/**
 * Session Idle Event tests.
 *
 * Tests for the session.idle event type: registration in the event taxonomy,
 * payload schema validation, hook filter integration, and backward
 * compatibility with existing configurations.
 *
 * Task: @task-session-idle-event
 * Spec: @session-idle-event
 */

import { describe, it, expect } from "vitest";
import {
  EVENT_REGISTRY,
  EVENTS_BY_DOMAIN,
  REGISTERED_EVENT_TYPES,
  PAYLOAD_FIELDS_BY_EVENT_TYPE,
  DispatchEventTypeSchema,
  isRegisteredEventType,
  getEventRegistryEntry,
} from "../src/schema/event-registry.js";
import {
  SessionIdlePayloadSchema,
  SESSION_IDLE_PAYLOAD_FIELDS,
  SessionEventPayloadSchema,
  EVENT_PAYLOAD_SCHEMAS,
  validateEventPayload,
} from "../src/schema/event-payloads.js";
import {
  AgentDispatchEventSchema,
  AgentDispatchRuleSchema,
  MetaManifestSchema,
} from "../src/schema/meta.js";
import {
  HookEventTypeSchema,
  HookSchema,
  getValidFilterFields,
  validateHookFilter,
} from "../src/schema/hooks.js";
import { SessionTriggerSchema } from "../src/sessions/types.js";
import { EventBus } from "../src/agent-runtime/event-bus.js";
import { testUlid } from "./helpers/cli.js";

// ─── AC-1: Session idle event emitted with required context ─────────────────

// AC: @session-idle-event ac-1
describe("ac-1: session.idle event emitted with session context, agent identity, task ref, turn count, stop reason, and duration", () => {
  const validIdlePayload = {
    session_id: "01JSESS000000000000000000",
    agent_id: "task-worker",
    task_ref: "@task-my-feature",
    turn_count: 1,
    stop_reason: "end_turn",
    turn_duration_ms: 45000,
  };

  it("should register session.idle in the event registry", () => {
    expect(isRegisteredEventType("session.idle")).toBe(true);
    const entry = getEventRegistryEntry("session.idle");
    expect(entry).toBeDefined();
    expect(entry!.domain).toBe("session");
    expect(entry!.description).toContain("idle");
  });

  it("should include session.idle in the session domain group", () => {
    const sessionEvents = EVENTS_BY_DOMAIN.session;
    const idleEntry = sessionEvents.find((e) => e.event_type === "session.idle");
    expect(idleEntry).toBeDefined();
  });

  it("should have payload fields for session_id, agent_id, task_ref, turn_count, stop_reason, turn_duration_ms", () => {
    const entry = getEventRegistryEntry("session.idle");
    expect(entry!.payload_fields).toContain("session_id");
    expect(entry!.payload_fields).toContain("agent_id");
    expect(entry!.payload_fields).toContain("task_ref");
    expect(entry!.payload_fields).toContain("turn_count");
    expect(entry!.payload_fields).toContain("stop_reason");
    expect(entry!.payload_fields).toContain("turn_duration_ms");
  });

  it("should accept a valid session.idle payload with all required fields", () => {
    const result = SessionIdlePayloadSchema.safeParse(validIdlePayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session_id).toBe("01JSESS000000000000000000");
      expect(result.data.agent_id).toBe("task-worker");
      expect(result.data.task_ref).toBe("@task-my-feature");
      expect(result.data.turn_count).toBe(1);
      expect(result.data.stop_reason).toBe("end_turn");
      expect(result.data.turn_duration_ms).toBe(45000);
    }
  });

  it("should accept session.idle payload with null task_ref", () => {
    const result = SessionIdlePayloadSchema.safeParse({
      ...validIdlePayload,
      task_ref: null,
    });
    expect(result.success).toBe(true);
  });

  it("should accept session.idle payload without task_ref (not task-scoped)", () => {
    const { task_ref: _, ...noTaskRef } = validIdlePayload;
    const result = SessionIdlePayloadSchema.safeParse(noTaskRef);
    expect(result.success).toBe(true);
  });

  it("should reject session.idle payload missing turn_count", () => {
    const { turn_count: _, ...missing } = validIdlePayload;
    const result = SessionIdlePayloadSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("should accept session.idle payload without stop_reason (optional field)", () => {
    const { stop_reason: _, ...noStopReason } = validIdlePayload;
    const result = SessionIdlePayloadSchema.safeParse(noStopReason);
    expect(result.success).toBe(true);
  });

  it("should reject session.idle payload missing turn_duration_ms", () => {
    const { turn_duration_ms: _, ...missing } = validIdlePayload;
    const result = SessionIdlePayloadSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("should reject session.idle payload with turn_count of 0 (must be positive)", () => {
    const result = SessionIdlePayloadSchema.safeParse({
      ...validIdlePayload,
      turn_count: 0,
    });
    expect(result.success).toBe(false);
  });

  it("should not include terminal_reason or work_summary in session.idle payload fields", () => {
    expect(SESSION_IDLE_PAYLOAD_FIELDS).not.toContain("terminal_reason");
    expect(SESSION_IDLE_PAYLOAD_FIELDS).not.toContain("work_summary");
  });

  it("should have a payload schema registered for session.idle", () => {
    expect(EVENT_PAYLOAD_SCHEMAS["session.idle"]).toBeDefined();
    expect(EVENT_PAYLOAD_SCHEMAS["session.idle"]).toBe(SessionIdlePayloadSchema);
  });

  it("should validate session.idle payloads via validateEventPayload", () => {
    const result = validateEventPayload("session.idle", validIdlePayload);
    expect(result.success).toBe(true);
  });

  it("should reject invalid session.idle payloads via validateEventPayload", () => {
    const result = validateEventPayload("session.idle", { missing: "fields" });
    expect(result.success).toBe(false);
  });

  it("should emit session.idle through the event bus with standard envelope", () => {
    const bus = new EventBus();
    const result = bus.emit({
      event_type: "session.idle",
      source_type: "invocation_lifecycle",
      source_id: "01JSESS000000000000000000",
      payload: validIdlePayload,
    });

    expect(result.accepted).toBe(true);
    expect(result.event!.event_type).toBe("session.idle");
    expect(result.event!.payload).toMatchObject(validIdlePayload);
    expect(result.event!.event_id).toBeTruthy();
    expect(result.event!.emitted_at).toBeGreaterThan(0);
  });

  it("should accept session.idle in the DispatchEventTypeSchema", () => {
    const result = DispatchEventTypeSchema.safeParse("session.idle");
    expect(result.success).toBe(true);
  });

  it("should accept session.idle in the HookEventTypeSchema", () => {
    const result = HookEventTypeSchema.safeParse("session.idle");
    expect(result.success).toBe(true);
  });

  it("should accept session.idle in the AgentDispatchEventSchema", () => {
    const result = AgentDispatchEventSchema.safeParse("session.idle");
    expect(result.success).toBe(true);
  });

  it("should accept session.idle in the SessionTriggerSchema", () => {
    const result = SessionTriggerSchema.safeParse("session.idle");
    expect(result.success).toBe(true);
  });
});

// ─── AC-2: Turn count reflects cumulative completed turns ────────────────────

// AC: @session-idle-event ac-2
describe("ac-2: turn count reflects cumulative number of completed turns", () => {
  it("should accept turn_count of 3 for a third-turn idle event", () => {
    const result = SessionIdlePayloadSchema.safeParse({
      session_id: "01JSESS000000000000000000",
      agent_id: "task-worker",
      task_ref: "@task-foo",
      turn_count: 3,
      stop_reason: "end_turn",
      turn_duration_ms: 30000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.turn_count).toBe(3);
    }
  });

  it("should accept incrementing turn_count values across sequential idle events", () => {
    const bus = new EventBus();

    for (let turn = 1; turn <= 3; turn++) {
      const result = bus.emit({
        event_type: "session.idle",
        source_type: "invocation_lifecycle",
        source_id: "01JSESS000000000000000000",
        payload: {
          session_id: "01JSESS000000000000000000",
          agent_id: "task-worker",
          task_ref: "@task-foo",
          turn_count: turn,
          stop_reason: "end_turn",
          turn_duration_ms: 10000 * turn,
        },
      });

      expect(result.accepted).toBe(true);
      expect(result.event!.payload.turn_count).toBe(turn);
    }
  });

  it("should enforce turn_count as a positive integer", () => {
    // Fractional turn_count should be rejected
    const fractional = SessionIdlePayloadSchema.safeParse({
      session_id: "s1",
      agent_id: "a1",
      turn_count: 1.5,
      stop_reason: "end_turn",
      turn_duration_ms: 1000,
    });
    expect(fractional.success).toBe(false);

    // Negative turn_count should be rejected
    const negative = SessionIdlePayloadSchema.safeParse({
      session_id: "s1",
      agent_id: "a1",
      turn_count: -1,
      stop_reason: "end_turn",
      turn_duration_ms: 1000,
    });
    expect(negative.success).toBe(false);
  });
});

// ─── AC-3: Hook filter on turn_count or agent ────────────────────────────────

// AC: @session-idle-event ac-3
describe("ac-3: hook filter on turn_count or agent filters session.idle events", () => {
  it("should accept a hook configured on session.idle", () => {
    const hook = {
      _ulid: testUlid("HOOK", 1),
      name: "on-session-idle",
      on: "session.idle",
      action: { type: "command", command: "echo", args: ["idle"] },
    };
    const result = HookSchema.safeParse(hook);
    expect(result.success).toBe(true);
  });

  it("should accept a hook on session.idle with filter on agent_id", () => {
    const hook = {
      _ulid: testUlid("HOOK", 2),
      name: "on-idle-worker",
      on: "session.idle",
      filter: { agent_id: "task-worker" },
      action: { type: "command", command: "echo", args: ["worker idle"] },
    };
    const result = HookSchema.safeParse(hook);
    expect(result.success).toBe(true);
  });

  it("should accept a hook on session.idle with filter on turn_count", () => {
    const hook = {
      _ulid: testUlid("HOOK", 3),
      name: "on-third-turn",
      on: "session.idle",
      filter: { turn_count: 3 },
      action: { type: "command", command: "echo", args: ["third turn"] },
    };
    const result = HookSchema.safeParse(hook);
    expect(result.success).toBe(true);
  });

  it("should include turn_count and agent_id as valid filter fields for session.idle", () => {
    const validFields = getValidFilterFields("session.idle");
    expect(validFields).toContain("turn_count");
    expect(validFields).toContain("agent_id");
    expect(validFields).toContain("session_id");
    expect(validFields).toContain("stop_reason");
    expect(validFields).toContain("turn_duration_ms");
  });

  it("should warn when filtering on unknown fields for session.idle", () => {
    const warnings = validateHookFilter(
      "test-hook",
      "session.idle",
      { nonexistent_field: "value" },
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].field).toBe("nonexistent_field");
  });

  it("should not warn when filtering on valid session.idle payload fields", () => {
    const warnings = validateHookFilter(
      "test-hook",
      "session.idle",
      { turn_count: 3, agent_id: "task-worker" },
    );
    expect(warnings).toHaveLength(0);
  });

  it("should accept a dispatch rule on session.idle", () => {
    const rule = { on: "session.idle" };
    const result = AgentDispatchRuleSchema.safeParse(rule);
    expect(result.success).toBe(true);
  });

  it("should accept a dispatch rule on session.idle with filter", () => {
    const rule = { on: "session.idle", filter: { automation: "eligible" } };
    const result = AgentDispatchRuleSchema.safeParse(rule);
    expect(result.success).toBe(true);
  });
});

// ─── AC-4: Existing configurations are unaffected ────────────────────────────

// AC: @session-idle-event ac-4
describe("ac-4: existing hooks and dispatch rules targeting other event types are unaffected", () => {
  const existingSessionEvents = [
    "session.ended",
    "session.idle_timeout",
    "session.cancelled",
  ] as const;

  const existingTaskEvents = [
    "task.in_progress",
    "task.ready",
    "task.needs_work",
    "task.pending_review",
  ] as const;

  it("should still register all existing session terminal events", () => {
    for (const event of existingSessionEvents) {
      expect(isRegisteredEventType(event)).toBe(true);
      const entry = getEventRegistryEntry(event);
      expect(entry).toBeDefined();
      expect(entry!.domain).toBe("session");
    }
  });

  it("should not change payload fields for existing session terminal events", () => {
    for (const event of existingSessionEvents) {
      const fields = PAYLOAD_FIELDS_BY_EVENT_TYPE[event];
      expect(fields).toContain("session_id");
      expect(fields).toContain("agent_id");
      expect(fields).toContain("terminal_reason");
      expect(fields).toContain("work_summary");
      expect(fields).toContain("duration_ms");
    }
  });

  it("should still accept existing task dispatch rules", () => {
    for (const event of existingTaskEvents) {
      const rule = { on: event, filter: { automation: "eligible" } };
      const result = AgentDispatchRuleSchema.safeParse(rule);
      expect(result.success).toBe(true);
    }
  });

  it("should still accept existing hooks targeting session terminal events", () => {
    for (const event of existingSessionEvents) {
      const hook = {
        _ulid: testUlid("HOOK", 10),
        name: `on-${event.replace(".", "-")}`,
        on: event,
        action: { type: "command", command: "echo", args: [event] },
      };
      const result = HookSchema.safeParse(hook);
      expect(result.success).toBe(true);
    }
  });

  it("should still accept existing agent definitions with task event dispatch rules", () => {
    const agentDef = {
      _ulid: testUlid("AGNT", 1),
      id: "task-worker",
      name: "Task Worker",
      dispatch: [
        { on: "task.ready", filter: { automation: "eligible" } },
        { on: "task.in_progress", filter: { automation: "eligible" } },
        { on: "task.needs_work", filter: { automation: "eligible" } },
      ],
    };

    const manifest = {
      kynetic_meta: "1.0",
      agents: [agentDef],
    };

    const result = MetaManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it("should still accept all existing event types in SessionTriggerSchema", () => {
    const allExisting = [
      "manual", "legacy",
      ...existingTaskEvents,
      ...existingSessionEvents,
      "invocation.started", "invocation.completed", "invocation.failed", "invocation.stalled",
      "schedule.tick",
      "action.started", "action.completed", "action.failed",
    ];
    for (const event of allExisting) {
      const result = SessionTriggerSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });

  it("should still validate existing session terminal payloads correctly", () => {
    const terminalPayload = {
      session_id: "s1",
      agent_id: "a1",
      duration_ms: 1000,
      terminal_reason: "completed",
      work_summary: {},
    };

    for (const event of existingSessionEvents) {
      const result = validateEventPayload(event, terminalPayload);
      expect(result.success).toBe(true);
    }
  });
});
