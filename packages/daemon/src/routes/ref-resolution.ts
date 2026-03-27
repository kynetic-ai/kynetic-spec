/**
 * Reference Resolution Utilities
 *
 * Server-side resolution of @references to display-ready metadata.
 * Used by API routes to include resolved titles alongside raw refs.
 *
 * AC: @ui-api-ref-resolution ac-1, ac-2, ac-3
 */

import type { ReferenceIndex } from "../../parser/index.js";

/**
 * Resolved metadata for a single-valued reference.
 * AC: @ui-api-ref-resolution ac-1
 */
export interface ResolvedRef {
  ref: string;
  title: string | null;
}

/**
 * Resolved metadata for an array reference entry with status.
 * AC: @ui-api-ref-resolution ac-2
 */
export interface ResolvedRefEntry {
  ref: string;
  title: string | null;
  status: string | null;
}

/**
 * Lightweight index entry for the ref index endpoint.
 * AC: @ui-api-ref-resolution ac-4, ac-5
 */
export interface RefIndexEntry {
  title: string;
  type: string;
  status?: string;
}

/**
 * Resolve a single-valued reference to its title.
 * Returns null title if the ref cannot be resolved (ac-3).
 *
 * AC: @ui-api-ref-resolution ac-1, ac-3
 */
export function resolveRefTitle(
  index: ReferenceIndex,
  ref: string | undefined | null,
): string | null {
  if (!ref) return null;
  const result = index.resolve(ref);
  if (!result.ok) return null;
  const item = result.item as { title?: string };
  return item.title ?? null;
}

/**
 * Resolve an array of references to entries with title and status.
 * Invalid/deleted refs get null title but preserve the raw ref (ac-3).
 *
 * AC: @ui-api-ref-resolution ac-2, ac-3
 */
export function resolveRefEntries(
  index: ReferenceIndex,
  refs: string[] | undefined | null,
): ResolvedRefEntry[] {
  if (!refs || refs.length === 0) return [];
  return refs.map((ref) => {
    const result = index.resolve(ref);
    if (!result.ok) {
      return { ref, title: null, status: null };
    }
    const item = result.item as { title?: string; status?: unknown };
    return {
      ref,
      title: item.title ?? null,
      status: normalizeStatus(item.status),
    };
  });
}

/**
 * Normalize a status value to a string.
 * Task status is already a string (e.g. "pending", "in_progress").
 * Spec item status may be an object {maturity, implementation} — extract implementation.
 */
function normalizeStatus(status: unknown): string | null {
  if (typeof status === "string") return status;
  if (typeof status === "object" && status !== null) {
    const obj = status as Record<string, string>;
    return obj.implementation ?? obj.maturity ?? null;
  }
  return null;
}

/**
 * Build a lightweight ref index map for the index endpoint.
 * Includes both ULID and slug keys for each entity.
 *
 * AC: @ui-api-ref-resolution ac-4, ac-5
 */
export function buildRefIndex(index: ReferenceIndex): Record<string, RefIndexEntry> {
  const result: Record<string, RefIndexEntry> = {};

  for (const ulid of index.getAllUlids()) {
    const item = index.getByUlid(ulid);
    if (!item) continue;

    const typed = item as { title?: string; type?: string; status?: unknown; slugs?: string[] };
    if (!typed.title) continue;

    const normalizedStatus = normalizeStatus(typed.status);
    const entry: RefIndexEntry = {
      title: typed.title,
      type: typed.type ?? "unknown",
      ...(normalizedStatus ? { status: normalizedStatus } : {}),
    };

    // Index by ULID
    result[ulid] = entry;

    // Index by slugs
    if (typed.slugs) {
      for (const slug of typed.slugs) {
        result[slug] = entry;
      }
    }
  }

  return result;
}
