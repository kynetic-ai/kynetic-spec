/**
 * Internal helpers for the Playwright real-daemon fixture wrapper.
 *
 * Extracted from `test-base.ts` so the cleanup-registration contract can be
 * exercised at the unit level without pulling in `@playwright/test`. The
 * Playwright wrapper keeps responsibility for the setup/use/teardown shape;
 * this module just owns the daemon-start step that has to honor
 * `startTestDaemon`'s `registerCleanup` contract.
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
   * Test seam for unit-level coverage of the cleanup-registration contract.
   * Production callers (`test-base.ts`) leave this undefined and the helper
   * delegates to the shared real-daemon fixture core in
   * `tests/helpers/daemon.ts`.
   */
  startTestDaemonImpl?: StartTestDaemonImpl;
}

export interface StartPlaywrightFixtureDaemonResult {
  started: StartedTestDaemon;
  /**
   * Stop hook captured via `startTestDaemon`'s `registerCleanup` callback,
   * registered synchronously after the daemon child is spawned and BEFORE
   * the readiness wait can fail. The same function is available as
   * `started.stop`; exposing the captured reference here documents that
   * the wrapper relies on the cleanup-before-readiness-wait contract from
   * the shared real-daemon fixture core. May be null only if the shared
   * core regressed and skipped the registration call — the wrapper falls
   * back to `started.stop` in that case.
   */
  earlyStop: (() => Promise<void>) | null;
}

/**
 * Start the Playwright fixture's real daemon child via the shared core,
 * passing a `registerCleanup` callback so the stop hook is captured before
 * the readiness wait can fail.
 *
 * The shared core's contract (covered by
 * `tests/helpers/daemon.test.ts` — "startTestDaemon registerCleanup
 * ordering") guarantees the registered cleanup runs synchronously after
 * the spawn and before the first readiness probe. The wrapper drives its
 * teardown from the captured `earlyStop`, so the same function the
 * wrapper registered is the one that runs on test exit.
 */
export async function startPlaywrightFixtureDaemon(
  opts: StartPlaywrightFixtureDaemonOptions,
): Promise<StartPlaywrightFixtureDaemonResult> {
  const start = opts.startTestDaemonImpl ?? defaultStartTestDaemon;
  let earlyStop: (() => Promise<void>) | null = null;
  const started = await start(opts.project, {
    runtime: opts.runtime,
    port: opts.port,
    extraEnv: {
      // KSPEC_TEST=1 enables the daemon's test-only cache-delay primitive
      // (src/daemon/entity-cache.ts). Preserved from the prior fixture.
      KSPEC_TEST: "1",
      KSPEC_TEST_RUNTIME: opts.runtime,
    },
    registerCleanup: (stop) => {
      earlyStop = stop;
    },
  });
  return { started, earlyStop };
}
