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
| R3 | One schema-of-record (JSON Schema) drives form + Pydantic. | v3 | `test_invariants.py::test_r3_*` |
| R4 | Library functions are declarative manifest entries; custom functions declare a `params` schema-of-record + an `execute`. | v3 | `lint_function_folders.py` |
| R5 | Every function returns the contract envelope and respects `keep_failures`. | v3 | `test_contracts.py` (skip-until-`SYNTH_FIXTURE`) |
| R6/R7 | Compute history is append-only; never `COMPLETED→QUEUED`; rerun appends. | v1 | `test_invariants.py` (R6/R7 needs a run harness) |
| R8 | Effect class is explicit; plotting render params are managed. | v2 | `test_invariants.py::test_r8_*` |
| R9 | One uvicorn worker; sessions never span worker processes. | v1 | supervisord `--workers 1` |
| R10 | State-changing ops are queued mutating jobs under the write lock. | v1 | `test_invariants.py::test_r10_*` |
| R11 | *Retired.* Governed the AI agent's context replay; the agent was removed. | v3 | — |
| R12 | *Retired.* Governed the AI agent's meta-tool set; the agent was removed. | v3 | — |
| R13 | Snapshots share the render core; assets are content-hashed. | v3 | `test_invariants.py::test_r13_*` |
| R14 | *Retired.* Required a widget **and** a `describe_function` resolver per binding type; the resolver was the AI agent's, which was removed. The widget requirement (`FunctionForm.tsx`) still applies but is enforced by review, not this gate. | v3 | — |
| R15 | Deps permissive or adjudicated; no torch/scvi; scan + SBOM before distribution. | v2/v3 | `scan_licenses.py` |
| R16 | Term-dictionary coverage must not regress below the floor. | v3 | `lint_term_dictionary.py` |

Run the gate: `make check` (use `PYTHON=<backend interpreter>` to enforce the
import-dependent rules rather than skip them).
