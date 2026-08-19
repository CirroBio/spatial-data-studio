"""Field-path resolver → Arrow IPC (DESIGN §3.3, §14.1). Fully generic: it never
knows function names, only how to fetch a field by `<element>:<key>` path.
"""
import io
import json

import numpy as np
import pyarrow as pa
import pyarrow.ipc as ipc
import pandas as pd
from scipy import sparse

# Sparse graphs (obsp) are shipped as dense (row, col, data) triplets — 16
# bytes/edge, never viewport- or row-limited like the other field paths. Nothing in
# the frontend fetches obsp today, but a future "show neighbor graph" feature could
# wire it in without noticing the missing bound; cap nnz so it fails loudly instead
# of streaming hundreds of MB (a k~15 kNN graph on 1M cells is ~15M edges/240MB).
_MAX_SPARSE_EDGES = 5_000_000

# Screen/world-space coordinates rounded to this many decimals before shipping —
# far below on-screen resolution, but it zeros enough low mantissa bits that gzip
# actually compresses the point cloud (raw float32 is near-incompressible).
# Mirrors the same precision `transport/geometry.py` uses for polygon coordinates.
_COORD_DECIMALS = 2


def _is_categorical(series: pd.Series) -> bool:
    return isinstance(series.dtype, pd.CategoricalDtype) or series.dtype == object


def field_kind(adata, element: str, key: str) -> str:
    if element == "obs":
        return "categorical" if _is_categorical(adata.obs[key]) else "numeric"
    return "numeric"


def resolve_field(adata, field_path: str) -> pa.RecordBatch:
    if ":" not in field_path:
        raise ValueError(f"bad field path: {field_path}")
    element, key = field_path.split(":", 1)

    if element == "obs":
        return _obs_batch(adata, key)
    if element == "var":
        col = adata.var[key]
        return pa.record_batch({"value": pa.array(np.asarray(col))})
    if element == "obsm":
        arr = np.round(np.asarray(adata.obsm[key]).astype("float32"), _COORD_DECIMALS)
        # A 1-D obsm entry is the single-component case `describe_fields` advertises as
        # n_components 1, so the picker can ask for it; make it n rows of one column
        # (np.atleast_2d would give the transposed 1 row of n columns).
        if arr.ndim == 1:
            arr = arr[:, np.newaxis]
        cols = {f"d{i}": pa.array(arr[:, i]) for i in range(arr.shape[1])}
        return pa.record_batch(cols)
    if element == "X":
        return _gene_batch(adata, key)
    if element == "obsp":
        return _sparse_batch(adata.obsp[key])
    if element == "layers":
        if "/" not in key:
            raise ValueError(f"layer field needs `layers:<layer>/<gene>` form: {key}")
        layer, gene = key.split("/", 1)
        return _gene_batch(adata, gene, layer=layer)
    raise ValueError(f"unsupported element: {element}")


def _obs_batch(adata, key: str) -> pa.RecordBatch:
    series = adata.obs[key]
    if _is_categorical(series):
        cat = series.astype("category") if not isinstance(series.dtype, pd.CategoricalDtype) else series
        codes = cat.cat.codes.to_numpy().astype("int32")
        categories = [str(c) for c in cat.cat.categories]
        schema = pa.schema(
            [pa.field("code", pa.int32())],
            metadata={b"categories": json.dumps(categories).encode(), b"kind": b"categorical"},
        )
        return pa.record_batch([pa.array(codes)], schema=schema)
    vals = pd.to_numeric(series, errors="coerce").to_numpy().astype("float64")
    schema = pa.schema([pa.field("value", pa.float64())], metadata={b"kind": b"numeric"})
    return pa.record_batch([pa.array(vals)], schema=schema)


def _gene_batch(adata, gene: str, layer: str | None = None) -> pa.RecordBatch:
    if gene not in adata.var_names:
        raise KeyError(f"gene not found: {gene}")
    idx = adata.var_names.get_loc(gene)
    mat = adata.layers[layer] if layer else adata.X
    if mat is None:  # a checkpoint saved without X (store.trim_table)
        raise KeyError("this checkpoint was saved without X, so it holds no expression values")
    col = mat[:, idx]
    col = col.toarray().ravel() if sparse.issparse(col) else np.asarray(col).ravel()
    return pa.record_batch({"value": pa.array(col.astype("float32"))})


def _sparse_batch(mat) -> pa.RecordBatch:
    """CSR/COO sparse graph → triplets, never densified (DESIGN §17)."""
    coo = mat.tocoo() if sparse.issparse(mat) else sparse.coo_matrix(mat)
    if coo.nnz > _MAX_SPARSE_EDGES:
        raise ValueError(
            f"sparse field has {coo.nnz:,} edges, over the {_MAX_SPARSE_EDGES:,} transport cap")
    schema = pa.schema(
        [pa.field("row", pa.int32()), pa.field("col", pa.int32()), pa.field("data", pa.float64())],
        metadata={b"shape": json.dumps(list(coo.shape)).encode()},
    )
    return pa.record_batch(
        [pa.array(coo.row.astype("int32")), pa.array(coo.col.astype("int32")),
         pa.array(coo.data.astype("float64"))],
        schema=schema,
    )


def apply_affine_xy(batch: pa.RecordBatch, affine6: list[float]) -> pa.RecordBatch:
    """Apply the 6-float affine to the (d0, d1) columns of a coordinate batch, leaving
    any further dimensions (d2) untouched. Used to serve points in the edited
    points->global space."""
    from ..sessions import transform
    xy = np.column_stack([np.asarray(batch.column("d0")), np.asarray(batch.column("d1"))])
    out = transform.apply_affine6_xy(affine6, xy)
    cols = {name: batch.column(name) for name in batch.schema.names}
    cols["d0"] = pa.array(np.round(out[:, 0].astype("float32"), _COORD_DECIMALS))
    cols["d1"] = pa.array(np.round(out[:, 1].astype("float32"), _COORD_DECIMALS))
    return pa.record_batch(cols)


def to_ipc_bytes(batch: pa.RecordBatch) -> bytes:
    sink = io.BytesIO()
    with ipc.new_stream(sink, batch.schema) as writer:
        writer.write_batch(batch)
    return sink.getvalue()


def describe_fields(adata, sdata) -> dict:
    """Field inventory for SessionState.fields (frontend pickers)."""
    from .. import imaging
    obs = [{"name": c, "kind": field_kind(adata, "obs", c)} for c in adata.obs.columns]
    images = list(getattr(sdata, "images", {}).keys()) if sdata is not None else []
    shapes = list(getattr(sdata, "shapes", {}).keys()) if sdata is not None else []
    image_dims = [{"name": n, "width": w, "height": h}
                  for n in images for (w, h) in [imaging.image_dims(sdata, n)]]
    obsm = []
    for k, v in adata.obsm.items():
        a = np.asarray(v)
        obsm.append({"name": k, "n_components": int(a.shape[1]) if a.ndim > 1 else 1})
    return {
        "obs": obs,
        "obsm": obsm,
        "obsp": list(adata.obsp.keys()),
        "layers": list(adata.layers.keys()),
        "n_obs": int(adata.n_obs),
        # False for a checkpoint saved without its expression matrix
        # (`store.trim_table`), which is what stops the pickers offering gene coloring
        # the file cannot answer. The checkpoint viewer derives the same flag from the
        # absence of a `tables/<key>/X` node.
        "has_x": adata.X is not None,
        "var_names_count": int(adata.n_vars),
        "var_names_sample": [str(v) for v in adata.var_names[:50]],
        "images": images,
        "image_dims": image_dims,
        "shapes": shapes,
    }
