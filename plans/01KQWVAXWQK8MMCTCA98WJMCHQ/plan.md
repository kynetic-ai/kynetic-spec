# Daemon Network Endpoint Contract

## Specs

```yaml
- title: Daemon Endpoint Consumer
  slug: trait-daemon-endpoint-consumer
  type: trait
  description: |
    Cross-cutting behavior for kspec surfaces that communicate with a running
    daemon. A daemon consumer uses the daemon endpoint that kspec reports for
    client communication instead of independently choosing a different local or
    wildcard address.
  acceptance_criteria:
    - id: ac-uses-reported-endpoint
      given: |
        A running daemon has reported the endpoint clients should use
      when: |
        A daemon consumer communicates with that daemon
      then: |
        The consumer addresses the reported endpoint rather than independently
        choosing a different daemon destination
    - id: ac-wildcard-not-destination
      given: |
        The daemon is explicitly configured to listen on all interfaces
      when: |
        A daemon consumer communicates with that daemon
      then: |
        The consumer addresses a non-wildcard destination reported for client
        communication

- title: Daemon Network Endpoint Contract
  slug: daemon-network-endpoint-contract
  type: requirement
  parent: "@daemon-server"
  description: |
    The daemon has one canonical network endpoint contract shared by
    daemon startup, daemon lifecycle metadata, CLI clients, web UI
    development clients, and tests. The default endpoint is a local
    loopback endpoint that does not depend on operating-system hostname
    resolution. Configured host and port values are resolved once and
    every daemon client uses the advertised connection endpoint instead
    of constructing daemon URLs independently.
  acceptance_criteria:
    - id: ac-default-loopback-v4
      given: |
        No daemon host is configured by CLI flag, environment variable,
        or kspec.config.yaml
      when: |
        The daemon starts
      then: |
        The daemon binds and advertises 127.0.0.1 without resolving
        the name localhost
    - id: ac-default-ipv6-fallback
      given: |
        No daemon host is configured and binding 127.0.0.1 fails because
        IPv4 loopback is unavailable
      when: |
        The daemon starts
      then: |
        The daemon retries on ::1 and advertises URLs using bracketed
        IPv6 host syntax
    - id: ac-configured-bind-host
      given: |
        A daemon host is configured by CLI flag, environment variable,
        or kspec.config.yaml
      when: |
        The daemon starts
      then: |
        The daemon binds to the configured host value
    - id: ac-wildcard-connect-host
      given: |
        The daemon bind host is 0.0.0.0 or ::
      when: |
        The daemon advertises its connection endpoint for local CLI use
      then: |
        The advertised connect host is a loopback address or explicitly
        configured connect host, not the wildcard bind address
    - id: ac-connection-metadata
      given: |
        The daemon starts successfully
      when: |
        Daemon lifecycle state is written
      then: |
        The global daemon metadata records pid, port, bind_host,
        connect_host, api_url, ws_url, and runtime
    - id: ac-clients-use-metadata
      given: |
        A daemon client needs to call the daemon from CLI code, daemon
        status code, scheduled-command code, agent-command code, event
        code, task-event code, or web UI development code
      when: |
        Daemon connection metadata advertises an API URL or WebSocket URL
      then: |
        The client calls the advertised URL instead of a separately chosen
        daemon host or port
    - id: ac-legacy-port-fallback
      given: |
        New daemon connection metadata is absent but the legacy global
        daemon.port file exists
      when: |
        A CLI client checks daemon availability
      then: |
        The client attempts 127.0.0.1 with the legacy port value before
        treating the daemon as unavailable
    - id: ac-external-binding-warning
      given: |
        The effective daemon bind host is a non-loopback address or a
        wildcard address
      when: |
        The daemon starts or a lifecycle command reports the endpoint
      then: |
        The output includes a visible warning that the daemon exposes
        unauthenticated project data and mutation APIs on the configured
        network interface
```

## Tasks

derive_from_specs: false

```yaml
- title: Update localhost security trait for configurable daemon endpoints
  slug: task-update-localhost-security-trait
  priority: 1
  tags: [spec-update, daemon, security]
  spec_ref: "@trait-localhost-security"
  description: |
    Update the existing @trait-localhost-security trait so it no longer
    contradicts configurable daemon interface binding.

    Why: The current trait says services accept only 127.0.0.1 and ::1,
    while @config-daemon already says daemon.host can be set to 0.0.0.0.
    Implementing configurable daemon interfaces without reconciling this
    trait would leave specs that are impossible to satisfy together.

    What: Change @trait-localhost-security exactly as follows.

    Update the title to:
      Loopback Default Security

    Replace the description with:
      Security pattern for daemon services that are loopback-only by
      default. Binding to wildcard or other non-loopback interfaces is never
      the default; it is allowed only by explicit configuration and is treated
      as unauthenticated network exposure. Specs using this trait must enforce
      loopback-only behavior in default mode and surface explicit warnings when
      external binding is enabled.

    Replace the existing acceptance criteria with these four ACs:

      ac-loopback-default
        given: No non-loopback daemon host is configured
        when: The server starts
        then: The server binds only to loopback interfaces

      ac-loopback-rejects-nonlocal
        given: The server is running in loopback-only mode
        when: An HTTP request is received from a non-loopback remote
              address or with a non-local Host or Origin
        then: The request is rejected with 403 Forbidden

      ac-external-host-explicit
        given: daemon.host is explicitly configured to a non-loopback or
               wildcard address
        when: The server starts
        then: The server binds to the configured address

      ac-external-warning
        given: The effective daemon host is non-loopback or wildcard
        when: The daemon starts or a lifecycle command reports the daemon
              endpoint
        then: Output includes a visible warning that the daemon has no
              authentication and exposes project data and mutation APIs on
              the configured network interface

    How: Use kspec item set to update the trait title and description. Use
    kspec item ac set/add/remove commands to leave exactly the four ACs above
    on the trait. Keep the trait slug unchanged. Verify with kspec item get
    @trait-localhost-security.

    Testing: Run kspec validate --warnings-ok after the spec mutation.

    Covers: @trait-localhost-security ac-loopback-default,
    ac-loopback-rejects-nonlocal, ac-external-host-explicit,
    ac-external-warning.

- title: Update configurable daemon settings spec for endpoint resolution
  slug: task-update-config-daemon-endpoint-ac
  priority: 1
  tags: [spec-update, daemon, config]
  spec_ref: "@config-daemon"
  depends_on:
    - "@task-update-localhost-security-trait"
  description: |
    Update @config-daemon so it owns the daemon port, host, connect host,
    runtime, and precedence contract used by daemon startup and auto-start.

    Why: src/parser/config.ts currently parses daemon.host and
    KSPEC_DAEMON_HOST, but daemon startup ignores the host. The spec also
    omits connect-host metadata, runtime config, and port environment
    precedence even though these values affect daemon lifecycle behavior.

    What: Change @config-daemon exactly as follows.

    Replace the description with:
      Daemon port, bind host, optional connect host, runtime, and auto-start
      behavior are configurable in kspec.config.yaml. These settings are
      loaded before shadow branch detection so daemon lifecycle and
      auto-start decisions do not depend on the shadow worktree. CLI flags
      and documented environment variables take precedence over file config.

    Keep ac-1 through ac-4, ac-7, and ac-8 unless their text is otherwise
    unchanged by current code. Replace ac-5 and ac-6, and add these ACs:

      ac-host-default
        given: No daemon.host is configured
        when: kspec serve start is run
        then: The daemon uses 127.0.0.1 as the effective bind host

      ac-host-config
        given: kspec.config.yaml sets daemon.host to "0.0.0.0"
        when: kspec serve start is run
        then: The daemon uses 0.0.0.0 as the effective bind host and emits
              the external binding warning required by @trait-localhost-security

      ac-host-env-precedence
        given: KSPEC_DAEMON_HOST is set
        when: kspec.config.yaml also sets daemon.host
        then: KSPEC_DAEMON_HOST is the effective bind host

      ac-connect-host-config
        given: kspec.config.yaml sets daemon.connect_host
        when: the daemon writes connection metadata
        then: daemon.connect_host is the advertised connect host used by
              local daemon clients

      ac-port-env-precedence
        given: KSPEC_DAEMON_PORT is set to a valid port
        when: kspec.config.yaml also sets daemon.port and no --port flag is passed
        then: KSPEC_DAEMON_PORT is the effective daemon port

      ac-runtime-config
        given: kspec.config.yaml sets daemon.runtime to "node" or "bun"
        when: the daemon starts explicitly or via auto-start
        then: the daemon is spawned with the configured runtime

      ac-runtime-default
        given: no daemon.runtime is configured
        when: the daemon starts
        then: the daemon uses node as the default runtime

      ac-connection-metadata
        given: the daemon starts successfully
        when: daemon lifecycle state is written
        then: the global daemon connection metadata records pid, port,
              bind_host, connect_host, api_url, ws_url, and runtime

    How: Use kspec item set and kspec item ac set/add commands. If ac-5 and
    ac-6 keep their ids, update them to ac-host-config and
    ac-host-env-precedence only if kspec supports id changes; otherwise
    remove/re-add the ACs with the new ids. Verify with kspec item get
    @config-daemon.

    Testing: Run kspec validate --warnings-ok after the spec mutation.

    Covers: @config-daemon ac-host-default, ac-host-config,
    ac-host-env-precedence, ac-connect-host-config,
    ac-port-env-precedence, ac-runtime-config, ac-runtime-default,
    ac-connection-metadata.

- title: Update daemon server spec for default loopback and metadata
  slug: task-update-daemon-server-endpoint-ac
  priority: 1
  tags: [spec-update, daemon, server]
  spec_ref: "@daemon-server"
  depends_on:
    - "@task-update-localhost-security-trait"
    - "@task-update-config-daemon-endpoint-ac"
  description: |
    Update @daemon-server so daemon startup, security checks, global state,
    and web UI root URLs match the centralized network endpoint contract.

    Why: @daemon-server currently says the daemon binds to localhost only,
    writes a per-project .kspec/.daemon.pid file, and serves the UI at
    http://localhost:<port>/. The implementation already uses global daemon
    pid/port files, and the new endpoint contract must avoid localhost
    resolver dependence while supporting explicitly configured interfaces.

    What: Change @daemon-server exactly as follows.

    Replace the description with:
      Long-running Elysia.js server that exposes kspec state via HTTP API
      and WebSocket for real-time updates. File watcher drives both
      WebSocket broadcast and entity cache invalidation. The server binds
      to a resolved daemon endpoint that defaults to 127.0.0.1 loopback and
      can be explicitly configured for other interfaces with visible
      unauthenticated-exposure warnings. Supports foreground and background
      modes with global daemon lifecycle metadata. Includes heartbeat
      ping/pong for connection health monitoring on runtimes that support it.

    Replace these existing ACs:

      ac-1
        given: kspec is installed
        when: the user runs "kspec serve start"
        then: The Elysia HTTP server starts on the effective daemon port and
              bind host, defaulting to port 3456 on 127.0.0.1

      ac-2
        given: daemon.host is unset
        when: the server binds to the network interface
        then: the daemon accepts only loopback HTTP and WebSocket connections

      ac-3
        given: daemon.host is unset
        when: a request is received from a non-loopback remote address or
              with a non-local Host or Origin
        then: the request is rejected with 403 Forbidden for HTTP or a
              policy-violation close for WebSocket

      ac-9
        given: daemon is not running
        when: the user runs "kspec serve start --detach"
        then: the process detaches to the background, writes global daemon
              lifecycle and connection metadata under ~/.config/kspec/, and
              the CLI returns immediately

      ac-10
        given: daemon is running in background
        when: the user runs "kspec serve stop"
        then: the daemon shuts down gracefully, removes global daemon
              lifecycle and connection metadata, and closes all WebSocket
              connections

      ac-17
        given: daemon is running with web UI assets available
        when: browser opens the advertised daemon api_url
        then: the daemon serves the built web UI assets as the root route

    Add this AC:

      ac-external-bind-warning
        given: daemon.host is explicitly configured to a non-loopback or
               wildcard address
        when: the daemon starts
        then: the server binds to that address and emits the external
              binding warning required by @trait-localhost-security

    How: Use kspec item ac set/add commands and verify with kspec item get
    @daemon-server. Do not remove unrelated WebSocket, watcher, cache, or
    web UI asset-coherence ACs.

    Testing: Run kspec validate --warnings-ok after the spec mutation.

    Covers: @daemon-server ac-1, ac-2, ac-3, ac-9, ac-10, ac-17,
    ac-external-bind-warning.

- title: Update daemon proxy and direct-mode specs for endpoint metadata
  slug: task-update-cli-daemon-proxy-endpoint-ac
  priority: 1
  tags: [spec-update, daemon, cli]
  spec_ref: "@cli-daemon-proxy"
  depends_on:
    - "@task-update-config-daemon-endpoint-ac"
  description: |
    Update @cli-daemon-proxy and @daemon-proxy-detection so daemon routing
    uses connection metadata instead of reconstructing URLs from only a port.

    Why: src/cli/daemon-proxy.ts currently health-checks and proxies to
    http://127.0.0.1:<port>, while other daemon clients use localhost. Once
    bind and connect hosts are configurable, proxy behavior needs to be a
    single metadata-driven contract. The current KSPEC_NO_DAEMON wording also
    conflicts with explicit daemon management command behavior.

    What: Change @cli-daemon-proxy exactly as follows.

      Replace ac-auto-detect with:
        given: The user runs a daemon-proxy-eligible kspec command
        when: Daemon connection metadata points to a running daemon and the
              current project can be registered or is already registered
        then: The command is routed through the daemon API using the
              advertised connect_host and port instead of operating directly
              on the shadow branch

      Replace ac-force-direct with:
        given: KSPEC_NO_DAEMON=1 is set
        when: The user runs a non-daemon-management kspec command
        then: The command operates directly on the shadow branch and
              suppresses incidental daemon communication

      Add ac-force-direct-management-exception:
        given: KSPEC_NO_DAEMON=1 is set
        when: The user runs an explicit daemon management command such as
              kspec serve start, stop, status, or restart
        then: The command follows daemon lifecycle semantics rather than
              forcing direct shadow mode

    Change @daemon-proxy-detection exactly as follows.

      Replace ac-port-file-check with ac-connection-metadata-check:
        given: The CLI starts up
        when: It checks for daemon availability
        then: It reads daemon connection metadata from the standard global
              location and attempts a health check against connect_host and port

      Add ac-legacy-port-file-fallback:
        given: Daemon connection metadata is absent but the legacy global
               daemon.port file exists
        when: The CLI checks for daemon availability
        then: It attempts the health check against 127.0.0.1 and the legacy
              port value

      Replace ac-health-timeout with:
        given: Daemon connection metadata exists but the advertised endpoint
               is unresponsive
        when: The CLI sends a health check
        then: The health check times out within 200ms and the CLI falls back
              to direct mode

    How: Use kspec item ac set/add commands for both specs. Verify with
    kspec item get @cli-daemon-proxy and kspec item get @daemon-proxy-detection.

    Testing: Run kspec validate --warnings-ok after the spec mutation.

    Covers: @cli-daemon-proxy ac-auto-detect, ac-force-direct,
    ac-force-direct-management-exception; @daemon-proxy-detection
    ac-connection-metadata-check, ac-legacy-port-file-fallback,
    ac-health-timeout.

- title: Update global daemon lifecycle and serve command specs for endpoint metadata
  slug: task-update-daemon-lifecycle-endpoint-ac
  priority: 1
  tags: [spec-update, daemon, cli]
  spec_ref: "@multi-directory-daemon"
  depends_on:
    - "@task-update-config-daemon-endpoint-ac"
    - "@task-update-daemon-server-endpoint-ac"
  description: |
    Update @multi-directory-daemon and @cli-serve-commands so global daemon
    lifecycle state records the complete endpoint and serve commands report it.

    Why: The current global daemon model stores pid and port but not the host
    or URL that clients should use. The older serve command specs still refer
    to per-project .kspec daemon files and do not require host/connect_host in
    status output.

    What: Change @multi-directory-daemon exactly as follows.

      Replace ac-9 with:
        given: no daemon is running
        when: kspec serve start runs from any directory
        then: the daemon starts and writes global lifecycle state under
              ~/.config/kspec/, including daemon.pid, daemon.port compatibility
              file, and daemon connection metadata containing pid, port,
              bind_host, connect_host, api_url, ws_url, and runtime

      Replace ac-13 with:
        given: CLI needs to connect to a running daemon
        when: daemon connection metadata exists under ~/.config/kspec/
        then: the CLI reads connect_host and port from the metadata, falling
              back to ~/.config/kspec/daemon.port plus 127.0.0.1 only for
              legacy compatibility

      Add ac-remote-auto-register-blocked:
        given: the daemon is externally bound and a request originates from a
               non-loopback remote address
        when: the request includes X-Kspec-Dir for a project path that is not
              already registered
        then: the daemon rejects the request with 403 and guidance to register
              the project from a local CLI or use the default project

      Add ac-project-registry-local-only:
        given: the daemon is externally bound and a request originates from a
               non-loopback remote address
        when: POST /api/projects or DELETE /api/projects/:encodedPath is called
        then: the daemon rejects the project registry mutation with 403 because
              project registration is local-only

    Change @cli-serve-commands exactly as follows.

      Replace ac-2 with:
        given: daemon not running
        when: kspec serve start --detach is executed
        then: starts in background, writes global daemon lifecycle and
              connection metadata under ~/.config/kspec/, and returns
              immediately with status message including pid, port, bind_host,
              connect_host, and URL

      Replace ac-4 with:
        given: daemon running
        when: kspec serve stop is executed
        then: sends SIGTERM to the daemon PID from global daemon state, waits
              for clean shutdown, and removes global daemon lifecycle and
              connection metadata

      Replace ac-6 with:
        given: any state
        when: kspec serve status is executed
        then: outputs status including running, pid, port, bind_host,
              connect_host, uptime, connections, runtime, and registered
              projects; JSON mode returns the same fields as structured JSON

      Replace ac-8 with:
        given: any state
        when: kspec serve logs is executed
        then: tails the daemon log file from the global daemon state directory
              under ~/.config/kspec/

    How: Use kspec item ac set/add commands for both specs. Verify with
    kspec item get @multi-directory-daemon and kspec item get
    @cli-serve-commands.

    Testing: Run kspec validate --warnings-ok after the spec mutation.

    Covers: @multi-directory-daemon ac-9, ac-13,
    ac-remote-auto-register-blocked, ac-project-registry-local-only;
    @cli-serve-commands ac-2, ac-4, ac-6, ac-8.

- title: Apply daemon endpoint consumer trait to client specs
  slug: task-apply-daemon-endpoint-consumer-trait
  priority: 1
  tags: [spec-update, daemon, cli, trait]
  spec_ref: "@trait-daemon-endpoint-consumer"
  depends_on:
    - "@task-update-cli-daemon-proxy-endpoint-ac"
    - "@task-update-daemon-lifecycle-endpoint-ac"
  description: |
    Apply the new @trait-daemon-endpoint-consumer trait to existing specs that
    describe kspec surfaces communicating with a running daemon.

    Why: The endpoint consumer behavior is cross-cutting: daemon proxy
    detection, command proxying, and serve lifecycle/status commands all need
    the same user-visible guarantee that they communicate with the endpoint
    kspec reports for clients and never attempt to use a wildcard listen
    address as the daemon destination. Keeping that behavior in a trait
    prevents each daemon client spec from restating the same contract with
    slightly different wording.

    What:
    - Add @trait-daemon-endpoint-consumer to @cli-daemon-proxy.
    - Add @trait-daemon-endpoint-consumer to @daemon-proxy-detection.
    - Add @trait-daemon-endpoint-consumer to @cli-serve-commands.
    - Do not add the trait to @config-daemon; it defines settings rather than
      consuming the daemon endpoint.
    - Do not add the trait to @daemon-server; it produces and protects the
      endpoint and should use @trait-localhost-security instead.
    - Do not add the trait to @api-contract or broad @web-ui unless a future
      spec specifically describes a daemon-consuming client surface there.

    How: Use kspec item set or the appropriate trait-update command to add the
    trait refs without removing existing traits. Verify each target item with
    kspec item get and confirm the existing @trait-api-endpoint,
    @trait-websocket-protocol, @trait-error-guidance, or @trait-json-output
    refs remain unchanged where present.

    Testing: Run kspec validate --warnings-ok after the trait refs are added.

    Covers: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint,
    ac-wildcard-not-destination; @cli-daemon-proxy ac-auto-detect;
    @daemon-proxy-detection ac-connection-metadata-check;
    @cli-serve-commands ac-6.

- title: Update web API and runtime specs for endpoint-aware clients
  slug: task-update-web-api-endpoint-ac
  priority: 1
  tags: [spec-update, daemon, web-ui]
  spec_ref: "@api-contract"
  depends_on:
    - "@task-update-config-daemon-endpoint-ac"
  description: |
    Update web API, runtime, and high-level web UI specs so CORS, WebSocket,
    runtime config, and developer UI endpoints follow the centralized daemon
    endpoint contract.

    Why: packages/web-ui/src/lib/constants.ts hardcodes localhost:3456 for
    development API and WebSocket URLs, while production uses same-origin.
    packages/daemon/src/server.ts hardcodes CORS origins for localhost and
    127.0.0.1. The runtime config spec also needs to agree that node is the
    default runtime in current config.

    What: Change @api-contract exactly as follows.

      Replace ac-1 with:
        given: daemon is running
        when: an API request includes an Origin header
        then: CORS allows same-origin daemon web UI requests and configured
              local development origins only

      Add ac-websocket-origin:
        given: daemon is running
        when: a WebSocket connection request includes an Origin header
        then: the origin is accepted only if it matches the same-origin daemon
              web UI or configured local development origins; otherwise the
              connection is rejected

    Change @daemon-runtime-adapter exactly as follows.

      Add ac-config-surface:
        given: kspec.config.yaml contains daemon.runtime
        when: config is loaded before daemon startup
        then: the runtime preference is available as the resolved daemon
              runtime used by serve start and daemon auto-start

      Ensure the default-runtime AC says node is the default runtime. If the
      existing id is ac-default-node, leave it. If the existing id or wording
      still says bun, update it to:
        id: ac-default-node
        given: No runtime preference is configured
        when: The daemon starts
        then: By default the daemon spawns using node

    Change @web-ui exactly as follows.

      Replace the Bun-only local daemon wording in the description with:
        Local daemon mode runs the daemon on the configured JavaScript
        runtime, defaulting to Node, using Elysia with the appropriate runtime
        adapter. Bun remains supported as an optional configured runtime.

      Replace @web-ui ac-1 with:
        given: user installs kspec CLI package
        when: daemon starts on the configured runtime
        then: all daemon runtime dependencies for the configured runtime are
              available without additional install steps except the runtime
              executable itself when an optional runtime such as Bun is selected

    How: Use kspec item ac set/add and kspec item set commands. Verify with
    kspec item get @api-contract, @daemon-runtime-adapter, and @web-ui.

    Testing: Run kspec validate --warnings-ok after the spec mutation.

    Covers: @api-contract ac-1, ac-websocket-origin;
    @daemon-runtime-adapter ac-config-surface, ac-default-node; @web-ui ac-1.

- title: Implement shared daemon endpoint resolver and metadata model
  slug: task-shared-daemon-endpoint-resolver
  priority: 1
  tags: [daemon, cli, config, foundation]
  spec_ref: "@daemon-network-endpoint-contract"
  depends_on:
    - "@task-update-config-daemon-endpoint-ac"
    - "@task-update-daemon-server-endpoint-ac"
    - "@task-update-daemon-lifecycle-endpoint-ac"
  description: |
    Create the shared daemon endpoint module that all daemon binding and
    client connection code uses.

    Why: The repository currently duplicates daemon lifecycle state code in
    src/cli/pid-utils.ts and packages/daemon/src/pid.ts, hardcodes daemon
    URLs in multiple CLI files, and hardcodes daemon listen hostname in
    packages/daemon/src/server.ts. A single shared endpoint module prevents
    localhost, IPv4, IPv6, wildcard, and port behavior from drifting again.

    What:
    1. Add a shared TypeScript module usable by both src/cli/* and
       packages/daemon/src/*, for example src/daemon/endpoint.ts or a shared
       package-local module included by the daemon build.
    2. Define exported types for daemon network config and metadata:
       - port: number
       - bindHost: string
       - connectHost: string
       - apiUrl: string
       - wsUrl: string
       - runtime: "node" | "bun"
       - pid: number
       - externallyReachable: boolean
    3. Implement helpers:
       - normalizeDaemonHost(value): validates and normalizes host strings
       - resolveDaemonBindHost(config): defaults to 127.0.0.1
       - resolveDaemonConnectHost(bindHost, explicitConnectHost?): maps
         wildcard bind hosts to a loopback or explicit connect host
       - formatHostForUrl(host): brackets IPv6 literals only in URLs
       - buildDaemonUrls(connectHost, port): returns apiUrl and wsUrl
       - isLoopbackHost(host) and isWildcardHost(host)
       - readDaemonConnectionMetadata() and writeDaemonConnectionMetadata()
       - readLegacyDaemonPortEndpoint() for daemon.port fallback
    4. Extend the config schema in src/parser/config.ts with optional
       daemon.connect_host and KSPEC_DAEMON_CONNECT_HOST precedence.
    5. Change DEFAULT_CONFIG.daemon.host from localhost to 127.0.0.1 and keep
       DEFAULT_CONFIG.daemon.port as the existing default port.
    6. Retain the legacy daemon.port file for compatibility while making the
       new metadata file the source of truth for new clients.
    7. Update or replace duplicated PID/port helpers so metadata behavior is
       defined in one implementation. If both files must temporarily remain,
       make one delegate to shared helpers and add tests proving they stay in
       sync.

    How: Start with pure helper functions and unit tests before wiring any
    network listener. Keep URL construction out of command files; command
    files should receive or read a resolved endpoint object. Do not use
    dns.setDefaultResultOrder() as a fix because it changes process-wide DNS
    behavior and does not control daemon binding. Do not advertise 0.0.0.0 or
    :: as client URLs.

    Testing: Add focused unit tests for default 127.0.0.1 behavior, IPv6 URL
    bracket formatting, wildcard bind-host connect-host mapping, explicit
    connect host, env/config precedence, and legacy daemon.port fallback.

    Covers: @daemon-network-endpoint-contract ac-default-loopback-v4,
    ac-wildcard-connect-host, ac-connection-metadata, ac-legacy-port-fallback;
    @config-daemon ac-host-default, ac-connect-host-config,
    ac-port-env-precedence, ac-connection-metadata.

- title: Wire daemon startup to resolved bind host and endpoint metadata
  slug: task-daemon-startup-bind-host-metadata
  priority: 1
  tags: [daemon, server, lifecycle]
  spec_ref: "@daemon-network-endpoint-contract"
  depends_on:
    - "@task-shared-daemon-endpoint-resolver"
  description: |
    Make daemon startup bind to the resolved host and write complete daemon
    endpoint metadata.

    Why: packages/daemon/src/server.ts currently calls app.listen({ port,
    hostname: "localhost" }) and logs localhost URLs. packages/daemon/src/index.ts
    parses --port and --kspec-dir but no --host. src/cli/commands/serve.ts and
    src/cli/index.ts spawn the daemon with only --port. This ignores daemon.host
    and creates the reported IPv4/IPv6 mismatch when localhost resolves only to
    ::1.

    What:
    1. Extend packages/daemon/src/server.ts ServerOptions to include bindHost,
       connectHost, and resolved URL fields.
    2. Change the production listen call in packages/daemon/src/server.ts from
       hostname: "localhost" to the resolved bindHost.
    3. If the default 127.0.0.1 bind fails specifically because IPv4 loopback
       is unavailable, retry once on ::1 and advertise bracketed IPv6 URLs.
       Do not retry on ::1 for unrelated errors such as EADDRINUSE.
    4. Write the complete daemon metadata under ~/.config/kspec/ after the
       server is listening and continue writing daemon.port for compatibility.
    5. Remove metadata on clean shutdown and stop; keep stale metadata cleanup
       behavior aligned with existing stale pid cleanup.
    6. Add --host and --connect-host parsing to packages/daemon/src/index.ts.
    7. Update src/cli/commands/serve.ts and src/cli/index.ts auto-start to pass
       resolved --host and --connect-host values from config and env.
    8. Update startup/status logs to print the advertised apiUrl and wsUrl. If
       the bind host is non-loopback or wildcard, print the external binding
       warning from @trait-localhost-security.

    How: Reuse the shared endpoint resolver exclusively. Keep the daemon's
    network values immutable after startup and store the actual fallback bind
    host in metadata if ::1 fallback occurs. Ensure node and bun runtime paths
    receive the same ServerOptions values.

    Testing: Add daemon startup tests that assert app.listen receives 127.0.0.1
    by default, configured host values are passed through, --host overrides
    config/env as specified, metadata is written with api_url/ws_url, and ::1
    fallback produces http://[::1]:<port> URLs. Run npm test -- --run
    tests/parser/daemon-config.test.ts tests/cli-serve.test.ts
    tests/daemon-server.test.ts.

    Covers: @daemon-network-endpoint-contract ac-default-loopback-v4,
    ac-default-ipv6-fallback, ac-configured-bind-host,
    ac-connection-metadata, ac-external-binding-warning; @daemon-server ac-1,
    ac-9, ac-10, ac-external-bind-warning; @config-daemon ac-host-config,
    ac-host-env-precedence.

- title: Centralize CLI daemon client connection logic
  slug: task-centralize-cli-daemon-clients
  priority: 1
  tags: [cli, daemon, proxy]
  spec_ref: "@daemon-network-endpoint-contract"
  depends_on:
    - "@task-daemon-startup-bind-host-metadata"
    - "@task-update-cli-daemon-proxy-endpoint-ac"
    - "@task-apply-daemon-endpoint-consumer-trait"
  description: |
    Replace scattered CLI daemon URL construction with the shared endpoint
    resolver.

    Why: CLI daemon clients currently disagree about the host. The main proxy
    in src/cli/daemon-proxy.ts uses 127.0.0.1, while serve status,
    daemon-status, task event emission, agent commands, event commands, and
    schedule commands construct localhost URLs. These codepaths must all use
    one endpoint resolver so daemon bind/connect behavior is deterministic.

    What:
    1. Update src/cli/daemon-proxy.ts health check, project registration, and
       /api/command proxy calls to read the daemon endpoint from shared
       metadata and use endpoint.apiUrl.
    2. Update src/parser/daemon-status.ts to use the shared endpoint when
       checking /api/health.
    3. Update src/cli/commands/serve.ts status/project/health fetches to use
       the shared endpoint and report bind_host/connect_host in text and JSON.
    4. Replace the duplicate getDaemonUrl() helpers in
       src/cli/commands/agent.ts, src/cli/commands/event.ts, and
       src/cli/commands/schedule.ts with a shared helper that returns the
       metadata endpoint.
    5. Update src/cli/commands/task.ts emitTaskStatusChangeEvent() to use the
       shared endpoint and keep its existing non-fatal failure semantics.
    6. Ensure KSPEC_NO_DAEMON=1 suppresses incidental daemon communication for
       non-management commands but does not block explicit serve lifecycle
       commands.
    7. Ensure --daemon still fails with clear guidance if metadata exists but
       the advertised endpoint is unreachable.

    How: Remove literal http://localhost and http://127.0.0.1 URL construction
    from CLI daemon client code. Tests should assert the constructed URLs come
    from metadata by using temporary metadata with a non-default connect_host.
    Keep legacy daemon.port fallback in the shared helper, not in individual
    command files.

    Testing: Extend tests/cli-daemon-proxy.test.ts with metadata-driven
    endpoint tests, IPv6 bracket URL tests, and legacy port fallback tests.
    Add or update tests for serve status, agent/event/schedule helpers, and
    task event emission. Run npm test -- --run tests/cli-daemon-proxy.test.ts
    tests/cli-serve.test.ts tests/parser/daemon-config.test.ts.

    Covers: @daemon-network-endpoint-contract ac-clients-use-metadata,
    ac-legacy-port-fallback; @trait-daemon-endpoint-consumer
    ac-uses-reported-endpoint, ac-wildcard-not-destination;
    @cli-daemon-proxy ac-auto-detect, ac-force-direct,
    ac-force-direct-management-exception; @daemon-proxy-detection
    ac-connection-metadata-check, ac-legacy-port-file-fallback,
    ac-health-timeout; @cli-serve-commands ac-6.

- title: Centralize web UI development daemon endpoints and CORS origins
  slug: task-centralize-web-ui-daemon-endpoints
  priority: 1
  tags: [web-ui, daemon, api]
  spec_ref: "@daemon-network-endpoint-contract"
  depends_on:
    - "@task-shared-daemon-endpoint-resolver"
    - "@task-update-web-api-endpoint-ac"
  description: |
    Make web UI development API/WebSocket endpoints and daemon CORS/origin
    behavior follow the same endpoint contract as CLI clients.

    Why: packages/web-ui/src/lib/constants.ts currently hardcodes
    http://localhost:3456 and ws://localhost:3456 for SSR and Vite dev mode.
    packages/daemon/src/server.ts hardcodes CORS origins for localhost:5173
    and 127.0.0.1:5173. Those values drift from configured daemon host and
    port, and they preserve localhost resolver dependence in development.

    What:
    1. Replace the hardcoded DAEMON_PORT in packages/web-ui/src/lib/constants.ts
       with an environment-driven value that defaults to the shared daemon
       default port.
    2. Replace dev/SSR localhost API and WebSocket URLs with endpoint formatting
       that defaults to 127.0.0.1 and correctly brackets IPv6 when configured.
    3. Preserve production same-origin behavior when the daemon serves the web UI.
    4. Add documented Vite/SvelteKit environment variables for web UI dev mode,
       such as VITE_KSPEC_DAEMON_HOST and VITE_KSPEC_DAEMON_PORT, wired through
       the same formatting rules as the shared resolver.
    5. Update daemon CORS configuration to allow same-origin requests and the
       configured local development origins derived from the endpoint config.
       Do not add wildcard CORS for external binding.
    6. Add WebSocket origin checks matching @api-contract ac-websocket-origin.

    How: If browser code cannot import the Node shared endpoint module directly,
    extract pure host-formatting helpers into a platform-neutral file or mirror
    them with tests that assert parity. Keep all host formatting rules in one
    documented place and avoid ad hoc template strings for IPv6 URLs.

    Testing: Update web UI constants tests and API/WebSocket tests to cover
    default 127.0.0.1, configured host/port, IPv6 bracket formatting, production
    same-origin behavior, and rejected unexpected origins. Run npm test -- --run
    tests/web-ui tests/daemon-api/server.test.ts tests/daemon-api/websocket-protocol.test.ts.

    Covers: @daemon-network-endpoint-contract ac-clients-use-metadata,
    ac-default-loopback-v4; @api-contract ac-1, ac-websocket-origin;
    @web-ui ac-1.

- title: Add daemon endpoint regression coverage across IPv4, IPv6, and configured hosts
  slug: task-daemon-endpoint-regression-tests
  priority: 2
  tags: [daemon, cli, tests]
  spec_ref: "@daemon-network-endpoint-contract"
  depends_on:
    - "@task-centralize-cli-daemon-clients"
    - "@task-centralize-web-ui-daemon-endpoints"
  description: |
    Add end-to-end and focused regression tests proving daemon binding and
    client connection behavior is centralized and portable.

    Why: Existing tests mostly bind mock servers to 127.0.0.1 or call
    localhost directly, so they did not catch a daemon bound via localhost to
    ::1 while clients attempted 127.0.0.1. The bug should stay fixed across
    Windows, Linux, and macOS without asking users to edit hosts files.

    What:
    1. Add helper tests for the shared endpoint module covering:
       - default bind/connect host is 127.0.0.1
       - localhost is not resolved unless explicitly configured
       - IPv6 literals format as http://[::1]:<port> and ws://[::1]:<port>/ws
       - wildcard bind hosts do not become client connect URLs
       - configured connect_host overrides wildcard local defaults
    2. Extend tests/cli-daemon-proxy.test.ts with a mock daemon whose metadata
       advertises ::1 and assert health/project/command proxy calls use
       http://[::1]:<port>.
    3. Extend daemon startup tests to assert configured host and --host values
       reach the production listen call for node and bun runtime paths.
    4. Add a status test that creates metadata with non-default host/port and
       proves kspec serve status reads and reports that endpoint.
    5. Add a daemon lifecycle test that explicitly configures a wildcard or
       non-loopback bind host and asserts startup or status output includes the
       unauthenticated external-binding warning.
    6. Add web UI constants tests for configured dev host/port and IPv6 bracket
       formatting.
    7. Add behavioral coverage for every production daemon client path that
       previously constructed its own host: main proxy health/project/command
       requests, serve status health/project requests, daemon-status health
       checks, agent/event/schedule daemon helpers, task event emission, and
       web UI development API/WebSocket endpoints. Each test should seed or
       configure a non-default advertised endpoint and assert the request is
       sent to that endpoint.

    How: Prefer deterministic unit/integration tests over mutating the machine's
    /etc/hosts. Use high ephemeral ports and isolated temporary config
    directories. Skip only the IPv6 socket integration case when the runtime
    reports IPv6 loopback is unavailable; still run pure formatting tests on all
    platforms.

    Testing: Run the full endpoint-focused suite:
      npm test -- --run tests/cli-daemon-proxy.test.ts tests/cli-serve.test.ts
      tests/parser/daemon-config.test.ts tests/daemon-server.test.ts
      tests/daemon-api/server.test.ts tests/daemon-api/websocket-protocol.test.ts
      tests/web-ui

    Covers: @daemon-network-endpoint-contract all ACs;
    @trait-daemon-endpoint-consumer ac-uses-reported-endpoint,
    ac-wildcard-not-destination; @daemon-server ac-1, ac-2, ac-3,
    ac-external-bind-warning; @cli-daemon-proxy ac-auto-detect;
    @daemon-proxy-detection ac-connection-metadata-check; @api-contract ac-1,
    ac-websocket-origin.
```

## Implementation Notes

### Investigation summary

The current daemon network contract is split across hardcoded values:

- `packages/daemon/src/server.ts:634-642` binds and logs `localhost` directly.
- `packages/daemon/src/server.ts:229-257` parses Host headers manually and
  permits only `localhost`, `127.0.0.1`, and `::1`.
- `src/parser/config.ts:86-97` parses `daemon.host` and `daemon.runtime`, and
  `src/parser/config.ts:693-705` resolves `daemon.host`, but daemon startup
  does not pass that host to the daemon.
- `src/cli/index.ts:195-199` auto-starts the daemon with `--port` and
  `--kspec-dir` only.
- `src/cli/daemon-proxy.ts:94`, `:164`, and `:218` hardcode
  `http://127.0.0.1:<port>`.
- `src/parser/daemon-status.ts:72`, `src/cli/commands/serve.ts:579` and `:595`,
  `src/cli/commands/task.ts:99`, and helper functions in
  `src/cli/commands/agent.ts`, `src/cli/commands/event.ts`, and
  `src/cli/commands/schedule.ts` use `localhost`-based daemon URLs.
- `packages/web-ui/src/lib/constants.ts:13-25` hardcodes dev/SSR API and
  WebSocket endpoints to `localhost:3456`.
- `src/cli/pid-utils.ts` and `packages/daemon/src/pid.ts` duplicate global
  daemon pid/port handling and persist only the port, not the host or URL.

Cross-platform recommendation: default to numeric IPv4 loopback `127.0.0.1`
for both bind and connect. Numeric loopback avoids `/etc/hosts`, DNS result
ordering, and Node/Bun/Elysia differences. If default IPv4 loopback is
unavailable, fallback to `::1` and advertise bracketed IPv6 URLs such as
`http://[::1]:3456`. Do not rely on omitted host, Bun/Elysia defaults, or
`localhost`: omitted host and framework defaults can expose `0.0.0.0`/`::`,
and `localhost` is resolver-dependent.

External binding is intentionally supported only by explicit configuration.
When the bind host is wildcard or non-loopback, the daemon must warn that it has
no authentication and exposes project data and mutation APIs. Wildcard bind
addresses are not valid client endpoints, so local clients should use a loopback
connect host or an explicit configured connect host.

### Dependency ordering

Spec-update tasks run first so the catalog no longer contradicts the work. The
localhost-security update reconciles default loopback security with explicitly
configured external binding. The endpoint-consumer trait is applied after the
existing CLI daemon specs are updated, so the shared client contract is attached
only to specs that actually communicate with a running daemon.
`task-shared-daemon-endpoint-resolver` creates the shared pure contract before
startup or client code is rewired. Daemon startup writes metadata before CLI and
web UI clients switch to consuming it. Regression coverage runs last because it
spans the shared module, daemon startup, CLI proxy, serve status, and web UI dev
endpoints.

### Out of scope

This plan does not add daemon authentication, TLS, remote user management, or a
LAN discovery workflow. It only makes configured external binding explicit,
warned, and internally consistent with existing unauthenticated daemon APIs.
