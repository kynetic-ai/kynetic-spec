# UI Redesign Global Decisions

## Specs

```yaml
# ─── Platform & Shell ───

- title: Web Shell Platform Target
  slug: web-shell-platform-target
  type: decision
  description: |
    The kspec web interface targets the web browser as its sole runtime
    platform. The application shell is a browser application served by the
    daemon, with a static export fallback, and adopts no native desktop
    chrome. The shell's top chrome reserves its leading zone — no shell
    element occupies it — so a native wrapper could later add window
    controls without relocating existing shell elements. Keyboard chords
    resolve through a central platform mapping that avoids
    browser-reserved combinations on each platform.
  acceptance_criteria:
    - id: ac-1
      given: |
        the application shell renders in a supported browser with no
        native wrapper present
      when: |
        any shell capability is exercised
      then: |
        full functionality is available and no affordance depends on a
        native window manager
    - id: ac-2
      given: |
        the shell's top chrome layout
      when: |
        its elements are laid out at any viewport width
      then: |
        the leading chrome zone contains no shell element
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
  description: |
    Test results enter the system exclusively by ingestion: runs executed
    outside the daemon — locally, in CI, or by an agent — submit
    structured results to the daemon. The daemon never executes test
    suites, and the web interface offers no test-execution controls.
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
        any request arriving at the daemon API
      when: |
        the request is processed
      then: |
        no test suite or project-defined command is executed as a result
        of the request
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

- title: Acceptance Criterion Applicability
  slug: ac-coverage-applicability
  type: decision
  description: |
    Corpus-level coverage recognizes no not-applicable state. Every
    acceptance criterion on a spec item is expected to be coverable; a
    criterion that cannot apply to its item indicates a spec-composition
    defect to repair, not a state to record. Not-applicable marking is a
    task-scoped concern — identifying which inherited criteria fall
    outside one task's work — and lives in task coverage metadata, not in
    the spec corpus. In-code not-applicable annotations are not coverage
    signals: they neither cover a criterion nor exempt it.
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
        the annotation does not count as coverage for that criterion

- title: Annotation Freshness Provenance
  slug: annotation-freshness-provenance
  type: decision
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

- title: Coverage State Presentation
  slug: coverage-state-presentation
  type: decision
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
        exactly the four presentation buckets appear, with the
        stale-versus-drifted distinction available only as cause detail
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
        the preference is stored or read
      then: |
        access goes through the shared preference utility rather than
        ad-hoc storage calls
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
  description: |
    Every recorded actor is canonical at write time: agent actors use the
    canonical identifier of their agent definition; the human operator is
    identified by a configured profile identity. Historical records are
    normalized once through the data upgrade path — recognizable variants
    map to their canonical identity, and ambiguous values resolve through
    assisted review or declared defaults. Identity is attribution: it
    powers filtering and display such as ownership and awaiting-action
    views, and carries no authentication or access-control semantics.
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
        actor fields resolve to canonical identities, with unresolvable
        values mapped to declared defaults
    - id: ac-3
      given: |
        an identity-derived view such as awaiting-action or ownership
        filtering
      when: |
        it is computed
      then: |
        it derives from canonical identities and grants or implies no
        access control

# ─── Mediation & Authority Boundaries ───

- title: Agent Question Mediation
  slug: agent-question-mediation
  type: decision
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
  description: |
    Integration merges are performed by the acting agent or human through
    the merge procedure in their own execution environment. The daemon
    exposes no merge-execution capability, and no surface offers
    one-click merge execution. Review approval and merge remain separate
    acts; approval emphasis concentrates at plan boundaries — planning
    and post-plan validation — rather than per-task merge automation.
  acceptance_criteria:
    - id: ac-1
      given: |
        any request arriving at the daemon API
      when: |
        the request is processed
      then: |
        no operation performs a version-control merge on a consumer code
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
    reason note pointing at the redesign program's decision set and plan
    series, so the old umbrella stops competing with the program for
    scope.

    Why: Two umbrellas for the same work invite duplicate planning. The
    redesign program supersedes the old revamp framing entirely.

    What:
    - Add a note to @01KJXQK4 referencing the redesign decision items and
      the program's plan series as its successor.
    - Cancel the task with a supersession reason.

    How: kspec batch with task note + task cancel; verify the task shows
    cancelled with the pointer note in its timeline.

- title: Fold the multi-project agent dashboard design task into the cross-project track
  slug: task-fold-agent-dashboard-design-task
  priority: 2
  tags: [meta, ui]
  description: |
    Resolve the pending multi-project agent dashboard design task
    (@01KKBD66) by folding its intent into the redesign program's
    cross-project track, where the all-projects dashboard and live-agent
    rail now live.

    Why: The task predates the program; its scope is wholly contained in
    the cross-project track's dashboard work. Leaving it pending invites
    parallel design work.

    What:
    - Add a note recording that the cross-project track's dashboard plan
      absorbs this task's scope.
    - Cancel the task with a supersession reason (or re-point it at the
      owning plan when that plan exists, whichever the owner prefers at
      execution time).

    How: kspec batch with task note + task cancel; confirm via task get.

- title: Record dispositions on overlapping draft plans
  slug: task-record-overlapping-plan-dispositions
  priority: 2
  tags: [meta, planning]
  description: |
    Add disposition notes to the four draft plans the redesign program
    absorbs, promotes, or reconciles, so no one picks them up
    independently while the program runs.

    Why: Open drafts without dispositions are invitations for duplicate
    work; the program's relationship to each is decided and should be
    visible on the records themselves.

    What:
    - @plan-interactive-agent-sessions: note that the sessions track's
      controls plan absorbs its scope (context injection surface).
    - @plan-activity-timeline-diff-summaries: note that the session
      entity plan absorbs its diff-summary scope.
    - @plan-dispatch-mutation-service: note that it is promoted as the
      program's shared mutation-service foundation (Phase 0).
    - @plan-ux-module-and-design-decision-architecture: note that its
      decision architecture is adopted (this plan's decision items are
      its first full use) and its sidebar/pulse feature sketches are
      superseded by the shell track.

    How: kspec batch with plan note per record; verify notes render on
    each plan.
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

### Consumers

| Decision | Consumed by (planned) |
|---|---|
| web-shell-platform-target | shell/palette plans, keyboard registry, view-header pattern |
| test-result-acquisition | coverage state engine, validate view |
| ac-coverage-applicability | coverage schema + engine, spec workspace, validate |
| annotation-freshness-provenance | coverage schema + engine, per-AC revision diffs |
| coverage-state-presentation | coverage engine, spec workspace, validate, sidebar badges |
| client-preference-persistence | UI foundations utility; sidebar/palette/dashboard/spec-tree persistence; cross-project registry storage |
| actor-identity-model | UI foundations identity layer; aggregation (awaiting-you), reviews surfaces, board "mine" |
| agent-question-mediation | session view, dashboard urgency feed, board blocked flow |
| integration-merge-authority | reviews gating surface, dashboard resolving actions |

### Boundaries and follow-ons deliberately not specced here

- The future "push-up" notification mechanism for agent questions
  (note-like, reliable) is deferred and unspecified by design.
- A post-plan-implementation validate/review step that could trigger
  final merges (with plan-level branching) is a named future evaluation,
  not part of this decision set.
- Task coverage metadata (a covers/covers_ac field superseding the
  in-code not-applicable convention) is out of program scope; the
  convention's retirement follows that future work, not this plan.
- Internal naming for the stale/drifted computation must not collide
  with the existing validate staleness/drift flag vocabulary (different
  semantics); the coverage engine plan owns the disambiguation.
