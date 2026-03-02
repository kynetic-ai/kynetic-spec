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
import {
  initContext,
  loadAllTasks,
  loadMetaContext,
  type LoadedTask,
  type LoadedAgent,
} from "../parser/index.js";
import { runInvocation } from "./invocation.js";
import type { InvocationOptions } from "./invocation.js";
import { getAdapter } from "../agents/adapters.js";
import type { AgentDispatchRule } from "../schema/meta.js";
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
  "task.ready": "pending",
  "task.needs_work": "needs_work",
  "task.pending_review": "pending_review",
};

const STATUS_TO_EVENT: Record<TaskStatus, string | undefined> = {
  pending: "task.ready",
  needs_work: "task.needs_work",
  pending_review: "task.pending_review",
  in_progress: undefined,
  blocked: undefined,
  completed: undefined,
  cancelled: undefined,
};

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
}

/**
 * Deduplication key for recent state changes.
 * AC: @agent-dispatch-engine ac-7
 */
type DedupKey = `${string}:${string}:${string}`;

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
  /** Path to kspec CLI binary (for task notes) */
  kspecCliPath?: string;
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
  private kspecCliPath?: string;

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

  constructor(options: DispatchEngineOptions) {
    this.projectDir = options.projectDir;
    this.specDir = options.specDir ?? path.join(options.projectDir, ".kspec");
    this.cwd = options.cwd ?? options.projectDir;
    this.dedupWindowMs = options.dedupWindowMs ?? 2000;
    this.kspecCliPath = options.kspecCliPath;
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

    // Load task data for filter evaluation if not provided
    let taskData = change.task;
    if (!taskData && change.taskId) {
      try {
        const ctx = await initContext(this.projectDir);
        const tasks = await loadAllTasks(ctx);
        taskData = tasks.find((t) => t._ulid === change.taskId);
      } catch {
        // Can't load task, filter evaluation will be lenient
      }
    }

    for (const agent of agents) {
      for (const rule of (agent.dispatch ?? [])) {
        if (rule.on !== eventType) continue;

        // AC: @agent-dispatch-engine ac-6 - Apply filters
        if (!this._matchesFilter(change, rule, taskData)) continue;

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
  }

  /**
   * Get the shadow mutex for external callers that need to serialize mutations.
   * AC: @agent-dispatch-engine ac-12
   */
  getShadowMutex(): Mutex {
    return this.shadowMutex;
  }

  /**
   * Returns current engine status info.
   */
  getStatus(): {
    running: boolean;
    activeInvocations: number;
    queuedInvocations: number;
  } {
    let active = 0;
    let queued = 0;
    for (const count of this.activeCount.values()) active += count;
    for (const entries of this.queues.values()) queued += entries.length;
    return { running: this.running, activeInvocations: active, queuedInvocations: queued };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Bootstrap: evaluate all current tasks against dispatch rules.
   * AC: @agent-dispatch-engine ac-8
   */
  private async _bootstrap(): Promise<void> {
    try {
      const ctx = await initContext(this.projectDir);
      const tasks = await loadAllTasks(ctx);
      const agents = await this._loadAgents();
      const now = Date.now();

      // Seed prevTaskStates so subsequent file watcher diffs work correctly
      for (const task of tasks) {
        this.prevTaskStates.set(task._ulid, task.status as TaskStatus);
      }

      // Evaluate each task against each agent's dispatch rules
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
              fromStatus: currentStatus, // bootstrap: treated as "just entered"
              toStatus: currentStatus,
              timestamp: now,
              task,
            };

            if (!this._matchesFilter(change, rule, task)) continue;

            this._enqueue(agent, change);
          }
        }
      }

      await this._drainQueues(agents);
    } catch (err) {
      console.error("[dispatch] Bootstrap error:", err);
    }
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
   * AC: @agent-dispatch-engine ac-6
   */
  private _matchesFilter(
    change: TaskStateChange,
    rule: AgentDispatchRule,
    task?: LoadedTask,
  ): boolean {
    if (!rule.filter) return true;

    // We need the task to evaluate filters — if not provided, reject to avoid
    // enqueuing non-matching tasks (AC-6: all filters must match)
    if (!task) return false;

    const { filter } = rule;

    // Automation filter
    if (filter.automation !== undefined) {
      if ((task as LoadedTask & { automation?: string }).automation !== filter.automation) {
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

    // Priority filter
    if (filter.priority !== undefined) {
      if ((task as LoadedTask & { priority?: number }).priority !== filter.priority) {
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
    queue.push({ agent, change, retryCount: 0, nextRetryAt: 0 });
    this.queues.set(agent.id, queue);
  }

  /**
   * Drain queues, spawning invocations up to each agent's max_concurrent limit.
   * AC: @agent-dispatch-engine ac-3
   */
  private async _drainQueues(agents: LoadedAgent[]): Promise<void> {
    for (const agent of agents) {
      const maxConcurrent = agent.concurrency?.max_concurrent ?? 1;
      const active = this.activeCount.get(agent.id) ?? 0;
      const queue = this.queues.get(agent.id) ?? [];

      let slots = maxConcurrent - active;
      while (slots > 0 && queue.length > 0) {
        const entry = queue.shift()!;
        if (entry.nextRetryAt > Date.now()) {
          // Not ready for retry yet; put back at front
          queue.unshift(entry);
          break;
        }
        this._spawnInvocation(agent, entry);
        slots--;
      }

      this.queues.set(agent.id, queue);
    }
  }

  /**
   * Spawn a single invocation for a queue entry.
   * AC: @agent-dispatch-engine ac-9, ac-10, ac-11, ac-12
   */
  private _spawnInvocation(agent: LoadedAgent, entry: QueueEntry): void {
    const agentId = agent.id;

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
      return;
    }

    // AC: @agent-dispatch-engine ac-11 - Create abort controller for graceful cancellation
    const abortController = new AbortController();
    this.invocationAbortControllers.add(abortController);

    const options: InvocationOptions = {
      agent,
      specDir: this.specDir,
      cwd: this.cwd,
      taskRef: entry.change.taskRef,
      prompt: agent.prompt_template ?? `Work on task ${entry.change.taskRef}`,
      trigger: (STATUS_TO_EVENT[entry.change.toStatus] ?? "task.ready") as SessionTrigger,
      kspecCliPath: this.kspecCliPath,
      abortSignal: abortController.signal,
    };

    // AC: @agent-dispatch-engine ac-12 - Wrap invocation in shadow mutex
    const invocationPromise = this.shadowMutex
      .runExclusive(async () => {
        // AC: @agent-dispatch-engine ac-9 - Retry on transient errors
        try {
          await runInvocation(options);
          // Reset retry count on success
          entry.retryCount = 0;
        } catch (err) {
          const retryLimit = agent.budget?.max_tasks ?? 3;
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
            // Re-enqueue at front for retry
            const queue = this.queues.get(agentId) ?? [];
            queue.unshift(entry);
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
          }
        }
      })
      .then(async () => {
        // Decrement active count and drain again
        const currentActive = this.activeCount.get(agentId) ?? 1;
        this.activeCount.set(agentId, Math.max(0, currentActive - 1));

        // Try to drain more items
        try {
          const agents = await this._loadAgents();
          await this._drainQueues(agents);
        } catch {
          // Best effort
        }
      })
      .finally(() => {
        this.runningInvocations.delete(invocationPromise);
        this.invocationAbortControllers.delete(abortController);
      });

    this.runningInvocations.add(invocationPromise);
  }
}
