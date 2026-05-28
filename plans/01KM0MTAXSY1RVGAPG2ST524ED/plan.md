# Review Version Auto-Derivation

## Problem

Review verdicts and checks require callers to pass `applies_to_version` explicitly via `--version-base`/`--version-head` or `--version-hash` flags. This is wrong for two reasons:

1. **Reviews are per-cycle snapshots.** A review's subject is frozen at creation time. Every verdict and check on that review applies to that same subject version. There is no reason for callers to specify a different version — the review already knows what it's reviewing.

2. **Type mismatches corrupt disposition computation.** The reviewer agent creates task-subject reviews (entity_version) but stamps verdicts/checks with code_compare versions (from the branch it reviewed). The shared `computeDisposition` treats these as stale due to type mismatch, making every approved review appear as `changes_requested` in the web UI. The CLI masks this with a naive local `computeDisposition` that ignores staleness entirely.

**Impact:** 76 of 110 reviews are approved per the CLI's naive calculation, but the daemon (using the correct shared logic) shows only 4 approved. The reviews index is effectively broken — approved work is invisible.

## Spec Changes

### @review-cli-mutation-commands

**ac-2 (checks):** Currently says "with the current compare context" implying callers pass version info. Should say the version is auto-derived from the review's subject. The `--version-base`, `--version-head`, and `--version-hash` flags are removed. The review already knows its subject version.

**ac-3 (verdicts):** Same issue — "compare context" language implies external version. Should say the verdict's `applies_to_version` is derived from the review subject automatically. No version flags accepted.

**Reasoning:** The daemon API already auto-derives versions for both verdicts (line 162 of review-operations.ts) and checks (line 915 of reviews.ts routes). The CLI should match. Callers should never need to know or care about the version type of the subject they're reviewing.

### @review-verdicts-and-resolution-lifecycle

**ac-1:** Says verdicts are recorded "with the applies_to_version context (base_commit and head_commit)". This incorrectly assumes code subjects. Should say `applies_to_version` is derived from the review's subject type — code_compare for code subjects, entity_version for task/plan/spec subjects. The caller does not provide this; the system derives it.

**ac-5:** References "base_commit and head_commit for code subjects, or content_hash for entity subjects" — this is correct as documentation of the version types, but should clarify these are derived from the subject, not provided by the verdict submitter.

**ac-7:** Staleness detection is correct as-is. The issue isn't the staleness logic — it's that mismatched version types were being created in the first place.

### @review-cli-commands

**ac-2:** References "computed disposition" and "computed gate state" — these should use the shared library functions, not local naive reimplementations. The CLI has its own `computeDisposition` and `computeGateState` that ignore version staleness and gate evaluation. These must be replaced with the shared versions from `review-operations.ts` and `checks.ts`.

### @review-subject-bindings

No changes needed. The subject binding and staleness specs are correct — the bug is in the CLI not respecting them.

## Tasks

```yaml
- title: Update specs for review version auto-derivation
  slug: task-spec-review-version-auto-derive
  priority: p1
  description: |
    Update acceptance criteria on three specs to reflect that
    applies_to_version is always auto-derived from the review subject,
    never passed by callers:

    @review-cli-mutation-commands ac-2: Change "with the current compare
    context" to say the version is auto-derived from the review's
    subject. Remove implication that --version-base/--version-head/
    --version-hash flags exist.

    @review-cli-mutation-commands ac-3: Same — remove "compare context"
    language, say applies_to_version is derived from the review subject
    automatically.

    @review-verdicts-and-resolution-lifecycle ac-1: Change "with the
    applies_to_version context (base_commit and head_commit)" to say
    applies_to_version is derived from the review's subject type —
    code_compare for code subjects, entity_version for task/plan/spec.
    The caller does not provide this.

    @review-verdicts-and-resolution-lifecycle ac-5: Clarify that the
    version types described (base_commit/head_commit for code,
    content_hash for entity) are derived from the subject, not provided
    by the verdict submitter.

    @review-cli-commands ac-2: Add that computed disposition and gate
    state must use the shared library functions from
    src/parser/review-operations.ts and src/review/checks.ts, not
    local reimplementations.
  why: |
    Current AC language says "with the current compare context" which
    implies callers provide version info. This led to the CLI exposing
    --version-base/--version-head/--version-hash flags that agents use
    incorrectly, creating type mismatches that corrupt disposition
    computation. Specs must be corrected before changing behavior.
  how: |
    Use kspec item ac set to update each AC listed above. The key
    change in each is removing language that implies callers provide
    version context and replacing it with language that says the system
    derives it from the review subject.
  tags: [spec, review]

- title: Remove version flags from CLI review verdict command
  slug: task-cli-verdict-auto-version
  priority: p1
  depends_on: ["@task-spec-review-version-auto-derive"]
  description: |
    Remove --version-base, --version-head, and --version-hash from the
    kspec review verdict command in src/cli/commands/review.ts. Replace
    the manual verdict construction with a call to submitVerdict() from
    src/parser/review-operations.ts, which auto-derives
    applies_to_version via extractSubjectVersion(review.subject).

    Currently the CLI verdict command (line 993 of review.ts) calls
    parseVersionFromOptions() to build a version from caller-provided
    flags, then manually constructs the verdict object (lines 995-1001).
    The daemon API already uses submitVerdict() correctly
    (packages/daemon/src/routes/reviews.ts line 771).
  why: |
    The CLI manually constructs verdicts with caller-provided versions.
    When the reviewer agent creates a task-subject review but passes
    code branch commits as --version-base/--version-head, the verdict
    gets a code_compare version on an entity_version subject. The
    shared computeDisposition() in src/parser/review-operations.ts
    treats this type mismatch as stale, making approved reviews appear
    as changes_requested in the daemon and web UI.
  how: |
    1. Remove the three --version-* option definitions from the verdict
       command (lines 970-972 of src/cli/commands/review.ts)
    2. Remove the parseVersionFromOptions call (line 993)
    3. Restructure the mutateReviewAtomically callback to use the
       daemon's two-step pattern (see reviews.ts:770-783):
       a. Call submitVerdict(latest, { reviewer, decision, role }) to
          get the record with the verdict appended and correct
          applies_to_version
       b. Conditionally call transitionLifecycle(withVerdict, 'closed',
          reviewer) on the result for auto-close
       The current flat spread that builds verdict + auto-close in one
       object won't work because submitVerdict owns the verdict
       construction including applies_to_version derivation.
    4. Keep the task transition logic (handleVerdictTaskTransition)
       after the atomic mutation, same as today
    5. Update tests that pass version flags to verdict commands —
       remove version flags and verify the auto-derived version
       matches the review subject type
  tags: [cli, review, bug]

- title: Remove version flags from CLI review check command
  slug: task-cli-check-auto-version
  priority: p1
  depends_on: ["@task-spec-review-version-auto-derive"]
  description: |
    Remove --version-base, --version-head, and --version-hash from the
    kspec review check command in src/cli/commands/review.ts. Replace
    the caller-provided version with auto-derivation via
    extractSubjectVersion(review.subject) from
    src/review/subject-bindings.ts.

    Currently the CLI check command (line 915 of review.ts) calls
    parseVersionFromOptions() to build a version from caller-provided
    flags. The daemon API already auto-derives correctly
    (packages/daemon/src/routes/reviews.ts line 915).

    Also delete parseVersionFromOptions() (line 412 of review.ts) —
    verified that review refresh uses its own --head/--base flags with
    different semantics and does not call this function. After both the
    verdict and check tasks, it will have zero callers.
  why: |
    Same root cause as the verdict command — callers pass wrong version
    types, creating type mismatches between applies_to_version and the
    review subject. The daemon check endpoint already auto-derives via
    extractSubjectVersion(). The CLI should match.
  how: |
    1. Remove the three --version-* option definitions from the check
       command (lines 891-893 of src/cli/commands/review.ts)
    2. Remove the parseVersionFromOptions call (line 915)
    3. Import extractSubjectVersion from
       src/review/subject-bindings.ts and use
       extractSubjectVersion(found.subject) for applies_to_version
    4. Delete parseVersionFromOptions() (line 412) — zero remaining
       callers after this task
    5. Update tests that pass version flags to check commands —
       remove version flags and verify the auto-derived version
       matches the review subject type
  tags: [cli, review, bug]

- title: Replace CLI local computeDisposition with shared implementation
  slug: task-cli-shared-disposition
  priority: p1
  depends_on: ["@task-cli-verdict-auto-version"]
  description: |
    Replace the naive local computeDisposition (line 117 of
    src/cli/commands/review.ts) and computeGateState (line 132) with
    the shared implementations: computeDisposition from
    src/parser/review-operations.ts and evaluateGates from
    src/review/checks.ts.

    The local computeDisposition ignores version staleness, gate state,
    and unresolved blockers — it just checks if any verdict is
    request_changes or approve. The local computeGateState ignores
    version staleness on checks.

    The shared computeDisposition considers effective verdicts (filtered
    by version staleness), gate evaluation, and unresolved blocker
    threads. The shared evaluateGates handles check staleness and
    returns a GateEvaluationResult object (not a string).
  why: |
    The CLI, daemon (packages/daemon/src/routes/reviews.ts), and web
    UI must agree on disposition and gate state. The local
    reimplementations produce different results — the CLI shows 76
    approved reviews while the daemon shows 4. This makes the CLI
    output unreliable and masks data inconsistencies.
  how: |
    1. Remove the local computeDisposition function (lines 117-126
       of src/cli/commands/review.ts)
    2. Remove the local computeGateState function (lines 132-137)
    3. Import computeDisposition from ../parser/review-operations.js
    4. Import evaluateGates from ../review/checks.js and
       extractSubjectVersion from ../review/subject-bindings.js
    5. Replace computeGateState calls with evaluateGates + version
       extraction. evaluateGates returns a GateEvaluationResult object
       (with .state, .checks, .summary) — extract .state for the
       current gate_state string usage
    6. Verify all review list and detail output uses the shared logic
    7. This intentionally changes semantics for reviews with no
       required checks — gate_state goes from "pending" to "passing"
       (vacuous truth: no gates to fail = passing). This aligns with
       the daemon. Update any tests that assert "pending" for
       check-less reviews.
  tags: [cli, review, bug]

- title: Update review skill documentation
  slug: task-review-skill-version-docs
  priority: p1
  depends_on: ["@task-cli-check-auto-version"]
  description: |
    Update the review skill source at templates/skills/review/SKILL.md
    to remove --version-base and --version-head from all verdict and
    check command examples (lines 280-317 of SKILL.md). Update
    explanatory text to say versions are auto-derived from the review
    subject. Run kspec skill render to regenerate the rendered output
    at .agents/skills/kspec-review/SKILL.md.

    Current examples teach agents to pass version flags on every
    verdict and check command, which is the direct cause of agents
    creating mismatched applies_to_version types.
  why: |
    The skill documentation is the primary interface agents use to
    learn CLI commands. If the --version-* flags are removed from the
    CLI (in @task-cli-verdict-auto-version and
    @task-cli-check-auto-version) without updating the skill, agent
    invocations will fail on unrecognized flags. The skill must match
    the CLI surface.
  how: |
    1. Edit templates/skills/review/SKILL.md
    2. Remove --version-base and --version-head from all check examples
       (lines 280-292)
    3. Remove --version-base and --version-head from all verdict
       examples (lines 305-317)
    4. Update the explanatory text near those examples — explain that
       applies_to_version is auto-derived from the review subject, so
       callers don't need to provide version info
    5. Run kspec skill render to regenerate .agents/skills/
    6. Commit both the source and rendered output together
  tags: [docs, review, skill]

- title: Remediate existing review data with version mismatches
  slug: task-remediate-review-versions
  priority: p1
  depends_on: ["@task-cli-verdict-auto-version", "@task-cli-check-auto-version"]
  description: |
    Write a one-time migration script to fix applies_to_version on
    existing verdicts and checks that have type mismatches with their
    review's subject. Of 110 existing reviews, the daemon computes
    only 4 as approved (correct: 76) because verdicts/checks were
    stamped with code_compare versions on task-subject reviews.

    The daemon computes disposition dynamically via computeDisposition()
    in src/parser/review-operations.ts, so correcting the stored
    applies_to_version will immediately fix the web UI display without
    any daemon code changes.
  why: |
    After the CLI fix (@task-cli-verdict-auto-version and
    @task-cli-check-auto-version), new reviews will have correct
    versions, but the 110 existing reviews will remain broken in the
    web UI. The data must be corrected for the reviews index to show
    accurate dispositions.
  how: |
    1. Write a script that loads all review records from the shadow
       branch via loadReviewRecords()
    2. For each review, extract the subject version via
       extractSubjectVersion(review.subject) from
       src/review/subject-bindings.ts
    3. For each verdict and check, compare applies_to_version.type
       with the subject version type
    4. If mismatched in either direction (code_compare on entity
       subject, or entity_version on code subject), replace
       applies_to_version with the version derived from the review
       subject. Note: if the review subject itself has changed since
       the verdict was created (e.g. via refreshSubject), the
       corrected version will still be "stale" relative to the
       current subject — this is correct behavior, not a bug
    5. Save the corrected reviews and commit to shadow branch
    6. Verify daemon API now returns correct dispositions by querying
       GET /api/reviews?status=all and checking disposition counts
    7. Delete the script after use — it's a one-time fix
  tags: [data, review, migration]
```

## Implementation Notes

**Ordering matters.** The spec task must go first because the other tasks change behavior that the current ACs describe. The verdict and check tasks are independent of each other. The shared disposition task depends on the verdict task because it touches the same file. The skill docs task depends on the check task to avoid documenting flags that still exist. The data remediation runs last after both CLI commands are fixed.

**parseVersionFromOptions** will have zero callers after the verdict and check tasks. Verified: `review refresh` has its own `--head`/`--base` flags with different semantics and does not use `parseVersionFromOptions`. Delete it unconditionally in the check task (last to remove a caller).

**Test impact.** Any test that calls `kspec review verdict` or `kspec review check` with `--version-base`/`--version-head` will break. These tests should be updated to not pass version flags and instead verify the auto-derived version matches the review subject.

**No schema changes.** The ReviewVerdict and ReviewCheck types still have `applies_to_version` — the field isn't removed, just auto-populated. The ReviewSubjectVersion union type is unchanged.

**Gate state semantic change.** Replacing the local `computeGateState` with the shared `evaluateGates` changes behavior for reviews with zero required checks: gate_state goes from `"pending"` to `"passing"`. This is intentional — vacuous truth (no gates to fail = passing) is the correct semantics and matches the daemon. Tests asserting `"pending"` for check-less reviews should be updated.
