/**
 * Composition Schema
 *
 * Defines the schema for composition group configurations in kynetic.meta.yaml.
 * A composition config declares fan-in join rules: how many action runs must
 * complete before the on_complete action fires, with optional timeout.
 *
 * Spec: @dispatch-composition-schema, @dispatch-composition-patterns
 * Task: @task-composition-join
 */

import { z } from "zod";
import { UlidSchema } from "./common.js";
import { ActionSchema } from "./action.js";

// ─── Composition Schema ────────────────────────────────────────────────────

/**
 * Composition group configuration — defines fan-in join rules.
 *
 * Each composition has:
 * - _ulid: Unique identifier
 * - id: Machine-readable identifier
 * - name: Human-readable label
 * - join_count: Number of successful action runs required to trigger on_complete
 * - on_complete: Action to execute when the join threshold is met (or timeout expires)
 * - timeout_ms: Optional timeout in milliseconds from the first run start
 * - enabled: Whether the composition is active (defaults to true)
 *
 * AC: @dispatch-composition-schema ac-1 — group parsed with typed fields;
 *     on_complete uses shared action schema
 * AC: @dispatch-composition-schema ac-2 — compositions defaults to empty
 */
export const CompositionSchema = z.object({
  _ulid: UlidSchema,
  id: z.string().min(1, "Composition ID is required"),
  name: z.string().min(1, "Composition name is required"),
  /** Number of successful action run completions required to trigger on_complete */
  join_count: z.number().int().positive("Join count must be a positive integer"),
  /** Action to fire when join threshold is met or timeout expires */
  on_complete: ActionSchema,
  /** Optional timeout in milliseconds; starts when first run begins */
  timeout_ms: z.number().int().positive().optional(),
  /** Whether the composition is active (defaults to true) */
  enabled: z.boolean().default(true),
});

// ─── Type Exports ────────────────────────────────────────────────────────────

export type Composition = z.infer<typeof CompositionSchema>;
