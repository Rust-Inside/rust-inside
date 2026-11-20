"""Copy root-only Cargo settings that affect the generated SDK workspace."""

import json
import os
from pathlib import Path
import sys
import tomllib


def toml_value(value):
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{toml_value(k)} = {toml_value(v)}" for k, v in value.items()) + " }"
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(v) for v in value) + "]"
    return json.dumps(value, ensure_ascii=False)


root, output = map(Path, sys.argv[1:])
with (root / "Cargo.toml").open("rb") as manifest:
    workspace = tomllib.load(manifest)
workspace_table = workspace.get("workspace", {})
package = workspace.get("package", {})
edition = package.get("edition", "2015")
if isinstance(edition, dict):
    edition = workspace_table["package"]["edition"]
# Cargo infers its default resolver from the root package's edition.
# A virtual workspace without an explicit resolver uses version 1.
default_resolver = {"2024": "3", "2021": "2"}.get(edition, "1")
resolver = workspace_table.get("resolver", package.get("resolver", default_resolver))
print(f"resolver = {toml_value(resolver)}")
for key in ["patch", "replace", "profile"]:
    if key not in workspace:
        continue
    section = workspace[key]
    if key == "patch":
        dependencies = [spec for registry in section.values() for spec in registry.values()]
    elif key == "replace":
        dependencies = section.values()
    else:
        dependencies = []
    for dependency in dependencies:
        if isinstance(dependency, dict) and "path" in dependency:
            dependency["path"] = os.path.relpath(root / dependency["path"], output)
    print(f"\n[{key}]")
    for name, settings in section.items():
        print(f"{toml_value(name)} = {toml_value(settings)}")
