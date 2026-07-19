"""
pb_compute.py
=============

COMPUTATION for pseudobulk differential expression via PyDESeq2. Plotting lives
in ``pb_plot.py``.

------------------------------------------------------------------------------
BIOLOGICAL CONTEXT
------------------------------------------------------------------------------
When comparing conditions (responder vs. non-responder, treated vs. control) in
scRNA/spatial data, testing per-cell across all cells of a type is statistically
wrong: cells from the same donor are not independent replicates, so treating
them as such inflates the sample size and produces anti-conservative p-values.
The field-standard fix (Squair et al., Nat Commun 2021; Crowell et al., muscat,
2020) is **pseudobulk**: sum raw counts across all cells of a given type within
each biological sample, producing one bulk-like profile per (sample x cell
type), then run a bulk RNA-seq DE method with **samples as the replicates**.

WHY THIS FILE EXISTS: PyDESeq2 (Muzellec et al.) provides the DE engine but
expects a prepared bulk count matrix + metadata; it does not do the
single-cell -> pseudobulk aggregation, the per-cell-type loop, or QC/plots.
This is NOT the same analysis as ``scanpy.tl.rank_genes_groups``, which does
per-cell marker detection treating cells as replicates -- anti-conservative for
a between-condition comparison. This module is the replicate-aware
alternative; Milo (``milo_da_compute.py`` in this collection) is the
companion for differential *abundance* rather than differential *expression*.

------------------------------------------------------------------------------
COMPUTATIONAL APPROACH
------------------------------------------------------------------------------
  1. aggregate_pseudobulk  -- sum raw counts per (sample x cell type) group via
                              an indicator-matrix product; carry sample-level
                              metadata (condition, batch, cell type, n_cells).
  2. filter_genes          -- drop low-count genes before fitting.
  3. run_deseq2            -- PyDESeq2 fit + Wald test + optional apeGLM LFC
                              shrinkage, per cell type.
  4. pseudobulk_de         -- orchestrator: aggregate once, loop over cell
                              types, skip ones without >=2 samples per contrast
                              level.
  5. pseudobulk_de_adata   -- thin AnnData wrapper (writes .uns).

NOTE: sum, not mean, of raw counts -- DESeq2's size-factor normalization
expects library-size-like totals; means break the negative-binomial count
model. Raw integer counts only: pseudobulk DE on normalized/log data is
statistically invalid, so `aggregate_pseudobulk` refuses non-integer/negative
input (see `looks_like_raw_counts`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Sequence, Union

import numpy as np
import pandas as pd
from scipy import sparse

ArrayLike = Union[np.ndarray, Sequence]


@dataclass
class PseudobulkData:
    """Aggregated pseudobulk counts + sample-level metadata for one grouping."""

    counts: pd.DataFrame        # (pb_samples x genes) summed raw integer counts
    metadata: pd.DataFrame      # (pb_samples x vars): sample, condition, [batch], [cell_type], n_cells
    group_key: Optional[str]    # original cell-type obs column that split the data (None if global)
    genes: list                 # gene order (columns of counts)


@dataclass
class DEResult:
    """One cell type's PyDESeq2 fit, for handoff to pb_plot."""

    cell_type: str
    results: pd.DataFrame            # PyDESeq2 results_df: baseMean, log2FoldChange, lfcSE, stat, pvalue, padj
    contrast: list                   # ["condition", "tested", "ref"]
    shrunk: bool                     # whether apeGLM LFC shrinkage was applied
    n_samples: dict                  # {condition_level: n_pseudobulk_samples}
    counts: Optional[pd.DataFrame] = None    # pseudobulk counts fit on (post gene-filter), for PCA/QC
    metadata: Optional[pd.DataFrame] = None  # sample metadata aligned to `counts`
    dds: object = field(default=None, repr=False)  # live DeseqDataSet (dispersions, size factors); not persisted
    params: dict = field(default_factory=dict)


@dataclass
class PseudobulkDEResult:
    """Every cell type's DE fit, plus the shared pseudobulk aggregation."""

    per_celltype: dict          # {cell_type: DEResult}
    pseudobulk: PseudobulkData
    contrast: list
    params: dict = field(default_factory=dict)

    def table(self) -> pd.DataFrame:
        """Concatenate all cell types' results into one long table."""
        frames = []
        for cell_type, de in self.per_celltype.items():
            df = de.results.copy()
            df.insert(0, "gene", df.index)
            df.insert(0, "cell_type", cell_type)
            frames.append(df)
        return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def looks_like_raw_counts(X, n_sample: int = 100_000) -> bool:
    """Sampled check that `X` plausibly holds raw non-negative integer counts.

    BIOLOGICAL CONTEXT
        DESeq2 models counts as negative-binomial; normalized or log-transformed
        input (negative values, non-integers) silently produces garbage.
    COMPUTATIONAL APPROACH
        Sample up to `n_sample` values (from `.data` for sparse matrices, so we
        never densify a huge matrix) and check non-negativity and closeness to
        the nearest integer.
    """
    if sparse.issparse(X):
        vals = X.data[:n_sample] if X.nnz else np.array([])
    else:
        vals = np.asarray(X).ravel()
        vals = vals[:n_sample] if vals.size > n_sample else vals
    if vals.size == 0:
        return True
    return bool(np.all(vals >= -1e-6) and np.allclose(vals, np.round(vals), atol=1e-3))


# --------------------------------------------------------------------------- #
# Step 1 -- aggregate cells into pseudobulk profiles
# --------------------------------------------------------------------------- #
def aggregate_pseudobulk(
    counts,                       # (n_cells x genes) raw counts: np/sparse array or DataFrame
    obs: pd.DataFrame,            # (n_cells,) rows aligned to `counts`; holds sample/condition/[celltype]/[batch]
    *,
    sample_key: str,
    condition_key: str,
    celltype_key: Optional[str] = None,
    batch_key: Optional[str] = None,
    min_cells: int = 10,
    agg: str = "sum",
    genes: Optional[list] = None,
) -> PseudobulkData:
    """Sum single-cell counts into one profile per (sample [x cell type]).

    BIOLOGICAL CONTEXT
        Each output row is a pseudo-replicate: all counts from one biological
        sample (optionally restricted to one cell type) added together, so the
        downstream DE test treats samples -- not cells -- as the unit of
        replication.
    COMPUTATIONAL APPROACH
        Build a (n_groups x n_cells) 0/1 indicator matrix `G` from the group
        labels and compute `G @ counts` (sparse-safe). `condition`/`batch`/
        `cell_type` are constant within a sample and are carried into
        `metadata` by taking each group's first cell. Groups with fewer than
        `min_cells` cells are dropped. Output metadata columns are canonical
        ("sample", "condition", "batch", "cell_type", "n_cells") regardless of
        the input obs column names, so downstream code (`filter_genes`,
        `run_deseq2`) doesn't need to know the caller's naming.

    Parameters
    ----------
    genes
        Gene names for the columns of `counts`, when `counts` isn't a
        DataFrame (e.g. an AnnData.X array). Falls back to `counts.columns` or
        generic names.
    agg
        "sum" (DESeq2-correct) or "mean" (diagnostics only -- breaks the count
        model DESeq2 assumes).
    """
    if genes is not None:
        gene_names = list(genes)
    elif hasattr(counts, "columns"):
        gene_names = list(counts.columns)
    else:
        gene_names = [f"gene{i}" for i in range(counts.shape[1])]

    counts_mat = counts.values if hasattr(counts, "values") else counts  # counts_mat = raw matrix, dense or sparse
    if not looks_like_raw_counts(counts_mat):
        raise ValueError(
            "aggregate_pseudobulk expects raw non-negative integer counts; the "
            "input looks normalized or log-transformed (negative or non-integer "
            "values). Pseudobulk DESeq2 is only valid on raw counts."
        )

    obs = obs.reset_index(drop=True)                     # obs = per-cell metadata, aligned to counts_mat rows
    n_cells = obs.shape[0]
    group_cols = [sample_key] + ([celltype_key] if celltype_key else [])
    group_id = (obs[group_cols].astype(str).agg("__".join, axis=1).values if celltype_key
                else obs[sample_key].astype(str).values)  # group_id = one pseudobulk-sample label per cell
    cats, codes = np.unique(group_id, return_inverse=True)  # cats = pseudobulk-sample ids; codes = per-cell group index
    n_groups = cats.shape[0]

    indicator = sparse.csr_matrix(                        # indicator = (n_groups x n_cells) 0/1 membership
        (np.ones(n_cells, dtype=np.float64), (codes, np.arange(n_cells))), shape=(n_groups, n_cells)
    )
    if sparse.issparse(counts_mat):
        summed = np.asarray((indicator @ counts_mat).todense())  # summed = (n_groups x genes) summed counts
    else:
        summed = indicator @ np.asarray(counts_mat, dtype=np.float64)
    n_cells_per_group = np.asarray(indicator.sum(axis=1)).ravel()  # n_cells_per_group = cells contributing to each row
    if agg == "mean":
        summed = summed / n_cells_per_group[:, None]
    elif agg != "sum":
        raise ValueError(f"agg must be 'sum' or 'mean', got {agg!r}")

    first_idx = np.zeros(n_groups, dtype=int)             # first_idx = index of one representative cell per group
    seen = np.full(n_groups, -1)
    for i, c in enumerate(codes):
        if seen[c] == -1:
            seen[c] = i
    first_idx = seen

    meta = {
        "sample": obs[sample_key].values[first_idx],
        "condition": obs[condition_key].values[first_idx],
    }
    if celltype_key:
        meta["cell_type"] = obs[celltype_key].values[first_idx]
    if batch_key:
        meta["batch"] = obs[batch_key].values[first_idx]
    meta["n_cells"] = n_cells_per_group.astype(int)
    metadata = pd.DataFrame(meta, index=cats)

    keep = n_cells_per_group >= min_cells                 # keep = groups meeting the min_cells floor
    counts_df = pd.DataFrame(summed[keep], index=cats[keep], columns=gene_names)
    return PseudobulkData(counts=counts_df, metadata=metadata.loc[keep], group_key=celltype_key, genes=gene_names)


# --------------------------------------------------------------------------- #
# Step 2 -- low-count gene filter
# --------------------------------------------------------------------------- #
def filter_genes(pb: PseudobulkData, *, min_count: int = 10, min_samples: Optional[int] = None) -> PseudobulkData:
    """Drop genes too lowly expressed for a reliable dispersion fit.

    BIOLOGICAL CONTEXT
        All-zero or near-zero genes carry no information and break DESeq2's
        dispersion fit; dropping them also reduces the multiple-testing burden
        on the genes that matter.
    COMPUTATIONAL APPROACH
        Keep a gene if its total pseudobulk count is >= `min_count`, OR it is
        detected (count > 0) in at least `min_samples` pseudobulk samples --
        either criterion is enough to keep a gene, so lowly-but-broadly
        expressed genes survive alongside highly-but-narrowly expressed ones.
        `min_samples` defaults to the size of the smaller condition group.
    """
    counts = pb.counts
    if min_samples is None:
        cond_sizes = pb.metadata["condition"].value_counts()
        min_samples = int(cond_sizes.min()) if len(cond_sizes) else 1
    total_count = counts.sum(axis=0)                      # total_count = summed count per gene, across samples
    n_detected = (counts > 0).sum(axis=0)                 # n_detected = number of samples with count > 0
    keep = (total_count >= min_count) | (n_detected >= min_samples)
    kept_counts = counts.loc[:, keep]
    return PseudobulkData(counts=kept_counts, metadata=pb.metadata, group_key=pb.group_key,
                           genes=kept_counts.columns.tolist())


# --------------------------------------------------------------------------- #
# Step 3 -- PyDESeq2 fit (accurate to 0.5.4)
# --------------------------------------------------------------------------- #
def _lfc_coeff_name(dds, contrast: Sequence[str]) -> str:
    """Map a `["variable", "tested", "ref"]` contrast to its formulaic LFC column."""
    variable, tested, _ref = contrast
    target = f"{variable}[T.{tested}]"
    columns = list(dds.varm["LFC"].columns)
    if target in columns:
        return target
    candidates = [c for c in columns if c.startswith(f"{variable}[T.")]
    if len(candidates) == 1:
        return candidates[0]
    raise ValueError(f"could not find an LFC coefficient for contrast {list(contrast)} among {columns}")


def run_deseq2(
    pb: PseudobulkData,
    *,
    condition_key: str = "condition",
    contrast: Sequence[str],
    batch_key: Optional[str] = None,
    shrink: bool = True,
    alpha: float = 0.05,
    cooks_filter: bool = True,
    independent_filter: bool = True,
    n_cpus: int = 4,
    quiet: bool = True,
    cell_type: Optional[str] = None,
) -> DEResult:
    """Fit PyDESeq2 on one pseudobulk group and Wald-test the given contrast.

    BIOLOGICAL CONTEXT
        `contrast = [condition_key, tested_level, ref_level]`: a positive
        `log2FoldChange` means the gene is higher in `tested_level`. Shrinkage
        (apeGLM) stabilizes fold-change estimates for genes with low counts or
        high dispersion -- it changes the reported effect sizes used for
        ranking/plotting but leaves the hypothesis-test p-values untouched.
    COMPUTATIONAL APPROACH
        `design` is a formulaic string with the tested variable last (a batch
        covariate belongs in the design, not a post-hoc correction). Explicit
        `contrast` is required by PyDESeq2 0.5.4 (no default contrast). The LFC
        shrinkage coefficient name is discovered from `dds.varm["LFC"].columns`
        rather than hardcoded, since formulaic's naming depends on the level
        strings.

    Raises
    ------
    ImportError
        If `pydeseq2` is not installed.
    """
    try:
        from pydeseq2.dds import DeseqDataSet
        from pydeseq2.ds import DeseqStats
        from pydeseq2.default_inference import DefaultInference
    except ImportError as e:
        raise ImportError(
            "pseudobulk differential expression requires the 'pydeseq2' package "
            "(pip install pydeseq2)"
        ) from e

    design = f"~{batch_key} + {condition_key}" if batch_key else f"~{condition_key}"
    inference = DefaultInference(n_cpus=n_cpus)
    counts_int = pb.counts.round().astype(int)            # counts_int = whole-number counts (DESeq2 requirement)
    dds = DeseqDataSet(counts=counts_int, metadata=pb.metadata, design=design,
                        refit_cooks=True, inference=inference, quiet=quiet)
    dds.deseq2()                                           # size factors, dispersions, LFCs
    stats = DeseqStats(dds, contrast=list(contrast), alpha=alpha, cooks_filter=cooks_filter,
                        independent_filter=independent_filter, inference=inference, quiet=quiet)
    stats.summary()                                        # -> stats.results_df
    if shrink:
        coeff = _lfc_coeff_name(dds, contrast)              # coeff = formulaic LFC column matching the contrast
        stats.lfc_shrink(coeff=coeff)                       # apeGLM; leaves p-values unchanged

    n_samples = pb.metadata["condition"].value_counts().to_dict()
    return DEResult(
        cell_type=cell_type if cell_type is not None else "all",
        results=stats.results_df, contrast=list(contrast), shrunk=shrink, n_samples=n_samples,
        counts=pb.counts, metadata=pb.metadata, dds=dds,
        params={"design": design, "alpha": alpha, "cooks_filter": cooks_filter,
                "independent_filter": independent_filter, "n_cpus": n_cpus},
    )


# --------------------------------------------------------------------------- #
# Step 4 -- orchestrator: loop over cell types
# --------------------------------------------------------------------------- #
def _as_counts_obs(adata_or_counts, obs):
    if obs is not None:
        return adata_or_counts, obs, None
    return adata_or_counts.X, adata_or_counts.obs, list(adata_or_counts.var_names)


def pseudobulk_de(
    adata_or_counts,
    obs: Optional[pd.DataFrame] = None,
    *,
    sample_key: str,
    condition_key: str,
    celltype_key: Optional[str],
    contrast: Sequence[str],
    batch_key: Optional[str] = None,
    min_cells: int = 10,
    min_count: int = 10,
    shrink: bool = True,
    alpha: float = 0.05,
    cooks_filter: bool = True,
    independent_filter: bool = True,
    n_cpus: int = 4,
    quiet: bool = True,
    genes: Optional[list] = None,
) -> PseudobulkDEResult:
    """Aggregate once, then run PyDESeq2 per cell type.

    BIOLOGICAL CONTEXT
        Each cell type gets its own dispersion fit -- pooling cell types into
        one model would force a shared dispersion across biologically distinct
        count distributions. A cell type is skipped (not silently zero-filled)
        when either contrast level has fewer than 2 pseudobulk samples, since
        pseudobulk DE without replicates is not statistically valid.
    COMPUTATIONAL APPROACH
        `aggregate_pseudobulk` once with `celltype_key`; for each cell type,
        slice its pseudobulk rows, `filter_genes`, `run_deseq2`.

    Parameters
    ----------
    adata_or_counts
        Either raw counts (array/DataFrame, requires `obs`) or an AnnData-like
        object exposing `.X`/`.obs`/`.var_names` (pass `obs=None`).
    """
    counts, resolved_obs, resolved_genes = _as_counts_obs(adata_or_counts, obs)
    obs = resolved_obs if obs is None else obs
    genes = genes if genes is not None else resolved_genes

    pb = aggregate_pseudobulk(counts, obs, sample_key=sample_key, condition_key=condition_key,
                               celltype_key=celltype_key, batch_key=batch_key, min_cells=min_cells,
                               genes=genes)

    cell_types = sorted(pb.metadata["cell_type"].unique()) if celltype_key else [None]
    tested, ref = contrast[1], contrast[2]
    per_celltype = {}
    for ct in cell_types:
        sub_meta = pb.metadata if ct is None else pb.metadata[pb.metadata["cell_type"] == ct]
        level_counts = sub_meta["condition"].value_counts()
        if level_counts.get(tested, 0) < 2 or level_counts.get(ref, 0) < 2:
            print(f"pseudobulk_de: skipping cell type {ct!r} "
                  f"({level_counts.get(tested, 0)} {tested} / {level_counts.get(ref, 0)} {ref} "
                  "pseudobulk samples; need >=2 of each)")
            continue
        sub_pb = PseudobulkData(counts=pb.counts.loc[sub_meta.index], metadata=sub_meta,
                                 group_key=pb.group_key, genes=pb.genes)
        sub_pb = filter_genes(sub_pb, min_count=min_count)
        label = ct if ct is not None else "all"
        de = run_deseq2(sub_pb, condition_key="condition", contrast=contrast,
                         batch_key=("batch" if batch_key else None), shrink=shrink, alpha=alpha,
                         cooks_filter=cooks_filter, independent_filter=independent_filter,
                         n_cpus=n_cpus, quiet=quiet, cell_type=label)
        per_celltype[label] = de

    return PseudobulkDEResult(
        per_celltype=per_celltype, pseudobulk=pb, contrast=list(contrast),
        params={"sample_key": sample_key, "condition_key": condition_key, "celltype_key": celltype_key,
                "batch_key": batch_key, "min_cells": min_cells, "min_count": min_count,
                "shrink": shrink, "alpha": alpha, "n_cpus": n_cpus},
    )


# --------------------------------------------------------------------------- #
# Step 5 -- AnnData wrapper
# --------------------------------------------------------------------------- #
def pseudobulk_de_adata(
    adata,
    *,
    sample_key: str,
    condition_key: str,
    celltype_key: Optional[str],
    contrast: Sequence[str],
    layer: Optional[str] = None,
    batch_key: Optional[str] = None,
    min_cells: int = 10,
    min_count: int = 10,
    shrink: bool = True,
    alpha: float = 0.05,
    cooks_filter: bool = True,
    independent_filter: bool = True,
    n_cpus: int = 4,
    quiet: bool = True,
    key_added: str = "pseudobulk_de",
) -> PseudobulkDEResult:
    """Run `pseudobulk_de` on an AnnData; store per-cell-type results in `.uns`.

    COMPUTATIONAL APPROACH
        Pull raw counts from `adata.X` (or `adata.layers[layer]`) and `adata.obs`;
        write `adata.uns[key_added] = {"per_celltype": {ct: results_df}, "params",
        "contrast"}`. `results_df` is a live DataFrame here -- callers that need
        a zarr/JSON-safe `.uns` must serialize it further (see
        `pseudobulk_deseq2.py`, which does this for the app's checkpoint).
    """
    counts = adata.layers[layer] if layer else adata.X
    result = pseudobulk_de(counts, adata.obs, sample_key=sample_key, condition_key=condition_key,
                            celltype_key=celltype_key, contrast=contrast, batch_key=batch_key,
                            min_cells=min_cells, min_count=min_count, shrink=shrink, alpha=alpha,
                            cooks_filter=cooks_filter, independent_filter=independent_filter,
                            n_cpus=n_cpus, quiet=quiet, genes=list(adata.var_names))
    adata.uns[key_added] = {
        "per_celltype": {ct: de.results for ct, de in result.per_celltype.items()},
        "params": result.params,
        "contrast": result.contrast,
    }
    return result


# --------------------------------------------------------------------------- #
# Synthetic data + demo
# --------------------------------------------------------------------------- #
def make_synthetic_pseudobulk(
    n_genes: int = 2000,
    n_de: int = 200,
    n_samples_per_cond: int = 4,
    cells_per_sample: int = 300,
    lfc: float = 1.5,
    dispersion: float = 0.3,
    seed: int = 0,
):
    """Planted-DE per-cell counts for two conditions, one cell type.

    BIOLOGICAL CONTEXT
        `n_de` genes carry a real log2 fold-change `lfc` between "control" and
        "treated"; a disjoint subset of genes carries a fixed batch effect so
        the `~batch + condition` design is exercised. Counts are drawn at
        single-cell resolution (not pre-aggregated), so summing them within a
        sample is the ground-truth pseudobulk profile.
    COMPUTATIONAL APPROACH
        Per gene, a lognormal baseline per-cell mean; per sample, a lognormal
        size factor models replicate-to-replicate depth variation. Each cell's
        count is drawn negative-binomial with that mean and a fixed
        `dispersion`. Sums of iid NB(r, p) draws are themselves NB(n*r, p), so
        this both is realistic and keeps `aggregate_pseudobulk` exactly
        checkable against a direct groupby-sum.

    Returns
    -------
    counts    (n_cells, n_genes) DataFrame of raw per-cell counts.
    obs       (n_cells,) DataFrame with sample_id/condition/batch columns.
    is_de     (n_genes,) bool array, True for planted-DE genes.
    true_lfc  (n_genes,) float array, planted log2 fold-change (0 for non-DE).
    """
    rng = np.random.default_rng(seed)
    baseline = rng.lognormal(mean=1.0, sigma=1.2, size=n_genes)  # baseline = per-cell mean count, one per gene

    de_idx = rng.choice(n_genes, size=n_de, replace=False)       # de_idx = genes carrying the planted fold-change
    sign = rng.choice([-1.0, 1.0], size=n_de)
    true_lfc = np.zeros(n_genes)
    true_lfc[de_idx] = sign * lfc

    n_batch_genes = max(1, n_genes // 10)                         # n_batch_genes = genes carrying a batch effect
    batch_idx = rng.choice(np.setdiff1d(np.arange(n_genes), de_idx), size=n_batch_genes, replace=False)
    batch_lfc = np.zeros(n_genes)
    batch_lfc[batch_idx] = 1.0

    n_samples = 2 * n_samples_per_cond
    counts_chunks, sample_ids, conditions, batches = [], [], [], []
    for s in range(n_samples):
        condition = "control" if s < n_samples_per_cond else "treated"
        batch = "b0" if s % 2 == 0 else "b1"
        size_factor = rng.lognormal(0.0, 0.15)                    # size_factor = per-sample depth multiplier
        mean = baseline.copy()
        if condition == "treated":
            mean = mean * (2.0 ** true_lfc)
        if batch == "b1":
            mean = mean * (2.0 ** batch_lfc)
        mean = mean * size_factor                                 # mean = per-cell NB mean for this sample
        r = 1.0 / dispersion                                       # r = NB "number of successes" (fixed dispersion)
        p = r / (r + mean)                                         # p = per-gene NB success probability
        cells = rng.negative_binomial(r, p, size=(cells_per_sample, n_genes))
        counts_chunks.append(cells)
        sample_id = f"sample{s}"
        sample_ids.extend([sample_id] * cells_per_sample)
        conditions.extend([condition] * cells_per_sample)
        batches.extend([batch] * cells_per_sample)

    counts = pd.DataFrame(np.vstack(counts_chunks), columns=[f"gene{i}" for i in range(n_genes)])
    obs = pd.DataFrame({"sample_id": sample_ids, "condition": conditions, "batch": batches})
    is_de = np.zeros(n_genes, dtype=bool)
    is_de[de_idx] = True
    return counts, obs, is_de, true_lfc


def _demo():
    """Run the full pipeline on synthetic data and check the §8 acceptance criteria."""
    counts, obs, is_de, true_lfc = make_synthetic_pseudobulk()
    gene_to_idx = {g: i for i, g in enumerate(counts.columns)}

    pb = aggregate_pseudobulk(counts.values, obs, sample_key="sample_id", condition_key="condition",
                               batch_key="batch", genes=list(counts.columns))

    # criterion 3: aggregation correctness (exact match vs. direct groupby sum)
    direct = counts.groupby(obs["sample_id"].values).sum().loc[pb.counts.index]
    assert np.allclose(pb.counts.values, direct.values), "aggregation mismatch vs. direct groupby sum"
    direct_n = obs.groupby("sample_id").size().loc[pb.counts.index]
    assert (pb.metadata["n_cells"].values == direct_n.values).all(), "n_cells mismatch"
    print("[3] aggregate_pseudobulk matches direct groupby sum, n_cells matches -- PASS")

    # criterion 5: min_cells / filter_genes drop the intended groups/genes
    dropped = aggregate_pseudobulk(counts.values, obs, sample_key="sample_id", condition_key="condition",
                                    batch_key="batch", genes=list(counts.columns),
                                    min_cells=counts.shape[0] + 1)
    assert dropped.counts.shape[0] == 0, "min_cells should have dropped every pseudobulk group"
    over_filtered = filter_genes(pb, min_count=10**9, min_samples=10**9)
    assert 0 < over_filtered.counts.shape[1] < pb.counts.shape[1] or over_filtered.counts.shape[1] == 0
    print("[5] min_cells and filter_genes drop the intended groups/genes -- PASS")

    pb_filtered = filter_genes(pb, min_count=10)
    contrast = ["condition", "treated", "control"]
    de = run_deseq2(pb_filtered, condition_key="condition", contrast=contrast, batch_key="batch",
                     shrink=True, alpha=0.05, n_cpus=1)

    kept_idx = np.array([gene_to_idx[g] for g in pb_filtered.genes])
    kept_is_de = is_de[kept_idx]
    kept_true_lfc = true_lfc[kept_idx]
    results = de.results.loc[pb_filtered.genes]

    # criterion 1: recovers planted DE + effect-size correlation
    sig = results["padj"].values < 0.05
    correct_sign = np.sign(results["log2FoldChange"].values) == np.sign(kept_true_lfc)
    recall = np.mean(sig[kept_is_de] & correct_sign[kept_is_de])
    corr = np.corrcoef(results["log2FoldChange"].values[kept_is_de], kept_true_lfc[kept_is_de])[0, 1]
    print(f"[1] recall={recall:.2f} (expect >=0.80), LFC correlation={corr:.2f} (expect >0.80)")
    assert recall >= 0.8, "failed to recover >=80% of planted DE genes"
    assert corr > 0.8, "estimated vs. true LFC correlation too low"

    # criterion 2: FDR control among non-DE genes
    non_de = ~kept_is_de
    fpr = np.mean(results["pvalue"].values[non_de] < 0.05)
    print(f"[2] empirical false-positive rate among non-DE genes = {fpr:.3f} (nominal 0.05)")
    assert fpr <= 0.10, "false-positive rate not controlled near nominal alpha"

    # criterion 4: PCA separates conditions
    from sklearn.cluster import KMeans
    from sklearn.decomposition import PCA
    from sklearn.metrics import adjusted_rand_score

    de.dds.vst()
    vst = de.dds.layers["vst_counts"]
    pcs = PCA(n_components=2, random_state=0).fit_transform(vst - vst.mean(axis=0))
    km = KMeans(n_clusters=2, n_init=10, random_state=0).fit_predict(pcs)
    ari = adjusted_rand_score(de.dds.obs["condition"].values, km)
    print(f"[4] PCA/condition adjusted Rand index = {ari:.2f} (expect >0.5)")
    assert ari > 0.5, "pseudobulk PCA does not separate conditions"

    print("all §8 acceptance criteria PASSED")


if __name__ == "__main__":
    _demo()
