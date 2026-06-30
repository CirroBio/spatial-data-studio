"""Region annotation (post-build spec Parts 2-3).

A region set is a categorical `obs` column; a region is a category within it.
Drawn regions also carry geometry as a SpatialData shapes element `regions/<set>`.
Assignment mutates the session object in place (a queued mutating job, §3.1) and
updates the `attrs.regions` registry. Because a region set is an ordinary `obs`
categorical, it flows through every existing picker/coloring mechanism unchanged.
"""
from __future__ import annotations

import uuid

import numpy as np
import pandas as pd

UNASSIGNED = "unassigned"
# distinct, color-blind-ish palette for new categories
PALETTE = ["#c1432b", "#2b6cc1", "#3a9e54", "#d4972b", "#8e5bc4", "#39a6a6",
           "#c44e9b", "#7a8b3a", "#b5b5b5"]


def _polygons(payload: dict):
    from shapely.geometry import Polygon
    polys = [Polygon(r) for r in payload["polygons"] if len(r) >= 3]
    if not polys:
        raise ValueError("no valid polygon in selection")
    return polys


def assign(session, payload: dict) -> list:
    """Label cells inside the polygon(s) into `region_set`/`category`, in place.
    Returns the changed field paths for the structural diff."""
    import geopandas as gpd
    from matplotlib.path import Path as MplPath
    from spatialdata.models import ShapesModel
    from spatialdata.transformations import Identity

    adata = session.active_table()
    sdata = session.sdata
    st = session.app_state

    set_name = payload["region_set"]
    category = payload["category"]
    color = payload.get("color")
    polys = _polygons(payload)
    cs = payload.get("coordinate_system") or sdata.coordinate_systems[0]

    if "spatial" not in adata.obsm:
        raise ValueError("table has no obsm['spatial']; cannot compute membership")
    coords = np.asarray(adata.obsm["spatial"])[:, :2]
    inside = np.zeros(len(coords), dtype=bool)
    for poly in polys:
        inside |= MplPath(np.asarray(poly.exterior.coords)).contains_points(coords)
    if not inside.any():
        raise ValueError("selection contains zero cells")

    # obs categorical column, "unassigned" by default (single-label partition, §2)
    col = adata.obs.get(set_name)
    if col is None or not isinstance(col.dtype, pd.CategoricalDtype):
        col = pd.Categorical([UNASSIGNED] * adata.n_obs, categories=[UNASSIGNED])
    col = pd.Series(col, index=adata.obs.index).astype("category")
    if category not in col.cat.categories:
        col = col.cat.add_categories([category])
    col = col.copy()
    col[inside] = category
    adata.obs[set_name] = col

    # shapes element (best-effort; the obs column is the load-bearing artifact).
    # SpatialData element keys cannot contain '/', so the conceptual "regions/<set>"
    # becomes "region_<set>".
    elem = f"region_{set_name}"
    try:
        from shapely.geometry import MultiPolygon
        geom = polys[0] if len(polys) == 1 else MultiPolygon(polys)
        row = gpd.GeoDataFrame({"region_set": [set_name], "category": [category]}, geometry=[geom])
        if elem in sdata.shapes:
            prev = sdata.shapes[elem]
            prev = prev[prev["category"] != category]  # redraw replaces this category
            combined = gpd.GeoDataFrame(pd.concat([prev, row], ignore_index=True), geometry="geometry")
        else:
            combined = row
        sdata.shapes[elem] = ShapesModel.parse(combined, transformations={cs: Identity()})
        has_geom = True
    except Exception as e:  # geometry is best-effort; log but keep the obs membership
        import sys
        print(f"[regions] geometry write failed for {elem}: {type(e).__name__}: {e}", file=sys.stderr)
        has_geom = False

    _update_registry(st, adata, set_name, elem if has_geom else None, cs, primary=category, color=color)
    fields = [f"obs:{set_name}"]
    if has_geom:
        fields.append(f"shapes:{elem}")
    return fields


def _update_registry(st: dict, adata, set_name: str, elem: str | None, cs: str, primary: str, color: str | None):
    regions = st.setdefault("regions", [])
    entry = next((r for r in regions if r.get("obs_column") == set_name), None)
    if entry is None:
        entry = {"id": str(uuid.uuid4()), "name": set_name, "obs_column": set_name,
                 "shapes_element": elem, "coordinate_system": cs, "categories": [],
                 "display": {"show_polygons": True, "fill_opacity": 0.15, "outline": True}}
        regions.append(entry)
    elif elem and not entry.get("shapes_element"):
        entry["shapes_element"] = elem

    counts = adata.obs[set_name].value_counts()
    prev_colors = {c["label"]: c.get("color") for c in entry.get("categories", [])}
    cats = []
    for i, label in enumerate(adata.obs[set_name].cat.categories):
        if label == primary and color:
            hexc = color
        elif label in prev_colors and prev_colors[label]:
            hexc = prev_colors[label]
        elif label == UNASSIGNED:
            hexc = "#bbbbbb"
        else:
            hexc = PALETTE[i % len(PALETTE)]
        cats.append({"label": str(label), "color": hexc, "n_cells": int(counts.get(label, 0))})
    entry["categories"] = cats


def promote(session, obs_column: str) -> list:
    """Promote an existing categorical obs column to a region set (no geometry, §3.2)."""
    adata = session.active_table()
    if obs_column not in adata.obs.columns:
        raise ValueError(f"obs column '{obs_column}' not found")
    if not isinstance(adata.obs[obs_column].dtype, pd.CategoricalDtype):
        adata.obs[obs_column] = adata.obs[obs_column].astype("category")
    cs = session.sdata.coordinate_systems[0]
    _update_registry(session.app_state, adata, obs_column, None, cs, primary="", color=None)
    return [f"obs:{obs_column}"]
