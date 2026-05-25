/**
 * Review folder-storage migration.
 *
 * Converts the monolithic `.kspec/project.reviews.yaml` (with full inline
 * review records) into the folder-backed layout owned by
 * {@link ./review-storage-manager.ts}:
 *
 *   .kspec/reviews/<review-ulid>/review.yaml     — cohesive detail record
 *   .kspec/reviews/<review-ulid>/resources.yaml  — empty `{ resources: [] }`
 *   .kspec/project.reviews.yaml                  — lean index projection
 *
 * Reviews keep the structured record cohesive in this first slice — threads,
 * checks, verdicts, events, notes, and external links all live inside a
 * single `review.yaml` sidecar. The lean index gets aggregate counts plus
 * the disposition computed from the full record so list/dashboard surfaces
 * don't need to touch the per-review file.
 *
 * Like the plan migration, the executing run preserves every known and
 * unknown field on each record, mints a ULID when none is present, and
 * commits all writes inside a single buffered transaction.
 *
 * Spec: @entity-folder-migration-and-compatibility-1
 */

import * as path from "node:path";
import { ulid as generateUlid } from "ulid";
import {
  mkdirBufferAware,
  runWithBuffer,
  writeFileBufferAware,
} from "../cli/batch-write-buffer.js";
import { ReviewRecordSchema } from "../schema/review-records.js";
import { computeDisposition } from "./review-operations.js";
import { getUnresolvedBlockers } from "./review-threads.js";
import {
  REVIEW_DETAIL_FILENAME,
  REVIEW_LAYOUT,
  REVIEW_RESOURCES_DIR,
  REVIEW_RESOURCES_MANIFEST_FILENAME,
  toIndexEntry as toReviewIndexEntry,
} from "./review-storage-manager.js";
import { getEntityDir, listEntityDirs, writeIndexEntries } from "./folder-backed-entity.js";
import { getMonolithicReviewsFilePath } from "./entity-storage-compatibility.js";
import type { KspecContext } from "./yaml.js";
import { readYamlFile, toYaml } from "./yaml.js";

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Per-review migration plan. Mirrors {@link PlanMigrationEntry} —
 * everything the executing run needs to materialize one review onto disk
 * and rewrite its index entry.
 */
export interface ReviewMigrationEntry {
  readonly ulid: string;
  readonly title: string;
  /** Full record after identity recovery — written verbatim to review.yaml. */
  readonly detail: Record<string, unknown>;
  readonly reviewDir: string;
  /** Path to the cohesive detail file (`<reviewDir>/review.yaml`). */
  readonly detailPath: string;
  /** Path to the (always-written) empty resource manifest sidecar. */
  readonly resourceManifestPath: string;
  /** Path to the (always-created) empty resources subdirectory. */
  readonly resourcesDir: string;
  readonly indexEntry: Record<string, unknown>;
  readonly hadGeneratedUlid: boolean;
  readonly preexistingFolder: boolean;
  readonly validationWarning?: string;
}

/**
 * Stable review-storage migration report. Dry-run and executing paths
 * produce the same shape.
 */
export interface ReviewMigrationReport {
  readonly migrated: number;
  readonly reconciled: number;
  readonly entries: ReviewMigrationEntry[];
  readonly alreadyMigrated: boolean;
  readonly partialLayout: boolean;
  readonly warnings: string[];
  readonly monolithicPath: string;
  readonly folderRoot: string;
  readonly indexPath: string;
  /**
   * Lean index entries already present in `project.reviews.yaml` that do
   * not describe monolithic records. Carried through to the apply step
   * so a force-through-partial-layout migration preserves discovery of
   * pre-existing folder-backed reviews.
   */
  readonly preservedLeanEntries: Record<string, unknown>[];
  /**
   * Lean index entries whose `_ulid` does not correspond to any review
   * folder on disk. Symmetric with the plan migration: a stale lean
   * entry points at a missing `.kspec/reviews/<ulid>/review.yaml`. The
   * compute step counts these toward `partialLayout` and clears
   * `alreadyMigrated`. The apply step drops them from the rewritten
   * index when force is set (after detecting the partial layout).
   */
  readonly orphanedLeanEntries: Record<string, unknown>[];
}

async function readMonolithicReviews(
  filePath: string,
): Promise<{ raw: Record<string, unknown>[]; wrapper: Record<string, unknown> | null }> {
  let parsed: unknown;
  try {
    parsed = await readYamlFile<unknown>(filePath);
  } catch {
    return { raw: [], wrapper: null };
  }
  if (!parsed || typeof parsed !== "object") {
    return { raw: [], wrapper: null };
  }
  const wrapper = parsed as Record<string, unknown>;
  const list = wrapper.reviews;
  const raw: Record<string, unknown>[] = [];
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        raw.push(entry as Record<string, unknown>);
      }
    }
  }
  return { raw, wrapper };
}

/**
 * Heuristic: lean review index entries carry pre-computed counts
 * (`thread_count` / `check_count` / `verdict_count` / `unresolved_blocker_count`)
 * with numeric values. A record carrying the full threads/checks/verdicts
 * arrays is monolithic.
 */
function isMonolithicEntry(entry: Record<string, unknown>): boolean {
  const hasFullThreads = Array.isArray(entry.threads) && entry.threads.length > 0;
  const hasFullChecks = Array.isArray(entry.checks) && entry.checks.length > 0;
  const hasFullVerdicts = Array.isArray(entry.verdicts) && entry.verdicts.length > 0;
  const hasFullEvents = Array.isArray(entry.events) && entry.events.length > 0;
  const hasFullNotes = Array.isArray(entry.notes) && entry.notes.length > 0;
  if (
    hasFullThreads ||
    hasFullChecks ||
    hasFullVerdicts ||
    hasFullEvents ||
    hasFullNotes
  ) {
    return true;
  }
  // Records without all the lean count fields are also monolithic — they
  // were written before the lean index existed and need migration anyway.
  return typeof entry.thread_count !== "number" || typeof entry.check_count !== "number";
}

/**
 * Build an index entry directly from raw fields when schema validation
 * fails. Mirrors the shape `toReviewIndexEntry` produces so the lean
 * index keeps its bounded contract.
 */
function buildRawIndexEntry(
  ulid: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const threads = Array.isArray(raw.threads) ? raw.threads : [];
  const checks = Array.isArray(raw.checks) ? raw.checks : [];
  const verdicts = Array.isArray(raw.verdicts) ? raw.verdicts : [];
  const entry: Record<string, unknown> = {
    _ulid: ulid,
    slugs: Array.isArray(raw.slugs) ? raw.slugs : [],
    title: typeof raw.title === "string" ? raw.title : "",
    lifecycle_state: typeof raw.lifecycle_state === "string" ? raw.lifecycle_state : "draft",
    author: typeof raw.author === "string" ? raw.author : "",
    subject:
      raw.subject && typeof raw.subject === "object"
        ? (raw.subject as Record<string, unknown>)
        : {},
    related_refs: Array.isArray(raw.related_refs) ? raw.related_refs : [],
    created_at:
      typeof raw.created_at === "string" ? raw.created_at : new Date().toISOString(),
    disposition: "pending",
    thread_count: threads.length,
    unresolved_blocker_count: 0,
    check_count: checks.length,
    verdict_count: verdicts.length,
  };
  if (typeof raw.updated_at === "string") entry.updated_at = raw.updated_at;
  if (typeof raw.examined_commit === "string") entry.examined_commit = raw.examined_commit;
  if (Array.isArray(raw.external_links) && raw.external_links.length > 0) {
    entry.external_links = raw.external_links;
  }
  return entry;
}

function buildMigrationEntry(
  ctx: KspecContext,
  raw: Record<string, unknown>,
  existingFolderUlids: Set<string>,
  warnings: string[],
): ReviewMigrationEntry {
  let ulid = typeof raw._ulid === "string" && ULID_REGEX.test(raw._ulid) ? raw._ulid : "";
  let hadGenerated = false;
  if (!ulid) {
    ulid = generateUlid();
    hadGenerated = true;
    warnings.push(
      `Review "${typeof raw.title === "string" ? raw.title : "(untitled)"}": missing or invalid _ulid — generated ${ulid}`,
    );
  }

  const detail: Record<string, unknown> = { ...raw, _ulid: ulid };

  // Try schema validation for warnings and an accurate index entry.
  let validationWarning: string | undefined;
  let indexEntry: Record<string, unknown>;
  const parsed = ReviewRecordSchema.safeParse(detail);
  if (parsed.success) {
    const review = parsed.data;
    indexEntry = toReviewIndexEntry(review);
    // Re-run disposition + unresolved blocker count for record-level accuracy.
    indexEntry.disposition = computeDisposition(review);
    indexEntry.unresolved_blocker_count = getUnresolvedBlockers(review).length;
  } else {
    validationWarning = `Review ${ulid}: validation warning — ${parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")}`;
    warnings.push(validationWarning);
    indexEntry = buildRawIndexEntry(ulid, raw);
  }

  const reviewDir = getEntityDir(ctx, REVIEW_LAYOUT, ulid);
  return {
    ulid,
    title: typeof raw.title === "string" ? raw.title : "",
    detail,
    reviewDir,
    detailPath: path.join(reviewDir, REVIEW_DETAIL_FILENAME),
    resourceManifestPath: path.join(reviewDir, REVIEW_RESOURCES_MANIFEST_FILENAME),
    resourcesDir: path.join(reviewDir, REVIEW_RESOURCES_DIR),
    indexEntry,
    hadGeneratedUlid: hadGenerated,
    preexistingFolder: existingFolderUlids.has(ulid),
    validationWarning,
  };
}

/**
 * Compute a review-storage migration plan from the on-disk state. Pure
 * projection — never writes.
 */
export async function computeReviewMigrationReport(
  ctx: KspecContext,
): Promise<ReviewMigrationReport> {
  const monolithicPath = getMonolithicReviewsFilePath(ctx);
  const folderRoot = path.join(ctx.specDir, REVIEW_LAYOUT.storageRoot);
  const indexPath = path.join(ctx.specDir, REVIEW_LAYOUT.indexFile);

  const { raw } = await readMonolithicReviews(monolithicPath);
  const folderUlids = new Set(await listEntityDirs(ctx, REVIEW_LAYOUT));
  const monolithicRecords = raw.filter(isMonolithicEntry);
  // Split non-monolithic lean entries into preserved (folder exists on
  // disk) and orphaned (folder missing) buckets. Symmetric with the plan
  // migration: orphans signal a partial layout that must be detected up
  // front, otherwise the upgrade promotes the manifest on top of stale
  // index entries and `kspec review list` fails with
  // `partial_entity_storage_layout` on the next call.
  const preservedLeanEntries: Record<string, unknown>[] = [];
  const orphanedLeanEntries: Record<string, unknown>[] = [];
  for (const entry of raw) {
    if (isMonolithicEntry(entry)) continue;
    const id = entry._ulid;
    if (typeof id === "string" && folderUlids.has(id)) {
      preservedLeanEntries.push(entry);
    } else {
      orphanedLeanEntries.push(entry);
    }
  }

  const warnings: string[] = [];
  const entries: ReviewMigrationEntry[] = monolithicRecords.map((record) =>
    buildMigrationEntry(ctx, record, folderUlids, warnings),
  );

  // Partial layout covers three distinct broken states:
  //   1. Folders + monolithic records present for distinct ULIDs —
  //      historical mixed case.
  //   2. Folders + monolithic records present for the SAME ULID —
  //      ambiguous storage where the monolithic record would overwrite
  //      pre-existing folder state during apply. Without flagging this
  //      the executing run silently replaces review.yaml.
  //   3. Lean index entries pointing at folders that do not exist on
  //      disk — stale entries leave the project in an incoherent state
  //      after manifest promotion.
  //
  // Cases 1 and 2 collapse to a single rule: any monolithic record
  // alongside any review folder = partial layout.
  const partialLayout =
    (folderUlids.size > 0 && entries.length > 0) ||
    orphanedLeanEntries.length > 0;

  const alreadyMigrated =
    monolithicRecords.length === 0 && orphanedLeanEntries.length === 0;

  return {
    migrated: entries.filter((e) => !e.preexistingFolder).length,
    reconciled: folderUlids.size,
    entries,
    alreadyMigrated,
    partialLayout,
    warnings,
    monolithicPath,
    folderRoot,
    indexPath,
    preservedLeanEntries,
    orphanedLeanEntries,
  };
}

export interface ReviewMigrationOptions {
  readonly force?: boolean;
}

/**
 * Apply a precomputed review migration report to disk. All writes happen
 * inside a single buffered transaction. The caller owns the shadow commit.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
 * AC: @entity-folder-migration-and-compatibility-1 ac-migration-preserves-record-identity-and-unknown-fields
 */
export async function applyReviewMigration(
  ctx: KspecContext,
  report: ReviewMigrationReport,
  options: ReviewMigrationOptions = {},
): Promise<{ written: number; indexEntries: number }> {
  // True no-op: nothing to migrate AND no partial-layout remediation.
  if (report.entries.length === 0 && !report.partialLayout) {
    return { written: 0, indexEntries: 0 };
  }
  if (report.partialLayout && !options.force) {
    const reason =
      report.orphanedLeanEntries.length > 0
        ? `lean index entries describe review folders that do not exist on disk ` +
          `(${report.orphanedLeanEntries.length} stale entr` +
          `${report.orphanedLeanEntries.length === 1 ? "y" : "ies"})`
        : `folders exist alongside monolithic records`;
    const err = new Error(
      `Review storage layout is partial: ${reason}. ` +
        `Re-run with --force to remediate, or run ` +
        `'kspec review rebuild-index' after manual cleanup.`,
    );
    (err as NodeJS.ErrnoException).code = "partial_entity_storage_layout";
    throw err;
  }

  let written = 0;
  let indexEntriesWritten = 0;
  await runWithBuffer(ctx.specDir, async () => {
    await mkdirBufferAware(report.folderRoot);

    for (const entry of report.entries) {
      await mkdirBufferAware(entry.reviewDir);

      await writeFileBufferAware(entry.detailPath, toYaml(entry.detail));
      // resources.yaml is always written (empty stub). The empty
      // resources/ directory is materialized below so the migrated
      // folder shape matches the layout contract (review.yaml,
      // resources.yaml, resources/) before any resource files exist.
      await writeFileBufferAware(entry.resourceManifestPath, toYaml({ resources: [] }));
      await mkdirBufferAware(entry.resourcesDir);
      written += 1;
    }

    // Replace the monolithic reviews file with a fresh lean projection.
    // Same path as the index (`project.reviews.yaml`), so this write is
    // sufficient — no separate delete step needed.
    //
    // The rebuilt index is the union of migrated entries and any
    // pre-existing lean entries the migration did not touch. This keeps
    // folder-backed reviews discoverable after a force-through-partial
    // layout migration; without it the index rewrite drops them and the
    // detail folder is orphaned.
    const migratedUlids = new Set(report.entries.map((e) => e.ulid));
    const finalIndexEntries: Record<string, unknown>[] = [];
    for (const lean of report.preservedLeanEntries) {
      const id = lean._ulid;
      if (typeof id === "string" && !migratedUlids.has(id)) {
        finalIndexEntries.push(lean);
      }
    }
    for (const entry of report.entries) {
      finalIndexEntries.push(entry.indexEntry);
    }
    const shape = {
      entries: finalIndexEntries,
      useWrapper: true,
      wrapperObj: { kynetic_reviews: "1.0" },
    };
    await writeIndexEntries(
      report.indexPath,
      finalIndexEntries,
      shape,
      REVIEW_LAYOUT.indexWrapperKey,
    );
    indexEntriesWritten = finalIndexEntries.length;
  });

  return { written, indexEntries: indexEntriesWritten };
}
