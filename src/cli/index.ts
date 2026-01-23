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
import {
  registerCloneForTestingCommand,
  registerDeriveCommand,
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
  registerRalphCommand,
  registerSearchCommand,
  registerServeCommands,
  registerSessionCommands,
  registerSetupCommand,
  registerShadowCommands,
  registerTaskCommands,
  registerTasksCommands,
  registerTraitCommands,
  registerValidateCommand,
  registerWorkflowCommand,
} from "./commands/index.js";
import { EXIT_CODES } from "./exit-codes.js";
import { getVerboseMode, setJsonMode, setVerboseMode } from "./output.js";
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
    const child = spawn(process.execPath, [daemonBinary, '--port', String(port), '--kspec-dir', kspecDir], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
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
  .option("--json", "Output in JSON format")
  .option("--debug-shadow", "Enable debug output for shadow operations")
  .hook("preAction", async (thisCommand) => {
    // Check for --json and --debug-shadow flags at top level or on subcommand
    const opts = thisCommand.opts();
    if (opts.json) {
      setJsonMode(true);
    }
    if (opts.debugShadow) {
      setVerboseMode(true);
    }

    // Auto-start daemon if configured and not running
    // Skip for init, serve, and help commands
    const commandName = thisCommand.name();
    const skipCommands = ['init', 'serve', 'help', 'kspec'];

    if (!skipCommands.includes(commandName)) {
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
registerServeCommands(program);
registerRalphCommand(program);
registerMetaCommands(program);
registerLinkCommands(program);
registerModuleCommands(program);
registerCloneForTestingCommand(program);
registerWorkflowCommand(program);
registerMergeDriverCommand(program);

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
