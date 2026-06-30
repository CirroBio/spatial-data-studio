# Skill: add-official-recipe

**Triggers on:** bundling a recipe adapted from a vignette / paper.

## Steps
1. Add an entry to `backend/app/recipes.py::_BUNDLED`:
   `{ name: { description, steps: [ {namespace, function, params}, ... ] } }`.
   Steps must reference functions that exist in the registry and params that
   conform to their schema-of-record.
2. Run the recipe preflight (`/recipe/preflight`) to confirm required-vs-produced
   keys resolve and no step names an unknown function.
3. Verify `list_recipes` / `apply_recipe` (and the agent's tools) surface it; each
   step runs through the contract.

**Satisfies:** recipe portability + R5.
