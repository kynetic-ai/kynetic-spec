import { z } from "zod";
import { AcIdSchema, DateTimeSchema, RefSchema, SlugSchema, UlidSchema } from "./common.js";
import { NoteSchema } from "./task.js";

// --- Lifecycle & Disposition ---

// AC: @review-record-core-model ac-2
export const ReviewLifecycleStateSchema = z.enum(["draft", "open", "closed", "archived"]);

export const ReviewDispositionSchema = z.enum(["pending", "approved", "changes_requested"]);

export const ReviewGateStateSchema = z.enum(["passing", "failing", "pending"]);

// --- Subject Bindings ---

// AC: @review-record-core-model ac-1, ac-3
export const ReviewCodeSubjectSchema = z.object({
  type: z.literal("code"),
  base_commit: z.string(),
  head_commit: z.string(),
  merge_base_commit: z.string().optional(),
  base_branch: z.string().optional(),
  head_branch: z.string().optional(),
});

export const ReviewPlanSubjectSchema = z.object({
  type: z.literal("plan"),
  ref: RefSchema,
  shadow_commit: z.string(),
  content_hash: z.string(),
});

export const ReviewTaskSubjectSchema = z.object({
  type: z.literal("task"),
  ref: RefSchema,
  shadow_commit: z.string(),
  content_hash: z.string(),
});

export const ReviewSpecSubjectSchema = z.object({
  type: z.literal("spec"),
  ref: RefSchema,
  shadow_commit: z.string(),
  content_hash: z.string(),
});

export const ReviewExternalSubjectSchema = z.object({
  type: z.literal("external"),
  url: z.string().url(),
  external_id: z.string().optional(),
  provider: z.string().optional(),
});

export const ReviewSubjectSchema = z.discriminatedUnion("type", [
  ReviewCodeSubjectSchema,
  ReviewPlanSubjectSchema,
  ReviewTaskSubjectSchema,
  ReviewSpecSubjectSchema,
  ReviewExternalSubjectSchema,
]);

// --- Subject Version (for verdicts and checks) ---

export const ReviewCodeCompareVersionSchema = z.object({
  type: z.literal("code_compare"),
  base_commit: z.string(),
  head_commit: z.string(),
});

export const ReviewEntityVersionSchema = z.object({
  type: z.literal("entity_version"),
  content_hash: z.string(),
});

export const ReviewSubjectVersionSchema = z.discriminatedUnion("type", [
  ReviewCodeCompareVersionSchema,
  ReviewEntityVersionSchema,
]);

// --- Anchors ---

export const ReviewAnchorTypeSchema = z.enum(["code", "structured", "spec_ac"]);

export const ReviewCodeAnchorSideSchema = z.enum(["base", "head"]);

export const ReviewCodeAnchorSchema = z.object({
  type: z.literal("code"),
  path: z.string(),
  side: ReviewCodeAnchorSideSchema,
  line_start: z.number().int().positive(),
  line_end: z.number().int().positive(),
  commit: z.string(),
});

export const ReviewStructuredAnchorSchema = z.object({
  type: z.literal("structured"),
  section: z.string().optional(),
  field: z.string().optional(),
  path: z.string().optional(),
  ref: RefSchema.optional(),
});

// AC: @review-spec-ac-anchors ac-typed-anchor-stored
// AC: @review-spec-ac-anchors ac-anchor-field-validation
export const ReviewSpecAcAnchorSchema = z.object({
  type: z.literal("spec_ac"),
  spec_ref: RefSchema,
  criterion_id: AcIdSchema,
});

export const ReviewAnchorSchema = z.discriminatedUnion("type", [
  ReviewCodeAnchorSchema,
  ReviewStructuredAnchorSchema,
  ReviewSpecAcAnchorSchema,
]);

// --- Threads ---

export const ReviewThreadKindSchema = z.enum(["blocker", "question", "nit", "idea"]);

export const ReviewThreadEntrySchema = z.object({
  _ulid: UlidSchema,
  author: z.string(),
  body: z.string(),
  created_at: DateTimeSchema,
});

export const ReviewThreadSchema = z.object({
  _ulid: UlidSchema,
  kind: ReviewThreadKindSchema.default("nit"),
  anchor: ReviewAnchorSchema.optional(),
  entries: z.array(ReviewThreadEntrySchema).default([]),
  resolved_at: DateTimeSchema.nullable().optional(),
  resolved_by: z.string().nullable().optional(),
});

// --- Checks ---

export const ReviewCheckStatusSchema = z.enum(["pass", "fail", "running", "skipped"]);

export const ReviewCheckSchema = z.object({
  name: z.string(),
  status: ReviewCheckStatusSchema,
  required: z.boolean().default(true),
  runner: z.string().optional(),
  evidence: z.string().optional(),
  applies_to_version: ReviewSubjectVersionSchema,
  created_at: DateTimeSchema,
  completed_at: DateTimeSchema.nullable().optional(),
});

// --- Verdicts ---

export const ReviewVerdictDecisionSchema = z.enum(["approve", "request_changes", "comment"]);

export const ReviewVerdictSchema = z.object({
  reviewer: z.string(),
  role: z.string().default("reviewer"),
  decision: ReviewVerdictDecisionSchema,
  applies_to_version: ReviewSubjectVersionSchema,
  created_at: DateTimeSchema,
});

// --- Events ---

// AC: @review-record-core-model ac-4
export const ReviewEventTypeSchema = z.enum([
  "lifecycle_change",
  "verdict_submitted",
  "thread_created",
  "thread_replied",
  "thread_resolved",
  "thread_reopened",
  "check_added",
  "subject_refreshed",
]);

export const ReviewEventSchema = z.object({
  _ulid: UlidSchema,
  event_type: ReviewEventTypeSchema,
  actor: z.string(),
  timestamp: DateTimeSchema,
  payload: z.record(z.unknown()).default({}),
});

// --- External Links ---

export const ReviewExternalLinkSchema = z.object({
  url: z.string().url(),
  provider: z.string().optional(),
  external_id: z.string().optional(),
  label: z.string().optional(),
});

// --- Review Record ---

// AC: @review-record-core-model ac-1, ac-2, ac-3, ac-4
export const ReviewRecordSchema = z.object({
  // Identity
  _ulid: UlidSchema,
  slugs: z.array(SlugSchema).default([]),
  title: z.string().min(1, "Title is required"),

  // State
  lifecycle_state: ReviewLifecycleStateSchema.default("draft"),

  // Subject binding
  subject: ReviewSubjectSchema,

  // Author
  author: z.string(),

  // Related refs (e.g. tasks associated with a code review)
  related_refs: z.array(RefSchema).default([]),

  // Threads
  threads: z.array(ReviewThreadSchema).default([]),

  // Checks
  checks: z.array(ReviewCheckSchema).default([]),

  // Verdicts
  verdicts: z.array(ReviewVerdictSchema).default([]),

  // Events (append-only audit log)
  events: z.array(ReviewEventSchema).default([]),

  // Notes (human-readable context)
  notes: z.array(NoteSchema).default([]),

  // External links (non-authoritative)
  external_links: z.array(ReviewExternalLinkSchema).default([]),

  // AC: @review-fix-cycle-diff ac-1 — commit the reviewer examined
  examined_commit: z.string().nullable().default(null),

  // Timestamps
  created_at: DateTimeSchema.default(() => new Date().toISOString()),
  updated_at: DateTimeSchema.nullable().optional(),
});

/**
 * Review record input schema (for creating new reviews).
 * Most fields are optional - defaults will be applied.
 */
export const ReviewRecordInputSchema = z.object({
  _ulid: UlidSchema.optional(),
  slugs: z.array(SlugSchema).optional(),
  title: z.string().min(1, "Title is required"),

  lifecycle_state: ReviewLifecycleStateSchema.optional(),
  subject: ReviewSubjectSchema,
  author: z.string(),
  related_refs: z.array(RefSchema).optional(),

  threads: z.array(ReviewThreadSchema).optional(),
  checks: z.array(ReviewCheckSchema).optional(),
  verdicts: z.array(ReviewVerdictSchema).optional(),
  events: z.array(ReviewEventSchema).optional(),
  notes: z.array(NoteSchema).optional(),
  external_links: z.array(ReviewExternalLinkSchema).optional(),

  examined_commit: z.string().nullable().optional(),

  created_at: DateTimeSchema.optional(),
  updated_at: DateTimeSchema.nullable().optional(),
});

/**
 * Reviews file schema (collection of reviews).
 * Stored in project.reviews.yaml.
 */
export const ReviewRecordsFileSchema = z.object({
  kynetic_reviews: z.string().default("1.0"),
  reviews: z.array(ReviewRecordSchema),
});

// --- Type exports ---

export type ReviewLifecycleState = z.infer<typeof ReviewLifecycleStateSchema>;
export type ReviewDisposition = z.infer<typeof ReviewDispositionSchema>;
export type ReviewGateState = z.infer<typeof ReviewGateStateSchema>;
export type ReviewCodeSubject = z.infer<typeof ReviewCodeSubjectSchema>;
export type ReviewPlanSubject = z.infer<typeof ReviewPlanSubjectSchema>;
export type ReviewTaskSubject = z.infer<typeof ReviewTaskSubjectSchema>;
export type ReviewSpecSubject = z.infer<typeof ReviewSpecSubjectSchema>;
export type ReviewExternalSubject = z.infer<typeof ReviewExternalSubjectSchema>;
export type ReviewSubject = z.infer<typeof ReviewSubjectSchema>;
export type ReviewCodeCompareVersion = z.infer<typeof ReviewCodeCompareVersionSchema>;
export type ReviewEntityVersion = z.infer<typeof ReviewEntityVersionSchema>;
export type ReviewSubjectVersion = z.infer<typeof ReviewSubjectVersionSchema>;
export type ReviewCodeAnchor = z.infer<typeof ReviewCodeAnchorSchema>;
export type ReviewStructuredAnchor = z.infer<typeof ReviewStructuredAnchorSchema>;
export type ReviewSpecAcAnchor = z.infer<typeof ReviewSpecAcAnchorSchema>;
export type ReviewAnchor = z.infer<typeof ReviewAnchorSchema>;
export type ReviewThreadKind = z.infer<typeof ReviewThreadKindSchema>;
export type ReviewThreadEntry = z.infer<typeof ReviewThreadEntrySchema>;
export type ReviewThread = z.infer<typeof ReviewThreadSchema>;
export type ReviewCheckStatus = z.infer<typeof ReviewCheckStatusSchema>;
export type ReviewCheck = z.infer<typeof ReviewCheckSchema>;
export type ReviewVerdictDecision = z.infer<typeof ReviewVerdictDecisionSchema>;
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type ReviewEventType = z.infer<typeof ReviewEventTypeSchema>;
export type ReviewEvent = z.infer<typeof ReviewEventSchema>;
export type ReviewExternalLink = z.infer<typeof ReviewExternalLinkSchema>;
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
export type ReviewRecordInput = z.infer<typeof ReviewRecordInputSchema>;
export type ReviewRecordsFile = z.infer<typeof ReviewRecordsFileSchema>;
