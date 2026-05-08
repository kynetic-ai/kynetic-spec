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

import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
