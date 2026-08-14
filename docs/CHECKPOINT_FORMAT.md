# Checkpoint file format (`.zarr.zip`)

This is a byte-for-byte specification of the checkpoint file Spatial Data Studio
saves and reads: a single `.sdata.zarr.zip` archive that holds a complete
[SpatialData](https://spatialdata.scverse.org/) object plus a small amount of
app-defined metadata layered on top. It is written for someone building a
**different** application that needs to read (or write) this file — the app's own
`backend/app/persistence/store.py` (writer) and `frontend/src/data/checkpointSource.ts`
(reader) are the reference implementation; this document describes the format
they agree on, independent of either implementation.

If you only need the *design rationale* (why a sidecar exists, why rasters are
sharded), see [DESIGN.md](../DESIGN.md) §14. This document is the field-level
reference DESIGN.md points to.

Every app-defined structure described below has a canonical [JSON Schema](https://json-schema.org/)
document under `backend/app/schemas/checkpoint/*.schema.json` (also listed in
[Schema files](#schema-files)). The app validates every one of these structures
against its schema **before** writing it to disk — see
[Validation guarantee](#validation-guarantee) — so a checkpoint this app produced
is always schema-conformant. A schema file is portable JSON Schema (draft
2020-12): validate against it with any language's JSON Schema library, not just
Python's.

## Contents

- [1. File-level structure](#1-file-level-structure)
- [2. SpatialData / Zarr conventions (not app-defined)](#2-spatialdata--zarr-conventions-not-app-defined)
- [3. `attrs["app_state"]` — application state](#3-appstateapp_state--application-state)
- [4. The `viewer/` sidecar group](#4-the-viewer-sidecar-group)
- [5. Raster sharding](#5-raster-sharding)
- [6. Worker logs (`logs/`)](#6-worker-logs-logs)
- [7. Content-hash filenames](#7-content-hash-filenames)
- [8. `index.json` — a collection of checkpoints](#8-indexjson--a-collection-of-checkpoints)
- [9. Versioning and compatibility](#9-versioning-and-compatibility)
- [10. Reading a checkpoint from scratch](#10-reading-a-checkpoint-from-scratch)
- [Schema files](#schema-files)
- [Validation guarantee](#validation-guarantee)

---

## 1. File-level structure

A checkpoint is a **zip archive**, `ZIP_STORED` (no zip-level compression — every
array inside is already zstd-compressed at the Zarr codec level, so compressing
again would just cost CPU for no size benefit). Its entries are exactly the files
of a [Zarr v3](https://zarr-specs.readthedocs.io/en/latest/v3/core/index.html)
directory store, flattened with `/`-separated relative paths as zip arcnames —
i.e. unzip it anywhere and you have an ordinary Zarr v3 store on disk.

```
<name>-<12-hex-content-hash>.sdata.zarr.zip     # see §7 for the filename convention
├── zarr.json                     # root group metadata + attrs (app_state lives here, §3)
├── images/<element>/...          # SpatialData images (multiscale OME-Zarr-ish arrays)
├── labels/<element>/...          # SpatialData labels (segmentation masks)
├── points/<element>/...          # SpatialData points
├── shapes/<element>/...          # SpatialData shapes (GeoParquet-backed)
├── tables/<key>/...              # SpatialData tables (AnnData: X, obs, var, obsm, obsp, layers, uns)
├── viewer/                       # APP-DEFINED sidecar — not a SpatialData element (§4)
│   ├── zarr.json                 #   sidecar_version, table_keys, images, coords_transform
│   └── tables/<key>/X_csc/       #   gene-major mirror of a sparse table's X
├── logs/<record_id>.log.gz       # APP-DEFINED — relocated worker stdout/stderr (§6)
└── .zmetadata / consolidated…    # Zarr consolidated metadata, written last (see §2)
```

Everything **except** `viewer/` and `logs/` is a plain SpatialData Zarr store —
readable with `spatialdata.read_zarr()` (Python) with no knowledge of this app at
all (`sd.read_zarr` ignores unknown root-level groups, so `viewer/` and `logs/`
are silently skipped by it). `attrs["app_state"]` on the root group is technically
plain Zarr group metadata, but its *contents* are app-defined (§3).

A reader that wants **only** the SpatialData object can stop there. A reader that
wants to reproduce this app's own rendering — which image/table/display was
showing, in what colors, at what pan/zoom — needs `attrs["app_state"]` (§3) and,
for a browser-based reader with no server backend, the `viewer/` sidecar (§4).

## 2. SpatialData / Zarr conventions (not app-defined)

These are upstream conventions this app relies on but does not define; consult
the [SpatialData](https://spatialdata.scverse.org/en/stable/) and
[Zarr v3](https://zarr-specs.readthedocs.io/en/latest/v3/core/index.html) specs
for their full definitions. Pinned versions: spatialdata 0.7.3, zarr-python 3.x,
anndata (see `backend/requirements.txt` for exact pins).

- **Root group attrs** (`zarr.json`'s `attributes`) carry `spatialdata_attrs`
  (SpatialData's own format/version marker) alongside this app's `app_state` (§3)
  — they're just two keys in the same JSON object.
- **`images/`, `labels/`** — multiscale pyramidal rasters (OME-Zarr-flavored
  multiscale metadata), shape `(c, y, x)` or `(y, x)`, coordinate transforms
  recorded in SpatialData's own `coordinateTransformations` metadata (not this
  app's `coords_transform`, which is a different, narrower affine — see §4).
- **`points/`, `shapes/`** — points as Parquet-backed dataframes; shapes as
  GeoParquet (geometry column + attribute columns). Not app-defined; a reader
  needs GeoParquet support to decode `shapes/`.
- **`tables/<key>/`** — one AnnData per table: `X` (dense or CSR sparse
  expression/intensity matrix), `obs`/`var` (row/column metadata, categoricals
  stored the anndata-zarr way), `obsm` (arrays keyed by name, e.g. `spatial`,
  `X_umap`), `obsp` (sparse graphs), `layers`, `uns` (free-form).
  `obs["<region>"]`-style linkage back to a shapes/labels/points element is
  recorded in `uns["spatialdata_attrs"]["region"]`.
- **Consolidated metadata** — `_write_browser_reader_support` (§9) always
  finishes a write by re-running Zarr's consolidated-metadata pass
  (`zarr.consolidate_metadata` / spatialdata's own wrapper around it) so the
  entire group tree can be discovered from the root `zarr.json` in one read,
  with no server-side directory listing. **This must be current for the file to
  be usable by a range-read browser client** — Zarr v3 stores carry no separate
  child index, so a stale consolidated tree (e.g. from hand-editing the archive)
  makes elements invisible to that kind of reader even though the bytes are
  present on disk.

## 3. `attrs["app_state"]` — application state

Lives at `sdata.attrs["app_state"]` — i.e. a key in the **root group's**
`zarr.json` `attributes` object, inlined as plain JSON (not a separate array or
group). This is the entire piece of state a reload needs to reproduce the
in-app UI: the compute audit log, plot records, display configuration
(color-by, viewport, channel visibility, …), per-field version counters, and
region-set (annotation) definitions.

Schema file: [`backend/app/schemas/checkpoint/app_state.schema.json`](../backend/app/schemas/checkpoint/app_state.schema.json).

```jsonc
{
  "schema_version": 3,
  "compute_history": [ /* §3.1 */ ],
  "plots":           [ /* §3.2 */ ],
  "displays":        [ /* §3.3 */ ],
  "data_versions":   { "obs:leiden": 3 },   // field_path -> monotonic counter, never reset
  "regions":         [ /* §3.4 */ ]
}
```

`data_versions` is a flat map from a **field path** (the same address grammar
used throughout the app — `obs:<col>`, `obsm:<key>`, `X:<gene>`, `var:<col>`,
`obsp:<key>`, `image:<element>`, `shapes:<element>`) to an integer that is
bumped every time a compute step's structural diff touches that field. It has
no other structure; values only ever increase.

### 3.1 `compute_history[]`

One entry per compute step ever run (queued, running, completed, or failed) —
an append-only audit log, never rewritten in place except for `status`.

| field | type | required | notes |
|---|---|---|---|
| `id` | string | yes | UUID |
| `namespace` | string | yes | e.g. `gr`, `im`, `tl`, `read`, `sc.pp`, `sc.tl`, `sc.get`, `custom` |
| `function` | string | yes | dotted function name within the namespace |
| `params` | object | yes | the exact kwargs the function was called with |
| `status` | enum | yes | `pending` \| `queued` \| `running` \| `completed` \| `failed` |
| `library_versions` | object (string→string) | yes | library name → version, stamped once at creation (e.g. `{"squidpy":"1.8.2"}`) |
| `structural_diff` | object | yes | `{facet: [changed names]}` — see below; `{}` until the step completes |
| `started_at` | string (ISO-8601) | no | present once `status` first becomes `running` |
| `finished_at` | string (ISO-8601) | no | present once `status` becomes `completed`; **absent on `failed`** |

`structural_diff` keys are drawn from a fixed vocabulary of eleven facets:
`obs`, `var`, `obsm`, `obsp`, `layers`, `uns` (table-level) and `images`,
`labels`, `points`, `shapes`, `tables` (SpatialData-element-level). `X` is
deliberately never a key here (an X-only mutation, e.g. normalization, is
tracked through `data_versions` instead, not a structural diff). A step's own
captured stdout/stderr is **never** part of the persisted record — see §6.

A file on disk can legitimately contain a `running` or `queued` compute-history
entry (a checkpoint saved while another step was mid-flight); a reader should
treat those as stale/unknown outcome, not as an error.

### 3.2 `plots[]`

Same shape as a compute-history entry but for plot-producing calls (namespace
`pl`), with two differences: `references` instead of `structural_diff`, and a
wider `status` enum because the rendered figure itself is **never persisted** —
only the recipe to redraw it.

| field | type | required | notes |
|---|---|---|---|
| `id`, `namespace`, `function`, `params`, `library_versions`, `started_at`, `finished_at` | — | as above | same semantics as a compute-history entry |
| `status` | enum | yes | `pending` \| `queued` \| `running` \| `drawn` \| `invalidated` \| `failed` |
| `references` | array of string | yes | field paths the plot depends on, e.g. `["obs:leiden"]` or `["X:CD3"]` |

On **load**, this app remaps any on-disk `drawn`/`failed`/`running`/`queued`
plot to `invalidated` in memory (a rendered figure is never carried across a
reload, so those statuses are meaningless the moment the file is reopened) —
but the file itself can and does contain all six values, since that remap
happens after load, not before save. A reader reproducing "what plots exist"
should treat `drawn` on disk as "was drawn as of the last save, redraw to see
it now."

### 3.3 `displays[]`

One entry per open canvas (spatial or embedding). There is **no server-side
validation** of this shape in the live app today — the schema in
`app_state.schema.json` is this app's own commitment to the shape it writes,
enforced only at the checkpoint-write boundary (§ Validation guarantee), not on
every API call that edits a display.

Common envelope:
```jsonc
{ "id": "uuid", "type": "spatial_canvas" | "embedding_canvas",
  "encoding": { /* shape depends on type, see below */ },
  "viewport": { "target": [x, y] /* or [x,y,z] */, "zoom": z,
                "rotationX"?: number, "rotationOrbit"?: number } | null }
```
`rotationX`/`rotationOrbit` are present only on a 3D embedding canvas viewport.

**`type: "spatial_canvas"` → `encoding`:**

| field | type | required | notes |
|---|---|---|---|
| `coords` | string | yes | field path of the plotted coordinates, e.g. `obsm:spatial` |
| `color_by` | string \| null | yes | field path colouring the points, or null |
| `image_layer` | string \| null | yes | image element shown, or null |
| `shapes_layer` | string \| null | yes | shapes element shown, or null |
| `point_size` | number | yes | |
| `opacity` | number | yes | |
| `colormap` | string | yes | e.g. `viridis`, used when `color_by` is numeric |
| `channels` | object | no | keyed by **stringified channel index** (`"0"`, `"1"`, …) → `{visible: bool, name: string, color?: string, contrast_limits?: [number, number]}` |
| `legend_visible`, `show_points`, `show_image`, `show_channel_legend`, `show_minimap` | boolean | no | layer/legend visibility toggles |
| `legend_title` | string | no | |
| `isolated_category` | string \| null | no | dim every category except this one |
| `category_colors` | object | no | `{color_by_path: {category_label: "#rrggbb"}}` |
| `render_mode` | enum | no | `points` \| `points+shapes` \| `shapes` |
| `boundary_style` | enum | no | `filled` \| `outline` |
| `boundary_line_width` | number | no | |
| `point_marker` | enum | no | `circle` \| `square` \| `hexagon` |
| `invert_x`, `invert_y` | boolean | no | mirror the plot |
| `background` | enum | no | `light` \| `dark` |

**`type: "embedding_canvas"` → `encoding`:**

| field | type | required | notes |
|---|---|---|---|
| `obsm_key` | string | yes | e.g. `X_umap` |
| `x_component`, `y_component`, `z_component` | integer | yes | column indices into the `obsm` array; `z_component` is only *used* when `is_3d` |
| `is_3d` | boolean | yes | |
| `color_by` | string \| null | yes | |
| `point_size`, `opacity` | number | yes | |
| `colormap` | string | yes | |
| `legend_visible`, `legend_title`, `category_colors` | — | no | same as spatial canvas |

An embedding encoding never carries `image_layer`, `channels`,
`render_mode`, or any of the spatial-only fields above — don't union the two
shapes.

### 3.4 `regions[]`

A **region set** is a named categorical annotation over cells, backed by an
ordinary `obs` column of the same name (drawing a region never creates
geometry — see DESIGN.md §10.1 for why). Registered here purely as a
convenience index over `obs` columns that are region sets.

```jsonc
{ "id": "uuid", "name": "tumor_vs_stroma", "obs_column": "tumor_vs_stroma",
  "categories": [
    { "label": "tumor", "color": "#c1432b", "n_cells": 18234 },
    { "label": "unassigned", "color": "#bbbbbb", "n_cells": 1203 }
  ] }
```
`name` and `obs_column` are always identical in this app (there is no rename
that diverges them, but a reader should not assume that invariant holds
forever). `categories` is the **complete, replaced-in-full** list as of the
last time the set was assigned — not an incremental diff. `color` is a hex
string; this app always writes 6-digit lowercase hex, but a hand-edited or
third-party-written file could carry an arbitrary string here, so a strict
reader should validate the `^#[0-9a-fA-F]{6}$` pattern rather than assume it.

## 4. The `viewer/` sidecar group

A top-level Zarr **group** (not a SpatialData element — ordinary
`spatialdata.read_zarr()` ignores it entirely). It exists so a browser can
render a checkpoint with **no backend at all**: everything in it is either
expensive to recompute from the raw SpatialData arrays (per-image geometry,
contrast domains) or would otherwise force downloading far more bytes than
necessary (the CSC gene mirror, §4.2). A file that predates this group, or
whose sidecar is stale relative to the data, cannot be opened by a
backend-less reader — see §9.

Schema file: [`backend/app/schemas/checkpoint/viewer_sidecar.schema.json`](../backend/app/schemas/checkpoint/viewer_sidecar.schema.json).

Group attrs (`viewer/zarr.json`'s `attributes`):

```jsonc
{
  "sidecar_version": 1,
  "table_keys": ["adata"],
  "images": {
    "<image_element>": {
      "<table_key_or_empty_string>": { /* ImageInfo, §4.1 */ }
    }
  },
  "coords_transform": {
    "<table_key>": [a, b, c, d, e, f]   // see affine convention below
  }
}
```

`images` is keyed **twice**: by image element name, then by table key (plus the
empty string `""` for "no table"). This is because reconciling an image against
cell coordinates (`pixel_to_world`, inside `ImageInfo`) depends on *which*
table's spots the image is being aligned to — a dataset with two tables
pointing at the same image can have two different reconciliations. Every
combination is precomputed at save time so a reader never has to re-derive it.

**Affine convention** (`coords_transform` and `ImageInfo.pixel_to_world`): a
flat 6-float array `[a, b, c, d, e, f]` meaning
```
x' = a*x + b*y + c
y' = d*x + e*y + f
```
i.e. a 2D affine in row-major `[a b c; d e f; 0 0 1]` form. `coords_transform[table]`
is the affine `obsm:spatial` for that table must be multiplied through to land
in the same global coordinate space the image is in — apply it to every `(x,
y)` pair before plotting cells against the image. Identity is `[1,0,0,0,1,0]`.

### 4.1 `ImageInfo` (baked per image × table)

Every field below is required and present for every combination in `images`:

| field | type | notes |
|---|---|---|
| `element` | string | the image element's name (redundant with the outer key, included for convenience) |
| `height`, `width` | integer | level-0 (finest) pixel dimensions |
| `channels` | integer | number of channels (1 for a single-band image) |
| `channel_names` | array of string | length == `channels` |
| `bounds` | `[x0, y0, x1, y1]` | axis-aligned world-space bounds of the full image |
| `pixel_to_world` | `[a,b,c,d,e,f]` | level-0-pixel → world affine, same convention as above |
| `levels` | array of `{level, width, height}` | pyramid levels, **finest first** (level 0 = `height`/`width` above) |
| `tile_size` | integer | the tile edge length (pixels) tiled reads are chunked to; `512` in this app |
| `contrast_limits` | array of `[0.0, hi]`, one per channel | the compositing range: values ≥ `hi` clip to full intensity |
| `contrast_range` | array of `[lo, hi]`, one per channel | the observed data range (for a contrast-adjustment UI's slider bounds) |
| `is_rgb` | boolean | true for a 3-channel image meant to be shown as RGB passthrough rather than per-channel additive compositing |

**Compositing convention** (needed to render `contrast_limits`/`is_rgb`
correctly): when `is_rgb` is false, the displayed color at a pixel is the
per-channel-additive sum `Σ clip(value / limit, 0, 1) * channel_color`, where
`limit` is that channel's `contrast_limits[1]` and `channel_color` is whatever
color the reader has assigned that channel (not stored here — this app's own
default channel colors come from a fixed palette cycled by channel index, and
a user-chosen override lives in `displays[].encoding.channels`, §3.3). When
`is_rgb` is true, the three channels are shown as literal RGB with no
per-channel math.

### 4.2 `viewer/tables/<table_key>/X_csc/` — gene-major mirror

Written only when the table's `X` is **sparse**; skipped for a dense `X`
(already column-sliceable by its own chunk grid, so no mirror is needed). This
duplicates the sparse matrix in gene-major (CSC) order so that fetching one
gene's expression column is two contiguous byte-range reads instead of
downloading the entire CSR `data`+`indices` arrays.

Group attrs — schema file
[`csc_table.schema.json`](../backend/app/schemas/checkpoint/csc_table.schema.json):
```jsonc
{ "shape": [n_cells, n_genes] }
```

Sibling arrays under the same group (not covered by the attrs schema above,
since they're ordinary Zarr arrays, not JSON — described here instead):

| array | dtype | shape | meaning |
|---|---|---|---|
| `data` | same as source `X.data` | `(nnz,)` | non-zero values, gene-major order |
| `indices` | same as source `X.indices` | `(nnz,)` | row (cell) index of each value in `data` |
| `indptr` | int | `(n_genes + 1,)` | CSC index pointer: gene `g`'s values are `data[indptr[g]:indptr[g+1]]` (and `indices[...]` for the matching cell indices) |

Cell order matches the table's `obs` row order; gene order matches `var`'s
index — neither is duplicated in the mirror, so a reader must already know
which row of `var` a gene name maps to before indexing `indptr`.

**To read gene `g`'s expression column:** read `indptr[g]` and `indptr[g+1]`
(two int reads, or one two-element slice), then read
`data[indptr[g]:indptr[g+1]]` and `indices[indptr[g]:indptr[g+1]]`; the result
is a sparse column — cell `indices[i]` has value `data[i]`, every other cell
is zero.

## 5. Raster sharding

Not a new structure, but a **codec requirement** a reader must support: every
array under `images/` and `labels/` is written (or rewritten, on a full save)
using the Zarr v3 [`sharding_indexed`](https://zarr-specs.readthedocs.io/en/latest/v3/codecs/sharding-indexed/index.html)
codec — inner chunks of `512×512` (one channel per inner chunk for a
multi-channel array, i.e. inner chunk shape `(1, 512, 512)`), grouped into
`4096×4096` shards (rounded down to a whole number of inner chunks on axes
smaller than that). This exists purely to keep the zip's central directory
small: an unsharded multi-gigabyte pyramid level can have tens of thousands of
chunk-file entries, which a browser must download in full (as the zip
directory) before it can request its first tile. A reader that doesn't
implement Zarr v3 sharding will see this codec in the array metadata and must
decode it accordingly — the same tile is not laid out as one chunk-per-file
under an unsharded reading.

## 6. Worker logs (`logs/`)

A compute or plot step's captured stdout/stderr is **never** part of
`app_state` on disk (see the `_log` note in §3.1/§3.2) — it is written instead
to `logs/<record_id>.log.gz` (gzip-compressed UTF-8 text), one file per
record `id` that produced output, only if there is any. A reader wanting a
step's log looks it up by the record's `id` field from `compute_history[]` or
`plots[]`; a record with no matching log file simply produced no captured
output.

## 7. Content-hash filenames

An auto-named checkpoint (one this app names itself, as opposed to an explicit
"save as") gets a 12-hex-character content hash appended to its stem:
`<stem>-<12 lowercase hex chars>.sdata.zarr.zip`. The hash is a SHA-256 over
the archive's **logical contents**, computed like this:

1. List every file in the (uncompressed) Zarr directory store, as
   `(relative_path, absolute_path)` pairs.
2. Sort by `relative_path` (plain string sort — this is what makes the hash
   deterministic across runs and machines, since a filesystem walk order is
   not guaranteed).
3. For each pair in sorted order: feed the UTF-8-encoded relative path into a
   running SHA-256, then feed the file's raw bytes into the same hash.
4. Take the first 12 hex characters of the final digest.

A re-save of the same content (even with a different mtime, since mtimes
aren't part of the hash) reproduces the same 12 characters, and a previous
hash suffix is stripped from the stem before a new one is appended (so
re-saving replaces rather than stacks the suffix). This lets a caller verify a
downloaded/copied file wasn't corrupted or truncated without needing a
separate checksum sidecar — recompute the hash the same way and compare
against the filename. A checkpoint from an explicit "save as" or a plain
import carries no such suffix and has nothing to verify against; that's
expected, not an error condition.

## 8. `index.json` — a collection of checkpoints

Not part of any single checkpoint file — a sibling manifest describing a
**directory of them**, for a static deployment (a built frontend + a folder of
`.zarr.zip` files + this manifest) or a Cirro dataset upload.

Schema file: [`backend/app/schemas/checkpoint/checkpoint_index.schema.json`](../backend/app/schemas/checkpoint/checkpoint_index.schema.json).

```jsonc
{
  "title": "My study",                 // optional
  "checkpoints": [
    { "path": "sessions/foo.sdata.zarr.zip",   // required; resolved relative to this index.json's own URL
      "label": "Foo",                          // optional; falls back to the file's basename
      "description": "…" }                     // optional
  ]
}
```
`path` can be a sibling, a subfolder path, or an absolute URL on another host
— always resolve it against the `index.json` file's own URL, never assume it's
relative to the page. This app's own writer (`backend/app/cirro.py`,
`_write_viewer_index`) only ever emits `path` and `label` — `title` and
`description` are reader-side conveniences a hand-authored manifest can add,
not something this app currently produces.

## 9. Versioning and compatibility

Two independent version numbers govern compatibility, at two different
granularities:

- **`app_state.schema_version`** (currently `3`) — the shape of `attrs["app_state"]`.
  This app **migrates forward** on load: a file with an older schema version is
  upgraded in memory to the current shape (missing collections default to
  empty); a file with a *newer* schema version than the app understands opens
  read-only with a warning rather than being rejected outright, since the
  underlying SpatialData is still perfectly readable even if some app-state
  fields are unrecognized.
- **`viewer.sidecar_version`** (currently `1`) — the shape of the `viewer/`
  group (§4). Bumped only on a breaking layout change. Unlike `schema_version`,
  a backend-less reader has no data to fall back to if the sidecar it finds is
  newer than the version it understands, so this app's own reader **refuses**
  to open a checkpoint whose `sidecar_version` exceeds what it was built
  against, rather than guessing at an unknown shape. A checkpoint with **no**
  `viewer/` group at all (written before the sidecar existed) is refused
  outright by a backend-less reader for the same reason — Zarr v3 has no child
  index, so without the sidecar's `table_keys` a reader can't even enumerate
  what tables exist.

A checkpoint that only needs to be read by *this app's own backend* (i.e.
`spatialdata.read_zarr()` plus `attrs["app_state"]` migration) never needs the
`viewer/` sidecar at all — that group exists solely to serve a browser reading
the file directly with no backend.

## 10. Reading a checkpoint from scratch

A minimal recipe for a from-scratch reader, in order of increasing
capability:

1. **Open the zip** as a random-access byte source (a local file, or an HTTP
   Range-capable client — every chunk is a contiguous byte span thanks to
   `ZIP_STORED`, §1).
2. **Read the root `zarr.json`.** Its `attributes.app_state` (§3) is enough to
   know what compute has run, what plots exist, and what displays/viewports
   were open — everything **except** actual data values.
3. **Read Zarr's consolidated metadata** (§2) to enumerate every group/array
   in the store without a directory listing.
4. To read **SpatialData content** (tables, images, shapes, points): follow
   the SpatialData/Zarr conventions in §2 — this needs no app-specific
   knowledge at all, and is what `spatialdata.read_zarr()` does.
5. To render **without a backend** (a pure client-side viewer): additionally
   read `viewer/zarr.json`'s attrs (§4) — check `sidecar_version` first (§9).
   Use `coords_transform[table]` to map that table's `obsm:spatial` into the
   same coordinate space as any image (§4, affine convention). Use
   `images[element][table_key].pixel_to_world`/`levels`/`contrast_*`/`is_rgb`
   to place and composite the image (§4.1, §5 for the sharding codec a
   pyramid level's arrays are stored under). Prefer
   `viewer/tables/<key>/X_csc` over the table's own `X` when coloring by one
   gene at a time (§4.2) — it exists precisely to make that single-column read
   cheap.
6. To reproduce **which record's log** goes with which compute/plot entry:
   match `compute_history[].id` / `plots[].id` against `logs/<id>.log.gz` (§6).

## Schema files

| File | Validates |
|---|---|
| [`backend/app/schemas/checkpoint/app_state.schema.json`](../backend/app/schemas/checkpoint/app_state.schema.json) | `attrs["app_state"]` (§3) |
| [`backend/app/schemas/checkpoint/viewer_sidecar.schema.json`](../backend/app/schemas/checkpoint/viewer_sidecar.schema.json) | the `viewer/` group's attrs (§4) |
| [`backend/app/schemas/checkpoint/csc_table.schema.json`](../backend/app/schemas/checkpoint/csc_table.schema.json) | `viewer/tables/<key>/X_csc`'s attrs (§4.2) |
| [`backend/app/schemas/checkpoint/checkpoint_index.schema.json`](../backend/app/schemas/checkpoint/checkpoint_index.schema.json) | `index.json` (§8) |

Each is standard JSON Schema (draft 2020-12) — no app-specific extensions —
and can be validated against with any language's implementation (Python
`jsonschema`, JS `ajv`, etc.), independent of this app.

## Validation guarantee

`backend/app/schemas/checkpoint/__init__.py` exposes one validation function
per schema above (`validate_app_state`, `validate_viewer_sidecar`,
`validate_csc_table_attrs`, `validate_checkpoint_index`). Every write site in
`backend/app/persistence/store.py` and `backend/app/cirro.py` calls the
matching validator on the exact dict it is about to write, **before** any
bytes reach disk — a `jsonschema.ValidationError` aborts the write rather than
letting a malformed structure land in a checkpoint. This means: a checkpoint
this app writes is *always* conformant to the schemas above; the schemas are
the authority, and this document is the human-readable transcription of them.

If the schemas and this document ever appear to disagree, the schema files are
correct — `sds-governance/checks/check_checkpoint_schema_docs.py` is meant to
catch that drift by failing whenever a schema file changes without this
document changing in the same commit, but treat that check as a safety net,
not a substitute for reading the schema file directly when precision matters.
