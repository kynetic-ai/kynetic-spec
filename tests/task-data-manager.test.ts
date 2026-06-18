import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initContext, TaskDataManager, TaskDataManagerError } from "../src/parser/index.js";
import type { TaskStorageBackend } from "../src/parser/task-data-manager.js";
import {
  registerBackend,
  unregisterBackend,
  resolveTaskDataManager,
} from "../src/parser/task-data-manager.js";
import { splitBackend, ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import { runWithEntityCache } from "../src/parser/yaml.js";
import {
  createMutationEventCollector,
  runWithMutationEventCollector,
} from "../src/mutation-pipeline.js";

// Register the split backend (no longer auto-registered at module scope)
ensureSplitBackendRegistered();
import { TaskSchema } from "../src/schema/task.js";
import {
  cleanupTempDir,
  readTestOutput,
  setupTempFixtures,
  testUlid,
  testUlids,
} from "./helpers/cli.js";

/** Detail-only fields that must NOT appear on TaskSummary results from listTasks. */
const DETAIL_ONLY_FIELDS = [
  "notes",
  "todos",
  "description",
  "vcs_refs",
  "review_url",
  "submission_linkage",
  "session_id",
  "meta_ref",
  "derivation",
  "origin",
  "prior_status",
  "closed_reason",
  "complexity",
  "context",
] as const;

async function loadFixtureTask(ctx: Awaited<ReturnType<typeof initContext>>, ref: string) {
  const { findTaskByRef, loadAllTasks } = await import("../src/parser/yaml.js");
  const task = findTaskByRef(await loadAllTasks(ctx), ref);
  if (!task) {
    throw new Error(`Fixture task not found: ${ref}`);
  }
  return task;
}

function toSummary(task: Awaited<ReturnType<typeof loadFixtureTask>>) {
  return {
    _ulid: task._ulid,
    slugs: task.slugs,
    title: task.title,
    type: task.type,
    status: task.status,
    priority: task.priority,
    tags: task.tags,
    assignee: task.assignee,
    automation: task.automation,
    spec_ref: task.spec_ref,
    plan_ref: task.plan_ref,
    review_ref: task.review_ref,
    depends_on: task.depends_on,
    blocked_by: task.blocked_by,
    created_at: task.created_at,
    started_at: task.started_at,
    submitted_at: task.submitted_at,
    completed_at: task.completed_at,
    notes_count: task.notes.length,
    todos_count: task.todos.length,
  };
}

describe("TaskDataManager", () => {
  let tempDir: string;
  let manager: TaskDataManager;

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  // AC: @task-data-manager ac-1
  // Callers do not know or care about the underlying storage format
  describe("storage format abstraction (ac-1)", () => {
    it("provides task data without exposing storage internals", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const tasks = await manager.listTasks(ctx);
      expect(tasks.length).toBeGreaterThan(0);

      // Callers get TaskSummary objects for listing — the storage format is not exposed
      const task = tasks[0];
      expect(task._ulid).toBeDefined();
      expect(task.title).toBeDefined();
      expect(task.status).toBeDefined();
    });

    it("reads and writes through the same interface regardless of backend", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Create via manager
      const created = await manager.createTask(ctx, {
        title: "Manager-created task",
        slugs: ["mgr-created"],
      });

      // Read back via manager
      const fetched = await manager.getTask(ctx, "@mgr-created");
      expect(fetched._ulid).toBe(created._ulid);
      expect(fetched.title).toBe("Manager-created task");
    });

    // AC: @mutation-event-coverage ac-1
    // AC: @mutation-event-coverage ac-5
    it("records a task creation event when callers omit commit metadata", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);
      const collector = createMutationEventCollector();

      const created = await runWithMutationEventCollector(collector, () =>
        manager.createTask(ctx, {
          title: "Metadata-free creation task",
          slugs: ["metadata-free-created"],
        }),
      );

      expect(collector.drain()).toEqual([
        {
          topic: "tasks:updates",
          event: "task_updated",
          data: expect.objectContaining({
            action: "created",
            ref: "@metadata-free-created",
            ulid: created._ulid,
            title: "Metadata-free creation task",
            old_status: null,
            new_status: "pending",
          }),
        },
      ]);
    });

    // AC: @mutation-event-coverage ac-1
    // AC: @mutation-event-coverage ac-5
    it("records task mutation events for skip-commit outer commits", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);
      const collector = createMutationEventCollector();
      const task = await manager.createTask(ctx, {
        title: "Outer-committed task",
        slugs: ["outer-committed-task"],
      });

      const updated = await runWithMutationEventCollector(collector, () =>
        manager.mutateTask(
          ctx,
          "@outer-committed-task",
          (latest) => ({
            ...latest,
            review_ref: "@outer-review",
          }),
          {
            operation: "review-link",
            ref: "@outer-committed-task",
            detail: "set review_ref to @outer-review",
            skipCommit: true,
          },
        ),
      );

      expect(collector.drain()).toEqual([
        {
          topic: "tasks:updates",
          event: "task_updated",
          data: expect.objectContaining({
            action: "review_linked",
            ref: "@outer-committed-task",
            ulid: task._ulid,
            title: updated.title,
            old_status: null,
            new_status: null,
          }),
        },
      ]);
    });

    // AC: @mutation-event-coverage ac-1
    // AC: @mutation-event-coverage ac-5
    it("records generic task change events when callers omit commit metadata", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);
      const collector = createMutationEventCollector();
      const task = await manager.createTask(ctx, {
        title: "Metadata-free mutation task",
        slugs: ["metadata-free-mutation-task"],
      });

      const updated = await runWithMutationEventCollector(collector, () =>
        manager.mutateTask(ctx, "@metadata-free-mutation-task", (latest) => ({
          ...latest,
          resource_refs: [
            {
              owner_type: "plan",
              owner_ref: "@plan-event-coverage",
              id: "doc",
              path: "doc.txt",
              sha256: "a".repeat(64),
              git_commit: null,
              git_path: null,
              recorded_at: "2026-06-18T00:00:00.000Z",
            },
          ],
        })),
      );

      expect(collector.drain()).toEqual([
        {
          topic: "tasks:updates",
          event: "task_updated",
          data: expect.objectContaining({
            action: "changed",
            ref: "@metadata-free-mutation-task",
            ulid: task._ulid,
            title: updated.title,
            old_status: null,
            new_status: null,
          }),
        },
      ]);
    });
  });

  // AC: @task-data-manager ac-2
  // AC: @task-listing-performance ac-1 — filtered lists read only index; no per-task directory accessed
  // Only index data is read for listing; per-task detail files are not accessed
  describe("list returns only index data (ac-2)", () => {
    it("returns summary records containing only index-level fields", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const tasks = await manager.listTasks(ctx);
      expect(tasks.length).toBe(4); // fixture has 4 tasks

      // Index fields are present
      expect(tasks.every((t) => t._ulid && t.title && t.status)).toBe(true);

      // Detail-only fields are NOT present on the returned objects
      for (const task of tasks) {
        for (const field of DETAIL_ONLY_FIELDS) {
          expect(task).not.toHaveProperty(
            field,
            `listTasks should not return detail field "${field}"`,
          );
        }
      }
    });

    it("returns TaskSummary type, not full LoadedTask", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Create a task with notes so we can verify they're stripped
      await manager.createTask(ctx, {
        title: "Task with detail data",
        slugs: ["detail-task"],
        description: "This is a description",
      });
      await manager.addNote(ctx, "@detail-task", "A note", "@author");

      // getTask returns full data including notes
      const fullTask = await manager.getTask(ctx, "@detail-task");
      expect(fullTask.notes.length).toBe(1);
      expect(fullTask.description).toBe("This is a description");

      // listTasks returns only summary — no notes or description
      const summaries = await manager.listTasks(ctx, {
        status: "pending",
      });
      const summary = summaries.find((t) => t.slugs.includes("detail-task"));
      expect(summary).toBeDefined();
      expect(summary).not.toHaveProperty("notes");
      expect(summary).not.toHaveProperty("description");
    });

    it("applies status filters", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const pendingTasks = await manager.listTasks(ctx, {
        status: "pending",
      });
      expect(pendingTasks.length).toBe(3); // 3 pending tasks in fixtures
      expect(pendingTasks.every((t) => t.status === "pending")).toBe(true);
    });

    it("applies tag filters (any match)", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const e2eTasks = await manager.listTasks(ctx, { tags: ["e2e"] });
      expect(e2eTasks.length).toBe(1);
      expect(e2eTasks[0].slugs).toContain("test-task-secondary");
    });

    it("applies automation filter", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const eligible = await manager.listTasks(ctx, {
        automation: "eligible",
      });
      expect(eligible.length).toBe(1);
      expect(eligible[0].slugs).toContain("test-task-pending");
    });

    it("applies multiple filters together", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const filtered = await manager.listTasks(ctx, {
        status: "pending",
        tags: ["test"],
      });
      // All 3 pending tasks have the "test" tag
      expect(filtered.length).toBe(3);
    });

    it("supports array of statuses", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const tasks = await manager.listTasks(ctx, {
        status: ["pending", "completed"],
      });
      expect(tasks.length).toBe(4); // 3 pending + 1 completed
    });

    it("discovers task files in subdirectories (recursive discovery)", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Add tasks via the split-format helper (per-task dirs + lean index)
      const { seedSplitTask: seed } = await import("./helpers/cli.js");
      const [nestedUlid1, nestedUlid2] = testUlids("NEST", 2);
      seed(tempDir, {
        _ulid: nestedUlid1,
        slugs: ["nested-task-one"],
        title: "Nested task one",
        type: "task",
        status: "pending",
        priority: 3,
        tags: ["nested"],
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-03-20T00:00:00.000Z",
      });
      seed(tempDir, {
        _ulid: nestedUlid2,
        slugs: ["nested-task-two"],
        title: "Nested task two",
        type: "task",
        status: "pending",
        priority: 2,
        tags: ["nested"],
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-03-20T00:00:00.000Z",
      });

      // listTasks (the manager's summary loader) must find the added tasks
      const summaries = await manager.listTasks(ctx);
      const nestedFromManager = summaries.filter((t) =>
        t.slugs.some((s) => s.startsWith("nested-task-")),
      );
      expect(nestedFromManager.length).toBe(2);

      // Total should include the 4 fixture tasks + 2 new tasks
      expect(summaries.length).toBe(6);
    });

    it("does not run full TaskSchema validation for listing", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Spy on TaskSchema.safeParse to verify it's NOT called during listing
      const originalSafeParse = TaskSchema.safeParse.bind(TaskSchema);
      let safeParseCallCount = 0;
      TaskSchema.safeParse = (...args: Parameters<typeof TaskSchema.safeParse>) => {
        safeParseCallCount++;
        return originalSafeParse(...args);
      };

      try {
        const summaries = await manager.listTasks(ctx);
        expect(summaries.length).toBe(4);
        // listTasks should extract summary fields from raw YAML without
        // running each record through TaskSchema.safeParse
        expect(safeParseCallCount).toBe(0);
      } finally {
        TaskSchema.safeParse = originalSafeParse;
      }
    });
  });

  // AC: @task-data-manager ac-3
  // AC: @task-detail-loading ac-1 — detail request reads index + per-task directory; result is unified task
  // Manager assembles the complete task from index and per-task files transparently
  describe("full detail loading (ac-3)", () => {
    it("returns complete task by slug reference", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const task = await manager.getTask(ctx, "@test-task-secondary");
      expect(task.title).toBe("Test secondary task");
      expect(task.notes.length).toBe(1);
      expect(task.notes[0].content).toBe("Initial note on secondary task");
      expect(task.todos.length).toBe(2);
    });

    it("returns complete task by ULID reference", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const task = await manager.getTask(ctx, "01KF1645CA45ZT43W2T6HJMVA1");
      expect(task.slugs).toContain("test-task-pending");
    });

    it("returns complete task by short ULID prefix", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const task = await manager.getTask(ctx, "01KF1645CA");
      expect(task.slugs).toContain("test-task-pending");
    });

    // AC: @trait-error-guidance ac-3 — suggests checking ref on not found
    it("throws with suggestion when task not found", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      await expect(manager.getTask(ctx, "@nonexistent-task")).rejects.toThrow(TaskDataManagerError);

      try {
        await manager.getTask(ctx, "@nonexistent-task");
      } catch (err) {
        expect(err).toBeInstanceOf(TaskDataManagerError);
        const tdmErr = err as TaskDataManagerError;
        expect(tdmErr.message).toContain("Task not found");
        expect(tdmErr.suggestion).toContain("kspec search");
      }
    });
  });

  describe("cache-backed task reads", () => {
    it("serves listTasks from the ready task cache without backend reads", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      const fixtureTask = await loadFixtureTask(ctx, "@test-task-pending");

      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        listTasks: vi.fn(async () => []),
        loadAllTasks: vi.fn(async () => []),
        getTask: vi.fn(async () => undefined),
        createTask: vi.fn(async (_ctx, task) => ({
          ...task,
          _sourceFile: `/mock/${task._ulid}.yaml`,
        })),
        mutateTask: vi.fn(async (_ctx, task) => task),
        mutateTasks: vi.fn(async (_ctx, tasks) => tasks),
        deleteTask: vi.fn(async () => {}),
        rebuildIndex: vi.fn(async () => ({ count: 0 })),
      };

      registerBackend(mockSplitBackend);
      try {
        manager = new TaskDataManager("split");

        // AC: @daemon-command-api ac-read-cache-serving
        const result = await runWithEntityCache(
          () =>
            manager.listTasks(ctx, {
              status: "pending",
            }),
          () => ({
            getDomainState: () => "ready",
            getTaskIndex: () => [toSummary(fixtureTask)],
            getTaskDetail: () => fixtureTask,
            getTaskHistory: () => [],
            setTaskDetail: vi.fn(),
            getAllTaskDetails: () => [fixtureTask],
          }),
          tempDir,
        );

        expect(result).toEqual([toSummary(fixtureTask)]);
        expect(mockSplitBackend.listTasks).not.toHaveBeenCalled();
      } finally {
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });

    it("serves loadAllTasks from the ready task cache without backend reads", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      const fixtureTask = await loadFixtureTask(ctx, "@test-task-secondary");

      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        listTasks: vi.fn(async () => []),
        loadAllTasks: vi.fn(async () => []),
        getTask: vi.fn(async () => undefined),
        createTask: vi.fn(async (_ctx, task) => ({
          ...task,
          _sourceFile: `/mock/${task._ulid}.yaml`,
        })),
        mutateTask: vi.fn(async (_ctx, task) => task),
        mutateTasks: vi.fn(async (_ctx, tasks) => tasks),
        deleteTask: vi.fn(async () => {}),
        rebuildIndex: vi.fn(async () => ({ count: 0 })),
      };

      registerBackend(mockSplitBackend);
      try {
        manager = new TaskDataManager("split");

        // AC: @daemon-command-api ac-read-cache-serving
        const result = await runWithEntityCache(
          () => manager.loadAllTasks(ctx),
          () => ({
            getDomainState: () => "ready",
            getTaskIndex: () => [toSummary(fixtureTask)],
            getTaskDetail: () => fixtureTask,
            getTaskHistory: () => [],
            setTaskDetail: vi.fn(),
            getAllTaskDetails: () => [fixtureTask],
          }),
          tempDir,
        );

        expect(result).toEqual([fixtureTask]);
        expect(mockSplitBackend.loadAllTasks).not.toHaveBeenCalled();
      } finally {
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });

    // AC: @daemon-entity-cache ac-task-history-retention
    it("delegates loadAllTasksWithHistory to backend when available", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      const fixtureTask = await loadFixtureTask(ctx, "@test-task-secondary");

      const mockHistory = [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          author: "@tester",
          command: "task-start",
          changes: { status: { previous: "pending", new: "in_progress" } },
        },
      ];

      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        listTasks: vi.fn(async () => []),
        loadAllTasks: vi.fn(async () => [fixtureTask]),
        getTask: vi.fn(async () => undefined),
        createTask: vi.fn(async (_ctx, task) => ({
          ...task,
          _sourceFile: `/mock/${task._ulid}.yaml`,
        })),
        mutateTask: vi.fn(async (_ctx, task) => task),
        mutateTasks: vi.fn(async (_ctx, tasks) => tasks),
        deleteTask: vi.fn(async () => {}),
        rebuildIndex: vi.fn(async () => ({ count: 0 })),
        loadAllTasksWithHistory: vi.fn(async () => [{ task: fixtureTask, history: mockHistory }]),
      };

      registerBackend(mockSplitBackend);
      try {
        manager = new TaskDataManager("split");

        const result = await manager.loadAllTasksWithHistory(ctx);

        expect(result).toEqual([{ task: fixtureTask, history: mockHistory }]);
        expect(mockSplitBackend.loadAllTasksWithHistory).toHaveBeenCalledOnce();
        // loadAllTasks should NOT be called when loadAllTasksWithHistory is available
        expect(mockSplitBackend.loadAllTasks).not.toHaveBeenCalled();
      } finally {
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });

    // AC: @daemon-entity-cache ac-task-history-retention
    it("falls back to loadAllTasks with empty history when backend lacks loadAllTasksWithHistory", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      const fixtureTask = await loadFixtureTask(ctx, "@test-task-secondary");

      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        listTasks: vi.fn(async () => []),
        loadAllTasks: vi.fn(async () => [fixtureTask]),
        getTask: vi.fn(async () => undefined),
        createTask: vi.fn(async (_ctx, task) => ({
          ...task,
          _sourceFile: `/mock/${task._ulid}.yaml`,
        })),
        mutateTask: vi.fn(async (_ctx, task) => task),
        mutateTasks: vi.fn(async (_ctx, tasks) => tasks),
        deleteTask: vi.fn(async () => {}),
        rebuildIndex: vi.fn(async () => ({ count: 0 })),
        // No loadAllTasksWithHistory — fallback path
      };

      registerBackend(mockSplitBackend);
      try {
        manager = new TaskDataManager("split");

        const result = await manager.loadAllTasksWithHistory(ctx);

        expect(result).toEqual([{ task: fixtureTask, history: [] }]);
        expect(mockSplitBackend.loadAllTasks).toHaveBeenCalledOnce();
      } finally {
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });

    it("loads getTask from disk on cache detail miss and writes through to cache", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      const fixtureTask = await loadFixtureTask(ctx, "@test-task-pending");
      const setTaskDetail = vi.fn();

      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        listTasks: vi.fn(async () => []),
        loadAllTasks: vi.fn(async () => []),
        getTask: vi.fn(async () => fixtureTask),
        createTask: vi.fn(async (_ctx, task) => ({
          ...task,
          _sourceFile: `/mock/${task._ulid}.yaml`,
        })),
        mutateTask: vi.fn(async (_ctx, task) => task),
        mutateTasks: vi.fn(async (_ctx, tasks) => tasks),
        deleteTask: vi.fn(async () => {}),
        rebuildIndex: vi.fn(async () => ({ count: 0 })),
      };

      registerBackend(mockSplitBackend);
      try {
        manager = new TaskDataManager("split");

        // AC: @daemon-command-api ac-read-cache-serving
        const task = await runWithEntityCache(
          () => manager.getTask(ctx, "@test-task-pending"),
          () => ({
            getDomainState: () => "ready",
            getTaskIndex: () => [toSummary(fixtureTask)],
            getTaskDetail: () => null,
            getTaskHistory: () => [],
            setTaskDetail,
            getAllTaskDetails: () => [fixtureTask],
          }),
          tempDir,
        );

        expect(task).toEqual(fixtureTask);
        expect(mockSplitBackend.getTask).toHaveBeenCalledWith(ctx, "@test-task-pending");
        expect(setTaskDetail).toHaveBeenCalledWith(fixtureTask._ulid, fixtureTask);
      } finally {
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });

    it("falls back to disk reads when no daemon cache context exists", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      const fixtureTask = await loadFixtureTask(ctx, "@test-task-pending");

      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        listTasks: vi.fn(async () => [toSummary(fixtureTask)]),
        loadAllTasks: vi.fn(async () => [fixtureTask]),
        getTask: vi.fn(async () => fixtureTask),
        createTask: vi.fn(async (_ctx, task) => ({
          ...task,
          _sourceFile: `/mock/${task._ulid}.yaml`,
        })),
        mutateTask: vi.fn(async (_ctx, task) => task),
        mutateTasks: vi.fn(async (_ctx, tasks) => tasks),
        deleteTask: vi.fn(async () => {}),
        rebuildIndex: vi.fn(async () => ({ count: 0 })),
      };

      registerBackend(mockSplitBackend);
      try {
        manager = new TaskDataManager("split");

        // AC: @daemon-command-api ac-no-cache-outside-daemon
        const summaries = await manager.listTasks(ctx);
        expect(summaries).toEqual([toSummary(fixtureTask)]);
        expect(mockSplitBackend.listTasks).toHaveBeenCalledOnce();
      } finally {
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });

    it("falls back to disk reads when cache context exists but the tasks domain is not ready", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      const fixtureTask = await loadFixtureTask(ctx, "@test-task-pending");

      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        listTasks: vi.fn(async () => [toSummary(fixtureTask)]),
        loadAllTasks: vi.fn(async () => [fixtureTask]),
        getTask: vi.fn(async () => fixtureTask),
        createTask: vi.fn(async (_ctx, task) => ({
          ...task,
          _sourceFile: `/mock/${task._ulid}.yaml`,
        })),
        mutateTask: vi.fn(async (_ctx, task) => task),
        mutateTasks: vi.fn(async (_ctx, tasks) => tasks),
        deleteTask: vi.fn(async () => {}),
        rebuildIndex: vi.fn(async () => ({ count: 0 })),
      };

      registerBackend(mockSplitBackend);
      try {
        manager = new TaskDataManager("split");

        // AC: @daemon-command-api ac-read-cache-serving
        const result = await runWithEntityCache(
          async () => ({
            summaries: await manager.listTasks(ctx),
            allTasks: await manager.loadAllTasks(ctx),
            task: await manager.getTask(ctx, "@test-task-pending"),
          }),
          () => ({
            getDomainState: () => "loading",
            getTaskIndex: vi.fn(() => [toSummary(fixtureTask)]),
            getTaskDetail: vi.fn(() => fixtureTask),
            getTaskHistory: vi.fn(() => []),
            setTaskDetail: vi.fn(),
            getAllTaskDetails: vi.fn(() => [fixtureTask]),
          }),
          tempDir,
        );

        expect(result).toEqual({
          summaries: [toSummary(fixtureTask)],
          allTasks: [fixtureTask],
          task: fixtureTask,
        });
        expect(mockSplitBackend.listTasks).toHaveBeenCalledOnce();
        expect(mockSplitBackend.loadAllTasks).toHaveBeenCalledOnce();
        expect(mockSplitBackend.getTask).toHaveBeenCalledWith(ctx, "@test-task-pending");
      } finally {
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });

    it("keeps mutation methods on the backend write path even when cache is ready", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      const fixtureTask = await loadFixtureTask(ctx, "@test-task-pending");

      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        listTasks: vi.fn(async () => [toSummary(fixtureTask)]),
        loadAllTasks: vi.fn(async () => [fixtureTask]),
        getTask: vi.fn(async () => fixtureTask),
        createTask: vi.fn(async (_ctx, task) => ({
          ...task,
          _sourceFile: `/mock/${task._ulid}.yaml`,
        })),
        mutateTask: vi.fn(async (_ctx, task, mutate) => mutate(task) as Promise<any>),
        mutateTasks: vi.fn(async (_ctx, tasks) => tasks),
        deleteTask: vi.fn(async () => {}),
        rebuildIndex: vi.fn(async () => ({ count: 0 })),
      };

      registerBackend(mockSplitBackend);
      try {
        manager = new TaskDataManager("split");

        await runWithEntityCache(
          () =>
            manager.mutateTask(ctx, "@test-task-pending", (task) => ({
              ...task,
              priority: 1,
            })),
          () => ({
            getDomainState: () => "ready",
            getTaskIndex: () => [toSummary(fixtureTask)],
            getTaskDetail: () => fixtureTask,
            getTaskHistory: () => [],
            setTaskDetail: vi.fn(),
            getAllTaskDetails: () => [fixtureTask],
          }),
          tempDir,
        );

        expect(mockSplitBackend.mutateTask).toHaveBeenCalledOnce();
      } finally {
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });

    // AC: @daemon-entity-cache ac-task-history-retention
    it("serves getTaskHistory from the ready task cache without backend reads", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      const fixtureTask = await loadFixtureTask(ctx, "@test-task-pending");
      const cachedHistory = [
        {
          timestamp: "2026-03-20T00:00:00.000Z",
          author: "@tester",
          command: "task-start",
          changes: {
            status: {
              previous: "pending",
              new: "in_progress",
            },
          },
        },
      ];

      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        listTasks: vi.fn(async () => []),
        loadAllTasks: vi.fn(async () => []),
        getTask: vi.fn(async () => fixtureTask),
        createTask: vi.fn(async (_ctx, task) => ({
          ...task,
          _sourceFile: `/mock/${task._ulid}.yaml`,
        })),
        mutateTask: vi.fn(async (_ctx, task) => task),
        mutateTasks: vi.fn(async (_ctx, tasks) => tasks),
        deleteTask: vi.fn(async () => {}),
        rebuildIndex: vi.fn(async () => ({ count: 0 })),
        getTaskHistory: vi.fn(async () => []),
      };

      registerBackend(mockSplitBackend);
      try {
        manager = new TaskDataManager("split");

        const result = await runWithEntityCache(
          () => manager.getTaskHistory(ctx, fixtureTask._ulid),
          () => ({
            getDomainState: () => "ready",
            getTaskIndex: () => [toSummary(fixtureTask)],
            getTaskDetail: () => fixtureTask,
            getTaskHistory: () => cachedHistory,
            setTaskDetail: vi.fn(),
            getAllTaskDetails: () => [fixtureTask],
          }),
          tempDir,
        );

        expect(result).toEqual(cachedHistory);
        expect(mockSplitBackend.getTaskHistory).not.toHaveBeenCalled();
      } finally {
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });

    it("falls back to backend getTaskHistory when the task cache is not ready", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      const fixtureTask = await loadFixtureTask(ctx, "@test-task-pending");
      const diskHistory = [
        {
          timestamp: "2026-03-20T00:05:00.000Z",
          author: "@tester",
          command: "task-submit",
          changes: {
            status: {
              previous: "in_progress",
              new: "pending_review",
            },
          },
        },
      ];

      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        listTasks: vi.fn(async () => [toSummary(fixtureTask)]),
        loadAllTasks: vi.fn(async () => [fixtureTask]),
        getTask: vi.fn(async () => fixtureTask),
        createTask: vi.fn(async (_ctx, task) => ({
          ...task,
          _sourceFile: `/mock/${task._ulid}.yaml`,
        })),
        mutateTask: vi.fn(async (_ctx, task) => task),
        mutateTasks: vi.fn(async (_ctx, tasks) => tasks),
        deleteTask: vi.fn(async () => {}),
        rebuildIndex: vi.fn(async () => ({ count: 0 })),
        getTaskHistory: vi.fn(async () => diskHistory),
      };

      registerBackend(mockSplitBackend);
      try {
        manager = new TaskDataManager("split");

        const result = await runWithEntityCache(
          () => manager.getTaskHistory(ctx, fixtureTask._ulid),
          () => ({
            getDomainState: () => "loading",
            getTaskIndex: vi.fn(() => [toSummary(fixtureTask)]),
            getTaskDetail: vi.fn(() => fixtureTask),
            getTaskHistory: vi.fn(() => []),
            setTaskDetail: vi.fn(),
            getAllTaskDetails: vi.fn(() => [fixtureTask]),
          }),
          tempDir,
        );

        expect(result).toEqual(diskHistory);
        expect(mockSplitBackend.getTaskHistory).toHaveBeenCalledWith(ctx, fixtureTask._ulid);
      } finally {
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });

    it("calls applyTaskMutation on the cache after mutateTask completes", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      const fixtureTask = await loadFixtureTask(ctx, "@test-task-pending");
      const applyTaskMutation = vi.fn();

      const mutatedTask = {
        ...fixtureTask,
        status: "in_progress" as const,
      };

      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        listTasks: vi.fn(async () => [toSummary(fixtureTask)]),
        loadAllTasks: vi.fn(async () => [fixtureTask]),
        getTask: vi.fn(async () => fixtureTask),
        createTask: vi.fn(async (_ctx, task) => ({
          ...task,
          _sourceFile: `/mock/${task._ulid}.yaml`,
        })),
        mutateTask: vi.fn(async (_ctx, _task, mutate) => {
          const result = await mutate(fixtureTask);
          return { ...result, _sourceFile: fixtureTask._sourceFile };
        }),
        mutateTasks: vi.fn(async (_ctx, tasks) => tasks),
        deleteTask: vi.fn(async () => {}),
        rebuildIndex: vi.fn(async () => ({ count: 0 })),
      };

      registerBackend(mockSplitBackend);
      try {
        manager = new TaskDataManager("split");

        await runWithEntityCache(
          () => manager.mutateTask(ctx, fixtureTask._ulid, () => mutatedTask),
          () => ({
            getDomainState: () => "ready",
            getTaskIndex: () => [toSummary(fixtureTask)],
            getTaskDetail: () => fixtureTask,
            getTaskHistory: () => [],
            setTaskDetail: vi.fn(),
            getAllTaskDetails: () => [fixtureTask],
            applyTaskMutation,
          }),
          tempDir,
        );

        expect(applyTaskMutation).toHaveBeenCalledOnce();
        expect(applyTaskMutation).toHaveBeenCalledWith(
          fixtureTask._ulid,
          expect.objectContaining({ status: "in_progress" }),
        );
      } finally {
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });

    it("does not call applyTaskMutation when no cache context exists", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      const fixtureTask = await loadFixtureTask(ctx, "@test-task-pending");

      // Without runWithEntityCache, no cache context exists
      const result = await manager.mutateTask(ctx, fixtureTask._ulid, (task) => ({
        ...task,
        priority: 1,
      }));

      // Should succeed without errors — no cache to update
      expect(result.priority).toBe(1);
    });

    it("calls applyTaskMutation for each task in mutateTasks", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      const task1 = await loadFixtureTask(ctx, "@test-task-pending");
      const task2 = await loadFixtureTask(ctx, "@test-task-secondary");
      const applyTaskMutation = vi.fn();

      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        listTasks: vi.fn(async () => [toSummary(task1), toSummary(task2)]),
        loadAllTasks: vi.fn(async () => [task1, task2]),
        getTask: vi.fn(async (_ctx, ref) => (ref === task1._ulid ? task1 : task2)),
        createTask: vi.fn(async (_ctx, task) => ({
          ...task,
          _sourceFile: `/mock/${task._ulid}.yaml`,
        })),
        mutateTask: vi.fn(async (_ctx, task) => task),
        mutateTasks: vi.fn(async (_ctx, tasks, mutate) => {
          const results = await mutate(tasks);
          return results.map((r, i) => ({
            ...r,
            _sourceFile: tasks[i]._sourceFile,
          }));
        }),
        deleteTask: vi.fn(async () => {}),
        rebuildIndex: vi.fn(async () => ({ count: 0 })),
      };

      registerBackend(mockSplitBackend);
      try {
        manager = new TaskDataManager("split");

        await runWithEntityCache(
          () =>
            manager.mutateTasks(ctx, [task1._ulid, task2._ulid], (tasks) =>
              tasks.map((t) => ({ ...t, priority: 1 })),
            ),
          () => ({
            getDomainState: () => "ready",
            getTaskIndex: () => [toSummary(task1), toSummary(task2)],
            getTaskDetail: (ulid: string) => (ulid === task1._ulid ? task1 : task2),
            getTaskHistory: () => [],
            setTaskDetail: vi.fn(),
            getAllTaskDetails: () => [task1, task2],
            applyTaskMutation,
          }),
          tempDir,
        );

        expect(applyTaskMutation).toHaveBeenCalledTimes(2);
      } finally {
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });

    it("calls applyTaskMutation after createTask completes", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      const applyTaskMutation = vi.fn();

      const result = await runWithEntityCache(
        () =>
          manager.createTask(ctx, {
            title: "New Task",
            type: "task",
          }),
        () => ({
          getDomainState: () => "ready",
          getTaskIndex: () => [],
          getTaskDetail: () => null,
          getTaskHistory: () => [],
          setTaskDetail: vi.fn(),
          getAllTaskDetails: () => [],
          applyTaskMutation,
        }),
        tempDir,
      );

      expect(result._ulid).toBeDefined();
      expect(applyTaskMutation).toHaveBeenCalledOnce();
      expect(applyTaskMutation).toHaveBeenCalledWith(
        result._ulid,
        expect.objectContaining({ title: "New Task" }),
      );
    });
  });

  // AC: @task-data-manager ac-4
  // All affected files, locking, and shadow branch commits are handled
  // by the manager as a single coordinated operation
  describe("coordinated mutations (ac-4)", () => {
    it("creates a task with file write and returns it", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const task = await manager.createTask(ctx, {
        title: "New coordinated task",
        slugs: ["coord-task"],
        priority: 2,
        tags: ["feature"],
      });

      expect(task._ulid).toBeDefined();
      expect(task.title).toBe("New coordinated task");
      expect(task.status).toBe("pending");

      // Verify persisted to disk
      const reloaded = await manager.getTask(ctx, "@coord-task");
      expect(reloaded._ulid).toBe(task._ulid);
    });

    it("mutates a task atomically", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const updated = await manager.mutateTask(ctx, "@test-task-pending", (task) => ({
        ...task,
        status: "in_progress" as const,
        started_at: "2026-03-20T00:00:00.000Z",
      }));

      expect(updated.status).toBe("in_progress");
      expect(updated.started_at).toBe("2026-03-20T00:00:00.000Z");

      // Verify persisted
      const reloaded = await manager.getTask(ctx, "@test-task-pending");
      expect(reloaded.status).toBe("in_progress");
    });

    it("deletes a task from storage", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Create a task then delete it
      await manager.createTask(ctx, {
        title: "Task to delete",
        slugs: ["to-delete"],
      });

      // Confirm it exists
      const existing = await manager.getTask(ctx, "@to-delete");
      expect(existing).toBeDefined();

      // Delete it
      await manager.deleteTask(ctx, "@to-delete");

      // Confirm it's gone
      await expect(manager.getTask(ctx, "@to-delete")).rejects.toThrow(TaskDataManagerError);
    });
  });

  // AC: @task-data-manager ac-5
  // Non-overlapping mutations proceed without contention
  describe("non-overlapping mutations (ac-5)", () => {
    it("allows concurrent mutations on different tasks", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Mutate two different tasks concurrently (same file, different tasks)
      const [task1, task2] = await Promise.all([
        manager.mutateTask(ctx, "@test-task-pending", async (task) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { ...task, priority: 1 };
        }),
        manager.mutateTask(ctx, "@test-task-secondary", (task) => ({
          ...task,
          priority: 5,
        })),
      ]);

      // Both mutations should succeed
      expect(task1.priority).toBe(1);
      expect(task2.priority).toBe(5);

      // Verify persistence
      const reloaded1 = await manager.getTask(ctx, "@test-task-pending");
      const reloaded2 = await manager.getTask(ctx, "@test-task-secondary");
      expect(reloaded1.priority).toBe(1);
      expect(reloaded2.priority).toBe(5);
    });

    it("runs non-overlapping mutation callbacks concurrently, not serially", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const DELAY_MS = 100;
      const timestamps: {
        task1Start: number;
        task1End: number;
        task2Start: number;
        task2End: number;
      } = {
        task1Start: 0,
        task1End: 0,
        task2Start: 0,
        task2End: 0,
      };

      // Both mutations have a significant delay in their callback.
      // With per-task locking, they should overlap (run concurrently).
      // With file-level locking, they would serialize (total time ≈ 2×DELAY_MS).
      await Promise.all([
        manager.mutateTask(ctx, "@test-task-pending", async (task) => {
          timestamps.task1Start = Date.now();
          await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
          timestamps.task1End = Date.now();
          return { ...task, priority: 1 };
        }),
        manager.mutateTask(ctx, "@test-task-secondary", async (task) => {
          timestamps.task2Start = Date.now();
          await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
          timestamps.task2End = Date.now();
          return { ...task, priority: 5 };
        }),
      ]);

      // If callbacks run concurrently, their execution windows overlap:
      // task1's callback starts before task2's callback ends, and vice versa.
      // With serial execution, one would start after the other finishes.
      const overlap =
        timestamps.task1Start < timestamps.task2End && timestamps.task2Start < timestamps.task1End;
      expect(overlap).toBe(true);

      // Verify both mutations persisted correctly
      const reloaded1 = await manager.getTask(ctx, "@test-task-pending");
      const reloaded2 = await manager.getTask(ctx, "@test-task-secondary");
      expect(reloaded1.priority).toBe(1);
      expect(reloaded2.priority).toBe(5);
    });
  });

  // AC: @task-data-manager ac-6
  // All writes happen within a single atomic operation that either
  // all succeed or all roll back
  describe("atomic operations (ac-6)", () => {
    it("batch mutation writes all changes atomically", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const refs = ["@test-task-pending", "@test-task-secondary"];
      const updated = await manager.mutateTasks(ctx, refs, (tasks) =>
        tasks.map((task) => ({ ...task, priority: 1 })),
      );

      expect(updated.length).toBe(2);
      expect(updated.every((t) => t.priority === 1)).toBe(true);

      // Verify both persisted
      const reloaded = await manager.listTasks(ctx);
      const pending = reloaded.find((t) => t.slugs.includes("test-task-pending"));
      const secondary = reloaded.find((t) => t.slugs.includes("test-task-secondary"));
      expect(pending?.priority).toBe(1);
      expect(secondary?.priority).toBe(1);
    });

    it("addNote is atomic — note appears on reload", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const { task, note } = await manager.addNote(
        ctx,
        "@test-task-pending",
        "First note via manager",
        "@test-author",
      );

      expect(task.notes.length).toBeGreaterThan(0);
      expect(note.content).toBe("First note via manager");
      expect(note.author).toBe("@test-author");

      // Verify persisted
      const reloaded = await manager.getTask(ctx, "@test-task-pending");
      expect(reloaded.notes.some((n) => n.content === "First note via manager")).toBe(true);
    });
  });

  // Split format is the only supported format
  describe("split format by default", () => {
    it("defaults to split format when no format specified", () => {
      const defaultManager = new TaskDataManager();
      expect(defaultManager.storageFormat).toBe("split");
    });

    it("reads from tasks file via resolved manager", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const tasks = await manager.listTasks(ctx);
      expect(tasks.length).toBe(4);

      // TaskSummary does not expose _sourceFile — callers should not know
      // about the underlying storage format (AC-1)
      for (const t of tasks) {
        expect(t).not.toHaveProperty("_sourceFile");
      }
    });

    it("writes through resolved manager", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const created = await manager.createTask(ctx, {
        title: "Manager write test",
        slugs: ["mgr-write"],
      });

      // Should have a valid _sourceFile from the storage backend
      expect(created._sourceFile).toBeDefined();

      // Reload from manager to verify it's persisted
      const found = await manager.getTask(ctx, "@mgr-write");
      expect(found).toBeDefined();
      expect(found._sourceFile).toBe(created._sourceFile);
    });
  });

  // AC: @task-data-manager ac-8
  // Split format used when explicitly activated
  describe("split format activation (ac-8)", () => {
    it("succeeds at construction when split backend is registered", () => {
      // The split backend is registered via src/parser/split-backend.ts
      // AC: @task-data-manager ac-8 — split format used when activated
      const splitManager = new TaskDataManager("split");
      expect(splitManager.storageFormat).toBe("split");
    });

    it("throws at construction for an unknown backend format", () => {
      // AC: @trait-error-guidance ac-1, ac-2
      try {
        const _unused = new TaskDataManager("nonexistent" as any);
        expect.fail("Should have thrown for unregistered backend");
      } catch (err) {
        expect(err).toBeInstanceOf(TaskDataManagerError);
        const tdmErr = err as TaskDataManagerError;
        expect(tdmErr.message).toContain("No storage backend registered");
        expect(tdmErr.suggestion).toContain("registerBackend");
        expect(tdmErr.field).toBe("storageFormat");
      }
    });

    // AC: @task-storage-activation ac-2 — split format used for all operations when activated
    it("routes all reads and writes to registered split backend", async () => {
      tempDir = await setupTempFixtures();

      // Register a mock split backend to verify routing for ALL operation types
      const calls: string[] = [];
      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        async listTasks(ctx) {
          calls.push("listTasks");
          // Return TaskSummary[] — only index-level fields
          const { loadAllTasks: load } = await import("../src/parser/yaml.js");
          const tasks = await load(ctx);
          return tasks.map((t) => ({
            _ulid: t._ulid,
            slugs: t.slugs,
            title: t.title,
            type: t.type,
            status: t.status,
            priority: t.priority,
            tags: t.tags,
            assignee: t.assignee,
            automation: t.automation,
            spec_ref: t.spec_ref,
            depends_on: t.depends_on,
            blocked_by: t.blocked_by,
            created_at: t.created_at,
            started_at: t.started_at,
            submitted_at: t.submitted_at,
            completed_at: t.completed_at,
            notes_count: t.notes?.length ?? 0,
            todos_count: t.todos?.length ?? 0,
          }));
        },
        async getTask(ctx, ref) {
          calls.push("getTask");
          const { loadAllTasks: load, findTaskByRef: find } = await import("../src/parser/yaml.js");
          const tasks = await load(ctx);
          return find(tasks, ref);
        },
        async createTask(_ctx, task) {
          calls.push("createTask");
          return { ...task, _sourceFile: `/mock/split/tasks/${task._ulid}/task.yaml` };
        },
        async mutateTask(ctx, task, mutate) {
          calls.push("mutateTask");
          return splitBackend.mutateTask(ctx, task, mutate);
        },
        async mutateTasks(ctx, tasks, mutate) {
          calls.push("mutateTasks");
          return splitBackend.mutateTasks(ctx, tasks, mutate);
        },
        async deleteTask() {
          calls.push("deleteTask");
        },
      };

      registerBackend(mockSplitBackend);
      try {
        const splitManager = new TaskDataManager("split");
        expect(splitManager.storageFormat).toBe("split");

        const ctx = await initContext(tempDir);

        // Read paths should route through the split backend
        await splitManager.listTasks(ctx);
        expect(calls).toContain("listTasks");

        await splitManager.getTask(ctx, "@test-task-pending");
        expect(calls).toContain("getTask");

        // Write paths should also route through the split backend
        await splitManager.createTask(ctx, {
          title: "Activation write test",
          slugs: ["activation-write"],
        });
        expect(calls).toContain("createTask");

        await splitManager.mutateTask(ctx, "@test-task-pending", (task) => ({
          ...task,
          priority: 1,
        }));
        expect(calls).toContain("mutateTask");

        await splitManager.deleteTask(ctx, "@test-task-pending");
        expect(calls).toContain("deleteTask");

        // Verify ALL operation types were routed to the split backend
        expect(calls).toEqual(
          expect.arrayContaining([
            "listTasks",
            "getTask",
            "createTask",
            "mutateTask",
            "deleteTask",
          ]),
        );
      } finally {
        // Clean up: remove mock and restore real split backend
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });

    // AC: @task-data-manager ac-1 — callers don't know about storage format
    // AC: @task-data-manager ac-8 — split backend owns _sourceFile on create
    it("createTask returns _sourceFile from the backend, not a default path", async () => {
      tempDir = await setupTempFixtures();

      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        async listTasks() {
          return [];
        },
        async getTask() {
          return undefined;
        },
        async createTask(_ctx, task) {
          // Split backend assigns its own _sourceFile
          return { ...task, _sourceFile: `/split/tasks/${task._ulid}/task.yaml` };
        },
        async mutateTask(_ctx, task) {
          return { ...task, _sourceFile: task._sourceFile };
        },
        async mutateTasks(_ctx, tasks) {
          return tasks;
        },
        async deleteTask() {},
      };

      registerBackend(mockSplitBackend);
      try {
        const splitManager = new TaskDataManager("split");
        const ctx = await initContext(tempDir);

        const created = await splitManager.createTask(ctx, { title: "Split-owned task" });

        // The returned task should have the split backend's _sourceFile,
        // not a default project.tasks.yaml path
        expect(created._sourceFile).toContain("/split/tasks/");
        expect(created._sourceFile).toContain("/task.yaml");
        expect(created._sourceFile).not.toContain("project.tasks.yaml");
      } finally {
        // Clean up: remove mock and restore real split backend
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });

    it("exposes storageFormat property for inspection", () => {
      const defaultManager = new TaskDataManager();
      expect(defaultManager.storageFormat).toBe("split");

      // Split backend is registered and succeeds at construction
      const splitManager = new TaskDataManager("split");
      expect(splitManager.storageFormat).toBe("split");
    });
  });

  // AC: @task-data-manager ac-9
  // Concurrent same-task mutations serialize via lock
  describe("same-task mutation serialization (ac-9)", () => {
    it("serializes concurrent mutations on the same task", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Two concurrent mutations on the same task
      const [result1, result2] = await Promise.all([
        manager.mutateTask(ctx, "@test-task-pending", async (task) => {
          // Add delay so both mutations overlap
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            ...task,
            status: "in_progress" as const,
            started_at: "2026-03-20T00:00:00.000Z",
          };
        }),
        manager.mutateTask(ctx, "@test-task-pending", (task) => ({
          ...task,
          notes: [
            ...task.notes,
            {
              _ulid: testUlid("N0TE", 1),
              created_at: "2026-03-20T00:01:00.000Z",
              author: "@test",
              content: "Concurrent note",
            },
          ],
        })),
      ]);

      // Both mutations should have completed
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();

      // Reload and verify both changes are present
      const reloaded = await manager.getTask(ctx, "@test-task-pending");
      expect(reloaded.status).toBe("in_progress");
      expect(reloaded.notes.some((n) => n.content === "Concurrent note")).toBe(true);
    });

    it("serializes overlapping mutateTask and mutateTasks on the same task", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Run mutateTask on @test-task-pending in parallel with mutateTasks
      // targeting [@test-task-pending, @test-task-secondary]. If mutateTasks
      // doesn't acquire per-task locks, the single-task mutation can overwrite
      // the batch update or vice versa, losing one set of changes.
      const [singleResult, batchResult] = await Promise.all([
        manager.mutateTask(ctx, "@test-task-pending", async (task) => {
          // Add delay so both mutations overlap
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { ...task, priority: 1 as const };
        }),
        manager.mutateTasks(ctx, ["@test-task-pending", "@test-task-secondary"], (tasks) =>
          tasks.map((task) => ({
            ...task,
            tags: [...task.tags, "batch-tagged"],
          })),
        ),
      ]);

      expect(singleResult).toBeDefined();
      expect(batchResult.length).toBe(2);

      // Reload and verify both mutations took effect on the shared task
      const reloaded = await manager.getTask(ctx, "@test-task-pending");
      // Exactly one of these operations ran last. Since they serialize,
      // the task must reflect the priority from mutateTask AND the tag
      // from mutateTasks — both changes must be present.
      expect(reloaded.priority).toBe(1);
      expect(reloaded.tags).toContain("batch-tagged");

      // The secondary task should also have the batch tag
      const secondary = await manager.getTask(ctx, "@test-task-secondary");
      expect(secondary.tags).toContain("batch-tagged");
    });

    it("serializes three concurrent mutations on the same task (FIFO queue)", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Track the order in which mutations enter and exit the critical section.
      // With a proper FIFO queue, each mutation runs exclusively — no two
      // mutations should overlap in time.
      const executionLog: Array<{ writer: number; phase: "enter" | "exit" }> = [];

      const mutate = (writer: number, tag: string) =>
        manager.mutateTask(ctx, "@test-task-pending", async (task) => {
          executionLog.push({ writer, phase: "enter" });
          // Delay long enough that a broken mutex would let others in
          await new Promise((resolve) => setTimeout(resolve, 30));
          executionLog.push({ writer, phase: "exit" });
          return { ...task, tags: [...task.tags, tag] };
        });

      // Launch all three mutations concurrently
      const [r1, r2, r3] = await Promise.all([
        mutate(1, "writer-1"),
        mutate(2, "writer-2"),
        mutate(3, "writer-3"),
      ]);

      expect(r1).toBeDefined();
      expect(r2).toBeDefined();
      expect(r3).toBeDefined();

      // Verify strict serialization: each "enter" must follow the previous "exit".
      // With a broken mutex, two enters would appear consecutively.
      for (let i = 1; i < executionLog.length; i++) {
        const prev = executionLog[i - 1];
        const curr = executionLog[i];
        if (curr.phase === "enter") {
          expect(prev.phase).toBe("exit");
        }
      }

      // Reload and verify all three writers' tags are present (no lost updates)
      const reloaded = await manager.getTask(ctx, "@test-task-pending");
      expect(reloaded.tags).toContain("writer-1");
      expect(reloaded.tags).toContain("writer-2");
      expect(reloaded.tags).toContain("writer-3");
    });

    // AC: @task-data-manager ac-10
    it("serializes concurrent deleteTask and mutateTask on the same task", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Create a task that we'll race delete + mutate on
      const target = await manager.createTask(ctx, {
        title: "Race target",
        slugs: ["race-target"],
        tags: ["original"],
      });
      expect(target._ulid).toBeDefined();

      // Run deleteTask and mutateTask concurrently on the same task.
      // Without per-task locking in deleteTask, the mutate can read the
      // task, then delete removes it, then the mutate's write phase fails
      // with "Task not found in file during write phase" — violating AC-10.
      // With the per-task lock, one operation completes before the other
      // starts, so we get either:
      //   (a) delete first → mutate throws TaskDataManagerError("Task not found")
      //   (b) mutate first → delete succeeds afterward
      // Both are valid as long as no "mid-flight" corruption occurs.
      const results = await Promise.allSettled([
        manager.deleteTask(ctx, "@race-target"),
        manager.mutateTask(ctx, "@race-target", async (task) => {
          // Delay to widen the race window
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { ...task, tags: [...task.tags, "mutated"] };
        }),
      ]);

      // Count successes and failures
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // At least one operation should succeed. If both succeed, the
      // mutate ran first and then the delete followed. If one fails, the
      // failure should be TaskDataManagerError (clean "not found"), not
      // an internal "Task not found in file during write phase" error
      // from the storage backend.
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      for (const r of rejected) {
        if (r.status === "rejected") {
          expect(r.reason).toBeInstanceOf(TaskDataManagerError);
          expect(r.reason.message).toContain("Task not found");
        }
      }

      // Regardless of order, the task should be gone after delete ran
      await expect(manager.getTask(ctx, "@race-target")).rejects.toThrow(TaskDataManagerError);
    });
  });

  // Mutation output validation — prevents storage corruption from invalid callback output
  describe("mutation output validation", () => {
    it("rejects mutation that produces invalid task (missing title)", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      await expect(
        manager.mutateTask(ctx, "@test-task-pending", (task) => {
          // Return task with empty title — violates schema min(1) constraint
          return { ...task, title: "" };
        }),
      ).rejects.toThrow(TaskDataManagerError);

      try {
        await manager.mutateTask(ctx, "@test-task-pending", (task) => ({
          ...task,
          title: "",
        }));
      } catch (err) {
        const tdmErr = err as TaskDataManagerError;
        expect(tdmErr.message).toContain("Mutation produced invalid task data");
        expect(tdmErr.suggestion).toContain("mutation callback");
      }
    });

    it("rejects mutation that produces invalid priority", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      await expect(
        manager.mutateTask(ctx, "@test-task-pending", (task) => ({
          ...task,
          priority: 99, // out of range (1-5)
        })),
      ).rejects.toThrow(TaskDataManagerError);
    });

    it("does not persist invalid mutation output", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Get the task's original title
      const original = await manager.getTask(ctx, "@test-task-pending");
      const originalTitle = original.title;

      // Attempt an invalid mutation
      try {
        await manager.mutateTask(ctx, "@test-task-pending", (task) => ({
          ...task,
          title: "", // invalid
        }));
      } catch {
        // Expected to fail
      }

      // Verify the original task is unchanged on disk
      const reloaded = await manager.getTask(ctx, "@test-task-pending");
      expect(reloaded.title).toBe(originalTitle);
    });

    it("rejects invalid output in batch mutations", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      await expect(
        manager.mutateTasks(ctx, ["@test-task-pending", "@test-task-secondary"], (tasks) =>
          tasks.map(
            (task, i) => (i === 0 ? { ...task, title: "" } : task), // first task invalid
          ),
        ),
      ).rejects.toThrow(TaskDataManagerError);
    });

    it("accepts valid mutation output", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Valid mutation should succeed
      const updated = await manager.mutateTask(ctx, "@test-task-pending", (task) => ({
        ...task,
        tags: [...task.tags, "validated"],
      }));

      expect(updated.tags).toContain("validated");

      // Verify persisted
      const reloaded = await manager.getTask(ctx, "@test-task-pending");
      expect(reloaded.tags).toContain("validated");
    });
  });

  // AC: @trait-error-guidance ac-1 — error includes description
  // AC: @trait-error-guidance ac-2 — error includes suggested action
  describe("error guidance (trait-error-guidance)", () => {
    // AC: @trait-error-guidance ac-1
    it("error includes description of what went wrong", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      try {
        await manager.getTask(ctx, "@does-not-exist");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TaskDataManagerError);
        expect((err as TaskDataManagerError).message).toContain("Task not found");
      }
    });

    // AC: @trait-error-guidance ac-2
    it("error includes suggested action to resolve", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      try {
        await manager.getTask(ctx, "@does-not-exist");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TaskDataManagerError);
        expect((err as TaskDataManagerError).suggestion).toBeDefined();
        expect((err as TaskDataManagerError).suggestion).toContain("kspec search");
      }
    });

    // AC: @trait-error-guidance ac-3
    it("not-found error suggests checking ref with search or list", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      try {
        await manager.getTask(ctx, "@nonexistent");
        expect.fail("Should have thrown");
      } catch (err) {
        const tdmErr = err as TaskDataManagerError;
        expect(tdmErr.suggestion).toMatch(/kspec search|kspec.*list/);
      }
    });

    // AC: @trait-error-guidance ac-5
    it("validation error indicates which field/value failed", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      try {
        // @ts-expect-error — deliberately invalid input (missing required title)
        await manager.createTask(ctx, { title: "" });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TaskDataManagerError);
        expect((err as TaskDataManagerError).message).toContain("Failed to create task");
      }
    });
  });

  // AC: @trait-error-guidance ac-4 — N/A: TaskDataManager does not perform state transitions directly;
  // state transition validation happens in CLI commands that use the manager.

  // AC: @trait-error-guidance ac-6 — N/A: TaskDataManager is a library module, not a CLI command.
  // It does not have --json mode. JSON mode error guidance is handled by CLI commands that consume
  // the TaskDataManagerError.

  describe("addNote convenience method", () => {
    it("appends note with auto-generated ULID and timestamp", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const { note } = await manager.addNote(
        ctx,
        "@test-task-pending",
        "Auto-generated note test",
        "@tester",
      );

      expect(note._ulid).toBeDefined();
      expect(note._ulid.length).toBe(26);
      expect(note.created_at).toBeDefined();
      expect(note.content).toBe("Auto-generated note test");
    });

    it("uses provided author", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const { note } = await manager.addNote(
        ctx,
        "@test-task-pending",
        "Author test",
        "@custom-author",
      );

      expect(note.author).toBe("@custom-author");
    });
  });

  // Fix cycle 8 — blocker 1: ULID immutability enforcement
  describe("ULID immutability in mutations", () => {
    it("rejects mutateTask callback that changes the task ULID", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      await expect(
        manager.mutateTask(ctx, "@test-task-pending", (task) => ({
          ...task,
          _ulid: testUlid("FAKE"),
        })),
      ).rejects.toThrow(TaskDataManagerError);

      try {
        await manager.mutateTask(ctx, "@test-task-pending", (task) => ({
          ...task,
          _ulid: testUlid("FAKE"),
        }));
      } catch (err) {
        const tdmErr = err as TaskDataManagerError;
        expect(tdmErr.message).toContain("must not change");
        expect(tdmErr.message).toContain("ULID");
        expect(tdmErr.field).toBe("_ulid");
      }
    });

    it("does not persist ULID change to disk", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      const original = await manager.getTask(ctx, "@test-task-pending");
      const originalUlid = original._ulid;

      try {
        await manager.mutateTask(ctx, "@test-task-pending", (task) => ({
          ...task,
          _ulid: testUlid("FAKE"),
        }));
      } catch {
        // Expected to fail
      }

      // ULID should be unchanged on disk
      const reloaded = await manager.getTask(ctx, "@test-task-pending");
      expect(reloaded._ulid).toBe(originalUlid);
    });

    it("rejects ULID change in batch mutations", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      await expect(
        manager.mutateTasks(ctx, ["@test-task-pending", "@test-task-secondary"], (tasks) =>
          tasks.map((task, i) => (i === 0 ? { ...task, _ulid: testUlid("FAKE") } : task)),
        ),
      ).rejects.toThrow(TaskDataManagerError);
    });
  });

  // Fix cycle 8 — blocker 2: preserve unknown raw fields through mutations
  describe("unknown raw field preservation", () => {
    it("preserves unknown fields through addNote mutation", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Inject a custom field into the per-task YAML file (split format)
      const taskFile = path.join(ctx.specDir, "tasks", "01KF1645CA45ZT43W2T6HJMVA1", "task.yaml");
      const content = await readTestOutput(taskFile);
      const lines = content.split("\n");
      const ulidLineIdx = lines.findIndex((l) => l.includes("01KF1645CA45ZT43W2T6HJMVA1"));
      expect(ulidLineIdx).toBeGreaterThan(-1);
      lines.splice(ulidLineIdx + 1, 0, "custom_backend_field: preserved-value");
      await fs.writeFile(taskFile, lines.join("\n"));

      // Mutate via addNote (should not strip the custom field)
      await manager.addNote(ctx, "@test-task-pending", "Note after custom field", "@tester");

      // Re-read raw file to verify custom field survived
      const afterContent = await readTestOutput(taskFile);
      expect(afterContent).toContain("custom_backend_field: preserved-value");
    });

    // AC: @task-core-data-file ac-4
    it("preserves unknown fields through mutateTask", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Inject a custom field into the per-task YAML file (split format)
      const taskFile = path.join(ctx.specDir, "tasks", "01KF1645CA45ZT43W2T6HJMVA1", "task.yaml");
      const content = await readTestOutput(taskFile);
      const lines = content.split("\n");
      const ulidLineIdx = lines.findIndex((l) => l.includes("01KF1645CA45ZT43W2T6HJMVA1"));
      expect(ulidLineIdx).toBeGreaterThan(-1);
      lines.splice(ulidLineIdx + 1, 0, "backend_metadata: keep-me");
      await fs.writeFile(taskFile, lines.join("\n"));

      // Mutate via mutateTask
      await manager.mutateTask(ctx, "@test-task-pending", (task) => ({
        ...task,
        priority: 1,
      }));

      // Re-read raw file to verify custom field survived
      const afterContent = await readTestOutput(taskFile);
      expect(afterContent).toContain("backend_metadata: keep-me");
    });
  });

  // Single task added via split format — reads and mutates
  describe("single-task added to split format", () => {
    it("reads and mutates a task added to split format", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Add a task via the split-format helper (per-task dir + lean index entry)
      const { seedSplitTask: seed } = await import("./helpers/cli.js");
      const singleUlid = testUlid("SNGL");
      seed(tempDir, {
        _ulid: singleUlid,
        slugs: ["single-task"],
        title: "Single task",
        type: "task",
        status: "pending",
        priority: 3,
        tags: [],
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-03-20T00:00:00.000Z",
      });

      // getTask should find it
      const task = await manager.getTask(ctx, "@single-task");
      expect(task._ulid).toBe(singleUlid);
      expect(task.title).toBe("Single task");

      // addNote should succeed (the mutation write path handles split format)
      await manager.addNote(ctx, "@single-task", "Note on single-task file", "@tester");

      // Verify persisted
      const reloaded = await manager.getTask(ctx, "@single-task");
      expect(reloaded.notes.some((n) => n.content === "Note on single-task file")).toBe(true);
    });
  });

  // Fix cycle 8 — blocker 4: deleteTask without _sourceFile
  describe("deleteTask without _sourceFile (split backend)", () => {
    it("routes delete to backend even when _sourceFile is absent", async () => {
      tempDir = await setupTempFixtures();

      let deleteCalled = false;
      const mockSplitBackend: TaskStorageBackend = {
        format: "split",
        async listTasks() {
          return [];
        },
        async getTask(_ctx, ref) {
          // Return a task without _sourceFile to simulate split backend
          const { loadAllTasks: load, findTaskByRef: find } = await import("../src/parser/yaml.js");
          const tasks = await load(_ctx);
          const found = find(tasks, ref);
          if (found) {
            // Strip _sourceFile to simulate split backend behavior
            const { _sourceFile: _, ...noSource } = found;
            return noSource as typeof found;
          }
          return undefined;
        },
        async createTask(_ctx, task) {
          return { ...task, _sourceFile: `/split/${task._ulid}/task.yaml` };
        },
        async mutateTask(_ctx, task) {
          return task;
        },
        async mutateTasks(_ctx, tasks) {
          return tasks;
        },
        async deleteTask() {
          deleteCalled = true;
        },
      };

      registerBackend(mockSplitBackend);
      try {
        const splitManager = new TaskDataManager("split");
        const ctx = await initContext(tempDir);

        // Delete should route to the backend's deleteTask without
        // pre-checking _sourceFile
        await splitManager.deleteTask(ctx, "@test-task-pending");
        expect(deleteCalled).toBe(true);
      } finally {
        // Clean up: remove mock and restore real split backend
        unregisterBackend("split");
        registerBackend(splitBackend);
      }
    });
  });

  // ── Folder-Backed Trait Baseline ─────────────────────────────────────────
  //
  // The task data manager has been shipping the trait-folder-backed-entity-1
  // consistency contract for some time: every mutator path (createTask,
  // mutateTask, addNote, deleteTask) keeps project.tasks.yaml in sync with
  // the per-task <ulid>/task.yaml + notes.yaml sidecars in the same atomic
  // mutation. These baseline assertions pin that behavior so the plan/review
  // storage managers have a concrete pattern to converge on as the trait
  // promotion lands across folder-backed entities.
  //
  // AC: @trait-folder-backed-entity-1 ac-index-entry-created-with-folder
  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  // AC: @trait-folder-backed-entity-1 ac-index-repair-converges
  // AC: @task-index-file ac-2
  // AC: @task-index-file ac-5
  describe("folder-backed trait baseline (task index consistency)", () => {
    /**
     * Compute index drift without writing — mirrors the dry-run rebuild
     * path used by `kspec task rebuild-index`. Returns added/removed/changed
     * entries; empty arrays mean the index is in sync with the per-task
     * folders.
     */
    async function computeTaskIndexDrift(ctx: Awaited<ReturnType<typeof initContext>>): Promise<{
      added: string[];
      removed: string[];
      changed: string[];
    }> {
      const { listTaskDirs, toIndexEntry, getIndexFilePath, indexEntriesEqual } =
        await import("../src/parser/split-backend.js");
      const { readYamlFile } = await import("../src/parser/yaml.js");
      const splitManagerLocal = new TaskDataManager("split");

      const ulids = await listTaskDirs(ctx);
      const tasks = await splitManagerLocal.loadAllTasks(ctx);
      const newEntries = new Map<string, Record<string, unknown>>();
      for (const t of tasks) {
        newEntries.set(t._ulid, toIndexEntry(t));
      }
      // Sanity: the per-task dir count must match the task loader count.
      expect(tasks.length).toBe(ulids.length);

      let raw: unknown;
      try {
        raw = await readYamlFile<unknown>(getIndexFilePath(ctx));
      } catch {
        raw = [];
      }
      let currentEntries: Record<string, unknown>[] = [];
      if (Array.isArray(raw)) {
        currentEntries = raw.filter(
          (e): e is Record<string, unknown> => !!e && typeof e === "object",
        );
      } else if (raw && typeof raw === "object" && "tasks" in raw) {
        const wrapper = raw as Record<string, unknown>;
        if (Array.isArray(wrapper.tasks)) {
          currentEntries = wrapper.tasks.filter(
            (e): e is Record<string, unknown> => !!e && typeof e === "object",
          );
        }
      }
      const currentByUlid = new Map<string, Record<string, unknown>>();
      for (const entry of currentEntries) {
        const id = entry._ulid;
        if (typeof id === "string") currentByUlid.set(id, entry);
      }

      const added: string[] = [];
      const removed: string[] = [];
      const changed: string[] = [];
      for (const [ulid, newEntry] of newEntries) {
        const cur = currentByUlid.get(ulid);
        if (!cur) {
          added.push(ulid);
        } else if (!indexEntriesEqual(cur, newEntry)) {
          changed.push(ulid);
        }
      }
      for (const ulid of currentByUlid.keys()) {
        if (!newEntries.has(ulid)) removed.push(ulid);
      }
      return { added, removed, changed };
    }

    /**
     * The shipped fixtures' project.tasks.yaml predates a couple of optional
     * projection fields (blocked_by defaults, expanded notes_count semantics)
     * and would surface as "stale" against the current toIndexEntry shape.
     * Calling splitBackend.rebuildIndex first establishes a clean baseline so
     * the per-mutation assertions in these tests catch drift introduced by
     * the mutation under test rather than by historical fixture skew.
     */
    async function syncIndexBaseline(ctx: Awaited<ReturnType<typeof initContext>>): Promise<void> {
      await splitBackend.rebuildIndex(ctx);
    }

    // AC: @trait-folder-backed-entity-1 ac-index-entry-created-with-folder
    // AC: @task-index-file ac-5
    it("createTask: the new index entry is written in the same mutation as the per-task folder", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);
      await syncIndexBaseline(ctx);

      await manager.createTask(ctx, {
        title: "Baseline Created Task",
        slugs: ["baseline-created-task"],
      });

      const drift = await computeTaskIndexDrift(ctx);
      expect(drift).toEqual({ added: [], removed: [], changed: [] });
    });

    // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
    // AC: @task-index-file ac-2
    it("mutateTask: updates to indexed fields (priority, tags, status) keep the index in sync", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);
      await syncIndexBaseline(ctx);

      await manager.mutateTask(ctx, "@test-task-pending", (task) => ({
        ...task,
        priority: 1,
        tags: [...task.tags, "baseline"],
        status: "in_progress",
        started_at: "2026-05-23T13:00:00Z",
      }));

      const drift = await computeTaskIndexDrift(ctx);
      expect(drift).toEqual({ added: [], removed: [], changed: [] });
    });

    // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
    // AC: @task-index-file ac-2
    it("addNote: notes_count is reflected in the index in the same mutation", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);
      await syncIndexBaseline(ctx);

      await manager.addNote(ctx, "@test-task-pending", "Baseline note", "@tester");

      const drift = await computeTaskIndexDrift(ctx);
      expect(drift).toEqual({ added: [], removed: [], changed: [] });
    });

    // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
    // AC: @task-index-file ac-5
    it("deleteTask: the index entry is removed in the same mutation as the folder", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);
      await syncIndexBaseline(ctx);

      await manager.deleteTask(ctx, "@test-task-pending");

      const drift = await computeTaskIndexDrift(ctx);
      expect(drift).toEqual({ added: [], removed: [], changed: [] });
    });

    // AC: @trait-folder-backed-entity-1 ac-index-repair-converges
    it("rebuildIndex converges: after a fresh repair, a follow-up drift check reports zero changes", async () => {
      tempDir = await setupTempFixtures();
      const ctx = await initContext(tempDir);
      manager = resolveTaskDataManager(ctx);

      // Touch every mutator path to exercise the projection surface.
      await manager.createTask(ctx, {
        title: "Converge Baseline Task",
        slugs: ["converge-baseline-task"],
      });
      await manager.mutateTask(ctx, "@test-task-pending", (task) => ({
        ...task,
        priority: 1,
      }));
      await manager.addNote(ctx, "@test-task-pending", "Converge note", "@tester");

      // Rebuild from per-task folders, then assert a follow-up drift check
      // reports no remaining differences (no spurious update churn).
      await splitBackend.rebuildIndex(ctx);

      const drift = await computeTaskIndexDrift(ctx);
      expect(drift).toEqual({ added: [], removed: [], changed: [] });
    });
  });
});
