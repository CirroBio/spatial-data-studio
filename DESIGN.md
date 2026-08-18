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
- Reproducing a figure from its pixels. The call descriptor is the record of how a plot
  was made; the rendered copy a checkpoint carries (§7.2) is there to be *looked at*,
  and is always redrawable from the descriptor.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser (React/TS)                                                │
│  ┌────────────┐  ┌──────────────────────────────────────────┐    │
│  │ Left        │  │ Main area                                │    │
│  │ sidebar     │  │  - deck.gl canvas                        │    │
│  │ (4 tabs:    │  │  - call detail docks beside the sidebar  │    │
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
│  │ (cgroup/RSS)  │                                                │
│  └──────────────┘                                                 │
└─────────────────────────────┬─────────────────────────────────────┘
                              │ read / write
                              ▼
                   Local folders + SpatialData .zarr / .zarr.zip
                   + snapshots (rendered PDF/PNG figures) + Cirro (optional)
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
| Resource monitoring | cgroup `memory.stat` where containerized, else `psutil` RSS | Heavy allocations live in numpy/numba/C (`tracemalloc` would miss them) and in compute-pool child processes (process RSS would miss those) |
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
                    "show_channel_legend": true, "show_minimap": true,  // overview inset (§9.11)
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
  under `registry/custom/_vendor/`, vendored as-is except where a step is replaced
  by an app-shared one (`cn_compute.py` clusters window compositions with the
  Leiden core in `custom/_leiden.py` rather than k-means) — the wrapper adapts the
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
context (per-job log capture, key-set snapshot for the structural diff), invokes the
callable, and handles the effect by class:

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
- The call descriptor is what makes a plot reproducible, and version drift
  non-destructive: if a `pl` signature changes and a stored call no longer validates,
  redraw goes `FAILED` and the data is untouched.
- A **drawn** plot's rendered figure (SVG + PDF + PNG) is saved into the checkpoint
  alongside the descriptor — `viewer/figures/<plot_id>/<fmt>` (§14.1) — so a reloaded or
  shared file *shows* its plots instead of holding a list of promises. The save dialog
  lists each figure with its size and can drop any of them; whatever the file doesn't
  carry reloads `invalidated`, exactly as before, and redraws on demand. An
  `invalidated` figure is never saved: its bytes no longer match the data, which is the
  whole meaning of the status.
- Plot detail view shows: the rendered figure, the generated form (editable params),
  status, log, an **Edit & rerun**, a **Redraw**, and an **Expand** button.
- The **Plots** view (main pane, next to Spatial/Embeddings) is a thumbnail grid of the
  session's figures; clicking one opens a fullscreen carousel (arrow keys step, Esc
  closes). Both work in the serverless viewer, which reads the figures out of the file.
- Export: user downloads the figure as **SVG, PDF or PNG** from the detail view or the
  carousel.

---

## 8. Lasso subset → child session

The flagship subsetting interaction. Implemented as an app-defined operation, recorded
as the child's immutable base — **not** as a compute-history step.

### 8.1 Flow

1. With the **Subsetting** tab active, the canvas selection mode arms a fork.
2. User draws box / lasso / circle via editable-layers, producing polygon vertices in
   the canvas' world space (§9.3). Multiple regions allowed (union).
3. Once the region is **finished** (committed, no partially-drawn ring open), the user
   clicks either **"Only keep cells in region"** or **"Remove cells in region."**
4. Frontend POSTs the polygon vertices, in canvas world coordinates, to the backend,
   with `invert:true` for the remove-in-region variant.
5. Backend maps the vertices into a coordinate system (`imaging.world_to_system`, §9.3),
   builds a `shapely` polygon and calls `spatialdata.polygon_query(sdata, polygon,
   target_coordinate_system=...)`. For `invert`, it queries the complement (the object's
   padded extent box, in that same system, with the selection cut out), keeping cells
   outside.
6. A **new child session** is created from the query result.

### 8.2 Backend notes

- **Embedding-view selection.** Region labeling and subset are also available from the
  embedding canvas. Its lasso lives in embedding space (2D) or, in 3D, screen space —
  neither is a spatial coordinate system, so `polygon_query` doesn't apply. The frontend
  resolves the enclosed cells to **table-row indices** (2D point-in-polygon on the obsm
  coords; 3D projects each cell through the live camera and tests the screen-space ring —
  so it catches every cell *visible* within the region) and sends `cell_indices` instead
  of `polygons`. Labeling then masks obs directly; subset filters the table by the mask
  and matches the linked elements with `spatialdata.match_sdata_to_table` (a table with no
  linked elements becomes a table-only child). `invert` keeps the complement of the mask.
- **World space is not a coordinate system.** The rings arrive in the space the canvas
  plots — `obsm["spatial"]` — while `polygon_query` resolves them against a coordinate
  system the store's elements declare, and the two need not coincide: Xenium spots are
  microns while its 'global' is image pixels. `imaging.world_to_system` returns both the
  system to query in and the world→system affine to push the rings through, from the
  same reconciliation that places the image (§9.3). Neither may be assumed: there is no
  system named 'global' on a Visium store (spatialdata-io names them after the dataset),
  and `SpatialData.coordinate_systems` comes off a `set`, so its order is hash-random and
  must never be indexed into — systems are tried most-populated first (the fullest one
  crops without dropping elements), best overlay wins.
- `polygon_query` selects elements that **intersect** the polygon; `bounding_box_query`
  selects by **center containment**. Use `polygon_query` for lasso/freeform. So a crop
  keeps a cell whose *footprint* meets the ring, i.e. slightly more than the centroid
  count the panel's `n=` shows.
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
| `boundary_style` | `filled` \| `outline` | cell-boundary overlay style (§9.10); `filled` is default, `outline` strokes the boundary only |
| `boundary_line_width` | number (pixels) | outline stroke width when `boundary_style: outline`; defaults to 1 |
| `invert_x` / `invert_y` | bool | Spatial-only; mirror the plot horizontally / vertically (camera-level, see §9.2) |
| `background` | `light` \| `dark` | Spatial-only per-plot backdrop, independent of the app theme; defaults to `dark` |
| `show_minimap` | bool | Spatial-only overview inset (§9.11); defaults on |

On load, default specs are generated from the object's structure: a spatial canvas, plus
an embedding canvas as soon as the table carries an embedding — `X_umap`/`X_tsne`/
`X_diffmap` in preference to the PCA they were built from. Only the missing specs are
added, so a later pass tops the set up rather than duplicating it — the offline CLI makes
one after its recipes, since a reader's table has no embedding when the session is built.
A checkpoint that still arrives without an embedding canvas can only get one from the
empty-state authoring form, where the host decides what persisting it means: a live
session PUTs it, a serverless checkpoint keeps it in the browser for that visit alone.
Writing the spec into the store is therefore what makes the view open by itself.

**Color by** first picks a slot (`obs`, `X` gene expression, or a `layer`) then the
column within it: obs columns from a dropdown, genes from a type-to-search box backed by `GET
/api/sessions/{id}/var-names?q=&limit=` (matches found server-side, prefix hits first),
so datasets with tens of thousands of genes stay responsive.

### 9.2 deck.gl layer mapping

- Cell centroids → `ScatterplotLayer` with **binary attributes** (position Float32Array
  from Arrow; color from a category-index + palette, or continuous value + colormap).
- Cell boundaries → the points + boundary overlay segmentation display (§9.10).
- Tissue image → `BitmapLayer`(s) fed from the multiscale pyramid (§9.3).
- Selection → editable-layers overlay (Polygon/Path/Scatterplot draw modes).

**Orientation + backdrop (Spatial only).** `invert_x`/`invert_y` and `background` are
applied at the camera, not per layer: `FlipOrthographicView` (a thin mirror of deck's
`OrthographicViewport` adding an `flipX` term to the view-matrix scale, alongside the
native `flipY`) flips the whole scene — points, image, and annotations together — so
picking, `info.coordinate`, pan, and fit stay consistent with no layer/coordinate changes.
The backdrop paints the canvas container behind the transparent deck canvas (its two
values match the light/dark `--color-bg`, but the plot backdrop is a display setting in
its own right — it never follows the app theme, and defaults to `dark`). `invert_x`/
`invert_y`/`background` live in the display `encoding`, so a rendered snapshot (§14)
reproduces the plot's orientation and backdrop — the matplotlib renderer flips its axes
and sets the figure facecolor the same way, with the same `dark` default.

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
them — searching every *coordinate system* the image maps into, and within each the
element transform that best overlays spots onto the image — so points and image line up,
and rotated/aligned images (e.g. an H&E) are placed as quadrilaterals. The system search
is not optional: a store need not declare a `global` system at all. spatialdata-io's
Visium and Visium HD readers name theirs `<dataset_id>` and give each downscaled image
its own `<dataset_id>_downscaled_hires`/`_lowres`, so asking for `global` by name left a
Visium H&E at identity — drawn at `tissue_hires_scalef` of its true size in the corner of
the spots. The same reconciliation answers the inverse question for spatial queries:
`world_to_system` returns the coordinate system to run a `polygon_query` in and the
affine that maps world coordinates into it (§8.2), so a lasso crops the region the user
drew rather than one scaled by whatever the store's transforms say.

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
per-session cache store under `WORK_DIR` (the system temp dir by default, a tmpfs
mount in Docker so the cache is held in RAM — see §23.4); the live elements are
rebound to lazy refs into it. An in-memory rechunk alone can't fix this — a small tile read
still fetches the large *store* chunk from disk — so the rewrite is the point.
After it, one tile realizes one ~2 MB chunk. Each element's rebuild runs in the
**compute pool** (§24.7) rather than the API process — re-reading and re-encoding a
multi-GB raster is exactly the sustained CPU that must not hold the API's GIL, or one
user opening a checkpoint stalls every other viewer's canvas for the length of the
rebuild. Elements are rebuilt one at a time and freed between (writing all four Xenium
rasters together peaks ~8.8 GB); with a small dask pool
(`SDS_RASTER_REBUILD_WORKERS`, now spent in the worker) the peak is the largest single
image (~2.1 GB for the 3.8 GB morphology). Images get a mean-downsampled pyramid; labels
are rebuilt **single-scale, tile-chunked only** — they aren't LOD-rendered, and a
nearest/mode downsample of integer IDs can't stream (it materializes the whole
array plus every level at once, ~6 GB for a 1.9 GB label), so a pure lazy rechunk
is both correct and cheap. Being already tile-chunked isn't by itself enough to skip
an image: a `.zarr.zip`/`.zarr.tar.gz` checkpoint is extracted into `WORK_DIR` before
loading (so its rasters are already local), but a bare `.zarr` directory is read in
place — possibly a slow network/object-store mount — so an image that's canonically
shaped but not yet known to live under `WORK_DIR` is rebuilt too (a rechunk-free
copy, since the shape is already right), converting what would otherwise be a live
slow read on every tile request into a one-time load-time cost. `normalize_rasters`
takes the session's own `raster_stores` map from its previous call (`known_stores`)
to remember which images it already resolved, so this locality check — and any
rebuild it forces — only ever happens once per element per session: idempotent for
reload (a store already under `WORK_DIR` is a no-op) and for a reshaping compute that
adopts a new object carrying the same already-normalized refs forward. Element
coordinate transforms are preserved so §9.3 reconciliation still holds, and because
the rebound in-memory elements are tile-chunked, `save` (§13) inherits the tile
chunking too. The cache dir shares the `extract_dir` lifecycle — cleaned on close,
ownership transferred to a subset child (§8.3).

Two-tier memory safety for rendering: image compositing is capped by a global
semaphore (`SDS_IMAGE_RENDER_CONCURRENCY`), and a render requested once RSS is past
`SDS_ADMISSION_PCT` returns 503 so a burst can't push an already-loaded container
over the OS memory limit (§11.3). The `create_from_read` path is likewise refused
at that boundary, since a raw reader input has no cheap size estimate.

### 9.4 Image channel controls

Which raster is drawn is itself a control: the **Image** tab lists the object's image
elements (`fields.images`) and writes the pick to `image_layer`, with **None** for no
image at all. Switching elements clears `channels` — that map is keyed by channel index,
which means nothing across images — and turns `show_image` back on, and the canvas
re-frames, since its coordinate space is the chosen image's pixel space (§9.3).

Per image channel: **toggle visibility**, **rename** (display-only name overriding raw
channel labels), and assign one of 8 canonical spectrum colors. Channels are composited
by additively blending each channel's percentile-normalized intensity tinted with its
color. State lives in the display spec, so it persists to `.zarr.zip`, is restored on
load, and is captured in snapshots (§14). A togglable legend overlays a swatch + label
for every visible channel.

**Client-side (Viv) compositing — the only canvas image path.** The browser composites the
image on the **GPU** with Viv's own `MultiscaleImageLayer`: it reads the session's normalized
raster **Zarr v3** store directly — zarrita over a byte-range route
`GET /api/sessions/{id}/raster/{element}/{key}` (Range/HEAD) — and blends channels additively
on black, with per-channel color and contrast as shader uniforms, so contrast/color/visibility
edits are instant with no server round-trip. An RGB/H&E image is composited the same way, its
three channels just defaulting to red/green/blue (so the additive blend reproduces true color)
and keeping black opaque (`is_rgb` skips the transparent-black extension, since black is real
data); those channels are editable like any other, not a fixed passthrough. The
server advertises the store per image in `/image/{element}/info` (`client_compositing`), true
whenever `SDS_CLIENT_IMAGE_COMPOSITING` (**default on**) is set and `normalize_rasters` (§9.3)
registered a served store for the element — which it does for every image (a freshly rebuilt
store, or `sdata.path` for a canonical-and-local one; §9.3). There is **no server-composited
canvas fallback**; disabling the flag turns the canvas image off entirely.

**At most 6 channels at once.** Viv composites up to 6 channels in one shader pass, so the
channel picker caps *visible* channels at 6: a >6-channel image shows a user-chosen subset
(toggle which ≤6 to display, plus per-channel rename, **any** color via a native color input
alongside the preset palette, and an independent **contrast min/max** window). Names, colors,
and per-channel `contrast_limits` (`[min,max]`) live in the display spec, so they persist to
`.zarr.zip`, restore on load, and are captured in snapshots (§14). The contrast sliders span
`/image/info`'s `contrast_range` (per-channel data min/max) and default to `contrast_limits`;
an unset per-channel `contrast_limits` means "use the server default". The frontend sends only
the visible channels' selections (and their effective contrast) to Viv.

The Spatial display-settings panel is organised into three icon tabs — **View** (layer
visibility, axis inversion, the minimap toggle, zoom, and the Fit-to-data /
Edit-points-transform actions), **Cells** (render mode, point size/geometry, boundary style, color-by, legend,
opacity), and **Image** (the light/dark plot backdrop, channel legend + the per-channel
picker above; always present, since the backdrop applies with or without an image
element) — rendered with the same `PanelTabs` component as the left sidebar's tabs
(one-word labels, sidebar-style icons, collapsing to icon-only when unselected).

**Image-pixel coordinate space.** When a display has an image, the canvas's `OrthographicView`
works in that image's own level-0 pixel space, so `MultiscaleImageLayer` sits at its native
extent `[0,0,W,H]` with no modelMatrix and deck.gl's `TileLayer` selects/streams pyramid tiles
natively (the case Viv is built for) — keeping the best-available coarser tile visible and
dropping it as finer tiles arrive, so loading sharpens in place with no bespoke coarse-base
bookkeeping. The cell points and every other world-space overlay (shapes, lasso, regions)
instead carry a `world→pixel` modelMatrix (`imageAffine.worldToPixelAffine` — the inverse of
`pixel_to_world`), and picked/drawn coordinates are mapped back to world at capture, so the
stored geometry and the backend contract stay in world coordinates. Point radii (world units)
are rescaled by `1/affineScale` into the pixel frame. A display with no image stays in world
space (identity). On a slow/remote store the coarse tiles show until finer ones arrive; the
mitigation is a RAM-backed `WORK_DIR` (§23.4), not a second compositing path.

**Tile-streaming smoothness.** `useVivImageLayer` forwards two deck.gl `TileLayer` props
through Viv (`MultiscaleImageLayerBase extends TileLayer`, and Viv passes `this.props`
straight down): a `maxCacheSize` derived from a fixed memory budget (`TILE_CACHE_BUDGET_BYTES`,
256 MB — divided by the actual per-tile footprint `tileSize² · bytesPerSample · activeChannels`,
floored at 64 tiles) instead of deck's default of 5× the visible tiles, so zooming/panning
back over a level just visited is a cache hit rather than a re-fetch (verified: descending to
a finer pyramid level never re-requested the coarser level's tiles, and returning to it issued
no new requests); and a `debounceTime` (`TILE_REQUEST_DEBOUNCE_MS`, 150 ms) that collapses the
tile requests fired for every pyramid level a continuous zoom/pan sweeps through into one
request at the settled viewport. Bounding the cache by *count* is unsafe here (a tile holds one
array per active channel, so a fixed count swings ~6× with channel count) and `maxCacheByteSize`
is unusable — Viv's tile content is a plain object with no `byteLength`, which deck logs as an
error and mismeasures — hence the budget-derived count. It also sets `refinementStrategy`
explicitly: `best-available` for opaque RGB (a coarse ancestor tile stays visible while the
finer one loads — it just overpaints), but `no-overlap` for fluorescence. Fluorescence tiles
are semi-transparent (transparentBlackExtension maps black→alpha 0 and channels composite
additively), so under `best-available` an ancestor and its finer tile briefly overlapping
during a zoom *sum* — the tile flashes lighter, then settles darker once the ancestor drops.
`no-overlap` never draws overlapping levels, so the flash is gone; the coarse base ImageLayer
still fills not-yet-loaded regions, so nothing blanks. (Viv makes exactly this choice, but keys
it on its `opacity` prop, which is always 1 here — the tiles' transparency comes from the
extension, not `opacity` — so we key it on `isRgb` instead.)

**Tile placement (`renderTileSubLayers`).** `useVivImageLayer` replaces Viv's default
`renderSubLayers`, which places any tile whose fetched data is smaller than `tileSize` — the
right column and bottom row at *every* pyramid level — at the full level-0 extent (`width`/
`height`). That is only correct for an exactly-halving pyramid; ours floor-halves (§9.3 builds
it with `scale_factors=[2]*n`, and spatialdata's downsample trims the odd pixel per step), so
level *k* spans `size_k · 2**k`, up to `2**k - 1` px short of the base. The stretch therefore
over-scaled those tiles by a level-dependent amount, so a feature landed at a slightly
different x/y depending on which level was drawn and the image visibly *shifted* as tiles
streamed in (measured on a 34,155 × 13,770 Xenium: 11 px at level 5, 10 px at level 4, ~1 px at
level 1, plus a third position from the coarse background `ImageLayer`, which is short but
correctly scaled). Placing every tile at its true footprint (`data size · 2**level`) equals
deck's own bbox for full tiles and fixes the partial ones at every level; the cost is that the
few-pixel sliver the coarse levels genuinely don't cover stays unpainted until a finer level
loads, instead of being smeared over.

**Idle look-ahead prefetch (`useImageTilePrefetch`).** deck's `TileLayer` only ever requests
the current viewport, so the first frames of a zoom/pan stall while the newly needed tiles
fetch. Once the camera has been still for `PREFETCH_SETTLE_MS`, this hook warms the tiles a
gesture is about to need — the next finer pyramid level over the viewport (a zoom-in) and a
one-tile ring at the current level (a pan) — by calling the same `loader[level].getTile` deck
will call. The decoded result is discarded; the point is the browser HTTP-cache entry, which
the raster route (`Cache-Control: no-cache` + weak ETag) serves back to deck's real request as
a cheap 304 revalidation rather than a full chunk download — biggest win on slow/remote stores.
The level a zoom-in will load is `-ceil(zoom)` clamped to `[-(levels-1), 0]` (deck's own
`getTileIndices` math for a non-geospatial `OrthographicView`), so the finer level to warm is
that minus one. It runs in a camera-keyed effect (never the layer memo, so the image layer is
never rebuilt), aborts in flight the instant the camera moves again, skips tiles already warmed
(a bounded LRU set, reset when the store URL changes), caps tile positions per pass, and — since
each position expands to one fetch per channel and these bypass deck's own `maxRequests` throttle
— drains them at most `PREFETCH_CONCURRENCY` in flight, so a multi-channel image can't flood the
browser's request pool (`ERR_INSUFFICIENT_RESOURCES`). This also softens the level-transition
"pop": the finer level is already resident when the switch happens, so it sharpens in place
immediately instead of after a network round-trip.

A server-composited WebP **thumbnail** endpoint (`/image/{element}/thumbnail`) remains, used
only by the DataInspector element preview — not by the canvas. See `docs/CONTRACT.md` for the
info/route schemas.

The `raster_store` route reads one compressed chunk file per browser request, so a
pan back over already-seen tiles would re-read each chunk under the session read lock.
A byte-budgeted server-side LRU of raw chunk bytes (`SDS_RASTER_CHUNK_CACHE_MB`, default
256; `imaging._raster_chunk_cache`) caps that repeat cost. It is keyed by `(id(sdata),
element, key)` so it is evicted on the same object-adoption/close boundary as the tile
cache (`evict_caches`); the bytes live in the API-process heap, so they count against RSS
and the admission budget like any other resident memory.

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
colors. Individual levels can be overridden from the **Cells** tab; the override map is
persisted in the encoding as `category_colors` (keyed by `color_by` path, then by
category value → `#rrggbb`) and honored by both the live canvas and snapshot export.

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
alone) vs `points+shapes` (scatter plus the cell-boundary overlay). The legacy value
`shapes` maps to `points+shapes`.

- **Point scatter (always on).** The instanced `MarkerScatterplotLayer` (size slider +
  circle/square/hexagon glyph) covers every zoom, including the zoomed-out and
  shapes-loading regimes, so the canvas never blanks. Overlapping glyphs **merge**, not
  blend: a two-pass fragment-depth trick writes `gl_FragDepth` so the nearest centroid
  wins each pixel — touching same-color cells read as one contiguous region and overlaps
  don't darken at opacity < 1 (this replaced the separate nearest-cell "field" layer).
- **Cell-boundary overlay (`render_mode: points+shapes`).** When the session has boundary
  polygons, their real outlines stack on top of the points, from a `GeoArrowPolygonLayer`
  fed by viewport-clipped GeoArrow fetched from `GET
  /api/sessions/{id}/shapes/{element}/geoarrow?bbox=…` (`usePolygonBbox.ts`, LRU-cached per
  viewport bbox + data_version). A **Boundary style** control (`boundary_style`, default
  `filled`) chooses between filling each polygon with the per-cell color and drawing only
  its boundary stroke at `boundary_line_width` screen pixels (`outline`); either way the
  color is the same per-cell stack as the points, so the overlap is seamless and the points
  fill the gaps between cells. The composite layer's fill sublayer triangulates on the main
  thread (`_subLayerProps.fill.earcutWorkerUrl = null`) so nothing is fetched from a CDN.
- **The fetch gate.** The overlay fetch fires only once a cell is a few pixels across —
  `zoom ≥ shapesFetchZoomThreshold(meanSpacing) = log2(6 / meanSpacing)`
  (`useCanvasViewState.ts`; `meanSpacing = estimateMeanSpacing(positions) ≈ √(bbox_area/n)`).
  Below that the viewport would hold more cells than the backend ships anyway, so the
  fetch is deferred and the points are the whole view. When a bbox is over the ship cap the
  backend returns a 0-row table, which `usePolygonBbox` reports as *no layer* — the points
  simply keep covering the view (no dead "blank band").

Geometry is served in the same world space `/data/obsm:spatial` uses (the region element's
points→global affine), so outlines, points, and image overlay; the GeoArrow polygons carry
a `cell_index` back to the active table for color gather. See
`docs/CONTRACT.md` for the payload schemas.

**Known follow-up:** `@geoarrow/deck.gl-layers` (0.3.2) logs a console deprecation — it
is renamed to `@geoarrow/deck.gl-geoarrow` (0.4.x). Not migrated: 0.3.2 is the verified
working version, and 0.4.x may drift the API and needs re-testing.

### 9.11 Minimap (overview inset)

`Minimap.tsx`, top-left of the spatial canvas, toggled by `show_minimap` (**View** tab,
default on): a thumbnail of the whole section with a white rectangle marking the window
the main view is showing, so a zoomed-in view keeps its context.

- **Coordinate space.** The canvas' own — the image's level-0 pixel extent when the
  display has an image, else the cell bounds in world space. The window rectangle is
  `target ± (canvasSize/2)/2**zoom`, the same relation §14 uses for a snapshot's framing.
  The view is y-up (deck's `flipY` is off unless `invert_y`), so the inset maps a content
  `y` to a CSS `y` from the bottom and mirrors itself with `invert_x`/`invert_y`.
- **What's in it.** The whole-image composite from `GET
  /api/sessions/{id}/image/{element}/thumbnail?channels=&max_px=` (the coarsest pyramid
  level, tinted with the visible channels' colors — contrast overrides don't reach it),
  or, with no image (or the image hidden), a strided cell scatter drawn to a 2D canvas in
  the same per-cell colors as the points.
- **Navigation.** Click or drag anywhere in the inset to move the main view's target
  there; the drag end persists the viewport like any other camera change.
- **In snapshots.** The figure renderer can draw the same inset — opt-in per render
  (`include_minimap`), see §14.

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
   In the same write-locked mutation it also points every display's `color_by` at the
   region set and seeds the picked color as that category's `category_colors` override
   (honored by both the spatial and embedding canvases) — so the labelled cells
   immediately render in the chosen color without the user re-selecting the column or
   re-picking in the legend controls. Doing this server-side (rather than as a follow-up
   display PUT) guarantees the color-by switch can't outrun a freshly created obs column.

An **Annotate region** checkbox (spatial canvas only — shape annotations are tissue
coordinates) additionally persists the drawn region *as geometry*: one filled-outline
polygon shape annotation per ring plus a text annotation of the category label at the
region's centroid (its world-space fontSize scaled to the region's extent). Unlike the
label itself, these are ordinary shape annotations in `sdata.shapes["annotations"]`.

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
directly through the data inspector and the element/table APIs. The agent loop
itself was later realized differently — as the MCP assistant surface (§29), where
the agent pulls state through tools instead of being fed a manifest.

---

## 14. Snapshots

A snapshot is a **rendered figure** of a display — a high-quality vector PDF and/or
raster PNG — produced server-side with matplotlib (`backend/app/snapshots.py`). It is a
standalone artifact the user downloads, not a re-openable view: there is no read-only
session, no pinned view, and no live re-render. The figure reproduces the display as it
looked on the canvas at the chosen framing.

- **What's rendered:** the microscopy image (when shown) is rasterized as an image
  layer, composited the same way the live canvas composites channels (per-channel
  color + `[min,max]` contrast window; RGB passthrough for H&E). Cell **points** are
  emitted as **vector** markers (circle/square/hexagon), colored by the same
  deterministic palette (categorical: 15-color CB-friendly palette over the sorted
  categories) / colormap (numeric: viridis over the data range) the frontend uses —
  the palette/LUT are ported into `snapshots.py`, so a figure matches the canvas
  without the client shipping a per-cell color buffer. When the display is in
  `render_mode` `points+shapes` and zoomed in past the same gate the canvas applies
  (`SHAPES_MIN_CELL_PX` cell diameter, and a `POLYGON_LIMIT` cells-in-view cap), the
  point markers are **replaced** by the actual cell-boundary polygons — the
  viewport-clipped world-space geometry from `transport/geometry.clipped_polygons`
  (shared with the GeoArrow endpoint), drawn as **vector** paths, filled or stroked per
  `boundary_style`/`boundary_line_width` and colored per cell — so a segmentation view
  snapshots as outlines, not circles. Below the gate (or over the cell cap) it falls
  back to the point scatter, exactly as the canvas does. Above `POINT_VECTOR_CAP`
  features in view the point/polygon layer is rasterized too, to keep the PDF small and
  fast to open (recorded in the metadata when it happens).
- **Coordinate regime:** with an image the figure is drawn in level-0 pixel space
  (points mapped world→pixel via `imaging.pixel_to_world`, the image at identity),
  matching the live canvas; otherwise pure world/spot space. `invert_x`/`invert_y`
  flip the axes as in the live `FlipOrthographicView`, and `background` sets the
  figure backdrop.
- **Framing + output come from the request; styling from the display:** the render
  request carries only `{viewport:{target,zoom}, width_px, height_px, dpi, formats}`
  (+ optional `label`/`display_id`/`include_minimap`). Everything visual — channels,
  colors, contrast, color-by, point size, marker, render mode — is read from the
  display's persisted `encoding`. The window is `target ± (output_px/2)/2**zoom`.
- **Minimap inset (opt-in per render):** `include_minimap` draws the §9.11 overview in
  the figure's top-left corner — the composited whole image (or the strided cell scatter
  when no image is shown) with a white rectangle marking the rendered window, axes
  flipped like the main axes. It is a *render* option, not an encoding one, so a figure
  can carry the inset whether or not the live canvas is showing one; the export modal
  seeds its checkbox from the canvas and `render.minimap` records what was drawn.
- **Files:** a set of siblings under `DATA_DIR` sharing a `<base>` name:
  `<base>.figure.pdf`/`.png` (the chosen deliverables), `<base>.figure.thumb.png`
  (gallery thumbnail), and `<base>.figure.json` (the provenance sidecar the gallery
  lists from). Both spatial and embedding displays can be snapshotted.
- **Embedded provenance:** dataset, viewport, output settings, the full display
  encoding, and the analysis recipe (completed compute steps) are embedded in every
  output file — PDF `/Info` (`Keywords` carries the JSON) and PNG `tEXt`
  (`sds-snapshot`) — as well as the sidecar. This is the "how it was generated"
  record; the figure needs no checkpoint to be reproducible-by-description.
- **Endpoints:** `POST /api/sessions/{id}/snapshot` (render + save →
  `{status, name, formats, rasterized_points}`), `POST …/snapshot/preview` (low-res
  PNG for the export modal), `GET /api/snapshots` (gallery list),
  `GET /api/snapshots/{name}/file?fmt=pdf|png`, `GET …/thumbnail`,
  `DELETE /api/snapshots/{name}`.
- **Invocation:** **Save snapshot** (settings panel) opens the export modal
  (`SnapshotExportModal`) seeded with the live viewport — the user sets zoom, output
  size, DPI, format(s), and (spatial) whether to include the minimap inset, against a
  live server-rendered preview. **Browse
  snapshots** opens the gallery (`SnapshotBrowser`): a thumbnail grid with a detail
  panel for download/delete and the embedded provenance.

### 14.1 Checkpoint on-disk format

See [docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md) for the field-level
reference (every attrs key, its type, and the JSON Schema that enforces it) — this
section is the design rationale, that document is what a third party building a
different reader/writer needs. Every app-defined structure below (`app_state`, the
`viewer/` sidecar, the `X_csc` mirror, `index.json`) has a JSON Schema under
`backend/app/schemas/checkpoint/`, validated on every write, so a checkpoint this
app produces is always conformant to that document.

The checkpoint format is shared by saves, snapshots, and Cirro uploads —
`.zarr.zip` (Zarr v3 + consolidated metadata, `ZIP_STORED`), write-dir-then-zip /
unzip-then-read (`backend/app/persistence/store.py`). Worker logs are relocated out
of `attrs["app_state"]` (inlined into the store's root `zarr.json`, downloaded in
full on open) into gzipped `logs/<record_id>.log.gz`, read back lazily by
`session.get_log` (the `/jobs/{id}/log` endpoint).

A checkpoint is **directly readable by a browser** over HTTP Range, with no backend
(§14.2). `ZIP_STORED` is what makes that possible — a zarr chunk, and equally a shape
parquet, is a contiguous byte span — and four write-time steps in
`_write_browser_reader_support` serve it. The first three are what the serverless viewer
needs to exist at all, not an optimization: a checkpoint written before them is rejected
on open (§14.2), because a Zarr v3 store carries no child index and the reader could not
even name the table.

- **`_shard_rasters`** rewrites image/label arrays with the Zarr v3 sharding codec
  (inner chunk `_SHARD_INNER` 512, shard `_SHARD_SIZE` 4096), region-by-region so
  peak memory is one shard rather than a whole multi-GB level. The inner chunk stays
  **one channel** (`(1, 512, 512)`), matching what `rasters.normalize_rasters` writes
  (§9.3): Viv requests tiles per channel, and a multi-channel inner chunk would
  decode every channel to serve one. Sharding is about the *zip central directory* —
  the browser downloads it in full before the first tile, and an unsharded Xenium s0
  puts tens of thousands of entries in it. On the Visium test checkpoint it took the
  image from 2172 entries to 22, and slightly *reduced* total size.
- **`_index_shapes`** rewrites each polygonal `shapes/<el>/shapes.parquet` as
  spatially indexed GeoParquet 1.1, so the browser can range-read a viewport's
  boundaries. spatialdata writes them with a bare `to_parquet()`: WKB geometry, snappy,
  **one row group**, rows in reader order. Parquet's statistics on a WKB binary column
  are lexicographic over the bytes and so spatially meaningless, and one row group
  leaves nothing to prune — the only way to draw the few hundred boundaries on screen
  was to download all of them. The fix is three ordinary GeoParquet features: a
  **Hilbert sort** on centroids (without which the other two are decoration — every
  row group's bbox would approximate the full extent), a **`covering` bbox column**
  whose FLOAT64 members get real per-row-group statistics, and **small row groups**
  (`_row_group_rows`: `n/256` clamped to `[4096, 65536]`, bounding the footer the
  browser pays on every query while keeping row groups thick enough to be worth a
  request) with zstd (~30% off snappy on real boundary geometry). It costs no disk —
  the indexed file is *smaller* — and stays a plain GeoParquet: `read_parquet`
  recognizes `covering` and drops the column, so the backend reads the element back
  unchanged. The sort does reorder rows, which is safe because every shape->table
  linkage is by index label, never position (`geometry.cell_index`). Point/circle
  shapes are skipped (drawn as scatter, not outlines) and so is `annotations`, whose
  row order is what the annotation list shows. Idempotent, so the incremental path can
  re-run it — which is also how a checkpoint saved before the index gets one.
- **`_write_viewer_sidecar`** writes a top-level `viewer/` group (not a SpatialData
  element — `sd.read_zarr` ignores unknown root groups) holding what the browser
  can't cheaply derive: the per-image manifest from `imaging.image_info`, keyed
  `[element][table_key]` because `pixel_to_world` reconciles the image against a
  table's spots; `coords_transform`, the points->global affine `GET /data/obsm:spatial`
  applies; `tables/<key>/X_csc`, a gene-major mirror of a sparse `X`; and the
  `shapes` report — per element, its geometry kinds, row/row-group counts, intrinsic
  bounds, `file_bytes`/`footer_bytes` and measured selectivity — plus a
  `shapes/<el>/<table>/cell_index` int32 array per element. The report lets the reader
  plan a boundary query entirely from consolidated metadata: reject an element the
  viewport misses without a request, and size the footer fetch exactly instead of
  speculating. `cell_index` is baked for the same reason the CSC mirror is: the
  shape->obs mapping is by label, so deriving it in JS would mean downloading the
  element's whole label column and the table's whole `obs` index to align two
  orderings.
  The CSC mirror is the one place this trades disk for latency: it duplicates `X`
  (+66 MB on the 372 MB Visium checkpoint), but without it coloring by one gene means
  downloading the whole CSR `data`+`indices` pair — worse exactly when the table is
  large. Its chunk length is sized from the data (`_csc_chunk`) so one gene column
  lands in one or two chunks whether a gene holds hundreds of non-zeros (Visium) or
  hundreds of thousands (Xenium). The same group carries the **rendered plot figures**
  (`_write_figures`): `viewer/figures/<plot_id>/<fmt>`, one uint8 array per format
  written as a single chunk, so a reader fetches a figure in one range read and gets the
  store's zstd for free (an SVG scatter compresses several-fold). The group is rebuilt
  from scratch on every save — the caller passes the complete set it wants in the file —
  so a deselected, deleted or invalidated plot leaves nothing behind. Byte lengths ride
  in the `figures` attr beside the format list, which is what lets a session report its
  whole figure index (and the save dialog size its rows) from one small read.
- **`_consolidate`** re-runs consolidated metadata **last**, so the tree the browser
  reads reports the sharded codec (or zarrita would decode the pre-shard layout) and
  lists `viewer/`. The incremental path (`update_checkpoint`) refreshes the sidecar
  and re-consolidates too, limiting the CSC rebuild to the dirty tables. That path
  rewrites the store the live session reads its own figures through, so before pruning it
  the session pulls anything it is about to lose into memory (`_hold_dropped_figures`):
  deselecting a figure changes the file, never what the open session can still show.

Order matters between them: the shape index runs before the sidecar, which publishes
its report, and consolidation runs last.

### 14.2 Serverless viewer

Opening the SPA with `?checkpoint=<url>` reads a `.zarr.zip` directly and renders it
with no backend at all — the same bundle, the same canvas, the same display controls.
This is one app with two data sources, not a second viewer:
`packages/viewer/src/data/types.ts` defines a `DataSource` interface over the render
path (`getFieldData`, `getImageInfo`, `openImageLoader`, `getShapesGeoArrow`,
`getElements`, `searchVarNames`, `imageThumbnailUrl`, `getPlotFigure`), implemented by
`frontend/src/data/apiSource.ts` (live session) and the library's `checkpointSource`
(zarrita over `ZipFileStore`). The handful of hooks that used to
call `api.ts` directly — `useArrowField`, `useVivImageLayer`, `usePolygonBbox`,
`VarNameSelect`, `SpatialCanvas` — read the source from `DataSourceProvider` instead.
Everything downstream (palettes, point styling, channel shaders, legends, minimap,
invert axes, backdrop) already worked off plain typed arrays and is untouched.

Details that make it work:

- `checkpointSource` materializes the **same Arrow schemas** `transport/arrow.py`
  emits, so `useArrowPositions` and `arrowToColorSource` consume either source
  unchanged.
- `RangeGetReader` never issues a HEAD. Cirro serves checkpoints as method-specific
  presigned S3 GET URLs which reject HEAD with 403, so zarrita's built-in
  `HTTPRangeReader` would abort the open before reading a chunk; the total length
  comes from the `Content-Range` of a one-byte GET.
- The image is Viv's own `loadOmeZarrFromStore` over a prefix view of the zip store,
  so the native `MultiscaleImageLayer` path (§9.4) — tiling, cache budget, prefetch,
  channel shader uniforms — is shared verbatim.
- Consolidated metadata makes every `zarr.open` a memory lookup and is what supplies
  the group listing that `SessionFields` (the obs/obsm pickers) is derived from;
  Zarr v3 stores carry no child index.
- Saved plot figures come through the same interface: the sidecar's `figures` attr is
  handed to the synthetic session as `SessionState.figures` — the shape the live route
  returns — and `getPlotFigure` reads `viewer/figures/<plot_id>/<fmt>` as a blob. The
  Plots grid, the fullscreen carousel and the figure exports are therefore the same
  components in both modes, and a plot the file carries no figure for reads
  "No saved figure" rather than offering a redraw that has no backend to run it.
- **Boundaries** (`packages/viewer/src/data/parquetShapes.ts`) are the one thing not
  read through zarrita: the shape file is GeoParquet, so the reader treats it as a
  plain zip entry and drives `hyparquet` over a `ZipFileStore.getRange`-backed
  `AsyncBuffer`. A viewport is answered in increasing order of cost — reject on the
  sidecar's `bounds` (no request); parse the footer once per element, sized exactly
  from `footer_bytes`; prune row groups against the `covering` statistics (free, the
  footer already holds them); read only the surviving row groups' **`bbox` column**
  (~10% of the file's bytes) and test each row exactly; only then read `geometry` for
  those row groups and decode just the hit rows. Reading `bbox` before `geometry` is
  what makes the `POLYGON_LIMIT` gate cheap — a zoomed-out viewport is rejected having
  moved the covering column and nothing else. On a 428k-cell boundary set (55 MB,
  105 row groups) a typical viewport costs ~1 MB in 3–4 requests and an over-limit pan
  ~0.5 MB, against 68 MB for every viewport unindexed.
  A file that resists pruning needs no separate code path: every row group survives,
  the same two passes read it whole, and `MAX_QUERY_DOWNLOAD_BYTES` bounds the result —
  which is the right answer for the small elements where that happens. Requests are
  coalesced at a 128 KiB gap, chosen from the two chunk spacings the writer produces
  (a row group's four `bbox` leaves are contiguous, consecutive `geometry` chunks sit
  ~71 KiB apart, consecutive `bbox` blocks ~478 KiB apart), so it merges the first two
  and never bridges a geometry chunk to join two bbox reads. Decoding goes from WKB
  straight into flat Arrow buffers (`wkbGeoArrow.ts`) rather than via GeoJSON objects,
  and produces byte-identical GeoArrow to what `polygons_geoarrow` serves — separated
  `struct<x, y>` coordinates and an int32 `cell_index` — so `usePolygonBbox` and its
  `GeoArrowPolygonLayer` are shared verbatim. The reader is **code-split**: a parquet
  reader plus a zstd decompressor is ~100 KB gzipped, and only a checkpoint with
  indexed boundaries loads it.
- The checkpoint is presented as a synthetic **read-only session**, so
  `editBlockReason`'s existing `summary.read_only` gate disables compute, regions,
  annotations, subsetting and transform edits with no second notion of "can't write".
  `useSSE`/`useSession`/`usePresence` take an `enabled` flag and stay dormant.

**UI in this mode.** The left sidebar opens collapsed (`leftMenuOpen` defaults off
when `?checkpoint=` is present — `store/sessionStore.ts`) and, when expanded, shows
only the record of the analysis that produced the checkpoint: the compute-history
list with no tab strip and no recipe footer (`Sidebar.tsx`'s serverless branch,
gated on the URL rather than the async data source so the tab strip never flashes
in). Regions, annotations and subsetting are not offered — nothing can run. The **Plots**
view is offered, because the figures are in the file: the same grid and fullscreen
carousel as the backed app, read-only (no redraw).
The browser-only edit plumbing those tabs once used on checkpoints
(`applyLocalRegion`/`setLocalColumn`, `hiddenCells`, `shapesAreLocalOnly`) is still
in the store and `DataSource`, but no UI reaches it in this mode. **Snapshot
export** becomes a canvas PNG capture (`lib/canvasCapture.ts`) — deck.gl 9 keeps
`preserveDrawingBuffer` on, so the backbuffer is readable — and the backend-only
menu entries (new/save session, snapshot gallery) are omitted rather than shown
broken.

### 14.3 Deploying a collection — `index.json`

A serverless deployment is three things in one directory: the built SPA, the
`.zarr.zip` files, and an `index.json` listing them.

```
index.html          the Vite build, unchanged — nothing deployment-specific in it
assets/…
index.json          { "title"?, "checkpoints": [ { "path", "label"?, "description"? } ] }
*.sdata.zarr.zip
```

`index.html` is deliberately boilerplate, so one build serves any collection and a
deployment is a copy plus a manifest. All asset URLs in the build are relative
(Vite `base: './'`), so the directory works hosted at any path prefix, not just
a domain root. `path` resolves against the manifest's own URL,
so entries can name siblings, subfolders, or absolute URLs on another host.

The documentation site's `/viewer/` directory is another instance of exactly this
layout, assembled by `.github/workflows/docs.yml` from the SPA build and the demo
checkpoints in `docs-site/viewer-data/`. That is what lets a docs page iframe a single
checkpoint while the same directory also serves as a browsable collection.

Mode resolution (`App`): `?checkpoint=<url>` opens that file. With no parameter, the
app polls `/api/readyz`; a sibling `index.json` is what distinguishes a static
deployment from a backend that is merely still booting, so it is probed **once** on
the first failed poll — a live app never pays for it, and a slow backend boot doesn't
retry it every tick. A collection with no checkpoint chosen renders
`CheckpointIndexPage` alone (no sidebar, settings panel or resource strip — there is
no session yet). Inside a checkpoint, `CheckpointPicker` replaces `SessionPicker` in
the header. Selecting an entry **navigates** rather than swapping state in place: a
checkpoint carries its own displays, fields and locally-made labels, and a reload is
the one way to guarantee none of the previous one's state leaks into the next — the
bundle is already cached, so it costs a parse, not a download.

A Cirro upload bundle **is** this layout (§15): `cirro._write_viewer_index` writes the
manifest and `_symlink_viewer` colocates the built SPA, so an uploaded set of
checkpoints is a complete, self-hosting deployment rather than just a pile of files.

Cell-boundary overlays work here too, but not through zarrita: `shapes/<name>/shapes.parquet`
is GeoParquet, so `parquetShapes.ts` range-reads it as a plain zip entry with `hyparquet`
(§14.1). `getShapesGeoArrow`/`getElements` stay *optional* on the interface, because a
checkpoint saved before the write-side index exists carries no `covering` column to prune
on — such a file leaves both methods undefined and the Cells layer on its points-only
path, the same fallback as a display with no shapes element.

Not possible without the backend, by construction: compute (squidpy/scanpy/recipes),
real subsetting (`sd.polygon_query`), saving, and the matplotlib vector-PDF snapshot
export.

Display settings are the one thing that does survive a reload, because they ride in the
URL rather than in storage. Whatever differs from the checkpoint's own saved encodings
is written to a `view` parameter (`lib/urlViewState.ts`), so a tuned view is shareable:
the recipient opens the same `?checkpoint=`, reads the identical `app_state` out of the
identical file, and the delta lands them on the same picture — camera included. Only the
delta travels, so a link stays short and a re-saved checkpoint degrades gracefully
(what the user changed still applies, what they didn't follows the new file). The
parameter also carries the UI state that decides what the recipient is looking at:
`ui.view` (which main view), `ui.menu` (sidebar), and `ui.plot` — the id of the plot open
fullscreen, so "look at this figure" is a link. Nothing else local survives: selections,
hidden cells and locally-drawn labels are gone on reload. The parameter is deliberately absent in embed mode, where the host owns display
state over postMessage (docs/EMBED_PROTOCOL.md), and in the backed app, where the
encoding is server-persisted and shared by session id.

---

## 15. Cirro upload

Upload saved checkpoint sessions to [Cirro](https://cirro.bio/) as a dataset
(`backend/app/cirro.py`), under **each user's own Cirro identity**.

- **Auth:** the OAuth **device code** flow, per browser. `POST /api/cirro/auth` with a
  domain starts a flow and returns Cirro's login URL immediately; the user opens it and
  signs in, while a background thread blocks on `DeviceCodeAuth.await_completion()` and
  flips the credential to `connected`. `AppConfig(base_url=<domain>)` discovers the
  OAuth client id, region and auth endpoint, so the domain is the only user input.
  `CIRRO_BASE_URL` only prefills that field — the server holds no Cirro credential of
  its own.
- **A device code dies long before the credential does** (30 minutes at Cirro's end vs
  `IDLE_EXPIRY_S`), so a login URL a user comes back to later is usually dead. Three
  parts make that recoverable rather than a dead end:
  - `Credential.current_state()` reports a pending login past its `login_deadline` as
    **`expired`** — a state of its own, because its remedy is specific (get a new URL for
    the same domain) rather than the "something went wrong" of `failed`. The deadline is
    the flow's own `expiry`, held as a monotonic instant, so a clock change can't age a
    live login. It is *derived*, not written by the polling thread: that thread sleeps
    `interval` (5 s) between checks, and a client asking in between must not be handed a
    URL Cirro no longer honors. `public()` withholds `login_url` outside `pending` for
    the same reason. When the thread does wake past the deadline the SDK gives it a bare
    "Authentication timed out", which it records as `expired` rather than regressing the
    state to `failed`.
  - **Refresh login token** in `CirroConnectDialog` posts the same domain again, which
    starts a fresh flow and *replaces* this browser's credential (`POST` drops the token
    it was called with). There is no separate refresh endpoint — restarting a flow is
    what the POST already does, and it is also the retry path when a login fails. The
    status poll is suspended while that request is in flight, since it carries the
    credential token the restart is about to drop.
  - The dialog **re-reads the auth state as it opens**. The store's copy is loaded at
    startup and only kept fresh by the pending poll, which runs only while the dialog is
    open, so rendering it unchecked is the other way a dead login URL reaches the user.
    Nothing polls in the `expired` state: it only moves when the user asks for a new URL.
- **Credential scoping:** this is a multiuser app, so a credential is keyed by a
  backend-minted secret (`cirro.CredentialStore`, `X-SDS-Cirro-Token`), held in process
  memory and dropped after `IDLE_EXPIRY_S` (8 h) without use. Deliberately **not** keyed
  by the presence `client_id`, which is a plain non-secret localStorage value — anyone
  who learned it could otherwise upload as that user. `enable_cache=False` on
  `DeviceCodeAuth` is load-bearing: the SDK's cache would persist one shared token file
  under `~/.cirro/` for every user of the process. The SDK refreshes its own access
  token; when the *refresh* token expires the credential turns into a 401 that the
  frontend renders as "reconnect".
- **Auth status is polled, not pushed.** The SSE bus is a broadcast to every connected
  client, so publishing a login state carrying a Cirro username would hand one user's
  identity to everyone else's browser. `CirroConnectDialog` polls `GET /api/cirro/auth`
  (token-scoped) while a flow is pending. Upload state has no such problem and rides
  the existing SSE stream + its polling fallback.
- **Flow:** at least one saved session must be selected (a session must be **saved
  first** to appear). `build_upload_folder()` builds a temp folder from **symlinks**:
  each selected `.zarr.zip` under `sessions/`, the `index.json` manifest, and the built
  SPA (`index.html` + `assets/`) — so the uploaded dataset is exactly the serverless
  deployment layout of §14.3 and renders itself. Never symlinks a directory itself
  (most upload walkers skip a symlinked directory's contents) — only real directories
  of per-file symlinks. `upload()` calls the Cirro SDK's `project.upload_dataset`.
- **The viewer rides along only when there is one to bundle.** `viewer_available()`
  tests `SDS_STATIC_DIR/index.html`, which is set in the Docker image but **unset in
  local dev**, where Vite serves the frontend. The upload still works there; it just
  carries the checkpoints and `index.json` alone, and the dialog says so rather than
  shipping a collection that silently won't open.
- **UI:** one sidebar entry that reads "Connect to Cirro" until this browser is signed
  in and "Upload to Cirro" (subtitled with the Cirro username and domain) after, plus a
  "Disconnect from Cirro" entry. While a login is pending the connect dialog shows the
  login URL and a "Refresh login token" action (spinner in place of the URL while the new
  one is being issued); once expired it says so and keeps only that action. The upload dialog lists Cirro projects, a dataset name,
  a description, an optional folder (free-text with typeahead, see below), and saved
  sessions (multi-select). Uploads always use the generic "Files" ingest process
  (`custom_dataset`), so there is no process picker. In-flight uploads survive a
  disconnect.
- **Folder:** Cirro's portal groups datasets into folders via a plain dataset tag whose
  value is `folder://<path>` (nested paths use `/`) — there's no dedicated folder API, so
  `list_folders()` derives the known folder list for a project by scanning
  `datasets.list` tags, same as the portal UI itself does. Cached **per credential**
  (`GET /api/cirro/projects/{id}/folders`) since a full dataset scan is expensive, and
  since two users may see different projects;
  a successful upload with a new folder updates the cache directly instead of forcing a
  rescan. The field is free text with a browser `<datalist>` typeahead, not a plain
  picker — the folder need not already exist.

---

## 16. Sessions, process model, and memory

### 16.1 Session model

- A session = one in-memory `SpatialData` + one queue + one worker thread + its `attrs`
  state.
- Sessions are **shared and fully collaborative to read**. Multiple users may attach;
  all see the same data, queue, history, plots, regions, and display specs, updated in
  real time over SSE. Who may *change* a session is decided by its edit lock (§16.5).
  (Authentication and access control remain the deployment layer's concern.)
- Switching sessions is a client navigation; it does not evict server-side sessions.
  Session navigation lives in the **Subsetting** tab's lineage tree (§20).

### 16.2 Process model — single shared process, per-session worker threads

Chosen over process-per-session because the audit-log decision removed the need to
reconstruct intermediate states (the main argument for process isolation), and because a
shared process keeps the **Arrow→GPU data path direct** (data served from the same
process that holds it — no IPC hop, which matters for high-performance rendering).

- One process; one worker thread per session; the FastAPI event loop stays responsive
  because heavy `squidpy`/`scanpy` work releases the GIL (numpy/numba/C).

### 16.3 Memory accounting and guards

Memory peak is **not predictable** (some functions allocate transient O(n²)
structures). Therefore: **monitor closely, expose live, guard at boundaries.**

- **Monitor:** sample memory on a fixed cadence and push over SSE to the resource strip.
  Show global and per-session resident cost. The sample is taken in a worker thread, not
  inline on the event loop: it is all syscalls, and at this cadence running it inline was
  measurably a periodic hitch in every client's request latency (§24.4).
- **Whose memory:** inside a memory-limited container the reading is the **cgroup's own**
  `anon` + `shmem` (`config.cgroup_mem_usage`), not this process's RSS. The heavy work
  runs in compute-pool workers — each holds a full pickled copy of the table for a job's
  duration, and the largest raster during an ingest re-tile (§9.3) — so process-local RSS
  is blind to it and admission would keep saying yes while the container filled. The
  cgroup charges shared pages (interpreter, libraries) once, whereas summing each
  process's RSS charges them once *per worker*: ~324 MB of mostly-shared RSS per idle
  worker, which across a core-count-sized pool invents gigabytes of pressure that isn't
  there. Reclaimable page cache is excluded — reading a multi-GB checkpoint fills it, but
  the kernel frees it rather than let us be OOM-killed. Outside a cgroup (local dev) it
  falls back to this process's RSS, where the workers stay invisible.
- **RAM-backed working set:** when `WORK_DIR` is a tmpfs mount (`SDS_WORK_DIR_IN_RAM=1`,
  §23.4), the unpacked archives and raster caches living there consume RAM that the
  cgroup/OOM killer counts but process RSS does not. So the boundary/admission math uses
  **effective memory = anonymous memory + WORK_DIR usage** (`manager._effective_mb`). In a
  container that second term is the cgroup's `shmem` — the same quantity measured rather
  than inferred, so it needs neither the flag nor a dedicated mount; outside one it is an
  `os.statvfs` of the mount, and 0 when `WORK_DIR` is on disk. `resource.sample` surfaces
  it as `work_dir_mb`, disjoint from `rss_mb`, and `rss_pct` is the effective fraction the
  boundary gates on.
- **Load-admission control:** before loading a dataset, estimate its **resident** cost
  from Zarr metadata (tables load eagerly and dominate; images/labels are lazy). If it
  won't fit in the effective-memory headroom, block the load.
- **Boundary admission (`ADMISSION_PCT`):** if effective usage is already ≥ the threshold,
  refuse to dequeue the next job (and refuse tile renders) and warn. Admission only gates
  *new* work; an already-running job that spikes is bounded only by the OS hard limit — an
  OOM kill, after which supervisord restarts the backend — not by any in-process cap.

### 16.4 Session death

- Subsetting evicts the parent (§8.3).
- Otherwise sessions are evicted under memory pressure or by explicit close; eviction
  flushes to a Zarr checkpoint first if there is unsaved state, then drops from RAM.

### 16.5 Viewer presence and the per-session edit lock

Every viewer of a session shares one in-memory object and one audit log, and there is no
undo — so two people editing at once is a data-integrity problem, not a merge problem.
The **edit lock** makes exactly one viewer the editor while everyone else watches.
Implemented in `sessions/presence.py` (process memory only; nothing persists to the
checkpoint) and enforced in `deps._claim_lock`, which every mutating route reaches
through `_writable_session`.

**Identity.** No accounts, no auth (that stays the deployment layer's concern). A browser
mints a `client_id` (uuid) and a two-word display name (e.g. *gloomy socrates*) and keeps
both in `localStorage`, so a reload keeps its name *and* its lock. The name is editable
and is what other viewers see; the id is what the lock is keyed on. Both ride every
request as `X-SDS-Client-Id` / the heartbeat body.

**Presence.** Clients `POST /api/presence` every 5 s with their id, name, and the session
they are viewing; a client silent for `PRESENCE_TIMEOUT_S` (20 s, the one knob) drops out
and releases what it held, so a closed tab never strands a session. A
closing tab also sends a parting `session_id: null` beat, which frees its lock at once
rather than after the timeout. The heartbeat returns the whole view (who is viewing what,
who holds each lock); changes are broadcast as `presence.updated`, published only when the
picture actually changes rather than per heartbeat.

**Lock rules.**

- Attaching to a session nobody has locked **takes** its lock — the ordinary single-user
  case is protected with no clicking. Only the attach transition does this, so a
  deliberate unlock is not undone by the holder's next heartbeat; leaving a session
  releases it.
- A mutating request claims the lock the same way, which is what stops two viewers from
  both writing in the window after a deliberate unlock.
- While another viewer holds the lock, every mutating route answers **423 Locked**
  (naming the holder). Read paths are never gated.
- The holder can **unlock**; any viewer can then **take** it. Taking a lock someone else
  holds is refused (409) — handover is deliberate, never a steal.
- A caller with no client id (the offline CLI, the e2e harness, scripts) writes freely
  while nobody holds the lock, and is refused while someone does.

**What a viewer without the lock can still do.** Everything that doesn't touch the
session: pan/zoom, inspect tables, and change any *display* setting (color by, channels,
contrast, render mode, minimap, isolated category). Those edits apply locally and skip the
`PUT /displays` write, so they never enter `app_state`; a session refetch keeps them
(`withLocalDisplays`) instead of snapping the view back to the holder's, and the holder's
`display.updated` broadcasts are ignored for the same reason. The frontend derives one
gate from this (`lib/presence.editBlockReason`) which read-only snapshot sessions share, so
both cases disable the same controls with a reason the user can read. The rule for adding a
control: if its route takes `_writable_session`, it reads the gate — directly via
`useEditGate`, or through whatever already owns its submit (`useRerunEditor` for the detail
views, `FunctionForm`'s `blockedReason` for the picker and recipe forms) — since a live
button whose write comes back 423 is a bug. Hiding the entry point is not enough on its own:
the lock can change hands while a dialog is open. A control acting on a *listed* session rather than the active one (the
session picker's delete) keys off that row's own lock instead.

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
  state blob) — the complete, portable project. Save is enqueued as a **special queue
  job** (§24.5) so it captures a consistent snapshot serialized against in-flight
  compute. Saving blocks the UI behind a spinner; a Stop button cancels it while still
  queued (a save already writing to disk can't be interrupted).
- **Incremental save:** a session loaded from a `.zarr.zip` is unpacked into a writable
  directory store (its `extract_dir`) that backs the live object. Re-saving such a
  session rewrites only the elements that changed since the last save — a changed
  table element (delete its on-disk dir, then `write_element`, since spatialdata 0.7.3
  refuses to overwrite an element inside its own store), an edited coordinate transform
  (`write_transformations`), and always `attrs` (`write_attrs`) — then refreshes the
  `viewer/` sidecar (§14.1) and re-consolidates metadata and re-zips the directory.
  Rasters are Dask-backed from these same files and are never touched at all (no
  reshard pass of any kind — a raster's sharding codec doesn't change once written, so
  an incremental save has nothing to redo there). This is gated on the object still being backed
  by a writable directory store (`can_update_incrementally`); a compute that changes a
  raster or other non-table element, or a fresh import with no backing directory store
  yet, falls back to the full write (`save_spatialdata`). The session tracks which
  elements are dirty (`dirty_tables`, `dirty_transforms`, `force_full`) from each
  mutation's `structural_diff`. Save staging happens next to the destination so the
  final commit is a same-filesystem rename, and the auto-named content hash is
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
| `POST` | `/api/presence` | Viewer heartbeat: id + display name + session being viewed → the presence/lock view (§16.5) |
| `POST`/`DELETE` | `/api/sessions/{id}/lock` | Take / release the session's edit lock (409 if held by another; 403 releasing one you don't hold) |
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
| `POST` | `/api/sessions/{id}/snapshot` | Render + save a snapshot figure (PDF/PNG); returns `{status,name,formats,rasterized_points}` |
| `POST` | `/api/sessions/{id}/snapshot/preview` | Low-res PNG preview of the framing for the export modal |
| `GET` | `/api/snapshots` | List saved snapshot figures (label, kind, output, thumbnail, embedded metadata) |
| `GET` | `/api/snapshots/{name}/file?fmt=pdf\|png` | Download a rendered figure |
| `GET` | `/api/snapshots/{name}/thumbnail` | Gallery thumbnail (PNG) |
| `DELETE` | `/api/snapshots/{name}` | Delete a snapshot and all its sibling artifacts |
| `GET`/`HEAD` | `/api/checkpoints/{name}` | Serve a saved checkpoint `.zarr.zip` for direct browser reads (Range) |
| `POST` | `/api/cirro/auth` | Start this browser's Cirro device-code login; returns the login URL |
| `POST` | `/api/cirro/upload` | Upload selected checkpoints + the viewer to Cirro (session-independent) |
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
| `display.updated` | displayId, spec | Re-derive canvas (ignored by a viewer without the edit lock, whose display settings are local — §16.5) |
| `region.updated` | regions | Refresh annotations panel + coloring |
| `session.loading` | load_id, message, pct?, log?, done?, status?, hash_check?, error? | Show live progress in the New Session load overlay (routed by client nonce); a `log` chunk is the reader's live output, appended below the milestone message; the terminal `done` event (`status:"ready"|"errored"`) finalizes the overlay — toast `hash_check` and open the session, or show `error` for a retry |
| `session.created` | sessionId (child) | Add to lineage |
| `session.removed` | sessionId, reason | Prune from list; if it was active and reason≠subset, clear the view |
| `presence.updated` | per-session `{lock, viewers}` | Update the lock badge + the session list's holder/viewer counts; re-derive the edit gate (§16.5). Published only when the picture changes, not per heartbeat |
| `resource.sample` | global (`rss_mb`, effective `rss_pct`, `work_dir_mb`, `cpu_pct` — memory and CPU both summed over the API process + compute workers, `cpu_count`) + per-session RSS | Update resource strip |
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
│  Annot.      │   selected item: detail PANEL docked              │
│  Subset      │     to the right of the sidebar (form/status)     │
├──────────────┴──────────────────────────────────────────────────┤
│  Resource strip: ▓▓▓▓░░ RAM 62% (this session 1.8 GB) · CPU …    │
└───────────────────────────────────────────────────────────────┘
```

- **Left sidebar — four peer tabs in two classes:**
  - **Operation-log tabs** (**Compute**, **Plots**) — a shared history list (name +
    status badge + timestamp + hover-delete); selecting an item opens its detail in a
    **side panel** docked to the right of the sidebar, pushing the viewer aside (form,
    params, status, log, **Edit & rerun**, Redraw for plots). Footer: **Run all
    pending (N)**, **+ Add function**, **Browse
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
- **Header:** the session switcher (each row showing the session's lock holder and
  viewer count) and, beside it, the **lock badge** — a padlock reading "Locked to you",
  the holder's name, or "Unlocked", which opens the panel that takes/releases the lock,
  lists who is viewing, and edits your own display name (§16.5). The menu holds
  New/Save session, snapshots, the theme toggle (light/dark via CSS variables, persisted
  in `localStorage`), About (Acknowledgements), and Cirro — one entry that connects
  this browser's own Cirro account and then becomes the upload action (§15).
- **Forms:** the introspection layer emits JSON Schema; `forms/FunctionFields.tsx` renders
  the field widgets (react-hook-form + a custom widget map: obs-key picker, var-name
  search/multiselect, layer/obsm/obsp pickers, enum dropdowns, `obs_value_map` old→new
  editor, and — for reader path params — an inline `forms/FsPicker.tsx` filesystem
  picker) driven by the `x-binding` hints (§4.4). `forms/FunctionForm.tsx` wraps those
  fields with the run/stage submit footer (function picker, recipe gallery, re-run
  editor); the New Session dialog embeds the same fields as the reader's full input
  form. Each reader param renders by its `path_kind` (`registry/reader_paths.py`):
  the primary path is a folder/either picker, absolute file params a file picker, and
  relative filename params (counts_file/…) a file picker rooted at the chosen primary
  path that yields a relative name; everything else is a value input.
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
6. Rendered figures are never written to `attrs` or a table's `uns`. The copy a
   checkpoint carries lives in the browser-facing `viewer/figures` group, keyed by plot
   id, and is only ever written for a `drawn` plot.
7. App state is written only to `sdata.attrs["app_state"]`, never to a table `uns`.
8. Display `viewport` is default-camera only; live camera is client-local, never
   broadcast.
9. Every job validates its references at dequeue time, not at enqueue time.
10. A child session's `attrs` are deep-copied; its compute history starts empty.
11. State-changing ops (compute, annotate, subset, save) are queued jobs under the write
    lock; region annotation and subset are queued mutating jobs.
    Every route that starts one goes through `deps._writable_session`, so a frozen
    (read-only) session and a session another viewer has locked (§16.5) are refused at the
    boundary rather than relying on the UI to hide the control.
12. The boundary-admission check is always active: new work is refused once effective
    memory reaches `ADMISSION_PCT` of the container limit. An in-flight spike past that is
    bounded only by the cgroup OOM killer (followed by a supervised restart).
13. uvicorn runs exactly one worker; sessions are never spread across worker processes.
    This is also what makes the edit lock and viewer presence (§16.5) sound: both live in
    process memory, so a second worker would give each its own idea of who holds a lock.
14. Snapshots are rendered figures (vector PDF / raster PNG) that reproduce the live
    canvas server-side, with provenance embedded in every file.
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

### 23.4 Memory limit, health, config, residual risk

- Admission checks evaluate against the container memory limit, which is **auto-detected
  from the cgroup** (v2 `memory.max`,
  then v1 `memory.limit_in_bytes`) when `SDS_CONTAINER_MEM_MB` is unset — so an ECS task or
  `docker run --memory` needs no separate env var — and falls back to the host's total
  physical RAM when the container has no memory hard-limit (a soft `memoryReservation`, or a
  bare `docker run`), so admission tracks what the container may actually use rather than a
  stale 8 GiB default (8192 MiB only if physical memory can't be read).
- **RAM-backed working set (`WORK_DIR`).** The live session working set — the unpacked
  `.zarr.zip` extract dir and the per-session normalized raster caches — lives under
  `WORK_DIR` (`SDS_WORK_DIR`, default the system temp dir). Point it at a tmpfs mount and
  set `SDS_WORK_DIR_IN_RAM=1` to hold that working set in RAM, so tile/chunk reads are
  served from memory instead of disk. tmpfs pages count against the cgroup limit but not
  process RSS, so the admission math adds the current `WORK_DIR` usage to the app's
  anonymous memory — the soft admission boundary therefore trips before the tmpfs can
  grow the container past its hard limit into an OOM kill. In a container that term is
  read straight from the cgroup (`shmem`, §11.3), so it is self-detecting; the
  `SDS_WORK_DIR_IN_RAM=1` flag and the **dedicated**-mount requirement apply only to the
  `os.statvfs` fallback used outside a cgroup. Durable checkpoints/snapshots always stay
  on the real `DATA_DIR` disk; the
  save-staging tempdir stays beside the destination so its commit is a same-filesystem
  rename regardless of `WORK_DIR`. The Docker image ships a `/work` tmpfs enabled by
  `docker-compose.yml`; the `work-tmpfs.sh` entrypoint remounts it to
  `SDS_WORK_TMPFS_PCT` (default 85%) of the memory limit it detects from the cgroup — the
  same limit admission auto-detects — so the tmpfs and the admission budget both scale
  from `mem_limit` with no hardcoded size. That remount needs `CAP_SYS_ADMIN` (compose
  `cap_add`); it fails open to the mount-time `size=` fallback if the capability is
  absent. Keep `SDS_WORK_TMPFS_PCT` above `SDS_ADMISSION_PCT` so the soft admission 503
  trips before the tmpfs ENOSPCs.
- **Liveness** `/api/healthz` / **readiness** `/api/readyz`. The container
  `HEALTHCHECK` probes `/api/readyz` so it reports healthy only once the operation
  registry has built and requests will succeed; the start period covers that build
  window. A rare GIL-blocking pure-Python job could delay either probe — use a
  generous timeout and tolerate several consecutive misses; do **not** configure
  aggressive single-miss kills.
- **Config (env):** container memory limit, max concurrent sessions,
  working-dir location + RAM-backing (`SDS_WORK_DIR` / `SDS_WORK_DIR_IN_RAM`), Viv chunk
  cache size (`SDS_RASTER_CHUNK_CACHE_MB`), checkpoint policy, liveness tuning, edge SSE
  buffering, the default Cirro domain (`CIRRO_BASE_URL`; users supply their own
  credentials from the browser, §15).
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
7. **Ingest raster rebuild runs in the compute pool:** re-tiling a raster (§9.3) is
   minutes of CPU on a large Xenium store, and it used to run in the API process, where
   it held the GIL in bursts long enough to stall every request in flight — one user's
   checkpoint load froze every other viewer's canvas. `rasters._child_rebuild` submits it
   to the same pool the compute call uses. Only the element crosses the boundary, as a
   lazy ref to its backing store (a few hundred kB of dask graph); the rebuilt bytes
   return via the cache store on disk, which the parent reopens lazily. Measured on a
   364 MB checkpoint: time the API spends stalled during someone else's load drops from
   ~1.4 s to ~0.24 s, worst single stall from ~210 ms to ~25 ms.
8. **Honest limits:** the GIL still serializes any pure-Python hot loop; running jobs are
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
- **Polygon coordinate-system mismatch.** Vertices arrive in canvas world space and are
  mapped into a coordinate system (`imaging.world_to_system`) before the query; the
  system is derived, never indexed out of the hash-ordered `coordinate_systems`.
  **Resolved** (§8.2, §9.3).
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
  §6.2, still applies). The flag is **repeatable**: several recipes run back to back in
  one session (one load, one save), so a longer analysis composes the bundled recipes
  rather than restating their steps in a new bundle. `--recipe-params` is shared by all
  of them — each recipe substitutes only the `$param` names it declares.
- **Output** — the resulting `SpatialData` + app state is written with
  `persistence.store.save_spatialdata` to
  `<output>/<name>-<content hash>.sdata.zarr.zip` (reloadable in the app), and every
  plot step's captured `figure_svg`/`figure_pdf` (§4.6, held in
  `Session.plot_figures`) is written to `<output>/plots/<NN>_<namespace>.<function>/
  figure.{svg,pdf}`. These are auto-named checkpoints (`hash_name=True`), so each
  filename embeds the hash of its own contents and a later load reports whether the
  bytes still match it — the same guarantee the app's own saves carry. `--session-name`
  records what the checkpoint calls *itself* (`app_state["name"]`, §7 of
  `docs/CHECKPOINT_FORMAT.md`), which is what reopening it shows however the file is
  named — the seam that lets a batch tree use one fixed filename per dataset folder.
  `--lowres-max-image-mb` writes a second checkpoint, `<name>.lowres` unless
  `--lowres-name` overrides the base, through the same call with an image budget:
  `store.cap_image_levels` builds a view whose multiscale images have lost as many of
  their finest pyramid levels as the budget takes, renumbering the rest from `scale0`.
  Nothing is resampled — each kept level already carries its own transform to the
  coordinate system, so the trimmed pyramid occupies the identical world extent and
  `pixel_to_world` reads the new `scale0` exactly as it read the old one. Since the
  finest level is the bulk of an imaging-based checkpoint, the copy holds the whole
  analysis at a fraction of the size and renders everything but the deepest zoom.
  Labels are left alone: their pyramids are runs of a few integer values and compress
  hard enough that the finest level is a rounding error.
- **Boundary reconciliation** — the server's data-root allowlist and
  `within_data_dir` save guard (§16, §19) exist for the shared multi-tenant
  server. The CLI owns its own paths, so it sets `SDS_DATA_DIR` (the input's parent)
  from its arguments *before* importing `config`, lifts the memory/session admission
  caps (single-shot, single-tenant), and saves by calling `save_spatialdata` directly
  rather than through the guarded save job. `backend/test_cli.py` exercises the whole
  path on `visium_hne`.
- **Step failures** — a step that cannot complete does **not** stop the run: it keeps the
  UI's audit-log model (§6.1), staying in history as `failed` with its captured log while
  the next step runs. This is safe because the call commits nothing — it ran on a pickled
  copy in the compute subprocess (§20.2), so the steps after it see exactly the object the
  last successful step left. The log is printed to stdout *and* relocated into the saved
  checkpoint's `logs/<job_id>.log.gz` like any other, so reopening the output in the app
  shows the failure and its log the way the live session would have. The exit status is
  therefore 0 for any run whose input loaded, however many steps failed, with the failure
  count reported on the last lines of stdout; only a failed read/load is fatal, because
  then there is no object to analyse.

### 28.2 Nextflow workflow (`nextflow/`)

One entrypoint, `nextflow/main.nf`. Given an input location it discovers the spatial
datasets under it, loads each with the reader for its type, runs that type's
preprocessing recipes, and publishes the results in a tree mirroring where they were
found — plus a MultiQC report over the run and a serverless viewer (§14.3) of every
checkpoint. Its container is a **public `uv` image**: the pinned Python dependencies
(`backend/requirements.txt`) are installed at **runtime** into a venv and the `backend/`
tree is staged in, so there is **no custom image to build**. Python 3.11 is required
(squidpy does not support 3.13+).

**All data-type knowledge is data.** `data_types.json` (schema: `data_types.schema.json`)
carries, per type: the glob patterns that recognise a folder of it, the registry key of
its reader, the bundled recipes that preprocess it, an optional instrument summary file
to surface in the report, and whether the recipe has actually been run against real data.
`common_params` declares each analysis knob once, with the recipe parameter names it
fills and the data types whose recipes declare them — so a parameter is exposed once but
applied only where it means something. `main.nf` and `modules/discovery.nf` contain no
per-format branch; adding a format is an edit to the catalog.

- **Discovery** walks the tree through Nextflow's own `file()` API, so a root may be
  local or `s3://`/`gs://`/`az://` with the executor's existing credentials. It is
  greedy — a folder that classifies is a candidate and is not descended into — and when
  several types match, the one whose `detect` block asserted the most wins, which is how
  a Visium HD run resolves without a rule saying so (it also carries a Visium-shaped
  matrix one level down). A genuine tie is a catalog bug and stops the run.
- **Input** is either a folder, in which case output prefixes are relative to it, or a
  `.json`/`.yaml` object mapping an output prefix to each root — the way several
  unrelated locations are processed into one organised tree. The key fully replaces the
  root's own path.
- **Output** mirrors discovery: a dataset found at `<root>/folderA/folderB` publishes
  the folder `<outdir>/results/folderA/folderB/`, holding
  `results-<hash>.sdata.zarr.zip`, its low-res copy `lowres-<hash>.sdata.zarr.zip`,
  `plots/` and `results.log` — the same names for every dataset, with each checkpoint's
  content hash where §28.1's saves put it. The dataset's path is what each checkpoint
  records as its own name (`--session-name`), so a file named for its slot in the tree
  still reopens as the dataset it holds. The SPA sits at `<outdir>/` so `results/…`
  paths resolve from it, making the whole publish directory a servable deployment.
- **Failure is per dataset.** Reading and analysing runs with the shell's error exit
  disarmed: a folder that looks like a type but is truncated or mis-exported publishes
  its log, is listed as `failed` in the report, and the sweep continues. The dependency
  install is *not* caught — a broken environment is not a data problem.
- **Every checkpoint gets a low-res copy** whose image pyramid is capped at
  `--lowres_max_image_mb` (§28.1's `cap_image_levels`), listed in `index.json` as its own
  entry beside the full one.

`tests/check_catalog.py` holds the four declarative files to each other: the catalog
against its schema, its recipe names against `backend/app/recipes/`, each `applies_to`
against the parameters those recipes actually declare, and the parameter set against
both `nextflow.config` and `nextflow_schema.json`. It also runs discovery over a
synthetic tree of every catalogued type. CI runs it next to `nextflow lint nextflow/`.

---

## 29. The assistant surface (MCP)

An AI agent (e.g. Claude) can drive the studio through a **Model Context Protocol
server inside the backend** — `backend/app/mcp/`, mounted at `POST /api/mcp`. This
realizes the agent loop that §13's data manifest was originally sketched for, with
the context problem inverted: instead of the backend assembling a manifest to replay
into a model, the agent *pulls* what it needs through tools (state, tables, renders)
and carries its own context. The retired rules R11/R12 governed that earlier design
and stay retired.

### 29.1 Shape and trust model

- **In-process, thin tools.** The FastMCP server's tools wrap the same functions the
  REST routes call (`deps` guards, `Session.enqueue_*`, `regions`, `recipes`,
  `snapshots`, `tables`) — no duplicated logic, and every mutation flows through the
  ordinary job queue and SSE bus, so humans watching the session in a browser see the
  agent's work live. Anything new the agent needed (vision, membership dry-runs) is
  additive in `app/mcp/vision.py`, not a parallel code path.
- **Transport**: streamable HTTP in **stateless + JSON-response** mode — every
  exchange is one `POST /api/mcp`, no SSE dependency (survives buffering gateways,
  cf. §16's polling fallback rationale), trivially testable with the in-process
  TestClient. The sub-app serves the single route `/mcp` and is mounted at `/api`
  *after* every REST route (a Starlette mount matches by prefix in registration
  order), so the endpoint is exact and nothing is shadowed. The SDK's DNS-rebinding
  Host allowlist is explicitly disabled: the studio's trust model (here and on REST)
  is that anything able to reach the port is authorized.
- **The agent is a viewer.** `app/mcp/agent.py` gives the assistant a fixed client id
  and the display name "Claude (assistant)", heartbeating `PRESENCE` while it has an
  active session, so it appears in viewer lists and the LockBadge like anyone else.
  Mutating tools bind `deps.CLIENT_ID` to it, so the §16.5 lock guard applies
  unchanged. Because a browser auto-holds the lock of the session it watches, the
  agent can never edit a watched session silently: it must call
  `set_active_session(take_control=True)`, which transfers the lock via
  `Presence.takeover` — the human's badge flips to the assistant's name, they keep
  watching (reads are never gated), and they reclaim the lock after the agent's
  `release_control` (or after `SDS_MCP_IDLE_RELEASE_S` without tool calls, when the
  agent's heartbeat stops and the lock expires normally).

### 29.2 Vision and the coordinate contract

The hard requirement is that the agent can *see* a display, *reason* about a pattern,
and then *act* on it (annotate/subset) in coordinates provably consistent with the
pixels it saw. `view_display` renders through the §14 snapshot core
(`snapshots._render_figure`) and returns two content blocks: the PNG, and a metadata
JSON carrying a `pixel_to_world` affine (composing the deck viewport window, the
PNG's y-down rows, `invert_x/y`, and — when the display renders in image-pixel space,
§9.4 — the image's own `pixel_to_world`), the world window and corner coordinates,
and grid intervals. Three mechanisms close the loop:

- a **world-labeled gridline overlay** drawn inside the render (vision models ground
  far better against labeled rulers; lines are generated in world space and mapped
  through the affine, so a rotating image transform stays correct);
- **verification overlays** — `mark_points`/`mark_polygons` draw the agent's own
  world coordinates back onto a render so it can check its math before mutating;
- **`inspect_region`** — a read-only membership dry-run (same point-in-polygon math
  as §region-annotation) reporting cell count, composition, and per-gene means.

"World" is always the space `annotate`/`subset` polygons use (`obsm['spatial']`
after the points→global affine). Embedding displays report their component space
instead, and selections there resolve to `cell_indices` server-side — mirroring what
the SPA does client-side. One asymmetry is documented rather than hidden: annotate/
inspect test cell *centroids*, while subset (via `polygon_query`) keeps any cell
whose *geometry* intersects the selection, so a subset can hold slightly more cells
than the matching inspect count. `test_e2e.run_mcp_flow` proves the contract end to
end: a pixel rectangle mapped through the returned affine must produce
inspect/annotate membership equal to an independent numpy count.

Plots gained a raster copy for the same reason: `render_plot` (§base) now saves PNG
alongside SVG/PDF, threaded through the kernel envelope into `plot_figures` and
`GET /plots/{id}/figure?fmt=png`, so `view_plot` can hand the agent an image it can
actually read. The PNG travels in the checkpoint with the other two (§7.2), so after a
reload `view_plot` usually has an image already; it still redraws first when the file
carried no figure, or when the plot is invalidated.

### 29.3 Guidance

Any connecting client receives instructions naming four bundled guides served by
`read_guide` (`app/mcp/guides/`): **studio** (sessions, jobs, displays, plots,
regions, locks — the app's mental model), **spatial-biology** (platforms, QC,
interpretation, pitfalls), **analysis-playbooks** (research question → recipe/
function workflows, what to ask the user), and **vision-and-selection** (the
coordinate contract and the survey → zoom → mark → inspect → act → verify loop).
Keeping the guidance server-side means every MCP client gets the same, versioned
knowledge as the code it drives; there is nothing to install on the agent side.
