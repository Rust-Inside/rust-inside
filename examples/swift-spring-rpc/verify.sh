#!/usr/bin/env bash
set -euo pipefail

example="$(cd "$(dirname "$0")" && pwd)"
source "$example/../../scripts/sdk/tests/run-rpc-example.sh"

verify_rpc_result() {
  if [[ "$2" != 5 ]]; then
    echo "Expected the Swift client to return 5, received: $2" >&2
    return 1
  fi
}

run_rpc_example "$example" "$@"
