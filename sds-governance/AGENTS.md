# AGENTS — prime directives for Spatial Data Studio

Read this first. The structure of v1/v2/v3 is held by **two separate mechanisms**:

- **Rules** (`RULES.md`) — invariants enforced by the gate (`make check`),
  independent of whether anyone followed a skill.
- **Skills** (`skills/<name>/SKILL.md`) — playbooks for each class of change, each
  ending by satisfying named rules.

**Principle: skills make the green path obvious; the gate makes the red path
unmergeable.** If skills were the only mechanism, the invariants would erode the
first change made without one.

## The non-negotiables

1. **Never name a library function in generic code.** squidpy/scanpy/spatialdata-io
   are reached through the registry (reflection + `library_catalog.yaml`). Only the
   reflection builder and hand-written `custom/` functions may call a library
   directly. (R1)
2. **One schema-of-record.** A function's params are defined once (generated for
   library functions; a `params` declaration for custom). Forms, validation, and the
   agent tool interface all derive from it. (R3, R4)
3. **One contract envelope.** Every function returns
   `{status, logs, structural_diff?, figure_bytes?, new_object?, result_value?,
   manifest_before/after, error?}` and respects `keep_failures`. (R5)
4. **The audit-log model holds.** Compute mutates in place under the write lock on
   the worker; history is append-only. (R6, R7, R10)
5. **The agent is bounded.** Fixed meta-tools only; state-changing calls gated in
   auto-off; never annotate/subset; memory is self-curated context, never the raw
   transcript. (R11, R12)
6. **Licenses stay clean.** No torch/scvi; copyleft must be adjudicated in
   `license_allowlist.yaml`; scan + SBOM before distribution. (R15)

## Workflow

- Find the matching skill in `skills/` and follow it; it ends by naming the rules to
  satisfy.
- Run `make check` before opening a PR; CI runs the same gate and blocks on failure.
- A change with **no** matching skill may warrant a **new rule** — add it to
  `RULES.md` **with an enforcement check**, never prose alone.
- Wiring is incremental: the `# WIRE:` markers in `checks/config.py` are the single
  seam; an unwired pytest check skips visibly instead of passing falsely.
