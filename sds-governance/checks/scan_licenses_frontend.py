"""Frontend third-party license manifest (v2 Part 9.2/9.4) — walks the resolved
`node_modules` tree and records each package's license, backing the in-app
Acknowledgements view alongside the backend SBOM (`scan_licenses.py`). Not wired
into `make check` as a gate: there's no npm equivalent of R15's forbidden-package
list defined yet. Regenerate on frontend dependency upgrades, per §9.5.
"""
import json
import sys
from pathlib import Path

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"
NODE_MODULES = FRONTEND_DIR / "node_modules"
OUT_PATH = Path(__file__).resolve().parents[1] / "sbom_frontend.json"


def _license_of(data: dict) -> str:
    lic = data.get("license")
    if isinstance(lic, str):
        return lic
    if isinstance(lic, dict):
        return lic.get("type", "UNKNOWN")
    licenses = data.get("licenses")
    if isinstance(licenses, list) and licenses:
        return "/".join(sorted({l.get("type", "UNKNOWN") for l in licenses if isinstance(l, dict)}))
    return "UNKNOWN"


def _iter_packages():
    seen = set()
    for pkg_json in sorted(NODE_MODULES.glob("*/package.json")) + sorted(NODE_MODULES.glob("@*/*/package.json")):
        try:
            data = json.loads(pkg_json.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        name, version = data.get("name"), data.get("version", "unknown")
        if not name or (name, version) in seen:
            continue
        seen.add((name, version))
        yield name, version, _license_of(data)


def main() -> int:
    if not NODE_MODULES.exists():
        print(f"error: {NODE_MODULES} not found — run `npm install` in frontend/ first", file=sys.stderr)
        return 1
    components = [{"type": "library", "name": name, "version": version,
                   "licenses": [{"license": {"name": lic}}]}
                  for name, version, lic in _iter_packages()]
    OUT_PATH.write_text(json.dumps({"bomFormat": "CycloneDX", "specVersion": "1.5", "components": components},
                                    indent=2) + "\n")
    print(f"Wrote {len(components)} frontend components to {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
