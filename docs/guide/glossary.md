# Words this guide uses

Spatial Data Studio uses a few words in a particular sense. Each is defined here, with a
link to where the guide covers it.

## Analysis Workspace

The server version of Spatial Data Studio: every squidpy and scanpy function through
point-and-click forms, curated recipes of several steps, and the memory of a whole
machine. It runs as a workspace in your Cirro project, started from the web app, or on
your own computer with Docker. [Analysis Workspaces](analysis-workspaces.md).

## Annotation

A column of a store's table with one value per cell: a grouping, such as clusters, cell
types or the areas you labelled, or a number, such as a quality metric. You color the
cells by an annotation, and an analysis that works on groups takes a grouping of 2 to 100
groups. In SpatialData it is a column of the table's `obs`.

## Cell, spot

What each point on the tissue is. Most platforms measure cells; Visium measures capture
spots, and the app says spots rather than cells for a Visium store.

## Checkpoint

A store Spatial Data Studio saved whole, as one `.sdata.zarr.zip` file: what an Analysis
Workspace saves, and what Spatial Data Studio's [workflow](#workflow) makes of an
instrument run. It carries copies made for fast reading, so it opens quickly in the web
app, in an Analysis Workspace, or in the [viewer](#viewer) on its own. A
[version](#version) is different: it holds only what changed.

## Cirro

The data platform Spatial Data Studio is built with. Your organization has its own Cirro,
at its own address, and you log in to it to open your projects.
[Your Data (Cirro)](cirro.md).

## Dataset

Cirro's unit of data in a project: an upload, a pipeline's output, or a version the app
saved. One dataset can hold several items (several stores, runs or images), and the
[map](#map) shows each one. The guide also says dataset for the item you open.

## Expression matrix

Each cell's count of each gene: the table's `X`. Coloring by a gene and the gene analyses
read it. A store saved without it still offers labelling, neighborhoods, niches and
figures.

## Figure

A view kept with its colors and framing (the tissue or the cell map), or a chart from a
report. A figure is kept inside the version it was made in, or downloaded as SVG, PDF or
a 300 dpi PNG. Figures are the fourth [stage](#stage).
[Keep a figure](analyze.md#keep-a-figure).

## Instrument run

An instrument's raw output as it wrote it (Xenium, Visium, CosMx, MERSCOPE and others):
the transcripts or spots, the instrument's own cell segmentation, the images and the
run's metrics. It isn't SpatialData yet: a pipeline makes a store of it. Instrument runs
are the second [stage](#stage).

## Map

What a project opens as: its items as bubbles in four columns, one per [stage](#stage),
with dashed lines joining a run or an image to the spatial data made from it.
[The map](find-a-dataset.md#the-map).

## Project

Where data lives. A Cirro project holds a team's datasets, and your role in it decides
what you can do there; a public project is one anyone can open with no account. Every
project is either one you can add to or a [read-only](#read-only) one.
[Projects](find-a-dataset.md#projects).

## Public Data

The public projects the web app opens on, starting with Spatial Data Studio's own
examples, which anyone can open with no account. Settings adds others, including your
own. [Public Data](public-data.md).

## Read-only

A project you can look at and analyze but not add to: every public project, and a Cirro
project where your role lets you only view. What you save there is kept in this browser,
where nobody else can see it.

## Report

What an analysis opens as when it finishes: what was run and with which settings, the
numbers that sum it up, its charts, a card for each group and the full table. It is kept
with the data. [Reports](analyze.md#reports).

## Section

A tissue section: the thin slice of tissue an instrument measured, and what you look at
in the app. A [store](#store) holds a section's cells, images and cell boundaries.
[Look at a section](look-at-a-section.md).

## Session

In an Analysis Workspace, one dataset opened to work on, held in the workspace's memory.
Whoever opens it holds its edit lock, and others can watch.
[Work in it together](analysis-workspaces.md#work-in-it-together).

## SpatialData

The open format ([spatialdata.scverse.org](https://spatialdata.scverse.org/)) that
analysis-ready spatial data is kept in: a section's cells, with their positions,
expression and annotations, together with its images and cell boundaries. Spatial data,
the third [stage](#stage), is data in this format.

## Stage

One of the four kinds of data the web app works with, in order: Images, Instrument runs,
Spatial data and Figures. An item moves on to the next stage when a pipeline or an
analysis makes it. [Four stages of data](find-a-dataset.md#four-stages-of-data).

## Store

One SpatialData store: a `.zarr.zip` file or a `.zarr` folder holding a section's cells,
images and cell boundaries. Opening a store is what shows a section. A
[checkpoint](#checkpoint) is a store Spatial Data Studio saved whole; a
[version](#version) is read over the store it was saved on.

## Unsaved changes

What tasks have made since you last saved, shown in a bar at the bottom of the page.
They are kept in this browser, so a reload loses nothing, until you save them as a
version or discard them. [Save a version](cirro.md#save-a-version).

## Version

What the web app saves: only what changed (a new column of labels, a report, a figure),
on top of the store or version it was saved on, so a column of labels is kilobytes beside
a store of gigabytes. In a project you can add to, each version is a new dataset; in a
read-only one, it is kept in this browser. Nothing is overwritten, so going back is
opening an older version. [Versions and history](cirro.md#versions-and-history).

## Viewer

The part of Spatial Data Studio that draws a section. On its own, it opens a checkpoint
in any browser with nothing running behind it, and it can sit in a frame on another
page. [Share and embed the viewer](viewer.md).

## Web app

Spatial Data Studio in your browser, at
[spatial-studio.apps.cirro.bio](https://spatial-studio.apps.cirro.bio/), with nothing to
install. It opens Public Data and your Cirro projects, and its analyses run in your
browser. [Introduction](README.md).

## Workflow

Spatial Data Studio's Nextflow pipeline. It reads an instrument run with its platform's
reader, runs the standard analysis for that kind of data, and saves the result as a
checkpoint. [`nextflow/README.md`](../../nextflow/README.md).
