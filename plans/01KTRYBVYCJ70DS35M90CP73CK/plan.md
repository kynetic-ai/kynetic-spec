# Validation and Test Coverage Integrity

## Specs

```yaml
[]
```

No new specs. Every behavioral contract touched by this plan already exists and is
implemented: `@validation-task-data-source` (storage-layout-agnostic reference checking,
from `@plan-spec-catalog-health-and-validation-trust`), `@plan-validation` (dangling
plan reference detection), `@triage-daemon-api` (triage REST/WebSocket API), and
`@fuzzy-item-search` ac-7 (search covers inbox and meta entities). This plan closes the
test-coverage and test-infrastructure gaps against those existing contracts. The test
runner cache fix is deliberately spec-less: test-infrastructure rules belong in the
project testing convention, not in spec acceptance criteria.

## Tasks

derive_from_specs: false

```yaml
- title: Re-enable split-storage dangling-reference validation test
  slug: task-reenable-split-storage-ref-validation-test
  priority: 2
  tags: [testing, validation, tasks]
  spec_ref: "@validation-task-data-source"
  description: |
    Re-enable and extend the skipped validation test at
    tests/task-plan-ref.test.ts:148 ("should warn when plan_ref points to
    non-existent plan").

    Why: The skip comment says "kspec validate doesn't load per-task detail
    files in split format, so can't detect dangling plan_ref". That was true
    when the test was written (commit 147d25b6b4, 2026-03-25), but the blind
    spot was closed a month later by the Spec Catalog Health work (commits
    87c41864b7, 2525fa93d5, b8aed7ebb9, 2026-04-24): validate() now loads
    tasks through the canonical TaskDataManager, so split-storage task detail
    files (including plan_ref, spec_ref, depends_on) participate in reference
    validation. The test was never re-enabled, so the core reference-integrity
    promise for split storage has zero regression coverage. If the canonical
    load path ever regresses, nothing fails.

    What: Re-enable the test, fix its stale expectations, and extend it to
    cover the whole class of task reference fields in split storage
    (plan_ref, spec_ref, depends_on), not just plan_ref.

    Code-reading findings (verified against current source — trust but
    re-verify the line numbers):
    - src/parser/validate.ts validate() (~lines 2405-2464): non-legacy
      projects load tasks via resolveTaskDataManager().loadAllTasks(ctx);
      validatePerTaskFiles() additionally feeds partial tasks (malformed
      records skipped by loadAllTasks) into ref validation.
    - src/parser/refs.ts REF_FIELDS (~line 407) includes depends_on,
      spec_ref, and plan_ref; plan targets resolve because validate()
      builds the ReferenceIndex with loadPlans() output (validate.ts ~2555).
    - Default validation.strict_refs is TRUE (src/parser/config.ts ~518),
      so a dangling ref is an ERROR and kspec validate exits non-zero. The
      skipped test calls the success-asserting kspec() helper and expects
      "warn" semantics — that is why it cannot be un-skipped as-is. The
      re-enabled test must use kspecRun(..., { expectFail: true }) and
      assert the combined stdout/stderr contains the dangling ref (e.g.
      "@nonexistent-plan") and a not-found message.

    Spec-reality drift found during verification: @plan-validation ac-10's
    Then clause says "Validation warns about dangling plan reference" (and
    the spec description says "warn about dangling references"), but
    validation.strict_refs defaults to true, so the implemented behavior —
    and what the re-enabled test asserts — is an ERROR with non-zero exit
    by default. Update the spec to match reality as part of this task
    (same policy as the triage AC correction in this plan):
    - Set ac-10's Then text, verbatim: "Validation reports the dangling
      plan reference as a finding — an error with non-zero exit when
      strict references mode is active (the default), a warning otherwise"
    - Update the spec description: replace "warn about dangling references
      to non-existent plans" with "report dangling references to
      non-existent plans as validation findings"
    Use kspec item ac set / kspec item set for these edits.
    @validation-task-data-source's ACs are already behavior-neutral
    ("contributes to validation findings") and need no change.

    How: Keep the test's approach of manually editing the per-task file
    (tasks/<ulid>/task.yaml under the temp specDir) to inject the dangling
    ref — this is the correct way to bypass CLI-time ref validation. Find
    the task ULID from project.tasks.yaml (index) as the test already does.
    Add sibling cases for a dangling spec_ref and a dangling depends_on
    entry injected the same way, asserting each is reported. Remove the
    TODO comment. Annotate the tests with all three covered ACs:
    AC: @plan-validation ac-10,
    AC: @validation-task-data-source ac-task-references-checked, and
    AC: @validation-task-data-source ac-all-persisted-tasks-included.
    The third annotation is justified because the dangling ref is injected
    directly into the persisted per-task detail file, so the finding can
    only surface if validation included that persisted record in its task
    set — the test is direct evidence the split-storage record participates.

    If a re-enabled case genuinely fails, that is a real regression in the
    canonical validation load path — fix it in src/parser/validate.ts /
    src/parser/refs.ts rather than re-skipping (root cause, not symptom).

    Testing: full npm test passes; tests/task-plan-ref.test.ts contains no
    it.skip entries afterwards.

    Covers: @plan-validation ac-10, @validation-task-data-source
    ac-task-references-checked, @validation-task-data-source
    ac-all-persisted-tasks-included.

- title: Port triage API coverage to vitest daemon integration tests
  slug: task-daemon-triage-api-tests
  priority: 2
  tags: [testing, daemon, api, triage]
  spec_ref: "@triage-daemon-api"
  description: |
    Replace the fully-skipped triage API E2E suite with vitest daemon
    integration tests, then delete the skipped suite.

    Why: tests/e2e/api-triage.spec.ts:163 wraps the entire "Triage API"
    suite (37 tests) in test.describe.skip with the note "Migrating from
    E2E to vitest daemon integration tests" — but the migration never
    happened. Verified current vitest coverage of the triage routes is
    only: one promote write-through test
    (tests/daemon-triage-write-through.test.ts) and one error-shape case
    (tests/daemon-api/errors.test.ts:167). @triage-daemon-api ac-1 through
    ac-9 are implemented but effectively unverified. The infrastructure
    for the migration already exists: tests/daemon-api/helpers.ts
    createTestApp() registers createTriageRoutes and the directory has
    established patterns (makeRequest, requestJson, captureBroadcasts).

    What: Create tests/daemon-api/triage.test.ts covering the endpoints
    implemented in packages/daemon/src/routes/triage.ts:
    - GET  /api/triage            (list: sorted created_at desc, status
                                   filter, pagination limit/offset, total)
    - GET  /api/triage/export     (format parameter: format=json —
                                   structured JSON, the default — vs
                                   format=context — markdown context
                                   output for agent handoff; the skipped
                                   suite tests ?format=context)
    - POST /api/triage            (record decision: item_snapshot created,
                                   404 for nonexistent inbox_ref,
                                   validation errors for invalid action /
                                   missing fields)
    - GET  /api/triage/:ref       (single record; 404 with guidance for
                                   unknown ref)
    - POST /api/triage/:ref/override (stores override_reasoning,
                                   override_by, override_at, updates action)
    - POST /api/triage/:ref/act   (executes action, transitions to
                                   acted_on, sets result_ref; 409 when
                                   already acted_on; 422 when status is
                                   pending)
    Port the assertions from the skipped suite (it annotates
    @triage-daemon-api ac-1..ac-9 plus @trait-api-endpoint and
    @trait-websocket-protocol ACs — keep those AC annotations and the N/A
    annotations from the suite header, updating N/A reasons that referenced
    the E2E context). Use captureBroadcasts(pubsub) to assert
    triage:updates broadcasts on the three mutation routes. After the new
    suite passes, delete tests/e2e/api-triage.spec.ts entirely.

    Spec-reality drift found during verification: @triage-daemon-api ac-4,
    ac-5, ac-8, and ac-9 all describe PUT requests, but the implementation
    uses POST /api/triage/:ref/override and POST /api/triage/:ref/act:
    - ac-4: "a PUT request is sent to /api/triage/:ref with override
      fields" → POST /api/triage/:ref/override
    - ac-5: "a PUT request is sent to /api/triage/:ref with act flag" →
      POST /api/triage/:ref/act
    - ac-8: "a PUT request with act flag targets a record with status
      acted_on" → "a POST request to /api/triage/:ref/act targets a record
      with status acted_on" (409 case, triage.ts ~523-529)
    - ac-9: "a PUT request with act flag targets a record with status
      pending" → "a POST request to /api/triage/:ref/act targets a record
      with status pending" (422 case, triage.ts ~533-540)
    Update ALL FOUR ACs via kspec item ac commands to match the
    implemented endpoints (spec updated to match reality), and annotate
    tests against the corrected ACs. Also correct the stale file-header
    AC-coverage comment block in packages/daemon/src/routes/triage.ts
    (~lines 1-22), which still says "PUT override" / "PUT act" for ac-4,
    ac-5, ac-8, ac-9.

    How: Follow tests/daemon-api/inbox.test.ts as the structural model.
    Fixtures: setupInlineFixtures / setupFixtures from helpers.ts; the
    E2E fixture tests/e2e/fixtures/project.triage.yaml shows the record
    shapes the old suite relied on (E2E fixtures must NOT be reused
    directly — daemon-api tests build their own temp-project fixtures).

    Testing: full npm test passes; npm run test:e2e is unaffected by the
    deleted spec file (it was fully skipped).

    Covers: @triage-daemon-api ac-1 through ac-9, @trait-api-endpoint
    ac-1, ac-2, ac-3, ac-4, ac-5, @trait-websocket-protocol ac-3.

- title: Fix vacuous search meta-entity tests and re-enable combined search test
  slug: task-fix-search-meta-entity-tests
  priority: 2
  tags: [testing, cli, search]
  spec_ref: "@fuzzy-item-search"
  description: |
    Fix the AC-7 search integration tests in tests/grep.test.ts so they
    actually verify entity loading, and re-enable the skipped combined test
    at tests/grep.test.ts:629 ("should search all entity types together").

    Why: The skip comment blames an "intermittent issue where meta entities
    aren't being loaded" and claims "individual entity type tests all pass,
    so the core functionality works". Code reading shows the failure is
    DETERMINISTIC today and the passing sibling tests are vacuous — they
    pass even when nothing loads. (The skip is itE2E.skip, where itE2E is
    vitest's own `it` aliased at the late-import block around line 462 —
    the suite runs in every plain vitest pass, not under a separate E2E
    runner, so the failure reproduced in every test run.)

    Root cause (verified by reading source and git history, not by
    running tests):
    1. loadMetaFile (src/parser/meta.ts ~250-332) silently skips any meta
       entity whose Zod safeParse fails — no error surfaces.
    2. MetaUlidSchema was tightened from z.string().min(1) to the strict
       26-char Crockford UlidSchema (/^[0-9A-HJKMNP-TV-Z]{26}$/i) in commit
       703f4b6764 ("feat: implement agent reference validation (AC-3)",
       2026-01-17) — five days BEFORE these tests were written in
       8f1f9534ec (2026-01-22). The fixtures were therefore invalid from
       the day they were created; they were never broken later by a schema
       change. The hand-written fixture ULIDs are all 23 characters
       (vs the required 26): "01TESTOBS00000000000000" (also contains the
       excluded letter O), "01TESTAGENT000000000000",
       "01TESTWORKFLOW000000000" (also contains excluded letters O and
       L), and "01TESTCONV0000000000000" (also
       contains an O); the beforeEach block adds invalid item/task ULIDs
       "01TESTITEM0000000000000" and "01TESTTASK0000000000000". All such
       entities are silently dropped at load time.
    3. The skipped test's observation also sets resolved_at: null, but
       ObservationSchema uses DateTimeSchema.optional(), which rejects null
       (optional is not nullable in zod) — a second independent parse
       failure.
    4. The sibling tests pass vacuously: when search finds nothing it
       prints 'No matches found for "<pattern>"'
       (src/cli/commands/search.ts ~351). Assertions like
       toContain("convention-keyword") and toContain("convention") are
       satisfied by that echo (the entity-type word is a substring of the
       search pattern). The combined test is the only one whose assertions
       ("inbox", "observation", "agent" type labels vs pattern "Universal")
       cannot be satisfied by the echo — which is why it alone failed and
       got skipped.

    What:
    - Replace all hand-written fixture ULIDs in the AC-7 describe block
      (items, tasks, observations, agents, workflows, conventions) with
      valid ULIDs from testUlid()/testUlids() (tests/helpers/cli.ts).
    - Make the observation fixture schema-valid: drop resolved_at (or use
      a valid ISO datetime string); keep required type/content/created_at.
    - Strengthen every AC-7 test so it cannot pass on the no-match echo:
      assert stdout does NOT contain "No matches found" and assert a
      positive result marker (the result-count line and/or the matched:
      field output) in addition to the keyword.
    - Re-enable the skipped combined test, remove the TODO and the
      oxlint-disable-next-line jest/no-disabled-tests comment.

    How: This is a test-fixture fix; no production code change is expected.
    If the re-enabled test still fails with valid fixtures, the residual
    failure is real (e.g. meta entities genuinely not searched) — fix that
    in src/cli/commands/search.ts / src/parser/meta.ts rather than
    re-skipping.

    Testing / stability criterion: with schema-valid fixtures the old
    failure mode is deterministic, so stability is verified by running the
    file at least 10 consecutive times with zero failures:
    npm test -- tests/grep.test.ts --fresh (repeat; --fresh forces re-runs
    past the content-hash cache). Then full npm test.

    Covers: @fuzzy-item-search ac-7.

- title: Include behavior-affecting environment variables in test cache key
  slug: task-test-cache-env-key
  priority: 3
  tags: [testing, infra]
  description: |
    Add an environment component to the test runner's result-cache key so
    runs under different test-affecting environments cannot serve each
    other's cached results.

    Why: computeCacheKey in scripts/test.cjs (~lines 107-166) hashes
    (1) git blob SHAs of TEST_INPUT_PATHS, (2) the unstaged diff,
    (3) untracked file contents, (4) the Node version, and (5) vitest
    args — but NO environment variables. Verified concrete staleness: the
    CI env var changes which tests execute (file-watcher tests skip when
    CI is set — see the project ci convention), yet CI=true npm test
    produces the same cache key as a plain local run in the same session,
    so the cached non-CI result (including watcher tests that never ran
    under CI conditions) is served as if it were a CI run. The same
    applies to any KSPEC_* or TZ/NODE_OPTIONS-style variable a test reads.
    Note the cache directory is already scoped by KSPEC_SESSION_ID
    (getCacheDir, ~line 171), so cross-agent dispatch isolation is not
    the gap — same-session env changes are.

    What: Extend computeCacheKey with a normalized env section: a curated
    allowlist of behavior-affecting variables, hashed as sorted
    name=value pairs (absent vars excluded so unset and empty differ from
    set). Recommended allowlist: CI, TZ, NODE_ENV, NODE_OPTIONS, and all
    KSPEC_*-prefixed variables EXCEPT KSPEC_SESSION_ID (already scopes the
    cache directory) and KSPEC_TEST_PROGRESS (affects only runner progress
    rendering, not test outcomes). Use an allowlist, not full-env hashing —
    hashing the whole environment would invalidate the cache on irrelevant
    churn (PWD, SHLVL, terminal vars) and destroy the cache's value.

    Also update the project testing convention as part of this task: the
    existing rule documenting the cache key ("Test runner caches results
    by content hash (git blob SHAs + unstaged diffs + untracked files +
    Node version + vitest args)...") must mention the env component. Use
    kspec meta set testing (replace/extend the relevant rule text), then
    run kspec agents generate to refresh kspec-agents.md, per the
    development convention. Per project policy, this is test
    infrastructure: convention + task, NO spec ACs.

    How: scripts/test.cjs is plain CommonJS with no test harness of its
    own. Keep the change inside computeCacheKey so --fresh, dry-run, and
    session scoping behavior are untouched.

    Testing: behavioral verification, recorded in task notes:
    (1) npm test twice in a row → second run is a cache hit;
    (2) CI=true npm test → cache miss (new key), and after it completes,
        CI=true npm test again → cache hit;
    (3) npm test (without CI) → hits the original entry, proving distinct
        keys coexist. Full npm test must pass.
```

## Implementation Notes

### Audit-finding verification summary

Four findings were audited against the codebase before drafting; two were corrected:

1. **"validate cannot detect dangling plan_ref in split format" — CORRECTED (stale).**
   The blind spot was real when the test was skipped (147d25b6b4, 2026-03-25) but was
   closed by `@plan-spec-catalog-health-and-validation-trust` (commits 87c41864b7,
   2525fa93d5, b8aed7ebb9, 2026-04-24), which routed `validate()` through the canonical
   TaskDataManager and added partial-task ref participation. `REF_FIELDS` already covers
   `plan_ref`, `spec_ref`, and `depends_on`, and plans are loaded into the
   ReferenceIndex. The behavioral contract already exists as
   `@validation-task-data-source` (implemented) and `@plan-validation` ac-10, so no new
   spec is needed — only the never-re-enabled regression test plus one small spec-text
   correction: `strict_refs` defaults to true, so the dangling ref is an error
   (non-zero exit), not the "warn" the stale test (and `@plan-validation` ac-10's
   literal wording) describes. The task updates ac-10 and the spec description to
   match implemented reality, the same spec-updated-to-match-reality policy applied
   to the triage ACs.

2. **Triage API suite skipped with no replacement — CONFIRMED.** Only a write-through
   test and one error-shape case exist in vitest; `tests/daemon-api/helpers.ts` already
   registers the triage routes, so the promised migration is mechanical. A spec-reality
   drift was found in the process: `@triage-daemon-api` ac-4, ac-5, ac-8, and ac-9 all
   describe PUT requests while the implementation uses POST subroutes
   (`/override`, `/act`) — the task corrects the wording of all four ACs and the
   stale PUT wording in the triage.ts file-header AC comment block.

3. **"Flaky grep test masking a bug" — CORRECTED (not flaky, and the bug is in the
   tests).** The combined search test fails deterministically (the skip is vitest's
   `it` aliased as `itE2E`, so the suite runs in every vitest pass): fixture meta
   entities use invalid 23-character ULIDs (three also containing excluded Crockford letters: two with O, one with O and L)
   and a null `resolved_at`, all silently dropped by `loadMetaFile`'s
   safeParse-and-skip; the "passing" sibling tests are vacuous because the
   `No matches found for "<pattern>"` echo satisfies their `toContain` assertions.
   Provenance (git-verified): MetaUlidSchema was tightened from `z.string().min(1)`
   to the strict `UlidSchema` in commit 703f4b6764 (2026-01-17) — five days BEFORE
   the tests were written in 8f1f9534ec (2026-01-22). The fixtures were invalid from
   birth; the schema never changed underneath them. (An earlier draft of this plan
   misattributed the tightening to 8624214d9f, the Skill meta-type commit, which
   only references MetaUlidSchema and never altered its definition.) No production
   search bug was found by code reading; the task includes the escalation path if
   one surfaces after fixtures are fixed.

4. **Test cache key ignores environment — CONFIRMED.** `computeCacheKey` hashes
   content, Node version, and vitest args only. The CI variable is a verified concrete
   staleness vector (it changes the executed test set via CI-skipped watcher tests).
   Per project policy this stays spec-less: convention update + task.

### Fix cycle 1 decisions (reviews @01KTRZPM, @01KTS0TQ)

Judgment calls made while addressing the two change-requesting reviews:

- **`ac-all-persisted-tasks-included` kept in Covers, annotation mapping added**
  (codex blocker): rather than dropping the AC from Covers, the annotation
  instructions now require it on the dangling-ref tests. The test injects refs into
  the persisted per-task detail file, so a reported finding is direct evidence the
  persisted record was included in the validation task set — the coverage claim is
  real, it was only the annotation mapping that was missing.
- **`@plan-validation` ac-10 drift resolved by updating the spec, not scoping the
  test** (claude question): `strict_refs` defaults to true and the implemented
  default behavior is an error with non-zero exit. Scoping the test to a
  non-default `strict_refs: false` configuration would test a non-default path to
  preserve stale wording. Updating the AC to "error when strict references mode is
  active (the default), warning otherwise" matches reality and is consistent with
  the plan's handling of the triage PUT→POST drift. Verbatim replacement text is in
  the task.
- **Triage AC correction extended to ac-8/ac-9 plus the triage.ts header comment**
  (both reviews): same drift, same endpoint contract; leaving half the ACs stale
  would make the spec internally inconsistent. The header-comment cleanup is
  included because the new tests annotate against the corrected ACs and the header
  is the file-level AC map.
- **Provenance narrative rewritten from git evidence** (claude blocker): verified
  via `git show 703f4b6764` (MetaUlidSchema `min(1)` → `UlidSchema`, 2026-01-17)
  and `git show 8624214d9f` (Skill meta type, no MetaUlidSchema definition change,
  2026-02-14). Timeline inverted versus the original draft: fixtures were invalid
  five days before the tests existed. Fix instructions were unaffected.
- **Export format wording corrected** (codex question): the route accepts
  `format=json` (default) and `format=context` (markdown context output); the
  task bullet no longer says "markdown vs JSON".
- **Fixture-ULID counts corrected** (claude nit): all four quoted meta fixture
  ULIDs are 23 characters; the beforeEach item/task ULIDs are listed explicitly so
  "replace all hand-written fixture ULIDs" is unambiguous.

### Overlap with existing kspec state

- `@plan-spec-catalog-health-and-validation-trust` (completed) — produced the specs
  this plan's first task covers. No conflict; this plan only adds the missing
  regression coverage.
- `@plan-delete-static-analysis-tests-and-replace-with-beha` (completed) — behavioral-
  coverage direction is consistent with porting the triage suite to daemon integration
  tests and with the no-source-scanning preference.
- No active or draft plan covers any of these findings (checked `kspec plan list`
  at drafting time: the only active plan was Resource UI Hardening, since
  completed; drafts are spec-cruft seeds and dispatch workspace work).

### Task independence

All four tasks are independent — no `depends_on` relationships. Each is standalone-
workable by a dispatch worker with no chat history.
