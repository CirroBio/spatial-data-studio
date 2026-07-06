"""R4 — function definitions follow the schema-of-record layout.

Adapted to this repo's structure (a documented deviation from the spec's literal
Zod schema.ts + manifest.yaml folders): library functions are declared as entries
in `library_catalog.yaml` (one short manifest entry each — library/namespace/
function/path/effect_class), and custom functions are modules under
`registry/custom/` that each declare a `params` schema-of-record and an `execute`.
This check enforces both shapes.
"""
import sys

import yaml

import config

_REQUIRED_CATALOG_KEYS = {"library", "namespace", "function", "path", "effect_class"}
_EFFECT_CLASSES = {"compute", "plot", "read", "extract"}
_CUSTOM_HELPERS = {"__init__.py", "tma_detect.py", "_leiden.py"}  # not Function modules


def check_catalog() -> list[str]:
    out = []
    for e in yaml.safe_load(config.LIBRARY_CATALOG.read_text()) or []:
        missing = _REQUIRED_CATALOG_KEYS - set(e)
        if missing:
            out.append(f"catalog entry {e.get('path', '?')}: missing keys {sorted(missing)}")
        if e.get("effect_class") not in _EFFECT_CLASSES:
            out.append(f"catalog entry {e.get('path', '?')}: bad effect_class {e.get('effect_class')!r}")
    return out


def check_custom() -> list[str]:
    out = []
    for path in sorted(config.CUSTOM_DIR.glob("*.py")):
        if path.name in _CUSTOM_HELPERS:
            continue
        text = path.read_text()
        if "params" not in text or "def execute" not in text:
            out.append(f"custom/{path.name}: must declare a `params` schema-of-record and an `execute`")
    return out


def main() -> int:
    problems = check_catalog() + check_custom()
    if problems:
        print("R4 FAIL:\n" + "\n".join(f"  {p}" for p in problems))
        return 1
    print("R4 OK — library entries are well-formed manifests; custom modules declare params + execute")
    return 0


if __name__ == "__main__":
    sys.exit(main())
