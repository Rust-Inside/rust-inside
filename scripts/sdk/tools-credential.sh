#!/usr/bin/env bash
set -euo pipefail

# Git calls this helper for HTTPS requests to the workflow's GitHub server.
# Other repositories and Cargo steps without the read token use their own credentials.
if [[ "$1" != get || -z "${RUST_INSIDE_TOOLS_TOKEN:-}" ]]; then exit 0; fi
shopt -s nocasematch
while IFS='=' read -r key value; do
  if [[ "$key" == path && ( "$value" == "$RUST_INSIDE_TOOLS_REPOSITORY" || "$value" == "$RUST_INSIDE_TOOLS_REPOSITORY.git" ) ]]; then
    printf 'username=x-access-token\npassword=%s\n' "$RUST_INSIDE_TOOLS_TOKEN"
    exit 0
  fi
done
