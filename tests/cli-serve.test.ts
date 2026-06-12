/**
 * E2E tests for kspec serve CLI commands
 * Spec: @cli-serve-commands
 */

import { describe, it, expect, beforeEach, afterEach, onTestFinished } from "vitest";
import {
  createTempDir,
  cleanupTempDir,
  createIsolatedKspecHome,
  initGitRepo,
  CLI_PATH,
  kspec,
  readTestOutputSync,
  waitForStartup,
  type KspecOptions,
} from "./helpers/cli";
import { createTestDaemonProject, startTestDaemon } from "./helpers/daemon.js";
import { boundedDaemonFetch } from "./helpers/daemon-fetch.js";
import { stopChildProcessBounded, stopPidBounded } from "./helpers/process-stop.js";
import {
  resolveDaemonClientEndpoint,
  type DaemonClientEndpoint,
} from "../src/daemon-shared/endpoint.js";
import { spawn, spawnSync, execSync } from "child_process";
import { once } from "events";
import { dirname, join } from "path";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { createServer } from "net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "child_process";

/**
 * Probe whether a process is still alive without sending a real signal.
 *
 * Used by bounded-stop contract tests to assert the cleanup helpers observe
 * actual process termination rather than reporting success from a timeout
 * callback while the OS-visible pid still exists.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synthetic uncooperative-child source for bounded-stop contract tests.
 *
 * Installs no-op SIGTERM / SIGINT / SIGHUP handlers so the only signal that
 * actually terminates the process is SIGKILL, then writes one "ready" line
 * to stdout. Tests MUST wait for that line before sending any signals —
 * without the handshake, a too-fast SIGTERM races the script's
 * signal-handler installation and hits the default terminate action,
 * masking the bug under test.
 */
const UNCOOPERATIVE_CHILD_SOURCE = `#!/usr/bin/env node
process.on("SIGTERM", () => { /* swallow */ });
process.on("SIGINT", () => { /* swallow */ });
process.on("SIGHUP", () => { /* swallow */ });
process.stdout.write("ready\\n");
setInterval(() => {}, 60_000);
`;

/**
 * Cooperative-child source that the parent terminates by signal.
 *
 * No signal handlers installed; the test sends SIGKILL after waiting for
 * the "ready" handshake so the parent's ChildProcess handle observes
 * exit-by-signal (exitCode === null, signalCode === 'SIGKILL'). Used by
 * the signal-exit-race regression to probe the cleanup helper's
 * already-exited fast-path.
 */
const SIGNAL_EXIT_CHILD_SOURCE = `#!/usr/bin/env node
process.stdout.write("ready\\n");
setInterval(() => {}, 60_000);
`;

/**
 * Wait for a spawned synthetic child to write its handshake line.
 *
 * Returns after the child writes "ready\\n" to stdout, or throws if the
 * child exits unexpectedly. Bounded by `timeoutMs` so a stuck child does
 * not hang the suite.
 */
function waitForSynthReady(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
      if (buf.includes("ready")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error(`synth child exited before ready: stdout=${buf}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`synth child did not write ready within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

/**
 * Stop a process by PID within bounded time, observing termination before
 * returning. Routes through the shared bounded process-stop primitive so an
 * uncooperative child does not survive cleanup. Used in `onTestFinished`
 * callbacks — vitest awaits returned promises, so the cleanup contract
 * holds across assertion failures and timeouts.
 *
 * Idempotent: an already-reaped pid is a no-op rather than an error, so a
 * second call after a regression cannot signal an unrelated process that
 * has taken over the pid.
 */
function killPid(pid: number): Promise<void> {
  return stopPidBounded(pid, { label: "kspec serve daemon pid" });
}

/**
 * Resolve the daemon client endpoint reported by a CLI-started daemon.
 *
 * Reads daemon.connection.json (or the legacy daemon.port fallback) from the
 * isolated kspec config dir using the same production resolver real clients
 * use. Lifecycle tests that started a daemon via `kspec serve start --detach`
 * call this helper instead of building `http://localhost:${port}` so HTTP and
 * WebSocket fetches address the daemon at the URL it advertises (honoring
 * IPv6 fallback, configured connect_host, and the default 127.0.0.1 host).
 *
 * AC: @cli-lifecycle-test-endpoint-consumption ac-lifecycle-helper-resolves-client-endpoint
 * AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
 */
function resolveCliLifecycleDaemonEndpoint(configDir: string): DaemonClientEndpoint {
  const endpoint = resolveDaemonClientEndpoint(configDir);
  if (!endpoint) {
    throw new Error(
      `No daemon connection metadata or legacy port file found at ${configDir}; ` +
        `kspec serve start --detach must have written lifecycle state before ` +
        `this helper resolves the client endpoint.`,
    );
  }
  return endpoint;
}

/**
 * Wait for a ChildProcess to be observed terminated, with SIGKILL escalation
 * after the configured graceful budget.
 *
 * Routes through the shared bounded process-stop primitive: the helper
 * checks both `exitCode` and `signalCode` for an observed exit (so a child
 * already terminated by signal returns immediately rather than falling
 * through to the full poll timeout), and waits for libuv's 'exit' event
 * after escalation before resolving. Cleanup never reports success while
 * the child handle is still observably running.
 *
 * `timeoutMs` is the graceful budget. Escalation adds a bounded tail wait
 * for the SIGKILL exit observation, capped by the primitive's default.
 */
function waitForChildExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  return stopChildProcessBounded(child, {
    gracefulMs: timeoutMs,
    label: "cli-serve child process",
  });
}

// Check if Node runtime is available.
let nodeAvailable = false;
try {
  execSync("which node", { stdio: "pipe" });
  nodeAvailable = true;
} catch {
  console.log(
    "⊘ Node runtime not available - skipping daemon tests requiring actual daemon process",
  );
}

describe("kspec serve commands", () => {
  let tempDir: string;
  let isolatedHome: string;
  let testEnv: Record<string, string>;
  let globalPidFilePath: string;
  let globalPortFilePath: string;

  async function getAvailablePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("Failed to allocate ephemeral port")));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(port);
        });
      });
    });
  }

  function runKspec(args: string, cwd = tempDir, options: KspecOptions = {}) {
    return kspec(args, cwd, {
      ...options,
      env: { ...testEnv, ...options.env },
    });
  }

  function readProcessCommand(pid: number): string {
    return execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8" }).trim();
  }

  async function waitForDaemonHealth(configDir?: string): Promise<DaemonClientEndpoint> {
    const dir = configDir ?? join(isolatedHome, ".config", "kspec");
    const endpoint = resolveCliLifecycleDaemonEndpoint(dir);
    await waitForStartup(
      `daemon health endpoint at ${endpoint.apiUrl}`,
      async () => {
        const url = `${endpoint.apiUrl}/api/health`;
        // Bounded probe: AbortSignal.timeout caps the request so a daemon
        // that accepts the connection but stalls mid-response cannot pin
        // the readiness wait to the OS TCP timeout (~75s on Linux).
        // AC: @daemon-test-teardown-boundedness ac-daemon-observations-are-bounded
        try {
          const response = await boundedDaemonFetch(url, { timeoutMs: 2_000 });
          const body = (await response.text()).trim();
          const bodyReportsHealthy = body.includes('"status":"ok"');
          return {
            ok: response.ok || bodyReportsHealthy,
            details: `status=${response.status} body=${body || "<empty>"}`,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, details: `fetch error=${message}` };
        }
      },
      { timeoutMs: 10_000 },
    );
    return endpoint;
  }

  async function waitForDaemonUptime(minUptimeSeconds: number): Promise<void> {
    await waitForStartup(
      `daemon uptime >= ${minUptimeSeconds}s`,
      async () => {
        const result = runKspec(
          `serve status --json --kspec-dir ${join(tempDir, ".kspec")}`,
          tempDir,
          {
            expectFail: true,
          },
        );
        if (result.exitCode !== 0) {
          return {
            ok: false,
            details: `exit=${result.exitCode} stderr=${result.stderr || "<empty>"}`,
          };
        }

        try {
          const status = JSON.parse(result.stdout);
          const uptime = typeof status.uptime === "number" ? status.uptime : -1;
          return {
            ok: uptime >= minUptimeSeconds,
            details: `running=${Boolean(status.running)} uptime=${uptime}`,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, details: `invalid-json=${message}` };
        }
      },
      { timeoutMs: 10_000 },
    );
  }

  beforeEach(async () => {
    tempDir = await createTempDir();
    await initGitRepo(tempDir);
    mkdirSync(join(tempDir, ".kspec"), { recursive: true });
    const isolated = await createIsolatedKspecHome(tempDir);
    isolatedHome = isolated.homeDir;
    testEnv = isolated.env;
    globalPidFilePath = isolated.daemonPidFilePath;
    globalPortFilePath = isolated.daemonPortFilePath;

    // Ensure this test HOME starts from clean daemon state.
    try {
      runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
    } catch {
      // Ignore: this is best-effort cleanup.
    }
  });

  afterEach(async () => {
    // Stop daemon scoped to isolated HOME so we never touch ambient daemon state.
    try {
      runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir, { expectFail: true });
    } catch {
      // Ignore cleanup errors
    }

    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-sensitive-cli-test-determinism ac-readiness-diagnostics
  it("should include actionable context when readiness wait times out", async () => {
    await expect(
      waitForStartup(
        "synthetic daemon readiness",
        async () => ({ ok: false, details: "status=503 body=warming-up" }),
        { timeoutMs: 120, intervalMs: 20 },
      ),
    ).rejects.toThrow(/Last observation: status=503 body=warming-up/);
  });

  // AC: @daemon-test-teardown-boundedness ac-daemon-observations-are-bounded
  // AC: @daemon-backed-test-fixture-contract ac-bounded-readiness
  // AC: @daemon-sensitive-cli-test-determinism ac-readiness-diagnostics
  // Positive contract lock for the bounded daemon-fetch helper that
  // `waitForDaemonHealth` and the representative `/api/health` /
  // `/api/projects` call sites in this file now adopt. The previous
  // FAILING-BEFORE-FIX shape used a bare `fetch(url)` to lock the gap;
  // the companion fix introduces `boundedDaemonFetch` so daemon-facing
  // probes never wait past the caller's budget. A small inline hang
  // server simulates a daemon that accepts the connection but stalls
  // mid-handler.
  it("bounded daemon fetch to /api/health reaches a bounded outcome when the endpoint stalls", async () => {
    const hangServer: HttpServer = createHttpServer(() => {
      // Accept the connection but never write a response — mirrors a
      // daemon that has bound its listener but stalled mid-handler.
    });
    const hangServerPort = await new Promise<number>((resolveListen, rejectListen) => {
      hangServer.once("error", rejectListen);
      hangServer.listen(0, "127.0.0.1", () => {
        const addr = hangServer.address() as AddressInfo | null;
        if (!addr) {
          rejectListen(new Error("hang server failed to allocate port"));
          return;
        }
        resolveListen(addr.port);
      });
    });

    const cleanupController = new AbortController();
    onTestFinished(async () => {
      cleanupController.abort();
      // Force-close any lingering sockets so the hang server can finalize
      // its close even if the bounded fetch was already aborted internally.
      await new Promise<void>((resolveClose) => {
        hangServer.closeAllConnections?.();
        hangServer.close(() => resolveClose());
      });
    });

    // Use the shared bounded helper exactly as the daemon-facing
    // call sites in this suite now do. The helper's internal
    // `AbortSignal.timeout` aborts the request within `timeoutMs`,
    // so the outer race timer never fires.
    const HELPER_TIMEOUT_MS = 200;
    const BUDGET_MS = 800;
    const startedAt = Date.now();
    const outcome = await Promise.race([
      boundedDaemonFetch(`http://127.0.0.1:${hangServerPort}/api/health`, {
        timeoutMs: HELPER_TIMEOUT_MS,
        signal: cleanupController.signal,
      })
        .then(() => "responded" as const)
        .catch(() => "errored" as const),
      new Promise<"timeout">((resolveTimeout) =>
        setTimeout(() => resolveTimeout("timeout"), BUDGET_MS),
      ),
    ]);
    const elapsed = Date.now() - startedAt;

    // ac-daemon-observations-are-bounded: the bounded helper aborts
    // the request internally, so the consumer observes an "errored"
    // outcome well inside the outer budget. A "timeout" would mean
    // the helper failed to enforce its own bound.
    expect(outcome).toBe("errored");
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  // AC: @cli-serve-commands ac-1
  // AC: @daemon-server ac-12
  it("should start in foreground mode with Ctrl+C support", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    // Use a unique port for this test
    const port = await getAvailablePort();

    // Spawn kspec serve in foreground
    // Strip KSPEC_SESSION_ID to prevent dispatch guard from blocking
    // when tests run inside an agent dispatch session
    const { KSPEC_SESSION_ID: _, ...cleanProcessEnv } = process.env;
    const child = spawn(
      "node",
      [
        join(__dirname, "../dist/cli/index.js"),
        "serve",
        "start",
        "--port",
        String(port),
        "--kspec-dir",
        join(tempDir, ".kspec"),
      ],
      {
        cwd: tempDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...cleanProcessEnv, ...testEnv },
      },
    );

    // Register cleanup before any assertion that could throw
    onTestFinished(async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await waitForChildExit(child);
      }
    });

    let output = "";
    child.stdout?.on("data", (data) => {
      output += data.toString();
    });

    child.stderr?.on("data", (data) => {
      output += data.toString();
    });

    // Wait for startup message (CI can be slower than local runs)
    const started = await new Promise<boolean>((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (output.includes("Starting server in foreground") && output.includes(`port ${port}`)) {
          clearInterval(interval);
          resolve(true);
          return;
        }
        if (Date.now() - start > 15_000 || child.exitCode !== null) {
          clearInterval(interval);
          resolve(false);
        }
      }, 100);
    });

    // oxlint-disable-next-line jest/valid-expect -- vitest supports custom message as 2nd arg
    expect(started, `foreground startup output missing:\n${output}`).toBe(true);

    // Send SIGINT (Ctrl+C)
    if (child.exitCode === null) {
      child.kill("SIGINT");
    }

    // Wait for shutdown
    if (child.exitCode === null) {
      await Promise.race([
        once(child, "exit"),
        waitForStartup(
          "foreground daemon child exit",
          async () => ({
            ok: child.exitCode !== null,
            details: `exitCode=${child.exitCode} killed=${child.killed}`,
          }),
          { timeoutMs: 10_000, intervalMs: 50 },
        ),
      ]);
    }

    // Graceful shutdown: process.exit(0) fires → exitCode === 0.
    // Signal-killed: node dies from SIGINT before the exit handler runs →
    //   exitCode === null, signalCode === 'SIGINT'.
    // Both are valid Ctrl+C outcomes; accept either.
    const exitedCleanly = child.exitCode === 0;
    const killedBySignal = child.exitCode === null && child.signalCode === "SIGINT";
    // oxlint-disable-next-line jest/valid-expect -- vitest supports custom message as 2nd arg
    expect(
      exitedCleanly || killedBySignal,
      `expected clean exit (0) or SIGINT kill, got exitCode=${child.exitCode} signalCode=${child.signalCode}`,
    ).toBe(true);
  });

  // AC: @cli-serve-commands ac-2
  // AC: @daemon-sensitive-cli-test-determinism ac-isolated-home-config
  it("should start in daemon mode and detach", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    const result = runKspec(
      `serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`,
      tempDir,
    );

    // Register PID-based cleanup before any assertion that could throw.
    // This test must use --detach (it tests the detach CLI path itself),
    // so we read the PID file and kill directly.
    const pid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    onTestFinished(() => killPid(pid));

    // Should report success
    expect(result.stdout).toContain("Daemon started");
    expect(result.stdout).toContain(`port ${port}`);

    // PID file should exist
    expect(existsSync(globalPidFilePath)).toBe(true);
    expect(existsSync(globalPortFilePath)).toBe(true);
    expect(globalPidFilePath.startsWith(isolatedHome)).toBe(true);
    expect(globalPortFilePath.startsWith(isolatedHome)).toBe(true);

    expect(pid).toBeGreaterThan(0);

    // Process should be running
    let processRunning = false;
    try {
      process.kill(pid, 0); // Signal 0 checks existence
      processRunning = true;
    } catch {
      processRunning = false;
    }
    expect(processRunning).toBe(true);

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @daemon-network-endpoint-contract ac-default-loopback-v4
  // AC: @daemon-network-endpoint-contract ac-connection-metadata
  // AC: @daemon-server ac-1
  // AC: @daemon-server ac-9
  // AC: @daemon-server ac-10
  // AC: @config-daemon ac-host-default
  // AC: @config-daemon ac-connection-metadata
  // AC: @trait-localhost-security ac-loopback-default
  it("writes daemon.connection.json with the resolved 127.0.0.1 endpoint on detached startup", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    runKspec(`serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const pid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    onTestFinished(() => killPid(pid));

    await waitForDaemonHealth();

    const metadataPath = join(isolatedHome, ".config", "kspec", "daemon.connection.json");
    expect(existsSync(metadataPath)).toBe(true);

    const metadata = JSON.parse(readTestOutputSync(metadataPath));
    expect(metadata).toMatchObject({
      pid,
      port,
      bind_host: "127.0.0.1",
      connect_host: "127.0.0.1",
      api_url: `http://127.0.0.1:${port}`,
      ws_url: `ws://127.0.0.1:${port}/ws`,
      runtime: "node",
    });

    // Daemon is bound on the resolved bind host (127.0.0.1), proven by a
    // health check that uses the IPv4 address directly rather than a name.
    const directIpv4Health = await boundedDaemonFetch(`http://127.0.0.1:${port}/api/health`);
    expect(directIpv4Health.ok).toBe(true);

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    // After stop, lifecycle files (including the metadata file) are removed.
    expect(existsSync(metadataPath)).toBe(false);
  });

  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  // AC: @cli-lifecycle-test-endpoint-consumption ac-direct-loopback-url-exception-is-endpoint-subject
  // Regression guard for cycle-4 reviewer blocker: the IPv6 fallback must
  // distinguish "IPv4 loopback unavailable" (the only condition the spec
  // permits fallback for) from "this port is taken on 127.0.0.1". A naive
  // implementation that treats all bind failures the same will silently
  // start a daemon on [::1]:PORT over a real port collision — masking the
  // conflict and starting on the wrong endpoint. End-to-end fallback for
  // genuine address_unavailable conditions (EADDRNOTAVAIL / EAFNOSUPPORT)
  // can't be reliably simulated without root; that path is exhaustively
  // covered by selectStartupBindHost unit tests in tests/daemon-endpoint.
  it("does NOT silently fall back to [::1] when the requested port is already in use on 127.0.0.1", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    // Pre-bind 127.0.0.1:PORT so the daemon's actual listen() will see
    // EADDRINUSE. The previous (incorrect) behavior would have probed,
    // observed any error, and silently switched to ::1. The fix must
    // surface the port conflict instead.
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen({ host: "127.0.0.1", port }, () => resolve());
    });
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          blocker.close(() => resolve());
        }),
    );

    // The detach parent polls for a live PID and may briefly report
    // success because PID/metadata files are written before the daemon's
    // app.listen() call fails. The parent's exit code is therefore not
    // a reliable signal — the daemon dies shortly after. The reliable
    // signal is what actually ends up bound on the network.
    runKspec(
      `serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`,
      tempDir,
      { expectFail: true },
    );

    // Best-effort PID cleanup in case the daemon child wrote a PID
    // file before its listen() call failed. Read the pid from the
    // file BEFORE registering cleanup so the closure captures a
    // concrete value at registration time (per
    // ac-detached-cleanup-bound-before-observation: the cleanup
    // callback must own the pid at registration so an intervening
    // assertion failure cannot leave it without a target). The
    // daemon parent does not return until either listen() succeeds
    // or fails, and the PID file is written before listen() is
    // attempted, so by the time runKspec returns above, the file
    // either exists with a usable pid or does not — there is no
    // post-return write window that would let a deferred read pick
    // up a pid we miss here.
    const stalePidText = existsSync(globalPidFilePath)
      ? readTestOutputSync(globalPidFilePath).trim()
      : "";
    const stalePid = stalePidText ? parseInt(stalePidText, 10) : NaN;
    onTestFinished(() => {
      if (Number.isFinite(stalePid) && stalePid > 0) {
        return killPid(stalePid);
      }
      return undefined;
    });

    // Direct behavioral proof of the fix: nothing should ever come up on
    // the IPv6 loopback at this port. With the cycle-4 bug, the daemon
    // would have silently bound [::1]:PORT — health check would succeed.
    // Poll briefly to make absolutely sure no late-binding sneaks in.
    const ipv6HealthChecked = await new Promise<boolean>((resolve) => {
      let elapsed = 0;
      const tick = async (): Promise<void> => {
        try {
          const response = await boundedDaemonFetch(`http://[::1]:${port}/api/health`, {
            timeoutMs: 1_000,
          });
          if (response.ok) {
            resolve(true);
            return;
          }
        } catch {
          // Connection refused or aborted — expected: nothing listening on [::1]:PORT.
        }
        elapsed += 200;
        if (elapsed >= 2000) {
          resolve(false);
          return;
        }
        setTimeout(() => void tick(), 200);
      };
      void tick();
    });
    expect(ipv6HealthChecked).toBe(false);

    // If metadata was written (server.ts writes metadata before listen()),
    // it must reflect the resolved IPv4 bind host — never silently
    // advertise [::1] over a real port collision.
    const metadataPath = join(isolatedHome, ".config", "kspec", "daemon.connection.json");
    if (existsSync(metadataPath)) {
      const metadata = JSON.parse(readTestOutputSync(metadataPath));
      expect(metadata.bind_host).toBe("127.0.0.1");
      expect(metadata.api_url).toBe(`http://127.0.0.1:${port}`);
    }
  });

  // AC: @daemon-network-endpoint-contract ac-connection-metadata
  // AC: @daemon-server ac-9
  // AC: @daemon-backed-test-fixture-contract ac-real-daemon-tests-use-shared-fixture
  // AC: @daemon-backed-test-fixture-contract ac-isolated-home-config
  // AC: @daemon-backed-test-fixture-contract ac-readiness-diagnostics
  // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
  // AC: @daemon-backed-test-fixture-contract ac-no-ambient-daemon-control
  // AC: @daemon-test-mode-boundaries ac-full-process-tests-use-real-daemon
  // Regression for cycle-1 reviewer blocker: Node's http.Server reports
  // bind errors (EADDRINUSE) asynchronously via its 'error' event, AFTER
  // app.listen() has already returned. Without an explicit listening-
  // success barrier, the daemon would write daemon.connection.json
  // before the bind actually succeeded — leaving clients pointed at an
  // api_url owned by a different process. The fix is to await the
  // underlying http.Server's 'listening' event before writing metadata.
  //
  // We start the daemon directly through the shared fixture (rather than
  // through `kspec serve start --detach`) so the test asserts on what
  // the daemon process itself does, without depending on the parent
  // CLI's polling timing or detach machinery. The fixture's readiness
  // failure path captures the daemon's exit code and stderr tail,
  // giving us the same observability the original direct-spawn provided.
  it("does NOT write connection metadata when listen() fails on EADDRINUSE", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    // Pre-bind 127.0.0.1:PORT so the daemon's actual listen() will fail
    // with EADDRINUSE asynchronously (after app.listen() has returned
    // synchronously without throwing).
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen({ host: "127.0.0.1", port }, () => resolve());
    });
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          blocker.close(() => resolve());
        }),
    );

    const project = await createTestDaemonProject({ skipFixtures: true });
    onTestFinished(async () => {
      await project.cleanup();
    });
    const metadataPath = join(project.isolatedHome.configDir, "daemon.connection.json");

    // Use a custom readiness probe that watches for the spawned daemon
    // to exit naturally. The shared fixture's default health probe would
    // try to fetch the pre-bound blocker port — the blocker is a raw TCP
    // server that accepts the connection but never responds, hanging the
    // health probe. The custom probe sidesteps that by waiting for the
    // daemon's own exit signal, which is the regression behavior under
    // test (daemon must exit on EADDRINUSE rather than write metadata).
    const started = await startTestDaemon(project, {
      port,
      readiness: {
        mode: "custom",
        probe: (ctx) => {
          if (ctx.child.exitCode !== null || ctx.child.signalCode) {
            return {
              ok: true,
              details: `child exited code=${ctx.child.exitCode ?? "<signal>"}`,
            };
          }
          return { ok: false, details: "child still running" };
        },
      },
      timeoutMs: 10_000,
      intervalMs: 50,
      registerCleanup: (stop) => {
        onTestFinished(async () => {
          await stop();
        });
      },
    });

    // The daemon must die (non-zero exit) when its bind fails. The
    // captured child handle and stderr tail give us the same observability
    // the original direct-spawn provided, without depending on the parent
    // CLI's polling timing or detach machinery.
    expect(started.child.exitCode).not.toBe(null);
    expect(started.child.exitCode).not.toBe(0);
    expect(started.stderrTail()).toMatch(/EADDRINUSE/);

    // The regression assertion: no daemon.connection.json may be
    // present after the daemon failed to bind. With the bug, the file
    // was written synchronously after app.listen() returned and
    // persisted past the child's exit, advertising an api_url that no
    // kspec process actually owns.
    expect(existsSync(metadataPath)).toBe(false);
  });

  // AC: @daemon-network-endpoint-contract ac-external-binding-warning
  // AC: @daemon-server ac-external-bind-warning
  // AC: @trait-localhost-security ac-external-warning
  // AC: @config-daemon ac-host-config
  it("surfaces external-binding warning from the parent CLI on detached starts", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    // Configure the daemon to bind to a wildcard address so the CLI
    // sees an externally-reachable bind host. We rely on the CLI to
    // surface the warning on stderr — the detached child has stdio
    // ignored, so any warning the child writes is invisible.
    writeFileSync(
      join(tempDir, "kspec.config.yaml"),
      ["daemon:", "  host: 0.0.0.0", `  port: ${port}`, ""].join("\n"),
      "utf-8",
    );

    const result = runKspec(
      `serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`,
      tempDir,
    );

    const pid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    onTestFinished(() => killPid(pid));

    expect(result.stderr).toMatch(/WARNING/i);
    expect(result.stderr).toContain("0.0.0.0");
    expect(result.stderr).toContain("non-loopback");

    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @daemon-network-endpoint-contract ac-external-binding-warning
  // AC: @daemon-server ac-external-bind-warning
  // AC: @trait-localhost-security ac-external-warning
  it("surfaces external-binding warning when serve status reports a non-loopback bind", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    writeFileSync(
      join(tempDir, "kspec.config.yaml"),
      ["daemon:", "  host: 0.0.0.0", `  port: ${port}`, ""].join("\n"),
      "utf-8",
    );

    runKspec(`serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const pid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    onTestFinished(() => killPid(pid));

    await waitForDaemonHealth();

    const status = runKspec(`serve status --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
    expect(status.stderr).toMatch(/WARNING/i);
    expect(status.stderr).toContain("0.0.0.0");

    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @daemon-network-endpoint-contract ac-external-connect-host-warning
  //
  // "localhost" is the non-loopback host value of choice here:
  // isLoopbackHost() deliberately recognizes only numeric loopback
  // addresses (no OS-resolver dependency), so a DNS name triggers the
  // warning while still resolving locally — the daemon stays reachable
  // for health checks and stop. A connect_host that differs from a
  // non-wildcard bind is rejected by resolveDaemonConnectHost, so the
  // wildcard bind is required for this configuration to be valid.
  it("surfaces connect-host warning from the parent CLI on detached starts", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    writeFileSync(
      join(tempDir, "kspec.config.yaml"),
      ["daemon:", "  host: 0.0.0.0", "  connect_host: localhost", `  port: ${port}`, ""].join("\n"),
      "utf-8",
    );

    const result = runKspec(
      `serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`,
      tempDir,
    );

    const pid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    onTestFinished(() => killPid(pid));

    expect(result.stderr).toMatch(/WARNING/i);
    expect(result.stderr).toMatch(/connect host is localhost/i);
    expect(result.stderr).toMatch(/accept requests addressed to localhost/i);

    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @daemon-network-endpoint-contract ac-external-connect-host-warning
  it("surfaces connect-host warning when serve status reports a non-loopback connect host", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    writeFileSync(
      join(tempDir, "kspec.config.yaml"),
      ["daemon:", "  host: 0.0.0.0", "  connect_host: localhost", `  port: ${port}`, ""].join("\n"),
      "utf-8",
    );

    runKspec(`serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const pid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    onTestFinished(() => killPid(pid));

    await waitForDaemonHealth();

    const status = runKspec(`serve status --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
    expect(status.stderr).toMatch(/WARNING/i);
    expect(status.stderr).toMatch(/connect host is localhost/i);

    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @daemon-network-endpoint-contract ac-external-connect-host-warning
  // Negative case: a loopback connect_host must not trigger the
  // connect-host warning on start or status. The wildcard bind keeps
  // the configuration valid (and its own bind warning proves stderr
  // warnings are flowing, so the absence assertion is meaningful).
  it("does not warn on a loopback connect host", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    writeFileSync(
      join(tempDir, "kspec.config.yaml"),
      ["daemon:", "  host: 0.0.0.0", "  connect_host: 127.0.0.1", `  port: ${port}`, ""].join("\n"),
      "utf-8",
    );

    const result = runKspec(
      `serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`,
      tempDir,
    );

    const pid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    onTestFinished(() => killPid(pid));

    // The bind warning still fires for the wildcard bind...
    expect(result.stderr).toContain("0.0.0.0");
    // ...but the connect-host warning must not.
    expect(result.stderr).not.toMatch(/connect host/i);

    await waitForDaemonHealth();

    const status = runKspec(`serve status --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
    expect(status.stderr).not.toMatch(/connect host/i);

    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @daemon-network-endpoint-contract ac-configured-bind-host
  // AC: @config-daemon ac-host-config
  // AC: @daemon-server ac-1
  // AC: @trait-localhost-security ac-external-host-explicit
  // AC: @cli-lifecycle-test-endpoint-consumption ac-direct-loopback-url-exception-is-endpoint-subject
  //
  // Regression for the IPv4/IPv6 mismatch incident: configured daemon.host
  // values must reach the production app.listen() call. A configured
  // NON-default, non-wildcard host (127.0.0.2 — a loopback alias on
  // Linux) flows through serve.ts → daemon child --host flag →
  // selectStartupBindHost → app.listen({ hostname }). The fact that the
  // daemon answers requests at 127.0.0.2 (and NOT the default 127.0.0.1)
  // is the strongest behavioral proof: a daemon bound only to 127.0.0.1
  // would refuse the 127.0.0.2 connection, and a daemon bound to ::1
  // would refuse it differently. The daemon binds exactly where the
  // configured host says.
  it("configured non-default daemon.host reaches the production listen call", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    // Probe whether 127.0.0.2 is locally addressable. Skip rather than
    // hard-fail on macOS / Windows that don't auto-alias the loopback range.
    const aliasAvailable = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => probe.close(() => resolve(false)));
      probe.once("listening", () => probe.close(() => resolve(true)));
      try {
        probe.listen({ host: "127.0.0.2", port: 0, exclusive: true });
      } catch {
        resolve(false);
      }
    });
    if (!aliasAvailable) {
      console.log("  ⊘ Skipping test - 127.0.0.2 loopback alias not available");
      return;
    }

    const port = await getAvailablePort();

    writeFileSync(
      join(tempDir, "kspec.config.yaml"),
      ["daemon:", "  host: 127.0.0.2", `  port: ${port}`, ""].join("\n"),
      "utf-8",
    );

    runKspec(`serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const pid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    onTestFinished(() => killPid(pid));

    // Wait for the daemon to be ready at the configured bind host.
    // Using the configured address proves the daemon listened there —
    // if app.listen() got 127.0.0.1 instead, this fetch would never
    // succeed because nothing is bound at 127.0.0.2:port.
    await waitForStartup(
      "daemon health endpoint at configured 127.0.0.2",
      async () => {
        try {
          const response = await boundedDaemonFetch(`http://127.0.0.2:${port}/api/health`, {
            timeoutMs: 2_000,
          });
          const body = (await response.text()).trim();
          return {
            ok: response.ok,
            details: `status=${response.status} body=${body || "<empty>"}`,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, details: `fetch error=${message}` };
        }
      },
      { timeoutMs: 10_000 },
    );

    // Negative proof: nothing at 127.0.0.1:port. If the daemon ignored
    // the configured host and bound to the default loopback, this would
    // succeed — and the test must catch that regression. Bounded so a
    // stalled (rather than refused) socket cannot pin teardown.
    let defaultLoopbackAccepted = false;
    try {
      const refused = await boundedDaemonFetch(`http://127.0.0.1:${port}/api/health`, {
        timeoutMs: 2_000,
      });
      defaultLoopbackAccepted = refused.ok;
    } catch {
      defaultLoopbackAccepted = false;
    }
    expect(defaultLoopbackAccepted).toBe(false);

    // Metadata reflects the configured bind host so clients honor it.
    const metadataPath = join(isolatedHome, ".config", "kspec", "daemon.connection.json");
    const metadata = JSON.parse(readTestOutputSync(metadataPath));
    expect(metadata.bind_host).toBe("127.0.0.2");
    expect(metadata.connect_host).toBe("127.0.0.2");
    expect(metadata.api_url).toBe(`http://127.0.0.2:${port}`);

    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @config-daemon ac-connect-host-config
  //
  // Behavioral end-to-end proof that the daemon's localhost-only middleware
  // accepts requests addressed to the metadata-advertised connect_host
  // when external binding is configured. Without this, a wildcard-bound
  // daemon with an explicit connect_host (e.g. 127.0.0.2 on a Linux host
  // that aliases all of 127.0.0.0/8) writes metadata clients honor but
  // serves them 403 Forbidden because the Host header doesn't match the
  // hardcoded localhost set. Probes 127.0.0.2 first so the test is a no-op
  // on platforms (macOS, Windows) that don't auto-alias the loopback range.
  it("accepts requests at the advertised connect_host when external binding is configured", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    // Probe whether 127.0.0.2 is locally addressable. On Linux every
    // address in 127.0.0.0/8 routes to loopback; macOS / Windows only
    // accept 127.0.0.1 by default. Skip rather than hard-fail so this
    // suite still runs on developer machines that lack the alias.
    const aliasAvailable = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => {
        probe.close(() => resolve(false));
      });
      probe.once("listening", () => {
        probe.close(() => resolve(true));
      });
      try {
        probe.listen({ host: "127.0.0.2", port: 0, exclusive: true });
      } catch {
        resolve(false);
      }
    });
    if (!aliasAvailable) {
      console.log("  ⊘ Skipping test - 127.0.0.2 loopback alias not available");
      return;
    }

    const port = await getAvailablePort();

    // Bind to wildcard so the daemon listens on every local interface;
    // advertise 127.0.0.2 as the connect host so clients call a
    // non-default loopback address. Both must be set for this scenario:
    // resolveDaemonConnectHost rejects connect_host that differs from a
    // specific (non-wildcard) bind_host because that URL would be
    // unreachable.
    writeFileSync(
      join(tempDir, "kspec.config.yaml"),
      ["daemon:", "  host: 0.0.0.0", "  connect_host: 127.0.0.2", `  port: ${port}`, ""].join("\n"),
      "utf-8",
    );

    runKspec(`serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const pid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    onTestFinished(() => killPid(pid));

    // Wait for the daemon to be ready via the advertised endpoint.
    await waitForStartup(
      `daemon health endpoint at advertised connect_host`,
      async () => {
        try {
          const response = await boundedDaemonFetch(`http://127.0.0.2:${port}/api/health`, {
            timeoutMs: 2_000,
          });
          const body = (await response.text()).trim();
          return {
            ok: response.ok,
            details: `status=${response.status} body=${body || "<empty>"}`,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, details: `fetch error=${message}` };
        }
      },
      { timeoutMs: 10_000 },
    );

    // Metadata reflects the explicit connect_host so clients honor it.
    const metadataPath = join(isolatedHome, ".config", "kspec", "daemon.connection.json");
    const metadata = JSON.parse(readTestOutputSync(metadataPath));
    expect(metadata.bind_host).toBe("0.0.0.0");
    expect(metadata.connect_host).toBe("127.0.0.2");
    expect(metadata.api_url).toBe(`http://127.0.0.2:${port}`);
    expect(metadata.ws_url).toBe(`ws://127.0.0.2:${port}/ws`);

    // The behavioral proof: a request whose Host header is the advertised
    // 127.0.0.2 must succeed. Before the middleware accepted additional
    // hosts, this came back 403 Forbidden even though metadata said the
    // URL was the canonical client endpoint.
    const advertised = await boundedDaemonFetch(`http://127.0.0.2:${port}/api/health`);
    expect(advertised.status).toBe(200);
    const advertisedBody = (await advertised.json()) as { status: string };
    expect(advertisedBody.status).toBe("ok");

    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @cli-serve-commands ac-3
  it("should accept custom port via --port flag", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const customPort = await getAvailablePort();

    // Must use --detach: tests CLI --port flag parsing and output
    const result = runKspec(
      `serve start --detach --port ${customPort} --kspec-dir ${join(tempDir, ".kspec")}`,
      tempDir,
    );

    // Register PID-based cleanup before assertions
    const pid = parseInt(readTestOutputSync(globalPidFilePath, "utf-8").trim(), 10);
    onTestFinished(() => killPid(pid));

    expect(result.stdout).toContain(`port ${customPort}`);

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @cli-serve-commands ac-4
  // AC: @daemon-server ac-12
  it("should send SIGTERM and wait for shutdown", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    // Must use --detach: tests the `serve stop` CLI command which depends on PID file
    runKspec(`serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const pid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    // Register PID-based cleanup before assertions, in case serve stop itself fails
    onTestFinished(() => killPid(pid));

    // Stop daemon
    const result = runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    expect(result.stdout).toContain("Stopping daemon");
    expect(result.stdout).toContain(`PID ${pid}`);
    expect(result.stdout).toContain("Daemon stopped");

    // The OS may not have fully reaped the process yet even though the
    // daemon's PID file has been removed.  Poll briefly to avoid a race
    // between SIGTERM delivery and process-table cleanup.
    let processRunning = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        process.kill(pid, 0);
      } catch {
        processRunning = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(processRunning).toBe(false);
  });

  // AC: @cli-serve-commands ac-5
  it("should return success when stopping non-running daemon (idempotent)", async () => {
    const result = runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Daemon not running");
  });

  // AC: @cli-serve-commands ac-6
  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-connection-metadata
  it("should return JSON status with process info, bind_host, connect_host, and runtime", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    // Start daemon (uses --detach so serve status can find PID file)
    const port = await getAvailablePort();
    runKspec(`serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const pid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    onTestFinished(() => killPid(pid));

    await waitForDaemonHealth();

    // Check status with --json flag
    const result = runKspec(`serve status --json --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    // Should output valid JSON with full endpoint metadata so daemon
    // clients (CLI, web UI, scripts) can read the same fields the daemon
    // advertises in daemon.connection.json.
    const status = JSON.parse(result.stdout);
    expect(status).toMatchObject({
      running: true,
      pid: pid,
      port,
      bind_host: "127.0.0.1",
      connect_host: "127.0.0.1",
      runtime: "node",
    });

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @cli-serve-commands ac-6
  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("should report bind_host, connect_host, and runtime in human-readable status", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();
    runKspec(`serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const pid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    onTestFinished(() => killPid(pid));

    await waitForDaemonHealth();

    const result = runKspec(`serve status --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
    expect(result.stdout).toContain("Bind host: 127.0.0.1");
    expect(result.stdout).toContain("Connect host: 127.0.0.1");
    expect(result.stdout).toContain("Runtime: node");

    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @multi-directory-daemon ac-12
  // AC: @daemon-sensitive-cli-test-determinism ac-bounded-readiness
  // AC: @cli-lifecycle-test-endpoint-consumption ac-cli-started-daemon-requests-use-reported-endpoint
  // AC: @cli-lifecycle-test-endpoint-consumption ac-lifecycle-helper-resolves-client-endpoint
  // AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
  // AC: @daemon-test-endpoint-consistency ac-no-localhost-by-default
  it("should show registered projects with paths in status output", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    // Start daemon (uses --detach so serve status can find PID file)
    runKspec(`serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const pid = parseInt(readTestOutputSync(globalPidFilePath, "utf-8").trim(), 10);
    onTestFinished(() => killPid(pid));

    const daemonEndpoint = await waitForDaemonHealth();

    // Register a project via API
    const testProjectPath = tempDir;
    await boundedDaemonFetch(`${daemonEndpoint.apiUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: testProjectPath }),
    });

    // Check status - should list registered projects
    const result = runKspec(`serve status --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    // Human-readable output should mention projects
    expect(result.stdout).toContain("Registered projects");
    expect(result.stdout).toContain(testProjectPath);
    expect(result.stdout).toContain("watcher:");

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @multi-directory-daemon ac-12
  it("should include projects list in JSON status output", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    // Start daemon (uses --detach so serve status can find PID file)
    runKspec(`serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const pid = parseInt(readTestOutputSync(globalPidFilePath, "utf-8").trim(), 10);
    onTestFinished(() => killPid(pid));

    const daemonEndpoint = await waitForDaemonHealth();

    // Register a project via API
    const testProjectPath = tempDir;
    await boundedDaemonFetch(`${daemonEndpoint.apiUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: testProjectPath }),
    });

    // Check status with --json
    const result = runKspec(`serve status --json --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const status = JSON.parse(result.stdout);
    expect(status).toHaveProperty("projects");
    expect(status.projects).toBeInstanceOf(Array);
    expect(status.projects.length).toBeGreaterThan(0);

    // Verify project details
    const project = status.projects.find((p: any) => p.path === testProjectPath);
    expect(project).toBeDefined();
    expect(project).toHaveProperty("path", testProjectPath);
    expect(project).toHaveProperty("registeredAt");
    expect(project).toHaveProperty("watcherStatus");

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @multi-directory-daemon ac-12
  it('should show "No projects registered" when no projects exist', async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    // Create temp directory WITHOUT .kspec/ to avoid auto-registration
    const emptyTempDir = await createTempDir();
    await initGitRepo(emptyTempDir);
    const isolated = await createIsolatedKspecHome(emptyTempDir);
    const env = isolated.env;

    const port = await getAvailablePort();

    // Start daemon from directory without .kspec/ (AC: @multi-directory-daemon ac-3)
    // This ensures no default project is registered
    runKspec(`serve start --detach --port ${port}`, emptyTempDir, { env });

    // AC2: This test uses its own isolated HOME, so the outer afterEach
    // cannot reach this daemon. Register cleanup targeting this daemon's PID.
    const pid = parseInt(readTestOutputSync(isolated.daemonPidFilePath, "utf-8").trim(), 10);
    onTestFinished(async () => {
      await killPid(pid);
      await cleanupTempDir(emptyTempDir);
    });

    await waitForDaemonHealth(isolated.configDir);

    // Check status - should indicate no projects
    const result = runKspec(`serve status`, emptyTempDir, { env });

    expect(result.stdout).toContain("No projects registered");

    // Cleanup
    runKspec(`serve stop`, emptyTempDir, { env });
  });

  // AC: @multi-directory-daemon ac-12
  it("should show uptime in status output", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    // Start daemon (uses --detach so serve status can find PID file)
    runKspec(`serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const pid = parseInt(readTestOutputSync(globalPidFilePath, "utf-8").trim(), 10);
    onTestFinished(() => killPid(pid));

    await waitForDaemonHealth();
    await waitForDaemonUptime(1);

    // Check status - should show uptime
    const result = runKspec(`serve status --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    expect(result.stdout).toContain("Uptime:");

    // Check JSON output includes uptime
    const jsonResult = runKspec(
      `serve status --json --kspec-dir ${join(tempDir, ".kspec")}`,
      tempDir,
    );
    const status = JSON.parse(jsonResult.stdout);
    expect(status).toHaveProperty("uptime");
    expect(typeof status.uptime).toBe("number");
    expect(status.uptime).toBeGreaterThan(0);

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @cli-serve-commands ac-7
  it("should stop then start on restart", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    // Must use --detach: tests the `serve restart` CLI command which uses PID files
    runKspec(`serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const originalPid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    // Kill original in case restart fails to stop it
    onTestFinished(() => killPid(originalPid));

    // Restart
    const result = runKspec(`serve restart --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    expect(result.stdout).toContain("Stopping daemon");
    expect(result.stdout).toContain("Starting daemon");

    // Should have new PID
    const newPid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    // Kill the new daemon on test exit
    onTestFinished(() => killPid(newPid));

    expect(newPid).not.toBe(originalPid);

    // New process should be running
    let processRunning = false;
    try {
      process.kill(newPid, 0);
      processRunning = true;
    } catch {
      processRunning = false;
    }
    expect(processRunning).toBe(true);

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @cli-serve-commands ac-10
  it("should show error with recovery hint for invalid port", async () => {
    const result = runKspec(
      `serve start --port 99999 --kspec-dir ${join(tempDir, ".kspec")}`,
      tempDir,
      { expectFail: true },
    );

    expect(result.exitCode).not.toBe(0);

    // Error and hint should be in stderr
    expect(result.stderr).toContain("Invalid port number");
    expect(result.stderr).toContain("Try: kspec serve --port");
  });

  // AC: @web-ui ac-1
  it("should start daemon from npm-installed package with all deps available", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    // Pack the project, install the tarball, then run the installed CLI's
    // `kspec serve start --detach` to verify all runtime dependencies
    // (elysia, @elysiajs/cors, @elysiajs/static) resolve at execution time.
    const projectRoot = join(__dirname, "..");
    const installDir = await createTempDir();

    try {
      // --ignore-scripts: prepack runs the full build (tsc, build:daemon,
      // rm -rf dist/web-ui), which would rewrite the live dist/ tree while
      // parallel vitest workers spawn `node dist/cli/index.js` — a race that
      // corrupts in-flight CLI module loads. The test runner's pre-test build
      // hook already guarantees dist/ reflects the current sources, so packing
      // the existing output still tests the current build.
      const packOutput = execSync(`npm pack --ignore-scripts --pack-destination ${installDir}`, {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const tarball = join(installDir, packOutput.split("\n").pop()!.trim());

      // Install the tarball into the temp dir (brings transitive deps)
      execSync(`npm init -y && npm install --no-save "${tarball}"`, {
        cwd: installDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      });

      // The installed CLI binary
      const installedCli = join(installDir, "node_modules", ".bin", "kspec");
      // oxlint-disable-next-line jest/valid-expect -- vitest supports custom message as 2nd arg
      expect(existsSync(installedCli), `installed CLI not found at ${installedCli}`).toBe(true);

      // Create a minimal .kspec/ directory so serve has something to point at
      const kspecDir = join(installDir, ".kspec");
      mkdirSync(kspecDir, { recursive: true });

      // Isolated HOME so PID/port files don't collide with real daemon
      const isolated = await createIsolatedKspecHome(installDir);
      const port = await getAvailablePort();

      // Strip KSPEC_SESSION_ID to prevent dispatch guard from blocking
      const { KSPEC_SESSION_ID: _, ...cleanProcessEnv } = process.env;

      // Must use --detach: tests the installed CLI's serve start command path
      const result = execSync(
        `"${installedCli}" serve start --detach --port ${port} --kspec-dir "${kspecDir}"`,
        {
          cwd: installDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 30_000,
          env: { ...cleanProcessEnv, ...isolated.env },
        },
      );

      // AC2: This test uses its own isolated HOME (installDir), so the outer
      // afterEach cannot reach this daemon. Register PID-based cleanup.
      if (existsSync(isolated.daemonPidFilePath)) {
        const pid = parseInt(readTestOutputSync(isolated.daemonPidFilePath, "utf-8").trim(), 10);
        onTestFinished(() => killPid(pid));
      }

      // Daemon should have started — output contains PID and port
      expect(result).toContain(`port ${port}`);

      const installedDaemonEndpoint = await waitForDaemonHealth(isolated.configDir);

      // Verify health endpoint responds (daemon is actually running with Elysia)
      const healthResponse = await boundedDaemonFetch(
        `${installedDaemonEndpoint.apiUrl}/api/health`,
      );
      // oxlint-disable-next-line jest/valid-expect -- vitest supports custom message as 2nd arg
      expect(healthResponse.ok, "daemon health endpoint should respond").toBe(true);
      const healthBody = (await healthResponse.json()) as { status: string; runtime: string };
      expect(healthBody).toHaveProperty("status", "ok");
      expect(healthBody).toHaveProperty("runtime", "node");

      // Cleanup: stop the daemon
      try {
        execSync(`"${installedCli}" serve stop --kspec-dir "${kspecDir}"`, {
          cwd: installDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10_000,
          env: { ...cleanProcessEnv, ...isolated.env },
        });
      } catch {
        // Best-effort cleanup; PID file has the PID if we need to kill manually
        const pidFile = isolated.daemonPidFilePath;
        if (existsSync(pidFile)) {
          try {
            const pid = parseInt(readTestOutputSync(pidFile).trim(), 10);
            process.kill(pid, "SIGTERM");
          } catch {
            /* ignore */
          }
        }
      }
    } finally {
      await cleanupTempDir(installDir);
    }
  }, 120_000);

  // AC: @web-ui ac-2
  it("should show clear error with Node install URL when the configured node runtime is not available", () => {
    // Build PATH that excludes node.
    const nodeDir = dirname(execSync("which node", { encoding: "utf-8" }).trim());
    const noNodePath = (process.env.PATH || "")
      .split(":")
      .filter((p) => {
        try {
          return p !== nodeDir && !existsSync(join(p, "node"));
        } catch {
          return true;
        }
      })
      .join(":");

    const { KSPEC_SESSION_ID: _sessionId, ...cleanProcessEnv } = process.env;
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "serve", "start", "--kspec-dir", join(tempDir, ".kspec")],
      {
        cwd: tempDir,
        encoding: "utf-8",
        env: { ...cleanProcessEnv, ...testEnv, PATH: noNodePath },
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Node runtime is required");
    expect(result.stdout).toContain("nodejs.org");
  });

  // AC: @daemon-runtime-adapter ac-default-node
  it("should default to spawning the daemon with node when no runtime is configured", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    // Must use --detach: tests runtime detection during CLI-driven daemon spawn
    const result = runKspec(
      `serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`,
      tempDir,
    );

    const pid = parseInt(readTestOutputSync(globalPidFilePath, "utf-8").trim(), 10);
    onTestFinished(() => killPid(pid));

    expect(result.exitCode).toBe(0);
    await waitForDaemonHealth();

    const status = JSON.parse(
      runKspec(`serve status --json --kspec-dir ${join(tempDir, ".kspec")}`, tempDir).stdout,
    ) as {
      running: boolean;
      pid: number | null;
    };

    expect(status.running).toBe(true);
    expect(status.pid).not.toBeNull();
    expect(readProcessCommand(status.pid as number)).toContain("node");

    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @web-ui ac-2
  it("should show Node install URL in JSON mode when the configured node runtime is not available", () => {
    // Build PATH that excludes node.
    const nodeDir = dirname(execSync("which node", { encoding: "utf-8" }).trim());
    const noNodePath = (process.env.PATH || "")
      .split(":")
      .filter((p) => {
        try {
          return p !== nodeDir && !existsSync(join(p, "node"));
        } catch {
          return true;
        }
      })
      .join(":");

    const { KSPEC_SESSION_ID: _sessionId, ...cleanProcessEnv } = process.env;
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "serve", "start", "--json", "--kspec-dir", join(tempDir, ".kspec")],
      {
        cwd: tempDir,
        encoding: "utf-8",
        env: { ...cleanProcessEnv, ...testEnv, PATH: noNodePath },
      },
    );

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse((result.stdout ?? "").trim());
    expect(parsed).toHaveProperty("error");
    expect(parsed.error).toContain("Node runtime is required");
    expect(parsed).toHaveProperty("hint");
    expect(parsed.hint).toContain("nodejs.org");
    expect(parsed).toHaveProperty("url");
    expect(parsed.url).toBe("https://nodejs.org/en/download");
  });

  // AC: @daemon-runtime-adapter ac-runtime-missing
  it("should report missing node runtime with installation guidance", () => {
    const nodeDir = dirname(execSync("which node", { encoding: "utf-8" }).trim());
    const noNodePath = (process.env.PATH || "")
      .split(":")
      .filter((p) => {
        try {
          return p !== nodeDir && !existsSync(join(p, "node"));
        } catch {
          return true;
        }
      })
      .join(":");

    writeFileSync(
      join(tempDir, "kspec.config.yaml"),
      ["daemon:", "  runtime: node", ""].join("\n"),
      "utf-8",
    );

    const { KSPEC_SESSION_ID: _sessionId, ...cleanProcessEnv } = process.env;
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "serve", "start", "--kspec-dir", join(tempDir, ".kspec")],
      {
        cwd: tempDir,
        encoding: "utf-8",
        env: { ...cleanProcessEnv, ...testEnv, PATH: noNodePath },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Node runtime is required");
    expect(result.stdout).toContain("nodejs.org");
  });

  // AC: @daemon-runtime-adapter ac-runtime-selection
  // AC: @daemon-runtime-adapter ac-http-parity
  it("should start via configured node runtime even when Bun is unavailable", async () => {
    const nodeDir = dirname(execSync("which node", { encoding: "utf-8" }).trim());
    const noBunPath = (process.env.PATH || "")
      .split(":")
      .filter((p) => {
        try {
          return !existsSync(join(p, "bun"));
        } catch {
          return true;
        }
      })
      .join(":");
    const pathWithNode = noBunPath.includes(nodeDir) ? noBunPath : `${nodeDir}:${noBunPath}`;
    const port = await getAvailablePort();

    writeFileSync(
      join(tempDir, "kspec.config.yaml"),
      ["daemon:", "  runtime: node", `  port: ${port}`, ""].join("\n"),
      "utf-8",
    );

    // Must use --detach: tests runtime selection during CLI-driven daemon spawn
    const result = runKspec(
      `serve start --detach --kspec-dir ${join(tempDir, ".kspec")}`,
      tempDir,
      { env: { PATH: pathWithNode } },
    );

    // AC5: Use process.kill directly for cleanup, not CLI subprocess
    // that depends on custom PATH resolution (which may fail silently).
    const pid = parseInt(readTestOutputSync(globalPidFilePath, "utf-8").trim(), 10);
    onTestFinished(() => killPid(pid));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`port ${port}`);

    const daemonEndpoint = await waitForDaemonHealth();

    const healthResponse = await boundedDaemonFetch(`${daemonEndpoint.apiUrl}/api/health`);
    expect(healthResponse.ok).toBe(true);
  });

  // AC: @cli-serve-commands ac-11
  describe("dispatch agent guard", () => {
    // AC: @trait-semantic-exit-codes ac-2 — validation error exit code
    it("should refuse serve start when KSPEC_SESSION_ID is set", async () => {
      const result = runKspec(`serve start --kspec-dir ${join(tempDir, ".kspec")}`, tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: "test-session-id" },
      });

      expect(result.exitCode).toBe(4); // VALIDATION_FAILED
      expect(result.stderr).toContain("Cannot start daemon from inside an agent invocation");
      expect(result.stderr).toContain("dispatch engine");
    });

    it("should refuse serve stop when KSPEC_SESSION_ID is set", async () => {
      const result = runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: "test-session-id" },
      });

      expect(result.exitCode).toBe(4); // VALIDATION_FAILED
      expect(result.stderr).toContain("Cannot stop daemon from inside an agent invocation");
      expect(result.stderr).toContain("dispatch engine");
    });

    it("should refuse serve restart when KSPEC_SESSION_ID is set", async () => {
      const result = runKspec(`serve restart --kspec-dir ${join(tempDir, ".kspec")}`, tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: "test-session-id" },
      });

      expect(result.exitCode).toBe(4); // VALIDATION_FAILED
      expect(result.stderr).toContain("Cannot restart daemon from inside an agent invocation");
      expect(result.stderr).toContain("dispatch engine");
    });

    // AC: @trait-json-output ac-3 — JSON error output for dispatch guard
    it("should output JSON error when guard triggers with --json", async () => {
      const result = runKspec(
        `serve start --json --kspec-dir ${join(tempDir, ".kspec")}`,
        tempDir,
        { expectFail: true, env: { KSPEC_SESSION_ID: "test-session-id" } },
      );

      expect(result.exitCode).toBe(4); // VALIDATION_FAILED
      const output = JSON.parse(result.stdout);
      expect(output).toHaveProperty("error");
      expect(output.error).toContain("Cannot start daemon");
      expect(output).toHaveProperty("reason");
      expect(output).toHaveProperty("suggestion");
    });
  });

  // Trait tests: @trait-json-output
  describe("JSON output mode", () => {
    // AC: @trait-json-output ac-1, ac-2
    it("should output valid JSON with --json for serve status", async () => {
      const result = runKspec(
        `serve status --json --kspec-dir ${join(tempDir, ".kspec")}`,
        tempDir,
      );

      // Should be valid JSON
      expect(() => JSON.parse(result.stdout)).not.toThrow();

      const output = JSON.parse(result.stdout);
      expect(output).toHaveProperty("running");
      expect(output).toHaveProperty("pid");
    });

    // AC: @trait-json-output ac-3, @trait-error-guidance ac-6
    it("should output errors as JSON with --json flag", async () => {
      const result = runKspec(
        `serve start --port 99999 --json --kspec-dir ${join(tempDir, ".kspec")}`,
        tempDir,
        { expectFail: true },
      );

      // Should be valid JSON
      expect(() => JSON.parse(result.stdout)).not.toThrow();

      const output = JSON.parse(result.stdout);
      expect(output).toHaveProperty("error");
      expect(output.error).toContain("Invalid port number");
      expect(output).toHaveProperty("hint");
      expect(output.hint).toContain("Try: kspec serve --port");
    });

    // AC: @trait-json-output ac-2
    it("should include all data in JSON mode that appears in human mode", async () => {
      if (!nodeAvailable) {
        console.log("  ⊘ Skipping test - Node runtime required");
        return;
      }

      const port = await getAvailablePort();

      // Start daemon (uses --detach so serve status can find PID file)
      runKspec(
        `serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`,
        tempDir,
      );

      const pid = parseInt(readTestOutputSync(globalPidFilePath, "utf-8").trim(), 10);
      onTestFinished(() => killPid(pid));

      // Compare JSON vs human output
      const humanResult = runKspec(`serve status --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
      const jsonResult = runKspec(
        `serve status --json --kspec-dir ${join(tempDir, ".kspec")}`,
        tempDir,
      );

      const jsonData = JSON.parse(jsonResult.stdout);

      // Human output should contain the same data
      expect(humanResult.stdout).toContain(String(jsonData.pid));
      expect(humanResult.stdout).toContain(jsonData.running ? "running" : "not running");

      // Cleanup
      runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
    });

    // AC: @trait-json-output ac-4
    it("should use @ prefix for references in JSON output", async () => {
      // serve commands don't output references, but we can verify the pattern if they did
      // This test ensures future additions follow the trait
      const result = runKspec(
        `serve status --json --kspec-dir ${join(tempDir, ".kspec")}`,
        tempDir,
      );
      const output = JSON.parse(result.stdout);

      // Defensive test: if refs are ever added, they should use @ prefix
      // For now, just verify JSON is valid and doesn't contain bare ULID prefixes like "01TASK"
      const jsonStr = JSON.stringify(output);
      expect(jsonStr).not.toMatch(/[^@]01[A-Z0-9]{6}/); // No bare ULID prefixes
    });

    // AC: @trait-json-output ac-5
    it("should use ISO 8601 timestamps in JSON output", async () => {
      // serve status doesn't currently include timestamps, but when it does they should be ISO 8601
      const result = runKspec(
        `serve status --json --kspec-dir ${join(tempDir, ".kspec")}`,
        tempDir,
      );
      const output = JSON.parse(result.stdout);

      // Defensive test for when uptime/timestamps are added
      if (output.started_at) {
        expect(output.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }
    });

    // AC: @trait-json-output ac-6
    it("should make --json take precedence over other format flags", async () => {
      // Test that --json always produces JSON even with other flags
      const result = runKspec(
        `serve status --json --kspec-dir ${join(tempDir, ".kspec")}`,
        tempDir,
      );

      // Should be valid JSON, not human-readable text
      expect(() => JSON.parse(result.stdout)).not.toThrow();

      // Should not contain human-readable markers
      expect(result.stdout).not.toContain("Daemon running");
      expect(result.stdout).not.toContain("Daemon not running");
    });
  });

  // Trait tests: @trait-semantic-exit-codes
  describe("Exit codes", () => {
    // AC: @trait-semantic-exit-codes ac-1
    it("should exit with code 0 on success", async () => {
      const result = runKspec(`serve status --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
      expect(result.exitCode).toBe(0);
    });

    // AC: @trait-semantic-exit-codes ac-2
    it("should exit with code 4 on validation errors", async () => {
      const result = runKspec(
        `serve start --port 99999 --kspec-dir ${join(tempDir, ".kspec")}`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    });

    // AC: @trait-semantic-exit-codes ac-5
    it("should exit with code 0 for idempotent operations", async () => {
      // Stopping non-running daemon should succeed
      const result = runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
      expect(result.exitCode).toBe(0);
    });
  });
});

/**
 * Bounded-stop contract tests for the PID-based and ChildProcess-based
 * cleanup helpers used by CLI lifecycle tests.
 *
 * These tests own their own synthetic children — no real daemon, no
 * isolated home, no shadow worktree — so the only behavior under
 * observation is the cleanup helper's stop semantics.
 *
 * Each helper now routes through the shared bounded process-stop
 * primitive (tests/helpers/process-stop.ts):
 *
 *   - `waitForChildExit(child, timeoutMs)` waits for an observed exit
 *     on the handle (exitCode OR signalCode non-null OR 'exit' event
 *     fired), escalates to SIGKILL after the graceful budget, and only
 *     resolves once the resulting exit observation lands.
 *
 *   - `killPid(pid)` sends SIGTERM, polls for the pid to be reaped
 *     within the graceful budget, escalates to SIGKILL, and continues
 *     polling until the OS-visible pid is gone or the escalation budget
 *     elapses.
 *
 * Cleanup never reports success while the owned process is still
 * observably running.
 */
describe(
  "PID-based cleanup contract — observes termination before return",
  { timeout: 20_000 },
  () => {
    let scriptDir: string;
    let uncooperativePath: string;
    let signalExitPath: string;

    beforeEach(async () => {
      scriptDir = await createTempDir("kspec-cli-bounded-stop-");
      uncooperativePath = join(scriptDir, "uncooperative.cjs");
      signalExitPath = join(scriptDir, "signal-exit.cjs");
      writeFileSync(uncooperativePath, UNCOOPERATIVE_CHILD_SOURCE);
      chmodSync(uncooperativePath, 0o755);
      writeFileSync(signalExitPath, SIGNAL_EXIT_CHILD_SOURCE);
      chmodSync(signalExitPath, 0o755);
    });

    afterEach(async () => {
      await cleanupTempDir(scriptDir);
    });

    // AC: @daemon-test-teardown-boundedness ac-stop-observes-termination-before-return
    // AC: @daemon-test-teardown-boundedness ac-uncooperative-process-stop-is-bounded
    // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
    //
    // waitForChildExit on a SIGTERM-ignoring child must escalate to
    // SIGKILL AND wait for the resulting exit event. The current bug
    // resolves from the timer callback synchronously after kill("SIGKILL"),
    // before libuv surfaces the exit event — leaving exitCode/signalCode
    // null and the pid potentially still in the OS process table.
    it("waitForChildExit does not resolve until uncooperative child exit observed", async () => {
      const child = spawn(uncooperativePath, [], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = child.pid;
      expect(pid).toBeDefined();
      expect(pid).toBeGreaterThan(0);

      // Belt-and-suspenders force-kill so a regression cannot strand a
      // synthetic daemon-like process between runs.
      onTestFinished(() => {
        if (pid !== undefined && isProcessAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      });

      // Wait for the synth handshake so the SIGTERM handler is
      // guaranteed installed before we signal. Without this, a too-fast
      // SIGTERM hits the default terminate action and masks the bug.
      await waitForSynthReady(child);

      // Send the initial SIGTERM directly (synth ignores it). The helper
      // must escalate to SIGKILL after the configured grace window and
      // must wait for the resulting exit observation.
      child.kill("SIGTERM");

      const startedAt = Date.now();
      await waitForChildExit(child, 200);
      const elapsed = Date.now() - startedAt;

      // ac-stop-observes-termination-before-return: waitForChildExit
      // resolves only after exit has been observed on the parent
      // handle. At least one of exitCode / signalCode is non-null —
      // signalCode alone counts because SIGKILL terminates the synth.
      // Pre-fix the helper resolved from its setTimeout callback
      // synchronously after kill("SIGKILL"), leaving BOTH null. The
      // pid-liveness check is racy (kernel may or may not have actually
      // delivered the queued SIGKILL by the time we probe), so handle
      // observation is the only deterministic differentiator.
      expect(pid).toBeDefined();
      expect(
        child.exitCode !== null || child.signalCode !== null,
        `waitForChildExit must not resolve until child exit observed (exitCode=${child.exitCode} signalCode=${child.signalCode})`,
      ).toBe(true);

      // ac-uncooperative-process-stop-is-bounded: helper must reach
      // a bounded outcome. 3s is generous for slow CI without masking
      // a hang — pre-fix returns near-instantly from the timer
      // callback; post-fix returns after libuv fires exit.
      expect(elapsed).toBeLessThan(3_000);
    });

    // AC: @daemon-test-teardown-boundedness ac-stop-observes-termination-before-return
    //
    // Signal-exit race: when a foreground child is killed by signal
    // rather than exiting normally, the ChildProcess handle has
    // `exitCode === null` and `signalCode !== null`. The current
    // waitForChildExit fast-path checks only `child.exitCode !== null`,
    // so an already-signal-exited handle falls through to the full
    // polling timeout (5000ms) before resolving — even though the exit
    // is already observable. Cleanup that proves termination must
    // recognize signalCode as an exit indicator equivalent to exitCode.
    //
    // SIGKILL is used here (not SIGINT) so the parent's ChildProcess
    // handle deterministically observes exit-by-signal — SIGKILL is
    // uncatchable so the synth cannot exit cleanly with code 0 and mask
    // the signalCode branch under test.
    it("waitForChildExit returns immediately when child already exited via signal", async () => {
      const child = spawn(signalExitPath, [], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = child.pid;
      expect(pid).toBeDefined();

      // Wait for the synth handshake so we know the script has reached
      // setInterval and won't exit on its own before we signal.
      await waitForSynthReady(child);

      // Wait for the child to fully exit by signal. SIGKILL forces a
      // signal-exit on the parent's handle regardless of any default
      // Node SIGINT behavior on the child side.
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      });

      onTestFinished(() => {
        if (pid !== undefined && isProcessAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      });

      // Confirm we set up the signal-exit race state we care about.
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBe("SIGKILL");

      // Fast-path: helper sees the exit is already observable and
      // returns immediately, not after the configured timeout.
      const startedAt = Date.now();
      await waitForChildExit(child, 5_000);
      const elapsed = Date.now() - startedAt;

      // ac-stop-observes-termination-before-return: the bounded
      // primitive recognises a signal-exited child via signalCode and
      // returns immediately. Pre-fix the fast-path only checked
      // `exitCode !== null`, so signal-exit fell through to the full
      // polling timeout (5000ms). 500ms gives slow CI a margin while
      // still failing if the signal-exit case falls back to polling.
      expect(
        elapsed,
        `waitForChildExit must recognise an already-signal-exited child via signalCode (elapsed=${elapsed}ms)`,
      ).toBeLessThan(500);
    });

    // AC: @daemon-test-teardown-boundedness ac-stop-observes-termination-before-return
    // AC: @daemon-test-teardown-boundedness ac-uncooperative-process-stop-is-bounded
    // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
    //
    // PID-based cleanup contract: an uncooperative pid must reach a
    // bounded terminal outcome. `killPid` now routes through the shared
    // bounded process-stop primitive (SIGTERM → poll for pid reap →
    // SIGKILL on graceful timeout → poll again for pid reap), so calling
    // it against a SIGTERM-ignoring child escalates and observes the pid
    // leave the process table before resolving.
    it("killPid drives an uncooperative pid to a bounded terminal outcome", async () => {
      const child = spawn(uncooperativePath, [], {
        // Pipe stdout so we can read the synth's ready handshake before
        // signaling. Without the handshake, SIGTERM races handler
        // installation and the synth dies cooperatively, hiding the gap.
        stdio: ["ignore", "pipe", "pipe"],
        // Detached so the child outlives the spawn handle for the test —
        // PID-based cleanup is the contract under test, not ChildProcess
        // cleanup. unref() lets the test process exit even if cleanup
        // misbehaves.
        detached: true,
      });
      child.unref();
      const pid = child.pid;
      expect(pid).toBeDefined();
      expect(pid).toBeGreaterThan(0);
      expect(isProcessAlive(pid as number)).toBe(true);

      // Belt-and-suspenders: force-kill if the helper bug leaves the
      // synthetic pid alive after the cleanup attempt.
      onTestFinished(() => {
        if (pid !== undefined && isProcessAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      });

      // Wait for the synth handshake so the SIGTERM handler is
      // guaranteed installed before we signal.
      await waitForSynthReady(child);

      // Invoke the cleanup helper. The current killPid is synchronous
      // void; a bounded replacement may return a Promise. Handle both
      // shapes so this regression captures the contract — termination
      // observed within a bounded window — independently of whether
      // the helper is refactored to async in the next task.
      const stopReturn: unknown = killPid(pid as number);
      if (
        stopReturn !== undefined &&
        stopReturn !== null &&
        typeof (stopReturn as { then?: unknown }).then === "function"
      ) {
        await (stopReturn as Promise<unknown>);
      } else {
        // Sync helper: allow a generous grace window for any internal
        // escalation + observation to complete. 5500ms is just past
        // the conventional 5s daemon-stop grace; today's fire-and-forget
        // killPid never escalates, so the pid survives this entire
        // window and the assertion below fails — proving the gap.
        await new Promise((r) => setTimeout(r, 5_500));
      }

      // ac-uncooperative-process-stop-is-bounded: killPid drives an
      // uncooperative pid to a bounded terminal outcome (escalates to
      // SIGKILL and observes the pid leave the OS process table). The
      // helper now returns a Promise that we await above; the assertion
      // is straightforward.
      expect(
        isProcessAlive(pid as number),
        `killPid must drive uncooperative pid ${pid} to a bounded terminal outcome`,
      ).toBe(false);
    });
  },
);
