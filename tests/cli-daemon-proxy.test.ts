/**
 * Tests for CLI daemon proxy detection and routing.
 *
 * AC Coverage:
 * - @cli-daemon-proxy ac-direct-fallback: commands operate directly when no daemon
 * - @cli-daemon-proxy ac-force-direct: KSPEC_NO_DAEMON=1 bypasses daemon
 * - @cli-daemon-proxy ac-force-direct-management-exception: KSPEC_NO_DAEMON does not redirect daemon management commands
 * - @cli-daemon-proxy ac-force-proxy: --daemon flag requires daemon
 * - @cli-daemon-proxy ac-transparent-output: output identical to direct mode
 * - @cli-daemon-proxy ac-mutation-coherence: mutations go through daemon
 * - @cli-daemon-proxy ac-read-from-cache: reads served from daemon cache
 * - @cli-daemon-proxy ac-timeout-fallback: read-only timeout falls back to direct
 * - @cli-daemon-proxy ac-timeout-mutation-error: mutation timeout returns error
 * - @daemon-proxy-detection ac-legacy-port-file-fallback: reads legacy daemon.port file and health-checks 127.0.0.1:port
 * - @daemon-proxy-detection ac-fast-detection: fast fail on missing port/refused
 * - @daemon-proxy-detection ac-project-registered: registers project before routing
 * - @daemon-proxy-detection ac-connection-metadata-check: detection reads daemon.connection.json
 * - @daemon-proxy-detection ac-health-timeout: 200ms timeout against advertised endpoint
 * - @cli-daemon-proxy ac-auto-detect: routes via advertised connect_host/port from metadata
 * - @daemon-network-endpoint-contract ac-clients-use-metadata
 * - @daemon-network-endpoint-contract ac-legacy-port-fallback
 * - @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
 * - @trait-daemon-endpoint-consumer ac-wildcard-not-destination
 *
 * - @trait-error-guidance ac-1: error includes description
 * - @trait-error-guidance ac-2: error includes suggested action
 * - @trait-error-guidance ac-3 — N/A: daemon proxy errors don't involve ref lookups
 * - @trait-error-guidance ac-4 — N/A: daemon proxy doesn't perform state transitions
 * - @trait-error-guidance ac-5 — N/A: daemon proxy doesn't perform field validation
 * - @trait-error-guidance ac-6 — N/A: daemon proxy passes through JSON mode from daemon response
 */

import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createIsolatedKspecHome,
  createTempDir,
  initGitRepo,
  kspec,
} from "./helpers/cli.js";
import {
  startMockDaemon,
  writeLegacyDaemonPort,
  writeMockDaemonMetadata,
  type MockDaemonClient,
} from "./helpers/mock-daemon.js";

import {
  detectDaemon,
  shouldProxyCommand,
  proxyCommand,
  extractCommandPayload,
  _resetDetectionCacheForTesting,
  _setDetectionCacheForTesting,
} from "../src/cli/daemon-proxy.js";
import type { DaemonClientEndpoint } from "../src/cli/pid-utils.js";

// ── Helper: Create a Node HTTP server and return its address ──────
//
// Used by proxyCommand unit tests that need very specific server behavior
// (e.g. hung /api/projects, header capture) that the shared mock daemon
// helper does not provide. Detection / E2E tests use the shared helper in
// tests/helpers/mock-daemon.ts.

function createTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
  });
}

// ── Helper: Build a DaemonClientEndpoint for proxyCommand tests ───
// proxyCommand requires the resolved endpoint object (not a port) so its
// URL construction is purely metadata-driven; tests synthesize a legacy
// port endpoint here to drive the same code path.
function makeTestEndpoint(
  port: number,
  overrides: Partial<DaemonClientEndpoint> = {},
): DaemonClientEndpoint {
  return {
    port,
    connectHost: "127.0.0.1",
    apiUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    bindHost: null,
    runtime: null,
    pid: null,
    source: "legacy-port",
    ...overrides,
  };
}

// ── Unit Tests: Detection ─────────────────────────────────────────

describe("daemon proxy detection", () => {
  beforeEach(() => {
    _resetDetectionCacheForTesting();
  });

  afterEach(() => {
    _resetDetectionCacheForTesting();
  });

  // AC: @daemon-proxy-detection ac-legacy-port-file-fallback — negative case: detection reports unavailable when the legacy port file is absent
  it("returns unavailable when no port file exists", async () => {
    const originalHome = process.env.HOME;
    const tempDir = await createTempDir();
    try {
      process.env.HOME = tempDir;
      const result = await detectDaemon();
      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.reason).toBe("no port file");
      }
    } finally {
      process.env.HOME = originalHome!;
      await cleanupTempDir(tempDir);
    }
  });

  // AC: @daemon-proxy-detection ac-fast-detection
  it("fails fast when port file missing (< 50ms)", async () => {
    const originalHome = process.env.HOME;
    const tempDir = await createTempDir();
    try {
      process.env.HOME = tempDir;
      const start = performance.now();
      await detectDaemon();
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    } finally {
      process.env.HOME = originalHome!;
      await cleanupTempDir(tempDir);
    }
  });

  // AC: @daemon-proxy-detection ac-fast-detection
  it("fails fast on connection refused", async () => {
    const originalHome = process.env.HOME;
    const tempDir = await createTempDir();
    try {
      const isolatedHome = await createIsolatedKspecHome(tempDir);
      process.env.HOME = isolatedHome.homeDir;
      // Legacy port pointing at a port that is not listening
      writeLegacyDaemonPort({ home: isolatedHome, port: 59999 });

      const result = await detectDaemon();

      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.reason).toBe("connection refused");
      }
    } finally {
      process.env.HOME = originalHome!;
      await cleanupTempDir(tempDir);
    }
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
  // AC: @daemon-network-endpoint-contract ac-tests-use-resolved-endpoint
  // AC: @daemon-proxy-detection ac-connection-metadata-check
  // AC: @cli-daemon-proxy ac-auto-detect
  // AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
  // AC: @daemon-test-endpoint-consistency ac-mock-metadata-fidelity
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  it("uses the advertised api_url from daemon.connection.json when present", async () => {
    const originalHome = process.env.HOME;
    const tempDir = await createTempDir();
    let mock: MockDaemonClient | undefined;
    try {
      const isolatedHome = await createIsolatedKspecHome(tempDir);
      process.env.HOME = isolatedHome.homeDir;

      // Shared in-process mock daemon serves /api/health out of the box.
      mock = (await startMockDaemon()) ?? undefined;
      expect(mock).toBeDefined();

      // Write canonical metadata advertising the mock's endpoint, then
      // overwrite the legacy port file with an unrelated, non-listening
      // port so a successful health check here proves detection used the
      // metadata path rather than legacy fallback.
      writeMockDaemonMetadata({ home: isolatedHome, client: mock! });
      writeFileSync(isolatedHome.daemonPortFilePath, "1");

      const result = await detectDaemon();
      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.port).toBe(mock!.port);
        expect(result.endpoint.source).toBe("metadata");
        expect(result.endpoint.apiUrl).toBe(`http://127.0.0.1:${mock!.port}`);
        expect(result.endpoint.wsUrl).toBe(`ws://127.0.0.1:${mock!.port}/ws`);
      }
    } finally {
      process.env.HOME = originalHome!;
      if (mock) await mock.stop();
      await cleanupTempDir(tempDir);
    }
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-tests-use-resolved-endpoint
  // AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  // Detection must honor the metadata's bracketed IPv6 api_url instead of
  // re-deriving a URL from port alone.
  it("honors bracketed IPv6 api_url advertised by daemon metadata", async () => {
    const originalHome = process.env.HOME;
    const tempDir = await createTempDir();
    let mock: MockDaemonClient | undefined;
    try {
      const isolatedHome = await createIsolatedKspecHome(tempDir);
      process.env.HOME = isolatedHome.homeDir;

      mock = (await startMockDaemon({ bindHost: "::1" })) ?? undefined;
      if (!mock) {
        console.log("  ⊘ Skipping test - IPv6 loopback (::1) not available");
        return;
      }

      writeMockDaemonMetadata({ home: isolatedHome, client: mock });

      const result = await detectDaemon();
      expect(result.available).toBe(true);
      if (result.available) {
        // Bracketed IPv6 host preserved verbatim — never re-derived.
        expect(result.endpoint.apiUrl).toBe(`http://[::1]:${mock.port}`);
        expect(result.endpoint.wsUrl).toBe(`ws://[::1]:${mock.port}/ws`);
        expect(result.endpoint.connectHost).toBe("::1");
      }
    } finally {
      process.env.HOME = originalHome!;
      if (mock) await mock.stop();
      await cleanupTempDir(tempDir);
    }
  });

  // AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
  it("falls back to legacy daemon.port when connection metadata is absent", async () => {
    const originalHome = process.env.HOME;
    const tempDir = await createTempDir();
    let mock: MockDaemonClient | undefined;
    try {
      const isolatedHome = await createIsolatedKspecHome(tempDir);
      process.env.HOME = isolatedHome.homeDir;

      mock = (await startMockDaemon()) ?? undefined;
      expect(mock).toBeDefined();

      // Legacy fallback path: only daemon.port written, no metadata.
      writeLegacyDaemonPort({ home: isolatedHome, port: mock!.port });

      const result = await detectDaemon();
      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.port).toBe(mock!.port);
        expect(result.endpoint.source).toBe("legacy-port");
        expect(result.endpoint.apiUrl).toBe(`http://127.0.0.1:${mock!.port}`);
      }
    } finally {
      process.env.HOME = originalHome!;
      if (mock) await mock.stop();
      await cleanupTempDir(tempDir);
    }
  });

  it("caches detection result for process lifetime", async () => {
    _setDetectionCacheForTesting({ available: true, port: 3456 });
    const result = await detectDaemon();
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.port).toBe(3456);
    }
  });

  it("reset clears the detection cache", async () => {
    _setDetectionCacheForTesting({ available: true, port: 3456 });
    _resetDetectionCacheForTesting();

    const originalHome = process.env.HOME;
    const tempDir = await createTempDir();
    try {
      process.env.HOME = tempDir;
      const result = await detectDaemon();
      expect(result.available).toBe(false);
    } finally {
      process.env.HOME = originalHome!;
      await cleanupTempDir(tempDir);
    }
  });
});

// ── Unit Tests: shouldProxyCommand ────────────────────────────────

describe("shouldProxyCommand", () => {
  let savedNoDaemon: string | undefined;

  beforeEach(() => {
    _resetDetectionCacheForTesting();
    savedNoDaemon = process.env.KSPEC_NO_DAEMON;
  });

  afterEach(() => {
    _resetDetectionCacheForTesting();
    // Properly restore KSPEC_NO_DAEMON
    if (savedNoDaemon === undefined) {
      delete process.env.KSPEC_NO_DAEMON;
    } else {
      process.env.KSPEC_NO_DAEMON = savedNoDaemon;
    }
  });

  // AC: @cli-daemon-proxy ac-force-direct
  it("returns proxy:false when KSPEC_NO_DAEMON=1", async () => {
    process.env.KSPEC_NO_DAEMON = "1";
    _setDetectionCacheForTesting({ available: true, port: 3456 });

    const result = await shouldProxyCommand({ forceDaemon: false });
    expect(result.proxy).toBe(false);
  });

  // AC: @cli-daemon-proxy ac-force-proxy
  it("returns proxy:true when --daemon and daemon is available", async () => {
    delete process.env.KSPEC_NO_DAEMON;
    _setDetectionCacheForTesting({ available: true, port: 3456 });

    const result = await shouldProxyCommand({ forceDaemon: true });
    expect(result.proxy).toBe(true);
    if (result.proxy) {
      expect(result.port).toBe(3456);
    }
  });

  // AC: @cli-daemon-proxy ac-force-proxy
  it("returns proxy:false with reason when --daemon but no daemon", async () => {
    delete process.env.KSPEC_NO_DAEMON;
    _setDetectionCacheForTesting({ available: false, reason: "no port file" });

    const result = await shouldProxyCommand({ forceDaemon: true });
    expect(result.proxy).toBe(false);
    if (!result.proxy) {
      expect(result.reason).toContain("daemon required but unavailable");
    }
  });

  // No AC annotation: ac-auto-detect requires reading connection metadata,
  // which is not yet implemented. This test bypasses detection via the
  // testing cache helper and only exercises the routing decision.
  it("returns proxy:true when daemon is available", async () => {
    delete process.env.KSPEC_NO_DAEMON;
    _setDetectionCacheForTesting({ available: true, port: 4567 });

    const result = await shouldProxyCommand({ forceDaemon: false });
    expect(result.proxy).toBe(true);
    if (result.proxy) {
      expect(result.port).toBe(4567);
    }
  });

  // AC: @cli-daemon-proxy ac-direct-fallback
  it("returns proxy:false when no daemon available (fallback)", async () => {
    delete process.env.KSPEC_NO_DAEMON;
    _setDetectionCacheForTesting({ available: false, reason: "connection refused" });

    const result = await shouldProxyCommand({ forceDaemon: false });
    expect(result.proxy).toBe(false);
  });
});

// ── Unit Tests: extractCommandPayload ─────────────────────────────

describe("extractCommandPayload", () => {
  it("extracts command path from nested Commander command", () => {
    const mockCommand = {
      name: () => "add",
      parent: {
        name: () => "task",
        parent: {
          name: () => "kspec",
          parent: null,
        },
      },
      opts: () => ({ text: "hello world", tag: ["cli", "mvp"] }),
      registeredArguments: [],
      processedArgs: [],
    };

    const result = extractCommandPayload(mockCommand);
    expect(result.command).toBe("task add");
    expect(result.args).toEqual({ text: "hello world", tag: ["cli", "mvp"] });
  });

  it("converts camelCase options to kebab-case", () => {
    const mockCommand = {
      name: () => "set",
      parent: {
        name: () => "task",
        parent: { name: () => "kspec", parent: null },
      },
      opts: () => ({ specRef: "@my-spec", dryRun: true }),
      registeredArguments: [],
      processedArgs: [],
    };

    const result = extractCommandPayload(mockCommand);
    expect(result.args["spec-ref"]).toBe("@my-spec");
    expect(result.args["dry-run"]).toBe(true);
  });

  it("extracts positional arguments", () => {
    const mockCommand = {
      name: () => "get",
      parent: {
        name: () => "task",
        parent: { name: () => "kspec", parent: null },
      },
      opts: () => ({}),
      registeredArguments: [{ name: () => "ref", required: true, variadic: false }],
      processedArgs: ["@my-task"],
    };

    const result = extractCommandPayload(mockCommand);
    expect(result.command).toBe("task get");
    expect(result.args.ref).toBe("@my-task");
  });

  it("filters out proxy-only options (daemon, debug-shadow)", () => {
    const mockCommand = {
      name: () => "list",
      parent: {
        name: () => "task",
        parent: { name: () => "kspec", parent: null },
      },
      opts: () => ({ daemon: true, debugShadow: true, json: true }),
      registeredArguments: [],
      processedArgs: [],
    };

    const result = extractCommandPayload(mockCommand);
    expect(result.args).not.toHaveProperty("daemon");
    expect(result.args).not.toHaveProperty("debug-shadow");
    expect(result.args.json).toBe(true);
  });

  it("skips undefined option values", () => {
    const mockCommand = {
      name: () => "list",
      parent: {
        name: () => "tasks",
        parent: { name: () => "kspec", parent: null },
      },
      opts: () => ({ status: undefined, verbose: false }),
      registeredArguments: [],
      processedArgs: [],
    };

    const result = extractCommandPayload(mockCommand);
    expect(result.args).not.toHaveProperty("status");
    expect(result.args.verbose).toBe(false);
  });
});

// ── Unit Tests: proxyCommand ─────────────────────────────────────

describe("proxyCommand", () => {
  let testServer: http.Server | undefined;

  afterEach(async () => {
    if (testServer) {
      await closeServer(testServer);
      testServer = undefined;
    }
  });

  // AC: @cli-daemon-proxy ac-transparent-output
  it("returns stdout/stderr/exitCode from daemon response", async () => {
    const { server, port } = await createTestServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);
      if (url.pathname === "/api/projects") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (url.pathname === "/api/command") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            stdout: "task list output\n",
            stderr: "",
            exitCode: 0,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    });
    testServer = server;

    const result = await proxyCommand({
      endpoint: makeTestEndpoint(port),
      command: "task list",
      args: {},
      projectPath: "/tmp/test-project",
      isMutating: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.stdout).toBe("task list output\n");
      expect(result.result.stderr).toBe("");
      expect(result.result.exitCode).toBe(0);
    }
  });

  // AC: @cli-daemon-proxy ac-transparent-output (non-zero exit code)
  it("preserves non-zero exit codes from daemon", async () => {
    const { server, port } = await createTestServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);
      if (url.pathname === "/api/projects") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (url.pathname === "/api/command") {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            stdout: "",
            stderr: "error: task not found\n",
            exitCode: 3,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    });
    testServer = server;

    const result = await proxyCommand({
      endpoint: makeTestEndpoint(port),
      command: "task get",
      args: { ref: "@nonexistent" },
      projectPath: "/tmp/test-project",
      isMutating: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.exitCode).toBe(3);
      expect(result.result.stderr).toContain("task not found");
    }
  });

  // AC: @cli-daemon-proxy ac-timeout-fallback
  it("falls back to direct mode on read-only connection failure", async () => {
    const result = await proxyCommand({
      endpoint: makeTestEndpoint(1),
      command: "task list",
      args: {},
      projectPath: "/tmp/test-project",
      isMutating: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallbackToDirectMode).toBe(true);
    }
  });

  // AC: @cli-daemon-proxy ac-timeout-mutation-error
  it("returns error (no fallback) on mutation connection failure", async () => {
    const result = await proxyCommand({
      endpoint: makeTestEndpoint(1),
      command: "task start",
      args: { ref: "@my-task" },
      projectPath: "/tmp/test-project",
      isMutating: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallbackToDirectMode).toBe(false);
    }
  });

  // AC: @daemon-proxy-detection ac-project-registered
  it("registers project with daemon before routing command", async () => {
    let registrationReceived = false;

    const { server, port } = await createTestServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);
      if (url.pathname === "/api/projects" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as { path: string };
        expect(body.path).toBe("/tmp/my-project");
        registrationReceived = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "registered" }));
        return;
      }
      if (url.pathname === "/api/command") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ stdout: "ok\n", stderr: "", exitCode: 0 }));
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    });
    testServer = server;

    await proxyCommand({
      endpoint: makeTestEndpoint(port),
      command: "task list",
      args: {},
      projectPath: "/tmp/my-project",
      isMutating: false,
    });

    expect(registrationReceived).toBe(true);
  });

  // AC: @cli-daemon-proxy ac-mutation-coherence
  it("sends mutating command to daemon for coherent cache updates", async () => {
    let receivedCommand: Record<string, unknown> | null = null;

    const { server, port } = await createTestServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);
      if (url.pathname === "/api/projects") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (url.pathname === "/api/command" && req.method === "POST") {
        receivedCommand = JSON.parse(await readBody(req)) as Record<string, unknown>;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            stdout: "OK Started task\n",
            stderr: "",
            exitCode: 0,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    });
    testServer = server;

    const result = await proxyCommand({
      endpoint: makeTestEndpoint(port),
      command: "task start",
      args: { ref: "@my-task" },
      projectPath: "/tmp/test-project",
      isMutating: true,
    });

    expect(result.ok).toBe(true);
    expect(receivedCommand).not.toBeNull();
    expect(receivedCommand!.command).toBe("task start");
    expect((receivedCommand!.args as Record<string, unknown>).ref).toBe("@my-task");
  });

  // AC: @cli-daemon-proxy ac-read-from-cache
  it("sends X-Kspec-Dir header for project-scoped cache reads", async () => {
    let receivedDir: string | null = null;

    const { server, port } = await createTestServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);
      if (url.pathname === "/api/projects") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (url.pathname === "/api/command") {
        receivedDir = req.headers["x-kspec-dir"] as string;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ stdout: "data\n", stderr: "", exitCode: 0 }));
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    });
    testServer = server;

    await proxyCommand({
      endpoint: makeTestEndpoint(port),
      command: "task list",
      args: {},
      projectPath: "/home/user/my-project",
      isMutating: false,
    });

    expect(receivedDir).toBe("/home/user/my-project");
  });

  // AC: @daemon-proxy-detection ac-project-registered (registration timeout)
  it("continues to command routing when project registration stalls", async () => {
    // /api/projects never responds — simulates stalled registration
    // The command should still proceed (registration is non-fatal)
    const { server, port } = await createTestServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);
      if (url.pathname === "/api/projects") {
        // Never respond — simulates hung registration endpoint
        return;
      }
      if (url.pathname === "/api/command") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ stdout: "ok\n", stderr: "", exitCode: 0 }));
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    });
    testServer = server;

    const start = performance.now();
    const result = await proxyCommand({
      endpoint: makeTestEndpoint(port),
      command: "task list",
      args: {},
      projectPath: "/tmp/test-project",
      isMutating: false,
    });
    const elapsed = performance.now() - start;

    // Registration should time out and continue to command routing
    // Total time should be bounded (registration timeout + command execution)
    expect(result.ok).toBe(true);
    // Should complete within registration timeout (5s) + reasonable overhead,
    // not hang indefinitely
    expect(elapsed).toBeLessThan(10_000);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  // AC: @trait-daemon-endpoint-consumer ac-wildcard-not-destination
  // AC: @daemon-proxy-detection ac-connection-metadata-check
  // proxyCommand must call the api_url that the endpoint advertises, not
  // re-derive `http://127.0.0.1:<port>` from the port. Drive a real local
  // server on a non-default loopback (127.0.0.2 on Linux) and prove the
  // request landed on the advertised host. The endpoint reports
  // bind_host=0.0.0.0 (wildcard) but connect_host=127.0.0.2, so this also
  // proves the consumer addresses the non-wildcard destination.
  it("calls the endpoint's advertised api_url verbatim, not a constructed 127.0.0.1 URL", async () => {
    let receivedHost: string | null = null;
    const started = await new Promise<{ server: http.Server; port: number } | null>((resolve) => {
      const server = http.createServer(async (req, res) => {
        receivedHost = req.headers.host ?? null;
        const url = new URL(req.url!, `http://${req.headers.host ?? "127.0.0.1"}`);
        if (url.pathname === "/api/projects") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        if (url.pathname === "/api/command") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ stdout: "ok\n", stderr: "", exitCode: 0 }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      server.once("error", () => resolve(null));
      server.listen(0, "127.0.0.2", () => {
        const addr = server.address() as { port: number } | null;
        if (!addr) {
          server.close(() => resolve(null));
          return;
        }
        resolve({ server, port: addr.port });
      });
    });
    if (!started) {
      // Skip when 127.0.0.2 is not locally addressable (macOS / Windows).
      console.log("  ⊘ Skipping test - 127.0.0.2 loopback alias not available");
      return;
    }
    testServer = started.server;
    const advertisedPort = started.port;

    // Build an endpoint that advertises 127.0.0.2 even though the test
    // server is also reachable at 127.0.0.1. If proxyCommand re-derived
    // the URL from port alone, the request would land on 127.0.0.1 and
    // the Host header would not match the advertised connect_host.
    const endpoint = makeTestEndpoint(advertisedPort, {
      connectHost: "127.0.0.2",
      apiUrl: `http://127.0.0.2:${advertisedPort}`,
      wsUrl: `ws://127.0.0.2:${advertisedPort}/ws`,
      bindHost: "0.0.0.0",
      runtime: "node",
      pid: 12345,
      source: "metadata",
    });

    const result = await proxyCommand({
      endpoint,
      command: "task list",
      args: {},
      projectPath: "/tmp/test-project",
      isMutating: false,
    });

    expect(result.ok).toBe(true);
    expect(receivedHost).toBe(`127.0.0.2:${advertisedPort}`);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  // proxyCommand must honor IPv6 bracketed hosts that come from metadata
  // — clients receive a bracketed api_url already and should not re-bracket
  // or otherwise re-derive it.
  it("uses bracketed IPv6 api_url verbatim from metadata", async () => {
    const ipv6Started = await new Promise<{ server: http.Server; port: number } | null>(
      (resolve) => {
        const server = http.createServer((req, res) => {
          const url = new URL(req.url!, `http://${req.headers.host ?? "::1"}`);
          if (url.pathname === "/api/projects") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
          }
          if (url.pathname === "/api/command") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ stdout: "ok\n", stderr: "", exitCode: 0 }));
            return;
          }
          res.writeHead(404);
          res.end();
        });
        server.once("error", () => resolve(null));
        server.listen(0, "::1", () => {
          const addr = server.address() as { port: number } | null;
          if (!addr) {
            server.close(() => resolve(null));
            return;
          }
          resolve({ server, port: addr.port });
        });
      },
    );
    if (!ipv6Started) {
      console.log("  ⊘ Skipping test - IPv6 loopback (::1) not available");
      return;
    }
    testServer = ipv6Started.server;

    const endpoint = makeTestEndpoint(ipv6Started.port, {
      connectHost: "::1",
      apiUrl: `http://[::1]:${ipv6Started.port}`,
      wsUrl: `ws://[::1]:${ipv6Started.port}/ws`,
      bindHost: "::1",
      runtime: "node",
      pid: 4242,
      source: "metadata",
    });

    const result = await proxyCommand({
      endpoint,
      command: "task list",
      args: {},
      projectPath: "/tmp/test-project",
      isMutating: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.exitCode).toBe(0);
    }
  });
});

// ── E2E Tests: CLI Integration ────────────────────────────────────
// E2E tests use a mock daemon in a CHILD PROCESS because the kspec()
// test helper uses spawnSync which blocks the event loop, preventing
// an in-process HTTP server from accepting connections.

describe("CLI daemon proxy E2E", () => {
  let tempDir: string;
  let mock: MockDaemonClient | undefined;

  beforeEach(async () => {
    // Clean up KSPEC_NO_DAEMON that may leak from unit tests in same process
    delete process.env.KSPEC_NO_DAEMON;

    tempDir = await createTempDir();
    initGitRepo(tempDir);
    // Create minimal .kspec/ project structure
    mkdirSync(join(tempDir, ".kspec"), { recursive: true });
    writeFileSync(join(tempDir, ".kspec", "kynetic.yaml"), "project_name: test-project\n");
    writeFileSync(join(tempDir, ".kspec", "project.tasks.yaml"), "[]\n");
    writeFileSync(join(tempDir, ".kspec", "project.inbox.yaml"), "[]\n");
    // Disable daemon auto-start so tests that clear KSPEC_NO_DAEMON for proxy
    // detection don't leak orphan daemons via the implicit auto-start hook.
    writeFileSync(join(tempDir, "kspec.config.yaml"), "daemon:\n  auto_start: false\n");
  });

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = undefined;
    }
    await cleanupTempDir(tempDir);
  });

  // AC: @cli-daemon-proxy ac-force-direct
  it("KSPEC_NO_DAEMON=1 skips daemon routing entirely", async () => {
    const isolatedHome = await createIsolatedKspecHome(tempDir);
    // Write port file pointing to a real port — but KSPEC_NO_DAEMON should skip
    writeFileSync(isolatedHome.daemonPortFilePath, "59999");
    writeFileSync(isolatedHome.daemonPidFilePath, String(process.pid));

    const result = kspec("task list --json", tempDir, {
      env: {
        ...isolatedHome.env,
        KSPEC_NO_DAEMON: "1",
      },
    });

    expect(result.exitCode).toBe(0);
  });

  // AC: @cli-daemon-proxy ac-force-direct-management-exception
  it("KSPEC_NO_DAEMON=1 does not redirect daemon management commands to direct mode", async () => {
    const isolatedHome = await createIsolatedKspecHome(tempDir);
    // Write a pid pointing at a live process (the test runner itself) and a
    // dummy port. If KSPEC_NO_DAEMON forced direct shadow mode, `serve status`
    // would short-circuit and report running:false. The exception lets the
    // lifecycle command read pid state and report running:true.
    writeFileSync(isolatedHome.daemonPortFilePath, "59999");
    writeFileSync(isolatedHome.daemonPidFilePath, String(process.pid));

    const result = kspec("serve status --json", tempDir, {
      env: {
        ...isolatedHome.env,
        KSPEC_NO_DAEMON: "1",
      },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { running: boolean; pid: number | null };
    expect(parsed.running).toBe(true);
    expect(parsed.pid).toBe(process.pid);
  });

  // AC: @cli-daemon-proxy ac-force-proxy
  // AC: @trait-error-guidance ac-1 — error includes description
  // AC: @trait-error-guidance ac-2 — error includes suggested action
  it("--daemon flag fails with clear error when no daemon running", async () => {
    const isolatedHome = await createIsolatedKspecHome(tempDir);

    const result = kspec("task list --daemon", tempDir, {
      expectFail: true,
      env: {
        ...isolatedHome.env,
        KSPEC_NO_DAEMON: "", // Explicitly unset
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("daemon required but unavailable");
    expect(result.stderr).toContain("kspec serve start");
  });

  // AC: @cli-daemon-proxy ac-direct-fallback
  it("falls back to direct mode when no daemon is available", async () => {
    const isolatedHome = await createIsolatedKspecHome(tempDir);

    const result = kspec("task list --json", tempDir, {
      env: {
        ...isolatedHome.env,
        KSPEC_NO_DAEMON: "", // Explicitly unset
      },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  // AC: @daemon-proxy-detection ac-legacy-port-file-fallback — positive case: legacy port file lets detection succeed and the command is routed through the daemon
  // AC: @cli-daemon-proxy ac-transparent-output — proxied stdout matches direct mode
  // (ac-auto-detect via metadata is deferred to the metadata implementation tasks)
  it("routes command through daemon when available and output matches", async () => {
    const isolatedHome = await createIsolatedKspecHome(tempDir);

    // Start mock daemon in a child process so spawnSync doesn't block it
    mock = (await startMockDaemon({ asChildProcess: true, mode: "normal" })) ?? undefined;
    expect(mock).toBeDefined();
    writeLegacyDaemonPort({ home: isolatedHome, port: mock!.port });

    const result = kspec("task list", tempDir, {
      env: {
        ...isolatedHome.env,
        KSPEC_NO_DAEMON: "", // Explicitly unset — unit tests may leak into process.env
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("proxied: task list");
  });

  // AC: @cli-daemon-proxy ac-transparent-output (exit code preservation)
  it("preserves non-zero exit codes from proxied commands", async () => {
    const isolatedHome = await createIsolatedKspecHome(tempDir);

    // Start mock daemon in error mode
    mock = (await startMockDaemon({ asChildProcess: true, mode: "error" })) ?? undefined;
    expect(mock).toBeDefined();
    writeLegacyDaemonPort({ home: isolatedHome, port: mock!.port });

    const result = kspec("task get @nonexistent", tempDir, {
      expectFail: true,
      env: {
        ...isolatedHome.env,
        KSPEC_NO_DAEMON: "", // Explicitly unset
      },
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("not found");
  });

  // AC: @cli-daemon-proxy ac-direct-fallback (connection error fallback)
  it("falls back to direct mode when daemon port file exists but daemon is dead", async () => {
    const isolatedHome = await createIsolatedKspecHome(tempDir);
    writeFileSync(isolatedHome.daemonPortFilePath, "59998");

    const result = kspec("task list --json", tempDir, {
      env: {
        ...isolatedHome.env,
        KSPEC_NO_DAEMON: "", // Explicitly unset
      },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });
});

// ── Health Check Timeout Tests ────────────────────────────────────

describe("daemon proxy health check timeout", () => {
  let testServer: http.Server | undefined;

  beforeEach(() => {
    _resetDetectionCacheForTesting();
  });

  afterEach(async () => {
    _resetDetectionCacheForTesting();
    if (testServer) {
      await closeServer(testServer);
      testServer = undefined;
    }
  });

  // AC: @daemon-proxy-detection ac-health-timeout
  // Detection now reads metadata first; this test exercises the 200ms
  // health-check timeout via the legacy port path because the same
  // detection code path runs in both cases — see the metadata-keyed
  // timeout test below for the metadata variant.
  it("times out within 200ms when daemon is unresponsive", async () => {
    const originalHome = process.env.HOME;
    const tempDir = await createTempDir();

    // Start a server that never responds to health checks. Custom server
    // used here because the shared mock daemon helper does not support a
    // hang-on-/api/health mode (its `hang` mode targets /api/command).
    const { server, port } = await createTestServer((_req, _res) => {
      // Never respond — simulates unresponsive daemon
    });
    testServer = server;

    try {
      const isolatedHome = await createIsolatedKspecHome(tempDir);
      process.env.HOME = isolatedHome.homeDir;
      writeLegacyDaemonPort({ home: isolatedHome, port });

      const start = performance.now();
      const result = await detectDaemon();
      const elapsed = performance.now() - start;

      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.reason).toBe("health check timed out");
      }
      // Should complete within 200ms + reasonable overhead
      expect(elapsed).toBeLessThan(500);
    } finally {
      process.env.HOME = originalHome!;
      await cleanupTempDir(tempDir);
    }
  });

  // AC: @daemon-proxy-detection ac-health-timeout
  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-test-endpoint-consistency ac-mock-metadata-fidelity
  // Drive the 200ms health-check timeout against the metadata-advertised
  // api_url so the metadata-keyed variant of ac-health-timeout has direct
  // behavioral coverage.
  it("times out within 200ms against the metadata-advertised endpoint", async () => {
    const originalHome = process.env.HOME;
    const tempDir = await createTempDir();

    // Custom hang server; helper does not hang on /api/health.
    const { server, port } = await createTestServer((_req, _res) => {
      // Hang — never respond to /api/health.
    });
    testServer = server;

    try {
      const isolatedHome = await createIsolatedKspecHome(tempDir);
      process.env.HOME = isolatedHome.homeDir;
      // Build a synthetic MockDaemonClient pointing at the hung server so
      // the metadata writer renders the canonical schema for that endpoint.
      const fakeClient: MockDaemonClient = {
        port,
        bindHost: "127.0.0.1",
        apiUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/ws`,
        requests: () => [],
        stop: async () => {},
      };
      writeMockDaemonMetadata({ home: isolatedHome, client: fakeClient });

      const start = performance.now();
      const result = await detectDaemon();
      const elapsed = performance.now() - start;

      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.reason).toBe("health check timed out");
      }
      expect(elapsed).toBeLessThan(500);
    } finally {
      process.env.HOME = originalHome!;
      await cleanupTempDir(tempDir);
    }
  });

  // AC: @daemon-proxy-detection ac-legacy-port-file-fallback
  it("detects running daemon via port file and health check", async () => {
    const originalHome = process.env.HOME;
    const tempDir = await createTempDir();
    let mock: MockDaemonClient | undefined;

    try {
      const isolatedHome = await createIsolatedKspecHome(tempDir);
      process.env.HOME = isolatedHome.homeDir;

      mock = (await startMockDaemon()) ?? undefined;
      expect(mock).toBeDefined();
      writeLegacyDaemonPort({ home: isolatedHome, port: mock!.port });

      const result = await detectDaemon();
      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.port).toBe(mock!.port);
      }
    } finally {
      process.env.HOME = originalHome!;
      if (mock) await mock.stop();
      await cleanupTempDir(tempDir);
    }
  });
});
