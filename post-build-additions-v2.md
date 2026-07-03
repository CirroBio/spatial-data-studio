# Post-Build Additions — Consolidated Spec (v2)

**Relationship to the build:** everything here is *new since* the core design spec you built from. It supersedes and incorporates the two interim documents (the region annotation/comparison scope and the parameter term dictionary). Section references like "core §4.6" point at the original build spec.

This addendum has two kinds of content, called out explicitly in **Part 6**:
- **Modifies already-built behavior** (changes to existing code: the introspection layer, the UI shell, the recipe preflight).
- **Net-new features** (region annotation, region comparison).

Reading order is foundational-first: the term dictionary (Part 1) underpins how region sets and analysis params flow through the system, so it comes before the features that rely on it.

---

# Part 1 — Parameter Term Dictionary

**Consolidates** core §4.2 (type→widget), §4.3 (name→data-slot convention map), and the §4.6 policy pins into **one declarative artifact**: a version-controlled YAML file loaded at startup, edited without code changes.

## 1.1 Purpose

Parameter knowledge previously lived in three code locations. This centralizes it as a dictionary keyed by **parameter term** — a canonical parameter concept that recurs across functions. Because the same params (`cluster_key`, `genes`, `layer`, `library_key`, `copy`, `n_jobs`…) appear in many functions, one entry enriches every function using it; a new function introducing a new param needs **one** new entry, after which all other functions sharing that param benefit.

**Invariant (unchanged, core §16.1):** the dictionary defines *parameter terms, never functions*. An entry says how to render/validate/pin a parameter wherever it appears; it never encodes a function's behavior. Functions still come only from the registry.

## 1.2 Resolution pipeline

For each parameter of a discovered function:

1. **Reflect** — name, annotation, default, kind (`inspect.signature` + `get_type_hints`).
2. **Match a term** by precedence: **scope-qualified** (`<ns.fn>::<name>`) › **exact name** › **name pattern** › **type-only** › none.
3. **Merge** — the term supplies `binding`, `widget`, a canonical `type` (only when the annotation is missing/loose, e.g. bare `str`), `policy`, `label`, `help`, `value_source`. A `Literal` annotation from reflection always wins for enum values; the dictionary fills enums only when the annotation is bare.
4. **Fall back** — unmatched params use the type-based widget; unknown types render as a safe text box (never an error).
5. **Emit** JSON Schema + widget hints; `value_source` resolves dynamically at render time against the active table (per core §4.6 data-arg injection — multi-table aware).

## 1.3 Entry schema

```yaml
terms:
  - match:
      names: [cluster_key]          # exact names (any-of)
      patterns: ["*cluster_key"]     # glob/suffix patterns (any-of), optional
      type: null                     # optional type-only match
      scope: null                    # optional "<namespace>.<function>" qualifier for ambiguous names
    binding: obs_categorical         # data slot values resolve against; null = no binding
    role: input                      # input | output | managed
    widget: picker                   # picker | multiselect | enum | number | toggle | text
    value_source: obs.categorical    # dynamic enumerator against the active table
    type: str                        # canonical type, only when reflection's is absent/loose
    required: false
    policy: null                     # { pin: <value>, hidden: <bool> }
    label: "Grouping key"
    help: "Categorical obs column used to group cells (cell types, clusters, or region sets)."
```

All fields except `match` are optional; an entry can be as thin as `match` + `binding`.

## 1.4 Binding vocabulary (the obs-slot mappings)

| `binding` | `value_source` | Resolves to |
|---|---|---|
| `obs_categorical` | `obs.categorical` | categorical `obs` columns (incl. **region sets**) |
| `obs_numeric` | `obs.numeric` | numeric `obs` columns |
| `obs_column` | `obs.any` | any `obs` column |
| `var_names` | `var.names` | gene/feature names (single or multi) |
| `obsm_key` | `obsm.keys` | keys in `obsm` (e.g. `spatial`) |
| `obsp_key` | `obsp.keys` | keys in `obsp` (graphs) |
| `layer_key` | `layers.keys` | keys in `layers` |
| `library_id` | `obs.values_of(library_key)` | values of the chosen partition column |
| `image_element`/`shapes_element`/`labels_element` | `elements.<type>` | SpatialData elements of that type |
| `categories_of(<param>)` | sibling-param categories | categories of the column a sibling param resolved to (§1.7) |
| `new_key` | — | free text naming a slot to **create** (output terms, §1.6) |
| `null` | — | plain scalar/enum/text; no binding |

The `obs_categorical` row is what makes **region sets surface automatically** in every grouping picker (Part 4): a region set *is* a categorical `obs` column.

## 1.5 Roles and policy

- **`input`** — user-facing, bound to data or a scalar (default).
- **`managed`** — the *app* controls the value, hidden from the form: plotting-render params so the app owns figure capture (`show → False`, `save → None`, `return_fig → True`, `ax`/`fig` injected), and mutation pins (`copy → False`, `inplace → True`).
- **`output`** — names a slot the call will create (§1.6).

`policy: { pin: <value>, hidden: true }` fixes a value and removes it from the form.

## 1.6 Output terms feed the recipe contract

Params naming a new slot (`key_added`, conventional output keys) are `role: output`, `binding: new_key`. They let the recipe preflight compute **produced keys statically**: a step with `key_added="foo"` produces `foo`, satisfying a downstream reference to `foo` *before* anything runs. "Required pre-existing keys" = (referenced keys) − (produced keys), computed from the dictionary rather than discovered after execution. This is the mechanism behind the annotation checklist (Part 5).

## 1.7 Relational terms

`groups` enumerates the categories of whatever column the grouping param chose; `reference` is one of those (or `"rest"`). Expressed function-agnostically as `value_source: categories_of(<grouping-term>)` — a parameter convention, not function logic.

## 1.8 Seed dictionary

```yaml
terms:
  # ---- grouping / annotation keys (the core reuse win) ----
  - match: { names: [cluster_key, groupby], patterns: ["*cluster_key"] }
    binding: obs_categorical
    value_source: obs.categorical
    label: "Grouping key"
    help: "Categorical obs column (cell types, clusters, or region sets)."
  - match: { names: [library_key] }
    binding: obs_categorical
    value_source: obs.categorical
    label: "Library / partition key"
  - match: { names: [library_id] }
    binding: library_id
    widget: multiselect
  - match: { names: [groups] }
    binding: categories_of(groupby)
    widget: multiselect
  - match: { names: [reference] }
    binding: categories_of(groupby)
    widget: enum            # plus a synthetic "rest" option

  # ---- features ----
  - match: { names: [genes, var_names] }
    binding: var_names
    widget: multiselect
  - match: { names: [gene] }
    binding: var_names
    widget: picker

  # ---- data slots ----
  - match: { names: [layer] }
    binding: layer_key
  - match: { names: [spatial_key] }
    binding: obsm_key
    type: str
  - match: { names: [connectivity_key, distances_key], patterns: ["*connectivity_key", "*distances_key"] }
    binding: obsp_key

  # ---- mutation / execution policy ----
  - match: { names: [copy] }
    role: managed
    policy: { pin: false, hidden: true }
  - match: { names: [inplace] }
    role: managed
    policy: { pin: true, hidden: true }
  - match: { names: [n_jobs] }
    widget: number
    type: int
    help: "Allocated from the global thread budget; default auto."
  - match: { names: [seed, random_state] }
    widget: number
    type: int
    help: "Set for reproducibility; captured in the recipe."

  # ---- output naming (feeds recipe contract) ----
  - match: { names: [key_added], patterns: ["*_added"] }
    role: output
    binding: new_key
    widget: text

  # ---- plotting render params (managed) ----
  - match: { names: [show] }
    role: managed
    policy: { pin: false, hidden: true }
  - match: { names: [save] }
    role: managed
    policy: { pin: null, hidden: true }
  - match: { names: [return_fig] }
    role: managed
    policy: { pin: true, hidden: true }
  - match: { names: [ax, fig] }
    role: managed
    policy: { hidden: true }

  # ---- generic numerics (type-refinement where annotations are bare) ----
  - match: { names: [n_neighs, n_rings, n_perms, n_genes] }
    widget: number
    type: int
  - match: { names: [radius] }
    widget: number
    type: float

  # ---- ambiguous name: scope-qualified (only if not Literal-annotated) ----
  - match: { names: [mode], scope: "gr.ripley" }
    widget: enum
    values: [F, G, L]
  - match: { names: [mode], scope: "gr.spatial_autocorr" }
    widget: enum
    values: [moran, geary]
```

## 1.9 Coverage report & expansion

At registry build, for every param across **all** discovered functions, record whether it matched a term or fell back to type default. Emit a **coverage report**: unmatched params with type, the functions using them, and a **reuse-frequency rank**. Maintainers add entries highest-frequency-first. Regenerated on every squidpy/scanpy upgrade, surfacing new params automatically — the operational meaning of "expanded as new functions necessitate."

---

# Part 2 — Region annotation: data model

A **region** is a category within a **region set**; a region set is a categorical `obs` column. Because a region set is an ordinary `obs` categorical, it flows through every existing mechanism with no new wiring (Part 1.4).

**Geometry is out of scope.** Drawing a region computes cell membership (via point-in-polygon over `obsm["spatial"]`) and keeps only that membership as an `obs` categorical; the drawn polygon itself is not persisted as a SpatialData shapes element. A region set therefore looks identical whether it came from a drawn lasso, a promoted existing categorical, or a derived clustering — there is no "has geometry" distinction to track.

| Piece | Where | Holds |
|---|---|---|
| **Membership** | `obs["<region_set>"]` (pandas Categorical) | per-cell label + `"unassigned"` |

App registration (declarative, persisted in `attrs`):

```jsonc
"regions": [
  {
    "id": "uuid", "name": "tumor_vs_stroma",
    "obs_column": "tumor_vs_stroma",
    "categories": [
      { "label": "tumor",  "color": "#c1432b", "n_cells": 18234 },
      { "label": "stroma", "color": "#2b6cc1", "n_cells": 40561 },
      { "label": "unassigned", "color": "#bbbbbb", "n_cells": 1203 }
    ]
  }
]
```

**Semantics:** a region set is **single-label** (a partition) — each cell maps to exactly one category, `"unassigned"` otherwise. Overlapping drawn polygons resolve last-wins (with an optional priority). Genuinely overlapping concepts are **separate region sets** (cells carry one label per set), enabling cross-tabulation between schemes.

---

# Part 3 — Region annotation: creation, sources, editing

## 3.1 The in-place lasso variant

The existing lasso machinery (editable-layers → vertices → `shapely`) is reused; only the terminal action differs. Instead of `polygon_query` → child session (subsetting), the operation computes membership and **mutates the current object in place**, as a **queued mutating job** (audit-log entry + structural diff + write lock — identical lifecycle to subset):

1. user draws box/lasso/circle (strokes union into one region);
2. chooses **"Assign to region…"** → pick/create set, name the category, pick color;
3. backend builds the polygon(s) in the display's coordinate system, computes membership over `obsm["spatial"]` via vectorized point-in-polygon (`matplotlib.path.Path.contains_points`, or `shapely` + `STRtree` for millions of points), writes `obs["<set>"]`, emits a structural diff (`obs:<set>`). The polygon itself is discarded once membership is computed (Part 2 — no shapes element is persisted).

## 3.2 Region sets from squidpy-native sources (promotion)

Any existing `obs` categorical can be **promoted** to a region set, unifying three sources that all land in the same geometry-free representation:
- **Hand-drawn** (lasso).
- **`tl.sliding_window`** — tiles into windows; assignment column promotable.
- **Cluster/domain-derived** — Leiden on a spatial graph, or `gr.calculate_niche`; resulting categorical promotable.

## 3.3 Editing operations

Create set · add region (draw) · rename · recolor · merge categories · split/reassign · delete region · delete set · promote existing categorical · toggle visibility · set active set. Each membership-affecting edit re-derives membership and updates `obs` as a queued mutating job.

---

# Part 4 — UI restructure: four tabs, two classes  *(modifies built core §15)*

The left sidebar moves from two tabs to **four peer tabs in two classes**:

| Tab | Class | Main area | Sidebar contents |
|---|---|---|---|
| **Compute** | operation log | selected call's detail (form, status, log) | compute audit log |
| **Plots** | operation log | selected figure + form + redraw | flat plot list |
| **Annotations** | canvas workflow | stays the live canvas | region sets → categories (swatch, count, visibility, edit); active-set selector |
| **Subsetting** | canvas workflow | stays the live canvas | **session lineage tree** with residency badges; the subset action |

**Operation-log tabs** drive the detail panel; the canvas is the fallback; selection tool **not** armed.

**Canvas-workflow tabs** keep the main area on the live canvas and **the active tab sets the canvas selection mode**, removing the action-button ambiguity:
- **Annotations active** → a drawn selection **labels** cells in place into the active region set (§3.1).
- **Subsetting active** → a drawn selection **arms a fork**; "Subset to Selection" creates a child session, evicting the parent (core model).

The **Subsetting** tab's contents are the **session lineage**, not a list of subset operations — a subset spawns a child and evicts the parent, so it doesn't persist within the current session. This tab is the home for session navigation (previously the gear menu) and shows which lineage members are resident vs. evicted-to-Zarr.

**Canvas rendering of regions** reuses existing layers: region coloring is `color_by` on the categorical (stable palette keyed by category value) — there is no separate region-boundary polygon overlay, since no geometry is persisted (Part 2). Interactions: legend with counts, click-to-isolate (client-side filter, no refetch), visibility toggles. Region layers participate in the existing per-layer data-state machine (`FRESH`/`LOADING`/`STALE`/`FETCHING`/`MISSING`).

**Core-app changes this implies:** session navigation moves out of the gear menu into the Subsetting tab; selection-arming becomes **modal by active tab** rather than action-button-driven; the gear menu retains only global/advanced ops (save/export, load, recipe, settings). A persistent on-canvas affordance should show the current mode ("drawing will: label region / arm subset") so the active mode is visible at the moment of drawing.

---

# Part 5 — Recipes (predefined analysis + plotting)  *(extends built core §10; modifies the step lifecycle and preflight)*

A **recipe** is a named, shareable bundle of ordered **compute + plotting** steps with an attached **README**. It is the reusable form of an analysis: author once — by hand, by adapting an official squidpy/scanpy vignette, or by transcribing a paper's methods — then apply to any dataset. Recipes may ship **in the app repo** (the "official" set) or be imported from a file.

## 5.1 Bundle format

A recipe is a single JSON document (one portable file; repo recipes are just committed files):

```jsonc
{
  "schema_version": 1,
  "meta": {
    "name": "Neighborhood enrichment by cell type",
    "description": "One-line summary.",
    "provenance": "Adapted from squidpy 'Neighborhood enrichment' vignette / Palla et al. 2022 Methods",
    "targets": { "squidpy": ">=1.6", "scanpy": ">=1.10" }   // informational
  },
  "readme": "# ...markdown...\nWhat this does, expected inputs, how to read the outputs.",
  "requires": {                       // the contract (§5.8); re-derived + validated on import
    "region_sets": [ { "key": "tumor_vs_stroma", "categories": ["tumor", "stroma"] } ],
    "obs_keys": [], "var_keys": []
  },
  "steps": [
    { "kind": "compute", "namespace": "gr", "function": "spatial_neighbors",  "params": { "n_neighs": 6 } },
    { "kind": "compute", "namespace": "gr", "function": "nhood_enrichment",   "params": { "cluster_key": "cell_type" } },
    { "kind": "plot",    "namespace": "pl", "function": "nhood_enrichment",   "params": { "cluster_key": "cell_type" } }
  ]
}
```

Steps are the same `{namespace, function, params}` descriptors used everywhere (core §4.5), tagged `compute` or `plot`. `requires` is the required-pre-existing-keys contract (§5.8), stored for display and re-derived on import.

## 5.2 Sources & authoring

- **Repo-bundled ("official")** — recipe files committed under a `recipes/` directory, discovered at startup. The curated set, typically adapted from official vignettes or published methods, each README citing provenance.
- **Imported** — a recipe file the user loads.
- **Authored in-session** — assemble a plan of PENDING steps (§5.4), write a README, save as a recipe (§5.5). Because the app already introspects every function and param, in-session authoring is just staging steps and saving them.

Generating a recipe by adapting a vignette or transcribing a paper's methods yields a conformant file; the app's contract is the format above. On import the recipe is **validated against the installed registry** — each step's function must exist and params must resolve via the term dictionary — so version drift in a shared recipe surfaces as clear per-step errors, not silent failure.

## 5.3 Import: run now vs. stage

Applying a recipe (official menu or file) opens a dialog showing the **README**, the ordered steps, and the `requires` checklist (§5.8). The user chooses:
- **Run now** — all steps enter the queue in order immediately (validate-on-dequeue handles inter-step dependencies).
- **Stage** — all steps are created **PENDING** (§5.4): visible in the Compute/Plots tabs, params editable, nothing executed until run.

## 5.4 PENDING lifecycle — also for manual adds  *(modifies built status model)*

A new pre-queue status, **PENDING**, sits ahead of QUEUED. A PENDING step is *staged but not submitted*: editable, reorderable, discardable, not consuming the queue.

```
(create) → PENDING → QUEUED → RUNNING → COMPLETED / FAILED
              │  ▲
   edit/reorder  │   (discard removes it; QUEUED onward is immutable)
              └──┘
```

- **Recipe import (Stage)** creates PENDING steps.
- **Manual add** lands in PENDING too — adding a step stages it with form params; the user edits, then runs. This is the same act as authoring a recipe in-session. A fast path is preserved: a single step offers **Run now** alongside **Stage**, so the common "add one step and run it" case stays one action and the built flow isn't slowed.
- **PENDING is the only editable state.** Once QUEUED, a step follows the immutable audit-log model (core §5): to change an executed step you append a new one (which starts PENDING). Editing a PENDING step's params is free.
- **Run controls:** "Run" on a single PENDING step, or "Run all pending" (enqueues all staged steps in order — i.e. runs the staged plan). Plots stage identically (PENDING → run → DRAWN).

Visuals (extends Part 4 / core §15): PENDING renders as a distinct **draft/staged** badge, separate from QUEUED (submitted, awaiting worker). The activity badge counts `staged · queued · running`.

## 5.5 Saving a recipe (with README)

"Save as recipe…" serializes a chosen set of steps — the executed history, the current PENDING plan, or a selected subset — to the bundle format. The dialog includes a **markdown README editor** (required, pre-filled with a generated outline: step list + detected `requires`) plus name/description/provenance. The `requires` contract is computed automatically (referenced keys minus keys produced by `role: output` params, §1.6).

## 5.6 The official-recipes menu

A **Recipes** menu (in the gear menu) offers: **Apply official recipe ▸** (submenu populated from the repo `recipes/` dir, each showing its README), **Import recipe from file…**, and **Save as recipe…**. Selecting an official recipe opens the import dialog (§5.3) with run-now / stage options.

## 5.7 Portability — annotations don't travel

Recipes carry **compute + plotting** steps only; **annotations are excluded**. Hand-drawn membership is derived from one section's specific spatial coordinates and is meaningless replayed elsewhere; replication works by **re-defining region sets under the same `obs` key names** (drawn, or promoted per §3.2). A step like `rank_genes_groups(groupby="tumor_vs_stroma")` resolves because the new dataset carries that column.

## 5.8 Preflight checklist  *(modifies built core §10 preflight)*

Using the dictionary's output terms (§1.6), the preflight computes **required pre-existing keys** = (referenced keys) − (keys produced by `role: output` params), and renders unresolved references as an **annotation checklist**: *"before running, define region set `tumor_vs_stroma` with categories `tumor`, `stroma`."* Where steps reference **specific category values**, those labels are part of the contract. Missing-key steps are blocked (not silently skipped); steps whose keys the recipe itself produces need nothing. Key-level grouping ports more freely than hard-coded category references; the preflight makes the difference visible.

---

# Part 6 — Region comparison: analysis  *(net-new feature; squidpy/scanpy/deps only — no new libraries)*

**Constraint:** uses only `squidpy`, `scanpy`, and existing deps (`anndata`, `numpy`, `scipy`, `pandas`, `scikit-learn`, `matplotlib`).

## 6.1 Grouping principle

Region comparison = use the region `obs` column as the grouping arg, then assemble and contrast per-region outputs. Because the term dictionary surfaces `obs_categorical` params (Part 1.4), **every relevant function takes a region set as its grouping key with no new code.** The app doesn't hardcode the list below; the registry enumerates the live functions. The inventory is what becomes region-aware for free.

## 6.2 Inventory by axis

**A — Transcriptional / molecular**

| Function | Grouping arg | Output | Comparison |
|---|---|---|---|
| `sc.tl.rank_genes_groups` | `groupby` (+`groups`/`reference`) | per-region DE vs rest or a reference | core DE between regions |
| `sc.tl.filter_rank_genes_groups` | — | filtered DE | trims by FC / fraction |
| `sc.get.rank_genes_groups_df` | — | tidy DataFrame | assembly for tables / volcano (matplotlib) |
| `sc.tl.score_genes[_cell_cycle]` | — | per-cell score | compare distributions (pandas groupby) |
| `sc.tl.dendrogram` | `groupby` | hierarchy over regions | relatedness |
| `sc.pl.rank_genes_groups[_dotplot/_heatmap/_matrixplot/_stacked_violin/_violin/_tracksplot]` | `groupby` | figures | via plotting path |

**B — Cell-type / cluster composition** (built from deps)
- `pandas.crosstab(region, cell_type)` → proportions per region.
- `scipy.stats.chi2_contingency` / `fisher_exact` on the region × cell-type table → composition-difference test (read with §6.5 caveat).
- Cross-tab two region sets to relate schemes.

**C — Spatial organization** (squidpy `gr`; per region via subset-per-region preferred, or `library_key`=region set as an optimization)

| Function | Cell-type arg | Per-region output | Comparison |
|---|---|---|---|
| `gr.spatial_neighbors` | (`library_key`) | region-confined graph | prerequisite |
| `gr.nhood_enrichment` | `cluster_key` | n×n z-scores | matrix diff; rank changed pairs |
| `gr.co_occurrence` | `cluster_key` | co-occurrence vs distance | curve overlay/diff |
| `gr.interaction_matrix` | `cluster_key` | interaction counts | matrix diff |
| `gr.centrality_scores` | `cluster_key` | per-type centralities | per-type deltas |
| `gr.ripley` | `cluster_key`, `mode` | Ripley K/L/F/G | curve comparison |
| `gr.ligrec` | `cluster_key` | L–R enrichment | gained/lost pairs |

**D — Spatially variable genes**
- `gr.spatial_autocorr` (`moran`/`geary`) per region → per-gene scores; compare to find genes structured in one region but not another (pandas delta).
- `gr.sepal` per region → alternative SVG ranking.

**E — Distance / gradient**
- `sq.tl.var_by_distance` anchored on a region → expression vs distance to it; `sq.pl.var_by_distance` plots gradients.

## 6.3 Per-region orchestration

App-defined workflow (like subset — orchestration over introspected calls):
1. **Fan out:** for each category, run the metric (subset-per-region or `library_key`), storing results into `uns` keyed by region.
2. **Assemble & contrast:** combine with numpy/pandas (matrix diffs, curve stacks, ranked deltas) + scipy tests; store the assembled comparison into `uns["_results"][<job_id>]` (core return-capture slot).
3. **Render:** comparison view (§6.4).

Each fan-out step is a normal queued, audit-logged, structural-diffed call; assembly is pure-dep arithmetic. This reproduces the *descriptive* substance of dedicated cross-condition tools without adding one — omitting their specialized graph kernels and replicated-significance models by the no-new-library constraint.

## 6.4 New display needs

- **Faceted small-multiples** — new display type, one mini-canvas per region; regions partition the cells, so total points ≈ one dataset (within the existing scatter budget); cap facet count / page for many regions. *This is the one piece that genuinely stretches the single-canvas model — prototype early to de-risk.*
- **Differential overlays** — color by per-region delta (derived field via `color_by`), or paired polygons with a shared legend.
- **Result charts** — DE dotplots/heatmaps/volcano, enrichment-matrix diffs, co-occurrence/Ripley curves — via the existing `pl`/matplotlib plotting path (static SVG/PDF, lazy redraw + invalidation inherited).

## 6.5 Statistical caveat (design the UI around it)

Comparing regions of **one** section has **no biological replication** (n = 1 per region):
- DE is valid for marker/exploratory discovery; lead with effect sizes/fractions, label p-values exploratory.
- Composition tests and enrichment-matrix diffs describe *this section*, not condition-level inference.
- Permutation metrics (`nhood_enrichment`, `ligrec`) give a within-region null by label shuffling — a descriptive enrichment, not a between-region inferential test.

UI posture: effect-size-first; gate or footnote inferential numbers with a pseudo-replication note.

---

# Part 7 — Consolidated change list

**Modifies already-built code:**
1. **Introspection layer** — replace inline §4.2/§4.3/§4.6-pin logic with the Parameter Term Dictionary (Part 1); add the coverage report.
2. **UI shell** — four-tab sidebar (Part 4); move session navigation from gear menu to the Subsetting tab; selection-arming becomes modal by active tab; on-canvas mode affordance.
3. **Step lifecycle & queue** — add the **PENDING** pre-queue status for compute *and* plot steps; manual add now lands in PENDING (with a single-step "Run now" fast path); "Run all pending" runs a staged plan (Part 5.4).
4. **Recipe subsystem** — bundle format with README + `meta` + `requires`; import dialog with run-now/stage; registry validation on import; "Save as recipe" with README editor; official-recipes menu from the repo `recipes/` dir (Part 5).
5. **Recipe preflight** — compute required-vs-produced keys from `role: output` terms; render unresolved references as an annotation checklist (Parts 5.8, 1.6).
6. **Plotting handler** — rely on `managed` render terms to pin `return_fig`/`show`/`save` and inject `ax` (Part 1.5).

**Net-new features:**
7. **Region data model** — `obs` categorical + `attrs.regions` registry, single-label/overlap/unassigned semantics; no geometry is persisted (Part 2).
8. **Annotation creation/editing** — in-place lasso label action; promotion of existing categoricals; edit ops (Part 3).
9. **Region comparison** — per-region orchestration wrapper + comparison views (faceted small-multiples, differential overlays, result charts) (Part 6).

**Invariants preserved:** no hardcoded functions (the dictionary is parameter-level only, with a CI guard); in-place mutation + audit-log; region/annotation/subset ops are queued mutating jobs under the existing concurrency model.

---

# Part 8 — Consolidated build sequence

1. **Term dictionary** — schema + loader + resolution pipeline; migrate §4.2/4.3/4.6 logic onto it; seed entries; coverage report.
2. **Region data model** — `obs` + `attrs.regions`; persistence round-trip. No geometry is stored.
3. **In-place lasso label** — single set/region → `obs` + structural diff (reuses subset machinery); the drawn polygon is discarded once membership is computed.
4. **Four-tab UI** — Annotations tab (list/color/counts/visibility/isolate) + canvas coloring by category; move session nav into a Subsetting tab; modal selection + on-canvas mode affordance.
5. **Editing + promotion** — rename/recolor/merge/delete; promote existing categoricals.
6. **Analysis grouping** — confirm region sets appear in every `obs_categorical` picker (should be automatic via the dictionary); run `rank_genes_groups` + composition crosstab end-to-end.
7. **PENDING lifecycle** — add the pre-queue staged status for compute + plots; manual add → PENDING with single-step Run-now; "Run all pending."
8. **Recipe subsystem** — bundle format (steps + README + meta + requires); import dialog (run-now/stage) with registry validation; Save-as-recipe with README editor; official-recipes menu from the repo `recipes/` dir; seed a few official recipes adapted from squidpy/scanpy vignettes.
9. **Per-region orchestration** — fan-out → assemble → `uns["_results"]`.
10. **Spatial-organization metrics per region** — subset-per-region; `library_key` optimization where supported.
11. **Comparison views** — faceted small-multiples (prototype first), differential overlays, result charts via plotting path.
12. **Recipe portability** — required/produced-key contract + annotation checklist in the preflight.
13. **Statistical-framing UI** — effect-size-first, pseudo-replication notes.
14. **License compliance** — run scanners + SBOM, adjudicate GPL exposure, bundle attributions, before any distribution (Part 9).

---

# Part 9 — Licensing & third-party compliance  *(project-wide, not only post-build additions)*

Applies to the whole application. The architecture violates no dependency license, but distribution (the Docker image counts as distribution) carries obligations that must be met to stay compliant. **This is an engineering checklist, not legal advice; the GPL derivative-work question in §9.3 should be confirmed with counsel.**

## 9.1 License posture

The core stack is **permissive**: squidpy, scanpy, anndata, spatialdata, numpy, scipy, pandas, scikit-learn are BSD-3-Clause; matplotlib is BSD-compatible; the frontend (React, deck.gl, Tailwind, Radix) is MIT; Apache Arrow is Apache-2.0. Permissive licensing means the app may remain **proprietary and be distributed without releasing app source**; the only baseline obligation is attribution.

## 9.2 Baseline obligations (on distribution)

- Bundle a **`THIRD_PARTY_LICENSES`** file (each dependency's copyright + license text) in the image, and surface attributions in an in-app **About / Acknowledgements** view.
- Preserve any **Apache-2.0 `NOTICE`** files (Arrow).
- Respect the **BSD-3 non-endorsement clause** — do not use upstream project/author names to promote the product. (The "Spatial Data Studio" name complies; avoid library-name-derived product branding.)

## 9.3 GPL exposure — clustering (decide explicitly)

Leiden/Louvain community detection pulls **GPL** dependencies: `python-igraph` (GPL-2.0-or-later), `leidenalg` (GPL-3.0-or-later), `louvain` (GPL). The **region-from-clustering** path (Part 3.2) uses these. Copyleft means that in a distributed image these components carry source-availability obligations, and whether importing a GPL Python module makes the app a derivative work is legally unsettled.

A deliberate decision is required — one of:
1. **Comply** with GPL for the isolated clustering component;
2. **Swap** to a non-GPL clustering method;
3. **Isolate** clustering as a separate process to support a "separate work" position (a legal judgment, not a guaranteed fix).

Do **not** bundle **napari or Qt/PyQt** in the server image: not needed (the squidpy napari plugin moved out), GPL/commercial-dual, and reintroduces the same exposure for no benefit.

## 9.4 Pre-distribution checklist

1. Run license scanners over the **fully-resolved** trees — `pip-licenses` (Python) and `license-checker` (npm) — and generate an **SBOM** (SPDX or CycloneDX).
2. Flag every GPL / LGPL / AGPL / MPL / CC-NC license and adjudicate each explicitly.
3. Bundle attributions (`THIRD_PARTY_LICENSES`) and expose the in-app About surface (§9.2).
4. Check bundled **example datasets** (squidpy datasets, Xenium/Visium samples) for their own data-licensing and attribution terms, independent of the code licenses.
5. For wide distribution, have **counsel review the SBOM**, especially the §9.3 GPL adjudication.

## 9.5 Maintenance

Re-run §9.4 on every dependency upgrade (the same trigger as the term-dictionary coverage report, §1.9) — a transitive license can change between versions, so compliance is a per-release check, not a one-time gate.
