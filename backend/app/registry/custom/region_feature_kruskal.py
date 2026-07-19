"""Region feature differences (Kruskal-Wallis) — for each cell type, test which
genes differ in expression across regions with the Kruskal-Wallis H-test (the
non-parametric, multi-sample analogue of one-way ANOVA), Benjamini-Hochberg FDR
across genes. Compute writes the per-cell-type results to `uns[key_added]`; the
paired plot step reads them back and draws a gene x region mean-expression
heatmap for one cell type — the same compute-writes/plot-reads split the other
custom metrics use (e.g. pseudobulk_deseq2). numpy/scipy only; no new deps."""
from __future__ import annotations

from ..base import CallResult, Function, ParamSpec, missing_obs_column, run_compute, run_plot
from ._docs import custom_doc

_CELLTYPE_PARAM = ParamSpec(
    "celltype_key", {"type": "string"}, "obs_categorical", None, required=True,
    tooltip="Cell type/cluster column (categorical obs); one Kruskal-Wallis test set per level")
_REGION_PARAM = ParamSpec(
    "region_key", {"type": "string"}, "obs_categorical", None, required=True,
    tooltip="Region set (categorical obs column); the groups each gene is compared across")

_CITATION = ("Original method implemented in this repository: per-cell-type Kruskal-Wallis H-test of "
             "per-gene expression across regions, with Benjamini-Hochberg FDR. Kruskal, W.H. & Wallis, "
             "W.A. Use of ranks in one-criterion variance analysis. JASA 47, 583-621 (1952).")
_DOC = custom_doc("region-feature-differences-kruskal-wallis")


def _benjamini_hochberg(pvalues):
    """BH-FDR adjusted p-values (numpy only, so no statsmodels dependency)."""
    import numpy as np

    p = np.asarray(pvalues, dtype=float)
    n = p.size
    order = np.argsort(p)
    ranked = p[order] * n / (np.arange(n) + 1)
    ranked = np.minimum.accumulate(ranked[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.clip(ranked, 0.0, 1.0)
    return out


def _dense(matrix):
    """A dense 2-D float array from a (possibly sparse) expression submatrix."""
    import numpy as np

    return np.asarray(matrix.todense() if hasattr(matrix, "todense") else matrix, dtype=float)


def _kruskal_by_region(sub_expr, region_labels, genes, min_cells, n_top):
    """Per-gene Kruskal-Wallis across the regions present in one cell type's cells.
    Returns (results dict, regions kept) or (None, reason) when there is nothing to
    test (fewer than two regions clear the min_cells floor)."""
    import numpy as np
    from scipy.stats import kruskal

    labels = np.asarray(region_labels, dtype=object)
    regions = [r for r in dict.fromkeys(labels) if np.sum(labels == r) >= min_cells]
    if len(regions) < 2:
        return None, f"fewer than 2 regions with >= {min_cells} cells"

    group_idx = [np.where(labels == r)[0] for r in regions]
    stats = np.zeros(len(genes))
    pvals = np.ones(len(genes))
    for j in range(len(genes)):
        col = sub_expr[:, j]
        groups = [col[idx] for idx in group_idx]
        try:
            stats[j], pvals[j] = kruskal(*groups)
        except ValueError:
            # scipy raises when every value across every group is identical.
            stats[j], pvals[j] = 0.0, 1.0
    padj = _benjamini_hochberg(pvals)

    order = np.argsort(padj, kind="stable")[: min(n_top, len(genes))]
    top_genes = [genes[i] for i in order]
    means = np.vstack([sub_expr[idx][:, order].mean(axis=0) for idx in group_idx])  # regions x top genes
    return {
        "gene": top_genes,
        "statistic": [float(stats[i]) for i in order],
        "pvalue": [float(pvals[i]) for i in order],
        "padj": [float(padj[i]) for i in order],
        "regions": regions,
        "mean_by_region": means.T.tolist(),  # genes x regions
        "n_genes_tested": int(len(genes)),
    }, regions


class RegionFeatureKruskal(Function):
    source = "custom"
    key = "custom.region_feature_kruskal"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "region_feature_kruskal"
    effect_class = "compute"
    label = "Region feature differences (Kruskal-Wallis)"
    summary = "Per cell type, rank genes whose expression differs across regions (Kruskal-Wallis + BH-FDR)."
    doc = """Region feature differences (Kruskal-Wallis)

For each cell type, test which genes differ in expression across regions and
rank them. Within the cells of one cell type, each gene's expression is compared
across the region groups with the Kruskal-Wallis H-test — the non-parametric,
multi-sample analogue of one-way ANOVA, so it needs no distributional assumption
and handles more than two regions. p-values are Benjamini-Hochberg FDR-adjusted
across genes, and the top genes per cell type are stored for the matching
"Region feature differences (Kruskal-Wallis) (plot)" step.

The test compares individual cells across regions within one section, so the
p-values are descriptive of this sample, not a between-replicate inferential
statistic; use "Pseudobulk DE (DESeq2)" when you have several biological
replicates per condition.

Parameters
----------
celltype_key
    Cell-type/cluster column (categorical obs). One test set is run per level.
region_key
    Region set (categorical obs column); the groups each gene is compared across.
layer
    Layer holding the expression to test; blank uses `.X`. Use normalized/log
    expression (e.g. after normalize_total + log1p), not raw counts.
min_cells
    A region needs at least this many cells of the cell type to be included.
n_top
    Top genes (by adjusted p-value) retained per cell type.
key_added
    uns key to store the per-cell-type results under.
"""
    params = [
        _CELLTYPE_PARAM,
        _REGION_PARAM,
        ParamSpec("layer", {"type": "string"}, "layer_key", None, required=False,
                  tooltip="expression layer to test (blank = .X); use normalized/log values"),
        ParamSpec("min_cells", {"type": "integer", "default": 10}, "number", None, required=False,
                  tooltip="min cells of the cell type a region needs to be included"),
        ParamSpec("n_top", {"type": "integer", "default": 50}, "number", None, required=False,
                  tooltip="top genes (by adjusted p-value) retained per cell type"),
        ParamSpec("key_added", {"type": "string", "default": "region_kruskal"}, "text", None,
                  required=True, tooltip="uns key to store the results under", role="output"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        celltype_key = params.get("celltype_key")
        region_key = params.get("region_key")
        layer = (params.get("layer") or "").strip() or None
        min_cells = int(params.get("min_cells") or 10)
        n_top = int(params.get("n_top") or 50)
        key_added = (params.get("key_added") or "region_kruskal").strip()

        adata = session.active_table()
        error = missing_obs_column(adata, celltype_key) or missing_obs_column(adata, region_key)
        if error:
            return CallResult(status="failed", error=error)
        if layer and layer not in adata.layers:
            return CallResult(status="failed", error=f"layer '{layer}' does not exist")

        def mutate(ad):
            genes = list(map(str, ad.var_names))
            matrix = ad.layers[layer] if layer else ad.X
            celltypes = ad.obs[celltype_key].astype(str).to_numpy()
            regions = ad.obs[region_key].astype(str).to_numpy()

            per_celltype, skipped = {}, {}
            for ct in dict.fromkeys(celltypes):
                mask = celltypes == ct
                result, kept = _kruskal_by_region(
                    _dense(matrix[mask]), regions[mask], genes, min_cells, n_top)
                if result is None:
                    skipped[ct] = kept
                else:
                    per_celltype[ct] = result
            if not per_celltype:
                raise ValueError(
                    f"no cell type had >= 2 regions with >= {min_cells} cells "
                    f"(celltype_key={celltype_key!r}, region_key={region_key!r})")
            ad.uns[key_added] = {
                "per_celltype": per_celltype,
                "params": {"celltype_key": celltype_key, "region_key": region_key,
                           "layer": layer, "min_cells": min_cells, "n_top": n_top},
                "skipped": skipped,
            }

        return run_compute(session, mutate)


class RegionFeatureKruskalPlot(Function):
    source = "custom"
    key = "custom.region_feature_kruskal_plot"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "region_feature_kruskal_plot"
    effect_class = "plot"
    label = "Region feature differences (Kruskal-Wallis) (plot)"
    summary = "Gene x region mean-expression heatmap of the top region-varying genes for one cell type."
    doc = """Region feature differences (Kruskal-Wallis) (plot)

Heatmap of the top region-varying genes for one cell type computed by "Region
feature differences (Kruskal-Wallis)" under the same key_added. Rows are the
most significant genes (smallest adjusted p-value), columns are regions, and
each cell is that gene's mean expression in that region, z-scored per gene so
the spatial pattern is visible regardless of absolute level.

Parameters
----------
key_added
    uns key used by the "Region feature differences (Kruskal-Wallis)" step.
cell_type
    Which cell type's result to plot; blank picks the cell type whose single
    most significant gene has the smallest adjusted p-value.
n_genes
    Number of top genes (rows) to show.
"""
    params = [
        ParamSpec("key_added", {"type": "string", "default": "region_kruskal"}, "text", None,
                  required=True, tooltip="uns key used by the compute step"),
        ParamSpec("cell_type", {"type": "string"}, "text", None, required=False,
                  tooltip="which cell type's result to plot (blank = the most differential one)"),
        ParamSpec("n_genes", {"type": "integer", "default": 15}, "number", None, required=False,
                  tooltip="top genes (rows) to show in the heatmap"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        key_added = (params.get("key_added") or "region_kruskal").strip()
        cell_type = (params.get("cell_type") or "").strip()
        n_genes = int(params.get("n_genes") or 15)
        adata = session.active_table()
        if key_added not in adata.uns:
            return CallResult(status="failed",
                              error=f"run 'Region feature differences (Kruskal-Wallis)' for this key first "
                                    f"(uns['{key_added}'] not found)")
        per_celltype = adata.uns[key_added].get("per_celltype", {})
        if not per_celltype:
            return CallResult(status="failed", error=f"uns['{key_added}'] has no per-cell-type results")
        if cell_type and cell_type not in per_celltype:
            return CallResult(status="failed",
                              error=f"cell type {cell_type!r} not found in uns['{key_added}']['per_celltype']; "
                                    f"available: {sorted(per_celltype)}")
        if not cell_type:
            # The cell type whose single most significant gene ranks best.
            cell_type = min(per_celltype, key=lambda ct: min(per_celltype[ct]["padj"], default=1.0))

        def fn(ad):
            import matplotlib.pyplot as plt
            import numpy as np

            stored = ad.uns[key_added]["per_celltype"][cell_type]
            k = min(n_genes, len(stored["gene"]))
            genes = stored["gene"][:k]
            regions = stored["regions"]
            means = np.asarray(stored["mean_by_region"], dtype=float)[:k]  # genes x regions
            # z-score each gene's row so the between-region pattern is comparable.
            centered = means - means.mean(axis=1, keepdims=True)
            sd = centered.std(axis=1, keepdims=True)
            z = np.divide(centered, sd, out=np.zeros_like(centered), where=sd > 0)

            fig, ax = plt.subplots(figsize=(max(4, 0.7 * len(regions) + 2), max(3, 0.35 * k + 1)))
            im = ax.imshow(z, aspect="auto", cmap="RdBu_r", vmin=-2, vmax=2)
            ax.set_xticks(range(len(regions)))
            ax.set_xticklabels(regions, rotation=45, ha="right", fontsize=8)
            ax.set_yticks(range(k))
            ax.set_yticklabels(genes, fontsize=7)
            ax.set_xlabel(ad.uns[key_added]["params"]["region_key"])
            ax.set_title(f"Region-varying genes — {cell_type}\n(top {k} by BH-FDR; per-gene z-scored mean expr)",
                         fontsize=9)
            fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04, label="z-score")
            fig.tight_layout()
            return fig

        return run_plot(session, fn)
