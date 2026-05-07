import { test as base, expect } from "@playwright/test";
import { execSync, type ChildProcess, spawn } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  cpSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { createServer } from "net";
import { parse as parseYaml } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type DaemonRuntime = "bun" | "node";

// Daemon entry point — spawned directly to avoid CLI PID-file timeout
const DAEMON_ENTRY = join(__dirname, "../../../dist/daemon/index.js");
// CLI entry point — used for scoped `kspec serve stop` teardown (ac-4)
const KSPEC_CLI = join(__dirname, "../../../dist/cli/index.js");

// E2E fixtures live alongside this file
const E2E_FIXTURES = __dirname;
// Path to built web UI bundle copied by build:e2e. Using dist/web-ui avoids
// worktree-specific package build paths leaking into isolated daemon fixtures.
const WEB_UI_BUILD = join(__dirname, "../../../dist/web-ui");

export interface FixtureTaskCounts {
  /** Total number of tasks in the fixture */
  total: number;
  /** Per-status breakdown: { pending: N, in_progress: N, ... } */
  byStatus: Record<string, number>;
}

/**
 * Parse the e2e fixture task data and derive expected per-status counts.
 *
 * Reads from the split per-task YAML files under tasks/<ULID>/task.yaml
 * (canonical when task_storage.format is "split"), falling back to
 * project.tasks.yaml if no split directory exists.
 *
 * Throws if neither source can be found or parsed.
 */
export function getFixtureTaskCounts(): FixtureTaskCounts {
  const splitDir = join(E2E_FIXTURES, "tasks");
  let statuses: string[];

  if (existsSync(splitDir)) {
    // Read from split per-task YAML files (canonical for format: split)
    statuses = [];
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- reads e2e fixture files, not source code
    const taskDirs = readdirSync(splitDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const ulid of taskDirs) {
      const taskFile = join(splitDir, ulid, "task.yaml");
      if (!existsSync(taskFile)) continue;
      // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- reads e2e fixture files, not source code
      const content = readFileSync(taskFile, "utf8");
      const task = parseYaml(content) as { status?: string };
      if (task?.status) {
        statuses.push(task.status);
      }
    }

    if (statuses.length === 0) {
      throw new Error(`No valid task.yaml files found in split directory: ${splitDir}`);
    }
  } else {
    // Fallback: read project.tasks.yaml
    const tasksFile = join(E2E_FIXTURES, "project.tasks.yaml");
    if (!existsSync(tasksFile)) {
      throw new Error(
        `E2E fixture task data not found. Checked:\n  Split: ${splitDir}\n  File: ${tasksFile}`,
      );
    }
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- reads e2e fixture files, not source code
    const content = readFileSync(tasksFile, "utf8");
    const tasks = parseYaml(content) as Array<{ status?: string }>;
    if (!Array.isArray(tasks)) {
      throw new Error(`Expected array in ${tasksFile}, got ${typeof tasks}`);
    }
    statuses = tasks.map((t) => t.status ?? "unknown");
  }

  const byStatus: Record<string, number> = {};
  for (const status of statuses) {
    byStatus[status] = (byStatus[status] || 0) + 1;
  }

  return { total: statuses.length, byStatus };
}

interface DaemonFixture {
  tempDir: string;
  kspecDir: string;
  /** Ephemeral port the test daemon is listening on */
  port: number;
  /** Base URL for HTTP requests (http://localhost:<port>) */
  baseUrl: string;
  /** Base URL for WebSocket connections (ws://localhost:<port>) */
  wsUrl: string;
  /** Stop the isolated daemon while keeping fixture data intact */
  stop: () => Promise<void>;
  /** Start or restart the isolated daemon on the same port */
  start: () => Promise<void>;
  /** Create a valid second project for multi-project tests */
  createSecondProject: () => Promise<string>;
}

// AC: @e2e-test-daemon-isolation ac-dynamic-port-propagation — allocate dynamic port for fixture
async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
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

function resolveTestRuntime(env: NodeJS.ProcessEnv = process.env): DaemonRuntime {
  const runtime = env.KSPEC_TEST_RUNTIME ?? "node";
  if (runtime === "bun" || runtime === "node") {
    return runtime;
  }

  throw new Error(`Invalid KSPEC_TEST_RUNTIME "${runtime}". Expected "bun" or "node".`);
}

async function checkRuntimeAvailable(runtime: DaemonRuntime): Promise<boolean> {
  try {
    // Use 'where' on Windows, 'which' on Unix
    const cmd = process.platform === "win32" ? "where" : "which";
    execSync(`${cmd} ${runtime}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getRuntimeInstallHint(runtime: DaemonRuntime): string {
  if (runtime === "node") {
    return "https://nodejs.org/en/download";
  }

  return process.platform === "win32"
    ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
    : "curl -fsSL https://bun.sh/install | bash";
}

function buildDaemonChildEnv(runtime: DaemonRuntime, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { BUN_ENV: _bunEnv, NODE_ENV: _nodeEnv, ...childEnv } = env;
  if (runtime === "node") {
    return { ...childEnv, NODE_ENV: "production" };
  }

  return { ...childEnv, BUN_ENV: "production" };
}

export const test = base.extend<{ daemon: DaemonFixture }>({
  // AC: @e2e-test-daemon-isolation ac-browser-endpoint-from-fixture — Playwright baseURL supplied by daemon fixture
  baseURL: async ({ daemon }, use) => {
    await use(daemon.baseUrl);
  },

  daemon: [
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const runtime = resolveTestRuntime();

      if (!(await checkRuntimeAvailable(runtime))) {
        const runtimeName = runtime === "bun" ? "Bun" : "Node";
        throw new Error(
          `${runtimeName} runtime required for E2E daemon tests. Install: ${getRuntimeInstallHint(runtime)}`,
        );
      }

      // AC: @e2e-test-daemon-isolation ac-dynamic-port-propagation — allocate dynamic port for fixture
      const port = await getAvailablePort();
      const baseUrl = `http://localhost:${port}`;
      const wsUrl = `ws://localhost:${port}`;

      // Create temp directory with .kspec subdirectory
      // Use mkdtempSync for atomic unique path — safe under parallel Playwright workers
      const tempDir = mkdtempSync(join(tmpdir(), "kspec-e2e-"));
      const kspecDir = join(tempDir, ".kspec");
      mkdirSync(kspecDir, { recursive: true });

      // AC: @e2e-test-daemon-isolation ac-isolated-e2e-state — isolated HOME/config
      const isolatedHome = join(tempDir, ".home");
      const configDir = join(isolatedHome, ".config", "kspec");
      mkdirSync(configDir, { recursive: true });
      const {
        KSPEC_NO_DAEMON: _kspecNoDaemon,
        KSPEC_SESSION_ID: _kspecSessionId,
        ...baseEnv
      } = process.env;
      const isolatedEnv = {
        ...baseEnv,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        WEB_UI_DIR: WEB_UI_BUILD,
        KSPEC_TEST: "1",
        KSPEC_TEST_RUNTIME: runtime,
      };

      // Copy E2E test fixtures to .kspec subdirectory (simulating shadow worktree mode)
      if (existsSync(E2E_FIXTURES)) {
        cpSync(E2E_FIXTURES, kspecDir, {
          recursive: true,
          filter: (src) => !src.includes("test-base") && !src.includes("project-tests"),
        });
      } else {
        throw new Error(`E2E test fixtures not found at ${E2E_FIXTURES}`);
      }

      // Copy project-level tests directory for AC coverage scanning
      const projectTests = join(E2E_FIXTURES, "project-tests");
      if (existsSync(projectTests)) {
        cpSync(projectTests, join(tempDir, "tests"), { recursive: true });
      }

      // Configure coverage scanning for the copied project-tests directory.
      // Coverage scanning is explicit opt-in (AC: @coverage-scan-config ac-explicit-opt-in)
      // and the e2e items spec relies on AC coverage being detected for @test-feature ac-1.
      writeFileSync(join(tempDir, "kspec.config.yaml"), "coverage:\n  scan_paths:\n    - tests\n");

      // Initialize git repo in project root (required for kspec)
      execSync("git init", { cwd: tempDir, stdio: "ignore" });
      execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: "ignore" });
      execSync('git config user.name "Test"', { cwd: tempDir, stdio: "ignore" });

      // Set up shadow worktree simulation for kspec to detect .kspec/ as spec directory
      const gitWorktreesDir = join(tempDir, ".git", "worktrees", "-kspec");
      mkdirSync(gitWorktreesDir, { recursive: true });
      writeFileSync(join(kspecDir, ".git"), `gitdir: ${gitWorktreesDir}\n`);
      writeFileSync(join(gitWorktreesDir, "gitdir"), `${join(tempDir, ".git")}\n`);
      writeFileSync(join(gitWorktreesDir, "HEAD"), "ref: refs/heads/kspec-meta\n");

      // Verify web UI is built (daemon serves it for E2E tests)
      if (!existsSync(WEB_UI_BUILD)) {
        throw new Error(
          `Web UI not built. Run 'npm run build -w packages/web-ui' first.\n` +
            `Expected build at: ${WEB_UI_BUILD}`,
        );
      }

      let daemonProcess: ChildProcess | null = null;
      let daemonStderr = "";
      const maxAttempts = 150;
      const pollInterval = 100;

      async function waitForDaemonReady(): Promise<void> {
        for (let i = 0; i < maxAttempts; i++) {
          if (daemonProcess?.exitCode !== null) {
            throw new Error(
              `Daemon process exited with code ${daemonProcess.exitCode} before becoming ready.\n${daemonStderr}`,
            );
          }
          try {
            const response = await fetch(`${baseUrl}/api/health`);
            if (response.ok) break;
          } catch {
            // Daemon not ready yet
          }
          if (i === maxAttempts - 1) {
            throw new Error(
              `Daemon failed to become ready after ${maxAttempts * pollInterval}ms.\n${daemonStderr}`,
            );
          }
          await new Promise((r) => setTimeout(r, pollInterval));
        }

        // Wait for entity cache to finish loading (cache_status: "ready")
        for (let i = 0; i < maxAttempts; i++) {
          try {
            const response = await fetch(`${baseUrl}/api/tasks`);
            if (response.ok) {
              const body = await response.json();
              if (body?.meta?.cache_status === "ready") break;
            }
          } catch {
            // Not ready yet
          }
          if (i === maxAttempts - 1) {
            throw new Error(
              `Daemon cache failed to become ready after ${maxAttempts * pollInterval}ms.\n${daemonStderr}`,
            );
          }
          await new Promise((r) => setTimeout(r, pollInterval));
        }
      }

      async function startDaemon(): Promise<void> {
        if (daemonProcess && daemonProcess.exitCode === null) {
          return;
        }

        daemonStderr = "";
        daemonProcess = spawn(
          runtime,
          [DAEMON_ENTRY, "--runtime", runtime, "--port", String(port), "--kspec-dir", tempDir],
          {
            cwd: tempDir,
            stdio: "pipe",
            env: buildDaemonChildEnv(runtime, isolatedEnv),
          },
        );

        daemonProcess.stderr?.on("data", (chunk: Buffer) => {
          daemonStderr += chunk.toString();
        });

        await waitForDaemonReady();
      }

      async function stopDaemon(): Promise<void> {
        if (!daemonProcess || daemonProcess.exitCode !== null) {
          return;
        }

        try {
          execSync(`node ${KSPEC_CLI} serve stop`, {
            cwd: tempDir,
            stdio: "ignore",
            timeout: 10000,
            env: isolatedEnv,
          });
        } catch {
          if (daemonProcess.pid && daemonProcess.exitCode === null) {
            daemonProcess.kill("SIGTERM");
          }
        }

        if (daemonProcess.exitCode === null) {
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              if (daemonProcess?.exitCode === null) {
                daemonProcess.kill("SIGKILL");
              }
              resolve();
            }, 5000);
            daemonProcess?.once("exit", () => {
              clearTimeout(timeout);
              resolve();
            });
          });
        }

        daemonProcess = null;
      }

      await startDaemon();

      // Helper to create a valid second project for multi-project tests
      // AC: @multi-directory-daemon ac-25 - Tests need multiple valid projects
      async function createSecondProject(): Promise<string> {
        const secondProjectPath = `${tempDir}-second`;
        const secondKspecDir = join(secondProjectPath, ".kspec");

        mkdirSync(secondKspecDir, { recursive: true });

        writeFileSync(
          join(secondKspecDir, "kynetic.yaml"),
          `kynetic: "1.0"
project: Second Test Project
`,
        );

        writeFileSync(
          join(secondKspecDir, "project.tasks.yaml"),
          `# Tasks for second test project
tasks: []
`,
        );

        execSync("git init", { cwd: secondProjectPath, stdio: "ignore" });
        execSync('git config user.email "test@test.com"', {
          cwd: secondProjectPath,
          stdio: "ignore",
        });
        execSync('git config user.name "Test"', { cwd: secondProjectPath, stdio: "ignore" });

        const secondGitWorktreesDir = join(secondProjectPath, ".git", "worktrees", "-kspec");
        mkdirSync(secondGitWorktreesDir, { recursive: true });
        writeFileSync(join(secondKspecDir, ".git"), `gitdir: ${secondGitWorktreesDir}\n`);
        writeFileSync(
          join(secondGitWorktreesDir, "gitdir"),
          `${join(secondProjectPath, ".git")}\n`,
        );
        writeFileSync(join(secondGitWorktreesDir, "HEAD"), "ref: refs/heads/kspec-meta\n");

        // AC: @e2e-test-daemon-isolation ac-dynamic-port-propagation — use dynamic port via fixture baseUrl
        const response = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: secondProjectPath }),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Failed to register second project: ${error}`);
        }

        return secondProjectPath;
      }

      // AC: @e2e-test-daemon-isolation ac-dynamic-port-propagation — propagate port/URLs to all tests
      // AC: @e2e-test-daemon-isolation ac-uses-shared-fixture — daemon startup flows through this fixture
      await use({
        tempDir,
        kspecDir,
        port,
        baseUrl,
        wsUrl,
        stop: stopDaemon,
        start: startDaemon,
        createSecondProject,
      });

      // AC: @e2e-test-daemon-isolation ac-e2e-scoped-cleanup — stop daemon via scoped `kspec serve stop`
      await stopDaemon();

      // Remove temp directories
      try {
        rmSync(tempDir, { recursive: true, force: true });
        rmSync(`${tempDir}-second`, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
    },
    { scope: "test" },
  ],
});

export { expect };
