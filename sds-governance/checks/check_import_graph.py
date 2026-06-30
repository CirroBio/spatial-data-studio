"""R1 — No module references a specific library function; reach them only via the
registry. Static check: scan the backend (excluding the reflection builder and the
hand-written custom functions) for hardcoded `sq.<ns>.<fn>(` / `sc.<ns>.<fn>(`
style calls. Library functions must be reached through the registry, not named in
generic code.
"""
import re
import sys

import config

# sq.gr.spatial_neighbors( / sc.pp.normalize_total( / squidpy.gr.x( / scanpy.tl.y(
_CALL = re.compile(r"\b(sq|sc|squidpy|scanpy)\.(gr|im|tl|pl|read|pp|get)\.[a-zA-Z_]\w*\s*\(")


def _exempt(rel: str) -> bool:
    return rel in config.R1_EXEMPT or any(rel.startswith(d) for d in config.R1_EXEMPT_DIRS)


def main() -> int:
    violations = []
    for path in config.BACKEND.rglob("*.py"):
        rel = str(path.relative_to(config.BACKEND))
        if _exempt(rel):
            continue
        for i, line in enumerate(path.read_text().splitlines(), 1):
            stripped = line.split("#", 1)[0]
            if _CALL.search(stripped):
                violations.append(f"{rel}:{i}: {line.strip()}")
    if violations:
        print("R1 FAIL — hardcoded library-function calls outside the registry:")
        print("\n".join(f"  {v}" for v in violations))
        return 1
    print(f"R1 OK — no hardcoded library-function calls in {config.BACKEND.name}/ (custom/ + builder exempt)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
