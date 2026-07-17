"""Proximity / avoidance test — nearest-neighbor distance test between cell-type
pairs, complementary to squidpy's nhood_enrichment (graph-edge counts) and
co_occurrence (probability across distance bins). See _vendor/proximity_compute.py
for the statistic and permutation-null details."""
from __future__ import annotations

from types import SimpleNamespace

from ..base import CallResult, Function, ParamSpec, capture_log, missing_obs_column, render_plot, run_compute, \
    resolve_obsm_key

_KEY_ADDED_PARAM = ParamSpec(
    "key_added", {"type": "string", "default": "proximity"}, "text", None,
    required=True, tooltip="uns key to store/read the proximity result under", role="output")


from ._docs import custom_doc

_CITATION = ("Original permutation-based proximity/avoidance test implemented in this repository "
             "(nearest-neighbor distance between cell-type pairs vs a label-permutation null).")
_DOC = custom_doc("proximity-and-avoidance-test")


class ProximityTest(Function):
    source = "custom"
    key = "custom.proximity_test"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "proximity_test"
    effect_class = "compute"
    label = "Proximity / avoidance test"
    summary = "Nearest-neighbor distance test for attraction/avoidance between cell types."
    doc = """Proximity / avoidance test

For every ordered pair of cell types (A, B), test whether A cells sit closer to
(or farther from) their nearest B cell than a label-permutation null. Negative
z-scores indicate attraction (interaction/recruitment); positive z-scores
indicate avoidance (exclusion). Results are stored in `uns` for the matching
"Proximity / avoidance test (plot)" step to render.

Parameters
----------
cell_type_key
    Categorical obs column (cell types/clusters) to test between.
coords
    obsm key holding the coordinates (default: spatial).
library_key
    Categorical obs column of sample/section ids; if set, labels are permuted
    within each sample rather than globally.
n_perm
    Number of label permutations for the null. Larger values are more precise
    but slower — the permutation loop reruns the full pairwise nearest-neighbor
    search each time.
stat
    Summary statistic for the nearest-neighbor distances ("median" or "mean").
random_state
    Seed for the permutation null.
key_added
    uns key to store the result under.
"""
    params = [
        ParamSpec("cell_type_key", {"type": "string"}, "obs_categorical", None,
                  required=True, tooltip="cell-type/cluster column to test between"),
        ParamSpec("coords", {"type": "string", "default": "spatial"}, "obsm_key", None,
                  required=False, tooltip="obsm key of the coordinates"),
        ParamSpec("library_key", {"type": "string"}, "obs_categorical", None,
                  required=False, tooltip="sample/section id column; permute labels within each sample"),
        ParamSpec("n_perm", {"type": "integer", "default": 500}, "number", None,
                  required=False, tooltip="number of label permutations (larger = slower, more precise)"),
        ParamSpec("stat", {"type": "string", "enum": ["median", "mean"], "default": "median"},
                  "select", None, required=False, tooltip="nearest-neighbor distance summary statistic"),
        ParamSpec("random_state", {"type": "integer", "default": 0}, "number", None,
                  required=False, tooltip="random seed for the permutation null"),
        _KEY_ADDED_PARAM,
    ]

    def execute(self, params: dict, session) -> CallResult:
        cell_type_key = params.get("cell_type_key")
        library_key = params.get("library_key") or None
        key_added = (params.get("key_added") or "proximity").strip()
        n_perm = int(params.get("n_perm") or 500)
        stat = params.get("stat") or "median"
        random_state = int(params.get("random_state") or 0)

        adata = session.active_table()
        error = missing_obs_column(adata, cell_type_key) or \
            (missing_obs_column(adata, library_key) if library_key else None)
        if error:
            return CallResult(status="failed", error=error)
        try:
            coords = resolve_obsm_key(adata, params)
        except KeyError as e:
            return CallResult(status="failed", error=f"obsm['{e.args[0]}'] does not exist")

        def mutate(ad):
            from ._vendor import proximity_compute

            proximity_compute.proximity_adata(
                ad, cell_type_key, spatial_key=coords, library_key=library_key,
                n_perm=n_perm, stat=stat, random_state=random_state, key_added=key_added)
            stored = ad.uns[key_added]
            ad.uns[key_added] = {
                "categories": stored["zscore"].index.astype(str).tolist(),
                "zscore": stored["zscore"].values.tolist(),
                "pvalue": stored["pvalue"].values.tolist(),
                "observed": stored["observed"].values.tolist(),
                "params": stored["params"],
            }

        return run_compute(session, mutate)


class ProximityTestPlot(Function):
    source = "custom"
    key = "custom.proximity_test_plot"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "proximity_test_plot"
    effect_class = "plot"
    label = "Proximity / avoidance test (plot)"
    summary = "Heatmap of proximity/avoidance z-scores between cell-type pairs."
    doc = """Proximity / avoidance test (plot)

Heatmap of the pairwise z-scores computed by "Proximity / avoidance test" for
the same key_added. Blue = closer than chance (attraction), red = farther
(avoidance); a dot marks pairs significant at p < 0.05. Run that step first.

Parameters
----------
key_added
    uns key the "Proximity / avoidance test" step stored its result under.
"""
    params = [_KEY_ADDED_PARAM]

    def execute(self, params: dict, session) -> CallResult:
        key_added = (params.get("key_added") or "proximity").strip()
        adata = session.active_table()
        if key_added not in adata.uns:
            return CallResult(
                status="failed",
                error=f"run 'Proximity / avoidance test' for this key first (uns['{key_added}'] not found)")

        def fn(ad):
            from ._vendor import proximity_plot

            data = ad.uns[key_added]
            result = SimpleNamespace(categories=data["categories"], zscore=data["zscore"], pvalue=data["pvalue"])
            return proximity_plot.plot_proximity_heatmap(result)

        with capture_log() as buf:
            return render_plot(fn, [adata], {}, buf)
