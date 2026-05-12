/**
 * Internal helpers for the Playwright real-daemon fixture wrapper.
 *
 * Extracted from `test-base.ts` so the cleanup-registration contract can be
 * exercised at the unit level without pulling in `@playwright/test`. The
 * Playwright wrapper keeps responsibility for the setup/use/teardown shape;
 * this module just owns the daemon-start step that has to honor
 * `startTestDaemon`'s `registerCleanup` contract.
 *
 * The helper plumbs the caller's `registerCleanup` callback straight through
 * to the shared real-daemon fixture core. The caller (test-base.ts) owns the
 * captured stop reference, so its `finally` block can drive teardown even on
 * the failure path where the helper itself throws — at that point the
 * shared core has already invoked `registerCleanup` (synchronously, after
 * spawn, before the readiness wait), so the caller has a stop hook in hand.
 */
import {
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

export interface DaemonFixtureLifecycleOpts<T> {
  /**
   * Setup phase. Constructs and returns the value passed to `use`. May
   * throw — the helper currently does not own any setup-failure cleanup;
   * a companion fix task (@task-fix-setup-failure-cleanup-error-preservation)
   * will move setup under cleanup coverage and wire test-base.ts to use this
   * helper.
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
 * Mirrors the wrapper pattern at `tests/e2e/fixtures/test-base.ts` so the
 * use-error preservation contract can be exercised at the unit level without
 * pulling in `@playwright/test`. The body deliberately uses the same simple
 * `try/finally` shape as the current wrapper: pre-fix, a teardown throw
 * replaces a primary use/setup error under JS try/finally semantics. The
 * companion fix task introduces explicit primary-error preservation (cause
 * chaining or `AggregateError`) here and refactors `test-base.ts` to delegate
 * to this helper.
 */
export async function runDaemonFixtureLifecycle<T>(
  opts: DaemonFixtureLifecycleOpts<T>,
): Promise<void> {
  const started = await opts.setup();
  try {
    await opts.use(started);
  } finally {
    await opts.teardown();
  }
}
