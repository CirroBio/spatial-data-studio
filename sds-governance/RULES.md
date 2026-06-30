# RULES — invariants enforced by the gate (v3 Part 14)

A rule is enforced by a check, a lint, or a startup assertion — **independent of
whether anyone followed a skill**. A rule that depends on memory is not a rule.
When a change has no matching skill it may warrant a new rule here — added **with
an enforcement check**, never prose alone. pytest checks **skip** (visibly) until
their `# WIRE:` seam in `checks/config.py` is satisfied, so the gate is adoptable
incrementally.

| ID | Rule | Origin | Enforced by |
|----|------|--------|-------------|
| R1 | No module references a specific library function; reach them only via the registry (the reflection builder + hand-written `custom/` run logic are exempt). | v1 | `check_import_graph.py` |
| R2 | The term dictionary defines parameter *terms*, never functions. | v2 | `lint_term_dictionary.py` |
| R3 | One schema-of-record (JSON Schema) drives form + Pydantic + agent. | v3 | `test_invariants.py::test_r3_*` |
| R4 | Library functions are declarative manifest entries; custom functions declare a `params` schema-of-record + an `execute`. | v3 | `lint_function_folders.py` |
| R5 | Every function returns the contract envelope and respects `keep_failures`. | v3 | `test_contracts.py` (skip-until-`SYNTH_FIXTURE`) |
| R6/R7 | Compute history is append-only; never `COMPLETED→QUEUED`; rerun appends. | v1 | `test_invariants.py` (R6/R7 needs a run harness) |
| R8 | Effect class is explicit; plotting render params are managed. | v2 | `test_invariants.py::test_r8_*` |
| R9 | One uvicorn worker; per-worker ceiling < container limit. | v1 | startup assertion (backend) |
| R10 | State-changing ops are queued mutating jobs under the write lock. | v1 | `test_invariants.py::test_r10_*` |
| R11 | Agent memory is self-curated context only; the transcript is never replayed. | v3 | `test_invariants.py::test_r11_*` |
| R12 | Fixed meta-tools; state-changing gated in auto-off; no annotate/subset. | v3 | `test_invariants.py::test_r12_*` |
| R13 | Snapshots share the render core; assets are content-hashed. | v3 | `test_invariants.py::test_r13_*` |
| R14 | Every binding type has a widget **and** a `describe_function` resolver. | v3 | `test_invariants.py::test_r14_*` |
| R15 | Deps permissive or adjudicated; no torch/scvi; scan + SBOM before distribution. | v2/v3 | `scan_licenses.py` |
| R16 | Term-dictionary coverage must not regress below the floor. | v3 | `lint_term_dictionary.py` |

Run the gate: `make check` (use `PYTHON=<backend interpreter>` to enforce the
import-dependent rules rather than skip them).
