import { test as base, expect } from "@playwright/test";
import { execSync } from "child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";

import {
  allocateTestDaemonPort,
  createTestDaemonProject,
  isDaemonRuntimeAvailable,
  type DaemonTestRuntime,
  type StartedTestDaemon,
} from "../../helpers/daemon.js";
import { startPlaywrightFixtureDaemon } from "./daemon-fixture.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  /** Ephemeral port the test daemon is listening on (from the shared fixture endpoint) */
  port: number;
  /** Base URL for HTTP requests (resolved from the shared daemon fixture endpoint) */
  baseUrl: string;
  /** Base URL for WebSocket connections (resolved from the shared daemon fixture endpoint) */
  wsUrl: string;
  /** Stop the isolated daemon while keeping fixture data intact */
  stop: () => Promise<void>;
  /** Start or restart the isolated daemon on the same port */
  start: () => Promise<void>;
  /** Create a valid second project for multi-project tests */
  createSecondProject: () => Promise<string>;
}

// AC: @daemon-test-runtime-selection ac-node-default — KSPEC_TEST_RUNTIME defaults to "node"
function resolveTestRuntime(env: NodeJS.ProcessEnv = process.env): DaemonTestRuntime {
  const runtime = env.KSPEC_TEST_RUNTIME ?? "node";
  if (runtime === "bun" || runtime === "node") {
    return runtime;
  }
  throw new Error(`Invalid KSPEC_TEST_RUNTIME "${runtime}". Expected "bun" or "node".`);
}

function getRuntimeInstallHint(runtime: DaemonTestRuntime): string {
  if (runtime === "node") {
    return "https://nodejs.org/en/download";
  }
  return process.platform === "win32"
    ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
    : "curl -fsSL https://bun.sh/install | bash";
}

export const test = base.extend<{ daemon: DaemonFixture }>({
  // AC: @e2e-test-daemon-isolation ac-browser-endpoint-from-fixture
  // AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
  baseURL: async ({ daemon }, use) => {
    await use(daemon.baseUrl);
  },

  daemon: [
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const runtime = resolveTestRuntime();

      if (!(await isDaemonRuntimeAvailable(runtime))) {
        const runtimeName = runtime === "bun" ? "Bun" : "Node";
        throw new Error(
          `${runtimeName} runtime required for E2E daemon tests. Install: ${getRuntimeInstallHint(runtime)}`,
        );
      }

      // Verify web UI is built (daemon serves it for E2E tests)
      if (!existsSync(WEB_UI_BUILD)) {
        throw new Error(
          `Web UI not built. Run 'npm run build -w packages/web-ui' first.\n` +
            `Expected build at: ${WEB_UI_BUILD}`,
        );
      }

      // AC: @e2e-test-daemon-isolation ac-uses-shared-fixture
      // AC: @e2e-test-daemon-isolation ac-isolated-e2e-state
      // AC: @daemon-backed-test-fixture-contract ac-real-daemon-tests-use-shared-fixture
      // AC: @daemon-backed-test-fixture-contract ac-isolated-home-config
      // AC: @daemon-backed-test-fixture-contract ac-isolated-project-data
      const project = await createTestDaemonProject({
        fixturesSource: E2E_FIXTURES,
        webUiDir: WEB_UI_BUILD,
      });

      // Copy project-level tests directory for AC coverage scanning. The
      // shared fixture only copies into .kspec/, so the e2e-only tests/
      // tree (used by the @test-feature ac-1 coverage path) has to be
      // staged here in the wrapper.
      const projectTests = join(E2E_FIXTURES, "project-tests");
      if (existsSync(projectTests)) {
        cpSync(projectTests, join(project.tempDir, "tests"), { recursive: true });
      }

      // Configure coverage scanning for the copied project-tests directory.
      // Coverage scanning is explicit opt-in (AC: @coverage-scan-config ac-explicit-opt-in)
      // and the e2e items spec relies on AC coverage being detected for @test-feature ac-1.
      writeFileSync(
        join(project.tempDir, "kspec.config.yaml"),
        "coverage:\n  scan_paths:\n    - tests\n",
      );

      // AC: @e2e-test-daemon-isolation ac-dynamic-port-propagation
      // AC: @daemon-test-endpoint-consistency ac-dynamic-port-propagation
      // Pre-allocate the dynamic port so daemon.stop() / daemon.start()
      // restart cycles re-bind to the same endpoint that the browser
      // already loaded — losing the port across a restart would force
      // every test that exercises reconnection behavior to reload.
      const port = await allocateTestDaemonPort();
      let started: StartedTestDaemon | null = null;
      // Stop hook captured via the shared fixture's `registerCleanup`
      // callback. Used by stopDaemon() so the wrapper drives teardown
      // through the cleanup it registered before the readiness wait
      // could fail, rather than reaching for `started.stop` directly.
      let earlyStop: (() => Promise<void>) | null = null;

      async function startDaemon(): Promise<void> {
        if (started && started.child.exitCode === null && started.child.signalCode === null) {
          return;
        }
        // AC: @e2e-test-daemon-isolation ac-uses-shared-fixture
        // AC: @daemon-backed-test-fixture-contract ac-real-daemon-tests-use-shared-fixture
        // AC: @daemon-backed-test-fixture-contract ac-bounded-readiness
        // AC: @daemon-backed-test-fixture-contract ac-readiness-diagnostics
        // AC: @daemon-test-endpoint-consistency ac-no-localhost-by-default
        // AC: @daemon-test-runtime-selection ac-node-default
        // AC: @daemon-test-startup-failure-hygiene ac-cleanup-registered-before-readiness-wait
        const result = await startPlaywrightFixtureDaemon({
          project,
          runtime,
          port,
        });
        started = result.started;
        // Capture the stop hook the shared core registered for us. If a
        // future regression dropped the registration, fall back to the
        // canonical stop returned by the helper so the wrapper still has
        // a stop function — the AC behavior is then enforced separately
        // at the unit level (tests/e2e-fixture-daemon-cleanup.test.ts).
        earlyStop = result.earlyStop ?? result.started.stop;
      }

      async function stopDaemon(): Promise<void> {
        if (!earlyStop) return;
        // AC: @e2e-test-daemon-isolation ac-e2e-scoped-cleanup
        // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
        // AC: @daemon-backed-test-fixture-contract ac-no-ambient-daemon-control
        // AC: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure
        // The captured stop is idempotent (see startTestDaemon's `stopped`
        // guard) so calling it again from the finally block below after
        // the test invoked daemon.stop() is safe.
        await earlyStop();
      }

      // Helper to create a valid second project for multi-project tests
      // AC: @multi-directory-daemon ac-25 - Tests need multiple valid projects
      async function createSecondProject(): Promise<string> {
        if (!started) {
          throw new Error("createSecondProject called before daemon was started");
        }
        const secondProjectPath = `${project.tempDir}-second`;
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

        // AC: @e2e-test-daemon-isolation ac-browser-endpoint-from-fixture
        // AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
        const response = await fetch(`${started.apiUrl}/api/projects`, {
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

      // The setup/use/teardown sequence runs inside a try/finally so the
      // wrapper always tears down the fixture-owned daemon and the temp
      // project tree, even when startDaemon() rejects (for example if the
      // shared real-daemon fixture's readiness wait fails). The captured
      // stop hook is registered before that wait can fail, so the finally
      // block always has a stop available when one is needed.
      try {
        await startDaemon();

        // AC: @e2e-test-daemon-isolation ac-dynamic-port-propagation
        // AC: @e2e-test-daemon-isolation ac-browser-endpoint-from-fixture
        // AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
        // The shared fixture's wsUrl includes the /ws path suffix
        // (ws://host:port/ws). Existing E2E tests treat fixture.wsUrl as a base
        // URL and append "/ws" themselves (api-watcher, api-triage), so strip
        // the suffix here to preserve that contract.
        const wsBaseUrl = started!.wsUrl.replace(/\/ws$/, "");
        await use({
          tempDir: project.tempDir,
          kspecDir: project.kspecDir,
          port: started!.port,
          baseUrl: started!.apiUrl,
          wsUrl: wsBaseUrl,
          stop: stopDaemon,
          start: startDaemon,
          createSecondProject,
        });
      } finally {
        // AC: @e2e-test-daemon-isolation ac-e2e-scoped-cleanup
        // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
        // AC: @daemon-test-startup-failure-hygiene ac-owned-child-stopped-after-startup-failure
        await stopDaemon();
        try {
          rmSync(`${project.tempDir}-second`, { recursive: true, force: true });
        } catch {
          // Best effort: second project is only created by tests that opt in.
        }
        await project.cleanup();
      }
    },
    { scope: "test" },
  ],
});

export { expect };
