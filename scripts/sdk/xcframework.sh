#!/usr/bin/env bash
set -euo pipefail

mobile="${1:?Pass the mobile crate directory}"
library="${2:?Pass the Rust library name}"
module="${3:?Pass the Swift module name}"
package="${4:?Pass the Swift package output directory}"
shift 4
mkdir -p "${CARGO_TARGET_DIR:?Set a Cargo target directory}"
export CARGO_TARGET_DIR="$(cd "$CARGO_TARGET_DIR" && pwd)"
export IPHONEOS_DEPLOYMENT_TARGET=18.0 MACOSX_DEPLOYMENT_TARGET=14.0
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
scripts="$(cd "$(dirname "$0")" && pwd)"

# The producer can select a default cross target in .cargo/config.toml.
host_target="$(rustc --print host-tuple)"
host_output="$CARGO_TARGET_DIR/$host_target"
cargo build --manifest-path "$mobile/Cargo.toml" --locked "$@" --target "$host_target" --features bindgen --bin rust-inside-bindgen
cargo build --manifest-path "$mobile/Cargo.toml" --locked "$@" --target "$host_target" --lib --release
for target in aarch64-apple-ios aarch64-apple-ios-sim; do
  cargo build --manifest-path "$mobile/Cargo.toml" --locked "$@" --lib --release --target "$target"
done

(
  cd "$mobile"
  "$host_output/debug/rust-inside-bindgen" generate --metadata-no-deps --crate "$library" \
    "$host_output/release/lib$library.dylib" --language swift --no-format --out-dir "$stage"
)
test -f "$stage/$module.swift"
bash "$scripts/assemble-xcframework.sh" "$stage" "$package" "" \
  "$host_output/release/lib$library.a" \
  "$CARGO_TARGET_DIR/aarch64-apple-ios/release/lib$library.a" \
  "$CARGO_TARGET_DIR/aarch64-apple-ios-sim/release/lib$library.a"
