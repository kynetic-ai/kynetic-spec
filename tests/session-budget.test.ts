/**
 * Session task budget tests.
 *
 * Tests for budget schema validation and CRUD operations
 * (create, read, check, increment, reset).
 *
 * Task: @extend-session-schema-with-task-budget
 * Spec: @session-creation-and-env-injection
 * Spec: @task-budget-enforcement
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { TaskBudgetSchema } from "../src/sessions/types.js";
import {
  createBudget,
  getBudget,
  checkBudget,
  incrementBudget,
  resetBudget,
  getSessionBudgetPath,
  createSession,
} from "../src/sessions/store.js";
import type { SessionMetadataInput } from "../src/sessions/types.js";

// ─── Schema Tests ────────────────────────────────────────────────────────────

describe("TaskBudgetSchema", () => {
  // AC: @session-creation-and-env-injection ac-budget
  it("should accept valid budget with positive max and zero started", () => {
    const result = TaskBudgetSchema.safeParse({
      max_per_cycle: 3,
      started_this_cycle: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_per_cycle).toBe(3);
      expect(result.data.started_this_cycle).toBe(0);
    }
  });

  it("should accept budget with started equal to max", () => {
    const result = TaskBudgetSchema.safeParse({
      max_per_cycle: 2,
      started_this_cycle: 2,
    });
    expect(result.success).toBe(true);
  });

  it("should accept budget with started exceeding max (counter, not constraint)", () => {
    const result = TaskBudgetSchema.safeParse({
      max_per_cycle: 1,
      started_this_cycle: 5,
    });
    expect(result.success).toBe(true);
  });

  it("should reject zero max_per_cycle", () => {
    const result = TaskBudgetSchema.safeParse({
      max_per_cycle: 0,
      started_this_cycle: 0,
    });
    expect(result.success).toBe(false);
  });

  it("should reject negative max_per_cycle", () => {
    const result = TaskBudgetSchema.safeParse({
      max_per_cycle: -1,
      started_this_cycle: 0,
    });
    expect(result.success).toBe(false);
  });

  it("should reject negative started_this_cycle", () => {
    const result = TaskBudgetSchema.safeParse({
      max_per_cycle: 3,
      started_this_cycle: -1,
    });
    expect(result.success).toBe(false);
  });

  it("should reject non-integer max_per_cycle", () => {
    const result = TaskBudgetSchema.safeParse({
      max_per_cycle: 1.5,
      started_this_cycle: 0,
    });
    expect(result.success).toBe(false);
  });

  it("should reject non-integer started_this_cycle", () => {
    const result = TaskBudgetSchema.safeParse({
      max_per_cycle: 1,
      started_this_cycle: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("should reject missing fields", () => {
    expect(TaskBudgetSchema.safeParse({}).success).toBe(false);
    expect(
      TaskBudgetSchema.safeParse({ max_per_cycle: 1 }).success,
    ).toBe(false);
    expect(
      TaskBudgetSchema.safeParse({ started_this_cycle: 0 }).success,
    ).toBe(false);
  });
});

// ─── Path Helper Tests ──────────────────────────────────────────────────────

describe("getSessionBudgetPath", () => {
  // AC: @session-creation-and-env-injection ac-budget-local
  it("should return path inside session directory", () => {
    const specDir = "/test/.kspec";
    const sessionId = "01KF123456789ABCDEFGHJKMNP";
    expect(getSessionBudgetPath(specDir, sessionId)).toBe(
      `/test/.kspec/sessions/${sessionId}/budget.json`,
    );
  });
});

// ─── Budget CRUD Tests ──────────────────────────────────────────────────────

describe("Budget CRUD", () => {
  let testDir: string;
  const sessionId = "01KF123456789ABCDEFGHJKMNP";

  beforeEach(async () => {
    testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "kspec-budget-test-"),
    );
    // Create a session directory so budget operations have a home
    const input: SessionMetadataInput = {
      id: sessionId,
      agent_type: "claude-code",
    };
    await createSession(testDir, input);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  describe("createBudget", () => {
    // AC: @session-creation-and-env-injection ac-budget
    it("should create budget.json with max_per_cycle and started_this_cycle=0", async () => {
      const budget = await createBudget(testDir, sessionId, 3);

      expect(budget.max_per_cycle).toBe(3);
      expect(budget.started_this_cycle).toBe(0);

      // Verify file on disk
      const budgetPath = getSessionBudgetPath(testDir, sessionId);
      const content = await fs.readFile(budgetPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.max_per_cycle).toBe(3);
      expect(parsed.started_this_cycle).toBe(0);
    });

    // AC: @session-creation-and-env-injection ac-budget-local
    it("should store budget in local filesystem under sessions dir", async () => {
      await createBudget(testDir, sessionId, 2);

      const budgetPath = getSessionBudgetPath(testDir, sessionId);
      expect(budgetPath).toContain("sessions");
      expect(budgetPath).toContain(sessionId);
      expect(budgetPath).toContain("budget.json");

      // File should exist
      const stat = await fs.stat(budgetPath);
      expect(stat.isFile()).toBe(true);
    });

    it("should reject invalid max_per_cycle", async () => {
      await expect(createBudget(testDir, sessionId, 0)).rejects.toThrow();
      await expect(createBudget(testDir, sessionId, -1)).rejects.toThrow();
    });
  });

  describe("getBudget", () => {
    // AC: @task-budget-enforcement ac-no-budget
    it("should return null when no budget configured", async () => {
      const budget = await getBudget(testDir, sessionId);
      expect(budget).toBeNull();
    });

    it("should return budget after creation", async () => {
      await createBudget(testDir, sessionId, 5);
      const budget = await getBudget(testDir, sessionId);

      expect(budget).not.toBeNull();
      expect(budget!.max_per_cycle).toBe(5);
      expect(budget!.started_this_cycle).toBe(0);
    });

    it("should return null for nonexistent session", async () => {
      const budget = await getBudget(testDir, "NONEXISTENT");
      expect(budget).toBeNull();
    });

    it("should return null for corrupt budget.json (intentional: treated as no budget)", async () => {
      // Write invalid JSON to budget.json
      const budgetPath = getSessionBudgetPath(testDir, sessionId);
      await fs.writeFile(budgetPath, "not valid json{{{", "utf-8");

      const budget = await getBudget(testDir, sessionId);
      expect(budget).toBeNull();
    });

    it("should return null for budget.json with invalid schema", async () => {
      // Write valid JSON but wrong schema
      const budgetPath = getSessionBudgetPath(testDir, sessionId);
      await fs.writeFile(budgetPath, JSON.stringify({ wrong: "shape" }), "utf-8");

      const budget = await getBudget(testDir, sessionId);
      expect(budget).toBeNull();
    });
  });

  describe("checkBudget", () => {
    // AC: @task-budget-enforcement ac-no-session
    it("should allow when no session ID provided", async () => {
      const result = await checkBudget(testDir, undefined);
      expect(result.allowed).toBe(true);
      expect(result.budget).toBeUndefined();
    });

    // AC: @task-budget-enforcement ac-no-budget
    it("should allow when session has no budget configured", async () => {
      const result = await checkBudget(testDir, sessionId);
      expect(result.allowed).toBe(true);
      expect(result.budget).toBeUndefined();
    });

    it("should allow when under budget", async () => {
      await createBudget(testDir, sessionId, 3);
      const result = await checkBudget(testDir, sessionId);

      expect(result.allowed).toBe(true);
      expect(result.budget).toBeDefined();
      expect(result.budget!.started_this_cycle).toBe(0);
    });

    // AC: @task-budget-enforcement ac-block-start
    it("should block when budget exhausted", async () => {
      await createBudget(testDir, sessionId, 1);
      await incrementBudget(testDir, sessionId);

      const result = await checkBudget(testDir, sessionId);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("1/1");
      expect(result.reason).toContain("budget exhausted");
      expect(result.budget).toBeDefined();
      expect(result.budget!.started_this_cycle).toBe(1);
    });

    // AC: @task-budget-enforcement ac-block-start
    it("should include budget counts in rejection message", async () => {
      await createBudget(testDir, sessionId, 2);
      await incrementBudget(testDir, sessionId);
      await incrementBudget(testDir, sessionId);

      const result = await checkBudget(testDir, sessionId);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("2/2");
      expect(result.reason).toContain("Wrap up");
    });
  });

  describe("incrementBudget", () => {
    // AC: @task-budget-enforcement ac-increment
    it("should increment started_this_cycle by 1", async () => {
      await createBudget(testDir, sessionId, 5);

      const updated = await incrementBudget(testDir, sessionId);
      expect(updated).not.toBeNull();
      expect(updated!.started_this_cycle).toBe(1);
      expect(updated!.max_per_cycle).toBe(5);

      // Verify persisted
      const read = await getBudget(testDir, sessionId);
      expect(read!.started_this_cycle).toBe(1);
    });

    it("should increment multiple times", async () => {
      await createBudget(testDir, sessionId, 5);

      await incrementBudget(testDir, sessionId);
      await incrementBudget(testDir, sessionId);
      const updated = await incrementBudget(testDir, sessionId);

      expect(updated!.started_this_cycle).toBe(3);
    });

    it("should return null when no budget configured", async () => {
      const result = await incrementBudget(testDir, sessionId);
      expect(result).toBeNull();
    });

    // AC: @task-budget-enforcement ac-atomic-write
    it("should write atomically (no temp files left behind)", async () => {
      await createBudget(testDir, sessionId, 3);
      await incrementBudget(testDir, sessionId);

      // Check that no .tmp files remain in session dir
      const sessionDir = path.join(testDir, "sessions", sessionId);
      const files = await fs.readdir(sessionDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe("resetBudget", () => {
    // AC: @task-budget-enforcement ac-reset
    it("should reset started_this_cycle to 0", async () => {
      await createBudget(testDir, sessionId, 3);
      await incrementBudget(testDir, sessionId);
      await incrementBudget(testDir, sessionId);

      const reset = await resetBudget(testDir, sessionId);
      expect(reset).not.toBeNull();
      expect(reset!.started_this_cycle).toBe(0);
      expect(reset!.max_per_cycle).toBe(3);

      // Verify persisted
      const read = await getBudget(testDir, sessionId);
      expect(read!.started_this_cycle).toBe(0);
    });

    it("should return null when no budget configured", async () => {
      const result = await resetBudget(testDir, sessionId);
      expect(result).toBeNull();
    });

    it("should preserve max_per_cycle after reset", async () => {
      await createBudget(testDir, sessionId, 7);
      await incrementBudget(testDir, sessionId);
      await resetBudget(testDir, sessionId);

      const budget = await getBudget(testDir, sessionId);
      expect(budget!.max_per_cycle).toBe(7);
      expect(budget!.started_this_cycle).toBe(0);
    });

    // AC: @task-budget-enforcement ac-atomic-write
    it("should write atomically (no temp files left behind)", async () => {
      await createBudget(testDir, sessionId, 3);
      await incrementBudget(testDir, sessionId);
      await resetBudget(testDir, sessionId);

      const sessionDir = path.join(testDir, "sessions", sessionId);
      const files = await fs.readdir(sessionDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe("full lifecycle", () => {
    it("should support create → increment → check → reset → check cycle", async () => {
      // Create budget allowing 1 task per cycle
      await createBudget(testDir, sessionId, 1);

      // Check: should be allowed (0/1)
      let check = await checkBudget(testDir, sessionId);
      expect(check.allowed).toBe(true);

      // Increment after starting a task
      await incrementBudget(testDir, sessionId);

      // Check: should be blocked (1/1)
      check = await checkBudget(testDir, sessionId);
      expect(check.allowed).toBe(false);

      // Reset at iteration boundary
      await resetBudget(testDir, sessionId);

      // Check: should be allowed again (0/1)
      check = await checkBudget(testDir, sessionId);
      expect(check.allowed).toBe(true);
    });
  });
});
