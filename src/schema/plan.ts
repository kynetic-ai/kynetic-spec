import { z } from "zod";
import { DateTimeSchema, RefSchema, SlugSchema, UlidSchema } from "./common.js";
import { NoteSchema } from "./task.js";

/**
 * Plan status lifecycle
 * AC: @plan-crud ac-3, ac-4
 * - draft: Initial state, editable
 * - approved: Plan reviewed and approved, ready for derivation
 * - active: Tasks have been derived from plan
 * - completed: All derived work finished
 * - rejected: Plan was rejected, terminal state
 */
export const PlanStatusSchema = z.enum(["draft", "approved", "active", "completed", "rejected"]);

export const PlanRevisionSchema = z.object({
  ordinal: z.number().int().positive(),
  author: z.string().min(1, "Revision author is required"),
  note: z.string().min(1, "Revision note is required"),
  created_at: DateTimeSchema,
  shadow_commit: z.string().min(1, "Shadow commit is required"),
});

/**
 * Full plan schema
 * AC: @plan-crud ac-1, ac-8, ac-30
 */
export const PlanSchema = z.object({
  // Identity
  _ulid: UlidSchema,
  slugs: z.array(SlugSchema).default([]),
  title: z.string().min(1, "Title is required"),

  // Content (markdown)
  content: z.string().default(""),

  // State
  status: PlanStatusSchema.default("draft"),

  // Links to derived work
  // AC: @plan-derive-enhanced ac-status-transition - updated when plans are derived
  derived_tasks: z.array(RefSchema).default([]),
  derived_specs: z.array(RefSchema).default([]),

  // Source tracking (if imported from file)
  // AC: @plan-import ac-24
  source_path: z.string().nullable().optional(),
  module_ref: RefSchema.nullable().optional(),
  branch: z.string().nullable().optional().default(null),

  // Timestamps (auto-populated if not provided)
  created_at: DateTimeSchema.default(() => new Date().toISOString()),
  approved_at: DateTimeSchema.nullable().optional(), // AC: @plan-crud ac-3
  completed_at: DateTimeSchema.nullable().optional(),

  // Notes (work log)
  // AC: @plan-crud ac-9
  notes: z.array(NoteSchema).default([]),

  // Intentional publish history. The document body is never duplicated here;
  // each revision points at the shadow commit that contains the published body.
  revisions: z.array(PlanRevisionSchema).default([]),
});

/**
 * Plan input schema (for creating new plans)
 * Most fields are optional - defaults will be applied
 */
export const PlanInputSchema = z.object({
  // Identity (auto-generated if not provided)
  _ulid: UlidSchema.optional(),
  slugs: z.array(SlugSchema).optional(),
  title: z.string().min(1, "Title is required"),

  // Content
  content: z.string().optional(),

  // State
  status: PlanStatusSchema.optional(),

  // Links
  derived_tasks: z.array(RefSchema).optional(),
  derived_specs: z.array(RefSchema).optional(),

  // Source tracking
  source_path: z.string().nullable().optional(),
  module_ref: RefSchema.nullable().optional(),
  branch: z.string().nullable().optional(),

  // Timestamps
  created_at: DateTimeSchema.optional(),
  approved_at: DateTimeSchema.nullable().optional(),
  completed_at: DateTimeSchema.nullable().optional(),

  // Notes
  notes: z.array(NoteSchema).optional(),

  // Revisions
  revisions: z.array(PlanRevisionSchema).optional(),
});

/**
 * Plans file schema (collection of plans)
 * AC: @plan-crud ac-1 - stored in project.plans.yaml
 */
export const PlansFileSchema = z.object({
  kynetic_plans: z.string().default("1.0"),
  plans: z.array(PlanSchema),
});

export type PlanStatus = z.infer<typeof PlanStatusSchema>;
export type PlanRevision = z.infer<typeof PlanRevisionSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type PlanInput = z.infer<typeof PlanInputSchema>;
export type PlansFile = z.infer<typeof PlansFileSchema>;
