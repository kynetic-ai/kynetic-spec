import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskDataManager } from "../src/parser/task-data-manager.js";
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
import type { KspecContext } from "../src/parser/yaml.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  readTestOutput,
  testUlid,
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
  await fs.writeFile(path.join(specDir, "project.tasks.yaml"), toYaml([]));

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
  options: {
    notes?: Array<{ _ulid: string; content: string; created_at: string }>;
    extraFiles?: Record<string, string>;
  } = {},
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
  await fs.writeFile(path.join(taskDir, "task.yaml"), toYaml(coreData));

  // Write notes.yaml
  const notes = options.notes || [];
  await fs.writeFile(path.join(taskDir, "notes.yaml"), toYaml({ notes }));

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
      const content = await readTestOutput(taskFilePath, "utf-8");
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
        notes: [{ _ulid: noteUlid, content: "Test note", created_at: "2026-03-20T00:00:00.000Z" }],
      });

      const notesFilePath = getNotesFilePath(ctx, ulid);
      const content = await readTestOutput(notesFilePath, "utf-8");
      const { parse } = await import("yaml");
      const parsed = parse(content);

      expect(parsed.notes).toBeDefined();
      expect(parsed.notes.length).toBe(1);
      expect(parsed.notes[0].content).toBe("Test note");
    });

    // AC: @task-directory-storage ac-2
    // AC: @task-detail-loading ac-1 — unified task assembled from index + per-task directory
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
      const customContent = await readTestOutput(customFilePath, "utf-8");
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
      const content = await readTestOutput(path.join(customDir, "file.txt"), "utf-8");
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

  // ── AC: @task-listing-performance ac-2 ──────────────────────────────────
  // Given: Tasks have extensive notes and history
  // When: A filtered task list is requested
  // Then: The response time is proportional to the number of tasks,
  //       not the total volume of notes and history across all tasks
  describe("listing cost independent of notes volume (ac-2)", () => {
    // AC: @task-listing-performance ac-2
    it("listTasks reads only the index, not per-task notes files, regardless of notes volume", async () => {
      const manager = new TaskDataManager("split");

      // Create tasks with varying notes volumes
      await manager.createTask(ctx, {
        title: "Few notes task",
        slugs: ["few-notes"],
      });
      const created2 = await manager.createTask(ctx, {
        title: "Many notes task",
        slugs: ["many-notes"],
      });

      // Add extensive notes to one task (simulating heavy history)
      for (let i = 0; i < 20; i++) {
        await manager.addNote(
          ctx,
          "@many-notes",
          `Detailed note entry ${i}: ${"x".repeat(200)}`,
          "@author",
        );
      }

      // Verify the heavy task has extensive notes on disk
      const notesFilePath = getNotesFilePath(ctx, created2._ulid);
      const notesContent = await readTestOutput(notesFilePath, "utf-8");
      expect(notesContent.length).toBeGreaterThan(4000);

      // listTasks should succeed and return accurate summaries
      // without reading any notes files — it reads only the index
      const summaries = await manager.listTasks(ctx);
      expect(summaries.length).toBe(2);

      // Summaries have notes_count (from index) but no notes content
      const heavySummary = summaries.find((s) => s.slugs.includes("many-notes"));
      expect(heavySummary).toBeDefined();
      expect(heavySummary!.notes_count).toBe(20);
      expect((heavySummary as any).notes).toBeUndefined();

      const lightSummary = summaries.find((s) => s.slugs.includes("few-notes"));
      expect(lightSummary).toBeDefined();
      expect(lightSummary!.notes_count).toBe(0);

      // The architectural guarantee: list operation routing confirms
      // notes files are never accessed during listing
      const routing = getOperationRouting("list");
      expect(routing.touchesNotes).toBe(false);
      expect(routing.touchesCoreData).toBe(false);
      expect(routing.touchesIndex).toBe(true);
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
    // AC: @task-listing-performance ac-1 — list reads only index; no per-task directory accessed
    it("list touches only index", () => {
      const routing = getOperationRouting("list");
      expect(routing.touchesIndex).toBe(true);
      expect(routing.touchesCoreData).toBe(false);
      expect(routing.touchesNotes).toBe(false);
    });

    // AC: @task-detail-loading ac-1 — detail request reads per-task directory (core data + notes)
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

    // AC: @task-listing-performance ac-1 — list reads only index, no per-task directory accessed
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
      const _taskFileBefore = await readTestOutput(getTaskFilePath(ctx, created._ulid), "utf-8");

      // Add a note
      await manager.addNote(ctx, "@note-test", "Test note content", "@tester");

      // task.yaml should still not contain notes
      // (it will be rewritten because addNote goes through mutateTask,
      // but notes should not appear in task.yaml)
      const taskFileAfter = await readTestOutput(getTaskFilePath(ctx, created._ulid), "utf-8");
      const { parse } = await import("yaml");
      const parsedAfter = parse(taskFileAfter);
      expect(parsedAfter.notes).toBeUndefined();

      // Notes should be in notes.yaml
      const notesContent = await readTestOutput(getNotesFilePath(ctx, created._ulid), "utf-8");
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

      const updated = await manager.mutateTasks(ctx, ["@batch-1", "@batch-2"], (tasks) =>
        tasks.map((t) => ({ ...t, priority: 1 })),
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
      const content = await readTestOutput(indexPath, "utf-8");
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
        notes: [
          {
            _ulid: testUlid("TNOT", 1),
            content: "note text",
            created_at: "2026-03-20T00:00:00.000Z",
          },
        ],
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

      await manager.mutateTasks(ctx, ["@batch-idx-1", "@batch-idx-2"], (tasks) =>
        tasks.map((t) => ({
          ...t,
          status: "in_progress" as const,
          started_at: "2026-03-20T01:00:00.000Z",
        })),
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
    it("adding a note updates the index count but not note content", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Note no index",
        slugs: ["note-no-index"],
      });

      // Add a note (goes through mutateTask)
      await manager.addNote(
        ctx,
        "@note-no-index",
        "A note with content that stays out of the index",
        "@tester",
      );

      // The index should update notes_count (it's an indexed field)
      const summaries = await manager.listTasks(ctx);
      const summary = summaries.find((s) => s._ulid === created._ulid);
      expect(summary!.notes_count).toBe(1);

      // But note *content* must NOT appear in the index (non-indexed data)
      const indexPath = getIndexFilePath(ctx);
      const indexContent = await readTestOutput(indexPath, "utf-8");
      expect(indexContent).not.toContain("A note with content that stays out of the index");

      // The note should be persisted in the per-task notes file
      const fetched = await manager.getTask(ctx, "@note-no-index");
      expect(fetched.notes.length).toBe(1);
      expect(fetched.notes[0].content).toBe("A note with content that stays out of the index");
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
      const indexBefore = await readTestOutput(indexPath, "utf-8");

      await manager.mutateTask(ctx, "@desc-no-index", (task) => ({
        ...task,
        description: "Updated description",
      }));

      const indexAfter = await readTestOutput(indexPath, "utf-8");
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
      // notes_count changed — indexed field, triggers index write
      expect(indexEntriesEqual(a, { ...a, notes_count: 1 })).toBe(false);
      // todos_count changed — indexed field, triggers index write
      expect(indexEntriesEqual(a, { ...a, todos_count: 2 })).toBe(false);
    });

    // AC: @task-index-file ac-2
    it("listTasks returns accurate notes_count after note additions", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Count accuracy",
        slugs: ["count-accuracy"],
      });

      // Initially notes_count should be 0
      let summaries = await manager.listTasks(ctx);
      let summary = summaries.find((s) => s._ulid === created._ulid);
      expect(summary).toBeDefined();
      expect(summary!.notes_count).toBe(0);

      // Add two notes — index count updates because notes_count is indexed
      await manager.addNote(ctx, "@count-accuracy", "Note one", "@tester");
      await manager.addNote(ctx, "@count-accuracy", "Note two", "@tester");

      // listTasks shows accurate count — notes_count is an indexed field
      summaries = await manager.listTasks(ctx);
      summary = summaries.find((s) => s._ulid === created._ulid);
      expect(summary!.notes_count).toBe(2);

      // getTask also returns the real count
      const fetched = await manager.getTask(ctx, "@count-accuracy");
      expect(fetched.notes.length).toBe(2);
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
      const indexContent = await readTestOutput(indexPath, "utf-8");
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
      const content = await readTestOutput(taskFilePath, "utf-8");
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
      const content = await readTestOutput(taskFilePath, "utf-8");
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

    // AC: @task-index-file ac-7
    it("rebuildIndex is accessible through TaskDataManager", async () => {
      const manager = new TaskDataManager("split");

      await manager.createTask(ctx, {
        title: "Manager rebuild test",
        slugs: ["manager-rebuild"],
        priority: 2,
        tags: ["infra"],
      });

      // Corrupt the index
      const indexPath = getIndexFilePath(ctx);
      await fs.writeFile(indexPath, toYaml([]));

      // Verify index is empty
      const summariesEmpty = await manager.listTasks(ctx);
      expect(summariesEmpty.length).toBe(0);

      // Rebuild via the manager (public API), not the backend directly
      const result = await manager.rebuildIndex(ctx);
      expect(result.count).toBe(1);

      // Verify index is restored
      const summaries = await manager.listTasks(ctx);
      expect(summaries.length).toBe(1);
      expect(summaries[0].slugs).toContain("manager-rebuild");
    });
  });

  // ── Blocker fix: plan_ref and review_ref in summary ────────────────────
  describe("plan_ref and review_ref in TaskSummary", () => {
    // AC: @task-index-file ac-1
    it("listTasks returns plan_ref and review_ref from index", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Refs test task",
        slugs: ["refs-test"],
        plan_ref: "@test-plan",
        review_ref: "@test-review",
      });

      const summaries = await manager.listTasks(ctx);
      const summary = summaries.find((s) => s._ulid === created._ulid);
      expect(summary).toBeDefined();
      expect(summary!.plan_ref).toBe("@test-plan");
      expect(summary!.review_ref).toBe("@test-review");
    });

    // AC: @task-index-file ac-1
    it("listTasks returns undefined for missing plan_ref/review_ref", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "No refs task",
        slugs: ["no-refs"],
      });

      const summaries = await manager.listTasks(ctx);
      const summary = summaries.find((s) => s._ulid === created._ulid);
      expect(summary).toBeDefined();
      // Fields should be undefined (not present) when not set
      expect(summary!.plan_ref).toBeUndefined();
      expect(summary!.review_ref).toBeUndefined();
    });

    // AC: @task-index-file ac-2
    it("index updates plan_ref when task is mutated", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Plan ref mutation test",
        slugs: ["plan-mut"],
      });

      // Mutate to add plan_ref
      await manager.mutateTask(ctx, `@${created._ulid}`, (task) => ({
        ...task,
        plan_ref: "@new-plan",
      }));

      const summaries = await manager.listTasks(ctx);
      const summary = summaries.find((s) => s._ulid === created._ulid);
      expect(summary).toBeDefined();
      expect(summary!.plan_ref).toBe("@new-plan");
    });

    // AC: @task-index-file ac-7
    it("rebuildIndex preserves plan_ref and review_ref", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Rebuild refs test",
        slugs: ["rebuild-refs"],
        plan_ref: "@plan-abc",
        review_ref: "@review-xyz",
      });

      // Corrupt the index
      const indexPath = getIndexFilePath(ctx);
      await fs.writeFile(indexPath, toYaml([]));

      // Rebuild
      await manager.rebuildIndex(ctx);

      // Verify refs are preserved in rebuilt index
      const summaries = await manager.listTasks(ctx);
      const summary = summaries.find((s) => s._ulid === created._ulid);
      expect(summary).toBeDefined();
      expect(summary!.plan_ref).toBe("@plan-abc");
      expect(summary!.review_ref).toBe("@review-xyz");
    });
  });

  // ── AC: @task-detail-loading ac-1 ──────────────────────────────────────
  // Given: A caller requests full details for a specific task
  // When: The task is loaded
  // Then: The manager reads the index entry for filterable fields and the
  //       per-task directory (task.yaml + notes.yaml) for complete data;
  //       the result is a unified task object indistinguishable from the
  //       current monolithic format
  describe("detail loading assembles unified task (ac-1)", () => {
    // AC: @task-detail-loading ac-1
    it("getTask assembles complete task from index and per-task files", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Detail loading test",
        slugs: ["detail-loading-test"],
        description: "A full description",
        priority: 2,
        tags: ["feature", "mvp"],
      });

      // Add a note so both files contribute
      await manager.addNote(ctx, "@detail-loading-test", "Implementation note", "@tester");

      const task = await manager.getTask(ctx, created._ulid);
      // Unified task has all fields
      expect(task._ulid).toBe(created._ulid);
      expect(task.title).toBe("Detail loading test");
      expect(task.description).toBe("A full description");
      expect(task.priority).toBe(2);
      expect(task.tags).toEqual(["feature", "mvp"]);
      expect(task.notes.length).toBe(1);
      expect(task.notes[0].content).toBe("Implementation note");
      expect(task.status).toBe("pending");
    });

    // AC: @task-detail-loading ac-1
    it("getTask by slug assembles complete task", async () => {
      const manager = new TaskDataManager("split");

      await manager.createTask(ctx, {
        title: "Slug detail test",
        slugs: ["slug-detail-test"],
        description: "Slug-accessed task",
      });

      await manager.addNote(ctx, "@slug-detail-test", "A note via slug", "@tester");

      const task = await manager.getTask(ctx, "@slug-detail-test");
      expect(task.title).toBe("Slug detail test");
      expect(task.description).toBe("Slug-accessed task");
      expect(task.notes.length).toBe(1);
      expect(task.notes[0].content).toBe("A note via slug");
    });

    // AC: @task-detail-loading ac-1
    it("getTask by short ULID prefix assembles complete task", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Short ULID test",
        slugs: ["short-ulid-test"],
      });

      // Use first 10 characters as short prefix
      const shortRef = created._ulid.slice(0, 10);
      const task = await manager.getTask(ctx, shortRef);
      expect(task._ulid).toBe(created._ulid);
      expect(task.title).toBe("Short ULID test");
    });
  });

  // ── AC: @task-detail-loading ac-2 ──────────────────────────────────────
  // Given: A per-task directory is missing but an index entry exists
  // When: The task detail is requested
  // Then: The manager returns the index data with a warning indicating
  //       the per-task directory is missing; it does not fail silently
  //       or throw an unrecoverable error
  describe("fallback for missing per-task directory (ac-2)", () => {
    // AC: @task-detail-loading ac-2
    it("returns index data when per-task directory is missing (full ULID)", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Fallback test",
        slugs: ["fallback-test"],
        priority: 2,
        tags: ["bug"],
      });

      // Delete the per-task directory to simulate missing data
      const taskDir = getTaskDir(ctx, created._ulid);
      await fs.rm(taskDir, { recursive: true });

      // Should NOT throw — returns degraded data from index
      const task = await manager.getTask(ctx, created._ulid);
      expect(task._ulid).toBe(created._ulid);
      expect(task.title).toBe("Fallback test");
      expect(task.priority).toBe(2);
      expect(task.tags).toEqual(["bug"]);
      expect(task.status).toBe("pending");
      // Notes are unavailable in fallback — defaults to empty
      expect(task.notes).toEqual([]);
    });

    // AC: @task-detail-loading ac-2
    it("returns index data when per-task directory is missing (slug ref)", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Slug fallback test",
        slugs: ["slug-fallback-test"],
        priority: 1,
        tags: ["infra"],
      });

      // Delete the per-task directory
      const taskDir = getTaskDir(ctx, created._ulid);
      await fs.rm(taskDir, { recursive: true });

      // Should still be retrievable via slug
      const task = await manager.getTask(ctx, "@slug-fallback-test");
      expect(task._ulid).toBe(created._ulid);
      expect(task.title).toBe("Slug fallback test");
      expect(task.priority).toBe(1);
    });

    // AC: @task-detail-loading ac-2
    it("returns index data when per-task directory is missing (short ULID)", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Short ULID fallback",
        slugs: ["short-fallback"],
      });

      // Delete the per-task directory
      const taskDir = getTaskDir(ctx, created._ulid);
      await fs.rm(taskDir, { recursive: true });

      // Should work with short ULID prefix
      const shortRef = created._ulid.slice(0, 10);
      const task = await manager.getTask(ctx, shortRef);
      expect(task._ulid).toBe(created._ulid);
      expect(task.title).toBe("Short ULID fallback");
    });

    // AC: @task-detail-loading ac-2
    it("emits a warning to stderr when falling back to index data", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Warning test",
        slugs: ["warning-test"],
      });

      // Delete the per-task directory
      const taskDir = getTaskDir(ctx, created._ulid);
      await fs.rm(taskDir, { recursive: true });

      // Capture stderr
      const stderrWrites: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;

      try {
        await manager.getTask(ctx, created._ulid);
      } finally {
        process.stderr.write = originalWrite;
      }

      const allStderr = stderrWrites.join("");
      expect(allStderr).toContain("Per-task directory missing");
      expect(allStderr).toContain(created._ulid);
    });

    // AC: @task-detail-loading ac-2
    it("does not throw an unrecoverable error for missing directory", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "No throw test",
        slugs: ["no-throw-test"],
      });

      // Delete the per-task directory
      const taskDir = getTaskDir(ctx, created._ulid);
      await fs.rm(taskDir, { recursive: true });

      // Should not throw
      await expect(manager.getTask(ctx, created._ulid)).resolves.toBeDefined();
    });

    // AC: @task-detail-loading ac-2
    it("returns empty notes and todos for fallback task", async () => {
      const manager = new TaskDataManager("split");

      const created = await manager.createTask(ctx, {
        title: "Empty detail test",
        slugs: ["empty-detail"],
      });

      // Add notes before deleting directory
      await manager.addNote(ctx, "@empty-detail", "A note that will be lost", "@tester");

      // Delete the per-task directory — notes are now gone
      const taskDir = getTaskDir(ctx, created._ulid);
      await fs.rm(taskDir, { recursive: true });

      // Suppress stderr warning noise
      const originalWrite = process.stderr.write;
      process.stderr.write = (() => true) as typeof process.stderr.write;
      try {
        const task = await manager.getTask(ctx, created._ulid);
        expect(task.notes).toEqual([]);
        expect(task.todos).toEqual([]);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    // AC: @task-detail-loading ac-2
    it("still throws for truly non-existent tasks (no index entry)", async () => {
      const manager = new TaskDataManager("split");

      // No task created — neither index nor directory exists
      const nonExistentUlid = testUlid("NOPE");
      await expect(manager.getTask(ctx, nonExistentUlid)).rejects.toThrow("Task not found");
    });
  });

  // ─── loadAllTasksWithHistory ─────────────────────────────────────────────
  describe("loadAllTasksWithHistory", () => {
    // AC: @daemon-entity-cache ac-task-history-retention
    it("returns both task data and history entries for each task", async () => {
      const ulid1 = testUlid("BLK1");
      const ulid2 = testUlid("BLK2");

      // Create task WITH history in task.yaml
      const taskDir1 = getTaskDir(ctx, ulid1);
      await fs.mkdir(taskDir1, { recursive: true });
      await fs.writeFile(
        path.join(taskDir1, "task.yaml"),
        toYaml({
          _ulid: ulid1,
          slugs: ["bulk-history-1"],
          title: "Bulk task 1",
          type: "task",
          status: "in_progress",
          priority: 2,
          tags: [],
          depends_on: [],
          created_at: "2026-01-01T00:00:00.000Z",
          history: [
            {
              timestamp: "2026-01-02T00:00:00.000Z",
              author: "@tester",
              command: "task-start",
              changes: {
                status: { previous: "pending", new: "in_progress" },
              },
            },
          ],
        }),
      );
      await fs.writeFile(path.join(taskDir1, "notes.yaml"), toYaml({ notes: [] }));

      // Create task WITHOUT history
      const taskDir2 = getTaskDir(ctx, ulid2);
      await fs.mkdir(taskDir2, { recursive: true });
      await fs.writeFile(
        path.join(taskDir2, "task.yaml"),
        toYaml({
          _ulid: ulid2,
          slugs: ["bulk-history-2"],
          title: "Bulk task 2",
          type: "task",
          status: "pending",
          priority: 3,
          tags: [],
          depends_on: [],
          created_at: "2026-01-01T00:00:00.000Z",
        }),
      );
      await fs.writeFile(path.join(taskDir2, "notes.yaml"), toYaml({ notes: [] }));

      const results = await splitBackend.loadAllTasksWithHistory(ctx);

      expect(results).toHaveLength(2);

      const task1Result = results.find((r) => r.task._ulid === ulid1);
      const task2Result = results.find((r) => r.task._ulid === ulid2);

      // Task 1 has history
      expect(task1Result).toBeDefined();
      expect(task1Result!.task.title).toBe("Bulk task 1");
      expect(task1Result!.history).toHaveLength(1);
      expect(task1Result!.history[0].command).toBe("task-start");
      expect(task1Result!.history[0].changes.status).toEqual({
        previous: "pending",
        new: "in_progress",
      });

      // Task 2 has empty history
      expect(task2Result).toBeDefined();
      expect(task2Result!.task.title).toBe("Bulk task 2");
      expect(task2Result!.history).toHaveLength(0);
    });

    // AC: @daemon-entity-cache ac-task-history-retention
    it("skips tasks that fail to load, consistent with loadAllTasks", async () => {
      const validUlid = testUlid("VLID");
      const badUlid = testUlid("BAAD");

      // Create a valid task
      const validDir = getTaskDir(ctx, validUlid);
      await fs.mkdir(validDir, { recursive: true });
      await fs.writeFile(
        path.join(validDir, "task.yaml"),
        toYaml({
          _ulid: validUlid,
          slugs: ["valid-task"],
          title: "Valid task",
          type: "task",
          status: "pending",
          priority: 3,
          tags: [],
          depends_on: [],
          created_at: "2026-01-01T00:00:00.000Z",
        }),
      );
      await fs.writeFile(path.join(validDir, "notes.yaml"), toYaml({ notes: [] }));

      // Create an invalid task (corrupted YAML)
      const badDir = getTaskDir(ctx, badUlid);
      await fs.mkdir(badDir, { recursive: true });
      await fs.writeFile(path.join(badDir, "task.yaml"), "not: valid: yaml: {{");

      const results = await splitBackend.loadAllTasksWithHistory(ctx);

      // Only the valid task should be returned
      expect(results).toHaveLength(1);
      expect(results[0].task._ulid).toBe(validUlid);
    });
  });
});
