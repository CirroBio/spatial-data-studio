"""
milo_da_plot.py
===============

VISUALIZATION for Milo-style differential-abundance results. Reads a
``MiloResult`` from ``milo_da_compute.py``; performs no computation.

BIOLOGICAL CONTEXT
    Two standard readouts of a DA analysis: the *beeswarm* (Milo's signature plot)
    shows the distribution of neighborhood log-fold-changes grouped by cell type,
    so you can see which identities shifted and in which direction; the *volcano*
    shows effect size against significance across all neighborhoods.

COMPUTATIONAL APPROACH
    Thin matplotlib wrappers. Significant neighborhoods (spatial FDR < alpha) are
    colored by signed logFC on a diverging map; non-significant ones are gray.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.axes import Axes
from matplotlib.figure import Figure


def _signed_colors(logFC, sig, cmap="RdBu_r", vmax=None):
    """Map logFC to diverging colors for significant points, gray otherwise."""
    logFC = np.asarray(logFC)                             # logFC = per-neighborhood effect sizes
    limit = vmax if vmax is not None else float(np.max(np.abs(logFC)) or 1.0)  # symmetric color bound
    cmap_obj = plt.get_cmap(cmap)                         # cmap_obj = diverging colormap
    norm = (logFC + limit) / (2 * limit)                  # norm = logFC scaled to [0, 1]
    colors = cmap_obj(np.clip(norm, 0, 1))                # colors = RGBA per neighborhood
    colors[~np.asarray(sig)] = (0.8, 0.8, 0.8, 1.0)       # gray-out non-significant neighborhoods
    return colors, limit


# --------------------------------------------------------------------------- #
# View 1 — beeswarm of logFC grouped by cell-type annotation
# --------------------------------------------------------------------------- #
def plot_da_beeswarm(
    result,
    *,
    alpha: float = 0.1,
    group_by_annotation: bool = True,
    ax: Optional[Axes] = None,
    title: Optional[str] = "Differential abundance by neighborhood",
):
    """Beeswarm: neighborhood logFC, grouped by majority cell type.

    BIOLOGICAL CONTEXT
        Each dot is a neighborhood; rows are cell types. A row shifted to the
        right/red means that identity gained abundance in the treatment condition,
        left/blue means it lost abundance. Reading the spread within a row shows
        whether the whole population moved or only part of it.
    COMPUTATIONAL APPROACH
        Group neighborhoods by `result.annotation` (or a single group if absent),
        jitter each group's points along the categorical axis, and color by signed
        logFC where spatial FDR < `alpha`, gray otherwise.

    Returns matplotlib Axes.
    """
    logFC = np.asarray(result.logFC)                      # logFC = effect size per neighborhood
    fdr = np.asarray(result.fdr)                          # fdr = spatial-FDR per neighborhood
    sig = fdr < alpha                                     # sig = significance mask
    if group_by_annotation and result.annotation is not None:
        groups = np.asarray(result.annotation)            # groups = majority cell type per neighborhood
    else:
        groups = np.full(logFC.shape[0], "all")           # single group fallback
    order = sorted(set(groups))                           # order = sorted group names (row order)
    colors, limit = _signed_colors(logFC, sig)            # colors = per-point colors; limit = color bound

    if ax is None:                                        # standalone figure if none supplied
        fig, ax = plt.subplots(figsize=(6, 0.5 * len(order) + 2))
    else:
        fig = ax.figure                                   # fig = parent figure
    rng = np.random.default_rng(0)                        # rng = jitter RNG (deterministic)
    for i, g in enumerate(order):                         # i = row index, g = group name
        m = groups == g                                   # m = neighborhoods in this group
        yj = i + (rng.random(m.sum()) - 0.5) * 0.6        # yj = jittered vertical positions
        ax.scatter(logFC[m], yj, c=colors[m], s=18, edgecolors="none")  # plot the group's points
    ax.axvline(0, color="k", lw=0.8, ls="--")             # reference line at logFC = 0
    ax.set_yticks(np.arange(len(order)))                  # y ticks at each group row
    ax.set_yticklabels(order, fontsize=9)
    ax.set_xlabel("log2 fold-change (condition vs. reference)", fontsize=9)
    sm = plt.cm.ScalarMappable(                           # sm = colorbar mapper for signed logFC
        cmap="RdBu_r", norm=plt.Normalize(-limit, limit)
    )
    cbar = fig.colorbar(sm, ax=ax, fraction=0.04, pad=0.02)  # cbar = logFC color scale
    cbar.set_label("logFC (significant only)", fontsize=8)
    if title:
        ax.set_title(f"{title}  (FDR < {alpha})")
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# View 2 — volcano
# --------------------------------------------------------------------------- #
def plot_da_volcano(
    result,
    *,
    alpha: float = 0.1,
    ax: Optional[Axes] = None,
    title: Optional[str] = "DA volcano",
):
    """Volcano: effect size vs. significance across neighborhoods.

    BIOLOGICAL CONTEXT
        A global view of how many neighborhoods changed and how strongly. Points
        top-left and top-right are the confidently depleted / enriched niches.
    COMPUTATIONAL APPROACH
        Scatter logFC (x) against -log10(spatial FDR) (y); mark the `alpha`
        threshold; color significant points by signed logFC.

    Returns matplotlib Axes.
    """
    logFC = np.asarray(result.logFC)                      # logFC = effect sizes
    fdr = np.asarray(result.fdr)                          # fdr = spatial-FDR values
    sig = fdr < alpha                                     # sig = significance mask
    y = -np.log10(np.clip(fdr, 1e-300, 1.0))              # y = -log10 FDR (significance axis)
    colors, limit = _signed_colors(logFC, sig)            # colors = per-point colors

    if ax is None:                                        # standalone figure if none supplied
        fig, ax = plt.subplots(figsize=(5.5, 4.5))
    else:
        fig = ax.figure                                   # fig = parent figure
    ax.scatter(logFC, y, c=colors, s=14, edgecolors="none")  # the volcano scatter
    ax.axhline(-np.log10(alpha), color="k", lw=0.8, ls="--")  # significance threshold line
    ax.axvline(0, color="0.6", lw=0.6)                    # zero-effect reference
    ax.set_xlabel("log2 fold-change", fontsize=9)
    ax.set_ylabel("-log10(spatial FDR)", fontsize=9)
    if title:
        ax.set_title(title)
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# Summary + demo
# --------------------------------------------------------------------------- #
def plot_summary(result, *, alpha: float = 0.1, figsize: tuple = (12, 5)) -> Figure:
    """Beeswarm + volcano side by side from a MiloResult."""
    fig, axes = plt.subplots(1, 2, figsize=figsize)       # fig/axes = two-panel figure
    plot_da_beeswarm(result, alpha=alpha, ax=axes[0])     # left: beeswarm
    plot_da_volcano(result, alpha=alpha, ax=axes[1])      # right: volcano
    fig.tight_layout()
    return fig


def _demo(outfile: str = "milo_da_demo.png"):
    """Compute DA on synthetic data with cell-type labels and render both views."""
    from milo_da_compute import milo, make_synthetic_da   # compute-side imports

    emb, sample, condition, pos = make_synthetic_da()      # synthetic trajectory + DA gradient
    # derive coarse cell-type labels from trajectory position, so the beeswarm has rows
    ct = np.where(pos < 0.33, "Progenitor",                # label by trajectory third
                  np.where(pos < 0.66, "Intermediate", "Mature"))
    res = milo(emb, sample, condition, cell_type=ct, k=30, prop=0.15, random_state=0)
    fig = plot_summary(res, alpha=0.1)                     # fig = combined figure
    fig.suptitle("Milo differential abundance — synthetic trajectory", y=1.02)
    fig.savefig(outfile, dpi=130, bbox_inches="tight")     # write to disk
    print(f"wrote {outfile}")


if __name__ == "__main__":
    _demo()
