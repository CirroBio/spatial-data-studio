"""Milo-style differential abundance — test compositional shift between two
conditions across small, overlapping neighborhoods of a KNN graph (Dann et al.,
Nat Biotechnol 2021). No scanpy/squidpy equivalent exists; the algorithm is
vendored from `_vendor/milo_da_compute.py` / `_vendor/milo_da_plot.py`. Compute
writes the per-neighborhood results table to `uns[key_added]`; the paired plot
step reads it back, mirroring the compute-writes/plot-reads split squidpy
metrics use (e.g. nhood_enrichment)."""
from __future__ import annotations

import numpy as np

from ..base import (CallResult, Function, ParamSpec, missing_obs_column,
                    resolve_obsm_key, run_compute, run_plot)
from ._vendor import milo_da_compute, milo_da_plot

_SAMPLE_PARAM = ParamSpec(
    "sample_key", {"type": "string"}, "obs_categorical", None, required=True,
    tooltip="Per-cell sample/replicate id (categorical obs column)")
_CONDITION_PARAM = ParamSpec(
    "condition_key", {"type": "string"}, "obs_categorical", None, required=True,
    tooltip="Per-cell condition (categorical obs column with exactly 2 levels)")
_KEY_ADDED_PARAM = ParamSpec(
    "key_added", {"type": "string", "default": "milo"}, "text", None,
    required=True, tooltip="uns key to store the differential-abundance results under", role="output")


from ._docs import custom_doc

_CITATION = ("Dann, E. et al. Differential abundance testing on single-cell data using k-nearest "
             "neighbor graphs. Nat Biotechnol 40, 245-253 (2022). doi:10.1038/s41587-021-01033-z (Milo).")
_DOC = custom_doc("milo-differential-abundance")


class MiloDifferentialAbundance(Function):
    source = "custom"
    key = "custom.milo_differential_abundance"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "milo_differential_abundance"
    effect_class = "compute"
    label = "Milo differential abundance"
    summary = "Test neighborhood-level abundance shifts between two conditions."
    doc = """Milo differential abundance

Build a KNN graph on a cell embedding, sample overlapping neighborhoods across
it, and test each neighborhood's cell counts for a shift between two levels of
a condition column (negative-binomial GLM, Wald test, overlap-aware spatial
FDR). Results are stored in `uns` for the matching "Milo differential
abundance (plot)" step to render.

Parameters
----------
sample_key
    Per-cell sample/replicate id (categorical obs column). Needs several
    samples per condition for the test to be meaningful.
condition_key
    Per-cell condition (categorical obs column). Must have exactly 2 levels;
    the alphabetically/numerically later level is treated as the tested
    condition, the earlier one as reference.
use_rep
    obsm key of the embedding to build the KNN graph on (default: X_pca).
cell_type_key
    Optional categorical obs column used only to annotate/group neighborhoods
    in the beeswarm plot, not to compute the test.
k
    KNN graph size.
prop
    Fraction of cells sampled as neighborhood seeds.
refine
    Refine each sampled seed to the cell nearest its window's median position.
prior_count
    Pseudocount added to neighborhood counts to stabilize fold-changes.
random_state
    Seed for neighborhood sampling.
key_added
    uns key to store the results under.
"""
    params = [
        _SAMPLE_PARAM,
        _CONDITION_PARAM,
        ParamSpec("use_rep", {"type": "string", "default": "X_pca"}, "obsm_key", None,
                  required=False, tooltip="obsm key of the embedding to build the KNN graph on"),
        ParamSpec("cell_type_key", {"type": "string"}, "obs_categorical", None,
                  required=False, tooltip="optional cell-type/cluster column, for annotating neighborhoods"),
        ParamSpec("k", {"type": "integer", "default": 30}, "number", None,
                  required=False, tooltip="KNN graph size"),
        ParamSpec("prop", {"type": "number", "default": 0.1}, "number", None,
                  required=False, tooltip="fraction of cells sampled as neighborhood seeds"),
        ParamSpec("refine", {"type": "boolean", "default": True}, "checkbox", None,
                  required=False, tooltip="refine sampled seeds to their window's median-nearest cell"),
        ParamSpec("prior_count", {"type": "number", "default": 1.0}, "number", None,
                  required=False, tooltip="pseudocount stabilizing sparse-neighborhood fold-changes"),
        ParamSpec("random_state", {"type": "integer", "default": 0}, "number", None,
                  required=False, tooltip="random seed for neighborhood sampling"),
        _KEY_ADDED_PARAM,
    ]

    def execute(self, params: dict, session) -> CallResult:
        import pandas as pd

        sample_key = params.get("sample_key")
        condition_key = params.get("condition_key")
        cell_type_key = params.get("cell_type_key") or None
        key_added = (params.get("key_added") or "milo").strip()

        adata = session.active_table()
        error = (missing_obs_column(adata, sample_key)
                 or missing_obs_column(adata, condition_key)
                 or (missing_obs_column(adata, cell_type_key) if cell_type_key else None))
        if error:
            return CallResult(status="failed", error=error)

        n_levels = adata.obs[condition_key].nunique()
        if n_levels != 2:
            return CallResult(status="failed",
                              error=f"condition_key '{condition_key}' has {n_levels} levels; "
                                    "Milo differential abundance needs exactly 2")

        if not adata.obsm:
            return CallResult(status="failed",
                              error="no embeddings found in obsm; run a step that produces one "
                                    "(e.g. PCA) before Milo differential abundance")
        try:
            use_rep = resolve_obsm_key(adata, params, param="use_rep", default="X_pca")
        except KeyError as e:
            return CallResult(status="failed",
                              error=f"obsm['{e.args[0]}'] does not exist; run PCA (or another "
                                    "embedding step) first and pass its obsm key as use_rep")

        k = int(params.get("k") or 30)
        prop = float(params.get("prop") or 0.1)
        refine = bool(params.get("refine", True))
        prior_count = float(params.get("prior_count") or 1.0)
        random_state = int(params.get("random_state") or 0)

        def mutate(ad):
            milo_da_compute.milo_adata(
                ad, sample_key, condition_key, use_rep=use_rep, cell_type_key=cell_type_key,
                k=k, prop=prop, refine=refine, prior_count=prior_count, random_state=random_state,
                key_added=key_added,
            )
            stored = ad.uns[key_added]
            results: pd.DataFrame = stored["results"]
            ad.uns[key_added] = {
                "columns": results.columns.tolist(),
                "results": results.to_dict(orient="list"),
                "params": stored["params"],
            }

        return run_compute(session, mutate)


class MiloDifferentialAbundancePlot(Function):
    source = "custom"
    key = "custom.milo_differential_abundance_plot"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "milo_differential_abundance_plot"
    effect_class = "plot"
    label = "Milo differential abundance (plot)"
    summary = "Beeswarm + volcano of neighborhood-level differential abundance."
    doc = """Milo differential abundance (plot)

Beeswarm (logFC by cell-type annotation) and volcano (logFC vs. spatial FDR)
of the neighborhoods computed by "Milo differential abundance" for the same
key_added. Run that step first.

Parameters
----------
key_added
    uns key used by the "Milo differential abundance" step.
alpha
    Spatial-FDR threshold marking a neighborhood as significant.
"""
    params = [
        _KEY_ADDED_PARAM,
        ParamSpec("alpha", {"type": "number", "default": 0.1}, "number", None,
                  required=False, tooltip="spatial-FDR threshold for significance"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        key_added = (params.get("key_added") or "milo").strip()
        alpha = float(params.get("alpha") or 0.1)
        adata = session.active_table()
        if key_added not in adata.uns:
            return CallResult(status="failed",
                              error=f"run 'Milo differential abundance' for this key first "
                                    f"(uns['{key_added}'] not found)")

        def fn(ad):
            stored = ad.uns[key_added]["results"]
            annotation = stored.get("annotation")
            has_annotation = annotation is not None and not all(
                a is None or (isinstance(a, float) and np.isnan(a)) for a in annotation)
            result = type("_MiloResult", (), {
                "logFC": np.asarray(stored["logFC"], dtype=float),
                "fdr": np.asarray(stored["spatial_fdr"], dtype=float),
                "annotation": np.asarray(annotation) if has_annotation else None,
            })()
            return milo_da_plot.plot_summary(result, alpha=alpha)

        return run_plot(session, fn)
