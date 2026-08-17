"""Per-sample MultiQC custom-content sections for the Xenium workflow.

Reads two things and turns them into MultiQC `*_mqc.json` files: the instrument's own
`metrics_summary.csv` from the raw Xenium bundle, and the analysis result in the
checkpoint the CLI wrote. Every section is keyed by sample name, and MultiQC merges
files that share an `id`, so one section per topic ends up holding every sample.

The checkpoint is read through `zarr`'s ZipStore rather than
`persistence.store.load_spatialdata`: only `obs` and `var` are needed, and the loader
unpacks the whole archive first — for Xenium that is the morphology pyramid, gigabytes
of it, for two dataframes.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd
import zarr
from anndata.io import read_elem

# Columns of the instrument's metrics_summary.csv worth putting in front of a reader.
# The file carries ~50; the rest are segmentation-internal fractions and counts that
# say nothing about whether the run is usable. Absent ones are skipped, so this also
# tolerates the column set moving between Xenium Onboard Analysis versions.
RUN_METRICS = [
    "panel_name",
    "region_area",
    "num_cells_detected",
    "cells_per_100um2",
    "median_transcripts_per_cell",
    "median_genes_per_cell",
    "total_high_quality_decoded_transcripts",
    "decoded_transcripts_per_100um2",
    "fraction_transcripts_decoded_q20",
    "fraction_transcripts_assigned",
    "adjusted_negative_control_probe_rate",
    "estimated_number_of_false_positive_transcripts_per_cell",
]

GENERAL_STATS = [
    ("cells_retained", {"title": "Cells", "description": "Cells passing the QC filter",
                        "format": "{:,.0f}", "scale": "Blues"}),
    ("median_transcripts_per_cell", {"title": "Median txn/cell",
                                     "description": "Median transcripts per retained cell",
                                     "format": "{:,.0f}", "scale": "Greens"}),
    ("genes_retained", {"title": "Genes", "description": "Panel genes passing the QC filter",
                        "format": "{:,.0f}", "scale": "Purples"}),
    ("n_clusters", {"title": "Clusters", "description": "Leiden clusters",
                    "format": "{:,.0f}", "scale": "Oranges"}),
    ("n_neighborhoods", {"title": "Niches", "description": "Cellular neighborhoods",
                         "format": "{:,.0f}", "scale": "Reds"}),
]


def _parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--sample", required=True, help="sample name, used as the MultiQC sample key")
    p.add_argument("--checkpoint", required=True, help="the .zarr.zip the CLI wrote")
    p.add_argument("--xenium-dir", required=True, help="the raw Xenium bundle that was analysed")
    p.add_argument("--cluster-key", required=True, help="obs column holding the Leiden clusters")
    p.add_argument("--neighborhood-key", required=True,
                   help="obs column holding the cellular-neighborhood labels")
    p.add_argument("--outdir", default=".", help="where the *_mqc.json files are written")
    return p.parse_args()


def _read_table(checkpoint: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """`(obs, var)` of the checkpoint's single table."""
    with zarr.storage.ZipStore(checkpoint, mode="r") as store:
        tables = zarr.open_group(store, mode="r")["tables"]
        keys = list(tables)
        if len(keys) != 1:
            raise SystemExit(f"{checkpoint}: expected exactly one table, found {keys}")
        group = tables[keys[0]]
        return read_elem(group["obs"]), read_elem(group["var"])


def _column(obs: pd.DataFrame, name: str, checkpoint: str) -> pd.Series:
    if name not in obs.columns:
        raise SystemExit(f"{checkpoint}: no obs column {name!r} — the recipe step that "
                         f"writes it did not run. Present: {sorted(obs.columns)}")
    return obs[name]


def _run_metrics(xenium_dir: Path) -> dict:
    """The instrument's own summary, or `{}` when the bundle has none (a re-exported or
    trimmed bundle) — the analysis sections stand on their own without it."""
    path = xenium_dir / "metrics_summary.csv"
    if not path.is_file():
        return {}
    row = pd.read_csv(path).iloc[0]
    return {c: row[c] for c in RUN_METRICS if c in row.index and pd.notna(row[c])}


def _section(path: Path, doc: dict) -> None:
    path.write_text(json.dumps(doc, indent=2, default=float))


def main() -> int:
    args = _parse_args()
    outdir = Path(args.outdir)
    sample = args.sample

    obs, var = _read_table(args.checkpoint)
    run = _run_metrics(Path(args.xenium_dir))

    clusters = _column(obs, args.cluster_key, args.checkpoint).astype(str)
    niches = _column(obs, args.neighborhood_key, args.checkpoint).astype(str)

    analysis = {
        "cells_retained": len(obs),
        "genes_retained": len(var),
        "n_clusters": clusters.nunique(),
        "n_neighborhoods": niches.nunique(),
    }
    # total_counts / n_genes_by_counts come from the QC step, which runs before the
    # filter, so these are the per-cell values of the cells that survived it.
    if "total_counts" in obs.columns:
        analysis["median_transcripts_per_cell"] = obs["total_counts"].median()
    if "n_genes_by_counts" in obs.columns:
        analysis["median_genes_per_cell"] = obs["n_genes_by_counts"].median()
    detected = run.get("num_cells_detected")
    if detected:
        analysis["cells_detected"] = detected
        analysis["pct_cells_retained"] = 100.0 * len(obs) / detected

    _section(outdir / f"{sample}_xenium_general_stats_mqc.json", {
        "id": "xenium_general_stats",
        "plot_type": "generalstats",
        "pconfig": [{name: cfg} for name, cfg in GENERAL_STATS],
        "data": {sample: {name: analysis[name] for name, _ in GENERAL_STATS
                          if name in analysis}},
    })

    _section(outdir / f"{sample}_xenium_analysis_mqc.json", {
        "id": "xenium_analysis",
        "section_name": "Analysis summary",
        "description": "What the recipe chain produced per sample: cells and panel genes "
                       "left after QC filtering, their median depth, and how many Leiden "
                       "clusters and cellular neighborhoods were found.",
        "plot_type": "table",
        "pconfig": {"id": "xenium_analysis_table", "title": "Analysis summary"},
        "data": {sample: analysis},
    })

    if run:
        _section(outdir / f"{sample}_xenium_run_mqc.json", {
            "id": "xenium_run",
            "section_name": "Xenium run metrics",
            "description": "Selected fields from the instrument's own "
                           "<code>metrics_summary.csv</code>, before any analysis.",
            "plot_type": "table",
            "pconfig": {"id": "xenium_run_table", "title": "Xenium run metrics"},
            "data": {sample: run},
        })

    _section(outdir / f"{sample}_xenium_clusters_mqc.json", {
        "id": "xenium_clusters",
        "section_name": "Cells per Leiden cluster",
        "description": "Cluster sizes. Clusters are numbered per sample and are not "
                       "matched across samples — read this as a size distribution.",
        "plot_type": "bargraph",
        "pconfig": {"id": "xenium_clusters_plot", "title": "Cells per Leiden cluster",
                    "ylab": "Cells", "cpswitch_c_active": False},
        "data": {sample: clusters.value_counts().sort_index().to_dict()},
    })

    _section(outdir / f"{sample}_xenium_neighborhoods_mqc.json", {
        "id": "xenium_neighborhoods",
        "section_name": "Cells per cellular neighborhood",
        "description": "Sizes of the recurring niches found by clustering each cell's "
                       "local cell-type composition.",
        "plot_type": "bargraph",
        "pconfig": {"id": "xenium_neighborhoods_plot",
                    "title": "Cells per cellular neighborhood",
                    "ylab": "Cells", "cpswitch_c_active": False},
        "data": {sample: niches.value_counts().sort_index().to_dict()},
    })

    print(f"[ok] {sample}: {analysis['cells_retained']} cells, "
          f"{analysis['n_clusters']} clusters, {analysis['n_neighborhoods']} neighborhoods")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
