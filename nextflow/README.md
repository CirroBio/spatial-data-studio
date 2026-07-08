# Offline analysis workflow (Nextflow)

A DSL2 workflow that runs a spatial-omics recipe over an input dataset by wrapping
the repo's headless CLI, `backend/cli.py`. It reads raw data (or an existing
SpatialData store), runs a recipe end-to-end, and publishes the resulting
`.zarr.zip` plus any per-step plots.

The workflow does **not** reimplement any analysis: it stages `backend/`, installs
the pinned Python deps at runtime with [uv](https://docs.astral.sh/uv/), and invokes
`cli.py` exactly as documented in that file.

## Quick run (test profile + docker)

Runs the bundled `01_neighborhood_enrichment` recipe over the bundled
`test-data/visium_hne.zarr` store:

```bash
nextflow run nextflow/main.nf -profile test,docker
```

Output lands in `./results/analysis/` (see [Output layout](#output-layout)).

## Real run: raw Xenium bundle

```bash
nextflow run nextflow/main.nf -profile docker \
    --parser io.xenium \
    --input  /path/to/xenium_bundle \
    --recipe backend/app/recipes/06_preprocess_cluster_raw_counts.json \
    --name   my_xenium_sample \
    --outdir results
```

`--recipe` accepts either a path to a recipe JSON file or the name of a bundled
recipe. `--parser` accepts a reader registry key (`io.xenium`, `io.visium`,
`io.visium_hd`, `io.merscope`, `io.cosmx`, `io.steinbock`, `io.mcmicro`,
`io.curio`), a bare reader name (`xenium`), or the sentinel `zarr` / `spatialdata`
to load an existing `.zarr` / `.zarr.zip`.

Extra reader kwargs can be passed as a JSON object:

```bash
    --reader_params '{"cells_boundaries": true}'
```

## Parameters

| Param             | Default                                             | Description |
| ----------------- | --------------------------------------------------- | ----------- |
| `--input`         | — (required)                                        | Raw data folder (reader mode) or `.zarr`/`.zarr.zip` (zarr mode). |
| `--recipe`        | — (required)                                        | Recipe JSON file path, or a bundled recipe name. |
| `--parser`        | — (required)                                        | Reader key (`io.xenium`), bare name (`xenium`), or `zarr`/`spatialdata`. |
| `--name`          | `null` (derived from `--input`)                     | Base name for the output `<name>.zarr.zip`. |
| `--reader_params` | `null`                                              | JSON object of extra reader kwargs (reader mode only). |
| `--os_packages`   | `null`                                              | Apt packages to install at runtime before the run (see OS libraries). |
| `--outdir`        | `results`                                           | Publish directory for the output. |
| `--backend`       | `${projectDir}/../backend`                          | Path to the repo `backend/` tree (`cli.py` + `app/`). |

Profiles:

- `docker` — runs the process in the public uv image
  `ghcr.io/astral-sh/uv:python3.11-bookworm` (`docker.enabled = true`).
- `test` — sets `--parser zarr`, `--input` to the bundled `visium_hne.zarr`, and
  `--recipe` to the bundled `01_neighborhood_enrichment.json`. Combine with
  `docker`: `-profile test,docker`.

## uv-at-runtime rationale

There is no custom Docker image to build or maintain. The process runs in the
public, upstream uv image (or on the host, if you drop the `docker` profile) and,
on each run, creates a venv with `uv venv --python 3.11` and installs
`backend/requirements.txt` with `uv pip install`. uv caches downloaded wheels and
built packages, so the install is only expensive the first time and is fast on
subsequent runs that reuse the cache.

Cache note: under the `docker` profile each task runs in a fresh container, so the
uv cache is not shared across containers unless you mount a persistent cache
directory (e.g. via `docker.runOptions = '-v $HOME/.cache/uv:/root/.cache/uv'`).
Running without the `docker` profile uses the host uv cache in `~/.cache/uv`
directly.

## Python 3.11 constraint

squidpy does not support Python 3.13+. The venv is pinned to Python 3.11 both by
the base image tag (`python3.11-bookworm`) and by `uv venv --python 3.11`, which
downloads a matching interpreter when the host lacks one.

## OS libraries

The uv base image is Debian bookworm-slim and lacks some OS libraries that certain
image-backed squidpy functions need at runtime: `libgl1`, `libglib2.0-0`,
`libgomp1` (the same set installed in `docker/Dockerfile`). Pure compute/plot
recipes — including the `test` recipe — do not need them.

If a recipe hits a function that does, install them at runtime with `--os_packages`
(the container runs as root under the docker executor):

```bash
nextflow run nextflow/main.nf -profile docker \
    --os_packages 'libgl1 libglib2.0-0 libgomp1' \
    --parser io.xenium --input /path/to/xenium_bundle \
    --recipe backend/app/recipes/06_preprocess_cluster_raw_counts.json
```

## Output layout

The published `--outdir` contains a single `analysis/` directory produced by
`cli.py`:

```
results/
  analysis/
    <name>.zarr.zip                       # full SpatialData object + app_state
    plots/
      <NN>_<namespace>.<function>/
        figure.svg
        figure.pdf
```

One `plots/<NN>_...` folder is written per plot step in the recipe; compute-only
recipes produce just the `.zarr.zip`.
