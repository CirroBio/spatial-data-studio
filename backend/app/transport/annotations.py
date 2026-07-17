"""Read-side conversion of `sdata.shapes["annotations"]` back into the JSON shape
the frontend's zod `ShapeAnnotation` schema expects — the inverse of
sessions/shape_annotations.py's `_row`/`_params_for`.
"""
from __future__ import annotations

import json

from ..sessions import shape_annotations


def list_shape_annotations(session) -> list:
    shapes = getattr(session.sdata, "shapes", {})
    if shape_annotations.ELEMENT not in shapes:
        return []
    gdf = shapes[shape_annotations.ELEMENT]

    out = []
    for shape_id, row in gdf.iterrows():
        params = json.loads(row["params"])
        geometry = {"kind": row["kind"], **params}
        if row["kind"] == "text":
            geometry.setdefault("rotation", 0.0)  # labels persisted before rotation existed
        stroke = {
            "color": row["stroke_color"],
            "width": float(row["stroke_width"]),
            "dash": row["stroke_dash"],
            "arrowStart": bool(row["stroke_arrow_start"]),
            "arrowEnd": bool(row["stroke_arrow_end"]),
            # Default matches defaultStroke() in the frontend zod schema; the
            # fallback covers shapes persisted before arrow size was editable.
            "arrowSize": float(row.get("stroke_arrow_size", 10.0)),
            "z": int(row["stroke_z"]),
        }
        shape = {"id": str(shape_id), "geometry": geometry, "stroke": stroke}
        if row["kind"] not in ("line", "text"):
            shape["fill"] = {
                "enabled": bool(row["fill_enabled"]),
                "color": row["fill_color"],
                "alpha": float(row["fill_alpha"]),
                "z": int(row["fill_z"]),
            }
        if row["label"]:
            shape["label"] = row["label"]
        out.append(shape)
    return out
