/**
 * Session Lifecycle Event tests.
 *
 * Tests for session event emission when dispatch sessions reach terminal states.
 * Covers the mapping from invocation outcomes to session events, payload
 * contracts, and action run closure on invocation terminal states.
 *
 * Task: @task-session-events
 * Spec: @dispatch-event-taxonomy, @dispatch-event-payload
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EventBus, type EventEnvelope } from "../src/agent-runtime/event-bus.js";
import {
  PAYLOAD_FIELDS_BY_EVENT,
  HookEventTypeSchema,
  getValidFilterFields,
  matchesFilter,
} from "../src/schema/hooks.js";
import { KNOWN_EVENT_FIELDS } from "../src/agent-runtime/action-executor.js";
import type { InvocationResult } from "../src/agent-runtime/invocation.js";
import type { SessionMetadata } from "../src/sessions/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal InvocationResult for testing.
 */
function buildInvocationResult(overrides: Partial<InvocationResult> = {}): InvocationResult {
  const session: SessionMetadata = {
    id: "TEST_SESSION_001",
    agent_type: "claude-agent-acp",
    agent_id: "task-worker",
    status: "completed",
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    event_count: 42,
    iteration_count: 3,
    tasks_completed: 2,
    ...overrides.session,
  };

  return {
    session,
    outcome: "success",
    durationMs: 60000,
    ...overrides,
    // Ensure session override merges
    ...(overrides.session ? { session } : {}),
  };
}

/**
 * Simulate the session lifecycle event emission logic from DispatchEngine._emitSessionLifecycleEvent.
 * This mirrors the private method for direct unit testing of the mapping logic.
 */
function emitSessionLifecycleEvent(
  bus: EventBus,
  terminalEvent: {
    type: "completed" | "failed";
    session_id: string;
    agent_id: string;
    // Canonical full task ULID (identity) — kept separate from the display ref.
    task_id: string | undefined;
    // Display task ref (slug or @ULID) for human-readable surfaces only.
    task_ref?: string;
    task_title: string | null;
    status: string;
    timestamp: number;
  },
  invocationResult: InvocationResult | null,
  startedAtMs: number,
): void {
  const outcome =
    invocationResult?.outcome ?? (terminalEvent.type === "completed" ? "success" : "failed");
  const durationMs = invocationResult?.durationMs ?? Date.now() - startedAtMs;

  let sessionEventType: string;
  let terminalReason: string;
  switch (outcome) {
    case "success":
      sessionEventType = "session.ended";
      terminalReason = "completed";
      break;
    case "timed_out":
      sessionEventType = "session.ended";
      terminalReason = "timed_out";
      break;
    case "failed": {
      const isAborted = invocationResult?.error?.includes("aborted by shutdown") ?? false;
      if (isAborted) {
        sessionEventType = "session.cancelled";
        terminalReason = "shutdown";
      } else {
        sessionEventType = "session.ended";
        terminalReason = invocationResult?.error ?? "failed";
      }
      break;
    }
    case "stalled":
      sessionEventType = "session.idle_timeout";
      terminalReason = invocationResult?.error ?? "no initial response";
      break;
    default:
      sessionEventType = "session.ended";
      terminalReason = "unknown";
      break;
  }

  const workSummary: Record<string, unknown> = {};
  if (invocationResult?.session) {
    const session = invocationResult.session;
    if (session.event_count !== undefined) {
      workSummary.event_count = session.event_count;
    }
    if (session.iteration_count !== undefined) {
      workSummary.iteration_count = session.iteration_count;
    }
    if (session.tasks_completed !== undefined) {
      workSummary.tasks_completed = session.tasks_completed;
    }
  }

  // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
  // Mirror production: canonical task_id is the identity field; task_ref is the
  // display alias. They are NOT collapsed into one another.
  const payload: Record<string, unknown> = {
    session_id: terminalEvent.session_id,
    agent_id: terminalEvent.agent_id,
    task_id: terminalEvent.task_id ?? undefined,
    task_ref: terminalEvent.task_ref ?? undefined,
    duration_ms: durationMs,
    terminal_reason: terminalReason,
    work_summary: workSummary,
  };

  bus.emit({
    event_type: sessionEventType,
    source_type: "invocation_lifecycle",
    source_id: terminalEvent.session_id,
    payload,
  });
}

// ─── AC: @dispatch-event-taxonomy ac-2 ──────────────────────────────────────

describe("ac-2: session lifecycle event emission", () => {
  let bus: EventBus;
  let received: EventEnvelope[];

  beforeEach(() => {
    bus = new EventBus();
    received = [];
    bus.subscribe("session.*", (event) => {
      received.push(event);
    });
  });

  // AC: @dispatch-event-taxonomy ac-2
  it("should emit session.ended when invocation completes successfully", async () => {
    const result = buildInvocationResult({ outcome: "success", durationMs: 30000 });

    emitSessionLifecycleEvent(
      bus,
      {
        type: "completed",
        session_id: "SESSION_001",
        agent_id: "task-worker",
        task_id: "@task-foo",
        task_title: "Test task",
        status: "completed",
        timestamp: Date.now(),
      },
      result,
      Date.now() - 30000,
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("session.ended");
    expect(received[0].payload.terminal_reason).toBe("completed");
  });

  // AC: @dispatch-event-taxonomy ac-2
  it("should emit session.ended when invocation times out", async () => {
    const result = buildInvocationResult({
      outcome: "timed_out",
      durationMs: 1800000,
      error: "Agent invocation timed out after 30 minutes",
    });

    emitSessionLifecycleEvent(
      bus,
      {
        type: "failed",
        session_id: "SESSION_002",
        agent_id: "task-worker",
        task_id: "@task-bar",
        task_title: "Timeout task",
        status: "failed",
        timestamp: Date.now(),
      },
      result,
      Date.now() - 1800000,
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("session.ended");
    expect(received[0].payload.terminal_reason).toBe("timed_out");
  });

  // AC: @dispatch-event-taxonomy ac-2
  it("should emit session.ended when invocation fails", async () => {
    const result = buildInvocationResult({
      outcome: "failed",
      durationMs: 5000,
      error: "Spawn failure: ENOENT",
    });

    emitSessionLifecycleEvent(
      bus,
      {
        type: "failed",
        session_id: "SESSION_003",
        agent_id: "task-worker",
        task_id: "@task-baz",
        task_title: "Failed task",
        status: "failed",
        timestamp: Date.now(),
      },
      result,
      Date.now() - 5000,
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("session.ended");
    expect(received[0].payload.terminal_reason).toBe("Spawn failure: ENOENT");
  });

  // AC: @dispatch-event-taxonomy ac-2
  it("should emit session.idle_timeout when invocation stalls", async () => {
    const result = buildInvocationResult({
      outcome: "stalled",
      durationMs: 120000,
      error: "Agent stalled: no initial response within 120s",
    });

    emitSessionLifecycleEvent(
      bus,
      {
        type: "failed",
        session_id: "SESSION_004",
        agent_id: "task-worker",
        task_id: "@task-stall",
        task_title: "Stalled task",
        status: "failed",
        timestamp: Date.now(),
      },
      result,
      Date.now() - 120000,
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("session.idle_timeout");
    expect(received[0].payload.terminal_reason).toContain("no initial response");
  });

  // AC: @dispatch-event-taxonomy ac-2
  it("should emit session.cancelled when invocation is aborted by shutdown", async () => {
    const result = buildInvocationResult({
      outcome: "failed",
      durationMs: 10000,
      error: "Agent invocation aborted by shutdown signal",
    });

    emitSessionLifecycleEvent(
      bus,
      {
        type: "failed",
        session_id: "SESSION_005",
        agent_id: "task-worker",
        task_id: "@task-abort",
        task_title: "Aborted task",
        status: "failed",
        timestamp: Date.now(),
      },
      result,
      Date.now() - 10000,
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("session.cancelled");
    expect(received[0].payload.terminal_reason).toBe("shutdown");
  });

  // AC: @dispatch-event-taxonomy ac-2
  it("should emit session.ended when invocation result is null (fallback)", async () => {
    emitSessionLifecycleEvent(
      bus,
      {
        type: "failed",
        session_id: "SESSION_006",
        agent_id: "task-worker",
        task_id: "@task-null",
        task_title: "Null result task",
        status: "failed",
        timestamp: Date.now(),
      },
      null,
      Date.now() - 5000,
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("session.ended");
    expect(received[0].payload.terminal_reason).toBe("failed");
  });

  // AC: @dispatch-event-taxonomy ac-2
  it("should use invocation_lifecycle as source_type for session events", async () => {
    const result = buildInvocationResult({ outcome: "success" });

    emitSessionLifecycleEvent(
      bus,
      {
        type: "completed",
        session_id: "SESSION_007",
        agent_id: "task-worker",
        task_id: "@task-source",
        task_title: "Source type test",
        status: "completed",
        timestamp: Date.now(),
      },
      result,
      Date.now(),
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(received[0].source_type).toBe("invocation_lifecycle");
    expect(received[0].source_id).toBe("SESSION_007");
  });
});

// ─── AC: @dispatch-event-payload ac-3 ───────────────────────────────────────

describe("ac-3: session event payload contract", () => {
  let bus: EventBus;
  let received: EventEnvelope[];

  beforeEach(() => {
    bus = new EventBus();
    received = [];
    bus.subscribe("session.*", (event) => {
      received.push(event);
    });
  });

  // AC: @dispatch-event-payload ac-3
  // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
  it("should include session_id, agent_id, canonical task_id, display task_ref, duration_ms, terminal_reason in payload", async () => {
    const result = buildInvocationResult({
      outcome: "success",
      durationMs: 45000,
    });

    emitSessionLifecycleEvent(
      bus,
      {
        type: "completed",
        session_id: "PAYLOAD_SESSION_001",
        agent_id: "task-worker",
        // Canonical identity (full ULID) is distinct from the display slug ref.
        task_id: "01HZPAYLOAD0000000000000AA",
        task_ref: "@task-payload",
        task_title: "Payload test",
        status: "completed",
        timestamp: Date.now(),
      },
      result,
      Date.now() - 45000,
    );

    await new Promise((r) => setTimeout(r, 10));

    const payload = received[0].payload;
    expect(payload.session_id).toBe("PAYLOAD_SESSION_001");
    expect(payload.agent_id).toBe("task-worker");
    // Identity and display ref are carried as separate fields.
    expect(payload.task_id).toBe("01HZPAYLOAD0000000000000AA");
    expect(payload.task_ref).toBe("@task-payload");
    expect(payload.duration_ms).toBe(45000);
    expect(payload.terminal_reason).toBe("completed");
  });

  // AC: @dispatch-event-payload ac-3
  it("should include work_summary with session stats", async () => {
    const result = buildInvocationResult({
      outcome: "success",
      durationMs: 60000,
      session: {
        id: "STATS_SESSION",
        agent_type: "claude-agent-acp",
        agent_id: "task-worker",
        status: "completed",
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        event_count: 150,
        iteration_count: 5,
        tasks_completed: 3,
      },
    });

    emitSessionLifecycleEvent(
      bus,
      {
        type: "completed",
        session_id: "STATS_SESSION",
        agent_id: "task-worker",
        task_id: "@task-stats",
        task_title: "Stats test",
        status: "completed",
        timestamp: Date.now(),
      },
      result,
      Date.now() - 60000,
    );

    await new Promise((r) => setTimeout(r, 10));

    const workSummary = received[0].payload.work_summary as Record<string, unknown>;
    expect(workSummary).toBeDefined();
    expect(workSummary.event_count).toBe(150);
    expect(workSummary.iteration_count).toBe(5);
    expect(workSummary.tasks_completed).toBe(3);
  });

  // AC: @dispatch-event-payload ac-3
  // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
  it("should omit both task_id and task_ref when invocation is not task-scoped", async () => {
    const result = buildInvocationResult({ outcome: "success", durationMs: 10000 });

    emitSessionLifecycleEvent(
      bus,
      {
        type: "completed",
        session_id: "UNBOUND_SESSION",
        agent_id: "task-worker",
        task_id: undefined,
        task_ref: undefined,
        task_title: null,
        status: "completed",
        timestamp: Date.now(),
      },
      result,
      Date.now() - 10000,
    );

    await new Promise((r) => setTimeout(r, 10));

    const payload = received[0].payload;
    expect(payload.task_id).toBeUndefined();
    expect(payload.task_ref).toBeUndefined();
  });

  // AC: @dispatch-event-payload ac-3
  it("should provide empty work_summary when invocation result is null", async () => {
    emitSessionLifecycleEvent(
      bus,
      {
        type: "completed",
        session_id: "NULL_RESULT_SESSION",
        agent_id: "task-worker",
        task_id: "@task-null-result",
        task_title: "Null result",
        status: "completed",
        timestamp: Date.now(),
      },
      null,
      Date.now() - 5000,
    );

    await new Promise((r) => setTimeout(r, 10));

    const workSummary = received[0].payload.work_summary as Record<string, unknown>;
    expect(workSummary).toBeDefined();
    expect(Object.keys(workSummary)).toHaveLength(0);
  });

  // AC: @dispatch-event-payload ac-3
  it("should include duration_ms based on invocation result when available", async () => {
    const result = buildInvocationResult({
      outcome: "success",
      durationMs: 99999,
    });

    emitSessionLifecycleEvent(
      bus,
      {
        type: "completed",
        session_id: "DURATION_SESSION",
        agent_id: "task-worker",
        task_id: "@task-duration",
        task_title: "Duration test",
        status: "completed",
        timestamp: Date.now(),
      },
      result,
      Date.now() - 50000, // Different from invocationResult.durationMs
    );

    await new Promise((r) => setTimeout(r, 10));

    // Should use invocationResult.durationMs, not computed from startedAtMs
    expect(received[0].payload.duration_ms).toBe(99999);
  });
});

// ─── Payload Field Registry Consistency ──────────────────────────────────────

describe("session event payload field registries", () => {
  // AC: @dispatch-event-payload ac-3
  it("should register session.ended with correct payload fields", () => {
    const fields = PAYLOAD_FIELDS_BY_EVENT["session.ended"];
    expect(fields).toBeDefined();
    expect(fields).toContain("session_id");
    expect(fields).toContain("agent_id");
    // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
    expect(fields).toContain("task_id");
    expect(fields).toContain("task_ref");
    expect(fields).toContain("duration_ms");
    expect(fields).toContain("terminal_reason");
    expect(fields).toContain("work_summary");
  });

  // AC: @dispatch-event-payload ac-3
  it("should register session.idle_timeout with correct payload fields", () => {
    const fields = PAYLOAD_FIELDS_BY_EVENT["session.idle_timeout"];
    expect(fields).toBeDefined();
    expect(fields).toContain("session_id");
    expect(fields).toContain("agent_id");
    expect(fields).toContain("task_id");
    expect(fields).toContain("task_ref");
    expect(fields).toContain("duration_ms");
    expect(fields).toContain("terminal_reason");
    expect(fields).toContain("work_summary");
  });

  // AC: @dispatch-event-payload ac-3
  it("should register session.cancelled with correct payload fields", () => {
    const fields = PAYLOAD_FIELDS_BY_EVENT["session.cancelled"];
    expect(fields).toBeDefined();
    expect(fields).toContain("session_id");
    expect(fields).toContain("agent_id");
    expect(fields).toContain("task_id");
    expect(fields).toContain("task_ref");
    expect(fields).toContain("duration_ms");
    expect(fields).toContain("terminal_reason");
    expect(fields).toContain("work_summary");
  });

  // AC: @dispatch-event-payload ac-3
  it("should have consistent session fields in KNOWN_EVENT_FIELDS (action-executor)", () => {
    const sessionFields = KNOWN_EVENT_FIELDS["session"];
    expect(sessionFields).toBeDefined();
    // Terminal session event fields
    expect(sessionFields.has("session_id")).toBe(true);
    expect(sessionFields.has("agent_id")).toBe(true);
    // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
    expect(sessionFields.has("task_id")).toBe(true);
    expect(sessionFields.has("task_ref")).toBe(true);
    expect(sessionFields.has("duration_ms")).toBe(true);
    expect(sessionFields.has("terminal_reason")).toBe(true);
    expect(sessionFields.has("work_summary")).toBe(true);
    // AC: @multi-turn-session-lifecycle ac-3 — session.idle per-turn fields
    expect(sessionFields.has("turn_count")).toBe(true);
    expect(sessionFields.has("stop_reason")).toBe(true);
    expect(sessionFields.has("turn_duration_ms")).toBe(true);
  });

  // AC: @dispatch-event-taxonomy ac-2
  it("should register all four session event types in HookEventTypeSchema", () => {
    const validTypes = HookEventTypeSchema.options;
    expect(validTypes).toContain("session.idle");
    expect(validTypes).toContain("session.ended");
    expect(validTypes).toContain("session.idle_timeout");
    expect(validTypes).toContain("session.cancelled");
  });

  // AC: @dispatch-event-payload ac-3
  it("should return valid filter fields for terminal session event types", () => {
    for (const eventType of ["session.ended", "session.idle_timeout", "session.cancelled"]) {
      const fields = getValidFilterFields(eventType);
      expect(fields).toContain("session_id");
      expect(fields).toContain("agent_id");
      expect(fields).toContain("duration_ms");
      expect(fields).toContain("terminal_reason");
      // Envelope fields should also be present
      expect(fields).toContain("event_id");
      expect(fields).toContain("correlation_id");
    }
  });

  // AC: @multi-turn-session-lifecycle ac-3
  it("should return valid filter fields for session.idle event", () => {
    const fields = getValidFilterFields("session.idle");
    expect(fields).toContain("session_id");
    expect(fields).toContain("agent_id");
    expect(fields).toContain("turn_count");
    expect(fields).toContain("stop_reason");
    expect(fields).toContain("turn_duration_ms");
    // Envelope fields should also be present
    expect(fields).toContain("event_id");
    expect(fields).toContain("correlation_id");
  });
});

// ─── Session Event Filter Integration ────────────────────────────────────────

describe("session event filter matching", () => {
  // AC: @dispatch-event-taxonomy ac-2
  it("should match session.ended filter on agent_id", () => {
    const filter = { agent_id: "task-worker" };
    const envelope = { event_type: "session.ended", source_type: "invocation_lifecycle" };
    const payload = { agent_id: "task-worker", session_id: "S1", duration_ms: 60000 };

    expect(matchesFilter(filter, envelope, payload)).toBe(true);
  });

  // AC: @dispatch-event-taxonomy ac-2
  it("should match session.cancelled filter on terminal_reason", () => {
    const filter = { terminal_reason: "shutdown" };
    const envelope = { event_type: "session.cancelled" };
    const payload = { terminal_reason: "shutdown", session_id: "S2" };

    expect(matchesFilter(filter, envelope, payload)).toBe(true);
  });

  // AC: @dispatch-event-taxonomy ac-2
  it("should not match when agent_id differs", () => {
    const filter = { agent_id: "task-worker" };
    const envelope = { event_type: "session.ended" };
    const payload = { agent_id: "pr-reviewer", session_id: "S3" };

    expect(matchesFilter(filter, envelope, payload)).toBe(false);
  });
});

// ─── Action Run Closure on Invocation Terminal States ────────────────────────

describe("action run closure contract", () => {
  // This tests the contract that session events carry the session_id
  // needed for action run closure. When an invocation's session event is
  // emitted, any action run tracking system can subscribe and close
  // linked action runs by matching session_id.

  // AC: @dispatch-event-taxonomy ac-2
  it("should emit session event with session_id that links to action runs", async () => {
    const bus = new EventBus();
    const closedActionRuns: string[] = [];

    // Simulate an action run tracking subscriber that closes action runs
    // when the linked session ends
    bus.subscribe("session.*", (event) => {
      const sessionId = event.payload.session_id as string;
      closedActionRuns.push(sessionId);
    });

    const result = buildInvocationResult({ outcome: "success", durationMs: 30000 });

    emitSessionLifecycleEvent(
      bus,
      {
        type: "completed",
        session_id: "LINKED_SESSION_001",
        agent_id: "task-worker",
        task_id: "@task-linked",
        task_title: "Linked task",
        status: "completed",
        timestamp: Date.now(),
      },
      result,
      Date.now() - 30000,
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(closedActionRuns).toContain("LINKED_SESSION_001");
  });

  // AC: @dispatch-event-taxonomy ac-2
  it("should emit session event for failed invocations to close action runs", async () => {
    const bus = new EventBus();
    const received: EventEnvelope[] = [];
    bus.subscribe("session.*", (event) => {
      received.push(event);
    });

    const result = buildInvocationResult({
      outcome: "failed",
      durationMs: 5000,
      error: "Agent crashed",
    });

    emitSessionLifecycleEvent(
      bus,
      {
        type: "failed",
        session_id: "FAILED_LINKED_SESSION",
        agent_id: "task-worker",
        task_id: "@task-failed-linked",
        task_title: "Failed linked task",
        status: "failed",
        timestamp: Date.now(),
      },
      result,
      Date.now() - 5000,
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("session.ended");
    expect(received[0].payload.session_id).toBe("FAILED_LINKED_SESSION");
  });

  // AC: @dispatch-event-taxonomy ac-2
  it("should emit session.idle_timeout for stalled invocations to close action runs", async () => {
    const bus = new EventBus();
    const received: EventEnvelope[] = [];
    bus.subscribe("session.*", (event) => {
      received.push(event);
    });

    const result = buildInvocationResult({
      outcome: "stalled",
      durationMs: 120000,
      error: "Agent stalled: no initial response within 120s",
    });

    emitSessionLifecycleEvent(
      bus,
      {
        type: "failed",
        session_id: "STALLED_LINKED_SESSION",
        agent_id: "task-worker",
        task_id: "@task-stalled-linked",
        task_title: "Stalled linked task",
        status: "failed",
        timestamp: Date.now(),
      },
      result,
      Date.now() - 120000,
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe("session.idle_timeout");
    expect(received[0].payload.session_id).toBe("STALLED_LINKED_SESSION");
  });
});

// ─── Trait AC Coverage ──────────────────────────────────────────────────────

// AC: @trait-error-guidance ac-1 — N/A: session events are bus emissions, not user-facing CLI commands with error messages
// AC: @trait-error-guidance ac-2 — N/A: session events are bus emissions, not user-facing CLI commands with error messages
// AC: @trait-error-guidance ac-3 — N/A: session events are bus emissions, not user-facing CLI commands with ref lookup
// AC: @trait-error-guidance ac-4 — N/A: session events are bus emissions, not user-facing CLI commands with state transitions
// AC: @trait-error-guidance ac-5 — N/A: session events are bus emissions, not user-facing CLI commands with validation errors
// AC: @trait-error-guidance ac-6 — N/A: session events are bus emissions, not user-facing CLI commands with JSON mode
