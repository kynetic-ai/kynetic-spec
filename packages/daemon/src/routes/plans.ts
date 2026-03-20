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

import { Elysia, t } from 'elysia';
import {
  initContext,
  loadPlans,
  loadAllTasks,
  findPlanByRef,
  type LoadedPlan,
  type LoadedTask,
} from '../../parser/index.js';
import { PlanStatusSchema } from '../../schema/plan.js';
import {
  countPlanTaskProgress,
  getLinkedPlanSummaryTasks,
  isCountedInPlanSummary,
} from '../../lib/plan-summary.js';
import type { PlanSummary, PlanDetail } from '@kynetic-ai/shared';
import { enumArrayUnion } from './enum-utils.js';

interface PlansRouteOptions {}

/**
 * Map a loaded plan to a PlanSummary.
 */
function toPlanSummary(
  plan: LoadedPlan,
  tasks: LoadedTask[]
): PlanSummary {
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

export function createPlansRoutes(options: PlansRouteOptions = {}) {
  return new Elysia({ prefix: '/api/plans' })
    // AC: @ui-plans-view ac-1 - List plans with progress
    .get(
      '/',
      async ({ query, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const plans = await loadPlans(ctx);
        const tasks = await loadAllTasks(ctx);

        // Apply status filter
        let filtered: LoadedPlan[] = plans;
        if (query.status) {
          const statusFilters = Array.isArray(query.status) ? query.status : [query.status];
          filtered = filtered.filter((plan) => statusFilters.includes(plan.status));
        }

        // Sort by created_at descending (newest first)
        const sorted = [...filtered].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
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
      }
    )
    // AC: @ui-plans-view ac-2 - Get single plan with content (lazy-loaded by UI on expand)
    .get(
      '/:ref',
      async ({ params, error: errorResponse, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const plan = await findPlanByRef(ctx, params.ref);

        if (!plan) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Plan reference "${params.ref}" not found`,
            suggestion: 'Use kspec plan list to find valid plan references',
          });
        }

        const tasks = await loadAllTasks(ctx);

        const detail: PlanDetail = {
          ...toPlanSummary(plan, tasks),
          content: plan.content,
        };

        return detail;
      }
    );
}
