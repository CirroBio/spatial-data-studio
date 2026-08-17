# Batch Xenium workflow (Nextflow)

Analyse several raw Xenium bundles in one run and publish two things: a MultiQC report
comparing them, and a self-contained folder that renders every result in the browser.

Like the single-dataset workflow next door (`../main.nf`), this does not reimplement any
analysis. Each sample is one `backend/cli.py` invocation running three **bundled recipes**
back to back in a single session:

| Recipe | What it does |
| ------ | ------------ |
| `01_xenium_preprocess_qc.json`   | QC metrics → drop low-count cells and rare genes → normalize → log1p → PCA → neighbors → UMAP |
| `02_leiden_cluster_markers.json` | Leiden clustering → ranked marker genes per cluster → dotplot |
| `04_neighborhood_analysis.json`  | cellular neighborhoods (niches) from each cell's local cluster composition → neighborhood plot |

The neighborhood step is pointed at the clusters the step before it produced, so
`--cluster_key` names both the Leiden output column and the labels the niches are built
from.

## Quick run (test profile + docker)

```bash
nextflow run nextflow/xenium/main.nf -profile test,docker
```

The `test` profile points `--input` at `test-data/_xenium_raw/lung_2fov`, the 10x
"Human Lung (2 FOV)" bundle that `scripts/prepare_xenium_data.py` downloads — run that
script first, since `test-data/` is not committed.

## Real run

```bash
nextflow run nextflow/xenium/main.nf -profile docker \
    --input  /data/xenium/sample_A,/data/xenium/sample_B,/data/xenium/sample_C \
    --outdir results \
    --title  'Lung cohort' \
    --resolution 0.8 \
    --n_neighborhoods 12
```

`--input` is a comma-separated list of Xenium output folders (the ones holding
`cells.parquet`, `cell_feature_matrix.h5`, `experiment.xenium`, …). **Each folder's own
name becomes the sample name**, so those names must be unique across the list and made
only of letters, digits, `.`, `_` and `-`; the run stops up front if they are not.

## Parameters

| Param                | Default                     | Description |
| -------------------- | --------------------------- | ----------- |
| `--input`            | — (required)                | Comma-separated Xenium bundle folders. |
| `--outdir`           | `results`                   | Publish directory. |
| `--title`            | `Xenium analysis`           | Names the viewer collection and the MultiQC report. |
| `--min_counts`       | `10`                        | Drop cells with fewer than this many total transcripts. |
| `--min_cells`        | `5`                         | Drop genes detected in fewer than this many cells. |
| `--cluster_key`      | `leiden`                    | obs column the Leiden labels are written to, and the labels the niches are built from. |
| `--resolution`       | `1.0`                       | Leiden resolution: higher = more, smaller clusters. |
| `--marker_method`    | `wilcoxon`                  | DE test ranking the markers (`wilcoxon`, `t-test`, `t-test_overestim_var`, `logreg`). |
| `--n_marker_genes`   | `5`                         | Top markers per cluster in the dotplot. |
| `--n_neighborhoods`  | `10`                        | Recurring neighborhoods (niches) to find. |
| `--neighborhood_key` | `cellular_neighborhood`     | obs column the niche labels are written to. |
| `--lowres_copy`      | `false`                     | Also emit a low-resolution copy of each checkpoint (see below). |
| `--reader_params`    | `null`                      | JSON object of extra kwargs for the `io.xenium` reader. |
| `--os_packages`      | `libgl1 libglib2.0-0 libgomp1` | Apt packages installed before the run (see below). |
| `--backend`          | `${projectDir}/../../backend`       | Repo `backend/` tree (`cli.py` + `app/`, which carries the recipes). |
| `--viewer_dist`      | `${projectDir}/../../frontend/dist` | A built viewer SPA (see below). |
| `--multiqc_container`| `quay.io/biocontainers/multiqc:1.35--pyhdfd78af_1` | Image the report is rendered in. |

Profiles: `docker` enables Docker (each process declares its own image, so nothing else
is needed); `test` sets `--input` to the bundled lung sample and trims the analysis
task's cpus/memory.

## The viewer has to be built first

This workflow does not build the SPA — the repo already builds it in two other places
(the docs site and the Docker image), and a third build path would be one too many.
Build it once at the repo root:

```bash
npm ci && npm run build
```

That writes `frontend/dist`, which is what `--viewer_dist` defaults to. The run stops
immediately with a message if there is no `index.html` there.

## Output layout

```
results/
  viewer/
    index.html                  # the built SPA, unchanged
    assets/…
    index.json                  # the manifest listing the checkpoints below
    <sample>.sdata.zarr.zip     # one session checkpoint per input folder
    <sample>.sdata.lowres.zarr.zip   # only with --lowres_copy
  multiqc/
    multiqc_report.html
    multiqc_report_data/        # the parsed numbers behind the report
  plots/
    <sample>/
      13_sc.pl.rank_genes_groups_dotplot/figure.{svg,pdf}
      15_custom.cellular_neighborhoods_plot/figure.{svg,pdf}
```

With `--lowres_copy`, each sample also gets a `<sample>.sdata.lowres.zarr.zip` next to
its full checkpoint, and both are listed in `index.json`.

`results/viewer/` is a complete serverless deployment (DESIGN §14.3): serve that one
directory over HTTP — any static host — and `index.html` reads the checkpoints next to
it directly, with no backend. Opening it lists the collection; picking a sample opens
it. `?checkpoint=<name>.sdata.zarr.zip` links straight to one. The same `.zarr.zip`
files also open in the full app (New Session → Load) when compute is needed.

The plot folders are numbered by the step's position in the combined recipe chain, so
the numbering is stable as long as the recipes are.

## The low-resolution copy

`--lowres_copy` writes a second checkpoint per sample whose images have lost their
finest pyramid level; the remaining levels are renumbered from `scale0`. The image
pyramid is the largest part of a Xenium checkpoint — its finest level alone is around
three quarters of the image data — so the copy carries the whole analysis (cells,
clusters, neighborhoods, boundaries, transcripts, plots, history) at a fraction of the
size, and renders identically until you zoom past the level it no longer has.

Nothing is resampled. Each kept level already stores its own transform to the
coordinate system, so the trimmed pyramid occupies exactly the same world extent and
the cells still land on the image. Label masks are left at full resolution: they are
long runs of a few integer values and compress hard enough that their finest level is
not worth dropping.

How much smaller depends on how much of the checkpoint is image — a bundle dominated by
a large multi-channel morphology image shrinks far more than one dominated by
transcripts.

## Report contents

`bin/xenium_metrics.py` runs after each sample's analysis and writes MultiQC custom
content; MultiQC merges the per-sample files into cross-sample sections:

- **General Statistics** — cells, median transcripts/cell, genes, clusters, niches.
- **Xenium run metrics** — selected fields from the instrument's own
  `metrics_summary.csv`, before any analysis. Skipped for a bundle that has no such file.
- **Analysis summary** — cells and panel genes surviving the QC filter, the fraction of
  detected cells that survived, median depth, and the cluster/niche counts.
- **Cells per Leiden cluster** and **Cells per cellular neighborhood** — size
  distributions. Cluster numbering is per sample and is not matched across samples.

The script reads only `obs` and `var` out of the checkpoint (through zarr's ZipStore),
so it costs a couple of dataframes rather than unpacking the whole archive.

## uv-at-runtime, OS libraries, Python 3.11

Same as the single-dataset workflow — see [`../README.md`](../README.md) for the
rationale and the uv cache note. One difference: because a Xenium bundle always carries
a morphology image, `--os_packages` defaults to `libgl1 libglib2.0-0 libgomp1` here
instead of being empty. A failed install stops the task rather than falling through to
a confusing `ImportError` later.

To run without the `docker` profile — on a host that has no `apt-get` — turn the
install off. Nextflow drops an empty value given on the command line, so this has to go
through a config file rather than `--os_packages ''`:

```bash
echo "params.os_packages = ''" > no-pkgs.config
nextflow run nextflow/xenium/main.nf -profile test -c no-pkgs.config
```
