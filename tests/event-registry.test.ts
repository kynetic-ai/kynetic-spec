/**
 * Event Registry tests.
 *
 * Tests for the dispatch event type registry: domain grouping, schema
 * validation, backward compatibility, and error guidance.
 *
 * Task: @task-event-schema
 * Spec: @dispatch-event-taxonomy
 */

import { describe, it, expect } from "vitest";
import {
  EVENT_REGISTRY,
  EVENT_DOMAINS,
  EVENTS_BY_DOMAIN,
  REGISTERED_EVENT_TYPES,
  REGISTERED_EVENT_TYPE_SET,
  PAYLOAD_FIELDS_BY_EVENT_TYPE,
  DispatchEventTypeSchema,
  isRegisteredEventType,
  extractEventDomain,
  validateEventType,
  getEventRegistryEntry,
  type EventDomain,
  type DispatchEventType,
} from "../src/schema/event-registry.js";
import {
  AgentDispatchEventSchema,
  AgentDispatchRuleSchema,
  MetaManifestSchema,
} from "../src/schema/meta.js";
import {
  HookEventTypeSchema,
  HookSchema,
  PAYLOAD_FIELDS_BY_EVENT,
} from "../src/schema/hooks.js";
import { SessionTriggerSchema } from "../src/sessions/types.js";
import { EventBus } from "../src/agent-runtime/event-bus.js";
import { testUlid } from "./helpers/cli.js";

// ─── AC-1: Invocation terminal state events ─────────────────────────────────

// AC: @dispatch-event-taxonomy ac-1
describe("ac-1: invocation terminal state events", () => {
  it("should register invocation.completed event", () => {
    expect(isRegisteredEventType("invocation.completed")).toBe(true);
    const entry = getEventRegistryEntry("invocation.completed");
    expect(entry).toBeDefined();
    expect(entry!.domain).toBe("invocation");
    expect(entry!.payload_fields).toContain("session_id");
    expect(entry!.payload_fields).toContain("outcome");
    expect(entry!.payload_fields).toContain("duration_ms");
  });

  it("should register invocation.failed event", () => {
    expect(isRegisteredEventType("invocation.failed")).toBe(true);
    const entry = getEventRegistryEntry("invocation.failed");
    expect(entry).toBeDefined();
    expect(entry!.domain).toBe("invocation");
    expect(entry!.payload_fields).toContain("error");
    expect(entry!.payload_fields).toContain("duration_ms");
  });

  it("should register invocation.stalled event", () => {
    expect(isRegisteredEventType("invocation.stalled")).toBe(true);
    const entry = getEventRegistryEntry("invocation.stalled");
    expect(entry).toBeDefined();
    expect(entry!.domain).toBe("invocation");
    expect(entry!.payload_fields).toContain("duration_ms");
  });

  it("should register invocation.started event", () => {
    expect(isRegisteredEventType("invocation.started")).toBe(true);
    const entry = getEventRegistryEntry("invocation.started");
    expect(entry).toBeDefined();
    expect(entry!.domain).toBe("invocation");
    expect(entry!.payload_fields).toContain("session_id");
    expect(entry!.payload_fields).toContain("agent_id");
    expect(entry!.payload_fields).toContain("task_ref");
  });

  it("should emit invocation events through the event bus with standard envelope", () => {
    const bus = new EventBus();
    const events = ["invocation.completed", "invocation.failed", "invocation.stalled"];

    for (const eventType of events) {
      const result = bus.emit({
        event_type: eventType,
        source_type: "invocation_lifecycle",
        source_id: "session-123",
        payload: { session_id: "session-123", agent_id: "task-worker", duration_ms: 5000 },
      });

      expect(result.accepted).toBe(true);
      expect(result.event).toBeDefined();
      expect(result.event!.event_type).toBe(eventType);
      expect(result.event!.event_id).toBeTruthy();
      expect(result.event!.emitted_at).toBeGreaterThan(0);
      expect(result.event!.source_type).toBe("invocation_lifecycle");
    }
  });
});

// ─── AC-2: Session terminal state events ─────────────────────────────────────

// AC: @dispatch-event-taxonomy ac-2
describe("ac-2: session terminal state events", () => {
  it("should register session.ended event with required payload fields", () => {
    expect(isRegisteredEventType("session.ended")).toBe(true);
    const entry = getEventRegistryEntry("session.ended");
    expect(entry).toBeDefined();
    expect(entry!.domain).toBe("session");
    expect(entry!.payload_fields).toContain("session_id");
    expect(entry!.payload_fields).toContain("agent_id");
    expect(entry!.payload_fields).toContain("task_ref");
    expect(entry!.payload_fields).toContain("duration");
    expect(entry!.payload_fields).toContain("reason");
  });

  it("should register session.idle_timeout event", () => {
    expect(isRegisteredEventType("session.idle_timeout")).toBe(true);
    const entry = getEventRegistryEntry("session.idle_timeout");
    expect(entry).toBeDefined();
    expect(entry!.domain).toBe("session");
    expect(entry!.payload_fields).toContain("session_id");
    expect(entry!.payload_fields).toContain("duration");
  });

  it("should register session.cancelled event", () => {
    expect(isRegisteredEventType("session.cancelled")).toBe(true);
    const entry = getEventRegistryEntry("session.cancelled");
    expect(entry).toBeDefined();
    expect(entry!.domain).toBe("session");
    expect(entry!.payload_fields).toContain("session_id");
    expect(entry!.payload_fields).toContain("reason");
  });

  it("should emit session events through the event bus with standard envelope", () => {
    const bus = new EventBus();

    const result = bus.emit({
      event_type: "session.ended",
      source_type: "invocation_lifecycle",
      source_id: "session-456",
      payload: {
        session_id: "session-456",
        agent_id: "task-worker",
        task_ref: "@task-foo",
        duration: 120000,
        reason: "agent_responded",
      },
    });

    expect(result.accepted).toBe(true);
    expect(result.event!.event_type).toBe("session.ended");
    expect(result.event!.payload).toMatchObject({
      session_id: "session-456",
      agent_id: "task-worker",
      task_ref: "@task-foo",
      duration: 120000,
      reason: "agent_responded",
    });
  });
});

// ─── AC-3: Invalid event type validation ─────────────────────────────────────

// AC: @dispatch-event-taxonomy ac-3
describe("ac-3: invalid event type validation", () => {
  it("should reject an unregistered event type via schema", () => {
    const result = DispatchEventTypeSchema.safeParse("task.unknown");
    expect(result.success).toBe(false);
  });

  it("should reject an event with unknown domain via schema", () => {
    const result = DispatchEventTypeSchema.safeParse("webhook.fired");
    expect(result.success).toBe(false);
  });

  it("should reject a malformed event type without dot", () => {
    const result = DispatchEventTypeSchema.safeParse("taskready");
    expect(result.success).toBe(false);
  });

  it("should identify invalid event and list valid events in known domain", () => {
    const result = validateEventType("task.unknown");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.invalid_event).toBe("task.unknown");
    expect(result.error!.parsed_domain).toBe("task");
    expect(result.error!.message).toContain("Unknown event type 'task.unknown'");
    expect(result.error!.message).toContain("task.ready");
    expect(result.error!.message).toContain("task.in_progress");
    // Valid events should only be task.* domain events
    expect(result.error!.valid_events).toContain("task.ready");
    expect(result.error!.valid_events).toContain("task.in_progress");
    expect(result.error!.valid_events).not.toContain("invocation.completed");
  });

  it("should identify unknown domain and list all valid domains", () => {
    const result = validateEventType("webhook.fired");
    expect(result.valid).toBe(false);
    expect(result.error!.parsed_domain).toBe("webhook");
    expect(result.error!.message).toContain("Unknown event domain 'webhook'");
    expect(result.error!.message).toContain("task");
    expect(result.error!.message).toContain("invocation");
    expect(result.error!.message).toContain("session");
  });

  it("should handle malformed event type without dot separator", () => {
    const result = validateEventType("nodot");
    expect(result.valid).toBe(false);
    expect(result.error!.parsed_domain).toBeUndefined();
    expect(result.error!.message).toContain("dotted-namespace format");
  });

  it("should accept all registered event types as valid", () => {
    for (const eventType of REGISTERED_EVENT_TYPES) {
      const result = validateEventType(eventType);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    }
  });

  it("should reject invalid event types in dispatch rules", () => {
    const rule = {
      on: "task.unknown",
      filter: { automation: "eligible" },
    };
    const result = AgentDispatchRuleSchema.safeParse(rule);
    expect(result.success).toBe(false);
  });

  it("should reject invalid event types in hook definitions", () => {
    const hook = {
      _ulid: testUlid("HOOK", 1),
      name: "bad-hook",
      on: "webhook.fired",
      action: { type: "command", command: "echo", args: ["hello"] },
    };
    const result = HookSchema.safeParse(hook);
    expect(result.success).toBe(false);
  });
});

// ─── AC-4: Backward compatibility ───────────────────────────────────────────

// AC: @dispatch-event-taxonomy ac-4
describe("ac-4: existing dispatch rules function identically", () => {
  const existingTaskEvents = [
    "task.in_progress",
    "task.ready",
    "task.needs_work",
    "task.pending_review",
  ] as const;

  it("should accept all original 4 task events in AgentDispatchEventSchema", () => {
    for (const event of existingTaskEvents) {
      const result = AgentDispatchEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });

  it("should accept existing dispatch rules unchanged", () => {
    for (const event of existingTaskEvents) {
      const rule = {
        on: event,
        filter: { automation: "eligible" },
      };
      const result = AgentDispatchRuleSchema.safeParse(rule);
      expect(result.success).toBe(true);
    }
  });

  it("should accept existing agent definitions with task event dispatch rules", () => {
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

  it("should accept existing task events in SessionTriggerSchema", () => {
    for (const event of existingTaskEvents) {
      const result = SessionTriggerSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
    // Also verify manual and legacy still work
    expect(SessionTriggerSchema.safeParse("manual").success).toBe(true);
    expect(SessionTriggerSchema.safeParse("legacy").success).toBe(true);
  });

  it("should register all 4 original task events in the registry", () => {
    for (const event of existingTaskEvents) {
      expect(isRegisteredEventType(event)).toBe(true);
      const entry = getEventRegistryEntry(event);
      expect(entry).toBeDefined();
      expect(entry!.domain).toBe("task");
    }
  });
});

// ─── AC-5: Event matches both dispatch rule and hook ────────────────────────

// AC: @dispatch-event-taxonomy ac-5
describe("ac-5: event matches both dispatch rule and hook independently", () => {
  it("should accept the same event type in both dispatch rules and hooks", () => {
    // Dispatch rule for task.ready
    const dispatchRule = { on: "task.ready", filter: { automation: "eligible" } };
    const ruleResult = AgentDispatchRuleSchema.safeParse(dispatchRule);
    expect(ruleResult.success).toBe(true);

    // Hook for task.ready
    const hook = {
      _ulid: testUlid("HOOK", 1),
      name: "notify-task-ready",
      on: "task.ready",
      action: { type: "command", command: "echo", args: ["ready!"] },
    };
    const hookResult = HookSchema.safeParse(hook);
    expect(hookResult.success).toBe(true);

    // Both use the same schema, validated independently
    expect(ruleResult.data!.on).toBe(hookResult.data!.on);
  });

  it("should allow hooks for event types not used by dispatch rules", () => {
    // action.completed is valid for hooks but may not be used by dispatch
    const hook = {
      _ulid: testUlid("HOOK", 2),
      name: "log-action-completed",
      on: "action.completed",
      action: { type: "command", command: "echo", args: ["action done"] },
    };
    const result = HookSchema.safeParse(hook);
    expect(result.success).toBe(true);
  });

  it("should allow dispatch rules for new event types alongside hooks", () => {
    // Dispatch rule for invocation.completed
    const dispatchRule = { on: "invocation.completed" };
    const ruleResult = AgentDispatchRuleSchema.safeParse(dispatchRule);
    expect(ruleResult.success).toBe(true);

    // Hook for invocation.completed
    const hook = {
      _ulid: testUlid("HOOK", 3),
      name: "on-invocation-complete",
      on: "invocation.completed",
      action: { type: "kspec", command: "task note @ref 'Invocation done'" },
    };
    const hookResult = HookSchema.safeParse(hook);
    expect(hookResult.success).toBe(true);
  });
});

// ─── Registry Structure Tests ────────────────────────────────────────────────

describe("Event Registry structure", () => {
  it("should define all 5 event domains", () => {
    expect(EVENT_DOMAINS).toContain("task");
    expect(EVENT_DOMAINS).toContain("invocation");
    expect(EVENT_DOMAINS).toContain("session");
    expect(EVENT_DOMAINS).toContain("schedule");
    expect(EVENT_DOMAINS).toContain("action");
    expect(EVENT_DOMAINS).toHaveLength(5);
  });

  it("should group events by domain correctly", () => {
    expect(EVENTS_BY_DOMAIN.task.length).toBe(4);
    expect(EVENTS_BY_DOMAIN.invocation.length).toBe(4);
    expect(EVENTS_BY_DOMAIN.session.length).toBe(3);
    expect(EVENTS_BY_DOMAIN.schedule.length).toBe(1);
    expect(EVENTS_BY_DOMAIN.action.length).toBe(3);
  });

  it("should have all registry entries with non-empty payload_fields", () => {
    for (const entry of EVENT_REGISTRY) {
      expect(entry.event_type).toBeTruthy();
      expect(entry.domain).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.payload_fields.length).toBeGreaterThan(0);
    }
  });

  it("should register exactly 15 event types", () => {
    expect(REGISTERED_EVENT_TYPES).toHaveLength(15);
    expect(REGISTERED_EVENT_TYPE_SET.size).toBe(15);
  });

  it("should have consistent PAYLOAD_FIELDS_BY_EVENT_TYPE for all registered events", () => {
    for (const entry of EVENT_REGISTRY) {
      const fields = PAYLOAD_FIELDS_BY_EVENT_TYPE[entry.event_type];
      expect(fields).toBeDefined();
      expect(fields).toEqual(entry.payload_fields);
    }
  });

  it("should make hooks PAYLOAD_FIELDS_BY_EVENT match registry", () => {
    // The hooks module re-exports the registry's payload fields
    expect(PAYLOAD_FIELDS_BY_EVENT).toBe(PAYLOAD_FIELDS_BY_EVENT_TYPE);
  });

  it("should have HookEventTypeSchema accept all registered events", () => {
    for (const eventType of REGISTERED_EVENT_TYPES) {
      const result = HookEventTypeSchema.safeParse(eventType);
      expect(result.success).toBe(true);
    }
  });

  it("should have AgentDispatchEventSchema accept all registered events", () => {
    for (const eventType of REGISTERED_EVENT_TYPES) {
      const result = AgentDispatchEventSchema.safeParse(eventType);
      expect(result.success).toBe(true);
    }
  });

  it("should have extractEventDomain parse domain from dotted name", () => {
    expect(extractEventDomain("task.ready")).toBe("task");
    expect(extractEventDomain("invocation.completed")).toBe("invocation");
    expect(extractEventDomain("session.ended")).toBe("session");
    expect(extractEventDomain("schedule.tick")).toBe("schedule");
    expect(extractEventDomain("action.failed")).toBe("action");
    expect(extractEventDomain("nodot")).toBeUndefined();
  });
});

// ─── Session Trigger Expansion Tests ────────────────────────────────────────

describe("SessionTriggerSchema expansion", () => {
  it("should accept new invocation event triggers", () => {
    for (const event of ["invocation.started", "invocation.completed", "invocation.failed", "invocation.stalled"]) {
      const result = SessionTriggerSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });

  it("should accept new session event triggers", () => {
    for (const event of ["session.ended", "session.idle_timeout", "session.cancelled"]) {
      const result = SessionTriggerSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });

  it("should accept schedule and action triggers", () => {
    for (const event of ["schedule.tick", "action.started", "action.completed", "action.failed"]) {
      const result = SessionTriggerSchema.safeParse(event);
      expect(result.success).toBe(true);
    }
  });

  it("should still reject unregistered trigger values", () => {
    expect(SessionTriggerSchema.safeParse("webhook.fired").success).toBe(false);
    expect(SessionTriggerSchema.safeParse("task.unknown").success).toBe(false);
  });
});

// ─── Trait AC Coverage ───────────────────────────────────────────────────────

// AC: @trait-error-guidance ac-1
describe("@trait-error-guidance ac-1: error includes description of what went wrong", () => {
  it("should describe unknown event type in known domain", () => {
    const result = validateEventType("task.unknown");
    expect(result.error!.message).toContain("Unknown event type");
    expect(result.error!.message).toContain("task.unknown");
  });

  it("should describe unknown domain", () => {
    const result = validateEventType("webhook.fired");
    expect(result.error!.message).toContain("Unknown event domain");
    expect(result.error!.message).toContain("webhook");
  });

  it("should describe malformed event type", () => {
    const result = validateEventType("nodot");
    expect(result.error!.message).toContain("Invalid event type");
    expect(result.error!.message).toContain("nodot");
  });
});

// AC: @trait-error-guidance ac-2
describe("@trait-error-guidance ac-2: error includes suggested action", () => {
  it("should suggest valid event types within known domain", () => {
    const result = validateEventType("task.unknown");
    expect(result.error!.suggestion).toContain("task.*");
  });

  it("should suggest valid domains for unknown domain", () => {
    const result = validateEventType("webhook.fired");
    expect(result.error!.suggestion).toContain("task");
    expect(result.error!.suggestion).toContain("invocation");
  });

  it("should suggest dotted-namespace format for malformed type", () => {
    const result = validateEventType("nodot");
    expect(result.error!.suggestion).toContain("dotted-namespace");
  });
});

// AC: @trait-error-guidance ac-5
describe("@trait-error-guidance ac-5: validation error indicates field/value", () => {
  it("should include the invalid event type value", () => {
    const result = validateEventType("task.bogus");
    expect(result.error!.invalid_event).toBe("task.bogus");
  });

  it("should include the parsed domain", () => {
    const result = validateEventType("session.bogus");
    expect(result.error!.parsed_domain).toBe("session");
  });

  it("should list valid events for the domain", () => {
    const result = validateEventType("action.bogus");
    expect(result.error!.valid_events).toContain("action.started");
    expect(result.error!.valid_events).toContain("action.completed");
    expect(result.error!.valid_events).toContain("action.failed");
  });
});

// AC: @trait-error-guidance ac-3 — N/A: validateEventType handles event type strings, not refs.
// Reference lookup suggestions are handled at the CLI layer, not the schema validation layer.

// AC: @trait-error-guidance ac-4 — N/A: validateEventType does not handle state transitions.
// State transition errors are handled by the task state machine, not event type validation.

// AC: @trait-error-guidance ac-6 — N/A: validateEventType returns structured error objects directly.
// JSON mode formatting is handled by the CLI command layer, not schema validation functions.
