"""Prepare the test dataset used to validate squidpy-viewer.

Downloads squidpy's `visium_hne_sdata` example (a single mouse-brain Visium H&E
section: 2688 spots x 18078 genes, with an H&E image and `leiden`/`cluster`
annotations), backfills `obsm['spatial']` from the spot-shape centroids (squidpy's
AnnData functions and the canvas's default `obsm:spatial` both need it), strips any
precomputed spatial graph so the app starts from a clean state, and writes a
SpatialData `.zarr` to test-data/visium_hne.zarr.

    python scripts/prepare_test_data.py
"""
import os
import shutil
import warnings

warnings.filterwarnings("ignore")
import numpy as np
import squidpy as sq

OUT = os.path.join(os.path.dirname(__file__), "..", "test-data", "visium_hne.zarr")


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    sdata = sq.datasets.visium_hne_sdata()
    ad = sdata.tables["adata"]
    shapes = sdata.shapes["spots"]

    centroids = np.column_stack([shapes.geometry.x.values, shapes.geometry.y.values])
    attrs = ad.uns.get("spatialdata_attrs", {})
    instance_key = attrs.get("instance_key")
    if instance_key and instance_key in ad.obs:
        pos = {idx: i for i, idx in enumerate(shapes.index)}
        rows = [pos[o] for o in ad.obs[instance_key].values]
        ad.obsm["spatial"] = centroids[rows]
    else:
        ad.obsm["spatial"] = centroids

    for key in ("spatial_connectivities", "spatial_distances"):
        ad.obsp.pop(key, None)
    for key in list(ad.uns.keys()):
        if "nhood" in key.lower() or key == "_results":
            ad.uns.pop(key, None)

    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    sdata.write(OUT)
    print(f"wrote {os.path.abspath(OUT)}")
    print(f"  table {ad.shape}, obs categoricals: "
          f"{[c for c in ad.obs.columns if str(ad.obs[c].dtype) == 'category']}")


if __name__ == "__main__":
    main()
