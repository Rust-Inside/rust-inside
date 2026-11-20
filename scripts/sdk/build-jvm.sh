#!/usr/bin/env bash
set -euo pipefail

scripts="$(cd "$(dirname "$0")" && pwd)"
templates="$scripts/package-templates/jvm"
generated="$(cd "${1:?Pass the generated SDK workspace}" && pwd)"
if [[ -d "$generated/platforms/backend" ]]; then generated="$generated/platforms/backend"; fi
version="${2:?Pass the SDK version}"
resources="$(cd "${3:?Pass the native resource directory}" && pwd)"
mkdir -p "${4:?Pass the backend package output directory}"
output="$(cd "$4" && pwd)"
shift 4
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

read -r library group artifact < <(node -p \
  'const s = require(process.argv[1]); [s.library, s.kotlinPackage, s.name + "-jvm"].join(" ")' "$generated/sdk.json")
cp "$templates/"*.gradle "$stage/"
if [[ $# == 0 ]]; then
  for directory in "$resources"/*; do
    if [[ -d "$directory" ]]; then set -- "$@" "${directory##*/}"; fi
  done
fi
if [[ $# == 0 ]]; then echo "Expected at least one native library in $resources" >&2; exit 1; fi

# Pass the expected release platforms to reject missing native artifacts before publishing.
entries=()
for platform in "$@"; do
  case "$platform" in
    linux-x86-64|linux-aarch64) extension=so ;;
    darwin-aarch64|darwin-x86-64) extension=dylib ;;
    *) echo "Unknown JVM native platform: $platform" >&2; exit 1 ;;
  esac
  entry="$platform/lib$library.$extension"
  mkdir -p "$stage/src/main/resources/$platform"
  cp "$resources/$entry" "$stage/src/main/resources/$platform/"
  entries+=("$entry")
done
if [[ -f "$generated/LICENSE" ]]; then
  mkdir -p "$stage/src/main/resources/META-INF"
  cp "$generated/LICENSE" "$stage/src/main/resources/META-INF/LICENSE"
fi

host="$(rustc --print host-tuple)"
mkdir -p "${CARGO_TARGET_DIR:=$generated/target}"
target_dir="$(cd "$CARGO_TARGET_DIR" && pwd)"
cargo build --manifest-path "$generated/mobile/Cargo.toml" --locked --target "$host" \
  --target-dir "$target_dir" --features bindgen --bin rust-inside-bindgen
(
  cd "$generated/mobile"
  "$target_dir/$host/debug/rust-inside-bindgen" generate --metadata-no-deps --crate "$library" \
    "$resources/${entries[0]}" --language kotlin --no-format --out-dir "$stage/src/main/kotlin"
)
tasks=(jar generateDescriptorFileForSdkPublication)
contract_task="$(node "$scripts/tests/write-kotlin-api-check.mjs" "$generated/sdk.json" backend "$stage")"
if [[ -n "$contract_task" ]]; then tasks+=("$contract_task"); fi
gradle --no-daemon -p "$stage" -PsdkGroup="$group" -PsdkArtifact="$artifact" -PsdkVersion="$version" \
  -PsdkCoroutinesVersion="$(node -p 'require(process.argv[1]).kotlinCoroutinesVersion || ""' "$generated/sdk.json")" \
  "${tasks[@]}"
archive="$stage/build/libs/$artifact-$version.jar"
unzip -tqq "$archive" "${group//./\/}/*.class" "${entries[@]}"
cp "$archive" "$output/"
cp "$stage/build/publications/sdk/ivy.xml" "$output/$artifact-$version.xml"
