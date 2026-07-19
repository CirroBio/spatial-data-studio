"""Hand-written (non-library) functions. Each is a `Function` subclass registered
alongside the introspected library functions — squidpy/scanpy/spatialdata-io (see
registry/introspect.py).

Registration is by auto-discovery, like recipes (recipes/__init__.py's
`_load_bundled`): every concrete `Function` subclass defined in a custom/*.py
module is found by `_discover_custom_classes()` and instantiated into
`CUSTOM_FUNCTIONS`. Dropping a new file in this directory is all it takes — no
import line and no list edit here."""
from __future__ import annotations

import importlib
import inspect
import re
from pathlib import Path

_CUSTOM_DIR = Path(__file__).parent


def _discover_custom_classes() -> list[type]:
    """Every concrete `Function` subclass defined in a custom/*.py module, in a
    stable order (filename, then definition order within the file). This is the
    single source of truth for what gets registered. The predicate excludes the
    `Function` ABC, abstract intermediates, non-`Function` helpers (e.g.
    `_CNResultView`), and classes merely imported into a module (`cls.__module__`
    guard — no double registration). `_`-prefixed files and `__init__.py` are
    skipped, so private helpers can live behind a leading underscore."""
    from ..base import Function
    classes = []
    for path in sorted(_CUSTOM_DIR.glob("*.py")):
        if path.stem.startswith("_") or path.stem == "__init__":
            continue
        module = importlib.import_module(f".{path.stem}", package=__name__)
        for cls in vars(module).values():  # module __dict__ == definition order
            if (inspect.isclass(cls)
                    and issubclass(cls, Function) and cls is not Function
                    and cls.__module__ == module.__name__
                    and not inspect.isabstract(cls)):
                classes.append(cls)
    return classes


CUSTOM_FUNCTIONS = [cls() for cls in _discover_custom_classes()]


def _github_slug(heading: str) -> str:
    """GitHub's heading-anchor slug: lowercase, drop punctuation (keep word chars,
    hyphens, spaces), then spaces -> hyphens. Custom README headings are plain, so
    this matches GitHub's rendered anchor."""
    return re.sub(r"[^\w\- ]", "", heading.strip().lower()).replace(" ", "-")


def _dead_doc_anchors() -> list[str]:
    """Each custom function's `documentation` anchor must resolve to a heading in
    custom/README.md (P4: a typo becomes a named gate error, not a shipped 404)."""
    headings = set()
    for line in (_CUSTOM_DIR / "README.md").read_text().splitlines():
        m = re.match(r"#{1,6}\s+(.*)$", line)
        if m:
            headings.add(_github_slug(m.group(1)))
    problems = []
    for fn in CUSTOM_FUNCTIONS:
        doc = fn.documentation or ""
        if "#" not in doc:
            continue
        anchor = doc.split("#", 1)[1]
        if anchor not in headings:
            problems.append(
                f"{fn.key}: documentation anchor '#{anchor}' has no matching heading in custom/README.md")
    return problems


def check_custom_functions() -> list[str]:
    """Registry self-check for the custom functions — returns a list of
    human-readable problems (empty == all good). Enforces the closed vocabularies
    (widget/effect_class/role), the bound_to contract (None unless obs_value_map),
    unique keys, the key == namespace.function invariant, discovery/registration
    parity, and doc-anchor resolution. Run at
    REGISTRY.build() and by backend/check-contribution.sh; see CONTRIBUTING.md."""
    from ..base import WIDGETS, EFFECT_CLASSES, ROLES
    problems = []
    # Auto-discovery keys each function into REGISTRY.entries by fn.key, so two
    # custom classes declaring the same key would silently overwrite (one vanishes
    # from the picker). The hand list couldn't hit this; the scan can.
    keys = [fn.key for fn in CUSTOM_FUNCTIONS]
    for key in sorted({k for k in keys if keys.count(k) > 1}):
        offenders = ", ".join(type(fn).__name__ for fn in CUSTOM_FUNCTIONS if fn.key == key)
        problems.append(f"duplicate custom key '{key}' declared by: {offenders}")
    # Parity tautology today (the list IS the discovery output); it turns any future
    # divergence (e.g. someone reintroduces a manual list) into a named gate error.
    if len(CUSTOM_FUNCTIONS) != len(_discover_custom_classes()):
        problems.append(
            f"registration parity: {len(CUSTOM_FUNCTIONS)} registered vs "
            f"{len(_discover_custom_classes())} discovered custom classes")
    for fn in CUSTOM_FUNCTIONS:
        # The three identity fields are hand-kept in sync on the class; a mismatch
        # produces a picker entry whose key doesn't match its namespace/function
        # (breaking recipe steps that reference it). Assert the invariant instead.
        if fn.key != f"{fn.namespace}.{fn.function}":
            problems.append(
                f"{fn.key}: key must equal '{fn.namespace}.{fn.function}' "
                f"(namespace.function)")
        if fn.effect_class not in EFFECT_CLASSES:
            problems.append(f"{fn.key}: effect_class '{fn.effect_class}' not in {sorted(EFFECT_CLASSES)}")
        if fn.source == "custom" and fn.effect_class == "extract":
            # `extract` stays valid in EFFECT_CLASSES for reflected library functions
            # (the sc.get.* agent path), but a custom `extract` has no end-to-end path
            # to hand its return value to the user, so it silently vanishes. Steer the
            # contributor to the working pattern instead of letting them build a dead end.
            problems.append(
                f"{fn.key}: effect_class 'extract' is not supported for a custom function "
                f"(it is reserved for the reflected library agent path and has no result "
                f"path in the app). Write a 'compute' that stores your DataFrame/dict in "
                f"adata.uns['<your_key>'] and read it back from an exported checkpoint/"
                f"snapshot/Cirro object — see the 'Returning a table / numeric results' "
                f"section in CONTRIBUTING.md.")
        for p in fn.params:
            if p.widget not in WIDGETS:
                problems.append(f"{fn.key}.{p.name}: widget '{p.widget}' not in the closed widget set")
            if p.role not in ROLES:
                problems.append(f"{fn.key}.{p.name}: role '{p.role}' not in {sorted(ROLES)}")
            if p.bound_to is not None and p.widget != "obs_value_map":
                problems.append(
                    f"{fn.key}.{p.name}: bound_to must be None unless widget is obs_value_map "
                    f"(has widget '{p.widget}', bound_to '{p.bound_to}')")
    problems += _dead_doc_anchors()
    return problems
