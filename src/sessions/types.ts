/**
 * Session event storage types and schemas.
 *
 * Provides JSONL-based event storage for agent sessions with:
 * - Session metadata tracking
 * - Append-only event logs
 * - Integration with kspec commit boundaries
 */

import { z } from 'zod';

// ─── Session Status ──────────────────────────────────────────────────────────

/**
 * Session status enum.
 * - active: Session is in progress
 * - completed: Session ended normally
 * - abandoned: Session ended without explicit close
 */
export const SessionStatusSchema = z.enum(['active', 'completed', 'abandoned']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

// ─── Session Metadata ────────────────────────────────────────────────────────

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

  /** Current session status */
  status: SessionStatusSchema,

  /** When session started (ISO 8601) */
  started_at: z.string().datetime(),

  /** When session ended (ISO 8601) - only set when status != 'active' */
  ended_at: z.string().datetime().optional(),
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
 */
export const EventTypeSchema = z.enum([
  'session.start',
  'session.update',
  'session.end',
  'prompt.sent',
  'tool.call',
  'tool.result',
  'note',
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
