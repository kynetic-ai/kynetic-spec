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
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  __createPortStartLockSignalHandler,
  acquireTestDaemonPortStartLock,
  buildDaemonChildEnv,
  createTestDaemonProject,
  DaemonReadinessError,
  allocateTestDaemonPort,
  reserveTestDaemonPort,
  startTestDaemon,
  type CreateTestDaemonProjectStage,
} from "./daemon.js";
import {
  _resetCleanupRmForTesting,
  _setCleanupRmForTesting,
  cleanupTempDir,
  createTempDir,
  readTestOutputSync,
} from "./cli.js";

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

/**
 * Synthetic delayed-bind daemon for the diagnostic-sample retry regression.
 *
 * Parses the --port flag (which startTestDaemon passes via buildDaemonArgs),
 * then waits SYNTH_BIND_DELAY_MS before binding an HTTP listener that serves
 * /api/health and /api/debug/cache-status with daemon-shaped responses. The
 * combined "delay > readiness timeout" + "respond once bound" produces a
 * deterministic race the diagnostic-sample retry must absorb: without retry
 * the failure-path lastHealth/lastCacheStatus are ECONNREFUSED, with retry
 * they become 200 because the bind lands inside the retry budget.
 */
const DELAYED_BIND_DAEMON_SOURCE = `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 0;
const bindDelayMs = Number(process.env.SYNTH_BIND_DELAY_MS ?? "0");
process.stdout.write("synth-booting\\n");
setTimeout(() => {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", uptime: 0, runtime: "node" }));
      return;
    }
    if (req.url === "/api/debug/cache-status") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ projects: [{ path: "/synth", domains: { tasks: { state: "ready" } } }] }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  server.on("error", (err) => {
    process.stderr.write("synth-bind-error: " + err.message + "\\n");
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write("synth-listening\\n");
  });
}, bindDelayMs);
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

describe("test daemon port reservation", () => {
  it("holds a preallocated port until the reservation is released", async () => {
    const port = await allocateTestDaemonPort();
    const release = await reserveTestDaemonPort(port);
    onTestFinished(async () => {
      await release();
    });

    await expect(reserveTestDaemonPort(port)).rejects.toMatchObject({ code: "EADDRINUSE" });

    await release();
    const releaseAgain = await reserveTestDaemonPort(port);
    await releaseAgain();
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
      throw new Error("dist/daemon/index.js missing — run 'npm run build:daemon' before tests");
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
    expect(started.child.exitCode !== null || started.child.signalCode !== null).toBe(true);

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

describe("startTestDaemon scoped cleanup on readiness failure", { timeout: 60_000 }, () => {
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
});

describe("startTestDaemon registerCleanup ordering", { timeout: 60_000 }, () => {
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
});

describe("startTestDaemon registerCleanup failure cleanup", { timeout: 60_000 }, () => {
  // AC: @daemon-test-startup-failure-hygiene ac-cleanup-registration-failure-stops-owned-child
  // AC: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure
  // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
  it("stops the owned child when registerCleanup throws after spawn", async () => {
    if (!existsSync(join(dirname(dirname(__dirname)), "dist", "daemon", "index.js"))) {
      throw new Error("dist/daemon/index.js missing — run 'npm run build:daemon' before tests");
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
      const errorMessage = thrown instanceof Error ? thrown.message : String(thrown);
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
            if (ref.child.exitCode !== null || ref.child.signalCode !== null) {
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
});

describe("startTestDaemon stop() observes termination before return", { timeout: 30_000 }, () => {
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
  it("does not resolve until an uncooperative child has been observed terminated", async () => {
    if (!existsSync(join(dirname(dirname(__dirname)), "dist", "daemon", "index.js"))) {
      throw new Error("dist/daemon/index.js missing — run 'npm run build:daemon' before tests");
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
  });
});

describe("createTestDaemonProject setup-failure cleanup", () => {
  // The helper records each owned resource on a cleanup stack as it is
  // claimed (temp dir, shadow worktree pointer, isolated HOME). When a
  // later setup step — including the test-only `__testStageHook` — throws,
  // the stack runs in reverse so already-owned resources are released
  // before the original failure propagates. These regressions pin the
  // contract that no temp project is leaked behind a setup failure.

  for (const stage of [
    "after-shadow-detection",
    "after-isolated-home",
  ] as const satisfies readonly CreateTestDaemonProjectStage[]) {
    // AC: @daemon-test-teardown-boundedness ac-setup-failure-cleans-owned-resources
    // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
    // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
    it(`removes the owned temp project when a setup step fails at ${stage}`, async () => {
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

      // ac-setup-failure-cleans-owned-resources — the helper rolls
      // back the owned temp dir when a later setup step fails before
      // the caller receives the project handle.
      const stillExists = existsSync(tempDirAtFailure);

      // Defensive safety net: if a regression re-introduces the leak,
      // force-remove the orphaned directory so the failing run does
      // not accumulate temp dirs. The assertion below still fails.
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
    });
  }
});

describe("createTestDaemonProject setup failure preserves primary when cleanup also fails", () => {
  // The setup-failure catch in createTestDaemonProject builds the primary
  // error BEFORE invoking runCleanups, and wraps the cleanup-error case in
  // attachCleanupFailure(). The primary setup failure remains the surfaced
  // error even when the registered cleanup (cleanupTempDir) itself rejects.
  // The cleanup failure is attached as error.cause + message context so the
  // actionable setup diagnostic is never replaced by secondary teardown noise.
  //
  // The contract is exercised by injecting both failures simultaneously:
  //   - __testStageHook throws at a later setup stage (primary)
  //   - _setCleanupRmForTesting installs a rm impl that rejects, causing
  //     cleanupTempDir(tempDir) on the cleanup stack to fail (cleanup)
  //
  // This is the gap identified by the cycle-1 review: prior coverage proved
  // setup-stage primary preservation only when cleanup succeeded. Without
  // this regression, the cleanupError branch in createTestDaemonProject
  // could regress (e.g. swallowed, or replacing primary) and every existing
  // setup-failure test would still pass.
  //
  // AC: @daemon-test-teardown-boundedness ac-cleanup-errors-preserve-primary-failure
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
  it("surfaces the setup-stage error as primary even when cleanupTempDir rejects", async () => {
    const setupSentinel = "setup-stage primary error sentinel with cleanup-failure";
    const cleanupSentinel = "simulated rm rejection during setup-failure cleanup";

    // Captured during the first hook so the test can manually remove the
    // orphaned tree after restoring the real rm impl. The injected
    // cleanup-failure means createTestDaemonProject's runCleanups path
    // cannot remove the temp dir on its own.
    let observedTempDir: string | null = null;

    _setCleanupRmForTesting(async () => {
      throw new Error(cleanupSentinel);
    });

    let thrown: unknown = null;
    try {
      await createTestDaemonProject({
        skipFixtures: true,
        __testStageHook: (currentStage) => {
          if (currentStage === "after-temp-dir") {
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
          if (currentStage === "after-shadow-detection") {
            throw new Error(setupSentinel);
          }
        },
      });
    } catch (error) {
      thrown = error;
    } finally {
      // Restore the real rm impl before any other test runs cleanupTempDir.
      // Tests in this file run sequentially under vitest's default
      // configuration, so a synchronous restore here is safe.
      _resetCleanupRmForTesting();
    }

    // Defensive cleanup: the injected rm-failure prevented runCleanups
    // from removing the temp dir during the failure-path catch. Drop the
    // orphaned tree now using the restored rm so the failing run does not
    // accumulate temp dirs.
    if (observedTempDir && existsSync(observedTempDir)) {
      try {
        await cleanupTempDir(observedTempDir);
      } catch {
        try {
          rmSync(observedTempDir, { recursive: true, force: true });
        } catch {
          // Best effort.
        }
      }
    }

    // ac-cleanup-errors-preserve-primary-failure — the surfaced error is
    // the setup-stage failure, not the cleanup failure that fired during
    // the catch block's runCleanups.
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(error.message).toContain(setupSentinel);

    // The cleanup failure remains discoverable from the surfaced error
    // — as message text, error.cause, or an entry in an AggregateError.
    // attachCleanupFailure sets primary.cause to the cleanup error and
    // appends a one-shot message suffix.
    const surfacedText = [
      error.message,
      (error as { cause?: unknown }).cause instanceof Error
        ? (error as { cause: Error }).cause.message
        : "",
      error instanceof AggregateError
        ? error.errors.map((e) => (e instanceof Error ? e.message : String(e))).join(" ")
        : "",
    ].join(" ");
    expect(surfacedText).toContain(cleanupSentinel);
  });
});

describe(
  "startTestDaemon readiness failure preserves primary error when stop also fails",
  { timeout: 60_000 },
  () => {
    // The readiness-failure catch in startTestDaemon constructs the
    // DaemonReadinessError BEFORE invoking stop(), and wraps the stop()
    // call in its own try/catch. When stop() throws, the readiness
    // diagnostic remains the surfaced primary error and the stop failure
    // is attached as `error.cause` + message context — the actionable
    // diagnostic is never replaced by secondary teardown noise.
    // AC: @daemon-test-teardown-boundedness ac-cleanup-errors-preserve-primary-failure
    // AC: @daemon-backed-test-fixture-contract ac-readiness-diagnostics
    // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
    // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
    it("surfaces DaemonReadinessError as primary even when stop() throws", async () => {
      if (!existsSync(join(dirname(dirname(__dirname)), "dist", "daemon", "index.js"))) {
        throw new Error("dist/daemon/index.js missing — run 'npm run build:daemon' before tests");
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

      // ac-cleanup-errors-preserve-primary-failure — the helper
      // surfaces the readiness diagnostic as the primary failure even
      // though `stop()` threw the sentinel during the failure-path
      // catch.
      expect(thrown).toBeInstanceOf(DaemonReadinessError);

      // The stop failure remains discoverable from the surfaced error
      // — either as `error.cause`, as an entry in an AggregateError,
      // or as supplementary message text.
      const error = thrown as Error;
      const surfacedText = [
        error.message,
        (error as { cause?: unknown }).cause instanceof Error
          ? (error as { cause: Error }).cause.message
          : "",
        error instanceof AggregateError
          ? error.errors.map((e) => (e instanceof Error ? e.message : String(e))).join(" ")
          : "",
      ].join(" ");
      expect(surfacedText).toContain(stopSentinel.message);
    });
  },
);

describe(
  "startTestDaemon readiness diagnostics retry late-binding daemon",
  { timeout: 60_000 },
  () => {
    // Regression for the lastHealth flake: under heavy parallel load, a
    // daemon spawned with a custom always-false probe and a short readiness
    // timeout could time out before the kernel finished binding the daemon's
    // listen socket. The pre-fix sampleEndpointDiagnostic took a single
    // snapshot at failure time, so a transient ECONNREFUSED surfaced as
    // {error:"fetch failed"} in the bundle even though the daemon process
    // was alive and would have responded a few hundred ms later.
    //
    // This test deterministically reproduces the race by spawning a synth
    // daemon that delays binding by SYNTH_BIND_DELAY_MS (1500ms) and using
    // a 500ms readiness timeout. Without the retry the diagnostic samples
    // are guaranteed to fire while the synth has not yet bound, so the
    // bundle reports errors. With the retry, the samples wait for the
    // late bind and surface 200 responses.
    // AC: @daemon-backed-test-fixture-contract ac-readiness-diagnostics
    // AC: @daemon-backed-test-fixture-contract ac-bounded-readiness
    // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
    // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
    // AC: @daemon-sensitive-cli-test-determinism ac-fixture-contract-tests
    it("retries diagnostic samples while the live child finishes binding", async () => {
      const scriptDir = await createTempDir("kspec-delayed-bind-daemon-");
      onTestFinished(async () => {
        await cleanupTempDir(scriptDir);
      });
      const synthPath = join(scriptDir, "delayed-bind-daemon.cjs");
      writeFileSync(synthPath, DELAYED_BIND_DAEMON_SOURCE);
      chmodSync(synthPath, 0o755);

      const project = await createTestDaemonProject();
      onTestFinished(async () => {
        await project.cleanup();
      });

      // Capture the live child handle so the test can force-kill the
      // synth on exit if a regression strands the listener.
      let observed: { child: ChildProcess; pid: number } | null = null;
      let registeredStop: (() => Promise<void>) | null = null;
      const startedAt = Date.now();
      const readinessTimeoutMs = 500;
      const synthBindDelayMs = 1_500;

      let thrown: unknown = null;
      try {
        await startTestDaemon(project, {
          __testBinaryOverride: synthPath,
          extraEnv: { SYNTH_BIND_DELAY_MS: String(synthBindDelayMs) },
          // Always-false probe — readiness must time out before the
          // synth's bind delay elapses, so the diagnostic sample lands
          // during the unbound window.
          readiness: {
            mode: "custom",
            probe: () => ({ ok: false, details: "intentional probe rejection" }),
          },
          timeoutMs: readinessTimeoutMs,
          intervalMs: 50,
          __testObserveSpawn: ({ child }) => {
            observed = { child, pid: child.pid ?? -1 };
          },
          registerCleanup: (stop) => {
            registeredStop = stop;
          },
        });
      } catch (error) {
        thrown = error;
      }
      const elapsed = Date.now() - startedAt;

      onTestFinished(async () => {
        if (registeredStop) {
          try {
            await registeredStop();
          } catch {
            /* idempotent */
          }
        }
        if (observed) {
          const ref = observed as unknown as { pid: number };
          if (ref.pid > 0 && isProcessAlive(ref.pid)) {
            try {
              process.kill(ref.pid, "SIGKILL");
            } catch {
              /* already gone */
            }
          }
        }
      });

      expect(thrown).toBeInstanceOf(DaemonReadinessError);
      const error = thrown as DaemonReadinessError;
      const d = error.diagnostics;

      // The synth was alive throughout — readiness timed out only
      // because of the probe rejection. The retry budget must absorb the
      // bind delay and surface a successful sample for both endpoints.
      expect(d.lastHealth).not.toBeNull();
      if ("status" in d.lastHealth) {
        expect(d.lastHealth.status).toBe(200);
        expect(d.lastHealth.body).toContain('"status":"ok"');
      } else {
        throw new Error(
          `lastHealth must reflect the late-bound synth (got error=${d.lastHealth.error})`,
        );
      }
      expect(d.lastCacheStatus).not.toBeNull();
      if ("status" in d.lastCacheStatus) {
        expect(d.lastCacheStatus.status).toBe(200);
        expect(d.lastCacheStatus.body).toContain("projects");
      } else {
        throw new Error(
          `lastCacheStatus must reflect the late-bound synth (got error=${d.lastCacheStatus.error})`,
        );
      }

      // The retry budget is bounded — the failure path must not extend
      // beyond the readiness timeout plus the retry budget plus a small
      // observation slack. Pre-fix: ~readinessTimeoutMs (single fast
      // ECONNREFUSED, ~0ms). Post-fix: ~readinessTimeoutMs +
      // synthBindDelayMs + a few hundred ms for the retry that catches
      // the bind. The cap below proves the failure path stays bounded
      // even when the retry has to wait for the synth.
      expect(elapsed).toBeLessThan(15_000);
    });
  },
);

/**
 * Locate an OS PID that does not currently exist. We probe upward from
 * `process.pid + 1` because the kernel almost never re-uses the next
 * sequential PID immediately after the helper starts; if a probe hits an
 * occupied slot we step past it. The loop is bounded so a degenerate
 * environment (e.g. a system saturated with PIDs) still terminates.
 */
function findDeadPid(): number {
  let candidate = process.pid + 1;
  for (let i = 0; i < 256; i += 1) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as { code?: string }).code === "ESRCH") return candidate;
    }
    candidate += 1;
  }
  // Fall back to a sentinel that virtually no host will assign. The
  // recovery code only depends on `process.kill(pid, 0)` rejecting; any
  // unassigned slot satisfies that contract.
  return 0x7fff_ffff;
}

function makeIsolatedLockPath(label: string): string {
  return join(
    tmpdir(),
    `kspec-test-daemon-port-start-${label}-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.lock`,
  );
}

describe("acquireTestDaemonPortStartLock stale-holder recovery", () => {
  // The shared port startup lock is a filesystem primitive that survives
  // process death. Before the recovery fix, a SIGKILL/OOM that killed a
  // prior test runner mid-startup left a stale lock that blocked every
  // subsequent acquirer for the full 120s default timeout, surfacing as
  // the cluster of "timed out" failures recorded in
  // @stabilize-daemon-fixture-cleanup-tests-timing-out. The regressions
  // below pin the new contract: acquisition reaches a bounded terminal
  // outcome when the recorded holder no longer exists, regardless of
  // whether the leftover was the current file format or a legacy
  // directory-only artifact from earlier helper versions.

  // AC: @daemon-test-teardown-boundedness ac-shared-startup-lock-recovers-from-crashed-holder
  it("reclaims the lock when the recorded holder PID is no longer alive", async () => {
    const lockPath = makeIsolatedLockPath("dead-pid");
    onTestFinished(() => {
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    });

    const deadPid = findDeadPid();
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        hostname: hostname(),
        startedAt: Date.now() - 60_000,
      }),
    );

    const startedAt = Date.now();
    const release = await acquireTestDaemonPortStartLock(2_000, { __testLockPath: lockPath });
    const elapsed = Date.now() - startedAt;

    try {
      // ac-shared-startup-lock-recovers-from-crashed-holder — bounded
      // outcome. The recovery path checks for stale holders every poll
      // tick after a short grace window, so reclaim should complete in
      // hundreds of milliseconds — well under the 2s budget we passed
      // in. The pre-fix implementation would have blocked for the full
      // 2s timeout and rejected.
      expect(elapsed).toBeLessThan(1_500);

      // The lock file now belongs to us — owner metadata reflects this
      // process and the file is parseable JSON.
      // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- Lock owner info written by acquireTestDaemonPortStartLock; this is test-generated output, not project source.
      const ownerContents = readFileSync(lockPath, "utf-8");
      const owner = JSON.parse(ownerContents) as {
        pid: number;
        hostname: string;
        startedAt: number;
      };
      expect(owner.pid).toBe(process.pid);
      expect(owner.hostname).toBe(hostname());
    } finally {
      release();
    }

    // Release dropped the lock file so a subsequent acquirer would not
    // observe contention from this test.
    expect(existsSync(lockPath)).toBe(false);
  });

  // AC: @daemon-test-teardown-boundedness ac-shared-startup-lock-recovers-from-crashed-holder
  it("reclaims a legacy mkdir-only directory left behind by a prior helper version", async () => {
    const lockPath = makeIsolatedLockPath("legacy-dir");
    onTestFinished(() => {
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    });

    // The prior helper implementation used `mkdirSync(lockPath)` as the
    // atomic acquisition primitive and never wrote owner content. A
    // crashed prior process leaves an empty directory at the lock path,
    // and the new file-based recovery must clear it.
    mkdirSync(lockPath);
    expect(statSync(lockPath).isDirectory()).toBe(true);

    const startedAt = Date.now();
    const release = await acquireTestDaemonPortStartLock(2_000, { __testLockPath: lockPath });
    const elapsed = Date.now() - startedAt;

    try {
      // ac-shared-startup-lock-recovers-from-crashed-holder — legacy
      // leftover is a stale resource even without owner content because
      // the path persists across process death. Recovery must remove it
      // within the bounded budget.
      expect(elapsed).toBeLessThan(1_500);

      // The path is now our file, not the legacy directory.
      const stat = statSync(lockPath);
      expect(stat.isFile()).toBe(true);
    } finally {
      release();
    }

    expect(existsSync(lockPath)).toBe(false);
  });

  // AC: @daemon-test-teardown-boundedness ac-shared-startup-lock-recovers-from-crashed-holder
  it("does not evict a live holder — the bounded deadline still governs", async () => {
    const lockPath = makeIsolatedLockPath("live-holder");
    onTestFinished(() => {
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    });

    // The recovery path must short-circuit when the recorded holder is
    // alive, even when the recorded PID looks "old". We record this
    // process as the holder — `process.kill(pid, 0)` always succeeds for
    // ourselves, so liveness detection cannot misclassify us as stale.
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        startedAt: Date.now() - 60_000,
      }),
    );

    const startedAt = Date.now();
    let thrown: unknown = null;
    try {
      const release = await acquireTestDaemonPortStartLock(500, { __testLockPath: lockPath });
      // Defensive: if acquisition unexpectedly succeeded, release so the
      // test cleanup is consistent before the assertion below fails.
      release();
    } catch (error) {
      thrown = error;
    }
    const elapsed = Date.now() - startedAt;

    // ac-shared-startup-lock-recovers-from-crashed-holder — recovery
    // must not race-evict a live holder. The acquire honors the
    // configured 500ms budget and surfaces the timeout once the live
    // holder remains in place. Pre-fix the timeout would also reject
    // (live holder still blocks), but a regression that incorrectly
    // treated live holders as stale would surface here by *succeeding*
    // acquisition with `thrown === null`.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Timed out");
    expect((thrown as Error).message).toContain(`pid=${process.pid}`);

    // Bounded: still respects the deadline. We allow generous slack
    // because the recovery loop polls every 25ms.
    expect(elapsed).toBeLessThan(2_000);
    expect(elapsed).toBeGreaterThanOrEqual(500);

    // The live holder's lock file remains intact.
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- Lock owner info written by the test itself; this is test-generated output, not project source.
    const ownerContents = readFileSync(lockPath, "utf-8");
    const owner = JSON.parse(ownerContents) as { pid: number };
    expect(owner.pid).toBe(process.pid);
  });
});

describe("registerPortStartLockExitHandlers signal-handler boundedness", () => {
  // The port-start-lock exit handlers install per-signal cleanup that releases
  // active locks then re-raises the signal so the process exits with the
  // signal-appropriate disposition. The handler MUST remove itself from
  // process.listeners before re-raising — Node suppresses default termination
  // while a listener is installed, so a re-raise that re-enters this same
  // handler would loop indefinitely. That recursion would leave any test
  // runner holding the port-start lock unable to terminate under SIGTERM,
  // violating the bounded-teardown contract for daemon-backed test
  // infrastructure that owns this lock.

  // AC: @daemon-test-teardown-boundedness ac-uncooperative-process-stop-is-bounded
  it("removes itself from process listeners and calls release exactly once before re-raising", () => {
    // Use SIGUSR2 to avoid colliding with vitest's own signal handling and
    // any other listeners on the test runner process.
    let releaseCalls = 0;
    const reRaised: NodeJS.Signals[] = [];
    const handler = __createPortStartLockSignalHandler(
      "SIGUSR2",
      () => {
        releaseCalls++;
      },
      (sig) => {
        reRaised.push(sig);
      },
    );

    onTestFinished(() => {
      // Defensive: if an assertion fails before the handler removes itself,
      // remove it here so SIGUSR2 from another source cannot affect the
      // test runner after this test exits.
      process.removeListener("SIGUSR2", handler);
    });

    process.on("SIGUSR2", handler);
    expect(process.listeners("SIGUSR2")).toContain(handler);

    // Invoke the handler directly to simulate the signal arrival without
    // actually sending SIGUSR2 (which would race other listeners).
    handler();

    // ac-uncooperative-process-stop-is-bounded — bounded outcome requires
    // that the handler does not re-enter itself. Removing the listener
    // before re-raise is what guarantees the re-raise hits default
    // disposition (process exit) instead of looping back into this
    // handler. Pre-fix this expectation fails because the unnamed
    // arrow handler had no removal step.
    expect(process.listeners("SIGUSR2")).not.toContain(handler);
    expect(releaseCalls).toBe(1);
    expect(reRaised).toEqual(["SIGUSR2"]);
  });

  // AC: @daemon-test-teardown-boundedness ac-uncooperative-process-stop-is-bounded
  it("a subprocess that mirrors the registration pattern reaches a bounded terminal outcome under SIGTERM", async () => {
    // End-to-end proof: spawn a Node subprocess that installs the same
    // remove-then-re-raise handler shape used by
    // registerPortStartLockExitHandlers, signal it with SIGTERM, and
    // assert that it exits via the signal disposition within a bounded
    // budget. Pre-fix (unnamed arrow handler that re-raises without
    // removal) this subprocess loops indefinitely and is only killed by
    // the test's SIGKILL escalation. Post-fix the subprocess exits
    // promptly with signalCode === 'SIGTERM'.
    //
    // The subprocess is intentionally a small JS replica rather than an
    // import of the real helper because the helper is TypeScript and the
    // test runner already covers the in-process handler factory above.
    // Drift risk is low: any future change to the production pattern
    // that breaks the boundedness contract would still surface as either
    // a subprocess hang here or a failure in the handler factory test.
    const scriptDir = await createTempDir("kspec-signal-handler-bounded-");
    onTestFinished(async () => {
      await cleanupTempDir(scriptDir);
    });
    const scriptPath = join(scriptDir, "signal-handler-bounded.cjs");
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of signals) {
  const handler = () => {
    process.removeListener(signal, handler);
    // Mirrors the production handler: re-raise after removal so the
    // signal hits default disposition instead of re-entering.
    process.kill(process.pid, signal);
  };
  process.on(signal, handler);
}
process.stdout.write("ready\\n");
setInterval(() => {}, 60_000);
`,
    );
    chmodSync(scriptPath, 0o755);

    const child = spawn("node", [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    });

    // Wait for the subprocess to install its handlers before signaling.
    await new Promise<void>((resolveReady, rejectReady) => {
      const readyTimer = setTimeout(() => {
        rejectReady(new Error("subprocess never wrote ready handshake"));
      }, 3_000);
      let buf = "";
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString();
        if (buf.includes("ready")) {
          clearTimeout(readyTimer);
          child.stdout?.off("data", onData);
          resolveReady();
        }
      };
      child.stdout?.on("data", onData);
    });

    // Capture exit before sending the signal so we have a stable
    // observation point for the bounded assertion.
    const exitObservation = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit) => {
      child.on("exit", (code, signal) => {
        resolveExit({ code, signal });
      });
    });

    const signaledAt = Date.now();
    child.kill("SIGTERM");

    // ac-uncooperative-process-stop-is-bounded — the bounded contract
    // requires that the subprocess terminate within a finite budget.
    // 5s is generous enough for slow CI without masking a regression
    // that would hang. Pre-fix the subprocess would never exit on its
    // own under SIGTERM (it would loop until SIGKILLed at teardown).
    const exit = await Promise.race([
      exitObservation,
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((_, rejectTimeout) => {
        setTimeout(() => {
          rejectTimeout(
            new Error(
              `subprocess did not exit within 5s of SIGTERM (still running with pid=${child.pid})`,
            ),
          );
        }, 5_000);
      }),
    ]);
    const elapsed = Date.now() - signaledAt;

    expect(elapsed).toBeLessThan(5_000);
    // Re-raise after removal must let the signal reach default
    // disposition: the child terminates via the signal, not via a
    // graceful process.exit. signalCode reflects this.
    expect(exit.signal).toBe("SIGTERM");
  });
});
