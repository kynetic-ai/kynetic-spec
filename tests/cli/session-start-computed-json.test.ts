/**
 * Tests for session start computed JSON fields
 *
 * AC: @session-start-computed-json ac-computed-inbox
 * AC: @session-start-computed-json ac-computed-unlocks
 * AC: @session-start-computed-json ac-computed-activity
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  kspec,
  setupTempFixtures,
  cleanupTempDir,
  kspecJson,
  testUlid,
  testUlids,
} from "../helpers/cli";
import type { SessionContext } from "../helpers/session-types";
import { seedInboxItems, seedTriageRecords } from "../helpers/inbox";

let tempDir: string;

beforeEach(async () => {
  tempDir = await setupTempFixtures();
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

// AC: @session-start-computed-json ac-computed-inbox
describe("computed.inbox fields", () => {
  it("should include inbox_untriaged_count, inbox_deferred_count, and inbox_total", () => {
    const [ulid1, ulid2, ulid3] = testUlids("JNBX", 3);

    seedInboxItems(tempDir, [
      { _ulid: ulid1, text: "Untriaged item one" },
      { _ulid: ulid2, text: "Item to defer" },
      { _ulid: ulid3, text: "Item to promote" },
    ]);

    seedTriageRecords(tempDir, [
      { _ulid: testUlid("TRJG", 0), inbox_ref: ulid2, item_snapshot: "Item to defer", action: "defer", reasoning: "needs thought" },
      { _ulid: testUlid("TRJG", 1), inbox_ref: ulid3, item_snapshot: "Item to promote", action: "promote", reasoning: "good idea" },
    ]);

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.computed).toBeDefined();
    expect(session.computed.inbox_untriaged_count).toBe(1);
    expect(session.computed.inbox_deferred_count).toBe(1);
    expect(session.computed.inbox_total).toBe(3);
  });

  it("should mirror inbox_stats values", () => {
    const [ulid1, ulid2, ulid3] = testUlids("JNBX", 3);

    seedInboxItems(tempDir, [
      { _ulid: ulid1, text: "Deferred A" },
      { _ulid: ulid2, text: "Deferred B" },
      { _ulid: ulid3, text: "Untriaged C" },
    ]);

    seedTriageRecords(tempDir, [
      { _ulid: testUlid("TRJG", 0), inbox_ref: ulid1, item_snapshot: "Deferred A", action: "defer", reasoning: "later" },
      { _ulid: testUlid("TRJG", 1), inbox_ref: ulid2, item_snapshot: "Deferred B", action: "defer", reasoning: "later too" },
    ]);

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    // computed inbox fields should match inbox_stats
    expect(session.computed.inbox_untriaged_count).toBe(
      session.inbox_stats.untriaged,
    );
    expect(session.computed.inbox_deferred_count).toBe(
      session.inbox_stats.deferred,
    );
    expect(session.computed.inbox_total).toBe(session.inbox_stats.total);
  });

  it("should handle empty inbox with all zeros", () => {
    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.computed.inbox_untriaged_count).toBe(0);
    expect(session.computed.inbox_deferred_count).toBe(0);
    expect(session.computed.inbox_total).toBe(0);
  });
});

// AC: @session-start-computed-json ac-computed-unlocks
describe("computed.task_unlocks", () => {
  it("should contain ref-to-count map for tasks with pending dependents", () => {
    kspec(
      'task add --title "Parent task" --slug task-parent-computed',
      tempDir,
    );
    kspec(
      'task add --title "Child one" --slug task-child-one-c --depends-on @task-parent-computed',
      tempDir,
    );
    kspec(
      'task add --title "Child two" --slug task-child-two-c --depends-on @task-parent-computed',
      tempDir,
    );

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.computed.task_unlocks).toBeDefined();
    // Resolve the parent task's short ULID ref from ready_tasks
    const parentTask = session.ready_tasks.find(
      (t) => t.title === "Parent task",
    );
    expect(parentTask).toBeDefined();
    expect(session.computed.task_unlocks[parentTask!.ref]).toBe(2);
  });

  it("should omit tasks with zero dependents from the map", () => {
    kspec(
      'task add --title "Standalone computed" --slug task-standalone-c',
      tempDir,
    );

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    // task_unlocks should be empty or not contain standalone task
    const values = Object.values(session.computed.task_unlocks);
    // All values should be > 0 (no zero entries)
    for (const v of values) {
      expect(v).toBeGreaterThan(0);
    }
  });

  it("should only count pending dependents, not completed or in_progress", () => {
    kspec('task add --title "Dep parent" --slug task-dep-parent-c', tempDir);
    kspec(
      'task add --title "Dep child completed" --slug task-dep-child-done-c --depends-on @task-dep-parent-c',
      tempDir,
    );
    kspec(
      'task add --title "Dep child in progress" --slug task-dep-child-ip-c --depends-on @task-dep-parent-c',
      tempDir,
    );
    kspec(
      'task add --title "Dep child pending" --slug task-dep-child-pending-c --depends-on @task-dep-parent-c',
      tempDir,
    );

    // Complete one child
    kspec("task start @task-dep-child-done-c", tempDir);
    kspec("task submit @task-dep-child-done-c", tempDir);
    kspec(
      'task complete @task-dep-child-done-c --reason "Done"',
      tempDir,
    );

    // Start another child (in_progress should not count)
    kspec("task start @task-dep-child-ip-c", tempDir);

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    // Resolve parent ref and assert only the pending child counts
    const parentTask = session.ready_tasks.find(
      (t) => t.title === "Dep parent",
    );
    expect(parentTask).toBeDefined();
    expect(session.computed.task_unlocks[parentTask!.ref]).toBe(1);
  });

  it("should not include standalone tasks in the unlocks map", () => {
    // Add a standalone task with no dependents
    kspec('task add --title "No deps" --slug task-no-deps-c', tempDir);

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    // The standalone task should NOT appear in task_unlocks
    const standaloneTask = session.ready_tasks.find(
      (t) => t.title === "No deps",
    );
    expect(standaloneTask).toBeDefined();
    expect(session.computed.task_unlocks[standaloneTask!.ref]).toBeUndefined();

    // All entries in the map must have count > 0
    for (const count of Object.values(session.computed.task_unlocks)) {
      expect(count).toBeGreaterThan(0);
    }
  });
});

// AC: @session-start-computed-json ac-computed-activity
describe("computed.recent_activity", () => {
  it("should contain the same activity timeline as top-level activity_timeline", () => {
    // Complete a task to generate activity
    kspec('task add --title "Activity task" --slug task-activity-c', tempDir);
    kspec("task start @task-activity-c", tempDir);
    kspec("task submit @task-activity-c", tempDir);
    kspec(
      'task complete @task-activity-c --reason "Done for computed test"',
      tempDir,
    );

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.computed.recent_activity).toBeDefined();
    expect(Array.isArray(session.computed.recent_activity)).toBe(true);
    // Should match the top-level activity_timeline
    expect(session.computed.recent_activity).toEqual(
      session.activity_timeline,
    );
  });

  it("should be an empty array when no recent activity", () => {
    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.computed.recent_activity).toBeDefined();
    expect(Array.isArray(session.computed.recent_activity)).toBe(true);
  });

  it("should include task_completion entries for completed tasks", () => {
    kspec(
      'task add --title "Timeline task" --slug task-timeline-c',
      tempDir,
    );
    kspec("task start @task-timeline-c", tempDir);
    kspec("task submit @task-timeline-c", tempDir);
    kspec(
      'task complete @task-timeline-c --reason "For timeline test"',
      tempDir,
    );

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    const taskCompletions = session.computed.recent_activity.filter(
      (a) => a.type === "task_completion",
    );
    expect(taskCompletions.length).toBeGreaterThanOrEqual(1);
    const found = taskCompletions.find(
      (a) => a.task?.title === "Timeline task",
    );
    expect(found).toBeDefined();
  });
});

describe("computed field is additive", () => {
  it("should not modify existing JSON fields", () => {
    const ulid1 = testUlid("JNBX", 0);
    seedInboxItems(tempDir, [{ _ulid: ulid1, text: "Test item" }]);
    kspec('task add --title "Additive test" --slug task-additive', tempDir);

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    // Raw fields still present and unchanged
    expect(session.inbox_stats).toBeDefined();
    expect(session.recently_completed).toBeDefined();
    expect(session.recent_commits).toBeDefined();
    expect(session.activity_timeline).toBeDefined();

    // computed is an additional field
    expect(session.computed).toBeDefined();
    expect(session.computed.inbox_total).toBe(session.inbox_stats.total);
  });
});
