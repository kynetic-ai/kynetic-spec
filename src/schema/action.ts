/**
 * Action Model Schema
 *
 * Defines the shared action model used by hooks, schedules, and composition
 * join triggers. Four action types (command, kspec, agent, notify) and the
 * action run tracking record.
 *
 * AC: @dispatch-action-model ac-1 through ac-9
 */

import { z } from "zod";
import { UlidSchema, DateTimeSchema } from "./common.js";

// ─── Action Type Schemas ─────────────────────────────────────────────────────

/**
 * Command action — runs an executable as a child process.
 * Uses structured program + args form (no shell by default) to eliminate injection risks.
 * AC: @dispatch-action-model ac-1, ac-2
 * AC: @dispatch-command-action ac-1
 */
export const CommandActionSchema = z.object({
  type: z.literal("command"),
  /** The executable path or name (program to run) */
  command: z.string().min(1, "Command is required"),
  /** Arguments to pass to the command — each is a separate argv element */
  args: z.array(z.string()).default([]),
  /** Optional timeout in milliseconds. Process is killed if exceeded. */
  timeout_ms: z.number().int().positive().optional(),
  /** Optional working directory override */
  cwd: z.string().optional(),
  /** Optional environment variables */
  env: z.record(z.string(), z.string()).optional(),
  /** Whether to run in shell mode — false by default for injection safety */
  shell: z.boolean().default(false),
});

/**
 * Kspec action — runs a kspec CLI command in the project root.
 * AC: @dispatch-action-model ac-3
 */
export const KspecActionSchema = z.object({
  type: z.literal("kspec"),
  /** The kspec subcommand and arguments (e.g. "task list --json") */
  command: z.string().min(1, "Kspec command is required"),
  /** Optional timeout in milliseconds */
  timeout_ms: z.number().int().positive().optional(),
});

/**
 * Agent action — spawns a new agent invocation.
 * AC: @dispatch-action-model ac-4, ac-5
 */
export const AgentActionSchema = z.object({
  type: z.literal("agent"),
  /** The agent definition ID to spawn */
  agent_id: z.string().min(1, "Agent ID is required"),
  /** Optional prompt override */
  prompt: z.string().optional(),
  /** Optional task reference to scope the invocation */
  task_ref: z.string().optional(),
  /** Optional timeout in minutes */
  timeout_minutes: z.number().positive().optional(),
});

/**
 * Notify action — emits a WebSocket notification.
 * AC: @dispatch-action-model ac-6
 */
export const NotifyActionSchema = z.object({
  type: z.literal("notify"),
  /** The notification message or template */
  message: z.string().min(1, "Notification message is required"),
  /** Optional topic to broadcast on (defaults to "automation") */
  topic: z.string().default("automation"),
});

/**
 * Discriminated union of all action types.
 */
export const ActionSchema = z.discriminatedUnion("type", [
  CommandActionSchema,
  KspecActionSchema,
  AgentActionSchema,
  NotifyActionSchema,
]);

/**
 * Valid action type identifiers.
 */
export const ACTION_TYPES = ["command", "kspec", "agent", "notify"] as const;

// ─── Action Run Schema ───────────────────────────────────────────────────────

/**
 * Action run status — tracks the lifecycle of a single action execution.
 */
export const ActionRunStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
]);

/**
 * Action run — lightweight tracking record for a single action execution.
 * Every action execution produces exactly one action run.
 */
export const ActionRunSchema = z.object({
  /** Unique identifier for this action run */
  action_run_id: UlidSchema,
  /** The action type that was executed */
  action_type: z.enum(["command", "kspec", "agent", "notify"]),
  /** Current status */
  status: ActionRunStatusSchema,
  /** When the run started */
  started_at: DateTimeSchema,
  /** When the run completed (set on terminal state) */
  completed_at: DateTimeSchema.optional(),
  /** Duration in milliseconds (set on terminal state) */
  duration_ms: z.number().nonnegative().optional(),
  /** Linked invocation ID (for agent actions only) */
  invocation_id: z.string().optional(),
  /** Process ID (for command and kspec actions) */
  pid: z.number().int().optional(),
  /** Exit code (for command and kspec actions) */
  exit_code: z.number().int().optional(),
  /** Error message if the run failed */
  error: z.string().optional(),
  /** Failure reason category */
  failure_reason: z.enum(["timeout", "exit_code", "signal", "spawn_error", "error"]).optional(),
  /** The source hook or schedule name that triggered this action */
  source_name: z.string().optional(),
  /** The event type that triggered this action */
  source_event_type: z.string().optional(),
});

// ─── Template Variable Schema ────────────────────────────────────────────────

/**
 * Regex for matching {{variable}} template placeholders.
 */
export const TEMPLATE_VAR_PATTERN = /\{\{(\w+)\}\}/g;

// ─── Type Exports ────────────────────────────────────────────────────────────

export type CommandAction = z.infer<typeof CommandActionSchema>;
export type KspecAction = z.infer<typeof KspecActionSchema>;
export type AgentAction = z.infer<typeof AgentActionSchema>;
export type NotifyAction = z.infer<typeof NotifyActionSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type ActionRunStatus = z.infer<typeof ActionRunStatusSchema>;
export type ActionRun = z.infer<typeof ActionRunSchema>;
