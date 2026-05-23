/**
 * Entity Storage Compatibility — version and layout gates for folder-backed
 * plan, review, and entity-scoped local resource storage.
 *
 * The new (kynetic 1.2) storage model decomposes monolithic project.plans.yaml
 * and project.reviews.yaml into per-entity directories under .kspec/plans/ and
 * .kspec/reviews/, with entity-scoped local resources living under each
 * owner's directory. Older projects (kynetic < 1.2, or missing the
 * `plan_storage.format: folder` / `review_storage.format: folder` /
 * `resource_storage.format: entity_scoped` declarations) must run
 * `kspec upgrade` before commands or daemon routes that require folder-backed
 * behavior can safely read or write.
 *
 * This module is named `entity_storage` because it covers three entity
 * domains (plans, reviews, resources). The deterministic error codes are:
 *
 *  - `legacy_plan_storage_removed` — kynetic < 1.2 without folder storage
 *  - `legacy_review_storage_removed` — kynetic < 1.2 without folder storage
 *  - `missing_plan_folder_storage` — kynetic >= 1.2 but plan_storage.format != "folder"
 *  - `missing_review_folder_storage` — kynetic >= 1.2 but review_storage.format != "folder"
 *  - `partial_entity_storage_layout` — folder storage declared but layout is partial
 *
 * Two gate flavors are provided so callers can pick the right strictness:
 *
 *  - `assertPlanStorageCompatible` / `assertReviewStorageCompatible`:
 *    storage-manager mode — passes on legacy (kynetic < 1.2 without folder
 *    declaration) so existing monolithic reads continue to work, but raises
 *    `missing_*_folder_storage` when the manifest explicitly declares a
 *    non-folder format on a 1.2+ project, and raises
 *    `partial_entity_storage_layout` when the manifest declares folder storage
 *    but monolithic records still exist on disk. This is the gate the
 *    monolithic plan/review storage managers call so they refuse to silently
 *    read or rewrite ambiguous data once a project has been promoted to
 *    folder-backed storage.
 *  - `requirePlanFolderStorage` / `requireReviewFolderStorage` /
 *    `requireResourceFolderStorage`:
 *    strict — callers that NEED folder-backed behavior. Raises
 *    `legacy_*_storage_removed` on legacy projects and `missing_*_folder_storage`
 *    when the manifest does not declare folder/entity_scoped storage. Also
 *    raises `partial_entity_storage_layout` for plan/review domains when
 *    monolithic records still exist beside the declared folder layout.
 *
 * Spec: @entity-folder-migration-and-compatibility-1
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Manifest } from "../schema/index.js";
import type { KspecContext } from "./yaml.js";

/** Manifest version that first introduced folder-backed entity storage. */
export const ENTITY_FOLDER_STORAGE_MIN_KYNETIC_VERSION = "1.2";

/** Numeric form used for `parseFloat` comparisons against `kynetic` strings. */
export const ENTITY_FOLDER_STORAGE_MIN_KYNETIC_NUMERIC = 1.2;

// ── Deterministic error codes ──────────────────────────────────────────────

/**
 * Stable codes for the deterministic entity-storage compatibility/migration
 * failures. Callers that observe one of these codes know the condition will
 * not resolve on retry — only a project state change (upgrade, migration,
 * or version pin) can clear it.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
export const LEGACY_PLAN_STORAGE_REMOVED_CODE = "legacy_plan_storage_removed";
export const LEGACY_REVIEW_STORAGE_REMOVED_CODE = "legacy_review_storage_removed";
export const MISSING_PLAN_FOLDER_STORAGE_CODE = "missing_plan_folder_storage";
export const MISSING_REVIEW_FOLDER_STORAGE_CODE = "missing_review_folder_storage";
export const PARTIAL_ENTITY_STORAGE_LAYOUT_CODE = "partial_entity_storage_layout";

export const DETERMINISTIC_ENTITY_STORAGE_INCOMPATIBILITY_CODES: ReadonlySet<string> = new Set([
  LEGACY_PLAN_STORAGE_REMOVED_CODE,
  LEGACY_REVIEW_STORAGE_REMOVED_CODE,
  MISSING_PLAN_FOLDER_STORAGE_CODE,
  MISSING_REVIEW_FOLDER_STORAGE_CODE,
  PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
]);

/** Logical entity domain the failure applies to. */
export type EntityStorageDomain = "plans" | "reviews" | "resources";

/**
 * Error thrown when a project's manifest or on-disk layout does not satisfy
 * the folder-backed entity storage contract required by a caller.
 *
 * Carries the deterministic code, the domain that failed, the field the user
 * needs to fix in the manifest, a suggestion (run `kspec upgrade`), and a
 * cache-domain identifier so daemon routes can attach cache state context.
 */
export class EntityStorageCompatibilityError extends Error {
  readonly code: string;
  readonly domain: EntityStorageDomain;
  readonly suggestion?: string;
  readonly field?: string;
  /**
   * Cache domain identifier the failure should be attributed to in daemon
   * responses. Defaults to the entity domain (plans, reviews, resources).
   */
  readonly cacheDomain: string;

  constructor(
    message: string,
    options: {
      code: string;
      domain: EntityStorageDomain;
      suggestion?: string;
      field?: string;
      cacheDomain?: string;
    },
  ) {
    super(message);
    this.name = "EntityStorageCompatibilityError";
    this.code = options.code;
    this.domain = options.domain;
    this.suggestion = options.suggestion;
    this.field = options.field;
    this.cacheDomain = options.cacheDomain ?? options.domain;
  }
}

/**
 * Type guard for deterministic entity-storage incompatibilities. Returns true
 * only when the error carries a known incompatibility code; generic Error
 * values and other thrown values return false.
 */
export function isDeterministicEntityStorageIncompatibility(
  err: unknown,
): err is EntityStorageCompatibilityError {
  return (
    err instanceof EntityStorageCompatibilityError &&
    DETERMINISTIC_ENTITY_STORAGE_INCOMPATIBILITY_CODES.has(err.code)
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const PLAN_UPGRADE_SUGGESTION =
  'Run "kspec upgrade" to migrate this project to folder-backed plan storage, or use a kspec version compatible with the current manifest.';
const REVIEW_UPGRADE_SUGGESTION =
  'Run "kspec upgrade" to migrate this project to folder-backed review storage, or use a kspec version compatible with the current manifest.';
const RESOURCE_UPGRADE_SUGGESTION =
  'Run "kspec upgrade" to migrate this project to entity-scoped local resource storage, or use a kspec version compatible with the current manifest.';

function parseKyneticVersion(manifest: Manifest | null | undefined): number | null {
  const raw = manifest?.kynetic;
  if (typeof raw !== "string") return null;
  const numeric = parseFloat(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function isKyneticAtLeastFolderMinimum(manifest: Manifest | null | undefined): boolean {
  const numeric = parseKyneticVersion(manifest);
  return numeric !== null && numeric >= ENTITY_FOLDER_STORAGE_MIN_KYNETIC_NUMERIC;
}

interface DomainCodes {
  readonly legacyCode: string;
  readonly missingCode: string;
  readonly field: string;
  readonly suggestion: string;
  readonly folderFormat: string;
  readonly displayName: string;
}

const DOMAIN_CONFIG: Record<EntityStorageDomain, DomainCodes> = {
  plans: {
    legacyCode: LEGACY_PLAN_STORAGE_REMOVED_CODE,
    missingCode: MISSING_PLAN_FOLDER_STORAGE_CODE,
    field: "plan_storage.format",
    suggestion: PLAN_UPGRADE_SUGGESTION,
    folderFormat: "folder",
    displayName: "plan",
  },
  reviews: {
    legacyCode: LEGACY_REVIEW_STORAGE_REMOVED_CODE,
    missingCode: MISSING_REVIEW_FOLDER_STORAGE_CODE,
    field: "review_storage.format",
    suggestion: REVIEW_UPGRADE_SUGGESTION,
    folderFormat: "folder",
    displayName: "review",
  },
  resources: {
    // Resources reuse the plan storage codes because the listed
    // deterministic codes only cover plan/review/partial cases. The
    // `domain` field on the error makes the actual entity clear, and the
    // message text references entity-scoped resource storage explicitly.
    legacyCode: LEGACY_PLAN_STORAGE_REMOVED_CODE,
    missingCode: MISSING_PLAN_FOLDER_STORAGE_CODE,
    field: "resource_storage.format",
    suggestion: RESOURCE_UPGRADE_SUGGESTION,
    folderFormat: "entity_scoped",
    displayName: "entity-scoped local resource",
  },
};

function getDeclaredFormat(
  manifest: Manifest | null | undefined,
  domain: EntityStorageDomain,
): string | undefined {
  if (domain === "plans") return manifest?.plan_storage?.format;
  if (domain === "reviews") return manifest?.review_storage?.format;
  return manifest?.resource_storage?.format;
}

// ── Strict requirement (callers that NEED folder behavior) ──────────────────

/**
 * Build the strict-mode incompatibility for a domain. Returns null when the
 * manifest declares the required folder/entity_scoped storage.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 */
export function describeStrictManifestIncompatibility(
  manifest: Manifest | null | undefined,
  domain: EntityStorageDomain,
): EntityStorageCompatibilityError | null {
  const cfg = DOMAIN_CONFIG[domain];
  const declared = getDeclaredFormat(manifest, domain);
  if (declared === cfg.folderFormat) return null;

  const kyneticForMessage = manifest?.kynetic ?? "(unset)";

  if (!isKyneticAtLeastFolderMinimum(manifest)) {
    return new EntityStorageCompatibilityError(
      `This project uses kynetic version "${kyneticForMessage}" without folder-backed ${cfg.displayName} storage. ` +
        `The monolithic ${cfg.displayName} storage format has been removed.`,
      {
        code: cfg.legacyCode,
        domain,
        suggestion: cfg.suggestion,
        field: cfg.field,
        cacheDomain: domain,
      },
    );
  }

  return new EntityStorageCompatibilityError(
    `This project declares kynetic >= ${ENTITY_FOLDER_STORAGE_MIN_KYNETIC_VERSION} but ${cfg.field} is not "${cfg.folderFormat}". ` +
      `Folder-backed ${cfg.displayName} storage is required for ${cfg.displayName} reads and writes.`,
    {
      code: cfg.missingCode,
      domain,
      suggestion: cfg.suggestion,
      field: cfg.field,
      cacheDomain: domain,
    },
  );
}

// ── Lenient compatibility check (default for routes that read monolithic) ──

/**
 * Build the lenient-mode incompatibility for a domain. Returns null when:
 *   - the project is legacy (kynetic < 1.2) AND has no declared storage
 *     format for the domain (backward-compatible default), OR
 *   - the manifest declares the required folder/entity_scoped format.
 *
 * Raises `missing_*_folder_storage` when the manifest declares a non-folder
 * format on a 1.2+ project or declares a non-folder format on any project
 * (broken manifest).
 *
 * The lenient mode allows existing routes that read legacy monolithic data
 * to continue working on 1.0/1.1 projects while still rejecting projects
 * whose manifests explicitly declare an unsupported storage shape.
 */
export function describeLenientManifestIncompatibility(
  manifest: Manifest | null | undefined,
  domain: EntityStorageDomain,
): EntityStorageCompatibilityError | null {
  const cfg = DOMAIN_CONFIG[domain];
  const declared = getDeclaredFormat(manifest, domain);
  if (declared === cfg.folderFormat) return null;

  // Backward-compat: no declaration on a legacy project → lenient pass.
  if (declared === undefined && !isKyneticAtLeastFolderMinimum(manifest)) {
    return null;
  }

  const kyneticForMessage = manifest?.kynetic ?? "(unset)";
  return new EntityStorageCompatibilityError(
    declared === undefined
      ? `This project declares kynetic >= ${ENTITY_FOLDER_STORAGE_MIN_KYNETIC_VERSION} but ${cfg.field} is not set. ` +
          `Folder-backed ${cfg.displayName} storage is required.`
      : `This project's ${cfg.field} is "${declared}" (kynetic: "${kyneticForMessage}"). ` +
          `Folder-backed ${cfg.displayName} storage requires ${cfg.field} = "${cfg.folderFormat}".`,
    {
      code: cfg.missingCode,
      domain,
      suggestion: cfg.suggestion,
      field: cfg.field,
      cacheDomain: domain,
    },
  );
}

// ── Project storage report (read-only diagnostic) ─────────────────────────

/**
 * Plain-data summary of the project's manifest storage declarations and
 * whether each requires a folder-backed read/write contract. Used by
 * `kspec doctor` and other read-only diagnostics that must run on
 * incompatible layouts without raising.
 *
 * The strict-mode incompatibilities surface every domain whose manifest does
 * not declare folder storage; the lenient ones only surface domains whose
 * manifests explicitly declare a non-folder format (the cases that are
 * always broken regardless of caller strictness).
 */
export interface ManifestStorageReport {
  kynetic: string;
  planFormat: string | undefined;
  reviewFormat: string | undefined;
  resourceFormat: string | undefined;
  strictPlanIncompatibility: EntityStorageCompatibilityError | null;
  strictReviewIncompatibility: EntityStorageCompatibilityError | null;
  strictResourceIncompatibility: EntityStorageCompatibilityError | null;
  lenientPlanIncompatibility: EntityStorageCompatibilityError | null;
  lenientReviewIncompatibility: EntityStorageCompatibilityError | null;
  lenientResourceIncompatibility: EntityStorageCompatibilityError | null;
}

export function buildManifestStorageReport(
  manifest: Manifest | null | undefined,
): ManifestStorageReport {
  return {
    kynetic: manifest?.kynetic ?? "(unset)",
    planFormat: manifest?.plan_storage?.format,
    reviewFormat: manifest?.review_storage?.format,
    resourceFormat: manifest?.resource_storage?.format,
    strictPlanIncompatibility: describeStrictManifestIncompatibility(manifest, "plans"),
    strictReviewIncompatibility: describeStrictManifestIncompatibility(manifest, "reviews"),
    strictResourceIncompatibility: describeStrictManifestIncompatibility(manifest, "resources"),
    lenientPlanIncompatibility: describeLenientManifestIncompatibility(manifest, "plans"),
    lenientReviewIncompatibility: describeLenientManifestIncompatibility(manifest, "reviews"),
    lenientResourceIncompatibility: describeLenientManifestIncompatibility(manifest, "resources"),
  };
}

// ── Partial-layout detection ─────────────────────────────────────────────────

/**
 * Path of the plan folder under specDir (.kspec/plans/).
 */
export function getPlanFolderRoot(ctx: KspecContext): string {
  return path.join(ctx.specDir, "plans");
}

/**
 * Path of the review folder under specDir (.kspec/reviews/).
 */
export function getReviewFolderRoot(ctx: KspecContext): string {
  return path.join(ctx.specDir, "reviews");
}

/**
 * Path of the monolithic plans file under specDir (.kspec/project.plans.yaml).
 */
export function getMonolithicPlansFilePath(ctx: KspecContext): string {
  return path.join(ctx.specDir, "project.plans.yaml");
}

/**
 * Path of the monolithic reviews file under specDir (.kspec/project.reviews.yaml).
 */
export function getMonolithicReviewsFilePath(ctx: KspecContext): string {
  return path.join(ctx.specDir, "project.reviews.yaml");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read raw monolithic record entries (those with an `_ulid` field) from a
 * legacy plans or reviews file. Returns 0 when the file is missing or empty.
 */
async function countMonolithicEntries(
  filePath: string,
  arrayKey: "plans" | "reviews",
): Promise<number> {
  let raw: unknown;
  try {
    const { readYamlFile } = await import("./yaml.js");
    raw = await readYamlFile<unknown>(filePath);
  } catch {
    return 0;
  }
  if (!raw || typeof raw !== "object") return 0;
  const arr = (raw as Record<string, unknown>)[arrayKey];
  if (!Array.isArray(arr)) return 0;
  return arr.filter(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>)._ulid === "string",
  ).length;
}

/**
 * Detect a partial folder-storage layout for a single domain.
 *
 * A layout is partial when the manifest declares folder storage but
 * monolithic record entries still exist alongside (or instead of) the
 * folder-backed layout — an ambiguous source of truth that should not be
 * silently dual-read or rewritten.
 *
 * Returns null when the layout is consistent with the declared format or
 * when the manifest does not declare folder storage at all.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
export async function detectPartialLayoutForDomain(
  ctx: KspecContext,
  domain: "plans" | "reviews",
): Promise<EntityStorageCompatibilityError | null> {
  const declared =
    domain === "plans" ? ctx.manifest?.plan_storage?.format : ctx.manifest?.review_storage?.format;
  if (declared !== "folder") {
    return null;
  }

  const folderRoot = domain === "plans" ? getPlanFolderRoot(ctx) : getReviewFolderRoot(ctx);
  const monolithicPath =
    domain === "plans" ? getMonolithicPlansFilePath(ctx) : getMonolithicReviewsFilePath(ctx);

  const folderExists = await pathExists(folderRoot);
  const monolithicEntries = await countMonolithicEntries(monolithicPath, domain);

  if (monolithicEntries === 0) {
    return null;
  }

  const cfg = DOMAIN_CONFIG[domain];
  const message = folderExists
    ? `Project declares folder-backed ${cfg.displayName} storage but ${path.basename(monolithicPath)} still contains ${monolithicEntries} monolithic ${cfg.displayName} record(s) alongside ${path.basename(folderRoot)}/. ` +
      "The storage layout is partial."
    : `Project declares folder-backed ${cfg.displayName} storage but no ${path.basename(folderRoot)}/ directory exists and ${path.basename(monolithicPath)} still contains ${monolithicEntries} monolithic ${cfg.displayName} record(s). ` +
      "The storage layout is partial.";

  return new EntityStorageCompatibilityError(message, {
    code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
    domain,
    suggestion:
      'Run "kspec upgrade" to complete the migration, or restore a compatible storage state.',
    field: cfg.field,
    cacheDomain: domain,
  });
}

// ── Caller-facing gates ──────────────────────────────────────────────────────

/**
 * Build the write-side incompatibility for a domain. This is the lenient
 * manifest check PLUS an additional rule: when the manifest declares
 * folder-backed storage, the monolithic storage manager must NOT create new
 * monolithic records. Without this rule, a fresh kynetic 1.2 project (which
 * declares folder storage by default) could have monolithic data created via
 * savePlan/saveReview before the partial-layout detector trips, immediately
 * producing the partial layout this task is supposed to prevent.
 *
 * Returns the appropriate `partial_entity_storage_layout` error in that case
 * so the structured 409 contract stays consistent across daemon and CLI.
 */
function describeMonolithicWriteIncompatibility(
  manifest: Manifest | null | undefined,
  domain: "plans" | "reviews",
): EntityStorageCompatibilityError | null {
  const cfg = DOMAIN_CONFIG[domain];
  const declared = getDeclaredFormat(manifest, domain);
  if (declared === cfg.folderFormat) {
    return new EntityStorageCompatibilityError(
      `Project declares folder-backed ${cfg.displayName} storage (${cfg.field} = "${cfg.folderFormat}"). ` +
        `The monolithic ${cfg.displayName} storage manager cannot create new ${cfg.displayName} records under a folder manifest; writes must route through the folder-backed ${cfg.displayName} storage manager.`,
      {
        code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
        domain,
        suggestion:
          'Run "kspec upgrade" to complete the migration, or use a kspec version compatible with the existing manifest.',
        field: cfg.field,
        cacheDomain: domain,
      },
    );
  }
  return null;
}

/**
 * Storage-manager READ gate for plan storage. The monolithic plan parser
 * (loadPlans / findPlanByRef) calls this before reading so it refuses to
 * serve data from layouts that no longer have an unambiguous source of
 * truth.
 *
 * The read gate is lenient on the manifest declaration:
 *   - Legacy projects (kynetic < 1.2, no `plan_storage` declaration) pass
 *     so the monolithic store continues serving CLI reads until upgrade.
 *     Daemon plan routes still raise the strict gate at the route entry
 *     (`requirePlanFolderStorage`) so unmigrated daemon reads fail with
 *     `legacy_plan_storage_removed` / `missing_plan_folder_storage`.
 *   - Folder-declared projects (`plan_storage.format: folder`) pass the
 *     manifest check, but the partial-layout detector then runs and fails
 *     with `partial_entity_storage_layout` if monolithic plan records
 *     still exist next to (or instead of) the declared folder layout.
 *   - Other 1.2+ projects (missing declaration or explicit non-folder)
 *     fail with `missing_plan_folder_storage`.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
export async function assertPlanStorageCompatible(ctx: KspecContext): Promise<void> {
  const manifestErr = describeLenientManifestIncompatibility(ctx.manifest, "plans");
  if (manifestErr) throw manifestErr;
  const partialErr = await detectPartialLayoutForDomain(ctx, "plans");
  if (partialErr) throw partialErr;
}

/**
 * Storage-manager WRITE gate for plan storage. The monolithic plan parser
 * (savePlan / mutatePlanAtomically / deletePlan) calls this before any
 * write. It enforces every read-time check plus one extra rule:
 *
 *   - Folder-declared projects (`plan_storage.format: folder`) MUST NOT
 *     have new monolithic records written to them, even when the on-disk
 *     layout is currently clean. Without this rule, a fresh kynetic 1.2
 *     project (which declares folder storage by default) could call
 *     savePlan and create a monolithic `project.plans.yaml` under a folder
 *     manifest, immediately producing the partial layout this task is
 *     supposed to prevent. Writes must route through the folder-backed
 *     plan storage manager (delivered by a sibling task).
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
export async function assertPlanStorageWritable(ctx: KspecContext): Promise<void> {
  const manifestErr = describeLenientManifestIncompatibility(ctx.manifest, "plans");
  if (manifestErr) throw manifestErr;
  const partialErr = await detectPartialLayoutForDomain(ctx, "plans");
  if (partialErr) throw partialErr;
  const writeErr = describeMonolithicWriteIncompatibility(ctx.manifest, "plans");
  if (writeErr) throw writeErr;
}

/**
 * Storage-manager READ gate for review storage. See {@link assertPlanStorageCompatible}.
 * Fires `partial_entity_storage_layout` when `review_storage.format: folder`
 * is declared but monolithic review records remain in `project.reviews.yaml`.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
export async function assertReviewStorageCompatible(ctx: KspecContext): Promise<void> {
  const manifestErr = describeLenientManifestIncompatibility(ctx.manifest, "reviews");
  if (manifestErr) throw manifestErr;
  const partialErr = await detectPartialLayoutForDomain(ctx, "reviews");
  if (partialErr) throw partialErr;
}

/**
 * Storage-manager WRITE gate for review storage. See {@link assertPlanStorageWritable}.
 * Refuses to create monolithic review records under a folder-declared manifest.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
export async function assertReviewStorageWritable(ctx: KspecContext): Promise<void> {
  const manifestErr = describeLenientManifestIncompatibility(ctx.manifest, "reviews");
  if (manifestErr) throw manifestErr;
  const partialErr = await detectPartialLayoutForDomain(ctx, "reviews");
  if (partialErr) throw partialErr;
  const writeErr = describeMonolithicWriteIncompatibility(ctx.manifest, "reviews");
  if (writeErr) throw writeErr;
}

/**
 * Storage-manager gate for entity-scoped local resource storage.
 *
 * Resource storage is manifest-only — resources live under their owning
 * entity's directory, so partial-layout detection for resources fires through
 * the owning entity's domain instead.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 */
export async function assertResourceStorageCompatible(ctx: KspecContext): Promise<void> {
  const manifestErr = describeLenientManifestIncompatibility(ctx.manifest, "resources");
  if (manifestErr) throw manifestErr;
}

/**
 * Strict gate for plan storage. Callers that explicitly require folder-backed
 * plan behavior (the folder-backed plan storage manager, plan migration code,
 * folder-required CLI commands) call this and surface the structured error
 * for any non-folder manifest state.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
export async function requirePlanFolderStorage(ctx: KspecContext): Promise<void> {
  const manifestErr = describeStrictManifestIncompatibility(ctx.manifest, "plans");
  if (manifestErr) throw manifestErr;
  const partialErr = await detectPartialLayoutForDomain(ctx, "plans");
  if (partialErr) throw partialErr;
}

/**
 * Strict gate for review storage. See {@link requirePlanFolderStorage}.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
export async function requireReviewFolderStorage(ctx: KspecContext): Promise<void> {
  const manifestErr = describeStrictManifestIncompatibility(ctx.manifest, "reviews");
  if (manifestErr) throw manifestErr;
  const partialErr = await detectPartialLayoutForDomain(ctx, "reviews");
  if (partialErr) throw partialErr;
}

/**
 * Strict gate for entity-scoped local resource storage.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 */
export async function requireResourceFolderStorage(ctx: KspecContext): Promise<void> {
  const manifestErr = describeStrictManifestIncompatibility(ctx.manifest, "resources");
  if (manifestErr) throw manifestErr;
}
