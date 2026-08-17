"""Per-dataset MultiQC custom-content sections.

Turns one analysed dataset into MultiQC `*_mqc.json` files: a status row that is
written whether or not the analysis succeeded, the instrument's own run summary when
the data type declares one, and what the recipes produced. MultiQC merges files that
share an `id`, so one section per topic ends up holding every dataset in the run.

Nothing here is specific to a data type. Which summary file to read and which of its
columns to surface arrive as `--run-metrics`, straight out of the catalog entry (see
data_types.schema.json); everything else is derived from the checkpoint itself.

The checkpoint is read through `zarr`'s ZipStore rather than
`persistence.store.load_spatialdata`: only `obs` and `var` are needed, and the loader
unpacks the whole archive first — for an imaging dataset that is the image pyramid,
gigabytes of it, for two dataframes.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd
import zarr
from anndata.io import read_elem

GENERAL_STATS = [
    ("cells", {"title": "Cells", "description": "Cells/spots passing the QC filter",
               "format": "{:,.0f}", "scale": "Blues"}),
    ("median_counts_per_cell", {"title": "Median counts", "description":
                                "Median transcripts per retained cell/spot",
                                "format": "{:,.0f}", "scale": "Greens"}),
    ("features", {"title": "Features", "description": "Genes/markers passing the QC filter",
                  "format": "{:,.0f}", "scale": "Purples"}),
    ("n_clusters", {"title": "Clusters", "description": "Clusters found",
                    "format": "{:,.0f}", "scale": "Oranges"}),
    ("n_neighborhoods", {"title": "Niches", "description": "Cellular neighborhoods found",
                         "format": "{:,.0f}", "scale": "Reds"}),
]


def _parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--sample", required=True, help="dataset name — its published path prefix")
    p.add_argument("--data-type", required=True, help="catalog id of the data type")
    p.add_argument("--status", required=True, choices=["ok", "failed"])
    p.add_argument("--checkpoint", help="the .zarr.zip that was written (status=ok)")
    p.add_argument("--source-dir", help="the data folder that was analysed (status=ok)")
    p.add_argument("--run-metrics", default=None,
                   help="the catalog's run_metrics block for this data type, as JSON")
    p.add_argument("--cluster-key", default=None, help="obs column holding cluster labels")
    p.add_argument("--neighborhood-key", default=None, help="obs column holding niche labels")
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


def _run_metrics(source_dir: Path, config: dict | None) -> dict:
    """The instrument's own summary, per the data type's `run_metrics` block. Empty when
    the type declares none, or the file is absent — a re-exported or trimmed folder is
    still perfectly analysable, so this is not an error."""
    if not config:
        return {}
    path = source_dir / config["file"]
    if not path.is_file():
        return {}
    # csv_first_row is the only format the schema admits: a header plus one row of
    # values, which is what both 10x and Vizgen write.
    row = pd.read_csv(path).iloc[0]
    return {c: row[c] for c in config["columns"] if c in row.index and pd.notna(row[c])}


def _section(outdir: Path, sample: str, name: str, doc: dict) -> None:
    # '/' is meaningful in a sample name (it is a published path) but not in a file name.
    token = sample.replace("/", "__") or "dataset"
    (outdir / f"{token}_{name}_mqc.json").write_text(json.dumps(doc, indent=2, default=float))


def _category_counts(series: pd.Series) -> dict:
    return series.astype(str).value_counts().sort_index().to_dict()


def main() -> int:
    args = _parse_args()
    outdir = Path(args.outdir)
    sample = args.sample

    status = {"data_type": args.data_type, "status": args.status}
    analysis: dict = {}

    if args.status == "ok":
        obs, var = _read_table(args.checkpoint)
        analysis["cells"] = len(obs)
        analysis["features"] = len(var)
        # These come from the QC step, which runs before the filter, so they describe
        # the cells that survived it.
        for column, metric in (("total_counts", "median_counts_per_cell"),
                               ("n_genes_by_counts", "median_features_per_cell")):
            if column in obs.columns:
                analysis[metric] = obs[column].median()

        run = _run_metrics(Path(args.source_dir),
                           json.loads(args.run_metrics) if args.run_metrics else None)
        if run:
            _section(outdir, sample, "run", {
                "id": "dataset_run",
                "section_name": "Instrument run metrics",
                "description": "Selected fields from the summary written by the instrument, "
                               "before any analysis. Columns differ by data type, so a cell is "
                               "blank where that field does not exist for that platform.",
                "plot_type": "table",
                "pconfig": {"id": "dataset_run_table", "title": "Instrument run metrics"},
                "data": {sample: run},
            })

        # Clustering/neighborhood columns are absent when --preprocess is off, which is
        # a supported mode rather than a failure — the sections simply do not appear.
        for key, metric, name, title in (
            (args.cluster_key, "n_clusters", "clusters", "Cells per cluster"),
            (args.neighborhood_key, "n_neighborhoods", "neighborhoods",
             "Cells per cellular neighborhood"),
        ):
            if not key or key not in obs.columns:
                continue
            labels = obs[key].astype(str)
            analysis[metric] = labels.nunique()
            _section(outdir, sample, name, {
                "id": f"dataset_{name}",
                "section_name": title,
                "description": f"{title}. Labels are assigned per dataset and are not "
                               "matched across datasets — read this as a size distribution.",
                "plot_type": "bargraph",
                "pconfig": {"id": f"dataset_{name}_plot", "title": title,
                            "ylab": "Cells", "cpswitch_c_active": False},
                "data": {sample: _category_counts(labels)},
            })

        _section(outdir, sample, "analysis", {
            "id": "dataset_analysis",
            "section_name": "Analysis summary",
            "description": "What the recipes produced per dataset: cells and features left "
                           "after QC filtering, their median depth, and how many clusters "
                           "and neighborhoods were found.",
            "plot_type": "table",
            "pconfig": {"id": "dataset_analysis_table", "title": "Analysis summary"},
            "data": {sample: analysis},
        })

        _section(outdir, sample, "general_stats", {
            "id": "dataset_general_stats",
            "plot_type": "generalstats",
            "pconfig": [{name: cfg} for name, cfg in GENERAL_STATS],
            "data": {sample: {name: analysis[name] for name, _ in GENERAL_STATS
                              if name in analysis}},
        })

    # Written last and unconditionally: on a failed dataset this is the only section,
    # so the report says which folders did not make it rather than quietly omitting them.
    _section(outdir, sample, "status", {
        "id": "dataset_status",
        "section_name": "Datasets",
        "description": "Every folder the run picked up, the data type it was recognised as, "
                       "and whether its analysis completed. A failed row has its log "
                       "published next to where its checkpoint would have gone.",
        "plot_type": "table",
        "pconfig": {"id": "dataset_status_table", "title": "Datasets"},
        "data": {sample: {**status, **{k: analysis[k] for k in ("cells", "n_clusters")
                                       if k in analysis}}},
    })

    print(f"[ok] {sample} ({args.data_type}): {args.status}"
          + (f", {analysis['cells']} cells" if "cells" in analysis else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
