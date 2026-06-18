/**
 * Folder-backed review storage manager.
 *
 * Reviews are stored as folder-backed entities under
 * `<specDir>/reviews/<review-ulid>/`:
 *
 *   review.yaml     — authoritative cohesive review detail record:
 *                     identity, lifecycle, subject, related refs, threads,
 *                     checks, verdicts, events, notes, external links, and
 *                     timestamps. This first folder slice keeps the full
 *                     structured ReviewRecord cohesive and does NOT split
 *                     threads/checks/verdicts/notes/events/external_links
 *                     into separate sidecars.
 *   resources.yaml  — optional resource manifest (owned by the
 *                     entity-scoped local resources trait)
 *   resources/      — optional local resource files (e.g. screenshots,
 *                     logs, evidence)
 *
 * The lean index at `<specDir>/project.reviews.yaml` carries a bounded
 * projection of each review's identity, lifecycle, subject summary,
 * related refs, author, timestamps, examined commit, external links,
 * disposition, and counts — never full threads/checks/verdicts/events/
 * notes, and never resource file bytes.
 *
 * Spec: @folder-backed-review-storage-1
 *       @trait-folder-backed-entity-1
 *       @trait-entity-scoped-local-resources-1
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ReviewRecord } from "../schema/index.js";
import { ReviewRecordSchema } from "../schema/index.js";
import {
  getActiveBatchBuffer,
  mkdirBufferAware,
  runWithBuffer,
  writeFileBufferAware,
} from "../cli/batch-write-buffer.js";
import {
  describeStrictManifestIncompatibility,
  requireReviewFolderStorage,
} from "./entity-storage-compatibility.js";
import { withFileLock } from "./file-lock.js";
import {
  type FolderBackedEntityLayout,
  arraysSemanticallyEqual,
  objectsStructurallyEqual,
  getEntityDir,
  getEntityFilePath,
  getEntityIndexPath,
  indexEntriesEqualForFields,
  listEntityDirs,
  mergePreservingRawShape,
  readIndexEntries,
  writeIndexEntries,
} from "./folder-backed-entity.js";
import { computeDisposition } from "./review-operations.js";
import { getUnresolvedBlockers } from "./review-threads.js";
import type { KspecContext } from "./yaml.js";
import { readYamlFile, toYaml } from "./yaml.js";
import { recordMutationEvents } from "../mutation-pipeline.js";

/**
 * Loaded review record with runtime metadata. Matches the shape exposed by
 * the monolithic parser so consumer code can switch backends transparently.
 */
export interface LoadedReviewRecord extends ReviewRecord {
  _sourceFile?: string;
}

function reviewSubjectRef(review: ReviewRecord): string | null {
  const maybeRef = (review.subject as { ref?: unknown }).ref;
  return typeof maybeRef === "string" ? maybeRef : null;
}

function recordReviewCreatedEvent(review: ReviewRecord): void {
  recordMutationEvents([
    {
      topic: "reviews:updates",
      event: "review_created",
      data: {
        review_ulid: review._ulid,
        title: review.title,
        subject_type: review.subject.type,
        subject_ref: reviewSubjectRef(review),
      },
    },
  ]);
}

// ── Layout ────────────────────────────────────────────────────────────────────

/**
 * Review storage layout — `<specDir>/reviews/<review-ulid>/...` with a lean
 * index at `<specDir>/project.reviews.yaml`. The wrapper key `reviews` is
 * preserved across read/write so the canonical `{ kynetic_reviews, reviews }`
 * shape round-trips.
 *
 * AC: @folder-backed-review-storage-1 ac-review-detail-file-is-cohesive
 * AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
 */
export const REVIEW_LAYOUT: FolderBackedEntityLayout = {
  entityType: "review",
  storageRoot: "reviews",
  indexFile: "project.reviews.yaml",
  indexWrapperKey: "reviews",
};

/** Filename for the per-review cohesive detail record. */
export const REVIEW_DETAIL_FILENAME = "review.yaml";
/** Filename for the per-review resource manifest sidecar. */
export const REVIEW_RESOURCES_MANIFEST_FILENAME = "resources.yaml";
/** Directory name for per-review resource files. */
export const REVIEW_RESOURCES_DIR = "resources";

// ── Path Helpers ─────────────────────────────────────────────────────────────

/** Directory for a single review (`<specDir>/reviews/<ulid>/`). */
export function getReviewDir(ctx: KspecContext, ulid: string): string {
  return getEntityDir(ctx, REVIEW_LAYOUT, ulid);
}

/**
 * Path to a review's cohesive detail file (`<specDir>/reviews/<ulid>/review.yaml`).
 *
 * AC: @folder-backed-review-storage-1 ac-review-detail-file-is-cohesive
 */
export function getReviewDetailFilePath(ctx: KspecContext, ulid: string): string {
  return getEntityFilePath(ctx, REVIEW_LAYOUT, ulid, REVIEW_DETAIL_FILENAME);
}

/** Path to a review's lean index file (`<specDir>/project.reviews.yaml`). */
export function getReviewIndexFilePath(ctx: KspecContext): string {
  return getEntityIndexPath(ctx, REVIEW_LAYOUT);
}

// ── Index Projection ─────────────────────────────────────────────────────────

/**
 * Resource summary projected into the lean index — bounded counts only,
 * never resource file bytes or preview content.
 *
 * AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export interface ReviewResourceSummary {
  count: number;
  total_bytes: number;
}

/**
 * Bounded set of indexed fields. These are the only fields that survive into
 * `project.reviews.yaml`. Full threads, checks, verdicts, events, and notes
 * are explicitly excluded — only their counts and the aggregate disposition
 * live in the index.
 *
 * AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
 * AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
 */
const INDEXED_FIELDS = [
  "_ulid",
  "slugs",
  "title",
  "lifecycle_state",
  "author",
  "subject",
  "related_refs",
  "external_links",
  "created_at",
  "updated_at",
  "examined_commit",
  "disposition",
  "thread_count",
  "unresolved_blocker_count",
  "check_count",
  "verdict_count",
  "resource_summary",
] as const;

/**
 * Compute a resource summary from a review's `resources.yaml` sidecar
 * without reading any resource file bytes. Returns `undefined` when the
 * manifest is absent so the index entry omits the field instead of
 * carrying empty data.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 * AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
 */
async function readResourceSummary(
  ctx: KspecContext,
  ulid: string,
): Promise<ReviewResourceSummary | undefined> {
  const manifestPath = path.join(getReviewDir(ctx, ulid), REVIEW_RESOURCES_MANIFEST_FILENAME);
  let raw: unknown;
  try {
    raw = await readYamlFile<unknown>(manifestPath);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") {
    return { count: 0, total_bytes: 0 };
  }
  const resources = (raw as Record<string, unknown>).resources;
  if (!Array.isArray(resources)) {
    return { count: 0, total_bytes: 0 };
  }
  let total = 0;
  for (const entry of resources) {
    if (entry && typeof entry === "object") {
      const bytes = (entry as Record<string, unknown>).bytes;
      if (typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0) {
        total += bytes;
      }
    }
  }
  return { count: resources.length, total_bytes: total };
}

/**
 * Project a loaded review to its index entry. Optional/empty fields are
 * omitted (rather than emitted as `null`/`[]`) so the YAML index stays
 * compact and round-trips without spurious diff churn.
 *
 * Disposition, thread count, unresolved-blocker count, check count, and
 * verdict count are pre-computed from the full record so list/dashboard
 * surfaces never need to load the per-review detail file just to display
 * an aggregate signal.
 *
 * AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
 * AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
 */
export function toIndexEntry(
  review: ReviewRecord,
  resourceSummary?: ReviewResourceSummary,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    _ulid: review._ulid,
    slugs: review.slugs,
    title: review.title,
    lifecycle_state: review.lifecycle_state,
    author: review.author,
    subject: review.subject,
    related_refs: review.related_refs,
    created_at: review.created_at,
    disposition: computeDisposition(review),
    thread_count: Array.isArray(review.threads) ? review.threads.length : 0,
    unresolved_blocker_count: getUnresolvedBlockers(review).length,
    check_count: Array.isArray(review.checks) ? review.checks.length : 0,
    verdict_count: Array.isArray(review.verdicts) ? review.verdicts.length : 0,
  };

  if (review.updated_at !== undefined && review.updated_at !== null) {
    entry.updated_at = review.updated_at;
  }
  if (review.examined_commit !== undefined && review.examined_commit !== null) {
    entry.examined_commit = review.examined_commit;
  }
  if (Array.isArray(review.external_links) && review.external_links.length > 0) {
    entry.external_links = review.external_links;
  }
  if (resourceSummary) {
    entry.resource_summary = { ...resourceSummary };
  }

  return entry;
}

/**
 * Compare two index entries for equality on the bounded indexed-field set.
 *
 * AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
 * AC: @trait-folder-backed-entity-1 ac-semantic-defaults-do-not-drift
 */
export function indexEntriesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const scalarFields = INDEXED_FIELDS.filter(
    (f) => f !== "resource_summary" && f !== "subject" && f !== "external_links",
  );
  if (!indexEntriesEqualForFields(a, b, scalarFields)) {
    return false;
  }
  // subject and external_links are nested objects/arrays — JSON-compare so
  // any field change in the subject discriminator or external links triggers
  // an index rewrite. external_links uses arraysSemanticallyEqual so that
  // an omitted entry and an explicit `[]` round-trip without surfacing
  // spurious drift.
  // AC: @trait-folder-backed-entity-1 ac-semantic-defaults-do-not-drift
  // subject is a discriminated-union object — compare structurally with
  // canonical key ordering so a migrated index entry (key order from the
  // legacy monolithic source) and a rebuilt entry (key order from the
  // schema-shaped projection) compare equal when they describe the same
  // state.
  // AC: @trait-folder-backed-entity-1 ac-semantic-defaults-do-not-drift
  if (!objectsStructurallyEqual(a.subject, b.subject)) return false;
  if (!arraysSemanticallyEqual(a.external_links, b.external_links)) {
    return false;
  }
  // resource_summary uses semantic-default equality so an omitted summary
  // (the canonical bounded-projection shape for a resourceless review) and
  // an explicit `{count:0, total_bytes:0}` describe the same empty state.
  // Migration emits the omitted form; rebuild emits the zero-summary form;
  // both round-trip without spurious drift.
  return resourceSummariesEqual(
    a.resource_summary as ReviewResourceSummary | undefined,
    b.resource_summary as ReviewResourceSummary | undefined,
  );
}

function isEmptyResourceSummary(s: ReviewResourceSummary | undefined): boolean {
  return s === undefined || (s.count === 0 && s.total_bytes === 0);
}

function resourceSummariesEqual(
  a: ReviewResourceSummary | undefined,
  b: ReviewResourceSummary | undefined,
): boolean {
  if (isEmptyResourceSummary(a) && isEmptyResourceSummary(b)) return true;
  if (a === undefined || b === undefined) return false;
  return a.count === b.count && a.total_bytes === b.total_bytes;
}

// ── Detail File Helpers ─────────────────────────────────────────────────────

const REVIEW_SCHEMA_KEYS: ReadonlySet<string> = new Set(Object.keys(ReviewRecordSchema.shape));

/**
 * Strip runtime metadata from a loaded record before persisting.
 */
function toDetailRecord(review: LoadedReviewRecord): Record<string, unknown> {
  const { _sourceFile: _sf, ...detail } = review;
  return detail as Record<string, unknown>;
}

/**
 * Read the raw detail object (no schema validation) so mutation helpers can
 * preserve forward-compatible extension fields.
 */
async function readRawDetail(
  ctx: KspecContext,
  ulid: string,
): Promise<Record<string, unknown> | null> {
  const detailPath = getReviewDetailFilePath(ctx, ulid);
  try {
    const raw = await readYamlFile<unknown>(detailPath);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch {
    // missing
  }
  return null;
}

/**
 * Assemble a `LoadedReviewRecord` from its detail sidecar. Returns
 * `undefined` when the file is missing or schema-invalid so callers can
 * drop the entry from listings rather than surfacing partial data.
 *
 * AC: @folder-backed-review-storage-1 ac-review-detail-file-is-cohesive
 */
async function loadReviewFromDir(
  ctx: KspecContext,
  ulid: string,
): Promise<LoadedReviewRecord | undefined> {
  const rawDetail = await readRawDetail(ctx, ulid);
  if (!rawDetail) {
    return undefined;
  }
  const parsed = ReviewRecordSchema.safeParse(rawDetail);
  if (!parsed.success) {
    return undefined;
  }
  return { ...parsed.data, _sourceFile: getReviewDetailFilePath(ctx, ulid) };
}

/** Write `review.yaml`, preserving unknown extension fields. */
async function writeDetailFile(
  filePath: string,
  detail: Record<string, unknown>,
  rawDetail: Record<string, unknown> | null,
): Promise<void> {
  const merged = rawDetail
    ? mergePreservingRawShape(rawDetail, detail, REVIEW_SCHEMA_KEYS)
    : detail;
  await writeFileBufferAware(filePath, toYaml(merged));
}

// ── Public Manager API ──────────────────────────────────────────────────────

/**
 * List all reviews by reading from per-review detail files. The cache (if
 * present and ready) is consulted first so the daemon can serve list/detail
 * surfaces without a disk read on hot paths.
 *
 * AC: @folder-backed-review-storage-1 ac-review-detail-file-is-cohesive
 */
export async function loadReviewRecordsFromFolders(
  ctx: KspecContext,
): Promise<LoadedReviewRecord[]> {
  await requireReviewFolderStorage(ctx);

  const { getEntityCacheContext } = await import("./yaml.js");
  const cacheContext = getEntityCacheContext();
  if (cacheContext) {
    const cache = cacheContext.cacheAccessor(cacheContext.projectPath) as
      | {
          getDomainState?(domain: string): string | null | undefined;
          getReviewsIndex?(): Array<{ _ulid: string }> | null;
          getReviewDetail?(ulid: string): LoadedReviewRecord | null;
        }
      | null
      | undefined;
    if (cache?.getDomainState?.("reviews") === "ready") {
      const reviewIndex = cache.getReviewsIndex?.();
      if (reviewIndex) {
        const cachedReviews = reviewIndex
          .map((review) => cache.getReviewDetail?.(review._ulid) ?? null)
          .filter((review): review is LoadedReviewRecord => review !== null);
        if (cachedReviews.length === reviewIndex.length) {
          return cachedReviews;
        }
      }
    }
  }

  const ulids = await listEntityDirs(ctx, REVIEW_LAYOUT);
  const reviews: LoadedReviewRecord[] = [];
  for (const ulid of ulids) {
    const review = await loadReviewFromDir(ctx, ulid);
    if (review) {
      reviews.push(review);
    }
  }
  return reviews;
}

/**
 * Resolve a review by ULID, short ULID, or slug. Matches the monolithic
 * loader's semantics so callers do not need to know which backend served
 * the lookup.
 */
export async function findReviewByRefInFolders(
  ctx: KspecContext,
  ref: string,
): Promise<LoadedReviewRecord | undefined> {
  const reviews = await loadReviewRecordsFromFolders(ctx);
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;
  return reviews.find(
    (r) =>
      r._ulid === cleanRef ||
      r._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
      r.slugs.includes(cleanRef),
  );
}

/**
 * Create or update a single review. The cohesive detail record is written
 * to `review.yaml`, and the lean index entry is upserted into
 * `project.reviews.yaml`. All writes happen inside a single buffered
 * transaction so partial states cannot reach disk if any step fails.
 *
 * AC: @folder-backed-review-storage-1 ac-review-detail-file-is-cohesive
 * AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
 */
export async function saveReviewRecordToFolder(
  ctx: KspecContext,
  review: LoadedReviewRecord,
): Promise<void> {
  await requireReviewFolderStorage(ctx);

  const reviewDir = getReviewDir(ctx, review._ulid);
  const detailPath = getReviewDetailFilePath(ctx, review._ulid);
  const indexPath = getReviewIndexFilePath(ctx);
  let created = false;

  await withFileLock(indexPath, async () => {
    await runWithBuffer(ctx.specDir, async () => {
      await mkdirBufferAware(reviewDir);

      const rawDetail = await readRawDetail(ctx, review._ulid);
      created = rawDetail === null;
      const detail = toDetailRecord(review);
      await writeDetailFile(detailPath, detail, rawDetail);

      const resourceSummary = await readResourceSummary(ctx, review._ulid);
      const entry = toIndexEntry(review, resourceSummary);
      await upsertIndexEntry(indexPath, entry);
    });
  });

  if (created) {
    recordReviewCreatedEvent(review);
  }
}

/**
 * Atomically mutate an existing review. The callback receives the latest
 * on-disk state (so concurrent writers do not clobber unrelated fields)
 * and returns the desired post-mutation review; the manager handles the
 * detail rewrite and the bounded index update.
 *
 * AC: @folder-backed-review-storage-1 ac-review-detail-file-is-cohesive
 */
export async function mutateReviewInFolder(
  ctx: KspecContext,
  review: LoadedReviewRecord,
  mutate: (
    latestReview: LoadedReviewRecord,
  ) => ReviewRecord | LoadedReviewRecord | Promise<ReviewRecord | LoadedReviewRecord>,
): Promise<LoadedReviewRecord> {
  await requireReviewFolderStorage(ctx);

  const detailPath = getReviewDetailFilePath(ctx, review._ulid);
  const indexPath = getReviewIndexFilePath(ctx);

  let result: LoadedReviewRecord | undefined;
  await withFileLock(indexPath, async () => {
    const latest = await loadReviewFromDir(ctx, review._ulid);
    if (!latest) {
      throw new Error(`Review not found in folder storage: ${review._ulid}`);
    }

    const mutated = await mutate(latest);
    if (mutated._ulid !== latest._ulid) {
      throw new Error(
        `Mutation must not change a review's ULID. Original: ${latest._ulid}, received: ${mutated._ulid}`,
      );
    }
    const clean: LoadedReviewRecord = { ...(mutated as LoadedReviewRecord) };
    delete clean._sourceFile;

    await runWithBuffer(ctx.specDir, async () => {
      const rawDetail = await readRawDetail(ctx, review._ulid);
      const detail = toDetailRecord(clean);
      await writeDetailFile(detailPath, detail, rawDetail);

      const oldSummary = await readResourceSummary(ctx, review._ulid);
      const oldEntry = toIndexEntry(latest, oldSummary);
      const newSummary = await readResourceSummary(ctx, review._ulid);
      const newEntry = toIndexEntry(clean, newSummary);
      if (!indexEntriesEqual(oldEntry, newEntry)) {
        await upsertIndexEntry(indexPath, newEntry);
      }
    });

    result = { ...clean, _sourceFile: detailPath };
  });

  if (!result) {
    throw new Error(`Failed to mutate review atomically: ${review._ulid}`);
  }
  return result;
}

/**
 * Remove a review: delete its directory (and everything underneath it,
 * including owned resource files) and its index entry in one logical
 * shadow mutation. Returns `true` when a review was deleted, `false`
 * when the review was not found — matching the boolean return contract
 * of the monolithic deleteReviewRecord so existing callers do not change.
 *
 * AC: @folder-backed-review-storage-1 ac-review-delete-removes-owned-folder
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
 */
export async function deleteReviewFromFolder(ctx: KspecContext, ulid: string): Promise<boolean> {
  await requireReviewFolderStorage(ctx);

  const reviewDir = getReviewDir(ctx, ulid);
  const indexPath = getReviewIndexFilePath(ctx);

  try {
    await fs.access(reviewDir);
  } catch {
    return false;
  }

  await withFileLock(indexPath, async () => {
    await runWithBuffer(ctx.specDir, async () => {
      const buffer = getActiveBatchBuffer();
      if (buffer) {
        buffer.deleteDirectory(reviewDir);
      } else {
        await fs.rm(reviewDir, { recursive: true, force: true });
      }
      await removeFromIndex(indexPath, ulid);
    });
  });
  return true;
}

// ── Index Mutation Helpers ───────────────────────────────────────────────────

/**
 * Insert or replace a review's entry in the lean index, preserving the
 * on-disk wrapper shape so sibling keys (e.g. `kynetic_reviews` version)
 * survive.
 *
 * AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
 */
async function upsertIndexEntry(indexPath: string, entry: Record<string, unknown>): Promise<void> {
  const shape = await readIndexEntries(indexPath, REVIEW_LAYOUT.indexWrapperKey);
  const updated = [...shape.entries];
  const existing = updated.findIndex(
    (e) => e && typeof e === "object" && (e as Record<string, unknown>)._ulid === entry._ulid,
  );
  if (existing >= 0) {
    updated[existing] = entry;
  } else {
    updated.push(entry);
  }
  const shapeWithWrapper =
    shape.useWrapper || shape.wrapperObj
      ? shape
      : { entries: shape.entries, useWrapper: true, wrapperObj: { kynetic_reviews: "1.0" } };
  await writeIndexEntries(indexPath, updated, shapeWithWrapper, REVIEW_LAYOUT.indexWrapperKey);
}

/** Remove a review's index entry; preserves the wrapper shape. */
async function removeFromIndex(indexPath: string, ulid: string): Promise<void> {
  const shape = await readIndexEntries(indexPath, REVIEW_LAYOUT.indexWrapperKey);
  if (shape.entries.length === 0 && !shape.useWrapper) {
    return;
  }
  const filtered = shape.entries.filter(
    (e) => !(e && typeof e === "object" && (e as Record<string, unknown>)._ulid === ulid),
  );
  await writeIndexEntries(indexPath, filtered, shape, REVIEW_LAYOUT.indexWrapperKey);
}

// ── Index Rebuild ────────────────────────────────────────────────────────────

/**
 * Describes a single change relative to the on-disk index.
 *
 * - `add`        — a review folder exists but the index has no matching entry
 * - `update`     — the folder and index entry differ on at least one
 *                  indexed field
 * - `remove_stale` — an index entry has no matching review folder; safe to
 *                  drop only when the caller explicitly requested `--force`
 */
export type ReviewIndexChange = {
  kind: "add" | "update" | "remove_stale";
  ref: string;
  path: string;
};

/**
 * Description of a non-recoverable conflict surfaced by `rebuild-index`.
 *
 * Stale entries without `--force` are reported with code
 * `stale_index_entry_without_force`; folders that fail to load are
 * reported with code `unloadable_review_folder`.
 */
export type ReviewIndexConflict = {
  code: string;
  ref: string | null;
  path: string | null;
  message: string;
};

export interface ReviewRebuildReport {
  changes: ReviewIndexChange[];
  conflicts: ReviewIndexConflict[];
  folders: number;
  indexEntries: number;
  added: number;
  updated: number;
  removedStale: number;
}

/**
 * Compute the drift between the lean index and the per-review folders
 * without touching disk beyond reads. Pure projection — callers decide
 * whether to surface, repair, or block based on the report and CLI flags.
 *
 * AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
 * AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
 */
export async function computeReviewIndexDrift(
  ctx: KspecContext,
  options: { force?: boolean } = {},
): Promise<ReviewRebuildReport> {
  // Manifest-only check — drift detection runs *because* the layout may be
  // partial; running the partial-layout gate here would defeat the purpose
  // of the rebuild-index path.
  const manifestErr = describeStrictManifestIncompatibility(ctx.manifest, "reviews");
  if (manifestErr) throw manifestErr;

  const indexPath = getReviewIndexFilePath(ctx);
  const shape = await readIndexEntries(indexPath, REVIEW_LAYOUT.indexWrapperKey);
  const indexByUlid = new Map<string, Record<string, unknown>>();
  for (const entry of shape.entries) {
    if (entry && typeof entry === "object") {
      const id = (entry as Record<string, unknown>)._ulid;
      if (typeof id === "string" && id.length > 0) {
        indexByUlid.set(id, entry as Record<string, unknown>);
      }
    }
  }

  const folderUlids = await listEntityDirs(ctx, REVIEW_LAYOUT);
  const folderSet = new Set(folderUlids);

  const changes: ReviewIndexChange[] = [];
  const conflicts: ReviewIndexConflict[] = [];

  for (const ulid of folderUlids) {
    const reviewDir = getReviewDir(ctx, ulid);
    const review = await loadReviewFromDir(ctx, ulid);
    if (!review) {
      conflicts.push({
        code: "unloadable_review_folder",
        ref: ulid,
        path: reviewDir,
        message: `Review folder ${ulid} could not be loaded (missing or invalid review.yaml).`,
      });
      continue;
    }
    const summary = await readResourceSummary(ctx, ulid);
    const rebuiltEntry = toIndexEntry(review, summary);
    const existingEntry = indexByUlid.get(ulid);
    if (!existingEntry) {
      changes.push({ kind: "add", ref: ulid, path: reviewDir });
    } else if (!indexEntriesEqual(existingEntry, rebuiltEntry)) {
      changes.push({ kind: "update", ref: ulid, path: reviewDir });
    }
  }

  for (const [ulid, _entry] of indexByUlid) {
    if (!folderSet.has(ulid)) {
      const reviewDir = getReviewDir(ctx, ulid);
      if (options.force) {
        changes.push({ kind: "remove_stale", ref: ulid, path: reviewDir });
      } else {
        conflicts.push({
          code: "stale_index_entry_without_force",
          ref: ulid,
          path: reviewDir,
          message: `Index entry ${ulid} has no matching review folder. Re-run with --force to drop stale entries.`,
        });
      }
    }
  }

  const added = changes.filter((c) => c.kind === "add").length;
  const updated = changes.filter((c) => c.kind === "update").length;
  const removedStale = changes.filter((c) => c.kind === "remove_stale").length;

  return {
    changes,
    conflicts,
    folders: folderUlids.length,
    indexEntries: indexByUlid.size,
    added,
    updated,
    removedStale,
  };
}

/**
 * Rewrite the lean index from per-review folders. Used by
 * `kspec review rebuild-index --repair`. Stale entries are dropped only
 * when `options.force` is true; without it, `computeReviewIndexDrift`
 * would have surfaced a conflict and the caller should refuse to call
 * this.
 *
 * AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
 */
export async function rebuildReviewIndex(
  ctx: KspecContext,
  options: { force?: boolean } = {},
): Promise<{ count: number }> {
  const manifestErr = describeStrictManifestIncompatibility(ctx.manifest, "reviews");
  if (manifestErr) throw manifestErr;
  const indexPath = getReviewIndexFilePath(ctx);

  return await withFileLock(indexPath, async () => {
    const shape = await readIndexEntries(indexPath, REVIEW_LAYOUT.indexWrapperKey);
    const indexByUlid = new Map<string, Record<string, unknown>>();
    for (const entry of shape.entries) {
      if (entry && typeof entry === "object") {
        const id = (entry as Record<string, unknown>)._ulid;
        if (typeof id === "string" && id.length > 0) {
          indexByUlid.set(id, entry as Record<string, unknown>);
        }
      }
    }

    const folderUlids = await listEntityDirs(ctx, REVIEW_LAYOUT);
    const folderSet = new Set(folderUlids);

    for (const ulid of folderUlids) {
      const review = await loadReviewFromDir(ctx, ulid);
      if (!review) continue;
      const summary = await readResourceSummary(ctx, ulid);
      indexByUlid.set(ulid, toIndexEntry(review, summary));
    }

    if (options.force) {
      // Drop stale entries whose folders no longer exist.
      for (const ulid of indexByUlid.keys()) {
        if (!folderSet.has(ulid)) {
          indexByUlid.delete(ulid);
        }
      }
    }

    const updated = [...indexByUlid.values()];
    const shapeWithWrapper =
      shape.useWrapper || shape.wrapperObj
        ? shape
        : { entries: shape.entries, useWrapper: true, wrapperObj: { kynetic_reviews: "1.0" } };
    await writeIndexEntries(indexPath, updated, shapeWithWrapper, REVIEW_LAYOUT.indexWrapperKey);
    return { count: updated.length };
  });
}
