/**
 * Focused contract tests for the shared mock daemon helper.
 *
 * These tests validate the helper directly — not by relying on consumer
 * tests that happen to exercise it. They prove the helper provides:
 *   - Canonical daemon.connection.json metadata that round-trips through
 *     readDaemonConnectionMetadata (the canonical client-side parser).
 *   - Dynamic port propagation: port=0 listen → consumer client receives
 *     the OS-assigned port via the helper, never zero.
 *   - Behavior modes for /api/command (normal | error | hang).
 *   - In-process and child-process startup variants.
 *   - Request recording (in-memory and JSONL).
 *   - Idempotent cleanup.
 *   - Bind-host flexibility with proper IPv6 bracketing in URLs.
 *   - Legacy port-file helper writing only the port file.
 *
 * AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
 * AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
 * AC: @daemon-test-endpoint-consistency ac-mock-metadata-fidelity
 * AC: @daemon-test-endpoint-consistency ac-dynamic-port-propagation
 * AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
 * AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
 * AC: @trait-daemon-endpoint-consumer ac-wildcard-not-destination
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import {
  readDaemonConnectionMetadata,
  type DaemonConnectionMetadata,
} from "../../src/daemon-shared/endpoint.js";
import {
  cleanupTempDir,
  createIsolatedKspecHome,
  createTempDir,
  type IsolatedKspecHome,
} from "./cli.js";
import { boundedDaemonFetch } from "./daemon-fetch.js";
import {
  expectedHostHeader,
  probeHostAvailable,
  startMockDaemon,
  writeLegacyDaemonPort,
  writeMockDaemonMetadata,
  type MockDaemonClient,
} from "./mock-daemon.js";

describe("mock daemon helper — contract", () => {
  let tempDir: string;
  let home: IsolatedKspecHome;
  let mock: MockDaemonClient | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-mock-daemon-contract-");
    home = await createIsolatedKspecHome(tempDir);
  });

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = undefined;
    }
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
  // AC: @daemon-test-endpoint-consistency ac-dynamic-port-propagation
  it("starts an in-process mock daemon at an OS-assigned port and serves /api/health", async () => {
    mock = (await startMockDaemon()) ?? undefined;
    expect(mock).toBeDefined();
    expect(mock!.bindHost).toBe("127.0.0.1");
    // Port must be non-zero (OS-assigned) and present in the apiUrl.
    expect(mock!.port).toBeGreaterThan(0);
    expect(mock!.apiUrl).toBe(`http://127.0.0.1:${mock!.port}`);
    expect(mock!.wsUrl).toBe(`ws://127.0.0.1:${mock!.port}/ws`);

    const response = await fetch(`${mock!.apiUrl}/api/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  // AC: @daemon-test-endpoint-consistency ac-mock-metadata-fidelity
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  it("writeMockDaemonMetadata produces a file that the canonical reader parses verbatim", async () => {
    mock = (await startMockDaemon()) ?? undefined;
    expect(mock).toBeDefined();

    writeMockDaemonMetadata({ home, client: mock!, runtime: "node" });

    const parsed = readDaemonConnectionMetadata(home.configDir);
    expect(parsed).not.toBeNull();
    const expected: DaemonConnectionMetadata = {
      pid: process.pid,
      port: mock!.port,
      bind_host: "127.0.0.1",
      connect_host: "127.0.0.1",
      api_url: `http://127.0.0.1:${mock!.port}`,
      ws_url: `ws://127.0.0.1:${mock!.port}/ws`,
      runtime: "node",
    };
    expect(parsed).toEqual(expected);
  });

  // AC: @trait-daemon-endpoint-consumer ac-wildcard-not-destination
  // Metadata can advertise a wildcard bind alongside a specific connect host.
  // This exercises the helper's bindHost / connectHost overrides and proves
  // the resulting JSON keeps both values verbatim through the canonical parser.
  it("writeMockDaemonMetadata supports wildcard bind with explicit connect host", async () => {
    mock = (await startMockDaemon()) ?? undefined;
    expect(mock).toBeDefined();

    writeMockDaemonMetadata({
      home,
      client: mock!,
      bindHost: "0.0.0.0",
      connectHost: "127.0.0.1",
    });

    const parsed = readDaemonConnectionMetadata(home.configDir);
    expect(parsed).not.toBeNull();
    expect(parsed!.bind_host).toBe("0.0.0.0");
    expect(parsed!.connect_host).toBe("127.0.0.1");
    expect(parsed!.api_url).toBe(`http://127.0.0.1:${mock!.port}`);
  });

  // AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
  it("normal mode returns 200 with a stdout/stderr/exitCode payload at /api/command", async () => {
    mock = (await startMockDaemon({ mode: "normal" })) ?? undefined;
    expect(mock).toBeDefined();

    const response = await fetch(`${mock!.apiUrl}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "task list" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    expect(body.stdout).toBe("proxied: task list\n");
    expect(body.exitCode).toBe(0);
  });

  // AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
  it("error mode returns 422 with non-zero exitCode at /api/command", async () => {
    mock = (await startMockDaemon({ mode: "error" })) ?? undefined;
    expect(mock).toBeDefined();

    const response = await fetch(`${mock!.apiUrl}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "task list" }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(3);
    expect(body.stderr).toContain("not found");
  });

  // AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
  // Refuse mode returns a non-JSON 503 at /api/command. CLI proxy clients
  // treat this as a daemon-side failure: read-only commands fall back to
  // direct mode (so endpoint-regression tests can record the inline
  // command's metadata-driven URLs), and mutating commands surface the
  // proxy attempt at /api/command for verification.
  it("refuse mode returns 503 with non-JSON body at /api/command", async () => {
    mock = (await startMockDaemon({ mode: "refuse" })) ?? undefined;
    expect(mock).toBeDefined();

    const response = await fetch(`${mock!.apiUrl}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "task list" }),
    });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("refuses");
  });

  // AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
  // Hang mode never responds to /api/command — the contract is that a
  // bounded fetch with an AbortController times out before the helper does.
  it("hang mode never responds at /api/command (callers must time out)", async () => {
    mock = (await startMockDaemon({ mode: "hang" })) ?? undefined;
    expect(mock).toBeDefined();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    let aborted = false;
    try {
      await fetch(`${mock!.apiUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "task list" }),
        signal: controller.signal,
      });
    } catch (err) {
      aborted = err instanceof Error && err.name === "AbortError";
    } finally {
      clearTimeout(timer);
    }
    expect(aborted).toBe(true);
  });

  // AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
  it("records every request observed by the in-process mock daemon", async () => {
    mock = (await startMockDaemon()) ?? undefined;
    expect(mock).toBeDefined();

    await fetch(`${mock!.apiUrl}/api/health`);
    await fetch(`${mock!.apiUrl}/api/agent/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: "abc" }),
    });

    const recorded = mock!.requests();
    expect(recorded).toHaveLength(2);
    expect(recorded[0].method).toBe("GET");
    expect(recorded[0].url).toBe("/api/health");
    expect(recorded[0].host).toBe(expectedHostHeader("127.0.0.1", mock!.port));
    expect(recorded[1].method).toBe("POST");
    expect(recorded[1].url).toBe("/api/agent/events");
    expect(recorded[1].body).toContain('"task_id":"abc"');
  });

  // AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
  // Child-process mode is required when the test invokes the kspec CLI via
  // spawnSync (which blocks the test runner event loop). The contract test
  // exercises the same surface API and asserts the JSONL recording path.
  it("starts a child-process mock daemon and records requests to JSONL", async () => {
    mock = (await startMockDaemon({ asChildProcess: true })) ?? undefined;
    expect(mock).toBeDefined();
    expect(mock!.port).toBeGreaterThan(0);
    expect(mock!.apiUrl).toBe(`http://127.0.0.1:${mock!.port}`);

    const response = await fetch(`${mock!.apiUrl}/api/health`);
    expect(response.status).toBe(200);

    // Allow the async fs.appendFileSync inside the child to complete.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const recorded = mock!.requests();
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    const health = recorded.find((r) => r.url === "/api/health");
    expect(health).toBeDefined();
    expect(health!.method).toBe("GET");
    expect(health!.host).toBe(expectedHostHeader("127.0.0.1", mock!.port));
  });

  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  // IPv6 binding is the strongest test of bracket handling in the URL
  // helpers — the apiUrl/wsUrl must use bracketed [::1]:port verbatim.
  // Skipped when ::1 is not addressable (typical in IPv6-disabled containers).
  it("starts an in-process mock daemon on ::1 with bracketed URLs", async () => {
    if (!(await probeHostAvailable("::1"))) {
      console.log("  ⊘ Skipping test - IPv6 loopback (::1) not available");
      return;
    }
    mock = (await startMockDaemon({ bindHost: "::1" })) ?? undefined;
    expect(mock).toBeDefined();
    expect(mock!.bindHost).toBe("::1");
    expect(mock!.apiUrl).toBe(`http://[::1]:${mock!.port}`);
    expect(mock!.wsUrl).toBe(`ws://[::1]:${mock!.port}/ws`);

    const response = await fetch(`${mock!.apiUrl}/api/health`);
    expect(response.status).toBe(200);

    const recorded = mock!.requests();
    expect(recorded[0].host).toBe(expectedHostHeader("::1", mock!.port));
  });

  // AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
  // Cleanup must be idempotent so afterEach's stop() never throws when a
  // test already stopped the mock explicitly.
  it("stop() is idempotent across in-process and child-process modes", async () => {
    const inProcess = await startMockDaemon();
    expect(inProcess).toBeDefined();
    await inProcess!.stop();
    await expect(inProcess!.stop()).resolves.toBeUndefined();

    const child = await startMockDaemon({ asChildProcess: true });
    expect(child).toBeDefined();
    await child!.stop();
    await expect(child!.stop()).resolves.toBeUndefined();
  });

  // AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
  // The legacy helper writes ONLY the port file — proves tests that
  // intentionally exercise legacy fallback don't accidentally write
  // canonical metadata that masks the fallback path.
  it("writeLegacyDaemonPort writes daemon.port and daemon.pid but not connection metadata", async () => {
    writeLegacyDaemonPort({ home, port: 12345 });

    expect(existsSync(home.daemonPortFilePath)).toBe(true);
    expect(existsSync(home.daemonPidFilePath)).toBe(true);
    expect(readDaemonConnectionMetadata(home.configDir)).toBeNull();
  });

  // AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
  // Helper-allocated record files (no recordPath supplied) MUST be removed
  // by stop() so child-process mock daemon runs do not leak request payloads
  // under /tmp. Regression: prior teardown only killed the child and left
  // kspec-mock-daemon-*.jsonl artifacts behind.
  it("stop() removes helper-allocated record files in child-process mode", async () => {
    const tmp = process.env.TMPDIR ?? process.env.TEMP ?? tmpdir();
    const snapshot = (): Set<string> =>
      new Set(
        readdirSync(tmp).filter((name) => name.startsWith("kspec-mock-daemon-")),
      );

    const beforeStart = snapshot();

    const child = await startMockDaemon({ asChildProcess: true });
    expect(child).toBeDefined();

    // Drive at least one request so the child writes the JSONL file before stop().
    await fetch(`${child!.apiUrl}/api/health`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The helper must have allocated and populated a new JSONL file.
    const duringRun = snapshot();
    const newFiles = [...duringRun].filter((name) => !beforeStart.has(name));
    expect(newFiles.length).toBeGreaterThan(0);

    await child!.stop();

    // Every helper-allocated file from this run must be gone after stop().
    const afterStop = snapshot();
    for (const name of newFiles) {
      expect(afterStop.has(name)).toBe(false);
    }
  });

  // AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
  // Caller-supplied record paths are NOT helper-owned. stop() must leave
  // them in place so callers can inspect or clean up on their own schedule.
  it("stop() leaves caller-supplied record paths intact in child-process mode", async () => {
    const callerDir = join(tempDir, "caller-record");
    mkdirSync(callerDir, { recursive: true });
    const callerRecord = join(callerDir, "requests.jsonl");
    // Pre-create the file so existence is unambiguous regardless of whether
    // the child appended to it during the lifetime of the test.
    writeFileSync(callerRecord, "");

    const child = await startMockDaemon({
      asChildProcess: true,
      recordPath: callerRecord,
    });
    expect(child).toBeDefined();
    await fetch(`${child!.apiUrl}/api/health`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await child!.stop();

    // Caller owns the file — helper must not unlink it.
    expect(existsSync(callerRecord)).toBe(true);
  });

  // AC: @daemon-test-endpoint-consistency ac-mock-metadata-fidelity
  // Round-trip: writeMockDaemonMetadata + readDaemonConnectionMetadata
  // produces a canonical metadata object on a non-default loopback alias
  // (Linux 127.0.0.2 maps to loopback). Skipped on platforms where the
  // alias is not addressable.
  it("metadata roundtrip honors a non-default loopback alias", async () => {
    if (!(await probeHostAvailable("127.0.0.2"))) {
      console.log("  ⊘ Skipping test - 127.0.0.2 loopback alias not available");
      return;
    }
    mock = (await startMockDaemon({ bindHost: "127.0.0.2" })) ?? undefined;
    expect(mock).toBeDefined();
    expect(mock!.apiUrl).toBe(`http://127.0.0.2:${mock!.port}`);

    writeMockDaemonMetadata({ home, client: mock! });

    const parsed = readDaemonConnectionMetadata(home.configDir);
    expect(parsed).not.toBeNull();
    expect(parsed!.bind_host).toBe("127.0.0.2");
    expect(parsed!.connect_host).toBe("127.0.0.2");
    expect(parsed!.api_url).toBe(`http://127.0.0.2:${mock!.port}`);
  });
});

/**
 * Contract tests for the child-process mock daemon helper's startup hygiene.
 *
 *   - When the helper observes a malformed first stdout line from a spawned
 *     child whose listener is still alive, it stops that child before
 *     returning failure to the caller.
 *     (ac-owned-child-stopped-after-startup-failure)
 *   - When the helper's startup wait times out while the spawned child is
 *     still running, it stops the child before returning failure.
 *     (ac-owned-child-stopped-after-startup-failure)
 *   - The helper sanitises the child env so ambient daemon-control and
 *     dispatch session vars are not inherited by the mock daemon child.
 *     (ac-child-env-sanitized)
 */
/** Probe whether a process is still alive without sending a real signal. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort kill so a leaked child does not survive the test run. */
function ensureProcessReaped(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

describe("mock daemon helper — startup-failure hygiene contract", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-mock-daemon-failure-");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  // The helper must stop the child BEFORE returning failure, not "soon
  // after" — sampling without a grace window catches a regression where
  // cleanup sends SIGTERM but resolves null before the OS has reaped the
  // child (the prior bug behind this task's first review cycle).
  it("stops the child process when the first stdout line is malformed", async () => {
    const pidFile = join(tempDir, "child-malformed.pid");

    // The injected --break malformed-stdout flag makes the child write a
    // non-JSON line so the helper's JSON.parse fails. The child stays
    // bound to its HTTP listener so the OS does not reap it on its own.
    // The pid is recorded synchronously before the malformed line is
    // emitted, giving the test a stable handle to assert against.
    const result = await startMockDaemon({
      asChildProcess: true,
      __testInjectArgs: ["--break", "malformed-stdout", "--pid-file", pidFile],
      // Generous timeout: the helper resolves to null on the malformed-
      // stdout branch immediately, well before this fires.
      __testStartupTimeoutMs: 5_000,
    });
    expect(result).toBeNull();
    expect(existsSync(pidFile)).toBe(true);
    const childPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    expect(Number.isFinite(childPid)).toBe(true);
    expect(childPid).toBeGreaterThan(0);

    // Belt-and-suspenders: reap on test exit if SIGTERM didn't take, so
    // an assertion regression doesn't leave a daemon listening.
    onTestFinished(() => {
      if (isProcessAlive(childPid)) ensureProcessReaped(childPid);
    });

    // The helper stops the still-running child BEFORE returning failure
    // — no grace window. Sampling immediately on return is what catches
    // the prior bug where cleanup fired SIGTERM and resolved null without
    // waiting for the child to actually exit.
    expect(isProcessAlive(childPid)).toBe(false);
  });

  // AC: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  it("stops the child process when startup times out without stdout", async () => {
    const pidFile = join(tempDir, "child-timeout.pid");

    // The injected --break no-stdout flag makes the child bind its
    // listener but never write the metadata line, forcing the helper's
    // setTimeout branch to fire while the child is still alive. The
    // shortened __testStartupTimeoutMs keeps the case under the per-
    // test budget (the production default is 5s).
    const result = await startMockDaemon({
      asChildProcess: true,
      __testInjectArgs: ["--break", "no-stdout", "--pid-file", pidFile],
      __testStartupTimeoutMs: 250,
    });
    expect(result).toBeNull();
    expect(existsSync(pidFile)).toBe(true);
    const childPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    expect(Number.isFinite(childPid)).toBe(true);
    expect(childPid).toBeGreaterThan(0);

    onTestFinished(() => {
      if (isProcessAlive(childPid)) ensureProcessReaped(childPid);
    });

    // No grace window — same return-boundary contract as the malformed-
    // stdout case above.
    expect(isProcessAlive(childPid)).toBe(false);
  });

  // AC: @daemon-test-startup-failure-hygiene ac-child-env-sanitized
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  it("does not inherit ambient daemon-control or session variables in the child env", async () => {
    const envFile = join(tempDir, "child-env.json");

    // Snapshot then poison the parent process env with the exact keys
    // the helper must strip. Using `tracked` for restoration so we put
    // each var back to its prior value (or delete if not previously
    // set), regardless of how the assertion ends.
    const tracked: Record<string, string | undefined> = {
      KSPEC_DAEMON_PID: process.env.KSPEC_DAEMON_PID,
      KSPEC_DAEMON_PORT: process.env.KSPEC_DAEMON_PORT,
      KSPEC_DAEMON_HOST: process.env.KSPEC_DAEMON_HOST,
      KSPEC_DAEMON_CONNECT_HOST: process.env.KSPEC_DAEMON_CONNECT_HOST,
      KSPEC_DAEMON_RUNTIME: process.env.KSPEC_DAEMON_RUNTIME,
      KSPEC_NO_DAEMON: process.env.KSPEC_NO_DAEMON,
      KSPEC_SESSION_ID: process.env.KSPEC_SESSION_ID,
    };
    process.env.KSPEC_DAEMON_PID = "999999";
    process.env.KSPEC_DAEMON_PORT = "9999";
    process.env.KSPEC_DAEMON_HOST = "leak.example";
    process.env.KSPEC_DAEMON_CONNECT_HOST = "leak.example";
    process.env.KSPEC_DAEMON_RUNTIME = "node";
    process.env.KSPEC_NO_DAEMON = "1";
    process.env.KSPEC_SESSION_ID = "leak-session";

    onTestFinished(() => {
      for (const [key, prior] of Object.entries(tracked)) {
        if (prior === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = prior;
        }
      }
    });

    // Use --env-record so the child writes its inherited env snapshot to
    // disk synchronously at startup, before the listener binds. The
    // helper runs in normal mode so the child reaches readiness and we
    // can stop() it cleanly afterwards.
    const child = await startMockDaemon({
      asChildProcess: true,
      __testInjectArgs: ["--env-record", envFile],
    });
    expect(child).not.toBeNull();
    onTestFinished(async () => {
      if (child) await child.stop();
    });

    expect(existsSync(envFile)).toBe(true);
    const recorded = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;

    // Ambient daemon-control vars and dispatch session vars are stripped
    // from the child env by the sanitised subprocess-env builder.
    expect(recorded.KSPEC_DAEMON_PID).toBeUndefined();
    expect(recorded.KSPEC_DAEMON_PORT).toBeUndefined();
    expect(recorded.KSPEC_DAEMON_HOST).toBeUndefined();
    expect(recorded.KSPEC_DAEMON_CONNECT_HOST).toBeUndefined();
    expect(recorded.KSPEC_DAEMON_RUNTIME).toBeUndefined();
    expect(recorded.KSPEC_NO_DAEMON).toBeUndefined();
    expect(recorded.KSPEC_SESSION_ID).toBeUndefined();
  });

  // AC: @daemon-test-startup-failure-hygiene ac-child-env-sanitized
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  // The strip lists are an opt-out, not a hard ban — a test that explicitly
  // passes a daemon-control or dispatch-session var via the helper's `env`
  // option needs that value preserved in the child. Otherwise tests that
  // specifically exercise daemon-control behavior could not configure the
  // child at all.
  it("preserves explicit env overrides for keys that would otherwise be stripped", async () => {
    const envFile = join(tempDir, "child-env-overrides.json");

    const child = await startMockDaemon({
      asChildProcess: true,
      __testInjectArgs: ["--env-record", envFile],
      env: {
        KSPEC_DAEMON_PID: "12345",
        KSPEC_NO_DAEMON: "1",
        KSPEC_SESSION_ID: "01OVERRIDESESSION0000000000",
      },
    });
    expect(child).not.toBeNull();
    onTestFinished(async () => {
      if (child) await child.stop();
    });

    expect(existsSync(envFile)).toBe(true);
    const recorded = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;

    expect(recorded.KSPEC_DAEMON_PID).toBe("12345");
    expect(recorded.KSPEC_NO_DAEMON).toBe("1");
    expect(recorded.KSPEC_SESSION_ID).toBe("01OVERRIDESESSION0000000000");
  });
});

/**
 * Contract tests for the child-process mock daemon helper's bounded-stop path.
 *
 * The mock daemon's child `stop()` closure now routes through the shared
 * bounded process-stop primitive:
 *   - Send SIGTERM, wait for observed exit (exitCode OR signalCode set OR
 *     'exit' event fired) within the graceful budget.
 *   - Escalate to SIGKILL on graceful timeout, then wait again for the
 *     resulting exit observation within the escalation budget.
 *   - Throw BoundedProcessStopError if termination cannot be observed even
 *     after escalation — never resolve while the OS pid is still alive.
 */
describe("mock daemon helper — bounded child stop contract", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-mock-daemon-bounded-");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-test-teardown-boundedness ac-stop-observes-termination-before-return
  // AC: @daemon-test-teardown-boundedness ac-uncooperative-process-stop-is-bounded
  // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  it(
    "stop() does not resolve until an uncooperative child has been observed terminated",
    async () => {
      const pidFile = join(tempDir, "uncooperative-child.pid");

      // The child writes its pid synchronously at startup and installs
      // no-op SIGTERM/SIGINT/SIGHUP handlers via --ignore-sigterm so the
      // helper must escalate to SIGKILL inside stop().
      const child = await startMockDaemon({
        asChildProcess: true,
        __testInjectArgs: ["--ignore-sigterm", "--pid-file", pidFile],
      });
      expect(child).not.toBeNull();
      expect(existsSync(pidFile)).toBe(true);
      const childPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      expect(Number.isFinite(childPid)).toBe(true);
      expect(childPid).toBeGreaterThan(0);
      expect(isProcessAlive(childPid)).toBe(true);

      // Belt-and-suspenders: force-kill on test exit if the regression
      // leaves the child alive after stop() returns.
      onTestFinished(() => {
        if (isProcessAlive(childPid)) ensureProcessReaped(childPid);
      });

      const stopStartedAt = Date.now();
      await child!.stop();
      const elapsed = Date.now() - stopStartedAt;

      // ac-stop-observes-termination-before-return: stop() resolves only
      // after the OS pid has been observed terminated (kill(pid, 0)
      // throws ESRCH). Pre-fix the helper finalised from the SIGKILL
      // timer callback before the exit event fired and left the pid in
      // the process table; post-fix the bounded primitive waits for the
      // exit observation.
      expect(
        isProcessAlive(childPid),
        `stop() must not resolve until pid ${childPid} has been observed terminated`,
      ).toBe(false);

      // ac-uncooperative-process-stop-is-bounded: helper must reach
      // a bounded outcome. 6s is generous for slow CI without masking
      // a regression that hangs the wait. Pre-fix returns near the
      // CHILD_GRACEFUL_KILL_MS budget (1500ms); post-fix returns
      // shortly thereafter — both well under 6s.
      expect(elapsed).toBeLessThan(6_000);

      // Idempotent stop after observation.
      await expect(child!.stop()).resolves.toBeUndefined();
    },
  );
});

/**
 * FAILING-BEFORE-FIX regression suite for @daemon-test-teardown-boundedness
 * ac-active-requests-do-not-block-teardown and ac-daemon-observations-are-bounded.
 *
 * The mock daemon advertises a "hang" mode for `/api/command` that accepts
 * the connection but never writes a response. That mode lets us simulate
 * the "daemon-like server with an active request that does not complete"
 * scenario described by the AC.
 *
 * Today:
 *   - In-process `stop()` awaits `server.close()`, which Node holds open
 *     until every active connection drains. With a hung request, the close
 *     callback never fires and `stop()` never resolves — there is no
 *     bounded outcome.
 *   - The child-process variant also catches SIGTERM and runs
 *     `server.close(() => process.exit(0))` in its signal handler, which
 *     hangs for the same reason. The parent's stop closure escalates to
 *     SIGKILL after CHILD_GRACEFUL_KILL_MS, which is the only thing that
 *     bounds the outer wait.
 *   - There is no shared bounded daemon-fetch helper, so daemon-facing
 *     probes that use bare `fetch(url)` (cli-serve.test.ts waitForDaemonHealth,
 *     Playwright daemon setup) can hang up to the OS TCP timeout (~75s on
 *     Linux) when a daemon endpoint stalls mid-request.
 *
 * Each test bounds itself with an explicit Promise.race timer so the suite
 * cannot hang even when the contract is violated. In-flight hang requests
 * are cancelled via AbortController before afterEach so any future fix can
 * complete `server.close()` deterministically during teardown.
 */
describe("mock daemon helper — active-request teardown contract", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-mock-daemon-active-request-");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-test-teardown-boundedness ac-active-requests-do-not-block-teardown
  // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  // Positive contract lock: in-process `stop()` tracks active sockets and
  // force-closes them after a small graceful budget so `server.close()`
  // finalizes even when a request is hanging. Before the fix Node held the
  // close callback until every accepted connection drained, so a hung
  // request kept the close pending forever; the bounded teardown contract
  // in mock-daemon.ts must keep the resolution well inside `BOUND_MS`.
  it(
    "in-process stop() reaches a bounded outcome when an active request is hanging",
    async () => {
      const mock = (await startMockDaemon({ mode: "hang" })) ?? undefined;
      expect(mock).toBeDefined();

      // Belt-and-suspenders: a future fix that resolves stop() but leaves
      // a socket dangling should still tear down before afterEach.
      const controller = new AbortController();
      onTestFinished(async () => {
        controller.abort();
        if (mock) {
          // Idempotent stop covers the case where the Promise.race below
          // observed a timeout and the outer stop() is still pending.
          await mock.stop();
        }
      });

      // Issue a hang request and intentionally hold the promise — the
      // server's handler stalls so Node keeps the connection open. We do
      // NOT await this promise; the test only needs the request in flight.
      const hangRequest = fetch(`${mock!.apiUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "task list" }),
        signal: controller.signal,
      }).catch(() => {
        // Swallow the AbortError from cleanup; the test is about teardown
        // boundedness, not the response.
      });

      // Brief delay so the request reaches the listener and `server.close`
      // sees an active connection before stop() runs.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

      const BOUND_MS = 1_500;
      const stopStartedAt = Date.now();
      const stopOutcome = await Promise.race([
        mock!.stop().then(() => "stopped" as const),
        new Promise<"timeout">((resolveTimeout) =>
          setTimeout(() => resolveTimeout("timeout"), BOUND_MS),
        ),
      ]);
      const elapsed = Date.now() - stopStartedAt;

      // Cancel the in-flight request so any future fix can finalize
      // server.close() during the lingering stop() invocation. Awaiting
      // hangRequest also ensures the response side has settled before we
      // assert on the outcome.
      controller.abort();
      await hangRequest;

      // ac-active-requests-do-not-block-teardown: stop() must reach a
      // bounded terminal outcome regardless of in-flight connections.
      // Today this assertion fails because Promise.race observes "timeout"
      // — server.close() never resolves while the hang handler holds the
      // socket open.
      expect(stopOutcome).toBe("stopped");
      expect(elapsed).toBeLessThan(BOUND_MS);
    },
  );

  // AC: @daemon-test-teardown-boundedness ac-active-requests-do-not-block-teardown
  // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  // The child-process stop() bounds the outer wait via the SIGKILL
  // escalation timer at CHILD_GRACEFUL_KILL_MS (1.5s) even when the
  // child's SIGTERM handler calls `server.close()` and hangs on an active
  // connection. Positive contract lock: a future cleanup refactor that
  // removed the SIGKILL fallback or extended the grace window without an
  // escalation path would break the AC.
  it(
    "child stop() reaches a bounded outcome when the child has an active hang request",
    { timeout: 10_000 },
    async () => {
      const child =
        (await startMockDaemon({ asChildProcess: true, mode: "hang" })) ??
        undefined;
      expect(child).toBeDefined();

      const controller = new AbortController();
      onTestFinished(async () => {
        controller.abort();
        if (child) await child.stop();
      });

      // Same hang-request pattern as the in-process case; the child's
      // SIGTERM handler will call server.close() and stall when stop()
      // signals it.
      const hangRequest = fetch(`${child!.apiUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "task list" }),
        signal: controller.signal,
      }).catch(() => {});

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

      // Allow SIGTERM grace (1.5s) + SIGKILL fan-out + observer settle.
      // 3s is generous for slow CI without masking a regression that
      // removes the SIGKILL fallback (which would hang past 3s).
      const BOUND_MS = 3_000;
      const stopStartedAt = Date.now();
      const stopOutcome = await Promise.race([
        child!.stop().then(() => "stopped" as const),
        new Promise<"timeout">((resolveTimeout) =>
          setTimeout(() => resolveTimeout("timeout"), BOUND_MS),
        ),
      ]);
      const elapsed = Date.now() - stopStartedAt;

      controller.abort();
      await hangRequest;

      // ac-active-requests-do-not-block-teardown: the parent's stop wait
      // bounds via SIGKILL escalation. The grace window is 1.5s so we
      // expect the resolution well before the 3s bound.
      expect(stopOutcome).toBe("stopped");
      expect(elapsed).toBeLessThan(BOUND_MS);
    },
  );

  // AC: @daemon-test-teardown-boundedness ac-daemon-observations-are-bounded
  // AC: @daemon-backed-test-fixture-contract ac-bounded-readiness
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  // Positive contract lock for the shared `boundedDaemonFetch` helper.
  // Replaced the prior inline `AbortSignal.timeout` shape now that the
  // helper exists — the helper composes `AbortSignal.timeout` with the
  // caller's optional signal, so this case proves the helper bounds the
  // observation against a stalled daemon endpoint.
  it("boundedDaemonFetch reaches a bounded outcome against a hang endpoint", async () => {
    const mock = (await startMockDaemon({ mode: "hang" })) ?? undefined;
    expect(mock).toBeDefined();
    onTestFinished(async () => {
      if (mock) await mock.stop();
    });

    const BUDGET_MS = 250;
    const startedAt = Date.now();
    let aborted = false;
    let body: string | null = null;
    try {
      const response = await boundedDaemonFetch(`${mock!.apiUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "task list" }),
        timeoutMs: BUDGET_MS,
      });
      body = await response.text();
    } catch (err) {
      // Node fetch surfaces AbortSignal.timeout as a TimeoutError;
      // accept either name so the test does not depend on the runtime's
      // exact error class label.
      const name = err instanceof Error ? err.name : "";
      aborted = name === "AbortError" || name === "TimeoutError";
    }
    const elapsed = Date.now() - startedAt;

    expect(aborted).toBe(true);
    expect(body).toBeNull();
    // Bound the observation to a small multiple of the budget so a
    // future regression that drops the helper's internal abort cannot
    // satisfy this case by waiting out the OS TCP timeout (~75s on Linux).
    expect(elapsed).toBeLessThan(BUDGET_MS * 4);
  });

  // AC: @daemon-test-teardown-boundedness ac-daemon-observations-are-bounded
  // AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
  // Positive contract lock for the shared `boundedDaemonFetch` helper that
  // the representative bare-fetch call sites in cli-serve.test.ts
  // (`waitForDaemonHealth` and inline `/api/health` / `/api/projects`
  // probes) and the Playwright fixture's `createSecondProject` POST now
  // adopt. The helper's internal `AbortSignal.timeout` aborts the request
  // within its budget regardless of socket-level behavior, so a daemon
  // that stalls mid-response can no longer pin the consumer to the OS
  // TCP timeout (~75s on Linux). A cleanup-bound signal still releases
  // any in-flight socket on `onTestFinished` so the test suite stays
  // bounded even if a future regression drops the helper's internal abort.
  it(
    "boundedDaemonFetch against a hang endpoint reaches a bounded outcome within a focused test budget",
    async () => {
      const mock = (await startMockDaemon({ mode: "hang" })) ?? undefined;
      expect(mock).toBeDefined();

      const cleanupController = new AbortController();
      onTestFinished(async () => {
        cleanupController.abort();
        if (mock) await mock.stop();
      });

      // The helper aborts internally after `timeoutMs`. The outer race
      // timer is a safety bound that should never fire — its purpose is
      // to keep the test bounded if a future regression drops the
      // helper's internal abort.
      const HELPER_TIMEOUT_MS = 200;
      const BUDGET_MS = 800;
      const startedAt = Date.now();
      const outcome = await Promise.race([
        boundedDaemonFetch(`${mock!.apiUrl}/api/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "task list" }),
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

      // ac-daemon-observations-are-bounded: the helper aborts the request
      // internally, so the consumer observes an "errored" outcome well
      // inside the outer budget. A "timeout" would mean the helper
      // failed to enforce its own bound.
      expect(outcome).toBe("errored");
      expect(elapsed).toBeLessThan(BUDGET_MS);
    },
  );
});
