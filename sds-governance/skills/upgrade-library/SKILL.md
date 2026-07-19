# Skill: upgrade-library

**Triggers on:** bumping squidpy / scanpy / spatialdata(-io) or an npm dependency.

## Steps
1. Update the pin in `backend/requirements.txt` (or `package.json`); rebuild.
2. Rebuild the registry and re-run the coverage report — new/renamed params surface
   as term-dictionary gaps; close the high-reuse ones (**extend-term-dictionary**).
3. Run `backend/test_e2e.py` and drive a representative function in the UI.
4. `make check` — R1 (still reached via registry), R3/R5 (schema + envelope),
   R16 (coverage floor), R15 (license scan on the new dependency set).

**Satisfies:** R1, R3, R5, R15, R16.
