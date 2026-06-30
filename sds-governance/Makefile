# Governance gate (v3 Part 14). `make check` runs the same way every change and
# blocks merge on failure. PYTHON defaults to python3; point it at the backend's
# interpreter (one with the stack installed) to enforce the import-dependent rules
# instead of skipping them, e.g. `make check PYTHON=../.venv-introspect/bin/python3`.
PYTHON ?= python3
CHECKS := $(dir $(lastword $(MAKEFILE_LIST)))checks

.PHONY: check static tests licenses

check: static tests licenses
	@echo "── governance gate: PASS ──"

static:
	@echo "── static (R1, R2, R4, R16) ──"
	@cd $(CHECKS) && $(PYTHON) check_import_graph.py
	@cd $(CHECKS) && $(PYTHON) lint_term_dictionary.py
	@cd $(CHECKS) && $(PYTHON) lint_function_folders.py

tests:
	@echo "── invariants + contracts (R3, R5-R14) ──"
	@cd $(CHECKS) && $(PYTHON) -m pytest -q -p no:cacheprovider test_invariants.py test_contracts.py

licenses:
	@echo "── licenses + SBOM (R15) ──"
	@cd $(CHECKS) && $(PYTHON) scan_licenses.py
