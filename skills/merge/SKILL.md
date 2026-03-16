# Merge

Merge approved work into an integration branch. Local-first — uses git merge directly, with merge gates based on kspec review disposition.

## When to Use

- After work has been reviewed and approved via `{skill:review}`
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

## Merge Process

### 1. Verify Branch State

```bash
# Confirm current branch
git branch --show-current

# Ensure branch is up to date with target
git fetch origin
git log --oneline origin/dev..HEAD  # What will be merged
```

### 2. Merge to Integration Branch

```bash
# Switch to target branch
git checkout dev

# Merge with merge commit (preserves trailers)
git merge --no-ff <task-branch>

# Verify merge succeeded
git log --oneline -3
```

**Use merge commits, not squash.** Merge commits preserve individual commit messages with their `Task:` and `Spec:` trailers, enabling `kspec log @ref` to find related commits.

### 3. Handle Conflicts

If a merge conflict occurs:

**Assess the conflict:**
- Is it a simple textual conflict (parallel edits to the same lines)?
- Or a semantic conflict (incompatible changes to behavior)?

**For simple conflicts:**
```bash
# View conflicting files
git diff --name-only --diff-filter=U

# Resolve conflicts in each file
# Then mark resolved
git add <resolved-files>
git commit  # Completes the merge
```

**For complex/semantic conflicts:**
- Do not force-merge
- Escalate: `kspec inbox add "Merge conflict between @task-a and @task-b — needs human review"`
- Or block the task: `kspec task block @ref --reason "Merge conflict with ..."`

### 4. Complete the Task

After successful merge:

```bash
kspec task complete @ref --reason "Merged to dev. Summary of what was done."
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

- **`{skill:task-work}`** — Work lifecycle leads to merge after review
- **`{skill:review}`** — Review disposition gates the merge
- **`kspec task complete`** — Final step after merge
