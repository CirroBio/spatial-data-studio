# Link to your own dataset

A link can open one dataset in the web app, with nothing else around it. The section is
read straight from where you keep it, and every analysis the web app offers works on it.
Put the link on your lab's site or in a paper's supplement, or show it in a frame on any
web page. Nobody needs an account, and the data doesn't pass through Spatial Data Studio.

## Make the link

The link is the web app's address with `open=` and the address of a `.zarr.zip` file:

```
https://spatial-studio.apps.cirro.bio/?open=<the file's address, URL-encoded>
```

Encode the file's address, so that its own `?` and `&` (a presigned URL has both) stay part
of it:

```js
const link = 'https://spatial-studio.apps.cirro.bio/?open=' + encodeURIComponent(fileUrl);
```

```python
from urllib.parse import quote
link = "https://spatial-studio.apps.cirro.bio/?open=" + quote(file_url, safe="")
```

Whoever follows the link sees that dataset on its tissue view, read-only:

- Every analysis and display setting works, as in any [read-only project](find-a-dataset.md#projects).
  What they save stays in their browser.
- There is no project picker or map. **Spatial Data Studio** in the corner opens the full
  app in a new tab, and so does **Log In (Cirro)**.
- The header names the dataset by the name it gives itself (see
  [Prepare the file](#prepare-the-file)), or else by its file name. It also says which
  site the file comes from.
- A reload, or the same link opened later, comes back to the dataset. The versions saved
  on it in that browser come back too, even when a presigned link has been signed again.

## Host the file

Any https address the visitor's browser can read in pieces works: an S3 or Google Cloud
Storage bucket, CloudFront, or your own web server. The app reads only the parts of the
file the view needs (byte ranges) as the visitor looks, rather than downloading all of
it. So the host must:

- answer a `Range` request with `206 Partial Content`;
- let a page on another site read the file (CORS). That means allowing `GET` from
  `https://spatial-studio.apps.cirro.bio` with a `Range` header, and exposing `Content-Range` and
  `Content-Length`.

For an S3 bucket, that CORS rule is:

```json
[{
  "AllowedOrigins": ["https://spatial-studio.apps.cirro.bio"],
  "AllowedMethods": ["GET"],
  "AllowedHeaders": ["Range"],
  "ExposeHeaders": ["Content-Range", "Content-Length", "ETag"]
}]
```

Allow the web app's origin even when the link sits in a frame on your own page: the app
is what reads the file.

**Presigned URLs work.** You can share a file in a private bucket with a presigned URL:

```bash
aws s3 presign s3://my-bucket/my-section.zarr.zip --expires-in 604800
```

S3 allows at most seven days, and less when the signing credentials are temporary. The app reads the file with `GET` alone, which is what the
signature covers. The link works until the signature expires, and that includes a visitor
who is still looking: once it has expired, the view stops loading. For a link that should
last, make the file public instead.

## Put it on your page

As a link:

```html
<a href="https://spatial-studio.apps.cirro.bio/?open=…">Explore the section</a>
```

Or in a frame:

```html
<iframe src="https://spatial-studio.apps.cirro.bio/?open=…"
        style="width: 100%; height: 800px; border: 0"></iframe>
```

The web app runs in a frame only when it is opened this way. With no account behind it,
a page around it has nothing to act on. Any other page of the app opens in a tab of its
own. To put only the drawing of the section on your page, with your own controls around
it, use [the viewer](viewer.md#embed-it-in-another-page) instead.

## Prepare the file

The file is a [SpatialData](https://spatialdata.scverse.org/)
[store](glossary.md#store), zipped. There are two ways to make one.

### With the workflow

The repository's [workflow](../../nextflow/README.md) does the work for you:

1. It finds the datasets in a folder of instrument output: Xenium, Visium, Visium HD,
   MERSCOPE, CosMx, Curio, Steinbock or MCMICRO.
2. It reads each one with spatialdata-io.
3. It runs that data type's analysis: quality filtering, clustering, a UMAP and cellular
   neighborhoods.
4. It writes each dataset as a `.sdata.zarr.zip`.

```bash
git clone https://github.com/CirroBio/spatial-data-studio
nextflow run spatial-data-studio/nextflow/main.nf -profile docker --input /path/to/runs
```

Each dataset lands at `results/results/<where it was found>/results-<hash>.sdata.zarr.zip`,
named inside by where it was found. A `lowres-<hash>.sdata.zarr.zip` copy sits beside
it, with the image capped in size, which opens faster over a slow connection. Add
`--preprocess false` to write the datasets without the analysis.

A store the workflow writes is the quickest to open. It carries indexes that let the app
read one gene, or the cell outlines in view, without reading the rest. Hosted whole, the
`results/` folder is also a [public project](public-data.md#show-your-own-data) of every
dataset in the run. The workflow needs Nextflow and Docker; its README has every option.

### By hand, with spatialdata

Build the store in Python with spatialdata 0.3 or later, or read the data with one of
[spatialdata-io](https://spatialdata.scverse.org/projects/io/)'s readers, and write it.
The app needs:

- **A table with each cell's position** in `obsm["spatial"]`. If there are several, it
  shows the first table that has one. Keep raw counts in `X`, for the analyses:
  clustering normalizes counts itself and uses other values as they are. A table without
  `X` opens with only the analyses that don't need expression.
- **Consolidated metadata**, which `SpatialData.write` writes by default. Without it, the
  app can't see what the store holds.
- **Images placed against the cells** (optional): an image's transformation to the
  `global` coordinate system takes its pixels to the units of `obsm["spatial"]`.
- **Cell outlines** (optional): a shapes element of polygons. Without the workflow's
  index, the app reads all of an element's outlines the first time it draws them, and
  doesn't draw an element holding more than 32 MB of them.

Two optional entries in `sdata.attrs["app_state"]` set how the dataset opens:

- `name` is the title shown, in place of the file name.
- `displays` lists the views it opens on, and what each is colored by. When it is set, the
  app opens exactly these views, so list a UMAP view too if you want one. Leave it out for
  the defaults: the tissue, colored by the first grouping column over the first image, and
  a UMAP view when the table has a UMAP. [`CHECKPOINT_FORMAT.md`](../CHECKPOINT_FORMAT.md#33-displays)
  lists every field.

```python
import anndata as ad
import numpy as np
import spatialdata as sd
from spatialdata.models import Image2DModel, TableModel
from spatialdata.transformations import Scale

adata = ad.read_h5ad("cells.h5ad")  # raw counts in X, each cell's x and y in obsm["spatial"]
he = np.load("he.npy")              # the H&E image, as (channel, y, x)

sdata = sd.SpatialData(
    images={"he": Image2DModel.parse(
        he, dims=("c", "y", "x"), scale_factors=[2, 2],
        # One image pixel spans 4 units of obsm["spatial"].
        transformations={"global": Scale([4, 4], axes=("x", "y"))},
    )},
    tables={"table": TableModel.parse(adata)},
)
sdata.attrs["app_state"] = {
    "name": "Mouse brain, coronal section",
    "displays": [{
        "id": "tissue", "type": "spatial_canvas", "viewport": None,
        "encoding": {
            "coords": "obsm:spatial", "color_by": "obs:cluster", "image_layer": "he",
            "shapes_layer": None, "point_size": 4, "opacity": 0.85, "colormap": "viridis",
        },
    }],
}
sdata.write("my-section.zarr")
```

Then zip it without compression, with the store's own files at the top of the zip rather
than inside a folder. Every array in the store is compressed already, and the app can
read an uncompressed zip in pieces. The file's name must end in `.zarr.zip`.

```python
import pathlib
import zipfile

store = pathlib.Path("my-section.zarr")
with zipfile.ZipFile("my-section.zarr.zip", "w", zipfile.ZIP_STORED) as z:
    for f in sorted(store.rglob("*")):
        if f.is_file():
            z.write(f, f.relative_to(store).as_posix())
```

To add the indexes a workflow store carries, run your store through the repository's
command-line tool. It writes the store again the way the workflow would, without running
any analysis, keeping your `name` and adding a UMAP view if there's a UMAP:

```bash
cd spatial-data-studio/backend
python cli.py --parser zarr --input my-section.zarr --output finished
```

It needs the backend's Python environment; see
[Run offline](../../DEVELOPMENT.md#run-offline-headless-cli--nextflow).

## Check it

Open the link yourself before you share it. When the file can't be shown, the page says
why. It might be:

- a store that isn't Zarr v3;
- a store with no consolidated metadata;
- a store with no table of positions;
- a host that refused the file (for a presigned URL, usually because it expired);
- a host that ignored the byte range asked for.

A host without the CORS rule shows as a failed fetch.
