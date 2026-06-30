"""Edit Annotations — rename/merge the values of a categorical obs column."""
from __future__ import annotations

from ..base import Function, ParamSpec, CallResult, run_compute

_DOC = """Edit Annotations

Pick a categorical obs column, review its unique values, and type a replacement
for any of them. Blank replacements leave a value unchanged; mapping two values
to the same text merges them into one category.

Parameters
----------
obs_column
    The categorical obs column to edit.
mapping
    A {old value: new value} object; only changed values need an entry.
"""


class EditAnnotations(Function):
    source = "custom"
    key = "custom.edit_annotations"
    namespace = "custom"
    function = "edit_annotations"
    effect_class = "compute"
    label = "Edit Annotations"
    summary = "Rename or merge the values of a categorical obs column."
    doc = _DOC
    partially_supported = False
    unsupported_params: list = []

    params = [
        ParamSpec("obs_column", {"type": "string"}, "obs_categorical", "obs_categorical",
                  required=True, tooltip="categorical obs column to edit"),
        ParamSpec("mapping", {"type": "object"}, "obs_value_map", "obs_column",
                  required=True, tooltip="replacement text per unique value"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        col = params.get("obs_column")
        raw = params.get("mapping") or {}

        adata = session.active_table()
        if not col or col not in adata.obs.columns:
            return CallResult(status="failed", error=f"obs column '{col}' does not exist")

        mapping = {str(k): str(v) for k, v in raw.items()
                   if v is not None and str(v) != "" and str(v) != str(k)}
        if not mapping:
            return CallResult(status="failed", error="no replacements provided")

        def mutate(ad):
            values = ad.obs[col].astype(str).replace(mapping)
            ad.obs[col] = values.astype("category")

        return run_compute(session, mutate)
