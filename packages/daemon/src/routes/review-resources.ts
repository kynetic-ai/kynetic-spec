/**
 * Review Resource API Routes — list, single metadata, raw bytes, create/replace
 * (multipart), and delete.
 *
 * Endpoints (all rooted at /api/reviews/:ref/resources/...):
 *   - GET    /api/reviews/:ref/resources              → list metadata
 *   - GET    /api/reviews/:ref/resources/:resourceId  → single metadata
 *   - GET    /api/reviews/:ref/resources/:resourceId/bytes
 *                                                    → raw file bytes with
 *                                                      Content-Type and
 *                                                      X-Kspec-Resource-Sha256
 *   - POST   /api/reviews/:ref/resources              → multipart create/replace
 *   - DELETE /api/reviews/:ref/resources/:resourceId  → delete entry + file
 *
 * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 * AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { Elysia, t } from "elysia";

import {
  addReviewResource,
  getReviewResource,
  initContext,
  listReviewResources,
  removeReviewResource,
  resolveReviewResourceFile,
  type ReviewResourceError,
} from "../../parser/index.js";
import type { ResourceMetadata } from "../../schema/resources.js";
import type { PubSubManager } from "../websocket/pubsub.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";
import { entityStorageIncompatibilityResponse } from "./entity-storage-error.js";
import { runRouteMutation } from "./mutation-pipeline.js";

interface ReviewResourcesRouteOptions {
  pubsub?: PubSubManager;
  getEntityCache?: EntityCacheAccessor;
}

interface ApiErrorBody {
  error: string;
  code: string;
  message: string;
  resource_id: string | null;
  path: string | null;
}

/**
 * Map a {@link ReviewResourceError} code onto its documented HTTP status
 * per the task contract:
 *   - invalid_resource_id / invalid_resource_path → 400
 *   - source_file_missing / source_file_unreadable → 400 (multipart bodies
 *     only ever surface as the dedicated `missing_resource_file` 400 below,
 *     so these codes generally won't escape from manager calls at the
 *     daemon boundary; we map defensively all the same)
 *   - review_not_found / resource_not_found → 404
 *   - resource_conflict → 409
 *
 * Note: explicit-but-invalid content_type values surface as
 * `invalid_resource_path` (the documented code) since content type is
 * path-derived metadata — see ReviewResourceErrorCode docs.
 */
function statusForCode(code: ReviewResourceError["code"]): number {
  switch (code) {
    case "review_not_found":
    case "resource_not_found":
      return 404;
    case "resource_conflict":
      return 409;
    case "invalid_resource_id":
    case "invalid_resource_path":
    case "source_file_missing":
    case "source_file_unreadable":
    default:
      return 400;
  }
}

function toApiErrorBody(error: ReviewResourceError, fallbackCode?: string): ApiErrorBody {
  return {
    error: fallbackCode ?? error.code,
    code: error.code,
    message: error.message,
    resource_id: error.resource_id ?? null,
    path: error.path ?? null,
  };
}

/**
 * Parse a `replace` multipart text field per the task contract:
 *   - undefined → false
 *   - "true" / "1" → true
 *   - "false" / "0" → false
 *   - anything else → ok: false (callers map to 400 invalid_replace_value)
 */
function parseReplaceField(value: unknown): { ok: true; value: boolean } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: false };
  if (value === "true" || value === "1") return { ok: true, value: true };
  if (value === "false" || value === "0") return { ok: true, value: false };
  return { ok: false };
}

/**
 * Pull the first non-empty string for a multipart text field, ignoring
 * empty strings emitted by browsers/clients that always send a placeholder
 * value. `id`, `path`, etc. are required-but-coerced strings; treat missing
 * or empty as undefined so manager validation produces the right error.
 */
function readTextField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0) return undefined;
  return value;
}

/**
 * Pull a text field that distinguishes "absent" from "explicitly empty".
 * Used for `content_type` (and any other field where an empty value is
 * a contract violation that must surface as a validation error rather
 * than silently falling back to the omitted-field default).
 *
 * Returns:
 *   - `undefined` when the multipart field is absent or non-string,
 *   - the original string (including `""`) when present, so downstream
 *     validation can reject empty / malformed values with the documented
 *     error envelope instead of inferring from the path extension.
 *
 * The task contract for `content_type` is explicit: an explicitly
 * provided value must be a non-empty `type/subtype` token; only an
 * omitted value is inferred. Treating `""` as omitted would silently
 * relax that rule. See ReviewResourceErrorCode docs in
 * review-resource-manager.ts for the path-shaped error code mapping.
 */
function readPresentField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value;
}

export function createReviewResourcesRoutes(options: ReviewResourcesRouteOptions = {}) {
  const { pubsub, getEntityCache } = options;

  return (
    new Elysia({ prefix: "/api/reviews" })
      .onError(({ error: err, set }) => {
        const conflict = entityStorageIncompatibilityResponse(err);
        if (conflict) {
          set.status = conflict.status;
          return conflict.body;
        }
      })

      // ── List ────────────────────────────────────────────────────────────
      // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
      .get(
        "/:id/resources",
        async ({ params, error: errorResponse, projectContext }) => {
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          const result = await listReviewResources(ctx, params.id);
          if (!result.ok) {
            return errorResponse(statusForCode(result.error.code), toApiErrorBody(result.error));
          }
          return { resources: result.value.resources };
        },
        { params: t.Object({ id: t.String() }) },
      )

      // ── Single metadata ─────────────────────────────────────────────────
      // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
      .get(
        "/:id/resources/:resourceId/bytes",
        async ({ params, error: errorResponse, projectContext, set }) => {
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          const result = await resolveReviewResourceFile(ctx, params.id, params.resourceId);
          if (!result.ok) {
            return errorResponse(statusForCode(result.error.code), toApiErrorBody(result.error));
          }
          let bytes: Buffer;
          try {
            bytes = await fs.readFile(result.value.absolutePath);
          } catch (e) {
            return errorResponse(500, {
              error: "io_error",
              code: "io_error",
              message: `Failed to read resource file: ${e instanceof Error ? e.message : String(e)}`,
              resource_id: params.resourceId,
              path: result.value.resource.path,
            });
          }
          set.headers["content-type"] = result.value.resource.content_type;
          set.headers["x-kspec-resource-sha256"] = result.value.resource.sha256;
          set.headers["content-length"] = String(bytes.byteLength);
          return new Response(bytes, { headers: set.headers as Record<string, string> });
        },
        {
          params: t.Object({
            id: t.String(),
            resourceId: t.String(),
          }),
        },
      )

      .get(
        "/:id/resources/:resourceId",
        async ({ params, error: errorResponse, projectContext }) => {
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          const result = await getReviewResource(ctx, params.id, params.resourceId);
          if (!result.ok) {
            return errorResponse(statusForCode(result.error.code), toApiErrorBody(result.error));
          }
          return { resource: result.value.resource };
        },
        {
          params: t.Object({
            id: t.String(),
            resourceId: t.String(),
          }),
        },
      )

      // ── Create / Replace (multipart) ────────────────────────────────────
      // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
      // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
      // AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
      .post(
        "/:id/resources",
        async ({ params, request, error: errorResponse, projectContext, set }) => {
          // Bun/Elysia provide a Web Standards Request; multipart bodies arrive
          // as a FormData when the Content-Type is multipart/form-data. We
          // intentionally parse the form here (rather than via Elysia's body
          // schema) so we can validate text fields against the documented
          // contract — invalid `replace` values, missing `file`, etc. — and
          // return the precise error envelopes the task description requires.
          let form: FormData;
          try {
            form = await request.formData();
          } catch {
            return errorResponse(400, {
              error: "invalid_multipart",
              code: "invalid_multipart",
              message:
                "Request body must be multipart/form-data with at least a 'file' field plus 'id' and 'path' text fields.",
              resource_id: null,
              path: null,
            });
          }

          const file = form.get("file");
          if (!(file instanceof File)) {
            return errorResponse(400, {
              error: "missing_resource_file",
              code: "missing_resource_file",
              message: "Multipart request is missing the required 'file' field.",
              resource_id: null,
              path: null,
            });
          }

          const id = readTextField(form.get("id"));
          const relativePath = readTextField(form.get("path"));
          const label = readTextField(form.get("label")) ?? null;
          const description = readTextField(form.get("description")) ?? null;
          // content_type uses readPresentField — an explicitly supplied
          // empty string must reach the manager so it surfaces as the
          // documented invalid_resource_path 400, not silently fall back
          // to extension inference (task contract: explicit values must
          // be non-empty type/subtype tokens).
          const contentTypeField = readPresentField(form.get("content_type"));
          const contentType = contentTypeField === undefined ? null : contentTypeField;
          const replaceParsed = parseReplaceField(form.get("replace") as unknown);
          if (!replaceParsed.ok) {
            return errorResponse(400, {
              error: "invalid_replace_value",
              code: "invalid_replace_value",
              message:
                'Multipart field "replace" must be exactly "true", "false", "1", or "0" when present.',
              resource_id: id ?? null,
              path: relativePath ?? null,
            });
          }

          if (!id) {
            return errorResponse(400, {
              error: "invalid_resource_id",
              code: "invalid_resource_id",
              message: "Multipart request is missing the required 'id' field.",
              resource_id: null,
              path: relativePath ?? null,
            });
          }
          if (!relativePath) {
            return errorResponse(400, {
              error: "invalid_resource_path",
              code: "invalid_resource_path",
              message: "Multipart request is missing the required 'path' field.",
              resource_id: id,
              path: null,
            });
          }

          // Spool the upload into a temp file so the manager can stream-hash
          // and copy through the shared helper without us also re-implementing
          // the storage path. The temp file lives outside the spec dir so a
          // mid-write failure cannot leave half-written bytes inside the
          // owning review's resources/ tree.
          const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-review-resource-"));
          const tempFile = path.join(tempDir, `upload-${randomUUID()}`);
          try {
            const bytes = Buffer.from(await file.arrayBuffer());
            await fs.writeFile(tempFile, bytes);

            const ctx = await initContext(projectContext.path);
            const result = await addReviewResource(ctx, params.id, {
              id,
              relativePath,
              sourceFile: tempFile,
              contentType,
              label,
              description,
              replace: replaceParsed.value,
            });

            if (!result.ok) {
              return errorResponse(statusForCode(result.error.code), toApiErrorBody(result.error));
            }

            await runRouteMutation({
              ctx,
              projectPath: projectContext.path,
              getEntityCache,
              pubsub,
              apply: () => undefined,
              commit: {
                operation: "review-resource-add",
                ref: result.value.review.slugs[0] || result.value.review._ulid.slice(0, 8),
                detail: `${id} → ${relativePath}`,
              },
              writeThrough: [{ domain: "reviews" }],
              events: [
                {
                  topic: "reviews:updates",
                  event: "resource_changed",
                  data: {
                    review_ulid: result.value.review._ulid,
                    resource_id: id,
                    action: result.value.replaced ? "replaced" : "added",
                  },
                },
              ],
            });

            set.status = result.value.replaced ? 200 : 201;
            return { resource: result.value.resource, replaced: result.value.replaced };
          } finally {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
          }
        },
        { params: t.Object({ id: t.String() }) },
      )

      // ── Delete ──────────────────────────────────────────────────────────
      // AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
      .delete(
        "/:id/resources/:resourceId",
        async ({ params, error: errorResponse, projectContext }) => {
          const ctx = await initContext(projectContext.path);
          const result = await removeReviewResource(ctx, params.id, params.resourceId);
          if (!result.ok) {
            return errorResponse(statusForCode(result.error.code), toApiErrorBody(result.error));
          }

          await runRouteMutation({
            ctx,
            projectPath: projectContext.path,
            getEntityCache,
            pubsub,
            apply: () => undefined,
            commit: {
              operation: "review-resource-remove",
              ref: result.value.review.slugs[0] || result.value.review._ulid.slice(0, 8),
              detail: `${result.value.removed.id} (${result.value.removed.path})`,
            },
            writeThrough: [{ domain: "reviews" }],
            events: [
              {
                topic: "reviews:updates",
                event: "resource_changed",
                data: {
                  review_ulid: result.value.review._ulid,
                  resource_id: result.value.removed.id,
                  action: "removed",
                },
              },
            ],
          });

          return { removed: result.value.removed };
        },
        {
          params: t.Object({
            id: t.String(),
            resourceId: t.String(),
          }),
        },
      )
  );
}

/**
 * Map a single resource into the documented response shape. Exported for
 * cases (tests, static export) where callers want the same projection the
 * routes use without duplicating field selection.
 */
export function resourceMetadataResponse(resource: ResourceMetadata) {
  return { resource };
}
