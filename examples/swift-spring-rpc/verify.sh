#!/usr/bin/env bash
set -euo pipefail

example="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$example/../.." && pwd)"
temporary_output=""
server_pid=""
server_log=""

cleanup() {
  local status=$?
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
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

cp -R "$example/swift-example" "$output/swift-example"
result="$(swift run --package-path "$output/swift-example" RpcExample "http://127.0.0.1:$port")"
if [[ "$result" != 5 ]]; then
  echo "Expected the Swift client to return 5, received: $result" >&2
  exit 1
fi
printf '%s\n' "$result"
