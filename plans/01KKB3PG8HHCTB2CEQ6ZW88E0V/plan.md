# Session Explorer: Unified Session Browsing & Filtering

## Specs

```yaml
- title: Session List Pagination API
  slug: session-list-pagination-api
  type: requirement
  parent: "@api-contract"
  description: |
    Add offset/limit pagination and multi-field filtering to the daemon
    GET /api/sessions endpoint. Currently returns all sessions unsorted
    with no pagination. With 700+ sessions this is too slow. Follow the
    existing task list API pattern (offset, limit, total in response).
  traits:
    - "@trait-api-endpoint"
    - "@trait-filterable-list"
  acceptance_criteria:
    - id: ac-pagination
      given: |
        The daemon is running with 700+ sessions on disk
      when: |
        GET /api/sessions?offset=0&limit=25 is called
      then: |
        Response includes items (max 25), total count, offset, and limit fields.
        Items are sorted by started_at descending (most recent first).
    - id: ac-filter-status
      given: |
        Sessions exist with various statuses (active, completed, failed, abandoned, timed_out)
      when: |
        GET /api/sessions?status=completed&status=failed is called
      then: |
        Only sessions matching the specified statuses are returned.
        Multiple status values are OR'd together.
    - id: ac-filter-agent-type
      given: |
        Sessions exist from different agent types (claude-agent-acp, codex-acp, etc.)
      when: |
        GET /api/sessions?agent_type=claude-agent-acp is called
      then: |
        Only sessions with matching agent_type are returned
    - id: ac-filter-agent-id
      given: |
        Sessions exist with different agent_id values (worker, pr-reviewer, etc.)
      when: |
        GET /api/sessions?agent_id=worker is called
      then: |
        Only sessions with matching agent_id are returned
    - id: ac-filter-trigger
      given: |
        Sessions exist with various triggers (manual, task.ready, task.in_progress, etc.)
      when: |
        GET /api/sessions?trigger=manual is called
      then: |
        Only sessions with matching trigger are returned.
        Dispatched shorthand (trigger=dispatched) matches all task.* triggers.
    - id: ac-filter-task
      given: |
        Sessions exist with task_id references
      when: |
        GET /api/sessions?task_id=@task-slug is called
      then: |
        Only sessions linked to that task are returned
    - id: ac-filter-spec-ref
      given: |
        Sessions exist linked to tasks that reference specs
      when: |
        GET /api/sessions?spec_ref=@spec-slug is called
      then: |
        Sessions are filtered by resolving the spec to its linked tasks
        (via AlignmentIndex), then returning sessions whose task_id
        matches any of those tasks.
    - id: ac-filter-since
      given: |
        Sessions span multiple days
      when: |
        GET /api/sessions?since=2025-03-01 is called
      then: |
        Only sessions with started_at >= the given date are returned
    - id: ac-combined-filters
      given: |
        Multiple filters are specified
      when: |
        GET /api/sessions?status=completed&agent_id=worker&limit=10 is called
      then: |
        Filters are AND'd together: status AND agent_id both must match.
        Pagination applies after filtering.
    - id: ac-invalid-filter
      given: |
        A filter parameter has an invalid value
      when: |
        GET /api/sessions?status=bogus is called
      then: |
        A 400 response is returned with an error message listing valid
        values for the parameter.
    - id: ac-metadata-only
      given: |
        The endpoint needs to be fast for list views
      when: |
        Session list is requested
      then: |
        Only session.yaml metadata is read, not events.jsonl.
        Summary stats (event_count, iteration_count, tasks_completed) are
        computed lazily or cached.
  implementation_notes: |
    Follow the existing tasks endpoint pattern in dist/daemon/routes/tasks.ts.
    Use Elysia query validation with t.Optional for all filter params.
    Multi-value params use t.Union([t.String(), t.Array(t.String())]).
    The expensive part is reading 700+ session.yaml files — consider a
    metadata cache that invalidates on directory mtime changes.

- title: Session Summary Cache
  slug: session-summary-cache
  type: requirement
  parent: "@api-contract"
  description: |
    Cache session metadata and summary stats to avoid reading 700+ YAML files
    and scanning events.jsonl on every list request. The cache should be
    filesystem-aware (invalidate when sessions dir changes) and build
    incrementally (new sessions appended, not full rebuild).
  acceptance_criteria:
    - id: ac-cache-build
      given: |
        The daemon starts and sessions exist on disk
      when: |
        The first session list request arrives
      then: |
        A metadata cache is built by reading all session.yaml files.
        Subsequent requests use the cache without re-reading files.
    - id: ac-cache-invalidate
      given: |
        A new session is created or an existing session status changes
      when: |
        The next session list request arrives
      then: |
        The cache detects the change (via directory listing diff or
        file watcher) and updates only the affected entries.
    - id: ac-cache-graceful
      given: |
        A session directory exists but session.yaml is missing or corrupt
      when: |
        The cache attempts to read it
      then: |
        The entry is skipped with a warning logged. The cache continues
        building from remaining valid sessions.
    - id: ac-summary-stats
      given: |
        A session has events.jsonl on disk
      when: |
        Summary stats are requested for the first time
      then: |
        event_count, iteration_count, and tasks_completed are computed
        by scanning events.jsonl and cached alongside metadata.
        Completed sessions never need recomputation.
    - id: ac-active-refresh
      given: |
        A session has status "active"
      when: |
        Its summary stats are requested
      then: |
        Stats are recomputed on each request since events are still
        being appended. Completed/failed/abandoned sessions use cached stats.
  implementation_notes: |
    Store cache in memory on the daemon. Use Map<sessionId, CachedSummary>.
    On startup, list session directories and read metadata in parallel.
    For stats, scan events.jsonl line count (fast) and grep for iteration
    markers. Only active sessions need stats refresh.

- title: Session List Infinite Scroll UI
  slug: session-list-infinite-scroll
  type: requirement
  parent: "@ui-session-history"
  description: |
    Replace the current load-all-sessions approach with infinite scroll
    pagination on the /sessions page. Initial load fetches first page,
    scrolling near bottom triggers next page fetch. Follow existing
    SvelteKit patterns with $effect for reactive loading.
  traits:
    - "@ui-url-panel-state"
  acceptance_criteria:
    - id: ac-initial-load
      given: |
        The user navigates to /sessions
      when: |
        The page loads
      then: |
        Only the first page of sessions (25 items) loads.
        A loading skeleton shows during fetch.
        Total count is displayed (e.g., "25 of 731 sessions").
    - id: ac-scroll-load
      given: |
        The user has scrolled to within 200px of the bottom of the list
      when: |
        More sessions exist beyond the current page
      then: |
        The next page loads automatically. A loading indicator shows
        at the bottom. Already-loaded sessions remain in place.
    - id: ac-scroll-end
      given: |
        All sessions have been loaded
      when: |
        The user scrolls to the bottom
      then: |
        No more requests are made. An "end of list" indicator shows.
    - id: ac-filter-reset
      given: |
        The user changes any filter
      when: |
        The filter value updates
      then: |
        The list resets to page 1 with the new filter applied.
        Previously loaded items are cleared.
        Total count updates to reflect filtered results.
    - id: ac-live-update
      given: |
        A new session is created while the user is on /sessions
      when: |
        The WebSocket broadcasts a session update
      then: |
        The total count updates. If the user is at the top of the list,
        the new session appears. Otherwise a "new sessions available"
        indicator shows.
  implementation_notes: |
    Use IntersectionObserver on a sentinel element at the bottom of the
    list. Track offset/limit/total in component state. Reset offset to 0
    when any filter changes. Append new pages to existing items array.
    WebSocket updates use the existing global subscription — no new
    connection management needed per-component.

- title: Session Filter Controls
  slug: session-filter-controls
  type: requirement
  parent: "@ui-session-history"
  description: |
    Add comprehensive filter controls to the /sessions page. Filters
    persist in URL search params (following the TaskFilters pattern)
    so they survive refresh and can be shared/bookmarked.
  traits:
    - "@ui-url-panel-state"
  acceptance_criteria:
    - id: ac-status-filter
      given: |
        The /sessions page is loaded
      when: |
        The user selects one or more status values (completed, active, failed, etc.)
      then: |
        URL updates with ?status=completed&status=failed.
        Session list filters to matching sessions.
    - id: ac-agent-filter
      given: |
        Sessions exist from different agents (worker, pr-reviewer)
      when: |
        The user selects an agent from the agent filter
      then: |
        URL updates with ?agent_id=worker.
        Session list filters to matching sessions.
    - id: ac-agent-type-filter
      given: |
        Sessions exist from different agent types (claude-agent-acp, codex-acp)
      when: |
        The user selects an agent type
      then: |
        URL updates with ?agent_type=claude-agent-acp.
        Session list filters to matching sessions.
    - id: ac-trigger-filter
      given: |
        Sessions exist with various triggers
      when: |
        The user selects manual or dispatched trigger filter
      then: |
        URL updates with ?trigger=manual or ?trigger=dispatched.
        Session list filters to matching sessions.
    - id: ac-date-filter
      given: |
        The /sessions page is loaded
      when: |
        The user selects a time range (today, 7d, 30d, all)
      then: |
        URL updates with ?since=<date>.
        Session list filters to sessions started after that date.
    - id: ac-clear-filters
      given: |
        One or more filters are active
      when: |
        The user clicks "Clear filters"
      then: |
        All filter params are removed from URL.
        Session list shows all sessions.
    - id: ac-filter-counts
      given: |
        Filters are applied
      when: |
        The session list updates
      then: |
        The count indicator shows filtered vs total
        (e.g., "12 of 731 sessions").
  implementation_notes: |
    Follow the TaskFilters.svelte pattern. Use goto() for URL state
    (never replaceState/pushState directly — see SvelteKit URL state
    management notes). Populate filter options dynamically from the
    distinct values in the session data (unique agent types, agent IDs).

- title: Session CLI Unified Filtering
  slug: session-cli-unified-filtering
  type: requirement
  parent: "@session-model-evolution"
  description: |
    Align CLI session log commands with the daemon API filtering
    capabilities. Currently the CLI has --status, --agent, --since
    but lacks --agent-id, --trigger, --task, and combined filters.
    Unify the filter vocabulary so CLI and UI use the same fields.
  traits:
    - "@trait-filterable-list"
    - "@trait-json-output"
  acceptance_criteria:
    - id: ac-agent-id-filter
      given: |
        Sessions exist with different agent_id values
      when: |
        kspec session log list --agent-id worker is run
      then: |
        Only sessions with agent_id "worker" are listed
    - id: ac-trigger-filter
      given: |
        Sessions exist with various triggers
      when: |
        kspec session log list --trigger manual is run
      then: |
        Only sessions with matching trigger are listed.
        --trigger dispatched matches all task.* triggers.
    - id: ac-task-filter
      given: |
        Sessions exist with task_id references
      when: |
        kspec session log list --task @task-slug is run
      then: |
        Only sessions linked to that task are listed
    - id: ac-backward-compat
      given: |
        The existing --agent flag is used
      when: |
        kspec session log list --agent claude-agent-acp is run
      then: |
        --agent continues to filter by agent_type as before.
        Both --agent and --agent-type are accepted as synonyms.
    - id: ac-combined
      given: |
        Multiple filters are specified
      when: |
        kspec session log list --status completed --agent-id worker --since 7d is run
      then: |
        All filters are AND'd together
    - id: ac-json-output
      given: |
        Any filter combination is applied
      when: |
        --json flag is used
      then: |
        Output includes the filter criteria and filtered results in
        structured JSON matching the daemon API response shape
  implementation_notes: |
    The CLI already has --status, --agent (agent_type), --since. Add
    --agent-id, --trigger, --task. The --agent flag maps to agent_type
    for backward compat. Share filter logic between CLI and daemon where
    possible — extract to a shared filterSessions() function.

- title: Task and Spec Session Context
  slug: task-spec-session-context
  type: requirement
  parent: "@ui-session-history"
  description: |
    Show related sessions on task and spec detail views, and allow
    filtering the session list by task or spec reference. This creates
    bidirectional navigation between sessions and the work they performed.
  acceptance_criteria:
    - id: ac-task-detail-sessions
      given: |
        A task has been worked on in one or more sessions
      when: |
        The user views the task detail (modal or page)
      then: |
        A "Sessions" section lists all sessions that referenced this
        task (via task_id), with status, duration, and link to session view
    - id: ac-spec-detail-sessions
      given: |
        A spec has tasks that were worked on in sessions
      when: |
        The user views the spec detail
      then: |
        A "Sessions" section lists all sessions related to this spec
        (via tasks that reference the spec), with status, duration, and
        link to session view
    - id: ac-session-list-task-filter
      given: |
        The user is on the task detail view and sees related sessions
      when: |
        The user clicks "View all sessions" or a filter link
      then: |
        They navigate to /sessions?task_id=@task-slug showing only
        sessions for that task
    - id: ac-session-list-spec-filter
      given: |
        The user is on the spec detail view and sees related sessions
      when: |
        The user clicks "View all sessions"
      then: |
        They navigate to /sessions?spec_ref=@spec-slug showing only
        sessions for specs/tasks under that spec
    - id: ac-api-task-sessions
      given: |
        The daemon API receives a request for task-related sessions
      when: |
        GET /api/tasks/:ref/sessions is called
      then: |
        Returns a list of sessions whose task_id matches the task,
        with status, duration, and started_at fields
    - id: ac-api-item-sessions
      given: |
        The daemon API receives a request for spec-related sessions
      when: |
        GET /api/items/:ref/sessions is called
      then: |
        Returns sessions related to tasks linked to this spec,
        resolved via AlignmentIndex
  implementation_notes: |
    For task filtering, a direct task_id match on session metadata suffices.
    For spec filtering, use the existing AlignmentIndex to resolve spec →
    tasks, then filter sessions by those task IDs. Add a "Sessions" section
    to TaskDetail and ItemDetail components. The dedicated sub-resource
    endpoints (/tasks/:ref/sessions, /items/:ref/sessions) are simpler
    than overloading the main sessions endpoint with spec resolution logic.

- title: Session Text Search
  slug: session-text-search
  type: requirement
  parent: "@ui-session-history"
  description: |
    Extend the existing CLI session log search with daemon API and UI
    support. The CLI already does case-insensitive substring search over
    events.jsonl. This spec adds: (1) a daemon API endpoint exposing the
    same search, (2) UI integration on /sessions, and (3) metadata
    pre-filtering to keep search fast at scale (700+ sessions, ~1GB events).
  traits:
    - "@trait-api-endpoint"
  acceptance_criteria:
    - id: ac-cli-search
      given: |
        Sessions with events exist on disk
      when: |
        kspec session log search "error handling" --since 7d is run
      then: |
        Matches are returned grouped by session with timestamp, event type,
        and context excerpt. Results respect --since and other metadata filters
        to narrow the search scope before scanning events.
    - id: ac-api-search
      given: |
        The daemon is running
      when: |
        GET /api/sessions/search?q=error+handling&since=7d is called
      then: |
        Response includes matches with session_id, event seq, type,
        excerpt, and timestamp. Metadata filters narrow scope first.
    - id: ac-ui-search
      given: |
        The user is on /sessions
      when: |
        The user types in the search box and submits
      then: |
        Sessions matching the search query are displayed.
        Search query persists in URL as ?q=search+term.
    - id: ac-empty-query
      given: |
        The search box is empty or contains only whitespace
      when: |
        The user submits the search
      then: |
        No search is performed. The session list shows unfiltered
        results (or filtered by other active filters).
    - id: ac-performance
      given: |
        700+ sessions exist with ~1GB of events data
      when: |
        A search is performed with a --since 7d filter
      then: |
        Results return within 5 seconds. Metadata filtering
        reduces the event files to scan before content search.
    - id: ac-scope-narrowing
      given: |
        Search is performed with metadata filters
      when: |
        --status, --agent-id, --since, or --task filters are combined with search
      then: |
        Metadata filters are applied first to reduce the set of sessions
        whose events need scanning. Only matching sessions' events.jsonl
        files are read.
  implementation_notes: |
    No index needed if metadata filters narrow scope first. The existing
    CLI search already does case-insensitive substring matching on event
    payloads. The key optimization is filtering sessions by metadata
    (status, since, agent, task) BEFORE scanning events.jsonl. For 7-day
    windows this typically means scanning 20-50 sessions instead of 700+.
    The daemon endpoint can stream results or use a reasonable timeout.
```

## Tasks

derive_from_specs: true

## Implementation Notes

Execution order should be:
1. Session summary cache + pagination API (foundation for everything else)
2. CLI unified filtering (shares filter logic with daemon)
3. Session filter controls + infinite scroll UI (depends on API)
4. Task/spec session context (depends on API filtering)
5. Session text search (depends on metadata filtering being in place)

Full-text search strategy: No dedicated search index. Instead, rely on
metadata filtering to narrow the scope before scanning events.jsonl.
A 7-day window typically contains 20-50 sessions, making substring
search over their events feasible (<5s). The CLI already does this.
The daemon endpoint wraps the same logic.

The metadata cache is critical for performance. Reading 700+ session.yaml
files on every request is too slow. An in-memory Map<id, CachedSummary>
on the daemon, populated on first request and updated incrementally
(watch directory or diff listings), makes list/filter/count operations fast.

The existing @ui-session-history ac-1 will need updating after this work
since the load-all behavior changes to paginated. The existing AC describes
what fields are shown; the new specs describe how loading and filtering work.
