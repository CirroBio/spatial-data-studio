# Skill: extend-term-dictionary

**Triggers on:** an unmapped parameter, or a new widget / data binding.

## Steps
1. Add an entry to `backend/app/registry/terms.yaml` keyed by **parameter term**
   (`match.names` / `match.patterns` / `match.type`), never by function. Use
   `scope: "ns.fn"` only to disambiguate an overloaded name.
2. Set `binding` (data slot) and/or `widget`, plus `role` (input | managed |
   output), `values` (enum), `help`. `policy.pin` for managed params.
3. `make check` — R2 (keyed on a term) and R16 (coverage floor). If you raised
   coverage, bump `MIN_TERM_COVERAGE` in `checks/config.py` up (never down).

**Satisfies:** R2, R16.
