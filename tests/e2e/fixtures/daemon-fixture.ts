/**
 * Internal helpers for the Playwright real-daemon fixture wrapper.
 *
 * Extracted from `test-base.ts` so the cleanup-registration contract,
 * pre-try/finally setup contract, and lifecycle primary-error preservation
 * contract can be exercised at the unit level without pulling in
 * `@playwright/test`. The Playwright wrapper delegates to these helpers so
 * the regression tests cover the same code paths the wrapper executes.
 *
 * `startPlaywrightFixtureDaemon` plumbs the caller's `registerCleanup`
 * callback straight through to the shared real-daemon fixture core. The
 * caller (test-base.ts) owns the captured stop reference, so its `finally`
 * block can drive teardown even on the failure path where the helper itself
 * throws — at that point the shared core has already invoked
 * `registerCleanup` (synchronously, after spawn, before the readiness wait),
 * so the caller has a stop hook in hand.
 */
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  allocateTestDaemonPort as defaultAllocateTestDaemonPort,
  attachCleanupFailure,
  createTestDaemonProject as defaultCreateTestDaemonProject,
  startTestDaemon as defaultStartTestDaemon,
  type DaemonTestRuntime,
  type StartedTestDaemon,
  type TestDaemonProject,
} from "../../helpers/daemon.js";

export type StartTestDaemonImpl = typeof defaultStartTestDaemon;

export interface StartPlaywrightFixtureDaemonOptions {
  project: TestDaemonProject;
  runtime: DaemonTestRuntime;
  port: number;
  /**
   * Caller-owned cleanup registration. Invoked synchronously by the shared
   * core after the daemon child is spawned and BEFORE the readiness wait
   * runs. The caller stores the provided stop function so its teardown
   * logic (e.g. the Playwright fixture's `finally` block) can drive
   * cleanup on both success and startup-failure paths.
   */
  registerCleanup: (stop: () => Promise<void>) => void;
  /**
   * Test seam for unit-level coverage of the cleanup-registration contract.
   * Production callers (`test-base.ts`) leave this undefined and the helper
   * delegates to the shared real-daemon fixture core in
   * `tests/helpers/daemon.ts`.
   */
  startTestDaemonImpl?: StartTestDaemonImpl;
}

/**
 * Start the Playwright fixture's real daemon child via the shared core,
 * passing the caller's `registerCleanup` callback through so the stop hook
 * is captured before the readiness wait can fail.
 *
 * The shared core's contract (covered by
 * `tests/helpers/daemon.test.ts` — "startTestDaemon registerCleanup
 * ordering") guarantees the registered cleanup runs synchronously after
 * the spawn and before the first readiness probe. By forwarding the
 * caller's callback directly, the wrapper's teardown closure receives the
 * same stop function the shared core registered, even on the failure path
 * where this function rejects.
 */
export async function startPlaywrightFixtureDaemon(
  opts: StartPlaywrightFixtureDaemonOptions,
): Promise<StartedTestDaemon> {
  const start = opts.startTestDaemonImpl ?? defaultStartTestDaemon;
  return await start(opts.project, {
    runtime: opts.runtime,
    port: opts.port,
    extraEnv: {
      // KSPEC_TEST=1 enables the daemon's test-only cache-delay primitive
      // (src/daemon/entity-cache.ts). Preserved from the prior fixture.
      KSPEC_TEST: "1",
      KSPEC_TEST_RUNTIME: opts.runtime,
    },
    registerCleanup: opts.registerCleanup,
  });
}

/**
 * Named stages observable by `__testStageHook` during
 * `acquirePlaywrightFixtureResources`. Each stage corresponds to a point at
 * which the wrapper has just claimed a new owned resource: the daemon test
 * project (temp dir + isolated home), the copied project-tests tree, the
 * coverage scan config file, and the dynamic listen port. Contract tests use
 * the hook to simulate later-step failures and assert that the project temp
 * dir is cleaned up rather than leaked.
 */
export type PlaywrightFixtureSetupStage =
  | "after-create-project"
  | "after-copy-project-tests"
  | "after-write-config"
  | "after-allocate-port";

export type CreateTestDaemonProjectImpl = typeof defaultCreateTestDaemonProject;
export type AllocateTestDaemonPortImpl = typeof defaultAllocateTestDaemonPort;

export interface AcquirePlaywrightFixtureResourcesOptions {
  /** Source directory copied into the project's `.kspec/` (e2e fixtures). */
  fixturesSource: string;
  /** Path to the built web UI bundle the daemon serves for E2E tests. */
  webUiDir: string;
  /**
   * Test seam for unit-level coverage of the setup-failure cleanup contract.
   * Production callers (`test-base.ts`) leave this undefined and the helper
   * runs the real setup steps end-to-end. Pairs with the
   * `ac-setup-failure-cleans-owned-resources` regression coverage.
   */
  __testStageHook?: (stage: PlaywrightFixtureSetupStage) => void;
  /** Test seam: override `createTestDaemonProject` for cleanup-observation tests. */
  __testCreateProjectImpl?: CreateTestDaemonProjectImpl;
  /** Test seam: override `allocateTestDaemonPort` for setup-failure injection. */
  __testAllocatePortImpl?: AllocateTestDaemonPortImpl;
}

export interface PlaywrightFixtureResources {
  /** Owned daemon project (temp dir, isolated HOME, shadow worktree pointer). */
  project: TestDaemonProject;
  /** Pre-allocated dynamic port the daemon should bind on. */
  port: number;
}

/**
 * Acquire the project + port resources the Playwright real-daemon fixture
 * wrapper needs before its main try/finally starts. Mirrors the wrapper's
 * pre-try/finally setup steps so the regression tests can exercise the same
 * code path the wrapper itself executes.
 *
 * The setup steps in order:
 *   1. `createTestDaemonProject` — claims the temp project + isolated HOME
 *   2. Copy project-tests tree into `<tempDir>/tests` (best-effort if absent)
 *   3. Write `kspec.config.yaml` enabling coverage scan opt-in
 *   4. `allocateTestDaemonPort` — reserves a dynamic listen port
 *
 * Setup-failure cleanup: each step claims its owned resource before the
 * named stage hook runs. If any later step (including the test-only hook)
 * throws, already-owned resources are released — currently the project
 * handle, which owns the temp project tree and isolated HOME. The
 * surfaced error is the original setup failure; a cleanup failure is
 * attached as `error.cause` and as message context so the actionable
 * diagnostic is not replaced by secondary teardown noise.
 */
export async function acquirePlaywrightFixtureResources(
  opts: AcquirePlaywrightFixtureResourcesOptions,
): Promise<PlaywrightFixtureResources> {
  const createProject = opts.__testCreateProjectImpl ?? defaultCreateTestDaemonProject;
  const allocatePort = opts.__testAllocatePortImpl ?? defaultAllocateTestDaemonPort;

  const project = await createProject({
    fixturesSource: opts.fixturesSource,
    webUiDir: opts.webUiDir,
  });

  try {
    opts.__testStageHook?.("after-create-project");

    // Copy project-level tests directory for AC coverage scanning. The shared
    // fixture only copies into .kspec/, so the e2e-only tests/ tree (used by
    // the @test-feature ac-1 coverage path) has to be staged here in the
    // wrapper.
    const projectTests = join(opts.fixturesSource, "project-tests");
    if (existsSync(projectTests)) {
      cpSync(projectTests, join(project.tempDir, "tests"), { recursive: true });
    }
    opts.__testStageHook?.("after-copy-project-tests");

    // Coverage scanning is explicit opt-in (AC: @coverage-scan-config
    // ac-explicit-opt-in) and the e2e items spec relies on AC coverage being
    // detected for @test-feature ac-1.
    writeFileSync(
      join(project.tempDir, "kspec.config.yaml"),
      "coverage:\n  scan_paths:\n    - tests\n",
    );
    opts.__testStageHook?.("after-write-config");

    // Pre-allocate the dynamic port so daemon.stop() / daemon.start() restart
    // cycles re-bind to the same endpoint that the browser already loaded —
    // losing the port across a restart would force every test that exercises
    // reconnection behavior to reload.
    const port = await allocatePort();
    opts.__testStageHook?.("after-allocate-port");

    return { project, port };
  } catch (primary) {
    // Release the owned project handle so a later-step failure does not
    // leak the temp project + isolated HOME. project.cleanup is
    // idempotent, so a later teardown that also calls cleanup is safe.
    try {
      await project.cleanup();
    } catch (cleanupError) {
      const err = primary instanceof Error ? primary : new Error(String(primary));
      const secondary = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
      attachCleanupFailure(err, secondary);
      throw err;
    }
    throw primary;
  }
}

export interface DaemonFixtureLifecycleOpts<T> {
  /**
   * Setup phase. Constructs and returns the value passed to `use`. May throw
   * — the helper currently does not own any setup-failure cleanup; the
   * companion fix task (@task-fix-setup-failure-cleanup-error-preservation)
   * will move setup under cleanup coverage so a setup throw triggers the
   * teardown path. The Playwright wrapper at
   * `tests/e2e/fixtures/test-base.ts` already delegates to this helper, so
   * the post-fix behavior flows into the wrapper automatically.
   */
  setup: () => Promise<T>;
  /**
   * Use phase. Mirrors the body of a Playwright test fixture's `await use(...)`
   * call. If this throws, the surfaced error is the primary failure that
   * must be preserved even when `teardown` also fails.
   */
  use: (started: T) => Promise<void>;
  /**
   * Teardown phase. Always runs after `use` regardless of whether `use`
   * threw. A throw from teardown must not replace a primary error from
   * `setup` or `use`.
   */
  teardown: () => Promise<void>;
}

/**
 * Run a daemon-backed fixture's setup → use → teardown lifecycle.
 *
 * The Playwright wrapper at `tests/e2e/fixtures/test-base.ts` delegates to
 * this helper, so the wrapper's primary-error preservation behavior flows
 * directly from this function. Both phases are caught explicitly so a
 * teardown failure cannot replace a primary `use()` failure under plain
 * JS try/finally semantics — the surfaced error is always the
 * actionable primary cause, with any cleanup failure attached as
 * `error.cause` and as message context.
 */
export async function runDaemonFixtureLifecycle<T>(
  opts: DaemonFixtureLifecycleOpts<T>,
): Promise<void> {
  const started = await opts.setup();
  let primary: unknown = null;
  try {
    await opts.use(started);
  } catch (error) {
    primary = error;
  }
  let teardownError: unknown = null;
  try {
    await opts.teardown();
  } catch (error) {
    teardownError = error;
  }
  if (primary !== null) {
    if (teardownError !== null) {
      const primaryErr = primary instanceof Error ? primary : new Error(String(primary));
      const secondary = teardownError instanceof Error ? teardownError : new Error(String(teardownError));
      attachCleanupFailure(primaryErr, secondary);
      throw primaryErr;
    }
    throw primary;
  }
  if (teardownError !== null) {
    throw teardownError;
  }
}

export interface RunPlaywrightFixtureBodyOpts<T> {
  /**
   * Start the daemon. May throw on readiness/startup failure. Wired into
   * the lifecycle helper's `use` phase (NOT `setup`) so that a startup
   * failure flows through the helper's `try/finally` and still triggers
   * `teardown`. Putting startDaemon in `setup` would regress
   * @daemon-test-startup-failure-hygiene
   * ac-owned-child-stopped-after-startup-failure because
   * `runDaemonFixtureLifecycle` calls `setup()` before its try/finally.
   */
  startDaemon: () => Promise<T>;
  /**
   * Test fixture body — equivalent to a Playwright fixture's `await use(...)`
   * call. Receives the value returned by `startDaemon`.
   */
  body: (started: T) => Promise<void>;
  /**
   * Full teardown including stopDaemon, second-project cleanup, and the
   * owned project.cleanup. Runs after `body` regardless of whether
   * `startDaemon` or `body` threw. A throw from teardown must not replace
   * the primary error (enforced by the companion fix task's primary-error
   * preservation contract in `runDaemonFixtureLifecycle`).
   */
  teardown: () => Promise<void>;
}

/**
 * Drive the Playwright fixture wrapper's startup → body → teardown sequence
 * with startup-failure cleanup and primary-error preservation.
 *
 * The wrapper at `tests/e2e/fixtures/test-base.ts` uses this helper to
 * wire startDaemon inside the lifecycle's `use` phase, mirroring the
 * pre-extraction wrapper shape where startDaemon was inside the wrapper's
 * own `try/finally`. This guarantees that a daemon readiness/startup
 * failure triggers full teardown (stopDaemon, second-project cleanup,
 * project.cleanup) — passing startDaemon as `setup` instead would skip
 * teardown because `runDaemonFixtureLifecycle` invokes `setup()` before
 * entering its try/finally.
 *
 * AC: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure
 * AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
 */
export async function runPlaywrightFixtureBody<T>(
  opts: RunPlaywrightFixtureBodyOpts<T>,
): Promise<void> {
  await runDaemonFixtureLifecycle<void>({
    setup: async () => undefined,
    use: async () => {
      const started = await opts.startDaemon();
      await opts.body(started);
    },
    teardown: opts.teardown,
  });
}
