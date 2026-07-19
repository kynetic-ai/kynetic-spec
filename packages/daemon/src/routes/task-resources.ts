/**
 * Task Resource API Routes — task-scoped resolution of a task's versioned
 * `resource_refs`, layered on the shared task resource resolver and the
 * entity-local-resources trait foundation.
 *
 * Endpoints (all rooted at /api/tasks/:ref/resources/...):
 *   - GET /api/tasks/:ref/resources
 *         → the task-detail `resolved_resources` projection plus the
 *           task-scoped `resources_base_url`.
 *   - GET /api/tasks/:ref/resources/:resourceId
 *         → one resolved-resource projection entry (carries drift/missing/
 *           unresolved status), or a structured 404 when the task has no
 *           matching `resource_refs` id.
 *   - GET /api/tasks/:ref/resources/:resourceId/bytes
 *         → raw bytes ONLY when the resolved resource status is `present`,
 *           with Content-Type, Content-Length, and X-Kspec-Resource-Sha256
 *           from the current matching owner-manifest entry. For drift,
 *           missing, or unresolved the route returns a structured non-2xx
 *           response that names the status and never streams replacement
 *           bytes that differ from the hash recorded at task derivation.
 *
 * Resolution reuses the SAME path as `kspec task get --json`, the agent
 * dispatch context, and the daemon task-detail route (`resolveTaskResources`
 * + `projectResolvedTaskResources`), so every surface reports identical drift
 * status for the same reference. Plan-owned refs resolve through the source
 * plan's manifest; task-owned copies resolve through the current task's
 * manifest. Byte resolution always goes through the symlink-safe
 * `resolveResourcePath` helper — user-authored relative paths are never
 * raw-joined onto a directory.
 *
 * This plugin co-mounts on the `/api/tasks` prefix alongside `createTasksRoutes`
 * (the same way `createPlanResourcesRoutes` co-mounts with `createPlansRoutes`),
 * so it inherits the project-context middleware: browser `<img src>` / `<a href>`
 * requests that cannot send the `X-Kspec-Dir` header carry the selected
 * project's path as a `?kspec_dir=` query parameter, exactly like review and
 * plan resource bytes URLs.
 *
 * Spec: @task-resource-resolution-api-contract
 *       @live-task-resource-markdown-rendering
 */

import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";

import { Elysia, t } from "elysia";

import {
  initContext,
  resolveTaskDataManager,
  TaskDataManagerError,
  resolveTaskResources,
  projectResolvedTaskResources,
  findPlanByRef,
  getResourcesDir,
  loadResourceManifest,
  resolveResourcePath,
  type LoadedTask,
  type ResolvedTaskResource,
} from "../../parser/index.js";
import { getPlanDir } from "../../parser/plan-storage-manager.js";
import { getTaskDir } from "../../parser/split-backend.js";
import { taskStorageIncompatibilityResponse } from "./task-storage-error.js";
import { entityStorageIncompatibilityResponse } from "./entity-storage-error.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";

interface TaskResourcesRouteOptions {
  getEntityCache?: EntityCacheAccessor;
}

type TaskResourceErrorCode =
  | "task_not_found"
  | "resource_not_found"
  | "resource_drift"
  | "resource_missing"
  | "resource_unresolved"
  | "io_error";

interface TaskResourceErrorBody {
  error: TaskResourceErrorCode;
  code: TaskResourceErrorCode;
  message: string;
  resource_id: string | null;
  path: string | null;
  /**
   * The exact task-resource resolution status when the refusal is caused by a
   * non-`present` reference (`drift`, `missing`, `unresolved`). Null for
   * structural errors (task/resource not found, io failure) that are not tied
   * to a resolution status. Naming the status is the contract requirement for
   * drift-safe refusal — clients must be able to distinguish "the bytes
   * changed since derivation" from "the resource was never declared".
   */
  status: ResolvedTaskResource["status"] | null;
}

function errorBody(
  code: TaskResourceErrorCode,
  message: string,
  options: {
    resourceId?: string | null;
    path?: string | null;
    status?: ResolvedTaskResource["status"] | null;
  } = {},
): TaskResourceErrorBody {
  return {
    error: code,
    code,
    message,
    resource_id: options.resourceId ?? null,
    path: options.path ?? null,
    status: options.status ?? null,
  };
}

/**
 * Build the task-scoped base URL clients use to fetch resolved-resource bytes
 * via `${base}/${encodeURIComponent(id)}/bytes`. Identical to the value the
 * task-detail route surfaces on `TaskDetail.resources_base_url`, so the list
 * route is a stable companion that does not require the caller to know
 * plan-owned vs task-owned ownership. Exported for the review content route,
 * which embeds the same base URL in task resource context.
 */
export function buildTaskResourcesBaseUrl(taskUlid: string): string {
  return `/api/tasks/${taskUlid}/resources`;
}

/**
 * Resolve a task ref to its loaded task, mapping the documented failure modes
 * onto structured responses: deterministic task-storage incompatibility →
 * shared 409, unknown ref → 404. Returns the loaded task on success.
 */
async function resolveTaskForResources(
  ctx: Awaited<ReturnType<typeof initContext>>,
  ref: string,
  cache: ReturnType<EntityCacheAccessor> | null | undefined,
): Promise<{ ok: true; task: LoadedTask } | { ok: false; status: number; body: unknown }> {
  try {
    const task = await resolveTaskDataManager(ctx).getTask(ctx, ref);
    return { ok: true, task };
  } catch (err) {
    const conflict = taskStorageIncompatibilityResponse(err, { cache });
    if (conflict) return { ok: false, status: conflict.status, body: conflict.body };
    if (err instanceof TaskDataManagerError) {
      return {
        ok: false,
        status: 404,
        body: errorBody("task_not_found", `Task reference "${ref}" not found`),
      };
    }
    throw err;
  }
}

/**
 * Resolve the owning entity's folder for one resolved task resource reference.
 * Plan-owned refs resolve through the source plan's folder; task-owned copies
 * resolve through the current task's folder. Returns null when the owner cannot
 * be located (which only happens for `unresolved` references — `present`
 * references always have a locatable owner). The caller derives the manifest
 * (`loadResourceManifest`) and resources directory (`getResourcesDir`) from
 * this entity folder so byte resolution always flows through the symlink-safe
 * helper rather than a raw path join.
 */
async function resolveOwnerEntityDir(
  ctx: Awaited<ReturnType<typeof initContext>>,
  resolved: ResolvedTaskResource,
  task: LoadedTask,
): Promise<string | null> {
  if (resolved.reference.owner_type === "plan") {
    const plan = await findPlanByRef(ctx, resolved.reference.owner_ref);
    if (!plan) return null;
    return getPlanDir(ctx, plan._ulid);
  }
  // owner_type === "task": the current task owns the copy. The resolver has
  // already confirmed the reference belongs to this task before marking it
  // `present`, so we serve from this task's folder.
  return getTaskDir(ctx, task._ulid);
}

/**
 * Map a non-`present` resolution status onto its drift-safe refusal response.
 * Drift is a conflict (409) — the bytes exist but differ from the version the
 * task was derived against. Missing/unresolved are 404 — there is nothing to
 * serve. Every body names the exact status so callers can surface it instead
 * of silently substituting different bytes.
 */
function refusalForStatus(
  resolved: ResolvedTaskResource,
  resourceId: string,
): { status: number; body: TaskResourceErrorBody } {
  switch (resolved.status) {
    case "drift":
      return {
        status: 409,
        body: errorBody("resource_drift", resolved.message, {
          resourceId,
          path: resolved.reference.path,
          status: "drift",
        }),
      };
    case "missing":
      return {
        status: 404,
        body: errorBody("resource_missing", resolved.message, {
          resourceId,
          path: resolved.reference.path,
          status: "missing",
        }),
      };
    case "unresolved":
    default:
      return {
        status: 404,
        body: errorBody("resource_unresolved", resolved.message, {
          resourceId,
          path: resolved.reference.path,
          status: "unresolved",
        }),
      };
  }
}

export function createTaskResourcesRoutes(options: TaskResourcesRouteOptions = {}) {
  const { getEntityCache } = options;

  return (
    new Elysia({ prefix: "/api/tasks" })
      // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
      .onError(({ error: err, set }) => {
        const conflict = entityStorageIncompatibilityResponse(err);
        if (conflict) {
          set.status = conflict.status;
          return conflict.body;
        }
      })

      // ── List resolved resources ──────────────────────────────────────────
      // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resolved-resources
      // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resource-base-url
      .get(
        "/:ref/resources",
        async ({ params, projectContext, set }) => {
          const cache = getEntityCache?.(projectContext.path);
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          const resolvedTask = await resolveTaskForResources(ctx, params.ref, cache);
          if (!resolvedTask.ok) {
            set.status = resolvedTask.status;
            return resolvedTask.body;
          }
          const resolved = await resolveTaskResources(ctx, resolvedTask.task);
          return {
            resolved_resources: projectResolvedTaskResources(resolved),
            resources_base_url: buildTaskResourcesBaseUrl(resolvedTask.task._ulid),
          };
        },
        { params: t.Object({ ref: t.String() }) },
      )

      // ── Single resolved resource (bytes) ─────────────────────────────────
      // The `/bytes` route is registered before `/:resourceId` so the extra
      // static segment always wins; Elysia route specificity also covers this,
      // but explicit ordering keeps the contract obvious.
      // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-serve-present-plan-owned-ref
      // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-serve-present-task-owned-copy
      // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-refuse-drifted-or-missing-ref
      // AC: @live-task-resource-markdown-rendering ac-drifted-task-resource-is-visible-not-silent
      .get(
        "/:ref/resources/:resourceId/bytes",
        async ({ params, projectContext, set }) => {
          const cache = getEntityCache?.(projectContext.path);
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          const resolvedTask = await resolveTaskForResources(ctx, params.ref, cache);
          if (!resolvedTask.ok) {
            set.status = resolvedTask.status;
            return resolvedTask.body;
          }

          const resolvedRefs = await resolveTaskResources(ctx, resolvedTask.task);
          // Match by recorded reference id. The param is only ever compared,
          // never joined onto a filesystem path, so traversal is impossible
          // here — the served path comes exclusively from the owner manifest.
          const match = resolvedRefs.find((r) => r.reference.id === params.resourceId);
          if (!match) {
            set.status = 404;
            return errorBody(
              "resource_not_found",
              `Task "${params.ref}" has no resource reference with id "${params.resourceId}".`,
              { resourceId: params.resourceId },
            );
          }

          // Drift-safe refusal: only `present` references stream bytes. Drift,
          // missing, and unresolved each surface a structured non-2xx that
          // names the status and serves no replacement bytes.
          if (match.status !== "present") {
            const refusal = refusalForStatus(match, params.resourceId);
            set.status = refusal.status;
            return refusal.body;
          }

          const current = match.current;
          // `present` guarantees a current owner-manifest entry; this is a
          // defensive guard for the impossible null so the type narrows.
          if (!current) {
            set.status = 404;
            return errorBody(
              "resource_missing",
              `Resource "${params.resourceId}" resolved as present but its current manifest entry is unavailable.`,
              { resourceId: params.resourceId, path: match.reference.path, status: "missing" },
            );
          }

          const ownerEntityDir = await resolveOwnerEntityDir(ctx, match, resolvedTask.task);
          if (!ownerEntityDir) {
            set.status = 404;
            return errorBody(
              "resource_unresolved",
              `Owning ${match.reference.owner_type} ${match.reference.owner_ref} could not be located to serve resource "${params.resourceId}".`,
              { resourceId: params.resourceId, path: match.reference.path, status: "unresolved" },
            );
          }

          // Resolve the current declared path through the symlink-safe helper
          // against the owner's manifest — never a raw path join.
          const manifest = await loadResourceManifest(ownerEntityDir);
          const resolution = await resolveResourcePath({
            ownerResourcesDir: getResourcesDir(ownerEntityDir),
            relativePath: current.path,
            manifest,
          });
          if (!resolution.ok) {
            set.status = 404;
            return errorBody("resource_not_found", resolution.error, {
              resourceId: params.resourceId,
              path: current.path,
            });
          }

          let fileStat;
          try {
            fileStat = await fs.stat(resolution.value.absolutePath);
          } catch {
            set.status = 404;
            return errorBody(
              "resource_not_found",
              `Resource file "${current.path}" is no longer available on disk.`,
              { resourceId: params.resourceId, path: current.path },
            );
          }

          // Headers come from the current matching owner-manifest entry. For a
          // `present` reference the recorded and current hashes are identical,
          // so X-Kspec-Resource-Sha256 also matches the version recorded at
          // task derivation.
          set.headers["Content-Type"] = current.content_type;
          set.headers["Content-Length"] = String(fileStat.size);
          set.headers["X-Kspec-Resource-Sha256"] = current.sha256;
          return new Response(
            createReadStream(resolution.value.absolutePath) as unknown as ReadableStream,
          );
        },
        {
          params: t.Object({
            ref: t.String(),
            resourceId: t.String(),
          }),
        },
      )

      // ── Single resolved resource (metadata) ──────────────────────────────
      // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-refuse-drifted-or-missing-ref
      //     — the detail route reports the exact status for drift/missing/
      //       unresolved references (in the projection) and never streams bytes.
      .get(
        "/:ref/resources/:resourceId",
        async ({ params, projectContext, set }) => {
          const cache = getEntityCache?.(projectContext.path);
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          const resolvedTask = await resolveTaskForResources(ctx, params.ref, cache);
          if (!resolvedTask.ok) {
            set.status = resolvedTask.status;
            return resolvedTask.body;
          }

          const resolvedRefs = await resolveTaskResources(ctx, resolvedTask.task);
          const match = resolvedRefs.find((r) => r.reference.id === params.resourceId);
          if (!match) {
            set.status = 404;
            return errorBody(
              "resource_not_found",
              `Task "${params.ref}" has no resource reference with id "${params.resourceId}".`,
              { resourceId: params.resourceId },
            );
          }

          // The single-entry projection carries the resolution status, so a
          // drifted/missing/unresolved reference is reported here (200) rather
          // than streamed — the bytes route is the one that refuses non-2xx.
          const [projected] = projectResolvedTaskResources([match]);
          return { resolved_resource: projected };
        },
        {
          params: t.Object({
            ref: t.String(),
            resourceId: t.String(),
          }),
        },
      )
  );
}
