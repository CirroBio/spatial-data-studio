# Spatial data workflow (Nextflow)

Point it at a folder. It finds the spatial datasets inside — Xenium, Visium, Visium HD,
MERSCOPE, CosMx, Curio, Steinbock, MCMICRO — loads each with the right reader, runs that
data type's preprocessing recipes, and publishes the results in a tree mirroring where
they were found, plus a MultiQC report over the whole run and a browsable viewer.

This is the repo's only workflow entrypoint.

```bash
nextflow run nextflow/main.nf -profile docker --input /data/experiments
```

## How it decides what to do

Nothing in `main.nf` knows about any particular data type. Recognition patterns, reader
names, preprocessing recipes and which parameter applies to which type all live in
[`data_types.json`](data_types.json), which conforms to
[`data_types.schema.json`](data_types.schema.json). Adding support for a format is an
edit to that one file.

| Data type | Recognised by | Preprocessing |
| --------- | ------------- | ------------- |
| 10x Xenium | `experiment.xenium` | QC → filter → normalize → log1p → PCA → neighbors → UMAP (2D + 3D) → Leiden → markers → cellular neighborhoods |
| 10x Visium HD | `binned_outputs/`, `segmented_outputs/`, `*feature_slice.h5` | scanpy Visium path (with HVG selection) → cellular neighborhoods |
| 10x Visium | `spatial/scalefactors_json.json` + a count matrix, and *not* `binned_outputs/` | as Visium HD |
| Vizgen MERSCOPE | `detected_transcripts.csv` + `cell_by_gene.csv`/`cell_metadata.csv` | as Xenium (same modality: targeted panel, cell resolution) |
| NanoString CosMx | `*exprMat_file.csv`, `*metadata_file.csv`, `*fov_positions_file.csv` | as Xenium |
| Curio Seeker | `anndata.h5ad` + `Metrics.csv`/`cluster_assignment.txt` | as Visium (whole transcriptome) |
| Steinbock | `cells.h5ad` + `ome/` + a masks folder | z-score → PCA → neighbors → Leiden → UMAP, then neighborhoods |
| MCMICRO | `quantification/` + `markers.csv` + `registration/`/`dearray/` | as Steinbock |

Steinbock and MCMICRO measure **protein intensity**, not transcript counts, so they take
a path with no `normalize_total`/`log1p` and no highly-variable-gene selection — those
assume counts. See `backend/app/recipes/25_cluster_protein_intensities.json`.

**Only the Xenium defaults have been executed against real data.** Every other entry
carries `"validated": false` in the catalog: its patterns and recipe are reasoned from
`spatialdata_io`'s own format constants and the standard analysis path for the modality,
but no run has proven them. Treat them as a starting point.

### Discovery

With `--recurse` (the default) the input tree is walked and every folder matching a
catalogued type becomes a dataset. Matching is **greedy** — a folder that is recognised
is not descended into, so a format that nests its own sub-outputs yields one dataset
rather than several. When two types match the same folder the more specific one wins, so
a Visium HD run does not also register as the Visium-shaped matrix it contains.

With `--recurse false` each input root is expected to be a dataset itself.

## Two ways to specify input

**A folder.** Output paths are relative to it, so the layout does not change if you pass
the same tree by a different path:

```bash
nextflow run nextflow/main.nf -profile docker --input /data/experiments
```

```
/data/experiments/folderA/folderB/{experiment.xenium, …}
  -> results/results/folderA/folderB.sdata.zarr.zip
```

**A map of roots**, as `.json` or `.yaml`, when the data lives in several unrelated
places and you want one organised output tree. The key is the output prefix and fully
replaces the root's own path; anything found by recursion nests beneath it:

```json
{
  "folderA": "s3://path/to/folderA/",
  "folderB/folderC": "s3://someother/completely/different/path/to/folder/B/"
}
```

```
-> results/results/folderA.sdata.zarr.zip
   results/results/folderB/folderC.sdata.zarr.zip
```

Roots may be local paths or `s3://`, `gs://`, `az://` — discovery goes through Nextflow's
own `file()` API, so it uses whatever credentials the executor already has.

## Output layout

```
results/
  index.html                       # the viewer, at the publish root
  assets/…
  index.json                       # lists every checkpoint below
  results/                         # mirrors where each dataset was found
    folderA/
      folderB.sdata.zarr.zip           # the full checkpoint
      folderB.sdata.lowres.zarr.zip    # image pyramid capped (see below)
      folderB.log                      # always written
      folderB.plots/<NN>_<ns>.<fn>/figure.{svg,pdf}
  multiqc/
    multiqc_report.html
    multiqc_report_data/
```

Serving the `results/` directory over HTTP — any static host — renders every dataset in
the browser with no backend (DESIGN §14.3). The same `.zarr.zip` files also open in the
full app (New Session → Load) when you need to compute on them.

**A dataset that fails to load does not fail the run.** Its log is published where its
checkpoint would have gone, it appears in the report's Datasets table as `failed`, and
the other datasets carry on. A broken environment (the dependency install) still stops
the task — that is not the data's fault.

### The low-resolution copy

Every checkpoint is published alongside a copy whose image pyramid has had its finest
levels dropped until the images fit under `--lowres_max_image_mb` (10 MB by default).
The image is the largest part of an imaging dataset, so the copy carries the whole
analysis — cells, clusters, neighborhoods, boundaries, plots, history — in a fraction of
the space, and renders identically until you zoom past the level it no longer has.

Nothing is resampled: each kept level already stores its own transform to the coordinate
system, so the trimmed pyramid occupies exactly the same world extent and the cells still
land on the image. Levels come off whichever image is largest, and at least one level of
each image always survives.

## Parameters

Full descriptions, types and defaults are in
[`nextflow_schema.json`](nextflow_schema.json). Analysis parameters are marked with the
data types they apply to, because not every knob is meaningful for every format — a
targeted panel has no highly-variable-gene step, a whole-transcriptome one has no
per-gene cell floor. A parameter is simply ignored by a type that does not use it.

| Param | Default | |
| ----- | ------- | --- |
| `--input` | — (required) | A folder, or a `.json`/`.yaml` map of output prefix to root. |
| `--outdir` | `results` | Publish directory. |
| `--title` | `Spatial data analysis` | Names the viewer collection and the report. |
| `--data_types` | all | Comma-separated ids to look for, e.g. `xenium,visium`. |
| `--recurse` | `true` | Walk into subfolders. |
| `--preprocess` | `true` | Run each type's recipes. Off loads and publishes unanalysed. |
| `--lowres_max_image_mb` | `10` | Image budget for the low-res copy. |
| `--min_reads_per_cell` | `10` | (Xenium, MERSCOPE, CosMx, Visium, Visium HD, Curio) |
| `--max_reads_per_cell` | `35000` | (Visium, Visium HD, Curio) |
| `--min_cells_per_gene` | `5` | (Xenium, MERSCOPE, CosMx) |
| `--n_top_genes` | `2000` | (Visium, Visium HD, Curio) |
| `--cluster_key` | `leiden` | (all) |
| `--resolution` | `1.0` | (Xenium, MERSCOPE, CosMx, Steinbock, MCMICRO) |
| `--marker_method` | `wilcoxon` | (Xenium, MERSCOPE, CosMx, Visium, Visium HD, Curio) |
| `--n_marker_genes` | `5` | (Xenium, MERSCOPE, CosMx) |
| `--n_neighborhoods` | `10` | (all) |
| `--neighborhood_key` | `cellular_neighborhood` | (all) |

Profiles: `docker` enables Docker (each process declares its own image); `test` points
`--input` at the bundled raw Xenium bundle that `scripts/prepare_xenium_data.py`
downloads, and trims the analysis task's resources.

```bash
nextflow run nextflow/main.nf -profile test,docker
```

## The viewer has to be built first

The workflow does not build the SPA — the repo already builds it in two other places
(the docs site and the Docker image), and a third build path would be one too many:

```bash
npm ci && npm run build
```

That writes `frontend/dist`, which `--viewer_dist` defaults to. The run stops
immediately if there is no `index.html` there.

## uv at runtime

The analysis container is the public `uv` image; the pinned Python dependencies
(`backend/requirements.txt`) are installed into a venv at runtime and `backend/` is
staged in, so there is no custom image to build. uv caches wheels, so only the first run
pays for the install — though under the `docker` profile each task gets a fresh
container, so mount a persistent cache to share it:

```groovy
docker.runOptions = '-v $HOME/.cache/uv:/root/.cache/uv'
```

squidpy does not support Python 3.13+, so the venv is pinned to 3.11 both by the image
tag and by `uv venv --python 3.11`.

Because every supported type carries images, `--os_packages` installs
`libgl1 libglib2.0-0 libgomp1` by default. To run without the `docker` profile on a host
that has no `apt-get`, turn it off — Nextflow drops an empty value given on the command
line, so this has to go through a config file:

```bash
echo "params.os_packages = ''" > no-pkgs.config
nextflow run nextflow/main.nf -profile test -c no-pkgs.config
```

## Tests

```bash
python nextflow/tests/check_catalog.py
```

Validates the catalog against its schema, checks every recipe it names exists, verifies
that each parameter's `applies_to` really is the set of types whose recipes declare it,
checks the parameters agree across `nextflow.config` and `nextflow_schema.json`, and runs
discovery over a synthetic tree of every catalogued type. CI runs this alongside
`nextflow lint nextflow/`.
