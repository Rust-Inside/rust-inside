#!/usr/bin/env bash
set -euo pipefail

example="$(cd "$(dirname "$0")" && pwd)"
source "$example/../../scripts/sdk/tests/run-rpc-example.sh"

configure_rpc_example() {
  cp -R "$example/spring/." "$1/spring/"
  printf "\napply from: 'report.gradle'\n" >> "$1/spring/build.gradle"
  export REPORT_DATABASE="$1/reports"
  REPORT_DEMO_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
  export REPORT_DEMO_PASSWORD
}

check_rpc_access() {
  local route="$1/rpc/report" status
  status="$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' \
    -H 'Content-Type: application/json' -d '{"target_id":"post-42","reason":"SPAM"}' "$route")"
  [[ "$status" == 401 ]] || { echo "Expected HTTP 401 for an unauthenticated report, received $status" >&2; return 1; }
  status="$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' \
    --user "martin:$REPORT_DEMO_PASSWORD" -H 'Content-Type: application/json' \
    -d '{"target_id":"post-42","reason":"SPAM","reporter_id":"someone-else"}' "$route")"
  [[ "$status" == 400 ]] || { echo "Expected HTTP 400 for a forged reporter ID, received $status" >&2; return 1; }
}

verify_rpc_result() {
  local output="$1" report_id="$2" rows
  local h2=("$output/spring/build/install/rust-inside-rpc-server/lib"/h2-*.jar)
  rows="$(java -cp "${h2[0]}" org.h2.tools.Shell -url "jdbc:h2:file:$REPORT_DATABASE" -user sa -password '' \
    -sql "SELECT report_id || '|' || reporter_id || '|' || target_id || '|' || reason AS saved_report FROM reports; SELECT 'count=' || COUNT(*) FROM reports;")"
  if ! printf '%s\n' "$rows" | grep -Fxq -- "$report_id|martin|post-42|SPAM" ||
     ! printf '%s\n' "$rows" | grep -Fxq -- 'count=1'; then
    printf 'Expected one matching report for %s\n%s\n' "$report_id" "$rows" >&2
    return 1
  fi
  echo "Database contains exactly one report from the authenticated user martin" >&2
}

run_rpc_example "$example" "$@"
