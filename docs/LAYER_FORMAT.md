# Version layer format

A **version** of a SpatialData store is saved as only what changed. The web app
(`cirro-studio/`) writes one whenever someone saves their work on a store: a new obs
column, an embedding, an analysis result, a figure, or a deletion. The store itself is
never copied. A version names the version (or store) it sits on, so a chain of them —
a *stack* — reads as one store whose top is the newest version. This file specifies the
format; the writer is `cirro-studio/src/stack/`, and `backend/app/persistence/sds_layers.py`
reads it from Python. An Analysis Workspace opens a version through that reader (see
[In an Analysis Workspace](#in-an-analysis-workspace)).

The design borrows from container image layers. Each layer holds the objects it adds or
replaces, plus *whiteouts* for what it deletes, and a reader answers each key from the
topmost layer that has it.

## A version is a dataset

A version is one dataset (a Cirro dataset, or a folder) holding, in its data directory:

```
layer.json        the manifest below
overlay/<key>     each object the version adds or replaces, at its store key
```

Store keys are Zarr keys relative to the store's root, such as
`tables/table/obs/leiden/codes/c/0`. The overlay is not a Zarr store on its own; it only
has meaning over the layers below it.

### `layer.json`

```jsonc
{
  "format": "spatial-data-studio.layer",
  "format_version": 1,
  // The version this one sits on: a store (`.zarr` folder or `.zarr.zip` file) or
  // another version's layer.json, as a Cirro reference (below).
  "parent": "cirro:::dataset:5f1c…/layer.json",
  // The store at the bottom of the stack, so a reader can name it without walking.
  "base": "cirro:::dataset:0d13…/results/Pancreas/results-c62cc1463792.sdata.zarr.zip",
  "depth": 2,                     // 1 for a version directly on the store
  "title": "Tumor margin regions",
  "message": "Drawn around the invasive front",
  "created_at": "2026-10-20T06:41:12.008Z",
  "created_by": "someone@example.org",
  "app": { "id": "spatial-data-studio", "version": "1.3.0" },
  "overlay": "overlay",           // folder holding the objects, next to layer.json
  "files": [ { "key": "zarr.json", "size": 170212 }, … ],
  "deleted": [ "tables/table/obs/old_labels/" ],
  "changes": [ { "op": "set-obs", "table": "table", "column": "regions", "kind": "categorical" }, … ]
}
```

- **`files`** lists every object under `overlay/`, which spares a reader from listing
  the dataset or probing for keys that aren't there.
- **`deleted`** holds the whiteouts. An entry ending in `/` deletes a whole node and
  everything under it; any other entry deletes one key. A whiteout hides keys in the
  layers *below* its version, not that version's own `files`. So one version can delete
  a column and write a new one of the same name: the old column's chunks stay hidden and
  the new ones show.
- **`changes`** is the readable summary the app's history shows. The objects themselves
  are the record. The ops are `set-obs`, `delete-obs`, `set-obsm`, `set-uns`,
  `delete-uns`, `set-figure` and `delete-figure`.

## References

Parents are **Cirro references**, the URI grammar Cirro's sheets and portal use:

```
cirro:<tenantId>:<projectId>:dataset:<datasetId>/<path>
```

`<path>` is relative to the dataset's data directory and is never percent-encoded.
Versions write the *empty-scope* form, with no tenant and no project:
`cirro:::dataset:<datasetId>/<path>`.

Cirro resolves such a reference through the project it is read from. A dataset shared
into another project keeps its ID there, so a stack still resolves when its datasets
reach a project through a share. They don't all have to arrive in the same share. A
reader resolves a dataset ID in the current project first, then in any other project
the user can see.

## Reading a stack

1. Follow `parent` from the top version down until it names a store rather than a
   `layer.json`. That store is the base.
2. To read a key, walk the versions from the top down:
   - if a version's `files` has the key, read `overlay/<key>` from that version;
   - otherwise, if one of the version's `deleted` entries covers the key, the key does
     not exist;
   - otherwise go on to the version below.

   If no version answers, read the key from the base.

That is the whole reader. `LayeredStore` in `cirro-studio/src/stack/layeredStore.ts`
implements it as a zarrita store, and `StackStore` in `sds_layers.py` as a zarr-python 3
store.

## What a writer must keep consistent

Readers rely on two indexes beside the objects. A version that changes a node rewrites
both, and the rewritten documents are objects in that version like any other:

- **The parent group's metadata.** An AnnData dataframe lists its columns in the
  `column-order` attribute of `tables/<t>/obs/zarr.json`, so adding or deleting an obs
  column rewrites that document.
- **The root's consolidated index.** The `consolidated_metadata` in the root `zarr.json`
  must list every node of the composed store and nothing that is gone. zarr-python
  rebuilds the tree from that flat index with `itertools.groupby` over keys sorted by
  depth, which only gathers a group's children when they are next to each other. So the
  writer emits the index sorted by depth, then by path.

Arrays are written as Zarr v3 with a single chunk: the `bytes` codec (or `vlen-utf8` for
strings), then `gzip`. Their AnnData encodings match what anndata writes: `categorical`
groups with `codes` and `categories`, `array`, `string-array`, `string` (a 0-d string),
`dict` and `dataframe`. So anndata and spatialdata read a stack without knowing it is
one.

## What the app keeps in `uns`

Figures and analysis results go in the annotated table's `uns`, under
`spatial_data_studio`:

| Key | Holds |
| --- | --- |
| `uns["spatial_data_studio"]["figures"][<id>]` | a figure spec as a JSON string: a canvas view (the display's colors, channels and camera) or a chart over a result, with its title, caption and print width |
| `uns["spatial_data_studio"]["results"][<id>]["table"]` | an analysis result's main table as a dataframe (markers, a comparison, Moran's I, neighborhood enrichment, niches, clusters) |
| `uns["spatial_data_studio"]["results"][<id>][<name>]` | any further tables the result keeps beside it, as dataframes (for example the cells a comparison drew on the tissue) |
| `uns["spatial_data_studio"]["results"][<id>]["meta"]` | what made it, as a JSON string: the kind of analysis (`kind`), its title, method, parameters, a `summary` of what its report needs (group sizes, cutoffs and the like), who ran it, when, and the app version |

A figure is a description, not a picture. Opening its version redraws it from the data
it sits on, and export draws it to SVG, PNG or PDF on demand. A result is the same: its
report is drawn from what is kept, so it reads the same whenever it is opened.

## From Python

Download the datasets of a stack, each into a folder named by its dataset ID, then
choose one of two ways in.

To read a table in place:

```python
import anndata, json, zarr
from sds_layers import open_stack

root = zarr.open_group(open_stack("downloads/<top version id>"), mode="r")
adata = anndata.read_zarr(root["tables/table"])
spec = json.loads(adata.uns["spatial_data_studio"]["figures"]["fig_…"])
```

`spatialdata.read_zarr` opens a path, or a group on a local or fsspec store, but not the
store `open_stack` returns. For it, write the stack out as one store first:

```bash
python backend/app/persistence/sds_layers.py flatten downloads/<top version id> out.zarr
```

Over a folder base, `flatten` links the base's objects instead of copying them; a
`.zarr.zip` base is extracted. `describe` lists a stack's versions.

Where a dataset's folder is not named by its ID, as in a Cirro workspace, give the map
from ID to folder name: `folders=` to `open_stack` and `Stack.resolve`, or `--folders`
with a JSON object to either command. In a workspace that object is the
`SDS_CIRRO_DATASETS` variable:

```bash
python backend/app/persistence/sds_layers.py flatten --folders "$SDS_CIRRO_DATASETS" \
  ~/datasets/<version folder> out.zarr
```

A manifest arrives with downloaded data, so `sds_layers.py` checks it before following
it: keys, the `overlay` folder, reference paths and the member names of a `.zarr.zip`
base must be relative paths with no empty, `.` or `..` segment and no backslash, dataset
IDs may hold only letters, digits and hyphens, and anything else is an error. So is a
chain of `parent` references that comes back to a version already in it, or that runs
more than 500 versions deep. `flatten` also refuses to read a version's object from
outside its overlay folder or to write outside the output folder, even through a
symbolic link. A folder the folder map names must meet the same rules as a path and lead
to a folder inside the datasets folder.

## In an Analysis Workspace

An Analysis Workspace opens a version the way it opens a saved checkpoint. A folder holding a
version's `layer.json`, at its top or under `data/`, is listed under **Open Checkpoint**
in the New Session dialog, by its path under the data directory followed by the
version's title when that differs from the folder's name, and Import Data's SpatialData
reader accepts one too. Opening it follows the stack down to the base, writes the whole
stack out as one store in the session's working directory (`SDS_WORK_DIR`), and reads
that. The store is a copy, not links into the base, so it costs what opening the same
store as a `.zarr.zip` costs, and the session's later saves never touch the version or
anything below it. A save writes a new `.sdata.zarr.zip` checkpoint; saving over the
version's own folder is refused.

A parent is looked up in the folder that holds the opened version's folder: in the
folder the folder map names for its dataset ID, or else in the one named by the ID
itself, which is how a download is laid out. Every folder the stack reads must be under
the workspace's data directory, like any other input.

In a Cirro workspace every attached dataset is mounted read-only at
`$HOME/datasets/<folder name>` (also `/mnt/datasets/<folder name>`), and the folder is
named for the dataset, not by its ID. The web app sets the workspace's
`SDS_CIRRO_DATASETS` variable to the folder map, a JSON object with an entry for every
mounted dataset:

```json
{ "5f1c…": "Tumor margin regions", "0d13…": "Pancreas results" }
```

When it starts a workspace on a saved version, the web app attaches every dataset of
its stack: the base store's and each version's. A version whose parent isn't attached
does not open; the message names the missing dataset's ID.
