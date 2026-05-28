# Daemon File Monitoring Reliability

## Specs

```yaml
# ─── New: Resource-Bounded File Monitoring ───

- title: Resource-Bounded File Monitoring
  slug: daemon-file-monitoring
  type: feature
  parent: "@web-ui"
  description: |
    Defines the contract for how the daemon monitors project directories
    for changes. File monitoring must be resource-proportional — the
    daemon's resource consumption scales with the number of directories
    and metadata files that need monitoring, not with the total volume
    of data stored in those directories.

    The daemon monitors two directory trees per project: the shadow
    branch worktree for spec/task state, and the sessions directory
    for session lifecycle. Each tree has distinct monitoring needs —
    the shadow branch contains structured YAML that drives cache
    invalidation, while the sessions directory contains metadata files
    alongside large volumes of content data (blobs) that are irrelevant
    to cache freshness.
  traits:
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        A project is registered with the daemon
      when: |
        File monitoring starts for that project
      then: |
        Changes to structured data files in the shadow branch directory
        are detected and reported within the debounce window
    - id: ac-2
      given: |
        The sessions directory contains large volumes of content data
        alongside session metadata files
      when: |
        File monitoring starts for the sessions directory
      then: |
        Only session metadata and event files are monitored; content
        storage directories are excluded from monitoring
    - id: ac-3
      given: |
        A project's sessions directory has thousands of sessions with
        accumulated content data
      when: |
        The daemon process resource usage is measured
      then: |
        File descriptor count is proportional to the number of
        monitored directories and metadata files, not to the total
        number of stored content files
    - id: ac-4
      given: |
        The daemon is running on any supported platform
      when: |
        File monitoring is initialized
      then: |
        File changes are detected reliably regardless of the
        operating system's native filesystem event mechanism
    - id: ac-5
      given: |
        A monitored file is modified through an atomic write operation
        (write to temporary file, then rename)
      when: |
        The monitoring system processes the filesystem event
      then: |
        The change is detected and reported as a modification to the
        target path
    - id: ac-6
      given: |
        Multiple projects are registered with the daemon
      when: |
        A file changes in one project's monitored directory
      then: |
        Only that project's change handler is invoked; no cross-project
        event delivery occurs
    - id: ac-7
      given: |
        A new session directory is created after monitoring started
      when: |
        Metadata files are written into the new session directory
      then: |
        The new session's metadata changes are detected without
        requiring a monitoring restart
    - id: ac-8
      given: |
        The monitoring system encounters a persistent error for a
        project directory
      when: |
        Recovery attempts are exhausted
      then: |
        The project is unregistered and resources are released, with
        a logged error identifying the affected project

# ─── New: Watcher Health Verification ───

- title: Watcher Health Verification
  slug: daemon-watcher-health
  type: requirement
  parent: "@daemon-file-monitoring"
  description: |
    Provides runtime verification that file monitoring is actively
    delivering events, not just that a watcher object exists. Silent
    watcher failures — where the watcher reports as active but stops
    delivering events — are detected and recovered from automatically.
  acceptance_criteria:
    - id: ac-1
      given: |
        File monitoring is active for a project
      when: |
        A periodic health check runs
      then: |
        The daemon verifies that the monitoring system can detect
        a synthetic file change within the expected debounce window
    - id: ac-2
      given: |
        The health check detects that a synthetic change was not
        reported within the expected window
      when: |
        The verification timeout elapses
      then: |
        The monitoring system is restarted for the affected project
        and the incident is logged with the project path and failure
        duration
    - id: ac-3
      given: |
        Multiple projects are registered
      when: |
        One project's watcher health check fails
      then: |
        Only that project's monitoring is restarted; other projects
        are unaffected
    - id: ac-4
      given: |
        The daemon's cache diagnostic endpoint is queried
      when: |
        Watcher health data is available
      then: |
        The response includes the last successful health check
        timestamp and consecutive failure count per project

```

## Tasks

derive_from_specs: false

```yaml
# ─── Phase 1: Spec Updates (spec-first) ───

- title: Update daemon-server ac-8 spec language
  slug: task-update-daemon-server-ac8
  priority: 1
  tags: [spec-update]
  spec_ref: "@daemon-server"
  description: |
    Replace the implementation-prescriptive ac-8 on @daemon-server
    with behavioral language that specifies reliable cross-platform
    monitoring without naming specific backends.

    Why: The current ac-8 says "fall back to Chokidar file watcher"
    which is an implementation detail, not a behavioral contract. The
    spec should describe the observable behavior: file changes are
    detected reliably on all supported platforms. This must happen
    before the implementation tasks so work proceeds against correct
    specs.

    What: Run kspec item ac set @daemon-server ac-8 to replace the
    given/when/then with behavioral language. Remove any references
    to specific runtime APIs or library names from the AC text.

    How: kspec item ac set @daemon-server ac-8
      --given "the daemon needs to detect file changes"
      --when "file monitoring is initialized"
      --then "changes are detected reliably across all supported
              platforms without manual configuration"

    Covers: @daemon-server ac-8 (replacement).

- title: Update multi-directory-daemon ac-19 for resource bounding
  slug: task-update-multi-dir-ac19
  priority: 1
  tags: [spec-update]
  spec_ref: "@multi-directory-daemon"
  description: |
    Extend ac-19 on @multi-directory-daemon to cover runtime resource
    exhaustion from monitoring large directories, not just creation-time
    EMFILE/ENFILE errors.

    Why: The original ac-19 only covers the case where watcher creation
    fails due to OS ulimits. The real-world failure mode is subtler —
    the watcher succeeds but consumes so many file descriptors that
    subsequent watchers for other projects silently fail. The spec
    should cover resource proportionality, not just hard OS errors.
    This must happen before implementation so the new behavior is
    specified before it's built.

    What: Run kspec item ac set @multi-directory-daemon ac-19 to
    replace the narrow EMFILE/ENFILE language with the broader resource
    constraint language.

    How: kspec item ac set @multi-directory-daemon ac-19
      --given "project file monitoring would consume excessive system
              resources due to directory size or OS limits"
      --when "the resource impact is detected during initialization
              or health monitoring"
      --then "the daemon reports the resource constraint with
              actionable guidance and does not allow the project's
              monitoring to degrade other registered projects"

    Covers: @multi-directory-daemon ac-19 (replacement).

# ─── Phase 2: Implementation — Standardize on Chokidar ───

- title: Replace dual-backend watcher with Chokidar-only implementation
  slug: task-chokidar-standardize
  priority: 1
  tags: [daemon, watcher, foundation]
  spec_ref: "@daemon-file-monitoring"
  depends_on:
    - "@task-update-daemon-server-ac8"
  description: |
    Replace the Bun fs.watch primary / Chokidar fallback dual-backend
    strategy in both KspecWatcher and SessionWatcher with Chokidar as
    the sole monitoring backend.

    Why: Bun's fs.watch with recursive:true has three confirmed bugs on
    Linux — it opens a file descriptor for every file in the watched tree
    (not just directories as inotify should), it leaks FDs on .close()
    (count increases rather than decreasing), and it can deliver events
    from one watcher's directory to another watcher's callback. These
    bugs cause the daemon to accumulate 190k+ FDs within minutes on
    projects with large session directories, which in turn causes
    secondary project watchers to silently fail. Chokidar uses native
    platform APIs correctly (inotify on Linux, FSEvents on macOS,
    ReadDirectoryChangesW on Windows) and is battle-tested in webpack,
    vite, and similar long-running tools.

    What: In packages/daemon/src/watcher.ts — remove startBunWatcher(),
    remove the try/catch fallback in start(), remove the usingChokidar
    flag and conditional close() logic. Make start() call Chokidar
    directly. Keep the existing debounce (500ms), YAML parse validation,
    nested .kspec path filtering, and error recovery with exponential
    backoff. In packages/daemon/src/session-watcher.ts — same removal
    of dual-backend, same Chokidar-only approach. Keep the bootstrap
    polling for lazy directory creation and the 250ms debounce.

    How: The Chokidar initialization in both files already exists as
    the fallback path. Promote it to the only path, remove the Bun
    path, and simplify. Keep chokidar v4.0.3+ (already a dependency).
    The ignored function for SessionWatcher does not change yet — that
    is task-session-blob-exclusion.

    Covers: @daemon-file-monitoring ac-1, ac-4, ac-5.

- title: Exclude session content storage from file monitoring
  slug: task-session-blob-exclusion
  priority: 1
  tags: [daemon, watcher, performance]
  spec_ref: "@daemon-file-monitoring"
  depends_on:
    - "@task-chokidar-standardize"
    - "@task-update-multi-dir-ac19"
  description: |
    Configure the session watcher to exclude content storage
    directories (blobs/) from monitoring, reducing FD consumption
    from ~185k to ~7k for large projects.

    Why: The daemon monitors .kspec-sessions/ for session lifecycle
    changes (creation, status updates, event recording). The sessions
    directory also contains a blobs/ subdirectory per session holding
    externalized content data — these are written during session
    recording and read on demand, but changes to blob files never
    drive cache invalidation. With Chokidar watching the full tree,
    it opens an inotify watch per directory. On a project with 1500+
    sessions and 180k+ blob files, this consumes ~185k file
    descriptors. With blob exclusion, only session metadata directories
    are watched (~7k FDs for the same project).

    What: In the SessionWatcher's Chokidar configuration, add an
    ignored function that returns true for paths matching blobs/
    directories and their contents. The function must allow directory
    traversal (return false for session root directories) while
    blocking descent into blobs/ subdirectories. Also exclude
    non-metadata file types — only .yaml and .jsonl files need
    monitoring in the sessions tree.

    How: The ignored function receives the path and optional stats.
    Check for /blobs at end of path or /blobs/ within path. For files
    (paths with extensions), only allow .yaml and .jsonl through.
    Validated via standalone test: Chokidar with this filter uses
    ~7k FDs vs 185k without, and correctly detects session.yaml
    modifications and new session directory creation.

    Covers: @daemon-file-monitoring ac-2, ac-3, ac-7.

# ─── Phase 3: Health Monitoring ───

- title: Implement watcher health verification
  slug: task-watcher-health-check
  priority: 2
  tags: [daemon, watcher, reliability]
  spec_ref: "@daemon-watcher-health"
  depends_on:
    - "@task-chokidar-standardize"
    - "@task-session-blob-exclusion"
  description: |
    Add a periodic health check that verifies file monitoring is
    actively delivering events, detecting silent watcher failures
    that report as active but stop delivering events.

    Why: The investigation that prompted this plan found a secondary
    project with watcherActive=true but lastInvalidatedAt=null on
    most domains — the watcher was structurally present but functionally
    dead. No existing mechanism detects this. The health check writes
    a sentinel file, waits for the watcher callback, and restarts
    monitoring if the callback never fires.

    What: A WatcherHealthMonitor that runs at a configurable interval
    (default 60 seconds). For each project with active monitoring, it
    writes a sentinel YAML file into the watched directory, waits for
    the watcher's change callback to fire within a timeout window
    (debounce time + margin), and records success or failure. On
    failure, it stops and restarts the watcher for that project,
    logging the incident. The sentinel file is cleaned up after each
    check. The health check results are exposed through the existing
    cache diagnostic endpoint.

    How: The health monitor lives in ProjectContextManager or as a
    standalone class wired in server.ts. It uses a .kspec/.health-check
    sentinel file (gitignored, cleaned up after each probe). The
    timeout is debounce_ms + 2000ms margin. On failure, call
    stopWatcher() then startWatcher() for the affected project.
    Track last_health_check_at and consecutive_failures per project
    in the ProjectContext. Extend the /api/debug/cache-status response
    to include these fields.

    Covers: @daemon-watcher-health ac-1, ac-2, ac-3, ac-4.

# ─── Phase 4: Test Coverage ───

- title: Unit tests for Chokidar-only watcher
  slug: task-test-chokidar-watcher
  priority: 2
  tags: [daemon, watcher, test]
  spec_ref: "@daemon-file-monitoring"
  depends_on:
    - "@task-chokidar-standardize"
    - "@task-session-blob-exclusion"
  description: |
    Update existing watcher tests and add new coverage for the
    Chokidar-only implementation and session blob exclusion.

    Why: The existing test files (daemon-watcher-fallback.test.ts,
    daemon-watcher-error-handling.test.ts, daemon-watcher-multi-project.test.ts,
    session-watcher.test.ts) test the dual-backend strategy including
    Bun-specific behavior and fallback paths that no longer exist.
    Tests must be updated to reflect the single-backend reality and
    new blob exclusion behavior.

    What: Remove or rewrite tests in daemon-watcher-fallback.test.ts
    that assert Bun→Chokidar fallback — the fallback concept is gone.
    Keep error handling tests (exponential backoff, permanent failure,
    max retries) since those behaviors are unchanged. Add tests for:
    session blob exclusion (verify blobs/ directories are not watched),
    resource proportionality (FD count scales with directories not
    files), cross-platform file detection (atomic writes via rename),
    and multi-project watcher isolation (no cross-project events).
    Add a test for new session directory detection to verify ac-7.

    How: Tests use temp directories with controlled file counts.
    The FD count test creates a sessions directory with synthetic
    blob files and verifies the watcher's FD footprint. The isolation
    test creates two watched directories and verifies events don't
    cross. Tests that depend on real fs.watch behavior continue to
    skip in CI (GitHub Actions limitation).

    Covers: @daemon-file-monitoring ac-1 through ac-8.
    Note: ac-6 (cross-project isolation) and ac-8 (persistent failure
    unregistration) are already implemented per @multi-directory-daemon
    ac-18 and ac-34 respectively — this task adds test coverage for
    those behaviors under the new monitoring spec.

- title: Integration test for watcher health verification
  slug: task-test-watcher-health
  priority: 3
  tags: [daemon, watcher, test]
  spec_ref: "@daemon-watcher-health"
  depends_on:
    - "@task-watcher-health-check"
  description: |
    Integration tests verifying the health check detects and recovers
    from silent watcher failures, and that the diagnostic endpoint
    exposes health data.

    Why: The health check is the regression safety net for the exact
    failure mode this plan addresses — silent watcher death in
    multi-project setups. Without tests, the health check itself
    could silently fail.

    What: Test that a healthy watcher passes the health check
    (sentinel write → callback fires → success recorded). Test that
    a simulated silent failure (watcher stopped but watcherActive
    still true) triggers restart and logs the incident. Test that
    the /api/debug/cache-status endpoint includes health check
    timestamps and failure counts. Test that a single-project health
    failure doesn't affect other projects' monitoring.

    How: Use the existing daemon test infrastructure with temp
    directories. Simulate silent failure by directly closing the
    underlying Chokidar watcher without going through the normal
    stop path, leaving the watcherActive flag true. Verify the
    health monitor detects the dead watcher within the check
    interval + timeout window.

    Covers: @daemon-watcher-health ac-1 through ac-4.

# ─── Phase 5: Cleanup ───

- title: Remove Bun fs.watch code paths and unused fallback tests
  slug: task-cleanup-bun-watcher
  priority: 3
  tags: [daemon, cleanup]
  depends_on:
    - "@task-test-chokidar-watcher"
  description: |
    Final cleanup pass to remove any residual Bun fs.watch references,
    dead code, and obsolete test infrastructure.

    Why: After the Chokidar-only implementation is tested and the
    fallback tests are rewritten, any remaining Bun-specific code is
    dead weight. This includes console.log messages referencing "Bun
    fs.watch", the usingChokidar boolean checks in stop() methods,
    and any test mocks for the Bun watcher.

    What: Audit watcher.ts and session-watcher.ts for any remaining
    references to "Bun", "fs.watch", or conditional Chokidar paths.
    Remove the startBunWatcher methods if not already removed in
    task-chokidar-standardize (they should be, but verify). Remove
    the usingChokidar flag and simplify stop() to always call
    Chokidar's close(). Update the testing convention in AGENTS.md
    if it references the watcher CI skip reason ("GitHub Actions
    does not support recursive fs.watch") — update to clarify it's
    a Chokidar/inotify CI limitation. Remove daemon-watcher-fallback
    test file if fully subsumed by new tests.

    How: grep -r for "Bun", "fs.watch", "startBun", "usingChokidar"
    in packages/daemon/src/ and tests/. Remove hits. Run full test
    suite to verify nothing breaks.
```

## Implementation Notes

This plan addresses two confirmed bugs found via daemon process
inspection:

1. Bun's fs.watch({recursive: true}) opens an FD for every file in
   the watched tree (not just directories). On a project with 180k+
   session blob files, this causes 191k+ leaked FDs within minutes of
   daemon startup. Closing the watcher makes the FD count increase
   rather than decrease.

2. When a secondary project registers with a daemon that already has
   190k+ FDs from the primary project's watcher, the secondary project's
   KspecWatcher silently fails — watcherActive reports true but no
   filesystem events are delivered. The SessionWatcher for the same
   project works, suggesting the failure is triggered by resource
   pressure at initialization time.

The fix has two independent levers:
- Standardize on Chokidar (eliminates the Bun FD leak bug)
- Exclude blob directories from monitoring (eliminates the root cause
  of excessive resource consumption regardless of backend)

Both are needed. Chokidar alone still opens 185k FDs when watching
a directory with 180k files. The exclusion filter brings this to ~7k.
The health monitor is the regression safety net — it catches any future
variant of "watcher looks alive but isn't delivering events."

Validated empirically: Chokidar with blob exclusion uses 7,281 FDs,
detects session.yaml modifications, and detects new session directory
creation. Without exclusion, both Bun and Chokidar use 185k+ FDs.
