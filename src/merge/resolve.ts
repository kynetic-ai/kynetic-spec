/**
 * Conflict resolution for semantic YAML merge.
 *
 * Handles interactive prompts for conflicts and formatting
 * conflicts as YAML comments in non-interactive mode.
 */

import type { ConflictInfo } from "./types.js";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/**
 * Resolution choice for a conflict
 */
export type ResolutionChoice = "ours" | "theirs" | "skip";

/**
 * Result of resolving a single conflict
 */
export interface ConflictResolution {
  /** The conflict that was resolved */
  conflict: ConflictInfo;
  /** The choice made */
  choice: ResolutionChoice;
  /** The resolved value (undefined if skipped) */
  value?: unknown;
}

/**
 * AC: @yaml-merge-driver ac-4
 * Prompt user interactively to resolve a scalar field conflict.
 *
 * @param conflict The conflict to resolve
 * @returns The resolution choice and value
 */
export async function promptScalarConflict(
  conflict: ConflictInfo,
): Promise<ConflictResolution> {
  const rl = readline.createInterface({ input, output });

  try {
    console.log(`\n${conflict.description}`);
    console.log(`Path: ${conflict.path}`);
    console.log(`  [1] Ours:   ${formatValue(conflict.oursValue)}`);
    console.log(`  [2] Theirs: ${formatValue(conflict.theirsValue)}`);
    console.log(`  [3] Skip (leave unresolved)`);

    const answer = await rl.question("\nChoose [1/2/3]: ");

    switch (answer.trim()) {
      case "1":
        return {
          conflict,
          choice: "ours",
          value: conflict.oursValue,
        };
      case "2":
        return {
          conflict,
          choice: "theirs",
          value: conflict.theirsValue,
        };
      case "3":
      default:
        return {
          conflict,
          choice: "skip",
        };
    }
  } finally {
    rl.close();
  }
}

/**
 * AC: @yaml-merge-driver ac-8
 * Prompt user to choose between deletion and keeping modified version.
 *
 * @param conflict The delete-modify conflict to resolve
 * @returns The resolution choice
 */
export async function promptDeleteModifyConflict(
  conflict: ConflictInfo,
): Promise<ConflictResolution> {
  const rl = readline.createInterface({ input, output });

  try {
    console.log(`\n${conflict.description}`);
    console.log(`Path: ${conflict.path}`);

    // Determine which side deleted
    const deletedInOurs = conflict.oursValue === undefined;

    if (deletedInOurs) {
      console.log(`  [1] Delete (ours deleted this)`);
      console.log(`  [2] Keep modified version: ${formatValue(conflict.theirsValue)}`);
    } else {
      console.log(`  [1] Keep modified version: ${formatValue(conflict.oursValue)}`);
      console.log(`  [2] Delete (theirs deleted this)`);
    }
    console.log(`  [3] Skip (leave unresolved)`);

    const answer = await rl.question("\nChoose [1/2/3]: ");

    switch (answer.trim()) {
      case "1":
        return {
          conflict,
          choice: deletedInOurs ? "ours" : "ours",
          value: deletedInOurs ? undefined : conflict.oursValue,
        };
      case "2":
        return {
          conflict,
          choice: deletedInOurs ? "theirs" : "theirs",
          value: deletedInOurs ? conflict.theirsValue : undefined,
        };
      case "3":
      default:
        return {
          conflict,
          choice: "skip",
        };
    }
  } finally {
    rl.close();
  }
}

/**
 * Resolve multiple conflicts interactively.
 *
 * @param conflicts Array of conflicts to resolve
 * @returns Array of resolutions
 */
export async function resolveConflictsInteractive(
  conflicts: ConflictInfo[],
): Promise<ConflictResolution[]> {
  const resolutions: ConflictResolution[] = [];

  for (const conflict of conflicts) {
    let resolution: ConflictResolution;

    switch (conflict.type) {
      case "scalar_field":
        resolution = await promptScalarConflict(conflict);
        break;
      case "delete_modify":
        resolution = await promptDeleteModifyConflict(conflict);
        break;
      case "nested_conflict":
        // Nested conflicts should have been flattened to scalar conflicts
        resolution = await promptScalarConflict(conflict);
        break;
    }

    resolutions.push(resolution);
  }

  return resolutions;
}

/**
 * AC: @yaml-merge-driver ac-10
 * Format a conflict as a YAML comment for non-interactive mode.
 *
 * Example output:
 * ```yaml
 * # CONFLICT: Field "title" modified with different values in both branches
 * # Path: tasks[0].title
 * # Ours: "Fix authentication bug"
 * # Theirs: "Fix auth issue"
 * title: "Fix authentication bug"  # Using ours
 * ```
 *
 * @param conflict The conflict to format
 * @returns YAML comment lines
 */
export function formatConflictComment(conflict: ConflictInfo): string[] {
  const lines: string[] = [];

  lines.push(`# CONFLICT: ${conflict.description}`);
  lines.push(`# Path: ${conflict.path}`);

  if (conflict.ulid) {
    lines.push(`# ULID: ${conflict.ulid}`);
  }

  lines.push(`# Ours:   ${formatValue(conflict.oursValue)}`);
  lines.push(`# Theirs: ${formatValue(conflict.theirsValue)}`);
  lines.push(`# Resolution: Using ours (run merge interactively to resolve)`);

  return lines;
}

/**
 * Format a value for display in prompts or comments.
 * Handles primitives, arrays, and objects concisely.
 */
function formatValue(value: unknown): string {
  if (value === undefined) return "<deleted>";
  if (value === null) return "null";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.length <= 3) {
      return `[${value.map(formatValue).join(", ")}]`;
    }
    return `[${value.length} items]`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    if (keys.length === 1) {
      return `{${keys[0]}}`;
    }
    return `{${keys.length} fields}`;
  }

  return String(value);
}
