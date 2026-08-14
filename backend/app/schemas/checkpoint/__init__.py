"""JSON Schema validation for the app-defined structures persisted inside a
checkpoint `.zarr.zip` (DESIGN.md §14, docs/CHECKPOINT_FORMAT.md). Each
`*.schema.json` file here is the single source of truth for that structure's
shape; the write paths in `persistence/store.py` and `cirro.py` validate
against it before the bytes reach disk, so a checkpoint this app writes is
guaranteed to conform to the documented format.

`sds-governance/checks/check_checkpoint_schema_docs.py` fails a change to any
schema file here unless docs/CHECKPOINT_FORMAT.md changes in the same commit.
"""
import json
from functools import lru_cache
from pathlib import Path

import jsonschema

_DIR = Path(__file__).parent


@lru_cache(maxsize=None)
def _schema(name: str) -> dict:
    return json.loads((_DIR / f"{name}.schema.json").read_text())


def validate_app_state(app_state: dict) -> None:
    jsonschema.validate(app_state, _schema("app_state"))


def validate_viewer_sidecar(sidecar: dict) -> None:
    jsonschema.validate(sidecar, _schema("viewer_sidecar"))


def validate_csc_table_attrs(attrs: dict) -> None:
    jsonschema.validate(attrs, _schema("csc_table"))


def validate_checkpoint_index(index: dict) -> None:
    jsonschema.validate(index, _schema("checkpoint_index"))
