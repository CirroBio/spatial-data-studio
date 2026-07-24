# API Contract — Spatial Data Studio

Shared ground for backend + frontend. All command/control is REST (JSON). All
server→client updates are SSE. Bulk field data is Apache Arrow IPC (binary).
Base path for the API behind the edge server: `/api`. SSE stream: `/api/events`;
JSON polling fallback `/api/events/poll` (see below) for proxies that block SSE.

Pinned versions: squidpy 1.8.2, spatialdata 0.7.3, anndata, pyarrow.

---

## Descriptor (the unit of everything)

```jsonc
{ "namespace": "gr",            // gr | im | tl | read | pl
  "function": "spatial_neighbors",
  "params": { "coord_type": "generic", "n_neighs": 6 } }
```

`effect_class` is `compute` (gr/im/tl/read) or `plot` (pl), assigned by the registry.

## Function registry entry (`GET /api/functions`)

```jsonc
{ "key": "gr.spatial_neighbors", "namespace": "gr", "function": "spatial_neighbors",
  "effect_class": "compute",
  "summary": "Create a graph from spatial coordinates.",
  "json_schema": { /* JSON Schema draft-07 for params, no injected/pinned args */ },
  "ui_schema":  { /* per-field widget hints: {field: {widget, bound_to, tooltip}} */ },
  "partially_supported": false,
  "unsupported_params": []   // locked-to-default params (variadic / non-serializable)
}
```
`GET /api/functions` → `{ "functions": [ <entry>... ], "library_versions": { "squidpy": "1.8.2", "scanpy": "1.11.5", "spatialdata_io": "0.7.0" } }`

ui_schema widget values: `checkbox|number|text|select|multitext|obs_key|obs_categorical|var_names|layer_key|obsm_key|obsp_key|library_id`.

---

## REST endpoints

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET  | `/api/functions` | — | registry |
| GET  | `/api/functions/coverage` | — | parameter-term coverage report (unmatched params ranked by reuse) |
| GET  | `/api/sessions` | — | `{sessions:[SessionSummary]}` |
| POST | `/api/sessions` | `{name?, source:{kind:"read"|"load", ...}, load_id?}` | `SessionSummary` — returned immediately with `status:"loading"` for both kinds; the checkpoint unzip/read/re-tile (`load`) and the reader bootstrap (`read`) run on the session's worker, so the load never blocks the request past a fronting proxy's origin timeout. `load_id` is a client nonce to receive `session.loading` progress + the terminal event during a `load`; the load's `hash_check` rides that terminal event (no longer in this response body). |
| GET  | `/api/fs/datasets` | — | `{datasets:[{name, path}]}` (loadable `.zarr`/`.zarr.zip` found under the data roots + CWD; New Session picker) |
| GET  | `/api/fs/browse?path=&include_files=` | — | `{path, parent, entries:[{name, path, kind:"dir"\|"dataset"\|"file"}]}` (folder navigation for raw-data import) |
| GET  | `/api/sessions/{id}` | — | `SessionState` |
| GET  | `/api/sessions/{id}/obs/{column}/values` | — | `{column, values:[{value,count}]}` (unique values of a categorical column, for Edit Annotations) |
| GET  | `/api/sessions/{id}/var-names?q=&limit=` | — | `{names:[str]}` (server-side gene-name search, prefix matches first; keeps type-to-search responsive on datasets with tens of thousands of genes) |
| DELETE | `/api/sessions/{id}` | `{save?:bool}` | `{ok:true}` |
| POST | `/api/sessions/{id}/jobs` | `Descriptor` | `{job_id, status}` |
| DELETE | `/api/sessions/{id}/jobs/{jobId}` | — | `{ok:true}` (queued only) |
| GET  | `/api/sessions/{id}/jobs/{jobId}` | — | `{job_id, status}` (poll a job; only way to await "special" save/subset/… jobs without SSE) |
| GET  | `/api/sessions/{id}/jobs/{jobId}/log` | — | `{log:string, status}` |
| POST | `/api/sessions/{id}/jobs/stage` | `Descriptor` | `{step_id, status:"pending"}` (PENDING staging) |
| POST | `/api/sessions/{id}/pending/run-all` | — | `{queued:int}` |
| POST | `/api/sessions/{id}/pending/{stepId}/run` | — | `{ok:true}` |
| PUT  | `/api/sessions/{id}/pending/{stepId}` | `{params}` | `{ok:true}` |
| DELETE | `/api/sessions/{id}/history/{entryId}` | — | `{ok:true}` (delete a compute/plot history entry, incl. discarding a pending step; queued/running entries can't be deleted) |
| POST | `/api/sessions/{id}/plots/{plotId}/redraw` | — | `{ok:true}` |
| GET  | `/api/sessions/{id}/plots/{plotId}/figure?fmt=svg\|pdf` | — | figure bytes (image/svg+xml or application/pdf) |
| PUT  | `/api/sessions/{id}/displays/{displayId}` | `DisplaySpec` | `{ok:true}` |
| POST | `/api/sessions/{id}/displays` | `DisplaySpec` (no id) | `DisplaySpec` (with id) — lazily add a display (e.g. an `embedding_canvas` for a dataset/obsm gained after session creation) |
| POST | `/api/sessions/{id}/subset` | `{polygons:[[[x,y]...]] \| cell_indices:[int], coordinate_system, save_parent:bool, name?, invert?:bool}` | `{job_id}` (queued; the child session arrives via a `session.created` SSE event). `invert:true` keeps the cells OUTSIDE the region. `cell_indices` (in place of `polygons`) subsets by explicit table rows — the embedding view's client-resolved selection, filtered via `match_sdata_to_table` |
| POST | `/api/sessions/{id}/annotate` | `{polygons \| cell_indices:[int], region_set, category, color?}` | `{job_id}` (label the lassoed cells — spatial `polygons`, or the embedding view's `cell_indices` — into a region set) |
| GET  | `/api/sessions/{id}/shape-annotations` | — | `{shapes:[ShapeAnnotation]}` (arrows/lines/boxes/polygons/ellipses/text from `sdata.shapes["annotations"]`) |
| POST | `/api/sessions/{id}/shape-annotations` | `ShapeAnnotation` (no id) | `{job_id}` (create one shape) |
| PUT  | `/api/sessions/{id}/shape-annotations/{shapeId}` | `ShapeAnnotation` | `{job_id}` (replace one shape's geometry/style) |
| DELETE | `/api/sessions/{id}/shape-annotations/{shapeId}` | — | `{job_id}` |
| POST | `/api/sessions/{id}/save` | `{path?}` | `{job_id, path}` (queued save) |
| GET  | `/api/sessions/{id}/points-transform` | — | `{affine:[a,b,c,d,e,f], element}` (points→global affine of the active table's region element) |
| POST | `/api/sessions/{id}/points-transform` | `{affine:[a,b,c,d,e,f], path?}` | `{job_id, path}` (sets the affine and persists to disk) |
| POST | `/api/sessions/{id}/snapshot` | `{viewport:{target,zoom}, width_px, height_px, dpi, formats:["pdf"\|"png"], label?, display_id?}` | `{status,name,formats,rasterized_points}` — renders + writes `<base>.figure.{pdf,png,thumb.png,json}` in DATA_DIR |
| POST | `/api/sessions/{id}/snapshot/preview` | same as snapshot | `image/png` bytes — a low-res preview of the framing; writes nothing |
| GET  | `/api/snapshots` | — | `{snapshots:[{name,base,label,created,kind,dataset,formats,output,thumbnail_url,metadata}]}` |
| GET  | `/api/snapshots/{name}/file?fmt=pdf\|png` | — | the rendered file (`application/pdf` / `image/png`) |
| GET  | `/api/snapshots/{name}/thumbnail` | — | gallery thumbnail (`image/png`) |
| DELETE | `/api/snapshots/{name}` | — | `{status:"deleted"}` — removes every sibling artifact (404 if absent) |
| GET/HEAD | `/api/checkpoints/{name}` | — | the checkpoint `.zarr.zip` bytes for direct browser reads (HTTP Range → 206); `name` must be `*.zarr.zip` in DATA_DIR |
| GET  | `/api/about/licenses` | — | `{python:[...], npm:[...]}` (third-party licenses, in-app Acknowledgements) |
| GET  | `/api/cirro/status` | — | `{enabled:bool}` |
| GET  | `/api/cirro/projects` | — | `{projects:[...]}` (503 if Cirro is not configured) |
| GET  | `/api/cirro/projects/{id}/folders?refresh=` | — | `{folders:[str]}` (known `folder://` tag paths in the project, backend-cached; `refresh=true` forces a rescan) |
| GET  | `/api/cirro/uploads` | — | `{uploading:int, pending:int}` (upload-queue depth; also broadcast as `cirro.upload.state` over SSE) |
| POST | `/api/cirro/upload` | `{project_id, dataset_name, session_paths:[str], snapshot_names:[str], folder?}` | `{status:"started"}` (background; announces `cirro.upload.completed`/`failed` over SSE; always uses the generic "Files" ingest process; `folder` → `folder://<path>` dataset tag; each included snapshot contributes its `.figure.pdf`/`.png`/`.thumb.png`/`.json` artifacts colocated at the dataset root; needs at least one session or snapshot) |
| GET  | `/api/sessions/{id}/data/{fieldPath}` | fieldPath e.g. `obs:leiden`, `obsm:spatial`, `X:Sox17`, `obsp:spatial_distances` | Arrow IPC stream (application/vnd.apache.arrow.stream) |
| GET  | `/api/sessions/{id}/shapes/{element}/geoarrow?bbox=minx,miny,maxx,maxy[&limit=N]` | `bbox` in the `obsm:spatial` world space; optional `limit` caps the returned feature count | Arrow IPC stream (`application/vnd.apache.arrow.stream`) of viewport-clipped boundary polygons — `geometry` (GeoArrow) + `cell_index:int32`; 400 on a malformed bbox; 404 if the element is absent or non-polygonal |
| GET  | `/api/sessions/{id}/elements` | — | `{tables:[{name,n_obs,n_vars,active}], shapes, points, images, labels}` (data inspector inventory) |
| GET  | `/api/sessions/{id}/table?path=&offset=&limit=` | path = `obs`, `var`, `shapes:<name>`, `points:<name>` | `{total_rows, offset, limit, index_name, index, columns:[{name,dtype}], rows}` (JSON page) |
| GET  | `/api/sessions/{id}/image/{element}/info` | — | `{levels:[{level,width,height}], channels, channel_names, bounds, pixel_to_world, tile_size, client_compositing, raster_base_url, zarr_group_path, contrast_limits, contrast_range, is_rgb}` (see below) |
| GET  | `/api/sessions/{id}/image/{element}/thumbnail?max_px=&channels=` | — | composited WebP (`image/webp`, LRU-cached) |
| GET  | `/api/sessions/{id}/image/{element}/tile/{level}/{col}/{row}?channels=` | — | composited WebP tile (`image/webp`, LRU-cached) |
| GET/HEAD | `/api/sessions/{id}/raster/{element}/{key}` | `key` is a zarr store path (e.g. `zarr.json`, `images/{element}/zarr.json`, a chunk key `images/{element}/s0/c/0/0/0`) | raw bytes from the session's on-disk normalized raster zarr store (`application/octet-stream`, or `application/json` for `*.json`); `Accept-Ranges: bytes`, `Cache-Control: no-cache`; honors `Range` (206) and `HEAD`; 404 for a missing chunk (zarr fill value), unknown element, or gone store |
| GET  | `/api/recipes` | — | `{recipes:[{name, description, steps:[Descriptor]}]}` (curated catalog) |
| GET  | `/api/sessions/{id}/recipe` | — | recipe JSON |
| POST | `/api/sessions/{id}/recipe/preflight` | recipe JSON | `{produced:[...], unresolved:[...], unknown_functions:[...]}` |
| POST | `/api/sessions/{id}/recipe/run` | recipe JSON, `{steps, mode?:"run"\|"stage"}` | `{queued:int}`, or `{staged:int}` when `mode:"stage"` |
| GET  | `/api/healthz` / `/api/readyz` | — | `{status}` |

### Response compression
Responses whose content type is `application/vnd.apache.arrow.stream` or
`application/json` are gzip-encoded when the client sends `Accept-Encoding: gzip`
(`SelectiveGZipMiddleware`, `backend/app/transport/compression.py`) — a `Vary:
Accept-Encoding` is set and browsers decode transparently. The gene/obs columns and
rounded GeoArrow polygons compress heavily; the already-compressed WebP tiles, the
Range-served raster chunks (`application/octet-stream`), and the `text/event-stream`
SSE channel are deliberately left untouched so Range semantics and live streaming
are preserved.

### Image info & client-side (Viv) compositing
The browser composites the tissue image on the GPU (via Viv), reading the raw raster
zarr directly — there is no server-composited *canvas* tile route. `/image/{element}/info`
returns the metadata (`levels`, `channels`, `channel_names`, `bounds`, `pixel_to_world`,
`tile_size`) plus:
- `client_compositing: bool` — true when the server flag `CLIENT_IMAGE_COMPOSITING` is on
  and the element has a served on-disk normalized store. Channel count does **not** gate it:
  the frontend displays up to 6 channels at once (Viv's shader-pass limit; the channel picker
  caps it) and lets the user pick which of a >6-channel image's channels to show.
- `raster_base_url: str` — `/api/sessions/{id}/raster/{element}` (no trailing slash);
  the root a zarrita `FetchStore` opens the store at.
- `zarr_group_path: str` — `images/{element}`, the multiscale group to open inside the store.
- `contrast_limits: [[lo, hi], ...]` — per channel in `channel_names` order (`lo` is 0.0); the
  **default** window. A user's per-channel override lives in the display encoding
  (`channels.<i>.contrast_limits`) and, when set, supersedes this in the client compositor.
- `contrast_range: [[min, max], ...]` — per channel data min/max (coarsest level); the **domain**
  the client's contrast sliders span (widened client-side to include the default window).
- `is_rgb: bool` — true for a true-color RGB/H&E image (shown as-is, not tinted).

Every image gets a served store: `normalize_rasters` rebuilds into the per-session cache
store any image that isn't already tile-chunked (one channel per chunk), or that is but
isn't yet known to live under `WORK_DIR` (e.g. a bare `.zarr` directory read in place from a
mounted path); a canonical-and-local image (e.g. reopened from one of our own checkpoints)
is served straight from its own backing store instead.

The only server-side WebP route that remains is `/image/{element}/thumbnail` — a whole-image
composited preview used by the DataInspector element view, not by the canvas.

### Session source on create
- read:  `{kind:"read", namespace:"read", function:"visium", params:{path:"..."}}` — any `path`/`input`/`image_path`/`alignment_file` param must resolve under `DATA_DIR`, else 400.
- load:  `{kind:"load", path:"/data/visium_hne.zarr"}` — `path` must resolve under `DATA_DIR` (the same allowlist as `/api/fs/browse`), else 400. `POST /api/sessions/{id}/save`'s `path` must also resolve under `DATA_DIR`, else 400.

### SessionSummary
```jsonc
{ "id":"uuid", "name":"visium_hne", "status":"ready|errored|loading",
  "resident_mb": 412.0, "parent_id": null, "created_at":"ISO" }
```

### SessionState (`GET /api/sessions/{id}`)
```jsonc
{ "summary": SessionSummary,
  "app_state": { "schema_version":1, "compute_history":[HistEntry], "plots":[PlotEntry], "displays":[DisplaySpec] },
  "queue": [ {job_id, descriptor, status, position} ],
  "fields": { "obs":[{name,kind:"categorical|numeric"}], "obsm":[{name,n_components}], "var_names_count":N, "obsp":[..], "layers":[..], "images":[..], "shapes":[..] },
  "data_versions": { "obs:leiden": 3, ... } }
```

### HistEntry / PlotEntry  (mirror DESIGN §3.2)
```jsonc
HistEntry = {id, namespace, function, params, status:"pending|queued|running|completed|failed|cancelled",
             library_versions:{squidpy,scanpy,spatialdata_io}, started_at, finished_at, structural_diff:{obsp:[...],...}}
PlotEntry = {id, namespace:"pl", function, params, status:"pending|queued|running|drawn|invalidated|failed",
             references:["obs:leiden"], library_versions:{squidpy,scanpy,spatialdata_io}}
```

### DisplaySpec  (app-defined, §9) — a `spatial_canvas | embedding_canvas` union
```jsonc
{ "id":"uuid", "type":"spatial_canvas",
  "encoding": { "coords":"obsm:spatial", "color_by":"obs:leiden", "image_layer":"hne",
                "shapes_layer":null, "point_size":3, "opacity":0.8, "colormap":"viridis",
                "render_mode":"points",   // "points" (scatter alone) | "points+shapes" (scatter + boundary overlay once zoomed in); legacy "shapes" == "points+shapes"
                "boundary_style":"filled", "boundary_line_width":1,   // points+shapes overlay: "filled" (default) fills each boundary | "outline" strokes it at boundary_line_width pixels
                "invert_x":false, "invert_y":false, "background":"dark" },   // optional Spatial-only view controls: mirror the plot horizontally/vertically; per-plot backdrop "light"|"dark" (unset follows the app theme)
  "viewport": { "target":[x,y], "zoom":z } }
```
```jsonc
{ "id":"uuid", "type":"embedding_canvas",
  "encoding": { "obsm_key":"X_umap", "x_component":0, "y_component":1, "z_component":2,
                "is_3d":false, "color_by":"obs:leiden", "point_size":4, "opacity":0.85,
                "colormap":"viridis" },
  "viewport": { "target":[x,y,z?], "zoom":z, "rotationX":25, "rotationOrbit":0 } }
```
`x_component`/`y_component`/`z_component` index into the obsm array's columns (see the
`obsm:<key>` payload below); `z_component`/`rotationX`/`rotationOrbit` only apply when
`is_3d` is true.

### Snapshot metadata sidecar (`<base>.figure.json`)
Written by `POST /api/sessions/{id}/snapshot` alongside the rendered `<base>.figure.pdf`/
`.png` deliverables and `<base>.figure.thumb.png`. The gallery (`GET /api/snapshots`)
lists from these; the same JSON is embedded in every output file (PDF `/Info` `Keywords`,
PNG `sds-snapshot` `tEXt`). A snapshot is a rendered figure, not a re-openable view (see
DESIGN.md §14).
```jsonc
{ "schema_version": "3.0",             // informational only; no compatibility gate reads it
  "label": "visium_hne",
  "created": "ISO8601",
  "dataset": "visium_hne",             // source session name
  "kind": "spatial",                   // "spatial" | "embedding"
  "formats": ["pdf", "png"],           // which deliverables were written
  "output": { "width_px":800, "height_px":636, "dpi":200 },
  "viewport": { "target":[x,y], "zoom":z },
  "encoding": DisplaySpec.encoding,    // the source display's encoding verbatim (how it was styled)
  "render": { "rasterized_points":bool, "image_element":str|null, "cells_in_view":int },
  "recipe": [ { "namespace":str, "function":str, "params":{} } ] }  // completed analysis steps
```
- **Rendering it:** the request body is `{viewport:{target,zoom}, width_px, height_px,
  dpi, formats:["pdf"|"png"], label?, display_id?}`. Styling is read from the display's
  persisted `encoding`; the response is `{status, name, formats, rasterized_points}`
  where `name` is the `<base>.figure.json` handle for the file/thumbnail/delete routes.
- **Preview:** `POST /api/sessions/{id}/snapshot/preview` takes the same body and returns
  a small PNG (`image/png` bytes), writing nothing.

---

## Arrow field payloads (`/data/{fieldPath}`)
Single RecordBatch streamed as Arrow IPC.
- `obs:<col>` numeric → column `value: float64`. categorical → `code: int32` + schema metadata `categories` (JSON list) for stable, value-keyed palettes.
- `obsm:<key>` → columns `d0,d1,...,d{n-1}` float32, one per column of the array (all
  components served, not just the first 2–3 — the embedding view's axis pickers index
  into these by number).
- `X:<gene>` → column `value: float32` (dense expression for one gene).
- `var:<col>` → one column typed by dtype.
- `obsp:<key>` (sparse) → CSR triplets: columns `row:int32, col:int32, data:float64`, schema metadata `shape`=`[n,n]`. Never densified.

## Cell-segmentation geometry (segmentation display)

The point scatter and the cell-boundary fills are expressed in the same world space
`/data/obsm:spatial` serves (the region element's points→global affine applied), so the
points, the polygon outlines, and the image all overlay. Only the polygon outlines need a
dedicated geometry endpoint (backed by `backend/app/transport/geometry.py`); the point
scatter is drawn entirely client-side from the already-loaded `obsm:spatial` positions and
the per-cell colors.

- **`/shapes/{element}/geoarrow`** streams a single Arrow IPC table of the boundary
  polygons that intersect `bbox` (subset via the GeoDataFrame's spatial index):
  - `geometry` — a GeoArrow extension column, `geoarrow.polygon` or
    `geoarrow.multipolygon`, with **separated** `struct<x: float64, y: float64>`
    coordinates. The polygons are transformed from their intrinsic element coordinates
    into the `obsm:spatial` world space (the region element's affine — a boundary
    element's own transform is not used, since on Xenium it disagrees with the region's).
    Coordinates are rounded to sub-pixel precision (2 decimals) so the near-incompressible
    float64 mantissa bits collapse and the gzip transport (below) can shrink the stream.
  - `cell_index` — `int32`, the row of each polygon's cell in the **active table**
    (matched by the shape's index label against the obs index or `instance_key`), or
    `-1` if the shape maps to no table row. The frontend gathers the already-loaded
    per-cell color by this index.
  - An empty/non-intersecting bbox yields a 0-row table (still a valid GeoArrow schema);
    `limit` truncates to the first N intersecting features.

## SSE events (`/api/events`, single multiplexed stream)
Each event: `event: <type>`, `data: <json>`, every payload carries `session_id` (except `session.loading`, which is routed by the client-minted `load_id` since it narrates the load into a session whose id the client may not yet be watching). Monotonic `id:` for `Last-Event-ID` resume. An idle stream emits a `: keepalive` comment every 15 s so a load-balancer idle timeout does not drop it.

**Polling fallback** `GET /api/events/poll?after=<id>` → `{last_id, events:[{id, event, data}]}`. Returns the same events off the in-memory ring as `application/json`, for clients behind a proxy that rejects the SSE `text/event-stream` content type (e.g. a JSON-only auth gateway) or buffers the stream. Omit `after` to get a baseline cursor (`last_id`, no events); then poll with `after=last_id`. Lock-free (reads the event ring, never a session lock). The client switches to this only when the browser reports the `EventSource` fatally closed.

| event | data |
|---|---|
| `job.queued` | `{session_id, job_id, descriptor, position}` |
| `job.started` | `{session_id, job_id}` |
| `job.completed` | `{session_id, job_id, kind:"compute"|"plot", structural_diff?, data_versions, plot_id?}` |
| `job.failed` | `{session_id, job_id, error}` |
| `job.log` | `{session_id, job_id, chunk}` (a reader/compute's log streamed live as it runs — emitted only for read-bootstrap jobs today; the client appends `chunk` to the job's live-log buffer and drops it on completion) |
| `plot.drawn` | `{session_id, plot_id}` |
| `plot.invalidated` | `{session_id, plot_ids:[...]}` |
| `display.updated` | `{session_id, display_id, spec}` |
| `session.loading` | `{load_id, message, pct:float|null, log?, done?, status?, hash_check?, error?}` (checkpoint-load progress + completion; a milestone event carries `message` (+ `pct` for the byte-fraction extraction step); a live-log event carries `log` (a reader log chunk) with `message`/`pct` null; the single terminal event carries `done:true` with `status:"ready"|"errored"` and, on success, the `hash_check` (`{ok,message}` for a hash-named checkpoint, else null), else `error`) |
| `session.created` | `{session_id, summary}` |
| `session.updated` | `{session_id, summary}` (a session's summary changed after creation — chiefly `status` flipping `loading`→`ready`/`errored` once an async load/read bootstrap finishes; clients replace the list row by id) |
| `session.removed` | `{session_id, reason:"closed"|"subset"}` (closed or lasso-evicted; clients prune it from the session list) |
| `session.errored` | `{session_id, error}` |
| `resource.sample` | `{global:{rss_mb, work_dir_mb, rss_pct, cpu_pct, cpu_count, rasters_mb}, per_session:{<id>:rss_mb}}` (`rss_pct`: effective memory = RSS + RAM-backed working set, as % of the limit — the fraction the admission boundary gates on; `work_dir_mb`: WORK_DIR usage when RAM-backed, else 0; `cpu_pct`: CPU% summed across the API process and its compute-worker children, where 100% is one fully-used core; `cpu_count`: cores the container may use — the `cpu_pct` denominator; `rasters_mb`: total size of all sessions' normalized-raster caches) |
| `memory.warning` | `{session_id?, message}` |
