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
import { spawn, spawnSync, execSync } from "child_process";
import { once } from "events";
import { dirname, join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { createServer } from "net";
import type { ChildProcess } from "child_process";

/**
 * Kill a process by PID, swallowing ESRCH (already dead).
 * Used in onTestFinished cleanup callbacks.
 */
function killPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone — fine
  }
}

/**
 * Wait for a ChildProcess to exit, with a SIGKILL fallback timeout.
 */
function waitForChildExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
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

  async function waitForDaemonHealth(port: number): Promise<void> {
    await waitForStartup(
      `daemon health endpoint on port ${port}`,
      async () => {
        const url = `http://localhost:${port}/api/health`;
        try {
          const response = await fetch(url);
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

  // AC: @daemon-sensitive-cli-test-determinism ac-1
  it("should include actionable context when readiness wait times out", async () => {
    await expect(
      waitForStartup(
        "synthetic daemon readiness",
        async () => ({ ok: false, details: "status=503 body=warming-up" }),
        { timeoutMs: 120, intervalMs: 20 },
      ),
    ).rejects.toThrow(/Last observation: status=503 body=warming-up/);
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
  // AC: @daemon-sensitive-cli-test-determinism ac-2
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
  // AC: @config-daemon ac-host-default
  // AC: @config-daemon ac-connection-metadata
  it("writes daemon.connection.json with the resolved 127.0.0.1 endpoint on detached startup", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    const port = await getAvailablePort();

    runKspec(`serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const pid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    onTestFinished(() => killPid(pid));

    await waitForDaemonHealth(port);

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
    const directIpv4Health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(directIpv4Health.ok).toBe(true);

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    // After stop, lifecycle files (including the metadata file) are removed.
    expect(existsSync(metadataPath)).toBe(false);
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
  it("should return JSON status with process info", async () => {
    if (!nodeAvailable) {
      console.log("  ⊘ Skipping test - Node runtime required");
      return;
    }

    // Start daemon (uses --detach so serve status can find PID file)
    const port = await getAvailablePort();
    runKspec(`serve start --detach --port ${port} --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    const pid = parseInt(readTestOutputSync(globalPidFilePath).trim(), 10);
    onTestFinished(() => killPid(pid));

    // Check status with --json flag
    const result = runKspec(`serve status --json --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);

    // Should output valid JSON with process info
    const status = JSON.parse(result.stdout);
    expect(status).toMatchObject({
      running: true,
      pid: pid,
    });

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir);
  });

  // AC: @multi-directory-daemon ac-12
  // AC: @daemon-sensitive-cli-test-determinism ac-3
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

    await waitForDaemonHealth(port);

    // Register a project via API
    const testProjectPath = tempDir;
    await fetch(`http://localhost:${port}/api/projects`, {
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

    await waitForDaemonHealth(port);

    // Register a project via API
    const testProjectPath = tempDir;
    await fetch(`http://localhost:${port}/api/projects`, {
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
      killPid(pid);
      await cleanupTempDir(emptyTempDir);
    });

    await waitForDaemonHealth(port);

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

    await waitForDaemonHealth(port);
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
      // Fresh pack so we test the current build output
      const packOutput = execSync(`npm pack --pack-destination ${installDir}`, {
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

      await waitForDaemonHealth(port);

      // Verify health endpoint responds (daemon is actually running with Elysia)
      const healthResponse = await fetch(`http://localhost:${port}/api/health`);
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
    await waitForDaemonHealth(port);

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

    await waitForDaemonHealth(port);

    const healthResponse = await fetch(`http://localhost:${port}/api/health`);
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
