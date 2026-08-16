# Live demos

Every demo below is the real Spatial Data Studio viewer, running in your browser against
a saved checkpoint. There is no server: the page fetches byte ranges out of a
`.sdata.zarr.zip` as you pan, zoom and change what you are looking at.

That is the same thing that happens when you
[open a checkpoint without the app running](/DEVELOPMENT#driving-the-serverless-viewer-locally) —
these pages just point the viewer at files hosted alongside the documentation.

## What you can do here

Colour the cells by a category or a gene, switch the image channels on and off and
adjust their contrast, change the point size and shape, and open the Embeddings view.
The analysis history in the sidebar shows the steps that produced the data.

## What you can't

A checkpoint is read-only and there is no backend to compute against, so running new
analyses, editing labels and saving are all unavailable. Anything you change here stays
on your screen and is gone on reload.

## The demos

<ViewerEmbed
  checkpoint="fluorescence-section.sdata.zarr.zip"
  label="Fluorescence section"
  description="1,800 synthetic cells over a three-channel image. Try colouring by cell_type, then by one of the marker genes."
/>

<ViewerEmbed
  checkpoint="tma-cores.sdata.zarr.zip"
  label="Tissue microarray cores"
  description="A 3×4 grid of cores laid out from real Xenium human lung cells."
/>

You can also open [the whole collection](/viewer/) in the viewer's own gallery, which is
what a deployed folder of checkpoints looks like.
