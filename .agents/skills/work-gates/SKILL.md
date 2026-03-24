---
name: work-gates
description: Project-specific quality standards — MUST-FIX patterns, test rules,
  and code quality checks for this codebase. Supplements core task-work skill.
---

<!-- kspec-managed -->

# Work Gates

Project-specific quality standards for kspec. Supplements the core `$kspec-task-work` skill with MUST-FIX patterns, test rules, and code quality checks specific to this codebase.

## MUST-FIX Patterns

The following are **always MUST-FIX** in this project — no exceptions, no downgrading:

### Stubs and No-ops

- `void` expressions, empty function bodies, TODO comments, placeholder returns where the spec requires real behavior
- Any code path where the AC's core verb (parse, validate, output, persist, exit) is not actually executed

### Test Integrity

- Tests that verify implementation internals (compiled source strings, parser state, AST shape) rather than user-visible behavior
- Tests that pass regardless of whether the feature works
- Tests that mock the thing being tested — if the AC says "CLI outputs JSON," mocking the output formatter proves nothing
- Tests that claim AC coverage at the wrong abstraction layer (parser tests claiming CLI-level coverage)

### Code Hygiene

- Imports from unmerged branches — code depending on work not on main must be blocked or rebased
- Hardcoded absolute paths — `/home/user/project/...` in any file
- Test helpers exported from production code — test-only exports from `src/` modules belong in `tests/`
- Bypassing Zod validation — creating parallel validation instead of using schemas in `src/schema/`

### Build and Verification Config

Any change to tsconfig, Biome config, or vitest config that makes the pipeline report _fewer_ problems:

- Adding excludes/ignores to suppress errors instead of fixing them
- Loosening compiler strictness, disabling rules, skipping test suites
- Modifying test sharding or timeouts to mask failures

### Test Rewrites That Reduce Coverage

- Replacement tests must be a **superset** of original coverage
- Watch for: E2E tests replaced with unit tests, structural assertions replacing behavioral ones, test names describing old behavior with new assertions

### Refactors

- Refactored code must preserve all behavior including error handling, edge cases, and `Result<T>` chains
- Verify all call sites still get the same behavior after utility extraction

## Test Strategy

### E2E Preference

Prefer end-to-end tests over unit tests in this project:

```typescript
// Good: test the CLI as a user would
it("should list tasks", async () => {
  const result = await kspec(["task", "list"], tempDir);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("task-slug");
});

// Less good: only unit testing internal functions
it("should format task", () => {
  const formatted = formatTask(mockTask);
  expect(formatted).toBe("...");
});
```

Unit tests are fine for complex logic, but E2E proves the feature works.

### Test Isolation

All tests MUST run in temp directories, not the kspec repo:

```typescript
let tempDir: string;
beforeEach(async () => {
  tempDir = await createTempDir();
  await initGitRepo(tempDir);
  await setupTempFixtures(tempDir);
});
```

### Test Helpers

Use existing helpers — don't reinvent:

- `testUlid()` / `testUlids()` — valid test ULIDs (Crockford base32)
- `setupTempFixtures()` — copy fixtures to temp dir
- `createTempDir()` — empty temp dir
- `initGitRepo(dir)` — git init with test config
- `kspec(args, cwd)` — run CLI, return result
- `kspecJson<T>(args, cwd)` — run CLI with --json

### Regression Check

```bash
npm test  # Always run full suite — never just new tests
```

## Code Quality

- **Search for existing utilities** before creating new ones — kspec has extensive shared helpers
- **Match neighboring file style** — naming, error handling, imports, `Result<T>` patterns
- **Schema validation** — Zod schemas in `src/schema/` are the source of truth. Never bypass them.
- **Shadow branch integrity** — extra scrutiny for changes touching `.kspec/` state or worktree operations

## Severity Default

**Default to MUST-FIX.** Only downgrade to SUGGESTION for pure style preferences (naming, comment formatting) with zero correctness implications. If it touches behavior or correctness in any way, it is at minimum SHOULD-FIX.
