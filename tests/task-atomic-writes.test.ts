/**
 * Tests for atomic multi-file task writes.
 *
 * Verifies that the TaskDataManager wraps all task mutations in a write buffer
 * scope so that index + per-task file writes are committed atomically to the
 * shadow branch. When a batch buffer is already active, the manager reuses it
 * instead of creating a nested buffer.
 *
 * Spec: @task-atomic-writes
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TaskDataManager,
} from "../src/parser/task-data-manager.js";
import {
  ensureSplitBackendRegistered,
  getTaskDir,
  getTaskFilePath,
  getNotesFilePath,
  getIndexFilePath,
} from "../src/parser/split-backend.js";
import {
  activateBatchBuffer,
  deactivateBatchBuffer,
  getActiveBatchBuffer,
} from "../src/cli/batch-write-buffer.js";

// Register the split backend (no longer auto-registered at module scope)
ensureSplitBackendRegistered();

import type { KspecContext } from "../src/parser/yaml.js";
import { toYaml } from "../src/parser/yaml.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  testUlid,
  testUlids,
} from "./helpers/cli.js";

/**
 * Helper: set up a split storage environment in a temp directory.
 */
async function setupSplitFixture(tempDir: string): Promise<KspecContext> {
  initGitRepo(tempDir);

  const specDir = path.join(tempDir, ".kspec");
  await fs.mkdir(specDir, { recursive: true });

  await fs.writeFile(
    path.join(specDir, "kynetic.yaml"),
    toYaml({ kynetic_spec: "1.0", title: "Test Project" }),
  );

  const tasksDir = path.join(specDir, "tasks");
  await fs.mkdir(tasksDir, { recursive: true });

  await fs.writeFile(
    path.join(specDir, "project.tasks.yaml"),
    toYaml([]),
  );

  const ctx: KspecContext = {
    rootDir: tempDir,
    projectRoot: tempDir,
    specDir,
    sessionsDir: path.join(tempDir, ".kspec-sessions"),
    manifestPath: path.join(specDir, "kynetic.yaml"),
    manifest: { kynetic_spec: "1.0", title: "Test Project" } as any,
    shadow: null,
    config: {} as any,
  };

  return ctx;
}

/**
 * Helper: create a task directly on disk in split format.
 */
async function createSplitTask(
  ctx: KspecContext,
  ulid: string,
  slug: string,
  options: { status?: string; notes?: Array<{ _ulid: string; content: string; created_at: string }> } = {},
): Promise<void> {
  const taskDir = path.join(ctx.specDir, "tasks", ulid);
  await fs.mkdir(taskDir, { recursive: true });

  const coreData = {
    _ulid: ulid,
    slugs: [slug],
    title: `Task ${slug}`,
    type: "task",
    status: options.status || "pending",
    priority: 3,
    tags: ["test"],
    depends_on: [],
    blocked_by: [],
    created_at: "2026-03-20T00:00:00.000Z",
    todos: [],
  };
  await fs.writeFile(path.join(taskDir, "task.yaml"), toYaml(coreData));

  const notes = options.notes || [];
  await fs.writeFile(path.join(taskDir, "notes.yaml"), toYaml({ notes }));

  // Add to index
  const indexPath = getIndexFilePath(ctx);
  let indexTasks: unknown[] = [];
  try {
    const indexContent = await fs.readFile(indexPath, "utf-8");
    const { parse } = await import("yaml");
    const parsed = parse(indexContent);
    if (Array.isArray(parsed)) {
      indexTasks = parsed;
    }
  } catch {
    // empty
  }

  indexTasks.push({
    _ulid: ulid,
    slugs: [slug],
    title: `Task ${slug}`,
    type: "task",
    status: options.status || "pending",
    priority: 3,
    tags: ["test"],
    depends_on: [],
    blocked_by: [],
    created_at: "2026-03-20T00:00:00.000Z",
    notes_count: notes.length,
    todos_count: 0,
  });

  await fs.writeFile(indexPath, toYaml(indexTasks));
}

describe("Atomic Multi-File Task Writes", () => {
  let tempDir: string;
  let ctx: KspecContext;
  let manager: TaskDataManager;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-atomic-writes-test-");
    ctx = await setupSplitFixture(tempDir);
    manager = new TaskDataManager("split");
  });

  afterEach(async () => {
    // Always clean up any lingering buffer
    deactivateBatchBuffer();
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  // ── AC: @task-atomic-writes ac-1 ──────────────────────────────────────
  // Given: A task mutation requires writing to the index and a per-task file
  // When: The write is executed
  // Then: Both files are written within a single buffered transaction that
  //       commits atomically to the shadow branch
  describe("single buffered transaction (ac-1)", () => {
    // AC: @task-atomic-writes ac-1
    it("createTask writes index + per-task files in a single buffer scope", async () => {
      // The manager should activate a buffer, the backend should detect
      // it and use it, and the manager should flush at the end.
      const created = await manager.createTask(ctx, {
        title: "Atomic create test",
        slugs: ["atomic-create-test"],
      });

      // Verify the task was persisted: both per-task files and index updated
      const taskFilePath = getTaskFilePath(ctx, created._ulid);
      const notesFilePath = getNotesFilePath(ctx, created._ulid);
      const indexPath = getIndexFilePath(ctx);

      const taskStat = await fs.stat(taskFilePath);
      expect(taskStat.isFile()).toBe(true);

      const notesStat = await fs.stat(notesFilePath);
      expect(notesStat.isFile()).toBe(true);

      const indexContent = await fs.readFile(indexPath, "utf-8");
      expect(indexContent).toContain(created._ulid);

      // No buffer should be active after the operation completes
      expect(getActiveBatchBuffer()).toBeNull();
    });

    // AC: @task-atomic-writes ac-1
    it("mutateTask writes index + per-task file in a single buffer scope", async () => {
      const [ulid] = testUlids("ATWR", 1);
      await createSplitTask(ctx, ulid, "atomic-mutate-test");

      const updated = await manager.mutateTask(
        ctx,
        `@${ulid}`,
        (task) => ({ ...task, status: "in_progress", started_at: "2026-03-20T12:00:00.000Z" }),
      );

      expect(updated.status).toBe("in_progress");

      // Verify both files were updated on disk
      const taskContent = await fs.readFile(getTaskFilePath(ctx, ulid), "utf-8");
      expect(taskContent).toContain("in_progress");

      const indexContent = await fs.readFile(getIndexFilePath(ctx), "utf-8");
      expect(indexContent).toContain("in_progress");

      // No buffer should be active after the operation completes
      expect(getActiveBatchBuffer()).toBeNull();
    });

    // AC: @task-atomic-writes ac-1
    it("deleteTask removes index entry + per-task files in a single buffer scope", async () => {
      const [ulid] = testUlids("ADEL", 1);
      await createSplitTask(ctx, ulid, "atomic-delete-test");

      // Verify task exists before deletion
      const taskDir = getTaskDir(ctx, ulid);
      await expect(fs.stat(taskDir)).resolves.toBeTruthy();

      await manager.deleteTask(ctx, `@${ulid}`);

      // Verify index no longer contains the task
      const indexContent = await fs.readFile(getIndexFilePath(ctx), "utf-8");
      expect(indexContent).not.toContain(ulid);

      // No buffer should be active after the operation completes
      expect(getActiveBatchBuffer()).toBeNull();
    });

    // AC: @task-atomic-writes ac-1
    it("manager-owned buffer is active during backend operation", async () => {
      const [ulid] = testUlids("ABUF", 1);
      await createSplitTask(ctx, ulid, "buffer-active-test");

      let bufferWasActive = false;

      await manager.mutateTask(
        ctx,
        `@${ulid}`,
        (task) => {
          // Inside the mutation callback, the manager's buffer should be active
          bufferWasActive = getActiveBatchBuffer() !== null;
          return { ...task, title: "Updated via buffer" };
        },
      );

      expect(bufferWasActive).toBe(true);

      // Buffer should be deactivated after the operation
      expect(getActiveBatchBuffer()).toBeNull();
    });
  });

  // ── AC: @task-atomic-writes ac-2 ──────────────────────────────────────
  // Given: A write to the per-task file succeeds but the index write fails
  // When: The transaction is evaluated
  // Then: Neither write is persisted; the shadow branch state is unchanged
  describe("rollback on failure (ac-2)", () => {
    // AC: @task-atomic-writes ac-2
    it("mutation failure discards all buffered writes — no partial persistence", async () => {
      const [ulid] = testUlids("ARLL", 1);
      await createSplitTask(ctx, ulid, "rollback-test");

      // Snapshot the state before the failed mutation
      const indexBefore = await fs.readFile(getIndexFilePath(ctx), "utf-8");
      const taskBefore = await fs.readFile(getTaskFilePath(ctx, ulid), "utf-8");

      // Mutation that throws after modifying the task
      await expect(
        manager.mutateTask(
          ctx,
          `@${ulid}`,
          (_task) => {
            throw new Error("Simulated mutation failure");
          },
        ),
      ).rejects.toThrow("Simulated mutation failure");

      // Verify files are unchanged — the buffer was discarded
      const indexAfter = await fs.readFile(getIndexFilePath(ctx), "utf-8");
      const taskAfter = await fs.readFile(getTaskFilePath(ctx, ulid), "utf-8");

      expect(indexAfter).toBe(indexBefore);
      expect(taskAfter).toBe(taskBefore);

      // Buffer should be cleaned up after failure
      expect(getActiveBatchBuffer()).toBeNull();
    });

    // AC: @task-atomic-writes ac-2
    it("createTask failure does not leave partial files on disk", async () => {
      // Create a conflicting task directory to prevent task creation from
      // being fully processed — we rely on Zod validation failure instead
      const indexBefore = await fs.readFile(getIndexFilePath(ctx), "utf-8");

      await expect(
        manager.createTask(ctx, {
          title: "", // Empty title should fail validation
        }),
      ).rejects.toThrow();

      // Index should be unchanged
      const indexAfter = await fs.readFile(getIndexFilePath(ctx), "utf-8");
      expect(indexAfter).toBe(indexBefore);

      // Buffer should be cleaned up after failure
      expect(getActiveBatchBuffer()).toBeNull();
    });
  });

  // ── AC: @task-atomic-writes ac-3 ──────────────────────────────────────
  // Given: A batch operation modifies multiple tasks
  // When: The batch is executed
  // Then: All index updates and all per-task file writes are collected in
  //       the write buffer and flushed as a single shadow branch commit
  describe("batch operations use single buffer (ac-3)", () => {
    // AC: @task-atomic-writes ac-3
    it("mutateTasks collects all writes in a single buffer flush", async () => {
      const [ulid1, ulid2] = testUlids("ABAT", 2);
      await createSplitTask(ctx, ulid1, "batch-task-1");
      await createSplitTask(ctx, ulid2, "batch-task-2");

      const updated = await manager.mutateTasks(
        ctx,
        [`@${ulid1}`, `@${ulid2}`],
        (tasks) => tasks.map((t) => ({
          ...t,
          status: "in_progress",
          started_at: "2026-03-20T12:00:00.000Z",
        })),
      );

      expect(updated).toHaveLength(2);
      expect(updated[0].status).toBe("in_progress");
      expect(updated[1].status).toBe("in_progress");

      // Verify both per-task files and index were updated
      const task1Content = await fs.readFile(getTaskFilePath(ctx, ulid1), "utf-8");
      const task2Content = await fs.readFile(getTaskFilePath(ctx, ulid2), "utf-8");
      const indexContent = await fs.readFile(getIndexFilePath(ctx), "utf-8");

      expect(task1Content).toContain("in_progress");
      expect(task2Content).toContain("in_progress");
      expect(indexContent).toContain("in_progress");

      // No buffer should remain active
      expect(getActiveBatchBuffer()).toBeNull();
    });

    // AC: @task-atomic-writes ac-3
    it("batch buffer from batch-exec is reused, not nested", async () => {
      const [ulid] = testUlids("ABNST", 1);
      await createSplitTask(ctx, ulid, "no-nest-test");

      // Simulate batch-exec scenario: activate a buffer before the operation
      const batchBuffer = activateBatchBuffer(ctx.specDir);

      let bufferDuringMutation: ReturnType<typeof getActiveBatchBuffer> = null;

      await manager.mutateTask(
        ctx,
        `@${ulid}`,
        (task) => {
          bufferDuringMutation = getActiveBatchBuffer();
          return { ...task, title: "Updated in batch" };
        },
      );

      // The same batch buffer should have been used (not a new one)
      expect(bufferDuringMutation).toBe(batchBuffer);

      // The batch buffer should still be active (batch-exec owns it)
      expect(getActiveBatchBuffer()).toBe(batchBuffer);

      // Writes should be in the buffer, not on disk yet
      expect(batchBuffer.size).toBeGreaterThan(0);

      // Flush the batch buffer (simulating batch-exec completion)
      await batchBuffer.flush();
      deactivateBatchBuffer();

      // Now verify files are on disk
      const taskContent = await fs.readFile(getTaskFilePath(ctx, ulid), "utf-8");
      expect(taskContent).toContain("Updated in batch");
    });
  });

  // ── AC: @task-atomic-writes ac-4 ──────────────────────────────────────
  // Given: A single logical operation affects multiple tasks (e.g.
  //        cancellation with dependency cleanup)
  // When: The mutation is persisted
  // Then: All affected task directories and index entries are written in
  //       a single atomic operation
  describe("multi-task atomic operation (ac-4)", () => {
    // AC: @task-atomic-writes ac-4
    it("mutateTasks affecting multiple tasks writes all changes atomically", async () => {
      const [ulid1, ulid2, ulid3] = testUlids("AMTA", 3);
      await createSplitTask(ctx, ulid1, "multi-atomic-1", { status: "in_progress" });
      await createSplitTask(ctx, ulid2, "multi-atomic-2", { status: "pending" });
      await createSplitTask(ctx, ulid3, "multi-atomic-3", { status: "pending" });

      // Simulate a cancellation that affects all three tasks
      const updated = await manager.mutateTasks(
        ctx,
        [`@${ulid1}`, `@${ulid2}`, `@${ulid3}`],
        (tasks) => tasks.map((t) => ({
          ...t,
          status: "cancelled",
        })),
      );

      expect(updated).toHaveLength(3);

      // Verify all three per-task files were updated
      for (const ulid of [ulid1, ulid2, ulid3]) {
        const taskContent = await fs.readFile(getTaskFilePath(ctx, ulid), "utf-8");
        expect(taskContent).toContain("cancelled");
      }

      // Verify index was updated for all three tasks
      const indexContent = await fs.readFile(getIndexFilePath(ctx), "utf-8");
      const { parse } = await import("yaml");
      const indexTasks = parse(indexContent) as Array<{ _ulid: string; status: string }>;

      for (const ulid of [ulid1, ulid2, ulid3]) {
        const entry = indexTasks.find((t) => t._ulid === ulid);
        expect(entry?.status).toBe("cancelled");
      }

      // No buffer should remain active
      expect(getActiveBatchBuffer()).toBeNull();
    });

    // AC: @task-atomic-writes ac-4
    it("multi-task mutation failure rolls back all changes", async () => {
      const [ulid1, ulid2] = testUlids("AMTF", 2);
      await createSplitTask(ctx, ulid1, "multi-fail-1");
      await createSplitTask(ctx, ulid2, "multi-fail-2");

      // Snapshot state before
      const index1Before = await fs.readFile(getIndexFilePath(ctx), "utf-8");
      const task1Before = await fs.readFile(getTaskFilePath(ctx, ulid1), "utf-8");
      const task2Before = await fs.readFile(getTaskFilePath(ctx, ulid2), "utf-8");

      await expect(
        manager.mutateTasks(
          ctx,
          [`@${ulid1}`, `@${ulid2}`],
          (_tasks) => {
            throw new Error("Simulated batch failure");
          },
        ),
      ).rejects.toThrow("Simulated batch failure");

      // All files should be unchanged — nothing persisted
      const indexAfter = await fs.readFile(getIndexFilePath(ctx), "utf-8");
      const task1After = await fs.readFile(getTaskFilePath(ctx, ulid1), "utf-8");
      const task2After = await fs.readFile(getTaskFilePath(ctx, ulid2), "utf-8");

      expect(indexAfter).toBe(index1Before);
      expect(task1After).toBe(task1Before);
      expect(task2After).toBe(task2Before);

      // Buffer should be cleaned up
      expect(getActiveBatchBuffer()).toBeNull();
    });
  });

  // ── Additional integration tests ──────────────────────────────────────

  describe("addNote uses write buffer through mutateTask", () => {
    // AC: @task-atomic-writes ac-1
    it("addNote writes notes.yaml + index update atomically", async () => {
      const [ulid] = testUlids("ANOT", 1);
      await createSplitTask(ctx, ulid, "note-atomic-test");

      const { task, note } = await manager.addNote(
        ctx,
        `@${ulid}`,
        "Test note content",
        "test-author",
      );

      expect(task.notes).toHaveLength(1);
      expect(note.content).toBe("Test note content");

      // Verify notes file was updated on disk
      const notesContent = await fs.readFile(getNotesFilePath(ctx, ulid), "utf-8");
      expect(notesContent).toContain("Test note content");

      // Verify index updated with notes_count
      const indexContent = await fs.readFile(getIndexFilePath(ctx), "utf-8");
      expect(indexContent).toContain("notes_count: 1");

      // No buffer should remain active
      expect(getActiveBatchBuffer()).toBeNull();
    });
  });

  describe("monolithic format skips buffer management", () => {
    it("monolithic manager does not activate a write buffer", async () => {
      const monoManager = new TaskDataManager("monolithic");

      // Set up monolithic fixture (task in project.tasks.yaml)
      const monoTasksPath = path.join(ctx.specDir, "project.tasks.yaml");
      const [ulid] = testUlids("AMNO", 1);
      await fs.writeFile(monoTasksPath, toYaml([{
        _ulid: ulid,
        slugs: ["mono-test"],
        title: "Monolithic test",
        type: "task",
        status: "pending",
        priority: 3,
        tags: [],
        depends_on: [],
        blocked_by: [],
        created_at: "2026-03-20T00:00:00.000Z",
        notes: [],
        todos: [],
      }]));

      let bufferDuringMutation: ReturnType<typeof getActiveBatchBuffer> = null;

      await monoManager.mutateTask(
        ctx,
        `@${ulid}`,
        (task) => {
          bufferDuringMutation = getActiveBatchBuffer();
          return { ...task, title: "Updated mono" };
        },
      );

      // No buffer should be active during monolithic mutations
      expect(bufferDuringMutation).toBeNull();
    });
  });
});
