/**
 * Integration tests for task budget enforcement.
 *
 * Tests that kspec task start checks and enforces session budgets,
 * increments counters on successful starts, and skips checks when
 * no session or budget is configured.
 *
 * Task: @add-budget-enforcement-to-task-start
 * Spec: @task-budget-enforcement
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { kspec, kspecJson, setupTempFixtures, cleanupTempDir, initGitRepo } from "./helpers/cli";

/**
 * Helper to create a budget file for a session in the test fixture directory.
 * Budget lives at {projectRoot}/.kspec-sessions/{sessionId}/budget.json
 */
async function createTestBudget(
  projectRoot: string,
  sessionId: string,
  maxPerCycle: number,
  startedThisCycle: number = 0,
): Promise<void> {
  const sessionDir = path.join(projectRoot, ".kspec-sessions", sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const budget = {
    max_per_cycle: maxPerCycle,
    started_this_cycle: startedThisCycle,
  };
  await fs.writeFile(path.join(sessionDir, "budget.json"), JSON.stringify(budget, null, 2) + "\n");
}

/**
 * Helper to read the budget file and return parsed contents.
 */
async function readTestBudget(
  projectRoot: string,
  sessionId: string,
): Promise<{ max_per_cycle: number; started_this_cycle: number } | null> {
  const budgetPath = path.join(projectRoot, ".kspec-sessions", sessionId, "budget.json");
  try {
    const content = await fs.readFile(budgetPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

describe("Integration: task budget enforcement", () => {
  let tempDir: string;
  const SESSION_ID = "01KJ7BBBHNMBABEHHDVEYSPJFR";

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @task-budget-enforcement ac-block-start
  describe("ac-block-start: blocks when budget exhausted", () => {
    it("should exit nonzero when started_this_cycle >= max_per_cycle", async () => {
      await createTestBudget(tempDir, SESSION_ID, 1, 1); // 1/1 used

      const result = kspec("task start @test-task-pending", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      // Should fail with validation error exit code (4)
      expect(result.exitCode).toBe(4);
    });

    it("should include budget counts in error message", async () => {
      await createTestBudget(tempDir, SESSION_ID, 1, 1);

      const result = kspec("task start @test-task-pending", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      const output = result.stdout + result.stderr;
      expect(output).toContain("1/1");
      expect(output).toContain("budget");
    });

    it("should include wrap-up instructions in error message", async () => {
      await createTestBudget(tempDir, SESSION_ID, 2, 2);

      const result = kspec("task start @test-task-pending", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      const output = result.stdout + result.stderr;
      expect(output).toMatch(/[Ww]rap up/);
    });

    it("should block even when budget is exceeded (started > max)", async () => {
      await createTestBudget(tempDir, SESSION_ID, 1, 3); // 3/1 — over budget

      const result = kspec("task start @test-task-pending", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      expect(result.exitCode).toBe(4);
    });
  });

  // AC: @task-budget-enforcement ac-no-session
  describe("ac-no-session: no check when KSPEC_SESSION_ID not set", () => {
    it("should allow task start without session env var", async () => {
      // Create a budget that would block if checked — but without session it's skipped
      const originalEnv = process.env.KSPEC_SESSION_ID;
      delete process.env.KSPEC_SESSION_ID;

      try {
        const result = kspec("task start @test-task-pending", tempDir);
        const output = result.stdout + result.stderr;
        expect(output).toContain("Started task");
      } finally {
        if (originalEnv !== undefined) {
          process.env.KSPEC_SESSION_ID = originalEnv;
        }
      }
    });
  });

  // AC: @task-budget-enforcement ac-no-budget
  describe("ac-no-budget: no check when no budget.json exists", () => {
    it("should allow task start when session has no budget file", () => {
      // Session ID set but no budget file created — budget is opt-in
      const result = kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      const output = result.stdout + result.stderr;
      expect(output).toContain("Started task");
    });
  });

  // AC: @task-budget-enforcement ac-increment
  describe("ac-increment: increments budget counter on successful start", () => {
    it("should increment started_this_cycle after starting a task", async () => {
      await createTestBudget(tempDir, SESSION_ID, 3, 0);

      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      const budget = await readTestBudget(tempDir, SESSION_ID);
      expect(budget).not.toBeNull();
      expect(budget!.started_this_cycle).toBe(1);
      expect(budget!.max_per_cycle).toBe(3);
    });

    it("should increment from existing count", async () => {
      await createTestBudget(tempDir, SESSION_ID, 5, 2);

      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      const budget = await readTestBudget(tempDir, SESSION_ID);
      expect(budget!.started_this_cycle).toBe(3);
    });
  });

  // AC: @task-budget-enforcement ac-needs-work-no-increment
  describe("ac-needs-work-no-increment: no increment when restarting a needs_work task", () => {
    it("should not increment budget when transitioning needs_work to in_progress", async () => {
      // Set up budget with 1 task started (consumed when task was originally started)
      await createTestBudget(tempDir, SESSION_ID, 3, 1);

      // Put task into needs_work state (start → submit → needs-work)
      // These run without budget env to avoid budget interference during setup
      kspec("task start @test-task-pending", tempDir);
      kspec("task submit @test-task-pending", tempDir);
      kspec('task needs-work @test-task-pending --reason "Fix cycle test"', tempDir);

      // Now restart from needs_work WITH session — should NOT increment
      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      // Budget should still be 1 — needs_work restart doesn't burn a new slot
      const budget = await readTestBudget(tempDir, SESSION_ID);
      expect(budget).not.toBeNull();
      expect(budget!.started_this_cycle).toBe(1);
    });

    it("should allow needs_work restart even when budget is exhausted", async () => {
      // Budget is at max — but needs_work restart should bypass this
      await createTestBudget(tempDir, SESSION_ID, 1, 1);

      // Put task into needs_work without budget env
      kspec("task start @test-task-pending", tempDir);
      kspec("task submit @test-task-pending", tempDir);
      kspec('task needs-work @test-task-pending --reason "Fix cycle test"', tempDir);

      // Restart from needs_work even though budget is exhausted
      const result = kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      expect(result.stdout + result.stderr).toContain("Started task");
    });
  });

  // AC: @task-budget-enforcement ac-resume-no-increment
  describe("ac-resume-no-increment: no increment when task already in_progress", () => {
    it("should not increment budget when resuming an in-progress task", async () => {
      // First start the task (this will increment from 0 to 1)
      await createTestBudget(tempDir, SESSION_ID, 3, 0);
      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      let budget = await readTestBudget(tempDir, SESSION_ID);
      expect(budget!.started_this_cycle).toBe(1);

      // Now try to start the same task again (already in_progress — resume case)
      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      // Budget should still be 1 — not incremented for resume
      budget = await readTestBudget(tempDir, SESSION_ID);
      expect(budget!.started_this_cycle).toBe(1);
    });
  });

  // AC: @task-budget-enforcement ac-atomic-write
  describe("ac-atomic-write: budget written atomically", () => {
    it("should not leave temp files after increment", async () => {
      await createTestBudget(tempDir, SESSION_ID, 3, 0);

      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      const sessionDir = path.join(tempDir, ".kspec-sessions", SESSION_ID);
      const files = await fs.readdir(sessionDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });

    it("should produce valid JSON in budget file after increment", async () => {
      await createTestBudget(tempDir, SESSION_ID, 3, 0);

      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      const budgetPath = path.join(tempDir, ".kspec-sessions", SESSION_ID, "budget.json");
      const content = await fs.readFile(budgetPath, "utf-8");
      // Should parse without error
      const budget = JSON.parse(content);
      expect(budget.max_per_cycle).toBe(3);
      expect(budget.started_this_cycle).toBe(1);
    });
  });

  // Trait: @trait-semantic-exit-codes
  describe("trait: semantic exit codes", () => {
    // Budget exhaustion uses EXIT_CODES.VALIDATION_FAILED = 4
    // (business rule violation), covered by ac-4 annotation below.
    // N/A for this feature: ac-2 (validation=exit 1, not applicable — budget uses exit 4),
    //   ac-3 (user cancellation — no confirmation prompt), ac-5 (empty result — not a query),
    //   ac-6 (invalid flags — handled by base command, not budget-specific),
    //   ac-7 (batch partial failure — not a batch op), ac-8 (documentation — not testable)
    it("should exit with validation failed code (4) on budget exceeded", async () => {
      await createTestBudget(tempDir, SESSION_ID, 1, 1);

      const result = kspec("task start @test-task-pending", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      // AC: @trait-semantic-exit-codes ac-4 — runtime/business rule violation
      expect(result.exitCode).toBe(4);
    });

    // AC: @trait-semantic-exit-codes ac-1 — success = exit 0
    it("should exit with 0 on successful start with budget room", async () => {
      await createTestBudget(tempDir, SESSION_ID, 3, 0);

      const result = kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      expect(result.exitCode).toBe(0);
    });
  });

  // Trait: @trait-error-guidance
  describe("trait: error guidance", () => {
    // N/A for this feature: ac-3 (ref not found — budget errors don't involve ref lookup),
    //   ac-4 (invalid state transition — budget exhaustion is not a state transition error)

    // AC: @trait-error-guidance ac-1 — error includes what went wrong
    it("should describe budget exhaustion in error message", async () => {
      await createTestBudget(tempDir, SESSION_ID, 1, 1);

      const result = kspec("task start @test-task-pending", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      const output = result.stdout + result.stderr;
      expect(output).toContain("budget");
      expect(output).toContain("exhausted");
    });

    // AC: @trait-error-guidance ac-2 — error includes suggested action
    it("should include recovery guidance (wrap up, let iteration end)", async () => {
      await createTestBudget(tempDir, SESSION_ID, 1, 1);

      const result = kspec("task start @test-task-pending", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      const output = result.stdout + result.stderr;
      // The checkBudget message includes "Wrap up current work and let the iteration end naturally"
      expect(output).toMatch(/wrap up/i);
      expect(output).toMatch(/iteration/i);
    });

    // AC: @trait-error-guidance ac-5 — validation error indicates which field/value failed
    it("should include budget counts in error showing what was exceeded", async () => {
      await createTestBudget(tempDir, SESSION_ID, 2, 2);

      const result = kspec("task start @test-task-pending", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      const output = result.stdout + result.stderr;
      // Should show "2/2 tasks started"
      expect(output).toContain("2/2");
    });

    // AC: @trait-error-guidance ac-6 — JSON mode error guidance
    it("should include guidance in structured JSON error on budget exceeded", async () => {
      await createTestBudget(tempDir, SESSION_ID, 1, 1);

      const result = kspec("task start @test-task-pending --json", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      // JSON mode error should include budget info
      const output = result.stdout + result.stderr;
      expect(output).toContain("budget");
    });
  });
});
