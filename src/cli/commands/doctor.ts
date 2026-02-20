/**
 * kspec doctor command - unified health check
 *
 * AC: @doctor-command
 */

import type { Command } from "commander";
import chalk from "chalk";
import { output, isJsonMode } from "../output.js";
import { EXIT_CODES } from "../exit-codes.js";
import {
  getDoctorReport,
  type DoctorReport,
  type CheckResult,
  type Severity,
} from "../../parser/doctor.js";

/**
 * Register the doctor command
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check kspec health (shadow branch, setup, daemon)")
    .option("--json", "Output as JSON")
    .action(async () => {
      try {
        const report = await getDoctorReport(process.cwd());

        if (isJsonMode()) {
          // AC: @doctor-command ac-json-output
          output(report);
        } else {
          formatDoctorReport(report);
        }

        // AC: @doctor-command ac-exit-zero, ac-exit-one
        // AC: @trait-semantic-exit-codes ac-1, ac-2
        // Exit 0 if healthy (no errors, warnings ok), exit 1 if any errors
        if (report.overall.healthy) {
          process.exit(EXIT_CODES.SUCCESS);
        } else {
          process.exit(EXIT_CODES.ERROR);
        }
      } catch (err) {
        if (isJsonMode()) {
          // AC: @trait-json-output ac-3
          output({ error: err instanceof Error ? err.message : String(err) });
        } else {
          console.error(
            chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`)
          );
        }
        process.exit(EXIT_CODES.ERROR);
      }
    });
}

/**
 * Get color for severity level
 */
function getSeverityColor(severity: Severity): (text: string) => string {
  switch (severity) {
    case "ok":
      return chalk.green;
    case "warning":
      return chalk.yellow;
    case "error":
      return chalk.red;
  }
}

/**
 * Get icon for severity level
 */
function getSeverityIcon(severity: Severity): string {
  switch (severity) {
    case "ok":
      return "✓";
    case "warning":
      return "⚠";
    case "error":
      return "✗";
  }
}

/**
 * Format a single check result
 */
function formatCheck(check: CheckResult): void {
  const color = getSeverityColor(check.severity);
  const icon = getSeverityIcon(check.severity);
  console.log(`  ${color(icon)} ${check.message}`);
  if (check.guidance) {
    console.log(chalk.gray(`    ${check.guidance}`));
  }
}

/**
 * Format the doctor report for human-readable output
 */
function formatDoctorReport(report: DoctorReport): void {
  console.log(chalk.bold("\n=== kspec doctor ===\n"));

  // Shadow section
  // AC: @doctor-command ac-shadow-healthy, ac-not-initialized
  console.log(chalk.bold.blue("Shadow Branch"));
  if (report.shadow.checks.length === 0) {
    console.log(chalk.gray("  No checks performed"));
  } else {
    for (const check of report.shadow.checks) {
      formatCheck(check);
    }
  }
  console.log();

  // Setup section (only if shadow is initialized)
  // AC: @doctor-command ac-setup-agent-hooks, ac-setup-skills-agents-md, ac-partial-init
  if (report.shadow.initialized) {
    console.log(chalk.bold.blue("Setup"));
    if (report.setup.checks.length === 0) {
      console.log(chalk.gray("  No checks performed"));
    } else {
      for (const check of report.setup.checks) {
        formatCheck(check);
      }
    }
    console.log();

    // Daemon section
    // AC: @doctor-command ac-daemon-running, ac-daemon-not-running, ac-daemon-unreachable
    console.log(chalk.bold.blue("Daemon"));
    if (report.daemon.checks.length === 0) {
      console.log(chalk.gray("  No checks performed"));
    } else {
      for (const check of report.daemon.checks) {
        formatCheck(check);
      }
    }
    console.log();
  }

  // Overall verdict
  // AC: @doctor-command ac-overall-verdict
  console.log(chalk.bold("─".repeat(40)));
  if (report.overall.healthy) {
    console.log(chalk.green.bold("✓ Healthy"));
    if (report.overall.warningCount > 0) {
      console.log(
        chalk.yellow(`  ${report.overall.warningCount} warning(s)`)
      );
    }
  } else {
    console.log(chalk.red.bold("✗ Issues found"));
    const parts: string[] = [];
    if (report.overall.errorCount > 0) {
      parts.push(chalk.red(`${report.overall.errorCount} error(s)`));
    }
    if (report.overall.warningCount > 0) {
      parts.push(chalk.yellow(`${report.overall.warningCount} warning(s)`));
    }
    console.log(`  ${parts.join(", ")}`);
  }
  console.log();
}
