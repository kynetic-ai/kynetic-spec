# Shared Mutation and Event Service

## Specs

```yaml
# ─── Mutation Pipeline ───

- title: Shared Mutation Pipeline
  slug: shared-mutation-pipeline
  type: feature
  parent: "@daemon-server"
  description: |
    Every mutation of project state follows one shared completion
    sequence: the change is applied, a shadow branch commit records it,
    the server's entity cache is updated to the post-mutation state, and
    a typed event identifying the affected entities is broadcast to
    subscribed clients. The sequence is the same regardless of the
    interface the mutation arrived through — an entity API endpoint, a
    proxied CLI command, or the dispatch engine's own record keeping.
    When no daemon serves the project, the same mutation logic applies
    and commits the change, and the cache and broadcast stages are
    skipped without error.
  acceptance_criteria:
    - id: ac-1
      given: |
        a mutation succeeds through any daemon-served interface
      when: |
        the originating caller observes the result
      then: |
        a shadow commit recording the change exists and the entity cache
        reflects the post-mutation state
    - id: ac-2
      given: |
        a mutation's typed event is broadcast
      when: |
        a subscriber re-fetches the affected entity in response to the
        event
      then: |
        the response reflects the post-mutation state — the broadcast is
        never observable before the cache reflects the change
    - id: ac-3
      given: |
        the same logical mutation is performed once through its entity
        API endpoint and once through a proxied CLI command
      when: |
        each succeeds
      then: |
        both broadcast on the same topic with the same event type and
        the same payload schema, differing only in the values specific
        to each occurrence
    - id: ac-4
      given: |
        a mutation executes while no daemon is serving the project
      when: |
        the mutation succeeds
      then: |
        the change is applied and committed to the shadow branch exactly
        as it would be under a daemon, and the unavailable cache and
        broadcast stages produce no error
    - id: ac-5
      given: |
        a batch of mutations executes atomically
      when: |
        the batch completes successfully
      then: |
        exactly one shadow commit records the batch, and a typed event
        is broadcast for each affected entity after the cache reflects
        the batch's full result
    - id: ac-6
      given: |
        a mutation fails at any stage of the sequence
      when: |
        the failure is reported to the originating caller
      then: |
        the report includes the underlying error description rather
        than only a generic failure indication

- title: Dispatch Mutation Transparency
  slug: dispatch-mutation-transparency
  type: requirement
  parent: "@shared-mutation-pipeline"
  description: |
    The dispatch engine records its own bookkeeping — failure notes,
    timeout notes, and task blocking — through the shared mutation
    pipeline. These mutations are applied in the engine's own process,
    broadcast on the owning entity topics like any other mutation, and
    report failures with their underlying detail. A bookkeeping failure
    is always subordinate to the agent outcome it records: it never
    replaces or hides that outcome.
  acceptance_criteria:
    - id: ac-1
      given: |
        the dispatch engine records a failure note, timeout note, or
        block on a task
      when: |
        the mutation succeeds
      then: |
        the broadcast topic, event type, and payload schema are
        identical to those produced when the same mutation is performed
        through the task API
    - id: ac-2
      given: |
        the dispatch engine performs a bookkeeping mutation while
        running inside the daemon process
      when: |
        the mutation executes
      then: |
        it is applied within that process, without spawning a child
        process and without issuing a request back through the daemon's
        own command interface
    - id: ac-3
      given: |
        a dispatch-initiated bookkeeping mutation fails
      when: |
        the failure is handled
      then: |
        the underlying error description is written to the
        operator-visible log, in engine-driven and one-shot execution
        modes alike, and the failure is never silently discarded
    - id: ac-4
      given: |
        an agent invocation fails and the subsequent failure-note
        mutation also fails
      when: |
        the invocation outcome is recorded
      then: |
        the recorded outcome remains the invocation's original error,
        and the note-write failure appears as a separate log entry
        rather than replacing it

# ─── Event Vocabulary ───

- title: Mutation Event Coverage
  slug: mutation-event-coverage
  type: requirement
  parent: "@shared-mutation-pipeline"
  description: |
    Every entity domain that clients can subscribe to receives
    entity-scoped typed events for all of its mutations. Task changes,
    review creation, and spec item changes each broadcast on their
    owning domain topic, through every interface a mutation can arrive
    on, with payloads that identify the affected entity and the kind of
    change.
  acceptance_criteria:
    - id: ac-1
      given: |
        any task mutation — creation, any state transition, or any
        field change, including changes with no dedicated entity
        endpoint
      when: |
        the mutation succeeds through any interface
      then: |
        a typed task event is broadcast on the task domain topic
        identifying the task and the kind of change, with prior and new
        status when the change is a state transition
    - id: ac-2
      given: |
        a review record is created through any interface
      when: |
        creation succeeds
      then: |
        a typed review-creation event is broadcast on the review domain
        topic identifying the new review and its subject
    - id: ac-3
      given: |
        a spec item is created, changed, or removed through any
        interface
      when: |
        the mutation succeeds
      then: |
        a typed spec-item event is broadcast on the spec-item domain
        topic, and a subscriber to that topic observes the change
        without relying on file-change fallback events
    - id: ac-4
      given: |
        any entity-scoped mutation event payload
      when: |
        a subscriber processes it
      then: |
        the payload identifies each affected entity by its canonical
        identifier, sufficient to refresh exactly that entity and
        nothing broader

- title: Mutation Event Naming
  slug: mutation-event-naming
  type: decision
  description: |
    Broadcast vocabulary is organized by entity domain: each domain has
    one updates topic, and entity-scoped event types within it name the
    changed subject and the change in past-tense subject_change form.
    New capabilities extend an existing domain topic with new event
    types rather than adding a parallel topic for the same entities.
    Two event families are reserved by name for later capabilities:
    plan-revision events on the plan domain topic and coverage-state
    events on the spec-item domain topic. The reserved names are part
    of this vocabulary; their payloads and semantics are defined by the
    capabilities that introduce them.
  acceptance_criteria:
    - id: ac-1
      given: |
        the set of entity-scoped event types the daemon broadcasts
      when: |
        the vocabulary is enumerated
      then: |
        every entity-scoped event type follows the past-tense
        subject_change form and is published on its owning domain's
        updates topic
    - id: ac-2
      given: |
        a client subscribed to a single entity domain's updates topic
      when: |
        mutations occur anywhere in that domain
      then: |
        every entity-scoped event for that domain arrives on that one
        topic, and no other topic carries entity-scoped events for the
        same domain

# ─── Client Consumption ───

- title: UI Targeted Event Consumption
  slug: ui-targeted-event-consumption
  type: requirement
  parent: "@ui-data-freshness"
  description: |
    The web client treats typed mutation events as its primary
    freshness signal. An event drives one immediate, targeted refresh:
    the affected entity's data and the views that include it update,
    and unaffected domains are left alone. Changes that originate
    outside daemon-served mutations reach the client through
    file-change fallback events, which also trigger a single immediate
    refresh of their affected domains. No freshness path schedules
    repeated delayed refreshes to compensate for event-timing
    uncertainty.
  acceptance_criteria:
    - id: ac-1
      given: |
        a typed mutation event identifying a single entity arrives
      when: |
        the client processes it
      then: |
        the client refreshes that entity's cached data and the views
        that include it, and does not refetch entity domains the event
        does not affect
    - id: ac-2
      given: |
        any broadcast event arrives
      when: |
        the client initiates refresh work for it
      then: |
        the refresh begins immediately on arrival and happens exactly
        once per event, with no additional fixed-delay refreshes
        scheduled for the same event
    - id: ac-3
      given: |
        a view is open and a mutation affecting it is performed through
        the CLI
      when: |
        the mutation's typed event reaches the client
      then: |
        the open view updates without a manual reload and without
        depending on file-change fallback events
    - id: ac-4
      given: |
        a shadow branch file changes through a path that is not a
        daemon-served mutation
      when: |
        the file-change fallback event arrives
      then: |
        the client performs a single immediate refresh of the affected
        domains and open views reflect the change
```

## Tasks

derive_from_specs: false

```yaml
- title: Extract the shared mutation pipeline and migrate entity routes onto it
  slug: task-shared-mutation-pipeline
  priority: 1
  tags: [daemon, infra, implementation]
  spec_ref: "@shared-mutation-pipeline"
  description: |
    Build the apply → shadow-commit → cache-write-through → broadcast
    sequence as one shared service and migrate the daemon's entity REST
    routes to call it instead of inlining the sequence per handler.

    Why: The four-stage sequence is currently copy-pasted across every
    daemon route handler (routes/tasks.ts, inbox.ts, triage.ts,
    reviews.ts, review-resources.ts, plan-resources.ts), and other
    mutation origins bypass parts of it entirely. One service is the
    precondition for every other task in this plan and for later
    daemon-initiated writes (the spec-revert mutation class routes
    through this service).

    What:
    - Implement the pipeline in the library layer (src/, importable by
      both the daemon and the CLI): a mutation operation declares the
      affected entity domain(s), an apply function, and typed event
      descriptor(s); the pipeline performs apply, commitIfShadow, cache
      write-through, then broadcast — in that order, so the broadcast is
      never observable before the cache reflects the change.
    - Cache and pubsub are optional injected capabilities. The daemon
      constructs the pipeline with its entity cache and pubsub at
      project registration; direct CLI execution constructs it with
      neither, and both stages no-op without error.
    - Native error propagation: stage failures surface the underlying
      error message to the caller — no exit-code-only or empty-stderr
      failure shapes.
    - Migrate the existing entity REST routes (task transitions, inbox
      create/delete, triage record/override/act, review threads,
      replies, resolve/reopen, verdicts, checks, lifecycle, resources,
      plan resources) onto the service. Existing topics, event types,
      and payload schemas must be preserved exactly — this task changes
      the plumbing, not the vocabulary.
    - Reuse the existing write-through skip flag so the watcher does not
      double-reload domains the pipeline already updated.

    How: Follow the route handler sequence documented at
    routes/tasks.ts (mutateTask → commitIfShadow → writeThrough →
    broadcast) as the extraction template. Thread the pipeline through
    the project-context middleware so handlers receive a ready instance.
    Add unit tests for stage ordering, optional-capability degradation,
    and failure propagation; run the existing route test suites to prove
    payload-schema preservation.

    Covers: @shared-mutation-pipeline ac-1, ac-2, ac-4, ac-6.

- title: Route command-proxy execution through the pipeline with typed entity events
  slug: task-command-path-typed-events
  priority: 1
  tags: [daemon, cli, events]
  spec_ref: "@shared-mutation-pipeline"
  depends_on:
    - "@task-shared-mutation-pipeline"
  description: |
    Make mutations that arrive through the daemon's command execution
    endpoint (single commands and batches) emit the same typed
    entity-scoped events as the entity REST routes.

    Why: This is the core asymmetry the plan removes. The command-proxy
    path is the dominant mutation path — every CLI invocation under a
    running daemon and every dispatch agent's kspec call routes through
    it — yet it broadcasts only a coarse command_executed event on the
    command topic, which the web client does not subscribe to. The
    client papers over the gap with delayed re-invalidation timers.

    What:
    - Emit typed entity events from the library mutation managers
      (task, item, review, plan, inbox, triage writes) through the
      pipeline when a daemon-provided pipeline context is present, so a
      proxied command (for example task cancel) produces the same
      tasks:updates typed event as the equivalent REST route.
    - Derive affected entities at the mutation-manager level — the
      manager knows the entity and change kind — rather than mapping
      from command names. The command route's existing write-through
      domain hints remain as the cache-consistency safety net.
    - Batch execution: keep the existing single-commit, single
      cache-update contract (@daemon-command-api ac-batch-support) and
      broadcast one typed event per affected entity after the cache
      reflects the batch result.
    - Keep command_executed and batch_executed broadcasts unchanged on
      the command topic for command-stream observers.
    - Preserve @daemon-command-api ac-mutation-cache-update and
      ac-no-recursive-command-proxy behavior: cache updated before
      response, no loop-back through the command endpoint from inside
      the daemon.

    How: Equivalence tests are the acceptance proof: perform the same
    logical mutation via the REST route and via POST /api/command,
    capture both broadcasts, and assert identical topic, event type,
    and payload schema. Extend the command-route integration tests in
    the daemon test suite; verify batch event emission with a
    multi-entity batch fixture.

    Covers: @shared-mutation-pipeline ac-3, ac-5.

- title: Emit the missing entity event types
  slug: task-missing-event-types
  priority: 1
  tags: [daemon, events, implementation]
  spec_ref: "@mutation-event-coverage"
  depends_on:
    - "@task-command-path-typed-events"
  description: |
    Fill the holes in the entity event vocabulary: review creation,
    full task-mutation coverage, and emission on the spec-item topic
    that clients already subscribe to.

    Why: Today only five task transitions (start, note, submit,
    complete, block) emit task_updated; review creation emits nothing
    (creation is CLI-only); and the items:updates topic is subscribed
    by the web client but no daemon code ever broadcasts on it — spec
    item changes reach clients only via file-change fallback.

    What:
    - review_created event on the reviews topic when a review record is
      created through any interface, identifying the review and its
      subject.
    - Task events for every task mutation — creation, all transitions
      (including cancel, reset, unblock), and field changes via task
      set / task note — with prior and new status on transitions and
      display-title enrichment per the established enriched-payload
      contract (@ui-api-aggregation ac-4).
    - items:updates emission for spec item creation, change, and
      removal (item add, item set, item ac mutations, trait changes,
      removal), with the canonical item identifier and change kind in
      the payload.
    - Conform the full vocabulary to the naming decision: every
      entity-scoped event type in past-tense subject_change form on its
      owning domain topic, and no second topic carrying entity events
      for the same domain.
    - Record the two reserved event families (plan-revision events on
      the plans topic, coverage-state events on the spec-items topic)
      as named reservations in the shared typed event definitions
      (packages/shared/src/websocket.ts) — names and owning topics
      only, no payloads or semantics.

    How: With the pipeline in place from the prior tasks, these are
    event-descriptor additions at the mutation-manager call sites plus
    typed payload definitions in the shared package. Enumerate the
    vocabulary in a test that asserts naming-form conformance and
    topic ownership. Verify items:updates emission end-to-end with a
    subscribed test client and a proxied item mutation.

    Covers: @mutation-event-coverage ac-1, ac-2, ac-3, ac-4.
    @mutation-event-naming ac-1, ac-2. @ui-api-aggregation ac-4 (for
    the new event types).

- title: Move dispatch engine bookkeeping mutations onto the pipeline
  slug: task-dispatch-engine-mutation-path
  priority: 1
  tags: [dispatch, daemon, reliability]
  spec_ref: "@dispatch-mutation-transparency"
  depends_on:
    - "@task-shared-mutation-pipeline"
  description: |
    Replace the dispatch invocation runner's subprocess-based shadow
    mutations with direct pipeline calls, and fix the error-masking and
    silent-swallowing failure handling around them.

    Why: The invocation runner (src/agent-runtime/invocation.ts) shells
    out to the kspec CLI for failure notes, timeout notes, and task
    blocks. Three concrete defects documented in the originating
    investigation: opaque errors (empty stderr, generic exited-non-zero
    reports), error masking (an unguarded note-write failure in the
    failure handler replaces the original invocation error, so the
    engine retries on the wrong cause and the real error vanishes from
    logs), and daemon loop-back overhead (daemon spawns a subprocess
    that proxies an HTTP request back into the same daemon process).

    What:
    - Replace the subprocess mutation helpers (addTaskNote, blockTask
      via runKspecCli) with direct pipeline calls. Daemon-hosted
      dispatch passes the daemon's cache and pubsub capabilities, so
      these mutations broadcast the same typed task events as the task
      API; one-shot kspec agent run passes neither and degrades
      cleanly per the pipeline contract.
    - Guard the failure-handler mutations: the invocation's original
      error is always the recorded outcome; a note or block write
      failure is logged as its own entry with the underlying error
      detail and never propagates in place of the invocation error.
    - Retire the strict-flag conflation: bookkeeping mutation failures
      are logged with detail in every execution mode — never silently
      swallowed in one-shot mode, never thrown over the original error
      in dispatch mode.
    - Audit for any remaining CLI-subprocess mutation call sites in the
      agent runtime (the investigation found them only in the
      invocation runner) and migrate any found. The mutation lock file
      passed to agent subprocesses for the agents' own kspec calls is
      unaffected — that path is the command proxy's concern.

    How: Unit-test the failure handler with an injected failing
    pipeline: assert the recorded invocation outcome is the original
    error and the log contains a separate mutation-failure entry.
    Integration-test that an engine-written failure note produces a
    tasks:updates typed event identical in schema to the task API's.

    Covers: @dispatch-mutation-transparency ac-1, ac-2, ac-3, ac-4.

- title: Switch the web client to targeted, payload-driven event consumption
  slug: task-ui-targeted-consumption
  priority: 1
  tags: [web-ui, events, implementation]
  spec_ref: "@ui-targeted-event-consumption"
  depends_on:
    - "@task-command-path-typed-events"
    - "@task-missing-event-types"
  description: |
    Replace wholesale domain invalidation and the delayed-invalidation
    timers with targeted refresh driven by typed event payloads.

    Why: The client's invalidation wiring
    (packages/web-ui/src/lib/query/ws-invalidation.ts) ignores the
    typed payloads that already arrive and wholesale-invalidates whole
    domains, and it schedules 650ms and 1500ms delayed re-invalidations
    (FILE_WATCHER_INVALIDATION_DELAYS_MS) on file-change events to
    outrun the server's cache reload. With typed events now emitted
    from every mutation origin and the server guaranteeing broadcasts
    fire only after the cache reload completes (@daemon-entity-cache
    ac-broadcast-after-reload, ac-write-through), both compensations
    are obsolete.

    What:
    - Map typed entity events to targeted query handling: refresh the
      affected entity's detail data and the list/aggregate views that
      include it, keyed off the canonical identifier in the payload;
      stop invalidating unrelated domain bundles (today a task file
      event invalidates tasks, validation, and session-context
      wholesale).
    - Consume the new event types: items:updates spec-item events
      (subscription already exists), review_created, and the expanded
      task event coverage.
    - Remove the delayed double-invalidation: every event triggers
      exactly one immediate refresh pass; file-change fallback events
      trigger a single immediate refresh of their mapped domains.
    - The client continues not subscribing to the command topic;
      entity freshness must not depend on it.
    - Preserve the enriched-payload fast path from @ui-data-freshness
      ac-3 (in-place cache update when the payload carries sufficient
      data) and the path-independence contract of @ui-data-freshness
      ac-10.

    How: Rework the handler map in ws-invalidation.ts from topic-level
    wholesale invalidation to event-type + payload dispatch. Unit-test
    the mapping (event in, exact query keys refreshed, nothing else).
    E2E (Playwright, ephemeral-port daemon fixture): open the task
    board, perform a CLI-proxied mutation, and assert the view updates
    without reload; assert no fixed-delay re-invalidation timers are
    scheduled.

    Covers: @ui-targeted-event-consumption ac-1, ac-2, ac-3, ac-4.

- title: Declare relationship metadata between the new and foundation specs
  slug: task-mutation-service-spec-links
  priority: 2
  tags: [specs, maintenance]
  spec_ref: "@shared-mutation-pipeline"
  description: |
    Record the relationships between this plan's specs and the
    foundation specs they extend, so the ownership boundaries are
    navigable metadata rather than plan prose.

    Why: The pipeline generalizes behavior owned today by the command
    API and entity cache specs, and the event coverage spec extends the
    API contract and enriched-events specs. Without recorded links,
    future readers cannot navigate from the foundation specs to the
    layer that now owns cross-interface mutation behavior.

    What — create relates_to links for exactly these pairs:
    - @shared-mutation-pipeline ↔ @daemon-command-api
    - @shared-mutation-pipeline ↔ @daemon-entity-cache
    - @mutation-event-coverage ↔ @ui-api-aggregation
    - @mutation-event-coverage ↔ @api-contract
    - @dispatch-mutation-transparency ↔ @agent-invocation-lifecycle

    How: kspec link create --type relates_to for each pair (or the
    item-set relationship flag if that is the supported mechanism at
    execution time); verify with kspec link list and kspec refs, then
    kspec validate --refs --warnings-ok.

    Covers: @shared-mutation-pipeline, @mutation-event-coverage,
    @dispatch-mutation-transparency (relationship metadata only — no
    acceptance criteria).
```

## Implementation Notes

### Promotion and record continuity

This document is the expanded replacement content for the draft plan
record `@plan-dispatch-mutation-service` (ULID
`01KN53HWBGWJT52V2TC2PXKBKP`). Import with `--into
@plan-dispatch-mutation-service` so the record, its history, and its
disposition notes are preserved. The original content was an
investigation draft (problem statement, current architecture, explored
alternatives); its preferred direction — Option 2, a shared mutation
service with optional cache/pubsub dependencies — is what this revision
specs. The P0a global-decisions plan's disposition task records the
promotion on the overlapping draft records.

### Resolutions of the draft's open questions

- **Commit boundaries**: the pipeline owns the commit for a single
  logical mutation; a batch is one logical unit with exactly one commit
  and one cache update (matching `@daemon-command-api ac-batch-support`),
  followed by per-entity event emission.
- **Optional cache/pubsub interface**: injected capabilities on the
  pipeline instance, constructed by the host (daemon: real cache +
  pubsub; direct CLI and one-shot agent run: absent). Absent
  capabilities no-op; they never error or change the recorded result.
- **One-shot `kspec agent run` without a daemon**: standalone direct
  application is the contract (`@shared-mutation-pipeline ac-4`). No
  daemon auto-start.
- **The `strict` flag**: the conflation of "dispatch mode" with "should
  mutation failures throw" is retired. Failures are always logged with
  underlying detail; a bookkeeping failure never substitutes for the
  invocation error it was recording.
- **Other subprocess mutation call sites**: audited during
  `@task-dispatch-engine-mutation-path`; the investigation found them
  only in the invocation runner.

### Event derivation for the command path

Typed events for proxied CLI commands are emitted at the
mutation-manager level (the code that knows which entity changed and
how), not derived from command names. This keeps event emission correct
for compound commands and batches, and means direct REST routes and
proxied commands literally share the emission site. The command route's
existing write-through domain hints remain as the cache-consistency
safety net but are no longer the event source.

### Current-state inventory this plan corrects

Verified at program research time (plans/ui-redesign/research/state-api.md
§6; analysis.md §3.3, §4.4):

- Granular typed events (`thread_created`, `verdict_submitted`,
  `task_updated`, session streaming, etc.) fire only from web REST
  routes.
- CLI-proxied mutations broadcast only `command_executed` /
  `batch_executed` on the `command` topic, which the web client does
  not subscribe to.
- The client compensates with 650ms/1500ms delayed double-invalidation
  on file-change events (`FILE_WATCHER_INVALIDATION_DELAYS_MS` in
  `ws-invalidation.ts`).
- Only five task transitions emit `task_updated`; all other task
  mutations are command-path-only and emit nothing entity-scoped.
- `items:updates` is subscribed by the client but never emitted by any
  daemon code.
- No event exists for review creation (creation is CLI-only).
- The dispatch invocation runner mutates tasks via CLI subprocess with
  the documented error-opacity, error-masking, and loop-back defects.

### Existing spec relationships (refs verified read-only)

- `@daemon-entity-cache` — `ac-write-through` (cache updated before
  response) and `ac-broadcast-after-reload` (watcher-driven broadcasts
  fire after reload) are the ordering guarantees the pipeline
  generalizes and the client's single-immediate-refresh behavior relies
  on. Unchanged by this plan.
- `@daemon-command-api` — `ac-mutation-cache-update`, `ac-batch-support`,
  and `ac-no-recursive-command-proxy` remain satisfied; this plan adds
  typed entity events alongside the existing coarse command-stream
  broadcast, which is retained.
- `@ui-data-freshness` — `ac-3` (event-driven invalidation with
  enriched-payload fast path) and `ac-10` (freshness independent of
  which internal path produced the change) are the parent contracts the
  new `@ui-targeted-event-consumption` spec refines. No edits to the
  existing ACs are needed.
- `@ui-api-aggregation` — `ac-4` (enriched event payloads: display
  title, old/new state) extends to the new event types; covered by
  `@task-missing-event-types`.
- `@agent-invocation-lifecycle` — `ac-5` requires the failure note;
  `@dispatch-mutation-transparency` specifies what happens when that
  note write itself fails, which `ac-5` leaves open.
- `@api-contract` — owns the WS message envelope and subscribe
  protocol; the naming decision governs vocabulary within that
  envelope.

### Scope exclusions

- **Reserved event families only named, not built**: plan-revision and
  coverage-state events get reserved names and owning topics; payloads
  and semantics belong to the plans that introduce those capabilities.
- **No event replay or resume**: the existing reconnect contract
  (resubscribe + full refetch, no missed-event delivery) is unchanged.
- **No SSE or new transport**; no change to per-connection project
  binding or topic subscription protocol.
- **The dispatch event registry** (`task.ready`, `invocation.*`, etc. —
  the internal hooks/schedules bus) is a separate system and is
  untouched.
- **No actor attribution in event payloads**: identity enrichment is
  the identity model's concern, owned elsewhere in the program.
- **`files:updates` is retained** as the fallback for non-daemon
  origins (external git operations, manual edits); only the client's
  delay compensation is removed.
- **No daemon-initiated code-repository writes**: this service handles
  shadow-branch project state only.

### Migration and backward compatibility

- Existing event consumers are unaffected: all current topics, event
  types, and payload schemas are preserved; this plan only adds event
  types and re-homes their emission.
- `command_executed` / `batch_executed` remain for command-stream
  observers; nothing may newly depend on them for entity freshness.
- The client change is behavior-compatible for end users: the same
  views refresh, faster and exactly once.

### Approval ordering

The program analysis records this plan (P0c) with no blocking
decisions; none of the P0a global-decision items gate these specs, and
no pending-materialization references are used in Specs or Tasks — all
external refs above exist today and were verified read-only. This plan
can be approved and derived independently of the P0a plan's
materialization. Later program work consumes this service (the
content-level spec-revert decision routes its mutations through this
pipeline; the cross-project event delivery work builds on the typed
vocabulary), so P0c should land before those tracks start.
