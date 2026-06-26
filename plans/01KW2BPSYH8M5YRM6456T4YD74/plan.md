# Coverage Resolution Mutations

> **Program track:** kspec interface redesign / coverage states, P1c.
>
> **Approval gate:** Do not approve or derive this plan until
> @plan-ac-coverage-verification-schema-and-storage, @plan-test-result-ingestion,
> @plan-coverage-state-engine, and @plan-dispatch-mutation-service are completed
> on the redesign branch. This plan consumes the verification stamp store,
> normalized run store, coverage-state read model, per-AC freshness comparison,
> and shared mutation/event pipeline; it must not recreate any of them.
>
> **Branch gate:** When imported, keep this plan on the shared redesign branch
> (`feat/ui-redesign`) with the other imported UI redesign plans. These
> mutations are backend/general-system work for any kspec project; they are not
> a special case for developing kynetic-spec itself.

## Specs

```yaml
# ─── Resolution Action Contract ───

- title: Coverage Resolution Mutation Interface
  slug: coverage-resolution-mutation-interface
  type: feature
  depends_on:
    - "@coverage-state-engine"
    - "@coverage-state-api-cache"
    - "@shared-mutation-pipeline"
    - "@actor-identity-model"
  traits:
    - "@trait-api-endpoint"
    - "@trait-dry-run"
    - "@trait-semantic-exit-codes"
    - "@trait-error-guidance"
  description: |
    Coverage resolution actions are one shared mutation surface for
    operator responses to backend-computed coverage state. The surface
    exposes exactly three actions against an acceptance criterion:
    explicit re-verification, spec-text revert, and dispatch-fix request.
    Every action is available through equivalent CLI and daemon interfaces,
    consumes the current server-computed coverage-state read model, supports
    dry-run previews, refuses static/read-only snapshots, and reports its
    stored effects and affected coverage-state scopes without requiring a UI
    client to reconstruct state or mutation semantics locally.
  acceptance_criteria:
    - id: ac-action-set
      given: |
        a caller wants to resolve a coverage-state issue for a specific
        acceptance criterion
      when: |
        the coverage resolution mutation interface is enumerated
      then: |
        it exposes exactly the supported action kinds explicit-reverify,
        spec-text-revert, and dispatch-fix, each with a stable request and
        response shape naming the target item and criterion
    - id: ac-current-state-required
      given: |
        any coverage resolution action is requested
      when: |
        the action validates its target before applying changes
      then: |
        validation reads the current backend coverage-state detail for that
        criterion, including freshness comparison findings, and rejects the
        action if the current state no longer satisfies that action's
        preconditions
    - id: ac-cli-daemon-equivalence
      given: |
        the same valid coverage resolution request is submitted through the
        CLI and through the daemon route in equivalent projects
      when: |
        each path succeeds
      then: |
        both paths produce the same stored effect class, response summary,
        affected coverage-state scopes, and diagnostics, differing only in
        occurrence-specific ids and timestamps; typed event equivalence is
        specified separately by @coverage-resolution-events-compatibility
    - id: ac-dry-run-preview
      given: |
        any coverage resolution request is submitted in dry-run mode
      when: |
        validation completes
      then: |
        the response reports the action that would run, affected items and
        criteria, precondition diagnostics, and exact stored effects that
        would be attempted, but no verification stamp, spec source edit,
        task, shadow commit, cache update, or event broadcast is produced
    - id: ac-static-readonly-refusal
      given: |
        a static-export snapshot or read-only project context
      when: |
        a caller attempts to apply any non-dry-run coverage resolution
        mutation
      then: |
        the interface refuses with a read-only/static-mode error and does
        not pretend the resolution was stored or dispatched; dry-run preview
        requests may still return computed previews when all required data is
        available without writing
    - id: ac-current-state-boundary
      given: |
        production code handles a coverage resolution action
      when: |
        it obtains coverage state for validation, previews, or responses
      then: |
        it uses the current production read path that includes freshness
        comparison and cache ownership, and it does not directly derive a
        raw read model from partial evidence in a way that bypasses
        freshness comparison

# ─── Explicit Re-verification ───

- title: Explicit Coverage Reverification
  slug: explicit-coverage-reverification
  type: requirement
  parent: "@coverage-resolution-mutation-interface"
  depends_on:
    - "@ac-verification-record-store"
    - "@verification-session-evidence"
    - "@coverage-state-engine"
  description: |
    A caller can explicitly re-verify a criterion whose current presentation
    bucket is re-verify and whose current state has positive non-failing
    evidence. The action
    writes a verification stamp with re_verification provenance using the
    existing verification record store. It records the acting actor,
    verification time, optional code commit, and optional producing session;
    it never runs tests and never invents evidence for a criterion that has
    no current positive basis.
  acceptance_criteria:
    - id: ac-reverify-preconditions
      given: |
        a caller requests explicit re-verification for a criterion
      when: |
        the current coverage state is checked
      then: |
        the action is accepted only when the criterion is currently in the
        re-verify bucket, has positive evidence, and has no latest mapped
        failed or errored result; covered, not-yet, and failing criteria are
        rejected with guidance to refresh the view, add evidence, or fix
        failing tests instead
    - id: ac-reverify-stamp-written
      given: |
        an explicit re-verification request satisfies its preconditions
      when: |
        the mutation succeeds
      then: |
        the criterion's verification stamp is written or replaced with
        provenance re_verification, the resolved actor, the mutation time,
        optional comparable commit metadata, and optional session linkage
    - id: ac-reverify-state-clears-when-current
      given: |
        a criterion was in the re-verify bucket only because existing
        positive evidence was older than comparable freshness sources
      when: |
        explicit re-verification writes a newer stamp and coverage state is
        recomputed
      then: |
        the criterion no longer remains in re-verify for that stale cause
        unless another current failing, missing, or stale cause still applies
    - id: ac-reverify-no-test-execution
      given: |
        a caller explicitly re-verifies a criterion
      when: |
        the action executes through either CLI or daemon
      then: |
        the action writes only verification metadata and never runs a test
        command, imports framework-native result data, or fabricates an
        ingested run

# ─── Spec Text Revert ───

- title: Coverage Spec Text Revert
  slug: coverage-spec-text-revert
  type: requirement
  parent: "@coverage-resolution-mutation-interface"
  depends_on:
    - "@coverage-freshness-revision-comparison"
    - "@shared-mutation-pipeline"
  description: |
    A caller can resolve a stale-spec-text coverage cause by applying a
    content-level inverse edit to the current acceptance criterion text. The
    revert uses the focused per-criterion comparison supplied by the coverage
    freshness layer, changes only the selected criterion's given/when/then
    text through normal kspec mutation machinery, and creates an ordinary
    forward shadow commit. It is not a raw git revert and never rewrites
    unrelated criteria or operational sidecars.
  acceptance_criteria:
    - id: ac-revert-preconditions
      given: |
        a caller requests a spec-text revert for a criterion
      when: |
        the current coverage state and focused criterion comparison are
        checked
      then: |
        the action is accepted only when the current state includes a
        stale_spec_text cause and the prior criterion text can be resolved
        from project metadata history
    - id: ac-revert-preview
      given: |
        a spec-text revert request is submitted in dry-run mode
      when: |
        the focused comparison resolves
      then: |
        the preview reports the current and prior given/when/then values,
        the fields that would change, the prior commit or timestamp used,
        and the affected coverage-state scopes without modifying files
    - id: ac-content-level-forward-edit
      given: |
        a spec-text revert request is applied
      when: |
        the mutation writes project metadata
      then: |
        it applies the inverse content edit through the normal kspec item
        mutation path, creates a forward shadow commit describing the
        criterion revert, and does not run git revert or mutate the code
        repository directly
    - id: ac-sibling-preservation
      given: |
        an item has several acceptance criteria and only one criterion is
        targeted for spec-text revert
      when: |
        the mutation succeeds
      then: |
        only the targeted criterion's given/when/then fields are changed;
        sibling criteria, item metadata, comments, verification stamps, and
        test-run records remain byte-equivalent
    - id: ac-concurrency-guard
      given: |
        the criterion text changes after a revert preview or before an
        apply request reaches the mutation path
      when: |
        the mutation validates the expected current criterion fingerprint
      then: |
        the mutation refuses rather than overwriting newer text, and the
        response tells the caller to refresh the coverage detail

# ─── Dispatch Fix Request ───

- title: Coverage Dispatch Fix Request
  slug: coverage-dispatch-fix-request
  type: requirement
  parent: "@coverage-resolution-mutation-interface"
  depends_on:
    - "@coverage-state-engine"
    - "@task-work-fields"
    - "@shared-mutation-pipeline"
  description: |
    A caller can convert a coverage-state issue into ordinary kspec task
    work for an agent or human to fix. The action creates or reuses a task
    that targets the affected item and criterion, includes the current
    coverage-state explanation and relevant evidence, and optionally marks
    the task dispatch-eligible through existing task automation fields. The
    action does not introduce a special coverage-only work queue, does not
    bypass plan/task approval policy, and does not spawn a bespoke agent
    outside the existing dispatch engine.
  acceptance_criteria:
    - id: ac-dispatch-fix-task-shape
      given: |
        a caller requests dispatch-fix for a criterion with a failing,
        not-yet, or re-verify coverage issue
      when: |
        the mutation succeeds
      then: |
        an ordinary kspec task exists whose title, spec reference, body,
        and metadata identify the targeted item and criterion, the current
        presentation bucket, the machine-readable explanation, and the
        latest relevant run or freshness evidence when available
    - id: ac-no-special-queue
      given: |
        a dispatch-fix request is accepted
      when: |
        the resulting work is inspected
      then: |
        the work is represented by normal task records and existing
        automation/dispatch fields, not by a parallel coverage-specific
        queue or an ad-hoc daemon agent invocation
    - id: ac-idempotent-open-request
      given: |
        an unresolved dispatch-fix task already exists for the same item,
        criterion, action kind, and current issue fingerprint
      when: |
        the caller requests dispatch-fix again
      then: |
        the mutation finds the existing task by a durable idempotency key
        stored in the task body, returns that task, and records no duplicate
        task unless the caller explicitly asks to create another one
    - id: ac-project-neutral-context
      given: |
        dispatch-fix is requested in projects with different package names,
        test frameworks, file layouts, or result producers
      when: |
        the task body is generated
      then: |
        the body uses normalized coverage-state evidence and kspec refs,
        and does not assume kynetic-spec paths, Vitest output, package
        scripts, or repository-specific branch names
    - id: ac-existing-dispatch-policy
      given: |
        a caller asks the dispatch-fix action to make the task automation
        eligible
      when: |
        the mutation stores the task
      then: |
        the task uses the existing automation fields and remains subject
        to normal dispatch engine reconciliation, dependencies, and
        operator policy; the coverage action itself does not start an
        agent outside those mechanisms

# ─── Events, Cache, and Compatibility ───

- title: Coverage Resolution Events and Compatibility
  slug: coverage-resolution-events-compatibility
  type: requirement
  parent: "@coverage-resolution-mutation-interface"
  depends_on:
    - "@coverage-state-events"
    - "@mutation-event-naming"
    - "@coverage-record-compatibility"
  traits:
    - "@trait-websocket-protocol"
  description: |
    Successful coverage resolution mutations invalidate the coverage-state
    read model and broadcast targeted coverage-state events on the spec-item
    domain after the post-mutation state is visible. The implementation is
    additive and backward-compatible: projects with no verification or
    test-run stores still load, dry-run and static snapshots are read-only,
    and consumers that do not understand the new actions can continue to
    read coverage state and metadata.
  acceptance_criteria:
    - id: ac-event-after-cache
      given: |
        any coverage resolution mutation succeeds through the daemon
      when: |
        clients receive the resulting coverage-state event
      then: |
        a same-tick refetch of the affected coverage detail or rollup
        observes the post-mutation read model
    - id: ac-targeted-scope
      given: |
        a resolution mutation affects one criterion or one item
      when: |
        the event payload is emitted
      then: |
        it identifies affected item and criterion scopes precisely when
        known, and uses a project-wide scope only when precision is not
        available
    - id: ac-cli-daemon-event-equivalence
      given: |
        equivalent successful resolution mutations arrive through the daemon
        REST route and through the daemon command-proxy CLI path
      when: |
        subscribers observe the resulting events
      then: |
        clients observe the same typed coverage-state event family, topic,
        affected scopes, and payload schema from both origins
    - id: ac-absent-store-compatible
      given: |
        a project has no verification record store or no test-run store
      when: |
        resolution actions are previewed, rejected, or applied where their
        preconditions are otherwise satisfied
      then: |
        absence is handled as ordinary coverage-state absence; reads do not
        materialize stores, and the first action that writes a store follows
        the existing first-write materialization contract
    - id: ac-validation-gates
      given: |
        the coverage resolution mutation plan implementation is complete
      when: |
        project validation and focused tests run
      then: |
        they prove CLI/daemon equivalence, dry-run no-effects behavior,
        static/read-only refusal, neutral-project behavior, event-after-cache
        ordering, and no production bypass of the current-state read path
```

## Tasks

derive_from_specs: false

```yaml
- title: Implement shared coverage resolution schemas and target resolver
  slug: task-coverage-resolution-contract
  priority: 1
  tags: [coverage, schema, parser, api]
  spec_ref: "@coverage-resolution-mutation-interface"
  description: |
    Add the shared request/response schemas and the production target
    resolver used by every coverage resolution action.

    Why: The three actions must not fork their target validation, dry-run
    response shape, static-mode behavior, or coverage-state read path. This
    is also where the recently identified legacy-builder risk is contained:
    production mutation decisions must read the current coverage-state detail
    through the production read model with freshness comparison, not directly
    from a raw evidence-to-state helper that can bypass comparison.

    What:
    - Create src/schema/coverage-resolution.ts with discriminated request
      schemas for explicit-reverify, spec-text-revert, and dispatch-fix;
      shared target fields (item ref or canonical id plus ac id); dry-run;
      expected current fingerprint for applying previews; optional actor,
      session, and commit metadata; and typed response/effect summaries.
    - Create src/parser/coverage-resolution.ts with a resolveCoverageTarget
      helper that initializes project context, loads the current
      getCachedCoverageStateReadModel path, resolves item aliases exactly as
      packages/daemon/src/routes/coverage.ts does, and returns current
      criterion detail plus item/context data needed by action handlers.
    - Add explicit action precondition diagnostics that name the current
      presentation bucket, internal state/cause, and missing requirement.
    - Add dry-run effect modeling common to all actions. Dry-run returns
      would-write stamps, would-edit fields, would-create/reuse task, and
      affected coverage-state scopes, but calls no write helpers and creates
      no commit.
    - Add read-only/static-mode error class shared by CLI and daemon, aligned
      with TestResultIngestionReadOnlyError behavior.
    - Add a focused boundary test proving daemon/CLI resolution handlers do
      not import or call buildCoverageStateReadModel directly; tests may
      import the raw builder only in pure read-model unit suites.

    How: Follow the normalized ingestion pattern: schema and pure parser
    service first, route/CLI adapters later. Reuse shared coverage API types
    where possible and add package/shared type exports only if response types
    need to cross into web UI code. Tests: target resolution by @ref and bare
    slug, criterion not found diagnostics, stale expected fingerprint refusal,
    dry-run no-effect shape, static/read-only error shape, and current-state
    read-path boundary.

    Covers: @coverage-resolution-mutation-interface ac-action-set,
    ac-current-state-required, ac-dry-run-preview,
    ac-static-readonly-refusal, ac-current-state-boundary.

- title: Implement explicit re-verification stamp mutation
  slug: task-explicit-coverage-reverification
  priority: 1
  tags: [coverage, verification, parser]
  spec_ref: "@explicit-coverage-reverification"
  depends_on:
    - "@task-coverage-resolution-contract"
  description: |
    Implement the explicit-reverify action in the shared coverage resolution
    service by writing re_verification provenance stamps through the existing
    verification record store.

    Why: Re-verify is the safest first resolution action: it is an ordinary
    verification-stamp write over already-built storage. It must still be
    strict enough not to let users stamp not-yet or failing criteria as
    covered, and it must not run tests or create fake ingested evidence.

    What:
    - Add applyExplicitReverification(ctx, request) in
      src/parser/coverage-resolution.ts.
    - Accept only current criteria with positive non-failing evidence. Reject
      presentation bucket failing; reject not_yet/no_positive_evidence;
      reject absent or unresolvable target; explain the next action to take.
    - Write stamps through writeVerificationStampWithoutCommit when inside a
      higher-level mutation transaction, with provenance re_verification,
      verified_at from the mutation clock, actor resolved by the shared actor
      rules, optional commit from request or current comparable source, and
      optional session id. Preserve the verification store's validation and
      format-ceiling behavior.
    - Recompute or invalidate the coverage-state read model after the stamp
      write so stale causes clear only when the engine's normal rules agree.
    - Tests: accepted re-verify writes/replaces a stamp; failing and not-yet
      targets reject; session/commit attribution round-trip; newer record
      format refusal propagates; recomputed state clears stale cause when the
      stamp is current; no test command or test-run store write occurs.

    How: Reuse src/parser/verification-record-store.ts and the freshness
    resolver/read-model path from the completed P1a/P1b plans. The action
    writes only verification metadata; do not touch test-run store code except
    to assert it remains unchanged in integration tests.

    Covers: @explicit-coverage-reverification ac-reverify-preconditions,
    ac-reverify-stamp-written, ac-reverify-state-clears-when-current,
    ac-reverify-no-test-execution.

- title: Implement content-level spec-text revert for stale AC text
  slug: task-coverage-spec-text-revert
  priority: 1
  tags: [coverage, specs, mutation]
  spec_ref: "@coverage-spec-text-revert"
  depends_on:
    - "@task-coverage-resolution-contract"
  description: |
    Implement spec-text-revert for stale_spec_text causes by applying the
    focused prior criterion text through normal kspec item mutation machinery.

    Why: The redesign needs a direct way to resolve stale spec wording when a
    user decides the prior AC text was correct. Decision #32 chose a
    content-level forward mutation through kspec, not a raw git revert class.
    This task must preserve siblings and guard against overwriting newer
    edits.

    What:
    - Extend the coverage resolution service with previewSpecTextRevert and
      applySpecTextRevert.
    - Use readCriterionFreshnessComparison from
      src/parser/coverage-freshness-comparison.ts to resolve the previous
      criterion text for stale_spec_text causes. Refuse if prior text or the
      source commit cannot be resolved.
    - Compute a stable current criterion fingerprint from current
      given/when/then plus item ULID and AC id. Apply requests must include
      the expected fingerprint from preview unless an explicit non-preview
      path computes and validates it in the same call.
    - Apply only the changed given/when/then fields for the targeted AC
      through the existing spec item mutation/storage path used by kspec item
      commands, then commit through the shared mutation pipeline. Do not use
      git revert and do not mutate the code repository.
    - Preserve sibling ACs, item metadata, verification records, test-run
      records, unknown sidecar files, and unrelated source bytes.
    - Tests: dry-run reports exact field diff; apply changes only targeted
      AC fields; stale preview fingerprint rejects after concurrent edit;
      missing prior comparison rejects; commit message/effect summary names
      the item and AC; recomputed coverage state/event scope identifies the
      affected item/criterion.

    How: Follow existing item mutation utilities rather than editing YAML with
    ad-hoc string replacement. If no single helper exists for AC field edits,
    add one in src/parser/yaml.ts or a focused spec-mutation module and test it
    independently before wiring coverage actions.

    Covers: @coverage-spec-text-revert ac-revert-preconditions,
    ac-revert-preview, ac-content-level-forward-edit,
    ac-sibling-preservation, ac-concurrency-guard.

- title: Implement dispatch-fix task creation and idempotency
  slug: task-coverage-dispatch-fix-request
  priority: 1
  tags: [coverage, tasks, dispatch]
  spec_ref: "@coverage-dispatch-fix-request"
  depends_on:
    - "@task-coverage-resolution-contract"
  description: |
    Implement the dispatch-fix action by creating or reusing ordinary kspec
    task work from current coverage-state evidence.

    Why: Some coverage issues require real implementation work: add evidence,
    fix a failing test, update mappings, or repair stale code. The resolution
    surface should hand that work to kspec's existing task/dispatch workflow,
    not invent a parallel coverage work queue or spawn a special agent.

    What:
    - Add dispatch-fix handling to src/parser/coverage-resolution.ts. It may
      target failing, not_yet, or re_verify criteria; covered targets reject
      unless the caller explicitly asks for a task anyway.
    - Persist the idempotency key as a stable machine-readable line in the task
      body, e.g. `Coverage-Resolution-Key: <hash>`, because the current task
      schema has no arbitrary metadata slot and this plan deliberately avoids
      adding covers_ac/task metadata. Task lookup uses that marker plus open
      lifecycle state; the marker remains visible and auditable.
    - Generate a normal task whose spec_ref targets the owning item and whose
      body contains: item ref/title, AC id and text, current presentation
      bucket, internal state/cause, latest run evidence or freshness detail,
      unmapped/invalid mapping summaries if relevant, and a neutral suggested
      repair checklist. Do not add a new task schema field for covers_ac in
      this plan.
    - Add an idempotency key derived from target item ULID, AC id, action kind,
      and current issue fingerprint. If an unresolved matching task exists,
      return it instead of duplicating unless the caller passes an explicit
      allow-duplicate option.
    - If the caller requests automation eligibility, set only existing task
      automation/dispatch fields and let the existing dispatch engine reconcile
      normally. Do not invoke an agent process directly from this action.
    - Tests: creates a task for failing/not-yet/re-verify; rejects covered by
      default; repeats return existing open task for same fingerprint; a changed
      issue fingerprint can create a new task; generated task body uses
      normalized coverage evidence and works in two neutral fixture projects;
      automation flag uses existing fields and no direct agent spawn occurs.

    How: Reuse task creation/storage helpers and ref-resolution utilities.
    Treat generated task text as durable user-facing context: concise,
    framework-neutral, and explicit about which evidence was observed. Any
    future covers_ac task metadata belongs to a separate schema plan.

    Covers: @coverage-dispatch-fix-request ac-dispatch-fix-task-shape,
    ac-no-special-queue, ac-idempotent-open-request,
    ac-project-neutral-context, ac-existing-dispatch-policy.

- title: Expose coverage resolution through CLI and daemon routes
  slug: task-coverage-resolution-cli-daemon
  priority: 1
  tags: [coverage, cli, daemon, api]
  spec_ref: "@coverage-resolution-mutation-interface"
  depends_on:
    - "@task-explicit-coverage-reverification"
    - "@task-coverage-spec-text-revert"
    - "@task-coverage-dispatch-fix-request"
  description: |
    Add the user-facing interfaces: CLI subcommands and daemon REST routes
    that call the same shared coverage resolution service.

    Why: Later spec workspace and Validate UI actions should consume daemon
    routes, while local automation and review agents need CLI parity. The two
    paths must not drift in semantics, diagnostics, or effects.

    What:
    - Extend src/cli/commands/coverage.ts with a coverage resolution namespace
      such as `kspec coverage resolve reverify`,
      `kspec coverage resolve revert-spec-text`, and
      `kspec coverage resolve dispatch-fix`. Support `--item`, `--ac`,
      `--dry-run`, `--json`, `--actor`, `--session`, and action-specific
      options such as `--expected-fingerprint`, `--commit`,
      `--automation-eligible`, and `--allow-duplicate` where applicable.
    - Add daemon routes under packages/daemon/src/routes/coverage.ts for the
      same actions, using runRouteMutation for non-dry-run writes and the
      same parser service as the CLI. Route handlers resolve actor/session
      attribution and request ids consistently with ingestion.
    - Human output summarizes action, target, state before/after when known,
      stored effect, affected scopes, and next suggested action. JSON output
      returns the typed response schema unchanged.
    - Error handling maps validation/precondition failures to semantic CLI
      exit codes and structured HTTP errors with actionable suggestions.
    - Static/read-only mode refuses all write actions through both CLI and
      daemon. Dry-run remains available in read-only mode only if it can
      compute previews without writing; if a preview requires unavailable
      mutable context, it returns a read-only diagnostic rather than guessing.
    - Tests compare CLI and daemon outcomes in equivalent temp projects for
      all three action kinds, including dry-run, precondition failure, and
      successful mutation.

    How: Mirror the ingestion interface pattern in coverage.ts. Do not shell
    out from daemon routes to the CLI; both adapters call the shared service.
    Keep generated shared types in sync before running root typecheck if route
    response types are exported to packages/shared.

    Covers: @coverage-resolution-mutation-interface ac-cli-daemon-equivalence,
    ac-dry-run-preview, ac-static-readonly-refusal. Covers @trait-api-endpoint
    ac-1, ac-2, ac-3, ac-5, and ac-6; @trait-dry-run ac-1, ac-2, ac-3, ac-4,
    ac-5, and ac-6; @trait-semantic-exit-codes ac-1, ac-2, ac-4, ac-6, and
    ac-8; and @trait-error-guidance ac-1, ac-2, ac-3, ac-5, and ac-6.
    Non-applicable inherited cases are listed in Implementation Notes.

- title: Wire coverage resolution cache invalidation, events, and compatibility gates
  slug: task-coverage-resolution-events-validation
  priority: 2
  tags: [coverage, websocket, validation, tests]
  spec_ref: "@coverage-resolution-events-compatibility"
  depends_on:
    - "@task-coverage-resolution-cli-daemon"
  description: |
    Complete the cross-cutting event/cache behavior and validation gates that
    prove coverage resolution mutations are safe, project-neutral, and visible
    to later UI surfaces.

    Why: Resolution actions are only useful if the coverage-state read model
    immediately reflects their effects, web clients can refresh targeted rows,
    static/read-only snapshots remain honest, and tests prove the behavior is
    reusable outside kynetic-spec.

    What:
    - Invalidate the coverage-state read model after each successful action
      and recompute or refresh as needed before broadcasting.
    - Emit coverage_state_changed events on items:updates after the post-mutation
      read model is observable. Payloads identify item ULID/ref and AC id for
      precise single-criterion actions; use project scope only for broad or
      unresolved changes.
    - Ensure command-proxy CLI mutations that go through the daemon produce the
      same typed event family as direct REST routes, via the shared mutation
      pipeline and command-path typed event bridge.
    - Add compatibility tests for projects with no verification store, no
      test-run store, newer-than-supported verification record formats, and
      static exports. Reads must not materialize stores; first write follows
      existing first-write behavior.
    - Add neutral-project fixtures for the full resolution flow: one project
      with annotation/bootstrap-only reverify, one with normalized test-run
      evidence from a non-kynetic producer, and one with stale AC text history.
    - Add final validation gates: focused coverage-resolution tests; relevant
      coverage-state API/event tests; CLI/daemon equivalence tests; static mode
      tests; `kspec validate --warnings-ok`; root format/lint/typecheck/build
      gates according to touched packages.

    How: Extend packages/daemon/src/routes/coverage-state-events.ts rather than
    adding a new topic. Use existing coverage-state read APIs for post-mutation
    assertions. The broad gates should run after focused suites so failures are
    actionable.

    Covers: @coverage-resolution-events-compatibility ac-event-after-cache,
    ac-targeted-scope, ac-cli-daemon-event-equivalence,
    ac-absent-store-compatible, ac-validation-gates. Also covers
    @trait-websocket-protocol ac-2, ac-3, ac-6, and ac-8 for
    resolution-originated events using the existing websocket infrastructure.
    Also covers @coverage-state-events ac-event-topic,
    ac-event-canonical-identity, ac-event-after-cache, and ac-no-event-storm
    for resolution-originated changes.
```

## Implementation Notes

### What this plan is

This is P1c of the UI redesign coverage track. It consumes the completed
coverage-state backend and adds backend-owned resolution mutations that later
spec workspace and Validate UI plans can call. It closes the loop for the
four presentation buckets without building those UI surfaces.

The plan deliberately keeps resolution as normal kspec state changes:

1. Explicit re-verification writes a verification stamp.
2. Spec-text revert applies an item content edit through kspec mutation
   machinery.
3. Dispatch-fix creates or reuses an ordinary task and optionally marks it
   eligible through existing dispatch fields.

No action runs tests, imports framework-native results, performs raw git
revert, performs a code-repository merge, or directly spawns a special agent.

### Relationship to prior imported redesign plans

- `@plan-web-ui-foundations` provides actor identity and status/read-only UI
  conventions. This plan consumes actor identity for stamps/tasks and keeps UI
  rendering out of scope.
- `@plan-ac-coverage-verification-schema-and-storage` provides
  `coverage/verifications/<item-ulid>.yaml`, provenance class
  `re_verification`, optional session evidence, first-write materialization,
  and record-format compatibility. This plan writes through that store.
- `@plan-test-result-ingestion` provides normalized run records and
  ingestion-provenance stamps. This plan reads their effects through the
  coverage-state engine; it does not add framework adapters or daemon-run tests.
- `@plan-coverage-state-engine` provides the evidence index, state derivation,
  freshness comparison, API/cache read model, and coverage-state event family.
  This plan validates every action against that current state and invalidates
  it after writes.
- `@plan-review-anchors-and-plan-revisions-schema` is a structural example for
  how this plan handles schema additions, compatibility, precise validation,
  and later-UI exclusions. It is not a direct dependency.
- `@plan-dispatch-mutation-service` provides shared write → shadow commit →
  cache update → typed event ordering. All non-dry-run daemon mutations in this
  plan ride that path.

### Current-state guard and legacy-helper hardening

The resolution action precondition is intentionally tied to the production
coverage-state read path. The raw `buildCoverageStateReadModel(...)` helper is
valid as a pure projection inside the read-model module and tests, but
resolution mutations must not call it directly from production paths. They
should call the current cached/read-model path that includes freshness
comparison, cache ownership, and the same state seen by `/api/coverage/state/*`.

This prevents an action from approving or reverting against a state derived
from partial evidence without the freshness comparison that made the criterion
`re_verify` in the first place. The implementation task includes a regression
boundary check so future routes do not accidentally reintroduce that bypass.

### Action preconditions

Expected action availability for this plan scope:

| Current presentation / cause | explicit-reverify | spec-text-revert | dispatch-fix |
|---|---|---|---|
| `covered` | rejected; refresh semantics are out of this resolution scope | rejected | rejected by default |
| `failing` | rejected | rejected unless also stale-spec-text and caller chooses revert after reading details | allowed |
| `not_yet` | rejected | rejected | allowed |
| `re_verify` + stale_spec_text | allowed when positive non-failing evidence exists | allowed when focused prior text resolves | allowed |
| `re_verify` + stale_annotation_or_mapping / stale_test_result / unknown_freshness | allowed when positive non-failing evidence exists | rejected | allowed |

Preconditions must be checked against the current read model immediately before
apply. Dry-run previews should include the same precondition diagnostics.

### Spec-text revert semantics

Spec-text revert is a content-level forward edit, not a git operation:

- It uses the per-AC comparison from `readCriterionFreshnessComparison(...)`.
- It writes only the targeted AC's `given`, `when`, and `then` values.
- It commits through kspec's normal shadow mutation path with a forward commit
  such as "revert coverage criterion text".
- It refuses stale previews via expected current fingerprint.
- It does not alter verification stamps or test-run records; after the edit,
  coverage-state recomputation decides whether the criterion remains covered,
  re-verify, failing, or not-yet.

### Dispatch-fix semantics

Dispatch-fix should produce ordinary work, not new infrastructure:

- No new task schema field for `covers_ac` in this plan. The future task-level
  covers/covers_ac design remains deferred.
- The idempotency key is persisted in the task body as a stable line such as
  `Coverage-Resolution-Key: sha256:<hex>`. The key input is item ULID, AC id,
  action kind, presentation bucket, internal cause, and source evidence ids.
  This uses existing task storage, keeps the marker auditable, and avoids a
  schema migration solely for this action.
- Task context should include enough normalized evidence for a worker to know
  whether to add missing tests, fix a failing test, update a mapping, or repair
  stale code, but it must not assume a framework or repository layout.
- Idempotency prevents one UI button from creating repeated identical tasks for
  the same current issue fingerprint.
- If automation eligibility is requested, the action only sets existing fields.
  The existing dispatch engine decides when or whether to run it.

### API and CLI sketch

The exact command names are implementation details, but this draft expects a
shape close to:

```text
kspec coverage resolve reverify --item @some-item --ac ac-1 [--commit <sha>] [--session <ulid>] [--dry-run] [--json]
kspec coverage resolve revert-spec-text --item @some-item --ac ac-1 --expected-fingerprint <hash> [--dry-run] [--json]
kspec coverage resolve dispatch-fix --item @some-item --ac ac-1 [--automation-eligible] [--allow-duplicate] [--dry-run] [--json]
```

Daemon routes should mirror these under `/api/coverage/resolve/...` or an
equivalent coverage namespace and return the same typed response shape. The
implemented names may differ if they fit existing route conventions better, but
CLI and daemon semantics must remain equivalent.

### General-system guardrails

- Use loaded project context, item ULIDs, AC ids, normalized run records, and
  server-computed coverage-state details. Never hardcode kynetic-spec package
  names, paths, Vitest output, current corpus counts, or branch naming.
- Do not infer missing mappings from file paths in dispatch-fix task text.
  Mapping semantics remain owned by normalized test-result ingestion.
- Do not add daemon-run test execution.
- Do not add daemon merge or code-repository repair authority.
- Do not derive state in Svelte/UI clients.
- Keep all action writes additive or ordinary kspec mutations and compatible
  with existing shadow history and static export behavior.

### Scope exclusions

- Spec workspace UI buttons and Validate matrix UI. Later P1d/P1e plans consume
  these routes.
- Flakiness detection, result history charts, and generated matrix observations.
- Test-result adapters beyond the normalized payload already defined.
- Task `covers_ac`/coverage metadata schema.
- Direct agent spawning outside the dispatch engine.
- Merge execution, code-repo repair, or shadow repair from dashboard actions.
- Retiring the in-code N/A convention beyond behavior already implemented by
  the coverage schema/storage and state-engine plans.

### Inherited trait coverage and non-applicable cases

This plan uses broad traits, but only the following inherited acceptance
criteria apply to the mutation surfaces in this plan:

| Trait | Applicable ACs | Non-applicable / rationale |
|---|---|---|
| `@trait-api-endpoint` | ac-1 success JSON, ac-2 invalid ref/not found, ac-3 validation errors, ac-5 shadow commit for mutating routes, ac-6 request id | ac-4 list pagination is not applicable: these are action endpoints, not list endpoints |
| `@trait-dry-run` | ac-1 preview, ac-2 no file writes, ac-3 preview indication, ac-4 dry-run errors without state change, ac-5 dry-run wins if a future force flag appears, ac-6 JSON includes `dry_run` | none for CLI actions; daemon dry-run responses use the same semantic fields even though they are query/body flags rather than commander flags |
| `@trait-semantic-exit-codes` | ac-1 success, ac-2 validation/precondition failure, ac-4 runtime failure, ac-6 invalid flags/arguments, ac-8 documented meanings | ac-3 confirmation-declined is not applicable because this plan has no interactive confirmation prompt; ac-5 empty result set is not applicable because these are targeted actions; ac-7 batch partial failure is not applicable because this plan has no batch mode |
| `@trait-error-guidance` | ac-1 description, ac-2 suggested action, ac-3 ref lookup guidance, ac-5 field/value diagnostics, ac-6 structured JSON guidance | ac-4 invalid state transition is represented by coverage action precondition diagnostics rather than task lifecycle transition states |
| `@trait-websocket-protocol` | ac-2 subscription to `items:updates`, ac-3 broadcast envelope, ac-6 no event storm/backpressure through coalesced events, ac-8 reconnect consumers can refetch by affected scope | ac-1 connection establishment, ac-4 heartbeat, ac-5 heartbeat timeout, and ac-7 close codes belong to the existing websocket infrastructure and are not reimplemented by this plan |

Task coverage mapping follows this table. If an implementer changes command
shape enough to make an inherited AC newly applicable, they must update the
plan before deriving or completing the task.

### Validation gates

Before this plan is considered ready for approval, run at least:

- `kspec plan import /home/chapel/Projects/kynetic-spec/plans/ui-redesign-coverage-resolution-mutations.md --module @core --status draft --dry-run --json`
- `kspec validate --warnings-ok`

Implementation tasks should add and run focused suites for coverage resolution,
verification records, coverage-state read model/API/events, CLI/daemon route
parity, static/read-only behavior, and neutral-project fixtures. If shared API
or websocket types change, regenerate shared outputs before root typecheck and
build gates.
