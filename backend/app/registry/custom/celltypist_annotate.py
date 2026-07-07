"""Annotate Cells (CellTypist) — predict a cell-type label per cell with a
pre-trained CellTypist model and write it to a new categorical obs column."""
from __future__ import annotations

from functools import lru_cache

from ..base import CallResult, Function, ParamSpec, missing_obs_column, run_compute
from ._leiden import leiden_labels

# The two general immune models lead the dropdown; the rest of CellTypist's
# catalogue follows alphabetically (see _available_models).
_PREFERRED_MODELS = ["Immune_All_Low.pkl", "Immune_All_High.pkl"]
_DEFAULT_MODEL = _PREFERRED_MODELS[0]

# Offline fallback when CellTypist's model index can't be fetched — a curated
# subset of the full catalogue at https://www.celltypist.org/models.
_FALLBACK_MODELS = [
    "Immune_All_Low.pkl",
    "Immune_All_High.pkl",
    "Cells_Intestinal_Tract.pkl",
    "Adult_Mouse_Gut.pkl",
    "Healthy_Adult_Heart.pkl",
    "Human_Lung_Atlas.pkl",
    "Developing_Human_Brain.pkl",
    "Cells_Fetal_Lung.pkl",
]


@lru_cache(maxsize=1)
def _available_models() -> list[str]:
    """The full CellTypist model catalogue for the dropdown. Reads CellTypist's
    model index (cached to disk after first fetch; a 30s-bounded download
    populates it if absent), falling back to a curated subset when offline."""
    try:
        from celltypist import models
        names = [m["filename"] for m in models.get_models_index()["models"]]
    except Exception:
        names = list(_FALLBACK_MODELS)
    preferred = [m for m in _PREFERRED_MODELS if m in names]
    return preferred + sorted(m for m in names if m not in preferred)


def _over_cluster(src):
    """Graspologic (MIT) replacement for CellTypist's internal over-clustering,
    which otherwise runs GPL sc.tl.leiden. Mirrors CellTypist's canonical Scanpy
    pipeline (PCA -> neighbours -> Leiden) and its cell-count-scaled resolution,
    returning one fine-grained subcluster label per cell for majority voting."""
    import scanpy as sc

    clust = src.copy()
    sc.pp.pca(clust)
    sc.pp.neighbors(clust)
    n = clust.n_obs
    resolution = (5 if n < 5000 else 10 if n < 20000 else 15 if n < 40000
                  else 20 if n < 100000 else 25 if n < 200000 else 30)
    return leiden_labels(clust.obsp["connectivities"], resolution=resolution,
                         random_state=0, n_iterations=2)

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
    (recommended; over-clusters the cells with Leiden internally).
over_clustering
    Categorical obs column to use as the subclusters for majority voting;
    blank over-clusters the cells with Leiden (graspologic) automatically.
key_added
    Name of the obs column to write the predicted cell-type labels into.
"""


from ._docs import custom_doc

_CITATION = ("Dominguez Conde, C. et al. Cross-tissue immune cell analysis reveals tissue-specific "
             "features in humans. Science 376, eabl5197 (2022). doi:10.1126/science.abl5197 (CellTypist).")
_DOC = custom_doc("annotate-cells-with-celltypist")


class CellTypistAnnotate(Function):
    source = "custom"
    key = "custom.celltypist_annotate"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "celltypist_annotate"
    effect_class = "compute"
    label = "Annotate Cells (CellTypist)"
    summary = "Predict a cell-type label per cell with a pre-trained CellTypist model."
    doc = _DOC
    partially_supported = False
    unsupported_params: list = []

    params = [
        ParamSpec("model", {"type": "string", "default": _DEFAULT_MODEL},
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

    def json_schema(self) -> dict:
        schema = super().json_schema()
        schema["properties"]["model"]["enum"] = _available_models()
        return schema

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

            # Supply our own over-clustering so CellTypist never falls back to
            # its GPL sc.tl.leiden; a user-named column still takes precedence.
            oc = over_clustering or None
            if majority_voting and oc is None:
                oc = _over_cluster(src)
            result = celltypist.annotate(
                src, model=model, majority_voting=majority_voting, over_clustering=oc)

            labels = result.predicted_labels
            label_col = ("majority_voting"
                         if majority_voting and "majority_voting" in labels.columns
                         else "predicted_labels")
            ad.obs[key_added] = pd.Categorical(labels[label_col].to_numpy())
            ad.obs[f"{key_added}_conf"] = result.probability_matrix.max(axis=1).to_numpy()

        return run_compute(session, mutate)
