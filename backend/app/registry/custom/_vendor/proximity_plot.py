"""
proximity_plot.py
=================

VISUALIZATION for the nearest-neighbor proximity test. Reads a
``ProximityResult`` from ``proximity_compute.py``; performs no computation.

BIOLOGICAL CONTEXT
    Two readouts: a matrix of proximity/avoidance z-scores across all cell-type
    pairs (the overview), and the observed vs. null distance distribution for a
    chosen pair (the detail behind one cell of the matrix).

COMPUTATIONAL APPROACH
    Thin matplotlib wrappers (diverging heatmap with significance marks; histogram
    of A->nearest-B distances with the null mean overlaid).
"""

from __future__ import annotations

from typing import Optional, Tuple

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.axes import Axes
from matplotlib.figure import Figure


# --------------------------------------------------------------------------- #
# View 1 — proximity/avoidance heatmap
# --------------------------------------------------------------------------- #
def plot_proximity_heatmap(
    result,
    *,
    alpha: float = 0.05,
    vmax: Optional[float] = None,
    cap: float = 25.0,
    ax: Optional[Axes] = None,
    title: Optional[str] = "Cell-type proximity (nearest-neighbor)",
):
    """Heatmap of proximity z-scores for every ordered cell-type pair.

    BIOLOGICAL CONTEXT
        Row A, column B reads "A cells relative to B cells": blue (negative z) =
        closer than chance (attraction/interaction), red (positive z) = farther
        (avoidance/exclusion). A dot marks pairs significant at `alpha`.
    COMPUTATIONAL APPROACH
        `imshow` of the z-score matrix on a diverging map (RdBu_r, so negative =
        blue) centered at 0 with a symmetric range; overlay a marker where the
        empirical p-value < alpha. Perfectly separated types yield near-infinite
        z (tiny null variance), so the color scale is capped by default at `cap`
        to keep moderate effects legible — significance is still shown by the dots.

    Returns matplotlib Axes.
    """
    cats = result.categories                              # cats = cell-type names (axes)
    Z = np.asarray(result.zscore, dtype=float)            # Z = (T, T) z-score matrix
    P = np.asarray(result.pvalue, dtype=float)            # P = (T, T) p-value matrix
    finite = Z[np.isfinite(Z)]                            # finite = defined z-scores
    raw_limit = float(np.max(np.abs(finite)) or 1.0)      # raw_limit = largest |z| present
    # limit = symmetric color bound; cap runaway values from perfect separation
    limit = vmax if vmax is not None else min(raw_limit, cap)
    clipped = vmax is None and raw_limit > cap            # clipped = whether the scale was capped

    if ax is None:                                        # standalone figure if none supplied
        fig, ax = plt.subplots(figsize=(0.7 * len(cats) + 2, 0.7 * len(cats) + 2))
    else:
        fig = ax.figure                                   # fig = parent figure
    # RdBu_r: negative z -> blue (closer), positive z -> red (farther)
    im = ax.imshow(Z, cmap="RdBu_r", vmin=-limit, vmax=limit)  # im = the heatmap image
    ax.set_xticks(np.arange(len(cats)))                   # x ticks = target types (B)
    ax.set_xticklabels(cats, rotation=45, ha="right", fontsize=9)
    ax.set_yticks(np.arange(len(cats)))                   # y ticks = source types (A)
    ax.set_yticklabels(cats, fontsize=9)
    ax.set_xlabel("nearest neighbor type (B)", fontsize=9)
    ax.set_ylabel("from cell type (A)", fontsize=9)
    for i in range(len(cats)):                            # i = source index
        for j in range(len(cats)):                        # j = target index
            if np.isfinite(P[i, j]) and P[i, j] < alpha:  # mark significant pairs
                ax.text(j, i, "•", ha="center", va="center", fontsize=14, color="k")
    cbar = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)  # cbar = z-score color scale
    cbar_label = "z-score  (blue = closer, red = farther)"    # cbar_label = color legend text
    if clipped:                                              # note when extreme values were capped
        cbar_label += f"\ncolor capped at ±{limit:.0f} (max |z| = {raw_limit:.0f})"
    cbar.set_label(cbar_label, fontsize=8)
    if title:
        ax.set_title(f"{title}\n•  = p < {alpha}", fontsize=10)
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# View 2 — distance distribution for one pair
# --------------------------------------------------------------------------- #
def plot_pair_distance(
    result,
    pair: Tuple[str, str],
    *,
    ax: Optional[Axes] = None,
    title: Optional[str] = None,
):
    """Histogram of A->nearest-B distances with the permutation-null mean overlaid.

    BIOLOGICAL CONTEXT
        The evidence behind a single matrix cell: how far A cells actually are from
        their nearest B cell, versus what random labeling would give. A distribution
        shifted left of the null mean is attraction.
    COMPUTATIONAL APPROACH
        Histogram the stored observed distances for the pair; draw the null-mean
        statistic as a reference line.

    Returns matplotlib Axes.
    """
    a, b = pair                                           # a, b = source and target types
    d = np.asarray(result.distances[(a, b)])              # d = observed A->nearest-B distances
    i = result.categories.index(a)                        # i = row index of A
    j = result.categories.index(b)                        # j = column index of B
    null_mu = result.null_mean[i, j]                      # null_mu = expected statistic under null
    obs = result.observed[i, j]                           # obs = observed statistic

    if ax is None:                                        # standalone figure if none supplied
        fig, ax = plt.subplots(figsize=(5.5, 4))
    else:
        fig = ax.figure                                   # fig = parent figure
    ax.hist(d, bins=40, color="0.6", alpha=0.8)           # histogram of observed distances
    ax.axvline(obs, color="steelblue", lw=2, label=f"observed {result.params['stat']} = {obs:.2f}")
    ax.axvline(null_mu, color="crimson", lw=2, ls="--", label=f"null mean = {null_mu:.2f}")
    ax.set_xlabel(f"distance from {a} to nearest {b}", fontsize=9)
    ax.set_ylabel("number of cells", fontsize=9)
    ax.legend(frameon=False, fontsize=8)
    ax.set_title(title or f"{a} -> {b} proximity")
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# Summary + demo
# --------------------------------------------------------------------------- #
def plot_summary(result, pair: Optional[Tuple[str, str]] = None,
                 *, figsize: tuple = (12, 5)) -> Figure:
    """Heatmap + one pair's distance distribution."""
    fig, axes = plt.subplots(1, 2, figsize=figsize)       # fig/axes = two-panel figure
    plot_proximity_heatmap(result, ax=axes[0])            # left: z-score heatmap
    if pair is None:                                      # default to the first available pair
        pair = next(iter(result.distances.keys()))        # pair = first stored (A, B)
    plot_pair_distance(result, pair, ax=axes[1])          # right: distance distribution
    fig.tight_layout()
    return fig


def _demo(outfile: str = "proximity_demo.png"):
    """Compute proximity on synthetic tissue and render both views."""
    from proximity_compute import proximity_test, make_synthetic_spatial  # compute-side imports

    coords, labels = make_synthetic_spatial()             # synthetic tissue (A-B close, C far)
    res = proximity_test(coords, labels, n_perm=200, random_state=0)  # run the test
    fig = plot_summary(res, pair=("A", "B"))              # fig = combined figure
    fig.suptitle("Nearest-neighbor proximity — synthetic tissue", y=1.02)
    fig.savefig(outfile, dpi=130, bbox_inches="tight")    # write to disk
    print(f"wrote {outfile}")


if __name__ == "__main__":
    _demo()
