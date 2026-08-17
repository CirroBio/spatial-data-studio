"""Cellular Neighborhoods — cluster cells into recurring multicellular niches
(Schürch/Bhate-style CN analysis) from spatial windows of cell-type composition.
Wraps the vendored `_vendor/cn_compute.py` / `_vendor/cn_plot.py`."""
from __future__ import annotations

import pandas as pd

from ..base import CallResult, Function, ParamSpec, missing_obs_column, run_compute, run_plot

_COMPUTE_DOC = """Cellular Neighborhoods

Partition the tissue into recurring multicellular niches: for each cell, take
its spatial window (its `n_neighs` nearest neighbors), summarize the window as
a vector of cell-type proportions, and group those vectors with Leiden community
detection. Cells in the same group sit in the same kind of neighborhood even if
they are far apart in the tissue. The number of neighborhoods is not fixed up
front — `resolution` sets how finely the compositions are split. Writes a
categorical CN label per cell, the per-cell composition matrix, and
per-neighborhood enrichment/composition summary tables for the paired plot step.

Parameters
----------
cell_type_key
    Categorical obs column of cell-type/cluster calls.
library_key
    Categorical obs column of sample/slide ids; windows are built within each
    sample only. Leave blank for a single sample.
n_neighs
    Window size — number of nearest neighbors (including self) per cell.
resolution
    Leiden resolution; higher values yield more, smaller neighborhoods.
    Composition space is far more modular than expression space, so useful values
    sit well below the 1.0 customary for clustering cells: the 0.1 default lands
    around ten neighborhoods on a typical slide.
n_neighbors
    Neighborhood size of the kNN graph Leiden runs on, built over the window
    composition vectors.
n_iterations
    Number of Leiden refinement iterations over that graph.
random_state
    Seed for reproducible clustering.
key_added
    Name of the obs column to write neighborhood labels into (also the uns key
    holding the enrichment/composition tables).
"""

_PLOT_DOC = """Cellular Neighborhoods (plot)

Dashboard for a "Cellular Neighborhoods" run: the spatial map of neighborhoods,
a log2 enrichment heatmap (cell type x neighborhood), and stacked composition
bars. Run "Cellular Neighborhoods" first with the same `key_added`.

Parameters
----------
key_added
    obs/uns key used by the "Cellular Neighborhoods" step to run.
"""


def _serialize_table(df: pd.DataFrame) -> dict:
    return {"values": df.values.tolist(), "index": df.index.astype(str).tolist(),
            "columns": df.columns.astype(str).tolist()}


def _deserialize_table(data: dict) -> pd.DataFrame:
    return pd.DataFrame(data["values"], index=data["index"], columns=data["columns"])


class _CNResultView:
    """Lightweight stand-in for CNResult, rebuilt from `adata.uns[key_added]` so
    the plot step doesn't need the live composition matrix."""

    def __init__(self, labels, enrichment, mean_composition, celltype_order):
        self.labels = labels
        self.enrichment = enrichment
        self.mean_composition = mean_composition
        self.celltype_order = celltype_order


from ._docs import custom_doc

_CITATION = ("Schurch, C.M. et al. Coordinated Cellular Neighborhoods Orchestrate Antitumoral "
             "Immunity at the Colorectal Cancer Invasive Front. Cell 182, 1341-1359 (2020). "
             "doi:10.1016/j.cell.2020.07.005. Window compositions are grouped by Leiden "
             "community detection (Traag, Waltman & van Eck, Sci Rep 9:5233, 2019) in place "
             "of the paper's k-means step.")
_DOC = custom_doc("cellular-neighborhoods")


class CellularNeighborhoods(Function):
    source = "custom"
    key = "custom.cellular_neighborhoods"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "cellular_neighborhoods"
    effect_class = "compute"
    label = "Cellular Neighborhoods"
    summary = "Cluster cells into recurring multicellular niches by window composition."
    doc = _COMPUTE_DOC

    params = [
        ParamSpec("cell_type_key", {"type": "string"}, "obs_categorical", None,
                  required=True, tooltip="cell-type/cluster column to build window compositions from"),
        ParamSpec("library_key", {"type": "string"}, "obs_categorical", None,
                  required=False, tooltip="sample/slide column (blank = single sample); windows stay within a sample"),
        ParamSpec("n_neighs", {"type": "integer", "default": 20}, "number", None,
                  required=False, tooltip="window size (nearest neighbors per cell, including self)"),
        ParamSpec("resolution", {"type": "number", "default": 0.1}, "number", None,
                  required=False, tooltip="higher = more, smaller neighborhoods"),
        ParamSpec("n_neighbors", {"type": "integer", "default": 15}, "number", None,
                  required=False, tooltip="kNN graph size over window compositions, for Leiden"),
        ParamSpec("n_iterations", {"type": "integer", "default": 2}, "number", None,
                  required=False, tooltip="Leiden refinement iterations"),
        ParamSpec("random_state", {"type": "integer", "default": 0}, "number", None,
                  required=False, tooltip="random seed"),
        ParamSpec("key_added", {"type": "string", "default": "cellular_neighborhood"}, "text", None,
                  required=True, tooltip="obs/uns key to write neighborhood results into", role="output"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        cell_type_key = params.get("cell_type_key")
        library_key = (params.get("library_key") or "").strip() or None
        n_neighs = int(params.get("n_neighs") or 20)
        resolution = float(params.get("resolution") or 0.1)
        n_neighbors = int(params.get("n_neighbors") or 15)
        n_iterations = int(params.get("n_iterations") or 2)
        random_state = int(params.get("random_state") or 0)
        key_added = (params.get("key_added") or "cellular_neighborhood").strip()

        adata = session.active_table()
        error = missing_obs_column(adata, cell_type_key)
        if not error and library_key:
            error = missing_obs_column(adata, library_key)
        if not error and "spatial" not in adata.obsm:
            error = "obsm['spatial'] does not exist"
        if error:
            return CallResult(status="failed", error=error)

        def mutate(ad):
            from ._vendor.cn_compute import cellular_neighborhoods_adata

            cellular_neighborhoods_adata(
                ad, cell_type_key,
                spatial_key="spatial", library_key=library_key,
                n_neighs=n_neighs, resolution=resolution,
                cluster_n_neighbors=n_neighbors, n_iterations=n_iterations,
                random_state=random_state, key_added=key_added,
            )
            tables = ad.uns[key_added]
            ad.uns[key_added] = {
                "enrichment": _serialize_table(tables["enrichment"]),
                "mean_composition": _serialize_table(tables["mean_composition"]),
                "celltype_order": list(tables["celltype_order"]),
                "params": tables["params"],
            }

        return run_compute(session, mutate)


class CellularNeighborhoodsPlot(Function):
    source = "custom"
    key = "custom.cellular_neighborhoods_plot"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "cellular_neighborhoods_plot"
    effect_class = "plot"
    label = "Cellular Neighborhoods (plot)"
    summary = "Neighborhood map, enrichment heatmap, and composition bars."
    doc = _PLOT_DOC

    params = [
        ParamSpec("key_added", {"type": "string", "default": "cellular_neighborhood"}, "obs_categorical",
                  None, required=True,
                  tooltip="obs/uns key from a previous 'Cellular Neighborhoods' run"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        key_added = (params.get("key_added") or "cellular_neighborhood").strip()
        adata = session.active_table()
        if key_added not in adata.obs.columns or key_added not in adata.uns:
            return CallResult(status="failed",
                              error=f"run 'Cellular Neighborhoods' with key_added='{key_added}' first")

        def fn(ad):
            from ._vendor.cn_plot import plot_summary

            data = ad.uns[key_added]
            labels = ad.obs[key_added].astype(str).str.slice(2).astype(int).to_numpy()
            result = _CNResultView(
                labels=labels,
                enrichment=_deserialize_table(data["enrichment"]),
                mean_composition=_deserialize_table(data["mean_composition"]),
                celltype_order=data["celltype_order"],
            )
            return plot_summary(result, coords=ad.obsm["spatial"], figsize=(15, 5))

        return run_plot(session, fn)
