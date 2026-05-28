# Granular Cache Invalidation

## Specs

```yaml
# ─── New Spec: Incremental Cache Updates ───

- title: Incremental Entity Cache Updates
  slug: daemon-incremental-cache
  type: feature
  description: |
    Cache invalidation updates only the entities affected by a change
    rather than reloading entire data domains. When the system knows
    which file changed, it uses that information to patch the cached
    index and detail data in place. Full domain reloads remain as a
    fallback when the changed file cannot be mapped to specific
    entities or when callers (such as write-through) do not provide
    file-level context.
  acceptance_criteria:
    - id: ac-file-path-preserved
      given: |
        The file watcher detects a change to a file in the shadow branch
      when: |
        The cache invalidation is triggered
      then: |
        The file path of the changed file is available to the cache
        update logic, not just the domain name
    - id: ac-single-entity-patch
      given: |
        A file change maps to a single identifiable entity within a domain
      when: |
        The cache processes the invalidation
      then: |
        Only that entity is reloaded from disk and its index and detail
        entries are replaced without reloading other entities in the domain
    - id: ac-multi-entity-file
      given: |
        A file change maps to a file containing multiple entities
      when: |
        The cache processes the invalidation
      then: |
        The entire file is re-parsed and all entities from that file are
        replaced in the index and detail tiers
    - id: ac-fallback-full-reload
      given: |
        A file change cannot be mapped to specific entities within a domain
      when: |
        The cache processes the invalidation
      then: |
        The entire domain is reloaded from disk, matching the current
        full-reload behavior
    - id: ac-removal-detection
      given: |
        A previously cached entity's source file is deleted
      when: |
        The cache processes the file removal event
      then: |
        The entity is removed from both the index and detail tiers
    - id: ac-index-consistency
      given: |
        An incremental update replaces or removes an entity
      when: |
        Concurrent API requests read from the same domain
      then: |
        Readers see either the complete pre-update state or the complete
        post-update state for the affected entity, never a partial mix
    - id: ac-batch-coalescing
      given: |
        Multiple files change within the debounce window
      when: |
        The debounce timer fires
      then: |
        All changed files are processed in a single update pass rather
        than triggering separate reloads per file
    - id: ac-watcher-content-passthrough
      given: |
        The file watcher reads and validates a changed file's content
      when: |
        The change event reaches the cache
      then: |
        The already-read content is available to the cache update logic
        so the file does not need to be read from disk a second time

# ─── New Spec: Cache-Aware Meta Decomposition ───

- title: Independent Meta Sub-Domains
  slug: daemon-meta-subdomain
  type: requirement
  description: |
    The meta cache domain is composed of independently-sourced data:
    project manifest metadata, shadow branch health, and session
    context. Each sub-domain has its own invalidation trigger and
    can be refreshed without affecting the others.
  acceptance_criteria:
    - id: ac-manifest-only-reload
      given: |
        A meta YAML file changes in the shadow branch
      when: |
        The cache processes the invalidation
      then: |
        Only the manifest and project metadata are reloaded; shadow
        branch health and session context are not re-evaluated
    - id: ac-shadow-on-schedule
      given: |
        The background sync scheduler runs its periodic check
      when: |
        Shadow branch health data has changed
      then: |
        The cached shadow status is updated independently of the
        manifest metadata and session context
    - id: ac-session-context-independent
      given: |
        The session context file changes
      when: |
        The cache processes the invalidation
      then: |
        Only the session context portion of meta is reloaded; manifest
        metadata and shadow health are not re-evaluated
    - id: ac-initial-load-all
      given: |
        A project is registered and the meta domain loads for the first
        time
      when: |
        The initial load completes
      then: |
        All three sub-domains (manifest, shadow, session context) are
        loaded before the meta domain transitions to ready state
```

## Tasks

derive_from_specs: false

```yaml
# ─── Phase 1: Spec Updates ───

- title: Add context reuse AC to daemon-entity-cache
  slug: task-add-ac-context-reuse
  priority: 1
  tags: [spec-update, daemon, cache]
  spec_ref: "@daemon-entity-cache"
  description: |
    Add a new acceptance criterion ac-context-reuse to @daemon-entity-cache
    that requires shared initialization work to be reused across
    concurrent domain reloads.

    Why: When multiple domains are invalidated by the same file change
    (e.g. kynetic.yaml invalidating both "meta" and "items"), each
    domain reload currently performs its own initialization including
    manifest resolution and shadow branch detection. This AC ensures
    that shared setup is performed once and reused, reducing redundant
    work during concurrent invalidations.

    The existing ac-granular-reload on @daemon-entity-cache is preserved
    as-is — it owns the cross-domain isolation contract ("only the
    affected domain is reloaded, not unrelated domains"). Within-domain
    entity-level granularity is owned by the new @daemon-incremental-cache
    spec via ac-single-entity-patch and ac-fallback-full-reload, which
    are complementary rather than conflicting.

    What: Add ac-context-reuse:
      given: Multiple cache domains are invalidated within the same
             debounce window
      when: The cache begins reloading affected data
      then: Shared initialization work is performed once and reused
            across all domain reloads in that window

    How: Run:
      kspec item ac add @daemon-entity-cache \
        --id ac-context-reuse \
        --given "Multiple cache domains are invalidated within the same debounce window" \
        --when "The cache begins reloading affected data" \
        --then "Shared initialization work is performed once and reused across all domain reloads in that window"

    Verify with: kspec item get @daemon-entity-cache

    Covers: @daemon-entity-cache ac-context-reuse (new).

# ─── Phase 2: Watcher Content Passthrough ───

- title: Pass file content from watcher through to cache invalidation
  slug: task-watcher-content-passthrough
  priority: 1
  tags: [daemon, cache, refactor]
  spec_ref: "@daemon-incremental-cache"
  depends_on:
    - "@task-add-ac-context-reuse"
  description: |
    Change the cache invalidation callback signature to include the
    file content that the watcher already read and parsed.

    Why: The KspecWatcher (packages/daemon/src/watcher.ts) already reads
    the changed file's content and parses its YAML at lines 154-158 of
    processFileChange(). This content is passed through the onFileChange
    callback as (filePath, content). However, the cache invalidation
    callback registered in packages/daemon/src/project-context.ts at
    line 164 only forwards (projectPath, kspecDir, file) — dropping the
    content. This means every cache reload re-reads files that were
    already read by the watcher. Passing the content through eliminates
    redundant disk reads for incremental updates.

    What: Update three connection points:

    1. The cacheInvalidationCallback type in project-context.ts to accept
       a content parameter alongside projectPath, kspecDir, and file.

    2. The onFileChange handler in project-context.ts (line 164) to
       forward the content parameter.

    3. The cache.handleFileChange() method signature in entity-cache.ts
       (line 1270) to accept content.

    handleFileChange has two callers with different content availability:

    - The onFileChange callback always provides content (the watcher
      reads and validates the file before calling it).
    - The onFileRemoved callback is a separate code path that calls
      cacheInvalidationCallback without content. This callback must
      pass undefined or null for the content parameter.

    The cache must handle both cases: content present (use it for
    incremental updates in subsequent tasks) and content absent (read
    from disk or perform full reload).

    How: Edit packages/daemon/src/project-context.ts to add content to
    the cacheInvalidationCallback call in onFileChange, and pass
    undefined in onFileRemoved. Edit src/daemon/entity-cache.ts to
    accept and store optional content on handleFileChange. For this
    task, the cache receives the content but does not yet use it —
    subsequent tasks build the incremental update logic that consumes
    it. Add a test that verifies content reaches handleFileChange when
    a file change occurs and that removal events pass no content.

    Covers: @daemon-incremental-cache ac-watcher-content-passthrough.

- title: Accumulate changed file paths during debounce window
  slug: task-debounce-path-accumulation
  priority: 1
  tags: [daemon, cache, refactor]
  spec_ref: "@daemon-incremental-cache"
  depends_on:
    - "@task-watcher-content-passthrough"
  description: |
    Change the domain debounce mechanism to collect the set of changed
    file paths and their content during the debounce window, instead of
    just tracking that a domain needs reloading.

    Why: The current invalidateDomain() method (entity-cache.ts line 1215)
    receives only a domain name. It sets a debounce timer, and when the
    timer fires, it calls loadDomain() which reloads everything in that
    domain. To support incremental updates, the debounce mechanism needs
    to know *which files* changed so it can decide whether to do a full
    reload or an incremental patch. When multiple files change within
    the 100ms debounce window, all their paths and content should be
    collected and processed together in one pass.

    What: Replace the (domain → Timer) debounce map with a structure
    that also accumulates (filePath, content?) entries per domain.
    When the debounce timer fires, the accumulated file set is passed
    to the reload/patch logic. If the set is empty (e.g. invalidation
    was triggered without a file path, such as write-through), fall
    back to full domain reload. The debounce timer reset behavior
    (clear and restart on each new file) is preserved.

    How: Add a pendingChanges map alongside domainDebounceTimers in
    the ProjectEntityCache class. In handleFileChange, push the file
    path and optional content into pendingChanges for the mapped
    domain(s) before calling invalidateDomain. In invalidateDomain,
    when the timer fires, drain the accumulated changes for that
    domain and pass them to a new method (processChanges or similar)
    that will be implemented by subsequent tasks. For now, the new
    method delegates to full loadDomain(). Add tests that verify
    multiple file changes within the debounce window are coalesced
    into a single set.

    Covers: @daemon-incremental-cache ac-batch-coalescing,
    ac-file-path-preserved.

# ─── Phase 3: Context Caching ───

- title: Cache KspecContext across concurrent domain reloads
  slug: task-cache-kspec-context
  priority: 2
  tags: [daemon, cache, performance]
  spec_ref: "@daemon-entity-cache"
  depends_on:
    - "@task-debounce-path-accumulation"
  description: |
    Cache the result of initContext() at the project level so that
    concurrent or sequential domain reloads within the same debounce
    cycle share a single context initialization.

    Why: Every doLoadDomain() call starts with initContext(projectPath)
    (entity-cache.ts line 924). initContext reads the project config file,
    resolves the manifest, and performs shadow branch detection including
    git operations. When multiple domains are invalidated by a single
    file change (e.g. kynetic.yaml invalidates both "meta" and "items"),
    or when several files change within the debounce window, initContext
    is called redundantly for each domain. The project config, manifest,
    and shadow branch state do not change between these calls — they are
    all triggered by the same file system event.

    What: Add a debounce-cycle-scoped context cache to
    ProjectEntityCache. When doLoadDomain calls initContext, check if
    a cached context exists for the current debounce cycle. If so,
    return the cached context. If not, call initContext, cache the
    result, and return it. The cache entry is invalidated when the
    debounce cycle completes (after all domain reloads for that cycle
    finish), ensuring subsequent unrelated changes get fresh context.

    How: Add a cachedContext field to ProjectEntityCache. In
    doLoadDomain, replace the direct initContext call with a method
    that checks the cache first. Clear the cached context at the end
    of each debounce cycle (when the timer fires and processing
    completes). Test that two concurrent domain reloads triggered by
    the same file change call initContext only once.

    Covers: @daemon-entity-cache ac-context-reuse.

# ─── Phase 4: Incremental Updates Per Domain ───

- title: Implement incremental task updates for split-backend task files
  slug: task-incremental-task-updates
  priority: 2
  tags: [daemon, cache, tasks]
  spec_ref: "@daemon-incremental-cache"
  depends_on:
    - "@task-debounce-path-accumulation"
  description: |
    When a single task file changes in the split-backend storage format,
    reload only that task and patch it into the cached index and detail
    maps instead of reloading all tasks.

    Why: The split-backend task storage uses per-task directories
    (tasks/<ULID>/task.yaml, tasks/<ULID>/notes.yaml). The file path
    contains the task ULID, so the cache knows exactly which task
    changed. Currently, any task file change triggers a full
    listTasks() + loadAllTasks() which re-reads every task file in the
    project. For projects with many tasks, this is wasteful — only the
    changed task needs reloading.

    What: When processChanges receives file paths matching the pattern
    tasks/<ULID>/*.yaml:

    1. Extract the ULID from the file path.
    2. Load only that task's data from its directory (task.yaml and
       notes.yaml).
    3. Convert to a TaskSummary for the index tier.
    4. Replace the existing entry in the index array (matched by ULID)
       or append if new.
    5. Replace the existing entry in the detail map (keyed by ULID)
       or add if new.

    When processChanges receives a change to project.tasks.yaml (the
    monolith format), fall back to full domain reload since individual
    tasks cannot be identified by file path.

    When a task file is deleted (removal event), remove the task from
    both index and detail tiers.

    Concurrent read safety: clone the existing index array and detail
    map, apply the patches to the clones, then swap the entire
    reference (this.tasks.index = newIndex, this.tasks.details =
    newDetails). This is different from the full-reload pattern which
    builds from scratch — incremental must clone first because readers
    may hold a reference to the current array. The swap must be a
    single assignment per tier so readers see all-old or all-new.

    How: Add a tryIncrementalTaskUpdate method that checks whether the
    changed files are all split-backend task paths. If so, perform
    targeted loads using the task data manager's single-task loading
    capability. If any changed file is project.tasks.yaml or the file
    set can't be mapped to specific ULIDs, return false to signal
    fallback to full reload. Write tests covering: single task change
    patches index correctly, new task file adds to index, deleted task
    file removes from index, monolith file change triggers full reload,
    concurrent changes to multiple tasks are batched.

    Covers: @daemon-incremental-cache ac-single-entity-patch,
    ac-removal-detection, ac-index-consistency, ac-fallback-full-reload.

- title: Implement incremental item updates for module files
  slug: task-incremental-item-updates
  priority: 2
  tags: [daemon, cache, items]
  spec_ref: "@daemon-incremental-cache"
  depends_on:
    - "@task-debounce-path-accumulation"
  description: |
    When a single module file changes, re-parse only that file and
    replace its items in the cached index and detail maps instead of
    reloading all items.

    Why: The loadAllItems function follows the manifest's includes
    patterns and parses every matching YAML file to collect all spec
    items. A change to one module file (e.g. modules/daemon.yaml) only
    affects the items defined in that file. The cache can track which
    items came from which source file and replace only those entries
    when that file changes.

    What: When processChanges receives file paths matching
    modules/*.yaml or *.spec.yaml:

    1. Track item source file: when loading items (both initial load
       and incremental), record which source file each item came from
       in a Map<ULID, sourceFile> or by tagging the index entries.
    2. On file change: parse the changed file to extract its items.
    3. Remove all existing index and detail entries that were sourced
       from the changed file.
    4. Insert the newly parsed items into both index and detail tiers.
    5. Clone the existing index array and detail map, apply all
       additions and removals to the clones, then swap both references
       atomically (single assignment per tier). Readers holding a
       reference to the old array see consistent pre-update state.

    When the change is to kynetic.yaml (the manifest itself), fall back
    to full reload because the includes list may have changed, meaning
    the set of source files is different.

    Trait references (traits: [@trait-slug]) are not resolved during
    item loading — they are stored as reference strings. Changing a
    trait definition file does not require re-resolving traits on items
    that reference it, because trait inheritance is resolved at query
    time, not at load time. However, if the trait file is also a module
    file containing inline items, the items from that file are updated
    via the normal incremental path.

    How: Add a sourceFileMap alongside the items DomainStore. Populate
    it during loadDomain("items") by recording each item's source file.
    Add tryIncrementalItemUpdate that re-parses the changed file(s),
    removes stale entries, and inserts new ones. Fall back to full
    reload when kynetic.yaml changes or when source file tracking is
    not available (first load). Write tests covering: single module
    file change patches items correctly, item added to module file
    appears in index, item removed from module file disappears from
    index, kynetic.yaml change triggers full reload.

    Covers: @daemon-incremental-cache ac-single-entity-patch,
    ac-multi-entity-file, ac-removal-detection, ac-index-consistency,
    ac-fallback-full-reload.

- title: Implement incremental session updates for individual sessions
  slug: task-incremental-session-updates
  priority: 2
  tags: [daemon, cache, sessions]
  spec_ref: "@daemon-incremental-cache"
  depends_on:
    - "@task-debounce-path-accumulation"
  description: |
    When a session's metadata or events file changes, reload only that
    session's entry in the index instead of enumerating all session
    directories.

    Why: The current loadSessionIndex enumerates every session directory,
    reads metadata for each, applies stale checks, sorts, and truncates
    to the retention window. The session watcher already knows which
    session directory changed. For active projects with many sessions,
    re-enumerating all directories on every change is expensive and
    involves opening and closing a directory handle plus N sequential
    file reads.

    What: When processChanges receives session-source file paths:

    1. Extract the session ID from the file path (first path segment
       when source is "sessions").
    2. Load metadata for only that session using getSessionMetadataOnly.
    3. Apply stale criteria to the single session if applicable.
    4. Replace the existing entry in the sorted index (matched by ID)
       or insert in sorted position if new.
    5. If the session was deleted, remove it from the index.
    6. Re-apply the retention window bound (keep only top N).

    When the sessions directory itself is the change source (e.g.
    a full directory creation or deletion event without a specific
    session ID), fall back to full loadSessionIndex.

    How: Add tryIncrementalSessionUpdate that processes single-session
    changes. Clone the existing sorted index array, apply the
    insert/update/remove to the clone, then swap the reference
    (this.sessions.index = newIndex). The clone ensures readers
    holding the old reference see consistent pre-update state.
    Write tests covering: single session metadata
    change updates index entry, new session appears in index at correct
    sort position, deleted session removed from index, session exceeding
    stale criteria is marked stalled, full directory event triggers
    full reload.

    Covers: @daemon-incremental-cache ac-single-entity-patch,
    ac-removal-detection, ac-index-consistency, ac-fallback-full-reload.

# ─── Phase 5: Meta Decomposition ───

- title: Decompose meta domain into independently-refreshable sub-domains
  slug: task-meta-subdomain-decomposition
  priority: 3
  tags: [daemon, cache, meta]
  spec_ref: "@daemon-meta-subdomain"
  depends_on:
    - "@task-cache-kspec-context"
  description: |
    Split the meta domain's doLoadDomain into three independent load
    paths so that each can be triggered and refreshed without forcing
    a full meta reload.

    Why: The current doLoadDomain("meta") performs four sequential
    operations: loadMetaContext (file I/O for manifest and includes),
    getShadowStatus (git subprocess), hasRemoteTracking (git subprocess),
    and loadSessionContext (single file read). These are completely
    independent data sources. A change to a meta YAML file should not
    trigger git subprocess calls for shadow status, and a background
    sync cycle updating shadow status should not re-read meta files.
    The git subprocess calls are the most expensive operations in any
    domain reload.

    What: Restructure the meta DomainStore to track three logical
    sub-domains internally:

    1. Manifest sub-domain: MetaContext, MetaSummary, CachedProjectConfig.
       Triggered by meta YAML file changes.
    2. Shadow sub-domain: CachedShadowInfo (shadow status, remote
       tracking). Triggered by the background sync scheduler, not by
       file watcher events.
    3. Session context sub-domain: CachedSessionContext. Triggered by
       session context file changes.

    The public API (getMetaIndex, getMetaDetail, getCachedShadowInfo,
    etc.) is unchanged. The meta domain state is "ready" when all three
    sub-domains have loaded at least once.

    How: Add internal sub-domain state tracking (e.g. three booleans
    or a sub-state enum). Split doLoadDomain("meta") into three
    private methods. In handleFileChange, when a meta YAML file
    changes, only invoke the manifest sub-load. Wire the background
    sync scheduler to invoke the shadow sub-load directly instead of
    invalidating the entire meta domain. Wire session context file
    changes to invoke only the session context sub-load. The initial
    loadAll still calls all three sequentially. Write tests covering:
    meta YAML change does not trigger git operations, shadow sync
    does not re-read meta files, session context change does not
    trigger either meta file reads or git operations, all three
    sub-domains must be loaded before meta domain is "ready".

    Covers: @daemon-meta-subdomain ac-manifest-only-reload,
    ac-shadow-on-schedule, ac-session-context-independent,
    ac-initial-load-all.

# ─── Phase 6: Write-Through Alignment ───

- title: Align write-through with incremental updates for single-file domains
  slug: task-writethrough-incremental-alignment
  priority: 3
  tags: [daemon, cache, refactor]
  spec_ref: "@daemon-incremental-cache"
  depends_on:
    - "@task-incremental-task-updates"
    - "@task-incremental-item-updates"
    - "@task-incremental-session-updates"
  description: |
    Update the writeThrough method to use the same incremental update
    paths as watcher-driven invalidation for domains that support it.

    Why: The writeThrough method (entity-cache.ts line 1306) currently
    calls loadDomain() which performs a full domain reload. After
    incremental updates are implemented for tasks, items, and sessions,
    write-through should also use incremental paths — otherwise API
    mutations still trigger full domain reloads synchronously. This is
    especially important because write-through happens in the request
    path (before the response is sent), so its latency directly affects
    API response time.

    What: When writeThrough is called for a domain that supports
    incremental updates, and the mutation context provides sufficient
    information to identify the affected entity (e.g. the task ULID
    that was modified), use the incremental update path instead of
    full loadDomain. When the domain doesn't support incremental
    updates (inbox, plans, triage, reviews — which are single-file
    domains where reload IS the minimal update), continue using
    loadDomain.

    The writeThrough skip flag behavior (suppress the next watcher
    invalidation) must continue to work correctly — incremental
    write-through should still set the skip flag so the watcher
    event doesn't trigger a redundant update.

    How: Add an optional entityHint parameter to writeThrough (e.g.
    { ulid?: string, filePath?: string }) that mutation routes can
    pass when they know which entity changed. Route handlers in
    packages/daemon/src/routes/ already know the entity being mutated.
    When entityHint is present and the domain supports incremental
    updates, delegate to the incremental path. Write tests covering:
    write-through with entity hint uses incremental update, write-through
    without hint falls back to full reload, watcher skip flag works
    correctly with incremental write-through.

    Covers: @daemon-entity-cache ac-write-through (existing, no change),
    @daemon-incremental-cache ac-single-entity-patch.
```

## Implementation Notes

### Motivation

The daemon freezes under load because bun's GeneralPurposeAllocator
deadlocks when concurrent I/O operations stress the thread pool. The
entity cache's full-domain-reload strategy amplifies single file changes
into burst I/O: a single task file change triggers reading ALL task files,
re-resolving the project context (including git operations), and
rebuilding the entire index. This plan reduces the I/O burst by making
invalidation proportional to the change — one file changed, one entity
reloaded.

### The watcher already has the content

KspecWatcher.processFileChange() reads the file content and parses YAML
before calling onFileChange(filePath, content). The content is then
dropped at the project-context → cache boundary. Phase 2 preserves this
content through to the cache, eliminating redundant reads.

### Domain characteristics

- **Tasks (split-backend)**: Per-task directories with file paths that
  contain the task ULID. Best candidate for incremental updates.
- **Items**: Module files contain multiple items. Source-file tracking
  enables file-level granularity (reload all items from one file, not
  all items from all files).
- **Sessions**: Per-session directories, similar to tasks. Session ID
  extractable from path.
- **Meta**: Three unrelated sub-loads sharing one domain. Decomposition
  eliminates the most expensive cross-contamination (git subprocess
  calls triggered by unrelated file changes).
- **Inbox, Plans, Triage, Reviews**: Single-file domains where full
  reload is already the minimal update.

### Spec changes summary

- @daemon-entity-cache: Add ac-context-reuse (Phase 1 task). The existing
  ac-granular-reload is preserved as-is — it owns cross-domain isolation.
  Within-domain entity-level granularity is owned by @daemon-incremental-cache.
- @daemon-incremental-cache: New spec with 8 ACs (derived from plan)
- @daemon-meta-subdomain: New spec with 4 ACs (derived from plan)

### Phasing rationale

Phase 1 (spec updates) establishes the target contracts before any code
changes. Phase 2 (passthrough + accumulation) is pure plumbing — no
behavioral change, zero risk. Phase 3 (context caching) is a standalone
optimization independent of incremental updates. Phases 4a-4c
(per-domain incremental) are independent of each other and can be
parallelized. Phase 5 (meta decomposition) depends on context caching
but not on incremental updates. Phase 6 (write-through alignment)
depends on the incremental paths existing.
