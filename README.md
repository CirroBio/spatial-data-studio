# Spatial Data Studio

**Interactive analysis and visualization for spatial omics data — in the browser,
no code required.**

> ### Documentation → [cirrobio.github.io/spatial-data-studio][docs]
>
> [**User guide**](docs/USER_GUIDE.md) — everything the app does ·
> [**Live demos**][demos] — the real viewer, nothing to install ·
> [**Run with Docker**](docker/README.md) ·
> [**Development guide**](DEVELOPMENT.md)

[docs]: https://cirrobio.github.io/spatial-data-studio/
[demos]: https://cirrobio.github.io/spatial-data-studio/demo/

Open a spatial transcriptomics dataset (Xenium, Visium, Visium HD, CosMx, MERSCOPE, or
anything else [SpatialData](https://spatialdata.scverse.org/) can read), run
[`squidpy`](https://squidpy.readthedocs.io/) and
[`scanpy`](https://scanpy.readthedocs.io/) analyses on it through point-and-click forms,
and explore the result on a fast WebGL canvas that draws every cell over the tissue
image. It runs as a single local server you open in your browser.

![The spatial canvas showing a Xenium ovarian-cancer section, each cell colored by its cellular neighborhood, over the morphology image, with the left panel open on the Compute (history) tab.](./docs/images/hero.jpg)

*A whole Xenium ovarian-cancer section (~400,000 cells), colored by cellular
neighborhood.*

## Run it

The quickest way to try it on your own machine is the single Docker image:

```bash
python scripts/prepare_test_data.py     # writes test-data/visium_hne.zarr (~375 MB, needs squidpy)
docker compose up --build -d            # builds the SPA + backend into one image
open http://localhost:8080              # New Session -> /data/visium_hne.zarr
```

The compose file bind-mounts a single read-write data directory at `/data`, holding
inputs, saved checkpoints, and snapshots together. It defaults to `test-data/`; point it
at your own folder with `SDS_DATA_HOST_DIR` (env var or `.env` entry), e.g.
`SDS_DATA_HOST_DIR=/path/to/data docker compose up`. Memory limits, the manual
`docker run` form, and the full environment contract are in
[`docker/README.md`](docker/README.md). To run from source for development instead, see
[`DEVELOPMENT.md`](DEVELOPMENT.md#local-dev-environment).

## All the documentation

The site above is rendered from these files, so they read the same on GitHub.

For users:

- **[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md)** — what the app does: loading data,
  running analyses and recipes, the canvas and display settings, annotating and
  subsetting, sharing sessions, saving checkpoints and snapshots, the AI assistant, the
  no-backend checkpoint viewer, and uploading to Cirro.
- **[`docker/README.md`](docker/README.md)** — running the Docker image, its memory
  limits and environment contract.
- **[`backend/app/registry/custom/README.md`](backend/app/registry/custom/README.md)** —
  what each bundled analysis method does.

For developers:

- **[`DEVELOPMENT.md`](DEVELOPMENT.md)** — architecture, repo layout, where to make a
  change, local dev setup, tests, and the offline CLI.
- **[`DESIGN.md`](DESIGN.md)** — the full design specification and the reasoning
  behind it.
- **[`docs/CONTRACT.md`](docs/CONTRACT.md)** — the REST / SSE / Arrow API contract.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — add a recipe (one JSON file) or a custom
  analysis function, and the Contributor Policy those contributions are accepted
  under.
- **[`LICENSE.md`](LICENSE.md)** — the Cirro Bio Source Available License. The default
  grant covers evaluation, review, and preparing contributions; any other use,
  including production use, needs a written authorization from Cirro Bio, Inc.

> **Maintenance rule:** this README stays a short orientation — the pitch, how to run
> the app, and where the docs are. [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) is the
> source of truth for **what the app does**, and
> [`DEVELOPMENT.md`](DEVELOPMENT.md) for the developer-facing detail. Any change that
> adds, removes, or alters a user-facing capability updates the user guide in the same
> commit (and refreshes a screenshot if it materially changes a pictured panel); a
> change to the run command updates this README. See [`CLAUDE.md`](CLAUDE.md).
