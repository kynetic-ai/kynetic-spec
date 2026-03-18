/**
 * Schedule Schema
 *
 * Defines the schema for time-triggered schedules configured in kynetic.meta.yaml.
 * Schedules use cron expressions to trigger actions on a recurring basis.
 * Reuses the shared action model from action.ts.
 *
 * Spec: @dispatch-schedule-schema
 * Task: @task-schedule-schema
 */

import { z } from "zod";
import { Cron } from "croner";
import { UlidSchema } from "./common.js";
import { ActionSchema } from "./action.js";

// ─── Overlap Policy ─────────────────────────────────────────────────────────

/**
 * Overlap policy for schedule execution.
 *
 * - skip: Skip the tick if the previous action is still running
 * - buffer_one: Queue at most one pending tick while the previous runs
 * - allow: Allow concurrent executions
 */
export const OverlapPolicySchema = z.enum(["skip", "buffer_one", "allow"]);

// ─── Cron Validation ────────────────────────────────────────────────────────

/**
 * Validate a cron expression using croner.
 * Accepts only 5-field (minute-level) cron expressions.
 * Rejects 6-field (second-level) expressions with a specific error.
 *
 * AC: @dispatch-schedule-schema ac-1, ac-2
 */
function validateCronExpression(value: string): boolean {
  try {
    const job = new Cron(value, { legacyMode: false });
    // croner parses 6-field expressions as second-level cron
    // Detect by checking the pattern: if it has 6 space-separated fields, reject
    const fields = value.trim().split(/\s+/);
    if (fields.length !== 5) {
      return false;
    }
    // Also validate it actually produces a next run (not an invalid pattern)
    job.nextRun();
    return true;
  } catch {
    return false;
  }
}

/**
 * Cron expression schema — validates 5-field cron expressions only.
 *
 * AC: @dispatch-schedule-schema ac-1 — valid 5-field cron accepted
 * AC: @dispatch-schedule-schema ac-2 — 6-field cron rejected with specific error
 */
export const CronExpressionSchema = z
  .string()
  .min(1, "Cron expression is required")
  .superRefine((value, ctx) => {
    const fields = value.trim().split(/\s+/);

    // AC: @dispatch-schedule-schema ac-2 — 6-field rejection
    if (fields.length === 6) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "6-field (second-level) cron expressions are not supported. " +
          "Use a 5-field (minute-level) expression instead. " +
          "Format: <minute> <hour> <day-of-month> <month> <day-of-week>. " +
          "Examples: '*/5 * * * *' (every 5 min), '0 9 * * 1-5' (weekdays at 9am)",
      });
      return;
    }

    // AC: @dispatch-schedule-schema ac-1 — valid 5-field validation
    if (!validateCronExpression(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Invalid cron expression '${value}'. ` +
          "Expected a valid 5-field cron expression. " +
          "Format: <minute> <hour> <day-of-month> <month> <day-of-week>. " +
          "Examples: '*/5 * * * *' (every 5 min), '0 9 * * 1-5' (weekdays at 9am)",
      });
    }
  });

// ─── Schedule Schema ────────────────────────────────────────────────────────

/**
 * Schedule definition — a time-triggered action configured in kynetic.meta.yaml.
 *
 * Each schedule has:
 * - _ulid: Unique identifier
 * - id: Machine-readable identifier
 * - name: Human-readable label
 * - cron: 5-field cron expression (minute-level only)
 * - timezone: IANA timezone for cron interpretation (defaults to UTC)
 * - action: What to do when the schedule fires (shared action model)
 * - overlap_policy: How to handle overlapping executions
 * - backfill: Whether to run missed ticks on startup
 * - enabled: Whether the schedule is active (defaults to true)
 *
 * AC: @dispatch-schedule-schema ac-1 through ac-4
 */
export const ScheduleSchema = z.object({
  _ulid: UlidSchema,
  id: z.string().min(1, "Schedule ID is required"),
  name: z.string().min(1, "Schedule name is required"),
  cron: CronExpressionSchema,
  timezone: z.string().default("UTC"),
  action: ActionSchema,
  overlap_policy: OverlapPolicySchema.default("skip"),
  backfill: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

// ─── Type Exports ────────────────────────────────────────────────────────────

export type OverlapPolicy = z.infer<typeof OverlapPolicySchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
