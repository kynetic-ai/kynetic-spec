/**
 * Split storage backend for per-task directory storage.
 *
 * Implements the TaskStorageBackend interface for the split format where
 * each task has its own directory (.kspec/tasks/<full-ulid>/) containing
 * task.yaml and notes.yaml, with a lean index in project.tasks.yaml.
 *
 * This module provides:
 * - Format detection (legacy vs split)
 * - Directory layout conventions (.kspec/tasks/<full-ulid>/)
 * - Routing logic (which operations touch index, per-task files, or both)
 * - Per-task file locking replacing whole-file locking
 * - Index entry projection and change detection (@task-impl-index)
 * - Index rebuild from per-task files (@task-impl-index)
 *
 * Spec: @task-directory-storage
 * Task: @task-impl-split-storage
 */

import * as fs from "node:fs/promises";
import type { Task } from "../schema/task.js";
import { TaskSchema } from "../schema/task.js";
import {
  getActiveBatchBuffer,
  runWithBuffer,
  mkdirBufferAware,
  writeFileBufferAware,
} from "../cli/batch-write-buffer.js";
import type { MutationMetadata, TaskStorageBackend, TaskSummary } from "./task-data-manager.js";
// Re-export history types from their canonical home in task-data-manager
export type { HistoryEntry, HistoryFieldChange } from "./task-data-manager.js";
import type { HistoryEntry, HistoryFieldChange } from "./task-data-manager.js";
import {
  TaskDataManagerError,
  TASK_STORAGE_SPLIT_UNMIGRATED_CODE,
  registerBackend,
} from "./task-data-manager.js";
import type { KspecContext, LoadedTask } from "./yaml.js";
import {
  findTaskByRef,
  getAuthor,
  getDefaultTaskFilePath,
  readYamlFile,
  stripRuntimeMetadata,
  TASK_SCHEMA_KEYS,
  toYaml,
} from "./yaml.js";
import { rawToSummary } from "./task-data-manager.js";
import {
  type FolderBackedEntityLayout,
  getEntityDir as getFolderBackedEntityDir,
  getEntityFilePath as getFolderBackedEntityFilePath,
  getStorageRoot as getFolderBackedStorageRoot,
  indexEntriesEqualForFields,
  isValidUlidDirName,
  listEntityDirs,
  mergePreservingRawShape,
  readIndexEntries,
  rebuildEntityIndex,
  writeIndexEntries,
} from "./folder-backed-entity.js";

/**
 * Task-specific wrapper around the shared unknown-field preservation
 * helper. Tasks use the canonical task schema key set so mutations
 * round-trip extension fields without polluting YAML with vacuous defaults.
 *
 * AC: @task-core-data-file ac-4 — preserve unknown fields through mutation
 * AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
 */
export function mergeTaskPreservingRawShape(
  rawTask: Record<string, unknown>,
  normalizedTask: Record<string, unknown>,
): Record<string, unknown> {
  return mergePreservingRawShape(rawTask, normalizedTask, TASK_SCHEMA_KEYS);
}

// ── Folder-Backed Entity Layout ──────────────────────────────────────────────

/**
 * Storage layout for the task entity. Tasks adopt the folder-backed entity
 * trait: each task owns a ULID directory under `<specDir>/tasks/`, and a
 * lean index lives at `<specDir>/project.tasks.yaml`.
 *
 * Spec: @trait-folder-backed-entity-1
 */
const TASK_LAYOUT: FolderBackedEntityLayout = {
  entityType: "task",
  storageRoot: "tasks",
  // indexFile is derived from getDefaultTaskFilePath(); we override the
  // shared getEntityIndexPath helper at call sites so the index path
  // remains consistent with legacy callers. Use the bare file name here
  // for diagnostic completeness.
  indexFile: "project.tasks.yaml",
  // Tasks support both bare-array and { tasks: [...] } wrapper formats on
  // disk for backward compatibility with hand-edited project.tasks.yaml.
  indexWrapperKey: "tasks",
};

// ── History Helpers ──────────────────────────────────────────────────────────

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
  // Fields to skip — notes are in a separate file, history is internal metadata
  const skipFields = new Set(["_sourceFile", "notes", "history"]);

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
//
// Task-specific thin wrappers around the shared folder-backed entity helpers.
// The trait foundation (src/parser/folder-backed-entity.ts) owns the storage
// shape; this module owns the task-specific schema and mutation semantics.

/**
 * Get the tasks directory path for a given context.
 * This is the parent directory containing all per-task directories.
 *
 * Layout: <specDir>/tasks/
 *
 * AC: @task-directory-storage ac-1 — directory named by full ULID
 * AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
 */
export function getTasksDir(ctx: KspecContext): string {
  return getFolderBackedStorageRoot(ctx, TASK_LAYOUT);
}

/**
 * Get the directory path for a specific task.
 *
 * Layout: <specDir>/tasks/<full-ulid>/
 *
 * AC: @task-directory-storage ac-1 — task has its own directory named by full ULID
 * AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
 */
export function getTaskDir(ctx: KspecContext, ulid: string): string {
  return getFolderBackedEntityDir(ctx, TASK_LAYOUT, ulid);
}

/**
 * Get the path to a task's core data file.
 *
 * Layout: <specDir>/tasks/<full-ulid>/task.yaml
 *
 * AC: @task-directory-storage ac-2 — core data in separate file
 */
export function getTaskFilePath(ctx: KspecContext, ulid: string): string {
  return getFolderBackedEntityFilePath(ctx, TASK_LAYOUT, ulid, "task.yaml");
}

/**
 * Get the path to a task's notes file.
 *
 * Layout: <specDir>/tasks/<full-ulid>/notes.yaml
 *
 * AC: @task-directory-storage ac-2 — notes in separate file
 */
export function getNotesFilePath(ctx: KspecContext, ulid: string): string {
  return getFolderBackedEntityFilePath(ctx, TASK_LAYOUT, ulid, "notes.yaml");
}

/**
 * Get the index file path (same as default task file for now).
 *
 * Layout: <specDir>/project.tasks.yaml (lean index with filterable fields only)
 *
 * Resolved via getDefaultTaskFilePath() rather than the layout's `indexFile`
 * field so the path stays consistent with legacy callers that derive the
 * task index from yaml.ts.
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
    return entries.some((entry) => entry.isDirectory() && isValidUlidDirName(entry.name));
  } catch {
    return false;
  }
}

/**
 * List all task ULID directories in the tasks/ directory.
 *
 * Returns the ULID directory names (not full paths).
 * Only includes entries that are directories with valid ULID names —
 * unknown files and non-ULID subdirectories are ignored by task semantics
 * and preserved on disk via the trait foundation.
 *
 * AC: @task-directory-storage ac-1 — directories named by full ULID
 * AC: @task-directory-storage ac-3 — unknown files/dirs are ignored
 * AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
 * AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
 */
export async function listTaskDirs(ctx: KspecContext): Promise<string[]> {
  return listEntityDirs(ctx, TASK_LAYOUT);
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
 * | mutateTask    | WRITE*| WRITE     | WRITE*     |
 * | deleteTask    | WRITE | DELETE    | DELETE     |
 * | mutateTasks   | WRITE*| WRITE     | WRITE*     |
 *
 * * Index is only written when indexed fields change.
 *   This includes notes_count/todos_count — these are indexed fields
 *   used by list surfaces. Note *content* is non-indexed (AC-3),
 *   but the derived count is an indexed field (AC-2).
 *
 * AC: @task-index-file ac-3 — note-only mutations don't touch index
 */
export type OperationType =
  | "list" // Read index only
  | "get" // Read per-task files
  | "create" // Write index + per-task files
  | "mutate" // Write per-task file, conditionally index
  | "note" // Write notes.yaml only
  | "delete"; // Remove from index + delete directory

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

// ── Index Entry Helpers ──────────────────────────────────────────────────────

/**
 * The set of fields that are stored in the index. Used to detect whether
 * an index write is needed after a mutation.
 *
 * AC: @task-index-file ac-1 — only listing/filtering/dependency fields
 */
const INDEXED_FIELDS = [
  "_ulid",
  "slugs",
  "title",
  "type",
  "status",
  "priority",
  "tags",
  "depends_on",
  "blocked_by",
  "created_at",
  "assignee",
  "automation",
  "spec_ref",
  "plan_ref",
  "review_ref",
  "started_at",
  "submitted_at",
  "completed_at",
  "notes_count",
  "todos_count",
] as const;

/**
 * Extract the index-level fields from a full task record.
 * This is the canonical projection used for index entries.
 *
 * AC: @task-index-file ac-1 — only listing/filtering/dependency fields
 */
export function toIndexEntry(task: Task): Record<string, unknown> {
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

/**
 * Compare two index entries for equality on all indexed fields.
 * Returns true if all indexed fields (including notes_count/todos_count)
 * have the same values.
 *
 * notes_count and todos_count ARE included in the comparison because they
 * are indexed fields used by list surfaces. When a note is added, the note
 * *content* is non-indexed data (AC-3), but the *count* is a derived indexed
 * field that changes — triggering an index write per AC-2 (filterable field
 * changes are persisted to both index and per-task file atomically).
 *
 * Delegates to the shared trait foundation so all folder-backed entities
 * compare bounded index projections with identical semantics.
 *
 * AC: @task-index-file ac-2 — index updated when any indexed field changes
 * AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
 */
export function indexEntriesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return indexEntriesEqualForFields(a, b, INDEXED_FIELDS);
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
/**
 * Single-resource FIFO mutex for serializing index read-modify-write cycles.
 *
 * Concurrent mutations on different tasks each get their own write buffer
 * (via runWithBuffer), so they can't see each other's buffered index writes.
 * Without serialization, two concurrent flushes can each overwrite the
 * other's index entry change. This mutex serializes index operations so
 * each read-modify-write cycle completes before the next begins.
 */
class IndexMutex {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    const predecessor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    return release;
  }
}

class SplitBackend implements TaskStorageBackend {
  readonly format = "split" as const;
  private readonly indexMutex = new IndexMutex();
  /** Per-specDir cache so each project is checked at most once. */
  private readonly migrationChecked = new Set<string>();

  /**
   * Verify that migration has been completed before allowing split operations.
   *
   * Detects unmigrated legacy entries by checking if project.tasks.yaml
   * contains full task records (with `notes` arrays) rather than lean index
   * entries (with `notes_count` scalars). When unmigrated entries are found
   * without corresponding per-task directories, an error is raised.
   *
   * AC: @task-storage-activation ac-3 — error when unmigrated tasks exist
   * AC: @task-storage-activation ac-5 — empty task set operates normally
   */
  private async ensureMigrated(ctx: KspecContext): Promise<void> {
    const key = ctx.specDir;
    if (this.migrationChecked.has(key)) return;

    const indexPath = getIndexFilePath(ctx);
    let rawEntries: unknown[];
    try {
      const raw = await readYamlFile<unknown>(indexPath);
      if (Array.isArray(raw)) {
        rawEntries = raw;
      } else if (raw && typeof raw === "object" && "tasks" in raw) {
        const wrapper = raw as Record<string, unknown>;
        rawEntries = Array.isArray(wrapper.tasks) ? wrapper.tasks : [];
      } else {
        rawEntries = [];
      }
    } catch {
      // File doesn't exist or is unreadable — empty set, proceed normally
      rawEntries = [];
    }

    // No entries at all — empty project, split is fine (ac-5)
    if (rawEntries.length === 0) {
      this.migrationChecked.add(key);
      return;
    }

    // Check for unmigrated entries: lean index entries use `notes_count`
    // as a scalar number. Any entry without `notes_count` as a number is
    // potentially unmigrated (including entries with malformed/missing notes).
    const unmigratedEntries = rawEntries.filter((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const rec = entry as Record<string, unknown>;
      return typeof rec.notes_count !== "number";
    });

    if (unmigratedEntries.length > 0) {
      // Verify these aren't already migrated (per-task dirs exist)
      const taskDirs = await listTaskDirs(ctx);
      const dirSet = new Set(taskDirs);
      const trulyUnmigrated = unmigratedEntries.filter((entry) => {
        const rec = entry as Record<string, unknown>;
        return typeof rec._ulid === "string" && !dirSet.has(rec._ulid);
      });

      if (trulyUnmigrated.length > 0) {
        throw new TaskDataManagerError(
          `Storage format is set to "split" but ${trulyUnmigrated.length} task(s) in project.tasks.yaml have not been migrated to per-task directories.`,
          {
            suggestion:
              'Run "kspec task migrate" to convert unmigrated entries to per-task directories.',
            field: "task_storage.format",
            code: TASK_STORAGE_SPLIT_UNMIGRATED_CODE,
          },
        );
      }
    }

    this.migrationChecked.add(key);
  }

  /**
   * List tasks by reading only the index file.
   *
   * AC: @task-data-manager ac-2 — only index data is read
   * AC: @task-listing-performance ac-1 — only project.tasks.yaml is read
   */
  async listTasks(ctx: KspecContext): Promise<TaskSummary[]> {
    await this.ensureMigrated(ctx);
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
    await this.ensureMigrated(ctx);
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
   * Load all tasks with their field-change history in a single bulk pass.
   *
   * Uses the same directory iteration as loadAllTasks() but retains the
   * history output from loadTaskFromDirWithHistory() instead of discarding it.
   *
   * AC: @daemon-entity-cache ac-task-history-retention — bulk load retains history
   */
  async loadAllTasksWithHistory(
    ctx: KspecContext,
  ): Promise<Array<{ task: LoadedTask; history: HistoryEntry[] }>> {
    await this.ensureMigrated(ctx);
    const ulids = await listTaskDirs(ctx);
    const results: Array<{ task: LoadedTask; history: HistoryEntry[] }> = [];

    for (const ulid of ulids) {
      try {
        const { task, history } = await this.loadTaskFromDirWithHistory(ctx, ulid);
        if (task) {
          results.push({ task, history });
        }
      } catch {
        // Skip tasks that fail to load — consistent with loadAllTasks()
      }
    }

    return results;
  }

  /**
   * Get a single task's full details.
   *
   * Uses per-task directory files, not the index.
   *
   * AC: @task-data-manager ac-3 — assembles complete task transparently
   * AC: @task-detail-loading ac-1 — reads per-task directory for complete data
   * AC: @task-detail-loading ac-2 — falls back to index data when per-task directory is missing
   */
  async getTask(ctx: KspecContext, ref: string): Promise<LoadedTask | undefined> {
    await this.ensureMigrated(ctx);
    // First try direct ULID lookup (fast path)
    if (/^[0-9A-HJKMNP-TV-Z]{10,26}$/.test(ref)) {
      // Could be a full ULID or a short ULID prefix
      if (ref.length === 26) {
        const task = await this.loadTaskFromDir(ctx, ref);
        if (task) return task;
        // AC: @task-detail-loading ac-2 — fallback to index when per-task directory is missing
        return this.fallbackToIndexEntry(ctx, ref);
      }
      // Short ULID prefix — scan directories
      const ulids = await listTaskDirs(ctx);
      const matching = ulids.filter((u) => u.startsWith(ref));
      if (matching.length === 1) {
        const task = await this.loadTaskFromDir(ctx, matching[0]);
        if (task) return task;
        return this.fallbackToIndexEntry(ctx, matching[0]);
      }
      // No directory match — try index for short ULID prefix
      // AC: @task-detail-loading ac-2 — index fallback for missing per-task directory
      if (matching.length === 0) {
        return this.fallbackToIndexEntry(ctx, ref);
      }
    }

    // Fall back to loading all tasks and finding by ref (handles slugs)
    const allTasks = await this.loadAllTasks(ctx);
    const found = findTaskByRef(allTasks, ref);
    if (found) return found;

    // Last resort: try slug-based lookup against the index
    // AC: @task-detail-loading ac-2 — index fallback for missing per-task directory
    return this.fallbackToIndexEntryByRef(ctx, ref);
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
    await this.ensureMigrated(ctx);
    const taskDir = getTaskDir(ctx, task._ulid);
    const taskFilePath = getTaskFilePath(ctx, task._ulid);
    const notesFilePath = getNotesFilePath(ctx, task._ulid);

    // runWithBuffer creates an isolated async-local scope. If a parent
    // buffer exists (from withWriteBuffer or batch-exec), it's reused.
    // Both per-task files AND the index write are inside the buffer so
    // they flush atomically — if the index write fails, per-task files
    // are not committed either (the buffer discards on error).
    await runWithBuffer(ctx.specDir, async () => {
      // Create directory
      await mkdirBufferAware(taskDir);

      // Separate notes from core data
      const { notes, ...coreData } = stripRuntimeMetadata(task as LoadedTask) as Task;

      // Write core data file (task.yaml) — no history for new tasks
      await writeTaskFile(taskFilePath, coreData);

      // Write notes file (notes.yaml)
      await writeNotesFile(notesFilePath, notes || []);

      // Add to index within the same buffer — serialized by indexMutex
      // AC: @task-index-file ac-5 — index entry added atomically with per-task files
      const releaseIndex = await this.indexMutex.acquire();
      try {
        await this.addToIndex(ctx, task);
      } finally {
        releaseIndex();
      }
    });

    return { ...task, _sourceFile: taskFilePath };
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
   * AC: @task-index-file ac-2 — index updated when indexed fields change
   * AC: @task-index-file ac-3 — note/history content not stored in index
   * AC: @task-core-data-file ac-1 — field changes recorded in history
   * AC: @task-notes-file ac-1 — note-only mutations don't touch task.yaml
   */
  async mutateTask(
    ctx: KspecContext,
    task: LoadedTask,
    mutate: (latestTask: LoadedTask) => Task | LoadedTask | Promise<Task | LoadedTask>,
    metadata?: MutationMetadata,
  ): Promise<LoadedTask> {
    await this.ensureMigrated(ctx);

    // Per-task locking is handled by TaskDataManager.mutateTask, which
    // holds the lock through the buffer flush. This method is always
    // called inside a write buffer scope (from TaskDataManager.withWriteBuffer),
    // so runWithBuffer reuses the existing buffer — writes are buffered,
    // and the flush happens after this method returns, while the outer
    // lock is still held.

    // Read latest state from per-task directory (includes existing history)
    // AC: @task-core-data-file ac-4 — rawCore preserved for unknown field round-trip
    const {
      task: latestTask,
      history: existingHistory,
      rawCore,
    } = await this.loadTaskFromDirWithHistory(ctx, task._ulid);
    if (!latestTask) {
      throw new TaskDataManagerError(`Task not found: ${task._ulid}`, {
        suggestion: `Check the reference with: kspec search "${task._ulid}" or kspec task list`,
      });
    }

    // Snapshot the index entry BEFORE mutation to detect changes
    const oldIndexEntry = toIndexEntry(latestTask);

    // Capture pre-mutation state for diff computation (excluding notes — they live in notes.yaml)
    const { notes: _notesBefore, ...coreFieldsBefore } = stripRuntimeMetadata(latestTask) as Task;

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

    // Use a write buffer for per-task file AND index atomicity —
    // runWithBuffer reuses the existing buffer from TaskDataManager.withWriteBuffer.
    // Both per-task files and the index write are inside the buffer so they flush
    // atomically — if either write fails, the buffer discards all.
    const taskFilePath = getTaskFilePath(ctx, task._ulid);

    await runWithBuffer(ctx.specDir, async () => {
      // Only write task.yaml if core fields actually changed
      // AC: @task-notes-file ac-1 — note-only mutations don't modify task.yaml
      if (fieldChanges) {
        // Append history entry for the field changes
        // AC: @task-core-data-file ac-1 — history entry appended on mutation
        const historyEntry = createHistoryEntry(fieldChanges, metadata);
        const updatedHistory = [...existingHistory, historyEntry];

        // AC: @task-core-data-file ac-4 — preserve unknown fields through mutation
        const mergedCore = mergeTaskPreservingRawShape(rawCore, coreDataAfter);
        await writeTaskFile(taskFilePath, mergedCore, updatedHistory);
      }

      // Write notes if they changed
      if (notes !== undefined) {
        const notesFilePath = getNotesFilePath(ctx, task._ulid);
        await writeNotesFile(notesFilePath, notes);
      }

      // Index update inside the same buffer — serialized by indexMutex.
      // The mutex prevents concurrent mutations on different tasks from
      // clobbering each other's index entry changes.
      // AC: @task-index-file ac-2 — index updated when indexed fields change
      const newIndexEntry = toIndexEntry(cleanTask);
      if (!indexEntriesEqual(oldIndexEntry, newIndexEntry)) {
        const releaseIndex = await this.indexMutex.acquire();
        try {
          await this.updateIndexEntry(ctx, cleanTask);
        } finally {
          releaseIndex();
        }
      }
    });

    return { ...cleanTask, _sourceFile: taskFilePath };
  }

  /**
   * Persist actor-field rewrites the historical actor-normalization migration
   * applied to a task, INCLUDING the per-task `history` array.
   *
   * The normal {@link mutateTask} path cannot serve this: it re-reads the
   * existing history from disk and only ever appends a new entry, so it can
   * neither expose nor rewrite the `author` of existing history entries. The
   * migration needs to rewrite `history[].author` in place, so it hands the
   * rewritten core task (assignee, todos, notes) plus the rewritten history
   * array straight back here.
   *
   * Round-trips task.yaml (core + history) and notes.yaml preserving on-disk
   * shape via the same raw-merge the mutate path uses, and refreshes the index
   * entry so indexed actor fields (assignee) do not drift from the per-task
   * file. No synthetic history entry is appended — the only change is the
   * actor rewrite the caller already made.
   *
   * AC: @actor-history-normalization ac-5 — every inventoried task actor field
   *     ends canonical-or-default, including history[].author
   */
  async saveActorNormalizedTask(
    ctx: KspecContext,
    task: LoadedTask,
    history: HistoryEntry[],
  ): Promise<void> {
    await this.ensureMigrated(ctx);

    // Reload the raw core so unknown fields round-trip; discard its history —
    // the caller supplies the rewritten history array.
    const { rawCore } = await this.loadTaskFromDirWithHistory(ctx, task._ulid);

    const clean = stripRuntimeMetadata(task) as Record<string, unknown>;
    // `history` is persisted separately (and re-attached by writeTaskFile); make
    // sure it never leaks into the core merge, even if the caller left it on the
    // task object it walked.
    delete clean.history;
    const { notes, ...coreDataAfter } = clean as { notes?: unknown[] } & Record<string, unknown>;

    const taskFilePath = getTaskFilePath(ctx, task._ulid);
    const notesFilePath = getNotesFilePath(ctx, task._ulid);

    await runWithBuffer(ctx.specDir, async () => {
      // AC: @task-core-data-file ac-4 — preserve unknown fields through the write
      const mergedCore = mergeTaskPreservingRawShape(rawCore, coreDataAfter);
      await writeTaskFile(taskFilePath, mergedCore, history);

      if (notes !== undefined) {
        await writeNotesFile(notesFilePath, notes);
      }

      // Keep the index in step with the rewritten per-task file (assignee is an
      // indexed actor field) — serialized by indexMutex like the mutate path.
      // Use `clean` (still carries notes/todos) so the index keeps accurate
      // notes_count/todos_count; coreDataAfter has notes stripped for the file.
      const releaseIndex = await this.indexMutex.acquire();
      try {
        await this.updateIndexEntry(ctx, clean as unknown as Task);
      } finally {
        releaseIndex();
      }
    });
  }

  /**
   * Mutate multiple tasks atomically with history tracking.
   *
   * Per-task locking is handled by TaskDataManager.mutateTasks, which
   * acquires locks in sorted ULID order and holds them through the buffer
   * flush. This method performs all mutations within the existing write
   * buffer transaction provided by TaskDataManager.withWriteBuffer.
   *
   * AC: @task-data-manager ac-5 — non-overlapping mutations no contention
   * AC: @task-data-manager ac-6 — all writes in single atomic operation
   * AC: @task-data-manager ac-9 — same-task mutations serialize
   * AC: @task-atomic-writes ac-3 — batch uses single write buffer
   * AC: @task-index-file ac-2 — index updated when indexed fields change
   * AC: @task-core-data-file ac-1 — field changes recorded in history
   */
  async mutateTasks(
    ctx: KspecContext,
    tasks: LoadedTask[],
    mutate: (
      latestTasks: LoadedTask[],
    ) => Array<Task | LoadedTask> | Promise<Array<Task | LoadedTask>>,
    metadata?: MutationMetadata,
  ): Promise<LoadedTask[]> {
    await this.ensureMigrated(ctx);

    // Load latest state for each task (with history for diff tracking)
    // AC: @task-core-data-file ac-4 — rawCore preserved for unknown field round-trip
    const latestResults: Array<{
      task: LoadedTask;
      history: HistoryEntry[];
      rawCore: Record<string, unknown>;
    }> = [];
    for (const task of tasks) {
      const result = await this.loadTaskFromDirWithHistory(ctx, task._ulid);
      if (!result.task) {
        throw new TaskDataManagerError(`Task not found: ${task._ulid}`, {
          suggestion: `Check the reference with: kspec search "${task._ulid}" or kspec task list`,
        });
      }
      latestResults.push({ task: result.task, history: result.history, rawCore: result.rawCore });
    }

    const latestTasks = latestResults.map((r) => r.task);

    // Snapshot index entries BEFORE mutation
    const oldIndexEntries = latestTasks.map((t) => toIndexEntry(t));

    // Capture pre-mutation core fields for diff computation (excluding notes — they live in notes.yaml)
    const coreFieldsBefore = latestTasks.map((t) => {
      const { notes: _n, ...core } = stripRuntimeMetadata(t) as Task;
      return core as Record<string, unknown>;
    });

    // Run mutation callback
    const mutatedTasks = await mutate(latestTasks);
    if (mutatedTasks.length !== latestTasks.length) {
      throw new Error(
        `Expected ${latestTasks.length} mutated tasks, received ${mutatedTasks.length}`,
      );
    }

    // Write per-task files AND index within a single buffer transaction.
    // runWithBuffer reuses the existing buffer from TaskDataManager.withWriteBuffer.
    // Both per-task files and index writes are inside the buffer for atomicity.
    const cleanResults: Array<{
      cleanTask: Task;
      taskFilePath: string;
      oldIndexEntry: Record<string, unknown>;
    }> = [];

    await runWithBuffer(ctx.specDir, async () => {
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
          // AC: @task-core-data-file ac-4 — preserve unknown fields through mutation
          const mergedCore = mergeTaskPreservingRawShape(latestResults[i].rawCore, coreData);
          await writeTaskFile(taskFilePath, mergedCore, updatedHistory);
        }

        if (notes !== undefined) {
          const notesFilePath = getNotesFilePath(ctx, cleanTask._ulid);
          await writeNotesFile(notesFilePath, notes);
        }

        cleanResults.push({ cleanTask, taskFilePath, oldIndexEntry: oldIndexEntries[i] });
      }

      // Index updates inside the same buffer — serialized by indexMutex
      // AC: @task-index-file ac-2 — index updated when indexed fields change
      const indexUpdates: Task[] = [];
      for (const { cleanTask, oldIndexEntry } of cleanResults) {
        const newIndexEntry = toIndexEntry(cleanTask);
        if (!indexEntriesEqual(oldIndexEntry, newIndexEntry)) {
          indexUpdates.push(cleanTask);
        }
      }

      if (indexUpdates.length > 0) {
        const releaseIndex = await this.indexMutex.acquire();
        try {
          for (const task of indexUpdates) {
            await this.updateIndexEntry(ctx, task);
          }
        } finally {
          releaseIndex();
        }
      }
    });

    const updatedTasks: LoadedTask[] = cleanResults.map(({ cleanTask, taskFilePath }) => ({
      ...cleanTask,
      _sourceFile: taskFilePath,
    }));
    return updatedTasks;
  }

  /**
   * Delete a task: remove the entire directory and the index entry.
   *
   * Strategy: Use the write buffer for the index update, file deletions,
   * and directory removal. The buffer defers directory removal to flush
   * so it participates in atomicity. Per-task locking is handled by
   * TaskDataManager.deleteTask, which holds the lock through the flush.
   *
   * AC: @task-directory-storage ac-4 — entire directory is removed
   * AC: @task-directory-storage ac-5 — index entry removed in same atomic operation
   */
  async deleteTask(ctx: KspecContext, task: LoadedTask): Promise<void> {
    await this.ensureMigrated(ctx);

    const taskDir = getTaskDir(ctx, task._ulid);

    await runWithBuffer(ctx.specDir, async () => {
      // Delete known per-task files through the buffer
      const taskFilePath = getTaskFilePath(ctx, task._ulid);
      const notesFilePath = getNotesFilePath(ctx, task._ulid);
      const buffer = getActiveBatchBuffer()!;
      buffer.delete(taskFilePath);
      buffer.delete(notesFilePath);

      // Queue directory removal through the buffer so it happens during
      // flush — after file-level operations. This ensures the directory
      // removal participates in the buffer's atomicity: if flush fails,
      // discard() prevents the removal from executing.
      // AC: @task-directory-storage ac-4 — entire directory is removed
      // AC: @task-atomic-writes ac-2 — directory removal deferred to flush
      buffer.deleteDirectory(taskDir);

      // Remove from index within the same buffer — serialized by indexMutex
      // AC: @task-directory-storage ac-5 — index entry removed atomically with directory
      const releaseIndex = await this.indexMutex.acquire();
      try {
        await this.removeFromIndex(ctx, task._ulid);
      } finally {
        releaseIndex();
      }
    });
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
  private async loadTaskFromDir(ctx: KspecContext, ulid: string): Promise<LoadedTask | undefined> {
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
  ): Promise<{
    task: LoadedTask | undefined;
    history: HistoryEntry[];
    rawCore: Record<string, unknown>;
  }> {
    const taskFilePath = getTaskFilePath(ctx, ulid);
    const notesFilePath = getNotesFilePath(ctx, ulid);

    try {
      // Read core data
      const rawCore = await readYamlFile<unknown>(taskFilePath);
      if (!rawCore || typeof rawCore !== "object") {
        return { task: undefined, history: [], rawCore: {} };
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
        return { task: undefined, history: [], rawCore: {} };
      }

      return {
        task: { ...parsed.data, _sourceFile: taskFilePath },
        history,
        rawCore: coreWithoutHistory,
      };
    } catch {
      return { task: undefined, history: [], rawCore: {} };
    }
  }

  /**
   * Fallback: construct a LoadedTask from an index entry when the per-task
   * directory is missing. Emits a warning to stderr indicating degraded data.
   *
   * AC: @task-detail-loading ac-2 — returns index data with warning when
   * per-task directory is missing; does not fail silently or throw
   */
  private async fallbackToIndexEntry(
    ctx: KspecContext,
    ulid: string,
  ): Promise<LoadedTask | undefined> {
    const indexPath = getIndexFilePath(ctx);
    try {
      const raw = await readYamlFile<unknown>(indexPath);
      let entries: unknown[];
      if (Array.isArray(raw)) {
        entries = raw;
      } else if (raw && typeof raw === "object" && "tasks" in raw) {
        entries = Array.isArray((raw as Record<string, unknown>).tasks)
          ? ((raw as Record<string, unknown>).tasks as unknown[])
          : [];
      } else {
        return undefined;
      }

      // Match by full ULID or short prefix
      const match = entries.find((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const e = entry as Record<string, unknown>;
        return (
          typeof e._ulid === "string" &&
          (e._ulid === ulid || (ulid.length < 26 && e._ulid.startsWith(ulid)))
        );
      });

      if (!match) return undefined;
      return this.indexEntryToLoadedTask(match as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }

  /**
   * Fallback: find a task in the index by slug ref when the per-task
   * directory is missing.
   *
   * AC: @task-detail-loading ac-2 — index fallback for slug-based lookups
   */
  private async fallbackToIndexEntryByRef(
    ctx: KspecContext,
    ref: string,
  ): Promise<LoadedTask | undefined> {
    const indexPath = getIndexFilePath(ctx);
    // Strip leading @ for slug matching
    const normalizedRef = ref.startsWith("@") ? ref.slice(1) : ref;
    try {
      const raw = await readYamlFile<unknown>(indexPath);
      let entries: unknown[];
      if (Array.isArray(raw)) {
        entries = raw;
      } else if (raw && typeof raw === "object" && "tasks" in raw) {
        entries = Array.isArray((raw as Record<string, unknown>).tasks)
          ? ((raw as Record<string, unknown>).tasks as unknown[])
          : [];
      } else {
        return undefined;
      }

      const match = entries.find((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const e = entry as Record<string, unknown>;
        // Match by slug
        if (Array.isArray(e.slugs) && e.slugs.includes(normalizedRef)) return true;
        // Match by ULID
        if (typeof e._ulid === "string" && e._ulid === normalizedRef) return true;
        return false;
      });

      if (!match) return undefined;
      return this.indexEntryToLoadedTask(match as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }

  /**
   * Convert a raw index entry to a LoadedTask, emitting a warning about
   * the missing per-task directory.
   *
   * The index entry has listing/filtering fields but lacks detail-only
   * data (notes content, description, history). Schema defaults fill
   * in empty arrays for notes and todos.
   *
   * AC: @task-detail-loading ac-2 — returns index data with warning
   */
  private indexEntryToLoadedTask(entry: Record<string, unknown>): LoadedTask | undefined {
    // Index entries store notes_count/todos_count as scalars — strip them
    // before parsing since TaskSchema expects notes/todos arrays (which will
    // default to empty arrays via schema defaults)
    const { notes_count: _nc, todos_count: _tc, ...taskFields } = entry;
    const parsed = TaskSchema.safeParse(taskFields);
    if (!parsed.success) return undefined;

    const ulid = parsed.data._ulid;
    process.stderr.write(
      `Warning: Per-task directory missing for task ${ulid}. ` +
        `Returning index-only data (notes, description, and history unavailable). ` +
        `Run "kspec task rebuild-index" or re-migrate to restore full data.\n`,
    );

    return { ...parsed.data, _sourceFile: undefined };
  }

  /**
   * Get the history entries for a task from its per-task directory.
   *
   * This is the public interface for reading history — callers use this
   * to display the audit trail without needing to know the storage format.
   *
   * AC: @task-core-data-file ac-2 — history provides complete audit trail
   */
  async getTaskHistory(ctx: KspecContext, ulid: string): Promise<HistoryEntry[]> {
    await this.ensureMigrated(ctx);
    const { history } = await this.loadTaskWithHistory(ctx, ulid);
    return history;
  }

  async loadTaskWithHistory(
    ctx: KspecContext,
    ulid: string,
  ): Promise<{ task: LoadedTask | undefined; history: HistoryEntry[] }> {
    await this.ensureMigrated(ctx);
    const { task, history } = await this.loadTaskFromDirWithHistory(ctx, ulid);
    return { task, history };
  }

  /**
   * Add a new entry to the index file.
   *
   * Preserves the on-disk wrapper shape via the shared trait foundation.
   *
   * AC: @task-index-file ac-5 — index entry added atomically with directory
   * AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
   */
  private async addToIndex(ctx: KspecContext, task: Task): Promise<void> {
    const indexPath = getIndexFilePath(ctx);
    const indexEntry = toIndexEntry(task);

    const shape = await readIndexEntries(indexPath, TASK_LAYOUT.indexWrapperKey);
    const updated = [...shape.entries, indexEntry];
    await writeIndexEntries(indexPath, updated, shape, TASK_LAYOUT.indexWrapperKey);
  }

  /**
   * Update an existing index entry.
   *
   * AC: @task-index-file ac-2 — index and per-task file updated atomically
   * AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
   */
  private async updateIndexEntry(ctx: KspecContext, task: Task): Promise<void> {
    const indexPath = getIndexFilePath(ctx);
    const indexEntry = toIndexEntry(task);

    const shape = await readIndexEntries(indexPath, TASK_LAYOUT.indexWrapperKey);
    const updated = [...shape.entries];
    const existingIdx = updated.findIndex(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        (entry as Record<string, unknown>)._ulid === task._ulid,
    );
    if (existingIdx >= 0) {
      updated[existingIdx] = indexEntry;
    } else {
      // Entry not found — add it (recovery path)
      updated.push(indexEntry);
    }
    await writeIndexEntries(indexPath, updated, shape, TASK_LAYOUT.indexWrapperKey);
  }

  /**
   * Remove an entry from the index file.
   *
   * AC: @task-directory-storage ac-5 — index entry removed atomically with directory
   * AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
   */
  private async removeFromIndex(ctx: KspecContext, ulid: string): Promise<void> {
    const indexPath = getIndexFilePath(ctx);
    const shape = await readIndexEntries(indexPath, TASK_LAYOUT.indexWrapperKey);
    if (shape.entries.length === 0 && !shape.useWrapper) {
      return; // No index to remove from
    }
    const filtered = shape.entries.filter(
      (entry) =>
        !(entry && typeof entry === "object" && (entry as Record<string, unknown>)._ulid === ulid),
    );
    await writeIndexEntries(indexPath, filtered, shape, TASK_LAYOUT.indexWrapperKey);
  }

  /**
   * Rebuild the index from per-task files.
   *
   * Scans all task directories, reads their core data, and regenerates
   * the entire index file. This is the recovery path when the index
   * has drifted from per-task files.
   *
   * Delegates the iteration / projection / wrapper-shape preservation to
   * the shared trait foundation; the SplitBackend supplies the
   * task-specific load and projection callbacks plus the indexMutex
   * serialization that protects against concurrent mutation races.
   *
   * AC: @task-index-file ac-7 — index fully regenerated from per-task files alone
   * AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
   */
  async rebuildIndex(ctx: KspecContext): Promise<{ count: number }> {
    // AC: @task-storage-activation ac-3 — refuse on unmigrated data
    await this.ensureMigrated(ctx);

    // Serialize index write with indexMutex to prevent races with
    // concurrent mutations updating the same index file.
    const releaseIndex = await this.indexMutex.acquire();
    try {
      return await rebuildEntityIndex<LoadedTask>(ctx, TASK_LAYOUT, {
        loadEntity: (rebuildCtx, ulid) => this.loadTaskFromDir(rebuildCtx, ulid),
        projectToIndexEntry: (task) => toIndexEntry(task),
      });
    } finally {
      releaseIndex();
    }
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
async function writeNotesFile(filePath: string, notes: unknown[]): Promise<void> {
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
