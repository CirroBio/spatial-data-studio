"""Third-party attribution for the in-app Acknowledgements view (v2 Part 9.2:
baseline obligation to surface attributions for permissively-licensed deps).
Reads the SBOM `sds-governance/checks/scan_licenses.py` already produces — no
separate scan lives here, so this can never drift into its own source of truth
about what's installed. Covers the Python side only: the SPA bundles its own npm
list (`sbom_frontend.json`) so the view also works with no backend behind it.
"""
from __future__ import annotations

import json
from pathlib import Path

_PYTHON_SBOM = Path(__file__).resolve().parents[2] / "sds-governance" / "sbom.json"


def _components(path: Path) -> list[dict]:
    if not path.exists():
        return []
    components = json.loads(path.read_text()).get("components", [])
    out = [{"name": c["name"], "version": c.get("version", ""),
            "license": c.get("licenses", [{}])[0].get("license", {}).get("name", "UNKNOWN")}
           for c in components]
    return sorted(out, key=lambda c: c["name"].lower())


def catalog() -> dict:
    return {"python": _components(_PYTHON_SBOM)}
