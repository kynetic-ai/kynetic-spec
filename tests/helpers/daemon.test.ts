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
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  buildDaemonChildEnv,
  createTestDaemonProject,
  DaemonReadinessError,
  startTestDaemon,
} from "./daemon.js";
import { readTestOutputSync } from "./cli.js";

describe("buildDaemonChildEnv", () => {
  // AC: @daemon-backed-test-fixture-contract ac-no-ambient-daemon-control
  // AC: @daemon-backed-test-fixture-contract ac-isolated-home-config
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
