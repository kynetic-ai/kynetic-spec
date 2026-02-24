/**
 * Tests for ralph session budget integration.
 * Static analysis tests verify that ralph.ts uses session budget APIs
 * instead of marker files for task limit enforcement.
 *
 * AC: @ralph-session-budget-integration ac-create-budget, ac-reset-iteration,
 *     ac-env-inject, ac-remove-marker-code, ac-session-close-all-paths
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const RALPH_PATH = path.resolve("src/cli/commands/ralph.ts");
const ralphSource = fs.readFileSync(RALPH_PATH, "utf-8");

describe("Ralph session budget integration", () => {
  // AC: @ralph-session-budget-integration ac-create-budget
  describe("ac-create-budget", () => {
    it("should use createSessionWithBudget instead of bare createSession", () => {
      expect(ralphSource).toContain("createSessionWithBudget");
      // Should NOT have bare createSession call (import is OK if re-exported)
      // Match only function calls, not import statements
      const callPattern = /await\s+createSession\s*\(/;
      expect(callPattern.test(ralphSource)).toBe(false);
    });

    it("should pass budget parameter to createSessionWithBudget", () => {
      expect(ralphSource).toMatch(/budget:\s*maxTasks/);
    });
  });

  // AC: @ralph-session-budget-integration ac-reset-iteration
  describe("ac-reset-iteration", () => {
    it("should call resetBudget in the iteration loop", () => {
      expect(ralphSource).toContain("resetBudget");
      // Verify it's called with specDir and sessionId
      expect(ralphSource).toMatch(/resetBudget\s*\(\s*specDir\s*,\s*sessionId\s*\)/);
    });
  });

  // AC: @ralph-session-budget-integration ac-env-inject
  describe("ac-env-inject", () => {
    it("should set KSPEC_SESSION_ID on process.env", () => {
      expect(ralphSource).toContain("process.env.KSPEC_SESSION_ID = sessionId");
    });

    it("should pass KSPEC_SESSION_ID to agent spawn", () => {
      expect(ralphSource).toMatch(/env:\s*\{\s*KSPEC_SESSION_ID:\s*sessionId\s*\}/);
    });

    it("should clean up KSPEC_SESSION_ID in finally block", () => {
      expect(ralphSource).toContain("delete process.env.KSPEC_SESSION_ID");
    });
  });

  // AC: @ralph-session-budget-integration ac-remove-marker-code
  describe("ac-remove-marker-code", () => {
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

    for (const pattern of removedPatterns) {
      it(`should not contain "${pattern}"`, () => {
        expect(ralphSource).not.toContain(pattern);
      });
    }

    it("should not import getIterationStats", () => {
      expect(ralphSource).not.toMatch(/import.*getIterationStats/);
    });
  });

  // AC: @ralph-session-budget-integration ac-session-close-all-paths
  describe("ac-session-close-all-paths", () => {
    it("should have budget cleanup via getSessionBudgetPath", () => {
      expect(ralphSource).toContain("getSessionBudgetPath");
    });

    it("should clean up budget in signal handler", () => {
      // The signal handler should delete the budget file
      // Look for unlink + getSessionBudgetPath in the signal handler area
      const signalHandlerMatch = ralphSource.match(
        /signalCleanup[\s\S]*?process\.exit/
      );
      expect(signalHandlerMatch).not.toBeNull();
      expect(signalHandlerMatch![0]).toContain("getSessionBudgetPath");
    });

    it("should clean up budget in finally block", () => {
      // The finally block should also delete the budget file
      const finallyMatch = ralphSource.match(/finally\s*\{[\s\S]*?\n {8}\}/);
      expect(finallyMatch).not.toBeNull();
      expect(finallyMatch![0]).toContain("getSessionBudgetPath");
    });

    it("should close session with status in finally block", () => {
      const finallyMatch = ralphSource.match(/finally\s*\{[\s\S]*?\n {8}\}/);
      expect(finallyMatch).not.toBeNull();
      expect(finallyMatch![0]).toContain("closeSession");
    });
  });
});
