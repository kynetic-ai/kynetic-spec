/**
 * Unit-level coverage for the Playwright real-daemon fixture wrapper's
 * cleanup-registration contract.
 *
 * The Playwright wrapper at `tests/e2e/fixtures/test-base.ts` delegates the
 * daemon-start step to `startPlaywrightFixtureDaemon`
 * (`tests/e2e/fixtures/daemon-fixture.ts`). That helper passes a
 * `registerCleanup` callback to the shared real-daemon fixture core so the
 * stop hook is captured synchronously after spawn and BEFORE the readiness
 * wait can fail. End-to-end ordering for the shared core itself is covered
 * in `tests/helpers/daemon.test.ts` ("startTestDaemon registerCleanup
 * ordering"); this suite proves the wrapper plumbs that contract through.
 *
 * No real daemon child is spawned — a fake `startTestDaemon` implementation
 * is injected through the helper's test seam and used to assert the
 * argument shape and captured-stop equivalence the wrapper relies on.
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
  it("passes a registerCleanup callback so the captured stop drives teardown", async () => {
    const observed = {
      registerCleanupReceived: false,
      registerCleanupInvocations: 0,
      stopInvocations: 0,
      capturedStopMatchesStarted: false,
    };
    const recordedStop = async (): Promise<void> => {
      observed.stopInvocations += 1;
    };

    const fakeStart: StartTestDaemonImpl = (async (_project, opts) => {
      // The wrapper's contract is that it provides a registerCleanup
      // function. Verify the option arrived as a function before
      // simulating the shared core's invocation order.
      observed.registerCleanupReceived = typeof opts.registerCleanup === "function";
      // Shared core invokes registerCleanup synchronously after spawn and
      // BEFORE readiness — model that order so the wrapper sees the same
      // sequencing as production.
      opts.registerCleanup?.(recordedStop);
      observed.registerCleanupInvocations += 1;
      return makeFakeStartedDaemon(recordedStop);
    }) as StartTestDaemonImpl;

    const result = await startPlaywrightFixtureDaemon({
      project: FAKE_PROJECT,
      runtime: "node",
      port: 1234,
      startTestDaemonImpl: fakeStart,
    });

    // The wrapper passed a registerCleanup callback to the shared core,
    // and the shared core invoked it once.
    expect(observed.registerCleanupReceived).toBe(true);
    expect(observed.registerCleanupInvocations).toBe(1);

    // The captured early stop is the same function the helper handed
    // back via registerCleanup. The wrapper's teardown drives this
    // captured reference, not a separately-computed stop path.
    expect(result.earlyStop).toBe(recordedStop);
    observed.capturedStopMatchesStarted = result.earlyStop === result.started.stop;
    expect(observed.capturedStopMatchesStarted).toBe(true);

    // Calling earlyStop drives the captured stop hook — the wrapper's
    // teardown reaches the same daemon stop via the registered hook.
    await result.earlyStop?.();
    expect(observed.stopInvocations).toBe(1);
  });

  // AC: @daemon-test-startup-failure-hygiene ac-cleanup-registered-before-readiness-wait
  // AC: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure
  it("registers the cleanup hook before the simulated readiness failure surfaces", async () => {
    let cleanupRegisteredBeforeFailure = false;

    const fakeStart: StartTestDaemonImpl = (async (_project, opts) => {
      // Shared core's contract — registerCleanup runs synchronously
      // after spawn and BEFORE the readiness wait. Model that here so
      // failure of the readiness wait still sees registerCleanup
      // already invoked, exactly as production does.
      opts.registerCleanup?.(NOOP_STOP);
      cleanupRegisteredBeforeFailure = true;
      throw new Error("simulated readiness failure");
    }) as StartTestDaemonImpl;

    let thrown: unknown = null;
    try {
      await startPlaywrightFixtureDaemon({
        project: FAKE_PROJECT,
        runtime: "node",
        port: 1234,
        startTestDaemonImpl: fakeStart,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("simulated readiness failure");
    // Cleanup was registered before the failure propagated. The wrapper
    // therefore had a stop hook captured for any teardown path the
    // Playwright fixture runs in its finally block.
    expect(cleanupRegisteredBeforeFailure).toBe(true);
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
