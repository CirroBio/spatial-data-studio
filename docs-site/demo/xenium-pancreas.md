# Xenium human pancreas

A 10x Xenium V1 run on FFPE human pancreas: 122,678 cells over the post-run H&E image,
with the segmentation boundary for every cell. It is the largest of the demos and the
one that shows what the serverless viewer does under load — 140,702 boundary polygons
live in an 18 MB GeoParquet block inside the checkpoint, and the page reads only the row
groups whose bounding boxes intersect what you are looking at.

<ViewerEmbed
  checkpoint="xenium-human-pancreas.sdata.zarr.zip"
  label="Xenium human pancreas"
  height="720px"
/>

## Things to try

- **Zoom in until the dots become cells.** The saved display is *Points + Shapes*: the
  scatter draws at every zoom, and the boundary fills come in once the viewport holds
  few enough of them to be worth fetching. Watch the minimap in the top left to keep
  track of where you are.
- **Recolor.** *Cells → Color by* offers 28 cellular neighborhoods, the Leiden clusters,
  and continuous columns like `transcript_counts`, `cell_area` and `nucleus_area`.
- **Turn the image off.** *View → Show image*. The neighborhoods carry the tissue
  architecture on their own.
- **Open the Embeddings view.** It opens on a 3-D UMAP colored by Leiden cluster;
  left-drag rotates it.
- **Copy link to this view.** In the menu, top right. The URL carries everything you
  changed from the saved view, so it reopens exactly what you are looking at.

## What is not in it

No expression matrix. The 377-gene panel is listed in `var`, but the counts were dropped
when the checkpoint was downsampled for the web, so *Color by* has no gene tier — see
[the demo index](/demo/) for why. The H&E is stored at 931 × 1,718 px over a two-level
pyramid, which is why it blurs well before the polygons do.
