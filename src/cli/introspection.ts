// AC: @auto-cli-docs ac-1
/**
 * Commander.js introspection - extracts command tree from program definition
 *
 * This module provides the foundation for auto-generated CLI documentation
 * by extracting command metadata directly from Commander.js definitions.
 */

import type { Command, Option as CommanderOption } from "commander";

/**
 * Metadata for a single command option
 */
export interface OptionMeta {
  /** Option flags (e.g., "-n, --name <value>") */
  flags: string;
  /** Option description */
  description: string;
  /** Whether option is required */
  required: boolean;
  /** Default value if any */
  defaultValue?: unknown;
  /** Whether option can be repeated */
  variadic: boolean;
}

/**
 * Metadata for a command argument
 */
export interface ArgumentMeta {
  /** Argument name */
  name: string;
  /** Argument description */
  description: string;
  /** Whether argument is required */
  required: boolean;
  /** Whether argument can be repeated */
  variadic: boolean;
}

/**
 * Complete metadata for a command
 */
export interface CommandMeta {
  /** Command name */
  name: string;
  /** Full command path from root (e.g., ["task", "add"]) */
  fullPath: string[];
  /** Command description */
  description: string;
  /** Command aliases */
  aliases: string[];
  /** Command arguments */
  arguments: ArgumentMeta[];
  /** Command options */
  options: OptionMeta[];
  /** Subcommands */
  subcommands: CommandMeta[];
  /** Whether this command is hidden */
  hidden: boolean;
}

/**
 * Extract metadata for a single option
 */
function extractOptionMeta(option: CommanderOption): OptionMeta {
  return {
    flags: option.flags,
    description: option.description || "",
    required: option.required,
    defaultValue: option.defaultValue,
    variadic: option.variadic,
  };
}

/**
 * Extract metadata for command arguments
 */
function extractArgumentsMeta(command: Command): ArgumentMeta[] {
  // Commander stores processed arguments with metadata
  const args = command.registeredArguments || [];
  return args.map((arg) => ({
    name: arg.name(),
    description: arg.description || "",
    required: arg.required,
    variadic: arg.variadic,
  }));
}

/**
 * Extract complete command tree from a Commander program
 *
 * @param command - Commander command to introspect
 * @param parentPath - Parent command path (for recursion)
 * @returns Complete command metadata tree
 */
export function extractCommandTree(
  command: Command,
  parentPath: string[] = [],
): CommandMeta {
  // Get command name - use first name if command has multiple
  const commandName = command.name();
  const fullPath = [...parentPath, commandName];

  // Extract options (filter out help option if needed)
  const options = command.options.map(extractOptionMeta);

  // Extract arguments
  const args = extractArgumentsMeta(command);

  // Recursively extract subcommands
  // Cast to any to access _hidden private property
  const isHidden = (cmd: Command): boolean => (cmd as any)._hidden || false;

  const subcommands = command.commands
    .filter((cmd) => !isHidden(cmd)) // Filter hidden commands
    .map((cmd) => extractCommandTree(cmd, fullPath));

  return {
    name: commandName,
    fullPath,
    description: command.description() || "",
    aliases: command.aliases(),
    arguments: args,
    options,
    subcommands,
    hidden: isHidden(command),
  };
}

/**
 * Find a command in the tree by path
 *
 * @param tree - Command tree to search
 * @param path - Command path (e.g., ["task", "add"])
 * @returns Command metadata if found, null otherwise
 */
export function findCommand(
  tree: CommandMeta,
  path: string[],
): CommandMeta | null {
  if (path.length === 0) {
    return tree;
  }

  // If we're at the right level
  if (path.length === 1 && path[0] === tree.name) {
    return tree;
  }

  // Search in subcommands
  const [first, ...rest] = path;
  const subcommand = tree.subcommands.find((cmd) => cmd.name === first);

  if (!subcommand) {
    return null;
  }

  if (rest.length === 0) {
    return subcommand;
  }

  return findCommand(subcommand, rest);
}

/**
 * Flatten command tree into a list of all commands
 *
 * @param tree - Command tree to flatten
 * @returns Array of all commands in the tree
 */
export function flattenCommandTree(tree: CommandMeta): CommandMeta[] {
  const result: CommandMeta[] = [tree];

  for (const subcommand of tree.subcommands) {
    result.push(...flattenCommandTree(subcommand));
  }

  return result;
}

/**
 * Format command usage string
 *
 * @param command - Command metadata
 * @returns Usage string (e.g., "kspec task add [options]")
 */
export function formatCommandUsage(command: CommandMeta): string {
  const parts = ["kspec", ...command.fullPath.slice(1)]; // Skip root 'kspec'

  // Add arguments
  for (const arg of command.arguments) {
    if (arg.required) {
      parts.push(`<${arg.name}${arg.variadic ? "..." : ""}>`);
    } else {
      parts.push(`[${arg.name}${arg.variadic ? "..." : ""}]`);
    }
  }

  // Add [options] if command has options
  if (command.options.length > 0) {
    parts.push("[options]");
  }

  return parts.join(" ");
}
