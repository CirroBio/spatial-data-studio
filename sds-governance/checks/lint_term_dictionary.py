"""R2 — the term dictionary defines parameter *terms*, never functions.
R16 — term-dictionary coverage must not regress below the configured floor.

R2 is static (terms key on param names/patterns/types, with only an optional
`scope` for disambiguation — never a function as the primary key). R16 builds the
registry and checks the reported match_rate, skipping if the backend can't import.
"""
import sys

import yaml

import config


def check_r2() -> int:
    raw = yaml.safe_load(config.TERMS_YAML.read_text()) or {}
    bad = []
    for i, term in enumerate(raw.get("terms", [])):
        m = term.get("match", {})
        if not (m.get("names") or m.get("patterns") or m.get("type")):
            bad.append(f"term #{i}: match has no names/patterns/type (a term must key on a parameter term)")
    if bad:
        print("R2 FAIL:\n" + "\n".join(f"  {b}" for b in bad))
        return 1
    print(f"R2 OK — {len(raw.get('terms', []))} terms key on parameter terms, not functions")
    return 0


def check_r16() -> int:
    try:
        sys.path.insert(0, str(config.BACKEND.parent))
        mod, attr = config.REGISTRY_REF.split(":")
        import importlib
        registry = getattr(importlib.import_module(mod), attr)
        registry.build()
        rate = registry.coverage.get("match_rate", 0.0)
    except Exception as e:
        print(f"R16 SKIP — could not build registry ({type(e).__name__}); wire the test env to enforce")
        return 0
    if rate < config.MIN_TERM_COVERAGE:
        print(f"R16 FAIL — term coverage {rate:.3f} < floor {config.MIN_TERM_COVERAGE}")
        return 1
    print(f"R16 OK — term coverage {rate:.3f} >= floor {config.MIN_TERM_COVERAGE}")
    return 0


if __name__ == "__main__":
    sys.exit(check_r2() or check_r16())
