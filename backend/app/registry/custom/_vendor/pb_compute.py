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
