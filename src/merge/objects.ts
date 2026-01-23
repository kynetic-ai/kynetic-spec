/**
 * Object merging algorithms for semantic YAML merge.
 *
 * Handles field-level merging of objects, recursively merging nested structures
 * and detecting conflicts when both sides modify the same scalar field.
 */

import type { ConflictInfo } from "./types.js";

/**
 * Result of merging two objects
 */
export interface ObjectMergeResult {
  /** The merged object */
  merged: Record<string, unknown>;
  /** Conflicts detected during merge */
  conflicts: ConflictInfo[];
}

/**
 * Check if a value is a plain object (not an array, null, or other type)
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Merge two objects field by field, recursively handling nested objects.
 *
 * AC: @yaml-merge-driver ac-3
 * When both versions modify different fields of the same item, fields are merged.
 *
 * AC: @yaml-merge-driver ac-7
 * Nested objects are merged recursively at field level.
 *
 * Strategy:
 * 1. Collect all keys from base, ours, and theirs
 * 2. For each key, determine what happened:
 *    - Added in ours only → include ours value
 *    - Added in theirs only → include theirs value
 *    - Added in both (not in base) → conflict if different
 *    - Modified in ours only → include ours value
 *    - Modified in theirs only → include theirs value
 *    - Modified in both → recurse if objects, else conflict
 *    - Deleted in ours, kept in theirs → include theirs value
 *    - Deleted in theirs, kept in ours → include ours value
 *    - Deleted in both → omit from result
 *
 * @param base Object from common ancestor
 * @param ours Object from current branch
 * @param theirs Object from incoming branch
 * @param path Path to this object (for conflict reporting)
 * @returns Merged object and any conflicts detected
 */
export function mergeObjects(
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

  // Collect all keys from all three versions
  const allKeys = new Set([
    ...Object.keys(baseObj),
    ...Object.keys(oursObj),
    ...Object.keys(theirsObj),
  ]);

  for (const key of allKeys) {
    const fieldPath = path ? `${path}.${key}` : key;
    const inBase = key in baseObj;
    const inOurs = key in oursObj;
    const inTheirs = key in theirsObj;

    const baseVal = baseObj[key];
    const oursVal = oursObj[key];
    const theirsVal = theirsObj[key];

    // Case 1: Field only in ours (added in ours)
    if (!inBase && inOurs && !inTheirs) {
      merged[key] = oursVal;
      continue;
    }

    // Case 2: Field only in theirs (added in theirs)
    if (!inBase && !inOurs && inTheirs) {
      merged[key] = theirsVal;
      continue;
    }

    // Case 3: Field added in both (not in base)
    if (!inBase && inOurs && inTheirs) {
      if (valuesEqual(oursVal, theirsVal)) {
        // Same value added in both - no conflict
        merged[key] = oursVal;
      } else if (isPlainObject(oursVal) && isPlainObject(theirsVal)) {
        // Both added nested objects - try to merge them
        const result = mergeObjects(undefined, oursVal, theirsVal, fieldPath);
        merged[key] = result.merged;
        conflicts.push(...result.conflicts);
      } else {
        // Different values added - conflict
        conflicts.push({
          type: "scalar_field",
          path: fieldPath,
          oursValue: oursVal,
          theirsValue: theirsVal,
          description: `Field "${key}" added with different values in both branches`,
        });
        // Default to ours for now (will be resolved interactively)
        merged[key] = oursVal;
      }
      continue;
    }

    // Case 4: Field deleted in ours, kept/modified in theirs
    if (inBase && !inOurs && inTheirs) {
      // Deletion in ours, but theirs kept it - include theirs value
      merged[key] = theirsVal;
      continue;
    }

    // Case 5: Field deleted in theirs, kept/modified in ours
    if (inBase && inOurs && !inTheirs) {
      // Deletion in theirs, but ours kept it - include ours value
      merged[key] = oursVal;
      continue;
    }

    // Case 6: Field deleted in both
    if (inBase && !inOurs && !inTheirs) {
      // Both deleted - omit from result
      continue;
    }

    // Case 7: Field exists in all three versions
    if (inBase && inOurs && inTheirs) {
      // Check if modified in ours
      const modifiedInOurs = !valuesEqual(baseVal, oursVal);
      // Check if modified in theirs
      const modifiedInTheirs = !valuesEqual(baseVal, theirsVal);

      if (!modifiedInOurs && !modifiedInTheirs) {
        // No changes in either - keep base value
        merged[key] = baseVal;
      } else if (modifiedInOurs && !modifiedInTheirs) {
        // Only modified in ours - take ours
        merged[key] = oursVal;
      } else if (!modifiedInOurs && modifiedInTheirs) {
        // Only modified in theirs - take theirs
        merged[key] = theirsVal;
      } else {
        // Modified in both - need to check for conflicts
        if (valuesEqual(oursVal, theirsVal)) {
          // Same modification in both - no conflict
          merged[key] = oursVal;
        } else if (isPlainObject(oursVal) && isPlainObject(theirsVal)) {
          // Both modified nested objects - recurse
          const result = mergeObjects(
            isPlainObject(baseVal) ? baseVal : undefined,
            oursVal,
            theirsVal,
            fieldPath,
          );
          merged[key] = result.merged;
          conflicts.push(...result.conflicts);
        } else {
          // Both modified scalar field with different values - conflict
          conflicts.push({
            type: "scalar_field",
            path: fieldPath,
            oursValue: oursVal,
            theirsValue: theirsVal,
            description: `Field "${key}" modified with different values in both branches`,
          });
          // Default to ours for now (will be resolved interactively)
          merged[key] = oursVal;
        }
      }
      continue;
    }
  }

  return { merged, conflicts };
}

/**
 * Compare two values for equality.
 * Handles primitives, arrays, and objects.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  // Handle primitives
  if (a === b) return true;

  // Handle null/undefined
  if (a == null || b == null) return a === b;

  // Handle arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => valuesEqual(val, b[idx]));
  }

  // Handle objects
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => valuesEqual(a[key], b[key]));
  }

  // Different types or values
  return false;
}
