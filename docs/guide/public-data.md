# Explore public data

Open the [web app](https://spatial-studio.apps.cirro.bio/) (**Open the app** at
the top of this site). It opens straight onto Spatial Data Studio's public sections, with
no account. **Log In (Cirro)** at the top right adds your own projects
([Your data in Cirro](cirro.md)), and everything below works the same there.

## Projects

All data lives in projects. The project name in the top bar opens the list of them: your
Cirro projects once you have logged in (before that, **Log in to see them…**), then the
public projects, so you can move between them. **About** says which version of the app this is and cites the methods it follows.

Every project is either one you can add to or a read-only one, and that is the only
difference the app makes between them. A read-only project has a **Read-only** badge
beside its name, which says what that means when clicked (and offers to log in). You can
look and run every analysis there, and what you save is kept in
this browser, in a folder of its own (*Saved in this browser*) in the project you saved it
in: not on other computers, and nobody else can see it. It offers no **Add Data**,
pipelines or Analysis Workspaces, which all add to a project. Every public project is
read-only, and so is a Cirro project where your role lets you only view
([Projects you can only read](cirro.md#projects-you-can-only-read)).

## Public projects

A public project is a project anyone can open with no account: a Cirro publication,
copies of Cirro datasets in a public bucket, the same for every visitor. The app opens on
Spatial Data Studio's own, *Spatial Data Studio examples*, where a section appears once it
is published there. Its sections are read straight from where they are published.

### Choose which public projects to list

**Settings** (in the top bar, or in your account menu once logged in), or **Manage public
projects…** at the bottom of the project list, lists the public projects this browser
shows. Each one gives its name, its description and the address it is read from, and
says whether it is Spatial Data Studio's own or one you added, which this app hasn't
reviewed.

- **Add** a public project by pasting its address: a Cirro publication's root (the
  `https://…/published/<name>` address its publisher gives), or a folder with an
  `index.json` ([Show your own data](#show-your-own-data)). The app checks that one of the
  two answers there before listing it. Other Cirro apps publish their public data the
  same way, so one of theirs can be added here; the app shows what it can read in it.
- **Remove** drops one from the list; nothing is deleted. Spatial Data Studio's own can be
  removed too, and **Bring back Spatial Data Studio's public project** restores it.

The list is kept in this browser only: another browser, or a private window, starts with
Spatial Data Studio's own.

### Show your own data

A public project needs no Cirro: any folder of SpatialData stores, zipped
(`.sdata.zarr.zip`), with an `index.json` at its root listing them, is one. Put it
anywhere a browser can read files from another site with byte ranges (CORS), such as an S3
bucket set up for it, and add the folder's address in Settings. Each entry names a store
and, if you like, how the map shows it:

```json
{ "title": "Our lung sections",
  "description": "Xenium sections from the lab, raw and clustered",
  "checkpoints": [
    { "path": "raw/lung.sdata.zarr.zip", "label": "Lung (raw counts)", "folder": "Xenium" },
    { "path": "clustered/lung.sdata.zarr.zip", "label": "Lung, clustered", "folder": "Xenium",
      "from": ["raw/lung.sdata.zarr.zip"], "tags": ["tumor"],
      "credit": { "source": "…", "url": "…", "by": "…", "license": "CC BY 4.0" } } ] }
```

`label` and `description` name and describe it, `folder` files it (a `/` nests folders),
`from` draws its lineage from the stores it was made from, and `credit` says whose data it
is. Anyone who adds the address sees the same project, and nothing about it passes
through Spatial Data Studio. To show one store on its own, with no `index.json` and nothing
to add in Settings, [link to it](link-a-dataset.md) instead. A pipeline run's `results/` folder already carries an
`index.json` of this kind. [`CHECKPOINT_FORMAT.md`](../CHECKPOINT_FORMAT.md#8-indexjson--a-collection-of-checkpoints)
lists every field.

## Whose data it is

A public dataset says where it comes from. The line above an open section names the
dataset it was made from, linked to its page, with its license, and **Details** says what
was done to the data to make the section. A publication carries this in its datasets'
`credit.<field>: <value>` tags, an `index.json` in each entry's `credit`. The map files
each dataset in its folders.

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
  composition of groups, alone or across another grouping; label cells by drawing round
  them; find clusters, compare groups, find marker genes and spatially variable genes,
  measure neighborhood enrichment, find cellular niches and score gene sets, each with a
  report; keep a view as a figure; save what you made as a version; or open it in an
  Analysis Workspace, with every squidpy and scanpy function. The gene analyses need the
  expression matrix.
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

## Open a spatial dataset

A store opens across the whole page, read in place: no copy is downloaded, only the
pieces on screen. Pan and zoom as you would on a map. The color legend, the image's
channels and an overview of the whole section are drawn on the image itself. The line
above it starts with the way back to the map, names the store, its size and where it came
from, counts its cells (spots, for Visium) and genes, and links the run or image it was
made **from** and what it was **made into**. A version shows as *Version N · its title*
beside the name of the store it was saved on, and keeps that store's credit. Esc closes
menus and an open task, but never leaves the dataset: the way back does.

Tabs over the top of the view switch what is shown:

- **Tissue**: every cell over the image.
- **Cell map**: the store's UMAP or other embedding.
- **Composition**: cells per group of the current color, or, with a column chosen under
  **Across**, how each of that column's groups is made up
  ([Compare composition](analyze.md#compare-composition)). A color of values rather than
  groups, or of more than 100 groups (too many to color), has nothing to count, and the
  view says so.
- **Versions**: the store's history, with the page to itself (it has nothing to set).
- **Figures**: a menu of the figures saved with it, when there are any.

A figure or report the store lists but whose data can't be read (a version copied
somewhere without all of its files, say) stays in its menu, named with the reason, and
can't be opened; the others open as usual.

Beside the tabs are **Color by** (the same box as in the Display drawer, below: type a
gene's or an annotation's name and pick it), a scale bar (when the store says its
coordinates are microns), zoom out and in, and **Fit to data**, which stay in reach when
the drawers are away; when the view is narrow they move under the tabs. For a Visium
store, whose observations are capture spots, the header, the map's tab, Composition and
Label cells say spots rather than cells.

Two drawers float over the view. Pull one in with its tab at the edge of the view and
push it away with its arrow, or press **[** for the left one, **]** for the right one
and **\\** for both at once; the app remembers which you keep open. In a window narrower
than 1,100 pixels only one is out at a time. The left one holds
the analysis tasks ([Analyze in the browser](analyze.md)). The right one, **Display**,
holds the display settings, the same panel with the same names as in an Analysis
Workspace: **View** (cells and image on or off, mirroring, zoom, the overview, fit),
**Cells** (first **Color by**, with the color range when the color is a number, and the
color legend and its title; then render mode,
point size and shape, the cell boundaries and their style, opacity, and each category's
color) and **Image** (which image, a light or dark backdrop, and each channel's color,
contrast and name). **Color by** is one search box: click it to list the store's
annotations, groupings first, or type a gene's name to find it. Arrow keys and Enter
pick from the list and Esc closes it. When the store has layers, **Gene values** below
it picks whether a gene is read from the expression matrix or from one of them.

A store first opens with a light backdrop behind a stained (brightfield) slide and a dark
one behind fluorescence, and the legends and overview take the backdrop's colors. It
opens colored as it was saved, unless that color has a single group (a column every cell
shares), in which case it opens colored by its first grouping with 2 to 50 groups. A
store with no such grouping opens with its cells drawn as outlines (where it has cell
boundaries), so the image shows through them. A gene or other number is colored from the
1st to the 99th percentile of the cells' non-zero values (from zero when some cells are
zero), so a few cells with very high counts don't leave the rest of the tissue dark; cells
past either end take its color, and the legend marks that end with ≥ or ≤. **Color
range** sets the range by hand and **Reset** returns it. The tissue and the cell map share
one color: choosing a color, its range, its legend title or a group's color on one changes
the other. On
**Composition** the drawer holds the color, which picks the groups counted, and
**Across**, the column they are counted across.
