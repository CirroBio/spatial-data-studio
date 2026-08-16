# Tissue microarray cores

A 3×4 grid of tissue-microarray cores. The cells are real — subsampled from the 10x
Xenium human lung demo — laid out on a regular grid by
[`scripts/prepare_xenium_tma.py`](https://github.com/CirroBio/spatial-data-studio/blob/main/scripts/prepare_xenium_tma.py)
so there is a known core count to detect against.

<ViewerEmbed
  checkpoint="tma-cores.sdata.zarr.zip"
  label="Tissue microarray cores"
  height="720px"
/>

## Things to try

- **Zoom into a single core.** Each is a jittered subsample of the same lung section, so
  they share structure without being identical.
- **Change the point shape and size.** At this density, square or hexagon glyphs read
  differently from circles — overlapping points are merged rather than blended, so the
  picture stays honest as you zoom out.

## Why this dataset exists

It is the fixture behind the "Identify TMAs" core detector: no real Xenium TMA is
publicly downloadable at a workable size (10x TMA runs are 9–27 GB and the small demos
are all single sections), so a grid of real cell clouds with a known core count stands in.
This is a table-only object — no image, no shapes — which is also why it is a useful
check that the viewer behaves when a checkpoint carries nothing but cells.
