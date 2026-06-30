"""Automatic TMA (tissue microarray) core detection.

Adapted from the grid/core-detection algorithm in the spatial-data-collection
project and rewritten to operate directly on an (x, y) coordinate table — no
SpatialPoints/Streamlit coupling. The public entry point is `assign_cores`,
which detects the TMA grid, fits a convex hull per core, names the cores, and
returns a per-point core-name array aligned to the input rows.

Pipeline: estimate grid line counts per axis (Gaussian-mixture density) ->
locate the grid lines -> iteratively assign a minor grid of occupied cells to
the nearest core centroid -> hull each core -> name cores by row/column ->
label each input point by the hull that contains it.
"""
from __future__ import annotations

from string import ascii_uppercase

import numpy as np
import pandas as pd
from matplotlib.path import Path
from scipy.spatial import ConvexHull, distance
from scipy.spatial.transform import Rotation
from sklearn.mixture import GaussianMixture

UNASSIGNED = "unassigned"
NAMING_SCHEMES = ("Row=Letter; Column=Number", "Column=Letter; Row=Number")


def _subsample(vals: pd.Series, n: int) -> pd.Series:
    return vals.sample(min(len(vals), n), random_state=0) if len(vals) > n else vals


def _rotate(coords: pd.DataFrame, angle: float) -> pd.DataFrame:
    """Rotate x/y about the z axis by `angle` degrees (clockwise)."""
    if angle == 0.0:
        return coords[["x", "y"]].copy()
    r = Rotation.from_euler("z", angle, degrees=True)
    rotated = r.apply(coords[["x", "y"]].assign(z=0).values)[:, :2]
    return pd.DataFrame(rotated, columns=["x", "y"], index=coords.index)


def _gaussian_mixture(vals: pd.Series, k: int):
    X = vals.values.reshape(-1, 1)
    gm = GaussianMixture(n_components=k, random_state=0).fit(X)
    pred = gm.predict(X)
    proba = [row[i] for i, row in zip(pred, gm.predict_proba(X))]
    return gm, float(np.mean(proba))


def _guess_n(vals: pd.Series, max_n=16, min_n=2) -> int:
    """Pick the grid-line count that maximises mean assignment probability."""
    upper = min(max_n, max(min_n, len(vals.unique()) - 1))
    best_n, best_score = min_n, None
    for k in range(min_n, upper + 1):
        _, score = _gaussian_mixture(vals, k)
        if best_score is None or score > best_score:
            best_n, best_score = k, score
    return best_n


def _find_grid(vals: pd.Series, n: int) -> np.ndarray:
    gm, _ = _gaussian_mixture(vals, n)
    grid = np.sort(gm.means_[:, 0])
    dists = np.diff(grid)
    median_dist = np.median(dists)
    for i in range(1, len(grid)):
        if dists[i - 1] > 1.75 * median_dist:
            grid = np.insert(grid, i, (grid[i - 1] + grid[i]) / 2)
    return grid


def _closest_core(cells: pd.DataFrame, cores: pd.DataFrame) -> pd.DataFrame:
    dists = distance.cdist(cells[["grid_x", "grid_y"]].values, cores[["grid_x", "grid_y"]].values)
    idx = np.argmin(dists, axis=1)
    cells = cells.copy()
    cells["closest_core"] = [cores.index[i] for i in idx]
    cells["closest_dist"] = dists[np.arange(dists.shape[0]), idx]
    return cells


def _core_centroids(cells: pd.DataFrame) -> pd.DataFrame:
    median_dist = cells["closest_dist"].median()
    near = cells.query(f"closest_dist <= {2 * median_dist}")
    n_cells = near.groupby("closest_core").size()
    keep = n_cells[n_cells >= 0.1 * n_cells.median()].index
    return (near[near["closest_core"].isin(keep)]
            .groupby("closest_core").agg({"grid_x": "mean", "grid_y": "mean"}))


def _hull(core_coords: pd.DataFrame) -> np.ndarray | None:
    if core_coords.shape[0] < 3:
        return None
    mean_x, mean_y = core_coords["x"].mean(), core_coords["y"].mean()
    d = np.sqrt((core_coords["x"] - mean_x) ** 2 + (core_coords["y"] - mean_y) ** 2)
    keep = d <= d.quantile(0.99) * 1.1   # drop outliers before hulling
    pts = core_coords.loc[keep, ["x", "y"]].values
    if pts.shape[0] < 3:
        return None
    return pts[ConvexHull(pts).vertices]


def _find_cores(coords: pd.DataFrame, x_grid, y_grid, min_prop_cells, minor_grid_scale=20, n_iter=50):
    cores = pd.DataFrame([
        {"x": x, "y": y, "col_i": col_i, "row_i": row_i, "id": f"core_{row_i}_{col_i}"}
        for row_i, x in enumerate(x_grid)
        for col_i, y in enumerate(y_grid)
    ]).set_index("id")

    x_median = np.median(np.diff(x_grid))
    y_median = np.median(np.diff(y_grid))
    minor = min(x_median, y_median) / minor_grid_scale

    coords = coords.assign(grid_x=(coords["x"] / minor).astype(int),
                           grid_y=(coords["y"] / minor).astype(int))
    cores = cores.assign(grid_x=(cores["x"] / minor).astype(int),
                         grid_y=(cores["y"] / minor).astype(int))
    coords = coords.query(
        f"x >= {x_grid[0] - 2 * x_median} and x <= {x_grid[-1] + 2 * x_median} and "
        f"y >= {y_grid[0] - 2 * y_median} and y <= {y_grid[-1] + 2 * y_median}")

    cells = coords[["grid_x", "grid_y"]].drop_duplicates()
    for _ in range(n_iter):
        cells = _closest_core(cells, cores)
        cores = _core_centroids(cells)

    coords = coords.merge(cells[["grid_x", "grid_y", "closest_core"]], on=["grid_x", "grid_y"], how="left")
    core_size = coords.groupby("closest_core").size()
    min_n = int(min_prop_cells * coords.shape[0])
    out = []
    for core_id, group in coords.groupby("closest_core"):
        if core_size.get(core_id, 0) < min_n:
            continue
        hull = _hull(group)
        if hull is None:
            continue
        out.append({"core_id": core_id,
                    "row_i": int(core_id.split("_")[1]), "col_i": int(core_id.split("_")[2]),
                    "n": int(core_size[core_id]), "shape": hull})
    return out


def _rotate_hulls_back(cores: list, angle: float):
    if angle == 0.0:
        return
    r = Rotation.from_euler("z", -angle, degrees=True)
    for core in cores:
        shape = core["shape"]
        core["shape"] = r.apply(np.hstack([shape, np.zeros((shape.shape[0], 1))]))[:, :2]


def _index_map(vals: pd.Series, ascending: bool, are_letters: bool) -> dict:
    labels = ascii_uppercase if are_letters else range(1, vals.shape[0] + 1)
    return dict(zip(vals.drop_duplicates().sort_values(ascending=ascending).tolist(), labels))


def _name_cores(cores: list, naming_scheme: str, row_start: str, col_start: str):
    if naming_scheme not in NAMING_SCHEMES:
        raise ValueError(f"unexpected core naming scheme: {naming_scheme}")
    rows_are_letters = naming_scheme == "Row=Letter; Column=Number"
    df = pd.DataFrame(cores)
    row_map = _index_map(df["row_i"], row_start == "Bottom", rows_are_letters)
    col_map = _index_map(df["col_i"], col_start == "Left", not rows_are_letters)
    for core in cores:
        rl, cl = row_map[core["row_i"]], col_map[core["col_i"]]
        core["name"] = f"{rl}{cl}" if rows_are_letters else f"{cl}{rl}"


def assign_cores(coords: pd.DataFrame, *, angle: float = 0.0, nrows: int | None = None,
                 ncols: int | None = None, min_prop_cells: float = 0.001,
                 core_naming_scheme: str = NAMING_SCHEMES[0], row_start: str = "Top",
                 col_start: str = "Left", subsample_n: int = 100000) -> tuple[pd.Series, list]:
    """Detect TMA cores and label each input point.

    `coords` must have columns 'x' and 'y'. Returns (labels, cores) where labels
    is a Series aligned to coords.index (core name or UNASSIGNED), and cores is
    the list of detected cores (name, grid position, cell count, hull vertices).
    """
    if row_start not in ("Top", "Bottom"):
        raise ValueError("row_start must be 'Top' or 'Bottom'")
    if col_start not in ("Left", "Right"):
        raise ValueError("col_start must be 'Left' or 'Right'")

    rotated = _rotate(coords, angle)
    ncols = ncols or _guess_n(_subsample(rotated["x"], subsample_n))
    nrows = nrows or _guess_n(_subsample(rotated["y"], subsample_n))
    x_grid = _find_grid(_subsample(rotated["x"], subsample_n), ncols)
    y_grid = _find_grid(_subsample(rotated["y"], subsample_n), nrows)

    cores = _find_cores(rotated, x_grid, y_grid, min_prop_cells)
    if not cores:
        return pd.Series(UNASSIGNED, index=coords.index, dtype=object), []
    _rotate_hulls_back(cores, angle)
    _name_cores(cores, core_naming_scheme, row_start, col_start)

    xy = coords[["x", "y"]].values
    labels = np.full(len(coords), UNASSIGNED, dtype=object)
    for core in cores:
        inside = Path(core["shape"]).contains_points(xy)
        labels[inside & (labels == UNASSIGNED)] = core["name"]
    return pd.Series(labels, index=coords.index, dtype=object), cores
