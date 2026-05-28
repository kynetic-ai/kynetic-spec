# Daemon Optimistic Data Layer

## Specs

```yaml
# ─── Server-Side Cache ───

- title: Daemon Entity Cache
  slug: daemon-entity-cache
  type: feature
  parent: "@daemon-server"
  description: |
    Server-side in-memory cache for entity data served by the daemon API.
    The cache uses a two-tier model: index data (summaries, counts,
    references) is kept hot in memory, while detail data (full content,
    notes, event logs) is loaded on demand when accessed. The file watcher
    drives cache invalidation — when shadow branch files change, affected
    data is selectively reloaded. Data domains load progressively so
    high-priority data is available before the full cache is ready.
  acceptance_criteria:
    - id: ac-load-on-register
      given: |
        a project is registered with the daemon
      when: |
        the project's shadow branch directory is accessible
      then: |
        index-tier entity data is loaded into memory and available for
        serving
    - id: ac-serve-from-memory
      given: |
        a project's index data has been loaded into the cache
      when: |
        an API list or summary request arrives for that project
      then: |
        the response is served from the in-memory cache without reading
        files from disk or running git operations
    - id: ac-detail-on-demand
      given: |
        a request arrives for a single entity's full detail
      when: |
        the detail data is not in the cache
      then: |
        the detail is loaded from disk, served, and optionally retained
        in cache until the next invalidation
    - id: ac-watcher-invalidation
      given: |
        the file watcher detects a change to a shadow branch file
      when: |
        the changed file belongs to a registered project
      then: |
        the affected data domain is reloaded from disk and the cache is
        updated before any subsequent request is served
    - id: ac-granular-reload
      given: |
        a file change affects only one data domain
      when: |
        the cache processes the invalidation
      then: |
        only the affected domain is reloaded, not unrelated domains
    - id: ac-write-through
      given: |
        a write operation mutates entity data through the daemon API
      when: |
        the mutation succeeds and is committed to the shadow branch
      then: |
        the cache is updated with the new state before the response is
        sent, without waiting for the file watcher to detect the change
    - id: ac-concurrent-reads
      given: |
        multiple API requests arrive concurrently for the same project
      when: |
        the cache is populated
      then: |
        all requests are served from the same cached data without
        blocking on each other or triggering redundant loads
    - id: ac-reload-dedup
      given: |
        multiple file changes arrive within a short window
      when: |
        the cache processes the invalidation events
      then: |
        only a single reload is performed for each affected data domain,
        not one per file change event
    - id: ac-graceful-degradation
      given: |
        the cache encounters an error loading entity data
      when: |
        an API request arrives
      then: |
        the request falls back to direct file reading and the error is
        logged, rather than failing the request entirely
    - id: ac-project-isolation
      given: |
        multiple projects are registered with the daemon
      when: |
        one project's cache is invalidated
      then: |
        other projects' cached data is not affected or reloaded
    - id: ac-unregister-cleanup
      given: |
        a project is unregistered from the daemon
      when: |
        the project context is removed
      then: |
        all cached data for that project is released from memory
    - id: ac-session-bounded-index
      given: |
        a project has more sessions than the configured retention window
      when: |
        the session index is loaded or refreshed
      then: |
        only the most recent sessions (up to the configured limit) are
        retained in the index; older sessions are accessible on demand
        but not held in the cache
    - id: ac-session-stale-exclusion
      given: |
        a session has active status but exceeds the stale session
        criteria (age and inactivity thresholds)
      when: |
        the session index is loaded or refreshed
      then: |
        the session is not treated as active in the cached index
    - id: ac-warming-availability
      given: |
        a project is registered and cache loading is in progress
      when: |
        an API request arrives before loading completes
      then: |
        the request receives a response indicating the data is still
        loading rather than blocking until the full cache is ready
    - id: ac-progressive-loading
      given: |
        a project begins cache loading on registration
      when: |
        high-priority data domains finish loading before others
      then: |
        requests for loaded domains are served from cache immediately
        while remaining domains continue loading

- title: Daemon Read Path Optimization
  slug: daemon-read-path
  type: requirement
  parent: "@daemon-entity-cache"
  description: |
    API read routes serve responses from the entity cache. Per-request
    sync operations move to the background sync scheduler so that read
    requests involve no git operations or filesystem reads.
  acceptance_criteria:
    - id: ac-no-per-request-sync
      given: |
        the daemon is running with a registered project
      when: |
        a read-only API request arrives
      then: |
        no git operations are performed as part of handling the request
    - id: ac-background-sync
      given: |
        the daemon's sync interval elapses
      when: |
        the background sync scheduler runs
      then: |
        drift-check and pull happen in the background, and if new data
        is pulled, the entity cache is invalidated and reloaded
    - id: ac-index-from-cache
      given: |
        a route needs a reference index or alignment index
      when: |
        the request handler builds the index
      then: |
        the index is built from cached entity data, not from fresh
        disk reads
    - id: ac-write-routes-sync
      given: |
        a write operation is received through the daemon API
      when: |
        the daemon processes the mutation
      then: |
        the daemon commits the change to the shadow branch using the
        standard write path before updating the cache

# ─── CLI Proxy ───

- title: CLI Daemon Proxy Mode
  slug: cli-daemon-proxy
  type: feature
  parent: "@cli"
  description: |
    When a daemon is running, the CLI routes commands through it instead
    of operating directly on the shadow branch. This makes the daemon
    the single writer, eliminating coherence issues between CLI mutations
    and daemon state. The CLI auto-detects daemon availability and routes
    accordingly. Users can force either mode explicitly.
  traits:
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-auto-detect
      given: |
        the user runs a kspec command
      when: |
        a daemon is running and reachable for the current project
      then: |
        the command is routed through the daemon's API rather than
        operating directly on the shadow branch
    - id: ac-direct-fallback
      given: |
        the user runs a kspec command
      when: |
        no daemon is running or the daemon is unreachable
      then: |
        the command operates directly on the shadow branch
    - id: ac-force-direct
      given: |
        KSPEC_NO_DAEMON=1 is set
      when: |
        the user runs a kspec command
      then: |
        the command operates directly on the shadow branch, bypassing
        daemon routing
    - id: ac-force-proxy
      given: |
        the user runs a kspec command with --daemon flag
      when: |
        no daemon is running
      then: |
        the command fails with a clear error indicating no daemon is
        available
    - id: ac-transparent-output
      given: |
        a command is routed through the daemon
      when: |
        the command completes
      then: |
        the output format, content, and exit code are identical to
        direct mode
    - id: ac-mutation-coherence
      given: |
        a CLI mutation is routed through the daemon
      when: |
        the mutation succeeds
      then: |
        the daemon's entity cache reflects the change immediately and
        subsequent requests from any client see the updated data
    - id: ac-read-from-cache
      given: |
        a CLI read command is routed through the daemon
      when: |
        the daemon has cached data for the project
      then: |
        the response is served from the daemon's cache
    - id: ac-timeout-fallback
      given: |
        the daemon responds to a health check but a routed read-only
        command does not complete within the timeout period
      when: |
        the timeout expires
      then: |
        the CLI falls back to direct mode for the read-only command and
        emits a warning on stderr indicating the daemon is not responding
    - id: ac-timeout-mutation-error
      given: |
        the daemon responds to a health check but a routed mutating
        command does not complete within the timeout period
      when: |
        the timeout expires
      then: |
        the CLI returns an error instead of falling back to direct mode,
        because the daemon may still be processing the mutation

- title: Daemon Command API
  slug: daemon-command-api
  type: requirement
  parent: "@cli-daemon-proxy"
  description: |
    REST endpoint that accepts CLI command payloads and executes them
    within the daemon process, returning structured results. Serves as
    the server-side counterpart to CLI daemon proxy mode.
  traits:
    - trait-api-endpoint
    - trait-localhost-security
  acceptance_criteria:
    - id: ac-command-endpoint
      given: |
        the daemon is running
      when: |
        a POST request is sent to the command execution endpoint with
        a command payload
      then: |
        the daemon executes the command and returns the result with
        stdout, stderr, and exit code
    - id: ac-mutation-cache-update
      given: |
        a command payload contains a mutating command
      when: |
        the command executes successfully
      then: |
        the entity cache is updated before the response is sent and
        a WebSocket event is broadcast to connected clients
    - id: ac-batch-support
      given: |
        a command payload contains a batch of commands
      when: |
        the batch is executed
      then: |
        all commands in the batch execute atomically and the cache
        is updated once after the batch completes
    - id: ac-concurrent-mutations
      given: |
        two command requests arrive concurrently with mutating commands
      when: |
        both attempt to modify shadow branch state
      then: |
        mutations are serialized to prevent conflicts and both callers
        receive correct results
    - id: ac-response-parity
      given: |
        a command is executed through the command API
      when: |
        the result is returned
      then: |
        the response body contains the same stdout and stderr content
        that would be produced by direct CLI execution of the same
        command

- title: Daemon Proxy Detection
  slug: daemon-proxy-detection
  type: requirement
  parent: "@cli-daemon-proxy"
  description: |
    The CLI detects whether a daemon is available and routes commands
    accordingly. Detection is fast and does not add perceptible latency
    to command startup.
  acceptance_criteria:
    - id: ac-port-file-check
      given: |
        the CLI starts up
      when: |
        it checks for daemon availability
      then: |
        it reads the daemon port file at the standard location and
        attempts a health check on that port
    - id: ac-fast-detection
      given: |
        no daemon is running
      when: |
        the CLI checks for daemon availability
      then: |
        the check completes within 50ms by failing fast on missing
        port file or connection refused
    - id: ac-health-timeout
      given: |
        a port file exists but the daemon is unresponsive
      when: |
        the CLI sends a health check
      then: |
        the health check times out within 200ms and the CLI falls
        back to direct mode
    - id: ac-project-registered
      given: |
        the daemon is running but the current project is not registered
      when: |
        the CLI detects the daemon
      then: |
        the CLI registers the project with the daemon before routing
        the command
```

## Tasks

derive_from_specs: false

```yaml
- title: Implement entity cache with tiered storage and watcher invalidation
  slug: task-entity-cache-impl
  priority: 1
  tags: [daemon, implementation, cache]
  spec_ref: "@daemon-entity-cache"
  description: |
    Build the entity cache with two-tier storage (index hot, detail on
    demand) and wire it to the existing file watcher for invalidation.
    Integrate with the project registration lifecycle.

    Why: The daemon currently re-reads all YAML files and rebuilds indexes
    on every API request. initContext() + loadAllItems() + loadAllTasks()
    runs on every route handler. The entity cache eliminates this by
    loading index data once on project registration and serving from
    memory, with the file watcher driving selective reloads on change.

    What:
    - Implement ProjectEntityCache class with per-domain storage. Each
      domain has an index tier (always hot) and a detail tier (loaded on
      demand, evicted on invalidation). See the cache tiering table in
      Implementation Notes for what goes where per domain.
    - Wire to file watcher in packages/daemon/src/watcher.ts — add cache
      invalidation alongside the existing WebSocket broadcast. Map changed
      file paths to domains using the domain mapping table (see
      Implementation Notes).
    - Implement reload dedup using in-flight promise dedup (Map<domain,
      Promise>) — proven pattern from shadowPull(). Multiple file changes
      within the watcher's existing 500ms debounce window produce a single
      reload per affected domain.
    - Implement write-through: daemon API write routes update the cache
      before returning. Use a write-through flag that causes the watcher
      callback to skip the redundant reload for that domain.
    - Implement graceful degradation: if cache load fails for a domain,
      mark the domain as degraded, fall back to direct file reading for
      requests to that domain, and log the error.
    - Implement progressive loading: on project registration, load
      domains in priority order (tasks → items → meta → inbox → plans →
      triage → reviews → sessions). Serve loaded domains from cache
      immediately; unloaded domains return a loading indicator.
    - Implement session index bounding: cache only the N most recent
      session summaries (configurable, default 100). Apply stale session
      exclusion: sessions with active status that exceed the existing
      stale criteria (older-than + inactive-for thresholds from
      @session-stale-criteria) are not treated as active in the index.
      Sessions outside the window are loaded on demand when accessed by
      ID.
    - Implement project isolation: each registered project gets its own
      ProjectEntityCache instance. Watcher events are scoped to the
      project whose files changed.
    - On project unregister: release all cached data and cancel any
      in-flight reloads.
    - Absorb the existing SessionSummaryCache (src/sessions/cache.ts)
      into the unified cache — the session domain replaces the standalone
      session cache.

    How: The cache lives in packages/daemon/ alongside project-context.ts.
    ProjectContextManager.registerProject() creates the cache instance
    and starts the initial load. The watcher callback in
    packages/daemon/src/watcher.ts gets a second handler (alongside the
    existing WebSocket broadcast) that maps file paths to domains and
    calls cache.invalidateDomain(). Build the domain mapping from the
    same file patterns used by the existing YAML loading functions.

    For tasks: TaskDataManager already has listTasks() returning
    TaskSummary[] and rawToSummary() — use this as the index tier. Full
    task detail (notes, todos) loaded via getTask() on demand.

    For items: No ItemSummary type exists yet. Create one with the index
    fields (ulid, title, type, status, priority, tags, traits, parent
    path). Full item detail (ACs, description, notes) loaded on demand.

    For sessions: Reuse the existing stale criteria resolution from
    src/sessions/store.ts (resolveStaleSessionCriteria) to determine
    whether an active-status session should be treated as stale in the
    cache index.

    Covers: @daemon-entity-cache ac-load-on-register, ac-serve-from-memory,
    ac-detail-on-demand, ac-watcher-invalidation, ac-granular-reload,
    ac-write-through, ac-concurrent-reads, ac-reload-dedup,
    ac-graceful-degradation, ac-project-isolation, ac-unregister-cleanup,
    ac-session-bounded-index, ac-session-stale-exclusion,
    ac-warming-availability, ac-progressive-loading.

- title: Migrate daemon read routes to serve from entity cache
  slug: task-migrate-read-routes
  priority: 1
  tags: [daemon, implementation, routes]
  spec_ref: "@daemon-read-path"
  depends_on:
    - "@task-entity-cache-impl"
  description: |
    Update all daemon API read routes to serve from the entity cache
    instead of calling initContext() + loadAll* per request. Move
    per-request drift-check to the background sync scheduler.

    Why: The cache exists but routes still bypass it. This task connects
    routes to the cache and eliminates per-request filesystem I/O and
    git operations. This is where the user-visible performance improvement
    actually happens.

    What:
    - Replace initContext() + loadAllItems/loadAllTasks/loadPlans calls
      in every read route with cache lookups. Affected route files in
      packages/daemon/src/routes/: tasks.ts, items.ts, inbox.ts,
      plans.ts, triage.ts, reviews.ts, meta.ts, sessions.ts,
      aggregation.ts, validation.ts (includes search handling), refs.ts
    - List routes use the index tier; detail routes (GET by ref) use
      the detail tier (on-demand load if not cached)
    - Build ReferenceIndex and AlignmentIndex from cached index data
      rather than fresh disk reads
    - Move drift-check sync from per-request to background scheduler:
      the existing ShadowSyncScheduler in shadow-sync.ts already runs
      periodically — extend it to invalidate the entity cache when new
      data is pulled
    - Ensure write routes still apply mutations through the normal
      shadow branch commit path, using write-through to update the cache
    - Ensure API response payloads remain identical — field names,
      nesting, ordering must not change from the migration
    - Batch endpoints (e.g. @batch-item-fetch-api) also serve from cache

    How: Each route currently does:
      const ctx = await initContext(projectPath);
      const items = await loadAllItems(ctx);
    Replace with:
      const cache = getProjectCache(projectPath);
      const items = cache.getItemIndex();  // hot index tier
    For detail routes:
      const item = await cache.getItemDetail(ref);  // on-demand
    Background sync: add a post-pull hook to the existing
    ShadowSyncScheduler that calls cache.invalidate() when shadowPull()
    returns changes.

    Covers: @daemon-read-path ac-no-per-request-sync, ac-background-sync,
    ac-index-from-cache, ac-write-routes-sync.

- title: Implement daemon command API endpoint
  slug: task-daemon-command-api
  priority: 2
  tags: [daemon, api, proxy]
  spec_ref: "@daemon-command-api"
  depends_on:
    - "@task-entity-cache-impl"
  description: |
    Build the REST endpoint that accepts CLI command payloads and executes
    them within the daemon process, returning structured results.

    Why: For the CLI to proxy through the daemon, the daemon needs an
    endpoint that can execute arbitrary kspec commands. Without it, CLI
    mutations would still write directly to the shadow branch, creating
    a window of stale data in the daemon's cache.

    What:
    - POST /api/command endpoint that accepts a command payload using
      the same JSON format as kspec batch command objects (command path
      string + args object)
    - Execute the command within the daemon process using Commander's
      parseAsync with captured output streams — avoids child process
      overhead and keeps everything in the daemon's event loop
    - Capture stdout, stderr, and exit code; return as structured JSON
    - For mutating commands: serialize execution using the dispatch
      mutation lock pattern (acquireFileLock) to prevent concurrent
      shadow branch conflicts
    - After successful mutation: update entity cache (write-through)
      before returning the response, broadcast WebSocket event
    - Support batch payloads: accept an array of commands, execute
      atomically via the existing batch runner (src/cli/batch.ts),
      update cache once after the batch completes
    - Response parity: stdout/stderr content must match what direct CLI
      execution would produce

    How: Follow the pattern in packages/daemon/src/routes/agent-dispatch.ts
    for route structure and middleware. The command executor wraps
    Commander's parseAsync, redirecting process.stdout/stderr to buffers.
    Mutation serialization uses the same lock mechanism as the dispatch
    engine. Batch execution reuses the existing batch runner. Cache
    update happens after the commit but before the HTTP response.

    Covers: @daemon-command-api ac-command-endpoint, ac-mutation-cache-update,
    ac-batch-support, ac-concurrent-mutations, ac-response-parity.

- title: Implement CLI daemon proxy detection and routing
  slug: task-cli-proxy-routing
  priority: 2
  tags: [cli, daemon, proxy]
  spec_ref: "@cli-daemon-proxy"
  depends_on:
    - "@task-daemon-command-api"
    - "@task-migrate-read-routes"
  description: |
    Add daemon detection to CLI startup and command routing logic so
    commands are transparently proxied through the daemon when available.

    Why: With the entity cache and command API in place, the CLI can
    route through the daemon to make it the single writer. CLI mutations
    go through the daemon, the daemon updates its cache immediately,
    and all clients (web UI, other CLI instances, agents) see consistent
    state.

    What:
    - Daemon detection on CLI startup: read port file from
      ~/.config/kspec/daemon.port, send health check ping to that port
    - Fast failure: if port file doesn't exist or connection is refused,
      skip to direct mode within 50ms. If health check doesn't respond,
      timeout within 200ms and skip to direct mode.
    - Command routing: when daemon is detected, serialize the CLI
      command into a command API payload and POST to the daemon's
      command endpoint. Deserialize the response, write stdout/stderr
      to process streams, exit with the returned exit code.
    - Timeout handling: if a read-only command times out, fall back to
      direct mode and emit a warning on stderr. If a mutating command
      times out, return an error (no fallback) because the daemon may
      still be processing the mutation
    - KSPEC_NO_DAEMON=1: skip daemon detection entirely, go straight
      to direct mode
    - --daemon flag: require daemon routing, fail with clear error if
      daemon is unavailable (no fallback)
    - Project registration: if daemon is running but current project
      is not registered, register it before routing the command
    - Detection result cached for the CLI process lifetime — don't
      re-detect per subcommand

    How: Detection runs early in the CLI preAction hook
    (src/cli/index.ts). Use the existing port file reading logic from
    src/cli/commands/serve.ts. For command serialization, reuse the
    batch command JSON format (command path + args object). Use
    fetch() for HTTP calls — Bun and Node both support it natively.
    Cache the detection result in module-level state (same pattern as
    syncMode).

    Covers: @cli-daemon-proxy ac-auto-detect, ac-direct-fallback,
    ac-force-direct, ac-force-proxy, ac-transparent-output,
    ac-mutation-coherence, ac-read-from-cache, ac-timeout-fallback,
    ac-timeout-mutation-error.
    @daemon-proxy-detection ac-port-file-check, ac-fast-detection,
    ac-health-timeout, ac-project-registered.

- title: Narrow shadow-lazy-read-sync scope for daemon context
  slug: task-narrow-shadow-lazy-read-sync
  priority: 2
  tags: [specs, maintenance]
  spec_ref: "@shadow-lazy-read-sync"
  depends_on:
    - "@task-entity-cache-impl"
  description: |
    Add AC to @shadow-lazy-read-sync clarifying that drift-check applies
    to CLI direct-mode only; daemon reads use the entity cache with
    background sync instead of per-request drift-check.

    Why: The entity cache changes the daemon's read path. The existing
    drift-check contract still applies for CLI direct-mode but not for
    daemon-served reads.

    What:
    - Add an AC to @shadow-lazy-read-sync specifying that daemon reads
      bypass drift-check and rely on the background sync scheduler

    Covers: @shadow-lazy-read-sync (new AC for daemon context).

- title: Link session-summary-cache to unified entity cache
  slug: task-link-session-cache
  priority: 2
  tags: [specs, maintenance]
  spec_ref: "@session-summary-cache"
  depends_on:
    - "@task-entity-cache-impl"
  description: |
    Add relates_to @daemon-entity-cache on @session-summary-cache,
    noting that session caching is absorbed into the unified cache.

    Why: The standalone SessionSummaryCache is replaced by the session
    domain in the entity cache. The spec relationship documents this.

    What:
    - Add relates_to @daemon-entity-cache on @session-summary-cache

    Covers: @session-summary-cache (relationship update).

- title: Update daemon-server description for cache invalidation
  slug: task-update-daemon-server-desc
  priority: 2
  tags: [specs, maintenance]
  spec_ref: "@daemon-server"
  depends_on:
    - "@task-entity-cache-impl"
  description: |
    Update @daemon-server description to note that the file watcher
    drives both WebSocket broadcast and cache invalidation.

    Why: The entity cache adds a second responsibility to the file
    watcher. The spec description should reflect this.

    What:
    - Update @daemon-server description to mention cache invalidation
      alongside WebSocket broadcast

    Covers: @daemon-server (description update).

- title: Link multi-directory-daemon to CLI proxy mode
  slug: task-link-multi-dir-proxy
  priority: 2
  tags: [specs, maintenance]
  spec_ref: "@multi-directory-daemon"
  depends_on:
    - "@task-cli-proxy-routing"
  description: |
    Add relates_to @cli-daemon-proxy on @multi-directory-daemon.

    Why: CLI proxy mode interacts with multi-directory daemon support —
    the proxy must route to the correct project context.

    What:
    - Add relates_to @cli-daemon-proxy on @multi-directory-daemon

    Covers: @multi-directory-daemon (relationship update).
```

## Implementation Notes

### Cache Tiering Model

The cache uses a two-tier model: **index** (always hot in memory) and
**detail** (loaded on demand, evicted on domain invalidation).

| Domain | Index tier (hot) | Detail tier (on-demand) |
|--------|-----------------|------------------------|
| **Tasks** | TaskSummary[]: ulid, title, status, priority, tags, spec_ref, depends_on, timestamps, notes_count, todos_count | Full task: notes[], todos[], description, context |
| **Items** | ItemSummary[] (new type): ulid, title, type, status, priority, tags, traits[], parent path | Full item: acceptance_criteria[], description, notes[], implementation refs |
| **Meta** | All of it (~200KB, referenced constantly for agents, conventions, hooks) | — |
| **Inbox** | All of it (~30KB, items are tiny) | — |
| **Triage** | All of it (records are small, ~500B-2KB each) | — |
| **Plans** | PlanSummary: ulid, title, status, derived_tasks/specs counts, timestamps | Full content (markdown body, 5-50KB each) |
| **Reviews** | ReviewSummary: ulid, title, lifecycle_state, author, thread_count, verdict_count | Full threads[], checks[], verdicts[], events[] |
| **Sessions** | Bounded index of N recent session summaries (session.yaml metadata only) | events.jsonl (1.6MB+ per session, never cached) |

**Why these splits:**
- Tasks: `project.tasks.yaml` is 400KB+ but notes are the bulk. TaskSummary
  already exists via `rawToSummary()` in TaskDataManager. Most routes only
  need summaries for listing/filtering.
- Items: Module files total 1.2MB but ACs and descriptions are the bulk.
  List views only need title/status/type. ItemSummary doesn't exist yet —
  this task creates it.
- Plans: content field is 5-50KB of imported markdown. List views need title
  and status only. Currently plans are in a single file so detail loading
  means re-reading the whole file — acceptable for now, future optimization
  could split storage.
- Reviews: threads and verdicts can be substantial. List views only need
  counts and state.
- Sessions: events.jsonl is unbounded and should never be cached. Only
  session.yaml metadata (270 bytes) goes in the index.
- Meta, inbox, triage: small enough to keep entirely hot.

### Domain Mapping (file patterns → cache domain)

| Domain | File patterns | Load function |
|--------|---------------|---------------|
| tasks | `*.tasks.yaml` | loadAllTasks() / loadAllTaskSummaries() |
| items | `modules/*.yaml`, manifest includes | loadAllItems() |
| plans | `*.plans.yaml` | loadPlans() |
| inbox | `project.inbox.yaml` | loadInbox() |
| triage | `triage/` | loadTriageRecords() |
| reviews | `reviews/` | loadReviews() |
| meta | `kynetic.meta.yaml` | loadMeta() |
| sessions | `.kspec-sessions/*/session.yaml` | SessionSummaryCache |

The manifest (`kynetic.yaml`) invalidates items since it controls includes.

### Indexes

ReferenceIndex, AlignmentIndex, ItemIndex, and TraitIndex are rebuilt when
any of their source domains are invalidated. They are cached alongside
domain data and served to route handlers. This eliminates the per-request
buildIndexes() call. Indexes are built from index-tier data only — they
don't need full item/task detail.

### Progressive Loading Priority

1. Tasks and items (sidebar counts, dashboard, most-visited pages)
2. Meta (agent definitions, convention rules)
3. Inbox (badge counts)
4. Plans, triage, reviews, sessions (visited less frequently)

### Write-Through Protocol

1. Route handler receives mutation request
2. Handler executes the mutation (shadow branch commit)
3. Handler updates the cache with the new state directly
4. Handler sets a domain-level "just-written" flag
5. Handler returns the response
6. File watcher fires (from the git commit) — sees the flag, skips reload
7. Flag is cleared

### Session Index Bounding and Staleness

The session domain caches at most N recent session summaries (default 100).
Sessions are sorted by recency (started_at descending).

**Stale session exclusion:** Sessions with `active` status that meet the
existing stale criteria from `@session-stale-criteria` (older-than 24h AND
inactive-for 6h, resolved via `resolveStaleSessionCriteria()` in
`src/sessions/store.ts`) are not treated as active in the cache index.
This prevents old stuck sessions from inflating the active count and
consuming cache slots. The cache applies the same deterministic criteria
the CLI uses for `kspec session stale-close`.

Sessions outside the bounded window are loaded on demand when accessed by
ID but not retained in the index.

### Relationship to Existing Caching

@session-summary-cache established the pattern: load once, serve from memory,
invalidate on change. The entity cache generalizes this to all domains.
The standalone SessionSummaryCache is absorbed — the session domain in the
entity cache replaces it, keeping the same semantics (incremental invalidation,
active session refresh, persistent stats for terminal sessions).

@shadow-lazy-read-sync's drift-check contract continues for CLI direct-mode.
For daemon-served reads, the background sync scheduler (already running via
@shadow-daemon-push-sync) handles sync, and the entity cache handles serving.
The per-request initContext() drift-check is removed for daemon routes only.

### CLI Proxy Routing

The CLI serializes commands using the same JSON format as `kspec batch`
command objects. This means the command API endpoint can reuse the existing
batch command parser for both single commands and batch payloads.

Dispatch engine interaction: when agents are spawned by the dispatch engine,
their CLI calls auto-detect the running daemon and route through the command
API. This is the intended behavior — the daemon remains the single writer.
The command API's mutation serialization handles re-entrant calls the same
as any other client.
