"""The single wiring seam for the governance gate (v3 Part 14).

Everything repo-specific lives behind `# WIRE:` markers here, so the checks are
adoptable incrementally: a check whose seam is still `None` reports a visible
skip rather than a false pass. Point these at the real modules to turn a skip
into an enforced rule.
"""
from pathlib import Path

# Repo root (sds-governance/checks/config.py -> repo root is two parents up).
REPO = Path(__file__).resolve().parents[2]

# WIRE: backend source tree and the registry artifacts the static checks read.
BACKEND = REPO / "backend" / "app"
TERMS_YAML = BACKEND / "registry" / "terms.yaml"
LIBRARY_CATALOG = BACKEND / "registry" / "library_catalog.yaml"
CUSTOM_DIR = BACKEND / "registry" / "custom"

# Modules that legitimately name library functions: the reflection builder and
# the hand-written custom functions' run logic. R1 excludes these.
R1_EXEMPT = {"registry/library_fn.py", "registry/introspect.py"}
R1_EXEMPT_DIRS = {"registry/custom"}

# WIRE: import path to the live registry for the contract smoke test (R5). Leave
# None to skip until the test environment can import the backend stack.
#   e.g. "app.registry.introspect:REGISTRY"
REGISTRY_REF = "app.registry.introspect:REGISTRY"

# WIRE: a callable that builds a synthetic SpatialData fixture for the R5 contract
# smoke test. None -> the contract smoke test reports a visible skip.
SYNTH_FIXTURE = None

# WIRE: term-dictionary minimum coverage (R16). The gate fails if match_rate drops
# below this floor. Bump it up as coverage improves; never down silently.
MIN_TERM_COVERAGE = 0.45

# R15: dependency licenses.
LICENSE_ALLOWLIST = REPO / "sds-governance" / "license_allowlist.yaml"
FORBIDDEN_PACKAGES = {"torch", "torchvision", "scvi-tools", "scvi"}
