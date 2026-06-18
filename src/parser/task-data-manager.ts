/**
 * Task Data Manager — the exclusive interface for all task storage operations.
 *
 * All consumers (CLI, API, batch, automation) read and write tasks exclusively
 * through this module. It encapsulates the storage format behind a consistent
 * interface so callers provide mutations, not I/O strategy.
 *
 * The only supported storage format is "split" (per-task directories with a
 * lean index). The "monolithic" format has been removed; legacy projects that
 * still use kynetic: "1.0" without task_storage.format: "split" receive a
 * version-gated error guiding them to run `kspec task migrate`.
 *
 * Spec: @task-data-manager
 */

import type { Note, Task, TaskInput } from "../schema/task.js";
import { TaskSchema } from "../schema/task.js";
import type { KspecContext, LoadedTask } from "./yaml.js";
import { createNote, createTask, getAuthor, getEntityCacheContext } from "./yaml.js";
import { createRequire } from "node:module";
import { commitIfShadow } from "./shadow.js";
import { getActiveBatchBuffer, runWithBuffer } from "../cli/batch-write-buffer.js";
import { recordMutationEvents, type MutationEventDescriptor } from "../mutation-pipeline.js";

/**
 * Storage format type. Only "split" is supported at runtime.
 * "monolithic" is kept in the type for schema parsing compatibility
 * but rejected at runtime with version-gated guidance.
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
  plan_ref?: string | null;
  review_ref?: string | null;
  depends_on: string[];
  blocked_by: string[];
  created_at: string;
  started_at?: string | null;
  submitted_at?: string | null;
  completed_at?: string | null;
  notes_count: number;
  todos_count: number;
}

/**
 * Extract a TaskSummary from a raw YAML task record.
 * Reads index-level fields plus array lengths for notes/todos counts.
 * Detail field *contents* (note text, todo items) are not accessed —
 * only Array.isArray checks and .length are used for the counts.
 *
 * AC: @task-data-manager ac-2 — only index data is read
 */
export function rawToSummary(raw: unknown): TaskSummary | null {
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
    assignee: typeof r.assignee === "string" ? r.assignee : r.assignee === null ? null : undefined,
    automation: typeof r.automation === "string" ? r.automation : undefined,
    spec_ref: typeof r.spec_ref === "string" ? r.spec_ref : r.spec_ref === null ? null : undefined,
    plan_ref: typeof r.plan_ref === "string" ? r.plan_ref : r.plan_ref === null ? null : undefined,
    review_ref:
      typeof r.review_ref === "string" ? r.review_ref : r.review_ref === null ? null : undefined,
    depends_on: Array.isArray(r.depends_on)
      ? r.depends_on.filter((d): d is string => typeof d === "string")
      : [],
    blocked_by: Array.isArray(r.blocked_by)
      ? r.blocked_by.filter((b): b is string => typeof b === "string")
      : [],
    created_at: typeof r.created_at === "string" ? r.created_at : new Date().toISOString(),
    started_at:
      typeof r.started_at === "string" ? r.started_at : r.started_at === null ? null : undefined,
    submitted_at:
      typeof r.submitted_at === "string"
        ? r.submitted_at
        : r.submitted_at === null
          ? null
          : undefined,
    completed_at:
      typeof r.completed_at === "string"
        ? r.completed_at
        : r.completed_at === null
          ? null
          : undefined,
    notes_count: Array.isArray(r.notes)
      ? r.notes.length
      : typeof r.notes_count === "number"
        ? r.notes_count
        : 0,
    todos_count: Array.isArray(r.todos)
      ? r.todos.length
      : typeof r.todos_count === "number"
        ? r.todos_count
        : 0,
  };
}

/**
 * Project only the index-level fields from a full task record.
 * Detail fields (notes, todos, description, vcs_refs, etc.) are stripped.
 *
 * AC: @task-data-manager ac-2 — callers of listTasks get only index data
 */
function _toTaskSummary(task: LoadedTask): TaskSummary {
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
    plan_ref: task.plan_ref,
    review_ref: task.review_ref,
    depends_on: task.depends_on,
    blocked_by: task.blocked_by,
    created_at: task.created_at,
    started_at: task.started_at,
    submitted_at: task.submitted_at,
    completed_at: task.completed_at,
    notes_count: task.notes?.length ?? 0,
    todos_count: task.todos?.length ?? 0,
  };
}

/**
 * Metadata about a mutation, passed to the storage backend for history tracking.
 * In the split format, this information is recorded in per-task history entries.
 *
 * AC: @task-core-data-file ac-1, ac-3 — provides author and command for history entries
 */
export interface MutationMetadata {
  /** The kspec command or API call that triggered the change */
  command: string;
  /** Who made the change (author identity) */
  author?: string;
}

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
  /** Skip the shadow commit — caller manages its own commit lifecycle.
   *  History metadata is still derived from operation/ref fields. */
  skipCommit?: boolean;
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
 * Stable code for the legacy (kynetic < 1.1) monolithic task-storage failure.
 *
 * Identifies projects pinned to the pre-1.1 manifest version without
 * task_storage.format: "split". The condition is deterministic: it can only
 * be cleared by running `kspec task migrate` or upgrading the manifest.
 */
export const TASK_STORAGE_LEGACY_REMOVED_CODE = "legacy_task_storage_removed";

/**
 * Stable code for the split-but-unmigrated task-storage failure.
 *
 * Identifies projects whose manifest configures the split task-storage format
 * while project.tasks.yaml still contains unmigrated monolithic entries. The
 * condition is deterministic: it can only be cleared by running
 * `kspec task migrate` or restoring a compatible task-storage state.
 */
export const TASK_STORAGE_SPLIT_UNMIGRATED_CODE = "split_task_storage_unmigrated";

/**
 * Codes that indicate a deterministic task-storage compatibility/migration
 * problem. These conditions will not resolve by retrying — they require a
 * project-state change (migration, manifest update). Callers that observe
 * an error with one of these codes can suspend retry loops until project
 * state changes.
 */
export const DETERMINISTIC_TASK_STORAGE_INCOMPATIBILITY_CODES: ReadonlySet<string> = new Set([
  TASK_STORAGE_LEGACY_REMOVED_CODE,
  TASK_STORAGE_SPLIT_UNMIGRATED_CODE,
]);

/**
 * Error thrown by TaskDataManager operations.
 * Includes descriptive messages and suggested actions per @trait-error-guidance.
 *
 * Stable error codes (see `code`) identify deterministic compatibility or
 * migration states so callers can drive bounded degraded-state behavior
 * without confusing them with transient mutation errors.
 */
// AC: @trait-error-guidance ac-1, ac-2
export class TaskDataManagerError extends Error {
  /** Suggested action for the user to resolve the error */
  readonly suggestion?: string;
  /** The field or value that failed, if applicable */
  readonly field?: string;
  /** Stable error code identifying a deterministic failure class. */
  readonly code?: string;

  constructor(message: string, options?: { suggestion?: string; field?: string; code?: string }) {
    super(message);
    this.name = "TaskDataManagerError";
    this.suggestion = options?.suggestion;
    this.field = options?.field;
    this.code = options?.code;
  }
}

/**
 * Type guard for TaskDataManagerError instances carrying a deterministic
 * task-storage incompatibility code (legacy removed, split unmigrated).
 *
 * Generic TaskDataManagerError cases — task-not-found, validation, mutation —
 * return false because they may resolve on retry and should not feed into
 * bounded degraded-state behavior.
 */
export function isDeterministicTaskStorageIncompatibility(
  err: unknown,
): err is TaskDataManagerError & { code: string } {
  return (
    err instanceof TaskDataManagerError &&
    typeof err.code === "string" &&
    DETERMINISTIC_TASK_STORAGE_INCOMPATIBILITY_CODES.has(err.code)
  );
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
  loadAllTasks(ctx: KspecContext): Promise<LoadedTask[]>;
  getTask(ctx: KspecContext, ref: string): Promise<LoadedTask | undefined>;
  createTask(ctx: KspecContext, task: Task): Promise<LoadedTask>;
  mutateTask(
    ctx: KspecContext,
    task: LoadedTask,
    mutate: (latestTask: LoadedTask) => Task | LoadedTask | Promise<Task | LoadedTask>,
    metadata?: MutationMetadata,
  ): Promise<LoadedTask>;
  mutateTasks(
    ctx: KspecContext,
    tasks: LoadedTask[],
    mutate: (
      latestTasks: LoadedTask[],
    ) => Array<Task | LoadedTask> | Promise<Array<Task | LoadedTask>>,
    metadata?: MutationMetadata,
  ): Promise<LoadedTask[]>;
  deleteTask(ctx: KspecContext, task: LoadedTask): Promise<void>;
  rebuildIndex(ctx: KspecContext): Promise<{ count: number }>;

  /**
   * Load all tasks with their field-change history in one bulk pass.
   * Optional because only the split backend currently exposes both.
   *
   * AC: @daemon-entity-cache ac-task-history-retention — bulk load retains history
   */
  loadAllTasksWithHistory?(
    ctx: KspecContext,
  ): Promise<Array<{ task: LoadedTask; history: HistoryEntry[] }>>;

  /**
   * Load a task and its field-change history in one read operation.
   * Optional because only the split backend currently exposes both.
   */
  loadTaskWithHistory?(
    ctx: KspecContext,
    ulid: string,
  ): Promise<{ task: LoadedTask | undefined; history: HistoryEntry[] }>;

  /**
   * Get the history entries for a task (optional — only split backend provides this).
   *
   * AC: @task-core-data-file ac-2 — history provides complete audit trail
   */
  getTaskHistory?(ctx: KspecContext, ulid: string): Promise<HistoryEntry[]>;

  /**
   * Persist actor-field rewrites the historical actor-normalization migration
   * applied to a task, including the per-task `history` array (history[].author)
   * that the normal mutate path neither exposes nor rewrites. Optional — only
   * the split backend, which owns the on-disk history shape, provides this.
   *
   * AC: @actor-history-normalization ac-5 — every inventoried task actor field
   *     ends canonical-or-default, including history[].author
   */
  saveActorNormalizedTask?(
    ctx: KspecContext,
    task: LoadedTask,
    history: HistoryEntry[],
  ): Promise<void>;
}

interface TaskReadCache {
  getDomainState(domain: "tasks"): string;
  getTaskIndex(): TaskSummary[] | null;
  getTaskDetail(ulid: string): LoadedTask | null;
  getTaskHistory(ulid: string): HistoryEntry[] | null;
  setTaskDetail(ulid: string, task: LoadedTask): void;
  getAllTaskDetails(): LoadedTask[] | null;
  /**
   * Apply a task mutation to the cache immediately — updates both the
   * index entry and the detail tier so subsequent reads see the new state
   * without waiting for a full domain reload.
   */
  applyTaskMutation?(ulid: string, task: LoadedTask): void;
}

function isTaskReadCache(cache: unknown): cache is TaskReadCache {
  return (
    typeof cache === "object" &&
    cache !== null &&
    typeof (cache as TaskReadCache).getDomainState === "function" &&
    typeof (cache as TaskReadCache).getTaskIndex === "function" &&
    typeof (cache as TaskReadCache).getTaskDetail === "function" &&
    typeof (cache as TaskReadCache).getTaskHistory === "function" &&
    typeof (cache as TaskReadCache).setTaskDetail === "function" &&
    typeof (cache as TaskReadCache).getAllTaskDetails === "function"
  );
}

function getReadyTaskCache(): TaskReadCache | null {
  const cacheCtx = getEntityCacheContext();
  if (!cacheCtx) {
    return null;
  }

  const cache = cacheCtx.cacheAccessor(cacheCtx.projectPath);
  if (!isTaskReadCache(cache) || cache.getDomainState("tasks") !== "ready") {
    return null;
  }

  return cache;
}

const TASK_MUTATION_ACTIONS: Record<string, string> = {
  "task-start": "start",
  "task-submit": "submit",
  "task-complete": "complete",
  "task-block": "block",
  "task-unblock": "unblock",
  "task-cancel": "cancel",
  "task-reset": "reset",
  "task-needs-work": "needs_work",
  "task-set": "set",
  "task-patch": "patch",
};

function taskEventRef(task: LoadedTask): string {
  return task.slugs[0] ? `@${task.slugs[0]}` : `@${task._ulid}`;
}

function buildTaskMutationEvent(
  before: LoadedTask,
  after: LoadedTask,
  commitOpts?: ShadowCommitOptions,
): MutationEventDescriptor | null {
  if (!commitOpts || commitOpts.skipCommit) {
    return null;
  }

  const action = TASK_MUTATION_ACTIONS[commitOpts.operation];
  if (!action) {
    return null;
  }

  return {
    topic: "tasks:updates",
    event: "task_updated",
    data: {
      ref: taskEventRef(after),
      ulid: after._ulid,
      action,
      title: after.title,
      old_status: before.status === after.status ? null : before.status,
      new_status: before.status === after.status ? null : after.status,
    },
  };
}

function recordTaskMutationEvent(
  before: LoadedTask,
  after: LoadedTask,
  commitOpts?: ShadowCommitOptions,
): void {
  const event = buildTaskMutationEvent(before, after, commitOpts);
  if (event) {
    recordMutationEvents([event]);
  }
}

function findTaskSummaryByRef(tasks: TaskSummary[], ref: string): TaskSummary | undefined {
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;

  return tasks.find((task) => {
    if (task._ulid === cleanRef) return true;
    if (task._ulid.toLowerCase().startsWith(cleanRef.toLowerCase())) return true;
    if (task.slugs.includes(cleanRef)) return true;
    return false;
  });
}

/**
 * In-memory per-task FIFO mutex for contention-free non-overlapping mutations.
 *
 * Each task ULID maps to a promise representing the tail of a FIFO queue.
 * A new waiter captures the current tail, replaces it with its own promise,
 * then awaits the captured tail. This ensures strict serialization even with
 * 3+ concurrent same-task mutations: each waiter chains onto the previous
 * waiter (not the current holder), so only one wakes at a time.
 *
 * Mutations on different ULIDs proceed independently — they don't share a lock.
 *
 * AC: @task-data-manager ac-5 — non-overlapping mutations proceed without contention
 * AC: @task-data-manager ac-9 — same-task mutations serialize (FIFO queue)
 */
class TaskMutexMap {
  private readonly locks = new Map<string, Promise<void>>();

  /**
   * Acquire an exclusive lock for a task ULID. Returns a release function.
   * Waiters form a FIFO chain: each new caller chains onto the tail of the
   * queue so that only one waiter wakes when the preceding holder releases.
   * Mutations on different ULIDs proceed concurrently.
   */
  async acquire(ulid: string): Promise<() => void> {
    // Capture the current tail of the queue (the previous waiter's promise).
    // This is the promise we must await before entering the critical section.
    const predecessor = this.locks.get(ulid);

    // Create this waiter's own promise — the *next* waiter will chain onto it.
    let release!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Install this waiter as the new tail BEFORE awaiting the predecessor.
    // Any subsequent caller will now chain onto lockPromise, not predecessor.
    this.locks.set(ulid, lockPromise);

    // Wait for the predecessor to release (no-op if we're first in line).
    if (predecessor) {
      await predecessor;
    }

    return () => {
      // Clean up the map entry only if this is still the tail (no waiters behind us).
      if (this.locks.get(ulid) === lockPromise) {
        this.locks.delete(ulid);
      }
      release();
    };
  }
}

/**
 * Registry for storage backends. Only the split backend is registered at
 * runtime. The registry is kept for extensibility.
 */
const backendRegistry = new Map<StorageFormat, TaskStorageBackend>();

/**
 * Register a storage backend for a given format.
 * Used by the split storage implementation to plug in its backend.
 */
export function registerBackend(backend: TaskStorageBackend): void {
  backendRegistry.set(backend.format, backend);
}

/**
 * Unregister a storage backend for a given format.
 * Primarily used in tests to restore the default registry state.
 */
export function unregisterBackend(format: StorageFormat): void {
  backendRegistry.delete(format);
}

/**
 * Ensure the split backend is registered. Uses createRequire for synchronous
 * module loading within ESM, avoiding circular dependency from top-level imports.
 * Called lazily from the TaskDataManager constructor when "split" format is requested.
 */
/** Synchronous require for ESM — used for lazy backend registration. */
const esmRequire = createRequire(import.meta.url);

function ensureSplitBackend(): void {
  if (backendRegistry.has("split")) return;
  try {
    const mod = esmRequire("./split-backend.js") as { ensureSplitBackendRegistered?: () => void };
    mod.ensureSplitBackendRegistered?.();
  } catch {
    // In vitest or environments where createRequire can't resolve .js,
    // the split backend must be imported by the test/caller directly.
    // The constructor will throw a descriptive error if still not registered.
  }
}

/**
 * Validate a task record against the schema before persisting.
 * Strips _sourceFile before validation since it is runtime metadata.
 * When originalUlid is provided, enforces that the mutation did not
 * change the task's identity — ULID must be immutable.
 *
 * AC: @trait-error-guidance ac-5 — validation errors include field info
 */
function validateMutationOutput(task: Task | LoadedTask, originalUlid?: string): void {
  // Enforce ULID immutability — mutations must not change a task's identity
  if (originalUlid && task._ulid !== originalUlid) {
    throw new TaskDataManagerError(
      `Mutation must not change a task's ULID. Original: ${originalUlid}, received: ${task._ulid}`,
      {
        suggestion:
          "The mutation callback must preserve the task's _ulid. Return the task with its original identity.",
        field: "_ulid",
      },
    );
  }

  const { _sourceFile: _, ...cleanTask } = task as LoadedTask;
  const result = TaskSchema.safeParse(cleanTask);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const fieldPath = firstIssue?.path?.join(".") || "unknown";
    throw new TaskDataManagerError(`Mutation produced invalid task data: ${result.error.message}`, {
      suggestion:
        "Check the mutation callback returns a valid task record matching the task schema",
      field: fieldPath,
    });
  }
}

/**
 * Task Data Manager — owns all task storage operations.
 *
 * AC: @task-data-manager ac-1 — callers don't know about storage format
 * AC: @task-data-manager ac-8 — split format used when activated
 *
 * The manager uses the split storage backend exclusively. Construction
 * defaults to "split" format. If the split backend has not been registered,
 * the constructor throws a descriptive error.
 */
export class TaskDataManager {
  readonly storageFormat: StorageFormat;
  private readonly backend: TaskStorageBackend;

  /**
   * Per-task in-memory mutex that spans the entire write-buffer lifecycle
   * (including flush). The backend's internal mutex only covers the
   * buffering phase — the flush happens in withWriteBuffer AFTER the
   * backend method returns. Without this outer lock, concurrent mutations
   * on the same task read stale disk state because the previous mutation's
   * buffer hasn't flushed yet.
   *
   * AC: @task-data-manager ac-9 — same-task mutations serialize through flush
   * AC: @task-data-manager ac-10 — delete + mutate fully complete before other begins
   */
  private readonly taskMutex = new TaskMutexMap();

  constructor(storageFormat: StorageFormat = "split") {
    this.storageFormat = storageFormat;
    let backend = backendRegistry.get(storageFormat);

    // Lazy registration: when "split" is requested but not yet registered,
    // synchronously load the split backend module and register it.
    if (!backend && storageFormat === "split") {
      ensureSplitBackend();
      backend = backendRegistry.get(storageFormat);
    }

    if (!backend) {
      throw new TaskDataManagerError(
        `No storage backend registered for format "${storageFormat}".`,
        {
          suggestion: "Ensure the split storage backend has been registered via registerBackend().",
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
   */
  async listTasks(ctx: KspecContext, filters?: TaskListFilters): Promise<TaskSummary[]> {
    const summaries = getReadyTaskCache()?.getTaskIndex() ?? (await this.backend.listTasks(ctx));

    if (!filters) {
      return summaries;
    }

    return summaries.filter((task) => {
      if (filters.status) {
        const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
        if (!statuses.includes(task.status)) return false;
      }
      if (filters.tags && filters.tags.length > 0) {
        if (!filters.tags.some((tag) => task.tags.includes(tag))) return false;
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
   * Load all tasks with full detail (notes, todos, description, etc.).
   *
   * Use this when the caller genuinely needs complete task records for
   * every task (e.g., alignment checks that inspect notes, prompt building
   * that formats notes for agents). For listing/filtering where only
   * index-level fields are needed, prefer listTasks().
   *
   * AC: @task-data-manager ac-1 — callers don't know about storage format
   */
  async loadAllTasks(ctx: KspecContext): Promise<LoadedTask[]> {
    return getReadyTaskCache()?.getAllTaskDetails() ?? this.backend.loadAllTasks(ctx);
  }

  /**
   * Load all tasks with their field-change history in one bulk pass.
   *
   * Delegates to the backend's loadAllTasksWithHistory() if available,
   * otherwise falls back to loadAllTasks() with empty history arrays.
   *
   * AC: @daemon-entity-cache ac-task-history-retention — bulk load retains history
   */
  async loadAllTasksWithHistory(
    ctx: KspecContext,
  ): Promise<Array<{ task: LoadedTask; history: HistoryEntry[] }>> {
    if (this.backend.loadAllTasksWithHistory) {
      return this.backend.loadAllTasksWithHistory(ctx);
    }

    // Fallback: load tasks without history
    const tasks = await this.backend.loadAllTasks(ctx);
    return tasks.map((task) => ({ task, history: [] }));
  }

  /**
   * Persist actor-field rewrites the historical actor-normalization migration
   * applied to a task, including the per-task history array (history[].author)
   * that the normal mutate path does not expose for rewriting.
   *
   * Delegates to the backend's history-aware save path when available. Backends
   * without per-task history (no split storage) fall back to a core-field-only
   * rewrite through mutateTask — there is no history to normalize there.
   *
   * AC: @actor-history-normalization ac-5 — every inventoried task actor field
   *     ends canonical-or-default, including history[].author
   */
  async saveActorNormalizedTask(
    ctx: KspecContext,
    task: LoadedTask,
    history: HistoryEntry[],
  ): Promise<void> {
    if (this.backend.saveActorNormalizedTask) {
      await this.backend.saveActorNormalizedTask(ctx, task, history);
      return;
    }
    // No history-aware backend: rewrite the schema-backed core actor fields
    // only (assignee, todos[].added_by, notes[].author) via the standard path.
    await this.mutateTask(ctx, task._ulid, () => task);
  }

  /**
   * Get full details for a specific task by reference (ULID, slug, or short ref).
   *
   * The backend reads the index + per-task directory to assemble the
   * complete record.
   *
   * AC: @task-data-manager ac-3 — assembles complete task transparently
   * AC: @trait-error-guidance ac-3 — suggests checking ref on not found
   */
  async getTask(ctx: KspecContext, ref: string): Promise<LoadedTask> {
    let task: LoadedTask | undefined;
    const cache = getReadyTaskCache();
    if (cache) {
      const cachedSummary = findTaskSummaryByRef(cache.getTaskIndex() ?? [], ref);
      if (cachedSummary) {
        const cachedTask = cache.getTaskDetail(cachedSummary._ulid);
        if (cachedTask) {
          return cachedTask;
        }
      }

      task = await this.backend.getTask(ctx, ref);
      if (task) {
        cache.setTaskDetail(task._ulid, task);
        return task;
      }
    }

    task ??= await this.backend.getTask(ctx, ref);
    if (!task) {
      // AC: @trait-error-guidance ac-1, ac-2, ac-3
      throw new TaskDataManagerError(`Task not found: ${ref}`, {
        suggestion: `Check the reference with: kspec search "${ref}" or kspec task list`,
      });
    }
    return task;
  }

  /**
   * Load a task and its history together when the backend can provide both.
   *
   * This lets cache-aware command execution reuse eagerly retained history
   * without re-reading task.yaml after task detail is already warm.
   */
  async loadTaskWithHistory(
    ctx: KspecContext,
    ulid: string,
  ): Promise<{ task: LoadedTask | undefined; history: HistoryEntry[] }> {
    const cache = getReadyTaskCache();
    if (cache) {
      const cachedTask = cache.getTaskDetail(ulid);
      const cachedHistory = cache.getTaskHistory(ulid);
      if (cachedTask && cachedHistory) {
        return { task: cachedTask, history: cachedHistory };
      }
    }

    if (this.backend.loadTaskWithHistory) {
      return this.backend.loadTaskWithHistory(ctx, ulid);
    }

    const task = await this.backend.getTask(ctx, ulid);
    const history = this.backend.getTaskHistory ? await this.backend.getTaskHistory(ctx, ulid) : [];
    return { task, history };
  }

  /**
   * Get the history entries for a task from the storage backend.
   *
   * Returns the per-task field-change history if the backend supports it.
   *
   * AC: @task-core-data-file ac-2 — history provides complete audit trail
   */
  async getTaskHistory(ctx: KspecContext, ulid: string): Promise<HistoryEntry[]> {
    const cachedHistory = getReadyTaskCache()?.getTaskHistory(ulid);
    if (cachedHistory) {
      return cachedHistory;
    }

    if (this.backend.getTaskHistory) {
      return this.backend.getTaskHistory(ctx, ulid);
    }
    return [];
  }

  /**
   * Wrap a backend operation in a write buffer scope.
   *
   * For the split format, this ensures all file writes (index + per-task files)
   * are collected in a single buffer and flushed atomically. Uses runWithBuffer()
   * which creates an isolated async-local scope — concurrent operations on
   * different tasks each get their own buffer and cannot interfere with each
   * other. If a batch buffer is already active (from batch-exec or a parent
   * operation), runWithBuffer() reuses it and the parent owns flush/discard.
   *
   * AC: @task-atomic-writes ac-1 — both files written within single buffered transaction
   * AC: @task-atomic-writes ac-2 — if any write fails, buffer is discarded
   * AC: @task-atomic-writes ac-3 — batch buffer reused when active
   */
  private async withWriteBuffer<T>(
    ctx: KspecContext,
    commitOpts: ShadowCommitOptions | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Check whether a parent buffer already owns the lifecycle BEFORE
    // entering runWithBuffer. When nested, the parent buffer has not
    // flushed yet, so commitIfShadow must be deferred to the parent —
    // committing now would capture pre-flush (stale) disk state.
    const isNested = getActiveBatchBuffer() !== null;

    // runWithBuffer creates an isolated async-local scope for the buffer.
    // If a parent buffer already exists (batch-exec or outer operation),
    // the callback receives null and the parent's buffer is reused.
    // Otherwise, a new buffer is created, flushed on success, discarded
    // on failure — all scoped to this async context only.
    const result = await runWithBuffer(ctx.specDir, async () => {
      return operation();
    });

    // Shadow commit AFTER flush — all files are on disk atomically.
    // Skip when nested: the parent buffer hasn't flushed yet, so disk
    // state doesn't reflect our writes. The parent scope (batch-exec or
    // outer withWriteBuffer) owns flush + commit lifecycle.
    if (commitOpts && !commitOpts.skipCommit && !isNested) {
      await commitIfShadow(
        ctx.shadow,
        commitOpts.operation,
        commitOpts.ref,
        commitOpts.detail,
        commitOpts.verbose,
      );
    }

    return result;
  }

  /**
   * Create a new task and persist it.
   *
   * Handles ULID generation, schema validation, file writing, locking, and
   * shadow branch commit as a single coordinated operation.
   *
   * AC: @task-data-manager ac-4 — files, locking, commits coordinated
   * AC: @task-data-manager ac-6 — atomic operation
   * AC: @task-atomic-writes ac-1 — all files written in single buffered transaction
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

    const result = await this.withWriteBuffer(ctx, commitOpts, async () => {
      // Delegate _sourceFile ownership to the backend — the backend decides
      // where the task lives based on its storage format.
      // AC: @task-data-manager ac-1 — callers don't know about storage format
      // AC: @task-data-manager ac-8 — split backend owns its own metadata
      return this.backend.createTask(ctx, newTask);
    });

    // Propagate new task to entity cache immediately.
    const cache = getReadyTaskCache();
    cache?.applyTaskMutation?.(result._ulid, result);

    return result;
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
   * AC: @task-atomic-writes ac-1 — index + per-task file in single buffer
   */
  async mutateTask(
    ctx: KspecContext,
    ref: string,
    mutate: (latestTask: LoadedTask) => Task | LoadedTask | Promise<Task | LoadedTask>,
    commitOpts?: ShadowCommitOptions,
  ): Promise<LoadedTask> {
    // Resolve the task first to get _sourceFile for locking
    const task = await this.getTask(ctx, ref);

    // Build mutation metadata from commitOpts for history tracking
    // AC: @task-core-data-file ac-3 — author resolved via full priority chain (env → config → git → system)
    const metadata: MutationMetadata | undefined = commitOpts
      ? { command: commitOpts.operation, author: getAuthor(ctx.config?.identity?.author) }
      : undefined;

    // Acquire per-task lock BEFORE withWriteBuffer so the lock spans the
    // entire operation including the buffer flush. Without this, the split
    // backend's internal lock releases before flush, allowing a concurrent
    // mutation to read stale disk state.
    // AC: @task-data-manager ac-9 — same-task mutations serialize through flush
    const releaseTaskLock = await this.taskMutex.acquire(task._ulid);
    try {
      let eventBeforeTask = task;
      const result = await this.withWriteBuffer(ctx, commitOpts, async () => {
        return this.backend.mutateTask(
          ctx,
          task,
          async (latestTask) => {
            eventBeforeTask = latestTask;
            const mutated = await mutate(latestTask);
            validateMutationOutput(mutated, latestTask._ulid);
            return mutated;
          },
          metadata,
        );
      });

      // Immediately propagate the mutation to the entity cache so subsequent
      // reads (even within the same request or the very next command) see the
      // updated state without waiting for the post-command writeThrough or
      // the file-watcher's debounced invalidation.
      const cache = getReadyTaskCache();
      cache?.applyTaskMutation?.(result._ulid, result);
      recordTaskMutationEvent(eventBeforeTask, result, commitOpts);

      return result;
    } finally {
      releaseTaskLock();
    }
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
   * AC: @task-atomic-writes ac-3 — all writes in single buffer commit
   * AC: @task-atomic-writes ac-4 — multi-task writes in single atomic operation
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
    const tasks = await Promise.all(refs.map((ref) => this.getTask(ctx, ref)));

    // Build mutation metadata from commitOpts for history tracking
    // AC: @task-core-data-file ac-3 — author resolved via full priority chain (env → config → git → system)
    const metadata: MutationMetadata | undefined = commitOpts
      ? { command: commitOpts.operation, author: getAuthor(ctx.config?.identity?.author) }
      : undefined;

    // Acquire per-task locks in sorted ULID order to prevent deadlocks,
    // and hold them through the buffer flush.
    // AC: @task-data-manager ac-9 — same-task mutations serialize through flush
    const sortedUlids = [...new Set(tasks.map((t) => t._ulid))].toSorted();
    const releases: Array<() => void> = [];

    try {
      for (const ulid of sortedUlids) {
        releases.push(await this.taskMutex.acquire(ulid));
      }

      let eventBeforeTasks = tasks;
      const results = await this.withWriteBuffer(ctx, commitOpts, async () => {
        return this.backend.mutateTasks(
          ctx,
          tasks,
          async (latestTasks) => {
            eventBeforeTasks = latestTasks;
            const mutated = await mutate(latestTasks);
            for (let i = 0; i < mutated.length; i++) {
              validateMutationOutput(mutated[i], latestTasks[i]?._ulid);
            }
            return mutated;
          },
          metadata,
        );
      });

      // Propagate all mutations to the entity cache immediately.
      const cache = getReadyTaskCache();
      if (cache?.applyTaskMutation) {
        for (const task of results) {
          cache.applyTaskMutation(task._ulid, task);
        }
      }
      for (let i = 0; i < results.length; i++) {
        const before = eventBeforeTasks[i];
        const after = results[i];
        if (before && after) {
          recordTaskMutationEvent(before, after, commitOpts);
        }
      }

      return results;
    } finally {
      for (const release of releases) {
        release();
      }
    }
  }

  /**
   * Delete a task by reference.
   *
   * Removes the task from its source file atomically with file locking.
   *
   * AC: @task-data-manager ac-4 — files, locking, commits coordinated
   * AC: @task-data-manager ac-6 — atomic operation
   * AC: @task-atomic-writes ac-1 — index + per-task file in single buffer
   * AC: @trait-error-guidance ac-3 — suggests checking ref on not found
   */
  async deleteTask(
    ctx: KspecContext,
    ref: string,
    commitOpts?: ShadowCommitOptions,
  ): Promise<void> {
    const task = await this.getTask(ctx, ref);

    // Acquire per-task lock BEFORE withWriteBuffer so the lock spans the
    // entire operation including the buffer flush. Prevents delete + mutate
    // races where the mutate reads stale state mid-delete.
    // AC: @task-data-manager ac-10 — delete + mutate fully complete before other begins
    const releaseTaskLock = await this.taskMutex.acquire(task._ulid);
    try {
      return await this.withWriteBuffer(ctx, commitOpts, async () => {
        // Delegate entirely to the backend — it decides how to locate and
        // remove the task based on its own storage format. The manager does
        // not require _sourceFile; a split backend may use other metadata.
        // AC: @task-data-manager ac-1 — callers don't know about storage format
        // AC: @task-data-manager ac-8 — split backend owns its own deletion path
        await this.backend.deleteTask(ctx, task);
      });
    } finally {
      releaseTaskLock();
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
    author: string,
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

  /**
   * Rebuild the task index from per-task files.
   *
   * Scans all task directories and regenerates the index file — the recovery
   * path when the index has drifted.
   *
   * AC: @task-index-file ac-7 — index fully regenerated from per-task files alone
   */
  async rebuildIndex(ctx: KspecContext): Promise<{ count: number }> {
    return this.backend.rebuildIndex(ctx);
  }
}

/**
 * Cached split-format manager instance.
 * Created lazily on first resolveTaskDataManager() call.
 */
let splitManagerInstance: TaskDataManager | null = null;

/**
 * Resolve the correct TaskDataManager for a given context.
 *
 * Returns the split-format manager when the manifest specifies
 * task_storage.format: "split" (or kynetic version >= 1.1).
 *
 * For legacy projects (kynetic: "1.0" without task_storage.format: "split"),
 * throws a version-gated error guiding users to run `kspec task migrate`.
 * This is a higher-level gate than ensureMigrated() which stays as a
 * data-integrity safety net in the split backend.
 */
export function resolveTaskDataManager(ctx: KspecContext): TaskDataManager {
  const storage = ctx.manifest?.task_storage?.format;
  const kyneticVersion = ctx.manifest?.kynetic;

  // Version-gated legacy detection: when the manifest explicitly declares
  // kynetic 1.0 without task_storage.format: "split", the project was
  // created before the split migration and hasn't been upgraded yet.
  // This is a higher-level gate than ensureMigrated() which stays as a
  // data-integrity safety net in the split backend.
  if (kyneticVersion !== undefined && storage !== "split" && parseFloat(kyneticVersion) < 1.1) {
    throw new TaskDataManagerError(
      `This project uses kynetic version "${kyneticVersion}" without split task storage. ` +
        "The monolithic task storage format has been removed.",
      {
        suggestion:
          'Run "kspec task migrate" to convert to per-task directory storage, then tasks will work normally.',
        field: "task_storage.format",
        code: TASK_STORAGE_LEGACY_REMOVED_CODE,
      },
    );
  }

  // All other cases: use split format (the only supported backend)
  if (!splitManagerInstance) {
    splitManagerInstance = new TaskDataManager("split");
  }
  return splitManagerInstance;
}
