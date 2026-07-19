# Skill: add-library-function

**Triggers on:** adding a squidpy / scanpy / spatialdata-io function to the catalog.

## Steps
1. Add one entry to `backend/app/registry/library_catalog.yaml`:
   `{ library, namespace, function, path, effect_class }` (`effect_class`:
   compute | plot | read | extract). `path` is the dotted attribute within the
   library module. squidpy stays wholesale-introspected — only opt-in libraries
   need an entry.
2. If the function's params aren't covered by the term dictionary, follow
   **extend-term-dictionary** (do NOT name the function in code — terms only).
3. Confirm type-based injection: the object param (AnnData / SpatialData / image)
   must be the first of its kind; readers inject nothing and take a `path`.
4. `make check` — verify R1 (no hardcoded call), R4 (entry well-formed), R16
   (coverage didn't regress). Drive the new function once in the UI.

**Satisfies:** R1, R3, R4, R5, R8, R16.
