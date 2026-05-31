/**
 * Core Type Definitions
 *
 * Basic types used throughout kspec that align with Zod schemas in src/schema.
 * These are plain TypeScript types without Zod dependencies for lightweight usage.
 */

/**
 * Task status values
 */
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "pending_review"
  | "blocked"
  | "completed"
  | "cancelled";

/**
 * Task type values
 */
export type TaskType = "epic" | "task" | "bug" | "spike" | "infra";

/**
 * Spec item type values
 */
export type ItemType =
  | "module"
  | "feature"
  | "requirement"
  | "constraint"
  | "decision"
  | "task"
  | "trait";

/**
 * Implementation status values
 */
export type ImplementationStatus = "not_started" | "in_progress" | "implemented" | "verified";

/**
 * Maturity status values
 */
export type Maturity = "draft" | "proposed" | "stable" | "deferred" | "deprecated";

/**
 * Observation type values
 */
export type ObservationType = "friction" | "success" | "question" | "idea";

/**
 * Agent dispatch event values — mirrors DispatchEventTypeSchema from src/schema/event-registry.ts.
 * When the event registry adds new events, update this union + AGENT_DISPATCH_EVENTS.
 * AC: @ui-agent-dispatch ac-4 — shared type for schema-driven edit form
 * AC: @dispatch-event-taxonomy ac-4 — existing values unchanged
 */
export type AgentDispatchEvent =
  // Task lifecycle events (existing, unchanged)
  | "task.in_progress"
  | "task.ready"
  | "task.needs_work"
  | "task.pending_review"
  // Invocation lifecycle events
  | "invocation.started"
  | "invocation.completed"
  | "invocation.failed"
  | "invocation.stalled"
  // Session lifecycle events
  | "session.idle"
  | "session.ended"
  | "session.idle_timeout"
  | "session.cancelled"
  // Schedule events
  | "schedule.tick"
  // Action run tracking events
  | "action.started"
  | "action.completed"
  | "action.failed";

/**
 * All valid dispatch events as a const array — for form dropdowns and validation.
 * Single source of truth for the web layer; mirrors DispatchEventTypeSchema values.
 * AC: @ui-agent-dispatch ac-4
 */
export const AGENT_DISPATCH_EVENTS: readonly AgentDispatchEvent[] = [
  "task.in_progress",
  "task.ready",
  "task.needs_work",
  "task.pending_review",
  "invocation.started",
  "invocation.completed",
  "invocation.failed",
  "invocation.stalled",
  "session.idle",
  "session.ended",
  "session.idle_timeout",
  "session.cancelled",
  "schedule.tick",
  "action.started",
  "action.completed",
  "action.failed",
] as const;

/**
 * Agent dispatch filter — mirrors AgentDispatchFilterSchema from src/schema/meta.ts.
 * AC: @ui-agent-dispatch ac-4
 */
export interface AgentDispatchFilter {
  automation?: "eligible" | "ineligible";
  tags?: string[];
  priority?: number;
}

/**
 * Agent dispatch rule — mirrors AgentDispatchRuleSchema from src/schema/meta.ts.
 * AC: @ui-agent-dispatch ac-4
 */
export interface AgentDispatchRule {
  on: AgentDispatchEvent;
  filter?: AgentDispatchFilter;
}

/**
 * Agent budget settings — mirrors AgentBudgetSchema from src/schema/meta.ts.
 * AC: @ui-agent-dispatch ac-4
 */
export interface AgentBudget {
  max_tasks?: number;
  max_retries?: number;
  timeout_minutes?: number;
}

/**
 * Agent concurrency settings — mirrors AgentConcurrencySchema from src/schema/meta.ts.
 * AC: @ui-agent-dispatch ac-4
 */
export interface AgentConcurrency {
  max_concurrent: number;
}

/**
 * Single runner validation diagnostic returned by the daemon API.
 * Mirrors `RunnerValidationIssue` in src/agents/runner-validation.ts.
 *
 * AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
 */
export interface AgentRunnerValidationDiagnostic {
  /** Stable reason code so structured callers can branch without parsing text. */
  reason: string;
  /** Operator-facing diagnostic — already redacted of any secret material. */
  message: string;
  /** Free-form structured details. Never contains secret values. */
  details?: Record<string, unknown>;
}

/**
 * Runner validation summary attached to agent API entries when the agent
 * declares a `runner` field. Mirrors the structured block emitted by
 * `kspec agent list --json` so daemon/Web UI surfaces share the same shape.
 *
 * AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
 * AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
 */
export interface AgentRunnerValidation {
  status: "valid" | "invalid";
  diagnostics: AgentRunnerValidationDiagnostic[];
}

/**
 * Full agent definition — mirrors AgentSchema from src/schema/meta.ts.
 * This is the canonical API contract type for the web layer.
 * The Zod schema (AgentSchema) is the authoritative definition;
 * this interface must be kept in sync with it.
 * AC: @ui-agent-dispatch ac-4
 * AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
 */
export interface AgentDefinition {
  _ulid: string;
  id: string;
  name: string;
  description?: string;
  capabilities: string[];
  tools: string[];
  session_protocol?: { start?: string | null; checkpoint?: string | null; end?: string | null };
  conventions: string[];
  adapter?: string;
  /**
   * Optional reference to a named runner from the layered runner config.
   * Mirrors AgentSchema.runner in src/schema/meta.ts.
   * AC: @agent-runner-configuration ac-agent-runner-reference
   */
  runner?: string;
  /**
   * Adapter identity the daemon resolved through the runner registry (or
   * the legacy `adapter` field when no runner is configured). Present on
   * read responses; not editable.
   * AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
   */
  resolved_adapter?: string;
  /**
   * Runner validation summary. Present on read responses when the agent
   * declares a runner field; absent for legacy adapter-backed agents.
   * AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
   */
  runner_validation?: AgentRunnerValidation;
  dispatch: AgentDispatchRule[];
  skills: string[];
  budget?: AgentBudget;
  concurrency: AgentConcurrency;
  auto_approve: boolean;
  prompt_template?: string;
  automation?: "eligible" | "ineligible";
  tags?: string[];
}

/**
 * Editable fields for PATCH /api/meta/agents/:id — derived from AgentDefinition.
 * Excludes identity fields (_ulid, id) that cannot be changed via edit.
 * AC: @ui-agent-dispatch ac-4
 * AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner
 */
export type AgentUpdatePayload = Partial<
  Pick<
    AgentDefinition,
    | "name"
    | "description"
    | "adapter"
    | "dispatch"
    | "capabilities"
    | "tools"
    | "skills"
    | "budget"
    | "concurrency"
    | "auto_approve"
    | "prompt_template"
  >
> & {
  /**
   * Runner reference update. `null` clears the runner field, a string
   * sets it. Omit the property entirely to leave the runner unchanged.
   * AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner
   */
  runner?: string | null;
};
