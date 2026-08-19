"""Download the example checkpoints the documentation site embeds, from Cirro.

The three datasets below are public 10x demos (two Visium CytAssist sections and a
Xenium run) that were imported, analyzed and saved as checkpoints by the Nextflow
workflow, then deliberately downsampled for the web: the images are stored at reduced
resolution (a two-level pyramid, at most ~2,000 px on the long edge) and the expression
matrix is dropped entirely, which is why a whole section fits in tens of megabytes and
why the viewer offers no color-by-gene on them. What survives is what the demo is for —
the cells or spots, their obs columns (Leiden clusters, cellular neighborhoods, QC
metrics), the embeddings, the H&E image and, for Xenium, the segmentation boundaries.

They are committed under `docs-site/viewer-data/` so the Pages job never downloads
anything and never needs Cirro credentials; the deploy job copies them in beside the
built SPA at `/viewer/`. GitHub Pages caps a file at 100 MB and a site at 1 GB, which
these sit well inside. Re-run this only to refresh them:

    python scripts/fetch_example_checkpoints.py

Needs the `cirro` SDK (`pip install cirro`) and a Cirro login for the tenant below; the
SDK prompts for a browser device-code login on first use and caches the token.

Because these are already-written checkpoints rather than something this repo builds, a
checkpoint-format change means re-exporting them upstream, not re-running this script —
the viewer rejects a stale `persistence.store.VIEWER_SIDECAR_VERSION`.
"""
import json
import os
import shutil
import sys
import tempfile

from cirro import DataPortal

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(_REPO_ROOT, "backend"))

OUT_DIR = os.path.join(_REPO_ROOT, "docs-site", "viewer-data")

BASE_URL = "dev.cirro.bio"
PROJECT_ID = "9a31492a-e679-43ce-9f06-d84213c8f7f7"
DATASET_ID = "b49dac46-550f-4980-b108-3a53d5710cb5"

INDEX_TITLE = "Spatial Data Studio demos"

# Keyed by the file's path in the Cirro dataset, which is a published viewer deployment
# and so carries the workflow's own content-hashed names. `path` is the stable name this
# repo serves under: a re-publish changes the hash, and a docs page must not have to
# follow it. The order is the order the viewer's collection page lists them in.
EXAMPLES = {
    "data/sessions/Xenium-V1-Human-Pancreas-FFPE-eef00cfeeff5.sdata.zarr.zip": {
        "path": "xenium-human-pancreas.sdata.zarr.zip",
        "label": "Xenium human pancreas",
        "description": "122,678 cells with their segmentation boundaries, over an H&E "
                       "image. Color by Leiden cluster or cellular neighborhood.",
    },
    "data/sessions/CytAssist-FFPE-Human-Colon-01e85daec072.sdata.zarr.zip": {
        "path": "visium-human-colon.sdata.zarr.zip",
        "label": "Visium CytAssist human colon",
        "description": "6,356 spots over the CytAssist image, with Leiden clusters, "
                       "cellular neighborhoods and a UMAP.",
    },
    "data/sessions/CytAssist-FreshFrozen-Mouse-Brain-42aa9abc4ebb.sdata.zarr.zip": {
        "path": "visium-mouse-brain.sdata.zarr.zip",
        "label": "Visium CytAssist mouse brain",
        "description": "4,881 spots over the CytAssist image, with Leiden clusters, "
                       "cellular neighborhoods and a UMAP.",
    },
}


def _write_index():
    """Rewrite `index.json`, the manifest that makes `/viewer/` a browsable collection."""
    from app.schemas import checkpoint as checkpoint_schemas

    index = {"title": INDEX_TITLE, "checkpoints": list(EXAMPLES.values())}
    checkpoint_schemas.validate_checkpoint_index(index)

    with open(os.path.join(OUT_DIR, "index.json"), "w") as fh:
        json.dump(index, fh, indent=2)
        fh.write("\n")

    total = 0.0
    for entry in index["checkpoints"]:
        mb = os.path.getsize(os.path.join(OUT_DIR, entry["path"])) / 1e6
        total += mb
        print(f"[ok] {entry['path']}  {mb:.1f} MB")
    print(f"[ok] wrote index.json ({len(index['checkpoints'])} checkpoints, {total:.1f} MB total)")


def main():
    dataset = (DataPortal(base_url=BASE_URL)
               .get_project_by_id(PROJECT_ID)
               .get_dataset_by_id(DATASET_ID))
    files = {f.relative_path: f for f in dataset.list_files()}

    missing = sorted(set(EXAMPLES) - set(files))
    if missing:
        raise SystemExit(
            f"{dataset.name} no longer carries these files, so the hashed names in "
            f"EXAMPLES are stale:\n  " + "\n  ".join(missing))

    os.makedirs(OUT_DIR, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="cirro-fetch-") as staging:
        for source, entry in EXAMPLES.items():
            print(f"[get] {source}")
            files[source].download(staging)
            shutil.move(os.path.join(staging, source),
                        os.path.join(OUT_DIR, entry["path"]))

    print()
    _write_index()


if __name__ == "__main__":
    main()
