"""Parameter Term Dictionary (post-build spec Part 1).

Loads terms.yaml at startup and resolves each discovered function parameter to a
form descriptor by matching a *parameter term* — never a function (invariant core
§16.1). Consolidates the former §4.2 (type->widget), §4.3 (name->slot), and §4.6
policy-pin logic into one declarative artifact. Emits a coverage report (§1.9).
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from fnmatch import fnmatch
from pathlib import Path
from typing import Any

import yaml

_TERMS_PATH = Path(__file__).with_name("terms.yaml")

# binding (spec §1.4) -> (public widget the frontend renders, bound_to data facet).
# The frontend widget vocabulary is fixed; bindings map onto it so existing forms
# keep working while the dictionary owns the knowledge.
_BINDING = {
    "obs_categorical": ("obs_categorical", "obs_categorical"),
    "obs_numeric": ("obs_key", "obs"),
    "obs_column": ("obs_key", "obs"),
    "var_names": ("var_names", "var_names"),
    "obsm_key": ("obsm_key", "obsm"),
    "obsp_key": ("obsp_key", "obsp"),
    "layer_key": ("layer_key", "layers"),
    "library_id": ("library_id", "library_id"),
    "image_element": ("text", "images"),
    "shapes_element": ("text", "shapes"),
    "labels_element": ("text", "labels"),
    "new_key": ("text", None),
}
# widget (spec) -> frontend widget, when a term has no data binding.
_WIDGET = {"picker": "text", "multiselect": "multitext", "enum": "select",
           "number": "number", "toggle": "checkbox", "text": "text"}
_TYPE_SCHEMA = {"int": {"type": "integer"}, "float": {"type": "number"},
                "str": {"type": "string"}, "bool": {"type": "boolean"}}


@dataclass
class Term:
    names: list
    patterns: list
    type_match: str | None
    scope: str | None
    binding: str | None
    role: str
    widget: str | None
    value_source: str | None
    canonical_type: str | None
    policy: dict | None
    values: list | None
    default_source: str | None
    label: str | None
    help: str | None


@dataclass
class Resolution:
    action: str                 # 'form' | 'pin' | 'lock'
    pin_value: Any = None
    widget: str = "text"
    bound_to: str | None = None
    schema: dict = field(default_factory=dict)
    tooltip: str = ""
    role: str = "input"
    matched: bool = False


def _finite(value) -> bool:
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, (list, tuple)):
        return all(_finite(v) for v in value)
    if isinstance(value, dict):
        return all(_finite(v) for v in value.values())
    try:
        import json
        json.dumps(value)
        return True
    except (TypeError, ValueError):
        return False


def _thread_default() -> int:
    from ..config import config
    return config.N_THREADS


class TermDictionary:
    def __init__(self, path: Path = _TERMS_PATH):
        self.path = path
        self.terms: list[Term] = []
        self.coverage: list[dict] = []  # one record per resolved param

    def load(self):
        raw = yaml.safe_load(self.path.read_text()) or {}
        self.terms = []
        for t in raw.get("terms", []):
            m = t.get("match", {})
            self.terms.append(Term(
                names=m.get("names", []) or [], patterns=m.get("patterns", []) or [],
                type_match=m.get("type"), scope=m.get("scope"),
                binding=t.get("binding"), role=t.get("role", "input"),
                widget=t.get("widget"), value_source=t.get("value_source"),
                canonical_type=t.get("type"), policy=t.get("policy"),
                values=t.get("values"), default_source=t.get("default_source"),
                label=t.get("label"), help=t.get("help"),
            ))
        return self

    def _match(self, key: str, name: str, canonical_type: str | None) -> Term | None:
        best, best_score = None, 0
        for term in self.terms:
            if term.scope is not None and term.scope != key:
                continue
            scoped = term.scope is not None
            if name in term.names:
                score = 5 if scoped else 3
            elif any(fnmatch(name, p) for p in term.patterns):
                score = 4 if scoped else 2
            elif term.type_match and term.type_match == canonical_type:
                score = 1
            else:
                continue
            if score > best_score:
                best, best_score = term, score
        return best

    @staticmethod
    def _widget_for(term: Term) -> tuple[str, str | None]:
        b = term.binding
        if b and b.startswith("categories_of"):
            return {"multiselect": "multitext", "enum": "text"}.get(term.widget or "", "text"), None
        if b in _BINDING:
            return _BINDING[b]
        return _WIDGET.get(term.widget or "text", "text"), None

    def _apply_default(self, schema: dict, term: Term | None, has_default: bool, default) -> dict:
        if term and term.default_source == "threads":
            schema["default"] = _thread_default()
        elif has_default and default is not None and _finite(default):
            schema["default"] = default
        return schema

    def resolve(self, key: str, name: str, canonical_type: str | None,
                base_schema: dict, type_widget: str, serializable: bool,
                has_default: bool, default) -> Resolution:
        term = self._match(key, name, canonical_type)
        self.coverage.append({"key": key, "name": name, "type": canonical_type,
                              "matched": term is not None})

        if term is None:  # fall back to type-based widget (spec §1.2 step 4)
            if not serializable:
                return Resolution(action="lock", matched=False)
            schema = self._apply_default(dict(base_schema), None, has_default, default)
            return Resolution(action="form", widget=type_widget, schema=schema, matched=False)

        if term.role == "managed":
            policy = term.policy or {}
            if "pin" in policy:
                return Resolution(action="pin", pin_value=policy["pin"], role="managed", matched=True)
            return Resolution(action="lock", role="managed", matched=True)  # hidden, no value

        widget, bound = self._widget_for(term)
        schema = dict(base_schema)
        is_literal = "enum" in base_schema
        if term.values and not is_literal:        # dictionary fills enums only when annot is bare
            schema = {"type": "string", "enum": list(term.values)}
        elif term.canonical_type and type_widget == "text" and not is_literal:
            schema = dict(_TYPE_SCHEMA.get(term.canonical_type, {"type": "string"}))
        schema = self._apply_default(schema, term, has_default, default)
        return Resolution(action="form", widget=widget, bound_to=bound,
                          schema=schema, tooltip=term.help or "", role=term.role, matched=True)

    def coverage_report(self) -> dict:
        """Unmatched params ranked by reuse frequency (spec §1.9)."""
        from collections import defaultdict
        total = len(self.coverage)
        matched = sum(1 for r in self.coverage if r["matched"])
        unmatched = defaultdict(lambda: {"count": 0, "type": None, "functions": []})
        for r in self.coverage:
            if not r["matched"]:
                u = unmatched[r["name"]]
                u["count"] += 1
                u["type"] = r["type"]
                u["functions"].append(r["key"])
        ranked = sorted(
            ({"name": n, **v} for n, v in unmatched.items()),
            key=lambda x: x["count"], reverse=True,
        )
        return {"total_params": total, "matched": matched,
                "match_rate": round(matched / total, 3) if total else 1.0,
                "unmatched_terms": ranked}


DICTIONARY = TermDictionary()
