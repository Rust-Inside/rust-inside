#!/usr/bin/env bash
set -euo pipefail

generated="$(cd "${1:?Pass the generated SDK workspace}" && pwd)"
version="${2:?Pass the SDK version}"
output="${3:?Pass the SDK output directory}"
scripts="$(cd "$(dirname "$0")" && pwd)"
# Scoped Node and browser APIs can compile to different Wasm binaries.
if [[ -d "$generated/platforms/backend/wasm" || -d "$generated/platforms/web/wasm" ]]; then
  for platform in backend web; do
    if [[ -d "$generated/platforms/$platform/wasm" ]]; then
      bash "$scripts/build-js.sh" "$generated/platforms/$platform" "$version" "$output"
    fi
  done
  exit 0
fi
read -r name library build_node build_web < <(node --input-type=module - "$generated/sdk.json" "$scripts/distribute.mjs" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { requireBackend } = await import(pathToFileURL(process.argv[3]));
const sdk = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const backend = requireBackend(sdk.backend);
console.log(sdk.name, sdk.wasmLibrary, backend === 'node' && Boolean(sdk.repositories?.backend), Boolean(sdk.repositories?.web));
NODE
)
if [[ "$build_node" != true && "$build_web" != true ]]; then exit 0; fi
mkdir -p "$output"
output="$(cd "$output" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
target_dir="${CARGO_TARGET_DIR:-$generated/target}"
cargo build --locked --release --target wasm32-unknown-unknown --target-dir "$target_dir" \
  --manifest-path "$generated/wasm/Cargo.toml" --lib
wasm="$target_dir/wasm32-unknown-unknown/release/$library.wasm"
tarballs=()
node_dir=""
web_dir=""
if [[ "$build_node" == true ]]; then
  node_dir="$output/backend"
  tarballs+=("$node_dir/$name-node-$version.tgz")
fi
if [[ "$build_web" == true ]]; then
  web_dir="$output/web"
  tarballs+=("$web_dir/$name-web-$version.tgz")
fi
bash "$scripts/pack-wasm.sh" "$wasm" "$name" "$version" "$node_dir" "$web_dir" "$generated/LICENSE"

# Resolve package names from a clean npm consumer and load the shipped WASM.
cd "$stage"
echo '{"private":true,"type":"module"}' > package.json
npm install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund "${tarballs[@]}"
node --input-type=module - "$generated/sdk.json" "$node_dir" "$web_dir" <<'NODE'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { name, exports, clients = [] } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const packages = {};
if (process.argv[3]) packages.backend = await import(`${name}-node`);
if (process.argv[4]) {
  const web = await import(`${name}-web`);
  const wasm = new URL('./index_bg.wasm', import.meta.resolve(`${name}-web`));
  await web.default({ module_or_path: await readFile(wasm) });
  packages.web = web;
}
for (const [platform, sdk] of Object.entries(packages)) {
  for (const { jsName } of exports) {
    assert.equal(typeof sdk[jsName], 'function', `Missing ${platform} export ${jsName}`);
  }
  for (const client of clients) {
    assert.equal(typeof sdk[client.name], 'function', `Missing ${platform} client ${client.name}`);
    for (const { jsName } of client.methods) {
      assert.equal(typeof sdk[client.name].prototype[jsName], 'function', `Missing ${platform} method ${client.name}.${jsName}`);
    }
  }
}
NODE
