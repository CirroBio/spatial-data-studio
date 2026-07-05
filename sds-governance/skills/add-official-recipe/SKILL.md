# Skill: add-official-recipe

**Triggers on:** bundling a recipe adapted from a vignette / paper.

## Steps
1. Drop a new JSON bundle file in `backend/app/recipes/` (discovered at startup,
   sorted by filename — number it to place it in the gallery):
   `{ schema_version, meta: { name, description, provenance }, readme, steps: [
   {namespace, function, params}, ... ] }`. Steps must reference functions that
   exist in the registry and params that conform to their schema-of-record.
2. Run the recipe preflight (`/recipe/preflight`) to confirm required-vs-produced
   keys resolve and no step names an unknown function.
3. Verify it appears in `GET /api/recipes` and applies via `/recipe/run`; each
   step runs through the contract.

**Satisfies:** recipe portability + R5.
