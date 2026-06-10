# Daemon Operational Reliability

This plan hardens the daemon's operational story: fatal failures currently
leave no trace (no process-level fault handlers, detached stdio discarded, no
log file), a hung command can wedge the daemon command queue indefinitely, a
non-loopback connect host is accepted silently, and the shipped web UI emits
debug console output and fetches the full task list to compute dashboard
counts.

Prior art this plan builds on instead of duplicating:

- `@trait-localhost-security` and `@daemon-network-endpoint-contract` already
  own loopback-default binding, explicit external opt-in, and the external
  bind-host warning. Only the connect-host warning gap is added here, as a
  delta AC.
- `@cli-serve-commands` ac-8/ac-9 already specify `kspec serve logs` against a
  daemon log file that does not exist yet. This plan supplies the log-capture
  contract and implements those existing ACs rather than re-specifying them.
- `@ui-api-aggregation` ac-1 already specifies (and the daemon already
  implements) the pre-computed task status summary endpoint. This plan only
  adds the client-side consumption contract as a delta AC on
  `@ui-dashboard-overview`.
- The completed plan "Daemon Dispatch OOM Hardening Spec Alignment" covered
  event-lineage bounding, reconciliation overlap, command recursion, and
  cleanup diagnostics. No overlap with this plan's scope.

## Specs

```yaml
- title: Daemon Failure Observability
  slug: daemon-failure-observability
  type: requirement
  parent: "@daemon-server"
  description: |
    When the daemon process terminates — gracefully or because of a fatal
    error — the termination reason is durably recorded outside the process
    and can be retrieved after the fact. Fatal conditions that would
    otherwise end the process without a trace (uncaught errors, unhandled
    asynchronous rejections) are captured with diagnostic detail before the
    process exits. The daemon lifecycle status surface reports the most
    recent termination when no daemon is running, so a user investigating a
    disappeared daemon can see why it stopped without reproducing the
    failure.
  acceptance_criteria:
    - id: ac-fatal-error-recorded
      given: |
        The daemon process is running
      when: |
        An uncaught error or an unhandled asynchronous rejection occurs in
        the daemon process
      then: |
        The error message, available stack detail, and a timestamp are
        durably recorded before the process exits, and the process exits
        with a non-zero exit code
    - id: ac-exit-record-durable
      given: |
        The daemon process has terminated for any reason
      when: |
        A user inspects daemon state after the process is gone
      then: |
        A durable record of the most recent termination is retrievable
        without a running daemon, containing the termination kind
        (graceful shutdown, fatal error, or startup failure), the reason
        detail, and a timestamp
    - id: ac-status-surfaces-last-exit
      given: |
        No daemon is running and a prior termination record exists
      when: |
        The daemon lifecycle status command runs
      then: |
        The output reports that the daemon is not running and includes the
        most recent termination kind, reason, and timestamp
    - id: ac-graceful-exit-recorded
      given: |
        The daemon shuts down in response to a shutdown signal or the stop
        command
      when: |
        The shutdown completes
      then: |
        The termination record identifies the termination as a graceful
        shutdown, so a later status check does not report it as a failure

- title: Daemon Log Capture
  slug: daemon-log-capture
  type: feature
  parent: "@daemon-server"
  description: |
    The daemon emits an operational log that survives the process. Daemon
    output is captured to a durable log file under the global daemon state
    location in every run mode, so background (detached) runs — which have
    no attached terminal — leave the same diagnostic trail as foreground
    runs. Log growth is bounded deterministically by size-based rotation
    with a fixed default cap, and the log location is discoverable from the
    lifecycle status surface.
  acceptance_criteria:
    - id: ac-detached-output-captured
      given: |
        The daemon was started in background (detached) mode
      when: |
        The daemon emits startup, diagnostic, warning, or error output
      then: |
        Each emitted line is appended to a durable log file under the
        global daemon state location instead of being discarded
    - id: ac-foreground-tee
      given: |
        The daemon is running in foreground mode
      when: |
        The daemon emits output
      then: |
        The output appears on the attached terminal and the same content is
        also appended to the durable log file
    - id: ac-log-line-timestamps
      given: |
        The daemon appends a line to the durable log file
      when: |
        The log file is read
      then: |
        Each captured line carries a timestamp
    - id: ac-bounded-rotation
      given: |
        Appending the next captured line would push the active daemon log
        file past the configured maximum size (default 5 MiB when not
        configured)
      when: |
        The daemon writes that output
      then: |
        The active log is rotated before the write so the new line begins
        a fresh active file, exactly one prior rotated generation is
        retained, older rotated content is deleted, and the combined size
        of retained log files never exceeds twice the configured maximum
        size plus the size of a single captured line
    - id: ac-log-location-discoverable
      given: |
        The daemon is running or has previously run
      when: |
        The daemon lifecycle status command reports daemon state
      then: |
        The output includes the daemon log file location

- title: Shipped UI Console Hygiene
  slug: ui-production-log-hygiene
  type: requirement
  parent: "@web-ui"
  description: |
    The shipped web interface does not emit debug- or informational-level
    diagnostic output to the browser console during normal operation.
    Console output in the shipped interface is reserved for actionable
    warnings and errors. Routine lifecycle activity — navigation, item
    selection, realtime connection progress, duplicate-event suppression —
    produces no console output by default.
  acceptance_criteria:
    - id: ac-no-debug-output-default
      given: |
        The shipped web interface is loaded in a browser with default
        settings
      when: |
        A user performs routine interactions (navigating views, selecting
        items) and the realtime connection performs its normal lifecycle
        (connect, receive events, disconnect, reconnect)
      then: |
        No debug- or informational-level diagnostic messages are written to
        the browser console
    - id: ac-errors-preserved
      given: |
        A genuine failure occurs in the shipped interface (a request fails,
        a message cannot be parsed, or an internal handler throws)
      when: |
        The interface handles the failure
      then: |
        A warning- or error-level console message is emitted that describes
        the failure
```

## Tasks

derive_from_specs: false

```yaml
- title: Add daemon reliability delta ACs to existing specs
  slug: task-update-daemon-reliability-specs
  priority: 1
  tags: [spec-update, daemon, reliability]
  spec_ref: "@daemon-command-api"
  description: |
    Add the delta acceptance criteria this plan needs on existing specs.
    The new specs in this plan (@daemon-failure-observability,
    @daemon-log-capture, @ui-production-log-hygiene) are materialized by
    kspec plan derive after the plan is approved — plan import only stores
    the plan document. This task covers only the deltas to specs that
    already exist.

    Why: Command timeout behavior belongs on @daemon-command-api (which
    already owns command execution semantics), the connect-host warning
    belongs on @daemon-network-endpoint-contract (which already owns the
    bind-host external warning via ac-external-binding-warning), and the
    dashboard counts contract belongs on @ui-dashboard-overview. Creating
    parallel specs would duplicate existing contracts.

    What: Use kspec item ac add (via kspec batch) to add the following ACs
    exactly, unless an equivalent AC already exists.

    1. Add to @daemon-command-api:

       ac-command-timeout:
         given: A command submitted through the command execution endpoint
           is still executing when the configured execution time limit
           elapses (default 120 seconds when not configured)
         when: The limit elapses
         then: The caller receives a structured error response identifying
           the command and the elapsed limit, while the command's
           underlying execution is not forcibly terminated and command
           execution remains serialized

       ac-timeout-queue-bounded:
         given: A previously timed-out command is still executing, so
           commands that require serialized execution are waiting behind
           it
         when: A new command is submitted through the command execution
           endpoint
         then: The caller receives a response within its own configured
           execution time limit — the normal result if execution begins
           and completes in time, otherwise the same structured timeout
           error — and a command whose limit elapses before its execution
           begins is discarded without ever executing

       ac-stuck-command-reported:
         given: A dispatched command has exceeded the configured execution
           time limit and has not completed
         when: The daemon health reporting surface is queried
         then: The response reports that command dispatch is degraded,
           identifying the stuck command and how long it has been
           executing, and stops reporting it once the command completes

       ac-timeout-isolation:
         given: A command timed out and its underlying execution later
           completes or emits further output
         when: Subsequent commands execute through the command execution
           endpoint
         then: The late output from the timed-out command is not attributed
           to any other command's response, and its completion frees
           waiting commands to proceed

    2. Add to @daemon-network-endpoint-contract:

       ac-external-connect-host-warning:
         given: The configured connect host is a non-loopback address
         when: The daemon starts or a lifecycle command reports the
           endpoint
         then: The output includes a visible warning that the daemon will
           accept requests addressed to that host value

    3. Add to @ui-dashboard-overview:

       ac-counts-from-summary:
         given: The dashboard is connected to a live backend
         when: The dashboard computes the status summary counts
         then: The counts are obtained from the pre-computed server-side
           status summary rather than by retrieving the full task list

    How: Run kspec item get on each target spec first to confirm no
    equivalent AC exists, then add via kspec batch with item ac add
    commands. Use file-based payloads for the multi-line given/when/then
    text.

    Testing: kspec validate passes; kspec item get @daemon-command-api,
    @daemon-network-endpoint-contract, and @ui-dashboard-overview show the
    new ACs.

- title: Implement daemon log file with rotation
  slug: task-daemon-log-capture
  priority: 1
  tags: [daemon, infra, reliability]
  spec_ref: "@daemon-log-capture"
  description: |
    Give the daemon a durable log file with deterministic size-based
    rotation, and tee daemon console output into it in all run modes.

    Why: src/cli/commands/serve.ts:444 spawns the detached daemon with
    stdio: "ignore" and an open TODO ("redirect to log file when logging
    implemented"). Every console.log/console.error in the daemon is
    discarded in detached mode, so production crashes and errors leave no
    accessible trace. @cli-serve-commands ac-8/ac-9 already promise a
    "daemon log file from the global daemon state directory under
    ~/.config/kspec/" that has never existed.

    What: A daemon-internal file logger that captures everything the daemon
    writes via console.log/warn/error (the daemon's only logging mechanism
    today) into ~/.config/kspec/daemon.log, with timestamps per line.
    Rotation: when an append would push daemon.log past the size limit
    (default 5 MiB, overridable via daemon config —
    daemon.log_max_size_bytes; extend DaemonConfigSchema in
    src/parser/config.ts, there is no src/config/ directory), rotate FIRST
    (rename daemon.log to daemon.log.1, replacing any existing
    daemon.log.1), then append to a fresh daemon.log — retained total
    bounded at 2x the limit plus at most one line. Foreground mode keeps
    terminal output and also writes the file.

    How: Implement the logger in packages/daemon/src (e.g. a new
    packages/daemon/src/logger.ts) that wraps console.log/warn/error to
    tee into an append-only file stream. Do the teeing inside the daemon
    process — do NOT change the stdio: "ignore" spawn in serve.ts;
    in-process capture works identically for foreground and detached
    modes and avoids parent-process file handle lifetime issues. Reuse
    getDefaultDaemonConfigDir() from src/daemon-shared/endpoint.ts
    (line 121, returns ~/.config/kspec) for the log path, and export a
    shared constant for the log filename from
    src/daemon-shared/endpoint.ts so the CLI (serve status / serve logs)
    resolves the same path.

    Interaction with the command-route console interception — get the
    model right: packages/daemon/src/routes/command.ts installs its
    console/stdout/stderr/exit interceptors ONCE at module load (~lines
    90-171: the current console.log etc. are captured as "originals" at
    import time and permanently replaced), then routes per call via
    AsyncLocalStorage (commandExecutionStorage) — output emitted during a
    command execution is pushed into that request's capture store and
    never reaches the captured originals. There is no per-command
    wrap/unwrap. packages/daemon/src/index.ts statically imports
    server.js, which statically imports command.js, so those interceptors
    are already installed before any index.ts body code runs — a tee
    installed "before createServer()" in the index.ts body would sit
    ABOVE the interception and double-log command output. To put the tee
    BENEATH the interception: install it at module load of the logger and
    make the logger the FIRST import in index.ts (a side-effect import
    line above the server.js import — ES module evaluation order runs it
    first). command.ts then captures the tee'd functions as its
    originals: daemon-side output (no active capture) flows interceptor →
    tee → file + terminal, while command output is swallowed by the
    capture store and never double-logged. Alternative if import ordering
    proves fragile: export an is-capturing check from command.ts and make
    the tee skip writes while a command capture store is active. The
    logger installs with built-in defaults at module load and applies the
    configured size limit once startup configuration is parsed. Rotate
    before any append that would cross the limit.

    Testing: Unit tests in tests/ (vitest, npm test) for the logger:
    timestamped lines appended, rotation triggers before the write that
    would cross the limit, exactly one .1 generation retained, total
    bounded at 2x limit plus one line. A guard test that output emitted
    while a command capture store is active does NOT land in the daemon
    log (no double-logging). Use createTempDir() and point the logger at
    a temp path. Annotate tests with AC comments.

    Covers: @daemon-log-capture ac-detached-output-captured,
    ac-foreground-tee, ac-log-line-timestamps, ac-bounded-rotation.

- title: Record and surface daemon termination reasons
  slug: task-daemon-fatal-failure-observability
  priority: 1
  tags: [daemon, reliability, cli]
  spec_ref: "@daemon-failure-observability"
  depends_on:
    - "@task-daemon-log-capture"
  description: |
    Install process-level fault handlers in the daemon, write a durable
    last-exit record on every termination path, and surface it from
    kspec serve status.

    Why: packages/daemon/src/index.ts has no uncaughtException /
    unhandledRejection handlers — an unhandled rejection kills the daemon
    with no diagnostics anywhere (stdio is discarded in detached mode).
    When the daemon disappears, kspec serve status just says "not running"
    with no explanation. This directly hampers investigations like the
    in-progress daemon OOM task (@investigate-daemon-dispatch-oom).

    What: (1) process.on("uncaughtException") and
    process.on("unhandledRejection") handlers registered in
    packages/daemon/src/index.ts before createServer() that log the error
    (message + stack) through the task-daemon-log-capture logger, write a
    last-exit record, then process.exit(1). (2) A last-exit record file
    ~/.config/kspec/daemon.last-exit.json with shape { kind:
    "graceful" | "fatal" | "startup_failure", reason: string, stack?:
    string, timestamp: ISO-8601, pid: number }. Write it from: the fault
    handlers (fatal), the shutdown() function in
    packages/daemon/src/server.ts (~line 1163, graceful — record the
    signal), and the startup catch block in packages/daemon/src/index.ts
    (startup_failure). (3) statusServer() in src/cli/commands/serve.ts
    (~line 595) reads the record when the daemon is not running and prints
    the last termination kind, reason, and timestamp (include the fields
    in --json output too).

    How: Put the record read/write helpers in
    src/daemon-shared/endpoint.ts next to PidFileManager so both the
    daemon (packages/daemon) and the CLI share one implementation and
    filename constant — that file is already shared between both builds.
    Overwrite the record on each termination (only the most recent matters
    per the spec). Do not remove the record on daemon start; a fresh start
    overwrites it only at the next termination. Graceful shutdown already
    removes pid/connection metadata via pidManager.remove() — the
    last-exit record must NOT be removed there.

    Testing: Unit tests for the record helpers (round-trip, malformed file
    tolerated). Behavioral test: spawn the daemon entry with an injected
    failure or call the handlers directly in a temp HOME/config dir and
    assert the record contents; CLI test that kspec serve status (with the
    daemon stopped and a record present) prints the termination reason —
    use the tests/helpers/cli.ts helpers with explicit cwd and
    buildTestSubprocessEnv(). Annotate ACs.

    Covers: @daemon-failure-observability ac-fatal-error-recorded,
    ac-exit-record-durable, ac-status-surfaces-last-exit,
    ac-graceful-exit-recorded.

- title: Implement kspec serve logs and status log path
  slug: task-serve-logs-command
  priority: 2
  tags: [cli, daemon, reliability]
  spec_ref: "@cli-serve-commands"
  depends_on:
    - "@task-daemon-log-capture"
  description: |
    Implement the long-spec'd kspec serve logs command and report the log
    file location from kspec serve status.

    Why: @cli-serve-commands ac-8 and ac-9 specify kspec serve logs
    (tail) and kspec serve logs --follow (stream) against the daemon log
    file — they have never been implemented because the log file did not
    exist. task-daemon-log-capture creates it.

    What: (1) New "logs" subcommand in registerServeCommands() in
    src/cli/commands/serve.ts (~line 214, alongside start/stop/status/
    restart): kspec serve logs prints the last N lines (default 50,
    --lines <n> to override) of the daemon log; kspec serve logs --follow
    keeps streaming appended lines until Ctrl+C. Works whether or not the
    daemon is currently running (the file persists); prints a clear
    actionable error if no log file exists yet. (2) statusServer() output
    gains a "Log file: <path>" line (and log_file field in --json).

    How: Resolve the path via the shared filename constant from
    src/daemon-shared/endpoint.ts added by task-daemon-log-capture. For
    --follow, use fs.watch or a 500ms polling stat/read loop on the file
    (polling is simpler and rotation-safe: reopen when the inode shrinks
    or the file is replaced). Respect rotation: when the active file is
    rotated mid-follow, continue from the new active file. Honor --json
    for the non-follow mode per @trait-json-output (lines array).

    Testing: CLI tests using kspec()/kspecJson() from tests/helpers/cli.ts
    with a fabricated log file in a temp global config dir (point HOME or
    the config-dir override at a temp dir): tail returns last lines,
    --lines respected, missing file error includes guidance, status shows
    the path. Follow mode: behavioral test with a child process appending
    lines, or document a manual check if timing proves flaky in CI.
    Annotate @cli-serve-commands ac-8, ac-9.

    Covers: @cli-serve-commands ac-8, ac-9; @daemon-log-capture
    ac-log-location-discoverable.

- title: Add command execution timeout to daemon command API
  slug: task-command-dispatch-timeout
  priority: 2
  tags: [daemon, api, reliability]
  spec_ref: "@daemon-command-api"
  depends_on:
    - "@task-update-daemon-reliability-specs"
  description: |
    Bound the time a caller of the daemon command route can be left
    waiting, and surface a wedged command queue to operators, so one hung
    command cannot silently make the daemon unusable.

    Why: packages/daemon/src/routes/command.ts serializes command
    dispatches through DispatchMutex (~line 196; cache-servable reads at
    ~line 625 bypass it). The mutex has no timeout: if a command hangs
    (deadlocked file lock, stuck network call), every subsequent
    serialized command request queues behind it indefinitely and the
    daemon is effectively dead for CLI proxy mode, the web UI, and
    dispatch — with no operator-visible signal. Live evidence: inbox item
    01KTRYDX records POST /api/command hanging indefinitely even for
    util ulid on a fresh daemon, with nothing to tell the operator why.

    Design decision — the timeout is client-observed, NOT an unwedge: on
    timeout the HTTP caller gets a structured error, but the mutex slot
    is NOT released and the abandoned execution is NOT killed. The
    abandoned execution runs to completion (or hangs forever) holding
    its slot; subsequent serialized commands queue behind it, and each
    gets its own bounded timeout response instead of an unbounded hang.
    Rationale: releasing the slot would let new commands run
    concurrently with the abandoned one, and for mutations the abandoned
    execution still holds the cross-process file lock (withFileLock,
    ~lines 638/751) — which same-process callers can NEVER reclaim
    (src/parser/file-lock.ts checkStaleLock treats the daemon's own live
    PID as not-stale), so follow-up mutations would only fail on lock
    timeouts. Holding the slot preserves the ac-concurrent-mutations
    serialization contract and keeps the semantics honest: the timeout
    buys diagnosability, and the paired degraded health report tells
    operators the remedy is a restart. Note the DispatchMutex doc
    comment claiming executeCommand mutates process-global cwd/console
    is stale: interception is installed once at module load and routed
    per call via AsyncLocalStorage, and the working directory is
    ALS-scoped (runWithWorkingDirectory in src/parser/yaml.ts — no
    process.chdir). There are no globals to restore on timeout; update
    that comment if you touch it, but keep the mutex.

    What: (1) A per-caller wait bound: default 120000 ms, overridable
    via daemon config (daemon.command_timeout_ms — extend
    DaemonConfigSchema in src/parser/config.ts; there is no src/config/
    directory). Forward the value to the daemon process through the
    spawn argv in src/cli/commands/serve.ts the same way --connect-host
    is forwarded (~line 422), parsed in packages/daemon/src/index.ts and
    threaded into the command route options. (2) On timeout the caller
    receives a structured error via the route's existing errorResponse
    pattern — HTTP 504 with body { error: "command_timeout", message:
    <command path + elapsed limit>, suggestion: <check kspec serve
    status / restart guidance> }. Do NOT look for an error helper in
    response-envelope.ts: wrapResponse there only shapes success
    envelopes; errors in these routes are errorResponse bodies of the
    { error, message, suggestion } / { error, details } form. (3) A
    command whose limit elapses while still queued (execution never
    started) is discarded when its slot finally frees — it must not
    execute after its caller was already told it timed out. (4) A wedge
    registry: track { command, startedAt } for the currently executing
    dispatch in command.ts module scope, export a getter, and extend the
    GET /api/health handler (packages/daemon/src/server.ts ~line 710) to
    report degraded command dispatch with the stuck command name and
    held duration whenever the current dispatch has exceeded its limit,
    clearing once it completes. (5) Batch path (~line 751): same bound
    applied whole-batch (a batch is one atomic dispatch).

    How: Race the awaited dispatchMutex.run(...) at the route-handler
    call sites (~lines 632 and 751) against a timer; clear the timer on
    normal completion to avoid open-handle leaks in tests. Do NOT modify
    DispatchMutex to drop the slot on timeout. Set a per-request
    timed-out flag when the race fires; the fn passed to
    dispatchMutex.run checks the flag first and returns immediately
    without executing (queued-command discard). Attach a .catch to the
    abandoned promise that logs a warning through the
    task-daemon-log-capture logger — REQUIRED, because
    task-daemon-fatal-failure-observability installs an
    unhandledRejection handler that exits the process; an abandoned
    command's late rejection must never crash the daemon. Leave the
    cache-served read path (~line 625) untouched — it bypasses the mutex
    and keeps working during a wedge. Cross-process callers contending
    on the file lock self-heal via the 30-second duration-ceiling
    reclaim in file-lock.ts; no work needed there.

    Testing: Vitest tests in the existing daemon route test suites with
    short configured timeouts (e.g. 50ms), never the 120s default: a
    stubbed never-resolving command times out with the 504
    command_timeout body (AC: @daemon-command-api ac-command-timeout); a
    second command submitted during the wedge receives its own bounded
    timeout response and is verifiably never executed after the wedge
    clears (AC: @daemon-command-api ac-timeout-queue-bounded); while
    wedged, GET /api/health reports the stuck command name and held
    duration, and stops reporting after completion (AC:
    @daemon-command-api ac-stuck-command-reported); a slow command that
    resolves after its timeout does not corrupt the response of the next
    command, and a late rejection from an abandoned command does not
    kill the process (AC: @daemon-command-api ac-timeout-isolation).
    Resolve wedge stubs at test end so no handles leak.

    Covers: @daemon-command-api ac-command-timeout,
    ac-timeout-queue-bounded, ac-stuck-command-reported,
    ac-timeout-isolation.

- title: Warn on non-loopback connect host
  slug: task-connect-host-exposure-warning
  priority: 3
  tags: [daemon, cli, security]
  spec_ref: "@daemon-network-endpoint-contract"
  depends_on:
    - "@task-update-daemon-reliability-specs"
  description: |
    Emit a visible warning when daemon.connect_host is configured to a
    non-loopback address, mirroring the existing bind-host warning.

    Why: The localhostOnly middleware in packages/daemon/src/server.ts
    (~line 459) extends the Host-header allowlist with endpoint.bindHost
    and endpoint.connectHost (~line 646). Wildcards are filtered
    (WILDCARD_HOSTS, line 351) but an explicit external IP/hostname in
    connect_host is silently added to the accepted Host values and
    advertised to all clients. Note this does NOT make a loopback-bound
    daemon externally reachable (the bind host controls the listening
    interface, and the existing ac-external-binding-warning covers
    external binds) — but a misconfigured connect_host silently weakens
    the Host-header (DNS-rebinding) protection and misroutes clients, so
    it must be loud.

    What: When the effective connect host is non-loopback: (1)
    startServer() in src/cli/commands/serve.ts emits a warning alongside
    the existing bind-host warning block (~line 432); (2) statusServer()
    (~line 633) does the same when reporting the endpoint. Reuse
    isExternallyReachable() from src/daemon-shared/endpoint.ts (line 250).
    Wording parallel to the existing warning: requests addressed to that
    host value will be accepted by the daemon; verify the value is
    intended.

    How: Pure additive warnings via warn() (already routes to stderr in
    JSON mode). No behavior change to binding, allowlisting, or metadata.

    Testing: CLI-level tests beside the existing external-binding-warning
    tests (find them via grep for ac-external-binding-warning under
    tests/): configure daemon.connect_host to a non-loopback value in a
    temp project's kspec.config.yaml and assert the warning text on
    stderr for start (can use --json mode to keep stdout clean) and
    status. Loopback connect_host produces no warning. Annotate
    @daemon-network-endpoint-contract ac-external-connect-host-warning.

    Covers: @daemon-network-endpoint-contract
    ac-external-connect-host-warning.

- title: Remove debug console output from shipped web UI
  slug: task-web-ui-debug-log-cleanup
  priority: 3
  tags: [web-ui, cleanup, reliability]
  spec_ref: "@ui-production-log-hygiene"
  description: |
    Strip debug/informational console output from the shipped web UI,
    keeping warnings and errors. Mechanical, tightly bounded change.

    Why: Debug logs ship to every user's browser console. Confirmed
    call sites (the full inventory — console.error/console.warn calls
    elsewhere are actionable-failure output and stay):

    - packages/web-ui/src/lib/components/TaskList.svelte lines 25, 28 —
      two console.log debug statements in selectTask.
    - packages/web-ui/src/lib/websocket/manager.ts lines 160, 168, 199,
      321, 408 (console.log connection tracing) and line 353
      (console.debug duplicate-event skip).

    What: Delete the two TaskList.svelte console.log lines. In
    manager.ts, remove the console.log/console.debug calls OR gate them
    behind a module-level debug flag that is false by default (e.g.
    const WS_DEBUG = false with a private debugLog helper) — choose
    gating for manager.ts since the connection traces have diagnostic
    value during development; choose deletion for TaskList.svelte (pure
    leftovers). Keep every console.warn/console.error in both files
    untouched (manager.ts lines 153, 184, 192, 342, 366, 378, 385, 395,
    469).

    Bounds — explicitly forbidden in this task: any semantic change to
    selection handling, reconnection logic, event dispatch, or message
    parsing; touching any file other than the two listed; introducing a
    logging library or new dependency; changing console.warn/error
    call sites.

    Testing: Run the web-ui unit suite and lint/format gates (see the
    work-gates skill for commands). Existing tests must pass unchanged —
    if a test asserts on the removed logs, update only that assertion.
    For AC annotation, add or extend a manager.ts unit test asserting no
    console.log/debug is called during a normal
    connect/message/disconnect cycle (spy on console), annotated with
    AC: @ui-production-log-hygiene ac-no-debug-output-default, and one
    asserting console.error still fires on a malformed message,
    annotated with AC: @ui-production-log-hygiene ac-errors-preserved.

    Covers: @ui-production-log-hygiene ac-no-debug-output-default,
    ac-errors-preserved.

- title: Use server-side task summary for dashboard counts
  slug: task-dashboard-summary-adoption
  priority: 3
  tags: [web-ui, performance, reliability]
  spec_ref: "@ui-dashboard-overview"
  depends_on:
    - "@task-update-daemon-reliability-specs"
  description: |
    Switch the dashboard status counts from a full task-list fetch to the
    existing pre-computed summary endpoint.

    Why: packages/web-ui/src/routes/+page.svelte (~line 66) has an open
    TODO: it fetches ALL tasks via fetchTasks() just to count statuses in
    a $derived block (~line 100). The project convention requires
    server-side aggregation for computed statistics, and the server side
    already exists: GET /api/aggregation/tasks/summary
    (packages/daemon/src/routes/aggregation.ts, AC-covered by
    @ui-api-aggregation ac-1, returns { counts: Record<status, number>,
    ready, blocked_by_dependencies, total }). No web UI code calls it
    today.

    What: (1) Add fetchTaskStatusSummary() to
    packages/web-ui/src/lib/api.ts following the existing fetcher
    pattern: in static mode (isStaticMode()), derive the same summary
    shape client-side from fetchTasksStatic() in
    packages/web-ui/src/lib/api-static.ts (static snapshots are local
    files — deriving there is fine and keeps GH Pages builds working);
    in live mode, call /api/aggregation/tasks/summary. (2) In
    +page.svelte, replace the tasksQuery full-list fetch with a query for
    the summary (add a queryKeys entry under
    packages/web-ui/src/lib/query/), and compute the TaskCounts object
    (ready, in_progress, needs_work, pending_review, blocked, completed,
    cancelled) with these EXPLICIT semantics: every card except ready
    maps 1:1 from summary.counts — in particular blocked stays
    summary.counts.blocked (status 'blocked' only), preserving the
    current display semantics; do NOT fold
    summary.blocked_by_dependencies into the blocked card. The ready
    card deliberately adopts summary.ready — the server's canonical
    dependency-aware definition (pending OR needs_work tasks with no
    blockers and all dependencies met,
    packages/daemon/src/routes/aggregation.ts ~lines 100-112). This is a
    deliberate, documented change from the current client computation
    (+page.svelte ~lines 99-152 counts only pending tasks with met
    dependencies), so the displayed ready number may rise where
    needs_work tasks are dispatch-ready; record the semantic change in
    the task notes and commit message. The static-mode derivation must
    implement these same semantics so both modes agree. (3) Remove the
    now-dead full-list aggregation code and
    the TODO comment. If other parts of +page.svelte genuinely need task
    items (check before deleting — e.g. active-work cards), keep those
    usages on their existing queries and only move the counts; do not
    expand scope to refactor unrelated dashboard data fetching.

    How: Follow the TanStack Query patterns already used in +page.svelte
    (createQuery with queryKeys, enabled: isProjectInitialized()). See
    the ui-data-layer skill for cache invalidation conventions — the
    summary query should invalidate on the same WebSocket task events as
    the task list queries so counts stay live.

    Testing: Web UI unit tests for fetchTaskStatusSummary (live path hits
    the aggregation URL; static path derives identical shape from a
    snapshot fixture). Component/page test or E2E check that the
    dashboard renders counts without issuing a full /api/tasks list
    request in live mode (assert on fetch calls). Annotate
    AC: @ui-dashboard-overview ac-counts-from-summary. Run the Playwright
    E2E dashboard specs (npm run test:e2e) to confirm no regression.

    Covers: @ui-dashboard-overview ac-counts-from-summary.
```

## Implementation Notes

- **Related in-progress work (do not modify):** P1 task
  `@investigate-daemon-dispatch-oom` (01KRMEKN) is investigating daemon OOM
  under dispatch workload. `task-daemon-log-capture` and
  `task-daemon-fatal-failure-observability` directly improve that
  investigation (an OOM kill or fatal rejection will finally leave a durable
  trace), but this plan does not change that task's scope.
- **Completed OOM plan:** "Daemon Dispatch OOM Hardening Spec Alignment"
  (01KRYJ0Z) covered event-lineage bounding, reconciliation overlap,
  recursive command proxying, and cleanup diagnostics gating — disjoint from
  this plan; no spec touched twice.
- **Network exposure finding corrected:** the audit claim that a
  misconfigured external connect host "silently makes the daemon externally
  reachable" is not accurate — reachability is controlled by the bind host,
  which already requires explicit configuration
  (@trait-localhost-security ac-external-host-explicit) and already warns
  (@daemon-network-endpoint-contract ac-external-binding-warning, implemented
  in serve.ts start and status). The real residual gap is the silent
  Host-allowlist extension and client misrouting for non-loopback
  connect_host, handled as a single delta AC + warning task.
- **`serve logs` was already spec'd:** @cli-serve-commands ac-8/ac-9 promised
  the command against a log file that never existed (the original "Implement
  daemon logging" task 01KFMMMN was cancelled). This plan implements those
  ACs rather than re-specifying them.
- **Spec-purity placement:** concrete file names (daemon.log,
  daemon.last-exit.json), env/config key names, and line numbers live only in
  task descriptions; specs state the behavior with deterministic defaults
  (5 MiB rotation cap, one retained generation, 120-second command timeout).
- **Command-timeout design (fix cycle 1):** the chosen semantics are a
  client-observed timeout without unwedging — the dispatch slot stays held
  by the abandoned execution, subsequent serialized callers receive bounded
  structured timeout errors (and queued-but-never-started commands are
  discarded), paired with a degraded-dispatch report on the daemon health
  surface so operators know to restart. Releasing the dispatch slot on
  timeout was rejected: console/stdout/exit interception and the working
  directory are AsyncLocalStorage-scoped (there are no globals to restore),
  but an abandoned MUTATING command still holds the cross-process file
  lock, and same-process lock acquisition never reclaims a lock from the
  daemon's own live PID — a released-slot design would run new commands
  concurrently with the abandoned one and fail follow-up mutations on lock
  timeouts, violating both the serialization contract and any
  "subsequent commands execute normally" promise. Cross-process lock
  contenders self-heal via the existing 30s duration-ceiling reclaim.
  AbortSignal-based cancellation is deferred: command implementations do
  not accept signals today; it can layer onto this contract later.
- **Rotation bound (fix cycle 1):** rotate-before-append chosen so the
  retained-size bound is deterministic (2x the limit plus at most one
  captured line) and the AC matches the prescribed mechanism exactly.
- **Log tee ordering (fix cycle 1):** the command-route interceptors are
  installed once at module load and routed per call via AsyncLocalStorage;
  the tee must be installed before that module is evaluated (first
  side-effect import in the daemon entry) or be capture-aware, otherwise
  command output double-logs into the daemon log.
- **Dashboard ready/blocked semantics (fix cycle 1):** the blocked card
  keeps status-only counts (no silent change); the ready card deliberately
  adopts the server's dependency-aware ready definition (which also counts
  needs_work tasks with met dependencies) — a documented display change,
  not an accident.
- **Ordering:** task-update-daemon-reliability-specs first (delta ACs gate the
  three tasks that cover them). task-daemon-log-capture before the
  fatal-failure and serve-logs tasks. The two web-ui tasks and the
  connect-host warning are independent of the daemon logging chain.
