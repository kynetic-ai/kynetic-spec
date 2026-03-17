/**
 * Task API Routes
 *
 * REST endpoints for task operations:
 * - GET /api/tasks - list with filters and pagination
 * - GET /api/tasks/:ref - get single task
 * - POST /api/tasks/:ref/start - start task
 * - POST /api/tasks/:ref/note - add note
 *
 * AC Coverage:
 * - ac-2: GET /api/tasks returns array with status, priority, spec_ref, notes count
 * - ac-3: Status filter with multi-value support
 * - ac-4: Pagination with {items, total, offset, limit} wrapper
 * - ac-5: GET /api/tasks/:ref resolves via ReferenceIndex
 * - ac-6: POST /api/tasks/:ref/start transitions state
 * - ac-7: POST /api/tasks/:ref/note appends note
 * - @ui-task-board ac-6: POST /api/tasks/:ref/submit transitions to pending_review
 * - @ui-task-board ac-6: POST /api/tasks/:ref/complete transitions to completed
 * - @ui-task-board ac-6: POST /api/tasks/:ref/block transitions to blocked
 */

import { Elysia, t } from 'elysia';
import {
  initContext,
  loadAllTasks,
  loadAllItems,
  loadPlans,
  ReferenceIndex,
  createNote,
  saveTask,
  getAuthor,
  syncSpecImplementationStatus,
  type LoadedTask,
} from '../../parser/index.js';
import { commitIfShadow } from '../../parser/shadow.js';
import type { PubSubManager } from '../websocket/pubsub';
import { getRelatedSessionsForTask } from './session-related.js';
import { resolveRefTitle, resolveRefEntries } from './ref-resolution.js';

interface TasksRouteOptions {
  pubsub: PubSubManager;
}

export function createTasksRoutes(options: TasksRouteOptions) {
  const { pubsub } = options;

  return new Elysia({ prefix: '/api/tasks' })
    // AC: @api-contract ac-2, ac-3, ac-4 - List tasks with filters and pagination
    .get(
      '/',
      async ({ query, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const ctx = await initContext(projectContext.path);
        const tasks = await loadAllTasks(ctx);
        const specItems = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, specItems);

        // Apply filters
        let filtered = tasks;

        // AC: @api-contract ac-3 - Multi-value status filter
        if (query.status) {
          const statusFilters = Array.isArray(query.status) ? query.status : [query.status];
          filtered = filtered.filter((task) => statusFilters.includes(task.status));
        }

        // Type filter (optional, not in ACs but useful)
        if (query.type) {
          const typeFilters = Array.isArray(query.type) ? query.type : [query.type];
          filtered = filtered.filter((task) => task.type && typeFilters.includes(task.type));
        }

        // Tag filter (optional, not in ACs but useful)
        if (query.tag) {
          const tagFilters = Array.isArray(query.tag) ? query.tag : [query.tag];
          filtered = filtered.filter((task) =>
            task.tags?.some((t) => tagFilters.includes(t))
          );
        }

        // Automation filter — filter by automation eligibility status
        if (query.automation) {
          filtered = filtered.filter((task) => task.automation === query.automation);
        }

        // Plan filter — show only tasks derived from a given plan
        if (query.plan) {
          const plans = await loadPlans(ctx);
          const plan = plans.find(
            (p) => p._ulid === query.plan || p.slugs.includes(query.plan!)
          );
          if (plan) {
            const derivedRefs = new Set(
              plan.derived_tasks.map((r) => (r.startsWith('@') ? r.slice(1) : r))
            );
            filtered = filtered.filter(
              (task) =>
                derivedRefs.has(task._ulid) ||
                task.slugs.some((s) => derivedRefs.has(s))
            );
          } else {
            filtered = [];
          }
        }

        // AC: @api-contract ac-4 - Pagination
        const total = filtered.length;
        const offset = Number(query.offset) || 0;
        const limit = Number(query.limit) || total;

        const paginated = filtered.slice(offset, offset + limit);

        // AC: @api-contract ac-2 - Return with status, priority, spec_ref, notes count
        // AC: @web-dashboard ac-1 - Include depends_on for blocked task computation
        // AC: @ui-api-ref-resolution ac-1 - Include spec_title resolved server-side
        const items = paginated.map((task) => ({
          _ulid: task._ulid,
          slugs: task.slugs,
          title: task.title,
          type: task.type || 'task',
          status: task.status,
          priority: task.priority,
          spec_ref: task.spec_ref,
          spec_title: resolveRefTitle(index, task.spec_ref),
          meta_ref: task.meta_ref,
          tags: task.tags,
          depends_on: task.depends_on || [],
          automation: task.automation,
          notes_count: task.notes?.length || 0,
          todos_count: task.todos?.length || 0,
          started_at: task.started_at,
          completed_at: task.completed_at,
          created_at: task.created_at,
        }));

        // AC: @api-contract ac-4, @trait-api-endpoint ac-4 - Return pagination wrapper
        return {
          items,
          total,
          offset,
          limit,
        };
      },
      {
        query: t.Object({
          status: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          type: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          tag: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          automation: t.Optional(t.String()),
          plan: t.Optional(t.String()),
          limit: t.Optional(t.String()),
          offset: t.Optional(t.String()),
        }),
      }
    )

    // AC: @api-contract ac-5 - Get single task by ref
    .get(
      '/:ref',
      async ({ params, error: errorResponse, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const ctx = await initContext(projectContext.path);
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const plans = await loadPlans(ctx);
        const index = new ReferenceIndex(tasks, items, [], plans);

        // AC: @api-contract ac-5, @trait-api-endpoint ac-2 - Resolve ref via ReferenceIndex
        const result = index.resolve(params.ref);

        if (!result.ok) {
          // AC: @trait-api-endpoint ac-2 - Return 404 with error details
          return errorResponse(404, {
            error: 'not_found',
            message: `Task reference "${params.ref}" not found`,
            suggestion: 'Use kspec task list or kspec search to find valid task references',
          });
        }

        // Find the task
        const task = tasks.find((t) => t._ulid === result.ulid);
        if (!task) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Reference "${params.ref}" is not a task`,
            suggestion: 'This reference might point to a spec item instead',
          });
        }

        // AC: @api-contract ac-5 - Return full task with notes, todos, dependencies
        // AC: @ui-task-board ac-3 - Include type, description, blocked_by, vcs_refs, plan_ref, session_ref
        // AC: @ui-api-ref-resolution ac-1, ac-2 - Include resolved titles for refs
        // AC: @review-records-web-ui ac-7 - Include review_ref for task-review integration
        return {
          _ulid: task._ulid,
          slugs: task.slugs,
          title: task.title,
          type: task.type || 'task',
          status: task.status,
          priority: task.priority,
          spec_ref: task.spec_ref,
          spec_title: resolveRefTitle(index, task.spec_ref),
          meta_ref: task.meta_ref,
          tags: task.tags,
          description: task.description,
          derivation: task.derivation,
          depends_on: task.depends_on,
          resolved_depends_on: resolveRefEntries(index, task.depends_on),
          blocked_by: task.blocked_by || [],
          resolved_blocked_by: resolveRefEntries(index, task.blocked_by),
          context: task.context || [],
          vcs_refs: (task.vcs_refs || []).map((v) =>
            typeof v === 'string' ? v : v.type ? `${v.type}:${v.ref}` : v.ref
          ),
          plan_ref: task.plan_ref,
          plan_title: resolveRefTitle(index, task.plan_ref),
          review_ref: task.review_ref ?? null,
          session_ref: task.session_id,
          notes: task.notes,
          notes_count: task.notes?.length || 0,
          todos: task.todos,
          todos_count: task.todos?.length || 0,
          started_at: task.started_at,
          completed_at: task.completed_at,
          cancelled_at: task.cancelled_at,
          closed_reason: task.closed_reason,
          automation: task.automation,
          created_at: task.created_at,
        };
      },
      {
        params: t.Object({
          ref: t.String(),
        }),
      }
    )

    .get(
      '/:ref/sessions',
      async ({ params, error: errorResponse, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const result = await getRelatedSessionsForTask({
          taskRef: params.ref,
          tasks,
          items,
          sessionsDir: ctx.sessionsDir,
        });

        if ('error' in result) {
          return errorResponse(404, result.error);
        }

        return {
          items: result.sessions,
          total: result.sessions.length,
          offset: 0,
          limit: result.sessions.length,
        };
      },
      {
        params: t.Object({
          ref: t.String(),
        }),
      }
    )

    // AC: @api-contract ac-6 - Start task
    .post(
      '/:ref/start',
      async ({ params, error: errorResponse, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const ctx = await initContext(projectContext.path);
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);

        // Resolve ref
        const result = index.resolve(params.ref);
        if (!result.ok) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Task reference "${params.ref}" not found`,
            suggestion: 'Use kspec task list to find valid task references',
          });
        }

        const task = tasks.find((t) => t._ulid === result.ulid);
        if (!task) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Reference "${params.ref}" is not a task`,
          });
        }

        // AC: @api-contract ac-6 - Transition to in_progress
        if (task.status === 'in_progress') {
          return errorResponse(409, {
            error: 'invalid_transition',
            message: 'Task is already in_progress',
            current: task.status,
            valid_transitions: ['blocked', 'pending_review', 'completed', 'cancelled'],
          });
        }

        // Update task status
        const updatedTask: LoadedTask = {
          ...task,
          status: 'in_progress',
          started_at: task.started_at || new Date().toISOString(),
        };

        // Save and commit
        await saveTask(ctx, updatedTask);
        await syncSpecImplementationStatus(ctx, updatedTask, tasks, items, index);
        await commitIfShadow(ctx.shadow, `task: start ${params.ref}`);

        // AC: @api-contract ac-6, @trait-api-endpoint ac-5 - WebSocket broadcast
        // AC: @ui-api-aggregation ac-4 - Include title and old/new status
        // AC: @multi-directory-daemon ac-18 - Broadcast scoped to request project
        pubsub.broadcast('tasks:updates', 'task_updated', {
          ref: params.ref,
          ulid: task._ulid,
          action: 'start',
          title: task.title,
          old_status: task.status,
          new_status: 'in_progress',
        }, projectContext.path);

        // AC: @api-contract ac-6 - Return updated task
        return updatedTask;
      },
      {
        params: t.Object({
          ref: t.String(),
        }),
      }
    )

    // AC: @api-contract ac-7 - Add note to task
    .post(
      '/:ref/note',
      async ({ params, body, error: errorResponse, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const ctx = await initContext(projectContext.path);
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);

        // Resolve ref
        const result = index.resolve(params.ref);
        if (!result.ok) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Task reference "${params.ref}" not found`,
          });
        }

        const task = tasks.find((t) => t._ulid === result.ulid);
        if (!task) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Reference "${params.ref}" is not a task`,
          });
        }

        // AC: @trait-api-endpoint ac-3 - Validate body
        if (!body.content || typeof body.content !== 'string') {
          return errorResponse(400, {
            error: 'validation_error',
            details: [
              {
                field: 'content',
                message: 'Content is required and must be a string',
              },
            ],
          });
        }

        // AC: @api-contract ac-7 - Append note
        const author = getAuthor(ctx.config?.identity?.author);
        const note = createNote(body.content, author);

        const updatedTask: LoadedTask = {
          ...task,
          notes: [...(task.notes || []), note],
        };

        // AC: @api-contract ac-7, @trait-api-endpoint ac-5 - Shadow commit
        await saveTask(ctx, updatedTask);
        await commitIfShadow(ctx.shadow, `task: add note to ${params.ref}`);

        // AC: @api-contract ac-7 - WebSocket broadcast
        // AC: @ui-api-aggregation ac-4 - Include title (no status change for notes)
        // AC: @multi-directory-daemon ac-18 - Broadcast scoped to request project
        pubsub.broadcast('tasks:updates', 'task_updated', {
          ref: params.ref,
          ulid: task._ulid,
          action: 'note_added',
          title: task.title,
          old_status: null,
          new_status: null,
          note_ulid: note._ulid,
        }, projectContext.path);

        return {
          success: true,
          note,
          task: updatedTask,
        };
      },
      {
        params: t.Object({
          ref: t.String(),
        }),
        body: t.Object({
          content: t.String(),
        }),
      }
    )

    // AC: @ui-task-board ac-6 - Submit task for review
    .post(
      '/:ref/submit',
      async ({ params, error: errorResponse, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);

        const result = index.resolve(params.ref);
        if (!result.ok) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Task reference "${params.ref}" not found`,
          });
        }

        const task = tasks.find((t) => t._ulid === result.ulid);
        if (!task) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Reference "${params.ref}" is not a task`,
          });
        }

        if (task.status !== 'in_progress' && task.status !== 'needs_work') {
          return errorResponse(409, {
            error: 'invalid_transition',
            message: `Cannot submit task with status "${task.status}". Must be in_progress or needs_work.`,
            current: task.status,
            valid_transitions: ['pending_review'],
          });
        }

        const updatedTask: LoadedTask = { ...task, status: 'pending_review' };
        await saveTask(ctx, updatedTask);
        await syncSpecImplementationStatus(ctx, updatedTask, tasks, items, index);
        await commitIfShadow(ctx.shadow, `task: submit ${params.ref}`);

        // AC: @ui-api-aggregation ac-4 - Include title and old/new status
        pubsub.broadcast('tasks:updates', 'task_updated', {
          ref: params.ref,
          ulid: task._ulid,
          action: 'submit',
          title: task.title,
          old_status: task.status,
          new_status: 'pending_review',
        }, projectContext.path);

        return updatedTask;
      },
      { params: t.Object({ ref: t.String() }) }
    )

    // AC: @ui-task-board ac-6 - Complete task
    .post(
      '/:ref/complete',
      async ({ params, body, error: errorResponse, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);

        const result = index.resolve(params.ref);
        if (!result.ok) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Task reference "${params.ref}" not found`,
          });
        }

        const task = tasks.find((t) => t._ulid === result.ulid);
        if (!task) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Reference "${params.ref}" is not a task`,
          });
        }

        const updatedTask: LoadedTask = {
          ...task,
          status: 'completed',
          completed_at: new Date().toISOString(),
          closed_reason: body.reason,
        };
        await saveTask(ctx, updatedTask);
        await syncSpecImplementationStatus(ctx, updatedTask, tasks, items, index);
        await commitIfShadow(ctx.shadow, `task: complete ${params.ref}`);

        // AC: @ui-api-aggregation ac-4 - Include title and old/new status
        pubsub.broadcast('tasks:updates', 'task_updated', {
          ref: params.ref,
          ulid: task._ulid,
          action: 'complete',
          title: task.title,
          old_status: task.status,
          new_status: 'completed',
        }, projectContext.path);

        return updatedTask;
      },
      {
        params: t.Object({ ref: t.String() }),
        body: t.Object({ reason: t.String() }),
      }
    )

    // AC: @ui-task-board ac-6 - Block task
    .post(
      '/:ref/block',
      async ({ params, body, error: errorResponse, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, items);

        const result = index.resolve(params.ref);
        if (!result.ok) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Task reference "${params.ref}" not found`,
          });
        }

        const task = tasks.find((t) => t._ulid === result.ulid);
        if (!task) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Reference "${params.ref}" is not a task`,
          });
        }

        const author = getAuthor(ctx.config?.identity?.author);
        const note = createNote(`Blocked: ${body.reason}`, author);

        const updatedTask: LoadedTask = {
          ...task,
          status: 'blocked',
          notes: [...(task.notes || []), note],
        };
        await saveTask(ctx, updatedTask);
        await syncSpecImplementationStatus(ctx, updatedTask, tasks, items, index);
        await commitIfShadow(ctx.shadow, `task: block ${params.ref}`);

        // AC: @ui-api-aggregation ac-4 - Include title and old/new status
        pubsub.broadcast('tasks:updates', 'task_updated', {
          ref: params.ref,
          ulid: task._ulid,
          action: 'block',
          title: task.title,
          old_status: task.status,
          new_status: 'blocked',
        }, projectContext.path);

        return updatedTask;
      },
      {
        params: t.Object({ ref: t.String() }),
        body: t.Object({ reason: t.String() }),
      }
    );
}
