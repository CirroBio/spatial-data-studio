"""Lightweight, dataset-free snapshot-schema gate. Run as:

    PYTHONPATH=. python test_schema_gate.py            # check (CI + local)
    PYTHONPATH=. python test_schema_gate.py --write     # freeze a NEW version's golden

Catches two failure modes without the 375MB e2e dataset, so CI can run it cheaply:
  1. `snapshot-viewer.json` version was bumped but no frozen golden was added.
  2. The emitted config's SHAPE changed but the version (and golden) did not.

It asserts a frozen golden exists for the CURRENT `config.SNAPSHOT_VIEWER_VERSION`
and that `schema_signature` of a hand-written config matching the emitted envelope
(backend/app/snapshots.py::save_snapshot, spatial display) equals that golden.
The heavier `test_e2e.run_snapshot_flow` re-checks the SAME golden against a REAL
saved config, so this cheap check and the real one enforce the same shape.

When you INTENTIONALLY change the emitted snapshot shape (see the "Version the
snapshot viewer schema" rule in CLAUDE.md), the runbook is:
  1. Make the shape change in `backend/app/snapshots.py`.
  2. Mirror it in `reference_config()` below so the dataset-free gate matches.
  3. Bump `version` in `/snapshot-viewer.json` (semver).
  4. `PYTHONPATH=. python test_schema_gate.py --write` to freeze the new
     `snapshot_schema/<newversion>.json` golden. `--write` REFUSES to overwrite an
     existing golden, so a shape change with no version bump can't silently mutate
     an already-frozen (potentially already-published) version's oracle.
  5. `PYTHONPATH=. python test_schema_gate.py` to confirm it passes.

Only stdlib + `app.config` are imported (no heavy scientific deps).
"""
from __future__ import annotations

import json
import sys

from app.config import config
from snapshot_schema import schema_signature, golden_path, load_golden

REMEDIATION = (
    "Snapshot schema changed — bump `version` in snapshot-viewer.json, add "
    "snapshot_schema/<newversion>.json, and republish the viewer."
)


def reference_config() -> dict:
    """A minimal but shape-complete config matching what save_snapshot emits for a
    spatial display with an image: same envelope keys, same spatial-canvas encoding
    (app/sessions/manager.py::auto_displays), same render.image (imaging.image_info)
    and channel-index-keyed render.channels. Values are placeholders — only SHAPE is
    asserted, and the channel indices exercise the `*` collapse."""
    return {
        "schema_version": config.SNAPSHOT_VIEWER_VERSION,
        "kind": "spatial",
        "label": "reference",
        "created": "2026-01-01T00:00:00+00:00",
        "data": "./ref.zarr.zip",
        "checkpoint": {"name": "ref.zarr.zip"},
        "table": "table",
        "viewport": {"target": [0.0, 0.0], "zoom": 0.0},
        "encoding": {
            "coords": "obsm:spatial",
            "color_by": "obs:cluster",
            "image_layer": "hne",
            "shapes_layer": None,
            "render_mode": "points",
            "point_marker": "circle",
            "point_size": 4,
            "opacity": 0.85,
            "colormap": "viridis",
            "legend_visible": True,
            "legend_title": "",
        },
        "render": {
            "coords": "obsm:spatial",
            "coords_transform": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "color_by": "obs:cluster",
            "point_size": 4,
            "opacity": 0.85,
            "image": {
                "element": "hne",
                "height": 512,
                "width": 512,
                "channels": 3,
                "channel_names": ["r", "g", "b"],
                "bounds": [0.0, 0.0, 512.0, 512.0],
                "pixel_to_world": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                "levels": [{"level": 0, "width": 512, "height": 512}],
                "tile_size": 512,
            },
            "channels": {
                "0": {"visible": True, "color": "#ff0000", "contrast_limit": 255.0},
                "1": {"visible": True, "color": "#00ff00", "contrast_limit": 255.0},
                "2": {"visible": False, "color": "#0000ff", "contrast_limit": 255.0},
            },
        },
    }


def write_golden() -> None:
    """Freeze the current version's golden from `reference_config()`. Refuses to
    overwrite an existing golden: a golden, once written, is immutable — a shape
    change is only ever paired with a NEW version (bump `snapshot-viewer.json`
    first). To re-freeze a not-yet-committed version you must delete its golden by
    hand, which keeps the mutation deliberate and visible in review."""
    version = config.SNAPSHOT_VIEWER_VERSION
    gp = golden_path(version)
    if gp.exists():
        print(f"[FAIL] golden {gp.name} already exists and is immutable.\n"
              f"       If you changed the snapshot shape, bump `version` in "
              f"snapshot-viewer.json first, then re-run --write for the new version.")
        sys.exit(1)
    signature = schema_signature(reference_config())
    gp.write_text(json.dumps(signature, indent=2) + "\n")
    print(f"[ok] wrote {gp.name} ({len(signature)} key-paths). Commit it and keep it immutable.")


def main() -> None:
    if "--write" in sys.argv[1:]:
        write_golden()
        return

    version = config.SNAPSHOT_VIEWER_VERSION
    gp = golden_path(version)
    if not gp.exists():
        print(f"[FAIL] no frozen golden for snapshot schema version {version} ({gp}).\n{REMEDIATION}")
        sys.exit(1)

    signature = schema_signature(reference_config())
    golden = load_golden(version)
    if signature != golden:
        missing = sorted(set(golden) - set(signature))
        extra = sorted(set(signature) - set(golden))
        print(f"[FAIL] snapshot schema signature != frozen golden {gp}.")
        if missing:
            print(f"       dropped paths: {missing}")
        if extra:
            print(f"       new paths: {extra}")
        print(REMEDIATION)
        sys.exit(1)

    print(f"[ok] snapshot schema gate: version {version}, {len(golden)} frozen key-paths match {gp.name}")


if __name__ == "__main__":
    main()
