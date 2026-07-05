# Skill: add-manifest-contributor

**Triggers on:** a facet of session state that isn't yet surfaced in the data
manifest / human-readable diff.

## Steps
1. Add a function in `backend/app/manifest/contributors.py` decorated with
   `@contributor("Label")` that takes `session` and returns a labeled text block
   (or `None` when the facet is absent). Reuse `transport.arrow.describe_fields`
   so the categorical view matches the Arrow transport.
2. Keep it small and structural-first; the manifest is captured before/after every
   call — don't bloat it.
3. Confirm it appears in the before/after manifest text for a call that touches
   the new facet.

**Satisfies:** manifest extensibility (Part 3.1).
