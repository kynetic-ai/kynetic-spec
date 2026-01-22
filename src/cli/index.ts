#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { realpathSync } from 'fs';
import { createRequire } from 'node:module';

// Read version from package.json at runtime
// AC: @cli-version ac-2 - version automatically reflects package.json without code changes
const require = createRequire(import.meta.url);
const { version } = require('../../package.json');
import { setJsonMode, setVerboseMode, getVerboseMode } from './output.js';
import { setVerboseModeGetter } from '../parser/shadow.js';
import { findClosestCommand, getAllCommands, COMMAND_ALIASES } from './suggest.js';
import {
  registerTasksCommands,
  registerTaskCommands,
  registerSetupCommand,
  registerSessionCommands,
  registerInitCommand,
  registerItemCommands,
  registerValidateCommand,
  registerHelpCommand,
  registerDeriveCommand,
  registerInboxCommands,
  registerShadowCommands,
  registerLogCommand,
  registerSearchCommand,
  registerRalphCommand,
  registerMetaCommands,
  registerLinkCommands,
  registerModuleCommands,
  registerTraitCommands,
  registerItemTraitCommands,
  registerCloneForTestingCommand,
} from './commands/index.js';
import { EXIT_CODES } from './exit-codes.js';

const program = new Command();

// Initialize verbose mode getter for shadow operations
setVerboseModeGetter(getVerboseMode);

program
  .name('kspec')
  .description('Kynetic Spec - Structured specification format CLI')
  .version(version)
  .option('--json', 'Output in JSON format')
  .option('--debug-shadow', 'Enable debug output for shadow operations')
  .hook('preAction', (thisCommand) => {
    // Check for --json and --debug-shadow flags at top level or on subcommand
    const opts = thisCommand.opts();
    if (opts.json) {
      setJsonMode(true);
    }
    if (opts.debugShadow) {
      setVerboseMode(true);
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
const itemCmd = program.commands.find(cmd => cmd.name() === 'item');
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
registerRalphCommand(program);
registerMetaCommands(program);
registerLinkCommands(program);
registerModuleCommands(program);
registerCloneForTestingCommand(program);

// Handle unknown commands with suggestions
program.on('command:*', (operands) => {
  const unknownCommand = operands[0];

  // Check for direct alias match
  if (COMMAND_ALIASES[unknownCommand]) {
    console.error(chalk.red(`error: unknown command '${unknownCommand}'`));
    console.error(chalk.yellow(`Did you mean: kspec ${COMMAND_ALIASES[unknownCommand]}?`));
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
