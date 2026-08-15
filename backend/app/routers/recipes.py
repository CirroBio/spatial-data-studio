"""Bundled analysis recipes: list, export the current history as one, and
run/stage/preflight an imported recipe (DESIGN §10)."""
from fastapi import APIRouter

from .. import recipes
from ..registry.introspect import REGISTRY
from ..deps import _session, _writable_session

router = APIRouter()


@router.get("/api/recipes")
async def list_bundled_recipes():
    """Curated analysis recipes shipped with the app (run via /recipe/run)."""
    return {"recipes": recipes.catalog()}


@router.get("/api/sessions/{sid}/recipe")
async def export_recipe(sid: str):
    sess = _session(sid)
    steps = recipes.steps_from_history(sess.app_state)
    return {"library_versions": REGISTRY.library_versions, "steps": steps}


@router.post("/api/sessions/{sid}/recipe/run")
async def run_recipe(sid: str, recipe: dict):
    """Import a recipe: run now (queue all steps) or stage as PENDING (spec §5.3). A
    recipe carrying declared `params` + caller `param_values` is resolved first ($param
    references filled in); an ad-hoc {steps} import resolves to itself."""
    sess = _writable_session(sid)
    mode = recipe.get("mode") or "run"
    steps = recipes.resolve_steps(recipe, recipe.get("param_values"))
    n = recipes.run_steps(sess, steps, mode)
    return {"staged" if mode == "stage" else "queued": n}


@router.post("/api/sessions/{sid}/recipe/preflight")
async def preflight_recipe(sid: str, recipe: dict):
    """Validate against the installed registry. Recipe params are resolved first so
    referenced-key checks reflect the caller's chosen `param_values`."""
    _session(sid)
    steps = recipes.resolve_steps(recipe, recipe.get("param_values"))
    return recipes.preflight({"steps": steps})
