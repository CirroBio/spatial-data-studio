"""Cell-segmentation geometry transport (segmentation display).

`polygons_geoarrow` serves a session's cell-boundary polygons, expressed in the
SAME world space as the coords endpoint (`/data/obsm:<world_key>`, i.e.
`transform.world_xy`) so the polygons, the point scatter, and the image all
overlay: viewport-clipped boundary polygons as GeoArrow IPC, for the zoomed-in
outline layer.

Alignment note: the polygons are placed by `element_to_world`, which reads the
placement out of the shapes element the polygons came from rather than borrowing the
active table's region affine. The two agree on Xenium, where the region maps identity
while `cell_boundaries` maps a 4.7x micron->pixel scale — the element's own scale is
divided back out when it is reconciled against the points — and `test_e2e` asserts the
resulting polygon centroids match the transformed `obsm['spatial']` on real Xenium data.
They disagree wherever the region affine is not this element's: a table annotating
several regions has no single region affine at all (`transform.region_name` is None, so
`get_affine6` is identity) while its boundaries carry a real transform, which borrowing
dropped on the floor.
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


def element_to_world(sdata, table, element: str, gdf) -> np.ndarray:
    """3x3 affine taking `element`'s intrinsic coordinates into the canvas world space.

    Two legs. The outer one is the editable points->global affine, so that nudging the
    cells into alignment carries their boundaries along instead of stranding them. The
    inner one places THIS element against the points — only the element itself knows what
    space its vertices are in, and borrowing a sibling's is what misplaces them:

    - The table's own region element needs no inner leg: its polygons and the table's
      cells are the same objects in the same intrinsic space, and its transform is
      already what the outer leg reads. Reconciling it would score that transform twice
      (a region element scaling 3x into 'global' came out at 9x).
    - A multi-region table's world coordinates are pinned to the one system its regions
      share (`transform.world_space`), so the element's own transform into that system is
      the answer outright — the same shortcut `imaging.pixel_to_world` takes for an image,
      for the same reason.
    - Otherwise world space is not a declared coordinate system at all (Xenium's spots are
      microns while its 'global' is image pixels), so the element is reconciled against
      the points exactly as an image is: `imaging._spots_to_system`'s best-overlaying
      spots->system fit, inverted to land back in the points' space. On Xenium that
      divides out the 4.7x micron->pixel scale `cell_boundaries` declares, leaving the
      polygons where the borrowed region affine used to put them (which is what `test_e2e`
      pins), while a store whose boundaries and region really do differ now follows the
      boundaries.

    The reference footprint is the element's own bounds rather than
    `imaging.world_to_system`'s whole-object `system_extent`, which transforms every
    element's geometry: measured at 450 ms on a 20k-polygon object against 3.5 ms for
    `total_bounds` at 200k polygons, and this runs on every viewport pan.

    Raises KeyError when a multi-region table's element declares no transform into the
    system its cells live in: nothing then places the polygons, and applying some other
    element's transform is how boundaries end up silently misplaced.

    Shared with the checkpoint writer, which bakes the result per (element, table) into
    the viewer sidecar (`persistence.store._shape_element_transforms`) so the serverless
    reader places the same polygons the same way. It is called there rather than mirrored
    in JS: two derivations of a coordinate transform diverging is invisible on the store
    that agrees and looks like corrupt data on the one that doesn't."""
    if element == transform.region_name(table):
        return transform.matrix3x3(transform.get_affine6(sdata, table))

    world_system = transform.world_space(sdata, table)[1]
    if world_system is not None:
        bridge = imaging._affine_xy(gdf, world_system)
        if bridge is None:
            raise KeyError(f"shapes element '{element}' declares no transform into "
                           f"'{world_system}', the coordinate system this table's cells "
                           "are placed in")
    else:
        bridge, best_iou = None, 0.0
        for cs in imaging._system_order(sdata):
            a = imaging._affine_xy(gdf, cs)
            if a is None:
                continue
            spots, iou = imaging._spots_to_system(
                sdata, table, cs, imaging.bbox_aabb(a, gdf.total_bounds))
            if iou > best_iou:
                bridge, best_iou = np.linalg.inv(spots) @ a, iou
        if bridge is None:
            # Nothing overlaid the points: the element maps into no system the object
            # declares, or there are no spot coordinates to reconcile it against. Fall
            # back to the standing assumption that its vertices are already in the
            # points' own space — what the region affine alone used to encode — rather
            # than refuse to draw a store that reconciliation simply has nothing to say
            # about.
            bridge = np.eye(3)
    return transform.matrix3x3(transform.get_affine6(sdata, table)) @ bridge


def clipped_polygons(sdata, table, element: str, bbox, limit: int | None = None):
    """Viewport-clipped boundary polygons of `element` as `(geoms, cell_index)`:
    a list of world-space shapely polygons/multipolygons and a matching int32
    `cell_index` array (each shape's row position in the active table, -1 if none).
    `bbox` is `(minx, miny, maxx, maxy)` in world space; it is inverted into the
    element's intrinsic space to query `gdf.sindex`, so only the covered subset is
    materialized and transformed into world space. Over `limit` hits returns empty
    (an all-or-nothing viewport, so a partial subset is never shown). Raises
    KeyError if the element is missing, is not polygonal, is the shape-annotation
    element, or has no transform into the world coordinate system. Shared by the
    GeoArrow transport and the snapshot figure renderer."""
    from ..sessions import shape_annotations

    if element not in getattr(sdata, "shapes", {}):
        raise KeyError(f"shapes element '{element}' not found")
    gdf = sdata.shapes[element]
    if element == shape_annotations.ELEMENT:
        # Polygonal, but not a boundary set, and its vertices are already world
        # coordinates carrying a placeholder identity 'global' transform (see
        # sessions/shape_annotations.py) — no element->world derivation describes it, and
        # the old one silently re-applied the points->global affine to shapes the user
        # drew where they already are. Every other boundary consumer excludes it
        # (snapshots._shapes_element, SpatialCanvas' polygonElements); refusing it here
        # makes the one remaining path that can still ask for it say so.
        raise KeyError(f"shapes element '{element}' holds shape annotations, "
                       "which are drawn from the annotation overlay, not cell boundaries")
    if not is_polygonal(gdf):
        raise KeyError(f"shapes element '{element}' is not polygonal")

    m = element_to_world(sdata, table, element, gdf)
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
