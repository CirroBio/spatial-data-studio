"""Data manifest (v3 Part 3): a text representation of session state — the AI's
eyes and a human-readable diff source. Assembled from an extensible registry of
contributors; captured before/after every function call (Part 2)."""
from .registry import build_manifest, manifest_delta, contributor  # noqa: F401
from . import contributors  # noqa: F401  (registers the seed contributors on import)
