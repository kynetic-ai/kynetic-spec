# Coverage State Engine

> **Program track:** kspec interface redesign / coverage states, P1b-2.
>
> **Approval gate:** Do not approve or derive this plan until the Test Result
> Ingestion plan has been approved, derived, and completed, and until
> @plan-ac-coverage-verification-schema-and-storage and
> @plan-dispatch-mutation-service remain completed on the redesign branch.
> This plan consumes the normalized test-run store, verification stamps,
> freshness resolver, and mutation/event foundations; it should not recreate
> any of them.
>
> **Branch gate:** When imported, keep this plan on the shared redesign branch
> (`feat/ui-redesign`) with the other UI redesign plans.

## Specs

```yaml
# ─── Coverage State Read Model ───

- title: Coverage Evidence Index
  slug: coverage-evidence-index
  type: feature
  depends_on:
    - "@ac-verification-record-store"
    - "@ac-freshness-resolution"
    - "@test-result-run-store"
    - "@test-result-ac-mapping"
  description: |
    A per-project read model that joins the spec corpus, acceptance
    criteria, static coverage annotations, annotation freshness,
    verification stamps, and ingested test-run outcomes into one evidence
    index. The index is the only backend input used by coverage-state
    computation. It records what evidence exists for each criterion,
    where it came from, whether any mapped latest result is failing or
    errored, which mappings are unmapped or invalid, and what freshness
    values are available. It never derives final UI state in the client
    and never assumes kynetic-spec-specific test files, slugs, packages,
    or framework output.
  acceptance_criteria:
    - id: ac-one-entry-per-criterion
      given: |
        a loaded kspec project with spec items and acceptance criteria
      when: |
        the coverage evidence index is built
      then: |
        every acceptance criterion in the corpus has exactly one evidence
        entry, including criteria with no annotations, no stamps, and no
        ingested results
    - id: ac-evidence-sources-labeled
      given: |
        an indexed criterion with any combination of annotations,
        freshness values, verification stamps, and ingested test results
      when: |
        its evidence entry is read
      then: |
        each evidence fact names its source class — annotation,
        bootstrap freshness, recorded verification, ingested result, or
        unmapped result — without collapsing them into an unlabeled value
    - id: ac-latest-result-selection
      given: |
        several ingested runs contain mapped results for the same
        criterion
      when: |
        the evidence index selects result evidence for state computation
      then: |
        it uses the latest accepted run relevant to that criterion,
        breaking exact completed-at ties deterministically by run id and
        preserving older runs for later history consumers
    - id: ac-unmapped-separated
      given: |
        an ingested run contains cases with no valid criterion mapping
      when: |
        the evidence index is built
      then: |
        those cases are exposed as unmapped result evidence and are not
        attributed to any criterion
    - id: ac-framework-neutral-input
      given: |
        normalized results from different producers in projects whose
        layouts differ from kynetic-spec
      when: |
        the evidence index reads them
      then: |
        index behavior is identical for equivalent normalized records and
        does not inspect framework-native fields or kynetic-spec paths
    - id: ac-no-client-side-join
      given: |
        a web or CLI consumer requests coverage evidence
      when: |
        the backend responds
      then: |
        the response contains backend-joined evidence or computed state;
        the consumer is not required to fetch raw lists and reproduce the
        join locally

- title: Coverage State Engine
  slug: coverage-state-engine
  type: feature
  depends_on:
    - "@coverage-evidence-index"
    - "@coverage-state-presentation"
    - "@ac-coverage-applicability"
  description: |
    The backend service that computes one deterministic corpus coverage
    state for every acceptance criterion from the coverage evidence index.
    Internal causes may distinguish failing test evidence, missing
    evidence, stale spec text, stale covering code, and stale mapping
    confirmation, but user-facing presentation collapses to the four
    buckets defined by @coverage-state-presentation: covered, failing,
    not yet, and re-verify. Corpus coverage has no not-applicable state;
    in-code not-applicable annotations neither cover nor exempt criteria.
  acceptance_criteria:
    - id: ac-total-state
      given: |
        any acceptance criterion in the loaded spec corpus
      when: |
        coverage state computation completes
      then: |
        the criterion has exactly one computed state and a machine-readable
        explanation naming the evidence and rule that produced it
    - id: ac-no-not-applicable-state
      given: |
        a criterion whose only annotations are not-applicable markers or
        whose tests mark it not-applicable
      when: |
        corpus coverage state is computed
      then: |
        the result is not a not-applicable state; the criterion is treated
        according to the ordinary evidence rules, with N/A markers
        contributing no positive coverage evidence
    - id: ac-failing-dominates-covered
      given: |
        the latest relevant ingested evidence for a criterion contains a
        failed or errored mapped case
      when: |
        the state is computed
      then: |
        the criterion's presentation bucket is failing even if older
        passing evidence or static annotations also exist
    - id: ac-covered-requires-current-positive-evidence
      given: |
        a criterion with current positive evidence from a coverage
        annotation, a passing mapped ingested result, or a verification
        stamp that is not stale under the engine's freshness rules
      when: |
        no latest mapped case is failing or errored and no re-verify cause
        applies
      then: |
        the criterion's presentation bucket is covered
    - id: ac-not-yet-for-no-positive-evidence
      given: |
        a criterion with no positive coverage evidence from annotations,
        verification stamps, or mapped ingested results
      when: |
        the state is computed
      then: |
        the criterion's presentation bucket is not yet
    - id: ac-reverify-for-stale-evidence
      given: |
        a criterion with positive evidence whose confirmed freshness is
        older than the criterion text, covering annotation, or mapped test
        evidence it depends on
      when: |
        no latest mapped case is failing or errored
      then: |
        the criterion's presentation bucket is re-verify and the internal
        cause identifies which dependency is stale
    - id: ac-four-presentation-buckets
      given: |
        computed internal coverage-state causes
      when: |
        any API, CLI, or UI-facing response presents the state
      then: |
        each state maps to exactly one of covered, failing, not yet, or
        re-verify, and detailed causes are secondary metadata
    - id: ac-deterministic-precedence
      given: |
        a criterion with multiple evidence facts that could imply
        different buckets
      when: |
        state computation runs repeatedly over the same inputs
      then: |
        the same state, presentation bucket, and explanation are produced
        each time according to the documented precedence rules

- title: Coverage Freshness and Revision Comparison
  slug: coverage-freshness-revision-comparison
  type: requirement
  parent: "@coverage-state-engine"
  depends_on:
    - "@ac-freshness-resolution"
  description: |
    Coverage state can determine whether existing evidence must be
    re-verified because the acceptance criterion text, covering
    annotation, or mapped test evidence changed after verification. The
    comparison reads version-control history and project metadata; it does
    not require storing operational state in spec source. Criterion text
    comparisons are per acceptance criterion, not only per whole spec
    item, so changing one criterion does not force unrelated criteria on
    the same item into re-verify.
  acceptance_criteria:
    - id: ac-ac-text-change-detected
      given: |
        a criterion has positive verification evidence and its given,
        when, or then text changes afterward
      when: |
        coverage state is recomputed
      then: |
        that criterion enters the re-verify bucket with a spec-text
        change cause unless newer positive evidence supersedes the change
    - id: ac-sibling-ac-unchanged
      given: |
        one criterion on a spec item changes while a sibling criterion on
        the same item does not
      when: |
        coverage state is recomputed
      then: |
        the unchanged sibling is not marked re-verify solely because the
        item file changed
    - id: ac-annotation-change-detected
      given: |
        a criterion's positive evidence relies on a coverage annotation
        location and that annotation line changes after verification
      when: |
        coverage state is recomputed
      then: |
        the criterion enters the re-verify bucket with a covering-code or
        mapping-change cause unless newer positive evidence supersedes it
    - id: ac-test-result-code-revision-compared
      given: |
        an ingested run carried a code revision and later source changes
        affect the mapped test case or annotation location
      when: |
        the engine can compare those revisions
      then: |
        the state explanation reports whether the run evidence is current
        or requires re-verification because code changed after the run
    - id: ac-unknown-comparison-degrades-to-reverify
      given: |
        positive evidence exists but the engine cannot compare a required
        freshness source because revision metadata is absent or
        unresolvable
      when: |
        the state is computed
      then: |
        the criterion does not get silently marked covered; it either
        remains not yet when there is no positive evidence or enters
        re-verify with an unknown-freshness cause
    - id: ac-per-ac-diff-read
      given: |
        a consumer requests why a criterion is stale
      when: |
        the backend can resolve the relevant prior and current versions
      then: |
        it can provide a per-criterion text or metadata comparison for
        that criterion without requiring the consumer to diff the entire
        spec item locally

- title: Coverage State API and Cache
  slug: coverage-state-api-cache
  type: requirement
  parent: "@coverage-state-engine"
  depends_on:
    - "@coverage-state-engine"
    - "@daemon-entity-cache"
    - "@api-contract"
  traits:
    - "@trait-api-endpoint"
  description: |
    The daemon exposes coverage-state reads as server-computed data with
    explicit cache ownership, pagination/filter support where needed, and
    static-mode fallback. Consumers can request corpus rollups, per-item
    rollups, per-criterion state detail, and unmapped-result summaries
    without rebuilding the evidence join client-side. Cache invalidation
    follows the same project metadata, source annotation, verification
    stamp, and test-run changes that affect state computation.
  acceptance_criteria:
    - id: ac-corpus-rollup
      given: |
        a daemon client requests coverage-state summary for a project
      when: |
        the project has computed states
      then: |
        the response includes counts for covered, failing, not yet, and
        re-verify plus the denominator used for corpus coverage
    - id: ac-item-and-ac-detail
      given: |
        a daemon client requests a spec item or acceptance criterion
        coverage detail
      when: |
        the item or criterion exists
      then: |
        the response includes the computed state, presentation bucket,
        explanation, relevant latest run evidence, freshness values, and
        any unmapped result references affecting that view
    - id: ac-server-computed
      given: |
        a web client renders a coverage badge, spec workspace row, or
        Validate matrix row
      when: |
        it requests coverage data
      then: |
        it consumes server-computed state/rollup fields and does not
        reproduce the state derivation rules locally
    - id: ac-cache-invalidation
      given: |
        spec source, configured annotation scan paths, verification
        stamps, or test-run records change
      when: |
        a subsequent coverage-state request is served
      then: |
        stale cached state is not returned for affected criteria or
        rollups
    - id: ac-static-snapshot
      given: |
        a static export contains coverage-state data
      when: |
        a client reads the exported snapshot
      then: |
        it can render the last computed state and rollups as read-only
        data, and mutation or ingestion actions are unavailable
    - id: ac-performance-bounded
      given: |
        a project with thousands of acceptance criteria and many
        annotations
      when: |
        coverage-state summary is requested repeatedly
      then: |
        the daemon reuses the cache/read model instead of rescanning and
        recomputing the full corpus for every request

- title: Coverage State Events
  slug: coverage-state-events
  type: requirement
  parent: "@coverage-state-engine"
  depends_on:
    - "@mutation-event-naming"
    - "@coverage-state-api-cache"
  traits:
    - "@trait-websocket-protocol"
  description: |
    Coverage-state changes broadcast through the reserved coverage-state
    event family on the spec-item domain topic. Events identify affected
    items and criteria by canonical identifiers and carry enough
    information for clients to refresh precise rows or rollups. They are
    emitted only after the daemon cache/read model reflects the changed
    state, matching the shared mutation/event ordering contract.
  acceptance_criteria:
    - id: ac-event-topic
      given: |
        a coverage-state-affecting mutation succeeds
      when: |
        the daemon broadcasts the resulting event
      then: |
        the event is published on the spec-item domain topic using the
        reserved coverage-state event family rather than on a parallel
        coverage-only topic
    - id: ac-event-canonical-identity
      given: |
        an event identifies affected coverage state
      when: |
        a client receives it
      then: |
        the payload identifies affected spec items and criteria by
        canonical identifiers sufficient to refresh exactly those rows or
        rollups
    - id: ac-event-after-cache
      given: |
        a subscriber receives a coverage-state event
      when: |
        it immediately re-fetches the affected coverage state
      then: |
        the response reflects the state that caused the event
    - id: ac-file-change-fallback
      given: |
        a source or metadata file changes outside a daemon-served
        mutation path
      when: |
        watcher fallback invalidation is all the daemon observes
      then: |
        open clients still refresh affected coverage views even if no
        precise typed mutation event was available
    - id: ac-no-event-storm
      given: |
        one ingestion or metadata mutation affects many criteria
      when: |
        coverage-state events are emitted
      then: |
        the daemon can coalesce payloads by affected item/rollup so a
        single run does not require one websocket message per criterion
```

## Tasks

derive_from_specs: false

```yaml
- title: Build the backend coverage evidence index
  slug: task-coverage-evidence-index
  priority: 1
  tags: [coverage, parser, daemon]
  spec_ref: "@coverage-evidence-index"
  description: |
    Create the server-side evidence index that joins spec ACs, static
    annotations, freshness values, verification stamps, and ingested test
    results into one per-criterion input model.

    Why: The redesigned spec workspace and Validate matrix must consume a
    single backend dataset. If each UI surface joins raw specs, test
    annotations, test runs, and stamps independently, the four coverage
    buckets will drift and performance will collapse on large projects.

    What:
    - Build an index entry for every AC in the loaded spec corpus,
      including entries with no evidence.
    - Feed the index from the existing structured annotation scan, the
      P1a freshness resolver and verification store, and the test-run
      store from the ingestion plan at `coverage/test-runs/index.yaml` plus
      `coverage/test-runs/runs/<run-ulid>/run.yaml`. Treat index.yaml as the
      authoritative bounded list of accepted run ids/paths, then read the
      indexed run files to compute latest relevant per-criterion evidence;
      do not expect ingestion to provide a per-criterion latest projection.
    - Label every evidence source: annotation, bootstrap freshness,
      recorded verification, ingested result, unmapped result.
    - Select latest relevant ingested result evidence per criterion using
      completed_at + run-id tie-break. Preserve older run data in the run
      store; the index only selects current evidence for state.
    - Keep unmapped/invalid results separate from criterion evidence.
    - Add fixtures for at least two non-kynetic projects with different
      layouts and normalized result producers.

    How: Put the pure index builder in src/parser/ or a coverage domain
    module importable by daemon and CLI. It should accept already-loaded
    project context and stores, not call daemon routes. Add unit tests for
    one-entry-per-criterion, source labeling, latest result selection,
    unmapped separation, and framework/project neutrality.

    Covers: @coverage-evidence-index ac-one-entry-per-criterion,
    ac-evidence-sources-labeled, ac-latest-result-selection,
    ac-unmapped-separated, ac-framework-neutral-input,
    ac-no-client-side-join.

- title: Implement deterministic per-AC coverage state derivation
  slug: task-coverage-state-derivation
  priority: 1
  tags: [coverage, state-engine]
  spec_ref: "@coverage-state-engine"
  depends_on:
    - "@task-coverage-evidence-index"
  description: |
    Implement the state engine that turns one evidence-index entry into a
    deterministic internal state, four-bucket presentation value, and
    explanation.

    Why: P0a intentionally collapsed user-facing state to covered,
    failing, not yet, and re-verify. The backend still needs precise
    internal causes so Validate/spec workspace rows can explain what to
    do next without forking state logic in the UI.

    What:
    - Define internal state/cause types for at least: covered,
      failing_result, no_positive_evidence, stale_spec_text,
      stale_annotation_or_mapping, stale_test_result, and
      unknown_freshness. Map these to presentation buckets per
      @coverage-state-presentation.
    - Document and test precedence. Required rules: failed/errored latest
      mapped result dominates covered; no positive evidence yields not
      yet; stale positive evidence yields re-verify when no latest failure
      dominates; N/A markers never create an N/A state or positive
      evidence; equivalent inputs always produce equivalent outputs.
    - Generate a machine-readable explanation containing the winning rule,
      source evidence ids, latest run id when relevant, and secondary
      re-verify causes.
    - Test mixed evidence: annotation only, recorded stamp only, passing
      latest run, failing latest run after older pass, passing latest run
      after older failure, skipped/unknown only, N/A-only annotation,
      stale evidence, and absent comparison metadata.

    How: Keep derivation pure and side-effect-free. Use serializable
    result objects so daemon APIs, static export, and CLI debug output can
    all consume the same state result.

    Covers: @coverage-state-engine ac-total-state,
    ac-no-not-applicable-state, ac-failing-dominates-covered,
    ac-covered-requires-current-positive-evidence,
    ac-not-yet-for-no-positive-evidence, ac-reverify-for-stale-evidence,
    ac-four-presentation-buckets, ac-deterministic-precedence.
    Also covers @ac-coverage-applicability ac-1 and ac-2, and
    @coverage-state-presentation ac-1.

- title: Add per-AC freshness and revision comparison for re-verify causes
  slug: task-coverage-freshness-revision-comparison
  priority: 1
  tags: [coverage, freshness, git]
  spec_ref: "@coverage-freshness-revision-comparison"
  depends_on:
    - "@task-coverage-state-derivation"
  description: |
    Implement the comparison layer that decides whether positive evidence
    is stale because AC text, covering annotations, or mapped test
    evidence changed after verification.

    Why: "Re-verify" is only trustworthy if it points to a real freshness
    cause. Whole-file heuristics would flood unrelated criteria; the
    comparison must be per-AC wherever the project data allows it.

    What:
    - Compare a criterion's current text/fingerprint against the version
      that was current when its positive evidence was recorded. Use
      shadow/project metadata history rather than writing operational
      state into spec source.
    - Provide a per-AC diff/read helper for stale-spec explanations so a
      consumer can show why the criterion needs re-verification without
      diffing an entire item client-side.
    - Compare annotation freshness using the P1a resolver's recorded and
      bootstrap values. A recorded stamp older than newer annotation
      history causes re-verify; absent/unresolvable comparison metadata
      degrades to re-verify with an unknown-freshness cause rather than
      silently covered.
    - Compare ingested run code revisions when available. If a run lacks
      comparable code revision metadata, report that absence in the
      explanation and follow the unknown-comparison rule.
    - Tests: changed AC text re-verifies only that AC; sibling AC on same
      item remains unchanged; changed annotation re-verifies mapped AC;
      passing newer evidence clears stale cause; unknown revision metadata
      yields re-verify not covered; per-AC diff helper returns focused
      comparison data.

    How: Reuse existing git utilities and plan-revision/content-hash
    patterns where appropriate. Keep expensive history reads batched and
    cacheable; add a performance regression fixture with many ACs and a
    small number of changed criteria.

    Covers: @coverage-freshness-revision-comparison
    ac-ac-text-change-detected, ac-sibling-ac-unchanged,
    ac-annotation-change-detected, ac-test-result-code-revision-compared,
    ac-unknown-comparison-degrades-to-reverify, ac-per-ac-diff-read.

- title: Expose coverage state daemon APIs and cache read model
  slug: task-coverage-state-api-cache
  priority: 1
  tags: [coverage, daemon, api, cache]
  spec_ref: "@coverage-state-api-cache"
  depends_on:
    - "@task-coverage-freshness-revision-comparison"
  description: |
    Add daemon read endpoints and cache ownership for coverage-state
    summaries, item rollups, criterion details, and unmapped-result
    summaries.

    Why: The spec workspace, Validate view, sidebar badge, and future
    static export need the same server-computed state. Existing
    coverage-cache only caches binary annotation scan results; it is not
    the coverage-state read model.

    What:
    - Define API response shapes for project summary, item summary,
      criterion detail, and unmapped-result summary. Include counts for
      covered/failing/not yet/re-verify, denominator, state explanation,
      latest run id, freshness details, and secondary causes.
    - Add daemon routes that serve from the coverage-state read model and
      integrate with entity-cache domain readiness/loading envelopes.
    - Replace or wrap the old binary coverage-cache so it is an input to
      the evidence index, not the public state cache.
    - Define cache keys/invalidation triggers: spec corpus change,
      configured annotation scan path change, source annotation file
      change, verification stamp write, test-run ingestion, and relevant
      static export snapshot load.
    - Add static-export serialization for last-computed read-only state
      and read-only errors for mutation/ingestion attempts in static
      mode.
    - Performance tests: repeated summary/detail requests reuse the cache;
      invalidation refreshes affected rows/rollups; a fixture with
      thousands of ACs stays bounded enough for daemon UI use.

    How: Follow the daemon aggregation route conventions: server-derived
    data, wrapped response envelopes, loading state while cache warms,
    and no client-side derivation requirement. Coordinate shared package
    type generation before root typecheck if response types land in
    packages/shared.

    Covers: @coverage-state-api-cache ac-corpus-rollup, ac-item-and-ac-detail,
    ac-server-computed, ac-cache-invalidation, ac-static-snapshot,
    ac-performance-bounded. Covers @trait-api-endpoint ac-1, ac-2, ac-3,
    ac-4, and ac-6 for coverage-state read endpoints; mutation/shadow
    endpoint behavior remains owned by ingestion and existing mutation plans.

- title: Emit coverage-state events and targeted UI invalidation
  slug: task-coverage-state-events
  priority: 1
  tags: [coverage, websocket, daemon, web-ui]
  spec_ref: "@coverage-state-events"
  depends_on:
    - "@task-coverage-state-api-cache"
  description: |
    Define and emit typed coverage-state events through the existing
    spec-item domain topic, and update clients to refresh coverage views
    precisely.

    Why: The mutation/event foundation reserved coverage-state events, but
    left payload semantics to this plan. Without typed events, coverage
    surfaces would fall back to broad delayed refreshes and stale badges.

    What:
    - Add typed event definitions for coverage-state changes on the
      spec-item domain topic (`items:updates`), using the reserved family
      from @mutation-event-naming. Payloads identify affected item ULIDs,
      AC ids when bounded, changed buckets/rollup scopes when known, and
      whether the client should refresh item detail, project summary, or
      unmapped-result summary.
    - Emit events after ingestion, verification stamp writes,
      spec/AC mutations, annotation file watcher invalidation, and cache
      recomputation paths that change visible state.
    - Ensure event-after-cache ordering: a subscriber that re-fetches
      immediately sees the new state.
    - Coalesce events for one run or broad file change so the daemon does
      not send one websocket message per criterion.
    - Wire the web client subscription/invalidation layer to refresh
      coverage-state consumers by exact item/summary scope when possible,
      with file-change fallback for out-of-band writes.
    - Tests: typed topic/payload conformance, event-after-cache ordering,
      ingestion event coalescing, watcher fallback invalidation, and UI
      subscription refresh path without broad global reload.

    How: Extend packages/shared websocket/event types first, regenerate
    shared dist, then update daemon emitters and web client invalidation.
    Use the shared mutation pipeline event ordering for daemon-served
    mutations and explicit cache invalidation for watcher paths.

    Covers: @coverage-state-events ac-event-topic, ac-event-canonical-identity,
    ac-event-after-cache, ac-file-change-fallback, ac-no-event-storm. Also covers
    @mutation-event-naming ac-3 for the coverage-state reserved family and
    @trait-websocket-protocol ac-2, ac-3, ac-6, and ac-8 for subscription,
    broadcast envelope, coalescing/backpressure, and reconnect behavior using
    the existing daemon websocket foundation.

- title: Add coverage-state compatibility, performance, and neutral-project gates
  slug: task-coverage-state-validation-gates
  priority: 2
  tags: [coverage, tests, validation]
  spec_ref: "@coverage-state-engine"
  depends_on:
    - "@task-coverage-state-events"
  description: |
    Add the cross-cutting test and validation coverage that proves the
    engine works as a reusable kspec system, not only for this repository.

    Why: The highest risk in this track is accidental coupling to
    kynetic-spec's own corpus and test setup. Completion must prove the
    generic behavior across temp projects, older/no-store projects, static
    snapshots, and large-ish corpora.

    What:
    - Add temp-project integration tests with at least two project shapes:
      one with no test-run store and bootstrap annotations only, one with
      normalized ingested runs from a differently named test framework or
      fake producer.
    - Add an upgrade/backcompat fixture: existing project with no
      verification/test-run store reads as valid and does not materialize
      stores on read; stores materialize only on write/ingestion.
    - Add static snapshot tests for read-only coverage state and refused
      mutation/ingestion actions.
    - Add performance smoke for corpus-level rollups over thousands of ACs
      using generated fixture data, proving cache reuse and avoiding one
      git/history call per AC when batching is possible.
    - Add validation/readiness notes documenting remaining follow-ons:
      resolution mutations, spec workspace, Validate matrix, flakiness,
      and generated observations.

    How: Run focused coverage-state suites first, then the relevant daemon
    route/websocket tests, then `KSPEC_NO_DAEMON=1 kspec validate
    --warnings-ok`. For touched shared package types, generate
    `packages/shared/dist` before root `tsc`.

    Covers: @coverage-state-engine ac-total-state,
    ac-deterministic-precedence; @coverage-state-api-cache
    ac-performance-bounded, ac-static-snapshot; @coverage-evidence-index
    ac-framework-neutral-input; @coverage-record-compatibility
    ac-absent-store-no-behavior-change and ac-upgrade-without-rewrite as
    regression coverage for this new read model.
```

## Implementation Notes

### What this plan is

This is the computation half of P1b. It consumes the normalized test-run
store from the Test Result Ingestion plan plus the already-completed P1a
verification/freshness store and computes backend-owned coverage state for
all later UI surfaces.

The plan deliberately does **not** build the spec workspace, Validate
matrix UI, resolution mutations, dispatch-fix/revert actions, flakiness
history, or generated observations. Those are follow-on plans that consume
this backend state.

### State vocabulary

User-facing presentation remains exactly the four buckets from
@coverage-state-presentation:

- `covered`
- `failing`
- `not yet`
- `re-verify`

Internal causes may be richer, but every API/UI-facing response must map
one internal result to exactly one of those buckets. Do not introduce a
fifth corpus `not-applicable` bucket; @ac-coverage-applicability explicitly
rejects that state for corpus coverage.

### Recommended precedence

The implementation task should codify and test the exact precedence, but
this draft expects the following shape:

1. Latest mapped failed/errored result → `failing`.
2. No positive evidence → `not yet`.
3. Positive evidence exists but required comparison says spec text,
   annotation/mapping, or test/source evidence changed afterward →
   `re-verify`.
4. Positive evidence exists but required comparison metadata is absent or
   unresolvable → `re-verify` with unknown-freshness cause.
5. Current positive evidence and no stale/unknown cause → `covered`.

Skipped/unknown cases are not positive evidence. N/A annotations are not
positive evidence and do not exempt the criterion.

### Relationship to imported redesign plans

- P0a provides the presentation and applicability decisions.
- P1a provides the verification record store and freshness resolver.
- P0c provides mutation/event ordering and reserves the coverage-state
  event family.
- The Test Result Ingestion plan provides normalized completed-run storage
  at `coverage/test-runs/index.yaml` and
  `coverage/test-runs/runs/<run-ulid>/run.yaml`, including folder-backed run
  entities, flat case records, attributed mappings, unmapped/invalid mapping
  reports, and verification effects. The state engine consumes that contract:
  it uses index.yaml as the bounded run list and reads run.yaml files for
  detailed evidence selection; it must not choose a different run-store layout,
  expect a precomputed per-criterion latest projection, or reinterpret native
  framework artifacts.
- P0b's UI status tokens ensure later views render the four buckets with a
  shared token vocabulary; this plan supplies the state values, not the
  visual components.

### General-system guardrails

- Use normalized ingested run records only. Never inspect Vitest/JUnit/etc.
  native fields from the state engine.
- Fixtures must include projects other than kynetic-spec, with different
  package names, test paths, spec refs, and result producers.
- Do not derive state in Svelte components. APIs return computed state and
  rollups.
- Do not hardcode `.kspec/modules/*.yaml`, `kynetic.yaml`, current corpus
  counts, or this repository's test annotation distribution. Use project
  discovery and loaded context.
- Treat missing stores as valid absence, not as an upgrade task or error.

### API/cache boundary

The existing `coverage-cache.ts` caches binary annotation scan results. The
engine needs a new read model that treats annotation scan output as one
input among several. Preserve the old scan utility as an input if useful;
do not expose binary annotation presence as the new public coverage state.

### Performance notes

The original design assumed a much smaller corpus than the real projects
can have. The implementation should batch expensive history reads by file
or metadata revision, cache joined evidence/read models, and expose
rollups without requiring clients to fetch every criterion detail. A
performance smoke with generated thousands-of-AC fixture data is part of
this plan, not a later UI task.

### Scope exclusions

- Test result ingestion/storage/mapping. That is the prerequisite plan.
- Daemon-run test execution.
- Coverage resolution mutations: re-verify button, revert, dispatch-fix.
- Spec workspace and Validate UI rendering.
- Flakiness detection and historical trend analytics.
- Generated matrix observations.
- Merge/repair authority and cross-project dashboard actions.

### Migration and backcompat

- Projects with no verification store and no test-run store remain valid;
  reads produce not-yet/annotation-derived states as allowed by the rules
  and never materialize stores.
- Existing verification stores and future test-run stores are additive
  sidecars.
- Static exports receive read-only snapshots and never pretend to ingest
  or mutate coverage state.
- New API fields must be optional/tolerant for older snapshots and forward
  compatible with unknown detail fields.

### Validation gates

Before this plan is considered ready for approval, run at least:

- `KSPEC_NO_DAEMON=1 kspec plan import /home/chapel/Projects/kynetic-spec/plans/ui-redesign-coverage-state-engine.md --module @core --status draft --dry-run --json`
- `KSPEC_NO_DAEMON=1 kspec validate --warnings-ok`

Implementation tasks should run focused coverage-state tests, daemon route
and websocket tests touching the new API/events, static-export tests for
read-only coverage state, and broad TypeScript/build gates with shared
package generation before root `tsc` when shared types change.
