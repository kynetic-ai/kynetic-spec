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
 *
 * AC: @task-data-manager ac-1 — all task I/O goes through taskDataManager
 */

import { join } from "path";
import { Elysia, t } from "elysia";
import {
  initContext,
  loadAllItems,
  loadPlans,
  ReferenceIndex,
  createNote,
  getAuthor,
  syncSpecImplementationStatus,
  resolveTaskDataManager,
  TaskDataManagerError,
  resolveTaskResources,
  projectResolvedTaskResources,
  type LoadedTask,
  type TaskSummary,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import { TaskStatusSchema, TaskTypeSchema } from "../../schema/common.js";
import { AutomationStatusSchema } from "../../schema/task.js";
import type { PubSubManager } from "../websocket/pubsub.js";
import { enumArrayUnion, enumUnion } from "./enum-utils.js";
import { getRelatedSessionsForTask } from "./session-related.js";
import { resolveRefTitle, resolveRefEntries } from "./ref-resolution.js";

import type { EntityCacheAccessor, WriteThroughHint } from "./entity-cache-types.js";
import { wrapResponse } from "./response-envelope.js";
import { taskStorageIncompatibilityResponse } from "./task-storage-error.js";
import { entityStorageIncompatibilityResponse } from "./entity-storage-error.js";

interface TasksRouteOptions {
  pubsub: PubSubManager;
  getEntityCache?: EntityCacheAccessor;
}

function getTaskWriteThroughHint(task: LoadedTask): WriteThroughHint {
  return { ulid: task._ulid };
}

/**
 * Build the task-scoped base URL clients use to fetch resolved-resource bytes
 * via `${base}/${encodeURIComponent(id)}/bytes`. Surfaced on
 * `TaskDetail.resources_base_url` so callers construct task resource byte URLs
 * without guessing plan-owned vs task-owned ownership. The bytes route itself
 * is owned by a sibling task; this only fixes the URL contract.
 *
 * AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resource-base-url
 */
function buildTaskResourcesBaseUrl(taskUlid: string): string {
  return `/api/tasks/${taskUlid}/resources`;
}

function getSpecWriteThroughHint(
  task: LoadedTask,
  index: ReferenceIndex,
): WriteThroughHint | undefined {
  if (!task.spec_ref) {
    return undefined;
  }

  const resolved = index.resolve(task.spec_ref);
  return resolved.ok ? { ulid: resolved.ulid } : undefined;
}

export function createTasksRoutes(options: TasksRouteOptions) {
  const { pubsub, getEntityCache } = options;

  return (
    new Elysia({ prefix: "/api/tasks" })
      // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
      //     — task routes load plan data for plan-aware progress; surface storage
      //     incompatibility as 409 instead of letting it escape as 500.
      .onError(({ error: err, set }) => {
        const conflict = entityStorageIncompatibilityResponse(err);
        if (conflict) {
          set.status = conflict.status;
          return conflict.body;
        }
      })
      // AC: @api-contract ac-2, ac-3, ac-4 - List tasks with filters and pagination
      // AC: @task-data-manager ac-2 - Uses resolveTaskDataManager(ctx).listTasks for index-only read
      // AC: @daemon-entity-cache ac-serve-from-memory — serve from cache when available
      // AC: @daemon-entity-cache ac-graceful-degradation — fall back to disk on cache miss
      // AC: @daemon-entity-cache ac-warming-availability — return loading indicator if warming
      .get(
        "/",
        async ({ query, error: errorResponse, projectContext }) => {
          // AC: @daemon-entity-cache ac-serve-from-memory, ac-warming-availability
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — cache-first path bypasses per-request drift-check
          const cache = getEntityCache?.(projectContext.path);
          const tasksDomainState = cache?.getDomainState("tasks");

          // If cache is warming, return loading indicator
          // AC: @daemon-entity-cache ac-warming-availability
          if (cache && tasksDomainState === "loading") {
            return wrapResponse([] as never[], {
              cacheDomainState: "loading",
              total: 0,
              offset: 0,
              limit: 0,
            });
          }

          // AC: @daemon-entity-cache ac-serve-from-memory — defer initContext to avoid
          // disk/git work on cache hits. Only initialize when disk fallback is needed.
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — daemon fallback reads skip
          // per-request drift-check; freshness is handled by background sync scheduler
          let _ctx: Awaited<ReturnType<typeof initContext>> | null = null;
          const getCtx = async () => {
            if (!_ctx) _ctx = await initContext(projectContext.path, { syncMode: "skip" });
            return _ctx;
          };

          // AC: @daemon-entity-cache ac-serve-from-memory — use cached index when ready
          // AC: @daemon-entity-cache ac-graceful-degradation — fall back to disk if degraded
          // AC: @api-contract ac-task-storage-incompatibility-* — direct disk reads that
          // hit a deterministic task-storage incompatibility surface as 409.
          let summaries;
          try {
            if (cache && tasksDomainState === "ready") {
              const cachedTasks = cache.getTaskIndex();
              if (cachedTasks) {
                // Apply status and automation filters (matching listTasks contract)
                summaries = cachedTasks;
                if (query.status) {
                  const statusFilters = Array.isArray(query.status) ? query.status : [query.status];
                  summaries = summaries.filter((t) => statusFilters.includes(t.status));
                }
                if (query.automation) {
                  summaries = summaries.filter((t) => t.automation === query.automation);
                }
              } else {
                const ctx = await getCtx();
                summaries = await resolveTaskDataManager(ctx).listTasks(ctx, {
                  status: query.status
                    ? Array.isArray(query.status)
                      ? query.status
                      : [query.status]
                    : undefined,
                  automation: query.automation || undefined,
                });
              }
            } else {
              // AC: @task-data-manager ac-2 — list uses index-only summaries
              const ctx = await getCtx();
              summaries = await resolveTaskDataManager(ctx).listTasks(ctx, {
                status: query.status
                  ? Array.isArray(query.status)
                    ? query.status
                    : [query.status]
                  : undefined,
                automation: query.automation || undefined,
              });
            }
          } catch (err) {
            const conflict = taskStorageIncompatibilityResponse(err, { cache });
            if (conflict) return errorResponse(conflict.status, conflict.body);
            throw err;
          }

          // Apply filters not supported by TaskListFilters
          let filtered = summaries;

          // Type filter (optional, not in ACs but useful)
          if (query.type) {
            const typeFilters = Array.isArray(query.type) ? query.type : [query.type];
            filtered = filtered.filter((task) => task.type && typeFilters.includes(task.type));
          }

          // Tag filter (optional, not in ACs but useful)
          if (query.tag) {
            const tagFilters = Array.isArray(query.tag) ? query.tag : [query.tag];
            filtered = filtered.filter((task) =>
              task.tags?.some((tag) => tagFilters.includes(tag)),
            );
          }

          // Plan filter — show tasks linked to a given plan (bidirectional)
          // AC: @api-contract ac-plan-filter-resolve, ac-plan-filter-derived, ac-plan-filter-ref
          if (query.plan) {
            // AC: @daemon-entity-cache ac-serve-from-memory — try cache for plans too
            let plans;
            const plansDomainState = cache?.getDomainState("plans");
            if (cache && plansDomainState === "ready") {
              plans = cache.getPlansIndex();
            }
            if (!plans) {
              const ctx = await getCtx();
              plans = await loadPlans(ctx);
            }
            // AC: @api-contract ac-plan-filter-resolve — resolve by full ULID, ULID prefix, or slug
            const planRef = query.plan!;
            const planRefUpper = planRef.toUpperCase();
            const plan = plans.find(
              (p: { _ulid: string; slugs: string[] }) =>
                p._ulid === planRef ||
                p._ulid.startsWith(planRefUpper) ||
                p.slugs.includes(planRef),
            );
            if (plan) {
              // Forward link: tasks listed in plan.derived_tasks
              const derivedRefs = new Set(
                (plan as { derived_tasks: string[] }).derived_tasks.map((r: string) =>
                  r.startsWith("@") ? r.slice(1) : r,
                ),
              );
              const planUlid = (plan as { _ulid: string })._ulid;
              const planSlugs = (plan as { slugs: string[] }).slugs;
              filtered = filtered.filter((task) => {
                // Forward: task is in plan's derived_tasks
                const matchesDerived =
                  derivedRefs.has(task._ulid) || task.slugs.some((s) => derivedRefs.has(s));
                // Reverse: task's plan_ref points to this plan
                const taskPlanRef = task.plan_ref
                  ? task.plan_ref.startsWith("@")
                    ? task.plan_ref.slice(1)
                    : task.plan_ref
                  : null;
                const matchesPlanRef =
                  taskPlanRef !== null &&
                  (taskPlanRef === planUlid ||
                    planUlid.startsWith(taskPlanRef) ||
                    planSlugs.includes(taskPlanRef));
                return matchesDerived || matchesPlanRef;
              });
            } else {
              filtered = [];
            }
          }

          // AC: @api-contract ac-4 - Pagination
          const total = filtered.length;
          const offset = Number(query.offset) || 0;
          const limit = Number(query.limit) || total;

          const paginated = filtered.slice(offset, offset + limit);

          // Resolve spec titles via ReferenceIndex (needs spec items)
          // AC: @daemon-entity-cache ac-serve-from-memory — try cache for items
          let specItems;
          const itemsDomainState = cache?.getDomainState("items");
          if (cache && itemsDomainState === "ready") {
            specItems = cache.getItemIndex();
          }
          if (!specItems) {
            const ctx = await getCtx();
            specItems = await loadAllItems(ctx);
          }
          // Build a minimal index from summaries for ref resolution
          // ReferenceIndex accepts LoadedTask[] — summaries have compatible _ulid/slugs
          const index = new ReferenceIndex([], specItems);

          // AC: @api-contract ac-2 - Return with status, priority, spec_ref, notes count
          // AC: @web-dashboard ac-1 - Include depends_on for blocked task computation
          // AC: @ui-api-ref-resolution ac-1 - Include spec_title resolved server-side
          const items = paginated.map((task) => ({
            _ulid: task._ulid,
            slugs: task.slugs,
            title: task.title,
            type: task.type || "task",
            status: task.status,
            priority: task.priority,
            spec_ref: task.spec_ref,
            spec_title: resolveRefTitle(index, task.spec_ref),
            tags: task.tags,
            depends_on: task.depends_on || [],
            automation: task.automation,
            notes_count: task.notes_count,
            todos_count: task.todos_count,
            started_at: task.started_at,
            completed_at: task.completed_at,
            created_at: task.created_at,
          }));

          // AC: @api-contract ac-4, @trait-api-endpoint ac-4 - Return pagination wrapper
          // AC: @api-contract ac-envelope - Unified envelope response
          return wrapResponse(items, { total, offset, limit, cacheDomainState: tasksDomainState });
        },
        {
          query: t.Object({
            status: t.Optional(enumArrayUnion(TaskStatusSchema.options)),
            type: t.Optional(enumArrayUnion(TaskTypeSchema.options)),
            tag: t.Optional(t.Union([t.String(), t.Array(t.String())])),
            automation: t.Optional(enumUnion(AutomationStatusSchema.options)),
            plan: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )

      // AC: @api-contract ac-5 - Get single task by ref
      // AC: @task-data-manager ac-3 - Uses resolveTaskDataManager(ctx).getTask for full detail
      // AC: @daemon-entity-cache ac-detail-on-demand — load detail from disk, cache result
      .get(
        "/:ref",
        async ({ params, error: errorResponse, projectContext }) => {
          // AC: @daemon-entity-cache ac-serve-from-memory, ac-detail-on-demand — defer initContext
          // to avoid disk/git work on cache hits. Only initialize when disk fallback is needed.
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — daemon fallback reads skip
          // per-request drift-check; freshness is handled by background sync scheduler
          let _ctx: Awaited<ReturnType<typeof initContext>> | null = null;
          const getCtx = async () => {
            if (!_ctx) _ctx = await initContext(projectContext.path, { syncMode: "skip" });
            return _ctx;
          };

          // AC: @daemon-entity-cache ac-warming-availability — return loading indicator during warmup
          const cache = getEntityCache?.(projectContext.path);
          const tasksDomainState = cache?.getDomainState("tasks");
          if (cache && tasksDomainState === "loading") {
            return wrapResponse(null, { cacheDomainState: "loading" });
          }

          // AC: @daemon-entity-cache ac-detail-on-demand — check cache first, fall back to disk
          let task: LoadedTask | null = null;

          if (cache && tasksDomainState === "ready") {
            // Resolve ref to ULID via cached task index
            const taskIndex = cache.getTaskIndex();
            if (taskIndex) {
              const ref = params.ref.startsWith("@") ? params.ref.slice(1) : params.ref;
              const matched = taskIndex.find(
                (t) =>
                  t._ulid === ref || t._ulid.startsWith(ref.toUpperCase()) || t.slugs.includes(ref),
              );
              if (matched) {
                task = cache.getTaskDetail(matched._ulid);
              }
            }
          }

          // AC: @task-data-manager ac-3 — fall back to disk if not in detail cache
          if (!task) {
            const ctx = await getCtx();
            try {
              task = await resolveTaskDataManager(ctx).getTask(ctx, params.ref);
            } catch (err) {
              // AC: @api-contract ac-task-storage-incompatibility-not-not-found —
              // deterministic task-storage incompatibility must surface as 409,
              // not be collapsed into a task-ref not_found.
              const conflict = taskStorageIncompatibilityResponse(err, { cache });
              if (conflict) return errorResponse(conflict.status, conflict.body);
              if (err instanceof TaskDataManagerError) {
                return errorResponse(404, {
                  error: "not_found",
                  message: `Task reference "${params.ref}" not found`,
                  suggestion: "Use kspec task list or kspec search to find valid task references",
                });
              }
              throw err;
            }

            // AC: @daemon-entity-cache ac-detail-on-demand — cache the loaded detail
            if (cache) {
              cache.setTaskDetail(task._ulid, task);
            }
          }

          // Build ReferenceIndex for ref title resolution
          // AC: @daemon-entity-cache ac-serve-from-memory — try cache for items and plans
          let items;
          let plans;
          const itemsDomainState = cache?.getDomainState("items");
          const plansDomainState = cache?.getDomainState("plans");
          if (cache && itemsDomainState === "ready") {
            items = cache.getItemIndex();
          }
          if (!items) {
            items = await loadAllItems(await getCtx());
          }
          if (cache && plansDomainState === "ready") {
            plans = cache.getPlansIndex();
          }
          if (!plans) {
            plans = await loadPlans(await getCtx());
          }
          // AC: @daemon-entity-cache ac-serve-from-memory — use cached tasks for ref index
          let tasksForIndex: LoadedTask[] | TaskSummary[];
          if (cache && cache.getDomainState("tasks") === "ready" && cache.getTaskIndex()) {
            tasksForIndex = cache.getTaskIndex()!;
          } else {
            tasksForIndex = await resolveTaskDataManager(await getCtx()).listTasks(await getCtx());
          }
          const index = new ReferenceIndex(
            tasksForIndex as unknown as LoadedTask[],
            items,
            [],
            plans,
          );

          // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resolved-resources
          // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resource-base-url
          // Resolve the task's derived resource_refs against their owning
          // entities so task detail reports drift status and a task-scoped
          // bytes base URL. Reuses resolveTaskResources/projectResolvedTaskResources
          // (the same path kspec task get --json and the agent context use) so
          // drift semantics stay identical across surfaces. Only runs when the
          // task actually has refs — resource-free tasks omit both fields and
          // skip the disk read entirely, even on cache hits. This is the one
          // detail path that needs the owning manifests, so it loads ctx lazily.
          let resolvedResources: ReturnType<typeof projectResolvedTaskResources> | undefined;
          let resourcesBaseUrl: string | undefined;
          if (task.resource_refs && task.resource_refs.length > 0) {
            const ctx = await getCtx();
            const resolved = await resolveTaskResources(ctx, task);
            resolvedResources = projectResolvedTaskResources(resolved);
            resourcesBaseUrl = buildTaskResourcesBaseUrl(task._ulid);
          }

          // AC: @api-contract ac-5 - Return full task with notes, todos, dependencies
          // AC: @ui-task-board ac-3 - Include type, description, blocked_by, vcs_refs, plan_ref, session_ref
          // AC: @ui-api-ref-resolution ac-1, ac-2 - Include resolved titles for refs
          // AC: @review-records-web-ui ac-7 - Include review_ref for task-review integration
          // AC: @api-contract ac-envelope - Unified envelope response
          return wrapResponse(
            {
              _ulid: task._ulid,
              slugs: task.slugs,
              title: task.title,
              type: task.type || "task",
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
                typeof v === "string" ? v : v.type ? `${v.type}:${v.ref}` : v.ref,
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
              // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resolved-resources
              // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resource-base-url
              ...(resolvedResources && resolvedResources.length > 0
                ? {
                    resolved_resources: resolvedResources,
                    resources_base_url: resourcesBaseUrl,
                  }
                : {}),
            },
            { cacheDomainState: tasksDomainState },
          );
        },
        {
          params: t.Object({
            ref: t.String(),
          }),
        },
      )

      // AC: @daemon-entity-cache ac-serve-from-memory — use cached task/item indexes for related sessions
      .get(
        "/:ref/sessions",
        async ({ params, error: errorResponse, projectContext }) => {
          const cache = getEntityCache?.(projectContext.path);
          const tasksDomainReady = cache && cache.getDomainState("tasks") === "ready";
          const itemsDomainReady = cache && cache.getDomainState("items") === "ready";

          let tasks: LoadedTask[];
          let items: Awaited<ReturnType<typeof loadAllItems>>;
          let sessionsDir: string;

          if (tasksDomainReady && itemsDomainReady) {
            // TaskSummary/ItemSummary have _ulid + slugs — sufficient for ReferenceIndex + buildTaskRefSet
            tasks = (cache!.getTaskIndex() ?? []) as unknown as LoadedTask[];
            items = (cache!.getItemIndex() ?? []) as unknown as Awaited<
              ReturnType<typeof loadAllItems>
            >;
            sessionsDir = join(projectContext.path, ".kspec-sessions");
          } else {
            // AC: @shadow-lazy-read-sync ac-daemon-bypass — daemon fallback reads skip
            // per-request drift-check; freshness is handled by background sync scheduler
            const ctx = await initContext(projectContext.path, { syncMode: "skip" });
            // AC: @api-contract ac-task-storage-incompatibility-* — surface a
            // structured 409 for legacy/unmigrated projects instead of letting
            // the storage error escape as an unhandled 500.
            try {
              tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
            } catch (err) {
              const conflict = taskStorageIncompatibilityResponse(err, { cache });
              if (conflict) return errorResponse(conflict.status, conflict.body);
              throw err;
            }
            items = await loadAllItems(ctx);
            sessionsDir = ctx.sessionsDir;
          }

          const result = await getRelatedSessionsForTask({
            taskRef: params.ref,
            tasks,
            items,
            sessionsDir,
            getEntityCache,
            projectPath: projectContext.path,
          });

          if ("error" in result) {
            return errorResponse(404, result.error);
          }

          return wrapResponse(result.sessions, {
            total: result.sessions.length,
            offset: 0,
            limit: result.sessions.length,
          });
        },
        {
          params: t.Object({
            ref: t.String(),
          }),
        },
      )

      // AC: @api-contract ac-6 - Start task
      // AC: @task-data-manager ac-4 - Mutation via resolveTaskDataManager(ctx).mutateTask
      .post(
        "/:ref/start",
        async ({ params, error: errorResponse, projectContext }) => {
          // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
          const ctx = await initContext(projectContext.path);
          const startEntityCache = getEntityCache?.(projectContext.path);

          // AC: @task-data-manager ac-3 — resolve task via manager
          let task: LoadedTask;
          try {
            task = await resolveTaskDataManager(ctx).getTask(ctx, params.ref);
          } catch (err) {
            // AC: @api-contract ac-task-storage-incompatibility-not-not-found
            const conflict = taskStorageIncompatibilityResponse(err, { cache: startEntityCache });
            if (conflict) return errorResponse(conflict.status, conflict.body);
            if (err instanceof TaskDataManagerError) {
              return errorResponse(404, {
                error: "not_found",
                message: `Task reference "${params.ref}" not found`,
                suggestion: "Use kspec task list to find valid task references",
              });
            }
            throw err;
          }

          // AC: @api-contract ac-6 - Transition to in_progress
          if (task.status === "in_progress") {
            return errorResponse(409, {
              error: "invalid_transition",
              message: "Task is already in_progress",
              current: task.status,
              valid_transitions: ["blocked", "pending_review", "completed", "cancelled"],
            });
          }

          const oldStatus = task.status;

          // AC: @task-data-manager ac-4, ac-6 - Atomic mutation via manager
          // skipCommit: task mutation + spec sync committed as one shadow commit
          const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
            ctx,
            params.ref,
            (latestTask) => ({
              ...latestTask,
              status: "in_progress" as const,
              started_at: latestTask.started_at || new Date().toISOString(),
            }),
            {
              operation: "api-task-start",
              ref: params.ref,
              detail: `start ${params.ref}`,
              skipCommit: true,
            },
          );

          // Sync spec implementation status and commit both changes together
          const items = await loadAllItems(ctx);
          const allTasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
          const index = new ReferenceIndex(allTasks, items);
          await syncSpecImplementationStatus(ctx, updatedTask, allTasks, items, index);
          await commitIfShadow(ctx.shadow, `task: start ${params.ref}`);

          // AC: @daemon-entity-cache ac-write-through — update cache before response
          // Write through both tasks and items domains because syncSpecImplementationStatus
          // modifies spec items (implementation status) as a side effect of task transitions.
          const startCache = getEntityCache?.(projectContext.path);
          if (startCache) {
            await Promise.all([
              startCache.writeThrough("tasks", getTaskWriteThroughHint(updatedTask)),
              startCache.writeThrough("items", getSpecWriteThroughHint(updatedTask, index)),
            ]);
          }

          // AC: @api-contract ac-6, @trait-api-endpoint ac-5 - WebSocket broadcast
          // AC: @ui-api-aggregation ac-4 - Include title and old/new status
          // AC: @multi-directory-daemon ac-18 - Broadcast scoped to request project
          pubsub.broadcast(
            "tasks:updates",
            "task_updated",
            {
              ref: params.ref,
              ulid: task._ulid,
              action: "start",
              title: task.title,
              old_status: oldStatus,
              new_status: "in_progress",
            },
            projectContext.path,
          );

          // AC: @api-contract ac-6 - Return updated task
          return updatedTask;
        },
        {
          params: t.Object({
            ref: t.String(),
          }),
        },
      )

      // AC: @api-contract ac-7 - Add note to task
      // AC: @task-data-manager ac-4 - Note via resolveTaskDataManager(ctx).addNote
      .post(
        "/:ref/note",
        async ({ params, body, error: errorResponse, projectContext }) => {
          // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
          const ctx = await initContext(projectContext.path);
          const noteEntityCache = getEntityCache?.(projectContext.path);

          // AC: @trait-api-endpoint ac-3 - Validate body
          if (!body.content || typeof body.content !== "string") {
            return errorResponse(400, {
              error: "validation_error",
              details: [
                {
                  field: "content",
                  message: "Content is required and must be a string",
                },
              ],
            });
          }

          const author = getAuthor(ctx.config?.identity?.author);

          // AC: @task-data-manager ac-4, ac-6 - Atomic note addition via manager
          let result: { task: LoadedTask; note: { _ulid: string } };
          try {
            result = await resolveTaskDataManager(ctx).addNote(
              ctx,
              params.ref,
              body.content,
              author,
              { operation: "task", ref: params.ref, detail: "add note" },
            );
          } catch (err) {
            // AC: @api-contract ac-task-storage-incompatibility-not-not-found
            const conflict = taskStorageIncompatibilityResponse(err, { cache: noteEntityCache });
            if (conflict) return errorResponse(conflict.status, conflict.body);
            if (err instanceof TaskDataManagerError) {
              return errorResponse(404, {
                error: "not_found",
                message: `Task reference "${params.ref}" not found`,
              });
            }
            throw err;
          }

          // AC: @daemon-entity-cache ac-write-through — update cache before response
          const noteCache = getEntityCache?.(projectContext.path);
          if (noteCache) {
            await noteCache.writeThrough("tasks", getTaskWriteThroughHint(result.task));
          }

          // AC: @api-contract ac-7 - WebSocket broadcast
          // AC: @ui-api-aggregation ac-4 - Include title (no status change for notes)
          // AC: @multi-directory-daemon ac-18 - Broadcast scoped to request project
          pubsub.broadcast(
            "tasks:updates",
            "task_updated",
            {
              ref: params.ref,
              ulid: result.task._ulid,
              action: "note_added",
              title: result.task.title,
              old_status: null,
              new_status: null,
              note_ulid: result.note._ulid,
            },
            projectContext.path,
          );

          return {
            success: true,
            note: result.note,
            task: result.task,
          };
        },
        {
          params: t.Object({
            ref: t.String(),
          }),
          body: t.Object({
            content: t.String(),
          }),
        },
      )

      // AC: @ui-task-board ac-6 - Submit task for review
      // AC: @task-data-manager ac-4 - Mutation via resolveTaskDataManager(ctx).mutateTask
      .post(
        "/:ref/submit",
        async ({ params, error: errorResponse, projectContext }) => {
          const ctx = await initContext(projectContext.path);
          const submitEntityCache = getEntityCache?.(projectContext.path);

          // AC: @task-data-manager ac-3 — resolve task via manager
          let task: LoadedTask;
          try {
            task = await resolveTaskDataManager(ctx).getTask(ctx, params.ref);
          } catch (err) {
            // AC: @api-contract ac-task-storage-incompatibility-not-not-found
            const conflict = taskStorageIncompatibilityResponse(err, { cache: submitEntityCache });
            if (conflict) return errorResponse(conflict.status, conflict.body);
            if (err instanceof TaskDataManagerError) {
              return errorResponse(404, {
                error: "not_found",
                message: `Task reference "${params.ref}" not found`,
              });
            }
            throw err;
          }

          if (task.status !== "in_progress" && task.status !== "needs_work") {
            return errorResponse(409, {
              error: "invalid_transition",
              message: `Cannot submit task with status "${task.status}". Must be in_progress or needs_work.`,
              current: task.status,
              valid_transitions: ["pending_review"],
            });
          }

          const oldStatus = task.status;

          // AC: @task-data-manager ac-4, ac-6 - Atomic mutation via manager
          // skipCommit: task mutation + spec sync committed as one shadow commit
          const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
            ctx,
            params.ref,
            (latestTask) => ({ ...latestTask, status: "pending_review" as const }),
            {
              operation: "api-task-submit",
              ref: params.ref,
              detail: `submit ${params.ref}`,
              skipCommit: true,
            },
          );

          // Sync spec implementation status and commit both changes together
          const items = await loadAllItems(ctx);
          const allTasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
          const index = new ReferenceIndex(allTasks, items);
          await syncSpecImplementationStatus(ctx, updatedTask, allTasks, items, index);
          await commitIfShadow(ctx.shadow, `task: submit ${params.ref}`);

          // AC: @daemon-entity-cache ac-write-through — update cache before response
          // Write through both tasks and items domains because syncSpecImplementationStatus
          // modifies spec items (implementation status) as a side effect of task transitions.
          const submitCache = getEntityCache?.(projectContext.path);
          if (submitCache) {
            await Promise.all([
              submitCache.writeThrough("tasks", getTaskWriteThroughHint(updatedTask)),
              submitCache.writeThrough("items", getSpecWriteThroughHint(updatedTask, index)),
            ]);
          }

          // AC: @ui-api-aggregation ac-4 - Include title and old/new status
          pubsub.broadcast(
            "tasks:updates",
            "task_updated",
            {
              ref: params.ref,
              ulid: task._ulid,
              action: "submit",
              title: task.title,
              old_status: oldStatus,
              new_status: "pending_review",
            },
            projectContext.path,
          );

          return updatedTask;
        },
        { params: t.Object({ ref: t.String() }) },
      )

      // AC: @ui-task-board ac-6 - Complete task
      // AC: @task-data-manager ac-4 - Mutation via resolveTaskDataManager(ctx).mutateTask
      .post(
        "/:ref/complete",
        async ({ params, body, error: errorResponse, projectContext }) => {
          const ctx = await initContext(projectContext.path);
          const completeEntityCache = getEntityCache?.(projectContext.path);

          // AC: @task-data-manager ac-3 — resolve task via manager
          let task: LoadedTask;
          try {
            task = await resolveTaskDataManager(ctx).getTask(ctx, params.ref);
          } catch (err) {
            // AC: @api-contract ac-task-storage-incompatibility-not-not-found
            const conflict = taskStorageIncompatibilityResponse(err, {
              cache: completeEntityCache,
            });
            if (conflict) return errorResponse(conflict.status, conflict.body);
            if (err instanceof TaskDataManagerError) {
              return errorResponse(404, {
                error: "not_found",
                message: `Task reference "${params.ref}" not found`,
              });
            }
            throw err;
          }

          const oldStatus = task.status;

          // AC: @task-data-manager ac-4, ac-6 - Atomic mutation via manager
          // skipCommit: task mutation + spec sync committed as one shadow commit
          const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
            ctx,
            params.ref,
            (latestTask) => ({
              ...latestTask,
              status: "completed" as const,
              completed_at: new Date().toISOString(),
              closed_reason: body.reason,
            }),
            {
              operation: "api-task-complete",
              ref: params.ref,
              detail: `complete ${params.ref}`,
              skipCommit: true,
            },
          );

          // Sync spec implementation status and commit both changes together
          const items = await loadAllItems(ctx);
          const allTasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
          const index = new ReferenceIndex(allTasks, items);
          await syncSpecImplementationStatus(ctx, updatedTask, allTasks, items, index);
          await commitIfShadow(ctx.shadow, `task: complete ${params.ref}`);

          // AC: @daemon-entity-cache ac-write-through — update cache before response
          // Write through both tasks and items domains because syncSpecImplementationStatus
          // modifies spec items (implementation status) as a side effect of task transitions.
          const completeCache = getEntityCache?.(projectContext.path);
          if (completeCache) {
            await Promise.all([
              completeCache.writeThrough("tasks", getTaskWriteThroughHint(updatedTask)),
              completeCache.writeThrough("items", getSpecWriteThroughHint(updatedTask, index)),
            ]);
          }

          // AC: @ui-api-aggregation ac-4 - Include title and old/new status
          pubsub.broadcast(
            "tasks:updates",
            "task_updated",
            {
              ref: params.ref,
              ulid: task._ulid,
              action: "complete",
              title: task.title,
              old_status: oldStatus,
              new_status: "completed",
            },
            projectContext.path,
          );

          return updatedTask;
        },
        {
          params: t.Object({ ref: t.String() }),
          body: t.Object({ reason: t.String() }),
        },
      )

      // AC: @ui-task-board ac-6 - Block task
      // AC: @task-data-manager ac-4 - Mutation via resolveTaskDataManager(ctx).mutateTask
      .post(
        "/:ref/block",
        async ({ params, body, error: errorResponse, projectContext }) => {
          const ctx = await initContext(projectContext.path);
          const blockEntityCache = getEntityCache?.(projectContext.path);

          // AC: @task-data-manager ac-3 — resolve task via manager
          let task: LoadedTask;
          try {
            task = await resolveTaskDataManager(ctx).getTask(ctx, params.ref);
          } catch (err) {
            // AC: @api-contract ac-task-storage-incompatibility-not-not-found
            const conflict = taskStorageIncompatibilityResponse(err, { cache: blockEntityCache });
            if (conflict) return errorResponse(conflict.status, conflict.body);
            if (err instanceof TaskDataManagerError) {
              return errorResponse(404, {
                error: "not_found",
                message: `Task reference "${params.ref}" not found`,
              });
            }
            throw err;
          }

          const oldStatus = task.status;
          const author = getAuthor(ctx.config?.identity?.author);
          const note = createNote(`Blocked: ${body.reason}`, author);

          // AC: @task-data-manager ac-4, ac-6 - Atomic mutation via manager
          // skipCommit: task mutation + spec sync committed as one shadow commit
          const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
            ctx,
            params.ref,
            (latestTask) => ({
              ...latestTask,
              status: "blocked" as const,
              notes: [...latestTask.notes, note],
            }),
            {
              operation: "api-task-block",
              ref: params.ref,
              detail: `block ${params.ref}`,
              skipCommit: true,
            },
          );

          // Sync spec implementation status and commit both changes together
          const items = await loadAllItems(ctx);
          const allTasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
          const index = new ReferenceIndex(allTasks, items);
          await syncSpecImplementationStatus(ctx, updatedTask, allTasks, items, index);
          await commitIfShadow(ctx.shadow, `task: block ${params.ref}`);

          // AC: @daemon-entity-cache ac-write-through — update cache before response
          // Write through both tasks and items domains because syncSpecImplementationStatus
          // modifies spec items (implementation status) as a side effect of task transitions.
          const blockCache = getEntityCache?.(projectContext.path);
          if (blockCache) {
            await Promise.all([
              blockCache.writeThrough("tasks", getTaskWriteThroughHint(updatedTask)),
              blockCache.writeThrough("items", getSpecWriteThroughHint(updatedTask, index)),
            ]);
          }

          // AC: @ui-api-aggregation ac-4 - Include title and old/new status
          pubsub.broadcast(
            "tasks:updates",
            "task_updated",
            {
              ref: params.ref,
              ulid: task._ulid,
              action: "block",
              title: task.title,
              old_status: oldStatus,
              new_status: "blocked",
            },
            projectContext.path,
          );

          return updatedTask;
        },
        {
          params: t.Object({ ref: t.String() }),
          body: t.Object({ reason: t.String() }),
        },
      )
  );
}
