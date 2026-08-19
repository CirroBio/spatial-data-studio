# Live demos

Every demo below is the real Spatial Data Studio viewer, running in your browser against
a saved checkpoint. There is no server: the page fetches byte ranges out of a
`.sdata.zarr.zip` as you pan, zoom and change what you are looking at.

That is the same thing that happens when you
[open a checkpoint without the app running](/DEVELOPMENT#driving-the-serverless-viewer-locally) —
these pages just point the viewer at files hosted alongside the documentation.

All three are public 10x demo runs, imported and analyzed by the
[Nextflow workflow](/nextflow/README) and saved as checkpoints. They are **downsampled
for the web**: the image is stored at reduced resolution — a two-level pyramid, at most
about 2,000 px on the long edge — and the expression matrix is dropped entirely, which
is what gets a whole section into tens of megabytes. So there is no color-by-gene here.
What survives is the cells or spots, the columns the analysis produced (Leiden clusters,
cellular neighborhoods, QC metrics), the embeddings, the image, and for Xenium the
segmentation boundaries.

## What you can do here

Color the cells by a category or a QC metric, switch the image channels on and off and
adjust their contrast, change the point size and shape, overlay cell-boundary polygons,
and open the Embeddings view. The analysis history in the sidebar shows what produced
the object you are looking at.

## What you can't

A checkpoint is read-only and there is no backend to compute against, so running new
analyses, editing labels and saving are all unavailable. Anything you change here stays
on your screen and is gone on reload.

## The demos

<ViewerEmbed
  checkpoint="xenium-human-pancreas.sdata.zarr.zip"
  label="Xenium human pancreas"
  description="122,678 cells and 140,702 boundary polygons over an H&E image. Zoom in far enough and the polygons replace the dots."
/>

<ViewerEmbed
  checkpoint="visium-human-colon.sdata.zarr.zip"
  label="Visium CytAssist human colon"
  description="6,356 spots on the CytAssist image, colored by cellular neighborhood."
/>

<ViewerEmbed
  checkpoint="visium-mouse-brain.sdata.zarr.zip"
  label="Visium CytAssist mouse brain"
  description="4,881 spots on the CytAssist image. The neighborhoods follow the section's structure."
/>

Each has its own page — [Xenium human pancreas](/demo/xenium-pancreas),
[human colon](/demo/visium-colon), [mouse brain](/demo/visium-mouse-brain) — with what
to try on it.

You can also open [the whole collection](/viewer/) in the viewer's own gallery, which is
what a deployed folder of checkpoints looks like.
