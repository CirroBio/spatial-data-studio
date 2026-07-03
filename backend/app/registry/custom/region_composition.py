"""Region composition — cell-type mix per region, for region comparison (post-build
spec Part 6.2.B). No dedicated squidpy/scanpy plotting function renders a two-categorical
crosstab, so this pairs a compute step (`pandas.crosstab` + `scipy.stats.chi2_contingency`,
both existing deps — no new library per Part 6's constraint) with a plot step that reads
the same `uns` key, mirroring the compute-writes/plot-reads convention every squidpy
metric already uses (e.g. `nhood_enrichment`)."""
from __future__ import annotations

from ..base import CallResult, Function, ParamSpec, capture_log, render_plot, run_compute

_REGION_PARAM = ParamSpec(
    "region_key", {"type": "string"}, "obs_categorical", "obs_categorical", required=True,
    tooltip="Region set (categorical obs column) to compare across")
_CELL_TYPE_PARAM = ParamSpec(
    "cell_type_key", {"type": "string"}, "obs_categorical", "obs_categorical", required=True,
    tooltip="Categorical obs column (cell types/clusters) to break down by region")


def _uns_key(region_key: str, cell_type_key: str) -> str:
    return f"{region_key}__{cell_type_key}_composition"


class RegionComposition(Function):
    source = "custom"
    key = "custom.region_composition"
    namespace = "custom"
    function = "region_composition"
    effect_class = "compute"
    label = "Region composition"
    summary = "Cell-type proportions per region (crosstab + chi-square test)."
    doc = """Region composition

Cross-tabulate a region set against a cell-type/cluster column: counts and
row-normalized proportions per region, plus a chi-square test of independence
over the counts table. Results are stored in `uns` for the matching
"Region composition (plot)" step to render.

Parameters
----------
region_key
    Region set (categorical obs column) forming the rows.
cell_type_key
    Cell-type/cluster column (categorical obs column) forming the columns.
"""
    params = [_REGION_PARAM, _CELL_TYPE_PARAM]

    def execute(self, params: dict, session) -> CallResult:
        import pandas as pd
        from scipy.stats import chi2_contingency

        region_key = params.get("region_key")
        cell_type_key = params.get("cell_type_key")
        adata = session.active_table()
        if region_key not in adata.obs.columns:
            return CallResult(status="failed", error=f"obs['{region_key}'] does not exist")
        if cell_type_key not in adata.obs.columns:
            return CallResult(status="failed", error=f"obs['{cell_type_key}'] does not exist")

        def mutate(ad):
            counts = pd.crosstab(ad.obs[region_key], ad.obs[cell_type_key])
            proportions = counts.div(counts.sum(axis=1), axis=0)
            statistic, p_value, dof, _ = chi2_contingency(counts.values)
            ad.uns[_uns_key(region_key, cell_type_key)] = {
                "regions": counts.index.astype(str).tolist(),
                "cell_types": counts.columns.astype(str).tolist(),
                "counts": counts.values.tolist(),
                "proportions": proportions.values.tolist(),
                "chi2": {"statistic": float(statistic), "p_value": float(p_value), "dof": int(dof)},
            }

        return run_compute(session, mutate)


class RegionCompositionPlot(Function):
    source = "custom"
    key = "custom.region_composition_plot"
    namespace = "custom"
    function = "region_composition_plot"
    effect_class = "plot"
    label = "Region composition (plot)"
    summary = "Stacked bar of cell-type proportions per region."
    doc = """Region composition (plot)

Stacked bar chart of the cell-type proportions computed by "Region
composition" for the same region_key/cell_type_key pair. Run that step first.

This is a single-section comparison (n=1 per region): the chi-square p-value
is descriptive, not a between-condition inferential test (spec Part 6.5).

Parameters
----------
region_key
    Region set used as the "Region composition" step's rows.
cell_type_key
    Cell-type/cluster column used as the "Region composition" step's columns.
"""
    params = [_REGION_PARAM, _CELL_TYPE_PARAM]

    def execute(self, params: dict, session) -> CallResult:
        region_key = params.get("region_key")
        cell_type_key = params.get("cell_type_key")
        adata = session.active_table()
        key = _uns_key(region_key, cell_type_key)
        if key not in adata.uns:
            return CallResult(status="failed",
                              error=f"run 'Region composition' for these keys first (uns['{key}'] not found)")

        def fn(ad):
            import pandas as pd

            data = ad.uns[key]
            proportions = pd.DataFrame(data["proportions"], index=data["regions"], columns=data["cell_types"])
            ax = proportions.plot(kind="bar", stacked=True, figsize=(7, 4))
            ax.set_ylabel("Proportion of cells")
            ax.set_xlabel(region_key)
            p_value = data["chi2"]["p_value"]
            ax.set_title(
                f"Cell-type composition by region (χ² p={p_value:.3g})\n"
                "Single-section comparison — descriptive, not inferential (n=1 per region)",
                fontsize=9)
            ax.legend(title=cell_type_key, bbox_to_anchor=(1.02, 1), loc="upper left", fontsize=7)
            return ax

        with capture_log() as buf:
            return render_plot(fn, [adata], {}, buf)
