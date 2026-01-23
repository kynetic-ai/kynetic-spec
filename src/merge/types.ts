/**
 * Types for semantic YAML merge driver.
 *
 * The merge driver parses kspec YAML files and merges them semantically,
 * understanding the structure of tasks, items, and other entities.
 */

/**
 * Result of a merge operation
 */
export interface MergeResult {
  /** The merged YAML content */
  content: string;
  /** Whether conflicts were detected */
  hasConflicts: boolean;
  /** Conflict information (empty if no conflicts) */
  conflicts: ConflictInfo[];
  /** Whether parsing failed (triggers fallback) */
  parseFailed: boolean;
  /** Error message if parse failed */
  parseError?: string;
}

/**
 * Information about a conflict that requires resolution
 */
export interface ConflictInfo {
  /** Type of conflict */
  type: ConflictType;
  /** Path to the conflicting field (e.g., "tasks[0].title") */
  path: string;
  /** ULID of the item with conflict (if applicable) */
  ulid?: string;
  /** Value from "ours" branch */
  oursValue: unknown;
  /** Value from "theirs" branch */
  theirsValue: unknown;
  /** Description of the conflict */
  description: string;
}

/**
 * Types of conflicts that can occur during merge
 */
export type ConflictType =
  | "scalar_field" // Both sides modified same scalar field
  | "delete_modify" // One side deleted, other modified
  | "nested_conflict"; // Conflict in nested object

/**
 * Options for merge operations
 */
export interface MergeOptions {
  /** Whether to run in non-interactive mode (no prompts) */
  nonInteractive?: boolean;
  /** Output file path for merged result */
  outputPath: string;
  /** Path to "base" version (common ancestor) */
  basePath: string;
  /** Path to "ours" version (current branch) */
  oursPath: string;
  /** Path to "theirs" version (incoming branch) */
  theirsPath: string;
}

/**
 * Parsed versions of a file for merging
 */
export interface ParsedVersions {
  /** Common ancestor version */
  base: unknown;
  /** Current branch version */
  ours: unknown;
  /** Incoming branch version */
  theirs: unknown;
}

/**
 * Result of parsing all three versions
 */
export interface ParseResult {
  /** Whether parsing succeeded */
  success: boolean;
  /** Parsed versions (undefined if parse failed) */
  versions?: ParsedVersions;
  /** Error message if parse failed */
  error?: string;
  /** Which file failed to parse (if applicable) */
  failedFile?: "base" | "ours" | "theirs";
}
