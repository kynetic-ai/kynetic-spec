# Plan Review

Review a plan document for quality, completeness, and readiness before approval and derivation. Covers spec quality, task quality, dependency ordering, and alignment with the existing spec system.

## When to Use

- Before approving a plan for derivation
- After significant edits to a draft plan
- When a plan has been through iteration and needs a final check

**Not for:** Reviewing task work or PRs (use `{skill:review}`), writing specs (use `{skill:writing-specs}`), or creating plans (use `{skill:plan}`).

## Review Process

### Step 1: Read the Plan

Read the full plan document. Understand the scope, the specs being introduced, and the tasks that implement them. Form your own understanding before checking details.

### Step 2: Review Specs Against Existing System

This is the most important step. New specs don't exist in isolation — they join an existing spec hierarchy with established conventions, boundaries, and terminology.

**Check for conflicts and overlaps:**
```bash
# For each new spec, search for related existing specs
kspec search "<keywords from spec title/description>"

# Get existing specs in the same module
kspec item list --under @parent-module

# Check existing specs that the plan interacts with
kspec item get @referenced-spec
```

For each new spec, answer:
- Does an existing spec already cover this behavior (even partially)?
- Does this spec's description or ACs contradict an existing spec?
- Are parent references valid and appropriate in the hierarchy?
- Would this spec be better as ACs on an existing spec rather than a new one?

**Check trait usage:**
- Are traits referenced with `@` prefix?
- Are the chosen traits appropriate for each spec?
- Are there cross-cutting behaviors in the ACs that should be traits instead?

### Step 3: Review Spec Quality

Each spec should be a standalone, timeless behavioral contract.

**Descriptions:**
- Describe what the system does, not how it differs from a previous version
- No implementation details (class names, file paths, protocol terms)
- No "supersedes," "replaces," or "non-goals" language
- Purpose and behavior should be clear to someone unfamiliar with the codebase

**Acceptance criteria:**
- Each AC is a single testable assertion (not compound)
- Given/when/then describe observable behavior, not internal mechanisms
- No implementation details — use natural language, not field names or code terms
- No rationale or commentary — assertions only
- No cross-references to other specs within AC text (use spec fields for relationships)

**Atomicity check — split if:**
- An AC has "and" connecting two independently verifiable outcomes
- An AC's "then" clause describes multiple distinct behaviors
- You could write two separate tests for one AC

**Completeness check:**
- Are there behaviors described in the spec description but not covered by ACs?
- Are error/failure cases covered?
- Are boundary conditions addressed?

### Step 4: Review Tasks

Tasks are implementation guidance. Unlike specs, they should contain concrete technical detail — the what, why, and how of implementation.

**Standalone check:**
Each task should be executable by an agent with no context beyond the task description and the spec it references. Ask: if someone picked up this task in a fresh session with no chat history, would they know what to do?

- **What:** Concrete deliverables — what changes, what gets created
- **Why:** Motivation — why this task exists, why it's needed now
- **How:** Implementation approach — files to touch, patterns to follow, technical strategy

**Red flags in tasks:**
- "See discussion above" or similar references to plan context not in the task
- Vague scope ("implement the feature") without concrete boundaries
- Missing why — the task says what to do but not why it matters
- No "Covers:" line linking back to specific ACs

**Coverage check:**
- Every AC across all specs should be claimed by at least one task's "Covers:" line
- If an AC is covered by multiple tasks, the division of responsibility should be clear
- Orphan ACs (not claimed by any task) will not get implemented

### Step 5: Review Dependency Ordering

Task dependencies define execution order. Getting this wrong means tasks are attempted before their prerequisites exist.

**Dependency graph analysis:**
- Map out the dependency chain: which tasks block which
- Check for circular dependencies (A depends on B depends on A)
- Check for missing dependencies — does task X use something that task Y creates, but X doesn't depend on Y?
- Check for over-constraining — does a dependency exist that isn't actually needed, artificially serializing work that could be parallel?

**Priority alignment:**
- Higher priority tasks (P1) should generally not depend on lower priority tasks (P2/P3)
- If a P2 task depends on a P1 task, that's fine — lower priority work builds on foundations
- If a P1 task depends on a P2 task, something is likely misordered

**Parallelism opportunities:**
- Tasks at the same priority level with no dependencies between them can run in parallel
- Look for tasks that are serialized by dependency but don't actually need to be
- Look for tasks that should be serialized but aren't (one uses output of another without declaring the dependency)

### Step 6: Cross-Reference Validation

Verify all internal references resolve:

- `spec_ref` values in tasks point to specs defined in this plan or existing specs
- `depends_on` values in tasks point to tasks defined in this plan or existing tasks
- `parent` values in specs point to specs in this plan or existing specs
- "Covers:" lines reference AC IDs that actually exist on the referenced spec
- AC numbering is sequential with no gaps or duplicates within each spec

### Step 7: Format Check

- YAML uses block scalars (`|`) for all multi-line AC text
- Traits use `@` prefix
- `derive_from_specs` directive is present in the Tasks section
- Parent, spec_ref, and depends_on references use `@` prefix

## Recording the Review

Plan reviews use the same kspec review record system as task/code reviews. This creates a durable audit trail of what was checked, what was found, and what the verdict was.

### Create the Review Record

```bash
kspec review add \
  --title "Plan review: <plan title>" \
  --subject-type plan \
  --subject-ref @plan-ref
```

### Structure Findings as Threads

Each finding becomes a comment thread with a severity level:

```bash
# MUST-FIX finding
kspec review comment @review-ref \
  --severity blocker \
  --message "ac-3 and ac-4 overlap — both describe idle timeout behavior"

# SHOULD-FIX finding
kspec review comment @review-ref \
  --severity suggestion \
  --message "task-multi-turn-invocation covers 10 ACs — consider splitting"

# Record a check that passed
kspec review check @review-ref \
  --name "AC coverage" \
  --status pass \
  --detail "All 17 ACs claimed by at least one task"
```

### Severity Mapping

| Plan review severity | Review thread severity |
|---------------------|----------------------|
| MUST-FIX | `blocker` |
| SHOULD-FIX | `suggestion` or `concern` |
| SUGGESTION | `suggestion` or `nitpick` |

### Verdict

After findings are addressed (or accepted):

```bash
# Approve — plan is ready for derivation
kspec review verdict @review-ref --disposition approved \
  --summary "Specs are behavioral, tasks are standalone, deps are ordered"

# Request changes — issues need fixing before approval
kspec review verdict @review-ref --disposition needs_work \
  --summary "3 MUST-FIX items: compound ACs, missing coverage, broken refs"
```

### Review Lifecycle

```
create review → add findings as threads → add check results → submit verdict
                                              ↓
                              if needs_work: author fixes → re-review
                              if approved: plan ready for kspec plan set --status approved
```

The review record links to the plan via `subject-ref`. Use `kspec review for-task @plan-ref` pattern (or `kspec review list --subject @plan-ref`) to find reviews for a plan.

## Reporting

When reporting findings directly (without a review record), group by severity:

**MUST-FIX** — Blocks approval. Factual errors, missing coverage, broken references, spec conflicts.

**SHOULD-FIX** — Quality improvement. Compound ACs, unclear task descriptions, missing dependencies, spec boundary overlap.

**SUGGESTION** — Optional enhancement. Style improvements, additional ACs for edge cases, documentation clarity.

For each finding, state:
- What the issue is
- Where it is (spec slug + AC ID, or task slug)
- What to do about it

## Integration

- **`{skill:plan}`** — Plan authoring, where these quality checks should be applied during writing
- **`{skill:writing-specs}`** — Detailed spec quality rules, especially behavioral language
- **`{skill:review}`** — Task/PR review after implementation begins
- **Codex review** — Can be run in parallel for a second perspective: `/codex review-plan @plan-ref`
