---
name: kspec-review
description: Kspec-specific review gates and first-party review records — spec
  alignment, AC coverage, trait coverage, validation integration, and the review
  record CLI for creating, inspecting, and managing durable review artifacts.
---
<!-- kspec-managed -->
# Review

Kspec-specific review gates and first-party review records. Covers spec alignment, AC coverage, trait coverage, validation integration, and the review record CLI for durable review artifacts.

## When to Use

- Before creating a PR — verify implementation meets spec
- As part of a project-specific local review workflow
- When reviewing code changes against acceptance criteria
- Creating or managing first-party review records for tasks, code, plans, or specs
- Recording check results, verdicts, and threaded comments on review records

**This is NOT a complete review workflow.** It covers kspec-specific quality gates and review record management. Projects should wrap this in their own review skill that adds project-specific concerns (test commands, E2E patterns, coding standards).

## Spec Context Discovery

If a spec ref is not explicitly provided, discover it before proceeding with AC checks:

```bash
# 1. Check commit messages for Task: or Spec: trailers
git log --format='%B' main..HEAD | grep -E '^(Task|Spec):'

# 2. Check changed files for // AC: annotations pointing to specs
git diff main..HEAD | grep '// AC: @'

# 3. If a task ref is found, get its spec_ref
kspec task get @task-ref --json | jq '.spec_ref'

# 4. Search recent tasks matching the scope of changes
kspec tasks list | grep -i "<keywords from changed files>"
```

If a spec is found through any method, proceed with full AC validation below.
If no spec context is found after all discovery steps, skip AC coverage checks and focus on code quality and regression checks.

**Principle:** The absence of a trailer is a signal to look harder, not permission to skip validation.

## CLI Lookups

Use CLI commands to resolve specs, traits, and reviews. **Do NOT search `.kspec/` YAML files manually.**

| Need | Command |
|------|---------|
| Spec + all ACs (own + inherited) | `kspec item get @spec-ref` |
| Trait definition + ACs | `kspec item get @trait-slug` |
| All traits on a spec | shown in `kspec item get @spec-ref` output |
| Search by keyword | `kspec search "keyword"` |
| All traits | `kspec trait list` |
| Review details | `kspec review get @review-ref` |
| Reviews for a task | `kspec review for-task @task-ref` |
| All open reviews | `kspec review list --status open` |

**Resolving inherited traits:** When `kspec item get` shows "Inherited from @trait-slug", run `kspec item get @trait-slug` to see the full trait ACs. This is one command — never grep through `.kspec/modules/*.yaml` files.

## Spec Alignment

Implementation must match spec intent, not just pass tests.

### How to Verify

```bash
# Read the spec — all ACs (own + inherited)
kspec item get @spec-ref
```

For each AC, verify:
1. **Implementation exists** — Code handles the described behavior
2. **Test exists** — A test validates the behavior
3. **Behavior matches** — The test actually proves the AC, not just syntactically passes

### What to Flag

| Issue | Severity |
|-------|----------|
| AC has no implementation | MUST-FIX |
| AC has no test | MUST-FIX |
| Implementation deviates from spec | MUST-FIX |
| Undocumented behavior (not in any AC) | SHOULD-FIX |
| Spec is vague, implementation chose reasonable interpretation | Note it |

## Own AC Coverage

Every acceptance criterion on the spec MUST have at least one annotated test.

### Annotation Format

```javascript
// AC: @spec-ref ac-N
it('should validate input when given invalid data', () => { ... });
```

```python
# AC: @spec-ref ac-N
def test_validates_input():
    ...
```

### Checking Coverage

```bash
# Get all ACs for the spec
kspec item get @spec-ref

# Search for annotations in test files
# (adapt grep path to your project's test directories)
grep -rn "// AC: @spec-ref" tests/
```

Each AC listed in the spec output must have a corresponding annotation. Missing annotations are MUST-FIX.
Before accepting coverage, confirm each annotation matches the AC text from `kspec item get @spec-ref` (not only the `ac-N` label).

## Trait AC Coverage

When a spec implements traits, it inherits their ACs. Every inherited trait AC must also have test coverage.

### How It Works

```bash
# kspec item get shows inherited ACs under "Inherited from @trait-slug" sections
kspec item get @spec-ref
```

Each inherited AC needs a test annotated with the **trait's** ref, not the spec's ref:

```javascript
// AC: @trait-json-output ac-1
it('should output valid JSON with --json flag', () => { ... });
```

### Checking Coverage

```bash
# kspec validate reports uncovered trait ACs
kspec validate

# Search for specific trait annotations
grep -rn "// AC: @trait-json-output" tests/
```

Any "inherited trait AC(s) without test coverage" warning from `kspec validate` is a MUST-FIX blocker.

### When a Trait AC Doesn't Apply

If a trait AC genuinely doesn't apply to this spec, annotate it with a reason:

```javascript
// AC: @trait-json-output ac-3 — N/A: this command has no tabular output to format
```

The annotation must exist so coverage tooling can track it.
Annotations must be standalone line comments (`// AC:` or `# AC:`), not embedded inside block/JSDoc comments.

### No Traits?

If the spec has no traits (`kspec item get` shows no "Inherited from" sections), skip this step entirely.

## Validation Integration

```bash
kspec validate
```

Validation catches spec-level issues:
- Missing acceptance criteria on specs
- Broken references (dangling `@slug`)
- Missing descriptions
- Uncovered trait ACs (the most common review finding)
- Orphaned specs (no linked tasks)

**Exit codes:** `0` = clean, `4` = errors, `6` = warnings only.

Treat errors as MUST-FIX. Treat warnings as SHOULD-FIX (especially trait AC warnings).

## Review Records

kspec stores first-party review records as durable artifacts in the shadow branch. Review records track the full lifecycle of reviewing a task, code change, plan, or spec — including threaded comments, check results, verdicts, and audit history.

### When to Use Review Records

- **Task reviews** — Create a review when a task enters `pending_review` to capture structured feedback
- **Code reviews** — Track base/head commit context so verdicts and checks are bound to specific reviewed state
- **Plan/spec reviews** — Review shadow-branch entities with content-hash-based staleness detection
- **Local review without a PR** — Record verification evidence and approval state without requiring GitHub

### Review Lifecycle

```
draft → open → closed
                 ↓
              archived
```

| State | Meaning |
|-------|---------|
| `draft` | Review created but not yet started |
| `open` | Active review in progress |
| `closed` | Review concluded (approved, changes requested, or abandoned) |
| `archived` | Permanently archived (terminal) |

### Disposition (Computed)

The review disposition is computed from verdicts, checks, and threads — not set directly:

| Disposition | Condition |
|-------------|-----------|
| `pending` | No verdicts, or only `comment` verdicts |
| `approved` | At least one `approve` verdict matching current version, no blocking `request_changes`, all required gates passing, no unresolved blocker threads |
| `changes_requested` | Any `request_changes` verdict matching current version, or required gates failing, or unresolved blocker threads |

### Creating Reviews

```bash
# Review a task (auto-links review_ref on the task)
kspec review add --title "Review task-add-auth" \
  --subject-type task --subject-ref @task-add-auth

# Review committed code
kspec review add --title "Review feature branch" \
  --subject-type code --base abc1234 --head def5678 \
  --base-branch main --head-branch feat/auth \
  --related-ref @task-add-auth

# Review a plan
kspec review add --title "Review auth plan" \
  --subject-type plan --subject-ref @plan-auth

# With a custom slug for batch workflows
kspec review add --title "Review auth" \
  --subject-type task --subject-ref @task-add-auth \
  --slug review-auth-v1
```

**Subject types:** `task`, `code`, `plan`, `spec`, `external`

For code subjects, `--base` and `--head` are required. For ref-backed subjects (task, plan, spec), `--subject-ref` is required. For external subjects, `--url` is required.

### Inspecting Reviews

```bash
# Full review details (lifecycle, disposition, gates, threads, verdicts)
kspec review get @review-ref

# List reviews with filters
kspec review list --status open
kspec review list --disposition changes_requested
kspec review list --subject-type code
kspec review list --reviewer agent@example.com
kspec review list --task @task-ref

# Find reviews linked to a task
kspec review for-task @task-ref
```

### Adding Comments

Comments create threaded discussions. Each thread has a `kind` that determines whether it blocks approval.

```bash
# General comment (nit by default)
kspec review comment @review-ref --body "Consider renaming this variable" --kind nit

# Blocking comment — must be resolved before approval
kspec review comment @review-ref --body "Missing error handling" --kind blocker

# Question — non-blocking
kspec review comment @review-ref --body "Why was this approach chosen?" --kind question

# Code-targeted comment with diff-side anchor
kspec review comment @review-ref --body "Off-by-one error" --kind blocker \
  --path src/parser/validate.ts --side head --line-start 42 --line-end 42 \
  --commit def5678

# Structured anchor (for plans/specs)
kspec review comment @review-ref --body "AC is too vague" --kind blocker \
  --section acceptance_criteria --field ac-3 --anchor-ref @spec-ref
```

**Thread kinds:** `blocker` (blocks approval), `question` (non-blocking), `nit` (non-blocking, default).

### Replying to Threads

```bash
kspec review reply @review-ref --thread <thread-ulid> --body "Fixed in commit abc1234"
```

### Resolving and Reopening Threads

```bash
# Resolve a thread (e.g., after fixing the issue)
kspec review resolve @review-ref --thread <thread-ulid>

# Reopen if the fix was insufficient
kspec review reopen @review-ref --thread <thread-ulid>
```

Only `blocker` threads affect disposition. Unresolved `nit` and `question` threads do not block approval.

### Recording Checks

Checks record verification evidence (test runs, CI results, manual attestations) bound to a specific reviewed state.

```bash
# Record a passing test run for code review
kspec review check @review-ref --name "vitest" --status pass \
  --runner vitest --evidence "All 342 tests passed" \
  --version-base abc1234 --version-head def5678

# Record a failing CI check
kspec review check @review-ref --name "lint" --status fail \
  --runner eslint --evidence "3 errors found" \
  --version-base abc1234 --version-head def5678

# Record a non-required informational check
kspec review check @review-ref --name "coverage" --status pass \
  --no-required --evidence "87% coverage" \
  --version-base abc1234 --version-head def5678

# Check for entity subject (plan/task/spec)
kspec review check @review-ref --name "spec-review" --status pass \
  --version-hash sha256abc
```

**Check statuses:** `pass`, `fail`, `running`, `skipped`

Checks whose `applies_to_version` does not match the current subject version are treated as stale.

### Setting Verdicts

Verdicts record individual reviewer decisions bound to the reviewed state.

```bash
# Approve
kspec review verdict @review-ref --decision approve \
  --reviewer agent@example.com \
  --version-base abc1234 --version-head def5678

# Request changes
kspec review verdict @review-ref --decision request_changes \
  --reviewer agent@example.com \
  --version-base abc1234 --version-head def5678

# Non-blocking comment verdict
kspec review verdict @review-ref --decision comment \
  --reviewer agent@example.com \
  --version-base abc1234 --version-head def5678

# Verdict with a role
kspec review verdict @review-ref --decision approve \
  --reviewer lead@example.com --role lead \
  --version-base abc1234 --version-head def5678
```

**Verdict decisions:** `approve`, `request_changes`, `comment`

Verdicts are per-reviewer. A reviewer who requests changes and later approves the same version replaces the blocking verdict. Verdicts whose `applies_to_version` does not match the current subject are treated as stale.

### Lifecycle Transitions

```bash
kspec review open @review-ref      # draft → open
kspec review close @review-ref     # open → closed (or draft → closed)
kspec review archive @review-ref   # closed → archived (permanent)
```

### Refreshing Subject Context

When the reviewed code has been updated (e.g., new commits pushed):

```bash
kspec review refresh @review-ref --head new-commit-sha
kspec review refresh @review-ref --head new-head --base new-base
```

After refresh, verdicts and checks from the old version become stale.

### Task Linkage

Reviews integrate with the task lifecycle:

```bash
# Creating a task review auto-sets task.review_ref
kspec review add --title "Review" --subject-type task --subject-ref @task-ref

# Creating a code review with --related-ref also links the task
kspec review add --title "Code review" --subject-type code \
  --base abc --head def --related-ref @task-ref

# Find the active review for a task
kspec review for-task @task-ref

# Task get shows the review_ref if linked
kspec task get @task-ref
```

When a `request_changes` verdict is recorded on a task review, the task automatically transitions to `needs_work` if it was in `pending_review`.

## Review Checklist

Use this checklist when reviewing implementation against a spec:

### MUST-FIX (Blocks PR)

- [ ] Every own AC has at least one annotated test
- [ ] Every inherited trait AC has at least one annotated test (or N/A annotation)
- [ ] `kspec validate` reports no errors for this spec
- [ ] Implementation matches spec behavior (not just syntactically correct tests)
- [ ] No regressions — existing tests still pass

### SHOULD-FIX

- [ ] `kspec validate` warnings addressed (especially trait AC coverage)
- [ ] Undocumented behavior has spec coverage or is flagged
- [ ] Test annotations reference correct spec/trait refs

### SUGGESTION

- [ ] Tests are meaningful (would fail if feature breaks)
- [ ] Prefer E2E over unit where practical
- [ ] Tests run in isolation (temp dirs, not project repo)

## Severity Guide

| Finding | Severity | Action |
|---------|----------|--------|
| Missing own AC test annotation | MUST-FIX | Add test with `// AC: @spec-ref ac-N` |
| Missing trait AC test annotation | MUST-FIX | Add test with `// AC: @trait-slug ac-N` |
| `kspec validate` error | MUST-FIX | Fix the validation error |
| Implementation doesn't match spec | MUST-FIX | Fix implementation or update spec |
| `kspec validate` warning | SHOULD-FIX | Address warning |
| Undocumented behavior | SHOULD-FIX | Add AC or note deviation |
| Test doesn't prove its AC | SHOULD-FIX | Rewrite test |
| No E2E tests | SUGGESTION | Consider adding |

## Using in Project Reviews

This skill provides the kspec-specific gates. Wrap it in your project's review:

```
Project Review = kspec:review gates + project-specific gates
```

Project-specific gates to add in your own review skill:
- **Test commands** — How to run your test suite
- **Test patterns** — Project-specific test helpers and isolation patterns
- **Code style** — Naming, error handling, import conventions
- **E2E specifics** — How E2E tests work in your project
- **Regression check** — Full suite command and expectations

## Command Reference

```bash
# Create and query
kspec review add [options]              # Create a review record
kspec review get <ref>                  # Show review details
kspec review list [--status, --disposition, --subject-type, --reviewer, --task, --limit, --offset, --count]

# Comments and threads
kspec review comment <ref> [options]    # Add a comment thread
kspec review reply <ref> --thread <ulid> --body "..."
kspec review resolve <ref> --thread <ulid>
kspec review reopen <ref> --thread <ulid>

# Checks and verdicts
kspec review check <ref> [options]      # Record a check result
kspec review verdict <ref> [options]    # Set a reviewer verdict

# Lifecycle
kspec review open <ref>                 # draft → open
kspec review close <ref>                # → closed
kspec review archive <ref>              # → archived (permanent)

# Subject management
kspec review refresh <ref> --head <commit> [--base <commit>]

# Task integration
kspec review for-task <ref>             # Find reviews linked to a task
```

## Integration

- **`/kspec-task-work`** — Run review before submitting tasks; create review records during pending_review
- **`/kspec-writing-specs`** — If review reveals spec gaps, update specs first
- **`kspec validate`** — Automated validation complements manual review
- **`kspec task review @ref`** — Quick task context for review (details, spec, ACs, diff)
