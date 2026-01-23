/**
 * Semantic YAML merge driver for kspec files.
 *
 * Public API exports for the merge module.
 */

export type {
  MergeResult,
  ConflictInfo,
  ConflictType,
  MergeOptions,
  ParsedVersions,
  ParseResult,
} from "./types.js";

export { parseYamlVersions } from "./parse.js";

export {
  mergeUlidArrays,
  mergeSetArray,
  detectDeletion,
} from "./arrays.js";

export { mergeObjects } from "./objects.js";
export type { ObjectMergeResult } from "./objects.js";
