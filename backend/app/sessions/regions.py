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


def _membership(adata, payload: dict, affine6: list[float]) -> np.ndarray:
    """Boolean mask of cells whose spatial coords fall inside any drawn ring. The
    lasso rings arrive in *world* space (the canvas draws obsm['spatial'] after the
    region element's points->global affine), so the coords must be pushed through the
    same affine before the point-in-polygon test — otherwise a nudged alignment
    (set_affine6) would label the wrong cells. Mirrors the transform geometry.py and
    the subset polygon_query apply."""
    from matplotlib.path import Path as MplPath

    rings = [r for r in payload["polygons"] if len(r) >= 3]
    if not rings:
        raise ValueError("no valid polygon in selection")
    if "spatial" not in adata.obsm:
        raise ValueError("table has no obsm['spatial']; cannot compute membership")
    xy = np.asarray(adata.obsm["spatial"])[:, :2]
    a, b, c, d, e, f = affine6
    coords = np.column_stack([a * xy[:, 0] + b * xy[:, 1] + c,
                              d * xy[:, 0] + e * xy[:, 1] + f])
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
    inside = _membership(adata, payload, transform.get_affine6(session.sdata, adata))

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
    return [f"obs:{set_name}"]


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
