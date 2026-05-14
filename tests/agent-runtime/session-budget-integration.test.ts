/**
 * Behavioral integration tests for session budget integration.
 *
 * Tests verify that the session budget lifecycle works correctly:
 * create session with budget → reset at iteration boundary →
 * budget enforcement via task start → cleanup on exit.
 *
 * AC: @ralph-session-budget-integration ac-create-budget, ac-reset-iteration,
 *     ac-env-inject, ac-remove-marker-code
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { kspec, setupTempFixtures, cleanupTempDir, testUlid, FIXTURES_DIR } from "../helpers/cli";

/** Path to the mock ACP agent script */
const MOCK_AGENT_PATH = path.join(FIXTURES_DIR, "mock-acp-agent.mjs");

// ─── Budget Creation (ac-create-budget) ─────────────────────────────────────

describe("ac-create-budget: session creation with budget", () => {
  let specDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    specDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-ralph-budget-"));
    sessionsDir = path.join(specDir, "sessions");
  });

  afterEach(async () => {
    await fs.rm(specDir, { recursive: true });
  });

  // AC: @ralph-session-budget-integration ac-create-budget
  it("should write budget.json with max_per_cycle=N when budget > 0", async () => {
    const sessionId = testUlid("RBUDG", 1);
    const result = await createSessionWithBudget(sessionsDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 3,
    });

    expect(result.budget).not.toBeNull();
    expect(result.budget!.max_per_cycle).toBe(3);
    expect(result.budget!.started_this_cycle).toBe(0);

    // Verify file on disk
    const budgetPath = getSessionBudgetPath(sessionsDir, sessionId);
    const content = await fs.readFile(budgetPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.max_per_cycle).toBe(3);
    expect(parsed.started_this_cycle).toBe(0);
  });

  // AC: @ralph-session-budget-integration ac-create-budget
  it("should NOT write budget.json when budget is 0 (unlimited)", async () => {
    const sessionId = testUlid("RBUDG", 2);
    const result = await createSessionWithBudget(sessionsDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 0,
    });

    expect(result.budget).toBeNull();

    // budget.json should not exist
    const budgetPath = getSessionBudgetPath(sessionsDir, sessionId);
    await expect(fs.access(budgetPath)).rejects.toThrow();
  });

  // AC: @ralph-session-budget-integration ac-create-budget
  it("should create budget with max_per_cycle matching --max-tasks value", async () => {
    for (const maxTasks of [1, 5, 10]) {
      const sessionId = testUlid("RBUDG", maxTasks + 10);
      const result = await createSessionWithBudget(sessionsDir, {
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
  let sessionsDir: string;
  let sessionId: string;

  beforeEach(async () => {
    specDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-ralph-reset-"));
    sessionsDir = path.join(specDir, "sessions");
    sessionId = testUlid("RRESET", 1);
    await createSessionWithBudget(sessionsDir, {
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
    await incrementBudget(sessionsDir, sessionId);
    await incrementBudget(sessionsDir, sessionId);

    let budget = await getBudget(sessionsDir, sessionId);
    expect(budget!.started_this_cycle).toBe(2);

    // Simulate calling resetBudget at iteration boundary
    await resetBudget(sessionsDir, sessionId);

    budget = await getBudget(sessionsDir, sessionId);
    expect(budget!.started_this_cycle).toBe(0);
    expect(budget!.max_per_cycle).toBe(2); // max unchanged
  });

  // AC: @ralph-session-budget-integration ac-reset-iteration
  it("should no-op when no budget exists (maxTasks=0)", async () => {
    const noBudgetSessionId = testUlid("RRESET", 2);
    await createSessionWithBudget(sessionsDir, {
      id: noBudgetSessionId,
      agent_type: "claude-code",
      budget: 0,
    });

    // resetBudget should return null (no budget to reset)
    const result = await resetBudget(sessionsDir, noBudgetSessionId);
    expect(result).toBeNull();
  });
});

// ─── Env Injection — Consumer Side (ac-env-inject) ──────────────────────────

describe("ac-env-inject: KSPEC_SESSION_ID budget enforcement via task start", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    sessionsDir = path.join(tempDir, ".kspec-sessions");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @ralph-session-budget-integration ac-env-inject
  it("should enforce budget when KSPEC_SESSION_ID is set and budget exhausted", async () => {
    // Create a session with budget in the fixtures dir (tempDir IS specDir)
    const sessionId = testUlid("RENV", 1);
    await createSessionWithBudget(sessionsDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 1,
    });

    // Exhaust the budget
    await incrementBudget(sessionsDir, sessionId);

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
    await createSessionWithBudget(sessionsDir, {
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

    // Spawn mock agent with the same env pattern the agent runtime uses
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
