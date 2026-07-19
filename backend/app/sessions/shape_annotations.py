"""Shape-annotation editor: arrows, lines, boxes, polygons, ellipses, and text
labels drawn directly on the canvas, persisted as a `sdata.shapes["annotations"]`
GeoDataFrame (a queued mutating job, mirroring regions.py's assign).

Vertices/centers are stored in the SAME world space the canvas already draws in
(no further transform), so the element gets an identity "global" transformation.

`ShapesModel` only validates a homogeneous Point or Polygon/MultiPolygon geometry
column (no LineString, and no mixing kinds), so every shape kind is stored as a
Polygon: a line/arrow's geometry is approximated as a thin rectangle along its
two vertices, and an ellipse as a fixed-resolution polygon. The exact, lossless
parameters (raw vertices, or center/radii/rotation) live in the `params` JSON
column, so re-opening a shape for editing never loses precision to the polygon
approximation used for the `geometry` column.
"""
from __future__ import annotations

import json
import uuid

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import LineString, Polygon

ELEMENT = "annotations"
_ELLIPSE_SEGMENTS = 64
_LINE_POLYGON_MIN_WIDTH = 1.0
# Side length of the placeholder square stored in the `geometry` column for a text
# label (its anchor point + text live losslessly in `params`); the visible label
# is drawn by the frontend TextLayer, not from this polygon.
_TEXT_ANCHOR_SIZE = 1.0


def _text_anchor_polygon(position) -> Polygon:
    x, y = position
    h = _TEXT_ANCHOR_SIZE / 2
    return Polygon([(x - h, y - h), (x + h, y - h), (x + h, y + h), (x - h, y + h)])


def _ellipse_polygon(center, radius_x: float, radius_y: float, rotation: float) -> Polygon:
    t = np.linspace(0, 2 * np.pi, _ELLIPSE_SEGMENTS, endpoint=False)
    x = radius_x * np.cos(t)
    y = radius_y * np.sin(t)
    cos_r, sin_r = np.cos(rotation), np.sin(rotation)
    xr = x * cos_r - y * sin_r + center[0]
    yr = x * sin_r + y * cos_r + center[1]
    return Polygon(zip(xr, yr))


def _line_polygon(vertices, width: float) -> Polygon:
    half = max(width, _LINE_POLYGON_MIN_WIDTH) / 2
    return LineString(vertices).buffer(half, cap_style="flat", join_style="mitre")


def _geometry_for(geometry: dict, stroke: dict) -> Polygon:
    kind = geometry["kind"]
    if kind == "line":
        return _line_polygon(geometry["vertices"], stroke["width"])
    if kind == "ellipse":
        return _ellipse_polygon(geometry["center"], geometry["radiusX"], geometry["radiusY"], geometry["rotation"])
    if kind == "text":
        return _text_anchor_polygon(geometry["position"])
    return Polygon(geometry["vertices"])  # box / polygon: exact ring (Polygon closes it)


def _params_for(geometry: dict) -> dict:
    if geometry["kind"] == "ellipse":
        return {"center": list(geometry["center"]), "radiusX": geometry["radiusX"],
                "radiusY": geometry["radiusY"], "rotation": geometry["rotation"]}
    if geometry["kind"] == "text":
        return {"position": list(geometry["position"]), "text": geometry["text"],
                "fontSize": geometry["fontSize"], "rotation": geometry.get("rotation", 0.0)}
    return {"vertices": [list(v) for v in geometry["vertices"]]}


def _row(shape: dict) -> dict:
    stroke, fill = shape["stroke"], shape.get("fill") or {}
    return {
        "kind": shape["geometry"]["kind"],
        "params": json.dumps(_params_for(shape["geometry"])),
        "label": shape.get("label") or "",
        "stroke_color": stroke["color"],
        "stroke_width": stroke["width"],
        "stroke_dash": stroke["dash"],
        "stroke_arrow_start": stroke["arrowStart"],
        "stroke_arrow_end": stroke["arrowEnd"],
        "stroke_arrow_size": stroke["arrowSize"],
        "stroke_z": stroke["z"],
        "fill_enabled": fill.get("enabled", False),
        "fill_color": fill.get("color", "#000000"),
        "fill_alpha": fill.get("alpha", 0.0),
        "fill_z": fill.get("z", 0),
    }


def _annotations_gdf(session) -> gpd.GeoDataFrame | None:
    shapes = getattr(session.sdata, "shapes", {})
    return shapes[ELEMENT] if ELEMENT in shapes else None


def _write_gdf(session, gdf: gpd.GeoDataFrame) -> None:
    from spatialdata.models import ShapesModel
    from spatialdata.transformations import Identity

    # `gdf` may be a slice/concat of a previously-parsed element, which still
    # carries the prior parse's `attrs` (including its transformations) —
    # ShapesModel.parse refuses to re-parse an element that already has
    # transformations set alongside a `transformations=` argument.
    gdf = gdf.copy()
    gdf.attrs = {}
    session.sdata.shapes[ELEMENT] = ShapesModel.parse(gdf, transformations={"global": Identity()})


def create(session, payload: dict) -> list:
    """Validate + append one shape. Returns the changed field paths."""
    from ..schemas.annotations import ShapeAnnotation

    shape = ShapeAnnotation.model_validate(payload).model_dump(mode="json")
    shape_id = payload.get("id") or str(uuid.uuid4())
    geometry = _geometry_for(shape["geometry"], shape["stroke"])
    new_row = gpd.GeoDataFrame([_row(shape)], geometry=[geometry], index=[shape_id])

    existing = _annotations_gdf(session)
    merged = pd.concat([existing, new_row]) if existing is not None and len(existing) else new_row
    _write_gdf(session, gpd.GeoDataFrame(merged, geometry="geometry"))
    return [f"shapes:{ELEMENT}"]


def update(session, shape_id: str, payload: dict) -> list:
    """Replace an existing shape's geometry/style in place (drop + re-append, since
    a Polygon's ring can't be edited column-wise on a GeoDataFrame row)."""
    from ..schemas.annotations import ShapeAnnotation

    existing = _annotations_gdf(session)
    if existing is None or shape_id not in existing.index:
        raise ValueError(f"shape '{shape_id}' not found")

    shape = ShapeAnnotation.model_validate({**payload, "id": shape_id}).model_dump(mode="json")
    geometry = _geometry_for(shape["geometry"], shape["stroke"])
    new_row = gpd.GeoDataFrame([_row(shape)], geometry=[geometry], index=[shape_id])

    merged = pd.concat([existing.drop(index=shape_id), new_row])
    _write_gdf(session, gpd.GeoDataFrame(merged, geometry="geometry"))
    return [f"shapes:{ELEMENT}"]


def delete(session, shape_id: str) -> list:
    existing = _annotations_gdf(session)
    if existing is None or shape_id not in existing.index:
        raise ValueError(f"shape '{shape_id}' not found")

    remaining = existing.drop(index=shape_id)
    if len(remaining):
        _write_gdf(session, remaining)
    else:
        del session.sdata.shapes[ELEMENT]
    return [f"shapes:{ELEMENT}"]
