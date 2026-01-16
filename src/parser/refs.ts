/**
 * Reference resolution system for @references.
 *
 * Handles resolution of @slug and @ulid references to actual items,
 * with proper error handling for not-found and ambiguous cases.
 */

import type { LoadedSpecItem, LoadedTask, AnyLoadedItem } from './yaml.js';

// ============================================================
// TYPES
// ============================================================

/**
 * Successful resolution result
 */
export interface ResolveSuccess {
  ok: true;
  ulid: string;
  item: AnyLoadedItem;
  /** How the reference was matched */
  matchType: 'slug' | 'ulid-full' | 'ulid-prefix';
}

/**
 * Failed resolution - reference not found
 */
export interface ResolveNotFound {
  ok: false;
  error: 'not_found';
  ref: string;
}

/**
 * Failed resolution - ambiguous ULID prefix
 */
export interface ResolveAmbiguous {
  ok: false;
  error: 'ambiguous';
  ref: string;
  /** The matching ULIDs */
  candidates: string[];
}

/**
 * Failed resolution - duplicate slug
 */
export interface ResolveDuplicateSlug {
  ok: false;
  error: 'duplicate_slug';
  ref: string;
  /** The ULIDs that share this slug */
  candidates: string[];
}

export type ResolveResult =
  | ResolveSuccess
  | ResolveNotFound
  | ResolveAmbiguous
  | ResolveDuplicateSlug;

/**
 * Validation error for a single reference
 */
export interface RefValidationError {
  /** The reference string that failed */
  ref: string;
  /** Where this reference was found */
  sourceFile?: string;
  /** The item containing this reference */
  sourceUlid?: string;
  /** The field containing this reference */
  field: string;
  /** Error type */
  error: 'not_found' | 'ambiguous' | 'duplicate_slug';
  /** Additional context */
  message: string;
}

// ============================================================
// REFERENCE INDEX
// ============================================================

/**
 * Index for efficient reference resolution.
 * Build once when loading the spec, then resolve many times.
 */
export class ReferenceIndex {
  /** slug → ULID mapping */
  private slugIndex = new Map<string, string[]>();

  /** ULID → item mapping */
  private ulidIndex = new Map<string, AnyLoadedItem>();

  /** All ULIDs for prefix matching */
  private allUlids: string[] = [];

  /**
   * Build index from loaded items
   */
  constructor(tasks: LoadedTask[], items: LoadedSpecItem[]) {
    // Index tasks
    for (const task of tasks) {
      this.indexItem(task);
    }

    // Index spec items
    for (const item of items) {
      this.indexItem(item);
    }

    // Sort ULIDs for consistent ordering
    this.allUlids.sort();
  }

  private indexItem(item: AnyLoadedItem): void {
    const ulid = item._ulid;

    // Index by ULID
    this.ulidIndex.set(ulid, item);
    this.allUlids.push(ulid);

    // Index by slugs
    for (const slug of item.slugs) {
      const existing = this.slugIndex.get(slug);
      if (existing) {
        existing.push(ulid);
      } else {
        this.slugIndex.set(slug, [ulid]);
      }
    }
  }

  /**
   * Resolve a reference to an item.
   *
   * Resolution order:
   * 1. Exact slug match
   * 2. Full ULID match
   * 3. ULID prefix match (must be unique)
   */
  resolve(ref: string): ResolveResult {
    // Strip @ prefix if present
    const cleanRef = ref.startsWith('@') ? ref.slice(1) : ref;
    const cleanRefLower = cleanRef.toLowerCase();

    // 1. Try slug match first
    const slugMatches = this.slugIndex.get(cleanRef);
    if (slugMatches) {
      if (slugMatches.length > 1) {
        return {
          ok: false,
          error: 'duplicate_slug',
          ref,
          candidates: slugMatches,
        };
      }
      const ulid = slugMatches[0];
      const item = this.ulidIndex.get(ulid)!;
      return { ok: true, ulid, item, matchType: 'slug' };
    }

    // 2. Try full ULID match
    const exactMatch = this.ulidIndex.get(cleanRef.toUpperCase());
    if (exactMatch) {
      return {
        ok: true,
        ulid: exactMatch._ulid,
        item: exactMatch,
        matchType: 'ulid-full',
      };
    }

    // 3. Try ULID prefix match
    const prefixMatches = this.allUlids.filter(ulid =>
      ulid.toLowerCase().startsWith(cleanRefLower)
    );

    if (prefixMatches.length === 0) {
      return { ok: false, error: 'not_found', ref };
    }

    if (prefixMatches.length > 1) {
      return {
        ok: false,
        error: 'ambiguous',
        ref,
        candidates: prefixMatches,
      };
    }

    const ulid = prefixMatches[0];
    const item = this.ulidIndex.get(ulid)!;
    return { ok: true, ulid, item, matchType: 'ulid-prefix' };
  }

  /**
   * Get an item by exact ULID (no resolution, direct lookup)
   */
  getByUlid(ulid: string): AnyLoadedItem | undefined {
    return this.ulidIndex.get(ulid);
  }

  /**
   * Get the minimum unique prefix for a ULID.
   * Returns the shortest prefix that uniquely identifies this ULID
   * among all indexed items.
   *
   * @param ulid The full ULID to shorten
   * @param minLength Minimum prefix length (default 8)
   * @returns Shortest unique prefix
   */
  shortUlid(ulid: string, minLength = 8): string {
    // Start with minimum length
    let length = minLength;

    while (length < ulid.length) {
      const prefix = ulid.slice(0, length);
      const matches = this.allUlids.filter(u =>
        u.toUpperCase().startsWith(prefix.toUpperCase())
      );

      if (matches.length === 1) {
        return prefix;
      }

      length++;
    }

    // Return full ULID if no shorter unique prefix found
    return ulid;
  }

  /**
   * Get all indexed ULIDs
   */
  getAllUlids(): string[] {
    return [...this.allUlids];
  }

  /**
   * Get all slugs and their mappings
   */
  getAllSlugs(): Map<string, string[]> {
    return new Map(this.slugIndex);
  }

  /**
   * Check if a slug exists
   */
  hasSlug(slug: string): boolean {
    return this.slugIndex.has(slug);
  }

  /**
   * Get count of indexed items
   */
  get size(): number {
    return this.ulidIndex.size;
  }
}

// ============================================================
// VALIDATION
// ============================================================

/**
 * Fields that contain references
 */
const REF_FIELDS = [
  'depends_on',
  'blocked_by',
  'implements',
  'relates_to',
  'tests',
  'supersedes',
  'spec_ref',
  'context',
];

/**
 * Extract all references from an item
 */
function extractRefs(item: AnyLoadedItem): Array<{ field: string; ref: string }> {
  const refs: Array<{ field: string; ref: string }> = [];
  const obj = item as unknown as Record<string, unknown>;

  for (const field of REF_FIELDS) {
    const value = obj[field];

    if (typeof value === 'string' && value.startsWith('@')) {
      refs.push({ field, ref: value });
    } else if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string' && v.startsWith('@')) {
          refs.push({ field, ref: v });
        }
      }
    }
  }

  return refs;
}

/**
 * Validate all references in the spec.
 * Returns list of validation errors.
 */
export function validateRefs(
  index: ReferenceIndex,
  tasks: LoadedTask[],
  items: LoadedSpecItem[]
): RefValidationError[] {
  const errors: RefValidationError[] = [];

  const allItems: AnyLoadedItem[] = [...tasks, ...items];

  for (const item of allItems) {
    const refs = extractRefs(item);
    const sourceFile = (item as LoadedTask | LoadedSpecItem)._sourceFile;

    for (const { field, ref } of refs) {
      const result = index.resolve(ref);

      if (!result.ok) {
        let message: string;

        switch (result.error) {
          case 'not_found':
            message = `Reference "${ref}" not found`;
            break;
          case 'ambiguous':
            message = `Reference "${ref}" is ambiguous, matches: ${result.candidates.join(', ')}`;
            break;
          case 'duplicate_slug':
            message = `Slug "${ref}" maps to multiple items: ${result.candidates.join(', ')}`;
            break;
        }

        errors.push({
          ref,
          sourceFile,
          sourceUlid: item._ulid,
          field,
          error: result.error,
          message,
        });
      }
    }
  }

  return errors;
}

/**
 * Find duplicate slugs in the index.
 * Returns map of slug → ULIDs for slugs with multiple items.
 */
export function findDuplicateSlugs(index: ReferenceIndex): Map<string, string[]> {
  const duplicates = new Map<string, string[]>();

  for (const [slug, ulids] of index.getAllSlugs()) {
    if (ulids.length > 1) {
      duplicates.set(slug, ulids);
    }
  }

  return duplicates;
}

// ============================================================
// SLUG UNIQUENESS CHECK
// ============================================================

/**
 * Result of checking slug uniqueness
 */
export interface SlugCheckSuccess {
  ok: true;
}

export interface SlugCheckConflict {
  ok: false;
  slug: string;
  existingUlid: string;
}

export type SlugCheckResult = SlugCheckSuccess | SlugCheckConflict;

/**
 * Check if proposed slugs are unique (don't conflict with existing items).
 *
 * @param index The reference index to check against
 * @param slugs Array of proposed slugs to check
 * @param excludeUlid Optional ULID to exclude from conflict check (for updates)
 * @returns Success if all slugs are available, or conflict info if one exists
 */
export function checkSlugUniqueness(
  index: ReferenceIndex,
  slugs: string[],
  excludeUlid?: string
): SlugCheckResult {
  const allSlugs = index.getAllSlugs();

  for (const slug of slugs) {
    const existingUlids = allSlugs.get(slug);
    if (existingUlids) {
      // Filter out the item being updated (if provided)
      const conflictingUlids = excludeUlid
        ? existingUlids.filter(ulid => ulid !== excludeUlid)
        : existingUlids;

      if (conflictingUlids.length > 0) {
        return {
          ok: false,
          slug,
          existingUlid: conflictingUlids[0],
        };
      }
    }
  }

  return { ok: true };
}
