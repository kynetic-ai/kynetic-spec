/**
 * Ralph command - deprecated.
 *
 * Ralph has been replaced by `kspec agent`. This stub provides a helpful
 * migration error message when users run `kspec ralph`.
 *
 * AC: @ralph-replacement ac-1
 */

import chalk from "chalk";
import type { Command } from "commander";
import { EXIT_CODES } from "../exit-codes.js";

// ─── Command Registration ────────────────────────────────────────────────────

export function registerRalphCommand(program: Command): void {
  const ralph = program
    .command("ralph")
    .description("[deprecated] Use kspec agent instead");

  // end-loop subcommand - deprecated
  // AC: @ralph-replacement ac-1
  ralph
    .command("end-loop")
    .description("[deprecated] Use kspec agent end-loop instead")
    .option("--reason <reason>", "Reason for ending the loop")
    .action(() => {
      showRalphDeprecationError();
    });

  // Main ralph run command (default behavior)
  // AC: @ralph-replacement ac-1
  ralph
    .command("run", { isDefault: true })
    .description("[deprecated] Use kspec agent dispatch start instead")
    .argument("[args...]", "")
    .allowUnknownOption()
    .action(() => {
      showRalphDeprecationError();
    });
}

/**
 * Display a migration error message explaining that ralph has been replaced.
 *
 * AC: @ralph-replacement ac-1 — error message lists equivalent commands for
 * common ralph operations (run, end-loop, dry-run)
 * AC: @trait-error-guidance ac-1 — includes description of what went wrong
 * AC: @trait-error-guidance ac-2 — includes suggested action to resolve
 */
function showRalphDeprecationError(): void {
  const header = chalk.red("✗ kspec ralph has been replaced by kspec agent");
  const msg = [
    header,
    "",
    chalk.bold("kspec ralph has been removed.") +
      " Use " +
      chalk.cyan("kspec agent") +
      " for equivalent functionality.",
    "",
    chalk.bold("Equivalent commands:"),
    `  ${chalk.yellow("kspec ralph run")}      → ${chalk.cyan("kspec agent dispatch start")}`,
    `  ${chalk.yellow("kspec ralph end-loop")} → ${chalk.cyan("kspec agent end-loop")}`,
    "",
    chalk.bold("Getting started:"),
    `  List configured agents:  ${chalk.cyan("kspec agent list")}`,
    `  Run a specific agent:    ${chalk.cyan("kspec agent run <agent-id>")}`,
    `  Start dispatch engine:   ${chalk.cyan("kspec agent dispatch start")}`,
    `  Check dispatch status:   ${chalk.cyan("kspec agent dispatch status")}`,
    "",
    `Run ${chalk.cyan("kspec setup")} to create built-in worker and reviewer agent definitions.`,
    `Run ${chalk.cyan("kspec agent --help")} for full documentation.`,
  ].join("\n");

  process.stderr.write(msg + "\n");
  process.exit(EXIT_CODES.ERROR);
}
