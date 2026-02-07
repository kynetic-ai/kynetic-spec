/**
 * kspec batch — execute multiple CLI commands from a JSON payload.
 *
 * Supports atomic mode (default: temp copy, rollback on failure) and
 * immediate mode (per-command commits, no rollback).
 */

import chalk from "chalk";
import type { Command } from "commander";
import {
  parseBatchInput,
  BatchParseError,
  executeBatch,
} from "../batch-exec.js";
import { createBatchCommandFilter } from "../command-annotations.js";
import { extractCommandTree, flattenCommandTree, type CommandMeta } from "../introspection.js";
import { isJsonMode, output } from "../output.js";
import { EXIT_CODES } from "../exit-codes.js";

/**
 * Format a command signature for display.
 * e.g., "inbox add <text> [--tag <tag...>]"
 */
function formatCommandSignature(cmd: CommandMeta): string {
  const parts = [cmd.fullPath.slice(1).join(" ")]; // Skip root 'kspec'

  // Add positional arguments
  for (const arg of cmd.arguments) {
    if (arg.required) {
      parts.push(`<${arg.name}${arg.variadic ? "..." : ""}>`);
    } else {
      parts.push(`[${arg.name}${arg.variadic ? "..." : ""}]`);
    }
  }

  // Add options (excluding common ones like --json, --verbose)
  const skipOptions = new Set(["json", "verbose", "help"]);
  const significantOptions = cmd.options.filter((opt) => {
    const match = opt.flags.match(/--([a-zA-Z0-9-]+)/);
    return match && !skipOptions.has(match[1]);
  });

  if (significantOptions.length > 0) {
    parts.push("[options]");
  }

  return parts.join(" ");
}

/**
 * Build structured command info for JSON output.
 */
interface BatchCommandInfo {
  command: string;
  signature: string;
  description: string;
  mutating: boolean;
  arguments: Array<{
    name: string;
    description: string;
    required: boolean;
    variadic: boolean;
  }>;
  options: Array<{
    flags: string;
    description: string;
    required: boolean;
  }>;
}

function buildCommandInfo(cmd: CommandMeta): BatchCommandInfo {
  return {
    command: cmd.fullPath.slice(1).join(" "), // Skip root 'kspec'
    signature: formatCommandSignature(cmd),
    description: cmd.description,
    mutating: cmd.mutating,
    arguments: cmd.arguments.map((arg) => ({
      name: arg.name,
      description: arg.description,
      required: arg.required,
      variadic: arg.variadic,
    })),
    options: cmd.options.map((opt) => ({
      flags: opt.flags,
      description: opt.description,
      required: opt.mandatory,
    })),
  };
}

/**
 * Register the `kspec batch` command group.
 *
 * AC: @batch-exec ac-stdin — stdin input
 * AC: @batch-exec ac-file — file input
 * AC: @batch-exec ac-inline — inline JSON input
 * AC: @batch-exec ac-default-atomic — atomic mode by default
 * AC: @batch-exec ac-no-atomic-flag — immediate mode
 * AC: @batch-exec ac-continue-implies-immediate — --continue implies --no-atomic
 * AC: @batch-exec ac-json-mode-field — JSON output includes mode field
 */
export function registerBatchCommand(program: Command): void {
  const batchCmd = program
    .command("batch")
    .description("Execute multiple commands from a JSON payload")
    .option("--file <path>", "Read commands from a JSON file")
    .option("--commands <json>", "Inline JSON command array")
    .option("--no-atomic", "Immediate mode: per-command commits, no rollback")
    .option("--continue", "Continue on error (implies --no-atomic)")
    .option("--dry-run", "Validate without executing")
    .addHelpText(
      "after",
      `
Examples:
  $ echo '[{"command":"inbox add","args":{"content":"test"}}]' | kspec batch
  $ kspec batch --file commands.json
  $ kspec batch --commands '[{"command":"inbox add","args":{"content":"test"}}]'
  $ kspec batch --no-atomic --commands '[...]'
  $ kspec batch --continue --commands '[...]'
  $ kspec batch --dry-run --commands '[...]'
  $ kspec batch commands           # list allowed commands`,
    )
    .action(async (options: {
      file?: string;
      commands?: string;
      atomic: boolean;
      continue?: boolean;
      dryRun?: boolean;
    }) => {
      const json = isJsonMode();

      // --continue implies --no-atomic
      // AC: ac-continue-implies-immediate
      let atomic = options.atomic;
      if (options.continue && atomic) {
        if (!json) {
          console.error(
            "Notice: --continue implies immediate mode (--no-atomic)",
          );
        }
        atomic = false;
      }

      // Determine input source
      let source: { type: "stdin" } | { type: "file"; path: string } | { type: "inline"; json: string };
      if (options.file) {
        source = { type: "file", path: options.file };
      } else if (options.commands) {
        source = { type: "inline", json: options.commands };
      } else {
        source = { type: "stdin" };
      }

      // Parse input
      let commands;
      try {
        commands = await parseBatchInput(source);
      } catch (err) {
        if (err instanceof BatchParseError) {
          if (json) {
            console.log(JSON.stringify({
              success: false,
              error: err.message,
            }, null, 2));
          } else {
            console.error(`Error: ${err.message}`);
          }
          process.exit(EXIT_CODES.ERROR);
        }
        throw err;
      }

      // Execute
      const result = await executeBatch(commands, program, {
        atomic,
        continueOnError: options.continue ?? false,
        dryRun: options.dryRun ?? false,
        json,
      });

      // Output
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        // Human-readable output
        const modeLabel = result.mode === "atomic" ? "atomic" : "immediate";
        if (result.success) {
          console.log(
            `Batch complete (${modeLabel}): ${result.summary.succeeded}/${result.summary.total} succeeded`,
          );
        } else {
          console.error(
            `Batch failed (${modeLabel}): ${result.summary.succeeded}/${result.summary.total} succeeded, ${result.summary.failed} failed`,
          );
        }

        // Show per-command results
        for (const r of result.results) {
          const label = r.id ?? `#${r.index}`;
          if (r.success) {
            console.log(`  [${label}] ${r.command}: OK`);
          } else {
            console.error(`  [${label}] ${r.command}: FAILED — ${r.error}`);
          }
        }
      }

      if (!result.success) {
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // Register the `batch commands` subcommand
  batchCmd
    .command("commands")
    .description("List commands allowed in batch mode")
    .action(() => {
      const json = isJsonMode();
      const tree = extractCommandTree(program);
      const allCommands = flattenCommandTree(tree);
      const commandFilter = createBatchCommandFilter();

      // Filter to leaf commands (no subcommands) that pass the batch filter
      const allowedCommands = allCommands.filter((cmd) => {
        // Must be a leaf command (no subcommands)
        if (cmd.subcommands.length > 0) return false;
        // Must pass the batch filter (mutating only)
        if (!commandFilter(cmd)) return false;
        // Exclude batch itself
        if (cmd.name === "batch" || cmd.fullPath.includes("batch")) return false;
        return true;
      });

      if (json) {
        const commandInfos = allowedCommands.map(buildCommandInfo);
        output({ commands: commandInfos, total: commandInfos.length });
      } else {
        console.log(chalk.bold.cyan("Batch-Allowed Commands"));
        console.log(chalk.gray("─".repeat(60)));
        console.log(chalk.gray("Only mutating commands can be used in batch mode.\n"));

        for (const cmd of allowedCommands) {
          const signature = formatCommandSignature(cmd);
          console.log(chalk.green(signature));
          if (cmd.description) {
            console.log(chalk.gray(`  ${cmd.description}`));
          }
        }

        console.log(chalk.gray(`\n${allowedCommands.length} command(s) available`));
      }
    });
}
