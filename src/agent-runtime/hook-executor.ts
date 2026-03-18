/**
 * Hook Execution Engine
 *
 * Subscribes to the event bus and runs matching hooks via the shared action model.
 * Loads hooks from meta context, filters events against hook configuration,
 * and dispatches actions via ActionExecutor. Propagates correlation_id and sets
 * causation_id on downstream events.
 *
 * Config reload uses a versioned snapshot — updated by external callers
 * (file watcher or API change notification) via reloadHooks(). In-flight
 * actions from removed hooks complete normally.
 *
 * Spec: @dispatch-hook-system
 * Task: @task-hook-executor
 */

import type { EventBus, EventEnvelope } from "./event-bus.js";
import { ActionExecutor, type ActionEventContext } from "./action-executor.js";
import { matchesFilter, type Hook } from "../schema/hooks.js";
import type { ActionRun } from "../schema/action.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A hook snapshot with a version counter for config change detection.
 * AC: @dispatch-hook-system ac-5
 */
export interface HookConfigSnapshot {
  version: number;
  hooks: readonly Hook[];
}

/**
 * Options for creating a HookExecutor.
 */
export interface HookExecutorOptions {
  /** The event bus to subscribe to */
  eventBus: EventBus;
  /** The action executor for running hook actions */
  actionExecutor: ActionExecutor;
  /** Initial set of hooks (typically from MetaContext) */
  hooks: readonly Hook[];
}

// ─── HookExecutor ────────────────────────────────────────────────────────────

/**
 * Subscribes to the event bus and executes matching hooks.
 *
 * Usage:
 *   const executor = new HookExecutor({ eventBus, actionExecutor, hooks });
 *   executor.start();
 *   // ... later, when config changes:
 *   executor.reloadHooks(newHooks);
 *   // ... on shutdown:
 *   executor.stop();
 *
 * AC: @dispatch-hook-system ac-1 through ac-5
 */
export class HookExecutor {
  private eventBus: EventBus;
  private actionExecutor: ActionExecutor;
  /** Versioned config snapshot. AC: @dispatch-hook-system ac-5 */
  private config: HookConfigSnapshot;

  /** Bus subscription ID (null when not subscribed) */
  private subscriptionId: string | null = null;

  /** Track in-flight action promises for graceful shutdown */
  private inFlightActions: Set<Promise<ActionRun | undefined>> = new Set();

  constructor(options: HookExecutorOptions) {
    this.eventBus = options.eventBus;
    this.actionExecutor = options.actionExecutor;
    this.config = {
      version: 1,
      hooks: options.hooks,
    };
  }

  /**
   * Start listening for events on the bus.
   * Subscribes to all events ("*") and evaluates hooks on each.
   */
  start(): void {
    if (this.subscriptionId !== null) return;
    this.subscriptionId = this.eventBus.subscribe("*", (event) => {
      this._handleEvent(event);
    });
  }

  /**
   * Stop listening for events. In-flight actions complete normally.
   * AC: @dispatch-hook-system ac-5 (in-flight actions from removed hooks complete)
   */
  stop(): void {
    if (this.subscriptionId !== null) {
      this.eventBus.unsubscribe(this.subscriptionId);
      this.subscriptionId = null;
    }
    // Note: in-flight actions are NOT cancelled — they complete normally
  }

  /**
   * Reload hook configuration with a new set of hooks.
   * Increments the version counter. In-flight actions from previously
   * configured hooks continue to completion.
   *
   * AC: @dispatch-hook-system ac-5
   */
  reloadHooks(hooks: readonly Hook[]): void {
    this.config = {
      version: this.config.version + 1,
      hooks,
    };
  }

  /**
   * Get the current config snapshot version.
   * Useful for testing and diagnostics.
   */
  get configVersion(): number {
    return this.config.version;
  }

  /**
   * Get the current hook count.
   */
  get hookCount(): number {
    return this.config.hooks.length;
  }

  /**
   * Whether the executor is currently subscribed to events.
   */
  get isRunning(): boolean {
    return this.subscriptionId !== null;
  }

  /**
   * Number of currently in-flight action executions.
   */
  get inFlightCount(): number {
    return this.inFlightActions.size;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Handle an event from the bus: evaluate all hooks against it.
   *
   * AC: @dispatch-hook-system ac-1 (match + execute)
   * AC: @dispatch-hook-system ac-2 (skip disabled)
   * AC: @dispatch-hook-system ac-3 (all matching hooks execute independently)
   * AC: @dispatch-hook-system ac-4 (filter matching)
   * AC: @dispatch-hook-system ac-5 (uses current config snapshot)
   */
  private _handleEvent(event: EventEnvelope): void {
    // Take a snapshot reference — if config reloads mid-iteration,
    // we continue with the version we started with
    const snapshot = this.config;

    for (const hook of snapshot.hooks) {
      // AC: @dispatch-hook-system ac-2 — skip disabled hooks silently
      if (!hook.enabled) continue;

      // Check event type match (hook.on must equal the event type)
      if (hook.on !== event.event_type) continue;

      // AC: @dispatch-hook-system ac-4 — apply filter matching
      const envelope: Record<string, unknown> = {
        event_id: event.event_id,
        event_type: event.event_type,
        emitted_at: event.emitted_at,
        source_type: event.source_type,
        source_id: event.source_id,
        causation_id: event.causation_id,
        correlation_id: event.correlation_id,
      };

      if (!matchesFilter(hook.filter, envelope, event.payload)) continue;

      // AC: @dispatch-hook-system ac-1 — execute action with event context
      // AC: @dispatch-hook-system ac-3 — fire-and-forget, no hook depends on another's outcome
      this._executeHookAction(hook, event);
    }
  }

  /**
   * Execute a single hook's action asynchronously (fire-and-forget).
   * Propagates correlation_id and sets causation_id from the triggering event.
   *
   * AC: @dispatch-hook-system ac-1
   */
  private _executeHookAction(hook: Hook, event: EventEnvelope): void {
    // Build action event context with flattened envelope + payload fields.
    // AC: @dispatch-hook-system ac-1 — propagate correlation_id, set causation_id
    const eventContext: ActionEventContext = {
      event_id: event.event_id,
      event_type: event.event_type,
      correlation_id: event.correlation_id ?? event.event_id,
      causation_id: event.event_id,
      source_type: event.source_type,
      source_id: event.source_id,
      // Flatten payload fields for template interpolation access
      ...this._flattenPayload(event.payload),
    };

    // Fire-and-forget with defensive catch — ActionExecutor.execute() handles
    // errors internally and returns a failed ActionRun, but we guard against
    // unexpected throws to prevent unhandled promise rejections.
    const promise = this.actionExecutor
      .execute(hook.action, eventContext, hook.name)
      .catch((err) => {
        console.error(
          `[hook-executor] Unexpected error executing hook '${hook.name}':`,
          err,
        );
        return undefined;
      });

    // Track in-flight for diagnostics
    this.inFlightActions.add(promise);
    promise.finally(() => {
      this.inFlightActions.delete(promise);
    });
  }

  /**
   * Flatten payload values to string/number/boolean for ActionEventContext.
   * Arrays and objects are stringified.
   */
  private _flattenPayload(
    payload: Record<string, unknown>,
  ): Record<string, string | number | boolean | undefined> {
    const flat: Record<string, string | number | boolean | undefined> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        flat[key] = value;
      } else if (value === null || value === undefined) {
        flat[key] = undefined;
      } else {
        // Arrays, objects → stringify for template interpolation
        flat[key] = JSON.stringify(value);
      }
    }
    return flat;
  }
}
