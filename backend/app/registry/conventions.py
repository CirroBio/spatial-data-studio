"""The ONLY library-specific knowledge in the application (DESIGN §4.3).

A function-agnostic map keyed on squidpy's consistent parameter-naming
conventions. It upgrades bare reflected params to semantic widgets bound to the
active dataset, and pins policy params so the in-place mutation model holds.
Nothing here references a specific function.
"""
import re

# Policy params pinned to enforce the in-place model (DESIGN §4.6 step 3).
# name -> pinned value; hidden from the form.
PINNED_PARAMS = {
    "copy": False,
    "inplace": True,
}

# (regex on param name, widget, bound_to) — first match wins. `bound_to` tells
# the frontend which dataset facet to populate the picker from.
_CONVENTIONS = [
    (r"cluster_key$|^cluster_key|groups$|^group_key", "obs_categorical", "obs_categorical"),
    (r"genes$|var_names|gene_symbols", "var_names", "var_names"),
    (r"^layer$|_layer$|layers$", "layer_key", "layers"),
    (r"spatial_key", "obsm_key", "obsm"),
    (r"connectivity_key|distances_key|graph_key", "obsp_key", "obsp"),
    (r"library_key|library_id", "library_id", "library_id"),
    (r"^color$|color_key", "obs_key", "obs"),  # plotting color picks obs or X:gene
]
_COMPILED = [(re.compile(p), w, b) for p, w, b in _CONVENTIONS]

# Thread-count params are surfaced as first-class fields (DESIGN §20.3) and default
# to the machine's thread budget (SQUIDPY_N_THREADS or cpu count) rather than 1.
_THREAD_PARAM = re.compile(r"^n_jobs$|n_threads|num_threads|^workers$|^n_workers$")


def is_thread_param(param_name: str) -> bool:
    return bool(_THREAD_PARAM.search(param_name))


def thread_default() -> int:
    from ..config import config
    return config.N_THREADS


def convention_for(param_name: str):
    """Return (widget, bound_to) if the param name matches a convention, else None."""
    for rx, widget, bound in _COMPILED:
        if rx.search(param_name):
            return widget, bound
    return None


def is_pinned(param_name: str) -> bool:
    return param_name in PINNED_PARAMS
