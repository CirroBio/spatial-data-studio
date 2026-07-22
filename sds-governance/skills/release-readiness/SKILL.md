# Skill: release-readiness

**Triggers on:** preparing a build / image for distribution.

## Steps
1. Confirm the runtime shape: one uvicorn worker; sessions never span worker
   processes (supervisord `--workers 1`). (R9)
2. Verify snapshots open standalone (HTML + content-hashed `assets/`) and share the
   render core. (R13)
3. Run `scan_licenses.py`: no torch/scvi, all copyleft adjudicated in
   `license_allowlist.yaml`, SBOM emitted. **Resolve `clustering_decision_todo`** —
   distribution is blocked while it is `true`. (R15)
4. `make check` green end to end; tag the image.

**Satisfies:** R9, R13, R15.
