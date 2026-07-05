"""
pb_plot.py
==========

VISUALIZATION for pseudobulk differential-expression results. Reads a
``DEResult`` from ``pb_compute.py``; performs no computation beyond a cheap
fallback normalization used only when the live PyDESeq2 fit (``result.dds``)
isn't available (e.g. after reloading serialized results from a checkpoint).

BIOLOGICAL CONTEXT
    Three standard readouts of a pseudobulk DE run: the *PCA* is the single
    most important QC -- pseudobulk samples should separate by condition, not
    by batch, or the DE call is untrustworthy regardless of what the gene-level
    tests say. The *MA plot* and *volcano* are the standard bulk-RNA-seq views
    of effect size vs. expression level and vs. significance. *Dispersion* and
    *per-gene count* plots are secondary QC/sanity checks.

COMPUTATIONAL APPROACH
    Thin matplotlib wrappers around a DEResult's `.results` table and (when
    present) its live `.dds` DeseqDataSet. When `.dds` is None (results were
    reconstructed from a serialized `.uns` entry rather than freshly computed),
    PCA and per-gene counts fall back to a log1p-CPM normalization of the
    persisted pseudobulk counts instead of DESeq2's VST/median-of-ratios --
    close enough for QC, without needing to refit DESeq2 just to plot.
"""

from __future__ import annotations

from typing import Optional, Sequence

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.axes import Axes
from matplotlib.figure import Figure


def _condition_colors(labels: Sequence) -> dict:
    """Stable color per distinct condition label (sorted, tab10)."""
    levels = sorted(set(labels))                          # levels = distinct condition values, deterministic order
    cmap = plt.get_cmap("tab10")
    return {level: cmap(i % 10) for i, level in enumerate(levels)}


def _log1p_cpm(counts) -> np.ndarray:
    """CPM + log1p fallback normalization when no live DeseqDataSet is available."""
    values = np.asarray(counts, dtype=float)
    lib = values.sum(axis=1)                               # lib = per-sample library size
    lib[lib == 0] = 1.0
    cpm = values / lib[:, None] * 1e6
    return np.log1p(cpm)


# --------------------------------------------------------------------------- #
# View 1 -- PCA of pseudobulk samples (the key QC)
# --------------------------------------------------------------------------- #
def plot_pca(
    result,
    *,
    ax: Optional[Axes] = None,
    title: Optional[str] = "Pseudobulk PCA",
):
    """PCA of the pseudobulk samples, colored by condition, shaped by batch.

    BIOLOGICAL CONTEXT
        Draw this first. Replicates should separate by condition, not by
        batch; if batch dominates PC1, the DE call downstream is suspect
        regardless of how clean the p-values look.
    COMPUTATIONAL APPROACH
        Uses `result.dds.vst()` (variance-stabilized values) when the live
        DeseqDataSet is available; otherwise falls back to log1p-CPM of
        `result.counts`. PCA via scikit-learn on the mean-centered matrix.

    Returns matplotlib Axes.
    """
    from sklearn.decomposition import PCA

    if getattr(result, "dds", None) is not None:
        dds = result.dds
        dds.vst()
        values = np.asarray(dds.layers["vst_counts"])      # values = (samples x genes) variance-stabilized
        metadata = dds.obs
    else:
        values = _log1p_cpm(result.counts)                 # fallback when no live DeseqDataSet
        metadata = result.metadata
    pcs = PCA(n_components=2).fit_transform(values - values.mean(axis=0))  # pcs = (samples x 2) PCA coordinates

    condition = metadata["condition"].astype(str).values
    colors = _condition_colors(condition)
    batch = metadata["batch"].astype(str).values if "batch" in metadata.columns else None
    markers = {b: m for b, m in zip(sorted(set(batch)), "os^Dv<>p") } if batch is not None else None

    if ax is None:
        fig, ax = plt.subplots(figsize=(5, 4.5))
    else:
        fig = ax.figure
    for level, color in colors.items():
        mask = condition == level
        if batch is not None:
            for b in sorted(set(batch[mask])):
                bmask = mask & (batch == b)
                ax.scatter(pcs[bmask, 0], pcs[bmask, 1], color=color, marker=markers[b],
                          s=60, edgecolors="k", linewidths=0.5, label=f"{level} / {b}")
        else:
            ax.scatter(pcs[mask, 0], pcs[mask, 1], color=color, s=60, edgecolors="k",
                      linewidths=0.5, label=level)
    ax.set_xlabel("PC1", fontsize=9)
    ax.set_ylabel("PC2", fontsize=9)
    ax.legend(fontsize=7, title="condition" + (" / batch" if batch is not None else ""))
    if title:
        ax.set_title(title)
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# View 2 -- MA plot
# --------------------------------------------------------------------------- #
def plot_ma(
    result,
    *,
    alpha: float = 0.05,
    ax: Optional[Axes] = None,
    title: Optional[str] = "MA plot",
):
    """Effect size vs. expression level, significant genes highlighted.

    BIOLOGICAL CONTEXT
        Genes far from y=0 at high mean expression are the confident calls;
        a funnel narrowing at low expression (more noise for lowly-expressed
        genes) is expected and is what `independent_filter`/`cooks_filter`
        guard against.
    COMPUTATIONAL APPROACH
        Scatter `log2FoldChange` (y) against `log10(baseMean)` (x); genes with
        `padj < alpha` colored, others gray. Reimplements PyDESeq2's
        `DeseqStats.plot_MA()` in this project's style (accepts `ax=`).
    """
    results = result.results
    x = np.log10(np.clip(results["baseMean"].values, 1e-3, None))
    y = results["log2FoldChange"].values
    sig = results["padj"].values < alpha

    if ax is None:
        fig, ax = plt.subplots(figsize=(5.5, 4.5))
    else:
        fig = ax.figure
    ax.scatter(x[~sig], y[~sig], c="0.75", s=10, edgecolors="none", label=f"padj >= {alpha}")
    ax.scatter(x[sig], y[sig], c="crimson", s=12, edgecolors="none", label=f"padj < {alpha}")
    ax.axhline(0, color="k", lw=0.8, ls="--")
    ax.set_xlabel("log10(baseMean)", fontsize=9)
    ax.set_ylabel("log2 fold-change", fontsize=9)
    ax.legend(fontsize=7)
    if title:
        ax.set_title(title)
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# View 3 -- volcano
# --------------------------------------------------------------------------- #
def plot_volcano(
    result,
    *,
    alpha: float = 0.05,
    lfc_threshold: float = 1.0,
    top_n: int = 0,
    ax: Optional[Axes] = None,
    title: Optional[str] = "Volcano",
):
    """Effect size vs. significance across genes.

    BIOLOGICAL CONTEXT
        Points in the top-left/top-right quadrants are the confident down-
        /up-regulated genes; `lfc_threshold` marks a minimum effect-size bar
        on top of statistical significance.
    COMPUTATIONAL APPROACH
        Scatter `log2FoldChange` (x) vs. `-log10(padj)` (y); dashed lines at
        `alpha` and +/-`lfc_threshold`. Optionally label the `top_n` most
        significant genes.
    """
    results = result.results
    x = results["log2FoldChange"].values
    y = -np.log10(np.clip(results["padj"].values, 1e-300, 1.0))
    sig = (results["padj"].values < alpha) & (np.abs(x) >= lfc_threshold)

    if ax is None:
        fig, ax = plt.subplots(figsize=(5.5, 4.5))
    else:
        fig = ax.figure
    ax.scatter(x[~sig], y[~sig], c="0.75", s=10, edgecolors="none")
    ax.scatter(x[sig], y[sig], c="crimson", s=12, edgecolors="none")
    ax.axhline(-np.log10(alpha), color="k", lw=0.8, ls="--")
    ax.axvline(lfc_threshold, color="0.5", lw=0.6, ls=":")
    ax.axvline(-lfc_threshold, color="0.5", lw=0.6, ls=":")
    if top_n > 0:
        top_genes = results.loc[sig].sort_values("padj").index[:top_n]
        for gene in top_genes:
            ax.annotate(str(gene), (results.loc[gene, "log2FoldChange"],
                                    -np.log10(max(results.loc[gene, "padj"], 1e-300))), fontsize=6)
    ax.set_xlabel("log2 fold-change", fontsize=9)
    ax.set_ylabel("-log10(padj)", fontsize=9)
    if title:
        ax.set_title(title)
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# View 4 -- dispersion QC (requires the live DeseqDataSet)
# --------------------------------------------------------------------------- #
def plot_dispersion(
    result,
    *,
    ax: Optional[Axes] = None,
    title: Optional[str] = "Dispersion estimates",
):
    """Gene-wise dispersion vs. mean expression, with the fitted trend.

    BIOLOGICAL CONTEXT
        QC that the negative-binomial dispersion fit is sane: genewise
        estimates should scatter around a smoothly decreasing trend as mean
        expression rises; a trend that fails to converge (or wildly scattered
        MAP estimates) signals a design/data problem upstream.
    COMPUTATIONAL APPROACH
        Reimplements `DeseqDataSet.plot_dispersions` in this project's style:
        `dds.var["genewise_dispersions"]`, `dds.var["dispersions"]` (MAP/final)
        and `dds.var["fitted_dispersions"]` (trend, evaluated per gene) against
        `dds.var["_normed_means"]`, log-log scale.

    Raises
    ------
    ValueError
        If `result.dds` is not available (e.g. reconstructed from serialized
        results) -- this view needs the live PyDESeq2 fit.
    """
    dds = getattr(result, "dds", None)
    if dds is None:
        raise ValueError("plot_dispersion needs the live DeseqDataSet (result.dds); "
                         "not available after reloading serialized results")

    x = dds.var["_normed_means"].values
    if ax is None:
        fig, ax = plt.subplots(figsize=(5.5, 4.5))
    else:
        fig = ax.figure
    ax.scatter(x, dds.var["genewise_dispersions"].values, s=8, c="0.6", label="genewise", alpha=0.6)
    ax.scatter(x, dds.var["dispersions"].values, s=8, c="crimson", label="final (MAP)", alpha=0.6)
    order = np.argsort(x)
    ax.plot(x[order], dds.var["fitted_dispersions"].values[order], c="k", lw=1.2, label="fitted trend")
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("mean of normalized counts", fontsize=9)
    ax.set_ylabel("dispersion", fontsize=9)
    ax.legend(fontsize=7)
    if title:
        ax.set_title(title)
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# View 5 -- one gene's normalized counts by condition
# --------------------------------------------------------------------------- #
def plot_gene_counts(
    result,
    gene: str,
    *,
    ax: Optional[Axes] = None,
    title: Optional[str] = None,
):
    """Normalized counts of one gene, split by condition (strip plot).

    BIOLOGICAL CONTEXT
        The per-gene sanity check behind a volcano/MA hit: does the shift hold
        up sample-by-sample, or is it driven by one outlier replicate?
    COMPUTATIONAL APPROACH
        Uses `dds.layers["normed_counts"]` (DESeq2 size-factor normalized) when
        the live fit is available; otherwise CPM from `result.counts`.
        Jittered strip plot, one point per pseudobulk sample, colored by
        condition.
    """
    if getattr(result, "dds", None) is not None:
        dds = result.dds
        values = dds.to_df(layer="normed_counts")[gene].values  # values = normalized counts for this gene
        condition = dds.obs["condition"].astype(str).values
    else:
        cpm = np.expm1(_log1p_cpm(result.counts))
        values = cpm[:, list(result.counts.columns).index(gene)]
        condition = result.metadata["condition"].astype(str).values
    colors = _condition_colors(condition)
    levels = sorted(colors)

    if ax is None:
        fig, ax = plt.subplots(figsize=(4, 4.5))
    else:
        fig = ax.figure
    rng = np.random.default_rng(0)
    for i, level in enumerate(levels):
        mask = condition == level
        xj = i + (rng.random(mask.sum()) - 0.5) * 0.3    # xj = jittered x position within the condition column
        ax.scatter(xj, values[mask], color=colors[level], s=40, edgecolors="k", linewidths=0.5)
    ax.set_xticks(np.arange(len(levels)))
    ax.set_xticklabels(levels)
    ax.set_ylabel("normalized counts", fontsize=9)
    ax.set_title(title or f"{gene}")
    fig.tight_layout()
    return ax


# --------------------------------------------------------------------------- #
# Summary + demo
# --------------------------------------------------------------------------- #
def plot_summary(result, *, alpha: float = 0.05, figsize: tuple = (15, 4)) -> Figure:
    """PCA + MA + volcano side by side for one cell type's DE result."""
    fig, axes = plt.subplots(1, 3, figsize=figsize)
    plot_pca(result, ax=axes[0])
    plot_ma(result, alpha=alpha, ax=axes[1])
    plot_volcano(result, alpha=alpha, ax=axes[2])
    fig.suptitle(f"Pseudobulk DE -- {result.cell_type}", y=1.03)
    fig.tight_layout()
    return fig


def _demo(outfile: str = "pseudobulk_deseq2_demo.png"):
    """Run the pipeline on synthetic data and render every view."""
    from pb_compute import aggregate_pseudobulk, filter_genes, make_synthetic_pseudobulk, run_deseq2

    counts, obs, _is_de, _true_lfc = make_synthetic_pseudobulk()
    pb = aggregate_pseudobulk(counts.values, obs, sample_key="sample_id", condition_key="condition",
                               batch_key="batch", genes=list(counts.columns))
    pb = filter_genes(pb, min_count=10)
    de = run_deseq2(pb, condition_key="condition", contrast=["condition", "treated", "control"],
                    batch_key="batch", shrink=True, n_cpus=1)

    fig = plot_summary(de)
    fig.savefig(outfile, dpi=130, bbox_inches="tight")
    print(f"wrote {outfile}")

    fig2, ax = plt.subplots(figsize=(5.5, 4.5))
    plot_dispersion(de, ax=ax)
    fig2.savefig("pseudobulk_deseq2_dispersion_demo.png", dpi=130, bbox_inches="tight")
    print("wrote pseudobulk_deseq2_dispersion_demo.png")

    top_gene = de.results.sort_values("padj").index[0]
    fig3, ax = plt.subplots(figsize=(4, 4.5))
    plot_gene_counts(de, top_gene, ax=ax)
    fig3.savefig("pseudobulk_deseq2_gene_demo.png", dpi=130, bbox_inches="tight")
    print("wrote pseudobulk_deseq2_gene_demo.png")


if __name__ == "__main__":
    _demo()
