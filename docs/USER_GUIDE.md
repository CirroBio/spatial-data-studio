# User guide

Everything Spatial Data Studio does, from the point of view of someone using it. For
how to start the app, see the Docker quickstart in [`README.md`](../README.md#run-it);
for the code, [`DEVELOPMENT.md`](../DEVELOPMENT.md).

Spatial Data Studio opens a spatial transcriptomics dataset (Xenium, Visium, Visium HD,
CosMx, MERSCOPE, or anything else [SpatialData](https://spatialdata.scverse.org/) can
read), runs [`squidpy`](https://squidpy.readthedocs.io/) and
[`scanpy`](https://scanpy.readthedocs.io/) analyses on it through point-and-click forms,
and draws the result on a fast WebGL canvas that puts every cell over the tissue image.

## What you can do

The left panel organizes a session into **Compute**, **Plots**, **Regions**,
**Annotations**, and **Subset** tabs; the canvas fills the rest of the window, with the
display settings in the right-hand sidebar.

### Load your data

Point the app at a raw acquisition folder (a spatialdata-io reader parses it) or open an
existing SpatialData `.zarr` store. Each reader input is its own field: a folder or file
input opens a filesystem picker, and the reader's options (e.g. whether Xenium reads
transcripts, cell boundaries, or the morphology image) are toggles/values — so you tailor
exactly what gets loaded. Large datasets can take a while to read, so the reader's log
streams live while it works. Datasets stay resident in memory for the session.

### Run analyses without writing code

Every `squidpy` and (curated) `scanpy` function appears in a searchable picker with a
form generated from the function's own signature — QC, normalization, clustering,
neighborhood enrichment, spatially variable genes, co-occurrence, ligand-receptor, and
more. Each carries a citation and a link to its documentation. Data-transforming
functions run from the **Compute** tab; plotting functions render static figures
collected in a separate **Plots** tab.

### Browse your figures

A **Plots** view sits next to Spatial and Embeddings as a grid of every figure the
session has drawn; click one to fill the screen with it and step through the rest with
the arrow keys. Any figure downloads as SVG, PDF or PNG.

### Apply curated recipes

Multi-step workflows (preprocess → cluster → annotate → neighborhood analysis) you can
run in one click or stage and edit step by step.

<table>
<tr>
<td width="50%"><img src="./images/run-function.jpg" alt="The Cellular Neighborhoods function detail: its documentation, citation, and a parameter form generated from the function signature."></td>
<td width="50%"><img src="./images/recipes.jpg" alt="The recipe gallery listing curated multi-step analysis workflows."></td>
</tr>
<tr>
<td><b>Run a function.</b> Each operation opens with its provenance and a form built from the function's parameters.</td>
<td><b>Apply a recipe.</b> Curated workflows run every step in order, or stage them for editing.</td>
</tr>
</table>

### Visualize interactively

Color cells by any gene or metadata column, choose which tissue-image channels to
display (up to 6 at once) and how they're named, colored (any color, not just presets),
and contrast-adjusted (min/max per channel), switch between point and cell-boundary
rendering, and view non-spatial embeddings (UMAP/PCA) in 2D or 3D — all on the same GPU
canvas. A **minimap** in the canvas' top-left corner shows the whole section with a box
marking the part you're looking at; click or drag it to jump somewhere else.

![The display settings panel, organised into View, Cells, and Image icon tabs: layer visibility, color by, render mode, point size, plot orientation, zoom, minimap, image selection, plot backdrop, and per-channel image color/contrast.](./images/display.jpg)

*Customize the display, organised into **View**, **Cells**, and **Image** icon tabs —
choose what colors the cells, how they render, how the plot is oriented (flip the
horizontal/vertical axes), the zoom level (buttons plus scroll/pinch), whether the
minimap is shown, the plot's own light/dark backdrop (on the **Image** tab, set per
plot and independent of the app theme), and how each tissue-image channel is colored
and contrast-adjusted. A dataset that carries more than one image (say an H&E next to
a morphology stain) picks which one is drawn under the cells at the top of the
**Image** tab, or **None** for no image at all; each image brings its own channels.
When cells are colored by a categorical value, each group's color can be overridden
individually (and reset to the default palette) at the bottom of the **Cells** tab.
(Text and shape annotations that persist with the dataset are drawn from the left
panel's **Annotations** tab.)*

![A Xenium section zoomed in, each cell drawn as its true segmentation outline and colored by its cellular neighborhood, over the morphology image.](./images/cell-outlines.jpg)

*Switch to cell-boundary rendering to draw each cell as its actual segmentation
shape rather than a point — pick the shape set (here `cell_boundaries`) and choose
whether each boundary is a filled shape or an outline (with an adjustable line
width), colored by the cell's value either way.*

### Annotate

Select groups of cells to label them, or draw shapes and text directly on the tissue.
Region labels become ordinary metadata columns you can then analyze by. Applying a label
recolors the view by that region set and paints the labelled cells in the color you
picked; the draw color then advances to the next preset for the next group. Labeling
works on the embedding view too — in 3D it labels every cell visible within the drawn
region.

### Select cells

Both the **Regions** and **Subset** tabs pick their cells the same way, with a tool you
choose at the top of the panel:

- **Lasso** — click point after point on the canvas to trace any outline you like, then
  **Finish region** to close it.
- **Circle**, **Ellipse**, **Square**, **Rectangle** — drag once on the canvas and the
  shape appears where you dragged. Then adjust it: drag the shape itself to move it, and
  its side handles to resize — a circle and a square keep their aspect, so they get one
  handle driving both. Everything except the circle also gets a green handle on an arm
  that rotates it. The cell count on the action button follows each adjustment.

A selection can combine areas: **Finish region** banks the shape (or the closed lasso
ring) and frees the canvas for the next one, and the action applies to all of them
together. **Clear** discards the lot.

### Subset

Select a region — on the tissue or an embedding — to spin off a child session that keeps
(or removes) just those cells.

### Share a session safely

Opening a session locks it to you, so a second person who connects can look but not
change anything. A padlock next to the session name shows whether the session is locked
to you, locked to someone else, or unlocked, and lists everyone currently viewing; the
session list shows who holds each session's lock and how many people are on it. You
appear under a two-word name like *gloomy socrates* — click the padlock to rename
yourself, unlock the session so a colleague can take over, or take an unlocked session's
lock. While someone else holds the lock you can still explore freely and change any
display setting (color by, channels, zoom, render mode); those changes stay on your
screen instead of going into the session.

### Save and share

Save a checkpoint you can reopen later — naming the session, picking the folder the file
goes in (a new one is created for you) and the filename it's written under, then choosing
what goes into the file from a checklist of the dataset's elements *and* the figures
you've drawn, each with its size, so you can leave a multi-gigabyte tissue image out of a
copy you want to send someone. The name travels inside the file, so reopening it shows
the name you gave the session however the file itself is named. An image you do keep has
a resolution slider: it lists what each level of the image pyramid costs, and you pick
the most detailed one worth keeping, trading zoomed-in detail for a much smaller file
(the session on screen keeps everything either way). A table you keep breaks out the same
way, into its parts — the gene-expression matrix, the cell and gene tables, each
embedding, layer and neighbor graph — each with its own size and its own checkbox, so an
analysis whose findings live in the annotations can be shared without the expression
matrix that dwarfs them. Such a file keeps everything else and stays fully readable; it
just has no gene expression to color by, and the app says so instead of showing you
zeros. Reopening a checkpoint brings its plots back as pictures, not just as a list of
what was run. Save a **snapshot** — a high-quality figure of the current view exported as
a vector PDF and/or raster PNG, framed and sized in a dialog with a live preview,
optionally with the minimap inset included in the figure — or upload saved checkpoints to
[Cirro](https://cirro.bio/). Saved snapshots are collected in a gallery you can browse,
download, or delete; each file embeds the provenance (view, settings, and the analysis
steps that produced the data).

### Work with an AI assistant

The backend speaks the [Model Context Protocol](https://modelcontextprotocol.io/) at
`/api/mcp`, so an AI agent (e.g. Claude) can drive the same studio you're looking at:
load data, run analyses and recipes, draw and *look at* plots and the tissue view
(renders come back with a world-coordinate grid and an exact pixel→coordinate mapping),
restyle displays, label regions of cells, subset, and save — every change appears in your
browser live. The agent joins the same per-session edit lock you do (it shows up as
*Claude (assistant)* on the padlock while it works, and hands control back when done),
and connects with built-in guidance covering the studio and spatial-omics analysis. From
this repo, `claude` picks the server up automatically via
[`.mcp.json`](../.mcp.json); from anywhere else:
`claude mcp add --transport http spatial-data-studio http://127.0.0.1:8000/api/mcp`
(use your deployment's own host/port for a Docker install, e.g. `:8080`; prefer
`127.0.0.1` over `localhost` locally — the dev backend binds IPv4 only, and `localhost`
can resolve to `::1` and reach some other process squatting the port). The MCP endpoint
is unauthenticated like the rest of the API — expose the port only to people and
processes you'd let edit your sessions.

## Analyses available

The gallery leads with a **guided Xenium region-analysis workflow** you run in order:
preprocess & QC → Leiden cluster & top marker genes → assign cell-type labels
(CellTypist) → neighborhood analysis (cellular neighborhoods) → cell types &
neighborhoods by region → region gene-expression differences.

Beyond that you get the full `squidpy` spatial toolkit (neighborhood enrichment,
Moran's I / Geary's C spatially variable genes, co-occurrence, Ripley's statistics,
ligand-receptor interactions), `scanpy` preprocessing and clustering, and a set of
**spatial / multi-sample methods** that scanpy and squidpy don't provide out of the
box: cellular neighborhoods, Milo differential abundance, LISI integration
diagnostics, proximity/avoidance testing, region-boundary infiltration profiles,
pseudobulk differential expression (DESeq2), and region feature differences
(Kruskal-Wallis). Each is described in
[`backend/app/registry/custom/README.md`](../backend/app/registry/custom/README.md).

## Open a checkpoint without the app running

A saved checkpoint is a single `.zarr.zip` the viewer can read on its own. Open the app
with `?checkpoint=<url>` and it reads that file directly over HTTP range requests: the
tissue image, the cells, the cell-boundary shapes, and every display setting (color by
any obs column or gene, palettes and per-category colors, point size and shape, channel
colors and contrast, legends, layer visibility, pan and zoom) work exactly as they do
live, with no backend and no server to run. It streams only what the current view needs
rather than downloading the file — opening a 438 MB checkpoint and coloring by a gene
costs under a megabyte, and zooming in far enough to draw real segmentation outlines
fetches only the boundaries on screen (about a megabyte out of a 55 MB boundary set).
Boundaries need a checkpoint saved by this version or later; open an older one in the app
and save it again to add them. Any host that serves the file with HTTP range requests
will do — put the built app, your `.zarr.zip` files, and a small `index.json` listing
them in one folder and the page becomes a browsable collection you can switch between.

The **Plots** view works here too: the figures saved with the checkpoint are in the file,
so the grid, the fullscreen view and the SVG/PDF/PNG downloads all work with no backend.
The left panel opens collapsed and holds one thing: the history of the analysis that
produced the checkpoint — expand it to see each function that was run, and click an entry
for its parameters and timing. Anything that would act on the data (running an analysis,
annotating, subsetting, drawing a new plot, saving) needs the live app. You can still
export what you see as a PNG; the publication-quality PDF figure of the current view
isn't available this way.

### Share the exact view you're looking at

In that no-backend viewer, every display setting you change from what the checkpoint was
saved with — color by, palettes and per-category colors, channels and contrast, point
size and shape, legends, layer visibility, where you've panned and zoomed to, and which
view (including a figure you've opened fullscreen) you're on — is kept in the page's
address. **Copy link to this view** in the menu hands you a URL that reopens the same
checkpoint framed and styled exactly as you left it, so a collaborator sees your view
rather than the saved one. Only your changes travel, so the link stays short.

You can try this without installing anything — the
[live demos](https://cirrobio.github.io/spatial-data-studio/demo/) are the real viewer
running in your browser against a hosted checkpoint, over public Visium and Xenium
sections as well as synthetic ones.

## Upload to Cirro

You can publish saved checkpoints to [Cirro](https://cirro.bio/) from the menu in the
right-hand sidebar. Each person signs in with their own Cirro account, so several
people can use the same running app without sharing credentials — the server holds no
Cirro credential and needs no Cirro configuration. Setting `CIRRO_BASE_URL` on the
deployment only prefills a domain other than `app.cirro.bio`.

1. **Connect to Cirro** asks for your Cirro domain (for example `app.cirro.bio`) and gives
   you a login link. Open it, sign in as you normally would, and the dialog updates
   itself when you're done — closing it won't cancel the login. Everything else about
   your account is discovered from the domain. A login link is only good for about half
   an hour; come back to a stale one and the dialog says so and offers **Refresh login
   token**, which gets you a fresh link for the same account.
2. The menu entry then reads **Upload to Cirro** and shows which account you're signed
   in as. **Disconnect from Cirro** signs you out of this browser.
3. The upload dialog asks for a project, a dataset name, an optional description and
   destination folder, and which saved sessions to include. Uploading runs in the
   background — you can keep working, and the sidebar shows progress.

Alongside your checkpoints, the upload includes the viewer itself (`index.html`) and an
`index.json` listing them, so the resulting Cirro dataset opens as a browsable
collection that anyone with access can view without running this app. (Uploads made
from a development server, which has no built viewer on disk, carry the checkpoints and
`index.json` only; the dialog tells you which kind of upload you're making.)

Your Cirro sign-in lives only in the running app's memory and is dropped after 8 hours
of inactivity or when you disconnect.
