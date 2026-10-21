"""Build the Cirro app's raw-counts example store from the 10x Xenium lung demo.

The docs site's demo checkpoints (docs-site/viewer-data) drop the expression matrix to
stay small, so on them the app's gene analyses have nothing to work with. This store
keeps it: the 10x Genomics "Human Lung (2 FOV)" Xenium demo (11,898 cells x 289 genes,
raw counts, no clustering), with its cell boundaries and the morphology image from half
resolution down. Transcripts, label images and the full-resolution image level are left
out, which is what keeps it near 12 MB.

Reads test-data/xenium.zarr (make it with scripts/prepare_xenium_data.py) and writes
cirro-studio/examples/xenium-human-lung.sdata.zarr.zip, a ZIP_STORED zip of the store
with consolidated metadata, which is what the app reads by HTTP range:

    .venv-introspect/bin/python scripts/prepare_studio_example.py
"""
import os
import shutil
import tempfile
import warnings
import zipfile

warnings.filterwarnings("ignore")
import spatialdata as sd
from spatialdata.models import Image2DModel, TableModel
from spatialdata.transformations import Scale

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SOURCE = os.path.join(ROOT, "test-data", "xenium.zarr")
OUT = os.path.join(ROOT, "cirro-studio", "examples", "xenium-human-lung.sdata.zarr.zip")
IMAGE = "morphology_focus"
BOUNDARIES = "cell_boundaries"


def main():
    s = sd.read_zarr(SOURCE)
    half = s.images[IMAGE]["scale1"].image
    image = Image2DModel.parse(
        half.data, dims=("c", "y", "x"), c_coords=list(half.coords["c"].values),
        scale_factors=[2, 2, 2], transformations={"global": Scale([2.0, 2.0], axes=("x", "y"))},
    )
    table = s.tables["table"].copy()
    # The source table annotates the label image, which this store leaves out; the
    # boundaries carry the same cells, keyed by cell_id.
    boundaries = s.shapes[BOUNDARIES]
    assert set(boundaries.index) == set(table.obs["cell_id"]), "boundaries and cells disagree"
    table.obs["region"] = BOUNDARIES
    table.obs["region"] = table.obs["region"].astype("category")
    del table.uns["spatialdata_attrs"]
    table = TableModel.parse(table, region=BOUNDARIES, region_key="region", instance_key="cell_id")
    out = sd.SpatialData(images={IMAGE: image}, shapes={BOUNDARIES: boundaries}, tables={"table": table})
    # The reader that wrote the source says its coordinates are microns; the app's figure
    # scale bar reads it from here.
    out.attrs.update({k: v for k, v in s.attrs.items() if k.startswith("spatialdata_io_")})

    tmp = tempfile.mkdtemp()
    try:
        store = os.path.join(tmp, "store.zarr")
        out.write(store)
        sd.SpatialData.write_consolidated_metadata(sd.read_zarr(store))
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_STORED) as z:
            for dirpath, _, files in os.walk(store):
                for name in sorted(files):
                    path = os.path.join(dirpath, name)
                    z.write(path, os.path.relpath(path, store))
    finally:
        shutil.rmtree(tmp)
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB): {table.n_obs} cells x {table.n_vars} genes")


if __name__ == "__main__":
    main()
