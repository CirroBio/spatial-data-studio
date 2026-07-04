"""Editable points->global coordinate transformation.

The cells drawn on the canvas are the active table's ``obsm['spatial']``, which
live in the coordinate space of the table's annotated region element
(``uns['spatialdata_attrs']['region']`` — a shapes/labels/points element). This
module reads and sets that element's transformation to the ``global`` coordinate
system as a 2D affine, so a user can nudge the points into alignment with the
image and have the change persist inside the SpatialData object.

The affine is exchanged with the frontend as 6 floats [a, b, c, d, e, f] meaning
``x' = a*x + b*y + c`` and ``y' = d*x + e*y + f``.
"""
from __future__ import annotations

import numpy as np

IDENTITY6: list[float] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]


def region_name(table) -> str | None:
    region = (getattr(table, "uns", {}).get("spatialdata_attrs") or {}).get("region")
    if isinstance(region, (list, tuple)):
        return region[0] if region else None
    return region


def _region_element(sdata, table):
    region = region_name(table)
    if not region:
        return None
    for group in ("shapes", "labels", "points"):
        coll = getattr(sdata, group, {})
        if region in coll:
            return coll[region]
    return None


def get_affine6(sdata, table) -> list[float]:
    from spatialdata.transformations import get_transformation

    elem = _region_element(sdata, table)
    if elem is None:
        return list(IDENTITY6)
    try:
        m = np.asarray(get_transformation(elem, "global").to_affine_matrix(("x", "y"), ("x", "y")))
    except Exception:
        return list(IDENTITY6)
    return [float(m[0, 0]), float(m[0, 1]), float(m[0, 2]),
            float(m[1, 0]), float(m[1, 1]), float(m[1, 2])]


def matrix3x3(affine6: list[float]) -> np.ndarray:
    a, b, c, d, e, f = affine6
    return np.array([[a, b, c], [d, e, f], [0.0, 0.0, 1.0]], dtype=float)


def is_identity(affine6: list[float]) -> bool:
    return np.allclose(matrix3x3(affine6), np.eye(3))


def set_affine6(sdata, table, affine6: list[float]) -> str:
    from spatialdata.transformations import Affine, set_transformation

    elem = _region_element(sdata, table)
    if elem is None:
        raise ValueError("active table has no annotated region element to transform")
    affine = Affine(matrix3x3(affine6), input_axes=("x", "y"), output_axes=("x", "y"))
    set_transformation(elem, affine, "global")
    return region_name(table) or ""
