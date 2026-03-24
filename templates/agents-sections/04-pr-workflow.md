## Work and Review Lifecycle

Before submitting work for review: `kspec task submit @ref` (transitions to `pending_review`).

The full lifecycle:

1. **Work** — Implement, test, annotate ACs. See the kspec task-work skill.
2. **Submit** — `kspec task submit @ref` signals work is ready for review.
3. **Review** — Reviewer creates a kspec review record, investigates, submits verdict. See the kspec review skill.
4. **Merge** — After review approval, merge to integration branch. See the kspec merge skill.

**Review gates (from kspec review disposition):**

- Review disposition = `approved`
- All required checks passing
- No unresolved blocker threads
- AC coverage verified (own + trait)

**After merge:** `kspec task complete @ref --reason "Merged. Summary..."`

**Fix cycle:** If review requests changes, task transitions to `needs_work`. Worker reads review threads via `kspec review for-task @ref`, addresses blockers, resubmits.
