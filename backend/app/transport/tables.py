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


def describe_elements(adata, sdata, active_table_key: str | None, *,
                      sizes: bool = False, stores: dict[str, str] | None = None) -> dict:
    """Inventory of the object's elements for the inspector's navigator.

    `sizes` additionally annotates every entry with `size_mb` — the estimated
    contribution that element makes to a written checkpoint — every image with the same
    breakdown per pyramid level (`levels`), and every table with the same breakdown per
    AnnData slot (`slots`), for the save dialog's per-element size, its resolution
    slider and its per-slot checkboxes. Off by default: it stats the backing store,
    which the inspector has no use for. See `store.element_size_mb` for the accuracy
    contract."""
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
        # Every shapes element is listed, `shape_annotations.ELEMENT` included: this is the
        # whole inventory, which the inspector browses and the save dialog turns into the
        # set of elements written to the checkpoint — dropping the annotations here would
        # leave a user's drawings out of every saved file. Consumers that want *boundary*
        # sets filter it out themselves (snapshots._shapes_element, SpatialCanvas'
        # polygonElements), since it is polygonal and would otherwise pass for one.
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

    out = {"tables": tables, "shapes": shapes, "points": points,
           "images": images, "labels": labels}
    if sizes and sdata is not None:
        from ..persistence.store import element_size_mb, image_levels, table_slots
        for facet, entries in out.items():
            for e in entries:
                e["size_mb"] = element_size_mb(sdata, facet, e["name"], stores)
                if facet == "images":
                    e["levels"] = image_levels(sdata, e["name"], stores)
                elif facet == "tables":
                    e["slots"] = table_slots(sdata, e["name"], stores)
    return out


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
    if element == "tables":
        # "tables:<name>:obs|var" names a specific table so the inspector can preview
        # a non-active one; bare "obs"/"var" above keeps meaning the active table.
        # rpartition: the facet is always the last segment, whatever the table name.
        table_name, _, field = name.rpartition(":")
        if sdata is None or table_name not in sdata.tables:
            raise KeyError(f"no table named {table_name!r}")
        table = sdata.tables[table_name]
        if field == "obs":
            return table.obs
        if field == "var":
            return table.var
        raise ValueError(f"unsupported table path: {path}")
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
        # npartitions=-1: dask's head() reads only the FIRST partition by default, so a
        # page starting past that partition's row count came back empty instead of the
        # rows it asked for.
        sl = df.head(offset + limit, npartitions=-1).iloc[offset : offset + limit]
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
