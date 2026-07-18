"""Persistence (DESIGN §13).

`sdata.write()` to a `.zarr` directory store round-trips data + `attrs["app_state"]`
reliably. Direct `.zarr.zip` writing is broken in spatialdata 0.7.3 (produces an
empty archive — the §17 "incremental write API has moved" risk), so `.zarr.zip`
export is implemented as write-dir-then-zip, and load as unzip-then-read.

A checkpoint `.zarr.zip` doubles as the source a browser reads directly (via
zarrita.js over HTTP range requests) to render a snapshot. To make that read cheap,
`_save_zip` (a) rewrites the large raster arrays with the Zarr v3 sharding codec —
small inner chunks packed into a few shard objects, so a viewport read fetches a
shard index plus a handful of small chunks instead of one giant chunk — then
re-consolidates metadata so the consolidated tree the browser reads reports the
sharded layout; and (b) relocates the (potentially multi-MB) per-compute worker
logs out of `attrs["app_state"]` — which is inlined into the store's root
`zarr.json` and would otherwise be downloaded in full on open — into gzipped files
under `logs/`, read back lazily by `session.get_log`.
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

import spatialdata as sd
import zarr

from ..sessions import appstate

# Sharding parameters for raster (image/label) arrays. Small inner chunks keep a
# viewport read cheap; a few large shards keep the object/zip-entry count low and
# the per-shard index tiny (SHARD/INNER)^2 * 16 bytes.
_SHARD_INNER = 512
_SHARD_SIZE = 4096

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


def _hash_zip_contents(path: str) -> str:
    """Recompute the content hash `_zip_dir` embeds in an auto-named checkpoint, by
    reading the archive's entries (same sorted-arcname + bytes scheme). Hashing the
    logical contents rather than the container makes the digest independent of zip
    ordering/headers, so re-saving unchanged data yields the same name."""
    h = hashlib.sha256()
    with zipfile.ZipFile(path) as zf:
        for arcname in sorted(zf.namelist()):
            h.update(arcname.encode())
            with zf.open(arcname) as f:
                for chunk in iter(lambda g=f: g.read(1 << 20), b""):
                    h.update(chunk)
    return h.hexdigest()[:HASH_LEN]


def read_spatialdata_archive(path: str):
    """Read a SpatialData zarr store from a bare `.zarr` directory, a `.zarr.zip`,
    or a `.zarr.tar.gz` archive. Returns (sdata, extract_dir); `extract_dir` is the
    temp directory an archive was unpacked into (None for a bare directory) — zarr
    maps chunks from it lazily, so the caller owns cleanup for the object's lifetime.
    Shared by the checkpoint load path and the SpatialData-zarr import reader."""
    if path.endswith((".zarr.tar.gz", ".zarr.tgz")):
        extract_dir = tempfile.mkdtemp(suffix=".zarr")
        with tarfile.open(path, "r:gz") as tf:
            tf.extractall(extract_dir, filter="data")
        return sd.read_zarr(_zarr_root(extract_dir)), extract_dir
    if path.endswith(".zarr.zip") or (os.path.isfile(path) and zipfile.is_zipfile(path)):
        extract_dir = tempfile.mkdtemp(suffix=".zarr")
        with zipfile.ZipFile(path) as zf:
            zf.extractall(extract_dir)
        return sd.read_zarr(_zarr_root(extract_dir)), extract_dir
    return sd.read_zarr(path), None


def load_spatialdata(path: str):
    """Returns (sdata, app_state, newer, extract_dir). `extract_dir` is the temp
    directory an archive checkpoint was unpacked into — zarr maps chunks from it
    lazily for the object's lifetime, so the caller owns cleanup on session close."""
    _check_content_hash(path)  # no-op unless it's an auto-named .zarr.zip
    sdata, extract_dir = read_spatialdata_archive(path)
    st = appstate.ensure(sdata.attrs)
    # Rendered figures are never persisted (§13); plots load undrawn and render
    # lazily on open (§7.2). A persisted `drawn`/`failed` is meaningless without bytes.
    for p in st.get("plots", []):
        if p.get("status") in ("drawn", "failed", "running", "queued"):
            p["status"] = "invalidated"
    newer = st.get("schema_version", 1) > appstate.SCHEMA_VERSION
    return sdata, st, newer, extract_dir


def save_spatialdata(sdata, path: str, app_state: dict, hash_name: bool = False) -> str:
    """`hash_name` renames a `.zarr.zip` checkpoint to embed a hash of its own
    contents once written (auto-managed saves only — explicit save-as paths are
    honored verbatim). Worker logs are stripped from the persisted `app_state` and
    written under `logs/` instead (see module docstring); the caller's live
    `app_state` is left untouched."""
    persisted, logs = _split_logs(app_state)
    original = sdata.attrs.get("app_state")
    sdata.attrs["app_state"] = persisted
    try:
        if path.endswith(".zarr.zip"):
            written = _save_zip(sdata, path, hash_name, logs)
        else:
            written = _save_dir(sdata, path, logs)
    finally:
        # Restore the identity between sdata.attrs and the live session app_state
        # (they are the same object during a live session).
        sdata.attrs["app_state"] = original if original is not None else app_state
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
        _shard_rasters(str(tmp))
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
        _shard_rasters(path)
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
        _shard_rasters(zarr_dir)
        _write_logs(zarr_dir, logs)
        return _zip_from_dir(zarr_dir, path, hash_name)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def can_update_incrementally(sdata, extract_dir: str | None) -> bool:
    """True when `sdata` is still backed by the writable, already-sharded directory
    store it was loaded from (`extract_dir`), so a checkpoint can be updated in place
    (`update_checkpoint`) instead of re-serialized whole. False for fresh imports, or
    once the backing dir has gone away (e.g. after a full re-save)."""
    if extract_dir is None or getattr(sdata, "path", None) is None:
        return False
    try:
        store_root = Path(str(sdata.path)).resolve()
        ed = Path(extract_dir).resolve()
    except (OSError, ValueError):
        return False
    if not (store_root.is_dir() and (store_root == ed or ed in store_root.parents)):
        return False
    # Only safe when the rasters are already sharded (i.e. this store was written by
    # us): an incremental repackage keeps them as-is, so an unsharded import store
    # would produce a zip the in-SPA zarrita viewer can't decode. Raw imports fall
    # back to a full save, which reshards.
    return _all_rasters_sharded(str(store_root))


def _all_rasters_sharded(zarr_dir: str) -> bool:
    for arr_dir in _raster_array_dirs(zarr_dir):
        meta = _read_meta(arr_dir)
        if "sharding_indexed" not in [c.get("name") for c in meta.get("codecs", [])]:
            return False
    return True


def _read_meta(node_dir: str) -> dict:
    """Parse a zarr node's `zarr.json` (v3 metadata)."""
    with open(os.path.join(node_dir, "zarr.json")) as f:
        return json.load(f)


def update_checkpoint(sdata, path: str, app_state: dict, *, tables: set[str],
                      transforms: set[str], hash_name: bool = False) -> str:
    """Incrementally update a `.zarr.zip` checkpoint, reusing the already-sharded
    raster arrays sitting in the directory store that backs `sdata` (`sdata.path`).
    Only the changed table elements and element transforms are rewritten; `app_state`
    is always re-persisted. Rasters are never touched, so the expensive
    decompress/recompress/reshard pass is skipped entirely — that is the whole point.

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


# ---- sharding repack (browser-readable rasters) ----------------------------
def _shard_rasters(zarr_dir: str) -> None:
    """Rewrite every image/label array in a freshly-written store with the Zarr v3
    sharding codec, then re-consolidate metadata. spatialdata 0.7.3 has no
    write-time sharding option, so each raster level is recreated (inner chunks
    `_SHARD_INNER`, shards `_SHARD_SIZE`), copying region-by-region so peak memory
    is ~one shard rather than a whole (possibly multi-GB) level. Re-consolidation is
    required for the browser: the root consolidated tree must report the sharded
    codec, or zarrita would read the pre-shard byte layout and decode garbage."""
    resharded = False
    for arr_dir in _raster_array_dirs(zarr_dir):
        _reshard_array(arr_dir)
        resharded = True
    if resharded:
        zarr.consolidate_metadata(zarr.storage.LocalStore(zarr_dir))


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
        c = shape[0]
        ih, iw = min(_SHARD_INNER, shape[1]), min(_SHARD_INNER, shape[2])
        inner = (c, ih, iw)
        shard = (c, _shard_dim(shape[1], ih), _shard_dim(shape[2], iw))
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
            if isinstance(rec, dict) and rec.get("_log"):
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


def _check_content_hash(path: str) -> None:
    """Log whether a `.zarr.zip` checkpoint's embedded hash (see `_save_zip`)
    still matches its actual bytes. Informational only — a mismatch (e.g. the
    file was hand-edited or copied incorrectly) is reported, never raised."""
    name = os.path.basename(path)
    if not name.endswith(".zarr.zip"):
        return
    stem = strip_checkpoint_ext(name)
    m = _HASH_SUFFIX_RE.search(stem)
    if not m:
        return  # not an auto-named checkpoint; nothing to verify
    expected = m.group(0)[1:]
    actual = _hash_zip_contents(path)
    if actual == expected:
        _log.info("checkpoint hash OK: %s", name)
    else:
        _log.warning("checkpoint hash mismatch: %s (filename says %s, contents hash to %s)",
                      name, expected, actual)


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
