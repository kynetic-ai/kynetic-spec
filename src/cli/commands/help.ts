// AC: @auto-cli-docs ac-2, ac-3, ac-4, ac-5

import chalk from "chalk";
import type { Command } from "commander";
import { EXIT_CODES, EXIT_CODE_METADATA } from "../exit-codes.js";
import { type HelpContent, helpContent } from "../help/content.js";
import { program } from "../index.js";
import {
  type CommandMeta,
  extractCommandTree,
  findCommand,
  flattenCommandTree,
  formatCommandUsage,
} from "../introspection.js";
import { output, setJsonMode, isJsonMode } from "../output.js";

/**
 * Show help for a specific topic (command or concept)
 */
function showTopic(topic: string): void {
  // Extract command tree from program
  const tree = extractCommandTree(program);

  // Try to find as a command first
  const command = findCommand(tree, topic.split(" "));

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
  console.log(`\nAvailable topics: ${getAllTopics(tree).join(", ")}`);
  console.log(`\nRun 'kspec help' to see all topics.`);
  process.exit(EXIT_CODES.ERROR);
}

/**
 * Show help for a specific command
 */
function showCommandHelp(command: CommandMeta): void {
  const content = helpContent[command.name];

  // Title: use content title, or command name
  const title = content?.title || `${command.name} - ${command.description}`;
  console.log(chalk.bold.cyan(title));
  console.log(chalk.gray("─".repeat(40)));

  // Usage
  console.log(chalk.bold("\nUsage:"));
  console.log(`  ${formatCommandUsage(command)}`);

  // Subcommands (auto-generated from Commander)
  if (command.subcommands.length > 0) {
    console.log(chalk.bold("\nCommands:"));
    for (const sub of command.subcommands) {
      const nameCol = sub.name.padEnd(20);
      console.log(`  ${chalk.green(nameCol)} ${sub.description}`);
    }
  }

  // Options (auto-generated from Commander)
  if (command.options.length > 0) {
    console.log(chalk.bold("\nOptions:"));
    for (const opt of command.options) {
      // Format flags column
      const flagsCol = opt.flags.padEnd(30);
      console.log(`  ${chalk.green(flagsCol)} ${opt.description}`);
    }
  }

  // Conceptual content (curated)
  if (content) {
    if (content.concept.trim()) {
      console.log(chalk.bold("\nDetails:"));
      console.log(content.concept.trim());
    }

    if (content.examples && content.examples.length > 0) {
      console.log(chalk.bold("\nExamples:"));
      for (const example of content.examples) {
        console.log(chalk.green(`  ${example}`));
      }
    }

    if (content.seeAlso && content.seeAlso.length > 0) {
      console.log(
        chalk.gray(
          `\nSee also: ${content.seeAlso.map((t) => `kspec help ${t}`).join(", ")}`,
        ),
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
  console.log(chalk.gray("─".repeat(40)));

  console.log(content.concept.trim());

  if (content.examples && content.examples.length > 0) {
    console.log(chalk.bold("\nExamples:"));
    for (const example of content.examples) {
      console.log(chalk.green(`  ${example}`));
    }
  }

  if (content.seeAlso && content.seeAlso.length > 0) {
    console.log(
      chalk.gray(
        `\nSee also: ${content.seeAlso.map((t) => `kspec help ${t}`).join(", ")}`,
      ),
    );
  }
}

/**
 * Get all available topics (commands + concepts)
 */
function getAllTopics(tree: CommandMeta): string[] {
  const commands = flattenCommandTree(tree)
    .filter((cmd) => cmd.name !== "kspec") // Skip root
    .map((cmd) => cmd.name);

  const concepts = Object.keys(helpContent).filter(
    (key) => !commands.includes(key),
  );

  return [...new Set([...commands, ...concepts])];
}

/**
 * Show list of all topics
 */
function showTopicList(): void {
  const tree = extractCommandTree(program);

  console.log(chalk.bold.cyan("kspec help"));
  console.log(chalk.gray("─".repeat(40)));
  console.log("\nExtended help for kspec commands and concepts.\n");

  // Show top-level commands (auto-generated)
  console.log(chalk.bold("Commands:"));
  for (const cmd of tree.subcommands) {
    const nameCol = cmd.name.padEnd(12);
    console.log(`  ${chalk.green(nameCol)} ${cmd.description}`);
  }

  // Show concept topics (curated)
  console.log(chalk.bold("\nConcepts:"));
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

  console.log(chalk.gray("\nUsage: kspec help <topic>"));
  console.log(chalk.gray("       kspec help --all        (full reference)"));
  console.log(chalk.gray("       kspec help --json       (structured output)"));
}

/**
 * Show full reference (all commands with options)
 */
function showFullReference(): void {
  const tree = extractCommandTree(program);
  const allCommands = flattenCommandTree(tree).filter(
    (cmd) => cmd.name !== "kspec",
  );

  console.log(chalk.bold.cyan("kspec - Full Command Reference"));
  console.log(chalk.gray("─".repeat(60)));

  for (const cmd of allCommands) {
    console.log(chalk.bold(`\n${formatCommandUsage(cmd)}`));
    if (cmd.description) {
      console.log(`  ${cmd.description}`);
    }

    if (cmd.options.length > 0) {
      console.log(chalk.gray("  Options:"));
      for (const opt of cmd.options) {
        console.log(
          chalk.gray(`    ${opt.flags.padEnd(30)} ${opt.description}`),
        );
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
 * Show exit codes documentation
 * AC: @cli-schema-introspection ac-2
 */
function showExitCodes(): void {
  console.log(chalk.bold.cyan("kspec - Exit Codes"));
  console.log(chalk.gray("─".repeat(60)));
  console.log("\nExit codes returned by kspec commands:\n");

  for (const exitCode of EXIT_CODE_METADATA) {
    console.log(chalk.bold(`${exitCode.code} - ${exitCode.name}`));
    console.log(`  ${exitCode.description}`);
    console.log(chalk.gray(`  Commands: ${exitCode.commands}`));
    console.log();
  }
}

/**
 * Output exit codes as JSON
 * AC: @cli-schema-introspection ac-3
 */
function showExitCodesJson(): void {
  const exitCodesData = EXIT_CODE_METADATA.map((ec) => ({
    code: ec.code,
    name: ec.name,
    description: ec.description,
    commands: ec.commands,
  }));

  output(exitCodesData);
}

/**
 * Generate JSON Schema for a command
 * AC: @cli-schema-introspection ac-4
 */
function showCommandJsonSchema(topic: string): void {
  const tree = extractCommandTree(program);
  const command = findCommand(tree, topic.split(" "));

  if (!command) {
    console.error(chalk.red(`Unknown command: ${topic}`));
    process.exit(EXIT_CODES.NOT_FOUND);
  }

  // Build JSON Schema object
  const schema: Record<string, unknown> = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    title: `${command.name} command options`,
    description: command.description,
    properties: {},
    required: [],
  };

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  // Add arguments as properties
  for (const arg of command.arguments) {
    const propName = arg.name;
    properties[propName] = {
      type: arg.variadic ? "array" : "string",
      description: arg.description,
    };

    if (arg.variadic) {
      (properties[propName] as Record<string, unknown>).items = {
        type: "string",
      };
    }

    if (arg.required) {
      required.push(propName);
    }
  }

  // Add options as properties
  for (const opt of command.options) {
    // Extract option name from flags (e.g., "-f, --force" -> "force")
    const flagMatch = opt.flags.match(/--([a-zA-Z0-9-]+)/);
    if (!flagMatch) continue;

    const propName = flagMatch[1];

    // Determine type from flags
    let type: string = "boolean";
    if (opt.flags.includes("<")) {
      type = "string";
    } else if (opt.flags.includes("[")) {
      type = "string";
    }

    const propSchema: Record<string, unknown> = {
      type,
      description: opt.description,
    };

    if (opt.defaultValue !== undefined) {
      propSchema.default = opt.defaultValue;
    }

    properties[propName] = propSchema;

    if (opt.required) {
      required.push(propName);
    }
  }

  schema.properties = properties;
  if (required.length > 0) {
    schema.required = required;
  }

  output(schema);
}

/**
 * Register the help command
 */
export function registerHelpCommand(program: Command): void {
  program
    .command("help [topic]")
    .description("Extended help for commands and concepts")
    .option("--all", "Show full command reference")
    .option("--json", "Output as JSON")
    .option("--exit-codes", "Show exit code documentation")
    .option("--json-schema", "Output JSON Schema for command (use with topic)")
    .action((
      topic: string | undefined,
      options: {
        all?: boolean;
        json?: boolean;
        exitCodes?: boolean;
        jsonSchema?: boolean;
      },
    ) => {
      // Handle exit codes flag
      if (options?.exitCodes) {
        // AC: @cli-schema-introspection ac-2, ac-3
        // Note: globalJsonMode is already set by preAction hook if --json flag present
        if (isJsonMode()) {
          showExitCodesJson();
        } else {
          showExitCodes();
        }
        return;
      }

      // Handle JSON schema flag
      if (options?.jsonSchema) {
        if (!topic) {
          console.error(
            chalk.red("Error: --json-schema requires a command topic"),
          );
          process.exit(EXIT_CODES.USAGE_ERROR);
        }
        // AC: @cli-schema-introspection ac-4
        setJsonMode(true);
        showCommandJsonSchema(topic);
        return;
      }

      // AC: @cli-schema-introspection ac-1, ac-5
      // If --json flag is present (globalJsonMode set by preAction hook), show JSON
      if (isJsonMode()) {
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
