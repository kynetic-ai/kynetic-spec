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
} from '../../parser/index.js';
import type { PlanSummary, PlanDetail } from '@kynetic-ai/shared';

interface PlansRouteOptions {}

/**
 * Build a task status lookup map from loaded tasks.
 */
function buildTaskStatusMap(tasks: Array<{ _ulid: string; slugs: string[]; status: string }>) {
  const tasksByRef = new Map<string, { status: string }>();
  for (const task of tasks) {
    tasksByRef.set(task._ulid, { status: task.status });
    for (const slug of task.slugs) {
      tasksByRef.set(slug, { status: task.status });
    }
  }
  return tasksByRef;
}

/**
 * Compute task progress for a plan's derived tasks.
 */
function computeTaskProgress(
  derivedTasks: string[],
  tasksByRef: Map<string, { status: string }>
) {
  const progress = { total: 0, completed: 0, in_progress: 0, pending: 0, blocked: 0 };
  for (const ref of derivedTasks) {
    const cleanRef = ref.startsWith('@') ? ref.slice(1) : ref;
    const task = tasksByRef.get(cleanRef);
    if (task) {
      progress.total++;
      if (task.status === 'completed') progress.completed++;
      else if (task.status === 'in_progress' || task.status === 'pending_review' || task.status === 'needs_work') progress.in_progress++;
      else if (task.status === 'blocked') progress.blocked++;
      else progress.pending++;
    }
  }
  return progress;
}

/**
 * Map a loaded plan to a PlanSummary.
 */
function toPlanSummary(
  plan: LoadedPlan,
  tasksByRef: Map<string, { status: string }>
): PlanSummary {
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
    task_count: plan.derived_tasks.length,
    task_progress: computeTaskProgress(plan.derived_tasks, tasksByRef),
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
        const tasksByRef = buildTaskStatusMap(tasks);

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
        const items: PlanSummary[] = sorted.map((plan) => toPlanSummary(plan, tasksByRef));

        return {
          items,
          total: items.length,
        };
      },
      {
        query: t.Object({
          status: t.Optional(t.Union([t.String(), t.Array(t.String())])),
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
        const tasksByRef = buildTaskStatusMap(tasks);

        const detail: PlanDetail = {
          ...toPlanSummary(plan, tasksByRef),
          content: plan.content,
        };

        return detail;
      }
    );
}
