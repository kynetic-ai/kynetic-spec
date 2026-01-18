#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
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
} from './commands/index.js';

const program = new Command();

program
  .name('kspec')
  .description('Kynetic Spec - Structured specification format CLI')
  .version('0.1.0')
  .option('--json', 'Output in JSON format')
  .option('-v, --verbose', 'Enable debug output for shadow operations')
  .hook('preAction', (thisCommand) => {
    // Check for --json and --verbose flags at top level or on subcommand
    const opts = thisCommand.opts();
    if (opts.json) {
      setJsonMode(true);
    }
    if (opts.verbose) {
      setVerboseMode(true);
    }
  });

// Register command groups
registerTasksCommands(program);
registerTaskCommands(program);
registerSetupCommand(program);
registerSessionCommands(program);
registerInitCommand(program);
registerItemCommands(program);
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

// Handle unknown commands with suggestions
program.on('command:*', (operands) => {
  const unknownCommand = operands[0];

  // Check for direct alias match
  if (COMMAND_ALIASES[unknownCommand]) {
    console.error(chalk.red(`error: unknown command '${unknownCommand}'`));
    console.error(chalk.yellow(`Did you mean: kspec ${COMMAND_ALIASES[unknownCommand]}?`));
    process.exit(1);
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

  process.exit(1);
});

// Export program for introspection (used by help command)
export { program };

// Parse and execute (only when run directly)
if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse();
}
