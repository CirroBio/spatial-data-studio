"""Persistence (DESIGN §13).

`sdata.write()` to a `.zarr` directory store round-trips data + `attrs["app_state"]`
reliably. Direct `.zarr.zip` writing is broken in spatialdata 0.7.3 (produces an
empty archive — the §17 "incremental write API has moved" risk), so `.zarr.zip`
export is implemented as write-dir-then-zip, and load as unzip-then-read.

`_save_zip`/`_save_dir` relocate the (potentially multi-MB) per-compute worker logs
out of `attrs["app_state"]` — which is inlined into the store's root `zarr.json`
and would otherwise be downloaded in full on open — into gzipped files under
`logs/`, read back lazily by `session.get_log`.

A checkpoint is **directly browser-readable** over HTTP Range without this backend
(DESIGN §14): the serverless viewer opens the `.zarr.zip` with zarrita and renders
from it. Three write-time steps exist only to serve that reader. They are what make
it readable at all, not an optimization — a Zarr v3 store carries no child index, so
a checkpoint written before them is rejected by the viewer with a re-save message:

- `_shard_rasters` rewrites image/label arrays with the Zarr v3 sharding codec, so a
  multi-gigabyte level contributes tens of entries to the zip central directory
  instead of tens of thousands (the browser downloads that directory in full before
  the first tile).
- `_write_viewer_sidecar` writes a `viewer/` group holding what the browser cannot
  cheaply derive: the per-image manifest from `imaging.image_info`, the points->global
  affine, and a gene-major (CSC) mirror of each table's `X` so coloring by one gene is
  a couple of range reads instead of a download of the whole CSR `data`+`indices` pair.
- `_consolidate` re-runs consolidated metadata last, so the tree the browser reads
  reports the sharded codec and includes `viewer/`.
"""
import gzip
import hashlib
import json
import logging
import os
import re
import shutil
import tarfile
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import spatialdata as sd
import zarr

from ..config import _within_dir, config
from ..schemas import checkpoint as checkpoint_schemas
from ..sessions import appstate

_log = logging.getLogger(__name__)
_log.setLevel(logging.INFO)
if not _log.handlers:
    # Uvicorn's default logging config only wires up its own loggers - without an
    # explicit handler here, INFO-level checkpoint-hash reports below would be
    # silently dropped (root has no handler, and the fallback one only takes
    # WARNING+) even though this module's logger is set to INFO above.
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    _log.addHandler(_handler)
    _log.propagate = False

# Content-hash suffix appended to auto-named checkpoints (see `_save_zip`),
# e.g. "myfile-3fa21c9b8e4d.sdata.zarr.zip". Fixed length so it can be recognized
# and stripped again on the next save instead of piling up.
HASH_LEN = 12
_HASH_SUFFIX_RE = re.compile(rf"-[0-9a-f]{{{HASH_LEN}}}$")

# Extension for saved checkpoints: `<name>-<hash>.sdata.zarr.zip` (SpatialData zarr
# zip). Reading also accepts the plain `.zarr.zip`/`.zarr.tar.gz`/`.zarr` forms
# (legacy saves and imported stores), so only the save name carries the `.sdata`
# infix. Longest-first so `.sdata.zarr.zip` wins over `.zarr.zip`/`.zarr`.
CHECKPOINT_EXT = ".sdata.zarr.zip"
_READ_EXTS = (".sdata.zarr.zip", ".zarr.zip", ".zarr.tar.gz", ".zarr.tgz", ".zarr")

# Raster sharding (see module docstring). Inner chunk stays at the tile size the
# canvas requests so a tile is still one decompress; the shard groups 8x8 of them,
# which keeps the per-shard index tiny ((SHARD/INNER)^2 * 16 bytes).
_SHARD_INNER = 512
_SHARD_SIZE = 4096

# Top-level group holding the browser-only sidecar. Not a SpatialData element —
# `sd.read_zarr` ignores unknown root groups, which the save/reload round trip in
# `test_e2e.run_full_flow` covers.
VIEWER_GROUP = "viewer"
# Bumped when the sidecar layout changes so a viewer can refuse a shape it predates.
VIEWER_SIDECAR_VERSION = 1
# Chunk length for the CSC mirror's `data`/`indices`, in elements. Sized from the data
# so one gene column lands in one or two chunks whatever the table's shape: a Visium
# gene holds a few hundred non-zeros, a Xenium gene hundreds of thousands, and a fixed
# size would either split every Xenium column across many chunks or make a Visium gene
# read drag in megabytes it doesn't need. Smaller chunks cost total size (zstd has less
# to work with): on the Visium test checkpoint the mirror is 66 MB at 16k vs 51 MB at
# 256k, against 72 KB vs 843 KB per gene read — latency is what this mirror exists for.
_CSC_CHUNK_MIN = 16384
_CSC_CHUNK_MAX = 1 << 20


def strip_checkpoint_ext(name: str) -> str:
    """Strip a checkpoint/zarr extension (longest match) from a filename, leaving
    the stem the content-hash suffix is measured against."""
    for ext in _READ_EXTS:
        if name.endswith(ext):
            return name[: -len(ext)]
    return name


def _invalidate_dataset_scan() -> None:
    """A checkpoint just landed in the mount — drop the cached load/upload picker
    scan (datasets.py) so the new file shows up on the picker's next open. This is
    the single write boundary every checkpoint goes through (save / incremental
    update / set-transform / snapshot autosave / close-with-save)."""
    from .. import datasets
    datasets.invalidate()


def strip_content_hash(stem: str) -> str:
    """Remove a previously-appended content-hash suffix from a checkpoint's base
    name (without extension), so re-saving replaces it instead of stacking a new
    one on top."""
    return _HASH_SUFFIX_RE.sub("", stem)


def _expected_content_hash(path: str) -> str | None:
    """The content-hash suffix embedded in an auto-named `.zarr.zip` checkpoint's
    filename (see `_save_zip`), or None if the name carries none (a plain import, or
    a legacy/hand-named store). Only auto-named checkpoints can be verified on load."""
    name = os.path.basename(path)
    if not name.endswith(".zarr.zip"):
        return None
    m = _HASH_SUFFIX_RE.search(strip_checkpoint_ext(name))
    return m.group(0)[1:] if m else None


def _hash_result(name: str, expected: str, actual: str) -> dict:
    """Report whether a checkpoint's embedded content hash still matches its bytes,
    and return the result so the load path can surface it to the user. Informational
    only — a mismatch (e.g. the file was hand-edited or copied incorrectly) is
    reported, never raised."""
    ok = actual == expected
    if ok:
        _log.info("checkpoint hash OK: %s", name)
        message = f"Content hash verified: {name}"
    else:
        _log.warning("checkpoint hash mismatch: %s (filename says %s, contents hash to %s)",
                     name, expected, actual)
        message = (f"Content hash mismatch: {name} may have been modified "
                   f"(filename says {expected}, contents hash to {actual})")
    return {"ok": ok, "message": message}


def read_spatialdata_archive(path: str, progress=None):
    """Read a SpatialData zarr store from a bare `.zarr` directory, a `.zarr.zip`,
    or a `.zarr.tar.gz` archive. Returns (sdata, extract_dir, hash_check);
    `extract_dir` is the temp directory an archive was unpacked into (None for a bare
    directory) — zarr maps chunks from it lazily, so the caller owns cleanup for the
    object's lifetime. `hash_check` is the embedded-content-hash verification result
    (`_hash_result`), or None when the name carries no hash to verify. Shared by the
    checkpoint load path and the SpatialData-zarr import reader. `progress(message,
    pct)` (optional) reports extraction/read progress; see `create_from_load`."""
    report = progress or (lambda *a, **k: None)
    if path.endswith((".zarr.tar.gz", ".zarr.tgz")):
        extract_dir = tempfile.mkdtemp(suffix=".zarr", dir=str(config.WORK_DIR))
        report("Extracting checkpoint…")
        with tarfile.open(path, "r:gz") as tf:
            tf.extractall(extract_dir, filter="data")
        report("Reading data tables…")
        return sd.read_zarr(_zarr_root(extract_dir)), extract_dir, None
    if path.endswith(".zarr.zip") or (os.path.isfile(path) and zipfile.is_zipfile(path)):
        extract_dir = tempfile.mkdtemp(suffix=".zarr", dir=str(config.WORK_DIR))
        expected = _expected_content_hash(path)
        if expected is None:
            report("Extracting checkpoint…")
            with zipfile.ZipFile(path) as zf:
                zf.extractall(extract_dir)
            hash_check = None
        else:
            # Auto-named checkpoint: recompute the embedded content hash while
            # unzipping (same sorted-arcname + bytes scheme as `_zip_dir`), so the
            # verification costs no extra read pass over the archive.
            hash_check = _extract_zip_verifying(path, extract_dir, expected, report)
        report("Reading data tables…")
        return sd.read_zarr(_zarr_root(extract_dir)), extract_dir, hash_check
    report("Reading data tables…")
    return sd.read_zarr(path), None, None


def _extract_zip_verifying(path: str, extract_dir: str, expected: str,
                           progress=None) -> dict:
    """Unzip an auto-named checkpoint into `extract_dir` while recomputing the
    content hash `_zip_dir` embedded in its name, in a single read pass, then report
    whether they still match. These archives are ones we wrote — file entries only,
    relative arcnames — but each entry is still checked to stay inside `extract_dir`
    before writing (untrusted imports go through `extractall` in
    `read_spatialdata_archive` instead). `progress(message, pct)` (optional) reports the
    extracted byte fraction, throttled to whole percent."""
    report = progress or (lambda *a, **k: None)
    extract_root = Path(extract_dir).resolve()
    h = hashlib.sha256()
    with zipfile.ZipFile(path) as zf:
        total = sum(zi.file_size for zi in zf.infolist()) or 1
        done = 0
        last_pct = -1
        report("Extracting checkpoint…", 0.0)
        for arcname in sorted(zf.namelist()):
            h.update(arcname.encode())
            target = os.path.join(extract_dir, arcname)
            # Zip-slip guard (shared config._within_dir containment check): reject any
            # entry that resolves outside extract_dir. Even though these are archives we
            # wrote, a hash-named drop-in could carry a `../` arcname, and the
            # content-hash check runs only AFTER the full extract.
            resolved = Path(target).resolve()
            if not _within_dir(resolved, extract_root):
                raise ValueError(f"unsafe archive entry escapes extract dir: {arcname!r}")
            if arcname.endswith("/"):
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with zf.open(arcname) as src, open(target, "wb") as dst:
                for chunk in iter(lambda s=src: s.read(1 << 20), b""):
                    h.update(chunk)
                    dst.write(chunk)
                    done += len(chunk)
                    pct = done / total
                    if int(pct * 100) > last_pct:
                        last_pct = int(pct * 100)
                        report("Extracting checkpoint…", pct)
    return _hash_result(os.path.basename(path), expected, h.hexdigest()[:HASH_LEN])


def load_spatialdata(path: str, progress=None):
    """Returns (sdata, app_state, newer, extract_dir, hash_check). `extract_dir` is
    the temp directory an archive checkpoint was unpacked into — zarr maps chunks
    from it lazily for the object's lifetime, so the caller owns cleanup on session
    close. `hash_check` is the embedded-content-hash verification result, verified
    during extraction (see `read_spatialdata_archive`), or None when the name carries
    no hash. `progress(message, pct)` (optional) reports load progress; see
    `create_from_load`."""
    sdata, extract_dir, hash_check = read_spatialdata_archive(path, progress)
    st = appstate.ensure(sdata.attrs)
    # Rendered figures are never persisted (§13); plots load undrawn and render
    # lazily on open (§7.2). A persisted `drawn`/`failed` is meaningless without bytes.
    for p in st.get("plots", []):
        if p.get("status") in ("drawn", "failed", "running", "queued"):
            p["status"] = "invalidated"
    newer = st.get("schema_version", 1) > appstate.SCHEMA_VERSION
    return sdata, st, newer, extract_dir, hash_check


def _coerce_object_string_fields(arr: np.ndarray) -> np.ndarray | None:
    """A record array whose object-dtype fields hold a non-string (a float) somewhere,
    rebuilt with those fields as fixed-length unicode ('' for the non-strings); None if
    nothing needed fixing. `sc.tl.filter_rank_genes_groups` marks dropped genes with
    `np.nan` in the object `names` field, which breaks anndata's zarr writer two ways:
    it calls `.encode()` on every entry (dying on the float), and when a whole group is
    filtered every entry becomes '' — a zero-length string dtype zarr v3 rejects. A
    fixed `<U{L}` (L>=1) field avoids both: no per-entry encode, and a floor of 1."""
    names = arr.dtype.names
    if not names:
        return None
    obj_fields = [n for n in names if arr.dtype[n].kind == "O"]
    if not any(any(not isinstance(x, str) for x in arr[n].tolist()) for n in obj_fields):
        return None
    new_dtype, cols = [], {}
    for n in names:
        if n in obj_fields:
            vals = [x if isinstance(x, str) else "" for x in arr[n].tolist()]
            width = max((len(v) for v in vals), default=0) or 1
            cols[n] = np.array(vals, dtype=f"<U{width}")
            new_dtype.append((n, f"<U{width}"))
        else:
            cols[n] = arr[n]
            new_dtype.append((n, arr.dtype[n]))
    out = np.empty(arr.shape, dtype=new_dtype)
    for n in names:
        out[n] = cols[n]
    return out


def _stringify_uns_recarrays(sdata) -> list[tuple[dict, str, object]]:
    """Make every table's `uns` safe for anndata's zarr writer by replacing the
    non-string entries in object-dtype record arrays (see `_coerce_object_string_fields`)
    for the write only. Returns [(mapping, key, original)] so `save_spatialdata` can
    restore the live object's arrays — the NaNs are how scanpy marks filtered genes,
    so the in-memory object must keep them."""
    swaps: list[tuple[dict, str, object]] = []

    def walk(mapping: dict) -> None:
        for key, val in mapping.items():
            if isinstance(val, dict):
                walk(val)
            elif isinstance(val, np.ndarray):
                fixed = _coerce_object_string_fields(val)
                if fixed is not None:
                    mapping[key] = fixed
                    swaps.append((mapping, key, val))

    for table in getattr(sdata, "tables", {}).values():
        uns = getattr(table, "uns", None)
        if isinstance(uns, dict):
            walk(uns)
    return swaps


def select_elements(sdata, include: dict[str, list[str]]):
    """Shallow view over `sdata` carrying only the named elements.

    A facet absent from `include` is kept whole; a facet present keeps exactly the
    names listed, so `{"images": []}` is how a caller drops every image. Element
    objects are shared with `sdata` rather than copied — the same dask arrays, the
    same AnnData — so building a view costs nothing and cannot mutate the live
    session's object. `attrs` is a fresh dict so `save_spatialdata`'s app_state swap
    lands on the view instead of the caller's object.

    The view has no backing path, so a filtered save structurally cannot take the
    incremental route (`can_update_incrementally`) and reuse on-disk rasters that the
    selection just dropped.
    """
    from ..registry.base import sdata_facets
    kept = {}
    for facet in sdata_facets():
        have = dict(getattr(sdata, facet, {}) or {})
        names = include.get(facet)
        kept[facet] = have if names is None else {n: have[n] for n in names if n in have}
    view = sd.SpatialData(**kept)
    view.attrs = dict(sdata.attrs)
    return view


def save_spatialdata(sdata, path: str, app_state: dict, hash_name: bool = False,
                     include: dict[str, list[str]] | None = None) -> str:
    """`hash_name` renames a `.zarr.zip` checkpoint to embed a hash of its own
    contents once written (auto-managed saves only — explicit save-as paths are
    honored verbatim). Worker logs are stripped from the persisted `app_state` and
    written under `logs/` instead (see module docstring); the caller's live
    `app_state` is left untouched.

    `include` (facet -> element names) writes only those elements — see
    `select_elements` for the absent-vs-present rule. Displays naming a dropped
    element are neutralised so the file still renders; the live object keeps
    everything."""
    if include is not None:
        from ..registry.base import sdata_facets
        sdata = select_elements(sdata, include)
        app_state = appstate.prune_to_elements(
            app_state, {f: set(getattr(sdata, f, {}) or {}) for f in sdata_facets()})
    persisted, logs = _split_logs(app_state)
    checkpoint_schemas.validate_app_state(persisted)
    original = sdata.attrs.get("app_state")
    sdata.attrs["app_state"] = persisted
    uns_swaps = _stringify_uns_recarrays(sdata)
    try:
        if path.endswith(".zarr.zip"):
            written = _save_zip(sdata, path, hash_name, logs)
        else:
            written = _save_dir(sdata, path, logs)
    finally:
        # Restore the identity between sdata.attrs and the live session app_state
        # (they are the same object during a live session).
        sdata.attrs["app_state"] = original if original is not None else app_state
        for mapping, key, orig in uns_swaps:
            mapping[key] = orig
    _invalidate_dataset_scan()
    return written


def _save_dir(sdata, path: str, logs: dict[str, str]) -> str:
    p = Path(path)
    if p.exists():
        # spatialdata refuses to overwrite its own backing store; write a temp
        # sibling then swap.
        tmp = p.with_name(p.name + ".tmp")
        if tmp.exists():
            shutil.rmtree(tmp)
        # Don't adopt `tmp` as the backing path — it's renamed to `p` below, which would
        # leave sdata.path dangling; point the object at the final `p` after the swap.
        sdata.write(str(tmp), overwrite=True, update_sdata_path=False)
        _write_browser_reader_support(str(tmp), sdata)
        _write_logs(str(tmp), logs)
        # Keep the original until the new store is fully written, then swap via two
        # atomic renames so a crash mid-save can't destroy the only copy.
        bak = p.with_name(p.name + ".bak")
        if bak.exists():
            shutil.rmtree(bak)
        os.replace(p, bak)
        os.replace(tmp, p)
        shutil.rmtree(bak, ignore_errors=True)
        sdata.path = p
    else:
        sdata.write(path, overwrite=True)
        _write_browser_reader_support(path, sdata)
        _write_logs(path, logs)
    return path


def _save_zip(sdata, path: str, hash_name: bool, logs: dict[str, str]) -> str:
    tmpdir = tempfile.mkdtemp(dir=str(Path(path).parent), prefix=".save-")
    zarr_dir = os.path.join(tmpdir, "store.zarr")
    try:
        # This temp store is zipped then deleted; don't let the live object adopt it
        # as its backing path (spatialdata's write() does so by default), or every
        # later str(sdata) — e.g. the SpatialData manifest contributor — fails once
        # the temp dir is gone.
        sdata.write(zarr_dir, overwrite=True, update_sdata_path=False)
        _write_browser_reader_support(zarr_dir, sdata)
        _write_logs(zarr_dir, logs)
        return _zip_from_dir(zarr_dir, path, hash_name)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def can_update_incrementally(sdata, extract_dir: str | None) -> bool:
    """True when `sdata` is still backed by the writable directory store it was
    loaded from (`extract_dir`), so a checkpoint can be updated in place
    (`update_checkpoint`) instead of re-serialized whole. False for fresh imports, or
    once the backing dir has gone away (e.g. after a full re-save)."""
    if extract_dir is None or getattr(sdata, "path", None) is None:
        return False
    try:
        store_root = Path(str(sdata.path)).resolve()
        ed = Path(extract_dir).resolve()
    except (OSError, ValueError):
        return False
    return store_root.is_dir() and (store_root == ed or ed in store_root.parents)


def update_checkpoint(sdata, path: str, app_state: dict, *, tables: set[str],
                      transforms: set[str], hash_name: bool = False) -> str:
    """Incrementally update a `.zarr.zip` checkpoint, reusing the raster arrays
    already sitting in the directory store that backs `sdata` (`sdata.path`). Only
    the changed table elements and element transforms are rewritten; `app_state` is
    always re-persisted. Rasters are never touched, so the expensive
    decompress/recompress/rewrite pass a full re-save would take is skipped
    entirely — that is the whole point.

    A changed table is rewritten by deleting its on-disk element directory first, then
    `write_element`: spatialdata 0.7.3 refuses to overwrite an element that lives
    inside its own backing store, and a clean delete also drops any obs/var columns the
    new table no longer has. Tables are in-memory `AnnData` so removing their files is
    safe; rasters are Dask-backed from these same files and must never be deleted under
    a live object — the caller keeps them out of `tables`/`transforms` and falls back
    to a full `save_spatialdata` when a raster changed. Callers must confirm
    `can_update_incrementally` first."""
    work_dir = str(sdata.path)
    persisted, logs = _split_logs(app_state)
    checkpoint_schemas.validate_app_state(persisted)
    original = sdata.attrs.get("app_state")
    sdata.attrs["app_state"] = persisted
    try:
        for key in tables:
            elem_dir = os.path.join(work_dir, "tables", key)
            if os.path.isdir(elem_dir):
                shutil.rmtree(elem_dir)
            sdata.write_element(key)
        for name in transforms:
            sdata.write_transformations(name)
        sdata.write_attrs()
        _write_logs(work_dir, logs)
        # Rasters are untouched here so they need no re-shard, but the sidecar does
        # need refreshing: a changed table invalidates its CSC mirror, and a changed
        # transform moves `pixel_to_world`. The image manifest is cheap, so it is
        # always rebuilt; the CSC rebuild is limited to the dirty tables.
        _write_viewer_sidecar(work_dir, sdata, tables=tables)
        sdata.write_consolidated_metadata()
        written = _zip_from_dir(work_dir, path, hash_name)
    finally:
        sdata.attrs["app_state"] = original if original is not None else app_state
    _invalidate_dataset_scan()
    return written


def _zip_from_dir(src_dir: str, path: str, hash_name: bool) -> str:
    """Package the on-disk zarr store at `src_dir` into the checkpoint `.zarr.zip` at
    `path`. Stages the archive next to the destination (dot-prefixed so the dataset
    scanner ignores it) so the final commit is a same-filesystem rename rather than a
    cross-device copy of the whole (multi-GB) archive — correct whether the
    destination is in DATA_DIR or an arbitrary CLI output dir."""
    tmpdir = tempfile.mkdtemp(dir=str(Path(path).parent), prefix=".save-")
    staging = os.path.join(tmpdir, "staged.zarr.zip")
    try:
        digest = _zip_dir(src_dir, staging)
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        if hash_name:
            stem = strip_content_hash(strip_checkpoint_ext(p.name))
            final = p.with_name(f"{stem}-{digest}{CHECKPOINT_EXT}")
        else:
            final = p
        os.replace(staging, final)  # same filesystem (staged under DATA_DIR): atomic
        return str(final)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _zip_dir(src_dir: str, dest_zip: str) -> str:
    """Zip a zarr directory store into a `.zarr.zip` (stored, not recompressed — the
    arrays are already zstd-compressed) and return a content hash of its logical
    entries accumulated in the same pass, so the archive never has to be re-read just
    to name it. Entries are written in sorted order so the hash is deterministic."""
    h = hashlib.sha256()
    entries = []
    for root, _, files in os.walk(src_dir):
        for f in files:
            full = os.path.join(root, f)
            entries.append((os.path.relpath(full, src_dir), full))
    entries.sort()
    with zipfile.ZipFile(dest_zip, "w", compression=zipfile.ZIP_STORED) as zf:
        for arcname, full in entries:
            h.update(arcname.encode())
            with open(full, "rb") as src, zf.open(arcname, "w") as dst:
                for chunk in iter(lambda s=src: s.read(1 << 20), b""):
                    h.update(chunk)
                    dst.write(chunk)
    return h.hexdigest()[:HASH_LEN]


# ---- browser-readable checkpoint support (DESIGN §14) -----------------------
def _write_browser_reader_support(zarr_dir: str, sdata) -> None:
    """Make a freshly-written store directly readable by the serverless viewer.
    Order matters: consolidation runs last so the tree the browser fetches reports
    the sharded codec and lists the `viewer/` sidecar."""
    _shard_rasters(zarr_dir)
    _write_viewer_sidecar(zarr_dir, sdata)
    _consolidate(zarr_dir)


def _consolidate(zarr_dir: str) -> None:
    """Re-run consolidated metadata over a store at an arbitrary path. Reuses
    spatialdata's own helper — it silences the `ZarrUserWarning` the `.parquet` shape
    files provoke — rather than calling `zarr.consolidate_metadata` directly.
    `SpatialData.write_consolidated_metadata` can't be used here because it reads
    `sdata.path`, which these save paths deliberately leave pointing elsewhere."""
    from spatialdata._io.io_zarr import _write_consolidated_metadata
    _write_consolidated_metadata(zarr_dir)


def _write_viewer_sidecar(zarr_dir: str, sdata, tables: set[str] | None = None) -> None:
    """Write the `viewer/` group: what the browser needs but cannot cheaply derive
    from the SpatialData elements themselves.

    - `viewer` attrs carry the per-image manifest from `imaging.image_info`, keyed
      `[element][table_key]` because `pixel_to_world` reconciles the image against a
      table's spots. Every table is baked (plus `""` for none) so the viewer looks up
      whichever it settles on instead of re-deriving the reconciliation in JS.
    - `coords_transform` is the points->global affine `GET /data/obsm:spatial`
      applies, so the viewer places cells identically without re-deriving it from the
      region element's `coordinateTransformations`.
    - `viewer/tables/<key>/X_csc` is a gene-major mirror of a sparse `X`. This
      duplicates `X` on disk; the alternative is the browser downloading the whole
      CSR `data`+`indices` pair to read one gene column, which is worse exactly when
      the table is large.

    `tables` limits the CSC rebuild to those keys (the incremental save path knows
    which tables changed); None rebuilds all of them.
    """
    from .. import imaging
    from ..sessions import transform

    root = zarr.open_group(zarr_dir, mode="r+", use_consolidated=False)
    group = root.require_group(VIEWER_GROUP)
    table_keys = list(getattr(sdata, "tables", {}))
    sidecar = {
        "sidecar_version": VIEWER_SIDECAR_VERSION,
        "table_keys": table_keys,
        "images": {
            element: {
                key: imaging.image_info(sdata, element, sdata.tables[key] if key else None)
                for key in [""] + table_keys
            }
            for element in getattr(sdata, "images", {})
        },
        "coords_transform": {
            key: transform.get_affine6(sdata, sdata.tables[key]) for key in table_keys
        },
    }
    checkpoint_schemas.validate_viewer_sidecar(sidecar)
    group.attrs.update(sidecar)
    for key in table_keys if tables is None else (tables & set(table_keys)):
        _write_csc_mirror(group, key, sdata.tables[key])


def _write_csc_mirror(group, key: str, adata) -> None:
    """Column-major (CSC) copy of `adata.X` under `viewer/tables/<key>/X_csc`, so one
    gene's column is a contiguous `data[indptr[g]:indptr[g+1]]` slice covered by one
    or two `_CSC_CHUNK` chunks. Written only for a sparse `X`: a dense one is already
    column-sliceable by the chunk grid AnnData wrote. Cell order matches `obs`, gene
    order matches `var/_index`, so neither is duplicated here."""
    import scipy.sparse as sp

    x = getattr(adata, "X", None)
    if x is None or not sp.issparse(x):
        return
    csc = x.tocsc()
    chunk = _csc_chunk(csc.indptr)
    dest = group.require_group("tables").require_group(key).require_group("X_csc")
    csc_attrs = {"shape": [int(csc.shape[0]), int(csc.shape[1])]}
    checkpoint_schemas.validate_csc_table_attrs(csc_attrs)
    dest.attrs.update(csc_attrs)
    for name, values, length in (("data", csc.data, chunk),
                                 ("indices", csc.indices, chunk),
                                 ("indptr", csc.indptr, len(csc.indptr))):
        arr = dest.create_array(name, shape=values.shape, dtype=values.dtype,
                                chunks=(max(1, min(length, len(values))),), overwrite=True)
        arr[:] = values


def _csc_chunk(indptr: np.ndarray) -> int:
    """Chunk length keeping a gene column inside one or two chunks: the next power of
    two at or above twice the 95th-percentile column length, clamped to
    [`_CSC_CHUNK_MIN`, `_CSC_CHUNK_MAX`]. The p95 rather than the max so one unusually
    dense gene doesn't inflate every chunk."""
    lengths = np.diff(indptr)
    if lengths.size == 0:
        return _CSC_CHUNK_MIN
    target = max(1.0, float(np.percentile(lengths, 95))) * 2
    return int(min(_CSC_CHUNK_MAX, max(_CSC_CHUNK_MIN, 1 << int(np.ceil(np.log2(target))))))


# ---- raster sharding --------------------------------------------------------
def _shard_rasters(zarr_dir: str) -> None:
    """Rewrite every image/label array in a freshly-written store with the Zarr v3
    sharding codec. spatialdata 0.7.3 has no write-time sharding option, so each
    raster level is recreated (inner chunks `_SHARD_INNER`, shards `_SHARD_SIZE`),
    copying region-by-region so peak memory is ~one shard rather than a whole
    (possibly multi-GB) level."""
    for arr_dir in _raster_array_dirs(zarr_dir):
        _reshard_array(arr_dir)


def _raster_array_dirs(zarr_dir: str):
    """Directories of array nodes (2-D or 3-D) under images/ and labels/."""
    for group in ("images", "labels"):
        base = os.path.join(zarr_dir, group)
        if not os.path.isdir(base):
            continue
        for root, _, files in os.walk(base):
            if "zarr.json" not in files:
                continue
            meta = _read_meta(root)
            if meta.get("node_type") == "array" and len(meta.get("shape", [])) in (2, 3):
                yield root


def _reshard_array(store_path: str) -> None:
    meta = _read_meta(store_path)
    if "sharding_indexed" in [c.get("name") for c in meta.get("codecs", [])]:
        return  # already sharded (idempotent)
    src = zarr.open_array(store_path, mode="r")
    shape, dtype = tuple(src.shape), src.dtype
    zstd_level = _zstd_level(meta)
    if len(shape) == 3:
        # One channel per inner chunk, matching what `rasters.normalize_rasters`
        # writes: Viv requests tiles per channel, so a multi-channel inner chunk would
        # decode every channel to serve one. The shard spans all channels, which only
        # groups them into one file — the sharding index still addresses each inner
        # chunk's byte range individually.
        ih, iw = min(_SHARD_INNER, shape[1]), min(_SHARD_INNER, shape[2])
        inner = (1, ih, iw)
        shard = (shape[0], _shard_dim(shape[1], ih), _shard_dim(shape[2], iw))
    else:
        ih, iw = min(_SHARD_INNER, shape[0]), min(_SHARD_INNER, shape[1])
        inner = (ih, iw)
        shard = (_shard_dim(shape[0], ih), _shard_dim(shape[1], iw))

    tmp = store_path + ".resharded"
    if os.path.exists(tmp):
        shutil.rmtree(tmp)
    dst = zarr.create_array(store=tmp, shape=shape, chunks=inner, shards=shard, dtype=dtype,
                            dimension_names=meta.get("dimension_names"),
                            compressors=zarr.codecs.ZstdCodec(level=zstd_level))
    for k, v in dict(src.attrs).items():
        dst.attrs[k] = v
    for y in range(0, shape[-2], shard[-2]):
        ys = slice(y, min(y + shard[-2], shape[-2]))
        for x in range(0, shape[-1], shard[-1]):
            xs = slice(x, min(x + shard[-1], shape[-1]))
            if len(shape) == 3:
                dst[:, ys, xs] = src[:, ys, xs]
            else:
                dst[ys, xs] = src[ys, xs]
    shutil.rmtree(store_path)
    shutil.move(tmp, store_path)


def _shard_dim(dim: int, inner: int) -> int:
    """Shard extent along one axis: a whole number of inner chunks (zarr requires the
    shard shape to be divisible by the inner chunk shape), sized ~`_SHARD_SIZE` but
    never more inner chunks than the axis actually has. Deriving it from `inner`
    (not from a fixed 512) keeps it divisible even when a small pyramid level makes
    `inner` < `_SHARD_INNER` (e.g. a 430-px level -> inner 430, shard 430)."""
    n_chunks = -(-dim // inner)  # ceil(dim / inner)
    return inner * max(1, min(_SHARD_SIZE // inner, n_chunks))


def _zstd_level(meta: dict) -> int:
    for codec in meta.get("codecs", []):
        if codec.get("name") == "zstd":
            return int(codec.get("configuration", {}).get("level", 0))
    return 0


def _read_meta(node_dir: str) -> dict:
    """Parse a zarr node's `zarr.json` (v3 metadata)."""
    with open(os.path.join(node_dir, "zarr.json")) as f:
        return json.load(f)


# ---- worker-log relocation --------------------------------------------------
def _split_logs(app_state: dict) -> tuple[dict, dict[str, str]]:
    """Return (app_state without any record `_log`, {record_id: log}). Copies only
    the two record collections and the records that carry a log, so the caller's
    live app_state keeps its in-memory logs."""
    logs: dict[str, str] = {}
    out = dict(app_state)
    for coll_key in ("compute_history", "plots"):
        recs = app_state.get(coll_key) or []
        new_recs = []
        for rec in recs:
            if isinstance(rec, dict) and "_log" in rec:
                # Strip `_log` unconditionally (even an empty string) - only a
                # non-empty one is worth relocating to logs/<id>.log.gz.
                if rec["_log"]:
                    logs[rec["id"]] = rec["_log"]
                rec = {k: v for k, v in rec.items() if k != "_log"}
            new_recs.append(rec)
        out[coll_key] = new_recs
    return out, logs


def _write_logs(zarr_dir: str, logs: dict[str, str]) -> None:
    if not logs:
        return
    d = os.path.join(zarr_dir, "logs")
    os.makedirs(d, exist_ok=True)
    for rec_id, text in logs.items():
        with gzip.open(os.path.join(d, f"{rec_id}.log.gz"), "wt", encoding="utf-8") as f:
            f.write(text)


def read_log(store_root: str | None, entry_id: str) -> str | None:
    """Read a relocated compute/plot log (gzipped under `logs/`) from a loaded
    checkpoint's on-disk store (the extract dir for a `.zarr.zip`, or the store dir
    itself). Returns None when there is no such log."""
    if not store_root:
        return None
    p = os.path.join(store_root, "logs", f"{entry_id}.log.gz")
    if not os.path.isfile(p):
        return None
    with gzip.open(p, "rt", encoding="utf-8") as f:
        return f.read()


def _zarr_root(extracted_dir: str) -> str:
    """A zarr group has a `zarr.json` (v3) or `.zgroup` (v2) at its root; locate it
    in case the archive nests the store one level down."""
    for marker in ("zarr.json", ".zgroup"):
        if os.path.exists(os.path.join(extracted_dir, marker)):
            return extracted_dir
    entries = [os.path.join(extracted_dir, e) for e in os.listdir(extracted_dir)]
    dirs = [e for e in entries if os.path.isdir(e)]
    if len(dirs) == 1:
        return dirs[0]
    return extracted_dir


# Inverse of `estimate_resident_mb`'s DECOMP: that reads a compressed store and scales
# up to resident bytes, this takes in-memory bytes and scales down to what the
# compressed checkpoint will hold. The same 4x, applied the other way.
_COMPRESSION = 1 / 4.0
# Label masks are long runs of a handful of integer values, so they compress far harder
# than photographic (H&E) or fluorescence intensity data.
_COMPRESSION_BY_FACET = {"labels": 1 / 20.0}


def _dir_bytes(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def _raster_nbytes(el) -> int:
    """Uncompressed bytes across every pyramid level of an image/labels element."""
    from .. import imaging
    levels = len(imaging._scale_names(el)) if imaging._is_multiscale(el) else 1
    total = 0
    for i in range(levels):
        arr = imaging._level_array(el, i)
        total += int(np.prod(arr.shape)) * np.dtype(arr.dtype).itemsize
    return total


def _matrix_nbytes(m) -> int:
    if m is None:
        return 0
    if hasattr(m, "nnz"):  # scipy sparse
        return int(m.nnz) * (m.data.itemsize + m.indices.itemsize)
    return int(getattr(m, "nbytes", 0))


def _table_nbytes(adata) -> int:
    """Uncompressed bytes of an AnnData. A sparse `X` counts twice: the checkpoint also
    carries the gene-major CSC mirror written by `_write_csc_mirror`."""
    total = _matrix_nbytes(adata.X) * (2 if hasattr(adata.X, "nnz") else 1)
    for layer in getattr(adata, "layers", {}).values():
        total += _matrix_nbytes(layer)
    for frame in (adata.obs, adata.var):
        total += int(frame.memory_usage(deep=True).sum())
    for mapping in ("obsm", "varm", "obsp"):
        for m in (getattr(adata, mapping, None) or {}).values():
            total += _matrix_nbytes(m)
    return total


def _shapes_nbytes(gdf) -> int:
    import shapely
    coords = int(shapely.get_num_coordinates(np.asarray(gdf.geometry.array)).sum())
    attrs = int(gdf.drop(columns=gdf.geometry.name).memory_usage(deep=True).sum())
    return coords * 16 + attrs  # two float64 ordinates per coordinate


def _points_nbytes(pdf) -> int | None:
    """None when the frame is dask-backed: its row count isn't known without reading
    it, and drawing a number in a dialog must not trigger a full scan."""
    rows = pdf.shape[0]
    if not isinstance(rows, (int, np.integer)):
        return None
    return int(rows) * sum(np.dtype(d).itemsize for d in pdf.dtypes)


def element_size_mb(sdata, facet: str, name: str,
                    stores: dict[str, str] | None = None) -> float | None:
    """Estimated contribution of one element to a written checkpoint, in MB.

    Two tiers, most accurate first. If the element already sits in a store on disk —
    the object's own backing directory, or the per-element store a rebuilt raster was
    written to (`Session.raster_stores`) — its real compressed bytes are read, which is
    what a full re-save writes out again. Otherwise the size is estimated from shape,
    dtype and sparsity and scaled by a compression factor.

    The estimate is rough: within roughly 2x, and worse for fluorescence than for H&E.
    `None` means "not estimable" (a dask points frame), so a total built from these is
    a lower bound.
    """
    for root in (getattr(sdata, "path", None), (stores or {}).get(name)):
        if root and (d := Path(root) / facet / name).is_dir():
            return round(_dir_bytes(d) / 1e6, 1)

    el = (getattr(sdata, facet, None) or {}).get(name)
    if el is None:
        return None
    if facet in ("images", "labels"):
        raw = _raster_nbytes(el)
    elif facet == "tables":
        raw = _table_nbytes(el)
    elif facet == "shapes":
        raw = _shapes_nbytes(el)
    else:
        raw = _points_nbytes(el)
    if raw is None:
        return None
    return round(raw * _COMPRESSION_BY_FACET.get(facet, _COMPRESSION) / 1e6, 1)


def estimate_resident_mb(path: str) -> float:
    """Best-effort resident-cost estimate (DESIGN §11.3). Tables load eagerly and
    dominate; images/labels are lazy/dask. Conservative decompression factor."""
    p = Path(path)
    DECOMP = 4.0
    if p.is_dir():
        tdir = p / "tables"
        base = tdir if tdir.exists() else p
        factor = 1.0 if tdir.exists() else 0.3
        nbytes = sum(f.stat().st_size for f in base.rglob("*") if f.is_file())
        return round(nbytes * DECOMP * factor / 1e6, 1)
    return round(p.stat().st_size * DECOMP * 0.3 / 1e6, 1)
