/**
 * Folder-backed entity trait foundation.
 *
 * Shared helpers and types for entities that adopt the folder-backed storage
 * shape: each entity owns a stable per-entity directory named by its full
 * ULID under that entity type's storage root; a lean index file contains
 * bounded identity/lifecycle/summary/relationship fields; unknown files in
 * entity directories are ignored by entity semantics and preserved across
 * writes; and the index can be regenerated from entity folders.
 *
 * This module defines the storage *shape* and the *plumbing* (path layout,
 * unknown-file preservation, bounded index projection, rebuild mechanics).
 * Entity-specific managers remain responsible for their own detail schema,
 * mutation routing, locking, and write coordination.
 *
 * Spec: @trait-folder-backed-entity-1
 */

import type { Dirent } from "node:fs";
import * as path from "node:path";
import { readdirBufferAware } from "../cli/batch-write-buffer.js";
import type { KspecContext } from "./yaml.js";
import { readYamlFile, writeYamlFile } from "./yaml.js";

// ── ULID Directory Naming ────────────────────────────────────────────────────

/**
 * Regex matching a full Crockford base32 ULID (exactly 26 characters, no
 * I/L/O/U). Folder-backed entities use directories named by this exact
 * pattern, so that listing/scanning operations can distinguish entity
 * directories from unknown sibling entries.
 *
 * AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
 */
export const ULID_DIRECTORY_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Test whether a directory entry name is a valid full ULID directory name.
 *
 * AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
 * AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
 */
export function isValidUlidDirName(name: string): boolean {
  return ULID_DIRECTORY_PATTERN.test(name);
}

// ── Layout Type ──────────────────────────────────────────────────────────────

/**
 * Describes the storage layout for one folder-backed entity type.
 *
 * Each entity type adopting the trait declares:
 * - `entityType`: short label used in diagnostics ("task", "plan", "review")
 * - `storageRoot`: directory name under specDir that owns this type's
 *   per-entity ULID directories (e.g. "tasks" → `<specDir>/tasks/`)
 * - `indexFile`: file name under specDir that holds the bounded index
 *   (e.g. "project.tasks.yaml" → `<specDir>/project.tasks.yaml`)
 * - `indexWrapperKey`: optional key for legacy wrapper format where the
 *   index is `{ <key>: [...] }` instead of a bare array. When present, the
 *   wrapper shape is preserved across reads/writes/rebuilds so unknown
 *   sibling keys round-trip.
 *
 * AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
 * AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
 */
export interface FolderBackedEntityLayout {
  readonly entityType: string;
  readonly storageRoot: string;
  readonly indexFile: string;
  readonly indexWrapperKey?: string;
}

// ── Path Helpers ─────────────────────────────────────────────────────────────

/**
 * Path to the storage root for this entity type (`<specDir>/<storageRoot>/`).
 *
 * AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
 */
export function getStorageRoot(ctx: KspecContext, layout: FolderBackedEntityLayout): string {
  return path.join(ctx.specDir, layout.storageRoot);
}

/**
 * Path to one entity's directory (`<specDir>/<storageRoot>/<ulid>/`).
 *
 * AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
 */
export function getEntityDir(
  ctx: KspecContext,
  layout: FolderBackedEntityLayout,
  ulid: string,
): string {
  return path.join(getStorageRoot(ctx, layout), ulid);
}

/**
 * Path to one named file within an entity's directory
 * (`<specDir>/<storageRoot>/<ulid>/<filename>`).
 */
export function getEntityFilePath(
  ctx: KspecContext,
  layout: FolderBackedEntityLayout,
  ulid: string,
  filename: string,
): string {
  return path.join(getEntityDir(ctx, layout, ulid), filename);
}

/**
 * Path to the bounded index file for this entity type
 * (`<specDir>/<indexFile>`).
 */
export function getEntityIndexPath(ctx: KspecContext, layout: FolderBackedEntityLayout): string {
  return path.join(ctx.specDir, layout.indexFile);
}

// ── Directory Listing ────────────────────────────────────────────────────────

/**
 * List all valid ULID-named subdirectories under the entity storage root.
 *
 * Buffer-aware so it works during in-flight batch transactions. Returns
 * the bare ULID directory names (not absolute paths). Entries that are
 * not directories, or whose names do not match the ULID pattern, are
 * silently ignored — those unknown entries are preserved on disk but do
 * not enter entity semantics.
 *
 * AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
 * AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
 */
export async function listEntityDirs(
  ctx: KspecContext,
  layout: FolderBackedEntityLayout,
): Promise<string[]> {
  const root = getStorageRoot(ctx, layout);
  try {
    const entries = (await readdirBufferAware(root, { withFileTypes: true })) as Dirent[];
    return entries
      .filter((entry) => entry.isDirectory() && isValidUlidDirName(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// ── Unknown-Field Preservation ───────────────────────────────────────────────

/**
 * Merge a schema-normalized entity onto its original raw on-disk shape,
 * preserving unknown fields so they round-trip through mutations.
 *
 * - Schema-known fields that are absent from `normalizedEntity` were
 *   intentionally cleared by the mutation and are NOT restored from
 *   `rawEntity`.
 * - Unknown fields (not present in `schemaKeys`) that are absent from
 *   `normalizedEntity` are carried forward from `rawEntity`, preserving
 *   forward-compatible extension fields written by future versions.
 * - Schema-known fields added by normalization with empty/null defaults
 *   are dropped to avoid polluting YAML output with vacuous defaults.
 *
 * AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
 */
export function mergePreservingRawShape(
  rawEntity: Record<string, unknown>,
  normalizedEntity: Record<string, unknown>,
  schemaKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawEntity)) {
    if (!(key in normalizedEntity) && !schemaKeys.has(key)) {
      result[key] = value;
    }
  }

  for (const [key, value] of Object.entries(normalizedEntity)) {
    if (key in rawEntity) {
      result[key] = value;
    } else {
      const isEmptyArray = Array.isArray(value) && value.length === 0;
      const isNullish = value === null || value === undefined;
      if (!isEmptyArray && !isNullish) {
        result[key] = value;
      }
    }
  }

  return result;
}

// ── Bounded Index Projection ─────────────────────────────────────────────────

/**
 * Test whether two raw index entries carry the same values across a given
 * set of indexed fields. Used by entity-specific managers to decide whether
 * a mutation has changed any indexed field (and therefore whether the
 * shared index file needs to be rewritten).
 *
 * Equality semantics:
 * - Primitive values use `===`.
 * - Both `undefined` is considered equal.
 * - Arrays compare element-wise with `===`.
 * - Other reference types compare by `===`.
 *
 * `indexedFields` defines the *bounded* set of fields the index commits to.
 * Detail bytes (full documents, notes, history, resource bytes) MUST NOT
 * appear in this list — the bounded projection is what keeps the index
 * cheap to load for listing, filtering, cache warm-up, and dashboard
 * summary surfaces.
 *
 * AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
 */
export function indexEntriesEqualForFields(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  indexedFields: readonly string[],
): boolean {
  for (const field of indexedFields) {
    const va = a[field];
    const vb = b[field];

    if (va === vb) continue;
    if (va === undefined && vb === undefined) continue;

    if (Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length) return false;
      for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) return false;
      }
      continue;
    }

    return false;
  }
  return true;
}

/**
 * Shape of a parsed index file: either a bare array of entries, or a
 * wrapper object with the entry array under a named key (e.g. `{ tasks: [...] }`).
 */
export interface IndexFileShape {
  /** The list of raw index entries (may be empty). */
  entries: unknown[];
  /** True when the file uses the wrapper format and the named key was found. */
  useWrapper: boolean;
  /** The complete wrapper object as read from disk, for sibling-key preservation. */
  wrapperObj?: Record<string, unknown>;
}

/**
 * Read the bounded index file and return its raw entries plus the
 * wrapper shape used on disk.
 *
 * - Bare array: returns `{ entries: [...], useWrapper: false }`
 * - Wrapper object `{ <key>: [...] }`: returns
 *   `{ entries: [...], useWrapper: true, wrapperObj }`. Sibling keys on the
 *   wrapper survive subsequent `writeIndexEntries` so unknown extension
 *   data round-trips.
 * - Missing file or unparseable contents: returns
 *   `{ entries: [], useWrapper: false }`.
 *
 * AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
 */
export async function readIndexEntries(
  indexPath: string,
  wrapperKey?: string,
): Promise<IndexFileShape> {
  let raw: unknown;
  try {
    raw = await readYamlFile<unknown>(indexPath);
  } catch {
    return { entries: [], useWrapper: false };
  }

  if (Array.isArray(raw)) {
    return { entries: raw, useWrapper: false };
  }

  if (wrapperKey && raw && typeof raw === "object" && wrapperKey in raw) {
    const wrapperObj = raw as Record<string, unknown>;
    const list = wrapperObj[wrapperKey];
    return {
      entries: Array.isArray(list) ? [...list] : [],
      useWrapper: true,
      wrapperObj,
    };
  }

  return { entries: [], useWrapper: false };
}

/**
 * Write the bounded index file, preserving the on-disk wrapper shape.
 *
 * When `useWrapper && wrapperObj && wrapperKey` are present, the wrapper
 * object is rewritten with the new entries under `wrapperKey` and any
 * other sibling keys preserved verbatim. Otherwise, a bare entry array
 * is written.
 *
 * AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
 * AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
 */
export async function writeIndexEntries(
  indexPath: string,
  entries: unknown[],
  shape: IndexFileShape,
  wrapperKey?: string,
): Promise<void> {
  if (shape.useWrapper && shape.wrapperObj && wrapperKey) {
    await writeYamlFile(indexPath, { ...shape.wrapperObj, [wrapperKey]: entries });
  } else {
    await writeYamlFile(indexPath, entries);
  }
}

// ── Index Rebuild Mechanics ──────────────────────────────────────────────────

/**
 * Callbacks supplied by an entity-specific manager when rebuilding its
 * bounded index from authoritative folder contents.
 *
 * `loadEntity` reads one ULID directory and returns the entity record (or
 * `undefined` to skip — e.g. if the folder is corrupt or has no entity
 * core file). `projectToIndexEntry` projects a loaded entity to the
 * bounded index shape that gets persisted in the index file.
 */
export interface RebuildIndexOptions<TLoaded> {
  loadEntity(ctx: KspecContext, ulid: string): Promise<TLoaded | undefined>;
  projectToIndexEntry(entity: TLoaded): Record<string, unknown>;
}

/**
 * Rebuild a folder-backed entity index from authoritative folder contents.
 *
 * Lists all valid ULID directories under the storage root, loads each
 * entity via `options.loadEntity`, projects to the bounded index shape
 * via `options.projectToIndexEntry`, and writes the index file —
 * preserving any wrapper shape detected on disk so sibling extension
 * data round-trips.
 *
 * Returns the number of entries written. Callers that need locking,
 * batch buffering, or cache invalidation around the rebuild can wrap
 * this function in their own coordination.
 *
 * AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
 * AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
 */
export async function rebuildEntityIndex<TLoaded>(
  ctx: KspecContext,
  layout: FolderBackedEntityLayout,
  options: RebuildIndexOptions<TLoaded>,
): Promise<{ count: number }> {
  const ulids = await listEntityDirs(ctx, layout);
  const projectedEntries: Record<string, unknown>[] = [];

  for (const ulid of ulids) {
    const entity = await options.loadEntity(ctx, ulid);
    if (entity) {
      projectedEntries.push(options.projectToIndexEntry(entity));
    }
  }

  const indexPath = getEntityIndexPath(ctx, layout);
  const shape = await readIndexEntries(indexPath, layout.indexWrapperKey);

  await writeIndexEntries(indexPath, projectedEntries, shape, layout.indexWrapperKey);

  return { count: projectedEntries.length };
}
