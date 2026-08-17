"""Consistency checks for the workflow's declarative half.

Four files have to agree, and nothing at runtime would notice if they stopped:

  data_types.json          the catalog — patterns, readers, recipes, which knob applies where
  data_types.schema.json   its schema
  nextflow.config          the params the workflow actually exposes
  nextflow_schema.json     how those params are documented

So this asserts, without running any analysis:

  * the catalog validates against its schema;
  * every recipe a data type names exists in backend/app/recipes/;
  * every `applies_to` is the truth — the type's recipes really do declare one of the
    parameter's `recipe_params`, and every type whose recipes declare one is listed;
  * every common parameter is a param in nextflow.config with the same default, and is
    described in nextflow_schema.json with its applicable types spelled out;
  * discovery classifies a synthetic tree of every catalogued type correctly, including
    the case where one type's folder also matches another's patterns.

Run from the repo root:  python nextflow/tests/check_catalog.py
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NF = REPO / "nextflow"
RECIPES = REPO / "backend" / "app" / "recipes"

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


def load(path: Path):
    return json.loads(path.read_text())


def check_schema(catalog: dict) -> None:
    try:
        import jsonschema
    except ImportError:
        print("[skip] jsonschema not installed; catalog not validated against its schema")
        return
    jsonschema.validate(catalog, load(NF / "data_types.schema.json"))
    jsonschema.Draft7Validator.check_schema(load(NF / "nextflow_schema.json"))
    print("[ok] data_types.json validates; nextflow_schema.json is a valid schema")


def recipe_params(name: str) -> set[str]:
    return {p["name"] for p in load(RECIPES / name).get("params", [])}


def check_recipes(catalog: dict) -> None:
    for data_type in catalog["data_types"]:
        for recipe in data_type["recipes"]:
            check((RECIPES / recipe).is_file(),
                  f"{data_type['id']}: recipe {recipe} does not exist in {RECIPES}")
    print(f"[ok] every recipe named by the {len(catalog['data_types'])} data types exists")


def check_applies_to(catalog: dict) -> None:
    """`applies_to` must be exactly the set of types whose recipes declare the
    parameter — neither a type that would silently ignore the value, nor a missing one
    that would silently keep a default the user thought they had changed."""
    declared = {}
    for data_type in catalog["data_types"]:
        names: set[str] = set()
        for recipe in data_type["recipes"]:
            names |= recipe_params(recipe)
        declared[data_type["id"]] = names

    for name, param in catalog["common_params"].items():
        targets = set(param["recipe_params"])
        actual = {tid for tid, names in declared.items() if names & targets}
        listed = set(param["applies_to"])
        check(listed <= actual,
              f"common_params.{name}.applies_to lists {sorted(listed - actual)}, whose "
              f"recipes declare none of {sorted(targets)}")
        check(actual <= listed,
              f"common_params.{name}.applies_to omits {sorted(actual - listed)}, whose "
              f"recipes do declare one of {sorted(targets)}")
    print(f"[ok] all {len(catalog['common_params'])} common params match their recipes")


def config_defaults() -> dict[str, str]:
    """`name = value` pairs from the params block of nextflow.config."""
    text = (NF / "nextflow.config").read_text()
    block = text.split("params {", 1)[1].split("\n}", 1)[0]
    found = {}
    for line in block.splitlines():
        line = line.split("//", 1)[0].strip()
        if match := re.match(r"^(\w+)\s*=\s*(.+?)\s*$", line):
            found[match.group(1)] = match.group(2)
    return found


def check_params_exposed(catalog: dict) -> None:
    config = config_defaults()
    schema = load(NF / "nextflow_schema.json")
    documented = {}
    for group in schema["definitions"].values():
        documented.update(group.get("properties", {}))

    for name, param in catalog["common_params"].items():
        check(name in config, f"common param {name} is not a param in nextflow.config")
        if name in config:
            want = param["default"]
            got = config[name].strip("'\"")
            check(str(want) == got,
                  f"{name}: catalog default {want!r} but nextflow.config has {got!r}")
        check(name in documented, f"common param {name} is missing from nextflow_schema.json")
        if name in documented:
            described = documented[name]["description"]
            check(described.startswith(param["description"]),
                  f"{name}: nextflow_schema.json description has drifted from the catalog")
            labels = {t["id"]: t["label"] for t in catalog["data_types"]}
            for applies in param["applies_to"]:
                check(labels[applies] in described,
                      f"{name}: nextflow_schema.json does not mark it as applying to "
                      f"{labels[applies]}")
    for name in config:
        if name in catalog["common_params"]:
            continue
        check(name in documented, f"nextflow.config param {name} is undocumented "
                                  f"in nextflow_schema.json")
    print(f"[ok] {len(config)} params agree across nextflow.config and nextflow_schema.json")


# A folder of each catalogued type, plus the two cases that a naive matcher gets wrong:
# a Visium HD run (which also carries a Visium-shaped matrix one level down) and a
# folder that is nothing. Values are paths to create relative to the dataset folder;
# a trailing '/' makes a directory.
FIXTURE = {
    "a/xen1": ["experiment.xenium", "cell_feature_matrix.h5"],
    "a/b/vis1": ["spatial/scalefactors_json.json", "spatial/tissue_positions.csv",
                 "filtered_feature_bc_matrix.h5"],
    "hd1": ["binned_outputs/square_008um/spatial/scalefactors_json.json",
            "binned_outputs/square_008um/filtered_feature_bc_matrix.h5",
            "spatial/scalefactors_json.json", "spatial/tissue_positions.csv",
            "filtered_feature_bc_matrix.h5"],
    "deep/x/y/mer1": ["detected_transcripts.csv", "cell_by_gene.csv", "cell_metadata.csv"],
    "cos1": ["Run1_exprMat_file.csv", "Run1_metadata_file.csv", "Run1_fov_positions_file.csv"],
    "cur1": ["anndata.h5ad", "Metrics.csv", "cluster_assignment.txt"],
    "st1": ["cells.h5ad", "ome/", "masks_deepcell/"],
    "mc1": ["markers.csv", "quantification/", "registration/"],
    "junk": ["notes.txt", "readme/"],
}
EXPECTED = {
    "a/xen1": "xenium", "a/b/vis1": "visium", "hd1": "visium_hd",
    "deep/x/y/mer1": "merscope", "cos1": "cosmx", "cur1": "curio",
    "st1": "steinbock", "mc1": "mcmicro",
}


def check_discovery(catalog: dict) -> None:
    """Every catalogued type must be represented in the fixture, and discovery must
    classify each one — otherwise a new type could be added with patterns that never
    match anything."""
    missing = {t["id"] for t in catalog["data_types"]} - set(EXPECTED.values())
    check(not missing, f"no discovery fixture for data type(s) {sorted(missing)}; add one "
                       f"to FIXTURE/EXPECTED in {Path(__file__).name}")

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for folder, entries in FIXTURE.items():
            for entry in entries:
                target = root / folder / entry
                if entry.endswith("/"):
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.touch()
        proc = subprocess.run(
            ["nextflow", "run", str(NF / "tests" / "discovery_test.nf"), "--root", str(root),
             "-ansi-log", "false"],
            capture_output=True, text=True, cwd=tmp)
        if proc.returncode != 0:
            failures.append(f"discovery_test.nf failed:\n{proc.stdout}\n{proc.stderr}")
            return
        found = dict(
            line.split("\t") for line in proc.stdout.splitlines() if "\t" in line)

    check(found == EXPECTED,
          f"discovery mismatch:\n  expected {EXPECTED}\n  got      {found}")
    if found == EXPECTED:
        print(f"[ok] discovery classified all {len(EXPECTED)} synthetic datasets, "
              f"and ignored the folder that is not one")


def main() -> int:
    catalog = load(NF / "data_types.json")
    check_schema(catalog)
    check_recipes(catalog)
    check_applies_to(catalog)
    check_params_exposed(catalog)
    check_discovery(catalog)

    if failures:
        print(f"\n{len(failures)} PROBLEM(S):", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1
    print("\nCATALOG CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
