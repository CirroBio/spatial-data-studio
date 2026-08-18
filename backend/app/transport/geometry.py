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

from .. import imaging
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


def cell_index(table, index_labels) -> np.ndarray:
    """Map each shape's index label to its row position in the active table, so the
    frontend can gather the already-loaded per-cell color. Label-based, never
    positional: `cell_boundaries` is keyed by the cell name (== the table's obs
    index), while boundary sets keyed by the SpatialData instance id (e.g.
    `nucleus_boundaries`) match the table's `instance_key` column. Unmatched shapes
    get -1.

    Shared with the checkpoint writer, which bakes the same mapping into the viewer
    sidecar for the serverless reader (`persistence.store._write_shape_cell_index`)."""
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


def clipped_polygons(sdata, table, element: str, bbox, limit: int | None = None):
    """Viewport-clipped boundary polygons of `element` as `(geoms, cell_index)`:
    a list of world-space shapely polygons/multipolygons and a matching int32
    `cell_index` array (each shape's row position in the active table, -1 if none).
    `bbox` is `(minx, miny, maxx, maxy)` in world space; it is inverted into the
    element's intrinsic space to query `gdf.sindex`, so only the covered subset is
    materialized and transformed into world space. Over `limit` hits returns empty
    (an all-or-nothing viewport, so a partial subset is never shown). Raises
    KeyError if the element is missing or not polygonal. Shared by the GeoArrow
    transport and the snapshot figure renderer."""
    if element not in getattr(sdata, "shapes", {}):
        raise KeyError(f"shapes element '{element}' not found")
    gdf = sdata.shapes[element]
    if not is_polygonal(gdf):
        raise KeyError(f"shapes element '{element}' is not polygonal")

    m = transform.matrix3x3(transform.get_affine6(sdata, table))
    # world bbox -> intrinsic; M may rotate, so this is the transformed corners' AABB.
    intrinsic_bbox = tuple(imaging.bbox_aabb(np.linalg.inv(m), bbox))

    hits = sorted(gdf.sindex.intersection(intrinsic_bbox))
    if limit is not None and len(hits) > limit:
        # Too many cells in view to ship + tessellate in the browser: return
        # nothing rather than an arbitrary partial subset, so the "Shapes
        # (zoomed in)" layer stays blank until the user zooms in far enough that
        # the visible set fits under `limit`. Skips serializing the geometry too.
        _log.info("clipped_polygons over limit for %s: %d hits > limit %d; returning empty",
                  element, len(hits), limit)
        hits = []

    if not hits:
        return [], np.empty(0, dtype="int32")

    sub = gdf.iloc[hits]
    aff = [m[0, 0], m[0, 1], m[1, 0], m[1, 1], m[0, 2], m[1, 2]]  # shapely: a,b,d,e,xoff,yoff
    geoms = [affine_transform(g, aff) for g in sub.geometry.to_numpy()]
    return geoms, cell_index(table, list(sub.index))


def polygons_geoarrow(sdata, table, element: str, bbox, limit: int | None = None) -> bytes:
    """Viewport-clipped boundary polygons of `element` as an Arrow IPC stream with a
    GeoArrow `geometry` column (polygon/multipolygon) and an int32 `cell_index`
    column, in the coords world space. See `clipped_polygons` for the query."""
    import geoarrow.pyarrow as ga

    geoms, cell_indices = clipped_polygons(sdata, table, element, bbox, limit)
    if len(geoms) == 0:
        table_out = pa.table({"geometry": _empty_geoarrow(sdata.shapes[element]),
                              "cell_index": pa.array([], type=pa.int32())})
        return _to_ipc(table_out)

    geoms = shapely.transform(np.asarray(geoms, dtype=object),
                              lambda coords: np.round(coords, _COORD_DECIMALS), include_z=False)
    geometry = ga.as_geoarrow(ga.array([g.wkb for g in geoms]))
    table_out = pa.table({"geometry": geometry,
                          "cell_index": pa.array(cell_indices, type=pa.int32())})
    return _to_ipc(table_out)


def _to_ipc(table_out: pa.Table) -> bytes:
    sink = io.BytesIO()
    with ipc.new_stream(sink, table_out.schema) as writer:
        writer.write_table(table_out)
    return sink.getvalue()
