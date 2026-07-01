# Coverage State Artifact Store and Compute Parity

> **Program track:** kspec interface redesign / coverage states, P1d follow-up.
>
> **Reason for plan:** The unified spec workspace and coverage APIs currently prove the
> projection model, but the live daemon route can cold-build coverage state during UI
> interaction. On the Kynetic self-hosting corpus that blocks the UI for minutes. Coverage
> state must become a daemon-independent, CLI-first, filesystem-backed project artifact so
> the daemon, CLI, static export, doctor/upgrade, and web UI all consume the same computed
> state instead of making the daemon the only practical consumer.
>
> **Approval gate:** Discuss direction before plan-reviewer review. Do not derive work
> until we agree on the storage layout, branch/staleness semantics, and async job UX.
>
> **Branch gate:** When imported, keep this plan on the shared redesign branch
> (`feat/ui-redesign`) with the other UI redesign plans. The feature is a general kspec
> coverage/state capability for any project, not Kynetic-specific UI glue.
>
> **Design constraints:**
>
> - Coverage state parity means CLI-only workflows can compute, inspect, diagnose, and
>   export coverage state without a daemon.
> - The daemon is one consumer and optional job orchestrator, not the owner of coverage
>   truth.
> - Stored state lives in the shadow metadata filesystem and is tied to the target source
>   branch/revision it was computed for.
> - Request-time reads must never perform heavy coverage computation. Reads may report
>   missing, stale, computing, failed, or ready artifact status with recovery guidance.
> - Branch-aware behavior must distinguish the project target branch from an arbitrary
>   checked-out work branch: a matching target-branch artifact may be reused; a divergent
>   work branch must be reported stale or recomputed for that branch/revision rather than
>   silently showing target-branch state as current.

## Specs

```yaml
# ─── Durable Coverage State Artifacts ───

- title: Coverage State Artifact Store
  slug: coverage-state-artifact-store
  type: feature
  parent: "@coverage-state-engine"
  depends_on:
    - "@coverage-state-engine"
    - "@coverage-evidence-index"
    - "@coverage-state-api-cache"
  traits:
    - "@trait-folder-backed-entity-1"
  description: |
    Coverage state is persisted as a project metadata artifact after an explicit
    compute operation. The artifact store records the computed coverage-state
    snapshot, bounded index metadata, generator details, input fingerprints,
    target source branch identity, source revision identity, and shadow metadata
    revision identity needed to decide whether the artifact is current for a
    later reader. The store lives in the shadow metadata filesystem and is
    usable by CLI, daemon, static export, doctor, upgrade, and web consumers
    without requiring a daemon process.
  acceptance_criteria:
    - id: ac-shadow-filesystem-storage
      given: |
        coverage state has been computed for a project
      when: |
        the result is stored for later consumers
      then: |
        the bounded artifact index and the computed state snapshot are written
        under the project's shadow metadata filesystem rather than only in a
        process-local cache, daemon memory, project source files, or web UI state
    - id: ac-artifact-provenance-recorded
      given: |
        a coverage-state artifact is stored
      when: |
        any consumer reads its metadata
      then: |
        the metadata identifies the target source branch or detached ref, source
        revision, shadow metadata revision, coverage config fingerprint, schema
        version, generator identity, generation time, and completion status
    - id: ac-branch-keyed-artifacts
      given: |
        coverage state is computed for different source branches or detached
        revisions of the same project
      when: |
        those artifacts are stored
      then: |
        the store keeps them distinguishable by branch/ref and revision so one
        branch's state is not silently treated as current for another branch
    - id: ac-ready-artifact-read-without-daemon
      given: |
        a ready coverage-state artifact exists for the current project context
      when: |
        a CLI command, static export, daemon route, or web static provider reads
        coverage state
      then: |
        it can load the stored artifact without starting or contacting a daemon
        and without rebuilding the coverage evidence index during that read
    - id: ac-failed-and-partial-status-preserved
      given: |
        a coverage-state compute attempt fails after identifying its context
      when: |
        the failure is recorded
      then: |
        the store preserves bounded failed status and diagnostics without
        replacing the last ready artifact for that branch/revision
    - id: ac-forward-compatible-artifacts
      given: |
        a stored coverage-state artifact declares a supported schema version and
        contains unrecognized fields
      when: |
        the artifact is read and rewritten by a later kspec version
      then: |
        supported fields are read normally and unrecognized compatible fields are
        preserved rather than discarded

# ─── Branch-Aware Freshness ───

- title: Coverage Artifact Freshness and Branch Semantics
  slug: coverage-artifact-freshness-branch-semantics
  type: requirement
  parent: "@coverage-state-artifact-store"
  depends_on:
    - "@coverage-state-artifact-store"
    - "@coverage-freshness-revision-comparison"
  description: |
    Readers classify a stored coverage-state artifact against the source checkout
    and shadow metadata currently being inspected. A configured target branch can
    have an authoritative stored artifact for ordinary project status, while a
    different checked-out work branch is treated as a separate source context.
    Branch mismatch, source revision drift, shadow metadata drift, coverage config
    drift, and missing artifacts are surfaced as status, not hidden by synchronous
    recomputation during reads.
  acceptance_criteria:
    - id: ac-target-branch-context
      given: |
        a project has a configured or selected target source branch for coverage
        status
      when: |
        coverage state is computed or read for that target
      then: |
        the artifact metadata records that target branch context and readers can
        request or display the target-branch artifact explicitly
    - id: ac-work-branch-does-not-reuse-target-as-current
      given: |
        a user is on a source branch or detached revision that differs from the
        stored artifact's target branch/revision
      when: |
        coverage state is read for the checked-out context
      then: |
        the reader reports the artifact as missing or stale for that context
        instead of presenting the target-branch artifact as current state
    - id: ac-staleness-reasons-enumerated
      given: |
        a stored artifact cannot be considered current
      when: |
        its freshness is evaluated
      then: |
        the status names the reason class, such as missing artifact, branch
        mismatch, source revision drift, shadow metadata drift, coverage config
        drift, unsupported schema, failed compute, or compute in progress
    - id: ac-no-request-time-heavy-recompute
      given: |
        a daemon route, CLI read command, static provider, or web UI query needs
        coverage state
      when: |
        no current ready artifact exists
      then: |
        the read returns artifact status and guidance without synchronously
        scanning annotations, running freshness git comparisons, or building the
        full coverage-state model as part of the read request
    - id: ac-recompute-is-explicit
      given: |
        a coverage-state artifact is missing or stale
      when: |
        a user or daemon wants to refresh it
      then: |
        refresh occurs through an explicit compute command or background job with
        progress/status reporting rather than as an implicit side effect of a
        normal read
    - id: ac-smart-reuse-boundary
      given: |
        only part of the source or shadow metadata changed since the last ready
        artifact
      when: |
        kspec decides whether to reuse or recompute stored coverage state
      then: |
        it uses recorded input fingerprints to reuse matching sub-results when
        supported and otherwise marks the artifact stale with a bounded reason;
        it does not return stale data as ready merely because a previous artifact
        exists

# ─── Compute Interfaces ───

- title: Coverage State Compute Interface
  slug: coverage-state-compute-interface
  type: feature
  parent: "@coverage-state-artifact-store"
  depends_on:
    - "@coverage-state-artifact-store"
    - "@coverage-artifact-freshness-branch-semantics"
    - "@coverage-state-engine"
  traits:
    - "@trait-semantic-exit-codes"
    - "@trait-error-guidance"
  description: |
    Coverage-state computation is exposed through equivalent CLI and daemon job
    interfaces backed by the same shared service. The CLI path is complete on its
    own: it can compute, store, inspect, and diagnose artifacts without a daemon.
    The daemon path wraps that service as an optional background job and emits
    events for interactive clients.
  acceptance_criteria:
    - id: ac-cli-compute
      given: |
        a user has only the kspec CLI and a project checkout
      when: |
        they run the coverage-state compute command for the current or selected
        target branch context
      then: |
        kspec computes coverage state, writes a branch/revision-keyed artifact,
        prints summary counts, artifact identity, freshness metadata, and
        diagnostics, and exits with semantic success or failure status
    - id: ac-cli-status-and-show
      given: |
        a project may or may not have stored coverage-state artifacts
      when: |
        the user runs coverage-state status or show commands
      then: |
        the CLI reports ready/missing/stale/computing/failed status, staleness
        reasons, branch context, source revision, summary counts when available,
        and the exact command needed to recompute
    - id: ac-daemon-job-equivalence
      given: |
        the daemon starts a coverage-state compute job for the same project and
        branch context as the CLI
      when: |
        the job completes successfully
      then: |
        it writes the same artifact shape and equivalent summary/status metadata
        as the CLI compute path, differing only in occurrence-specific ids,
        timestamps, and duration values
    - id: ac-single-flight-per-context
      given: |
        multiple compute requests target the same project branch/revision context
      when: |
        a compute is already running
      then: |
        kspec deduplicates or refuses duplicate work with guidance instead of
        launching competing writers for the same artifact context
    - id: ac-doctor-and-upgrade-visibility
      given: |
        a project uses coverage state or spec workspace features
      when: |
        doctor or upgrade checks run
      then: |
        they report missing, stale, failed, unsupported, or legacy in-memory-only
        coverage-state situations and point to the CLI compute/status commands

# ─── Consumer Parity ───

- title: Coverage State Consumer Parity
  slug: coverage-state-consumer-parity
  type: requirement
  parent: "@coverage-state-artifact-store"
  depends_on:
    - "@coverage-state-compute-interface"
    - "@unified-spec-workspace-data-projection"
    - "@coverage-resolution-mutation-interface"
  description: |
    Every coverage consumer reads from the same artifact-aware coverage-state
    service. Daemon APIs, CLI commands, static export, the spec workspace,
    coverage resolution previews, Validate destinations, and web UI widgets use
    a shared status/read contract so behavior is consistent whether or not a
    daemon is running.
  acceptance_criteria:
    - id: ac-daemon-reads-artifact-not-cold-build
      given: |
        a daemon coverage-state or spec-workspace route handles a normal read
      when: |
        it needs coverage data
      then: |
        it reads the current stored artifact or returns artifact status and does
        not cold-build coverage state in the request path
    - id: ac-static-export-uses-artifact
      given: |
        a static export is generated for a project
      when: |
        coverage state is included in the export
      then: |
        the export uses a ready stored artifact for the selected branch context
        or reports that coverage state is unavailable/stale according to the
        same artifact status contract
    - id: ac-resolution-uses-current-artifact
      given: |
        a coverage resolution action validates a target criterion
      when: |
        the current coverage-state artifact for the selected context is missing
        or stale
      then: |
        the action refuses or previews with guidance to recompute rather than
        deriving a raw fresh model that bypasses artifact freshness semantics
    - id: ac-ui-status-ux
      given: |
        the web UI or spec workspace loads coverage data
      when: |
        coverage state is missing, stale, computing, failed, or ready
      then: |
        the UI shows a scoped state with branch/revision context and an
        appropriate action or explanation instead of blocking navigation on
        coverage computation
    - id: ac-cli-daemon-static-consistency
      given: |
        CLI, daemon, and static export read the same ready coverage artifact
      when: |
        they present summary counts, item rollups, criterion details, or
        unmapped result summaries
      then: |
        the values and staleness metadata agree across consumers within the
        limits of each surface's read-only or interactive capabilities
```

## Tasks

derive_from_specs: false

```yaml
- title: Define branch-aware coverage artifact storage contract
  slug: task-coverage-artifact-storage-contract
  priority: 1
  tags: [specs, coverage, storage, branch-semantics]
  spec_ref: "@coverage-state-artifact-store"
  description: |
    What:
    - Update the newly derived storage/freshness specs if needed after plan
      discussion so they remain timeless and project-neutral.
    - Confirm the concrete storage layout before implementation. Proposed
      starting point for discussion:
      - `coverage/state/index.yaml` as the bounded artifact index in the shadow
        metadata filesystem;
      - `coverage/state/snapshots/<snapshot-ulid>/state.yaml` as the full
        computed coverage-state snapshot;
      - optional `coverage/state/snapshots/<snapshot-ulid>/diagnostics.yaml` for
        bounded compute diagnostics when the main snapshot should stay compact.
    - Define the artifact metadata fields precisely: artifact id, schema version,
      status, target branch/ref, source revision, shadow metadata revision,
      coverage config fingerprint, input/corpus fingerprint, generated_at,
      generator, duration, previous ready artifact pointer, and failure summary.
    - Decide how this project selects a target branch. For Kynetic self-hosting
      that will usually be the integration target branch (`dev`), but the spec
      and implementation must support arbitrary projects and detached contexts.
    - Define stale reason enums and response/status shapes before code work.

    Why:
    The core product decision is storage and freshness semantics, not a route
    optimization. If the artifact cannot be interpreted outside a daemon or
    across source branches, coverage parity is not actually solved.

    How:
    - Inspect existing folder-backed storage patterns in `src/parser/*store*.ts`,
      `src/parser/plan-storage-manager.ts`, `src/parser/review-storage-manager.ts`,
      and the normalized test-run store.
    - Inspect `src/parser/coverage-state-read-model.ts`,
      `src/parser/coverage-evidence-index.ts`, and
      `src/parser/coverage-freshness-comparison.ts` to identify which inputs
      belong in fingerprints.
    - Keep exact current Kynetic branch names in task notes only; do not bake
      them into spec AC text.

    Testing:
    - Use `kspec item get` on the derived specs to verify the ACs describe
      reusable kspec behavior and not this repository's one branch policy.
    - Run `kspec validate --warnings-ok` after spec materialization.

    Covers: @coverage-state-artifact-store ac-shadow-filesystem-storage,
    ac-artifact-provenance-recorded, ac-branch-keyed-artifacts;
    @coverage-artifact-freshness-branch-semantics ac-target-branch-context,
    ac-staleness-reasons-enumerated

- title: Implement the coverage state artifact store and freshness classifier
  slug: task-coverage-artifact-store-implementation
  priority: 1
  tags: [coverage, storage, parser, branch-semantics]
  spec_ref: "@coverage-state-artifact-store"
  depends_on:
    - "@task-coverage-artifact-storage-contract"
  description: |
    What:
    - Add schema types for coverage-state artifact index entries, snapshot
      sidecars, status values, stale reason enums, and versioned forward-
      compatible records.
    - Implement parser/storage helpers for writing a completed artifact, recording
      a bounded failed compute attempt, loading the best artifact for a requested
      context, and classifying readiness/staleness against the current checkout.
    - Compute branch/ref and revision identity using git in a bounded helper.
      Treat detached revisions explicitly instead of pretending they are a named
      branch.
    - Record shadow metadata revision/fingerprint and coverage config/input
      fingerprints so readers can distinguish source drift from metadata/config
      drift.
    - Preserve the previous ready artifact when a newer compute fails.
    - Do not modify project source files or spec item YAML except through the
      shadow metadata artifact store.

    Why:
    This is the daemonless source of truth. All later CLI, daemon, export, and UI
    work should depend on this store rather than rebuilding the model in each
    consumer.

    How:
    - Prefer a dedicated module such as
      `src/parser/coverage-state-artifact-store.ts` plus schema definitions under
      `src/schema/`.
    - Follow folder-backed index consistency conventions from
      `@trait-folder-backed-entity-1`.
    - Use deterministic index ordering and forward-compatible YAML parsing
      patterns already used by test-run, plan, and review stores.
    - Add tests with temp git repositories that simulate:
      - target branch artifact read on the same branch;
      - different work branch read against target artifact;
      - source revision drift;
      - shadow metadata drift;
      - coverage config drift;
      - failed compute preserving previous ready artifact.

    Testing:
    - `npm test -- --fresh tests/coverage-state-artifact-store.test.ts`
    - `npm test -- --fresh tests/coverage-state-read-model.test.ts tests/test-result-ingestion.test.ts`
    - `npm run typecheck`

    Covers: @coverage-state-artifact-store ac-shadow-filesystem-storage,
    ac-artifact-provenance-recorded, ac-branch-keyed-artifacts,
    ac-failed-and-partial-status-preserved, ac-forward-compatible-artifacts;
    @coverage-artifact-freshness-branch-semantics ac-work-branch-does-not-reuse-target-as-current,
    ac-staleness-reasons-enumerated, ac-smart-reuse-boundary

- title: Add CLI-first coverage state compute status and show commands
  slug: task-coverage-state-cli-parity
  priority: 1
  tags: [coverage, cli, doctor, upgrade]
  spec_ref: "@coverage-state-compute-interface"
  depends_on:
    - "@task-coverage-artifact-store-implementation"
  description: |
    What:
    - Add CLI commands for daemonless coverage state operation. Proposed command
      shape for discussion:
      - `kspec coverage state compute [--target-branch <name>|--current] [--json]`
      - `kspec coverage state status [--target-branch <name>|--current] [--json]`
      - `kspec coverage state show [--item <ref>] [--ac <id>] [--json]`
    - The compute command uses the existing coverage-state engine, writes the
      artifact store, prints summary counts/status, and never requires a daemon.
    - The status/show commands read stored artifacts and freshness classifications
      only; they must not scan annotations or perform heavy model computation.
    - Add doctor/upgrade checks that surface missing/stale/failed/unsupported
      coverage artifacts with the exact recompute command.
    - Ensure semantic exit codes distinguish ready, stale/missing, validation
      error, and compute failure in human and JSON modes.

    Why:
    Coverage parity means operators can use coverage without the web UI or daemon.
    The CLI must be the foundational producer/inspector, not an afterthought.

    How:
    - Extend `src/cli/commands/coverage.ts` rather than creating an unrelated
      top-level command group.
    - Keep compute and read/status code in shared parser/service modules so daemon
      jobs call the same implementation.
    - Make heavy work explicit in command descriptions and progress output.
    - Avoid `KSPEC_NO_DAEMON=1` assumptions in tests unless deliberately testing
      daemonless command execution; normal CLI should work with or without daemon
      routing according to existing command conventions.

    Testing:
    - Add CLI integration tests covering compute/status/show in temp projects on
      target and work branches.
    - Prove status/show do not call the heavy compute path by using test seams or
      fixtures with missing scan paths.
    - Run `npm test -- --fresh tests/coverage-state-cli.test.ts tests/doctor.test.ts tests/upgrade*.test.ts` with the exact suites adjusted to existing filenames.

    Covers: @coverage-state-compute-interface ac-cli-compute,
    ac-cli-status-and-show, ac-doctor-and-upgrade-visibility;
    @coverage-artifact-freshness-branch-semantics ac-recompute-is-explicit,
    ac-no-request-time-heavy-recompute

- title: Convert daemon coverage reads to artifact status and async jobs
  slug: task-coverage-state-daemon-artifact-jobs
  priority: 1
  tags: [coverage, daemon, api, async-jobs, performance]
  spec_ref: "@coverage-state-compute-interface"
  depends_on:
    - "@task-coverage-state-cli-parity"
  description: |
    What:
    - Replace request-time cold coverage-state computation in daemon read routes
      with artifact reads and status responses.
    - Add a daemon background job wrapper around the same shared compute service
      used by the CLI. Proposed API shape for discussion:
      - `GET /api/coverage/state/status`
      - `POST /api/coverage/state/jobs` to start or join a compute for a selected
        branch context
      - `GET /api/coverage/state/jobs/:id` for job progress/result
    - Preserve existing `/api/coverage/state/summary`, `/items/:ref`,
      `/criteria/:ref/:acId`, and `/unmapped` routes by making them return ready
      artifact data or an explicit unavailable/stale response. Do not silently
      run the old full compute on those reads.
    - Keep single-flight behavior per project/branch/revision context and bounded
      diagnostics for duplicate or failed jobs.
    - Emit existing coverage-state events after a completed artifact changes the
      ready state; do not event-storm progress ticks.

    Why:
    The daemon should provide an interactive UX around compute, but it should not
    be the only viable way to compute coverage and should not block UI navigation
    while doing heavy work.

    How:
    - Update `packages/daemon/src/routes/coverage.ts` and
      `packages/daemon/src/routes/spec-workspace.ts` to use the artifact-aware
      read service.
    - Keep the in-memory cache, if retained, as a short-lived artifact-read cache
      keyed by artifact identity, not as the canonical state store.
    - Add API contract tests that time-bound normal read paths and assert they do
      not call the heavy compute service when an artifact is missing/stale.
    - Ensure route responses include request ids and existing envelope metadata.

    Testing:
    - `npm test -- --fresh tests/coverage-state-api.test.ts tests/daemon-api/spec-workspace.test.ts tests/daemon-entity-cache.test.ts`
    - Add a performance-style regression using a mocked slow compute service to
      prove read routes return status immediately while compute happens only via
      the job route.

    Covers: @coverage-state-compute-interface ac-daemon-job-equivalence,
    ac-single-flight-per-context; @coverage-state-consumer-parity
    ac-daemon-reads-artifact-not-cold-build; @coverage-artifact-freshness-branch-semantics
    ac-no-request-time-heavy-recompute, ac-recompute-is-explicit

- title: Update static export workspace and resolution consumers for artifact parity
  slug: task-coverage-consumer-artifact-parity
  priority: 1
  tags: [coverage, export, web-ui, spec-workspace, resolution]
  spec_ref: "@coverage-state-consumer-parity"
  depends_on:
    - "@task-coverage-state-daemon-artifact-jobs"
  description: |
    What:
    - Update JSON/static export to use stored ready coverage artifacts by default
      instead of performing surprise heavy computation during export. If an
      explicit export-time compute flag is accepted, it must call the same shared
      compute service and report cost/status clearly.
    - Update static web providers so coverage artifact metadata and stale/missing
      status are available to the workspace and coverage widgets.
    - Update unified spec workspace routes/components to show missing/stale/
      computing/failed/ready states with branch/revision context and recompute
      guidance, without horizontal-scroll regressions.
    - Update coverage resolution validation/previews so they require a current
      artifact for the selected context or clearly refuse with guidance to
      recompute. They must not bypass artifact freshness by deriving raw state.
    - Ensure Validate/coverage consumers share the same status contract instead
      of inventing UI-only loading states.

    Why:
    This closes the parity loop: CLI, daemon, static export, workspace, coverage
    resolution, and future Validate surfaces should all talk about the same
    stored state and same freshness decision.

    How:
    - Touch `src/export/json.ts`, `packages/web-ui/src/lib/api-static.ts`,
      `packages/web-ui/src/lib/api.ts`, spec workspace components, and coverage
      resolution client modules as needed.
    - Keep mutation affordances disabled in static/read-only contexts.
    - Preserve existing coverage-state snapshot compatibility for older exports;
      older snapshots should degrade gracefully.
    - Use branch/status copy that explains target branch vs current work branch
      without making Kynetic's `dev` branch a universal default.

    Testing:
    - `npm test -- --fresh tests/spec-workspace-static.test.ts tests/web-ui/spec-workspace-coverage-presentation.test.ts tests/web-ui/coverage-resolution-api.test.ts tests/web-ui/ws-cache-invalidation.test.ts`
    - Run a browser smoke test proving `/specs` opens immediately on a project
      with missing/stale coverage state and shows recompute guidance rather than
      blocking on compute.
    - Run static export tests proving a ready artifact is embedded and a missing
      artifact is represented as unavailable/stale metadata.

    Covers: @coverage-state-consumer-parity ac-static-export-uses-artifact,
    ac-resolution-uses-current-artifact, ac-ui-status-ux,
    ac-cli-daemon-static-consistency; @unified-spec-workspace-data-projection
    ac-static-readonly-projection, ac-error-boundaries

- title: Optimize compute internals and prove large corpus behavior
  slug: task-coverage-artifact-large-corpus-verification
  priority: 1
  tags: [coverage, performance, validation, large-corpus]
  spec_ref: "@coverage-artifact-freshness-branch-semantics"
  depends_on:
    - "@task-coverage-consumer-artifact-parity"
  description: |
    What:
    - Profile and optimize the heavy compute path now that it runs out of band.
      Focus on avoiding thousands of repeated git subprocesses for identical
      source files/timestamps/revisions.
    - Add caching or batching inside compute for annotation blame, criterion text
      comparison, `git log --before`, `git show`, and source-revision ancestry
      checks where correctness allows.
    - Preserve exact coverage-state semantics while reducing cold compute time.
    - Add a large-corpus regression fixture or synthetic benchmark that proves
      request-time reads stay bounded and explicit compute reports progress and
      final stats.
    - Validate behavior on the Kynetic self-hosting corpus manually, but keep
      tests general and portable.

    Why:
    Moving compute out of the UI path fixes responsiveness, but the compute
    command/job still needs useful progress, failure diagnostics, and acceptable
    runtime. This task turns the discovered Kynetic-scale failure into a
    reusable performance guard.

    How:
    - Keep optimization in shared parser/service modules, not daemon routes.
    - Consider per-file/revision memoization and batch git queries before adding
      complex incremental recompute.
    - If true per-criterion incremental recompute is too large for this plan,
      explicitly document the first supported smart-reuse boundary and leave a
      follow-up note for finer-grained incremental updates.
    - Browser/manual proof should include a real `/specs` load on the Kynetic
      corpus with no current artifact and with a ready artifact.

    Testing:
    - Add focused tests for memoization/batching behavior without relying on
      wall-clock-only assertions.
    - Run broad gates: `npm run format`, `npm run lint`, `npm run typecheck`, and
      the relevant coverage/workspace test shards.
    - Manual verification: compute coverage artifact for the Kynetic corpus,
      record artifact status/counts/duration, then prove workspace read routes do
      not recompute and the UI remains responsive.

    Covers: @coverage-artifact-freshness-branch-semantics ac-smart-reuse-boundary,
    ac-no-request-time-heavy-recompute; @coverage-state-api-cache
    ac-performance-bounded; @coverage-state-consumer-parity
    ac-daemon-reads-artifact-not-cold-build, ac-cli-daemon-static-consistency
```

## Open Discussion Points Before Review

- Should the stored artifact keep one latest ready snapshot per target branch, or retain a bounded history per branch/revision for comparisons and rollback?
- How should a project declare its default target branch for coverage status: reuse dispatch/integration target config when present, add explicit coverage config, or infer from git default branch?
- Should static export fail, warn, or omit coverage state when the artifact is missing/stale unless an explicit compute flag is provided?
- What is the minimum acceptable smart-update behavior in this plan: fingerprint-aware full recompute only, or partial reuse of per-file/per-criterion freshness work?
- Should daemon job state be local-only while completed artifacts are committed to shadow, or should bounded job records also be persisted in shadow metadata?
