# Custom functions

Hand-written operations that scanpy/squidpy don't provide, registered alongside
the introspected library functions (see `../introspect.py`). Each is a `Function`
subclass in this folder. Every entry below is what a custom function's
**Documentation** link in the app points at; its **Citation** (the source the
method was taken from, or a note that it's original to this repo) is set on the
class. When you add a custom function, add a section here and keep its heading's
GitHub anchor in sync with the `custom_doc("...")` call in the class (see
`../../../CLAUDE.md`).

Effect class is noted per method: `compute` mutates the active table in place;
`plot` renders a server-side figure from what a paired compute step stored.

---

## Leiden clustering

`custom.leiden` (compute). Leiden community detection over an existing
neighbours graph, writing the cluster label to a new categorical `obs` column.
Provided instead of `sc.tl.leiden`/`sc.tl.louvain` because their usual backends
(python-igraph, leidenalg, louvain) are GPL — the partitioning runs on the
MIT-licensed graspologic core. Run `sc.pp.neighbors` first.

**Citation:** Traag, Waltman & van Eck, *From Louvain to Leiden: guaranteeing
well-connected communities*, Sci Rep 9:5233 (2019).

## Identify regions (Leiden)

`custom.identify_regions_leiden` (compute). Runs Leiden on a nearest-neighbour
graph built directly from the **spatial coordinates** (not expression), so the
resulting clusters are contiguous tissue regions rather than cell types. Writes
a new categorical `obs` column. A spatial-region variant original to this repo,
using the same graspologic Leiden core as above.

**Citation:** Leiden clustering (Traag et al., 2019) applied to spatial
coordinates; spatial variant original to this repository.

## Edit annotations

`custom.edit_annotations` (compute). Rename or merge the values (categories) of
an existing categorical `obs` column — e.g. collapse several fine clusters into
one label, or give clusters meaningful names. Original utility of this repo.

**Citation:** Original utility implemented in this repository.

## Identify TMAs

`custom.identify_tmas` (compute). Auto-detects the cores of a tissue microarray
by clustering the cell coordinates into spatially separated groups, and labels
each cell with its core id in a new `obs` column. Original method of this repo.

**Citation:** Original tissue-microarray core detector implemented in this
repository.

## Region composition

`custom.region_composition` (compute) + `custom.region_composition_plot`
(plot). Cross-tabulates a cell-type column against a region column to get the
cell-type proportions per region, and runs a chi-square test of independence for
whether composition differs across regions. The plot step renders a stacked bar
of the proportions. pandas/scipy/matplotlib only.

**Citation:** Original method implemented in this repository (crosstab +
chi-square test of independence).

## Annotate cells with CellTypist

`custom.celltypist_annotate` (compute). Predicts a cell-type label per cell with
a pre-trained [CellTypist](https://www.celltypist.org/) model, writing a
categorical `<key_added>` column plus a `<key_added>_conf` confidence column.
Input is log1p / 1e4-normalized on a copy by default; the chosen model is
downloaded on first use.

**Citation:** Domínguez Conde et al., *Cross-tissue immune cell analysis reveals
tissue-specific features in humans*, Science 376:eabl5197 (2022).

## Cellular neighborhoods

`custom.cellular_neighborhoods` (compute) + `custom.cellular_neighborhoods_plot`
(plot). For each cell, takes the cell-type composition of its spatial window
(its k nearest neighbours), then clusters those composition vectors into a set of
recurring multicellular niches ("cellular neighborhoods"), written to a new `obs`
column. The plot step shows the neighborhood map, an enrichment heatmap, and
composition bars. numpy/scipy/scikit-learn only.

**Citation:** Schürch et al., *Coordinated Cellular Neighborhoods Orchestrate
Antitumoral Immunity at the Colorectal Cancer Invasive Front*, Cell
182:1341–1359 (2020).

## Milo differential abundance

`custom.milo_differential_abundance` (compute) +
`custom.milo_differential_abundance_plot` (plot). Tests which small, overlapping
neighborhoods of a kNN graph (in an embedding) shift in cell abundance between
two conditions, using a negative-binomial GLM with spatial FDR correction.
Needs a sample key, a two-level condition key, and enough samples per condition.
Results are stored in `uns` for the plot step.

**Citation:** Dann et al., *Differential abundance testing on single-cell data
using k-nearest neighbor graphs*, Nat Biotechnol 40:245–253 (2022) (Milo).

## LISI scores

`custom.lisi_scores` (compute) + `custom.lisi_scores_plot` (plot). Local Inverse
Simpson's Index: the effective number of label categories in each cell's local
neighborhood of an embedding. `batch_key` scores batch mixing (iLISI);
`label_key` scores cell-type separation (cLISI). A per-cell integration-quality
diagnostic with no scanpy/squidpy equivalent. The plot step shows the score
distributions and the embedding colored by LISI.

**Citation:** Korsunsky et al., *Fast, sensitive and accurate integration of
single-cell data with Harmony*, Nat Methods 16:1289–1296 (2019) (LISI).

## Proximity and avoidance test

`custom.proximity_test` (compute) + `custom.proximity_test_plot` (plot). For each
ordered pair of cell types, compares the observed nearest-neighbour distance from
one type to the other against a label-permutation null, yielding a z-score for
attraction (closer than chance) or avoidance (farther than chance). Distinct
from squidpy's distance-binned `co_occurrence`. The plot step renders the
pairwise z-score heatmap. Original method of this repo.

**Citation:** Original permutation-based proximity/avoidance test implemented in
this repository.

## Region boundary and infiltration

`custom.region_boundary` / `custom.region_boundary_plot` and
`custom.infiltration_profile` / `custom.infiltration_profile_plot` (compute +
plot). Derives a tissue region from cell-type labels (no hand-drawn geometry),
computes each cell's **signed distance** to the region margin (negative inside,
positive outside), and then profiles a target population's abundance as a
function of that distance — the infiltration curve. Original method of this repo.

**Citation:** Original method implemented in this repository.

## Pseudobulk DE with DESeq2

`custom.pseudobulk_deseq2` (compute) + `custom.pseudobulk_deseq2_plot` (plot).
Sums **raw integer counts** per (sample × cell type) into bulk-like profiles and
runs PyDESeq2 with the samples as replicates and an explicit condition contrast,
one fit per cell type — the replicate-aware alternative to `rank_genes_groups`
for condition comparisons. Requires ≥2 pseudobulk samples per condition per cell
type (others are skipped). The plot step renders a volcano for a chosen cell type.

**Citation:** Love, Huber & Anders, *Moderated estimation of fold change and
dispersion for RNA-seq data with DESeq2*, Genome Biol 15:550 (2014); pseudobulk
aggregation per Squair et al., Nat Commun 12:5692 (2021).
