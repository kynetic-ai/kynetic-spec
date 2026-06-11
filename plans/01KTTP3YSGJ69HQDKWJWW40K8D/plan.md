# UI Redesign Global Decisions

## Specs

```yaml
# ─── Decisions Home ───

- title: UI Redesign Decisions
  slug: ui-redesign-decisions
  type: module
  description: |
    Durable home for the interface redesign program's global decision
    records. Each child is a decision-type spec item: a behavioral
    contract that more than one redesign track consumes.

# ─── Platform & Shell ───

- title: Web Shell Platform Target
  slug: web-shell-platform-target
  type: decision
  parent: "@ui-redesign-decisions"
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
  parent: "@ui-redesign-decisions"
  description: |
    Test results enter the system exclusively by ingestion: runs executed
    outside the daemon — locally, in CI, or by an agent — submit
    structured results to the daemon. The daemon's request handlers never
    execute test suites, and the web interface offers no test-execution
    controls. Agent processes that the daemon's dispatch engine spawns run
    in their own execution context and are outside this boundary: work
    they perform, including running tests, is not daemon execution.
    Submitted results use a standardized result format and carry a
    deterministic mapping between tests and the acceptance criteria they
    cover, expressed through test naming or result metadata. Freshness
    presentation always reflects the most recently ingested run, named as
    such.
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
        any endpoint the daemon API exposes
      when: |
        its request handler processes a request
      then: |
        the handler executes no test suite or project-defined command
    - id: ac-3
      given: |
        submitted results whose tests reference acceptance criteria
        through the mapping convention
      when: |
        the results are ingested
      then: |
        each mappable result is attributed to its acceptance criteria,
        and results that cannot be mapped are surfaced as unmapped rather
        than silently dropped
    - id: ac-4
      given: |
        a project with more than one ingested test run
      when: |
        result freshness is presented on any surface
      then: |
        the presentation reflects the most recently ingested run and
        labels it as the latest ingested run

- title: Acceptance Criterion Applicability
  slug: ac-coverage-applicability
  type: decision
  parent: "@ui-redesign-decisions"
  description: |
    Corpus-level coverage recognizes no not-applicable state. Every
    acceptance criterion on a spec item is expected to be coverable; a
    criterion that cannot apply to its item indicates a spec-composition
    defect to repair, not a state to record. Not-applicable marking is a
    task-scoped concern — identifying which inherited criteria fall
    outside one task's work — and lives in task coverage metadata, not in
    the spec corpus. For the corpus coverage this program introduces,
    in-code not-applicable annotations are not coverage signals: they
    neither cover a criterion nor exempt it. This is a transition
    boundary, not a retroactive change: the pre-existing completeness
    validation path that honors in-code not-applicable annotations for
    trait criteria remains in force until the coverage state engine work
    reconciles the two semantics.
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
        corpus coverage is computed by the coverage state engine
      then: |
        the annotation neither counts as coverage for that criterion nor
        exempts it from the corpus coverage states

- title: Annotation Freshness Provenance
  slug: annotation-freshness-provenance
  type: decision
  parent: "@ui-redesign-decisions"
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
  parent: "@ui-redesign-decisions"
  description: |
    Coverage computation distinguishes five states: covered, failing,
    not-yet-covered, stale (the spec text changed after the annotation's
    freshness), and drifted (the covering code changed after the
    annotation's freshness). Presentation collapses stale and drifted
    into a single re-verification bucket: user-facing vocabulary is four
    buckets — covered, failing, not yet, re-verify — with the underlying
    cause exposed as secondary detail such as row captions, detail
    views, and filter facets. Each presentation state is represented by
    exactly one visual token wherever it appears.
  acceptance_criteria:
    - id: ac-1
      given: |
        any surface presenting coverage state
      when: |
        states are rendered
      then: |
        every rendered coverage state is one of the four presentation
        buckets — covered, failing, not yet, re-verify — and the
        stale-versus-drifted distinction is available only as cause
        detail
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
  parent: "@ui-redesign-decisions"
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
  parent: "@ui-redesign-decisions"
  description: |
    Every recorded actor is canonical at write time: agent actors use the
    canonical identifier of their agent definition; the human operator is
    identified by a configured profile identity. Historical records are
    normalized once through the data upgrade path — recognizable variants
    map to their canonical identity, ambiguous values may be resolved
    through assisted review during the upgrade, and any value still
    unresolved when the upgrade completes maps to a declared default. The
    upgrade's observable contract is its end state: every actor field
    canonical. Identity is attribution: it powers filtering and display
    such as ownership and awaiting-action views, and carries no
    authentication or access-control semantics. This is a transition
    boundary, not a silent contradiction: the implemented
    author-resolution fallback chain (@config-author ac-3), which derives
    an author from version-control or operating-system user names when no
    explicit identity is configured, produces free-form variants by this
    decision's definition and remains in force until the canonical-write
    identity layer supersedes it and reconciles that spec with this
    contract.
  acceptance_criteria:
    - id: ac-1
      given: |
        a new record carrying an actor field
      when: |
        it is written through any interface
      then: |
        the actor value is a canonical agent identifier or the configured
        human identity, never a free-form variant
    - id: ac-2
      given: |
        a project's historical records containing actor variants
      when: |
        the data upgrade completes
      then: |
        every actor field resolves to a canonical identity — directly
        mapped, confirmed through assisted review, or assigned the
        declared default — and no free-form variant remains
    - id: ac-3
      given: |
        an identity-derived view such as awaiting-action or ownership
        filtering
      when: |
        it is computed
      then: |
        it derives from canonical identities

# ─── Mediation & Authority Boundaries ───

- title: Agent Question Mediation
  slug: agent-question-mediation
  type: decision
  parent: "@ui-redesign-decisions"
  description: |
    Agents surface questions and blockers to humans through durable work
    records: task blocking with a stated reason, and task notes. The
    system defines no interactive decision protocol between running
    agents and humans — no structured choice prompts and no in-session
    resolution feedback loop. Surfaces that present work awaiting human
    input resolve by navigation to the owning task and session records,
    where the human acts through the ordinary work lifecycle.
  acceptance_criteria:
    - id: ac-1
      given: |
        an agent that requires human input to proceed
      when: |
        it signals the need
      then: |
        the signal is recorded as durable task state — blocked with a
        reason — and task notes, reviewable after the fact
    - id: ac-2
      given: |
        a surface presenting work that awaits human input
      when: |
        the user acts on the item
      then: |
        the action navigates to the owning task or session record, and no
        surface offers inline structured-choice resolution into a running
        session

- title: Integration Merge Authority
  slug: integration-merge-authority
  type: decision
  parent: "@ui-redesign-decisions"
  description: |
    Integration merges are performed by the acting agent or human through
    the merge procedure in their own execution environment. The daemon's
    request handlers expose no merge-execution capability, and no surface
    offers one-click merge execution. Merges that dispatched agents
    perform in their own execution environments are the merge procedure
    working as intended, not a daemon capability. Review approval and
    merge remain separate acts; approval emphasis concentrates at plan
    boundaries — planning and post-plan validation — rather than per-task
    merge automation.
  acceptance_criteria:
    - id: ac-1
      given: |
        any endpoint the daemon API exposes
      when: |
        its request handler processes a request
      then: |
        the handler performs no version-control merge on a consumer code
        repository
    - id: ac-2
      given: |
        a surface presenting an approved review
      when: |
        its resolving actions render
      then: |
        merge execution is not among them, and the merge procedure
        remains the path to integration
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
      the @ui-redesign-decisions module; track plans follow from there."
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
      under the @ui-redesign-decisions module. The sidebar/pulse feature
      sketches are superseded by the program's shell track. If the @ux
      module later materializes, @ui-redesign-decisions reparents under
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

The plan record's stored module is @main (the import-time default), and
it is load-bearing for exactly one record: derive parents parentless
non-trait specs under the stored module, so the @ui-redesign-decisions
module itself is created as a child of @main. Every decision item
declares `parent: "@ui-redesign-decisions"`, so a single derive creates
the module and its nine children together — no out-of-band module setup
precedes derivation, and no decision item is parented under @main
directly.

@main is the interim home for @ui-redesign-decisions, not the intended
final one. The adopted decision architecture's @ux module (from
@plan-ux-module-and-design-decision-architecture, an underived draft)
does not exist yet; if it materializes, @ui-redesign-decisions reparents
under it. That contingency is recorded on the ux plan by the disposition
task, not left implicit.

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

`derive_from_specs: false` is deliberate: the three tasks in this plan
are program-hygiene work that implements no decision behavior, so they
carry no spec_ref or Covers lines. After derivation the decision items
enter the corpus as not_started with no implementing tasks, and
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
| @test-result-acquisition ac-2 | results-ingestion plan (daemon surface boundary) |
| @test-result-acquisition ac-3 | results-ingestion plan (AC mapping convention) |
| @test-result-acquisition ac-4 | validate view plan (freshness presentation) |
| @ac-coverage-applicability ac-1 | coverage state engine plan |
| @ac-coverage-applicability ac-2 | coverage state engine plan |
| @annotation-freshness-provenance ac-1 | coverage state engine plan (bootstrap freshness) |
| @annotation-freshness-provenance ac-2 | coverage state engine plan (recorded stamps) |
| @annotation-freshness-provenance ac-3 | coverage state engine plan (freshness interface) |
| @coverage-state-presentation ac-1 | validate view + spec workspace plans |
| @coverage-state-presentation ac-2 | UI foundations plan (shared state tokens) |
| @client-preference-persistence ac-1 | UI foundations plan (preference utility) |
| @client-preference-persistence ac-2 | cross-project registry plan |
| @actor-identity-model ac-1 | UI foundations plan (canonical-write identity layer) |
| @actor-identity-model ac-2 | data upgrade plan (one-time migration) |
| @actor-identity-model ac-3 | aggregation plan (awaiting-you, ownership filters) |
| @agent-question-mediation ac-1 | sessions track plans (blocked-state surfacing) |
| @agent-question-mediation ac-2 | dashboard plan (deep-link resolution, no inline prompts) |
| @integration-merge-authority ac-1 | reviews gating plan (daemon surface boundary) |
| @integration-merge-authority ac-2 | reviews gating plan (approved-review actions) |

### Boundaries and follow-ons deliberately not specced here

- The future "push-up" notification mechanism for agent questions
  (note-like, reliable) is deferred and unspecified by design.
- A post-plan-implementation validate/review step that could trigger
  final merges (with plan-level branching) is a named future evaluation,
  not part of this decision set.
- Task coverage metadata (a covers/covers_ac field superseding the
  in-code not-applicable convention) is out of program scope; the
  convention's retirement follows that future work, not this plan.
  Until then two semantics coexist by design: the implemented
  completeness validation path continues to honor in-code N/A
  annotations for trait criteria, while the corpus coverage introduced
  by this program treats them as neither covering nor exempting
  (@ac-coverage-applicability ac-2 is scoped to the new engine for this
  reason). The coverage state engine plan owns reconciling the validate
  exemption behavior with corpus coverage.
- @actor-identity-model coexists with the implemented author-resolution
  spec (@config-author) during the transition: @config-author ac-3 falls
  back to git user.name then OS user when no env var or configured
  author exists — a free-form variant under @actor-identity-model ac-1.
  That implemented fallback remains in force until the UI foundations
  plan's canonical-write identity layer (per the Consumers table)
  supersedes it; that work owns reconciling @config-author — updating or
  superseding its fallback chain — so the two specs do not sit in the
  corpus as an unexplained contradiction.
- Routing all preference access through the shared utility
  (@client-preference-persistence) is the decided mechanism, but its
  enforcement is a lint-rule concern, not a behavioral test — the
  decision's criteria assert only the observable persistence contract
  (restore-on-reload, namespaced versioned key format, server-side
  daemon state).
- Internal naming for the stale/drifted computation must not collide
  with the existing validate staleness/drift flag vocabulary (different
  semantics); the coverage engine plan owns the disambiguation.
