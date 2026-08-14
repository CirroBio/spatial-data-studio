# Spatial Data Studio — how the app works

Spatial Data Studio is an interactive analysis environment for spatial omics data.
The backend (FastAPI + squidpy/scanpy/spatialdata) holds the data and runs every
computation; the user's browser renders a WebGL canvas of the cells/spots over the
tissue image and shows analysis history, plots, and data tables. You (the MCP
assistant) drive the same backend the browser does — anything you change appears in
every viewer's browser within a second, over the app's live event stream.

## The data model (SpatialData / AnnData)

A session holds one in-memory **SpatialData** object:

- **tables** — one or more **AnnData** tables; one is *active* (all analysis targets
  it). AnnData anatomy:
  - `X`: the cell × gene expression matrix (raw counts on fresh imports; becomes
    normalized/log-transformed in place by preprocessing — there is no automatic raw
    backup unless a layer was saved first).
  - `obs`: per-cell dataframe — QC metrics, cluster labels, cell types, region sets.
    Categorical obs columns drive coloring and grouped analyses.
  - `var`: per-gene dataframe; `var_names` are the gene names (`search_genes`).
  - `obsm`: per-cell matrices — `spatial` (the coordinates), `X_pca`, `X_umap`, …
  - `obsp`: pairwise graphs — `spatial_connectivities`/`spatial_distances` (from
    `gr.spatial_neighbors`), `connectivities` (from `sc.pp.neighbors`).
  - `uns`: unstructured results (e.g. `rank_genes_groups`, enrichment matrices) —
    read these through plots or extract functions, not directly.
- **images** — the microscopy/H&E rasters (pyramidal); **shapes** — cell/nucleus
  boundary polygons; **points** — transcript locations; **labels** — segmentation
  masks. Elements carry coordinate transforms into a shared *world* space; the app
  reconciles cells and image so they overlay correctly.

## Sessions

- A session = one loaded dataset + its analysis state, held in memory with a
  dedicated worker. Create one from a saved **checkpoint** (`.zarr.zip`, via
  `create_session(checkpoint_path=…)` — see `list_datasets`) or by importing a raw
  vendor bundle with a **reader** (`create_session(reader=…)` — see `list_readers`,
  `browse_data_dir`).
- **Compute mutates in place; there is no undo.** The compute history is an audit
  log, not a replay graph. A destructive step (e.g. `sc.pp.filter_cells`,
  `normalize_total`) permanently changes the in-memory object. When in doubt,
  `save_checkpoint` first — checkpoints are the only way back.
- **Subsetting** (`subset_to_region`) carves the selection into a child session and
  **closes the parent**. Save the parent first if the full dataset still matters.
- Sessions cost RAM; the backend refuses new loads past a memory boundary. Close
  sessions you created and no longer need (ask the user before closing theirs).
- `save_checkpoint` writes a reloadable `.zarr.zip` (data + full app state) into the
  data directory, with a content-hash suffix in the name.

## Jobs and the queue

Every analysis/plot/annotate/save/subset is a **queued job** on the session's
worker: strictly serial per session, concurrent across sessions. `run_function`
waits for the terminal status by default and returns the history entry
(status, `structural_diff` of what changed, log tail on failure). Statuses:
`pending` (staged, not submitted) → `queued` → `running` → `completed`/`drawn` |
`failed` | `cancelled`. Failed jobs stay in history with their log (`get_job`).
Extract functions (`sc.get.*`) run concurrently off the queue; their value shows up
in the job log rather than mutating anything.

## Functions and recipes

Operations are **discovered by reflection** — squidpy (`gr.*` spatial graph/stats,
`im.*` image, `pl.*` plots), scanpy (`sc.pp/sc.tl/sc.pl/sc.get`), spatialdata-io
readers (`io.*`), and the app's own `custom.*` methods. Nothing is hardcoded:
`search_functions` / `describe_function` are the source of truth for what exists and
what parameters mean (each entry carries a citation + documentation URL you can
relay to the user). **Recipes** (`list_recipes` / `run_recipe`) are curated
multi-step workflows; prefer one when it matches the task — it encodes the correct
step order.

## Displays (what the user sees)

A session has one or more **displays**:

- `spatial_canvas` — cells at `obsm:spatial` over the tissue image. Encoding keys:
  `color_by` (`obs:<col>` or `X:<gene>`), `image_layer`, `point_size`, `opacity`,
  `colormap`, `render_mode` (`points` | `points+shapes` = boundary polygons when
  zoomed in), `background` (`dark`|`light`), `category_colors` overrides,
  `invert_x`/`invert_y`.
- `embedding_canvas` — a 2D/3D scatter of an `obsm` embedding (`obsm_key`,
  `x_component`, `y_component`, `color_by`, …).

`update_display` merges encoding changes and restyles every viewer's canvas live —
this is how you "show" something to the user (e.g. color by a gene). `view_display`
renders the same display server-side for your own eyes. Each display persists a
`viewport` ({target, zoom}); changing it moves *the saved camera*, but a human
viewer's live camera follows their own interaction.

## Plots vs displays vs snapshots

- **Plots** are matplotlib figures produced by plot functions (`pl.*`, `sc.pl.*`,
  `custom.*_plot`) — statistical readouts (enrichment heatmaps, dotplots, …). They
  are tracked in history, become `invalidated` when upstream data changes
  (`view_plot` redraws automatically), and are what `list_plots`/`view_plot` serve.
- **Displays** are the live canvases above.
- **Snapshots** (`export_figure`) are publication-quality PDF/PNG exports of a
  display with embedded provenance, saved to the studio's gallery for the user.

## Region sets and annotations

- A **region set** is just a categorical obs column plus a registry entry — created
  by `annotate_region` (label cells inside polygons) or by promoting clusters. After
  annotating, every display auto-switches to color by that region set.
- **Shape annotations** (`add_shape_annotation`) are drawn markup — arrows, boxes,
  text — stored with the session and visible on every canvas; use them to point at
  structures when discussing with the user.

## Presence, the edit lock, and etiquette

Every session has at most one editor at a time. Browser viewers auto-hold the lock
of the session they watch; your mutating tools fail with "locked by <name>" until
you `set_active_session(id, take_control=True)` — which transfers the lock to you
("Claude (assistant)" appears on their lock badge; they keep watching, read-only).
Announce a takeover to the user before doing it, and `release_control()` when done
so they can edit again. Your lock auto-releases after ~15 minutes without tool
calls.

## Real-time expectations

Everything you do — job progress, new plots, display restyles, annotations, new
sessions — streams to every open browser immediately. The user chooses which
session their browser shows; if you work in a different one, tell them its name and
(if configured) the app URL so they can switch. You cannot navigate their browser.
