# Public Data

Open the [web app](https://spatial-studio.apps.cirro.bio/) (**Open the app** at
the top of this site). It opens straight onto Spatial Data Studio's public sections, with
no account. Public data is read-only: you can look and run every analysis, and what you
save stays in this browser ([Projects](find-a-dataset.md#projects)). **Log In (Cirro)** at
the top right adds your own data ([Your Data (Cirro)](cirro.md)).

Finding a dataset and looking at it work the same for both:
[Find a dataset](find-a-dataset.md) and [Look at a section](look-at-a-section.md) cover
them. This page covers what public data is, which of it your browser lists, and how to
show your own.

## Public projects

Public data comes in [projects](glossary.md#project), as all data in the app does. A
public project is a project anyone can open with no account: a Cirro publication,
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

