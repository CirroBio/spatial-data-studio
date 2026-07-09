"""SpatialData-zarr importer — the "Import Data" reader for an already-SpatialData
store. spatialdata's own `read_zarr` only opens a `.zarr` directory; this reader
additionally accepts a `.zarr.zip` or `.zarr.tar.gz` archive by unpacking it to a
temp dir (owned by the session, cleaned on close) before reading. Extraction +
format detection live in persistence/store.read_spatialdata_archive, shared with
the checkpoint load path."""
from __future__ import annotations

import traceback

from ..base import CallResult, Function, ParamSpec, capture_log, short_error
from ._docs import custom_doc

_STORE_PARAM = ParamSpec(
    "store", {"type": "string"}, "text", None, required=True,
    tooltip="Path to a SpatialData store: a .zarr directory, or a .zarr.zip / .zarr.tar.gz archive")


class ReadSpatialDataZarr(Function):
    source = "custom"
    # Keeps the reader's descriptor stable as io.read_zarr (the introspected
    # spatialdata.read_zarr entry it replaces), so existing import call sites and
    # saved read-bootstrap history keep resolving.
    key = "io.read_zarr"
    namespace = "io"
    function = "read_zarr"
    effect_class = "read"
    input_kind = "either"
    label = "SpatialData zarr (.zarr / .zip / .tar.gz)"
    citation = ("SpatialData (Marconato, L., Palla, G., Yamauchi, K.A. et al. Nat Methods 22, "
                "58-62 (2025)); .zarr.zip / .zarr.tar.gz archive extraction added in this repository.")
    documentation = custom_doc("spatialdata-zarr-import")
    summary = "Open a SpatialData store: a .zarr directory, or a .zarr.zip / .zarr.tar.gz archive."
    doc = """SpatialData zarr import

Opens an existing SpatialData store as a new session. Accepts either a `.zarr`
directory or a compressed archive of one (`.zarr.zip` or `.zarr.tar.gz`); an
archive is unpacked to a temporary directory that the session owns and cleans up
when it closes. This is the raw-import counterpart to opening an app checkpoint —
any `app_state` stored in the object is ignored; the session starts fresh.

Parameters
----------
store
    Path to the SpatialData store (a `.zarr` directory, or a `.zarr.zip` /
    `.zarr.tar.gz` archive) under the data directory.
"""
    params = [_STORE_PARAM]

    def execute(self, params: dict, session) -> CallResult:
        from ...persistence.store import read_spatialdata_archive

        store = params.get("store")
        if not store:
            return CallResult(status="failed", error="a store path is required")
        with capture_log() as buf:
            try:
                sdata, extract_dir = read_spatialdata_archive(store)
            except Exception as e:
                return CallResult(status="failed", log=buf.getvalue() + "\n" + traceback.format_exc(),
                                  error=short_error(e))
            log = buf.getvalue()
        # The session cleans extract_dir on close (same contract as create_from_load);
        # zarr reads chunks from it lazily for the object's lifetime.
        if extract_dir is not None:
            session.extract_dir = extract_dir
        return CallResult(status="completed", log=log, new_object=sdata)
