"""Cell-segmentation geometry transport (segmentation display).

Two read-only views of a session's cells, both expressed in the SAME world space
as the coords endpoint (`/data/obsm:spatial`, i.e. `obsm['spatial']` after the
region element's points->global affine) so the field, the polygons, the point
scatter, and the image all overlay:

- `cell_field`: characteristic nearest-neighbor spacing + data bounds, for the
  zoomed-out impostor-cone field layer.
- `polygons_geoarrow`: viewport-clipped boundary polygons as GeoArrow IPC, for
  the zoomed-in outline layer.

Alignment note: a boundary shapes element carries its OWN element->global
transform, but on Xenium that transform is inconsistent with the region element's
(the region maps identity while `cell_boundaries` maps a 4.7x micron->pixel
scale). The coords endpoint and the image reconciliation both display against the
region element's transform, so that is the transform reused here (via
`transform.get_affine6`) — applied to the polygons' intrinsic coordinates, which
share the region's micron space. `test_e2e` asserts the resulting polygon
centroids match the transformed `obsm['spatial']` on real Xenium data.
"""
from __future__ import annotations

import io
import logging
from collections import OrderedDict

import numpy as np
import pyarrow as pa
import pyarrow.ipc as ipc
from scipy.spatial import cKDTree
from shapely.affinity import affine_transform

from . import arrow
from ..sessions import transform

_log = logging.getLogger(__name__)

_FIELD_SAMPLE = 1000
_FIELD_SEED = 0
_POLYGON_GEOM_TYPES = {"Polygon", "MultiPolygon"}

# (session_id, coords field, data_version) -> field metadata. Cheap floats; the
# expensive part is the cKDTree build, paid once per data version and kept.
_field_cache: "OrderedDict[tuple, dict]" = OrderedDict()
_FIELD_CACHE_MAX = 64


def _world_coords(sdata, table, coords_field: str) -> np.ndarray:
    """The (N, 2) world-space coordinates the coords endpoint serves for
    `coords_field` — resolved and transformed exactly as `main.data` does, so the
    field/polygon geometry lands in the identical space as the plotted points."""
    batch = arrow.resolve_field(table, coords_field)
    if coords_field == "obsm:spatial":
        affine6 = transform.get_affine6(sdata, table)
        if not transform.is_identity(affine6):
            batch = arrow.apply_affine_xy(batch, transform.matrix3x3(affine6))
    d0 = np.asarray(batch.column("d0"), dtype="float64")
    d1 = np.asarray(batch.column("d1"), dtype="float64")
    return np.column_stack([d0, d1])


def cell_field(sdata, table, coords_field: str, cache_key: tuple) -> dict:
    """Median nearest-neighbor spacing (the field radius R) + cell count + world
    bounds. The tree is built over every cell so each measured distance is a true
    nearest neighbor; a fixed-seed sample of up to `_FIELD_SAMPLE` cells is queried
    to bound cost. Memoized on `cache_key = (session_id, coords, data_version)`."""
    cached = _field_cache.get(cache_key)
    if cached is not None:
        _field_cache.move_to_end(cache_key)
        return cached

    xy = _world_coords(sdata, table, coords_field)
    n = len(xy)
    if n == 0:
        raise ValueError(f"no coordinates for field {coords_field}")
    tree = cKDTree(xy)
    if n > _FIELD_SAMPLE:
        rng = np.random.default_rng(_FIELD_SEED)
        sample = xy[rng.choice(n, size=_FIELD_SAMPLE, replace=False)]
    else:
        sample = xy
    # k=2 and drop the self-match (column 0, distance 0) to get each point's
    # nearest OTHER point; a lone cell (n==1) has no neighbor.
    dist, _ = tree.query(sample, k=min(2, n))
    nn = dist[:, 1] if dist.ndim == 2 and dist.shape[1] > 1 else np.array([0.0])
    result = {
        "median_nn_world": float(np.median(nn)),
        "n_cells": int(n),
        "bounds": [float(xy[:, 0].min()), float(xy[:, 1].min()),
                   float(xy[:, 0].max()), float(xy[:, 1].max())],
    }
    _field_cache[cache_key] = result
    if len(_field_cache) > _FIELD_CACHE_MAX:
        _field_cache.popitem(last=False)
    return result


def is_polygonal(gdf) -> bool:
    """True when a shapes element holds polygon geometry (the field/outline path);
    circle/point shapes are served as scatter, not outlines."""
    if len(gdf) == 0:
        return False
    return bool(set(str(g) for g in gdf.geom_type.unique()) & _POLYGON_GEOM_TYPES)


def _cell_index(table, index_labels) -> np.ndarray:
    """Map each shape's index label to its row position in the active table, so the
    frontend can gather the already-loaded per-cell color. Label-based, never
    positional: `cell_boundaries` is keyed by the cell name (== the table's obs
    index), while boundary sets keyed by the SpatialData instance id (e.g.
    `nucleus_boundaries`) match the table's `instance_key` column. Unmatched shapes
    get -1."""
    obs = table.obs
    name_to_pos = {label: i for i, label in enumerate(obs.index)}
    inst_to_pos: dict = {}
    attrs = getattr(table, "uns", {}).get("spatialdata_attrs") or {}
    instance_key = attrs.get("instance_key")
    if instance_key and instance_key in obs.columns:
        for i, v in enumerate(obs[instance_key].to_numpy()):
            inst_to_pos.setdefault(v, i)
    out = np.full(len(index_labels), -1, dtype="int32")
    for k, label in enumerate(index_labels):
        pos = name_to_pos.get(label)
        if pos is None:
            pos = inst_to_pos.get(label)
        if pos is not None:
            out[k] = pos
    return out


def _empty_geoarrow(gdf):
    import geoarrow.pyarrow as ga
    ga_type = ga.multipolygon() if "MultiPolygon" in set(gdf.geom_type.unique()) else ga.polygon()
    return ga_type.wrap_array(pa.array([], type=ga_type.storage_type))


def polygons_geoarrow(sdata, table, element: str, bbox, limit: int | None = None) -> bytes:
    """Viewport-clipped boundary polygons of `element` as an Arrow IPC stream with a
    GeoArrow `geometry` column (polygon/multipolygon) and an int32 `cell_index`
    column. `bbox` is `(minx, miny, maxx, maxy)` in world space; it is inverted into
    the element's intrinsic space to query `gdf.sindex`, so only the covered subset
    is materialized and transformed. Raises KeyError if the element is missing or
    not polygonal."""
    import geoarrow.pyarrow as ga

    if element not in getattr(sdata, "shapes", {}):
        raise KeyError(f"shapes element '{element}' not found")
    gdf = sdata.shapes[element]
    if not is_polygonal(gdf):
        raise KeyError(f"shapes element '{element}' is not polygonal")

    m = transform.matrix3x3(transform.get_affine6(sdata, table))
    minv = np.linalg.inv(m)
    wx0, wy0, wx1, wy1 = bbox
    corners = np.array([[wx0, wy0, 1.0], [wx1, wy0, 1.0], [wx0, wy1, 1.0], [wx1, wy1, 1.0]]).T
    pc = minv @ corners  # world bbox -> intrinsic (M may rotate: take the corner AABB)
    intrinsic_bbox = (float(pc[0].min()), float(pc[1].min()), float(pc[0].max()), float(pc[1].max()))

    hits = sorted(gdf.sindex.intersection(intrinsic_bbox))
    if limit is not None and len(hits) > limit:
        _log.info("polygons_geoarrow truncated %s: %d hits > limit %d", element, len(hits), limit)
        hits = hits[:limit]

    if not hits:
        table_out = pa.table({"geometry": _empty_geoarrow(gdf),
                              "cell_index": pa.array([], type=pa.int32())})
        return _to_ipc(table_out)

    sub = gdf.iloc[hits]
    aff = [m[0, 0], m[0, 1], m[1, 0], m[1, 1], m[0, 2], m[1, 2]]  # shapely: a,b,d,e,xoff,yoff
    geoms = [affine_transform(g, aff) for g in sub.geometry.to_numpy()]
    geometry = ga.as_geoarrow(ga.array([g.wkb for g in geoms]))
    cell_index = _cell_index(table, list(sub.index))
    table_out = pa.table({"geometry": geometry, "cell_index": pa.array(cell_index, type=pa.int32())})
    return _to_ipc(table_out)


def _to_ipc(table_out: pa.Table) -> bytes:
    sink = io.BytesIO()
    with ipc.new_stream(sink, table_out.schema) as writer:
        writer.write_table(table_out)
    return sink.getvalue()
