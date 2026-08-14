# Analysis playbooks — research question → workflow

How to turn a user's biological question into concrete studio steps. Prefer a
bundled recipe (`list_recipes` / `run_recipe`) when one fits — recipes encode the
correct step order; run individual functions when the user's case deviates.
`search_functions`/`describe_function` are always the ground truth for names and
parameters (libraries evolve; this guide names the stable ones).

## First: ask the user (before computing anything)

1. **What is the tissue and platform?** (Visium spot data vs Xenium/MERFISH
   single-cell panel vs proteomics — changes QC thresholds, deconvolution needs,
   and which recipes apply.)
2. **What is the biological question?** Map it to a playbook below (tissue
   organization? cell types present? condition differences? interactions?).
3. **Is the data raw or preprocessed?** Check `get_session` history + whether X
   looks like integer counts (`get_table` on obs/var, `get_obs_summary
   total_counts`). Never re-normalize processed data.
4. **Are there conditions/replicates?** (obs columns like condition/sample/TMA
   core) — determines whether Milo/pseudobulk DE are possible.
5. **What do they already believe/expect?** Anchors validation (expected cell
   types, marker genes, anatomy).

## Playbook 0 — orient yourself on any new session

`get_session` (fields, history, displays) → `view_display(viewport="fit")` →
`get_obs_summary` on the obvious categorical columns → if QC metrics exist, color
the canvas by `obs:total_counts` (`update_display`) and look for technical
gradients. Report what the dataset *is* before proposing analyses.

## Playbook 1 — QC and preprocessing (raw imported data)

Recipes: **"Preprocess & QC (Xenium)"**, **"QC, filter & cluster (raw counts)"**,
or **"Visium analysis & visualization (scanpy)"** for spot data.
Manual chain: `sc.pp.calculate_qc_metrics` → inspect (`get_obs_summary`,
color QC on tissue, `sc.pl` QC plots) → `sc.pp.filter_cells`/`filter_genes` with
thresholds justified by those distributions (platform-appropriate: don't apply
Visium-scale count cutoffs to a 300-gene panel) → `sc.pp.normalize_total` →
`sc.pp.log1p`. If pseudobulk DE is planned, note that it needs raw counts — do it
in a session/checkpoint that still has them.

## Playbook 2 — what cell types/states are here?

Recipes: **"Preprocess & cluster (raw counts)"** then **"Cluster (Leiden) & top
marker genes"**, optionally **"Assign cell-type labels (CellTypist)"**.
Manual: `sc.pp.highly_variable_genes` → `sc.pp.pca` → `sc.pp.neighbors` →
`custom.leiden` (key_added e.g. `leiden`) → `sc.tl.umap` → add an embedding display
→ `sc.tl.rank_genes_groups(groupby=leiden)` → `sc.pl.rank_genes_groups_dotplot`
(view it) → name clusters with the user; relabel via `custom.edit_annotations` or
annotate_region. Validate: color the *spatial* canvas by the clusters — do they
form anatomically plausible territories?

## Playbook 3 — how is the tissue organized? (domains, niches)

- Spatial graph first: `gr.spatial_neighbors` (grid/hex for Visium; Delaunay or
  kNN for single-cell).
- **Niches from composition**: recipe **"Neighborhood analysis (cellular
  neighborhoods)"** (`custom.cellular_neighborhoods` + its plot): recurring local
  cell-type mixtures = microenvironments.
- **Which labels border which**: recipes **"Neighborhood enrichment"**,
  **"Cluster co-occurrence"**, **"Region graph topology"**, **"Spatial point
  patterns (Ripley's L)"** — adjacency z-scores, distance profiles, centralities.
- **Expression-defined domains**: `custom.identify_regions_leiden` (cluster on
  spatially-smoothed expression) when domains should come from expression rather
  than annotated types; on TMA slides run `custom.identify_tmas` first to split
  cores.
- Present: heatmap plots + a spatial canvas colored by the niche/domain column;
  annotate agreed regions into a named region set.

## Playbook 4 — which genes are spatially patterned?

Recipes: **"Spatially variable genes (Moran's I)"** / **"(Geary's C)"** /
**"(sepal)"** (all need `gr.spatial_neighbors` first; the recipes include it).
Results land in `var`/`uns` — read the ranking via `get_table(path='var', …)` or the
recipe's plot, then *look at the top genes*: `update_display(color_by="X:<gene>")` +
`view_display`. Warn about depth-gradient artifacts (check `total_counts` pattern).

## Playbook 5 — do regions/conditions differ?

- **Define regions**: `annotate_region` from what you or the user see (or promote a
  computed domain column). Then recipes **"Cell types & neighborhoods by region"**
  (`custom.region_composition`) and **"Region gene-expression differences
  (Kruskal-Wallis)"** (`custom.region_feature_kruskal`).
- **Between conditions with replicates**: **"Pseudobulk differential expression
  (DESeq2)"** (`custom.pseudobulk_deseq`, needs raw counts + a sample column) for
  expression; `custom.milo_differential_abundance` for composition shifts;
  `custom.lisi_scores` for mixing (e.g. infiltration) quantification.
- **Interfaces**: `custom.region_boundary` + `custom.infiltration_profile` measure
  boundary sharpness and who crosses it (e.g. immune infiltration into tumor).
- No replicates → say plainly that condition-level claims are exploratory.

## Playbook 6 — are two cell types interacting/signaling?

Contact structure first (`gr.nhood_enrichment`, `gr.co_occurrence`,
`custom.proximity_test` for a focused pair) → then **"Ligand-receptor interactions"**
(`gr.ligrec`) restricted to the clusters of interest. Frame LR hits as hypotheses;
prioritize pairs whose partners are actually adjacent in space.

## Playbook 7 — trajectories / continua

Recipes **"PAGA trajectory (raw counts)"** (`sc.tl.paga` over Leiden) and
**"t-SNE & diffusion-map embeddings"**; `sc.tl.dpt` for pseudotime once a root is
chosen with the user. In tissue, check whether the trajectory has a spatial axis
(color pseudotime on the spatial canvas).

## Presenting results (always)

After each analysis: view the plot yourself (`view_plot`) and summarize what it
shows *biologically*, not just that it completed; restyle the user's canvas to show
the key finding (`update_display`); offer `export_figure` for anything worth
keeping; `save_checkpoint` after significant milestones. State parameters that
materially shaped results (graph type, resolution, thresholds) and cite the method
(`describe_function` carries citation + docs URL).
