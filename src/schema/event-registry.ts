/**
 * Event Type Registry
 *
 * The single source of truth for all valid event type identifiers in the
 * dispatch event system. Events use dotted-namespace domains. The registry
 * is an explicit enumeration — event identifiers must be registered to be valid.
 *
 * Domain grouping:
 * - task.*         — Task lifecycle state changes (existing, unchanged)
 * - invocation.*   — Agent invocation lifecycle (started, completed, failed, stalled)
 * - session.*      — Dispatch session lifecycle (ended, idle_timeout, cancelled)
 * - schedule.*     — Scheduled triggers (tick)
 * - action.*       — Universal action run tracking (started, completed, failed)
 *
 * Identity model: session_id and invocation_id are the same value.
 * A "session" in the dispatch context IS an invocation.
 *
 * Spec: @dispatch-event-taxonomy
 * Task: @task-event-schema
 */

import { z } from "zod";
import {
  TASK_PAYLOAD_FIELDS,
  INVOCATION_STARTED_PAYLOAD_FIELDS,
  INVOCATION_TERMINAL_PAYLOAD_FIELDS,
  SESSION_PAYLOAD_FIELDS,
  SCHEDULE_TICK_PAYLOAD_FIELDS,
  ACTION_STARTED_PAYLOAD_FIELDS,
  ACTION_TERMINAL_PAYLOAD_FIELDS,
} from "./event-payloads.js";

// ─── Event Domains ────────────────────────────────────────────────────────────

/**
 * Event domain identifiers. Each domain groups related event types.
 */
export const EVENT_DOMAINS = [
  "task",
  "invocation",
  "session",
  "schedule",
  "action",
] as const;

export type EventDomain = (typeof EVENT_DOMAINS)[number];

// ─── Event Registry ───────────────────────────────────────────────────────────

/**
 * Registry entry for a single event type.
 * Maps an event identifier to its domain and known payload fields.
 */
export interface EventRegistryEntry {
  /** The dotted-namespace event identifier */
  event_type: string;
  /** The domain this event belongs to */
  domain: EventDomain;
  /** Human-readable description of when this event is emitted */
  description: string;
  /** Known payload fields for this event type (used for filter validation) */
  payload_fields: readonly string[];
}

/**
 * The event type registry — an explicit enumeration of all valid event
 * identifiers with domain grouping and payload field metadata.
 *
 * This is the canonical source of truth. All event type schemas, validation,
 * and CLI output derive from this registry.
 *
 * AC: @dispatch-event-taxonomy ac-1, ac-2, ac-3, ac-4, ac-5
 */
export const EVENT_REGISTRY: readonly EventRegistryEntry[] = [
  // ─── Task domain (existing, unchanged) ────────────────────────────────
  // AC: @dispatch-event-taxonomy ac-4 — existing dispatch rules unchanged
  // AC: @dispatch-event-payload ac-1 — task payload includes enriched metadata
  {
    event_type: "task.ready",
    domain: "task",
    description: "A task became ready for work (pending status)",
    payload_fields: TASK_PAYLOAD_FIELDS,
  },
  {
    event_type: "task.in_progress",
    domain: "task",
    description: "A task transitioned to in-progress",
    payload_fields: TASK_PAYLOAD_FIELDS,
  },
  {
    event_type: "task.needs_work",
    domain: "task",
    description: "A task needs work (fix cycle from review)",
    payload_fields: TASK_PAYLOAD_FIELDS,
  },
  {
    event_type: "task.pending_review",
    domain: "task",
    description: "A task is pending review",
    payload_fields: TASK_PAYLOAD_FIELDS,
  },

  // ─── Invocation domain ────────────────────────────────────────────────
  // AC: @dispatch-event-taxonomy ac-1 — invocation terminal state events
  // AC: @dispatch-event-payload ac-2 — invocation payload fields
  {
    event_type: "invocation.started",
    domain: "invocation",
    description: "An agent invocation has started",
    payload_fields: INVOCATION_STARTED_PAYLOAD_FIELDS,
  },
  {
    event_type: "invocation.completed",
    domain: "invocation",
    description: "An agent invocation completed successfully",
    payload_fields: [...INVOCATION_TERMINAL_PAYLOAD_FIELDS, "outcome"],
  },
  {
    event_type: "invocation.failed",
    domain: "invocation",
    description: "An agent invocation failed with an error",
    payload_fields: [...INVOCATION_TERMINAL_PAYLOAD_FIELDS, "error"],
  },
  {
    event_type: "invocation.stalled",
    domain: "invocation",
    description: "An agent invocation stalled (no progress detected)",
    payload_fields: INVOCATION_TERMINAL_PAYLOAD_FIELDS,
  },

  // ─── Session domain ───────────────────────────────────────────────────
  // AC: @dispatch-event-taxonomy ac-2 — session terminal state events
  // AC: @dispatch-event-payload ac-3 — session payload fields
  {
    event_type: "session.ended",
    domain: "session",
    description: "A dispatch session ended normally (agent responded)",
    payload_fields: SESSION_PAYLOAD_FIELDS,
  },
  {
    event_type: "session.idle_timeout",
    domain: "session",
    description: "A dispatch session ended due to idle timeout",
    payload_fields: SESSION_PAYLOAD_FIELDS,
  },
  {
    event_type: "session.cancelled",
    domain: "session",
    description: "A dispatch session was cancelled",
    payload_fields: SESSION_PAYLOAD_FIELDS,
  },

  // ─── Schedule domain ──────────────────────────────────────────────────
  // AC: @dispatch-event-payload ac-4 — schedule tick payload fields
  {
    event_type: "schedule.tick",
    domain: "schedule",
    description: "A scheduled trigger fired",
    payload_fields: SCHEDULE_TICK_PAYLOAD_FIELDS,
  },

  // ─── Action domain ────────────────────────────────────────────────────
  // AC: @dispatch-event-payload ac-5 — action payload fields
  {
    event_type: "action.started",
    domain: "action",
    description: "An action run started (hook, schedule, or composition action)",
    payload_fields: [...ACTION_STARTED_PAYLOAD_FIELDS, "source_event_type"],
  },
  {
    event_type: "action.completed",
    domain: "action",
    description: "An action run completed successfully",
    payload_fields: [...ACTION_TERMINAL_PAYLOAD_FIELDS, "source_event_type"],
  },
  {
    event_type: "action.failed",
    domain: "action",
    description: "An action run failed",
    payload_fields: [...ACTION_TERMINAL_PAYLOAD_FIELDS, "source_event_type", "error", "failure_reason"],
  },
] as const;

// ─── Derived Constants ────────────────────────────────────────────────────────

/**
 * All registered event type identifiers, derived from the registry.
 */
export const REGISTERED_EVENT_TYPES = EVENT_REGISTRY.map((e) => e.event_type);

/**
 * Set of all registered event type identifiers for O(1) lookup.
 */
export const REGISTERED_EVENT_TYPE_SET = new Set(REGISTERED_EVENT_TYPES);

/**
 * Registry entries grouped by domain.
 */
export const EVENTS_BY_DOMAIN: Record<EventDomain, readonly EventRegistryEntry[]> = {
  task: EVENT_REGISTRY.filter((e) => e.domain === "task"),
  invocation: EVENT_REGISTRY.filter((e) => e.domain === "invocation"),
  session: EVENT_REGISTRY.filter((e) => e.domain === "session"),
  schedule: EVENT_REGISTRY.filter((e) => e.domain === "schedule"),
  action: EVENT_REGISTRY.filter((e) => e.domain === "action"),
};

/**
 * Payload fields indexed by event type, derived from registry entries.
 * Used by hook filter validation.
 */
export const PAYLOAD_FIELDS_BY_EVENT_TYPE: Record<string, readonly string[]> =
  Object.fromEntries(EVENT_REGISTRY.map((e) => [e.event_type, e.payload_fields]));

// ─── Zod Schema ───────────────────────────────────────────────────────────────

/**
 * Zod schema for validating event type identifiers.
 * Derived from the registry — accepts exactly the registered set.
 *
 * AC: @dispatch-event-taxonomy ac-3 — validation rejects unregistered types
 */
export const DispatchEventTypeSchema = z.enum(
  REGISTERED_EVENT_TYPES as unknown as [string, ...string[]],
);

export type DispatchEventType = z.infer<typeof DispatchEventTypeSchema>;

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Check if a string is a registered event type.
 */
export function isRegisteredEventType(eventType: string): eventType is DispatchEventType {
  return REGISTERED_EVENT_TYPE_SET.has(eventType);
}

/**
 * Extract the domain from a dotted-namespace event type string.
 * Returns undefined if the string doesn't contain a dot.
 */
export function extractEventDomain(eventType: string): string | undefined {
  const dotIndex = eventType.indexOf(".");
  return dotIndex > 0 ? eventType.slice(0, dotIndex) : undefined;
}

/**
 * Validate an event type identifier against the registry.
 * Returns a structured error with the invalid event, its domain (if parseable),
 * and the list of valid events within that domain.
 *
 * AC: @dispatch-event-taxonomy ac-3 — error identifies invalid event and lists
 * valid event types within the referenced domain
 *
 * AC: @trait-error-guidance ac-1 — includes description of what went wrong
 * AC: @trait-error-guidance ac-2 — includes suggested action to resolve
 * AC: @trait-error-guidance ac-5 — indicates which field/value failed validation
 */
export function validateEventType(eventType: string): {
  valid: boolean;
  error?: {
    /** The invalid event type that was provided */
    invalid_event: string;
    /** The domain extracted from the event type, if any */
    parsed_domain: string | undefined;
    /** Human-readable error message */
    message: string;
    /** Suggested action to resolve the error */
    suggestion: string;
    /** Valid event types within the parsed domain (or all if domain unknown) */
    valid_events: string[];
  };
} {
  if (isRegisteredEventType(eventType)) {
    return { valid: true };
  }

  const parsedDomain = extractEventDomain(eventType);
  const isDomainKnown = parsedDomain !== undefined &&
    EVENT_DOMAINS.includes(parsedDomain as EventDomain);

  let validEvents: string[];
  let message: string;
  let suggestion: string;

  if (isDomainKnown) {
    // Domain is known but the specific event isn't registered
    const domainEvents = EVENTS_BY_DOMAIN[parsedDomain as EventDomain];
    validEvents = domainEvents.map((e) => e.event_type);
    message = `Unknown event type '${eventType}' in domain '${parsedDomain}'. ` +
      `Valid '${parsedDomain}.*' events: ${validEvents.join(", ")}`;
    suggestion = `Use one of the valid '${parsedDomain}.*' event types listed above, or check available domains: ${EVENT_DOMAINS.join(", ")}`;
  } else if (parsedDomain !== undefined) {
    // Domain prefix exists but is not recognized
    validEvents = REGISTERED_EVENT_TYPES.slice();
    message = `Unknown event domain '${parsedDomain}' in event type '${eventType}'. ` +
      `Valid domains: ${EVENT_DOMAINS.join(", ")}`;
    suggestion = `Use a valid event domain prefix (${EVENT_DOMAINS.join(", ")}) followed by a specific event. ` +
      `Run 'kspec event types' to see all valid event types.`;
  } else {
    // No domain prefix at all
    validEvents = REGISTERED_EVENT_TYPES.slice();
    message = `Invalid event type '${eventType}'. Event types use dotted-namespace format (e.g., 'task.ready').`;
    suggestion = `Use a dotted-namespace event type. ` +
      `Run 'kspec event types' to see all valid event types.`;
  }

  return {
    valid: false,
    error: {
      invalid_event: eventType,
      parsed_domain: parsedDomain,
      message,
      suggestion,
      valid_events: validEvents,
    },
  };
}

/**
 * Get the registry entry for a given event type.
 * Returns undefined if the event type is not registered.
 */
export function getEventRegistryEntry(eventType: string): EventRegistryEntry | undefined {
  return EVENT_REGISTRY.find((e) => e.event_type === eventType);
}
