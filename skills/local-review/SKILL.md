


# Local Review

Quality enforcement for pre-PR review. Use before creating a PR to catch issues early.

## Reviewer Philosophy

**You are the first gate, not a formality.** Your job is to catch problems before they reach the PR review. If you pass something that the PR reviewer catches, the local review failed. Be more strict than you think is necessary — it is always cheaper to fix something now than after a PR is created.

**When in doubt, flag it as MUST-FIX.** Do not rationalize away problems. Do not downgrade findings because "it's early stage" or "it will be fixed later." If the spec says the system does X, the code must actually do X right now — not stub it, not mock it, not TODO it.

**Reproduce, don't just read.** Run `npm test`. Run the actual CLI commands. If the spec says "exit 0 on success," run it and verify. If a test claims to cover an AC, verify the test would actually fail if the feature broke.

**Simple-looking changes are where bugs hide.** Refactors, renames, test rewrites, and "mechanical" changes can silently change semantics. Give these the same scrutiny as new feature code.

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

9-step quality gate. The goal is to find problems, not to approve.

0. **Discover Spec Context** — If `spec_ref` is not provided, discover it (see below)
1. **Get Spec & ACs** — Run `kspec item get @spec-ref` to read own ACs and inherited trait ACs
2. **Own AC Coverage** — Every own AC must have test (MUST-FIX)
3. **Trait AC Coverage** — Every inherited trait AC must have test (MUST-FIX)
4. **Test Quality** — No fluff tests (MUST-FIX)
5. **Test Strategy** — Prefer E2E over unit
6. **Test Isolation** — Tests in temp dirs (MUST-FIX)
7. **Code Quality** — Duplicated logic, ignored shared code, inconsistent patterns (MUST-FIX)
8. **Regression Check** — `npm test` passes fully, no broken existing tests (MUST-FIX)

### Step 0: Discover Spec Context

If `spec_ref` is not explicitly provided, discover it before proceeding:

```bash
# 1. Check git log for Task: or Spec: trailers in recent commits on this branch
git log --format='%B' main..HEAD | grep -E '^(Task|Spec):'

# 2. Check changed files for // AC: annotations pointing to specs
git diff main..HEAD | grep '// AC: @'

# 3. Search recent tasks matching the scope of changed files
kspec tasks list | grep -i "<keywords from changed files>"

# 4. If a task ref is found, resolve to spec_ref
kspec task get @task-ref --json | jq '.spec_ref'
# Then get the spec with ACs
kspec item get @spec-ref
```

If a spec is found through any method, use it for full AC validation (steps 1-3).
If only a task ref is found (no spec_ref on it), the task is infra/internal — skip AC checks.
If no spec context is found after all discovery steps, skip AC coverage checks (steps 1-3) and proceed with steps 4-8 (test quality, isolation, code quality, regression).

## CLI Lookups

Use CLI commands to resolve specs and traits. **Do NOT search `.kspec/` YAML files manually.**

| Need | Command |
|------|---------|
| Spec + all ACs (own + inherited) | `kspec item get @spec-ref` |
| Trait definition + ACs | `kspec item get @trait-slug` |
| Task's linked spec | `kspec task get @ref` → read `spec_ref` field |
| Search by keyword | `kspec search "keyword"` |
| All traits | `kspec trait list` |

**Resolving inherited traits:** When `kspec item get` shows "Inherited from @trait-slug", run `kspec item get @trait-slug` to see the full trait ACs. This is one command — never grep through `.kspec/modules/*.yaml` files.

## Automatic MUST-FIX: Patterns That Always Block

The following are **always MUST-FIX** — no exceptions, no downgrading:

- **Stubs claiming AC coverage** — `void` expressions, empty function bodies, TODO comments, placeholder returns where the spec requires real behavior.
- **Tests that don't prove the AC** — testing implementation internals (parser state, compiled strings, internal data structures) instead of user-visible behavior. A test must fail if the feature breaks.
- **Tests that mock the thing being tested** — mocking the CLI runner then asserting the mock was called proves nothing about the CLI working.
- **Imports from unmerged branches** — code that depends on work not yet on main must be blocked or rebased.
- **Hardcoded absolute paths** — `/home/user/project/...` in any file.
- **Test helpers exported from production code** — test-only exports from `src/` modules. Test infrastructure belongs in `tests/`.
- **Bypassing Zod validation** — creating parallel validation logic instead of using the schemas in `src/schema/`.

### Build and Verification Config Changes
Any change to tsconfig, Biome config, vitest config, or other verification tooling that makes the pipeline report *fewer* problems is MUST-FIX:
- Adding excludes/ignores to suppress errors instead of fixing them
- Loosening compiler strictness, disabling Biome rules, skipping test suites
- Modifying test sharding or timeouts to mask failures

### Test Rewrites That Reduce Coverage
- If original tests verified behavior X and the replacement no longer verifies X, that is MUST-FIX. Replacements must be a **superset** of original coverage. Watch for: E2E CLI tests replaced with unit tests, structural assertions replacing behavioral ones, test names describing old behavior with new assertions.

### Refactors and Mechanical Changes
- Refactored code must preserve all behavior including error handling, edge cases, and `Result<T>` chains. Verify all call sites still get the same behavior after utility extraction or consolidation.

**Severity default: MUST-FIX.** Only downgrade to SUGGESTION for pure style preferences (naming, comment formatting) with zero correctness implications. If it touches behavior or correctness in any way, it is at minimum SHOULD-FIX.

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

Before accepting coverage, confirm each annotation maps to the correct AC text from `kspec item get @spec-ref` (not just the same `ac-N` number).

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

Annotations must be standalone line comments (`// AC:` or `# AC:`), not embedded inside block/JSDoc comments.

If a trait AC genuinely does not apply to this spec, annotate it with a reason: `// AC: @trait-slug ac-N — N/A: <reason>`. The annotation must exist so coverage tooling can track it.

If the spec has no traits, skip this step.

### 3. Test Quality (MUST-FIX)

All tests must properly validate their intended purpose. **Coverage quality matters more than coverage existence.**

**Valid tests:**
- AC-specific tests that validate acceptance criteria through observable behavior
- Edge case tests that catch real bugs
- E2E tests that run the CLI as a user would and verify output/exit codes

**Fluff tests to reject (MUST-FIX):**
- Tests that always pass regardless of implementation
- Tests that only verify implementation internals (parser state, compiled source strings, internal data structures) instead of user-visible behavior
- Tests that mock everything and verify nothing — if you mock the CLI runner, you haven't proven the CLI works
- Tests that assert a function exists or was called, rather than asserting its actual output/effect
- Tests that claim AC coverage but stop at a different abstraction layer than what the AC describes (e.g., parser tests claiming CLI-level AC coverage)

**Litmus test:** Would this test fail if the feature broke? If the answer is "maybe not" or "only if the internals changed in a specific way," it's fluff.

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
- **Schema validation bypass** — New code that validates input without using Zod schemas from `src/schema/` is MUST-FIX. Zod is the single source of truth for validation.
- **Shadow branch integrity** — Changes touching worktree management, `.kspec/` state, or shadow branch operations need extra scrutiny for corruption risks.
- **Test helpers in production code** — Exports like `_resetForTesting` from `src/` modules are MUST-FIX. Test infrastructure belongs in `tests/` only.
- **Stubs and no-ops** — `void` expressions, empty function bodies, or TODO comments where real behavior is required by the spec. If the AC's core verb (parse, validate, output, persist, exit) isn't actually executed, it's MUST-FIX.

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

- **After task work**: Run local review before `{skill:pr}`
- **Before merge**: Complements `@pr-review-merge` workflow
- **In CI**: Automated review also runs but local catches issues earlier
