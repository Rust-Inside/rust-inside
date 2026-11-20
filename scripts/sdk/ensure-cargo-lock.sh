#!/usr/bin/env bash
set -euo pipefail
manifest="${1:?Pass the source Cargo.toml}"
workspace="$(cargo locate-project --manifest-path "$manifest" --workspace --message-format plain)"
if [[ ! -f "$(dirname "$workspace")/Cargo.lock" ]]; then
  cargo generate-lockfile --manifest-path "$manifest"
fi
