"""Cell-segmentation geometry transport (segmentation display).

`polygons_geoarrow` serves a session's cell-boundary polygons, expressed in the
SAME world space as the coords endpoint (`/data/obsm:spatial`, i.e.
`obsm['spatial']` after the region element's points->global affine) so the
polygons, the point scatter, and the image all overlay: viewport-clipped
boundary polygons as GeoArrow IPC, for the zoomed-in outline layer.

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

import numpy as np
import pyarrow as pa
import pyarrow.ipc as ipc
import shapely
from shapely.affinity import affine_transform

from ..sessions import transform

_log = logging.getLogger(__name__)

_POLYGON_GEOM_TYPES = {"Polygon", "MultiPolygon"}

# Boundary coordinates are world-space micron/pixel units, so 2 decimals is far
# below on-screen resolution but zeros the low float64 mantissa bits, which is
# what lets the gzip transport actually compress the geometry stream (raw float64
# coordinates are near-incompressible; rounded, the stream shrinks ~2x). Rounding
# via shapely.transform maps coordinates only — it preserves every vertex and the
# geometry type and cannot raise the topology errors that set_precision does.
_COORD_DECIMALS = 2


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
        # Too many cells in view to ship + tessellate in the browser: return
        # nothing rather than an arbitrary partial subset, so the "Shapes
        # (zoomed in)" layer stays blank until the user zooms in far enough that
        # the visible set fits under `limit`. Skips serializing the geometry too.
        _log.info("polygons_geoarrow over limit for %s: %d hits > limit %d; returning empty",
                  element, len(hits), limit)
        hits = []

    if not hits:
        table_out = pa.table({"geometry": _empty_geoarrow(gdf),
                              "cell_index": pa.array([], type=pa.int32())})
        return _to_ipc(table_out)

    sub = gdf.iloc[hits]
    aff = [m[0, 0], m[0, 1], m[1, 0], m[1, 1], m[0, 2], m[1, 2]]  # shapely: a,b,d,e,xoff,yoff
    geoms = [affine_transform(g, aff) for g in sub.geometry.to_numpy()]
    geoms = shapely.transform(np.asarray(geoms, dtype=object),
                              lambda coords: np.round(coords, _COORD_DECIMALS), include_z=False)
    geometry = ga.as_geoarrow(ga.array([g.wkb for g in geoms]))
    cell_index = _cell_index(table, list(sub.index))
    table_out = pa.table({"geometry": geometry, "cell_index": pa.array(cell_index, type=pa.int32())})
    return _to_ipc(table_out)


def _to_ipc(table_out: pa.Table) -> bytes:
    sink = io.BytesIO()
    with ipc.new_stream(sink, table_out.schema) as writer:
        writer.write_table(table_out)
    return sink.getvalue()
