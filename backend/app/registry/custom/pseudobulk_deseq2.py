"""Pseudobulk differential expression (PyDESeq2) — sum raw counts per (sample x
cell type) into bulk-like profiles and run PyDESeq2 with samples as the
replicates, looping over cell types (Squair et al., Nat Commun 2021; muscat).
Per-cell tests across conditions treat non-independent cells as replicates and
are anti-conservative for this question — see `scanpy.tl.rank_genes_groups`
for the (different) per-cell marker-detection use case. The algorithm is
vendored from `_vendor/pb_compute.py` / `_vendor/pb_plot.py`. Compute writes
the per-cell-type results table to `uns[key_added]`; the paired plot step
reads it back, mirroring the compute-writes/plot-reads split squidpy metrics
use (e.g. nhood_enrichment)."""
from __future__ import annotations

from ..base import CallResult, Function, ParamSpec, capture_log, missing_obs_column, render_plot, run_compute
from ._vendor import pb_compute, pb_plot

_SAMPLE_PARAM = ParamSpec(
    "sample_key", {"type": "string"}, "obs_categorical", None, required=True,
    tooltip="Per-cell sample/replicate id (categorical obs column)")
_CONDITION_PARAM = ParamSpec(
    "condition_key", {"type": "string"}, "obs_categorical", None, required=True,
    tooltip="Per-cell condition (categorical obs column)")
_CELLTYPE_PARAM = ParamSpec(
    "celltype_key", {"type": "string"}, "obs_categorical", None, required=True,
    tooltip="Per-cell type/cluster (categorical obs column); one DESeq2 fit per level")
_KEY_ADDED_PARAM = ParamSpec(
    "key_added", {"type": "string", "default": "pseudobulk_de"}, "text", None,
    required=True, tooltip="uns key to store the differential-expression results under", role="output")


from ._docs import custom_doc

_CITATION = ("Love, M.I., Huber, W. & Anders, S. Moderated estimation of fold change and dispersion "
             "for RNA-seq data with DESeq2. Genome Biol 15, 550 (2014). doi:10.1186/s13059-014-0550-8; "
             "pseudobulk aggregation per Squair, J.W. et al. Nat Commun 12, 5692 (2021).")
_DOC = custom_doc("pseudobulk-de-with-deseq2")


class PseudobulkDESeq2(Function):
    source = "custom"
    key = "custom.pseudobulk_deseq2"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "pseudobulk_deseq2"
    effect_class = "compute"
    label = "Pseudobulk DE (DESeq2)"
    summary = "Sum counts per sample x cell type and test conditions with PyDESeq2."
    doc = """Pseudobulk DE (DESeq2)

Sum raw counts across all cells of a type within each biological sample,
producing one bulk-like profile per (sample x cell type), then test each
cell type between two condition levels with PyDESeq2 (negative-binomial GLM,
Wald test, optional apeGLM LFC shrinkage). Samples — not cells — are the
replicates, which is the statistically valid way to compare conditions;
per-cell tests inflate the sample size and are anti-conservative for this
question (use "Rank Genes Groups" / squidpy marker tools for per-cell marker
detection instead). Cell types with fewer than 2 pseudobulk samples in either
condition level are skipped (noted in the run log), not silently tested.
Results are stored in `uns` for the matching "Pseudobulk DE (DESeq2) (plot)"
step to render.

Parameters
----------
sample_key
    Per-cell sample/replicate id (categorical obs column). Needs several
    samples per condition for the test to be statistically meaningful.
condition_key
    Per-cell condition (categorical obs column) forming the contrast.
celltype_key
    Per-cell type/cluster (categorical obs column); one DESeq2 fit per level.
tested_level, ref_level
    The two condition values forming the contrast (log2FoldChange is tested
    vs. ref). Leave both blank to auto-infer when condition_key has exactly 2
    levels (the alphabetically/numerically later level becomes tested, the
    earlier one ref, matching this app's Milo differential-abundance step).
batch_key
    Optional categorical obs column added to the design (`~batch + condition`)
    as a covariate.
layer
    Layer holding raw integer counts to aggregate; blank uses `.X`. Pseudobulk
    DESeq2 requires raw counts — normalized/log data is rejected.
min_cells
    Minimum cells for a (sample x cell type) pseudobulk group to be kept.
min_count
    Minimum total pseudobulk count for a gene to be kept (or detected in
    enough samples — see filter_genes).
shrink
    Apply apeGLM log-fold-change shrinkage (stabilizes ranking/plots; leaves
    the hypothesis-test p-values unchanged).
alpha
    Significance threshold used by PyDESeq2's independent filtering.
key_added
    uns key to store the results under.
"""
    params = [
        _SAMPLE_PARAM,
        _CONDITION_PARAM,
        _CELLTYPE_PARAM,
        ParamSpec("tested_level", {"type": "string"}, "text", None, required=False,
                  tooltip="condition value tested (blank = auto-infer for a 2-level column)"),
        ParamSpec("ref_level", {"type": "string"}, "text", None, required=False,
                  tooltip="condition value used as reference (blank = auto-infer)"),
        ParamSpec("batch_key", {"type": "string"}, "obs_categorical", None,
                  required=False, tooltip="optional batch/covariate column added to the design"),
        ParamSpec("layer", {"type": "string"}, "layer_key", None,
                  required=False, tooltip="raw-counts layer to aggregate (blank = .X)"),
        ParamSpec("min_cells", {"type": "integer", "default": 10}, "number", None,
                  required=False, tooltip="min cells per (sample x cell type) pseudobulk group"),
        ParamSpec("min_count", {"type": "integer", "default": 10}, "number", None,
                  required=False, tooltip="min total pseudobulk count to keep a gene"),
        ParamSpec("shrink", {"type": "boolean", "default": True}, "checkbox", None,
                  required=False, tooltip="apply apeGLM log-fold-change shrinkage"),
        ParamSpec("alpha", {"type": "number", "default": 0.05}, "number", None,
                  required=False, tooltip="significance threshold (independent filtering)"),
        _KEY_ADDED_PARAM,
    ]

    def execute(self, params: dict, session) -> CallResult:
        sample_key = params.get("sample_key")
        condition_key = params.get("condition_key")
        celltype_key = params.get("celltype_key")
        batch_key = params.get("batch_key") or None
        tested_level = (params.get("tested_level") or "").strip() or None
        ref_level = (params.get("ref_level") or "").strip() or None
        layer = (params.get("layer") or "").strip() or None
        min_cells = int(params.get("min_cells") or 10)
        min_count = int(params.get("min_count") or 10)
        shrink = bool(params.get("shrink", True))
        alpha = float(params.get("alpha") or 0.05)
        key_added = (params.get("key_added") or "pseudobulk_de").strip()

        adata = session.active_table()
        error = (missing_obs_column(adata, sample_key)
                 or missing_obs_column(adata, condition_key)
                 or missing_obs_column(adata, celltype_key)
                 or (missing_obs_column(adata, batch_key) if batch_key else None))
        if error:
            return CallResult(status="failed", error=error)
        if layer and layer not in adata.layers:
            return CallResult(status="failed", error=f"layer '{layer}' does not exist")

        counts = adata.layers[layer] if layer else adata.X
        if not pb_compute.looks_like_raw_counts(counts):
            where = f"layer '{layer}'" if layer else "adata.X"
            return CallResult(status="failed",
                              error=f"Pseudobulk DESeq2 needs raw integer counts, but {where} contains "
                                    "negative or non-integer values (looks normalized/log-transformed). "
                                    "Point 'layer' at a raw-counts layer, or run this step before normalizing.")

        levels = adata.obs[condition_key].astype(str).unique().tolist()
        if tested_level or ref_level:
            if not (tested_level and ref_level):
                return CallResult(status="failed",
                                  error="set both tested_level and ref_level, or leave both blank to auto-infer")
            missing_levels = [lvl for lvl in (tested_level, ref_level) if lvl not in levels]
            if missing_levels:
                return CallResult(status="failed",
                                  error=f"condition_key '{condition_key}' has no level(s) {missing_levels}; "
                                        f"available levels: {levels}")
        else:
            if len(levels) != 2:
                return CallResult(status="failed",
                                  error=f"condition_key '{condition_key}' has {len(levels)} levels {levels}; "
                                        "set tested_level/ref_level explicitly, or use a column with exactly "
                                        "2 levels to auto-infer the contrast")
            ref_level, tested_level = sorted(levels)
        contrast = [condition_key, tested_level, ref_level]

        def mutate(ad):
            counts = ad.layers[layer] if layer else ad.X
            result = pb_compute.pseudobulk_de(
                counts, ad.obs, sample_key=sample_key, condition_key=condition_key,
                celltype_key=celltype_key, contrast=contrast, batch_key=batch_key,
                min_cells=min_cells, min_count=min_count, shrink=shrink, alpha=alpha,
                genes=list(ad.var_names),
            )
            ad.uns[key_added] = {
                # str(): cell-type labels become zarr subgroup names on save, so a
                # numeric celltype_key (e.g. integer cluster ids) must be stringified
                # or anndata's writer fails ('float' object has no attribute 'encode').
                "per_celltype": {
                    str(ct): {"columns": de.results.columns.tolist(),
                        "gene": de.results.index.astype(str).tolist(),
                        "values": de.results.to_dict(orient="list")}
                    for ct, de in result.per_celltype.items()
                },
                "params": result.params,
                "contrast": result.contrast,
            }

        return run_compute(session, mutate)


class PseudobulkDESeq2Plot(Function):
    source = "custom"
    key = "custom.pseudobulk_deseq2_plot"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "pseudobulk_deseq2_plot"
    effect_class = "plot"
    label = "Pseudobulk DE (DESeq2) (plot)"
    summary = "MA plot + volcano for one cell type's pseudobulk DE result."
    doc = """Pseudobulk DE (DESeq2) (plot)

MA plot (log2 fold-change vs. mean expression) and volcano (log2 fold-change
vs. significance) for the cell type computed by "Pseudobulk DE (DESeq2)" for
the same key_added. Run that step first. The PCA QC panel is not available
here: it needs the underlying pseudobulk expression matrix / live PyDESeq2
fit, which isn't persisted to keep the checkpoint lean (see the compute
step's docs) — use the standalone pb_plot.plot_pca / plot_summary if you need
it against a freshly-run result.

Parameters
----------
key_added
    uns key used by the "Pseudobulk DE (DESeq2)" step.
cell_type
    Which cell type's DE result to plot (a key of
    uns[key_added]["per_celltype"]); blank plots the first available.
alpha
    Significance threshold used to color the MA/volcano panels.
"""
    params = [
        ParamSpec("key_added", {"type": "string", "default": "pseudobulk_de"}, "text", None,
                  required=True, tooltip="uns key used by the compute step"),
        ParamSpec("cell_type", {"type": "string"}, "text", None, required=False,
                  tooltip="which cell type's DE result to plot (blank = the first available)"),
        ParamSpec("alpha", {"type": "number", "default": 0.05}, "number", None,
                  required=False, tooltip="significance threshold for MA/volcano coloring"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        key_added = (params.get("key_added") or "pseudobulk_de").strip()
        cell_type = (params.get("cell_type") or "").strip()
        alpha = float(params.get("alpha") or 0.05)
        adata = session.active_table()
        if key_added not in adata.uns:
            return CallResult(status="failed",
                              error=f"run 'Pseudobulk DE (DESeq2)' for this key first (uns['{key_added}'] not found)")
        per_celltype = adata.uns[key_added].get("per_celltype", {})
        if not per_celltype:
            return CallResult(status="failed", error=f"uns['{key_added}'] has no per-cell-type results")
        if not cell_type:
            cell_type = sorted(per_celltype)[0]
        if cell_type not in per_celltype:
            return CallResult(status="failed",
                              error=f"cell type {cell_type!r} not found in uns['{key_added}']['per_celltype']; "
                                    f"available: {sorted(per_celltype)}")

        def fn(ad):
            import matplotlib.pyplot as plt
            import pandas as pd

            stored = ad.uns[key_added]["per_celltype"][cell_type]
            df = pd.DataFrame(stored["values"], index=stored["gene"])
            result = type("_DEResult", (), {"results": df, "cell_type": cell_type})()
            fig, axes = plt.subplots(1, 2, figsize=(11, 4.5))
            pb_plot.plot_ma(result, alpha=alpha, ax=axes[0])
            pb_plot.plot_volcano(result, alpha=alpha, ax=axes[1])
            fig.suptitle(f"Pseudobulk DE — {cell_type}", y=1.03)
            fig.tight_layout()
            return fig

        with capture_log() as buf:
            return render_plot(fn, [adata], {}, buf)
