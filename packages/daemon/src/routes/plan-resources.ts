/**
 * Plan Resource API Routes
 *
 * Project-scoped REST endpoints for plan-owned local resources, layered on the
 * folder-backed plan storage manager and the shared entity-local-resources
 * trait foundation.
 *
 *   - GET    /api/plans/:ref/resources                       — list metadata
 *   - GET    /api/plans/:ref/resources/:resourceId           — single metadata
 *   - GET    /api/plans/:ref/resources/:resourceId/bytes     — raw bytes
 *   - POST   /api/plans/:ref/resources                       — multipart upload
 *   - DELETE /api/plans/:ref/resources/:resourceId           — remove
 *
 * Mutating routes rely on the existing folder-backed file watcher invalidation
 * (`isFolderBackedEntityChild("plans", ...)`) — no per-route watcher is added.
 *
 * Spec: @folder-backed-plan-storage-1
 *       @trait-entity-scoped-local-resources-1
 *       @entity-folder-migration-and-compatibility-1
 */

import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { Elysia } from "elysia";

import { initContext, findPlanByRef, type LoadedPlan } from "../../parser/index.js";
import {
  requirePlanFolderStorage,
  requireResourceFolderStorage,
} from "../../parser/entity-storage-compatibility.js";
import {
  assertSafeResourceMutationPath,
  captureResourceGitVersion,
  computeResourceMetadata,
  getResourcesDir,
  loadResourceManifest,
  resolveResourcePath,
  validateContentType,
  validateResourceId,
  validateResourceRelativePath,
  writeResourceManifest,
} from "../../parser/entity-local-resources.js";
import { getPlanDir } from "../../parser/plan-storage-manager.js";
import type { ResourceMetadata } from "../../schema/resources.js";
import type { PlanResourceMetadata } from "@kynetic-ai/shared";

import type { PubSubManager } from "../websocket/pubsub.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";
import { entityStorageIncompatibilityResponse } from "./entity-storage-error.js";
import { runRouteMutation } from "./mutation-pipeline.js";

interface PlanResourcesRouteOptions {
  getEntityCache?: EntityCacheAccessor;
  pubsub?: PubSubManager;
}

export type PlanResourceErrorCode =
  | "invalid_resource_id"
  | "invalid_resource_path"
  | "missing_resource_file"
  | "invalid_replace_value"
  | "resource_conflict"
  | "resource_not_found"
  | "plan_not_found";

interface PlanResourceErrorBody {
  error: PlanResourceErrorCode;
  code: PlanResourceErrorCode;
  message: string;
  resource_id: string | null;
  path: string | null;
}

function errorBody(
  code: PlanResourceErrorCode,
  message: string,
  resourceId: string | null = null,
  resourcePath: string | null = null,
): PlanResourceErrorBody {
  return { error: code, code, message, resource_id: resourceId, path: resourcePath };
}

/**
 * Build the safe, project-scoped base URL clients use to fetch per-resource
 * bytes via `${base}/${encodeURIComponent(id)}/bytes`. Exposed on
 * `PlanDetail.resources_base_url` so the resource metadata shape stays
 * strict (9 fields, no embedded URLs).
 */
export function buildResourcesBaseUrl(planUlid: string): string {
  return `/api/plans/${planUlid}/resources`;
}

/**
 * Project a stored `ResourceMetadata` into the strict `PlanResourceMetadata`
 * API shape. Mirrors `ResourceMetadata` exactly — clients build bytes URLs
 * from `PlanDetail.resources_base_url`, not from a field embedded in each
 * metadata entry.
 */
export function toPlanResourceMetadata(metadata: ResourceMetadata): PlanResourceMetadata {
  return {
    id: metadata.id,
    label: metadata.label,
    path: metadata.path,
    content_type: metadata.content_type,
    bytes: metadata.bytes,
    sha256: metadata.sha256,
    git_commit: metadata.git_commit,
    git_path: metadata.git_path,
    description: metadata.description,
  };
}

/**
 * Multipart `replace` field parsing rule (task contract): false when omitted,
 * true only when the field value is exactly `true` or `1`, false when exactly
 * `false` or `0`, and any other value fails with `invalid_replace_value`.
 */
function parseReplaceField(value: FormDataEntryValue | null):
  | {
      ok: true;
      value: boolean;
    }
  | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: false };
  if (typeof value !== "string") return { ok: false };
  if (value === "true" || value === "1") return { ok: true, value: true };
  if (value === "false" || value === "0") return { ok: true, value: false };
  return { ok: false };
}

interface ResolvedPlan {
  ulid: string;
  ref: string;
}

/**
 * Resolve a plan ref under folder-backed storage, returning either the plan
 * identity or a structured error envelope. Storage incompatibility surfaces
 * as the shared 409 response; missing plans use the resource 404 envelope.
 */
async function resolvePlanForResources(
  planRef: string,
  projectPath: string,
  cache: ReturnType<EntityCacheAccessor> | null | undefined,
): Promise<
  | { ok: true; ctx: Awaited<ReturnType<typeof initContext>>; plan: ResolvedPlan }
  | { ok: false; status: number; body: unknown }
> {
  let ctx: Awaited<ReturnType<typeof initContext>>;
  try {
    ctx = await initContext(projectPath, { syncMode: "skip" });
  } catch (err) {
    const conflict = entityStorageIncompatibilityResponse(err, { cache });
    if (conflict) return { ok: false, status: conflict.status, body: conflict.body };
    throw err;
  }

  try {
    await requirePlanFolderStorage(ctx);
  } catch (err) {
    const conflict = entityStorageIncompatibilityResponse(err, { cache });
    if (conflict) return { ok: false, status: conflict.status, body: conflict.body };
    throw err;
  }

  // Plan resource routes also require entity-scoped local resource storage
  // (`resource_storage.format: entity_scoped`) — folder-backed plans alone
  // are not sufficient. Surface the shared structured 409 envelope when the
  // manifest is missing or declares a different format, so the resource API
  // never silently accepts requests against a project whose resource storage
  // contract has not been migrated.
  try {
    await requireResourceFolderStorage(ctx);
  } catch (err) {
    const conflict = entityStorageIncompatibilityResponse(err, { cache });
    if (conflict) return { ok: false, status: conflict.status, body: conflict.body };
    throw err;
  }

  let plan: LoadedPlan | undefined;
  try {
    plan = await findPlanByRef(ctx, planRef);
  } catch (err) {
    const conflict = entityStorageIncompatibilityResponse(err, { cache });
    if (conflict) return { ok: false, status: conflict.status, body: conflict.body };
    throw err;
  }
  if (!plan) {
    return {
      ok: false,
      status: 404,
      body: errorBody("plan_not_found", `Plan reference "${planRef}" not found`),
    };
  }
  return {
    ok: true,
    ctx,
    plan: {
      ulid: plan._ulid,
      ref: plan.slugs[0] ? `@${plan.slugs[0]}` : `@${plan._ulid}`,
    },
  };
}

export function createPlanResourcesRoutes(options: PlanResourcesRouteOptions = {}) {
  const { getEntityCache, pubsub } = options;

  return (
    new Elysia({ prefix: "/api/plans" })
      // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
      .onError(({ error: err, set }) => {
        const conflict = entityStorageIncompatibilityResponse(err);
        if (conflict) {
          set.status = conflict.status;
          return conflict.body;
        }
      })
      // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
      .get("/:ref/resources", async ({ params, projectContext, set }) => {
        const cache = getEntityCache?.(projectContext.path);
        const resolved = await resolvePlanForResources(params.ref, projectContext.path, cache);
        if (!resolved.ok) {
          set.status = resolved.status;
          return resolved.body;
        }
        const manifest = await loadResourceManifest(getPlanDir(resolved.ctx, resolved.plan.ulid));
        return {
          resources: manifest.resources.map((r) => toPlanResourceMetadata(r)),
        };
      })
      // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
      .get("/:ref/resources/:resourceId", async ({ params, projectContext, set }) => {
        const cache = getEntityCache?.(projectContext.path);
        const idValidation = validateResourceId(params.resourceId);
        if (!idValidation.ok) {
          set.status = 400;
          return errorBody("invalid_resource_id", idValidation.error, params.resourceId);
        }
        const resolved = await resolvePlanForResources(params.ref, projectContext.path, cache);
        if (!resolved.ok) {
          set.status = resolved.status;
          return resolved.body;
        }
        const manifest = await loadResourceManifest(getPlanDir(resolved.ctx, resolved.plan.ulid));
        const match = manifest.resources.find((r) => r.id === params.resourceId);
        if (!match) {
          set.status = 404;
          return errorBody(
            "resource_not_found",
            `Resource "${params.resourceId}" not found on plan ${resolved.plan.ref}.`,
            params.resourceId,
          );
        }
        return { resource: toPlanResourceMetadata(match) };
      })
      // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
      // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
      .get("/:ref/resources/:resourceId/bytes", async ({ params, projectContext, set }) => {
        const cache = getEntityCache?.(projectContext.path);
        const idValidation = validateResourceId(params.resourceId);
        if (!idValidation.ok) {
          set.status = 400;
          return errorBody("invalid_resource_id", idValidation.error, params.resourceId);
        }
        const resolved = await resolvePlanForResources(params.ref, projectContext.path, cache);
        if (!resolved.ok) {
          set.status = resolved.status;
          return resolved.body;
        }
        const planDir = getPlanDir(resolved.ctx, resolved.plan.ulid);
        const manifest = await loadResourceManifest(planDir);
        const match = manifest.resources.find((r) => r.id === params.resourceId);
        if (!match) {
          set.status = 404;
          return errorBody(
            "resource_not_found",
            `Resource "${params.resourceId}" not found on plan ${resolved.plan.ref}.`,
            params.resourceId,
          );
        }

        const resolution = await resolveResourcePath({
          ownerResourcesDir: getResourcesDir(planDir),
          relativePath: match.path,
          manifest,
        });
        if (!resolution.ok) {
          set.status = 404;
          return errorBody("resource_not_found", resolution.error, params.resourceId, match.path);
        }

        let fileStat;
        try {
          fileStat = await fs.stat(resolution.value.absolutePath);
        } catch {
          set.status = 404;
          return errorBody(
            "resource_not_found",
            `Resource file "${match.path}" is no longer available on disk.`,
            params.resourceId,
            match.path,
          );
        }

        set.headers["Content-Type"] = match.content_type;
        set.headers["Content-Length"] = String(fileStat.size);
        set.headers["X-Kspec-Resource-Sha256"] = match.sha256;
        return new Response(
          createReadStream(resolution.value.absolutePath) as unknown as ReadableStream,
        );
      })
      // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
      // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
      .post("/:ref/resources", async ({ params, request, projectContext, set }) => {
        const cache = getEntityCache?.(projectContext.path);

        let form: FormData;
        try {
          form = await request.formData();
        } catch (err) {
          set.status = 400;
          return errorBody(
            "missing_resource_file",
            `Failed to parse multipart/form-data body: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const file = form.get("file");
        if (!(file instanceof Blob)) {
          set.status = 400;
          return errorBody("missing_resource_file", "Multipart field 'file' is required.");
        }

        const idField = form.get("id");
        const id = typeof idField === "string" ? idField : "";
        if (!id) {
          set.status = 400;
          return errorBody("invalid_resource_id", "Multipart field 'id' is required.", id || null);
        }
        const idValidation = validateResourceId(id);
        if (!idValidation.ok) {
          set.status = 400;
          return errorBody("invalid_resource_id", idValidation.error, id);
        }

        const pathField = form.get("path");
        const relativePath = typeof pathField === "string" ? pathField : "";
        if (!relativePath) {
          set.status = 400;
          return errorBody(
            "invalid_resource_path",
            "Multipart field 'path' is required.",
            id,
            relativePath || null,
          );
        }
        const pathValidation = validateResourceRelativePath(relativePath);
        if (!pathValidation.ok) {
          set.status = 400;
          return errorBody("invalid_resource_path", pathValidation.error, id, relativePath);
        }

        const replaceResult = parseReplaceField(form.get("replace"));
        if (!replaceResult.ok) {
          set.status = 400;
          return errorBody(
            "invalid_replace_value",
            "Multipart field 'replace' must be one of 'true', '1', 'false', or '0' when supplied.",
            id,
            pathValidation.value,
          );
        }
        const replaceRequested = replaceResult.value;

        const labelField = form.get("label");
        const descriptionField = form.get("description");
        const contentTypeField = form.get("content_type");
        const label = typeof labelField === "string" ? labelField : null;
        const description = typeof descriptionField === "string" ? descriptionField : null;
        const explicitContentType = typeof contentTypeField === "string" ? contentTypeField : null;

        // Explicit content_type rule mirrors the trait foundation: non-empty
        // type/subtype tokens with no whitespace; omitted values are inferred
        // from the path extension; unknown extensions get
        // application/octet-stream. Reuses `validateContentType` for the
        // explicit branch; `computeResourceMetadata` below handles the
        // omitted/extension-based branch.
        if (explicitContentType !== null) {
          const ctValidation = validateContentType(explicitContentType);
          if (!ctValidation.ok) {
            set.status = 400;
            return errorBody("invalid_resource_path", ctValidation.error, id, pathValidation.value);
          }
        }

        const resolved = await resolvePlanForResources(params.ref, projectContext.path, cache);
        if (!resolved.ok) {
          set.status = resolved.status;
          return resolved.body;
        }
        const planDir = getPlanDir(resolved.ctx, resolved.plan.ulid);
        const resourcesDir = getResourcesDir(planDir);
        const manifest = await loadResourceManifest(planDir);

        const existingById = manifest.resources.find((r) => r.id === id);
        const existingByPath = manifest.resources.find((r) => r.path === pathValidation.value);

        if (existingByPath && existingByPath.id !== id) {
          set.status = 409;
          return errorBody(
            "resource_conflict",
            `Path "${pathValidation.value}" is already declared by resource "${existingByPath.id}"; choose a different path or remove the existing entry first.`,
            id,
            pathValidation.value,
          );
        }
        if (existingById && !replaceRequested) {
          set.status = 409;
          return errorBody(
            "resource_conflict",
            `Resource id "${id}" already exists on plan ${resolved.plan.ref}; pass replace=true to overwrite it.`,
            id,
            pathValidation.value,
          );
        }
        if (!existingById && existingByPath && replaceRequested) {
          set.status = 409;
          return errorBody(
            "resource_conflict",
            `Path "${pathValidation.value}" is already declared by resource "${existingByPath.id}"; replace=true only updates the resource matching id.`,
            id,
            pathValidation.value,
          );
        }

        // Validate the destination path safety BEFORE writing any bytes.
        // `assertSafeResourceMutationPath` walks the chain with `lstat` and
        // rejects pre-existing symlinks at the resources root, intermediate
        // segments, or the destination leaf. Running it first means a
        // hostile or stale `resources/` symlink cannot trick a later
        // `fs.mkdir(resourcesDir, { recursive: true })` plus `fs.writeFile`
        // into materialising uploaded bytes outside the owning entity tree.
        const safeDestination = await assertSafeResourceMutationPath({
          ownerResourcesDir: resourcesDir,
          relativePath: pathValidation.value,
        });
        if (!safeDestination.ok) {
          set.status = 400;
          return errorBody(
            "invalid_resource_path",
            safeDestination.error,
            id,
            pathValidation.value,
          );
        }
        if (existingById && existingById.path !== pathValidation.value) {
          const safePrevious = await assertSafeResourceMutationPath({
            ownerResourcesDir: resourcesDir,
            relativePath: existingById.path,
          });
          if (!safePrevious.ok) {
            set.status = 400;
            return errorBody("invalid_resource_path", safePrevious.error, id, existingById.path);
          }
        }

        // Stage uploaded bytes inside the plan directory itself rather than
        // under `resourcesDir`. The plan directory is created and managed by
        // the folder-backed plan storage manager (kspec-owned), so even if a
        // hostile actor swapped `resources/` for a symlink between the safety
        // check above and this write, the temp file still lands in a
        // kspec-controlled directory instead of escaping the entity tree.
        const tempName = `.upload-${id}-${Date.now()}-${process.pid}`;
        const tempPath = path.join(planDir, tempName);
        try {
          const buffer = Buffer.from(await file.arrayBuffer());
          await fs.writeFile(tempPath, buffer);
        } catch (err) {
          set.status = 400;
          await fs.rm(tempPath, { force: true });
          return errorBody(
            "missing_resource_file",
            `Failed to read uploaded file bytes: ${err instanceof Error ? err.message : String(err)}`,
            id,
            pathValidation.value,
          );
        }

        let metadata: ResourceMetadata;
        try {
          const metadataResult = await computeResourceMetadata({
            id,
            relativePath: pathValidation.value,
            absolutePath: tempPath,
            contentType: explicitContentType,
            label,
            description,
            captureGit: false,
          });
          if (!metadataResult.ok) {
            await fs.rm(tempPath, { force: true });
            set.status = 400;
            return errorBody(
              "invalid_resource_path",
              metadataResult.error,
              id,
              pathValidation.value,
            );
          }
          metadata = metadataResult.value;
        } catch (err) {
          await fs.rm(tempPath, { force: true });
          throw err;
        }

        const destination = safeDestination.value.absolutePath;
        await fs.mkdir(path.dirname(destination), { recursive: true });
        try {
          await fs.rename(tempPath, destination);
        } catch (err) {
          await fs.rm(tempPath, { force: true });
          throw err;
        }

        if (existingById && existingById.path !== pathValidation.value) {
          const previousAbsolute = path.join(resourcesDir, existingById.path);
          try {
            await fs.rm(previousAbsolute, { force: true });
          } catch {
            // tolerated — drift will surface via the rebuild-index helper
          }
        }

        const gitVersion = captureResourceGitVersion(destination);
        metadata = {
          ...metadata,
          git_commit: gitVersion.git_commit,
          git_path: gitVersion.git_path,
        };

        const replaced = Boolean(existingById);
        const nextResources = replaced
          ? manifest.resources.map((r) => (r.id === id ? metadata : r))
          : [...manifest.resources, metadata];

        await runRouteMutation({
          ctx: resolved.ctx,
          projectPath: projectContext.path,
          getEntityCache,
          pubsub,
          apply: () => writeResourceManifest(planDir, { resources: nextResources }),
          commit: {
            operation: "plan-resource-api-post",
            ref: resolved.plan.ref,
            detail: `${replaced ? "replaced" : "added"} ${metadata.id} (${metadata.path})`,
          },
          writeThrough: [{ domain: "plans", hint: { ulid: resolved.plan.ulid } }],
          events: [
            {
              topic: "plans:updates",
              event: "plan_resource_changed",
              data: {
                plan_ulid: resolved.plan.ulid,
                resource_id: metadata.id,
                action: replaced ? "replaced" : "added",
              },
            },
          ],
        });

        set.status = replaced ? 200 : 201;
        return {
          resource: toPlanResourceMetadata(metadata),
          replaced,
        };
      })
      // AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
      .delete("/:ref/resources/:resourceId", async ({ params, projectContext, set }) => {
        const cache = getEntityCache?.(projectContext.path);
        const idValidation = validateResourceId(params.resourceId);
        if (!idValidation.ok) {
          set.status = 400;
          return errorBody("invalid_resource_id", idValidation.error, params.resourceId);
        }
        const resolved = await resolvePlanForResources(params.ref, projectContext.path, cache);
        if (!resolved.ok) {
          set.status = resolved.status;
          return resolved.body;
        }
        const planDir = getPlanDir(resolved.ctx, resolved.plan.ulid);
        const resourcesDir = getResourcesDir(planDir);
        const manifest = await loadResourceManifest(planDir);
        const match = manifest.resources.find((r) => r.id === params.resourceId);
        if (!match) {
          set.status = 404;
          return errorBody(
            "resource_not_found",
            `Resource "${params.resourceId}" not found on plan ${resolved.plan.ref}.`,
            params.resourceId,
          );
        }

        const safeFile = await assertSafeResourceMutationPath({
          ownerResourcesDir: resourcesDir,
          relativePath: match.path,
        });
        if (!safeFile.ok) {
          set.status = 400;
          return errorBody("invalid_resource_path", safeFile.error, params.resourceId, match.path);
        }

        await fs.rm(safeFile.value.absolutePath, { force: true });
        const nextResources = manifest.resources.filter((r) => r.id !== params.resourceId);
        await runRouteMutation({
          ctx: resolved.ctx,
          projectPath: projectContext.path,
          getEntityCache,
          pubsub,
          apply: () => writeResourceManifest(planDir, { resources: nextResources }),
          commit: {
            operation: "plan-resource-api-delete",
            ref: resolved.plan.ref,
            detail: `${params.resourceId} (${match.path})`,
          },
          writeThrough: [{ domain: "plans", hint: { ulid: resolved.plan.ulid } }],
          events: [
            {
              topic: "plans:updates",
              event: "plan_resource_changed",
              data: {
                plan_ulid: resolved.plan.ulid,
                resource_id: params.resourceId,
                action: "removed",
              },
            },
          ],
        });

        return { removed: { id: params.resourceId, path: match.path } };
      })
  );
}
