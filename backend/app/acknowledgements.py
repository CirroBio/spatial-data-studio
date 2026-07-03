"""Third-party attribution for the in-app Acknowledgements view (v2 Part 9.2:
baseline obligation to surface attributions for permissively-licensed deps).
Reads the SBOMs `sds-governance/checks/scan_licenses{,_frontend}.py` already
produce — no separate scan lives here, so this can never drift into its own
source of truth about what's installed.
"""
from __future__ import annotations

import json
from pathlib import Path

_GOVERNANCE_DIR = Path(__file__).resolve().parents[2] / "sds-governance"
_SBOMS = {"python": _GOVERNANCE_DIR / "sbom.json", "npm": _GOVERNANCE_DIR / "sbom_frontend.json"}


def _components(path: Path) -> list[dict]:
    if not path.exists():
        return []
    components = json.loads(path.read_text()).get("components", [])
    out = [{"name": c["name"], "version": c.get("version", ""),
            "license": c.get("licenses", [{}])[0].get("license", {}).get("name", "UNKNOWN")}
           for c in components]
    return sorted(out, key=lambda c: c["name"].lower())


def catalog() -> dict:
    return {ecosystem: _components(path) for ecosystem, path in _SBOMS.items()}
