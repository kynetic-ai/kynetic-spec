import { z } from "zod";
import { DateTimeSchema, RefSchema, UlidSchema } from "./common.js";
import { HookSchema } from "./hooks.js";

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
 * Agent dispatch event types - lifecycle events that can trigger agent spawning
 * AC: @agent-definition-schema ac-2
 */
export const AgentDispatchEventSchema = z.enum([
  "task.in_progress",
  "task.ready",
  "task.needs_work",
  "task.pending_review",
]);

/**
 * Agent dispatch filter - constraints for matching tasks during dispatch
 * AC: @agent-definition-schema ac-3
 */
export const AgentDispatchFilterSchema = z.object({
  automation: z.enum(["eligible", "ineligible"]).optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().optional(),
});

/**
 * Agent dispatch rule - maps an event type to optional filters
 * AC: @agent-definition-schema ac-2
 */
export const AgentDispatchRuleSchema = z.object({
  on: AgentDispatchEventSchema,
  filter: AgentDispatchFilterSchema.optional(),
});

/**
 * Agent budget settings - limits on task count and time
 * AC: @agent-definition-schema ac-4
 */
export const AgentBudgetSchema = z.object({
  max_tasks: z.number().positive().optional(),
  max_retries: z.number().int().nonnegative().optional(),
  timeout_minutes: z.number().positive().optional(),
  initial_response_timeout_seconds: z.number().int().positive().optional(),
});

/**
 * Agent concurrency settings
 * AC: @agent-definition-schema ac-6
 */
export const AgentConcurrencySchema = z.object({
  max_concurrent: z.number().int().positive().default(1),
});

export const AgentBootstrapStepSchema = z.object({
  run: z.string().min(1, "Bootstrap command is required"),
  name: z.string().optional(),
  roles: z.array(z.enum(["worker", "reviewer"])).optional(),
  idempotent: z.boolean().optional(),
  allow_tracked_changes: z.boolean().optional(),
  reviewer_rerun_allowed: z.boolean().optional(),
});

export const AgentBootstrapSchema = z.object({
  steps: z.array(AgentBootstrapStepSchema).default([]),
});

/**
 * Agent definition - describes an agent's role and capabilities
 * AC: @agent-definition-schema ac-1 through ac-8
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
  // New dispatch/runtime fields (AC: @agent-definition-schema ac-1 through ac-8)
  adapter: z.string().optional(),
  dispatch: z.array(AgentDispatchRuleSchema).default([]),
  skills: z.array(z.string()).default([]),
  budget: AgentBudgetSchema.optional(),
  concurrency: AgentConcurrencySchema.default({ max_concurrent: 1 }),
  bootstrap: AgentBootstrapSchema.optional(),
  auto_approve: z.boolean().default(false),
  prompt_template: z.string().optional(),
  /** Automation eligibility for agent list filtering (eligible|ineligible) */
  automation: z.enum(["eligible", "ineligible"]).optional(),
  /** Tags for filtering and categorization */
  tags: z.array(z.string()).default([]).optional(),
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
 * Workflow mode - interactive (default) for human-in-loop, loop for autonomous agents
 */
export const WorkflowModeSchema = z.enum(["interactive", "loop"]);

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
  mode: WorkflowModeSchema.default("interactive").optional(),
  based_on: RefSchema.optional(),
  tags: z.array(z.string()).default([]).optional(),
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
 * Skill origin - where the skill comes from
 */
export const SkillOriginSchema = z.enum(["core", "project", "local"]);

/**
 * Claude Code platform config - settings specific to Claude Code
 */
export const ClaudeCodeConfigSchema = z
  .object({
    disable_model_invocation: z.boolean().optional(),
    user_invocable: z.boolean().optional(),
    context: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    argument_hint: z.string().optional(),
  })
  .strict();

/**
 * Codex platform config - settings specific to OpenAI Codex CLI
 */
export const CodexConfigSchema = z
  .object({
    allow_implicit_invocation: z.boolean().optional(),
    display_name: z.string().optional(),
    short_description: z.string().optional(),
    icon_small: z.string().optional(),
    icon_large: z.string().optional(),
    brand_color: z.string().optional(),
    default_prompt: z.string().optional(),
  })
  .strict();

/**
 * Droid platform config - same portable frontmatter shape as Claude Code
 * without the Claude-specific agent field.
 */
export const DroidConfigSchema = z
  .object({
    disable_model_invocation: z.boolean().optional(),
    user_invocable: z.boolean().optional(),
    context: z.string().optional(),
    model: z.string().optional(),
    argument_hint: z.string().optional(),
  })
  .strict();

/**
 * Platform config - container for platform-specific settings
 * Uses passthrough for unknown platforms to support future extensibility
 */
export const PlatformConfigSchema = z
  .object({
    claude_code: ClaudeCodeConfigSchema.optional(),
    codex: CodexConfigSchema.optional(),
    droid: DroidConfigSchema.optional(),
  })
  .passthrough();

/**
 * Kebab-case regex for skill IDs - lowercase letters, numbers, and hyphens only
 * Must start with a letter and not end with a hyphen
 */
const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Skill definition - reusable agent capabilities stored in files
 * Content is stored in .kspec/skills/<id>/SKILL.md
 *
 * Extended with portable Agent Skills fields for multi-platform support:
 * - license, compatibility, allowed_tools for portability
 * - metadata for arbitrary key-value pairs
 * - platform_config for platform-specific settings
 */
export const SkillSchema = z.object({
  _ulid: MetaUlidSchema,
  _type: z.literal("skill").default("skill"),
  id: z
    .string({ required_error: "Skill ID is required" })
    .regex(
      KEBAB_CASE_REGEX,
      "Skill ID must be in kebab-case format (lowercase letters, numbers, and hyphens)",
    ),
  name: z.string().min(1, "Skill name is required"),
  description: z.string().optional(),
  origin: SkillOriginSchema,
  version: z.string().optional(),
  platforms: z.array(z.string()).default(["claude-code"]),
  depends_on: z.array(RefSchema).default([]),
  tags: z.array(z.string()).default([]),
  // Portable Agent Skills fields
  license: z.string().optional(),
  compatibility: z.string().optional(),
  allowed_tools: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  platform_config: PlatformConfigSchema.optional(),
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
 * Workflow run result - distinguishes between different completion types
 */
export const WorkflowRunResultSchema = z.enum([
  "success", // Normal completion through all steps
  "no_work_available", // Graceful exit - no eligible work to process
  "early_exit", // Intentional exit before all steps (not an error)
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
  result: WorkflowRunResultSchema.optional(), // Only set for completed runs
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
 * AC: @dispatch-hook-schema ac-4 — hooks defaults to empty array
 */
export const MetaManifestSchema = z.object({
  kynetic_meta: z.string().default("1.0"),
  agents: z.array(AgentSchema).default([]),
  workflows: z.array(WorkflowSchema).default([]),
  conventions: z.array(ConventionSchema).default([]),
  observations: z.array(ObservationSchema).default([]),
  skills: z.array(SkillSchema).default([]),
  hooks: z.array(HookSchema).default([]),
  includes: z.array(z.string()).default([]),
});

// Type exports
export type SessionProtocol = z.infer<typeof SessionProtocolSchema>;
export type AgentDispatchEvent = z.infer<typeof AgentDispatchEventSchema>;
export type AgentDispatchFilter = z.infer<typeof AgentDispatchFilterSchema>;
export type AgentDispatchRule = z.infer<typeof AgentDispatchRuleSchema>;
export type AgentBudget = z.infer<typeof AgentBudgetSchema>;
export type AgentConcurrency = z.infer<typeof AgentConcurrencySchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type WorkflowStepType = z.infer<typeof WorkflowStepTypeSchema>;
export type StepExecution = z.infer<typeof StepExecutionSchema>;
export type StepInput = z.infer<typeof StepInputSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type WorkflowMode = z.infer<typeof WorkflowModeSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type ConventionExample = z.infer<typeof ConventionExampleSchema>;
export type ConventionValidation = z.infer<typeof ConventionValidationSchema>;
export type Convention = z.infer<typeof ConventionSchema>;
export type ObservationType = z.infer<typeof ObservationTypeSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type SkillOrigin = z.infer<typeof SkillOriginSchema>;
export type ClaudeCodeConfig = z.infer<typeof ClaudeCodeConfigSchema>;
export type CodexConfig = z.infer<typeof CodexConfigSchema>;
export type DroidConfig = z.infer<typeof DroidConfigSchema>;
export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type SessionContext = z.infer<typeof SessionContextSchema>;
export type MetaManifest = z.infer<typeof MetaManifestSchema>;
export type StepResultStatus = z.infer<typeof StepResultStatusSchema>;
export type StepResult = z.infer<typeof StepResultSchema>;
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export type WorkflowRunResult = z.infer<typeof WorkflowRunResultSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export type WorkflowRunsFile = z.infer<typeof WorkflowRunsFileSchema>;

/**
 * Meta item type - union of all meta item types
 */
export type MetaItem = Agent | Workflow | Convention | Observation | Skill;

/**
 * Type guard for skill items
 * Uses _type discriminant field for reliable discrimination
 */
export function isSkill(item: MetaItem | unknown): item is Skill {
  return (
    typeof item === "object" &&
    item !== null &&
    "_type" in item &&
    (item as { _type: unknown })._type === "skill"
  );
}

/**
 * Determine the type of a meta item
 * AC: @skill-meta-type ac-7 - skills discriminated by _type field
 */
export function getMetaItemType(
  item: MetaItem,
): "agent" | "workflow" | "convention" | "observation" | "skill" {
  if (isSkill(item)) return "skill";
  if ("capabilities" in item) return "agent";
  if ("trigger" in item) return "workflow";
  if ("domain" in item) return "convention";
  return "observation";
}
