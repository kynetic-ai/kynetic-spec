/**
 * Tests for loop mode error handling utilities.
 *
 * AC: @loop-mode-error-handling (all 9 ACs)
 */

import { describe, expect, it } from "vitest";
import type { Task } from "../src/schema/task.js";
import {
  createFailureNote,
  getTaskFailureCount,
  hasTaskProgress,
  isIterationFailure,
  parseFailureCount,
  processFailedIteration,
  shouldEscalate,
} from "../src/ralph/loop-errors.js";

describe("Loop Mode Error Handling", () => {
  describe("parseFailureCount", () => {
    // AC: @loop-mode-error-handling ac-4
    it("should parse failure count from [LOOP-FAIL:N] prefix", () => {
      expect(parseFailureCount("[LOOP-FAIL:1] Task failed")).toBe(1);
      expect(parseFailureCount("[LOOP-FAIL:2] Another failure")).toBe(2);
      expect(parseFailureCount("[LOOP-FAIL:10] Many failures")).toBe(10);
    });

    // AC: @loop-mode-error-handling ac-4
    it("should return 0 for non-failure notes", () => {
      expect(parseFailureCount("Normal note")).toBe(0);
      expect(parseFailureCount("Working on task")).toBe(0);
      expect(parseFailureCount("")).toBe(0);
    });

    // AC: @loop-mode-error-handling ac-4
    it("should return 0 for malformed failure prefix", () => {
      expect(parseFailureCount("[LOOP-FAIL] Missing number")).toBe(0);
      expect(parseFailureCount("LOOP-FAIL:1 Missing brackets")).toBe(0);
      expect(parseFailureCount("[LOOP-FAIL:abc] Invalid number")).toBe(0);
    });
  });

  describe("getTaskFailureCount", () => {
    // AC: @loop-mode-error-handling ac-4
    it("should return highest failure count from task notes", () => {
      const task: Task = {
        _ulid: "01TEST000000000000000000000",
        slugs: [],
        title: "Test Task",
        type: "task",
        status: "in_progress",
        notes: [
          {
            _ulid: "01NOTE1",
            created_at: "2024-01-01T00:00:00Z",
            author: "@test",
            content: "Started work",
          },
          {
            _ulid: "01NOTE2",
            created_at: "2024-01-02T00:00:00Z",
            author: "@test",
            content: "[LOOP-FAIL:1] First failure",
          },
          {
            _ulid: "01NOTE3",
            created_at: "2024-01-03T00:00:00Z",
            author: "@test",
            content: "Trying again",
          },
          {
            _ulid: "01NOTE4",
            created_at: "2024-01-04T00:00:00Z",
            author: "@test",
            content: "[LOOP-FAIL:2] Second failure",
          },
        ],
      };

      expect(getTaskFailureCount(task)).toBe(2);
    });

    // AC: @loop-mode-error-handling ac-4
    it("should return 0 for task with no failure notes", () => {
      const task: Task = {
        _ulid: "01TEST000000000000000000000",
        slugs: [],
        title: "Test Task",
        type: "task",
        status: "in_progress",
        notes: [
          {
            _ulid: "01NOTE1",
            created_at: "2024-01-01T00:00:00Z",
            author: "@test",
            content: "Normal note",
          },
        ],
      };

      expect(getTaskFailureCount(task)).toBe(0);
    });

    // AC: @loop-mode-error-handling ac-4
    it("should return 0 for task with no notes", () => {
      const task: Task = {
        _ulid: "01TEST000000000000000000000",
        slugs: [],
        title: "Test Task",
        type: "task",
        status: "in_progress",
      };

      expect(getTaskFailureCount(task)).toBe(0);
    });
  });

  describe("createFailureNote", () => {
    // AC: @loop-mode-error-handling ac-1, ac-3
    it("should create failure note with incremented count", () => {
      const note1 = createFailureNote("@task-ref", "Tests failed", 0);
      expect(note1).toBe("[LOOP-FAIL:1] Task @task-ref failed: Tests failed");

      const note2 = createFailureNote("@task-ref", "Still failing", 1);
      expect(note2).toBe("[LOOP-FAIL:2] Task @task-ref failed: Still failing");

      const note3 = createFailureNote("@task-ref", "Third time", 2);
      expect(note3).toBe("[LOOP-FAIL:3] Task @task-ref failed: Third time");
    });

    // AC: @loop-mode-error-handling ac-3
    it("should include error description in note", () => {
      const note = createFailureNote(
        "@task-ref",
        "Build failed with exit code 1",
        0,
      );
      expect(note).toContain("Build failed with exit code 1");
    });
  });

  describe("shouldEscalate", () => {
    // AC: @loop-mode-error-handling ac-5
    it("should return true at threshold of 3 failures", () => {
      expect(shouldEscalate(3)).toBe(true);
      expect(shouldEscalate(4)).toBe(true);
      expect(shouldEscalate(10)).toBe(true);
    });

    // AC: @loop-mode-error-handling ac-5
    it("should return false below threshold", () => {
      expect(shouldEscalate(0)).toBe(false);
      expect(shouldEscalate(1)).toBe(false);
      expect(shouldEscalate(2)).toBe(false);
    });
  });

  describe("isIterationFailure", () => {
    // AC: @loop-mode-error-handling ac-7
    it("should detect explicit failure", () => {
      expect(isIterationFailure({ succeeded: false })).toBe(true);
    });

    // AC: @loop-mode-error-handling ac-7
    it("should detect error thrown", () => {
      expect(
        isIterationFailure({ error: new Error("Something broke") }),
      ).toBe(true);
    });

    // AC: @loop-mode-error-handling ac-7
    it("should detect cancelled stop reason", () => {
      expect(isIterationFailure({ stopReason: "cancelled" })).toBe(true);
    });

    // AC: @loop-mode-error-handling ac-7
    it("should return false for successful iteration", () => {
      expect(isIterationFailure({ succeeded: true })).toBe(false);
      expect(isIterationFailure({ stopReason: "end_turn" })).toBe(false);
      expect(isIterationFailure({})).toBe(false);
    });
  });

  describe("hasTaskProgress", () => {
    const iterationStart = new Date("2024-01-10T12:00:00Z");

    // AC: @loop-mode-error-handling ac-8
    it("should detect progress from new non-failure notes", () => {
      const task: Task = {
        _ulid: "01TEST000000000000000000000",
        slugs: [],
        title: "Test Task",
        type: "task",
        status: "in_progress",
        notes: [
          {
            _ulid: "01NOTE1",
            created_at: "2024-01-10T11:00:00Z", // Before iteration
            author: "@test",
            content: "Started work",
          },
          {
            _ulid: "01NOTE2",
            created_at: "2024-01-10T13:00:00Z", // After iteration start
            author: "@test",
            content: "Made some progress",
          },
        ],
      };

      expect(hasTaskProgress(task, iterationStart)).toBe(true);
    });

    // AC: @loop-mode-error-handling ac-8
    it("should not count LOOP-FAIL notes as progress", () => {
      const task: Task = {
        _ulid: "01TEST000000000000000000000",
        slugs: [],
        title: "Test Task",
        type: "task",
        status: "in_progress",
        notes: [
          {
            _ulid: "01NOTE1",
            created_at: "2024-01-10T11:00:00Z",
            author: "@test",
            content: "Started work",
          },
          {
            _ulid: "01NOTE2",
            created_at: "2024-01-10T13:00:00Z",
            author: "@test",
            content: "[LOOP-FAIL:1] Task failed",
          },
        ],
      };

      expect(hasTaskProgress(task, iterationStart)).toBe(false);
    });

    // AC: @loop-mode-error-handling ac-8
    it("should return false when only old notes exist", () => {
      const task: Task = {
        _ulid: "01TEST000000000000000000000",
        slugs: [],
        title: "Test Task",
        type: "task",
        status: "in_progress",
        notes: [
          {
            _ulid: "01NOTE1",
            created_at: "2024-01-10T11:00:00Z",
            author: "@test",
            content: "Old work",
          },
        ],
      };

      expect(hasTaskProgress(task, iterationStart)).toBe(false);
    });

    // AC: @loop-mode-error-handling ac-8
    it("should return false for task with no notes", () => {
      const task: Task = {
        _ulid: "01TEST000000000000000000000",
        slugs: [],
        title: "Test Task",
        type: "task",
        status: "in_progress",
      };

      expect(hasTaskProgress(task, iterationStart)).toBe(false);
    });
  });

  describe("processFailedIteration", () => {
    const iterationStart = new Date("2024-01-10T12:00:00Z");

    // AC: @loop-mode-error-handling ac-8
    it("should identify tasks without progress", () => {
      const tasksInProgress: Task[] = [
        {
          _ulid: "01TASK1",
          slugs: [],
          title: "Task 1",
          type: "task",
          status: "in_progress",
          notes: [
            {
              _ulid: "01NOTE1",
              created_at: "2024-01-10T11:00:00Z",
              author: "@test",
              content: "Old note",
            },
          ],
        },
      ];

      const currentTasks: Task[] = [
        {
          ...tasksInProgress[0],
          // Still in_progress, no new notes
        },
      ];

      const results = processFailedIteration(
        tasksInProgress,
        currentTasks,
        iterationStart,
        "Iteration failed",
      );

      expect(results).toHaveLength(1);
      expect(results[0].taskRef).toBe("01TASK1");
      expect(results[0].failureCount).toBe(1);
      expect(results[0].escalated).toBe(false);
      expect(results[0].noteAdded).toBe(true);
    });

    // AC: @loop-mode-error-handling ac-4, ac-5
    it("should track escalation at third failure", () => {
      const tasksInProgress: Task[] = [
        {
          _ulid: "01TASK1",
          slugs: [],
          title: "Task 1",
          type: "task",
          status: "in_progress",
          notes: [
            {
              _ulid: "01NOTE1",
              created_at: "2024-01-10T10:00:00Z",
              author: "@test",
              content: "[LOOP-FAIL:1] First failure",
            },
            {
              _ulid: "01NOTE2",
              created_at: "2024-01-10T11:00:00Z",
              author: "@test",
              content: "[LOOP-FAIL:2] Second failure",
            },
          ],
        },
      ];

      const currentTasks: Task[] = [{ ...tasksInProgress[0] }];

      const results = processFailedIteration(
        tasksInProgress,
        currentTasks,
        iterationStart,
        "Third failure",
      );

      expect(results).toHaveLength(1);
      expect(results[0].failureCount).toBe(3);
      expect(results[0].escalated).toBe(true);
    });

    // AC: @loop-mode-error-handling ac-2, ac-6
    it("should skip tasks that were completed during iteration", () => {
      const tasksInProgress: Task[] = [
        {
          _ulid: "01TASK1",
          slugs: [],
          title: "Task 1",
          type: "task",
          status: "in_progress",
        },
      ];

      const currentTasks: Task[] = [
        {
          ...tasksInProgress[0],
          status: "completed", // Changed to completed
          completed_at: "2024-01-10T13:00:00Z",
        },
      ];

      const results = processFailedIteration(
        tasksInProgress,
        currentTasks,
        iterationStart,
        "Iteration failed",
      );

      // Should not track failure for completed task
      expect(results).toHaveLength(0);
    });

    // AC: @loop-mode-error-handling ac-8
    it("should skip tasks that made progress", () => {
      const tasksInProgress: Task[] = [
        {
          _ulid: "01TASK1",
          slugs: [],
          title: "Task 1",
          type: "task",
          status: "in_progress",
          notes: [
            {
              _ulid: "01NOTE1",
              created_at: "2024-01-10T11:00:00Z",
              author: "@test",
              content: "Old note",
            },
          ],
        },
      ];

      const currentTasks: Task[] = [
        {
          ...tasksInProgress[0],
          notes: [
            ...tasksInProgress[0].notes!,
            {
              _ulid: "01NOTE2",
              created_at: "2024-01-10T13:00:00Z", // After iteration start
              author: "@test",
              content: "Made progress",
            },
          ],
        },
      ];

      const results = processFailedIteration(
        tasksInProgress,
        currentTasks,
        iterationStart,
        "Iteration failed",
      );

      // Task made progress, so no failure recorded
      expect(results).toHaveLength(0);
    });

    // AC: @loop-mode-error-handling ac-2
    it("should handle multiple tasks independently", () => {
      const tasksInProgress: Task[] = [
        {
          _ulid: "01TASK1",
          slugs: [],
          title: "Task 1",
          type: "task",
          status: "in_progress",
        },
        {
          _ulid: "01TASK2",
          slugs: [],
          title: "Task 2",
          type: "task",
          status: "in_progress",
        },
      ];

      const currentTasks: Task[] = [
        { ...tasksInProgress[0] }, // Still in progress, no notes
        {
          ...tasksInProgress[1],
          notes: [
            {
              _ulid: "01NOTE1",
              created_at: "2024-01-10T13:00:00Z",
              author: "@test",
              content: "Made progress",
            },
          ],
        },
      ];

      const results = processFailedIteration(
        tasksInProgress,
        currentTasks,
        iterationStart,
        "Iteration failed",
      );

      // Only Task 1 should have failure tracked
      expect(results).toHaveLength(1);
      expect(results[0].taskRef).toBe("01TASK1");
    });

    // AC: @loop-mode-error-handling ac-9
    it("should count iteration as single failure regardless of phase", () => {
      // AC-9 states "each error noted separately, iteration counts as single failure"
      // Implementation note: phases run sequentially (task-work then reflect)
      // If task-work fails, reflect doesn't run
      // If reflect fails, only reflect error captured
      // Either way, iteration fails once → consecutiveFailures += 1

      const tasksInProgress: Task[] = [
        {
          _ulid: "01TASK1",
          slugs: [],
          title: "Task 1",
          type: "task",
          status: "in_progress",
        },
      ];

      const currentTasks: Task[] = [{ ...tasksInProgress[0] }];
      const iterationStart = new Date("2024-01-10T12:00:00Z");

      // Single call to processFailedIteration per iteration
      const results = processFailedIteration(
        tasksInProgress,
        currentTasks,
        iterationStart,
        "Iteration failed (task-work or reflect phase)",
      );

      // One failure note per task without progress
      expect(results).toHaveLength(1);
      expect(results[0].failureCount).toBe(1);
      expect(results[0].noteAdded).toBe(true);
    });
  });
});
