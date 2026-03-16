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
  type ReviewRecordsFile,
  ReviewRecordsFileSchema,
} from "../schema/index.js";
import type { KspecContext } from "./yaml.js";
import { readYamlFile, writeYamlFilePreserveFormat } from "./yaml.js";

/**
 * Loaded review record with runtime metadata.
 * AC: @review-record-storage-and-identity ac-2 - ULID-backed identity
 */
export interface LoadedReviewRecord extends ReviewRecord {
  _sourceFile?: string;
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
async function loadReviewsFromFile(
  reviewsPath: string,
): Promise<ReviewRecord[]> {
  const raw = await readYamlFile<unknown>(reviewsPath);
  return parseReviewsFromRaw(raw);
}

/**
 * Strip runtime metadata before serialization.
 */
function stripReviewMetadata(
  review: ReviewRecord | LoadedReviewRecord,
): ReviewRecord {
  const { _sourceFile, ...cleanReview } = review as LoadedReviewRecord;
  return cleanReview as ReviewRecord;
}

/**
 * Load all review records from the project.
 * AC: @review-record-storage-and-identity ac-1 - dedicated first-party review storage
 * AC: @review-record-storage-and-identity ac-3 - single dedicated file per project
 */
export async function loadReviewRecords(
  ctx: KspecContext,
): Promise<LoadedReviewRecord[]> {
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
  const reviewsPath = getReviewsFilePath(ctx);

  // Lock the file to prevent concurrent read-modify-write races
  await withFileLock(reviewsPath, async () => {
    // Ensure directory exists
    const dir = path.dirname(reviewsPath);
    await fs.mkdir(dir, { recursive: true });

    // Load existing reviews (inside lock to prevent TOCTOU)
    let reviews: ReviewRecord[] = [];
    try {
      reviews = await loadReviewsFromFile(reviewsPath);
    } catch {
      // File doesn't exist yet, start fresh
    }

    const cleanReview = stripReviewMetadata(review);

    // Update or add
    const existingIndex = reviews.findIndex((r) => r._ulid === review._ulid);
    if (existingIndex >= 0) {
      reviews[existingIndex] = cleanReview;
    } else {
      reviews.push(cleanReview);
    }

    // Save back to file
    const reviewsFile: ReviewRecordsFile = {
      kynetic_reviews: "1.0",
      reviews,
    };

    await writeYamlFilePreserveFormat(reviewsPath, reviewsFile);
  });
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
  const reviewsPath = review._sourceFile || getReviewsFilePath(ctx);
  let updatedReview: LoadedReviewRecord | undefined;

  await withFileLock(reviewsPath, async () => {
    // Ensure directory exists
    const dir = path.dirname(reviewsPath);
    await fs.mkdir(dir, { recursive: true });

    let reviews: ReviewRecord[] = [];
    try {
      reviews = await loadReviewsFromFile(reviewsPath);
    } catch {
      throw new Error(`Reviews file not found: ${reviewsPath}`);
    }

    const reviewIndex = reviews.findIndex(
      (candidate) => candidate._ulid === review._ulid,
    );
    if (reviewIndex === -1) {
      throw new Error(`Review not found in file: ${review._ulid}`);
    }

    const latestReview: LoadedReviewRecord = {
      ...reviews[reviewIndex],
      _sourceFile: reviewsPath,
    };

    const mutatedReview = await mutate(latestReview);
    const cleanMutatedReview = stripReviewMetadata(mutatedReview);
    reviews[reviewIndex] = cleanMutatedReview;

    const reviewsFile: ReviewRecordsFile = {
      kynetic_reviews: "1.0",
      reviews,
    };
    await writeYamlFilePreserveFormat(reviewsPath, reviewsFile);

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
export async function deleteReviewRecord(
  ctx: KspecContext,
  reviewUlid: string,
): Promise<boolean> {
  const reviewsPath = getReviewsFilePath(ctx);

  return withFileLock(reviewsPath, async () => {
    try {
      const reviews = await loadReviewsFromFile(reviewsPath);

      const index = reviews.findIndex((r) => r._ulid === reviewUlid);
      if (index < 0) {
        return false;
      }

      reviews.splice(index, 1);

      const reviewsFile: ReviewRecordsFile = {
        kynetic_reviews: "1.0",
        reviews,
      };

      await writeYamlFilePreserveFormat(reviewsPath, reviewsFile);
      return true;
    } catch {
      return false;
    }
  });
}
