import { z } from "zod";
import {
  DateTimeSchema,
  RefSchema,
  SlugSchema,
  SubmissionLinkageSchema,
  TaskStatusSchema,
  TaskTypeSchema,
  UlidSchema,
  VcsRefSchema,
} from "./common.js";

/**
 * Automation eligibility status for tasks
 * AC: @task-automation-eligibility ac-1
 * - eligible: Task can be processed by automation loops
 * - needs_review: Task was rejected by automation and needs human review
 * - manual_only: Task should only be handled by humans
 * - undefined/absent: Task has not been assessed for automation (unassessed)
 */
export const AutomationStatusSchema = z.enum([
  "eligible",
  "needs_review",
  "manual_only",
]);

export type AutomationStatus = z.infer<typeof AutomationStatusSchema>;

/**
 * Coarse dispatch-facing automation filter.
 * Derived from task automation semantics: "eligible" stays explicit and every
 * other canonical task automation state buckets into "ineligible".
 */
export const AgentDispatchAutomationFilterSchema = z.enum([
  "eligible",
  "ineligible",
]);

export type AgentDispatchAutomationFilter = z.infer<
  typeof AgentDispatchAutomationFilterSchema
>;

export function matchesAutomationFilter(
  status: AutomationStatus | undefined,
  filter: AgentDispatchAutomationFilter,
): boolean {
  return filter === "eligible" ? status === "eligible" : status !== "eligible";
}

/**
 * Note entry - append-only work log
 */
export const NoteSchema = z.object({
  _ulid: UlidSchema,
  created_at: DateTimeSchema,
  author: z.string().optional(),
  content: z.string(),
  supersedes: UlidSchema.nullable().optional(),
});

/**
 * Todo item - lightweight checklist
 */
export const TodoSchema = z.object({
  id: z.number().int().positive(),
  text: z.string(),
  done: z.boolean().default(false),
  done_at: DateTimeSchema.optional(),
  added_at: DateTimeSchema,
  added_by: z.string().optional(),
  promoted_to: RefSchema.optional(),
});

/**
 * Full task schema
 * Note: created_at defaults to now if not provided (auto-populated on load)
 */
export const TaskSchema = z.object({
  // Identity
  _ulid: UlidSchema,
  slugs: z.array(SlugSchema).default([]),
  title: z.string().min(1, "Title is required"),
  type: TaskTypeSchema.default("task"),

  // Content (doesn't duplicate spec - brief description for standalone context)
  description: z.string().optional(),

  // Spec relationship
  spec_ref: RefSchema.nullable().optional(),
  derivation: z.enum(["auto", "manual"]).optional(),

  // Meta relationship (links to workflow, agent, or convention for process improvement tracking)
  meta_ref: RefSchema.nullable().optional(),

  // Plan relationship (links to the plan this task was derived from)
  // AC: @plan-derive-enhanced ac-task-refs, ac-bidirectional-links
  plan_ref: RefSchema.nullable().optional(),

  // Origin tracking (where this task came from)
  origin: z.enum(["manual", "derived", "observation_promotion"]).optional(),

  // State
  status: TaskStatusSchema.default("pending"),
  blocked_by: z.array(z.string()).default([]),
  closed_reason: z.string().nullable().optional(),

  // Dependencies
  depends_on: z.array(RefSchema).default([]),
  context: z.array(RefSchema).default([]),

  // Work metadata
  priority: z.number().int().min(1).max(5).default(3),
  complexity: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string()).default([]),
  assignee: z.string().nullable().optional(),

  // VCS references
  vcs_refs: z.array(VcsRefSchema).default([]),

  // Review URL (PR, MR, or external review link — set at submit time)
  // AC: @task-submit ac-submit-2
  review_url: z.string().url().optional(),

  // Review record linkage (set automatically when a review targets or relates to this task)
  // AC: @review-task-lifecycle-integration ac-1
  review_ref: RefSchema.nullable().optional(),

  // AC: @portable-task-submission-linkage ac-1, ac-2, ac-3
  // Structured submission linkage: branch, commit, remote context
  submission_linkage: SubmissionLinkageSchema.nullable().optional(),

  // Session scoping (advisory, not enforced)
  // AC: @session-scoped-task-claiming ac-schema
  session_id: z.string().nullable().optional(),

  // Timestamps (auto-populated if not provided)
  created_at: DateTimeSchema.default(() => new Date().toISOString()),
  started_at: DateTimeSchema.nullable().optional(),
  submitted_at: DateTimeSchema.nullable().optional(),
  completed_at: DateTimeSchema.nullable().optional(),

  // Notes (work log)
  notes: z.array(NoteSchema).default([]),

  // Todos (emergent subtasks)
  todos: z.array(TodoSchema).default([]),

  // Automation eligibility (AC: @task-automation-eligibility ac-1, ac-2)
  // Optional - absent means unassessed
  automation: AutomationStatusSchema.optional(),
});

/**
 * Task input schema (for creating new tasks, some fields auto-generated)
 * All fields except title are optional - defaults will be applied
 */
export const TaskInputSchema = z.object({
  // Identity (auto-generated if not provided)
  _ulid: UlidSchema.optional(),
  slugs: z.array(SlugSchema).optional(),
  title: z.string().min(1, "Title is required"),
  type: TaskTypeSchema.optional(),

  // Content
  description: z.string().optional(),

  // Spec relationship
  spec_ref: RefSchema.nullable().optional(),
  derivation: z.enum(["auto", "manual"]).optional(),

  // Meta relationship
  meta_ref: RefSchema.nullable().optional(),

  // Plan relationship
  plan_ref: RefSchema.nullable().optional(),

  // Origin tracking
  origin: z.enum(["manual", "derived", "observation_promotion"]).optional(),

  // State
  status: TaskStatusSchema.optional(),
  blocked_by: z.array(z.string()).optional(),
  closed_reason: z.string().nullable().optional(),

  // Dependencies
  depends_on: z.array(RefSchema).optional(),
  context: z.array(RefSchema).optional(),

  // Work metadata
  priority: z.number().int().min(1).max(5).optional(),
  complexity: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string()).optional(),
  assignee: z.string().nullable().optional(),

  // VCS references
  vcs_refs: z.array(VcsRefSchema).optional(),

  // Review URL
  review_url: z.string().url().optional(),

  // Review record linkage
  review_ref: RefSchema.nullable().optional(),

  // Submission linkage
  submission_linkage: SubmissionLinkageSchema.nullable().optional(),

  // Session scoping
  session_id: z.string().nullable().optional(),

  // Timestamps
  created_at: DateTimeSchema.optional(),
  started_at: DateTimeSchema.nullable().optional(),
  submitted_at: DateTimeSchema.nullable().optional(),
  completed_at: DateTimeSchema.nullable().optional(),

  // Notes (work log)
  notes: z.array(NoteSchema).optional(),

  // Todos (emergent subtasks)
  todos: z.array(TodoSchema).optional(),

  // Automation eligibility (AC: @task-automation-eligibility ac-1, ac-2, ac-13)
  automation: AutomationStatusSchema.optional(),
});

/**
 * Tasks file schema (collection of tasks)
 */
export const TasksFileSchema = z.object({
  kynetic_tasks: z.string().default("1.0"),
  tasks: z.array(TaskSchema),
});

export type Note = z.infer<typeof NoteSchema>;
export type Todo = z.infer<typeof TodoSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = z.infer<typeof TaskInputSchema>;
export type TasksFile = z.infer<typeof TasksFileSchema>;
