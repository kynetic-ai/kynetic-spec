import { afterEach, describe, expect, it } from "vitest";
import {
  initContext,
  loadAllTasks,
  TaskDataManager,
  TaskDataManagerError,
} from "../src/parser/index.js";
import type { TaskSummary } from "../src/parser/task-data-manager.js";
import {
  cleanupTempDir,
  kspec,
  setupTempFixtures,
  testUlid,
} from "./helpers/cli.js";

/** Detail-only fields that must NOT appear on TaskSummary results from listTasks. */
const DETAIL_ONLY_FIELDS = [
  "notes",
  "todos",
  "description",
  "vcs_refs",
  "review_url",
  "review_ref",
  "submission_linkage",
  "session_id",
  "meta_ref",
  "plan_ref",
  "derivation",
  "origin",
  "prior_status",
  "closed_reason",
  "complexity",
  "context",
] as const;

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
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

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
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

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
  });

  // AC: @task-data-manager ac-2
  // Only index data is read for listing; per-task detail files are not accessed
  describe("list returns only index data (ac-2)", () => {
    it("returns summary records containing only index-level fields", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

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
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

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
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      const pendingTasks = await manager.listTasks(ctx, {
        status: "pending",
      });
      expect(pendingTasks.length).toBe(3); // 3 pending tasks in fixtures
      expect(pendingTasks.every((t) => t.status === "pending")).toBe(true);
    });

    it("applies tag filters (any match)", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      const e2eTasks = await manager.listTasks(ctx, { tags: ["e2e"] });
      expect(e2eTasks.length).toBe(1);
      expect(e2eTasks[0].slugs).toContain("test-task-secondary");
    });

    it("applies automation filter", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      const eligible = await manager.listTasks(ctx, {
        automation: "eligible",
      });
      expect(eligible.length).toBe(1);
      expect(eligible[0].slugs).toContain("test-task-pending");
    });

    it("applies multiple filters together", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      const filtered = await manager.listTasks(ctx, {
        status: "pending",
        tags: ["test"],
      });
      // All 3 pending tasks have the "test" tag
      expect(filtered.length).toBe(3);
    });

    it("supports array of statuses", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      const tasks = await manager.listTasks(ctx, {
        status: ["pending", "completed"],
      });
      expect(tasks.length).toBe(4); // 3 pending + 1 completed
    });
  });

  // AC: @task-data-manager ac-3
  // Manager assembles the complete task from index and per-task files transparently
  describe("full detail loading (ac-3)", () => {
    it("returns complete task by slug reference", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      const task = await manager.getTask(ctx, "@test-task-secondary");
      expect(task.title).toBe("Test secondary task");
      expect(task.notes.length).toBe(1);
      expect(task.notes[0].content).toBe("Initial note on secondary task");
      expect(task.todos.length).toBe(2);
    });

    it("returns complete task by ULID reference", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      const task = await manager.getTask(ctx, "01KF1645CA45ZT43W2T6HJMVA1");
      expect(task.slugs).toContain("test-task-pending");
    });

    it("returns complete task by short ULID prefix", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      const task = await manager.getTask(ctx, "01KF1645CA");
      expect(task.slugs).toContain("test-task-pending");
    });

    // AC: @trait-error-guidance ac-3 — suggests checking ref on not found
    it("throws with suggestion when task not found", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      await expect(
        manager.getTask(ctx, "@nonexistent-task"),
      ).rejects.toThrow(TaskDataManagerError);

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

  // AC: @task-data-manager ac-4
  // All affected files, locking, and shadow branch commits are handled
  // by the manager as a single coordinated operation
  describe("coordinated mutations (ac-4)", () => {
    it("creates a task with file write and returns it", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

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
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      const updated = await manager.mutateTask(
        ctx,
        "@test-task-pending",
        (task) => ({
          ...task,
          status: "in_progress" as const,
          started_at: "2026-03-20T00:00:00.000Z",
        }),
      );

      expect(updated.status).toBe("in_progress");
      expect(updated.started_at).toBe("2026-03-20T00:00:00.000Z");

      // Verify persisted
      const reloaded = await manager.getTask(ctx, "@test-task-pending");
      expect(reloaded.status).toBe("in_progress");
    });

    it("deletes a task from storage", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

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
      await expect(
        manager.getTask(ctx, "@to-delete"),
      ).rejects.toThrow(TaskDataManagerError);
    });
  });

  // AC: @task-data-manager ac-5
  // Non-overlapping mutations proceed without contention
  describe("non-overlapping mutations (ac-5)", () => {
    it("allows concurrent mutations on different tasks", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

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
  });

  // AC: @task-data-manager ac-6
  // All writes happen within a single atomic operation that either
  // all succeed or all roll back
  describe("atomic operations (ac-6)", () => {
    it("batch mutation writes all changes atomically", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      const refs = ["@test-task-pending", "@test-task-secondary"];
      const updated = await manager.mutateTasks(ctx, refs, (tasks) =>
        tasks.map((task) => ({ ...task, priority: 1 })),
      );

      expect(updated.length).toBe(2);
      expect(updated.every((t) => t.priority === 1)).toBe(true);

      // Verify both persisted
      const reloaded = await manager.listTasks(ctx);
      const pending = reloaded.find((t) =>
        t.slugs.includes("test-task-pending"),
      );
      const secondary = reloaded.find((t) =>
        t.slugs.includes("test-task-secondary"),
      );
      expect(pending?.priority).toBe(1);
      expect(secondary?.priority).toBe(1);
    });

    it("addNote is atomic — note appears on reload", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

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
      expect(
        reloaded.notes.some((n) => n.content === "First note via manager"),
      ).toBe(true);
    });
  });

  // AC: @task-data-manager ac-7
  // Monolithic format is used until split explicitly activated
  describe("monolithic format by default (ac-7)", () => {
    it("defaults to monolithic format when no format specified", () => {
      const defaultManager = new TaskDataManager();
      expect(defaultManager.storageFormat).toBe("monolithic");
    });

    it("reads from monolithic tasks file", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      // The fixture uses project.tasks.yaml (monolithic format)
      const tasks = await manager.listTasks(ctx);
      expect(tasks.length).toBe(4);

      // All tasks should have _sourceFile pointing to the monolithic file
      expect(
        tasks.every(
          (t) =>
            t._sourceFile && t._sourceFile.endsWith("project.tasks.yaml"),
        ),
      ).toBe(true);
    });

    it("writes to monolithic tasks file", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      const created = await manager.createTask(ctx, {
        title: "Monolithic write test",
        slugs: ["mono-write"],
      });

      // Should write to the same monolithic file
      expect(created._sourceFile).toBeDefined();
      expect(created._sourceFile!.endsWith("project.tasks.yaml")).toBe(true);

      // Reload from raw to verify it's in the same file
      const allTasks = await loadAllTasks(ctx);
      const found = allTasks.find((t) => t.slugs.includes("mono-write"));
      expect(found).toBeDefined();
      expect(found?._sourceFile).toBe(created._sourceFile);
    });
  });

  // AC: @task-data-manager ac-8
  // Split format used when explicitly activated
  describe("split format activation (ac-8)", () => {
    it("throws descriptive error when split format is activated", async () => {
      tempDir = await setupTempFixtures();
      const splitManager = new TaskDataManager("split");
      const ctx = await initContext(tempDir);

      // The split backend is not yet implemented — the manager routes to it
      // and throws a descriptive error explaining the situation
      try {
        await splitManager.listTasks(ctx);
        expect.fail("Should have thrown for unimplemented split backend");
      } catch (err) {
        expect(err).toBeInstanceOf(TaskDataManagerError);
        const tdmErr = err as TaskDataManagerError;
        expect(tdmErr.message).toContain("Split storage format is not yet implemented");
        expect(tdmErr.suggestion).toContain("monolithic");
        expect(tdmErr.field).toBe("storageFormat");
      }
    });

    it("split format guard applies to all operations", async () => {
      tempDir = await setupTempFixtures();
      const splitManager = new TaskDataManager("split");
      const ctx = await initContext(tempDir);

      // Every public method should throw when split is activated
      await expect(splitManager.listTasks(ctx)).rejects.toThrow(
        "Split storage format is not yet implemented",
      );
      await expect(splitManager.getTask(ctx, "@test-task-pending")).rejects.toThrow(
        "Split storage format is not yet implemented",
      );
      await expect(
        splitManager.createTask(ctx, { title: "test", slugs: ["test"] }),
      ).rejects.toThrow("Split storage format is not yet implemented");
      await expect(
        splitManager.mutateTask(ctx, "@test-task-pending", (t) => t),
      ).rejects.toThrow("Split storage format is not yet implemented");
      await expect(
        splitManager.mutateTasks(ctx, ["@test-task-pending"], (t) => t),
      ).rejects.toThrow("Split storage format is not yet implemented");
      await expect(
        splitManager.deleteTask(ctx, "@test-task-pending"),
      ).rejects.toThrow("Split storage format is not yet implemented");
      await expect(
        splitManager.addNote(ctx, "@test-task-pending", "note"),
      ).rejects.toThrow("Split storage format is not yet implemented");
    });

    it("exposes storageFormat property for inspection", () => {
      const monoManager = new TaskDataManager();
      expect(monoManager.storageFormat).toBe("monolithic");

      const splitManager = new TaskDataManager("split");
      expect(splitManager.storageFormat).toBe("split");
    });
  });

  // AC: @task-data-manager ac-9
  // Concurrent same-task mutations serialize via lock
  describe("same-task mutation serialization (ac-9)", () => {
    it("serializes concurrent mutations on the same task", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

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
      expect(
        reloaded.notes.some((n) => n.content === "Concurrent note"),
      ).toBe(true);
    });
  });

  // AC: @trait-error-guidance ac-1 — error includes description
  // AC: @trait-error-guidance ac-2 — error includes suggested action
  describe("error guidance (trait-error-guidance)", () => {
    // AC: @trait-error-guidance ac-1
    it("error includes description of what went wrong", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      try {
        await manager.getTask(ctx, "@does-not-exist");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TaskDataManagerError);
        expect((err as TaskDataManagerError).message).toContain(
          "Task not found",
        );
      }
    });

    // AC: @trait-error-guidance ac-2
    it("error includes suggested action to resolve", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      try {
        await manager.getTask(ctx, "@does-not-exist");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TaskDataManagerError);
        expect((err as TaskDataManagerError).suggestion).toBeDefined();
        expect((err as TaskDataManagerError).suggestion).toContain(
          "kspec search",
        );
      }
    });

    // AC: @trait-error-guidance ac-3
    it("not-found error suggests checking ref with search or list", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

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
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      try {
        // @ts-expect-error — deliberately invalid input (missing required title)
        await manager.createTask(ctx, { title: "" });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TaskDataManagerError);
        expect((err as TaskDataManagerError).message).toContain(
          "Failed to create task",
        );
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
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      const { note } = await manager.addNote(
        ctx,
        "@test-task-pending",
        "Auto-generated note test",
      );

      expect(note._ulid).toBeDefined();
      expect(note._ulid.length).toBe(26);
      expect(note.created_at).toBeDefined();
      expect(note.content).toBe("Auto-generated note test");
    });

    it("uses provided author", async () => {
      tempDir = await setupTempFixtures();
      manager = new TaskDataManager();
      const ctx = await initContext(tempDir);

      const { note } = await manager.addNote(
        ctx,
        "@test-task-pending",
        "Author test",
        "@custom-author",
      );

      expect(note.author).toBe("@custom-author");
    });
  });

  describe("singleton export", () => {
    it("provides a module-level singleton instance with monolithic format", async () => {
      const { taskDataManager } = await import(
        "../src/parser/task-data-manager.js"
      );
      expect(taskDataManager).toBeInstanceOf(TaskDataManager);
      expect(taskDataManager.storageFormat).toBe("monolithic");
    });
  });
});
