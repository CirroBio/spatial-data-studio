"""Documentation-URL helper for custom functions.

Every custom function's `documentation` points at its section in this folder's
README.md (rendered on GitHub), so the user can read what the method does. Keep
the README anchors in sync with the `custom_doc(...)` calls in each function.
"""
from __future__ import annotations

CUSTOM_README_URL = (
    "https://github.com/CirroBio/squidpy-viewer/blob/main/"
    "backend/app/registry/custom/README.md"
)


def custom_doc(anchor: str) -> str:
    """URL of a method's section in custom/README.md (anchor = its GitHub slug)."""
    return f"{CUSTOM_README_URL}#{anchor}"
