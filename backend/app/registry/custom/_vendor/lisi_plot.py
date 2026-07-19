"""
lisi_plot.py
============

VISUALIZATION for LISI results. Reads a ``LISIResult`` from ``lisi_compute.py``;
performs no computation.

BIOLOGICAL CONTEXT
    Two readouts: the distribution of per-cell scores (how mixing/separation vary
    across the dataset, not just the median), and the embedding colored by LISI
    (WHERE mixing succeeds or fails).

COMPUTATIONAL APPROACH
    Thin matplotlib wrappers (violin + jittered points; scatter colored by score).
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.axes import Axes
from matplotlib.figure import Figure


# --------------------------------------------------------------------------- #
# View 1 — score distributions
# --------------------------------------------------------------------------- #
def plot_lisi_distributions(
    result,
    *,
    ax: Optional[Axes] = None,
    title: Optional[str] = "LISI score distributions",
):
    """Violin + jitter of per-cell LISI, one violin per metric (iLISI / cLISI).

    BIOLOGICAL CONTEXT
        The spread matters: a good integration has iLISI concentrated near the
        batch count and cLISI concentrated near 1. Bimodality flags regions that
        integrated well and regions that did not.
    COMPUTATIONAL APPROACH
        A matplotlib violin per metric with reference lines at the ideal values
        (n_categories for iLISI, 1 for cLISI).

    Returns matplotlib Axes.
    """
    metrics = list(result.scores.keys())                 # metrics = e.g. ["iLISI", "cLISI"]
    data = [result.scores[m] for m in metrics]           # data = per-cell score arrays

    if ax is None:                                        # standalone figure if none supplied
        fig, ax = plt.subplots(figsize=(1.6 * len(metrics) + 2, 4))
    else:
        fig = ax.figure                                   # fig = parent figure
    parts = ax.violinplot(data, showextrema=False)        # parts = violin bodies
    for b in parts["bodies"]:                             # b = one violin body
        b.set_alpha(0.5)                                  # translucent fill
    rng = np.random.default_rng(0)                        # rng = jitter RNG
    for i, s in enumerate(data):                          # i = metric index, s = its scores
        xj = i + 1 + (rng.random(min(len(s), 400)) - 0.5) * 0.25  # xj = jittered x for a subsample
        sub = rng.choice(s, size=min(len(s), 400), replace=False)  # sub = plotted subsample
        ax.scatter(xj, sub, s=4, c="0.25", alpha=0.3)     # overlay individual cells
    for i, m in enumerate(metrics):                       # draw ideal reference lines
        ideal = result.n_categories[m] if m == "iLISI" else 1  # ideal = target value for this metric
        ax.hlines(ideal, i + 0.7, i + 1.3, color="crimson", lw=1.5,
                  label="ideal" if i == 0 else None)      # ideal marker
    ax.set_xticks(np.arange(1, len(metrics) + 1))         # x ticks at each metric
    ax.set_xticklabels(metrics, fontsize=10)
    ax.set_ylabel("LISI (effective # categories)", fontsize=9)
    ax.legend(frameon=False, fontsize=8)
    if title:
        ax.set_title(title)
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# View 2 — embedding colored by LISI
# --------------------------------------------------------------------------- #
def plot_lisi_embedding(
    result,
    embedding: np.ndarray,
    *,
    metric: str = "iLISI",
    ax: Optional[Axes] = None,
    title: Optional[str] = None,
):
    """Scatter the embedding, coloring each cell by its LISI score.

    BIOLOGICAL CONTEXT
        Localizes integration quality: for iLISI, blue islands are poorly mixed
        regions (likely residual batch effect); for cLISI, hot spots are where
        cell types are blending.
    COMPUTATIONAL APPROACH
        2-D scatter of the first two embedding dimensions colored by the chosen
        per-cell score.

    Returns matplotlib Axes.
    """
    emb = np.asarray(embedding, dtype=float)              # emb = embedding coordinates
    s = result.scores[metric]                             # s = per-cell score for the chosen metric
    if ax is None:                                        # standalone figure if none supplied
        fig, ax = plt.subplots(figsize=(5.5, 4.5))
    else:
        fig = ax.figure                                   # fig = parent figure
    sc = ax.scatter(emb[:, 0], emb[:, 1], c=s, s=6, cmap="viridis")  # sc = colored scatter
    ax.set_xticks([]); ax.set_yticks([])                  # coordinates are arbitrary
    cbar = fig.colorbar(sc, ax=ax, fraction=0.046, pad=0.04)  # cbar = LISI color scale
    cbar.set_label(metric, fontsize=9)
    ax.set_title(title or f"Embedding colored by {metric}")
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# Summary + demo
# --------------------------------------------------------------------------- #
def plot_summary(result, embedding: Optional[np.ndarray] = None,
                 *, figsize: tuple = (12, 5)) -> Figure:
    """Distributions (+ embedding colored by the first metric, if given)."""
    n_panels = 2 if embedding is not None else 1          # n_panels = subplots to draw
    fig, axes = plt.subplots(1, n_panels, figsize=figsize)  # fig/axes = panel row
    axes = np.atleast_1d(axes)                            # ensure indexable
    plot_lisi_distributions(result, ax=axes[0])           # left: distributions
    if embedding is not None:                             # right: embedding colored by first metric
        first_metric = list(result.scores.keys())[0]      # first_metric = e.g. "iLISI"
        plot_lisi_embedding(result, embedding, metric=first_metric, ax=axes[1])
    fig.tight_layout()
    return fig


def _demo(outfile: str = "lisi_demo.png"):
    """Compute LISI on the well-mixed synthetic embedding and render both views."""
    from lisi_compute import lisi_scores, make_synthetic_integration  # compute-side imports

    emb_mixed, _, batch, cell_type = make_synthetic_integration()      # well-mixed embedding
    res = lisi_scores(emb_mixed, batch=batch, label=cell_type, perplexity=30)
    fig = plot_summary(res, embedding=emb_mixed)          # fig = combined figure
    fig.suptitle("LISI — well-mixed synthetic integration", y=1.02)
    fig.savefig(outfile, dpi=130, bbox_inches="tight")    # write to disk
    print(f"wrote {outfile}")


if __name__ == "__main__":
    _demo()
