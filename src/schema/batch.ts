import { z } from "zod";

/**
 * Schema for a single command in a batch execution payload.
 *
 * AC: @batch-command-schema ac-command-field — command is a string command path
 * AC: @batch-command-schema ac-args-mapping — args map to CLI parameters
 * AC: @batch-command-schema ac-id-field — optional correlation id
 */
export const BatchCommandSchema = z.object({
  /** CLI command path, e.g. "task add" or "item note" */
  command: z.string().min(1, "Command path is required"),
  /** Arguments/options keyed by flag name (without --) or positional arg name */
  args: z.record(z.string(), z.unknown()).default({}),
  /** Optional correlation ID for matching results to commands */
  id: z.string().optional(),
});

export type BatchCommand = z.infer<typeof BatchCommandSchema>;

/**
 * Schema for the full batch input — an array of commands.
 * Must contain at least one command.
 */
export const BatchInputSchema = z
  .array(BatchCommandSchema)
  .min(1, "Batch must contain at least one command");

export type BatchInput = z.infer<typeof BatchInputSchema>;

/**
 * Result of executing a single batch command.
 */
export interface BatchCommandResult {
  /** Index in the original batch array */
  index: number;
  /** Correlation ID if provided */
  id?: string;
  /** The command path that was executed */
  command: string;
  /** Whether execution succeeded */
  success: boolean;
  /** Command output on success */
  output?: unknown;
  /** Error message on failure */
  error?: string;
  /** Suggested correction (e.g. closest arg name) */
  suggestion?: string;
}

/**
 * Summary counts for batch execution.
 */
export interface BatchExecSummary {
  total: number;
  succeeded: number;
  failed: number;
}

/**
 * Execution mode for batch commands.
 * - "atomic": all-or-nothing with temp copy (default)
 * - "immediate": per-command commits, no rollback
 */
export type BatchExecMode = "atomic" | "immediate";

/**
 * Complete result of a batch execution.
 */
export interface BatchExecResult {
  /** Overall success (true only if all commands succeeded) */
  success: boolean;
  /** Execution mode used */
  mode: BatchExecMode;
  /** Aggregate counts */
  summary: BatchExecSummary;
  /** Per-command results */
  results: BatchCommandResult[];
  /** True if failure was due to pre-validation errors (unknown command, unknown arg, etc.) */
  validationFailed?: boolean;
}
