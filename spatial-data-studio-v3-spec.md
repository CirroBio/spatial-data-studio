# Spatial Data Studio — v3 Specification

**Expanded function catalog + AI integration**

**Builds on:** the core build spec (v1) and the post-build addendum (v2). References like "v2 §4.6" point at those. This document is self-contained for the v3 work.

**Two goals:**
1. **Expand the catalog** — formalize every runnable function behind one schema-of-record and one execution contract, and add scanpy + spatialdata-io readers through a near-zero-boilerplate import pattern.
2. **AI integration** — an in-app chat backed by AWS Bedrock that can propose and run functions, apply recipes, and save snapshots, under a human-approval model, with aggressively compact self-curated memory.
3. **Lock in the structure** — ship a governance layer (independently-triggerable skills + CI-enforced rules) so the expanding catalog and the AI surface stay coherent as they grow (Part 14).

**Decisions made for this draft (flagged so you can adjust):**
- Snapshot assets are Arrow per data field, named by a content hash of the field bytes (dedupe across snapshots); only the image tiles the captured view needs are written, also content-hashed.
- The data manifest seed is structural-first plus a small set of summary contributors.
- Library scope is scanpy (`pp`/`tl`/`get`) + spatialdata-io readers. scvi-tools is **out** (keeps the stack permissive and the image lean).

---

# Part 1 — Function architecture: one schema, one executor

## 1.1 Schema of record

Every function's inputs are defined by a schema whose **canonical serialization is JSON Schema**, because that is simultaneously what the frontend form renders from, what Python validates against (Pydantic), and what the agent tool interface publishes (Part 5).

Two authoring paths converge on that one artifact:
- **Custom functions** (app-defined ops: region label, subset, comparison orchestration, snapshot, recipe-apply) — the schema is **authored as a Zod schema** in the function's folder; `zod-to-json-schema` emits the JSON Schema.
- **Library functions** (squidpy, scanpy) — the schema is **generated** at build time from the Python signature (reflection) enriched by the Parameter Term Dictionary (v2 Part 1). No hand-written schema.

Either way: one schema → frontend form + Python validation + agent tool description. There is no second place where params are defined.

## 1.2 Custom Zod types = the binding vocabulary

The custom types the schema uses (`obsCategorical`, `varNames`, `layerKey`, `obsmKey`, `obspKey`, `libraryKey`, `imageElement`, `shapesElement`, …) are exactly the term-dictionary **binding vocabulary** (v2 Part 1.4), re-homed as Zod types. On conversion they survive as JSON Schema vendor extensions: a base type plus `x-binding: obs_categorical`. The frontend reads `x-binding` to pick the right widget (a live dropdown); the agent interface reads it to know the value is dynamic (Part 5.2). One catalog of custom types, shared by both consumers.

## 1.3 Function folders

```
functions/
  _shared/
    library_executor.py        # the ONE executor for all library functions
  spatial_neighbors/           # a library function
    manifest.yaml              # tiny import manifest (no schema, no python)
  rank_genes_groups/
    manifest.yaml
  region_label/                # a custom function
    schema.ts                  # authored Zod
    run.py                     # its own python
  subset_to_selection/
    schema.ts
    run.py
```

**Library function folder = a tiny manifest, nothing else:**

```yaml
# functions/spatial_neighbors/manifest.yaml
library: squidpy
path: gr.spatial_neighbors          # dotted path within the library
effect_class: compute               # compute | plot | read  (v2 §4.4)
executor: _shared/library_executor.py
overrides:                          # optional, term-dictionary-style, only when needed
  n_neighs: { help: "Number of spatial neighbors." }
```

From this, the build step reflects the Python signature, applies the term dictionary, and generates the JSON Schema. Adding a library function is one short file — satisfying "does not create very many files."

## 1.4 The single library executor

All library functions run through **one** Python module (the v3 evolution of the v2 `CallAdapter`). Given a manifest + validated params + the session, it:
1. resolves the callable from the registry by `library` + `path`;
2. injects data arguments by type (AnnData → active table, SpatialData → object, ImageContainer/image → element) per v2 §4.6;
3. binds and coerces params, applying managed pins (`copy=False`, `inplace=True`, plotting `return_fig=True/show=False`) from the term dictionary;
4. executes, capturing the result per the contract (Part 2).

Custom functions supply their own `run.py` but **return the same contract envelope**, so everything downstream (queue, history, context, agent) treats library and custom calls identically.

---

# Part 2 — The function contract

Every function — library or custom, frontend- or AI-invoked — runs through one contract.

**Input:** params conforming to the schema, plus a boolean **`keep_failures`**.

**Execution & capture:**
1. Capture the **data manifest before** the call (Part 3).
2. Validate params (Pydantic, from the schema); validate-on-dequeue against current state (v2).
3. Execute; capture **success/failure**, **return value/effect**, and all **logging** (stdout/stderr/logging/tqdm) per v2 §6.3.
4. Capture the **data manifest after** the call.

**Output envelope:** `{ status, logs, structural_diff?, figure_bytes?, new_object?, manifest_before, manifest_after, error? }`.

**`keep_failures` semantics:**
- **Frontend invocation → `keep_failures = True`.** A failed call stays in the dataset history (the audit log) so the user can inspect it and delete it manually.
- **AI invocation → `keep_failures = False`.** A failed call is **not** written to dataset history (so the agent's exploration doesn't clutter the record) — **but the failure is always returned to the agent loop and distilled into context** (Part 7). "Not kept" means *absent from dataset history*, never *hidden from the agent*. This holds in auto-on mode too: a failure must reach the model so it can recover.

Successful AI calls **are** written to history like any other compute/plot call.

---

# Part 3 — Data manifest

A **text** representation of session state — the AI's eyes, and a human-readable diff source.

## 3.1 Contributor registry

The manifest is assembled from an **extensible registry of contributors**, each a small function appending a labeled text block. New contributors are added the way term-dictionary entries are — without touching the manifest core — matching the "can't think of everything yet" reality.

## 3.2 Seed contributors

- **SpatialData repr** — the native `str(sdata)` (the backbone: elements, coordinate systems, shapes).
- **Tables** — per table: shape, `obs` columns with dtypes, `var` columns with dtypes, `obsm`/`obsp`/`layers` keys.
- **Categoricals** — each categorical `obs` column with its categories and per-category counts (this is what makes `obsCategorical` values legible to the agent).
- **Region sets** — registered sets (v2 Part 2) with categories + counts.
- **Images** — image elements with channel names (and current on/off + rename state, Part 10).
- **Summaries (structural-first, small set):** total cells, total counts / median genes-per-cell if QC metrics exist; per-region cell counts when a region set is active. Kept minimal by design; grow via the registry.
- **Recent context** — the rolling context notes (Part 7) are appended so a fresh agent turn sees prior learnings.

Manifests are captured **before and after** every function call (Part 2) so deltas are computable.

---

# Part 4 — Expanded catalog (scanpy + spatialdata-io)

All added through the import-manifest pattern (Part 1.3) — manifests only, no per-function code. The registry enumerates the live set; the list below is what becomes available, not a hardcoded table.

**scanpy `pp` (preprocessing, mutate the active table):** `calculate_qc_metrics`, `filter_cells`, `filter_genes`, `normalize_total`, `log1p`, `scale`, `regress_out`, `highly_variable_genes`, `pca`, `neighbors`, `scrublet` (doublets).

**scanpy `tl` (tools):** `leiden`, `louvain`, `umap`, `tsne`, `diffmap`, `draw_graph`, `dpt`, `paga`, `dendrogram`, `rank_genes_groups`, `filter_rank_genes_groups`, `score_genes`, `score_genes_cell_cycle`, `embedding_density`.

**scanpy `get` (extraction, read-only):** `obs_df`, `var_df`, `rank_genes_groups_df`, `aggregate` — these feed result assembly and the comparison views (v2 Part 6) rather than mutating.

**spatialdata-io (readers, session bootstrap):** `xenium`, `visium`, `visium_hd`, `merscope`/`vizgen`, `cosmx`, and others as the library provides — registered as `read` effect-class functions that create the session object.

**Notes:**
- scanpy functions inject the **active table** (AnnData); squidpy functions inject the object/element — handled uniformly by §1.4 type-based injection.
- `pp`/`tl` mutate in place (consistent with the v2 audit-log model); `copy`/`inplace` are pinned by the term dictionary.
- Leiden/Louvain still pull GPL clustering deps — the v2 Part 9 §9.3 decision applies unchanged; nothing in v3 worsens the license posture (scvi explicitly excluded).

---

# Part 5 — Agent tool interface

The LLM does not get one tool per function (the catalog is dynamic and would bloat and duplicate the registry). It gets a **small fixed set of meta-tools** over the catalog. (This is the formalization of the earlier "MCP" idea; whether it is also exposed as a literal MCP server for external clients is an implementation option, but the core is this internal tool set given to Bedrock via Converse tool-use.)

## 5.1 The tools

**Read-only (no approval, even in auto-off):**
- `list_functions(filter?)` → catalog: names + one-line descriptions, filterable by namespace/keyword.
- `describe_function(name)` → full JSON Schema for one function, **with live-resolved option lists** for dynamic params (Part 5.2).
- `get_data_manifest()` → the current manifest text (Part 3).
- `list_recipes()` → available recipes (v2 Part 5) with their READMEs.
- `list_snapshots()` → existing snapshots.

**State-changing (sequential approval in auto-off; auto-run in auto-on):**
- `run_function(name, params)` → execute under the contract with `keep_failures=False` (Part 2).
- `apply_recipe(name, mode)` → apply a recipe staged or run (v2 Part 5.3).
- `save_snapshot()` → write a snapshot (Part 9).

**Out of scope for the agent (v3):** region annotation and subsetting are **not** exposed — those remain human-only canvas workflows.

## 5.2 Dynamic options via `describe_function`

The schema is **fixed**: if a param is `obsCategorical`, that is what the tool schema says. The *currently valid values* are not baked into the schema; they are returned by `describe_function`, which resolves each dynamic param's options against the live session. The agent's loop is therefore: `list_functions` → `describe_function` (see current valid options) → `run_function`. Stable regardless of catalog size, and it reuses the registry rather than shadowing it.

---

# Part 6 — AI chat & interaction model

When Bedrock is configured (Part 8), the app exposes a chat. One Bedrock conversation per session.

## 6.1 Turn structure

1. **User message** → sent to Bedrock with: system prompt, the rolling **context** (Part 7), the current **data manifest** (or delta — Part 7.4), the tool definitions (Part 5), and the user text.
2. **Assistant responds** with (a) text shown to the user and/or (b) proposed tool calls.
3. **Read-only tool calls** (`list_functions`, `describe_function`, `get_data_manifest`, `list_*`) execute immediately, no gate — the agent explores freely.
4. **State-changing tool calls** hit the approval gate per auto-mode (6.2).
5. Each executed call returns its **contract envelope** (success/failure + before/after manifest delta) as a tool result back to the model, which may propose further calls (the within-turn tool-use loop).
6. When the turn settles, the model emits its **context note** (Part 7) and the raw turn is discarded from memory.

## 6.2 Auto-mode and approval

A per-session **auto-mode toggle**:
- **Auto on** → state-changing calls execute immediately.
- **Auto off** → each state-changing call shows an **approval modal** with the resolved function + params. Three actions:
  - **Approve** → run as proposed.
  - **Edit & approve** → user edits params, then runs. Safe because context records *what actually ran*, so the model learns the corrected form regardless of who authored it.
  - **Deny (± reason)** → not run; the denial **and the optional reason** are returned to the model as the tool result, so the model adapts instead of retrying blindly.

## 6.3 Sequential approval for multi-call turns

When a turn proposes multiple state-changing calls, they are approved **one at a time, in order** — because functions mutate in place, approving call 1 changes the state call 2 was predicated on. After each approval, later calls are **re-validated** against the new state (validate-on-dequeue), and the modal for the next call reflects the updated manifest. Read-only calls interleaved in the turn still run without gating.

## 6.4 Denial and failure are both information

Denials (with reason) and failures both return to the model as tool results and both flow into the context note. This is what makes auto-off feel collaborative rather than obstructive, and what prevents the agent repeating a rejected or failed approach.

---

# Part 7 — Context management (aggressively compact, self-curated)

The defining v3 memory decision: **the LLM-authored summary is the only carried memory.** The full back-and-forth is ephemeral.

## 7.1 What is and isn't memory

- **Ephemeral:** the user-facing transcript and the within-turn tool-use messages. Rendered to the user, used to produce the turn, then **dropped** from anything replayed to the model. (The human-readable transcript is still persisted for the *user* — Part 8.4 — just not fed back to the model.)
- **Memory:** a short **"what I newly learned"** note the model is explicitly asked to emit each turn. This is the *only* thing appended to the **context** — durable facts: what worked, what failed and why, user corrections/preferences, key parameter values. Not narration of the exchange.

## 7.2 The context list

- Append-only list of delta notes, **separate from dataset history**, so it **outlives function calls deleted from history** (and AI failures never written to history). The agent's mistakes-and-fixes survive even when the dataset record doesn't.
- **Persists into the `.zarr.zip`** (survives reload), under `attrs` alongside the v2 app-state.

## 7.3 Two-tier compaction

- **Per-turn distillation (always):** transcript+outcomes → one short delta note.
- **Periodic consolidation (on threshold):** when total context exceeds `CONTEXT_TOKEN_LIMIT`, the model is asked to **compact the whole context** into a tighter form. The most recent `CONTEXT_KEEP_RECENT_N` delta notes are kept **verbatim** (not yet consolidated) so recent detail stays sharp; older notes collapse.
- **Known tradeoff (stated, accepted):** repeated lossy re-summarization can erode old specifics over very long sessions. Mitigated by setting the ceiling high enough that consolidation is rare and by the keep-recent-N verbatim window.

## 7.4 Replay model (Bedrock is stateless)

Bedrock retains no server-side memory; the model "remembers" only what you replay. So each call replays: **system prompt + rolled-up context + current manifest (or, after the first turn, the manifest delta) + the current user message + tool definitions.** The prior turns' raw text is *not* replayed — only the distilled context. Within a single turn, the full tool-use message list is maintained (required by the tool-use protocol); across turns, only context carries.

---

# Part 8 — Bedrock integration & configuration

## 8.1 Provider & invocation

AWS Bedrock via the **Converse API** (native tool-use). Model id and region are configured; credentials come from a local `.env` not tracked in the repo. See `.env.example`.

## 8.2 Graceful degradation

If Bedrock is not configured (no creds / `AI_ENABLED=false`), the chat panel and all agent features are **dark**, and the rest of the app runs normally. AI is strictly additive.

## 8.3 Scope boundary

The agent can run functions, apply recipes, and save snapshots. It **cannot** create/edit region annotations or perform subsetting — those stay human-only.

## 8.4 Persistence

- **Context** → persisted to `.zarr.zip` (fed to the model).
- **Visible transcript** → persisted as a human-readable record (not fed to the model).
- Both restored on load; only context + manifest go to Bedrock.

---

# Part 9 — Snapshots

Save the current display as a self-contained, **read-only** HTML view.

## 9.1 Read-only viewer

A **second compiled entry point** sharing the rendering core with the main app, with all editing/menu chrome removed — just the frozen view. The user can still **pan and zoom**; there is no compute, editing, chat, or sidebar.

## 9.2 What is captured

The session **view-state**: active canvas, current region/zoom (camera), channel on/off + names, spot/point styling, image selection, colormap/opacity. (No compute or editing state.)

## 9.3 Files & content-hash dedupe

```
snapshots/
  2026-06-30T14-22-05_tumor-margin.html     # the view + a manifest of which assets it needs
  assets/
    <sha256-of-bytes>.arrow                  # one per data field (coords, color channels, …)
    <sha256-of-bytes>.bin                    # image tiles needed for the captured view
```

- **Folder is the shareable unit**, not the lone HTML (the HTML references sibling `assets/` files).
- **Asset format:** Arrow per data field (matching the main transport); image: only the tiles the captured zoom/region needs, at the relevant pyramid level(s).
- **Filenames are a content hash of the bytes**, so identical fields across multiple snapshots **dedupe** (no duplicate copies) and successive snapshots **never overwrite** older ones.
- `SNAPSHOTS_DIR` is configurable (default `./snapshots`); assets live in its `assets/` subfolder.

## 9.4 Invocation

A **Save snapshot** action (gear menu + a canvas toolbar button), and the agent tool `save_snapshot()` (Part 5).

---

# Part 10 — Image channel controls

(Promoted from a side note to a first-class display feature.)

- **Toggle channels on/off** — per-channel visibility on multi-channel images.
- **Rename channels** — user-assigned display names overriding raw channel indices/labels.

State lives in the **display spec** (v2 Part 9 / app-state), so it persists to `.zarr.zip`, is restored on load, is captured in snapshots (Part 9.2), and appears in the data manifest (Part 3.2) so the agent knows the channel layout.

---

# Part 11 — UI changes

- **Chat panel** — a collapsible **right-side panel** (present only when Bedrock is configured), visible alongside the canvas so the agent's effects on the display are watchable. Includes the **auto-mode toggle**.
- **Approval modals** — center-screen, one per state-changing call, sequential (Part 6.3), with Approve / Edit & approve / Deny(± reason).
- **Channel controls** — in the canvas/display controls (Part 10).
- **Save snapshot** — gear menu + canvas toolbar button.
- The four-tab sidebar (v2 Part 4) is unchanged.

---

# Part 12 — Change list & license note

**Modifies already-built code:**
1. **Schema layer** — JSON Schema becomes the single schema-of-record; frontend forms, Pydantic validation, and the agent interface all derive from it (Part 1). The v2 term dictionary now feeds schema *generation* for library functions.
2. **Executor** — consolidate library execution into the single `library_executor` returning the contract envelope (Part 1.4, Part 2); `keep_failures` added to the contract.
3. **Function layout** — per-function folders; library = manifest only, custom = Zod + python.
4. **Manifest capture** — before/after manifests added to every run.

**Net-new features:**
5. **Data manifest** subsystem (Part 3).
6. **Expanded catalog** — scanpy `pp`/`tl`/`get` + spatialdata-io readers (Part 4).
7. **Agent tool interface** — fixed meta-tools (Part 5).
8. **AI chat** — Bedrock conversation, auto-mode, sequential approval, edit/deny-with-reason (Part 6).
9. **Context management** — self-curated, two-tier compaction (Part 7).
10. **Snapshots** — read-only viewer + content-hashed assets (Part 9).
11. **Image channel** toggle/rename (Part 10).
12. **Governance layer** — skills + CI-enforced rules bundle (`sds-governance/`), wired via one config seam (Part 14).

**License note (Part 9 of v2 still governs):** scanpy and spatialdata-io are BSD-3-Clause (permissive); **scvi-tools is excluded**, so v3 adds **no** torch/CUDA footprint and no new copyleft surface. The Leiden/Louvain GPL chain is unchanged from v2. AWS SDK (`boto3`) is Apache-2.0. Re-run the v2 §9.4 license scan on the new dependency set before distribution.

---

# Part 13 — Build sequence

1. **Schema-of-record** — Zod authoring for custom functions + generation from manifest+term-dictionary for library functions; emit JSON Schema; wire frontend forms + Pydantic from it.
2. **Single library executor + contract** — one executor returning the contract envelope; add `keep_failures`; per-function folders.
3. **Data manifest** — contributor registry + seed contributors; before/after capture in the contract.
4. **Expanded catalog** — scanpy `pp`/`tl`/`get` and spatialdata-io reader manifests; verify type-based injection for AnnData-vs-SpatialData.
5. **Agent tool interface** — the fixed meta-tools; `describe_function` live-option resolution.
6. **Bedrock integration** — Converse client, `.env` config, graceful degradation; `.env.example`.
7. **Context management** — per-turn distillation, token-ceiling consolidation, keep-recent-N, persistence.
8. **Chat UI + approval** — right-side panel, auto-mode, sequential modals (Approve / Edit & approve / Deny±reason), read-only no-gate.
9. **Image channel controls** — toggle/rename in display spec; manifest + snapshot integration.
10. **Snapshots** — read-only viewer entry point, view-state capture, content-hashed Arrow/tile assets, dedupe.
11. **License re-scan** (v2 §9.4) on the new dependency set.
12. **Adopt the governance gate** — wire the `checks/config.py` seams to the real modules, make `make check` green, and gate CI on it (Part 14).

---

# Part 14 — Development governance: skills & rules

To keep the structure and requirements of v1/v2/v3 solid as the catalog and AI surface grow, v3 ships a governance layer with **two deliberately separate parts**:

- **Rules** — invariants enforced by CI, a lint, or a startup assertion, **independent of whether anyone followed a skill**. A rule that depends on memory is not a rule.
- **Skills** — independently-triggerable playbooks for each class of change, each ending by satisfying named rules.

Principle: **skills make the green path obvious; the gate makes the red path unmergeable.** If skills were the only mechanism, the invariants would erode the first change made without one.

Delivered as the **`sds-governance/`** bundle: `AGENTS.md` (prime directives), `RULES.md` (the catalog), `Makefile` (`make check`), `skills/<name>/SKILL.md` (ten playbooks), `checks/` (the executable gate). Everything repo-specific lives behind `# WIRE:` markers in `checks/config.py` — a single seam.

## 14.1 Rules

Each rule cites its origin (v1/v2/v3) and is enforced by a check; the pytest checks **skip** until their seam is wired, so the gate is adoptable incrementally.

| ID | Rule | Enforced by |
|----|------|-------------|
| R1 | No module references a specific library function; reach them only via the registry. | `check_import_graph.py` |
| R2 | The term dictionary defines parameter *terms*, never functions. | `lint_term_dictionary.py` |
| R3 | One schema-of-record drives form + Pydantic + agent. | `test_invariants.py` |
| R4 | Library folder = manifest only; custom folder = `schema.ts` + `run.py`. | `lint_function_folders.py` |
| R5 | Every function returns the contract envelope and respects `keep_failures`. | `test_contracts.py` |
| R6/R7 | Compute is append-only; never `COMPLETED→QUEUED`; rerun appends. | `test_invariants.py` |
| R8 | Effect class explicit; plotting render params `managed`. | manifest schema + `test_contracts.py` |
| R9 | One uvicorn worker; per-worker ceiling < container limit. | startup assertion |
| R10 | State-changing ops are queued mutating jobs under the write lock. | `test_invariants.py` |
| R11 | Agent memory is self-curated context only; transcript never replayed. | `test_invariants.py` |
| R12 | Fixed meta-tools; state-changing gated in auto-off; no annotate/subset. | `test_invariants.py` |
| R13 | Snapshots share the render core; assets content-hashed. | `test_invariants.py` |
| R14 | Every binding type has a widget **and** a `describe_function` resolver. | `test_invariants.py` |
| R15 | Deps permissive or adjudicated; no torch/scvi; scan + SBOM before distribution. | `scan_licenses.py` |
| R16 | Term-dictionary coverage must not regress. | `lint_term_dictionary.py` |

## 14.2 Skills

Each is independently triggerable; the SKILL.md `description` is its trigger.

| Skill | Triggers on | Satisfies |
|-------|-------------|-----------|
| `add-library-function` | adding a squidpy/scanpy/spatialdata-io function | R1, R3, R4, R5, R8, R16 |
| `add-custom-function` | adding an app-defined op (label, subset, comparison, snapshot, recipe-apply) | R3, R4, R5, R8, R10 |
| `extend-term-dictionary` | an unmapped param / new param widget or binding | R2, R16 |
| `add-binding-type` | a new data-slot type beyond the binding vocabulary | R14 |
| `add-manifest-contributor` | the agent needs to "see" new session state | manifest extensibility |
| `add-display-type` | a new visualization/encoding (e.g. faceted small-multiples) | R13 |
| `add-official-recipe` | a bundled recipe adapted from a vignette/paper | recipe portability + R5 |
| `upgrade-library` | bumping squidpy/scanpy/spatialdata(-io) or npm | R1, R3, R5, R15, R16 |
| `change-agent-behavior` | modifying the chat loop, tools, approval, or context | R11, R12 |
| `release-readiness` | preparing a build/image for distribution | R9, R13, R15 |

## 14.3 Enforcement gate

`make check` runs `static` (R1/R2/R4/R16 — no imports, work immediately against the file tree) + `tests` (R3/R5–R14 — pytest, skip-until-wired) + `licenses` (R15 + SBOM). It runs the same way every change and **blocks merge** on failure.

The **contract smoke test (R5)** is the highest-value check: it runs every registered function against a synthetic SpatialData fixture and asserts the envelope, that AI-run failures are excluded from history but surfaced to the agent, and that plotting calls produce a figure without mutating. Functions whose smoke inputs can't be synthesized are reported as **visible skips**, not silent passes — enriching the fixture to close those skips is ongoing regression-coverage work.

The **license gate (R15)** reads installed package metadata, fails on torch/scvi or un-adjudicated copyleft, and emits a CycloneDX SBOM. `license_allowlist.yaml` is the durable record of the v2 §9.3 clustering decision; the `release-readiness` skill blocks distribution while that decision is still a `TODO`.

## 14.4 Repo integration

`AGENTS.md` at the repo root is the prime-directives file an agent or new contributor reads first. When a change has no matching skill, it may warrant a **new rule** — added to `RULES.md` **with an enforcement check**, never prose alone, because suggestions erode and checks don't.
