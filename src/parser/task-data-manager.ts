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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Note, Task, TaskInput } from "../schema/task.js";
import { TaskSchema } from "../schema/task.js";
import type { KspecContext, LoadedTask } from "./yaml.js";
import {
  createNote,
  createTask,
  deleteTask as deleteTaskFromFile,
  extractRawTaskArray,
  findRawTaskIndex,
  findTaskByRef,
  getDefaultTaskFilePath,
  loadAllTasks,
  mergeTaskPreservingRawShape,
  mutateTasksAtomically,
  readYamlFile,
  saveTask as saveTaskToFile,
  stripRuntimeMetadata,
  writeRawTaskArray,
} from "./yaml.js";
import { acquireFileLock } from "./file-lock.js";
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
 * Extract a TaskSummary from a raw YAML task record.
 * Only reads index-level fields — detail fields (notes, todos, description,
 * vcs_refs, etc.) are never accessed.
 *
 * AC: @task-data-manager ac-2 — only index data is read
 */
function rawToSummary(raw: unknown, sourceFile: string): TaskSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  // Minimal validation: ULID and title must be present
  if (typeof r._ulid !== "string" || !r._ulid) return null;
  if (typeof r.title !== "string" || !r.title) return null;

  return {
    _ulid: r._ulid,
    slugs: Array.isArray(r.slugs) ? r.slugs.filter((s): s is string => typeof s === "string") : [],
    title: r.title,
    type: typeof r.type === "string" ? r.type : "task",
    status: typeof r.status === "string" ? r.status : "pending",
    priority: typeof r.priority === "number" ? r.priority : 3,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
    assignee: typeof r.assignee === "string" ? r.assignee : (r.assignee === null ? null : undefined),
    automation: typeof r.automation === "string" ? r.automation : undefined,
    spec_ref: typeof r.spec_ref === "string" ? r.spec_ref : (r.spec_ref === null ? null : undefined),
    depends_on: Array.isArray(r.depends_on) ? r.depends_on.filter((d): d is string => typeof d === "string") : [],
    blocked_by: Array.isArray(r.blocked_by) ? r.blocked_by.filter((b): b is string => typeof b === "string") : [],
    created_at: typeof r.created_at === "string" ? r.created_at : new Date().toISOString(),
    started_at: typeof r.started_at === "string" ? r.started_at : (r.started_at === null ? null : undefined),
    submitted_at: typeof r.submitted_at === "string" ? r.submitted_at : (r.submitted_at === null ? null : undefined),
    completed_at: typeof r.completed_at === "string" ? r.completed_at : (r.completed_at === null ? null : undefined),
    _sourceFile: sourceFile,
  };
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
 * Storage backend interface — defines all storage operations that a backend
 * must implement. The manager delegates to the active backend based on the
 * configured storage format.
 *
 * AC: @task-data-manager ac-1 — callers interact via the manager, not backends
 * AC: @task-data-manager ac-8 — split format routes through its own backend
 */
export interface TaskStorageBackend {
  readonly format: StorageFormat;

  listTasks(ctx: KspecContext): Promise<TaskSummary[]>;
  getTask(ctx: KspecContext, ref: string): Promise<LoadedTask | undefined>;
  createTask(ctx: KspecContext, task: LoadedTask): Promise<void>;
  mutateTask(
    ctx: KspecContext,
    task: LoadedTask,
    mutate: (latestTask: LoadedTask) => Task | LoadedTask | Promise<Task | LoadedTask>,
  ): Promise<LoadedTask>;
  mutateTasks(
    ctx: KspecContext,
    tasks: LoadedTask[],
    mutate: (latestTasks: LoadedTask[]) => Array<Task | LoadedTask> | Promise<Array<Task | LoadedTask>>,
  ): Promise<LoadedTask[]>;
  deleteTask(ctx: KspecContext, task: LoadedTask): Promise<void>;
}

/**
 * In-memory per-task mutex for contention-free non-overlapping mutations.
 *
 * Each task ULID maps to a promise chain. Mutations on the same task serialize
 * by awaiting the previous mutation's promise. Mutations on different tasks
 * proceed independently — they don't share a lock.
 *
 * AC: @task-data-manager ac-5 — non-overlapping mutations proceed without contention
 * AC: @task-data-manager ac-9 — same-task mutations serialize
 */
class TaskMutexMap {
  private readonly locks = new Map<string, Promise<void>>();

  /**
   * Acquire an exclusive lock for a task ULID. Returns a release function.
   * If another mutation is in progress for the same ULID, waits for it.
   * Mutations on different ULIDs proceed concurrently.
   */
  async acquire(ulid: string): Promise<() => void> {
    // Wait for any existing lock on this ULID
    const existing = this.locks.get(ulid);
    if (existing) {
      await existing;
    }

    let release!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.locks.set(ulid, lockPromise);

    return () => {
      // Only delete if this is still the current lock for the ULID
      if (this.locks.get(ulid) === lockPromise) {
        this.locks.delete(ulid);
      }
      release();
    };
  }
}

/**
 * Load task summaries from raw YAML files without full schema validation.
 * Reads the file and extracts only index-level fields from each raw record.
 *
 * AC: @task-data-manager ac-2 — only index data is read; detail fields not parsed
 */
async function loadSummariesFromFile(filePath: string): Promise<TaskSummary[]> {
  const summaries: TaskSummary[] = [];

  try {
    const raw = await readYamlFile<unknown>(filePath);

    let taskList: unknown[];

    if (Array.isArray(raw)) {
      taskList = raw;
    } else if (raw && typeof raw === "object" && "tasks" in raw) {
      const wrapper = raw as Record<string, unknown>;
      const tasks = wrapper.tasks;
      taskList = Array.isArray(tasks) ? tasks : [];
    } else if (raw) {
      taskList = [raw];
    } else {
      return summaries;
    }

    for (const taskData of taskList) {
      const summary = rawToSummary(taskData, filePath);
      if (summary) {
        summaries.push(summary);
      }
    }
  } catch {
    // Skip invalid files
  }

  return summaries;
}

/**
 * Discover task files and load only summary-level data from each.
 * Uses the same file discovery algorithm as loadAllTasks but extracts
 * only index-level fields without running TaskSchema validation.
 *
 * AC: @task-data-manager ac-2 — only index data is read for listing
 */
async function loadAllTaskSummaries(ctx: KspecContext): Promise<TaskSummary[]> {
  // Reuse loadAllTasks' file discovery by importing findTaskFiles
  // We inline the discovery logic to avoid importing a private function
  const summaries: TaskSummary[] = [];

  const checkFile = async (loc: string, files: string[]) => {
    try {
      await fs.access(loc);
      if (!files.includes(loc)) {
        files.push(loc);
      }
    } catch {
      // File doesn't exist
    }
  };

  const scanDir = async (dir: string): Promise<string[]> => {
    const files: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isFile() &&
          (entry.name.endsWith(".tasks.yaml") || entry.name === "tasks.yaml")
        ) {
          files.push(path.join(dir, entry.name));
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
    return files;
  };

  if (ctx.shadow?.enabled || Boolean(process.env.KSPEC_SPEC_DIR)) {
    const taskFiles = await scanDir(ctx.specDir);

    const standaloneLocations = [
      path.join(ctx.specDir, "tasks.yaml"),
      path.join(ctx.specDir, "project.tasks.yaml"),
      path.join(ctx.specDir, "kynetic.tasks.yaml"),
      path.join(ctx.specDir, "backlog.tasks.yaml"),
      path.join(ctx.specDir, "active.tasks.yaml"),
    ];

    for (const loc of standaloneLocations) {
      await checkFile(loc, taskFiles);
    }

    const uniqueFiles = [...new Set(taskFiles)];
    for (const filePath of uniqueFiles) {
      const fileSummaries = await loadSummariesFromFile(filePath);
      summaries.push(...fileSummaries);
    }
  } else {
    const taskFiles = await scanDir(ctx.rootDir);

    const additionalPaths = [
      path.join(ctx.rootDir, "tasks"),
      path.join(ctx.rootDir, "spec"),
    ];

    for (const additionalPath of additionalPaths) {
      const files = await scanDir(additionalPath);
      taskFiles.push(...files);
    }

    const standaloneLocations = [
      path.join(ctx.rootDir, "tasks.yaml"),
      path.join(ctx.rootDir, "project.tasks.yaml"),
      path.join(ctx.rootDir, "spec", "project.tasks.yaml"),
      path.join(ctx.rootDir, "backlog.tasks.yaml"),
      path.join(ctx.rootDir, "active.tasks.yaml"),
    ];

    for (const loc of standaloneLocations) {
      await checkFile(loc, taskFiles);
    }

    const uniqueFiles = [...new Set(taskFiles)];
    for (const filePath of uniqueFiles) {
      const fileSummaries = await loadSummariesFromFile(filePath);
      summaries.push(...fileSummaries);
    }
  }

  return summaries;
}

/**
 * Monolithic storage backend — all tasks in a single YAML file.
 * This is the default backend used when no split format is activated.
 *
 * Uses per-task in-memory locks so that non-overlapping mutations do not
 * contend with each other. The file lock is acquired only for the brief
 * write phase, not for the entire mutation callback.
 *
 * AC: @task-data-manager ac-5 — non-overlapping mutations proceed without contention
 * AC: @task-data-manager ac-7 — monolithic format used by default
 */
class MonolithicBackend implements TaskStorageBackend {
  readonly format: StorageFormat = "monolithic";

  /** Per-task in-memory locks for contention-free non-overlapping mutations. */
  private readonly taskMutex = new TaskMutexMap();

  /**
   * List tasks by reading raw YAML and extracting only summary-level fields.
   * Detail fields (notes, todos, description, etc.) are not parsed or validated.
   *
   * AC: @task-data-manager ac-2 — only index data is read
   */
  async listTasks(ctx: KspecContext): Promise<TaskSummary[]> {
    return loadAllTaskSummaries(ctx);
  }

  async getTask(ctx: KspecContext, ref: string): Promise<LoadedTask | undefined> {
    const tasks = await loadAllTasks(ctx);
    return findTaskByRef(tasks, ref);
  }

  async createTask(ctx: KspecContext, task: LoadedTask): Promise<void> {
    await saveTaskToFile(ctx, task);
  }

  /**
   * Mutate a single task with per-task locking.
   *
   * Acquires an in-memory per-task lock (by ULID) so that concurrent mutations
   * on different tasks proceed independently. The file-level lock is held only
   * for the brief re-read + merge + write phase, not during the mutation callback.
   *
   * AC: @task-data-manager ac-5 — non-overlapping mutations proceed without contention
   * AC: @task-data-manager ac-9 — same-task mutations serialize via per-task lock
   */
  async mutateTask(
    ctx: KspecContext,
    task: LoadedTask,
    mutate: (latestTask: LoadedTask) => Task | LoadedTask | Promise<Task | LoadedTask>,
  ): Promise<LoadedTask> {
    const taskFilePath = task._sourceFile || getDefaultTaskFilePath(ctx);

    // Acquire per-task lock: same-task mutations serialize (AC-9),
    // different-task mutations proceed concurrently (AC-5)
    const releaseTaskLock = await this.taskMutex.acquire(task._ulid);

    try {
      // Phase 1: Read current state and run mutation callback OUTSIDE file lock.
      // This allows other tasks' mutations to read/write concurrently.
      const dir = path.dirname(taskFilePath);
      await fs.mkdir(dir, { recursive: true });

      const preRead = await extractRawTaskArray(taskFilePath);
      const preIndex = findRawTaskIndex(preRead.rawTasks, task._ulid);
      if (preIndex === -1) {
        throw new Error(`Task not found in file: ${task._ulid}`);
      }

      const rawTarget = preRead.rawTasks[preIndex];
      const parsed = TaskSchema.safeParse(rawTarget);
      if (!parsed.success) {
        throw new Error(`Invalid task data for ${task._ulid}: ${parsed.error.message}`);
      }
      const latestTask: LoadedTask = { ...parsed.data, _sourceFile: taskFilePath };

      // Run the mutation callback outside the file lock
      const mutatedTask = await mutate(latestTask);
      const cleanMutatedTask = stripRuntimeMetadata(mutatedTask as LoadedTask);

      // Phase 2: Acquire file lock ONLY for the re-read + merge + write phase.
      // Since we hold the per-task lock, no other mutation can change our target
      // task between phases. Other tasks' data may have changed, which is fine —
      // we re-read the file to get fresh state for all non-target tasks.
      let updatedTask: LoadedTask | undefined;
      const releaseFileLock = await acquireFileLock(taskFilePath);
      try {
        const { rawTasks, useTasksWrapper, wrapperObj } =
          await extractRawTaskArray(taskFilePath);

        const taskIndex = findRawTaskIndex(rawTasks, task._ulid);
        if (taskIndex === -1) {
          throw new Error(`Task not found in file during write phase: ${task._ulid}`);
        }

        rawTasks[taskIndex] = mergeTaskPreservingRawShape(
          rawTasks[taskIndex] as Record<string, unknown>,
          cleanMutatedTask as Record<string, unknown>,
        );

        await writeRawTaskArray(taskFilePath, rawTasks, useTasksWrapper, wrapperObj);

        updatedTask = {
          ...cleanMutatedTask,
          _sourceFile: taskFilePath,
        };
      } finally {
        await releaseFileLock();
      }

      if (!updatedTask) {
        throw new Error(`Failed to mutate task atomically: ${task._ulid}`);
      }

      return updatedTask;
    } finally {
      releaseTaskLock();
    }
  }

  async mutateTasks(
    ctx: KspecContext,
    tasks: LoadedTask[],
    mutate: (latestTasks: LoadedTask[]) => Array<Task | LoadedTask> | Promise<Array<Task | LoadedTask>>,
  ): Promise<LoadedTask[]> {
    return mutateTasksAtomically(ctx, tasks, mutate);
  }

  async deleteTask(ctx: KspecContext, task: LoadedTask): Promise<void> {
    await deleteTaskFromFile(ctx, task);
  }
}

/** Singleton monolithic backend instance. */
const monolithicBackend = new MonolithicBackend();

/**
 * Registry for storage backends. The split backend will be registered here
 * by @task-impl-split-storage when it is implemented.
 *
 * AC: @task-data-manager ac-8 — split format routes to registered backend
 */
const backendRegistry = new Map<StorageFormat, TaskStorageBackend>([
  ["monolithic", monolithicBackend],
]);

/**
 * Register a storage backend for a given format.
 * Used by the split storage implementation to plug in its backend.
 *
 * AC: @task-data-manager ac-8 — enables split format activation
 */
export function registerBackend(backend: TaskStorageBackend): void {
  backendRegistry.set(backend.format, backend);
}

/**
 * Unregister a storage backend for a given format.
 * Primarily used in tests to restore the default registry state.
 * Cannot unregister the monolithic backend.
 */
export function unregisterBackend(format: StorageFormat): void {
  if (format === "monolithic") {
    return; // monolithic backend is always available
  }
  backendRegistry.delete(format);
}

/**
 * Validate a task record against the schema before persisting.
 * Strips _sourceFile before validation since it is runtime metadata.
 *
 * AC: @trait-error-guidance ac-5 — validation errors include field info
 */
function validateMutationOutput(task: Task | LoadedTask): void {
  const { _sourceFile: _, ...cleanTask } = task as LoadedTask;
  const result = TaskSchema.safeParse(cleanTask);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const fieldPath = firstIssue?.path?.join(".") || "unknown";
    throw new TaskDataManagerError(
      `Mutation produced invalid task data: ${result.error.message}`,
      {
        suggestion: "Check the mutation callback returns a valid task record matching the task schema",
        field: fieldPath,
      },
    );
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
 * "split", the manager routes to the registered split backend. If no split
 * backend has been registered, the manager throws a descriptive error.
 */
export class TaskDataManager {
  readonly storageFormat: StorageFormat;
  private readonly backend: TaskStorageBackend;

  constructor(storageFormat: StorageFormat = "monolithic") {
    this.storageFormat = storageFormat;
    const backend = backendRegistry.get(storageFormat);
    if (!backend) {
      // AC: @trait-error-guidance ac-1, ac-2
      throw new TaskDataManagerError(
        `No storage backend registered for format "${storageFormat}". The split per-task directory backend is delivered by task @task-impl-split-storage.`,
        {
          suggestion:
            "Set storage format to 'monolithic' or ensure the split storage backend has been registered via registerBackend().",
          field: "storageFormat",
        },
      );
    }
    this.backend = backend;
  }

  /**
   * List all tasks, returning summary records with only index-level fields.
   *
   * Returns TaskSummary objects that contain only the fields needed for
   * listing, filtering, and dependency resolution. Detail fields (notes,
   * todos, description, etc.) are not included and not read from storage.
   *
   * AC: @task-data-manager ac-2 — only index data read from storage
   * AC: @task-data-manager ac-7 — monolithic format used until split activated
   */
  async listTasks(
    ctx: KspecContext,
    filters?: TaskListFilters,
  ): Promise<TaskSummary[]> {
    const summaries = await this.backend.listTasks(ctx);

    if (!filters) {
      return summaries;
    }

    return summaries.filter((task) => {
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

  /**
   * Get full details for a specific task by reference (ULID, slug, or short ref).
   *
   * In the monolithic backend, this loads all tasks and finds the match.
   * When the split format is activated, the backend reads the index + per-task
   * directory to assemble the complete record.
   *
   * AC: @task-data-manager ac-3 — assembles complete task transparently
   * AC: @task-data-manager ac-7 — monolithic format used until split activated
   * AC: @trait-error-guidance ac-3 — suggests checking ref on not found
   */
  async getTask(ctx: KspecContext, ref: string): Promise<LoadedTask> {
    const task = await this.backend.getTask(ctx, ref);
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

    await this.backend.createTask(ctx, loadedTask);

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
   * per-task lock, so concurrent writers on different tasks proceed without
   * contention. The callback's output is validated against the task schema
   * before persisting to prevent storage corruption.
   *
   * AC: @task-data-manager ac-4 — files, locking, commits coordinated
   * AC: @task-data-manager ac-5 — non-overlapping mutations no contention
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
    // Resolve the task first to get _sourceFile for locking
    const task = await this.getTask(ctx, ref);

    const updated = await this.backend.mutateTask(
      ctx,
      task,
      async (latestTask) => {
        const result = await mutate(latestTask);
        validateMutationOutput(result);
        return result;
      },
    );

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
   * Each mutated task is validated against the task schema before persisting.
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
    // Resolve all refs to loaded tasks
    const tasks = await Promise.all(
      refs.map((ref) => this.getTask(ctx, ref)),
    );

    const updated = await this.backend.mutateTasks(
      ctx,
      tasks,
      async (latestTasks) => {
        const results = await mutate(latestTasks);
        for (const result of results) {
          validateMutationOutput(result);
        }
        return results;
      },
    );

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
    const task = await this.getTask(ctx, ref);

    if (!task._sourceFile) {
      throw new TaskDataManagerError(
        `Cannot delete task ${ref}: no source file metadata. The task may have been loaded from an unexpected location.`,
        { suggestion: "Reload the task and try again" },
      );
    }

    await this.backend.deleteTask(ctx, task);

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
