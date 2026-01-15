#!/usr/bin/env node

import { Command } from 'commander';
import { setJsonMode } from './output.js';
import { registerTasksCommands, registerTaskCommands, registerSetupCommand } from './commands/index.js';

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

// Parse and execute
program.parse();
