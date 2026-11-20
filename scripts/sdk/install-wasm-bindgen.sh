#!/usr/bin/env bash
set -euo pipefail

archive=wasm-bindgen-0.2.130-x86_64-unknown-linux-musl
cd "${RUNNER_TEMP:?Set RUNNER_TEMP to an absolute temporary directory}"
curl --fail --silent --show-error --location --retry 3 --output "$archive.tar.gz" \
  "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.130/$archive.tar.gz"
echo "9687f3bb551b9f66f37ed32a40d7913a00f7962db653054e56857bc306c3227f  $archive.tar.gz" | sha256sum --check
tar -xzf "$archive.tar.gz" "$archive/wasm-bindgen"
echo "$PWD/$archive" >> "$GITHUB_PATH"
