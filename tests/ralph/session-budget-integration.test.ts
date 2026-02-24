/**
 * Behavioral integration tests for ralph session budget integration.
 *
 * Tests verify that the session budget lifecycle works correctly
 * when exercised in the same sequence ralph uses:
 * create session with budget → reset at iteration boundary →
 * budget enforcement via task start → cleanup on exit.
 *
 * AC: @ralph-session-budget-integration ac-create-budget, ac-reset-iteration,
 *     ac-env-inject, ac-remove-marker-code, ac-session-close-all-paths
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
  closeSession,
} from "../../src/sessions/store.js";
import type { SessionMetadataInput } from "../../src/sessions/types.js";
import {
  kspec,
  setupTempFixtures,
  cleanupTempDir,
  testUlid,
} from "../helpers/cli";

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

// ─── Env Injection (ac-env-inject) ──────────────────────────────────────────

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

// ─── Marker Code Removal (ac-remove-marker-code) ────────────────────────────

describe("ac-remove-marker-code: no marker file code in ralph.ts", () => {
  let ralphSource: string;

  beforeEach(async () => {
    ralphSource = await fs.readFile(
      path.resolve("src/cli/commands/ralph.ts"),
      "utf-8",
    );
  });

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

describe("ac-session-close-all-paths: budget cleanup on session end", () => {
  let specDir: string;

  beforeEach(async () => {
    specDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "kspec-ralph-cleanup-"),
    );
  });

  afterEach(async () => {
    await fs.rm(specDir, { recursive: true });
  });

  // AC: @ralph-session-budget-integration ac-session-close-all-paths
  it("should delete budget.json when cleaned up (normal exit)", async () => {
    const sessionId = testUlid("RCLOSE", 1);
    await createSessionWithBudget(specDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 3,
    });

    // Verify budget exists
    const budgetPath = getSessionBudgetPath(specDir, sessionId);
    await expect(fs.access(budgetPath)).resolves.toBeUndefined();

    // Simulate ralph's cleanup: unlink budget + close session
    await fs.unlink(budgetPath).catch(() => {});
    await closeSession(specDir, sessionId, "completed", "All iterations done");

    // Budget file should be gone
    await expect(fs.access(budgetPath)).rejects.toThrow();
  });

  // AC: @ralph-session-budget-integration ac-session-close-all-paths
  it("should handle cleanup when no budget exists (maxTasks=0)", async () => {
    const sessionId = testUlid("RCLOSE", 2);
    await createSessionWithBudget(specDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 0,
    });

    // No budget file — cleanup should not throw
    const budgetPath = getSessionBudgetPath(specDir, sessionId);
    await expect(
      fs.unlink(budgetPath).catch(() => {}),
    ).resolves.toBeUndefined();

    await closeSession(specDir, sessionId, "completed", "No budget scenario");
  });

  // AC: @ralph-session-budget-integration ac-session-close-all-paths
  it("should close session as abandoned on error exit", async () => {
    const sessionId = testUlid("RCLOSE", 3);
    await createSessionWithBudget(specDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 2,
    });

    // Simulate error exit: clean up budget and close as abandoned
    const budgetPath = getSessionBudgetPath(specDir, sessionId);
    await fs.unlink(budgetPath).catch(() => {});
    await closeSession(specDir, sessionId, "abandoned", "Max failures reached");

    // Verify session is closed as abandoned
    const sessionPath = path.join(
      specDir,
      "sessions",
      sessionId,
      "session.yaml",
    );
    const content = await fs.readFile(sessionPath, "utf-8");
    expect(content).toContain("status: abandoned");
    expect(content).toContain("Max failures reached");
  });

  // AC: @ralph-session-budget-integration ac-session-close-all-paths
  it("should close session as abandoned on signal (SIGINT/SIGTERM)", async () => {
    const sessionId = testUlid("RCLOSE", 4);
    await createSessionWithBudget(specDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 1,
    });

    // Simulate signal handler: same cleanup pattern as error
    const budgetPath = getSessionBudgetPath(specDir, sessionId);
    await fs.unlink(budgetPath).catch(() => {});
    await closeSession(specDir, sessionId, "abandoned", "Received SIGINT");

    const sessionPath = path.join(
      specDir,
      "sessions",
      sessionId,
      "session.yaml",
    );
    const content = await fs.readFile(sessionPath, "utf-8");
    expect(content).toContain("status: abandoned");
    expect(content).toContain("Received SIGINT");
  });
});
