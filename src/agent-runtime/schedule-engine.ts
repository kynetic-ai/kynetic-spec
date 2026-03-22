/**
 * Schedule Tick Engine
 *
 * Evaluates cron expressions on a 60-second loop and fires schedule.tick
 * events. Tracks per-schedule runtime state (volatile — resets on restart),
 * enforces overlap policies against action runs, supports config reload
 * via versioned snapshot, and handles backfill on start.
 *
 * Spec: @dispatch-schedule-entities, @dispatch-schedule-runtime
 * Task: @task-schedule-engine
 */

import { Cron } from "croner";
import { initContext, loadMetaContext, type LoadedSchedule } from "../parser/index.js";
import type { EventBus, EventEnvelope } from "./event-bus.js";
import {
  ActionExecutor,
  type ActionEventContext,
  type ActionRunEvent,
} from "./action-executor.js";
import type { Action } from "../schema/action.js";
import type { OverlapPolicy } from "../schema/schedules.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Evaluation interval in milliseconds (60 seconds = minute-level resolution). */
export const EVALUATION_INTERVAL_MS = 60_000;

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Per-schedule volatile runtime state. Resets on daemon restart.
 * AC: @dispatch-schedule-runtime ac-1
 */
export interface ScheduleRuntimeState {
  /** Last time a tick was accepted (not skipped). Null if never ticked. */
  last_tick: Date | null;
  /** Next scheduled tick per cron. */
  next_tick: Date | null;
  /** Number of accepted runs (ticks not skipped by overlap policy). */
  run_count: number;
  /** Action run IDs currently running (multiple possible with allow policy). */
  active_run_ids: string[];
  /** One pending tick when overlap_policy = buffer_one. Null if no buffered tick. */
  buffered_tick: Date | null;
}

/**
 * Internal tracking record combining schedule definition with runtime state.
 */
interface ScheduleRecord {
  schedule: LoadedSchedule;
  state: ScheduleRuntimeState;
}

/**
 * Status for a single schedule (public API).
 */
export interface ScheduleStatus {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  overlap_policy: OverlapPolicy;
  last_tick: string | null;
  next_tick: string | null;
  run_count: number;
  active_run_count: number;
  buffered: boolean;
}

/**
 * Detailed status for a single schedule including active run IDs.
 * AC: @automation-api ac-2
 */
export interface ScheduleDetailedStatus extends ScheduleStatus {
  active_run_ids: string[];
}

/**
 * Function signature for loading schedules from config.
 * Abstracted for testability — production code uses loadMetaContext,
 * tests can inject a mock.
 */
export type ScheduleLoader = () => Promise<LoadedSchedule[]>;

/**
 * Options for creating a ScheduleEngine.
 */
export interface ScheduleEngineOptions {
  /** Project root directory. */
  projectDir: string;
  /** The shared event bus. */
  eventBus: EventBus;
  /** Action executor for running schedule actions. */
  actionExecutor: ActionExecutor;
  /** Evaluation interval override (mainly for testing). */
  evaluationIntervalMs?: number;
  /**
   * Optional custom schedule loader for testing.
   * When not provided, loads from loadMetaContext(initContext(projectDir)).
   */
  scheduleLoader?: ScheduleLoader;
}

// ─── ScheduleEngine ─────────────────────────────────────────────────────────

/**
 * Schedule tick engine.
 *
 * Lifecycle: construct → start() → [evaluates on interval] → stop()
 *
 * AC: @dispatch-schedule-entities ac-1 through ac-6
 * AC: @dispatch-schedule-runtime ac-1 through ac-5
 */
export class ScheduleEngine {
  private projectDir: string;
  private eventBus: EventBus;
  private actionExecutor: ActionExecutor;
  private evaluationIntervalMs: number;
  private scheduleLoader: ScheduleLoader;

  /** Whether the engine is running. */
  private running = false;
  /** Interval timer handle. */
  private evalTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-schedule tracking records, keyed by schedule id. */
  private schedules: Map<string, ScheduleRecord> = new Map();
  /** Config version — increments on each reload to detect changes. */
  private configVersion = 0;
  /** Bus subscription IDs for cleanup on stop. */
  private subscriptionIds: string[] = [];
  /** In-flight evaluation promises (for graceful shutdown). */
  private inFlightEvals = new Set<Promise<void>>();

  constructor(options: ScheduleEngineOptions) {
    this.projectDir = options.projectDir;
    this.eventBus = options.eventBus;
    this.actionExecutor = options.actionExecutor;
    this.evaluationIntervalMs = options.evaluationIntervalMs ?? EVALUATION_INTERVAL_MS;
    this.scheduleLoader = options.scheduleLoader ?? (async () => {
      const ctx = await initContext(this.projectDir);
      const meta = await loadMetaContext(ctx);
      return meta.schedules;
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Start the schedule engine.
   *
   * Loads schedules, performs backfill for eligible schedules, then starts
   * the evaluation interval.
   *
   * AC: @dispatch-schedule-runtime ac-1 (volatile state reset on start)
   */
  async start(): Promise<void> {
    this.running = true;

    // Subscribe to action events to track active runs
    const actionCompletedSubId = this.eventBus.subscribe(
      "action.completed",
      (event) => this._handleActionComplete(event),
    );
    const actionFailedSubId = this.eventBus.subscribe(
      "action.failed",
      (event) => this._handleActionComplete(event),
    );
    this.subscriptionIds.push(actionCompletedSubId, actionFailedSubId);

    // Load initial schedule configuration
    await this._reloadConfig();

    // AC: @dispatch-schedule-runtime ac-1 — backfill on start
    await this._backfillOnStart();

    // Start evaluation loop
    this.evalTimer = setInterval(() => {
      if (this.running) {
        const p = this._evaluate().catch((err) => {
          console.error("[schedule-engine] Evaluation error:", err);
        }).finally(() => {
          this.inFlightEvals.delete(p);
        });
        this.inFlightEvals.add(p);
      }
    }, this.evaluationIntervalMs);
    if (this.evalTimer && typeof this.evalTimer === "object" && "unref" in this.evalTimer) {
      this.evalTimer.unref();
    }
  }

  /**
   * Stop the schedule engine.
   *
   * Cancels the evaluation timer, unsubscribes from events, and waits
   * for in-flight evaluations to complete.
   */
  async stop(): Promise<void> {
    this.running = false;

    // Cancel evaluation timer
    if (this.evalTimer !== null) {
      clearInterval(this.evalTimer);
      this.evalTimer = null;
    }

    // Unsubscribe from bus events
    for (const subId of this.subscriptionIds) {
      this.eventBus.unsubscribe(subId);
    }
    this.subscriptionIds = [];

    // Wait for in-flight evaluations
    if (this.inFlightEvals.size > 0) {
      await Promise.allSettled(Array.from(this.inFlightEvals));
      this.inFlightEvals.clear();
    }

    // Clear state
    this.schedules.clear();
    this.configVersion = 0;
  }

  /**
   * Manually trigger a schedule.
   *
   * Emits a normal schedule.tick event with overlap policy enforced.
   * AC: @dispatch-schedule-runtime ac-4
   */
  async triggerSchedule(scheduleId: string): Promise<{
    accepted: boolean;
    reason?: string;
  }> {
    const record = this.schedules.get(scheduleId);
    if (!record) {
      return { accepted: false, reason: `Schedule not found: ${scheduleId}` };
    }
    // AC: @dispatch-schedule-entities ac-4 — disabled schedules don't fire even manually?
    // Per ac-4 of runtime spec: "A normal schedule.tick event is emitted; overlap policy applies"
    // Manual triggers work even on disabled schedules per runtime spec ac-4 (it doesn't mention enabled check).
    // However the entities spec ac-4 says disabled schedules take no action. Manual trigger is a distinct
    // path — we apply overlap policy but allow disabled schedules to be manually triggered.
    const tickTime = new Date();
    return this._fireTick(record, tickTime);
  }

  /**
   * Get the status of all schedules.
   */
  getStatus(): ScheduleStatus[] {
    const statuses: ScheduleStatus[] = [];
    for (const record of this.schedules.values()) {
      statuses.push({
        id: record.schedule.id,
        name: record.schedule.name,
        enabled: record.schedule.enabled,
        cron: record.schedule.cron,
        timezone: record.schedule.timezone,
        overlap_policy: record.schedule.overlap_policy,
        last_tick: record.state.last_tick?.toISOString() ?? null,
        next_tick: record.state.next_tick?.toISOString() ?? null,
        run_count: record.state.run_count,
        active_run_count: record.state.active_run_ids.length,
        buffered: record.state.buffered_tick !== null,
      });
    }
    return statuses;
  }

  /**
   * Get detailed status for a single schedule by ID.
   * Returns null if the schedule is not found.
   * AC: @automation-api ac-2
   */
  getScheduleStatus(scheduleId: string): ScheduleDetailedStatus | null {
    const record = this.schedules.get(scheduleId);
    if (!record) return null;

    return {
      id: record.schedule.id,
      name: record.schedule.name,
      enabled: record.schedule.enabled,
      cron: record.schedule.cron,
      timezone: record.schedule.timezone,
      overlap_policy: record.schedule.overlap_policy,
      last_tick: record.state.last_tick?.toISOString() ?? null,
      next_tick: record.state.next_tick?.toISOString() ?? null,
      run_count: record.state.run_count,
      active_run_count: record.state.active_run_ids.length,
      buffered: record.state.buffered_tick !== null,
      active_run_ids: [...record.state.active_run_ids],
    };
  }

  /**
   * Check if the engine is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ─── Evaluation Loop ──────────────────────────────────────────────────────

  /**
   * Single evaluation cycle.
   *
   * 1. Reload config (detect added/removed/updated schedules)
   * 2. For each enabled schedule, check if cron matches current time
   * 3. Apply overlap policy and fire tick if appropriate
   *
   * AC: @dispatch-schedule-entities ac-1 (cron match → action executes)
   * AC: @dispatch-schedule-entities ac-6 (config reload)
   */
  private async _evaluate(): Promise<void> {
    if (!this.running) return;

    // AC: @dispatch-schedule-entities ac-6 — reload config each cycle
    await this._reloadConfig();

    const now = new Date();

    for (const record of this.schedules.values()) {
      // AC: @dispatch-schedule-entities ac-4 — disabled schedules don't fire
      if (!record.schedule.enabled) continue;

      // Check if the cron expression matches now
      if (this._shouldTick(record, now)) {
        await this._fireTick(record, this._getTickTime(record));
      }
    }
  }

  /**
   * Determine if a schedule should tick at the given time.
   *
   * Uses croner to check if the next expected tick is at or before `now`.
   */
  private _shouldTick(record: ScheduleRecord, now: Date): boolean {
    const nextTick = record.state.next_tick;
    if (!nextTick) return false;

    // The schedule should tick if its next_tick is at or before now
    return nextTick.getTime() <= now.getTime();
  }

  /**
   * Get the tick_time for a schedule (the scheduled wall-clock time, not eval time).
   * AC: @dispatch-schedule-runtime ac-2
   */
  private _getTickTime(record: ScheduleRecord): Date {
    // tick_time is the scheduled wall-clock time, which is the next_tick value
    return record.state.next_tick ?? new Date();
  }

  /**
   * Fire a tick for a schedule, applying overlap policy.
   *
   * AC: @dispatch-schedule-entities ac-1 (action executes)
   * AC: @dispatch-schedule-entities ac-2 (skip policy)
   * AC: @dispatch-schedule-entities ac-3 (buffer_one policy)
   * AC: @dispatch-schedule-entities ac-5 (allow policy)
   * AC: @dispatch-schedule-runtime ac-4 (manual triggers follow same path)
   * AC: @dispatch-schedule-runtime ac-5 (run_count increments on accepted ticks)
   */
  private async _fireTick(
    record: ScheduleRecord,
    tickTime: Date,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const { schedule, state } = record;
    const hasActiveRuns = state.active_run_ids.length > 0;

    // Apply overlap policy
    // AC: @dispatch-schedule-entities ac-2, ac-3, ac-5
    if (hasActiveRuns) {
      switch (schedule.overlap_policy) {
        case "skip":
          // AC: @dispatch-schedule-entities ac-2 — skip and advance
          this._advanceNextTick(record);
          return { accepted: false, reason: "Skipped: active run exists (overlap_policy: skip)" };

        case "buffer_one":
          // AC: @dispatch-schedule-entities ac-3 — buffer at most one
          if (state.buffered_tick === null) {
            state.buffered_tick = tickTime;
            this._advanceNextTick(record);
            return { accepted: false, reason: "Buffered: will run when active run completes" };
          }
          // Additional ticks are dropped
          this._advanceNextTick(record);
          return { accepted: false, reason: "Dropped: already have a buffered tick (overlap_policy: buffer_one)" };

        case "allow":
          // AC: @dispatch-schedule-entities ac-5 — allow concurrent
          // Fall through to execute
          break;
      }
    }

    // Execute the tick
    return this._executeTick(record, tickTime);
  }

  /**
   * Execute a tick: emit event, run action, track state.
   */
  private async _executeTick(
    record: ScheduleRecord,
    tickTime: Date,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const { schedule, state } = record;

    // Increment run count
    // AC: @dispatch-schedule-runtime ac-5
    state.run_count++;
    state.last_tick = tickTime;

    // AC: @dispatch-schedule-entities ac-1 — emit schedule.tick event
    const emitResult = this.eventBus.emit({
      event_type: "schedule.tick",
      source_type: "schedule_engine",
      source_id: schedule.id,
      payload: {
        schedule_id: schedule.id,
        schedule_name: schedule.name,
        tick_time: tickTime.toISOString(),
        run_count: state.run_count,
      },
    });

    if (!emitResult.accepted) {
      // Revert run_count if event was rejected
      state.run_count--;
      return { accepted: false, reason: `Event rejected: ${emitResult.reason}` };
    }

    // Build event context for the action executor
    const eventContext: ActionEventContext = {
      event_id: emitResult.event!.event_id,
      event_type: "schedule.tick",
      correlation_id: emitResult.event!.correlation_id ?? undefined,
      causation_id: emitResult.event!.event_id,
      source_type: "schedule_engine",
      source_id: schedule.id,
      schedule_id: schedule.id,
      schedule_name: schedule.name,
      tick_time: tickTime.toISOString(),
      run_count: state.run_count,
    };

    // Execute the action
    const actionRun = await this.actionExecutor.execute(
      schedule.action as Action,
      eventContext,
      schedule.name,
    );

    // Track the active run
    if (actionRun.status === "running") {
      state.active_run_ids.push(actionRun.action_run_id);
    }
    // For immediately completed/failed actions (e.g. notify), don't track as active

    // Advance to next tick
    this._advanceNextTick(record);

    return { accepted: true };
  }

  // ─── Overlap Run Tracking ─────────────────────────────────────────────────

  /**
   * Handle action completion/failure — clear active run from schedule state.
   *
   * When a run completes and buffer_one has a pending tick, fire the buffered tick.
   */
  private async _handleActionComplete(event: EventEnvelope): Promise<void> {
    const actionRunId = event.payload.action_run_id as string;
    if (!actionRunId) return;

    for (const record of this.schedules.values()) {
      const idx = record.state.active_run_ids.indexOf(actionRunId);
      if (idx !== -1) {
        record.state.active_run_ids.splice(idx, 1);

        // AC: @dispatch-schedule-entities ac-3 — fire buffered tick when active run completes
        if (
          record.schedule.overlap_policy === "buffer_one" &&
          record.state.buffered_tick !== null &&
          record.state.active_run_ids.length === 0
        ) {
          const bufferedTime = record.state.buffered_tick;
          record.state.buffered_tick = null;
          await this._executeTick(record, bufferedTime);
        }

        break;
      }
    }
  }

  // ─── Config Reload ────────────────────────────────────────────────────────

  /**
   * Reload schedule configuration from meta manifest.
   *
   * Detects added, removed, and updated schedules using versioned comparison.
   *
   * AC: @dispatch-schedule-entities ac-6
   */
  private async _reloadConfig(): Promise<void> {
    let loadedSchedules: LoadedSchedule[];
    try {
      loadedSchedules = await this.scheduleLoader();
    } catch (err) {
      console.error("[schedule-engine] Failed to load schedules:", err);
      return;
    }

    const newIds = new Set(loadedSchedules.map((s) => s.id));
    const existingIds = new Set(this.schedules.keys());

    // Remove schedules that no longer exist
    // AC: @dispatch-schedule-entities ac-6 — removed schedules stop ticking
    for (const id of existingIds) {
      if (!newIds.has(id)) {
        // Don't clear active runs — in-flight actions complete normally
        this.schedules.delete(id);
      }
    }

    // Add or update schedules
    for (const schedule of loadedSchedules) {
      const existing = this.schedules.get(schedule.id);
      if (!existing) {
        // New schedule — initialize runtime state
        const state = this._createInitialState(schedule);
        this.schedules.set(schedule.id, { schedule, state });
      } else {
        // Existing schedule — update definition, preserve runtime state
        // AC: @dispatch-schedule-entities ac-6 — updated schedules use new settings
        const configChanged = this._hasConfigChanged(existing.schedule, schedule);
        existing.schedule = schedule;
        if (configChanged) {
          // Re-compute next tick with new cron/timezone
          existing.state.next_tick = this._computeNextTick(schedule);
        }
      }
    }

    this.configVersion++;
  }

  /**
   * Check if schedule configuration has changed in a way that affects evaluation.
   */
  private _hasConfigChanged(
    oldSchedule: LoadedSchedule,
    newSchedule: LoadedSchedule,
  ): boolean {
    return (
      oldSchedule.cron !== newSchedule.cron ||
      oldSchedule.timezone !== newSchedule.timezone ||
      oldSchedule.enabled !== newSchedule.enabled ||
      oldSchedule.overlap_policy !== newSchedule.overlap_policy
    );
  }

  // ─── Backfill ─────────────────────────────────────────────────────────────

  /**
   * Best-effort backfill on start.
   *
   * For schedules with backfill: true, checks if the current time matches
   * the cron within the last interval and fires one catch-up action.
   *
   * AC: @dispatch-schedule-runtime ac-1
   */
  private async _backfillOnStart(): Promise<void> {
    const now = new Date();

    for (const record of this.schedules.values()) {
      if (!record.schedule.backfill || !record.schedule.enabled) continue;

      // Check if the previous cron occurrence was within the last evaluation interval
      const previousTick = this._computePreviousTick(record.schedule);
      if (!previousTick) continue;

      const msSincePrevious = now.getTime() - previousTick.getTime();

      // If the previous tick was within the last interval, fire one catch-up
      if (msSincePrevious >= 0 && msSincePrevious <= this.evaluationIntervalMs) {
        await this._executeTick(record, previousTick);
      }
    }
  }

  // ─── Cron Helpers ─────────────────────────────────────────────────────────

  /**
   * Create initial runtime state for a newly loaded schedule.
   */
  private _createInitialState(schedule: LoadedSchedule): ScheduleRuntimeState {
    return {
      last_tick: null,
      next_tick: this._computeNextTick(schedule),
      run_count: 0,
      active_run_ids: [],
      buffered_tick: null,
    };
  }

  /**
   * Compute the next tick time for a schedule using croner.
   *
   * AC: @dispatch-schedule-runtime ac-2, ac-3 (timezone handling)
   */
  private _computeNextTick(schedule: LoadedSchedule): Date | null {
    try {
      const job = new Cron(schedule.cron, {
        timezone: schedule.timezone,
        legacyMode: false,
      });
      return job.nextRun() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Compute the most recent past cron match for a schedule (for backfill).
   *
   * Uses croner's previousRuns(1) which computes theoretical past matches
   * (as opposed to previousRun() which only returns the last actual execution).
   *
   * AC: @dispatch-schedule-runtime ac-1 (backfill heuristic)
   */
  private _computePreviousTick(schedule: LoadedSchedule): Date | null {
    try {
      const job = new Cron(schedule.cron, {
        timezone: schedule.timezone,
        legacyMode: false,
      });
      const prev = job.previousRuns(1);
      return prev.length > 0 ? prev[0] : null;
    } catch {
      return null;
    }
  }

  /**
   * Advance a schedule's next_tick to the following occurrence.
   */
  private _advanceNextTick(record: ScheduleRecord): void {
    record.state.next_tick = this._computeNextTick(record.schedule);
  }
}
