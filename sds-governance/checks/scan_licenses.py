"""R15 — dependencies must be permissive or explicitly adjudicated; no torch/scvi.
Reads installed package metadata, fails on forbidden packages or un-adjudicated
copyleft, and emits a minimal CycloneDX SBOM to sds-governance/sbom.json.
"""
import json
import sys
from importlib import metadata

import yaml

import config


def _load_allowlist() -> dict:
    if config.LICENSE_ALLOWLIST.exists():
        return yaml.safe_load(config.LICENSE_ALLOWLIST.read_text()) or {}
    return {}


def main() -> int:
    allow = _load_allowlist()
    allowed_licenses = {l.lower() for l in allow.get("allowed_licenses", [])}
    adjudicated = {p.lower() for p in allow.get("adjudicated_packages", {})}
    todo = allow.get("clustering_decision_todo", False)

    components, forbidden, unadjudicated = [], [], []
    for dist in metadata.distributions():
        name = (dist.metadata["Name"] or "").strip()
        if not name:
            continue
        version = dist.version
        lic = (dist.metadata.get("License") or "").strip()
        classifiers = [c for c in dist.metadata.get_all("Classifier", []) if "License" in c]
        lic_text = (lic + " " + " ".join(classifiers)).lower()
        components.append({"type": "library", "name": name, "version": version,
                           "licenses": [{"license": {"name": lic or (classifiers[0] if classifiers else "UNKNOWN")}}]})
        low = name.lower()
        if low in config.FORBIDDEN_PACKAGES:
            forbidden.append(name)
        elif low in adjudicated:
            continue
        elif not any(a in lic_text for a in allowed_licenses):
            # copyleft signal not on the allowlist and not adjudicated
            if any(k in lic_text for k in ("gpl", "agpl", "mozilla", "mpl", "copyleft")):
                unadjudicated.append(f"{name} ({lic or 'unknown'})")

    sbom = {"bomFormat": "CycloneDX", "specVersion": "1.5", "components": components}
    (config.LICENSE_ALLOWLIST.parent / "sbom.json").write_text(json.dumps(sbom, indent=2))

    if forbidden:
        print(f"R15 FAIL — forbidden packages present: {forbidden}")
        return 1
    if unadjudicated:
        print("R15 FAIL — un-adjudicated copyleft dependencies:\n" + "\n".join(f"  {u}" for u in unadjudicated))
        return 1
    msg = f"R15 OK — {len(components)} deps scanned, SBOM written, no torch/scvi or un-adjudicated copyleft"
    if todo:
        msg += " (NOTE: clustering license decision still marked TODO — blocks distribution)"
    print(msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
