import { z } from "zod";
import { DateTimeSchema, RefSchema, UlidSchema } from "./common.js";

/**
 * ULID schema for meta items - uses the same strict validation as core items.
 * All ULIDs must be exactly 26 characters in Crockford base32 format.
 */
const MetaUlidSchema = UlidSchema;

/**
 * Agent session protocol - commands to run at session lifecycle events
 */
export const SessionProtocolSchema = z.object({
  start: z.string().nullable().optional(),
  checkpoint: z.string().nullable().optional(),
  end: z.string().nullable().optional(),
});

/**
 * Agent definition - describes an agent's role and capabilities
 */
export const AgentSchema = z.object({
  _ulid: MetaUlidSchema,
  id: z.string().min(1, "Agent ID is required"),
  name: z.string().min(1, "Agent name is required"),
  description: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  session_protocol: SessionProtocolSchema.optional(),
  conventions: z.array(z.string()).default([]),
});

/**
 * Workflow step types
 */
export const WorkflowStepTypeSchema = z.enum(["check", "action", "decision"]);

/**
 * Workflow step execution hints
 */
export const StepExecutionSchema = z.object({
  mode: z.enum(["prompt", "silent", "skip"]).default("prompt"),
  timeout: z.number().nullable().optional(),
});

/**
 * Workflow step input definition
 */
export const StepInputSchema = z.object({
  name: z.string().min(1, "Input name is required"),
  description: z.string().optional(),
  required: z.boolean().default(true).optional(),
  type: z.enum(["string", "ref", "number"]).default("string").optional(),
});

/**
 * Workflow step - a single step in a workflow
 */
export const WorkflowStepSchema = z.object({
  type: WorkflowStepTypeSchema,
  content: z.string(),
  on_fail: z.string().optional(),
  options: z.array(z.string()).optional(), // For decision type
  execution: StepExecutionSchema.optional(),
  entry_criteria: z.array(z.string()).optional(),
  exit_criteria: z.array(z.string()).optional(),
  inputs: z.array(StepInputSchema).optional(),
});

/**
 * Workflow definition - structured process definition
 */
export const WorkflowSchema = z.object({
  _ulid: MetaUlidSchema,
  id: z.string().min(1, "Workflow ID is required"),
  trigger: z.string().min(1, "Workflow trigger is required"),
  description: z.string().optional(),
  steps: z.array(WorkflowStepSchema).default([]),
  enforcement: z.enum(["advisory", "strict"]).default("advisory").optional(),
});

/**
 * Convention example (good/bad)
 */
export const ConventionExampleSchema = z.object({
  good: z.string(),
  bad: z.string(),
});

/**
 * Convention validation configuration
 */
export const ConventionValidationSchema = z.object({
  type: z.enum(["regex", "enum", "range", "prose"]),
  // For regex
  pattern: z.string().optional(),
  message: z.string().optional(),
  // For enum
  allowed: z.array(z.string()).optional(),
  // For range
  min: z.number().optional(),
  max: z.number().optional(),
  unit: z.enum(["words", "chars", "lines"]).optional(),
});

/**
 * Convention definition - project-specific rules and standards
 */
export const ConventionSchema = z.object({
  _ulid: MetaUlidSchema,
  domain: z.string().min(1, "Convention domain is required"),
  rules: z.array(z.string()).default([]),
  examples: z.array(ConventionExampleSchema).default([]),
  validation: ConventionValidationSchema.optional(),
});

/**
 * Observation types
 */
export const ObservationTypeSchema = z.enum([
  "friction",
  "success",
  "question",
  "idea",
]);

/**
 * Observation - feedback about workflows and conventions
 */
export const ObservationSchema = z.object({
  _ulid: MetaUlidSchema,
  type: ObservationTypeSchema,
  workflow_ref: RefSchema.optional(),
  content: z.string().min(1, "Observation content is required"),
  created_at: DateTimeSchema,
  author: z.string().optional(),
  resolved: z.boolean().default(false),
  resolution: z.string().nullable().optional(),
  resolved_at: DateTimeSchema.optional(),
  resolved_by: z.string().optional(),
  promoted_to: RefSchema.optional(),
});

/**
 * Session context schema - ephemeral session state
 */
export const SessionContextSchema = z.object({
  focus: z.string().nullable(),
  threads: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
  updated_at: DateTimeSchema,
});

/**
 * Step result status
 */
export const StepResultStatusSchema = z.enum([
  "completed",
  "skipped",
  "failed",
]);

/**
 * Step result schema - result of executing a workflow step
 */
export const StepResultSchema = z.object({
  step_index: z.number(),
  status: StepResultStatusSchema,
  started_at: DateTimeSchema,
  completed_at: DateTimeSchema,
  entry_confirmed: z.boolean().optional(),
  exit_confirmed: z.boolean().optional(),
  notes: z.string().optional(),
  inputs: z.record(z.string()).optional(),
});

/**
 * Workflow run status
 */
export const WorkflowRunStatusSchema = z.enum([
  "active",
  "paused",
  "completed",
  "aborted",
]);

/**
 * Workflow run schema - tracks execution of a workflow
 */
export const WorkflowRunSchema = z.object({
  _ulid: UlidSchema,
  workflow_ref: RefSchema,
  status: WorkflowRunStatusSchema,
  current_step: z.number(),
  total_steps: z.number(),
  started_at: DateTimeSchema,
  paused_at: DateTimeSchema.optional(),
  completed_at: DateTimeSchema.optional(),
  step_results: z.array(StepResultSchema).default([]),
  initiated_by: z.string().optional(),
  abort_reason: z.string().optional(),
  task_ref: RefSchema.optional(),
});

/**
 * Workflow runs file schema - container for all workflow runs
 */
export const WorkflowRunsFileSchema = z.object({
  kynetic_runs: z.string().default("1.0"),
  runs: z.array(WorkflowRunSchema).default([]),
});

/**
 * Meta manifest schema - the root structure for kynetic.meta.yaml
 */
export const MetaManifestSchema = z.object({
  kynetic_meta: z.string().default("1.0"),
  agents: z.array(AgentSchema).default([]),
  workflows: z.array(WorkflowSchema).default([]),
  conventions: z.array(ConventionSchema).default([]),
  observations: z.array(ObservationSchema).default([]),
  includes: z.array(z.string()).default([]),
});

// Type exports
export type SessionProtocol = z.infer<typeof SessionProtocolSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type WorkflowStepType = z.infer<typeof WorkflowStepTypeSchema>;
export type StepExecution = z.infer<typeof StepExecutionSchema>;
export type StepInput = z.infer<typeof StepInputSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type ConventionExample = z.infer<typeof ConventionExampleSchema>;
export type ConventionValidation = z.infer<typeof ConventionValidationSchema>;
export type Convention = z.infer<typeof ConventionSchema>;
export type ObservationType = z.infer<typeof ObservationTypeSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type SessionContext = z.infer<typeof SessionContextSchema>;
export type MetaManifest = z.infer<typeof MetaManifestSchema>;
export type StepResultStatus = z.infer<typeof StepResultStatusSchema>;
export type StepResult = z.infer<typeof StepResultSchema>;
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export type WorkflowRunsFile = z.infer<typeof WorkflowRunsFileSchema>;

/**
 * Meta item type - union of all meta item types
 */
export type MetaItem = Agent | Workflow | Convention | Observation;

/**
 * Determine the type of a meta item
 */
export function getMetaItemType(
  item: MetaItem,
): "agent" | "workflow" | "convention" | "observation" {
  if ("capabilities" in item) return "agent";
  if ("trigger" in item) return "workflow";
  if ("domain" in item) return "convention";
  return "observation";
}
