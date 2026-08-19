# Visium CytAssist human colon

A 10x Visium CytAssist FFPE human colon section: 6,356 spots on the CytAssist image,
colored by the cellular neighborhood each spot falls in.

<ViewerEmbed
  checkpoint="visium-human-colon.sdata.zarr.zip"
  label="Visium CytAssist human colon"
  height="720px"
/>

## Things to try

- **Compare the neighborhoods against the tissue.** *View → Show image* toggles the
  CytAssist image underneath, so you can see which neighborhood boundaries fall on
  something visible in the stain and which do not.
- **Switch to Leiden.** *Cells → Color by → leiden* is the clustering the neighborhoods
  were built from — each spot's 20 nearest neighbors, grouped by their mix of Leiden
  labels — so the two colorings say different things about the same spots.
- **Use the legend as a filter.** Click a category to isolate it and dim the rest.
- **Grow the spots.** *Cells → Point size*, with the *Hexagon* glyph — Visium spots sit
  on a honeycomb array, so at the right size they tile the section rather than dotting
  it.
- **Open the Embeddings view.** It opens on the UMAP colored by `region`, which has a
  single value here and so comes out one color — switch *Color by* to `leiden` or
  `cellular_neighborhood` to see the structure.

## What is not in it

The expression matrix was dropped when the checkpoint was downsampled for the web, so
there is no color-by-gene; the 17,012 genes are listed in `var` and nothing else. The
per-spot QC columns (`total_counts`, `n_genes_by_counts`, the `pct_counts_in_top_*`
series) survived and are colorable.
