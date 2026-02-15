#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import chalk from "chalk";
import { Command } from "commander";

// Read version from package.json at runtime
// AC: @cli-version ac-2 - version automatically reflects package.json without code changes
const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

import { setVerboseModeGetter } from "../parser/shadow.js";
import { initContext } from "../parser/yaml.js";
import { isBatchMode } from "./batch-context.js";
import {
  registerBatchCommand,
  registerCloneForTestingCommand,
  registerDeriveCommand,
  registerExportCommand,
  registerHelpCommand,
  registerInboxCommands,
  registerInitCommand,
  registerItemCommands,
  registerItemTraitCommands,
  registerLinkCommands,
  registerLogCommand,
  registerMergeDriverCommand,
  registerMetaCommands,
  registerModuleCommands,
  registerPlanCommands,
  registerRalphCommand,
  registerRefsCommand,
  registerSearchCommand,
  registerServeCommands,
  registerSessionCommands,
  registerSetupCommand,
  registerShadowCommands,
  registerSkillCommands,
  registerTaskCommands,
  registerTasksCommands,
  registerTraitCommands,
  registerUtilCommands,
  registerValidateCommand,
  registerWorkflowCommand,
} from "./commands/index.js";
import { EXIT_CODES } from "./exit-codes.js";
import {
  getVerboseMode,
  setJsonMode,
  setVerboseMode,
  setYamlMode,
} from "./output.js";
import {
  COMMAND_ALIASES,
  findClosestCommand,
  getAllCommands,
} from "./suggest.js";
import { PidFileManager } from "./pid-utils.js";
import { spawn } from "child_process";
import { join } from "path";
import { existsSync } from "fs";

const program = new Command();

// Initialize verbose mode getter for shadow operations
setVerboseModeGetter(getVerboseMode);

/**
 * Auto-start daemon if configured and not already running
 * AC: @daemon-server (implicit auto-start behavior)
 */
async function maybeAutoStartDaemon(): Promise<void> {
  try {
    // Load context to get daemon config
    const context = await initContext();
    const daemonConfig = context.manifest?.daemon;

    // If daemon section missing entirely, auto_start defaults to true via schema
    // Only skip if explicitly disabled
    if (daemonConfig && daemonConfig.auto_start === false) {
      return;
    }

    // Get port from config (schema defaults to 3456 if daemon section exists)
    const port = daemonConfig?.port ?? 3456;

    // Check if daemon is already running
    const kspecDir = context.specDir;
    const pidManager = new PidFileManager(kspecDir);

    if (pidManager.isDaemonRunning()) {
      // Already running, nothing to do
      return;
    }

    // Get path to daemon entry point - resolve relative to installed package
    const packageRoot = join(import.meta.dirname, '../../');
    const daemonBinary = join(packageRoot, 'dist/daemon/index.js');
    if (!existsSync(daemonBinary)) {
      // Daemon not available, skip silently
      return;
    }

    // Start daemon in background using current runtime
    // Set BUN_ENV=production to prevent Bun dev mode HTML transformation
    const child = spawn(process.execPath, [daemonBinary, '--port', String(port), '--kspec-dir', kspecDir], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      env: { ...process.env, BUN_ENV: 'production' },
    });

    // Detach from parent
    child.unref();

    // Don't wait for daemon to start - let it happen in background
  } catch {
    // Errors during auto-start are non-fatal - continue with command
  }
}

program
  .name("kspec")
  .description("Kynetic Spec - Structured specification format CLI")
  .version(version)
  // AC: @output-format-option ac-format-json, ac-format-yaml, ac-global-scope
  // Note: We use shorthands --json, --yaml, --raw as global options
  // --format is NOT global because it conflicts with command-specific --format options (e.g., export)
  // Commands can still use --format locally; the global behavior uses shorthands only
  .option("--json", "Output in JSON format")
  .option("--yaml", "Output in YAML format")
  .option("--raw", "Output in raw JSON format (same as --json)")
  .option("--debug-shadow", "Enable debug output for shadow operations")
  .hook("preAction", async (thisCommand, actionCommand) => {
    // Skip all hooks during batch dispatch — the batch handler manages modes itself
    if (isBatchMode()) return;

    // The actionCommand is the actual command being executed (e.g., 'export')
    const executingCommandName = actionCommand.name();

    // Check format options at top level
    const opts = thisCommand.opts();

    // AC: @output-format-option ac-conflict-error
    // Detect conflicting format shorthand specifications
    const formatFlags = [];
    if (opts.json) formatFlags.push("--json");
    if (opts.yaml) formatFlags.push("--yaml");
    if (opts.raw) formatFlags.push("--raw");

    if (formatFlags.length > 1) {
      console.error(
        chalk.red(`error: Conflicting format options: ${formatFlags.join(", ")}`)
      );
      console.error(chalk.gray("Use only one of: --json, --yaml, --raw"));
      process.exit(EXIT_CODES.ERROR);
    }

    // AC: @output-format-option ac-json-shorthand, ac-raw-shorthand, ac-yaml-shorthand
    // Set output format based on shorthand flags
    if (opts.json || opts.raw) {
      setJsonMode(true);
    } else if (opts.yaml) {
      setYamlMode(true);
    }

    if (opts.debugShadow) {
      setVerboseMode(true);
    }

    // Auto-start daemon if configured and not running
    // Skip for init, serve, and help commands
    const skipCommands = ['init', 'serve', 'help', 'kspec'];

    if (!skipCommands.includes(executingCommandName)) {
      await maybeAutoStartDaemon();
    }
  });

// Register command groups
registerTasksCommands(program);
registerTaskCommands(program);
registerSetupCommand(program);
registerSessionCommands(program);
registerInitCommand(program);

// Register item commands first, then add trait subcommands to it
registerItemCommands(program);
const itemCmd = program.commands.find((cmd) => cmd.name() === "item");
if (itemCmd) {
  registerItemTraitCommands(itemCmd);
}

registerTraitCommands(program);
registerValidateCommand(program);
registerHelpCommand(program);
registerDeriveCommand(program);
registerInboxCommands(program);
registerShadowCommands(program);
registerLogCommand(program);
registerSearchCommand(program);
registerRefsCommand(program);
registerServeCommands(program);
registerRalphCommand(program);
registerMetaCommands(program);
registerLinkCommands(program);
registerModuleCommands(program);
registerPlanCommands(program);
registerCloneForTestingCommand(program);
registerWorkflowCommand(program);
registerMergeDriverCommand(program);
registerExportCommand(program);
registerUtilCommands(program);
registerBatchCommand(program);
registerSkillCommands(program);

// Handle unknown commands with suggestions
program.on("command:*", (operands) => {
  const unknownCommand = operands[0];

  // Check for direct alias match
  if (COMMAND_ALIASES[unknownCommand]) {
    console.error(chalk.red(`error: unknown command '${unknownCommand}'`));
    console.error(
      chalk.yellow(`Did you mean: kspec ${COMMAND_ALIASES[unknownCommand]}?`),
    );
    process.exit(EXIT_CODES.ERROR);
  }

  // Get all available commands
  const allCommands = getAllCommands(program);

  // Find closest match
  const suggestion = findClosestCommand(unknownCommand, allCommands);

  if (suggestion) {
    console.error(chalk.red(`error: unknown command '${unknownCommand}'`));
    console.error(chalk.yellow(`Did you mean: kspec ${suggestion}?`));
  } else {
    console.error(chalk.red(`error: unknown command '${unknownCommand}'`));
    console.error(chalk.gray(`Run 'kspec help' to see available commands`));
  }

  process.exit(EXIT_CODES.ERROR);
});

// Export program for introspection (used by help command)
export { program };

// Parse and execute (only when run directly)
// Use realpathSync to resolve symlinks (e.g., when run via npm link)
const scriptPath = realpathSync(process.argv[1]);
if (import.meta.url === `file://${scriptPath}`) {
  program.parse();
}
