# Unified Spec Workspace

> **Program track:** kspec interface redesign / spec workspace, P1d.
>
> **Approval gate:** Do not approve or derive this plan until
> @plan-web-ui-foundations, @plan-ac-coverage-verification-schema-and-storage,
> @plan-test-result-ingestion, @plan-coverage-state-engine, and
> @plan-coverage-resolution-mutations are completed on the redesign branch.
> This plan consumes the server-resolved breadcrumb chain, shared view-header
> and status-token primitives, actor/foundation work, the normalized coverage
> read model, coverage-state cache/events, and coverage resolution mutation
> endpoints; it must not recreate those foundations.
>
> **Branch gate:** When imported, keep this plan on the shared redesign branch
> (`feat/ui-redesign`) with the other UI redesign plans. The workspace is a
> general kspec UI for any project, not a Kynetic-self-hosting-only surface.
>
> **Design source:** This plan follows the chosen "unified page+tree" direction
> from the UI redesign handoff and research notes: the current `/specs` sheet
> view becomes a real navigable workspace where every spec node and acceptance
> criterion can be expanded in context or opened as its own page. Visual details
> are reference material; behavior, data ownership, URL semantics, coverage
> state consumption, accessibility, and static/read-only degradation are the
> binding requirements.

## Specs

```yaml
# ─── Workspace Data Contract ───

- title: Unified Spec Workspace Data Projection
  slug: unified-spec-workspace-data-projection
  type: feature
  parent: "@web-ui"
  depends_on:
    - "@ui-breadcrumb"
    - "@ui-view-header"
    - "@coverage-state-api-cache"
    - "@coverage-state-events"
  traits:
    - "@trait-api-endpoint"
    - "@trait-error-guidance"
  description: |
    The spec workspace reads one backend-owned workspace projection instead
    of reconstructing page hierarchy, breadcrumb paths, linked work, corpus
    counts, or coverage rollups from unbounded client-side entity lists. The
    projection exposes the root workspace, node detail, child-row summaries,
    acceptance-criterion detail, coverage-state summaries, and lightweight
    linked-work counts through bounded daemon/static API contracts. It uses
    the canonical four user-facing presentation buckets from the
    coverage-state engine — covered, failing, not yet, and re-verify — while
    preserving transport enum values and secondary re-verify causes for API
    payloads, captions, and resolution panels.
  acceptance_criteria:
    - id: ac-bounded-root-projection
      given: |
        a web client opens the root Specs workspace
      when: |
        it requests the root projection
      then: |
        the daemon returns corpus counts, project coverage summary, top-level
        visible nodes, and per-node child/coverage/linked-work counts in one
        bounded envelope; the client does not fetch every item and compute
        derived workspace statistics locally
    - id: ac-node-detail-projection
      given: |
        a client opens any module, feature, requirement, trait, constraint, or
        other supported spec item node
      when: |
        it requests the node's workspace detail
      then: |
        the response includes the node header fields, server-resolved
        breadcrumb ancestors, ordered child sections, acceptance criteria when
        present, coverage rollups, linked-work counts, and enough pagination
        or continuation metadata to avoid unbounded child expansion
    - id: ac-ac-detail-projection
      given: |
        a client opens an acceptance criterion as a focused workspace page
      when: |
        it requests the criterion detail
      then: |
        the response includes the parent item chain, criterion G/W/T text,
        computed coverage state, coverage evidence summaries, sibling
        criterion summaries, linked tasks/sessions/plans where available, and
        any current re-verify explanation without requiring the client to join
        raw coverage, task, session, and spec lists
    - id: ac-coverage-source-of-truth
      given: |
        the workspace displays state pills, bars, banners, counts, filters, or
        resolution affordances
      when: |
        it needs coverage data
      then: |
        every displayed coverage value comes from the backend
        coverage-state read model and maps API enum values onto the same
        user-facing covered, failing, not yet, and re-verify vocabulary, with
        secondary causes used only as details and never as a separate
        client-computed state model
    - id: ac-endpoint-contract
      given: |
        a client requests any workspace projection endpoint
      when: |
        the request succeeds, names a missing ref, includes invalid query
        input, or is processed for tracing
      then: |
        responses follow the existing daemon API contract: successful reads
        return 2xx JSON envelopes, missing refs return 404 bodies with error,
        message, and suggestion, validation errors identify fields, paginated
        projections expose limit/offset/total metadata where pagination is
        supported, and responses carry the request tracing header required by
        the API endpoint trait
    - id: ac-read-endpoints-do-not-commit
      given: |
        workspace projection endpoints are read endpoints
      when: |
        they serve root, node, criterion, linked-work, or coverage projection
        data
      then: |
        they do not mutate project state or create shadow commits; the
        mutation-specific API endpoint trait criterion applies only to the
        existing resolution mutation endpoints consumed by this workspace
    - id: ac-error-guidance-contract
      given: |
        a workspace projection request fails because a ref, criterion, query
        field, snapshot section, or coverage projection cannot be resolved
      when: |
        the error is returned to CLI, daemon, JSON, or web UI consumers
      then: |
        the response describes what failed, identifies the failed field or
        value when applicable, and includes recovery guidance such as checking
        refs, refreshing the workspace, or using an available read-only/static
        path
    - id: ac-linked-work-definition
      given: |
        any workspace page displays linked tasks, sessions, plans, reviews, or
        observations for a spec node or criterion
      when: |
        the backend computes those links
      then: |
        each link class has a documented inclusion rule, returns server-
        resolved titles/statuses/ages, and omits or degrades unavailable
        classes explicitly instead of letting the client infer relationships
        from raw entity scans
    - id: ac-static-readonly-projection
      given: |
        the web UI runs from a static export or other read-only context
      when: |
        the workspace renders
      then: |
        read projections render from the static snapshot when present,
        unavailable dynamic evidence or linked-work classes are labeled as
        unavailable, and mutation affordances are disabled or replaced with
        read-only guidance rather than pretending writes can occur
    - id: ac-cache-and-event-coherence
      given: |
        spec items, tasks, sessions, test-run ingestion, verification stamps,
        or coverage resolution mutations change workspace-visible data
      when: |
        the daemon broadcasts existing item/task/session/coverage events
      then: |
        workspace query keys are invalidated at the narrowest practical scope
        and the UI refreshes without polling or recomputing stale derived state
        locally
    - id: ac-error-boundaries
      given: |
        the workspace cannot resolve a node, criterion, child page, coverage
        projection, or linked-work class
      when: |
        the client receives the failure
      then: |
        it shows a scoped empty/error state with actionable guidance and keeps
        the rest of the workspace usable

# ─── Page+Tree Navigation ───

- title: Unified Spec Workspace Navigation
  slug: unified-spec-workspace-navigation
  type: feature
  parent: "@unified-spec-workspace-data-projection"
  depends_on:
    - "@ui-breadcrumb"
    - "@ui-view-header"
    - "@ui-shortcut-registry"
  description: |
    The `/specs` surface becomes a unified page+tree workspace. Every spec
    node can be expanded inline to inspect children in context, and every node
    including an acceptance criterion can be opened as a focused page with a
    stable URL. Row body activation expands; title/open activation navigates.
    Navigation uses SvelteKit `goto()` and reactive URL state, preserves
    expansion context across browser back/forward, and works without hover.
  acceptance_criteria:
    - id: ac-stable-node-urls
      given: |
        any spec item or acceptance criterion shown in the workspace
      when: |
        the user opens it as a page
      then: |
        the browser URL identifies that node or criterion directly, can be
        copied and reloaded, and restores the same focused workspace page
    - id: ac-existing-ref-links-compatible
      given: |
        an existing link points to `/specs?ref=<ref>` or a ReferenceLink uses
        the current spec route convention
      when: |
        the redesigned workspace handles the URL
      then: |
        it opens the matching node in the new workspace instead of regressing
        existing deep links
    - id: ac-dual-gesture-row
      given: |
        a workspace row with children
      when: |
        the user activates the row body
      then: |
        the row expands or collapses inline without navigating; activating the
        title, explicit open affordance, or keyboard open command navigates to
        the node page
    - id: ac-touch-and-keyboard-open
      given: |
        the user has no hover-capable pointer or uses keyboard-only input
      when: |
        they focus a row
      then: |
        both expand/collapse and open-page actions are visible or otherwise
        reachable with named controls and accessible labels
    - id: ac-expansion-state-preserved
      given: |
        the user expands several branches and then opens a node page
      when: |
        they return via browser back or workspace navigation
      then: |
        the previously expanded branches remain expanded, subject only to
        bounded-data eviction that is explicitly indicated to the user
    - id: ac-multi-branch-expansion
      given: |
        multiple independent branches exist in the spec tree
      when: |
        the user expands more than one branch
      then: |
        each branch remains open independently; expanding one branch does not
        collapse unrelated branches
    - id: ac-page-children-use-same-rows
      given: |
        a node page renders its child sections
      when: |
        children appear inside the page
      then: |
        they use the same row component, coverage tokens, expand behavior, and
        open-page affordances as the root tree
    - id: ac-no-horizontal-scroll
      given: |
        deeply nested paths, long titles, tags, or coverage summaries appear
        in the workspace
      when: |
        the viewport is at supported desktop and mobile widths
      then: |
        content wraps, truncates, collapses, or stacks without introducing
        page-level horizontal scrolling

# ─── Node and Criterion Pages ───

- title: Spec Node and Criterion Workspace Pages
  slug: spec-node-criterion-workspace-pages
  type: feature
  parent: "@unified-spec-workspace-navigation"
  depends_on:
    - "@unified-spec-workspace-data-projection"
    - "@ui-breadcrumb"
    - "@ui-view-header"
  description: |
    The workspace presents first-class pages for the root, every spec item
    node, and every acceptance criterion. Pages share breadcrumb and header
    primitives, show children in typed sections, keep linked work near the
    spec content, and render acceptance criteria as readable scenarios rather
    than hidden sheet accordions. This plan is a read/navigation plan: spec
    editing, add-AC flows, and broad spec CRUD are intentionally out of scope
    unless a later approved plan designs them.
  acceptance_criteria:
    - id: ac-root-page
      given: |
        the user opens `/specs` with no focused node
      when: |
        the workspace loads
      then: |
        it shows the root Specs page with corpus counts, project coverage
        summary, top-level rows, and no fake breadcrumb segment
    - id: ac-module-feature-requirement-pages
      given: |
        the user opens a module, feature, requirement, trait, or constraint
        page
      when: |
        the page renders
      then: |
        it shows the shared view header, breadcrumb, description, tags/traits
        where applicable, child sections appropriate to the node kind, and a
        linked-work strip or unavailable-state placeholder
    - id: ac-requirement-ac-list
      given: |
        a requirement has acceptance criteria
      when: |
        the requirement page renders
      then: |
        criteria appear as state-aware rows with AC ids, concise summaries,
        expandable G/W/T bodies, linked evidence indicators, and open-page
        affordances for each criterion
    - id: ac-criterion-page
      given: |
        the user opens a criterion page
      when: |
        its detail projection is available
      then: |
        the page shows the criterion scenario, parent requirement context,
        current coverage state and explanation, evidence summaries, siblings,
        and links back to related task/session/plan context
    - id: ac-linked-work-strip
      given: |
        linked work exists for a node or criterion
      when: |
        the workspace page renders its linked-work area
      then: |
        counts and entries are grouped by entity class, use ReferenceLink or
        equivalent stable navigation, and do not require opening a side sheet
        to discover implementation context
    - id: ac-empty-and-missing-sections
      given: |
        a node has no children, no acceptance criteria, no linked work, or a
        projection omits an unavailable class
      when: |
        the page renders
      then: |
        the section is omitted or displays a concise empty/unavailable state;
        blank panels and misleading zeroes are avoided
    - id: ac-read-navigation-scope
      given: |
        a user looks for editing actions such as add criterion, edit node
        text, reorder specs, or create child item
      when: |
        those actions are not designed by this plan
      then: |
        the workspace does not expose partial CRUD controls; any mention of
        editing directs to later planning or existing CLI workflows

# ─── Coverage State Consumer UI ───

- title: Spec Workspace Coverage State Presentation
  slug: spec-workspace-coverage-state-presentation
  type: requirement
  parent: "@spec-node-criterion-workspace-pages"
  depends_on:
    - "@coverage-state-presentation"
    - "@coverage-state-api-cache"
    - "@coverage-state-events"
  description: |
    The spec workspace is the first major UI consumer of the completed
    coverage-state engine. It presents coverage rollups, state pills, filters,
    re-verify banners, and evidence captions using one shared token and label
    system for the four API-facing presentation buckets. It never falls back to
    the legacy boolean AC `covered` scan when state data is available.
  acceptance_criteria:
    - id: ac-four-bucket-tokens
      given: |
        any coverage bucket is rendered in the spec workspace
      when: |
        the token is displayed in a row, header, rollup bar, filter chip,
        banner, or criterion page
      then: |
        covered, failing, not yet, and re-verify each use one consistent
        label/color/icon token, and backend secondary re-verify causes such as
        stale_spec_text, stale_annotation_or_mapping, stale_test_result, or
        unknown_freshness are translated into secondary explanation text under
        re-verify instead of top-level UI states
    - id: ac-rollup-bars
      given: |
        a node or root projection includes coverage bucket counts and a
        denominator
      when: |
        the workspace renders its header or row summary
      then: |
        it shows a segmented rollup or compact equivalent whose counts match
        the backend projection and whose denominator rules match the coverage
        state engine
    - id: ac-requirement-state-filter
      given: |
        a requirement page has criteria in more than one presentation bucket
      when: |
        the state filter strip renders
      then: |
        each filter chip shows backend counts, filtering changes only the
        visible criteria for that page, and a reset/all filter restores the
        original ordered list without refetching raw unrelated entities
    - id: ac-reverify-banner
      given: |
        a node or requirement projection has one or more re-verify criteria
      when: |
        the page renders
      then: |
        a scoped re-verify banner summarizes the count and cause classes and
        links to the Validate surface filtered to the same node or criterion
        when that filtered destination exists
    - id: ac-failing-dominates-visual-priority
      given: |
        a page or list contains failing and re-verify criteria
      when: |
        the workspace orders attention states
      then: |
        failing evidence is visually and semantically prioritized over
        re-verify, and not-yet remains visually distinct from work that needs
        immediate re-validation or repair
    - id: ac-no-legacy-covered-fallback
      given: |
        the backend coverage-state projection is ready for a project
      when: |
        the workspace renders AC state
      then: |
        it uses the projection's presentation bucket and explanation instead
        of the legacy acceptance-criterion boolean `covered` field or a fresh
        client annotation scan
    - id: ac-warming-and-unavailable-state
      given: |
        the coverage-state domain is warming, degraded, or unavailable in a
        static snapshot
      when: |
        the workspace renders coverage-dependent UI
      then: |
        it shows warming, retry, or unavailable indicators scoped to coverage
        state while preserving non-coverage spec navigation

# ─── Resolution Panels ───

- title: Spec Workspace Coverage Resolution Panels
  slug: spec-workspace-coverage-resolution-panels
  type: requirement
  parent: "@spec-workspace-coverage-state-presentation"
  depends_on:
    - "@coverage-resolution-mutation-interface"
    - "@explicit-coverage-reverification"
    - "@coverage-spec-text-revert"
    - "@coverage-dispatch-fix-request"
  description: |
    Criterion pages and inline re-verify contexts expose coverage resolution
    actions only when the current backend state says they are applicable. The
    UI previews and applies the existing resolution mutations — explicit
    re-verification, spec-text revert, and dispatch-fix request — without
    inventing a separate mutation path, test runner, or workspace-specific
    task creation flow.
  acceptance_criteria:
    - id: ac-resolution-visibility
      given: |
        a criterion is not currently in a state that supports a resolution
        action
      when: |
        the workspace renders its criterion page or inline panel
      then: |
        resolution controls are hidden or disabled with explanatory guidance
        instead of allowing a doomed mutation attempt
    - id: ac-dry-run-before-apply
      given: |
        the user activates any resolution action from the workspace
      when: |
        the action has side effects
      then: |
        the UI obtains and displays the existing dry-run preview before final
        confirmation, including expected stored effects and affected coverage
        scopes
    - id: ac-explicit-reverify-action
      given: |
        a criterion satisfies explicit re-verification preconditions
      when: |
        the user confirms the action
      then: |
        the UI calls the shared coverage resolution endpoint, records no local
        fake state, and refreshes from the coverage-state event or mutation
        response
    - id: ac-spec-text-revert-action
      given: |
        a criterion has a stale spec-text cause with a current revert preview
      when: |
        the user confirms revert
      then: |
        the UI submits the shared spec-text revert request with the expected
        current fingerprint and handles stale-target conflicts by refreshing
        and explaining that the criterion changed
    - id: ac-dispatch-fix-action
      given: |
        a criterion needs code or test repair
      when: |
        the user confirms dispatch fix
      then: |
        the UI submits the shared dispatch-fix request and presents the
        resulting task reference/status without spawning agents or composing
        task records in client code
    - id: ac-readonly-resolution-refusal
      given: |
        the workspace is running in static or read-only mode
      when: |
        a resolution panel would otherwise render actions
      then: |
        it presents the current state and disables mutations with read-only
        guidance; it does not offer confirmations that cannot be stored
    - id: ac-resolution-event-refresh
      given: |
        a resolution action succeeds through the workspace, CLI, or another
        daemon consumer
      when: |
        the coverage_state_changed event is received
      then: |
        the affected workspace pages, filters, rollups, and criterion panels
        invalidate and refresh consistently

# ─── Quality, Accessibility, and Static Mode ───

- title: Spec Workspace Delivery Quality
  slug: spec-workspace-delivery-quality
  type: requirement
  parent: "@unified-spec-workspace-navigation"
  depends_on:
    - "@ui-data-freshness"
    - "@ui-url-panel-state"
    - "@gh-pages-export"
  description: |
    The workspace ships as a production-quality SvelteKit surface that follows
    existing web UI conventions: Svelte 5 runes, TanStack query keys,
    centralized WebSocket invalidation, static-export degradation, URL changes
    through `goto()`, component-level tests for stateful behavior, and browser
    proof for the vertical workflow. It must replace the current tree + sheet
    experience without leaving a preview-only half surface.
  acceptance_criteria:
    - id: ac-svelte-and-query-conventions
      given: |
        workspace route, component, store, and API-client code is added
      when: |
        it is reviewed
      then: |
        it uses existing Svelte 5, TanStack query wrapper, query-key factory,
        api/api-static split, and design-system conventions rather than
        introducing parallel data or style frameworks
    - id: ac-url-state-via-goto
      given: |
        workspace interactions change focused node, criterion, filter, or
        expansion state represented in the URL
      when: |
        code updates the URL
      then: |
        it uses SvelteKit `goto()` or link navigation so `$page.url` stays
        reactive; direct history mutation is not used
    - id: ac-static-export-build
      given: |
        the web UI is built for static export
      when: |
        the workspace route is included in the export
      then: |
        it renders read-only data from the snapshot when available, avoids
        daemon-only write attempts, and keeps existing static docs/spec links
        valid
    - id: ac-keyboard-and-screenreader
      given: |
        a user navigates the workspace with keyboard or assistive technology
      when: |
        they move through rows, breadcrumbs, filters, banners, and resolution
        panels
      then: |
        focus order, names, expanded states, selected states, and action
        labels are perceivable and operable without hover
    - id: ac-browser-proof
      given: |
        the implementation is ready for review
      when: |
        it is verified in a browser against a live daemon project
      then: |
        the proof covers root tree navigation, opening a node page, opening an
        AC page, filtering by state, following linked work, static/read-only or
        disabled mutation behavior, and no horizontal-scroll regression
    - id: ac-test-coverage
      given: |
        the workspace implementation lands
      when: |
        project gates run
      then: |
        focused tests cover route URL restoration, dual-gesture row behavior,
        projection API client/static fallback, coverage event invalidation,
        resolution preview/apply flows, and accessibility-critical keyboard
        interactions
    - id: ac-existing-specs-route-replaced
      given: |
        the new workspace is complete enough to ship
      when: |
        `/specs` is opened
      then: |
        users see the unified workspace as the primary surface, and the old
        sheet-only detail experience is removed, reused only as internal code
        where still appropriate, or explicitly redirected
```

## Tasks

derive_from_specs: false

```yaml
- title: Build unified spec workspace projection API
  slug: task-unified-spec-workspace-projection-api
  priority: 1
  tags: [web-ui, daemon, api, specs, coverage]
  spec_ref: "@unified-spec-workspace-data-projection"
  description: |
    What:
    - Add the backend/shared/static projection needed by the unified spec workspace.
    - Define shared response types for root workspace, node detail, child-row summaries,
      criterion detail, linked-work counts, and unavailable dynamic sections.
    - Reuse existing item detail ancestry, coverage-state read model, task/session/plan
      reference resolution, response envelopes, and cache warming semantics.
    - Provide bounded child expansion and count/continuation metadata rather than having
      the client derive workspace state from an unbounded `fetchItems()` list.
    - Include static snapshot/read-only behavior: workspace read projections render when
      present; dynamic evidence classes clearly report unavailable when absent.
    - Do not recreate the coverage engine, the coverage resolution service, or the
      breadcrumb resolver.

    Why:
    The current `/specs` route fetches a flat item list and opens detail in a sheet. The
    redesign requires stable node/AC pages, rollups, linked work, and evidence without
    pushing joins into the browser.

    How:
    - Inspect existing `packages/daemon/src/routes/items.ts`, coverage routes, shared API
      types, query keys, and `api-static.ts` before choosing the exact endpoint shape.
    - Prefer a small family under an existing daemon route namespace if that matches
      project conventions; otherwise document the new namespace clearly.
    - Preserve envelope, cache-warming, `X-Kspec-Dir`, and structured error conventions.
    - Use backend-resolved refs/titles/statuses for linked work.
    - Ensure coverage values come from `getCachedCoverageStateReadModel`/existing route
      helpers, not from a fresh legacy covered-boolean scan.
    - Cover inherited API/error trait behavior for the new read endpoints. Explicitly
      document that shadow-commit behavior is not applicable to read-only projection
      endpoints, while mutation behavior remains owned by the existing coverage
      resolution endpoints consumed later in this plan.

    Testing:
    - Focused daemon/shared tests for root projection, node detail, criterion detail,
      coverage summary integration, linked-work counts, missing-node/criterion errors,
      static fallback, and cache-warming responses.
    - npm run typecheck
    - kspec validate --refs --warnings-ok

    Covers: @unified-spec-workspace-data-projection ac-bounded-root-projection,
      ac-node-detail-projection, ac-ac-detail-projection, ac-coverage-source-of-truth,
      ac-endpoint-contract, ac-read-endpoints-do-not-commit, ac-error-guidance-contract,
      ac-linked-work-definition, ac-static-readonly-projection, ac-cache-and-event-coherence,
      ac-error-boundaries; @trait-api-endpoint ac-1, ac-2, ac-3, ac-4, ac-6;
      @trait-api-endpoint ac-5 (not applicable to read-only projection endpoints);
      @trait-error-guidance ac-1, ac-2, ac-3, ac-5, ac-6;
      @trait-error-guidance ac-4 (not applicable: projection reads do not perform
      state transitions)

- title: Replace specs route with page-tree workspace shell
  slug: task-unified-spec-workspace-shell-navigation
  priority: 1
  tags: [web-ui, specs, navigation, accessibility]
  spec_ref: "@unified-spec-workspace-navigation"
  depends_on:
    - "@task-unified-spec-workspace-projection-api"
  description: |
    What:
    - Replace the current `/specs` tree + side-sheet route with the unified workspace shell.
    - Introduce stable focused-node and focused-criterion URLs while preserving existing
      `/specs?ref=` deep-link compatibility.
    - Implement the dual-gesture row model: row/body expands inline; title/open control
      navigates to the page.
    - Preserve expansion state across open/back navigation and allow independent branches.
    - Ensure touch and keyboard users can both expand and open nodes without relying on
      hover-only controls.
    - Use `goto()`/links for URL state; do not use direct history APIs.

    Why:
    This is the plan's core UX shift: specs become a real workspace rather than a flat
    tree with a modal/sheet detail panel.

    How:
    - Reuse existing design-system primitives and the breadcrumb/view-header components
      from the foundations plan.
    - Keep expansion state bounded and project-scoped. If state is persisted outside the
      URL, make reload/back behavior explicit and tested.
    - Avoid page-level horizontal scrolling in deep trees; use truncation/collapse/stacking.
    - Remove or adapt `ItemTree`/`ItemDetail` only after the new route covers their current
      read/navigation behavior.

    Testing:
    - Component/route tests for URL compatibility, reload restoration, browser back,
      independent branch expansion, keyboard/touch open controls, and no horizontal-scroll
      regression at supported widths.
    - npm run typecheck

    Covers: @unified-spec-workspace-navigation ac-stable-node-urls,
      ac-existing-ref-links-compatible, ac-dual-gesture-row, ac-touch-and-keyboard-open,
      ac-expansion-state-preserved, ac-multi-branch-expansion, ac-page-children-use-same-rows,
      ac-no-horizontal-scroll; @spec-workspace-delivery-quality ac-url-state-via-goto

- title: Implement spec node and criterion workspace pages
  slug: task-spec-node-criterion-workspace-pages
  priority: 1
  tags: [web-ui, specs, linked-work]
  spec_ref: "@spec-node-criterion-workspace-pages"
  depends_on:
    - "@task-unified-spec-workspace-shell-navigation"
  description: |
    What:
    - Implement the root, node, requirement, and acceptance-criterion page bodies.
    - Render shared view headers, breadcrumbs, descriptions, tags/traits, child sections,
      acceptance criteria, linked-work strips, evidence summaries, and sibling navigation.
    - Make criteria readable as scenario content with G/W/T blocks and focused AC pages.
    - Keep this plan read/navigation scoped: do not add spec edit/add/reorder controls.
    - Provide clear empty/unavailable states for missing child, linked-work, or evidence
      sections.

    Why:
    The workspace must be usable as a vertical workflow, not a preview-only shell. Users
    should be able to move from corpus overview to a requirement to a criterion and then
    to related work without losing context.

    How:
    - Reuse ReferenceLink, RelatedSessionsSection patterns where they fit, but avoid sheet
      dependence for primary discovery.
    - Keep linked-work inclusion rules aligned with the projection API task; do not add
      client-side scans to fill gaps.
    - Treat constraints/traits generically based on current item types; do not hard-code
      Kynetic module names or source paths.

    Testing:
    - Route/component tests for root page, node page, requirement AC list, criterion page,
      linked-work groups, empty sections, and no-CRUD controls.
    - Browser proof through root → node → criterion → linked task/session/plan navigation.

    Covers: @spec-node-criterion-workspace-pages ac-root-page,
      ac-module-feature-requirement-pages, ac-requirement-ac-list, ac-criterion-page,
      ac-linked-work-strip, ac-empty-and-missing-sections, ac-read-navigation-scope

- title: Add coverage state presentation to the workspace
  slug: task-spec-workspace-coverage-presentation
  priority: 1
  tags: [web-ui, coverage, specs]
  spec_ref: "@spec-workspace-coverage-state-presentation"
  depends_on:
    - "@task-spec-node-criterion-workspace-pages"
  description: |
    What:
    - Add shared workspace coverage tokens, row/header rollups, state pills, requirement
      filter chips, and re-verify banners backed by the projection API.
    - Use the current four presentation buckets: covered, failing, not yet, re-verify.
    - Use secondary re-verify causes only for captions/details; do not resurrect the old
      six-state UI as a separate top-level model.
    - Ensure coverage_state_changed events invalidate the workspace coverage queries.
    - Remove or bypass legacy boolean `covered` display when the coverage-state projection
      is ready.

    Why:
    This is the first real UI consumer of the completed coverage-state engine and must
    prove that the foundational backend work drives a coherent spec-reading workflow.

    How:
    - Build on existing `queryKeys.coverage`, `ws-invalidation.ts`, coverage API client
      helpers, and design-system status tokens.
    - Keep filters local to the current projected page or request an explicit scoped
      projection; do not fetch unrelated raw lists to filter.
    - Make warming/degraded coverage state visible without blocking non-coverage navigation.

    Testing:
    - Tests for four-bucket rendering, rollup count accuracy, requirement filter behavior,
      re-verify banner links, failing-vs-reverify priority, coverage warming/degraded UI,
      and coverage event invalidation.
    - npm run typecheck

    Covers: @spec-workspace-coverage-state-presentation ac-four-bucket-tokens,
      ac-rollup-bars, ac-requirement-state-filter, ac-reverify-banner,
      ac-failing-dominates-visual-priority, ac-no-legacy-covered-fallback,
      ac-warming-and-unavailable-state; @unified-spec-workspace-data-projection
      ac-coverage-source-of-truth, ac-cache-and-event-coherence

- title: Integrate coverage resolution panels
  slug: task-spec-workspace-resolution-panels
  priority: 1
  tags: [web-ui, coverage, mutations, specs]
  spec_ref: "@spec-workspace-coverage-resolution-panels"
  depends_on:
    - "@task-spec-workspace-coverage-presentation"
  description: |
    What:
    - Add criterion-page and inline re-verify resolution panels that call the shared
      coverage resolution mutation API.
    - Support dry-run preview before side effects for explicit re-verify, spec-text
      revert, and dispatch-fix request.
    - Hide or disable actions when current state/preconditions do not support them.
    - Handle read-only/static mode, stale fingerprint conflicts, precondition failures,
      and successful event-driven refresh.
    - Present created/updated task refs from dispatch-fix responses; do not spawn agents
      or build task records in client code.

    Why:
    P1c closed the backend action loop. The spec workspace should expose that loop where
    users encounter stale/re-verify criterion state.

    How:
    - Reuse existing coverage resolution request/response schemas and API client helpers.
    - Keep confirmation copy specific about what will be stored.
    - Prefer existing dialog/button primitives and structured error components.
    - Verify that mutation success is reflected by backend events/query invalidation, not
      by optimistic local invention of coverage state.

    Testing:
    - Tests for action visibility, dry-run previews, successful apply refresh,
      stale-target conflict refresh/guidance, read-only refusal, and dispatch-fix task-ref
      presentation.
    - Focused daemon/web UI tests around the coverage resolution API client if needed.

    Covers: @spec-workspace-coverage-resolution-panels ac-resolution-visibility,
      ac-dry-run-before-apply, ac-explicit-reverify-action, ac-spec-text-revert-action,
      ac-dispatch-fix-action, ac-readonly-resolution-refusal, ac-resolution-event-refresh

- title: Verify workspace quality, static mode, and browser workflow
  slug: task-spec-workspace-quality-verification
  priority: 1
  tags: [web-ui, tests, accessibility, static]
  spec_ref: "@spec-workspace-delivery-quality"
  depends_on:
    - "@task-spec-workspace-resolution-panels"
  description: |
    What:
    - Complete the focused test/a11y/static/browser verification pass for the unified spec
      workspace.
    - Add or update tests that prove route restoration, row interaction, projection client
      behavior, static fallback, event invalidation, resolution panels, keyboard operation,
      and no horizontal-scroll regression.
    - Browser-prove the vertical workflow against a live daemon project: root tree → node
      page → requirement/AC page → state filter → linked work → resolution disabled or
      preview path.
    - Run the project's normal web UI and kspec gates.

    Why:
    This plan should ship the first major redesign UI surface, not a partial demo. The
    final task ensures it matches project conventions and can safely replace the old
    `/specs` surface.

    How:
    - Use existing test runner commands and project-local work-gate conventions.
    - Include screenshots or logs as task resources/notes when browser proof is manual.
    - If any spec-workspace behavior cannot be completed because an upstream API/design
      decision is missing, block with the exact missing contract instead of silently
      shipping a preview-only half.

    Testing:
    - npm run format:check
    - npm run lint -- --quiet
    - npm run typecheck
    - focused workspace/unit tests
    - npm test, or documented shard/focused evidence plus rationale if the full suite is
      not practical in the worker environment
    - kspec validate --refs --alignment --completeness --warnings-ok
    - browser proof using the live daemon/web UI

    Covers: @spec-workspace-delivery-quality ac-svelte-and-query-conventions,
      ac-url-state-via-goto, ac-static-export-build, ac-keyboard-and-screenreader,
      ac-browser-proof, ac-test-coverage, ac-existing-specs-route-replaced
```

## Implementation Notes

### Scope boundaries

- In scope: replacing `/specs` with a navigable page+tree workspace, stable node/AC
  URLs, coverage-state rollups and filters, linked-work/evidence discovery, and
  coverage resolution panels backed by the existing mutation endpoints.
- Out of scope: spec editing, add/reorder/delete spec controls, Validate queue/matrix
  redesign, cross-project dashboard behavior, and a new coverage-state computation model.
- The workspace should use the completed four-bucket coverage presentation from the
  coverage-state engine. Design handoff references to six visual states should be mapped
  to four UI buckets plus secondary re-verify causes unless a later approved decision
  changes the global coverage vocabulary.

### Existing surfaces to reuse or replace carefully

- Current `/specs` fetches a flat item list and renders `ItemTree` plus `ItemDetail` in a
  sheet. Reuse pieces only if they fit the new routed workspace; do not preserve the sheet
  as the primary detail UX.
- Breadcrumb ancestry, view header/status tokens, coverage-state query keys, coverage
  invalidation events, and coverage resolution endpoints already exist from foundation
  plans and should be consumed rather than rebuilt.
- Existing `ReferenceLink` destinations that target `/specs?ref=` must keep working.

### Review checklist for this plan

- Does every UI requirement consume the backend coverage/read projection instead of doing
  client-side raw-list joins?
- Are static/read-only and cache-warming states specified for all dynamic parts?
- Is hover-only behavior paired with keyboard/touch equivalents?
- Is the plan explicit that spec CRUD is not in scope?
- Are the tasks sequenced so backend projection work lands before UI consumers?
- Is the plan project-neutral and suitable for arbitrary kspec projects rather than tuned
  to kynetic-spec's own spec tree?
