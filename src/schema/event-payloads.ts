/**
 * Event Payload Schemas
 *
 * Typed Zod schemas defining the guaranteed payload fields for each event
 * domain. These are the fields that hook filters can match on and template
 * variables can reference, beyond the universal event envelope.
 *
 * Spec: @dispatch-event-payload
 * Task: @task-event-payloads
 */

import { z } from "zod";
import { TaskStatusSchema } from "./common.js";

// ─── Task Event Payloads ────────────────────────────────────────────────────

/**
 * Payload for task.* events.
 *
 * Enriched beyond bare state transitions — includes task metadata so hook
 * filters can match on tags, priority, and automation status, not just
 * state changes.
 *
 * AC: @dispatch-event-payload ac-1
 */
export const TaskEventPayloadSchema = z.object({
  /** The task's ULID */
  task_id: z.string(),
  /** The task's @-prefixed reference (slug or ULID) */
  task_ref: z.string(),
  /** The status the task transitioned from */
  from_status: TaskStatusSchema,
  /** The status the task transitioned to */
  to_status: TaskStatusSchema,
  /** The task's human-readable title */
  task_title: z.string().nullable(),
  /** Tags assigned to the task */
  tags: z.array(z.string()),
  /** Task priority (1–5 numeric or named) */
  priority: z.union([z.number(), z.string()]).nullable(),
  /** Automation eligibility status */
  automation: z.enum(["eligible", "not_eligible", "assisted"]).nullable(),
});

export type TaskEventPayload = z.infer<typeof TaskEventPayloadSchema>;

/**
 * Field names guaranteed in task.* event payloads.
 * Derived from the schema for use in registry and filter validation.
 */
export const TASK_PAYLOAD_FIELDS = Object.keys(
  TaskEventPayloadSchema.shape,
) as readonly string[];

// ─── Invocation Event Payloads ──────────────────────────────────────────────

/**
 * Payload for invocation.started events.
 *
 * AC: @dispatch-event-payload ac-2
 */
export const InvocationStartedPayloadSchema = z.object({
  /** The invocation's canonical identifier (same as session_id) */
  session_id: z.string(),
  /** The agent definition that was dispatched */
  agent_id: z.string(),
  /** The dispatch event that triggered this invocation */
  trigger: z.string(),
  /** Task reference when the invocation is task-scoped */
  task_ref: z.string().nullable().optional(),
});

/**
 * Payload for invocation terminal events (completed, failed, stalled).
 *
 * AC: @dispatch-event-payload ac-2
 */
export const InvocationTerminalPayloadSchema = z.object({
  /** The invocation's canonical identifier (same as session_id) */
  session_id: z.string(),
  /** The agent definition that was dispatched */
  agent_id: z.string(),
  /** The dispatch event that triggered this invocation */
  trigger: z.string(),
  /** Task reference when the invocation is task-scoped */
  task_ref: z.string().nullable().optional(),
  /** Duration of the invocation in milliseconds */
  duration_ms: z.number().nonnegative(),
});

export type InvocationStartedPayload = z.infer<typeof InvocationStartedPayloadSchema>;
export type InvocationTerminalPayload = z.infer<typeof InvocationTerminalPayloadSchema>;

/**
 * Field names guaranteed in invocation.started payloads.
 */
export const INVOCATION_STARTED_PAYLOAD_FIELDS = Object.keys(
  InvocationStartedPayloadSchema.shape,
) as readonly string[];

/**
 * Field names guaranteed in invocation terminal event payloads.
 */
export const INVOCATION_TERMINAL_PAYLOAD_FIELDS = Object.keys(
  InvocationTerminalPayloadSchema.shape,
) as readonly string[];

// ─── Session Event Payloads ─────────────────────────────────────────────────

/**
 * Work summary included in session terminal events.
 * Summarizes what the agent accomplished during the session.
 *
 * AC: @dispatch-event-payload ac-3
 */
export const WorkSummarySchema = z.object({
  /** Number of session events recorded */
  event_count: z.number().int().nonnegative().optional(),
  /** Number of dispatch iterations */
  iteration_count: z.number().int().nonnegative().optional(),
  /** Number of tasks completed during the session */
  tasks_completed: z.number().int().nonnegative().optional(),
}).passthrough();

/**
 * Payload for session.* events (ended, idle_timeout, cancelled).
 *
 * AC: @dispatch-event-payload ac-3
 */
export const SessionEventPayloadSchema = z.object({
  /** The session's canonical identifier */
  session_id: z.string(),
  /** The agent definition that ran the session */
  agent_id: z.string(),
  /** Task reference if the session was task-scoped */
  task_ref: z.string().nullable().optional(),
  /** Duration of the session in milliseconds */
  duration_ms: z.number().nonnegative(),
  /** Why the session terminated (e.g., "completed", "idle", "cancelled") */
  terminal_reason: z.string(),
  /** Summary of work performed during the session */
  work_summary: WorkSummarySchema,
});

export type WorkSummary = z.infer<typeof WorkSummarySchema>;
export type SessionEventPayload = z.infer<typeof SessionEventPayloadSchema>;

/**
 * Field names guaranteed in session.* event payloads.
 */
export const SESSION_PAYLOAD_FIELDS = Object.keys(
  SessionEventPayloadSchema.shape,
) as readonly string[];

// ─── Schedule Event Payloads ────────────────────────────────────────────────

/**
 * Payload for schedule.tick events.
 *
 * AC: @dispatch-event-payload ac-4
 */
export const ScheduleTickPayloadSchema = z.object({
  /** The schedule's unique identifier */
  schedule_id: z.string(),
  /** The schedule's human-readable name */
  schedule_name: z.string(),
  /** The scheduled time (not evaluation time) — ISO 8601 */
  tick_time: z.string(),
  /** Number of accepted runs (not cron matches) */
  run_count: z.number().int().nonnegative(),
});

export type ScheduleTickPayload = z.infer<typeof ScheduleTickPayloadSchema>;

/**
 * Field names guaranteed in schedule.tick event payloads.
 */
export const SCHEDULE_TICK_PAYLOAD_FIELDS = Object.keys(
  ScheduleTickPayloadSchema.shape,
) as readonly string[];

// ─── Action Event Payloads ──────────────────────────────────────────────────

/**
 * Payload for action.started events.
 *
 * AC: @dispatch-event-payload ac-5
 */
export const ActionStartedPayloadSchema = z.object({
  /** Unique identifier for this action run */
  action_run_id: z.string(),
  /** The action type (command, kspec, agent, notify) */
  action_type: z.enum(["command", "kspec", "agent", "notify"]),
  /** Hook ID that triggered this action (mutually exclusive with schedule_id) */
  hook_id: z.string().optional(),
  /** Schedule ID that triggered this action (mutually exclusive with hook_id) */
  schedule_id: z.string().optional(),
  /** Source hook or schedule name */
  source_name: z.string().optional(),
});

/**
 * Payload for action terminal events (completed, failed).
 *
 * AC: @dispatch-event-payload ac-5
 */
export const ActionTerminalPayloadSchema = z.object({
  /** Unique identifier for this action run */
  action_run_id: z.string(),
  /** The action type (command, kspec, agent, notify) */
  action_type: z.enum(["command", "kspec", "agent", "notify"]),
  /** Hook ID that triggered this action (mutually exclusive with schedule_id) */
  hook_id: z.string().optional(),
  /** Schedule ID that triggered this action (mutually exclusive with hook_id) */
  schedule_id: z.string().optional(),
  /** Source hook or schedule name */
  source_name: z.string().optional(),
  /** Duration of the action run in milliseconds */
  duration_ms: z.number().nonnegative(),
  /** Session ID when action type is agent — links to the spawned invocation */
  session_id: z.string().optional(),
});

export type ActionStartedPayload = z.infer<typeof ActionStartedPayloadSchema>;
export type ActionTerminalPayload = z.infer<typeof ActionTerminalPayloadSchema>;

/**
 * Field names guaranteed in action.started event payloads.
 */
export const ACTION_STARTED_PAYLOAD_FIELDS = Object.keys(
  ActionStartedPayloadSchema.shape,
) as readonly string[];

/**
 * Field names guaranteed in action terminal event payloads.
 */
export const ACTION_TERMINAL_PAYLOAD_FIELDS = Object.keys(
  ActionTerminalPayloadSchema.shape,
) as readonly string[];

// ─── Payload Schema Lookup ──────────────────────────────────────────────────

/**
 * Map from event type to its payload Zod schema.
 * Useful for runtime validation of event payloads.
 */
export const EVENT_PAYLOAD_SCHEMAS: Record<string, z.ZodType> = {
  "task.ready": TaskEventPayloadSchema,
  "task.in_progress": TaskEventPayloadSchema,
  "task.needs_work": TaskEventPayloadSchema,
  "task.pending_review": TaskEventPayloadSchema,
  "invocation.started": InvocationStartedPayloadSchema,
  "invocation.completed": InvocationTerminalPayloadSchema,
  "invocation.failed": InvocationTerminalPayloadSchema,
  "invocation.stalled": InvocationTerminalPayloadSchema,
  "session.ended": SessionEventPayloadSchema,
  "session.idle_timeout": SessionEventPayloadSchema,
  "session.cancelled": SessionEventPayloadSchema,
  "schedule.tick": ScheduleTickPayloadSchema,
  "action.started": ActionStartedPayloadSchema,
  "action.completed": ActionTerminalPayloadSchema,
  "action.failed": ActionTerminalPayloadSchema,
};

/**
 * Validate an event payload against the schema for its event type.
 * Returns the parsed payload on success, or the validation error on failure.
 */
export function validateEventPayload(
  eventType: string,
  payload: Record<string, unknown>,
): { success: true; data: Record<string, unknown> } | { success: false; error: z.ZodError } {
  const schema = EVENT_PAYLOAD_SCHEMAS[eventType];
  if (!schema) {
    // No schema for this event type — accept as-is
    return { success: true, data: payload };
  }
  const result = schema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data as Record<string, unknown> };
  }
  return { success: false, error: result.error };
}
