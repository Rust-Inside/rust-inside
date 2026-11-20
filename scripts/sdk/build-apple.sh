#!/usr/bin/env bash
set -euo pipefail

generated="$(cd "${1:?Pass the generated workspace}" && pwd)"
if [[ -d "$generated/platforms/ios" ]]; then generated="$generated/platforms/ios"; fi
version="${2:?Pass the SDK version}"
mkdir -p "${3:?Pass the output directory}"
output="$(cd "$3" && pwd)"
scripts="$(cd "$(dirname "$0")" && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$generated/target}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
package="$stage/sdk"

write_release_assets() {
  local ffi="$1"
  if [[ -f "$generated/LICENSE" ]]; then cp "$generated/LICENSE" "$package/$ffi.xcframework/LICENSE"; fi
  ditto -c -k --keepParent "$package/$ffi.xcframework" "$output/$ffi-$version.xcframework.zip"
  mkdir -p "$output/swift-package"
  cp -R "$package/Sources" "$output/swift-package/"
  sed "s|path: \"$ffi.xcframework\"|url: \"@RUST_INSIDE_BINARY_URL@\", checksum: \"@RUST_INSIDE_BINARY_SHA256@\"|" \
    "$package/Package.swift" > "$output/swift-package/Package.swift"
}

native_manifest="$(node -p 'require(process.argv[1]).uniffiManifest ?? ""' "$generated/sdk.json")"
if [[ -n "$native_manifest" ]]; then
  bash "$scripts/build-uniffi-ios.sh" "$generated/$native_manifest" "$package"
  frameworks=("$package"/*.xcframework)
  write_release_assets "$(basename "${frameworks[0]}" .xcframework)"
  exit 0
fi

module="$(node -p 'require(process.argv[1]).module' "$generated/sdk.json")"
library="$(node -p 'require(process.argv[1]).library' "$generated/sdk.json")"
bash "$scripts/xcframework.sh" "$generated/mobile" "$library" "$module" "$package"
sed "s/RustInside/$module/g" "$scripts/package-templates/swift/Package.swift" > "$package/Package.swift"

# Reference each public symbol from an application linking the packaged XCFramework.
consumer="$stage/consumer"
mkdir -p "$consumer/Sources/RustInside_ReleaseCheck"
cat > "$consumer/Package.swift" <<SWIFT
// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "RustInside_ReleaseCheck", platforms: [.iOS(.v18), .macOS(.v14)],
    dependencies: [.package(path: "../sdk")],
    targets: [.executableTarget(name: "RustInside_ReleaseCheck", dependencies: [.product(name: "$module", package: "sdk")])])
SWIFT
node --input-type=module - "$generated/sdk.json" > "$consumer/Sources/RustInside_ReleaseCheck/main.swift" <<'JS'
import { readFileSync } from 'node:fs';
const sdk = JSON.parse(readFileSync(process.argv[2], 'utf8'));
console.log(`import ${sdk.module}`);
for (const api of sdk.exports) console.log(`_ = ${sdk.module}.\`${api.jsName}\``);
const swiftName = name => name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
for (const record of sdk.records ?? []) {
  console.log(`private func check${record.name}(_ value: ${sdk.module}.${record.name}) {`);
  for (const field of record.fields) console.log(`  _ = value.\`${swiftName(field.name)}\``);
  console.log('}');
}
for (const client of sdk.clients ?? []) {
  const type = `${sdk.module}.${client.name}`;
  const labels = Object.keys(client.constructor.args).map(name => `${swiftName(name)}:`).join('');
  console.log(`private func check${client.name}(_ value: ${type}) {`);
  console.log(labels ? `  _ = ${type}.init(${labels})` : `  _ = ${type}()`);
  for (const method of client.methods) console.log(`  _ = value.\`${method.jsName}\``);
  console.log('}');
}
JS
swift build --package-path "$consumer" --triple arm64-apple-ios18.0-simulator \
  --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --product RustInside_ReleaseCheck

write_release_assets "${module}FFI"
