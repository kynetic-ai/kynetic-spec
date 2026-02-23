## PR Workflow

Before creating a PR, mark the task: `kspec task submit @ref` (transitions to `pending_review`).

The full PR lifecycle has three steps — **all required, in order:**

1. **Local review** — Quality gates: AC coverage, test quality, test isolation. Run this FIRST.
2. **Create PR** — Push branch and open pull request.
3. **Review and merge** — `kspec workflow start @pr-review-merge`.

**Quality gates (never skip without explicit approval):**
- All CI checks passing
- All review comments addressed
- All review threads resolved
- AC coverage verified

**After merge:** `kspec task complete @ref --reason "Merged in PR #N. Summary..."`
