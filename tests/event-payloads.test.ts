/**
 * Event Payload Schema tests.
 *
 * Tests for typed payload schemas per event domain: task, invocation,
 * session, schedule, and action. Validates that schemas enforce the
 * payload contracts and that registry payload_fields stay in sync.
 *
 * Task: @task-event-payloads
 * Spec: @dispatch-event-payload
 */

import { describe, it, expect } from "vitest";
import {
  TaskEventPayloadSchema,
  InvocationStartedPayloadSchema,
  InvocationTerminalPayloadSchema,
  SessionEventPayloadSchema,
  WorkSummarySchema,
  ScheduleTickPayloadSchema,
  ActionStartedPayloadSchema,
  ActionTerminalPayloadSchema,
  EVENT_PAYLOAD_SCHEMAS,
  validateEventPayload,
  TASK_PAYLOAD_FIELDS,
  INVOCATION_STARTED_PAYLOAD_FIELDS,
  INVOCATION_TERMINAL_PAYLOAD_FIELDS,
  SESSION_PAYLOAD_FIELDS,
  SCHEDULE_TICK_PAYLOAD_FIELDS,
  ACTION_STARTED_PAYLOAD_FIELDS,
  ACTION_TERMINAL_PAYLOAD_FIELDS,
} from "../src/schema/event-payloads.js";
import {
  EVENT_REGISTRY,
  PAYLOAD_FIELDS_BY_EVENT_TYPE,
} from "../src/schema/event-registry.js";
import { EventBus } from "../src/agent-runtime/event-bus.js";

// ─── AC-1: Task event payloads ──────────────────────────────────────────────

// AC: @dispatch-event-payload ac-1
describe("ac-1: task.* event payloads include required fields", () => {
  const validTaskPayload = {
    task_id: "01JTEST000000000000000000",
    task_ref: "@task-my-feature",
    from_status: "pending",
    to_status: "in_progress",
    task_title: "Implement feature X",
    tags: ["cli", "mvp"],
    priority: 1,
    automation: "eligible",
  };

  it("should accept a valid task event payload with all required fields", () => {
    const result = TaskEventPayloadSchema.safeParse(validTaskPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.task_id).toBe("01JTEST000000000000000000");
      expect(result.data.task_ref).toBe("@task-my-feature");
      expect(result.data.from_status).toBe("pending");
      expect(result.data.to_status).toBe("in_progress");
      expect(result.data.task_title).toBe("Implement feature X");
      expect(result.data.tags).toEqual(["cli", "mvp"]);
      expect(result.data.priority).toBe(1);
      expect(result.data.automation).toBe("eligible");
    }
  });

  it("should accept task payload with nullable title, priority, and automation", () => {
    const payload = {
      ...validTaskPayload,
      task_title: null,
      priority: null,
      automation: null,
    };
    const result = TaskEventPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.task_title).toBeNull();
      expect(result.data.priority).toBeNull();
      expect(result.data.automation).toBeNull();
    }
  });

  it("should accept task payload with string priority", () => {
    const payload = { ...validTaskPayload, priority: "high" };
    const result = TaskEventPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priority).toBe("high");
    }
  });

  it("should accept task payload with empty tags array", () => {
    const payload = { ...validTaskPayload, tags: [] };
    const result = TaskEventPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual([]);
    }
  });

  it("should reject task payload missing required field task_id", () => {
    const { task_id: _, ...missing } = validTaskPayload;
    const result = TaskEventPayloadSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("should reject task payload with invalid status values", () => {
    const result = TaskEventPayloadSchema.safeParse({
      ...validTaskPayload,
      from_status: "invalid_status",
    });
    expect(result.success).toBe(false);
  });

  it("should include all spec-required fields in TASK_PAYLOAD_FIELDS", () => {
    const requiredFields = [
      "task_id", "task_ref", "from_status", "to_status",
      "task_title", "tags", "priority", "automation",
    ];
    for (const field of requiredFields) {
      expect(TASK_PAYLOAD_FIELDS).toContain(field);
    }
  });

  it("should validate task payloads emitted through event bus", () => {
    const bus = new EventBus();
    const result = bus.emit({
      event_type: "task.ready",
      source_type: "task_watcher",
      source_id: "@task-my-feature",
      payload: validTaskPayload,
    });

    expect(result.accepted).toBe(true);
    const validation = validateEventPayload("task.ready", result.event!.payload);
    expect(validation.success).toBe(true);
  });

  it("should register task event payload_fields in the registry matching the schema", () => {
    for (const eventType of ["task.ready", "task.in_progress", "task.needs_work", "task.pending_review"]) {
      const registryFields = PAYLOAD_FIELDS_BY_EVENT_TYPE[eventType];
      expect(registryFields).toBeDefined();
      expect([...registryFields]).toEqual([...TASK_PAYLOAD_FIELDS]);
    }
  });
});

// ─── AC-2: Invocation event payloads ────────────────────────────────────────

// AC: @dispatch-event-payload ac-2
describe("ac-2: invocation.* event payloads include required fields", () => {
  const validStartedPayload = {
    session_id: "01JSESS000000000000000000",
    agent_id: "task-worker",
    trigger: "task.ready",
    task_ref: "@task-my-feature",
  };

  const validTerminalPayload = {
    ...validStartedPayload,
    duration_ms: 120000,
  };

  it("should accept a valid invocation.started payload", () => {
    const result = InvocationStartedPayloadSchema.safeParse(validStartedPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session_id).toBe("01JSESS000000000000000000");
      expect(result.data.agent_id).toBe("task-worker");
      expect(result.data.trigger).toBe("task.ready");
      expect(result.data.task_ref).toBe("@task-my-feature");
    }
  });

  it("should accept invocation.started payload without task_ref (not task-scoped)", () => {
    const { task_ref: _, ...noTaskRef } = validStartedPayload;
    const result = InvocationStartedPayloadSchema.safeParse(noTaskRef);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.task_ref).toBeUndefined();
    }
  });

  it("should accept invocation.started payload with null task_ref", () => {
    const result = InvocationStartedPayloadSchema.safeParse({
      ...validStartedPayload,
      task_ref: null,
    });
    expect(result.success).toBe(true);
  });

  it("should accept a valid invocation terminal payload with duration_ms", () => {
    const result = InvocationTerminalPayloadSchema.safeParse(validTerminalPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.duration_ms).toBe(120000);
      expect(result.data.session_id).toBe("01JSESS000000000000000000");
    }
  });

  it("should reject invocation terminal payload missing duration_ms", () => {
    const { duration_ms: _, ...missing } = validTerminalPayload;
    const result = InvocationTerminalPayloadSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("should reject invocation payload missing session_id", () => {
    const { session_id: _, ...missing } = validStartedPayload;
    const result = InvocationStartedPayloadSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("should include session_id, agent_id, trigger in started payload fields", () => {
    expect(INVOCATION_STARTED_PAYLOAD_FIELDS).toContain("session_id");
    expect(INVOCATION_STARTED_PAYLOAD_FIELDS).toContain("agent_id");
    expect(INVOCATION_STARTED_PAYLOAD_FIELDS).toContain("trigger");
    expect(INVOCATION_STARTED_PAYLOAD_FIELDS).toContain("task_ref");
  });

  it("should include duration_ms in terminal payload fields", () => {
    expect(INVOCATION_TERMINAL_PAYLOAD_FIELDS).toContain("duration_ms");
    expect(INVOCATION_TERMINAL_PAYLOAD_FIELDS).toContain("session_id");
    expect(INVOCATION_TERMINAL_PAYLOAD_FIELDS).toContain("agent_id");
  });

  it("should register invocation.started payload_fields as superset of schema fields", () => {
    const registryFields = PAYLOAD_FIELDS_BY_EVENT_TYPE["invocation.started"];
    expect(registryFields).toBeDefined();
    for (const field of INVOCATION_STARTED_PAYLOAD_FIELDS) {
      expect(registryFields).toContain(field);
    }
  });

  it("should register invocation terminal payload_fields as superset of schema fields", () => {
    for (const eventType of ["invocation.completed", "invocation.failed", "invocation.stalled"]) {
      const registryFields = PAYLOAD_FIELDS_BY_EVENT_TYPE[eventType];
      expect(registryFields).toBeDefined();
      for (const field of INVOCATION_TERMINAL_PAYLOAD_FIELDS) {
        expect(registryFields).toContain(field);
      }
    }
  });

  it("should include event-specific extras in invocation registry fields", () => {
    expect(PAYLOAD_FIELDS_BY_EVENT_TYPE["invocation.completed"]).toContain("outcome");
    expect(PAYLOAD_FIELDS_BY_EVENT_TYPE["invocation.failed"]).toContain("error");
  });

  it("should validate invocation payloads emitted through event bus", () => {
    const bus = new EventBus();
    const result = bus.emit({
      event_type: "invocation.completed",
      source_type: "invocation_lifecycle",
      source_id: "01JSESS000000000000000000",
      payload: validTerminalPayload,
    });

    expect(result.accepted).toBe(true);
    const validation = validateEventPayload("invocation.completed", result.event!.payload);
    expect(validation.success).toBe(true);
  });
});

// ─── AC-3: Session event payloads ───────────────────────────────────────────

// AC: @dispatch-event-payload ac-3
describe("ac-3: session.* event payloads include required fields", () => {
  const validSessionPayload = {
    session_id: "01JSESS000000000000000000",
    agent_id: "task-worker",
    task_ref: "@task-my-feature",
    duration_ms: 300000,
    terminal_reason: "completed",
    work_summary: {
      event_count: 42,
      iteration_count: 3,
      tasks_completed: 1,
    },
  };

  it("should accept a valid session event payload with all required fields", () => {
    const result = SessionEventPayloadSchema.safeParse(validSessionPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session_id).toBe("01JSESS000000000000000000");
      expect(result.data.agent_id).toBe("task-worker");
      expect(result.data.task_ref).toBe("@task-my-feature");
      expect(result.data.duration_ms).toBe(300000);
      expect(result.data.terminal_reason).toBe("completed");
      expect(result.data.work_summary).toMatchObject({
        event_count: 42,
        iteration_count: 3,
        tasks_completed: 1,
      });
    }
  });

  it("should accept session payload without task_ref (not task-scoped)", () => {
    const { task_ref: _, ...noTaskRef } = validSessionPayload;
    const result = SessionEventPayloadSchema.safeParse(noTaskRef);
    expect(result.success).toBe(true);
  });

  it("should accept session payload with null task_ref", () => {
    const result = SessionEventPayloadSchema.safeParse({
      ...validSessionPayload,
      task_ref: null,
    });
    expect(result.success).toBe(true);
  });

  it("should accept session payload with empty work_summary", () => {
    const result = SessionEventPayloadSchema.safeParse({
      ...validSessionPayload,
      work_summary: {},
    });
    expect(result.success).toBe(true);
  });

  it("should accept work_summary with extra fields (passthrough)", () => {
    const result = WorkSummarySchema.safeParse({
      event_count: 10,
      tasks_completed: 2,
      custom_metric: "extra",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).custom_metric).toBe("extra");
    }
  });

  it("should reject session payload missing duration_ms", () => {
    const { duration_ms: _, ...missing } = validSessionPayload;
    const result = SessionEventPayloadSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("should reject session payload missing terminal_reason", () => {
    const { terminal_reason: _, ...missing } = validSessionPayload;
    const result = SessionEventPayloadSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("should include all spec-required fields in SESSION_PAYLOAD_FIELDS", () => {
    const requiredFields = [
      "session_id", "agent_id", "task_ref",
      "duration_ms", "terminal_reason", "work_summary",
    ];
    for (const field of requiredFields) {
      expect(SESSION_PAYLOAD_FIELDS).toContain(field);
    }
  });

  it("should register session event payload_fields matching the schema", () => {
    for (const eventType of ["session.ended", "session.idle_timeout", "session.cancelled"]) {
      const registryFields = PAYLOAD_FIELDS_BY_EVENT_TYPE[eventType];
      expect(registryFields).toBeDefined();
      expect([...registryFields]).toEqual([...SESSION_PAYLOAD_FIELDS]);
    }
  });

  it("should validate session payloads emitted through event bus", () => {
    const bus = new EventBus();
    const result = bus.emit({
      event_type: "session.ended",
      source_type: "invocation_lifecycle",
      source_id: "01JSESS000000000000000000",
      payload: validSessionPayload,
    });

    expect(result.accepted).toBe(true);
    const validation = validateEventPayload("session.ended", result.event!.payload);
    expect(validation.success).toBe(true);
  });
});

// ─── AC-4: Schedule tick event payloads ─────────────────────────────────────

// AC: @dispatch-event-payload ac-4
describe("ac-4: schedule.tick event payloads include required fields", () => {
  const validSchedulePayload = {
    schedule_id: "01JSCHED00000000000000000",
    schedule_name: "hourly-sync",
    tick_time: "2026-03-18T10:00:00.000Z",
    run_count: 42,
  };

  it("should accept a valid schedule.tick payload with all required fields", () => {
    const result = ScheduleTickPayloadSchema.safeParse(validSchedulePayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schedule_id).toBe("01JSCHED00000000000000000");
      expect(result.data.schedule_name).toBe("hourly-sync");
      expect(result.data.tick_time).toBe("2026-03-18T10:00:00.000Z");
      expect(result.data.run_count).toBe(42);
    }
  });

  it("should accept schedule payload with zero run_count", () => {
    const result = ScheduleTickPayloadSchema.safeParse({
      ...validSchedulePayload,
      run_count: 0,
    });
    expect(result.success).toBe(true);
  });

  it("should reject schedule payload missing schedule_id", () => {
    const { schedule_id: _, ...missing } = validSchedulePayload;
    const result = ScheduleTickPayloadSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("should reject schedule payload missing tick_time", () => {
    const { tick_time: _, ...missing } = validSchedulePayload;
    const result = ScheduleTickPayloadSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("should reject schedule payload missing run_count", () => {
    const { run_count: _, ...missing } = validSchedulePayload;
    const result = ScheduleTickPayloadSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("should include all spec-required fields in SCHEDULE_TICK_PAYLOAD_FIELDS", () => {
    const requiredFields = ["schedule_id", "schedule_name", "tick_time", "run_count"];
    for (const field of requiredFields) {
      expect(SCHEDULE_TICK_PAYLOAD_FIELDS).toContain(field);
    }
  });

  it("should register schedule.tick payload_fields matching the schema", () => {
    const registryFields = PAYLOAD_FIELDS_BY_EVENT_TYPE["schedule.tick"];
    expect(registryFields).toBeDefined();
    expect([...registryFields]).toEqual([...SCHEDULE_TICK_PAYLOAD_FIELDS]);
  });

  it("should validate schedule payloads emitted through event bus", () => {
    const bus = new EventBus();
    const result = bus.emit({
      event_type: "schedule.tick",
      source_type: "schedule_engine",
      source_id: "01JSCHED00000000000000000",
      payload: validSchedulePayload,
    });

    expect(result.accepted).toBe(true);
    const validation = validateEventPayload("schedule.tick", result.event!.payload);
    expect(validation.success).toBe(true);
  });
});

// ─── AC-5: Action event payloads ────────────────────────────────────────────

// AC: @dispatch-event-payload ac-5
describe("ac-5: action.* event payloads include required fields", () => {
  const validStartedPayload = {
    action_run_id: "01JACTRUN0000000000000000",
    action_type: "command" as const,
    hook_id: "01JHOOK000000000000000000",
    source_name: "notify-on-ready",
  };

  const validTerminalPayload = {
    action_run_id: "01JACTRUN0000000000000000",
    action_type: "agent" as const,
    schedule_id: "01JSCHED00000000000000000",
    source_name: "hourly-sync",
    duration_ms: 5000,
    session_id: "01JSESS000000000000000000",
  };

  it("should accept a valid action.started payload with hook_id", () => {
    const result = ActionStartedPayloadSchema.safeParse(validStartedPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action_run_id).toBe("01JACTRUN0000000000000000");
      expect(result.data.action_type).toBe("command");
      expect(result.data.hook_id).toBe("01JHOOK000000000000000000");
    }
  });

  it("should accept action.started payload with schedule_id instead of hook_id", () => {
    const result = ActionStartedPayloadSchema.safeParse({
      action_run_id: "01JACTRUN0000000000000000",
      action_type: "kspec",
      schedule_id: "01JSCHED00000000000000000",
      source_name: "nightly-cleanup",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schedule_id).toBe("01JSCHED00000000000000000");
      expect(result.data.hook_id).toBeUndefined();
    }
  });

  it("should accept a valid action terminal payload with duration_ms", () => {
    const result = ActionTerminalPayloadSchema.safeParse(validTerminalPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.duration_ms).toBe(5000);
      expect(result.data.session_id).toBe("01JSESS000000000000000000");
      expect(result.data.action_type).toBe("agent");
    }
  });

  it("should accept action terminal payload with session_id for agent type", () => {
    const result = ActionTerminalPayloadSchema.safeParse(validTerminalPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session_id).toBe("01JSESS000000000000000000");
    }
  });

  it("should accept action terminal payload without session_id for non-agent types", () => {
    const result = ActionTerminalPayloadSchema.safeParse({
      action_run_id: "01JACTRUN0000000000000000",
      action_type: "command",
      hook_id: "01JHOOK000000000000000000",
      duration_ms: 1000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session_id).toBeUndefined();
    }
  });

  it("should reject action payload missing action_run_id", () => {
    const { action_run_id: _, ...missing } = validStartedPayload;
    const result = ActionStartedPayloadSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("should reject action payload with invalid action_type", () => {
    const result = ActionStartedPayloadSchema.safeParse({
      ...validStartedPayload,
      action_type: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("should include hook_id, schedule_id, and session_id in terminal payload fields", () => {
    expect(ACTION_TERMINAL_PAYLOAD_FIELDS).toContain("hook_id");
    expect(ACTION_TERMINAL_PAYLOAD_FIELDS).toContain("schedule_id");
    expect(ACTION_TERMINAL_PAYLOAD_FIELDS).toContain("duration_ms");
    expect(ACTION_TERMINAL_PAYLOAD_FIELDS).toContain("session_id");
  });

  it("should include hook_id and schedule_id in started payload fields", () => {
    expect(ACTION_STARTED_PAYLOAD_FIELDS).toContain("hook_id");
    expect(ACTION_STARTED_PAYLOAD_FIELDS).toContain("schedule_id");
    expect(ACTION_STARTED_PAYLOAD_FIELDS).toContain("action_run_id");
    expect(ACTION_STARTED_PAYLOAD_FIELDS).toContain("action_type");
  });

  it("should register action event payload_fields as superset of schema fields", () => {
    const startedFields = PAYLOAD_FIELDS_BY_EVENT_TYPE["action.started"];
    expect(startedFields).toBeDefined();
    for (const field of ACTION_STARTED_PAYLOAD_FIELDS) {
      expect(startedFields).toContain(field);
    }

    for (const eventType of ["action.completed", "action.failed"]) {
      const registryFields = PAYLOAD_FIELDS_BY_EVENT_TYPE[eventType];
      expect(registryFields).toBeDefined();
      for (const field of ACTION_TERMINAL_PAYLOAD_FIELDS) {
        expect(registryFields).toContain(field);
      }
    }
  });

  it("should include event-specific extras in action registry fields", () => {
    expect(PAYLOAD_FIELDS_BY_EVENT_TYPE["action.failed"]).toContain("error");
    expect(PAYLOAD_FIELDS_BY_EVENT_TYPE["action.failed"]).toContain("failure_reason");
    // All action events include source_event_type for filter matching
    expect(PAYLOAD_FIELDS_BY_EVENT_TYPE["action.started"]).toContain("source_event_type");
    expect(PAYLOAD_FIELDS_BY_EVENT_TYPE["action.completed"]).toContain("source_event_type");
  });

  it("should validate action payloads emitted through event bus", () => {
    const bus = new EventBus();
    const result = bus.emit({
      event_type: "action.completed",
      source_type: "invocation_lifecycle",
      source_id: "01JACTRUN0000000000000000",
      payload: validTerminalPayload,
    });

    expect(result.accepted).toBe(true);
    const validation = validateEventPayload("action.completed", result.event!.payload);
    expect(validation.success).toBe(true);
  });
});

// ─── Cross-cutting: Schema-Registry alignment ──────────────────────────────

describe("event payload schemas align with registry", () => {
  it("should have a payload schema for every registered event type", () => {
    for (const entry of EVENT_REGISTRY) {
      expect(EVENT_PAYLOAD_SCHEMAS[entry.event_type]).toBeDefined();
    }
  });

  it("should have registry payload_fields for every event type", () => {
    for (const entry of EVENT_REGISTRY) {
      expect(entry.payload_fields.length).toBeGreaterThan(0);
    }
  });

  it("should have validateEventPayload accept valid payloads for all event types", () => {
    // Construct minimal valid payloads per domain
    const samplePayloads: Record<string, Record<string, unknown>> = {
      "task.ready": {
        task_id: "01JTEST000000000000000000",
        task_ref: "@test",
        from_status: "pending",
        to_status: "pending",
        task_title: "Test",
        tags: [],
        priority: null,
        automation: null,
      },
      "invocation.started": {
        session_id: "s1",
        agent_id: "a1",
        trigger: "task.ready",
      },
      "invocation.completed": {
        session_id: "s1",
        agent_id: "a1",
        trigger: "task.ready",
        duration_ms: 1000,
      },
      "session.ended": {
        session_id: "s1",
        agent_id: "a1",
        duration_ms: 1000,
        terminal_reason: "completed",
        work_summary: {},
      },
      "schedule.tick": {
        schedule_id: "sc1",
        schedule_name: "test",
        tick_time: "2026-01-01T00:00:00Z",
        run_count: 0,
      },
      "action.started": {
        action_run_id: "ar1",
        action_type: "command",
      },
      "action.completed": {
        action_run_id: "ar1",
        action_type: "command",
        duration_ms: 100,
      },
    };

    // Use same payload for similar events
    samplePayloads["task.in_progress"] = samplePayloads["task.ready"];
    samplePayloads["task.needs_work"] = samplePayloads["task.ready"];
    samplePayloads["task.pending_review"] = samplePayloads["task.ready"];
    samplePayloads["invocation.failed"] = samplePayloads["invocation.completed"];
    samplePayloads["invocation.stalled"] = samplePayloads["invocation.completed"];
    samplePayloads["session.idle_timeout"] = samplePayloads["session.ended"];
    samplePayloads["session.cancelled"] = samplePayloads["session.ended"];
    samplePayloads["action.failed"] = samplePayloads["action.completed"];

    for (const entry of EVENT_REGISTRY) {
      const payload = samplePayloads[entry.event_type];
      expect(payload).toBeDefined();
      const result = validateEventPayload(entry.event_type, payload);
      expect(result.success).toBe(true);
    }
  });

  it("should reject invalid payloads via validateEventPayload", () => {
    const result = validateEventPayload("task.ready", { missing: "fields" });
    expect(result.success).toBe(false);
  });

  it("should accept payloads for unregistered event types (passthrough)", () => {
    const result = validateEventPayload("unknown.event", { anything: "goes" });
    expect(result.success).toBe(true);
  });
});
