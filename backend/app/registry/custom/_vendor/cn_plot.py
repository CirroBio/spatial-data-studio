"""
cn_plot.py
==========

VISUALIZATION half of the cellular-neighborhood (CN) analysis. Every function
here only *reads* the outputs produced by ``cn_compute.py`` and draws a figure;
none of them compute neighborhoods. Depends on matplotlib + numpy/pandas (and
scipy only for optional dendrogram ordering), so it stays lightweight.

------------------------------------------------------------------------------
BIOLOGICAL CONTEXT
------------------------------------------------------------------------------
Numbers from the compute step become interpretable only when you can see them
against the tissue. Four complementary views are standard in CN papers:

  * Neighborhood map    — WHERE each niche sits in physical space. This is the
                          payoff plot: it shows tissue architecture (tumor core,
                          invasive margin, immune aggregates, stroma).
  * Enrichment heatmap  — WHAT defines each niche, corrected for globally common
                          cell types. This is how you *name* CNs.
  * Composition bars    — the raw make-up of each niche (proportions that sum to 1).
  * Abundance bars      — HOW MUCH of the tissue each niche occupies, optionally
                          split by sample/condition for comparisons.

------------------------------------------------------------------------------
COMPUTATIONAL APPROACH
------------------------------------------------------------------------------
Thin matplotlib wrappers. Shared, stable color palettes keep a given CN (and a
given cell type) the same color across every panel, which is essential for
reading the figures together. Functions accept an optional ``ax`` so they compose
into multi-panel figures, and return the Axes/Figure they drew on.
"""

from __future__ import annotations

from typing import Optional, Sequence

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.axes import Axes
from matplotlib.colors import to_hex
from matplotlib.figure import Figure

# CNResult is imported for type hints / the summary helper; plotting itself is
# duck-typed and works on plain arrays and DataFrames too.
try:
    from cn_compute import CNResult
except Exception:  # pragma: no cover - keep module importable in isolation
    CNResult = object  # type: ignore


# --------------------------------------------------------------------------- #
# Palette helpers — one color per category, stable across all panels
# --------------------------------------------------------------------------- #
def make_palette(keys: Sequence, cmap: str = "tab20") -> dict:
    """Map an ordered list of category names to fixed, distinct colors.

    BIOLOGICAL CONTEXT
        A reader tracks a niche or a cell type by its color across the map, the
        heatmap, and the bar charts. That only works if the color assignment is
        computed once and shared, which is what this returns.

    COMPUTATIONAL APPROACH
        Sample evenly spaced colors from a qualitative matplotlib colormap and
        pair them with the keys in order.

    Parameters
    ----------
    keys  ordered category names (e.g. CN ids or cell-type names).
    cmap  qualitative matplotlib colormap name.

    Returns
    -------
    dict  {key: hex_color}.
    """
    keys = list(keys)                                      # keys = category names as a concrete list
    n = max(len(keys), 1)                                  # n = number of colors needed (>=1)
    cmap_obj = plt.get_cmap(cmap)                          # cmap_obj = matplotlib colormap callable
    # positions = evenly spaced sample points in [0, 1) across the colormap
    positions = (np.arange(n) % cmap_obj.N) / max(cmap_obj.N - 1, 1) \
        if getattr(cmap_obj, "N", 256) < 64 else np.linspace(0, 1, n, endpoint=False)
    colors = [to_hex(cmap_obj(p)) for p in positions]     # colors = hex string per category
    return {k: colors[i] for i, k in enumerate(keys)}     # ordered key -> color mapping


def _cn_key_order(labels: np.ndarray) -> list:
    """Return CN keys as 'CN{id}' strings in ascending id order."""
    ids = np.unique(np.asarray(labels))                   # ids = sorted distinct CN ids
    return [f"CN{i}" for i in ids]                         # formatted keys "CN0", "CN1", ...


# --------------------------------------------------------------------------- #
# View 1 — spatial neighborhood map
# --------------------------------------------------------------------------- #
def plot_neighborhood_map(
    coords: np.ndarray,
    labels: np.ndarray,
    *,
    batch: Optional[np.ndarray] = None,
    palette: Optional[dict] = None,
    point_size: float = 6.0,
    ax: Optional[Axes] = None,
    ncols: int = 3,
    title: Optional[str] = "Cellular neighborhoods in situ",
):
    """Scatter each cell at its spatial position, colored by its neighborhood.

    BIOLOGICAL CONTEXT
        This is the tissue-architecture view: recurring niches appear as coherent
        colored territories (a tumor core, an immune rim, stromal bands). Faceting
        by `batch` puts each slide/core in its own panel so you can compare
        architecture across samples or conditions.

    COMPUTATIONAL APPROACH
        A matplotlib scatter of (x, y) with a discrete color per CN using the
        shared palette. If `batch` is given, draw one subplot per sample on a
        shared color scheme and a shared, equal-aspect coordinate frame.

    Parameters
    ----------
    coords      (n_cells, 2) spatial coordinates.
    labels      (n_cells,) CN id per cell (ints) or 'CN{id}' strings.
    batch       optional (n_cells,) sample ids for faceting.
    palette     optional {CN_key: color}; built if omitted.
    point_size  marker size in points^2.
    ax          existing Axes to draw on (single-panel only); created if omitted.
    ncols       columns in the facet grid when `batch` is given.
    title       figure suptitle / axis title.

    Returns
    -------
    matplotlib Figure.
    """
    coords = np.asarray(coords)                            # coords = (n_cells, 2) positions
    labels = np.asarray(labels)                            # labels = (n_cells,) CN id/string per cell
    # cn_keys = normalized 'CN{id}' string per cell (accept ints or strings)
    cn_keys = np.array(
        [lab if isinstance(lab, str) else f"CN{lab}" for lab in labels]
    )
    key_order = sorted(set(cn_keys), key=lambda s: int(s[2:]))  # key_order = CN keys sorted by numeric id
    palette = palette or make_palette(key_order)          # palette = CN -> color (built if not supplied)

    # ---- faceted layout: one subplot per sample ----
    if batch is not None:
        batch = np.asarray(batch)                         # batch = (n_cells,) sample id per cell
        samples = list(pd.unique(batch))                  # samples = ordered unique sample ids
        n_s = len(samples)                                # n_s = number of samples/panels
        nrows = int(np.ceil(n_s / ncols))                 # nrows = grid rows needed
        fig, axes = plt.subplots(                         # fig/axes = facet grid
            nrows, ncols, figsize=(4.2 * ncols, 4.0 * nrows), squeeze=False
        )
        for i, s in enumerate(samples):                   # i = panel index, s = sample id
            a = axes[i // ncols][i % ncols]               # a = the Axes for this sample
            m = batch == s                                # m = boolean mask of cells in sample s
            for key in key_order:                         # draw one CN at a time for a clean legend
                sel = m & (cn_keys == key)                # sel = cells in sample s AND neighborhood `key`
                a.scatter(
                    coords[sel, 0], coords[sel, 1],       # x, y of selected cells
                    s=point_size, c=palette[key], label=key, linewidths=0,
                )
            a.set_title(str(s), fontsize=10)              # panel title = sample id
            a.set_aspect("equal")                         # equal aspect so tissue isn't distorted
            a.invert_yaxis()                              # image convention: y increases downward
            a.set_xticks([]); a.set_yticks([])            # strip ticks (coordinates are arbitrary units)
        for j in range(n_s, nrows * ncols):               # j = index of any leftover empty panels
            axes[j // ncols][j % ncols].axis("off")       # hide unused grid cells
        handles = [                                       # handles = legend proxies, one per CN
            plt.Line2D([0], [0], marker="o", linestyle="", markersize=6,
                       markerfacecolor=palette[k], markeredgecolor="none", label=k)
            for k in key_order
        ]
        fig.legend(handles=handles, loc="center right", frameon=False, title="Neighborhood")
        if title:
            fig.suptitle(title)                           # overall figure title
        fig.tight_layout(rect=(0, 0, 0.9, 1))            # leave right margin for the legend
        return fig

    # ---- single-panel layout ----
    if ax is None:                                        # create a standalone figure if none provided
        fig, ax = plt.subplots(figsize=(6, 6))           # fig/ax = new single panel
    else:
        fig = ax.figure                                   # fig = parent figure of the supplied Axes
    for key in key_order:                                 # plot each neighborhood separately for the legend
        sel = cn_keys == key                             # sel = mask of cells in neighborhood `key`
        ax.scatter(
            coords[sel, 0], coords[sel, 1],              # x, y of those cells
            s=point_size, c=palette[key], label=key, linewidths=0,
        )
    ax.set_aspect("equal")                                # undistorted tissue geometry
    ax.invert_yaxis()                                     # image-style y axis
    ax.set_xticks([]); ax.set_yticks([])                 # remove arbitrary-unit ticks
    if title:
        ax.set_title(title)                               # axis title
    ax.legend(                                            # legend outside the plot area
        markerscale=2, frameon=False, title="Neighborhood",
        bbox_to_anchor=(1.02, 1), loc="upper left",
    )
    fig.tight_layout()
    return fig


# --------------------------------------------------------------------------- #
# View 2 — enrichment heatmap
# --------------------------------------------------------------------------- #
def plot_enrichment_heatmap(
    enrichment: pd.DataFrame,
    *,
    cluster: bool = True,
    cmap: str = "RdBu_r",
    vmax: Optional[float] = None,
    ax: Optional[Axes] = None,
    title: Optional[str] = "CN x cell-type enrichment (log2)",
):
    """Heatmap of log2 fold-enrichment of each cell type within each CN.

    BIOLOGICAL CONTEXT
        The interpretive core of CN analysis. Red cells mark cell types that are
        over-represented in a neighborhood relative to the whole tissue, blue
        marks depletion. Reading a row tells you the identity of that niche (e.g.
        "high CD8T + Macrophage, low Tumor -> immune infiltrate").

    COMPUTATIONAL APPROACH
        `imshow` of the enrichment matrix on a diverging colormap centered at 0
        with a symmetric range so red/blue are comparable. Optional hierarchical
        (Ward) clustering reorders rows and columns to put similar niches / cell
        types together.

    Parameters
    ----------
    enrichment  (n_cn x n_types) DataFrame of log2 enrichments (CNResult.enrichment).
    cluster     reorder rows & columns by hierarchical clustering.
    cmap        diverging matplotlib colormap.
    vmax        symmetric color limit; inferred from the data if None.
    ax          Axes to draw on; created if omitted.
    title       axis title.

    Returns
    -------
    matplotlib Axes.
    """
    mat = enrichment.copy()                               # mat = working copy of the enrichment table
    row_labels = list(mat.index)                          # row_labels = CN names
    col_labels = list(mat.columns)                        # col_labels = cell-type names

    if cluster and mat.shape[0] > 2 and mat.shape[1] > 2:
        from scipy.cluster.hierarchy import leaves_list, linkage  # lazy import; only if clustering
        row_link = linkage(mat.values, method="ward")     # row_link = linkage over CNs (rows)
        col_link = linkage(mat.values.T, method="ward")   # col_link = linkage over cell types (columns)
        row_ord = leaves_list(row_link)                   # row_ord = dendrogram row ordering
        col_ord = leaves_list(col_link)                   # col_ord = dendrogram column ordering
        mat = mat.iloc[row_ord, col_ord]                  # reorder matrix by both dendrograms
        row_labels = list(mat.index)                      # refresh labels after reorder
        col_labels = list(mat.columns)

    data = mat.values                                     # data = 2-D float array to render
    limit = vmax if vmax is not None else float(np.nanmax(np.abs(data)))  # limit = symmetric color bound
    limit = limit or 1.0                                  # guard against all-zero matrices

    if ax is None:                                        # standalone figure if no Axes passed
        fig, ax = plt.subplots(
            figsize=(0.6 * len(col_labels) + 2, 0.5 * len(row_labels) + 2)
        )
    else:
        fig = ax.figure                                   # fig = parent of provided Axes
    im = ax.imshow(data, cmap=cmap, vmin=-limit, vmax=limit, aspect="auto")  # im = the heatmap image
    ax.set_xticks(np.arange(len(col_labels)))            # x ticks at each cell-type column
    ax.set_xticklabels(col_labels, rotation=45, ha="right", fontsize=9)
    ax.set_yticks(np.arange(len(row_labels)))            # y ticks at each CN row
    ax.set_yticklabels(row_labels, fontsize=9)
    for i in range(data.shape[0]):                       # i = row index (CN)
        for j in range(data.shape[1]):                   # j = column index (cell type)
            val = data[i, j]                             # val = enrichment value in this cell
            ax.text(                                     # annotate each cell with its value
                j, i, f"{val:.1f}", ha="center", va="center", fontsize=7,
                color="white" if abs(val) > 0.6 * limit else "black",  # contrast vs. cell color
            )
    cbar = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)  # cbar = the color scale bar
    cbar.set_label("log2(fold enrichment)", fontsize=9)
    if title:
        ax.set_title(title)
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# View 3 — stacked composition bars
# --------------------------------------------------------------------------- #
def plot_composition_bars(
    mean_composition: pd.DataFrame,
    *,
    palette: Optional[dict] = None,
    ax: Optional[Axes] = None,
    title: Optional[str] = "Mean cell-type composition per neighborhood",
):
    """Horizontal stacked bars of each niche's mean cell-type proportions.

    BIOLOGICAL CONTEXT
        Shows the literal make-up of each niche (segments sum to 100%).
        Complements the enrichment heatmap: enrichment says what is *distinctive*,
        this says what is actually *there*, including abundant background types.

    COMPUTATIONAL APPROACH
        Cumulative horizontal bar chart: for each CN, lay cell-type proportions
        end to end using the shared cell-type palette so colors match other panels.

    Parameters
    ----------
    mean_composition  (n_cn x n_types) proportions (CNResult.mean_composition).
    palette           optional {cell_type: color}; built if omitted.
    ax                Axes to draw on; created if omitted.
    title             axis title.

    Returns
    -------
    matplotlib Axes.
    """
    df = mean_composition                                 # df = per-CN mean composition table
    cn_names = list(df.index)                             # cn_names = neighborhood row labels
    types = list(df.columns)                              # types = cell-type column labels
    palette = palette or make_palette(types)             # palette = cell type -> color

    if ax is None:                                        # standalone figure if no Axes passed
        fig, ax = plt.subplots(figsize=(7, 0.5 * len(cn_names) + 1.5))
    else:
        fig = ax.figure                                   # fig = parent of provided Axes
    y = np.arange(len(cn_names))                          # y = vertical position of each CN bar
    left = np.zeros(len(cn_names))                        # left = running left edge for stacking segments
    for t in types:                                       # t = one cell type (a stacked segment)
        widths = df[t].values                            # widths = proportion of type t in each CN
        ax.barh(
            y, widths, left=left, color=palette[t], label=t, edgecolor="white", height=0.8
        )
        left = left + widths                             # advance left edge by this segment's width
    ax.set_yticks(y)                                      # y ticks at each CN
    ax.set_yticklabels(cn_names, fontsize=9)
    ax.set_xlim(0, 1)                                     # proportions span 0..1
    ax.set_xlabel("Proportion of cells in window", fontsize=9)
    ax.invert_yaxis()                                     # first CN at the top
    ax.legend(                                            # cell-type legend outside the plot
        frameon=False, bbox_to_anchor=(1.02, 1), loc="upper left", title="Cell type", fontsize=8
    )
    if title:
        ax.set_title(title)
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# View 4 — neighborhood abundance
# --------------------------------------------------------------------------- #
def plot_neighborhood_abundance(
    labels: np.ndarray,
    *,
    batch: Optional[np.ndarray] = None,
    normalize: bool = False,
    palette: Optional[dict] = None,
    ax: Optional[Axes] = None,
    title: Optional[str] = "Neighborhood abundance",
):
    """Bar chart of how many cells fall in each neighborhood.

    BIOLOGICAL CONTEXT
        Quantifies how much of the tissue each niche occupies. Split by `batch`
        and normalized, this is the basis for comparing niche prevalence across
        conditions (e.g. responder vs. non-responder) — often the statistical
        endpoint of a CN study.

    COMPUTATIONAL APPROACH
        Count cells per CN (optionally per sample), optionally convert counts to
        within-sample fractions, and draw grouped bars with the shared CN palette.

    Parameters
    ----------
    labels     (n_cells,) CN id/string per cell.
    batch      optional (n_cells,) sample ids for grouped bars.
    normalize  express as fraction of each sample instead of raw counts.
    palette    optional {CN_key: color}; built if omitted.
    ax         Axes to draw on; created if omitted.
    title      axis title.

    Returns
    -------
    matplotlib Axes.
    """
    labels = np.asarray(labels)                           # labels = (n_cells,) CN id/string per cell
    cn_keys = np.array(                                   # cn_keys = normalized 'CN{id}' per cell
        [lab if isinstance(lab, str) else f"CN{lab}" for lab in labels]
    )
    key_order = sorted(set(cn_keys), key=lambda s: int(s[2:]))  # key_order = CN keys by numeric id
    palette = palette or make_palette(key_order)         # palette = CN -> color

    if ax is None:                                        # standalone figure if none supplied
        fig, ax = plt.subplots(figsize=(1.0 * len(key_order) + 2, 4))
    else:
        fig = ax.figure                                   # fig = parent figure

    if batch is None:                                     # ---- single-sample: one bar per CN ----
        counts = np.array([np.sum(cn_keys == k) for k in key_order], dtype=float)
        # counts = number of cells in each CN
        if normalize:
            counts = counts / counts.sum()               # convert to overall fractions
        ax.bar(
            np.arange(len(key_order)), counts,           # x positions, bar heights
            color=[palette[k] for k in key_order],
        )
        ax.set_xticks(np.arange(len(key_order)))         # x ticks at each CN
        ax.set_xticklabels(key_order, rotation=0, fontsize=9)
    else:                                                 # ---- multi-sample: grouped bars ----
        batch = np.asarray(batch)                        # batch = sample id per cell
        samples = list(pd.unique(batch))                 # samples = ordered unique sample ids
        n_s = len(samples)                               # n_s = number of samples
        width = 0.8 / n_s                                # width = per-sample bar width within a CN group
        x = np.arange(len(key_order))                    # x = base position of each CN group
        # hatches = per-sample fill patterns; bars stay CN-colored for cross-panel
        # consistency, so samples are told apart by hatch (and position), not color.
        hatches = ["", "///", "...", "xxx", "\\\\\\", "++", "oo"]
        for si, s in enumerate(samples):                 # si = sample index, s = sample id
            m = batch == s                               # m = mask of cells in sample s
            counts = np.array(                           # counts = cells per CN within sample s
                [np.sum(cn_keys[m] == k) for k in key_order], dtype=float
            )
            if normalize and counts.sum() > 0:
                counts = counts / counts.sum()           # counts -> fraction of this sample
            ax.bar(
                x + si * width - 0.4 + width / 2,        # offset each sample's bars within the group
                counts, width=width,
                color=[palette[k] for k in key_order],   # fill = CN color (matches other panels)
                hatch=hatches[si % len(hatches)],        # hatch = which sample
                edgecolor="white", linewidth=0.3,
            )
        ax.set_xticks(x)                                 # x ticks centered on CN groups
        ax.set_xticklabels(key_order, fontsize=9)
        # sample_handles = neutral gray swatches encoding hatch -> sample only
        sample_handles = [
            plt.Rectangle((0, 0), 1, 1, facecolor="0.8", edgecolor="0.4",
                          hatch=hatches[si % len(hatches)], label=str(s))
            for si, s in enumerate(samples)
        ]
        ax.legend(handles=sample_handles, frameon=False, fontsize=8, title="Sample")
    ax.set_ylabel("Fraction of cells" if normalize else "Cell count", fontsize=9)
    if title:
        ax.set_title(title)
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# Convenience — multi-panel dashboard from a CNResult
# --------------------------------------------------------------------------- #
def plot_summary(
    result,
    coords: Optional[np.ndarray] = None,
    *,
    batch: Optional[np.ndarray] = None,
    figsize: tuple = (15, 5),
) -> Figure:
    """One figure combining map (optional), enrichment heatmap, and composition.

    BIOLOGICAL CONTEXT
        A single at-a-glance panel answering the three questions a reviewer asks
        of a CN analysis: where are the niches, what defines them, and what are
        they made of.

    COMPUTATIONAL APPROACH
        Lay out subplots and delegate each to the single-view functions above,
        sharing one cell-type palette and one CN palette so colors are consistent.

    Parameters
    ----------
    result   a CNResult (has .labels, .enrichment, .mean_composition, .celltype_order).
    coords   optional (n_cells, 2) coordinates; if given, the spatial map is drawn.
    batch    optional (n_cells,) sample ids (only used for the map here).
    figsize  overall figure size.

    Returns
    -------
    matplotlib Figure.
    """
    # Shared palettes so the same CN / cell type has one color everywhere.
    cn_palette = make_palette(_cn_key_order(result.labels))          # cn_palette = CN -> color
    ct_palette = make_palette(list(result.celltype_order))          # ct_palette = cell type -> color

    n_panels = 3 if coords is not None else 2                        # n_panels = subplots to draw
    fig, axes = plt.subplots(1, n_panels, figsize=figsize)          # fig/axes = single row of panels
    axes = np.atleast_1d(axes)                                       # ensure indexable even if 1 panel
    idx = 0                                                          # idx = current panel cursor

    if coords is not None:                                           # panel: spatial map (if coords given)
        plot_neighborhood_map(
            coords, result.labels, batch=None, palette=cn_palette,
            ax=axes[idx], title="Neighborhood map",
        )
        idx += 1

    plot_enrichment_heatmap(                                         # panel: enrichment heatmap
        result.enrichment, ax=axes[idx], title="Enrichment (log2)"
    )
    idx += 1
    plot_composition_bars(                                           # panel: composition stacked bars
        result.mean_composition, palette=ct_palette, ax=axes[idx],
        title="Composition",
    )
    fig.tight_layout()
    return fig


# --------------------------------------------------------------------------- #
# Demo: compute on synthetic tissue, render every view to a PNG
# --------------------------------------------------------------------------- #
def _demo(outfile: str = "cn_plots_demo.png"):
    """Generate synthetic data, compute CNs, and save all four views."""
    from cn_compute import cellular_neighborhoods, make_synthetic_tissue  # compute-side imports

    coords, cell_types, _ = make_synthetic_tissue()                 # coords/cell_types = toy tissue
    result = cellular_neighborhoods(                                # result = CNResult
        coords, cell_types, n_neighs=20, n_neighborhoods=3, random_state=0
    )
    batch = np.repeat(["sampleA", "sampleB"], len(coords) // 2)     # batch = fake 2-sample split for demos

    cn_pal = make_palette(_cn_key_order(result.labels))            # cn_pal = shared CN palette
    ct_pal = make_palette(list(result.celltype_order))            # ct_pal = shared cell-type palette

    fig, axes = plt.subplots(2, 2, figsize=(14, 11))              # fig/axes = 2x2 panel grid
    plot_neighborhood_map(coords, result.labels, palette=cn_pal, ax=axes[0][0])
    plot_enrichment_heatmap(result.enrichment, ax=axes[0][1])
    plot_composition_bars(result.mean_composition, palette=ct_pal, ax=axes[1][0])
    plot_neighborhood_abundance(result.labels, batch=batch, normalize=True,
                                palette=cn_pal, ax=axes[1][1])
    fig.suptitle("Cellular neighborhood analysis — synthetic tissue", fontsize=13)
    fig.tight_layout(rect=(0, 0, 1, 0.98))
    fig.savefig(outfile, dpi=130)                                  # write figure to disk
    print(f"wrote {outfile}")


if __name__ == "__main__":
    _demo()
