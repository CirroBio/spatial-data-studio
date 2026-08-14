"""R17 — a change to any checkpoint JSON Schema must land in the same commit as a
change to docs/CHECKPOINT_FORMAT.md, so the human-readable spec never drifts from
the schema that's actually enforced (see that document's "Validation guarantee"
section). Diff-based, so it only makes sense against a range of commits:

- as a pre-commit hook (`.pre-commit-config.yaml`), run with no args, it checks
  the staged diff (`git diff --cached`);
- in `make check` / CI, pass explicit refs, e.g.
  `check_checkpoint_schema_docs.py origin/main HEAD`.
"""
import subprocess
import sys

import config


def _changed_files(diff_args: list[str]) -> set[str] | None:
    out = subprocess.run(["git", "diff", "--name-only", *diff_args],
                         cwd=config.REPO, capture_output=True, text=True)
    if out.returncode != 0:
        return None
    return {line.strip() for line in out.stdout.splitlines() if line.strip()}


def check(diff_args: list[str]) -> int:
    changed = _changed_files(diff_args)
    if changed is None:
        print(f"R17 SKIP — could not diff {diff_args} (ref not resolvable in this checkout)")
        return 0
    schema_rel = config.CHECKPOINT_SCHEMA_DIR.relative_to(config.REPO)
    changed_schemas = sorted(f for f in changed
                             if f.startswith(f"{schema_rel}/") and f.endswith(".schema.json"))
    if not changed_schemas:
        print("R17 OK — no checkpoint schema changed")
        return 0
    doc_rel = str(config.CHECKPOINT_FORMAT_DOC.relative_to(config.REPO))
    if doc_rel in changed:
        print(f"R17 OK — {doc_rel} updated alongside {changed_schemas}")
        return 0
    print(f"R17 FAIL — {changed_schemas} changed but {doc_rel} did not. "
         f"Update {doc_rel} to match, in the same commit.")
    return 1


if __name__ == "__main__":
    args = sys.argv[1:] or ["--cached"]
    sys.exit(check(args))
