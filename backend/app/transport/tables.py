"""Tabular previews of the SpatialData object's elements for the data inspector
(DESIGN §3.3). Unlike arrow.py (one typed column → Arrow IPC), this serves a
paginated, mixed-dtype slice of a whole dataframe as plain JSON — small payloads
(a page at a time), simple to render in a grid.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

_MAX_CELL = 80  # truncate long stringified cells (e.g. geometry WKT)


def describe_elements(adata, sdata, active_table_key: str | None) -> dict:
    """Inventory of the object's elements for the inspector's navigator."""
    tables = []
    if sdata is not None and sdata.tables:
        for name, t in sdata.tables.items():
            tables.append({
                "name": name, "n_obs": int(t.n_obs), "n_vars": int(t.n_vars),
                "active": name == active_table_key,
            })
    elif adata is not None:
        tables.append({"name": "table", "n_obs": int(adata.n_obs),
                       "n_vars": int(adata.n_vars), "active": True})

    shapes, points, images, labels = [], [], [], []
    if sdata is not None:
        for name, gdf in sdata.shapes.items():
            geom = sorted({str(g) for g in gdf.geom_type.unique()}) if len(gdf) else []
            shapes.append({
                "name": name, "count": int(len(gdf)), "geometry": geom,
                "columns": [c for c in gdf.columns if c != gdf.geometry.name],
            })
        for name, pdf in sdata.points.items():
            points.append({"name": name, "columns": [str(c) for c in pdf.columns]})
        for name in sdata.images:
            images.append({"name": name})
        for name in sdata.labels:
            labels.append({"name": name})

    return {"tables": tables, "shapes": shapes, "points": points,
            "images": images, "labels": labels}


def _cell(v):
    """Coerce one dataframe cell to a JSON-safe scalar."""
    if v is None:
        return None
    if hasattr(v, "geom_type"):  # shapely geometry
        w = v.wkt
        return w if len(w) <= _MAX_CELL else w[: _MAX_CELL - 3] + "..."
    if isinstance(v, np.generic):
        v = v.item()
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, (bool, int, float, str)):
        return v
    s = str(v)
    return s if len(s) <= _MAX_CELL else s[: _MAX_CELL - 3] + "..."


def _frame_for(adata, sdata, path: str) -> pd.DataFrame:
    element, _, name = path.partition(":")
    if element == "obs":
        return adata.obs
    if element == "var":
        return adata.var
    if element in ("shapes", "points"):
        if sdata is None:
            raise ValueError(f"no SpatialData object; cannot read {path}")
        return sdata.shapes[name] if element == "shapes" else sdata.points[name]
    raise ValueError(f"unsupported table path: {path}")


def table_preview(adata, sdata, path: str, offset: int, limit: int) -> dict:
    df = _frame_for(adata, sdata, path)
    is_dask = hasattr(df, "npartitions")
    total = int(df.shape[0].compute()) if is_dask else int(len(df))

    if is_dask:
        sl = df.head(offset + limit).iloc[offset : offset + limit]
    else:
        sl = df.iloc[offset : offset + limit]

    columns = [{"name": str(c), "dtype": str(df[c].dtype)} for c in df.columns]
    values = sl.to_numpy(dtype=object)
    rows = [[_cell(values[r][c]) for c in range(values.shape[1])]
            for r in range(values.shape[0])]

    return {
        "path": path,
        "total_rows": total,
        "offset": offset,
        "limit": limit,
        "index_name": sl.index.name or "index",
        "index": [str(i) for i in sl.index],
        "columns": columns,
        "rows": rows,
    }
