"""Annotate Cells (CellTypist) — predict a cell-type label per cell with a
pre-trained CellTypist model and write it to a new categorical obs column."""
from __future__ import annotations

from ..base import CallResult, Function, ParamSpec, missing_obs_column, run_compute

# A curated subset of CellTypist's pre-trained models; the full catalogue lives
# at https://www.celltypist.org/models. Any model name valid there also works
# even if it is not listed here (it is downloaded on first use).
_MODELS = [
    "Immune_All_Low.pkl",
    "Immune_All_High.pkl",
    "Cells_Intestinal_Tract.pkl",
    "Adult_Mouse_Gut.pkl",
    "Healthy_Adult_Heart.pkl",
    "Human_Lung_Atlas.pkl",
    "Developing_Human_Brain.pkl",
    "Cells_Fetal_Lung.pkl",
]
_DEFAULT_MODEL = _MODELS[0]

_DOC = """Annotate Cells (CellTypist)

Predict a cell-type label for every cell with a pre-trained CellTypist model
(logistic-regression classifier) and store it as a categorical obs column,
alongside a per-cell confidence column named `<key_added>_conf`.

CellTypist requires the expression matrix to be **log1p-normalised to 10,000
counts per cell** and to use **gene symbols** as var names. Leave `normalize`
on (the default) to have that transform applied to an internal copy — your
session's `.X` is never modified. Turn it off only if your `.X` (or the chosen
`layer`) is already normalised that way.

The first use of a given model downloads it (needs network); later runs are
offline. See https://www.celltypist.org/models for the full model list.

Parameters
----------
model
    Pre-trained model to predict with (default: Immune_All_Low.pkl).
layer
    Layer holding raw counts to annotate on; blank uses `.X`.
normalize
    Normalise the input to log1p / 10,000 counts on a copy before predicting.
majority_voting
    Refine per-cell predictions by majority vote within local subclusters
    (recommended; runs CellTypist's over-clustering internally).
over_clustering
    Categorical obs column to use as the subclusters for majority voting;
    blank uses CellTypist's heuristic clustering.
key_added
    Name of the obs column to write the predicted cell-type labels into.
"""


class CellTypistAnnotate(Function):
    source = "custom"
    key = "custom.celltypist_annotate"
    namespace = "custom"
    function = "celltypist_annotate"
    effect_class = "compute"
    label = "Annotate Cells (CellTypist)"
    summary = "Predict a cell-type label per cell with a pre-trained CellTypist model."
    doc = _DOC
    partially_supported = False
    unsupported_params: list = []

    params = [
        ParamSpec("model", {"type": "string", "enum": _MODELS, "default": _DEFAULT_MODEL},
                  "select", None, required=False, tooltip="pre-trained CellTypist model"),
        ParamSpec("layer", {"type": "string"}, "layer_key", "layers",
                  required=False, tooltip="counts layer to annotate on (blank = .X)"),
        ParamSpec("normalize", {"type": "boolean", "default": True}, "checkbox", None,
                  required=False, tooltip="normalise to log1p / 1e4 counts on a copy first"),
        ParamSpec("majority_voting", {"type": "boolean", "default": True}, "checkbox", None,
                  required=False, tooltip="refine labels by majority vote within subclusters"),
        ParamSpec("over_clustering", {"type": "string"}, "obs_categorical", "obs_categorical",
                  required=False, tooltip="subcluster column for voting (blank = heuristic)"),
        ParamSpec("key_added", {"type": "string", "default": "cell_type"}, "text", None,
                  required=True, tooltip="obs column to write cell-type labels into", role="output"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        model = (params.get("model") or _DEFAULT_MODEL).strip()
        layer = (params.get("layer") or "").strip()
        over_clustering = (params.get("over_clustering") or "").strip()
        key_added = (params.get("key_added") or "cell_type").strip()
        normalize = bool(params.get("normalize", True))
        majority_voting = bool(params.get("majority_voting", True))

        adata = session.active_table()
        if layer and layer not in adata.layers:
            return CallResult(status="failed", error=f"layer '{layer}' does not exist")
        if over_clustering:
            error = missing_obs_column(adata, over_clustering)
            if error:
                return CallResult(status="failed", error=error)

        def mutate(ad):
            import anndata
            import celltypist
            import pandas as pd
            import scanpy as sc
            from celltypist import models

            if model not in models.get_all_models():
                models.download_models(model=model)

            counts = ad.layers[layer] if layer else ad.X
            src = anndata.AnnData(X=counts.copy(), obs=ad.obs.copy(), var=ad.var.copy())
            if normalize:
                sc.pp.normalize_total(src, target_sum=1e4)
                sc.pp.log1p(src)

            result = celltypist.annotate(
                src, model=model, majority_voting=majority_voting,
                over_clustering=over_clustering or None)

            labels = result.predicted_labels
            label_col = ("majority_voting"
                         if majority_voting and "majority_voting" in labels.columns
                         else "predicted_labels")
            ad.obs[key_added] = pd.Categorical(labels[label_col].to_numpy())
            ad.obs[f"{key_added}_conf"] = result.probability_matrix.max(axis=1).to_numpy()

        return run_compute(session, mutate)
