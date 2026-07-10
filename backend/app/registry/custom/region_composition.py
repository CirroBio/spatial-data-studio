"""Region composition — cell-type mix per region, for region comparison (post-build
spec Part 6.2.B). A single plot step cross-tabulates the two categorical obs columns
(`pandas.crosstab`), row-normalizes to per-region proportions, runs a chi-square test
of independence (`scipy.stats.chi2_contingency`) for the title, and renders a stacked
bar — all existing deps, no new library per Part 6's constraint."""
from __future__ import annotations

from ..base import CallResult, Function, ParamSpec, capture_log, missing_obs_column, render_plot

_REGION_PARAM = ParamSpec.obs_categorical(
    "region_key", required=True,
    tooltip="Region set (categorical obs column) to compare across")
_CELL_TYPE_PARAM = ParamSpec.obs_categorical(
    "cell_type_key", required=True,
    tooltip="Categorical obs column (cell types/clusters) to break down by region")

from ._docs import custom_doc

_CITATION = ("Original method implemented in this repository (per-region cell-type crosstab with "
             "a chi-square test of independence).")
_DOC = custom_doc("region-composition")


class RegionComposition(Function):
    source = "custom"
    key = "custom.region_composition"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "region_composition"
    effect_class = "plot"
    label = "Region composition"
    summary = "Stacked bar of cell-type proportions per region (crosstab + chi-square test)."
    doc = """Region composition

Stacked bar chart of cell-type proportions per region. Cross-tabulates a region
set against a cell-type/cluster column, row-normalizes to per-region proportions,
and runs a chi-square test of independence over the counts for the plot title.

This is a single-section comparison (n=1 per region): the chi-square p-value is
descriptive, not a between-condition inferential test (spec Part 6.5).

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
        error = missing_obs_column(adata, region_key) or missing_obs_column(adata, cell_type_key)
        if error:
            return CallResult(status="failed", error=error)

        def fn(ad):
            counts = pd.crosstab(ad.obs[region_key], ad.obs[cell_type_key])
            proportions = counts.div(counts.sum(axis=1), axis=0)
            _, p_value, _, _ = chi2_contingency(counts.values)
            ax = proportions.plot(kind="bar", stacked=True, figsize=(7, 4))
            ax.set_ylabel("Proportion of cells")
            ax.set_xlabel(region_key)
            ax.set_title(
                f"Cell-type composition by region (χ² p={p_value:.3g})\n"
                "Single-section comparison — descriptive, not inferential (n=1 per region)",
                fontsize=9)
            ax.legend(title=cell_type_key, bbox_to_anchor=(1.02, 1), loc="upper left", fontsize=7)
            return ax

        with capture_log() as buf:
            return render_plot(fn, [adata], {}, buf)
