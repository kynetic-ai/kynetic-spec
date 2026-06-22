# Test Result Ingestion

> **Program track:** kspec interface redesign / coverage states, P1b-1.
>
> **Approval gate:** Do not approve or derive this plan until
> @plan-ui-redesign-global-decisions, @plan-ac-coverage-verification-schema-and-storage,
> and @plan-dispatch-mutation-service are completed on the redesign branch.
> Those plans define the ingestion-oriented acquisition decision, the
> verification stamp sidecar, and the shared mutation/event pipeline this plan
> consumes.
>
> **Branch gate:** When imported, keep this plan on the shared redesign branch
> (`feat/ui-redesign`) with the other imported UI redesign plans. This plan is
> backend/general-system work for any kspec project; it is not a special case
> for developing kynetic-spec itself.

## Specs

```yaml
# ─── Generic Test Result Ingestion ───

- title: Test Result Run Store
  slug: test-result-run-store
  type: feature
  depends_on:
    - "@test-result-acquisition"
    - "@coverage-record-compatibility"
  traits:
    - "@trait-folder-backed-entity-1"
  description: |
    Durable storage for normalized completed test runs submitted to a
    kspec project. A run record captures one completed execution from
    any producer — local tool, CI job, agent, or other runner — without
    assuming the producer's framework, repository layout, package
    manager, or result-file format. The store persists the normalized
    run envelope, the normalized test cases, mappable acceptance-criterion
    references, unmapped cases, producer metadata, execution timestamps,
    and optional code revision. It lives in project metadata as an
    additive folder-backed sidecar at `coverage/test-runs/index.yaml` plus one
    folder-backed run entity per accepted run under
    `coverage/test-runs/runs/<run-ulid>/run.yaml`; project source files and
    spec source files are never rewritten by ingestion.
  acceptance_criteria:
    - id: ac-normalized-run-persistence
      given: |
        a completed test run submitted in the supported normalized run
        envelope
      when: |
        ingestion accepts it
      then: |
        the run is persisted with its run identity, producer metadata,
        timestamps, test cases, mapped acceptance-criterion references,
        unmapped cases, and optional code revision
    - id: ac-framework-neutral-storage
      given: |
        two submitted runs produced by different test frameworks or CI
        systems
      when: |
        each is normalized before storage
      then: |
        the stored records use the same kspec-owned schema and contain no
        framework-specific top-level fields required for correctness
    - id: ac-sidecar-only
      given: |
        a project's spec files and source files before ingestion
      when: |
        a run is ingested
      then: |
        no spec source file and no code source file is modified by the
        ingestion; only the project metadata sidecar changes
    - id: ac-fixed-storage-layout
      given: |
        a valid normalized run with canonical run id 01ARZ3NDEKTSV4RRFFQ69G5FAV
      when: |
        ingestion persists it
      then: |
        the run is stored as
        coverage/test-runs/runs/01ARZ3NDEKTSV4RRFFQ69G5FAV/run.yaml and the
        coverage/test-runs/index.yaml summary is updated in the same
        mutation; ingestion uses the folder-backed entity trait for the run
        folder and does not store framework-native artifact files in this plan
    - id: ac-latest-run-query
      given: |
        more than one accepted run in the store
      when: |
        consumers request the latest ingested run
      then: |
        the store returns the run with the latest completed-at timestamp,
        breaking exact timestamp ties deterministically by run identity
    - id: ac-invalid-run-rejected
      given: |
        a submitted run missing required envelope fields or containing
        an invalid case status
      when: |
        ingestion validates it
      then: |
        the run is rejected with field-specific diagnostics and the store
        remains unchanged
    - id: ac-forward-compatible-records
      given: |
        a stored run record carrying unrecognized fields within a
        supported record-format version
      when: |
        a later run is ingested or the store is read
      then: |
        the unrecognized fields survive unchanged and do not prevent
        supported fields from being read
    - id: ac-newer-record-format-refused
      given: |
        a test-run store or run record declaring a record-format version
        newer than the running kspec version supports
      when: |
        the store is read or written
      then: |
        the operation refuses with an error naming both versions, the
        store is not modified, and unrelated project operations remain
        available

- title: Normalized Test Result Ingestion Contract
  slug: normalized-test-result-ingestion-contract
  type: requirement
  parent: "@test-result-run-store"
  depends_on:
    - "@test-result-acquisition"
  traits:
    - "@trait-type-safe-input"
  description: |
    The ingestion boundary accepts one kspec-owned normalized result
    format. Producers, reporters, and adapters translate framework-native
    output into this format before the core store, coverage engine, or
    daemon routes see it. The contract models runs, suites, and cases in
    general terms; it records stable case identity, display names,
    optional file/line locations, status, duration, diagnostic text,
    producer/source metadata, and zero or more acceptance-criterion
    references. It intentionally does not import a Vitest, JUnit, GitHub
    Actions, or kynetic-spec-specific result shape as the internal model.
  acceptance_criteria:
    - id: ac-owned-envelope
      given: |
        a producer submits test results
      when: |
        the ingestion boundary accepts the payload
      then: |
        the payload conforms to the kspec normalized run envelope rather
        than to a framework-native result schema
    - id: ac-status-vocabulary
      given: |
        a normalized test case in a submitted run
      when: |
        its status is read
      then: |
        the status is one of passed, failed, errored, skipped, or unknown,
        and unknown or skipped cases never count as positive coverage
        evidence
    - id: ac-stable-case-identity
      given: |
        a normalized test case with a producer-supplied stable id
      when: |
        the same logical case appears in a later run from the same
        producer and project revision
      then: |
        consumers can match the case by that stable id without relying on
        display-name text alone
    - id: ac-location-optional
      given: |
        a normalized test case whose producer cannot provide a file or
        line location
      when: |
        the run is ingested
      then: |
        ingestion still accepts the case and records location absence as
        absence rather than inventing a project-specific path
    - id: ac-diagnostics-preserved
      given: |
        a failing or errored normalized case with diagnostic text or a
        failure message
      when: |
        the run is read back
      then: |
        the diagnostic material needed for a human to identify the
        failure is preserved without requiring the original native result
        file
    - id: ac-producer-metadata
      given: |
        a run produced by a local command, CI job, or agent session
      when: |
        it is normalized
      then: |
        the run identifies the producer kind and producer label, and may
        carry optional source details such as command, CI URL, agent
        session id, or code revision without making any of those details
        mandatory for all producers

- title: Test Result AC Mapping
  slug: test-result-ac-mapping
  type: requirement
  parent: "@test-result-run-store"
  depends_on:
    - "@normalized-test-result-ingestion-contract"
  description: |
    Ingested results map test cases onto acceptance criteria through the
    normalized result contract, not through project-specific file names or
    the shape of one repository's test suite. A case may carry explicit
    criterion references emitted by a reporter or adapter, and adapters
    may also extract references from agreed text tokens in test names or
    suite names before producing the normalized payload. Core ingestion
    validates mapped references against the project's current spec corpus,
    records all valid mappings, and keeps invalid or absent mappings as
    unmapped result data that later surfaces can show. No result is
    silently discarded only because it cannot be mapped.
  acceptance_criteria:
    - id: ac-explicit-mapping
      given: |
        a normalized test case carrying explicit acceptance-criterion
        references
      when: |
        the run is ingested
      then: |
        each reference that resolves to an existing criterion in the
        project is attributed to that criterion
    - id: ac-token-mapping-before-core
      given: |
        a framework-native result whose test name contains an agreed
        acceptance-criterion token
      when: |
        an adapter normalizes the result
      then: |
        the adapter emits explicit normalized references, and the core
        ingestion path handles them exactly like any other explicit
        mapping
    - id: ac-invalid-mapping-reported
      given: |
        a normalized case whose mapped reference names a missing item or
        criterion
      when: |
        the run is ingested
      then: |
        ingestion records a structured unmapped-or-invalid mapping entry
        naming the case and offending reference, and does not attribute
        the case to any wrong criterion
    - id: ac-unmapped-results-retained
      given: |
        a normalized run containing test cases with no acceptance-criterion
        mapping
      when: |
        ingestion accepts the run
      then: |
        those cases remain attached to the run as unmapped cases so UI,
        CLI, or validation surfaces can report them later
    - id: ac-multiple-criteria
      given: |
        one test case intentionally covers multiple acceptance criteria
      when: |
        the case carries several valid criterion references
      then: |
        the run attributes the same case outcome to every referenced
        criterion without duplicating the stored case payload
    - id: ac-no-project-name-assumption
      given: |
        a kspec project whose package name, manifest file, test directory,
        and spec item slugs differ from kynetic-spec
      when: |
        its normalized test results are ingested
      then: |
        mapping behavior depends only on the project's loaded spec corpus
        and normalized references, not on kynetic-spec-specific names,
        paths, or test framework conventions

- title: Test Result Ingestion Interface
  slug: test-result-ingestion-interface
  type: requirement
  parent: "@test-result-run-store"
  depends_on:
    - "@shared-mutation-pipeline"
    - "@actor-identity-model"
    - "@test-result-ac-mapping"
  traits:
    - "@trait-json-output"
    - "@trait-semantic-exit-codes"
    - "@trait-error-guidance"
    - "@trait-api-endpoint"
    - "@trait-dry-run"
  description: |
    Test-result ingestion is exposed through matching CLI and daemon
    interfaces that accept the same normalized payload and produce the
    same stored run, validation diagnostics, cache updates, and events.
    The daemon does not run arbitrary test commands for this plan; it
    accepts completed run records submitted by trusted local tools, CI, or
    agents. Successful ingestion is a project metadata mutation and uses
    the shared mutation pipeline so the shadow commit, cache update, and
    typed event order match the rest of the redesign program.
  acceptance_criteria:
    - id: ac-cli-daemon-equivalence
      given: |
        the same valid normalized run payload
      when: |
        it is submitted once through the CLI and once through the daemon
        ingestion route in equivalent projects
      then: |
        both paths produce the same stored run shape, mapping report, and
        affected-domain event payloads before stamp-writing behavior is
        layered on by the ingestion-provenance stamp task
    - id: ac-no-daemon-execution
      given: |
        a caller wants test results represented in kspec
      when: |
        the ingestion interface is used
      then: |
        the daemon accepts a completed result payload and never executes
        a configured test command as part of this plan
    - id: ac-actor-source-attribution
      given: |
        a run submitted through CLI, daemon route, CI helper, or agent
        session
      when: |
        ingestion stores it
      then: |
        the run records the submitting actor resolved by the shared actor
        identity rules and records source metadata sufficient to identify
        whether the run came from local, CI, agent, or other producer
    - id: ac-session-attribution-optional
      given: |
        a run submitted from inside a kspec session or outside any
        session
      when: |
        ingestion stores it
      then: |
        the session id is recorded when supplied and valid, and absence
        of session id remains valid for non-session producers
    - id: ac-mutation-pipeline-order
      given: |
        a daemon-served ingestion succeeds
      when: |
        subscribers observe the emitted event and re-fetch the latest run
      then: |
        the shadow commit exists and the daemon read model reflects the
        ingested run before the event is observable
    - id: ac-static-mode-readonly
      given: |
        a static-export or read-only project snapshot
      when: |
        a caller attempts to ingest a run
      then: |
        the interface refuses with a read-only/static-mode error and does
        not pretend the result was stored
    - id: ac-dry-run-preview
      given: |
        a valid or invalid normalized payload is submitted with dry-run
        preview enabled through the CLI or daemon ingestion route
      when: |
        ingestion validates and maps the payload
      then: |
        the response reports the run id, validation diagnostics, mapping
        summary, affected items, and event scopes that would result, but
        no run folder, index entry, verification stamp, shadow commit,
        cache update, or event broadcast is produced

- title: Ingested Run Verification Stamps
  slug: ingested-run-verification-stamps
  type: requirement
  parent: "@test-result-run-store"
  depends_on:
    - "@ac-verification-record-store"
    - "@verification-session-evidence"
    - "@annotation-freshness-provenance"
    - "@test-result-ingestion-interface"
  description: |
    Passing ingested results can confirm the test mapping for their
    mapped acceptance criteria by writing verification stamps with
    ingestion provenance. Failed, errored, skipped, unknown, unmapped, or
    invalidly mapped cases do not write positive verification stamps.
    Detailed run data remains in the test-run store; the verification
    stamp records only the current verification fact supported by the
    existing stamp schema — verified time, actor, provenance, optional
    commit, and optional session linkage.
  acceptance_criteria:
    - id: ac-passing-mapped-writes-stamp
      given: |
        an accepted run containing a passed case mapped to an existing
        acceptance criterion
      when: |
        ingestion finalizes
      then: |
        the criterion's verification stamp is written or replaced with
        provenance ingestion, the run's completion time, the submitting
        actor, and any supplied commit or session linkage
    - id: ac-nonpassing-no-positive-stamp
      given: |
        an accepted run containing failed, errored, skipped, or unknown
        cases mapped to an acceptance criterion
      when: |
        ingestion finalizes
      then: |
        those cases do not write positive verification stamps for that
        criterion
    - id: ac-unmapped-no-stamp
      given: |
        an accepted run containing cases that cannot be mapped to any
        acceptance criterion
      when: |
        ingestion finalizes
      then: |
        no verification stamp is written for those cases, and their
        unmapped status remains available from the run record
    - id: ac-stamp-store-contract-preserved
      given: |
        a run ingestion writes verification stamps
      when: |
        the verification record store is read by existing consumers
      then: |
        the stamps conform to the existing verification stamp schema and
        do not require consumers to understand test-run store internals
    - id: ac-stamp-cli-daemon-equivalence
      given: |
        the same valid normalized run payload with passing mapped cases is
        submitted through the CLI and daemon ingestion paths in equivalent
        projects
      when: |
        ingestion-provenance stamp writing is enabled
      then: |
        both paths produce the same verification stamp writes, stamp-write
        count, non-positive mapped case count, and stored verification
        effects in the run record
    - id: ac-latest-ingested-run-freshness
      given: |
        more than one accepted run has written ingestion-provenance
        verification stamps
      when: |
        a consumer presents freshness based on ingested-run evidence
      then: |
        it labels the stamp as positive ingestion-provenance evidence from
        an ingested run while the detailed latest-run, failed-run, or
        unmapped evidence remains in the test-run store for the coverage
        state engine to evaluate
```

## Tasks

derive_from_specs: false

```yaml
- title: Implement the normalized test result schema and run store
  slug: task-test-result-run-store
  priority: 1
  tags: [coverage, ingestion, schema, storage]
  spec_ref: "@test-result-run-store"
  description: |
    Build the normalized test-run record schema and additive metadata
    sidecar store that future coverage-state computation reads.

    Why: The redesign decision @test-result-acquisition says coverage is
    ingestion-oriented, but no durable run store exists. This store must
    be general for any kspec project, not shaped around kynetic-spec's
    current Vitest output, package layout, or test file names.

    What:
    - Add Zod schemas for the concrete normalized run envelope, producer/source
      metadata, normalized flat case records, mapped criterion refs,
      unmapped/invalid mapping reports, verification effect summary, index
      summary, and a record-format version. Required fields: canonical run id
      as a ULID, completed_at, producer kind/label, case list, and each case's
      stable id, display name, and status. Optional fields: started_at,
      duration_ms, suite_path, file/line, diagnostic text, command, CI URL,
      code revision, session id, and producer-native metadata retained only
      under an explicitly namespaced extension object.
    - Store runs in the fixed sidecar layout
      `coverage/test-runs/index.yaml` and
      `coverage/test-runs/runs/<run-ulid>/run.yaml`. The per-run folder is a
      folder-backed entity: run.yaml is the source of truth for detailed
      case/mapping data; index.yaml stores bounded list/latest summaries for
      consumers and enumerates every accepted run id/path. The sidecar is
      additive like the verification store: no spec source or code source file
      changes on ingestion, absent store remains valid, first write
      materializes both the index and the runs directory, and newer record
      format is refused with deterministic diagnostics.
    - Implement folder-backed trait behavior for test runs: stable ULID
      directories, unknown-file preservation, bounded index entries,
      index-entry-and-run-folder writes in one logical atomic mutation,
      indexed mutation updates, rebuild from run folders, repair convergence,
      and semantic-default drift avoidance.

    - Preserve unrecognized fields within supported record-format
      versions across read/write cycles.
    - Implement latest-run lookup by completed_at with deterministic
      tie-break by run id.
    - Tests must use neutral fixture projects with different package/test
      layouts; no test may rely on this repository's real test result
      shape or kynetic-spec-specific path conventions.

    How: Put schemas in src/schema/ and the store in src/parser/ following
    the verification-record-store pattern: one store manager, tolerant
    reads, explicit format ceiling, and no CLI/daemon endpoint in this
    first task. Add focused unit tests for valid persistence, invalid
    rejection, sidecar-only writes, latest-run ordering, forward-compatible
    unknown fields, and newer-format refusal.

    Covers: @test-result-run-store ac-normalized-run-persistence,
    ac-framework-neutral-storage, ac-sidecar-only, ac-fixed-storage-layout,
    ac-latest-run-query, ac-invalid-run-rejected,
    ac-forward-compatible-records, ac-newer-record-format-refused.
    Covers @normalized-test-result-ingestion-contract ac-owned-envelope,
    ac-status-vocabulary, ac-stable-case-identity, ac-location-optional,
    ac-diagnostics-preserved, ac-producer-metadata for the schema/store
    contract. Covers @trait-type-safe-input ac-1, ac-2, and ac-3 for the
    normalized payload schema boundary. Covers @trait-folder-backed-entity-1
    ac-entity-has-ulid-directory, ac-index-excludes-heavy-detail-bytes,
    ac-unknown-files-preserved, ac-index-rebuilds-from-folders,
    ac-index-entry-created-with-folder, ac-indexed-mutation-updates-index,
    ac-index-repair-converges, ac-semantic-defaults-do-not-drift for the
    test-run store layout.

- title: Implement normalized mapping and unmapped-result reporting
  slug: task-test-result-ac-mapping
  priority: 1
  tags: [coverage, ingestion, mapping]
  spec_ref: "@test-result-ac-mapping"
  depends_on:
    - "@task-test-result-run-store"
  description: |
    Implement the mapper that validates normalized case-to-AC references
    against the loaded spec corpus and records every unmapped or invalid
    case explicitly.

    Why: The important general-system boundary is here. Core ingestion
    must consume explicit normalized references, not infer meaning from
    kynetic-spec's current tests, Vitest field names, or repository paths.
    Any framework parser is an adapter that emits normalized refs before
    this mapper runs.

    What:
    - Define the normalized AC reference shape used by test cases. It
      must reference the project's spec corpus by item ref/canonical id
      plus AC id, and resolve through the same ref index as other kspec
      surfaces.
    - Attribute a passed/failed/errored/skipped/unknown case to every
      valid referenced criterion without duplicating the stored case
      payload.
    - For each missing item, missing AC id, malformed reference, or case
      with no references, record a structured unmapped entry naming the
      case, native display name, and offending/absent reference.
    - Keep invalid mappings out of positive attribution. Do not guess a
      nearby AC or infer from file path.
    - Add a small adapter-boundary helper that can extract agreed AC
      tokens from arbitrary strings into normalized refs, but keep it
      outside the store/engine core. Tests should prove explicit refs and
      token-derived refs reach the core in the same normalized shape.
    - Tests: valid explicit mapping, token-derived normalized mapping,
      multiple criteria per case, malformed reference, missing item,
      missing AC id, unmapped case retained, and a fixture project whose
      names/paths differ from kynetic-spec.

    How: Implement as pure parser/mapping functions in src/parser/ so both
    CLI and daemon ingestion can call the same code. Use the existing
    ref-resolution utilities rather than introducing a coverage-specific
    ref resolver.

    Covers: @test-result-ac-mapping ac-explicit-mapping,
    ac-token-mapping-before-core, ac-invalid-mapping-reported,
    ac-unmapped-results-retained, ac-multiple-criteria,
    ac-no-project-name-assumption.

- title: Expose equivalent CLI and daemon ingestion interfaces
  slug: task-test-result-ingestion-interface
  priority: 1
  tags: [coverage, ingestion, cli, daemon, api]
  spec_ref: "@test-result-ingestion-interface"
  depends_on:
    - "@task-test-result-ac-mapping"
  description: |
    Add the user-facing ingestion paths: a CLI command and a daemon API
    route that accept the same normalized payload, use the same mapper and
    store, and produce the same mutation/event behavior.

    Why: Completed results may come from local scripts, CI, or agents.
    The daemon should not run arbitrary test commands for this slice; it
    should ingest completed run records. The CLI and daemon paths must be
    equivalent so automation does not create a second semantics path.

    What:
    - Add a CLI command under a coverage/test-result namespace that reads
      a normalized JSON payload from a file or stdin, validates it, maps
      AC references, writes the run, and prints human-readable or `--json`
      summaries containing run id, case counts, mapped criterion count,
      unmapped count, invalid mapping count, and affected item refs. Stamp-write
      counts are added by the later ingestion-provenance stamp task, not by
      this task.
    - Add a daemon route that accepts the same normalized JSON payload and
      returns the same summary shape using REST endpoint conventions:
      schema-derived request validation, JSON responses, structured error
      bodies, request ids, and semantic status codes. Successful writes must
      use the shared mutation pipeline for write → shadow commit → cache
      update → event broadcast ordering.
    - Add dry-run support for both CLI and daemon ingestion. Dry-run performs
      validation and mapping, reports the same diagnostics/summary/event scopes
      that a write would produce, and guarantees no run folder, index entry,
      verification stamp, shadow commit, cache update, or event broadcast.
      This command has no `--force`, confirmation prompt, state transition, or
      batch partial-success mode; those inherited trait cases are explicitly
      non-applicable. Accepted runs with unmapped/invalid mapping diagnostics
      still succeed because diagnostics are retained result data, not command
      partial failure.
    - Resolve actor identity through the shared actor write rules. Accept
      optional session and source metadata; validate session id shape but
      do not require a session.
    - Static/export mode refuses ingestion with a read-only/static-mode
      error.
    - Equivalence tests submit the same fixture through CLI and daemon in
      equivalent temporary projects and compare stored run shape, mapping
      report, and returned summary. Daemon tests assert the event is
      observable only after read-back sees the new run.

    How: Route implementation should call the same library function as
    the CLI after actor/source resolution. Do not shell out from the
    daemon to the CLI. Emit a minimal coverage-evidence-changed event on
    the spec-item domain (`items:updates`) for affected mapped items and
    for project-level unmapped-result summary changes. This plan's event
    says evidence changed; the companion engine plan defines final
    coverage-state event payload semantics after state recomputation.

    Covers: @test-result-ingestion-interface ac-cli-daemon-equivalence,
    ac-no-daemon-execution, ac-actor-source-attribution,
    ac-session-attribution-optional, ac-mutation-pipeline-order,
    ac-static-mode-readonly, ac-dry-run-preview. Covers the applicable
    ingestion-command portions of @trait-json-output, @trait-semantic-exit-codes,
    @trait-error-guidance, @trait-api-endpoint, and @trait-dry-run. Non-applicable
    inherited cases are explicitly out of scope for this command: confirmation
    decline, invalid state transition, batch partial failure, `--dry-run --force`,
    and list-endpoint pagination. Accepted runs with unmapped or invalid mapping
    diagnostics return success with diagnostics rather than semantic partial
    failure.

- title: Write ingestion-provenance verification stamps from passing mapped cases
  slug: task-ingested-run-verification-stamps
  priority: 1
  tags: [coverage, ingestion, verification]
  spec_ref: "@ingested-run-verification-stamps"
  depends_on:
    - "@task-test-result-ingestion-interface"
  description: |
    Connect accepted passing mapped results to the existing AC
    verification record store by writing ingestion-provenance stamps.

    Why: @annotation-freshness-provenance says ingested passing runs can
    supersede bootstrap freshness. P1a already built the stamp store;
    this task makes ingested runs write the current verification fact
    without expanding the stamp schema into a framework-specific result
    object.

    What:
    - For each passed case mapped to an existing criterion, write or
      replace that criterion's verification stamp with provenance
      ingestion, verified_at = run completed_at, actor = submitting actor,
      optional commit = run code revision, and optional session = supplied
      session id.
    - Do not write positive stamps for failed, errored, skipped, unknown,
      unmapped, or invalidly mapped cases.
    - Preserve the existing verification stamp schema. Store detailed
      run/case data only in the test-run store; stamps remain readable by
      existing freshness consumers without understanding run internals.
    - Make the CLI/API summary report how many stamps were written and
      how many mapped cases were non-positive evidence, and persist those
      verification effects in the run record consistently for CLI and daemon
      submissions.
    - Tests: passing mapped case writes ingestion stamp; failed/errored,
      skipped, unknown, unmapped, and invalidly mapped cases write none;
      commit/session attribution passes through; an existing stamp is
      replaced according to the verification store contract; existing
      freshness resolver returns the recorded ingestion stamp.

    How: Reuse writeVerificationStamp from the P1a store inside the same
    mutation transaction as the run write. If the run write succeeds but a
    stamp write would fail validation, the whole ingestion mutation fails
    and leaves both stores unchanged.

    Covers: @ingested-run-verification-stamps ac-passing-mapped-writes-stamp,
    ac-nonpassing-no-positive-stamp, ac-unmapped-no-stamp,
    ac-stamp-store-contract-preserved, ac-stamp-cli-daemon-equivalence,
    ac-latest-ingested-run-freshness.
    Also covers @annotation-freshness-provenance ac-2 and
    @test-result-acquisition ac-1, ac-2, ac-3 for the ingested-run path.

- title: Add producer contract docs and neutral ingestion fixtures
  slug: task-test-result-producer-contract-fixtures
  priority: 2
  tags: [coverage, ingestion, docs, tests]
  spec_ref: "@normalized-test-result-ingestion-contract"
  depends_on:
    - "@task-ingested-run-verification-stamps"
  description: |
    Document the normalized producer contract and add reusable fixtures
    that prove the ingestion path is project- and framework-neutral.

    Why: The first implementers and future adapters need a concrete
    contract, but the contract must not be mistaken for kynetic-spec's
    own test suite shape. Neutral fixtures are the regression guard.

    What:
    - Add developer documentation for the normalized JSON envelope,
      fixed shadow sidecar layout, required index.yaml and run-file shapes,
      required fields, status vocabulary, mapping reference shape,
      producer/source metadata, and examples for local, CI, and agent
      producers.
    - Include examples that do not mention kynetic-spec paths, packages,
      or Vitest fields. If Vitest or JUnit examples are included, label
      them as adapter examples that translate into the normalized
      envelope, not as accepted core schemas.
    - Add temp-project fixtures with two different repository layouts and
      test naming styles. One should submit explicit normalized refs; one
      should exercise token extraction before normalization. Both should
      verify the same core store/mapping behavior.
    - Add a negative fixture showing a framework-native payload rejected
      by the core ingestion endpoint until normalized, so the boundary is
      explicit.

    How: Keep docs near the CLI command/help text and tests near the new
    ingestion test suite. Run focused ingestion tests plus kspec validate
    before marking this task complete.

    Covers: @normalized-test-result-ingestion-contract ac-owned-envelope,
    ac-status-vocabulary, ac-stable-case-identity, ac-location-optional,
    ac-diagnostics-preserved, ac-producer-metadata.
```

## Implementation Notes

### What this plan is

This is the ingestion half of P1b. It creates a general, durable input
pipeline for completed test runs and makes accepted passing mapped results
write ingestion-provenance verification stamps. It deliberately stops
before deriving coverage states such as covered/failing/re-verify; that is
owned by the companion coverage-state-engine plan.

### Split rationale

The split keeps dependencies simple:

1. **This plan:** normalized run store, mapping, CLI/API ingestion,
   verification stamps.
2. **Coverage state engine plan:** read the run store plus existing
   annotation/freshness data and compute per-AC states.

The only dependency is one-way: the state engine consumes the run store.
The ingestion path is independently useful and testable through CLI/API
round-trips, stored runs, unmapped reports, and verification stamps.

### Expected storage layout

The P1b ingestion store has a fixed shadow-metadata layout:

```text
<specDir>/coverage/test-runs/index.yaml
<specDir>/coverage/test-runs/runs/<run-ulid>/run.yaml
```

Rules:

- Test runs adopt `@trait-folder-backed-entity-1`: each accepted run owns a
  stable directory named by its full ULID under `coverage/test-runs/runs/`.
- `<run-ulid>` is the canonical kspec run id and must be a valid ULID. Do
  not use producer-native ids, test names, timestamps, or filesystem paths
  as directory names.
- `runs/<run-ulid>/run.yaml` is the authoritative sidecar for detailed case,
  mapping, diagnostic, producer, and verification-effect data for that run.
- `index.yaml` is a bounded persisted list/latest summary for consumers and
  cache warm-up. It is updated in the same logical atomic mutation as the
  run folder and `run.yaml`; it can be rebuilt from run folders if needed,
  but reads must not materialize it in an otherwise absent store.
- `index.yaml` must enumerate every accepted run id and relative run-file
  path. It does not contain a per-criterion latest-evidence projection in
  this plan; downstream coverage-state consumers select latest relevant
  per-criterion evidence by reading the indexed run files and applying the
  completed_at plus run-id tie-break rule.
- The store exposes an index rebuild/repair path that scans
  `coverage/test-runs/runs/<run-ulid>/run.yaml` folders and rewrites
  `index.yaml`; a dry-run rebuild after repair must report no drift.
- Unknown files or directories inside a run folder are ignored by test-run
  semantics and preserved across writes, per the folder-backed entity trait.
- This plan does not adopt `@trait-entity-scoped-local-resources` and does
  not persist framework-native artifacts, logs, screenshots, XML, or JSON
  blobs. Those require a future artifact/resource-store plan if needed.
- The store lives beside the existing `coverage/verifications/<item-ulid>.yaml`
  verification sidecar and never rewrites `.kspec/modules/*` spec source.

Expected `index.yaml` shape:

```text
format: 1
runs:
  01ARZ3NDEKTSV4RRFFQ69G5FAV:
    path: runs/01ARZ3NDEKTSV4RRFFQ69G5FAV/run.yaml
    completed_at: "2026-06-22T21:15:00.000Z"
    producer:
      kind: local
      label: generic-project-tests
    code_revision: abc123
    totals:
      cases: 2
      mapped: 1
      unmapped: 1
      invalid: 0
      passed: 1
      failed: 0
      errored: 0
      skipped: 1
      unknown: 0
      stamps_written: 1
latest_run_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
```

Expected `runs/<run-ulid>/run.yaml` shape:

```text
format: 1
run:
  id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
  completed_at: "2026-06-22T21:15:00.000Z"
  started_at: "2026-06-22T21:14:10.000Z"
  duration_ms: 50000
producer:
  kind: local                 # local | ci | agent | other
  label: generic-project-tests
  command: npm test
  ci_url: null
  agent_session: null
  code_revision: abc123
  native:
    run_id: producer-owned-id
cases:
  - id: case-stable-id-1
    display_name: accepts explicit AC references
    suite_path: [adapter contract]
    status: passed            # passed | failed | errored | skipped | unknown
    duration_ms: 12
    location:
      file: tests/adapter-contract.test.ts
      line: 42
    diagnostic: null
    refs:
      - item_ref: "@generic-feature"
        ac_id: ac-explicit-mapping
  - id: case-stable-id-2
    display_name: plain test without AC reference
    suite_path: [adapter contract]
    status: skipped
    refs: []
mapping:
  attributed:
    - case_id: case-stable-id-1
      item_ulid: 01BX5ZZKBKACTAV9WEVGEMMVRZ
      item_ref: "@generic-feature"
      ac_id: ac-explicit-mapping
      status: passed
  unmapped:
    - case_id: case-stable-id-2
      reason: no_refs
      display_name: plain test without AC reference
  invalid: []
verification_effects:
  stamps_written:
    - case_id: case-stable-id-1
      item_ulid: 01BX5ZZKBKACTAV9WEVGEMMVRZ
      ac_id: ac-explicit-mapping
      verified_at: "2026-06-22T21:15:00.000Z"
  non_positive_mapped_cases: []
```

Field-name and layout compatibility is part of this plan's contract. An
implementation agent may add forward-compatible optional fields under
schema-approved extension objects, but must not rename these fields, move the
store, switch away from folder-backed run entities, or store framework-native
payloads as the core persistence model.

### General-system guardrails

- Core ingestion accepts the kspec normalized envelope, not Vitest JSON,
  JUnit XML, GitHub Actions artifacts, or this repository's current test
  progress reporter output.
- Framework-native importers are adapters. They may live later or as thin
  examples, but the store, mapper, daemon route, and state engine never
  depend on native adapter fields.
- Tests must include temporary kspec projects whose package names, test
  paths, spec slugs, and framework labels are not kynetic-spec.
- Do not infer AC mappings from file paths or repository conventions. The
  core mapping input is explicit normalized references, optionally produced
  by an adapter/token extractor before core ingestion.
- Do not make the daemon run test commands in this plan. Command execution
  policy, resource limits, and dispatch-engine contention are separate
  concerns deliberately avoided by the global ingestion decision.

### Relationship to imported redesign plans

- `@plan-ui-redesign-global-decisions` provides
  `@test-result-acquisition`, `@annotation-freshness-provenance`, and
  `@coverage-state-presentation` decision boundaries.
- `@plan-ac-coverage-verification-schema-and-storage` provides the
  verification stamp store, freshness resolver, session evidence, and
  compatibility rules. This plan writes stamps through that store; it does
  not replace it.
- `@plan-dispatch-mutation-service` provides the mutation pipeline and
  event vocabulary reservation. Ingestion writes must use the pipeline for
  daemon-served mutations.
- `@plan-web-ui-foundations` provides actor identity/write rules consumed
  by ingestion attribution.

### Event and cache boundary

A successful ingestion is a metadata mutation. It should broadcast a
minimal coverage-evidence-changed event on the spec-item domain
(`items:updates`) after the run store and any ingestion-provenance stamps
are committed and visible. The event identifies mapped affected items when
known and can carry a project-summary scope when only unmapped-result
summaries changed. It must not claim final covered/failing/not-yet/re-verify
state; the companion coverage-state-engine plan owns final coverage-state
payload semantics and cache invalidation for computed states.

### Migration and backcompat

- Projects with no test-run store remain valid and unchanged.
- Reads do not create the store.
- First accepted ingestion creates the sidecar.
- Older kspec versions ignore the sidecar if they do not know it.
- Newer record formats fail closed for the store only.
- Unknown fields in supported records round-trip.

### Scope exclusions

- Running tests from the daemon.
- A full adapter library for every framework.
- Coverage-state computation and UI presentation.
- Flakiness history, matrix observations, and trend analytics.
- Merge/repair/revert actions.
- Authentication or multi-user authorization. Actor identity here is
  attribution, consistent with the imported UI foundation plan.

### Validation gates

Before this plan is considered ready for approval, run at least:

- `KSPEC_NO_DAEMON=1 kspec plan import /home/chapel/Projects/kynetic-spec/plans/ui-redesign-test-result-ingestion.md --module @core --status draft --dry-run --json`
- `KSPEC_NO_DAEMON=1 kspec validate --warnings-ok`

Implementation tasks should add focused unit/integration tests and preserve
the established TypeScript build order: generate `packages/shared/dist`
before root `tsc` when a task touches shared package types.
