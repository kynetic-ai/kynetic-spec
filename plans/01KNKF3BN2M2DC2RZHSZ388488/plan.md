# Cache-Aware Command Execution

## Specs

```yaml
# ─── New Spec: Concurrent Read Command Execution ───

- title: Concurrent Read Command Execution
  slug: daemon-concurrent-reads
  type: requirement
  description: |
    Read-only commands executed via the command API can complete
    concurrently when served from cached data. Mutating commands
    and commands that require disk access continue to execute
    sequentially to preserve data integrity.
  acceptance_criteria:
    - id: ac-concurrent-cache-reads
      given: |
        Multiple read-only commands are submitted to the command
        API concurrently and all required cache domains are in
        ready state
      when: |
        The commands execute
      then: |
        The commands complete without waiting for each other
    - id: ac-mutation-serialization
      given: |
        A mutating command is submitted to the command API
      when: |
        The command executes
      then: |
        The command executes sequentially with respect to other
        mutating commands and does not overlap with them
    - id: ac-disk-fallback-serialization
      given: |
        A read-only command is submitted to the command API but
        one or more required cache domains are not in ready state
      when: |
        The command falls back to disk-based data loading
      then: |
        The command executes sequentially to protect shared
        process state during disk-based execution
```

## Tasks

derive_from_specs: false

```yaml
# ─── Phase 1: Spec Updates ───

- title: Add cache-serving AC to daemon-command-api spec
  slug: task-update-command-api-spec
  priority: 1
  tags: [spec-update, daemon]
  spec_ref: "@daemon-command-api"
  description: |
    Add acceptance criteria to @daemon-command-api that specify
    cache-aware behavior for command execution.

    Why: The current @daemon-command-api spec requires response
    parity (ac-response-parity) and mutation cache updates
    (ac-mutation-cache-update) but does not specify that read
    commands should use cached data, that the cache should be
    accessible during command execution, or that commands running
    outside the daemon skip cache lookups. These behaviors are
    the core of this plan and need explicit spec coverage before
    implementation begins.

    What: Add three ACs to @daemon-command-api:

    ac-read-cache-serving:
      given: A read-only command is executed via the command API
             and the entity cache has all required domains in
             ready state
      when: The command resolves data
      then: Data is served from the entity cache without reading
            files from disk

    ac-cache-context-propagation:
      given: The daemon executes a CLI command via the command API
      when: The command begins execution
      then: The entity cache for the target project is accessible
            to data loading functions throughout the command's
            async execution chain

    ac-no-cache-outside-daemon:
      given: A CLI command runs in direct mode without the daemon
      when: Data loading functions are called
      then: Data is loaded from disk and no cache lookup is
            attempted

    How: Run three kspec item ac add commands for
    @daemon-command-api with the AC definitions above. Verify
    with kspec item get @daemon-command-api.

    Covers: @daemon-command-api ac-read-cache-serving (new),
    ac-cache-context-propagation (new),
    ac-no-cache-outside-daemon (new).

- title: Add task history retention AC to daemon-entity-cache spec
  slug: task-update-entity-cache-history-ac
  priority: 1
  tags: [spec-update, daemon, cache]
  spec_ref: "@daemon-entity-cache"
  description: |
    Add an acceptance criterion to @daemon-entity-cache that
    specifies task history entries are retained in the cache
    alongside task detail data.

    Why: The current entity cache spec covers index and detail
    tiers but does not mention task field-change history — a
    distinct data category that is parsed from the same file as
    task details but excluded from the LoadedTask type. Making
    history caching explicit ensures the cache contract covers
    all task data that consumers need. This is the single home
    for the history-retention contract; no separate spec is
    needed because history is a data tier concern within the
    existing entity cache.

    What: Add ac-task-history-retention to @daemon-entity-cache:

      given: The task cache domain loads or incrementally updates
             a task
      when: The task file is parsed
      then: Field-change history entries from the task file are
            retained in the cache and available to consumers
            without re-reading the file from disk

    How: Run:
      kspec item ac add @daemon-entity-cache \
        --id ac-task-history-retention \
        --given "The task cache domain loads or incrementally updates a task" \
        --when "The task file is parsed" \
        --then "Field-change history entries from the task file are retained in the cache and available to consumers without re-reading the file from disk"

    Verify with: kspec item get @daemon-entity-cache

    Covers: @daemon-entity-cache ac-task-history-retention (new).

# ─── Phase 2: Cache Context Propagation ───

- title: Add AsyncLocalStorage for entity cache propagation
  slug: task-cache-async-context
  priority: 1
  tags: [daemon, cache, foundation]
  spec_ref: "@daemon-command-api"
  depends_on:
    - "@task-update-command-api-spec"
  description: |
    Create an AsyncLocalStorage-based mechanism for propagating
    the entity cache reference into CLI command execution chains
    running inside the daemon.

    Why: The daemon's command API executes CLI commands in-process
    via program.parseAsync(). These commands call data loading
    functions (loadAllItems, listTasks, etc.) that always read from
    disk. The entity cache holds the same data in memory but the
    loading functions have no way to access it. AsyncLocalStorage
    provides a transparent propagation channel that does not require
    changing function signatures across the codebase.

    The parser layer already uses this pattern: specDirOverrideStorage
    in src/parser/yaml.ts propagates context via
    runWithoutSpecDirOverride(). The new cache storage follows the
    same pattern.

    What:

    1. In src/parser/yaml.ts, create entityCacheStorage as a new
       AsyncLocalStorage instance alongside the existing
       specDirOverrideStorage. The store shape holds a reference to
       the project's entity cache accessor (a function that takes a
       project path and returns the cache interface) and the project
       path string.

    2. Export runWithEntityCache(fn, cacheAccessor, projectPath) that
       wraps fn in entityCacheStorage.run(). Export
       getEntityCacheContext() that returns the current store or
       undefined.

    3. In packages/daemon/src/routes/command.ts, in the
       executeCommand function, wrap the existing
       runWithoutSpecDirOverride(program.parseAsync(...)) call
       inside runWithEntityCache() using the project's entity cache
       from getEntityCache(projectContext.path). The two
       AsyncLocalStorage wrappers nest independently.

    No behavior change in this task — data loaders do not read
    from the cache yet. This task establishes the propagation
    channel only.

    How: The entityCacheStorage uses the same AsyncLocalStorage API
    as specDirOverrideStorage. Import AsyncLocalStorage from
    node:async_hooks. Define the store type as
    { cacheAccessor: EntityCacheAccessor; projectPath: string }.
    The EntityCacheAccessor type is imported from
    packages/daemon/src/routes/entity-cache-types.ts. In
    executeCommand, the getEntityCache callback is already available
    in the route closure — pass it into runWithEntityCache. Add a
    unit test that verifies getEntityCacheContext() returns the
    cache reference inside a runWithEntityCache block and returns
    undefined outside it.

    Covers: @daemon-command-api ac-cache-context-propagation,
    ac-no-cache-outside-daemon.

# ─── Phase 3: Cache-Aware Context Initialization ───

- title: Resolve project context from entity cache during command execution
  slug: task-cache-aware-init-context
  priority: 1
  tags: [daemon, cache, performance]
  spec_ref: "@daemon-command-api"
  depends_on:
    - "@task-cache-async-context"
  description: |
    Make initContext() use cached meta artifacts when running inside
    the daemon's command execution context, eliminating disk reads
    and git operations for project discovery.

    Why: initContext() is the single most expensive call in the
    command execution path. It reads kspec.config.yaml, resolves
    the manifest, detects the shadow branch (including git
    operations for sync status), and builds KspecContext. The entity
    cache already stores all of this in cachedProjectConfig,
    cachedShadowInfo, and the meta domain detail tier (after
    @plan-granular-cache-invalidation). When the meta domain is
    ready, initContext() can build KspecContext from these cached
    artifacts instead of going to disk.

    What: In initContext() (src/parser/yaml.ts), before the existing
    disk-based discovery logic, check getEntityCacheContext(). If a
    cache is available and its meta domain state is "ready":

    1. Read cachedProjectConfig for the resolved config (project
       name, version, daemon settings, shadow config).

    2. Read cachedShadowInfo for shadow branch state (enabled,
       branch name, worktree dir, healthy, remote tracking).

    3. Read the meta detail tier for the manifest via
       getMetaDetail().

    4. Construct KspecContext from these cached values and return
       immediately without any disk reads or git operations.

    If the meta domain is not ready or getEntityCacheContext()
    returns undefined, fall through to the existing disk-based
    path unchanged.

    How: The cache exposes getCachedProjectConfig(),
    getCachedShadowInfo(), and getMetaDetail() as public methods.
    The constructed KspecContext must have the same field shape as
    disk-based initContext: rootDir, projectRoot, specDir,
    sessionsDir, manifestPath, manifest, shadow, config. Derive
    specDir from cachedProjectConfig.root_dir plus the configured
    shadow directory name. Derive sessionsDir as
    projectRoot + "/.kspec-sessions". Build the shadow config
    object from cachedShadowInfo fields. Build the config object
    from cachedProjectConfig. The manifest comes from
    getMetaDetail().manifest or the meta index. Add tests that
    verify: initContext returns cached context when meta is ready,
    initContext falls through to disk when meta is not ready,
    initContext falls through to disk when no cache context exists,
    and the returned KspecContext has identical field values to
    disk-based context for the same project.

    Covers: @daemon-command-api ac-read-cache-serving (partial —
    context initialization).

# ─── Phase 4: Cache-Aware Data Loaders ───

- title: Serve task data from entity cache during command execution
  slug: task-cache-aware-task-loading
  priority: 2
  tags: [daemon, cache, tasks]
  spec_ref: "@daemon-command-api"
  depends_on:
    - "@task-cache-async-context"
  description: |
    Make the task data loading functions return cached data when
    the entity cache is available and the tasks domain is ready.

    Why: Task loading is the heaviest data operation. With 1335+
    split task files, loadAllTasks() reads every task directory.
    listTasks() reads the task index. getTask() reads a single
    task's files. The entity cache already holds all of this in
    memory (index tier for summaries, detail tier for full tasks
    eagerly loaded during domain initialization). When running
    inside the daemon's command execution context, these functions
    should return cached data directly.

    What: In the TaskDataManager methods
    (src/parser/task-data-manager.ts):

    1. listTasks(): Check getEntityCacheContext(). If cache
       available and tasks domain ready, return
       cache.getTaskIndex(). Otherwise fall through to disk.

    2. loadAllTasks(): Check cache. If ready, return
       cache.getAllTaskDetails(). Otherwise fall through to disk.

    3. getTask(): Check cache. If ready, look up the task via
       cache.getTaskDetail(ulid). If found, return it. If not
       found in cache (detail miss), fall through to disk and
       populate cache via setTaskDetail().

    The cache check is a 3-5 line preamble at the top of each
    method. The existing disk-based logic is unchanged as the
    fallback path.

    Mutation methods (mutateTask, addNote, etc.) are NOT modified —
    they always use the disk path. After mutation, the existing
    write-through mechanism updates the cache.

    How: Import getEntityCacheContext from src/parser/yaml.ts.
    Each method checks:
    const cacheCtx = getEntityCacheContext();
    if (cacheCtx) {
      const cache = cacheCtx.cacheAccessor(cacheCtx.projectPath);
      if (cache?.getDomainState("tasks") === "ready") { ... }
    }
    Add tests verifying: cache hit returns cached data without
    disk reads, cache miss falls through to disk, mutation methods
    always use disk regardless of cache state, and getTask with
    cache detail miss loads from disk and populates cache.

    Covers: @daemon-command-api ac-read-cache-serving (partial —
    task domain).

- title: Serve item data from entity cache during command execution
  slug: task-cache-aware-item-loading
  priority: 2
  tags: [daemon, cache, items]
  spec_ref: "@daemon-command-api"
  depends_on:
    - "@task-cache-async-context"
  description: |
    Make loadAllItems() return cached data when the entity cache
    is available and the items domain is ready.

    Why: loadAllItems() parses the manifest, follows include
    patterns, and reads every module YAML file. The entity cache
    already holds all loaded spec items in its detail tier
    (getAllItemDetails() returns LoadedSpecItem[]). Returning
    cached data eliminates this multi-file parse.

    What: In loadAllItems() (src/parser/yaml.ts), add a cache
    check preamble. If getEntityCacheContext() provides a cache
    with items domain ready, return cache.getAllItemDetails().
    Otherwise fall through to the existing disk-based path.

    How: Same preamble pattern as task loading — import
    getEntityCacheContext, check domain state, return cached data
    or fall through. Add tests verifying cache hit returns cached
    items, cache miss falls through to disk.

    Covers: @daemon-command-api ac-read-cache-serving (partial —
    items domain).

- title: Serve inbox and triage data from entity cache during command execution
  slug: task-cache-aware-inbox-triage
  priority: 2
  tags: [daemon, cache]
  spec_ref: "@daemon-command-api"
  depends_on:
    - "@task-cache-async-context"
  description: |
    Make loadInboxItems() and loadTriageRecords() return cached
    data when the entity cache is available and their domains are
    ready.

    Why: Both functions read single YAML files from disk. The
    entity cache already holds their data: inbox stores full
    LoadedInboxItem[] in its index tier, and triage stores full
    LoadedTriageRecord[] in its detail tier. Returning cached data
    avoids the file read and YAML parse.

    What:

    1. loadInboxItems() (src/parser/yaml.ts) — add cache check
       preamble. If inbox domain ready, return
       cache.getInboxIndex() which stores full LoadedInboxItem[].
       Otherwise fall through to disk.

    2. loadTriageRecords() (src/parser/yaml.ts) — add cache check
       preamble. If triage domain ready, return all triage details
       from the detail tier. Otherwise fall through to disk.

    How: Same preamble pattern. Both functions are in the same
    file (src/parser/yaml.ts). Add tests verifying each loader
    returns cached data on hit and falls through on miss.

    Covers: @daemon-command-api ac-read-cache-serving (partial —
    inbox and triage domains).

- title: Serve plan and review data from entity cache during command execution
  slug: task-cache-aware-plans-reviews
  priority: 2
  tags: [daemon, cache]
  spec_ref: "@daemon-command-api"
  depends_on:
    - "@task-cache-async-context"
  description: |
    Make loadPlans() and loadReviewRecords() return cached data
    when the entity cache is available and their domains are ready.

    Why: Both functions read single YAML files from disk. The
    entity cache holds plan and review data in index and detail
    tiers. Returning cached data avoids the file read and YAML
    parse.

    What:

    1. loadPlans() (src/parser/plans.ts) — add cache check
       preamble. If plans domain ready and detail tier has entries,
       return all plan details from the detail tier. If detail tier
       is empty (index-only), fall through to disk because
       LoadedPlan[] is the expected return type and index-tier
       PlanIndexSummary[] is not type-compatible.

    2. loadReviewRecords() (src/parser/reviews.ts) — add cache
       check preamble. Same pattern: if reviews domain ready and
       detail tier has entries, return all review details. Otherwise
       fall through to disk.

    How: Same preamble pattern. Each function is in its own file.
    The detail tier check is important: unlike tasks and items
    where the cache eagerly loads details, plans and reviews may
    have only index-tier data populated. The preamble checks both
    domain state and detail tier population before returning. Add
    tests verifying each loader returns cached data when detail
    tier is populated, falls through when detail tier is empty,
    and falls through when domain is not ready.

    Covers: @daemon-command-api ac-read-cache-serving (partial —
    plans and reviews domains).

- title: Serve meta context from entity cache during command execution
  slug: task-cache-aware-meta
  priority: 2
  tags: [daemon, cache, meta]
  spec_ref: "@daemon-command-api"
  depends_on:
    - "@task-cache-async-context"
  description: |
    Make loadMetaContext() return cached data when the entity
    cache is available and the meta domain is ready.

    Why: loadMetaContext() reads the meta manifest and all
    included meta YAML files from disk to build MetaContext. The
    entity cache stores the full MetaContext in its meta detail
    tier (getMetaDetail()). Returning cached data avoids the
    multi-file parse.

    What: In loadMetaContext() (src/parser/meta.ts), add a cache
    check preamble. If getEntityCacheContext() provides a cache
    with meta domain ready, return cache.getMetaDetail().
    Otherwise fall through to the existing disk-based path.

    How: Same preamble pattern. Import getEntityCacheContext,
    check meta domain state, return getMetaDetail() or fall
    through. Add tests verifying cache hit returns cached meta,
    cache miss falls through to disk.

    Covers: @daemon-command-api ac-read-cache-serving (partial —
    meta domain).

# ─── Phase 5: Task History Caching ───

- title: Retain task history entries in entity cache
  slug: task-cache-task-history
  priority: 2
  tags: [daemon, cache, tasks]
  spec_ref: "@daemon-entity-cache"
  depends_on:
    - "@task-update-entity-cache-history-ac"
    - "@task-cache-aware-task-loading"
  description: |
    Store task field-change history entries in the entity cache
    alongside task detail data so getTaskHistory() can return
    cached history without re-reading task files.

    Why: The split backend's loadTaskFromDirWithHistory() reads
    task.yaml and extracts the history array, but this history is
    stripped from the LoadedTask type before it enters the cache's
    detail tier. When getTaskHistory() is called, it re-reads the
    same task.yaml to extract history again. In the cache-aware
    command execution context, this re-read is unnecessary — the
    history was already parsed during the initial load.

    What:

    1. Add a historyDetails map (Map<string, HistoryEntry[]>) to
       the task domain store in entity-cache.ts, alongside the
       existing details map.

    2. Extend the TaskDataManager interface with an optional
       loadTaskWithHistory(ctx, ulid) method that returns both
       LoadedTask and HistoryEntry[]. The split backend already
       has loadTaskFromDirWithHistory internally — expose it
       through this new public method.

    3. During task domain loading in doLoadDomain("tasks"), use
       loadTaskWithHistory instead of loadTask for each task. Store
       the history in historyDetails keyed by ULID alongside the
       task in the details map.

    4. During incremental task updates
       (tryIncrementalTaskUpdate), when a single task file is
       re-parsed, update the history entries for that task in the
       historyDetails map using the same loadTaskWithHistory call.

    5. Add getTaskHistory(ulid) to the cache accessor interface
       (RouteEntityCache in entity-cache-types.ts) that returns
       HistoryEntry[] or null.

    6. In TaskDataManager.getTaskHistory()
       (src/parser/task-data-manager.ts), add a cache check
       preamble following the same pattern as other loaders. If
       cache is available and historyDetails has an entry for the
       requested ULID, return it. Otherwise fall through to disk.

    How: The split backend's private loadTaskFromDirWithHistory
    returns { task, history, rawCore }. Add a public method on
    SplitTaskBackend that calls loadTaskFromDirWithHistory and
    returns { task, history }. Register this method on the
    TaskStorageBackend interface as optional (only split format
    supports it). In doLoadDomain("tasks"), iterate tasks using
    the new method and populate both details and historyDetails
    maps. In tryIncrementalTaskUpdate, similarly use the new
    method for the changed task and update historyDetails. The
    historyDetails map follows the same lifecycle as the details
    map — cleared on dispose, swapped atomically during reloads.
    Add tests verifying: history populated during domain load,
    history served from cache on getTaskHistory() call, history
    updated on incremental task update, history falls through to
    disk when cache not ready.

    Covers: @daemon-entity-cache ac-task-history-retention.

# ─── Phase 6: Read Command Concurrency ───

- title: Allow concurrent execution of cache-backed read commands
  slug: task-read-command-concurrency
  priority: 3
  tags: [daemon, cache, performance]
  spec_ref: "@daemon-concurrent-reads"
  depends_on:
    - "@task-cache-aware-init-context"
    - "@task-cache-aware-task-loading"
    - "@task-cache-aware-item-loading"
    - "@task-cache-aware-inbox-triage"
    - "@task-cache-aware-plans-reviews"
    - "@task-cache-aware-meta"
    - "@task-cache-task-history"
  description: |
    Allow read-only commands executed via the command API to run
    concurrently when their required cache domains are ready, by
    skipping the dispatch mutex for these commands.

    Why: The dispatch mutex (DispatchMutex in command.ts)
    serializes all command execution because executeCommand()
    mutates process-global state: process.cwd(), console.log,
    process.stderr.write, and the process.exit interceptor.
    After phases 3-5 of this plan, cache-backed read commands
    get their data from memory. However, they still run through
    program.parseAsync() which uses process.chdir() and console
    interception for output capture. Skipping the mutex for reads
    is safe because: (a) initContext returns from cache without
    needing chdir, (b) data loaders return from cache without
    disk I/O, and (c) output capture via console interception is
    per-call (each executeCommand saves and restores the
    originals). The chdir in executeCommand is the remaining
    concern — but with cached initContext, the chdir result is
    never used by data loaders since they skip disk paths.

    What: In the command route handler (command.ts POST /):

    1. Add a canServeFromCache(command, cache) function that
       checks two conditions: the command is classified as
       read-only (not mutating), and the specific cache domains
       that command requires are in ready state. Each allowlisted
       command declares its required domains (e.g. task list
       requires tasks + items for ReferenceIndex; inbox list
       requires only inbox). Use a conservative allowlist of
       commands known to be cache-safe: task list, task get,
       tasks list, tasks ready, item list, item get, search,
       inbox list, plan list, plan get, review get, review list.

    2. When canServeFromCache returns true, execute the command
       outside the dispatch mutex. The command still runs through
       executeCommand() with console capture and chdir, but it
       does not wait for the mutex.

    3. When canServeFromCache returns false (required domains not
       ready or command not in allowlist), use the existing
       mutex-protected path. Mutations always use the mutex.

    How: Define a COMMAND_CACHE_DOMAINS map that associates each
    allowlisted command with its required cache domains. The
    domain list for each command must be derived by the worker
    at implementation time by reading each command handler in
    src/cli/commands/ and tracing every data loading call through
    all code paths (including flag-dependent branches). Each
    entry must list exactly the domains the handler loads
    unconditionally — not more (which would over-serialize) and
    not less (which would allow mutex bypass while a loader falls
    back to disk). The worker must add inline comments in the
    COMMAND_CACHE_DOMAINS map citing the source file and line
    number that justifies each domain entry.

    The isCommandMutating() function already classifies commands.
    canServeFromCache looks up the command in COMMAND_CACHE_DOMAINS
    and checks that each listed domain is in ready state. Commands
    not in the map are not cache-eligible. In the route handler,
    branch before dispatchMutex.run():
    if (!mutating && canServeFromCache(payload, cache)) {
      return executeCommand(payload, program, projectPath);
    } else {
      return dispatchMutex.run(() => ... existing logic ...);
    }
    Add tests verifying: allowlisted read commands skip mutex
    when their required cache domains are ready, read commands
    acquire mutex when a required domain is not ready, commands
    not in allowlist acquire mutex, mutations always acquire
    mutex, and two concurrent allowlisted read commands can
    complete without blocking each other.

    Covers: @daemon-concurrent-reads ac-concurrent-cache-reads,
    ac-mutation-serialization, ac-disk-fallback-serialization.
```

## Implementation Notes

### Motivation

The daemon's command API (POST /api/command) executes CLI commands
in-process by calling program.parseAsync(). Every command that reads
spec/task data calls initContext() which performs disk reads and git
operations, then calls data loading functions that parse YAML files
from disk. The entity cache holds all of this data in memory but the
command execution path bypasses it entirely.

For projects with many entities (1335+ tasks), this makes command
execution take 60+ seconds — exceeding the CLI proxy timeout — even
though the same data is available from cache in milliseconds.

The REST API routes (GET /api/tasks, GET /api/items, etc.) already
serve from cache. This plan makes the command API path equally fast
by making data loaders cache-aware.

### Builds on granular cache invalidation

This plan depends on @plan-granular-cache-invalidation being merged
to dev. That plan provides:

- ReloadCycle with context caching (getReloadCycleContext)
- getAllTaskDetails() and getAllItemDetails() on the cache
- Incremental update methods (tryIncrementalTaskUpdate, etc.)
- WriteThroughHint for entity-level write-through
- Meta sub-domain decomposition (cached config, shadow, session)

The cache-aware command execution builds on these by making the
cached data accessible to the CLI command handlers that run inside
the daemon process.

### AsyncLocalStorage pattern

The parser layer already uses AsyncLocalStorage for
specDirOverrideStorage (src/parser/yaml.ts). The new
entityCacheStorage follows the identical pattern. These two can
be nested — executeCommand already wraps parseAsync in
runWithoutSpecDirOverride, and the new cache wrapper nests
alongside it using an independent storage instance.

### Spec ownership boundaries

This plan does not introduce standalone specs for cache-backed
command execution or task history caching. Instead:

- Cache-serving behavior for the command API is specified as new
  ACs on the existing @daemon-command-api spec (ac-read-cache-serving,
  ac-cache-context-propagation, ac-no-cache-outside-daemon).
- Task history retention is specified as a new AC on the existing
  @daemon-entity-cache spec (ac-task-history-retention).
- Only @daemon-concurrent-reads is a new spec because concurrent
  read execution is a distinct behavioral contract not covered by
  existing specs.

This avoids duplicate ownership between new and existing specs.

### What does NOT change

- CLI command handlers — zero changes to command code in
  src/cli/commands/. They call the same data loading functions.
- Direct CLI mode — no cache in AsyncLocalStorage = disk path.
- REST API routes — already serve from cache via getEntityCache
  callback. Unaffected.
- Mutation path — writes always go through disk + shadow commit +
  write-through. The cache-aware path is read-only.
- Response parity — commands still produce the same stdout/stderr
  because they run through the same formatters.

### Task history architecture

Task history (field-change audit trail) lives in task.yaml but is
stripped from LoadedTask during parsing — the split backend's
loadTaskFromDirWithHistory() returns history as a separate array.
The entity cache currently discards this history because it calls
loadAllTasks() which returns LoadedTask[] without history.

To cache history, the TaskDataManager interface is extended with
an optional loadTaskWithHistory method that the split backend
implements by exposing its existing internal method. The entity
cache uses this during domain loading and incremental updates.

### Concurrent read commands

Phase 6 (read command concurrency) uses a conservative allowlist
approach. Only commands verified to work correctly with
cache-backed data are included in the allowlist. The existing
mutex-protected path is the fallback for everything else. The
allowlist can be expanded incrementally as more commands are
verified safe.

### Phasing rationale

Phase 1 (spec updates) establishes target contracts before code
changes. Phase 2 (AsyncLocalStorage plumbing) is zero-risk
infrastructure. Phase 3 (initContext cache) provides the biggest
single performance win. Phases 4a-4e (per-domain loader cache
awareness) are independent of each other and can be parallelized.
Phase 5 (history caching) extends the existing task detail caching
and depends on the task loader being cache-aware. Phase 6
(concurrency) depends on all read loaders being cache-aware and
is the final optimization.
