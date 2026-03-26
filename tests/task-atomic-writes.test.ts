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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDataManager } from "../src/parser/task-data-manager.js";
import {
  ensureSplitBackendRegistered,
  getTaskDir,
  getTaskFilePath,
  getNotesFilePath,
  getIndexFilePath,
} from "../src/parser/split-backend.js";
import { getActiveBatchBuffer, runWithBatchBuffer } from "../src/cli/batch-write-buffer.js";

// Register the split backend (no longer auto-registered at module scope)
ensureSplitBackendRegistered();

import type { KspecContext } from "../src/parser/yaml.js";
import { toYaml } from "../src/parser/yaml.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  readTestOutput,
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

  await fs.writeFile(path.join(specDir, "project.tasks.yaml"), toYaml([]));

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
  options: {
    status?: string;
    notes?: Array<{ _ulid: string; content: string; created_at: string }>;
  } = {},
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
    const indexContent = await readTestOutput(indexPath, "utf-8");
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

      const indexContent = await readTestOutput(indexPath, "utf-8");
      expect(indexContent).toContain(created._ulid);

      // No buffer should be active after the operation completes
      expect(getActiveBatchBuffer()).toBeNull();
    });

    // AC: @task-atomic-writes ac-1
    it("mutateTask writes index + per-task file in a single buffer scope", async () => {
      const [ulid] = testUlids("ATWR", 1);
      await createSplitTask(ctx, ulid, "atomic-mutate-test");

      const updated = await manager.mutateTask(ctx, `@${ulid}`, (task) => ({
        ...task,
        status: "in_progress",
        started_at: "2026-03-20T12:00:00.000Z",
      }));

      expect(updated.status).toBe("in_progress");

      // Verify both files were updated on disk
      const taskContent = await readTestOutput(getTaskFilePath(ctx, ulid), "utf-8");
      expect(taskContent).toContain("in_progress");

      const indexContent = await readTestOutput(getIndexFilePath(ctx), "utf-8");
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
      const indexContent = await readTestOutput(getIndexFilePath(ctx), "utf-8");
      expect(indexContent).not.toContain(ulid);

      // Verify the task directory was removed
      await expect(fs.stat(taskDir)).rejects.toThrow();

      // No buffer should be active after the operation completes
      expect(getActiveBatchBuffer()).toBeNull();
    });

    // AC: @task-atomic-writes ac-1
    it("manager-owned buffer is active during backend operation", async () => {
      const [ulid] = testUlids("ABUF", 1);
      await createSplitTask(ctx, ulid, "buffer-active-test");

      let bufferWasActive = false;

      await manager.mutateTask(ctx, `@${ulid}`, (task) => {
        // Inside the mutation callback, the manager's buffer should be active
        bufferWasActive = getActiveBatchBuffer() !== null;
        return { ...task, title: "Updated via buffer" };
      });

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
      const indexBefore = await readTestOutput(getIndexFilePath(ctx), "utf-8");
      const taskBefore = await readTestOutput(getTaskFilePath(ctx, ulid), "utf-8");

      // Mutation that throws after modifying the task
      await expect(
        manager.mutateTask(ctx, `@${ulid}`, (_task) => {
          throw new Error("Simulated mutation failure");
        }),
      ).rejects.toThrow("Simulated mutation failure");

      // Verify files are unchanged — the buffer was discarded
      const indexAfter = await readTestOutput(getIndexFilePath(ctx), "utf-8");
      const taskAfter = await readTestOutput(getTaskFilePath(ctx, ulid), "utf-8");

      expect(indexAfter).toBe(indexBefore);
      expect(taskAfter).toBe(taskBefore);

      // Buffer should be cleaned up after failure
      expect(getActiveBatchBuffer()).toBeNull();
    });

    // AC: @task-atomic-writes ac-2
    it("deleteTask failure preserves directory and index — no partial deletion", async () => {
      const [ulid] = testUlids("ADRF", 1);
      await createSplitTask(ctx, ulid, "delete-rollback-test");

      // Snapshot state before the failed deletion
      const indexBefore = await readTestOutput(getIndexFilePath(ctx), "utf-8");
      const taskDir = getTaskDir(ctx, ulid);
      const taskBefore = await readTestOutput(getTaskFilePath(ctx, ulid), "utf-8");

      // Monkey-patch the manager to inject a failure after the backend
      // queues deletions but before flush completes. We do this by
      // activating a buffer that will throw on flush.
      const _realFlush = (await import("../src/cli/batch-write-buffer.js")).WriteBuffer.prototype
        .flush;
      const { WriteBuffer } = await import("../src/cli/batch-write-buffer.js");
      const originalFlush = WriteBuffer.prototype.flush;
      WriteBuffer.prototype.flush = async function () {
        // Discard so nothing is written, then throw
        this.discard();
        throw new Error("Simulated flush failure");
      };

      try {
        await expect(manager.deleteTask(ctx, `@${ulid}`)).rejects.toThrow(
          "Simulated flush failure",
        );
      } finally {
        WriteBuffer.prototype.flush = originalFlush;
      }

      // Directory should still exist — buffer was discarded before flush
      await expect(fs.stat(taskDir)).resolves.toBeTruthy();

      // Task files should be unchanged
      const taskAfter = await readTestOutput(getTaskFilePath(ctx, ulid), "utf-8");
      expect(taskAfter).toBe(taskBefore);

      // Index should be unchanged
      const indexAfter = await readTestOutput(getIndexFilePath(ctx), "utf-8");
      expect(indexAfter).toBe(indexBefore);

      // Buffer should be cleaned up
      expect(getActiveBatchBuffer()).toBeNull();
    });

    // AC: @task-atomic-writes ac-2
    it("index write failure does not leave per-task files committed", async () => {
      const [ulid] = testUlids("AIDX", 1);
      await createSplitTask(ctx, ulid, "index-fail-test");

      // Snapshot state before
      const indexBefore = await readTestOutput(getIndexFilePath(ctx), "utf-8");
      const taskBefore = await readTestOutput(getTaskFilePath(ctx, ulid), "utf-8");

      // Monkey-patch writeYamlFile to throw only when writing the index file
      const yamlModule = await import("../src/parser/yaml.js");
      const originalWriteYamlFile = yamlModule.writeYamlFile;
      const indexPath = getIndexFilePath(ctx);
      vi.spyOn(yamlModule, "writeYamlFile").mockImplementation(
        async (filePath: string, data: unknown) => {
          if (path.resolve(filePath) === path.resolve(indexPath)) {
            throw new Error("Simulated index write failure");
          }
          return originalWriteYamlFile(filePath, data);
        },
      );

      try {
        await expect(
          manager.mutateTask(ctx, `@${ulid}`, (task) => ({
            ...task,
            status: "in_progress",
            started_at: "2026-03-20T12:00:00.000Z",
          })),
        ).rejects.toThrow("Simulated index write failure");
      } finally {
        vi.restoreAllMocks();
      }

      // Per-task files should be unchanged — the buffer was discarded
      // because the index write (inside the buffer) threw
      const taskAfter = await readTestOutput(getTaskFilePath(ctx, ulid), "utf-8");
      expect(taskAfter).toBe(taskBefore);

      // Index should also be unchanged
      const indexAfter = await readTestOutput(getIndexFilePath(ctx), "utf-8");
      expect(indexAfter).toBe(indexBefore);

      // Buffer should be cleaned up
      expect(getActiveBatchBuffer()).toBeNull();
    });

    // AC: @task-atomic-writes ac-2
    it("createTask failure does not leave partial files on disk", async () => {
      // Create a conflicting task directory to prevent task creation from
      // being fully processed — we rely on Zod validation failure instead
      const indexBefore = await readTestOutput(getIndexFilePath(ctx), "utf-8");

      await expect(
        manager.createTask(ctx, {
          title: "", // Empty title should fail validation
        }),
      ).rejects.toThrow();

      // Index should be unchanged
      const indexAfter = await readTestOutput(getIndexFilePath(ctx), "utf-8");
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

      const updated = await manager.mutateTasks(ctx, [`@${ulid1}`, `@${ulid2}`], (tasks) =>
        tasks.map((t) => ({
          ...t,
          status: "in_progress",
          started_at: "2026-03-20T12:00:00.000Z",
        })),
      );

      expect(updated).toHaveLength(2);
      expect(updated[0].status).toBe("in_progress");
      expect(updated[1].status).toBe("in_progress");

      // Verify both per-task files and index were updated
      const task1Content = await readTestOutput(getTaskFilePath(ctx, ulid1), "utf-8");
      const task2Content = await readTestOutput(getTaskFilePath(ctx, ulid2), "utf-8");
      const indexContent = await readTestOutput(getIndexFilePath(ctx), "utf-8");

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

      // Simulate batch-exec scenario: run within a buffer scope
      await runWithBatchBuffer(ctx.specDir, async (batchBuffer) => {
        let bufferDuringMutation: ReturnType<typeof getActiveBatchBuffer> = null;

        await manager.mutateTask(ctx, `@${ulid}`, (task) => {
          bufferDuringMutation = getActiveBatchBuffer();
          return { ...task, title: "Updated in batch" };
        });

        // The same batch buffer should have been used (not a new one)
        expect(bufferDuringMutation).toBe(batchBuffer);

        // The batch buffer should still be active (batch-exec owns it)
        expect(getActiveBatchBuffer()).toBe(batchBuffer);

        // Writes should be in the buffer, not on disk yet
        expect(batchBuffer.size).toBeGreaterThan(0);

        // Flush the batch buffer (simulating batch-exec completion)
        await batchBuffer.flush();
      });

      // Now verify files are on disk
      const taskContent = await readTestOutput(getTaskFilePath(ctx, ulid), "utf-8");
      expect(taskContent).toContain("Updated in batch");
    });

    // AC: @task-atomic-writes ac-3
    it("nested mutation with commitOpts skips commitIfShadow until parent flushes", async () => {
      const [ulid] = testUlids("ABNCS", 1);
      await createSplitTask(ctx, ulid, "no-commit-in-nested");

      // Spy on commitIfShadow to verify it is NOT called during nested mutation
      const shadowModule = await import("../src/parser/shadow.js");
      const commitSpy = vi.spyOn(shadowModule, "commitIfShadow");

      try {
        // Simulate batch-exec scenario: run within a parent buffer scope
        await runWithBatchBuffer(ctx.specDir, async (batchBuffer) => {
          await manager.mutateTask(ctx, `@${ulid}`, (task) => ({ ...task, priority: 1 }), {
            operation: "test-nested-commit",
            ref: `@${ulid}`,
          });

          // commitIfShadow must NOT be called — the parent buffer hasn't
          // flushed yet, so disk state is stale. The parent (batch-exec)
          // owns the commit lifecycle and will commit after flush.
          expect(commitSpy).not.toHaveBeenCalled();

          // Writes should still be in the buffer, not on disk
          expect(batchBuffer.size).toBeGreaterThan(0);

          // Discard instead of flushing — we're just testing the nested behavior
          batchBuffer.discard();
        });
      } finally {
        commitSpy.mockRestore();
      }
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
        (tasks) =>
          tasks.map((t) => ({
            ...t,
            status: "cancelled",
          })),
      );

      expect(updated).toHaveLength(3);

      // Verify all three per-task files were updated
      for (const ulid of [ulid1, ulid2, ulid3]) {
        const taskContent = await readTestOutput(getTaskFilePath(ctx, ulid), "utf-8");
        expect(taskContent).toContain("cancelled");
      }

      // Verify index was updated for all three tasks
      const indexContent = await readTestOutput(getIndexFilePath(ctx), "utf-8");
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
      const index1Before = await readTestOutput(getIndexFilePath(ctx), "utf-8");
      const task1Before = await readTestOutput(getTaskFilePath(ctx, ulid1), "utf-8");
      const task2Before = await readTestOutput(getTaskFilePath(ctx, ulid2), "utf-8");

      await expect(
        manager.mutateTasks(ctx, [`@${ulid1}`, `@${ulid2}`], (_tasks) => {
          throw new Error("Simulated batch failure");
        }),
      ).rejects.toThrow("Simulated batch failure");

      // All files should be unchanged — nothing persisted
      const indexAfter = await readTestOutput(getIndexFilePath(ctx), "utf-8");
      const task1After = await readTestOutput(getTaskFilePath(ctx, ulid1), "utf-8");
      const task2After = await readTestOutput(getTaskFilePath(ctx, ulid2), "utf-8");

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
      const notesContent = await readTestOutput(getNotesFilePath(ctx, ulid), "utf-8");
      expect(notesContent).toContain("Test note content");

      // Verify index updated with notes_count
      const indexContent = await readTestOutput(getIndexFilePath(ctx), "utf-8");
      expect(indexContent).toContain("notes_count: 1");

      // No buffer should remain active
      expect(getActiveBatchBuffer()).toBeNull();
    });
  });

  // ── Concurrent buffer isolation ──────────────────────────────────────
  //
  // Verifies that concurrent split mutations on different tasks each get
  // their own buffer scope via AsyncLocalStorage. Previously, a process-
  // global singleton buffer meant one operation's failure could discard
  // another's successful writes.

  describe("concurrent split mutations use isolated buffers", () => {
    it("one mutation failure does not discard another's writes", async () => {
      const [ulidA, ulidB] = testUlids("CONC", 2);
      await createSplitTask(ctx, ulidA, "concurrent-a", { status: "pending" });
      await createSplitTask(ctx, ulidB, "concurrent-b", { status: "pending" });

      // Mutation A: will throw after a short delay
      const mutationA = manager.mutateTask(ctx, `@${ulidA}`, async (_task) => {
        // Yield to let mutation B start concurrently
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("Simulated failure in mutation A");
      });

      // Mutation B: succeeds immediately
      const mutationB = manager.mutateTask(ctx, `@${ulidB}`, (task) => ({ ...task, priority: 1 }));

      // Both run concurrently; A should fail, B should succeed
      const results = await Promise.allSettled([mutationA, mutationB]);

      expect(results[0].status).toBe("rejected");
      expect(results[1].status).toBe("fulfilled");

      // B's writes should be persisted — NOT discarded by A's failure
      const taskBContent = await readTestOutput(getTaskFilePath(ctx, ulidB), "utf-8");
      expect(taskBContent).toContain("priority: 1");

      // A's task should be unchanged (its buffer was discarded)
      const taskAContent = await readTestOutput(getTaskFilePath(ctx, ulidA), "utf-8");
      expect(taskAContent).toContain("priority: 3");

      // No buffer should remain active
      expect(getActiveBatchBuffer()).toBeNull();
    });

    it("each concurrent mutation gets its own buffer instance", async () => {
      const [ulidC, ulidD] = testUlids("CONP", 2);
      await createSplitTask(ctx, ulidC, "concurrent-c", { status: "pending" });
      await createSplitTask(ctx, ulidD, "concurrent-d", { status: "pending" });

      let bufferC: ReturnType<typeof getActiveBatchBuffer> = null;
      let bufferD: ReturnType<typeof getActiveBatchBuffer> = null;

      // Use a barrier to ensure both mutations are in-flight simultaneously
      let resolveBarrier: () => void;
      const barrier = new Promise<void>((r) => {
        resolveBarrier = r;
      });
      let arrivals = 0;

      const mutationC = manager.mutateTask(ctx, `@${ulidC}`, async (task) => {
        bufferC = getActiveBatchBuffer();
        arrivals++;
        if (arrivals === 2) resolveBarrier!();
        await barrier;
        return { ...task, title: "Updated C" };
      });

      const mutationD = manager.mutateTask(ctx, `@${ulidD}`, async (task) => {
        bufferD = getActiveBatchBuffer();
        arrivals++;
        if (arrivals === 2) resolveBarrier!();
        await barrier;
        return { ...task, title: "Updated D" };
      });

      // Both mutations run concurrently — we only care that they have
      // distinct buffer instances (isolation), not that they both flush
      // without conflict. Index-level coordination is a separate concern.
      await Promise.allSettled([mutationC, mutationD]);

      // Critical assertion: each mutation must have seen its own buffer,
      // NOT the same shared buffer. This prevents one operation's
      // discard() from affecting the other.
      expect(bufferC).not.toBeNull();
      expect(bufferD).not.toBeNull();
      expect(bufferC).not.toBe(bufferD);
    });
  });

});
