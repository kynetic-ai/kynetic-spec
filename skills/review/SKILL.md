# Review

How to review work and use kspec review records. Covers both the reviewer perspective (creating reviews, structuring findings) and the worker perspective (reading feedback, addressing issues). Bakes in review principles, AC coverage verification, and the full review record interface.

## When to Use

- Reviewing submitted work (as reviewer)
- Reading and addressing review feedback (as worker)
- Creating or managing review records
- Verifying AC coverage before submitting work

## Two Perspectives

This skill serves both sides of the review process:

- **As a reviewer:** Create reviews, investigate code, structure findings as threads, record checks, submit verdicts
- **As a worker:** Read review threads, understand what's blocking, address findings, request re-review

Both perspectives use the same review record system.

---

## Review Principles

### Adversarial Investigation

**Worker claims are hypotheses, not facts.** When a commit message says "all tests pass," verify it. When a note says "fixed the type errors," check they're actually fixed and not suppressed. Workers are not lying — but they are biased toward believing their own work is correct. Your job is to independently verify.

**Read the code before the description.** Start by reading the diff — what changed, what was added, what was removed. Form your own understanding. Only then read the task notes or PR description and compare. This prevents anchoring bias.

**Treat justifications as claims to verify.** "Pre-existing issue," "out of scope," "will be addressed in follow-up," "this is the standard pattern" — these require evidence, not acceptance.

**A clean review is valid.** Not every submission has bugs. If you investigate thoroughly and find nothing wrong, approve. Do not invent findings to justify time spent. The goal is accuracy, not a finding quota.

### Cognitive Biases to Counteract

**Satisfaction of search** — After finding the first issue, your detection rate drops 25-50%. Finding one issue makes it MORE likely there are others. Deliberately increase scrutiny after your first finding.

**Complexity bias** — Simple-looking changes (renames, test rewrites, config changes) receive less scrutiny because they "look safe." These are where semantic bugs hide. Every submission gets the same investigation depth.

**Anchoring** — Don't frame analysis around the author's stated intent. Assess what the code actually does, not what the author says it does.

**Decision fatigue** — On the Nth review, reviewers default to approval. Every approval must be backed by specific evidence of verification.

### Structured Exploration

Before rendering any verdict, complete both deterministic and analytical checks:

**Deterministic checks** (run these, don't reason about them):
```bash
kspec item get @spec-ref                    # Own ACs + inherited trait ACs
kspec validate                              # Trait coverage warnings
# Run the project's test suite
grep -rn "AC: @spec-ref" tests/             # Own AC annotations (adapt path/syntax)
grep -rn "AC: @trait-" tests/               # Trait AC annotations
```

**Analytical checks** (require reading and judgment):
1. Read the diff — every changed file, not just the interesting ones
2. Read surrounding context — unchanged files that interact with changed code
3. Verify spec alignment — for each AC, confirm the code satisfies the behavior
4. Verify at least one worker claim independently
5. Search across categories — correctness, edge cases, error handling, security, test quality, integration

---

## AC Coverage Verification

### Own AC Coverage

Every acceptance criterion on the spec MUST have at least one annotated test.

```bash
# Get all ACs (own + inherited from traits)
kspec item get @spec-ref

# Search for annotations in test files (adapt to your language/paths)
grep -rn "AC: @spec-ref" tests/
```

Annotations use language-appropriate comment syntax:

```javascript
// AC: @spec-ref ac-1
it('should validate input', () => { ... });
```

```python
# AC: @spec-ref ac-1
def test_validates_input():
    ...
```

Before accepting coverage, confirm each annotation matches the AC text from `kspec item get` — not just the `ac-N` number. A test must actually prove the AC, not just touch the code path.

### Trait AC Coverage

When a spec implements traits, it inherits their ACs. Every inherited AC needs test coverage using the **trait's** ref:

```javascript
// AC: @trait-json-output ac-1
it('should output valid JSON with --json flag', () => { ... });
```

```bash
# kspec validate reports uncovered trait ACs
kspec validate
```

Any "inherited trait AC(s) without test coverage" warning is a blocker.

If a trait AC genuinely doesn't apply, annotate it with a reason:

```javascript
// AC: @trait-json-output ac-3 — N/A: this command has no tabular output
```

Annotations must be standalone line comments, not embedded in block comments.

### Spec Alignment

Implementation must match spec intent, not just pass tests:

1. **Implementation exists** — Code handles the described behavior
2. **Test exists** — A test validates the behavior
3. **Behavior matches** — The test actually proves the AC, not just syntactically passes

---

## Review Records

kspec stores first-party review records as durable artifacts in the shadow branch. They track the full lifecycle of reviewing work — threaded comments, check results, verdicts, and audit history.

### Review Lifecycle

```
draft → open → closed
                 ↓
              archived (terminal)
```

| State | Meaning |
|-------|---------|
| `draft` | Review created but not yet started |
| `open` | Active review in progress |
| `closed` | Review concluded (auto-closed on approve/request_changes verdict) |
| `archived` | Permanently archived |

**Auto-close on verdict:** When a reviewer submits an `approve` or `request_changes` verdict, the review record automatically transitions to `closed`. A `comment` verdict leaves the review open since it doesn't represent a final assessment. Each closed review is a point-in-time artifact.

### Per-Cycle Review Model

Each review cycle produces its own review record. This is analogous to individual PR reviews on GitHub — each review is a discrete artifact with its own verdict, and the collection of reviews across cycles comprises the full review history for the task.

**How it works:**
- When a task enters `pending_review`, the reviewer creates a **new** review record
- If a prior closed review exists, it remains as a historical artifact
- The task's `review_ref` is updated to point to the new record
- Historical reviews are accessible via `kspec review for-task @ref` (returns all linked reviews)

**Do NOT reopen old reviews.** Instead, create a fresh review for each cycle. This keeps each review's findings, verdict, and context self-contained.

### Disposition (Computed)

The disposition is computed from verdicts, checks, and threads — not set directly:

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

# Review committed code (requires base/head commits)
kspec review add --title "Review feature branch" \
  --subject-type code --base abc1234 --head def5678 \
  --base-branch main --head-branch feat/auth \
  --related-ref @task-add-auth

# Review a plan or spec
kspec review add --title "Review auth plan" \
  --subject-type plan --subject-ref @plan-auth
```

**Subject types:** `task`, `code`, `plan`, `spec`, `external`

### Structuring Findings as Threads

Each finding becomes a thread with a kind that determines its impact:

```bash
# Blocker — must be resolved before approval
kspec review comment @review-ref \
  --body "Missing error handling for invalid input" --kind blocker

# Question — non-blocking, needs clarification
kspec review comment @review-ref \
  --body "Why was this approach chosen over X?" --kind question

# Nit — non-blocking, minor suggestion (default)
kspec review comment @review-ref \
  --body "Consider renaming this variable" --kind nit
```

**Thread kinds:** `blocker` (blocks approval), `question` (non-blocking), `nit` (non-blocking, default).

Only blocker threads affect disposition. Unresolved nits and questions do not block approval.

#### Code-Targeted Comments

Anchor findings to specific lines for code reviews:

```bash
kspec review comment @review-ref --body "Off-by-one error" --kind blocker \
  --path src/parser/validate.ts --side head --line-start 42 --line-end 42 \
  --commit def5678
```

#### Structured Anchors (for plans/specs)

```bash
kspec review comment @review-ref --body "AC is too vague" --kind blocker \
  --section acceptance_criteria --field ac-3 --anchor-ref @spec-ref
```

### Recording Checks

Checks record verification evidence bound to the reviewed state:

```bash
# Passing test run
kspec review check @review-ref --name "vitest" --status pass \
  --runner vitest --evidence "All 342 tests passed" \
  --version-base abc1234 --version-head def5678

# Failing check
kspec review check @review-ref --name "lint" --status fail \
  --runner eslint --evidence "3 errors found" \
  --version-base abc1234 --version-head def5678

# Informational (non-required) check
kspec review check @review-ref --name "coverage" --status pass \
  --no-required --evidence "87% coverage" \
  --version-base abc1234 --version-head def5678
```

**Check statuses:** `pass`, `fail`, `running`, `skipped`

Checks whose `applies_to_version` does not match the current subject version are stale.

### Submitting Verdicts

Verdicts record individual reviewer decisions:

```bash
# Approve
kspec review verdict @review-ref --decision approve \
  --reviewer agent@example.com \
  --version-base abc1234 --version-head def5678

# Request changes (triggers needs_work on linked task)
kspec review verdict @review-ref --decision request_changes \
  --reviewer agent@example.com \
  --version-base abc1234 --version-head def5678

# Comment (non-blocking)
kspec review verdict @review-ref --decision comment \
  --reviewer agent@example.com \
  --version-base abc1234 --version-head def5678
```

Verdicts are per-reviewer. A later verdict from the same reviewer replaces the earlier one for the same version. Verdicts not matching the current subject version are stale.

### Replying and Resolving Threads

```bash
# Reply to a thread
kspec review reply @review-ref --thread <thread-ulid> \
  --body "Fixed in commit abc1234"

# Resolve a thread
kspec review resolve @review-ref --thread <thread-ulid>

# Reopen if fix was insufficient
kspec review reopen @review-ref --thread <thread-ulid>
```

### Fix Cycles (Re-review After Changes)

When a task returns to `pending_review` after a fix cycle, the reviewer creates a **new** review record rather than updating the old one:

```bash
# The old review is already closed (auto-closed on verdict)
# Create a fresh review for the new cycle
kspec review add --title "Review task-foo (cycle 2)" \
  --subject-type task --subject-ref @task-foo

# The task's review_ref now points to this new review
# The prior review remains accessible via for-task
kspec review for-task @task-foo  # Shows all reviews, current + historical
```

If dispatch workspace metadata is available, the new review's orientation will include a diff summary showing what changed since the prior review's examined commit.

**Subject refresh** is still available for within-cycle updates (e.g., reviewer pushes a minor fix before verdicting):

```bash
kspec review refresh @review-ref --head new-commit-sha
```

### Task Integration

Reviews integrate with the task lifecycle:

- Creating a task review auto-sets `task.review_ref` to the new review
- A `request_changes` verdict auto-transitions `pending_review` tasks to `needs_work` and auto-closes the review
- An `approve` verdict auto-closes the review
- `kspec review for-task @ref` finds **all** linked reviews (current + historical)

---

## Finding Validation

Before emitting any finding, apply the **claim-disprove-emit** cycle:

1. **State the claim.** What exactly is wrong? Be specific: file, line, behavior.
2. **Try to disprove it.** Look for evidence the code is correct — guard clauses, tests covering the case, spec decisions justifying the approach.
3. **If disproved, drop it.** Dropped candidates are the process working correctly.
4. **If still valid, assess severity and confidence.**

### Finding Quality

Every finding must include:
- **Path and line** — exactly where the issue is
- **Claim** — what is wrong, stated precisely
- **Impact** — what breaks, what guarantee is lost
- **Evidence** — what you observed that proves the claim

### Severity Guide

| Severity | When to use |
|----------|-------------|
| **MUST-FIX** | Correctness, security, spec violation, coverage loss. High or medium confidence required. |
| **SHOULD-FIX** | Likely correctness issue, missing boundary case, fragile code. |
| **SUGGESTION** | Pure style, naming, formatting. Zero correctness implications. |

**Default to MUST-FIX.** Only downgrade when you are certain the issue is cosmetic.

---

## As a Worker: Reading Review Feedback

When your task is in `needs_work`:

```bash
# Find all reviews for the task (current + historical)
kspec review for-task @ref

# Read the most recent review (the one that kicked back to needs_work)
kspec review get @review-ref

# Focus on blocker threads — these must be resolved
# Address questions and nits where reasonable
# Reply to threads explaining your fix
kspec review reply @review-ref --thread <ulid> --body "Fixed in commit abc1234"
```

**Historical context:** If the task has been through multiple fix cycles, `kspec review for-task @ref` returns all reviews. Each is a closed artifact with its own findings and verdict. Read prior reviews to understand the full review history and avoid re-introducing previously flagged issues.

After fixing:
```bash
kspec task submit @ref  # Back to pending_review — reviewer creates a new review record
```

---

## Reviewer Workflow Summary

1. **Discover context** — `kspec task get @ref`, `kspec item get @spec-ref`
2. **Create review** — `kspec review add --subject-type task --subject-ref @ref` (creates a new record each cycle)
3. **Open review** — `kspec review open @review-ref`
4. **Investigate** — deterministic checks, then analytical checks
5. **Record findings** — `kspec review comment` for each finding with appropriate kind
6. **Record checks** — `kspec review check` for test/lint results
7. **Submit verdict** — `kspec review verdict` (approve or request_changes — auto-closes the review)

---

## CLI Lookups

| Need | Command |
|------|---------|
| Spec + all ACs (own + inherited) | `kspec item get @spec-ref` |
| Trait definition + ACs | `kspec item get @trait-slug` |
| Review details | `kspec review get @review-ref` |
| Reviews for a task | `kspec review for-task @task-ref` |
| All open reviews | `kspec review list --status open` |
| Search by keyword | `kspec search "keyword"` |
| All traits | `kspec trait list` |
| Validation | `kspec validate` |

## Command Reference

```bash
# Create and query
kspec review add [options]              # Create a review record
kspec review get <ref>                  # Show review details
kspec review list [--status, --disposition, --subject-type, --reviewer, --task]
kspec review for-task <ref>             # Find reviews linked to a task

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
```

## Integration

- **`{skill:task-work}`** — Workers read review feedback during fix cycles
- **`{skill:merge}`** — Merge gate checks review disposition before merging
- **`{skill:writing-specs}`** — If review reveals spec gaps, update specs first
- **`kspec validate`** — Automated validation complements manual review
