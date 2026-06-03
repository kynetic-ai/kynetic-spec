---
name: review-gates
description: Project-specific review criteria — severity classification,
  regression patterns, anti-rubber-stamping checklist, and quality checks for
  this codebase. Supplements core review skill.
---
<!-- kspec-managed -->
# Review Gates

Project-specific review criteria for kspec. Supplements the core `$kspec-review` skill with severity classification, regression patterns, and quality checks specific to this codebase.

## Kynetic Quality Gate Checks

The shared `$kspec-review` skill defers to "project-defined" quality gates. In this repository those gates are the ones enumerated in `$work-gates` Kynetic Quality Gate Commands. Reviewers must record passing evidence for each required gate as a `kspec review check`, or explicitly note a documented reason for skipping it:

| Gate                          | Command                                | `kspec review check --name` / `--runner` |
| ----------------------------- | -------------------------------------- | ---------------------------------------- |
| Formatting                    | `npm run format:check`                 | `--name "format" --runner "npm run format:check"` |
| Repo-wide lint                | `npm run lint -- --quiet`              | `--name "lint" --runner "npm run lint -- --quiet"` |
| Focused changed-file lint     | `npx oxlint <changed-ts-or-test-files>` | Recorded inline in evidence on the lint check or as an optional `--name "focused-lint"` |
| Typecheck                     | `npm run typecheck`                    | `--name "typecheck" --runner "npm run typecheck"` |
| Tests                         | `npm test` (or shards / `npm test -- --fresh`) | `--name "full test suite" --runner "npm test"` |
| kspec reference validation    | `kspec validate --refs --warnings-ok`  | `--name "kspec validate refs" --runner "kspec"` |
| kspec alignment validation    | `kspec validate --alignment --warnings-ok` | `--name "kspec validate alignment" --runner "kspec"` |
| kspec completeness validation | `kspec validate --completeness --warnings-ok` | `--name "kspec validate completeness" --runner "kspec"` |

Failures of any required gate are review blockers. Request changes rather than approving when a gate is red or missing without a documented reason. Lint warnings inside the changed diff are review findings even when the repo-wide lint baseline passes — verify pre-existing status before downgrading.

For skill-touching changes, also record the optional check `kspec skill status`/`kspec skill verify` against the rendered outputs in `.agents/skills/`, `.factory/skills/`, and (when applicable) `plugin/plugins/kspec/skills/` so render drift is captured in the review.

## Reviewer Philosophy

**You own the merge.** When you approve, you are vouching that the code is correct, complete, and ready. If something bad gets through, the review failed — not just the implementation.

**When in doubt, MUST-FIX.** A false positive costs one fix cycle. A false negative costs trust and debugging time. Default to the higher severity.

**Terminology:** "blocker" in reviews means a MUST-FIX finding thread that prevents approval. It does NOT mean transitioning the task to `blocked` status. Reviewers issue `request_changes` verdicts (which transition tasks to `needs_work`). Do not `kspec task block` unless the agent genuinely cannot proceed or fix the issue — blocking is reserved for external dependencies requiring human intervention (see AGENTS.md blocking rules).

**Reproduce, don't just read.** Run `npm test`. Run the CLI commands. If the spec says "exit 0 on success," run it. If a test claims to cover an AC, verify it would fail if the feature broke.

## Severity Classification

### MUST-FIX (blocks merge)
- Missing own AC test annotation
- Missing trait AC test annotation
- `kspec validate` errors
- Implementation doesn't match spec behavior
- Any pattern from `$work-gates` MUST-FIX list
- Stubs claiming AC coverage
- Tests that don't prove their AC
- Build/config changes that suppress errors
- Test rewrites reducing coverage
- Regressions introduced by this branch (tests that pass on the base branch but fail on the task branch)

### SHOULD-FIX (strong recommendation)
- `kspec validate` warnings (especially trait AC coverage)
- Undocumented behavior not covered by spec
- Test doesn't prove its AC robustly (would pass even if feature broke)
- Likely correctness issue or missing boundary case

### SUGGESTION (non-blocking)
- No E2E tests (prefer E2E but unit is acceptable)
- Style preferences with zero correctness implications
- Naming improvements

**If unsure between SHOULD-FIX and SUGGESTION, it is SHOULD-FIX.**

## Severity Consistency

You MUST NOT downgrade a finding to a lower severity than what an identical finding received in a previous review on this repo. If unsure, default to MUST-FIX.

## Anti-Rubber-Stamping Checklist

Before approving, verify you can answer YES to all:

- [ ] I read the diff before reading any description
- [ ] I ran the test suite (`npm test`) — not just checked CI
- [ ] I verified at least one worker claim independently
- [ ] I checked for issues across multiple categories (correctness, tests, edge cases, error handling)
- [ ] I searched for additional issues after finding the first one (or after finding none)
- [ ] My review took long enough to have actually read the changed code
- [ ] Every approval is backed by specific evidence, not assumption

## Review Evidence Log

Every review must include a brief log. If zero findings, this proves the review was real:

```
Files read: <list>
Commands run: <list>
Claims verified: <which claim, how verified>
Categories searched: <which categories, any findings>
```

## Role Boundary (Automated Reviewers)

When running as an automated reviewer agent:

- **Do NOT fix code** — post findings as review threads, transition to needs_work
- **Do NOT push commits** — the worker handles fixes
- **DO resolve simple merge conflicts** — textual conflicts from parallel additive edits are merge mechanics, not code fixes. Read both sides, include both, complete the merge. Only escalate semantic conflicts (see `$kspec-merge` conflict handling).
- Verdicts auto-close the review — no manual close needed after approve/request_changes
- Each fix cycle gets a **new** review record — do not reopen prior reviews
- After merge, complete the task: `kspec task complete @ref --reason "Merged. Summary..."`

## Merge Criteria

Beyond core disposition gate (from `$kspec-merge`):

- No test regressions introduced by the reviewed branch (pre-existing failures are not blockers — see Test Failure Triage)
- No MUST-FIX or SHOULD-FIX items remaining
- Severity consistency maintained across reviews
- Evidence log present in review record

## Test Failure Triage

When `npm test` fails during review, determine the cause before recording findings:

1. **Run tests at least twice** to identify flaky tests vs deterministic failures.
2. **Check the base branch.** Run `npm test` on the integration target branch (before the task's changes). If the same tests fail there, they are pre-existing — not regressions introduced by this work.
3. **Classify each failure:**

| Failure type | Action |
|---|---|
| **Introduced by this branch** | Record as MUST-FIX blocker thread, submit `request_changes` verdict. The worker fixes it. |
| **Pre-existing on base branch** | Not a regression. Create a new task (`kspec task add`) with detailed description (what fails, why it fails, how to fix — no assumptions), set `--automation eligible`, then proceed with the review as if the test passed. |
| **Flaky (intermittent)** | Same as pre-existing: create a task to stabilize the test, proceed with review. Note flakiness in the task description. |

**Never block a task for pre-existing or flaky test failures.** The task under review didn't cause them. Merge the work if it's otherwise approved, and let the new task handle the test fix independently.

## Categories to Cover

A review should search across multiple areas. Note what was checked even if nothing was found:

- **Correctness** — does the code do what the spec says?
- **Edge cases** — empty input, null, boundary values, concurrent access?
- **Error handling** — are error paths tested? Do errors propagate correctly?
- **Security** — input validation, authorization, data exposure
- **Test quality** — do tests prove the ACs or just touch code paths?
- **Integration** — does this change interact correctly with existing code?
