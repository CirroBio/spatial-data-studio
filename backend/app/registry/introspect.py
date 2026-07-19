"""The function registry — the only path to a runnable function (invariant §16.1).

Builds the reflected library functions (`library_fn.build_library_function`) for
squidpy plus the catalog libraries (scanpy, spatialdata-io) and registers the
hand-written `custom/` functions alongside them. Every entry is a `Function`; the
descriptor `{namespace, function, params}` resolves to one by key. No library
function is named here.
"""
from __future__ import annotations

import importlib
import importlib.metadata
import inspect
import logging
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .base import Function
from .dictionary import DICTIONARY
from .library_fn import build_library_function
from .custom import CUSTOM_FUNCTIONS, check_custom_functions

warnings.filterwarnings("ignore")

NAMESPACES = ["gr", "im", "tl", "read", "pl"]
_CATALOG_PATH = Path(__file__).with_name("library_catalog.yaml")
_log = logging.getLogger(__name__)


def _module_version(name: str) -> str:
    try:
        mod = importlib.import_module(name)
    except ImportError:
        return ""
    version = getattr(mod, "__version__", None)
    if version:
        return str(version)
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return ""


@dataclass
class Registry:
    entries: dict = field(default_factory=dict)
    # Version of each reflected library, keyed by import name (squidpy, scanpy,
    # spatialdata_io). Stamped onto compute/plot history for reproducibility — a
    # run may execute any of them, so a single squidpy version is not enough.
    library_versions: dict = field(default_factory=dict)
    coverage: dict = field(default_factory=dict)

    def build(self):
        import squidpy as sq
        DICTIONARY.load()
        DICTIONARY.coverage = []
        self.entries = {}
        for ns in NAMESPACES:
            mod = getattr(sq, ns, None)
            if mod is None:
                continue
            for name in dir(mod):
                if name.startswith("_"):
                    continue
                obj = getattr(mod, name)
                if not callable(obj) or inspect.isclass(obj):
                    continue
                if not getattr(obj, "__module__", "").startswith("squidpy"):
                    continue
                entry = build_library_function("squidpy", ns, name, obj)
                if entry is not None:
                    self.entries[entry.key] = entry
        self._load_catalog()
        self.library_versions = {
            lib: _module_version(lib)
            for lib in sorted({e.library for e in self.entries.values()
                               if getattr(e, "library", None)})
        }
        self.coverage = DICTIONARY.coverage_report()
        for fn in CUSTOM_FUNCTIONS:
            self.entries[fn.key] = fn
        problems = check_custom_functions()
        if problems:
            raise RuntimeError("custom function registry self-check failed:\n  " + "\n  ".join(problems))
        return self

    def _load_catalog(self):
        """Build the opt-in library functions (scanpy, spatialdata-io) declared in
        library_catalog.yaml (v3 Part 4). Entries whose import fails (a reader absent
        in the installed version) are skipped, never hardcoded."""
        for e in yaml.safe_load(_CATALOG_PATH.read_text()) or []:
            try:
                obj = importlib.import_module(e["library"])
                for part in e["path"].split("."):
                    obj = getattr(obj, part)
            except (ImportError, AttributeError) as ex:
                _log.warning("catalog: skipping %s (%s)", e.get("key") or e["path"], ex)
                continue
            key = e.get("key") or f"{e['namespace']}.{e['function']}"
            entry = build_library_function(
                e["library"], e["namespace"], e["function"], obj,
                effect_class=e.get("effect_class"), path=e["path"], key=key,
                overrides=e.get("overrides"),
            )
            if entry is not None:
                self.entries[entry.key] = entry

    def get(self, key: str) -> Function | None:
        return self.entries.get(key)

    def public(self) -> dict:
        return {"functions": [e.to_public() for e in self.entries.values()],
                "library_versions": self.library_versions}


REGISTRY = Registry()
