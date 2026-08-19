"""Read-side conversion of `sdata.shapes["annotations"]` back into the JSON shape
the frontend's zod `ShapeAnnotation` schema expects — the inverse of
sessions/shape_annotations.py's `_row`/`_params_for`.
"""
from __future__ import annotations

import json
from typing import Any

import pandas as pd

from ..sessions import shape_annotations


def _cell(row: pd.Series, column: str, default: Any) -> Any:
    """Value of `column` in `row`, falling back to `default` when the column is
    absent *or* NA.

    A checkpoint written before a column existed gains that column, filled with
    NaN for its older rows, the moment sessions/shape_annotations.py concatenates
    a newer row onto it — and `Series.get`'s default only covers an absent key,
    never a stored NaN. Unguarded, that NaN reaches the response as bare `NaN`
    (invalid JSON, rejected by the frontend's zod schema) or silently reads as
    True through `bool()`.
    """
    value = row.get(column)
    return default if value is None or pd.isna(value) else value


def list_shape_annotations(session) -> list:
    shapes = getattr(session.sdata, "shapes", {})
    if shape_annotations.ELEMENT not in shapes:
        return []
    gdf = shapes[shape_annotations.ELEMENT]

    out = []
    for shape_id, row in gdf.iterrows():
        # `kind`/`params` carry the shape's identity rather than its style: no
        # fallback would produce a shape the viewer could render, so a row missing
        # them raises instead of emitting an entry that fails validation anyway.
        params = json.loads(row["params"])
        geometry = {"kind": row["kind"], **params}
        if row["kind"] == "text":
            geometry.setdefault("rotation", 0.0)  # labels persisted before rotation existed
        # Every style fallback below is what the shape effectively looked like
        # before its column existed: the frontend defaultStroke() values for
        # stroke, and _row()'s no-fill row for fill.
        stroke = {
            "color": _cell(row, "stroke_color", "#3388ff"),
            "width": float(_cell(row, "stroke_width", 2.0)),
            "dash": _cell(row, "stroke_dash", "solid"),
            "arrowStart": bool(_cell(row, "stroke_arrow_start", False)),
            "arrowEnd": bool(_cell(row, "stroke_arrow_end", False)),
            "arrowSize": float(_cell(row, "stroke_arrow_size", 10.0)),
            "z": int(_cell(row, "stroke_z", 0)),
        }
        shape = {"id": str(shape_id), "geometry": geometry, "stroke": stroke}
        if row["kind"] not in ("line", "text"):
            shape["fill"] = {
                "enabled": bool(_cell(row, "fill_enabled", False)),
                "color": _cell(row, "fill_color", "#000000"),
                "alpha": float(_cell(row, "fill_alpha", 0.0)),
                "z": int(_cell(row, "fill_z", 0)),
            }
        label = _cell(row, "label", "")
        if label:
            shape["label"] = label
        out.append(shape)
    return out
