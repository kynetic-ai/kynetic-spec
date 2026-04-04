/**
 * Integration tests for session-scoped task claiming
 * AC: @session-scoped-task-claiming
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  kspec,
  kspecJson,
  kspecOutput,
  readTestOutput,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from "./helpers/cli";

describe("Integration: session-scoped task claiming", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @session-scoped-task-claiming ac-schema
  describe("ac-schema: session_id is optional and backward compatible", () => {
    it("should load existing tasks without session_id", () => {
      // Existing fixtures have no session_id field
      const task = kspecJson<{ status: string; session_id?: string | null }>(
        "task get @test-task-pending",
        tempDir,
      );
      expect(task.status).toBe("pending");
      // session_id should be absent or undefined — backward compatible
      expect(task.session_id).toBeUndefined();
    });

    it("should accept tasks with session_id set", () => {
      // Start task with session_id to prove the field is accepted
      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: "01KJ6NFBHNMBABEHHDVEYSPJFR" },
      });
      const task = kspecJson<{ status: string; session_id?: string | null }>(
        "task get @test-task-pending",
        tempDir,
      );
      expect(task.status).toBe("in_progress");
      expect(task.session_id).toBe("01KJ6NFBHNMBABEHHDVEYSPJFR");
    });
  });

  // AC: @session-scoped-task-claiming ac-stamp
  describe("ac-stamp: task start stamps session_id when env var set", () => {
    it("should set session_id from KSPEC_SESSION_ID env var", () => {
      const sessionId = "01KJ6NFBHNMBABEHHDVEYSPJFR";
      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: sessionId },
      });

      const task = kspecJson<{ session_id?: string | null }>(
        "task get @test-task-pending",
        tempDir,
      );
      expect(task.session_id).toBe(sessionId);
    });
  });

  // AC: @session-scoped-task-claiming ac-no-env
  describe("ac-no-env: no session_id stamped when env var not set", () => {
    it("should not set session_id when KSPEC_SESSION_ID is absent", () => {
      // Explicitly remove KSPEC_SESSION_ID if somehow set
      const originalEnv = process.env.KSPEC_SESSION_ID;
      delete process.env.KSPEC_SESSION_ID;

      try {
        kspec("task start @test-task-pending", tempDir);
        const task = kspecJson<{ session_id?: string | null }>(
          "task get @test-task-pending",
          tempDir,
        );
        // session_id should not be set
        expect(task.session_id).toBeUndefined();
      } finally {
        if (originalEnv !== undefined) {
          process.env.KSPEC_SESSION_ID = originalEnv;
        }
      }
    });
  });

  // AC: @session-scoped-task-claiming ac-startable
  describe("ac-startable: warn when starting task claimed by another session", () => {
    it("should show warning when task has session_id from another session", async () => {
      // Add session_id to the pending task's per-task file (split format)
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const taskFile = path.join(tempDir, "tasks", "01KF1645CA45ZT43W2T6HJMVA1", "task.yaml");
      const content = await readTestOutput(taskFile);

      // Add session_id to the task detail file
      const updatedContent = content.replace(
        "status: pending\npriority: 2\nautomation: eligible",
        'status: pending\npriority: 2\nautomation: eligible\nsession_id: "01KJ6NFBHNMBABEHHDVEYSPJFR"',
      );
      await fs.writeFile(taskFile, updatedContent);

      // Start the task with a different session
      const result = kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: "01KJ7AAAAAAAAAAAAAAAAAAAAAA" },
      });

      // Should contain warning about the other session
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("session 01KJ6NFB");
      expect(combined).toContain("Started task");
    });

    it("should not warn when same session re-starts a task", async () => {
      const sessionId = "01KJ6NFBHNMBABEHHDVEYSPJFR";

      // Add session_id to the pending task's per-task file (split format)
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const taskFile = path.join(tempDir, "tasks", "01KF1645CA45ZT43W2T6HJMVA1", "task.yaml");
      const content = await readTestOutput(taskFile);
      const updatedContent = content.replace(
        "status: pending\npriority: 2\nautomation: eligible",
        `status: pending\npriority: 2\nautomation: eligible\nsession_id: "${sessionId}"`,
      );
      await fs.writeFile(taskFile, updatedContent);

      const result = kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: sessionId },
      });

      // Should NOT contain warning about session claiming
      const combined = result.stdout + result.stderr;
      expect(combined).not.toContain("claimed by session");
      expect(combined).toContain("Started task");
    });
  });

  // AC: @session-scoped-task-claiming ac-display
  describe("ac-display: session indicator in task list output", () => {
    it("should show session indicator for tasks with session_id", async () => {
      // Start a task with a session ID to give it session_id
      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: "01KJ6NFBHNMBABEHHDVEYSPJFR" },
      });

      // List in-progress tasks (which should include the session indicator)
      const result = kspecOutput("tasks list --status in_progress", tempDir);
      expect(result).toContain("[session 01KJ6NFB...]");
    });

    it("should show session_id in task details", () => {
      const sessionId = "01KJ6NFBHNMBABEHHDVEYSPJFR";
      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: sessionId },
      });

      const result = kspecOutput("task get @test-task-pending", tempDir);
      expect(result).toContain(sessionId);
    });

    it("should include session_id in JSON output", () => {
      const sessionId = "01KJ6NFBHNMBABEHHDVEYSPJFR";
      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: sessionId },
      });

      const task = kspecJson<{ session_id?: string | null }>(
        "task get @test-task-pending",
        tempDir,
      );
      expect(task.session_id).toBe(sessionId);
    });
  });

  // AC: @session-scoped-task-claiming ac-claim-clear
  describe("ac-claim-clear: session_id cleared on status transitions", () => {
    it("should clear session_id when task transitions to needs_work", () => {
      const sessionId = "01KJ6NFBHNMBABEHHDVEYSPJFR";

      // Start with session
      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: sessionId },
      });

      // Submit
      kspec("task submit @test-task-pending", tempDir);

      // Kick back to needs_work
      kspec('task needs-work @test-task-pending --reason "Needs fixes"', tempDir);

      const task = kspecJson<{ status: string; session_id?: string | null }>(
        "task get @test-task-pending",
        tempDir,
      );
      expect(task.status).toBe("needs_work");
      expect(task.session_id).toBeNull();
    });

    it("should clear session_id when task is unblocked", () => {
      const sessionId = "01KJ6NFBHNMBABEHHDVEYSPJFR";

      // Start with session
      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: sessionId },
      });

      // Block it
      kspec('task block @test-task-pending --reason "Waiting on design"', tempDir);

      // Verify session_id exists while blocked (should be preserved from in_progress)
      const blocked = kspecJson<{ session_id?: string | null }>(
        "task get @test-task-pending",
        tempDir,
      );
      expect(blocked.session_id).toBe(sessionId);

      // Unblock it — restores prior status (in_progress) but clears session_id
      kspec("task unblock @test-task-pending", tempDir);

      const task = kspecJson<{ status: string; session_id?: string | null }>(
        "task get @test-task-pending",
        tempDir,
      );
      expect(task.status).toBe("in_progress");
      expect(task.session_id).toBeNull();
    });

    it("should clear session_id when task is reset to pending", () => {
      const sessionId = "01KJ6NFBHNMBABEHHDVEYSPJFR";

      // Start with session
      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: sessionId },
      });

      // Complete the task
      kspec('task complete @test-task-pending --skip-review --reason "Done"', tempDir);

      // Reset to pending
      kspec("task reset @test-task-pending", tempDir);

      const task = kspecJson<{ status: string; session_id?: string | null }>(
        "task get @test-task-pending",
        tempDir,
      );
      expect(task.status).toBe("pending");
      expect(task.session_id).toBeNull();
    });

    it("should report session_id in cleared_fields on reset", () => {
      const sessionId = "01KJ6NFBHNMBABEHHDVEYSPJFR";

      kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: sessionId },
      });

      const resetResult = kspecJson<{ cleared_fields: string[] }>(
        "task reset @test-task-pending",
        tempDir,
      );
      expect(resetResult.cleared_fields).toContain("session_id");
    });
  });
});
