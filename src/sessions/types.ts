/**
 * Session event storage types and schemas.
 *
 * Provides JSONL-based event storage for agent sessions with:
 * - Session metadata tracking
 * - Append-only event logs
 * - Integration with kspec commit boundaries
 */

import { z } from "zod";

// ─── Session Status ──────────────────────────────────────────────────────────

/**
 * Session status enum.
 * - active: Session is in progress
 * - completed: Session ended normally
 * - abandoned: Session ended without explicit close
 * - timed_out: Session ended due to timeout
 * - failed: Session ended due to an error
 *
 * AC: @session-model-evolution ac-3
 */
export const SessionStatusSchema = z.enum(["active", "completed", "abandoned", "timed_out", "failed", "stalled"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

// ─── Session Metadata ────────────────────────────────────────────────────────

/**
 * Trigger source enum — what caused this agent session to be dispatched.
 *
 * Accepts any registered dispatch event type as a trigger, plus:
 * - manual: Started manually by user
 * - legacy: Old agent sessions without explicit trigger
 *
 * AC: @session-model-evolution ac-1, ac-2
 * AC: @dispatch-event-taxonomy ac-4 — existing trigger values unchanged
 */
export const SessionTriggerSchema = z.enum([
  "manual",
  // Task lifecycle events (existing, unchanged)
  "task.in_progress",
  "task.ready",
  "task.needs_work",
  "task.pending_review",
  // Invocation lifecycle events
  "invocation.started",
  "invocation.completed",
  "invocation.failed",
  "invocation.stalled",
  // Session lifecycle events
  "session.ended",
  "session.idle_timeout",
  "session.cancelled",
  // Schedule events
  "schedule.tick",
  // Action run tracking events
  "action.started",
  "action.completed",
  "action.failed",
  "legacy",
]);

export type SessionTrigger = z.infer<typeof SessionTriggerSchema>;

/**
 * Session metadata stored in session.yaml.
 * AC-5: includes task_id (optional), agent_type, status, started_at, ended_at
 */
export const SessionMetadataSchema = z.object({
  /** Session ULID */
  id: z.string(),

  /** Optional task being worked on */
  task_id: z.string().optional(),

  /** Type of agent running the session */
  agent_type: z.string(),

  /**
   * Reference to the agent definition that dispatched this session.
   * For legacy sessions without this field, defaults to agent_type value.
   * AC: @session-model-evolution ac-1, ac-2
   */
  agent_id: z.string().optional(),

  /**
   * Trigger source — what caused this session to be dispatched.
   * For legacy sessions without this field, defaults to "legacy".
   * AC: @session-model-evolution ac-1, ac-2
   */
  trigger: SessionTriggerSchema.optional(),

  /** Current session status */
  status: SessionStatusSchema,

  /** When session started (ISO 8601) */
  started_at: z.string().datetime(),

  /** When session ended (ISO 8601) - only set when status != 'active' */
  ended_at: z.string().datetime().optional(),

  /** Whether end-loop has been requested for this session */
  end_requested: z.boolean().optional(),

  /** Reason for end-loop request */
  end_reason: z.string().optional(),

  /** Reason for session close (normal exit, signal, error) */
  close_reason: z.string().optional(),

  /**
   * Persisted summary stats — written on session close so list endpoints
   * can display counts without scanning events.jsonl.
   * AC: @session-summary-cache ac-persist-on-close
   */
  event_count: z.number().int().nonnegative().optional(),
  iteration_count: z.number().int().nonnegative().optional(),
  tasks_completed: z.number().int().nonnegative().optional(),
});

export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;

/**
 * Input for creating a new session.
 */
export const SessionMetadataInputSchema = SessionMetadataSchema.omit({
  status: true,
  started_at: true,
  ended_at: true,
}).extend({
  status: SessionStatusSchema.optional(),
  started_at: z.string().datetime().optional(),
});

export type SessionMetadataInput = z.infer<typeof SessionMetadataInputSchema>;

// ─── Event Types ─────────────────────────────────────────────────────────────

/**
 * Supported event types for session tracking.
 *
 * agent.* events are emitted by the new agent runtime:
 * - agent.dispatched: Agent was dispatched for a task
 * - agent.started: Agent started work on a task
 * - agent.completed: Agent completed work (with structured outcome)
 * - agent.failed: Agent failed (error or crash)
 * - agent.timeout: Agent exceeded timeout limit
 *
 * AC: @session-model-evolution ac-4
 */
export const EventTypeSchema = z.enum([
  "session.start",
  "session.update",
  "iteration.timeout",
  "session.end",
  "session.wrapup",
  "prompt.sent",
  "tool.call",
  "tool.result",
  "note",
  "agent.dispatched",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "agent.timeout",
  "agent.stalled",
]);

export type EventType = z.infer<typeof EventTypeSchema>;

// ─── Session Event ───────────────────────────────────────────────────────────

/**
 * A single event in the session log.
 * AC-2: Events include ts and seq auto-assigned on append.
 */
export const SessionEventSchema = z.object({
  /** Unix timestamp in milliseconds (auto-assigned) */
  ts: z.number(),

  /** Sequence number in session (auto-assigned, 0-indexed) */
  seq: z.number().int().nonnegative(),

  /** Event type */
  type: EventTypeSchema,

  /** Session this event belongs to */
  session_id: z.string(),

  /** Optional trace ID for correlation */
  trace_id: z.string().optional(),

  /** Type-specific event payload */
  data: z.unknown(),
});

export type SessionEvent = z.infer<typeof SessionEventSchema>;

/**
 * Input for appending an event (without auto-assigned fields).
 */
export const SessionEventInputSchema = SessionEventSchema.omit({
  ts: true,
  seq: true,
}).extend({
  ts: z.number().optional(),
  seq: z.number().int().nonnegative().optional(),
});

export type SessionEventInput = z.infer<typeof SessionEventInputSchema>;

// ─── Task Budget ────────────────────────────────────────────────────────────

/**
 * Task budget state stored in .kspec-sessions/{id}/budget.json.
 *
 * Budget lives on LOCAL filesystem (not shadow branch) to avoid contention
 * between the dispatch loop and spawned agents. Single-writer guarantee: the
 * loop resets only between iterations (agent not running), agent is the only
 * writer during its turn.
 *
 * AC: @session-creation-and-env-injection ac-budget
 * AC: @session-creation-and-env-injection ac-budget-local
 * AC: @task-budget-enforcement ac-atomic-write
 */
export const TaskBudgetSchema = z.object({
  /** Maximum tasks that can be started per cycle/iteration */
  max_per_cycle: z.number().int().positive(),

  /** Number of tasks started in current cycle */
  started_this_cycle: z.number().int().nonnegative(),
});

export type TaskBudget = z.infer<typeof TaskBudgetSchema>;
