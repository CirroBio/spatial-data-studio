"""Persistence (DESIGN §13).

`sdata.write()` to a `.zarr` directory store round-trips data + `attrs["app_state"]`
reliably. Direct `.zarr.zip` writing is broken in spatialdata 0.7.3 (produces an
empty archive — the §17 "incremental write API has moved" risk), so `.zarr.zip`
export is implemented as write-dir-then-zip, and load as unzip-then-read.

`_save_zip`/`_save_dir` relocate the (potentially multi-MB) per-compute worker logs
out of `attrs["app_state"]` — which is inlined into the store's root `zarr.json`
and would otherwise be downloaded in full on open — into gzipped files under
`logs/`, read back lazily by `session.get_log`.

Rendered plot figures travel the same way: the caller passes the bytes of every
drawn plot it wants persisted and `_write_figures` puts them under
`viewer/figures/<plot_id>/<fmt>`, read back lazily by `read_figure`. A plot whose
figure is in the file reloads still `drawn` (see `load_spatialdata`).

A checkpoint is **directly browser-readable** over HTTP Range without this backend
(DESIGN §14): the serverless viewer opens the `.zarr.zip` with zarrita and renders
from it. Three write-time steps exist only to serve that reader. They are what make
it readable at all, not an optimization — a Zarr v3 store carries no child index, so
a checkpoint written before them is rejected by the viewer with a re-save message:

- `_shard_rasters` rewrites image/label arrays with the Zarr v3 sharding codec, so a
  multi-gigabyte level contributes tens of entries to the zip central directory
  instead of tens of thousands (the browser downloads that directory in full before
  the first tile).
- `_index_shapes` rewrites each polygonal `shapes/<el>/shapes.parquet` as spatially
  indexed GeoParquet 1.1 — Hilbert-sorted rows, a `covering` bbox column, small row
  groups — so the browser can prune row groups from the footer and range-read only the
  ones its viewport touches instead of downloading every boundary.
- `_write_viewer_sidecar` writes a `viewer/` group holding what the browser cannot
  cheaply derive: the per-image manifest from `imaging.image_info`, the points->global
  affine, the per-shapes-element index report, a gene-major (CSC) mirror of each
  table's `X` so coloring by one gene is a couple of range reads instead of a download
  of the whole CSR `data`+`indices` pair, and the drawn plot figures (`_write_figures`)
  the Plots view renders.
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
import xarray
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
# Additive keys (e.g. `figures`, `shapes`) don't bump it: an older reader ignores what
# it doesn't know, and bumping would make it refuse files it can still render.
VIEWER_SIDECAR_VERSION = 1
# Subgroup of `viewer/` holding one group per plot id, one uint8 array per format.
FIGURES_GROUP = "figures"
# The formats a drawn plot carries (`session.plot_figures`): SVG is what the app and
# the browser render, PDF is the publication export, PNG is what the MCP vision tool
# looks at. All three are persisted so a reloaded checkpoint loses no capability.
FIGURE_FORMATS = ("svg", "pdf", "png")
# Chunk length for the CSC mirror's `data`/`indices`, in elements. Sized from the data
# so one gene column lands in one or two chunks whatever the table's shape: a Visium
# gene holds a few hundred non-zeros, a Xenium gene hundreds of thousands, and a fixed
# size would either split every Xenium column across many chunks or make a Visium gene
# read drag in megabytes it doesn't need. Smaller chunks cost total size (zstd has less
# to work with): on the Visium test checkpoint the mirror is 66 MB at 16k vs 51 MB at
# 256k, against 72 KB vs 843 KB per gene read — latency is what this mirror exists for.
_CSC_CHUNK_MIN = 16384
_CSC_CHUNK_MAX = 1 << 20

# Shape spatial index (see `_index_shapes`). Row groups are the browser's pruning
# granularity, so their count is what matters: too few and a viewport read drags in
# most of the file, too many and the footer the browser downloads on every query
# outgrows the geometry it saves. `_ROW_GROUP_TARGET` row groups keeps the footer
# around a few hundred KiB at the top end (~1.9 KiB per row group for a boundary set's
# handful of columns), and the row bounds keep small elements from being split into
# row groups too thin to be worth a request.
_ROW_GROUP_TARGET = 256
_ROW_GROUP_ROWS_MIN = 4096
_ROW_GROUP_ROWS_MAX = 65536


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
    # A `drawn` status only means something if the figure came back with the file: one
    # saved with figures excluded, or written before they were persisted at all, has a
    # record with no bytes behind it. Those (and any status a save caught mid-flight)
    # load as `invalidated`, redrawable on demand.
    persisted = figure_index(extract_dir or path)
    for p in st.get("plots", []):
        if p.get("status") == "drawn" and p.get("id") in persisted:
            continue
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


def trim_pyramid(el, finest: int):
    """Multiscale image `el` with every pyramid level finer than `finest` dropped and
    the survivors renumbered from `scale0`.

    Each level carries its own transform to the global coordinate system — the level
    that becomes the new `scale0` keeps the downscale its old position implied — so the
    trimmed image still lands where it did. Levels are shared with `el`, not copied.
    A single-scale image, or `finest == 0`, comes back untouched.
    """
    from .. import imaging
    names = imaging._scale_names(el) if imaging._is_multiscale(el) else []
    if finest <= 0 or not names:
        return el
    kept = {f"/scale{i}": xarray.Dataset({"image": imaging._level_array(el, level)})
            for i, level in enumerate(range(finest, len(names)))}
    return xarray.DataTree.from_dict(kept)


def select_elements(sdata, include: dict[str, list[str]] | None = None,
                    levels: dict[str, int] | None = None):
    """Shallow view over `sdata` carrying only the named elements.

    A facet absent from `include` is kept whole; a facet present keeps exactly the
    names listed, so `{"images": []}` is how a caller drops every image. `levels` maps
    an image name to the finest pyramid level to keep (`trim_pyramid`), which shrinks an
    image rather than dropping it — for the same trim driven by a byte budget instead of
    a per-image choice, see `cap_image_levels`. Element
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
        names = include.get(facet) if include is not None else None
        kept[facet] = have if names is None else {n: have[n] for n in names if n in have}
    for name, finest in (levels or {}).items():
        if name in kept["images"]:
            kept["images"][name] = trim_pyramid(kept["images"][name], finest)
    view = sd.SpatialData(**kept)
    view.attrs = dict(sdata.attrs)
    return view


def _level_stored_mb(arr) -> float:
    """Estimated compressed MB one pyramid level occupies in a written checkpoint —
    the same shape x dtype x `_COMPRESSION` estimate `element_size_mb` falls back to,
    per level rather than per element."""
    return _level_nbytes(arr) * _COMPRESSION / 1e6


def cap_image_levels(sdata, max_mb: float):
    """Shallow view whose multiscale images have dropped their finest pyramid levels
    until the images' estimated stored size fits under `max_mb`, the kept levels
    renumbered from `scale0`.

    The image pyramid is the bulk of an imaging-based checkpoint — its finest level
    alone is around three quarters of it — so a capped copy carries the whole analysis
    in a small file and still renders, just without the deepest zoom. Nothing is
    resampled: each kept level already stores its own transform to the coordinate
    system, so the renumbered pyramid sits exactly where the original did, and
    `pixel_to_world` reads the new `scale0`'s transform the same way it read the old
    one.

    Levels come off whichever image is currently largest, so a session with one huge
    and one small image loses resolution where the bytes actually are. At least one
    level of each image always survives: if even the coarsest levels exceed `max_mb`
    the view is as small as it can be made this way, and the caller is told rather than
    handed an image-less object. Single-scale images pass through untouched, having no
    level to drop.

    This is the budget-driven half of the same trim `select_elements`'s `levels` does
    per image (both land in `trim_pyramid`): a batch caller names a size it must fit,
    the save dialog names the detail it wants to keep.

    Only images are trimmed — label pyramids are long runs of a few integer values and
    compress hard enough that their finest level is a rounding error.
    """
    from ..registry.base import sdata_facets
    from .. import imaging

    kept = {facet: dict(getattr(sdata, facet, {}) or {}) for facet in sdata_facets()}
    # name -> estimated MB per level still kept, finest first.
    pyramids = {}
    fixed_mb = 0.0
    for name, el in kept["images"].items():
        if not imaging._is_multiscale(el):
            fixed_mb += _level_stored_mb(imaging._level_array(el, 0))
            continue
        pyramids[name] = [_level_stored_mb(el[s]["image"]) for s in imaging._scale_names(el)]

    def total():
        return fixed_mb + sum(mb for levels in pyramids.values() for mb in levels)

    # Drop from the image whose finest level is biggest, until it fits or nothing is
    # left to drop.
    dropped = {name: 0 for name in pyramids}
    while total() > max_mb:
        droppable = {name: levels for name, levels in pyramids.items() if len(levels) > 1}
        if not droppable:
            break
        biggest = max(droppable, key=lambda name: droppable[name][0])
        pyramids[biggest] = pyramids[biggest][1:]
        dropped[biggest] += 1

    for name, finest in dropped.items():
        kept["images"][name] = trim_pyramid(kept["images"][name], finest)

    view = sd.SpatialData(**kept)
    view.attrs = dict(sdata.attrs)
    return view


def save_spatialdata(sdata, path: str, app_state: dict, hash_name: bool = False,
                     include: dict[str, list[str]] | None = None,
                     levels: dict[str, int] | None = None,
                     max_image_mb: float | None = None,
                     figures: dict[str, dict[str, bytes]] | None = None) -> str:
    """`hash_name` renames a `.zarr.zip` checkpoint to embed a hash of its own
    contents once written (auto-managed saves only — explicit save-as paths are
    honored verbatim). Worker logs are stripped from the persisted `app_state` and
    written under `logs/` instead (see module docstring); the caller's live
    `app_state` is left untouched.

    `include` (facet -> element names) writes only those elements — see
    `select_elements` for the absent-vs-present rule. Displays naming a dropped
    element are neutralised so the file still renders; the live object keeps
    everything.

    `levels` (image name -> finest pyramid level) and `max_image_mb` both write images
    at reduced resolution — the first per image, the second to fit a byte budget (see
    `select_elements` and `cap_image_levels`). Both drop resolution, not elements, so
    nothing in `app_state` needs neutralising for them.

    `figures` (plot id -> format -> bytes) are the rendered plots to persist; see
    `_write_figures`."""
    if include is not None or levels:
        from ..registry.base import sdata_facets
        sdata = select_elements(sdata, include, levels)
        app_state = appstate.prune_to_elements(
            app_state, {f: set(getattr(sdata, f, {}) or {}) for f in sdata_facets()})
    if max_image_mb is not None:
        sdata = cap_image_levels(sdata, max_image_mb)
    persisted, logs = _split_logs(app_state)
    checkpoint_schemas.validate_app_state(persisted)
    original = sdata.attrs.get("app_state")
    sdata.attrs["app_state"] = persisted
    uns_swaps = _stringify_uns_recarrays(sdata)
    try:
        if path.endswith(".zarr.zip"):
            written = _save_zip(sdata, path, hash_name, logs, figures)
        else:
            written = _save_dir(sdata, path, logs, figures)
    finally:
        # Restore the identity between sdata.attrs and the live session app_state
        # (they are the same object during a live session).
        sdata.attrs["app_state"] = original if original is not None else app_state
        for mapping, key, orig in uns_swaps:
            mapping[key] = orig
    _invalidate_dataset_scan()
    return written


def _save_dir(sdata, path: str, logs: dict[str, str],
              figures: dict[str, dict[str, bytes]] | None = None) -> str:
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
        _write_browser_reader_support(str(tmp), sdata, figures)
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
        _write_browser_reader_support(path, sdata, figures)
        _write_logs(path, logs)
    return path


def _save_zip(sdata, path: str, hash_name: bool, logs: dict[str, str],
              figures: dict[str, dict[str, bytes]] | None = None) -> str:
    Path(path).parent.mkdir(parents=True, exist_ok=True)  # may be a new subfolder
    tmpdir = tempfile.mkdtemp(dir=str(Path(path).parent), prefix=".save-")
    zarr_dir = os.path.join(tmpdir, "store.zarr")
    try:
        # This temp store is zipped then deleted; don't let the live object adopt it
        # as its backing path (spatialdata's write() does so by default), or every
        # later str(sdata) — e.g. the SpatialData manifest contributor — fails once
        # the temp dir is gone.
        sdata.write(zarr_dir, overwrite=True, update_sdata_path=False)
        _write_browser_reader_support(zarr_dir, sdata, figures)
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
                      transforms: set[str], hash_name: bool = False,
                      figures: dict[str, dict[str, bytes]] | None = None) -> str:
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
        # need refreshing: a changed table invalidates its CSC mirror and its shape
        # `cell_index` mirrors, and a changed transform moves `pixel_to_world`. The
        # image manifest is cheap, so it is always rebuilt; the CSC rebuild is limited
        # to the dirty tables. The shape index is re-derived (not passed in): it is
        # idempotent on a store already indexed, and this is the path that upgrades a
        # checkpoint first saved before the index existed.
        _write_viewer_sidecar(work_dir, sdata, tables=tables, figures=figures)
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
    destination is in DATA_DIR or an arbitrary CLI output dir. The destination folder is
    created first, since staging beside a folder that doesn't exist yet cannot work (a
    save into a new subfolder is one of the Save dialog's options)."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmpdir = tempfile.mkdtemp(dir=str(p.parent), prefix=".save-")
    staging = os.path.join(tmpdir, "staged.zarr.zip")
    try:
        digest = _zip_dir(src_dir, staging)
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
def _write_browser_reader_support(zarr_dir: str, sdata,
                                  figures: dict[str, dict[str, bytes]] | None = None) -> None:
    """Make a freshly-written store directly readable by the serverless viewer.
    Order matters: the shape index runs before the sidecar, which publishes its report,
    and consolidation runs last so the tree the browser fetches reports the sharded
    codec and lists the `viewer/` sidecar."""
    _shard_rasters(zarr_dir)
    _write_viewer_sidecar(zarr_dir, sdata, figures=figures,
                          shapes=_index_shapes(zarr_dir, sdata))
    _consolidate(zarr_dir)


def _consolidate(zarr_dir: str) -> None:
    """Re-run consolidated metadata over a store at an arbitrary path. Reuses
    spatialdata's own helper — it silences the `ZarrUserWarning` the `.parquet` shape
    files provoke — rather than calling `zarr.consolidate_metadata` directly.
    `SpatialData.write_consolidated_metadata` can't be used here because it reads
    `sdata.path`, which these save paths deliberately leave pointing elsewhere."""
    from spatialdata._io.io_zarr import _write_consolidated_metadata
    _write_consolidated_metadata(zarr_dir)


def _write_viewer_sidecar(zarr_dir: str, sdata, tables: set[str] | None = None,
                          figures: dict[str, dict[str, bytes]] | None = None,
                          shapes: dict[str, dict] | None = None) -> None:
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
    - `viewer/figures/<plot_id>` holds the rendered plots (`_write_figures`), listed
      in the `figures` attr so a reader knows what is there without walking the tree.
    - `shapes` is `_index_shapes`' report, and `viewer/shapes/<el>/<table>/cell_index`
      the label->obs-row mapping written alongside it. Together they let the viewer plan
      a boundary query — pick an element, invert its viewport, prune row groups, check
      the cost — entirely from consolidated metadata, without a single speculative read
      against the geometry.

    `tables` limits the CSC rebuild to those keys (the incremental save path knows
    which tables changed); None rebuilds all of them. `figures` is the complete set to
    end up in the file — whatever it omits is removed, so a caller passing None or `{}`
    writes a checkpoint with no figures at all.
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
        "figures": {pid: {fmt: len(blob) for fmt, blob in blobs.items()}
                    for pid, blobs in (figures or {}).items() if blobs},
        "shapes": shapes if shapes is not None else _index_shapes(zarr_dir, sdata),
    }
    checkpoint_schemas.validate_viewer_sidecar(sidecar)
    group.attrs.update(sidecar)
    _write_figures(zarr_dir, group, figures or {})
    for key in table_keys if tables is None else (tables & set(table_keys)):
        _write_csc_mirror(group, key, sdata.tables[key])
    for element in sidecar["shapes"]:
        _write_shape_cell_index(group, zarr_dir, element, sdata, table_keys)


def _write_shape_cell_index(group, zarr_dir: str, element: str, sdata,
                            table_keys: list[str]) -> None:
    """`viewer/shapes/<element>/<table>/cell_index`: for each row of the indexed
    `shapes.parquet`, that shape's row position in `table`'s obs (-1 unmatched) — the
    int32 column the boundary layer gathers per-cell colors from.

    It is baked because the browser cannot cheaply reproduce it. The mapping is by
    index *label* (`transport.geometry.cell_index`), so deriving it in JS would mean
    downloading the element's whole label column and the table's whole obs index just
    to align two orderings. Labels are read back from the parquet rather than taken
    from the in-memory GeoDataFrame so the array is aligned with the file's actual row
    order even when `_index_shapes` skipped an already-indexed file whose order no
    longer matches the live object's.

    Chunked at the file's row-group length, so the viewer's read for one surviving row
    group is one chunk."""
    from ..transport import geometry

    labels = _parquet_row_labels(os.path.join(zarr_dir, "shapes", element, "shapes.parquet"))
    dest = group.require_group("shapes").require_group(element)
    for key in table_keys:
        values = geometry.cell_index(sdata.tables[key], labels)
        arr = dest.require_group(key).create_array(
            "cell_index", shape=values.shape, dtype=values.dtype,
            chunks=(max(1, min(_row_group_rows(len(labels)), len(values))),), overwrite=True)
        arr[:] = values


def _parquet_row_labels(path: str) -> list:
    """The row labels of a shapes parquet, in file order: the pandas index column if
    one was written, else the implicit 0..n-1 of a RangeIndex. Reads that one column,
    never the geometry."""
    import pyarrow.parquet as pq

    pf = pq.ParquetFile(path)
    pandas_meta = json.loads((pf.metadata.metadata or {}).get(b"pandas") or b"{}")
    index_cols = [c for c in pandas_meta.get("index_columns", []) if isinstance(c, str)]
    if not index_cols:
        return list(range(pf.metadata.num_rows))
    return pf.read(columns=index_cols).column(0).to_pylist()


def _write_figures(zarr_dir: str, viewer_group, figures: dict[str, dict[str, bytes]]) -> None:
    """Rendered plot figures as `viewer/figures/<plot_id>/<fmt>` uint8 arrays, one
    chunk each so a reader fetches a figure in a single range read (and gets the store's
    zstd for free — an SVG scatter compresses several-fold).

    The group is rebuilt from scratch rather than added to: `figures` is the complete
    desired state, so a plot the user deselected, deleted, or invalidated since the last
    save leaves nothing behind. That means the incremental save path re-writes the bytes
    of every kept figure each time, which is cheap next to the tables it is already
    rewriting."""
    dest = os.path.join(zarr_dir, VIEWER_GROUP, FIGURES_GROUP)
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    if not figures:
        return
    group = viewer_group.require_group(FIGURES_GROUP)
    for plot_id, blobs in figures.items():
        node = group.require_group(plot_id)
        for fmt, blob in blobs.items():
            data = np.frombuffer(blob, dtype=np.uint8)
            arr = node.create_array(fmt, shape=data.shape, dtype=data.dtype,
                                    chunks=(max(1, data.size),), overwrite=True)
            arr[:] = data


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


# ---- shape spatial index ----------------------------------------------------
def _index_shapes(zarr_dir: str, sdata) -> dict[str, dict]:
    """Rewrite every polygonal `shapes/<el>/shapes.parquet` in the store as spatially
    indexed GeoParquet 1.1, and return the per-element report the sidecar publishes.

    spatialdata writes shapes with a bare `GeoDataFrame.to_parquet()`: WKB geometry,
    snappy, one row group, rows in whatever order the reader produced. Every one of
    those defeats a range-reading browser. Parquet's own min/max statistics on a WKB
    binary column are lexicographic over the bytes and so spatially meaningless, and
    with a single row group there is nothing to prune anyway — the viewer's only option
    is to download every boundary in the sample to draw the few hundred on screen.

    Three changes make the same file range-queryable:

    - **Hilbert sort.** Rows are ordered by a space-filling curve over their centroids,
      so a row group holds geometry that is actually adjacent on the slide. Without it
      the remaining two steps are decoration: every row group's bbox approximates the
      whole extent and pruning eliminates nothing.
    - **`covering` bbox column.** A `bbox` struct of per-feature bounds, registered in
      the `geo` metadata's `covering` key. Its FLOAT64 members get real numeric
      row-group statistics, which is what the viewer intersects its viewport against.
      `geopandas.read_parquet` recognizes `covering` and drops the column again on read,
      so the GeoDataFrame the backend loads back is unchanged.
    - **Small row groups + zstd.** `_row_group_rows` sizes the pruning granularity;
      zstd over snappy is ~30% off the wire on real boundary geometry (measured on the
      Xenium test element: 2.13 MB snappy vs 1.51 MB zstd).

    Point/circle shapes are left alone — they are served as scatter, not outlines, and
    the viewer reads their coordinates from the table. `annotations` is skipped too: it
    is a handful of user-drawn shapes whose row order is the order they appear in the
    annotation list, and re-sorting it would shuffle that for no gain.

    Idempotent: an element already carrying `covering` is left untouched, so the
    incremental save path can call this over a store it has already indexed.
    """
    report: dict[str, dict] = {}
    from ..sessions import shape_annotations
    from ..transport import geometry

    for element, gdf in getattr(sdata, "shapes", {}).items():
        path = os.path.join(zarr_dir, "shapes", element, "shapes.parquet")
        if element == shape_annotations.ELEMENT or not os.path.isfile(path):
            continue
        if not geometry.is_polygonal(gdf):
            continue
        entry = _index_shape_parquet(path, gdf)
        if entry is not None:
            report[element] = entry
            _log.info("shape index %s: %d rows, %d row groups, footer %.1f KiB, "
                      "selectivity %.4f", element, entry["num_rows"], entry["row_groups"],
                      entry["footer_bytes"] / 1024, entry["selectivity"])
    return report


def _index_shape_parquet(path: str, gdf) -> dict | None:
    """Rewrite one `shapes.parquet` in indexed form and report on the result. Returns None
    when there is nothing to publish: an element with no rows, or one whose every geometry
    is empty or missing."""
    if len(gdf) == 0:
        return None
    if _has_covering(path):
        return _shape_index_report(path)
    tmp = path + ".indexing"
    gdf.iloc[_hilbert_order(gdf)].to_parquet(
        tmp, write_covering_bbox=True, schema_version="1.1.0", compression="zstd",
        row_group_size=_row_group_rows(len(gdf)),
        # Page-level pruning below the row group, for free at ~85 bytes per row group.
        write_page_index=True,
    )
    os.replace(tmp, path)
    return _shape_index_report(path)


def _hilbert_order(gdf) -> np.ndarray:
    """Row positions in Hilbert-curve order over feature centroids.

    Empty and missing geometries are sorted to the end rather than mixed in:
    `hilbert_distance` refuses a GeoSeries containing either (it has no centroid to
    place them by), and raising here would fail the whole checkpoint save over one bad
    cell — which a filtered element or an upstream geometry op can easily produce. They
    keep their labels and their row order, and get a null `covering` bbox, so the viewer
    prunes them away instead of drawing them."""
    import shapely

    geoms = gdf.geometry
    # shapely's predicates rather than `notna()`/`is_empty`: geopandas is mid-change on
    # what those mean for an empty geometry and warns on every call, while these two say
    # exactly what is meant and take the array as it is.
    values = geoms.to_numpy()
    drawable = ~(shapely.is_missing(values) | shapely.is_empty(values))
    if drawable.all():
        return np.argsort(geoms.hilbert_distance().to_numpy(), kind="stable")
    at = np.flatnonzero(drawable)
    if at.size == 0:
        # Nothing to order, and `hilbert_distance` cannot reduce over zero rows. The
        # file is still written (the element keeps its rows for the Python reader); the
        # report then finds no bounds and omits it, so no viewer offers its boundaries.
        return np.arange(len(gdf))
    sorted_at = at[np.argsort(geoms.iloc[at].hilbert_distance().to_numpy(), kind="stable")]
    return np.concatenate([sorted_at, np.flatnonzero(~drawable)])


def _row_group_rows(n: int) -> int:
    """Rows per row group: `n / _ROW_GROUP_TARGET` clamped to
    [`_ROW_GROUP_ROWS_MIN`, `_ROW_GROUP_ROWS_MAX`]. The ratio bounds the footer on a
    large element (a million-cell sample gets ~250 row groups, not ~250 thousand); the
    floor stops a small one from being cut into row groups so thin that the per-request
    overhead dwarfs the geometry, and it is also why a small element ends up with a
    handful of row groups and correspondingly weak selectivity — such a file is small
    enough for the viewer to read whole, which is what its budget check decides."""
    return int(min(_ROW_GROUP_ROWS_MAX, max(_ROW_GROUP_ROWS_MIN, -(-n // _ROW_GROUP_TARGET))))


def _has_covering(path: str) -> bool:
    import pyarrow.parquet as pq
    geo = pq.ParquetFile(path).metadata.metadata.get(b"geo")
    if not geo:
        return False
    parsed = json.loads(geo)
    column = parsed.get("columns", {}).get(parsed.get("primary_column"), {})
    return "covering" in column


def _shape_index_report(path: str) -> dict | None:
    """Everything the viewer needs to plan a query against this element without touching
    the file first: its geometry kinds and extent (so it can skip an element the viewport
    misses entirely), its size in rows and row groups, and the measured selectivity +
    footer size its budget check reads. Bounds are intrinsic — the same space the
    `covering` statistics are in, and the space the viewer inverts its viewport into
    using the element's transform.

    Every field is read from the file, never from the in-memory GeoDataFrame, so the
    report cannot disagree with what it describes. That matters on the idempotent path:
    an already-indexed file is deliberately *not* rewritten to match the live object, so
    a report taken from that object could claim a narrower extent than the file holds
    (viewports over the difference would draw nothing) or claim Polygon-only for a file
    holding MultiPolygons (the reader would pick the wrong GeoArrow nesting)."""
    import pyarrow.parquet as pq

    md = pq.ParquetFile(path).metadata
    geo = json.loads(md.metadata[b"geo"])
    column = geo["columns"][geo["primary_column"]]
    boxes = _covering_boxes(md)
    if not boxes:
        # No row group has usable bounds, so every geometry in the file is empty or
        # missing: there is nothing for the viewer to draw and no extent to publish.
        # Omitting the element leaves the boundary overlay off, which is the honest
        # outcome — a zero-area `bounds` would instead reject every viewport that misses
        # the origin and look like a bug.
        return None
    return {
        # Required of every GeoParquet column, and written from the data itself. The
        # dimension band is dropped ("Polygon Z" -> "Polygon"): the reader and the
        # boundary picker both match the bare names, and a 3-D element is drawn from its
        # x/y like any other (`wkbGeoArrow` skips the Z/M ordinates).
        "geometry_types": sorted({str(t).split()[0] for t in column["geometry_types"]}),
        "num_rows": int(md.num_rows),
        "row_groups": int(md.num_row_groups),
        "file_bytes": int(os.path.getsize(path)),
        "footer_bytes": int(md.serialized_size),
        "bounds": _union_box(boxes),
        "selectivity": _selectivity(md, boxes),
    }


def _selectivity(md, boxes: list[tuple] | None = None) -> float:
    """Median fraction of the element's extent covered by a single row group's bbox —
    the number that decides whether range-querying this file actually pays. The ideal
    is 1/num_row_groups (disjoint row groups tiling the extent); a well-sorted file
    lands within a small factor of that, an unsorted one near 1.0 because every row
    group spans everything. Measured from the `covering` column's row-group statistics,
    i.e. from exactly the values the viewer prunes on."""
    if boxes is None:
        boxes = _covering_boxes(md)
    if not boxes:
        return 1.0
    denom = _box_area(_union_box(boxes))
    if denom <= 0:
        # A degenerate extent (every feature on one line, or a single feature) has no
        # area to take a ratio against; report the no-pruning-benefit end of the scale
        # rather than dividing by zero.
        return 1.0
    ratios = sorted(_box_area(b) / denom for b in boxes)
    return float(ratios[len(ratios) // 2])


def _covering_boxes(md) -> list[tuple]:
    """Bounding boxes of the row groups that have usable `covering` statistics. A row
    group with none is omitted rather than poisoning the result — Parquet permits unset
    min/max, and a row group holding only empty/missing geometry has exactly that (see
    `_hilbert_order`, which sorts such rows to the end and so can fill one)."""
    stats = _covering_stats(md)
    if stats is None:
        return []
    return [(s["xmin"].min, s["ymin"].min, s["xmax"].max, s["ymax"].max)
            for s in stats if s is not None]


def _union_box(boxes: list[tuple]) -> list[float]:
    """The element's extent: the union of its row-group boxes, which is exactly the union
    of every feature's bbox and therefore the same number `total_bounds` would give — but
    derived from the file, and from the very statistics the viewer prunes against."""
    return [float(min(b[0] for b in boxes)), float(min(b[1] for b in boxes)),
            float(max(b[2] for b in boxes)), float(max(b[3] for b in boxes))]


def _covering_stats(md) -> list[dict | None] | None:
    """Statistics of the four `covering` bbox members, one entry per row group in
    row-group order, or None when the file carries no covering column at all.

    An individual entry is None when that row group's statistics are unset — Parquet
    permits a `Statistics` object with no min/max, which must be read as absent, not as
    an empty range. Only that row group is unknown, so callers ignore it rather than
    discarding every other row group's box with it."""
    geo = json.loads(md.metadata[b"geo"])
    covering = geo["columns"][geo["primary_column"]].get("covering")
    if not covering:
        return None
    paths = {k: ".".join(v) for k, v in covering["bbox"].items()}
    first = md.row_group(0)
    col_at = {first.column(i).path_in_schema: i for i in range(first.num_columns)}
    if not all(p in col_at for p in paths.values()):
        return None
    out: list[dict | None] = []
    for r in range(md.num_row_groups):
        rg = md.row_group(r)
        entry = {}
        for member, p in paths.items():
            s = rg.column(col_at[p]).statistics
            if s is None or not s.has_min_max:
                entry = None
                break
            entry[member] = s
        out.append(entry or None)
    return out


def _box_area(b) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


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


# ---- persisted plot figures -------------------------------------------------
def figure_index(store_root: str | None) -> dict[str, dict[str, int]]:
    """`{plot_id: {format: byte length}}` for the figures in a loaded checkpoint's
    on-disk store — the sidecar's `figures` attr, read as-is. Empty for a store with
    none (including one written before figures were persisted).

    The sizes are in the attr rather than measured from the arrays so this is a single
    small read: the session's state response reports the index on every poll."""
    if not store_root:
        return {}
    meta_path = os.path.join(store_root, VIEWER_GROUP, "zarr.json")
    if not os.path.isfile(meta_path):
        return {}
    with open(meta_path) as f:
        return json.load(f).get("attributes", {}).get("figures", {})


def read_figure(store_root: str | None, plot_id: str, fmt: str) -> bytes | None:
    """Read one persisted figure back out of a loaded checkpoint's on-disk store (the
    extract dir for a `.zarr.zip`, or the store dir itself), like `read_log`. Returns
    None when the checkpoint holds no such figure."""
    if not store_root or fmt not in FIGURE_FORMATS:
        return None
    node = os.path.join(store_root, VIEWER_GROUP, FIGURES_GROUP, plot_id, fmt)
    if not os.path.isdir(node):
        return None
    return zarr.open_array(node, mode="r")[:].tobytes()


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


def _level_nbytes(arr) -> int:
    return int(np.prod(arr.shape)) * np.dtype(arr.dtype).itemsize


def _raster_nbytes(el) -> int:
    """Uncompressed bytes across every pyramid level of an image/labels element."""
    from .. import imaging
    levels = len(imaging._scale_names(el)) if imaging._is_multiscale(el) else 1
    return sum(_level_nbytes(imaging._level_array(el, i)) for i in range(levels))


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


def _element_dir(sdata, facet: str, name: str,
                 stores: dict[str, str] | None = None) -> Path | None:
    """Directory holding one element's arrays on disk — the object's own backing store,
    or the per-element store a rebuilt raster was written to (`Session.raster_stores`) —
    or None when the element isn't backed by either."""
    for root in (getattr(sdata, "path", None), (stores or {}).get(name)):
        if root and (d := Path(root) / facet / name).is_dir():
            return d
    return None


def _level_dirs(d: Path) -> list[Path]:
    """A raster element's per-level subdirectories, finest first. Writers disagree on
    the naming (`0, 1, …` for zarr v2 stores, `s0, s1, …` for v3), so they're ordered by
    the trailing integer rather than lexically."""
    numbered = [(m.group(1), p) for p in d.iterdir()
                if p.is_dir() and (m := re.fullmatch(r"s?(\d+)", p.name))]
    return [p for _, p in sorted(numbered, key=lambda kv: int(kv[0]))]


def image_levels(sdata, name: str, stores: dict[str, str] | None = None) -> list[dict]:
    """Per pyramid level of one image, finest first: `imaging._levels_meta`'s index and
    native pixel dims plus the `size_mb` that level contributes to a written checkpoint.
    A single-scale image reports one level.

    Sizes follow `element_size_mb`'s two tiers and its accuracy contract, per level: the
    real compressed bytes when the level sits in a store on disk, otherwise an estimate
    from shape and dtype. Summed over the levels they come to that function's whole-
    element number, so the save dialog can subtract dropped levels from the total."""
    from .. import imaging
    meta = imaging._levels_meta(sdata, name)
    d = _element_dir(sdata, "images", name, stores)
    dirs = _level_dirs(d) if d is not None else []
    # A store written for a different pyramid than the one in memory (a raster rebuilt
    # since the load) can't be matched up level by level; estimate the whole thing.
    if len(dirs) != len(meta):
        dirs = []
    el = sdata.images[name]
    out = []
    for lv in meta:
        if dirs:
            mb = _dir_bytes(dirs[lv["level"]]) / 1e6
        else:
            mb = _level_stored_mb(imaging._level_array(el, lv["level"]))
        out.append({**lv, "size_mb": round(mb, 1)})
    return out


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
    if (d := _element_dir(sdata, facet, name, stores)) is not None:
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
