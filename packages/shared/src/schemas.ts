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
  | 'pending'
  | 'in_progress'
  | 'pending_review'
  | 'blocked'
  | 'completed'
  | 'cancelled';

/**
 * Task type values
 */
export type TaskType =
  | 'epic'
  | 'task'
  | 'bug'
  | 'spike'
  | 'infra';

/**
 * Spec item type values
 */
export type ItemType =
  | 'module'
  | 'feature'
  | 'requirement'
  | 'constraint'
  | 'decision'
  | 'task'
  | 'trait';

/**
 * Implementation status values
 */
export type ImplementationStatus =
  | 'not_started'
  | 'in_progress'
  | 'implemented'
  | 'verified';

/**
 * Maturity status values
 */
export type Maturity =
  | 'draft'
  | 'proposed'
  | 'stable'
  | 'deferred'
  | 'deprecated';

/**
 * Observation type values
 */
export type ObservationType =
  | 'friction'
  | 'success'
  | 'question'
  | 'idea';

/**
 * Agent dispatch event values — mirrors AgentDispatchEventSchema enum from src/schema/meta.ts.
 * When AgentDispatchEventSchema adds new events, update this union + AGENT_DISPATCH_EVENTS.
 * AC: @ui-agent-dispatch ac-4 — shared type for schema-driven edit form
 */
export type AgentDispatchEvent =
  | 'task.in_progress'
  | 'task.ready'
  | 'task.needs_work'
  | 'task.pending_review';

/**
 * All valid dispatch events as a const array — for form dropdowns and validation.
 * Single source of truth for the web layer; mirrors AgentDispatchEventSchema values.
 * AC: @ui-agent-dispatch ac-4
 */
export const AGENT_DISPATCH_EVENTS: readonly AgentDispatchEvent[] = [
  'task.in_progress',
  'task.ready',
  'task.needs_work',
  'task.pending_review',
] as const;

/**
 * Agent dispatch filter — mirrors AgentDispatchFilterSchema from src/schema/meta.ts.
 * AC: @ui-agent-dispatch ac-4
 */
export interface AgentDispatchFilter {
  automation?: 'eligible' | 'ineligible';
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
 * Full agent definition — mirrors AgentSchema from src/schema/meta.ts.
 * This is the canonical API contract type for the web layer.
 * The Zod schema (AgentSchema) is the authoritative definition;
 * this interface must be kept in sync with it.
 * AC: @ui-agent-dispatch ac-4
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
  dispatch: AgentDispatchRule[];
  skills: string[];
  budget?: AgentBudget;
  concurrency: AgentConcurrency;
  auto_approve: boolean;
  prompt_template?: string;
  automation?: 'eligible' | 'ineligible';
  tags?: string[];
}

/**
 * Editable fields for PATCH /api/meta/agents/:id — derived from AgentDefinition.
 * Excludes identity fields (_ulid, id) that cannot be changed via edit.
 * AC: @ui-agent-dispatch ac-4
 */
export type AgentUpdatePayload = Partial<
  Pick<
    AgentDefinition,
    | 'name'
    | 'description'
    | 'adapter'
    | 'dispatch'
    | 'capabilities'
    | 'tools'
    | 'skills'
    | 'budget'
    | 'concurrency'
    | 'auto_approve'
    | 'prompt_template'
  >
>;
