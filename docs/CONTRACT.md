# API Contract — Spatial Data Studio

Shared ground for backend + frontend. All command/control is REST (JSON). All
server→client updates are SSE. Bulk field data is Apache Arrow IPC (binary).
Base path for the API behind the edge server: `/api`. SSE stream: `/api/events`.

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
`GET /api/functions` → `{ "functions": [ <entry>... ], "squidpy_version": "1.8.2" }`

ui_schema widget values: `checkbox|number|text|select|multitext|obs_key|obs_categorical|var_names|layer_key|obsm_key|obsp_key|library_id`.

---

## REST endpoints

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET  | `/api/functions` | — | registry |
| GET  | `/api/functions/coverage` | — | parameter-term coverage report (unmatched params ranked by reuse) |
| GET  | `/api/sessions` | — | `{sessions:[SessionSummary]}` |
| POST | `/api/sessions` | `{name?, source:{kind:"read"|"load", ...}}` | `SessionSummary` |
| GET  | `/api/fs/datasets` | — | `{datasets:[{name, path}]}` (loadable `.zarr`/`.zarr.zip` found under the data roots + CWD; New Session picker) |
| GET  | `/api/fs/browse?path=&include_files=` | — | `{path, parent, entries:[{name, path, kind:"dir"\|"dataset"\|"file"}]}` (folder navigation for raw-data import) |
| GET  | `/api/sessions/{id}` | — | `SessionState` |
| GET  | `/api/sessions/{id}/obs/{column}/values` | — | `{column, values:[{value,count}]}` (unique values of a categorical column, for Edit Annotations) |
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
| POST | `/api/sessions/{id}/subset` | `{polygons:[[[x,y]...]], coordinate_system, save_parent:bool, name?}` | `{job_id}` (queued; the child session arrives via a `session.created` SSE event) |
| POST | `/api/sessions/{id}/annotate` | `{polygons, region_set, category, color?}` | `{job_id}` (label lassoed cells into a region set) |
| POST | `/api/sessions/{id}/regions/promote` | `{obs_column}` | `{job_id}` (promote an existing obs categorical to a region set) |
| POST | `/api/sessions/{id}/save` | `{path?}` | `{job_id, path}` (queued save) |
| GET  | `/api/sessions/{id}/points-transform` | — | `{affine:[a,b,c,d,e,f], element}` (points→global affine of the active table's region element) |
| POST | `/api/sessions/{id}/points-transform` | `{affine:[a,b,c,d,e,f], path?}` | `{job_id, path}` (sets the affine and persists to disk) |
| POST | `/api/sessions/{id}/snapshot` | `{label?}` | self-contained read-only snapshot result |
| GET  | `/api/snapshots` | — | `{snapshots:[...]}` |
| GET  | `/api/about/licenses` | — | `{python:[...], npm:[...]}` (third-party licenses, in-app Acknowledgements) |
| GET  | `/api/cirro/status` | — | `{enabled:bool}` |
| GET  | `/api/cirro/projects` | — | `{projects:[...]}` (503 if Cirro is not configured) |
| GET  | `/api/cirro/processes` | — | `{processes:[...]}` (503 if Cirro is not configured) |
| POST | `/api/sessions/{id}/cirro/upload` | `{project_id, process_id, dataset_name, snapshot_names:[str]}` | `{job_id}` (session must be saved first) |
| GET  | `/api/sessions/{id}/data/{fieldPath}` | fieldPath e.g. `obs:leiden`, `obsm:spatial`, `X:Sox17`, `obsp:spatial_distances` | Arrow IPC stream (application/vnd.apache.arrow.stream) |
| GET  | `/api/sessions/{id}/elements` | — | `{tables:[{name,n_obs,n_vars,active}], shapes, points, images, labels}` (data inspector inventory) |
| GET  | `/api/sessions/{id}/table?path=&offset=&limit=` | path = `obs`, `var`, `shapes:<name>`, `points:<name>` | `{total_rows, offset, limit, index_name, index, columns:[{name,dtype}], rows}` (JSON page) |
| GET  | `/api/sessions/{id}/image/{element}/info` | — | `{levels:[{level,width,height}], channels, dtype, pixel_to_world}` |
| GET  | `/api/sessions/{id}/image/{element}/thumbnail?max_px=&channels=` | — | composited PNG (LRU-cached) |
| GET  | `/api/sessions/{id}/image/{element}/tile/{level}/{col}/{row}?channels=` | — | composited PNG tile (LRU-cached) |
| GET  | `/api/recipes` | — | `{recipes:[{name, description, steps:[Descriptor]}]}` (curated catalog) |
| GET  | `/api/sessions/{id}/recipe` | — | recipe JSON |
| POST | `/api/sessions/{id}/recipe/preflight` | recipe JSON | `{produced:[...], unresolved:[...], unknown_functions:[...]}` |
| POST | `/api/sessions/{id}/recipe/run` | recipe JSON, `{steps, mode?:"run"\|"stage"}` | `{queued:int}`, or `{staged:int}` when `mode:"stage"` |
| GET  | `/api/healthz` / `/api/readyz` | — | `{status}` |
| GET  | `/api/ai/status` | — | `{enabled, provider, model}` (dark unless `AI_ENABLED`) |
| POST | `/api/sessions/{id}/chat` | `{message}` | `{status:"started"}` (503 if AI is not configured) |
| POST | `/api/sessions/{id}/chat/approve` | `{call_id, action:"approve"\|"edit"\|"deny", params?, reason?}` | `{ok:true}` |
| PUT  | `/api/sessions/{id}/chat/auto-mode` | `{auto:bool}` | `{ok:true}` |
| GET  | `/api/sessions/{id}/chat` | — | `{transcript, auto_mode, context}` |

### Session source on create
- read:  `{kind:"read", namespace:"read", function:"visium", params:{path:"..."}}` — any `path`/`input`/`image_path`/`alignment_file` param must resolve under `DATA_DIR`/`CHECKPOINT_DIR`/CWD, else 400.
- load:  `{kind:"load", path:"/data/visium_hne.zarr"}` — `path` must resolve under `DATA_DIR`/`CHECKPOINT_DIR`/CWD (the same allowlist as `/api/fs/browse`), else 400. `POST /api/sessions/{id}/save`'s `path` must resolve under `CHECKPOINT_DIR`, else 400.

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
  "fields": { "obs":[{name,kind:"categorical|numeric"}], "obsm":[..], "var_names_count":N, "obsp":[..], "layers":[..], "images":[..], "shapes":[..] },
  "data_versions": { "obs:leiden": 3, ... } }
```

### HistEntry / PlotEntry  (mirror DESIGN §3.2)
```jsonc
HistEntry = {id, namespace, function, params, status:"pending|queued|running|completed|failed|cancelled",
             squidpy_version, started_at, finished_at, structural_diff:{obsp:[...],...}}
PlotEntry = {id, namespace:"pl", function, params, status:"pending|queued|running|drawn|invalidated|failed",
             references:["obs:leiden"], squidpy_version}
```

### DisplaySpec  (app-defined, §9)
```jsonc
{ "id":"uuid", "type":"spatial_canvas",
  "encoding": { "coords":"obsm:spatial", "color_by":"obs:leiden", "image_layer":"hne",
                "shapes_layer":null, "point_size":3, "opacity":0.8, "colormap":"viridis" },
  "viewport": { "target":[x,y], "zoom":z } }
```

---

## Arrow field payloads (`/data/{fieldPath}`)
Single RecordBatch streamed as Arrow IPC.
- `obs:<col>` numeric → column `value: float64`. categorical → `code: int32` + schema metadata `categories` (JSON list) for stable, value-keyed palettes.
- `obsm:<key>` → columns `d0,d1[,d2...]` float32 (only first 2–3 dims served for coords).
- `X:<gene>` → column `value: float32` (dense expression for one gene).
- `var:<col>` → one column typed by dtype.
- `obsp:<key>` (sparse) → CSR triplets: columns `row:int32, col:int32, data:float64`, schema metadata `shape`=`[n,n]`. Never densified.

## SSE events (`/api/events`, single multiplexed stream)
Each event: `event: <type>`, `data: <json>`, every payload carries `session_id`. Monotonic `id:` for `Last-Event-ID` resume.

| event | data |
|---|---|
| `job.queued` | `{session_id, job_id, descriptor, position}` |
| `job.started` | `{session_id, job_id}` |
| `job.completed` | `{session_id, job_id, kind:"compute"|"plot", structural_diff?, data_versions, plot_id?}` |
| `job.failed` | `{session_id, job_id, error}` |
| `plot.drawn` | `{session_id, plot_id}` |
| `plot.invalidated` | `{session_id, plot_ids:[...]}` |
| `display.updated` | `{session_id, display_id, spec}` |
| `session.created` | `{session_id, summary}` |
| `session.errored` | `{session_id, error}` |
| `resource.sample` | `{global:{rss_mb, rss_pct, cpu_pct}, per_session:{<id>:rss_mb}}` |
| `memory.warning` | `{session_id?, message}` |
