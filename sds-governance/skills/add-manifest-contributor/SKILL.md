# Skill: add-manifest-contributor

**Triggers on:** the agent needs to "see" a facet of session state not yet in the
data manifest.

## Steps
1. Add a function in `backend/app/manifest/contributors.py` decorated with
   `@contributor("Label")` that takes `session` and returns a labeled text block
   (or `None` when the facet is absent). Reuse `transport.arrow.describe_fields`
   so the categorical view matches the Arrow transport.
2. Keep it small and structural-first; the manifest is captured before/after every
   call and replayed to the model — don't bloat it.
3. Confirm it appears in `GET /api/sessions/{id}/manifest` and in a turn's delta.

**Satisfies:** manifest extensibility (Part 3.1).
