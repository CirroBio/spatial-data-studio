"""
boundary_compute.py
===================

COMPUTATION for tissue-region / infiltration analysis. Plotting lives in
``boundary_plot.py``.

------------------------------------------------------------------------------
BIOLOGICAL CONTEXT
------------------------------------------------------------------------------
"Infiltration" is a spatial question about a reference frame: how deeply does one
cell population sit *inside* a region defined by another (classically, immune
cells relative to a tumor)? The clinical framing (Immunoscore-style core / margin
/ stroma) assumes a pathologist drew the region boundary. This module removes that
prerequisite: it **derives the region from the cell labels you already have** and
turns it into a single per-cell coordinate — a signed distance to the region
margin (negative = interior/core, 0 = margin, positive = exterior/stroma).

From that one coordinate everything follows:
  * bin cells by it and take a target population's density  -> infiltration gradient
    (distinguishes an infiltrated tumor from an immune-EXCLUDED one, which bulk
    and boundary-free scores cannot);
  * threshold it -> core / margin / stroma compartments, into which any proximity
    or enrichment test can then be run.

You do NOT need to supply geometric boundaries. Inputs are coordinates + cell-type
labels + which label(s) form the region interior.

------------------------------------------------------------------------------
COMPUTATIONAL APPROACH (two tiers, one shared signed-distance interface)
------------------------------------------------------------------------------
  method="mask"  (default): rasterize interior-cell density (2-D histogram +
     Gaussian smoothing), threshold to a binary region, clean it morphologically,
     drop specks, then a Euclidean distance transform gives a true signed distance
     in coordinate units. This is the only tier that yields an actual margin.
  method="soft": for each cell, the local fraction of interior-label cells within
     radius r (a continuous 0->1 "insideness"). No mask, no polygon, one
     parameter; mapped to a unitless signed coordinate 0.5 - insideness so the
     downstream interface is identical. Use when a mask is not defensible
     (scattered / irregular regions).

Depends only on numpy / scipy; ``boundary_adata`` is a thin AnnData wrapper.

NOTE: the mask tier has one free parameter that IS the analysis — the spatial
scale at which tissue "becomes" interior (bandwidth / bin_size / threshold). It is
surfaced explicitly and the mask is meant to be eyeballed (see boundary_plot).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Sequence, Union

import numpy as np
import pandas as pd
from scipy import ndimage
from scipy.spatial import cKDTree

ArrayLike = Union[np.ndarray, Sequence]


# --------------------------------------------------------------------------- #
# Result container
# --------------------------------------------------------------------------- #
@dataclass
class BoundaryResult:
    """Everything a boundary/infiltration run produces, for handoff to plotting.

    Fields
    ------
    signed_distance  (n_cells,) negative = interior, 0 = margin, positive =
                     exterior. Coordinate units for method="mask"; unitless
                     [-0.5, 0.5] for method="soft".
    insideness       (n_cells,) local interior fraction [0, 1] (method="soft"
                     only; None for mask).
    compartment      (n_cells,) 'core' / 'margin' / 'stroma'.
    method           "mask" or "soft".
    mask             (nx, ny) bool region raster (method="mask"; None for soft).
    signed_grid      (nx, ny) signed distance per pixel (method="mask"; for
                     contouring the margin at 0).
    grid_origin      (x0, y0) lower corner of the raster in coordinate units.
    bin_size         raster pixel size in coordinate units (method="mask").
    interior_labels  labels treated as the region interior.
    margin_width     half-width of the margin band (signed_distance units).
    params           settings used, for provenance.
    """

    signed_distance: np.ndarray
    insideness: Optional[np.ndarray]
    compartment: np.ndarray
    method: str
    mask: Optional[np.ndarray]
    signed_grid: Optional[np.ndarray]
    grid_origin: Optional[tuple]
    bin_size: Optional[float]
    interior_labels: list
    margin_width: float
    params: dict = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Tier "soft" — local interior fraction (no mask)
# --------------------------------------------------------------------------- #
def local_interior_fraction(
    coords: np.ndarray,
    labels: ArrayLike,
    interior_labels: Sequence,
    *,
    radius: float,
):
    """Per-cell fraction of neighbors (within `radius`) that are interior-labeled.

    BIOLOGICAL CONTEXT
        A boundary-free "how surrounded by tumor am I" score: 1 deep inside the
        region, 0 far outside, ~0.5 at the edge.
    COMPUTATIONAL APPROACH
        Two KD-trees (all cells, interior cells); count neighbors within `radius`
        of each cell in each and divide.

    Returns (n_cells,) insideness in [0, 1].
    """
    coords = np.asarray(coords, dtype=float)              # coords = (n_cells, 2) positions
    labels = np.asarray(labels)                           # labels = (n_cells,) cell-type per cell
    is_interior = np.isin(labels, list(interior_labels))  # is_interior = mask of interior-label cells
    tree_all = cKDTree(coords)                            # tree_all = index over every cell
    tree_int = cKDTree(coords[is_interior])               # tree_int = index over interior cells only
    n_all = tree_all.query_ball_point(coords, radius, return_length=True)  # neighbors within r
    n_int = tree_int.query_ball_point(coords, radius, return_length=True)  # interior neighbors within r
    n_all = np.maximum(n_all, 1)                          # guard against divide-by-zero (isolated cells)
    return n_int / n_all                                  # insideness fraction per cell


# --------------------------------------------------------------------------- #
# Tier "mask" — rasterized region + signed distance
# --------------------------------------------------------------------------- #
def build_region_mask(
    coords: np.ndarray,
    labels: ArrayLike,
    interior_labels: Sequence,
    *,
    bin_size: float,
    bandwidth: float,
    threshold: float = 0.25,
    min_area: float = 0.0,
    pad: float = 0.0,
):
    """Rasterize interior-cell density into a cleaned binary region mask.

    BIOLOGICAL CONTEXT
        Approximates the physical territory occupied by the interior population
        (e.g. the tumor nest) without a hand-drawn outline.
    COMPUTATIONAL APPROACH
        2-D histogram of interior-cell positions -> Gaussian smoothing (sigma =
        bandwidth / bin_size) -> threshold at `threshold` x the max smoothed
        density -> morphological close then open -> drop connected components
        smaller than `min_area` (coordinate-unit^2).

    Returns
    -------
    mask         (nx, ny) bool raster.
    grid_origin  (x0, y0) lower corner in coordinate units.
    (nx, ny)     raster shape.
    """
    coords = np.asarray(coords, dtype=float)              # coords = positions
    labels = np.asarray(labels)                           # labels = cell-type per cell
    is_interior = np.isin(labels, list(interior_labels))  # is_interior = interior-cell mask
    x0, y0 = coords[:, 0].min() - pad, coords[:, 1].min() - pad  # grid lower corner (padded)
    x1, y1 = coords[:, 0].max() + pad, coords[:, 1].max() + pad  # grid upper corner
    nx = max(1, int(np.ceil((x1 - x0) / bin_size)))       # nx = raster columns
    ny = max(1, int(np.ceil((y1 - y0) / bin_size)))       # ny = raster rows
    ix = np.clip(((coords[is_interior, 0] - x0) / bin_size).astype(int), 0, nx - 1)  # interior x-bins
    iy = np.clip(((coords[is_interior, 1] - y0) / bin_size).astype(int), 0, ny - 1)  # interior y-bins
    dens = np.zeros((nx, ny), dtype=float)                # dens = interior-cell count per pixel
    np.add.at(dens, (ix, iy), 1.0)                        # accumulate counts into the grid
    dens = ndimage.gaussian_filter(dens, sigma=bandwidth / bin_size)  # smooth to a density field
    if dens.max() > 0:                                    # normalize to [0, 1] for relative threshold
        dens = dens / dens.max()
    mask = dens > threshold                               # mask = pixels above the density threshold
    struct = ndimage.generate_binary_structure(2, 2)      # struct = 8-connectivity element
    mask = ndimage.binary_closing(mask, structure=struct, iterations=1)  # fill small holes
    mask = ndimage.binary_opening(mask, structure=struct, iterations=1)  # remove small specks
    if min_area > 0:                                      # drop connected components below min_area
        lab, n = ndimage.label(mask, structure=struct)    # lab = component id per pixel; n = count
        min_px = min_area / (bin_size ** 2)               # min_px = min component size in pixels
        keep = np.zeros_like(mask)                        # keep = cleaned mask accumulator
        for c in range(1, n + 1):                         # c = component id
            comp = lab == c                               # comp = pixels of this component
            if comp.sum() >= min_px:                      # keep only sufficiently large regions
                keep |= comp
        mask = keep
    return mask, (x0, y0), (nx, ny)


def signed_distance_to_margin(mask, grid_origin, bin_size, coords):
    """Per-cell signed distance to the region margin (negative inside).

    BIOLOGICAL CONTEXT
        The single coordinate infiltration is measured against: how far inside or
        outside the region each cell sits. Handles multiple disconnected nests
        automatically (distance is to the NEAREST margin).
    COMPUTATIONAL APPROACH
        Euclidean distance transforms of the mask and its complement; signed grid
        = dist_outside - dist_inside (in pixels) x bin_size; sample per cell by its
        raster index.

    Returns
    -------
    signed_per_cell  (n_cells,) signed distance in coordinate units.
    signed_grid      (nx, ny) signed distance per pixel (coordinate units).
    """
    coords = np.asarray(coords, dtype=float)              # coords = positions
    x0, y0 = grid_origin                                  # grid lower corner
    nx, ny = mask.shape                                   # raster shape
    if mask.any() and not mask.all():                     # normal case: a boundary exists
        d_in = ndimage.distance_transform_edt(mask)       # d_in = depth inside the region (pixels)
        d_out = ndimage.distance_transform_edt(~mask)     # d_out = distance to region from outside
        signed_grid = (d_out - d_in) * bin_size           # signed grid: + outside, - inside
    else:                                                 # degenerate mask (all/none) -> flat field
        signed_grid = np.full((nx, ny), np.nan)
    ix = np.clip(((coords[:, 0] - x0) / bin_size).astype(int), 0, nx - 1)  # per-cell x raster index
    iy = np.clip(((coords[:, 1] - y0) / bin_size).astype(int), 0, ny - 1)  # per-cell y raster index
    signed_per_cell = signed_grid[ix, iy]                 # sample the signed field at each cell
    return signed_per_cell, signed_grid


# --------------------------------------------------------------------------- #
# Shared downstream: compartments + infiltration profile
# --------------------------------------------------------------------------- #
def assign_compartments(signed_distance: np.ndarray, margin_width: float):
    """Bucket the signed distance into core / margin / stroma.

    BIOLOGICAL CONTEXT
        Recovers the classical three compartments from the continuous coordinate:
        'core' = interior, 'margin' = the band within `margin_width` of the
        boundary, 'stroma' = exterior.
    COMPUTATIONAL APPROACH
        Two thresholds at -/+ margin_width on the signed distance.

    Returns (n_cells,) array of strings.
    """
    sd = np.asarray(signed_distance, dtype=float)         # sd = signed distances
    comp = np.full(sd.shape[0], "margin", dtype=object)   # comp = default 'margin'
    comp[sd < -margin_width] = "core"                     # deep interior -> core
    comp[sd > margin_width] = "stroma"                    # exterior -> stroma
    comp[~np.isfinite(sd)] = "undefined"                  # NaNs (degenerate mask)
    return comp.astype(str)                               # return as string array


def infiltration_profile(
    signed_distance: np.ndarray,
    labels: ArrayLike,
    target_labels: Sequence,
    *,
    bins: Union[int, np.ndarray] = 20,
    value: str = "fraction",
):
    """Target-population abundance as a function of signed distance to the margin.

    BIOLOGICAL CONTEXT
        THE infiltration readout. A target that infiltrates shows abundance
        extending into negative distances (inside); an EXCLUDED target piles up
        just outside the margin (small positive) with a deficit at negative.
    COMPUTATIONAL APPROACH
        Bin cells by signed distance; per bin report the fraction of cells that
        are a target type (composition) or the raw count.

    Parameters
    ----------
    signed_distance  (n_cells,) signed distances.
    labels           (n_cells,) cell-type labels.
    target_labels    one or more labels to profile.
    bins             number of bins or explicit bin edges.
    value            "fraction" (target share of cells per bin) or "count".

    Returns
    -------
    DataFrame indexed by bin-center distance, one column per target label plus
    'n_cells' (cells per bin).
    """
    sd = np.asarray(signed_distance, dtype=float)         # sd = signed distances
    labels = np.asarray(labels)                           # labels = cell types
    finite = np.isfinite(sd)                              # finite = cells with a defined distance
    sd, labels = sd[finite], labels[finite]               # drop undefined cells
    if np.isscalar(bins):                                 # build equal-width edges if given a count
        edges = np.linspace(sd.min(), sd.max(), int(bins) + 1)  # edges = bin boundaries
    else:
        edges = np.asarray(bins, dtype=float)             # edges = user-provided boundaries
    centers = 0.5 * (edges[:-1] + edges[1:])              # centers = bin-center distances
    which = np.clip(np.digitize(sd, edges) - 1, 0, len(centers) - 1)  # which = bin index per cell
    out = {"n_cells": np.array([np.sum(which == b) for b in range(len(centers))])}  # cells per bin
    for t in target_labels:                               # t = one target cell type
        is_t = labels == t                                # is_t = mask of target cells
        per_bin = np.array([                              # per_bin = count/fraction of t per bin
            (np.sum(is_t[which == b]) / max(np.sum(which == b), 1)) if value == "fraction"
            else np.sum(is_t[which == b])
            for b in range(len(centers))
        ])
        out[str(t)] = per_bin                             # column per target label
    return pd.DataFrame(out, index=pd.Index(centers, name="signed_distance"))


# --------------------------------------------------------------------------- #
# Orchestrator (array interface)
# --------------------------------------------------------------------------- #
def region_boundary(
    coords: np.ndarray,
    labels: ArrayLike,
    interior_labels: Sequence,
    *,
    method: str = "mask",
    bin_size: Optional[float] = None,
    bandwidth: Optional[float] = None,
    threshold: float = 0.25,
    min_area: float = 0.0,
    radius: Optional[float] = None,
    margin_width: Optional[float] = None,
) -> BoundaryResult:
    """Derive a region from labels and return a per-cell signed-distance frame.

    BIOLOGICAL CONTEXT
        Turns "which cells are Tumor" into "how far inside/outside the tumor is
        every cell", the basis for all infiltration readouts.
    COMPUTATIONAL APPROACH
        method="mask": build_region_mask -> signed_distance_to_margin.
        method="soft": local_interior_fraction -> signed = 0.5 - insideness.
        Then assign_compartments on the signed coordinate.

    Parameters
    ----------
    coords           (n_cells, 2) coordinates.
    labels           (n_cells,) cell-type labels.
    interior_labels  label(s) forming the region interior (e.g. ["Tumor"]).
    method           "mask" (default) or "soft".
    bin_size         raster pixel size (mask); defaults to ~1/60 of the smaller
                     extent if omitted.
    bandwidth        Gaussian smoothing scale (mask); defaults to 3 x bin_size.
    threshold        relative density threshold in [0, 1] (mask).
    min_area         minimum region area in coordinate-unit^2 (mask); filters
                     specks / isolated single-cell nests.
    radius           neighborhood radius (soft); defaults to bandwidth or a
                     fraction of the extent.
    margin_width     half-width of the margin band in signed-distance units;
                     defaults to bandwidth (mask) or 0.15 (soft).
    """
    coords = np.asarray(coords, dtype=float)              # coords = positions
    labels = np.asarray(labels)                           # labels = cell types
    interior_labels = list(interior_labels)               # interior_labels = region-defining labels
    extent = float(min(np.ptp(coords[:, 0]), np.ptp(coords[:, 1])))  # extent = smaller bbox side

    if method == "mask":
        bin_size = bin_size or max(extent / 60.0, 1e-6)   # default raster resolution
        bandwidth = bandwidth or 3.0 * bin_size           # default smoothing scale
        mask, grid_origin, _ = build_region_mask(         # build the binary region
            coords, labels, interior_labels, bin_size=bin_size, bandwidth=bandwidth,
            threshold=threshold, min_area=min_area,
        )
        signed, signed_grid = signed_distance_to_margin(  # per-cell + per-pixel signed distance
            mask, grid_origin, bin_size, coords
        )
        insideness = None                                 # not defined for the mask tier
        mw = margin_width if margin_width is not None else bandwidth  # margin band half-width
    elif method == "soft":
        radius = radius or max(extent / 15.0, 1e-6)        # default neighborhood radius
        insideness = local_interior_fraction(             # per-cell interior fraction
            coords, labels, interior_labels, radius=radius
        )
        signed = 0.5 - insideness                         # signed coord: + outside, - inside
        signed_grid = mask = grid_origin = bin_size = None  # no raster in the soft tier
        mw = margin_width if margin_width is not None else 0.15  # default margin band (unitless)
    else:
        raise ValueError(f"Unknown method {method!r}; use 'mask' or 'soft'.")

    compartment = assign_compartments(signed, mw)         # core / margin / stroma per cell

    return BoundaryResult(
        signed_distance=signed,
        insideness=insideness,
        compartment=compartment,
        method=method,
        mask=mask,
        signed_grid=signed_grid,
        grid_origin=grid_origin,
        bin_size=bin_size,
        interior_labels=interior_labels,
        margin_width=mw,
        params={"method": method, "bin_size": bin_size, "bandwidth": bandwidth,
                "threshold": threshold, "min_area": min_area, "radius": radius,
                "margin_width": mw},
    )


# --------------------------------------------------------------------------- #
# AnnData wrapper
# --------------------------------------------------------------------------- #
def boundary_adata(
    adata,
    cell_type_key: str,
    interior_labels: Sequence,
    *,
    spatial_key: str = "spatial",
    method: str = "mask",
    key_added: str = "boundary",
    **kwargs,
) -> BoundaryResult:
    """Run region/infiltration analysis on an AnnData; write per-cell columns to ``.obs``.

    COMPUTATIONAL APPROACH
        Pull coordinates from ``adata.obsm[spatial_key]`` and labels from
        ``adata.obs``; call ``region_boundary``; write signed distance and
        compartment to ``.obs`` and parameters/mask metadata to ``.uns``.
    """
    coords = np.asarray(adata.obsm[spatial_key])          # coords = spatial coordinates
    labels = np.asarray(adata.obs[cell_type_key].values)  # labels = cell-type per cell
    res = region_boundary(coords, labels, interior_labels, method=method, **kwargs)
    adata.obs[f"{key_added}_signed_distance"] = res.signed_distance  # per-cell distance
    adata.obs[f"{key_added}_compartment"] = pd.Categorical(res.compartment)  # per-cell compartment
    if res.insideness is not None:                        # soft tier also writes insideness
        adata.obs[f"{key_added}_insideness"] = res.insideness
    adata.uns[key_added] = {"params": res.params, "interior_labels": res.interior_labels}
    return res


# --------------------------------------------------------------------------- #
# Synthetic data + demo
# --------------------------------------------------------------------------- #
def make_synthetic_infiltration(seed: int = 0):
    """Tumor disk with one INFILTRATING and one EXCLUDED immune population.

    BIOLOGICAL CONTEXT
        Ground truth for infiltration: 'T_infil' penetrates the tumor (spans
        negative distances), 'T_excl' is kept at/outside the margin (positive
        distances only). A correct method must separate them.
    COMPUTATIONAL APPROACH
        Tumor = uniform disk (radius R). T_infil = points inside the disk plus
        some stroma. T_excl = points in an annulus outside R (never inside).
        'Other' = scattered stromal filler.

    Returns (coords, labels).
    """
    rng = np.random.default_rng(seed)                     # rng = seeded RNG
    R = 15.0                                              # R = tumor radius

    def disk(n, rmax, rmin=0.0, center=(0.0, 0.0)):       # helper: n points in an annulus/disk
        r = np.sqrt(rng.uniform(rmin ** 2, rmax ** 2, n)) # r = radii (area-uniform)
        th = rng.uniform(0, 2 * np.pi, n)                 # th = angles
        return np.column_stack([center[0] + r * np.cos(th), center[1] + r * np.sin(th)])

    tumor = disk(1600, R)                                 # tumor = solid disk of tumor cells
    infil = np.vstack([disk(500, R * 0.95),               # infil inside the tumor
                       disk(150, R + 12, R)])             # + some in the surrounding stroma
    excl = disk(500, R + 10, R + 1)                       # excl = ring just OUTSIDE the margin
    other = rng.uniform(-32, 32, (1400, 2))               # other = stromal filler across the field
    coords = np.vstack([tumor, infil, excl, other])       # coords = all cells
    labels = np.array(                                    # labels = cell types
        ["Tumor"] * len(tumor) + ["T_infil"] * len(infil)
        + ["T_excl"] * len(excl) + ["Other"] * len(other)
    )
    return coords, labels


def _demo():
    """Derive the tumor region and verify infiltrating vs excluded separation."""
    coords, labels = make_synthetic_infiltration()        # synthetic tissue with known truth
    res = region_boundary(coords, labels, ["Tumor"], method="mask",
                          min_area=20.0, threshold=0.25)   # derive region + signed distance
    sd = res.signed_distance                              # sd = per-cell signed distance
    for t in ["T_infil", "T_excl", "Tumor"]:              # report distance stats per population
        m = labels == t                                   # m = cells of this type
        print(f"{t:8s}  median signed dist {np.nanmedian(sd[m]):+6.2f}   "
              f"fraction inside (<0): {np.mean(sd[m] < 0):.2f}")
    frac_infil = np.mean(sd[labels == "T_infil"] < 0)     # infiltrating cells inside the tumor
    frac_excl = np.mean(sd[labels == "T_excl"] < 0)       # excluded cells inside the tumor
    print(f"\nCHECK infiltrating penetrates (want high): {frac_infil:.2f}")
    print(f"CHECK excluded stays out    (want ~0):     {frac_excl:.2f}")

    prof = infiltration_profile(sd, labels, ["T_infil", "T_excl"], bins=16)  # infiltration gradient
    print("\nInfiltration profile (target fraction by signed-distance bin):")
    print(prof.round(2).to_string())


if __name__ == "__main__":
    _demo()
