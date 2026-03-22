/**
 * Hook Schema
 *
 * Defines the schema for event-triggered hooks configured in kynetic.meta.yaml.
 * Hooks map event types to actions via optional payload filters.
 *
 * Spec: @dispatch-hook-schema, @dispatch-hook-filter
 * Task: @task-hook-schema
 */

import { z } from "zod";
import { UlidSchema } from "./common.js";
import { ActionSchema } from "./action.js";
import {
  DispatchEventTypeSchema,
  PAYLOAD_FIELDS_BY_EVENT_TYPE,
} from "./event-registry.js";

// ─── Event Type Schema ───────────────────────────────────────────────────────

/**
 * All valid event types in the dispatch event system.
 * Derived from the canonical event registry in event-registry.ts.
 *
 * Spec: @dispatch-event-taxonomy
 */
export const HookEventTypeSchema = DispatchEventTypeSchema;

// ─── Event Envelope & Payload Field Registry ─────────────────────────────────

/**
 * Standard envelope fields present on every event.
 * These are always valid filter targets for any event type.
 *
 * AC: @dispatch-hook-filter ac-5
 */
export const ENVELOPE_FIELDS = [
  "event_id",
  "event_type",
  "emitted_at",
  "source_type",
  "source_id",
  "causation_id",
  "correlation_id",
] as const;

/**
 * Known payload fields per event type domain.
 * Derived from the canonical event registry.
 * Used for filter validation — unknown filter fields on known event types
 * produce warnings.
 *
 * AC: @dispatch-hook-filter ac-3
 */
export const PAYLOAD_FIELDS_BY_EVENT: Record<string, readonly string[]> =
  PAYLOAD_FIELDS_BY_EVENT_TYPE;

/**
 * Get all valid filter fields for a given event type.
 * Returns envelope fields (always valid) plus payload fields specific to the event type.
 */
export function getValidFilterFields(eventType: string): string[] {
  const envelopeFields = [...ENVELOPE_FIELDS];
  const payloadFields = PAYLOAD_FIELDS_BY_EVENT[eventType] || [];
  return [...envelopeFields, ...payloadFields];
}

// ─── Hook Filter Schema ──────────────────────────────────────────────────────

/**
 * Hook filter for payload matching.
 *
 * Filters use:
 * - Exact string equality for scalar fields (agent_id, status, source_type, etc.)
 * - Contains-all semantics for array fields (tags) — all specified values
 *   must be present, extra values are allowed.
 *
 * AC: @dispatch-hook-filter ac-1 through ac-5
 */
export const HookFilterSchema = z.record(
  z.string(),
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
  ]),
);

// ─── Hook Schema ─────────────────────────────────────────────────────────────

/**
 * Hook definition — an event-triggered action configured in kynetic.meta.yaml.
 *
 * Each hook has:
 * - _ulid: Unique identifier
 * - name: Human-readable label
 * - on: Event type from the registry
 * - filter: Optional structured payload filter
 * - action: What to do when the event matches (shared action model)
 * - enabled: Whether the hook is active (defaults to true)
 *
 * AC: @dispatch-hook-schema ac-1 through ac-4
 */
export const HookSchema = z.object({
  // AC: @dispatch-hook-schema ac-1
  _ulid: UlidSchema,
  name: z.string().min(1, "Hook name is required"),
  on: HookEventTypeSchema,
  filter: HookFilterSchema.optional(),
  action: ActionSchema,
  enabled: z.boolean().default(true),
});

// ─── Validation Utilities ────────────────────────────────────────────────────

/**
 * Validate filter fields against known fields for an event type.
 * Returns warnings for unknown fields.
 *
 * AC: @dispatch-hook-filter ac-3
 */
export function validateHookFilter(
  hookName: string,
  eventType: string,
  filter: Record<string, unknown>,
): { field: string; message: string }[] {
  const warnings: { field: string; message: string }[] = [];
  const validFields = getValidFilterFields(eventType);
  const validFieldSet = new Set(validFields);

  for (const field of Object.keys(filter)) {
    if (!validFieldSet.has(field)) {
      warnings.push({
        field,
        message: `Hook '${hookName}' filter references unknown field '${field}' for event type '${eventType}'. Available fields: ${validFields.join(", ")}`,
      });
    }
  }

  return warnings;
}

/**
 * Check if a hook's filter matches an event payload.
 * Implements the filter matching semantics:
 * - String/number/boolean values use exact equality
 * - Array values use contains-all semantics
 *
 * AC: @dispatch-hook-filter ac-1, ac-2, ac-4, ac-5
 */
export function matchesFilter(
  filter: Record<string, unknown> | undefined,
  envelope: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  // AC: @dispatch-hook-filter ac-4 — no filter matches all events
  if (!filter || Object.keys(filter).length === 0) {
    return true;
  }

  // Merge envelope and payload for field lookup
  // Envelope fields take precedence for matching
  const combined = { ...payload, ...envelope };

  for (const [field, filterValue] of Object.entries(filter)) {
    const actualValue = combined[field];

    if (Array.isArray(filterValue)) {
      // AC: @dispatch-hook-filter ac-2 — contains-all semantics for arrays
      if (!Array.isArray(actualValue)) {
        return false;
      }
      const actualSet = new Set(actualValue as unknown[]);
      for (const required of filterValue) {
        if (!actualSet.has(required)) {
          return false;
        }
      }
    } else {
      // AC: @dispatch-hook-filter ac-1, ac-5 — exact equality for scalars
      if (actualValue !== filterValue) {
        return false;
      }
    }
  }

  return true;
}

// ─── Type Exports ────────────────────────────────────────────────────────────

export type HookEventType = z.infer<typeof HookEventTypeSchema>;
export type HookFilter = z.infer<typeof HookFilterSchema>;
export type Hook = z.infer<typeof HookSchema>;
