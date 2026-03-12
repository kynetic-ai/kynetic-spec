/**
 * Agent Dispatch Engine
 *
 * Core dispatch runtime for the daemon. Watches for task state changes via
 * file watcher events and direct API event emission from CLI commands. Matches
 * state changes against agent dispatch rules, queues invocations, manages
 * concurrency, and handles deduplication of events from dual sources.
 * Serializes shadow branch mutations when multiple agents run concurrently.
 *
 * AC: @agent-dispatch-engine ac-1 through ac-12
 */

import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ulid } from "ulid";
import {
  initContext,
  loadAllTasks,
  loadMetaContext,
  areDependenciesMet,
  type LoadedTask,
  type LoadedAgent,
} from "../parser/index.js";
import { runInvocation } from "./invocation.js";
import type { InvocationOptions } from "./invocation.js";
import { interpolateTemplate } from "./prompts.js";
import { getAdapter } from "../agents/adapters.js";
import {
  provisionDispatchWorkspace,
  DispatchWorkspaceError,
} from "./workspace.js";
import type {
  AgentDispatchRule,
  AgentDispatchFilter,
} from "../schema/meta.js";
import type { SessionTrigger } from "../sessions/types.js";

// ─── Simple Mutex ─────────────────────────────────────────────────────────────

/**
 * A minimal promise-based mutex for serializing async operations.
 * AC: @agent-dispatch-engine ac-12
 */
class Mutex {
  private _queue: Array<() => void> = [];
  private _locked = false;

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this._acquire();
    try {
      return await fn();
    } finally {
      this._release();
    }
  }

  private _acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  private _release(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._locked = false;
    }
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Task state as used for dispatch tracking.
 */
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "pending_review"
  | "needs_work"
  | "blocked"
  | "completed"
  | "cancelled";

/**
 * Mapping from dispatch event names to task statuses.
 * AC: @agent-dispatch-engine ac-1
 */
const EVENT_TO_STATUS: Record<string, TaskStatus> = {
  "task.in_progress": "in_progress",
  "task.ready": "pending",
  "task.needs_work": "needs_work",
  "task.pending_review": "pending_review",
};

const STATUS_TO_EVENT: Record<TaskStatus, string | undefined> = {
  in_progress: "task.in_progress",
  pending: "task.ready",
  needs_work: "task.needs_work",
  pending_review: "task.pending_review",
  blocked: undefined,
  completed: undefined,
  cancelled: undefined,
};

/**
 * Dispatch precedence for runnable task statuses.
 * Lower number = higher scheduling priority.
 *
 * AC: @dispatch-in-progress-priority ac-1
 */
const STATUS_PRECEDENCE: Record<TaskStatus, number> = {
  in_progress: 0,
  needs_work: 1,
  pending_review: 2,
  pending: 3,
  blocked: 4,
  completed: 5,
  cancelled: 6,
};

// ─── Prompt Helpers ──────────────────────────────────────────────────────────

// AC: @agent-dispatch-engine ac-16 — re-exported from prompts.ts for backwards compat
export { interpolateTemplate };

/**
 * Human-readable trigger description for orientation context.
 */
function triggerDescription(trigger: string): string {
  switch (trigger) {
    case "task.ready":
      return "New task assignment.";
    case "task.in_progress":
      return "Continuing in-progress work.";
    case "task.needs_work":
      return "Fix cycle \u2014 this task was kicked back from review. Address the feedback below.";
    case "task.pending_review":
      return "Task submitted for review.";
    default:
      return `Trigger: ${trigger}`;
  }
}

/**
 * Format recent notes for inclusion in dispatch prompts.
 * Takes last N notes, truncates each to maxLen characters, strips newlines.
 */
function formatRecentNotes(
  notes: Array<{ created_at: string; author?: string; content: string }>,
  count = 3,
  maxLen = 200,
): string {
  if (!notes || notes.length === 0) return "";
  const recent = notes.slice(-count);
  const lines = recent.map((n) => {
    const date = n.created_at.slice(0, 10);
    const author = n.author ? `@${n.author}` : "unknown";
    const content = n.content.replace(/\n/g, " ").slice(0, maxLen);
    return `- [${date}] ${author}: ${content}`;
  });
  return lines.join("\n");
}

/**
 * Build orientation context block for a dispatch prompt.
 * Provides the agent with task title, trigger meaning, and relevant context.
 *
 * AC: @agent-dispatch-engine ac-13, ac-14, ac-15
 */
export function buildOrientationContext(
  taskRef: string,
  trigger: string,
  task?: {
    title: string;
    notes?: Array<{ created_at: string; author?: string; content: string }>;
    review_url?: string;
  },
): string {
  const title = task?.title ?? "(unavailable)";
  const lines = [
    "## Task Context",
    `Task: ${taskRef} \u2014 "${title}"`,
    `Trigger: ${triggerDescription(trigger)}`,
  ];

  // AC: @agent-dispatch-engine ac-14 - Include recent notes for fix cycles
  if (trigger === "task.needs_work" && task?.notes && task.notes.length > 0) {
    const noteText = formatRecentNotes(task.notes);
    if (noteText) {
      lines.push("", "Recent notes:", noteText);
    }
  }

  // AC: @agent-dispatch-engine ac-15 - Include review URL for reviewer
  if (trigger === "task.pending_review") {
    const url = task?.review_url ?? "Not provided \u2014 find PR via task notes or git log.";
    lines.push(`Review URL: ${url}`);
  }

  return lines.join("\n");
}

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A state change event for a single task.
 */
export interface TaskStateChange {
  taskId: string;
  taskRef: string;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  timestamp: number;
  /** Optional task data used for filter evaluation (AC-6) */
  task?: LoadedTask;
}

/**
 * An entry in the dispatch queue.
 */
interface QueueEntry {
  agent: LoadedAgent;
  change: TaskStateChange;
  retryCount: number;
  nextRetryAt: number;
  /** When this entry was first enqueued (for wait-time display) */
  enqueuedAtMs: number;
  /** Monotonic sequence for deterministic tie-breaking */
  sequence: number;
}

/**
 * Tracking record for an active invocation.
 * AC: @cli-agent-commands ac-6
 */
interface ActiveInvocationRecord {
  invocationId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  taskRef: string | undefined;
  startedAtMs: number;
}

/**
 * Deduplication key for recent state changes.
 * AC: @agent-dispatch-engine ac-7
 */
type DedupKey = `${string}:${string}:${string}`;

/**
 * Invocation lifecycle event payload.
 * AC: @daemon-agent-dispatch ac-3, ac-4
 */
export interface InvocationEvent {
  type: "started" | "completed" | "failed";
  session_id: string;
  agent_id: string;
  task_id: string | undefined;
  status: "started" | "completed" | "failed";
  timestamp: number;
}

/**
 * Options for creating a DispatchEngine.
 */
export interface DispatchEngineOptions {
  /** Project root directory */
  projectDir: string;
  /**
   * Spec directory (.kspec/ for shadow mode, or same as projectDir for traditional mode).
   * Defaults to projectDir/.kspec if not specified.
   */
  specDir?: string;
  /** Working directory for spawned agents */
  cwd?: string;
  /** Deduplication window in milliseconds (default 2000) */
  dedupWindowMs?: number;
  /**
   * Periodic reconciliation interval in milliseconds (default 60000).
   * Re-evaluates all task states against dispatch rules, enqueuing any that
   * match but have no active or queued invocation. Set to 0 or null to disable.
   * AC: @agent-dispatch-engine ac-20
   */
  reconcileIntervalMs?: number | null;
  /** Path to kspec CLI binary (for task notes) */
  kspecCliPath?: string;
  /**
   * Optional callback invoked on invocation lifecycle events (start, complete, fail).
   * AC: @daemon-agent-dispatch ac-3, ac-4
   */
  onInvocationEvent?: (event: InvocationEvent) => void;
  /**
   * Optional callback invoked for each text chunk produced by a running agent.
   * AC: @cli-agent-commands ac-13 (broadcast to watch subscribers)
   * AC: @daemon-agent-dispatch ac-8
   */
  onTextChunk?: (sessionId: string, agentId: string, taskId: string | null, text: string) => void;
}

// ─── DispatchEngine ───────────────────────────────────────────────────────────

/**
 * The core dispatch runtime.
 *
 * Lifecycle:
 *   1. Create with new DispatchEngine(options)
 *   2. Call start() to bootstrap and begin processing
 *   3. Feed state changes via handleStateChange()
 *   4. Call stop() for graceful shutdown
 *
 * AC: @agent-dispatch-engine ac-1 through ac-12
 */
export class DispatchEngine {
  private projectDir: string;
  private specDir: string;
  private cwd: string;
  private dedupWindowMs: number;
  private reconcileIntervalMs: number;
  private kspecCliPath?: string;
  private onInvocationEvent?: (event: InvocationEvent) => void;
  private onTextChunk?: (sessionId: string, agentId: string, taskId: string | null, text: string) => void;

  /** Queue of pending dispatch entries, per agent id */
  private queues: Map<string, QueueEntry[]> = new Map();
  /** Count of active (running) invocations per agent id */
  private activeCount: Map<string, number> = new Map();
  /** Recent dedup keys with their expiry timestamps */
  private recentEvents: Map<DedupKey, number> = new Map();
  /** Previous task states (for file watcher diffing) */
  private prevTaskStates: Map<string, TaskStatus> = new Map();
  /** Mutex serializing shadow branch mutations */
  private shadowMutex = new Mutex();
  /** Whether the engine is currently running */
  private running = false;
  /** Set of running invocation promises (for graceful shutdown) */
  private runningInvocations: Set<Promise<void>> = new Set();
  /** AbortControllers for active invocations (for graceful cancel on stop) */
  private invocationAbortControllers: Set<AbortController> = new Set();
  /** Per-invocation tracking records for status display */
  private activeInvocationDetails: Map<string, ActiveInvocationRecord> = new Map();
  /** Monotonic enqueue sequence for deterministic queue ordering */
  private nextQueueSequence = 0;
  /** Timer handle for periodic reconciliation. AC: @agent-dispatch-engine ac-20 */
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DispatchEngineOptions) {
    this.projectDir = options.projectDir;
    this.specDir = options.specDir ?? path.join(options.projectDir, ".kspec");
    this.cwd = options.cwd ?? options.projectDir;
    this.dedupWindowMs = options.dedupWindowMs ?? 2000;
    this.reconcileIntervalMs = (options.reconcileIntervalMs === null || options.reconcileIntervalMs === 0)
      ? 0
      : (options.reconcileIntervalMs ?? 60_000);
    this.kspecCliPath = options.kspecCliPath;
    this.onInvocationEvent = options.onInvocationEvent;
    this.onTextChunk = options.onTextChunk;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start the dispatch engine.
   *
   * Loads current task states and evaluates dispatch rules for bootstrap.
   * AC: @agent-dispatch-engine ac-8
   */
  async start(): Promise<void> {
    this.running = true;

    // AC: @agent-dispatch-engine ac-8 - Bootstrap: evaluate existing task states
    await this._bootstrap();

    // AC: @agent-dispatch-engine ac-19, ac-20 - Start periodic reconciliation
    if (this.reconcileIntervalMs > 0) {
      this.reconcileTimer = setInterval(() => {
        if (this.running) {
          this._reconcile().catch((err) => {
            console.error("[dispatch] Reconciliation error:", err);
          });
        }
      }, this.reconcileIntervalMs);
      this.reconcileTimer.unref();
    }
  }

  /**
   * Handle a task state change event from any source (file watcher or API).
   *
   * AC: @agent-dispatch-engine ac-1, ac-2, ac-4, ac-5, ac-6, ac-7
   */
  async handleStateChange(change: TaskStateChange): Promise<void> {
    if (!this.running) return;

    // AC: @agent-dispatch-engine ac-7 - Deduplication
    if (this._isDuplicate(change)) {
      return;
    }
    this._recordEvent(change);

    // AC: @agent-dispatch-engine ac-1 - Match against dispatch rules
    const agents = await this._loadAgents();
    const eventType = STATUS_TO_EVENT[change.toStatus];
    if (!eventType) return;

    // Load all tasks for filter evaluation (needed for dependency checks)
    let allTasks: LoadedTask[] | undefined;
    let taskData = change.task;
    if (!taskData && change.taskId) {
      try {
        const ctx = await initContext(this.projectDir);
        allTasks = await loadAllTasks(ctx);
        taskData = allTasks.find((t) => t._ulid === change.taskId);
      } catch {
        // Can't load tasks, filter evaluation will be lenient
      }
    }
    // Load allTasks for dependency checking even when task data was provided
    if (!allTasks && taskData) {
      try {
        const ctx = await initContext(this.projectDir);
        allTasks = await loadAllTasks(ctx);
      } catch {
        // Can't load tasks, dependency check will be skipped
      }
    }
    // Make loaded task available for prompt building (AC: @agent-dispatch-engine ac-13)
    if (taskData && !change.task) {
      change.task = taskData;
    }

    for (const agent of agents) {
      for (const rule of (agent.dispatch ?? [])) {
        if (rule.on !== eventType) continue;

        // AC: @agent-dispatch-engine ac-6 - Apply filters
        if (!this._matchesFilter(change, rule, taskData, allTasks)) continue;

        // AC: @agent-dispatch-engine ac-2 - Each matching agent queued independently
        this._enqueue(agent, change);
      }
    }

    // Drain queues after enqueuing
    await this._drainQueues(agents);
  }

  /**
   * Handle file watcher notification: diff previous vs current task states.
   *
   * AC: @agent-dispatch-engine ac-5
   */
  async handleFileChange(specDir: string): Promise<void> {
    if (!this.running) return;

    try {
      const ctx = await initContext(this.projectDir);
      const tasks = await loadAllTasks(ctx);

      const changes: TaskStateChange[] = [];
      const now = Date.now();

      for (const task of tasks) {
        const taskId = task._ulid;
        const currentStatus = task.status as TaskStatus;
        const prevStatus = this.prevTaskStates.get(taskId);

        if (prevStatus !== undefined && prevStatus !== currentStatus) {
          changes.push({
            taskId,
            taskRef: `@${taskId}`,
            fromStatus: prevStatus,
            toStatus: currentStatus,
            timestamp: now,
            task,
          });
        }

        this.prevTaskStates.set(taskId, currentStatus);
      }

      // Emit change events for detected transitions
      for (const change of changes) {
        await this.handleStateChange(change);
      }
    } catch (err) {
      console.error("[dispatch] Error processing file change:", err);
    }
  }

  /**
   * Stop the dispatch engine gracefully.
   *
   * Sends cancel signals to all active invocations and waits for them to finish.
   * AC: @agent-dispatch-engine ac-11
   */
  async stop(): Promise<void> {
    this.running = false;

    // AC: @agent-dispatch-engine ac-20 - Stop periodic reconciliation
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    // AC: @agent-dispatch-engine ac-11 - Send graceful cancel to all active invocations
    for (const controller of this.invocationAbortControllers) {
      controller.abort();
    }

    // Wait for all running invocations to complete (or abort)
    if (this.runningInvocations.size > 0) {
      await Promise.allSettled(Array.from(this.runningInvocations));
    }

    this.queues.clear();
    this.activeCount.clear();
    this.recentEvents.clear();
    this.invocationAbortControllers.clear();
    this.activeInvocationDetails.clear();
  }

  /**
   * Get the shadow mutex for external callers that need to serialize mutations.
   * AC: @agent-dispatch-engine ac-12
   */
  getShadowMutex(): Mutex {
    return this.shadowMutex;
  }

  getCwd(): string {
    return this.cwd;
  }

  /**
   * Returns current engine status info including per-invocation details.
   * AC: @cli-agent-commands ac-6
   */
  getStatus(): {
    running: boolean;
    activeInvocations: number;
    queuedInvocations: number;
    invocations: Array<{
      invocationId: string;
      sessionId: string;
      agentId: string;
      agentName: string;
      taskRef: string | undefined;
      elapsedMs: number;
    }>;
    queued: Array<{
      agentId: string;
      agentName: string;
      taskRef: string | undefined;
      waitMs: number;
    }>;
  } {
    let active = 0;
    let queued = 0;
    for (const count of this.activeCount.values()) active += count;
    for (const entries of this.queues.values()) queued += entries.length;
    const now = Date.now();
    const invocations = Array.from(this.activeInvocationDetails.values()).map((r) => ({
      invocationId: r.invocationId,
      sessionId: r.sessionId,
      agentId: r.agentId,
      agentName: r.agentName,
      taskRef: r.taskRef,
      elapsedMs: now - r.startedAtMs,
    }));
    const queuedItems = Array.from(this.queues.values()).flatMap((entries) =>
      entries.map((e) => ({
        agentId: e.agent.id,
        agentName: e.agent.name,
        taskRef: e.change.taskRef,
        waitMs: now - e.enqueuedAtMs,
      })),
    );
    return { running: this.running, activeInvocations: active, queuedInvocations: queued, invocations, queued: queuedItems };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Bootstrap: evaluate all current tasks against dispatch rules.
   * AC: @agent-dispatch-engine ac-8
   */
  private async _bootstrap(): Promise<void> {
    try {
      const enqueued = await this._evaluateAllTasks({ skipIfActive: false });
      if (enqueued > 0) {
        const agents = await this._loadAgents();
        await this._drainQueues(agents);
      }
    } catch (err) {
      console.error("[dispatch] Bootstrap error:", err);
    }
  }

  /**
   * Periodic reconciliation: re-evaluate all task states against dispatch rules.
   * Enqueues tasks that match but have no active or queued invocation.
   * AC: @agent-dispatch-engine ac-19
   */
  private async _reconcile(): Promise<void> {
    const enqueued = await this._evaluateAllTasks({ skipIfActive: true });
    if (enqueued > 0) {
      console.log(`[dispatch] Reconciliation enqueued ${enqueued} task(s)`);
      const agents = await this._loadAgents();
      await this._drainQueues(agents);
    }
  }

  /**
   * Shared logic for bootstrap and reconciliation: load all tasks, seed
   * prevTaskStates, and enqueue tasks matching agent dispatch rules.
   *
   * When skipIfActive is true (reconciliation), tasks with an existing
   * active or queued invocation are skipped.
   *
   * AC: @agent-dispatch-engine ac-8, ac-19
   */
  private async _evaluateAllTasks(opts: { skipIfActive: boolean }): Promise<number> {
    const ctx = await initContext(this.projectDir);
    const tasks = await loadAllTasks(ctx);
    const agents = await this._loadAgents();
    const now = Date.now();
    let enqueued = 0;

    // Seed/update prevTaskStates so file watcher diffs work correctly
    for (const task of tasks) {
      this.prevTaskStates.set(task._ulid, task.status as TaskStatus);
    }

    for (const task of tasks) {
      const currentStatus = task.status as TaskStatus;
      const eventType = STATUS_TO_EVENT[currentStatus];
      if (!eventType) continue;

      for (const agent of agents) {
        for (const rule of (agent.dispatch ?? [])) {
          if (rule.on !== eventType) continue;

          const change: TaskStateChange = {
            taskId: task._ulid,
            taskRef: `@${task._ulid}`,
            fromStatus: currentStatus,
            toStatus: currentStatus,
            timestamp: now,
            task,
          };

          if (!this._matchesFilter(change, rule, task, tasks)) continue;
          if (opts.skipIfActive && this._hasActiveOrQueuedInvocation(agent.id, task._ulid)) continue;

          this._enqueue(agent, change);
          enqueued++;
        }
      }
    }

    return enqueued;
  }

  /**
   * Check if an agent already has an active or queued invocation for a task.
   * AC: @agent-dispatch-engine ac-19
   */
  private _hasActiveOrQueuedInvocation(agentId: string, taskId: string): boolean {
    // Check active invocations
    for (const record of this.activeInvocationDetails.values()) {
      if (record.agentId === agentId && record.taskRef === `@${taskId}`) {
        return true;
      }
    }
    // Check queued entries
    const queue = this.queues.get(agentId) ?? [];
    return queue.some((entry) => entry.change.taskId === taskId);
  }

  /**
   * Load agent definitions from meta context.
   */
  private async _loadAgents(): Promise<LoadedAgent[]> {
    try {
      const ctx = await initContext(this.projectDir);
      const meta = await loadMetaContext(ctx);
      return meta.agents;
    } catch {
      return [];
    }
  }

  /**
   * Check if a state change matches a dispatch rule's filters.
   * Base readiness (deps, blocked_by) is checked before consumer filters
   * per @trait-task-readiness ac-composable.
   *
   * AC: @agent-dispatch-engine ac-6
   * AC: @agent-dispatch-engine ac-21
   * AC: @trait-task-readiness ac-deps
   * AC: @trait-task-readiness ac-not-blocked
   * AC: @trait-task-readiness ac-composable
   */
  private _matchesFilter(
    change: TaskStateChange,
    rule: AgentDispatchRule,
    task?: LoadedTask,
    allTasks?: LoadedTask[],
  ): boolean {
    // AC: @agent-dispatch-engine ac-21 — default to automation: eligible for
    // task.ready and task.needs_work when no filter is specified
    const defaultsToEligible =
      rule.on === "task.ready" || rule.on === "task.needs_work";
    if (!rule.filter && !defaultsToEligible) return true;

    // We need the task to evaluate filters — if not provided, reject to avoid
    // enqueuing non-matching tasks (AC-6: all filters must match)
    if (!task) return false;

    // AC: @trait-task-readiness ac-not-blocked — blocked_by must be empty
    if (defaultsToEligible && (task.blocked_by ?? []).length > 0) {
      return false;
    }

    // AC: @trait-task-readiness ac-deps — all depends_on must be completed
    if (defaultsToEligible && allTasks && (task.depends_on ?? []).length > 0) {
      if (!areDependenciesMet(task, allTasks)) {
        return false;
      }
    }

    // AC: @trait-task-readiness ac-composable — consumer filters applied after base readiness
    const filter: AgentDispatchFilter = rule.filter ?? {};

    // Apply default automation filter for task.ready/task.needs_work
    const effectiveAutomation =
      filter.automation ?? (defaultsToEligible ? "eligible" : undefined);

    // Automation filter
    if (effectiveAutomation !== undefined) {
      if ((task as LoadedTask & { automation?: string }).automation !== effectiveAutomation) {
        return false;
      }
    }

    // Tags filter
    if (filter.tags && filter.tags.length > 0) {
      const taskTags: string[] = (task as LoadedTask & { tags?: string[] }).tags ?? [];
      if (!filter.tags.every((tag) => taskTags.includes(tag))) {
        return false;
      }
    }

    // Priority filter — threshold semantics: task priority at or above (numerically <=)
    // AC: @ui-agent-dispatch ac-8
    if (filter.priority !== undefined) {
      const taskPriority = (task as LoadedTask & { priority?: number }).priority;
      if (taskPriority === undefined || taskPriority > filter.priority) {
        return false;
      }
    }

    return true;
  }

  /**
   * Build a deduplication key for a state change.
   * AC: @agent-dispatch-engine ac-7
   */
  private _dedupKey(change: TaskStateChange): DedupKey {
    return `${change.taskId}:${change.fromStatus}:${change.toStatus}`;
  }

  /**
   * Check whether this event is a duplicate within the dedup window.
   * AC: @agent-dispatch-engine ac-7
   */
  private _isDuplicate(change: TaskStateChange): boolean {
    const key = this._dedupKey(change);
    const expiry = this.recentEvents.get(key);
    if (expiry === undefined) return false;
    return change.timestamp < expiry;
  }

  /**
   * Record a state change for deduplication.
   * AC: @agent-dispatch-engine ac-7
   */
  private _recordEvent(change: TaskStateChange): void {
    const key = this._dedupKey(change);
    this.recentEvents.set(key, change.timestamp + this.dedupWindowMs);

    // Prune expired entries periodically
    if (this.recentEvents.size > 1000) {
      const now = Date.now();
      for (const [k, expiry] of this.recentEvents) {
        if (expiry < now) this.recentEvents.delete(k);
      }
    }
  }

  /**
   * Enqueue a dispatch entry for an agent.
   * AC: @agent-dispatch-engine ac-3
   */
  private _enqueue(agent: LoadedAgent, change: TaskStateChange): void {
    const queue = this.queues.get(agent.id) ?? [];
    const entry: QueueEntry = {
      agent,
      change,
      retryCount: 0,
      nextRetryAt: 0,
      enqueuedAtMs: Date.now(),
      sequence: this.nextQueueSequence++,
    };
    this._insertQueueEntry(queue, entry);
    this.queues.set(agent.id, queue);
  }

  /**
   * Insert an entry into an agent queue using deterministic status precedence.
   * AC: @dispatch-in-progress-priority ac-1
   */
  private _insertQueueEntry(queue: QueueEntry[], entry: QueueEntry): void {
    const insertAt = queue.findIndex((queued) => this._compareQueueEntries(entry, queued) < 0);
    if (insertAt === -1) {
      queue.push(entry);
      return;
    }
    queue.splice(insertAt, 0, entry);
  }

  /**
   * Compare queue entries by dispatch precedence, then by enqueue sequence.
   * AC: @dispatch-in-progress-priority ac-1
   */
  private _compareQueueEntries(a: QueueEntry, b: QueueEntry): number {
    const statusDelta = STATUS_PRECEDENCE[a.change.toStatus] - STATUS_PRECEDENCE[b.change.toStatus];
    if (statusDelta !== 0) return statusDelta;
    return a.sequence - b.sequence;
  }

  /**
   * Drain queues, spawning invocations up to each agent's max_concurrent limit.
   * AC: @agent-dispatch-engine ac-3, ac-17
   */
  private async _drainQueues(agents: LoadedAgent[]): Promise<void> {
    // Prevent new invocation starts during/after shutdown.
    if (!this.running) return;

    // AC: @agent-dispatch-engine ac-17 - Load current tasks once for staleness + readiness checks
    let currentTasks: LoadedTask[] | undefined;
    let currentTaskStates: Map<string, TaskStatus> | undefined;
    try {
      const ctx = await initContext(this.projectDir);
      currentTasks = await loadAllTasks(ctx);
      currentTaskStates = new Map(
        currentTasks.map((t) => [t._ulid, t.status as TaskStatus]),
      );
    } catch {
      // If we can't load tasks, skip staleness checks (best effort)
    }

    for (const agent of agents) {
      const maxConcurrent = agent.concurrency?.max_concurrent ?? 1;
      const active = this.activeCount.get(agent.id) ?? 0;
      const queue = this.queues.get(agent.id) ?? [];

      // AC: @agent-dispatch-engine ac-17 - Discard stale entries before spawning.
      // Only discard when we have positive evidence the task moved: either the task
      // exists on disk with a different status, or the task was previously tracked
      // (in prevTaskStates) but is no longer found (deleted).
      if (currentTaskStates) {
        const before = queue.length;
        for (let i = queue.length - 1; i >= 0; i--) {
          const entry = queue[i];
          const currentStatus = currentTaskStates.get(entry.change.taskId);
          const expectedEvent = STATUS_TO_EVENT[entry.change.toStatus];
          if (!expectedEvent) continue; // No event mapping — skip check
          if (currentStatus === undefined) {
            // Task not on disk — only discard if we previously knew about it
            // (it was deleted). Tasks from pure handleStateChange events without
            // on-disk presence should still be processed.
            if (this.prevTaskStates.has(entry.change.taskId)) {
              queue.splice(i, 1);
            }
          } else {
            const currentEvent = STATUS_TO_EVENT[currentStatus];
            if (currentEvent !== expectedEvent) {
              queue.splice(i, 1);
            }
          }
        }
        if (before > queue.length) {
          console.log(
            `[dispatch] Discarded ${before - queue.length} stale queue entries for agent "${agent.id}"`,
          );
        }
      }

      // AC: @trait-task-readiness ac-deps, ac-not-blocked — discard entries
      // where deps are no longer met or task became blocked since enqueue
      if (currentTasks) {
        for (let i = queue.length - 1; i >= 0; i--) {
          const entry = queue[i];
          const eventType = STATUS_TO_EVENT[entry.change.toStatus];
          if (eventType !== "task.ready" && eventType !== "task.needs_work") continue;
          const task = currentTasks.find((t) => t._ulid === entry.change.taskId);
          if (!task) continue; // already handled by staleness check above
          if (task.blocked_by.length > 0 || !areDependenciesMet(task, currentTasks)) {
            queue.splice(i, 1);
          }
        }
      }

      let slots = maxConcurrent - active;
      while (slots > 0 && queue.length > 0) {
        const now = Date.now();
        const nextReadyIndex = queue.findIndex((entry) => entry.nextRetryAt <= now);
        if (nextReadyIndex === -1) {
          break;
        }
        const [entry] = queue.splice(nextReadyIndex, 1);
        const spawned = await this._spawnInvocation(agent, entry);
        if (spawned) slots--;
      }

      this.queues.set(agent.id, queue);
    }
  }

  /**
   * Build dispatch-mode prompt guardrails to keep autonomous agents from
   * stopping with handoff text instead of performing required actions.
   *
   * AC: @agent-dispatch-engine ac-13, ac-14, ac-15, ac-16
   */
  private _buildDispatchPrompt(agent: LoadedAgent, change: TaskStateChange): string {
    const trigger = (STATUS_TO_EVENT[change.toStatus] ?? "task.ready") as SessionTrigger;
    const taskRef = change.taskRef;

    // AC: @agent-dispatch-engine ac-16 - Interpolate prompt_template variables
    const templateVars: Record<string, string> = {
      task_ref: taskRef,
      task_title: change.task?.title ?? "(unavailable)",
      trigger,
      review_url: change.task?.review_url ?? "",
    };
    const rawTemplate = agent.prompt_template ?? `Work on task ${taskRef}`;
    const basePrompt = interpolateTemplate(rawTemplate, templateVars);

    // AC: @agent-dispatch-engine ac-13 - Orientation context
    const orientation = buildOrientationContext(taskRef, trigger, change.task);

    const autonomousPreamble = [
      "AUTONOMOUS DISPATCH MODE (no interactive user is available).",
      "- Do not ask for confirmation, approval, or next-step handoff.",
      "- Execute required commands directly in this invocation.",
      "- Do not end your turn with a recommendations-only summary. Perform the next required action yourself.",
      "- Do not end your turn until the expected task transition is complete, or you have explicitly blocked the task with `kspec task block <task> --reason \"...\"`.",
      "- If you find an open PR/branch from a different task, create or switch to a dedicated branch for this task before committing to avoid PR conflation.",
    ];

    const triggerSpecific =
      trigger === "task.pending_review"
        ? [
            `Review flow completion criteria for ${taskRef}:`,
            "- Execute your configured review workflow directly (no handoff).",
            `- If blocking issues are found, transition ${taskRef} out of pending_review appropriately (for example needs_work).`,
            `- If review gates are clean, perform your workflow's completion actions directly in this invocation.`,
          ]
        : [
            `Work flow completion criteria for ${taskRef}:`,
            "- Execute your configured work workflow directly (no handoff).",
            `- Perform the required commands to move ${taskRef} to the next appropriate state in this same invocation.`,
            "- If your workflow includes git or PR steps, execute them directly instead of deferring to a human.",
          ];

    return `${basePrompt}\n\n${orientation}\n\n${autonomousPreamble.join("\n")}\n\n${triggerSpecific.join("\n")}`;
  }

  /**
   * Spawn a single invocation for a queue entry.
   * Returns true if an invocation was actually started, false if skipped.
   * AC: @agent-dispatch-engine ac-9, ac-10, ac-11, ac-12
   */
  private async _spawnInvocation(agent: LoadedAgent, entry: QueueEntry): Promise<boolean> {
    const agentId = agent.id;
    let workspace: Awaited<ReturnType<typeof provisionDispatchWorkspace>>;
    try {
      workspace = await provisionDispatchWorkspace({
        projectDir: this.projectDir,
        taskRef: entry.change.taskRef,
        task: entry.change.task
          ? {
              title: entry.change.task.title,
              slugs: entry.change.task.slugs,
            }
          : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const guidance = err instanceof DispatchWorkspaceError ? err.suggestion : "Inspect dispatch workspace configuration and git worktree state.";
      console.error(
        `[dispatch] Failed to provision workspace for ${entry.change.taskRef}: ${message}`,
      );
      if (this.kspecCliPath) {
        spawnSync(process.execPath, [
          this.kspecCliPath,
          "task", "note", entry.change.taskRef,
          `[DISPATCH-WORKSPACE] ${message} Suggested action: ${guidance}`,
        ], { cwd: this.cwd });
      }
      return false;
    }

    // Increment active count
    this.activeCount.set(agentId, (this.activeCount.get(agentId) ?? 0) + 1);

    // AC: @agent-dispatch-engine ac-10 - Check adapter resolvability before spawn
    const adapterId = agent.adapter ?? "claude-agent-acp";
    const adapter = getAdapter(adapterId);
    if (!adapter) {
      console.error(
        `[dispatch] Cannot resolve adapter "${adapterId}" for agent "${agentId}". Skipping invocation.`,
      );
      // Decrement active count since we're not actually running
      const currentActive = this.activeCount.get(agentId) ?? 1;
      this.activeCount.set(agentId, Math.max(0, currentActive - 1));
      // AC: @agent-dispatch-engine ac-10 - Add task note for unresolvable adapter
      if (this.kspecCliPath) {
        spawnSync(process.execPath, [
          this.kspecCliPath,
          "task", "note", entry.change.taskRef,
          `[AGENT-SKIP] Cannot resolve adapter "${adapterId}" for agent "${agentId}". Invocation skipped.`,
        ], { cwd: this.cwd });
      }
      return false;
    }

    // AC: @agent-dispatch-engine ac-11 - Create abort controller for graceful cancellation
    const abortController = new AbortController();
    this.invocationAbortControllers.add(abortController);

    // AC: @cli-agent-commands ac-6 - Pre-assign session ID for status tracking
    const preSessionId = ulid();
    const invocationId = ulid();
    const trackingRecord: ActiveInvocationRecord = {
      invocationId,
      sessionId: preSessionId,
      agentId,
      agentName: agent.name,
      taskRef: entry.change.taskRef,
      startedAtMs: Date.now(),
    };
    this.activeInvocationDetails.set(invocationId, trackingRecord);

    // AC: @daemon-agent-dispatch ac-3, ac-4 - Emit started event
    this.onInvocationEvent?.({
      type: "started",
      session_id: preSessionId,
      agent_id: agentId,
      task_id: entry.change.taskRef,
      status: "started",
      timestamp: Date.now(),
    });

    // AC: @cli-agent-commands ac-13, @daemon-agent-dispatch ac-8 - stream text chunks to watchers
    const taskId = entry.change.taskRef ?? null;
    const onUpdate = this.onTextChunk
      ? (update: import("../acp/index.js").SessionUpdate) => {
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content.type === "text"
          ) {
            this.onTextChunk!(preSessionId, agentId, taskId, update.content.text);
            return;
          }
          // Non-text updates (especially tool events) delimit logical message runs.
          // Emit an empty sentinel so watch renderers can end the current line
          // without needing to infer boundaries from prose punctuation.
          this.onTextChunk!(preSessionId, agentId, taskId, "");
        }
      : undefined;

    const options: InvocationOptions = {
      agent,
      specDir: this.specDir,
      sessionsDir: path.join(this.projectDir, ".kspec-sessions"),
      cwd: workspace.cwd,
      taskRef: entry.change.taskRef,
      prompt: this._buildDispatchPrompt(agent, entry.change),
      trigger: (STATUS_TO_EVENT[entry.change.toStatus] ?? "task.ready") as SessionTrigger,
      kspecCliPath: this.kspecCliPath,
      abortSignal: abortController.signal,
      sessionId: preSessionId,
      env: {
        KSPEC_DISPATCH_BASE_BRANCH: workspace.metadata.baseBranch,
        KSPEC_DISPATCH_MERGE_TARGET: workspace.metadata.mergeTargetBranch,
        KSPEC_DISPATCH_CANONICAL_BRANCH: workspace.metadata.canonicalBranch,
        KSPEC_DISPATCH_WORKTREE_ROOT: workspace.metadata.worktreeRoot,
        KSPEC_DISPATCH_WORKSPACE_FILE: workspace.metadataPath,
      },
      onUpdate,
    };

    // AC: @agent-dispatch-engine ac-12 - Wrap invocation in shadow mutex
    const invocationPromise = this.shadowMutex
      .runExclusive(async () => {
        // AC: @agent-dispatch-engine ac-9 - Retry on transient errors
        try {
          await runInvocation(options);
          // Reset retry count on success
          entry.retryCount = 0;
          // AC: @daemon-agent-dispatch ac-3, ac-4 - Emit completed event
          this.onInvocationEvent?.({
            type: "completed",
            session_id: preSessionId,
            agent_id: agentId,
            task_id: entry.change.taskRef,
            status: "completed",
            timestamp: Date.now(),
          });
        } catch (err) {
          const retryLimit = agent.budget?.max_retries ?? 3;
          if (entry.retryCount < retryLimit) {
            entry.retryCount++;
            const backoffMs = Math.min(
              1000 * Math.pow(2, entry.retryCount - 1),
              30_000,
            );
            entry.nextRetryAt = Date.now() + backoffMs;
            console.warn(
              `[dispatch] Invocation for agent "${agentId}" failed (attempt ${entry.retryCount}/${retryLimit}), retrying in ${backoffMs}ms`,
              err,
            );
            // Re-enqueue for retry while preserving status precedence ordering.
            const queue = this.queues.get(agentId) ?? [];
            this._insertQueueEntry(queue, entry);
            this.queues.set(agentId, queue);
            // AC: @agent-dispatch-engine ac-9 - Schedule wake-up to drain retry
            setTimeout(() => {
              if (this.running) {
                this._loadAgents()
                  .then((agents) => this._drainQueues(agents))
                  .catch(() => {/* best effort */});
              }
            }, backoffMs);
          } else {
            console.error(
              `[dispatch] Agent "${agentId}" exceeded retry limit. Dropping invocation.`,
              err,
            );
            // AC: @daemon-agent-dispatch ac-3, ac-4 - Emit failed event when retry limit exceeded
            this.onInvocationEvent?.({
              type: "failed",
              session_id: preSessionId,
              agent_id: agentId,
              task_id: entry.change.taskRef,
              status: "failed",
              timestamp: Date.now(),
            });
          }
        }

        // Clean up active tracking immediately while still holding the mutex,
        // BEFORE _drainQueues can spawn the next invocation. This prevents
        // completed invocations from appearing active in the fleet status
        // while the next invocation runs.
        const currentActive = this.activeCount.get(agentId) ?? 1;
        this.activeCount.set(agentId, Math.max(0, currentActive - 1));
        this.activeInvocationDetails.delete(invocationId);
      })
      .then(async () => {
        if (!this.running) return;

        // AC: @agent-dispatch-engine ac-23, ac-24
        // Re-evaluate all tasks from disk so the drain loop sees tasks that
        // reached a dispatchable state during the prior invocation (e.g.
        // pending_review tasks submitted by a worker).
        try {
          await this._evaluateAllTasks({ skipIfActive: true });
        } catch (err) {
          // AC: @agent-dispatch-engine ac-25
          console.warn(
            "[dispatch] Post-invocation re-evaluation failed, proceeding with existing queue:",
            err,
          );
        }

        // Drain queues with current state
        try {
          const agents = await this._loadAgents();
          await this._drainQueues(agents);
        } catch {
          // Best effort drain
        }
      })
      .finally(() => {
        this.runningInvocations.delete(invocationPromise);
        this.invocationAbortControllers.delete(abortController);
      });

    this.runningInvocations.add(invocationPromise);
    return true;
  }
}
