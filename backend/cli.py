"""Offline analysis runner — the headless, batch equivalent of the interactive app.

Reuses the exact engine the FastAPI server drives: the introspected function
`REGISTRY`, a `SessionManager` + `Session` worker, recipe step descriptors, and
`persistence.store.save_spatialdata`. A recipe run here therefore produces the
same SpatialData object and the same plots as running those steps in the UI —
reading, compute, plot capture, and saving are not reimplemented anywhere below.

Run from the `backend/` directory (like `test_e2e.py`):

    python cli.py --parser io.xenium --input /path/to/xenium_bundle \\
        --recipe app/recipes/06_preprocess_cluster_raw_counts.json --output out/

    python cli.py --parser zarr --input ../test-data/visium_hne.zarr \\
        --recipe app/recipes/01_neighborhood_enrichment.json --output out/

`--parser` selects a spatialdata-io / squidpy reader by its registry key
(`io.xenium`) or bare function name (`xenium`), or the sentinel `zarr`/
`spatialdata` to load an existing SpatialData `.zarr`/`.zarr.zip` (the app's
New Session "load" path). The output folder receives `<name>.zarr.zip` (the full
object + app_state) and, per plot step, `plots/<NN>_<namespace>.<function>/
figure.{svg,pdf}`.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ZARR_PARSERS = ("zarr", "spatialdata")


def _parse_args(argv):
    p = argparse.ArgumentParser(
        prog="cli.py", description="Run a recipe over an input dataset, headless.")
    p.add_argument("--parser", required=True,
                   help="reader registry key (io.xenium), bare reader name (xenium), "
                        "or 'zarr'/'spatialdata' to load an existing SpatialData store")
    p.add_argument("--input", required=True,
                   help="path to the raw data folder (reader mode) or the .zarr/.zarr.zip (zarr mode)")
    p.add_argument("--recipe", required=True,
                   help="path to a recipe JSON file, or the name of a bundled recipe")
    p.add_argument("--recipe-params", default=None,
                   help="JSON object of recipe-level parameter overrides (see the recipe's "
                        "`params`); values fill the recipe's $param references, defaults apply otherwise")
    p.add_argument("--output", required=True, help="output directory (created if absent)")
    p.add_argument("--reader-params", default=None,
                   help="JSON object of extra kwargs merged into the reader call (reader mode only)")
    p.add_argument("--name", default=None,
                   help="base name for the output .zarr.zip (default: derived from --input)")
    p.add_argument("--list-parsers", action="store_true",
                   help="print the available parser names and exit")
    return p.parse_args(argv)


def _read_entries(registry):
    """Registry keys of every read-effect function (spatialdata-io + squidpy readers)."""
    return sorted(e.key for e in registry.entries.values() if e.effect_class == "read")


def _resolve_reader(registry, parser):
    """Map --parser to a (namespace, function) reader, or raise SystemExit listing
    the valid choices. Sentinels are handled by the caller before this is reached."""
    readers = _read_entries(registry)
    if "." in parser:
        matches = [k for k in readers if k == parser]
    else:
        matches = [k for k in readers if k.split(".", 1)[1] == parser]
    if len(matches) == 1:
        fn = registry.get(matches[0])
        return fn.namespace, fn.function
    choices = ", ".join(readers + list(ZARR_PARSERS))
    raise SystemExit(f"unknown or ambiguous --parser {parser!r}; choose one of: {choices}")


def _wait(sess, job_id, timeout=7200, interval=0.2):
    """Block (in this thread, not the worker) until a Session job reaches a terminal
    status, returning it. Mirrors the server's job polling; no cap is meaningful for
    an offline single run, so the timeout is generous."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = sess.job_status(job_id)
        if st in ("completed", "drawn", "failed", "cancelled"):
            return st
        time.sleep(interval)
    raise TimeoutError(f"job {job_id} did not finish within {timeout}s")


def _output_name(args) -> str:
    if args.name:
        return args.name
    stem = Path(args.input.rstrip("/")).name
    for suffix in (".zarr.zip", ".zarr"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
    return stem or "session"


def _load_recipe_steps(recipe_arg: str, param_values: dict | None) -> list:
    """Resolved steps of a recipe given as a file path, or (fallback) a bundled
    recipe name. `param_values` fills the recipe's $param references (declared
    defaults apply where a value is absent)."""
    from app import recipes
    path = Path(recipe_arg)
    if path.is_file():
        recipe = json.loads(path.read_text())
    else:
        recipe = next((r for r in recipes.catalog() if r["name"] == recipe_arg), None)
        if recipe is None:
            names = ", ".join(r["name"] for r in recipes.catalog())
            raise SystemExit(f"recipe {recipe_arg!r} is neither an existing file nor a bundled "
                             f"recipe. Bundled: {names}")
    return recipes.resolve_steps(recipe, param_values)


def _open_session(manager, args, reader):
    """Bootstrap a session from a reader (running the read job) or a saved store."""
    resolved_input = str(Path(args.input).resolve())
    if reader is None:  # zarr / spatialdata sentinel: load an existing store
        return manager.create_from_load(resolved_input)
    namespace, function = reader
    params = {"path": resolved_input}
    if args.reader_params:
        params.update(json.loads(args.reader_params))
    sess = manager.create_from_read({"namespace": namespace, "function": function, "params": params})
    # The read bootstrap is the session's first (and, here, only) queued job.
    read_id = sess.app_state["compute_history"][-1]["id"]
    if _wait(sess, read_id) != "completed":
        log, _ = sess.get_log(read_id)
        raise SystemExit(f"reader {namespace}.{function} failed:\n{log}")
    return sess


def _write_plot(out_dir: Path, index: int, step: dict, figures: dict):
    folder = out_dir / "plots" / f"{index:02d}_{step['namespace']}.{step['function']}"
    folder.mkdir(parents=True, exist_ok=True)
    for fmt, data in (("svg", figures.get("svg")), ("pdf", figures.get("pdf"))):
        if data:
            (folder / f"figure.{fmt}").write_bytes(data)
    return folder


def _run_steps(sess, steps: list, out_dir: Path) -> int:
    plots_written = 0
    for i, step in enumerate(steps, start=1):
        label = f"{step['namespace']}.{step['function']}"
        job_id = sess.enqueue_descriptor(step, keep_failures=True)
        status = _wait(sess, job_id)
        if status in ("failed", "cancelled"):
            log, _ = sess.get_log(job_id)
            raise SystemExit(f"step {i} ({label}) {status}:\n{log}")
        if status == "drawn" and job_id in sess.plot_figures:
            folder = _write_plot(out_dir, i, step, sess.plot_figures[job_id])
            plots_written += 1
            print(f"[{i:02d}] {label} drawn -> {folder}")
        else:
            print(f"[{i:02d}] {label} {status}")
    return plots_written


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    # Env must be set BEFORE importing app.config (Config reads it at import time).
    # SQV_DATA_DIR makes the input readable past the server's data-root allowlist;
    # SQV_CHECKPOINT_DIR is where ingest raster tiling caches. Offline runs are
    # single-shot and single-tenant, so lift the memory/session admission limits
    # unless the caller pinned them.
    out_dir = Path(args.output).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    os.environ["SQV_DATA_DIR"] = str(Path(args.input).resolve().parent)
    os.environ["SQV_CHECKPOINT_DIR"] = str(out_dir)
    os.environ.setdefault("SQV_CONTAINER_MEM_MB", "65536")
    os.environ.setdefault("SQV_MAX_SESSIONS", "64")

    from app.registry.introspect import REGISTRY
    from app.sessions.manager import SessionManager
    from app.persistence.store import save_spatialdata

    REGISTRY.build()

    if args.list_parsers:
        for name in _read_entries(REGISTRY) + list(ZARR_PARSERS):
            print(name)
        return 0

    reader = None if args.parser in ZARR_PARSERS else _resolve_reader(REGISTRY, args.parser)
    param_values = json.loads(args.recipe_params) if args.recipe_params else None
    steps = _load_recipe_steps(args.recipe, param_values)

    manager = SessionManager(REGISTRY)
    sess = _open_session(manager, args, reader)
    print(f"[ok] loaded via {args.parser}: {args.input}")
    try:
        plots_written = _run_steps(sess, steps, out_dir)
        out_zip = out_dir / f"{_output_name(args)}.zarr.zip"
        # Save directly rather than through the queued save job, whose write-path guard
        # (within_checkpoint_dir) is a multi-tenant server concern; offline output goes
        # wherever the caller asked.
        with sess.lock.reading():
            saved = save_spatialdata(sess.sdata, str(out_zip), sess.app_state, hash_name=False)
    finally:
        sess.shutdown()

    size_mb = os.path.getsize(saved) / 1e6
    print(f"\n[ok] ran {len(steps)} step(s), wrote {plots_written} plot(s)")
    print(f"[ok] saved {saved} ({size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
