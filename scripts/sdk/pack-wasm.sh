#!/usr/bin/env bash
set -euo pipefail

wasm="${1:?Pass the compiled WASM library}"
name="${2:?Pass the SDK package name}"
version="${3:?Pass the SDK version}"
backend="${4?Pass a backend archive directory, or an empty string to skip it}"
web="${5?Pass a web archive directory, or an empty string to skip it}"
license="${6:-}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

pack() {
  local platform="$1" target="$2" type="$3" destination="$4"
  local package="$stage/$platform"
  mkdir -p "$destination"
  wasm-bindgen --target "$target" --out-name index --out-dir "$package" "$wasm"
  node --input-type=module - "$package" "$name-$platform" "$version" "$type" <<'NODE'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [directory, name, version, type] = process.argv.slice(2);
const path = join(directory, 'package.json');
const generated = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const manifest = { ...generated, name, version, type, main: './index.js', types: './index.d.ts' };
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
NODE
  if [[ -f "$license" ]]; then cp "$license" "$package/LICENSE"; fi
  # Pack the whole bindgen output, including any generated JS snippets.
  npm pack "$package" --ignore-scripts --pack-destination "$destination"
}

if [[ -n "$backend" ]]; then
  pack node nodejs commonjs "$backend"
fi
if [[ -n "$web" ]]; then
  pack web web module "$web"
fi
