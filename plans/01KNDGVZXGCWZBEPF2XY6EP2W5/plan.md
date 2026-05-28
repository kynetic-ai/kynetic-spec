# Configurable Daemon Runtime

## Specs

```yaml
- title: Configurable Daemon Runtime
  slug: daemon-runtime-adapter
  type: feature
  description: |
    The daemon supports running on multiple JavaScript runtimes. The
    runtime is selected at startup via configuration, with bun as the
    default for backward compatibility. When running on an alternative
    runtime, the server uses a runtime adapter for HTTP and WebSocket
    handling. Features that depend on runtime-specific APIs degrade
    gracefully when unavailable rather than crashing.
  acceptance_criteria:
    - id: ac-runtime-selection
      given: |
        The user has configured a daemon runtime preference
      when: |
        The daemon starts
      then: |
        The daemon spawns using the configured runtime
    - id: ac-default-bun
      given: |
        No runtime preference is configured
      when: |
        The daemon starts
      then: |
        By default the daemon spawns using bun
    - id: ac-http-parity
      given: |
        The daemon is running on any configured runtime
      when: |
        HTTP API requests arrive, including SPA fallback routes
      then: |
        All routes serve correctly regardless of runtime
    - id: ac-websocket-parity
      given: |
        The daemon is running on any configured runtime
      when: |
        A WebSocket client connects
      then: |
        The client receives connection events, topic subscriptions,
        and broadcast messages regardless of runtime
    - id: ac-connection-state
      given: |
        The daemon is running on any supported runtime
      when: |
        A WebSocket client connects and interacts with the server
      then: |
        Per-connection state (session ID, subscribed topics, sequence
        number, heartbeat timestamps, project path) is tracked and
        accessible throughout the connection lifecycle
    - id: ac-heartbeat-degradation
      given: |
        The daemon is running on a runtime where frame-level WebSocket
        ping is unavailable
      when: |
        A WebSocket connection is idle
      then: |
        The connection remains open without heartbeat enforcement and
        a warning is logged at startup indicating degraded heartbeat
    - id: ac-backpressure-degradation
      given: |
        The daemon is running on a runtime where buffered amount
        queries are unavailable
      when: |
        The server broadcasts to WebSocket clients
      then: |
        Broadcasts proceed without backpressure checks rather than
        failing
    - id: ac-runtime-health
      given: |
        The daemon is running on any supported runtime
      when: |
        The health endpoint is called
      then: |
        The response includes which runtime the daemon is using
    - id: ac-graceful-shutdown
      given: |
        The daemon is running on any supported runtime
      when: |
        A shutdown signal is received or stop is requested
      then: |
        The daemon shuts down cleanly, closing connections and
        removing the PID file
    - id: ac-auto-start-runtime
      given: |
        Auto-start is enabled and a runtime preference is configured
      when: |
        The daemon auto-starts in the background
      then: |
        The auto-started daemon uses the configured runtime
    - id: ac-runtime-missing
      given: |
        The configured runtime is not installed on the system
      when: |
        The daemon attempts to start
      then: |
        A clear error message names the missing runtime and provides
        installation guidance
```

## Tasks

derive_from_specs: false

```yaml
# ─── Phase 1: Spec Updates ───

- title: Scope daemon-server ac-16 to bun runtime
  slug: task-scope-ac16-bun-only
  priority: 1
  tags: [spec-update, daemon]
  spec_ref: "@daemon-server"
  description: |
    Update the given clause of ac-16 on @daemon-server to specify
    that the standalone executable build applies only when using bun
    as the daemon runtime.

    Why: ac-16 currently says "Given: daemon code is ready / When:
    bun build --compile runs / Then: produces standalone executable
    without requiring Bun installation." With configurable runtime
    support, this AC only applies to bun mode. Node mode does not
    have an equivalent single-binary compilation step. Without
    scoping, the AC would appear violated whenever the daemon runs
    on node.

    What: Update ac-16's given clause to: "The daemon is configured
    to use bun runtime and the daemon code is ready"

    How: Run:
      kspec item ac set @daemon-server ac-16 \
        --given "The daemon is configured to use bun runtime and the daemon code is ready"

    Verify with: kspec item get @daemon-server

    Covers: @daemon-server ac-16 (update).

# ─── Phase 2: Daemon Build Pipeline ───

- title: Compile daemon TypeScript to JavaScript for dual-runtime support
  slug: task-daemon-compile-js
  priority: 1
  tags: [daemon, build, node]
  spec_ref: "@daemon-runtime-adapter"
  depends_on:
    - "@task-scope-ac16-bun-only"
  description: |
    Change the daemon build pipeline to compile TypeScript to
    JavaScript so both bun and node can execute the output without
    a TypeScript loader.

    Why: The current build:daemon script (package.json line 42)
    copies raw .ts files to dist/daemon/ and relies on bun's native
    TypeScript execution. Node cannot run .ts files without a loader
    like tsx. Compiling to JS eliminates this dependency and makes
    both runtimes execute the same output. Bun can also run compiled
    JS, so this is a unifying change, not a regression.

    The current daemon tsconfig (packages/daemon/tsconfig.json) has
    two bun-specific settings that need updating:
    - "types": ["bun-types"] — makes bun globals (Bun.file,
      ServerWebSocket) available globally, providing false type
      safety when building for node
    - "moduleResolution": "bundler" — bun's resolution strategy

    What:

    1. Update packages/daemon/tsconfig.json:
       - Remove "bun-types" from the types array. Instead, use
         explicit type imports where bun types are needed (the
         existing `import type { ServerWebSocket } from "bun"`
         statements already do this).
       - Add a conditional type reference or runtime type shim
         for Bun.file() (which will be replaced in a later task).

    2. Add a build step that compiles the daemon TypeScript to
       JavaScript. Options include:
       - tsc with the daemon's tsconfig (produces .js + .d.ts)
       - A bundler like vite/esbuild (produces a single or few
         .js files, resolves imports)

       A bundler is preferred because it resolves the .js extension
       imports (e.g. import from "./server.js" resolving to
       server.ts) and produces self-contained output. The existing
       entity-cache.ts in src/daemon/ that gets copied into
       dist/daemon/ also needs to be included in the build input.

    3. Update the build:daemon script in package.json to invoke
       the compilation instead of copying raw .ts files.

    4. Update the daemon entry point reference in serve.ts (line 278)
       from dist/daemon/index.ts to dist/daemon/index.js.

    5. Update maybeAutoStartDaemon in src/cli/index.ts — it already
       references dist/daemon/index.js (line 169), so it should
       continue working. Verify this.

    How: Choose a build tool (vite or esbuild recommended — both
    are already available in the project). Configure it to compile
    packages/daemon/src/ + src/daemon/entity-cache.ts into
    dist/daemon/ as JavaScript. Test that the compiled output runs
    under both `bun dist/daemon/index.js` and `node dist/daemon/index.js`.
    Update the tsconfig types to remove global bun-types. Add tests
    that verify the build produces valid JS output.

    Covers: @daemon-runtime-adapter ac-runtime-selection (enables
    both runtimes to execute the daemon).

# ─── Phase 3: Runtime Config ───

- title: Add daemon.runtime to configuration schema
  slug: task-daemon-runtime-config
  priority: 1
  tags: [daemon, config, schema]
  spec_ref: "@daemon-runtime-adapter"
  depends_on:
    - "@task-daemon-compile-js"
  description: |
    Add a runtime field to the daemon configuration schema so users
    can choose which JavaScript runtime the daemon uses.

    Why: The daemon currently hardcodes bun as its runtime. To make
    the runtime configurable, the config system needs a field that
    stores the user's preference. This field is read by the serve
    command and auto-start logic to determine which runtime binary
    to spawn.

    What: Add a "runtime" field to DaemonConfigSchema in
    src/schema/config.ts (or wherever DaemonConfigSchema is defined
    — check src/parser/config.ts). The field should:

    - Accept values "bun" or "node"
    - Default to "bun"
    - Be optional (omission means "bun")

    The config file location is kspec.config.yaml at the project
    root. The existing daemon config fields are port (number),
    host (string), and auto_start (boolean). Add runtime alongside
    these.

    How: Edit the Zod schema for daemon config to add:
      runtime: z.enum(["bun", "node"]).default("bun")

    Update the default config generation if there is one. Add a
    test that verifies the default is "bun" and that "node" is
    accepted. Verify existing configs without the runtime field
    continue to work (default kicks in).

    Covers: @daemon-runtime-adapter ac-runtime-selection,
    ac-default-bun.

# ─── Phase 4: WebSocket Connection State Abstraction ───

- title: Abstract WebSocket per-connection state from bun's ws.data
  slug: task-ws-connection-state-abstraction
  priority: 1
  tags: [daemon, websocket, refactor]
  spec_ref: "@daemon-runtime-adapter"
  depends_on:
    - "@task-daemon-compile-js"
  description: |
    Replace direct usage of bun's ws.data property for per-connection
    state with a runtime-agnostic abstraction.

    Why: The daemon stores all per-connection state on ws.data, a
    property specific to bun's ServerWebSocket<T>. The data includes
    sessionId, topics (Set<string>), seq (sequence number), lastPing,
    lastPong, and projectPath. Under the Elysia node adapter, the
    WebSocket object is a crossws Peer which may not support mutable
    .data in the same way. The ws.data property is accessed in ~20
    call sites across 5 files:

    - server.ts open handler: assigns ws.data with initial state
    - heartbeat.ts: reads/writes ws.data.lastPing, ws.data.lastPong,
      ws.data.sessionId
    - handler.ts: reads ws.data.sessionId, ws.data.projectPath
    - pubsub.ts: reads ws.data.sessionId, ws.data.topics,
      ws.data.seq; writes ws.data.seq
    - lifecycle.ts: reads ws.data.sessionId

    What: Introduce a ConnectionStateManager that stores per-connection
    state in a WeakMap<WebSocket, ConnectionData> instead of on the
    WebSocket object directly. This works on any runtime because it
    uses standard JavaScript — the WebSocket object is the key, and
    the connection data is the value.

    1. Create a ConnectionStateManager class or module in
       packages/daemon/src/websocket/ with methods:
       - init(ws, data: ConnectionData): void
       - get(ws): ConnectionData | undefined
       - remove(ws): void

    2. Update the open handler in server.ts to call
       connectionState.init(ws, { sessionId, topics, seq, ... })
       instead of assigning ws.data.

    3. Update all ws.data read sites to use
       connectionState.get(ws)?.sessionId, etc.

    4. Update the close handler to call connectionState.remove(ws)
       for cleanup (though WeakMap handles GC automatically, explicit
       removal is cleaner for the lifecycle).

    5. Update the ConnectionData type definition in
       packages/daemon/src/websocket/types.ts. The type itself
       doesn't change — only where it's stored.

    The Elysia framework may still set ws.data internally for its
    own purposes. The ConnectionStateManager should not conflict
    with this — it uses a separate WeakMap, not the ws.data slot.

    How: Create the ConnectionStateManager. Update all files that
    access ws.data to use the manager instead. The WebSocket type
    annotations can use a generic WebSocket type or the Elysia
    framework's type rather than bun's ServerWebSocket<T>. Run
    existing WebSocket tests to verify behavior is preserved. Add
    a test that verifies connection state is accessible after init
    and cleaned up after remove.

    Covers: @daemon-runtime-adapter ac-connection-state,
    ac-websocket-parity.

# ─── Phase 5: Server Adapter ───

- title: Install and wire Elysia node adapter in daemon server
  slug: task-elysia-node-adapter
  priority: 1
  tags: [daemon, server, node]
  spec_ref: "@daemon-runtime-adapter"
  depends_on:
    - "@task-daemon-runtime-config"
    - "@task-ws-connection-state-abstraction"
  description: |
    Install @elysiajs/node and conditionally apply the node adapter
    when the daemon is configured to run on node.

    Why: Elysia is the HTTP/WebSocket framework used by the daemon.
    By default it uses bun's native HTTP server. The @elysiajs/node
    package provides an adapter that lets Elysia run on node using
    standard Node.js HTTP and the crossws WebSocket library. The
    daemon needs to apply this adapter when running under node.

    What: Four changes:

    1. Add @elysiajs/node as a dependency in packages/daemon/
       package.json. Verify version compatibility with the current
       elysia version (^1.1.31). Check the @elysiajs/node npm page
       or changelog — the node adapter version should be compatible
       with the installed Elysia version. If not, update both
       together. Document the verified compatible version pairing
       in a task note.

    2. In packages/daemon/src/server.ts, accept a runtime parameter
       (passed from the entry point). When runtime is "node",
       import and apply the adapter:

         import { node } from "@elysiajs/node";
         const app = new Elysia(
           runtime === "node" ? { adapter: node() } : {}
         );

    3. Replace the Bun.file() usage at line 571 of server.ts with
       a runtime-agnostic alternative. Bun.file() returns a Response
       from a file path. The replacement should work on both runtimes:

         import { readFileSync } from "fs";
         // Read once at startup, serve from memory
         const indexHtml = readFileSync(indexHtmlPath);
         app.get(route, () => new Response(
           indexHtml,
           { headers: { "Content-Type": "text/html" } }
         ));

       Verify there are no other Bun.file() calls in the daemon
       codebase (grep for "Bun\." across packages/daemon/src/).

    4. Handle the shutdown path. The current shutdown at line 728
       calls app.server?.stop(). Under the node adapter, the server
       object is a Node http.Server which uses .close() not .stop().
       Use a runtime-aware shutdown:

         if (app.server) {
           if (typeof app.server.stop === "function") {
             app.server.stop();
           } else if (typeof app.server.close === "function") {
             app.server.close();
           }
         }

    How: Install the dependency, make the server.ts changes above,
    and verify the daemon starts and serves HTTP routes under both
    runtimes. The runtime value should be passed from the entry
    point (index.ts) via CLI argument or environment variable.
    Write a test that verifies the adapter is applied when runtime
    is "node" and not applied when runtime is "bun".

    Covers: @daemon-runtime-adapter ac-http-parity, ac-graceful-shutdown.

# ─── Phase 6: Spawn and Entry Point ───

- title: Update daemon spawn to use configured runtime
  slug: task-daemon-spawn-runtime
  priority: 1
  tags: [daemon, cli, node]
  spec_ref: "@daemon-runtime-adapter"
  depends_on:
    - "@task-elysia-node-adapter"
  description: |
    Update the serve command and auto-start to spawn the daemon using
    the configured runtime instead of hardcoding bun.

    Why: The serve command (src/cli/commands/serve.ts) hardcodes
    "bun" as the spawn runtime at lines 322 and 372. The auto-start
    function (src/cli/index.ts line 177) uses process.execPath which
    inherits whatever runtime is running the CLI. Neither reads the
    daemon.runtime config. Both need to read the config and spawn
    accordingly.

    What: Five changes:

    1. In src/cli/commands/serve.ts, read the daemon.runtime config
       value (from the project's kspec.config.yaml). Replace the
       hardcoded "bun" at lines 322 and 372 with the config value.

    2. When runtime is "node", spawn with:
         spawn("node", [daemonBinary, ...args])
       The daemon binary is now compiled JavaScript
       (dist/daemon/index.js) thanks to the build pipeline task,
       so node can execute it directly without tsx.

       When runtime is "bun", spawn with:
         spawn("bun", [daemonBinary, ...args])
       Bun can also run the compiled .js output.

    3. Update buildDaemonChildEnv() (line 109) to set NODE_ENV
       instead of BUN_ENV when runtime is "node". When runtime is
       "bun", continue setting BUN_ENV as before.

    4. Update the bun availability check (lines 293-312) to only
       run when runtime is "bun". When runtime is "node", check
       that node is available instead. Update the error messages
       to reference the correct runtime and remove the outdated
       "cannot run on Node.js alone" message.

    5. Update maybeAutoStartDaemon in src/cli/index.ts to read the
       daemon.runtime config and use the configured runtime instead
       of process.execPath. Auto-start already references
       dist/daemon/index.js (line 169), which aligns with the
       compiled output from the build pipeline task.

    How: Edit serve.ts and index.ts as described. The config read
    should use the same initContext/loadConfig path that resolves
    daemon.port. Test that `kspec serve start` with runtime: node
    spawns node instead of bun, and that `kspec serve start` with
    no runtime config spawns bun. Test that auto-start reads config.

    Covers: @daemon-runtime-adapter ac-runtime-selection,
    ac-default-bun, ac-auto-start-runtime, ac-runtime-missing.

# ─── Phase 7: WebSocket Degradation ───

- title: Handle WebSocket API gaps for node runtime
  slug: task-ws-degradation-node
  priority: 1
  tags: [daemon, websocket, node]
  spec_ref: "@daemon-runtime-adapter"
  depends_on:
    - "@task-ws-connection-state-abstraction"
    - "@task-elysia-node-adapter"
  description: |
    Ensure the daemon's WebSocket features degrade gracefully when
    running on node, where certain bun-native WebSocket APIs are
    unavailable.

    Why: The Elysia node adapter uses the crossws library for
    WebSocket support. crossws wraps the ws npm package but does not
    expose all of bun's native ServerWebSocket APIs. Specifically:

    - ws.ping() is not available (crossws Peer has no ping method)
    - The pong event handler does not fire (crossws only maps open,
      message, close, error — not pong)
    - ws.getBufferedAmount() is not available (crossws Peer has no
      equivalent)
    - ws.subscribe() / ws.unsubscribe() are no-ops (track topics
      in a Set but don't create transport-level pub/sub)

    The subscribe/unsubscribe and getBufferedAmount calls are already
    guarded with optional chaining (?.) and fallback values, so they
    won't crash. But ws.ping() in heartbeat.ts:51 is called directly
    and will throw if the method doesn't exist.

    What: Four changes:

    1. In packages/daemon/src/websocket/heartbeat.ts, guard the
       ws.ping() call. Check if the method exists before calling:

         if (typeof ws.ping === "function") {
           ws.ping();
         }

       When ping is unavailable, skip heartbeat enforcement for
       that connection entirely. Do not close connections for
       missing pong when ping was never sent — the pong timeout
       check must be conditional on whether a ping was actually
       sent.

    2. Handle the missing pong handler. The pong callback at
       server.ts:524 calls heartbeatManager.recordPong(ws). Under
       crossws, this callback never fires because crossws doesn't
       map pong events. This is safe — recordPong just updates a
       timestamp, and if ping was never sent (step 1), the timeout
       check won't fire either. Verify this logic holds by tracing
       the heartbeat flow: if lastPing is never set (ping skipped),
       the timeout comparison should not trigger connection closure.

    3. Log a one-time warning at daemon startup when running on
       node indicating WebSocket heartbeat is degraded:
       "[daemon] Running on node: WebSocket heartbeat ping/pong
       is unavailable. Dead connection detection is disabled."

    4. Verify existing guards are sufficient:
       - pubsub.ts:40 ws.subscribe?.() — already safe
       - pubsub.ts:49 ws.unsubscribe?.() — already safe
       - pubsub.ts:166 ws.getBufferedAmount?.() ?? 0 — already safe
       - The daemon's PubSubManager.broadcast() iterates connections
         and calls ws.send() directly — it does NOT use bun's
         ws.publish() for topic-based broadcast, so this path
         works on both runtimes.

    How: Edit heartbeat.ts to add the typeof guard on ws.ping().
    Verify the timeout logic is safe when ping is skipped (trace
    the lastPing/lastPong flow). Add the startup warning in
    server.ts (after server starts, check runtime and log). Write
    tests that verify: ping is skipped when ws.ping is undefined,
    connections are not reaped when ping was never sent, startup
    warning is logged on node runtime.

    Covers: @daemon-runtime-adapter ac-heartbeat-degradation,
    ac-backpressure-degradation, ac-websocket-parity.

# ─── Phase 8: Health Endpoint ───

- title: Add runtime field to health endpoint response
  slug: task-health-runtime-field
  priority: 2
  tags: [daemon, api]
  spec_ref: "@daemon-runtime-adapter"
  depends_on:
    - "@task-daemon-spawn-runtime"
  description: |
    Add a runtime field to the GET /api/health response so operators
    can verify which runtime the daemon is using.

    Why: When the daemon supports multiple runtimes, operators and
    tooling need to know which runtime is active. The health endpoint
    already returns status, uptime, connections, and version. Adding
    the runtime field makes it easy to verify the configuration took
    effect, and aids debugging when behavior differs between runtimes.

    What: Add a "runtime" field to the health endpoint response.
    The value should be "bun" or "node" based on which runtime the
    daemon was started with. The runtime value is available from the
    same source that the server adapter selection uses (CLI argument
    or environment variable passed at spawn time).

    How: In the health route handler (packages/daemon/src/routes/
    or server.ts — find the GET /api/health handler), add the
    runtime field to the response object. The runtime value should
    be determined once at startup and stored in a module-level
    variable or passed through the server context. Write a test
    that verifies the health response includes the runtime field.

    Covers: @daemon-runtime-adapter ac-runtime-health.

# ─── Phase 9: E2E Test Awareness ───

- title: Update E2E test fixture to support configurable runtime
  slug: task-e2e-runtime-aware
  priority: 3
  tags: [e2e, testing, daemon]
  spec_ref: "@daemon-runtime-adapter"
  depends_on:
    - "@task-daemon-spawn-runtime"
    - "@task-ws-degradation-node"
  description: |
    Update the E2E test fixture to support running tests against
    either bun or node daemon runtime.

    Why: The E2E test fixture (tests/e2e/fixtures/test-base.ts)
    hardcodes "bun" as the daemon runtime at line 208 and checks
    bun availability at lines 67-86. To verify that the daemon
    works correctly on node, the test fixture needs to support
    spawning the daemon with either runtime. This also serves as
    integration-level verification that all the runtime adapter
    changes work end-to-end.

    What: Update tests/e2e/fixtures/test-base.ts:

    1. Accept a runtime parameter (default "bun") that controls
       which runtime is used to spawn the daemon.

    2. When runtime is "node", spawn with node and the compiled
       .js entry point. Update the availability check to verify
       node is installed.

    3. Add a test configuration option (environment variable or
       Playwright config) to select the runtime for E2E runs.

    This task does NOT require running the full E2E suite on node
    as part of CI. It enables manual verification and makes future
    CI matrix testing possible. The primary CI target remains bun.

    How: Edit tests/e2e/fixtures/test-base.ts to parameterize the
    runtime. Add a KSPEC_TEST_RUNTIME environment variable that
    defaults to "bun". When set to "node", use node with the
    compiled JS for spawning. Verify at least one E2E test passes
    with KSPEC_TEST_RUNTIME=node manually.

    Covers: @daemon-runtime-adapter ac-http-parity, ac-websocket-parity
    (integration verification).
```

## Implementation Notes

### Motivation

The daemon freezes under sustained load due to a bun runtime deadlock
(oven-sh/bun#26762) — a lock ordering violation between
GeneralPurposeAllocator and the thread pool drain mechanism. All threads
end up in futex_wait with zero CPU and the event loop stops polling
epoll entirely. The fix PRs are open but unmerged. The granular cache
invalidation plan (@plan-granular-cache-invalidation) reduces the
triggering I/O burst but will take time to implement and test. Running
on node eliminates the bun-specific deadlock entirely as an interim
measure while both long-term fixes progress.

### Why configurable, not a hard switch

Bun provides meaningful benefits: native TypeScript execution, faster
HTTP serving, built-in WebSocket pub/sub, and standalone binary
compilation (ac-16). The node runtime is a workaround for a specific
bug, not a permanent migration. Making it configurable lets users
switch between runtimes without code changes, and lets the project
switch back to bun-only when the deadlock is fixed upstream.

### Compiled JS eliminates the tsx dependency

Rather than running TypeScript source on node via tsx (a devDependency
with spawn latency overhead), the daemon is compiled to JavaScript.
Both bun and node execute the compiled .js output. This:
- Eliminates the need for tsx as a runtime dependency
- Unifies the entry point (dist/daemon/index.js for both runtimes)
- Resolves the auto-start divergence (maybeAutoStartDaemon already
  uses dist/daemon/index.js)
- Avoids moduleResolution differences between bun's "bundler" mode
  and node's module resolver (compiled output has resolved imports)

Build tool options: vite or esbuild (both available in the project).
The build must include packages/daemon/src/ and src/daemon/entity-cache.ts.

### Elysia node adapter

Elysia provides @elysiajs/node, a runtime adapter that uses Node's
native HTTP server and the crossws library for WebSocket support. The
adapter is applied at Elysia construction time:

  import { node } from "@elysiajs/node";
  const app = new Elysia({ adapter: node() });

All Elysia routes, plugins, and middleware work identically. The gaps
are in WebSocket-specific APIs that bun's ServerWebSocket provides
but crossws does not: ping(), pong handler, getBufferedAmount(), and
transport-level subscribe/unsubscribe.

Version compatibility: @elysiajs/node versioning tracks the main Elysia
version. The task to install it must verify compatibility with the
current elysia ^1.1.31 and document the verified pairing.

### ws.data and per-connection state

The daemon stores all per-connection state (sessionId, topics, seq,
lastPing, lastPong, projectPath) on bun's ws.data property. This is
the largest bun-specific API surface in the codebase (~20 call sites
across 5 files). Under crossws, ws.data may not be available or may
behave differently. The plan abstracts this into a WeakMap-based
ConnectionStateManager that works on any runtime. The WeakMap uses the
WebSocket object as the key, so state is automatically GC'd when the
connection closes.

### What's already runtime-agnostic

Most of the daemon codebase has no bun dependencies:
- PID file management (packages/daemon/src/pid.ts)
- Watcher health monitor
- Entity cache (src/daemon/entity-cache.ts)
- Session watcher (chokidar-based)
- All route handlers
- Dispatch engine
- Signal handling (SIGTERM/SIGINT)

### Bun-specific surface area (complete list)

1. Bun.file() — server.ts:571 (SPA fallback routes)
2. ServerWebSocket type — 5 files (type-only imports, erased at compile)
3. ws.data — ~20 call sites across 5 websocket files (connection state)
4. ws.ping() — heartbeat.ts:51 (heartbeat sending)
5. pong handler — server.ts:524 (heartbeat tracking, never fires on node)
6. ws.getBufferedAmount() — pubsub.ts:166 (backpressure, already guarded)
7. ws.subscribe/unsubscribe — pubsub.ts:40,49 (already guarded)
8. app.server?.stop() — server.ts:728 (shutdown)
9. "bun" spawn — serve.ts:322,372 (daemon startup)
10. BUN_ENV env var — serve.ts:111
11. #!/usr/bin/env bun shebang — index.ts:1 (cosmetic)
12. tsconfig "types": ["bun-types"] — packages/daemon/tsconfig.json
13. tsconfig "moduleResolution": "bundler" — packages/daemon/tsconfig.json

### Phasing rationale

Phase 1 (spec updates) establishes contracts before code changes.
Phase 2 (build pipeline) is the foundation — compiled JS enables
everything else. Phase 3 (config) and Phase 4 (ws.data abstraction)
are independent and can be parallelized. Phase 5 (server adapter)
depends on both. Phase 6 (spawn) depends on the adapter. Phase 7
(WS degradation) depends on the ws.data abstraction and adapter.
Phase 8 (health) and Phase 9 (E2E) are lower priority follow-ups.
