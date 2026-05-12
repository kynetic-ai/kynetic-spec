/**
 * Contract tests for the shared daemon test fixture (tests/helpers/daemon.ts).
 *
 * These tests exercise the fixture core directly so that helper changes are
 * caught before they ripple into product-flow tests (websocket protocol,
 * Playwright e2e, runtime parity). AC coverage is recorded as standalone
 * `// AC:` line annotations on each test below — see kspec-agents conventions
 * for why annotations must be line comments rather than docstring entries.
 */
import { describe, expect, it, onTestFinished } from "vitest";
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  buildDaemonChildEnv,
  createTestDaemonProject,
  DaemonReadinessError,
  startTestDaemon,
  type CreateTestDaemonProjectStage,
} from "./daemon.js";
import { cleanupTempDir, createTempDir, readTestOutputSync } from "./cli.js";

/**
 * Synthetic uncooperative-child source for bounded-stop contract tests.
 *
 * Installs no-op SIGTERM / SIGINT / SIGHUP handlers so the only signal that
 * actually terminates the process is SIGKILL, then writes one ready line to
 * stdout. The test waits for that line before sending any signals — without
 * the handshake, a too-fast SIGTERM races the script's signal-handler
 * installation and hits the default terminate action, masking the bug
 * under test.
 */
const UNCOOPERATIVE_CHILD_SOURCE = `#!/usr/bin/env node
process.on("SIGTERM", () => { /* swallow */ });
process.on("SIGINT", () => { /* swallow */ });
process.on("SIGHUP", () => { /* swallow */ });
process.stdout.write("ready\\n");
setInterval(() => {}, 60_000);
`;

/** Probe whether a process is still alive without sending a real signal. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("buildDaemonChildEnv", () => {
  // AC: @daemon-backed-test-fixture-contract ac-no-ambient-daemon-control
  // AC: @daemon-backed-test-fixture-contract ac-isolated-home-config
  // AC: @daemon-test-startup-failure-hygiene ac-child-env-sanitized
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
  it("strips ambient daemon-control vars and isolates HOME", () => {
    const previous = {
      KSPEC_DAEMON_PID: process.env.KSPEC_DAEMON_PID,
      KSPEC_DAEMON_PORT: process.env.KSPEC_DAEMON_PORT,
      KSPEC_DAEMON_HOST: process.env.KSPEC_DAEMON_HOST,
      KSPEC_DAEMON_CONNECT_HOST: process.env.KSPEC_DAEMON_CONNECT_HOST,
      KSPEC_DAEMON_RUNTIME: process.env.KSPEC_DAEMON_RUNTIME,
      KSPEC_NO_DAEMON: process.env.KSPEC_NO_DAEMON,
      KSPEC_SESSION_ID: process.env.KSPEC_SESSION_ID,
    };
    process.env.KSPEC_DAEMON_PID = "99999";
    process.env.KSPEC_DAEMON_PORT = "1234";
    process.env.KSPEC_DAEMON_HOST = "10.0.0.1";
    process.env.KSPEC_DAEMON_CONNECT_HOST = "10.0.0.2";
    process.env.KSPEC_DAEMON_RUNTIME = "bun";
    process.env.KSPEC_NO_DAEMON = "1";
    process.env.KSPEC_SESSION_ID = "ambient-session";

    onTestFinished(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const env = buildDaemonChildEnv({
      runtime: "node",
      isolatedHome: {
        homeDir: "/tmp/fake-home",
        configDir: "/tmp/fake-home/.config/kspec",
        daemonPidFilePath: "/tmp/fake-home/.config/kspec/daemon.pid",
        daemonPortFilePath: "/tmp/fake-home/.config/kspec/daemon.port",
        env: { HOME: "/tmp/fake-home", USERPROFILE: "/tmp/fake-home" },
      },
      webUiDir: "/tmp/web-ui-build",
    });

    expect(env.HOME).toBe("/tmp/fake-home");
    expect(env.USERPROFILE).toBe("/tmp/fake-home");
    expect(env.WEB_UI_DIR).toBe("/tmp/web-ui-build");
    expect(env.NODE_ENV).toBe("test");

    expect(env.KSPEC_DAEMON_PID).toBeUndefined();
    expect(env.KSPEC_DAEMON_PORT).toBeUndefined();
    expect(env.KSPEC_DAEMON_HOST).toBeUndefined();
    expect(env.KSPEC_DAEMON_CONNECT_HOST).toBeUndefined();
    expect(env.KSPEC_DAEMON_RUNTIME).toBeUndefined();
    expect(env.KSPEC_NO_DAEMON).toBeUndefined();
    expect(env.KSPEC_SESSION_ID).toBeUndefined();
  });

  // AC: @daemon-backed-test-fixture-contract ac-no-ambient-daemon-control
  // AC: @daemon-test-startup-failure-hygiene ac-child-env-sanitized
  it("honors caller-provided extraEnv overrides verbatim", () => {
    const env = buildDaemonChildEnv({
      runtime: "bun",
      isolatedHome: {
        homeDir: "/tmp/fake-home",
        configDir: "/tmp/fake-home/.config/kspec",
        daemonPidFilePath: "/tmp/fake-home/.config/kspec/daemon.pid",
        daemonPortFilePath: "/tmp/fake-home/.config/kspec/daemon.port",
        env: { HOME: "/tmp/fake-home", USERPROFILE: "/tmp/fake-home" },
      },
      extraEnv: { KSPEC_NO_DAEMON: "0", BUN_ENV: "production" },
    });

    expect(env.BUN_ENV).toBe("production");
    expect(env.KSPEC_NO_DAEMON).toBe("0");
  });
});

describe("createTestDaemonProject", () => {
  // AC: @daemon-backed-test-fixture-contract ac-isolated-home-config
  // AC: @daemon-backed-test-fixture-contract ac-isolated-project-data
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
  it("creates an isolated temp project with HOME, .kspec, and shadow worktree pointer", async () => {
    const project = await createTestDaemonProject();
    onTestFinished(async () => {
      await project.cleanup();
    });

    expect(statSync(project.tempDir).isDirectory()).toBe(true);
    expect(statSync(project.kspecDir).isDirectory()).toBe(true);
    expect(project.kspecDir).toBe(join(project.tempDir, ".kspec"));

    expect(project.isolatedHome.homeDir.startsWith(project.tempDir)).toBe(true);
    expect(project.isolatedHome.configDir).toBe(
      join(project.isolatedHome.homeDir, ".config", "kspec"),
    );
    expect(statSync(project.isolatedHome.configDir).isDirectory()).toBe(true);
    expect(project.isolatedHome.env.HOME).toBe(project.isolatedHome.homeDir);

    // Shadow worktree pointer present so daemon detects .kspec/ as spec dir.
    const kspecGitFile = join(project.kspecDir, ".git");
    expect(existsSync(kspecGitFile)).toBe(true);
    const pointer = readTestOutputSync(kspecGitFile, "utf-8");
    expect(pointer.startsWith("gitdir:")).toBe(true);

    // E2E fixtures copied by default so a daemon child can hydrate its cache.
    expect(existsSync(join(project.kspecDir, "kynetic.yaml"))).toBe(true);
    expect(existsSync(join(project.kspecDir, "project.tasks.yaml"))).toBe(true);
  });

  it("removes the temp project on cleanup", async () => {
    const project = await createTestDaemonProject({ skipFixtures: true });
    expect(existsSync(project.tempDir)).toBe(true);
    await project.cleanup();
    expect(existsSync(project.tempDir)).toBe(false);
    // Idempotent.
    await project.cleanup();
  });
});

// Spawning a real daemon takes several seconds. Allow a generous overall
// timeout for the live-fixture tests so flakiness from CI cold caches doesn't
// mask real regressions.
describe("startTestDaemon happy path", { timeout: 60_000 }, () => {
  // AC: @daemon-backed-test-fixture-contract ac-real-daemon-tests-use-shared-fixture
  // AC: @daemon-backed-test-fixture-contract ac-isolated-home-config
  // AC: @daemon-backed-test-fixture-contract ac-isolated-project-data
  // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
  // AC: @daemon-backed-test-fixture-contract ac-bounded-readiness
  // AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
  // AC: @daemon-test-endpoint-consistency ac-no-localhost-by-default
  // AC: @daemon-test-endpoint-consistency ac-http-ws-same-endpoint
  // AC: @daemon-test-endpoint-consistency ac-dynamic-port-propagation
  // AC: @daemon-test-runtime-selection ac-node-default
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
  it("spawns a Node daemon on a dynamic 127.0.0.1 endpoint and stops cleanly", async () => {
    if (!existsSync(join(dirname(dirname(__dirname)), "dist", "daemon", "index.js"))) {
      throw new Error(
        "dist/daemon/index.js missing — run 'npm run build:daemon' before tests",
      );
    }
    const project = await createTestDaemonProject();
    onTestFinished(async () => {
      await project.cleanup();
    });

    const started = await startTestDaemon(project, {
      registerCleanup: (stop) => {
        onTestFinished(async () => {
          await stop();
        });
      },
    });

    // ac-node-default — default runtime is Node, advertised by /api/health.
    expect(started.runtime).toBe("node");

    // ac-no-localhost-by-default — fixture URLs use the numeric IPv4 loopback.
    expect(started.endpoint.connectHost).toBe("127.0.0.1");
    expect(started.apiUrl.startsWith("http://127.0.0.1:")).toBe(true);
    expect(started.wsUrl.startsWith("ws://127.0.0.1:")).toBe(true);
    expect(started.apiUrl).not.toContain("localhost");
    expect(started.wsUrl).not.toContain("localhost");

    // ac-dynamic-port-propagation — the resolved port matches the URLs.
    expect(started.port).toBeGreaterThan(0);
    expect(started.port).not.toBe(3456); // default port — must be a fresh allocation
    expect(started.apiUrl).toContain(`:${started.port}`);
    expect(started.wsUrl).toContain(`:${started.port}`);

    // ac-real-daemon-tests-use-shared-fixture — the fixture-spawned daemon
    // is reachable through the fixture-provided endpoint.
    const healthResponse = await fetch(`${started.apiUrl}/api/health`);
    expect(healthResponse.status).toBe(200);
    const healthBody = (await healthResponse.json()) as {
      status: string;
      runtime: string;
    };
    expect(healthBody.status).toBe("ok");
    expect(healthBody.runtime).toBe("node");

    // ac-isolated-project-data — daemon serves data from the fixture project.
    const tasksResponse = await fetch(`${started.apiUrl}/api/tasks`);
    expect(tasksResponse.status).toBe(200);
    const tasksBody = (await tasksResponse.json()) as {
      meta: { cache_status: string };
    };
    expect(tasksBody.meta.cache_status).toBe("ready");

    // ac-bounded-readiness (probe correctness) — when health-and-cache
    // readiness resolves, the entity cache is genuinely registered with
    // the tasks domain ready. Without this check the probe could match
    // during the disk-fallback window between server.listen() and
    // registerEntityCache(), where /api/tasks returns cache_status=ready
    // because the cacheDomainState is undefined; the test's cache_status
    // assertion above would then race a subsequent loadAll() that flips
    // the tasks domain to "loading".
    const cacheStatusResponse = await fetch(`${started.apiUrl}/api/debug/cache-status`);
    expect(cacheStatusResponse.status).toBe(200);
    const cacheStatusBody = (await cacheStatusResponse.json()) as {
      projects: Array<{
        path: string;
        domains: Record<string, { state: string }> | null;
      }>;
    };
    expect(cacheStatusBody.projects.length).toBeGreaterThan(0);
    const cacheProject = cacheStatusBody.projects[0];
    expect(cacheProject.domains).not.toBeNull();
    expect(cacheProject.domains?.tasks?.state).toBe("ready");

    expect(started.child.exitCode).toBe(null);

    // ac-scoped-cleanup — stop targets only this child handle and exits the
    // process cleanly.
    await started.stop();
    expect(
      started.child.exitCode !== null || started.child.signalCode !== null,
    ).toBe(true);

    // Idempotent stop.
    await started.stop();
  });
});

describe("startTestDaemon readiness diagnostics", { timeout: 60_000 }, () => {
  // AC: @daemon-backed-test-fixture-contract ac-readiness-diagnostics
  // AC: @daemon-backed-test-fixture-contract ac-bounded-readiness
  // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
  it("reports a diagnostic bundle when readiness times out", async () => {
    const project = await createTestDaemonProject();
    onTestFinished(async () => {
      await project.cleanup();
    });

    let registeredStop: (() => Promise<void>) | null = null;
    const startedAt = Date.now();
    const failingTimeoutMs = 800;

    let thrown: unknown = null;
    try {
      await startTestDaemon(project, {
        // Always-false probe forces the bounded wait to time out even though
        // the daemon itself starts successfully.
        readiness: {
          mode: "custom",
          probe: () => ({ ok: false, details: "intentional probe rejection" }),
        },
        timeoutMs: failingTimeoutMs,
        intervalMs: 50,
        registerCleanup: (stop) => {
          registeredStop = stop;
        },
      });
    } catch (error) {
      thrown = error;
    }
    const elapsed = Date.now() - startedAt;

    // Cleanup: even though startTestDaemon stops the child on failure,
    // exercise the registered hook to confirm it can run safely.
    onTestFinished(async () => {
      if (registeredStop) await registeredStop();
    });

    expect(thrown).toBeInstanceOf(DaemonReadinessError);
    const error = thrown as DaemonReadinessError;
    const d = error.diagnostics;

    // ac-readiness-diagnostics — the bundle reports endpoint, runtime, pid,
    // exit code/signal, stdout/stderr tails, and the last health response.
    expect(d.endpoint.apiUrl.startsWith("http://127.0.0.1:")).toBe(true);
    expect(d.endpoint.wsUrl.startsWith("ws://127.0.0.1:")).toBe(true);
    expect(d.endpoint.port).toBeGreaterThan(0);
    expect(d.runtime).toBe("node");
    expect(typeof d.pid).toBe("number");
    expect(d.pid).toBeGreaterThan(0);
    expect(typeof d.stdoutTail).toBe("string");
    expect(typeof d.stderrTail).toBe("string");
    expect(d.cause).toContain("Timed out");

    // ac-readiness-diagnostics — even custom probes must surface the last
    // /api/health and /api/debug/cache-status responses in the bundle so
    // diagnostics are not mode-dependent. The daemon itself is alive in this
    // test (only the probe rejects), so both endpoints should respond 200.
    expect(d.lastHealth).not.toBeNull();
    if ("status" in d.lastHealth) {
      expect(d.lastHealth.status).toBe(200);
      expect(d.lastHealth.body).toContain('"status":"ok"');
    } else {
      throw new Error(
        `lastHealth should have been a successful sample for a live daemon, ` +
          `got error: ${d.lastHealth.error}`,
      );
    }
    expect(d.lastCacheStatus).not.toBeNull();
    if ("status" in d.lastCacheStatus) {
      expect(d.lastCacheStatus.status).toBe(200);
      // The /api/debug/cache-status response is JSON-shaped with a projects
      // array; the fixture project should appear under "projects".
      expect(d.lastCacheStatus.body).toContain("projects");
    } else {
      throw new Error(
        `lastCacheStatus should have been a successful sample for a live daemon, ` +
          `got error: ${d.lastCacheStatus.error}`,
      );
    }

    // The error message echoes the bundle so failure logs are actionable
    // without unwrapping the diagnostics object.
    expect(error.message).toContain("Test daemon failed to reach readiness");
    expect(error.message).toContain(`pid=${d.pid}`);
    expect(error.message).toContain(d.endpoint.apiUrl);
    expect(error.message).toContain("last-health=");
    expect(error.message).toContain("last-cache-status=");

    // The custom probe rejection message must be visible in the chained
    // waitForStartup error.
    expect(d.cause).toContain("intentional probe rejection");

    // ac-bounded-readiness — the wait honored the configured budget and did
    // not silently extend.
    expect(elapsed).toBeLessThan(failingTimeoutMs * 4);

    // ac-scoped-cleanup — startTestDaemon's failure path already terminated
    // the spawned child; verify the stop registered via registerCleanup is
    // safe to invoke a second time.
    expect(registeredStop).not.toBeNull();
  });
});

describe("startTestDaemon process launch failure", { timeout: 30_000 }, () => {
  // AC: @daemon-test-startup-failure-hygiene ac-process-launch-failure-diagnosed
  // AC: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure
  // AC: @daemon-backed-test-fixture-contract ac-readiness-diagnostics
  // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
  it("surfaces a bounded startup diagnostic when the OS rejects the spawn", async () => {
    const project = await createTestDaemonProject();
    onTestFinished(async () => {
      await project.cleanup();
    });

    // Capture any unhandled child 'error' events for the duration of the
    // test. Without a listener attached by startTestDaemon itself, an ENOENT
    // 'error' event from spawn() would otherwise propagate as an
    // uncaughtException and abort the test before assertions run. We assert
    // separately that the failure surfaces as a DaemonReadinessError, so any
    // captured uncaught error indicates a missing 'error' listener in the
    // helper.
    const capturedUncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      capturedUncaught.push(err);
    };
    process.on("uncaughtException", onUncaught);
    onTestFinished(() => {
      process.off("uncaughtException", onUncaught);
    });

    // A binary that cannot exist on any reasonable host. spawn() will return
    // a child handle synchronously and emit 'error' (ENOENT) asynchronously.
    const nonexistentBinary = join(
      "/nonexistent",
      "kspec-daemon-test-binary-xyz-",
      `${Date.now()}-${process.pid}`,
    );

    let registeredStop: (() => Promise<void>) | null = null;
    let thrown: unknown = null;
    const startedAt = Date.now();
    const failingTimeoutMs = 4_000;

    try {
      await startTestDaemon(project, {
        __testBinaryOverride: nonexistentBinary,
        timeoutMs: failingTimeoutMs,
        intervalMs: 50,
        registerCleanup: (stop) => {
          registeredStop = stop;
        },
      });
    } catch (error) {
      thrown = error;
    }
    const elapsed = Date.now() - startedAt;

    onTestFinished(async () => {
      if (registeredStop) await registeredStop();
    });

    // ac-process-launch-failure-diagnosed — the helper must convert the
    // spawn-time 'error' (ENOENT) into a structured DaemonReadinessError
    // rather than hanging on the readiness wait or letting the error
    // propagate as uncaughtException.
    expect(capturedUncaught).toEqual([]);
    expect(thrown).toBeInstanceOf(DaemonReadinessError);
    const error = thrown as DaemonReadinessError;
    const d = error.diagnostics;

    // The diagnostic must include the runtime label, the resolved endpoint,
    // and a cause string identifying the launch failure. The pid is allowed
    // to be undefined since the OS never started the process.
    expect(d.runtime).toBe("node");
    expect(d.endpoint.apiUrl.startsWith("http://127.0.0.1:")).toBe(true);
    expect(d.endpoint.wsUrl.startsWith("ws://127.0.0.1:")).toBe(true);
    expect(d.endpoint.port).toBeGreaterThan(0);
    expect(typeof d.cause).toBe("string");
    expect(d.cause.length).toBeGreaterThan(0);
    // The cause should mention the launch failure (ENOENT or the failed
    // binary path) so the diagnostic is actionable.
    expect(d.cause).toMatch(/ENOENT|spawn|launch|nonexistent/i);

    // ac-readiness-diagnostics — the bundle is shaped consistently with the
    // readiness-timeout case so consumers do not have to special-case launch
    // failures.
    expect(typeof d.stdoutTail).toBe("string");
    expect(typeof d.stderrTail).toBe("string");
    expect(d.lastHealth).not.toBeNull();
    expect(d.lastCacheStatus).not.toBeNull();

    // The error message echoes the bundle so failure logs are actionable
    // without unwrapping the diagnostics object.
    expect(error.message).toContain("Test daemon failed to reach readiness");

    // Bounded — must not hang past a small multiple of the configured
    // timeout. ENOENT is observable almost immediately, so the actual
    // elapsed time should be well under the configured budget.
    expect(elapsed).toBeLessThan(failingTimeoutMs * 2);

    // ac-owned-child-stopped-after-startup-failure — registerCleanup was
    // invoked synchronously after spawn even though the OS rejected the
    // launch; the cleanup hook must be safe to call.
    expect(registeredStop).not.toBeNull();
    await (registeredStop as unknown as () => Promise<void>)();
  });
});

describe(
  "startTestDaemon scoped cleanup on readiness failure",
  { timeout: 60_000 },
  () => {
    // AC: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure
    // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
    // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
    // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
    it("stops the fixture-owned child before reporting readiness failure", async () => {
      const project = await createTestDaemonProject();
      onTestFinished(async () => {
        await project.cleanup();
      });

      // Capture the child handle via the probe context. The probe runs after
      // the child is spawned but always rejects, forcing the readiness wait
      // to fail. We then assert the captured child has terminated by the
      // time startTestDaemon throws — proving the helper stops the child
      // before returning failure to the caller.
      let capturedChild: ChildProcess | null = null;
      let registeredStop: (() => Promise<void>) | null = null;
      let thrown: unknown = null;

      try {
        await startTestDaemon(project, {
          readiness: {
            mode: "custom",
            probe: (ctx) => {
              capturedChild = ctx.child;
              return { ok: false, details: "always-fail" };
            },
          },
          timeoutMs: 600,
          intervalMs: 50,
          registerCleanup: (stop) => {
            registeredStop = stop;
          },
        });
      } catch (error) {
        thrown = error;
      }

      onTestFinished(async () => {
        if (registeredStop) await registeredStop();
      });

      expect(thrown).toBeInstanceOf(DaemonReadinessError);
      expect(capturedChild).not.toBeNull();
      const child = capturedChild as unknown as ChildProcess;

      // ac-owned-child-stopped-after-startup-failure — by the time
      // startTestDaemon throws, the captured child must already be exited or
      // signaled. The helper awaits stop() before throwing, so exit/signal
      // state is observable on the handle when the catch block runs.
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);

      // ac-scoped-cleanup — the registered stop hook is safe to call again
      // (idempotent stop). It must not throw, kill ambient processes, or
      // re-fetch the global pid file.
      expect(registeredStop).not.toBeNull();
      await (registeredStop as unknown as () => Promise<void>)();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    });
  },
);

describe(
  "startTestDaemon registerCleanup ordering",
  { timeout: 60_000 },
  () => {
    // AC: @daemon-test-startup-failure-hygiene ac-cleanup-registered-before-readiness-wait
    // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
    // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
    // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
    it("invokes registerCleanup before any readiness probe runs", async () => {
      const project = await createTestDaemonProject();
      onTestFinished(async () => {
        await project.cleanup();
      });

      // Synthetic registerCleanup hook: record the order in which the helper
      // invokes registerCleanup vs the first readiness probe. The contract
      // is that registerCleanup MUST run first so a wrapper (Playwright,
      // vitest onTestFinished) has a teardown hook in place before the
      // readiness wait can fail.
      const order: string[] = [];
      let registeredStop: (() => Promise<void>) | null = null;
      let thrown: unknown = null;

      try {
        await startTestDaemon(project, {
          readiness: {
            mode: "custom",
            probe: () => {
              order.push("probe");
              return { ok: false, details: "always-fail" };
            },
          },
          timeoutMs: 400,
          intervalMs: 50,
          registerCleanup: (stop) => {
            order.push("registerCleanup");
            registeredStop = stop;
          },
        });
      } catch (error) {
        thrown = error;
      }

      onTestFinished(async () => {
        if (registeredStop) await registeredStop();
      });

      expect(thrown).toBeInstanceOf(DaemonReadinessError);
      // ac-cleanup-registered-before-readiness-wait — registerCleanup is
      // invoked exactly once, before the first probe call.
      expect(order.filter((event) => event === "registerCleanup")).toHaveLength(1);
      expect(order[0]).toBe("registerCleanup");
      // The probe ran at least once after registration, so the test
      // observed real ordering rather than a no-probe early exit.
      expect(order).toContain("probe");
      const firstProbeIndex = order.indexOf("probe");
      const registerIndex = order.indexOf("registerCleanup");
      expect(registerIndex).toBeLessThan(firstProbeIndex);
    });
  },
);

describe(
  "startTestDaemon registerCleanup failure cleanup",
  { timeout: 60_000 },
  () => {
    // AC: @daemon-test-startup-failure-hygiene ac-cleanup-registration-failure-stops-owned-child
    // AC: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure
    // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
    // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
    // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
    it("stops the owned child when registerCleanup throws after spawn", async () => {
      if (!existsSync(join(dirname(dirname(__dirname)), "dist", "daemon", "index.js"))) {
        throw new Error(
          "dist/daemon/index.js missing — run 'npm run build:daemon' before tests",
        );
      }
      const project = await createTestDaemonProject();
      onTestFinished(async () => {
        await project.cleanup();
      });

      // Capture the live child handle and resolved endpoint via the
      // non-behavioral observer seam, BEFORE registerCleanup runs. The
      // observer must not catch the cleanup-registration error or invoke
      // stop(); it only exposes references so the test can deterministically
      // assert post-rejection that the helper terminated the spawned daemon.
      let observed: { child: ChildProcess; endpoint: string } | null = null;
      let registerCalls = 0;
      const sentinel = "intentional registerCleanup failure for regression";
      let thrown: unknown = null;

      try {
        try {
          await startTestDaemon(project, {
            __testObserveSpawn: ({ child, endpoint }) => {
              observed = { child, endpoint: endpoint.apiUrl };
            },
            registerCleanup: () => {
              registerCalls += 1;
              throw new Error(sentinel);
            },
            timeoutMs: 4_000,
            intervalMs: 50,
          });
        } catch (error) {
          thrown = error;
        }

        // The observer ran synchronously before registerCleanup, so the test
        // has direct references to the just-spawned child and its resolved
        // endpoint regardless of how the helper surfaces the
        // cleanup-registration failure.
        expect(observed).not.toBeNull();
        expect(registerCalls).toBe(1);
        const captured = observed as unknown as {
          child: ChildProcess;
          endpoint: string;
        };

        // The helper must reject — either with the cleanup-registration
        // failure directly or with a wrapped diagnostic that surfaces the
        // sentinel. Either form satisfies the contract because the AC is
        // about cleanup behavior, not about how the failure is wrapped.
        expect(thrown).not.toBeNull();
        expect(thrown).toBeInstanceOf(Error);
        const errorMessage =
          thrown instanceof Error ? thrown.message : String(thrown);
        expect(errorMessage).toContain(sentinel);

        // ac-cleanup-registration-failure-stops-owned-child: by the time the
        // helper rejects, it must have stopped the spawned child it owned.
        expect(
          captured.child.exitCode !== null || captured.child.signalCode !== null,
          "captured child must be terminated by the time startTestDaemon rejects",
        ).toBe(true);

        // Endpoint must be unreachable post-rejection. A partial helper fix
        // could terminate the child but leave a listener (orphaned port
        // binding, leaked watchdog) reachable — see review @01KR6T0X — so
        // this is verified independently of child liveness.
        let endpointReachable = false;
        try {
          const probe = await fetch(`${captured.endpoint}/api/health`, {
            signal: AbortSignal.timeout(750),
          });
          endpointReachable = probe.ok;
        } catch {
          endpointReachable = false;
        }
        expect(
          endpointReachable,
          "daemon endpoint must be unreachable after startTestDaemon rejects",
        ).toBe(false);
      } finally {
        // Safety net: if a future regression reintroduces the leak, force-kill
        // whatever the observer captured so this test cannot strand a daemon
        // process between runs. With the fix in place, startTestDaemon already
        // stopped the child before rejecting, so this branch is a no-op.
        if (observed) {
          const ref = observed as unknown as { child: ChildProcess };
          if (ref.child.exitCode === null && ref.child.signalCode === null) {
            try {
              ref.child.kill("SIGKILL");
            } catch {
              // Already dead — nothing to clean up.
            }
            await new Promise<void>((resolve) => {
              if (
                ref.child.exitCode !== null ||
                ref.child.signalCode !== null
              ) {
                resolve();
                return;
              }
              const onExit = (): void => {
                ref.child.off("exit", onExit);
                resolve();
              };
              ref.child.once("exit", onExit);
              setTimeout(() => {
                ref.child.off("exit", onExit);
                resolve();
              }, 5_000);
            });
          }
        }
      }
    });
  },
);

describe(
  "startTestDaemon stop() observes termination before return",
  { timeout: 30_000 },
  () => {
    // killChildScoped (tests/helpers/daemon.ts) now routes through the
    // shared bounded process-stop primitive: SIGTERM, wait for observed
    // exit on the handle (exitCode OR signalCode non-null OR 'exit' event
    // fired), escalate to SIGKILL on graceful timeout, wait again for
    // observed exit. Cleanup never resolves while the child is still
    // observably running.
    // AC: @daemon-test-teardown-boundedness ac-stop-observes-termination-before-return
    // AC: @daemon-test-teardown-boundedness ac-uncooperative-process-stop-is-bounded
    // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
    // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
    // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
    it(
      "does not resolve until an uncooperative child has been observed terminated",
      async () => {
        if (!existsSync(join(dirname(dirname(__dirname)), "dist", "daemon", "index.js"))) {
          throw new Error(
            "dist/daemon/index.js missing — run 'npm run build:daemon' before tests",
          );
        }
        const scriptDir = await createTempDir("kspec-uncooperative-daemon-");
        onTestFinished(async () => {
          await cleanupTempDir(scriptDir);
        });
        const synthPath = join(scriptDir, "uncooperative-daemon.cjs");
        writeFileSync(synthPath, UNCOOPERATIVE_CHILD_SOURCE);
        chmodSync(synthPath, 0o755);

        const project = await createTestDaemonProject();
        onTestFinished(async () => {
          await project.cleanup();
        });

        // Capture the spawned child handle via the synchronous observer
        // seam so the test can assert on the OS-visible pid after stop()
        // returns. The probe waits for the synth's stdout handshake so
        // we never race SIGTERM against the script's signal-handler
        // installation (without the handshake a too-fast SIGTERM hits
        // the default terminate action and masks the bug under test).
        let observed: { child: ChildProcess; pid: number } | null = null;
        const started = await startTestDaemon(project, {
          __testBinaryOverride: synthPath,
          readiness: {
            mode: "custom",
            probe: (ctx) => {
              const stdoutText = ctx.stdoutTail();
              if (ctx.child.exitCode !== null || ctx.child.signalCode !== null) {
                return { ok: false, details: `synth child exited unexpectedly` };
              }
              if (!stdoutText.includes("ready")) {
                return { ok: false, details: `awaiting synth ready handshake` };
              }
              return { ok: true, details: "synth ready" };
            },
          },
          timeoutMs: 5_000,
          intervalMs: 50,
          __testObserveSpawn: ({ child }) => {
            observed = { child, pid: child.pid ?? -1 };
          },
          registerCleanup: () => {
            /* test owns stop() lifecycle directly */
          },
        });

        expect(observed).not.toBeNull();
        const captured = observed as unknown as { child: ChildProcess; pid: number };
        expect(captured.pid).toBeGreaterThan(0);
        expect(isProcessAlive(captured.pid)).toBe(true);

        // Belt-and-suspenders: if the helper bug leaves the synthetic
        // child alive after stop() resolves, force-kill it on test exit
        // so the regression cannot strand an uncooperative process.
        onTestFinished(() => {
          if (isProcessAlive(captured.pid)) {
            try {
              process.kill(captured.pid, "SIGKILL");
            } catch {
              /* already gone */
            }
          }
        });

        const stopStartedAt = Date.now();
        await started.stop();
        const elapsed = Date.now() - stopStartedAt;

        // ac-stop-observes-termination-before-return: stop() resolves
        // only after exit has been observed on the parent handle. At
        // least one of exitCode / signalCode is non-null — signalCode
        // alone counts because the synth is uncooperative and the
        // helper escalates to SIGKILL.
        expect(
          started.child.exitCode !== null || started.child.signalCode !== null,
          `stop() must not resolve until child exit observed (exitCode=${started.child.exitCode} signalCode=${started.child.signalCode})`,
        ).toBe(true);

        // ac-uncooperative-process-stop-is-bounded: helper must reach
        // a bounded outcome. 15s is generous enough for slow CI
        // without masking a regression that hangs the wait. Pre-fix
        // returns near-instantly from the timer callback; post-fix
        // returns within the graceful window plus libuv exit
        // observation — both well under 15s.
        expect(elapsed).toBeLessThan(15_000);

        // Idempotent stop after observation.
        await started.stop();
      },
    );
  },
);

describe("createTestDaemonProject setup-failure cleanup", () => {
  // STAGED REGRESSION (vitest `it.fails`): documents the partial-resource leak
  // in createTestDaemonProject when a setup step fails after the temp project
  // directory has already been created. With the helper as-shipped today,
  // throwing from a stage hook bubbles straight out of the function — the
  // tempDir is never removed because there is no setup-failure cleanup
  // wrapper around the steps that own resources. `it.fails` reports the
  // expected leak assertion failure as PASS so the merge gate stays green
  // while this regression sits ahead of the helper fix
  // (@task-fix-setup-failure-cleanup-error-preservation).
  //
  // Post-fix contract: the helper will record each owned resource as it is
  // claimed (temp dir, shadow worktree pointer, isolated HOME) and roll back
  // already-claimed resources when a later step throws. The assertion below
  // will then pass, `it.fails` will report it as FAIL, and the implementation
  // task will flip the wrapper back to a regular `it(...)` to pin normal
  // post-fix behavior.

  for (const stage of [
    "after-shadow-detection",
    "after-isolated-home",
  ] as const satisfies readonly CreateTestDaemonProjectStage[]) {
    // AC: @daemon-test-teardown-boundedness ac-setup-failure-cleans-owned-resources
    // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
    // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
    it.fails(
      `removes the owned temp project when a setup step fails at ${stage}`,
      async () => {
        const sentinel = `setup failure sentinel for ${stage}`;
        // Capture the tempDir path via the first hook call so the test can
        // assert it was removed even though the helper never returned a
        // project handle. Without this, the failing call leaks the path —
        // there is no other observation channel.
        let observedTempDir: string | null = null;

        let thrown: unknown = null;
        try {
          await createTestDaemonProject({
            skipFixtures: true,
            __testStageHook: (currentStage) => {
              if (currentStage === "after-temp-dir") {
                // The helper calls the hook synchronously right after
                // createTempDir resolves, so the directory exists on disk at
                // hook time. We capture the freshest matching entry under
                // tmpdir() so the test can assert on cleanup even though the
                // helper never returns a project handle to inspect.
                const parent = tmpdir();
                const prefix = basename("kspec-daemon-fixture-");
                let newest: { name: string; mtimeMs: number } | null = null;
                for (const name of readdirSync(parent)) {
                  if (!name.startsWith(prefix)) continue;
                  try {
                    const fullPath = join(parent, name);
                    const stat = statSync(fullPath);
                    if (!stat.isDirectory()) continue;
                    if (!newest || stat.mtimeMs > newest.mtimeMs) {
                      newest = { name, mtimeMs: stat.mtimeMs };
                    }
                  } catch {
                    // Directory may have been cleaned up by a sibling test.
                  }
                }
                if (newest) {
                  observedTempDir = join(parent, newest.name);
                }
              }
              if (currentStage === stage) {
                throw new Error(sentinel);
              }
            },
          });
        } catch (error) {
          thrown = error;
        }

        // The helper must propagate the simulated step failure verbatim — the
        // contract is about cleanup, not error wrapping.
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain(sentinel);

        // The "after-temp-dir" hook captured the tempDir path — the helper
        // owned this resource at the moment a later step failed.
        expect(observedTempDir).not.toBeNull();
        const tempDirAtFailure = observedTempDir as unknown as string;

        // ac-setup-failure-cleans-owned-resources — the helper must roll
        // back the owned temp dir when a later setup step fails before the
        // caller receives the project handle. Pre-fix, the directory still
        // exists; post-fix it is removed.
        const stillExists = existsSync(tempDirAtFailure);

        // Safety net: even with `it.fails` masking the failure, force-remove
        // the leaked directory so this regression cannot accumulate temp
        // directories across runs. With the fix in place the helper will
        // already have removed it and this branch is a no-op.
        if (stillExists) {
          try {
            rmSync(tempDirAtFailure, { recursive: true, force: true });
          } catch {
            // Best effort: another concurrent cleanup may have removed it.
          }
        }

        expect(
          stillExists,
          `tempDir ${tempDirAtFailure} must be removed after setup failure at ${stage}`,
        ).toBe(false);
      },
    );
  }
});

describe(
  "startTestDaemon readiness failure preserves primary error when stop also fails",
  { timeout: 60_000 },
  () => {
    // STAGED REGRESSION (vitest `it.fails`): documents the primary-error
    // replacement gap in startTestDaemon's readiness-failure catch block.
    // The catch currently does `await stop(); throw new DaemonReadinessError(...)`,
    // so if `stop()` throws, JS evaluation order means the stop error escapes
    // and the DaemonReadinessError is never constructed — the caller loses
    // the actionable readiness diagnostic.
    //
    // Pre-fix: the stop error replaces the DaemonReadinessError, so the
    // assertion that `thrown instanceof DaemonReadinessError` fails.
    // `it.fails` reports that expected failure as PASS so the merge gate
    // stays green ahead of @task-fix-setup-failure-cleanup-error-preservation.
    //
    // Post-fix: the helper preserves the readiness diagnostic as the primary
    // error and attaches the stop failure as suppressed context (cause chain
    // or AggregateError, per the fix task's chosen shape). `it.fails` will
    // then report this test as FAIL, signaling the fix to flip it back to a
    // regular `it(...)`.
    //
    // The body still asserts the full contract (primary surfaces the
    // readiness diagnostic, the surfaced error references the stop failure
    // somehow) so the staged regression captures every facet the dependent
    // fix must preserve.
    // AC: @daemon-test-teardown-boundedness ac-cleanup-errors-preserve-primary-failure
    // AC: @daemon-backed-test-fixture-contract ac-readiness-diagnostics
    // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
    // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
    it.fails(
      "surfaces DaemonReadinessError as primary even when stop() throws",
      async () => {
        if (!existsSync(join(dirname(dirname(__dirname)), "dist", "daemon", "index.js"))) {
          throw new Error(
            "dist/daemon/index.js missing — run 'npm run build:daemon' before tests",
          );
        }
        const project = await createTestDaemonProject();
        onTestFinished(async () => {
          await project.cleanup();
        });

        const stopSentinel = new Error("simulated stop failure during readiness teardown");
        let registeredStop: (() => Promise<void>) | null = null;
        let capturedChild: ChildProcess | null = null;
        let thrown: unknown = null;

        try {
          await startTestDaemon(project, {
            // Always-false probe so readiness times out even though the
            // daemon itself is healthy.
            readiness: {
              mode: "custom",
              probe: (ctx) => {
                capturedChild = ctx.child;
                return { ok: false, details: "intentional probe rejection" };
              },
            },
            timeoutMs: 600,
            intervalMs: 50,
            __testStopFailure: stopSentinel,
            registerCleanup: (stop) => {
              registeredStop = stop;
            },
          });
        } catch (error) {
          thrown = error;
        }

        // Always drive the registered stop on cleanup — the `stopped` flag
        // inside the helper makes this idempotent and silent even when the
        // first call already threw `__testStopFailure`.
        onTestFinished(async () => {
          if (registeredStop) {
            try {
              await registeredStop();
            } catch {
              // The first stop invocation may have thrown the sentinel.
              // Subsequent calls are guarded by `stopped` and are no-ops.
            }
          }
          // Defensive: if a future regression bypasses the `stopped` guard,
          // make sure the child does not leak across tests.
          if (
            capturedChild &&
            (capturedChild as ChildProcess).exitCode === null &&
            (capturedChild as ChildProcess).signalCode === null
          ) {
            try {
              (capturedChild as ChildProcess).kill("SIGKILL");
            } catch {
              // Already dead.
            }
          }
        });

        // ac-cleanup-errors-preserve-primary-failure — the helper must
        // surface the readiness diagnostic as the primary failure even
        // though `stop()` threw the sentinel during the failure-path catch.
        // Pre-fix this assertion fails: the surfaced error is the sentinel
        // (a plain Error), not a DaemonReadinessError, because JS try/finally
        // semantics let the stop throw escape and abort the
        // `throw new DaemonReadinessError(...)` that followed it.
        expect(thrown).toBeInstanceOf(DaemonReadinessError);

        // Post-fix: the stop failure must remain discoverable from the
        // surfaced error — either as `error.cause`, as an entry in an
        // AggregateError, or as supplementary message text. The exact
        // shape is the fix task's choice; the contract is just that the
        // information is preserved.
        const error = thrown as Error;
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
        expect(surfacedText).toContain(stopSentinel.message);
      },
    );
  },
);
