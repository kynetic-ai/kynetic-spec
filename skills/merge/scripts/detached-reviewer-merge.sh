#!/usr/bin/env bash
# Detached Reviewer Merge Helper
#
# Merges the reviewed canonical branch into the integration target from a
# detached reviewer snapshot. This is the one supported merge path for
# reviewers in manual_merge publication mode.
#
# The helper performs the merge in a helper-owned temporary worktree that it
# creates and removes itself. It does NOT require the integration target
# branch to already be checked out anywhere; if the target IS checked out in
# a non-helper worktree, the helper refuses before moving any refs.
#
# Required dispatch environment variables:
#   KSPEC_DISPATCH_CANONICAL_BRANCH  — the task branch to merge
#   KSPEC_DISPATCH_MERGE_TARGET      — the integration branch name (e.g. "dev")
#   KSPEC_DISPATCH_CANONICAL_HEAD    — the reviewed commit SHA to merge (pinned at snapshot time)
#
# Exit codes:
#   0  — merge succeeded (or no-op: already integrated)
#   1  — error (missing env, occupied target, dirty target, conflict, etc.)

set -euo pipefail

# --- Environment contract ---------------------------------------------------

if [ -z "${KSPEC_DISPATCH_CANONICAL_BRANCH:-}" ]; then
  echo "error: KSPEC_DISPATCH_CANONICAL_BRANCH is not set." >&2
  echo "This script must be run from a dispatch reviewer invocation." >&2
  exit 1
fi

if [ -z "${KSPEC_DISPATCH_MERGE_TARGET:-}" ]; then
  echo "error: KSPEC_DISPATCH_MERGE_TARGET is not set." >&2
  echo "This script must be run from a dispatch reviewer invocation." >&2
  exit 1
fi

if [ -z "${KSPEC_DISPATCH_CANONICAL_HEAD:-}" ]; then
  echo "error: KSPEC_DISPATCH_CANONICAL_HEAD is not set." >&2
  echo "This script must be run from a dispatch reviewer invocation." >&2
  exit 1
fi

CANONICAL_BRANCH="$KSPEC_DISPATCH_CANONICAL_BRANCH"
MERGE_TARGET="$KSPEC_DISPATCH_MERGE_TARGET"
CANONICAL_HEAD="$KSPEC_DISPATCH_CANONICAL_HEAD"

# --- Verify the pinned canonical head ---------------------------------------

git cat-file -t "$CANONICAL_HEAD" >/dev/null 2>&1 || {
  echo "error: pinned canonical head '$CANONICAL_HEAD' does not exist in the repository." >&2
  exit 1
}

BRANCH_TIP=$(git rev-parse --verify "refs/heads/$CANONICAL_BRANCH" 2>/dev/null) || {
  echo "error: canonical branch '$CANONICAL_BRANCH' does not exist." >&2
  exit 1
}

if [ "$CANONICAL_HEAD" != "$BRANCH_TIP" ]; then
  echo "warning: canonical branch '$CANONICAL_BRANCH' has advanced past the reviewed commit." >&2
  echo "  reviewed commit: $CANONICAL_HEAD" >&2
  echo "  current tip:     $BRANCH_TIP" >&2
  echo "Merging the reviewed commit as pinned." >&2
fi

# --- Resolve the integration target ref -------------------------------------

TARGET_HEAD=$(git rev-parse --verify "refs/heads/$MERGE_TARGET" 2>/dev/null) || {
  echo "error: integration target branch '$MERGE_TARGET' does not exist." >&2
  exit 1
}

# --- No-op detection: is canonical already integrated? ----------------------
# Detect no-op before checking occupancy or creating any worktree state so the
# no-op path leaves no helper-owned worktree behind and does not dirty any
# pre-existing target checkout.

if git merge-base --is-ancestor "$CANONICAL_HEAD" "$TARGET_HEAD" 2>/dev/null; then
  echo "no-op: canonical branch '$CANONICAL_BRANCH' ($CANONICAL_HEAD) is already integrated at '$MERGE_TARGET' ($TARGET_HEAD)."
  exit 0
fi

# --- Detect whether the target branch is checked out in any other worktree --

OCCUPIED_WORKTREE=""
TARGET_REF="refs/heads/$MERGE_TARGET"
current_path=""
current_branch=""

while IFS= read -r line; do
  case "$line" in
    "worktree "*)
      current_path="${line#worktree }"
      current_branch=""
      ;;
    "branch "*)
      current_branch="${line#branch }"
      ;;
    "")
      if [ "$current_branch" = "$TARGET_REF" ] && [ -n "$current_path" ]; then
        OCCUPIED_WORKTREE="$current_path"
      fi
      current_path=""
      current_branch=""
      ;;
  esac
done < <(git worktree list --porcelain; echo "")

# Older git versions may omit the trailing blank line; handle the final block.
if [ -z "$OCCUPIED_WORKTREE" ] && [ "$current_branch" = "$TARGET_REF" ] && [ -n "$current_path" ]; then
  OCCUPIED_WORKTREE="$current_path"
fi

if [ -n "$OCCUPIED_WORKTREE" ]; then
  HAS_TRACKED_MODS=0
  HAS_STAGED_DRIFT=0
  DIRTY_DETAILS=""

  if ! git -C "$OCCUPIED_WORKTREE" diff --quiet 2>/dev/null; then
    HAS_TRACKED_MODS=1
    DIRTY_DETAILS+="Tracked modifications:"$'\n'
    DIRTY_DETAILS+="$(git -C "$OCCUPIED_WORKTREE" diff --name-status 2>/dev/null)"$'\n'
  fi

  if ! git -C "$OCCUPIED_WORKTREE" diff --cached --quiet 2>/dev/null; then
    HAS_STAGED_DRIFT=1
    DIRTY_DETAILS+="Staged drift:"$'\n'
    DIRTY_DETAILS+="$(git -C "$OCCUPIED_WORKTREE" diff --cached --name-status 2>/dev/null)"$'\n'
  fi

  if [ "$HAS_TRACKED_MODS" -eq 1 ] || [ "$HAS_STAGED_DRIFT" -eq 1 ]; then
    echo "error: integration target branch '$MERGE_TARGET' is checked out at '$OCCUPIED_WORKTREE' with uncommitted changes." >&2
    echo "" >&2
    echo "$DIRTY_DETAILS" >&2
    echo "The integration target ref has NOT been moved and the dirty pre-existing checkout was not overwritten." >&2
    echo "Recovery:" >&2
    echo "  1. Inspect the dirty pre-existing checkout at $OCCUPIED_WORKTREE." >&2
    echo "  2. Commit, stash, or discard the changes in that checkout." >&2
    echo "  3. Free the target branch by detaching that checkout" >&2
    echo "       (cd $OCCUPIED_WORKTREE && git checkout --detach)" >&2
    echo "     or removing that worktree" >&2
    echo "       (git worktree remove $OCCUPIED_WORKTREE)." >&2
    echo "  4. Re-run this merge helper from the detached reviewer snapshot." >&2
    exit 1
  fi

  echo "error: integration target branch '$MERGE_TARGET' is already checked out at '$OCCUPIED_WORKTREE'." >&2
  echo "" >&2
  echo "The merge helper performs the merge in a helper-owned temporary worktree" >&2
  echo "and requires exclusive ownership of the target branch. The integration target ref has NOT been moved." >&2
  echo "" >&2
  echo "Recovery: free the blocking checkout, then re-run this merge helper." >&2
  echo "  - Detach the existing checkout:" >&2
  echo "      cd $OCCUPIED_WORKTREE && git checkout --detach" >&2
  echo "  - Or remove the existing worktree:" >&2
  echo "      git worktree remove $OCCUPIED_WORKTREE" >&2
  exit 1
fi

# --- Create a helper-owned temporary target worktree ------------------------
# We perform the merge in this worktree and remove it in an EXIT trap so no
# auxiliary worktree remains checked out on the target branch on any path.

SCRATCH_DIR=$(mktemp -d "${TMPDIR:-/tmp}/kspec-merge-helper.XXXXXX")
TEMP_WORKTREE="$SCRATCH_DIR/target"

cleanup_temp_worktree() {
  if [ -n "${TEMP_WORKTREE:-}" ] && [ -e "$TEMP_WORKTREE" ]; then
    git -C "$TEMP_WORKTREE" merge --abort >/dev/null 2>&1 || true
    git worktree remove --force "$TEMP_WORKTREE" >/dev/null 2>&1 || true
  fi
  if [ -n "${SCRATCH_DIR:-}" ] && [ -d "$SCRATCH_DIR" ]; then
    rm -rf "$SCRATCH_DIR" 2>/dev/null || true
  fi
  git worktree prune >/dev/null 2>&1 || true
}
trap cleanup_temp_worktree EXIT

if ! WT_OUTPUT=$(git worktree add "$TEMP_WORKTREE" "$MERGE_TARGET" 2>&1); then
  echo "error: failed to create temporary target worktree for '$MERGE_TARGET'." >&2
  echo "$WT_OUTPUT" >&2
  echo "" >&2
  echo "The integration target ref has NOT been moved." >&2
  echo "If the target branch is checked out in another worktree, free that" >&2
  echo "checkout by detaching it (git -C <path> checkout --detach) or removing" >&2
  echo "the worktree (git worktree remove <path>), then re-run this merge helper." >&2
  exit 1
fi

# --- Perform the merge in the helper-owned temporary worktree ---------------

MERGE_MSG="Merge branch '$CANONICAL_BRANCH' into $MERGE_TARGET"

if ! MERGE_OUTPUT=$(git -C "$TEMP_WORKTREE" merge --no-ff "$CANONICAL_HEAD" -m "$MERGE_MSG" 2>&1); then
  if git -C "$TEMP_WORKTREE" diff --name-only --diff-filter=U 2>/dev/null | head -1 | grep -q .; then
    git -C "$TEMP_WORKTREE" merge --abort 2>/dev/null || true

    echo "error: merge conflict detected." >&2
    echo "" >&2
    echo "Conflicting output:" >&2
    echo "$MERGE_OUTPUT" >&2
    echo "" >&2
    echo "The integration target ref has NOT been advanced." >&2
    echo "The helper-owned temporary target worktree has been aborted and will be removed." >&2
    echo "" >&2
    echo "Next step:" >&2
    echo "  Move the task to needs_work with a note describing the conflicting files" >&2
    echo "  and what both sides changed. Do not attempt to resolve merge conflicts" >&2
    echo "  inside the detached snapshot." >&2
    exit 1
  else
    echo "error: merge failed." >&2
    echo "$MERGE_OUTPUT" >&2
    exit 1
  fi
fi

# --- Post-merge verification ------------------------------------------------

NEW_TARGET_HEAD=$(git -C "$TEMP_WORKTREE" rev-parse HEAD 2>/dev/null)

if [ "$NEW_TARGET_HEAD" = "$TARGET_HEAD" ]; then
  echo "warning: target ref did not advance after merge. This is unexpected." >&2
  exit 1
fi

POST_MERGE_STATUS=$(git -C "$TEMP_WORKTREE" status --porcelain 2>/dev/null)
if [ -n "$POST_MERGE_STATUS" ]; then
  echo "warning: temporary target worktree has unexpected dirty state after merge." >&2
  echo "$POST_MERGE_STATUS" >&2
fi

echo "success: merged '$CANONICAL_BRANCH' into '$MERGE_TARGET'."
echo "  previous target: $TARGET_HEAD"
echo "  new target:      $NEW_TARGET_HEAD"
# EXIT trap removes the helper-owned temporary target worktree.
