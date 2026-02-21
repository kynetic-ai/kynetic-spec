---
name: local-review
description: Pre-PR quality review - verify AC coverage, test quality, E2E preference, and test isolation.
---

Base directory for this skill: /home/chapel/Projects/kynetic-spec/.claude/skills/local-review

# Local Review

Quality enforcement for pre-PR review. Use before creating a PR to catch issues early.

## Quick Start

```bash
# Start the workflow
kspec workflow start @local-review
kspec workflow next --input spec_ref="@spec-slug"
```

## When to Use

- Before creating a PR
- When spawning a review subagent
- After completing implementation, before shipping

## Subagent Invocation

When spawned as a subagent by the worker (before PR creation):
- Return findings to the caller with severity classifications
- MUST-FIX items block PR creation until resolved
- The worker fixes issues inline, not a separate cycle
- Actionable items not worth fixing now: recommend `kspec inbox add`

## Workflow Overview

8-step quality gate. The goal is to find problems, not to approve.

1. **Get Spec & ACs** — Run `kspec item get @spec-ref` to read own ACs and inherited trait ACs
2. **Own AC Coverage** — Every own AC must have test (MUST-FIX)
3. **Trait AC Coverage** — Every inherited trait AC must have test (MUST-FIX)
4. **Test Quality** — No fluff tests (MUST-FIX)
5. **Test Strategy** — Prefer E2E over unit
6. **Test Isolation** — Tests in temp dirs (MUST-FIX)
7. **Code Quality** — Duplicated logic, ignored shared code, inconsistent patterns (MUST-FIX)
8. **Regression Check** — `npm test` passes fully, no broken existing tests (MUST-FIX)

## Review Criteria

### 1. Own AC Coverage (MUST-FIX)

Every own acceptance criterion MUST have at least one test that validates it.

**How to check:**
```bash
# Get all ACs (own + inherited from traits)
kspec item get @spec-ref

# Search for own AC annotations across all test directories
grep -rn "// AC: @spec-ref" tests/ packages/
```

**Annotation format:**
```typescript
// AC: @spec-ref ac-1
it('should validate input when given invalid data', () => { ... });
```

### 2. Trait AC Coverage (MUST-FIX)

If the spec implements traits, every inherited trait AC MUST also have test coverage. Run `kspec item get @spec-ref` — inherited ACs appear under "Inherited from @trait-slug" sections. Each one needs a test annotated with the **trait's** ref, not the spec's ref.

**How to check:**
```bash
# List inherited trait ACs
kspec item get @spec-ref    # Look for "Inherited from @trait-slug" sections

# Search for trait AC annotations (use actual trait slug from output above)
grep -rn "// AC: @trait-json-output" tests/ packages/
grep -rn "// AC: @trait-cli-command" tests/ packages/

# Cross-check: kspec validate reports uncovered trait ACs
kspec validate
```

Any "inherited trait AC(s) without test coverage" warning from `kspec validate` is a **MUST-FIX** blocker.

**Annotation format for trait ACs:**
```typescript
// AC: @trait-json-output ac-1
it('should output valid JSON with --json flag', () => { ... });
```

If a trait AC genuinely does not apply to this spec, annotate it with a reason: `// AC: @trait-slug ac-N — N/A: <reason>`. The annotation must exist so coverage tooling can track it.

If the spec has no traits, skip this step.

### 3. Test Quality (MUST-FIX)

All tests must properly validate their intended purpose.

**Valid tests:**
- AC-specific tests that validate acceptance criteria
- Edge case tests that catch real bugs
- Integration tests that verify components work together

**Fluff tests to reject:**
- Tests that always pass regardless of implementation
- Tests that only verify implementation details
- Tests that mock everything and verify nothing

**Litmus test:** Would this test fail if the feature breaks?

### 4. Test Strategy (SUGGESTION)

Prefer end-to-end tests over unit tests.

**Good:** Test the CLI as a user would invoke it
```typescript
it('should list tasks', async () => {
  const result = await kspec(['task', 'list'], tempDir);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('task-slug');
});
```

**Less good:** Only unit testing internal functions
```typescript
it('should format task', () => {
  const formatted = formatTask(mockTask);
  expect(formatted).toBe('...');
});
```

Unit tests are okay for complex logic, but E2E proves the feature works.

### 5. Test Isolation (MUST-FIX)

All tests MUST run in temp directories, not the kspec repo.

**Why this matters:**
- Prevents nested worktree issues
- Prevents data corruption in real `.kspec/`
- Ensures tests are reproducible

**Correct pattern:**
```typescript
let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempDir();
  await initGitRepo(tempDir);
  await setupTempFixtures(tempDir);
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});
```

**Wrong pattern:**
```typescript
// NEVER do this - tests run in actual kspec repo
it('should work', async () => {
  const result = await kspec(['task', 'list']);  // No tempDir!
});
```

### 6. Code Quality (MUST-FIX)

Review the implementation code, not just tests. Assume there is a problem to find.

**Checkable criteria:**
- **Duplicated logic** — Does new code reimplement something that already exists in `src/`? Search for existing helpers before approving new ones. If a utility exists, the new code MUST use it.
- **Inconsistent patterns** — Does the code follow conventions in neighboring files? Check naming, error handling, import style. If adjacent files handle errors with `Result<T>`, new code should too.
- **Ignored shared utilities** — Were test helpers (`testUlid()`, `setupTempFixtures()`, `kspec()` runner) overlooked in favor of ad-hoc implementations?
- **Error handling gaps** — Are error paths tested? Does the code handle edge cases the spec implies?

Each finding must include `file:line` and a concrete description of what's wrong.

### 7. Regression Check (MUST-FIX)

```bash
# Run the full test suite — not just new tests
npm test
```

Any test failures are MUST-FIX. New code that breaks existing spec or trait AC tests is not shippable.

## Example Review Prompt

When spawning a subagent for review:

```
Review this implementation against the spec @spec-ref. Assume there are problems to find.
- Run `kspec item get @spec-ref` to enumerate ALL ACs (own + inherited trait ACs)
- Every own AC must have test coverage: // AC: @spec-ref ac-N
- Every inherited trait AC must have test coverage: // AC: @trait-slug ac-N
- Run `kspec validate` — trait AC warnings are MUST-FIX
- Review code for duplicated logic, ignored shared utilities, inconsistent patterns
- Run `npm test` — all existing tests must still pass
- Prioritize E2E tests over unit tests
- Verify tests run in temp dirs, not kspec repo
- Reject fluff tests that don't validate real behavior
- List MUST-FIX findings first, each with file:line and specific issue
```

## Issue Severity

| Issue | Severity | Action |
|-------|----------|--------|
| Missing own AC coverage | MUST-FIX | Add test with `// AC: @spec-ref ac-N` |
| Missing trait AC coverage | MUST-FIX | Add test with `// AC: @trait-slug ac-N` |
| Fluff test | MUST-FIX | Rewrite or remove |
| Tests not isolated | MUST-FIX | Move to temp dirs |
| Duplicated or inconsistent code | MUST-FIX | Use existing utilities, match patterns |
| Regression (existing tests broken) | MUST-FIX | Fix before PR |
| No E2E tests | SUGGESTION | Consider adding |

## Integration

- **After task work**: Run local review before `/pr`
- **Before merge**: Complements `@pr-review-merge` workflow
- **In CI**: Automated review also runs but local catches issues earlier
