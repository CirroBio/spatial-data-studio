"""The function registry — the only path to a runnable function (invariant §16.1).

Builds the squidpy functions by reflection (`squidpy_fn.build_squidpy_function`)
and registers the hand-written `custom/` functions alongside them. Every entry is
a `Function`; the descriptor `{namespace, function, params}` resolves to one by
key. No squidpy function is named here.
"""
from __future__ import annotations

import inspect
import warnings
from dataclasses import dataclass, field

from .base import Function
from .dictionary import DICTIONARY
from .squidpy_fn import build_squidpy_function
from .custom import CUSTOM_FUNCTIONS

warnings.filterwarnings("ignore")

NAMESPACES = ["gr", "im", "tl", "read", "pl"]


@dataclass
class Registry:
    entries: dict = field(default_factory=dict)
    squidpy_version: str = ""
    coverage: dict = field(default_factory=dict)

    def build(self):
        import squidpy as sq
        self.squidpy_version = sq.__version__
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
                entry = build_squidpy_function(ns, name, obj)
                if entry is not None:
                    self.entries[entry.key] = entry
        self.coverage = DICTIONARY.coverage_report()
        for fn in CUSTOM_FUNCTIONS:
            self.entries[fn.key] = fn
        return self

    def get(self, key: str) -> Function | None:
        return self.entries.get(key)

    def public(self) -> dict:
        return {"functions": [e.to_public() for e in self.entries.values()],
                "squidpy_version": self.squidpy_version}


REGISTRY = Registry()
