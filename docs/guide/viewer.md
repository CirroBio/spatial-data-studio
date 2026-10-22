# Share and embed the viewer

The viewer is the part of Spatial Data Studio that draws a section. It also works on its
own: point it at a saved checkpoint and the section opens in any browser, with nothing
running behind it. This page is for showing a saved section to people who don't use the
app, and for putting it on a web page of your own.

You may have met it already. The [live demos](../../docs-site/demo/index.md) are the
viewer, and so is the browsable collection Cirro shows for a dataset that Spatial Data
Studio's workflow made or an Analysis Workspace
[published](analysis-workspaces.md#publish-to-cirro).

## Open a checkpoint without the app running

A saved checkpoint is a single `.zarr.zip` the viewer can read on its own. Open the viewer
with `?checkpoint=<url>` and it reads that file directly over HTTP range requests: the
tissue image, the cells, the cell-boundary shapes, the text and shape annotations drawn on
the dataset, and every display setting (color by any obs column or gene, palettes and
per-category colors, point size and shape, channel colors and contrast, legends, layer
visibility, pan and zoom) work exactly as they do in an Analysis Workspace, with no
backend and no server to run. It streams only what the current view needs rather than
downloading the file — opening a 438 MB checkpoint and coloring by a gene costs under a
megabyte, and zooming in far enough to draw real segmentation outlines fetches only the
boundaries on screen (about a megabyte out of a 55 MB boundary set). Boundaries need a
checkpoint saved by this version or later; open an older one in an Analysis Workspace and
save it again to add them.

The viewer also opens SpatialData stores it did not save: a `.zarr.zip`, or a `.zarr/`
folder (point `?checkpoint=` at the folder with a trailing `/`), such as nf-core/sopa or
spatialdata-io output. It finds the table, places the images against the cells, and starts
on the displays a new session would: the spatial view colored by the first categorical
column over the first image, and a UMAP (or other embedding) view when the table has one.
Such a store must be Zarr v3 with consolidated metadata (what spatialdata 0.3 and later
write), and its table needs `obsm["spatial"]`; when one of those is missing the viewer
says which instead of opening an empty view. A store with images and no table at all —
multiplexed imaging not yet segmented, say — opens on the image alone, with its channel
controls and no cells; a checkpoint saved from such a session opens the same way.
Cell boundaries draw from such a store too: each polygon shapes element is offered under
**Cell boundaries**, placed against the cells and colored like them. Without the spatial
index a saved checkpoint carries, the viewer reads an element's outlines whole the first
time it draws them, so a boundary set holding more than 32 MB of geometry is not drawn
from a plain store; save it from an Analysis Workspace to get those. Coloring by a gene
also reads the table's whole expression matrix rather than one gene's slice (a few
seconds on a 2 GB sopa store).

The **Plots** view works here too: the figures saved with the checkpoint are in the file,
so the grid, the fullscreen view and the SVG/PDF/PNG downloads all work with no backend.
The left panel opens collapsed and holds one thing: the history of the analysis that
produced the checkpoint — expand it to see each function that was run, and click an entry
for its parameters and timing. The checkpoint's annotations are drawn exactly as an
Analysis Workspace draws them, but can't be selected, moved, edited or deleted, and no new
ones can be added. Anything that would act on the data (running an analysis, annotating,
subsetting, drawing a new plot, saving) needs an Analysis Workspace. You can still export
what you see as a PNG; the publication-quality PDF figure of the current view isn't
available this way.

## Share the exact view you're looking at

Every display setting you change from what the checkpoint was saved with — color by,
palettes and per-category colors, channels and contrast, point size and shape, legends,
layer visibility, where you've panned and zoomed to, and which view (including a figure
you've opened fullscreen) you're on — is kept in the page's address. **Copy link to this
view** in the menu hands you a URL that reopens the same checkpoint framed and styled
exactly as you left it, so a collaborator sees your view rather than the saved one. Only
your changes travel, so the link stays short.

## Host a collection

Put the viewer, your `.sdata.zarr.zip` files, and a small `index.json` listing them in
one folder on any web server that answers HTTP range requests, and the page becomes a
browsable collection you can switch between:

```json
{ "title": "Demo checkpoints",
  "checkpoints": [{ "path": "my-run.sdata.zarr.zip", "label": "Visium H&E" }] }
```

The viewer is the `viewer-dist.tar.gz` attached to each
[release](https://github.com/CirroBio/spatial-data-studio/releases/latest). Files on
another site than the viewer can be opened too, when that site allows it (CORS) and lets
the page read the `Content-Range` header. [`CHECKPOINT_FORMAT.md`](../CHECKPOINT_FORMAT.md)
describes `index.json` in full.

## Embed it in another page

The viewer can sit in a frame on any page:

```html
<iframe src="<viewer>/index.html?checkpoint=<url-encoded checkpoint URL>"></iframe>
```

Shown this way it keeps its own header and controls, as the demos in this documentation
do. `&theme=light` or `&theme=dark` sets the colors it opens with, and
`&background=light` or `&background=dark` the backdrop behind the image. Add `&embed=1`
and it draws only the canvas, with no header, sidebar, settings panel
or picker: the page around it owns the display settings, setting them and following
changes through messages to and from the frame. Cirro's dashboards host it like that;
[`EMBED_PROTOCOL.md`](../EMBED_PROTOCOL.md) is the contract. A developer can also build
the canvas into a React app of their own from
[`packages/viewer`](../../packages/viewer/README.md).
