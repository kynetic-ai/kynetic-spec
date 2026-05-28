# Daemon Test Cleanup Contract Hardening

## Specs

```yaml
- title: Daemon Test Teardown Boundedness
  slug: daemon-test-teardown-boundedness
  type: requirement
  parent: "@daemon-server"
  description: |
    Daemon-backed test infrastructure treats cleanup as a deterministic
    contract rather than a best-effort signal send. Fixtures, wrappers, and
    daemon lifecycle tests that own daemon processes or daemon-like mock
    children stop owned resources within bounded time, verify termination when
    cleanup reports success, and preserve the primary failure when cleanup also
    encounters an error.
  acceptance_criteria:
    - id: ac-stop-observes-termination-before-return
      given: |
        A daemon-backed test fixture or lifecycle helper owns a daemon process
        or daemon-like child process
      when: |
        Cleanup reports that the process has been stopped
      then: |
        The owned process has been observed terminated
    - id: ac-uncooperative-process-stop-is-bounded
      given: |
        A fixture-owned daemon process or daemon-like child ignores the initial
        termination request
      when: |
        Cleanup attempts to stop the owned process
      then: |
        Cleanup reaches a bounded terminal outcome
    - id: ac-active-requests-do-not-block-teardown
      given: |
        A daemon-like test server has an active request that does not complete
      when: |
        The helper stop operation runs
      then: |
        Teardown reaches a bounded terminal outcome
    - id: ac-setup-failure-cleans-owned-resources
      given: |
        Daemon test setup has created temporary project, home, port, or child
        resources
      when: |
        A later setup step fails before the fixture reports readiness
      then: |
        The resources already owned by the setup are cleaned up
    - id: ac-cleanup-errors-preserve-primary-failure
      given: |
        A daemon-backed test setup, test body, or readiness wait fails with a
        primary error
      when: |
        Cleanup also fails while handling that primary error
      then: |
        The surfaced failure preserves the primary error
    - id: ac-daemon-observations-are-bounded
      given: |
        A daemon-backed test or fixture probes a daemon HTTP or WebSocket
        endpoint
      when: |
        The endpoint accepts a connection but does not respond
      then: |
        The probe reaches a bounded terminal outcome
```

## Tasks

derive_from_specs: false

```yaml
- title: Tighten daemon guardrail cleanup semantics specs
  slug: task-tighten-daemon-guardrail-cleanup-semantics-specs
  priority: 1
  tags: [testing, lint, daemon, spec]
  spec_ref: "@daemon-test-guardrail-precision"
  description: |
    What:
    - Update the existing `@daemon-test-guardrail-precision` requirement with
      exact cleanup-effect and cleanup-boundary ACs so the guardrail contract
      cannot be satisfied by cleanup-shaped code that leaves a daemon alive.
    - Add `ac-cleanup-operation-terminates-daemon` with this behavioral shape:
      Given a test starts a detached daemon through a daemon lifecycle path;
      When the guardrail evaluates cleanup for that daemon; Then only cleanup
      operations that terminate or stop the daemon satisfy the cleanup
      requirement.
    - Add `ac-cleanup-probes-do-not-count` with this behavioral shape: Given a
      test starts a detached daemon and registers cleanup-shaped code; When the
      code only probes liveness, emits documentation text, calls a non-daemon
      helper, or sends a non-terminating signal; Then the detached daemon start
      is reported as missing scoped cleanup.
    - Add `ac-cleanup-helper-origin-is-trusted` with this behavioral shape:
      Given a test cleanup callback calls a helper by a daemon-cleanup-like
      name; When that helper is locally defined or otherwise not one of the
      approved cleanup primitives; Then the helper name alone does not satisfy
      daemon cleanup.
    - Add `ac-cleanup-registration-is-test-scoped` with this behavioral shape:
      Given a test starts a detached daemon; When cleanup is registered only on
      process-lifecycle or global shutdown hooks; Then that registration does
      not satisfy the per-test scoped cleanup requirement.
    - Add `ac-implicit-autostart-cleanup-before-observation` with this
      behavioral shape: Given a test invokes a CLI command that may implicitly
      auto-start a daemon and then observes the started daemon's pid, metadata,
      process, or endpoint; When the test performs later assertions or daemon
      observations before registering cleanup for that daemon; Then the unsafe
      auto-started daemon ownership is reported.
    - Set `@daemon-test-guardrail-precision` implementation status back to
      `in_progress` without cascading to unrelated specs.

    Why:
    The current guardrail precision spec covers ordering and binding, but it
    does not say that credited cleanup must actually terminate the daemon, must
    be trusted structurally, or must run at the current-test boundary. That
    under-specification allowed `process.kill(pid, 0)`, local no-op `killPid`,
    and `process.on("exit", ...)`-only cleanup to look compliant.

    How:
    - Use `kspec item ac add @daemon-test-guardrail-precision ...` for each new
      AC.
    - Use exact behavioral wording above; do not encode file names or internal
      AST predicate names in the spec ACs.
    - Run `mise exec -- kspec item get @daemon-test-guardrail-precision` and
      verify all new AC IDs are present once.
    - Run `mise exec -- kspec validate --refs --warnings-ok`.

    Testing:
    - `mise exec -- kspec item get @daemon-test-guardrail-precision`
    - `mise exec -- kspec validate --refs --warnings-ok`

    Covers: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon,
    ac-cleanup-probes-do-not-count, ac-cleanup-helper-origin-is-trusted,
    ac-cleanup-registration-is-test-scoped,
    ac-implicit-autostart-cleanup-before-observation

- title: Add adversarial guardrail regressions for cleanup effects
  slug: task-add-guardrail-cleanup-effect-regressions
  priority: 1
  tags: [testing, lint, daemon]
  spec_ref: "@daemon-test-guardrail-precision"
  depends_on:
    - "@task-tighten-daemon-guardrail-cleanup-semantics-specs"
  description: |
    What:
    - Extend `tests/lint-no-leaky-test-daemon.test.ts` and, where the newer
      harness is the better home, `tests/lint-daemon-test-guardrails.test.ts`
      with failing-before-fix regression cases for cleanup effect semantics.
    - Add rejected cases for `onTestFinished(() => process.kill(pid, 0))`,
      `process.kill(pid, "SIGUSR1")`, `process.kill(pid, "SIGCONT")`, and any
      other non-terminating or daemon-irrelevant signal literals the rule can
      statically identify.
    - Add rejected cases where a local no-op or unrelated helper named
      `killPid`, `stopDaemon`, or `stopMockDaemon` is called in a cleanup
      callback but does not invoke an approved terminating cleanup primitive.
    - Add accepted cases for `process.kill(pid)`, `process.kill(pid,
      "SIGTERM")`, `process.kill(pid, "SIGKILL")`, and project-approved stop
      helpers whose origin or body proves they stop the just-started daemon.
    - Add accepted and rejected cases for child-handle cleanup so
      `child.kill()` and `child.kill("SIGTERM")` are treated consistently with
      Node's terminating defaults while `child.kill("SIGUSR1")` remains
      rejected.
    - Keep each synthetic snippet self-contained and assert on the rule message
      instead of merely checking a non-zero parser exit.

    Why:
    The current rule accepts `process.kill(...)` by member-expression shape,
    regardless of signal. A liveness probe such as `process.kill(pid, 0)` proves
    the process exists but does not terminate it. Name-only helper recognition
    has the same failure shape: a local function named `killPid` can be a no-op.

    How:
    - Place tests near the existing cleanup-timing and cleanup-callback
      adversarial cases so future reviewers can compare accepted and rejected
      shapes.
    - Annotate each regression with the new `@daemon-test-guardrail-precision`
      AC it protects.
    - For helper-origin cases, include at least one locally defined no-op helper
      and one approved helper/import case so the implementation cannot solve
      the false negative by banning all helpers.

    Testing:
    - First run the new cases and observe they fail against the current rule.
    - After the implementation task, run:
      `mise exec -- npm test -- --fresh tests/lint-no-leaky-test-daemon.test.ts tests/lint-daemon-test-guardrails.test.ts`.

    Covers: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon,
    ac-cleanup-probes-do-not-count, ac-cleanup-helper-origin-is-trusted;
    @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged

- title: Fix guardrail cleanup-effect classification
  slug: task-fix-guardrail-cleanup-effect-classification
  priority: 1
  tags: [testing, lint, daemon]
  spec_ref: "@daemon-test-guardrail-precision"
  depends_on:
    - "@task-add-guardrail-cleanup-effect-regressions"
  description: |
    What:
    - Update `tools/eslint-rules/no-leaky-test-daemon.js` so cleanup credit is
      based on terminating daemon cleanup, not merely cleanup-shaped syntax.
    - For `process.kill(pid, signal)`, accept only missing/undefined signal or
      explicit terminating signals such as `SIGTERM`, `SIGKILL`, and `SIGINT`.
      Reject signal `0`, non-terminating signal literals, and unknown literal
      signals unless the rule has an explicit project reason to treat them as
      terminating.
    - For child-handle `.kill(...)`, align the accepted signal policy with
      `process.kill`: no signal and known terminating signals count;
      non-terminating or daemon-irrelevant signals do not count.
    - Stop treating bare helper names such as `killPid`, `stopDaemon`, or
      `stopMockDaemon` as sufficient when the helper is locally defined as a
      no-op or otherwise cannot be trusted. Either restrict recognition to
      approved imports/known helper paths or inspect the local helper body for a
      terminating daemon cleanup primitive.
    - Preserve accepted cleanup through `kspec serve stop` lifecycle commands
      and approved shared helper internals.

    Why:
    The guardrail is supposed to prove that tests do not leak daemon processes.
    A liveness probe, diagnostic signal, or local no-op helper does not stop the
    daemon and therefore cannot be an exception to the detached-start rule.

    How:
    - Refactor the cleanup classifier into separate predicates for terminating
      signals, trusted helper calls, child-handle cleanup, process PID cleanup,
      and CLI `serve stop` cleanup.
    - Keep the allowed signal list centralized and documented in the rule
      comment.
    - When local helper-body inspection is used, avoid counting recursive
      wrappers or helper names whose body does not contain an approved
      terminating cleanup call.
    - Keep current false-positive protections for string literals and
      non-daemon subprocesses.

    Testing:
    - `mise exec -- npm test -- --fresh tests/lint-no-leaky-test-daemon.test.ts tests/lint-daemon-test-guardrails.test.ts`
    - `mise exec -- npm run lint` or the repository lint command that invokes
      oxlint, if available and not blocked by unrelated pre-existing lint
      failures.

    Covers: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon,
    ac-cleanup-probes-do-not-count, ac-cleanup-helper-origin-is-trusted;
    @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged,
    ac-exceptions-are-localized

- title: Add adversarial guardrail regressions for cleanup boundaries
  slug: task-add-guardrail-cleanup-boundary-regressions
  priority: 1
  tags: [testing, lint, daemon]
  spec_ref: "@daemon-test-guardrail-precision"
  depends_on:
    - "@task-tighten-daemon-guardrail-cleanup-semantics-specs"
  description: |
    What:
    - Add failing-before-fix guardrail tests proving cleanup must be registered
      at a current-test cleanup boundary or in the same synchronous
      `try/finally` control flow that owns the daemon.
    - Add rejected cases where the only cleanup registration is
      `process.on("exit", ...)`, `process.on("beforeExit", ...)`,
      `process.on("SIGTERM", ...)`, `process.once(...)`, `afterAll(...)`, or
      another process/global lifecycle hook that can leave the daemon alive
      while later tests run.
    - Keep already-rejected cases for `beforeEach`, `beforeAll`, misplaced
      `afterEach`, callbacks assigned but never invoked, `Promise.finally`, and
      `queueMicrotask` covered and aligned with the new AC wording.
    - Add accepted cases for `onTestFinished(() => terminatingCleanup(...))` and
      direct `try/finally` finalizers that are already bound to the concrete
      daemon pid or stop handle before observations can fail.
    - Add a mixed case where a process-lifecycle fallback exists in addition to
      `onTestFinished`; the per-test cleanup should be what satisfies the
      guardrail, not the fallback.

    Why:
    Process-exit cleanup can be a last-resort safety net, but it is not scoped
    to the test that started the daemon. Treating it as sufficient lets the
    daemon survive subsequent tests and violates the fixture cleanup contract.

    How:
    - Update the existing process-on-exit allowed regression in
      `tests/lint-no-leaky-test-daemon.test.ts` so it becomes a rejected case
      under `ac-cleanup-registration-is-test-scoped`.
    - Keep the failure message actionable: direct the author to
      `onTestFinished` or `try/finally`, not merely to any cleanup callback.
    - Include comments explaining that process-lifecycle cleanup is allowed only
      as a supplemental fallback, not as the cleanup credit for the guardrail.

    Testing:
    - First run the new cases and observe the current `process.on("exit", ...)`
      allowed case fail the new expectation.
    - After the implementation task, run:
      `mise exec -- npm test -- --fresh tests/lint-no-leaky-test-daemon.test.ts tests/lint-daemon-test-guardrails.test.ts`.

    Covers: @daemon-test-guardrail-precision ac-cleanup-registration-is-test-scoped,
    ac-detached-cleanup-before-observation, ac-detached-cleanup-bound-before-observation;
    @daemon-test-harness-guardrails ac-detached-serve-without-cleanup-flagged

- title: Fix guardrail cleanup-boundary classification
  slug: task-fix-guardrail-cleanup-boundary-classification
  priority: 1
  tags: [testing, lint, daemon]
  spec_ref: "@daemon-test-guardrail-precision"
  depends_on:
    - "@task-add-guardrail-cleanup-boundary-regressions"
    - "@task-fix-guardrail-cleanup-effect-classification"
  description: |
    What:
    - Update `tools/eslint-rules/no-leaky-test-daemon.js` so process-lifecycle
      and global lifecycle hooks do not satisfy scoped cleanup for a daemon
      started inside a test.
    - Treat `onTestFinished` and same-flow `try/finally` finalizers as the
      primary accepted cleanup boundaries for detached daemon starts.
    - If a test also registers `process.on(...)` as a last-resort fallback, keep
      it allowed only when a valid per-test cleanup boundary is already present.
    - Update diagnostics and rule comments that currently describe
      `process.on("exit"|...)` as valid cleanup.

    Why:
    The guardrail should prevent a daemon from remaining alive into later tests.
    Process shutdown hooks run too late to provide that guarantee.

    How:
    - Remove process-exit event names from the predicate that credits cleanup.
    - If useful, add a separate predicate for supplemental process fallbacks so
      comments and diagnostics can distinguish fallback safety nets from
      guardrail-satisfying cleanup.
    - Verify local-disable exception behavior remains localized and
      behavior-specific.

    Testing:
    - `mise exec -- npm test -- --fresh tests/lint-no-leaky-test-daemon.test.ts tests/lint-daemon-test-guardrails.test.ts`
    - Run the real codebase guardrail validation that greps for
      `no-leaky-test-daemon` output under `tests/` and classify any remaining
      hit.

    Covers: @daemon-test-guardrail-precision ac-cleanup-registration-is-test-scoped,
    ac-detached-cleanup-before-observation, ac-local-exception-is-local,
    ac-exception-reason-states-subject

- title: Add implicit auto-start daemon cleanup regressions
  slug: task-add-implicit-autostart-cleanup-regressions
  priority: 2
  tags: [testing, lint, daemon, cli]
  spec_ref: "@daemon-test-guardrail-precision"
  depends_on:
    - "@task-tighten-daemon-guardrail-cleanup-semantics-specs"
  description: |
    What:
    - Add regression coverage for CLI tests that implicitly auto-start a daemon
      through ordinary CLI commands rather than an explicit `serve start
      --detach` command.
    - Cover the existing pattern in `tests/cli-no-daemon.test.ts` where a CLI
      subprocess can auto-start the daemon, the test reads the isolated daemon
      PID file, and later assertions inspect the process or daemon metadata.
    - Add a rejected guardrail fixture where the PID file is read and assertions
      or daemon observations run before `onTestFinished` cleanup is registered.
    - Add an allowed guardrail fixture where cleanup is registered immediately
      after the PID is known and before any process, metadata, endpoint, or
      assertion observation.
    - Add focused source coverage or contract tests proving the real
      `tests/cli-no-daemon.test.ts` auto-start cases register cleanup at the
      safe boundary.

    Why:
    The repo-wide adversarial audit found an implicit auto-start path that does
    not contain the literal `serve start --detach` token sequence. Without
    coverage for that ownership shape, daemon leaks can bypass the detached
    lifecycle guardrail entirely.

    How:
    - Inspect `tests/cli-no-daemon.test.ts` and the helpers that expose
      `isolatedHome.daemonPidFilePath`.
    - Model unsafe ownership as: CLI invocation that may auto-start the daemon,
      read/parse daemon PID or daemon metadata, later assertion/observation,
      then cleanup.
    - Model safe ownership as: CLI invocation, immediate PID/metadata capture,
      immediate `onTestFinished` terminating cleanup, then later observations.
    - Keep the classifier narrow enough that ordinary CLI tests that never
      observe or own an auto-started daemon are not reported.

    Testing:
    - First run the new guardrail regression and observe it fails against the
      current rule or source state.
    - After the implementation task, run:
      `mise exec -- npm test -- --fresh tests/cli-no-daemon.test.ts tests/lint-no-leaky-test-daemon.test.ts tests/lint-daemon-test-guardrails.test.ts`.

    Covers: @daemon-test-guardrail-precision ac-implicit-autostart-cleanup-before-observation,
    ac-cleanup-registration-is-test-scoped; @daemon-test-harness-guardrails
    ac-detached-serve-without-cleanup-flagged

- title: Fix implicit auto-start daemon cleanup coverage
  slug: task-fix-implicit-autostart-cleanup-coverage
  priority: 2
  tags: [testing, lint, daemon, cli]
  spec_ref: "@daemon-test-guardrail-precision"
  depends_on:
    - "@task-add-implicit-autostart-cleanup-regressions"
    - "@task-fix-guardrail-cleanup-boundary-classification"
  description: |
    What:
    - Harden `tests/cli-no-daemon.test.ts` so every implicit auto-start case
      registers terminating per-test cleanup immediately after the daemon PID or
      stop handle becomes known and before later assertions or process
      observations.
    - Extend the daemon lifecycle guardrail so tests that observe an
      implicitly auto-started daemon through PID files, daemon metadata, daemon
      status, or daemon endpoints must register scoped cleanup before later
      observations.
    - Preserve ordinary CLI tests that do not observe or own an auto-started
      daemon.

    Why:
    The current guardrail is centered on explicit detached start commands. CLI
    auto-start creates the same leak risk once a test discovers the daemon PID
    and then continues with assertions before cleanup is registered.

    How:
    - Patch the unsafe `tests/cli-no-daemon.test.ts` pattern first so the real
      repo complies with the intended rule.
    - Implement the guardrail expansion using concrete ownership observations
      such as daemon PID-file reads or daemon metadata reads after a CLI
      subprocess that can auto-start the daemon, not a broad ban on CLI
      subprocess tests.
    - Reuse the cleanup-effect and cleanup-boundary predicates from the earlier
      guardrail tasks.

    Testing:
    - `mise exec -- npm test -- --fresh tests/cli-no-daemon.test.ts tests/lint-no-leaky-test-daemon.test.ts tests/lint-daemon-test-guardrails.test.ts`
    - Run the full tests-directory no-leaky-daemon validation and classify any
      remaining report.

    Covers: @daemon-test-guardrail-precision ac-implicit-autostart-cleanup-before-observation,
    ac-cleanup-operation-terminates-daemon, ac-cleanup-registration-is-test-scoped

- title: Add bounded process-stop contract tests
  slug: task-add-bounded-process-stop-contract-tests
  priority: 1
  tags: [testing, daemon]
  spec_ref: "@daemon-test-teardown-boundedness"
  description: |
    What:
    - Add focused tests that prove daemon test cleanup observes process
      termination before reporting success and reaches a bounded outcome for
      uncooperative children.
    - Cover the shared real-daemon fixture stop path in `tests/helpers/daemon.ts`
      using a test seam or synthetic child that ignores the initial termination
      signal and requires escalation.
    - Cover the mock child-process daemon stop path in
      `tests/helpers/mock-daemon.ts` with a child that ignores `SIGTERM`.
    - Cover PID-based cleanup used by CLI lifecycle tests, including signal exit
      races where `signalCode` is set and `exitCode` remains `null`.
    - Assert that cleanup does not resolve until the child exit/death has been
      observed, or until a bounded failure diagnostic is surfaced.

    Why:
    Current cleanup helpers can send `SIGKILL` and then resolve from a timeout
    callback without observing the child exit. That leaves a narrow but real
    false success path where cleanup reports completion while the process still
    exists.

    How:
    - Prefer small synthetic child scripts in temp directories over real daemon
      processes for uncooperative-signal tests.
    - Use bounded event waits and process probes; do not add fixed sleeps except
      as explicit grace-period configuration under test.
    - Add AC annotations for `@daemon-test-teardown-boundedness` and existing
      fixture contract ACs.

    Testing:
    - First run the new tests and observe at least one failure against the
      current cleanup helper behavior.
    - After the implementation task, run:
      `mise exec -- npm test -- --fresh tests/helpers/daemon.test.ts tests/helpers/mock-daemon.test.ts tests/cli-serve.test.ts`.

    Covers: @daemon-test-teardown-boundedness ac-stop-observes-termination-before-return,
    ac-uncooperative-process-stop-is-bounded; @daemon-backed-test-fixture-contract
    ac-scoped-cleanup, ac-no-ambient-daemon-control

- title: Implement bounded process-stop primitives
  slug: task-implement-bounded-process-stop-primitives
  priority: 1
  tags: [testing, daemon]
  spec_ref: "@daemon-test-teardown-boundedness"
  depends_on:
    - "@task-add-bounded-process-stop-contract-tests"
  description: |
    What:
    - Add or refactor to a shared test-side process stop primitive used by the
      real daemon fixture, mock daemon child helper, CLI detached PID cleanup,
      and foreground child wait helpers where applicable.
    - The primitive must send a graceful termination request, wait for observed
      exit/death, escalate to a forceful termination request when needed, and
      then wait again for observed exit/death before reporting success.
    - If the process cannot be observed terminated after escalation, return or
      throw a bounded diagnostic instead of reporting successful cleanup.
    - Treat signal-based exits as real exits even when `exitCode` remains
      `null` and only `signalCode` is set.
    - Keep cleanup idempotent, and avoid killing unrelated processes when the
      owned child/PID has already exited.

    Why:
    Multiple helpers currently duplicate partial stop logic. Shared semantics
    reduce future drift and make cleanup success mean the same thing for real
    daemon, mock daemon, and CLI lifecycle tests.

    How:
    - Inspect `tests/helpers/daemon.ts`, `tests/helpers/mock-daemon.ts`, and
      `tests/cli-serve.test.ts` for existing stop helpers before choosing the
      shared helper location.
    - Preserve existing public helper return shapes unless tests prove a more
      explicit diagnostic type is needed.
    - Update comments and diagnostics to say cleanup observes termination rather
      than merely sending a signal.

    Testing:
    - `mise exec -- npm test -- --fresh tests/helpers/daemon.test.ts tests/helpers/mock-daemon.test.ts tests/cli-serve.test.ts`
    - Run any existing daemon build or WebSocket protocol slice that uses the
      real daemon fixture.

    Covers: @daemon-test-teardown-boundedness ac-stop-observes-termination-before-return,
    ac-uncooperative-process-stop-is-bounded; @daemon-backed-test-fixture-contract
    ac-scoped-cleanup, ac-readiness-diagnostics

- title: Add active-request and bounded-observation teardown regressions
  slug: task-add-active-request-bounded-observation-regressions
  priority: 2
  tags: [testing, daemon, mock]
  spec_ref: "@daemon-test-teardown-boundedness"
  description: |
    What:
    - Add focused regression tests for daemon-like servers and daemon probes
      that accept a connection but never complete a response.
    - Cover in-process mock daemon `stop()` while a hanging request is active.
    - Cover mock child-process daemon cleanup when the child has an active
      hanging request and graceful shutdown does not complete.
    - Cover daemon-facing HTTP probe helpers used by tests so accepted but
      non-responding requests are aborted or otherwise bounded.
    - Identify and update representative bare-fetch call sites in
      `tests/cli-serve.test.ts` and Playwright daemon setup coverage so the
      regression protects real consumers, not only an isolated helper.

    Why:
    `server.close()` waits for active requests. A test helper that exposes a
    hanging endpoint must also prove teardown does not hang forever when that
    endpoint is active.

    How:
    - Reuse the existing mock daemon hang behavior where possible.
    - Use `AbortSignal.timeout`, a shared bounded fetch helper, or equivalent
      test-side timeout control for daemon probes.
    - Keep runtime waits deterministic and short enough for focused tests.

    Testing:
    - First run the new tests and observe current hang/bare-fetch behavior is
      exposed without letting the suite hang indefinitely.
    - After the implementation task, run:
      `mise exec -- npm test -- --fresh tests/helpers/mock-daemon.test.ts tests/helpers/daemon.test.ts tests/cli-serve.test.ts`.

    Covers: @daemon-test-teardown-boundedness ac-active-requests-do-not-block-teardown,
    ac-daemon-observations-are-bounded; @daemon-backed-test-fixture-contract
    ac-bounded-readiness

- title: Fix active-request teardown and daemon observation bounds
  slug: task-fix-active-request-teardown-and-observation-bounds
  priority: 2
  tags: [testing, daemon, mock]
  spec_ref: "@daemon-test-teardown-boundedness"
  depends_on:
    - "@task-add-active-request-bounded-observation-regressions"
    - "@task-implement-bounded-process-stop-primitives"
  description: |
    What:
    - Update in-process and child-process mock daemon helpers so active or
      hanging requests cannot block teardown indefinitely.
    - Add a shared bounded daemon fetch/probe helper or update existing probe
      helpers so daemon-facing test HTTP requests use an abortable timeout.
    - Replace representative bare daemon `fetch(...)` calls in CLI lifecycle
      and Playwright daemon setup tests with the bounded helper when the request
      is not itself testing raw fetch behavior.
    - Preserve endpoint metadata fidelity and existing request-recording
      behavior for mock daemon clients.

    Why:
    Test infrastructure should fail with a diagnostic when a daemon endpoint
    stalls. It should not leave active sockets or hanging requests that prevent
    fixture teardown from completing.

    How:
    - For in-process servers, track sockets/active requests or use Node server
      connection-closing APIs with a bounded fallback.
    - For child-process mock cleanup, route stop through the bounded process
      stop primitive and ensure graceful server shutdown cannot block the
      parent forever.
    - For daemon probes, prefer the existing bounded patterns already present in
      the real daemon fixture and daemon build tests.

    Testing:
    - `mise exec -- npm test -- --fresh tests/helpers/mock-daemon.test.ts tests/helpers/daemon.test.ts tests/cli-serve.test.ts`
    - `mise exec -- npm run build:e2e && mise exec -- npx playwright test tests/e2e/smoke.spec.ts`

    Covers: @daemon-test-teardown-boundedness ac-active-requests-do-not-block-teardown,
    ac-daemon-observations-are-bounded; @daemon-test-startup-failure-hygiene
    ac-owned-child-stopped-after-startup-failure

- title: Add setup-failure cleanup and primary-error preservation regressions
  slug: task-add-setup-failure-error-preservation-regressions
  priority: 2
  tags: [testing, daemon, e2e]
  spec_ref: "@daemon-test-teardown-boundedness"
  description: |
    What:
    - Add focused tests for resource cleanup when daemon test setup fails before
      fixture readiness or before the main fixture `try/finally` begins.
    - Cover `createTestDaemonProject()` failure after a temp project directory
      has been created but before the returned cleanup handle is available.
    - Cover the Playwright daemon fixture setup path where project/home/config
      setup or port allocation fails before normal teardown registration.
    - Add tests proving readiness/startup primary errors are preserved when
      cleanup also fails, with cleanup failure included as suppressed context or
      an `AggregateError` according to the chosen implementation shape.
    - Add tests proving test-body/use primary errors in the Playwright wrapper
      are not replaced by secondary cleanup failures.

    Why:
    Cleanup hardening is incomplete if setup resources leak before the fixture
    reaches its main `try/finally`, or if a cleanup failure hides the original
    diagnostic that explains why startup/test execution failed.

    How:
    - Prefer dependency injection or narrow test seams rather than mutating real
      filesystem permissions globally.
    - Assert both sides of the contract: resource cleanup occurs, and the
      surfaced error still identifies the original failure.
    - Keep Playwright-specific coverage at the fixture-unit level when browser
      automation is not needed.

    Testing:
    - First run the new tests and observe failures in the current setup/error
      preservation paths.
    - After the implementation task, run:
      `mise exec -- npm test -- --fresh tests/helpers/daemon.test.ts tests/e2e-fixture-daemon-cleanup.test.ts`.

    Covers: @daemon-test-teardown-boundedness ac-setup-failure-cleans-owned-resources,
    ac-cleanup-errors-preserve-primary-failure; @daemon-test-startup-failure-hygiene
    ac-owned-child-stopped-after-startup-failure,
    ac-cleanup-registration-failure-stops-owned-child

- title: Fix setup-failure cleanup and primary-error preservation
  slug: task-fix-setup-failure-cleanup-error-preservation
  priority: 2
  tags: [testing, daemon, e2e]
  spec_ref: "@daemon-test-teardown-boundedness"
  depends_on:
    - "@task-add-setup-failure-error-preservation-regressions"
    - "@task-implement-bounded-process-stop-primitives"
  description: |
    What:
    - Harden `createTestDaemonProject()` so every owned resource created during
      setup is cleaned up if a later setup step fails before the project fixture
      is returned.
    - Move Playwright daemon fixture setup under cleanup coverage immediately
      after each resource is owned, so failures before readiness still clean up
      temp project, home/config, and child resources.
    - Preserve primary startup, readiness, setup, and test-body errors when
      cleanup also fails. Include cleanup failure context without replacing the
      primary error.
    - Keep existing successful fixture behavior and endpoint propagation
      unchanged.

    Why:
    Setup and cleanup failures are exactly when diagnostics matter most. The
    fixture should not leak resources or hide the primary cause while handling a
    secondary cleanup problem.

    How:
    - Use nested `try/finally` or a small cleanup stack that records owned
      resources as soon as they are created.
    - When cleanup fails after a primary error, attach the cleanup error as
      suppressed context or construct an `AggregateError` whose primary entry is
      the original failure.
    - Ensure idempotent cleanup remains safe when early cleanup and normal
      teardown both run.

    Testing:
    - `mise exec -- npm test -- --fresh tests/helpers/daemon.test.ts tests/e2e-fixture-daemon-cleanup.test.ts`
    - `mise exec -- npm run build:e2e && mise exec -- npx playwright test tests/e2e/smoke.spec.ts`

    Covers: @daemon-test-teardown-boundedness ac-setup-failure-cleans-owned-resources,
    ac-cleanup-errors-preserve-primary-failure; @e2e-test-daemon-isolation
    ac-e2e-scoped-cleanup; @daemon-backed-test-fixture-contract ac-isolated-project-data,
    ac-scoped-cleanup

- title: Validate daemon cleanup contract hardening end to end
  slug: task-validate-daemon-cleanup-contract-hardening
  priority: 3
  tags: [testing, daemon, validation]
  spec_ref: "@daemon-test-teardown-boundedness"
  depends_on:
    - "@task-fix-guardrail-cleanup-effect-classification"
    - "@task-fix-guardrail-cleanup-boundary-classification"
    - "@task-fix-implicit-autostart-cleanup-coverage"
    - "@task-implement-bounded-process-stop-primitives"
    - "@task-fix-active-request-teardown-and-observation-bounds"
    - "@task-fix-setup-failure-cleanup-error-preservation"
  description: |
    What:
    - Run final focused and broad validation for daemon cleanup contract
      hardening.
    - Verify every new AC on `@daemon-test-guardrail-precision` and
      `@daemon-test-teardown-boundedness` has truthful source or test coverage
      annotations.
    - Run adversarial guardrail probes for non-terminating signals, local no-op
      cleanup helpers, process-lifecycle-only cleanup, implicit CLI auto-start,
      and bounded teardown snippets.
    - Run source audits for direct daemon entrypoint starts, explicit detached
      starts, implicit auto-start PID observations, process-lifecycle cleanup
      hooks, bare daemon `fetch(...)` calls, and guardrail suppressions.
    - Classify every remaining hit as approved helper internals, behavior-under-
      test exception with local suppression, or a blocker.

    Why:
    This plan exists because previous hardening passes left small semantic
    false negatives. Final validation must challenge the completed work with
    adversarial examples instead of only rerunning the checked-in happy-path
    suite.

    How:
    - Use small generated lint fixtures or focused tests for adversarial probes;
      do not rely only on source grep.
    - Run focused suites first, then broader validation.
    - Add task notes listing the adversarial cases tested and their verdicts.
    - If any case remains ambiguous, leave the task open with a concrete blocker
      instead of marking the plan complete.

    Required commands:
    - `mise exec -- kspec validate --refs --warnings-ok`
    - `mise exec -- kspec validate --alignment --warnings-ok`
    - `mise exec -- npm test -- --fresh tests/lint-no-leaky-test-daemon.test.ts tests/lint-daemon-test-guardrails.test.ts`
    - `mise exec -- npm test -- --fresh tests/helpers/daemon.test.ts tests/helpers/mock-daemon.test.ts tests/cli-serve.test.ts tests/cli-no-daemon.test.ts`
    - `mise exec -- npm test -- --fresh tests/e2e-fixture-daemon-cleanup.test.ts`
    - `mise exec -- npm run build:e2e && mise exec -- npx playwright test tests/e2e/smoke.spec.ts`

    Covers: @daemon-test-guardrail-precision ac-cleanup-operation-terminates-daemon,
    ac-cleanup-probes-do-not-count, ac-cleanup-helper-origin-is-trusted,
    ac-cleanup-registration-is-test-scoped,
    ac-implicit-autostart-cleanup-before-observation;
    @daemon-test-teardown-boundedness ac-stop-observes-termination-before-return,
    ac-uncooperative-process-stop-is-bounded, ac-active-requests-do-not-block-teardown,
    ac-setup-failure-cleans-owned-resources,
    ac-cleanup-errors-preserve-primary-failure,
    ac-daemon-observations-are-bounded
```

## Implementation Notes

This is a follow-up hardening plan after `@plan-daemon-test-fixture-hardening`.
That plan substantially improved daemon test infrastructure, but adversarial
validation found residual cleanup false negatives and teardown-boundary gaps.
The key lesson is that cleanup must be treated as a semantic contract: code that
looks like cleanup is not sufficient unless it actually stops the daemon, runs
at the right lifecycle boundary, and reports completion only after bounded
termination has been observed.

Investigation evidence used to scope this plan:

- `tools/eslint-rules/no-leaky-test-daemon.js` currently credits
  `process.kill(...)` by callee shape, so `process.kill(pid, 0)` and
  `process.kill(pid, "SIGUSR1")` can satisfy cleanup despite not being a safe
  daemon stop.
- The same rule currently treats `process.on("exit"|"beforeExit"|signal, ...)`
  as valid cleanup. That can be useful as a process fallback, but it is not
  per-test scoped cleanup and can leave the daemon alive through later tests.
- Name-based cleanup helper recognition accepts local helpers named `killPid`,
  `stopDaemon`, or `stopMockDaemon` unless helper origin/body is trusted.
- `tests/cli-no-daemon.test.ts` includes implicit daemon auto-start paths that
  do not contain `serve start --detach`, so literal detached-start guardrails do
  not cover the ownership shape after the test reads the daemon PID.
- `tests/helpers/daemon.ts`, `tests/helpers/mock-daemon.ts`, and
  `tests/cli-serve.test.ts` contain stop paths that can send a forceful signal
  and report completion without always observing post-escalation process exit.
- Mock daemon helpers expose hanging request behavior; teardown needs to prove
  active requests cannot block cleanup indefinitely.
- Setup code in real and Playwright daemon fixtures can own temp resources
  before the main cleanup path is active; failures in that window need cleanup
  coverage.
- Primary startup/test errors can be masked if cleanup also throws; the surfaced
  error should retain the primary failure and include cleanup context.

Scope boundaries:

- In scope: daemon-test guardrail precision, implicit CLI auto-start cleanup in
  tests, shared test-side cleanup helpers, real/mock daemon fixture teardown,
  Playwright daemon fixture cleanup boundaries, and daemon-facing test probe
  bounds.
- Out of scope: production daemon endpoint selection, production serve-stop UX
  beyond test helper needs, replacing CLI lifecycle tests with the shared daemon
  fixture when lifecycle commands are the behavior under test, and unrelated
  pre-existing lint failures.
- Process-lifecycle cleanup hooks may remain as supplemental fallbacks, but they
  must not be the sole reason the guardrail treats a daemon as scoped to the
  current test.

Task ordering keeps spec updates first, then failing regression tests, then
implementation fixes. The final validation task must actively probe adversarial
cases rather than relying only on the repository's ordinary test suite.
