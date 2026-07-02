"""Prepare a small example Xenium dataset for Spatial Data Studio.

Reads the 10x Genomics "Human Lung (2 FOV)" Xenium demo output (a real Xenium run,
11,898 cells x 289 genes, with cell/nucleus boundaries and a morphology image) with
`spatialdata_io.xenium` and writes a SpatialData `.zarr` to test-data/xenium.zarr
(~70 MB). The table holds RAW integer counts with NO clustering — that's the point:
the scanpy preprocessing recipes turn it into Leiden clusters. `obsm['spatial']` is
populated by the reader, so (unlike the Visium prep) no centroid backfill is needed.

First fetch + unzip the raw bundle (~278 MB; not committed — see .gitignore):

    mkdir -p test-data/_xenium_raw
    curl -L -o test-data/_xenium_raw/lung_2fov.zip \
      https://cf.10xgenomics.com/samples/xenium/2.0.0/Xenium_V1_human_Lung_2fov/Xenium_V1_human_Lung_2fov_outs.zip
    unzip -oq test-data/_xenium_raw/lung_2fov.zip -d test-data/_xenium_raw/lung_2fov

    python scripts/prepare_xenium_data.py
"""
import os
import shutil
import warnings

warnings.filterwarnings("ignore")
import spatialdata_io as sdio

RAW = os.path.join(os.path.dirname(__file__), "..", "test-data", "_xenium_raw", "lung_2fov")
OUT = os.path.join(os.path.dirname(__file__), "..", "test-data", "xenium.zarr")


def main():
    sdata = sdio.xenium(RAW)
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    sdata.write(OUT)
    t = sdata.tables["table"]
    print(f"wrote {os.path.abspath(OUT)}")
    print(f"  table {t.shape}, obsm: {list(t.obsm)}, "
          f"shapes: {list(sdata.shapes)}, images: {list(sdata.images)}")


if __name__ == "__main__":
    main()
