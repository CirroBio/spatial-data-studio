"""
boundary_plot.py
================

VISUALIZATION for region / infiltration analysis. Reads a ``BoundaryResult`` from
``boundary_compute.py``; performs no computation.

BIOLOGICAL CONTEXT
    Three readouts: the derived region overlaid on the tissue (QC — always look at
    this, the region is inferred and the scale parameter is a choice); the
    infiltration profile (target abundance vs distance to margin — the payoff);
    and the signed-distance distribution per population (infiltrating vs excluded
    at a glance).

COMPUTATIONAL APPROACH
    Thin matplotlib wrappers. The margin is drawn as the zero contour of the
    signed-distance grid (mask tier) or implied by the insideness field (soft).
"""

from __future__ import annotations

from typing import Optional, Sequence

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.axes import Axes
from matplotlib.figure import Figure

_COMPARTMENT_COLORS = {                                   # fixed colors for the three compartments
    "core": "#c1121f", "margin": "#f4a261", "stroma": "#457b9d", "undefined": "#cccccc",
}


# --------------------------------------------------------------------------- #
# View 1 — derived region overlaid on the tissue (QC)
# --------------------------------------------------------------------------- #
def plot_region_mask(
    result,
    coords: np.ndarray,
    labels: Optional[np.ndarray] = None,
    *,
    color_by: str = "compartment",
    point_size: float = 5.0,
    ax: Optional[Axes] = None,
    title: Optional[str] = "Derived region & margin",
):
    """Scatter cells with the inferred margin drawn on top.

    BIOLOGICAL CONTEXT
        The sanity check for the whole analysis: does the derived region actually
        trace the interior population? Because the region is inferred and its scale
        is a free parameter, this plot is where you decide whether to trust it.
    COMPUTATIONAL APPROACH
        Scatter cells (colored by compartment or by the interior/other split); for
        the mask tier draw the margin as the zero contour of the signed-distance
        grid; for the soft tier color by insideness.

    Returns matplotlib Axes.
    """
    coords = np.asarray(coords, dtype=float)              # coords = positions
    if ax is None:                                        # standalone figure if none supplied
        fig, ax = plt.subplots(figsize=(6, 6))
    else:
        fig = ax.figure                                   # fig = parent figure

    if color_by == "compartment":                         # color by core/margin/stroma
        for comp, col in _COMPARTMENT_COLORS.items():     # comp = compartment name, col = its color
            m = result.compartment == comp               # m = cells in this compartment
            if m.any():
                ax.scatter(coords[m, 0], coords[m, 1], s=point_size, c=col,
                           label=comp, linewidths=0)
        ax.legend(frameon=False, markerscale=2, fontsize=8,
                  bbox_to_anchor=(1.02, 1), loc="upper left")
    elif color_by == "insideness" and result.insideness is not None:  # soft-tier gradient
        sc = ax.scatter(coords[:, 0], coords[:, 1], s=point_size,
                        c=result.insideness, cmap="magma", linewidths=0)
        fig.colorbar(sc, ax=ax, fraction=0.046, pad=0.04).set_label("insideness", fontsize=9)
    else:                                                 # fall back to interior vs other
        interior = np.isin(np.asarray(labels), result.interior_labels)  # interior-cell mask
        ax.scatter(coords[~interior, 0], coords[~interior, 1], s=point_size,
                   c="0.8", linewidths=0, label="other")
        ax.scatter(coords[interior, 0], coords[interior, 1], s=point_size,
                   c="#c1121f", linewidths=0, label="interior")
        ax.legend(frameon=False, markerscale=2, fontsize=8)

    # draw the margin as the zero contour of the signed-distance grid (mask tier)
    if result.method == "mask" and result.signed_grid is not None and result.grid_origin:
        x0, y0 = result.grid_origin                       # grid lower corner
        nx, ny = result.signed_grid.shape                 # raster shape
        xs = x0 + (np.arange(nx) + 0.5) * result.bin_size # xs = pixel-center x coordinates
        ys = y0 + (np.arange(ny) + 0.5) * result.bin_size # ys = pixel-center y coordinates
        X, Y = np.meshgrid(xs, ys)                         # X, Y = coordinate grids (row=y, col=x)
        finite = np.isfinite(result.signed_grid)          # guard: only contour where defined
        if finite.any():
            ax.contour(X, Y, result.signed_grid.T, levels=[0.0],  # zero level = the margin
                       colors="k", linewidths=1.5)
    ax.set_aspect("equal")                                # undistorted tissue geometry
    ax.set_xticks([]); ax.set_yticks([])                  # coordinates are arbitrary units
    if title:
        ax.set_title(title)
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# View 2 — infiltration profile
# --------------------------------------------------------------------------- #
def plot_infiltration_profile(
    profile: pd.DataFrame,
    *,
    margin_width: Optional[float] = None,
    ax: Optional[Axes] = None,
    title: Optional[str] = "Infiltration profile",
):
    """Target abundance vs. signed distance to the margin.

    BIOLOGICAL CONTEXT
        The infiltration readout. A curve with mass at negative distances =
        infiltrated; a curve peaking just past 0 with nothing at negative =
        immune-excluded. The dashed line at 0 is the margin; shading marks core
        (left) and stroma (right).
    COMPUTATIONAL APPROACH
        Line per target column of the profile DataFrame against its bin-center
        signed distance; optional margin band shading.

    Returns matplotlib Axes.
    """
    x = profile.index.values                              # x = bin-center signed distances
    targets = [c for c in profile.columns if c != "n_cells"]  # targets = target label columns
    if ax is None:                                        # standalone figure if none supplied
        fig, ax = plt.subplots(figsize=(6.5, 4))
    else:
        fig = ax.figure                                   # fig = parent figure
    for t in targets:                                     # t = one target population
        ax.plot(x, profile[t].values, marker="o", ms=3, lw=1.8, label=t)  # profile curve
    ax.axvline(0, color="k", ls="--", lw=1)               # margin at signed distance 0
    if margin_width:                                      # shade the margin band if provided
        ax.axvspan(-margin_width, margin_width, color="0.85", alpha=0.5, zorder=0)
    ax.text(0.02, 0.95, "core", transform=ax.transAxes, ha="left", va="top", fontsize=8, color="#c1121f")
    ax.text(0.98, 0.95, "stroma", transform=ax.transAxes, ha="right", va="top", fontsize=8, color="#457b9d")
    ax.set_xlabel("signed distance to margin  (<0 interior)", fontsize=9)
    ax.set_ylabel("target fraction of cells", fontsize=9)
    ax.legend(frameon=False, fontsize=8)
    if title:
        ax.set_title(title)
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# View 3 — signed-distance distributions per population
# --------------------------------------------------------------------------- #
def plot_distance_distributions(
    result,
    labels: np.ndarray,
    target_labels: Sequence,
    *,
    bins: int = 40,
    ax: Optional[Axes] = None,
    title: Optional[str] = "Signed-distance distributions",
):
    """Overlaid histograms of signed distance for chosen populations.

    BIOLOGICAL CONTEXT
        Separates infiltrating (mass left of 0) from excluded (mass right of 0)
        populations directly, without binning into a profile.
    COMPUTATIONAL APPROACH
        Step histogram of each target's signed distances on a shared range, with a
        reference line at the margin.

    Returns matplotlib Axes.
    """
    labels = np.asarray(labels)                           # labels = cell types
    sd = np.asarray(result.signed_distance)               # sd = signed distances
    finite = np.isfinite(sd)                              # finite = defined distances
    lo, hi = np.percentile(sd[finite], [1, 99])           # lo/hi = robust plotting range
    edges = np.linspace(lo, hi, bins + 1)                 # edges = shared histogram bins
    if ax is None:                                        # standalone figure if none supplied
        fig, ax = plt.subplots(figsize=(6.5, 4))
    else:
        fig = ax.figure                                   # fig = parent figure
    for t in target_labels:                               # t = one target population
        d = sd[(labels == t) & finite]                    # d = that population's signed distances
        ax.hist(d, bins=edges, histtype="step", lw=2, density=True, label=t)  # normalized step hist
    ax.axvline(0, color="k", ls="--", lw=1)               # margin reference
    ax.set_xlabel("signed distance to margin  (<0 interior)", fontsize=9)
    ax.set_ylabel("density", fontsize=9)
    ax.legend(frameon=False, fontsize=8)
    if title:
        ax.set_title(title)
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# Summary + demo
# --------------------------------------------------------------------------- #
def plot_summary(result, coords, labels, target_labels, *, figsize=(16, 4.5)) -> Figure:
    """Region QC + infiltration profile + distance distributions in one figure."""
    from boundary_compute import infiltration_profile     # compute the profile for the middle panel
    fig, axes = plt.subplots(1, 3, figsize=figsize)       # fig/axes = three-panel row
    plot_region_mask(result, coords, labels, ax=axes[0])  # left: derived region
    prof = infiltration_profile(result.signed_distance, labels, target_labels, bins=16)
    plot_infiltration_profile(prof, margin_width=result.margin_width, ax=axes[1])  # middle: profile
    plot_distance_distributions(result, labels, target_labels, ax=axes[2])  # right: distributions
    fig.tight_layout()
    return fig


def _demo(outfile: str = "boundary_demo.png"):
    """Derive the region on synthetic tissue and render all three views."""
    from boundary_compute import region_boundary, make_synthetic_infiltration

    coords, labels = make_synthetic_infiltration()        # synthetic tissue (infiltrated + excluded)
    res = region_boundary(coords, labels, ["Tumor"], method="mask",
                          min_area=20.0, threshold=0.25)
    fig = plot_summary(res, coords, labels, ["T_infil", "T_excl"])  # combined figure
    fig.suptitle("Infiltration analysis — synthetic tumor (T_infil infiltrates, T_excl excluded)",
                 y=1.03)
    fig.savefig(outfile, dpi=130, bbox_inches="tight")    # write to disk
    print(f"wrote {outfile}")


if __name__ == "__main__":
    _demo()
