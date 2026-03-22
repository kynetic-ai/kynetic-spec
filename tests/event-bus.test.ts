/**
 * Event Bus tests.
 *
 * Tests for the dispatch event bus: envelope structure, causation tracking,
 * task event dedup, per-source ordering, chain depth limit, and ring buffer.
 *
 * Task: @task-event-bus
 * Spec: @dispatch-event-envelope
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  EventBus,
  type EventEnvelope,
  type EmitResult,
} from "../src/agent-runtime/event-bus.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emitBasicEvent(
  bus: EventBus,
  overrides: Record<string, unknown> = {},
): EmitResult {
  return bus.emit({
    event_type: "test.basic",
    source_type: "manual",
    source_id: "test-source",
    payload: { key: "value" },
    ...overrides,
  });
}

// ─── AC-1: Event Envelope Structure ──────────────────────────────────────────

// AC: @dispatch-event-envelope ac-1
describe("ac-1: event envelope structure", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it("should carry event_id, event_type, emitted_at, source_type, source_id", () => {
    const before = Date.now();
    const result = bus.emit({
      event_type: "task.ready",
      source_type: "task_watcher",
      source_id: "@01ABC123",
      payload: { taskId: "01ABC123" },
    });

    expect(result.accepted).toBe(true);
    expect(result.event).toBeDefined();
    const event = result.event!;

    // event_id is a unique ULID
    expect(event.event_id).toMatch(/^[0-9A-Z]{26}$/);
    // event_type is the dotted namespace
    expect(event.event_type).toBe("task.ready");
    // emitted_at is a timestamp
    expect(event.emitted_at).toBeGreaterThanOrEqual(before);
    expect(event.emitted_at).toBeLessThanOrEqual(Date.now());
    // source_type
    expect(event.source_type).toBe("task_watcher");
    // source_id
    expect(event.source_id).toBe("@01ABC123");
  });

  it("should generate unique event_id for each emission", () => {
    const r1 = emitBasicEvent(bus);
    const r2 = emitBasicEvent(bus);

    expect(r1.event!.event_id).not.toBe(r2.event!.event_id);
  });

  it("should accept all valid source types", () => {
    const sourceTypes = [
      "task_watcher",
      "api",
      "invocation_lifecycle",
      "schedule_engine",
      "manual",
    ] as const;

    for (const sourceType of sourceTypes) {
      const result = bus.emit({
        event_type: "test.source",
        source_type: sourceType,
        source_id: "test",
        payload: {},
      });
      expect(result.accepted).toBe(true);
      expect(result.event!.source_type).toBe(sourceType);
    }
  });

  it("should include payload in envelope", () => {
    const result = bus.emit({
      event_type: "task.ready",
      source_type: "api",
      source_id: "@task-ref",
      payload: { taskId: "ABC123", fromStatus: "pending", toStatus: "in_progress" },
    });

    expect(result.event!.payload).toEqual({
      taskId: "ABC123",
      fromStatus: "pending",
      toStatus: "in_progress",
    });
  });

  it("should default payload to empty object when omitted", () => {
    const result = bus.emit({
      event_type: "test.no-payload",
      source_type: "manual",
      source_id: "test",
    });

    expect(result.event!.payload).toEqual({});
  });
});

// ─── AC-2: Causation and Correlation Chain ──────────────────────────────────

// AC: @dispatch-event-envelope ac-2
describe("ac-2: causation and correlation chain tracking", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it("should set causation_id and correlation_id to null for root events", () => {
    const result = emitBasicEvent(bus);
    const event = result.event!;

    expect(event.causation_id).toBeNull();
    expect(event.correlation_id).toBeNull();
  });

  it("should carry explicit causation_id and correlation_id", () => {
    const root = emitBasicEvent(bus);
    const rootId = root.event!.event_id;

    const downstream = bus.emit({
      event_type: "test.downstream",
      source_type: "invocation_lifecycle",
      source_id: "session-1",
      causation_id: rootId,
      correlation_id: rootId,
    });

    expect(downstream.event!.causation_id).toBe(rootId);
    expect(downstream.event!.correlation_id).toBe(rootId);
  });

  it("should auto-resolve correlation_id from causation chain in ring buffer", () => {
    // Root event
    const root = bus.emit({
      event_type: "test.root",
      source_type: "manual",
      source_id: "root-source",
    });
    const rootId = root.event!.event_id;

    // Level 1: caused by root
    const level1 = bus.emit({
      event_type: "test.level1",
      source_type: "invocation_lifecycle",
      source_id: "session-1",
      causation_id: rootId,
      // No explicit correlation_id — should auto-resolve to rootId
    });
    // Root event had no correlation_id, so downstream gets root's event_id as correlation
    expect(level1.event!.correlation_id).toBe(rootId);

    // Level 2: caused by level1, should propagate correlation transitively
    const level2 = bus.emit({
      event_type: "test.level2",
      source_type: "invocation_lifecycle",
      source_id: "session-2",
      causation_id: level1.event!.event_id,
      // No explicit correlation_id — should propagate from level1
    });
    expect(level2.event!.correlation_id).toBe(rootId);
  });

  it("should use causation_id as correlation fallback when cause not in ring buffer", () => {
    const bus = new EventBus({ ringBufferCapacity: 1 });

    // Emit and fill ring buffer to evict
    bus.emit({
      event_type: "test.filler",
      source_type: "manual",
      source_id: "filler",
    });

    // The cause is not in the ring buffer
    const externalCauseId = "EXTERNAL_CAUSE_ID_123456";
    const result = bus.emit({
      event_type: "test.caused",
      source_type: "api",
      source_id: "test",
      causation_id: externalCauseId,
    });

    expect(result.event!.causation_id).toBe(externalCauseId);
    expect(result.event!.correlation_id).toBe(externalCauseId);
  });

  it("should propagate KSPEC_CORRELATION_ID for cross-process causation chain", () => {
    // This tests the contract: callers can pass correlation_id derived from
    // the KSPEC_CORRELATION_ID env var to maintain cross-process chains.
    const crossProcessCorrelation = "CROSS_PROCESS_ROOT_EVENT";
    const result = bus.emit({
      event_type: "task.ready",
      source_type: "api",
      source_id: "@task-ref",
      causation_id: crossProcessCorrelation,
      correlation_id: crossProcessCorrelation,
      payload: { taskId: "test", fromStatus: "pending", toStatus: "in_progress" },
    });

    expect(result.event!.correlation_id).toBe(crossProcessCorrelation);
    expect(result.event!.causation_id).toBe(crossProcessCorrelation);
  });
});

// ─── AC-3: Task Event Dedup ─────────────────────────────────────────────────

// AC: @dispatch-event-envelope ac-3
describe("ac-3: task event dedup", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus({ dedupWindowMs: 2000 });
  });

  it("should deduplicate task events with same (taskId, fromStatus, toStatus)", () => {
    const emitTaskEvent = () =>
      bus.emit({
        event_type: "task.ready",
        source_type: "task_watcher",
        source_id: "@task-123",
        payload: { taskId: "task-123", fromStatus: "pending", toStatus: "in_progress" },
      });

    const first = emitTaskEvent();
    expect(first.accepted).toBe(true);

    const duplicate = emitTaskEvent();
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.reason).toContain("Duplicate task event");
  });

  it("should allow task events with different (taskId, fromStatus, toStatus)", () => {
    const r1 = bus.emit({
      event_type: "task.ready",
      source_type: "task_watcher",
      source_id: "@task-A",
      payload: { taskId: "task-A", fromStatus: "pending", toStatus: "in_progress" },
    });

    const r2 = bus.emit({
      event_type: "task.ready",
      source_type: "task_watcher",
      source_id: "@task-B",
      payload: { taskId: "task-B", fromStatus: "pending", toStatus: "in_progress" },
    });

    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(true);
  });

  it("should NOT deduplicate non-task events", () => {
    const emitNonTaskEvent = () =>
      bus.emit({
        event_type: "invocation.completed",
        source_type: "invocation_lifecycle",
        source_id: "session-1",
        payload: { taskId: "task-123", fromStatus: "pending", toStatus: "in_progress" },
      });

    const first = emitNonTaskEvent();
    const second = emitNonTaskEvent();

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    // Each gets a unique event_id
    expect(first.event!.event_id).not.toBe(second.event!.event_id);
  });

  it("should allow same task event after dedup window expires", async () => {
    const bus = new EventBus({ dedupWindowMs: 50 });

    const emitTaskEvent = () =>
      bus.emit({
        event_type: "task.ready",
        source_type: "task_watcher",
        source_id: "@task-123",
        payload: { taskId: "task-123", fromStatus: "pending", toStatus: "in_progress" },
      });

    const first = emitTaskEvent();
    expect(first.accepted).toBe(true);

    // Wait for dedup window to expire
    await new Promise((r) => setTimeout(r, 60));

    const afterWindow = emitTaskEvent();
    expect(afterWindow.accepted).toBe(true);
  });

  it("should use source_id as taskId fallback for dedup key", () => {
    // When payload doesn't have taskId, source_id is used
    const r1 = bus.emit({
      event_type: "task.ready",
      source_type: "api",
      source_id: "@task-fallback",
      payload: { fromStatus: "pending", toStatus: "in_progress" },
    });
    expect(r1.accepted).toBe(true);

    const r2 = bus.emit({
      event_type: "task.ready",
      source_type: "api",
      source_id: "@task-fallback",
      payload: { fromStatus: "pending", toStatus: "in_progress" },
    });
    expect(r2.accepted).toBe(false);
  });
});

// ─── AC-4: Per-Source Sequential Delivery ───────────────────────────────────

// AC: @dispatch-event-envelope ac-4
describe("ac-4: per-source sequential delivery ordering", () => {
  it("should deliver events in emission order per source", async () => {
    const bus = new EventBus();
    const deliveryOrder: string[] = [];

    bus.subscribe("test.*", async (event) => {
      // Simulate async processing with varying delays
      const delay = event.event_type === "test.first" ? 30 : 5;
      await new Promise((r) => setTimeout(r, delay));
      deliveryOrder.push(event.event_type);
    });

    // Emit two events from the same source
    bus.emit({
      event_type: "test.first",
      source_type: "manual",
      source_id: "source-A",
    });
    bus.emit({
      event_type: "test.second",
      source_type: "manual",
      source_id: "source-A",
    });

    // Wait for all delivery to complete
    await new Promise((r) => setTimeout(r, 100));

    // Should be in emission order despite first handler taking longer
    expect(deliveryOrder).toEqual(["test.first", "test.second"]);
  });

  it("should process events from different sources independently", async () => {
    const bus = new EventBus();
    const deliveryOrder: string[] = [];

    bus.subscribe("test.*", async (event) => {
      const delay = event.source_id === "slow-source" ? 50 : 5;
      await new Promise((r) => setTimeout(r, delay));
      deliveryOrder.push(`${event.source_id}:${event.event_type}`);
    });

    bus.emit({
      event_type: "test.event",
      source_type: "manual",
      source_id: "slow-source",
    });
    bus.emit({
      event_type: "test.event",
      source_type: "manual",
      source_id: "fast-source",
    });

    await new Promise((r) => setTimeout(r, 100));

    // Fast source should complete before slow source
    expect(deliveryOrder.indexOf("fast-source:test.event")).toBeLessThan(
      deliveryOrder.indexOf("slow-source:test.event"),
    );
  });

  it("should process subscribers sequentially for same-source events", async () => {
    const bus = new EventBus();
    const log: string[] = [];

    bus.subscribe("*", async (event) => {
      log.push(`handler1:start:${event.event_type}`);
      await new Promise((r) => setTimeout(r, 20));
      log.push(`handler1:end:${event.event_type}`);
    });

    bus.subscribe("*", async (event) => {
      log.push(`handler2:start:${event.event_type}`);
      await new Promise((r) => setTimeout(r, 10));
      log.push(`handler2:end:${event.event_type}`);
    });

    bus.emit({
      event_type: "test.a",
      source_type: "manual",
      source_id: "src",
    });
    bus.emit({
      event_type: "test.b",
      source_type: "manual",
      source_id: "src",
    });

    await new Promise((r) => setTimeout(r, 200));

    // All handlers for test.a must complete before test.b starts
    const aEnd = log.lastIndexOf("handler2:end:test.a");
    const bStart = log.indexOf("handler1:start:test.b");
    expect(aEnd).toBeLessThan(bStart);
  });
});

// ─── AC-5: Chain Depth Limit ────────────────────────────────────────────────

// AC: @dispatch-event-envelope ac-5
describe("ac-5: chain depth limit", () => {
  it("should reject events exceeding max chain depth (default 5)", () => {
    const bus = new EventBus();
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Build a chain of 5 events with the same correlation
    const root = bus.emit({
      event_type: "test.root",
      source_type: "manual",
      source_id: "root",
    });
    const correlationId = root.event!.event_id;

    // Events 1-5 in the chain (depth 1-5)
    let lastEventId = root.event!.event_id;
    for (let i = 1; i <= 5; i++) {
      const result = bus.emit({
        event_type: `test.chain.${i}`,
        source_type: "invocation_lifecycle",
        source_id: `session-${i}`,
        causation_id: lastEventId,
        correlation_id: correlationId,
      });
      expect(result.accepted).toBe(true);
      lastEventId = result.event!.event_id;
    }

    // Event 6 should be rejected (exceeds depth 5)
    const rejected = bus.emit({
      event_type: "test.chain.6",
      source_type: "invocation_lifecycle",
      source_id: "session-6",
      causation_id: lastEventId,
      correlation_id: correlationId,
    });

    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toContain("Chain depth limit exceeded");
    expect(rejected.reason).toContain(correlationId);

    // Should log a warning
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Chain depth limit exceeded"),
    );

    consoleSpy.mockRestore();
  });

  it("should respect custom maxChainDepth", () => {
    const bus = new EventBus({ maxChainDepth: 2 });
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const root = bus.emit({
      event_type: "test.root",
      source_type: "manual",
      source_id: "root",
    });
    const correlationId = root.event!.event_id;

    // Depth 1 — accepted
    const d1 = bus.emit({
      event_type: "test.d1",
      source_type: "invocation_lifecycle",
      source_id: "s1",
      causation_id: root.event!.event_id,
      correlation_id: correlationId,
    });
    expect(d1.accepted).toBe(true);

    // Depth 2 — accepted
    const d2 = bus.emit({
      event_type: "test.d2",
      source_type: "invocation_lifecycle",
      source_id: "s2",
      causation_id: d1.event!.event_id,
      correlation_id: correlationId,
    });
    expect(d2.accepted).toBe(true);

    // Depth 3 — rejected
    const d3 = bus.emit({
      event_type: "test.d3",
      source_type: "invocation_lifecycle",
      source_id: "s3",
      causation_id: d2.event!.event_id,
      correlation_id: correlationId,
    });
    expect(d3.accepted).toBe(false);

    consoleSpy.mockRestore();
  });

  it("should not limit events without correlation_id", () => {
    const bus = new EventBus({ maxChainDepth: 1 });

    // Root events have no correlation_id and are never depth-limited
    for (let i = 0; i < 10; i++) {
      const result = bus.emit({
        event_type: "test.root",
        source_type: "manual",
        source_id: `source-${i}`,
      });
      expect(result.accepted).toBe(true);
    }
  });

  it("should track chain depth warning with correlation_id and causation_id", () => {
    const bus = new EventBus({ maxChainDepth: 1 });
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const root = bus.emit({
      event_type: "test.root",
      source_type: "manual",
      source_id: "root",
    });
    const correlationId = root.event!.event_id;

    // Depth 1 — accepted
    const d1 = bus.emit({
      event_type: "test.d1",
      source_type: "invocation_lifecycle",
      source_id: "s1",
      causation_id: root.event!.event_id,
      correlation_id: correlationId,
    });
    expect(d1.accepted).toBe(true);

    // Depth 2 — rejected with identifying info
    const rejected = bus.emit({
      event_type: "test.cycle",
      source_type: "invocation_lifecycle",
      source_id: "s2",
      causation_id: d1.event!.event_id,
      correlation_id: correlationId,
    });

    expect(rejected.accepted).toBe(false);
    // Warning identifies the cycle via correlation_id and causation_id
    const warnCall = consoleSpy.mock.calls[0][0] as string;
    expect(warnCall).toContain(`correlation_id=${correlationId}`);
    expect(warnCall).toContain(`causation_id=${d1.event!.event_id}`);

    consoleSpy.mockRestore();
  });

  it("should allow resetChainDepth to start a new chain", () => {
    const bus = new EventBus({ maxChainDepth: 1 });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const root = bus.emit({
      event_type: "test.root",
      source_type: "manual",
      source_id: "root",
    });
    const correlationId = root.event!.event_id;

    // Use up the chain depth
    bus.emit({
      event_type: "test.d1",
      source_type: "manual",
      source_id: "s1",
      causation_id: root.event!.event_id,
      correlation_id: correlationId,
    });

    // Reset the chain
    bus.resetChainDepth(correlationId);

    // Now same correlation should work again
    const afterReset = bus.emit({
      event_type: "test.after-reset",
      source_type: "manual",
      source_id: "s2",
      causation_id: root.event!.event_id,
      correlation_id: correlationId,
    });
    expect(afterReset.accepted).toBe(true);

    vi.restoreAllMocks();
  });
});

// ─── AC-6: Ring Buffer ──────────────────────────────────────────────────────

// AC: @dispatch-event-envelope ac-6
describe("ac-6: configurable ring buffer for recent event retention", () => {
  it("should retain recent events in a ring buffer (default 500)", () => {
    const bus = new EventBus();

    for (let i = 0; i < 10; i++) {
      bus.emit({
        event_type: `test.event.${i}`,
        source_type: "manual",
        source_id: `source-${i}`,
      });
    }

    const events = bus.getRecentEvents();
    expect(events).toHaveLength(10);
    expect(events[0].event_type).toBe("test.event.0");
    expect(events[9].event_type).toBe("test.event.9");
  });

  it("should drop older events when buffer is full", () => {
    const bus = new EventBus({ ringBufferCapacity: 5 });

    for (let i = 0; i < 8; i++) {
      bus.emit({
        event_type: `test.event.${i}`,
        source_type: "manual",
        source_id: `source-${i}`,
      });
    }

    const events = bus.getRecentEvents();
    expect(events).toHaveLength(5);
    // Oldest events (0,1,2) should be dropped
    expect(events[0].event_type).toBe("test.event.3");
    expect(events[4].event_type).toBe("test.event.7");
  });

  it("should respect configurable capacity", () => {
    const bus = new EventBus({ ringBufferCapacity: 3 });

    for (let i = 0; i < 10; i++) {
      bus.emit({
        event_type: `test.event.${i}`,
        source_type: "manual",
        source_id: `source-${i}`,
      });
    }

    const events = bus.getRecentEvents();
    expect(events).toHaveLength(3);
    expect(events[0].event_type).toBe("test.event.7");
    expect(events[2].event_type).toBe("test.event.9");
  });

  it("should return events in insertion order (oldest to newest)", () => {
    const bus = new EventBus({ ringBufferCapacity: 100 });

    const emittedIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const result = bus.emit({
        event_type: "test.ordered",
        source_type: "manual",
        source_id: `source-${i}`,
      });
      emittedIds.push(result.event!.event_id);
    }

    const events = bus.getRecentEvents();
    const retrievedIds = events.map((e) => e.event_id);
    expect(retrievedIds).toEqual(emittedIds);
  });

  it("should report correct event count", () => {
    const bus = new EventBus({ ringBufferCapacity: 10 });

    expect(bus.getRecentEventCount()).toBe(0);

    for (let i = 0; i < 5; i++) {
      emitBasicEvent(bus, { source_id: `s-${i}` });
    }
    expect(bus.getRecentEventCount()).toBe(5);

    for (let i = 5; i < 15; i++) {
      emitBasicEvent(bus, { source_id: `s-${i}` });
    }
    expect(bus.getRecentEventCount()).toBe(10); // Capped at capacity
  });
});

// ─── Subscribe / Unsubscribe ────────────────────────────────────────────────

describe("subscribe and unsubscribe", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it("should deliver events to matching subscribers", async () => {
    const received: EventEnvelope[] = [];
    bus.subscribe("task.*", (event) => {
      received.push(event);
    });

    bus.emit({
      event_type: "task.ready",
      source_type: "task_watcher",
      source_id: "@task-1",
      payload: { taskId: "1", fromStatus: "pending", toStatus: "in_progress" },
    });

    // Wait for async delivery
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("task.ready");
  });

  it("should not deliver non-matching events", async () => {
    const received: EventEnvelope[] = [];
    bus.subscribe("task.*", (event) => {
      received.push(event);
    });

    bus.emit({
      event_type: "invocation.completed",
      source_type: "invocation_lifecycle",
      source_id: "session-1",
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(0);
  });

  it("should support exact match patterns", async () => {
    const received: EventEnvelope[] = [];
    bus.subscribe("task.ready", (event) => {
      received.push(event);
    });

    bus.emit({
      event_type: "task.ready",
      source_type: "api",
      source_id: "test",
      payload: { taskId: "t", fromStatus: "a", toStatus: "b" },
    });
    bus.emit({
      event_type: "task.in_progress",
      source_type: "api",
      source_id: "test2",
      payload: { taskId: "t2", fromStatus: "a", toStatus: "b" },
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("task.ready");
  });

  it("should support catch-all '*' pattern", async () => {
    const received: EventEnvelope[] = [];
    bus.subscribe("*", (event) => {
      received.push(event);
    });

    bus.emit({ event_type: "task.ready", source_type: "api", source_id: "a", payload: { taskId: "t", fromStatus: "x", toStatus: "y" } });
    bus.emit({ event_type: "invocation.started", source_type: "invocation_lifecycle", source_id: "b" });

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(2);
  });

  it("should unsubscribe correctly", async () => {
    const received: EventEnvelope[] = [];
    const subId = bus.subscribe("*", (event) => {
      received.push(event);
    });

    emitBasicEvent(bus);
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);

    const removed = bus.unsubscribe(subId);
    expect(removed).toBe(true);

    emitBasicEvent(bus, { source_id: "after-unsub" });
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1); // No new delivery
  });

  it("should return false for unknown subscription id", () => {
    expect(bus.unsubscribe("nonexistent")).toBe(false);
  });

  it("should handle subscriber errors without breaking delivery", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const received: string[] = [];

    bus.subscribe("test.*", () => {
      throw new Error("Subscriber error");
    });

    bus.subscribe("test.*", (event) => {
      received.push(event.event_id);
    });

    emitBasicEvent(bus);
    await new Promise((r) => setTimeout(r, 10));

    // Second subscriber should still receive despite first throwing
    expect(received).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Subscriber error"),
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });
});

// ─── Clear / Lifecycle ──────────────────────────────────────────────────────

describe("clear and lifecycle", () => {
  it("should clear all state", () => {
    const bus = new EventBus();

    bus.subscribe("*", () => {});
    emitBasicEvent(bus);

    expect(bus.getRecentEventCount()).toBeGreaterThan(0);

    bus.clear();

    expect(bus.getRecentEventCount()).toBe(0);
    expect(bus.getRecentEvents()).toEqual([]);
  });
});
