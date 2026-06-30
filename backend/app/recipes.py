"""Named analysis recipes for the agent's list_recipes/apply_recipe tools (v3
Part 5). The app supports ad-hoc recipe export/import over the current history
(see main.py /recipe endpoints); no curated/bundled recipes ship yet, so the
catalog is empty until official recipes are added."""
from __future__ import annotations

_BUNDLED: dict[str, dict] = {}  # name -> {description, steps}


def list_recipes() -> list[dict]:
    return [{"name": n, "description": r.get("description", "")} for n, r in _BUNDLED.items()]


def apply_recipe(session, name: str, mode: str = "run") -> dict:
    recipe = _BUNDLED.get(name)
    if recipe is None:
        return {"status": "failed", "error": f"no recipe named '{name}'"}
    n = 0
    for step in recipe.get("steps", []):
        session.stage_descriptor(step) if mode == "stage" else session.enqueue_descriptor(step)
        n += 1
    return {"status": "completed", "staged" if mode == "stage" else "queued": n}
