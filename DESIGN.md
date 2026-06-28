# Spatial Omics Analysis & Visualization Application — Design Specification

**Status:** Ready for build handoff
**Audience:** Engineering build session (backend Python + frontend React/TS)
**Core library:** `squidpy` (analysis) over `spatialdata` (data model)

---

## 1. Purpose and scope

A single-machine, server-based application for interactively analyzing and visualizing spatial omics datasets (Xenium, Visium, CosMx, MERSCOPE, and other SpatialData-readable formats). A Python backend holds data in memory and exposes an API; a React/TypeScript frontend renders data-dense graphics in WebGL and drives all interaction. Users load data from a local folder, queue analysis (`squidpy`) and plotting calls, configure live GPU-rendered displays, lasso-subset regions into child datasets, and persist everything to a SpatialData `.zarr.zip`.

### 1.1 Foundational principle: zero hardcoded library functions

No part of the application hardcodes any specific `squidpy` function. The set of available operations is discovered by runtime introspection of the `squidpy` package. Forms are generated from function signatures. Calls are stored and executed as declarative descriptors. The consequence: upgrading `squidpy` to a newer version exposes new functions and updated signatures **with no application code changes**. The only library-specific knowledge encoded anywhere is `squidpy`'s *parameter-naming conventions* (Section 4.3), applied uniformly across all functions, never per-function.

### 1.2 Non-goals

- Transcript-level rendering (hundreds of millions of points). Display targets **cell/observation scale** — low millions of points maximum.
- Authentication / access control. The deployment layer owns this; the app is fully open and collaborative.
- Distributed/multi-machine compute. Single long-lived server process.
- Persisting rendered figures. Plot outputs (SVG/PDF) are disposable; only call descriptors persist.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser (React/TS)                                                │
│  ┌────────────┐  ┌──────────────────────┐  ┌──────────────────┐  │
│  │ Left        │  │ Main area            │  │ Resource panel   │  │
│  │ sidebar     │  │  - deck.gl canvas    │  │ (live RAM/CPU)   │  │
│  │ (compute /  │  │  - or call detail    │  └──────────────────┘  │
│  │  plot lists)│  │ ┌── gear (global ops)│                        │
│  └────────────┘  └──────────────────────┘                        │
└───────────┬───────────────────────────────────┬──────────────────┘
            │ REST (commands, JSON)              │ SSE (server push)
            │ Arrow IPC (binary data fetch)      │ + binary data
            ▼                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│ Backend — single FastAPI/uvicorn process                          │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐  │
│  │ Function      │  │ Session manager                          │  │
│  │ registry      │  │  Session A: SpatialData (RAM) + queue +  │  │
│  │ (introspected │  │             worker thread + state(attrs) │  │
│  │  from squidpy)│  │  Session B: ...                          │  │
│  └──────────────┘  └──────────────────────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐  │
│  │ Resource      │  │ Arrow field resolver / data transport    │  │
│  │ monitor       │  │ (obs/obsm/var/X → Arrow IPC)             │  │
│  │ (psutil RSS)  │  └──────────────────────────────────────────┘  │
│  └──────────────┘                                                 │
└─────────────────────────────┬─────────────────────────────────────┘
                              │ read / write
                              ▼
                   Local folders + SpatialData .zarr / .zarr.zip
```

**Runtime model:** one OS process. Each session owns one in-memory `SpatialData` object, one FIFO job queue, and one worker thread. Jobs run serially **within** a session (multithreaded internally where the underlying function supports it); sessions run concurrently across threads. Data is served from the same process that holds it — no IPC hop on the data path. (See Section 11 for why shared-process beat process-per-session.)

### 2.1 Technology choices

| Layer | Choice | Rationale |
|---|---|---|
| Backend framework | FastAPI + uvicorn | Async, native SSE/WebSocket, Pydantic contracts, integrates with thread-pool workers |
| In-memory data | `spatialdata.SpatialData` | Committed data model; coordinate systems + shapes make lasso-subset clean |
| Data transport | Apache Arrow IPC (binary) | Zero-copy-ish to JS typed arrays → deck.gl binary attributes; no JSON on hot path |
| Server push | Server-Sent Events (SSE) | One-directional (queue/job/resource events); commands go over POST |
| Rendering | deck.gl + `@deck.gl-community/editable-layers` | Millions of points on GPU, binary attributes, built-in lasso/box/polygon editing, coordinate systems, `TileLayer` for image pyramids |
| Resource monitoring | `psutil` (process RSS) | Heavy allocations live in numpy/numba/C; `tracemalloc` would miss them |
| Frontend UI | React + TS + Tailwind + headless primitives (Radix or Headless UI) | Lightweight; maximizes canvas real estate; no heavy component kit chrome |
| Dynamic forms | JSON Schema → react-hook-form + custom widget map | Introspection emits JSON Schema; custom widgets for obs-key/var-name pickers |

---

## 3. Data model and persisted state

### 3.1 The object

The single source of truth is the in-memory `SpatialData` object. All compute mutates it **in place**. There is no replay engine, no intermediate checkpointing, no reactive rebuild graph — history is an audit log describing how the current object came to be, not an execution plan (Section 5).

SpatialData elements in play:
- **Tables** (AnnData): expression/intensity matrices + `obs`/`var`/`obsm`/`obsp`/`layers`. Resident in RAM eagerly.
- **Shapes** (GeoDataFrame): cell/nucleus boundaries, ROIs, lasso polygons.
- **Points**: centroids / molecule locations (may be large; treat as lazy).
- **Images / Labels**: raster, dask-backed, multiscale (pyramidal), lazy.

### 3.2 Application state lives in `sdata.attrs`

SpatialData has **no top-level `uns`** — `uns` is per-table, and a SpatialData may hold multiple tables. The canonical home for persisted application state is **`sdata.attrs`**, which serializes to the Zarr store. Bonus property: `attrs` is passed by reference through `subset()`/`query()` operations, so app state rides along through subsetting unless deliberately deep-copied (relevant to child sessions, Section 8).

State blob schema (versioned):

```jsonc
sdata.attrs["app_state"] = {
  "schema_version": 1,
  "compute_history": [
    {
      "id": "uuid",
      "namespace": "gr",                  // gr | im | tl | read
      "function": "spatial_neighbors",
      "params": { "coord_type": "generic", "n_neighs": 6 },
      "status": "completed",              // see Section 6.1
      "squidpy_version": "1.8.2",
      "started_at": "ISO-8601",
      "finished_at": "ISO-8601",
      "log": "captured stdout/stderr/logging text",
      "structural_diff": {                // keys added/changed by this call
        "obsp": ["spatial_connectivities", "spatial_distances"]
      }
    }
  ],
  "plots": [
    {
      "id": "uuid",
      "namespace": "pl",
      "function": "spatial_scatter",
      "params": { "color": "leiden", "shape": null },
      "status": "drawn",                  // see Section 7.1
      "squidpy_version": "1.8.2",
      "references": ["obs:leiden"]        // resolved field paths it depends on
      // NOTE: rendered SVG/PDF is NOT stored here
    }
  ],
  "displays": [
    {
      "id": "uuid",
      "type": "spatial_canvas",           // app-defined, not a squidpy function
      "encoding": {
        "coords": "obsm:spatial",
        "color_by": "obs:leiden",
        "image_layer": "morphology_focus",
        "point_size": 3,
        "opacity": 0.8,
        "colormap": "viridis"
      },
      "viewport": { "target": [x,y], "zoom": z }  // DEFAULT camera on load only
    }
  ]
}
```

Reload reconstructs the entire UI from this blob: data is hydrated from Zarr (compute effects already materialized as fields), displays re-derive by resolving `encoding` field paths, plots load in `invalidated`/`not-drawn` state and render lazily.

### 3.3 Field-path addressing scheme

A single string grammar addresses any servable data field, used by both displays and the Arrow resolver:

```
<element>:<key>[/<subkey>]
  obs:leiden            → adata.obs["leiden"]
  obsm:spatial          → adata.obsm["spatial"]
  var:highly_variable   → adata.var["highly_variable"]
  X:GENE_NAME           → expression column for one gene
  obsp:spatial_distances→ sparse graph matrix
  image:morphology_focus→ image element (served as tiles, not Arrow)
  shapes:cell_boundaries→ shapes element (served as GeoJSON/binary)
```

The resolver is fully generic — it never knows function names, only how to fetch a field by path.

---

## 4. Function introspection layer (the backbone)

### 4.1 Discovery

At startup (and on demand), walk `squidpy.gr`, `squidpy.im`, `squidpy.pl`, `squidpy.tl`, `squidpy.read`, and `squidpy.experimental.*`. Keep callables whose `__module__` is within `squidpy`. Build a registry keyed by `"<namespace>.<function>"` (e.g. `gr.spatial_neighbors`). The registry is the only thing that needs regenerating on a `squidpy` upgrade — and it regenerates itself.

### 4.2 Signature → form descriptor

For each function, build a descriptor from `inspect.signature` + `typing.get_type_hints`:

| Python type (introspected) | Form widget |
|---|---|
| `bool` | checkbox |
| `int` / `float` | number input (with default) |
| `Literal['F','G','L']` | dropdown (enum values are exact) |
| `str \| None` | optional text |
| `Sequence[str]` / `list[str]` | multi-value input |
| unannotated / unknown | text box (safe fallback) |

Defaults come from the signature. Docstrings (numpydoc) are parsed for **parameter descriptions → tooltips only** — never for validation or enums (too brittle). Enums come exclusively from `Literal` types.

### 4.3 Convention map (the only library-specific knowledge)

Pure reflection renders `cluster_key: str` as a bare text box, which is error-prone. A small, **function-agnostic** map keyed on `squidpy`'s consistent parameter-naming conventions upgrades these to semantic widgets bound to the active dataset:

| Param name pattern | Widget | Bound to |
|---|---|---|
| `*cluster_key*`, `*groups*` (categorical) | picker | categorical columns in `obs` |
| `genes`, `*var_names*` | multiselect | `var_names` |
| `layer*` | picker | keys in `layers` |
| `*spatial_key*` | picker | keys in `obsm` |
| `*connectivity_key*`, `*distances_key*` | picker | keys in `obsp` |
| `library_key*`, `library_id*` | picker | library ids in the object |

This encodes the library's naming conventions **once**, applied uniformly. New functions following the conventions get rich, validated forms automatically; anything unrecognized degrades to a text box. Nothing here references a specific function.

### 4.4 Compute vs. plotting split

The registry tags each function by **effect class**, derived from namespace (with a return-annotation cross-check):

- **Compute** (`gr`, `im`, `tl`, `read`): mutate the SpatialData in place. Run once per queue entry. Tracked in `compute_history`. Run-and-mutate semantics.
- **Plotting** (`pl`): read-only w.r.t. data; produce a matplotlib figure exported to SVG/PDF. Tracked in a separate flat `plots` list. Idempotent, re-runnable, lazy.

These are surfaced as two separate lists in the UI and have different lifecycles (Sections 6 and 7). The live deck.gl canvas is **neither** — it is an app-defined display (Section 9), not a `squidpy` call.

### 4.5 The descriptor is the unit of everything

A call descriptor `{namespace, function, params}` is simultaneously: a queue job, a history/plot entry, and (when serialized) a recipe step (Section 10). History is descriptors bound to a concrete dataset; a recipe is the same descriptors before binding.

### 4.6 The single call adapter

Every squidpy call — every namespace, every function — executes through **one** component, `CallAdapter`, with a single entrypoint `execute(descriptor, session) -> CallResult`. Per-function variation is absorbed entirely by the introspected descriptor; per-class variation is three small effect-handlers selected by the registry's `effect_class` tag. There are no per-function conditionals anywhere, so a squidpy upgrade changes nothing in the adapter.

Uniform pipeline:

1. **Resolve** the callable from the registry by `namespace.function`. The adapter never imports a specific function.
2. **Inject data arguments** by *type*, not name. Every parameter whose annotation is a session-held type is filled from the session and excluded from the form: `AnnData` → the active table, `SpatialData` → the object, `ImageContainer`/image → an image element. Functions may take **more than one** (e.g. `im.calculate_image_features(adata, img, ...)`); each typed slot is filled independently. When the object holds **multiple candidates of a type** (several tables or images), the form shows a selector for that slot (defaulting to the session's active table). `read` functions have no session-typed parameter, so nothing is injected (their path comes from the form).
3. **Bind and coerce:** validate `params` against the function's JSON Schema, coerce JSON→Python, resolve convention-bound references against the **current** object (validate-on-dequeue). Pin policy params via the convention map — `copy → False`, `inplace → True`, hidden from the form — so the in-place model can't be defeated.
4. **Enter execution context:** per-job log capture (logging + stdout/stderr/tqdm), snapshot key-sets for the structural diff, run under the per-worker memory ceiling.
5. **Invoke** `fn(*injected, **bound)`.
6. **Effect handling** (the only branch, keyed on `effect_class`, never on function identity):
   - **compute** → object mutated in place; compute the structural diff (after − before). *Edge A:* if the call returns non-`None` with an empty diff (a return-only function), capture the return into `uns["_results"][descriptor.id]` and surface it in the detail view. *Edge B:* if the call returns a data object (`AnnData`/`SpatialData`) — a function that always copies regardless of pinned `copy=False` — adopt it as the session object. Both are uniform fallbacks, not per-function branches.
   - **plotting** → capture the matplotlib figure (returned Axes' figure, else `plt.gcf()`), render to SVG/PDF bytes in memory, return them; no mutation, no diff, bytes not persisted. Held under a **process-global plotting lock** with the **Agg** backend, because pyplot state is process-global and sessions plot concurrently.
   - **read** → the return value *is* the new session object; adopt it as `session.sdata`.
7. **Return** a uniform `CallResult{status, log, structural_diff?, figure_bytes?, new_object?, error?}`; the worker applies it (update history/plots/`attrs`, emit SSE).

---

## 5. Execution model: in-place mutation + audit log

The deliberate, load-bearing decision: compute is **append-only and mutating**. There is no undo and no reactive recomputation.

- Compute history is an **audit log**, not a replayable plan.
- "Rerun step k" does **not** edit step k. It appends a new call (a copy of k's descriptor, editable before submit) to the tail of the queue and executes it against current state.
- Because mutation is in place with no undo, re-running a mutating step **re-applies** it (re-running `normalize_total` normalizes already-normalized data). This is inherent, not a bug. **UI wording must frame rerun as "run this operation again," never "fix the earlier step."**
- This severs replay-correctness from memory management, which is why huge datasets and slow serialization become tractable: the object is just the object; no intermediate states are retained or reconstructed.

Loading a saved project: hydrate the object from Zarr (all compute effects already materialized), restore history/plots/displays from `attrs`. Compute history is informational only — never re-executed on load.

---

## 6. Compute calls and the job queue

### 6.1 Status lifecycle (compute)

```
QUEUED → RUNNING → COMPLETED
                 ↘ FAILED      (error captured to log)
QUEUED → CANCELLED            (user cancels before run)
```

- `QUEUED` calls remain cancellable; **`RUNNING` calls cannot be force-cancelled.** Python offers no safe way to interrupt a thread mid–native-call, and the single-process model rules out killing a worker without taking down the box. Cancel therefore dequeues only not-yet-started jobs; a running job must finish or fail. A **watchdog** surfaces a "long-running" warning once a job exceeds a configurable wall-clock threshold (it cannot reclaim the job — only make the stall legible). This is an accepted limitation of in-process execution (§21, R6).
- If a session's bootstrap `read` job fails, the session has no object: it is marked `errored` and offered for retry-with-different-params or disposal, never left in a half-live state.
- `COMPLETED` calls remain in history permanently.
- `FAILED` and `CANCELLED` calls **vanish from history** (transient, not retained).
- There is no `INVALIDATED` state for compute (invalidation is a plotting concept, Section 7).

### 6.2 Queue and worker

- One FIFO queue + one worker thread **per session**. Strictly serial dequeue.
- `read` calls are ordinary queue jobs and are normally the **first** entry in a session's history (they bootstrap the object — see Section 12).
- The worker mutates the shared in-memory object directly (same process), so no serialization cost per job.
- **Validate-on-dequeue:** when a job is dequeued, its `params` are validated against the *current* object state (referenced `obs`/`var`/`obsm` keys must exist). This is what lets a recipe's step 5 reference a column that step 3 creates. Validation failure → `FAILED` with a clear log message.

### 6.3 Log capture

During a job, redirect Python `logging`, `stdout`/`stderr`, and tqdm into a per-job buffer (a scoped logging handler + `contextlib.redirect_stdout/redirect_stderr`). Logs are **not streamed live** — they attach to the history entry and become viewable when the job reaches `COMPLETED`/`FAILED`. The frontend updates **live on status transition** via SSE (queued/started/finished events), then fetches the log on demand.

### 6.4 Structural diff (drives invalidation + cache busting)

On compute completion, compare the object's key-sets before and after: which `obs`/`obsm`/`obsp`/`var`/`layers` keys and SpatialData elements were added or changed. This diff is fully introspectable (set comparison, no per-function knowledge) and is:
1. stored on the history entry,
2. broadcast over SSE so clients **refetch only the Arrow fields that changed** (not the whole object),
3. used to invalidate any plot or display whose `references` intersect the changed keys.

---

## 7. Plotting calls

Plotting is tracked **separately** from compute — a flat list with no interdependencies.

### 7.1 Status lifecycle (plotting)

```
QUEUED → RUNNING → DRAWN
                 ↘ FAILED
DRAWN → INVALIDATED   (an upstream compute call changed a referenced key)
INVALIDATED → QUEUED  (user clicks "Redraw")
```

### 7.2 Semantics

- Plots run through the **same queue** as compute (serial), but carry extra detail-view functionality.
- A plot is **drawn only when first created** (or on explicit redraw). Loading a project does **not** auto-draw plots — strictly lazy.
- Plots render against the **current** data state ("live re-derivation," not a snapshot). A redrawn plot may differ from the original if upstream data changed — this is intended; document it.
- The rendered SVG/PDF is **never persisted**. Only the call descriptor (signature + params) is saved. This is exactly what makes version drift non-destructive: if a `pl` signature changes and a stored call no longer validates, redraw goes `FAILED` and the data is untouched.
- Plot detail view shows: the rendered figure (when drawn), the generated form (editable params), status, log, and a **Redraw** button (which sets status → `QUEUED`).
- Export: user downloads the figure as **SVG or PDF** (matplotlib vector output) from the detail view.

---

## 8. Lasso subset → child session

The flagship interaction. Implemented as an app-defined operation (not a `squidpy` function), but recorded as the child's immutable base — **not** as a compute-history step.

### 8.1 Flow

1. User configures the deck.gl canvas with coordinates (`obsm:spatial`) and optionally a background image layer.
2. User draws box / lasso / circle via `@deck.gl-community/editable-layers`, producing polygon vertices in the display's coordinate system. Multiple regions allowed (union).
3. User clicks **"Subset to Selection."**
4. Frontend POSTs polygon vertices + target coordinate system to the backend.
5. Backend builds a `shapely` polygon and calls `spatialdata.polygon_query(sdata, polygon, target_coordinate_system=...)`.
6. A **new child session** is created from the query result.

### 8.2 Backend notes

- `polygon_query` selects elements that **intersect** the polygon; `bounding_box_query` selects by **center containment**. Use `polygon_query` for lasso/freeform; the box tool may use either — default to `polygon_query` for consistency.
- Performance caveat: if the object has a large `points` element, `polygon_query` can be slow. Where applicable, narrow with `subset()` before querying.
- The child's base is the **query result**, not a re-readable source. The child therefore retains this subset as its own immutable origin for its lifetime.
- Child `attrs` are **deep-copied** (not by-reference) so the child's history/displays diverge from the parent. Child `compute_history` starts **empty** (the lasso is not a recorded step).

### 8.3 Parent lifecycle on subset

- User is prompted: **"Save parent before subsetting?"** If yes, flush parent to its Zarr store.
- **Either way the parent is evicted from RAM.** The child becomes the active session.
- Subsetting must pass the load-admission check for the child (Section 11.2) before the parent is evicted, to avoid a state with neither resident.

---

## 9. Displays (live WebGL canvas)

### 9.1 Model

A single primary deck.gl canvas is the home view. Its configuration is an **app-defined display spec** (Section 3.2 `displays[]`) — configured through the **same form machinery** as `squidpy` calls, but with a signature **defined by the application**, not introspected:

| Display param | Type | Bound to |
|---|---|---|
| `coords` | field path | an `obsm` key (default `obsm:spatial`) |
| `color_by` | field path | an `obs` column or `X:gene` |
| `image_layer` | element name \| null | an image element |
| `point_size` | number | — |
| `opacity` | number (0–1) | — |
| `colormap` | enum | named colormaps |
| `shapes_layer` | element name \| null | a shapes element (cell boundaries, opt-in) |

Auto-displays: on load, generate default specs from the object's structure (e.g. one `spatial_canvas` colored by each categorical `obs` column). The earlier "gallery of saved displays" collapses into this one configurable canvas; saved-view presets are a later enhancement.

### 9.2 deck.gl layer mapping

- Cell centroids → `ScatterplotLayer` with **binary attributes** (position Float32Array from Arrow, color from a category-index Uint8/16 + palette, or continuous Float32 + colormap applied in a layer extension/shader).
- Cell boundaries → `PolygonLayer`/`GeoJsonLayer`, opt-in (heavy).
- Tissue image → `TileLayer` fed from the SpatialData multiscale image pyramid.
- Selection → editable-layers overlay.

### 9.3 Refresh

When a compute job completes, the SSE structural-diff event tells the canvas which fields changed. The canvas refetches only changed Arrow fields and rebinds GPU buffers; displays whose `references` did not change do not refetch. The client caches each fetched field keyed by `(session, field_path, data_version)`, where `data_version` is a per-field counter bumped by the structural diff — so a refetch happens only when a field's version actually advances, and switching displays never re-downloads unchanged fields. Categorical color palettes are keyed by **category value** (not ordinal index) so recompute that changes the label set keeps stable colors.

### 9.4 Camera

`viewport` in a display spec is the **default/initial** camera restored on load — **not** a shared cursor. Live pan/zoom is **per-client browser state**, never broadcast, so collaborators don't fight over the view.

### 9.5 Display data-state machine and waiting indicators

Each layer of the canvas carries an explicit visual state, so the user always knows whether what they see is current, stale, loading, or unavailable:

| State | When | Visual treatment |
|---|---|---|
| `FRESH` | bound buffers match current `data_version` | normal render |
| `LOADING` | initial fetch of a field in flight | layer dimmed + indeterminate progress overlay |
| `STALE` | a running/queued compute call touches a referenced field (from structural-diff prediction or `plot.invalidated`-style signal), refetch not yet issued | layer dimmed + "updating…" badge; **previous data still shown** (not blanked) so the view stays legible |
| `FETCHING` | refetch issued after compute completion, new buffers not yet bound | progress overlay over the dimmed prior render |
| `MISSING` | a referenced field does not (yet) exist on the object — e.g. `color_by` a column no step has produced, or a field removed by a compute call | layer shows a placeholder with the unresolved field path and a prompt to pick another field or run the producing step |

Transitions are driven by existing SSE events (`job.started`/`job.completed` + structural diff): when a compute job starts and the adapter's pre-snapshot indicates it *may* touch a referenced field, dependent layers go `STALE`; on `job.completed`, affected layers go `FETCHING` then `FRESH`. The view never silently shows data that no longer matches the object.

---

## 10. Recipes (portable analysis)

A recipe is the compute (and optionally plot) call list **before binding to a dataset**.

- **Export:** serialize the session's `compute_history` (and/or `plots`) descriptors to a standalone JSON file. Strips status/log/timestamps; keeps `{namespace, function, params}` and `squidpy_version` (informational).
- **Import / run on a new dataset:** enqueue the descriptors in order through the normal queue.
- **Binding:** params reference data-dependent keys (e.g. `color_by="leiden"`) that may not exist until an earlier step creates them. Resolution strategy: **validate-on-dequeue** (Section 6.2) — each step checks references against current state at execution time, so upstream steps can satisfy downstream references.
- **Preflight:** before running an imported recipe, run a **dry-run** that statically flags references which **nothing in the recipe will create** (e.g. a `cluster_key` no clustering step produces). These are surfaced as warnings; the user can run anyway (such steps will `FAIL` on dequeue) or edit first.

---

## 11. Sessions, process model, and memory

### 11.1 Session model

- A session = one in-memory `SpatialData` + one queue + one worker thread + its `attrs` state.
- Sessions are **shared and fully collaborative**. Multiple users may attach to one session; all see the same data, queue, history, plots, and display specs, updated in real time over SSE. (Access control is the deployment layer's concern.)
- A user may switch between sessions. Switching is a client navigation; it does not evict server-side sessions.

### 11.2 Process model — **single shared process, per-session worker threads**

Chosen over process-per-session because the audit-log decision removed the need to reconstruct intermediate states (which had been the main argument for process isolation), and because a shared process keeps the **Arrow→GPU data path direct** (data is served from the same process that holds it — no browser→gateway→worker IPC hop, which matters for the high-performance rendering goal).

- One process; one worker thread per session; FastAPI event loop stays responsive because heavy `squidpy` work releases the GIL (numpy/numba/C). A pathologically pure-Python job can transiently block — acceptable on a well-resourced single box.
- **Hard per-worker memory ceiling:** cap each worker so an overrun raises a catchable `MemoryError` (fail that one job, keep the server and other sessions alive) instead of inviting the OS OOM killer. This is the surviving piece of the process-isolation argument and is kept regardless.

### 11.3 Memory accounting and guards

Memory peak is **not predictable** (some functions allocate transient O(n²) structures, and with no per-function knowledge the peak is unknowable ahead of time). Therefore: **monitor closely, expose live, guard at boundaries.**

- **Monitor:** sample process **RSS** via `psutil` on a fixed cadence (a few Hz). Push samples over SSE to a **dedicated resource panel** in the UI. Show both **global** usage and **per-session resident cost**, so a user can tell whether *their* dataset is the pressure source.
- **Load-admission control:** before loading a dataset, estimate its **resident** cost from Zarr metadata (element shapes/dtypes; tables load eagerly and dominate, images/labels are lazy/dask and don't count as resident). If it won't fit in available RAM, **block the load.**
- **Boundary admission control (80% rule):** if usage is already ≥ 80%, **refuse to dequeue** the next job and **warn** the user. This cannot stop an in-flight job from spiking past the line — only the per-worker ceiling (11.2) bounds that.

### 11.4 Session death

- Subsetting evicts the parent (Section 8.3).
- Otherwise sessions are evicted under memory pressure or by explicit close; eviction flushes to a Zarr checkpoint first if the session has unsaved state, then drops from RAM. (Idle-eviction policy tuning is deferrable; leave the seam.)

---

## 12. Reading data / starting a session

- `read` functions (`read.visium`, `read.vizgen`, `read.nanostring`, plus SpatialData/`spatialdata-io` readers as available) are the entry point. The user selects a **local folder**; the app parses the format and builds the initial `SpatialData`.
- A `read` call is enqueued as the **first job** in the session and appears as the first entry in `compute_history`.
- Loading must pass load-admission control (Section 11.3) before the object is materialized.

---

## 13. Persistence

- **Save / export:** write the active `SpatialData` to a `.zarr.zip` (data + `attrs` state blob) — the complete, portable project. Because a zip is write-once, this is for explicit export, not incremental updates. Save is enqueued as a **special job in the session queue** (§20.5) so it captures a consistent snapshot serialized against in-flight compute.
- **Checkpoints** (graceful shutdown, optional auto-checkpoint, §19.6) use a **plain `.zarr` directory store** on the volume, not `.zarr.zip`, because directory stores support fast incremental element-level writes; only changed elements are rewritten.
- **Load:** open a `.zarr.zip` (or `.zarr`); hydrate the object and restore UI from `attrs` (Section 5). On load, `attrs["app_state"]` is run through a **schema migration** keyed on `schema_version`: older blobs are upgraded; a blob newer than the running app opens read-only with a compatibility warning rather than silently dropping fields.
- **Round-trip guarantee:** reloading a saved project reproduces the exact display configuration (display specs + default viewport), the exact compute audit log, and the exact plot list (undrawn until opened).
- Saving is potentially slow for huge datasets; surface progress and do not block the queue UI.

---

## 14. API surface

All command/control over REST (JSON). All server→client updates over SSE. Bulk data over Arrow IPC (binary).

### 14.1 REST (representative)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/functions` | Introspected registry: descriptors + JSON Schema forms, tagged compute/plot |
| `GET` | `/functions/{ns.fn}` | Single function descriptor + JSON Schema |
| `GET` | `/sessions` | List sessions + per-session resident memory |
| `POST` | `/sessions` | Start session via a `read` call (folder path + read descriptor) |
| `GET` | `/sessions/{id}` | Session state: history, plots, displays, status |
| `DELETE` | `/sessions/{id}` | Close session (flush if needed, evict) |
| `POST` | `/sessions/{id}/jobs` | Enqueue a call descriptor (compute or plot) |
| `DELETE` | `/sessions/{id}/jobs/{jobId}` | Cancel a queued job |
| `GET` | `/sessions/{id}/jobs/{jobId}/log` | Fetch captured log (after completion) |
| `POST` | `/sessions/{id}/plots/{plotId}/redraw` | Set plot → QUEUED |
| `GET` | `/sessions/{id}/plots/{plotId}/export?fmt=svg\|pdf` | Download figure |
| `PUT` | `/sessions/{id}/displays/{displayId}` | Update display spec |
| `POST` | `/sessions/{id}/subset` | Lasso subset → child session (polygon + coord system + save-parent flag) |
| `POST` | `/sessions/{id}/save` | Write `.zarr.zip` |
| `POST` | `/sessions/load` | Load a `.zarr.zip` / `.zarr` |
| `GET` | `/sessions/{id}/recipe` | Export recipe JSON |
| `POST` | `/sessions/{id}/recipe/preflight` | Dry-run a recipe; return unresolved references |
| `POST` | `/sessions/{id}/recipe/run` | Import + enqueue recipe |
| `GET` | `/sessions/{id}/data/{fieldPath}` | **Arrow IPC** stream of a field |
| `GET` | `/sessions/{id}/image/{element}/tiles/...` | Image pyramid tiles for `TileLayer` |

### 14.2 SSE event types

All events for a client arrive over a **single multiplexed SSE stream** (one `EventSource`), with each event tagged by `session_id`, rather than one connection per session — browsers cap concurrent HTTP/1.1 connections per origin (~6), and the edge server should also speak HTTP/2 to multiplex. Events carry a monotonic id so a reconnecting client resumes via `Last-Event-ID` without missing transitions.

| Event | Payload | Consumer effect |
|---|---|---|
| `job.queued` | jobId, descriptor, position | Update queue list |
| `job.started` | jobId | Mark RUNNING |
| `job.completed` | jobId, structural_diff | Refetch changed Arrow fields; invalidate dependent plots/displays |
| `job.failed` | jobId | Remove from history; offer log |
| `plot.drawn` | plotId | Enable figure in detail view |
| `plot.invalidated` | plotIds[] | Flag for redraw |
| `display.updated` | displayId, spec | Re-derive canvas |
| `session.created` | sessionId (child) | Add to session list |
| `resource.sample` | global + per-session RSS, CPU | Update resource panel |
| `memory.warning` | threshold breached | Block dequeue; warn user |

---

## 15. Frontend layout and stack

```
┌───────────────────────────────────────────────────────────────┐
│  [logo]                                              [⚙ gear ▾] │  ← global ops dropdown
├──────────────┬────────────────────────────────────────────────┤
│ Sidebar      │  Main area                                       │
│ ┌──────────┐ │   default: deck.gl spatial canvas                │
│ │ Compute  │ │     (image + points; configurable color/style)   │
│ │  list    │ │   selected compute item: form + status + log     │
│ ├──────────┤ │   selected plot item: figure + form + redraw     │
│ │ Plot     │ │                                                  │
│ │  list    │ │                                                  │
│ └──────────┘ │                                                  │
├──────────────┴────────────────────────────────────────────────┤
│  Resource panel: ▓▓▓▓░░ RAM 62% (this session 1.8 GB) · CPU …   │  ← live SSE
└───────────────────────────────────────────────────────────────┘
```

- **Left sidebar** toggles between the **compute call list** and the **plot call list**. Selecting an item drives the main area; deselecting returns to the canvas (home view).
- **Main area:** single deck.gl canvas by default, with app-defined controls for color/style/image. A selected compute item shows its form, params, status, and log. A selected plot item shows the rendered figure, its form, status, log, and **Redraw**.
- **Gear (top-right) dropdown** holds all advanced/global operations: switch session, new session (load folder), open `.zarr.zip`, save `.zarr.zip`, export/import/run recipe, subset-to-selection mode toggle.
- **Resource panel:** dedicated, always-visible strip fed by `resource.sample` SSE.
- **Activity indicators (always visible):** a global compute badge shows `N running · M queued` for the active session and pulses while any job runs, so the user always knows the dataset is being mutated and displays may change. Each sidebar item renders its status explicitly — `QUEUED` (pending badge), `RUNNING` (animated spinner + elapsed time), `COMPLETED`/`DRAWN`, `FAILED` (error glyph + link to log), `INVALIDATED` (stale badge + Redraw). A job whose elapsed time crosses a configurable threshold shows a "long-running" warning (see §20.6). Canvas layers carry their own data-state (§9.5); the global badge and the per-layer state together make "compute is happening" and "this view is waiting on data" unambiguous and distinct.
- **Forms:** introspection layer emits **JSON Schema**; render with react-hook-form + a custom widget map providing the obs-key picker, var-name multiselect, layer/obsm pickers (driven by the convention map of Section 4.3) and `Literal` dropdowns. (RJSF is an acceptable batteries-included fallback but is more opinionated than the custom widgets warrant.)
- **Stack:** React + TS, Tailwind for layout, Radix or Headless UI for dropdown/dialog/tabs primitives. Keep chrome minimal to maximize canvas room.

---

## 16. Cross-cutting invariants (enforce in code)

1. No module imports or names any specific `squidpy` function. The registry is the only path to a function.
2. Redraw exists only on plotting items; a compute item can never transition COMPLETED→QUEUED.
3. Rendered figures are never written to `attrs` or Zarr.
4. App state is written only to `sdata.attrs["app_state"]`, never to a table `uns`.
5. Display `viewport` is default-camera only; live camera is client-local and never broadcast.
6. Every job validates its references at dequeue time, not at enqueue time.
7. A child session's `attrs` are deep-copied; its compute history starts empty.
8. The per-worker memory ceiling and the 80% boundary-admission check are both always active.
9. uvicorn runs exactly one worker; sessions are never spread across worker processes.
10. The per-worker memory ceiling is set below the container memory limit, so the app's catchable `MemoryError` fires before the cgroup OOM killer.

---

## 17. Known risks / pin early

- **SpatialData incremental Zarr write API** has moved across versions. Pin the exact element-level write calls used for save/checkpoint at the start of the build; do not assume a stable surface.
- **`get_type_hints` on `squidpy`** may raise on forward refs / optional deps in some modules — wrap per-function and fall back to raw `signature` annotations.
- **deck.gl continuous colormaps** typically need a layer extension or shader for per-point colormap application; budget for this rather than assuming a built-in prop.
- **Arrow JS + sparse `obsp`** — design a serialization for sparse matrices (CSR triplets in Arrow) rather than densifying graphs for transport.
- **GIL blocking** from a rare pure-Python `squidpy` path can stall SSE; if observed, move only that worker to a process — keep the data resolver in-process.

---

## 18. Suggested build sequence

1. **Skeleton:** FastAPI app, session manager (one shared process, per-session worker thread), `psutil` resource SSE + frontend resource panel.
2. **Introspection layer:** registry discovery, signature→JSON-Schema, convention map, compute/plot tagging. `GET /functions`.
3. **Read + queue:** start session from a local folder via a `read` job; serial worker; status SSE; log capture; compute history in `attrs`.
4. **Arrow data path:** field-path resolver → Arrow IPC; image tile endpoint.
5. **deck.gl canvas:** binary scatter from Arrow, app-defined display spec + form, image `TileLayer`, structural-diff refresh.
6. **Plotting:** `pl` jobs, detail view, SVG/PDF export, invalidation + redraw.
7. **Lasso subset → child session:** editable-layers, `polygon_query`, save-parent prompt, eviction, child bootstrap.
8. **Persistence:** save/load `.zarr.zip`, full UI restore from `attrs`, round-trip test.
9. **Recipes:** export/import JSON, preflight dry-run, validate-on-dequeue run.
10. **Memory guards:** load-admission, 80% boundary block, per-worker ceiling → catchable `MemoryError`.
11. **Collaboration hardening:** multi-subscriber SSE fan-out, per-client camera isolation, session switching.
12. **Containerization & resilience:** single-image build, supervisor, health checks, graceful shutdown, crash recovery from the checkpoint volume.

---

## 19. Deployment and process orchestration

Everything ships as **one Docker image** run on a single machine. The single-process, in-RAM session model (Section 11.2) is what makes process failure costly — a hard crash loses every in-memory session at once — so resilience is a first-class concern here, not an afterthought.

### 19.1 Single-image composition

Multi-stage build:
- **Stage 1 (node):** build the React/TS SPA to static assets.
- **Stage 2 (python):** Python runtime + `squidpy`/`spatialdata` + backend code; copy in the built static assets.

Runtime processes **inside** the container:

```
PID 1: tini                      # signal forwarding + zombie reaping
  └─ supervisor (s6-overlay)     # restarts children, ordered start/stop
       ├─ edge (Caddy or nginx)  # serves static SPA; reverse-proxies /api,/events → uvicorn
       └─ uvicorn (--workers 1)  # FastAPI backend; per-session worker threads inside
```

- **`tini` as PID 1** so signals propagate and defunct children are reaped.
- **Supervisor:** `s6-overlay` (recommended) or `supervisord`. Owns child lifecycle and restart-on-exit with backoff.
- **Edge server (Caddy or nginx):** serves the static SPA, reverse-proxies `/api/*` and `/events` to uvicorn. **SSE requires response buffering disabled** (`proxy_buffering off` in nginx / `flush_interval -1` in Caddy) or events stall. The edge also gives gzip, HTTP range requests for image tiles, and efficient large binary Arrow responses.

Why an edge server rather than serving static from uvicorn: it **stays up while uvicorn restarts**, so the SPA shell remains reachable and the frontend can render a "reconnecting" state instead of a dead page.

### 19.2 Single worker is mandatory (and is the single point of failure)

uvicorn runs **exactly one worker process** (`--workers 1`). Sessions live in that process's RAM and are shared across users; multiple uvicorn workers would each hold separate, inconsistent session state. Concurrency comes from the async event loop plus per-session worker threads — **not** process replication. The corollary: this one process is a single point of failure, which the rest of this section addresses.

### 19.3 Failure taxonomy

- **Job-level (common):** bad params, Python exceptions, `MemoryError` from the per-worker ceiling. **Contained** — caught, job → `FAILED`, log captured, process and other sessions unaffected (Sections 6.1, 11.2).
- **Process-level (rare):** native segfault in a C/numba extension, cgroup OOM kill, unhandled fatal error. **Kills uvicorn and all in-memory sessions.** This is the shared-process model's exposure and the focus of orchestration.

### 19.4 Restart and reconnection

- Supervisor **auto-restarts uvicorn** on unexpected exit (with backoff). The registry rebuilds on boot (cheap). The edge server stays up throughout.
- Frontend: `EventSource` SSE **auto-reconnects** natively. On connection loss the UI enters a "backend reconnecting" state, then re-syncs the session list and state from REST on reconnect.
- **Outer ring:** if the supervisor or PID 1 itself dies, the deployment system restarts the container.

### 19.5 Memory ceiling vs. container limit

Set the per-worker memory ceiling (Section 11.2) **strictly below the container cgroup memory limit**, so the app raises a catchable `MemoryError` and fails a single job **before** the kernel OOM killer fires and takes down uvicorn (losing all sessions). Load-admission and the 80% boundary check (Section 11.3) evaluate against the **container limit**, not host RAM.

### 19.6 Crash recovery — best-effort, explicit tradeoff

You cannot have both "no expensive serialization" and "full crash durability"; the huge-dataset / slow-serialize constraint forces a choice. The default favors speed; durability is an opt-in knob.

- **Default:** a hard crash recovers only **explicitly-saved** projects. Graceful shutdown checkpoints sessions (19.7), so planned restarts/deploys lose nothing — only unplanned hard crashes lose unsaved state.
- **Opt-in auto-checkpoint:** for durability-prioritizing deployments, checkpoint after each completed compute job or on an interval. Pays serialization cost; recovers to the **last checkpoint**, never the exact crash instant.
- **Checkpoints/saves MUST live on a mounted volume.** Container-local files do not survive a container restart; only mounted volumes persist across container-level restarts.
- On boot, scan the checkpoint volume and present recoverable sessions tagged `recovered (from <time>)`.

### 19.7 Graceful shutdown

FastAPI shutdown handler on `SIGTERM`: stop dequeuing new jobs, finish or abandon the in-flight job per policy, flush each session to its checkpoint volume, close SSE streams cleanly. The supervisor/orchestrator **stop-timeout must be generous** — large datasets flush slowly, and a too-short timeout converts a graceful stop into a data-losing kill.

### 19.8 Health checks

- **Liveness** `GET /healthz`: cheap, confirms the event loop is responsive. **Readiness** `GET /readyz`: registry built, ready to serve.
- **Gotcha:** a rare GIL-blocking pure-Python job could delay `/healthz` and trigger a **false restart that kills healthy sessions**. Mitigation: generous liveness timeout and tolerate several consecutive misses before restarting; in practice heavy `squidpy` work releases the GIL. Do **not** configure aggressive single-miss liveness kills.

### 19.9 Deployment contract (volumes & config)

- **Read mount:** input data folders (may be read-only).
- **Read-write mount:** checkpoint/save volume — must persist across container restarts.
- **Config (env):** container memory limit (set to box RAM minus a reserve for OS + edge + supervisor), per-worker ceiling, **max concurrent sessions per box**, checkpoint policy (`off` / `interval` / `per-step`), liveness timeout/miss-tolerance, edge SSE buffering.

### 19.10 Accepted residual risk (single box)

With **one container per box**, there is no horizontal isolation to fall back on: a native segfault in any job takes down all co-resident sessions on that box until uvicorn restarts. This is an **accepted risk**. The surviving mitigations are all in-box — fast supervised restart (19.4) and recovery checkpointing (19.6). Because there is no redundant instance to absorb a loss, **the checkpoint policy is the primary durability lever**: a box that routinely hosts several concurrent sessions should lean toward auto-checkpointing rather than save-only, while a box holding one or two sessions can stay save-only.

Bound blast radius and memory contention with the **max-concurrent-sessions cap** (19.9): once reached, new session creation is refused — the same posture as load-admission — since there is no other box to route the overflow to.

---

## 20. Concurrency and threading model

The goal is to use threads as fully as correctness allows. The hard constraint is the in-place mutation model: an object being mutated by a compute job cannot be safely read or mutated concurrently. Everything below maximizes parallelism *around* that constraint rather than violating it.

### 20.1 Cross-session parallelism (full)

Sessions own independent objects, so their worker threads run **truly in parallel** for the GIL-releasing numerical work that dominates `squidpy` (numpy/numba/BLAS/Cython). This is the primary axis of parallelism and it is unrestricted except by the global thread budget (20.3).

### 20.2 Per-session read/write lock

Each session has one read/write lock guarding its object:
- **Writer (exclusive):** the worker while executing a **compute** call (mutates in place).
- **Readers (shared, concurrent):** Arrow field serving, image-tile serving, and **plotting** calls. Many reads proceed at once.

Compute and plotting are already serialized within a session because they share the one FIFO queue, so the lock's real job is to keep async data/tile endpoints from reading a half-mutated object. To avoid the UI ever *blocking* on the writer, the client does not issue refetches mid-compute: it holds prior buffers in `STALE` (§9.5) and refetches only on `job.completed`. A read that *is* issued during a write (e.g. the user opens a new field) waits on the lock and shows `LOADING` until it resolves — bounded, and made legible by the data-state machine.

### 20.3 Within-job parallelism + global thread budget

`squidpy`/`scanpy` functions expose parallelism via `n_jobs`, plus numba and BLAS/OpenMP thread pools. The convention map (4.3) surfaces `n_jobs` as a first-class form field with a sensible default. To prevent **oversubscription** (every concurrent session spawning `n_cores` threads and thrashing), a process-wide **thread budget** governs the total: a global semaphore caps concurrently *running* compute jobs, and each running job's effective `n_jobs` plus the pinned BLAS/OMP/numba thread counts are allocated from the budget (e.g. cores ÷ active compute jobs, floored at 1). Thread-count env (`OMP_NUM_THREADS`, `OPENBLAS_NUM_THREADS`, `NUMBA_NUM_THREADS`) is set per job rather than globally so the split is dynamic.

### 20.4 Non-blocking event loop

The single uvicorn worker's async loop must never block on CPU or IO. Arrow serialization, sparse-matrix encoding, zarr reads/writes, image-tile generation, and matplotlib rendering all run in a thread-pool executor (`run_in_executor`), not inline in the request coroutine. SSE fan-out and the resource sampler are lightweight async tasks.

### 20.5 Save and subset as queued operations

Operations that need a consistent view of the object — explicit save/export (§13) and lasso-subset (§8) — are enqueued as **special jobs** in the session's FIFO queue rather than run off async endpoints. This serializes them against compute (no save of a half-mutated object, no subset racing a mutation) using the existing queue rather than new locking, and they take the read lock (they don't mutate the parent).

### 20.6 Honest limits

- **The GIL** still serializes any pure-Python hot loop; parallelism is real only where the underlying code releases it (true for the heavy `squidpy` paths, not guaranteed for all).
- **Running jobs are not interruptible** (§6.1): no safe thread kill, and no process isolation to kill into. The watchdog warns; it cannot reclaim.
- **Within-session compute is serial by design.** This is a correctness choice, not a missed optimization — concurrent mutation of one object is unsafe and is not attempted.

---

## 21. Critique log (edge cases, limitations, dispositions)

A structured adversarial pass over the design, run in rounds until the only remaining items are conscious accepted tradeoffs (forced by the constraints set: one box, single process, in-place mutation, no per-job isolation, huge datasets) rather than fixable defects. Each item is tagged **Resolved** (designed away, with location), **Accepted** (irreducible given a stated constraint), or **Deferred** (out of scope for v1).

### Round 1 — data model & introspection
- **Non-serializable params** (callables, arrays, metric functions some `squidpy` fns accept). JSON-Schema forms only emit JSON-serializable values; a param whose type can't be coerced is flagged at registry build, the function marked *partially supported*, and that param locked to its default (or the function hidden if the default is invalid). **Resolved** (4.2/4.3, registry capability flag).
- **Multiple tables / elements** — `cluster_key`/`var_names` pickers and data injection are ambiguous when the object holds several tables or images. Injection fills every session-typed slot and shows a selector when multiple candidates exist; pickers resolve against the chosen/active table. **Resolved** (4.6 step 2).
- **Multiple data arguments** (e.g. `calculate_image_features(adata, img)`). Type-based injection fills each slot independently. **Resolved** (4.6 step 2).
- **Variadic signatures** (`*args`/`**kwargs`) can't be form-generated. Variadic params unsupported, function marked partially supported. **Accepted** (rare in `squidpy`).
- **Functions that always return a copy** despite pinned `copy=False`. Compute handler adopts a returned data object as the session object. **Resolved** (4.6 step 6, Edge B).

### Round 2 — execution & memory
- **Cancelling a RUNNING job** is impossible to do safely. Cancel limited to `QUEUED`; watchdog warns on long runs. **Accepted** (6.1, 20.6).
- **A hung/infinite job** blocks its session's queue forever. Watchdog surfaces it; cannot reclaim without process isolation. **Accepted**; the per-session queue means it stalls only that session, not the box.
- **Failed bootstrap read** → empty session. Marked `errored`, offered retry/disposal. **Resolved** (6.1).
- **RSS overcounts** because freed memory isn't always returned to the OS, risking false 80% blocks. Run `gc.collect()` + `malloc_trim` after large jobs; treat RSS as deliberately conservative. **Accepted** (conservative bias is the safe direction).
- **Collaborative stale assumptions** — user A's queued job assumed state that user B's earlier-dequeued job changed. Validate-on-dequeue catches it; A's job fails with a clear reason. **Resolved** (6.2) / **Accepted** (inherent to a shared FIFO queue).

### Round 3 — concurrency
- **Read/write races** between async data serving and an in-place compute mutation. Per-session read/write lock. **Resolved** (20.2).
- **Reader starvation / UI blocking** under a long writer. Client defers refetch to completion and shows `STALE`; only explicit mid-compute reads wait, shown as `LOADING`. **Resolved** (9.5, 20.2).
- **Thread oversubscription** across concurrent sessions. Global thread budget + per-job dynamic thread-count env. **Resolved** (20.3).
- **matplotlib pyplot global state** across concurrent plot jobs. Process-global plotting lock + Agg backend. **Resolved** (4.6 step 6).
- **Save racing a mutation.** Save enqueued as a queue job. **Resolved** (20.5).

### Round 4 — transport, displays, persistence
- **SSE connection-cap exhaustion** with multiple sessions/tabs. Single multiplexed stream + HTTP/2. **Resolved** (14.2).
- **Re-downloading large fields** on every view change. Client cache keyed by `(session, field, data_version)`. **Resolved** (9.3).
- **Display references a removed/renamed field.** `MISSING` layer state with a clear prompt. **Resolved** (9.5).
- **Palette instability** when recompute changes a category set. Palette keyed by category value. **Resolved** (9.3).
- **`.zarr.zip` is write-once / slow** for huge data. Incremental `.zarr` directory store for checkpoints; `.zarr.zip` only for explicit export. **Resolved** (13).
- **App-state schema drift** across app versions. Versioned migration on load; newer-than-app opens read-only. **Resolved** (13).
- **Continuous colormap over millions of points** must be GPU-side. Shader/layer-extension colormap. **Resolved** (9.2, noted in 17).
- **Sparse `obsp` transport** must not densify. Encode as CSR triplets in Arrow. **Resolved** (17).

### Round 5 — lasso subset
- **Polygon coordinate-system mismatch.** Polygon vertices are taken in the display's declared SpatialData coordinate system (deck.gl world coords, not pixels) and passed as `target_coordinate_system` to `polygon_query`. **Resolved** (8.1/8.2).
- **Empty selection** → zero-observation child. Refused with a warning; no empty child created. **Resolved** (8).
- **Multiple disjoint regions.** Union as a shapely `MultiPolygon`; if a `spatialdata` version rejects it, fall back to per-polygon query + concatenation. **Resolved** (8.1).
- **Subset of a huge `points` element is slow** (`polygon_query` caveat). Narrow with `subset()` first. **Resolved** (8.2).

### Round 6 — residual accepted risks (irreducible under stated constraints)
- **Native-crash blast radius:** a segfault in one job takes down all co-resident sessions until restart. **Accepted** (19.10; constraint: one box, single process). Mitigated by fast restart + checkpoint policy, not eliminated.
- **Running-job non-interruptibility.** **Accepted** (constraint: no per-job process isolation, chosen to keep the direct Arrow path).
- **Compute memory-peak unpredictability:** can't be known pre-run with no per-function knowledge. **Accepted** (boundary admission + ceiling + live monitor are the guards).
- **Single-process SPOF.** **Accepted** (required for shared in-RAM sessions + direct data path).
- **Registry reflects installed `squidpy` at boot;** upgrading requires a restart (no hot reload). **Accepted** (rebuild is cheap; aligns with the immutable-image deploy).
- **Reconstructing pre-save intermediate states is impossible** (audit-log model keeps no intermediates). **Accepted** (the deliberate decision in §5; "rerun" means run-again, never edit-in-place).

### Termination

Further rounds produce only (a) restatements of the Round-6 accepted tradeoffs, or (b) increasingly exotic failure modes (e.g. silent disk corruption, BLAS miscompilation) that lie below the application design layer and belong to the platform/ops domain. No remaining item is a fixable design defect. The critique loop is therefore closed: the open set is exactly the documented accepted tradeoffs, each tied to a constraint the design was explicitly given.