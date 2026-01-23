/**
 * Array merging algorithms for semantic YAML merge.
 *
 * Handles different types of arrays:
 * - ULID-based entity arrays (tasks, notes, inbox items)
 * - Set-like arrays (tags, depends_on)
 * - Append-only arrays (notes, todos)
 */

/**
 * Merge arrays that contain entities with _ulid fields.
 *
 * AC: @yaml-merge-driver ac-2
 * Union merge: both additions included, identified by ULID.
 *
 * AC: @yaml-merge-driver ac-5
 * Append-only arrays (notes, todos) are union merged by ULID.
 *
 * Strategy:
 * 1. Start with all items from base (common ancestor)
 * 2. Add items from ours that aren't in base (new in our branch)
 * 3. Add items from theirs that aren't in base (new in their branch)
 * 4. For items in base that were modified, prefer the modified version
 *
 * @param base Array from common ancestor
 * @param ours Array from current branch
 * @param theirs Array from incoming branch
 * @returns Merged array with all items
 */
export function mergeUlidArrays<T extends { _ulid: string }>(
  base: T[] | undefined,
  ours: T[] | undefined,
  theirs: T[] | undefined,
): T[] {
  const baseArr = base ?? [];
  const oursArr = ours ?? [];
  const theirsArr = theirs ?? [];

  // Build lookup maps by ULID
  const baseMap = new Map(baseArr.map((item) => [item._ulid, item]));
  const oursMap = new Map(oursArr.map((item) => [item._ulid, item]));
  const theirsMap = new Map(theirsArr.map((item) => [item._ulid, item]));

  // Result map - track all unique ULIDs
  const resultMap = new Map<string, T>();

  // Add all items from ours (includes base items that may be modified)
  for (const item of oursArr) {
    resultMap.set(item._ulid, item);
  }

  // Add items from theirs that aren't in ours
  for (const item of theirsArr) {
    if (!oursMap.has(item._ulid)) {
      // Item was added in theirs - include it
      resultMap.set(item._ulid, item);
    }
    // If item exists in both ours and theirs but differs, we have a conflict
    // That will be handled by field-level merge (separate function)
  }

  // Convert back to array, preserving order (ours first, then theirs additions)
  const result: T[] = [];

  // Add all items from ours in original order
  for (const item of oursArr) {
    result.push(resultMap.get(item._ulid)!);
  }

  // Add new items from theirs that weren't in ours
  for (const item of theirsArr) {
    if (!oursMap.has(item._ulid)) {
      result.push(resultMap.get(item._ulid)!);
    }
  }

  return result;
}

/**
 * Merge set-like arrays (tags, depends_on, etc).
 *
 * AC: @yaml-merge-driver ac-6
 * Set union: combine both arrays, remove duplicates.
 *
 * Strategy:
 * 1. Start with items from ours
 * 2. Add items from theirs that aren't in ours
 * 3. Remove duplicates
 *
 * @param base Array from common ancestor (not used for set merge)
 * @param ours Array from current branch
 * @param theirs Array from incoming branch
 * @returns Merged array with unique items
 */
export function mergeSetArray<T extends string | number>(
  base: T[] | undefined,
  ours: T[] | undefined,
  theirs: T[] | undefined,
): T[] {
  const oursArr = ours ?? [];
  const theirsArr = theirs ?? [];

  // Use Set to eliminate duplicates
  const result = new Set<T>(oursArr);

  // Add items from theirs
  for (const item of theirsArr) {
    result.add(item);
  }

  return Array.from(result);
}

/**
 * Detect if an item was deleted in one branch.
 *
 * Helper for AC: @yaml-merge-driver ac-8
 * Detect when one version deletes an item while other modifies it.
 *
 * @param ulid ULID to check
 * @param base Base version map
 * @param ours Ours version map
 * @param theirs Theirs version map
 * @returns Whether item was deleted in ours or theirs
 */
export function detectDeletion(
  ulid: string,
  base: Map<string, unknown>,
  ours: Map<string, unknown>,
  theirs: Map<string, unknown>,
): {
  deletedInOurs: boolean;
  deletedInTheirs: boolean;
  modifiedInOurs: boolean;
  modifiedInTheirs: boolean;
} {
  const inBase = base.has(ulid);
  const inOurs = ours.has(ulid);
  const inTheirs = theirs.has(ulid);

  return {
    deletedInOurs: inBase && !inOurs && inTheirs,
    deletedInTheirs: inBase && inOurs && !inTheirs,
    modifiedInOurs: inBase && inOurs,
    modifiedInTheirs: inBase && inTheirs,
  };
}
