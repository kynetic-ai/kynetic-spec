/**
 * Unit-level coverage for the Playwright real-daemon fixture wrapper's
 * cleanup-registration contract.
 *
 * The Playwright wrapper at `tests/e2e/fixtures/test-base.ts` delegates the
 * daemon-start step to `startPlaywrightFixtureDaemon`
 * (`tests/e2e/fixtures/daemon-fixture.ts`). The helper plumbs the caller's
 * `registerCleanup` callback through to the shared real-daemon fixture
 * core; the wrapper's outer `finally` block drives the captured stop on
 * both the success path and the startup-failure path.
 *
 * No real daemon child is spawned — a fake `startTestDaemon` implementation
 * is injected through the helper's test seam to drive the simulated
 * startup-failure scenario the wrapper relies on. End-to-end ordering for
 * the shared core itself is covered in `tests/helpers/daemon.test.ts`
 * ("startTestDaemon registerCleanup ordering" and
 * "startTestDaemon scoped cleanup on readiness failure"); this suite proves
 * the wrapper plumbs that contract through behaviorally.
 */
import { describe, expect, it } from "vitest";

import {
  startPlaywrightFixtureDaemon,
  type StartTestDaemonImpl,
} from "./e2e/fixtures/daemon-fixture.js";
import type {
  StartedTestDaemon,
  TestDaemonProject,
} from "./helpers/daemon.js";

const FAKE_PROJECT: TestDaemonProject = {
  tempDir: "/tmp/fake-fixture-project",
  kspecDir: "/tmp/fake-fixture-project/.kspec",
  isolatedHome: {
    homeDir: "/tmp/fake-fixture-project/.home",
    configDir: "/tmp/fake-fixture-project/.home/.config/kspec",
    daemonPidFilePath: "/tmp/fake-fixture-project/.home/.config/kspec/daemon.pid",
    daemonPortFilePath: "/tmp/fake-fixture-project/.home/.config/kspec/daemon.port",
    env: {
      HOME: "/tmp/fake-fixture-project/.home",
      USERPROFILE: "/tmp/fake-fixture-project/.home",
    },
  },
  webUiDir: null,
  cleanup: async () => {},
};

const NOOP_STOP = async (): Promise<void> => {};

function makeFakeStartedDaemon(stop: () => Promise<void>): StartedTestDaemon {
  return {
    endpoint: {
      apiUrl: "http://127.0.0.1:1234",
      wsUrl: "ws://127.0.0.1:1234/ws",
      port: 1234,
      bindHost: "127.0.0.1",
      connectHost: "127.0.0.1",
    },
    runtime: "node",
    // The wrapper only reads `child.exitCode` / `child.signalCode` from this
    // handle on the restart path, which the cleanup-registration suite does
    // not exercise. Keep the fake opaque so the test surface matches the
    // wrapper's actual coupling to the real ChildProcess type.
    child: { pid: 99999, exitCode: null, signalCode: null } as never,
    pid: 99999,
    apiUrl: "http://127.0.0.1:1234",
    wsUrl: "ws://127.0.0.1:1234/ws",
    port: 1234,
    stdoutTail: () => "",
    stderrTail: () => "",
    stop,
  };
}

describe("startPlaywrightFixtureDaemon — cleanup registration contract", () => {
  // AC: @daemon-test-startup-failure-hygiene ac-cleanup-registered-before-readiness-wait
  // AC: @e2e-test-daemon-isolation ac-e2e-scoped-cleanup
  it("plumbs the caller's registerCleanup so the wrapper captures the stop on the success path", async () => {
    const observed = {
      registerCleanupReceivedFromCaller: false,
      registerCleanupInvocationsByCore: 0,
      callerCapturedStopMatchesStarted: false,
      stopInvocations: 0,
    };
    const recordedStop = async (): Promise<void> => {
      observed.stopInvocations += 1;
    };

    const fakeStart: StartTestDaemonImpl = (async (_project, opts) => {
      // The helper's contract is that it forwards the caller's
      // registerCleanup down to the shared core. Verify the callback
      // arrived and simulate the shared core's invocation order:
      // synchronously after spawn, BEFORE readiness.
      observed.registerCleanupReceivedFromCaller = typeof opts.registerCleanup === "function";
      opts.registerCleanup?.(recordedStop);
      observed.registerCleanupInvocationsByCore += 1;
      return makeFakeStartedDaemon(recordedStop);
    }) as StartTestDaemonImpl;

    // Mirror the wrapper's setup from test-base.ts: caller-owned
    // `earlyStop` populated through its own registerCleanup callback.
    let earlyStop: (() => Promise<void>) | null = null;
    const started = await startPlaywrightFixtureDaemon({
      project: FAKE_PROJECT,
      runtime: "node",
      port: 1234,
      registerCleanup: (stop) => {
        earlyStop = stop;
      },
      startTestDaemonImpl: fakeStart,
    });

    // The helper passed the caller's callback down to the shared core,
    // and the core invoked it once.
    expect(observed.registerCleanupReceivedFromCaller).toBe(true);
    expect(observed.registerCleanupInvocationsByCore).toBe(1);

    // The caller's earlyStop is the same function the shared core
    // registered AND the canonical stop on the started handle — the
    // wrapper's teardown drives the same idempotent cleanup hook on
    // both paths.
    expect(earlyStop).toBe(recordedStop);
    observed.callerCapturedStopMatchesStarted = earlyStop === started.stop;
    expect(observed.callerCapturedStopMatchesStarted).toBe(true);

    // Calling the captured stop drives the registered hook — the
    // wrapper's `finally` reaches the same daemon stop on the success
    // path that it would on the failure path.
    await earlyStop!();
    expect(observed.stopInvocations).toBe(1);
  });

  // AC: @daemon-test-startup-failure-hygiene ac-cleanup-registered-before-readiness-wait
  // AC: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure
  // AC: @e2e-test-daemon-isolation ac-e2e-scoped-cleanup
  it("lets the wrapper's finally block drive the registered stop when startup fails", async () => {
    const stopCalls: string[] = [];
    const recordedStop = async (): Promise<void> => {
      stopCalls.push("stop-invoked");
    };

    // Simulate the shared core's contract on the readiness-failure path:
    // registerCleanup runs synchronously after spawn, then the readiness
    // wait fails and the helper rejects. With the helper plumbing
    // registerCleanup through, the caller's earlyStop is already set
    // when the rejection surfaces — exactly the condition the wrapper's
    // finally block depends on.
    const fakeStart: StartTestDaemonImpl = (async (_project, opts) => {
      opts.registerCleanup?.(recordedStop);
      throw new Error("simulated readiness failure");
    }) as StartTestDaemonImpl;

    // Mirror the wrapper's setup/finally pattern from test-base.ts so
    // we observe the actual teardown behavior on the failure path,
    // not just the registration ordering.
    let earlyStop: (() => Promise<void>) | null = null;
    let earlyStopAtFailure: (() => Promise<void>) | null = null;
    let thrown: unknown = null;
    try {
      await startPlaywrightFixtureDaemon({
        project: FAKE_PROJECT,
        runtime: "node",
        port: 1234,
        registerCleanup: (stop) => {
          earlyStop = stop;
        },
        startTestDaemonImpl: fakeStart,
      });
    } catch (error) {
      thrown = error;
      // Snapshot at failure time so a later assignment cannot mask a
      // missing pre-failure registration.
      earlyStopAtFailure = earlyStop;
    } finally {
      if (earlyStop) await earlyStop();
    }

    // The helper propagated the readiness failure (no swallow).
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("simulated readiness failure");

    // ac-cleanup-registered-before-readiness-wait — registerCleanup ran
    // BEFORE the failure surfaced. earlyStopAtFailure being non-null
    // proves the caller already had the stop hook in hand by the time
    // the rejection was observable.
    expect(earlyStopAtFailure).toBe(recordedStop);

    // ac-owned-child-stopped-after-startup-failure — the wrapper's
    // `finally` block invoked the registered stop on the failure path,
    // and the registered stop ran to completion. A regression where
    // the wrapper lost startup-failure teardown — either by failing to
    // capture earlyStop pre-failure or by not invoking it in finally —
    // would leave stopCalls empty and fail this assertion.
    expect(stopCalls).toEqual(["stop-invoked"]);
  });

  it("forwards the runtime, port, and KSPEC_TEST env contract to the shared core", async () => {
    // Light coverage that the wrapper still passes the test-only env vars
    // and the pre-allocated port through to the shared core. The
    // cleanup-registration AC is the primary subject; this assertion
    // protects the registration change from accidentally regressing the
    // surrounding option contract.
    let receivedRuntime: string | undefined;
    let receivedPort: number | undefined;
    let receivedExtraEnv: Record<string, string> | undefined;

    const fakeStart: StartTestDaemonImpl = (async (_project, opts) => {
      receivedRuntime = opts.runtime;
      receivedPort = opts.port;
      receivedExtraEnv = opts.extraEnv;
      opts.registerCleanup?.(NOOP_STOP);
      return makeFakeStartedDaemon(NOOP_STOP);
    }) as StartTestDaemonImpl;

    await startPlaywrightFixtureDaemon({
      project: FAKE_PROJECT,
      runtime: "node",
      port: 1234,
      registerCleanup: () => {},
      startTestDaemonImpl: fakeStart,
    });

    expect(receivedRuntime).toBe("node");
    expect(receivedPort).toBe(1234);
    expect(receivedExtraEnv).toEqual({
      KSPEC_TEST: "1",
      KSPEC_TEST_RUNTIME: "node",
    });
  });
});
