#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '::error::%s\n' "$1" >&2
  exit 1
}

validate_tag() {
  local identifier='(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)'
  local pattern="^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-${identifier}(\\.${identifier})*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$"
  [[ "$RELEASE_TAG" =~ $pattern ]] || fail "Release tag must use vX.Y.Z semantic-version grammar; got '$RELEASE_TAG'."
}

validate_versions() {
  local version="${RELEASE_TAG#v}"
  local package_version lock_version
  package_version="$(node -p "require('./package.json').version")"
  lock_version="$(node -p "require('./package-lock.json').version")"
  [[ "$package_version" == "$version" ]] || fail "package.json version '$package_version' does not match release tag '$RELEASE_TAG'."
  [[ "$lock_version" == "$version" ]] || fail "package-lock.json version '$lock_version' does not match release tag '$RELEASE_TAG'."
}

validate_manual_release() {
  [[ "$EVENT_NAME" == "workflow_dispatch" ]] || return 0
  local api_release_tag release_draft release_published_at
  IFS=$'\t' read -r api_release_tag release_draft release_published_at < <(
    gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}" \
      --jq '[.tag_name, (.draft | tostring), (.published_at // "")] | @tsv'
  )
  [[ "$api_release_tag" == "$RELEASE_TAG" && "$release_draft" == "false" && -n "$release_published_at" ]] ||
    fail "Manual recovery requires an existing published, non-draft GitHub release for '$RELEASE_TAG'."
}

resolve_remote_tag() {
  local listing direct='' peeled=''
  listing="$(git ls-remote --tags origin "refs/tags/${RELEASE_TAG}" "refs/tags/${RELEASE_TAG}^{}")"
  while IFS=$'\t' read -r object ref; do
    [[ -n "$object" ]] || continue
    if [[ "$ref" == "refs/tags/${RELEASE_TAG}^{}" ]]; then
      peeled="$object"
    elif [[ "$ref" == "refs/tags/${RELEASE_TAG}" ]]; then
      direct="$object"
    fi
  done <<< "$listing"
  [[ -n "$peeled" || -n "$direct" ]] || fail "Remote tag '$RELEASE_TAG' does not exist."
  printf '%s\n' "${peeled:-$direct}"
}

resolve_release() {
  local tag_commit authoritative head
  tag_commit="$(git rev-parse "refs/tags/${RELEASE_TAG}^{commit}")"
  if [[ "$EVENT_NAME" == "release" ]]; then
    [[ -n "${RELEASE_EVENT_COMMIT:-}" ]] || fail "Release event commit is missing."
    authoritative="$(git rev-parse "${RELEASE_EVENT_COMMIT}^{commit}")"
    [[ "$tag_commit" == "$authoritative" ]] || fail "Release tag '$RELEASE_TAG' does not resolve to release event commit '$authoritative'."
  elif [[ "$EVENT_NAME" == "workflow_dispatch" ]]; then
    authoritative="$tag_commit"
  else
    fail "Unsupported event '$EVENT_NAME'."
  fi
  head="$(git rev-parse HEAD)"
  [[ "$head" == "$authoritative" ]] || fail "Preflight checkout '$head' does not match authoritative commit '$authoritative'."
  validate_versions
  validate_manual_release
  {
    printf 'tag=%s\n' "$RELEASE_TAG"
    printf 'commit=%s\n' "$authoritative"
    printf 'version=%s\n' "${RELEASE_TAG#v}"
  } >> "$GITHUB_OUTPUT"
}

verify_release() {
  local head remote_commit
  [[ "${EXPECTED_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || fail "Expected authoritative commit must be a full lowercase SHA."
  head="$(git rev-parse HEAD)"
  [[ "$head" == "$EXPECTED_COMMIT" ]] || fail "Checked-out commit '$head' does not match authoritative commit '$EXPECTED_COMMIT'."
  remote_commit="$(resolve_remote_tag)"
  [[ "$remote_commit" == "$EXPECTED_COMMIT" ]] || fail "Remote tag '$RELEASE_TAG' no longer resolves to authoritative commit '$EXPECTED_COMMIT' (now '$remote_commit')."
  validate_versions
}

[[ $# -eq 1 ]] || fail "Usage: validate-release.sh resolve|verify"
validate_tag
case "$1" in
  resolve) resolve_release ;;
  verify) verify_release ;;
  *) fail "Usage: validate-release.sh resolve|verify" ;;
esac
