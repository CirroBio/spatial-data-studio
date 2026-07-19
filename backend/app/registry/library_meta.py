"""Per-library citation + documentation-URL lookup for reflected functions.

Introspected library functions (squidpy, scanpy, spatialdata-io) don't carry a
citation or docs link individually — each LIBRARY declares one citation and a
doc_url template in `library_meta.yaml`, and `build_library_function` fills the
`Function.citation` / `Function.documentation` attributes from it (the docs link
is the template with the function's dotted path substituted in). Mirrors the
terms.yaml / dictionary.py config pattern.
"""
from __future__ import annotations

from pathlib import Path

import yaml

_META_PATH = Path(__file__).with_name("library_meta.yaml")
_META: dict | None = None


def _meta() -> dict:
    global _META
    if _META is None:
        _META = yaml.safe_load(_META_PATH.read_text()) or {}
    return _META


def citation(library: str) -> str:
    return _meta().get(library, {}).get("citation", "")


def documentation(library: str, path: str) -> str:
    """Docs URL for one function: the library's doc_url template filled with `path`."""
    template = _meta().get(library, {}).get("doc_url", "")
    return template.format(path=path) if template else ""
