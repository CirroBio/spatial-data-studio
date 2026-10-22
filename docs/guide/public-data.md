# Explore public data

Open the [web app](https://cirrobio.github.io/spatial-data-studio/) (**Open the app** at
the top of this site). Its start page offers two ways in, **Public Data** and **Private Data (Cirro)**, and links
to the About section, which is this documentation. This page covers the first. Logging
in to Cirro is in [Your data in Cirro](cirro.md), and everything below works the same
there.

## The public data

**Public Data** needs no account. The top bar says *Public data · nothing leaves this
browser*: the sections are read straight from where they are published, the analyses run
in your browser, and anything you save is kept in this browser, in a folder of its own
(*Saved in this browser*). **Log In (Cirro)** at the top right switches to your own
projects.

There are four sections. One is a Xenium human lung section as the instrument counted
it, with no analysis yet: it is the one to try the analyses on. The other three, a Xenium
human pancreas and two Visium sections (human colon and mouse brain), were already
analyzed by Spatial Data Studio's workflow, with clusters and cellular neighborhoods.
They were saved without their expression matrix to keep them small, so the analyses that
need gene expression can't run on them, and the task drawer says which those are.

## Four stages of data

The web app works with data in four stages: from what a microscope or an instrument
produced, through the SpatialData a pipeline makes of it, to the figures you keep. Each
stage is a column of the [map](#the-map), and an item moves on to the next stage when a
pipeline or an analysis makes it. Public Data holds only spatial data; a Cirro project can
hold all four. [What the app finds in a project](cirro.md#what-the-app-finds-in-a-project)
says which Cirro datasets it reads.

### Images

- **What it holds.** Microscopy and histology images of a section on their own: H&E and
  other stains, immunofluorescence, multiplexed imaging, before any cells are found in
  them.
- **In Cirro.** Datasets of an imaging data type or pipeline (OME-TIFF, image, QuPath,
  CODEX, MCMICRO), or images uploaded as Files.
- **What the app reads.** OME-TIFF files (`.ome.tif`, `.ome.tiff`), read in place a tile at
  a time. Other slide formats (`.tif`, `.tiff`, `.qptiff`, `.svs`, `.ndpi`, `.scn`,
  `.czi`, `.lif`, `.nd2`, `.ims`, `.lsm`, `.vsi`) are listed so you can find them, but a
  browser can't draw them. An image inside a SpatialData store or an instrument run is
  part of that item instead.
- **What you can do.** View it, with each channel's color and contrast; start a cell
  segmentation pipeline in your Cirro on it (Cellpose, StarDist, nf-core/sopa), whose
  output is spatial data; or
  [open it in an Analysis Workspace](analysis-workspaces.md#start-one-from-the-web-app).

### Instrument runs

- **What it holds.** An instrument's raw output as it wrote it: the transcripts or spots,
  the instrument's own cell segmentation, the morphology images and the run's metrics.
  It isn't SpatialData yet.
- **In Cirro.** Datasets of an instrument's data type (Xenium, Visium, Space Ranger,
  CosMx, MERSCOPE), or a run uploaded as Files. Within one, a folder is a run when its
  files match a platform in the catalog Spatial Data Studio's workflow reads runs with,
  [`nextflow/data_types.json`](https://github.com/CirroBio/spatial-data-studio/blob/main/nextflow/data_types.json),
  by the same rules the workflow applies (below).
- **What the app reads.** Only the file list, to recognize the run, and the metrics the
  instrument reported: `metrics_summary.csv`, for the 10x platforms, shown on the run's
  page.
- **What you can do.** Read its metrics; start Spatial Data Studio's workflow in your
  Cirro to turn it into a SpatialData store, or a segmentation pipeline to find its
  cells again first; or open it in an Analysis Workspace, whose **Import Data** reads it
  with the platform's spatialdata-io reader.

| Platform | A folder is a run of it when it holds |
| --- | --- |
| 10x Xenium | `experiment.xenium`, and the cell-feature matrix (`cell_feature_matrix.h5`, `.zarr.zip` or folder) |
| 10x Visium HD | `binned_outputs`, `segmented_outputs` or a `*feature_slice.h5` |
| 10x Visium | `spatial/scalefactors_json.json`, a filtered or raw feature-barcode matrix (`*filtered_feature_bc_matrix.h5` or `*raw_feature_bc_matrix.h5`), and the tissue positions (`spatial/tissue_positions.csv` or `spatial/tissue_positions_list.csv`) |
| Vizgen MERSCOPE | `detected_transcripts.csv`, with `cell_by_gene.csv` or `cell_metadata.csv` |
| NanoString CosMx | `*exprMat_file.csv`, `*metadata_file.csv` and `*fov_positions_file.csv` |
| Curio Seeker | `anndata.h5ad`, with `cluster_assignment.txt`, `Metrics.csv` or `variable_features_clusters.txt` |
| Steinbock (imaging mass cytometry) | `cells.h5ad`, a `masks_deepcell` or `masks_ilastik` folder, and `ome` |
| MCMICRO (multiplexed tissue imaging) | `quantification` and `markers.csv`, with `registration` or `dearray` |

### Spatial data

- **What it holds.** Analysis-ready SpatialData: each cell (each spot, for Visium) with
  its position, its expression and its annotations, together with the section's images
  and cell boundaries, in one store. It is what a pipeline makes of a run or an image,
  along with every version you save on it.
- **In Cirro.** The output of Spatial Data Studio's workflow, nf-core/sopa, Proseg or a
  segmentation pipeline; SpatialData uploaded as Files; and the versions the web app saves
  (Files datasets tagged `spatial-data-studio`).
- **What the app reads.** A SpatialData store in Zarr v3: a `.zarr.zip` file, or a
  `.zarr` folder holding a table of cell positions (`tables/<name>/obsm/spatial`) or an
  image. Spatial Data Studio's own checkpoints are `.sdata.zarr.zip` files that also
  carry a `viewer/` folder of copies made for fast reading
  ([`CHECKPOINT_FORMAT.md`](../CHECKPOINT_FORMAT.md)). A version is a `layer.json` and an
  `overlay/` folder holding only what it changed, read over the store beneath it
  ([`LAYER_FORMAT.md`](../LAYER_FORMAT.md)). From a store the app reads, in place, the
  table's annotations (`obs`), its positions and embeddings (`obsm`), its expression
  matrix (`X`) when it has one, the images, and the cell boundaries (`shapes`). 10x's
  own Xenium archives (`cells.zarr.zip` and the like) aren't SpatialData, and aren't
  listed.
- **What you can do.** See every cell over the image, the cell map (UMAP) and the
  composition of groups; label cells by drawing round them; find clusters, compare
  groups, find marker genes and spatially variable genes, measure neighborhood
  enrichment, find cellular niches and score gene sets, each with a report; keep a view
  as a figure; save what you made as a version; or open it in an Analysis Workspace, with
  every squidpy and scanpy function. The gene analyses need the expression matrix.
  [Open a spatial dataset](#open-a-spatial-dataset) and
  [Analyze in the browser](analyze.md) have the details.

### Figures

- **What it holds.** A view kept as a figure: the tissue with its colors and framing, or
  a chart from a report.
- **In Cirro.** No dataset of its own: a figure is saved inside the version it was made
  in, so it travels with the data it shows.
- **What the app reads.** The figure's settings from that version (in its `uns`), drawn
  again from the version's data.
- **What you can do.** Open it to see it again: a tissue figure restores the store's view
  as it was framed, where **Save as a figure** downloads it as SVG, PDF or a 300 dpi PNG,
  and a chart figure redraws the chart from the result it came from.

## The map

Public Data, like a Cirro project, opens as a map of the four stages (Images, Instrument
runs, Spatial data, Figures). Each bubble is one item, sized by its files and named
inside it when there is room. A dataset holding several stores shows each one, and rings
inside a spatial-data bubble are the versions saved on that store.

Dashed lines join a run or an image to the spatial data made from it. Click a stage to
step inside it: its items are packed by Cirro folder, or regrouped by tag or by month,
with a filter and a list beside them (shown from the start when a stage holds more than
20 items). Click a group to step into it and a bubble to open it. **About** in the top
bar says which version of the app this is and cites the methods it follows.

Each bubble stays itself as you move: stepping into a stage brings its bubbles to the
middle and sends the other stages' bubbles to their places in the rail on the left;
regrouping or stepping into a folder moves them to their new places; a bubble you open
grows into its page and shrinks back into the map when you return.

## Open a spatial dataset

A store opens across the whole page, read in place: no copy is downloaded, only the
pieces on screen. Pan and zoom as you would on a map. The color legend, the image's
channels and an overview of the whole section are drawn on the image itself. The line
above it starts with the way back to the map, names the store, its size and where it came
from, counts its cells (spots, for Visium) and genes, and links the run or image it was
made **from** and what it was **made into**.

Tabs over the top of the view switch what is shown:

- **Tissue**: every cell over the image.
- **Cell map**: the store's UMAP or other embedding.
- **Composition**: cells per group of the current color. A color of values rather than
  groups, or of more than 100 groups (too many to color), has nothing to count, and the
  view says so.
- **Versions**: the store's history, with the page to itself (it has nothing to set).
- **Figures**: a menu of the figures saved with it, when there are any.

At the other end of the tabs are a scale bar (when the store says its coordinates are
microns), zoom out and in, and **Fit to data**, which stay in reach when the drawers are
away. For a Visium store, whose observations are capture spots, the header, the map's tab
and Composition say spots rather than cells.

Two drawers float over the view. Pull one in with its tab at the edge of the view and
push it away with its arrow, or press **[** for the left one, **]** for the right one
and **\\** for both at once; the app remembers which you keep open. The left one holds
the analysis tasks ([Analyze in the browser](analyze.md)). The right one, **Display**,
holds the display settings, the same panel with the same names as in an Analysis
Workspace: **View** (cells and image on or off, mirroring, zoom, the overview, fit),
**Cells** (first what colors the cells, any annotation, gene or layer, with the color
legend and its title; then render mode, point size and shape, the cell boundaries and
their style, opacity, and each category's color) and **Image** (which image, a light or
dark backdrop, and each channel's color, contrast and name).

A store first opens with a light backdrop behind a stained (brightfield) slide and a dark
one behind fluorescence, and the legends and overview take the backdrop's colors. It
opens colored as it was saved, unless that color has a single group (a column every cell
shares), in which case it opens colored by its first grouping with 2 to 50 groups. A
store with no such grouping opens with its cells drawn as outlines (where it has cell
boundaries), so the image shows through them. The tissue and the cell map share one
color: choosing a color, its legend title or a group's color on one changes the other. On
**Composition** the drawer holds just the color, which picks the groups counted.
