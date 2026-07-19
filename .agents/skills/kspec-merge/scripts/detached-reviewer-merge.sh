#!/usr/bin/env bash
# Detached Reviewer Merge Helper
#
# Merges the reviewed canonical branch into the integration target from a
# detached reviewer snapshot. This is the one supported merge path for
# reviewers in manual_merge publication mode.
#
# Branch-coherent merge surface selection:
#   - target free (not checked out in any worktree)
#       → create a helper-owned temporary target worktree, merge there, remove it
#   - target checked out in exactly one eligible clean non-auxiliary worktree
#       → merge through that existing checkout so Git advances the branch, index,
#         and working tree together (checkout-aware merge)
#   - target checked out in a dispatch auxiliary worktree (worker, reviewer,
#     helper, plan-scoped, detached-reviewer snapshot)
#       → refuse before moving refs; identify the blocker; recommend cleanup
#   - target checked out with tracked mods / staged drift / in-progress git
#     operation / untracked-overwrite hazard
#       → refuse before moving refs; identify the blocker; recommend cleanup
#   - target checked out in more than one eligible worktree
#       → refuse before moving refs; identify the ambiguity
#
# Required dispatch environment variables:
#   KSPEC_DISPATCH_CANONICAL_BRANCH  — the task branch to merge
#   KSPEC_DISPATCH_MERGE_TARGET      — the integration branch name (e.g. "dev")
#   KSPEC_DISPATCH_CANONICAL_HEAD    — the reviewed commit SHA to merge (pinned at snapshot time)
#
# Optional dispatch environment variables:
#   KSPEC_DISPATCH_WORKTREE_ROOT     — absolute path to the dispatch worktree root
#                                      (any worktree at or under this path is
#                                      treated as auxiliary even without the
#                                      .kspec-dispatch-workspace.json marker)
#
# Exit codes:
#   0  — merge succeeded (or no-op: already integrated)
#   1  — error (missing env, dirty/auxiliary/ambiguous target checkout,
#               conflict, missing refs, etc.)

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
WORKTREE_ROOT="${KSPEC_DISPATCH_WORKTREE_ROOT:-}"

DISPATCH_WORKSPACE_METADATA_FILE=".kspec-dispatch-workspace.json"

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
# Detect no-op before classifying occupancy or creating any worktree state so
# the no-op path leaves no helper-owned worktree behind and does not dirty any
# pre-existing target checkout.

if git merge-base --is-ancestor "$CANONICAL_HEAD" "$TARGET_HEAD" 2>/dev/null; then
  echo "no-op: canonical branch '$CANONICAL_BRANCH' ($CANONICAL_HEAD) is already integrated at '$MERGE_TARGET' ($TARGET_HEAD)."
  exit 0
fi

# --- Helper: resolve an absolute, symlink-resolved version of a path --------

normalize_path() {
  local p="$1"
  if [ -d "$p" ]; then
    (cd "$p" && pwd -P)
  elif [ -e "$p" ]; then
    local parent
    parent=$(dirname "$p")
    if [ -d "$parent" ]; then
      printf '%s/%s\n' "$(cd "$parent" && pwd -P)" "$(basename "$p")"
    else
      printf '%s\n' "$p"
    fi
  else
    printf '%s\n' "$p"
  fi
}

is_path_inside() {
  local parent="$1"
  local candidate="$2"
  parent=$(normalize_path "$parent")
  candidate=$(normalize_path "$candidate")
  [ -n "$parent" ] || return 1
  case "$candidate" in
    "$parent") return 0 ;;
    "$parent"/*) return 0 ;;
  esac
  return 1
}

# --- Helper: resolve a git-operation marker path for a worktree -------------
# `git -C "$wt" rev-parse --git-path <marker>` reports the path relative to the
# worktree it was queried in (its -C directory). For a PRIMARY repository
# worktree git returns a worktree-relative path such as ".git/MERGE_HEAD";
# for a LINKED worktree it returns an absolute path under the common git dir
# (e.g. "/repo/.git/worktrees/<name>/MERGE_HEAD"). The helper process cwd is the
# detached reviewer snapshot, not "$wt", so testing the raw relative result with
# `[ -e ... ]` would probe the wrong filesystem location and silently miss an
# in-progress operation (or a lingering MERGE_HEAD) in a primary target
# checkout. Anchor relative results under "$wt"; preserve absolute results.
resolve_worktree_git_path() {
  local wt="$1"
  local raw="$2"
  [ -n "$raw" ] || return 1
  case "$raw" in
    /*) printf '%s\n' "$raw" ;;
    *) printf '%s/%s\n' "$wt" "$raw" ;;
  esac
}

# Resolve the filesystem path of a git operation marker inside "$wt", or print
# nothing when rev-parse fails or yields no path. The result is safe to test
# with `[ -e ... ]` from any cwd.
worktree_marker_path() {
  local wt="$1"
  local marker="$2"
  local raw
  raw=$(git -C "$wt" rev-parse --git-path "$marker" 2>/dev/null) || return 0
  [ -n "$raw" ] || return 0
  resolve_worktree_git_path "$wt" "$raw"
}

NORMALIZED_WORKTREE_ROOT=""
if [ -n "$WORKTREE_ROOT" ]; then
  NORMALIZED_WORKTREE_ROOT=$(normalize_path "$WORKTREE_ROOT")
fi

# --- Detect whether the target branch is checked out in any worktree --------
# Build a list of worktree paths that hold refs/heads/$MERGE_TARGET. Older git
# versions may not emit a trailing blank line so the loop appends an explicit
# sentinel to ensure the final block is flushed.

OCCUPIED_WORKTREES=()
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
        OCCUPIED_WORKTREES+=("$current_path")
      fi
      current_path=""
      current_branch=""
      ;;
  esac
done < <(git worktree list --porcelain; echo "")

if [ "$current_branch" = "$TARGET_REF" ] && [ -n "$current_path" ]; then
  # Avoid duplicate if the final block was already flushed by the blank line.
  add_final=1
  for existing in "${OCCUPIED_WORKTREES[@]+"${OCCUPIED_WORKTREES[@]}"}"; do
    if [ "$existing" = "$current_path" ]; then
      add_final=0
      break
    fi
  done
  if [ "$add_final" -eq 1 ]; then
    OCCUPIED_WORKTREES+=("$current_path")
  fi
fi

# --- Classify each occupied worktree ----------------------------------------
# Categories:
#   auxiliary  — dispatch-created or under the configured worktree root
#   in_progress — has MERGE_HEAD/REBASE/CHERRY_PICK/REVERT/BISECT marker
#   dirty      — tracked mods or staged drift
#   eligible   — clean, pre-existing non-auxiliary checkout

ELIGIBLE_WORKTREES=()
AUXILIARY_WORKTREES=()
DIRTY_WORKTREES=()
DIRTY_DETAILS=()
IN_PROGRESS_WORKTREES=()
IN_PROGRESS_LABELS=()

classify_worktree() {
  local wt="$1"

  # Auxiliary by path (configured worktree root)
  if [ -n "$NORMALIZED_WORKTREE_ROOT" ] && is_path_inside "$NORMALIZED_WORKTREE_ROOT" "$wt"; then
    AUXILIARY_WORKTREES+=("$wt")
    return
  fi

  # Auxiliary by marker file
  if [ -f "$wt/$DISPATCH_WORKSPACE_METADATA_FILE" ]; then
    AUXILIARY_WORKTREES+=("$wt")
    return
  fi

  # In-progress git operation detection: ask git for the resolved per-worktree
  # path of each marker rather than guessing .git layout (which differs between
  # primary worktrees and linked worktrees).
  local marker
  for marker in MERGE_HEAD REBASE_HEAD rebase-apply rebase-merge CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
    local marker_path
    marker_path=$(worktree_marker_path "$wt" "$marker")
    if [ -n "$marker_path" ] && [ -e "$marker_path" ]; then
      local label
      case "$marker" in
        MERGE_HEAD) label="merge" ;;
        REBASE_HEAD|rebase-apply|rebase-merge) label="rebase" ;;
        CHERRY_PICK_HEAD) label="cherry-pick" ;;
        REVERT_HEAD) label="revert" ;;
        BISECT_LOG) label="bisect" ;;
        *) label="$marker" ;;
      esac
      IN_PROGRESS_WORKTREES+=("$wt")
      IN_PROGRESS_LABELS+=("$label")
      return
    fi
  done

  # Tracked modifications
  if ! git -C "$wt" diff --quiet 2>/dev/null; then
    DIRTY_WORKTREES+=("$wt")
    DIRTY_DETAILS+=("tracked modifications")
    return
  fi

  # Staged drift
  if ! git -C "$wt" diff --cached --quiet 2>/dev/null; then
    DIRTY_WORKTREES+=("$wt")
    DIRTY_DETAILS+=("staged drift")
    return
  fi

  ELIGIBLE_WORKTREES+=("$wt")
}

for wt in "${OCCUPIED_WORKTREES[@]+"${OCCUPIED_WORKTREES[@]}"}"; do
  classify_worktree "$wt"
done

print_recovery_hint_release_blocker() {
  local wt="$1"
  echo "  Recovery:" >&2
  echo "    - Inspect the unsafe checkout at $wt." >&2
  echo "    - Commit, stash, or discard tracked/staged changes there." >&2
  echo "    - Finish or abort any in-progress merge/rebase/cherry-pick/revert/bisect there." >&2
  echo "    - Or detach that checkout" >&2
  echo "        cd $wt && git checkout --detach" >&2
  echo "      or remove the worktree" >&2
  echo "        git worktree remove $wt" >&2
  echo "    - Re-run this merge helper from the detached reviewer snapshot." >&2
}

# Auxiliary occupancy → refuse before any ref movement.
if [ "${#AUXILIARY_WORKTREES[@]}" -gt 0 ]; then
  blocker="${AUXILIARY_WORKTREES[0]}"
  echo "error: integration target branch '$MERGE_TARGET' is checked out in dispatch auxiliary worktree '$blocker'." >&2
  echo "" >&2
  echo "Auxiliary worktrees (worker, reviewer, helper, plan-scoped, detached-reviewer snapshots)" >&2
  echo "are not valid merge surfaces. The integration target ref has NOT been moved." >&2
  echo "" >&2
  echo "Recovery: clean up the auxiliary checkout, then re-run this merge helper." >&2
  echo "  - Remove the auxiliary worktree:" >&2
  echo "      git worktree remove --force $blocker" >&2
  echo "  - Or detach the existing checkout:" >&2
  echo "      cd $blocker && git checkout --detach" >&2
  exit 1
fi

# In-progress git operation → refuse before any ref movement.
if [ "${#IN_PROGRESS_WORKTREES[@]}" -gt 0 ]; then
  blocker="${IN_PROGRESS_WORKTREES[0]}"
  label="${IN_PROGRESS_LABELS[0]}"
  echo "error: integration target branch '$MERGE_TARGET' is checked out at '$blocker' with an in-progress $label operation." >&2
  echo "" >&2
  echo "The integration target ref has NOT been moved." >&2
  print_recovery_hint_release_blocker "$blocker"
  exit 1
fi

# Tracked modifications or staged drift → refuse before any ref movement.
if [ "${#DIRTY_WORKTREES[@]}" -gt 0 ]; then
  blocker="${DIRTY_WORKTREES[0]}"
  details="${DIRTY_DETAILS[0]}"
  echo "error: integration target branch '$MERGE_TARGET' is checked out at '$blocker' with uncommitted changes ($details)." >&2
  echo "" >&2
  echo "The integration target ref has NOT been moved and the dirty pre-existing checkout was not overwritten." >&2
  print_recovery_hint_release_blocker "$blocker"
  exit 1
fi

# Ambiguous: more than one eligible occupied checkout → refuse before any ref movement.
if [ "${#ELIGIBLE_WORKTREES[@]}" -gt 1 ]; then
  echo "error: integration target branch '$MERGE_TARGET' is checked out in multiple eligible worktrees:" >&2
  for w in "${ELIGIBLE_WORKTREES[@]}"; do
    echo "  - $w" >&2
  done
  echo "" >&2
  echo "The integration target ref has NOT been moved." >&2
  echo "Recovery: detach or remove all but one of the eligible target checkouts, then re-run this merge helper." >&2
  exit 1
fi

# --- Helper: verify an aborted merge restored a pre-existing checkout -------
# After aborting a failed merge in an existing (pre-existing, non-helper-owned)
# target checkout, confirm the abort fully restored the pre-merge state. If any
# check fails, emit a severe cleanup-failed error naming the checkout so the
# operator knows dispatch may need manual repair. Returns nonzero when cleanup
# could not be verified.
verify_existing_checkout_cleanup() {
  local surface="$1"
  local pre_head="$2"
  local problems=()

  if [ -n "$pre_head" ]; then
    local now_head
    now_head=$(git -C "$surface" rev-parse HEAD 2>/dev/null || echo "")
    if [ "$now_head" != "$pre_head" ]; then
      problems+=("HEAD is now '$now_head' but the pre-merge target tip was '$pre_head'")
    fi
  fi

  local tracked_status
  tracked_status=$(git -C "$surface" status --porcelain --untracked-files=no 2>/dev/null || echo "")
  if [ -n "$tracked_status" ]; then
    problems+=("tracked working tree is not clean after abort")
  fi

  local mh
  mh=$(worktree_marker_path "$surface" MERGE_HEAD)
  if [ -n "$mh" ] && [ -e "$mh" ]; then
    problems+=("MERGE_HEAD is still present — the merge was not fully aborted")
  fi

  if [ "${#problems[@]}" -gt 0 ]; then
    echo "" >&2
    echo "SEVERE: failed to restore the pre-existing integration target checkout after aborting the merge." >&2
    echo "  target checkout: $surface" >&2
    local p
    for p in "${problems[@]}"; do
      echo "    - $p" >&2
    done
    echo "" >&2
    echo "This checkout may be left in a partially-merged state. The integration target ref" >&2
    echo "was NOT advanced, but dispatch may need MANUAL repair of this checkout before further" >&2
    echo "merge attempts. Inspect '$surface' and restore it to '$pre_head' before retrying." >&2
    return 1
  fi
  return 0
}

cleanup_scratch_dir_only() {
  if [ -n "${SCRATCH_DIR:-}" ] && [ -d "$SCRATCH_DIR" ]; then
    rm -rf "$SCRATCH_DIR" 2>/dev/null || true
  fi
}

cleanup_temp_worktree() {
  if [ -n "${TEMP_WORKTREE:-}" ] && [ -e "$TEMP_WORKTREE" ]; then
    git -C "$TEMP_WORKTREE" merge --abort >/dev/null 2>&1 || true
    git worktree remove --force "$TEMP_WORKTREE" >/dev/null 2>&1 || true
  fi
  cleanup_scratch_dir_only
  git worktree prune >/dev/null 2>&1 || true
}

# --- Select the merge surface and perform the merge -------------------------
# Two paths from here:
#   (a) Exactly one eligible occupied checkout → merge through that worktree.
#   (b) No occupied worktree → create a helper-owned temporary worktree.

MERGE_MSG="Merge branch '$CANONICAL_BRANCH' into $MERGE_TARGET"
MERGE_SURFACE=""
MERGE_SURFACE_KIND=""
SCRATCH_DIR=""
TEMP_WORKTREE=""
PRE_MERGE_TARGET_HEAD=""

if [ "${#ELIGIBLE_WORKTREES[@]}" -eq 1 ]; then
  MERGE_SURFACE="${ELIGIBLE_WORKTREES[0]}"
  MERGE_SURFACE_KIND="existing"
  PRE_MERGE_TARGET_HEAD=$(git -C "$MERGE_SURFACE" rev-parse HEAD 2>/dev/null || echo "")
else
  SCRATCH_DIR=$(mktemp -d "${TMPDIR:-/tmp}/kspec-merge-helper.XXXXXX")
  TEMP_WORKTREE="$SCRATCH_DIR/target"
  trap cleanup_temp_worktree EXIT
  if ! WT_OUTPUT=$(git worktree add "$TEMP_WORKTREE" "$MERGE_TARGET" 2>&1); then
    echo "error: failed to create temporary target worktree for '$MERGE_TARGET'." >&2
    echo "$WT_OUTPUT" >&2
    echo "" >&2
    echo "The integration target ref has NOT been moved." >&2
    exit 1
  fi
  MERGE_SURFACE="$TEMP_WORKTREE"
  MERGE_SURFACE_KIND="temporary"
fi

# --- Perform the merge in the selected surface ------------------------------

if ! MERGE_OUTPUT=$(git -C "$MERGE_SURFACE" merge --no-ff "$CANONICAL_HEAD" -m "$MERGE_MSG" 2>&1); then
  # Untracked/ignored overwrite hazard: git refuses to start the merge and
  # leaves the working tree, index, and HEAD untouched. Distinguish this from
  # a started-then-conflicted merge by inspecting MERGE_HEAD. Resolve the marker
  # path through the worktree-aware helper so a primary target checkout (which
  # reports ".git/MERGE_HEAD" relative to the checkout, not the helper cwd) is
  # detected correctly.
  MERGE_HEAD_PATH=$(worktree_marker_path "$MERGE_SURFACE" MERGE_HEAD)
  MERGE_STARTED=0
  HAS_CONFLICTS=0
  if [ -n "$MERGE_HEAD_PATH" ] && [ -e "$MERGE_HEAD_PATH" ]; then
    MERGE_STARTED=1
    # Capture conflict state before aborting — the abort clears the unmerged
    # index entries we are inspecting here.
    if git -C "$MERGE_SURFACE" diff --name-only --diff-filter=U 2>/dev/null | head -1 | grep -q .; then
      HAS_CONFLICTS=1
    fi
    # On any nonzero merge attempt after a merge has started, abort before
    # returning failure — unconditionally, regardless of how the failure is
    # later classified — so no surface is left mid-merge.
    git -C "$MERGE_SURFACE" merge --abort 2>/dev/null || true
  fi

  if [ "$MERGE_STARTED" -eq 1 ] && [ "$HAS_CONFLICTS" -eq 1 ]; then
    # After aborting in a pre-existing checkout, verify the abort restored the
    # pre-merge state. A failed restoration is a severe condition that must be
    # surfaced loudly rather than masked by the generic conflict guidance.
    if [ "$MERGE_SURFACE_KIND" = "existing" ]; then
      if ! verify_existing_checkout_cleanup "$MERGE_SURFACE" "$PRE_MERGE_TARGET_HEAD"; then
        exit 1
      fi
    fi
    echo "error: merge conflict detected." >&2
    echo "" >&2
    echo "Conflicting output:" >&2
    echo "$MERGE_OUTPUT" >&2
    echo "" >&2
    echo "The integration target ref has NOT been advanced." >&2
    if [ "$MERGE_SURFACE_KIND" = "temporary" ]; then
      echo "The helper-owned temporary target worktree has been aborted and will be removed." >&2
    else
      echo "The merge has been aborted in '$MERGE_SURFACE' and that worktree is restored to its pre-merge target tip." >&2
    fi
    echo "" >&2
    echo "Next step:" >&2
    echo "  Move the task to needs_work with a note describing the conflicting files" >&2
    echo "  and what both sides changed. Do not attempt to resolve merge conflicts" >&2
    echo "  inside the detached snapshot." >&2
    exit 1
  fi

  # Recognize the untracked-overwrite case and report it as such. Git emits
  # two different error shapes depending on whether the collision is a file
  # vs file ("would be overwritten by merge") or a file vs directory
  # ("would lose untracked files in them"). Both mean the same thing: the
  # merge would have clobbered untracked content in the occupied checkout.
  if printf '%s\n' "$MERGE_OUTPUT" | grep -q -i -e "would be overwritten by merge" -e "would lose untracked files"; then
    echo "error: integration target branch '$MERGE_TARGET' is checked out at '$MERGE_SURFACE' and the required merge would overwrite untracked/ignored files in that checkout." >&2
    echo "" >&2
    echo "$MERGE_OUTPUT" >&2
    echo "" >&2
    echo "The integration target ref has NOT been moved and the unsafe checkout was not overwritten." >&2
    print_recovery_hint_release_blocker "$MERGE_SURFACE"
    exit 1
  fi

  echo "error: merge failed." >&2
  echo "$MERGE_OUTPUT" >&2
  exit 1
fi

# --- Post-merge verification ------------------------------------------------

NEW_TARGET_HEAD=$(git -C "$MERGE_SURFACE" rev-parse HEAD 2>/dev/null)

if [ "$NEW_TARGET_HEAD" = "$TARGET_HEAD" ]; then
  echo "warning: target ref did not advance after merge. This is unexpected." >&2
  exit 1
fi

POST_MERGE_STATUS=$(git -C "$MERGE_SURFACE" status --porcelain --untracked-files=no 2>/dev/null)
if [ -n "$POST_MERGE_STATUS" ]; then
  echo "warning: target worktree has unexpected dirty tracked state after merge." >&2
  echo "$POST_MERGE_STATUS" >&2
fi

echo "success: merged '$CANONICAL_BRANCH' into '$MERGE_TARGET'."
echo "  previous target: $TARGET_HEAD"
echo "  new target:      $NEW_TARGET_HEAD"
if [ "$MERGE_SURFACE_KIND" = "existing" ]; then
  echo "  merged through pre-existing target checkout: $MERGE_SURFACE"
fi
# EXIT trap removes the helper-owned temporary target worktree (when used).
