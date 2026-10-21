# Spatial Data Studio for Cirro (`cirro-studio/`)

A front-end-only Cirro OAuth app: Spatial Data Studio as a static site that signs users
in with Cirro, reads their projects' SpatialData stores in place, runs analyses in the
browser, and saves each result as a light version on top of the store. What it does for
users is in [`docs/USER_GUIDE.md`](../docs/USER_GUIDE.md#spatial-data-studio-in-your-browser-on-cirro);
the version format is [`docs/LAYER_FORMAT.md`](../docs/LAYER_FORMAT.md). This file is
for working on it.

It follows the [Cirro app kit](https://github.com/CirroBio/Cirro-app-kit) (sign-in, API
calls, permissions, deployment, `tools/scan.py` and its review skill). Its map of a
project borrows from Expression Studio, the bulk RNA-seq app built on the same kit; an
opened item looks like Spatial Data Studio itself, the tissue edge to edge with its
controls in drawers over it, and its display settings are the Studio's own panel.

## Run it

```bash
npm install          # at the repo root: one workspace with packages/*, frontend and this app
npm run dev:studio   # http://localhost:5171
```

The port is fixed because Cirro's development registration on dev.cirro.bio
(`public/tenants.json`) lists `http://localhost:5171` as this app's redirect URI.
**Explore example data** needs no sign-in. The examples are `examples/` (this app's own
raw-counts Xenium store and its `index.json`) and the docs site's demo checkpoints
(`docs-site/viewer-data/`), which the dev server serves at `/examples/` and `/viewer/`,
the way the Pages site lays them out. `npx vite --port <other>` runs it elsewhere for the
examples alone; sign-in only returns to 5171.

```bash
npm run test:studio                     # vitest
npx tsc --noEmit -p cirro-studio        # typecheck
npm run build:studio                    # cirro-studio/dist
```

One test (`src/stack/python.test.ts`) writes a two-version stack with the browser code
and reads it back with anndata and spatialdata through `python/sds_layers.py`. It needs
the repo's Python environment (`.venv-introspect`, see
[`DEVELOPMENT.md`](../DEVELOPMENT.md#local-dev-environment)) and skips itself without it,
as in CI.

## Layout

```
src/main.tsx        boot: refuse to run framed, load tenants.json, sign in, start the app
src/auth.ts         oidc-client-ts against the tenant's authorize page (openid scope,
                    PKCE, sessionStorage); signInState.ts is what needs no library
src/tenants.ts      runtime tenant registry (tenants.json) and where a page load starts
src/app/            shell, URL routing (route.ts), the catalog store (catalog.ts), the
                    project model (library.ts: stages, stores with their versions, figures,
                    lineage links), the studio context (studio.tsx)
src/cirro/          everything that talks to Cirro: the project as a Collection
                    (cirroCollection.ts: datasets, manifests, signed range reads, version
                    uploads, pipeline links), the catalog sheet (catalogSheet.ts),
                    provenance notes, error wording
src/data/           the Collection interface both sources implement, discovery of stores,
                    runs and images from a file listing (discover.ts, which applies the
                    workflow's own nextflow/data_types.json), the example collection
                    (examples.ts) and browser storage (idb.ts)
src/stack/          the version format: Cirro references, the Zarr v3 writer, the layered
                    store, the AnnData editor, layer.json, and opening a stack
src/workbench/      an opened stack: its draft, edits into it, reopening, saving
src/map/            the home map and the stage view
src/item/           an opened item: the store page (its views as tabs in ViewTabs.tsx,
                    the canvas tools beside them in ViewTools.tsx, history, the
                    unsaved-changes bar), the image page (OME-TIFF via Viv), the run
                    page, and the frame they share (ViewFrame.tsx: the view edge to edge,
                    the tasks and Display drawers over it, the bar over its top);
                    displayState.ts is how each opened store is being looked at
src/tasks/          the task panels, each writing into the draft; an analysis keeps its run
                    and opens its report
src/reports/        each analysis's report, drawn from the result kept in uns (store.ts
                    writes and lists results; ReportView.tsx opens one by its kind)
src/analysis/       the analyses, run in a Web Worker (ops.ts is the table of operations)
src/charts/         SVG charts (volcano, heatmap, dot plot, bar list, histogram, scree) and
                    the tissue thumbnails reports draw
src/figures/        figure specs in uns, and SVG/PNG/PDF export
python/sds_layers.py  reading a version stack from Python (open in place, or flatten)
examples/           the raw-counts example store (scripts/prepare_studio_example.py)
deploy/tenants.json the tenants the published site serves
cirro-permissions.json  what the registration grants, and why
```

`@cirrobio/spatial-viewer` (`packages/viewer`) draws the canvases and reads the stores. It
resolves to its sources, as it does for the Studio frontend, and is given the composed
stack through `openCheckpointStore`.

`@cirrobio/studio-ui` (`packages/studio-ui`) is the Studio's display settings panel. The
canvas hands it to `LensCanvas.tsx` through its `controls` slot, which docks it in the
Display drawer with a portal. It is styled with Tailwind, which this app runs only for
that package (`tailwind.config.js`, `src/styles/studio-ui.css`): preflight is off so the
app's own pages keep `src/styles`, and `studio-ui.css` applies what the panel needs of it
inside elements with the `studio-ui` class. See
[`packages/studio-ui/README.md`](../packages/studio-ui/README.md).

The palette is the Studio's (`frontend/src/index.css`): `src/styles/tokens.css` carries the
same colors as the app's `--sds-` tokens and as the Studio's own `--color-*` RGB channels,
which the viewer's on-image legends and overview and the settings panel read. A change to the Studio's palette
is a change to make there too.

## Connecting a tenant

The published site (`deploy/tenants.json`) lists no tenants until a Cirro registration
exists for it, so it offers only the examples. To connect one:

1. Register a **Public App** in that tenant, with redirect URI
   `https://cirrobio.github.io/spatial-data-studio/app/` (exactly, trailing slash
   included). Request the permissions in `cirro-permissions.json` as project
   permissions.
2. Add `{ "id", "name", "url", "clientId" }` for the tenant to `deploy/tenants.json`.
   The Pages workflow checks every entry and copies the file over the development one.
3. Before asking a tenant's admins to approve it, run the kit's scanner and review
   skill. The app kit's deploy skill describes the request itself.

   ```bash
   python3 ../Cirro-app-kit/tools/scan.py cirro-studio
   ```

   It reports one medium finding, `unpinned-cirro` for `@cirrobio/spatial-viewer: *`. That
   is the workspace sibling (`packages/viewer`), resolved to its sources by the Vite alias
   rather than installed from npm, so there is no published version to pin.

The site is served from github.io, an origin other sites share, so tokens stay in
sessionStorage. A new tab signs in again, and nothing else on github.io can read the
tokens. GitHub Pages can't send a `frame-ancestors` header, so `main.tsx` refuses to run
inside another page's frame.

## Deploying

`.github/workflows/docs.yml` builds the app with the docs site and publishes it at
`/app/`, with `examples/` beside it and `deploy/tenants.json` as its `tenants.json`.
Merging to `main` deploys it. No release tag is involved: the app doesn't ship in the
Nextflow workflow's viewer bundle.
