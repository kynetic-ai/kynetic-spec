---
name: kspec-merge
description: Merge approved work into an integration branch. Local-first git
  merge with gates based on kspec review disposition — approved status, passing
  checks, and resolved blocker threads.
---
<!-- kspec-managed -->
# Merge

Merge approved work into an integration branch. Local-first — uses git merge directly, with merge gates based on kspec review disposition.

## When to Use

- After work has been reviewed and approved via `/kspec-review`
- Merging a task branch into a dev or integration branch
- Completing the work lifecycle after review approval

**Not for:** Creating pull requests to remote repositories (that's a human-directed activity for feature-level merges into main).

## Merge Gate

Before merging, verify all gates pass:

```bash
# 1. Check review disposition
kspec review for-task @ref
kspec review get @review-ref
# Disposition must be "approved"

# 2. Required checks passing
# Review checks should show all required checks as "pass"

# 3. No unresolved blocker threads
# Review should have no open blocker threads
```

**All three must be satisfied:**

- Review disposition = `approved`
- All required checks passing (not stale)
- No unresolved blocker threads

If any gate fails, do not merge. Address the issue first:

- `changes_requested` → worker fixes issues, resubmits
- Required check failing → fix and re-run
- Unresolved blocker → resolve the thread or fix the issue

## Determining the Integration Branch

The merge target depends on context:

- **Dispatch mode** — The integration branch is provided in the dispatch prompt context (the `Integration target:` line) and via the `KSPEC_DISPATCH_MERGE_TARGET` environment variable. **Use the dispatch-provided target verbatim — never assume a branch name.**
- **Manual mode** — The integration branch is typically `dev`, but check your project's branching convention or ask if unsure.

In the examples below, `<integration-branch>` is a placeholder for the actual target branch.

## Detached Reviewer Context

In `manual_merge` publication mode, reviewers work from a **detached snapshot** of the task branch — you are NOT on the integration branch, and you must not check it out inside the detached snapshot as a recovery step.

**Use the supported merge helper.** It is the one supported merge path in this mode. Do not improvise git merge commands in the detached snapshot:

```bash
bash .factory/skills/kspec-merge/scripts/detached-reviewer-merge.sh
```

The helper reads the dispatch environment variables (`KSPEC_DISPATCH_CANONICAL_BRANCH`, `KSPEC_DISPATCH_MERGE_TARGET`, `KSPEC_DISPATCH_CANONICAL_HEAD`) and selects a branch-coherent merge surface:

- If the integration target is **not checked out anywhere**, the helper creates a helper-owned temporary worktree on the target branch, performs the merge there, and removes that temporary worktree before exiting.
- If the integration target is checked out in **exactly one clean, non-auxiliary project/user checkout** (for example the project root already has `main` or `dev` checked out), the helper performs the merge through that existing checkout so Git advances the branch, index, and working tree together.
- If the integration target is checked out in an unsafe location or state, the helper refuses before moving refs and prints recovery guidance naming the blocker.

The helper never asks the reviewer to check out the integration target inside the detached snapshot, and it must not leave a new persistent target-branch worktree behind.

### Helper Outcomes

| Outcome                            | What happens                                                                                                                                      | What to do next                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Success: target free**           | Helper creates a temporary target worktree, merges there, advances the integration target, and removes the temporary worktree                     | `kspec task complete @ref`, `kspec review close @review-ref`                                             |
| **Success: clean occupied target** | Helper merges through the existing clean non-auxiliary target checkout; that checkout remains on the target branch, coherent at the new merge tip | `kspec task complete @ref`, `kspec review close @review-ref`                                             |
| **No-op**                          | Canonical branch already integrated at target tip — no ref move, no helper worktree created, no existing checkout dirtied                         | Report no-op, complete the task                                                                          |
| **Unsafe occupied target**         | Target branch is checked out in an auxiliary, dirty/staged, in-progress, ambiguous, or untracked-overwrite-hazard checkout; helper refuses        | Follow the recovery guidance the helper prints to free, clean, detach, or remove the blocker, then retry |
| **Conflict**                       | Merge conflicts in the selected merge surface — helper aborts; temporary worktrees are removed and existing target checkouts are restored         | Move task to `needs_work` with conflict details — do not attempt manual resolution in the snapshot       |

### What NOT to Do in a Detached Snapshot

- Do **not** run `git checkout <integration-branch>` in the detached reviewer snapshot — the helper selects the safe merge surface for you
- Do **not** create an auxiliary worktree on the integration target to "free" or "stage" anything — that recreates the branch lock the helper is designed to avoid
- Do **not** run `git merge` manually — the helper handles merge mechanics, merge-surface selection, temporary-worktree lifecycle, and conflict cleanup
- Do **not** attempt to resolve merge conflicts inside the detached snapshot — send the task back to the worker via `needs_work`

## Merge Process (Non-Dispatch)

The following steps apply when merging **outside** dispatch mode (e.g., manual human-directed merges). In dispatch mode, use the detached reviewer merge helper above instead.

### 1. Verify Branch State

```bash
# Confirm current branch
git branch --show-current

# Ensure branch is up to date with target
git fetch origin
git log --oneline origin/<integration-branch>..HEAD  # What will be merged
```

### 2. Merge to Integration Branch

```bash
# Switch to target branch
git checkout <integration-branch>

# Merge with merge commit (preserves trailers)
git merge --no-ff <task-branch>

# Verify merge succeeded
git log --oneline -3
```

**Use merge commits, not squash.** Merge commits preserve individual commit messages with their `Task:` and `Spec:` trailers, enabling `kspec log @ref` to find related commits.

### 3. Handle Conflicts

If a merge conflict occurs:

**Assess the conflict:**

- Is it a simple textual conflict (parallel additive edits to the same region)?
- Or a semantic conflict (incompatible behavioral changes)?

**For simple/textual conflicts — resolve them:**

```bash
# View conflicting files
git diff --name-only --diff-filter=U

# Resolve conflicts in each file (include both sides for additive changes)
# Then mark resolved
git add <resolved-files>
git commit  # Completes the merge
```

Resolving straightforward textual conflicts is merge mechanics, not code authoring. Reviewers and workers should both handle these directly.

**For complex/semantic conflicts (reviewer):**

- Do not force-merge
- Abort the merge: `git merge --abort`
- Submit a **MUST-FIX** review finding describing the conflict: which files, what both sides changed, and why it's unclear how to resolve
- This sends the task back to the worker via `needs_work`, who has better context to resolve

**For complex/semantic conflicts (worker receiving needs_work):**

- Attempt best-effort non-destructive resolution using the reviewer's conflict description
- If genuinely uncertain about the correct resolution, block: `kspec task block @ref --reason "Merge conflict with ... — requires human judgment because ..."`

### 4. Complete the Task

After successful merge:

```bash
kspec task complete @ref --reason "Merged to <integration-branch>. Summary of what was done."
```

### 5. Close the Review

```bash
kspec review close @review-ref
```

## Post-Merge Cleanup

```bash
# Delete the task branch locally
git branch -d <task-branch>

# Optionally delete remote branch
git push origin --delete <task-branch>
```

## Integration

- **`/kspec-task-work`** — Work lifecycle leads to merge after review
- **`/kspec-review`** — Review disposition gates the merge
- **`kspec task complete`** — Final step after merge
