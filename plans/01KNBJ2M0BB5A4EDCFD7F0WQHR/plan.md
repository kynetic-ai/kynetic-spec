# Active-Session-Scoped File Monitoring

## Tasks

derive_from_specs: false

```yaml
# ─── Phase 1: Spec Update ───

- title: Update daemon-file-monitoring ac-3 for active-session FD proportionality
  slug: task-monitoring-spec-ac3-active-sessions
  priority: 1
  tags: [spec-update, daemon, sessions]
  spec_ref: "@daemon-file-monitoring"
  description: |
    Update acceptance criterion ac-3 on @daemon-file-monitoring to scope
    file descriptor proportionality to active sessions rather than all
    sessions.

    Why: The current ac-3 says FD count should be "proportional to the
    number of monitored directories and metadata files, not to the total
    number of stored content files." This was written when the blob
    exclusion fix was the goal. The blob fix shipped, but the daemon
    still opens FDs for every session directory's metadata files
    (session.yaml, events.jsonl) regardless of whether the session is
    active or completed. After extended dispatch runs with 1,600+
    sessions, this exhausts daemon resources (~13,000 FDs) and causes
    the HTTP handler to stop responding even though the process stays
    alive. The spec needs to explicitly require that FD usage scales
    with the number of active sessions, not the total historical count.

    What: Update ac-3's "then" clause to:
      "File descriptor count is proportional to the number of active
      sessions and monitored spec directories"

    How: Run:
      kspec item ac set @daemon-file-monitoring ac-3 \
        --then "File descriptor count is proportional to the number of active sessions and monitored spec directories"

    Verify with:
      kspec item get @daemon-file-monitoring

    Covers: @daemon-file-monitoring ac-3 (update).

- title: Add active-session watching ACs to daemon-file-monitoring
  slug: task-monitoring-spec-active-session-acs
  priority: 1
  tags: [spec-update, daemon, sessions]
  spec_ref: "@daemon-file-monitoring"
  depends_on:
    - "@task-monitoring-spec-ac3-active-sessions"
  description: |
    Add four new acceptance criteria to @daemon-file-monitoring that
    define the active-session-only watching contract.

    Why: The existing spec has eight ACs covering blob exclusion,
    platform reliability, cross-project isolation, new session detection,
    and error recovery. None of them address *which* sessions should be
    watched. The daemon currently watches all sessions regardless of
    status, which causes resource exhaustion at scale. These new ACs
    establish that the daemon should only maintain file watches for
    sessions with active status, and that non-active sessions are not
    watched.

    The session status enum (defined in src/sessions/types.ts) includes
    six values: active, completed, abandoned, timed_out, failed, and
    stalled. Only "active" is non-terminal for watching purposes — all
    other statuses indicate the session is no longer receiving updates
    and does not need a file watcher.

    What: Add these four ACs via kspec item ac add:

    ac-active-only-watching:
      given: The sessions directory contains both active and non-active
             sessions (completed, abandoned, failed, timed_out, or
             stalled)
      when: File monitoring is running for the sessions directory
      then: Only sessions with active status are individually watched
            for metadata and event changes

    ac-session-close-unwatch:
      given: A watched session transitions from active to any non-active
             status (completed, abandoned, failed, timed_out, or stalled)
      when: The status change is detected by the watcher
      then: The per-session watch is removed and its file descriptors
            are released

    ac-new-session-conditional-watch:
      given: A new session directory appears in the sessions directory
      when: The top-level directory watcher detects the new entry
      then: The new session's metadata is checked and a per-session
            watch is added only if the session has active status

    ac-startup-active-only:
      given: The daemon starts with existing sessions in the sessions
             directory
      when: File monitoring is initialized
      then: Only sessions with active status at startup time are
            watched

    How: Use kspec batch for atomicity:

    [
      {
        "command": "item ac add",
        "args": {
          "ref": "@daemon-file-monitoring",
          "id": "ac-active-only-watching",
          "given": "The sessions directory contains both active and non-active sessions (completed, abandoned, failed, timed_out, or stalled)",
          "when": "File monitoring is running for the sessions directory",
          "then": "Only sessions with active status are individually watched for metadata and event changes"
        }
      },
      {
        "command": "item ac add",
        "args": {
          "ref": "@daemon-file-monitoring",
          "id": "ac-session-close-unwatch",
          "given": "A watched session transitions from active to any non-active status (completed, abandoned, failed, timed_out, or stalled)",
          "when": "The status change is detected by the watcher",
          "then": "The per-session watch is removed and its file descriptors are released"
        }
      },
      {
        "command": "item ac add",
        "args": {
          "ref": "@daemon-file-monitoring",
          "id": "ac-new-session-conditional-watch",
          "given": "A new session directory appears in the sessions directory",
          "when": "The top-level directory watcher detects the new entry",
          "then": "The new session's metadata is checked and a per-session watch is added only if the session has active status"
        }
      },
      {
        "command": "item ac add",
        "args": {
          "ref": "@daemon-file-monitoring",
          "id": "ac-startup-active-only",
          "given": "The daemon starts with existing sessions in the sessions directory",
          "when": "File monitoring is initialized",
          "then": "Only sessions with active status at startup time are watched"
        }
      }
    ]

    Verify with:
      kspec item get @daemon-file-monitoring

    Covers: @daemon-file-monitoring (new ACs: ac-active-only-watching,
    ac-session-close-unwatch, ac-new-session-conditional-watch,
    ac-startup-active-only).

# ─── Phase 2: Session Watcher Refactor ───

- title: Refactor SessionWatcher from recursive-all to active-session-scoped watching
  slug: task-refactor-session-watcher-active-scoped
  priority: 2
  tags: [daemon, sessions, refactor]
  spec_ref: "@daemon-file-monitoring"
  depends_on:
    - "@task-monitoring-spec-active-session-acs"
  description: |
    Replace the single recursive chokidar watcher on the entire
    .kspec-sessions/ directory with a two-tier approach that only
    watches active sessions.

    Why: The current SessionWatcher (packages/daemon/src/session-watcher.ts)
    creates one chokidar instance watching the entire .kspec-sessions/
    directory recursively. Every session directory gets file descriptors
    for its directory entry, session.yaml, and events.jsonl — regardless
    of whether the session is active or completed. After extended
    dispatch runs producing 1,600+ sessions, the daemon accumulates
    ~13,000 open FDs. The bun process stays alive and accepts TCP
    connections on its listening socket, but the HTTP handler stops
    responding (zero bytes returned). The blob exclusion fix
    (shouldIgnorePath filtering out paths containing "blobs") reduced
    content file FDs but did not address the per-session metadata FDs.
    Only 1-5 sessions are typically active at any time, so watching all
    1,600+ is pure waste.

    What: Restructure SessionWatcher into two layers:

    1. A top-level watcher on .kspec-sessions/ with depth 0 that only
       detects new session directories appearing (addDir events). This
       watcher does not recurse into session directories.

    2. Per-session chokidar watchers, stored in a Map<string, ChokidarWatcher>,
       created only for sessions whose session.yaml has status "active".
       Each per-session watcher monitors that session's directory for
       session.yaml and events.jsonl changes. The existing
       shouldIgnorePath logic (blob exclusion, non-yaml/jsonl filtering)
       applies to per-session watchers.

    The session status enum (defined in src/sessions/types.ts) has six
    values: active, completed, abandoned, timed_out, failed, stalled.
    Only status === "active" means the session needs watching. All other
    statuses are non-active and should not have watchers.

    Startup behavior: scan .kspec-sessions/ for all session directories.
    For each, read session.yaml and parse the status field. Create
    per-session watchers only for sessions with status === "active".
    Skip all other statuses.

    New session detection: when the top-level watcher emits addDir for
    a new session directory, read its session.yaml. If status is
    "active", create a per-session watcher. If the session.yaml doesn't
    exist yet (race with session creation), retry after a short delay
    (e.g. 200ms). If status is already non-active, skip.

    Session close detection: when a per-session watcher detects a
    change to session.yaml, re-read the status field. If it has
    transitioned to any non-active status (completed, abandoned, failed,
    timed_out, stalled), close that per-session watcher, remove it
    from the Map, and fire onSessionChange one final time so the
    entity cache picks up the terminal state.

    The onSessionChange callback contract is unchanged — consumers
    (entity cache invalidation via project-context.ts, WebSocket
    broadcast) receive the same session root path they do today.

    The entity cache session index reload
    (src/daemon/entity-cache.ts loadSessionIndex) already reads all
    session directories from disk and keeps only the 100 most recent,
    so no cache changes are needed. The cache reload is triggered by
    onSessionChange from active session changes, which is sufficient
    for freshness.

    Determine active status from session.yaml, not from the runtime
    SessionRegistry (src/agent-runtime/session-registry.ts). Reason:
    on daemon restart, SessionRegistry is empty but sessions from a
    previous run may still have status "active" on disk. The watcher
    must pick those up. The existing stale session detection (24h
    older-than / 6h inactive-for thresholds in src/sessions/store.ts)
    handles truly abandoned sessions separately.

    Preserve the existing error handling: per-session watcher errors
    should trigger the same retry-with-backoff and eventual
    unregistration behavior. The top-level watcher error path should
    also retry, since losing it means no new sessions would be detected.

    How: Edit packages/daemon/src/session-watcher.ts. The class
    interface (constructor options, start(), stop(), public API) stays
    the same. Internal state changes from a single `watcher` field to
    a `topLevelWatcher` plus a `sessionWatchers: Map<string, ChokidarWatcher>`.
    The stop() method must close all per-session watchers in addition
    to the top-level watcher. Update the existing tests in
    tests/session-watcher.test.ts to cover the new behavior.

    Covers: @daemon-file-monitoring ac-3 (updated), ac-active-only-watching,
    ac-session-close-unwatch, ac-new-session-conditional-watch,
    ac-startup-active-only.

# ─── Phase 3: FD Regression Test ───

- title: Add FD budget regression test for active-session-scoped watching
  slug: task-fd-regression-test-active-scoping
  priority: 3
  tags: [daemon, sessions, testing]
  spec_ref: "@daemon-file-monitoring"
  depends_on:
    - "@task-refactor-session-watcher-active-scoped"
  description: |
    Add a regression test that proves file descriptor count scales with
    the number of active sessions, not total sessions.

    Why: The original bug was that 1,600+ historical sessions caused
    ~13,000 open FDs and made the daemon unresponsive. The existing FD
    measurement test in tests/session-watcher.test.ts (the blob
    exclusion test at ~line 176) measures FD delta between 1-blob and
    250-blob sessions, confirming blob content doesn't leak FDs. There
    is no test that measures FD delta between "many completed sessions"
    and "few active sessions" — which is the scenario this plan fixes.
    Without this test, a future change could regress back to watching
    all sessions.

    What: Create a test that:

    1. Sets up a .kspec-sessions/ fixture directory with N completed
       sessions (e.g. 50) and M active sessions (e.g. 2). Each session
       directory contains a session.yaml with the appropriate status
       field, an empty events.jsonl, and optionally a blobs/ directory.
       The session status enum has six values (active, completed,
       abandoned, timed_out, failed, stalled) — use a mix of non-active
       statuses for the completed fixtures to exercise all paths.

    2. Creates a SessionWatcher on this fixture directory and starts it.

    3. Measures the FD delta (using the same /proc/self/fd counting
       technique as the existing blob exclusion test, or
       process.getActiveResourcesInfo if available in the bun runtime).

    4. Asserts that the FD count is proportional to M (active sessions),
       not N+M (all sessions). Concretely: FD delta should be bounded
       by a small multiple of M (accounting for the top-level watcher
       and per-session overhead), and should NOT grow linearly with N.

    5. Optionally: repeat with N=100 and verify FD delta doesn't change
       significantly, proving independence from completed session count.

    How: Add the test to tests/session-watcher.test.ts alongside the
    existing FD measurement tests. Use the same fixture creation
    helpers (writeFileSync for session.yaml with appropriate YAML
    content, mkdirSync for session directories). The session.yaml
    content for completed sessions should be:
      id: <ULID>
      status: completed
      started_at: <ISO timestamp>
      ended_at: <ISO timestamp>
      agent_type: test

    For active sessions:
      id: <ULID>
      status: active
      started_at: <ISO timestamp>
      agent_type: test

    Covers: @daemon-file-monitoring ac-3 (updated),
    ac-active-only-watching, ac-startup-active-only.
```

## Implementation Notes

### Why the current approach fails

SessionWatcher creates a single recursive chokidar on .kspec-sessions/.
With 1,625 sessions (typical after extended dispatch runs), this opens
~13,000 file descriptors. The daemon process stays alive but stops
responding to HTTP requests — it accepts TCP connections but never sends
a response. The blob exclusion fix (637beb279) reduced FDs from content
files inside blobs/ but didn't address the per-session directory and
metadata file FDs.

### What the UI actually needs

- Active sessions: real-time updates via WebSocket (watcher-driven)
- Recent sessions (top 100): served from entity cache index, refreshed
  on active session changes
- Historical sessions: on-demand disk reads, no freshness guarantee needed

### Design decision: session.yaml status vs SessionRegistry

The watcher determines "active" by reading session.yaml status, not by
consulting SessionRegistry. Reason: on daemon restart, SessionRegistry is
empty but active sessions from a previous run still exist on disk with
status: active. The watcher needs to pick those up. The stale session
detection (24h/6h thresholds) handles truly abandoned sessions separately.

### On-demand disk reads for unwatched sessions

API routes for session data (packages/daemon/src/routes/sessions.ts)
already have disk fallback paths — used when the entity cache domain is
not "ready" or when a session isn't in the bounded top-100 index. This
behavior is already covered by existing specs: @daemon-entity-cache
ac-detail-on-demand, ac-graceful-degradation, and ac-session-bounded-index
cover on-demand disk reads, while @session-list-pagination-api owns
GET /api/sessions behavior. No new spec or AC is needed for this path.
