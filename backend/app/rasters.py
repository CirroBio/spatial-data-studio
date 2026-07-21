"""Ingest-time raster normalization (DESIGN §9.3).

Readers and older checkpoints hand us image/label elements with whatever pyramid
and chunking the source happened to use — often a single scale, or huge store
chunks (Xenium morphology: 4096x4096). The tile server slices a TILE_SIZE window
per request, but dask must realize every *store* chunk that window touches, so a
512 px tile off a 4096 chunk pulls ~134 MB per channel; a zoom burst multiplies
that into an OOM.

`normalize_rasters` rebuilds every image/label into a canonical form once, up
front, chunked at TILE_SIZE so one tile == one ~2 MB chunk: images become a 2x
pyramid down to a <= RASTER_BASE_PX base; labels are rebuilt single-scale (they
aren't LOD-rendered, and a nearest downsample of integer IDs doesn't stream). The
rebuilt elements are written to a per-session cache store (so the tiny-window reads
actually hit tile-sized store chunks, which an in-memory rechunk alone can't
achieve) and the live SpatialData is rebound to lazy refs into it. The caller owns
the returned dir for cleanup.
"""
import gc
import math
import os
import tempfile

import dask
import spatialdata as sd
from spatialdata.models import Image2DModel, Labels2DModel
from spatialdata.transformations import get_transformation

from . import imaging
from .config import config

TILE = imaging.TILE_SIZE


def _is_canonical(el, is_label: bool) -> bool:
    """True if re-tiling `el` would be wasted work, so reloads of our own stores are
    free. Both kinds need store chunks no larger than a tile; images additionally
    need a pyramid unless they're already small (labels aren't LOD-rendered, so a
    single tile-chunked scale is their canonical form — see `_rebuild`)."""
    arr = imaging._level_array(el, 0)
    chunksize = getattr(getattr(arr, "data", None), "chunksize", None)
    if chunksize is None:  # eagerly-loaded numpy: not lazy/tiled, rebuild it
        return False
    if chunksize[-2] > TILE or chunksize[-1] > TILE:
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
    return Image2DModel.parse(data, dims=dims, c_coords=c_coords,
                              scale_factors=_scale_factors(max(arr.shape[-1], arr.shape[-2])),
                              chunks=(data.shape[0], TILE, TILE), transformations=transforms)


def normalize_rasters(sdata, progress=None) -> tuple[str | None, dict[str, str]]:
    """Rebuild every non-canonical image/label of `sdata` into a tile-chunked 2x
    pyramid, persist them to a fresh cache store under DATA_DIR, and rebind
    `sdata`'s elements to lazy refs into it. Returns (cache_dir, element_stores):
    the cache dir (the caller must rmtree it when the session closes, or None if
    nothing needed rebuilding) and a map from each rebuilt element's name to the
    absolute `{i}.zarr` store dir written for it. The raster HTTP route resolves an
    element to its store via that map (spatialdata element names are globally unique
    across images/labels, so a single name-keyed map is unambiguous). `progress(message,
    pct)` (optional) reports per-element rebuild progress; see `create_from_load`."""
    report = progress or (lambda *a, **k: None)
    todo = [("images", n) for n, el in getattr(sdata, "images", {}).items() if not _is_canonical(el, False)]
    todo += [("labels", n) for n, el in getattr(sdata, "labels", {}).items() if not _is_canonical(el, True)]
    if not todo:
        return None, {}

    cache_dir = tempfile.mkdtemp(suffix=".rasters", dir=str(config.DATA_DIR))
    stores: dict[str, str] = {}
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
