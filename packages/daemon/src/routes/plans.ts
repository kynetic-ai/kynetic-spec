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
  findPlanByRef,
  resolveTaskDataManager,
  type LoadedPlan,
  type LoadedTask,
  type TaskSummary,
} from "../../parser/index.js";
import { PlanStatusSchema } from "../../schema/plan.js";
import {
  countPlanTaskProgress,
  getLinkedPlanSummaryTasks,
  isCountedInPlanSummary,
} from "../../lib/plan-summary.js";
import type { PlanSummary, PlanDetail } from "@kynetic-ai/shared";
import type { PlanSummaryTask } from "../../lib/plan-summary.js";
import { enumArrayUnion } from "./enum-utils.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";

interface PlansRouteOptions {
  getEntityCache?: EntityCacheAccessor;
}

/**
 * Map a loaded plan to a PlanSummary.
 * Accepts LoadedTask[] or TaskSummary[] — both satisfy PlanSummaryTask.
 */
function toPlanSummary(plan: LoadedPlan, tasks: PlanSummaryTask[]): PlanSummary {
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
  };
}

export function createPlansRoutes(_options: PlansRouteOptions = {}) {
  const { getEntityCache } = _options;

  return (
    new Elysia({ prefix: "/api/plans" })
      // AC: @ui-plans-view ac-1 - List plans with progress
      // AC: @daemon-entity-cache ac-serve-from-memory — serve from cache when available
      .get(
        "/",
        async ({ query, projectContext }) => {
          // AC: @daemon-entity-cache ac-serve-from-memory — defer initContext for cache hits
          const cache = getEntityCache?.(projectContext.path);
          let _ctx: Awaited<ReturnType<typeof initContext>> | null = null;
          const getCtx = async () => {
            if (!_ctx) _ctx = await initContext(projectContext.path);
            return _ctx;
          };

          // Try cache for plans
          const plansDomainState = cache?.getDomainState("plans");
          let plans;
          if (cache && plansDomainState === "ready") {
            plans = cache.getPlansIndex();
          }
          if (!plans) {
            const ctx = await getCtx();
            plans = await loadPlans(ctx);
          }

          // Try cache for tasks (needed for progress computation)
          const tasksDomainState = cache?.getDomainState("tasks");
          let tasks;
          if (cache && tasksDomainState === "ready") {
            tasks = cache.getTaskIndex();
          }
          if (!tasks) {
            const ctx = await getCtx();
            tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
          }

          // Apply status filter
          let filtered: LoadedPlan[] = plans;
          if (query.status) {
            const statusFilters = Array.isArray(query.status) ? query.status : [query.status];
            filtered = filtered.filter((plan) => statusFilters.includes(plan.status));
          }

          // Sort by created_at descending (newest first)
          const sorted = [...filtered].toSorted(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
          );

          // AC: @ui-plans-view ac-1 - Compute progress for each plan
          const items: PlanSummary[] = sorted.map((plan) => toPlanSummary(plan, tasks));

          return {
            items,
            total: items.length,
          };
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
        const getCtx = async () => {
          if (!_ctx) _ctx = await initContext(projectContext.path);
          return _ctx;
        };

        const cleanRef = params.ref.startsWith("@") ? params.ref.slice(1) : params.ref;

        // Try to find plan from cached index first
        let plan: LoadedPlan | undefined;
        const plansDomainState = cache?.getDomainState("plans");
        if (cache && plansDomainState === "ready") {
          const cachedPlans = cache.getPlansIndex();
          if (cachedPlans) {
            plan = cachedPlans.find(
              (p) =>
                p._ulid === cleanRef ||
                p._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
                p.slugs.includes(cleanRef),
            );
          }
        }
        if (!plan) {
          plan = await findPlanByRef(await getCtx(), params.ref);
        }

        if (!plan) {
          return errorResponse(404, {
            error: "not_found",
            message: `Plan reference "${params.ref}" not found`,
            suggestion: "Use kspec plan list to find valid plan references",
          });
        }

        // Try cache for tasks (needed for progress computation)
        const tasksDomainState = cache?.getDomainState("tasks");
        let tasks;
        if (cache && tasksDomainState === "ready") {
          tasks = cache.getTaskIndex();
        }
        if (!tasks) {
          tasks = await resolveTaskDataManager(await getCtx()).loadAllTasks(await getCtx());
        }

        const detail: PlanDetail = {
          ...toPlanSummary(plan, tasks),
          content: plan.content,
        };

        return detail;
      })
  );
}
