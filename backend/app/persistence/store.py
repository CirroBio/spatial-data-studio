"""Persistence (DESIGN §13).

`sdata.write()` to a `.zarr` directory store round-trips data + `attrs["app_state"]`
reliably. Direct `.zarr.zip` writing is broken in spatialdata 0.7.3 (produces an
empty archive — the §17 "incremental write API has moved" risk), so `.zarr.zip`
export is implemented as write-dir-then-zip, and load as unzip-then-read.
"""
import hashlib
import logging
import os
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

import spatialdata as sd

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

# Content-hash suffix appended to auto-named `.zarr.zip` checkpoints (see
# `_save_zip`), e.g. "myfile-3fa21c9b8e4d.zarr.zip". Fixed length so it can be
# recognized and stripped again on the next save instead of piling up.
HASH_LEN = 12
_HASH_SUFFIX_RE = re.compile(rf"-[0-9a-f]{{{HASH_LEN}}}$")


def strip_content_hash(stem: str) -> str:
    """Remove a previously-appended content-hash suffix from a checkpoint's base
    name (without extension), so re-saving replaces it instead of stacking a new
    one on top."""
    return _HASH_SUFFIX_RE.sub("", stem)


def _hash_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:HASH_LEN]


def load_spatialdata(path: str):
    """Returns (sdata, app_state, newer, extract_dir). `extract_dir` is the temp
    directory a `.zarr.zip` was unpacked into — zarr maps chunks from it lazily for
    the object's lifetime, so the caller owns cleanup when the session closes."""
    extract_dir = None
    if path.endswith(".zarr.zip") or (os.path.isfile(path) and zipfile.is_zipfile(path)):
        _check_content_hash(path)
        extract_dir = tempfile.mkdtemp(suffix=".zarr")
        with zipfile.ZipFile(path) as zf:
            zf.extractall(extract_dir)
        sdata = sd.read_zarr(_zarr_root(extract_dir))
    else:
        sdata = sd.read_zarr(path)
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
    honored verbatim)."""
    sdata.attrs["app_state"] = app_state
    if path.endswith(".zarr.zip"):
        return _save_zip(sdata, path, hash_name)
    return _save_dir(sdata, path)


def _save_dir(sdata, path: str) -> str:
    p = Path(path)
    if p.exists():
        # spatialdata refuses to overwrite its own backing store; write a temp
        # sibling then swap.
        tmp = p.with_name(p.name + ".tmp")
        if tmp.exists():
            shutil.rmtree(tmp)
        sdata.write(str(tmp), overwrite=True)
        # Keep the original until the new store is fully written, then swap via two
        # atomic renames so a crash mid-save can't destroy the only copy.
        bak = p.with_name(p.name + ".bak")
        if bak.exists():
            shutil.rmtree(bak)
        os.replace(p, bak)
        os.replace(tmp, p)
        shutil.rmtree(bak, ignore_errors=True)
    else:
        sdata.write(path, overwrite=True)
    return path


def _save_zip(sdata, path: str, hash_name: bool) -> str:
    tmpdir = tempfile.mkdtemp()
    zarr_dir = os.path.join(tmpdir, "store.zarr")
    staging = os.path.join(tmpdir, "staged.zarr.zip")
    try:
        sdata.write(zarr_dir, overwrite=True)
        with zipfile.ZipFile(staging, "w", compression=zipfile.ZIP_STORED) as zf:
            for root, _, files in os.walk(zarr_dir):
                for f in files:
                    full = os.path.join(root, f)
                    zf.write(full, os.path.relpath(full, zarr_dir))

        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        if hash_name:
            stem = strip_content_hash(p.name[: -len(".zarr.zip")])
            final = p.with_name(f"{stem}-{_hash_file(staging)}.zarr.zip")
        else:
            final = p
        if final.exists():
            final.unlink()
        shutil.move(staging, final)
        return str(final)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _check_content_hash(path: str) -> None:
    """Log whether a `.zarr.zip` checkpoint's embedded hash (see `_save_zip`)
    still matches its actual bytes. Informational only — a mismatch (e.g. the
    file was hand-edited or copied incorrectly) is reported, never raised."""
    name = os.path.basename(path)
    if not name.endswith(".zarr.zip"):
        return
    stem = name[: -len(".zarr.zip")]
    m = _HASH_SUFFIX_RE.search(stem)
    if not m:
        return  # not an auto-named checkpoint; nothing to verify
    expected = m.group(0)[1:]
    actual = _hash_file(path)
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
