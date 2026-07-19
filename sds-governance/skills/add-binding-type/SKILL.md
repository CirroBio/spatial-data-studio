# Skill: add-binding-type

**Triggers on:** a new data-slot type beyond the binding vocabulary
(obs_categorical, obs, var_names, obsm, obsp, layers, …).

## Steps
1. Add the binding to the term dictionary's `_BINDING` map (`dictionary.py`) →
   (frontend widget, bound_to facet).
2. Add the widget to the frontend `UiWidget` union and render it in
   `FunctionForm.tsx` with live options.
3. Verify the widget renders with live-resolved values against a real session.

**Satisfies:** R14 (widget requirement only — the rule's `describe_function`
resolver clause was retired with the AI agent; see `RULES.md`).
