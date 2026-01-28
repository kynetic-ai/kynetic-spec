/**
 * Git merge driver for kspec YAML files.
 *
 * This command is invoked by git during merge operations to semantically
 * merge kspec YAML files based on their structure rather than line-by-line.
 */

import * as fs from "node:fs/promises";
import type { Command } from "commander";
import { stringify as yamlStringify } from "yaml";
import {
  parseYamlVersions,
  mergeObjects,
  mergeUlidArrays,
  resolveConflictsInteractive,
  formatConflictComment,
  detectFileType,
  FileType,
  type MergeResult,
  type ConflictInfo,
  type ObjectMergeResult,
} from "../../merge/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error } from "../output.js";

/**
 * Enhanced object merge that handles arrays with ULID items specially.
 *
 * For array fields containing objects with _ulid, uses ULID-based merging
 * to first merge the array structure, then recursively merges each item.
 */
function mergeObjectsWithArrays(
  base: Record<string, unknown> | undefined,
  ours: Record<string, unknown> | undefined,
  theirs: Record<string, unknown> | undefined,
  path = "",
): ObjectMergeResult {
  const baseObj = base ?? {};
  const oursObj = ours ?? {};
  const theirsObj = theirs ?? {};

  const merged: Record<string, unknown> = {};
  const conflicts: ConflictInfo[] = [];

  // Collect all keys
  const allKeys = new Set([
    ...Object.keys(baseObj),
    ...Object.keys(oursObj),
    ...Object.keys(theirsObj),
  ]);

  for (const key of allKeys) {
    const fieldPath = path ? `${path}.${key}` : key;
    const baseVal = baseObj[key];
    const oursVal = oursObj[key];
    const theirsVal = theirsObj[key];

    // Check if this field is an array of ULID items
    if (
      Array.isArray(baseVal) &&
      Array.isArray(oursVal) &&
      Array.isArray(theirsVal) &&
      hasUlidItems(oursVal as unknown[])
    ) {
      // Use ULID array merging
      const mergedArray = mergeUlidArrays(
        baseVal as Array<{ _ulid: string }>,
        oursVal as Array<{ _ulid: string }>,
        theirsVal as Array<{ _ulid: string }>,
      );

      // Now merge each item in the array recursively
      const mergedItems: unknown[] = [];
      for (const item of mergedArray) {
        const itemUlid = (item as any)._ulid;
        const baseItem = (baseVal as any[]).find((i: any) => i._ulid === itemUlid);
        const oursItem = (oursVal as any[]).find((i: any) => i._ulid === itemUlid);
        const theirsItem = (theirsVal as any[]).find((i: any) => i._ulid === itemUlid);

        if (oursItem && theirsItem) {
          // Item exists in both - merge fields
          const itemMerge = mergeObjects(
            baseItem as Record<string, unknown> | undefined,
            oursItem as Record<string, unknown>,
            theirsItem as Record<string, unknown>,
            `${fieldPath}[${itemUlid}]`,
          );
          mergedItems.push(itemMerge.merged);
          conflicts.push(...itemMerge.conflicts);
        } else {
          // Item only in one side - use it as-is
          mergedItems.push(item);
        }
      }

      merged[key] = mergedItems;
    } else {
      // Not a ULID array - use standard object merge for this field
      const fieldMerge = mergeObjects(
        { [key]: baseVal },
        { [key]: oursVal },
        { [key]: theirsVal },
        path,
      );
      if (key in fieldMerge.merged) {
        merged[key] = fieldMerge.merged[key];
      }
      conflicts.push(...fieldMerge.conflicts);
    }
  }

  return { merged, conflicts };
}

/**
 * Check if an array contains items with _ulid field.
 */
function hasUlidItems(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  const first = arr[0];
  return (
    typeof first === 'object' &&
    first !== null &&
    '_ulid' in first &&
    typeof (first as any)._ulid === 'string'
  );
}

/**
 * Check if a value is a root-level array (not an object).
 */
function isRootArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Merge root-level arrays with ULID-based deduplication and field-level conflict detection.
 * AC: @merge-file-detection ac-7
 */
function mergeRootArrays(
  base: unknown,
  ours: unknown,
  theirs: unknown,
): ObjectMergeResult {
  const baseArr = Array.isArray(base) ? base : [];
  const oursArr = Array.isArray(ours) ? ours : [];
  const theirsArr = Array.isArray(theirs) ? theirs : [];

  const conflicts: ConflictInfo[] = [];

  // Check if arrays contain ULID items
  if (!hasUlidItems(oursArr) && !hasUlidItems(theirsArr)) {
    // Non-ULID arrays: keep ours (fallback)
    return { merged: oursArr as unknown as Record<string, unknown>, conflicts: [] };
  }

  // Use ULID array merging
  const mergedArray = mergeUlidArrays(
    baseArr as Array<{ _ulid: string }>,
    oursArr as Array<{ _ulid: string }>,
    theirsArr as Array<{ _ulid: string }>,
  );

  // Merge each item recursively for field-level conflicts
  const mergedItems: unknown[] = [];
  for (const item of mergedArray) {
    const itemUlid = (item as any)._ulid;
    const baseItem = baseArr.find((i: any) => i._ulid === itemUlid);
    const oursItem = oursArr.find((i: any) => i._ulid === itemUlid);
    const theirsItem = theirsArr.find((i: any) => i._ulid === itemUlid);

    if (oursItem && theirsItem) {
      // Item exists in both - merge fields
      const itemMerge = mergeObjects(
        baseItem as Record<string, unknown> | undefined,
        oursItem as Record<string, unknown>,
        theirsItem as Record<string, unknown>,
        `[${itemUlid}]`,
      );
      mergedItems.push(itemMerge.merged);
      conflicts.push(...itemMerge.conflicts);
    } else {
      mergedItems.push(item);
    }
  }

  // Return array but typed to satisfy ObjectMergeResult
  // The caller will handle this specially
  return {
    merged: mergedItems as unknown as Record<string, unknown>,
    conflicts
  };
}

/**
 * Perform a semantic merge of three YAML files.
 *
 * AC: @merge-driver-cli ac-1
 * Reads base (%O), ours (%A), theirs (%B) and writes merged result to %A path.
 *
 * @param basePath Path to base version (common ancestor)
 * @param oursPath Path to ours version (current branch) - also output path
 * @param theirsPath Path to theirs version (incoming branch)
 * @param options Merge options
 * @returns MergeResult with merged content and conflict info
 */
async function performSemanticMerge(
  basePath: string,
  oursPath: string,
  theirsPath: string,
  options: {
    nonInteractive: boolean;
    filePath?: string;
  },
): Promise<MergeResult> {
  // Parse all three versions
  const parseResult = await parseYamlVersions(basePath, oursPath, theirsPath);

  if (!parseResult.success) {
    return {
      content: "",
      hasConflicts: true,
      conflicts: [],
      parseFailed: true,
      parseError: parseResult.error,
    };
  }

  const { versions } = parseResult;
  if (!versions) {
    return {
      content: "",
      hasConflicts: true,
      conflicts: [],
      parseFailed: true,
      parseError: "No versions parsed",
    };
  }

  // Detect file type for future specialized merging
  const _fileType = options.filePath
    ? detectFileType(options.filePath)
    : FileType.Unknown;

  // For now, use generic object merging for all types
  // Future: Specialized merging based on _fileType

  // Check if root is array vs object
  // AC: @merge-file-detection ac-7
  const isRootLevelArray = isRootArray(versions.ours) || isRootArray(versions.theirs);

  let mergeResult: ObjectMergeResult;
  let rootIsArray = false;

  if (isRootLevelArray) {
    rootIsArray = true;
    mergeResult = mergeRootArrays(versions.base, versions.ours, versions.theirs);
  } else {
    mergeResult = mergeObjectsWithArrays(
      versions.base as Record<string, unknown>,
      versions.ours as Record<string, unknown>,
      versions.theirs as Record<string, unknown>,
      "",
    );
  }

  let finalMerged: Record<string, unknown> | unknown[] = mergeResult.merged;
  const conflicts = mergeResult.conflicts;

  // Handle conflicts based on mode
  if (conflicts.length > 0) {
    if (options.nonInteractive) {
      // AC: @merge-driver-cli ac-3
      // Non-interactive: keep ours value and add conflict comments
      // Conflicts are already in the conflicts array, merged object uses ours by default
    } else {
      // Interactive: prompt user for each conflict
      const resolutions = await resolveConflictsInteractive(conflicts);

      // Apply resolutions to merged object
      for (const resolution of resolutions) {
        if (resolution.choice !== "skip") {
          applyResolution(finalMerged, resolution.conflict.path, resolution.value);
        }
      }
    }
  }

  // Convert merged object back to YAML
  let mergedYaml = yamlStringify(finalMerged, {
    lineWidth: 0, // Disable line wrapping
    indent: 2,
  });

  // In non-interactive mode, add conflict comments at the top
  // AC: @merge-driver-cli ac-3
  if (options.nonInteractive && conflicts.length > 0) {
    const conflictComments: string[] = [];
    for (const conflict of conflicts) {
      conflictComments.push(...formatConflictComment(conflict));
    }
    mergedYaml = conflictComments.join("\n") + "\n\n" + mergedYaml;
  }

  return {
    content: mergedYaml,
    hasConflicts: conflicts.length > 0,
    conflicts,
    parseFailed: false,
  };
}

/**
 * Apply a resolution to a merged object or array at a given path.
 * Path format: "field.nestedField", "array[0].field", or "[ulid].field" for root arrays
 */
function applyResolution(
  obj: Record<string, unknown> | unknown[],
  path: string,
  value: unknown,
): void {
  const parts = path.split(/\.|\[|\]/).filter((p) => p.length > 0);
  let current: any = obj;

  // Handle root array: first part is ULID, find item by it
  if (Array.isArray(obj) && parts.length > 0) {
    const ulid = parts[0];
    const itemIndex = obj.findIndex((item: any) => item._ulid === ulid);
    if (itemIndex === -1) return;
    if (parts.length === 1) {
      // Replacing entire item - not typical
      obj[itemIndex] = value;
      return;
    }
    current = obj[itemIndex];
    parts.shift(); // Remove ULID, continue with remaining path
  }

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current)) {
      current[part] = {};
    }
    current = current[part];
  }

  const lastPart = parts[parts.length - 1];
  if (value === undefined) {
    delete current[lastPart];
  } else {
    current[lastPart] = value;
  }
}

/**
 * Format a summary message about the merge result.
 *
 * AC: @merge-driver-cli ac-2
 * Shows summary of what was merged/conflicted on stderr.
 */
function formatMergeSummary(result: MergeResult): string {
  const lines: string[] = [];

  if (result.parseFailed) {
    lines.push("Merge failed: Parse error");
    if (result.parseError) {
      lines.push(`  ${result.parseError}`);
    }
    lines.push("  Falling back to standard git merge");
    return lines.join("\n");
  }

  if (result.hasConflicts) {
    lines.push(`Merged with ${result.conflicts.length} conflict(s):`);
    for (const conflict of result.conflicts) {
      lines.push(`  - ${conflict.path}: ${conflict.description}`);
    }
  } else {
    lines.push("Merged successfully (no conflicts)");
  }

  return lines.join("\n");
}

/**
 * Register the 'merge-driver' command.
 *
 * Git invokes merge drivers with these positional arguments:
 *   %O - base version (common ancestor)
 *   %A - ours version (current branch) - also the output path
 *   %B - theirs version (incoming branch)
 *   %L - conflict marker size (optional, unused by semantic merge)
 *   %P - file path (optional, for context)
 */
export function registerMergeDriverCommand(program: Command): void {
  program
    .command("merge-driver <base> <ours> <theirs> [markerSize] [path]")
    .description("Git merge driver for semantic YAML merging")
    .option(
      "--non-interactive",
      "Run in non-interactive mode (write conflicts as comments)",
    )
    .action(
      async (
        basePath: string,
        oursPath: string,
        theirsPath: string,
        _markerSize: string | undefined,
        filePath: string | undefined,
        options: { nonInteractive?: boolean },
      ) => {
        try {
          // AC: @merge-driver-cli ac-1
          // Perform semantic merge
          const result = await performSemanticMerge(
            basePath,
            oursPath,
            theirsPath,
            {
              nonInteractive: options.nonInteractive || false,
              filePath,
            },
          );

          // If parse failed, exit with error code to trigger git's fallback
          if (result.parseFailed) {
            // AC: @merge-driver-cli ac-2
            console.error(formatMergeSummary(result));
            process.exit(EXIT_CODES.ERROR);
          }

          // Write merged result to ours path (git expects output at %A)
          // AC: @merge-driver-cli ac-1
          await fs.writeFile(oursPath, result.content, "utf-8");

          // AC: @merge-driver-cli ac-2
          // Write summary to stderr for user visibility
          console.error(formatMergeSummary(result));

          // Exit code: 0 for clean merge, 1 if conflicts remain
          // Git interprets non-zero exit as "conflict markers written"
          process.exit(result.hasConflicts ? 1 : 0);
        } catch (err) {
          error("Merge driver failed", err);
          process.exit(EXIT_CODES.ERROR);
        }
      },
    );
}
