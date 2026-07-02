"""The fixed agent meta-tools (v3 Part 5).

The LLM is given a small, stable set of tools *over* the catalog rather than one
tool per function — so the surface doesn't grow with the registry and never
shadows it. Read-only tools run with no approval; state-changing tools are gated
by the chat loop (Part 6). Region annotation and subsetting are deliberately NOT
exposed (R12) — they stay human-only canvas workflows.
"""
from __future__ import annotations

from ..registry.introspect import REGISTRY
from ..transport import arrow

# bound_to (from the term dictionary) -> how describe_function resolves live options
_BIND_FACET = {"obs_categorical": "obs_categorical", "obs": "obs", "obsm": "obsm",
               "obsp": "obsp", "layers": "layers", "var_names": "var_names"}


def _tool(name, description, properties, required, state_changing):
    return {"name": name, "description": description, "state_changing": state_changing,
            "input_schema": {"type": "object", "properties": properties, "required": required}}


# Fixed tool specs (Part 5.1). input_schema is JSON Schema; the Bedrock client wraps
# these into Converse toolConfig.toolSpec entries.
TOOL_SPECS = [
    _tool("list_functions", "List available functions (name + one-line summary). "
          "Optionally filter by a namespace or keyword substring.",
          {"filter": {"type": "string", "description": "namespace or keyword substring"}}, [], False),
    _tool("describe_function", "Full JSON Schema for one function, plus the currently "
          "valid option lists for its dynamic params (obs columns, genes, embeddings).",
          {"name": {"type": "string", "description": "function key, e.g. sc.tl.leiden"}}, ["name"], False),
    _tool("get_data_manifest", "The current data manifest: tables, obs columns and their "
          "categories with counts, embeddings, region sets, images.", {}, [], False),
    _tool("list_recipes", "List bundled/available analysis recipes with their descriptions.",
          {}, [], False),
    _tool("list_snapshots", "List saved read-only snapshots of the view.", {}, [], False),
    _tool("run_function", "Run a function in the current session under the contract. "
          "Params must conform to the function's schema (use describe_function first).",
          {"name": {"type": "string"}, "params": {"type": "object"}}, ["name"], True),
    _tool("apply_recipe", "Apply a recipe: run it now or stage its steps as pending.",
          {"name": {"type": "string"}, "mode": {"type": "string", "enum": ["run", "stage"]}}, ["name"], True),
    _tool("save_snapshot", "Save the current view as a read-only shareable snapshot.",
          {"label": {"type": "string"}}, [], True),
]
_BY_NAME = {t["name"]: t for t in TOOL_SPECS}


def is_state_changing(name: str) -> bool:
    return _BY_NAME.get(name, {}).get("state_changing", True)


# ---- read-only tools --------------------------------------------------------

def list_functions(session, filter: str | None = None) -> dict:
    q = (filter or "").lower()
    out = []
    for e in REGISTRY.entries.values():
        if e.effect_class == "read":
            continue  # readers create sessions; not runnable in-session by the agent
        label = e.label or e.key
        if q and q not in e.key.lower() and q not in (e.summary or "").lower() and q not in label.lower():
            continue
        out.append({"name": e.key, "label": label, "effect_class": e.effect_class,
                    "summary": e.summary or ""})
    return {"functions": out}


def describe_function(session, name: str) -> dict:
    e = REGISTRY.get(name)
    if e is None:
        return {"error": f"unknown function '{name}'"}
    pub = e.to_public()
    return {"name": e.key, "label": e.label, "effect_class": e.effect_class,
            "summary": e.summary, "doc": e.doc, "json_schema": pub["json_schema"],
            "options": _live_options(e, session)}


def _live_options(entry, session) -> dict:
    with session.lock.reading():
        try:
            adata = session.active_table()
        except RuntimeError:
            return {}
        fields = arrow.describe_fields(adata, session.sdata)
    cat = [f["name"] for f in fields["obs"] if f["kind"] == "categorical"]
    allobs = [f["name"] for f in fields["obs"]]
    opts = {}
    for p in entry.params:
        facet = _BIND_FACET.get(p.bound_to or "")
        if facet == "obs_categorical":
            opts[p.name] = cat
        elif facet == "obs":
            opts[p.name] = allobs
        elif facet in ("obsm", "obsp", "layers"):
            opts[p.name] = fields.get(facet, [])
        elif facet == "var_names":
            opts[p.name] = {"count": fields.get("var_names_count", 0),
                            "sample": fields.get("var_names_sample", [])}
    return opts


def get_data_manifest(session) -> dict:
    from ..manifest import build_manifest
    with session.lock.reading():
        return {"manifest": build_manifest(session)}


def list_recipes(session) -> dict:
    from .. import recipes
    return {"recipes": recipes.list_recipes()}


def list_snapshots(session) -> dict:
    from .. import snapshots
    return {"snapshots": snapshots.list_snapshots()}


# ---- state-changing tools (gated by the chat loop) --------------------------

def run_function(session, name: str, params: dict | None = None) -> dict:
    e = REGISTRY.get(name)
    if e is None:
        return {"status": "failed", "error": f"unknown function '{name}'"}
    if e.effect_class == "read":
        return {"status": "failed", "error": "readers create sessions; not runnable here"}
    descriptor = {"namespace": e.namespace, "function": e.function, "params": params or {}}
    return session.run_and_wait(descriptor, keep_failures=False)


def apply_recipe(session, name: str, mode: str = "run") -> dict:
    from .. import recipes
    return recipes.apply_recipe(session, name, mode)


def save_snapshot(session, label: str | None = None) -> dict:
    from .. import snapshots
    return snapshots.save_snapshot(session, label)


_READ_ONLY = {"list_functions": list_functions, "describe_function": describe_function,
              "get_data_manifest": get_data_manifest, "list_recipes": list_recipes,
              "list_snapshots": list_snapshots}
_STATE_CHANGING = {"run_function": run_function, "apply_recipe": apply_recipe,
                   "save_snapshot": save_snapshot}


def run_tool(name: str, args: dict, session) -> dict:
    """Execute a meta-tool by name. The chat loop gates state-changing tools before
    calling this; read-only tools may be called freely."""
    fn = _READ_ONLY.get(name) or _STATE_CHANGING.get(name)
    if fn is None:
        return {"error": f"unknown tool '{name}'"}
    return fn(session, **(args or {}))
