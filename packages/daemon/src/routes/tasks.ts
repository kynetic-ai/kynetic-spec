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
 */

import { Elysia, t } from 'elysia';
import {
  initContext,
  loadAllTasks,
  loadAllItems,
  ReferenceIndex,
  createNote,
  saveTask,
  getAuthor,
  syncSpecImplementationStatus,
  type LoadedTask,
} from '../../parser/index.js';
import { commitIfShadow } from '../../parser/shadow.js';
import type { PubSubManager } from '../websocket/pubsub';
import { join } from 'path';

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
        const kspecDir = join(projectContext.path, '.kspec');
        const ctx = await initContext(kspecDir);
        const tasks = await loadAllTasks(ctx);
        const index = new ReferenceIndex(ctx);

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

        // AC: @api-contract ac-4 - Pagination
        const total = filtered.length;
        const offset = Number(query.offset) || 0;
        const limit = Number(query.limit) || total;

        const paginated = filtered.slice(offset, offset + limit);

        // AC: @api-contract ac-2 - Return with status, priority, spec_ref, notes count
        const items = paginated.map((task) => ({
          _ulid: task._ulid,
          slugs: task.slugs,
          title: task.title,
          status: task.status,
          priority: task.priority,
          spec_ref: task.spec_ref,
          meta_ref: task.meta_ref,
          tags: task.tags,
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
        const kspecDir = join(projectContext.path, '.kspec');
        const ctx = await initContext(kspecDir);
        const tasks = await loadAllTasks(ctx);
        const index = new ReferenceIndex(ctx);

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
        return {
          _ulid: task._ulid,
          slugs: task.slugs,
          title: task.title,
          status: task.status,
          priority: task.priority,
          spec_ref: task.spec_ref,
          meta_ref: task.meta_ref,
          tags: task.tags,
          description: task.description,
          depends_on: task.depends_on,
          notes: task.notes,
          todos: task.todos,
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

    // AC: @api-contract ac-6 - Start task
    .post(
      '/:ref/start',
      async ({ params, error: errorResponse, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const kspecDir = join(projectContext.path, '.kspec');
        const ctx = await initContext(kspecDir);
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(ctx);

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
        await commitIfShadow(ctx, `task: start ${params.ref}`);

        // AC: @api-contract ac-6, @trait-api-endpoint ac-5 - WebSocket broadcast
        // AC: @multi-directory-daemon ac-18 - Broadcast scoped to request project
        pubsub.broadcast('tasks:updates', 'task_updated', {
          ref: params.ref,
          ulid: task._ulid,
          action: 'start',
          status: 'in_progress',
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
        const kspecDir = join(projectContext.path, '.kspec');
        const ctx = await initContext(kspecDir);
        const tasks = await loadAllTasks(ctx);
        const index = new ReferenceIndex(ctx);

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
        const author = await getAuthor(ctx.root);
        const note = createNote(body.content, author);

        const updatedTask: LoadedTask = {
          ...task,
          notes: [...(task.notes || []), note],
        };

        // AC: @api-contract ac-7, @trait-api-endpoint ac-5 - Shadow commit
        await saveTask(ctx, updatedTask);
        await commitIfShadow(ctx, `task: add note to ${params.ref}`);

        // AC: @api-contract ac-7 - WebSocket broadcast
        // AC: @multi-directory-daemon ac-18 - Broadcast scoped to request project
        pubsub.broadcast('tasks:updates', 'task_updated', {
          ref: params.ref,
          ulid: task._ulid,
          action: 'note_added',
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
    );
}
