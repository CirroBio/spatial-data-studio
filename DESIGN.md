# Spatial Data Studio — Design Specification

**Status:** Living design document — reflects the built application
**Audience:** Engineers working on the backend (Python) or frontend (React/TS)
**Core libraries:** `squidpy` + `scanpy` (analysis) over `spatialdata` (data model)

This is the single design-of-record. It began as the pre-build specification and
now incorporates everything added since: the Parameter Term Dictionary, region
annotation and comparison, recipes with staged (PENDING) execution, the expanded
scanpy / spatialdata-io catalog, snapshots, Cirro
upload, and the governance layer. `README.md` remains the source of truth for how to
run the app and the exact current feature set; `docs/CONTRACT.md` is the API contract.
Where a subsystem was built differently from the original plan, this document
describes what exists, not the plan.

---

## 1. Purpose and scope

A single-machine, server-based application for interactively analyzing and
visualizing spatial omics datasets (Xenium, Visium, Visium HD, CosMx, MERSCOPE, and
other SpatialData-readable formats). A Python backend holds data in memory and
exposes an API; a React/TypeScript frontend renders data-dense graphics in WebGL and
drives all interaction. Users load data from a local folder, queue analysis
(`squidpy`/`scanpy`) and plotting calls, configure a live GPU-rendered display, draw
regions to label or subset cells, and persist everything to a SpatialData
`.zarr`/`.zarr.zip`.

### 1.1 Foundational principle: zero hardcoded library functions

No part of the application hardcodes any specific `squidpy` (or `scanpy`) function.
The set of available operations is discovered by runtime introspection; forms are
generated from function signatures; calls are stored and executed as declarative
descriptors. The consequence: upgrading `squidpy`/`scanpy` exposes new functions and
updated signatures **with no application code changes**.

The only library-specific knowledge encoded anywhere is captured **once**, in the
**Parameter Term Dictionary** (`backend/app/registry/terms.yaml` +
`dictionary.py`, Section 4.4): a startup-loaded, editable map keyed by *parameter
term* — never by function — that supplies widgets, data bindings, value pins, and
output-key roles, applied uniformly across every function that uses a given
parameter.

### 1.2 Non-goals

- Transcript-level rendering (hundreds of millions of points). Display targets
  **cell/observation scale** — low millions of points maximum.
- Authentication / access control. The deployment layer owns this; the app is fully
  open and collaborative.
- Distributed/multi-machine compute. Single long-lived server process.
- Persisting rendered figures. Plot outputs (SVG/PDF) are disposable; only call
  descriptors persist.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser (React/TS)                                                │
│  ┌────────────┐  ┌──────────────────────────────────────────┐    │
│  │ Left        │  │ Main area                                │    │
│  │ sidebar     │  │  - deck.gl canvas                        │    │
│  │ (4 tabs:    │  │  - or call detail modal                  │    │
│  │  compute/   │  │  ┌── gear (global ops)                   │    │
│  │  plots/     │  │  └── Resource strip (live RAM/CPU)       │    │
│  │  annot/     │  └──────────────────────────────────────────┘    │
│  │  subset)    │                                                  │
│  └────────────┘                                                   │
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
│  │  + term dict) │  │  Session B: ...                          │  │
│  └──────────────┘  └──────────────────────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐  │
│  │ Resource      │  │ Arrow / tile / table transport            │  │
│  │ monitor       │  └──────────────────────────────────────────┘  │
│  │ (psutil RSS)  │                                                │
│  └──────────────┘                                                 │
└─────────────────────────────┬─────────────────────────────────────┘
                              │ read / write
                              ▼
                   Local folders + SpatialData .zarr / .zarr.zip
                   + snapshots (JSON config + HTML page) + Cirro (optional)
```

**Runtime model:** one OS process. Each session owns one in-memory `SpatialData`
object, one FIFO job queue, and one worker thread. Jobs run serially **within** a
session (multithreaded internally where the underlying function supports it);
sessions run concurrently across threads. Data is served from the same process that
holds it — no IPC hop on the data path. (See Section 16 for why shared-process beat
process-per-session.)

### 2.1 Technology choices

| Layer | Choice | Rationale |
|---|---|---|
| Backend framework | FastAPI + uvicorn | Async, native SSE, Pydantic contracts, integrates with thread-pool workers |
| In-memory data | `spatialdata.SpatialData` | Committed data model; coordinate systems + shapes make lasso-subset clean |
| Data transport | Apache Arrow IPC (binary) | Zero-copy-ish to JS typed arrays → deck.gl binary attributes; no JSON on hot path |
| Server push | Server-Sent Events (SSE) | One-directional (queue/job/resource events); commands go over POST |
| Rendering | deck.gl + `@deck.gl-community/editable-layers` | Millions of points on GPU, binary attributes, built-in lasso/box/polygon editing, coordinate systems, image tiles |
| Resource monitoring | `psutil` (process RSS) | Heavy allocations live in numpy/numba/C; `tracemalloc` would miss them |
| Frontend UI | React + TS + Tailwind + Radix | Lightweight; maximizes canvas real estate; no heavy component kit chrome |
| Dynamic forms | JSON Schema → react-hook-form + custom widget map | Introspection emits JSON Schema; custom widgets for obs-key/var-name pickers |

---

## 3. Data model and persisted state

### 3.1 The object

The single source of truth is the in-memory `SpatialData` object. All compute mutates
it **in place**. There is no replay engine, no intermediate checkpointing, no
reactive rebuild graph — history is an audit log describing how the current object
came to be, not an execution plan (Section 5).

SpatialData elements in play:
- **Tables** (AnnData): expression/intensity matrices + `obs`/`var`/`obsm`/`obsp`/`layers`. Resident in RAM eagerly.
- **Shapes** (GeoDataFrame): cell/nucleus boundaries, ROIs.
- **Points**: centroids / molecule locations (may be large; treat as lazy).
- **Images / Labels**: raster, dask-backed, multiscale (pyramidal), lazy.

### 3.2 Application state lives in `sdata.attrs`

SpatialData has **no top-level `uns`** — `uns` is per-table, and a SpatialData may
hold multiple tables. The canonical home for persisted application state is
**`sdata.attrs["app_state"]`**, which serializes to the Zarr store. Bonus property:
`attrs` is passed by reference through `subset()`/`query()` operations, so app state
rides along through subsetting unless deliberately deep-copied (relevant to child
sessions, Section 8).

State blob schema (versioned; `backend/app/sessions/appstate.py`, current
`SCHEMA_VERSION = 3`, with a `migrate()` path):

```jsonc
sdata.attrs["app_state"] = {
  "schema_version": 3,
  "compute_history": [
    {
      "id": "uuid",
      "namespace": "gr",                  // gr | im | tl | read | pl | sc.pp | sc.tl | sc.get | custom
      "function": "spatial_neighbors",
      "params": { "coord_type": "generic", "n_neighs": 6 },
      "status": "completed",              // see Section 6.1 (incl. PENDING)
      "started_at": "ISO-8601",
      "finished_at": "ISO-8601",
      "log": "captured stdout/stderr/logging text",
      "structural_diff": { "obsp": ["spatial_connectivities", "spatial_distances"] }
    }
  ],
  "plots": [
    { "id": "uuid", "namespace": "pl", "function": "spatial_scatter",
      "params": { "color": "leiden" }, "status": "drawn",
      "references": ["obs:leiden"] }      // rendered SVG/PDF is NOT stored
  ],
  "displays": [
    { "id": "uuid", "type": "spatial_canvas",
      "encoding": { "coords": "obsm:spatial", "color_by": "obs:leiden",
                    "image_layer": "morphology_focus", "point_size": 3,
                    "opacity": 0.8, "channels": [ /* per-index visible/name/color */ ],
                    "show_points": true, "show_image": true,       // layer-visibility toggles
                    "show_channel_legend": true,
                    "render_mode": "points",                        // cell render (§9.10): points | points+shapes
                    "isolated_category": "Tumor" },                 // dim all but this category
      "viewport": { "target": [x,y], "zoom": z } }   // persisted on pan/zoom (embedding adds rotationX/rotationOrbit in 3D)
  ],
  "data_versions": { "obs:leiden": 3 },   // per-field counters bumped by structural diffs (§9)
  "regions": [ /* registered region sets — see §10.1 */ ]
}
```

Reload reconstructs the entire UI from this blob: data is hydrated from Zarr (compute
effects already materialized as fields), displays re-derive by resolving `encoding`
field paths, plots load in `not-drawn` state and render lazily, and regions
re-register.

### 3.3 Field-path addressing scheme

A single string grammar addresses any servable data field, used by both displays and
the Arrow resolver:

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

The resolver is fully generic — it never knows function names, only how to fetch a
field by path.

---

## 4. Function architecture: registry, schema-of-record, one contract

### 4.1 Discovery and the `Function` abstraction

At startup, `Registry.build()` (`backend/app/registry/introspect.py`) walks
`squidpy.gr`, `squidpy.im`, `squidpy.pl`, `squidpy.tl`, `squidpy.read` (and
`experimental.*`), keeps callables whose `__module__` is within `squidpy`, and builds
a registry keyed by `"<namespace>.<function>"`. The registry regenerates itself on a
library upgrade — nothing to hand-edit.

Every operation — library or app-defined — is modeled by an abstract **`Function`**
(`backend/app/registry/base.py`) with: identity (`namespace`, `name`), a generated
**form descriptor** (JSON Schema + UI hints), an **effect class** (Section 4.5),
**provenance** (`citation` + `documentation`, Section 4.3), and an
`execute(descriptor, session) -> CallResult` contract (Section 4.7). All three
kinds of function flow through the same picker → form → queue → history machinery.

### 4.2 Schema of record

Each function's inputs are defined by one schema whose **canonical serialization is
JSON Schema**, because that is simultaneously:
- what the frontend form renders from (react-hook-form + a custom widget map), and
- what Python validates against (Pydantic).

There is no second place where params are defined. For library functions the JSON
Schema is **generated** from the Python signature (`inspect.signature` +
`typing.get_type_hints`) enriched by the Term Dictionary; for custom functions it is
declared by the `Function` subclass. Docstrings (numpydoc) are parsed for **parameter
descriptions → tooltips only** — never for validation or enums. Enums come
exclusively from `Literal` annotations.

Type → widget fallback (before the Term Dictionary refines it):

| Python type (introspected) | Form widget |
|---|---|
| `bool` | checkbox |
| `int` / `float` | number input (with default) |
| `Literal['F','G','L']` | dropdown (enum values are exact) |
| `str \| None` | optional text |
| `Sequence[str]` / `list[str]` | multi-value input |
| unannotated / unknown | text box (safe fallback) |

### 4.3 `LibraryFunction`, custom functions, and the library catalog

- **`LibraryFunction`** (`backend/app/registry/library_fn.py`) is the **one
  reflection-built executor** for all library functions. A `library` field drives the
  import, so squidpy, scanpy, and spatialdata-io readers all run through one path;
  squidpy is still never named in code. Squidpy functions are discovered
  automatically; scanpy `pp`/`tl`/`get` and spatialdata-io readers are opted in via
  short manifest entries in **`backend/app/registry/library_catalog.yaml`** (each entry
  is a dotted path + effect class; import-guarded, skipped if the library is absent).
- **Custom functions** (`backend/app/registry/custom/`) are hand-written `Function`
  subclasses for app-defined operations that aren't a single library call. Built ones:
  *Identify Regions (Leiden)* (`leiden_regions.py`), *Edit Annotations*
  (`edit_annotations.py` — rename/merge a categorical obs column's values), *Identify
  TMAs* (`identify_tmas.py` / `tma_detect.py` — automatic tissue-microarray core
  detection), *Region composition*
  (`region_composition.py` — §11), *Annotate Cells (CellTypist)*
  (`celltypist_annotate.py` — predict a cell-type label per cell with a pre-trained
  model), and six spatial/multi-sample analysis method pairs — *Cellular
  Neighborhoods* (`cellular_neighborhoods.py`), *Milo differential abundance*
  (`milo_da.py`), *LISI* (`lisi.py`), *Proximity / avoidance test* (`proximity.py`),
  *Region boundary / infiltration distance* + *Infiltration profile*
  (`boundary.py`), and *Pseudobulk DE (DESeq2)* (`pseudobulk_deseq2.py`). Each of
  these six wraps a dependency-light (numpy/scipy/scikit-learn) compute/plot module
  vendored unmodified under `registry/custom/_vendor/` — the wrapper adapts the
  module's thin AnnData entry point to the `Function` contract (obs/obsm/uns writes,
  `ParamSpec`s, zarr-safe serialization of any result the module returns as a live
  DataFrame/array) rather than reimplementing the algorithm. They register in
  `custom/__init__.py`'s `CUSTOM_FUNCTIONS` and carry `namespace: custom`.

**Provenance (`citation` + `documentation`).** Every function carries a `citation`
(a text reference) and a `documentation` URL, surfaced in the picker and required
for all functions (enforced by `test_e2e.py`). These are populated by source, not
hardcoded per reflected function:
- **Library functions** inherit both from **`backend/app/registry/library_meta.yaml`**
  (loaded by `library_meta.py`), keyed by library. Each library declares one
  `citation` (the library's own reference) and a `doc_url` template whose `{path}`
  is filled with the function's dotted path, so the link resolves to that
  function's page in the library docs. Adding a library is a one-line meta entry;
  every reflected function inherits both fields.
- **Custom functions** set both explicitly: `citation` names where the method came
  from (paper/post/tutorial, or "original to this repository"), and
  `documentation = custom_doc("<anchor>")` links to that method's section in
  **`backend/app/registry/custom/README.md`**, which describes the method for users.

### 4.4 Parameter Term Dictionary (the only library-specific knowledge)

Pure reflection renders `cluster_key: str` as a bare text box, which is error-prone.
The Term Dictionary (`backend/app/registry/terms.yaml` loaded by `dictionary.py`)
centralizes parameter knowledge as a version-controlled YAML file, edited without
code changes. It is keyed by **parameter term** — a canonical parameter concept that
recurs across functions (`cluster_key`, `genes`, `layer`, `library_key`, `copy`,
`n_jobs`…) — so one entry enriches every function using that parameter.

**Invariant:** the dictionary defines *parameter terms, never functions*. An entry
says how to render/validate/pin a parameter wherever it appears; it never encodes a
function's behavior. Functions still come only from the registry.

**Resolution pipeline** (per parameter of a discovered function):
1. **Reflect** — name, annotation, default, kind.
2. **Match a term** by precedence: **scope-qualified** (`<ns.fn>::<name>`) › **exact
   name** › **name pattern** › **type-only** › none.
3. **Merge** — the term supplies `binding`, `widget`, a canonical `type` (only when the
   annotation is missing/loose), `policy`, `label`, `help`, `value_source`. A `Literal`
   annotation always wins for enum values; the dictionary fills enums only when the
   annotation is bare.
4. **Fall back** — unmatched params use the type-based widget; unknown types render as
   a safe text box.
5. **Emit** JSON Schema + widget hints; `value_source` resolves dynamically at render
   time against the active table.

**Binding vocabulary** (the data-slot mappings — a base type plus an `x-binding`
vendor extension the frontend reads to pick a live-dropdown widget):

| `binding` | Resolves to |
|---|---|
| `obs_categorical` | categorical `obs` columns (incl. **region sets**) |
| `obs_numeric` / `obs_column` | numeric / any `obs` columns |
| `var_names` | gene/feature names (single or multi) |
| `obsm_key` / `obsp_key` / `layer_key` | keys in `obsm` / `obsp` / `layers` |
| `library_id` | values of the chosen partition column |
| `image_element` / `shapes_element` / `labels_element` | SpatialData elements of that type |
| `categories_of(<param>)` | categories of the column a sibling param resolved to |
| `new_key` | free text naming a slot to **create** (output terms) |
| `null` | plain scalar/enum/text; no binding |

The `obs_categorical` row is what makes **region sets surface automatically** in every
grouping picker (a region set *is* a categorical `obs` column, §10).

**Roles and policy:**
- **`input`** — user-facing, bound to data or a scalar (default).
- **`managed`** — the *app* controls the value, hidden from the form: plotting render
  params so the app owns figure capture (`show → False`, `save → None`,
  `return_fig → True`, `ax`/`fig` injected), and mutation pins (`copy → False`,
  `inplace → True`). `policy: { pin: <value>, hidden: true }` fixes a value.
- **`output`** — names a slot the call will create (`key_added`, conventional output
  keys). Output terms let the recipe preflight compute **produced keys statically**
  (§12.4): "required pre-existing keys" = (referenced keys) − (produced keys).

**Coverage report:** at registry build, for every param across all discovered
functions, record whether it matched a term or fell back to the type default. `GET
/api/functions/coverage` reports unmatched params with type, the functions using
them, and a reuse-frequency rank, so maintainers add entries highest-frequency-first.
Regenerated on every upgrade — surfacing new params automatically.

### 4.5 Effect classes

The registry tags each function by **effect class**, derived from namespace with a
return-annotation cross-check:

- **Compute** (`gr`, `im`, `tl`, `sc.pp`, `sc.tl`, most `custom`): mutate the
  SpatialData in place. Tracked in `compute_history`. Run-and-mutate semantics.
- **Plot** (`pl`): read-only w.r.t. data; produce a matplotlib figure exported to
  SVG/PDF. Tracked in the separate flat `plots` list. Idempotent, re-runnable, lazy.
  There is **no `sc.pl`** — do all plotting through squidpy `pl.*`.
- **Read** (`read`, spatialdata-io readers): the return value *is* the new session
  object (session bootstrap, §17).
- **Extract** (`sc.get`, e.g. `obs_df`/`rank_genes_groups_df`): read-only extraction
  that feeds result assembly and comparison views rather than mutating.

These are surfaced as separate lists in the UI (Section 20) with different lifecycles
(Sections 6 and 7). The live deck.gl canvas is **neither** — it is an app-defined
display (Section 9), not a library call.

### 4.6 The single call adapter and data-argument injection

Every call runs through **one** adapter, `CallAdapter.execute(descriptor, session)`
(`backend/app/sessions/adapter.py`, singleton `ADAPTER`), which resolves
`namespace.function` in the registry and delegates to `fn.execute`. Per-function
variation is absorbed by the introspected descriptor + the `Function` subclass; there
are no per-function conditionals in the adapter, so a library upgrade changes nothing
here.

`LibraryFunction.execute` **injects data arguments by type, not name.** Every
parameter whose annotation is a session-held type is filled from the session and
excluded from the form: `AnnData` → the active table, `SpatialData` → the object,
`ImageContainer`/image → an image element. Functions may take more than one (e.g.
`im.calculate_image_features(adata, img, ...)`); each typed slot is filled
independently. When the object holds multiple candidates of a type, the form shows a
selector (defaulting to the active table). scanpy functions inject the active AnnData;
squidpy functions inject the object/element — handled uniformly by the same
type-based rule. `read` functions have no session-typed parameter, so nothing is
injected (their path comes from the form).

It then binds and coerces params (validate against JSON Schema, coerce JSON→Python,
resolve convention-bound references against the **current** object — validate-on-
dequeue), applies the managed pins from the Term Dictionary, enters an execution
context (per-job log capture, key-set snapshot for the structural diff, per-worker
memory ceiling), invokes the callable, and handles the effect by class:

- **compute** → object mutated in place; compute the structural diff (after − before).
  If it returns a data object (always-copies despite pinned `copy=False`), adopt it as
  the session object. If an
  in-place call instead *reshaped* the active table (changed its row/column count —
  e.g. `sc.pp.filter_cells` / `filter_genes`), the same whole-object adoption applies:
  the facet-merge writeback can only carry same-length columns back, so a shortened
  column would index-align and silently NaN-fill the dropped rows (corrupting integer
  keys like a table's `instance_key`). Both are uniform fallbacks, not per-function
  branches.
- **plot / extract** → capture the matplotlib figure (returned Axes' figure, else
  `plt.gcf()`), render to SVG/PDF bytes in memory; no mutation, no diff, bytes not
  persisted. Held under a **process-global plotting lock** with the **Agg** backend
  (pyplot state is process-global and sessions plot concurrently). Extract calls
  (`sc.get.*`) run for their side-effect-free return value, which is not written back
  or persisted — the object is unchanged.
- **read** → the return value *is* the new session object; adopt it as `session.sdata`.

### 4.7 The result envelope

Every function returns one uniform envelope:

```
CallResult { status, logs, structural_diff?, figure_bytes?, new_object?, error? }
```

The worker applies it (update history/plots/`attrs`, emit SSE). A failed
compute/plot call stays in the audit log so the user can inspect and delete it
(§6.1).

---

## 5. Execution model: in-place mutation + audit log

The deliberate, load-bearing decision: compute is **append-only and mutating**. There
is no undo and no reactive recomputation.

- Compute history is an **audit log**, not a replayable plan.
- "Rerun step k" does **not** edit step k. It appends a new call (a copy of k's
  descriptor, editable before submit) to the tail of the queue and executes it against
  current state.
- Because mutation is in place with no undo, re-running a mutating step **re-applies**
  it (re-running `normalize_total` normalizes already-normalized data). This is
  inherent, not a bug. **UI wording frames rerun as "run this operation again," never
  "fix the earlier step."**
- This severs replay-correctness from memory management, which is why huge datasets and
  slow serialization become tractable: the object is just the object; no intermediate
  states are retained.

Loading a saved project: hydrate the object from Zarr (all compute effects already
materialized), restore history/plots/displays/regions from `attrs`. Compute history is
informational only — never re-executed on load.

---

## 6. Compute calls and the job queue

### 6.1 Status lifecycle (compute)

A pre-queue **PENDING** status sits ahead of QUEUED for staged / manually-added steps
(§12.3):

```
(create) → PENDING → QUEUED → RUNNING → COMPLETED
              │  ▲                     ↘ FAILED      (error captured to log)
   edit/reorder  │  (discard removes it; QUEUED onward is immutable)
              └──┘
QUEUED → CANCELLED            (user cancels before run)
```

- **PENDING is the only editable state** — staged but not submitted: editable,
  reorderable, discardable, not consuming the queue. Once QUEUED, a step follows the
  immutable audit-log model; to change an executed step you append a new one (which
  starts PENDING). Manual "+ Add function" lands in PENDING with a single-step **Run
  now** fast path; **Run all pending (N)** enqueues every staged step in order.
- `QUEUED` calls remain cancellable; **`RUNNING` calls cannot be force-cancelled.**
  Python offers no safe way to interrupt a thread mid–native-call, and the single-
  process model rules out killing a worker without taking down the box. A **watchdog**
  surfaces a "long-running" warning once a job exceeds a configurable threshold (it
  cannot reclaim the job). Accepted limitation of in-process execution (§27, R6).
- If a session's bootstrap `read` job fails, the session has no object: it is marked
  `errored` and offered for retry or disposal, never left half-live.
- `COMPLETED` calls remain in history permanently. `FAILED` / `CANCELLED` are shown
  but user-deletable (§4.7).
- There is no `INVALIDATED` state for compute (invalidation is a plotting concept, §7).

### 6.2 Queue and worker

- One FIFO queue (`queue.Queue`) + one daemon worker thread per session
  (`backend/app/sessions/session.py`). Strictly serial dequeue.
- `read` calls are ordinary queue jobs and are normally the **first** entry in a
  session's history (they bootstrap the object — §17).
- The worker mutates the shared in-memory object directly (same process), so no
  serialization cost per job.
- **Validate-on-dequeue:** when a job is dequeued, its `params` are validated against
  the *current* object state (referenced `obs`/`var`/`obsm` keys must exist). This is
  what lets a recipe's step 5 reference a column that step 3 creates. Validation
  failure → `FAILED` with a clear log message.

### 6.3 Log capture

During a job, redirect Python `logging`, `stdout`/`stderr`, and tqdm into a per-job
buffer (a scoped logging handler + `contextlib.redirect_stdout/redirect_stderr`). Logs
attach to the history entry and become viewable when the job reaches
`COMPLETED`/`FAILED`. The frontend updates **live on status transition** via SSE, then
fetches the log on demand.

### 6.4 Structural diff (drives invalidation + cache busting)

On compute completion, compare the object's key-sets before and after: which
`obs`/`obsm`/`obsp`/`var`/`layers` keys and SpatialData elements were added or changed.
This diff is fully introspectable (set comparison, no per-function knowledge) and is:
1. stored on the history entry,
2. broadcast over SSE so clients **refetch only the Arrow fields that changed**,
3. used to invalidate any plot or display whose `references` intersect the changed keys.

---

## 7. Plotting calls

Plotting is tracked **separately** from compute — a flat list with no interdependencies.

### 7.1 Status lifecycle (plotting)

```
(create) → PENDING → QUEUED → RUNNING → DRAWN
                              ↘ FAILED
DRAWN → INVALIDATED   (an upstream compute call changed a referenced key)
INVALIDATED → QUEUED  (user clicks "Redraw")
```

### 7.2 Semantics

- Plots run through the **same queue** as compute (serial), stage via PENDING like
  compute, but carry extra detail-view functionality.
- A plot is **drawn only when first created** (or on explicit redraw). Loading a
  project does **not** auto-draw plots — strictly lazy.
- Plots render against the **current** data state ("live re-derivation," not a
  snapshot). A redrawn plot may differ from the original if upstream data changed —
  intended; documented.
- The rendered SVG/PDF is **never persisted**. Only the call descriptor is saved. This
  is what makes version drift non-destructive: if a `pl` signature changes and a stored
  call no longer validates, redraw goes `FAILED` and the data is untouched.
- Plot detail view shows: the rendered figure, the generated form (editable params),
  status, log, an **Edit & rerun**, and a **Redraw** button.
- Export: user downloads the figure as **SVG or PDF** from the detail view.

---

## 8. Lasso subset → child session

The flagship subsetting interaction. Implemented as an app-defined operation, recorded
as the child's immutable base — **not** as a compute-history step.

### 8.1 Flow

1. With the **Subsetting** tab active, the canvas selection mode arms a fork.
2. User draws box / lasso / circle via editable-layers, producing polygon vertices in
   the display's coordinate system. Multiple regions allowed (union).
3. User clicks **"Subset to selection."**
4. Frontend POSTs polygon vertices + target coordinate system to the backend.
5. Backend builds a `shapely` polygon and calls `spatialdata.polygon_query(sdata,
   polygon, target_coordinate_system=...)`.
6. A **new child session** is created from the query result.

### 8.2 Backend notes

- `polygon_query` selects elements that **intersect** the polygon; `bounding_box_query`
  selects by **center containment**. Use `polygon_query` for lasso/freeform.
- Performance caveat: if the object has a large `points` element, `polygon_query` can be
  slow. Where applicable, narrow with `subset()` first.
- The child's base is the **query result**, not a re-readable source; the child retains
  this subset as its own immutable origin for its lifetime.
- Child `attrs` are **deep-copied** (not by-reference) so the child's history/displays
  diverge from the parent. Child `compute_history` starts **empty** (the lasso is not a
  recorded step).
- Subset is enqueued as a **special queue job** (§24.5) so it serializes against
  compute and takes the read lock.

### 8.3 Parent lifecycle on subset

- User may **save parent before subsetting** (checkbox in the Subsetting panel); if so,
  flush parent to its Zarr store.
- **Either way the parent is evicted from RAM.** The child becomes the active session.
- Subsetting must pass the load-admission check for the child (§16.3) before the parent
  is evicted, to avoid a state with neither resident. Empty selections (zero-observation
  child) are refused with a warning.

---

## 9. Displays (live WebGL canvas)

### 9.1 Model

A single primary deck.gl canvas is the home view. Its configuration is an app-defined
**display spec** (§3.2 `displays[]`), configured through the same form machinery as
library calls but with a signature **defined by the application**:

| Display param | Type | Bound to |
|---|---|---|
| `coords` | field path | an `obsm` key (default `obsm:spatial`) |
| `color_by` | field path | an `obs` column, `X:gene`, or a `layer` gene |
| `image_layer` | element name \| null | an image element |
| `point_size` | number (world units) | — |
| `opacity` | number (0–1) | — |
| `channels` | per-index list | image channel visibility / name / color |
| `render_mode` | `points` \| `points+shapes` | cell render (§9.10); `points` is default (legacy `shapes` == `points+shapes`) |
| `invert_x` / `invert_y` | bool | Spatial-only; mirror the plot horizontally / vertically (camera-level, see §9.2) |
| `background` | `light` \| `dark` | Spatial-only per-plot backdrop; unset follows the app theme |

On load, default specs are generated from the object's structure. **Color by** first
picks a slot (`obs`, `X` gene expression, or a `layer`) then the column within it:
obs columns from a dropdown, genes from a type-to-search box backed by `GET
/api/sessions/{id}/var-names?q=&limit=` (matches found server-side, prefix hits first),
so datasets with tens of thousands of genes stay responsive.

### 9.2 deck.gl layer mapping

- Cell centroids → `ScatterplotLayer` with **binary attributes** (position Float32Array
  from Arrow; color from a category-index + palette, or continuous value + colormap).
- Cell boundaries → the points + boundary-fill overlay segmentation display (§9.10).
- Tissue image → `BitmapLayer`(s) fed from the multiscale pyramid (§9.3).
- Selection → editable-layers overlay (Polygon/Path/Scatterplot draw modes).

**Orientation + backdrop (Spatial only).** `invert_x`/`invert_y` and `background` are
applied at the camera, not per layer: `FlipOrthographicView` (a thin mirror of deck's
`OrthographicViewport` adding an `flipX` term to the view-matrix scale, alongside the
native `flipY`) flips the whole scene — points, image, and annotations together — so
picking, `info.coordinate`, pan, and fit stay consistent with no layer/coordinate changes.
The backdrop paints the canvas container behind the transparent deck canvas (matching a
theme's `--color-bg`), defaulting to the app theme until pinned. Both are baked into the
snapshot config's `render` (`invert_x`/`invert_y`/`background`, schema >= 1.1.0) and applied
by `SnapshotViewer` through the same `FlipOrthographicView`, so a snapshot preserves the
plot's orientation and backdrop (baked `background` defaults to `dark` when the user never
pinned one, since save can't see the live app theme).

### 9.3 Tiled image pyramid + coordinate reconciliation

Large sections (e.g. Xenium, ~34k×14k px) are drawn from the `SpatialData` multiscale
pyramid (`backend/app/imaging.py`): a coarse whole-image base thumbnail plus
level-of-detail tiles for the current viewport, so only what's on screen at the
resolution it needs is fetched, and zooming reaches full resolution. Served by `GET
/api/sessions/{id}/image/{element}/tile/{level}/{col}/{row}?channels=` (composited
WebP, 512px tiles, LRU-cached); `…/info` reports pyramid levels, tile size, and a
`pixel_to_world` affine.

Because a table's `obsm["spatial"]` and its image can live in different coordinate
spaces (Xenium spots are in microns; the image is in pixels), the server reconciles
them — picking the element transform that best overlays spots onto the image — so
points and image line up, and rotated/aligned images (e.g. an H&E) are placed as
quadrilaterals.

**Ingest-time raster normalization (`backend/app/rasters.py`).** The tile server
assumes each raster is a multiscale pyramid with tile-sized *store* chunks, but a
reader or an older checkpoint may hand us a single scale or huge chunks (Xenium
morphology ships as `(1, 4096, 4096)` chunks). Slicing a 512px tile out of a 4096
chunk forces dask to realize the whole chunk (~134 MB/channel), and a zoom burst
of such tiles OOMs the container. So `normalize_rasters` runs once when a session
adopts a `SpatialData` (read bootstrap in `Session._run_call`, and
`create_from_load`): every image/label that isn't already a tile-chunked pyramid
is rebuilt via `Image2DModel`/`Labels2DModel.parse` into a 2× pyramid down to a
`SDS_RASTER_BASE_PX` (1024) base, chunked at `imaging.TILE_SIZE`, and written to a
per-session cache store under `DATA_DIR`; the live elements are rebound to
lazy refs into it. An in-memory rechunk alone can't fix this — a small tile read
still fetches the large *store* chunk from disk — so the rewrite is the point.
After it, one tile realizes one ~2 MB chunk. Elements are rebuilt one at a time
and freed between (writing all four Xenium rasters together peaks ~8.8 GB); with a
small dask pool (`SDS_RASTER_REBUILD_WORKERS`) the peak is the largest single image
(~2.1 GB for the 3.8 GB morphology). Images get a mean-downsampled pyramid; labels
are rebuilt **single-scale, tile-chunked only** — they aren't LOD-rendered, and a
nearest/mode downsample of integer IDs can't stream (it materializes the whole
array plus every level at once, ~6 GB for a 1.9 GB label), so a pure lazy rechunk
is both correct and cheap. The check is idempotent (reloading a normalized store is
a no-op), element coordinate transforms are preserved so §9.3 reconciliation still
holds, and because the rebound in-memory elements are tile-chunked, `save` (§13)
inherits the tile chunking too. The cache dir shares the `extract_dir` lifecycle —
cleaned on close, ownership transferred to a subset child (§8.3).

Two-tier memory safety for rendering: image compositing is capped by a global
semaphore (`SDS_IMAGE_RENDER_CONCURRENCY`), and a render requested once RSS is past
`SDS_ADMISSION_PCT` returns 503 so a burst can't push an already-loaded container
over the OS memory limit (§11.3). The `create_from_read` path is likewise refused
at that boundary, since a raw reader input has no cheap size estimate.

### 9.4 Image channel controls

Per image channel: **toggle visibility**, **rename** (display-only name overriding raw
channel labels), and assign one of 8 canonical spectrum colors. Channels are composited
by additively blending each channel's percentile-normalized intensity tinted with its
color. State lives in the display spec, so it persists to `.zarr.zip`, is restored on
load, and is captured in snapshots (§14). A togglable legend overlays a swatch + label
for every visible channel.

**Two compositing paths.** The controls above drive one of two compositing back-ends,
chosen per image and transparent to the user. When the image qualifies, the browser
composites on the **GPU**: it reads the session's normalized raster **Zarr v3** store
directly — zarrita over a byte-range route `GET /api/sessions/{id}/raster/{element}/{key}`
(Range/HEAD) — and **Viv**'s `MultiscaleImageLayer` blends channels additively on black,
with per-channel color and contrast as shader uniforms, so contrast/color/visibility
edits are instant with no server round-trip. RGB/H&E images pass through as true color.
The server advertises this per image in `/image/{element}/info` (`client_compositing`),
gated by `SDS_CLIENT_IMAGE_COMPOSITING` (**default off**, opt-in with `=1`) and a channel
cap `SDS_CLIENT_IMAGE_MAX_CHANNELS` (default 6). Above the cap, or for a canonical image
with no rebuilt raster store (§9.3), `client_compositing` is false and the client falls
back to the **server-composited WebP tiles** (§9.3) — the same additive percentile-normalized
blend. A dev-only escape hatch `localStorage['sds:disableClientCompositing']='1'` also forces
the WebP tile path.

The client path streams full-resolution tiles with a **custom tiled layer** rather than Viv's
`MultiscaleImageLayer`: that tiled layer's deck.gl `TileLayer` never updates its tileset under
our world-coordinate `OrthographicView` + non-unit `pixel_to_world` scale (Xenium ~0.2125
um/px), so it renders nothing. Instead `useVivImageLayer.ts` reuses the exact
world-coordinate tile selection the WebP tile path uses (`useImageTiles`: pick the pyramid level for
the current zoom, inverse-affine the viewport to the visible tile bbox) and renders a Viv
`XRLayer` per visible tile — fetching raw channel data via the pyramid `PixelSource`
(`loader[level].getTile`) and compositing on the GPU — over a coarse Viv `ImageLayer` base so
the canvas is never blank while detail streams. Every XRLayer shares one level-0 pixel->world
`modelMatrix` and expresses its bounds in level-0 pixels, so the scaled/rotated affine
positions each tile exactly where the points are. Bounds use `[px0, py1, px1, py0]`
(row-0 side `py0` as `bounds[3]`=top, matching the WebP tile path's `quad`): this app's world /
`OrthographicView` is y-up (a cell at world y=0 sits at the screen bottom), so image row 0
(pixel py=0 → world y=0 via the affine) must land at the bottom to align with the points. Deep zoom fetches only the visible finest-level tiles
(a ~3x3 grid of level-0 tiles at high zoom), so there is no resolution penalty versus the
WebP tile path. It is **on by default** (`SDS_CLIENT_IMAGE_COMPOSITING`, disable with `=0`);
verified live across single- and multi-channel fluorescence (additive-on-black), RGB/H&E
true-color passthrough, deep-zoom streaming, and image<->points alignment. See `docs/CONTRACT.md` for the info/route schemas. The snapshot viewer and
its schema are unchanged by this dual path.

### 9.5 Editable points transform

When the automatic reconciliation (§9.3) is off, **Edit points transform** opens an
editor for the points→global affine of the table's region element, as either
scale/rotation/translation or a raw 2×3 matrix. Saving runs
`spatialdata.transformations.set_transformation` under the write lock and writes the
object to its checkpoint (blocking spinner while it saves), so the new alignment
persists across sessions. Served via `GET`/`POST
/api/sessions/{id}/points-transform` (`backend/app/sessions/transform.py`).

### 9.6 Refresh and caching

When a compute job completes, the SSE structural-diff event tells the canvas which
fields changed. The canvas refetches only changed Arrow fields and rebinds GPU buffers;
displays whose `references` did not change do not refetch. The client caches each
fetched field keyed by `(session, field_path, data_version)`, where `data_version` is a
per-field counter bumped by the structural diff — so a refetch happens only when a
field's version actually advances. Categorical color palettes are keyed by **category
value** (not ordinal index) so recompute that changes the label set keeps stable
colors.

### 9.7 Camera

`viewport` in a display spec is the **default/initial** camera restored on load — not a
shared cursor. Live pan/zoom is **per-client browser state**, never broadcast, so
collaborators don't fight over the view.

### 9.8 Display data-state machine

Each layer carries an explicit visual state so the user always knows whether what they
see is current, stale, loading, or unavailable:

| State | When | Visual treatment |
|---|---|---|
| `FRESH` | bound buffers match current `data_version` | normal render |
| `LOADING` | initial fetch of a field in flight | dimmed + progress overlay |
| `STALE` | a running/queued compute call touches a referenced field, refetch not yet issued | dimmed + "updating…" badge; **previous data still shown** |
| `FETCHING` | refetch issued after completion, new buffers not yet bound | progress overlay over dimmed prior render |
| `MISSING` | a referenced field does not (yet) exist | placeholder with the unresolved path + a prompt |

Transitions are driven by existing SSE events (`job.started`/`job.completed` +
structural diff). The view never silently shows data that no longer matches the object.

### 9.9 Cell-color legend and data inspector

- **Cell-color legend** (bottom-right, togglable) reflects the current **Color by** — a
  viridis colorbar with the value range for numeric columns, category swatches for
  categorical ones — with an editable title defaulting to the column/gene name.
- **Data inspector** — a Spatial/Tables switch opens a paginated browser over the
  `SpatialData` elements: each table's `obs`/`var`, `shapes` GeoDataFrames (geometry as
  WKT), `points`, and image metadata + thumbnail. Served by `GET
  /api/sessions/{id}/elements` (inventory) and `GET
  /api/sessions/{id}/table?path=&offset=&limit=` (JSON page).

### 9.10 Cell-segmentation display (display only)

The point scatter always draws; cell-boundary fills optionally overlay on top of it. This
is a **display** of existing segmentation — it never resegments or recomputes boundaries. A
**Render mode** control persists on the display encoding (`render_mode`): `points` (scatter
alone) vs `points+shapes` (scatter plus the boundary-fill overlay). The legacy value
`shapes` maps to `points+shapes`.

- **Point scatter (always on).** The instanced `MarkerScatterplotLayer` (size slider +
  circle/square/hexagon glyph) covers every zoom, including the zoomed-out and
  shapes-loading regimes, so the canvas never blanks. Overlapping glyphs **merge**, not
  blend: a two-pass fragment-depth trick writes `gl_FragDepth` so the nearest centroid
  wins each pixel — touching same-color cells read as one contiguous region and overlaps
  don't darken at opacity < 1 (this replaced the separate nearest-cell "field" layer).
- **Cell-boundary overlay (`render_mode: points+shapes`).** When the session has boundary
  polygons, their real outlines filled by the per-cell color stack on top of the points,
  from a `GeoArrowSolidPolygonLayer` fed by viewport-clipped GeoArrow fetched from `GET
  /api/sessions/{id}/shapes/{element}/geoarrow?bbox=…` (`usePolygonBbox.ts`, LRU-cached per
  viewport bbox + data_version). The fills use the same per-cell colors as the points, so
  the overlap is seamless and the points fill the gaps between cells.
- **The fetch gate.** The overlay fetch fires only once a cell is a few pixels across —
  `zoom ≥ shapesFetchZoomThreshold(meanSpacing) = log2(6 / meanSpacing)`
  (`useCanvasViewState.ts`; `meanSpacing = estimateMeanSpacing(positions) ≈ √(bbox_area/n)`).
  Below that the viewport would hold more cells than the backend ships anyway, so the
  fetch is deferred and the points are the whole view. When a bbox is over the ship cap the
  backend returns a 0-row table, which `usePolygonBbox` reports as *no layer* — the points
  simply keep covering the view (no dead "blank band").

Geometry is served in the same world space `/data/obsm:spatial` uses (the region element's
points→global affine), so outlines, points, and image overlay; the GeoArrow polygons carry
a `cell_index` back to the active table for color gather. The read-only snapshot viewer,
which has no backend to fetch polygons, draws the same merged point scatter (no shapes
overlay) for 2D spatial snapshots. See `docs/CONTRACT.md` for the payload schemas.

**Known follow-up:** `@geoarrow/deck.gl-layers` (0.3.2) logs a console deprecation — it
is renamed to `@geoarrow/deck.gl-geoarrow` (0.4.x). Not migrated: 0.3.2 is the verified
working version, and 0.4.x may drift the API and needs re-testing.

---

## 10. Region annotation

A **region** is a category within a **region set**; a region set is a categorical `obs`
column (`backend/app/sessions/regions.py`). Because a region set is an ordinary `obs`
categorical, it flows through every existing mechanism (grouping pickers, color-by,
recipes) with no new wiring.

### 10.1 Data model

**Geometry is out of scope.** Drawing a region computes cell membership (via
point-in-polygon over `obsm["spatial"]`) and keeps only that membership as an `obs`
categorical; the drawn polygon itself is **not** persisted as a shapes element. A region
set therefore looks identical whether it came from a drawn lasso, a promoted existing
categorical, or a derived clustering — there is no "has geometry" distinction to track.

Registration is declarative, persisted in `attrs.regions`:

```jsonc
"regions": [
  { "id": "uuid", "name": "tumor_vs_stroma", "obs_column": "tumor_vs_stroma",
    "categories": [
      { "label": "tumor",  "color": "#c1432b", "n_cells": 18234 },
      { "label": "stroma", "color": "#2b6cc1", "n_cells": 40561 },
      { "label": "unassigned", "color": "#bbbbbb", "n_cells": 1203 } ] }
]
```

**Semantics:** a region set is **single-label** (a partition) — each cell maps to
exactly one category, `"unassigned"` otherwise. Overlapping drawn polygons resolve
last-wins. Genuinely overlapping concepts are **separate region sets**, enabling
cross-tabulation between schemes.

### 10.2 Creation: lasso, promotion, derived

The existing lasso machinery is reused; only the terminal action differs. With the
**Annotations** tab active, a drawn selection **labels** cells in place (rather than
subsetting), as a **queued mutating job** (audit-log entry + structural diff + write
lock — identical lifecycle to subset):

1. user draws box/lasso/circle (strokes union into one region);
2. chooses the target region set (create or pick), names the category, picks a color;
3. backend (`regions.assign()`) computes membership via
   `matplotlib.path.Path.contains_points` over `obsm["spatial"]`, writes
   `obs["<set>"]`, updates the `attrs.regions` registry, and emits a structural diff
   (`obs:<set>`). The polygon is discarded once membership is computed.

Three sources land in the same geometry-free representation:
- **Hand-drawn** (lasso).
- **Promoted** — any existing `obs` categorical promoted to a region set
  (`regions.promote()`), including `tl.sliding_window` window assignments.
- **Cluster/domain-derived** — Leiden on a spatial graph (*Identify Regions*), or a
  niche categorical, promotable.

### 10.3 Editing operations

Create set · add region (draw) · rename · recolor · merge categories · split/reassign ·
delete region · delete set · promote existing categorical · toggle visibility · set
active set. Each membership-affecting edit re-derives membership as a queued mutating
job. In the canvas, region coloring is `color_by` on the categorical (stable palette
keyed by category value); the legend lists sets and per-category counts, with
click-to-isolate (client-side filter, no refetch).

---

## 11. Region comparison

Region comparison = use the region `obs` column as the grouping argument, then contrast
per-region outputs. Because the Term Dictionary surfaces `obs_categorical` params
(§4.4), **every relevant grouping function takes a region set as its grouping key with
no new code** — `sc.tl.rank_genes_groups(groupby="tumor_vs_stroma")`,
`gr.nhood_enrichment(cluster_key=...)`, `gr.co_occurrence`, `gr.ripley`, `gr.ligrec`,
`gr.centrality_scores`, `gr.interaction_matrix`, `gr.spatial_autocorr`, etc. The app
doesn't hardcode that list; the registry enumerates the live functions and region sets
become groupable for free.

**Built comparison analysis:** cell-type-by-region composition, as a custom plot
step (`region_composition.py`): `pandas.crosstab(region, cell_type)` for
proportions, `scipy.stats.chi2_contingency` for a composition-difference test, then a
stacked-bar plot of the proportions, all in one step (pandas/scipy/matplotlib only — no
new dependencies). A broader per-region orchestration engine and faceted small-multiples
display remain design directions, not built features.

**Statistical caveat (designed into the UI):** comparing regions of **one** section has
**no biological replication** (n = 1 per region). DE is valid for marker/exploratory
discovery — lead with effect sizes/fractions, label p-values exploratory. Composition
tests and enrichment-matrix diffs describe *this section*, not condition-level
inference. Permutation metrics (`nhood_enrichment`, `ligrec`) give a within-region null
by label shuffling — a descriptive enrichment, not a between-region inferential test.
The composition function's docstring and output state this explicitly.

---

## 12. Recipes

A **recipe** is a named, shareable bundle of ordered **compute + plot** steps with an
attached README — the reusable form of an analysis, authored once and applied to any
dataset. Recipes ship in the repo (`backend/app/recipes/`) or are imported from a file.

### 12.1 Bundle format

One JSON file per recipe (`NN_short_name.json`, numbered for gallery order), discovered
at startup (`backend/app/recipes/__init__.py`):

```jsonc
{
  "schema_version": 1,
  "meta": { "name": "...", "description": "...", "provenance": "adapted from ..." },
  "readme": "# markdown notes: what it does, expected inputs, how to read outputs",
  "steps": [
    { "namespace": "sc.pp", "function": "normalize_total", "params": {} },
    { "namespace": "gr", "function": "spatial_neighbors", "params": { "n_neighs": 6 } },
    { "namespace": "gr", "function": "nhood_enrichment", "params": { "cluster_key": "cell_type" } },
    { "namespace": "pl", "function": "nhood_enrichment", "params": { "cluster_key": "cell_type" } }
  ]
}
```

Steps are the same `{namespace, function, params}` descriptors used everywhere. Valid
namespaces: squidpy `gr`/`im`/`tl`/`pl`/`read`; scanpy `sc.pp`/`sc.tl`/`sc.get` (no
`sc.pl`). A param set to `null` is dropped before the call. The 17 bundled recipes cover
squidpy spatial workflows on `visium_hne`, scanpy preprocessing/clustering on raw counts
(Xenium), and scanpy-tutorial reproductions (full Visium analysis, MERFISH clustering).

### 12.2 Sources & authoring

- **Repo-bundled ("official")** — files under `recipes/`, discovered at startup, each
  README citing provenance.
- **Imported** — a recipe file the user loads.
- **Authored in-session** — stage a plan of PENDING steps, then export.

On import a recipe is **validated against the installed registry** — each step's
function must exist and params must resolve via the Term Dictionary — so version drift
in a shared recipe surfaces as clear per-step errors, not silent failure.

### 12.3 Import: run vs. stage; PENDING

Applying a recipe (from **Browse recipes** or a file) shows the README, the ordered
steps, and the preflight checklist (§12.4). The user chooses:
- **Run** — all steps enter the queue in order immediately (validate-on-dequeue handles
  inter-step dependencies).
- **Stage** — all steps are created **PENDING** (§6.1): visible in the Compute/Plots
  tabs, params editable (**Edit params**, Save keeps it pending), each runnable on its
  own, and **Run all pending (N)** submits the staged plan in order.

### 12.4 Preflight

`POST /api/sessions/{id}/recipe/preflight` computes **required pre-existing keys** =
(referenced keys) − (keys produced by `role: output` params, §4.4), and renders
unresolved references as a checklist (e.g. *"before running, define region set
`tumor_vs_stroma` with categories `tumor`, `stroma`"*). Unknown functions block; steps
whose keys the recipe itself produces need nothing. `requires` is recomputed on import,
never stored.

### 12.5 Portability — annotations don't travel

Recipes carry **compute + plot** steps only; **annotations are excluded**. Hand-drawn
membership is derived from one section's coordinates and is meaningless replayed
elsewhere; replication works by re-defining region sets under the same `obs` key names
(drawn or promoted). A step like `rank_genes_groups(groupby="tumor_vs_stroma")` resolves
because the new dataset carries that column. Key-level grouping ports more freely than
hard-coded category references; the preflight makes the difference visible.

---

## 13. Data manifest (removed)

Earlier versions captured a text "data manifest" of session state before and after
every call — assembled from a registry of contributors under
`backend/app/manifest/` — to feed a planned AI-agent loop. That loop was never
built, so the manifest (its only consumer) was removed along with the envelope's
`manifest_*` fields and `keep_failures` flag (§4.7). Session state is inspected
directly through the data inspector and the element/table APIs.

---

## 14. Snapshots

A snapshot is a small **JSON config** plus a tiny **HTML page**, describing a
**read-only** view over an immutable checkpoint (`backend/app/snapshots.py`). It ships no
pixels, data, or viewer code of its own — the HTML loads a shared, version-pinned viewer
bundle from GitHub Pages, and that bundle opens the referenced checkpoint `.zarr.zip`
directly (zarrita.js over HTTP range requests) and renders the image + cells from it,
reusing the live canvas rendering.

- **Config envelope:** `{schema_version, kind, label, created, data, checkpoint:{name},
  table, viewport, encoding, render}`. `schema_version` is a semver string equal to the
  version in `snapshot-viewer.json`. `data` is a **relative** path to the checkpoint
  (`./<checkpoint>.zarr.zip`) that the viewer resolves against the config file's own URL
  (`new URL(cfg.data, configUrl)`) — "paths in the JSON are relative to the JSON" — so the
  config and its `.zarr.zip` must stay siblings both live and in a bundle. `checkpoint`
  carries only `name` (used by `list_snapshots` and the Cirro symlink); the old absolute
  `checkpoint.url` coupling is gone. `render` bakes what the browser can't derive from the
  raw arrays: the image geometry (`image_info` — bounds, `pixel_to_world`, pyramid levels,
  channel names) and per-channel `{visible, color, contrast_limit}` (the contrast limit
  is `imaging._channel_norm`, coarsest-level-derived like the tile server, so the browser
  compositor `sum(clip(value/limit, 0, 1) * color)` reproduces the live look). The
  categorical palette / numeric range are **not** baked — the viewer derives them with
  the same `colorUtils` from the same immutable arrays. `render`/`encoding`/`viewport`
  internals are unchanged from the pre-refactor schema; only the envelope changed.
- **HTML page:** a five-line standalone entry point —
  `<div id="app" data-config="./<name>.sview.json"></div>` plus a classic (non-module)
  `<script src="${pagesBaseUrl}/viewer/${version}/app.js">`. The classic script tag loads
  cross-origin from GitHub Pages without CORS headers; `data-config` is relative so the
  browser resolves it against the HTML's own URL (colocated). See §14.2 for the shared
  viewer's hosting and versioning.
- **Immutable target:** saving a snapshot first writes the session to a content-hashed
  `.zarr.zip` (so the config points at bytes that won't change under it), then bakes the
  manifest — both under one continuous read lock so no compute can interleave. The
  checkpoint is served for direct browser reads (HTTP Range) at `GET /api/checkpoints/<name>`
  (checkpoint picker) and, so the config's relative `data` path resolves live, also as a
  sibling of the config under the name-validated route `GET /snapshots/<name>`, which
  serves the `.sview.json` config, the `.html` page, and the `.zarr.zip` checkpoint alike
  (Range + HEAD).
- **Files:** `<name>-<hash>.sview.json` + `<name>-<hash>.html` in `DATA_DIR` (same prefix,
  the config JSON content-hashed), alongside the checkpoints. Both spatial and embedding
  displays can be snapshotted (`POST /api/sessions/{id}/snapshot` with an optional
  `display_id`, returning `{status, name, url, html}`).
- **Invocation:** a **Save snapshot** action (canvas controls).

### 14.1 Checkpoint on-disk format (browser-readable)

The same `.zarr.zip` that reloads as a live session is the source the snapshot viewer
reads. To make a browser read cheap over one HTTP-served file:

- **Zarr v3 + consolidated metadata** (spatialdata's default) + **ZIP_STORED** (each entry
  is a contiguous byte span a range request maps to directly).
- **Sharding codec** on the image/label arrays, added on save (`store._shard_rasters`):
  small inner chunks (`512`) packed into a few shards (`4096`), so a viewport read fetches
  a tiny shard index plus a handful of small chunks instead of one giant chunk — without
  exploding the object/zip-entry count. spatialdata 0.7.3 has no write-time sharding
  option, so each raster level is recreated region-by-region (peak memory ~one shard),
  then metadata is **re-consolidated** (the consolidated tree the browser reads must
  report the sharded codec, or zarrita would decode the pre-shard byte layout).
- **Worker logs relocated** out of `attrs["app_state"]` (inlined into the store's root
  `zarr.json`, downloaded in full on open) into gzipped `logs/<record_id>.log.gz`, read
  back lazily by `session.get_log` (the existing `/jobs/{id}/log` endpoint).

### 14.2 Shared viewer hosting and versioning

The viewer bundle is published **once per version** to GitHub Pages, decoupled from any
individual snapshot; snapshots only point at it. This is what lets a saved snapshot keep
rendering forever even after the schema evolves.

- **Single source of truth:** `snapshot-viewer.json` at the repo root
  (`{version, pagesBaseUrl}`). The backend reads it (`config.py`), the viewer's Vite build
  imports it (`vite.app.config.ts`), and CI reads it — the published URL
  `${pagesBaseUrl}/viewer/${version}/app.js` is always computed, never hardcoded in pieces.
- **The bundle:** `npm run build:app` (`vite.app.config.ts`) builds `src/app-entry.tsx`
  into a **single-file classic IIFE** at `frontend/dist-app/viewer/<version>/app.js` —
  Tailwind CSS inlined and injected as a `<style>` at runtime, all assets inlined, no
  `type="module"`. `app-entry.tsx` finds `#app[data-config]`, fetches the config, resolves
  `data` against the config URL, and renders one snapshot by reusing `SnapshotViewer` (no
  picker). The bundle bakes in its own schema major and shows a friendly message if a
  config's `schema_version` major differs.
- **Immutable per version:** `.github/workflows/deploy-viewer.yml` publishes
  `viewer/<version>/` to GitHub Pages **accumulatively** (prior version dirs are never
  deleted; `.nojekyll` at the site root). Because each snapshot HTML pins its exact
  `app.js` version, older snapshots keep loading the viewer they were built against.
- **Version governance (test-gated):** the emitted schema is frozen per version as a
  structural golden in `backend/snapshot_schema/<version>.json`; a test asserts a freshly
  saved config matches the golden and that its `schema_version` equals the version file.
  A schema change therefore forces bumping `version` in `snapshot-viewer.json`, adding a
  new golden, and republishing — an already-published version dir/golden is never mutated
  (mirroring immutable GitHub Pages). `ci.yml` runs this gate plus the frontend
  typecheck/build on PRs.
- **In-app preview vs. published viewer:** the in-app `SnapshotViewer` (used by the
  snapshot browser) and the published `app.js` share the same rendering and the same
  `new URL(cfg.data, configUrl)` resolution rule; the removed standalone-picker path
  (`StandaloneViewer.tsx`, `viewer-main.tsx`, `viewer.html`, `vite.viewer.config.ts`,
  the `build:viewer` script, `snapshots/index.json`) is gone.

---

## 15. Cirro upload

Optionally upload the saved session plus selected snapshots to
[Cirro](https://cirro.bio/) as a dataset (`backend/app/cirro.py`). Strictly additive:
dark unless `CIRRO_BASE_URL`, `CIRRO_CLIENT_ID`, and `CIRRO_CLIENT_SECRET` are all set.

- **Auth:** a service-account (OAuth client-credentials) identity — **no interactive
  login**, gated by `config.cirro_enabled()`.
- **Flow:** the session must be **saved first**. `build_upload_folder()` builds a temp
  folder from **symlinks**: each selected `.zarr.zip` under `sessions/`, and each selected
  snapshot's three files — its `.sview.json` config, its `.html` page, and the `.zarr.zip`
  it references — colocated as siblings at the bundle root, so nothing is copied and each
  config's relative `data` path resolves. **No viewer code is bundled** (the removed
  `_copy_viewer` / `dist-viewer` path): each HTML loads the shared version-pinned viewer
  from GitHub Pages (§14.2), so every uploaded `.html` is a standalone read-only entry
  point. There is no multi-snapshot picker or `snapshots/index.json` manifest anymore.
  `upload()` calls the Cirro SDK's `project.upload_dataset`. Driven by a `cirro_upload`
  worker job.
- **UI:** a dialog listing Cirro projects, a dataset name, an optional folder (free-text
  with typeahead, see below), and saved snapshots (multi-select). Uploads always use the
  generic "Files" ingest process (`custom_dataset`), so there is no process picker.
- **Folder:** Cirro's portal groups datasets into folders via a plain dataset tag whose
  value is `folder://<path>` (nested paths use `/`) — there's no dedicated folder API, so
  `list_folders()` derives the known folder list for a project by scanning
  `project.list_datasets()` tags, same as the portal UI itself does. Backend-cached per
  project (`GET /api/cirro/projects/{id}/folders`) since a full dataset scan is expensive;
  a successful upload with a new folder updates the cache directly instead of forcing a
  rescan. The field is free text with a browser `<datalist>` typeahead, not a plain
  picker — the folder need not already exist.

---

## 16. Sessions, process model, and memory

### 16.1 Session model

- A session = one in-memory `SpatialData` + one queue + one worker thread + its `attrs`
  state.
- Sessions are **shared and fully collaborative**. Multiple users may attach; all see
  the same data, queue, history, plots, regions, and display specs, updated in real time
  over SSE. (Access control is the deployment layer's concern.)
- Switching sessions is a client navigation; it does not evict server-side sessions.
  Session navigation lives in the **Subsetting** tab's lineage tree (§20).

### 16.2 Process model — single shared process, per-session worker threads

Chosen over process-per-session because the audit-log decision removed the need to
reconstruct intermediate states (the main argument for process isolation), and because a
shared process keeps the **Arrow→GPU data path direct** (data served from the same
process that holds it — no IPC hop, which matters for high-performance rendering).

- One process; one worker thread per session; the FastAPI event loop stays responsive
  because heavy `squidpy`/`scanpy` work releases the GIL (numpy/numba/C).
- **Hard per-worker memory ceiling:** cap each worker so an overrun raises a catchable
  `MemoryError` (fail that one job, keep the server and other sessions alive) instead of
  inviting the OS OOM killer.

### 16.3 Memory accounting and guards

Memory peak is **not predictable** (some functions allocate transient O(n²)
structures). Therefore: **monitor closely, expose live, guard at boundaries.**

- **Monitor:** sample process **RSS** via `psutil` on a fixed cadence; push over SSE to
  the resource strip. Show global and per-session resident cost.
- **Load-admission control:** before loading a dataset, estimate its **resident** cost
  from Zarr metadata (tables load eagerly and dominate; images/labels are lazy). If it
  won't fit, block the load.
- **Boundary admission (`ADMISSION_PCT`):** if usage is already ≥ the threshold, refuse
  to dequeue the next job and warn. Only the per-worker ceiling bounds an in-flight
  spike.

### 16.4 Session death

- Subsetting evicts the parent (§8.3).
- Otherwise sessions are evicted under memory pressure or by explicit close; eviction
  flushes to a Zarr checkpoint first if there is unsaved state, then drops from RAM.

---

## 17. Reading data / starting a session

- `read` functions (`read.visium`, `read.vizgen`, `read.nanostring`, plus
  spatialdata-io readers `xenium`/`visium`/`visium_hd`/`merscope`/`cosmx` as available)
  are the entry point. The user selects a **local folder**; the app parses the format and
  builds the initial `SpatialData`.
- A `read` call is enqueued as the **first job** in the session and appears as the first
  entry in `compute_history`.
- **Opening a saved checkpoint (`load`)** is the same shape: `create_from_load` runs only
  the cheap admission checks synchronously, then returns a `loading` shell and enqueues the
  unzip/read/re-tile as the session's first worker job (`Session._run_load`), which adopts
  the object under the write lock exactly like a read bootstrap. This keeps a large
  (multi-GB Xenium) checkpoint load off the HTTP request, so it never blocks past a fronting
  proxy's origin timeout (a 504, §24.2); progress and a terminal `done` event stream over
  `session.loading` keyed by the client-minted `load_id`, and the checkpoint's `hash_check`
  rides that terminal event.
- Loading must pass load-admission control (§16.3) before the object is materialized.
- **Startup splash:** the frontend polls `GET /api/readyz` and shows a full-screen splash
  until the backend finishes importing `squidpy` and building the registry, so a slow
  cold start doesn't look like an empty app.

---

## 18. Persistence

- **Save / export:** write the active `SpatialData` to a `.zarr.zip` (data + `attrs`
  state blob) — the complete, portable project, and the artifact the in-SPA snapshot
  viewer byte-range-reads directly. Save is enqueued as a **special queue job** (§24.5) so
  it captures a consistent snapshot serialized against in-flight compute. Saving blocks the
  UI behind a spinner; a Stop button cancels it while still queued (a save already writing
  to disk can't be interrupted).
- **Incremental save:** a session loaded from a `.zarr.zip` is unpacked into a writable,
  already-sharded directory store (its `extract_dir`) that backs the live object. Re-saving
  such a session rewrites only the elements that changed since the last save — a changed
  table element (delete its on-disk dir, then `write_element`, since spatialdata 0.7.3
  refuses to overwrite an element inside its own store), an edited coordinate transform
  (`write_transformations`), and always `attrs` (`write_attrs`) — then re-consolidates
  metadata and re-zips the directory. Rasters are Dask-backed from these same files and are
  never touched, so the expensive decompress/recompress/**reshard** pass is skipped
  entirely. This is gated on the store already being sharded (`can_update_incrementally`);
  a compute that changes a raster or other non-table element, or a fresh import whose store
  isn't sharded yet, falls back to the full write (`save_spatialdata`, which reshards). The
  session tracks which elements are dirty (`dirty_tables`, `dirty_transforms`, `force_full`)
  from each mutation's `structural_diff`. Save staging happens next to the destination
  so the final commit is a same-filesystem rename, and the auto-named content hash is
  accumulated during the zip write rather than by re-reading the finished archive.
- **Load:** open a `.zarr.zip` (or `.zarr`); hydrate the object and restore UI from
  `attrs` (§5). `attrs["app_state"]` runs through a **schema migration** keyed on
  `schema_version`; a blob newer than the app opens read-only with a warning.
- **Round-trip guarantee:** reloading reproduces the exact display configuration, the
  compute audit log, the plot list (undrawn until opened), and registered regions. The
  in-process `test_e2e.py` asserts this.

---

## 19. API surface

All command/control over REST (JSON). All server→client updates over SSE. Bulk data over
Arrow IPC (binary). See `docs/CONTRACT.md` for the full contract.

### 19.1 REST (representative)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/functions` | Introspected registry: descriptors + JSON Schema, tagged by effect class |
| `GET` | `/api/functions/{ns.fn}` | Single function descriptor + JSON Schema |
| `GET` | `/api/functions/coverage` | Term-dictionary coverage report |
| `GET` | `/api/readyz`, `/api/healthz` | Readiness (registry built) / liveness |
| `GET` | `/api/sessions` | List sessions + per-session resident memory + lineage |
| `POST` | `/api/sessions` | Start session via a `read` call (folder + read descriptor) |
| `GET` | `/api/sessions/{id}` | Session state: history, plots, displays, regions, status |
| `DELETE` | `/api/sessions/{id}` | Close session (flush if needed, evict) |
| `POST` | `/api/sessions/{id}/jobs` | Enqueue a call descriptor (run or stage) |
| `POST` | `/api/sessions/{id}/jobs/{jobId}/run` | Run a PENDING step |
| `POST` | `/api/sessions/{id}/run-pending` | Run all pending steps in order |
| `PATCH`/`DELETE` | `/api/sessions/{id}/jobs/{jobId}` | Edit PENDING params / cancel or delete |
| `GET` | `/api/sessions/{id}/jobs/{jobId}/log` | Fetch captured log |
| `POST` | `/api/sessions/{id}/plots/{plotId}/redraw` | Set plot → QUEUED |
| `GET` | `/api/sessions/{id}/plots/{plotId}/export?fmt=svg\|pdf` | Download figure |
| `PUT` | `/api/sessions/{id}/displays/{displayId}` | Update display spec |
| `GET`/`POST` | `/api/sessions/{id}/points-transform` | Read / set points→global affine |
| `POST` | `/api/sessions/{id}/annotate` | Lasso label → region set (in place) |
| `POST` | `/api/sessions/{id}/regions/...` | Region edit ops (rename/merge/promote/…) |
| `POST` | `/api/sessions/{id}/subset` | Lasso subset → child session |
| `POST` | `/api/sessions/{id}/save` | Write `.zarr.zip` |
| `POST` | `/api/sessions/load` | Load a `.zarr.zip` / `.zarr` |
| `GET` | `/api/recipes` | Bundled recipe catalog |
| `POST` | `/api/sessions/{id}/recipe/preflight` | Dry-run a recipe; unresolved references |
| `POST` | `/api/sessions/{id}/recipe/run` | Import + run or stage a recipe |
| `GET` | `/api/sessions/{id}/recipe` | Export recipe JSON from history |
| `GET` | `/api/sessions/{id}/var-names?q=&limit=` | Server-side gene name search |
| `GET` | `/api/sessions/{id}/data/{fieldPath}` | **Arrow IPC** stream of a field |
| `GET` | `/api/sessions/{id}/elements` | Data-inspector element inventory |
| `GET` | `/api/sessions/{id}/table?path=&offset=&limit=` | Data-inspector dataframe page |
| `GET` | `/api/sessions/{id}/image/{element}/tile/{level}/{col}/{row}?channels=` | Image pyramid tile (WebP) |
| `GET` | `/api/sessions/{id}/image/{element}/info` | Pyramid levels, tile size, `pixel_to_world` |
| `POST` | `/api/sessions/{id}/snapshot` | Save a snapshot (writes `.sview.json` + `.html`); returns `{status,name,url,html}` |
| `GET` | `/api/snapshots` | List saved snapshots (`checkpoint_name`, `schema_version`, `html`, …) |
| `GET`/`HEAD` | `/snapshots/{name}` | Serve a snapshot's `.sview.json`, `.html`, or sibling `.zarr.zip` (Range) |
| `GET`/`HEAD` | `/api/checkpoints/{name}` | Serve a saved checkpoint `.zarr.zip` for direct browser reads (Range) |
| `POST` | `/api/cirro/upload` | Upload selected checkpoints + snapshots to Cirro (session-independent) |
| `GET` | `/api/about/licenses` | Third-party licenses (from SBOMs) |

### 19.2 SSE event types

All events for a client arrive over a **single multiplexed SSE stream** (`/api/events`),
each tagged by `session_id`, with a monotonic id so a reconnecting client resumes via
`Last-Event-ID`. An idle stream emits a comment-line **heartbeat** (`: keepalive`, every
15 s) so a fronting reverse proxy or cloud load balancer (e.g. an AWS ALB, default 60 s
idle timeout) does not silently drop the connection — without it a deployed client stops
receiving updates until a reload, even though local dev (no load balancer) works fine.

**Polling fallback.** Some deployments front the app with a proxy that rejects the SSE
`text/event-stream` content type outright (a JSON-only auth gateway responds 406) or
buffers the stream, so SSE never delivers. `GET /api/events/poll?after=<id>` returns the
same events off the in-memory ring as `application/json` (`{last_id, events}`), which such
a proxy passes through; the client replays them through the identical event handlers,
seeding its cursor from `last_id`. The endpoint is **lock-free** — it reads the event
ring, never a session lock — so it stays responsive while a compute job holds the write
lock. The client switches to it only when the browser reports the `EventSource` fatally
closed (a 406 does not auto-reconnect), so SSE remains the path wherever it works.

| Event | Payload | Consumer effect |
|---|---|---|
| `job.queued` / `job.started` | jobId (+ descriptor) | Update queue list / mark RUNNING |
| `job.completed` | jobId, structural_diff | Refetch changed fields; invalidate dependents |
| `job.failed` | jobId | Surface the error; keep the row for inspect/remove; offer log |
| `job.log` | jobId, chunk | Append to the job's live-log buffer (read bootstrap only) so the import UI streams the reader's log; dropped on completion |
| `plot.drawn` / `plot.invalidated` | plotId(s) | Enable figure / flag for redraw |
| `display.updated` | displayId, spec | Re-derive canvas |
| `region.updated` | regions | Refresh annotations panel + coloring |
| `session.loading` | load_id, message, pct?, log?, done?, status?, hash_check?, error? | Show live progress in the New Session load overlay (routed by client nonce); a `log` chunk is the reader's live output, appended below the milestone message; the terminal `done` event (`status:"ready"|"errored"`) finalizes the overlay — toast `hash_check` and open the session, or show `error` for a retry |
| `session.created` | sessionId (child) | Add to lineage |
| `session.removed` | sessionId, reason | Prune from list; if it was active and reason≠subset, clear the view |
| `resource.sample` | global + per-session RSS, CPU | Update resource strip |
| `memory.warning` | threshold breached | Block dequeue; warn |

---

## 20. Frontend layout and stack

```
┌───────────────────────────────────────────────────────────────┐
│ [logo]  New · Save · Theme · About · Cirro                [⚙ ▾]│
├──────────────┬──────────────────────────────────────────────────┤
│ Sidebar      │  Main area                                       │
│ 4 tabs:      │   default: deck.gl spatial canvas                │
│  Compute     │     (image + points; controls)                   │
│  Plots       │   or data inspector (Tables view)                │
│  Annot.      │   selected item: detail MODAL over                │
│  Subset      │     the current view (form/status)                │
├──────────────┴──────────────────────────────────────────────────┤
│  Resource strip: ▓▓▓▓░░ RAM 62% (this session 1.8 GB) · CPU …    │
└───────────────────────────────────────────────────────────────┘
```

- **Left sidebar — four peer tabs in two classes:**
  - **Operation-log tabs** (**Compute**, **Plots**) — a shared history list (name +
    status badge + timestamp + hover-delete); selecting an item opens its detail in a
    **modal** over the current view (form, params, status, log, **Edit & rerun**,
    Redraw for plots). Footer: **Run all pending (N)**, **+ Add function**, **Browse
    recipes**, **Load recipe**, **Export recipe**.
  - **Canvas-workflow tabs** (**Annotations**, **Subsetting**) — keep the main area on
    the canvas and **the active tab sets the canvas selection mode**: Annotations → a
    drawn selection labels cells into the active region set; Subsetting → a drawn
    selection arms a fork. The Subsetting tab's contents are the **session lineage
    tree** (residency badges, per-node delete, New session…), not a list of subset ops.
    An on-canvas hint shows the current draw mode.
- **Status badges:** PENDING (dashed draft badge), QUEUED, RUNNING (spinner + elapsed),
  COMPLETED/DRAWN, FAILED (error glyph + log), INVALIDATED (stale + Redraw). The activity
  badge counts staged · queued · running.
- **Header:** New/Save session (icon buttons), theme toggle (light/dark via CSS
  variables, persisted in `localStorage`), About (Acknowledgements), Cirro upload
  (only when configured). The gear dropdown holds remaining global ops.
- **Forms:** the introspection layer emits JSON Schema; `forms/FunctionForm.tsx` renders
  with react-hook-form + a custom widget map (obs-key picker, var-name search/multiselect,
  layer/obsm/obsp pickers, enum dropdowns, `obs_value_map` old→new editor) driven by the
  `x-binding` hints (§4.4).
- **Stack:** React + TS, Tailwind, Radix, deck.gl. Vite build; a single-image Docker
  build serves the SPA behind an nginx edge.

---

## 21. Cross-cutting invariants (enforced in code)

1. No module imports or names any specific `squidpy`/`scanpy` function. The registry is
   the only path to a function.
2. The Term Dictionary defines parameter *terms*, never functions.
3. One schema-of-record drives the form + Pydantic validation.
4. Every function returns the result envelope (§4.7).
5. Redraw exists only on plotting items; a compute item can never go COMPLETED→QUEUED;
   rerun appends a new (PENDING) step.
6. Rendered figures are never written to `attrs` or Zarr.
7. App state is written only to `sdata.attrs["app_state"]`, never to a table `uns`.
8. Display `viewport` is default-camera only; live camera is client-local, never
   broadcast.
9. Every job validates its references at dequeue time, not at enqueue time.
10. A child session's `attrs` are deep-copied; its compute history starts empty.
11. State-changing ops (compute, annotate, subset, save) are queued jobs under the write
    lock; region annotation and subset are queued mutating jobs.
12. The per-worker memory ceiling and the boundary-admission check are always active; the
    ceiling is set below the container limit so the catchable `MemoryError` fires before
    the cgroup OOM killer.
13. uvicorn runs exactly one worker; sessions are never spread across worker processes.
14. Snapshots are read-only and share point coloring with the live canvas; assets are
    content-hashed.
15. Dependencies are permissive or explicitly adjudicated (§25).

---

## 22. Development governance: skills & rules

To keep the structure solid as the catalog grows, the repo ships a
governance layer (`sds-governance/`) with **two deliberately separate parts**:

- **Rules** — invariants enforced by CI, a lint, or a startup assertion, independent of
  whether anyone followed a skill. A rule that depends on memory is not a rule.
- **Skills** — independently-triggerable playbooks for each class of change, each ending
  by satisfying named rules.

Principle: **skills make the green path obvious; the gate makes the red path
unmergeable.**

Contents: `AGENTS.md` (prime directives), `RULES.md` (the R1–R16 catalog, each citing its
origin and enforcement check), `Makefile` (`make check` → `static` + `tests` +
`licenses`), `skills/<name>/SKILL.md` (playbooks: `add-library-function`,
`add-custom-function`, `extend-term-dictionary`, `add-official-recipe`,
`release-readiness`, …), `checks/` (the executable gate:
`check_import_graph.py`, `lint_term_dictionary.py`, `lint_function_folders.py`,
`scan_licenses.py`, `test_invariants.py`, `test_contracts.py`), plus `sbom.json` /
`sbom_frontend.json` and `license_allowlist.yaml`.

The **contract smoke test** runs every registered function against a synthetic
SpatialData fixture and asserts the envelope, and that plotting calls produce a figure
without mutating. Functions whose smoke inputs can't be synthesized are **visible skips**, not
silent passes. The **license gate** reads installed package metadata, fails on
torch/scvi or un-adjudicated copyleft, and emits a CycloneDX SBOM; `license_allowlist.yaml`
records the resolved clustering-GPL posture (§25): the copyleft chain was removed, so the
gate now fails if `leidenalg`/`igraph` reappear. Checks **skip** until their
seam is wired, so the gate is adoptable incrementally.

---

## 23. Deployment and process orchestration

Everything ships as **one Docker image** run on a single machine. The single-process,
in-RAM session model is what makes process failure costly, so resilience is first-class.

### 23.1 Single-image composition

Multi-stage build: (1) node builds the React/TS SPA to static assets; (2) python runtime
+ `squidpy`/`scanpy`/`spatialdata` + backend, copying in the built assets. Runtime
processes inside the container:

```
PID 1: tini                      # signal forwarding + zombie reaping
  └─ supervisor (supervisord)    # restarts children, ordered start/stop
       ├─ edge (nginx)           # serves static SPA; reverse-proxies /api,/api/events
       └─ uvicorn (--workers 1)  # FastAPI backend; per-session worker threads inside
```

**SSE requires response buffering disabled** on the edge (`proxy_buffering off`) or
events stall. Any load balancer *in front of* this edge (e.g. an AWS ALB terminating
ECS traffic) must also not buffer the stream; its idle timeout is survived by the
15 s stream heartbeat (§19.2), not by proxy config. The edge stays up while uvicorn
restarts, so the SPA can render a "reconnecting" state instead of a dead page.

### 23.2 Single worker is mandatory (and is the single point of failure)

uvicorn runs **exactly one worker process**. Sessions live in that process's RAM and are
shared across users; multiple workers would each hold separate, inconsistent state.
Concurrency comes from the async event loop plus per-session worker threads. The
corollary: this one process is a single point of failure.

### 23.3 Failure taxonomy & recovery

- **Job-level (common):** bad params, exceptions, `MemoryError` from the ceiling.
  Contained — caught, job → `FAILED`, log captured, process unaffected.
- **Process-level (rare):** native segfault, cgroup OOM kill, unhandled fatal error.
  Kills uvicorn and all in-memory sessions. Supervisor auto-restarts uvicorn (registry
  rebuilds on boot, cheap); the frontend `EventSource` auto-reconnects and re-syncs from
  REST. Outer ring: if the supervisor/PID 1 dies, the deployment system restarts the
  container.
- **Crash recovery:** a hard crash recovers only **explicitly-saved** projects by
  default; graceful shutdown checkpoints sessions to a mounted volume (so planned
  restarts lose nothing). Optional auto-checkpoint (per-step or interval) trades
  serialization cost for durability to the last checkpoint. Checkpoints/saves MUST live
  on a mounted volume.
- **Graceful shutdown** on `SIGTERM`: stop dequeuing, finish/abandon the in-flight job,
  flush each session to its checkpoint volume, close SSE cleanly. The stop-timeout must
  be generous — large datasets flush slowly.

### 23.4 Memory ceiling, health, config, residual risk

- Set the per-worker ceiling **strictly below the container cgroup limit** so the app
  raises a catchable `MemoryError` before the OOM killer fires. Admission checks evaluate
  against the container limit, which is **auto-detected from the cgroup** (v2 `memory.max`,
  then v1 `memory.limit_in_bytes`) when `SDS_CONTAINER_MEM_MB` is unset — so an ECS task or
  `docker run --memory` needs no separate env var — and falls back to the host's total
  physical RAM when the container has no memory hard-limit (a soft `memoryReservation`, or a
  bare `docker run`), so admission tracks what the container may actually use rather than a
  stale 8 GiB default (8192 MiB only if physical memory can't be read).
- **Liveness** `/api/healthz` / **readiness** `/api/readyz`. The container
  `HEALTHCHECK` probes `/api/readyz` so it reports healthy only once the operation
  registry has built and requests will succeed; the start period covers that build
  window. A rare GIL-blocking pure-Python job could delay either probe — use a
  generous timeout and tolerate several consecutive misses; do **not** configure
  aggressive single-miss kills.
- **Config (env):** container memory limit, per-worker ceiling, max concurrent sessions,
  checkpoint policy, liveness tuning, edge SSE buffering, Cirro credentials.
- **Accepted residual risk:** with one container per box, a native segfault takes down
  all co-resident sessions until restart. Mitigated by fast supervised restart + the
  checkpoint policy (the primary durability lever), not eliminated. A max-concurrent-
  sessions cap bounds blast radius and memory contention.

---

## 24. Concurrency and threading model

The hard constraint is the in-place mutation model: an object being mutated cannot be
safely read concurrently. But a compute mutates the *live* object only when it commits —
the call itself runs in a subprocess on a pickled copy (§4.6), so the live object is
untouched for the whole (possibly minutes-long) compute and only the brief commit needs
exclusivity. Everything below maximizes parallelism *around* that narrow window.

1. **Cross-session parallelism (full):** sessions own independent objects, so their
   worker threads run truly in parallel for the GIL-releasing numerical work that
   dominates `squidpy`/`scanpy`. Unrestricted except by the global thread budget (§24.3).
2. **Per-session read/write lock** (`RWLock`), held only for the commit: the worker runs
   the compute lock-free (the subprocess holds the copy) and takes the **write** lock
   only for the brief commit phase — applying the child's changed facets
   back onto the live object, or adopting a returned object (`session._run_call`).
   Arrow/tile/table serving and plotting are shared **readers**, so they serve the
   last-committed object *throughout* a running job instead of stalling on it — the
   "one-operation-stale" read (the picture as of the job's start), reconciled when the
   client's `job.completed` handler refetches. A read still acquires the lock with a
   `READ_LOCK_TIMEOUT_S` bound (`_read_locked`): a read that lands during the brief commit
   gives up with a retryable **503** the client re-issues with backoff (`fetchWhenIdle`)
   rather than block past a fronting proxy's origin timeout — but that window is now
   sub-second, not the whole compute.
3. **Within-job parallelism + global thread budget:** `n_jobs` is surfaced as a form
   field; a process-wide thread budget (a global semaphore capping concurrent compute
   jobs + per-job `OMP_NUM_THREADS`/`OPENBLAS_NUM_THREADS`/`NUMBA_NUM_THREADS`) prevents
   oversubscription across sessions.
4. **Non-blocking event loop:** Arrow serialization, sparse-matrix encoding, zarr I/O,
   tile generation, and matplotlib rendering run in a thread-pool executor
   (`run_in_executor`), never inline in the request coroutine.
5. **Save, subset, annotate as queued operations:** operations that need a consistent
   view of the object are enqueued as **special queue jobs** rather than run off async
   endpoints, serializing them against compute using the existing queue.
6. **Extracts run off the serial queue (read lane):** an extract reads a value out of the
   object (e.g. `sc.get.*`) and writes nothing back, so it needn't sit behind a running
   compute in the FIFO. An eligible extract (`Function.read_lane`; adata-only) is dispatched
   to a shared thread pool (`_run_read_lane`), which takes a **shallow snapshot** of the
   active table under a brief read lock — independent containers sharing the underlying
   arrays, so it stays consistent under later `m[k]=v` commits — then runs the call in the
   compute pool with no lock held. (The snapshot is required because loky pickles pool args
   asynchronously on a feeder thread, so a read lock can't cover the pickle of the *live*
   object; a private snapshot can.) **Plots stay on the lock-blocked mutation path**, not
   the read lane: a plot caches `uns['<col>_colors']` on the live table, so it goes through
   the serial worker where that write is applied and persisted — it therefore blocks behind
   any queued compute and renders the up-to-date object (at the cost of waiting for it).
7. **Honest limits:** the GIL still serializes any pure-Python hot loop; running jobs are
   not interruptible; within-session *mutation* is serial by design (concurrent mutation
   of one object is unsafe and is not attempted); an extract in the read lane reads the
   committed state as of its snapshot, so it can be one operation stale.

---

## 25. Licensing & third-party compliance

Applies to the whole application. The architecture violates no dependency license, but
distribution (the Docker image counts as distribution) carries obligations. **This is an
engineering checklist, not legal advice; the GPL derivative-work question should be
confirmed with counsel.**

- **Posture:** the core stack is **permissive** — squidpy, scanpy, anndata, spatialdata,
  numpy, scipy, pandas, scikit-learn (BSD-3), matplotlib (BSD-compatible), the frontend
  (React, deck.gl, Tailwind, Radix — MIT), Apache Arrow (Apache-2.0). The
  cell-segmentation display adds only permissive deps: `geoarrow-pyarrow`
  (+ `geoarrow-c`/`geoarrow-types`, Apache-2.0) on the backend and
  `@geoarrow/deck.gl-layers` (+ `@deck.gl/geo-layers`, `@deck.gl/aggregation-layers`,
  `@math.gl/polygon`, `@geoarrow/geoarrow-js`, `threads` — MIT) on the frontend, all
  covered by `allowed_licenses` in `license_allowlist.yaml` with no per-package
  adjudication. The app may remain proprietary and be distributed without releasing app
  source; the baseline obligation is attribution.
- **Baseline obligations:** bundle a `THIRD_PARTY_LICENSES` (surfaced in the in-app
  **About / Acknowledgements** view via `GET /api/about/licenses` from the SBOMs);
  preserve Apache-2.0 `NOTICE` files; respect the BSD-3 non-endorsement clause.
- **GPL exposure — clustering (resolved, GPL removed):** Leiden/Louvain via scanpy
  pull GPL deps (`python-igraph`, `leidenalg`, `louvain`). These were removed: Leiden
  clustering now runs on `graspologic-native` (MIT, the Rust core `graspologic` wraps),
  exposed as `custom.leiden` and used by the region-from-clustering path; `sc.tl.leiden`
  and `sc.tl.louvain` are no longer offered (Louvain is dropped — Leiden supersedes it).
  `celltypist` hard-depends on `leidenalg`, so the Docker/dev install strips
  `leidenalg`+`igraph` after `uv pip install` and the annotate path over-clusters with
  graspologic instead; the license gate fails if the GPL packages reappear.
  `clustering_decision_todo` is now `false`. Do **not** bundle napari/Qt
  (GPL/commercial, unneeded). **scvi-tools is excluded**, so there is no torch/CUDA
  footprint or added copyleft surface.
- **Pre-distribution checklist:** run `pip-licenses` + `license-checker` over the
  fully-resolved trees; generate an SBOM (the license gate emits CycloneDX); adjudicate
  every GPL/LGPL/AGPL/MPL/CC-NC license; check bundled example datasets for their own
  data-licensing terms; for wide distribution, have counsel review the SBOM. Re-run on
  every dependency upgrade (a transitive license can change between versions).

---

## 26. Known risks / pin early

- **SpatialData incremental Zarr write API** has moved across versions. Pin the exact
  element-level write calls used for save/checkpoint.
- **`get_type_hints` on `squidpy`/`scanpy`** may raise on forward refs / optional deps —
  wrap per-function and fall back to raw `signature` annotations.
- **deck.gl continuous colormaps** typically need a layer extension or shader for
  per-point application; budget for this.
- **Arrow JS + sparse `obsp`** — serialize sparse matrices (CSR triplets in Arrow) rather
  than densifying graphs for transport.
- **Process-pool squidpy paths** (`gr.spatial_autocorr`/`sepal` with `n_perms`,
  `spatial_scatter` needing `uns['spatial']`) fail on the worker thread — recipes avoid
  them; prefer analytic scores.
- **GIL blocking** from a rare pure-Python path can stall SSE; if observed, move only that
  worker to a process — keep the data resolver in-process.

---

## 27. Critique log (edge cases, limitations, dispositions)

A structured adversarial pass over the design. Each item is tagged **Resolved**
(designed away, with location), **Accepted** (irreducible given a stated constraint), or
**Deferred**.

### Data model & introspection
- **Non-serializable params** (callables, arrays). JSON-Schema forms emit only
  serializable values; a param whose type can't be coerced is flagged at registry build
  and locked to its default (or the function hidden). **Resolved** (§4.2/4.4).
- **Multiple tables / elements** — pickers and injection are ambiguous. Injection fills
  every session-typed slot and shows a selector when multiple candidates exist; pickers
  resolve against the chosen/active table. **Resolved** (§4.6).
- **Variadic signatures** (`*args`/`**kwargs`) can't be form-generated. Marked partially
  supported. **Accepted** (rare).
- **Functions that always return a copy** despite pinned `copy=False`. The compute
  handler adopts a returned data object as the session object. **Resolved** (§4.6).

### Execution & memory
- **Cancelling a RUNNING job** is impossible to do safely. Cancel limited to QUEUED;
  watchdog warns. **Accepted** (§6.1, §24.6).
- **A hung/infinite job** blocks its session's queue. Watchdog surfaces it; per-session
  queue means it stalls only that session. **Accepted**.
- **Failed bootstrap read** → empty session. Marked `errored`, offered retry/disposal.
  **Resolved** (§6.1).
- **RSS overcounts** freed-but-unreturned memory, risking false blocks. `gc.collect()` +
  `malloc_trim` after large jobs; RSS is deliberately conservative. **Accepted**.
- **Collaborative stale assumptions** — A's queued job assumed state B's earlier job
  changed. Validate-on-dequeue catches it. **Resolved** (§6.2) / **Accepted** (inherent
  to a shared FIFO queue).

### Concurrency
- **Read/write races** between async data serving and an in-place mutation. Per-session
  read/write lock. **Resolved** (§24.2).
- **Reader starvation / UI blocking** under a long writer. Client defers refetch to
  completion and shows `STALE`; a mid-compute read fast-fails with a retryable 503
  (`READ_LOCK_TIMEOUT_S`) instead of hanging past a fronting proxy's origin timeout
  (a 504). **Resolved** (§9.8, §24.2).
- **Checkpoint load blocking the POST past the proxy timeout** — a large (multi-GB Xenium)
  `.zarr.zip` load ran synchronously inside `POST /api/sessions`, so its tens-of-seconds
  unzip/read/re-tile blew past the fronting proxy's ~30 s origin timeout and returned a 504
  even though the backend was still working. The load now runs as the session's first
  worker job (`Session._run_load`), so the POST returns a `loading` shell at once and the
  client follows `session.loading` to completion. **Resolved** (§17).
- **Thread oversubscription** across sessions. Global thread budget + per-job thread-count
  env. **Resolved** (§24.3).
- **matplotlib pyplot global state** across concurrent plot jobs. Process-global plotting
  lock + Agg. **Resolved** (§4.6).
- **Save/annotate/subset racing a mutation.** Enqueued as queue jobs. **Resolved**
  (§24.5).

### Transport, displays, persistence
- **SSE connection-cap exhaustion.** Single multiplexed stream + HTTP/2. **Resolved**
  (§19.2).
- **Re-downloading large fields** on view change. Client cache keyed by `(session, field,
  data_version)`. **Resolved** (§9.6).
- **Display references a removed/renamed field.** `MISSING` layer state with a prompt.
  **Resolved** (§9.8).
- **Palette instability** when a category set changes. Palette keyed by category value.
  **Resolved** (§9.6).
- **`.zarr.zip` write-once / slow** for huge data. Incremental `.zarr` directory store for
  checkpoints. **Resolved** (§18).
- **App-state schema drift.** Versioned migration on load; newer-than-app read-only.
  **Resolved** (§3.2, §18).
- **Continuous colormap over millions of points** must be GPU-side. Shader/extension.
  **Resolved** (§9.2, §26).
- **Sparse `obsp` transport** must not densify. CSR triplets in Arrow. **Resolved** (§26).

### Lasso subset & regions
- **Polygon coordinate-system mismatch.** Vertices taken in the display's declared
  coordinate system and passed as `target_coordinate_system`. **Resolved** (§8).
- **Empty selection** → zero-observation child. Refused with a warning. **Resolved** (§8).
- **Multiple disjoint regions.** Union as a shapely `MultiPolygon`; per-polygon fallback.
  **Resolved** (§8, §10.2).
- **Region annotation replays meaninglessly on another dataset.** Annotations are excluded
  from recipes; replication re-defines region sets under the same key names. **Resolved**
  (§12.5).
- **Single-section region comparison has no replication.** Effect-size-first UI, p-values
  labeled exploratory. **Accepted** (§11).

### Residual accepted risks (irreducible under stated constraints)
- **Native-crash blast radius**, **running-job non-interruptibility**, **compute
  memory-peak unpredictability**, **single-process SPOF**, **registry reflects installed
  libraries at boot (restart to upgrade)**, **no pre-save intermediate states**. All
  **Accepted** — each tied to a constraint the design was given (one box, single process,
  in-place mutation, direct data path, huge datasets). Mitigations are documented in the
  relevant sections; none is a fixable design defect.

---

## 28. Offline computation (headless CLI + Nextflow)

The same analysis engine runs headless, for batch/pipeline use with no server or
browser. The design principle is **reuse, not a parallel implementation**: reading,
compute, plot capture, and saving all go through the identical code paths the
interactive server drives, so an offline recipe run produces the same object and the
same figures as running those steps in the UI.

### 28.1 CLI (`backend/cli.py`)

A single-shot runner: parse an input dataset, apply a recipe, write an output folder.

```
python cli.py --parser <reader|zarr> --input <path> --recipe <file|name> --output <dir>
```

- **Parser** — `--parser` selects how the input is read, reusing the app's parsing
  functions: a read-effect registry entry named by key (`io.xenium`) or bare function
  name (`xenium`) drives `SessionManager.create_from_read` (§17); the sentinels
  `zarr`/`spatialdata` load an existing `.zarr`/`.zarr.zip` via `create_from_load`
  (§18) — the headless equivalent of the New Session "load" path.
- **Recipe** — `--recipe` is a recipe JSON file (the §12.1 bundle format) or a bundled
  recipe name; its `steps` are enqueued through `Session.enqueue_descriptor` exactly as
  the UI's "Run recipe" does, and completion is awaited per step (validate-on-dequeue,
  §6.2, still applies).
- **Output** — the resulting `SpatialData` + app state is written with
  `persistence.store.save_spatialdata` to `<output>/<name>.zarr.zip` (reloadable in the
  app), and every plot step's captured `figure_svg`/`figure_pdf` (§4.6, held in
  `Session.plot_figures`) is written to `<output>/plots/<NN>_<namespace>.<function>/
  figure.{svg,pdf}`.
- **Boundary reconciliation** — the server's data-root allowlist and
  `within_data_dir` save guard (§16, §19) exist for the shared multi-tenant
  server. The CLI owns its own paths, so it sets `SDS_DATA_DIR` (the input's parent)
  from its arguments *before* importing `config`, lifts the memory/session admission
  caps (single-shot, single-tenant), and saves by calling `save_spatialdata` directly
  rather than through the guarded save job. A step failure aborts the run non-zero with
  the captured log (fail-fast batch semantics), rather than the UI's keep-in-history
  model. `backend/test_cli.py` exercises the whole path on `visium_hne`.

### 28.2 Nextflow workflow (`nextflow/`)

`nextflow/main.nf` wraps the CLI in one process, exposing the CLI's parameters
(`parser`, `input`, `recipe`, `outdir`, `name`, `reader_params`). Its container is a
**public `uv` image**: the pinned Python dependencies (`backend/requirements.txt`) are
installed at **runtime** with `uv` into a venv, and the `backend/` tree is mounted in —
so there is **no custom image to build**. The output folder is published via
`publishDir`. A `test` profile runs the bundled neighborhood-enrichment recipe against
`test-data/visium_hne.zarr` in `zarr` mode. Python 3.11 is required (squidpy does not
support 3.13+).
