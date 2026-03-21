/**
 * Task Data Manager — the exclusive interface for all task storage operations.
 *
 * All consumers (CLI, API, batch, automation) read and write tasks exclusively
 * through this module. It encapsulates the storage format behind a consistent
 * interface so callers provide mutations, not I/O strategy.
 *
 * The manager supports two storage formats:
 * - "monolithic": All tasks in a single file (default, current)
 * - "split": Per-task directories with a lean index (future)
 *
 * The active format is an explicit setting, not auto-detected.
 * AC: @task-storage-activation ac-1, ac-2
 *
 * Spec: @task-data-manager
 */

import type { Note, Task, TaskInput } from "../schema/task.js";
import type { KspecContext, LoadedTask } from "./yaml.js";
import {
  createNote,
  createTask,
  deleteTask as deleteTaskFromFile,
  findTaskByRef,
  getDefaultTaskFilePath,
  loadAllTasks,
  mutateTaskAtomically,
  mutateTasksAtomically,
  saveTask as saveTaskToFile,
} from "./yaml.js";
import { commitIfShadow } from "./shadow.js";

/**
 * Storage format selector.
 * AC: @task-data-manager ac-7, ac-8
 * AC: @task-storage-activation ac-1, ac-2
 */
export type StorageFormat = "monolithic" | "split";

/**
 * Summary record returned by listTasks — contains only index-level fields
 * needed for listing, filtering, and dependency resolution.
 *
 * AC: @task-data-manager ac-2 — only index data read for listing
 * AC: @task-index-file ac-1 — no notes, history, or detail-only data
 */
export interface TaskSummary {
  _ulid: string;
  slugs: string[];
  title: string;
  type: string;
  status: string;
  priority: number;
  tags: string[];
  assignee?: string | null;
  automation?: string;
  spec_ref?: string | null;
  depends_on: string[];
  blocked_by: string[];
  created_at: string;
  started_at?: string | null;
  submitted_at?: string | null;
  completed_at?: string | null;
  _sourceFile?: string;
}

/**
 * Project only the index-level fields from a full task record.
 * Detail fields (notes, todos, description, vcs_refs, etc.) are stripped.
 *
 * AC: @task-data-manager ac-2 — callers of listTasks get only index data
 */
function toTaskSummary(task: LoadedTask): TaskSummary {
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
    depends_on: task.depends_on,
    blocked_by: task.blocked_by,
    created_at: task.created_at,
    started_at: task.started_at,
    submitted_at: task.submitted_at,
    completed_at: task.completed_at,
    _sourceFile: task._sourceFile,
  };
}

/**
 * Options for shadow branch commits after mutations.
 * When provided, the manager coordinates the commit as part of the operation.
 */
// AC: @task-data-manager ac-4 — shadow branch commits handled by manager
export interface ShadowCommitOptions {
  /** Operation name for the commit message (e.g., "task-add", "task-set") */
  operation: string;
  /** Reference for the commit message (e.g., "@task-slug") */
  ref?: string;
  /** Additional detail for the commit message */
  detail?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Filters for listing tasks.
 * Used by listTasks to filter without loading full task details.
 */
export interface TaskListFilters {
  /** Filter by task status */
  status?: string | string[];
  /** Filter by tags (any match) */
  tags?: string[];
  /** Filter by assignee */
  assignee?: string;
  /** Filter by automation eligibility */
  automation?: string;
  /** Filter by spec reference */
  specRef?: string;
}

/**
 * Error thrown by TaskDataManager operations.
 * Includes descriptive messages and suggested actions per @trait-error-guidance.
 */
// AC: @trait-error-guidance ac-1, ac-2
export class TaskDataManagerError extends Error {
  /** Suggested action for the user to resolve the error */
  readonly suggestion?: string;
  /** The field or value that failed, if applicable */
  readonly field?: string;

  constructor(
    message: string,
    options?: { suggestion?: string; field?: string },
  ) {
    super(message);
    this.name = "TaskDataManagerError";
    this.suggestion = options?.suggestion;
    this.field = options?.field;
  }
}

/**
 * Task Data Manager — owns all task storage operations.
 *
 * AC: @task-data-manager ac-1 — callers don't know about storage format
 * AC: @task-data-manager ac-7 — monolithic format used by default
 * AC: @task-data-manager ac-8 — split format used when activated
 *
 * The manager receives a storage format at construction time. The format
 * defaults to "monolithic" per @task-storage-activation ac-1. When set to
 * "split", the manager routes to the split backend (not yet implemented;
 * the split storage backend is delivered by @task-impl-split-storage).
 */
export class TaskDataManager {
  readonly storageFormat: StorageFormat;

  constructor(storageFormat: StorageFormat = "monolithic") {
    this.storageFormat = storageFormat;
  }

  /**
   * Guard that throws if the split backend is requested but not yet available.
   * AC: @task-data-manager ac-8 — split format routing
   * AC: @trait-error-guidance ac-1, ac-2 — descriptive error with suggestion
   */
  private ensureBackendAvailable(): void {
    if (this.storageFormat === "split") {
      throw new TaskDataManagerError(
        "Split storage format is not yet implemented. The split per-task directory backend is delivered by task @task-impl-split-storage.",
        {
          suggestion:
            "Set storage format to 'monolithic' or wait for the split storage implementation to be completed.",
          field: "storageFormat",
        },
      );
    }
  }

  /**
   * List all tasks, returning summary records with only index-level fields.
   *
   * Returns TaskSummary objects that contain only the fields needed for
   * listing, filtering, and dependency resolution. Detail fields (notes,
   * todos, description, etc.) are not included.
   *
   * In the monolithic backend, this reads the full file and projects index
   * fields. In the split backend (future), this will read only the lean
   * index file.
   *
   * AC: @task-data-manager ac-2 — only index data returned to callers
   * AC: @task-data-manager ac-7 — monolithic format used until split activated
   */
  async listTasks(
    ctx: KspecContext,
    filters?: TaskListFilters,
  ): Promise<TaskSummary[]> {
    this.ensureBackendAvailable();

    const tasks = await loadAllTasks(ctx);

    let filtered: LoadedTask[];
    if (!filters) {
      filtered = tasks;
    } else {
      filtered = tasks.filter((task) => {
        if (filters.status) {
          const statuses = Array.isArray(filters.status)
            ? filters.status
            : [filters.status];
          if (!statuses.includes(task.status)) return false;
        }
        if (filters.tags && filters.tags.length > 0) {
          if (!filters.tags.some((tag) => task.tags.includes(tag)))
            return false;
        }
        if (filters.assignee !== undefined) {
          if (task.assignee !== filters.assignee) return false;
        }
        if (filters.automation !== undefined) {
          if (task.automation !== filters.automation) return false;
        }
        if (filters.specRef !== undefined) {
          if (task.spec_ref !== filters.specRef) return false;
        }
        return true;
      });
    }

    // AC: @task-data-manager ac-2 — project only index fields
    return filtered.map(toTaskSummary);
  }

  /**
   * Get full details for a specific task by reference (ULID, slug, or short ref).
   *
   * In the monolithic backend, this loads all tasks and finds the match.
   * When the split format is activated, this will read the index + per-task
   * directory to assemble the complete record.
   *
   * AC: @task-data-manager ac-3 — assembles complete task transparently
   * AC: @task-data-manager ac-7 — monolithic format used until split activated
   * AC: @trait-error-guidance ac-3 — suggests checking ref on not found
   */
  async getTask(ctx: KspecContext, ref: string): Promise<LoadedTask> {
    this.ensureBackendAvailable();
    const tasks = await loadAllTasks(ctx);
    const task = findTaskByRef(tasks, ref);
    if (!task) {
      // AC: @trait-error-guidance ac-1, ac-2, ac-3
      throw new TaskDataManagerError(
        `Task not found: ${ref}`,
        {
          suggestion:
            `Check the reference with: kspec search "${ref}" or kspec task list`,
        },
      );
    }
    return task;
  }

  /**
   * Create a new task and persist it.
   *
   * Handles ULID generation, schema validation, file writing, locking, and
   * shadow branch commit as a single coordinated operation.
   *
   * AC: @task-data-manager ac-4 — files, locking, commits coordinated
   * AC: @task-data-manager ac-6 — atomic operation
   * AC: @trait-error-guidance ac-5 — validation errors include field info
   */
  async createTask(
    ctx: KspecContext,
    input: TaskInput,
    commitOpts?: ShadowCommitOptions,
  ): Promise<LoadedTask> {
    this.ensureBackendAvailable();
    let newTask: Task;
    try {
      newTask = createTask(input);
    } catch (err) {
      // AC: @trait-error-guidance ac-5 — validation error with field info
      throw new TaskDataManagerError(
        `Failed to create task: ${err instanceof Error ? err.message : String(err)}`,
        { suggestion: "Check the input fields match the task schema" },
      );
    }

    const loadedTask: LoadedTask = {
      ...newTask,
      _sourceFile: getDefaultTaskFilePath(ctx),
    };

    await saveTaskToFile(ctx, loadedTask);

    if (commitOpts) {
      await commitIfShadow(
        ctx.shadow,
        commitOpts.operation,
        commitOpts.ref,
        commitOpts.detail,
        commitOpts.verbose,
      );
    }

    return loadedTask;
  }

  /**
   * Atomically mutate a single task using the latest on-disk state.
   *
   * The mutation callback receives the current task value while holding the
   * file lock, so concurrent writers cannot clobber unrelated fields.
   *
   * AC: @task-data-manager ac-4 — files, locking, commits coordinated
   * AC: @task-data-manager ac-6 — atomic operation
   * AC: @task-data-manager ac-9 — concurrent mutations serialize via lock
   */
  async mutateTask(
    ctx: KspecContext,
    ref: string,
    mutate: (
      latestTask: LoadedTask,
    ) => Task | LoadedTask | Promise<Task | LoadedTask>,
    commitOpts?: ShadowCommitOptions,
  ): Promise<LoadedTask> {
    this.ensureBackendAvailable();
    // Resolve the task first to get _sourceFile for locking
    const task = await this.getTask(ctx, ref);

    const updated = await mutateTaskAtomically(ctx, task, mutate);

    if (commitOpts) {
      await commitIfShadow(
        ctx.shadow,
        commitOpts.operation,
        commitOpts.ref,
        commitOpts.detail,
        commitOpts.verbose,
      );
    }

    return updated;
  }

  /**
   * Atomically mutate multiple tasks as one write transaction.
   *
   * Acquires all affected task-file locks in sorted order, loads the latest
   * on-disk state for each target task, lets the caller compute the updated
   * records, then writes each touched file once before releasing the locks.
   *
   * AC: @task-data-manager ac-4 — files, locking, commits coordinated
   * AC: @task-data-manager ac-5 — non-overlapping mutations no contention
   * AC: @task-data-manager ac-6 — all writes in single atomic operation
   * AC: @task-data-manager ac-9 — same-task mutations serialize via lock
   */
  async mutateTasks(
    ctx: KspecContext,
    refs: string[],
    mutate: (
      latestTasks: LoadedTask[],
    ) => Array<Task | LoadedTask> | Promise<Array<Task | LoadedTask>>,
    commitOpts?: ShadowCommitOptions,
  ): Promise<LoadedTask[]> {
    this.ensureBackendAvailable();
    // Resolve all refs to loaded tasks
    const tasks = await Promise.all(
      refs.map((ref) => this.getTask(ctx, ref)),
    );

    const updated = await mutateTasksAtomically(ctx, tasks, mutate);

    if (commitOpts) {
      await commitIfShadow(
        ctx.shadow,
        commitOpts.operation,
        commitOpts.ref,
        commitOpts.detail,
        commitOpts.verbose,
      );
    }

    return updated;
  }

  /**
   * Delete a task by reference.
   *
   * Removes the task from its source file atomically with file locking.
   *
   * AC: @task-data-manager ac-4 — files, locking, commits coordinated
   * AC: @task-data-manager ac-6 — atomic operation
   * AC: @trait-error-guidance ac-3 — suggests checking ref on not found
   */
  async deleteTask(
    ctx: KspecContext,
    ref: string,
    commitOpts?: ShadowCommitOptions,
  ): Promise<void> {
    this.ensureBackendAvailable();
    const task = await this.getTask(ctx, ref);

    if (!task._sourceFile) {
      throw new TaskDataManagerError(
        `Cannot delete task ${ref}: no source file metadata. The task may have been loaded from an unexpected location.`,
        { suggestion: "Reload the task and try again" },
      );
    }

    await deleteTaskFromFile(ctx, task);

    if (commitOpts) {
      await commitIfShadow(
        ctx.shadow,
        commitOpts.operation,
        commitOpts.ref,
        commitOpts.detail,
        commitOpts.verbose,
      );
    }
  }

  /**
   * Add a note to a task.
   *
   * This is a convenience method that appends a note entry to the task's
   * notes array. In the split format, this will write only to notes.yaml
   * without touching the index.
   *
   * AC: @task-data-manager ac-4 — files, locking, commits coordinated
   * AC: @task-data-manager ac-6 — atomic operation
   */
  async addNote(
    ctx: KspecContext,
    ref: string,
    content: string,
    author?: string,
    commitOpts?: ShadowCommitOptions,
  ): Promise<{ task: LoadedTask; note: Note }> {
    this.ensureBackendAvailable();
    const note = createNote(content, author);

    const updated = await this.mutateTask(
      ctx,
      ref,
      (latestTask) => ({
        ...latestTask,
        notes: [...latestTask.notes, note],
      }),
      commitOpts,
    );

    return { task: updated, note };
  }
}

/**
 * Module-level singleton instance.
 *
 * Consumers should use this singleton rather than creating new instances.
 * The manager is stateless, so a single instance serves all callers.
 */
export const taskDataManager = new TaskDataManager();
