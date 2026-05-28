# UI Data Layer Rework

Rework the web UI → daemon data layer to eliminate per-page independent
fetching, client-side joins, and unbounded entity list fetches. The daemon
API resolves references and provides aggregations server-side. The web UI
maintains a shared reactive cache with WebSocket-driven invalidation.

**Technology choice:** @tanstack/svelte-query v6 — Svelte 5 runes-native
(~13 kB gzip), provides automatic caching, request deduplication,
stale-while-revalidate, and background revalidation. WebSocket events
integrate via queryClient.invalidateQueries() and setQueryData().

## Specs

```yaml
- title: API Reference Resolution
  slug: ui-api-ref-resolution
  type: feature
  description: |
    The daemon API resolves entity references to display-ready metadata so
    consumers can render human-readable titles, statuses, and types without
    separate lookups. This applies both inline (fields within existing
    responses) and via a dedicated lightweight index endpoint for arbitrary
    resolution.

  traits:
    - trait-api-endpoint
  acceptance_criteria:
    - id: ac-1
      given: |
        An API response includes a single-valued reference to another entity
        (task_ref, task_id, spec_ref, plan_ref)
      when: |
        The response is serialized
      then: |
        A corresponding title field is included alongside the ref, resolved
        against loaded entity data. Null if the ref cannot be resolved.
    - id: ac-2
      given: |
        An API response includes an array of references to other entities
        (depends_on, blocked_by, evidence_refs, derived_specs, derived_tasks)
      when: |
        The response is serialized
      then: |
        Each entry includes the resolved title and current status alongside
        the ref string.
    - id: ac-3
      given: |
        A referenced entity has been deleted or the ref is invalid
      when: |
        The API attempts resolution
      then: |
        The title field is null and the raw ref is preserved. The response
        does not fail or omit the entry.
    - id: ac-4
      given: |
        A consumer needs to resolve an arbitrary set of refs to display
        metadata (e.g., rendering refs in markdown, cross-entity link previews)
      when: |
        A lightweight index endpoint is called
      then: |
        Returns a map of all resolvable refs (tasks, items, traits) with
        title, type, and status. Both ULID and slug keys are included
        for each entity.
    - id: ac-5
      given: |
        The project has 1000+ entities
      when: |
        The index endpoint is called
      then: |
        The response payload is significantly smaller than fetching full
        entity lists because it only includes display metadata.

- title: API Aggregation and Enriched Events
  slug: ui-api-aggregation
  type: feature
  description: |
    The daemon provides pre-computed aggregations and enriched event payloads
    so consumers do not need to fetch full entity lists to compute derived
    data. This covers both HTTP endpoints for summary statistics and WebSocket
    broadcast events that include enough context for in-place UI updates.

  traits:
    - trait-api-endpoint
    - trait-websocket-protocol
  acceptance_criteria:
    - id: ac-1
      given: |
        A consumer needs entity counts grouped by status
      when: |
        A summary endpoint is called
      then: |
        Returns pre-computed counts by status with dependency-aware
        distinctions (e.g., ready vs blocked by incomplete dependencies).
    - id: ac-2
      given: |
        A consumer needs validation coverage statistics
      when: |
        The validation or alignment endpoint is called
      then: |
        The response includes entity counts, acceptance criteria counts,
        and orphaned entity counts as pre-computed fields.
    - id: ac-3
      given: |
        A consumer needs inbox items with their triage status
      when: |
        A merged endpoint is called
      then: |
        Returns inbox items with inline triage status in a single response.
    - id: ac-4
      given: |
        An entity changes (task status, inbox item created, etc.)
      when: |
        A WebSocket broadcast event is sent
      then: |
        The payload includes the entity's display title and both old and
        new state where applicable, in addition to the existing ref and
        action fields.
- title: UI Data Freshness and Caching
  slug: ui-data-freshness
  type: feature
  description: |
    The web UI maintains a shared, reactive data cache that provides instant
    page transitions, request deduplication, and real-time updates without
    per-page independent fetching. Data fetched by one page is available to
    all pages. Real-time events drive cache invalidation. The UI degrades
    gracefully when the daemon is unreachable and supports read-only static
    mode for exported snapshots.

  acceptance_criteria:
    - id: ac-1
      given: |
        A page fetches data on first visit
      when: |
        The user navigates away and returns to the same page
      then: |
        The page renders immediately from cached data without a loading
        state, then revalidates in the background if the data is stale.
    - id: ac-2
      given: |
        Two or more pages or components need the same data concurrently
      when: |
        Both are active at the same time
      then: |
        Only one HTTP request is made. Both consumers share the result.
    - id: ac-3
      given: |
        A WebSocket broadcast event indicates data has changed
      when: |
        The event is processed by the UI
      then: |
        Cached data for the affected entity type is invalidated and
        active views revalidate in the background. If the broadcast
        includes sufficient enriched data, the cache is updated
        immediately without a server round-trip.
    - id: ac-4
      given: |
        The UI needs periodic status data (badge counts, agent status)
      when: |
        The data changes on the server
      then: |
        The data is served from cache and kept current via event-driven
        invalidation rather than timer-based polling.
    - id: ac-5
      given: |
        The user switches projects in the multi-directory daemon
      when: |
        The project context changes
      then: |
        All cached data is discarded. Subsequent data requests fetch
        fresh data for the new project.
    - id: ac-6
      given: |
        The app is running in static mode (exported snapshot)
      when: |
        A data request is made
      then: |
        The request is served from the static data source. No daemon
        HTTP calls are attempted.
    - id: ac-7
      given: |
        The daemon is unreachable or returns an error
      when: |
        A data request fails
      then: |
        The error is surfaced with appropriate messaging (e.g., daemon
        not running vs data error). Retry behavior is appropriate for
        localhost (minimal retries, short delay).
    - id: ac-8
      given: |
        A write operation is performed (start task, add note, etc.)
      when: |
        The operation succeeds
      then: |
        Related cached data is invalidated so the originating client
        updates immediately without waiting for a broadcast.
```

## Tasks

derive_from_specs: false

```yaml
- title: Create UI data layer skill for Svelte + TanStack Query patterns
  slug: task-ui-data-layer-skill
  priority: 1
  tags:
    - docs
    - web-ui
  implementation_notes: |
    Create a kspec skill (.kspec/skills/ui-data-layer/SKILL.md) that documents
    the data fetching patterns and conventions for the web UI. This skill is
    the reference for all agents working on UI data layer tasks.

    CRITICAL: The agent MUST research the actual TanStack Query v6 Svelte
    documentation online before writing this skill. Do NOT fabricate API
    signatures, configuration options, or patterns from memory. Fetch and
    reference the real docs:
    - https://tanstack.com/query/latest/docs/framework/svelte/overview
    - https://tanstack.com/query/latest/docs/framework/svelte/migrate-from-v5-to-v6
    - @tanstack/svelte-query npm package README
    - Any Svelte 5 runes-specific examples in the official docs

    Include URLs as references in the skill where patterns come from
    external documentation.

    Content to cover:
    - TanStack Query v6 setup and conventions for this project
    - Query key naming conventions and factory patterns
    - WebSocket → query invalidation wiring pattern
    - How to create a new query (step by step with example)
    - How to create a mutation with invalidation
    - Ref index usage for title resolution
    - Cache timing conventions (staleTime, gcTime recommendations)
    - Project switch cache clearing
    - Static mode compatibility (query factories must wrap isStaticMode dispatch)
    - Error handling and retry config for localhost daemon
    - Migration guide: converting a page from manual fetch to queries
    - Testing patterns (QueryClientProvider wrapper, mock queryFn)
    - Anti-patterns to avoid (manual fetch + $state for API data,
      fetchTasks for title lookup, unbounded limit fetches, polling intervals)
    - Boundary: WebSocket streaming (agent text chunks) stays outside TanStack
      Query — only request-response data goes through queries
    - Sessions infinite scroll uses createInfiniteQuery, not createQuery

    The existing svelte-5 skill covers reactivity patterns and gotchas.
    This new skill covers the data layer specifically.

    After creating, add to .kspec/skills/ and run kspec skill render.

- title: Install TanStack Query, set up provider, and migrate dashboard as proof
  slug: task-tanstack-setup
  priority: 1
  tags:
    - web-ui
    - infra
  implementation_notes: |
    Install @tanstack/svelte-query v6 (requires Svelte >= 5.25.0).

    Part 1 — Infrastructure:
    1. npm install @tanstack/svelte-query
    2. Create query client factory with default config including:
       - staleTime appropriate for localhost daemon (e.g., 30s for lists, 5m for ref index)
       - Retry config for localhost (minimal retries, short delay)
       - gcTime for session-length caching
    3. Add QueryClientProvider to root layout
    4. Create query key factories directory with initial factories
    5. Wire WebSocket connection store to queryClient.invalidateQueries()
       mapping broadcast topics to query key filters
    6. Wire project switch to queryClient.clear()
    7. Ensure static mode compatibility (query factories check isStaticMode)

    Part 2 — Dashboard migration as proving ground:
    Migrate the dashboard (+page.svelte) from manual fetch to TanStack Query.
    The dashboard is ideal because it touches multiple data sources (tasks,
    inbox, observations, agent status, validation) and currently makes 5+
    parallel API calls including fetchTasks({limit: 1000}). Migrating it
    proves the full pattern: query factories, WebSocket invalidation wiring,
    cache-then-revalidate navigation, static mode compatibility, and error
    handling.

    This establishes the concrete patterns that all subsequent migration
    tasks follow. The query factories, WebSocket wiring, and conventions
    created here become the foundation — later tasks just add more queries
    using the same patterns.

    Acceptance gates (from @ui-data-freshness):
    - Dashboard renders from cache on revisit without loading state (ac-1)
    - WebSocket events invalidate dashboard queries, no full re-fetch (ac-3)
    - Static mode works without daemon calls (ac-6)
    - Daemon-unreachable shows appropriate error, not infinite loading (ac-7)
    - Write operations (if any on dashboard) invalidate related cache (ac-8)
  depends_on:
    - "@task-ui-data-layer-skill"

- title: Add server-side title resolution to API responses
  slug: task-server-resolve
  priority: 1
  tags:
    - daemon
    - web-ui
  implementation_notes: |
    The daemon already loads task/item data via ReferenceIndex on most routes.
    Add resolved title fields alongside existing ref fields.

    Endpoints to update:
    - GET /api/agent/status → active_invocations need task_title
    - GET /api/sessions → session summaries need task_title
    - GET /api/sessions/:id → session detail needs task_title
    - GET /api/tasks → task summaries need spec_title alongside spec_ref
    - GET /api/tasks/:ref → task detail needs spec_title, resolved depends_on
      and blocked_by entries with titles and status
    - Triage records → evidence_refs need resolved titles

    Add response types to @kynetic-ai/shared package for type safety.

    Acceptance gates (from @ui-api-ref-resolution):
    - Single-valued refs include resolved title (ac-1)
    - Array refs include resolved title and status per entry (ac-2)
    - Invalid/deleted refs return null title, preserve raw ref (ac-3)

- title: Implement ref index endpoint
  slug: task-ref-index-endpoint
  priority: 1
  tags:
    - daemon
  implementation_notes: |
    Add GET /api/refs/index returning a lightweight ref-to-display-metadata
    map. Include tasks, items, and traits. Return title, type, and status
    for each. Key by both ULID and slug.

    Omit descriptions, notes, ACs, tags, and other heavyweight fields.
    Must respect X-Kspec-Dir project scoping.
    Add response type to @kynetic-ai/shared package.

    Acceptance gates (from @ui-api-ref-resolution):
    - Returns map with title, type, status per ref (ac-4)
    - Payload significantly smaller than full entity lists (ac-5)

- title: Add server-side aggregation endpoints
  slug: task-server-aggregation
  priority: 2
  tags:
    - daemon
  implementation_notes: |
    Three independent endpoints. Can be implemented incrementally.

    1. Task status summary:
       - Endpoint returning counts by status with dependency-aware
         ready vs blocked distinction.

    2. Validation/alignment stats:
       - Extend validation/alignment response to include entity counts,
         AC counts, and orphan counts as pre-computed fields. Eliminates
         the fragile pattern of parsing free-text warning detail strings
         with regex for AC coverage calculation.

    3. Inbox/triage merge:
       - Merged endpoint returning inbox items with inline triage status,
         eliminating the need for separate fetches and client-side joins.

    Add response types to @kynetic-ai/shared package.
    Each must respect X-Kspec-Dir project scoping.

    Acceptance gates (from @ui-api-aggregation):
    - Status counts with dependency-aware distinctions (ac-1)
    - Coverage stats as pre-computed fields (ac-2)
    - Inbox items with inline triage status (ac-3)

- title: Enrich WebSocket broadcast payloads
  slug: task-ws-enrichment
  priority: 2
  tags:
    - daemon
    - websocket
  implementation_notes: |
    Update broadcast calls in daemon routes to include display-ready data.
    The entities are already loaded at broadcast time.

    task_updated: add title, include both old and new status.
    agent_invocation: add task_title alongside task_id.
    agent_text_chunk: add task_title.
    inbox_item_created: include full item data (already partially done).

    Update shared BroadcastEvent types in @kynetic-ai/shared.

    Acceptance gates (from @ui-api-aggregation):
    - Broadcasts include display title and old/new state (ac-4)

- title: Migrate core pages to TanStack Query (agents, sessions, settings)
  slug: task-migrate-core-pages
  priority: 2
  tags:
    - web-ui
  implementation_notes: |
    Migrate the simplest pages first — ones that primarily need server-resolved
    titles and don't have complex state.

    Pages in scope:
    1. agents/+page.svelte — use server-resolved task_title on invocations,
       replace fetchTasks({limit:1000}) with query for agent status
    2. sessions/+page.svelte — use server-resolved task_title from response,
       convert infinite scroll to createInfiniteQuery, remove fetchTasks
    3. sessions/[id]/+page.svelte — use server-resolved task_title,
       remove resolveTaskTitle() function and its fetchTasks call.
       Note: agent text streaming stays outside TanStack Query.
    4. settings/+page.svelte — convert 4 fetch calls to queries, replace
       files:updates full-reload with targeted query invalidation
    5. workflows/+page.svelte — simple query migration
    6. observations/+page.svelte — simple query migration

    For each page: replace manual fetch/$state/$effect/WS reload with queries.
    Preserve @ui-url-panel-state AC annotations where URL state is used.
    Remove old WebSocket reload handlers as pages are migrated.

    Acceptance gates (from @ui-data-freshness):
    - Each page renders from cache on revisit (ac-1)
    - Concurrent requests deduplicated (ac-2)
    - WS events invalidate, not full re-fetch (ac-3)
  depends_on:
    - "@task-tanstack-setup"
    - "@task-server-resolve"

- title: Migrate sidebar to TanStack Query and eliminate polling
  slug: task-migrate-sidebar
  priority: 2
  tags:
    - web-ui
  implementation_notes: |
    The sidebar currently polls 4 endpoints every 30 seconds for badge counts.
    This is one of the most impactful migrations because it affects every page.

    Replace setInterval(loadCounts, 30000) with TanStack Query:
    - Inbox count query (invalidated by inbox:updates WS events)
    - Observations count query (invalidated by relevant WS events)
    - Pending review count query (invalidated by tasks:updates WS events)
    - Session context query

    After migration, remove the 30s polling interval entirely.

    Acceptance gates (from @ui-data-freshness):
    - Badge counts served from cache, invalidated by WS events (ac-4)
    - No polling interval remains (ac-4)
  depends_on:
    - "@task-tanstack-setup"

- title: Migrate complex pages to TanStack Query (tasks, board, specs, plans, validate)
  slug: task-migrate-complex-pages
  priority: 2
  tags:
    - web-ui
  implementation_notes: |
    These pages have more complex data needs — aggregation, filtering,
    multiple related queries, or detail panels.

    Pages in scope (dashboard already migrated in task-tanstack-setup):
    1. tasks/+page.svelte — paginated query with filter params in key,
       task detail panel as separate query, spec_ref uses server-resolved title
    2. tasks/board/+page.svelte — all-tasks query for columns, agent status
       query (replace 5s polling interval). Active Fleet streaming stays
       outside TanStack Query. Spec refs use server-resolved titles.
    3. specs/+page.svelte — items query, detail query (3 parallel calls could
       be reduced), caching eliminates re-fetch on re-select
    4. plans/+page.svelte — plans query, lazy content query with caching.
       Convert filter from local state to URL params for consistency.
    5. validate/+page.svelte — validation query with server-computed stats
       (after server aggregation), remove fetchItems/fetchTasks

    Acceptance gates (from @ui-data-freshness):
    - Each page renders from cache on revisit (ac-1)
    - Board agent status served from cache, not 5s polling (ac-4)
    - WS events invalidate, not full re-fetch (ac-3)
    - Project switch clears all cache (ac-5)
  depends_on:
    - "@task-tanstack-setup"
    - "@task-server-resolve"
    - "@task-server-aggregation"

- title: Migrate inbox and triage pages to TanStack Query
  slug: task-migrate-inbox-triage
  priority: 2
  tags:
    - web-ui
  implementation_notes: |
    These pages share the same client-side join pattern (inbox + triage records)
    and should be migrated together using the merged endpoint.

    Pages in scope:
    1. inbox/+page.svelte — use merged inbox endpoint (after server aggregation),
       remove separate fetchTriageRecords call and O(n*m) client join.
       Triage evidence_refs should use ref index for title resolution.
    2. triage/+page.svelte — same merged endpoint, card-by-card navigation
       stays as-is but data source changes.

    Both pages subscribe to inbox:updates and triage:updates — after migration,
    WS events invalidate the merged inbox query instead of triggering full reload.

    Acceptance gates (from @ui-data-freshness + @ui-api-aggregation):
    - Inbox items include inline triage status, no client join (aggregation ac-3)
    - WS events invalidate, not full re-fetch (freshness ac-3)
  depends_on:
    - "@task-tanstack-setup"
    - "@task-server-aggregation"
    - "@task-ref-index-endpoint"

- title: Clean up legacy fetch infrastructure
  slug: task-cleanup-legacy-fetches
  priority: 3
  tags:
    - web-ui
  implementation_notes: |
    After all pages are migrated to TanStack Query, remove dead code:
    - Unused fetch functions from api.ts (fetchTasks-for-titles pattern)
    - Per-page taskTitles lookup map construction
    - Sidebar polling interval (setInterval)
    - Board agent status polling interval
    - Manual loading/error $state variables replaced by query states
    - Old WebSocket reload handlers (loadAll, loadData patterns)

    Grep for "limit: 999" and "limit: 1000" to verify none remain.
    Grep for "setInterval" to verify no polling remains.
    Verify static mode still works end-to-end.

    Acceptance gates (from @ui-data-freshness):
    - No polling intervals remain (ac-4)
    - Static mode works end-to-end (ac-6)
  depends_on:
    - "@task-migrate-core-pages"
    - "@task-migrate-sidebar"
    - "@task-migrate-complex-pages"
    - "@task-migrate-inbox-triage"
```

