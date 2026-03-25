/**
 * Tests for session start dependency display ("unlocks N" annotation)
 *
 * AC: @session-start-unlocks ac-unlocks-shown
 * AC: @session-start-unlocks ac-unlocks-omit-zero
 * AC: @session-start-unlocks ac-unlocks-unresolvable
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kspec, kspecJson, setupTempFixtures, cleanupTempDir, testUlid, seedSplitTask } from "../helpers/cli";
import type { SessionContext } from "../helpers/session-types";

describe("session start dependency display", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @session-start-unlocks ac-unlocks-shown
  describe("unlocks annotation shown when N > 0", () => {
    it("should show unlocks count for ready tasks that have pending dependents", () => {
      // Create a "parent" task that other tasks depend on
      kspec('task add --title "Parent task" --slug task-parent', tempDir);

      // Create two tasks that depend on the parent
      kspec(
        'task add --title "Child one" --slug task-child-one --depends-on @task-parent',
        tempDir,
      );
      kspec(
        'task add --title "Child two" --slug task-child-two --depends-on @task-parent',
        tempDir,
      );

      const session = kspecJson<SessionContext>("session start --json", tempDir);

      const parentTask = session.ready_tasks.find((t) => t.title === "Parent task");
      expect(parentTask).toBeDefined();
      expect(parentTask!.unlocks).toBe(2);
    });

    it("should show unlocks count in human-readable output", () => {
      kspec('task add --title "Blocker task" --slug task-blocker', tempDir);
      kspec(
        'task add --title "Dependent task" --slug task-dependent --depends-on @task-blocker',
        tempDir,
      );

      const result = kspec("session start", tempDir);

      expect(result.stdout).toContain("unlocks 1");
    });

    it("should show unlocks for blocked tasks that have pending dependents", () => {
      // Create a blocked task that other tasks depend on
      kspec('task add --title "Blocked parent" --slug task-blocked-parent', tempDir);
      kspec("task start @task-blocked-parent", tempDir);
      kspec('task block @task-blocked-parent --reason "Waiting on external"', tempDir);

      // Create a task that depends on the blocked parent
      kspec(
        'task add --title "Waiting child" --slug task-waiting-child --depends-on @task-blocked-parent',
        tempDir,
      );

      const session = kspecJson<SessionContext>("session start --json", tempDir);

      const blockedTask = session.blocked_tasks.find((t) => t.title === "Blocked parent");
      expect(blockedTask).toBeDefined();
      expect(blockedTask!.unlocks).toBe(1);
    });

    it("should show unlocks in blocked task human output", () => {
      kspec('task add --title "Blocked blocker" --slug task-blocked-blocker', tempDir);
      kspec("task start @task-blocked-blocker", tempDir);
      kspec('task block @task-blocked-blocker --reason "External blocker"', tempDir);

      kspec(
        'task add --title "Downstream task" --slug task-downstream --depends-on @task-blocked-blocker',
        tempDir,
      );

      const result = kspec("session start", tempDir);

      // The blocked task line should contain "unlocks 1"
      const lines = result.stdout.split("\n");
      const blockedLine = lines.find((l: string) => l.includes("Blocked blocker"));
      expect(blockedLine).toBeDefined();
      expect(blockedLine).toContain("unlocks 1");
    });
  });

  // AC: @session-start-unlocks ac-unlocks-omit-zero
  describe("unlocks omitted when zero", () => {
    it("should not show unlocks annotation for tasks with no dependents", () => {
      // Create a standalone task with no dependents
      kspec('task add --title "Standalone task" --slug task-standalone', tempDir);

      const session = kspecJson<SessionContext>("session start --json", tempDir);

      const standaloneTask = session.ready_tasks.find((t) => t.title === "Standalone task");
      expect(standaloneTask).toBeDefined();
      expect(standaloneTask!.unlocks).toBe(0);
    });

    it("should not show unlocks text in human output for zero-dependent tasks", () => {
      kspec('task add --title "Solo task" --slug task-solo', tempDir);

      const result = kspec("session start", tempDir);

      // Find the line for our task
      const lines = result.stdout.split("\n");
      const soloLine = lines.find((l: string) => l.includes("Solo task"));
      expect(soloLine).toBeDefined();
      expect(soloLine).not.toContain("unlocks");
    });

    it("should not count completed dependents as unlockable", () => {
      // Create parent and a child, then complete the child
      kspec('task add --title "Done parent" --slug task-done-parent', tempDir);
      kspec(
        'task add --title "Done child" --slug task-done-child --depends-on @task-done-parent',
        tempDir,
      );

      // Complete the child task — completed tasks should not count
      kspec("task start @task-done-child", tempDir);
      kspec("task submit @task-done-child", tempDir);
      kspec('task complete @task-done-child --reason "Finished"', tempDir);

      const session = kspecJson<SessionContext>("session start --json", tempDir);

      const parentTask = session.ready_tasks.find((t) => t.title === "Done parent");
      expect(parentTask).toBeDefined();
      expect(parentTask!.unlocks).toBe(0);
    });

    it("should not count in_progress dependents as unlockable", () => {
      // Only pending tasks count — in_progress tasks are already being worked on
      kspec('task add --title "IP parent" --slug task-ip-parent', tempDir);
      kspec(
        'task add --title "IP child" --slug task-ip-child --depends-on @task-ip-parent',
        tempDir,
      );

      // Start the child so it becomes in_progress
      kspec("task start @task-ip-child", tempDir);

      const session = kspecJson<SessionContext>("session start --json", tempDir);

      const parentTask = session.ready_tasks.find((t) => t.title === "IP parent");
      expect(parentTask).toBeDefined();
      expect(parentTask!.unlocks).toBe(0);
    });

    it("should not count blocked dependents as unlockable", () => {
      // Blocked tasks are not pending work waiting to be unblocked by this task
      kspec('task add --title "Blocked dep parent" --slug task-bdp', tempDir);
      kspec('task add --title "Blocked dep child" --slug task-bdc --depends-on @task-bdp', tempDir);

      // Block the child
      kspec("task start @task-bdc", tempDir);
      kspec('task block @task-bdc --reason "External"', tempDir);

      const session = kspecJson<SessionContext>("session start --json", tempDir);

      const parentTask = session.ready_tasks.find((t) => t.title === "Blocked dep parent");
      expect(parentTask).toBeDefined();
      expect(parentTask!.unlocks).toBe(0);
    });
  });

  // AC: @session-start-unlocks ac-unlocks-unresolvable
  describe("unresolvable refs silently skipped", () => {
    it("should not error when a depends_on ref cannot be resolved", () => {
      // Create a target task that would be "unlocked"
      kspec('task add --title "Target task" --slug task-target', tempDir);

      // Inject a task with an unresolvable depends_on ref using split format
      const bogusTaskUlid = testUlid("BADREF", 1);
      seedSplitTask(tempDir, {
        _ulid: bogusTaskUlid,
        slugs: ["task-with-bad-ref"],
        title: "Task with bad ref",
        type: "task",
        status: "pending",
        priority: 3,
        automation: "eligible",
        tags: [],
        description: "Has an unresolvable depends_on",
        depends_on: ["@nonexistent-ref-that-does-not-exist", "@task-target"],
        notes: [],
        todos: [],
        created_at: "2026-01-01T00:00:00Z",
      });

      // Session start should succeed without errors (unresolvable ref silently skipped)
      const session = kspecJson<SessionContext>("session start --json", tempDir);
      expect(session.ready_tasks).toBeDefined();

      // The target task should have unlocks = 1 (from the bad-ref task's resolvable dep)
      const targetTask = session.ready_tasks.find((t) => t.title === "Target task");
      expect(targetTask).toBeDefined();
      expect(targetTask!.unlocks).toBe(1);
    });

    it("should not count unresolvable refs toward unlocks total", () => {
      // Create two tasks: one real dependency, one will have bogus ref
      kspec('task add --title "Real dep" --slug task-real-dep', tempDir);
      kspec(
        'task add --title "Depending task" --slug task-depending --depends-on @task-real-dep',
        tempDir,
      );

      // The bogus ref "@nonexistent" should not inflate any unlocks count
      const session = kspecJson<SessionContext>("session start --json", tempDir);

      const realDep = session.ready_tasks.find((t) => t.title === "Real dep");
      expect(realDep).toBeDefined();
      // Should be exactly 1, not inflated by any phantom refs
      expect(realDep!.unlocks).toBe(1);
    });
  });
});
