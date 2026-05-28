# Daemon Test Fixture Standardization

## Specs

```yaml
- title: Daemon-Backed Test Fixture Contract
  slug: daemon-backed-test-fixture-contract
  type: requirement
  parent: "@daemon-server"
  tags: [testing, daemon, reliability]
  description: |
    Daemon-backed tests use one shared fixture contract for process startup,
    project setup, environment isolation, readiness, and teardown. The
    contract applies to Vitest and Playwright tests that start a real daemon
    process, while allowing unit tests and in-process route tests to use
    narrower fixtures that do not start a daemon.
  acceptance_criteria:
    - id: ac-real-daemon-tests-use-shared-fixture
      given: |
        A Vitest or Playwright test needs a real daemon child process
      when: |
        The test starts the daemon
      then: |
        Startup flows through the shared daemon test fixture
    - id: ac-isolated-home-config
      given: |
        A daemon-backed test prepares daemon lifecycle state
      when: |
        The fixture builds the child process environment
      then: |
        The daemon HOME and kspec config directory are isolated from the
        ambient user environment
    - id: ac-isolated-project-data
      given: |
        A daemon-backed test prepares kspec project data
      when: |
        The fixture creates the project workspace
      then: |
        The daemon reads only fixture-owned project files
    - id: ac-scoped-cleanup
      given: |
        A daemon-backed test has started a child daemon process
      when: |
        The test completes, fails, or times out
      then: |
        Cleanup targets only the daemon owned by that fixture
    - id: ac-readiness-diagnostics
      given: |
        A daemon-backed test waits for daemon readiness
      when: |
        Readiness is not reached before the timeout
      then: |
        The failure output reports a diagnostic bundle for the failed startup
        attempt
    - id: ac-bounded-readiness
      given: |
        A daemon-backed test needs startup synchronization
      when: |
        The test waits for daemon readiness
      then: |
        The wait uses bounded polling rather than fixed sleep delays
    - id: ac-no-ambient-daemon-control
      given: |
        A developer or CI runner has an unrelated daemon running
      when: |
        Daemon-backed tests run in parallel
      then: |
        The tests do not stop, kill, or reuse the unrelated daemon

- title: Daemon Test Endpoint Consistency
  slug: daemon-test-endpoint-consistency
  type: requirement
  parent: "@daemon-network-endpoint-contract"
  traits:
    - "@trait-daemon-endpoint-consumer"
  tags: [testing, daemon, endpoint]
  description: |
    Tests that call a daemon use the same endpoint contract as production
    daemon consumers. Real daemon fixtures, mock daemon fixtures, HTTP test
    clients, WebSocket clients, browser page URLs, and CLI metadata setup all
    receive endpoint information from one resolved fixture endpoint instead of
    constructing localhost URLs independently.
  acceptance_criteria:
    - id: ac-resolved-endpoint-source
      given: |
        A daemon test fixture has resolved a daemon endpoint
      when: |
        Test code makes an HTTP or WebSocket daemon request
      then: |
        The request uses the fixture-provided client endpoint
    - id: ac-no-localhost-by-default
      given: |
        A daemon test fixture uses the default loopback endpoint
      when: |
        The fixture reports client URLs
      then: |
        The URLs use 127.0.0.1 rather than localhost
    - id: ac-http-ws-same-endpoint
      given: |
        A test uses both HTTP and WebSocket daemon clients
      when: |
        The fixture provides client URLs
      then: |
        Both clients address the same resolved daemon endpoint
    - id: ac-mock-metadata-fidelity
      given: |
        A CLI client test uses a mock daemon instead of a real daemon
      when: |
        The test records daemon connection metadata
      then: |
        The metadata matches the canonical daemon connection contract
    - id: ac-dynamic-port-propagation
      given: |
        A test daemon listens on a dynamic port
      when: |
        Test clients are created
      then: |
        The clients receive the port from the fixture endpoint

- title: Daemon Test Runtime Selection
  slug: daemon-test-runtime-selection
  type: requirement
  parent: "@daemon-runtime-adapter"
  tags: [testing, daemon, runtime]
  description: |
    Daemon tests exercise the same runtime defaults and runtime-selection
    behavior promised by the daemon runtime adapter. Generic daemon tests run
    against Node by default. Runtime-specific or parity tests opt into a
    runtime matrix explicitly and treat Bun as optional unless the test is
    specifically validating a configured Bun environment.
  acceptance_criteria:
    - id: ac-node-default
      given: |
        A daemon-backed test does not opt into a specific runtime
      when: |
        The shared daemon fixture starts the daemon
      then: |
        The daemon starts with Node
    - id: ac-explicit-runtime-only
      given: |
        A test starts the daemon with Bun
      when: |
        The test is authored or modified
      then: |
        The test declares that Bun runtime behavior is part of its subject
    - id: ac-runtime-matrix-parity
      given: |
        A test claims HTTP or WebSocket parity across daemon runtimes
      when: |
        The parity suite runs on a machine with the configured runtimes
      then: |
        The same daemon behavior is exercised for each available runtime
    - id: ac-missing-optional-runtime-skips
      given: |
        A parity test includes an optional runtime that is not installed
      when: |
        The parity suite starts
      then: |
        The missing optional runtime is reported as a skipped runtime case
    - id: ac-runtime-degradation-assertions
      given: |
        A runtime lacks a daemon capability such as frame-level WebSocket
        heartbeat support
      when: |
        Runtime-specific daemon behavior is tested
      then: |
        The test asserts the documented degraded behavior for that runtime

- title: Daemon Test Mode Boundaries
  slug: daemon-test-mode-boundaries
  type: requirement
  parent: "@daemon-server"
  tags: [testing, daemon, api]
  description: |
    Daemon tests choose the lightest fixture mode that still exercises the
    behavior under test. Route and API handler tests use in-process app
    fixtures. CLI client routing tests use mock daemons with realistic
    metadata. Daemon lifecycle, runtime adapter, and WebSocket protocol tests
    use real child daemons through the shared fixture.
  acceptance_criteria:
    - id: ac-in-process-route-tests-no-child-process
      given: |
        A daemon API test only needs route handler behavior
      when: |
        The test creates the daemon app
      then: |
        The test does not spawn a daemon child process
    - id: ac-cli-client-tests-use-mock-daemon
      given: |
        A CLI test only needs to verify daemon client routing
      when: |
        The test prepares a reachable daemon endpoint
      then: |
        The test uses a mock daemon with canonical connection metadata
    - id: ac-cli-lifecycle-tests-use-cli-path
      given: |
        A CLI test verifies serve start, stop, status, or restart behavior
      when: |
        The test manages a daemon process
      then: |
        The test invokes the CLI lifecycle path under test
    - id: ac-full-process-tests-use-real-daemon
      given: |
        A test verifies daemon runtime, lifecycle, cache readiness, or
        WebSocket protocol behavior
      when: |
        The behavior requires the daemon process boundary
      then: |
        The test uses a real child daemon through the shared fixture

- title: Daemon Test Harness Guardrails
  slug: daemon-test-harness-guardrails
  type: requirement
  parent: "@daemon-server"
  tags: [testing, lint, daemon]
  description: |
    Focused fixture contract tests plus static and runtime guardrails keep new
    daemon tests on the standardized helpers. Direct daemon child-process
    startup and detached serve commands are allowed only inside the shared
    helper implementation or in explicitly documented exception tests.
  acceptance_criteria:
    - id: ac-fixture-contract-tests-run
      given: |
        Shared daemon fixture or helper behavior is implemented or changed
      when: |
        daemon test validation runs
      then: |
        Focused helper tests exercise the fixture contract directly
    - id: ac-direct-daemon-spawn-flagged
      given: |
        A test file starts a real daemon directly outside the shared daemon
        fixture
      when: |
        the daemon-test guardrail check runs
      then: |
        The check reports the direct daemon startup
    - id: ac-detached-serve-without-cleanup-flagged
      given: |
        A test file starts a detached daemon through the CLI without scoped
        cleanup
      when: |
        the daemon-test guardrail check runs
      then: |
        The check reports the unsafe detached daemon start
    - id: ac-helper-internals-allowed
      given: |
        The shared daemon fixture implementation starts a daemon process
      when: |
        the daemon-test guardrail check runs
      then: |
        The check accepts the helper-owned startup code
    - id: ac-exceptions-are-localized
      given: |
        A test needs to exercise behavior that intentionally violates the
        normal fixture pattern
      when: |
        the daemon-test guardrail check runs
      then: |
        The check accepts only a local documented exception for that test case
```

## Tasks

derive_from_specs: false

```yaml
- title: Update existing daemon test specs for shared fixture standards
  slug: task-update-daemon-test-specs
  priority: 1
  tags: [spec-update, testing, daemon]
  description: |
    Update the existing daemon-related test specs so they align with the new
    shared fixture standards in this plan.

    Why: The current spec catalog describes daemon-sensitive CLI tests and
    Playwright daemon isolation, but the wording is narrower than the actual
    daemon-backed test surface. It also leaves test-specific endpoint behavior
    implicit in @daemon-network-endpoint-contract even though current tests
    have independently constructed localhost URLs.

    What:
    - Update @daemon-sensitive-cli-test-determinism exactly as follows:
      - Change the title to "Daemon-Sensitive Test Determinism".
      - Replace the description with:
        "Define deterministic testing patterns for daemon-sensitive CLI,
        Vitest, and Playwright tests so parallel execution and ambient machine
        daemon state do not create flaky failures. Daemon-backed tests use
        shared helpers for isolated HOME/config state, bounded readiness waits,
        actionable diagnostics, and scoped cleanup."
      - Replace the acceptance criteria with these five ACs, preserving the
        slug @daemon-sensitive-cli-test-determinism:
        - ac-readiness-diagnostics
          given: A daemon-sensitive test waits for process or server readiness
          when: the readiness wait exceeds its timeout
          then: the failing assertion includes actionable process output and
          the last observed readiness state
        - ac-bounded-readiness
          given: daemon-sensitive tests need startup synchronization
          when: tests wait for server or foreground process readiness
          then: tests use bounded polling helpers instead of fixed sleep delays
        - ac-isolated-home-config
          given: daemon-sensitive tests run in parallel with ambient daemon state
          when: the tests invoke CLI commands or start daemon processes
          then: HOME and daemon config state are isolated through shared helpers
        - ac-scoped-daemon-cleanup
          given: a daemon-sensitive test starts a daemon process
          when: the test finishes or fails
          then: cleanup targets only the daemon owned by that test fixture
        - ac-fixture-contract-tests
          given: shared daemon test fixture behavior is implemented or changed
          when: daemon-sensitive test validation runs
          then: focused helper tests exercise the fixture contract directly
    - Update @e2e-test-daemon-isolation exactly as follows:
      - Change the title to "Browser E2E Daemon Fixture Integration".
      - Replace the description with:
        "Playwright tests that need daemon-backed browser behavior use the
        shared daemon test fixture through a Playwright wrapper. Browser URLs,
        API calls, isolated HOME/config state, dynamic ports, readiness, and
        teardown are supplied by the same daemon fixture contract used by
        Vitest daemon-backed tests."
      - Replace the acceptance criteria with these five ACs, preserving the
        slug @e2e-test-daemon-isolation:
        - ac-uses-shared-fixture
          given: a Playwright test needs a daemon for API or browser testing
          when: the Playwright fixture starts a daemon
          then: startup flows through the shared daemon test fixture
        - ac-browser-endpoint-from-fixture
          given: the Playwright daemon fixture reports an endpoint
          when: browser pages navigate or make daemon API calls
          then: the browser uses the endpoint supplied by the fixture
        - ac-isolated-e2e-state
          given: Playwright tests start a daemon in a temp project
          when: the fixture creates the daemon environment
          then: HOME and daemon config paths are isolated from the ambient system
        - ac-e2e-scoped-cleanup
          given: a Playwright test daemon has started
          when: Playwright fixture teardown runs
          then: teardown stops only the fixture-owned daemon
        - ac-dynamic-port-propagation
          given: the Playwright daemon listens on a dynamic port
          when: Playwright tests make API calls or navigate browser pages
          then: the port is propagated through the daemon fixture context
    - Update @daemon-network-endpoint-contract by adding this AC without
      changing the existing ACs:
        - ac-tests-use-resolved-endpoint
          given: a daemon-backed test starts or mocks a daemon
          when: the test creates HTTP clients, WebSocket clients, browser URLs,
          or daemon connection metadata
          then: the test uses the canonical resolved daemon endpoint
    - Set implementation status for each updated spec to in_progress unless
      the same branch also migrates all behavior needed by the updated ACs.

    How:
    Use kspec item set and kspec item ac set/add/remove commands. Do not edit
    .kspec YAML by hand. After updating each spec, run kspec item get on that
    ref and verify the final title, description, AC IDs, and status match the
    text above.

    Testing:
    Run kspec validate --refs --warnings-ok after the spec mutations. Also run
    a focused grep for the old AC IDs in tests and update stale AC annotations
    only where the test still truthfully covers the rewritten behavior.

    Covers: @daemon-sensitive-cli-test-determinism ac-readiness-diagnostics,
    ac-bounded-readiness, ac-isolated-home-config, ac-scoped-daemon-cleanup,
    ac-fixture-contract-tests;
    @e2e-test-daemon-isolation ac-uses-shared-fixture,
    ac-browser-endpoint-from-fixture, ac-isolated-e2e-state,
    ac-e2e-scoped-cleanup, ac-dynamic-port-propagation;
    @daemon-network-endpoint-contract ac-tests-use-resolved-endpoint.

- title: Implement shared daemon test fixture core
  slug: task-implement-shared-daemon-test-fixture
  priority: 1
  tags: [testing, daemon, fixture]
  spec_ref: "@daemon-backed-test-fixture-contract"
  depends_on:
    - "@task-update-daemon-test-specs"
  description: |
    Implement the shared daemon test fixture core used by real daemon process
    tests.

    Why: Multiple tests currently duplicate daemon process setup, port
    selection, environment isolation, readiness polling, runtime selection, and
    cleanup. The duplicated code has already drifted: the websocket protocol
    test hardcodes Bun, uses localhost URLs, and produces weak readiness
    diagnostics compared with newer helper patterns.

    What:
    - Add a shared helper module for daemon-backed tests, for example
      tests/helpers/daemon.ts.
    - Provide a fixture creation API that prepares:
      - a temp kspec project directory with .kspec data needed by the daemon;
      - an isolated HOME/config directory using createIsolatedKspecHome from
        tests/helpers/cli.ts;
      - a sanitized child process env that does not inherit ambient daemon
        PID/port/session state;
      - a resolved daemon endpoint using src/daemon-shared/endpoint.ts;
      - cleanup registration that is installed immediately after a daemon
        child is spawned.
    - Provide startTestDaemon options for:
      - runtime: default node, explicit node, explicit bun, or runtime matrix
        entry;
      - bind host and connect host;
      - readiness mode: health only, health plus cache ready, or custom probe;
      - process startup mode: direct child process for daemon process tests.
    - Build readiness on top of tests/helpers/cli.ts waitForStartup or an
      equivalent shared polling helper that preserves the last observed state.
    - On readiness failure, include endpoint, runtime, child pid, exit code or
      signal if known, stdout tail, stderr tail, last health response, and last
      cache-status response in the thrown error.
    - Stop fixture-owned daemons by child process handle or scoped lifecycle
      metadata only. Do not kill by port number.
    - Add tests/helpers/daemon.test.ts as the focused contract test suite for
      the helper itself. Cover runtime selection, environment isolation,
      endpoint defaults, dynamic port propagation, readiness timeout diagnostics,
      and cleanup behavior without relying only on migrated product-flow tests.

    How:
    Reuse createTempDir, cleanupTempDir, initGitRepo, createIsolatedKspecHome,
    readTestOutputSync, and waitForStartup from tests/helpers/cli.ts instead of
    copying their behavior. Import resolveDaemonEndpoint and canonical metadata
    helpers from src/daemon-shared/endpoint.ts rather than formatting daemon
    URLs independently. Keep the helper small enough that Playwright can import
    the core logic through a wrapper without depending on Vitest globals.

    Testing:
    First run the helper contract suite directly:
    - mise exec -- npm test -- --fresh tests/helpers/daemon.test.ts

    Then run the migrated websocket consumer after the websocket migration task
    lands:
    - mise exec -- npm test -- --fresh tests/daemon-api/websocket-protocol.test.ts

    Covers: @daemon-backed-test-fixture-contract
    ac-real-daemon-tests-use-shared-fixture, ac-isolated-home-config,
    ac-isolated-project-data, ac-scoped-cleanup, ac-readiness-diagnostics,
    ac-bounded-readiness, ac-no-ambient-daemon-control;
    @daemon-test-endpoint-consistency ac-no-localhost-by-default,
    ac-dynamic-port-propagation; @daemon-test-runtime-selection ac-node-default;
    @daemon-test-harness-guardrails ac-fixture-contract-tests-run;
    @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests.

- title: Migrate real daemon Vitest process tests to the shared fixture
  slug: task-migrate-real-daemon-vitest-tests
  priority: 2
  tags: [testing, daemon, vitest]
  spec_ref: "@daemon-backed-test-fixture-contract"
  depends_on:
    - "@task-implement-shared-daemon-test-fixture"
  description: |
    Convert Vitest tests that start a real daemon child process to use the
    shared daemon fixture.

    Why: Real daemon process tests exercise the highest-risk path for flakiness:
    child processes, readiness timing, dynamic ports, runtime selection, and
    cleanup. Keeping those tests on bespoke fixtures allows the same localhost,
    Bun-default, and weak-diagnostic drift to recur.

    What:
    - Migrate tests/daemon-api/websocket-protocol.test.ts to the shared helper.
      The default run must use Node. WebSocket URLs must come from the fixture
      ws_url. Cache readiness must use the shared readiness mode rather than a
      local polling loop. Preserve the existing protocol assertions for
      connected events, ping/ack, subscriptions, task_created flow, malformed
      messages, unknown message types, and multiple clients.
    - Add runtime parity coverage for the websocket protocol where it belongs:
      either a small node-plus-installed-bun matrix inside the websocket test or
      a focused runtime parity test that covers connect, subscribe, broadcast,
      and documented heartbeat degradation. If Bun is not installed, report the
      Bun case as skipped rather than failing generic Node coverage.
    - Migrate tests/daemon-build.test.ts to use the shared dynamic endpoint,
      runtime-selection helpers, and readiness diagnostics while preserving its
      build-artifact smoke-test purpose.
    - Migrate direct daemon child-process sections in tests/cli-serve.test.ts
      that spawn dist/daemon/index.js outside the CLI lifecycle subject. Keep
      tests that intentionally verify serve start, serve stop, serve status, or
      serve restart on the CLI path.
    - Audit tests/cli-no-daemon.test.ts and any other Vitest file that starts a
      real daemon process. Convert real daemon setup to the helper or document a
      narrow exception if the test must verify a lower-level process behavior.
    - Remove duplicated getAvailablePort, waitForDaemonReady, spawn("bun"),
      spawn("node"), baseUrl, and wsUrl construction from migrated tests.
    - Update AC annotations in migrated tests to the rewritten existing specs
      and new plan specs.

    How:
    Migrate one file at a time. After each file, run its focused test command
    with mise exec -- npm test -- --fresh <file>. Keep route-level assertions
    unchanged unless the helper changes only setup mechanics. Do not broaden the
    product behavior under test while migrating fixtures.

    Testing:
    Run:
    - mise exec -- npm run build:daemon
    - mise exec -- npm test -- --fresh tests/daemon-api/websocket-protocol.test.ts
    - mise exec -- npm test -- --fresh tests/daemon-build.test.ts
    - mise exec -- npm test -- --fresh tests/cli-serve.test.ts tests/cli-no-daemon.test.ts

    Covers: @daemon-backed-test-fixture-contract
    ac-real-daemon-tests-use-shared-fixture, ac-isolated-home-config,
    ac-isolated-project-data, ac-scoped-cleanup, ac-readiness-diagnostics,
    ac-bounded-readiness, ac-no-ambient-daemon-control;
    @daemon-test-endpoint-consistency ac-resolved-endpoint-source,
    ac-no-localhost-by-default, ac-http-ws-same-endpoint,
    ac-dynamic-port-propagation; @daemon-test-runtime-selection ac-node-default,
    ac-explicit-runtime-only, ac-runtime-matrix-parity,
    ac-missing-optional-runtime-skips, ac-runtime-degradation-assertions;
    @daemon-test-mode-boundaries ac-cli-lifecycle-tests-use-cli-path,
    ac-full-process-tests-use-real-daemon.

- title: Migrate Playwright daemon setup to the shared fixture core
  slug: task-migrate-playwright-daemon-fixture
  priority: 2
  tags: [testing, daemon, e2e, web-ui]
  spec_ref: "@e2e-test-daemon-isolation"
  depends_on:
    - "@task-implement-shared-daemon-test-fixture"
  description: |
    Update the Playwright daemon fixture to reuse the same daemon setup core as
    Vitest real-daemon process tests.

    Why: tests/e2e/fixtures/test-base.ts already has better runtime-awareness
    than the websocket Vitest test, but it still duplicates port selection,
    environment preparation, readiness, endpoint propagation, and teardown
    logic. Playwright should be a wrapper around the shared daemon fixture, not
    a separate fixture implementation that can drift.

    What:
    - Refactor tests/e2e/fixtures/test-base.ts so daemon startup, runtime
      resolution, environment isolation, endpoint construction, readiness, and
      teardown come from the shared daemon fixture core.
    - Preserve Playwright-specific fixture values such as page base URL,
      worker-scoped lifetime, browser context integration, and any current web
      UI setup required by existing e2e tests.
    - Ensure browser navigation and API calls use the fixture-provided endpoint
      rather than reconstructing localhost or port strings.
    - Keep Node as the default runtime and preserve the existing
      KSPEC_TEST_RUNTIME opt-in behavior through the shared runtime resolver.
    - Update AC annotations in Playwright fixture tests to the rewritten
      @e2e-test-daemon-isolation AC IDs and the new endpoint/runtime specs.

    How:
    Extract runtime-independent daemon setup into tests/helpers/daemon.ts first.
    In Playwright, wrap that core in test.extend fixtures instead of importing
    Vitest-only APIs. If Playwright requires worker-scoped cleanup semantics,
    add a small adapter that registers cleanup with Playwright teardown while
    keeping daemon process ownership in the core helper.

    Testing:
    Run a representative e2e slice that exercises daemon-backed browser flows,
    then run the full e2e command if the focused slice passes:
    - mise exec -- npm run test:e2e -- tests/e2e/api-websocket.spec.ts tests/e2e/connection.spec.ts
    - mise exec -- npm run test:e2e

    Covers: @e2e-test-daemon-isolation ac-uses-shared-fixture,
    ac-browser-endpoint-from-fixture, ac-isolated-e2e-state,
    ac-e2e-scoped-cleanup, ac-dynamic-port-propagation;
    @daemon-backed-test-fixture-contract ac-real-daemon-tests-use-shared-fixture,
    ac-isolated-home-config, ac-isolated-project-data, ac-scoped-cleanup,
    ac-readiness-diagnostics, ac-bounded-readiness, ac-no-ambient-daemon-control;
    @daemon-test-endpoint-consistency ac-resolved-endpoint-source,
    ac-no-localhost-by-default, ac-dynamic-port-propagation;
    @daemon-test-runtime-selection ac-node-default.

- title: Standardize mock daemon client fixtures
  slug: task-standardize-mock-daemon-client-fixtures
  priority: 3
  tags: [testing, daemon, cli, mock]
  spec_ref: "@daemon-test-mode-boundaries"
  depends_on:
    - "@task-implement-shared-daemon-test-fixture"
  description: |
    Centralize mock daemon setup for CLI client and endpoint-routing tests.

    Why: Tests that only verify client routing do not need a real daemon, but
    their mocks must still write realistic daemon metadata and use canonical
    endpoint formatting. Today mock daemon startup, request recording, endpoint
    formatting, PID/port metadata, and cleanup are duplicated across several
    files.

    What:
    - Add a shared mock daemon helper, either in tests/helpers/daemon.ts or a
      sibling tests/helpers/mock-daemon.ts.
    - Support HTTP mock daemon modes currently covered by
      tests/helpers/mock-daemon.cjs and tests/helpers/recording-daemon.cjs:
      normal response, error response, hang/timeout behavior, request recording,
      configurable bind host, and JSON first-line port reporting.
    - Provide a helper that writes canonical daemon.connection.json metadata
      into an IsolatedKspecHome using src/daemon-shared/endpoint.ts helpers.
    - Add focused mock-helper contract tests, for example
      tests/helpers/mock-daemon.test.ts, for metadata writing, request
      recording, error/hang modes, endpoint formatting, and cleanup. These
      tests should validate the mock fixture directly instead of relying only on
      CLI client consumer tests.
    - Migrate duplicate mock setup in:
      - tests/cli-daemon-proxy.test.ts
      - tests/cli-daemon-endpoint-regression.test.ts
      - tests/cli-task-event-endpoint.test.ts
      - tests/daemon-status-endpoint.test.ts
      - any other CLI client test that starts a mock daemon or manually writes
        daemon connection metadata.
    - Preserve tests that intentionally verify legacy daemon.port fallback;
      those tests should use an explicit legacy-metadata helper so the fallback
      case is visible.
    - Update AC annotations to @daemon-test-mode-boundaries,
      @daemon-test-endpoint-consistency, @trait-daemon-endpoint-consumer, and
      @daemon-network-endpoint-contract where appropriate.

    How:
    Keep mock daemon tests as child-process mocks when the kspec CLI is invoked
    with spawnSync, because an in-process server cannot accept requests while
    spawnSync blocks the test runner event loop. Factor the process management,
    request recording, metadata writing, and cleanup into shared helpers rather
    than changing the concurrency model.

    Testing:
    Run:
    - mise exec -- npm test -- --fresh tests/helpers/mock-daemon.test.ts
    - mise exec -- npm test -- --fresh tests/cli-daemon-proxy.test.ts
    - mise exec -- npm test -- --fresh tests/cli-daemon-endpoint-regression.test.ts
    - mise exec -- npm test -- --fresh tests/cli-task-event-endpoint.test.ts tests/daemon-status-endpoint.test.ts

    Covers: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon;
    @daemon-test-endpoint-consistency ac-resolved-endpoint-source,
    ac-mock-metadata-fidelity, ac-dynamic-port-propagation;
    @trait-daemon-endpoint-consumer ac-uses-reported-endpoint,
    ac-wildcard-not-destination; @daemon-network-endpoint-contract
    ac-tests-use-resolved-endpoint; @daemon-test-harness-guardrails
    ac-fixture-contract-tests-run.

- title: Standardize in-process daemon API fixtures
  slug: task-standardize-in-process-daemon-api-fixtures
  priority: 3
  tags: [testing, daemon, api]
  spec_ref: "@daemon-test-mode-boundaries"
  depends_on:
    - "@task-implement-shared-daemon-test-fixture"
  description: |
    Align in-process daemon API tests on shared app-handle and project fixture
    helpers without converting them to child-process daemon tests.

    Why: Most tests under tests/daemon-api already use tests/daemon-api/helpers.ts,
    but older top-level daemon API and review tests still duplicate request
    construction and fixture setup. These tests should remain fast in-process
    tests, but their fixture setup should be standardized so they do not drift
    from route-helper conventions.

    What:
    - Audit tests/daemon-api/*.test.ts and top-level daemon API/review tests
      such as tests/daemon-review-websocket.test.ts and
      tests/daemon-review-verdicts-api.test.ts.
    - Extend tests/daemon-api/helpers.ts only where necessary to cover common
      in-process needs: project fixture setup, app creation with disabled
      watchers, request construction, JSON response parsing, and broadcast
      capture helpers for websocket-related route side effects.
    - Add or update focused tests in tests/daemon-api/helpers.test.ts for any
      new in-process helper behavior so route-level consumer tests are not the
      only validation surface.
    - Migrate duplicate makeRequest, setupFixtures, and temporary project setup
      code to the shared in-process helpers.
    - Do not convert handler-level tests to real daemon process tests unless the
      behavior under test requires a process boundary, runtime adapter, cache
      readiness, lifecycle metadata, or an actual WebSocket network connection.
    - Keep direct use of app.handle for route behavior where that is sufficient.
    - Update AC annotations to @daemon-test-mode-boundaries and the relevant
      daemon API product specs after migration.

    How:
    Start with one representative top-level duplicate test and make the helper
    API adequate for it. Then migrate similar files mechanically. Preserve test
    data values and expected API responses exactly unless an existing assertion
    is proven stale by the current product spec.

    Testing:
    Run:
    - mise exec -- npm test -- --fresh tests/daemon-api/helpers.test.ts
    - mise exec -- npm test -- --fresh tests/daemon-api/server.test.ts tests/daemon-api/tasks.test.ts
    - mise exec -- npm test -- --fresh tests/daemon-review-websocket.test.ts tests/daemon-review-verdicts-api.test.ts

    Covers: @daemon-test-mode-boundaries ac-in-process-route-tests-no-child-process;
    @daemon-test-harness-guardrails ac-fixture-contract-tests-run.

- title: Enforce daemon test fixture usage with guardrails
  slug: task-enforce-daemon-test-fixture-usage
  priority: 4
  tags: [testing, lint, daemon]
  spec_ref: "@daemon-test-harness-guardrails"
  depends_on:
    - "@task-migrate-real-daemon-vitest-tests"
    - "@task-migrate-playwright-daemon-fixture"
    - "@task-standardize-mock-daemon-client-fixtures"
  description: |
    Update static guardrails so new daemon tests use the shared helpers instead
    of reintroducing bespoke process startup or unsafe daemon cleanup.

    Why: The repository already has tests for a no-leaky-test-daemon lint rule,
    but the rule is not tied to a spec AC and it focuses on cleanup rather than
    standard fixture usage. After migration, the guardrail should encode the new
    standard so future tests do not drift back to direct daemon spawns,
    hardcoded Bun startup, detached serve commands without scoped cleanup, or
    localhost URL construction.

    What:
    - Add or update a daemon test guardrail rule so test files outside approved
      helper implementations are flagged when they:
      - spawn dist/daemon/index.js directly;
      - call kspec serve start --detach without a shared scoped cleanup helper;
      - hardcode spawn("bun") for a daemon process outside a runtime-specific
        parity test;
      - construct daemon HTTP or WebSocket URLs from localhost plus a raw port
        outside endpoint-contract unit tests.
    - Allow the shared daemon fixture implementation, mock daemon helper
      implementation, and explicit lint-rule fixture strings to contain the
      otherwise flagged patterns.
    - Require any intentional exception to be documented locally in the test
      file with a narrow reason that names the behavior under test.
    - Update tests/lint-no-leaky-test-daemon.test.ts or add a new lint test file
      so the guardrail behavior has AC annotations for
      @daemon-test-harness-guardrails.
    - Ensure the rule does not flag pure unit tests that use app.handle or
      endpoint-contract tests that intentionally assert URL formatting.

    How:
    Reuse the existing no-leaky-test-daemon rule if extending it keeps the rule
    understandable. If the new checks would make that rule too broad, create a
    separate daemon-test-fixture guardrail rule with focused tests. Keep
    allowlists path-based and minimal.

    Testing:
    Run the lint-rule tests with mise exec -- npm test -- --fresh
    tests/lint-no-leaky-test-daemon.test.ts and any new guardrail test file.
    Then run the repository lint command used by package scripts if present.

    Covers: @daemon-test-harness-guardrails ac-direct-daemon-spawn-flagged,
    ac-detached-serve-without-cleanup-flagged, ac-helper-internals-allowed,
    ac-exceptions-are-localized.

- title: Validate daemon fixture standardization across the suite
  slug: task-validate-daemon-test-fixture-standardization
  priority: 5
  tags: [testing, daemon, validation]
  spec_ref: "@daemon-backed-test-fixture-contract"
  depends_on:
    - "@task-enforce-daemon-test-fixture-usage"
    - "@task-standardize-in-process-daemon-api-fixtures"
  description: |
    Run final validation for the daemon test fixture standardization plan and
    document any intentionally deferred exceptions.

    Why: This plan spans real daemon tests, Playwright fixtures, mock daemon
    tests, in-process daemon API helpers, specs, and guardrails. A final pass is
    needed to catch inconsistent runtime defaults, endpoint construction,
    readiness diagnostics, cleanup behavior, stale AC annotations, and accidental
    broadening of test scope.

    What:
    - Run a source audit over tests/ for daemon process startup, mock daemon
      startup, getAvailablePort, localhost daemon URLs, daemon.connection.json
      writes, waitForStartup usage, and direct dist/daemon/index.js references.
    - Confirm each remaining occurrence is either inside the shared helper,
      inside a focused endpoint/runtime unit test, inside lint-rule fixture
      strings, or documented as a local exception.
    - Run kspec validate --refs --warnings-ok and fix any stale refs introduced
      by rewritten AC IDs or new annotations.
    - Run focused test slices for fixture helper contracts, real daemon, mock
      daemon, in-process API, lint guardrail, and Playwright fixture coverage.
    - Confirm helper contract test files exist for each changed helper category
      so migrated product-flow tests are not the only evidence for the testing
      infrastructure specs.
    - Run the full Vitest suite with mise exec -- npm test -- --fresh after the
      focused slices pass.
    - If the full Playwright suite is too slow or environment-bound for the
      worker, run the representative Playwright slice and add a task note with
      the exact command, result, and reason full e2e was deferred.

    How:
    Use ripgrep or equivalent source searches for the audit, but apply fixes in
    source files with targeted edits. Do not manually edit .kspec YAML. Keep any
    exception list short and tied to named test behavior.

    Testing:
    Required commands:
    - mise exec -- npm run build:daemon
    - mise exec -- npm test -- --fresh tests/helpers/daemon.test.ts tests/helpers/mock-daemon.test.ts
    - mise exec -- npm test -- --fresh tests/daemon-api/websocket-protocol.test.ts tests/daemon-build.test.ts
    - mise exec -- npm test -- --fresh tests/cli-daemon-proxy.test.ts tests/cli-daemon-endpoint-regression.test.ts tests/cli-task-event-endpoint.test.ts tests/daemon-status-endpoint.test.ts
    - mise exec -- npm test -- --fresh tests/daemon-api/helpers.test.ts tests/daemon-api/server.test.ts tests/daemon-api/tasks.test.ts
    - mise exec -- npm test -- --fresh tests/lint-no-leaky-test-daemon.test.ts
    - mise exec -- npm test -- --fresh
    - mise exec -- npm run test:e2e -- tests/e2e/api-websocket.spec.ts tests/e2e/connection.spec.ts

    Covers: verification for @daemon-backed-test-fixture-contract,
    @daemon-test-endpoint-consistency, @daemon-test-runtime-selection,
    @daemon-test-mode-boundaries, @daemon-test-harness-guardrails
    ac-fixture-contract-tests-run, @daemon-sensitive-cli-test-determinism
    ac-fixture-contract-tests, @e2e-test-daemon-isolation, and
    @daemon-network-endpoint-contract ac-tests-use-resolved-endpoint.
```

## Implementation Notes

This plan is a test-infrastructure hardening plan. It intentionally separates
fixture categories rather than forcing every daemon-related test into the same
runtime mode:

- Real daemon process tests use the new shared daemon fixture because they
  exercise child process startup, runtime adapters, lifecycle state, cache
  readiness, or actual WebSocket network behavior.
- Playwright tests wrap the same daemon fixture core because browser URL and
  daemon endpoint propagation must match Vitest daemon-backed tests.
- CLI client routing tests use mock daemons because the CLI is often invoked
  with spawnSync, which blocks the test runner event loop and requires a child
  process mock to accept requests.
- In-process daemon API tests keep using app.handle because they are fast route
  tests and should not gain process-lifecycle flakiness.

The plan validates testing-related specs through three separate evidence types:
focused contract tests for the helper APIs, representative consumer tests that
prove migrated daemon flows still work, and static source-audit guardrails for
repo-wide structural rules that runtime tests cannot prove by themselves. Helper
contract tests are required for changed real-daemon, mock-daemon, and in-process
helper behavior so a fixture regression fails close to the fixture instead of
surfacing only as a broad product-flow failure.

The first task is intentionally a concrete spec-update task. It rewrites two
existing test specs whose scope is too narrow and adds one endpoint-contract AC
that makes test endpoint behavior explicit. Agents implementing that task must
use kspec CLI commands rather than editing .kspec YAML directly.

The plan does not require immediate elimination of every ephemeral port probe.
The shared helper may initially centralize the current dynamic-port approach if
using daemon --port 0 plus metadata readback is too large for this slice. Once
centralized, the port allocation strategy can be replaced in one helper without
migrating tests again.
