#!/usr/bin/env bash
set -euo pipefail

bindings="${1:?Pass the directory containing generated UniFFI Swift bindings}"
package="${2:?Pass the Swift package directory}"
template="${3-}"
shift 3
shopt -s nullglob
swift=("$bindings"/*.swift)
maps=("$bindings"/*.modulemap)
headers=("$bindings"/*.h)
if [[ ${#swift[@]} -ne 1 || ${#maps[@]} -ne 1 || ${#headers[@]} -eq 0 ]]; then
  echo "Expected Swift bindings, a module map and headers for one UniFFI component in $bindings" >&2
  exit 1
fi
module="$(basename "${swift[0]}" .swift)"
# UniFFI lets the FFI module name and header filename be configured separately.
ffi="$(awk '$1 == "module" { print $2; exit }' "${maps[0]}")"
identifier='^[a-zA-Z_][a-zA-Z_0-9]*$'
if ! [[ "$module" =~ $identifier && "$ffi" =~ $identifier && "$module" != "$ffi" ]]; then
  echo "Expected distinct Swift and FFI module identifiers, got '$module' and '$ffi'" >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/headers" "$package/Sources/$module"
cp "${headers[@]}" "$stage/headers/"
cp "${maps[0]}" "$stage/headers/module.modulemap"
libraries=()
for library in "$@"; do
  libraries+=(-library "$library" -headers "$stage/headers")
done
xcodebuild -create-xcframework "${libraries[@]}" -output "$stage/$ffi.xcframework"
ditto "$stage/$ffi.xcframework" "$package/$ffi.xcframework"
cp "${swift[0]}" "$package/Sources/$module/"
if [[ -n "$template" ]]; then
  sed -e "s/@SWIFT_MODULE@/$module/g" -e "s/@FFI_MODULE@/$ffi/g" "$template" > "$package/Package.swift"
fi
