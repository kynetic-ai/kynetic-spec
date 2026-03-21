import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TaskDataManager,
  registerBackend,
  unregisterBackend,
} from "../src/parser/task-data-manager.js";
import {
  splitBackend,
  ensureSplitBackendRegistered,
  getTaskDir,
  getTaskFilePath,
  getNotesFilePath,
  getTasksDir,
  getIndexFilePath,
  listTaskDirs,
  detectSplitFormat,
  getOperationRouting,
  toIndexEntry,
  indexEntriesEqual,
} from "../src/parser/split-backend.js";

// Register the split backend (no longer auto-registered at module scope)
ensureSplitBackendRegistered();
import { initContext } from "../src/parser/yaml.js";
import type { KspecContext } from "../src/parser/yaml.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  testUlid,
  testUlids,
} from "./helpers/cli.js";
import { toYaml } from "../src/parser/yaml.js";

/**
 * Helper: set up a split storage environment in a temp directory.
 * Creates the necessary directory structure and index file.
 */
async function setupSplitFixture(tempDir: string): Promise<KspecContext> {
  // Initialize git repo (required for kspec context)
  initGitRepo(tempDir);

  // Create .kspec directory structure
  const specDir = path.join(tempDir, ".kspec");
  await fs.mkdir(specDir, { recursive: true });

  // Write a minimal kynetic.yaml manifest
  await fs.writeFile(
    path.join(specDir, "kynetic.yaml"),
    toYaml({ kynetic_spec: "1.0", title: "Test Project" }),
  );

  // Create tasks directory
  const tasksDir = path.join(specDir, "tasks");
  await fs.mkdir(tasksDir, { recursive: true });

  // Write an empty index file
  await fs.writeFile(
    path.join(specDir, "project.tasks.yaml"),
    toYaml([]),
  );

  // Set up shadow-like context
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
 * Helper: create a task in split format (task directory + index entry).
 */
async function createSplitTask(
  ctx: KspecContext,
  ulid: string,
  slug: string,
  options: { notes?: Array<{ _ulid: string; content: string; created_at: string }>; extraFiles?: Record<string, string> } = {},
): Promise<void> {
  const taskDir = getTaskDir(ctx, ulid);
  await fs.mkdir(taskDir, { recursive: true });

  // Write task.yaml (core data without notes)
  const coreData = {
    _ulid: ulid,
    slugs: [slug],
    title: `Task ${slug}`,
    type: "task",
    status: "pending",
    priority: 3,
    tags: ["test"],
    depends_on: [],
    blocked_by: [],
    created_at: "2026-03-20T00:00:00.000Z",
    todos: [],
  };
  await fs.writeFile(
    path.join(taskDir, "task.yaml"),
    toYaml(coreData),
  );

  // Write notes.yaml
  const notes = options.notes || [];
  await fs.writeFile(
    path.join(taskDir, "notes.yaml"),
    toYaml({ notes }),
  );

  // Write any extra files
  if (options.extraFiles) {
    for (const [name, content] of Object.entries(options.extraFiles)) {
      await fs.writeFile(path.join(taskDir, name), content);
    }
  }

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
    status: "pending",
    priority: 3,
    tags: ["test"],
    depends_on: [],
    blocked_by: [],
    created_at: "2026-03-20T00:00:00.000Z",
  });

  await fs.writeFile(indexPath, toYaml(indexTasks));
}

describe("SplitBackend", () => {
  let tempDir: string;
  let ctx: KspecContext;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-split-test-");
    ctx = await setupSplitFixture(tempDir);
  });

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  // ── AC: @task-directory-storage ac-1 ────────────────────────────────────
  // Given: A task exists in the system
  // When: The task is persisted
  // Then: The task has its own directory named by its full ULID
  describe("per-task directory by ULID (ac-1)", () => {
    // AC: @task-directory-storage ac-1
    it("creates a directory named by full ULID when a task is created", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "ULID-dir test task",
        slugs: ["ulid-dir-test"],
      });

      const expectedDir = getTaskDir(ctx, created._ulid);
      const stat = await fs.stat(expectedDir);
      expect(stat.isDirectory()).toBe(true);

      // Verify the directory name IS the full ULID
      const dirName = path.basename(expectedDir);
      expect(dirName).toBe(created._ulid);
      expect(dirName.length).toBe(26); // Full ULID length
    });

    // AC: @task-directory-storage ac-1
    it("uses the full 26-character ULID as directory name", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Full ULID test",
        slugs: ["full-ulid-test"],
      });

      const taskDirs = await listTaskDirs(ctx);
      expect(taskDirs).toContain(created._ulid);
      expect(taskDirs.every((d) => d.length === 26)).toBe(true);
    });

    // AC: @task-directory-storage ac-1
    it("directory layout follows .kspec/tasks/<full-ulid>/", async () => {
      const ulid = testUlid("DRKY");
      await createSplitTask(ctx, ulid, "layout-test");

      const taskDir = getTaskDir(ctx, ulid);
      const expectedPath = path.join(ctx.specDir, "tasks", ulid);
      expect(taskDir).toBe(expectedPath);

      const stat = await fs.stat(taskDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  // ── AC: @task-directory-storage ac-2 ────────────────────────────────────
  // Given: A task is persisted
  // When: The task directory is examined
  // Then: Core task data and notes are stored in separate files within the directory
  describe("separate files for core data and notes (ac-2)", () => {
    // AC: @task-directory-storage ac-2
    it("stores core data in task.yaml and notes in notes.yaml", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Separate files test",
        slugs: ["separate-files"],
      });

      const taskFilePath = getTaskFilePath(ctx, created._ulid);
      const notesFilePath = getNotesFilePath(ctx, created._ulid);

      // Both files should exist
      const taskStat = await fs.stat(taskFilePath);
      expect(taskStat.isFile()).toBe(true);

      const notesStat = await fs.stat(notesFilePath);
      expect(notesStat.isFile()).toBe(true);
    });

    // AC: @task-directory-storage ac-2
    it("task.yaml contains core data without notes array", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Core data test",
        slugs: ["core-data-test"],
        description: "A task with description",
        priority: 2,
        tags: ["feature"],
      });

      const taskFilePath = getTaskFilePath(ctx, created._ulid);
      const content = await fs.readFile(taskFilePath, "utf-8");
      const { parse } = await import("yaml");
      const parsed = parse(content);

      // Core data fields present
      expect(parsed._ulid).toBe(created._ulid);
      expect(parsed.title).toBe("Core data test");
      expect(parsed.priority).toBe(2);
      expect(parsed.tags).toContain("feature");

      // Notes should NOT be in task.yaml
      expect(parsed.notes).toBeUndefined();
    });

    // AC: @task-directory-storage ac-2
    it("notes.yaml contains the notes array", async () => {
      const ulid = testUlid("N0TE");
      const noteUlid = testUlid("ANOT", 1);
      await createSplitTask(ctx, ulid, "notes-test", {
        notes: [
          { _ulid: noteUlid, content: "Test note", created_at: "2026-03-20T00:00:00.000Z" },
        ],
      });

      const notesFilePath = getNotesFilePath(ctx, ulid);
      const content = await fs.readFile(notesFilePath, "utf-8");
      const { parse } = await import("yaml");
      const parsed = parse(content);

      expect(parsed.notes).toBeDefined();
      expect(parsed.notes.length).toBe(1);
      expect(parsed.notes[0].content).toBe("Test note");
    });

    // AC: @task-directory-storage ac-2
    it("assembled task has data from both files", async () => {
      const ulid = testUlid("ASMB");
      const noteUlid = testUlid("ANT2", 1);
      await createSplitTask(ctx, ulid, "assembled-test", {
        notes: [
          { _ulid: noteUlid, content: "Assembly note", created_at: "2026-03-20T00:00:00.000Z" },
        ],
      });

      const task = await splitBackend.getTask(ctx, ulid);
      expect(task).toBeDefined();
      expect(task!.title).toBe("Task assembled-test");
      expect(task!.notes.length).toBe(1);
      expect(task!.notes[0].content).toBe("Assembly note");
    });
  });

  // ── AC: @task-directory-storage ac-3 ────────────────────────────────────
  // Given: A task directory exists
  // When: Unknown files or directories are placed within it
  // Then: The task system ignores them and preserves them across reads and writes
  describe("unknown files preserved (ac-3)", () => {
    // AC: @task-directory-storage ac-3
    it("ignores unknown files in the task directory during reads", async () => {
      const ulid = testUlid("XTRA");
      await createSplitTask(ctx, ulid, "extra-files-test", {
        extraFiles: {
          "custom-data.json": '{"custom": true}',
          "readme.md": "# Custom readme",
        },
      });

      // Reading the task should succeed despite unknown files
      const task = await splitBackend.getTask(ctx, ulid);
      expect(task).toBeDefined();
      expect(task!.title).toBe("Task extra-files-test");
    });

    // AC: @task-directory-storage ac-3
    it("preserves unknown files across mutations", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Preserve test",
        slugs: ["preserve-test"],
      });

      // Add an unknown file to the task directory
      const taskDir = getTaskDir(ctx, created._ulid);
      const customFilePath = path.join(taskDir, "custom-metadata.json");
      await fs.writeFile(customFilePath, '{"preserved": true}');

      // Mutate the task
      await manager.mutateTask(ctx, "@preserve-test", (task) => ({
        ...task,
        priority: 1,
      }));

      // Verify the unknown file still exists
      const customContent = await fs.readFile(customFilePath, "utf-8");
      expect(customContent).toBe('{"preserved": true}');
    });

    // AC: @task-directory-storage ac-3
    it("preserves unknown subdirectories across mutations", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Subdir preserve test",
        slugs: ["subdir-preserve"],
      });

      // Add an unknown subdirectory to the task directory
      const taskDir = getTaskDir(ctx, created._ulid);
      const customDir = path.join(taskDir, "attachments");
      await fs.mkdir(customDir, { recursive: true });
      await fs.writeFile(path.join(customDir, "file.txt"), "attachment data");

      // Mutate the task
      await manager.mutateTask(ctx, "@subdir-preserve", (task) => ({
        ...task,
        tags: [...task.tags, "mutated"],
      }));

      // Verify the unknown subdirectory still exists
      const fileStat = await fs.stat(path.join(customDir, "file.txt"));
      expect(fileStat.isFile()).toBe(true);
      const content = await fs.readFile(path.join(customDir, "file.txt"), "utf-8");
      expect(content).toBe("attachment data");
    });

    // AC: @task-directory-storage ac-3
    it("listTaskDirs ignores non-ULID named entries", async () => {
      const ulid = testUlid("TKDR");
      await createSplitTask(ctx, ulid, "task-dir-test");

      // Add non-ULID entries to the tasks directory
      const tasksDir = getTasksDir(ctx);
      await fs.mkdir(path.join(tasksDir, "not-a-ulid"), { recursive: true });
      await fs.writeFile(path.join(tasksDir, "random.txt"), "ignored");

      const dirs = await listTaskDirs(ctx);
      expect(dirs).toContain(ulid);
      expect(dirs).not.toContain("not-a-ulid");
      expect(dirs.length).toBe(1);
    });
  });

  // ── AC: @task-directory-storage ac-4 ────────────────────────────────────
  // Given: A task is deleted
  // When: The deletion is persisted
  // Then: The task's entire directory is removed
  describe("delete removes entire directory (ac-4)", () => {
    // AC: @task-directory-storage ac-4
    it("removes the entire task directory on delete", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Delete dir test",
        slugs: ["delete-dir-test"],
      });

      const taskDir = getTaskDir(ctx, created._ulid);

      // Verify directory exists before delete
      const statBefore = await fs.stat(taskDir);
      expect(statBefore.isDirectory()).toBe(true);

      // Delete the task
      await manager.deleteTask(ctx, "@delete-dir-test");

      // Verify directory is gone
      await expect(fs.stat(taskDir)).rejects.toThrow();
    });

    // AC: @task-directory-storage ac-4
    it("removes directory including unknown files on delete", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Delete with extras",
        slugs: ["delete-extras"],
      });

      // Add unknown files
      const taskDir = getTaskDir(ctx, created._ulid);
      await fs.writeFile(path.join(taskDir, "custom.json"), "{}");
      await fs.mkdir(path.join(taskDir, "subdir"), { recursive: true });
      await fs.writeFile(path.join(taskDir, "subdir", "nested.txt"), "data");

      // Delete the task
      await manager.deleteTask(ctx, "@delete-extras");

      // Entire directory tree is gone
      await expect(fs.stat(taskDir)).rejects.toThrow();
    });
  });

  // ── AC: @task-directory-storage ac-5 ────────────────────────────────────
  // Given: A task is deleted
  // When: The deletion is persisted
  // Then: The corresponding index entry is removed in the same atomic operation
  //       as the directory removal
  describe("delete removes index entry atomically (ac-5)", () => {
    // AC: @task-directory-storage ac-5
    it("removes the index entry when deleting a task", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Delete index test",
        slugs: ["delete-index-test"],
      });

      // Verify index entry exists
      const summariesBefore = await manager.listTasks(ctx);
      expect(summariesBefore.some((s) => s._ulid === created._ulid)).toBe(true);

      // Delete the task
      await manager.deleteTask(ctx, "@delete-index-test");

      // Verify index entry is gone
      const summariesAfter = await manager.listTasks(ctx);
      expect(summariesAfter.some((s) => s._ulid === created._ulid)).toBe(false);
    });

    // AC: @task-directory-storage ac-5
    it("both directory and index entry are removed together", async () => {
      const manager = new TaskDataManager("split");

      // Create two tasks
      const task1 = await manager.createTask(ctx, {
        title: "Task to delete",
        slugs: ["task-to-delete"],
      });
      const task2 = await manager.createTask(ctx, {
        title: "Task to keep",
        slugs: ["task-to-keep"],
      });

      // Delete only task1
      await manager.deleteTask(ctx, "@task-to-delete");

      // task1 directory gone, task2 directory still present
      const task1Dir = getTaskDir(ctx, task1._ulid);
      const task2Dir = getTaskDir(ctx, task2._ulid);
      await expect(fs.stat(task1Dir)).rejects.toThrow();
      const stat2 = await fs.stat(task2Dir);
      expect(stat2.isDirectory()).toBe(true);

      // Index has only task2
      const summaries = await manager.listTasks(ctx);
      expect(summaries.length).toBe(1);
      expect(summaries[0]._ulid).toBe(task2._ulid);
    });

    // AC: @task-directory-storage ac-5
    it("index and directory removal are in the same operation (no partial state)", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Atomic delete test",
        slugs: ["atomic-delete"],
      });

      // Delete
      await manager.deleteTask(ctx, "@atomic-delete");

      // After delete: both the directory AND the index entry must be gone.
      // If either survived, the operation was not atomic.
      const taskDir = getTaskDir(ctx, created._ulid);
      await expect(fs.stat(taskDir)).rejects.toThrow();

      const summaries = await manager.listTasks(ctx);
      expect(summaries.some((s) => s._ulid === created._ulid)).toBe(false);
    });
  });

  // ── Format Detection ───────────────────────────────────────────────────
  describe("format detection", () => {
    it("detects split format when ULID directories exist", async () => {
      const ulid = testUlid("DTCT");
      await createSplitTask(ctx, ulid, "detect-test");

      const isSplit = await detectSplitFormat(ctx);
      expect(isSplit).toBe(true);
    });

    it("returns false when no task directories exist", async () => {
      const isSplit = await detectSplitFormat(ctx);
      expect(isSplit).toBe(false);
    });

    it("returns false when tasks dir has only non-ULID entries", async () => {
      const tasksDir = getTasksDir(ctx);
      await fs.mkdir(path.join(tasksDir, "not-a-ulid"), { recursive: true });

      const isSplit = await detectSplitFormat(ctx);
      expect(isSplit).toBe(false);
    });
  });

  // ── Operation Routing ──────────────────────────────────────────────────
  describe("operation routing", () => {
    it("list touches only index", () => {
      const routing = getOperationRouting("list");
      expect(routing.touchesIndex).toBe(true);
      expect(routing.touchesCoreData).toBe(false);
      expect(routing.touchesNotes).toBe(false);
    });

    it("get touches only per-task files", () => {
      const routing = getOperationRouting("get");
      expect(routing.touchesIndex).toBe(false);
      expect(routing.touchesCoreData).toBe(true);
      expect(routing.touchesNotes).toBe(true);
    });

    it("create touches all files", () => {
      const routing = getOperationRouting("create");
      expect(routing.touchesIndex).toBe(true);
      expect(routing.touchesCoreData).toBe(true);
      expect(routing.touchesNotes).toBe(true);
    });

    it("note touches only notes.yaml", () => {
      const routing = getOperationRouting("note");
      expect(routing.touchesIndex).toBe(false);
      expect(routing.touchesCoreData).toBe(false);
      expect(routing.touchesNotes).toBe(true);
    });

    it("delete touches all files", () => {
      const routing = getOperationRouting("delete");
      expect(routing.touchesIndex).toBe(true);
      expect(routing.touchesCoreData).toBe(true);
      expect(routing.touchesNotes).toBe(true);
    });
  });

  // ── Directory Layout Helpers ───────────────────────────────────────────
  describe("directory layout helpers", () => {
    it("getTasksDir returns .kspec/tasks/", () => {
      const tasksDir = getTasksDir(ctx);
      expect(tasksDir).toBe(path.join(ctx.specDir, "tasks"));
    });

    it("getTaskDir returns .kspec/tasks/<ulid>/", () => {
      const ulid = testUlid("HELP");
      const taskDir = getTaskDir(ctx, ulid);
      expect(taskDir).toBe(path.join(ctx.specDir, "tasks", ulid));
    });

    it("getTaskFilePath returns .kspec/tasks/<ulid>/task.yaml", () => {
      const ulid = testUlid("HELP");
      const filePath = getTaskFilePath(ctx, ulid);
      expect(filePath).toBe(path.join(ctx.specDir, "tasks", ulid, "task.yaml"));
    });

    it("getNotesFilePath returns .kspec/tasks/<ulid>/notes.yaml", () => {
      const ulid = testUlid("HELP");
      const filePath = getNotesFilePath(ctx, ulid);
      expect(filePath).toBe(path.join(ctx.specDir, "tasks", ulid, "notes.yaml"));
    });
  });

  // ── Backend Integration ────────────────────────────────────────────────
  describe("backend integration with TaskDataManager", () => {
    it("split backend is registered and available", () => {
      const manager = new TaskDataManager("split");
      expect(manager.storageFormat).toBe("split");
    });

    it("createTask persists and is retrievable via getTask", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Roundtrip test",
        slugs: ["roundtrip-test"],
        priority: 2,
        tags: ["feature"],
      });

      const fetched = await manager.getTask(ctx, "@roundtrip-test");
      expect(fetched._ulid).toBe(created._ulid);
      expect(fetched.title).toBe("Roundtrip test");
      expect(fetched.priority).toBe(2);
    });

    it("listTasks returns summaries from index", async () => {
      const manager = new TaskDataManager("split");

      await manager.createTask(ctx, {
        title: "List test 1",
        slugs: ["list-test-1"],
      });
      await manager.createTask(ctx, {
        title: "List test 2",
        slugs: ["list-test-2"],
      });

      const summaries = await manager.listTasks(ctx);
      expect(summaries.length).toBe(2);
      expect(summaries.every((s) => s._ulid && s.title && s.status)).toBe(true);
    });

    it("mutateTask updates and persists changes", async () => {
      const manager = new TaskDataManager("split");

      await manager.createTask(ctx, {
        title: "Mutate test",
        slugs: ["mutate-test"],
      });

      const updated = await manager.mutateTask(ctx, "@mutate-test", (task) => ({
        ...task,
        status: "in_progress" as const,
        started_at: "2026-03-20T01:00:00.000Z",
      }));

      expect(updated.status).toBe("in_progress");

      const reloaded = await manager.getTask(ctx, "@mutate-test");
      expect(reloaded.status).toBe("in_progress");
    });

    it("addNote writes only to notes.yaml", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Note test",
        slugs: ["note-test"],
      });

      // Read task.yaml content before note
      const taskFileBefore = await fs.readFile(
        getTaskFilePath(ctx, created._ulid),
        "utf-8",
      );

      // Add a note
      await manager.addNote(ctx, "@note-test", "Test note content", "@tester");

      // task.yaml should still not contain notes
      // (it will be rewritten because addNote goes through mutateTask,
      // but notes should not appear in task.yaml)
      const taskFileAfter = await fs.readFile(
        getTaskFilePath(ctx, created._ulid),
        "utf-8",
      );
      const { parse } = await import("yaml");
      const parsedAfter = parse(taskFileAfter);
      expect(parsedAfter.notes).toBeUndefined();

      // Notes should be in notes.yaml
      const notesContent = await fs.readFile(
        getNotesFilePath(ctx, created._ulid),
        "utf-8",
      );
      const parsedNotes = parse(notesContent);
      expect(parsedNotes.notes.length).toBe(1);
      expect(parsedNotes.notes[0].content).toBe("Test note content");
    });

    it("loadAllTasks loads from per-task directories", async () => {
      const manager = new TaskDataManager("split");

      await manager.createTask(ctx, {
        title: "Load all test 1",
        slugs: ["load-all-1"],
      });
      await manager.createTask(ctx, {
        title: "Load all test 2",
        slugs: ["load-all-2"],
      });

      const allTasks = await manager.loadAllTasks(ctx);
      expect(allTasks.length).toBe(2);
      expect(allTasks.every((t) => t._ulid && t.title)).toBe(true);
    });

    it("concurrent mutations on different tasks succeed", async () => {
      const manager = new TaskDataManager("split");

      await manager.createTask(ctx, {
        title: "Concurrent task 1",
        slugs: ["concurrent-1"],
      });
      await manager.createTask(ctx, {
        title: "Concurrent task 2",
        slugs: ["concurrent-2"],
      });

      const [r1, r2] = await Promise.all([
        manager.mutateTask(ctx, "@concurrent-1", async (task) => {
          await new Promise((r) => setTimeout(r, 10));
          return { ...task, priority: 1 };
        }),
        manager.mutateTask(ctx, "@concurrent-2", (task) => ({
          ...task,
          priority: 5,
        })),
      ]);

      expect(r1.priority).toBe(1);
      expect(r2.priority).toBe(5);
    });

    it("batch mutation is atomic", async () => {
      const manager = new TaskDataManager("split");

      await manager.createTask(ctx, {
        title: "Batch 1",
        slugs: ["batch-1"],
      });
      await manager.createTask(ctx, {
        title: "Batch 2",
        slugs: ["batch-2"],
      });

      const updated = await manager.mutateTasks(
        ctx,
        ["@batch-1", "@batch-2"],
        (tasks) => tasks.map((t) => ({ ...t, priority: 1 })),
      );

      expect(updated.length).toBe(2);
      expect(updated.every((t) => t.priority === 1)).toBe(true);

      // Verify both persisted
      const r1 = await manager.getTask(ctx, "@batch-1");
      const r2 = await manager.getTask(ctx, "@batch-2");
      expect(r1.priority).toBe(1);
      expect(r2.priority).toBe(1);
    });
  });

  // ── AC: @task-index-file ac-1 ────────────────────────────────────────────
  // Given: Tasks exist in the system
  // When: The index file is read
  // Then: Each entry contains only the fields required for listing,
  //       filtering, and dependency resolution — no notes, history,
  //       or other detail-only data
  describe("index contains only listing/filtering fields (ac-1)", () => {
    // AC: @task-index-file ac-1
    it("index entries exclude notes, todos, description, and history", async () => {
      const manager = new TaskDataManager("split");

      await manager.createTask(ctx, {
        title: "Index fields test",
        slugs: ["index-fields-test"],
        description: "A detailed description that should not appear in index",
        priority: 2,
        tags: ["feature", "mvp"],
      });

      // Read the raw index file to check what fields are persisted
      const indexPath = getIndexFilePath(ctx);
      const content = await fs.readFile(indexPath, "utf-8");
      const { parse } = await import("yaml");
      const parsed = parse(content);
      const indexEntry = Array.isArray(parsed) ? parsed[0] : parsed.tasks[0];

      // Index should have listing/filtering fields
      expect(indexEntry._ulid).toBeDefined();
      expect(indexEntry.slugs).toEqual(["index-fields-test"]);
      expect(indexEntry.title).toBe("Index fields test");
      expect(indexEntry.status).toBe("pending");
      expect(indexEntry.priority).toBe(2);
      expect(indexEntry.tags).toEqual(["feature", "mvp"]);
      expect(indexEntry.depends_on).toEqual([]);
      expect(indexEntry.blocked_by).toEqual([]);
      expect(indexEntry.created_at).toBeDefined();

      // Index must NOT have detail-only data
      expect(indexEntry.notes).toBeUndefined();
      expect(indexEntry.todos).toBeUndefined();
      expect(indexEntry.description).toBeUndefined();
      expect(indexEntry.history).toBeUndefined();
      expect(indexEntry.vcs_refs).toBeUndefined();
      expect(indexEntry.context).toBeUndefined();
    });

    // AC: @task-index-file ac-1
    it("toIndexEntry produces only indexed fields", () => {
      const fullTask = {
        _ulid: testUlid("TIDX"),
        slugs: ["test-task"],
        title: "Test Task",
        type: "task" as const,
        status: "pending" as const,
        priority: 3,
        tags: ["test"],
        depends_on: [],
        blocked_by: [],
        created_at: "2026-03-20T00:00:00.000Z",
        notes: [{ _ulid: testUlid("TNOT", 1), content: "note text", created_at: "2026-03-20T00:00:00.000Z" }],
        todos: [{ id: "t1", text: "todo item", done: false }],
        description: "A description",
        context: ["some-context"],
        vcs_refs: [],
      };

      const entry = toIndexEntry(fullTask as any);

      expect(entry._ulid).toBe(fullTask._ulid);
      expect(entry.title).toBe("Test Task");
      expect(entry.notes_count).toBe(1);
      expect(entry.todos_count).toBe(1);

      // Detail fields must not leak into index
      expect(entry.notes).toBeUndefined();
      expect(entry.todos).toBeUndefined();
      expect(entry.description).toBeUndefined();
      expect(entry.context).toBeUndefined();
      expect(entry.vcs_refs).toBeUndefined();
    });

    // AC: @task-index-file ac-1
    it("listTasks returns summaries without detail data", async () => {
      const manager = new TaskDataManager("split");

      await manager.createTask(ctx, {
        title: "Summary check",
        slugs: ["summary-check"],
        description: "Should not appear in summary",
      });

      // Add a note to verify notes are excluded from summary
      await manager.addNote(ctx, "@summary-check", "A note", "@tester");

      const summaries = await manager.listTasks(ctx);
      expect(summaries.length).toBe(1);

      const summary = summaries[0];
      expect(summary.title).toBe("Summary check");
      expect(summary._ulid).toBeDefined();
      // Summary should have notes_count but NOT notes array contents
      expect(summary.notes_count).toBeGreaterThanOrEqual(0);
      expect((summary as any).notes).toBeUndefined();
      expect((summary as any).description).toBeUndefined();
    });
  });

  // ── AC: @task-index-file ac-2 ────────────────────────────────────────────
  // Given: A task's filterable field changes (status, priority, tags, etc.)
  // When: The mutation is persisted
  // Then: Both the index entry and the per-task file are updated atomically
  describe("index updated on filterable field changes (ac-2)", () => {
    // AC: @task-index-file ac-2
    it("status change updates both index and per-task file", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Status sync test",
        slugs: ["status-sync-test"],
      });

      await manager.mutateTask(ctx, "@status-sync-test", (task) => ({
        ...task,
        status: "in_progress" as const,
        started_at: "2026-03-20T01:00:00.000Z",
      }));

      // Check the index
      const summaries = await manager.listTasks(ctx);
      const summary = summaries.find((s) => s._ulid === created._ulid);
      expect(summary).toBeDefined();
      expect(summary!.status).toBe("in_progress");

      // Check the per-task file
      const fetched = await manager.getTask(ctx, "@status-sync-test");
      expect(fetched.status).toBe("in_progress");
    });

    // AC: @task-index-file ac-2
    it("priority change updates both index and per-task file", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Priority sync test",
        slugs: ["priority-sync-test"],
      });

      await manager.mutateTask(ctx, "@priority-sync-test", (task) => ({
        ...task,
        priority: 1,
      }));

      const summaries = await manager.listTasks(ctx);
      const summary = summaries.find((s) => s._ulid === created._ulid);
      expect(summary!.priority).toBe(1);

      const fetched = await manager.getTask(ctx, "@priority-sync-test");
      expect(fetched.priority).toBe(1);
    });

    // AC: @task-index-file ac-2
    it("tags change updates both index and per-task file", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Tags sync test",
        slugs: ["tags-sync-test"],
        tags: ["original"],
      });

      await manager.mutateTask(ctx, "@tags-sync-test", (task) => ({
        ...task,
        tags: ["original", "new-tag"],
      }));

      const summaries = await manager.listTasks(ctx);
      const summary = summaries.find((s) => s._ulid === created._ulid);
      expect(summary!.tags).toEqual(["original", "new-tag"]);

      const fetched = await manager.getTask(ctx, "@tags-sync-test");
      expect(fetched.tags).toEqual(["original", "new-tag"]);
    });

    // AC: @task-index-file ac-2
    it("batch mutation updates index for all changed tasks", async () => {
      const manager = new TaskDataManager("split");

      await manager.createTask(ctx, {
        title: "Batch idx 1",
        slugs: ["batch-idx-1"],
      });
      await manager.createTask(ctx, {
        title: "Batch idx 2",
        slugs: ["batch-idx-2"],
      });

      await manager.mutateTasks(
        ctx,
        ["@batch-idx-1", "@batch-idx-2"],
        (tasks) => tasks.map((t) => ({ ...t, status: "in_progress" as const, started_at: "2026-03-20T01:00:00.000Z" })),
      );

      const summaries = await manager.listTasks(ctx);
      expect(summaries.every((s) => s.status === "in_progress")).toBe(true);
    });
  });

  // ── AC: @task-index-file ac-3 ────────────────────────────────────────────
  // Given: A task's non-indexed data changes (notes, history entries)
  // When: The mutation is persisted
  // Then: Only the per-task file is written; the index is not modified
  describe("non-indexed changes skip index (ac-3)", () => {
    // AC: @task-index-file ac-3
    it("adding a note does not modify the index file", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Note no index",
        slugs: ["note-no-index"],
      });

      // Capture index file content after creation
      const indexPath = getIndexFilePath(ctx);
      const indexBefore = await fs.readFile(indexPath, "utf-8");

      // Add a note (goes through mutateTask)
      await manager.addNote(ctx, "@note-no-index", "A note that should not touch the index", "@tester");

      // The index file content should be unchanged
      const indexAfter = await fs.readFile(indexPath, "utf-8");
      expect(indexAfter).toBe(indexBefore);

      // But the note should be persisted in the per-task notes file
      const fetched = await manager.getTask(ctx, "@note-no-index");
      expect(fetched.notes.length).toBe(1);
      expect(fetched.notes[0].content).toBe("A note that should not touch the index");
    });

    // AC: @task-index-file ac-3
    it("description change does not modify the index file", async () => {
      const manager = new TaskDataManager("split");

      await manager.createTask(ctx, {
        title: "Desc no index",
        slugs: ["desc-no-index"],
        description: "Original description",
      });

      const indexPath = getIndexFilePath(ctx);
      const indexBefore = await fs.readFile(indexPath, "utf-8");

      await manager.mutateTask(ctx, "@desc-no-index", (task) => ({
        ...task,
        description: "Updated description",
      }));

      const indexAfter = await fs.readFile(indexPath, "utf-8");
      expect(indexAfter).toBe(indexBefore);
    });

    // AC: @task-index-file ac-3
    it("indexEntriesEqual correctly detects unchanged indexed fields", () => {
      const a = {
        _ulid: "01ABC",
        slugs: ["test"],
        title: "Test",
        type: "task",
        status: "pending",
        priority: 3,
        tags: ["a", "b"],
        depends_on: [],
        blocked_by: [],
        created_at: "2026-03-20T00:00:00.000Z",
        notes_count: 0,
        todos_count: 0,
      };

      const b = { ...a };
      expect(indexEntriesEqual(a, b)).toBe(true);
    });

    // AC: @task-index-file ac-3
    it("indexEntriesEqual detects changed indexed fields", () => {
      const a = {
        _ulid: "01ABC",
        slugs: ["test"],
        title: "Test",
        type: "task",
        status: "pending",
        priority: 3,
        tags: ["a"],
        depends_on: [],
        blocked_by: [],
        created_at: "2026-03-20T00:00:00.000Z",
        notes_count: 0,
        todos_count: 0,
      };

      // Status changed
      expect(indexEntriesEqual(a, { ...a, status: "in_progress" })).toBe(false);
      // Priority changed
      expect(indexEntriesEqual(a, { ...a, priority: 1 })).toBe(false);
      // Tags changed
      expect(indexEntriesEqual(a, { ...a, tags: ["a", "b"] })).toBe(false);
      // Title changed
      expect(indexEntriesEqual(a, { ...a, title: "Changed" })).toBe(false);
    });
  });

  // ── AC: @task-index-file ac-4 ────────────────────────────────────────────
  // (covered by @task-directory-storage ac-1 and ac-2 tests above — task
  //  directory creation is the same operation. Adding explicit index check.)
  describe("new task creates directory with per-task files (ac-4)", () => {
    // AC: @task-index-file ac-4
    it("creating a task creates task.yaml and notes.yaml in the directory", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "AC4 create test",
        slugs: ["ac4-create-test"],
      });

      const taskFile = getTaskFilePath(ctx, created._ulid);
      const notesFile = getNotesFilePath(ctx, created._ulid);

      const taskStat = await fs.stat(taskFile);
      expect(taskStat.isFile()).toBe(true);

      const notesStat = await fs.stat(notesFile);
      expect(notesStat.isFile()).toBe(true);
    });
  });

  // ── AC: @task-index-file ac-5 ────────────────────────────────────────────
  // (covered by @task-directory-storage ac-5 tests above — adding index
  //  content verification.)
  describe("new task adds index entry atomically (ac-5)", () => {
    // AC: @task-index-file ac-5
    it("creating a task adds an entry to the index", async () => {
      const manager = new TaskDataManager("split");

      const summariesBefore = await manager.listTasks(ctx);
      expect(summariesBefore.length).toBe(0);

      const created = await manager.createTask(ctx, {
        title: "AC5 index test",
        slugs: ["ac5-index-test"],
        priority: 2,
        tags: ["feature"],
      });

      const summariesAfter = await manager.listTasks(ctx);
      expect(summariesAfter.length).toBe(1);

      const summary = summariesAfter[0];
      expect(summary._ulid).toBe(created._ulid);
      expect(summary.title).toBe("AC5 index test");
      expect(summary.priority).toBe(2);
      expect(summary.tags).toEqual(["feature"]);
    });

    // AC: @task-index-file ac-5
    it("index entry and directory are created in same atomic operation", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "AC5 atomic test",
        slugs: ["ac5-atomic-test"],
      });

      // Both must exist — if one is missing, the operation was not atomic
      const taskDir = getTaskDir(ctx, created._ulid);
      const dirStat = await fs.stat(taskDir);
      expect(dirStat.isDirectory()).toBe(true);

      const summaries = await manager.listTasks(ctx);
      expect(summaries.some((s) => s._ulid === created._ulid)).toBe(true);
    });
  });

  // ── AC: @task-index-file ac-6 ────────────────────────────────────────────
  // Given: The index and a per-task file disagree on a filterable field value
  // When: The task is loaded for detailed view
  // Then: The per-task file is authoritative
  describe("per-task file is authoritative on disagreement (ac-6)", () => {
    // AC: @task-index-file ac-6
    it("getTask returns per-task file values when index disagrees", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Authority test",
        slugs: ["authority-test"],
        priority: 3,
      });

      // Manually corrupt the index to have a different priority
      const indexPath = getIndexFilePath(ctx);
      const indexContent = await fs.readFile(indexPath, "utf-8");
      const { parse, stringify } = await import("yaml");
      const indexData = parse(indexContent);

      // Find the entry and change its priority in the index only
      const entry = Array.isArray(indexData)
        ? indexData.find((e: any) => e._ulid === created._ulid)
        : indexData.tasks?.find((e: any) => e._ulid === created._ulid);
      entry.priority = 1;
      entry.status = "completed";
      await fs.writeFile(indexPath, stringify(indexData));

      // getTask should return values from per-task file, not index
      const fetched = await manager.getTask(ctx, created._ulid);
      expect(fetched.priority).toBe(3); // per-task file value
      expect(fetched.status).toBe("pending"); // per-task file value
    });

    // AC: @task-index-file ac-6
    it("getTask reads from per-task directory not from index", async () => {
      const ulid = testUlid("AUTH");
      await createSplitTask(ctx, ulid, "auth-test");

      // Manually update per-task file to have different title
      const taskFilePath = getTaskFilePath(ctx, ulid);
      const { parse, stringify } = await import("yaml");
      const content = await fs.readFile(taskFilePath, "utf-8");
      const taskData = parse(content);
      taskData.title = "Updated per-task title";
      await fs.writeFile(taskFilePath, stringify(taskData));

      // getTask should return the per-task file's title
      const task = await splitBackend.getTask(ctx, ulid);
      expect(task).toBeDefined();
      expect(task!.title).toBe("Updated per-task title");
    });
  });

  // ── AC: @task-index-file ac-7 ────────────────────────────────────────────
  // Given: The index has drifted from per-task files
  // When: A rebuild is requested
  // Then: The index can be fully regenerated from per-task files alone
  describe("index rebuild from per-task files (ac-7)", () => {
    // AC: @task-index-file ac-7
    it("rebuildIndex regenerates index from per-task directories", async () => {
      const manager = new TaskDataManager("split");

      // Create some tasks
      await manager.createTask(ctx, {
        title: "Rebuild task 1",
        slugs: ["rebuild-1"],
        priority: 1,
        tags: ["feature"],
      });
      await manager.createTask(ctx, {
        title: "Rebuild task 2",
        slugs: ["rebuild-2"],
        priority: 5,
        tags: ["bug"],
      });

      // Corrupt the index (remove all entries)
      const indexPath = getIndexFilePath(ctx);
      await fs.writeFile(indexPath, toYaml([]));

      // Verify index is empty
      const summariesEmpty = await manager.listTasks(ctx);
      expect(summariesEmpty.length).toBe(0);

      // Rebuild
      const result = await splitBackend.rebuildIndex(ctx);
      expect(result.count).toBe(2);

      // Verify index is restored
      const summaries = await manager.listTasks(ctx);
      expect(summaries.length).toBe(2);

      const s1 = summaries.find((s) => s.slugs.includes("rebuild-1"));
      expect(s1).toBeDefined();
      expect(s1!.priority).toBe(1);
      expect(s1!.tags).toEqual(["feature"]);

      const s2 = summaries.find((s) => s.slugs.includes("rebuild-2"));
      expect(s2).toBeDefined();
      expect(s2!.priority).toBe(5);
      expect(s2!.tags).toEqual(["bug"]);
    });

    // AC: @task-index-file ac-7
    it("rebuildIndex handles drifted index values", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Drift test",
        slugs: ["drift-test"],
        priority: 3,
      });

      // Mutate the per-task file directly (simulating drift)
      const taskFilePath = getTaskFilePath(ctx, created._ulid);
      const { parse, stringify } = await import("yaml");
      const content = await fs.readFile(taskFilePath, "utf-8");
      const taskData = parse(content);
      taskData.priority = 1;
      taskData.status = "in_progress";
      taskData.started_at = "2026-03-20T01:00:00.000Z";
      await fs.writeFile(taskFilePath, stringify(taskData));

      // Index still shows old values
      const summariesBefore = await manager.listTasks(ctx);
      const beforeEntry = summariesBefore.find((s) => s._ulid === created._ulid);
      expect(beforeEntry!.priority).toBe(3); // Old index value

      // Rebuild
      await splitBackend.rebuildIndex(ctx);

      // Index should now match per-task file
      const summariesAfter = await manager.listTasks(ctx);
      const afterEntry = summariesAfter.find((s) => s._ulid === created._ulid);
      expect(afterEntry!.priority).toBe(1);
      expect(afterEntry!.status).toBe("in_progress");
    });

    // AC: @task-index-file ac-7
    it("rebuildIndex handles tasks with notes", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Notes rebuild test",
        slugs: ["notes-rebuild"],
      });

      await manager.addNote(ctx, "@notes-rebuild", "Note 1", "@tester");
      await manager.addNote(ctx, "@notes-rebuild", "Note 2", "@tester");

      // Corrupt index
      const indexPath = getIndexFilePath(ctx);
      await fs.writeFile(indexPath, toYaml([]));

      // Rebuild
      await splitBackend.rebuildIndex(ctx);

      // Index should show correct notes count
      const summaries = await manager.listTasks(ctx);
      const summary = summaries.find((s) => s._ulid === created._ulid);
      expect(summary).toBeDefined();
      expect(summary!.notes_count).toBe(2);
    });

    // AC: @task-index-file ac-7
    it("rebuildIndex with empty tasks directory produces empty index", async () => {
      // No tasks created — tasks dir exists but is empty
      const result = await splitBackend.rebuildIndex(ctx);
      expect(result.count).toBe(0);

      const summaries = await splitBackend.listTasks(ctx);
      expect(summaries.length).toBe(0);
    });
  });
});
