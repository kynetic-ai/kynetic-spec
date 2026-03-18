/**
 * Join Accumulator
 *
 * Enables fan-in synthesis by tracking action run completions per composition
 * group. Subscribes to action.completed and action.failed events, tracks
 * completions by group_id, and fires on_complete when the join threshold is
 * met or timeout expires.
 *
 * State is volatile (daemon lifetime) — in-progress groups are lost on
 * daemon restart.
 *
 * Spec: @dispatch-composition-patterns, @dispatch-composition-correlation
 * Task: @task-composition-join
 */

import { ulid } from "ulid";
import type { EventBus, EventEnvelope } from "./event-bus.js";
import type {
  ActionExecutor,
  ActionEventContext,
} from "./action-executor.js";
import type { Composition } from "../schema/composition.js";
import type { ActionRun } from "../schema/action.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Status of an individual action run within a composition group.
 */
export type MemberRunStatus = "completed" | "failed" | "timed_out";

/**
 * Tracking record for a single action run within a composition group.
 */
export interface GroupMemberRun {
  action_run_id: string;
  action_type: string;
  status: MemberRunStatus;
  session_id?: string;
  completed_at: string;
}

/**
 * Runtime state for a single activation of a composition group.
 *
 * AC: @dispatch-composition-correlation ac-1 — each activation has unique
 *     activation_id, tracks members by group_id
 * AC: @dispatch-composition-correlation ac-3 — timeout starts when first
 *     run begins
 * AC: @dispatch-composition-correlation ac-4 — state is volatile
 */
export interface GroupState {
  /** Unique identifier for this activation */
  activation_id: string;
  /** The composition config this activation derives from */
  config_id: string;
  /** Number of successful completions so far */
  completed_count: number;
  /** Number of failed runs */
  failed_count: number;
  /** Tracking records for all member runs */
  members: GroupMemberRun[];
  /** When the first run started (timeout reference point) */
  first_run_at: number | null;
  /** Whether this group has already fired on_complete */
  fired: boolean;
  /** Timeout handle for cleanup */
  timeout_handle: ReturnType<typeof setTimeout> | null;
}

/**
 * Options for creating a JoinAccumulator.
 */
export interface JoinAccumulatorOptions {
  eventBus: EventBus;
  actionExecutor: ActionExecutor;
}

// ─── JoinAccumulator ──────────────────────────────────────────────────────────

/**
 * Tracks action run completions per composition group and fires on_complete
 * when the join threshold is met or timeout expires.
 *
 * AC: @dispatch-composition-patterns ac-2 — on_complete triggered when Nth run finishes
 * AC: @dispatch-composition-patterns ac-3 — on_complete fires with partial results on timeout
 * AC: @dispatch-composition-correlation ac-1 — activation created with unique activation_id
 * AC: @dispatch-composition-correlation ac-2 — only successful runs count toward threshold
 * AC: @dispatch-composition-correlation ac-3 — timeout starts when first run begins
 * AC: @dispatch-composition-correlation ac-4 — state is volatile (daemon lifetime)
 */
export class JoinAccumulator {
  private eventBus: EventBus;
  private actionExecutor: ActionExecutor;

  /** Composition configs indexed by config ID */
  private configs: Map<string, Composition> = new Map();

  /**
   * Runtime state per group_id.
   * Map<group_id, GroupState>
   */
  private groups: Map<string, GroupState> = new Map();

  /** Event bus subscription IDs for cleanup */
  private subscriptionIds: string[] = [];

  constructor(options: JoinAccumulatorOptions) {
    this.eventBus = options.eventBus;
    this.actionExecutor = options.actionExecutor;
  }

  /**
   * Load composition configs and subscribe to events.
   * Call this after constructing the accumulator.
   */
  start(compositions: Composition[]): void {
    this.configs.clear();
    for (const comp of compositions) {
      if (comp.enabled) {
        this.configs.set(comp.id, comp);
      }
    }

    // Subscribe to action.completed and action.failed events
    const completedSubId = this.eventBus.subscribe(
      "action.completed",
      (event) => this.handleActionEvent(event),
    );
    const failedSubId = this.eventBus.subscribe(
      "action.failed",
      (event) => this.handleActionEvent(event),
    );
    this.subscriptionIds.push(completedSubId, failedSubId);
  }

  /**
   * Stop the accumulator, unsubscribe from events, and clear all state.
   * Outstanding timeouts are cancelled.
   */
  stop(): void {
    for (const subId of this.subscriptionIds) {
      this.eventBus.unsubscribe(subId);
    }
    this.subscriptionIds = [];

    // Cancel all outstanding timeouts
    for (const group of this.groups.values()) {
      if (group.timeout_handle) {
        clearTimeout(group.timeout_handle);
      }
    }
    this.groups.clear();
    this.configs.clear();
  }

  /**
   * Reload composition configs (e.g., after meta manifest changes).
   * Existing in-flight groups continue with their original config.
   */
  reload(compositions: Composition[]): void {
    this.configs.clear();
    for (const comp of compositions) {
      if (comp.enabled) {
        this.configs.set(comp.id, comp);
      }
    }
  }

  /**
   * Get the current state of a group by group_id.
   * Returns undefined if no group exists.
   */
  getGroupState(groupId: string): GroupState | undefined {
    return this.groups.get(groupId);
  }

  /**
   * Get all active group states.
   */
  getActiveGroups(): Map<string, GroupState> {
    return new Map(this.groups);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Handle an action.completed or action.failed event.
   *
   * Matches the event to a composition group via group_id in the payload.
   * If no group_id or no matching config, the event is ignored.
   *
   * AC: @dispatch-composition-correlation ac-1 — new activation created
   *     when first event with a group_id matching a config arrives
   * AC: @dispatch-composition-correlation ac-2 — only completed runs count
   *     toward threshold; failed runs tracked for partial results
   */
  private async handleActionEvent(event: EventEnvelope): Promise<void> {
    const payload = event.payload;

    // group_id is set by the action executor when spawning composition members
    const groupId = payload.group_id as string | undefined;
    if (!groupId) return;

    // config_id maps group_id to a composition config
    const configId = payload.config_id as string | undefined;
    if (!configId) return;

    const config = this.configs.get(configId);
    if (!config) return;

    // Get or create group state
    let group = this.groups.get(groupId);
    if (!group) {
      // AC: @dispatch-composition-correlation ac-1 — create new activation
      group = {
        activation_id: ulid(),
        config_id: configId,
        completed_count: 0,
        failed_count: 0,
        members: [],
        first_run_at: null,
        fired: false,
        timeout_handle: null,
      };
      this.groups.set(groupId, group);
    }

    // Don't process if already fired
    if (group.fired) return;

    // AC: @dispatch-composition-correlation ac-3 — timeout starts when
    // first run begins
    if (group.first_run_at === null) {
      group.first_run_at = Date.now();
      this.startTimeout(groupId, config);
    }

    // Track the member run
    const isCompleted = event.event_type === "action.completed";
    const memberRun: GroupMemberRun = {
      action_run_id: payload.action_run_id as string,
      action_type: payload.action_type as string,
      status: isCompleted ? "completed" : "failed",
      session_id: payload.session_id as string | undefined,
      completed_at: new Date().toISOString(),
    };
    group.members.push(memberRun);

    // AC: @dispatch-composition-correlation ac-2 — only successful
    // completions count toward threshold
    if (isCompleted) {
      group.completed_count++;
    } else {
      group.failed_count++;
    }

    // AC: @dispatch-composition-patterns ac-2 — fire on_complete when
    // Nth successful run finishes
    if (group.completed_count >= config.join_count) {
      await this.fireOnComplete(groupId, group, config, "threshold_met");
    }
  }

  /**
   * Start the timeout timer for a group.
   *
   * AC: @dispatch-composition-correlation ac-3 — timeout starts when
   * first action run begins, not when group is configured
   * AC: @dispatch-composition-patterns ac-3 — on timeout, fire on_complete
   * with partial results
   */
  private startTimeout(groupId: string, config: Composition): void {
    if (!config.timeout_ms) return;

    const group = this.groups.get(groupId);
    if (!group) return;

    group.timeout_handle = setTimeout(async () => {
      const currentGroup = this.groups.get(groupId);
      if (!currentGroup || currentGroup.fired) return;

      // Mark any pending members as timed out (for reporting)
      await this.fireOnComplete(groupId, currentGroup, config, "timeout");
    }, config.timeout_ms);
  }

  /**
   * Fire the on_complete action for a group and clean up state.
   *
   * AC: @dispatch-composition-patterns ac-2 — on_complete triggered with
   *     references to all completed action runs and their linked sessions
   * AC: @dispatch-composition-patterns ac-3 — on timeout, fires with
   *     partial results (which completed, which failed, which timed out)
   */
  private async fireOnComplete(
    groupId: string,
    group: GroupState,
    config: Composition,
    trigger: "threshold_met" | "timeout",
  ): Promise<void> {
    // Mark as fired to prevent double-firing
    group.fired = true;

    // Cancel timeout if still pending
    if (group.timeout_handle) {
      clearTimeout(group.timeout_handle);
      group.timeout_handle = null;
    }

    // Build the event context for the on_complete action
    const completedRuns = group.members.filter(
      (m) => m.status === "completed",
    );
    const failedRuns = group.members.filter((m) => m.status === "failed");

    const eventContext: ActionEventContext = {
      event_id: ulid(),
      event_type: "composition.completed",
      source_type: "join_accumulator",
      source_id: config.id,
      group_id: groupId,
      correlation_id: groupId,
      activation_id: group.activation_id,
      config_id: config.id,
      trigger,
      join_count: config.join_count,
      completed_count: group.completed_count,
      failed_count: group.failed_count,
      total_members: group.members.length,
      completed_run_ids: completedRuns
        .map((m) => m.action_run_id)
        .join(","),
      completed_session_ids: completedRuns
        .filter((m) => m.session_id)
        .map((m) => m.session_id!)
        .join(","),
      failed_run_ids: failedRuns.map((m) => m.action_run_id).join(","),
    };

    // Execute the on_complete action
    await this.actionExecutor.execute(
      config.on_complete,
      eventContext,
      `composition:${config.id}`,
    );

    // Clean up group state
    this.groups.delete(groupId);
  }
}
