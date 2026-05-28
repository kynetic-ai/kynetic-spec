# Daemon Test Fixture Hardening

## Specs

```yaml
- title: Daemon Test Startup Failure Hygiene
  slug: daemon-test-startup-failure-hygiene
  type: requirement
  parent: "@daemon-server"
  description: |
    Test fixtures that start daemon-like child processes fail safely when
    startup does not reach readiness. Startup failures produce bounded
    diagnostics for the attempted child, and any child process already owned by
    the fixture is stopped before the helper returns failure to the caller.
  acceptance_criteria:
    - id: ac-process-launch-failure-diagnosed
      given: |
        A daemon test fixture attempts to start a child process
      when: |
        The operating system or runtime rejects the process launch
      then: |
        The caller receives a bounded startup diagnostic for that attempt
    - id: ac-owned-child-stopped-after-startup-failure
      given: |
        A daemon test fixture has obtained a child process handle
      when: |
        Startup fails before the fixture reports readiness
      then: |
        The fixture stops the child process before returning failure
    - id: ac-child-env-sanitized
      given: |
        A daemon test helper starts a child process for daemon-backed behavior
      when: |
        The helper builds the child process environment
      then: |
        Ambient daemon-control and session variables are not inherited
    - id: ac-cleanup-registered-before-readiness-wait
      given: |
        A wrapper starts a fixture-owned daemon process
      when: |
        The wrapper receives a cleanup registration hook
      then: |
        Cleanup is registered before the readiness wait can fail

- title: Daemon Test Guardrail Precision
  slug: daemon-test-guardrail-precision
  type: requirement
  parent: "@daemon-test-harness-guardrails"
  description: |
    Static guardrails report daemon-test patterns that can leak daemon
    processes or bypass the shared fixture, while avoiding reports for
    unrelated subprocesses that only happen to contain similar argument words.
    Cleanup-based exceptions are accepted only when cleanup is associated with
    the daemon that was just started before the test makes later observations.
  acceptance_criteria:
    - id: ac-direct-daemon-entry-invocations-flagged
      given: |
        A test invokes the real daemon entrypoint directly outside an approved helper
      when: |
        The guardrail scans the test file
      then: |
        The direct daemon startup is reported
    - id: ac-detached-cleanup-before-observation
      given: |
        A test starts a detached daemon through the kspec CLI
      when: |
        The test performs later awaits, assertions, or daemon observations before registering cleanup for that daemon
      then: |
        The detached daemon startup is reported
    - id: ac-unrelated-subprocesses-not-reported
      given: |
        A test starts a subprocess that is not a kspec daemon command
      when: |
        The subprocess arguments contain words also used by daemon lifecycle commands
      then: |
        The daemon guardrail does not report the subprocess
    - id: ac-local-exception-is-local
      given: |
        A test intentionally violates a daemon guardrail for behavior under test
      when: |
        The test suppresses the guardrail
      then: |
        The suppression is local to the violating statement
    - id: ac-exception-reason-states-subject
      given: |
        A test intentionally suppresses a daemon guardrail
      when: |
        The guardrail suppression is reviewed
      then: |
        The suppression states the behavior being exercised

- title: CLI Lifecycle Test Endpoint Consumption
  slug: cli-lifecycle-test-endpoint-consumption
  type: requirement
  parent: "@daemon-test-endpoint-consistency"
  description: |
    CLI lifecycle tests may start and stop the daemon through the CLI when the
    lifecycle command is the behavior under test. Once a CLI-started daemon has
    reported a client endpoint, lifecycle tests that make HTTP or WebSocket
    requests use that reported endpoint instead of constructing a localhost URL
    from a port number.
  acceptance_criteria:
    - id: ac-cli-started-daemon-requests-use-reported-endpoint
      given: |
        A CLI lifecycle test starts a daemon and the daemon reports a client endpoint
      when: |
        The test makes an HTTP or WebSocket request to that daemon
      then: |
        The request uses the reported client endpoint
    - id: ac-direct-loopback-url-exception-is-endpoint-subject
      given: |
        A CLI lifecycle test constructs a loopback daemon URL directly
      when: |
        The test is reviewed by guardrails or humans
      then: |
        The direct URL construction is tied to endpoint reporting, endpoint fallback, or missing-metadata behavior under test
    - id: ac-lifecycle-helper-resolves-client-endpoint
      given: |
        A CLI lifecycle test needs to call a daemon that was started through the CLI
      when: |
        A reported endpoint is available in daemon lifecycle state
      then: |
        Shared test code resolves a client endpoint for the test

- title: In-Process Daemon Test Helper Boundary
  slug: in-process-daemon-test-helper-boundary
  type: requirement
  parent: "@daemon-test-mode-boundaries"
  description: |
    In-process daemon API test helpers advertise the route and dependency
    boundary they provide. Tests that need full production-server behavior do
    not rely on a helper that only assembles a narrower route subset.
  acceptance_criteria:
    - id: ac-helper-scope-is-explicit
      given: |
        A shared in-process daemon API helper is available to tests
      when: |
        A test author reads or calls the helper
      then: |
        The helper states the server behavior boundary it represents
    - id: ac-test-uses-helper-matching-behavior
      given: |
        An in-process daemon API test relies on shared route or dependency behavior
      when: |
        The test chooses a helper
      then: |
        The helper boundary covers the behavior asserted by the test
```


## Tasks

derive_from_specs: false

```yaml
- title: Add guardrail regression tests for precise daemon classification
  slug: task-add-guardrail-classification-regressions
  priority: 1
  tags: [testing, lint, daemon]
  spec_ref: "@daemon-test-guardrail-precision"
  description: |
    What:
    - Extend `tests/lint-daemon-test-guardrails.test.ts` and, where the
      existing older suite is the better home, `tests/lint-no-leaky-test-daemon.test.ts`.
    - Add failing-before-fix tests proving the guardrail reports direct daemon
      entrypoint invocation through child-process APIs beyond the current
      `spawn`/`spawnSync` happy path. Include at least `fork("dist/daemon/index.js", ...)`
      and one exec-file style invocation that starts the daemon entrypoint.
    - Add a negative test proving a non-kspec subprocess such as a harmless
      command with arguments containing `serve`, `start`, and `--detach` is not
      reported as a daemon lifecycle violation.
    - Keep synthetic source snippets self-contained and avoid requiring a real
      daemon process.

    Why:
    The guardrail currently has bypasses and false positives that make it less
    trustworthy as repo-wide evidence for daemon test fixture usage. Capturing
    those cases first prevents an implementation from silently weakening the
    rule while making it pass existing examples.

    How:
    - Use the existing `runOxlint` test helper in
      `tests/lint-daemon-test-guardrails.test.ts` for synthetic files.
    - Anchor tests with `// AC:` comments for
      @daemon-test-guardrail-precision and the existing
      @daemon-test-harness-guardrails ACs they support.
    - Assert on both exit code and the relevant rule message so that a generic
      parser failure cannot satisfy the test.

    Testing:
    - First run the new test cases and observe they fail against the current
      rule.
    - After the implementation task, run:
      `mise exec -- npm test -- --fresh tests/lint-daemon-test-guardrails.test.ts tests/lint-no-leaky-test-daemon.test.ts`.

    Covers: @daemon-test-guardrail-precision ac-direct-daemon-entry-invocations-flagged,
    ac-unrelated-subprocesses-not-reported; @daemon-test-harness-guardrails
    ac-direct-daemon-spawn-flagged

- title: Fix guardrail daemon command classification
  slug: task-fix-guardrail-daemon-command-classification
  priority: 1
  tags: [testing, lint, daemon]
  spec_ref: "@daemon-test-guardrail-precision"
  depends_on:
    - "@task-add-guardrail-classification-regressions"
  description: |
    What:
    - Update `tools/eslint-rules/no-leaky-test-daemon.js` so direct daemon
      entrypoint detection applies to every child-process API that can launch
      the daemon entrypoint, including `fork` and exec-file style calls.
    - Update detached-serve detection so it is tied to a kspec daemon lifecycle
      command rather than any subprocess whose arguments contain the words
      `serve`, `start`, and `--detach`.
    - Preserve existing allowlisted helper paths for the shared daemon fixture,
      mock helper internals, and guardrail fixture-string tests.

    Why:
    A static guardrail is only useful if it reports the daemon-starting patterns
    it claims to guard and avoids training contributors to ignore false
    positives. This task makes the classifier match daemon behavior rather than
    incidental token sequences.

    How:
    - Refactor the rule into small predicate helpers for direct daemon entry
      launch, kspec lifecycle CLI launch, and approved helper paths.
    - For `fork`, inspect the first module path argument as the daemon entry
      candidate.
    - For exec-file style calls, inspect the executable and argv together so a
      direct daemon entrypoint and `kspec serve start --detach` are both covered
      without matching unrelated executables.
    - Keep the test-facing error messages actionable and specific to the
      matched violation.

    Testing:
    - Run:
      `mise exec -- npm test -- --fresh tests/lint-daemon-test-guardrails.test.ts tests/lint-no-leaky-test-daemon.test.ts`.
    - Run `mise exec -- npm run lint` or the project lint command that invokes
      oxlint, if available.
    - Run a source audit for remaining direct daemon entrypoint starts outside
      the approved helper/test-fixture strings and document any intentional
      exceptions.

    Covers: @daemon-test-guardrail-precision ac-direct-daemon-entry-invocations-flagged,
    ac-unrelated-subprocesses-not-reported; @daemon-test-harness-guardrails
    ac-direct-daemon-spawn-flagged, ac-helper-internals-allowed

- title: Add guardrail regression tests for detached cleanup timing
  slug: task-add-detached-cleanup-timing-regressions
  priority: 1
  tags: [testing, lint, daemon]
  spec_ref: "@daemon-test-guardrail-precision"
  description: |
    What:
    - Add guardrail tests for detached daemon starts where cleanup exists
      somewhere in the file but is not registered for the just-started daemon
      before later awaits, assertions, or daemon observations.
    - Include a regression case where an `afterEach` hook exists but the test
      assigns the PID only after an assertion or awaited observation.
    - Include an allowed case where the test captures the PID or child handle
      and registers scoped cleanup immediately after the detached start returns.
    - Include suppression tests proving a guardrail disable must be local to the
      violating statement and must state the behavior being exercised.
    - Keep the allowed case narrow; do not make a broad `afterEach` hook alone
      sufficient evidence of safe cleanup.

    Why:
    The rule currently treats some file-level cleanup patterns as enough even
    when an assertion between startup and PID capture can still leak the daemon.
    The plan goal is deterministic daemon cleanup, not merely cleanup-shaped
    code somewhere nearby.

    How:
    - Use synthetic snippets in `tests/lint-daemon-test-guardrails.test.ts`.
    - Model the unsafe sequence as `serve start --detach`, then `await` or
      `expect`, then PID capture or assignment.
    - Model the safe sequence as startup, immediate PID capture, immediate
      `onTestFinished`/`afterEach`-backed cleanup registration, then later
      awaits/assertions.

    Testing:
    - First run the new cases and observe the unsafe case fails to be reported
      against the current rule.
    - After the implementation task, run:
      `mise exec -- npm test -- --fresh tests/lint-daemon-test-guardrails.test.ts tests/lint-no-leaky-test-daemon.test.ts`.

    Covers: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation, ac-local-exception-is-local,
    ac-exception-reason-states-subject; @daemon-test-harness-guardrails
    ac-detached-serve-without-cleanup-flagged, ac-exceptions-are-localized

- title: Fix guardrail detached cleanup timing analysis
  slug: task-fix-detached-cleanup-timing-analysis
  priority: 1
  tags: [testing, lint, daemon]
  spec_ref: "@daemon-test-guardrail-precision"
  depends_on:
    - "@task-add-detached-cleanup-timing-regressions"
    - "@task-fix-guardrail-daemon-command-classification"
  description: |
    What:
    - Update `tools/eslint-rules/no-leaky-test-daemon.js` so detached daemon
      starts are considered safe only when scoped cleanup is registered before
      later awaits, assertions, or daemon observations can run.
    - Stop treating the mere presence of an ancestor `afterEach` hook as proof
      that the newly-started detached daemon is protected.
    - Preserve and, where needed, tighten support for local disable comments so
      each accepted suppression applies only to the violating statement and
      states the behavior under test.

    Why:
    A detached daemon can leak if a test fails between startup and cleanup
    registration. The guardrail should prevent that exact ordering bug instead
    of allowing it because cleanup appears elsewhere in the file.

    How:
    - Reuse or extend the rule's existing statement-order scan instead of
      introducing a second independent traversal.
    - Treat cleanup registration as valid only when it appears in the same test
      control flow before the next awaited operation, expectation, or daemon
      request, unless the statement itself is a local documented exception.
    - Keep helper internals and dedicated guardrail fixture strings allowlisted.

    Testing:
    - Run:
      `mise exec -- npm test -- --fresh tests/lint-daemon-test-guardrails.test.ts tests/lint-no-leaky-test-daemon.test.ts`.
    - Run a targeted source audit of `tests/cli-serve.test.ts` for detached
      startup cases and confirm every remaining exception is local and
      behavior-specific.

    Covers: @daemon-test-guardrail-precision ac-detached-cleanup-before-observation, ac-local-exception-is-local,
    ac-exception-reason-states-subject; @daemon-test-harness-guardrails
    ac-detached-serve-without-cleanup-flagged, ac-exceptions-are-localized

- title: Add real daemon fixture startup-failure contract tests
  slug: task-add-real-daemon-startup-failure-tests
  priority: 1
  tags: [testing, daemon]
  spec_ref: "@daemon-test-startup-failure-hygiene"
  description: |
    What:
    - Extend `tests/helpers/daemon.test.ts` with focused contract tests for
      real daemon fixture failure paths.
    - Cover process launch failure from an unavailable runtime or invalid
      executable path without relying on a real missing system dependency.
    - Cover readiness failure after a child handle exists and assert the child
      is stopped before the helper returns or throws.
    - Cover the wrapper cleanup registration ordering by using a synthetic
      `registerCleanup` hook that records whether cleanup was registered before
      readiness failure completed.
    - Update or add real-fixture environment contract coverage so ambient
      daemon-control and session variables are stripped from the real daemon
      child environment, with `// AC:` annotations for the new startup hygiene
      AC.

    Why:
    The existing happy-path and readiness-timeout tests prove ordinary behavior,
    but they do not fully protect launch errors or cleanup registration order.
    These failure-path tests make the fixture contract explicit before code is
    changed.

    How:
    - Prefer dependency injection already available in `startTestDaemon` options;
      if the helper does not expose enough test seam, add the smallest internal
      test seam needed without changing consumer-facing fixture behavior.
    - Assert on `DaemonReadinessError` or the chosen diagnostic error type, and
      verify the error includes the attempted runtime and endpoint context.
    - Avoid using fixed sleep delays; use bounded polling or child exit events.

    Testing:
    - First run the new tests and observe the launch-error/cleanup-order case
      fail or expose the missing diagnostic.
    - After the implementation task, run:
      `mise exec -- npm test -- --fresh tests/helpers/daemon.test.ts`.

    Covers: @daemon-test-startup-failure-hygiene ac-process-launch-failure-diagnosed,
    ac-owned-child-stopped-after-startup-failure, ac-child-env-sanitized,
    ac-cleanup-registered-before-readiness-wait; @daemon-backed-test-fixture-contract
    ac-readiness-diagnostics, ac-scoped-cleanup, ac-no-ambient-daemon-control

- title: Fix real daemon fixture startup-failure handling
  slug: task-fix-real-daemon-startup-failure-handling
  priority: 1
  tags: [testing, daemon]
  spec_ref: "@daemon-test-startup-failure-hygiene"
  depends_on:
    - "@task-add-real-daemon-startup-failure-tests"
  description: |
    What:
    - Update `tests/helpers/daemon.ts` so child process `error` events are
      captured and converted into the same bounded diagnostic style used for
      readiness failures.
    - Ensure `startTestDaemon` stops any fixture-owned child when readiness or
      startup diagnostics fail after a child handle has been created.
    - Ensure callers that provide `registerCleanup` get cleanup registered as
      soon as the child is owned by the fixture, before any readiness wait can
      fail.

    Why:
    Startup failures should not bypass diagnostic handling or leave children
    behind. The shared real-daemon fixture is now the foundation for Vitest and
    Playwright daemon tests, so its failure paths need the same quality as its
    happy path.

    How:
    - Add an `error` listener immediately after spawning the child.
    - Race readiness polling against launch-error and early-exit signals, and
      normalize failures into a single diagnostic error shape.
    - Make `stop()` idempotent and safe to call from both registered cleanup and
      immediate failure cleanup.
    - Keep public helper fields stable unless a test-only internal seam was
      introduced by the previous task.

    Testing:
    - Run:
      `mise exec -- npm test -- --fresh tests/helpers/daemon.test.ts tests/daemon-api/websocket-protocol.test.ts tests/daemon-build.test.ts`.
    - Run a representative Playwright daemon fixture slice if available in the
      project scripts.

    Covers: @daemon-test-startup-failure-hygiene ac-process-launch-failure-diagnosed,
    ac-owned-child-stopped-after-startup-failure,
    ac-cleanup-registered-before-readiness-wait; @daemon-backed-test-fixture-contract
    ac-readiness-diagnostics, ac-scoped-cleanup

- title: Harden Playwright daemon fixture cleanup registration
  slug: task-harden-playwright-daemon-fixture-cleanup
  priority: 2
  tags: [testing, daemon, e2e]
  spec_ref: "@daemon-test-startup-failure-hygiene"
  depends_on:
    - "@task-fix-real-daemon-startup-failure-handling"
  description: |
    What:
    - Update `tests/e2e/fixtures/test-base.ts` so the Playwright wrapper passes
      a cleanup registration hook into the shared real-daemon fixture before
      readiness can fail.
    - Preserve the existing Playwright fixture behavior: tests receive the
      daemon context, browser URLs use the fixture endpoint, and teardown stops
      only the fixture-owned daemon.
    - Add or update the narrowest Playwright fixture test or fixture-level unit
      test that proves the wrapper registers cleanup through the shared fixture
      path.

    Why:
    The Playwright wrapper already uses the shared core, but setup failures
    should be protected by the same early cleanup registration guarantee that
    Vitest daemon tests can use.

    How:
    - Use the `registerCleanup` option exposed by `startTestDaemon` rather than
      duplicating daemon stop logic in the Playwright wrapper.
    - Keep the wrapper's final teardown idempotent so cleanup is safe if both
      early registration and normal fixture teardown run.
    - Avoid adding real browser work to a unit-level cleanup-order test unless
      a Playwright-specific behavior is being asserted.

    Testing:
    - Run the focused test added or updated for the wrapper cleanup behavior.
    - Run the representative Playwright daemon fixture slice used by the prior
      standardization validation.

    Covers: @daemon-test-startup-failure-hygiene ac-cleanup-registered-before-readiness-wait,
    ac-owned-child-stopped-after-startup-failure; @e2e-test-daemon-isolation
    ac-e2e-scoped-cleanup

- title: Add mock daemon helper failure-path contract tests
  slug: task-add-mock-daemon-failure-contract-tests
  priority: 1
  tags: [testing, daemon, mock]
  spec_ref: "@daemon-test-startup-failure-hygiene"
  description: |
    What:
    - Extend `tests/helpers/mock-daemon.test.ts` with focused failure-path
      coverage for `tests/helpers/mock-daemon.ts`.
    - Cover startup timeout or malformed first stdout line from the mock child,
      and assert no child process remains owned by the helper after failure.
    - Cover child environment construction and assert ambient daemon-control and
      session variables are not inherited by mock daemon children.
    - Keep tests deterministic by using the existing mock helper script or a
      small synthetic child script controlled by the test.

    Why:
    Mock daemon helpers are part of the standardized daemon test surface. If a
    mock child fails during startup, the helper must not leak the process or
    inherit ambient daemon state that can make CLI client tests nondeterministic.

    How:
    - Use bounded waits and process exit events, not arbitrary sleeps.
    - If a synthetic child script is needed, write it under a temp directory and
      register cleanup with the test framework.
    - Add `// AC:` annotations for the new startup hygiene spec and existing
      mock metadata specs where applicable.

    Testing:
    - First run the new tests and observe the failure path expose the current
      missing cleanup/env behavior.
    - After the implementation task, run:
      `mise exec -- npm test -- --fresh tests/helpers/mock-daemon.test.ts`.

    Covers: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure,
    ac-child-env-sanitized; @daemon-test-endpoint-consistency
    ac-mock-metadata-fidelity

- title: Fix mock daemon helper cleanup and environment hygiene
  slug: task-fix-mock-daemon-cleanup-env-hygiene
  priority: 1
  tags: [testing, daemon, mock]
  spec_ref: "@daemon-test-startup-failure-hygiene"
  depends_on:
    - "@task-add-mock-daemon-failure-contract-tests"
  description: |
    What:
    - Update `tests/helpers/mock-daemon.ts` so any child spawned during mock
      daemon startup is killed on timeout, malformed startup output, or startup
      failure before the helper returns failure to the caller.
    - Build mock child process environments through the same sanitized
      subprocess-env helper used by other test subprocesses, while preserving
      explicit test-provided environment overrides.
    - Keep mock daemon metadata fidelity unchanged: generated connection
      metadata must continue to round-trip through production endpoint helpers.

    Why:
    Mock daemon helpers should be safe substitutes for real daemon clients.
    Leaking a mock process or inheriting ambient daemon-control variables makes
    CLI routing tests nondeterministic and undermines the standardized fixture
    contract.

    How:
    - Add an idempotent internal child cleanup helper for startup-failure paths.
    - Ensure cleanup runs before resolving `null` or throwing from a startup
      helper.
    - Use the existing test subprocess environment utility instead of passing
      the parent process environment wholesale.

    Testing:
    - Run:
      `mise exec -- npm test -- --fresh tests/helpers/mock-daemon.test.ts tests/cli-daemon-proxy.test.ts tests/cli-daemon-endpoint-regression.test.ts tests/cli-task-event-endpoint.test.ts`.

    Covers: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure,
    ac-child-env-sanitized; @daemon-test-endpoint-consistency
    ac-mock-metadata-fidelity, ac-resolved-endpoint-source

- title: Resolve CLI lifecycle test daemon endpoints from reported metadata
  slug: task-resolve-cli-lifecycle-test-endpoints
  priority: 2
  tags: [testing, daemon, cli]
  spec_ref: "@cli-lifecycle-test-endpoint-consumption"
  depends_on:
    - "@task-fix-real-daemon-startup-failure-handling"
    - "@task-fix-detached-cleanup-timing-analysis"
  description: |
    What:
    - Update CLI lifecycle tests in `tests/cli-serve.test.ts` that start the
      daemon through `kspec serve start --detach` and then make HTTP requests to
      that daemon.
    - When daemon lifecycle metadata is available, resolve the client endpoint
      from that metadata or the same production endpoint helpers used by daemon
      clients instead of constructing `http://localhost:${port}` directly.
    - Keep direct loopback URL construction only in tests whose asserted
      behavior is endpoint reporting, endpoint fallback, legacy metadata
      compatibility, or missing-metadata behavior. Each remaining direct URL
      must have a local, behavior-specific guardrail suppression if the lint
      rule would otherwise flag it.
    - Do not convert CLI lifecycle tests to the shared daemon fixture when the
      behavior under test is `serve start`, `serve stop`, `serve status`, or
      `serve restart`; those tests must still exercise the CLI path.

    Why:
    The previous fixture standardization correctly preserved CLI lifecycle
    tests, but some of those tests still address the daemon with localhost URLs
    assembled from a port. That leaves the original hostname-resolution hazard
    in a high-value regression area. CLI lifecycle tests should use the daemon's
    reported endpoint once the CLI-started daemon has one.

    How:
    - Introduce a small helper in `tests/cli-serve.test.ts` or an existing test
      helper module that reads the isolated daemon connection metadata and
      returns an API base URL for the CLI-started daemon.
    - Prefer production endpoint parsing/formatting helpers over ad hoc string
      concatenation.
    - Replace applicable fetch calls currently shaped like
      ``fetch(`http://localhost:${port}/...`)`` with endpoint-derived URLs.
    - Audit every remaining `localhost:${port}` occurrence in
      `tests/cli-serve.test.ts` and document why each is endpoint-subject
      coverage rather than generic daemon access.

    Testing:
    - Run:
      `mise exec -- npm test -- --fresh tests/cli-serve.test.ts`.
    - Run the guardrail suites:
      `mise exec -- npm test -- --fresh tests/lint-daemon-test-guardrails.test.ts tests/lint-no-leaky-test-daemon.test.ts`.
    - Run a source audit for `localhost:${port}` in `tests/cli-serve.test.ts`
      and include the remaining intentional exceptions in the task notes.

    Covers: @cli-lifecycle-test-endpoint-consumption
    ac-cli-started-daemon-requests-use-reported-endpoint,
    ac-direct-loopback-url-exception-is-endpoint-subject,
    ac-lifecycle-helper-resolves-client-endpoint; @daemon-test-endpoint-consistency
    ac-resolved-endpoint-source, ac-no-localhost-by-default

- title: Clarify in-process daemon API helper boundary
  slug: task-clarify-in-process-daemon-api-helper-boundary
  priority: 2
  tags: [testing, daemon]
  spec_ref: "@in-process-daemon-test-helper-boundary"
  description: |
    What:
    - Update `tests/daemon-api/helpers.ts` so comments and exported helper
      names accurately describe the route/dependency boundary provided by the
      in-process daemon app helper.
    - If tests need a full production-server in-process helper, add it as a
      separate helper with explicit coverage. Otherwise, keep the existing
      helper narrow and state that it covers the common daemon API route subset
      used by current in-process tests.
    - Update existing in-process daemon API tests only where their helper choice
      or comments overclaim full production-server behavior.

    Why:
    A helper whose documentation says it registers all API routes can mislead
    future agents into using it for behavior that actually depends on production
    server wiring. The fixture boundary should be clear so tests choose the
    lightest correct mode without hiding missing dependencies.

    How:
    - Compare `tests/daemon-api/helpers.ts` with production route registration
      in `packages/daemon/src/server.ts`.
    - Prefer a documentation/export-name correction if current tests only need
      the common subset.
    - Add focused helper tests in `tests/daemon-api/helpers.test.ts` for any
      newly stated boundary behavior.

    Testing:
    - Run:
      `mise exec -- npm test -- --fresh tests/daemon-api/helpers.test.ts tests/daemon-api-input-validation.test.ts tests/daemon-review-verdicts-api.test.ts tests/daemon-review-websocket.test.ts`.

    Covers: @in-process-daemon-test-helper-boundary ac-helper-scope-is-explicit,
    ac-test-uses-helper-matching-behavior; @daemon-test-mode-boundaries
    ac-in-process-route-tests-no-child-process

- title: Validate daemon test hardening end to end
  slug: task-validate-daemon-test-hardening
  priority: 3
  tags: [testing, daemon, validation]
  spec_ref: "@daemon-test-startup-failure-hygiene"
  depends_on:
    - "@task-fix-guardrail-daemon-command-classification"
    - "@task-fix-detached-cleanup-timing-analysis"
    - "@task-fix-real-daemon-startup-failure-handling"
    - "@task-harden-playwright-daemon-fixture-cleanup"
    - "@task-fix-mock-daemon-cleanup-env-hygiene"
    - "@task-resolve-cli-lifecycle-test-endpoints"
    - "@task-clarify-in-process-daemon-api-helper-boundary"
  description: |
    What:
    - Run final focused and broad validation for the daemon test hardening
      follow-up.
    - Verify every new spec AC in this plan has truthful source or test
      coverage annotations.
    - Verify remaining guardrail suppressions and direct loopback URL
      constructions are local, behavior-specific exceptions.
    - Verify spec metadata alignment does not leave daemon testing specs with
      new status mismatches.

    Why:
    This plan intentionally splits hardening into small tasks so workers do not
    chase unrelated failures. A final validation task confirms the pieces compose
    and that no small task left a gap at the standardized test-fixture boundary.

    How:
    - Run the focused helper and guardrail suites first so failures point at the
      smallest surface.
    - Run the CLI lifecycle daemon suite after endpoint cleanup.
    - Run the project validation commands and record any warnings as pre-existing
      or introduced by this plan.
    - Use source audits for direct daemon entrypoint starts, detached lifecycle
      commands, `localhost:${port}` daemon requests, and guardrail disable
      comments. Classify every remaining hit.

    Required commands:
    - `mise exec -- kspec validate --refs --warnings-ok`
    - `mise exec -- kspec validate --alignment --warnings-ok`
    - `mise exec -- npm test -- --fresh tests/helpers/daemon.test.ts tests/helpers/mock-daemon.test.ts tests/daemon-api/helpers.test.ts`
    - `mise exec -- npm test -- --fresh tests/lint-daemon-test-guardrails.test.ts tests/lint-no-leaky-test-daemon.test.ts`
    - `mise exec -- npm test -- --fresh tests/cli-serve.test.ts tests/daemon-api/websocket-protocol.test.ts tests/daemon-build.test.ts`
    - Run the representative Playwright daemon fixture slice used by the prior
      daemon fixture standardization validation, or document the exact command
      and environmental reason if it is unavailable.

    Covers: @daemon-test-startup-failure-hygiene ac-process-launch-failure-diagnosed,
    ac-owned-child-stopped-after-startup-failure, ac-child-env-sanitized,
    ac-cleanup-registered-before-readiness-wait; @daemon-test-guardrail-precision
    ac-direct-daemon-entry-invocations-flagged, ac-detached-cleanup-before-observation,
    ac-unrelated-subprocesses-not-reported, ac-local-exception-is-local,
    ac-exception-reason-states-subject;
    @cli-lifecycle-test-endpoint-consumption ac-cli-started-daemon-requests-use-reported-endpoint,
    ac-direct-loopback-url-exception-is-endpoint-subject,
    ac-lifecycle-helper-resolves-client-endpoint; @in-process-daemon-test-helper-boundary
    ac-helper-scope-is-explicit, ac-test-uses-helper-matching-behavior
```

## Implementation Notes

This plan is a follow-up hardening slice for daemon test infrastructure after
shared daemon fixtures, mock daemon fixtures, Playwright fixture integration,
and guardrail suites already landed. The prior plan is complete; this plan owns
only the remaining hardening gaps listed here.

The work is intentionally split into small tasks. Regression-test tasks precede
rule or helper fixes where behavior is subtle, so agents can validate one gap at
a time instead of broadening scope while debugging.

Spec gaps identified by the audit:

- Startup failure hygiene was not explicitly specified for launch-error events,
  child cleanup after partial startup, mock child env sanitation, or wrapper
  cleanup registration before readiness waits. The new
  `@daemon-test-startup-failure-hygiene` requirement owns those behaviors.
- The existing guardrail specs required direct daemon starts and detached daemon
  starts to be reported, but did not specify classifier precision, immediate
  cleanup ordering, behavior-specific local suppressions, or non-daemon
  false-positive avoidance. The new
  `@daemon-test-guardrail-precision` requirement owns those behaviors.
- Existing endpoint consistency requirements covered fixture-provided endpoints,
  but CLI lifecycle tests have a special path where the CLI must start the
  daemon while subsequent HTTP requests should still use the daemon-reported
  client endpoint. The new `@cli-lifecycle-test-endpoint-consumption`
  requirement owns that behavior.
- In-process daemon API helper behavior needed an explicit boundary so a helper
  that registers a route subset is not mistaken for a full production server
  assembly. The new `@in-process-daemon-test-helper-boundary` requirement owns
  that behavior.

Known source surfaces for workers to inspect:

- `tools/eslint-rules/no-leaky-test-daemon.js`: daemon-start guardrail
  classifier and cleanup-order analysis.
- `tests/lint-daemon-test-guardrails.test.ts` and
  `tests/lint-no-leaky-test-daemon.test.ts`: synthetic guardrail regression
  suites.
- `tests/helpers/daemon.ts` and `tests/helpers/daemon.test.ts`: shared real
  daemon fixture and focused contract tests.
- `tests/e2e/fixtures/test-base.ts`: Playwright wrapper around the shared real
  daemon fixture.
- `tests/helpers/mock-daemon.ts` and `tests/helpers/mock-daemon.test.ts`: mock
  daemon helper and focused contract tests.
- `tests/cli-serve.test.ts`: CLI lifecycle tests that intentionally exercise
  `kspec serve start/stop/status/restart` and should not be blindly converted to
  the shared daemon fixture.
- `tests/daemon-api/helpers.ts` and `tests/daemon-api/helpers.test.ts`:
  in-process daemon API helper boundary.
- `packages/daemon/src/server.ts`: production route registration reference for
  comparing in-process helper scope.

Out of scope:

- Replacing CLI lifecycle tests with the shared daemon fixture when the CLI
  lifecycle command itself is the behavior under test.
- Redesigning production daemon endpoint selection or production daemon
  metadata semantics beyond what tests need to consume already-reported
  endpoints.
- Fixing unrelated pre-existing kspec completeness warnings or deprecated-ref
  warnings outside daemon testing specs.
```