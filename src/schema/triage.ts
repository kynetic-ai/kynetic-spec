import { z } from "zod";
import { DateTimeSchema, RefSchema, UlidSchema } from "./common.js";

/**
 * Triage status lifecycle
 * AC: @triage-record-schema ac-1, ac-5
 * - pending: Record created, no decision yet
 * - triaged: Decision recorded (action + reasoning)
 * - acted_on: Action has been executed
 */
export const TriageStatusSchema = z.enum(["pending", "triaged", "acted_on"]);

/**
 * Triage action types
 * AC: @triage-record-schema ac-2
 */
export const TriageActionSchema = z.enum([
  "promote",
  "delete",
  "defer",
  "spec-gap",
  "duplicate",
]);

/**
 * Full triage record schema
 * AC: @triage-record-schema ac-1, ac-2, ac-3, ac-4, ac-5, ac-7, ac-9
 * AC: @trait-error-guidance ac-1, ac-2, ac-4, ac-5 — validation errors include field and guidance
 */
export const TriageRecordSchema = z
  .object({
    // Identity
    _ulid: UlidSchema,

    // Source reference — AC: ac-1, ac-7
    inbox_ref: UlidSchema,
    item_snapshot: z.string().min(1, "Item snapshot is required"),

    // Status — AC: ac-1, ac-5
    status: TriageStatusSchema,

    // Decision fields — AC: ac-2, ac-3
    action: TriageActionSchema.optional(),
    reasoning: z.string().optional(),
    decided_by: z.string().optional(),
    evidence_refs: z.array(RefSchema).default([]),

    // Override fields — AC: ac-4
    override_reasoning: z.string().optional(),
    override_by: z.string().optional(),
    override_at: DateTimeSchema.optional(),

    // Execution fields — AC: ac-5
    acted_at: DateTimeSchema.optional(),
    result_ref: RefSchema.optional(),

    // Timestamps — AC: ac-1, ac-9
    created_at: DateTimeSchema,
    updated_at: DateTimeSchema.optional(),
  })
  .superRefine((data, ctx) => {
    // AC: @triage-record-schema ac-3 — triaged records must have decision metadata
    // AC: @trait-error-guidance ac-4 — indicates current state and valid next states
    if (data.status === "triaged") {
      if (!data.action) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["action"],
          message:
            "Triaged records require an action. Set action to one of: promote, delete, defer, spec-gap, duplicate",
        });
      }
      if (!data.reasoning) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reasoning"],
          message: "Triaged records require reasoning for the decision",
        });
      }
      if (!data.decided_by) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["decided_by"],
          message:
            "Triaged records require decided_by to attribute the decision",
        });
      }
    }

    // AC: @triage-record-schema ac-5 — acted_on records must have acted_at
    // AC: @trait-error-guidance ac-4 — indicates current state and valid next states
    if (data.status === "acted_on") {
      if (!data.acted_at) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["acted_at"],
          message:
            "Acted-on records require acted_at timestamp. Set acted_at when executing the action.",
        });
      }
      // acted_on also implies the record was triaged first
      if (!data.action) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["action"],
          message:
            "Acted-on records require an action. Record must be triaged before acting.",
        });
      }
    }
  });

/**
 * Triage record input schema (for creating new records)
 */
export const TriageRecordInputSchema = z.object({
  _ulid: UlidSchema.optional(),
  inbox_ref: UlidSchema,
  item_snapshot: z.string().min(1, "Item snapshot is required"),
  status: TriageStatusSchema.optional(),
  action: TriageActionSchema.optional(),
  reasoning: z.string().optional(),
  decided_by: z.string().optional(),
  evidence_refs: z.array(RefSchema).optional(),
  created_at: DateTimeSchema.optional(),
});

/**
 * Triage file schema (collection of triage records)
 * AC: @triage-record-schema ac-6
 */
export const TriageFileSchema = z.object({
  kynetic_triage: z.string().default("1.0"),
  triage: z.array(TriageRecordSchema),
});

export type TriageStatus = z.infer<typeof TriageStatusSchema>;
export type TriageAction = z.infer<typeof TriageActionSchema>;
export type TriageRecord = z.infer<typeof TriageRecordSchema>;
export type TriageRecordInput = z.infer<typeof TriageRecordInputSchema>;
export type TriageFile = z.infer<typeof TriageFileSchema>;
