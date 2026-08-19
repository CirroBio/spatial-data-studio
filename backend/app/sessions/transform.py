"""Which coordinates the canvas draws, and the editable points->global transform.

The cells drawn on the canvas are the active table's ``obsm[world_key(...)]`` —
``'spatial'`` for almost every dataset — which live in the coordinate space of the
table's annotated region element (``uns['spatialdata_attrs']['region']`` — a
shapes/labels/points element). This module reads and sets that element's
transformation to the ``global`` coordinate system as a 2D affine, so a user can
nudge the points into alignment with the image and have the change persist inside
the SpatialData object.

A table may annotate SEVERAL region elements, and then neither half of that holds:
its ``obsm['spatial']`` is region-*local* (CosMx writes per-FOV pixel coordinates,
one origin per FOV), and no single affine maps every row to world space because
each region carries its own. ``world_space`` handles that case; see its docstring.

The affine is exchanged with the frontend as 6 floats [a, b, c, d, e, f] meaning
``x' = a*x + b*y + c`` and ``y' = d*x + e*y + f``.
"""
from __future__ import annotations

import numpy as np

IDENTITY6: list[float] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]


def region_names(table) -> list[str]:
    """Every region element the table annotates. Usually one; CosMx annotates one
    labels element per FOV, steinbock one per sample."""
    region = (getattr(table, "uns", {}).get("spatialdata_attrs") or {}).get("region")
    if region is None:
        return []
    names = list(region) if isinstance(region, (list, tuple)) else [region]
    return [str(n) for n in names]


def region_name(table) -> str | None:
    """The table's single region element, or None when it names none — or several.

    None for several is the point: the region element supplies the points->world
    affine, and a table spanning regions with different transforms has no single one.
    Taking `region[0]` (what this used to do) applied one FOV's transform to every
    cell in the section."""
    names = region_names(table)
    return names[0] if len(names) == 1 else None


def _element_named(sdata, name: str):
    """A shapes/labels/points element by name, or None."""
    for group in ("shapes", "labels", "points"):
        coll = getattr(sdata, group, {})
        if name in coll:
            return coll[name]
    return None


def _region_element(sdata, table):
    region = region_name(table)
    return _element_named(sdata, region) if region else None


def get_affine6(sdata, table) -> list[float]:
    from spatialdata.transformations import get_transformation

    elem = _region_element(sdata, table)
    if elem is None:
        return list(IDENTITY6)
    try:
        m = np.asarray(get_transformation(elem, "global").to_affine_matrix(("x", "y"), ("x", "y")))
    except (KeyError, ValueError):
        # No `global` mapping for this element, or one spatialdata cannot express as a
        # 2-D affine (e.g. a sequence including a non-affine step). Identity is the right
        # answer for both — the overlay is drawn unaligned rather than not at all — but the
        # catch stays narrow so a genuine failure in here surfaces instead of silently
        # rendering a misaligned overlay that looks like a data problem.
        return list(IDENTITY6)
    return [float(m[0, 0]), float(m[0, 1]), float(m[0, 2]),
            float(m[1, 0]), float(m[1, 1]), float(m[1, 2])]


def _multiregion_regions(sdata, table) -> dict | None:
    """`{region element name: element}` for a table that annotates several of them, or
    None when it annotates one (the ordinary case, handled by `get_affine6`) or when the
    pieces needed to place its rows are missing."""
    names = region_names(table)
    if len(names) < 2 or "spatial" not in getattr(table, "obsm", {}):
        return None
    region_key = (getattr(table, "uns", {}).get("spatialdata_attrs") or {}).get("region_key")
    if not region_key or region_key not in getattr(table, "obs", {}):
        return None
    elements = {n: _element_named(sdata, n) for n in names}
    return None if any(el is None for el in elements.values()) else elements


def _multiregion_system(sdata, table) -> str | None:
    """The coordinate system every one of a multi-region table's region elements maps
    into — the only space its rows can share. None when they share none, which is not a
    defect: steinbock's samples are separate acquisitions, each in its own system, with
    no defined spatial relationship to lay them out by."""
    from spatialdata.transformations import get_transformation
    from .. import imaging

    elements = _multiregion_regions(sdata, table)
    if elements is None:
        return None
    shared = set.intersection(
        *(set(get_transformation(el, get_all=True)) for el in elements.values()))
    # `_system_order` puts the most-populated system first, which is the one holding the
    # whole section rather than a per-kind subset (CosMx declares 'global' over images
    # and labels both, plus 'global_only_image'/'global_only_labels' over one each).
    return next((cs for cs in imaging._system_order(sdata) if cs in shared), None)


def _multiregion_world_xy(sdata, table, system: str) -> np.ndarray | None:
    """Exact world coordinates, in `system`, for a table whose rows span several region
    elements: each row's own region transform, applied to that row's own region-local
    `obsm['spatial']`.

    Raises ValueError when a row's `region_key` value names none of the declared
    regions. Nothing places such a row — its local coordinates belong to an origin the
    object does not describe — and the alternative is worse than the error: the returned
    array is compared against every `obsm` key to find the one holding the stitched
    coordinates, so leaving those rows undefined (this used to hand back whatever
    `np.empty_like` picked up) makes every candidate key miss and `world_space` fall
    back to the region-*local* `obsm['spatial']`, stacking the whole section onto one
    FOV's origin with nothing said."""
    from .. import imaging

    elements = _multiregion_regions(sdata, table)
    if elements is None:
        return None
    region_key = table.uns["spatialdata_attrs"]["region_key"]
    xy = np.asarray(table.obsm["spatial"])[:, :2].astype(float)
    rows = np.asarray(table.obs[region_key].astype(str))
    out = np.empty_like(xy)
    placed = np.zeros(len(xy), dtype=bool)
    for name, elem in elements.items():
        a = imaging._affine_xy(elem, system)
        if a is None:
            return None
        mask = rows == name
        if mask.any():
            out[mask] = apply_affine6_xy(
                [a[0, 0], a[0, 1], a[0, 2], a[1, 0], a[1, 1], a[1, 2]], xy[mask])
            placed |= mask
    if not placed.all():
        stray = sorted(set(rows[~placed]))
        raise ValueError(
            f"table column '{region_key}' names {len(stray)} region element(s) the table "
            f"does not annotate ({', '.join(stray[:5])}), leaving "
            f"{int((~placed).sum())} of {len(rows)} rows with no transform into world space")
    return out


def world_space(sdata, table) -> tuple[str, str | None]:
    """`(obsm key holding the coordinates the canvas draws, the system they are in)`.

    `("spatial", None)` for every single-region table, which is nearly all of them: the
    key is `obsm['spatial']` and which system it is in is for `imaging` to infer by
    overlay. A multi-region table's `obsm['spatial']` is region-*local* instead, and
    plotting it stacks every region on one origin (a CosMx section collapses into one
    FOV's footprint). The reader that produced such a table generally also carries the
    stitched coordinates in another `obsm` key — CosMx writes `obsm['global']` — so
    rather than guess by name, derive the true per-row world coordinates and return
    whichever key reproduces them, together with the system they live in. The system
    lets `imaging` place a per-region image outright: a CosMx FOV image covers a few
    percent of the section, so every overlay candidate scores near zero and the best of
    them is noise.

    The match tolerance is loose on purpose. CosMx's per-region transform is
    least-squares fitted from the local/global column pair, so it reproduces the
    stitched coordinates only up to the fit residual; the comparison only has to tell a
    matching key from one that differs by whole FOV offsets, so it is scaled to the
    coordinate span.

    Falls back to `("spatial", None)` when nothing matches — the behavior that was there
    before, wrong for such a table but no worse, and the alternative would be inventing
    an `obsm` key the object never had. That fallback covers "no key reproduces the world
    coordinates"; a table whose rows cannot be placed at all raises out of
    `_multiregion_world_xy` instead of falling through to it."""
    system = _multiregion_system(sdata, table)
    world = _multiregion_world_xy(sdata, table, system) if system is not None else None
    if world is None:
        return "spatial", None
    span = float(np.ptp(world, axis=0).max()) or 1.0
    for key in getattr(table, "obsm", {}):
        if key == "spatial":
            continue
        arr = np.asarray(table.obsm[key])
        if arr.ndim != 2 or arr.shape[0] != world.shape[0] or arr.shape[1] < 2:
            continue
        if np.abs(arr[:, :2].astype(float) - world).max() <= 1e-3 * span:
            return key, system
    return "spatial", None


def world_key(sdata, table) -> str:
    """The `obsm` key holding the coordinates the canvas draws (see `world_space`)."""
    return world_space(sdata, table)[0]


def world_xy(sdata, table) -> np.ndarray:
    """The table's cells in world space, exactly as the canvas draws them: the
    `world_key` coordinates after the points->world affine. The one place that
    resolves both halves, so the image reconciliation, lasso membership and the
    figure renderer cannot disagree about where a cell is."""
    xy = np.asarray(table.obsm[world_key(sdata, table)])[:, :2].astype(float)
    return apply_affine6_xy(get_affine6(sdata, table), xy)


def matrix3x3(affine6: list[float]) -> np.ndarray:
    a, b, c, d, e, f = affine6
    return np.array([[a, b, c], [d, e, f], [0.0, 0.0, 1.0]], dtype=float)


def apply_affine6_xy(affine6: list[float], xy: np.ndarray) -> np.ndarray:
    """Apply the 6-float affine to an (N, 2) array of xy points, returning a new
    (N, 2) array: ``x' = a*x + b*y + c``, ``y' = d*x + e*y + f``."""
    a, b, c, d, e, f = affine6
    return np.column_stack([a * xy[:, 0] + b * xy[:, 1] + c,
                            d * xy[:, 0] + e * xy[:, 1] + f])


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
