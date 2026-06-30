# Skill: add-binding-type

**Triggers on:** a new data-slot type beyond the binding vocabulary
(obs_categorical, obs, var_names, obsm, obsp, layers, …).

## Steps
1. Add the binding to the term dictionary's `_BINDING` map (`dictionary.py`) →
   (frontend widget, bound_to facet).
2. Add the widget to the frontend `UiWidget` union and render it in
   `FunctionForm.tsx` with live options.
3. Add a `describe_function` resolver: extend `agent/tools.py::_BIND_FACET` (and
   `_live_options`) so the agent sees the live valid values.
4. `make check` — R14 asserts every binding has both a widget and a resolver.

**Satisfies:** R14.
