/**
 * Batch command parsing, validation, execution, and error reporting.
 *
 * Parses JSON batch input from stdin/file/inline, validates command paths
 * against the CLI's introspection tree, executes in atomic or immediate
 * mode, and produces helpful error messages.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import chalk from "chalk";
import type { Command, CommanderError } from "commander";
import { ZodError } from "zod";
import {
  BatchInputSchema,
  type BatchCommand,
  type BatchCommandResult,
  type BatchExecMode,
  type BatchExecResult,
  type BatchInput,
} from "../schema/batch.js";
import { initContext } from "../parser/yaml.js";
import { shadowAutoCommit, shadowPushAsync } from "../parser/shadow.js";
import type { CommandMeta } from "./introspection.js";
import { extractCommandTree, findCommand, flattenCommandTree } from "./introspection.js";
import { findClosestCommand } from "./suggest.js";
import { createBatchCommandFilter } from "./command-annotations.js";
import { setJsonMode, setVerboseMode } from "./output.js";
import {
  BatchExitError,
  OutputCapture,
  installExitInterceptor,
  uninstallExitInterceptor,
  setBatchMode,
  isBatchMode,
} from "./batch-context.js";

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

// ── Execution Engine ─────────────────────────────────────────────────

export interface ExecuteBatchOptions {
  /** Use atomic mode (default true) */
  atomic: boolean;
  /** Continue on error (implies immediate mode) */
  continueOnError: boolean;
  /** Validate-only mode */
  dryRun: boolean;
  /** JSON output */
  json: boolean;
}

/**
 * Build Commander argv from a BatchCommand and its CommandMeta.
 *
 * Translates { command: "inbox add", args: { content: "hello", tag: ["a","b"] } }
 * into ["inbox", "add", "hello", "--tag", "a", "--tag", "b"]
 *
 * Positional args are emitted in Commander definition order (not JSON key order)
 * to ensure correct argument mapping regardless of how the JSON was serialized.
 */
export function buildCommandArgv(cmd: BatchCommand, cmdMeta: CommandMeta): string[] {
  const argv: string[] = [...cmd.command.trim().split(/\s+/)];

  // Build sets for classification
  const positionalDefs = cmdMeta.arguments; // ordered by Commander definition
  const positionalNameSet = new Set<string>();
  for (const arg of positionalDefs) {
    positionalNameSet.add(arg.name);
    positionalNameSet.add(kebabToCamel(arg.name));
  }

  const optionMap = new Map<string, { flags: string; variadic: boolean }>();
  for (const opt of cmdMeta.options) {
    const name = extractOptionName(opt.flags);
    if (name) {
      optionMap.set(name, { flags: opt.flags, variadic: opt.variadic });
      optionMap.set(kebabToCamel(name), { flags: opt.flags, variadic: opt.variadic });
    }
  }

  // Phase 1: Emit positional args in Commander definition order
  for (const argDef of positionalDefs) {
    const name = argDef.name;
    const camelName = kebabToCamel(name);
    const value = cmd.args[name] ?? cmd.args[camelName];
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      for (const v of value) argv.push(String(v));
    } else {
      argv.push(String(value));
    }
  }

  // Phase 2: Emit options from remaining keys
  for (const [key, value] of Object.entries(cmd.args)) {
    const camelKey = kebabToCamel(key);
    // Skip positional args (already emitted)
    if (positionalNameSet.has(key) || positionalNameSet.has(camelKey)) {
      continue;
    }

    // Convert camelCase key back to kebab-case for CLI
    const kebabKey = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    const flagName = `--${kebabKey}`;

    if (typeof value === "boolean") {
      if (value) {
        argv.push(flagName);
      }
      // false booleans: omit (Commander treats absence as false)
    } else if (Array.isArray(value)) {
      // Variadic or repeated options
      for (const v of value) {
        argv.push(flagName, String(v));
      }
    } else if (value !== null && value !== undefined) {
      argv.push(flagName, String(value));
    }
  }

  return argv;
}

/**
 * Reset Commander command tree state between dispatches.
 * Commander retains _optionValues between parseAsync calls.
 */
export function resetCommandTree(cmd: Command): void {
  (cmd as any)._optionValues = {};
  (cmd as any)._optionValueSources = {};
  (cmd as any).processedArgs = [];
  for (const sub of cmd.commands) {
    resetCommandTree(sub);
  }
}

/**
 * Check if a CommandMeta supports the --force option.
 */
function commandHasForce(cmdMeta: CommandMeta): boolean {
  return cmdMeta.options.some((opt) => {
    const name = extractOptionName(opt.flags);
    return name === "force";
  });
}

/**
 * Execute a batch of commands.
 *
 * AC: @batch-exec ac-default-atomic — atomic mode by default
 * AC: @batch-exec ac-no-atomic-flag — immediate mode with --no-atomic
 * AC: @batch-exec ac-stop-on-error — stop on first failure (default)
 * AC: @batch-exec ac-continue — continue on error with --continue
 * AC: @batch-exec ac-dry-run — validate without executing
 * AC: @batch-exec ac-prevalidate — validation before any execution
 * AC: @batch-exec ac-confirmation-suppressed — auto-append --force
 */
export async function executeBatch(
  commands: BatchCommand[],
  program: Command,
  options: ExecuteBatchOptions,
): Promise<BatchExecResult> {
  const mode: BatchExecMode = options.atomic ? "atomic" : "immediate";

  // Build command tree for validation
  const tree = extractCommandTree(program);
  const commandFilter = createBatchCommandFilter();

  // AC: ac-prevalidate — validate all commands before executing any
  const validation = validateBatchCommands(commands, tree, { commandFilter });
  if (!validation.valid) {
    return {
      success: false,
      mode,
      summary: {
        total: commands.length,
        succeeded: 0,
        failed: validation.errors.length,
      },
      results: validation.errors.map((err) => ({
        index: err.index,
        id: err.id,
        command: err.command,
        success: false,
        error: err.message,
      })),
    };
  }

  // AC: ac-dry-run — validate without executing
  if (options.dryRun) {
    return {
      success: true,
      mode,
      summary: { total: commands.length, succeeded: commands.length, failed: 0 },
      results: commands.map((cmd, i) => ({
        index: i,
        id: cmd.id,
        command: cmd.command,
        success: true,
        output: "dry-run: would execute",
      })),
    };
  }

  if (options.atomic) {
    return executeAtomic(commands, program, tree, options);
  } else {
    return executeImmediate(commands, program, tree, options);
  }
}

/**
 * Atomic execution: copy specDir to temp, run all, copy back on success.
 *
 * AC: @batch-exec ac-default-atomic
 * AC: @batch-exec ac-atomic-rollback
 * AC: @batch-exec ac-atomic-isolation
 * AC: @batch-exec ac-single-commit
 */
async function executeAtomic(
  commands: BatchCommand[],
  program: Command,
  tree: CommandMeta,
  options: ExecuteBatchOptions,
): Promise<BatchExecResult> {
  // Get the real context for copy-back
  const ctx = await initContext();
  const realSpecDir = ctx.specDir;

  // Create temp copy using mkdtemp for safe, collision-free naming
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-batch-"));
  await fs.cp(realSpecDir, tempDir, { recursive: true });

  // Remove .git from temp copy to prevent worktree pointer leaks
  await fs.rm(path.join(tempDir, ".git"), { force: true, recursive: true });

  // Set up atomic context
  const savedChalkLevel = chalk.level;
  const savedSpecDir = process.env.KSPEC_SPEC_DIR;
  process.env.KSPEC_SPEC_DIR = tempDir;
  setBatchMode(true);
  chalk.level = 0;

  const results: BatchCommandResult[] = [];
  let allSucceeded = true;
  let copyBackFailed = false;

  try {
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      const result = await dispatchCommand(cmd, i, program, tree);
      results.push(result);

      if (!result.success) {
        allSucceeded = false;
        // Atomic mode: stop on first failure, discard everything
        // Fill remaining as not-executed
        for (let j = i + 1; j < commands.length; j++) {
          results.push({
            index: j,
            id: commands[j].id,
            command: commands[j].command,
            success: false,
            error: "Not executed (prior command failed in atomic mode)",
          });
        }
        break;
      }
    }

    // Copy back on success
    if (allSucceeded) {
      try {
        // Clear real specDir contents (except .git and .gitattributes) before copy-back
        const entries = await fs.readdir(realSpecDir);
        for (const entry of entries) {
          if (entry === ".git" || entry === ".gitattributes") continue;
          await fs.rm(path.join(realSpecDir, entry), { recursive: true, force: true });
        }
        // Copy temp contents back
        const tempEntries = await fs.readdir(tempDir);
        for (const entry of tempEntries) {
          await fs.cp(
            path.join(tempDir, entry),
            path.join(realSpecDir, entry),
            { recursive: true },
          );
        }

        // Single shadow commit for all changes
        if (ctx.shadow?.enabled) {
          const successCount = results.filter((r) => r.success).length;
          await shadowAutoCommit(
            ctx.shadow.worktreeDir,
            `batch: ${successCount} command${successCount !== 1 ? "s" : ""}`,
          );
          shadowPushAsync(ctx.shadow.worktreeDir);
        }
      } catch (copyErr) {
        // Copy-back failed — preserve tempDir for manual recovery
        copyBackFailed = true;
        allSucceeded = false;
        console.error(
          `Batch copy-back failed: ${copyErr instanceof Error ? copyErr.message : copyErr}`,
        );
        console.error(`Temp dir preserved for recovery: ${tempDir}`);
      }
    }
  } finally {
    // Clean up
    setBatchMode(false);
    chalk.level = savedChalkLevel;
    if (savedSpecDir !== undefined) {
      process.env.KSPEC_SPEC_DIR = savedSpecDir;
    } else {
      delete process.env.KSPEC_SPEC_DIR;
    }
    // Only remove temp dir if copy-back succeeded (or commands failed)
    if (!copyBackFailed) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return {
    success: allSucceeded,
    mode: "atomic",
    summary: { total: commands.length, succeeded, failed },
    results,
  };
}

/**
 * Immediate execution: execute against real state, per-command commits.
 *
 * AC: @batch-exec ac-no-atomic-flag
 * AC: @batch-exec ac-immediate-per-commit
 * AC: @batch-exec ac-immediate-no-rollback
 */
async function executeImmediate(
  commands: BatchCommand[],
  program: Command,
  tree: CommandMeta,
  options: ExecuteBatchOptions,
): Promise<BatchExecResult> {
  const savedChalkLevel = chalk.level;
  chalk.level = 0;

  const results: BatchCommandResult[] = [];

  try {
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      const result = await dispatchCommand(cmd, i, program, tree);
      results.push(result);

      if (!result.success && !options.continueOnError) {
        // Stop on first failure, remaining not executed
        for (let j = i + 1; j < commands.length; j++) {
          results.push({
            index: j,
            id: commands[j].id,
            command: commands[j].command,
            success: false,
            error: "Not executed (prior command failed)",
          });
        }
        break;
      }
    }
  } finally {
    chalk.level = savedChalkLevel;
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return {
    success: failed === 0,
    mode: "immediate",
    summary: { total: commands.length, succeeded, failed },
    results,
  };
}

/**
 * Dispatch a single command through Commander's parseAsync.
 */
async function dispatchCommand(
  cmd: BatchCommand,
  index: number,
  program: Command,
  tree: CommandMeta,
): Promise<BatchCommandResult> {
  const parts = cmd.command.trim().split(/\s+/);
  const cmdMeta = findCommand(tree, parts);
  if (!cmdMeta) {
    return {
      index,
      id: cmd.id,
      command: cmd.command,
      success: false,
      error: `Command not found: ${cmd.command}`,
    };
  }

  // Build argv, auto-appending --force if supported
  // AC: ac-confirmation-suppressed
  const enrichedCmd = { ...cmd, args: { ...cmd.args } };
  if (commandHasForce(cmdMeta) && !("force" in enrichedCmd.args)) {
    enrichedCmd.args.force = true;
  }
  const argv = buildCommandArgv(enrichedCmd, cmdMeta);

  // Reset Commander state
  resetCommandTree(program);
  setJsonMode(false);
  setVerboseMode(false);

  const capture = new OutputCapture();
  capture.start();
  installExitInterceptor();

  let caughtError: unknown = undefined;
  let succeeded = false;

  try {
    await program.parseAsync(argv, { from: "user" });
    succeeded = true;
  } catch (err) {
    caughtError = err;
  } finally {
    capture.stop();
    uninstallExitInterceptor();
  }

  if (succeeded) {
    const output = capture.getOutput();
    // Try to parse output as JSON for structured results
    let parsedOutput: unknown = output;
    try {
      parsedOutput = JSON.parse(output);
    } catch {
      // Not JSON, keep as string
    }

    return {
      index,
      id: cmd.id,
      command: cmd.command,
      success: true,
      output: parsedOutput,
    };
  }

  // Handle errors
  const err = caughtError;

  if (err instanceof BatchExitError) {
    // Filter out BatchExitError noise from captured output (handlers may
    // catch and re-log the error before calling process.exit again)
    const capturedOutput = capture
      .getOutput()
      .split("\n")
      .filter((line) => !line.includes("BatchExitError"))
      .join("\n")
      .trim();

    if (err.code === 0) {
      return {
        index,
        id: cmd.id,
        command: cmd.command,
        success: true,
        output: capturedOutput,
      };
    }
    return {
      index,
      id: cmd.id,
      command: cmd.command,
      success: false,
      error: capturedOutput || `Command exited with code ${err.code}`,
    };
  }

  // Commander errors (e.g., missing required arg at runtime)
  const isCommanderError =
    err && typeof err === "object" && "code" in err && "exitCode" in err;
  if (isCommanderError) {
    const cmdErr = err as unknown as { message: string; exitCode: number };
    return {
      index,
      id: cmd.id,
      command: cmd.command,
      success: false,
      error: cmdErr.message || capture.getOutput(),
    };
  }

  // Generic errors
  return {
    index,
    id: cmd.id,
    command: cmd.command,
    success: false,
    error: err instanceof Error ? err.message : String(err),
  };
}
