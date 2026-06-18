/**
 * Review record loading and operations.
 *
 * Review records are first-party top-level entities stored in
 * project.reviews.yaml with stable ULID-backed identity.
 *
 * AC: @review-record-storage-and-identity ac-1 - Dedicated first-party review storage
 * AC: @review-record-storage-and-identity ac-3 - Single dedicated file per project
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ulid } from "ulid";
import { withFileLock } from "./file-lock.js";
import {
  type ReviewRecord,
  type ReviewRecordInput,
  ReviewRecordSchema,
  ReviewRecordsFileSchema,
} from "../schema/index.js";
import { recordMutationEvents } from "../mutation-pipeline.js";
import type { KspecContext } from "./yaml.js";
import { readYamlFile, writeYamlFilePreserveFormat } from "./yaml.js";
import {
  assertReviewStorageCompatible,
  assertReviewStorageWritable,
} from "./entity-storage-compatibility.js";
import {
  deleteReviewFromFolder,
  loadReviewRecordsFromFolders,
  mutateReviewInFolder,
  saveReviewRecordToFolder,
} from "./review-storage-manager.js";

/**
 * Detect whether the project's manifest declares folder-backed review
 * storage. When this returns true, every review-storage entry point
 * routes through the folder-backed manager; otherwise it falls through
 * to the legacy monolithic implementation. The lenient compatibility
 * gate still fires on the monolithic path, so partial or incompatible
 * manifests raise the deterministic error codes rather than dual-reading
 * or silently migrating.
 *
 * AC: @folder-backed-review-storage-1 ac-review-detail-file-is-cohesive
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
function usesFolderStorage(ctx: KspecContext): boolean {
  return ctx.manifest?.review_storage?.format === "folder";
}

/**
 * Loaded review record with runtime metadata.
 * AC: @review-record-storage-and-identity ac-2 - ULID-backed identity
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

/**
 * Get the reviews file path.
 * AC: @review-record-storage-and-identity ac-3 - single dedicated file per project
 */
export function getReviewsFilePath(ctx: KspecContext): string {
  return path.join(ctx.specDir, "project.reviews.yaml");
}

/**
 * Parse review records from raw YAML payload.
 *
 * Supports the canonical { kynetic_reviews, reviews } shape and a fallback
 * { reviews } shape for older files without version metadata.
 */
function parseReviewsFromRaw(raw: unknown): ReviewRecord[] {
  const parsed = ReviewRecordsFileSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data.reviews;
  }

  if (raw && typeof raw === "object" && "reviews" in raw) {
    const fallbackReviews = (raw as { reviews?: unknown }).reviews;
    if (Array.isArray(fallbackReviews)) {
      const reviews: ReviewRecord[] = [];
      for (const review of fallbackReviews) {
        const reviewResult = ReviewRecordSchema.safeParse(review);
        if (reviewResult.success) {
          reviews.push(reviewResult.data);
        }
      }
      return reviews;
    }
  }

  return [];
}

/**
 * Load review records from an explicit file path.
 */
async function loadReviewsFromFile(reviewsPath: string): Promise<ReviewRecord[]> {
  const raw = await readYamlFile<unknown>(reviewsPath);
  return parseReviewsFromRaw(raw);
}

/**
 * Extract the raw review array and wrapper metadata from a YAML file.
 * Does NOT run schema validation — preserves original data for round-trip stability.
 */
async function extractRawReviewArray(
  filePath: string,
): Promise<{ rawReviews: unknown[]; wrapperObj?: Record<string, unknown> }> {
  let existingRaw: unknown = null;

  try {
    existingRaw = await readYamlFile<unknown>(filePath);
  } catch {
    // File doesn't exist
    return { rawReviews: [] };
  }

  if (!existingRaw || typeof existingRaw !== "object") {
    return { rawReviews: [] };
  }

  const wrapper = existingRaw as Record<string, unknown>;
  const reviews = wrapper.reviews;
  return {
    rawReviews: Array.isArray(reviews) ? reviews : [],
    wrapperObj: wrapper,
  };
}

/**
 * Write raw review array back to file, preserving wrapper metadata.
 */
async function writeRawReviewArray(
  filePath: string,
  rawReviews: unknown[],
  wrapperObj?: Record<string, unknown>,
): Promise<void> {
  const output = wrapperObj
    ? { ...wrapperObj, reviews: rawReviews }
    : { kynetic_reviews: "1.0", reviews: rawReviews };
  await writeYamlFilePreserveFormat(filePath, output);
}

/**
 * Find review index in a raw array by ULID match.
 */
function findRawReviewIndex(rawReviews: unknown[], reviewUlid: string): number {
  return rawReviews.findIndex(
    (r) => r && typeof r === "object" && (r as Record<string, unknown>)._ulid === reviewUlid,
  );
}

/**
 * Merge a schema-normalized review onto the original raw review data.
 * Only adds fields that were in the original raw data or that contain
 * non-default values. This prevents Zod defaults from polluting YAML
 * output with fields that weren't originally present.
 */
function mergeReviewPreservingRawShape(
  rawReview: Record<string, unknown>,
  normalizedReview: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(normalizedReview)) {
    if (key in rawReview) {
      // Field existed in raw — always include (even if value changed)
      result[key] = value;
    } else {
      // Field was added by schema normalization — only include if non-trivial
      const isEmptyArray = Array.isArray(value) && value.length === 0;
      const isNull = value === null || value === undefined;
      if (!isEmptyArray && !isNull) {
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Strip runtime metadata before serialization.
 */
function stripReviewMetadata(review: ReviewRecord | LoadedReviewRecord): ReviewRecord {
  const { _sourceFile, ...cleanReview } = review as LoadedReviewRecord;
  return cleanReview as ReviewRecord;
}

/**
 * Load all review records from the project.
 * AC: @review-record-storage-and-identity ac-1 - dedicated first-party review storage
 * AC: @review-record-storage-and-identity ac-3 - single dedicated file per project
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
export async function loadReviewRecords(ctx: KspecContext): Promise<LoadedReviewRecord[]> {
  if (usesFolderStorage(ctx)) {
    return loadReviewRecordsFromFolders(ctx);
  }
  await assertReviewStorageCompatible(ctx);
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

  const reviewsPath = getReviewsFilePath(ctx);

  try {
    const reviews = await loadReviewsFromFile(reviewsPath);
    return reviews.map((review) => ({
      ...review,
      _sourceFile: reviewsPath,
    }));
  } catch {
    // File doesn't exist or parse error
    return [];
  }
}

/**
 * Find a review record by reference (ULID, short ULID, or slug).
 * AC: @review-record-storage-and-identity ac-2 - addressable by @review ref
 */
export function findReviewByRef(
  reviews: LoadedReviewRecord[],
  ref: string,
): LoadedReviewRecord | undefined {
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;

  return reviews.find(
    (r) =>
      // Match full ULID
      r._ulid === cleanRef ||
      // Match short ULID (prefix)
      r._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
      // Match any slug
      r.slugs.includes(cleanRef),
  );
}

/**
 * Create a new review record from input.
 * AC: @review-record-storage-and-identity ac-2 - ULID-backed identity
 */
export function createReviewRecord(input: ReviewRecordInput): ReviewRecord {
  const now = new Date().toISOString();

  return {
    _ulid: input._ulid ?? ulid(),
    slugs: input.slugs ?? [],
    title: input.title,
    lifecycle_state: input.lifecycle_state ?? "draft",
    subject: input.subject,
    author: input.author,
    related_refs: input.related_refs ?? [],
    threads: input.threads ?? [],
    checks: input.checks ?? [],
    verdicts: input.verdicts ?? [],
    events: input.events ?? [],
    notes: input.notes ?? [],
    external_links: input.external_links ?? [],
    examined_commit: input.examined_commit ?? null,
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? null,
  };
}

/**
 * Save a single review record (create or update).
 * AC: @review-record-storage-and-identity ac-1 - dedicated first-party review storage
 * AC: @review-record-storage-and-identity ac-3 - single dedicated file per project
 * Uses file lock to prevent TOCTOU race on concurrent writes.
 */
export async function saveReviewRecord(
  ctx: KspecContext,
  review: LoadedReviewRecord,
): Promise<void> {
  if (usesFolderStorage(ctx)) {
    return saveReviewRecordToFolder(ctx, review);
  }
  await assertReviewStorageWritable(ctx);
  const reviewsPath = getReviewsFilePath(ctx);
  let created = false;

  // Lock the file to prevent concurrent read-modify-write races
  await withFileLock(reviewsPath, async () => {
    // Ensure directory exists
    const dir = path.dirname(reviewsPath);
    await fs.mkdir(dir, { recursive: true });

    // Load raw review data without schema normalization
    const { rawReviews, wrapperObj } = await extractRawReviewArray(reviewsPath);

    // Strip runtime metadata before saving
    const cleanReview = stripReviewMetadata(review);

    // Update existing or add new — replace only the target review
    const existingIndex = findRawReviewIndex(rawReviews, review._ulid);
    if (existingIndex >= 0) {
      // Merge onto raw data to avoid adding Zod defaults for absent fields
      const rawTarget = rawReviews[existingIndex] as Record<string, unknown>;
      rawReviews[existingIndex] = mergeReviewPreservingRawShape(
        rawTarget,
        cleanReview as Record<string, unknown>,
      );
    } else {
      rawReviews.push(cleanReview);
      created = true;
    }

    await writeRawReviewArray(reviewsPath, rawReviews, wrapperObj);
  });

  if (created) {
    recordReviewCreatedEvent(review);
  }
}

/**
 * Atomically mutate a review record using the latest on-disk state.
 *
 * The callback receives the current review value while holding the file lock,
 * so concurrent writers do not clobber unrelated fields.
 */
export async function mutateReviewAtomically(
  ctx: KspecContext,
  review: LoadedReviewRecord,
  mutate: (
    latestReview: LoadedReviewRecord,
  ) => ReviewRecord | LoadedReviewRecord | Promise<ReviewRecord | LoadedReviewRecord>,
): Promise<LoadedReviewRecord> {
  if (usesFolderStorage(ctx)) {
    return mutateReviewInFolder(ctx, review, mutate);
  }
  // Mutate-only operations update an existing review in place and require
  // that review to already exist in the monolithic file; they cannot
  // introduce a partial folder layout the way `saveReviewRecord`
  // (create-or-update) or `deleteReviewRecord` (orphan-folder maker) can.
  // The compatibility gate (lenient manifest + partial-layout detector) is
  // sufficient — applying the broader writable gate would block valid
  // updates under a consistent folder-backed layout. The strict
  // monolithic-write rule still applies to save/delete.
  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  await assertReviewStorageCompatible(ctx);
  const reviewsPath = review._sourceFile || getReviewsFilePath(ctx);
  let updatedReview: LoadedReviewRecord | undefined;

  await withFileLock(reviewsPath, async () => {
    // Ensure directory exists
    const dir = path.dirname(reviewsPath);
    await fs.mkdir(dir, { recursive: true });

    // Load raw review data without schema normalization for non-target reviews
    const { rawReviews, wrapperObj } = await extractRawReviewArray(reviewsPath);

    if (rawReviews.length === 0) {
      throw new Error(`Reviews file not found: ${reviewsPath}`);
    }

    const reviewIndex = findRawReviewIndex(rawReviews, review._ulid);
    if (reviewIndex === -1) {
      throw new Error(`Review not found in file: ${review._ulid}`);
    }

    // Schema-parse only the target review for the mutation callback
    const rawTarget = rawReviews[reviewIndex];
    const parsed = ReviewRecordSchema.safeParse(rawTarget);
    if (!parsed.success) {
      throw new Error(`Invalid review data for ${review._ulid}: ${parsed.error.message}`);
    }
    const latestReview: LoadedReviewRecord = {
      ...parsed.data,
      _sourceFile: reviewsPath,
    };

    const mutatedReview = await mutate(latestReview);
    const cleanMutatedReview = stripReviewMetadata(mutatedReview);

    // Merge onto raw data to avoid adding Zod defaults for absent fields
    rawReviews[reviewIndex] = mergeReviewPreservingRawShape(
      rawTarget as Record<string, unknown>,
      cleanMutatedReview as Record<string, unknown>,
    );

    await writeRawReviewArray(reviewsPath, rawReviews, wrapperObj);

    updatedReview = {
      ...cleanMutatedReview,
      _sourceFile: reviewsPath,
    };
  });

  if (!updatedReview) {
    throw new Error(`Failed to mutate review atomically: ${review._ulid}`);
  }

  return updatedReview;
}

/**
 * Delete a review record by ULID.
 */
export async function deleteReviewRecord(ctx: KspecContext, reviewUlid: string): Promise<boolean> {
  if (usesFolderStorage(ctx)) {
    return deleteReviewFromFolder(ctx, reviewUlid);
  }
  await assertReviewStorageWritable(ctx);
  const reviewsPath = getReviewsFilePath(ctx);

  return withFileLock(reviewsPath, async () => {
    try {
      // Load raw review data without schema normalization for round-trip stability
      const { rawReviews, wrapperObj } = await extractRawReviewArray(reviewsPath);

      const index = findRawReviewIndex(rawReviews, reviewUlid);
      if (index < 0) {
        return false;
      }

      rawReviews.splice(index, 1);

      await writeRawReviewArray(reviewsPath, rawReviews, wrapperObj);
      return true;
    } catch {
      return false;
    }
  });
}
