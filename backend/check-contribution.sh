#!/usr/bin/env bash
# One command to validate a contribution (a recipe or a custom function) before
# opening a PR. Builds the registry, runs the custom-function self-check (closed
# widget/effect_class/role vocab, the bound_to contract, registration
# completeness, and doc-anchor resolution — see registry/custom/__init__.py),
# asserts every function carries citation + documentation, and confirms the
# recipes load. See CONTRIBUTING.md.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

VENV_PY="../.venv-introspect/bin/python"
if [[ ! -x "$VENV_PY" ]]; then
  echo "error: .venv-introspect not found at repo root. Create it:" >&2
  echo "  python3.11 -m venv .venv-introspect && . .venv-introspect/bin/activate && pip install -r backend/requirements.txt && pip uninstall -y leidenalg igraph" >&2
  exit 1
fi

PYTHONPATH=. "$VENV_PY" - <<'PY'
import sys

from app.registry.custom import check_custom_functions

problems = check_custom_functions()
if problems:
    print("Custom-function self-check FAILED:")
    for p in problems:
        print("  -", p)
    sys.exit(1)

from app.registry.introspect import REGISTRY
REGISTRY.build()
pub = REGISTRY.public()
missing = [f["key"] for f in pub["functions"] if not f["citation"] or not f["documentation"]]
if missing:
    print("Functions missing citation/documentation:", missing)
    sys.exit(1)

from app import recipes
n_recipes = len(recipes.list_recipes())
if n_recipes < 24:
    print(f"expected at least 24 recipes, found {n_recipes}")
    sys.exit(1)

print(f"OK {len(pub['functions'])} functions {n_recipes} recipes")
PY
