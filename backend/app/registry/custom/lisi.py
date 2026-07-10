"""LISI (Local Inverse Simpson's Index) — per-cell diagnostic of integration
quality: iLISI scores batch mixing, cLISI scores cell-type separation. No
scanpy/squidpy equivalent exists (it lives in scib/harmonypy); the algorithm is
vendored from `_vendor/lisi_compute.py` / `_vendor/lisi_plot.py`. Compute writes
per-cell scores to `obs` and a JSON-safe summary to `uns[key_added]`; the paired
plot step reads both back, mirroring the compute-writes/plot-reads split squidpy
metrics use (e.g. nhood_enrichment)."""
from __future__ import annotations

import numpy as np

from ..base import (CallResult, Function, ParamSpec, capture_log, missing_obs_column, render_plot,
                    resolve_obsm_key, run_compute)
from ._docs import custom_doc
from ._vendor import lisi_compute, lisi_plot

_CITATION = ("Korsunsky, I. et al. Fast, sensitive and accurate integration of single-cell "
             "data with Harmony. Nat Methods 16, 1289-1296 (2019). doi:10.1038/s41592-019-0619-0 (LISI).")
_DOC = custom_doc("lisi-scores")

_KEY_ADDED_PARAM = ParamSpec(
    "key_added", {"type": "string", "default": "lisi"}, "text", None,
    required=True, tooltip="uns key / obs column prefix for the LISI results", role="output")


class LisiScores(Function):
    source = "custom"
    key = "custom.lisi_scores"
    namespace = "custom"
    function = "lisi_scores"
    effect_class = "compute"
    label = "LISI scores"
    summary = "Per-cell iLISI (batch mixing) / cLISI (cell-type separation) scores."
    citation = _CITATION
    documentation = _DOC
    doc = """LISI scores

Local Inverse Simpson's Index (Korsunsky et al., Nat Methods 2019): the
effective number of label categories in each cell's local neighborhood of an
embedding. Provide batch_key to score batch mixing (iLISI: near 1 = poorly
mixed, near the batch count = well mixed) and/or label_key to score cell-type
separation (cLISI: near 1 = distinct types, higher = blended). Results are
stored in `obs`/`uns` for the matching "LISI scores (plot)" step to render.

Parameters
----------
use_rep
    obsm key of the embedding to score (default: X_pca).
batch_key
    Batch/sample id (categorical obs column) — scores mixing as iLISI.
label_key
    Cell-type/cluster column (categorical obs column) — scores separation as
    cLISI. At least one of batch_key/label_key must be given.
perplexity
    Effective neighborhood size (t-SNE-style perplexity calibration).
key_added
    uns key / obs column prefix for the results.
"""
    params = [
        ParamSpec("use_rep", {"type": "string", "default": "X_pca"}, "obsm_key", None,
                  required=False, tooltip="obsm key of the embedding to score"),
        ParamSpec("batch_key", {"type": "string"}, "obs_categorical", None,
                  required=False, tooltip="batch/sample id (categorical obs column) for iLISI"),
        ParamSpec("label_key", {"type": "string"}, "obs_categorical", None,
                  required=False, tooltip="cell-type/cluster column (categorical obs column) for cLISI"),
        ParamSpec("perplexity", {"type": "number", "default": 30}, "number", None,
                  required=False, tooltip="effective neighborhood size"),
        _KEY_ADDED_PARAM,
    ]

    def execute(self, params: dict, session) -> CallResult:
        batch_key = params.get("batch_key") or None
        label_key = params.get("label_key") or None
        perplexity = float(params.get("perplexity") or 30)
        key_added = (params.get("key_added") or "lisi").strip()

        adata = session.active_table()
        if not batch_key and not label_key:
            return CallResult(status="failed",
                              error="provide at least one of batch_key or label_key to score")
        error = ((missing_obs_column(adata, batch_key) if batch_key else None)
                 or (missing_obs_column(adata, label_key) if label_key else None))
        if error:
            return CallResult(status="failed", error=error)
        try:
            use_rep = resolve_obsm_key(adata, params, param="use_rep", default="X_pca")
        except KeyError as e:
            return CallResult(status="failed", error=f"obsm['{e.args[0]}'] does not exist")

        def mutate(ad):
            res = lisi_compute.lisi_adata(ad, use_rep=use_rep, batch_key=batch_key, label_key=label_key,
                                          perplexity=perplexity, key_added=key_added)
            ad.uns[key_added] = {
                "summary": res.summary.to_dict(orient="list"),
                "n_categories": res.n_categories,
                "params": res.params,
                "use_rep": use_rep,
            }

        return run_compute(session, mutate)


class LisiScoresPlot(Function):
    source = "custom"
    key = "custom.lisi_scores_plot"
    namespace = "custom"
    function = "lisi_scores_plot"
    effect_class = "plot"
    label = "LISI scores (plot)"
    summary = "Score distributions (+ embedding colored by LISI) from 'LISI scores'."
    citation = _CITATION
    documentation = _DOC
    doc = """LISI scores (plot)

Violin plot of the per-cell iLISI/cLISI distributions computed by "LISI
scores", plus the scoring embedding colored by the first available metric.
Run that step first.

Parameters
----------
key_added
    uns key / obs column prefix used by the "LISI scores" step.
"""
    params = [_KEY_ADDED_PARAM]

    def execute(self, params: dict, session) -> CallResult:
        key_added = (params.get("key_added") or "lisi").strip()
        adata = session.active_table()
        if key_added not in adata.uns:
            return CallResult(status="failed",
                              error=f"run 'LISI scores' for this key first (uns['{key_added}'] not found)")

        def fn(ad):
            stored = ad.uns[key_added]
            summary = stored["summary"]
            metrics = summary["metric"]
            missing = [m for m in metrics if f"{key_added}_{m}" not in ad.obs.columns]
            if missing:
                raise KeyError(f"obs column(s) {missing} not found; rerun 'LISI scores'")
            scores = {m: np.asarray(ad.obs[f"{key_added}_{m}"], dtype=float) for m in metrics}
            n_categories = dict(zip(metrics, summary["n_categories"]))
            result = type("_LISIResult", (), {"scores": scores, "n_categories": n_categories})()
            use_rep = stored.get("use_rep")
            embedding = np.asarray(ad.obsm[use_rep]) if use_rep and use_rep in ad.obsm else None
            return lisi_plot.plot_summary(result, embedding=embedding)

        with capture_log() as buf:
            return render_plot(fn, [adata], {}, buf)
