"""Region annotation (post-build spec Parts 2-3).

A region set is just a categorical `obs` column; a region is a category within it.
Annotating labels the cells whose `obsm['spatial']` falls inside the drawn lasso with
that category — mutating the session object in place (a queued mutating job, §3.1) and
updating the `attrs.regions` registry (the obs column plus its categories/colors/cell
counts). No geometry is stored: a region set is an ordinary `obs` categorical, so it
flows through every existing picker/coloring mechanism unchanged.
"""
from __future__ import annotations

import uuid

import numpy as np
import pandas as pd

from . import transform

UNASSIGNED = "unassigned"
# distinct, color-blind-ish palette for new categories
PALETTE = ["#c1432b", "#2b6cc1", "#3a9e54", "#d4972b", "#8e5bc4", "#39a6a6",
           "#c44e9b", "#7a8b3a", "#b5b5b5"]


def _membership_from_indices(adata, cell_indices: list[int]) -> np.ndarray:
    """Boolean mask from explicit table-row indices — the selection made on the
    embedding view (2D point-in-polygon, or 3D projected-into-region), where the drawn
    region lives in embedding/screen space, not the spatial coordinate system, so the
    frontend resolves the cells and sends their row indices instead of a lasso."""
    inside = np.zeros(adata.n_obs, dtype=bool)
    idx = np.asarray(cell_indices, dtype=int)
    idx = idx[(idx >= 0) & (idx < adata.n_obs)]
    if idx.size == 0:
        raise ValueError("selection contains zero cells")
    inside[idx] = True
    return inside


def _membership(sdata, adata, payload: dict) -> np.ndarray:
    """Boolean mask of cells whose coordinates fall inside any drawn ring. The lasso
    rings arrive in *world* space, so the cells are resolved into the same space by
    `transform.world_xy` — which key holds the coordinates, then the region element's
    points->world affine — before the point-in-polygon test. Going through that one
    helper is what keeps a nudged alignment (set_affine6) and a multi-region table
    (whose plotted key is not `obsm['spatial']`) from labelling the wrong cells.
    Mirrors the transform geometry.py and the subset polygon_query apply."""
    from matplotlib.path import Path as MplPath

    rings = [r for r in payload["polygons"] if len(r) >= 3]
    if not rings:
        raise ValueError("no valid polygon in selection")
    if "spatial" not in adata.obsm:
        raise ValueError("table has no obsm['spatial']; cannot compute membership")
    coords = transform.world_xy(sdata, adata)
    inside = np.zeros(len(coords), dtype=bool)
    for ring in rings:
        inside |= MplPath(np.asarray(ring)).contains_points(coords)
    if not inside.any():
        raise ValueError("selection contains zero cells")
    return inside


def assign(session, payload: dict) -> list:
    """Label cells inside the lasso into `region_set`/`category`, in place.
    Returns the changed field paths for the structural diff."""
    adata = session.active_table()
    st = session.app_state

    set_name = payload["region_set"]
    category = payload["category"]
    color = payload.get("color")

    # Annotating into a non-categorical column replaces it wholesale with a fresh
    # categorical (see below), destroying its data. Refuse that unless the column is
    # already a tracked region set. Relabeling an existing categorical (e.g. leiden)
    # is fine — it adds the category and keeps the other labels.
    region_cols = {r.get("obs_column") for r in st.get("regions", [])}
    existing = adata.obs.get(set_name)
    if (existing is not None and not isinstance(existing.dtype, pd.CategoricalDtype)
            and set_name not in region_cols):
        raise ValueError(f"'{set_name}' is an existing non-categorical column; choose a different region set name")

    cell_indices = payload.get("cell_indices")
    inside = (_membership_from_indices(adata, cell_indices) if cell_indices is not None
              else _membership(session.sdata, adata, payload))

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

    _update_registry(st, adata, set_name, primary=category, color=color)
    _apply_region_to_displays(st, set_name, category, color)
    return [f"obs:{set_name}"]


def _apply_region_to_displays(st: dict, set_name: str, category: str, color: str | None):
    """Make the just-labelled cells visible as labelled: point every display's color-by
    at the region set, and seed the picked color as that category's `category_colors`
    override (the per-category override mechanism honored by useSpotColors on both the
    spatial and embedding canvases) so the cells render in it without the user re-picking
    in the legend controls. Runs inside the same write-locked mutation that creates the
    obs column, so the color-by switch can never outrun the column's existence."""
    key = f"obs:{set_name}"
    for d in st.get("displays", []):
        enc = d.get("encoding")
        if enc is None:
            continue
        enc["color_by"] = key
        if color:
            enc.setdefault("category_colors", {}).setdefault(key, {})[category] = color


def _update_registry(st: dict, adata, set_name: str, primary: str, color: str | None):
    regions = st.setdefault("regions", [])
    entry = next((r for r in regions if r.get("obs_column") == set_name), None)
    if entry is None:
        entry = {"id": str(uuid.uuid4()), "name": set_name, "obs_column": set_name, "categories": []}
        regions.append(entry)

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
