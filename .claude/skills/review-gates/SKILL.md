---
name: review-gates
description: Project-specific review criteria — severity classification,
  regression patterns, anti-rubber-stamping checklist, and quality checks for
  this codebase. Supplements core review skill.
---
<!-- kspec-managed -->
# Review Gates

Project-specific review criteria for kspec. Supplements the core `/kspec:review` skill with severity classification, regression patterns, and quality checks specific to this codebase.

## Reviewer Philosophy

**You own the merge.** When you approve, you are vouching that the code is correct, complete, and ready. If something bad gets through, the review failed — not just the implementation.

**When in doubt, block.** A false positive costs one fix cycle. A false negative costs trust and debugging time. Default to MUST-FIX.

**Reproduce, don't just read.** Run `npm test`. Run the CLI commands. If the spec says "exit 0 on success," run it. If a test claims to cover an AC, verify it would fail if the feature broke.

## Severity Classification

### MUST-FIX (blocks merge)
- Missing own AC test annotation
- Missing trait AC test annotation
- `kspec validate` errors
- Implementation doesn't match spec behavior
- Any pattern from `/work-gates` MUST-FIX list
- Stubs claiming AC coverage
- Tests that don't prove their AC
- Build/config changes that suppress errors
- Test rewrites reducing coverage
- Regressions (existing tests broken)

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
- **DO resolve simple merge conflicts** — textual conflicts from parallel additive edits are merge mechanics, not code fixes. Read both sides, include both, complete the merge. Only escalate semantic conflicts (see `/kspec:merge` conflict handling).
- Verdicts auto-close the review — no manual close needed after approve/request_changes
- Each fix cycle gets a **new** review record — do not reopen prior reviews
- After merge, complete the task: `kspec task complete @ref --reason "Merged. Summary..."`

## Merge Criteria

Beyond core disposition gate (from `/kspec:merge`):

- All tests pass (`npm test`) — no regressions
- No MUST-FIX or SHOULD-FIX items remaining
- Severity consistency maintained across reviews
- Evidence log present in review record

## Categories to Cover

A review should search across multiple areas. Note what was checked even if nothing was found:

- **Correctness** — does the code do what the spec says?
- **Edge cases** — empty input, null, boundary values, concurrent access?
- **Error handling** — are error paths tested? Do errors propagate correctly?
- **Security** — input validation, authorization, data exposure
- **Test quality** — do tests prove the ACs or just touch code paths?
- **Integration** — does this change interact correctly with existing code?
