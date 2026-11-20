#!/usr/bin/env bash

run_rpc_example() (
  example="$1"
  shift
  root="$(cd "$example/../.." && pwd)"
  temporary_output=""
  server_pid=""
  server_log=""

  stop_spring() {
    if [[ -n "$server_pid" ]]; then
      kill "$server_pid" 2>/dev/null || true
      wait "$server_pid" 2>/dev/null || true
      server_pid=""
    fi
  }

  cleanup() {
    local status=$?
    stop_spring
    if ((status != 0)) && [[ -f "$server_log" ]]; then
      tail -n 60 "$server_log" >&2
    fi
    if [[ -n "$temporary_output" ]]; then
      rm -rf -- "$temporary_output"
    fi
  }

  if (( $# > 1 )); then
    echo "Usage: bash $0 [empty output directory]" >&2
    exit 2
  fi
  if (( $# == 1 )); then
    mkdir -p -- "$1"
    output="$(cd -- "$1" && pwd)"
    shopt -s dotglob nullglob
    existing_files=("$output"/*)
    if (( ${#existing_files[@]} )); then
      echo "Choose an empty output directory: $output" >&2
      exit 2
    fi
    shopt -u dotglob nullglob
  else
    temporary_output="$(mktemp -d "${TMPDIR:-/tmp}/rust-inside-rpc.XXXXXX")"
    output="$temporary_output"
  fi
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  node "$root/scripts/sdk/generate-rpc.mjs" "$example/rust-inside.json" "$output" >&2
  version="$(node -p 'require(process.argv[1]).version' "$output/jvm/sdk.json")"
  bash "$root/scripts/sdk/build-jvm-native.sh" "$output/jvm" "$output/native" >&2
  bash "$root/scripts/sdk/build-jvm.sh" "$output/jvm" "$version" "$output/native" "$output/packages" >&2
  if declare -F configure_rpc_example >/dev/null; then
    configure_rpc_example "$output"
  fi
  gradle --no-daemon --console=plain -p "$output/spring" installDist >&2

  server_log="$output/spring.log"
  "$output/spring/build/install/rust-inside-rpc-server/bin/rust-inside-rpc-server" \
    --server.address=127.0.0.1 --server.port=0 --spring.output.ansi.enabled=never >"$server_log" 2>&1 &
  server_pid=$!
  deadline=$((SECONDS + 45))
  while :; do
    port="$(sed -nE 's/.*Tomcat started on port ([0-9]+).*/\1/p' "$server_log" | tail -n 1)"
    if [[ -n "$port" ]]; then break; fi
    if ! kill -0 "$server_pid" 2>/dev/null || (( SECONDS >= deadline )); then
      echo "The Spring server did not start" >&2
      exit 1
    fi
    sleep 1
  done

  origin="http://127.0.0.1:$port"
  if declare -F check_rpc_access >/dev/null; then
    check_rpc_access "$origin"
  fi
  cp -R "$example/swift-example" "$output/swift-example"
  result="$(swift run --package-path "$output/swift-example" RpcExample "$origin")"
  stop_spring
  verify_rpc_result "$output" "$result"
  printf '%s\n' "$result"
)
