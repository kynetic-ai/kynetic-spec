/**
 * Export Command
 *
 * Exports kspec data to JSON or HTML format for static site hosting.
 * AC: @gh-pages-export ac-1, ac-2, ac-3, ac-4, ac-5, ac-6, ac-7
 */

import * as fs from "node:fs/promises";
import chalk from "chalk";
import type { Command } from "commander";
import {
  calculateExportStats,
  formatBytes,
  generateHtmlExport,
  generateJsonSnapshot,
} from "../../export/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, isJsonMode, output, success, warn } from "../output.js";

/**
 * Register the export command.
 */
export function registerExportCommand(program: Command): void {
  program
    .command("export")
    .description("Export kspec data to JSON or HTML format")
    .requiredOption(
      "--format <format>",
      "Output format (json or html)",
      "json"
    )
    .option("-o, --output <path>", "Output file path (defaults to stdout for JSON)")
    .option(
      "--include-validation",
      "Include validation results in the export",
      false
    )
    .option(
      "--dry-run",
      "Show what would be exported without writing files",
      false
    )
    .action(async (options) => {
      try {
        // Validate format
        // AC: @gh-pages-export ac-1, ac-6
        if (options.format !== "json" && options.format !== "html") {
          error(`Invalid format: ${options.format}. Must be 'json' or 'html'.`);
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // HTML format requires output file
        // AC: @gh-pages-export ac-6
        if (options.format === "html" && !options.output) {
          error("HTML format requires --output <path>");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // Only show progress when not outputting JSON to stdout (keep stdout clean for piping)
        const jsonToStdout = options.format === "json" && !options.output && !options.dryRun;
        if (!jsonToStdout) {
          info("Generating snapshot...");
        }

        // Generate the snapshot
        // AC: @gh-pages-export ac-1, ac-2, ac-3, ac-4, ac-5
        const snapshot = await generateJsonSnapshot(options.includeValidation);

        // AC: @trait-dry-run ac-1, ac-2, ac-3 - Show preview without writing
        if (options.dryRun) {
          const stats = calculateExportStats(snapshot);

          // AC: @trait-dry-run ac-3 - Clear indication this is a preview
          // AC: @gh-pages-export ac-7
          const dryRunOutput = {
            dry_run: true,
            format: options.format,
            output: options.output || "(stdout)",
            stats: {
              tasks: stats.taskCount,
              items: stats.itemCount,
              inbox: stats.inboxCount,
              observations: stats.observationCount,
              agents: stats.agentCount,
              workflows: stats.workflowCount,
              conventions: stats.conventionCount,
              estimated_size: formatBytes(stats.estimatedSizeBytes),
            },
            validation_included: options.includeValidation,
            ...(options.includeValidation && snapshot.validation
              ? {
                  validation_summary: {
                    valid: snapshot.validation.valid,
                    errors: snapshot.validation.errorCount,
                    warnings: snapshot.validation.warningCount,
                  },
                }
              : {}),
          };

          output(dryRunOutput, () => {
            console.log(chalk.cyan("\n=== Dry Run - No files will be written ===\n"));
            console.log(chalk.gray("Format:"), options.format);
            console.log(chalk.gray("Output:"), options.output || "(stdout)");
            console.log();
            console.log(chalk.gray("─".repeat(40)));
            console.log(chalk.bold("Export Statistics:"));
            console.log(chalk.gray("─".repeat(40)));
            console.log(`  Tasks:        ${stats.taskCount}`);
            console.log(`  Items:        ${stats.itemCount}`);
            console.log(`  Inbox:        ${stats.inboxCount}`);
            console.log(`  Observations: ${stats.observationCount}`);
            console.log(`  Agents:       ${stats.agentCount}`);
            console.log(`  Workflows:    ${stats.workflowCount}`);
            console.log(`  Conventions:  ${stats.conventionCount}`);
            console.log();
            console.log(
              `  Estimated size: ${chalk.cyan(formatBytes(stats.estimatedSizeBytes))}`
            );

            if (options.includeValidation && snapshot.validation) {
              console.log();
              console.log(chalk.gray("─".repeat(40)));
              console.log(chalk.bold("Validation:"));
              console.log(chalk.gray("─".repeat(40)));
              const validIcon = snapshot.validation.valid
                ? chalk.green("✓")
                : chalk.red("✗");
              console.log(`  Status: ${validIcon} ${snapshot.validation.valid ? "Valid" : "Invalid"}`);
              console.log(`  Errors: ${snapshot.validation.errorCount}`);
              console.log(`  Warnings: ${snapshot.validation.warningCount}`);
            }
            console.log();
          });

          return;
        }

        // Generate output based on format
        let content: string;

        if (options.format === "json") {
          // AC: @gh-pages-export ac-1
          content = JSON.stringify(snapshot, null, 2);
        } else {
          // AC: @gh-pages-export ac-6
          content = generateHtmlExport(snapshot);
        }

        // Write or output
        if (options.output) {
          await fs.writeFile(options.output, content, "utf-8");
          success(`Exported to ${options.output}`);
        } else {
          // JSON to stdout (no success message to keep output clean)
          console.log(content);
        }
      } catch (err) {
        error("Export failed", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
