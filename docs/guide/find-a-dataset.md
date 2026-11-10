# Find a dataset

[Public Data](public-data.md) and [your own data in Cirro](cirro.md) are found the same
way. Choose a project, and it opens as a map of the four stages of data, from what an
instrument produced to the figures you keep. Click an item on the map to open it: an item
of spatial data opens as a section to [look at](look-at-a-section.md) and
[analyze](analyze.md).

## Projects

All data in the app lives in [projects](glossary.md#project). The project name in the top
bar opens the list of them: your Cirro projects once you have logged in (before that,
**Log in to see them…**), then the public projects, so you can move between them.
**About** says which version of the app this is and cites the methods it follows.

Every project is either one you can add to or a read-only one, and that is the only
difference the app makes between them. A read-only project has a **Read-only** badge
beside its name, which says what that means when clicked (and offers to log in). You can
look and run every analysis there, and what you save is kept in
this browser, in a folder of its own (*Saved in this browser*) in the project you saved it
in: not on other computers, and nobody else can see it. It offers no **Add Data** or
Analysis Workspaces, which add to a project, and shows an image's or a run's pipelines
switched off, saying what would let you run them. Every public project is
read-only, and so is a Cirro project where your role lets you only view
([Projects you can only read](cirro.md#projects-you-can-only-read)).

## Four stages of data

The web app works with data in four stages: from what a microscope or an instrument
produced, through the SpatialData a pipeline makes of it, to the figures you keep. Each
stage is a column of the [map](#the-map), and an item moves on to the next stage when a
pipeline or an analysis makes it. A public project holds whatever stages were published in
it; a Cirro project can hold all four. [What the app finds in a project](cirro.md#what-the-app-finds-in-a-project)
says which Cirro datasets it reads.

### Images

- **What it holds.** Microscopy and histology images of a section on their own: H&E and
  other stains, immunofluorescence, multiplexed imaging, before any cells are found in
  them.
- **In Cirro.** Datasets of an imaging data type or pipeline (OME-TIFF, image, QuPath,
  CODEX, MCMICRO), or images uploaded as Files.
- **What the app reads.** OME-TIFF images, read in place a tile at a time. Images in
  other slide formats are listed so you can find them, but a browser can't draw them.
- **What you can do.** View it, with each channel's color and contrast; start a cell
  segmentation pipeline in your Cirro on it (Cellpose, StarDist, nf-core/sopa), whose
  output is spatial data; or
  [open it in an Analysis Workspace](analysis-workspaces.md#start-one-from-the-web-app).

<details>
<summary>File formats</summary>

The app draws OME-TIFF files (`.ome.tif`, `.ome.tiff`). It lists `.tif`, `.tiff`,
`.qptiff`, `.svs`, `.ndpi`, `.scn`, `.czi`, `.lif`, `.nd2`, `.ims`, `.lsm` and `.vsi`
files without drawing them. An image inside a SpatialData store or an instrument run is
part of that item instead.

</details>

### Instrument runs

- **What it holds.** An instrument's raw output as it wrote it: the transcripts or spots,
  the instrument's own cell segmentation, the morphology images and the run's metrics.
  It isn't SpatialData yet.
- **In Cirro.** Datasets of an instrument's data type (Xenium, Visium, Space Ranger,
  CosMx, MERSCOPE), or a run uploaded as Files. Within one, a folder is a run when its
  files match a platform Spatial Data Studio's workflow reads (*Which folders are runs*,
  below).
- **What the app reads.** Only the file list, to recognize the run, and the metrics the
  instrument reported, shown on the run's page.
- **What you can do.** Read its metrics; start Spatial Data Studio's workflow in your
  Cirro to turn it into a SpatialData store, or a segmentation pipeline to find its
  cells again first; or open it in an Analysis Workspace, whose **Import Data** reads it
  with the platform's spatialdata-io reader.

<details>
<summary>Which folders are runs</summary>

A folder is a run when its files match a platform in the catalog Spatial Data Studio's
workflow reads runs with,
[`nextflow/data_types.json`](https://github.com/CirroBio/spatial-data-studio/blob/main/nextflow/data_types.json),
by the same rules the workflow applies. The metrics on a run's page are its
`metrics_summary.csv`, for the 10x platforms.

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

</details>

### Spatial data

- **What it holds.** Analysis-ready SpatialData: each cell (each spot, for Visium) with
  its position, its expression and its annotations, together with the section's images
  and cell boundaries, in one [store](glossary.md#store). It is what a pipeline makes of a
  run or an image, along with every [version](glossary.md#version) you save on it.
- **In Cirro.** The output of Spatial Data Studio's workflow, nf-core/sopa, Proseg or a
  segmentation pipeline; SpatialData uploaded as Files; and the versions the web app saves
  (Files datasets tagged `spatial-data-studio`).
- **What the app reads.** A SpatialData store, in place: the cells' annotations,
  positions and embeddings, the expression matrix when the store has one, the images and
  the cell boundaries. 10x's own Xenium archives aren't SpatialData, and aren't listed.
- **What you can do.** See every cell over the image, the cell map (UMAP) and the
  composition of groups, alone or across another grouping; label cells by drawing round
  them; find clusters, compare groups, find marker genes and spatially variable genes,
  measure neighborhood enrichment, find cellular niches and score gene sets, each with a
  report; keep a view as a figure; save what you made as a version; or open it in an
  Analysis Workspace, with every squidpy and scanpy function. The gene analyses need the
  expression matrix.
  [Look at a section](look-at-a-section.md) and
  [Analyze in the browser](analyze.md) have the details.

<details>
<summary>Store formats</summary>

The app reads SpatialData in Zarr v3: a `.zarr.zip` file, or a `.zarr` folder holding a
table of cell positions (`tables/<name>/obsm/spatial`) or an image. Spatial Data
Studio's own [checkpoints](glossary.md#checkpoint) are `.sdata.zarr.zip` files that also
carry a `viewer/` folder of copies made for fast reading
([`CHECKPOINT_FORMAT.md`](../CHECKPOINT_FORMAT.md)). A version is a `layer.json` and an
`overlay/` folder holding only what it changed, read over the store beneath it
([`LAYER_FORMAT.md`](../LAYER_FORMAT.md)). From a store the app reads the table's
annotations (`obs`), its positions and embeddings (`obsm`), its expression matrix (`X`),
the images, and the cell boundaries (`shapes`). The 10x Xenium archives it leaves out are
files such as `cells.zarr.zip`.

</details>

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

A project opens as a map of the four stages (Images, Instrument runs, Spatial data,
Figures). Each bubble is one item, sized by its files and named inside it when there is
room; pointing at one shows its full name under the map. A dataset holding several stores
shows each one, and rings inside a spatial-data bubble are the versions saved on that
store. Dashed lines join a run or an image to the spatial data made from it.

Click a bubble to open that item. Click a stage's heading, or the space around its
bubbles, to open it as a list of its items, a row each, in their Cirro folders:

- **A row** gives the item's full name and, under it, what it is in a few words: an
  image's format and whether spatial data was made from it, a run's platform, a spatial
  dataset's kind, how many versions it has and what it was made from, and the spatial
  dataset a figure draws. Its size is the
  number on the right and a dot on the stage's size scale (KB, MB, GB), and the date is
  when it was added. A folder's row gives what its items weigh together, with a tick on
  the scale for each one, so a closed folder still shows where its large items are.
- **Said once.** What every item of the stage shares ("all 10x Xenium") is said once,
  above the list, rather than on every row.
- **Find and narrow.** Search by name, folder, tag or any of those facts; the chips beside
  the search narrow the list to one kind of item (only "OME-TIFF", say), and are offered
  only for facts that tell the stage's items apart. Order by name, size or newest, and
  switch between **Folders** and a **Flat list** of everything.
- **Select** a row to see more under it: the dataset's description, who added it and when,
  a link to it in Cirro, what it was made from and what was made from it (click one to go
  to it in its own stage), and what you can do: **Open** it, open it in an Analysis
  Workspace, or run a pipeline on it. A double-click, or Enter, opens an item straight
  away, its picture growing out of its row; leaving the picture comes back to the list with
  the row still selected.
- **Keyboard.** The arrow keys move through the list and open and close folders, typing
  jumps to a name, `/` goes to the search (where the down arrow moves into the list and
  Enter opens the first item found), and Esc closes what is open under a row, then goes
  back to the map.

On a wide screen, a rail on the left keeps every stage as a small map of its bubbles: the
open stage's dims the items the search leaves out and rings the selected item and what
it was made from and into. What you have opened, searched for, selected and chosen is
kept in the page's address, so a reload, Back or a shared link shows the same list.
