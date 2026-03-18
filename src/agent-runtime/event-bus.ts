/**
 * Event Bus with typed envelope for dispatch event system.
 *
 * Provides a publish/subscribe model with:
 * - Standard event envelope (identity, causation, ordering metadata)
 * - Task event deduplication (existing mechanism, task.* events only)
 * - Per-source sequential delivery ordering
 * - Chain depth limit via correlation_id tracking
 * - Configurable ring buffer for recent event retention
 *
 * Spec: @dispatch-event-envelope
 * Task: @task-event-bus
 */

import { ulid } from "ulid";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Source types that can emit events on the bus.
 * AC: @dispatch-event-envelope ac-1
 */
export type EventSourceType =
  | "task_watcher"
  | "api"
  | "invocation_lifecycle"
  | "schedule_engine"
  | "manual";

/**
 * Standard event envelope carried by every event on the bus.
 * AC: @dispatch-event-envelope ac-1, ac-2
 */
export interface EventEnvelope {
  /** Unique identifier per event occurrence */
  event_id: string;
  /** Dotted namespace event type (e.g. "task.ready", "invocation.completed") */
  event_type: string;
  /** Timestamp when the event was emitted */
  emitted_at: number;
  /** Type of source that produced this event */
  source_type: EventSourceType;
  /** Originating entity identifier (e.g. task ref, session id) */
  source_id: string;
  /** The event_id that directly caused this event (null for root events) */
  causation_id: string | null;
  /** Root event_id of the causal chain, propagated transitively (null for root events) */
  correlation_id: string | null;
  /** Arbitrary payload associated with the event */
  payload: Record<string, unknown>;
}

/**
 * Options for emitting an event, allowing the caller to specify
 * causation chain fields and source metadata.
 */
export interface EmitOptions {
  event_type: string;
  source_type: EventSourceType;
  source_id: string;
  payload?: Record<string, unknown>;
  /** The event_id that directly caused this emission */
  causation_id?: string | null;
  /** The root correlation_id to propagate (defaults to causation_id's correlation or event_id) */
  correlation_id?: string | null;
  /**
   * Skip the bus-level task event dedup check.
   * Set to true when the caller has already performed dedup (e.g., DispatchEngine).
   */
  skipDedup?: boolean;
}

/**
 * A subscription pattern for filtering events.
 * Supports exact match or prefix match with wildcard (e.g. "task.*").
 */
export type SubscriptionPattern = string;

/**
 * Handler function invoked when a matching event is delivered.
 */
export type EventHandler = (event: EventEnvelope) => void | Promise<void>;

/**
 * A registered subscription.
 */
interface Subscription {
  id: string;
  pattern: SubscriptionPattern;
  handler: EventHandler;
}

/**
 * Task event deduplication key.
 * AC: @dispatch-event-envelope ac-3
 */
export type TaskDedupKey = `${string}:${string}:${string}`;

/**
 * Result of an emit attempt.
 */
export interface EmitResult {
  /** Whether the event was accepted (not rejected by dedup or chain depth) */
  accepted: boolean;
  /** The event envelope if accepted, undefined if rejected */
  event?: EventEnvelope;
  /** Reason for rejection if not accepted */
  reason?: string;
}

/**
 * Configuration options for the EventBus.
 */
export interface EventBusOptions {
  /** Maximum chain depth before rejecting events (default 5). AC: @dispatch-event-envelope ac-5 */
  maxChainDepth?: number;
  /** Ring buffer capacity for recent event retention (default 500). AC: @dispatch-event-envelope ac-6 */
  ringBufferCapacity?: number;
  /** Deduplication window in milliseconds for task events (default 2000). AC: @dispatch-event-envelope ac-3 */
  dedupWindowMs?: number;
}

// ─── Ring Buffer ──────────────────────────────────────────────────────────────

/**
 * A simple circular array for retaining recent events.
 * AC: @dispatch-event-envelope ac-6
 */
class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /**
   * Return all items in insertion order (oldest to newest).
   */
  toArray(): T[] {
    if (this.count === 0) return [];
    const result: T[] = [];
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      result.push(this.buffer[idx] as T);
    }
    return result;
  }

  get size(): number {
    return this.count;
  }
}

// ─── EventBus ─────────────────────────────────────────────────────────────────

/**
 * Central event bus for the dispatch system.
 *
 * Provides typed event emission with standard envelopes, subscription-based
 * delivery, per-source ordering, task event dedup, chain depth limiting,
 * and recent event retention via ring buffer.
 *
 * AC: @dispatch-event-envelope ac-1 through ac-6
 */
export class EventBus {
  private subscriptions: Subscription[] = [];
  private maxChainDepth: number;
  private dedupWindowMs: number;

  /** Ring buffer for recent event retention. AC: @dispatch-event-envelope ac-6 */
  private ringBuffer: RingBuffer<EventEnvelope>;

  /** Task event dedup: (taskId:fromStatus:toStatus) → expiry timestamp. AC: @dispatch-event-envelope ac-3 */
  private taskDedupMap: Map<TaskDedupKey, number> = new Map();

  /** Chain depth tracking: correlation_id → current depth. AC: @dispatch-event-envelope ac-5 */
  private chainDepths: Map<string, number> = new Map();

  /**
   * Per-source delivery queue for sequential ordering.
   * Maps source_id to a promise chain that serializes delivery.
   * AC: @dispatch-event-envelope ac-4
   */
  private sourceDeliveryChains: Map<string, Promise<void>> = new Map();

  constructor(options: EventBusOptions = {}) {
    this.maxChainDepth = options.maxChainDepth ?? 5;
    this.ringBuffer = new RingBuffer(options.ringBufferCapacity ?? 500);
    this.dedupWindowMs = options.dedupWindowMs ?? 2000;
  }

  /**
   * Emit an event on the bus.
   *
   * Creates an envelope, applies dedup (task events only), checks chain depth,
   * stores in ring buffer, and delivers to matching subscribers in emission
   * order per source.
   *
   * AC: @dispatch-event-envelope ac-1 (envelope), ac-2 (causation), ac-3 (dedup),
   *     ac-4 (ordering), ac-5 (chain depth)
   */
  emit(options: EmitOptions): EmitResult {
    const event_id = ulid();
    const now = Date.now();

    // Resolve causation chain
    const causation_id = options.causation_id ?? null;
    let correlation_id = options.correlation_id ?? null;

    // If we have a causation_id but no explicit correlation_id,
    // look up the correlation chain from the causing event
    if (causation_id && !correlation_id) {
      // The correlation_id of a caused event is the correlation_id of its cause,
      // or the cause's event_id if the cause was a root event
      const causingEvent = this.getRecentEvents().find(
        (e) => e.event_id === causation_id,
      );
      if (causingEvent) {
        correlation_id = causingEvent.correlation_id ?? causingEvent.event_id;
      } else {
        // Cause not in ring buffer; use causation_id as correlation root
        correlation_id = causation_id;
      }
    }

    // AC: @dispatch-event-envelope ac-5 - Chain depth limit
    if (correlation_id) {
      const currentDepth = this.chainDepths.get(correlation_id) ?? 0;
      const newDepth = currentDepth + 1;
      if (newDepth > this.maxChainDepth) {
        console.warn(
          `[event-bus] Chain depth limit exceeded (${newDepth}/${this.maxChainDepth}) ` +
            `for correlation_id=${correlation_id}, causation_id=${causation_id}, ` +
            `event_type=${options.event_type}. Rejecting event.`,
        );
        return {
          accepted: false,
          reason: `Chain depth limit exceeded: ${newDepth}/${this.maxChainDepth} ` +
            `(correlation_id=${correlation_id})`,
        };
      }
      this.chainDepths.set(correlation_id, newDepth);
    }

    // Build the envelope
    // AC: @dispatch-event-envelope ac-1
    const envelope: EventEnvelope = {
      event_id,
      event_type: options.event_type,
      emitted_at: now,
      source_type: options.source_type,
      source_id: options.source_id,
      causation_id,
      correlation_id,
      payload: options.payload ?? {},
    };

    // AC: @dispatch-event-envelope ac-3 - Task event dedup
    if (options.event_type.startsWith("task.") && !options.skipDedup) {
      const taskId = (options.payload?.taskId as string) ?? options.source_id;
      const fromStatus = (options.payload?.fromStatus as string) ?? "";
      const toStatus = (options.payload?.toStatus as string) ?? "";
      const dedupKey: TaskDedupKey = `${taskId}:${fromStatus}:${toStatus}`;

      const expiry = this.taskDedupMap.get(dedupKey);
      if (expiry !== undefined && now < expiry) {
        return {
          accepted: false,
          reason: `Duplicate task event: ${dedupKey}`,
        };
      }
      this.taskDedupMap.set(dedupKey, now + this.dedupWindowMs);

      // Prune expired dedup entries periodically
      if (this.taskDedupMap.size > 1000) {
        for (const [k, exp] of this.taskDedupMap) {
          if (exp < now) this.taskDedupMap.delete(k);
        }
      }
    }

    // AC: @dispatch-event-envelope ac-6 - Store in ring buffer
    this.ringBuffer.push(envelope);

    // AC: @dispatch-event-envelope ac-4 - Per-source sequential delivery
    this._deliverToSubscribers(envelope);

    return { accepted: true, event: envelope };
  }

  /**
   * Subscribe to events matching a pattern.
   *
   * Patterns support:
   * - Exact match: "task.ready"
   * - Prefix wildcard: "task.*" (matches any event_type starting with "task.")
   * - Catch-all: "*" (matches all events)
   *
   * Returns a subscription id that can be used to unsubscribe.
   */
  subscribe(pattern: SubscriptionPattern, handler: EventHandler): string {
    const id = ulid();
    this.subscriptions.push({ id, pattern, handler });
    return id;
  }

  /**
   * Remove a subscription by id.
   */
  unsubscribe(subscriptionId: string): boolean {
    const idx = this.subscriptions.findIndex((s) => s.id === subscriptionId);
    if (idx === -1) return false;
    this.subscriptions.splice(idx, 1);
    return true;
  }

  /**
   * Get recent events from the ring buffer.
   * AC: @dispatch-event-envelope ac-6
   */
  getRecentEvents(): EventEnvelope[] {
    return this.ringBuffer.toArray();
  }

  /**
   * Get the number of events currently retained in the ring buffer.
   */
  getRecentEventCount(): number {
    return this.ringBuffer.size;
  }

  /**
   * Reset the chain depth counter for a given correlation_id.
   * Useful when a chain completes normally and should allow new chains.
   */
  resetChainDepth(correlationId: string): void {
    this.chainDepths.delete(correlationId);
  }

  /**
   * Get the current chain depth for a correlation_id.
   */
  getChainDepth(correlationId: string): number {
    return this.chainDepths.get(correlationId) ?? 0;
  }

  /**
   * Clear all state (subscriptions, ring buffer, dedup, chain depths).
   * Useful for testing or engine shutdown.
   */
  clear(): void {
    this.subscriptions = [];
    this.ringBuffer = new RingBuffer(this.ringBuffer["capacity"]);
    this.taskDedupMap.clear();
    this.chainDepths.clear();
    this.sourceDeliveryChains.clear();
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Deliver an event to all matching subscribers, sequentially per source.
   * AC: @dispatch-event-envelope ac-4
   */
  private _deliverToSubscribers(event: EventEnvelope): void {
    const matching = this.subscriptions.filter((s) =>
      this._matchesPattern(s.pattern, event.event_type),
    );
    if (matching.length === 0) return;

    // Chain delivery onto the per-source promise chain to ensure
    // events from the same source are processed sequentially
    const sourceId = event.source_id;
    const previousChain = this.sourceDeliveryChains.get(sourceId) ?? Promise.resolve();

    const deliveryChain = previousChain.then(async () => {
      for (const sub of matching) {
        try {
          await sub.handler(event);
        } catch (err) {
          console.error(
            `[event-bus] Subscriber error for ${event.event_type}:`,
            err,
          );
        }
      }
    });

    this.sourceDeliveryChains.set(sourceId, deliveryChain);
  }

  /**
   * Check if an event type matches a subscription pattern.
   */
  private _matchesPattern(pattern: string, eventType: string): boolean {
    if (pattern === "*") return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -1); // "task.*" → "task."
      return eventType.startsWith(prefix);
    }
    return pattern === eventType;
  }
}
