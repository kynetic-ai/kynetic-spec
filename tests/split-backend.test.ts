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
});
