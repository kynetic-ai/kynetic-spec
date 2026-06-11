# Web UI Foundations

## Specs

```yaml
# ─── Navigation ───

- title: Breadcrumb Navigation
  slug: ui-breadcrumb
  type: feature
  parent: "@web-ui"
  description: |
    Entity views present a breadcrumb trail showing the hierarchy path
    from the root to the current entity. The trail adapts to the number
    of path segments and the available width by collapsing middle
    segments into a single collapse indicator; collapsed segments stay
    reachable through a popover that lists them in hierarchy order.
    Each segment carries an indicator of its item kind, the current
    segment is visually emphasized, and the full path's titles and
    kinds are resolved server-side in one bounded request.
  acceptance_criteria:
    - id: ac-1
      given: |
        an entity whose breadcrumb path — root through current entity —
        contains 4 or fewer segments
      when: |
        the breadcrumb renders with sufficient width for all segments
      then: |
        every segment renders in hierarchy order and no collapse
        indicator appears
    - id: ac-2
      given: |
        a breadcrumb path containing 5 or 6 segments
      when: |
        the breadcrumb renders
      then: |
        exactly the root segment, one collapse indicator, the two
        ancestor segments nearest the current entity, and the current
        segment render in hierarchy order, with the remaining segments
        collapsed into the indicator
    - id: ac-3
      given: |
        a breadcrumb path containing 7 or more segments
      when: |
        the breadcrumb renders
      then: |
        exactly the root segment, one collapse indicator, the single
        ancestor segment nearest the current entity, and the current
        segment render in hierarchy order, with the remaining segments
        collapsed into the indicator
    - id: ac-4
      given: |
        a breadcrumb whose truncated form still exceeds the available
        width
      when: |
        the breadcrumb renders
      then: |
        visible ancestor segments, including the root, collapse into
        the indicator until the trail fits, and the current segment
        always remains visible
    - id: ac-5
      given: |
        a breadcrumb showing a collapse indicator
      when: |
        the indicator is activated
      then: |
        a popover lists every collapsed segment in hierarchy order,
        and activating a listed segment navigates to that entity
    - id: ac-6
      given: |
        the collapsed-segment popover is open
      when: |
        the user presses the up or down arrow key, Enter, or Escape
      then: |
        arrow keys move the selection through the listed segments,
        Enter navigates to the selected segment, and Escape closes the
        popover without navigating
    - id: ac-7
      given: |
        a pointing device without hover capability or keyboard-only
        input
      when: |
        the collapse indicator is activated by tap, click, or keyboard
      then: |
        the popover opens; opening never requires hover
    - id: ac-8
      given: |
        a breadcrumb with a collapse indicator
      when: |
        the popover opens or closes
      then: |
        the breadcrumb's visible segments and the surrounding page
        content do not shift position
    - id: ac-9
      given: |
        a breadcrumb path whose segments reference spec items of
        differing kinds
      when: |
        the breadcrumb renders
      then: |
        each segment, including segments listed inside the popover,
        carries the indicator for its item kind, and the current
        segment is visually emphasized relative to ancestor segments
    - id: ac-10
      given: |
        a breadcrumb is built for any entity
      when: |
        the ancestor chain is resolved
      then: |
        the titles and kinds for the entire chain come from
        server-resolved data in a single bounded request, and the
        client issues no unbounded entity-list request to construct
        the trail

# ─── View Header ───

- title: Standard View Header
  slug: ui-view-header
  type: feature
  parent: "@web-ui"
  depends_on:
    - "@web-shell-platform-target"
  description: |
    Entity views share a single header pattern: the entity reference,
    a lifecycle or state indicator drawn from a shared status-token
    vocabulary, counts of the entity's children where applicable, and
    a zone for view-specific actions, arranged identically across
    views. The header's leading chrome zone stays empty. Each entity
    state is represented by exactly one visual token wherever it
    appears. Detail views adopt the header as their surfaces are
    redesigned: the review detail and session detail views are the
    first adopters, and every other entity detail view adopts it
    through the track plan that redesigns that surface.
  acceptance_criteria:
    - id: ac-1
      given: |
        an entity detail view that presents the standard header
      when: |
        its header renders
      then: |
        the header presents the entity reference, a lifecycle or state
        indicator, child counts where the entity has countable
        children, and a view-actions zone, in the arrangement shared
        by all adopting views
    - id: ac-2
      given: |
        the same entity state presented in two different views
      when: |
        each view renders its state indicator
      then: |
        one shared status token — the same color and glyph —
        represents that state in both places
    - id: ac-3
      given: |
        a view header laid out at any viewport width
      when: |
        its elements are positioned
      then: |
        the leading chrome zone contains no header element
    - id: ac-4
      given: |
        an entity with countable children
      when: |
        the header presents child counts
      then: |
        the counts derive from server-resolved fields or server-side
        aggregation, not from client-side enumeration of full entity
        lists
    - id: ac-5
      given: |
        a view that contributes actions to its header
      when: |
        the header renders
      then: |
        the actions appear only within the designated actions zone and
        each action is operable by keyboard
    - id: ac-6
      given: |
        the review detail and session detail views
      when: |
        each view renders
      then: |
        each presents the standard view header in place of a bespoke
        header

# ─── Keyboard Shortcuts ───

- title: Keyboard Shortcut Registry
  slug: ui-shortcut-registry
  type: feature
  parent: "@web-ui"
  depends_on:
    - "@web-shell-platform-target"
  description: |
    All interface keyboard shortcuts are declared through one central
    registry that resolves each shortcut's chord per platform,
    detects binding collisions at registration, refuses
    browser-reserved combinations, and falls back to a shortcut's
    declared alternate chords when the preferred chord cannot be
    bound. Each shortcut is declared with an activation context — a
    global context or a surface-scoped context that is active only
    while its owning surface is active — a binding is active only
    while its context is active, and collision detection applies
    among the bindings of the same context. The registry's inventory
    of active bindings is enumerable with display labels matching the
    active platform.
  acceptance_criteria:
    - id: ac-1
      given: |
        a shortcut registered through the registry and active in the
        current context
      when: |
        its resolved chord is pressed
      then: |
        the bound action fires exactly once
    - id: ac-2
      given: |
        the set of registered shortcuts active in the current context
      when: |
        the shortcut inventory is requested
      then: |
        every active binding is enumerated with its display label and
        the chord resolved for the active platform
    - id: ac-3
      given: |
        a shortcut declared with a platform-abstract primary modifier
      when: |
        its binding resolves on each supported platform
      then: |
        the platform's conventional primary modifier is used, and the
        displayed label matches the binding that is actually active
    - id: ac-4
      given: |
        a registration that resolves to a chord already bound in the
        same context
      when: |
        the registration is attempted
      then: |
        the registration is rejected with a reported collision and the
        existing binding remains the only binding for that chord
    - id: ac-5
      given: |
        a registration whose preferred chord is on the active
        platform's browser-reserved combination list
      when: |
        the binding resolves
      then: |
        the preferred chord is not bound; the shortcut's first
        declared fallback chord that is neither reserved nor colliding
        is bound instead, and a shortcut with no resolvable fallback
        is reported as unbound rather than silently dropped
    - id: ac-6
      given: |
        keyboard focus inside a text-entry control
      when: |
        a chord without the platform's primary modifier is pressed
      then: |
        no registry action fires and the keystroke reaches the
        text-entry control

# ─── Preference Persistence ───

- title: Persisted Preference Utility
  slug: ui-preference-store
  type: feature
  parent: "@web-ui"
  depends_on:
    - "@client-preference-persistence"
  description: |
    Interface preferences persist through one shared utility. Each
    preference is declared with a namespace, a key, a value type with
    validation, a schema version with an upgrade rule, and a default.
    The utility's interface is storage-agnostic; the default backend
    is browser-local storage, and the utility degrades to
    session-scoped in-memory behavior when persistent storage is
    unavailable.
  acceptance_criteria:
    - id: ac-1
      given: |
        a preference value written through the utility
      when: |
        the interface reloads in the same browser
      then: |
        reading the preference returns the stored value
    - id: ac-2
      given: |
        two preferences registered under different namespaces with the
        same key name
      when: |
        both are written and read back
      then: |
        each returns its own value and neither overwrites the other
    - id: ac-3
      given: |
        a stored preference value whose schema version is older than
        the preference's current declared version
      when: |
        the preference is read
      then: |
        the result is the value produced by the preference's declared
        upgrade rule, or the declared default when no rule applies —
        never the unmigrated stored shape
    - id: ac-4
      given: |
        a stored value that fails the preference's declared type
        validation
      when: |
        the preference is read
      then: |
        the declared default is returned and the invalid value does
        not propagate to the consumer
    - id: ac-5
      given: |
        an alternative storage backend provided behind the utility's
        interface
      when: |
        consumers read and write preferences
      then: |
        the observable read and write semantics are unchanged and
        consumers never access the backing store directly
    - id: ac-6
      given: |
        persistent browser storage is unavailable or a write to it
        fails
      when: |
        preferences are written and read
      then: |
        the utility operates in session-scoped in-memory mode and the
        interface remains functional

# ─── Identity ───

- title: Actor Identity Resolution
  slug: actor-identity-resolution
  type: feature
  parent: "@web-ui"
  depends_on:
    - "@actor-identity-model"
  description: |
    The system exposes its identity configuration — the configured
    human identity and the canonical agent roster — through a single
    identity surface, and classifies recorded actor strings to
    canonical identities. Classification resolves recognizable
    variants of agent identifiers and of the human identity to their
    canonical form; strings that resolve to neither classify as
    unknown without failing. Records written through the daemon
    resolve their author through the standard author-resolution
    precedence rather than an anonymous placeholder, and actor values
    persisted by daemon record writes are canonical wherever
    classification can resolve them: a value — caller-supplied or
    precedence-resolved — that classifies as a recognizable variant
    of a canonical identity is stored in canonical form, and a value
    that classifies to no canonical identity is stored as supplied
    and classifies as unknown when read.
  acceptance_criteria:
    - id: ac-1
      given: |
        a running daemon with a configured project
      when: |
        the identity surface is requested
      then: |
        the response contains the configured human identity with its
        display name and the canonical agent roster — each agent's
        canonical identifier and display information — in a single
        bounded response
    - id: ac-2
      given: |
        a recorded actor string that is a recognizable variant of a
        canonical agent identifier
      when: |
        the string is classified
      then: |
        it resolves to that agent's canonical identity with actor
        kind agent
    - id: ac-3
      given: |
        a recorded actor string matching the configured human identity
        or a recognizable variant of it
      when: |
        the string is classified
      then: |
        it resolves to the human identity with actor kind human
    - id: ac-4
      given: |
        a recorded actor string that resolves to no canonical agent
        and not to the human identity
      when: |
        the string is classified
      then: |
        classification yields an unknown-kind result that preserves
        the original string, and no operation fails because of it
    - id: ac-5
      given: |
        the same actor string and the same identity configuration
      when: |
        classification runs at different times
      then: |
        the result is identical
    - id: ac-6
      given: |
        a review mutation arriving through the daemon without an
        explicit actor value
      when: |
        the record is written
      then: |
        the recorded author resolves through the standard
        author-resolution precedence — explicit value, then
        environment, then configured author, then version-control or
        system identity — and is never recorded as an anonymous
        placeholder
    - id: ac-7
      given: |
        an actor value about to be persisted by a daemon record
        write — supplied explicitly by the caller or resolved through
        the author-resolution precedence — that classifies as a
        recognizable variant of a canonical agent identity or of the
        configured human identity
      when: |
        the record is written
      then: |
        the stored actor value is the canonical identity, never the
        variant form
    - id: ac-8
      given: |
        an actor value about to be persisted by a daemon record write
        that classifies to no canonical identity
      when: |
        the record is written
      then: |
        the write succeeds, the value is stored as supplied, and
        reading the record classifies the actor as unknown

- title: Actor Display and Next-Actor Derivation
  slug: actor-display
  type: requirement
  parent: "@actor-identity-resolution"
  description: |
    A single display primitive renders any recorded actor: the
    canonical display name with a visual distinction between human and
    agent kinds, and an honest distinct treatment for unknown actors.
    A deterministic next-actor rule derives, from a review's lifecycle
    state and disposition, which role the review awaits — the
    reviewing party, the author of the work under review, or no one —
    and every surface presenting whom a review awaits resolves the
    awaited party by applying that one rule to the review's recorded
    participants.
  acceptance_criteria:
    - id: ac-1
      given: |
        any surface presenting a recorded actor
      when: |
        the actor renders
      then: |
        the actor's canonical display name renders with a visual
        distinction between human and agent kinds, and the same actor
        renders identically across surfaces
    - id: ac-2
      given: |
        an actor classified as unknown
      when: |
        it renders
      then: |
        the original recorded string is displayed with a distinct
        unknown treatment and is never presented as a canonical
        identity
    - id: ac-3
      given: |
        a review's lifecycle state and disposition
      when: |
        the review's awaited role is derived
      then: |
        the result follows the fixed mapping — an open review with
        pending disposition awaits the reviewer role; an open review
        with changes-requested disposition awaits the work-author
        role; an open review with approved disposition awaits the
        work-author role for post-approval action; a closed or
        archived review awaits no role
    - id: ac-4
      given: |
        two surfaces presenting whom the same review awaits
      when: |
        each derives the awaited party from that review's lifecycle
        state, disposition, and recorded participants
      then: |
        both surfaces present the same result

- title: Historical Actor Normalization
  slug: actor-history-normalization
  type: requirement
  parent: "@actor-identity-resolution"
  depends_on:
    - "@actor-identity-model"
  description: |
    A one-time step of the project data upgrade path rewrites
    historical actor fields to canonical identities. A declared
    variant map resolves recognizable historical actor strings; values
    no rule resolves are replaced with the declared default for their
    record kind. The step reports every rewrite, supports a preview
    mode that modifies nothing, and is idempotent.
  acceptance_criteria:
    - id: ac-1
      given: |
        a project whose historical records contain recognizable actor
        variants
      when: |
        the upgrade step runs
      then: |
        those actor fields are rewritten to the corresponding
        canonical identities according to the declared variant map
    - id: ac-2
      given: |
        an actor value that no variant rule resolves
      when: |
        the upgrade step runs
      then: |
        the value is replaced with the declared default for its record
        kind, and the original value appears in the step's report
    - id: ac-3
      given: |
        the upgrade step has already run to completion on a project
      when: |
        it runs again
      then: |
        no record changes
    - id: ac-4
      given: |
        the upgrade is invoked in preview mode
      when: |
        the step evaluates the project's records
      then: |
        it reports the rewrites it would perform and modifies no
        record
    - id: ac-5
      given: |
        the upgrade step completes
      when: |
        actor fields across the project's record kinds are inspected
      then: |
        every actor field value is a canonical identity or a declared
        default
```

## Tasks

derive_from_specs: false

```yaml
- title: Implement identity endpoint and actor classifier
  slug: task-identity-endpoint-classifier
  priority: 1
  tags: [daemon, api, identity]
  spec_ref: "@actor-identity-resolution"
  description: |
    Build the identity surface (configured human identity + canonical
    agent roster) and the actor classification logic that resolves
    recorded actor strings to canonical identities.

    Why: No current-user concept exists anywhere in the system. Every
    "mine" / "awaiting you" / "needs you" feature in the redesign
    program is undefined without it, and the measured actor-string
    spread (the same codex agent recorded at least 7 different ways,
    pr-reviewer at least 4, across 1,323 review records) makes
    read-time classification mandatory regardless of write-time
    normalization.

    What:
    - Add a daemon identity endpoint (e.g. GET /api/identity) that
      returns the configured human identity (from the author config
      chain — see @config-author — plus any configured profile
      display name) and the canonical agent roster built from the
      project's agent definitions: canonical id and display info per
      agent. One bounded response; no entity-list fan-out. Follow the
      standard response envelope and project-scoping middleware.
    - Apply @trait-api-endpoint to @actor-identity-resolution as part
      of this task (kspec item set @actor-identity-resolution
      --add-trait trait-api-endpoint) — plan derivation does not
      materialize plan-declared traits reliably, so the task owns the
      application — and implement the endpoint to the trait contract:
      success response shape and request-id tracing per the trait;
      trait criteria that cannot apply to a bodyless, read-only,
      non-list endpoint with no entity-ref parameter are annotated
      N/A with reasons per the N/A annotation convention.
    - Implement an actor classifier in shared (non-daemon-only) code
      so the upgrade path can reuse it: input is a recorded actor
      string plus the identity configuration; output is
      { kind: human | agent | unknown, canonical id, display name,
      original string }. Recognizable variants include the canonical
      id itself, @-prefixed forms, email-suffixed forms
      (codex@openai.com, codex@openai, codex@local, codex@gpt-5),
      role-suffixed forms (codex-reviewer), and the configured human
      name variants. Unknown strings classify as unknown and never
      throw.
    - Classification must be a pure function of (string, config):
      same input, same output.
    - Static-mode/web consumption: expose the classifier to the web
      UI as a shared utility fed by the identity endpoint payload.

    How: Roster source is the agent definitions in project meta
    (kspec agent list data); human identity source is the
    author-resolution config (KSPEC_AUTHOR env, kspec.config.yaml
    author, git/OS fallback) per @config-author. Seed the variant
    table from the measured inventory in
    plans/ui-redesign/analysis.md section 4.6. Keep the variant map
    data-driven (one table consumed by both the classifier and the
    upgrade step in @task-actor-normalization-upgrade).

    Covers: @actor-identity-resolution ac-1, ac-2, ac-3, ac-4, ac-5;
    @trait-api-endpoint ac-1, ac-6 (inherited via
    @actor-identity-resolution; trait ac-2, ac-3, ac-4, ac-5 are
    annotated N/A — no entity-ref parameter, no request body, not a
    list endpoint, read-only).

- title: Canonicalize daemon-write authorship and remove anonymous fallbacks
  slug: task-review-author-resolution
  priority: 1
  tags: [daemon, reviews, identity]
  spec_ref: "@actor-identity-resolution"
  depends_on:
    - "@task-identity-endpoint-classifier"
  description: |
    Make daemon record writes persist canonical actor identities:
    remove the anonymous review-route fallbacks, resolve missing
    actor values through the standard author-resolution chain, and
    classify every actor value to canonical form before persistence.

    Why: packages/daemon/src/routes/reviews.ts contains ten
    `|| "anonymous"` fallbacks (threads, replies, resolve/reopen,
    verdicts, checks, lifecycle changes) — they are why 287 review
    records carry "@claude" and singleton variants as authors. But
    fixing the fallbacks alone is not enough: no daemon write path
    canonicalizes, the author chain ends in free-form git/OS-derived
    names, and caller-supplied values persist verbatim — which is how
    the same codex agent accumulated at least 7 recorded spellings.
    @actor-identity-model ac-1 requires newly written actor fields to
    be canonical, and the upstream claim table assigns this plan the
    canonical-write identity layer.

    What:
    - Replace every anonymous fallback in the review routes with the
      same author resolution used by the other record-writing routes
      (explicit body value wins, then environment, then configured
      author, then git/OS identity).
    - Add a write-path canonicalization step shared by the daemon's
      record-writing routes (reviews, tasks, triage, inbox, plan
      notes): after resolution — explicit caller value or chain
      result — classify the value through the shared classifier from
      @task-identity-endpoint-classifier and persist the canonical
      identity whenever classification resolves it. A value that
      classifies to no canonical identity persists as supplied and
      surfaces as unknown on read — out-of-roster actors stay
      honestly attributed, and no recognizable variant is ever
      persisted by a daemon write.
    - Reconcile @config-author with @actor-identity-model's
      transition boundary: update that spec's fallback-chain wording
      (kspec item set at execution time) to state that chain-resolved
      values pass through write-time classification before
      persistence, so the git/OS-name tail no longer persists
      free-form variants of configured identities and the two specs
      stop sitting in the corpus as an unexplained contradiction.
    - Reconcile @actor-identity-model ac-1 with the canonical-write
      boundary the same way: update that criterion's wording (kspec
      item set at execution time — the item exists by then, since
      P0a derives before this plan) to scope the canonical guarantee
      to values classification can resolve — a value that classifies
      to a canonical identity is stored in canonical form, never a
      variant; a value that classifies to no canonical identity is
      stored as supplied and classifies as unknown on read. Without
      this rewording, ac-1's literal "never a free-form variant"
      text is unmeetable against @actor-identity-resolution ac-8's
      deliberate preserve-as-supplied behavior for out-of-roster
      actors, and this task's Covers claim on ac-1 could not be
      verified as written.
    - Behavioral tests: a review mutation without an actor in the
      body records the resolved configured author in canonical form;
      one with an explicit variant actor (e.g. codex@openai.com)
      records the canonical agent id; one with an unrecognizable
      actor records the supplied value and classifies unknown on
      read; no path records "anonymous".

    How: Reuse the existing getAuthor() chain (the one task/triage/
    inbox routes call) inside the review route handlers, then wrap
    resolution + classification into one shared helper adopted by
    all record-writing routes. This is a write-path-only change —
    historical values are handled by
    @task-actor-normalization-upgrade, not here.

    Covers: @actor-identity-resolution ac-6, ac-7, ac-8;
    @actor-identity-model ac-1.

- title: Build actor display primitive and next-actor derivation
  slug: task-actor-display-next-actor
  priority: 2
  tags: [web-ui, identity]
  spec_ref: "@actor-display"
  depends_on:
    - "@task-identity-endpoint-classifier"
  description: |
    Build the shared actor display primitive and the next-actor
    derivation rule for reviews, and adopt them on the surfaces that
    render actors today.

    Why: Without one primitive, every redesigned surface re-invents
    actor rendering the way getStatusColor was re-invented four
    times. Without one next-actor rule, "awaiting your action" views
    in later plans (aggregation, dashboard, reviews hub) would each
    derive who a review awaits differently.

    What:
    - An actor display component that takes a recorded actor string,
      classifies it via the shared classifier (fed by the identity
      endpoint payload), and renders canonical display name with a
      human/agent kind distinction; unknown actors render the
      original string with a distinct unknown treatment. Same actor
      renders identically wherever the component is used.
    - A next-actor derivation helper implementing the fixed role
      mapping from @actor-display ac-3 (open+pending → reviewer
      role, open+changes_requested → work-author role,
      open+approved → work-author role, closed/archived → no role).
      Surfaces resolve the awaited role to a concrete party using
      the review record's recorded participants (verdict reviewers,
      work submitter). Implement the rule once in shared code so
      server payload enrichment and client surfaces consume the same
      rule; assert with a table-driven test over every
      lifecycle/disposition combination.
    - Adopt the primitive on the existing review detail and review
      list surfaces (thread authors, verdict reviewers) as first
      consumers, replacing raw string rendering.

    How: Component lives with the shared web-ui component library;
    derivation helper lives next to the classifier so the daemon can
    enrich review payloads with it later. Static mode: classifier
    degrades to unknown-kind rendering when no identity payload is
    available (snapshot has no daemon identity surface).

    Covers: @actor-display ac-1, ac-2, ac-3, ac-4.

- title: Add historical actor normalization to the upgrade path
  slug: task-actor-normalization-upgrade
  priority: 2
  tags: [cli, upgrade, identity]
  spec_ref: "@actor-history-normalization"
  depends_on:
    - "@task-identity-endpoint-classifier"
  description: |
    Add a one-time data-upgrade step that rewrites historical actor
    fields to canonical identities.

    Why: The actor-string spread is measured, not hypothetical: 1,323
    review records split author across Jacob Chapel / "@claude" /
    Test User / codex variants, and verdict reviewer strings name the
    same agents many different ways. Identity-derived views computed
    over un-normalized history would misattribute most of the corpus.
    The decision (@actor-identity-model ac-2) requires the upgrade
    path to resolve this once, and this plan is the data-upgrade
    claimant for that criterion.

    What:
    - A kspec upgrade step that scans actor-bearing fields across
      record kinds (review authors, thread/reply authors, verdict
      reviewers, check/lifecycle actors, task note authors, inbox
      added_by, triage actors, plan note authors) and rewrites
      recognizable variants to canonical identities using the shared
      variant map from the classifier task.
    - Declared defaults for unresolvable values per record kind
      (e.g. unresolvable agent-like strings vs. unattributed human
      records), applied when no rule matches; originals listed in the
      step's report.
    - A rewrite report (original → canonical, record ref, field) for
      every change; kspec upgrade --dry-run prints the report without
      modifying records.
    - Idempotency: running the step on an already-normalized project
      changes nothing; cover with a run-twice test.
    - All writes go through the standard upgrade/mutation machinery
      so shadow commits record the change set.

    How: Hook into the existing kspec upgrade step framework (the
    same path that performed the folder-backed entity migration).
    Reuse the classifier's variant table as the rewrite map; the
    declared defaults live alongside it as data. Test against
    fixtures seeded with the measured variants from
    plans/ui-redesign/analysis.md section 4.6.

    Covers: @actor-history-normalization ac-1, ac-2, ac-3, ac-4,
    ac-5; @actor-identity-model ac-2.

- title: Serve server-resolved breadcrumb ancestor chains
  slug: task-breadcrumb-ancestry-api
  priority: 2
  tags: [daemon, api]
  spec_ref: "@ui-breadcrumb"
  description: |
    Provide the server-resolved ancestor chain (refs, titles, item
    kinds, root through current entity) that the breadcrumb consumes.

    Why: The breadcrumb must not fetch entity lists to reconstruct a
    path client-side — the pagination convention forbids unbounded
    list fetches for derived data, and titles/kinds are already
    server-resolvable through the cached ref index.

    What:
    - Expose the ancestor chain for an entity in one bounded
      response: either as a resolved `ancestors` field on the item
      detail payload or as a dedicated chain lookup — pick one shape
      and document it; the client must get the full chain (ref,
      title, item kind per segment, in root-to-current order) in a
      single request.
    - Build the chain from the daemon entity cache / reference index
      (parent path is already computed for items); no per-request
      disk walks.
    - Cover tasks, plans, reviews, and sessions as breadcrumb leaves
      too: a task's chain is its spec_ref's chain plus the task; a
      plan's chain is its module plus the plan; a review's chain is
      its subject entity's chain plus the review; a session's chain
      is its owning task's chain plus the session when the session
      is task-scoped, otherwise a single-segment chain. Entities
      without ancestors return a single-segment chain.
    - Static export: the snapshot carries enough parent/kind data for
      the static provider to serve the same chain shape read-only.

    How: Extend the items route detail handler (and the task, plan,
    review, and session detail payloads) using the existing
    ref-resolution helpers in the daemon. Follow the standard
    response envelope.

    Covers: @ui-breadcrumb ac-10.

- title: Build the adaptive breadcrumb component
  slug: task-breadcrumb-component
  priority: 2
  tags: [web-ui, navigation]
  spec_ref: "@ui-breadcrumb"
  depends_on:
    - "@task-breadcrumb-ancestry-api"
  description: |
    Build the breadcrumb component with adaptive truncation and the
    collapsed-segment popover, and adopt it on existing detail
    routes.

    Why: No breadcrumb exists anywhere in the web UI today (detail
    pages use ad-hoc "Back to X" links). Every redesigned surface
    needs hierarchy orientation; building it per-surface would fork
    the truncation and accessibility logic immediately.

    What:
    - Truncation tiers driven by segment count: full path at <= 4
      segments; root + collapse indicator + last two ancestors +
      current at 5-6; root + indicator + last ancestor + current at
      7+; further ancestor-stack collapse (root included) when the
      rendered trail still overflows its container, with the current
      segment always visible.
    - The collapse indicator opens a popover (overlay — zero layout
      shift) listing collapsed segments in hierarchy order; segments
      are clickable links; up/down + Enter keyboard navigation;
      Escape closes; activation works by click, tap, and keyboard —
      never hover-only.
    - Per-segment item-kind indicators (module/feature/requirement/
      decision/trait, task, plan, review, session) and emphasized
      current segment, in the popover as well as the trail.
    - Data from the ancestor-chain payload of
      @task-breadcrumb-ancestry-api (which serves item, task, plan,
      review, and session chains); no client-side list fetches.
    - Adopt on the review detail and session detail routes (the two
      existing full-page detail surfaces), replacing their ad-hoc
      back links.
    - Component tests for each truncation tier boundary (4, 5, 6, 7
      segments), overflow collapse, and keyboard interaction.

    How: Build on the existing bits-ui popover/command primitives in
    the component library; use a container-width observer for the
    overflow tier. Route URLs via the shared reference utility
    (normalizeRef/refHref).

    Covers: @ui-breadcrumb ac-1, ac-2, ac-3, ac-4, ac-5, ac-6, ac-7,
    ac-8, ac-9.

- title: Implement the standard view header and shared status tokens
  slug: task-view-header-status-tokens
  priority: 1
  tags: [web-ui, design-system]
  spec_ref: "@ui-view-header"
  description: |
    Build the shared view-header component and the single
    status-token source it draws from, and adopt them on existing
    entity views.

    Why: The codebase has four independent getStatusColor()
    implementations (ItemDetail, TaskList, DiffFileList,
    DiffFileView) — the canonical example of what happens when
    surfaces are built without a shared substrate. Every redesigned
    surface consumes this header; without it each surface plan
    re-forks header layout and status rendering.

    What:
    - One status-token module mapping every entity lifecycle/state
      value (task statuses, review lifecycle/disposition, spec
      maturity/implementation, session statuses) to exactly one
      color + glyph token, built on the existing design-token CSS
      (--design-* status variables). Replace all four duplicated
      getStatusColor() implementations with it.
    - Include the four coverage presentation buckets (covered,
      failing, not yet, re-verify) in the same token vocabulary as
      data, so the coverage surfaces that later track plans build
      draw their tokens from this single source; the
      one-token-per-state uniqueness test covers them like every
      other state, satisfying @coverage-state-presentation ac-2's
      same-token-on-every-surface contract by construction.
    - A view-header component with fixed zones: entity reference
      (slug/ULID, copyable), state indicator from the token module,
      child counts, and a view-actions slot. The leading chrome zone
      renders empty per @web-shell-platform-target.
    - Child counts accept server-resolved values only (counts come
      from detail payloads or aggregation endpoints — the component
      offers no fetch-and-count path).
    - Header actions render in the actions slot and are
      keyboard-operable (focusable, Enter/Space activation).
    - Adopt on the review detail and session detail pages as the
      first consumers, replacing their bespoke headers (per
      @ui-view-header, every other entity detail view adopts the
      header through the track plan that redesigns that surface).

    How: Token module lives in the web-ui lib next to the design
    tokens; header component in the shared component library. Assert
    token uniqueness with a table-driven test over the full state
    vocabulary (one token per state, no state unmapped).

    Covers: @ui-view-header ac-1, ac-2, ac-3, ac-4, ac-5, ac-6;
    @coverage-state-presentation ac-2.

- title: Implement the keyboard shortcut registry
  slug: task-shortcut-registry
  priority: 2
  tags: [web-ui, keyboard]
  spec_ref: "@ui-shortcut-registry"
  description: |
    Build the central shortcut registry and migrate the existing
    uncoordinated key handlers onto it.

    Why: Three uncoordinated global key handlers exist today (the
    command palette's Cmd/Ctrl+K window listener, the sidebar
    provider's toggle chord, and the triage queue's navigation keys),
    with no collision detection and no platform mapping. The shell
    and palette plans both register many more shortcuts; without a
    registry they will collide silently.

    What:
    - Registry module: register(shortcut) with id, display label,
      platform-abstract chord (primary modifier abstraction),
      optional ordered fallback chords, activation context (global
      or surface-scoped, active only while the owning surface is
      active), and handler; unregister on component teardown.
    - Platform resolution: primary modifier maps to the platform
      convention (Cmd on macOS, Ctrl elsewhere); display labels
      render the resolved chord (⌘K vs Ctrl+K).
    - Per-platform browser-reserved combination lists maintained as
      data (e.g. Cmd/Ctrl+W, Cmd/Ctrl+T, Cmd/Ctrl+N, Cmd+Q,
      Ctrl+Tab); registration of a reserved chord falls through to
      declared fallbacks; no resolvable chord → shortcut reported
      unbound (console/diagnostic surface), never silently dropped.
    - Collision detection at registration within a context: reject
      with a reported collision, keep the existing binding.
    - Single document-level dispatcher: exactly-once action firing;
      modifier-less chords suppressed while focus is in text-entry
      controls (input, textarea, contenteditable).
    - Enumeration API returning active bindings with labels and
      resolved chords — the future shortcut-help and palette
      surfaces consume this.
    - Migrate the three existing handlers to the registry with
      unchanged user-visible behavior (the palette chord behavior of
      @web-dashboard ac-23 is preserved).
    - Table-driven tests: platform resolution, collision rejection,
      reserved fallback, text-entry suppression, enumeration.

    How: Svelte-runes store + one window keydown listener installed
    by the root layout; context activation tied to component
    lifecycle. Reserved lists and chord normalization live as plain
    data/functions for direct unit testing.

    Covers: @ui-shortcut-registry ac-1, ac-2, ac-3, ac-4, ac-5,
    ac-6; @web-shell-platform-target ac-3.

- title: Implement the persisted preference utility
  slug: task-preference-utility
  priority: 1
  tags: [web-ui, persistence]
  spec_ref: "@ui-preference-store"
  description: |
    Build the namespaced, versioned, typed preference utility with a
    storage-agnostic interface and a browser-local-storage backend,
    and migrate existing ad-hoc persistence onto it.

    Why: @client-preference-persistence requires all surface
    preferences to flow through one shared utility. Today the only
    persisted preference (project selection) talks to localStorage
    directly, and the redesign program adds many more (sidebar
    collapse, palette recents, view toggles, tree expansion) — each
    surface plan needs the utility to already exist.

    What:
    - definePreference({ namespace, key, version, schema/validate,
      default, migrate? }) returning a typed accessor (get/set/
      subscribe) usable from Svelte runes contexts.
    - Storage keys derived from namespace + key + version scheme so
      namespaces cannot collide; one reserved top-level prefix for
      the application — the shared namespaced, versioned key format
      under which every stored preference value is recorded.
    - Read path: parse → version check → migrate (declared rule) or
      fall back to default → validate → return; invalid or foreign
      values never propagate (return default).
    - Backend interface (get/set/remove string) with two
      implementations: browser-local storage and in-memory. The
      in-memory backend doubles as the degradation mode when
      localStorage is unavailable (private browsing, quota) — detect
      on first use, fall back per-write on quota errors, keep the
      interface functional.
    - Migrate the project-selection persistence in the project store
      to the utility as the first consumer, preserving the existing
      stored value (read the legacy key once as a migration).
    - Unit tests against the in-memory backend for round-trip,
      namespace isolation, version migration, validation fallback,
      and unavailable-storage degradation.

    How: Lives in the web-ui lib (src/lib/preferences/). SSR is
    disabled globally so window access is safe at module init, but
    guard for test environments. Keep serialization JSON-based with
    schema validation at the edge.

    Covers: @ui-preference-store ac-1, ac-2, ac-3, ac-4, ac-5, ac-6;
    @client-preference-persistence ac-1.
```

## Implementation Notes

### Approval ordering (binding gate)

The spec items here reference three decision items by `depends_on`
(`@web-shell-platform-target`, `@client-preference-persistence`,
`@actor-identity-model`); task Covers lines additionally claim
decision criteria on those items and on
`@coverage-state-presentation`. All four decision items live in the
P0a plan (`@plan-ui-redesign-global-decisions`, source
`plans/ui-redesign-global-decisions.md`) and enter the catalog only
when that plan derives. **Gate: this plan must not be approved or
derived until P0a has been approved and derived** — approving or
deriving it earlier produces broken references by construction.
This is the only cross-plan ordering constraint; everything else
here depends on nothing outside the existing implemented
foundation.

### Upstream decision AC claims

P0a's claim table binds track plans to claim the decision criteria
they implement with task Covers lines. This plan claims:

| Decision AC | Claiming task |
|---|---|
| @web-shell-platform-target ac-3 | @task-shortcut-registry |
| @client-preference-persistence ac-1 | @task-preference-utility |
| @actor-identity-model ac-1 | @task-review-author-resolution (canonical-write layer) |
| @actor-identity-model ac-2 | @task-actor-normalization-upgrade |
| @coverage-state-presentation ac-2 | @task-view-header-status-tokens (shared token source) |

The "data upgrade plan" named in P0a's table row for
@actor-identity-model ac-2 is this plan: the one-time migration is
@task-actor-normalization-upgrade's upgrade-path step; no separate
data-upgrade plan exists or is needed. These Covers lines resolve
once P0a derives (see the approval-ordering gate above).

@actor-identity-model ac-1's literal wording ("never a free-form
variant") predates the canonical-write boundary adopted here and
would be unmeetable against @actor-identity-resolution ac-8's
preserve-as-supplied behavior for out-of-roster actors.
@task-review-author-resolution therefore reconciles that
criterion's wording at execution time — scoping the canonical
guarantee to values classification can resolve, with unclassifiable
values preserved and surfaced as unknown — exactly the way it
already reconciles @config-author, so its Covers claim on ac-1 is
verifiable as written.

### Relationship to existing specs (verified read-only)

- `@ui-app-shell` — owns sidebar/navigation chrome; untouched here.
  The view header is a per-entity-view pattern, not shell chrome. Any
  supersession of shell specs belongs to the shell-track plan, not
  this one.
- `@web-dashboard` ac-23..25 — the existing Cmd/Ctrl+K palette
  behavior is preserved; the shortcut-registry task migrates only the
  binding mechanism. No AC rewrite needed in this plan.
- `@config-author` — defines the author-resolution precedence (env >
  config > git/OS) that the identity surface's human identity builds
  on and that the canonical-write task adopts. That task also amends
  the spec's fallback-chain wording to layer write-time
  classification on top — the reconciliation @actor-identity-model's
  transition boundary assigns to this plan. The precedence order
  itself is unchanged.
- `@ui-api-aggregation` — establishes the server-resolved-data
  conventions (no client list fetches for derived data) that the
  breadcrumb ancestry payload and header counts follow. Extended, not
  modified.

`@trait-api-endpoint` is applied to `@actor-identity-resolution`
inside `@task-identity-endpoint-classifier` (plan derivation does
not materialize traits declared in plan YAML reliably, so the task
owns the application via `kspec item set --add-trait`). That task's
Covers line claims the applicable inherited trait criteria, and
non-applicable trait criteria are annotated N/A with reasons per
the N/A annotation convention — the endpoint contract cannot be
skipped silently after derive.

### Design detail

- **Breadcrumb segment math**: "segments" counts root through current
  entity inclusive. The three tiers are by segment count; the fourth
  (ancestor-stack) tier is by measured width and may collapse the
  root itself. The current segment is never collapsed.
- **Breadcrumb leaves beyond items**: reviews and sessions are
  first-class breadcrumb leaves — a review chains through its
  subject entity, a session through its owning task — so the two
  existing full-page detail surfaces (review detail, session detail)
  can adopt the breadcrumb with the same server-resolved payload.
- **Status tokens**: the four duplicated `getStatusColor()`
  implementations live in ItemDetail, TaskList, DiffFileList, and
  DiffFileView; the token module replaces all four. The module is
  the single token source for both vocabularies: entity
  lifecycle/state values (whose one-token-per-state contract is
  `@ui-view-header`'s) and the four coverage presentation buckets
  (registered as data here so later coverage surfaces draw from the
  same source — claiming `@coverage-state-presentation` ac-2).
- **Shortcut fallbacks**: this plan resolves open question #28
  (keyboard fallbacks) from the decision register: shortcuts declare
  ordered fallback chords; resolution binds the first chord that is
  neither browser-reserved on the active platform nor colliding; a
  shortcut with no resolvable chord is reported unbound, never
  silently dropped.
- **Identity classification is read-side and permanent**: even after
  write-time canonicalization (the canonical-write layer) and the
  one-time normalization, classification stays in the read path —
  external writers and older shadow history can always reintroduce
  variants. The variant map is one data table shared by the
  classifier, the write path, and the upgrade step.
- **Canonical-write boundary**: the daemon write path guarantees
  that no recognizable variant of a canonical identity is ever
  persisted; values that classify to no canonical identity persist
  as supplied and render as unknown. This is deliberate: rewriting
  out-of-roster actors to a default at write time would fabricate
  attribution, while the honest unknown classification keeps
  identity-derived views truthful.
  @task-review-author-resolution reconciles
  @actor-identity-model ac-1's wording with this boundary at
  execution time (see the upstream decision AC claims note) so the
  decision criterion and this behavior agree literally, not just in
  intent.
- **Next-actor mapping** is intentionally minimal and role-based:
  the rule derives the awaited role (reviewer role / work-author
  role / no role) from lifecycle + disposition, and surfaces resolve
  the role to a concrete party via the review's recorded
  participants. Richer assignment semantics (explicit reviewer
  assignment, reassignment) are deferred with the A5 cluster per the
  decision register and can extend the rule without breaking its
  consumers.

### Scope exclusions

- No authentication or access control — identity is attribution only,
  per `@actor-identity-model` ac-3.
- No awaiting-you / needs-you aggregate views or endpoints — later
  track plans (aggregation, cross-project, dashboard) consume the
  classifier and next-actor rule built here.
- No sidebar/palette/shell rebuild — the shell-track plan consumes
  the registry and preference utility.
- No server-synced preferences — browser-local storage only, per the
  decision register's deferred list; the storage-agnostic interface
  is the future seam.
- No header adoption beyond the review and session detail views —
  per `@ui-view-header`, every other entity detail view adopts the
  standard header through the track plan that redesigns that
  surface.
- Assisted review of ambiguous historical actors is an operator
  activity at upgrade time (agent-assisted cleanup); the upgrade step
  itself applies only the declared variant map and declared defaults.

### Migration and backcompat

- The actor normalization runs as a step of `kspec upgrade` with
  `--dry-run` preview, a full rewrite report, and idempotent
  re-runs. It writes through the standard mutation machinery so the
  shadow branch records the change set.
- The canonical-write authorship change is write-path only; it does
  not rewrite history (the upgrade step owns that). Explicit actor
  values from CLI/dispatch callers keep winning the resolution
  precedence, but a value that classifies as a recognizable variant
  persists in canonical form; only out-of-roster values persist as
  supplied.
- The preference utility migrates the existing project-selection
  localStorage value by reading the legacy key once; no other
  persisted client state exists today.
- Breadcrumb adoption on existing routes (reviews, sessions) replaces
  ad-hoc back links without changing route URLs; static export serves
  the same ancestor-chain shape read-only.
