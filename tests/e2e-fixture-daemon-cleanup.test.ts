/**
 * Unit-level coverage for the Playwright real-daemon fixture wrapper's
 * cleanup-registration, setup-failure cleanup, and primary-error preservation
 * contracts.
 *
 * The Playwright wrapper at `tests/e2e/fixtures/test-base.ts` delegates to
 * three helpers in `tests/e2e/fixtures/daemon-fixture.ts`:
 *
 *   - `acquirePlaywrightFixtureResources` — performs the wrapper's
 *     pre-try/finally setup (createTestDaemonProject + project-tests copy +
 *     coverage config + port allocation). Exercised here for the
 *     `ac-setup-failure-cleans-owned-resources` contract on the wrapper path.
 *
 *   - `startPlaywrightFixtureDaemon` — plumbs `registerCleanup` through to
 *     the shared real-daemon fixture core. Exercised here for the
 *     `ac-cleanup-registered-before-readiness-wait` contract.
 *
 *   - `runDaemonFixtureLifecycle` — wraps setup/use/teardown so the wrapper
 *     inherits primary-error preservation. Exercised here for the
 *     `ac-cleanup-errors-preserve-primary-failure` contract on the test-body
 *     path.
 *
 * The wrapper is now wired through all three, so the regressions below cover
 * the same code paths the wrapper executes — a regression in any helper
 * surfaces here AND in the wrapper itself. End-to-end ordering for the
 * shared core is covered in `tests/helpers/daemon.test.ts`
 * ("startTestDaemon registerCleanup ordering" and "startTestDaemon scoped
 * cleanup on readiness failure"); this suite proves the wrapper plumbs that
 * contract through behaviorally.
 */
import { existsSync, rmSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  acquirePlaywrightFixtureResources,
  runDaemonFixtureLifecycle,
  runPlaywrightFixtureBody,
  startPlaywrightFixtureDaemon,
  type AllocateTestDaemonPortImpl,
  type CreateTestDaemonProjectImpl,
  type PlaywrightFixtureSetupStage,
  type StartTestDaemonImpl,
} from "./e2e/fixtures/daemon-fixture.js";
import {
  createTestDaemonProject,
  type StartedTestDaemon,
  type TestDaemonProject,
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

describe("runDaemonFixtureLifecycle — primary error preservation", () => {
  // Positive contract: the lifecycle helper runs setup → use → teardown in
  // order on the success path. The fix task will refactor `test-base.ts` to
  // delegate to this helper, so wiring success-path ordering here protects
  // the wrapper's lifecycle contract from accidental regressions.
  // AC: @daemon-test-teardown-boundedness ac-cleanup-errors-preserve-primary-failure
  it("invokes setup, use, and teardown in order on the success path", async () => {
    const order: string[] = [];
    await runDaemonFixtureLifecycle<{ token: number }>({
      setup: async () => {
        order.push("setup");
        return { token: 42 };
      },
      use: async (started) => {
        order.push(`use:${started.token}`);
      },
      teardown: async () => {
        order.push("teardown");
      },
    });

    expect(order).toEqual(["setup", "use:42", "teardown"]);
  });

  // Positive contract: teardown still runs when only the use phase throws,
  // even before the primary-error-preservation fix lands. The wrapper today
  // already guarantees this via JS try/finally semantics; without this
  // assertion a regression that swallows the use error AND skips teardown
  // would slip past the more specific it.fails regression below.
  // AC: @daemon-test-teardown-boundedness ac-cleanup-errors-preserve-primary-failure
  it("runs teardown when use throws even if teardown succeeds", async () => {
    let teardownRan = false;
    const useSentinel = "use-only failure sentinel";

    let thrown: unknown = null;
    try {
      await runDaemonFixtureLifecycle<void>({
        setup: async () => {},
        use: async () => {
          throw new Error(useSentinel);
        },
        teardown: async () => {
          teardownRan = true;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(teardownRan).toBe(true);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(useSentinel);
  });

  // STAGED REGRESSION (vitest `it.fails`): documents the use-error
  // replacement gap that exists in the wrapper at
  // `tests/e2e/fixtures/test-base.ts` today. The current `runDaemonFixtureLifecycle`
  // body is a plain `try { use() } finally { teardown() }`, so when both
  // `use()` and `teardown()` throw, JS try/finally semantics drop the
  // primary use error and surface the teardown error instead — exactly the
  // failure mode @daemon-test-teardown-boundedness ac-cleanup-errors-preserve-primary-failure
  // calls out for the test-body path.
  //
  // Pre-fix: at least one assertion below fails because the surfaced error
  // does not reference the use sentinel. `it.fails` reports the expected
  // failure as PASS so the merge gate stays green while this regression
  // sits ahead of @task-fix-setup-failure-cleanup-error-preservation.
  //
  // Post-fix: the helper will capture the use error, run teardown, then
  // re-raise the use error with the teardown error attached (cause chain
  // or AggregateError per the fix task's chosen shape). All assertions
  // will pass, `it.fails` will then report this as FAIL, and the fix task
  // flips it back to a regular `it(...)`.
  // AC: @daemon-test-teardown-boundedness ac-cleanup-errors-preserve-primary-failure
  // AC: @e2e-test-daemon-isolation ac-e2e-scoped-cleanup
  it.fails(
    "preserves the use-phase primary error when teardown also fails",
    async () => {
      const useSentinel = "use-phase primary error sentinel";
      const teardownSentinel = "teardown failure sentinel";
      let teardownRan = false;

      let thrown: unknown = null;
      try {
        await runDaemonFixtureLifecycle<void>({
          setup: async () => {},
          use: async () => {
            throw new Error(useSentinel);
          },
          teardown: async () => {
            teardownRan = true;
            throw new Error(teardownSentinel);
          },
        });
      } catch (error) {
        thrown = error;
      }

      // Teardown still ran — the helper must not skip cleanup just because
      // `use()` threw. This part holds pre-fix and protects the JS
      // try/finally guarantee against regressions in the helper structure.
      expect(teardownRan).toBe(true);

      // ac-cleanup-errors-preserve-primary-failure (use path): the surfaced
      // error must be the use-phase failure. Pre-fix this fails because JS
      // try/finally lets the teardown throw escape and the use error is
      // discarded.
      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error;
      expect(error.message).toContain(useSentinel);

      // Post-fix: the teardown failure must remain discoverable from the
      // surfaced error — as message text, `error.cause`, or an entry in
      // an AggregateError. Pre-fix the surfaced error is the teardown
      // error itself, so the use sentinel is missing from every channel
      // and the assertion above already fails.
      const surfacedText = [
        error.message,
        (error as { cause?: unknown }).cause instanceof Error
          ? ((error as { cause: Error }).cause).message
          : "",
        error instanceof AggregateError
          ? error.errors
              .map((e) => (e instanceof Error ? e.message : String(e)))
              .join(" ")
          : "",
      ].join(" ");
      expect(surfacedText).toContain(teardownSentinel);
    },
  );
});

describe("acquirePlaywrightFixtureResources — wrapper setup-failure cleanup", () => {
  // Positive contract: the helper returns the project + port on the success
  // path AND emits every named stage in declared order. The Playwright
  // wrapper at `tests/e2e/fixtures/test-base.ts` reads both off the returned
  // object before constructing its lifecycle, so a regression in the return
  // shape would break every E2E test. The stage-order assertion guards the
  // failure-injection regressions below — if a future refactor dropped a
  // hook call (or moved a step before the hook), the keyed regression would
  // silently never trigger and become false coverage.
  it("returns the resources and emits every stage hook on the success path", async () => {
    const project = await createTestDaemonProject({ skipFixtures: true });
    try {
      const fakeCreate: CreateTestDaemonProjectImpl = (async () => project) as CreateTestDaemonProjectImpl;
      const fakeAllocate: AllocateTestDaemonPortImpl = (async () => 4321) as AllocateTestDaemonPortImpl;

      const stages: PlaywrightFixtureSetupStage[] = [];
      const resources = await acquirePlaywrightFixtureResources({
        // Pointing fixturesSource at a path that does NOT contain a
        // project-tests subdirectory exercises the cpSync-skip branch while
        // still requiring the helper to emit after-copy-project-tests. The
        // failure-injection regressions below depend on that emission.
        fixturesSource: "/nonexistent-fixtures-source",
        webUiDir: "/tmp/fake-web-ui",
        __testCreateProjectImpl: fakeCreate,
        __testAllocatePortImpl: fakeAllocate,
        __testStageHook: (stage) => {
          stages.push(stage);
        },
      });

      expect(resources.project).toBe(project);
      expect(resources.port).toBe(4321);
      expect(stages).toEqual([
        "after-create-project",
        "after-copy-project-tests",
        "after-write-config",
        "after-allocate-port",
      ]);
    } finally {
      await project.cleanup();
    }
  });

  // STAGED REGRESSIONS (vitest `it.fails`): document the partial-resource
  // leak in the wrapper setup path when a step after createTestDaemonProject
  // fails. Today `acquirePlaywrightFixtureResources` mirrors the wrapper's
  // pre-try/finally body verbatim — there is no setup-failure cleanup, so a
  // throw at any later stage exits before the project handle reaches the
  // wrapper's outer teardown. The temp project tree leaks because the only
  // `cleanup()` reference is on the unreturned project handle.
  //
  // Pre-fix: the assertion that the temp project no longer exists fails.
  // `it.fails` reports that as PASS so the merge gate stays green ahead of
  // @task-fix-setup-failure-cleanup-error-preservation.
  //
  // Post-fix: the helper records each owned resource as it is claimed and
  // rolls back already-claimed resources when a later step throws. The
  // assertion will then pass, `it.fails` will report this as FAIL, and the
  // fix task will flip these back to regular `it(...)` calls to pin the
  // cleaned-up post-fix behavior.
  for (const failureStage of [
    "after-copy-project-tests",
    "after-write-config",
    "after-allocate-port",
  ] as const satisfies readonly PlaywrightFixtureSetupStage[]) {
    // AC: @daemon-test-teardown-boundedness ac-setup-failure-cleans-owned-resources
    // AC: @e2e-test-daemon-isolation ac-e2e-scoped-cleanup
    it.fails(
      `cleans up the project temp dir when wrapper setup fails at ${failureStage}`,
      async () => {
        const sentinel = `wrapper setup failure sentinel for ${failureStage}`;

        // Use a real temp project so the cleanup-or-leak observation is
        // grounded in actual filesystem state. The handle doubles as the
        // safety net — even with `it.fails` masking the assertion, a
        // post-test `cleanup()` removes the directory so the staged
        // regression cannot accumulate leaked temp dirs across runs.
        const safetyHandle = await createTestDaemonProject({ skipFixtures: true });
        const projectTempDir = safetyHandle.tempDir;

        const fakeCreate: CreateTestDaemonProjectImpl = (async () => safetyHandle) as CreateTestDaemonProjectImpl;
        const fakeAllocate: AllocateTestDaemonPortImpl = (async () => 4321) as AllocateTestDaemonPortImpl;

        let thrown: unknown = null;
        try {
          await acquirePlaywrightFixtureResources({
            fixturesSource: "/nonexistent-fixtures-source",
            webUiDir: "/tmp/fake-web-ui",
            __testCreateProjectImpl: fakeCreate,
            __testAllocatePortImpl: fakeAllocate,
            __testStageHook: (stage) => {
              if (stage === failureStage) {
                throw new Error(sentinel);
              }
            },
          });
        } catch (error) {
          thrown = error;
        }

        // The helper must propagate the simulated step failure verbatim —
        // the contract is about cleanup, not error wrapping.
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain(sentinel);

        // The project temp dir was owned at the moment of failure (the
        // helper's createTestDaemonProject stage already returned the
        // project handle). The wrapper's only cleanup reference would have
        // been `project.cleanup()` on the unreturned handle, so pre-fix
        // the directory still exists.
        const stillExists = existsSync(projectTempDir);

        // Safety net: force-remove the leaked directory so this regression
        // cannot accumulate temp directories across runs even when
        // `it.fails` is masking the assertion. Post-fix the helper will
        // already have cleaned it up and this branch is a no-op.
        if (stillExists) {
          try {
            await safetyHandle.cleanup();
          } catch {
            try {
              rmSync(projectTempDir, { recursive: true, force: true });
            } catch {
              // Best effort: another concurrent cleanup may have removed it.
            }
          }
        }

        // ac-setup-failure-cleans-owned-resources — the helper must roll
        // back the owned project temp dir when a later wrapper setup step
        // fails before the resources reach the wrapper's outer teardown.
        // Pre-fix the directory still exists; post-fix it is removed.
        expect(
          stillExists,
          `project tempDir ${projectTempDir} must be removed after wrapper setup failure at ${failureStage}`,
        ).toBe(false);
      },
    );
  }

  // STAGED REGRESSION (vitest `it.fails`): allocateTestDaemonPort is the
  // last step in the wrapper setup path. A failure here is the most likely
  // real-world setup failure (port exhaustion, EADDRINUSE on the bind
  // probe), so it gets a dedicated test that simulates the failure inside
  // allocatePort itself rather than via the stage hook. This matches the
  // task description's call-out for "port allocation fails before normal
  // teardown registration".
  // AC: @daemon-test-teardown-boundedness ac-setup-failure-cleans-owned-resources
  // AC: @e2e-test-daemon-isolation ac-e2e-scoped-cleanup
  it.fails(
    "cleans up the project temp dir when allocateTestDaemonPort itself rejects",
    async () => {
      const sentinel = "allocateTestDaemonPort failure sentinel";
      const safetyHandle = await createTestDaemonProject({ skipFixtures: true });
      const projectTempDir = safetyHandle.tempDir;

      const fakeCreate: CreateTestDaemonProjectImpl = (async () => safetyHandle) as CreateTestDaemonProjectImpl;
      const fakeAllocate: AllocateTestDaemonPortImpl = (async () => {
        throw new Error(sentinel);
      }) as AllocateTestDaemonPortImpl;

      let thrown: unknown = null;
      try {
        await acquirePlaywrightFixtureResources({
          fixturesSource: "/nonexistent-fixtures-source",
          webUiDir: "/tmp/fake-web-ui",
          __testCreateProjectImpl: fakeCreate,
          __testAllocatePortImpl: fakeAllocate,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(sentinel);

      const stillExists = existsSync(projectTempDir);
      if (stillExists) {
        try {
          await safetyHandle.cleanup();
        } catch {
          try {
            rmSync(projectTempDir, { recursive: true, force: true });
          } catch {
            // Best effort.
          }
        }
      }

      // ac-setup-failure-cleans-owned-resources — allocateTestDaemonPort
      // throwing must not leave the project tree behind.
      expect(
        stillExists,
        `project tempDir ${projectTempDir} must be removed after allocateTestDaemonPort failure`,
      ).toBe(false);
    },
  );
});

describe("runPlaywrightFixtureBody — wrapper startup-failure cleanup", () => {
  // Cycle 2 review caught a wrapper regression: an earlier refactor passed
  // startDaemon as the lifecycle helper's `setup` callback, but
  // `runDaemonFixtureLifecycle` invokes `setup()` BEFORE entering its
  // try/finally — so a readiness/startup failure surfaced without running
  // teardown, dropping stopDaemon, second-project cleanup, and
  // project.cleanup. The reviewer reproduced the regression by "executing
  // the helper shape with a throwing setup" and observed
  // `thrown=setup/start failure` / `teardownRan=false`.
  //
  // `runPlaywrightFixtureBody` exists to close that gap: it wires
  // startDaemon inside the lifecycle's `use` phase (not `setup`) so a
  // startup failure flows through the try/finally and still triggers full
  // teardown. The Playwright wrapper at `tests/e2e/fixtures/test-base.ts`
  // delegates to this helper, so the assertions below cover the same code
  // path the wrapper executes — a regression that re-introduced the
  // setup-as-startup shape would surface here behaviorally.

  // Positive contract: the helper invokes startDaemon → body → teardown in
  // order on the success path. The wrapper's per-test ordering depends on
  // this — body reads from state that startDaemon populates, and teardown
  // expects body to have completed.
  // AC: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure
  // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
  it("invokes startDaemon, body, and teardown in order on the success path", async () => {
    const order: string[] = [];
    await runPlaywrightFixtureBody<{ token: number }>({
      startDaemon: async () => {
        order.push("start-daemon");
        return { token: 7 };
      },
      body: async (started) => {
        order.push(`body:${started.token}`);
      },
      teardown: async () => {
        order.push("teardown");
      },
    });

    expect(order).toEqual(["start-daemon", "body:7", "teardown"]);
  });

  // Regression: startDaemon throws during readiness/startup. The wrapper's
  // owned project temp dir, second-project tree, and daemon child must be
  // released — exactly the contract the cycle 2 review identified as
  // regressed.
  //
  // This is NOT staged with `it.fails` because `runPlaywrightFixtureBody`
  // is the fix for the wrapper-level regression: it routes startDaemon
  // through the lifecycle's `use` phase, so a throw triggers teardown via
  // JS try/finally even before the companion fix task adds explicit
  // primary-error preservation. A future refactor that reverted to the
  // setup-as-startup shape would fail this assertion by surfacing the
  // startup error without running teardown.
  // AC: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure
  // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
  // AC: @e2e-test-daemon-isolation ac-e2e-scoped-cleanup
  it("runs teardown when startDaemon throws (wrapper startup-failure path)", async () => {
    const order: string[] = [];
    const startupSentinel = "wrapper startDaemon readiness failure sentinel";
    let bodyRan = false;

    let thrown: unknown = null;
    try {
      await runPlaywrightFixtureBody<void>({
        startDaemon: async () => {
          order.push("start-daemon");
          throw new Error(startupSentinel);
        },
        body: async () => {
          // Should never run — startDaemon threw before body was reached.
          // Tracked explicitly so a regression that swallowed the startup
          // error and proceeded to body would surface as an unexpected
          // event in `order` rather than a silent skip.
          bodyRan = true;
          order.push("body");
        },
        teardown: async () => {
          order.push("teardown");
        },
      });
    } catch (error) {
      thrown = error;
    }

    // The startup error propagates verbatim — the helper does not swallow
    // or wrap it.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(startupSentinel);

    // body() never ran (startDaemon threw first).
    expect(bodyRan).toBe(false);

    // ac-owned-child-stopped-after-startup-failure / ac-scoped-cleanup —
    // teardown ran even though startDaemon rejected before body could
    // execute. This is the precise behavior the cycle 2 review confirmed
    // was MISSING in the prior wrapper shape: pre-fix the reviewer
    // observed teardownRan=false; post-fix `order` here contains both
    // start-daemon AND teardown.
    expect(order).toEqual(["start-daemon", "teardown"]);
  });

  // Regression: startDaemon throws AND teardown throws. The wrapper must
  // still drive teardown to completion (so the project temp dir is
  // released) and the surfaced error must remain the startup error, not
  // the teardown error, once the companion fix task lands.
  //
  // Staged with `it.fails`: pre-fix the lifecycle helper's plain
  // try/finally lets the teardown error escape and discards the startup
  // error. @task-fix-setup-failure-cleanup-error-preservation will add
  // primary-error preservation (cause chain or AggregateError) so the
  // startup sentinel remains discoverable. This pairs with the existing
  // use-phase primary-error-preservation regression in
  // `runDaemonFixtureLifecycle — primary error preservation`.
  // AC: @daemon-test-teardown-boundedness ac-cleanup-errors-preserve-primary-failure
  // AC: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure
  // AC: @e2e-test-daemon-isolation ac-e2e-scoped-cleanup
  it.fails(
    "preserves the startDaemon primary error when teardown also fails",
    async () => {
      const startupSentinel = "wrapper startDaemon primary error sentinel";
      const teardownSentinel = "wrapper teardown failure sentinel";
      let teardownRan = false;

      let thrown: unknown = null;
      try {
        await runPlaywrightFixtureBody<void>({
          startDaemon: async () => {
            throw new Error(startupSentinel);
          },
          body: async () => {},
          teardown: async () => {
            teardownRan = true;
            throw new Error(teardownSentinel);
          },
        });
      } catch (error) {
        thrown = error;
      }

      // Teardown still ran — even pre-fix the JS try/finally drives this.
      // The assertion guards against a regression that skips teardown
      // entirely (e.g., re-introducing the setup-as-startup shape).
      expect(teardownRan).toBe(true);

      // ac-cleanup-errors-preserve-primary-failure (startup path): the
      // surfaced error must reference the startDaemon failure. Pre-fix
      // the teardown throw escapes and the startup error is dropped, so
      // this assertion fails. Post-fix the helper preserves the startup
      // error and the assertion passes.
      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error;
      expect(error.message).toContain(startupSentinel);

      // Post-fix the teardown failure must remain discoverable from the
      // surfaced error — as message text, `error.cause`, or an entry in
      // an AggregateError. Pre-fix the surfaced error IS the teardown
      // error, so the startup sentinel is missing and the assertion above
      // already fails before this one is reached.
      const surfacedText = [
        error.message,
        (error as { cause?: unknown }).cause instanceof Error
          ? ((error as { cause: Error }).cause).message
          : "",
        error instanceof AggregateError
          ? error.errors
              .map((e) => (e instanceof Error ? e.message : String(e)))
              .join(" ")
          : "",
      ].join(" ");
      expect(surfacedText).toContain(teardownSentinel);
    },
  );
});
