# The web app (`cirro-studio/`)

Spatial Data Studio's web app: a static site, and a front-end-only Cirro OAuth app, that
opens public examples with no account or signs users in with Cirro, reads their
projects' SpatialData stores in place, runs analyses in the browser, and saves each
result as a light version on top of the store. What it does for users is in the guide,
from [Explore public data](../docs/guide/public-data.md) on;
the version format is [`docs/LAYER_FORMAT.md`](../docs/LAYER_FORMAT.md). This file is
for working on it.

It follows the [Cirro app kit](https://github.com/CirroBio/Cirro-app-kit) (sign-in, API
calls, permissions, deployment, `tools/scan.py` and its review skill). Its map of a
project borrows from Expression Studio, the bulk RNA-seq app built on the same kit; an
opened item looks like Spatial Data Studio itself, the tissue edge to edge with its
controls in drawers over it, and its display settings are the Studio's own panel (the
Studio being the Analysis Workspace's code: `frontend/` and `backend/`).

## Run it

```bash
npm install          # at the repo root: one workspace with packages/*, frontend and this app
npm run dev:studio   # http://localhost:5171
npm --prefix docs-site run docs:dev -- --port 5180   # optional: the docs the app links to
```

The app links to its docs at `about/`, where the deployed site serves them. The dev server
passes `/about/` on to the docs dev server on port 5180 (`vite.config.ts`), so with that
running the links open this checkout's docs; without it they fail.

The port is fixed because Cirro's development registration on dev.cirro.bio (the `dev`
entry in `public/tenants.json`) lists `http://localhost:5171` as this app's redirect URI.
That registration isn't discoverable, so the app needs its client ID, and no client ID is
kept in the repo: put it in `cirro-studio/.env.local` (ignored by git), which the dev server
reads.

```bash
echo 'VITE_TENANT_CLIENT_IDS=dev:<client id>' > cirro-studio/.env.local
```
**Public projects** need no sign-in. A public project is a Cirro publication: a project
of static copies of Cirro datasets in a public bucket, written by `cirro-publish`
([Cirro-publish-data-objects](https://github.com/CirroBio/Cirro-publish-data-objects)),
and the app lists everything in it. Or it is a folder of zipped checkpoints with an
`index.json` at its root (`src/data/indexFolder.ts`; the format is
[`docs/CHECKPOINT_FORMAT.md` §8](../docs/CHECKPOINT_FORMAT.md#8-indexjson--a-collection-of-checkpoints)),
each entry a dataset of one file; Settings tries a publication's `catalog.json` first,
then `index.json`. Which public projects a browser lists is that
visitor's own setting, kept in `localStorage` (`src/data/publicProjects.ts`; Settings in
`src/app/Settings.tsx`): it starts with Spatial Data Studio's own,
`published/spatial-data-studio` in the public bucket (`DEFAULT_PUBLIC_PROJECT`), and any
publication can be added by its root's address or dropped. Each one is listed by its
publication's project ID and name, beside the user's Cirro projects once they log in, and
opens as a `PublicProject` (`src/data/publicProject.ts`), read-only, with versions saved in
this browser and filed under the project they were made in (`src/data/browserStore.ts`, which
a Cirro project the user can only read uses too: see `Collection.access`). Publishing a dataset into
Spatial Data Studio's publication is what makes it part of the default public data.

**A store opened by its address** (`?open=<URL-encoded address of a .zarr.zip>`,
`OPEN_PARAM` in `src/app/route.ts`, kept through every navigation) is a read-only project
of that one store. `openedStoreProject` (`src/data/publicProjects.ts`) knows it by its
address without the query, so a presigned link signed again finds the versions saved on
it; `storeIndex` (`src/data/indexFolder.ts`) reads it as a folder of one checkpoint; and
`OpenedStore` (`src/app/App.tsx`) shows only its item page, under a shell with no
project picker, map or Settings, titled by the store's own `app_state.name` when it has
one. It never starts a Cirro session, and logging in opens a tab of its own.
[docs/guide/link-a-dataset.md](../docs/guide/link-a-dataset.md) is the user's side.
`src/cirro/cirro-publication.ts` is that repository's publication shim, copied in
unchanged (never edit the copy; change the canonical file there). Through it a
publication answers the same calls as a Cirro project (`src/cirro/datasetReader.ts`), so a
dataset's Folder tags file it on the map, and its `credit.<field>: <value>` tags (source,
publisher, license, what was changed) are shown as its credit, as a Creative Commons
license asks. A publication that doesn't answer is listed in Settings as not reachable,
with the shim's error ("Not published: v2/project.json" before it exists). The About links go to `about/` beside
the app, which only the assembled site has (`.github/workflows/docs.yml`).
`npx vite --port <other>` runs it elsewhere for public data alone; sign-in only returns to
5171.

```bash
npm run test:studio                     # vitest
npx tsc --noEmit -p cirro-studio        # typecheck
npm run build:studio                    # cirro-studio/dist
```

One test (`src/stack/python.test.ts`) writes a two-version stack with the browser code
and reads it back with anndata and spatialdata through
`backend/app/persistence/sds_layers.py`. It needs
the repo's Python environment (`.venv-introspect`, see
[`DEVELOPMENT.md`](../DEVELOPMENT.md#local-dev-environment)) and skips itself without it,
as in CI.

## Layout

```
src/main.tsx        boot: a store opened by its address on its own; otherwise refuse to run
                    framed, load tenants.json, sign in, start the app
src/auth.ts         oidc-client-ts against the tenant's authorize page (openid scope,
                    PKCE, sessionStorage, client ID from the tenant by callback URL);
                    signInState.ts is what needs no library
src/tenants.ts      the tenants the log-in box suggests (tenants.json), a typed Cirro
                    address, and where a page load starts
src/app/            shell, URL routing (route.ts), the catalog store (catalog.ts), the
                    project model (library.ts: stages, stores with their versions, figures,
                    lineage links), the studio context (studio.tsx)
src/cirro/          everything that talks to Cirro: the project as a Collection
                    (cirroCollection.ts: datasets, version uploads, pipeline links and
                    upload data types, both matched by name), reading a dataset's record,
                    manifest and files from a project or a publication (datasetReader.ts),
                    the publication shim (cirro-publication.ts, a copy; see above),
                    the catalog sheet (catalogSheet.ts),
                    provenance notes, error wording
src/data/           the Collection interface both sources implement, discovery of stores,
                    runs and images from a file listing (discover.ts, which applies the
                    workflow's own nextflow/data_types.json), public projects (the
                    visitor's list, publicProjects.ts; one opened, publicProject.ts, read
                    from a publication or an index.json folder, indexFolder.ts) and
                    browser storage (idb.ts)
src/stack/          the version format: Cirro references, the Zarr v3 writer, the layered
                    store, the AnnData editor, layer.json, and opening a stack
src/workbench/      an opened stack: its draft, edits into it, reopening, saving
src/map/            the home map (stages as bubbles) and an open stage: its items as a tree
                    of folders with facts in words (browse.ts, pure and tested;
                    StageTree.tsx) beside the stages' minimaps (StageView.tsx)
src/item/           an opened item: the store page (its views as tabs in ViewTabs.tsx,
                    the canvas tools beside them in ViewTools.tsx, history, the
                    unsaved-changes bar), the image page (OME-TIFF via Viv), the run
                    page, and the frame they share (ViewFrame.tsx: the view edge to edge,
                    the tasks and Display drawers over it, the bar over its top);
                    displayState.ts is how each opened store is being looked at
src/tasks/          the task panels, each writing into the draft; an analysis keeps its run
                    and opens its report
src/reports/        each analysis's report, drawn from the result kept in uns (store.ts
                    writes and lists results; ReportView.tsx opens one by its kind); the
                    Composition view's comparison across a column draws the sections of
                    its report (CompositionReport.tsx) live
src/analysis/       the analyses, run in a Web Worker (ops.ts is the table of operations;
                    client.ts hands the expression matrix over as a transferred copy, which
                    the worker normalizes in place: the tab holds it twice during a run, not
                    three and a half times); composition.ts, a count and a test per pair of
                    groups, runs on the page
src/charts/         SVG charts (volcano, heatmap, dot plot, bar list, stacked bars,
                    histogram, scree) and the tissue thumbnails reports draw
src/figures/        figure specs in uns, and SVG/PNG/PDF export
src/workspaces/     Analysis Workspaces on chosen items: Cirro's
                    side (cirro.ts: the environment, mounts, sizes, the per-user limit),
                    the top-bar button and sheet (Workspaces.tsx, loaded only for a
                    signed-in project), the form (NewWorkspace.tsx), and what an item
                    asks for (request.ts)
src/add/            the Add Data page: per stage, the `cirro upload` command for this
                    Cirro and project (uploadCommand.ts) and the pipelines that make that
                    stage's data, each linking to Cirro's launch form
deploy/tenants.json the tenants the published site serves
cirro-permissions.json  what the registration grants, and why
```

The Python reader for versions, `backend/app/persistence/sds_layers.py`, lives in the
Studio's backend, which opens versions through it; it also runs on its own (open a
stack in place, or flatten it).

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

The app gets its client ID from each tenant by its callback URL (dynamic client
registration, `src/auth.ts`), so the published site needs nothing built in for a tenant.
To connect one:

1. A tenant admin registers a **Public App** with redirect URI
   `https://spatial-studio.apps.cirro.bio` (exactly, with no trailing slash: the app
   is served at the domain's root, `src/signInState.ts`), **discovery enabled**, and
   the permissions in `cirro-permissions.json` as project permissions, and approves it. A registration without discovery works only
   with its `clientId` in the tenant's `deploy/tenants.json` entry.
2. `deploy/tenants.json` lists the tenants the log-in box suggests, each an `id`, a
   `name` and a `url` (the tenant's web address). The box suggests the entries whose
   name, id or address match once three characters are typed, takes the address of a
   Cirro the file doesn't list, and remembers the last choice. It lists Cirro Demo, Cirro
   Development, Fred Hutch Cancer Center and Salk Institute; logging in to one works once
   it has registered the app. The Pages workflow checks every entry and copies the file
   over the development one.
3. Before asking a tenant's admins to approve it, run the kit's scanner and review
   skill. The app kit's deploy skill describes the request itself.

   ```bash
   python3 ../Cirro-app-kit/tools/scan.py cirro-studio
   ```

   It reports two medium findings, `unpinned-cirro` for `@cirrobio/spatial-viewer: *` and
   `@cirrobio/studio-ui: *`. Those are the workspace siblings (`packages/viewer` and
   `packages/studio-ui`), resolved to their sources by the Vite aliases rather than
   installed from npm, so there is no published version to pin.

The site is served from github.io, an origin other sites share, so tokens stay in
sessionStorage. A new tab signs in again, and nothing else on github.io can read the
tokens. Served from an origin of its own (a custom domain), the app kit allows keeping
the login in localStorage, shared by every tab, once the tenant's admins have shortened
the refresh-token lifetime on the app's client; the registration has no field for it.
GitHub Pages can't send a `frame-ancestors` header, so `main.tsx` refuses to run inside
another page's frame, except for a store opened by its address: that page starts no Cirro
session and reads no stored login, so a page framing it has nothing to act on.

## Workspaces

**Open in an Analysis Workspace** and the top bar's **Workspaces** start Cirro workspaces from
Cirro's Spatial Data Studio environment (`cirro-spatial-data-studio`, found by name,
`Cirro/spatial-data-studio`, where the ID differs), which runs this repo's Docker image.
Each item brings its datasets, a saved version every dataset beneath it, mounted
read-only at `$HOME/datasets/<folder>` with the folder named for the dataset (`mountsFor`
in `src/workspaces/cirro.ts`). A version names its parent by dataset ID, so the
workspace also gets `SDS_CIRRO_DATASETS`, a JSON map from each dataset ID to its folder,
which the Studio's backend reads (`backend/app/config.py`) to assemble the stack
([docs/LAYER_FORMAT.md](../docs/LAYER_FORMAT.md#in-an-analysis-workspace)).

The rest follows the app kit's workspace guide:
- **Naming.** Workspaces carry no tags, so the app names its own
  `spatial-data-studio / …` and leaves a provenance note on each.
- **Lifecycle.** Auto-stop is two hours, with Extend to postpone it. Each workspace opens
  in a new tab, with a fresh connection URL every click.
- **Limits and changes.** Cirro's per-user limit is read from its refusal, with an offer
  to delete a workspace. A stopped workspace's datasets change in place: `updateWorkspace`,
  then start.
- **Sizes.** Machine sizes are the environment's default CPU and memory times 1, 2 or 4.
- **Loading.** The code loads only for a signed-in project (`Shell.tsx` lazy-loads
  `Workspaces.tsx`), so the examples never download the Cirro client for it.
- **Permissions.** The workspace permissions are optional in `cirro-permissions.json`.
  A registration without them gets Cirro's refusal, worded by `describeError`.

## Deploying

`.github/workflows/docs.yml` builds the app with the docs site and publishes it at the
site's root, with `deploy/tenants.json` as its `tenants.json`;
the docs are its About section, under `/about/`.
Merging to `main` deploys it. No release tag is involved: the app doesn't ship in the
Nextflow workflow's viewer bundle.
