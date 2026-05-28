# E2E Test Suite Audit and Restructure

## Specs

```yaml
[]
```

## Tasks

derive_from_specs: false

```yaml
- title: "Fix TanStack Query reactivity bug: loading state never resolves"
  slug: task-fix-query-loading-state
  description: |
    What: The web UI pages at /, /agents, and /automation show a loading
    skeleton forever on fresh page load. The page never transitions to
    showing content. Navigating away to another page and back causes the
    content to appear correctly.

    Why: This is a live application bug affecting every user on every
    fresh page load of these three pages. It also blocks ~46 e2e test
    failures across dashboard.spec.ts, agents.spec.ts, automation.spec.ts,
    and other specs whose tests time out waiting for content that never
    appears past the loading skeleton.

    Evidence (HAR capture, 2026-03-30): A fresh load of /automation fires
    5 API queries (agent/status, meta/agents, hooks, schedules,
    events/recent). All return 200 OK with valid data within 2 seconds.
    No CacheWarmingError, no retry loops. The UI stays in loading skeleton
    state indefinitely. When the user navigates to another page and returns,
    the page renders correctly because the TanStack Query cache already has
    data and the component reads it on mount.

    Root cause hypothesis: TanStack Query Svelte v6 (installed at 6.1.0,
    package @tanstack/svelte-query) uses a createRawRef proxy in
    node_modules/@tanstack/svelte-query/src/containers.svelte.ts to bridge
    query observer state into Svelte's reactivity system. The proxy uses
    $state.raw inside a Proxy set trap with Object.defineProperty
    getter/setter closures. The hypothesis is that when the query observer
    transitions from {isLoading: true} to {isLoading: false, data: ...},
    the proxy's update() function writes the new values, but Svelte's
    $derived in the page component (e.g. let loading = $derived(
    agentStatusQuery.isLoading || ...)) does not re-evaluate because the
    reactive tracking doesn't follow through the proxy indirection.

    CRITICAL: This bug has survived multiple previous fix attempts. Each
    time a plausible root cause was identified, a fix was applied, and the
    issue remained unchanged. Do NOT write fix code until the actual break
    point is proven with runtime console output.

    How:
    1. Add console.log instrumentation in the installed
       node_modules/@tanstack/svelte-query/src/createBaseQuery.svelte.ts:
       - In the $effect at line 74, log when observer.subscribe callback
         fires and the isLoading value from createResult()
       - In the update() function of createRawRef (containers.svelte.ts),
         log when properties are being set and their values
    2. Add console.log in packages/web-ui/src/routes/automation/+page.svelte
       in the $derived(loading) expression to log when it re-evaluates and
       what values agentStatusQuery.isLoading etc. return
    3. Build the web UI (npm run build:web-ui), start the daemon, do a
       fresh page load of /automation, capture console output
    4. The logs will show exactly where the chain breaks: does the observer
       callback fire? Does update() get called? Does $derived re-evaluate?
    5. Write a fix targeting only the confirmed break point
    6. Verify the fix works on fresh page load (Ctrl+R, not navigate-back)
       for all three pages: /, /agents, /automation
    7. Remove all instrumentation before committing

    If the fix requires changing TanStack internals, use a pnpm patch
    (pnpm patch @tanstack/svelte-query) or create a local wrapper function
    that components use instead of createQuery directly.

    Key files:
    - node_modules/@tanstack/svelte-query/src/createBaseQuery.svelte.ts
    - node_modules/@tanstack/svelte-query/src/containers.svelte.ts
    - packages/web-ui/src/routes/+page.svelte (dashboard loading logic)
    - packages/web-ui/src/routes/agents/+page.svelte (agents loading logic)
    - packages/web-ui/src/routes/automation/+page.svelte (automation loading)
    - packages/web-ui/src/lib/query/client.ts (QueryClient configuration)
  priority: 1
  tags: [bug, web-ui, e2e]

- title: "Fix e2e tests for dashboard, agents, and automation pages"
  slug: task-fix-loading-page-e2e
  depends_on: ["@task-fix-query-loading-state"]
  description: |
    What: After @task-fix-query-loading-state resolves the loading skeleton
    bug, the e2e tests for dashboard, agents, and automation pages will get
    past the loading state. However, they will likely still have additional
    failures from stale selectors, stale fixtures, and timing issues. This
    task fixes those remaining failures so all three specs pass cleanly.

    Why: These three specs account for 59 of the 155 total e2e failures.
    They are the highest-priority specs to fix because they block the
    loading-affected failure category (46 tests across the suite) and
    validate the most-used pages in the application.

    How:
    1. Run each spec individually after the loading fix is in place:
       npx playwright test tests/e2e/dashboard.spec.ts
       npx playwright test tests/e2e/agents.spec.ts
       npx playwright test tests/e2e/automation.spec.ts
    2. For each remaining failure, inspect the error-context.md snapshot
       (in test-results/) and the current component markup to identify
       the root cause (stale selector, stale fixture, timing race, or
       envelope mismatch)
    3. Fix in batches by cause type — selectors first (compare test
       getByTestId/locator calls against current Svelte component
       data-testid attributes), then fixtures (compare
       tests/e2e/fixtures/*.yaml against src/schema/ Zod schemas),
       then timing (replace fixed waits with Playwright waitFor patterns)

    Affected specs with known failure breakdown from test-results/:
    - dashboard.spec.ts (~18 failures): stale selectors for task-count-*
      cards, navigation links; 2 envelope-drift failures in aggregation
      count rendering; stale fixture for agent running state
    - agents.spec.ts (~24 failures): stale selectors for dispatch-status,
      dispatch-indicator-stopped, agent card elements, edit dialog fields;
      timing issues on dispatch start/stop button state; 1 removed-feature
      (trigger editing moved to automation view)
    - automation.spec.ts (~17 failures): stale selectors for trigger rows,
      tag filter chips, priority filter; timing on dialog close animation;
      stale fixtures for eligibility criteria and filter schema changes
  priority: 1
  tags: [test, e2e, web-ui]

- title: "Migrate API-only e2e specs to vitest using app.handle()"
  slug: task-migrate-api-tests-vitest
  description: |
    What: 15 Playwright e2e specs containing 279 tests are currently skipped
    (via test.describe.skip) in tests/e2e/ because they test HTTP API
    contracts without any browser interaction — they use Playwright's
    request fixture for HTTP calls but never use the page fixture. These
    tests should be migrated to vitest using the Elysia app.handle()
    pattern so they run without Chromium overhead.

    Why: Running API contract tests in Playwright wastes resources: each
    test spawns a Chromium process and a daemon subprocess despite never
    opening a browser page. Migrating to vitest makes them run in the
    fast shard pipeline (npm run test:shard1/2/3) with sub-second
    execution per test instead of multi-second Playwright overhead.
    The tests themselves are valuable — they cover 56 spec acceptance
    criteria across @api-contract, @batch-item-fetch-api,
    @daemon-agent-dispatch, @daemon-server, @multi-directory-daemon,
    @review-records-daemon-api, @session-list-pagination-api,
    @session-text-search, @triage-daemon-api, and @ui-api-aggregation.

    How: Use the existing app.handle(Request) pattern established in
    tests/daemon-api-input-validation.test.ts. This pattern imports
    createServer from packages/daemon/src/server.ts, creates an Elysia
    app instance, and calls app.handle(new Request(url, options)) directly
    without starting an HTTP server. Required headers for each request:
    Host: localhost, X-Kspec-Dir: <tempDir>, Content-Type: application/json.

    For each of the 15 specs:
    1. Create a corresponding vitest file under tests/daemon-api/
       (e.g. tests/e2e/api-tasks.spec.ts → tests/daemon-api/tasks.test.ts)
    2. Convert Playwright request.get/post/delete calls to
       app.handle(new Request(...)) calls
    3. Convert Playwright expect() assertions to vitest expect()
    4. Set up shared beforeAll that creates a temp dir with fixtures,
       initializes git repo with shadow worktree simulation (same setup
       as tests/daemon-api-input-validation.test.ts)
    5. Run the new vitest file and confirm all tests pass
    6. Delete the skipped Playwright spec

    Each spec can be migrated independently. The 15 specs (listed by
    file name and test count):
    api-tasks.spec.ts (35), api-items.spec.ts (26),
    api-sessions-pagination.spec.ts (23), api-meta.spec.ts (23),
    api-inbox.spec.ts (18), api-reviews-list.spec.ts (18),
    api-reviews-threads.spec.ts (17), api-errors.spec.ts (14),
    api-aggregation.spec.ts (11), api-projects.spec.ts (10),
    api-agent-dispatch.spec.ts (9), api-server.spec.ts (8),
    api-sessions-legacy.spec.ts (7), api-sessions-search.spec.ts (3),
    api-triage.spec.ts (37).
  priority: 2
  tags: [test, infra, e2e]

- title: "Fix stale-selector e2e failures across UI specs"
  slug: task-fix-stale-selectors
  depends_on: ["@task-fix-loading-page-e2e"]
  description: |
    What: Approximately 35 e2e test failures across multiple UI specs are
    caused by stale data-testid attributes or Playwright locator selectors
    that no longer match the current Svelte component markup. The UI was
    refactored after these tests were written, and the test selectors were
    not updated.

    Why: These tests were passing when written but broke as components
    were refactored. They represent valid behavioral assertions — the
    features they test still exist, only the DOM structure changed. Fixing
    the selectors restores coverage for features like item detail views,
    command palette search, task navigation, review badges, and validation
    display. This task depends on @task-fix-loading-page-e2e because some
    of these specs share pages with loading-affected specs and the loading
    fix may change which failures remain.

    How:
    1. Run the full e2e suite: npx playwright test
    2. For each failure with a "locator not found" or "element not visible"
       error in test-results/<test>/error-context.md, compare the selector
       used in the test (getByTestId, getByRole, locator) against the
       current component markup in packages/web-ui/src/
    3. Update the test selector to match the current markup. Prefer
       updating the test over adding new testids — only add data-testid
       attributes to components when no stable selector exists (role,
       label, text content)
    4. Run the individual spec to confirm the fix

    Affected specs (from failure categorization of test-results/ directory):
    - items.spec.ts: ~12 failures (AC expansion, collapse button, coverage
      indicator, markdown renderer, linked task section, trait chips,
      slide-over panel selectors)
    - search.spec.ts: subset of ~15 failures (placeholder text, no-results
      message, result grouping, ARIA attributes, keyboard navigation)
    - tasks.spec.ts: ~4 failures (modal close, spec link, review badge,
      navigation link selectors)
    - task-board.spec.ts: subset (modal URL param trigger, close action)
    - validate.spec.ts: subset of ~8 (coverage percentage, clean message,
      count elements, severity grouping, skeleton testid)
    - reviews-detail.spec.ts: subset of ~6 (revision selector, badge
      structure, kind badge markup)
    - triage.spec.ts, navigation.spec.ts, inbox.spec.ts: 1-2 each

    Can be parallelized — each spec file is independent.
  priority: 2
  tags: [test, e2e]

- title: "Fix timing and race condition e2e failures"
  slug: task-fix-timing-races
  depends_on: ["@task-fix-loading-page-e2e"]
  description: |
    What: Approximately 38 e2e test failures are caused by timing and race
    condition issues where tests assert on UI state before asynchronous
    operations have completed. Common patterns include: WebSocket
    subscription not established before testing real-time features, dialog
    open/close animations not finished, keyboard event handlers not yet
    registered, search debounce timers still pending, and scroll or
    navigation state not settled.

    Why: These tests verify real asynchronous behavior (WebSocket updates,
    dialog interactions, search-as-you-type) but use insufficient wait
    strategies. The features work correctly for users but the tests race
    against async operations. This task depends on @task-fix-loading-page-e2e
    because some timing failures may be masked by or compound with the
    loading state bug.

    How: For each timing failure, identify the async operation being raced
    and add the appropriate Playwright wait pattern:

    - WebSocket readiness: Before testing WS-dependent features, wait for
      the connection indicator element (data-testid or text "Connected")
      to be visible. The connection.svelte store manages WS state and the
      Sidebar.svelte component renders the indicator.
    - Dialog animations: After triggering dialog open/close, use
      await expect(dialog).toBeVisible() or .toBeHidden() instead of
      fixed setTimeout delays. Svelte transitions take variable time.
    - Keyboard handlers: After page.goto(), wait for a known interactive
      element to be ready before sending keyboard events (e.g. wait for
      the command palette trigger to be attached)
    - Search debounce: The CommandPalette.svelte uses a 300ms debounce.
      After typing, use page.waitForResponse() or waitFor on result
      elements rather than fixed delays.
    - Navigation: After goto() or click(), use page.waitForURL() or
      waitFor on destination content rather than assuming immediate state.

    Affected specs (from failure categorization):
    - search.spec.ts: ~10 failures (Cmd+K handler, debounce, result
      clearing, navigation, palette reset, Escape key)
    - automation-session-idle.spec.ts: ~9 failures (WebSocket subscription
      timing, event arrival within test window)
    - agents.spec.ts: subset (dispatch start/stop state propagation,
      edit dialog data loading, dialog close animation)
    - task-board.spec.ts: subset (WebSocket message timing, modal open)
    - cache-warming-views.spec.ts: subset (cache warming cycle timing,
      retry exhaustion)
    - connection.spec.ts: 2 failures (WebSocket reconnection backoff)
    - sessions.spec.ts: subset (scroll events, WebSocket event arrival)

    Can be parallelized — each spec file is independent.
  priority: 2
  tags: [test, e2e]

- title: "Fix stale fixture and envelope drift e2e failures"
  slug: task-fix-fixtures-envelope
  description: |
    What: Approximately 15 e2e failures are caused by two related issues:
    (1) Test fixture YAML files in tests/e2e/fixtures/ contain data that
    doesn't match the current Zod schemas in src/schema/, causing the
    daemon to reject or misinterpret fixture data. (2) A small number of
    tests expect API responses in the old unwrapped format ({items, total})
    when the daemon now wraps responses in the {data, meta} envelope via
    wrapResponse() from packages/daemon/src/routes/response-envelope.ts,
    or vice versa.

    Why: The fixture data was written against earlier schema versions and
    hasn't been updated as schemas evolved. The envelope migration wrapped
    most endpoints in {data, meta: {cache_status, total, ...}} format but
    some test assertions still expect the old shape. These are mechanical
    mismatches — the features work correctly, only the test data and
    assertions are stale.

    How:
    Stale fixtures (10 failures):
    1. For each failing test, check the daemon's console output or response
       body to identify what the daemon rejects or returns differently
    2. Compare the fixture YAML (e.g. tests/e2e/fixtures/project.tasks.yaml,
       project.reviews.yaml, modules/core.yaml) against the corresponding
       Zod schema in src/schema/ (TaskSchema, ReviewSchema, ItemSchema etc.)
    3. Update fixture data to conform to current schemas — add missing
       required fields, fix enum values, update nested structure
    4. Run the individual spec to confirm

    Envelope drift (5 failures):
    1. For each failure, check whether the daemon endpoint uses wrapResponse
       (grep for wrapResponse in packages/daemon/src/routes/<domain>.ts)
    2. Check whether the client API function (packages/web-ui/src/lib/api.ts)
       uses unwrapEnvelope/unwrapPaginatedEnvelope/unwrapListEnvelope
    3. If the daemon wraps but the test expects unwrapped: update the test
       assertion to account for the {data, meta} envelope
    4. If the client unwraps but the daemon doesn't wrap (e.g. automation
       routes /api/hooks, /api/schedules, /api/events/recent return raw
       {items, total} without envelope): the pair is intentionally
       consistent, check if the test itself is wrong

    Affected specs: plans.spec.ts (stale fixtures for plan ref resolution),
    reviews-detail.spec.ts (interaction fixture data), items.spec.ts
    (AC fixture schema), session-context.spec.ts (spec filter fixture),
    triage.spec.ts (triage action fixture), static-mode.spec.ts (envelope
    format in static responses), dashboard.spec.ts (2 aggregation count
    assertions expecting unwrapped data).
  priority: 2
  tags: [test, e2e]

- title: "Rewrite api-websocket spec as behavioral UI e2e tests"
  slug: task-rewrite-websocket-e2e
  depends_on: ["@task-fix-query-loading-state"]
  description: |
    What: tests/e2e/api-websocket.spec.ts contains 14 tests that verify
    the WebSocket protocol by using page.evaluate() to open raw WebSocket
    connections from the browser context. These test protocol-level
    concerns (message format, ack/nack, subscribe commands, close codes,
    heartbeat ping/pong) rather than user-visible behavior. They should
    be split into two groups: behavioral UI tests (stays in Playwright)
    and protocol tests (moves to vitest).

    Why: API-level WebSocket protocol tests don't need a browser — opening
    a raw WS connection via page.evaluate() is an unnecessary indirection
    when a vitest test can use the ws npm package or Bun's native WebSocket
    client directly. Meanwhile, there are zero e2e tests that verify
    WebSocket-driven UI features from the user's perspective: real-time
    data updates, connection status display, and live streaming. These
    behavioral tests are the actual coverage gap.

    How:
    Behavioral UI tests (new Playwright spec, e.g. websocket-ui.spec.ts):
    - Connection indicator: Navigate to any page, verify the sidebar shows
      "Connected" text (rendered by Sidebar.svelte from the connection
      store at packages/web-ui/src/lib/stores/connection.svelte)
    - Real-time task updates: Navigate to /tasks, use the daemon fixture's
      API to change a task status (POST /api/tasks/:ref/start), verify the
      task list updates without page refresh
    - Real-time inbox count: Navigate to /inbox, POST /api/inbox to add an
      item, verify the sidebar inbox badge count increments
    - Agent streaming: Navigate to / (dashboard), start dispatch via API,
      verify the active fleet section appears with streaming output
    - Disconnection: Stop the daemon, verify "Disconnected" indicator
      appears; restart, verify reconnection

    These tests depend on @task-fix-query-loading-state because pages must
    render content before WebSocket-driven updates can be observed.

    Protocol tests (new vitest spec under tests/daemon-api/):
    - Move raw protocol assertions (message format {action, request_id,
      payload}, ack format {ack, request_id, success}, subscribe command,
      close codes 1000/1001, heartbeat timing) to a vitest test that
      connects to the daemon using a WebSocket client library
    - These need a real running daemon (unlike HTTP tests that use
      app.handle()), so use the daemon subprocess pattern with
      ephemeral port allocation

    Original spec covers these ACs (preserve coverage in new locations):
    @api-contract ac-25 through ac-31, @trait-websocket-protocol ac-1
    through ac-5, @daemon-server ac-4.
  priority: 3
  tags: [test, e2e, web-ui]

- title: "Add file watcher e2e behavioral tests"
  slug: task-add-filewatcher-e2e
  depends_on: ["@task-fix-query-loading-state"]
  description: |
    What: Write Playwright e2e tests that verify file system changes in
    the .kspec/ directory propagate through the daemon's file watcher,
    through WebSocket broadcasts, and into the web UI — all without the
    user manually refreshing the page. Currently there are zero UI-level
    tests for this end-to-end flow.

    Why: The daemon watches .kspec/ for file changes (via
    ProjectContextManager.startWatcher in packages/daemon/src/server.ts)
    and broadcasts updates over WebSocket topics (tasks:updates,
    items:updates, inbox:updates, files:updates). The web UI's centralized
    ws-invalidation.ts handler receives these broadcasts and invalidates
    TanStack Query caches, causing affected views to refetch. This entire
    pipeline was previously only tested at the API level in
    api-watcher.spec.ts, which verified file change detection and
    WebSocket broadcast but never checked if the UI actually updated.

    How: Write a new spec file tests/e2e/file-watcher.spec.ts:
    1. Navigate to /tasks, wait for content to render
    2. Write a modified project.tasks.yaml to the daemon fixture's
       kspecDir (daemon.kspecDir from the test fixture) that adds or
       changes a task
    3. Wait for the tasks list to update (use Playwright waitFor on the
       new/changed task element, with a reasonable timeout like 5s)
    4. Verify the updated task appears in the UI without page refresh

    Additional test cases:
    - Modify project.inbox.yaml, verify inbox count updates in sidebar
    - Modify modules/core.yaml, verify items view updates
    - Multi-project isolation: Create a second project via
      daemon.createSecondProject(), modify its files, verify the first
      project's view is unaffected

    Platform note: File watcher tests must be skipped in CI because
    GitHub Actions runners don't support recursive fs.watch reliably.
    Use testInfo.skip() with a CI environment check (process.env.CI).
    This matches the existing pattern in api-watcher.spec.ts.

    This task depends on @task-fix-query-loading-state because the file
    watcher flow ends at TanStack Query cache invalidation — if the
    loading bug prevents queries from rendering data, file change
    propagation can't be observed.
  priority: 3
  tags: [test, e2e, web-ui]

- title: "Add e2e tests for batch item fetch UI behavior"
  slug: task-e2e-batch-item-fetch
  depends_on: ["@task-fix-stale-selectors"]
  description: |
    What: Write Playwright e2e tests that exercise the batch item fetch
    API endpoint (POST /api/items/batch) through UI flows that depend on
    it. The batch endpoint is called by the web UI's fetchBatchItems()
    function in packages/web-ui/src/lib/api.ts to resolve multiple item
    references in a single request — used when rendering task details
    that link to spec items, and item views that display trait references.

    Why: The batch item fetch API has 5 acceptance criteria
    (@batch-item-fetch-api ac-1 through ac-5) covering: valid ref
    resolution, unresolved ref handling, task ref resolution, empty batch,
    and batch size limits. These are currently only tested in the API-only
    spec api-items.spec.ts (being migrated to vitest in
    @task-migrate-api-tests-vitest). After migration, the API contract is
    covered in vitest but no e2e test verifies that the UI correctly
    renders batch-fetched data. If the batch endpoint works but the UI
    fails to call it or render results, no test would catch that.

    How: Add test cases to the existing tests/e2e/items.spec.ts and/or
    tests/e2e/tasks.spec.ts:
    1. Navigate to a task detail view where the task has a spec_ref
       linking to a spec item. Verify the linked spec item title and
       type are displayed (exercises batch fetch for spec item resolution).
    2. Navigate to an item detail view where the item has traits. Verify
       trait chips render with correct names (exercises batch fetch for
       trait reference resolution).
    3. Navigate to a task detail that references a nonexistent spec item.
       Verify the UI shows the raw ref gracefully rather than crashing
       (exercises unresolved ref handling).

    The test fixtures in tests/e2e/fixtures/ already include tasks with
    spec_ref fields (project.tasks.yaml) and items with traits
    (modules/core.yaml). Verify these fixture relationships are intact
    before writing tests; update fixtures if needed.

    This task depends on @task-fix-stale-selectors because the items and
    tasks specs need working selectors before new test cases can be added.
  priority: 3
  tags: [test, e2e, web-ui]

- title: "Add e2e tests for session full-text search"
  slug: task-e2e-session-search
  depends_on: ["@task-fix-timing-races"]
  description: |
    What: Write Playwright e2e tests that verify session full-text search
    works through the sessions page UI at /sessions. The sessions page has
    a search mode toggle that switches between the paginated session list
    and a search view.

    Why: Session full-text search has 2 acceptance criteria
    (@session-text-search ac-api-search for search functionality and
    ac-performance for search with metadata filters) that are currently
    only tested in the API-only spec api-sessions-search.spec.ts (3 tests,
    being migrated to vitest in @task-migrate-api-tests-vitest). No e2e
    test verifies that a user can type a search query in the sessions page
    and see matching results. The sessions page implements search mode
    via a toggle in packages/web-ui/src/routes/sessions/+page.svelte
    (searchMode state controls which query is enabled: the paginated list
    query or the search query).

    How: Add test cases to tests/e2e/sessions.spec.ts:
    1. Navigate to /sessions, activate search mode (click the search
       toggle or use the search input)
    2. Type a search query that matches fixture session data
    3. Verify matching session entries appear in the results
    4. Type a query that matches nothing, verify empty state message
    5. Combine search with a filter (e.g. status filter), verify results
       are filtered correctly
    6. Verify search input has debounce behavior — typing quickly should
       not fire a request per keystroke (use page.waitForResponse to
       count network requests)

    The test fixtures need session data with searchable content. Check
    whether tests/e2e/fixtures/ includes session YAML files; if not,
    create fixture session data that contains known searchable text.

    This task depends on @task-fix-timing-races because the sessions spec
    already has timing failures related to search debounce and async state
    updates; those must be fixed before adding new search tests.
  priority: 3
  tags: [test, e2e, web-ui]

- title: "Add e2e tests for triage export flow"
  slug: task-e2e-triage-export
  depends_on: ["@task-fix-fixtures-envelope"]
  description: |
    What: Write Playwright e2e tests that verify the triage export feature
    works through the triage page UI at /triage. The export endpoint
    (GET /api/triage/export) returns triage records formatted as markdown
    or JSON, and the triage UI should provide a way to trigger and view
    this export.

    Why: Triage export has 1 acceptance criterion (@triage-daemon-api ac-6:
    GET /api/triage/export returns context markdown or JSON) that is
    currently only tested in the API-only spec api-triage.spec.ts (being
    migrated to vitest in @task-migrate-api-tests-vitest). No e2e test
    verifies the export flow from the user's perspective.

    How:
    1. First check whether the triage page
       (packages/web-ui/src/routes/triage/+page.svelte) has an export
       action in the UI. If it does: write tests that click the export
       button and verify the exported content appears or downloads.
    2. If the triage page does not yet have an export UI action: this task
       should document that the export feature exists at the API level but
       has no UI surface, and create an inbox item for adding the UI.
    3. If export UI exists, add test cases to tests/e2e/triage.spec.ts:
       - Click export action, verify markdown/JSON content is displayed
       - Verify exported content includes triage record data from fixtures
         (tests/e2e/fixtures/project.triage.yaml has triaged, acted_on,
         and pending records)
       - If format selection exists, test both markdown and JSON formats

    This task depends on @task-fix-fixtures-envelope because the triage
    spec has fixture data that may need updating before new tests work.
  priority: 3
  tags: [test, e2e, web-ui]

- title: "Address excessive WebSocket query invalidation during dispatch"
  slug: task-fix-ws-invalidation-storm
  description: |
    What: When the dispatch engine is running with active agent invocations,
    the web UI's centralized WebSocket invalidation handler in
    packages/web-ui/src/lib/query/ws-invalidation.ts fires
    queryKeys.agents.all invalidation for every message_complete,
    thinking_complete, and tool_call_complete WebSocket event on the
    "agents" topic. During active agent work, these events fire every few
    seconds, causing the agent/status API endpoint to be re-fetched
    continuously in a tight loop.

    Why: HAR capture evidence (2026-03-30) shows 22 rounds of
    GET /api/agent/status fetches over 45 seconds on the /automation page
    with a single active agent invocation. Each fetch takes 400-800ms.
    This wastes bandwidth, creates unnecessary daemon load, and may cause
    visual flickering once the loading state bug (@task-fix-query-loading-state)
    is fixed. The ws-invalidation.ts handler at lines 65-91 already filters
    out streaming progress events (message_progress, thinking_progress,
    etc.) to avoid cache thrashing, but the corresponding completion events
    (message_complete, thinking_complete, tool_call_complete) are not
    filtered and they trigger full agents.all invalidation.

    How: Modify the "agents" case in getInvalidationKeys() in
    packages/web-ui/src/lib/query/ws-invalidation.ts:
    1. Add message_complete, thinking_complete, and tool_call_complete to
       the set of events that get scoped invalidation instead of blanket
       agents.all invalidation
    2. For these completion events, only invalidate session-scoped queries
       (queryKeys.sessions.all) since they signal that a message/thought
       finished — relevant for session detail views but not for the
       agent status or definitions queries
    3. Keep the existing behavior for agent_invocation lifecycle events
       (started, completed, failed) — these should continue to invalidate
       queryKeys.agents.all because they represent actual changes to
       dispatch state (new invocation, invocation finished)
    4. Verify by running the web UI with dispatch active and confirming
       agent/status is not re-fetched on every message completion
  priority: 2
  tags: [bug, web-ui, perf]

- title: "Validate and expand CI e2e gate to full suite"
  slug: task-ci-full-e2e
  depends_on:
    - "@task-fix-loading-page-e2e"
    - "@task-fix-stale-selectors"
    - "@task-fix-timing-races"
    - "@task-fix-fixtures-envelope"
  description: |
    What: Expand the CI e2e test gate from the current 2-spec smoke test
    to run the full Playwright e2e suite. Currently, the GitHub Actions
    workflow at .github/workflows/test.yml runs only tests/e2e/smoke.spec.ts
    and tests/e2e/api-server.spec.ts (which is itself skipped) via the
    npm run test:e2e script in package.json.

    Why: The current CI gate provides almost no e2e coverage — smoke.spec.ts
    tests basic page loads and sidebar navigation, nothing else. The full
    suite (npm run test:e2e:full in package.json, which runs
    npx playwright test against all specs in tests/e2e/) exists but is
    not wired into CI. Once the dependent tasks fix the failing tests,
    the full suite should pass and CI should enforce it to prevent future
    regression.

    How:
    1. After all dependent tasks are complete, run the full suite locally:
       npm run test:e2e:full
       Confirm the pass rate (should be 100% or near it; document any
       intentionally skipped tests and why)
    2. Time the full suite under CI-like conditions:
       npx playwright test --workers=2 --retries=2
       (CI uses 2 workers and 2 retries per playwright.config.ts)
    3. If total time is acceptable (under ~5 minutes): change the test:e2e
       script in package.json from running specific specs to running the
       full suite (npm run build:e2e && npx playwright test)
    4. If total time is too long: identify a meaningful subset of specs
       that covers the most critical paths, or implement Playwright
       sharding (--shard=1/N) with parallel CI jobs
    5. Update .github/workflows/test.yml if any workflow changes are needed
       (e.g. additional parallel jobs, timeout adjustments)
    6. The vitest-migrated API contract tests (@task-migrate-api-tests-vitest)
       will already run in the npm test shards, so API coverage is in CI
       regardless of this task
  priority: 3
  tags: [ci, e2e, infra]
```

## Implementation Notes

### Reviewer guidance: expected e2e test state during plan execution

The e2e suite has 155 known failures and 15 skipped API-only specs (279
tests) at the start of this plan. During execution, reviewers should
expect e2e failures and skips outside the scope of the task under review:

- **@task-fix-query-loading-state**: The full e2e suite will still have
  ~109 non-loading failures (selectors, timing, fixtures). Only the
  loading-affected pages (/, /agents, /automation) should be verified
  as rendering content on fresh load. Running the full suite is not a
  gate for this task.
- **@task-fix-loading-page-e2e**: Only dashboard.spec.ts, agents.spec.ts,
  and automation.spec.ts should pass. Other specs will still fail.
- **@task-migrate-api-tests-vitest**: The 15 skipped Playwright specs
  are being replaced by vitest tests. Verify the new vitest tests pass;
  the skipped Playwright specs will be deleted as part of this task.
  Other e2e failures are unrelated.
- **@task-fix-stale-selectors, @task-fix-timing-races, @task-fix-fixtures-envelope**:
  Each fixes a category of failure across multiple specs. Verify that
  the specific category is resolved in the affected specs listed in the
  task description. Other failure categories in those same specs may
  still be present if the other fix tasks haven't completed yet.
- **@task-rewrite-websocket-e2e, @task-add-filewatcher-e2e, @task-e2e-batch-item-fetch,
  @task-e2e-session-search, @task-e2e-triage-export**: These add new
  tests. Verify the new tests pass. Existing failures elsewhere are
  unrelated.
- **@task-fix-ws-invalidation-storm**: This is a code fix, not a test
  fix. Verify via manual observation (or HAR capture) that agent/status
  is not re-fetched on every message completion event. E2e test state
  is unrelated.
- **@task-ci-full-e2e**: This is the final gate. By this point all
  dependent tasks should be complete and the full suite should pass.
  If it doesn't, the remaining failures are blockers for this task.

### Investigation findings (2026-03-30)

**Failure categorization (155 test failures across 30 UI specs):**
- loading-never-resolves: 46 (30%) — dashboard, agents, automation, workflows, validate, sessions
- timing-race: 38 (25%) — WebSocket, dialog animation, keyboard, debounce, scroll
- stale-selector: 35 (23%) — testid/CSS selectors outdated after UI refactors
- stale-fixture: 10 (7%) — test data schemas out of sync
- envelope-drift: 5 (3%) — response wrapping inconsistencies
- removed-feature: 1 (<1%) — agent trigger editing moved to automation view

**Loading state bug — confirmed behavior via HAR capture:**
- All API requests fire and complete with 200 OK and valid data
- No CacheWarmingError, no retry loops (in clean project without dispatch)
- UI stays in loading skeleton forever
- Navigating away and back renders correctly (cached data)
- Bug has existed since these pages were built; no previous fix attempt has ever succeeded
- Hypothesis: TanStack Query Svelte v6 createRawRef proxy $state.raw updates
  don't trigger Svelte $derived re-evaluation. MUST be proven with runtime
  instrumentation before writing any fix code.

**WebSocket invalidation storm (separate from loading bug):**
- With dispatch running, message_complete/thinking_complete events fire
  continuously, each invalidating queryKeys.agents.all
- Creates perpetual refetch cycle (~20 rounds of agent/status over 45s)
- Compounds loading bug and will cause perf issues even after loading is fixed

**API-only test migration:**
- 15 specs, 279 tests already skipped with migration notes
- Existing app.handle() pattern in tests/daemon-api-input-validation.test.ts
- No daemon startup needed — direct Elysia app invocation
- api-websocket.spec.ts stays in Playwright but rewrites as behavioral UI tests

**Coverage gaps exposed by API test migration:**
- WebSocket-driven UI updates: zero behavioral e2e coverage
- File watcher propagation to UI: zero behavioral e2e coverage
- Batch item fetch (@batch-item-fetch-api ac-1..5): used internally by task
  detail and item views, no UI test exercises the batch resolution path
- Session full-text search (@session-text-search ac-api-search, ac-performance):
  no UI test for the sessions search flow
- Triage export (@triage-daemon-api ac-6): no UI test for export action
- Most other API-only ACs (56 total) ARE exercised through existing UI e2e
  tests that are currently broken — fixing those tests restores coverage
