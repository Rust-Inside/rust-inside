#!/usr/bin/env bash
set -euo pipefail

manifest="${1:?Pass the UniFFI library Cargo.toml}"
package="${2:?Pass a new directory for the Swift package}"
scripts="$(cd "$(dirname "$0")" && pwd)"
crate="$(cd "$(dirname "$manifest")" && pwd)"
manifest="$crate/$(basename "$manifest")"
mkdir -p "$(dirname "$package")"
package="$(cd "$(dirname "$package")" && pwd)/$(basename "$package")"
if [[ -e "$package" || -L "$package" ]]; then
  echo "Choose a new output directory for the Swift package: $package" >&2
  exit 1
fi
stage="$(mktemp -d "$(dirname "$package")/.rust-inside-ios.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
cd "$crate"
export IPHONEOS_DEPLOYMENT_TARGET=18.0
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$crate/target}"
mkdir -p "$CARGO_TARGET_DIR"
export CARGO_TARGET_DIR="$(cd "$CARGO_TARGET_DIR" && pwd)"

# Discover the actual library target and locked UniFFI version, including renamed
# Cargo dependencies and custom [lib] names. No generator binary is needed in the crate.
bash "$scripts/ensure-cargo-lock.sh" "$manifest"
cargo metadata --locked --manifest-path "$manifest" --format-version 1 --filter-platform aarch64-apple-ios > "$stage/metadata.json"
python3 - "$stage/metadata.json" "$manifest" > "$stage/component" <<'PY'
import json
import sys
from pathlib import Path

metadata = json.loads(Path(sys.argv[1]).read_text())
packages = {p["id"]: p for p in metadata["packages"]}
manifest = Path(sys.argv[2]).resolve()
package = next((p for p in packages.values() if Path(p["manifest_path"]).resolve() == manifest), None)
if not package:
    sys.exit(f"Select the Cargo.toml of a UniFFI library crate: {manifest}")
library = next((t for t in package["targets"] if "staticlib" in t["crate_types"]), None)
if not library:
    sys.exit(f"Add staticlib to [lib].crate-type in {manifest}")
node = next(n for n in metadata["resolve"]["nodes"] if n["id"] == package["id"])
versions = {packages[d["pkg"]]["version"] for d in node["deps"]
            if packages[d["pkg"]]["name"] == "uniffi" and any(k["kind"] is None for k in d["dep_kinds"])}
if len(versions) != 1:
    sys.exit(f"Expected one direct UniFFI dependency in {manifest}")
print(library["name"], versions.pop())
PY
read -r library version < "$stage/component"

host="$(rustc --print host-tuple)"
cli="$CARGO_TARGET_DIR/rust-inside-uniffi/$version/$host"
cargo install --locked --debug --target "$host" --version "=$version" --root "$cli" --features cli --bin uniffi-bindgen uniffi
device=aarch64-apple-ios
simulator=aarch64-apple-ios-sim
intel_simulator=x86_64-apple-ios
rustup target add "$device" "$simulator" "$intel_simulator"
for target in "$device" "$simulator" "$intel_simulator"; do
  cargo build --locked --manifest-path "$manifest" --release --lib --target "$target"
done
archive="lib$library.a"
"$cli/bin/uniffi-bindgen" generate --metadata-no-deps --crate "$library" \
  "$CARGO_TARGET_DIR/$device/release/$archive" --language swift --no-format --out-dir "$stage/bindings"

# This package is fetched over Git. Strip library debug sections while keeping
# both simulator architectures and the symbols the generated Swift calls.
mkdir -p "$stage/device" "$stage/simulator"
xcrun strip -S -o "$stage/device/$archive" "$CARGO_TARGET_DIR/$device/release/$archive"
xcrun lipo -create "$CARGO_TARGET_DIR/$simulator/release/$archive" \
  "$CARGO_TARGET_DIR/$intel_simulator/release/$archive" -output "$stage/simulator.a"
xcrun strip -S -o "$stage/simulator/$archive" "$stage/simulator.a"
bash "$scripts/assemble-xcframework.sh" "$stage/bindings" "$stage/sdk" \
  "$scripts/package-templates/swift/Package.ios.swift" "$stage/device/$archive" "$stage/simulator/$archive"

# Link through a clean SwiftPM consumer, including the binary module, before publication.
modules=("$stage/sdk/Sources/"*)
module="$(basename "${modules[0]}")"
mkdir -p "$stage/check/Sources/PackageCheck"
cat > "$stage/check/Package.swift" <<SWIFT
// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "PackageCheck", platforms: [.iOS(.v18)],
    dependencies: [.package(path: "../sdk")],
    targets: [.executableTarget(name: "PackageCheck", dependencies: [.product(name: "$module", package: "sdk")])])
SWIFT
printf 'import %s\n' "$module" > "$stage/check/Sources/PackageCheck/main.swift"
swift build --package-path "$stage/check" --triple arm64-apple-ios18.0-simulator \
  --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --product PackageCheck
mv "$stage/sdk" "$package"
