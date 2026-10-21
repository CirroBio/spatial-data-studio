"""Read a Spatial Data Studio version stack from Python.

A version saved by the Cirro app is a dataset holding ``layer.json`` and, under
``overlay/``, only the store objects that version added or replaced. Its ``parent`` is a
Cirro reference (``cirro:::dataset:<id>/<path>``) to the version below it, or to the
SpatialData store at the bottom of the stack. docs/LAYER_FORMAT.md specifies the format.

Download the datasets of a stack into one folder, each in a folder named by its dataset
ID, then open a table in place with zarr and anndata::

    import anndata, zarr
    from sds_layers import open_stack
    root = zarr.open_group(open_stack("downloads/<top version id>"), mode="r")
    adata = anndata.read_zarr(root["tables/table"])

or write the stack out as one ordinary store, which is what ``spatialdata.read_zarr``
needs: it opens a path, or a group on a local or fsspec store, but not the store
``open_stack`` returns::

    python backend/app/persistence/sds_layers.py flatten downloads/<top version id> out.zarr

Flattening a stack whose base is a ``.zarr`` folder links the base's objects instead of
copying them (``--copy`` to copy); a ``.zarr.zip`` base is extracted.

Where dataset folders are named otherwise, as in a Cirro workspace, which mounts each
attached dataset under its name, pass a map from dataset ID to folder name (``folders``,
or ``--folders`` with a JSON object such as ``"$SDS_CIRRO_DATASETS"``). A dataset the map
names is looked up in its folder, any other by its ID.

Only the standard library and zarr-python 3 are needed. The Studio's backend opens
versions through this file too (``persistence/store.py``).
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import zipfile
from collections.abc import AsyncIterator, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

LAYER_FORMAT = "spatial-data-studio.layer"
LAYER_FORMAT_VERSION = 1
LAYER_MANIFEST = "layer.json"
DATASET_ID = re.compile(r"[A-Za-z0-9-]+")
# The most versions a stack may have. MAX_DEPTH in cirro-studio/src/stack/openStack.ts is
# the browser's; no person builds a stack this deep by hand.
MAX_STACK_DEPTH = 500


def _check_relative(value: object, where: str, *, node: bool = False) -> str:
    """``value``, if it is a relative ``/``-separated path that stays inside its folder.

    Each segment must pass the rule of ``checkName`` in cirro-studio/src/stack/editor.ts,
    the browser writer: not empty, ``.`` or ``..``. A backslash is refused because Windows
    reads it as a separator. With ``node``, one trailing ``/`` (a whole node) is allowed.
    """
    if not isinstance(value, str):
        raise ValueError(f"{where}: expected a path, got {value!r}")
    body = value[:-1] if node and value.endswith("/") else value
    if "\\" in body or any(s in ("", ".", "..") for s in body.split("/")):
        raise ValueError(f"{where}: {value!r} is not a relative path inside its folder")
    return value


def _check_inside(path: Path, root: Path, where: str) -> None:
    # The lexical rule above can't see symbolic links, so compare where both really lead.
    resolved = path.resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise ValueError(f"{where}: {path} leads to {resolved}, outside {root}")


def parse_ref(ref: str) -> tuple[str, str]:
    """``cirro:<tenant>:<project>:dataset:<id>/<path>`` -> (dataset id, path)."""
    if not ref.startswith("cirro:"):
        raise ValueError(f"not a Cirro reference: {ref!r}")
    head, _, path = ref[len("cirro:"):].partition("/")
    parts = head.split(":")
    if len(parts) != 4 or parts[2] != "dataset" or not DATASET_ID.fullmatch(parts[3]):
        raise ValueError(f"not a Cirro dataset reference: {ref!r}")
    # An empty path names the dataset's data directory itself.
    if path:
        _check_relative(path, f"reference {ref!r}", node=True)
    return parts[3], path


class MissingDataset(FileNotFoundError):
    """A dataset of the stack is not in the datasets folder."""

    def __init__(self, dataset_id: str, folder: Path):
        super().__init__(f"dataset {dataset_id} is not at {folder}")
        self.dataset_id = dataset_id


def _dataset_folder(datasets: Path, dataset_id: str, folders: Mapping[str, str] | None) -> Path:
    if folders is None or dataset_id not in folders:
        return datasets / dataset_id
    # The map is the deployment's, not the manifest's, but a folder it names is held to
    # the rules a dataset ID's folder meets by construction: one inside `datasets`.
    where = f"the folder of dataset {dataset_id}"
    folder = datasets / _check_relative(folders[dataset_id], where)
    _check_inside(folder, datasets, where)
    return folder


def _dataset_file(datasets: Path, dataset_id: str, path: str,
                  folders: Mapping[str, str] | None = None) -> Path:
    """Where a downloaded dataset's file is: under ``data/`` or at the folder's top."""
    folder = _dataset_folder(datasets, dataset_id, folders)
    if not folder.is_dir():
        raise MissingDataset(dataset_id, folder)
    for candidate in (folder / "data" / path, folder / path):
        if candidate.exists():
            _check_inside(candidate, folder, f"{path!r} in dataset {dataset_id}")
            return candidate
    raise FileNotFoundError(
        f"dataset {dataset_id} has no {path!r} (looked in {folder}/data and {folder})"
    )


@dataclass
class Version:
    """One saved version: its manifest and the folder its overlay objects are in."""

    folder: Path
    manifest: dict

    @classmethod
    def read(cls, manifest_path: Path) -> Version:
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("format") != LAYER_FORMAT:
            raise ValueError(f"{manifest_path} is not a Spatial Data Studio version")
        if manifest.get("format_version") != LAYER_FORMAT_VERSION:
            raise ValueError(
                f"{manifest_path} is format version {manifest.get('format_version')}; "
                f"this reader understands {LAYER_FORMAT_VERSION}"
            )
        overlay = _check_relative(manifest["overlay"], f"{manifest_path} overlay")
        for f in manifest["files"]:
            _check_relative(f["key"], f"{manifest_path} files")
        for d in manifest["deleted"]:
            _check_relative(d, f"{manifest_path} deleted", node=True)
        folder = manifest_path.parent / overlay
        _check_inside(folder, manifest_path.parent, f"{manifest_path} overlay")
        return cls(folder, manifest)

    @property
    def keys(self) -> set[str]:
        return {f["key"] for f in self.manifest["files"]}

    def hides(self, key: str) -> bool:
        return any(key.startswith(d) if d.endswith("/") else key == d for d in self.manifest["deleted"])


@dataclass
class Stack:
    """A base store and the versions on it, bottom to top."""

    base: Path
    versions: list[Version]

    @classmethod
    def resolve(cls, top: Path, datasets: Path | None = None,
                folders: Mapping[str, str] | None = None) -> Stack:
        """Follow ``parent`` references down from ``top``.

        ``top`` is a version's folder (or its ``layer.json``); parents are looked up in
        ``datasets`` (default: the folder holding ``top``'s dataset folder), in the folder
        ``folders`` maps their dataset ID to, or else in the one named by the ID.
        """
        manifest_path = top if top.name == LAYER_MANIFEST else find_manifest(top)
        if manifest_path is None:
            raise FileNotFoundError(f"no {LAYER_MANIFEST} in {top} or {top / 'data'}")
        if datasets is None:
            datasets = _dataset_root(manifest_path)
        versions = []
        current = Version.read(manifest_path)
        # By file rather than by reference: the top version has none, and two references
        # (in different scopes, say) can name one manifest.
        seen = {manifest_path.resolve()}
        while True:
            versions.append(current)
            ref = current.manifest["parent"]
            dataset_id, path = parse_ref(ref)
            target = _dataset_file(datasets, dataset_id, path, folders)
            if target.name != LAYER_MANIFEST:
                return cls(target, list(reversed(versions)))
            if target.resolve() in seen:
                raise ValueError(f"the stack loops: {ref!r} is a version already in it")
            if len(versions) >= MAX_STACK_DEPTH:
                raise ValueError(f"the stack is too deep: it goes on past {MAX_STACK_DEPTH} versions, to {ref!r}")
            seen.add(target.resolve())
            current = Version.read(target)

    def owner(self, key: str) -> Path | None:
        """Where to read ``key``, from the top version down.

        The overlay file of the first version whose ``files`` has it; None when a version's
        ``deleted`` hides it first; otherwise ``_BASE``, meaning ask the base, which may or
        may not hold it.
        """
        for version in reversed(self.versions):
            if key in version.keys:
                return version.folder / key
            if version.hides(key):
                return None
        return _BASE

    def keys(self) -> Iterable[str]:
        seen = set()
        for version in reversed(self.versions):
            for key in sorted(version.keys):
                if key not in seen and self.owner(key) is not None:
                    seen.add(key)
                    yield key
        for key in _base_keys(self.base):
            if key not in seen and self.owner(key) is _BASE:
                seen.add(key)
                yield key


# Marks a key that only the base can answer, if it holds it.
_BASE = Path("<base>")


def find_manifest(folder: Path) -> Path | None:
    """``folder``'s ``layer.json``, under ``data/`` or at its top; None when it has none."""
    for candidate in (folder / "data" / LAYER_MANIFEST, folder / LAYER_MANIFEST):
        if candidate.is_file():
            return candidate
    return None


def _dataset_root(manifest_path: Path) -> Path:
    # <datasets>/<id>/data/layer.json or <datasets>/<id>/layer.json
    folder = manifest_path.parent
    return folder.parent.parent if folder.name == "data" else folder.parent


def _base_keys(base: Path) -> Iterable[str]:
    if base.is_dir():
        for p in sorted(base.rglob("*")):
            if p.is_file():
                yield p.relative_to(base).as_posix()
    else:
        with zipfile.ZipFile(base) as z:
            yield from (_check_relative(n, f"{base} member") for n in z.namelist() if not n.endswith("/"))


def flatten(stack: Stack, out: Path, link: bool = True) -> int:
    """Write the stack as one ordinary ``.zarr`` folder; returns the number of objects.

    ``out`` must not exist, or be an empty folder. With ``link``, objects from a folder
    base are symbolic links into it, so flattening a large store costs only the version's
    own objects.
    """
    if out.exists() and not (out.is_dir() and not any(out.iterdir())):
        raise FileExistsError(f"{out} exists; flatten writes a new or empty folder")
    zipped = None if stack.base.is_dir() else zipfile.ZipFile(stack.base)
    count = 0
    try:
        for key in stack.keys():
            target = out / key
            _check_inside(target, out, f"key {key!r}")
            target.parent.mkdir(parents=True, exist_ok=True)
            source = stack.owner(key)
            if source is _BASE:
                if zipped is None and link:
                    target.symlink_to((stack.base / key).resolve())
                elif zipped is None:
                    shutil.copyfile(stack.base / key, target)
                else:
                    target.write_bytes(zipped.read(key))
            else:
                # `source` is <overlay folder>/<key>; a link there must not lead out of it.
                _check_inside(source, source.parents[key.count("/")], f"key {key!r}")
                shutil.copyfile(source, target)
            count += 1
    finally:
        if zipped is not None:
            zipped.close()
    return count


def open_stack(top: str | Path, datasets: str | Path | None = None,
               folders: Mapping[str, str] | None = None):
    """A read-only zarr store over the stack, for ``zarr.open_group``.

    ``spatialdata.read_zarr`` can't read it; ``flatten`` the stack for that.
    """
    stack = Stack.resolve(Path(top), Path(datasets) if datasets else None, folders)
    return _stack_store_class()(stack)


def _stack_store_class():
    # zarr is imported here so `flatten` runs without it.
    from zarr.abc.store import ByteRequest, OffsetByteRequest, RangeByteRequest, Store, SuffixByteRequest
    from zarr.core.buffer import Buffer, BufferPrototype

    class StackStore(Store):
        supports_writes = False
        supports_deletes = False
        supports_partial_writes = False
        supports_listing = True

        def __init__(self, stack: Stack):
            super().__init__(read_only=True)
            self.stack = stack
            self._zip = None if stack.base.is_dir() else zipfile.ZipFile(stack.base)

        def __eq__(self, other: object) -> bool:
            return isinstance(other, StackStore) and other.stack == self.stack

        def _read(self, key: str) -> bytes | None:
            source = self.stack.owner(key)
            if source is None:
                return None
            if source is not _BASE:
                return source.read_bytes()
            if self._zip is not None:
                try:
                    return self._zip.read(key)
                except KeyError:
                    return None
            path = self.stack.base / key
            return path.read_bytes() if path.is_file() else None

        async def get(self, key: str, prototype: BufferPrototype, byte_range: ByteRequest | None = None) -> Buffer | None:
            data = self._read(key)
            if data is None:
                return None
            if isinstance(byte_range, RangeByteRequest):
                data = data[byte_range.start:byte_range.end]
            elif isinstance(byte_range, OffsetByteRequest):
                data = data[byte_range.offset:]
            elif isinstance(byte_range, SuffixByteRequest):
                data = data[-byte_range.suffix:]
            return prototype.buffer.from_bytes(data)

        async def get_partial_values(self, prototype, key_ranges):
            return [await self.get(k, prototype, r) for k, r in key_ranges]

        async def exists(self, key: str) -> bool:
            return self._read(key) is not None

        async def set(self, key, value) -> None:
            raise PermissionError("a version stack is read-only")

        async def delete(self, key) -> None:
            raise PermissionError("a version stack is read-only")

        async def list(self) -> AsyncIterator[str]:
            for key in self.stack.keys():
                yield key

        async def list_prefix(self, prefix: str) -> AsyncIterator[str]:
            for key in self.stack.keys():
                if key.startswith(prefix):
                    yield key

        async def list_dir(self, prefix: str) -> AsyncIterator[str]:
            prefix = prefix.rstrip("/") + "/" if prefix else ""
            seen = set()
            for key in self.stack.keys():
                if key.startswith(prefix):
                    child = key[len(prefix):].split("/", 1)[0]
                    if child not in seen:
                        seen.add(child)
                        yield child

    return StackStore


def _folder_map(text: str) -> dict[str, str]:
    folders = json.loads(text)
    if not isinstance(folders, dict):
        raise argparse.ArgumentTypeError("expected a JSON object of dataset ID to folder name")
    return folders


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    f = sub.add_parser("flatten", help="write a version stack out as one .zarr folder")
    f.add_argument("version", type=Path, help="the top version's dataset folder (or its layer.json)")
    f.add_argument("out", type=Path, help="the .zarr folder to write")
    f.add_argument("--datasets", type=Path, help="folder holding every dataset of the stack")
    f.add_argument("--folders", type=_folder_map,
                   help="JSON object naming the folder of each dataset ID not in a folder of that name")
    f.add_argument("--copy", action="store_true", help="copy a folder base's objects instead of linking them")
    d = sub.add_parser("describe", help="list a stack's versions, bottom to top")
    d.add_argument("version", type=Path)
    d.add_argument("--datasets", type=Path)
    d.add_argument("--folders", type=_folder_map)
    args = parser.parse_args(argv)
    stack = Stack.resolve(args.version, args.datasets, args.folders)
    if args.command == "describe":
        print(f"base: {stack.base}")
        for i, v in enumerate(stack.versions, 1):
            m = v.manifest
            print(f"{i}. {m['title']} ({m['created_at']}, {m['created_by']}): {len(m['files'])} objects, {len(m['deleted'])} deleted")
        return 0
    n = flatten(stack, args.out, link=not args.copy)
    print(f"wrote {n} objects to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
