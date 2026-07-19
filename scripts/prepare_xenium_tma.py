"""Build a Xenium TMA test dataset for the "Identify TMAs" core detector.

No real Xenium tissue-microarray is publicly downloadable at a usable size (10x
Xenium TMA runs are 9-27 GB, and the small demos are all single sections). So this
lays out REAL Xenium cells — from the Human Lung demo in test-data/xenium.zarr — as
a regular grid of cores: each core is a jittered subsample of the lung cells,
offset onto a NROWS x NCOLS grid. The detector only uses obsm['spatial'] x/y, so a
grid of real cell clouds with a known core count is a faithful test of core
detection. Writes a table-only SpatialData to test-data/xenium_tma.zarr.

Requires test-data/xenium.zarr (see prepare_xenium_data.py) first.

    python scripts/prepare_xenium_tma.py
"""
import os
import shutil
import warnings

warnings.filterwarnings("ignore")
import numpy as np
import anndata as ad
import spatialdata as sd
from spatialdata.models import TableModel

SRC = os.path.join(os.path.dirname(__file__), "..", "test-data", "xenium.zarr")
OUT = os.path.join(os.path.dirname(__file__), "..", "test-data", "xenium_tma.zarr")
NROWS, NCOLS = 3, 4          # 12 cores
CELLS_PER_CORE = 1200
GAP = 1.6                    # core spacing as a multiple of the section extent


def main():
    lung = sd.read_zarr(SRC)
    table = lung.tables["table"]
    xy = np.asarray(table.obsm["spatial"])
    span_x = xy[:, 0].max() - xy[:, 0].min()
    span_y = xy[:, 1].max() - xy[:, 1].min()
    rng = np.random.default_rng(0)

    cores = []
    for r in range(NROWS):
        for c in range(NCOLS):
            idx = rng.choice(table.n_obs, size=min(CELLS_PER_CORE, table.n_obs), replace=False)
            core = table[idx].copy()
            offset = np.array([c * span_x * GAP, r * span_y * GAP])
            jitter = rng.normal(0, span_x * 0.01, size=(core.n_obs, 2))
            core.obsm["spatial"] = np.asarray(core.obsm["spatial"]) + offset + jitter
            core.obs_names = [f"r{r}c{c}_{n}" for n in core.obs_names]
            cores.append(core)

    merged = ad.concat(cores)
    merged.obs_names_make_unique()
    # Strip the source table's region annotation so it parses as a standalone table.
    merged.uns.pop("spatialdata_attrs", None)
    merged.obs = merged.obs.drop(columns=["region", "region_key", "instance_key"], errors="ignore")

    tma = sd.SpatialData(tables={"table": TableModel.parse(merged)})
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    tma.write(OUT)
    print(f"wrote {os.path.abspath(OUT)}")
    print(f"  table {merged.shape}  cores={NROWS * NCOLS} ({NROWS} rows x {NCOLS} cols)  "
          f"obsm={list(merged.obsm)}")


if __name__ == "__main__":
    main()
