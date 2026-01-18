#!/usr/bin/env node

import { Command } from 'commander';
import { setJsonMode } from './output.js';
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
  .hook('preAction', (thisCommand) => {
    // Check for --json flag at top level or on subcommand
    const opts = thisCommand.opts();
    if (opts.json) {
      setJsonMode(true);
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

// Export program for introspection (used by help command)
export { program };

// Parse and execute (only when run directly)
if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse();
}
