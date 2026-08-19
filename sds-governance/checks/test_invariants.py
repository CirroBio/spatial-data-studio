"""Invariant checks (R3, R6/R7, R8-R10, R13). pytest; checks whose seam can't be
satisfied in the current environment skip visibly rather than passing falsely.

R6/R7 is checked statically, like R10: the two halves that are visible in the
source are enforced here, and the half that is not is left to review rather than
faked. Enforced: no history record goes back to `queued` from a terminal status,
and a compute run inserts a record instead of updating one. Not enforced: that a
record, once written, is never *removed* — `delete_entry` and `_drop_history`
remove records on purpose (a user deleting a kept failure, a cancel dropping a
queued row), so "append-only" cannot be read as "nothing is ever popped", and
telling a legitimate removal from an illegitimate one needs the run harness
(`config.SYNTH_FIXTURE`, still None) that R5 also waits on. See the per-test
docstrings for what each one does and does not constrain.
"""
import ast
import importlib
import sys

import pytest

import config


def _backend():
    sys.path.insert(0, str(config.BACKEND.parent))
    try:
        return importlib.import_module(config.REGISTRY_REF.split(":")[0])
    except Exception as e:
        pytest.skip(f"backend not importable here ({type(e).__name__}); wire the test env to enforce")


def _registry():
    importlib.import_module("app.registry.introspect")
    reg = getattr(importlib.import_module(config.REGISTRY_REF.split(":")[0]), config.REGISTRY_REF.split(":")[1])
    reg.build()
    return reg


def test_r3_one_schema_of_record():
    """Every function derives its form schema from `params` (json_schema + ui_schema)."""
    _backend()
    reg = _registry()
    for e in reg.entries.values():
        pub = e.to_public()
        assert "json_schema" in pub and "properties" in pub["json_schema"], e.key
        assert "ui_schema" in pub, e.key


def test_r8_effect_class_explicit():
    """Effect class is explicit and from the known set."""
    _backend()
    reg = _registry()
    for e in reg.entries.values():
        assert e.effect_class in {"compute", "plot", "read", "extract"}, (e.key, e.effect_class)


def test_r13_snapshot_assets_content_hashed():
    """Snapshot assets are content-hashed (sha256) for dedupe.

    Executes the hashing rather than grepping for the string `hashlib.sha256`, which a
    comment mentioning it satisfied: two different payloads must land on different
    artifact base names and the same payload must reproduce its own."""
    _backend()
    snapshots = importlib.import_module("app.snapshots")
    digest = getattr(snapshots, "_content_hash", None)
    if digest is None:
        pytest.skip("app.snapshots exposes no _content_hash to exercise")
    a, b = digest(b"payload-a"), digest(b"payload-b")
    assert a != b, "distinct snapshot payloads collide on one artifact name"
    assert digest(b"payload-a") == a, "snapshot hash is not deterministic"
    assert len(a) >= 8 and all(c in "0123456789abcdef" for c in a), a


def test_r10_state_changing_ops_are_queued_under_write_lock():
    """Compute mutations run on the worker under the write lock.

    Walks `Session._run_call`'s AST for an actual `with self.lock.writing()` block, rather
    than grepping session.py for the substring `acquire_write` anywhere in the file — the
    previous form passed on any file that merely mentioned the name."""
    tree = ast.parse((config.BACKEND / "sessions" / "session.py").read_text())
    session_cls = next((n for n in ast.walk(tree)
                        if isinstance(n, ast.ClassDef) and n.name == "Session"), None)
    assert session_cls is not None, "Session class not found in sessions/session.py"
    run_call = next((n for n in session_cls.body
                     if isinstance(n, ast.FunctionDef) and n.name == "_run_call"), None)
    assert run_call is not None, "Session._run_call not found"

    def _is_write_lock(item) -> bool:
        call = item.context_expr
        return (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                and call.func.attr == "writing")

    guarded = [n for n in ast.walk(run_call)
               if isinstance(n, ast.With) and any(_is_write_lock(i) for i in n.items)]
    assert guarded, "Session._run_call commits without holding self.lock.writing()"

    # The mutation queue is what serializes those commits.
    assert any(isinstance(n, ast.Attribute) and n.attr == "_queue"
               for n in ast.walk(session_cls)), "Session no longer owns a mutation queue"


# ---- R6/R7: append-only compute history --------------------------------------
# A compute-history record reaches one of these and stops. Putting such a record back
# to "queued" is the transition R6/R7 names: the run the user already saw finish would
# restart in the same row, and the first run's outcome would be overwritten instead of
# standing next to the second one in the audit log.
# `pending` (staged, never submitted) is deliberately absent: promoting a staged step to
# `queued` in place is its lifecycle, not a resurrection.
TERMINAL_STATUSES = frozenset({"completed", "failed"})

SESSION_PY = ("sessions", "session.py")


def _status_writes(stmts, fn, guards, out):
    """Collect every `<x>["status"] = "queued"` assignment, paired with the enclosing
    function and the `if` tests that dominate it. Recursive over statement lists rather
    than `ast.walk` because the dominating tests are what say whether a write is a
    resurrection or a legal lifecycle step, and `walk` loses that nesting."""
    for st in stmts:
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
            _status_writes(st.body, st, [], out)
        elif isinstance(st, ast.ClassDef):
            _status_writes(st.body, None, [], out)
        elif isinstance(st, ast.If):
            _status_writes(st.body, fn, guards + [st.test], out)
            _status_writes(st.orelse, fn, guards, out)
        elif isinstance(st, (ast.For, ast.AsyncFor, ast.While, ast.With, ast.AsyncWith, ast.Try)):
            for field in ("body", "orelse", "finalbody"):
                _status_writes(getattr(st, field, None) or [], fn, guards, out)
            for handler in getattr(st, "handlers", []):
                _status_writes(handler.body, fn, guards, out)
        elif isinstance(st, ast.Assign):
            for target in st.targets:
                if (isinstance(target, ast.Subscript)
                        and isinstance(target.slice, ast.Constant) and target.slice.value == "status"
                        and isinstance(st.value, ast.Constant) and st.value.value == "queued"):
                    out.append((fn, target.value, guards))


def _mentions(node, attr: str) -> bool:
    return any(isinstance(n, ast.Attribute) and n.attr == attr for n in ast.walk(node))


def _bindings(fn, name: str) -> list:
    """The values `name` is assigned in `fn` — how a bare `rec`/`job` is traced back to
    the collection it came out of."""
    return [st.value for st in ast.walk(fn) if isinstance(st, ast.Assign)
            for t in st.targets if isinstance(t, ast.Name) and t.id == name]


def _guarded_statuses(guards, name: str) -> set:
    """The prior statuses the dominating tests allow for `name` — from `x["status"] ==
    "..."` and `x["status"] in (...)`. Empty means the write is unguarded, which for a
    durable record is itself the violation: nothing stops it landing on a finished run."""
    allowed = set()
    for test in guards:
        for cmp_node in (n for n in ast.walk(test) if isinstance(n, ast.Compare)):
            left = cmp_node.left
            if not (isinstance(left, ast.Subscript) and isinstance(left.value, ast.Name)
                    and left.value.id == name and isinstance(left.slice, ast.Constant)
                    and left.slice.value == "status"):
                continue
            for op, comparator in zip(cmp_node.ops, cmp_node.comparators):
                if isinstance(op, ast.Eq) and isinstance(comparator, ast.Constant):
                    allowed.add(comparator.value)
                elif isinstance(op, ast.In) and isinstance(comparator, (ast.Tuple, ast.List, ast.Set)):
                    allowed.update(e.value for e in comparator.elts if isinstance(e, ast.Constant))
    return allowed


def test_r6_r7_no_history_record_returns_to_queued_from_a_terminal_status():
    """No durable history record is put back to `queued` once it has finished.

    Deny-by-default over `sessions/session.py`: *every* `x["status"] = "queued"` write
    has to justify itself, so a newly added one fails this check by existing rather than
    by matching a pattern anyone predicted. Two justifications are accepted, both
    checked from the source rather than assumed:

      - the target is an entry of `self._jobs`, the in-memory worker bookkeeping table.
        It is not the audit log — it is rebuilt per process and never persisted — so the
        worker returning a memory-held job to `queued` is not a history rewrite.
      - the target came from `self._find_record(..., "plot")`. Plots live in
        `app_state["plots"]`, not `compute_history`, and redraw deliberately reuses the
        same record and id so the figure cache key stays stable. R6/R7 is about compute.

    Anything else must be dominated by a test on its own current status, and that test's
    allowed set must not include a terminal one — which is the rule stated directly.

    Not constrained: a write that reaches the same state without the literal (a status
    constant, `dict.update`, a record handed to another module through the public
    `find_record`), and removals, which the module docstring covers."""
    session_py = config.BACKEND.joinpath(*SESSION_PY)
    writes = []
    _status_writes(ast.parse(session_py.read_text()).body, None, [], writes)
    assert writes, f"no status writes found in {session_py}; the check has lost its target"

    for fn, base, guards in writes:
        where = f"{fn.name if fn else '<module>'} in {'/'.join(SESSION_PY)}"
        # `self._jobs[job_id]["status"] = ...` — the base is the subscript into _jobs.
        if isinstance(base, ast.Subscript) and _mentions(base.value, "_jobs"):
            continue
        if not isinstance(base, ast.Name):
            raise AssertionError(
                f"{where} sets 'status' to 'queued' on an expression this check cannot "
                f"trace to a collection; assign it to a name first so the guard is visible")
        sources = _bindings(fn, base.id)
        if sources and all(_mentions(s, "_jobs") for s in sources):
            continue
        if any(isinstance(s, ast.Call) and _mentions(s.func, "_find_record")
               and any(isinstance(a, ast.Constant) and a.value == "plot" for a in s.args)
               for s in sources):
            continue
        allowed = _guarded_statuses(guards, base.id)
        assert allowed, (
            f"{where} returns '{base.id}' to 'queued' without testing its current status; "
            f"an already-completed run would restart in place (R6/R7)")
        assert not (allowed & TERMINAL_STATUSES), (
            f"{where} returns '{base.id}' to 'queued' from {sorted(allowed & TERMINAL_STATUSES)}; "
            f"a rerun appends a new record instead (R6/R7)")

    # `_set_status` writes rec["status"] = status with no guard of its own, so it is the
    # one call that would move a finished record without a "queued" literal in sight.
    for call in (n for n in ast.walk(ast.parse(session_py.read_text())) if isinstance(n, ast.Call)):
        if _mentions(call.func, "_set_status"):
            assert not any(isinstance(a, ast.Constant) and a.value == "queued" for a in call.args), \
                "_set_status(..., 'queued') bypasses the status guards in session.py (R6/R7)"

    # Only session.py owns the lifecycle; a route or the MCP surface reaching into
    # app_state to re-queue a record would be invisible to the sweep above.
    for path in sorted(config.BACKEND.rglob("*.py")):
        if path == session_py:
            continue
        elsewhere = []
        _status_writes(ast.parse(path.read_text()).body, None, [], elsewhere)
        assert not elsewhere, (
            f"{path.relative_to(config.BACKEND)} sets a record's status to 'queued'; the "
            f"history lifecycle lives in {'/'.join(SESSION_PY)} (R6/R7)")


def test_r6_r7_running_a_descriptor_appends_rather_than_updates():
    """A compute run inserts a history record; it never updates an existing one.

    `enqueue_descriptor` is the single entry point every compute descriptor is run
    through (`/jobs`, `/recipe/run`, `run_pending`, the MCP `run_function` tool), so
    "a rerun appends" is a property of that one function. Asserted from its AST: it
    mints a fresh uuid (a rerun cannot land on the earlier run's id), the only thing it
    does with the history collection is `append`, and it never reaches an existing
    record — neither through `_find_record` nor by indexing `app_state`. Those are the
    two shapes an "avoid growing the history" change would take, and the second is
    exactly what `redraw_plot` is allowed to do for plots.

    Not constrained: what happens to the record after it is appended (the sweep above
    covers its status), or whether the id is actually unique at runtime."""
    tree = ast.parse(config.BACKEND.joinpath(*SESSION_PY).read_text())
    session_cls = next((n for n in ast.walk(tree)
                        if isinstance(n, ast.ClassDef) and n.name == "Session"), None)
    assert session_cls is not None, "Session class not found in sessions/session.py"
    enqueue = next((n for n in session_cls.body
                    if isinstance(n, ast.FunctionDef) and n.name == "enqueue_descriptor"), None)
    assert enqueue is not None, "Session.enqueue_descriptor not found"

    calls = [n for n in ast.walk(enqueue) if isinstance(n, ast.Call)]
    assert any(_mentions(c.func, "uuid4") for c in calls), \
        "enqueue_descriptor no longer mints a fresh id; a rerun would reuse the first run's record"

    appended = {id(c.func.value) for c in calls
                if isinstance(c.func, ast.Attribute) and c.func.attr == "append"}
    collections = [c for c in calls
                   if isinstance(c.func, ast.Attribute) and c.func.attr == "_collection"]
    assert collections, "enqueue_descriptor no longer reaches the history collection"
    for coll in collections:
        assert id(coll) in appended, \
            "enqueue_descriptor uses the history collection for something other than append (R6/R7)"

    assert not any(_mentions(c.func, "_find_record") or _mentions(c.func, "find_record")
                   for c in calls), \
        "enqueue_descriptor looks up an existing record; a rerun must append a new one (R6/R7)"
    assert not any(isinstance(n, ast.Subscript) and _mentions(n.value, "app_state")
                   for n in ast.walk(enqueue)), \
        "enqueue_descriptor indexes app_state directly, bypassing the append (R6/R7)"
