# Spatial Data Studio

**Interactive analysis and visualization for spatial omics data — in the browser,
no code required.**

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

Everything ships as one Docker image, so the published build needs nothing but Docker
and a folder of your own data:

```bash
docker run -d -p 8080:8888 \
  -v "$(pwd)/data":/data -e SDS_DATA_DIR=/data \
  public.ecr.aws/cirrobio/spatial-data-studio:v1
```

Open `http://localhost:8080` and start a session on anything in that folder.
[`docker/README.md`](docker/README.md) has the compose file, the memory limits and the
full environment contract; [`DEVELOPMENT.md`](DEVELOPMENT.md#local-dev-environment) has
how to run from a clone instead. Or try it with nothing installed at all — the
[live demos][demos] are the real viewer running in your browser.

## Documentation

**[cirrobio.github.io/spatial-data-studio][docs]** renders every file below, so the
same words read the same on GitHub and on the site.

[docs]: https://cirrobio.github.io/spatial-data-studio/
[demos]: https://cirrobio.github.io/spatial-data-studio/demo/

| | |
| --- | --- |
| [User guide](docs/USER_GUIDE.md) | what the app does — the source of truth for it |
| [Run with Docker](docker/README.md) | the image, its memory limits and environment |
| [Analysis methods](backend/app/registry/custom/README.md) | what each bundled method does |
| [Development guide](DEVELOPMENT.md) | architecture, repo layout, dev setup, tests |
| [Design](DESIGN.md) | the full specification and the reasoning behind it |
| [API contract](docs/CONTRACT.md) | the REST / SSE / Arrow contract |
| [Contributing](CONTRIBUTING.md) | adding a recipe or an analysis function |
| [License](LICENSE.md) | the Cirro Bio Source Available License |

The default licence grant covers evaluation, review, and preparing contributions; any
other use, including production use, needs a written authorization from Cirro Bio, Inc.

> **Maintenance rule:** this README stays a short orientation — the pitch, how to run
> the app, and where the docs are. [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) is the
> source of truth for **what the app does**, and [`DEVELOPMENT.md`](DEVELOPMENT.md) for
> the developer-facing detail. Any change that adds, removes, or alters a user-facing
> capability updates the user guide in the same commit (and refreshes a screenshot if it
> materially changes a pictured panel); a change to the run command updates this README.
> See [`CLAUDE.md`](CLAUDE.md).
