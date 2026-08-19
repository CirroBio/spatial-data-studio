# Visium CytAssist mouse brain

A 10x Visium CytAssist fresh-frozen mouse brain section: 4,881 spots on the CytAssist
image, and the smallest of the demos.

<ViewerEmbed
  checkpoint="visium-mouse-brain.sdata.zarr.zip"
  label="Visium CytAssist mouse brain"
  height="720px"
/>

## Things to try

- **Read the structure off the colors.** The cellular neighborhoods come out as
  concentric bands across the section. Nothing told the clustering where the tissue's
  layers are; it recovered them from expression alone.
- **Toggle the image.** *View → Show image*, then back, to check the boundaries against
  the tissue itself.
- **Switch to Leiden.** *Cells → Color by → leiden*, and compare it against
  `cellular_neighborhood`: one clusters spots by their own expression, the other by the
  mix of Leiden clusters in each spot's 20 nearest neighbors.
- **Open the Embeddings view.** Both a UMAP and a PCA are stored; the *Embedding*
  dropdown switches between them, and the X/Y selectors pick which components to plot.

## What is not in it

As with the other demos, the expression matrix was dropped when the checkpoint was
downsampled for the web, so there is no color-by-gene. The obs columns, the embeddings
and the image are all intact.
