/**
 * Plans API Routes
 *
 * REST endpoints for plan operations:
 * - GET /api/plans - list plans with status filter and task progress
 * - GET /api/plans/:ref - get single plan with content
 *
 * AC Coverage:
 * - @ui-plans-view ac-1: Plan list with title, status, dates, linked counts, progress
 * - @ui-plans-view ac-2: Plan detail with content for expand/detail view
 */

import { Elysia, t } from "elysia";
import {
  initContext,
  loadPlans,
  loadAllItems,
  findPlanByRef,
  resolveTaskDataManager,
  type LoadedPlan,
} from "../../parser/index.js";
import {
  BreadcrumbAncestryResolver,
  type AncestryItemInput,
} from "../../lib/breadcrumb-ancestry.js";
import { requirePlanFolderStorage } from "../../parser/entity-storage-compatibility.js";
import { loadResourceManifest } from "../../parser/entity-local-resources.js";
import { getPlanDir } from "../../parser/plan-storage-manager.js";
import { PlanStatusSchema } from "../../schema/plan.js";
import {
  countPlanTaskProgress,
  getLinkedPlanSummaryTasks,
  isCountedInPlanSummary,
} from "../../lib/plan-summary.js";
import type {
  PlanSummary,
  PlanDetail,
  PlanResourceMetadata,
  PlanResourceSummary,
} from "@kynetic-ai/shared";
import type { PlanSummaryTask } from "../../lib/plan-summary.js";
import type { PlanIndexSummary } from "../../daemon/entity-cache.js";
import { enumArrayUnion } from "./enum-utils.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";
import { wrapResponse } from "./response-envelope.js";
import { taskStorageIncompatibilityResponse } from "./task-storage-error.js";
import { entityStorageIncompatibilityResponse } from "./entity-storage-error.js";
import { buildResourcesBaseUrl, toPlanResourceMetadata } from "./plan-resources.js";

interface PlansRouteOptions {
  getEntityCache?: EntityCacheAccessor;
}

/**
 * Pull the bounded resource summary off a plan record. Both `LoadedPlan`
 * (when populated by the folder-backed loader) and `PlanIndexSummary` may
 * carry an explicit `resource_summary`. Falls back to `{ count: 0,
 * total_bytes: 0 }` so list responses always surface the shape even when
 * the underlying plan declares no resources.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
 */
function extractResourceSummary(plan: LoadedPlan | PlanIndexSummary): PlanResourceSummary {
  const summary = (plan as { resource_summary?: PlanResourceSummary }).resource_summary;
  if (summary && typeof summary.count === "number" && typeof summary.total_bytes === "number") {
    return { count: summary.count, total_bytes: summary.total_bytes };
  }
  return { count: 0, total_bytes: 0 };
}

/**
 * Map a plan (full or summary) to a PlanSummary for the API response.
 * Accepts LoadedPlan or PlanIndexSummary — both have the required fields.
 * Accepts LoadedTask[] or TaskSummary[] — both satisfy PlanSummaryTask.
 *
 * List responses always surface the bounded `resource_summary` projected
 * from the plan index, never the full resource metadata array (which lives
 * on the detail response and is loaded from the per-plan `resources.yaml`
 * sidecar on demand).
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
 */
function toPlanSummary(plan: LoadedPlan | PlanIndexSummary, tasks: PlanSummaryTask[]): PlanSummary {
  const linkedTasks = getLinkedPlanSummaryTasks(plan, tasks);

  return {
    _ulid: plan._ulid,
    slugs: plan.slugs,
    title: plan.title,
    status: plan.status,
    created_at: plan.created_at,
    approved_at: plan.approved_at ?? undefined,
    completed_at: plan.completed_at ?? undefined,
    derived_specs: plan.derived_specs,
    derived_tasks: plan.derived_tasks,
    spec_count: plan.derived_specs.length,
    task_count: linkedTasks.filter((task) => isCountedInPlanSummary(task)).length,
    task_progress: countPlanTaskProgress(linkedTasks),
    resource_summary: extractResourceSummary(plan),
  };
}

/**
 * Load the API-shaped resource metadata for one plan from its sidecar
 * manifest. Returns an empty array when the manifest is absent or
 * unreadable so list/detail routes degrade gracefully.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
async function loadPlanResourcesForApi(
  ctx: Awaited<ReturnType<typeof initContext>>,
  ulid: string,
): Promise<PlanResourceMetadata[]> {
  try {
    const manifest = await loadResourceManifest(getPlanDir(ctx, ulid));
    return manifest.resources.map((r) => toPlanResourceMetadata(r));
  } catch {
    return [];
  }
}

export function createPlansRoutes(_options: PlansRouteOptions = {}) {
  const { getEntityCache } = _options;

  return (
    new Elysia({ prefix: "/api/plans" })
      // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
      //     — catch any plan-storage incompatibility that escapes a per-route
      //     try/catch (e.g. cache-write-through paths) and surface a structured
      //     409 instead of an unhandled 500.
      .onError(({ error: err, set }) => {
        const conflict = entityStorageIncompatibilityResponse(err);
        if (conflict) {
          set.status = conflict.status;
          return conflict.body;
        }
      })
      // AC: @ui-plans-view ac-1 - List plans with progress
      // AC: @daemon-entity-cache ac-serve-from-memory — serve from cache when available
      .get(
        "/",
        async ({ query, error: errorResponse, projectContext }) => {
          // AC: @daemon-entity-cache ac-serve-from-memory — defer initContext for cache hits
          const cache = getEntityCache?.(projectContext.path);

          let _ctx: Awaited<ReturnType<typeof initContext>> | null = null;
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const getCtx = async () => {
            if (!_ctx) _ctx = await initContext(projectContext.path, { syncMode: "skip" });
            return _ctx;
          };

          // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
          const plansDomainState = cache?.getDomainState("plans");
          if (cache && plansDomainState === "loading") {
            return wrapResponse([] as PlanSummary[], { cacheDomainState: "loading", total: 0 });
          }

          // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
          // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
          //     — plan routes require folder-backed plan storage. Reject legacy
          //     projects (kynetic < 1.2 with no plan_storage declaration), 1.2
          //     projects with a missing or non-folder declaration, and partial
          //     folder layouts with a structured 409 before serving any data.
          //
          // AC: @daemon-read-path ac-no-per-request-sync — skip the gate when
          //     the cache has already proved this project is compatible at
          //     load time. The cache loader runs requirePlanFolderStorage()
          //     before loadPlans() during warm-up, so a "ready" plans domain
          //     means the strict gate already passed — incompatible projects
          //     mark the domain "degraded" and fall through to the
          //     gate-at-route-entry path below, where the strict error is
          //     translated into the structured 409 response.
          if (!cache || plansDomainState !== "ready") {
            try {
              await requirePlanFolderStorage(await getCtx());
            } catch (err) {
              const conflict = entityStorageIncompatibilityResponse(err, { cache });
              if (conflict) return errorResponse(conflict.status, conflict.body);
              throw err;
            }
          }

          // Try cache for plans (index tier has PlanIndexSummary, disk fallback gives LoadedPlan)
          // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
          //     — translate plan-storage incompatibility into a structured 409.
          let plans: (LoadedPlan | PlanIndexSummary)[];
          const cachedPlans = cache && plansDomainState === "ready" ? cache.getPlansIndex() : null;
          if (cachedPlans) {
            plans = cachedPlans;
          } else {
            const ctx = await getCtx();
            try {
              plans = await loadPlans(ctx);
            } catch (err) {
              const conflict = entityStorageIncompatibilityResponse(err, { cache });
              if (conflict) return errorResponse(conflict.status, conflict.body);
              throw err;
            }
          }

          // Try cache for tasks (needed for progress computation)
          // AC: @api-contract ac-task-storage-incompatibility-* — translate the
          // storage error into a structured 409 instead of a 500.
          const tasksDomainState = cache?.getDomainState("tasks");
          let tasks;
          if (cache && tasksDomainState === "ready") {
            tasks = cache.getTaskIndex();
          }
          if (!tasks) {
            const ctx = await getCtx();
            try {
              tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
            } catch (err) {
              const conflict = taskStorageIncompatibilityResponse(err, { cache });
              if (conflict) return errorResponse(conflict.status, conflict.body);
              throw err;
            }
          }

          // Apply status filter
          let filtered = plans;
          if (query.status) {
            const statusFilters = Array.isArray(query.status) ? query.status : [query.status];
            filtered = filtered.filter((plan) => statusFilters.includes(plan.status));
          }

          // Sort by created_at descending (newest first)
          const sorted = [...filtered].toSorted(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
          );

          // AC: @ui-plans-view ac-1 - Compute progress for each plan
          // AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
          // AC: @daemon-read-path ac-no-per-request-sync
          //     — list responses are intentionally fast: the lean index never
          //     embeds resource bytes. Both the cache-ready and disk-fallback
          //     paths project the bounded `resource_summary` (count +
          //     total_bytes) carried by `PlanIndexSummary`/`LoadedPlan`. No
          //     per-plan sidecar reads happen here. Full resource metadata is
          //     served on demand by the dedicated resource endpoints
          //     (`GET /api/plans/:ref/resources[/:id[/bytes]]`).
          const items: PlanSummary[] = sorted.map((plan) => toPlanSummary(plan, tasks));

          return wrapResponse(items, { total: items.length, cacheDomainState: plansDomainState });
        },
        {
          query: t.Object({
            status: t.Optional(enumArrayUnion(PlanStatusSchema.options)),
          }),
        },
      )
      // AC: @ui-plans-view ac-2 - Get single plan with content (lazy-loaded by UI on expand)
      // AC: @daemon-entity-cache ac-detail-on-demand — serve from cache when available
      .get("/:ref", async ({ params, error: errorResponse, projectContext }) => {
        // AC: @daemon-entity-cache ac-serve-from-memory — defer initContext for cache hits
        const cache = getEntityCache?.(projectContext.path);
        let _ctx: Awaited<ReturnType<typeof initContext>> | null = null;
        // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
        const getCtx = async () => {
          if (!_ctx) _ctx = await initContext(projectContext.path, { syncMode: "skip" });
          return _ctx;
        };

        // AC: @daemon-entity-cache ac-warming-availability — return loading indicator during warmup
        const plansDomainState = cache?.getDomainState("plans");
        if (cache && plansDomainState === "loading") {
          return wrapResponse(null, { cacheDomainState: "loading" });
        }

        // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
        // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
        //     — plan detail routes require folder-backed plan storage, the same
        //     contract the list route enforces. Without this gate, requests for
        //     a specific @plan ref on a legacy project would either resolve via
        //     the lenient storage manager and surface monolithic data, or fall
        //     through to a 404 — both contradict the structured 409 contract.
        //
        // AC: @daemon-read-path ac-no-per-request-sync — skip the gate when
        //     the cache has already proved this project is compatible. See
        //     the list route for the full rationale (cache loader runs the
        //     strict gate at warm-up, so a "ready" domain proves compatibility).
        if (!cache || plansDomainState !== "ready") {
          try {
            await requirePlanFolderStorage(await getCtx());
          } catch (err) {
            const conflict = entityStorageIncompatibilityResponse(err, { cache });
            if (conflict) return errorResponse(conflict.status, conflict.body);
            throw err;
          }
        }

        const cleanRef = params.ref.startsWith("@") ? params.ref.slice(1) : params.ref;

        // AC: @daemon-entity-cache ac-detail-on-demand — resolve via index, load from detail tier
        let plan: LoadedPlan | undefined;
        if (cache && plansDomainState === "ready") {
          // Find the plan's ULID in the index (summaries only)
          const cachedPlans = cache.getPlansIndex();
          if (cachedPlans) {
            const match = cachedPlans.find(
              (p) =>
                p._ulid === cleanRef ||
                p._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
                p.slugs.includes(cleanRef),
            );
            if (match) {
              // Load full plan from detail tier
              plan = cache.getPlanDetail(match._ulid) ?? undefined;
            }
          }
        }
        if (!plan) {
          // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
          //     — translate plan-storage incompatibility into a structured 409.
          try {
            plan = await findPlanByRef(await getCtx(), params.ref);
          } catch (err) {
            const conflict = entityStorageIncompatibilityResponse(err, { cache });
            if (conflict) return errorResponse(conflict.status, conflict.body);
            throw err;
          }
          // Cache the loaded detail for subsequent requests
          if (plan && cache) {
            cache.setPlanDetail(plan._ulid, plan);
          }
        }

        if (!plan) {
          return errorResponse(404, {
            error: "not_found",
            message: `Plan reference "${params.ref}" not found`,
            suggestion: "Use kspec plan list to find valid plan references",
          });
        }

        // Try cache for tasks (needed for progress computation)
        // AC: @api-contract ac-task-storage-incompatibility-* — translate the
        // storage error into a structured 409 instead of a 500.
        const tasksDomainState = cache?.getDomainState("tasks");
        let tasks;
        if (cache && tasksDomainState === "ready") {
          tasks = cache.getTaskIndex();
        }
        if (!tasks) {
          try {
            tasks = await resolveTaskDataManager(await getCtx()).loadAllTasks(await getCtx());
          } catch (err) {
            const conflict = taskStorageIncompatibilityResponse(err, { cache });
            if (conflict) return errorResponse(conflict.status, conflict.body);
            throw err;
          }
        }

        // AC: @folder-backed-plan-storage-1 ac-plan-document-sidecar-is-authoritative
        // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
        //     — detail responses surface the authoritative markdown body, the
        //     full resource metadata array loaded from the sidecar manifest,
        //     and the safe `resources_base_url` clients use to construct
        //     per-resource bytes URLs (`${base}/${encodeURIComponent(id)}/bytes`).
        //     `PlanResourceMetadata` stays the strict 9-field shape; URLs live
        //     outside the metadata object so all consumers (API, CLI, static
        //     export, agent contexts) see an identical resource shape.
        const resources = await loadPlanResourcesForApi(await getCtx(), plan._ulid);

        // AC: @ui-breadcrumb ac-10 — resolve the breadcrumb ancestor chain
        // (module_ref chain plus the plan). Prefer the cached item index; fall
        // back to a disk read only when the items domain is not warm.
        const itemsDomainReady = cache?.getDomainState("items") === "ready";
        const items =
          (itemsDomainReady ? cache!.getItemIndex() : null) ?? (await loadAllItems(await getCtx()));
        const ancestors = new BreadcrumbAncestryResolver({
          items: items as AncestryItemInput[],
        }).forPlan({ _ulid: plan._ulid, title: plan.title, module_ref: plan.module_ref });

        const detail: PlanDetail = {
          ...toPlanSummary(plan, tasks),
          content: plan.content,
          resources,
          resources_base_url: buildResourcesBaseUrl(plan._ulid),
          ancestors,
        };

        return wrapResponse(detail, { cacheDomainState: plansDomainState });
      })
  );
}
