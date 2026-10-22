# Your data in Cirro

[Cirro](https://cirro.bio/) is the data platform Spatial Data Studio is built with. A
Cirro project holds a team's datasets: instrument runs, images, pipeline results. The web
app opens a project, reads its spatial data where Cirro stores it, and saves what you
make back into the project as new datasets, so everyone on the project can open them.
Nothing is downloaded to your computer.

Everything in [Explore public data](public-data.md) works the same here. This page covers
what is different about your own data.

## Log in

**Private Data (Cirro)** on the start page asks which Cirro you use. It suggests the
ones it knows as you type their name, and takes the address you use for any other (such
as cirro.example.org). It remembers your choice for next time. You sign in on Cirro's
own page, which shows what the app may do, and the app never sees your password.
Logging in works once your organization's Cirro has registered the app.

When a Cirro can't be reached or the log-in doesn't finish, the page says why and offers
**Try again** or **Log in to another Cirro**. Signed in, the menu at the top right (your
Cirro and your name) has **Log out** and **Log in to another Cirro** on every page,
including when your account can't see any projects yet. Each browser tab logs in on its
own, so a new tab asks again.

## What the app finds in a project

A project opens as the [map](public-data.md#the-map) of the
[four stages of data](public-data.md#four-stages-of-data). The app finds the items on it
by reading the file list of every finished dataset in the project that a spatial or
imaging pipeline or data type made, that was uploaded as plain files (Cirro's **Files**
type), or that the app saved itself. Pipelines and data types are matched by their name
or ID, which differ between Cirros: names containing spatial, Xenium, Visium, Space
Ranger, CosMx, MERSCOPE, sopa, Proseg, segment, Cellpose, StarDist, MCMICRO, CODEX,
OME-TIFF, image, QuPath or ARTIST. Within a dataset, its files decide the stage, and one
dataset can hold items of several stages.

The app reads each dataset's file list once. It keeps what it found in a sheet in the
project (*Spatial Data Studio catalog*), so the next visit, by anyone, reads only the
datasets added since. Where the project can't have that sheet, the catalog stays in your
browser and the top bar says so.

## Images and instrument runs

An image opens across the page with its channels in the right drawer. A run opens with
the metrics its instrument reported. Both list, in the left drawer, the pipelines in
your Cirro that take them further: cell segmentation for an image (Cellpose, StarDist,
nf-core/sopa), and Spatial Data Studio's workflow for a run. These open Cirro's own
launch form for the dataset, so the pipeline's options, cost and permissions are Cirro's
to show. Their output appears on the map as spatial data, linked back to what it was
made from.

Spatial Data Studio's workflow reads each run with its platform's reader, runs the
standard analysis for its kind of data (for Xenium: quality control, normalization, a
PCA, a UMAP, Leiden clusters, marker genes and cellular neighborhoods), and saves the
result as a checkpoint that opens colored by its neighborhoods or clusters.
[`nextflow/README.md`](../../nextflow/README.md) has what it does for each platform.

## Save a version

What a task makes is not saved straight away. It goes into **unsaved changes**, shown in
a bar at the bottom of the page with what they are and how big. **Save as a version**
writes them as a new dataset in the project, holding only what changed: a new column of
labels is kilobytes, beside a store of gigabytes that is not copied. The dataset is
tagged as this app's, filed in the store's Cirro folder, and carries a note saying what
was saved and by whom; the top bar says the catalog is updating while the project is
read again to list it. **Discard** throws the changes away. Until you do one or the
other they are kept in this browser, so a reload loses nothing. Logging out, or logging
in to another Cirro, discards a project's unsaved changes (the app asks first), so the
next person to log in on the same browser can't open them. On Public Data, a version is
kept in this browser instead, and its unsaved changes stay when you log in or out.

## Versions and history

**Versions** shows a store's history: the original store at the bottom and each version
above the one it was saved on, with what it changed. Open any version to see the data
exactly as it was saved. Saving from an older version starts a branch beside the newer
ones rather than replacing them. Nothing is ever overwritten, so going back is always
just opening an older version.

A version is ordinary SpatialData underneath, so it can also be read from Python:
[`docs/LAYER_FORMAT.md`](../LAYER_FORMAT.md) explains how, and what the app keeps in `uns`.

## Work as a team

A project is shared, so what one person saves is there for the rest:

- **Versions.** Each version is a dataset in the project, with a note of what was saved
  and by whom, and anyone on the project can open it, see the reports and figures kept
  in it, and save their own version on top. Two people saving on the same version make
  two branches side by side; neither replaces the other.
- **Sharing beyond the project.** Every version names the one it was saved on, by
  dataset ID. A stack of versions therefore still opens after its datasets are shared
  into another project, whether they are shared together or one by one.
- **Working at the same time.** To work on one analysis together, with everyone seeing
  each step as it runs, share an
  [Analysis Workspace](analysis-workspaces.md#work-in-it-together).

What each person can see and change is what their own role in the project allows.

## What it can see and do

The app acts as you, with the permissions your project role gives you and the ones
your organization granted the app; it never sees your password. It reads data by
short-lived signed links straight from the project's storage, and nothing it reads
leaves your browser. It writes only what you save: a version dataset, its note, and the
project's catalog sheet, and the workspaces you start, each with a note of what it
opened.
