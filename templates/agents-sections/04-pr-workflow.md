## PR Workflow

Before creating a PR, mark the task: `kspec task submit @ref` (transitions to `pending_review`).

The full PR lifecycle has three steps — **all required, in order:**

1. **`/local-review`** — Quality gates: AC coverage, test quality, test isolation. Run this FIRST.
2. **`/pr`** — Create the pull request.
3. **`/pr-review`** — Review and merge. Or `kspec workflow start @pr-review-merge`.

**Quality gates (never skip without explicit approval):**
- All CI checks passing
- All review comments addressed
- All review threads resolved
- AC coverage verified

**After merge:** `kspec task complete @ref --reason "Merged in PR #N. Summary..."`
