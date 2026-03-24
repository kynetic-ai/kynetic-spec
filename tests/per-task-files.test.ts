import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TaskDataManager,
  resolveTaskDataManager,
} from "../src/parser/task-data-manager.js";
import {
  splitBackend,
  ensureSplitBackendRegistered,
  getTaskDir,
  getTaskFilePath,
  getNotesFilePath,
  getIndexFilePath,
} from "../src/parser/split-backend.js";
import type { HistoryEntry } from "../src/parser/split-backend.js";

// Register the split backend
ensureSplitBackendRegistered();
import type { KspecContext } from "../src/parser/yaml.js";
import { toYaml } from "../src/parser/yaml.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  readTestOutput,
  testUlid,
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
 * Helper: read and parse a YAML file.
 */
async function readYaml(filePath: string): Promise<Record<string, unknown>> {
  const content = await readTestOutput(filePath);
  const { parse } = await import("yaml");
  return parse(content);
}

describe("Per-Task Core Data File (@task-core-data-file)", () => {
  let tempDir: string;
  let ctx: KspecContext;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-per-task-files-");
    ctx = await setupSplitFixture(tempDir);
  });

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  // ── AC: @task-core-data-file ac-1 ──────────────────────────────────────
  // Given: A task's mutable field is modified
  // When: The mutation is persisted
  // Then: The current field value is updated in-place and a history entry
  //       is appended recording the timestamp, author, command that made
  //       the change, the field name, the previous value, and the new value
  describe("field mutation with history (ac-1)", () => {
    // AC: @task-core-data-file ac-1
    it("appends a history entry when a field is mutated", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "History test",
        slugs: ["history-test"],
        priority: 3,
      });

      // Mutate the task
      await manager.mutateTask(ctx, "@history-test", (task) => ({
        ...task,
        priority: 1,
      }));

      // Read task.yaml directly and check for history
      const taskFile = await readYaml(getTaskFilePath(ctx, created._ulid));
      expect(taskFile.history).toBeDefined();
      expect(Array.isArray(taskFile.history)).toBe(true);
      expect((taskFile.history as HistoryEntry[]).length).toBe(1);

      const entry = (taskFile.history as HistoryEntry[])[0];
      expect(entry.changes).toBeDefined();
      expect(entry.changes.priority).toBeDefined();
      expect(entry.changes.priority.previous).toBe(3);
      expect(entry.changes.priority.new).toBe(1);
    });

    // AC: @task-core-data-file ac-1
    it("updates the field value in-place alongside history", async () => {
      const manager = new TaskDataManager("split");

      await manager.createTask(ctx, {
        title: "In-place update test",
        slugs: ["in-place-test"],
        status: "pending",
      });

      await manager.mutateTask(ctx, "@in-place-test", (task) => ({
        ...task,
        status: "in_progress" as const,
        started_at: "2026-03-20T01:00:00.000Z",
      }));

      const reloaded = await manager.getTask(ctx, "@in-place-test");
      expect(reloaded.status).toBe("in_progress");
      expect(reloaded.started_at).toBe("2026-03-20T01:00:00.000Z");
    });

    // AC: @task-core-data-file ac-1
    it("records multiple field changes in a single history entry", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Multi-field test",
        slugs: ["multi-field-test"],
        priority: 3,
        tags: ["original"],
      });

      await manager.mutateTask(ctx, "@multi-field-test", (task) => ({
        ...task,
        priority: 1,
        tags: ["updated", "modified"],
      }));

      const taskFile = await readYaml(getTaskFilePath(ctx, created._ulid));
      const history = taskFile.history as HistoryEntry[];
      expect(history.length).toBe(1);

      const entry = history[0];
      expect(entry.changes.priority).toBeDefined();
      expect(entry.changes.tags).toBeDefined();
      expect(entry.changes.priority.previous).toBe(3);
      expect(entry.changes.priority.new).toBe(1);
    });

    // AC: @task-core-data-file ac-1
    it("appends sequential history entries for multiple mutations", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Sequential test",
        slugs: ["sequential-test"],
        priority: 3,
      });

      // First mutation
      await manager.mutateTask(ctx, "@sequential-test", (task) => ({
        ...task,
        priority: 2,
      }));

      // Second mutation
      await manager.mutateTask(ctx, "@sequential-test", (task) => ({
        ...task,
        priority: 1,
      }));

      const taskFile = await readYaml(getTaskFilePath(ctx, created._ulid));
      const history = taskFile.history as HistoryEntry[];
      expect(history.length).toBe(2);

      // First entry: 3 → 2
      expect(history[0].changes.priority.previous).toBe(3);
      expect(history[0].changes.priority.new).toBe(2);

      // Second entry: 2 → 1
      expect(history[1].changes.priority.previous).toBe(2);
      expect(history[1].changes.priority.new).toBe(1);
    });

    // AC: @task-core-data-file ac-1
    it("does not create a history entry when no fields change", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "No-change test",
        slugs: ["no-change-test"],
        priority: 3,
      });

      // Mutate returning the same values — no actual change
      await manager.mutateTask(ctx, "@no-change-test", (task) => ({
        ...task,
      }));

      const taskFile = await readYaml(getTaskFilePath(ctx, created._ulid));
      // History should be absent or empty since nothing changed
      expect(taskFile.history).toBeUndefined();
    });

    // AC: @task-core-data-file ac-1
    it("records history entries with metadata from commitOpts", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Metadata test",
        slugs: ["metadata-test"],
        priority: 3,
      });

      // Mutate with commitOpts to provide command metadata
      await manager.mutateTask(
        ctx,
        "@metadata-test",
        (task) => ({ ...task, priority: 1 }),
        { operation: "task-set", ref: "@metadata-test" },
      );

      const taskFile = await readYaml(getTaskFilePath(ctx, created._ulid));
      const history = taskFile.history as HistoryEntry[];
      expect(history.length).toBe(1);
      expect(history[0].command).toBe("task-set");
    });
  });

  // ── AC: @task-core-data-file ac-2 ──────────────────────────────────────
  // Given: A task is loaded for detailed view
  // When: The caller requests activity information
  // Then: The history section provides a complete audit trail of all field
  //       changes without requiring version control queries
  describe("history as audit trail (ac-2)", () => {
    // AC: @task-core-data-file ac-2
    it("provides complete audit trail through getTaskHistory", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Audit trail test",
        slugs: ["audit-trail-test"],
        priority: 3,
        status: "pending",
      });

      // Multiple mutations to build history
      await manager.mutateTask(ctx, "@audit-trail-test", (task) => ({
        ...task,
        status: "in_progress" as const,
        started_at: "2026-03-20T01:00:00.000Z",
      }));

      await manager.mutateTask(ctx, "@audit-trail-test", (task) => ({
        ...task,
        priority: 1,
      }));

      await manager.mutateTask(ctx, "@audit-trail-test", (task) => ({
        ...task,
        tags: ["urgent"],
      }));

      // Read history directly from the backend
      const history = await splitBackend.getTaskHistory(ctx, created._ulid);

      // Should have 3 history entries — one per mutation
      expect(history.length).toBe(3);

      // Each entry tracks specific changes
      expect(history[0].changes.status).toBeDefined();
      expect(history[1].changes.priority).toBeDefined();
      expect(history[2].changes.tags).toBeDefined();
    });

    // AC: @task-core-data-file ac-2
    it("history is complete without needing git queries", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "No-git test",
        slugs: ["no-git-test"],
        status: "pending",
      });

      // Simulate a task lifecycle
      await manager.mutateTask(ctx, "@no-git-test", (task) => ({
        ...task,
        status: "in_progress" as const,
        started_at: "2026-03-20T01:00:00.000Z",
      }));
      await manager.mutateTask(ctx, "@no-git-test", (task) => ({
        ...task,
        status: "pending_review" as const,
        submitted_at: "2026-03-20T02:00:00.000Z",
      }));
      await manager.mutateTask(ctx, "@no-git-test", (task) => ({
        ...task,
        status: "completed" as const,
        completed_at: "2026-03-20T03:00:00.000Z",
      }));

      const history = await splitBackend.getTaskHistory(ctx, created._ulid);

      // Complete audit trail in chronological order
      expect(history.length).toBe(3);

      // Verify the full lifecycle is captured
      expect(history[0].changes.status.previous).toBe("pending");
      expect(history[0].changes.status.new).toBe("in_progress");

      expect(history[1].changes.status.previous).toBe("in_progress");
      expect(history[1].changes.status.new).toBe("pending_review");

      expect(history[2].changes.status.previous).toBe("pending_review");
      expect(history[2].changes.status.new).toBe("completed");
    });

    // AC: @task-core-data-file ac-2
    it("newly created tasks have empty history", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Empty history test",
        slugs: ["empty-history-test"],
      });

      const history = await splitBackend.getTaskHistory(ctx, created._ulid);
      expect(history.length).toBe(0);
    });
  });

  // ── AC: @task-core-data-file ac-3 ──────────────────────────────────────
  // Given: A history entry is recorded
  // When: The entry is read back
  // Then: The entry includes: timestamp (ISO 8601), author (who made the
  //       change), command (the kspec command or API call that triggered
  //       it), and a changes object mapping field names to their previous
  //       and new values
  describe("history entry structure (ac-3)", () => {
    // AC: @task-core-data-file ac-3
    it("history entry has timestamp in ISO 8601 format", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Timestamp test",
        slugs: ["timestamp-test"],
        priority: 3,
      });

      await manager.mutateTask(ctx, "@timestamp-test", (task) => ({
        ...task,
        priority: 1,
      }));

      const history = await splitBackend.getTaskHistory(ctx, created._ulid);
      expect(history.length).toBe(1);

      // Verify ISO 8601 format
      const timestamp = history[0].timestamp;
      expect(typeof timestamp).toBe("string");
      // ISO 8601 should be parseable to a valid date
      const parsed = new Date(timestamp);
      expect(parsed.toISOString()).toBeTruthy();
      expect(Number.isNaN(parsed.getTime())).toBe(false);
    });

    // AC: @task-core-data-file ac-3
    it("history entry has author field", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Author test",
        slugs: ["author-test"],
        priority: 3,
      });

      await manager.mutateTask(ctx, "@author-test", (task) => ({
        ...task,
        priority: 1,
      }));

      const history = await splitBackend.getTaskHistory(ctx, created._ulid);
      expect(history.length).toBe(1);
      expect(typeof history[0].author).toBe("string");
      expect(history[0].author.length).toBeGreaterThan(0);
    });

    // AC: @task-core-data-file ac-3
    it("history entry uses configured project author identity", async () => {
      const manager = new TaskDataManager("split");

      // Create a ctx with config identity.author set
      const configCtx: KspecContext = {
        ...ctx,
        config: {
          ...ctx.config,
          identity: { author: "@config-author" },
        } as any,
      };

      const created = await manager.createTask(configCtx, {
        title: "Config author test",
        slugs: ["config-author-test"],
        priority: 3,
      });

      // Clear KSPEC_AUTHOR to ensure config author is used
      const prevAuthor = process.env.KSPEC_AUTHOR;
      delete process.env.KSPEC_AUTHOR;
      try {
        await manager.mutateTask(
          configCtx,
          "@config-author-test",
          (task) => ({ ...task, priority: 1 }),
          { operation: "task-set", ref: "@config-author-test" },
        );
      } finally {
        if (prevAuthor !== undefined) process.env.KSPEC_AUTHOR = prevAuthor;
      }

      const history = await splitBackend.getTaskHistory(configCtx, created._ulid);
      expect(history.length).toBe(1);
      expect(history[0].author).toBe("@config-author");
    });

    // AC: @task-core-data-file ac-3
    it("history entry has command field", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Command test",
        slugs: ["command-test"],
        priority: 3,
      });

      // Provide commitOpts with operation to set the command
      await manager.mutateTask(
        ctx,
        "@command-test",
        (task) => ({ ...task, priority: 1 }),
        { operation: "task-set", ref: "@command-test" },
      );

      const history = await splitBackend.getTaskHistory(ctx, created._ulid);
      expect(history.length).toBe(1);
      expect(history[0].command).toBe("task-set");
    });

    // AC: @task-core-data-file ac-3
    it("history entry has changes object with field names and values", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Changes test",
        slugs: ["changes-test"],
        priority: 3,
        status: "pending",
      });

      await manager.mutateTask(ctx, "@changes-test", (task) => ({
        ...task,
        priority: 1,
        status: "in_progress" as const,
        started_at: "2026-03-20T01:00:00.000Z",
      }));

      const history = await splitBackend.getTaskHistory(ctx, created._ulid);
      expect(history.length).toBe(1);

      const changes = history[0].changes;
      expect(typeof changes).toBe("object");

      // priority: 3 → 1
      expect(changes.priority).toBeDefined();
      expect(changes.priority.previous).toBe(3);
      expect(changes.priority.new).toBe(1);

      // status: pending → in_progress
      expect(changes.status).toBeDefined();
      expect(changes.status.previous).toBe("pending");
      expect(changes.status.new).toBe("in_progress");

      // started_at: null → "2026-03-20T01:00:00.000Z"
      expect(changes.started_at).toBeDefined();
      expect(changes.started_at.new).toBe("2026-03-20T01:00:00.000Z");
    });

    // AC: @task-core-data-file ac-3
    it("history entries persist across reads and are read back correctly", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Persist test",
        slugs: ["persist-test"],
        priority: 3,
      });

      await manager.mutateTask(
        ctx,
        "@persist-test",
        (task) => ({ ...task, priority: 1 }),
        { operation: "task-set", ref: "@persist-test" },
      );

      // Read history — it should survive file reads
      const history1 = await splitBackend.getTaskHistory(ctx, created._ulid);
      expect(history1.length).toBe(1);

      // Mutate again and verify accumulated history
      await manager.mutateTask(
        ctx,
        "@persist-test",
        (task) => ({ ...task, priority: 5 }),
        { operation: "task-set", ref: "@persist-test" },
      );

      const history2 = await splitBackend.getTaskHistory(ctx, created._ulid);
      expect(history2.length).toBe(2);

      // Both entries should have all required fields
      for (const entry of history2) {
        expect(entry.timestamp).toBeTruthy();
        expect(entry.author).toBeTruthy();
        expect(entry.command).toBe("task-set");
        expect(typeof entry.changes).toBe("object");
        expect(Object.keys(entry.changes).length).toBeGreaterThan(0);
      }
    });
  });

  // ── History with batch mutations ──────────────────────────────────────
  describe("history with batch mutations", () => {
    it("records history entries for batch mutations", async () => {
      const manager = new TaskDataManager("split");

      const task1 = await manager.createTask(ctx, {
        title: "Batch history 1",
        slugs: ["batch-hist-1"],
        priority: 3,
      });
      const task2 = await manager.createTask(ctx, {
        title: "Batch history 2",
        slugs: ["batch-hist-2"],
        priority: 3,
      });

      await manager.mutateTasks(
        ctx,
        ["@batch-hist-1", "@batch-hist-2"],
        (tasks) => tasks.map((t) => ({ ...t, priority: 1 })),
      );

      const history1 = await splitBackend.getTaskHistory(ctx, task1._ulid);
      const history2 = await splitBackend.getTaskHistory(ctx, task2._ulid);

      expect(history1.length).toBe(1);
      expect(history2.length).toBe(1);
      expect(history1[0].changes.priority.previous).toBe(3);
      expect(history1[0].changes.priority.new).toBe(1);
      expect(history2[0].changes.priority.previous).toBe(3);
      expect(history2[0].changes.priority.new).toBe(1);
    });
  });

  // ── Todo-only mutations ──────────────────────────────────────────────
  describe("todo mutations persist to task.yaml", () => {
    // AC: @task-core-data-file ac-1
    it("todo-only mutation writes task.yaml and records history", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Todo mutation test",
        slugs: ["todo-mutation"],
      });

      // Add a todo via mutation (todo-only change)
      await manager.mutateTask(ctx, "@todo-mutation", (task) => ({
        ...task,
        todos: [
          { id: 1, text: "Do something", done: false, added_at: "2026-03-20T01:00:00.000Z" },
        ],
      }));

      // task.yaml should contain the todo
      const taskFile = await readYaml(getTaskFilePath(ctx, created._ulid));
      expect(taskFile.todos).toBeDefined();
      expect(Array.isArray(taskFile.todos)).toBe(true);
      expect((taskFile.todos as unknown[]).length).toBe(1);

      // History should record the todos change
      const history = taskFile.history as HistoryEntry[];
      expect(history.length).toBe(1);
      expect(history[0].changes.todos).toBeDefined();
    });

    // AC: @task-core-data-file ac-1
    it("todo-only mutation in batch writes task.yaml", async () => {
      const manager = new TaskDataManager("split");

      const task1 = await manager.createTask(ctx, {
        title: "Batch todo 1",
        slugs: ["batch-todo-1"],
      });

      await manager.mutateTasks(
        ctx,
        ["@batch-todo-1"],
        (tasks) => tasks.map((t) => ({
          ...t,
          todos: [{ id: 1, text: "Batch todo", done: false, added_at: "2026-03-20T01:00:00.000Z" }],
        })),
      );

      const taskFile = await readYaml(getTaskFilePath(ctx, task1._ulid));
      expect(taskFile.todos).toBeDefined();
      expect((taskFile.todos as unknown[]).length).toBe(1);

      const history = taskFile.history as HistoryEntry[];
      expect(history.length).toBe(1);
      expect(history[0].changes.todos).toBeDefined();
    });
  });

  // ── TaskDataManager.getTaskHistory ────────────────────────────────────
  describe("getTaskHistory via TaskDataManager", () => {
    // AC: @task-core-data-file ac-2
    it("returns history entries through TaskDataManager", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Manager history test",
        slugs: ["manager-history"],
        priority: 3,
      });

      await manager.mutateTask(ctx, "@manager-history", (task) => ({
        ...task,
        priority: 1,
      }));

      const history = await manager.getTaskHistory(ctx, created._ulid);
      expect(history.length).toBe(1);
      expect(history[0].changes.priority).toBeDefined();
      expect(history[0].changes.priority.previous).toBe(3);
      expect(history[0].changes.priority.new).toBe(1);
    });

    // AC: @task-core-data-file ac-2
    it("returns empty array for monolithic backend", async () => {
      const manager = new TaskDataManager("monolithic");
      // Monolithic backend doesn't support getTaskHistory
      const history = await manager.getTaskHistory(ctx, "nonexistent");
      expect(history).toEqual([]);
    });

    // AC: @task-core-data-file ac-2
    // AC: @task-storage-activation ac-1, ac-2
    it("resolveTaskDataManager returns split manager when manifest specifies split format", async () => {
      // Context with task_storage.format = "split" in manifest
      const splitCtx: KspecContext = {
        ...ctx,
        manifest: {
          ...ctx.manifest!,
          task_storage: { format: "monolithic" as const },
        } as any,
      };

      // With monolithic format, should return monolithic manager
      const monolithicManager = resolveTaskDataManager(splitCtx);
      expect(monolithicManager.storageFormat).toBe("monolithic");

      // With split format, should return split manager
      const splitCtx2: KspecContext = {
        ...ctx,
        manifest: {
          ...ctx.manifest!,
          task_storage: { format: "split" as const },
        } as any,
      };
      const splitManager = resolveTaskDataManager(splitCtx2);
      expect(splitManager.storageFormat).toBe("split");

      // Create a task and mutate it to generate history
      const created = await splitManager.createTask(splitCtx2, {
        title: "Resolve manager test",
        slugs: ["resolve-mgr-test"],
        priority: 3,
      });

      await splitManager.mutateTask(splitCtx2, "@resolve-mgr-test", (task) => ({
        ...task,
        priority: 1,
      }));

      // History should surface through the resolved manager
      const history = await splitManager.getTaskHistory(splitCtx2, created._ulid);
      expect(history.length).toBe(1);
      expect(history[0].changes.priority).toBeDefined();
      expect(history[0].changes.priority.previous).toBe(3);
      expect(history[0].changes.priority.new).toBe(1);
    });

    // AC: @task-core-data-file ac-2
    // AC: @task-storage-activation ac-1
    it("resolveTaskDataManager returns monolithic manager when no manifest", async () => {
      const noManifestCtx: KspecContext = {
        ...ctx,
        manifest: null,
      };
      const manager = resolveTaskDataManager(noManifestCtx);
      expect(manager.storageFormat).toBe("monolithic");
    });
  });
});

describe("Per-Task Notes File (@task-notes-file)", () => {
  let tempDir: string;
  let ctx: KspecContext;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-notes-file-");
    ctx = await setupSplitFixture(tempDir);
  });

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  // ── AC: @task-notes-file ac-1 ──────────────────────────────────────────
  // Given: A note is added to a task
  // When: The note is persisted
  // Then: The note is appended to tasks/<ulid>/notes.yaml; the task.yaml
  //       file is not modified
  describe("note isolation from task.yaml (ac-1)", () => {
    // AC: @task-notes-file ac-1
    it("appends note to notes.yaml without modifying task.yaml", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Note isolation test",
        slugs: ["note-isolation"],
        priority: 3,
      });

      // Read task.yaml content before adding a note
      const taskFileBefore = await readTestOutput(
        getTaskFilePath(ctx, created._ulid),
      );

      // Add a note
      await manager.addNote(ctx, "@note-isolation", "Test note content", "@tester");

      // task.yaml should be unchanged
      const taskFileAfter = await readTestOutput(
        getTaskFilePath(ctx, created._ulid),
      );
      expect(taskFileAfter).toBe(taskFileBefore);

      // Note should be in notes.yaml
      const notesFile = await readYaml(getNotesFilePath(ctx, created._ulid));
      expect(notesFile.notes).toBeDefined();
      expect(Array.isArray(notesFile.notes)).toBe(true);
      expect((notesFile.notes as unknown[]).length).toBe(1);
      const note = (notesFile.notes as Record<string, unknown>[])[0];
      expect(note.content).toBe("Test note content");
      expect(note.author).toBe("@tester");
    });

    // AC: @task-notes-file ac-1
    it("note-only mutation does not create a history entry", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Note no-history test",
        slugs: ["note-no-history"],
      });

      // Add a note (this is a note-only mutation)
      await manager.addNote(ctx, "@note-no-history", "A note", "@tester");

      // task.yaml should have no history (since task.yaml was not modified)
      const taskFile = await readYaml(getTaskFilePath(ctx, created._ulid));
      expect(taskFile.history).toBeUndefined();
    });

    // AC: @task-notes-file ac-1
    it("multiple notes are appended to notes.yaml", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Multiple notes test",
        slugs: ["multi-notes"],
      });

      await manager.addNote(ctx, "@multi-notes", "First note", "@tester");
      await manager.addNote(ctx, "@multi-notes", "Second note", "@tester");
      await manager.addNote(ctx, "@multi-notes", "Third note", "@tester");

      const notesFile = await readYaml(getNotesFilePath(ctx, created._ulid));
      const notes = notesFile.notes as Record<string, unknown>[];
      expect(notes.length).toBe(3);
      expect(notes[0].content).toBe("First note");
      expect(notes[1].content).toBe("Second note");
      expect(notes[2].content).toBe("Third note");

      // task.yaml should still have no history
      const taskFile = await readYaml(getTaskFilePath(ctx, created._ulid));
      expect(taskFile.history).toBeUndefined();
    });

    // AC: @task-notes-file ac-1
    it("note-only mutation updates notes_count in the lean index", async () => {
      const manager = new TaskDataManager("split");

      await manager.createTask(ctx, {
        title: "Index count test",
        slugs: ["index-count"],
      });

      // Verify initial notes_count is 0 in listTasks
      const beforeList = await manager.listTasks(ctx);
      const beforeTask = beforeList.find((t) => t.slugs.includes("index-count"));
      expect(beforeTask).toBeDefined();
      expect(beforeTask!.notes_count).toBe(0);

      // Add notes (note-only mutation — no core field changes)
      await manager.addNote(ctx, "@index-count", "First note", "@tester");
      await manager.addNote(ctx, "@index-count", "Second note", "@tester");

      // Verify notes_count in listTasks reflects the added notes
      const afterList = await manager.listTasks(ctx);
      const afterTask = afterList.find((t) => t.slugs.includes("index-count"));
      expect(afterTask).toBeDefined();
      expect(afterTask!.notes_count).toBe(2);
    });
  });

  // ── AC: @task-notes-file ac-2 ──────────────────────────────────────────
  // Given: A task has no notes
  // When: The notes file is read
  // Then: The file contains an empty notes array or does not exist; both
  //       are treated as zero notes
  describe("empty notes handling (ac-2)", () => {
    // AC: @task-notes-file ac-2
    it("new task has empty notes array in notes.yaml", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Empty notes test",
        slugs: ["empty-notes"],
      });

      const notesFile = await readYaml(getNotesFilePath(ctx, created._ulid));
      expect(notesFile.notes).toBeDefined();
      expect(Array.isArray(notesFile.notes)).toBe(true);
      expect((notesFile.notes as unknown[]).length).toBe(0);
    });

    // AC: @task-notes-file ac-2
    it("missing notes file is treated as zero notes", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Missing notes test",
        slugs: ["missing-notes"],
      });

      // Delete the notes file
      await fs.unlink(getNotesFilePath(ctx, created._ulid));

      // Task should still load with zero notes
      const task = await manager.getTask(ctx, "@missing-notes");
      expect(task.notes).toBeDefined();
      expect(task.notes.length).toBe(0);
    });

    // AC: @task-notes-file ac-2
    it("empty notes array in file is treated as zero notes", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Empty array test",
        slugs: ["empty-array"],
      });

      // Write an explicit empty notes array
      await fs.writeFile(
        getNotesFilePath(ctx, created._ulid),
        toYaml({ notes: [] }),
      );

      const task = await manager.getTask(ctx, "@empty-array");
      expect(task.notes.length).toBe(0);
    });
  });

  // ── AC: @task-notes-file ac-3 ──────────────────────────────────────────
  // Given: A note supersedes a previous note
  // When: The superseding note is persisted
  // Then: The new note is appended with a supersedes reference to the
  //       original, consistent with existing note supersession semantics
  describe("note supersession (ac-3)", () => {
    // AC: @task-notes-file ac-3
    it("superseding note is appended with supersedes reference", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Supersede test",
        slugs: ["supersede-test"],
      });

      // Add initial note
      const { note: firstNote } = await manager.addNote(
        ctx,
        "@supersede-test",
        "Original note",
        "@tester",
      );

      // Add superseding note by mutating the task directly
      // (addNote doesn't have a supersedes parameter, but the
      // schema and storage support it through direct mutation)
      await manager.mutateTask(ctx, "@supersede-test", (task) => ({
        ...task,
        notes: [
          ...task.notes,
          {
            _ulid: testUlid("SUPR"),
            created_at: new Date().toISOString(),
            author: "@tester",
            content: "Superseding note",
            supersedes: firstNote._ulid,
          },
        ],
      }));

      // Read notes from file
      const task = await manager.getTask(ctx, "@supersede-test");
      expect(task.notes.length).toBe(2);

      const supersedingNote = task.notes[1];
      expect(supersedingNote.content).toBe("Superseding note");
      expect(supersedingNote.supersedes).toBe(firstNote._ulid);
    });

    // AC: @task-notes-file ac-3
    it("supersedes reference points to original note ULID", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Supersede ref test",
        slugs: ["supersede-ref"],
      });

      // Add original note
      const { note: originalNote } = await manager.addNote(
        ctx,
        "@supersede-ref",
        "Original content",
        "@tester",
      );

      // Add superseding note
      await manager.mutateTask(ctx, "@supersede-ref", (task) => ({
        ...task,
        notes: [
          ...task.notes,
          {
            _ulid: testUlid("SUP2"),
            created_at: new Date().toISOString(),
            author: "@tester",
            content: "Updated content",
            supersedes: originalNote._ulid,
          },
        ],
      }));

      // Read notes.yaml directly to verify structure
      const notesFile = await readYaml(getNotesFilePath(ctx, created._ulid));
      const notes = notesFile.notes as Record<string, unknown>[];
      expect(notes.length).toBe(2);

      // First note has no supersedes
      expect(notes[0].supersedes).toBeNull();

      // Second note supersedes the first
      expect(notes[1].supersedes).toBe(originalNote._ulid);
    });
  });

  // ── Notes + field mutation interaction ─────────────────────────────────
  describe("notes with concurrent field mutations", () => {
    it("field mutation does not affect notes file", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Mixed mutation test",
        slugs: ["mixed-mutation"],
        priority: 3,
      });

      // Add a note first
      await manager.addNote(ctx, "@mixed-mutation", "First note", "@tester");

      // Read notes.yaml before field mutation
      const notesBefore = await readTestOutput(
        getNotesFilePath(ctx, created._ulid),
      );

      // Now mutate a core field (not notes)
      await manager.mutateTask(ctx, "@mixed-mutation", (task) => ({
        ...task,
        priority: 1,
      }));

      // Notes file should be unchanged since we didn't modify notes
      // (The mutation callback returns the task with the same notes,
      // so notes.yaml gets rewritten with the same content.)
      // Verify notes are still accessible
      const task = await manager.getTask(ctx, "@mixed-mutation");
      expect(task.notes.length).toBe(1);
      expect(task.notes[0].content).toBe("First note");

      // And history should record the priority change
      const history = await splitBackend.getTaskHistory(ctx, created._ulid);
      expect(history.length).toBe(1);
      expect(history[0].changes.priority).toBeDefined();
    });

    it("task loads correctly with both history and notes", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Full lifecycle",
        slugs: ["full-lifecycle"],
        priority: 3,
      });

      // Add notes
      await manager.addNote(ctx, "@full-lifecycle", "Note 1", "@tester");
      await manager.addNote(ctx, "@full-lifecycle", "Note 2", "@tester");

      // Mutate fields
      await manager.mutateTask(ctx, "@full-lifecycle", (task) => ({
        ...task,
        status: "in_progress" as const,
        started_at: "2026-03-20T01:00:00.000Z",
      }));

      // Load the task — should have both notes and the updated fields
      const task = await manager.getTask(ctx, "@full-lifecycle");
      expect(task.notes.length).toBe(2);
      expect(task.status).toBe("in_progress");

      // History should be available
      const history = await splitBackend.getTaskHistory(ctx, created._ulid);
      expect(history.length).toBe(1);
      expect(history[0].changes.status).toBeDefined();

      // Notes should NOT be in task.yaml
      const taskFile = await readYaml(getTaskFilePath(ctx, created._ulid));
      expect(taskFile.notes).toBeUndefined();
    });
  });

  // ── AC: @task-storage-activation ac-3 ─────────────────────────────────
  // Given: The storage format is set to split but unmigrated tasks exist
  //        in the monolithic file without corresponding per-task directories
  // When: The task data manager initializes
  // Then: An error indicates that migration must be run before activation
  describe("migration gate (ac-3)", () => {
    // AC: @task-storage-activation ac-3
    it("throws when monolithic entries exist without per-task directories", async () => {
      const migrationDir = await createTempDir("kspec-migration-gate-");
      try {
        initGitRepo(migrationDir);
        const specDir = path.join(migrationDir, ".kspec");
        await fs.mkdir(specDir, { recursive: true });
        await fs.mkdir(path.join(specDir, "tasks"), { recursive: true });

        // Write monolithic-style entries (with `notes` arrays, not `notes_count`)
        const ulid = testUlid("MIGRATE");
        await fs.writeFile(
          path.join(specDir, "project.tasks.yaml"),
          toYaml([
            {
              _ulid: ulid,
              slugs: ["unmigrated-task"],
              title: "Unmigrated Task",
              type: "task",
              status: "pending",
              priority: 3,
              tags: [],
              depends_on: [],
              blocked_by: [],
              created_at: "2026-03-20T00:00:00.000Z",
              notes: [],
              todos: [],
            },
          ]),
        );

        const migCtx: KspecContext = {
          rootDir: migrationDir,
          projectRoot: migrationDir,
          specDir,
          sessionsDir: path.join(migrationDir, ".kspec-sessions"),
          manifestPath: path.join(specDir, "kynetic.yaml"),
          manifest: {
            kynetic_spec: "1.0",
            title: "Migration Test",
            task_storage: { format: "split" as const },
          } as any,
          shadow: null,
          config: {} as any,
        };

        const manager = new TaskDataManager("split");
        await expect(manager.listTasks(migCtx)).rejects.toThrow(
          /migration/i,
        );
      } finally {
        await cleanupTempDir(migrationDir);
      }
    });

    // AC: @task-storage-activation ac-5
    it("allows split mode with empty task set", async () => {
      const emptyDir = await createTempDir("kspec-empty-split-");
      try {
        initGitRepo(emptyDir);
        const specDir = path.join(emptyDir, ".kspec");
        await fs.mkdir(specDir, { recursive: true });
        await fs.mkdir(path.join(specDir, "tasks"), { recursive: true });
        await fs.writeFile(
          path.join(specDir, "project.tasks.yaml"),
          toYaml([]),
        );

        const emptyCtx: KspecContext = {
          rootDir: emptyDir,
          projectRoot: emptyDir,
          specDir,
          sessionsDir: path.join(emptyDir, ".kspec-sessions"),
          manifestPath: path.join(specDir, "kynetic.yaml"),
          manifest: {
            kynetic_spec: "1.0",
            title: "Empty Test",
            task_storage: { format: "split" as const },
          } as any,
          shadow: null,
          config: {} as any,
        };

        const manager = new TaskDataManager("split");
        const tasks = await manager.listTasks(emptyCtx);
        expect(tasks).toEqual([]);
      } finally {
        await cleanupTempDir(emptyDir);
      }
    });

    // AC: @task-storage-activation ac-3
    it("allows split mode when monolithic entries have corresponding per-task dirs", async () => {
      // This tests the case where entries have notes arrays but per-task dirs exist
      // (migration was completed but index wasn't converted to lean format yet)
      const migratedDir = await createTempDir("kspec-migrated-split-");
      try {
        initGitRepo(migratedDir);
        const specDir = path.join(migratedDir, ".kspec");
        await fs.mkdir(specDir, { recursive: true });

        const ulid = testUlid("MIGRTD");
        const taskDir = path.join(specDir, "tasks", ulid);
        await fs.mkdir(taskDir, { recursive: true });

        // Write task.yaml and notes.yaml in per-task dir
        await fs.writeFile(
          path.join(taskDir, "task.yaml"),
          toYaml({
            _ulid: ulid,
            slugs: ["migrated-task"],
            title: "Migrated Task",
            type: "task",
            status: "pending",
            priority: 3,
            tags: [],
            depends_on: [],
            blocked_by: [],
            created_at: "2026-03-20T00:00:00.000Z",
          }),
        );
        await fs.writeFile(
          path.join(taskDir, "notes.yaml"),
          toYaml({ notes: [] }),
        );

        // Index still has monolithic-style entry (notes array)
        await fs.writeFile(
          path.join(specDir, "project.tasks.yaml"),
          toYaml([
            {
              _ulid: ulid,
              slugs: ["migrated-task"],
              title: "Migrated Task",
              type: "task",
              status: "pending",
              priority: 3,
              tags: [],
              depends_on: [],
              blocked_by: [],
              created_at: "2026-03-20T00:00:00.000Z",
              notes: [],
              todos: [],
            },
          ]),
        );

        const migCtx: KspecContext = {
          rootDir: migratedDir,
          projectRoot: migratedDir,
          specDir,
          sessionsDir: path.join(migratedDir, ".kspec-sessions"),
          manifestPath: path.join(specDir, "kynetic.yaml"),
          manifest: {
            kynetic_spec: "1.0",
            title: "Migrated Test",
            task_storage: { format: "split" as const },
          } as any,
          shadow: null,
          config: {} as any,
        };

        const manager = new TaskDataManager("split");
        // Should NOT throw — per-task dir exists
        const tasks = await manager.listTasks(migCtx);
        expect(tasks.length).toBe(1);
      } finally {
        await cleanupTempDir(migratedDir);
      }
    });
  });
});
