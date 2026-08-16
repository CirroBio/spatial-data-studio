"""Build the small demo checkpoints the documentation site embeds.

docs-site/ serves a live serverless viewer over a handful of `.sdata.zarr.zip` files
under `docs-site/viewer-data/`, committed so the Pages build never has to download or
rebuild them; the deploy job copies them in beside the built SPA at `/viewer/`. GitHub Pages caps a file at 100 MB and a site at 1 GB, while a
real session checkpoint runs 350-450 MB, so these are purpose-built small: a fully
synthetic multichannel section that needs no downloads at all, plus the Xenium TMA grid
fixture when it has been generated locally (scripts/prepare_xenium_tma.py).

Checkpoints are written through the app's own session machinery — the same path
backend/cli.py uses — so each carries a current `viewer/` sidecar and the default
displays the viewer opens on. The reader rejects a stale sidecar version
(persistence.store.VIEWER_SIDECAR_VERSION), so re-run this whenever the checkpoint
format moves, and commit the result.

    python scripts/prepare_demo_checkpoints.py
"""
import json
import os
import shutil
import sys
import tempfile
import warnings

warnings.filterwarnings("ignore")

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(_REPO_ROOT, "backend"))
os.environ.setdefault("SDS_MAX_SESSIONS", "64")
# `create_from_load` only opens stores under DATA_DIR (a multi-tenant server concern).
# Offline, the inputs are this repo's own staging dir and test-data/, so point it at the
# repo root rather than working around the guard.
os.environ.setdefault("SDS_DATA_DIR", _REPO_ROOT)

import numpy as np
import anndata as ad
import scipy.sparse as sp
import spatialdata as sd
from spatialdata.models import Image2DModel, TableModel

OUT_DIR = os.path.join(_REPO_ROOT, "docs-site", "viewer-data")
TMA_SRC = os.path.join(_REPO_ROOT, "test-data", "xenium_tma.zarr")

IMG_PX = 1024
N_CELLS = 1800
N_GENES = 60
CELL_TYPES = ["Tumor", "Stroma", "Immune", "Vessel"]
CHANNEL_NAMES = ["DAPI", "CD3", "PanCK"]


def _synthetic_section():
    """A multichannel fluorescence section with cells over it.

    Entirely generated, so the always-on demo has no download and no fixture behind it.
    Cells sit in the image's pixel space (identity transform) and carry a categorical
    cell type, a sparse expression matrix with type-enriched marker genes, and a 2-D
    embedding — enough to exercise colouring by category, by gene, the channel controls
    and the embedding view.
    """
    rng = np.random.default_rng(7)

    # Cells: four clusters, each a gaussian blob at its own centre.
    centres = np.array([[300, 320], [720, 300], [380, 720], [700, 740]], dtype=float)
    labels = rng.integers(0, len(CELL_TYPES), N_CELLS)
    xy = centres[labels] + rng.normal(0, 95, (N_CELLS, 2))
    xy = np.clip(xy, 8, IMG_PX - 8)

    # Expression: a shared baseline plus a per-type block of enriched markers, so
    # colouring by a marker gene visibly picks out one cluster.
    counts = rng.poisson(0.4, (N_CELLS, N_GENES)).astype("float32")
    per_type = N_GENES // len(CELL_TYPES)
    for t in range(len(CELL_TYPES)):
        rows = labels == t
        cols = slice(t * per_type, (t + 1) * per_type)
        counts[rows, cols] += rng.poisson(6.0, (rows.sum(), per_type)).astype("float32")

    adata = ad.AnnData(X=sp.csr_matrix(counts))
    adata.var_names = [f"{CELL_TYPES[i // per_type][:3].upper()}{i % per_type + 1}"
                       for i in range(N_GENES)]
    adata.var_names_make_unique()
    adata.obs_names = [f"cell_{i}" for i in range(N_CELLS)]
    adata.obs["cell_type"] = [CELL_TYPES[i] for i in labels]
    adata.obs["cell_type"] = adata.obs["cell_type"].astype("category")
    adata.obs["area"] = rng.gamma(9.0, 12.0, N_CELLS).astype("float32")
    adata.obsm["spatial"] = xy.astype("float32")
    # A 2-D embedding that separates the same four groups, so the Embeddings view is
    # worth opening. Not a real UMAP — it is a labelled scatter with the same structure.
    adata.obsm["X_umap"] = (centres[labels] / 120.0 + rng.normal(0, 0.35, (N_CELLS, 2))).astype("float32")

    # Image: one gaussian field per channel, brightest around that channel's cell types.
    yy, xx = np.mgrid[0:IMG_PX, 0:IMG_PX].astype("float32")
    planes = []
    for ch, focus in enumerate([centres, centres[[2]], centres[[0, 1]]]):
        field = np.zeros((IMG_PX, IMG_PX), dtype="float32")
        for cx, cy in focus:
            field += np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * 180.0 ** 2)))
        field += rng.normal(0, 0.03, field.shape)
        field = np.clip(field / max(field.max(), 1e-6), 0, 1)
        planes.append((field * (200 if ch == 0 else 235)).astype("uint8"))
    image = Image2DModel.parse(np.stack(planes), dims=("c", "y", "x"),
                               c_coords=CHANNEL_NAMES)

    return sd.SpatialData(images={"section": image},
                          tables={"table": TableModel.parse(adata)})


def _checkpoint_from_store(src_zarr: str, name: str) -> str:
    """Load a `.zarr` store through the app's session machinery and save a checkpoint.

    Going through SessionManager rather than calling `save_spatialdata` on a bare object
    is what gets the default displays (`auto_displays`) into `app_state`; a checkpoint
    without them opens on an empty canvas. Mirrors backend/cli.py's `_open_session`.
    """
    from app.registry.introspect import REGISTRY
    from app.sessions.manager import SessionManager
    from app.persistence.store import save_spatialdata
    from cli import _wait

    REGISTRY.build()
    manager = SessionManager(REGISTRY)
    sess = manager.create_from_load(os.path.abspath(src_zarr))
    try:
        load_id = next(j["job_id"] for j in sess.queue_view() if j["kind"] == "load")
        status = _wait(sess, load_id)
        if status != "completed":
            log, _ = sess.get_log(load_id)
            raise SystemExit(f"load of {src_zarr} failed ({status}):\n{log}")
        out = os.path.join(OUT_DIR, f"{name}.sdata.zarr.zip")
        with sess.lock.reading():
            return save_spatialdata(sess.sdata, out, sess.app_state, hash_name=False)
    finally:
        sess.shutdown()


def _build(name: str, sdata, tmp_root: str) -> str:
    src = os.path.join(tmp_root, f"{name}.zarr")
    sdata.write(src)
    return _checkpoint_from_store(src, name)


def main():
    from app.schemas import checkpoint as checkpoint_schemas

    os.makedirs(OUT_DIR, exist_ok=True)
    entries = []
    with tempfile.TemporaryDirectory(dir=_REPO_ROOT, prefix=".demo-build-") as tmp_root:
        written = _build("fluorescence-section", _synthetic_section(), tmp_root)
        entries.append({
            "path": os.path.basename(written),
            "label": "Fluorescence section (synthetic)",
            "description": "1,800 cells over a three-channel image. Colour by cell type "
                           "or a marker gene, and toggle the channels.",
        })

        if os.path.exists(TMA_SRC):
            # Staged into the build dir rather than loaded in place: in a git worktree
            # test-data/ is a symlink whose realpath sits outside this checkout, which
            # the DATA_DIR guard rejects. It is ~1 MB, so copying costs nothing.
            staged = os.path.join(tmp_root, "xenium_tma.zarr")
            shutil.copytree(os.path.realpath(TMA_SRC), staged)
            written = _checkpoint_from_store(staged, "tma-cores")
            entries.append({
                "path": os.path.basename(written),
                "label": "Tissue microarray cores",
                "description": "A 3x4 grid of cores laid out from real Xenium lung cells.",
            })
        else:
            print(f"[skip] tma-cores: missing {os.path.relpath(TMA_SRC, _REPO_ROOT)} "
                  f"(build it with scripts/prepare_xenium_tma.py)")

    index = {"title": "Spatial Data Studio demos", "checkpoints": entries}
    checkpoint_schemas.validate_checkpoint_index(index)
    index_path = os.path.join(OUT_DIR, "index.json")
    with open(index_path, "w") as fh:
        json.dump(index, fh, indent=2)
        fh.write("\n")

    print()
    total = 0.0
    for e in entries:
        mb = os.path.getsize(os.path.join(OUT_DIR, e["path"])) / 1e6
        total += mb
        print(f"[ok] {e['path']}  {mb:.1f} MB")
    print(f"[ok] wrote {index_path} ({len(entries)} demo(s), {total:.1f} MB total)")


if __name__ == "__main__":
    main()
