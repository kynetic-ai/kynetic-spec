/**
 * Split storage backend for per-task directory storage.
 *
 * Implements the TaskStorageBackend interface for the split format where
 * each task has its own directory (.kspec/tasks/<full-ulid>/) containing
 * task.yaml and notes.yaml, with a lean index in project.tasks.yaml.
 *
 * This module provides:
 * - Format detection (monolithic vs split)
 * - Directory layout conventions (.kspec/tasks/<full-ulid>/)
 * - Routing logic (which operations touch index, per-task files, or both)
 * - Per-task file locking replacing whole-file locking
 *
 * The actual index read/write and per-task file read/write operations are
 * implemented by child tasks (@task-impl-index and @task-impl-per-task-files).
 * This module provides the framework they plug into.
 *
 * Spec: @task-directory-storage
 * Task: @task-impl-split-storage
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Task } from "../schema/task.js";
import { TaskSchema } from "../schema/task.js";
import {
  activateBatchBuffer,
  deactivateBatchBuffer,
  getActiveBatchBuffer,
  mkdirBufferAware,
  readdirBufferAware,
  writeFileBufferAware,
} from "../cli/batch-write-buffer.js";
import type { MutationMetadata, TaskStorageBackend, TaskSummary } from "./task-data-manager.js";
import { TaskDataManagerError, registerBackend } from "./task-data-manager.js";
import type { KspecContext, LoadedTask } from "./yaml.js";
import {
  findTaskByRef,
  getAuthor,
  getDefaultTaskFilePath,
  readYamlFile,
  stripRuntimeMetadata,
  toYaml,
  writeYamlFile,
} from "./yaml.js";
import { rawToSummary } from "./task-data-manager.js";

// ── History Entry Types ─────────────────────────────────────────────────────

/**
 * A single field change within a history entry.
 * Maps field name to previous and new values.
 *
 * AC: @task-core-data-file ac-1 — records field name, previous value, and new value
 */
export interface HistoryFieldChange {
  previous: unknown;
  new: unknown;
}

/**
 * A history entry recording a mutation to a task's fields.
 *
 * Stored in the `history` array within task.yaml. Each entry records
 * the timestamp, author, command, and the specific field changes.
 *
 * AC: @task-core-data-file ac-1 — appended on mutation
 * AC: @task-core-data-file ac-3 — includes timestamp, author, command, changes
 */
export interface HistoryEntry {
  /** ISO 8601 timestamp of when the change was made */
  timestamp: string;
  /** Who made the change (author identity) */
  author: string;
  /** The kspec command or API call that triggered the change */
  command: string;
  /** Field-level changes: field name → { previous, new } */
  changes: Record<string, HistoryFieldChange>;
}

/**
 * Compute the field-level diff between two task states.
 * Only includes fields that actually changed (different values).
 * Skips internal/runtime fields (_sourceFile, notes, todos, history).
 *
 * AC: @task-core-data-file ac-1 — records field name, previous value, new value
 */
function computeFieldChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, HistoryFieldChange> | null {
  const changes: Record<string, HistoryFieldChange> = {};
  // Fields to skip — notes and todos are separate files, history is internal
  const skipFields = new Set(["_sourceFile", "notes", "todos", "history"]);

  // Collect all unique keys from both objects
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    if (skipFields.has(key)) continue;

    const oldVal = before[key];
    const newVal = after[key];

    // Use JSON comparison for deep equality of arrays/objects
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes[key] = { previous: oldVal ?? null, new: newVal ?? null };
    }
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * Create a history entry from a field diff.
 *
 * AC: @task-core-data-file ac-1 — appended on mutation with all required metadata
 * AC: @task-core-data-file ac-3 — timestamp, author, command, changes
 */
function createHistoryEntry(
  changes: Record<string, HistoryFieldChange>,
  metadata?: MutationMetadata,
): HistoryEntry {
  return {
    timestamp: new Date().toISOString(),
    author: metadata?.author ?? getAuthor() ?? "unknown",
    command: metadata?.command ?? "unknown",
    changes,
  };
}

// ── Directory Layout ─────────────────────────────────────────────────────────

/**
 * Get the tasks directory path for a given context.
 * This is the parent directory containing all per-task directories.
 *
 * Layout: <specDir>/tasks/
 *
 * AC: @task-directory-storage ac-1 — directory named by full ULID
 */
export function getTasksDir(ctx: KspecContext): string {
  return path.join(ctx.specDir, "tasks");
}

/**
 * Get the directory path for a specific task.
 *
 * Layout: <specDir>/tasks/<full-ulid>/
 *
 * AC: @task-directory-storage ac-1 — task has its own directory named by full ULID
 */
export function getTaskDir(ctx: KspecContext, ulid: string): string {
  return path.join(getTasksDir(ctx), ulid);
}

/**
 * Get the path to a task's core data file.
 *
 * Layout: <specDir>/tasks/<full-ulid>/task.yaml
 *
 * AC: @task-directory-storage ac-2 — core data in separate file
 */
export function getTaskFilePath(ctx: KspecContext, ulid: string): string {
  return path.join(getTaskDir(ctx, ulid), "task.yaml");
}

/**
 * Get the path to a task's notes file.
 *
 * Layout: <specDir>/tasks/<full-ulid>/notes.yaml
 *
 * AC: @task-directory-storage ac-2 — notes in separate file
 */
export function getNotesFilePath(ctx: KspecContext, ulid: string): string {
  return path.join(getTaskDir(ctx, ulid), "notes.yaml");
}

/**
 * Get the index file path (same as default task file for now).
 *
 * Layout: <specDir>/project.tasks.yaml (lean index with filterable fields only)
 */
export function getIndexFilePath(ctx: KspecContext): string {
  return getDefaultTaskFilePath(ctx);
}

// ── Format Detection ─────────────────────────────────────────────────────────

/**
 * Check whether the split storage format is in use by looking for the
 * tasks directory with ULID-named subdirectories.
 *
 * This is a secondary check used during validation. The primary mechanism
 * for selecting the format is the explicit setting in the manager constructor.
 *
 * AC: @task-storage-activation ac-3 — detect unmigrated tasks
 */
export async function detectSplitFormat(ctx: KspecContext): Promise<boolean> {
  const tasksDir = getTasksDir(ctx);
  try {
    const entries = await fs.readdir(tasksDir, { withFileTypes: true });
    // Look for at least one ULID-named directory (26-char Crockford base32)
    return entries.some(
      (entry) => entry.isDirectory() && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(entry.name),
    );
  } catch {
    return false;
  }
}

/**
 * List all task ULID directories in the tasks/ directory.
 *
 * Returns the ULID directory names (not full paths).
 * Only includes entries that are directories with valid ULID names.
 *
 * AC: @task-directory-storage ac-1 — directories named by full ULID
 * AC: @task-directory-storage ac-3 — unknown files/dirs are ignored
 */
export async function listTaskDirs(ctx: KspecContext): Promise<string[]> {
  const tasksDir = getTasksDir(ctx);
  try {
    const entries = await readdirBufferAware(tasksDir, { withFileTypes: true }) as import("node:fs").Dirent[];
    return entries
      .filter(
        (entry) => entry.isDirectory() && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(entry.name),
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// ── Routing Logic ────────────────────────────────────────────────────────────

/**
 * Operation routing — determines which files each operation touches.
 *
 * This is the central routing decision that the split backend makes.
 * Child tasks implement the actual read/write for each file type.
 *
 * | Operation     | Index | task.yaml | notes.yaml |
 * |---------------|-------|-----------|------------|
 * | listTasks     | READ  | -         | -          |
 * | getTask       | -     | READ      | READ       |
 * | createTask    | WRITE | WRITE     | WRITE      |
 * | mutateTask    | WRITE*| WRITE     | -          |
 * | addNote       | -     | -         | WRITE      |
 * | deleteTask    | WRITE | DELETE    | DELETE     |
 * | mutateTasks   | WRITE*| WRITE     | -          |
 *
 * * Index is only written when indexed fields change.
 *   The index write determination is deferred to @task-impl-index.
 *
 * AC: @task-index-file ac-3 — note-only mutations don't touch index
 */
export type OperationType =
  | "list"      // Read index only
  | "get"       // Read per-task files
  | "create"    // Write index + per-task files
  | "mutate"    // Write per-task file, conditionally index
  | "note"      // Write notes.yaml only
  | "delete";   // Remove from index + delete directory

/**
 * Describes which files an operation needs to touch.
 */
export interface OperationRouting {
  /** Whether to read/write the index file */
  touchesIndex: boolean;
  /** Whether to read/write per-task core data (task.yaml) */
  touchesCoreData: boolean;
  /** Whether to read/write per-task notes (notes.yaml) */
  touchesNotes: boolean;
}

/**
 * Get the routing for a given operation type.
 *
 * AC: @task-index-file ac-1 — index contains only listing/filtering fields
 * AC: @task-index-file ac-3 — note-only mutations skip the index
 */
export function getOperationRouting(operation: OperationType): OperationRouting {
  switch (operation) {
    case "list":
      return { touchesIndex: true, touchesCoreData: false, touchesNotes: false };
    case "get":
      return { touchesIndex: false, touchesCoreData: true, touchesNotes: true };
    case "create":
      return { touchesIndex: true, touchesCoreData: true, touchesNotes: true };
    case "mutate":
      // Index touch is conditional — the actual index update determination
      // is handled by @task-impl-index based on which fields changed.
      // Here we signal that the index MAY be touched.
      return { touchesIndex: true, touchesCoreData: true, touchesNotes: false };
    case "note":
      return { touchesIndex: false, touchesCoreData: false, touchesNotes: true };
    case "delete":
      return { touchesIndex: true, touchesCoreData: true, touchesNotes: true };
  }
}

// ── Per-Task Locking ─────────────────────────────────────────────────────────

/**
 * In-memory per-task FIFO mutex — same design as TaskMutexMap in the
 * monolithic backend, but exported for use by the split backend.
 *
 * Each task ULID maps to a promise representing the tail of a FIFO queue.
 * A new waiter captures the current tail, replaces it with its own promise,
 * then awaits the captured tail.
 *
 * AC: @task-data-manager ac-5 — non-overlapping mutations no contention
 * AC: @task-data-manager ac-9 — same-task mutations serialize
 */
class SplitTaskMutexMap {
  private readonly locks = new Map<string, Promise<void>>();

  async acquire(ulid: string): Promise<() => void> {
    const predecessor = this.locks.get(ulid);

    let release!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.locks.set(ulid, lockPromise);

    if (predecessor) {
      await predecessor;
    }

    return () => {
      if (this.locks.get(ulid) === lockPromise) {
        this.locks.delete(ulid);
      }
      release();
    };
  }
}

// ── Split Storage Backend ────────────────────────────────────────────────────

/**
 * Split storage backend implementation.
 *
 * Each task is stored as:
 *   .kspec/tasks/<full-ulid>/task.yaml   — core data + history
 *   .kspec/tasks/<full-ulid>/notes.yaml  — append-only notes
 *
 * A lean index at project.tasks.yaml provides fast list/filter operations.
 *
 * AC: @task-directory-storage ac-1 — directory named by full ULID
 * AC: @task-directory-storage ac-2 — core data and notes in separate files
 * AC: @task-directory-storage ac-3 — unknown files preserved
 * AC: @task-directory-storage ac-4 — delete removes entire directory
 * AC: @task-directory-storage ac-5 — delete removes index entry atomically
 */
class SplitBackend implements TaskStorageBackend {
  readonly format = "split" as const;
  private readonly taskMutex = new SplitTaskMutexMap();

  /**
   * List tasks by reading only the index file.
   *
   * AC: @task-data-manager ac-2 — only index data is read
   * AC: @task-listing-performance ac-1 — only project.tasks.yaml is read
   */
  async listTasks(ctx: KspecContext): Promise<TaskSummary[]> {
    const indexPath = getIndexFilePath(ctx);
    try {
      const raw = await readYamlFile<unknown>(indexPath);

      let taskList: unknown[];
      if (Array.isArray(raw)) {
        taskList = raw;
      } else if (raw && typeof raw === "object" && "tasks" in raw) {
        const wrapper = raw as Record<string, unknown>;
        taskList = Array.isArray(wrapper.tasks) ? wrapper.tasks : [];
      } else {
        return [];
      }

      const summaries: TaskSummary[] = [];
      for (const entry of taskList) {
        const summary = rawToSummary(entry);
        if (summary) {
          summaries.push(summary);
        }
      }
      return summaries;
    } catch {
      return [];
    }
  }

  /**
   * Load all tasks with full detail from per-task directories.
   *
   * Scans each ULID directory and assembles the full task record
   * from task.yaml + notes.yaml.
   *
   * AC: @task-detail-loading ac-1 — assembles complete task from per-task files
   */
  async loadAllTasks(ctx: KspecContext): Promise<LoadedTask[]> {
    const ulids = await listTaskDirs(ctx);
    const tasks: LoadedTask[] = [];

    for (const ulid of ulids) {
      try {
        const task = await this.loadTaskFromDir(ctx, ulid);
        if (task) {
          tasks.push(task);
        }
      } catch {
        // Skip tasks that fail to load — log warning in future
      }
    }

    return tasks;
  }

  /**
   * Get a single task's full details.
   *
   * Uses per-task directory files, not the index.
   *
   * AC: @task-data-manager ac-3 — assembles complete task transparently
   * AC: @task-detail-loading ac-1 — reads per-task directory for complete data
   */
  async getTask(ctx: KspecContext, ref: string): Promise<LoadedTask | undefined> {
    // First try direct ULID lookup (fast path)
    if (/^[0-9A-HJKMNP-TV-Z]{10,26}$/.test(ref)) {
      // Could be a full ULID or a short ULID prefix
      if (ref.length === 26) {
        return this.loadTaskFromDir(ctx, ref);
      }
      // Short ULID prefix — scan directories
      const ulids = await listTaskDirs(ctx);
      const matching = ulids.filter((u) => u.startsWith(ref));
      if (matching.length === 1) {
        return this.loadTaskFromDir(ctx, matching[0]);
      }
    }

    // Fall back to loading all tasks and finding by ref (handles slugs)
    const allTasks = await this.loadAllTasks(ctx);
    return findTaskByRef(allTasks, ref);
  }

  /**
   * Create a new task in the split format.
   *
   * Creates the task directory, writes task.yaml and notes.yaml,
   * and adds an entry to the index. All within a write buffer for atomicity.
   *
   * AC: @task-directory-storage ac-1 — directory named by full ULID
   * AC: @task-directory-storage ac-2 — separate files for core data and notes
   * AC: @task-index-file ac-4 — task directory created with per-task files
   * AC: @task-index-file ac-5 — index entry added atomically
   */
  async createTask(ctx: KspecContext, task: Task): Promise<LoadedTask> {
    const taskDir = getTaskDir(ctx, task._ulid);
    const taskFilePath = getTaskFilePath(ctx, task._ulid);
    const notesFilePath = getNotesFilePath(ctx, task._ulid);

    const existingBuffer = getActiveBatchBuffer();
    const localBuffer = !existingBuffer ? activateBatchBuffer(ctx.specDir) : null;

    try {
      // Create directory
      await mkdirBufferAware(taskDir);

      // Separate notes from core data
      const { notes, ...coreData } = stripRuntimeMetadata(task as LoadedTask) as Task;

      // Write core data file (task.yaml) — no history for new tasks
      await writeTaskFile(taskFilePath, coreData);

      // Write notes file (notes.yaml)
      await writeNotesFile(notesFilePath, notes || []);

      // Add to index
      await this.addToIndex(ctx, task);

      if (localBuffer) {
        await localBuffer.flush();
      }

      return { ...task, _sourceFile: taskFilePath };
    } catch (error) {
      if (localBuffer) {
        localBuffer.discard();
      }
      throw error;
    } finally {
      if (localBuffer) {
        deactivateBatchBuffer();
      }
    }
  }

  /**
   * Mutate a single task with per-task locking and history tracking.
   *
   * The mutation only touches the per-task directory files.
   * Index is updated only if indexed fields changed.
   * History entries are appended to task.yaml when core fields change.
   * If only notes changed, task.yaml is not modified.
   *
   * AC: @task-data-manager ac-5 — non-overlapping mutations no contention
   * AC: @task-data-manager ac-9 — same-task mutations serialize
   * AC: @task-core-data-file ac-1 — field changes recorded in history
   * AC: @task-notes-file ac-1 — note-only mutations don't touch task.yaml
   */
  async mutateTask(
    ctx: KspecContext,
    task: LoadedTask,
    mutate: (latestTask: LoadedTask) => Task | LoadedTask | Promise<Task | LoadedTask>,
    metadata?: MutationMetadata,
  ): Promise<LoadedTask> {
    const releaseTaskLock = await this.taskMutex.acquire(task._ulid);

    try {
      // Read latest state from per-task directory (includes existing history)
      const { task: latestTask, history: existingHistory } = await this.loadTaskFromDirWithHistory(ctx, task._ulid);
      if (!latestTask) {
        throw new TaskDataManagerError(
          `Task not found: ${task._ulid}`,
          { suggestion: `Check the reference with: kspec search "${task._ulid}" or kspec task list` },
        );
      }

      // Capture pre-mutation state for diff computation (excluding notes/history)
      const { notes: _notesBefore, todos: _todosBefore, ...coreFieldsBefore } =
        stripRuntimeMetadata(latestTask) as Task;

      // Run mutation callback
      const mutatedTask = await mutate(latestTask);
      const cleanTask = stripRuntimeMetadata(mutatedTask as LoadedTask) as Task;

      // Separate notes from core data for routing
      const { notes, ...coreDataAfter } = cleanTask;

      // Compute field-level diff for history tracking
      // AC: @task-core-data-file ac-1 — detect field changes
      const fieldChanges = computeFieldChanges(
        coreFieldsBefore as Record<string, unknown>,
        coreDataAfter as Record<string, unknown>,
      );

      // Use a write buffer for atomicity
      const existingBuffer = getActiveBatchBuffer();
      const localBuffer = !existingBuffer ? activateBatchBuffer(ctx.specDir) : null;

      try {
        const taskFilePath = getTaskFilePath(ctx, task._ulid);

        // Only write task.yaml if core fields actually changed
        // AC: @task-notes-file ac-1 — note-only mutations don't modify task.yaml
        if (fieldChanges) {
          // Append history entry for the field changes
          // AC: @task-core-data-file ac-1 — history entry appended on mutation
          const historyEntry = createHistoryEntry(fieldChanges, metadata);
          const updatedHistory = [...existingHistory, historyEntry];

          await writeTaskFile(taskFilePath, coreDataAfter, updatedHistory);

          // Update index if indexed fields changed
          await this.updateIndexEntry(ctx, cleanTask);
        }

        // Write notes if they changed
        if (notes !== undefined) {
          const notesFilePath = getNotesFilePath(ctx, task._ulid);
          await writeNotesFile(notesFilePath, notes);
        }

        if (localBuffer) {
          await localBuffer.flush();
        }

        return { ...cleanTask, _sourceFile: taskFilePath };
      } catch (error) {
        if (localBuffer) {
          localBuffer.discard();
        }
        throw error;
      } finally {
        if (localBuffer) {
          deactivateBatchBuffer();
        }
      }
    } finally {
      releaseTaskLock();
    }
  }

  /**
   * Mutate multiple tasks atomically with history tracking.
   *
   * Acquires per-task locks in sorted ULID order to prevent deadlocks,
   * then performs all mutations within a single write buffer transaction.
   *
   * AC: @task-data-manager ac-5 — non-overlapping mutations no contention
   * AC: @task-data-manager ac-6 — all writes in single atomic operation
   * AC: @task-data-manager ac-9 — same-task mutations serialize
   * AC: @task-atomic-writes ac-3 — batch uses single write buffer
   * AC: @task-core-data-file ac-1 — field changes recorded in history
   */
  async mutateTasks(
    ctx: KspecContext,
    tasks: LoadedTask[],
    mutate: (latestTasks: LoadedTask[]) => Array<Task | LoadedTask> | Promise<Array<Task | LoadedTask>>,
    metadata?: MutationMetadata,
  ): Promise<LoadedTask[]> {
    // Acquire per-task locks in sorted order to prevent deadlocks
    const sortedUlids = [...new Set(tasks.map((t) => t._ulid))].sort();
    const releases: Array<() => void> = [];

    try {
      for (const ulid of sortedUlids) {
        releases.push(await this.taskMutex.acquire(ulid));
      }

      // Load latest state for each task (with history for diff tracking)
      const latestResults: Array<{ task: LoadedTask; history: HistoryEntry[] }> = [];
      for (const task of tasks) {
        const result = await this.loadTaskFromDirWithHistory(ctx, task._ulid);
        if (!result.task) {
          throw new TaskDataManagerError(
            `Task not found: ${task._ulid}`,
            { suggestion: `Check the reference with: kspec search "${task._ulid}" or kspec task list` },
          );
        }
        latestResults.push({ task: result.task, history: result.history });
      }

      const latestTasks = latestResults.map((r) => r.task);

      // Capture pre-mutation core fields for diff computation
      const coreFieldsBefore = latestTasks.map((t) => {
        const { notes: _n, todos: _td, ...core } = stripRuntimeMetadata(t) as Task;
        return core as Record<string, unknown>;
      });

      // Run mutation callback
      const mutatedTasks = await mutate(latestTasks);
      if (mutatedTasks.length !== latestTasks.length) {
        throw new Error(
          `Expected ${latestTasks.length} mutated tasks, received ${mutatedTasks.length}`,
        );
      }

      // Write all mutations within a single buffer transaction
      const existingBuffer = getActiveBatchBuffer();
      const localBuffer = !existingBuffer ? activateBatchBuffer(ctx.specDir) : null;

      try {
        const updatedTasks: LoadedTask[] = [];

        for (let i = 0; i < mutatedTasks.length; i++) {
          const mutatedTask = mutatedTasks[i];
          const cleanTask = stripRuntimeMetadata(mutatedTask as LoadedTask) as Task;
          const { notes, ...coreData } = cleanTask;

          const taskFilePath = getTaskFilePath(ctx, cleanTask._ulid);

          // Compute field-level diff for history tracking
          const fieldChanges = computeFieldChanges(
            coreFieldsBefore[i],
            coreData as Record<string, unknown>,
          );

          if (fieldChanges) {
            const historyEntry = createHistoryEntry(fieldChanges, metadata);
            const updatedHistory = [...latestResults[i].history, historyEntry];
            await writeTaskFile(taskFilePath, coreData, updatedHistory);
            await this.updateIndexEntry(ctx, cleanTask);
          }

          if (notes !== undefined) {
            const notesFilePath = getNotesFilePath(ctx, cleanTask._ulid);
            await writeNotesFile(notesFilePath, notes);
          }

          updatedTasks.push({ ...cleanTask, _sourceFile: taskFilePath });
        }

        if (localBuffer) {
          await localBuffer.flush();
        }

        return updatedTasks;
      } catch (error) {
        if (localBuffer) {
          localBuffer.discard();
        }
        throw error;
      } finally {
        if (localBuffer) {
          deactivateBatchBuffer();
        }
      }
    } finally {
      for (const release of releases) {
        release();
      }
    }
  }

  /**
   * Delete a task: remove the entire directory and the index entry.
   *
   * Strategy: Use the write buffer for the index update and file deletions,
   * then remove the directory itself after flush (since the WriteBuffer
   * only handles file-level operations, not recursive directory removal).
   *
   * AC: @task-directory-storage ac-4 — entire directory is removed
   * AC: @task-directory-storage ac-5 — index entry removed in same atomic operation
   */
  async deleteTask(ctx: KspecContext, task: LoadedTask): Promise<void> {
    const releaseTaskLock = await this.taskMutex.acquire(task._ulid);

    try {
      const taskDir = getTaskDir(ctx, task._ulid);
      const existingBuffer = getActiveBatchBuffer();
      const localBuffer = !existingBuffer ? activateBatchBuffer(ctx.specDir) : null;

      try {
        // Delete known per-task files through the buffer
        const taskFilePath = getTaskFilePath(ctx, task._ulid);
        const notesFilePath = getNotesFilePath(ctx, task._ulid);
        const buffer = getActiveBatchBuffer();
        if (buffer) {
          buffer.delete(taskFilePath);
          buffer.delete(notesFilePath);
        }

        // Remove from index (also goes through the buffer)
        await this.removeFromIndex(ctx, task._ulid);

        if (localBuffer) {
          await localBuffer.flush();
        }
      } catch (error) {
        if (localBuffer) {
          localBuffer.discard();
        }
        throw error;
      } finally {
        if (localBuffer) {
          deactivateBatchBuffer();
        }
      }

      // After buffer flush, remove the directory tree directly.
      // This handles unknown files/subdirectories that weren't in the buffer.
      // AC: @task-directory-storage ac-4 — entire directory is removed
      await fs.rm(taskDir, { recursive: true, force: true });
    } finally {
      releaseTaskLock();
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  /**
   * Load a complete task from its per-task directory.
   *
   * Reads task.yaml for core data and notes.yaml for notes,
   * then assembles them into a unified LoadedTask. History is
   * stripped from the assembled task (it's internal to storage).
   *
   * AC: @task-detail-loading ac-1 — assembles complete task from files
   * AC: @task-detail-loading ac-2 — handles missing per-task directory
   */
  private async loadTaskFromDir(
    ctx: KspecContext,
    ulid: string,
  ): Promise<LoadedTask | undefined> {
    const result = await this.loadTaskFromDirWithHistory(ctx, ulid);
    return result.task;
  }

  /**
   * Load a task from its per-task directory, returning both the task
   * and the raw history entries from task.yaml.
   *
   * The history is NOT included in the returned LoadedTask (it's
   * internal to the split storage format). It's returned separately
   * for use by mutation operations that need to append new entries.
   *
   * AC: @task-core-data-file ac-2 — history provides complete audit trail
   * AC: @task-detail-loading ac-1 — assembles complete task from files
   */
  private async loadTaskFromDirWithHistory(
    ctx: KspecContext,
    ulid: string,
  ): Promise<{ task: LoadedTask | undefined; history: HistoryEntry[] }> {
    const taskFilePath = getTaskFilePath(ctx, ulid);
    const notesFilePath = getNotesFilePath(ctx, ulid);

    try {
      // Read core data
      const rawCore = await readYamlFile<unknown>(taskFilePath);
      if (!rawCore || typeof rawCore !== "object") {
        return { task: undefined, history: [] };
      }

      const rawCoreObj = rawCore as Record<string, unknown>;

      // Extract history before assembling the task
      // History is internal to the split format — not part of TaskSchema
      const history: HistoryEntry[] = Array.isArray(rawCoreObj.history)
        ? (rawCoreObj.history as HistoryEntry[])
        : [];

      // Remove history from the core data before schema validation
      const { history: _h, ...coreWithoutHistory } = rawCoreObj;

      // Read notes (may not exist)
      // AC: @task-notes-file ac-2 — missing file treated as zero notes
      let notes: unknown[] = [];
      try {
        const rawNotes = await readYamlFile<unknown>(notesFilePath);
        if (rawNotes && typeof rawNotes === "object" && "notes" in rawNotes) {
          const notesWrapper = rawNotes as Record<string, unknown>;
          notes = Array.isArray(notesWrapper.notes) ? notesWrapper.notes : [];
        } else if (Array.isArray(rawNotes)) {
          notes = rawNotes;
        }
      } catch {
        // Notes file doesn't exist — zero notes
        // AC: @task-notes-file ac-2 — treated as zero notes
      }

      // Assemble the complete task (without history — it's not in the schema)
      const assembled = { ...coreWithoutHistory, notes };
      const parsed = TaskSchema.safeParse(assembled);
      if (!parsed.success) {
        return { task: undefined, history: [] };
      }

      return {
        task: { ...parsed.data, _sourceFile: taskFilePath },
        history,
      };
    } catch {
      return { task: undefined, history: [] };
    }
  }

  /**
   * Get the history entries for a task from its per-task directory.
   *
   * This is the public interface for reading history — callers use this
   * to display the audit trail without needing to know the storage format.
   *
   * AC: @task-core-data-file ac-2 — history provides complete audit trail
   */
  async getTaskHistory(
    ctx: KspecContext,
    ulid: string,
  ): Promise<HistoryEntry[]> {
    const { history } = await this.loadTaskFromDirWithHistory(ctx, ulid);
    return history;
  }

  /**
   * Add a new entry to the index file.
   *
   * AC: @task-index-file ac-5 — index entry added atomically with directory
   */
  private async addToIndex(ctx: KspecContext, task: Task): Promise<void> {
    const indexPath = getIndexFilePath(ctx);
    const indexEntry = this.toIndexEntry(task);

    // Read current index
    let rawTasks: unknown[] = [];
    let useWrapper = false;
    let wrapperObj: Record<string, unknown> | undefined;

    try {
      const raw = await readYamlFile<unknown>(indexPath);
      if (Array.isArray(raw)) {
        rawTasks = raw;
      } else if (raw && typeof raw === "object" && "tasks" in raw) {
        wrapperObj = raw as Record<string, unknown>;
        rawTasks = Array.isArray(wrapperObj.tasks) ? [...wrapperObj.tasks as unknown[]] : [];
        useWrapper = true;
      }
    } catch {
      // Index doesn't exist yet
    }

    rawTasks.push(indexEntry);

    if (useWrapper && wrapperObj) {
      await writeYamlFile(indexPath, { ...wrapperObj, tasks: rawTasks });
    } else {
      await writeYamlFile(indexPath, rawTasks);
    }
  }

  /**
   * Update an existing index entry.
   *
   * AC: @task-index-file ac-2 — index and per-task file updated atomically
   */
  private async updateIndexEntry(ctx: KspecContext, task: Task): Promise<void> {
    const indexPath = getIndexFilePath(ctx);
    const indexEntry = this.toIndexEntry(task);

    const raw = await readYamlFile<unknown>(indexPath);
    let rawTasks: unknown[];
    let useWrapper = false;
    let wrapperObj: Record<string, unknown> | undefined;

    if (Array.isArray(raw)) {
      rawTasks = raw;
    } else if (raw && typeof raw === "object" && "tasks" in raw) {
      wrapperObj = raw as Record<string, unknown>;
      rawTasks = Array.isArray(wrapperObj.tasks) ? [...wrapperObj.tasks as unknown[]] : [];
      useWrapper = true;
    } else {
      rawTasks = [];
    }

    // Find and replace the matching entry
    const existingIdx = rawTasks.findIndex(
      (entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>)._ulid === task._ulid,
    );

    if (existingIdx >= 0) {
      rawTasks[existingIdx] = indexEntry;
    } else {
      // Entry not found — add it (recovery path)
      rawTasks.push(indexEntry);
    }

    if (useWrapper && wrapperObj) {
      await writeYamlFile(indexPath, { ...wrapperObj, tasks: rawTasks });
    } else {
      await writeYamlFile(indexPath, rawTasks);
    }
  }

  /**
   * Remove an entry from the index file.
   *
   * AC: @task-directory-storage ac-5 — index entry removed atomically with directory
   */
  private async removeFromIndex(ctx: KspecContext, ulid: string): Promise<void> {
    const indexPath = getIndexFilePath(ctx);

    const raw = await readYamlFile<unknown>(indexPath);
    let rawTasks: unknown[];
    let useWrapper = false;
    let wrapperObj: Record<string, unknown> | undefined;

    if (Array.isArray(raw)) {
      rawTasks = raw;
    } else if (raw && typeof raw === "object" && "tasks" in raw) {
      wrapperObj = raw as Record<string, unknown>;
      rawTasks = Array.isArray(wrapperObj.tasks) ? [...wrapperObj.tasks as unknown[]] : [];
      useWrapper = true;
    } else {
      return; // No index to remove from
    }

    // Filter out the matching entry
    rawTasks = rawTasks.filter(
      (entry) => !(entry && typeof entry === "object" && (entry as Record<string, unknown>)._ulid === ulid),
    );

    if (useWrapper && wrapperObj) {
      await writeYamlFile(indexPath, { ...wrapperObj, tasks: rawTasks });
    } else {
      await writeYamlFile(indexPath, rawTasks);
    }
  }

  /**
   * Extract the index-level fields from a full task record.
   *
   * AC: @task-index-file ac-1 — only listing/filtering/dependency fields
   */
  private toIndexEntry(task: Task): Record<string, unknown> {
    const entry: Record<string, unknown> = {
      _ulid: task._ulid,
      slugs: task.slugs,
      title: task.title,
      type: task.type,
      status: task.status,
      priority: task.priority,
      tags: task.tags,
      depends_on: task.depends_on,
      blocked_by: task.blocked_by,
      created_at: task.created_at,
      // Persist counts as scalars so rawToSummary can derive them
      // without reading per-task files (notes/todos live outside the index)
      notes_count: Array.isArray(task.notes) ? task.notes.length : 0,
      todos_count: Array.isArray(task.todos) ? task.todos.length : 0,
    };

    // Include optional indexed fields only when present
    if (task.assignee !== undefined && task.assignee !== null) {
      entry.assignee = task.assignee;
    }
    if (task.automation !== undefined) {
      entry.automation = task.automation;
    }
    if (task.spec_ref !== undefined && task.spec_ref !== null) {
      entry.spec_ref = task.spec_ref;
    }
    if (task.plan_ref !== undefined && task.plan_ref !== null) {
      entry.plan_ref = task.plan_ref;
    }
    if (task.review_ref !== undefined && task.review_ref !== null) {
      entry.review_ref = task.review_ref;
    }
    if (task.started_at) {
      entry.started_at = task.started_at;
    }
    if (task.submitted_at) {
      entry.submitted_at = task.submitted_at;
    }
    if (task.completed_at) {
      entry.completed_at = task.completed_at;
    }

    return entry;
  }
}

// ── File Write Helpers ───────────────────────────────────────────────────────

/**
 * Write a task core data file (task.yaml).
 * Includes optional history entries alongside core data.
 * Uses buffer-aware writing for atomicity in batch operations.
 *
 * AC: @task-core-data-file ac-1 — history appended to task.yaml
 */
async function writeTaskFile(
  filePath: string,
  coreData: Record<string, unknown>,
  history?: HistoryEntry[],
): Promise<void> {
  const dataWithHistory: Record<string, unknown> = { ...coreData };
  if (history && history.length > 0) {
    dataWithHistory.history = history;
  }
  const content = toYaml(dataWithHistory);
  await writeFileBufferAware(filePath, content);
}

/**
 * Write a notes file (notes.yaml).
 * Uses buffer-aware writing for atomicity in batch operations.
 */
async function writeNotesFile(
  filePath: string,
  notes: unknown[],
): Promise<void> {
  const content = toYaml({ notes });
  await writeFileBufferAware(filePath, content);
}

// ── Registration ─────────────────────────────────────────────────────────────

/** Singleton instance of the split backend. */
export const splitBackend = new SplitBackend();

/**
 * Register the split backend with the task data manager.
 *
 * Exported as a function (not called at module scope) to avoid circular
 * dependency issues — split-backend imports from task-data-manager, and
 * calling registerBackend() at the top level would access backendRegistry
 * before it is initialized. Instead, the TaskDataManager constructor
 * calls ensureSplitBackend() when format "split" is requested.
 *
 * AC: @task-data-manager ac-8 — enables split format activation
 */
export function ensureSplitBackendRegistered(): void {
  registerBackend(splitBackend);
}
