// AC: @auto-cli-docs ac-2, ac-3, ac-4, ac-5
import { Command } from 'commander';
import chalk from 'chalk';
import { program } from '../index.js';
import {
  extractCommandTree,
  findCommand,
  flattenCommandTree,
  formatCommandUsage,
  type CommandMeta,
} from '../introspection.js';
import { helpContent, type HelpContent } from '../help/content.js';
import { output } from '../output.js';

/**
 * Show help for a specific topic (command or concept)
 */
function showTopic(topic: string): void {
  // Extract command tree from program
  const tree = extractCommandTree(program);

  // Try to find as a command first
  const command = findCommand(tree, topic.split(' '));

  if (command) {
    showCommandHelp(command);
    return;
  }

  // Try to find as a concept
  const content = helpContent[topic];
  if (content) {
    showConceptHelp(topic, content);
    return;
  }

  // Not found
  console.log(chalk.red(`Unknown topic: ${topic}`));
  console.log(`\nAvailable topics: ${getAllTopics(tree).join(', ')}`);
  console.log(`\nRun 'kspec help' to see all topics.`);
  process.exit(1);
}

/**
 * Show help for a specific command
 */
function showCommandHelp(command: CommandMeta): void {
  const content = helpContent[command.name];

  // Title: use content title, or command name
  const title = content?.title || `${command.name} - ${command.description}`;
  console.log(chalk.bold.cyan(title));
  console.log(chalk.gray('─'.repeat(40)));

  // Usage
  console.log(chalk.bold('\nUsage:'));
  console.log(`  ${formatCommandUsage(command)}`);

  // Subcommands (auto-generated from Commander)
  if (command.subcommands.length > 0) {
    console.log(chalk.bold('\nCommands:'));
    for (const sub of command.subcommands) {
      const nameCol = sub.name.padEnd(20);
      console.log(`  ${chalk.green(nameCol)} ${sub.description}`);
    }
  }

  // Options (auto-generated from Commander)
  if (command.options.length > 0) {
    console.log(chalk.bold('\nOptions:'));
    for (const opt of command.options) {
      // Format flags column
      const flagsCol = opt.flags.padEnd(30);
      console.log(`  ${chalk.green(flagsCol)} ${opt.description}`);
    }
  }

  // Conceptual content (curated)
  if (content) {
    if (content.concept.trim()) {
      console.log(chalk.bold('\nDetails:'));
      console.log(content.concept.trim());
    }

    if (content.examples && content.examples.length > 0) {
      console.log(chalk.bold('\nExamples:'));
      for (const example of content.examples) {
        console.log(chalk.green(`  ${example}`));
      }
    }

    if (content.seeAlso && content.seeAlso.length > 0) {
      console.log(
        chalk.gray(`\nSee also: ${content.seeAlso.map((t) => `kspec help ${t}`).join(', ')}`)
      );
    }
  }
}

/**
 * Show help for a concept topic
 */
function showConceptHelp(topic: string, content: HelpContent): void {
  const title = content.title || topic;
  console.log(chalk.bold.cyan(title));
  console.log(chalk.gray('─'.repeat(40)));

  console.log(content.concept.trim());

  if (content.examples && content.examples.length > 0) {
    console.log(chalk.bold('\nExamples:'));
    for (const example of content.examples) {
      console.log(chalk.green(`  ${example}`));
    }
  }

  if (content.seeAlso && content.seeAlso.length > 0) {
    console.log(
      chalk.gray(`\nSee also: ${content.seeAlso.map((t) => `kspec help ${t}`).join(', ')}`)
    );
  }
}

/**
 * Get all available topics (commands + concepts)
 */
function getAllTopics(tree: CommandMeta): string[] {
  const commands = flattenCommandTree(tree)
    .filter((cmd) => cmd.name !== 'kspec') // Skip root
    .map((cmd) => cmd.name);

  const concepts = Object.keys(helpContent).filter((key) => !commands.includes(key));

  return [...new Set([...commands, ...concepts])];
}

/**
 * Show list of all topics
 */
function showTopicList(): void {
  const tree = extractCommandTree(program);

  console.log(chalk.bold.cyan('kspec help'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log('\nExtended help for kspec commands and concepts.\n');

  // Show top-level commands (auto-generated)
  console.log(chalk.bold('Commands:'));
  for (const cmd of tree.subcommands) {
    const nameCol = cmd.name.padEnd(12);
    console.log(`  ${chalk.green(nameCol)} ${cmd.description}`);
  }

  // Show concept topics (curated)
  console.log(chalk.bold('\nConcepts:'));
  const conceptTopics = Object.keys(helpContent).filter((key) => {
    // Concepts are topics that don't match command names
    return !tree.subcommands.some((cmd) => cmd.name === key);
  });

  for (const topic of conceptTopics) {
    const content = helpContent[topic];
    const title = content.title || topic;
    const nameCol = topic.padEnd(12);
    console.log(`  ${chalk.green(nameCol)} ${title}`);
  }

  console.log(chalk.gray('\nUsage: kspec help <topic>'));
  console.log(chalk.gray('       kspec help --all        (full reference)'));
  console.log(chalk.gray('       kspec help --json       (structured output)'));
}

/**
 * Show full reference (all commands with options)
 */
function showFullReference(): void {
  const tree = extractCommandTree(program);
  const allCommands = flattenCommandTree(tree).filter((cmd) => cmd.name !== 'kspec');

  console.log(chalk.bold.cyan('kspec - Full Command Reference'));
  console.log(chalk.gray('─'.repeat(60)));

  for (const cmd of allCommands) {
    console.log(chalk.bold(`\n${formatCommandUsage(cmd)}`));
    if (cmd.description) {
      console.log(`  ${cmd.description}`);
    }

    if (cmd.options.length > 0) {
      console.log(chalk.gray('  Options:'));
      for (const opt of cmd.options) {
        console.log(chalk.gray(`    ${opt.flags.padEnd(30)} ${opt.description}`));
      }
    }
  }
}

/**
 * Output help as JSON
 */
function showJson(): void {
  const tree = extractCommandTree(program);

  // Include both command tree and curated content
  const data = {
    commands: tree,
    content: helpContent,
  };

  output(data);
}

/**
 * Register the help command
 */
export function registerHelpCommand(program: Command): void {
  program
    .command('help [topic]')
    .description('Extended help for commands and concepts')
    .option('--all', 'Show full command reference')
    .option('--json', 'Output as JSON')
    .action((topic?: string, options?: { all?: boolean; json?: boolean }) => {
      // Handle flags
      if (options?.json) {
        showJson();
        return;
      }

      if (options?.all) {
        showFullReference();
        return;
      }

      // Show topic or list
      if (topic) {
        showTopic(topic);
      } else {
        showTopicList();
      }
    });
}
