/**
 * Review resource manager — high-level add/list/get/remove primitives that
 * the CLI and daemon both call so the review resource contract is enforced
 * once.
 *
 * Internally delegates to the entity-scoped local resources trait foundation
 * for all the shared concerns: id/path validation, content-type inference,
 * SHA-256 hashing, git identity capture, symlink-safe resolution, and
 * resources.yaml read/write. This module owns review-specific glue:
 *   - resolving a review ref → review folder
 *   - copying source bytes into `<reviewDir>/resources/<path>`
 *   - upserting / deleting manifest entries with `replace` semantics
 *   - re-saving the review record so the lean index picks up the updated
 *     resource summary (and shadow-branch auto-commits fire)
 *   - mapping every failure mode onto the structured error codes the CLI
 *     and daemon contracts require.
 *
 * Spec: @folder-backed-review-storage-1
 *       @trait-entity-scoped-local-resources-1
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  computeResourceMetadata,
  getResourcesDir,
  loadResourceManifest,
  type ResourceManifest,
  type ResourceMetadata,
  resolveContentType,
  resolveResourcePath,
  validateResourceId,
  validateResourceRelativePath,
  writeResourceManifest,
} from "./entity-local-resources.js";
import { requireReviewFolderStorage } from "./entity-storage-compatibility.js";
import {
  findReviewByRefInFolders,
  getReviewDir,
  saveReviewRecordToFolder,
  type LoadedReviewRecord,
} from "./review-storage-manager.js";
import type { KspecContext } from "./yaml.js";

/**
 * Structured error codes shared by every review-resource surface.
 *
 * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 */
export type ReviewResourceErrorCode =
  | "invalid_resource_id"
  | "invalid_resource_path"
  | "invalid_content_type"
  | "source_file_missing"
  | "source_file_unreadable"
  | "resource_conflict"
  | "resource_not_found"
  | "review_not_found";

/**
 * Structured error returned by every manager primitive. Includes the
 * machine-readable code, a human-readable message, and any contextual
 * identifiers (resource_id, path, source_file) so CLI/JSON and HTTP layers
 * can build their full error envelopes without re-parsing the message.
 */
export interface ReviewResourceError {
  code: ReviewResourceErrorCode;
  message: string;
  resource_id?: string | null;
  path?: string | null;
  source_file?: string | null;
}

export type ReviewResourceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ReviewResourceError };

function err(error: ReviewResourceError): { ok: false; error: ReviewResourceError } {
  return { ok: false, error };
}

// ── Lookup ──────────────────────────────────────────────────────────────────

/**
 * Resolve a review reference to its loaded record. Returns a structured
 * `review_not_found` failure when no review matches, so CLI/daemon callers
 * can map the code uniformly.
 */
export async function findReviewForResource(
  ctx: KspecContext,
  ref: string,
): Promise<ReviewResourceResult<LoadedReviewRecord>> {
  await requireReviewFolderStorage(ctx);
  const review = await findReviewByRefInFolders(ctx, ref);
  if (!review) {
    return err({
      code: "review_not_found",
      message: `Review "${ref}" not found. Use kspec review list to find valid references.`,
    });
  }
  return { ok: true, value: review };
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Load every declared resource for a review. Resource ordering matches the
 * on-disk manifest; missing manifests yield an empty array (consistent
 * with `loadResourceManifest`).
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export async function listReviewResources(
  ctx: KspecContext,
  ref: string,
): Promise<ReviewResourceResult<{ review: LoadedReviewRecord; resources: ResourceMetadata[] }>> {
  const lookup = await findReviewForResource(ctx, ref);
  if (!lookup.ok) return lookup;
  const manifest = await loadResourceManifest(getReviewDir(ctx, lookup.value._ulid));
  return { ok: true, value: { review: lookup.value, resources: manifest.resources } };
}

/**
 * Fetch a single review resource by id. Returns `resource_not_found` when
 * the id is undeclared.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export async function getReviewResource(
  ctx: KspecContext,
  ref: string,
  resourceId: string,
): Promise<ReviewResourceResult<{ review: LoadedReviewRecord; resource: ResourceMetadata }>> {
  const listing = await listReviewResources(ctx, ref);
  if (!listing.ok) return listing;
  const resource = listing.value.resources.find((r) => r.id === resourceId);
  if (!resource) {
    return err({
      code: "resource_not_found",
      message: `Review resource "${resourceId}" not found on review ${listing.value.review._ulid}.`,
      resource_id: resourceId,
    });
  }
  return { ok: true, value: { review: listing.value.review, resource } };
}

/**
 * Resolve the absolute on-disk path of a review resource by id using the
 * symlink-safe resolver. The manifest is consulted first so every read
 * surface gets the same `resource_not_found` rejection for undeclared
 * ids regardless of which file happens to live on disk.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export async function resolveReviewResourceFile(
  ctx: KspecContext,
  ref: string,
  resourceId: string,
): Promise<
  ReviewResourceResult<{
    review: LoadedReviewRecord;
    resource: ResourceMetadata;
    absolutePath: string;
  }>
> {
  const fetched = await getReviewResource(ctx, ref, resourceId);
  if (!fetched.ok) return fetched;
  const reviewDir = getReviewDir(ctx, fetched.value.review._ulid);
  const manifest: ResourceManifest = {
    resources: [fetched.value.resource],
  };
  const resolution = await resolveResourcePath({
    ownerResourcesDir: getResourcesDir(reviewDir),
    relativePath: fetched.value.resource.path,
    manifest,
  });
  if (!resolution.ok) {
    return err({
      code: "resource_not_found",
      message: resolution.error,
      resource_id: resourceId,
      path: fetched.value.resource.path,
    });
  }
  return {
    ok: true,
    value: {
      review: fetched.value.review,
      resource: fetched.value.resource,
      absolutePath: resolution.value.absolutePath,
    },
  };
}

// ── Write ───────────────────────────────────────────────────────────────────

export interface AddReviewResourceOptions {
  id: string;
  /** Relative POSIX path under `<reviewDir>/resources/`. */
  relativePath: string;
  /** Absolute path to the source file whose bytes will be copied in. */
  sourceFile: string;
  contentType?: string | null;
  label?: string | null;
  description?: string | null;
  /**
   * When true, allow updating an existing resource id and replacing its
   * file bytes / metadata. Without replace, id or path collisions surface
   * `resource_conflict` so callers can decide to abort or retry.
   */
  replace?: boolean;
  /**
   * Test seam — when `false`, the metadata writer skips capturing git
   * identity so deterministic byte/hash assertions don't depend on the
   * surrounding repo state. Defaults to `true` so production calls retain
   * the @trait-entity-scoped-local-resources-1 versioning contract.
   */
  captureGit?: boolean;
}

export interface AddReviewResourceResult {
  review: LoadedReviewRecord;
  resource: ResourceMetadata;
  /** True iff an existing resource id had its bytes/metadata rewritten. */
  replaced: boolean;
}

/**
 * Validate the source file before any bytes are read or written. Mirrors
 * the source_file_* error codes the CLI/daemon contracts require and
 * keeps the per-error context (path) attached for structured responses.
 */
async function validateSourceFile(
  sourceFile: string,
): Promise<ReviewResourceResult<{ absolutePath: string }>> {
  if (typeof sourceFile !== "string" || sourceFile.length === 0) {
    return err({
      code: "source_file_missing",
      message: "Source file path is required and must be a non-empty string.",
      source_file: sourceFile ?? null,
    });
  }
  const absolutePath = path.resolve(sourceFile);
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      return err({
        code: "source_file_missing",
        message: `Source file "${sourceFile}" does not exist.`,
        source_file: sourceFile,
      });
    }
    return err({
      code: "source_file_unreadable",
      message: `Source file "${sourceFile}" could not be inspected: ${e instanceof Error ? e.message : String(e)}.`,
      source_file: sourceFile,
    });
  }
  if (!stat.isFile()) {
    return err({
      code: "source_file_unreadable",
      message: `Source file "${sourceFile}" is not a regular file; only files can be attached as review resources.`,
      source_file: sourceFile,
    });
  }
  return { ok: true, value: { absolutePath } };
}

/**
 * Add (or replace) a single review resource.
 *
 * Validation order matches the CLI/daemon contract:
 *   1. resource id format
 *   2. resource relative path format
 *   3. content-type format (only if explicitly supplied)
 *   4. source-file existence / readability
 *   5. id-and-path collision rules vs the current manifest
 *
 * On success the source bytes are streamed into the review's
 * `resources/` directory, a fresh `ResourceMetadata` record is computed
 * with SHA-256 + git identity, and the review record is re-saved so the
 * lean index summary updates and shadow-branch auto-commits fire.
 *
 * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export async function addReviewResource(
  ctx: KspecContext,
  ref: string,
  options: AddReviewResourceOptions,
): Promise<ReviewResourceResult<AddReviewResourceResult>> {
  // Run id/path/content-type validation BEFORE the review lookup so callers
  // get the same response shape regardless of which review they tried to
  // attach to. Source-file checks also run before any review-folder I/O.
  const idValidation = validateResourceId(options.id);
  if (!idValidation.ok) {
    return err({
      code: "invalid_resource_id",
      message: idValidation.error,
      resource_id: options.id,
    });
  }
  const pathValidation = validateResourceRelativePath(options.relativePath);
  if (!pathValidation.ok) {
    return err({
      code: "invalid_resource_path",
      message: pathValidation.error,
      path: options.relativePath,
    });
  }
  if (options.contentType !== undefined && options.contentType !== null) {
    const contentTypeResolved = resolveContentType(options.contentType, options.relativePath);
    if (!contentTypeResolved.ok) {
      return err({
        code: "invalid_content_type",
        message: contentTypeResolved.error,
        resource_id: options.id,
        path: options.relativePath,
      });
    }
  }
  const sourceValidation = await validateSourceFile(options.sourceFile);
  if (!sourceValidation.ok) return sourceValidation;

  const lookup = await findReviewForResource(ctx, ref);
  if (!lookup.ok) return lookup;
  const review = lookup.value;
  const reviewDir = getReviewDir(ctx, review._ulid);
  const resourcesDir = getResourcesDir(reviewDir);

  const manifest = await loadResourceManifest(reviewDir);
  const existingById = manifest.resources.find((r) => r.id === options.id);
  const existingByPath = manifest.resources.find((r) => r.path === options.relativePath);

  // Conflict rules per task description:
  //   - Without --replace, any id-or-path collision is a hard conflict.
  //   - With --replace, the id MUST match an existing resource; the path
  //     may move so long as it does not collide with a *different* id.
  if (existingById && !options.replace) {
    return err({
      code: "resource_conflict",
      message: `Resource id "${options.id}" already exists on review ${review._ulid}; re-run with --replace to update it.`,
      resource_id: options.id,
      path: options.relativePath,
    });
  }
  if (existingByPath && (!options.replace || existingByPath.id !== options.id)) {
    return err({
      code: "resource_conflict",
      message: `Resource path "${options.relativePath}" is already owned by ${existingByPath.id === options.id ? "this resource" : `resource "${existingByPath.id}"`} on review ${review._ulid}; remove the existing entry or use a different path.`,
      resource_id: options.id,
      path: options.relativePath,
    });
  }
  if (options.replace && !existingById) {
    return err({
      code: "resource_not_found",
      message: `Resource id "${options.id}" does not exist on review ${review._ulid}; --replace requires the id to already be declared.`,
      resource_id: options.id,
      path: options.relativePath,
    });
  }

  // Copy source bytes into the owning review's resources tree. Path traversal
  // and symlink escape are already rejected by validateResourceRelativePath
  // (and by the schema at manifest write time), so a plain join is safe.
  const destAbsolute = path.join(resourcesDir, options.relativePath);
  await fs.mkdir(path.dirname(destAbsolute), { recursive: true });
  await fs.copyFile(sourceValidation.value.absolutePath, destAbsolute);

  // If we're replacing and the path moved, remove the old file so the
  // resources/ tree only contains files declared by the current manifest.
  if (existingById && existingById.path !== options.relativePath) {
    const oldAbsolute = path.join(resourcesDir, existingById.path);
    await fs.rm(oldAbsolute, { force: true }).catch(() => {});
  }

  const metadata = await computeResourceMetadata({
    id: options.id,
    relativePath: options.relativePath,
    absolutePath: destAbsolute,
    contentType: options.contentType,
    label: options.label ?? null,
    description: options.description ?? null,
    captureGit: options.captureGit,
  });
  if (!metadata.ok) {
    return err({
      code: "source_file_unreadable",
      message: metadata.error,
      resource_id: options.id,
      path: options.relativePath,
      source_file: options.sourceFile,
    });
  }

  // Upsert by id so a replace updates exactly one entry in place.
  const updated = existingById
    ? manifest.resources.map((r) => (r.id === options.id ? metadata.value : r))
    : [...manifest.resources, metadata.value];
  await writeResourceManifest(reviewDir, { resources: updated });

  // Re-save the review record so its lean-index resource_summary updates
  // and shadow-branch auto-commits fire under the same atomic write the
  // detail rewrite already uses.
  await saveReviewRecordToFolder(ctx, review);

  return {
    ok: true,
    value: {
      review,
      resource: metadata.value,
      replaced: Boolean(existingById),
    },
  };
}

/**
 * Remove a single review resource by id. Both the manifest entry and the
 * owned file are deleted in a single mutation; the review record is then
 * re-saved so the lean index resource_summary refreshes.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
 */
export async function removeReviewResource(
  ctx: KspecContext,
  ref: string,
  resourceId: string,
): Promise<ReviewResourceResult<{ review: LoadedReviewRecord; removed: { id: string; path: string } }>> {
  const fetched = await getReviewResource(ctx, ref, resourceId);
  if (!fetched.ok) return fetched;
  const review = fetched.value.review;
  const resource = fetched.value.resource;
  const reviewDir = getReviewDir(ctx, review._ulid);
  const resourcesDir = getResourcesDir(reviewDir);
  const manifest = await loadResourceManifest(reviewDir);

  const updated = manifest.resources.filter((r) => r.id !== resourceId);
  await writeResourceManifest(reviewDir, { resources: updated });
  await fs.rm(path.join(resourcesDir, resource.path), { force: true }).catch(() => {});

  await saveReviewRecordToFolder(ctx, review);

  return {
    ok: true,
    value: {
      review,
      removed: { id: resource.id, path: resource.path },
    },
  };
}
