# Spatial transcriptomics & proteomics — a working primer

What the measurements mean, how to judge data quality, and how to interpret the
standard analyses. This is the domain knowledge behind the playbooks guide.

## Platforms and what a "cell" is

- **Sequencing-based, spot resolution** — 10x **Visium** (55 µm spots on a hex grid,
  ~1–10 cells per spot, whole transcriptome), **Visium HD** (2–16 µm bins), Slide-seq,
  **Curio**. A *spot is a mixture of cells*: composition, not single-cell identity.
  Expect deep counts per spot (thousands of UMIs) over ~18k genes.
- **Imaging-based, single-cell resolution** — 10x **Xenium**, Vizgen **MERSCOPE**
  (MERFISH), NanoString **CosMx**. A targeted *panel* of a few hundred to ~5k genes,
  counts per cell are low (tens to a few hundred transcripts), but true single cells
  with segmented boundaries and subcellular transcript positions.
- **Proteomics imaging** — CODEX/PhenoCycler, IMC (**steinbock**/**mcmicro**
  outputs): dozens of protein markers per segmented cell; treat marker intensity
  like a small, dense expression matrix (normalization differs; clustering and
  neighborhood logic carry over).

Implications: panel data can't do discovery outside the panel; spot data can't
assign single-cell types without deconvolution; imaging counts are sparse, so
cluster on many cells rather than trusting any single cell's profile.

## Segmentation and its artifacts (imaging platforms)

Cell boundaries come from nuclear expansion or membrane staining. Typical errors:
transcript spillover between adjacent cells (creates phantom co-expression —
e.g. immune markers "in" tumor cells at interfaces), fused cells, over-split large
cells. Judge by: transcripts-per-cell distribution, negative-control probe rates,
and visual inspection of boundaries (`render_mode: points+shapes` zoomed in). Be
skeptical of rare "hybrid" clusters that sit exactly at tissue interfaces.

## QC — what to compute and what the numbers mean

`sc.pp.calculate_qc_metrics` writes per-cell `obs` columns
(`total_counts`, `n_genes_by_counts`, `pct_counts_mt` when mito genes are flagged)
and per-gene `var` columns. Interpretation:

- **Low total_counts / n_genes**: empty or dying cells (sequencing) or poorly
  segmented slivers (imaging). Filter conservatively — imaging platforms are
  *supposed* to be low-count (a 300-gene panel cell with 50 transcripts is fine;
  a Visium spot with 50 UMIs is garbage).
- **High pct_counts_mt** (sequencing): stressed/lysed cells. Typical cutoffs 10–20%;
  tissue-dependent.
- **Spatial QC**: always view QC metrics *on the tissue* (`color_by` the QC column).
  A low-quality *stripe or edge* is a section/technical artifact — filtering it is
  fine; a low-quality *anatomical structure* may be real biology (necrotic core,
  low-RNA tissue like adipose) — filtering it deletes the biology.

## Normalization

`sc.pp.normalize_total` + `sc.pp.log1p` is the default (library-size normalize, then
log). It overwrites `X` in place. For panel data, total counts partly reflect real
cell size/type, so normalization is debated — the standard pipeline still applies it.
DE methods that need raw counts (pseudobulk DESeq2) must run on a saved counts layer
or a fresh session — check before normalizing twice (a second `log1p` is a real and
common corruption; the history shows whether it already ran).

## Clusters vs cell types

`custom.leiden` clusters the expression kNN graph (`sc.pp.neighbors` on
`sc.pp.pca`). Clusters are *hypotheses*: validate with marker genes
(`sc.tl.rank_genes_groups` + dotplot) and, in tissue, by spatial plausibility.
Assign identities via known markers or `custom.celltypist_annotate` (pre-trained
models; majority-vote per over-cluster). Resolution controls granularity — start
~1.0, refine where biology demands. A cluster driven by a QC covariate (counts
gradient) or by section position alone is usually technical.

## The spatial graph

Almost every spatial statistic runs on `gr.spatial_neighbors`' graph
(`obsp['spatial_connectivities']`). Choose it deliberately:
- Visium: `coord_type="grid", n_neighs=6` (the hex lattice).
- Single-cell platforms: `coord_type="generic"` with Delaunay or k-NN
  (`n_neighs`≈6–15) or a radius; radius graphs respect physical distance best.
The graph defines "neighborhood" for everything below — state which you used.

## Interpreting the standard spatial analyses

- **Neighborhood enrichment** (`gr.nhood_enrichment`): permutation z-scores of
  label adjacency. Positive = the two labels touch more than chance (interface,
  co-habitation); negative = spatial avoidance/compartmentalization.
- **Co-occurrence** (`gr.co_occurrence`): the same idea as a function of distance —
  reads as "given a cell of type A, how enriched is type B within r?".
- **Spatial autocorrelation** (`gr.spatial_autocorr`, Moran's I / Geary's C): ranks
  *genes* by spatial patterning. High Moran's I = territorial expression (anatomy,
  gradients); near zero = salt-and-pepper. **sepal** ranks by diffusion time —
  strong for sharp domains.
- **Ripley statistics** (`gr.ripley`): clustered vs dispersed point patterns per
  label at multiple scales.
- **Centrality / interaction matrix** (`gr.centrality_scores`,
  `gr.interaction_matrix`): each label's connectivity role in the tissue graph.
- **Cellular neighborhoods / niches** (`custom.cellular_neighborhoods`): cluster
  each cell's local cell-type composition into recurring niches (à la Schürch
  CODEX neighborhoods) — the standard way to define microenvironments.
- **Ligand–receptor** (`gr.ligrec`, CellPhoneDB-style): candidate signaling between
  cluster pairs from co-expression; treat as hypothesis generation (expression ≠
  signaling), prioritize pairs consistent with the spatial contact structure.
- **Differential abundance** (`custom.milo_differential_abundance`): which
  neighborhoods shift in composition between conditions — needs replicates.
- **Pseudobulk DE** (`custom.pseudobulk_deseq`): condition contrasts summed to
  sample×cell-type pseudobulks (DESeq2). The statistically sound way to compare
  conditions — per-cell DE across samples overstates confidence (cells within a
  sample are not independent).

## Common pitfalls to guard against

1. **Double preprocessing** — re-running normalize/log1p on already-processed data.
   Check compute history / whether `X` looks like integers before preprocessing.
2. **Segmentation spillover read as biology** (above).
3. **Spot mixing read as co-expression** — on Visium, "co-expression" within a spot
   may be two adjacent cell types.
4. **Confounded conditions** — condition vs section/batch: if each condition is one
   section, spatial statistics differences may be section artifacts; say so.
5. **P-values on spatial permutations** are calibrated by the chosen graph; a
   different graph can move marginal results — check robustness before strong claims.
6. **Depth gradients** — total-count gradients across a section (edge drying,
   permeabilization) masquerade as spatial expression patterns; inspect
   `total_counts` on the tissue first.
