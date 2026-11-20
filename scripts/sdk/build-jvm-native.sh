#!/usr/bin/env bash
set -euo pipefail

generated="$(cd "${1:?Pass the generated SDK workspace}" && pwd)"
if [[ -d "$generated/platforms/backend" ]]; then generated="$generated/platforms/backend"; fi
resources="${2:?Pass the native resource directory}"
library="$(node -p 'require(process.argv[1]).library' "$generated/sdk.json")"
host="$(rustc --print host-tuple)"
# JNA searches for System.mapLibraryName(library) under its OS/architecture prefix.
case "$host" in
  x86_64-unknown-linux-gnu) platform=linux-x86-64; extension=so ;;
  aarch64-unknown-linux-gnu) platform=linux-aarch64; extension=so ;;
  aarch64-apple-darwin) platform=darwin-aarch64; extension=dylib ;;
  x86_64-apple-darwin) platform=darwin-x86-64; extension=dylib ;;
  *) echo "No JVM native resource mapping for $host" >&2; exit 1 ;;
esac

target_dir="${CARGO_TARGET_DIR:-$generated/target}"
cargo build --manifest-path "$generated/mobile/Cargo.toml" --locked --target "$host" \
  --target-dir "$target_dir" --release --lib
mkdir -p "$resources/$platform"
cp "$target_dir/$host/release/lib$library.$extension" "$resources/$platform/"
