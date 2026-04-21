# Reviews

kspec has a built-in review system that creates a structured record for each round of review on a task. Reviews are not just approvals or rejections — they capture the investigation, the feedback, and the resolution in a durable, auditable format.

## Why They Exist

Code review is usually a conversation in a pull request — useful, but ephemeral and hard to trace back to requirements. kspec reviews tie directly to specs and acceptance criteria, so a reviewer can verify that the work actually satisfies what was specified, not just that the code looks reasonable.

The review record also supports iterative fix cycles. When a reviewer requests changes, the record captures exactly what needs to change. When the author fixes the issues and resubmits, a new review record is created for the new round. The full history of review-resubmit cycles is preserved, so no feedback gets lost between rounds.

## What a Review Record Contains

Each review record binds to a **subject** — typically a task's code at a specific commit. The subject includes version information so the system knows when verdicts and checks become stale because the code has changed.

Within a review record, there are three main structures:

**Threads** are the feedback itself. Each thread has a kind — blocker, question, or nit — and contains one or more entries from the participants. Blocker threads must be resolved before the review can approve. Questions and nits are non-blocking but should be addressed. Threads can be anchored to specific code locations or left general.

**Verdicts** record the reviewer's decision: approve, request changes, or comment. Each verdict is stamped with the subject version it applies to. If the subject changes (because the author pushed new code), older verdicts become stale and don't count toward the current disposition.

**Checks** record the results of automated verification — test suites, linters, build steps. Like verdicts, checks are version-aware. A passing test suite from an old commit doesn't satisfy the gate for the current commit.

## How Review Gating Works

The review's **disposition** — approved, changes requested, or pending — is computed from the combination of verdicts, checks, and threads:

- **Approved**: all required checks pass, at least one approval verdict exists, no unresolved blocker threads, and no active "request changes" verdicts.
- **Changes requested**: any required check is failing, any blocker thread is unresolved, or any reviewer has requested changes.
- **Pending**: no blockers, but not enough approvals yet.

This means approval is not just one person clicking a button. The system verifies that checks pass, blockers are resolved, and the approval applies to the current version of the code — not a version that has since been updated.

## How Reviews Surface in Use

**After submitting a task.** When a task moves to "pending review," a reviewer (human or agent) creates a review record, investigates the work against the spec's acceptance criteria, opens threads for issues found, and submits a verdict.

**During fix cycles.** If the verdict is "request changes," the task moves to "needs work." The author reads the review threads, addresses each one, replies with what was changed, resolves the threads, and resubmits. A new review record is created for the next round.

**At the merge gate.** Before merging approved work, the merge process checks the review disposition. Only tasks with an approved disposition, passing checks, and no unresolved blocker threads can proceed.

**In the audit trail.** Review records persist as first-class entities in the shadow branch. You can look up any task's review history to see what was found, what was fixed, and who approved it. This is especially valuable when reconstructing decisions months later.

The per-cycle model — one review record per submission round — means the history is clean. Each record represents a complete pass through the work, not an ever-growing thread of mixed feedback from different versions.
