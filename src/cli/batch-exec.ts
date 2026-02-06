/**
 * Batch command parsing, validation, and error reporting.
 *
 * Parses JSON batch input from stdin/file/inline, validates command paths
 * against the CLI's introspection tree, and produces helpful error messages.
 */

import * as fs from "node:fs/promises";
import { ZodError } from "zod";
import {
  BatchInputSchema,
  type BatchCommand,
  type BatchInput,
} from "../schema/batch.js";
import type { CommandMeta } from "./introspection.js";
import { findCommand, flattenCommandTree } from "./introspection.js";
import { findClosestCommand } from "./suggest.js";

// ── Input Source Types ───────────────────────────────────────────────

export type BatchInputSource =
  | { type: "stdin" }
  | { type: "file"; path: string }
  | { type: "inline"; json: string };

// ── Error Types ─────────────────────────────────────────────────────

export class BatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchParseError";
  }
}

export type BatchValidationErrorType =
  | "unknown_command"
  | "missing_required"
  | "unknown_arg"
  | "rejected_command";

export interface BatchValidationError {
  /** Index in the batch array */
  index: number;
  /** Correlation ID if provided */
  id?: string;
  /** The command string from input */
  command: string;
  /** Error classification */
  type: BatchValidationErrorType;
  /** Human-readable error message */
  message: string;
  /** Suggested correction (e.g. closest command name) */
  suggestion?: string;
}

export interface BatchValidationResult {
  /** Whether all commands passed validation */
  valid: boolean;
  /** Validated commands (only present when valid) */
  commands: BatchCommand[];
  /** Validation errors */
  errors: BatchValidationError[];
}

export interface ValidateBatchOptions {
  /**
   * Optional predicate to filter which commands are allowed.
   * Extension point for allowed-commands task (@01KGR05NE).
   * When provided, commands that don't pass the filter are rejected
   * with a "rejected_command" error.
   */
  commandFilter?: (cmd: CommandMeta) => boolean;
}

// ── Parsing ─────────────────────────────────────────────────────────

/**
 * Read raw text from a batch input source.
 */
async function readSource(source: BatchInputSource): Promise<string> {
  switch (source.type) {
    case "inline":
      return source.json;

    case "file":
      try {
        return await fs.readFile(source.path, "utf-8");
      } catch (err) {
        throw new BatchParseError(
          `Failed to read batch file: ${(err as Error).message}`,
        );
      }

    case "stdin": {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text.trim()) {
        throw new BatchParseError("No input received on stdin");
      }
      return text;
    }
  }
}

/**
 * Parse batch input from a source, returning validated commands.
 *
 * @throws {BatchParseError} on invalid JSON, empty array, or schema violations
 */
export async function parseBatchInput(
  source: BatchInputSource,
): Promise<BatchInput> {
  const raw = await readSource(source);

  // Parse JSON — preserve the native error message which includes position
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BatchParseError(
      `Invalid JSON: ${(err as SyntaxError).message}`,
    );
  }

  // Validate against schema
  try {
    return BatchInputSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      const messages = err.errors.map((e) => {
        const path = e.path.length > 0 ? ` at ${e.path.join(".")}` : "";
        return `${e.message}${path}`;
      });
      throw new BatchParseError(
        `Batch validation failed: ${messages.join("; ")}`,
      );
    }
    throw err;
  }
}

// ── Validation ──────────────────────────────────────────────────────

/**
 * Extract the option name from Commander flag syntax.
 * e.g. "-f, --force" → "force", "--spec-ref <value>" → "spec-ref"
 */
function extractOptionName(flags: string): string | null {
  const match = flags.match(/--([a-zA-Z0-9-]+)/);
  return match ? match[1] : null;
}

/**
 * Convert a kebab-case string to camelCase.
 * e.g. "spec-ref" → "specRef"
 */
function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Get all known argument and option names for a command, returning both
 * kebab-case and camelCase variants.
 */
function getKnownArgNames(
  cmd: CommandMeta,
): { names: Set<string>; required: string[] } {
  const names = new Set<string>();
  const required: string[] = [];

  // Positional arguments
  for (const arg of cmd.arguments) {
    names.add(arg.name);
    names.add(kebabToCamel(arg.name));
    if (arg.required) {
      required.push(arg.name);
    }
  }

  // Options
  for (const opt of cmd.options) {
    const optName = extractOptionName(opt.flags);
    if (optName) {
      names.add(optName);
      names.add(kebabToCamel(optName));
      if (opt.mandatory) {
        required.push(optName);
      }
    }
  }

  return { names, required };
}

/**
 * Collect all leaf command paths from a command tree as space-joined strings.
 */
function collectLeafCommandPaths(tree: CommandMeta): string[] {
  const flat = flattenCommandTree(tree);
  return flat
    .filter((cmd) => cmd.subcommands.length === 0)
    .map((cmd) => cmd.fullPath.slice(1).join(" ")) // skip root name
    .filter((path) => path.length > 0);
}

/**
 * Validate batch commands against the CLI's command tree.
 *
 * AC: @batch-command-schema ac-command-field — validates command paths
 * AC: @batch-command-schema ac-args-mapping — validates arg names
 * AC: @batch-command-schema ac-unknown-command — suggests similar commands
 * AC: @batch-command-schema ac-missing-required — identifies missing args
 * AC: @batch-command-schema ac-id-field — preserves id in errors
 */
export function validateBatchCommands(
  commands: BatchCommand[],
  program: CommandMeta,
  options?: ValidateBatchOptions,
): BatchValidationResult {
  const errors: BatchValidationError[] = [];
  const validLeafPaths = collectLeafCommandPaths(program);

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const parts = cmd.command.trim().split(/\s+/);

    // 1. Resolve command path
    const found = findCommand(program, parts);

    if (!found) {
      // Unknown command — suggest closest
      const suggestion = findClosestCommand(cmd.command, validLeafPaths);
      errors.push({
        index: i,
        id: cmd.id,
        command: cmd.command,
        type: "unknown_command",
        message: `Unknown command: "${cmd.command}"`,
        suggestion: suggestion ?? undefined,
      });
      continue;
    }

    // Reject command groups (non-leaf nodes)
    if (found.subcommands.length > 0) {
      const suggestion = findClosestCommand(cmd.command, validLeafPaths);
      errors.push({
        index: i,
        id: cmd.id,
        command: cmd.command,
        type: "unknown_command",
        message: `"${cmd.command}" is a command group, not an executable command`,
        suggestion: suggestion ?? undefined,
      });
      continue;
    }

    // 2. Reject nested batch commands
    // AC: @batch-allowed-commands ac-batch-itself
    if (found.name === "batch") {
      errors.push({
        index: i,
        id: cmd.id,
        command: cmd.command,
        type: "rejected_command",
        message: "Nested batch commands are not allowed",
      });
      continue;
    }

    // 3. Apply command filter if provided
    // AC: @batch-allowed-commands ac-denylist
    if (options?.commandFilter && !options.commandFilter(found)) {
      errors.push({
        index: i,
        id: cmd.id,
        command: cmd.command,
        type: "rejected_command",
        message: `Command "${cmd.command}" is not allowed in batch mode. Only mutating commands can be used in batch.`,
      });
      continue;
    }

    // 4. Check for unknown args
    const { names: knownNames, required: requiredNames } =
      getKnownArgNames(found);

    // Collect all known names as flat array for suggestion matching
    const knownNamesArray = Array.from(knownNames);

    for (const argKey of Object.keys(cmd.args)) {
      // Accept both kebab-case and camelCase
      if (!knownNames.has(argKey)) {
        const suggestion = findClosestCommand(argKey, knownNamesArray);
        errors.push({
          index: i,
          id: cmd.id,
          command: cmd.command,
          type: "unknown_arg",
          message: `Unknown argument "${argKey}" for command "${cmd.command}"`,
          suggestion: suggestion ?? undefined,
        });
      }
    }

    // 5. Check for missing required args
    for (const reqName of requiredNames) {
      const camelName = kebabToCamel(reqName);
      if (
        !(reqName in cmd.args) &&
        !(camelName in cmd.args) &&
        // Skip if provided via positional alias
        !Object.keys(cmd.args).some(
          (k) => kebabToCamel(k) === camelName,
        )
      ) {
        errors.push({
          index: i,
          id: cmd.id,
          command: cmd.command,
          type: "missing_required",
          message: `Missing required argument "${reqName}" for command "${cmd.command}"`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    commands,
    errors,
  };
}

// ── Error Reporting ─────────────────────────────────────────────────

/**
 * Format validation errors for human or JSON output.
 *
 * @param result - Validation result containing errors
 * @param json - If true, return JSON string; otherwise human-readable lines
 * @returns Formatted error string
 */
export function reportBatchValidationErrors(
  result: BatchValidationResult,
  json: boolean = false,
): string {
  if (result.valid) {
    return json ? JSON.stringify({ valid: true, errors: [] }) : "";
  }

  if (json) {
    return JSON.stringify(
      {
        valid: false,
        errors: result.errors,
      },
      null,
      2,
    );
  }

  // Human-readable format
  const lines: string[] = [];
  for (const err of result.errors) {
    const label = err.id ?? `#${err.index}`;
    lines.push(`[${label}] ${err.message}`);
    if (err.suggestion) {
      lines.push(`  Did you mean: ${err.suggestion}?`);
    }
  }
  return lines.join("\n");
}
