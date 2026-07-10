# Contributing to Spatial Data Studio

Thanks for extending Spatial Data Studio. This guide is written for **data
scientists** — you know Python, pandas, scanpy/squidpy, and how to read an
`AnnData` — but you do **not** need to be a software engineer to contribute. Fork
the repo, follow one of the two recipes below, run the one-line check, and open a
PR.

There are exactly two ways to add analysis capability, and they are very
different in effort:

| You want to… | Contribute a… | Effort | What you write |
| --- | --- | --- | --- |
| Chain existing operations into a named, reusable workflow | **Recipe** | Low | One JSON file |
| Add a brand-new analysis or plot that doesn't exist yet | **Custom function** | Higher | One Python file + a few coupled edits |

**If your idea can be expressed as a sequence of operations that already exist in
the app, write a recipe.** It is just JSON, there is no Python to write, and it
is far easier to review and merge. Only write a custom function when the
computation itself does not yet exist.

---

## Orientation: function vs. recipe

- A **function** is a single runnable operation — one entry in the operation
  picker with a parameter form. Most functions are discovered automatically by
  introspecting `squidpy`/`scanpy` (you never touch those). A **custom function**
  is a hand-written `Function` subclass under
  `backend/app/registry/custom/` for analysis those libraries don't provide.
- A **recipe** is a named, ordered list of function calls (`steps`) with its own
  optional parameters. Applying a recipe stages/queues each step in order. Recipes
  live as JSON files in `backend/app/recipes/`.

Both present identically to the frontend: a recipe's params render through the
same form as a function's params.

---

## Add a recipe (the easy path)

A recipe is a single JSON file. No Python, no registration — the loader
(`backend/app/recipes/__init__.py` → `_load_bundled()`) auto-discovers every
`*.json` in the directory at startup.

### 1. Create the file

Path and name: `backend/app/recipes/NN_short_name.json`

- `NN` is a **two-digit order prefix** (e.g. `06`) that sets the position in the
  recipe gallery. Look at the existing files and pick the next number, or a number
  that groups your recipe near related ones.
- Keep the rest short and lowercase with underscores.

### 2. Fill in the shape

Every recipe has this structure (see
`backend/app/recipes/05_composition_by_region.json` for a real one):

```json
{
  "schema_version": 1,
  "meta": {
    "name": "Cluster and embed (Leiden + UMAP)",
    "description": "One-line summary shown in the recipe gallery.",
    "provenance": "Where this workflow comes from — a paper, a tutorial, or 'original to this repository'."
  },
  "readme": "A paragraph the user reads before running it: what it assumes about the data, what it produces, and which param to set.",
  "params": [
    {
      "name": "resolution",
      "schema": { "type": "number", "default": 1.0 },
      "widget": "number",
      "bound_to": null,
      "required": false,
      "tooltip": "higher = more, smaller clusters"
    },
    {
      "name": "cluster_key",
      "schema": { "type": "string", "default": "leiden" },
      "widget": "text",
      "bound_to": null,
      "required": true,
      "tooltip": "obs column the clusters are written to"
    }
  ],
  "steps": [
    { "namespace": "sc.pp", "function": "neighbors", "params": {} },
    { "namespace": "custom", "function": "leiden",
      "params": { "resolution": { "$param": "resolution" },
                  "key_added":  { "$param": "cluster_key" } } },
    { "namespace": "sc.tl", "function": "umap", "params": {} }
  ]
}
```

Field notes:

- `meta.name` must be **unique** — it is the recipe's key. `meta.description` and
  `meta.provenance` are both required by convention; `provenance` is your
  citation for the workflow.
- `readme` is user-facing prose. Write it for the person about to click "run".
- `params` is optional and uses the **same shape as a function parameter**
  (`name`, `schema`, `widget`, `bound_to`, `required`, `tooltip`), with the
  default carried in `schema.default`. Set `"bound_to": null` — the widget alone
  drives the picker (use `"obs_categorical"` for a column the recipe consumes).
  If a param feeds a `select`/enum function param, you can omit `enum` from its
  `schema` — it is inherited from the registry function it feeds.
- `steps` is a list of `{namespace, function, params}` descriptors — the same
  descriptors used everywhere in the app. `namespace`+`function` must name a real
  registered operation (e.g. `sc.pp.neighbors`, `custom.leiden`,
  `custom.region_composition`).

### 3. Understand `$param` substitution

A step param value of the form `{"$param": "<name>"}` is replaced, before the step
runs, by the resolved value of the recipe param named `<name>`
(`resolve_steps` in `recipes/__init__.py`). Rules:

- **If a `$param` resolves to `None`, that step param is dropped** (the function
  then uses its own default). This is how optional params work.
- **One recipe param can feed several steps** — e.g. a single `cluster_key` can
  fill both `custom.leiden`'s `key_added` (the column it produces) and a later
  step's `groups` (a consumer of that column). This keeps produced/consumed keys
  in sync.
- Any value that is **not** a `{"$param": ...}` object passes through unchanged, so
  a recipe with no `params` at all is valid — its steps run as written.

That's it. Run the validation command (below) and open the PR.

---

## Add a custom function (the fuller path)

A custom function is a `Function` subclass (the ABC is in
`backend/app/registry/base.py`). Adding one touches **several coupled files** — if
you skip one, the app won't see your function or the provenance test will fail.
Work through this checklist.

### Checklist

1. **New file** `backend/app/registry/custom/<name>.py` defining a `Function`
   subclass.
2. **Class identity attributes** (all required):
   `source = "custom"`, `key` (e.g. `"custom.foo"` — must be unique across all
   custom functions), `namespace = "custom"`, `function` (e.g. `"foo"`),
   `effect_class` (`compute` or `plot`; a `read` importer is the rare third case),
   `label` (human title), `summary` (one line), `doc` (help text),
   `params` (a `list[ParamSpec]`).

   **Do not use `extract`** for a custom function: it is reserved for the
   reflected-library agent path and has no way to hand its return value to the
   user, so the self-check rejects it. To return a table or numeric results, write
   a `compute` that stores them in `uns` — see [Returning a table / numeric
   results](#returning-a-table--numeric-results) below.
3. **Provenance attributes** (required — enforced by `backend/test_e2e.py`):
   `citation` (a text reference: paper, tutorial, or "original to this
   repository") and `documentation = custom_doc("<anchor>")` (imported from
   `._docs`).
4. **`params`** — each is a `ParamSpec` (see below).
5. **`execute(self, params: dict, session) -> CallResult`** — implement using the
   right helper: `run_compute` for a `compute`, `render_plot` for a `plot`.
6. **Nothing to register.** Your file is auto-discovered — dropping it in
   `custom/` is all it takes (see [Register it](#register-it) below). No
   `__init__.py` edit.
7. **Document** in `backend/app/registry/custom/README.md`: add a section whose
   GitHub heading anchor equals the string you passed to `custom_doc(...)`.

### ParamSpec

Build each parameter with a **named-intent constructor** — one classmethod per
common parameter kind. Each one bakes in the correct widget and JSON-Schema
skeleton, so you pick your intent and the form can't be handed anything it can't
render (`ParamSpec` lives in `backend/app/registry/base.py`):

| Constructor | Widget | Use for |
| --- | --- | --- |
| `ParamSpec.obs_categorical(name, *, required, tooltip)` | picker over categorical obs columns | a cluster/region/cell-type column you **consume** |
| `ParamSpec.obs_column(name, *, required, tooltip)` | picker over all obs columns | any obs column |
| `ParamSpec.obsm_key(name, *, default="spatial", required, tooltip)` | picker over obsm keys | coordinates / an embedding |
| `ParamSpec.number(name, *, default, required, tooltip, integer=False)` | numeric input | a float; pass `integer=True` for an int |
| `ParamSpec.text(name, *, default="", required, tooltip, output=False)` | free text | a name/label; pass `output=True` for a column the step **creates** (e.g. `key_added`) |
| `ParamSpec.choice(name, choices, *, default, required, tooltip)` | dropdown | a fixed set of string options |
| `ParamSpec.flag(name, *, default=False, required, tooltip)` | checkbox | a boolean toggle |

```python
params = [
    ParamSpec.obs_categorical("group_key", required=True,
                              tooltip="categorical obs column to operate on"),
    ParamSpec.number("resolution", default=1.0, tooltip="higher = more, smaller clusters"),
    ParamSpec.text("key_added", default="my_result", required=True, output=True,
                   tooltip="obs column to write results into"),
]
```

Notes:

- **You never set `bound_to`.** The picker's options come from the *widget*
  alone; `bound_to` is only meaningful for the `obs_value_map` editor and is set
  for you. The self-check (below) rejects any other use.
- Set `output=True` (via `ParamSpec.text`) for a param that **names a slot the
  step creates** — `key_added` and friends. Everything else stays an input.
- The positional constructor `ParamSpec(name, schema, widget, bound_to, ...)`
  still exists for the rare param the factories don't cover (e.g. the
  `obs_value_map` editor in `edit_annotations.py`), but the factories are the
  recommended path.

### The widget vocabulary (closed set)

`widget` is a **closed set**: the self-check rejects any value outside it. The
authoritative list is the `WIDGETS` frozenset in `base.py`, mirrored from the
frontend's `UiWidget` union so the form can always render what you pick — this
is the whole list, not a sample. The named-intent constructors cover the common
widgets; for the rest, use the positional `ParamSpec(...)` and pass the widget
string yourself.

| Widget | Constructor | Renders |
| --- | --- | --- |
| `checkbox` | `.flag(...)` | a boolean toggle |
| `number` | `.number(...)` | a numeric input (int if `integer=True`) |
| `text` | `.text(...)` | a free-text field |
| `select` | `.choice(...)` | a dropdown over a fixed `schema.enum` |
| `obs_categorical` | `.obs_categorical(...)` | picker over categorical obs columns |
| `obs_key` | `.obs_column(...)` | picker over all obs columns |
| `obsm_key` | `.obsm_key(...)` | picker over obsm keys (embeddings/coords) |
| `var_names` | positional | picker over var (gene) names |
| `layer_key` | positional | picker over `layers` keys |
| `obsp_key` | positional | picker over `obsp` keys |
| `library_id` | positional | picker over spatial `library_id`s |
| `multitext` | positional | a list of free-text values |
| `obs_value_map` | positional | the category rename/merge editor — the **only** widget that uses `bound_to` |
| `json` | positional | a raw JSON input |

### Skeleton — a `compute` function

Adapted from `custom/cluster_leiden.py`. A compute mutates the active `AnnData`
in place; `run_compute` captures logs and computes the structural diff for you.

```python
"""One-line module docstring: what this computes and any prerequisite step."""
from __future__ import annotations

from ..base import Function, ParamSpec, CallResult, run_compute, missing_obs_column
from ._docs import custom_doc

_DOC = """My analysis

What it does, in prose. Note any step that must run first.

Parameters
----------
group_key
    Categorical obs column to operate on.
key_added
    Name of the obs column results are written to.
"""


class MyCompute(Function):
    source = "custom"
    key = "custom.my_compute"
    namespace = "custom"
    function = "my_compute"
    effect_class = "compute"
    label = "My analysis"
    summary = "One-line summary shown in the picker."
    doc = _DOC
    citation = "Author et al. Journal (Year). doi:... — or 'original to this repository'."
    documentation = custom_doc("my-analysis")   # anchor MUST match the README heading

    params = [
        ParamSpec.obs_categorical("group_key", required=True,
                                  tooltip="categorical obs column to operate on"),
        ParamSpec.text("key_added", default="my_result", required=True, output=True,
                       tooltip="obs column to write results into"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        group_key = params.get("group_key")
        key_added = (params.get("key_added") or "my_result").strip()

        adata = session.active_table()
        # Validate at the boundary, then trust your invariants.
        error = missing_obs_column(adata, group_key)
        if error:
            return CallResult(status="failed", error=error)

        def mutate(ad):
            ad.obs[key_added] = ...  # your computation, writing into the AnnData

        return run_compute(session, mutate)
```

Notes:

- `session.active_table()` returns the working `AnnData`.
- Do your validation up front and return `CallResult(status="failed", error=...)`
  with a clear message; let unexpected errors propagate — `run_compute` catches
  them, captures the traceback into the log, and returns a `failed` result.
- Everything your `mutate` writes into `obs`/`obsm`/etc. is detected
  automatically; you do not build the diff yourself.

### Returning a table / numeric results

Some analyses produce a derived table (e.g. a per-cluster summary) or a numeric
result rather than a per-cell column. The supported way to hand that to the user
is a **`compute`** that writes the result into `adata.uns` under a key you choose;
the user retrieves it by exporting the session and reading it back in pandas.

**Do not use `effect_class = "extract"` for this** — `extract` is wired only for
the reflected-library agent path and has no way to surface a custom function's
return value in the UI. The self-check rejects a custom `extract`, and there is
no `run_extract` helper. Write a `compute` instead:

```python
def execute(self, params: dict, session) -> CallResult:
    key_added = (params.get("key_added") or "my_table").strip()

    def mutate(ad):
        import pandas as pd
        summary = pd.DataFrame({...})     # your derived table
        ad.uns[key_added] = summary       # a DataFrame or a plain dict

    return run_compute(session, mutate)   # the uns write is detected + reported
```

Use `ParamSpec.text(..., output=True)` for the `key_added` param so the picker
marks it as a slot the step creates. `region_feature_kruskal.py` is the worked
example — a `compute` that stores a per-cell-type results dict in
`uns[key_added]`, paired with a `plot` that reads it back.

**Retrieving the result.** There is no in-app "download table" button yet. The
user saves or exports the session (checkpoint, snapshot, or Cirro upload) and
reads the object back in pandas:

```python
import spatialdata as sd
sdata = sd.read_zarr("my_session.zarr")   # or the extracted .zarr.zip
adata = sdata.tables["table"]
adata.uns["my_table"]                       # your DataFrame / dict, back again
```

What survives this round-trip (verified against the checkpoint save/reload path):

- A **pandas DataFrame** comes back as a DataFrame with column names and dtypes
  intact (including `category` columns).
- A **dict** comes back as a dict; nested dicts are preserved, **but** lists come
  back as NumPy arrays and Python scalars as NumPy scalars (`np.int64`/`np.float64`
  /`np.str_`). Compare/consume accordingly (`np.asarray(...).tolist()` to
  re-flatten). Every dict key must be a **string**.
- Keep values plain (numbers, strings, lists, nested dicts, DataFrames, ndarrays).
  Arbitrary Python objects are not serializable by the zarr writer.

### Skeleton — a `plot` function

Adapted from `custom/region_composition.py`. A plot builds a matplotlib
figure; `render_plot` runs your plotting callable under the global pyplot lock and
captures SVG + PDF.

```python
"""One-line module docstring: what this plots."""
from __future__ import annotations

from ..base import CallResult, Function, ParamSpec, capture_log, missing_obs_column, render_plot
from ._docs import custom_doc


class MyPlot(Function):
    source = "custom"
    key = "custom.my_plot"
    namespace = "custom"
    function = "my_plot"
    effect_class = "plot"
    label = "My plot"
    summary = "One-line summary shown in the picker."
    doc = """My plot

    What it draws and how to read it.
    """
    citation = "Original to this repository (describe the method briefly)."
    documentation = custom_doc("my-plot")   # anchor MUST match the README heading

    params = [
        ParamSpec.obs_categorical("group_key", required=True,
                                  tooltip="categorical obs column to plot by"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        import pandas as pd  # import heavy/plotting deps inside execute

        group_key = params.get("group_key")
        adata = session.active_table()
        error = missing_obs_column(adata, group_key)
        if error:
            return CallResult(status="failed", error=error)

        def fn(ad):
            ax = ...  # build and return a matplotlib Axes (or Figure)
            return ax

        with capture_log() as buf:
            return render_plot(fn, [adata], {}, buf)
```

Notes:

- `render_plot(fn, injected, bound, buf)` calls `fn(*injected, **bound)`. Pass the
  `AnnData` positionally via `injected=[adata]`; use `bound` for keyword args.
- Return the `Axes`/`Figure` from `fn`; `render_plot` finds the figure, saves SVG
  and PDF, and closes all figures. Do **not** call `plt.show()`.
- Import matplotlib/plotting/heavy libraries **inside** `execute`, not at module
  top level, to keep registry import fast.

### Register it

Nothing to wire up — just drop your `.py` file in
`backend/app/registry/custom/`. It's auto-discovered, exactly like a recipe (drop
a JSON file in `recipes/`): `custom/__init__.py` scans every `custom/*.py` module
and instantiates every concrete `Function` subclass into `CUSTOM_FUNCTIONS`. No
import line, no list edit.

Details of the scan (rarely need to think about them):

- A leading-underscore file (`_helpers.py`) is skipped, so private helper modules
  don't register — use this for shared code a function imports.
- A class registers only if it's defined **in that file** and is a concrete
  `Function` subclass. Imported-in classes, abstract bases, and non-`Function`
  helper classes are ignored, so you can freely import `Function` and define
  helper classes alongside your function.
- The picker lists custom functions in filename order, then definition order
  within a file (so a compute defined above its plot shows first). To nudge a
  function's position, rename the file (recipes use numeric prefixes for the same
  reason).
- Instances are built with `cls()` — a `Function` takes no constructor arguments;
  its identity lives in the class attributes above.

### Document it

Add a section to `backend/app/registry/custom/README.md`. The section heading's
GitHub anchor (lowercased, spaces → hyphens, punctuation dropped) **must equal**
the argument you passed to `custom_doc(...)`. For example
`documentation = custom_doc("my-analysis")` requires a heading like
`## My analysis` (which GitHub slugs to `my-analysis`). Write the section for a
user: what the method does, what it assumes, and how to read the result.

### Heavy / third-party code

If your function needs a substantial third-party implementation that isn't already
a dependency, vendor it **unmodified** under
`backend/app/registry/custom/_vendor/` and import from there, rather than adding a
new top-level dependency. Bring this up in your PR description.

---

## Before you open the PR

Run the one-command check from `backend/`:

```bash
cd backend
./check-contribution.sh
```

It builds the registry, runs the custom-function **self-check** (every param
widget/`effect_class`/`role` is in the closed vocabulary; `bound_to` is unset
except for `obs_value_map`; every custom `key` is unique and equals
`namespace.function`; every `custom_doc(...)`
anchor resolves to a heading in `custom/README.md`), asserts every function
carries a non-empty `citation` and `documentation`, and confirms the recipes
load. Any problem is printed as a named line, e.g.:

```
Custom-function self-check FAILED:
  - duplicate custom key 'custom.foo' declared by: MyCompute, OtherCompute
  - custom.my_compute: documentation anchor '#my-analisis' has no matching heading in custom/README.md
```

Expect a line like `OK 97 functions 25 recipes` — the counts should go **up** by
what you added, with zero missing provenance. (Baseline before any contribution:
96 functions, 24 recipes.) If the venv is missing, the script prints how to
create it.

Then confirm:

- [ ] **Provenance is set.** Custom function: `citation` and `documentation` on
      the class, and the README section anchor matches `custom_doc(...)`. Recipe:
      `meta.provenance` filled in. (You do **not** set provenance on
      squidpy/scanpy library functions — they inherit it from
      `registry/library_meta.yaml`.)
- [ ] **Docs stay accurate.** Per the project rules (`CLAUDE.md`), if your change
      alters a user-facing feature, endpoint, run command, env var, or the
      directory layout, update `README.md` **in the same commit**. Adding a recipe
      or a custom function that shows up in the picker/gallery generally means a
      mention in `README.md`. Keep this `CONTRIBUTING.md` accurate too if you
      change the contribution flow.
- [ ] **You reused, not duplicated.** Before adding a new helper, param widget, or
      obs-column picker, check whether one already exists and adapt it (e.g. the
      `obs_categorical` widget, `missing_obs_column`, `custom_doc`). A new element
      is justified only when the behavior is genuinely different.
- [ ] **Worker/process-pool constraint.** The app runs functions on a worker
      thread where **joblib/multiprocessing process pools cannot spawn**. Do not
      rely on process-pool parallelism (e.g. squidpy's `spatial_autocorr`
      `n_perms` permutation path). Also avoid plots that assume `uns["spatial"]`
      (`spatial_scatter`/`spatial_segment`) on app sessions.
- [ ] **You ran it against real data.** The gate validates structure but does not
      execute your function. Launch the app with `./run.sh` (from the repo root),
      open a session, and actually run your function/recipe once — it's the only way
      to catch the runtime-only issues above.

---

## Common mistakes / gotchas

- **Duplicate custom `key`.** Two custom classes declaring the same `key` collide
  — one silently overwrites the other in the registry. The self-check reports it
  as a named line. Keys must be unique across all custom functions.
- **Naming your file with a leading underscore.** `_my_compute.py` is treated as a
  private helper module and is **not** discovered, so your function never appears.
  Use a leading underscore only for helper modules you import from a real one.
- **README anchor mismatch.** `custom_doc("foo-bar")` must correspond to a heading
  in `custom/README.md` that GitHub slugs to `foo-bar`. `check-contribution.sh`
  resolves every anchor against the headings and fails with a named line if one
  doesn't match, so a typo is caught before it ships as a dead link.
- **Non-unique recipe name.** `meta.name` is the recipe's dictionary key; two
  recipes with the same name silently collide (last one wins).
- **Empty `citation`/`documentation` on a custom function.** This fails the gate
  immediately. Every custom function needs both.
- **Setting provenance on library functions.** Don't. squidpy/scanpy/etc. get
  `citation`/`documentation` from `registry/library_meta.yaml` automatically;
  hardcoding per-function contradicts the project rule.
- **`plt.show()` or leaking figures in a plot.** Return the `Axes`/`Figure` from
  your `fn` and let `render_plot` handle rendering and cleanup.
- **Heavy imports at module top level.** Import matplotlib/scipy/etc. inside
  `execute` so registry startup stays fast.
- **Using a squidpy function name you assume exists.** Operations are discovered
  by introspection; confirm the `namespace.function` you reference in a recipe
  actually appears in the registry (the gate will build it — check your step names
  resolve).
- **`$param` silently dropped.** A `$param` resolving to `None` drops the step
  param. If a step seems to ignore your recipe param, check that the param has a
  non-`None` default or that the caller supplied a value.
