# Daemon Cache Warming UX

## Context

When the daemon's entity cache is warming after initial project registration or daemon restart, list endpoints return empty data with `_cache_status: "loading"`. The web UI treats this as a normal empty response and caches it. Users see empty pages with no indication that data is loading.

Note: Watcher-triggered reloads of already-populated domains are NOT affected — `@daemon-entity-cache` ac-stale-during-reload ensures ready domains serve prior cached data during reload. This plan targets the cold-cache scenario only (no prior data to serve).

### Design Decisions

1. **Response envelope normalization for cache-sensitive endpoints** — All endpoints that serve entity data from the cache return `{data: T, meta: {total, offset, limit, cache_status}}`. Non-cache endpoints (health, projects, command, mutation responses) are excluded. Internal change, no API versioning needed (only consumer is our web UI).
2. **WebSocket push + retry fallback** — Daemon broadcasts `cache:domain:ready` events; UI subscribes and invalidates queries. Retry at 2s intervals as safety net.
3. **30s timeout → error state** — If cache doesn't become ready within 30 seconds, show error with retry button. Prevents users from acting on empty data.

## Specs

No new specs. This plan updates three existing specs with new acceptance
criteria. The AC additions are handled as tasks (see Phase 0 below)
because `kspec plan derive` creates new specs — it cannot modify existing
ones.

**Specs updated:**
- `@trait-api-endpoint` — rewrite ac-4 to behavioral language (remove response shape prescription)
- `@api-contract` — rewrite ac-4 to behavioral language, add ac-envelope, ac-cache-status-field
- `@daemon-entity-cache` — add ac-domain-ready-event
- `@ui-data-freshness` — add ac-warming-skeleton, ac-warming-auto-transition, ac-warming-retry-fallback, ac-warming-timeout

## Tasks

derive_from_specs: false

```yaml
# ─── Phase 0: Spec Updates ───

- title: Rewrite pagination ACs to behavioral language and add envelope ACs
  slug: task-spec-update-api-contract
  spec_ref: "@api-contract"
  priority: 1
  tags: [spec, api]
  description: |
    Two existing ACs prescribe the response wire format ({items, total,
    offset, limit}) rather than describing pagination behavior. This
    conflicts with the envelope normalization in this plan. Additionally,
    @api-contract has no ACs for a normalized response envelope or typed
    cache status signaling.

    Why: @trait-api-endpoint ac-4 says "returns {items, total, offset,
    limit} wrapper" and @api-contract ac-4 says "returns paginated
    results with {items, total, offset, limit} wrapper." Both prescribe
    a specific shape instead of describing the behavioral contract
    (accepts pagination params, response includes total count and
    pagination metadata). If left unchanged, the new envelope shape
    {data, meta} would violate these ACs. The new envelope and cache
    status ACs define what "correct" looks like for the server-side
    migration.

    What:
    1. Rewrite @trait-api-endpoint ac-4 to: "accepts limit and offset
       query params, response includes the total count of matching
       items and the pagination parameters applied" — behavioral, no
       shape prescription.
    2. Rewrite @api-contract ac-4 to: "returns paginated results
       including total count and the pagination parameters applied" —
       behavioral, endpoint-specific detail without shape.
    3. Add two new ACs to @api-contract:

    ac-envelope:
      Given: the daemon is running and receives an API request
      When: an endpoint that serves entity data from the cache returns
      a response
      Then: the response uses a normalized envelope with a typed data
      payload and a metadata object containing cache readiness state,
      and pagination fields (total, offset, limit) when applicable.
      Non-cache endpoints (health, projects, command, mutation
      responses) are excluded from this contract.

    ac-cache-status-field:
      Given: a cache domain is still loading for the requested project
      When: an API list or query endpoint is called
      Then: the response metadata includes a cache status value of
      "loading" and the data payload is empty or default, distinct from
      a normal empty result where cache status is "ready"

    How: Use kspec batch. For ac rewrites, use "item ac set" on
    @trait-api-endpoint and @api-contract targeting ac-4. For new ACs,
    use "item ac add" on @api-contract. Use given/when/then block
    scalars.

- title: Add domain ready event AC to entity cache spec
  slug: task-spec-update-entity-cache
  spec_ref: "@daemon-entity-cache"
  priority: 1
  tags: [spec, daemon]
  description: |
    The @daemon-entity-cache spec covers cache loading, serving, and
    invalidation but has no AC for broadcasting when a domain becomes
    ready. The WebSocket event task depends on this AC.

    Why: The domain-ready broadcast is new behavior not covered by
    existing ACs. ac-warming-availability covers the server returning
    a loading response, but not actively notifying clients when loading
    completes.

    What: Add one AC to @daemon-entity-cache:

    ac-domain-ready-event:
      Given: a cache domain transitions to ready state (from loading,
      degraded, or any non-ready state)
      When: the transition completes
      Then: a real-time event is broadcast to all connected clients
      identifying the domain and project that became ready

    How: Use kspec item ac add @daemon-entity-cache with the AC fields.

- title: Add cache warming UX ACs to data freshness spec
  slug: task-spec-update-data-freshness
  spec_ref: "@ui-data-freshness"
  priority: 1
  tags: [spec, web-ui]
  description: |
    The @ui-data-freshness spec covers caching, invalidation, and
    WebSocket-driven updates but has no ACs for cache warming behavior —
    what the UI should do when the server reports its cache is still
    loading. The warming UX tasks depend on these ACs.

    Why: Four new behaviors need AC coverage: showing skeletons instead
    of empty content, auto-transitioning when cache is ready, retry
    fallback for missed events, and timeout error state. Without these
    ACs, the warming UX has no testable contract.

    What: Add four ACs to @ui-data-freshness using kspec batch:

    ac-warming-skeleton:
      Given: the server signals that its cache is still warming
      When: the UI receives the response
      Then: a loading skeleton is displayed instead of empty content,
      and the warming response is not persisted in the client cache
      as real data

    ac-warming-auto-transition:
      Given: the UI is displaying a loading skeleton due to cache warming
      When: a real-time event indicates the cache domain is ready
      Then: the affected queries are invalidated and the view transitions
      to real data without user interaction

    ac-warming-retry-fallback:
      Given: the UI is displaying a loading skeleton due to cache warming
      When: no real-time domain-ready event has been received
      Then: the UI retries the request at short intervals as a fallback
      for missed or delayed real-time events

    ac-warming-timeout:
      Given: the UI has been retrying a cache-warming response
      When: the retry ceiling (30 seconds) is reached without the cache
      becoming ready
      Then: the UI displays an error state with a manual retry option
      instead of continuing to show the loading skeleton

    How: Use kspec batch with four "item ac add" commands targeting
    @ui-data-freshness. Use given/when/then block scalars.

# ─── Phase 1: Server-Side Envelope ───

- title: Define unified API response envelope type and wrapper
  slug: task-api-response-envelope-type
  spec_ref: "@api-contract"
  priority: 1
  depends_on: ["@task-spec-update-api-contract"]
  tags: [api, daemon, schema]
  description: |
    Today, daemon API responses have inconsistent shapes: list endpoints
    return {items, total, offset, limit}, aggregation endpoints return
    {counts: {...}}, and cache warming state is an ad-hoc _cache_status
    field mixed in at the top level. This makes it impossible for the
    web UI to have a single response handling path.

    Why: A normalized envelope is the prerequisite for centralized cache
    warming detection in the UI. Without it, every fetch function needs
    its own logic to find and interpret the cache status field, and the
    UI cannot distinguish "cache is warming, data is empty" from "data
    really is empty."

    What: Define a generic ApiResponse<T> type with two fields: `data`
    (typed payload — array for lists, object for aggregation/detail) and
    `meta` (object with total, offset, limit as optional numbers, and
    cache_status as a required "ready" | "loading" literal). Create a
    server-side wrapper function (e.g. wrapResponse) that route handlers
    call to construct envelope responses. Export the type from the shared
    types package so the web UI can import it.

    How: Add the Zod schema and TypeScript type to the shared types
    package. The wrapper function takes the domain data, pagination
    params, and cache domain state, and returns the envelope. For cache
    warming responses, it returns {data: default-empty, meta: {
    cache_status: "loading"}}. For normal responses, cache_status is
    "ready". This is an internal contract change — no API versioning
    needed since the only consumer is the web UI.

    Covers: @api-contract ac-envelope.

- title: Migrate daemon route handlers to unified envelope
  slug: task-migrate-route-handlers-envelope
  spec_ref: "@api-contract"
  priority: 2
  depends_on: ["@task-api-response-envelope-type"]
  tags: [api, daemon]
  description: |
    There are ~27 route handlers across the daemon that return responses
    directly with varying shapes. Each currently has its own inline
    cache warming check that returns a hand-crafted loading response
    (e.g. {items: [], total: 0, _cache_status: "loading"} in tasks.ts,
    {counts: {}, _cache_status: "loading"} in aggregation.ts). These
    all need to use the envelope wrapper from the previous task.

    Why: The envelope type is defined but not yet used by any route. This
    task is the mechanical migration that makes the contract real. Until
    all routes use the envelope, the web UI cannot rely on a single
    response shape.

    What: Update every route handler in the daemon routes directory to
    use the wrapResponse helper. Discover all handlers by searching for
    existing _cache_status usage and direct response object construction
    — these are the sites that need migration. This covers list
    endpoints, aggregation/stats endpoints, validation endpoints, meta
    endpoints, and detail endpoints. Remove the inline _cache_status
    field construction from each handler — the wrapper handles it.

    How: For each route: replace the return statement with a call to
    wrapResponse(), passing the domain data and cache domain state.
    List endpoints pass their items array as data. Aggregation endpoints
    pass their counts/stats object. The wrapper reads domain state from
    EntityCache.getDomainState() to set cache_status. Existing tests
    need updating to expect the new shape.

    Covers: @api-contract ac-envelope, ac-cache-status-field.

# ─── Phase 2: WebSocket Event + Client Unwrapping ───

- title: Broadcast cache domain ready event via WebSocket
  slug: task-cache-domain-ready-ws-event
  spec_ref: "@daemon-entity-cache"
  priority: 1
  depends_on: ["@task-spec-update-entity-cache"]
  tags: [daemon, websocket]
  description: |
    The daemon's EntityCache tracks per-domain loading state (unloaded →
    loading → ready/degraded) but does not notify WebSocket clients when
    a domain finishes loading. The web UI currently has no way to know
    when to refetch after receiving a cache-warming response except by
    polling.

    Why: WebSocket push is the primary mechanism for the UI to transition
    from loading skeleton to real data. Without it, the UI must poll at
    fixed intervals (2s), adding latency and unnecessary requests. The
    daemon already has a PubSubManager that broadcasts entity mutation
    events — domain-ready events follow the same pattern.

    What: When EntityCache transitions a domain to "ready" from any
    non-ready state (loading, degraded, or unloaded), broadcast a
    domain_ready event on a "cache:status" topic via PubSubManager. The event payload includes
    the domain name (e.g. "tasks", "items", "sessions") and the project
    path. This event is scoped to the project, matching how entity
    mutation broadcasts work.

    How: In the EntityCache class (src/daemon/entity-cache.ts), after
    the domain state transitions to "ready", call pubsub.broadcast()
    with topic "cache:status", type "domain_ready", and payload
    {domain, project}. The PubSub instance needs to be accessible from
    EntityCache — either pass it in at construction or emit an event
    that the route layer relays. Follow the existing broadcast pattern
    used in route handlers (e.g. tasks.ts broadcasts on "tasks:updates"
    after mutations).

    Covers: @daemon-entity-cache ac-domain-ready-event.

- title: Update web UI fetch functions for unified envelope
  slug: task-ui-unwrap-envelope
  spec_ref: "@api-contract"
  priority: 3
  depends_on: ["@task-migrate-route-handlers-envelope"]
  tags: [web-ui, data-layer]
  description: |
    The web UI's api.ts contains ~20 fetch functions (fetchTasks,
    fetchItems, fetchInbox, fetchPlans, fetchSessions, fetchReviews,
    etc.) that each return response.json() directly, typed to the old
    per-endpoint shapes (e.g. PaginatedResponse<TaskSummary> with
    {items, total, offset, limit}). After the server migrates to the
    unified envelope, these functions will receive {data, meta} but
    still expect the old shape.

    Why: Without updating the fetch functions, TypeScript types will be
    wrong, destructuring will break, and components will receive
    undefined where they expect arrays. This is the client-side
    counterpart of the server migration.

    What: Update all fetch functions in the web UI API layer to unwrap
    the envelope. Each function should extract response.data and
    response.meta, returning the domain data to callers. Update the
    TypeScript return types to match. The meta object (including
    cache_status) must be inspectable before the data is returned —
    the downstream cache warming interceptor
    (@task-ui-cache-warming-interceptor) checks cache_status and throws
    a CacheWarmingError for "loading" responses before data reaches
    TanStack Query's cache.

    How: Import the ApiResponse<T> type from shared types. Each fetch
    function calls response.json() to get the envelope, then returns
    the unwrapped result. For static mode (isStaticMode()), update the
    static data helpers to return the same envelope shape — wrap their
    pre-baked data with {data, meta: {cache_status: "ready"}}. This
    means the unwrap path is identical for both live and static modes,
    no branching needed. Update all TypeScript interfaces
    (PaginatedResponse, etc.) to match the new contract. Update
    component-level destructuring as needed.

    Covers: @api-contract ac-envelope (client-side).

# ─── Phase 3: Cache Warming UX ───

- title: Implement cache warming detection and retry in query layer
  slug: task-ui-cache-warming-interceptor
  spec_ref: "@ui-data-freshness"
  priority: 3
  depends_on: ["@task-ui-unwrap-envelope", "@task-spec-update-data-freshness"]
  tags: [web-ui, data-layer]
  description: |
    After the fetch functions unwrap the envelope, the web UI has access
    to meta.cache_status on every response. But TanStack Query doesn't
    know that a cache_status: "loading" response is transient — it caches
    it with the normal 30s staleTime, meaning users see empty pages for
    up to 30 seconds even after the server cache is ready.

    Why: Cache warming responses must not be treated as successful data.
    They need to trigger automatic retry so the UI refetches when the
    server is ready. Without this, the existing staleTime (30s) and
    retry config (1 retry, 1s delay) are insufficient — the UI caches
    the empty response and stops trying.

    What: Add a centralized mechanism in the query layer that detects
    cache_status: "loading" responses and treats them as retryable
    transient conditions rather than successful empty results. Configure
    retry behavior: 2-second intervals, maximum 15 attempts (30-second
    ceiling). The retry should be specific to cache warming — normal
    successful-but-empty responses (cache_status: "ready" with zero
    items) must NOT retry.

    How: Two approaches to evaluate: (1) Throw a typed CacheWarmingError
    from the fetch function when cache_status is "loading" — TanStack
    Query's retry mechanism handles it naturally. The retry callback
    checks error type to only retry CacheWarmingError. (2) Use TanStack
    Query's queryFn meta or select to flag warming responses and
    configure per-query retry. Option 1 is simpler and recommended.
    Either way, the warming response must not enter the query cache as
    successful data.

    Covers: @ui-data-freshness ac-warming-retry-fallback,
    ac-warming-timeout. Also covers ac-warming-skeleton's requirement
    that warming responses are not persisted in the client cache — the
    CacheWarmingError prevents TanStack Query from caching them as
    successful data. The skeleton rendering itself is in
    @task-ui-warming-skeletons.

- title: Subscribe to cache domain ready events for query invalidation
  slug: task-ui-cache-domain-ready-subscription
  spec_ref: "@ui-data-freshness"
  priority: 4
  depends_on: ["@task-cache-domain-ready-ws-event", "@task-ui-cache-warming-interceptor"]
  tags: [web-ui, websocket]
  description: |
    The web UI already subscribes to WebSocket events for entity mutation
    invalidation (e.g. when a task is updated, the tasks query is
    invalidated). Cache domain ready events need the same treatment —
    when the server broadcasts that a domain finished loading, the UI
    should invalidate queries for that domain so they refetch immediately
    instead of waiting for the next retry interval.

    Why: WebSocket push is faster and more efficient than retry polling.
    When the daemon's tasks cache finishes loading, the UI should refetch
    within milliseconds, not wait up to 2 seconds for the next retry.
    This is the primary transition mechanism; retry is the fallback for
    missed events or reconnection gaps.

    What: Add a WebSocket subscription handler for the "cache:status"
    topic alongside existing mutation topic handlers. When a
    "domain_ready" event is received, map the domain name to TanStack
    Query keys (e.g. domain "tasks" → query key ["tasks"], domain
    "items" → query key ["items"]) and call
    queryClient.invalidateQueries() for those keys. This triggers an
    immediate refetch of any active queries for that domain.

    How: The web UI's WebSocket handler (in the query/websocket
    integration layer) already maps topics to query invalidation. Add
    "cache:status" as a subscribed topic. The domain_ready event
    payload includes {domain, project} — use the domain field to
    determine which query keys to invalidate. If the domain maps to
    multiple query keys (e.g. "meta" covers several endpoints), all
    related keys should be invalidated.

    Covers: @ui-data-freshness ac-warming-auto-transition.

- title: Show loading skeletons and timeout error across all views
  slug: task-ui-warming-skeletons
  spec_ref: "@ui-data-freshness"
  priority: 4
  depends_on: ["@task-ui-cache-warming-interceptor"]
  tags: [web-ui, components]
  description: |
    The web UI has existing skeleton components (Skeleton, BoardSkeleton,
    SessionStreamSkeleton, SidebarMenuSkeleton) but no view currently
    uses them for cache warming. Views either show empty content or their
    own initial loading state only on first mount. Once TanStack Query
    has cached data (even an empty warming response), views show that
    cached data with no indication that it's incomplete.

    Why: This is the user-facing piece — without it, the interceptor and
    WebSocket plumbing work correctly but users still see empty pages
    during cache warming. The existing skeleton components were built
    for exactly this purpose but have never been connected to the cache
    warming signal.

    What: Update all list views in the web UI to detect when the query
    is in a cache-warming retry state and render the appropriate skeleton
    component instead of empty content. Views to update: tasks board
    (BoardSkeleton), items list, sessions list (SessionStreamSkeleton
    for detail), inbox, plans, reviews, and triage. Also add a timeout
    error state component: after 30 seconds of retrying, show an error
    message ("Unable to load [entity]. The server cache did not become
    ready.") with a manual Retry button that resets the retry counter
    and tries again.

    How: The cache warming interceptor (previous task) either throws
    CacheWarmingError or sets a flag. TanStack Query's isError +
    error type, or a custom isPending-like flag, can be checked in
    each view's template. When warming is detected, render the skeleton.
    When the retry ceiling is exceeded (error is CacheWarmingError and
    failureCount >= 15), render the error state instead. The Retry
    button calls queryClient.resetQueries() for the relevant key.

    Covers: @ui-data-freshness ac-warming-skeleton (skeleton rendering
    and view integration — the "not persisted in cache" requirement is
    handled by @task-ui-cache-warming-interceptor), ac-warming-timeout
    (error state UI and retry button).

# ─── Phase 4: Validation ───

- title: E2E test for cache warming to ready transition
  slug: task-e2e-cache-warming-transition
  spec_ref: "@ui-data-freshness"
  priority: 5
  depends_on: ["@task-ui-warming-skeletons", "@task-ui-cache-domain-ready-subscription"]
  tags: [test, e2e]
  description: |
    There are no tests verifying the cache warming UX end-to-end. The
    daemon's cache warming behavior, WebSocket domain_ready event, and
    the UI's skeleton/error/transition flow need integration coverage
    to prevent regression.

    Why: The cache warming flow spans three systems (EntityCache →
    WebSocket PubSub → TanStack Query + Svelte views). Unit tests for
    individual pieces don't catch integration failures — e.g. the
    WebSocket event fires but the query key mapping is wrong, or the
    skeleton renders but doesn't transition when data arrives.

    What: A Playwright E2E test with three scenarios: (1) Navigate to
    a view while the daemon cache is still warming — verify that a
    loading skeleton is visible instead of empty content. (2) After
    the cache finishes warming, verify the skeleton is replaced by
    real data without user interaction (driven by WebSocket
    domain_ready event). (3) Simulate a cache that never becomes ready
    (or takes >30s) — verify the error state appears with a working
    Retry button.

    How: Register a new project mid-test to trigger fresh cache warming
    — this is the most realistic way to control timing without test-only
    endpoints. Navigate to the new project's view immediately after
    registration to catch the warming window. For the timeout scenario,
    add a test-only daemon endpoint that injects an artificial delay
    into cache domain loading (behind a KSPEC_TEST flag) so the 30s
    ceiling can be hit reliably without needing a massive dataset. Use
    existing Playwright fixture patterns from the e2e test suite.

    Covers: @ui-data-freshness ac-warming-skeleton, ac-warming-auto-
    transition, ac-warming-retry-fallback, ac-warming-timeout.
```

## Implementation Notes

### Response Envelope Shape

```typescript
interface ApiResponse<T> {
  data: T;
  meta: {
    total?: number;
    offset?: number;
    limit?: number;
    cache_status: "ready" | "loading";
  };
}
```

All list endpoints: `T = SomeItem[]`. Aggregation: `T = { counts: {...} }`. Detail endpoints can use the same envelope with `T = SingleItem`.

### Cache Warming Detection Strategy

The interceptor should treat `cache_status: "loading"` responses as transient errors rather than successful empty results. This prevents TanStack Query from caching them with the normal staleTime. The retry mechanism (2s interval, 15 attempts = 30s ceiling) runs automatically. WebSocket domain_ready events short-circuit the retry by invalidating the query.

### Static Mode

Static exports don't have cache warming — all data is pre-baked. Static data helpers are updated to return the same envelope shape with `cache_status: "ready"`. This means the unwrap path is identical for live and static modes — no branching or format detection needed.

### Migration Order

Phase 0 spec updates first (P1, can run in parallel). Then server-side envelope type + WS event (P1, can run in parallel since independent). Then route handler migration (P2). Then client unwrapping + interceptor (P3). Then WS subscription + skeleton views (P4). Finally E2E test (P5).
