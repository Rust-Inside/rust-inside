#!/usr/bin/env bash
set -euo pipefail

package="$(cd "${1:?Pass the built Swift package directory}" && pwd)"
tag="${2:?Pass the version tag}"
source_repo="${3:?Pass the source GitHub repository as owner/name}"
revision="${4:?Pass the full source commit SHA}"
remote="${5:?Pass the destination SDK Git remote}"
scripts="$(cd "$(dirname "$0")" && pwd)"
workflow="$scripts/package-templates/swift-release/publish-ios-release.yml"

if ! [[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ && "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected a vX.Y.Z tag and a full core commit SHA" >&2
  exit 1
fi
if ! [[ "$source_repo" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$ ]]; then
  echo "Expected the core repository as owner/name" >&2
  exit 1
fi

shopt -s nullglob
modules=("$package"/Sources/*/)
frameworks=("$package"/*.xcframework)
if [[ ${#modules[@]} != 1 || ${#frameworks[@]} != 1 ]]; then
  echo "Expected one Swift module and one XCFramework in the built package" >&2
  exit 1
fi
module="$(basename "${modules[0]}")"
framework="$(basename "${frameworks[0]}")"
if ! [[ "$module" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "$framework" =~ ^[A-Za-z_][A-Za-z0-9_]*\.xcframework$ ]]; then
  echo "Invalid Swift module or XCFramework name" >&2
  exit 1
fi
required=(Package.swift "Sources/$module/$module.swift" "$framework/Info.plist")
for entry in "${required[@]}"; do
  [[ -s "$package/$entry" ]] || { echo "Missing package file: $entry" >&2; exit 1; }
done

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
git init --quiet "$scratch/sdk"
sdk=(git -C "$scratch/sdk")
"${sdk[@]}" remote add origin "$remote"
printf 'source=%s\ntag=%s\ncommit=%s\n' "$source_repo" "$tag" "$revision" > "$scratch/provenance"

# Runners can produce different binary bytes from the same source. The published
# tag owns this version. Confirm its provenance and package identity before reuse.
verify_existing() {
  "${sdk[@]}" fetch --quiet --no-tags origin "refs/tags/$tag" || return 1
  "${sdk[@]}" show FETCH_HEAD:SDK-PROVENANCE > "$scratch/existing" || return 1
  if ! cmp -s "$scratch/provenance" "$scratch/existing"; then
    echo "The existing $tag tag belongs to a different core build" >&2
    return 1
  fi
  for entry in "${required[@]}"; do
    if ! "${sdk[@]}" cat-file -e "FETCH_HEAD:$entry"; then
      echo "The existing $tag tag does not contain the expected package file $entry" >&2
      return 1
    fi
  done
  echo "Verified existing $tag for $source_repo@$revision"
}

published="$("${sdk[@]}" ls-remote --refs origin "refs/tags/$tag")"
if [[ -n "$published" ]]; then
  verify_existing
  exit 0
fi

commit_as_bot=(-c user.name='Rust Inside' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' -c commit.gpgSign=false)
# Give a completely empty SDK repository its first branch before pushing a tag.
# A separate push lets GitHub register the release workflow. Existing destination
# branches always belong to the SDK maintainer.
remote_refs="$("${sdk[@]}" ls-remote --refs origin)"
if [[ -z "$remote_refs" ]]; then
  git init --quiet "$scratch/landing"
  mkdir -p "$scratch/landing/.github/workflows"
  cp "$workflow" "$scratch/landing/.github/workflows/"
  printf '# %s\n\nSelect a version tag to install this Swift package. The Releases page contains the XCFramework archives.\n' "$module" > "$scratch/landing/README.md"
  landing=(git -C "$scratch/landing")
  "${landing[@]}" add -- README.md .github/workflows/publish-ios-release.yml
  "${landing[@]}" "${commit_as_bot[@]}" commit --quiet -m "Set up Swift package releases"
  if ! "${landing[@]}" push "$remote" HEAD:refs/heads/main; then
    # Concurrent first releases may race to create the landing branch.
    "${sdk[@]}" ls-remote --exit-code --heads origin refs/heads/main > /dev/null
  fi
fi

cp -R "$package/Package.swift" "$package/Sources" "$package/$framework" "$scratch/sdk/"
cp "$scratch/provenance" "$scratch/sdk/SDK-PROVENANCE"
mkdir -p "$scratch/sdk/.github/workflows"
cp "$workflow" "$scratch/sdk/.github/workflows/"
"${sdk[@]}" add -f -- Package.swift Sources "$framework" SDK-PROVENANCE .github/workflows/publish-ios-release.yml
"${sdk[@]}" "${commit_as_bot[@]}" commit --quiet -m "$module $tag" -m "Core: $source_repo@$revision"
# A concurrent publisher can win the race. Reuse only its matching, immutable tag.
if ! "${sdk[@]}" push origin "HEAD:refs/tags/$tag"; then
  verify_existing
fi
