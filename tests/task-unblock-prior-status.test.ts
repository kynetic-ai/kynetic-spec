/**
 * Integration tests for restoring prior status on task unblock
 *
 * AC: @task-unblock ac-1
 * AC: @state-blocked ac-1
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  kspecOutput as kspec,
  kspecJson,
  readTestOutputSync,
  setupTempFixtures,
  cleanupTempDir,
  testUlid,
  seedSplitTask,
} from "./helpers/cli";

interface TaskState {
  status: string;
  blocked_by: string[];
  prior_status?: string | null;
}

describe("Integration: restore prior status on task unblock", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @task-unblock ac-1 — task resumes from in_progress
  it("should restore in_progress status when unblocking a task that was in_progress", () => {
    kspec('task add --title "Test task" --slug task-ip-block', tempDir);
    kspec("task start @task-ip-block", tempDir);

    const beforeBlock = kspecJson<TaskState>("task get @task-ip-block", tempDir);
    expect(beforeBlock.status).toBe("in_progress");

    kspec('task block @task-ip-block --reason "Waiting on API"', tempDir);

    const blocked = kspecJson<TaskState>("task get @task-ip-block", tempDir);
    expect(blocked.status).toBe("blocked");
    expect(blocked.prior_status).toBe("in_progress");

    kspec("task unblock @task-ip-block", tempDir);

    const unblocked = kspecJson<TaskState>("task get @task-ip-block", tempDir);
    expect(unblocked.status).toBe("in_progress");
    expect(unblocked.blocked_by).toEqual([]);
    expect(unblocked.prior_status).toBeNull();
  });

  // AC: @task-unblock ac-1 — task resumes from needs_work
  it("should restore needs_work status when unblocking a task that was in needs_work", () => {
    kspec('task add --title "Needs work task" --slug task-nw-block', tempDir);
    kspec("task start @task-nw-block", tempDir);
    kspec("task submit @task-nw-block", tempDir);
    kspec('task needs-work @task-nw-block --reason "Fix cycle"', tempDir);

    const beforeBlock = kspecJson<TaskState>("task get @task-nw-block", tempDir);
    expect(beforeBlock.status).toBe("needs_work");

    kspec('task block @task-nw-block --reason "Waiting on design decision"', tempDir);

    const blocked = kspecJson<TaskState>("task get @task-nw-block", tempDir);
    expect(blocked.status).toBe("blocked");
    expect(blocked.prior_status).toBe("needs_work");

    kspec("task unblock @task-nw-block", tempDir);

    const unblocked = kspecJson<TaskState>("task get @task-nw-block", tempDir);
    expect(unblocked.status).toBe("needs_work");
    expect(unblocked.blocked_by).toEqual([]);
    expect(unblocked.prior_status).toBeNull();
  });

  // AC: @task-unblock ac-1 — task resumes from pending_review
  it("should restore pending_review status when unblocking a task that was in pending_review", () => {
    kspec('task add --title "Review task" --slug task-pr-block', tempDir);
    kspec("task start @task-pr-block", tempDir);
    kspec("task submit @task-pr-block", tempDir);

    const beforeBlock = kspecJson<TaskState>("task get @task-pr-block", tempDir);
    expect(beforeBlock.status).toBe("pending_review");

    kspec('task block @task-pr-block --reason "Reviewer unavailable"', tempDir);

    const blocked = kspecJson<TaskState>("task get @task-pr-block", tempDir);
    expect(blocked.status).toBe("blocked");
    expect(blocked.prior_status).toBe("pending_review");

    kspec("task unblock @task-pr-block", tempDir);

    const unblocked = kspecJson<TaskState>("task get @task-pr-block", tempDir);
    expect(unblocked.status).toBe("pending_review");
    expect(unblocked.blocked_by).toEqual([]);
    expect(unblocked.prior_status).toBeNull();
  });

  // AC: @task-unblock ac-1 — task resumes from pending
  it("should restore pending status when unblocking a task that was pending", () => {
    kspec('task add --title "Pending task" --slug task-p-block', tempDir);

    const beforeBlock = kspecJson<TaskState>("task get @task-p-block", tempDir);
    expect(beforeBlock.status).toBe("pending");

    kspec('task block @task-p-block --reason "External dep"', tempDir);

    const blocked = kspecJson<TaskState>("task get @task-p-block", tempDir);
    expect(blocked.status).toBe("blocked");
    expect(blocked.prior_status).toBe("pending");

    kspec("task unblock @task-p-block", tempDir);

    const unblocked = kspecJson<TaskState>("task get @task-p-block", tempDir);
    expect(unblocked.status).toBe("pending");
    expect(unblocked.blocked_by).toEqual([]);
    expect(unblocked.prior_status).toBeNull();
  });

  // AC: @task-unblock ac-1 — backwards compat: no prior_status falls back to pending
  it("should fall back to pending when prior_status is not set (backwards compat)", () => {
    const ulid = testUlid("KEGACY", 1);
    seedSplitTask(tempDir, {
      _ulid: ulid,
      slugs: ["task-legacy-blocked"],
      title: "Legacy blocked task",
      type: "task",
      status: "blocked",
      priority: 3,
      tags: [],
      blocked_by: ["Old reason"],
      depends_on: [],
      notes: [],
      todos: [],
      created_at: "2026-01-01T00:00:00Z",
    });

    const blocked = kspecJson<TaskState>("task get @task-legacy-blocked", tempDir);
    expect(blocked.status).toBe("blocked");

    kspec("task unblock @task-legacy-blocked", tempDir);

    const unblocked = kspecJson<TaskState>("task get @task-legacy-blocked", tempDir);
    expect(unblocked.status).toBe("pending");
    expect(unblocked.blocked_by).toEqual([]);
  });

  // AC: @state-blocked ac-1 — prior_status is recorded when blocking
  it("should store current status as prior_status when blocking", () => {
    kspec('task add --title "Block record test" --slug task-block-record', tempDir);
    kspec("task start @task-block-record", tempDir);

    const blocked = kspecJson<{ task: TaskState }>(
      'task block @task-block-record --reason "Test"',
      tempDir,
    );
    expect(blocked.task.status).toBe("blocked");
    expect(blocked.task.prior_status).toBe("in_progress");
    expect(blocked.task.blocked_by).toContain("Test");
  });

  // AC: @state-blocked ac-1 — re-blocking preserves original prior_status
  it("should preserve original prior_status when re-blocking an already blocked task", () => {
    kspec('task add --title "Re-block test" --slug task-reblock', tempDir);
    kspec("task start @task-reblock", tempDir);

    const beforeBlock = kspecJson<TaskState>("task get @task-reblock", tempDir);
    expect(beforeBlock.status).toBe("in_progress");

    kspec('task block @task-reblock --reason "First blocker"', tempDir);

    const firstBlock = kspecJson<TaskState>("task get @task-reblock", tempDir);
    expect(firstBlock.status).toBe("blocked");
    expect(firstBlock.prior_status).toBe("in_progress");
    expect(firstBlock.blocked_by).toEqual(["First blocker"]);

    kspec('task block @task-reblock --reason "Second blocker"', tempDir);

    const secondBlock = kspecJson<TaskState>("task get @task-reblock", tempDir);
    expect(secondBlock.status).toBe("blocked");
    expect(secondBlock.prior_status).toBe("in_progress");
    expect(secondBlock.blocked_by).toEqual(["First blocker", "Second blocker"]);

    kspec("task unblock @task-reblock", tempDir);

    const unblocked = kspecJson<TaskState>("task get @task-reblock", tempDir);
    expect(unblocked.status).toBe("in_progress");
    expect(unblocked.blocked_by).toEqual([]);
    expect(unblocked.prior_status).toBeNull();
  });

  // AC: @trait-json-output ac-1 — JSON output includes prior_status field
  // AC: @trait-json-output ac-2 — all data available in JSON
  it("should include prior_status in task get JSON output when blocked", () => {
    kspec('task add --title "JSON test" --slug task-json-block', tempDir);
    kspec("task start @task-json-block", tempDir);
    kspec('task block @task-json-block --reason "Test"', tempDir);

    const result = kspecJson<TaskState>("task get @task-json-block", tempDir);
    expect(result.status).toBe("blocked");
    expect(result.prior_status).toBe("in_progress");
  });
});
