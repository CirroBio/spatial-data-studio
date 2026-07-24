"""Ingest-time raster normalization (DESIGN §9.3).

Readers and older checkpoints hand us image/label elements with whatever pyramid
and chunking the source happened to use — often a single scale, or huge store
chunks (Xenium morphology: 4096x4096). The tile server slices a TILE_SIZE window
per request, but dask must realize every *store* chunk that window touches, so a
512 px tile off a 4096 chunk pulls ~134 MB per channel; a zoom burst multiplies
that into an OOM.

`normalize_rasters` rebuilds every image/label into a canonical form once, up
front, chunked at TILE_SIZE as one channel-tile per store chunk (1, TILE, TILE):
images become a 2x pyramid down to a <= RASTER_BASE_PX base; labels are rebuilt
single-scale (they aren't LOD-rendered, and a nearest downsample of integer IDs
doesn't stream). One channel per chunk is the standard OME-NGFF layout Viv reads. The
rebuilt elements are written to a per-session cache store (so the tiny-window reads
actually hit tile-sized store chunks, which an in-memory rechunk alone can't
achieve) and the live SpatialData is rebound to lazy refs into it. The caller owns
the returned dir for cleanup.
"""
import gc
import math
import os
import tempfile
from pathlib import Path

import dask
import spatialdata as sd
from spatialdata.models import Image2DModel, Labels2DModel
from spatialdata.transformations import get_transformation

from . import imaging
from .config import config

TILE = imaging.TILE_SIZE


def _is_canonical(el, is_label: bool) -> bool:
    """True if `el`'s array is already shaped like our tile-chunked output — store
    chunks no larger than a tile, and (for images) a pyramid unless already small
    (labels aren't LOD-rendered, so a single tile-chunked scale is their canonical
    form — see `_rebuild`). Shape alone doesn't mean "free to skip": an image can be
    canonically shaped yet still backed by a slow original mount, so `normalize_rasters`
    additionally gates images on locality (see its `known_stores` param) before
    treating this as a no-op."""
    arr = imaging._level_array(el, 0)
    chunksize = getattr(getattr(arr, "data", None), "chunksize", None)
    if chunksize is None:  # eagerly-loaded numpy: not lazy/tiled, rebuild it
        return False
    if chunksize[-2] > TILE or chunksize[-1] > TILE:
        return False
    # Images must be chunked one channel per store chunk (see `_rebuild`): a packed
    # (C, tile, tile) chunk would make Viv's per-channel getTile fetch the same chunk
    # N times. A 3D image array is (c, y, x); a store packing channels is not canonical.
    if not is_label and arr.ndim >= 3 and chunksize[0] != 1:
        return False
    if is_label or imaging._is_multiscale(el):
        return True
    return max(arr.shape[-1], arr.shape[-2]) <= config.RASTER_BASE_PX


def _scale_factors(max_dim: int) -> list[int] | None:
    """2x steps until the coarsest level's longest side is <= RASTER_BASE_PX.
    None (a single level) when the element is already at/under the base size."""
    if max_dim <= config.RASTER_BASE_PX:
        return None
    return [2] * math.ceil(math.log2(max_dim / config.RASTER_BASE_PX))


def _rebuild(el, is_label: bool):
    arr = imaging._level_array(el, 0)
    dims = tuple(arr.dims)
    transforms = get_transformation(el, get_all=True)
    if is_label:
        # No pyramid for labels: they aren't LOD-rendered, and a nearest-neighbour
        # downsample (mode/nearest can't average integer IDs) doesn't stream — it
        # materializes the whole array + every level at once (~6 GB for a 1.9 GB
        # Xenium label). A single tile-chunked scale is a pure lazy rechunk.
        return Labels2DModel.parse(arr.data, dims=dims, scale_factors=None,
                                   chunks=(TILE, TILE), transformations=transforms)
    data = arr.data
    if arr.ndim == 2:
        # Image2DModel is (c, y, x); promote a bare (y, x) grayscale raster so parse
        # doesn't get a 3-tuple chunks against 2-D data (which raises, aborting load).
        data = data[None, ...]
        dims = ("c", "y", "x")
        c_coords = ["0"]
    else:
        c_coords = [str(c) for c in arr.coords["c"].values] if "c" in arr.coords else None
    # Chunk one channel per chunk (1, TILE, TILE), not all channels together
    # (C, TILE, TILE): this is the standard OME-NGFF layout, and it makes Viv's
    # per-channel getTile fetch a distinct chunk URL per channel — so no client-side
    # fetch-dedup shim is needed to collapse N identical requests for one packed chunk.
    return Image2DModel.parse(data, dims=dims, c_coords=c_coords,
                              scale_factors=_scale_factors(max(arr.shape[-1], arr.shape[-2])),
                              chunks=(1, TILE, TILE), transformations=transforms)


def normalize_rasters(sdata, progress=None,
                      known_stores: dict[str, str] | None = None) -> tuple[str | None, dict[str, str]]:
    """Rebuild every non-canonical (or canonical-but-not-yet-local, see below)
    image/label of `sdata` into a tile-chunked 2x pyramid, persist them to a fresh
    cache store under WORK_DIR, and rebind `sdata`'s elements to lazy refs into it.
    Returns (cache_dir, element_stores): the cache dir (the caller must rmtree it
    when the session closes, or None if nothing needed rebuilding) and a map from
    every image's name to the absolute store dir serving it — the freshly-rebuilt
    `{i}.zarr` dir, or `sdata.path` itself for a canonical image already known to be
    local. The raster HTTP route resolves an element to its store via that map
    (spatialdata element names are globally unique across images/labels, so a single
    name-keyed map is unambiguous); labels never populate it since only images serve
    client compositing (see `main.py::image_info`'s `client_compositing` gate).
    `progress(message, pct)` (optional) reports per-element rebuild progress; see
    `create_from_load`.

    `known_stores` is the session's own `raster_stores` map from its previous call
    here (`{}` on a session's first call) — every name in it was already resolved to
    a local store by a prior call, under this same rule, so it's trusted without
    re-checking locality. This session-scoped memory is what keeps the locality
    check below from re-triggering on every subsequent call (e.g. a reshaping
    compute that adopts a new object carrying the same already-normalized image refs
    forward): only an element's first-ever appearance in a session pays the
    locality check or rebuild cost."""
    report = progress or (lambda *a, **k: None)
    known = known_stores or {}
    # `sdata.path` is the object's own backing root (set by `sd.read_zarr`; same
    # attribute `can_update_incrementally` reads). A bare `.zarr` directory (as
    # opposed to a `.zarr.zip`/`.zarr.tar.gz`, which persistence/store.py extracts
    # into WORK_DIR first) is read in place, so this can point at a slow network/
    # object-store mount. A canonical (already tile-chunked) image on such a mount
    # would otherwise be served straight from it forever, reading live on every tile
    # request — so a canonical image not already known-local also goes through the
    # rebuild below, which for it is a cheap chunk-shape-preserving copy into WORK_DIR.
    backing_root = str(sdata.path) if getattr(sdata, "path", None) else None
    outside_workdir = backing_root is not None and not Path(backing_root).resolve().is_relative_to(
        config.WORK_DIR.resolve())
    todo = [("images", n) for n, el in getattr(sdata, "images", {}).items()
            if not _is_canonical(el, False) or (n not in known and outside_workdir)]
    todo += [("labels", n) for n, el in getattr(sdata, "labels", {}).items() if not _is_canonical(el, True)]

    # A canonical-and-already-local image (no rebuild needed — e.g. reloaded from
    # one of our own checkpoints) still needs a `stores` entry: the client-
    # compositing endpoint (main.py::raster_store) serves chunks straight from an
    # element's own backing store, keyed by this map. Without an entry here, `has_store`
    # is false and every reopened checkpoint falls back to server-side WebP tiling even
    # though nothing needed rebuilding. This doesn't create or own a new directory,
    # just points at one the session already keeps alive via `extract_dir`.
    #
    # `known.get(name)` takes priority over `backing_root`: `sdata.path` is the whole
    # *object's* original backing root and never changes even after an element gets
    # rebound to a rebuilt WORK_DIR store, so for an element this session previously
    # force-rebuilt (locality check above, on an earlier call), `backing_root` would
    # be the stale original — possibly slow — path. `known_stores` already carries
    # that element's real, current store dir forward.
    todo_names = {n for _, n in todo}
    stores: dict[str, str] = {}
    for name in getattr(sdata, "images", {}):
        if name in todo_names:
            continue
        store = known.get(name) or backing_root
        if store:
            stores[name] = store

    if not todo:
        return None, stores

    cache_dir = tempfile.mkdtemp(suffix=".rasters", dir=str(config.WORK_DIR))
    # Rebuild one element at a time, freeing between: each is a full read, so writing
    # them together sums their footprints (all four Xenium rasters at once peak
    # ~8.8 GB). Per-element with a small dask pool, peak is the largest single
    # element (~2.1 GB for the 3.8 GB morphology image).
    with dask.config.set(scheduler="threads", num_workers=config.RASTER_REBUILD_WORKERS):
        for i, (kind, name) in enumerate(todo):
            report(f"Preparing image {i + 1}/{len(todo)}…")
            rebuilt = _rebuild(getattr(sdata, kind)[name], is_label=(kind == "labels"))
            store = os.path.join(cache_dir, f"{i}.zarr")  # write() needs a non-existing path
            sd.SpatialData(**{kind: {name: rebuilt}}).write(store)
            getattr(sdata, kind)[name] = getattr(sd.read_zarr(store), kind)[name]
            stores[name] = store
            del rebuilt
            gc.collect()
    return cache_dir, stores


def cache_size_mb(cache_dir: str | None) -> float:
    """On-disk size (MB) of a raster cache store dir, for the resource strip's disk
    accounting. 0.0 when the load was canonical and built no cache (cache_dir is None).
    Called once per load, not per resource tick — the cache is immutable for a
    session's life, so the sampler reads the stored figure rather than re-walking."""
    if not cache_dir:
        return 0.0
    total = 0
    for root, _dirs, files in os.walk(cache_dir):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                continue  # file vanished mid-walk (a concurrent close); skip it
    return round(total / 1e6, 1)
