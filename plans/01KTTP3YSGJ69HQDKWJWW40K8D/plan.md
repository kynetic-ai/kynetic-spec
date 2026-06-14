# UI Redesign Global Decisions

## Specs

```yaml
# ─── Platform & Shell ───

- title: Web Shell Platform Target
  slug: web-shell-platform-target
  type: decision
  parent: "@web-ui"
  description: |
    The kspec web interface targets the web browser as its sole runtime
    platform. The application shell is a browser application served by the
    daemon, with a static export fallback, and adopts no native desktop
    chrome. The shell's top chrome reserves its leading zone — the
    contiguous region at the inline-start edge of the top chrome, whose
    extent is a single named reservation value defined by the shell
    layout, sized to hold platform window controls — and no shell element
    occupies it, so a native wrapper could later add window controls
    without relocating existing shell elements. Keyboard chords resolve
    through a central platform mapping that avoids browser-reserved
    combinations on each platform.
  acceptance_criteria:
    - id: ac-1
      given: |
        the application shell renders in a supported browser with no
        native wrapper present
      when: |
        any shell action is invoked
      then: |
        the action is operable through browser-standard pointer and
        keyboard input, and no shell affordance requires a native
        window-manager facility — window controls, native application
        menus, or OS-level global shortcuts
    - id: ac-2
      given: |
        the shell's top chrome layout
      when: |
        its elements are laid out at any viewport width
      then: |
        the leading chrome zone contains no shell element — every
        top-chrome element clears the named reservation value at the
        inline-start edge
    - id: ac-3
      given: |
        a keyboard chord is registered for a shell action
      when: |
        the binding is resolved on a given platform
      then: |
        the chord comes from the central platform mapping and does not
        collide with combinations the browser reserves on that platform

# ─── Coverage & Validation ───

- title: Test Result Acquisition
  slug: test-result-acquisition
  type: decision
  parent: "@web-ui"
  description: |
    Future coverage behavior is ingestion-oriented: completed runs from
    local tools, CI, or agents can submit structured result records to
    the daemon. Submitted results use a standardized result format and
    carry a deterministic mapping between tests and the acceptance
    criteria they cover, expressed through test naming or result
    metadata. Static annotation scanning remains the mapping and
    integrity source until the coverage-track plans define the complete
    ingestion schema and engine behavior. Freshness presentation names
    ingested-run evidence as such and reflects the latest ingested run
    when that evidence is the source being presented.
  acceptance_criteria:
    - id: ac-1
      given: |
        a completed test run in any execution environment
      when: |
        its results are submitted through the ingestion interface
      then: |
        per-acceptance-criterion outcomes are recorded and attributed to
        that run
    - id: ac-2
      given: |
        submitted results whose tests reference acceptance criteria
        through the mapping convention
      when: |
        the results are ingested
      then: |
        each mappable result is attributed to its acceptance criteria,
        and results that cannot be mapped are surfaced as unmapped rather
        than silently dropped
    - id: ac-3
      given: |
        a project with more than one ingested test run
      when: |
        ingested-run freshness is presented on any surface
      then: |
        the presentation reflects the most recently ingested run and
        labels it as the latest ingested run

- title: Acceptance Criterion Applicability
  slug: ac-coverage-applicability
  type: decision
  parent: "@web-ui"
  description: |
    Corpus-level coverage recognizes no not-applicable state. Every
    acceptance criterion on a spec item is expected to be coverable; a
    criterion that cannot apply to its item indicates a spec-composition
    defect to repair, not a state to record. Not-applicable marking is a
    task-scoped concern — identifying which inherited criteria fall
    outside one task's work — and lives in task coverage metadata, not in
    the spec corpus. In-code not-applicable annotations are not coverage
    signals: they neither cover a criterion nor exempt it. The existing
    scanner and trait-validation specs that count those annotations as
    coverage are incorrect under this decision and must be respecced and
    fixed by the coverage storage plan before the new coverage engine
    treats corpus coverage as authoritative.
  acceptance_criteria:
    - id: ac-1
      given: |
        coverage states computed across the spec corpus
      when: |
        any acceptance criterion's state is derived
      then: |
        the result is one of the recognized coverage states and never a
        not-applicable state
    - id: ac-2
      given: |
        a test annotation that marks a criterion not-applicable
      when: |
        corpus coverage is computed
      then: |
        the annotation neither counts as coverage for that criterion nor
        exempts it from the corpus coverage states

- title: Annotation Freshness Provenance
  slug: annotation-freshness-provenance
  type: decision
  parent: "@web-ui"
  description: |
    Every acceptance-criterion test annotation carries a freshness
    timestamp with two provenance classes. A bootstrap value is derived
    from version-control history of the annotation's location, so
    existing annotations have freshness without prior bookkeeping. A
    recorded verification stamp — written when a validation pass, an
    ingested test run, or an explicit re-verification confirms the
    mapping — supersedes the bootstrap value from then on. Interfaces
    that consume freshness accept either a timestamp or a commit
    reference, keeping the provenance source evolvable.
  acceptance_criteria:
    - id: ac-1
      given: |
        an annotation with no recorded verification stamp
      when: |
        its freshness is requested
      then: |
        a bootstrap value derived from the annotation's version-control
        history is returned
    - id: ac-2
      given: |
        an ingested passing run or explicit re-verification that confirms
        an annotation
      when: |
        freshness is subsequently requested
      then: |
        the recorded verification stamp is returned in place of the
        bootstrap value
    - id: ac-3
      given: |
        an interface that consumes annotation freshness
      when: |
        it receives a provenance value expressed as either a timestamp or
        a commit reference
      then: |
        the value is accepted and resolves to a comparable freshness
        ordering without requiring one canonical form

- title: Coverage State Presentation
  slug: coverage-state-presentation
  type: decision
  parent: "@web-ui"
  description: |
    Coverage state is presented as four user-facing buckets: covered,
    failing, not yet, and re-verify. The re-verify bucket covers any
    condition where existing evidence must be checked again, including
    spec-text changes after verification and covering-code changes after
    verification; those causes are exposed only as secondary detail such
    as row captions, detail views, and filter facets, not as separate
    presentation states. Each presentation state is represented by
    exactly one visual token wherever it appears.
  acceptance_criteria:
    - id: ac-1
      given: |
        any surface presenting coverage state
      when: |
        states are rendered
      then: |
        every rendered coverage state is one of the four presentation
        buckets — covered, failing, not yet, re-verify — and any
        re-verification cause is available only as secondary detail
    - id: ac-2
      given: |
        the same coverage state appearing on two different surfaces
      when: |
        each surface renders it
      then: |
        the same visual token represents the state on both

# ─── Client & Identity ───

- title: Client Preference Persistence
  slug: client-preference-persistence
  type: decision
  parent: "@web-ui"
  description: |
    Interface preferences — focus selection, collapse states, recents,
    view toggles, and similar per-user interface state — persist in
    browser-local storage through one shared, namespaced, versioned
    utility whose interface is storage-agnostic. Daemon-level state —
    configuration describing the daemon's own world, such as the roster
    of registered projects — persists server-side in the daemon's
    configuration directory and never depends on browser storage.
  acceptance_criteria:
    - id: ac-1
      given: |
        a surface that persists an interface preference
      when: |
        the preference is changed and the browser session is later
        reloaded
      then: |
        the preference is restored, and its stored value is recorded
        under the shared namespaced, versioned key format
    - id: ac-2
      given: |
        daemon-level state such as the registered-project roster
      when: |
        the daemon restarts
      then: |
        the state is recovered from the daemon configuration directory
        without any client involvement

- title: Actor Identity Model
  slug: actor-identity-model
  type: decision
  parent: "@web-ui"
  description: |
    Actor identity is a configured attribution vocabulary, not an
    authentication boundary. Direct human changes are attributed to a
    configured human author identity, and automated work is attributed to
    canonical agent identifiers drawn from the configured runner/agent
    roster. New actor-bearing writes validate against that author pool
    and persist canonical identifiers; invalid or out-of-pool write
    values are rejected by validation rather than being accepted as new
    free-form authors. Historical records are normalized once through the
    data upgrade path: recognizable variants map to their canonical
    identity, ambiguous values may be resolved through assisted review or
    operator-provided mapping, and values still unresolved when the
    upgrade completes map to a declared unknown/default actor while the
    original value remains reportable for audit. Identity powers
    filtering and display such as ownership and awaiting-action views,
    and carries no authentication or access-control semantics.
  acceptance_criteria:
    - id: ac-1
      given: |
        a new record carrying an actor field
      when: |
        it is written through any interface
      then: |
        the actor value is a canonical configured human author or a
        canonical configured agent/runner identifier, and an invalid or
        out-of-pool value is rejected by validation
    - id: ac-2
      given: |
        a project's historical records containing actor variants
      when: |
        the data upgrade completes
      then: |
        every actor field resolves to a canonical configured human or
        agent identity, an operator-provided mapping, or the declared
        unknown/default actor, and unresolved originals appear in the
        upgrade report
    - id: ac-3
      given: |
        an identity-derived view such as awaiting-action or ownership
        filtering
      when: |
        it is computed
      then: |
        it derives from the canonical actor vocabulary and treats the
        declared unknown/default actor distinctly from configured humans
        and agents

# ─── Mediation & Authority Boundaries ───

- title: Agent Question Mediation
  slug: agent-question-mediation
  type: decision
  parent: "@web-ui"
  description: |
    Dispatched automated task agents do not wait on user-facing
    interactive question prompts. When a dispatched automation agent
    requires human input, it records durable work state — task blocking
    with a stated reason and task notes — and the human resumes the work
    through the ordinary task lifecycle. This decision is scoped to
    automated dispatch sessions only: it does not forbid future
    deliberately interactive planning/chat sessions, including structured
    ask/answer protocols, when those are planned as a separate user-facing
    session mode.
  acceptance_criteria:
    - id: ac-1
      given: |
        a dispatched automation agent requires human input to proceed
      when: |
        it signals the need
      then: |
        the signal is recorded as durable task state — blocked with a
        reason — and task notes, reviewable after the fact
    - id: ac-2
      given: |
        a surface presenting dispatched automation work that awaits human
        input
      when: |
        the user acts on the item
      then: |
        the action navigates to the owning task or session record, and no
        surface offers inline structured-choice resolution into that
        dispatched automation session
    - id: ac-3
      given: |
        a future interactive planning or chat session mode is designed
      when: |
        it defines prompt/response or structured ask/answer behavior
      then: |
        that behavior is specified as user-facing interactive-session
        behavior, not as dispatched automation waiting for inline user
        resolution

- title: Integration Merge Authority
  slug: integration-merge-authority
  type: decision
  parent: "@web-ui"
  description: |
    Integration merges are performed by the acting agent or human through
    the merge procedure in their own execution environment. The daemon's
    request handlers expose no merge-execution capability. Merges that
    dispatched agents perform in their own execution environments are the
    merge procedure working as intended, not a daemon capability. UI
    surfaces may guide users to the appropriate workflow, but merge
    execution itself remains outside the daemon API.
  acceptance_criteria:
    - id: ac-1
      given: |
        any endpoint the daemon API exposes
      when: |
        its request handler processes a request
      then: |
        the handler performs no version-control merge on a consumer code
        repository
```

## Tasks

derive_from_specs: false

```yaml
- title: Supersede the legacy UI/UX revamp umbrella task
  slug: task-supersede-legacy-revamp-umbrella
  priority: 2
  tags: [meta, ui]
  description: |
    Cancel the pending UI/UX revamp umbrella task (@01KJXQK4) with a
    reason note pointing at the redesign program's decision set, so the
    old umbrella stops competing with the program for scope.

    Why: Two umbrellas for the same work invite duplicate planning. The
    redesign program supersedes the old revamp framing entirely.

    What:
    - Add a note to @01KJXQK4 with this content: "Superseded by the kspec
      interface redesign program. The program's global decision set lives
      at @plan-ui-redesign-global-decisions and its decision items under
      the @web-ui module; track plans follow from there."
    - Cancel the task with reason: "Superseded by the interface redesign
      program (see @plan-ui-redesign-global-decisions)."

    How: kspec batch with task note + task cancel; verify via task get
    that the task shows cancelled with the pointer note in its timeline.

- title: Fold the multi-project agent dashboard design task into the redesign program
  slug: task-fold-agent-dashboard-design-task
  priority: 2
  tags: [meta, ui]
  description: |
    Cancel the pending multi-project agent dashboard design task
    (@01KKBD66) with a supersession note: its scope is wholly contained
    in the redesign program's cross-project track, where the
    all-projects dashboard and live-agent rail now live.

    Why: The task predates the program; leaving it pending invites
    parallel design work. Cancellation with a durable pointer matches the
    sibling umbrella supersession and requires no judgment call at
    execution time.

    What:
    - Add a note to @01KKBD66 with this content: "Superseded by the kspec
      interface redesign program: the cross-project track's all-projects
      dashboard and live-agent rail absorb this task's scope. Program
      anchor: @plan-ui-redesign-global-decisions. Until the cross-project
      track plan is imported, that anchor is the authoritative successor
      pointer."
    - Cancel the task with reason: "Superseded by the redesign program's
      cross-project track (see @plan-ui-redesign-global-decisions)."

    How: kspec batch with task note + task cancel; confirm via task get
    that the task shows cancelled with the pointer note in its timeline.

- title: Record dispositions on overlapping draft plans
  slug: task-record-overlapping-plan-dispositions
  priority: 2
  tags: [meta, planning]
  description: |
    Add disposition notes to the four existing draft plans the redesign
    program absorbs, promotes, or reconciles, so no one picks them up
    independently while the program runs. All four plan refs exist today;
    each note anchors on @plan-ui-redesign-global-decisions (an existing
    record) as the program's authoritative successor pointer, naming
    future tracks in prose only as forward context.

    Why: Open drafts without dispositions are invitations for duplicate
    work; the program's relationship to each is decided and should be
    visible on the records themselves.

    What — add one note per plan with this content:
    - @plan-interactive-agent-sessions: "Absorbed by the kspec interface
      redesign program: the sessions track's controls work (context
      injection surface) supersedes this plan's scope. Program anchor:
      @plan-ui-redesign-global-decisions. Until the sessions track plan
      is imported, that anchor is the authoritative successor pointer."
    - @plan-activity-timeline-diff-summaries: "Absorbed by the kspec
      interface redesign program: the sessions track's session entity
      work absorbs this plan's diff-summary scope. Program anchor:
      @plan-ui-redesign-global-decisions. Until the sessions track plan
      is imported, that anchor is the authoritative successor pointer."
    - @plan-dispatch-mutation-service: "Promoted: this plan is the
      redesign program's shared mutation-service foundation (Phase 0).
      Program anchor: @plan-ui-redesign-global-decisions."
    - @plan-ux-module-and-design-decision-architecture: "Decision
      architecture adopted: the decision items derived from
      @plan-ui-redesign-global-decisions are its first full use, parented
      under the @web-ui module. The sidebar/pulse feature
      sketches are superseded by the program's shell track. If the @ux
      module later materializes, @web-ui reparents under
      it."

    What — also make the identity transition boundary machine-traversable:
    - Add a relates_to reference from the derived @actor-identity-model
      item to @config-author, so the reconciliation obligation documented
      in both records' prose is traversable in the corpus rather than
      description-only.

    How: kspec batch with one plan note per record, plus kspec item set
    @actor-identity-model --relates-to @config-author; verify the notes
    render on each plan via plan get and the relates_to reference via
    item get @actor-identity-model.

- title: Respec multi-project daemon roster persistence
  slug: task-respec-daemon-project-roster-persistence
  priority: 1
  tags: [specs, daemon, cross-project]
  spec_ref: "@client-preference-persistence"
  description: |
    Update the existing multi-directory daemon spec so registered-project
    roster persistence agrees with @client-preference-persistence ac-2.

    Why: @multi-directory-daemon ac-15 currently says the registered
    project list is empty after daemon restart. The global redesign
    decision intentionally supersedes that behavior: daemon-level state
    such as the registered-project roster is server-side state recovered
    from the daemon configuration directory, not browser-local UI
    preference state. Leaving ac-15 unchanged would make the derived
    decision contradict an existing UI/UX-touching spec.

    What:
    - Change @multi-directory-daemon ac-15 so a daemon restart restores
      the registered project list from daemon-side configuration state.
    - Update @multi-directory-daemon description/key architecture notes
      if needed so project-context caching distinguishes persisted
      registration metadata from runtime watcher/cache state.
    - Preserve @multi-directory-daemon ac-14's auto-registration behavior
      for a first request naming a project that is not in the persisted
      roster; persistence adds a restart restore path, it does not remove
      request-time registration.
    - Preserve unregister/delete behavior for invalid or deleted projects:
      restored entries whose project metadata is no longer valid must be
      surfaced and removed through the existing invalid-project handling
      rather than silently poisoning the roster.

    How: kspec item ac set @multi-directory-daemon ac-15 via a batch
    (and item set for description text if needed). Verify with kspec item
    get @multi-directory-daemon that ac-15 no longer promises an empty
    roster after restart and still coexists with ac-14/ac-20/ac-34.

    Covers: @client-preference-persistence ac-2.
```

## Implementation Notes

### What this plan is

The durable, reviewable home for the redesign program's global decisions —
the choices that more than one track consumes. Track-scoped decisions
(drift granularity, plan revision mechanics, anchor addressing, gating
enforcement mode, notification semantics, cross-project delivery shape,
session-trace derivation, triage commit model) ride in the Specs section
of their owning track plans, alongside the features they gate, per the
distributed model.

### Module placement and derive sequencing

The global decision items are decision-type specs, not a separate module.
Each decision item declares `parent: "@web-ui"`, placing the durable
interface decisions under the existing Web UI System module. This keeps
"redesign" as the program/branch context while the derived corpus items
remain timeless.

The plan record's stored module may remain @main from import-time storage;
it is not load-bearing for these decision items because every item declares
an explicit parent. If an @ux module later materializes, @web-ui can be
reparented under it through that architecture plan rather than by creating
a one-off decisions-only module for this program.

### Consumers

| Decision | Consumed by (planned) |
|---|---|
| web-shell-platform-target | shell/palette plans, keyboard registry, view-header pattern |
| test-result-acquisition | coverage state engine, results ingestion, validate view |
| ac-coverage-applicability | coverage schema + engine, spec workspace, validate |
| annotation-freshness-provenance | coverage schema + engine, per-AC revision diffs |
| coverage-state-presentation | coverage engine, spec workspace, validate, sidebar badges |
| client-preference-persistence | UI foundations utility; sidebar/palette/dashboard/spec-tree persistence; cross-project registry storage |
| actor-identity-model | UI foundations identity layer; aggregation (awaiting-you), reviews surfaces, board "mine" |
| agent-question-mediation | session view, dashboard urgency feed, board blocked flow |
| integration-merge-authority | reviews gating surface, dashboard resolving actions |

### AC coverage handoff

`derive_from_specs: false` is deliberate: most tasks in this plan are
program-hygiene work that implements no decision behavior. The one
exception, @task-respec-daemon-project-roster-persistence, is a
spec-alignment task for an existing contradictory daemon AC and carries
the relevant `Covers:` line. After derivation the remaining decision
items enter the corpus as not_started with no implementing tasks, and
completeness validation will flag their criteria until track plans land.
That is the intended interim posture; the table below converts the
ambient coverage debt into a tracked claim list.

The claiming mechanism is binding on the program's track plans: a track
plan that implements a decision's behavior claims the relevant criteria
with task `Covers:` lines referencing the decision item directly (for
example `Covers: @web-shell-platform-target ac-2`). A decision criterion
is claimed when a track task carries its Covers line; the program does
not close while any row below is unclaimed.

| Decision AC | Claiming track work |
|---|---|
| @web-shell-platform-target ac-1 | shell top-bar / view-header plan (browser-only operability) |
| @web-shell-platform-target ac-2 | shell top-bar plan (leading-zone reservation) |
| @web-shell-platform-target ac-3 | keyboard registry plan |
| @test-result-acquisition ac-1 | results-ingestion plan (ingest endpoint, run attribution) |
| @test-result-acquisition ac-2 | results-ingestion plan (AC mapping convention) |
| @test-result-acquisition ac-3 | validate view plan (freshness presentation) |
| @ac-coverage-applicability ac-1 | coverage state engine plan |
| @ac-coverage-applicability ac-2 | coverage state engine plan |
| @annotation-freshness-provenance ac-1 | coverage state engine plan (bootstrap freshness) |
| @annotation-freshness-provenance ac-2 | coverage state engine plan (recorded stamps) |
| @annotation-freshness-provenance ac-3 | coverage state engine plan (freshness interface) |
| @coverage-state-presentation ac-1 | validate view + spec workspace plans |
| @coverage-state-presentation ac-2 | UI foundations plan (shared state tokens) |
| @client-preference-persistence ac-1 | UI foundations plan (preference utility) |
| @client-preference-persistence ac-2 | @task-respec-daemon-project-roster-persistence, then cross-project registry implementation plan |
| @actor-identity-model ac-1 | UI foundations plan (canonical-write identity layer) |
| @actor-identity-model ac-2 | data upgrade plan (one-time migration) |
| @actor-identity-model ac-3 | aggregation plan (awaiting-you, ownership filters) |
| @agent-question-mediation ac-1 | sessions track plans (blocked-state surfacing) |
| @agent-question-mediation ac-2 | dashboard plan (deep-link resolution, no inline prompts) |
| @agent-question-mediation ac-3 | future interactive-session planning (scope boundary only; no implementation in this program) |
| @integration-merge-authority ac-1 | reviews gating plan (daemon surface boundary) |

### Boundaries and follow-ons deliberately not specced here

- The future "push-up" notification mechanism for agent questions
  (note-like, reliable) is deferred and unspecified by design.
- A post-plan-implementation validate/review step that could trigger
  final merges (with plan-level branching) is a named future evaluation,
  not part of this decision set. The current decision binds only the
  daemon/API boundary: the daemon does not execute merges.
- Task coverage metadata (a covers/covers_ac field superseding the
  in-code not-applicable convention) is out of program scope. The
  coverage storage plan still fixes the existing scanner and
  trait-validation semantics so in-code not-applicable markers no
  longer count as coverage; retiring or replacing the marker as a
  task-scoped communication convention is future work.
- @actor-identity-model supersedes the implemented author-resolution
  free-form fallback behavior for new writes. The UI foundations plan's
  canonical-write identity layer owns reconciling @config-author so the
  chain resolves to configured human or agent identities, rejects
  invalid/out-of-pool author values on new writes, and leaves unknown
  classification available for historical/external records and upgrade
  reporting rather than as a way to persist new arbitrary authors.
- Routing all preference access through the shared utility
  (@client-preference-persistence) is the decided mechanism, but its
  enforcement is a lint-rule concern, not a behavioral test — the
  decision's criteria assert only the observable persistence contract
  (restore-on-reload, namespaced versioned key format, server-side
  daemon state).
- Internal diagnostic names for re-verification causes must not become
  user-facing presentation states; the four-bucket vocabulary is the
  durable UI contract.
