/**
 * kspec batch — execute multiple CLI commands from a JSON payload.
 *
 * Supports atomic mode (default: temp copy, rollback on failure) and
 * immediate mode (per-command commits, no rollback).
 */

import type { Command } from "commander";
import {
  parseBatchInput,
  BatchParseError,
  executeBatch,
  reportBatchValidationErrors,
} from "../batch-exec.js";
import { isJsonMode } from "../output.js";
import { EXIT_CODES } from "../exit-codes.js";

/**
 * Register the `kspec batch` command.
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
  program
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
  $ kspec batch --dry-run --commands '[...]'`,
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
}
