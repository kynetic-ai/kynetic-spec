/**
 * Behavioral integration tests for ralph session budget integration.
 *
 * Tests verify that the session budget lifecycle works correctly
 * when exercised in the same sequence ralph uses:
 * create session with budget → reset at iteration boundary →
 * budget enforcement via task start → cleanup on exit.
 *
 * Producer-side tests use a mock ACP agent (tests/fixtures/mock-acp-agent.mjs)
 * to verify env injection and cleanup through the real ralph code paths.
 *
 * AC: @ralph-session-budget-integration ac-create-budget, ac-reset-iteration,
 *     ac-env-inject, ac-remove-marker-code, ac-session-close-all-paths
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  createSessionWithBudget,
  resetBudget,
  getBudget,
  incrementBudget,
  getSessionBudgetPath,
} from "../../src/sessions/store.js";
import { spawnAgent } from "../../src/agents/spawner.js";
import {
  kspec,
  setupTempFixtures,
  cleanupTempDir,
  testUlid,
  CLI_PATH,
  FIXTURES_DIR,
  initGitRepo,
} from "../helpers/cli";

/** Path to the mock ACP agent script */
const MOCK_AGENT_PATH = path.join(FIXTURES_DIR, "mock-acp-agent.mjs");

// ─── Budget Creation (ac-create-budget) ─────────────────────────────────────

describe("ac-create-budget: session creation with budget", () => {
  let specDir: string;

  beforeEach(async () => {
    specDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-ralph-budget-"));
  });

  afterEach(async () => {
    await fs.rm(specDir, { recursive: true });
  });

  // AC: @ralph-session-budget-integration ac-create-budget
  it("should write budget.json with max_per_cycle=N when budget > 0", async () => {
    const sessionId = testUlid("RBUDG", 1);
    const result = await createSessionWithBudget(specDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 3,
    });

    expect(result.budget).not.toBeNull();
    expect(result.budget!.max_per_cycle).toBe(3);
    expect(result.budget!.started_this_cycle).toBe(0);

    // Verify file on disk
    const budgetPath = getSessionBudgetPath(specDir, sessionId);
    const content = await fs.readFile(budgetPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.max_per_cycle).toBe(3);
    expect(parsed.started_this_cycle).toBe(0);
  });

  // AC: @ralph-session-budget-integration ac-create-budget
  it("should NOT write budget.json when budget is 0 (unlimited)", async () => {
    const sessionId = testUlid("RBUDG", 2);
    const result = await createSessionWithBudget(specDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 0,
    });

    expect(result.budget).toBeNull();

    // budget.json should not exist
    const budgetPath = getSessionBudgetPath(specDir, sessionId);
    await expect(fs.access(budgetPath)).rejects.toThrow();
  });

  // AC: @ralph-session-budget-integration ac-create-budget
  it("should create budget with max_per_cycle matching --max-tasks value", async () => {
    for (const maxTasks of [1, 5, 10]) {
      const sessionId = testUlid("RBUDG", maxTasks + 10);
      const result = await createSessionWithBudget(specDir, {
        id: sessionId,
        agent_type: "claude-code",
        budget: maxTasks,
      });

      expect(result.budget!.max_per_cycle).toBe(maxTasks);
    }
  });
});

// ─── Budget Reset (ac-reset-iteration) ──────────────────────────────────────

describe("ac-reset-iteration: budget reset at iteration boundary", () => {
  let specDir: string;
  let sessionId: string;

  beforeEach(async () => {
    specDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-ralph-reset-"));
    sessionId = testUlid("RRESET", 1);
    await createSessionWithBudget(specDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 2,
    });
  });

  afterEach(async () => {
    await fs.rm(specDir, { recursive: true });
  });

  // AC: @ralph-session-budget-integration ac-reset-iteration
  it("should reset started_this_cycle to 0 after tasks were started", async () => {
    // Simulate agent starting tasks during an iteration
    await incrementBudget(specDir, sessionId);
    await incrementBudget(specDir, sessionId);

    let budget = await getBudget(specDir, sessionId);
    expect(budget!.started_this_cycle).toBe(2);

    // Simulate ralph calling resetBudget at iteration boundary
    await resetBudget(specDir, sessionId);

    budget = await getBudget(specDir, sessionId);
    expect(budget!.started_this_cycle).toBe(0);
    expect(budget!.max_per_cycle).toBe(2); // max unchanged
  });

  // AC: @ralph-session-budget-integration ac-reset-iteration
  it("should no-op when no budget exists (maxTasks=0)", async () => {
    const noBudgetSessionId = testUlid("RRESET", 2);
    await createSessionWithBudget(specDir, {
      id: noBudgetSessionId,
      agent_type: "claude-code",
      budget: 0,
    });

    // resetBudget should return null (no budget to reset)
    const result = await resetBudget(specDir, noBudgetSessionId);
    expect(result).toBeNull();
  });
});

// ─── Env Injection — Consumer Side (ac-env-inject) ──────────────────────────

describe("ac-env-inject: KSPEC_SESSION_ID budget enforcement via task start", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @ralph-session-budget-integration ac-env-inject
  it("should enforce budget when KSPEC_SESSION_ID is set and budget exhausted", async () => {
    // Create a session with budget in the fixtures dir (tempDir IS specDir)
    const sessionId = testUlid("RENV", 1);
    await createSessionWithBudget(tempDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 1,
    });

    // Exhaust the budget
    await incrementBudget(tempDir, sessionId);

    // Now task start should be blocked when KSPEC_SESSION_ID is set
    const result = kspec("task start @test-task-pending", tempDir, {
      expectFail: true,
      env: { KSPEC_SESSION_ID: sessionId },
    });

    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    expect(result.stderr).toContain("budget");
  });

  // AC: @ralph-session-budget-integration ac-env-inject
  it("should allow task start when KSPEC_SESSION_ID is set and budget available", async () => {
    const sessionId = testUlid("RENV", 2);
    await createSessionWithBudget(tempDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 5,
    });

    // Budget not exhausted — task start should succeed
    const result = kspec("task start @test-task-pending", tempDir, {
      env: { KSPEC_SESSION_ID: sessionId },
    });

    expect(result.exitCode).toBe(0);
  });

  // AC: @ralph-session-budget-integration ac-env-inject
  it("should not enforce budget when KSPEC_SESSION_ID is not set", async () => {
    // No session ID → no budget check → task start should succeed
    const result = kspec("task start @test-task-pending", tempDir);
    expect(result.exitCode).toBe(0);
  });
});

// ─── Env Injection — Producer Side (ac-env-inject) ──────────────────────────

describe("ac-env-inject: spawnAgent passes KSPEC_SESSION_ID to child process", () => {
  let tempDir: string;
  let envFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-ralph-spawn-"));
    envFile = path.join(tempDir, "agent-env.json");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true });
  });

  // AC: @ralph-session-budget-integration ac-env-inject
  it("should pass KSPEC_SESSION_ID to spawned agent via env", async () => {
    const sessionId = testUlid("RSPAWN", 1);

    // Spawn mock agent with the same env pattern ralph uses
    const agent = spawnAgent(
      { command: "node", args: [MOCK_AGENT_PATH], description: "mock" },
      {
        cwd: tempDir,
        env: {
          KSPEC_SESSION_ID: sessionId,
          MOCK_ACP_ENV_FILE: envFile,
        },
      },
    );

    try {
      // Initialize to prove the agent is alive and responding
      await agent.client.initialize();

      // Mock agent writes env to file on startup — verify it received the session ID
      const envData = JSON.parse(await fs.readFile(envFile, "utf-8"));
      expect(envData.KSPEC_SESSION_ID).toBe(sessionId);
    } finally {
      agent.kill();
    }
  });

  // AC: @ralph-session-budget-integration ac-env-inject
  it("should not leak KSPEC_SESSION_ID when env is not provided", async () => {
    // Ensure KSPEC_SESSION_ID is NOT in the current process env for this test
    const originalValue = process.env.KSPEC_SESSION_ID;
    delete process.env.KSPEC_SESSION_ID;

    try {
      const agent = spawnAgent(
        { command: "node", args: [MOCK_AGENT_PATH], description: "mock" },
        {
          cwd: tempDir,
          env: { MOCK_ACP_ENV_FILE: envFile },
        },
      );

      try {
        await agent.client.initialize();
        const envData = JSON.parse(await fs.readFile(envFile, "utf-8"));
        expect(envData.KSPEC_SESSION_ID).toBeNull();
      } finally {
        agent.kill();
      }
    } finally {
      // Restore original value
      if (originalValue !== undefined) {
        process.env.KSPEC_SESSION_ID = originalValue;
      }
    }
  });
});

// ─── Marker Code Removal (ac-remove-marker-code) ────────────────────────────

describe("ac-remove-marker-code: no marker file code in ralph.ts", () => {
  let ralphSource: string;

  beforeEach(async () => {
    ralphSource = await fs.readFile(
      path.resolve("src/cli/commands/ralph.ts"),
      "utf-8",
    );
  });

  // Task-limit marker artifacts
  const removedPatterns = [
    "TaskLimitMarker",
    "TASK_LIMIT_MARKER",
    "ralph-task-limit.json",
    "detectTaskCompleteCommand",
    "extractBashCommand",
    "TASK LIMIT REACHED",
    "writeTaskLimitMarker",
    "readTaskLimitMarker",
    "clearTaskLimitMarker",
    "clearStaleMarker",
    "STALE_MARKER_THRESHOLD",
    "taskLimitReached",
    "tasksCompletedThisIteration",
    // End-loop marker artifacts (removed in end-loop migration)
    "END_LOOP_MARKER_PATH",
    "ralph-end-loop.json",
    "writeEndLoopMarker",
    "readEndLoopMarker",
    "clearEndLoopMarker",
  ];

  // AC: @ralph-session-budget-integration ac-remove-marker-code
  for (const pattern of removedPatterns) {
    it(`should not contain "${pattern}"`, () => {
      expect(ralphSource).not.toContain(pattern);
    });
  }

  // AC: @ralph-session-budget-integration ac-remove-marker-code
  it("should not import getIterationStats", () => {
    expect(ralphSource).not.toMatch(/import.*getIterationStats/);
  });
});

// ─── Session Close All Paths (ac-session-close-all-paths) ───────────────────

describe("ac-session-close-all-paths: ralph cleans up budget on exit", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    // Initialize a clean git repo so getWorkingTreeStatus() returns clean.
    // This prevents the wrap-up agent from spawning (2-min timeout) and
    // causing flaky test timeouts. The .gitignore ensures session artifacts
    // created by ralph during the test don't dirty the working tree.
    initGitRepo(tempDir);
    await fs.writeFile(path.join(tempDir, ".gitignore"), "sessions/\n");
    execSync("git add -A && git commit -m 'init'", { cwd: tempDir, stdio: "pipe" });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  /**
   * Helper: spawn kspec ralph as a subprocess.
   * Watches combined output for a marker string, then resolves.
   * Ralph may not exit cleanly due to open Node handles, so we
   * kill the process after the marker is seen and cleanup has occurred.
   */
  function spawnRalphUntil(
    args: string[],
    marker: string,
    env: Record<string, string> = {},
  ): Promise<{ output: string }> {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn("node", [CLI_PATH, "ralph", ...args], {
        cwd: tempDir,
        env: {
          ...process.env,
          KSPEC_SPEC_DIR: tempDir,
          KSPEC_AUTHOR: "@test",
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let output = "";
      let resolved = false;

      const onData = (d: Buffer) => {
        output += d.toString();
        // Once we see the marker, cleanup is done — give a small grace period then kill
        if (!resolved && output.includes(marker)) {
          resolved = true;
          setTimeout(() => {
            child.kill("SIGKILL");
            resolve({ output });
          }, 500);
        }
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);

      child.on("close", () => {
        if (!resolved) {
          resolved = true;
          resolve({ output });
        }
      });

      // Safety timeout
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.kill("SIGKILL");
          reject(new Error(`Timed out waiting for marker "${marker}"\noutput: ${output}`));
        }
      }, 25_000);
    });
  }

  // AC: @ralph-session-budget-integration ac-session-close-all-paths
  it("should clean up budget.json after normal exit (max-iterations reached)", async () => {
    // Run ralph with mock agent for 1 iteration.
    // Wait for "Ralph loop completed" which appears after all cleanup.
    const result = await spawnRalphUntil(
      ["--adapter-cmd", `node ${MOCK_AGENT_PATH}`, "--max-loops", "1", "--max-tasks", "2"],
      "Ralph loop completed",
    );

    expect(result.output).toContain("Completed iteration 1");

    // Find the session directory ralph created
    const sessionsDir = path.join(tempDir, "sessions");
    const sessionDirs = await fs.readdir(sessionsDir);

    // Ralph should have created exactly one session
    expect(sessionDirs.length).toBe(1);

    // Budget.json should NOT exist after ralph cleanup
    const budgetPath = path.join(sessionsDir, sessionDirs[0], "budget.json");
    const budgetExists = await fs.access(budgetPath).then(() => true).catch(() => false);
    expect(budgetExists).toBe(false);

    // Session should be closed as completed
    const sessionPath = path.join(sessionsDir, sessionDirs[0], "session.yaml");
    const content = await fs.readFile(sessionPath, "utf-8");
    expect(content).toContain("status: completed");
  }, 30_000);

  /**
   * Helper: spawn ralph, wait for it to start, send a signal, verify cleanup.
   */
  async function testSignalCleanup(signal: "SIGINT" | "SIGTERM") {
    const child = nodeSpawn(
      "node",
      [CLI_PATH, "ralph", "--adapter-cmd", `node ${MOCK_AGENT_PATH}`, "--max-loops", "999", "--max-tasks", "2"],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          KSPEC_SPEC_DIR: tempDir,
          KSPEC_AUTHOR: "@test",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let output = "";
    const onData = (d: Buffer) => { output += d.toString(); };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);

    // Wait for ralph to create the session and start working
    await new Promise<void>((resolve) => {
      const check = () => {
        if (output.includes("Creating ACP session")) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
      setTimeout(resolve, 5_000);
    });

    // Send the signal
    child.kill(signal);

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 10_000);
    });

    // Verify budget.json was cleaned up
    const sessionsDir = path.join(tempDir, "sessions");
    const sessionDirs = await fs.readdir(sessionsDir);
    expect(sessionDirs.length).toBe(1);

    const budgetPath = path.join(sessionsDir, sessionDirs[0], "budget.json");
    const budgetExists = await fs.access(budgetPath).then(() => true).catch(() => false);
    expect(budgetExists).toBe(false);

    // Session should be closed as abandoned with signal name
    const sessionPath = path.join(sessionsDir, sessionDirs[0], "session.yaml");
    const content = await fs.readFile(sessionPath, "utf-8");
    expect(content).toContain("status: abandoned");
    expect(content).toContain(signal);
  }

  // AC: @ralph-session-budget-integration ac-session-close-all-paths
  // AC: @ralph-task-limit ac-signal-cleanup
  it("should clean up budget.json after signal (SIGINT)", async () => {
    await testSignalCleanup("SIGINT");
  }, 30_000);

  // AC: @ralph-session-budget-integration ac-session-close-all-paths
  // AC: @ralph-task-limit ac-signal-cleanup
  it("should clean up budget.json after signal (SIGTERM)", async () => {
    await testSignalCleanup("SIGTERM");
  }, 30_000);

  // AC: @ralph-session-budget-integration ac-session-close-all-paths
  it("should clean up budget.json after agent crash (error path)", async () => {
    const crashAgent = path.join(FIXTURES_DIR, "mock-acp-agent-crash.mjs");

    // Ralph with a crashing agent — retries exhaust, then finally block cleans up.
    // Wait for "Ralph loop completed" (capital R) which appears after all cleanup.
    const result = await spawnRalphUntil(
      ["--adapter-cmd", `node ${crashAgent}`, "--max-loops", "1", "--max-tasks", "2"],
      "Ralph loop completed",
    );

    // Ralph should have logged iteration failures
    expect(result.output).toContain("Iteration failed");

    // Find the session directory ralph created
    const sessionsDir = path.join(tempDir, "sessions");
    const sessionDirs = await fs.readdir(sessionsDir);
    expect(sessionDirs.length).toBe(1);

    // Budget.json should be cleaned up by finally block
    const budgetPath = path.join(sessionsDir, sessionDirs[0], "budget.json");
    const budgetExists = await fs.access(budgetPath).then(() => true).catch(() => false);
    expect(budgetExists).toBe(false);
  }, 30_000);
});
