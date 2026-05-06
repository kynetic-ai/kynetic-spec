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
 *
 * Not covered here (deferred to metadata implementation tasks):
 * - @cli-daemon-proxy ac-auto-detect (metadata-keyed)
 * - @daemon-proxy-detection ac-connection-metadata-check
 * - @daemon-proxy-detection ac-health-timeout (metadata-keyed)
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
import { ChildProcess, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createIsolatedKspecHome,
  createTempDir,
  initGitRepo,
  kspec,
} from "./helpers/cli.js";

import {
  detectDaemon,
  shouldProxyCommand,
  proxyCommand,
  extractCommandPayload,
  _resetDetectionCacheForTesting,
  _setDetectionCacheForTesting,
} from "../src/cli/daemon-proxy.js";

// ── Helper: Create a Node HTTP server and return its address ──────

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

// ── Helper: Start mock daemon in a child process ──────────────────
// Uses a separate process so spawnSync in kspec() helper doesn't
// block the event loop and prevent the mock server from accepting.

const MOCK_DAEMON_SCRIPT = join(import.meta.dirname, "helpers", "mock-daemon.cjs");

function startMockDaemon(mode: "normal" | "error" | "hang" = "normal"): Promise<{
  process: ChildProcess;
  port: number;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [MOCK_DAEMON_SCRIPT, "--mode", mode], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Port is the first line of stdout
      const match = stdout.match(/^(\d+)\n/);
      if (match) {
        resolve({ process: child, port: parseInt(match[1], 10) });
      }
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (!stdout.includes("\n")) {
        reject(new Error(`Mock daemon exited with code ${code} before reporting port`));
      }
    });
  });
}

function stopMockDaemon(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    // Force kill after 2s
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
  });
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
      process.env.HOME = tempDir;
      // Write a port file pointing to a port that is not listening
      const configDir = join(tempDir, ".config", "kspec");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "daemon.port"), "59999");

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
      port,
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
      port,
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
      port: 1, // Invalid port — connection will be refused
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
      port: 1, // Invalid port
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
      port,
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
      port,
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
      port,
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
      port,
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
});

// ── E2E Tests: CLI Integration ────────────────────────────────────
// E2E tests use a mock daemon in a CHILD PROCESS because the kspec()
// test helper uses spawnSync which blocks the event loop, preventing
// an in-process HTTP server from accepting connections.

describe("CLI daemon proxy E2E", () => {
  let tempDir: string;
  let mockDaemonProcess: ChildProcess | undefined;

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
    if (mockDaemonProcess) {
      await stopMockDaemon(mockDaemonProcess);
      mockDaemonProcess = undefined;
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
    const { process: daemon, port } = await startMockDaemon("normal");
    mockDaemonProcess = daemon;

    writeFileSync(isolatedHome.daemonPortFilePath, String(port));
    writeFileSync(isolatedHome.daemonPidFilePath, String(process.pid));

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
    const { process: daemon, port } = await startMockDaemon("error");
    mockDaemonProcess = daemon;

    writeFileSync(isolatedHome.daemonPortFilePath, String(port));
    writeFileSync(isolatedHome.daemonPidFilePath, String(process.pid));

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

  // No AC annotation: ac-health-timeout's "given" requires daemon connection
  // metadata, which is not yet read by the implementation. This test
  // exercises the same 200ms timeout via the legacy port file path; the
  // metadata-keyed AC will be covered by the metadata implementation tasks.
  it("times out within 200ms when daemon is unresponsive", async () => {
    const originalHome = process.env.HOME;
    const tempDir = await createTempDir();

    // Start a server that never responds to health checks
    const { server, port } = await createTestServer((_req, _res) => {
      // Never respond — simulates unresponsive daemon
    });
    testServer = server;

    try {
      process.env.HOME = tempDir;
      const configDir = join(tempDir, ".config", "kspec");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "daemon.port"), String(port));

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

  // AC: @daemon-proxy-detection ac-legacy-port-file-fallback
  it("detects running daemon via port file and health check", async () => {
    const originalHome = process.env.HOME;
    const tempDir = await createTempDir();

    const { server, port } = await createTestServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);
      if (url.pathname === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    });
    testServer = server;

    try {
      process.env.HOME = tempDir;
      const configDir = join(tempDir, ".config", "kspec");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "daemon.port"), String(port));

      const result = await detectDaemon();
      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.port).toBe(port);
      }
    } finally {
      process.env.HOME = originalHome!;
      await cleanupTempDir(tempDir);
    }
  });
});
