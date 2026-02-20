---
name: pr-review
description: Review a PR linked to a kspec task, post findings as inline comments, and merge only when all quality gates pass. You NEVER fix code — you review and comment. If issues found, kick back to worker.
---

# PR Review Skill

Review a PR linked to a kspec task, post findings as inline comments, and merge only when all quality gates pass. This skill runs in **subagent context** (spawned by ralph). The goal is to find problems and verify quality — not to rubber-stamp merges.

## Role Boundary

You are a REVIEWER. Your responsibilities:
- Review code quality, AC coverage (own + trait), spec alignment
- Post findings as inline PR comments with severity (MUST-FIX:, SHOULD-FIX:, SUGGESTION:)
- Merge the PR ONLY when all quality gates pass (no MUST-FIX or SHOULD-FIX)
- Complete the task after merge

You MUST NOT:
- Fix code issues
- Push commits to the PR branch
- Add or modify tests
- Make any code changes

If you find issues, post them as inline comments and transition the task to needs_work. The worker agent fixes them in the next iteration.

## Usage

```
/pr-review @task-ref
```

**Task reference is required.** This skill needs to know which task's PR to review.

## Quick Start

```bash
# Validate inputs first
kspec task get @task-ref           # Verify task exists
gh pr list --search "Task: @task-ref"  # Find linked PR

# Start the workflow
kspec workflow start @pr-review-loop
```

## Validation (Before Starting)

### 1. Task Reference Required

If no task ref provided, error immediately:

```
Error: Task reference required.
Usage: /pr-review @task-ref
```

### 2. PR Must Exist

Find the PR linked to this task:

```bash
# Check task for vcs_refs
kspec task get @task-ref --json | jq '.vcs_refs'

# Or search PR body/commits for task reference
gh pr list --search "Task: @task-ref" --json number,url,title
```

If no PR found:

```
Error: No PR found for task @task-ref.
Create a PR first with /pr, then run /pr-review @task-ref.
```

## Quality Gates

This skill enforces **four quality gates**. Assume there are problems to find.

### 1. AC Coverage (Own + Trait)

Every acceptance criterion MUST have test coverage — both own ACs and inherited trait ACs.

```typescript
// Own AC
// AC: @spec-ref ac-1
it('should validate task ref is provided', () => { ... });

// Trait AC (use the trait ref, not the spec ref)
// AC: @trait-cli-command ac-1
it('should exit 0 on success', () => { ... });
```

**Check for gaps:**
- Run `kspec item get @spec-ref` — shows own ACs and inherited trait ACs (under "Inherited from @trait-slug")
- Search test files for `// AC: @spec-ref ac-N` (own) and `// AC: @trait-slug ac-N` (trait) across `tests/` and `packages/`
- Run `kspec validate` — any "inherited trait AC(s) without test coverage" for this spec is MUST-FIX
- Flag any uncovered ACs (own or trait)

### 2. Spec Alignment

Implementation must match spec intent, not just pass tests:

- Read the spec description and ACs
- Read the implementation code
- Verify behavior matches spec (not just syntactically correct)
- Check for undocumented behavior or spec deviations

**This is NOT just "do tests pass"** - it's verifying the implementation actually does what the spec says.

### 3. Code Quality

Review the code with the scrutiny of a human reviewer. Local review (step 1) covers detailed criteria; here, focus on PR-level concerns:

- **Shared code awareness** — if the diff adds a utility that already exists in `src/`, flag it
- **Consistency with codebase** — naming, error patterns, import organization match neighboring files
- **Unnecessary complexity** — extra abstractions or premature generalization beyond what the spec requires

### 4. Regression Check

Run `npm test` and verify zero failures. New code must not break existing spec or trait AC tests. If the PR touches shared code, verify downstream consumers still work.

## Workflow

This skill delegates all behavior to `@pr-review-loop` workflow:

```bash
kspec workflow start @pr-review-loop
```

The workflow handles:
1. Run local review (`/local-review`) — covers own + trait AC coverage, test quality, code quality
2. Verify spec alignment (implementation matches spec intent)
3. Review code quality (DRY, consistency, shared code usage)
4. Verify no regressions (`npm test` passes fully)
5. Post all findings as inline PR comments (MUST-FIX:, SHOULD-FIX:, SUGGESTION:)
6. If MUST-FIX or SHOULD-FIX found: transition task to needs_work, exit without merging
7. Wait for CI to pass
8. **Post a structured GitHub review** (see below)
9. Merge only if all quality gates pass (no MUST-FIX or SHOULD-FIX items)

### REQUIRED: Post a GitHub Review with Inline Comments

You MUST post a GitHub review with **inline comments** on specific findings. This creates an actionable audit trail — reviewers and authors can see exactly which lines have issues.

**Step 1: Build a review JSON file with inline comments.**

For each finding (missing AC, code quality issue, etc.), add an inline comment on the relevant file and line:

```bash
# Write review body with inline comments to a temp file
cat > /tmp/pr-review-body.json << 'REVIEWEOF'
{
  "event": "APPROVE",
  "body": "## Review Summary\n\n**Task:** @task-ref\n**Spec:** @spec-ref\n\n### Own AC Coverage\n- [x] ac-1: <description> — test at <file:line>\n- [x] ac-2: <description> — test at <file:line>\n\n### Trait AC Coverage\n- [x] @trait-slug ac-1: <description> — test at <file:line>\n- [x] @trait-slug ac-2: <description> — test at <file:line>\n_(omit this section if spec has no traits)_\n\n### Code Quality\n<findings or 'No issues found'>\n\n### Quality Gates\n- [x] All tests pass (no regressions)\n- [x] Own AC coverage verified\n- [x] Trait AC coverage verified (or N/A — no traits)\n- [x] Code quality reviewed\n- [x] Spec alignment verified",
  "comments": [
    {
      "path": "src/example.ts",
      "line": 42,
      "body": "**MUST-FIX**: This reimplements `formatRef()` from `src/utils/refs.ts:15`. Use the existing utility."
    },
    {
      "path": "tests/example.test.ts",
      "line": 10,
      "body": "**MUST-FIX**: Missing trait AC coverage. `@trait-json-output ac-2` (JSON contains all displayed data) has no test. Add: `// AC: @trait-json-output ac-2`"
    }
  ]
}
REVIEWEOF
```

**Step 2: Post the review.**

```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews \
  --method POST \
  --input /tmp/pr-review-body.json
```

**Review event decision:**
- **MUST-FIX or SHOULD-FIX present** → use `"event": "COMMENT"`, do NOT merge, transition task to needs_work
- **Only SUGGESTION or no findings** → use `"event": "APPROVE"`, proceed to merge

**Inline comment guidelines:**
- Every MUST-FIX finding gets an inline comment on the relevant line
- Use severity prefix: `**MUST-FIX**:`, `**SHOULD-FIX**:`, `**SUGGESTION**:`
- For missing AC coverage, comment on the test file where the annotation should be added
- For code quality issues, comment on the specific line with the problem
- Do NOT use `REQUEST_CHANGES` since the review is posted from the repo owner's account

**Never merge without posting a review.** Even a brief APPROVE review with no inline comments is better than no review.

### When Issues Are Found (Kick Back to Worker)

If your review finds MUST-FIX or SHOULD-FIX items:

1. Post the review with `"event": "COMMENT"` and inline comments
2. Transition task: `kspec task needs-work @task-ref --reason "MUST-FIX: <summary>"`
3. Exit — do NOT merge, do NOT fix code

The worker agent picks up the `needs_work` task in the next iteration and addresses the findings.

### CRITICAL: CI Re-verification

**After ANY push, you MUST re-verify CI from the beginning.** Prior CI checks are invalidated by new commits. Never merge without fresh CI verification on the current HEAD.

## Re-review After Fix Cycle

When reviewing a PR that was previously reviewed and had fixes pushed:

1. Review the FULL PR (not just new commits)
2. Focus feedback on changes since last review
3. Verify previous MUST-FIX and SHOULD-FIX findings were addressed
4. Check for regressions introduced by fixes
5. If all resolved: APPROVE and merge
6. If issues remain or new issues: post comments, kick back again

## Unfixed SHOULD-FIX Tracking

If a SHOULD-FIX item persists after re-review (worker chose not to fix):
- Create an inbox item: `kspec inbox add "SHOULD-FIX from PR #N: <description>"`
- If the issue is well-defined enough: create a task directly
- This ensures the finding is tracked even if the PR is merged

## Subagent Context

This skill runs in **ACP subagent context**:
- Spawned by ralph for PR review
- Runs sequentially (ralph waits for completion)
- No human interaction expected
- Auto-resolves decisions based on quality gate outcomes

**Role boundary:** This skill reviews and merges. It NEVER fixes code, adds tests, or pushes commits. If issues are found, they are posted as comments and the task is transitioned to needs_work for the worker.

## Exit Conditions

- **PR merged** - Success, quality gates passed (no MUST-FIX or SHOULD-FIX)
- **Issues found** - Posted as inline comments, task transitioned to needs_work
- **CI failed** - Tests don't pass
- **PR not found** - Validation failed, no PR for task

## Example

```
/pr-review @task-reflect-loop-skill

[Validates task exists]
[Finds PR #234 linked to task]
[Starts @pr-review-loop workflow]
[Runs local review - checks AC coverage]
[Verifies spec alignment]
[Posts review with findings]
[If clean: waits for CI, merges PR, completes task]
[If issues: posts COMMENT review, transitions to needs_work, exits]
```

## Task Completion

**CRITICAL: You MUST complete the task after merging the PR.**

The `@pr-review-loop` workflow includes task completion as the final step (ac-7). After the PR is merged:

```bash
kspec task complete @task-ref --reason "Merged in PR #N. <summary>"
```

Include in the reason:
- PR number
- Summary of what was implemented
- Any notable changes or deviations
- AC coverage confirmation

Do NOT exit after merge without completing the task.
