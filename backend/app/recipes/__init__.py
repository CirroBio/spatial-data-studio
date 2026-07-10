"""Curated analysis recipes — discovered from JSON bundle files in this directory
(post-build spec §5.1/§5.2) rather than hardcoded, so adding one is "drop a file."
Exposed to the AI agent (list_recipes/apply_recipe tools) and to the UI
(GET /api/recipes -> run via /recipe/run). The app also supports ad-hoc recipe
export/import over the current history (see main.py /recipe endpoints).

Each bundle's `steps` are the same {namespace, function, params} descriptors used
everywhere (core spec §4.5); `requires` (spec §5.8) is re-derived at preflight time
rather than stored, so it can't drift from the installed registry.

Recipe-level parameters (optional `params`): a recipe can declare its own
parameters — the same {name, schema, widget, bound_to, required, tooltip} shape as
a function's ParamSpec (registry/base.py), with the default carried in
`schema.default`. A step param value of the form {"$param": "<name>"} is replaced
by the resolved recipe-param value before the step runs (dropped if it resolves to
None, matching the None-param rule). One recipe param can feed several steps, and
can feed a produced key plus its consumers (e.g. custom.leiden's `key_added` and
sc.tl.paga's `groups`). `resolve_steps` performs the substitution and is shared by
the HTTP endpoint and the offline CLI so resolution can't diverge.

Two families ship, filenames numbered for a stable gallery order:
  * squidpy spatial recipes for the `visium_hne` example (a Visium H&E mouse-brain
    section): hexagonal grid (coord_type="grid", n_neighs=6), a named brain-region
    annotation in obs["cluster"], spatial coords in obsm["spatial"], already
    log-normalised X.
  * scanpy recipes for unprocessed (raw-count) data such as Xenium: normalize ->
    log1p -> PCA -> neighbors -> Leiden (-> UMAP / markers / spatial), keyed on the
    obs["leiden"] they produce.

App constraints honoured: spatial_autocorr omits n_perms (the permutation path uses
joblib's process pool, which can't spawn on the worker thread); no spatial_scatter/
spatial_segment plots (the table lacks uns["spatial"]); every spatial-graph step is
preceded by spatial_neighbors in the same recipe.
"""
from __future__ import annotations

import json
from pathlib import Path

_RECIPES_DIR = Path(__file__).parent


def _load_bundled() -> dict[str, dict]:
    bundled = {}
    for path in sorted(_RECIPES_DIR.glob("*.json")):
        recipe = json.loads(path.read_text())
        bundled[recipe["meta"]["name"]] = recipe
    return bundled


_BUNDLED: dict[str, dict] = _load_bundled()


def _step_enums(recipe: dict) -> dict[str, list]:
    """For each recipe param fed to a registry-function param via {"$param": ...},
    the `enum` that function computes for that param (empty when it has none).
    Lets a recipe param inherit a dynamic choice list (e.g. custom.celltypist_annotate's
    model catalogue) instead of hardcoding one that would drift from the registry."""
    from ..registry.introspect import REGISTRY
    enums = {}
    for step in recipe.get("steps", []):
        entry = REGISTRY.get(f"{step.get('namespace')}.{step.get('function')}")
        if entry is None:
            continue
        props = entry.json_schema().get("properties", {})
        for target, val in step.get("params", {}).items():
            if isinstance(val, dict) and list(val.keys()) == ["$param"]:
                choices = props.get(target, {}).get("enum")
                if choices:
                    enums[val["$param"]] = choices
    return enums


def _json_schema(recipe: dict) -> dict:
    """{type, properties, required} built from the recipe's declared params —
    same shape as Function.json_schema (registry/base.py), so the frontend
    FunctionForm renders a recipe's params exactly like a function's. A param
    lacking an `enum` inherits one from the registry function it feeds, so a
    `select` widget gets its choices from the live registry (see _step_enums)."""
    inherited = _step_enums(recipe)
    props, required = {}, []
    for p in recipe.get("params", []):
        schema = dict(p["schema"])
        if "enum" not in schema and p["name"] in inherited:
            schema["enum"] = inherited[p["name"]]
        props[p["name"]] = schema
        if p.get("required"):
            required.append(p["name"])
    return {"type": "object", "properties": props, "required": required}


def _ui_schema(recipe: dict) -> dict:
    return {p["name"]: {"widget": p["widget"], "bound_to": p.get("bound_to"),
                        "tooltip": p.get("tooltip", "")}
            for p in recipe.get("params", [])}


def _param_values(recipe: dict, values: dict | None) -> dict:
    """Declared defaults, overridden by any caller `values` naming a declared param."""
    resolved = {p["name"]: p.get("schema", {}).get("default") for p in recipe.get("params", [])}
    if values:
        for name, val in values.items():
            if name in resolved:
                resolved[name] = val
    return resolved


def resolve_steps(recipe: dict, values: dict | None = None) -> list[dict]:
    """Substitute the recipe's parameter values into each step's params. A step
    param value of the form {"$param": "<name>"} becomes the resolved value for
    that recipe param (dropped if it resolves to None). All other values pass
    through unchanged, so a recipe with no `params` resolves to itself."""
    resolved = _param_values(recipe, values)
    steps = []
    for step in recipe.get("steps", []):
        params = {}
        for name, val in step.get("params", {}).items():
            if isinstance(val, dict) and list(val.keys()) == ["$param"]:
                sub = resolved.get(val["$param"])
                if sub is None:
                    continue
                params[name] = sub
            else:
                params[name] = val
        steps.append({**step, "params": params})
    return steps


def list_recipes() -> list[dict]:
    return [{"name": n, "description": r["meta"].get("description", "")} for n, r in _BUNDLED.items()]


def catalog() -> list[dict]:
    """Full recipes (steps + declared params) — for the UI's recipe gallery.
    `json_schema`/`ui_schema` let the gallery render the param form via the same
    FunctionForm the picker uses."""
    return [{"name": n, "description": r["meta"].get("description", ""),
             "steps": r["steps"], "params": r.get("params", []),
             "json_schema": _json_schema(r), "ui_schema": _ui_schema(r)}
            for n, r in _BUNDLED.items()]


def run_steps(session, steps: list, mode: str) -> int:
    """Stage (mode='stage') or run-now each step descriptor; returns the count run.
    Steps are already resolved (see resolve_steps). Shared by a bundled recipe
    (apply_recipe) and an ad-hoc imported one (main.py's /recipe/run, exported via
    GET /recipe)."""
    n = 0
    for step in steps:
        session.stage_descriptor(step) if mode == "stage" else session.enqueue_descriptor(step)
        n += 1
    return n


def apply_recipe(session, name: str, mode: str = "run", param_values: dict | None = None) -> dict:
    recipe = _BUNDLED.get(name)
    if recipe is None:
        return {"status": "failed", "error": f"no recipe named '{name}'"}
    n = run_steps(session, resolve_steps(recipe, param_values), mode)
    return {"status": "completed", "staged" if mode == "stage" else "queued": n}
