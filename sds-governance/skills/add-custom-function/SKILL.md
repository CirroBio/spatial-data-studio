# Skill: add-custom-function

**Triggers on:** adding an app-defined op (region label, subset, comparison,
snapshot, recipe-apply, or a new analysis not in any library).

## Steps
1. Create `backend/app/registry/custom/<name>.py` with a `Function` subclass that
   sets identity (`key`, `namespace="custom"`, `function`, `effect_class`, `label`,
   `summary`, `doc`) and declares a `params` list of `ParamSpec` — this is the
   schema-of-record (forms + validation + agent all derive from it).
2. Implement `execute(self, params, session) -> CallResult`. Reuse
   `base.run_compute` for in-place mutations so you get log capture + structural
   diffing + the contract envelope for free. Return the envelope on failure too.
3. Register the instance in `registry/custom/__init__.py::CUSTOM_FUNCTIONS`.
4. `make check` — R4 (params + execute present), R5 (envelope). Run it in the UI.

**Satisfies:** R3, R4, R5, R8, R10.
