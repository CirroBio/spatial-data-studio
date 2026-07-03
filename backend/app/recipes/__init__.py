"""Curated analysis recipes — discovered from JSON bundle files in this directory
(post-build spec §5.1/§5.2) rather than hardcoded, so adding one is "drop a file."
Exposed to the AI agent (list_recipes/apply_recipe tools) and to the UI
(GET /api/recipes -> run via /recipe/run). The app also supports ad-hoc recipe
export/import over the current history (see main.py /recipe endpoints).

Each bundle's `steps` are the same {namespace, function, params} descriptors used
everywhere (core spec §4.5); `requires` (spec §5.8) is re-derived at preflight time
rather than stored, so it can't drift from the installed registry.

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


def list_recipes() -> list[dict]:
    return [{"name": n, "description": r["meta"].get("description", "")} for n, r in _BUNDLED.items()]


def catalog() -> list[dict]:
    """Full recipes (including steps) — for the UI's recipe gallery."""
    return [{"name": n, "description": r["meta"].get("description", ""), "steps": r["steps"]}
            for n, r in _BUNDLED.items()]


def apply_recipe(session, name: str, mode: str = "run") -> dict:
    recipe = _BUNDLED.get(name)
    if recipe is None:
        return {"status": "failed", "error": f"no recipe named '{name}'"}
    n = 0
    for step in recipe.get("steps", []):
        session.stage_descriptor(step) if mode == "stage" else session.enqueue_descriptor(step)
        n += 1
    return {"status": "completed", "staged" if mode == "stage" else "queued": n}
