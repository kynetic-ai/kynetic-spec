/**
 * Spec Item API Routes
 *
 * REST endpoints for spec item operations:
 * - GET /api/items - list with filters and pagination
 * - GET /api/items/:ref - get single item
 * - GET /api/items/:ref/tasks - get linked tasks
 *
 * AC Coverage:
 * - ac-8: GET /api/items returns array of spec items
 * - ac-9: Type filter with multi-value support
 * - ac-10: GET /api/items/:ref with full details
 * - ac-11: GET /api/items/:ref/tasks via AlignmentIndex
 */

import { join } from "path";
import { Elysia, t } from "elysia";
import {
  initContext,
  loadAllItems,
  loadPlans,
  findTaskByRef,
  ReferenceIndex,
  AlignmentIndex,
  getCachedTestCoverage,
  computeACCoverage,
  resolveTaskDataManager,
  type LoadedSpecItem,
  type LoadedTask,
} from "../../parser/index.js";
import { ImplementationStatusSchema, ItemTypeSchema, MaturitySchema } from "../../schema/common.js";
import { enumArrayUnion } from "./enum-utils.js";
import { getRelatedSessionsForItem } from "./session-related.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";
import type { ItemSummary } from "../../daemon/entity-cache.js";
import { wrapResponse } from "./response-envelope.js";
import { taskStorageIncompatibilityResponse } from "./task-storage-error.js";
import { entityStorageIncompatibilityResponse } from "./entity-storage-error.js";
import {
  computeItemParentMap,
  buildItemAncestors,
  indexItemsByUlid,
  type AncestryItemInput,
} from "../../lib/breadcrumb-ancestry.js";

interface ItemsRouteOptions {
  getEntityCache?: EntityCacheAccessor;
}

/**
 * Compute parent ULIDs for items based on _path and _sourceFile.
 *
 * Thin alias over the shared `computeItemParentMap` so the items list `parent`
 * field and the breadcrumb `ancestors` chain stay derived from one
 * implementation. Items are nested when they share a source file and one
 * item's path is the dotted prefix of another's.
 */
function computeParentMap(items: AncestryItemInput[]): Map<string, string | undefined> {
  return computeItemParentMap(items);
}

function getItemImplementationStatus(item: LoadedSpecItem | ItemSummary): string | undefined {
  if (typeof item.status === "string") {
    return item.status;
  }

  return (item.status as Record<string, string> | undefined)?.implementation;
}

function getItemMaturity(item: LoadedSpecItem | ItemSummary): string | undefined {
  if (typeof item.status === "object") {
    return (item.status as Record<string, string> | undefined)?.maturity;
  }

  return undefined;
}

function toBatchSpecItemSummary(item: LoadedSpecItem | ItemSummary) {
  return {
    kind: "item",
    ulid: item._ulid,
    slugs: item.slugs,
    title: item.title,
    type: item.type,
    status: getItemImplementationStatus(item),
    maturity: getItemMaturity(item),
    traits: item.traits ?? [],
    ac_count:
      "acceptance_criteria_count" in item
        ? (item as ItemSummary).acceptance_criteria_count
        : ((item as LoadedSpecItem).acceptance_criteria?.length ?? 0),
  };
}

function toBatchTaskSummary(task: LoadedTask) {
  return {
    kind: "task",
    ulid: task._ulid,
    slugs: task.slugs,
    title: task.title,
    status: task.status,
    priority: task.priority,
    spec_ref: task.spec_ref,
    assignee: task.assignee,
  };
}

export function createItemsRoutes(_options: ItemsRouteOptions = {}) {
  const { getEntityCache } = _options;

  return (
    new Elysia({ prefix: "/api/items" })
      // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
      //     — items aggregation may need plan/review data; surface incompatibility
      //     as structured 409 instead of letting it escape as 500.
      .onError(({ error: err, set }) => {
        const conflict = entityStorageIncompatibilityResponse(err);
        if (conflict) {
          set.status = conflict.status;
          return conflict.body;
        }
      })
      // AC: @api-contract ac-8, ac-9 - List items with type filter
      // AC: @daemon-entity-cache ac-serve-from-memory — serve from cache when available
      .get(
        "/",
        async ({ query, projectContext }) => {
          // AC: @daemon-entity-cache ac-serve-from-memory, ac-warming-availability
          const cache = getEntityCache?.(projectContext.path);
          const itemsDomainState = cache?.getDomainState("items");

          // AC: @daemon-entity-cache ac-warming-availability
          if (cache && itemsDomainState === "loading") {
            return wrapResponse([] as never[], {
              cacheDomainState: "loading",
              total: 0,
              offset: 0,
              limit: 0,
            });
          }

          // AC: @daemon-entity-cache ac-serve-from-memory — defer initContext to avoid
          // disk/git work on cache hits
          let _ctx: Awaited<ReturnType<typeof initContext>> | null = null;
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const getCtx = async () => {
            if (!_ctx) _ctx = await initContext(projectContext.path, { syncMode: "skip" });
            return _ctx;
          };

          // AC: @daemon-entity-cache ac-serve-from-memory — use cached item summaries when ready
          let items: (LoadedSpecItem | ItemSummary)[];
          if (cache && itemsDomainState === "ready") {
            const cachedItems = cache.getItemIndex();
            items = cachedItems ?? (await loadAllItems(await getCtx()));
          } else {
            items = await loadAllItems(await getCtx());
          }

          // Compute parent relationships from path structure
          const parentMap = computeParentMap(items);

          // Apply filters
          let filtered = items;

          // AC: @api-contract ac-9 - Multi-value type filter
          if (query.type) {
            const typeFilters = Array.isArray(query.type) ? query.type : [query.type];
            filtered = filtered.filter((item) => typeFilters.includes(item.type));
          }

          // Optional maturity filter (not in ACs but useful)
          if (query.maturity) {
            const maturityFilters = Array.isArray(query.maturity)
              ? query.maturity
              : [query.maturity];
            filtered = filtered.filter((item) => {
              if (typeof item.status === "object" && item.status?.maturity) {
                return maturityFilters.includes(item.status.maturity);
              }
              return false;
            });
          }

          // Optional implementation filter (not in ACs but useful)
          if (query.implementation) {
            const implFilters = Array.isArray(query.implementation)
              ? query.implementation
              : [query.implementation];
            filtered = filtered.filter((item) => {
              if (typeof item.status === "object" && item.status?.implementation) {
                return implFilters.includes(item.status.implementation);
              }
              return false;
            });
          }

          // Tag filter (not in ACs but useful)
          if (query.tag) {
            const tagFilters = Array.isArray(query.tag) ? query.tag : [query.tag];
            filtered = filtered.filter((item) =>
              item.tags?.some((tag) => tagFilters.includes(tag)),
            );
          }

          // Plan filter — show only specs derived from a given plan
          if (query.plan) {
            // AC: @daemon-entity-cache ac-serve-from-memory — try cache for plans
            let plans;
            const plansDomainState = cache?.getDomainState("plans");
            if (cache && plansDomainState === "ready") {
              plans = cache.getPlansIndex();
            }
            if (!plans) {
              const ctx = await getCtx();
              plans = await loadPlans(ctx);
            }
            const plan = plans.find((p) => p._ulid === query.plan || p.slugs.includes(query.plan!));
            if (plan) {
              const derivedRefs = new Set(
                plan.derived_specs.map((r) => (r.startsWith("@") ? r.slice(1) : r)),
              );
              filtered = filtered.filter(
                (item) => derivedRefs.has(item._ulid) || item.slugs.some((s) => derivedRefs.has(s)),
              );
            } else {
              filtered = [];
            }
          }

          // Pagination
          const total = filtered.length;
          const offset = Number(query.offset) || 0;
          const limit = Number(query.limit) || total;

          const paginated = filtered.slice(offset, offset + limit);

          // AC: @api-contract ac-8 - Return spec items (modules, features, requirements)
          const result = paginated.map((item) => ({
            _ulid: item._ulid,
            slugs: item.slugs,
            title: item.title,
            type: item.type,
            status: item.status,
            tags: item.tags,
            parent: parentMap.get(item._ulid),
            created_at: (item as LoadedSpecItem).created,
            acceptance_criteria_count:
              "acceptance_criteria_count" in item
                ? (item as ItemSummary).acceptance_criteria_count
                : (item as LoadedSpecItem).acceptance_criteria?.length || 0,
          }));

          // AC: @trait-api-endpoint ac-4 - Return pagination wrapper
          // AC: @api-contract ac-envelope - Unified envelope response
          return wrapResponse(result, { total, offset, limit, cacheDomainState: itemsDomainState });
        },
        {
          query: t.Object({
            type: t.Optional(enumArrayUnion(ItemTypeSchema.options)),
            maturity: t.Optional(enumArrayUnion(MaturitySchema.options)),
            implementation: t.Optional(enumArrayUnion(ImplementationStatusSchema.options)),
            tag: t.Optional(t.Union([t.String(), t.Array(t.String())])),
            plan: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )

      .post(
        "/batch",
        async ({ body, error: errorResponse, projectContext }) => {
          const refs = body.refs;

          // AC: @trait-api-endpoint ac-3 - Validate body
          if (!Array.isArray(refs)) {
            return errorResponse(400, {
              error: "validation_error",
              details: [
                {
                  field: "refs",
                  message: "Refs is required and must be an array of item references",
                },
              ],
            });
          }

          // AC: @batch-item-fetch-api ac-5 - Enforce max batch size
          if (refs.length > 100) {
            return errorResponse(400, {
              error: "validation_error",
              details: [
                {
                  field: "refs",
                  message: "Maximum batch size is 100 refs",
                },
              ],
            });
          }

          // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
          // AC: @daemon-entity-cache ac-serve-from-memory — defer initContext to avoid
          // disk/git work on cache hits
          let _batchCtx: Awaited<ReturnType<typeof initContext>> | null = null;
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const getBatchCtx = async () => {
            if (!_batchCtx)
              _batchCtx = await initContext(projectContext.path, { syncMode: "skip" });
            return _batchCtx;
          };
          // AC: @daemon-entity-cache ac-serve-from-memory — try cache for items and tasks
          const batchCache = getEntityCache?.(projectContext.path);
          const batchItemsDomainState = batchCache?.getDomainState("items");
          const batchItems: (LoadedSpecItem | ItemSummary)[] =
            (batchCache && batchItemsDomainState === "ready" ? batchCache.getItemIndex() : null) ??
            (await loadAllItems(await getBatchCtx()));
          const batchTasksDomainState = batchCache?.getDomainState("tasks");
          // AC: @api-contract ac-task-storage-incompatibility-* — surface 409 with
          // structured guidance instead of a 500 when batch resolution needs tasks
          // from a legacy/unmigrated project.
          let tasks;
          try {
            tasks =
              (batchCache && batchTasksDomainState === "ready"
                ? batchCache.getTaskIndex()
                : null) ??
              (await resolveTaskDataManager(await getBatchCtx()).loadAllTasks(await getBatchCtx()));
          } catch (err) {
            const conflict = taskStorageIncompatibilityResponse(err, { cache: batchCache });
            if (conflict) return errorResponse(conflict.status, conflict.body);
            throw err;
          }

          const resolvedItems = [];
          const unresolved: string[] = [];

          for (const ref of refs) {
            const task = findTaskByRef(tasks as LoadedTask[], ref);
            if (task) {
              resolvedItems.push(toBatchTaskSummary(task));
              continue;
            }

            // Find item by ref — works with both LoadedSpecItem and ItemSummary
            const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;
            const item = batchItems.find(
              (i) =>
                i._ulid === cleanRef ||
                i._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
                i.slugs.includes(cleanRef),
            );
            if (item) {
              resolvedItems.push(toBatchSpecItemSummary(item));
              continue;
            }

            unresolved.push(ref);
          }

          return {
            items: resolvedItems,
            unresolved,
          };
        },
        {
          body: t.Object({
            refs: t.Optional(t.Array(t.String())),
          }),
        },
      )

      // AC: @api-contract ac-10 - Get single item by ref
      // AC: @daemon-entity-cache ac-detail-on-demand — load item detail from cache or disk
      .get(
        "/:ref",
        async ({ params, error: errorResponse, projectContext }) => {
          // AC: @daemon-entity-cache ac-serve-from-memory, ac-detail-on-demand — defer initContext
          // to avoid disk/git work on cache hits. Only initialize when disk fallback is needed.
          let _ctx: Awaited<ReturnType<typeof initContext>> | null = null;
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const getCtx = async () => {
            if (!_ctx) _ctx = await initContext(projectContext.path, { syncMode: "skip" });
            return _ctx;
          };

          // AC: @daemon-entity-cache ac-warming-availability — return loading indicator during warmup
          const cache = getEntityCache?.(projectContext.path);
          const itemsDomainState = cache?.getDomainState("items");
          if (cache && itemsDomainState === "loading") {
            return wrapResponse(null, { cacheDomainState: "loading" });
          }
          // AC: @daemon-entity-cache ac-detail-on-demand — check cache detail tier first
          const itemsDomainReady = cache && itemsDomainState === "ready";

          // Resolve the ref against cached index or disk to find the ULID
          let resolvedUlid: string | null = null;

          if (itemsDomainReady) {
            // Try to resolve via cached item index (avoid loading all items from disk)
            const cachedItems = cache!.getItemIndex();
            const tasksDomainReady = cache!.getDomainState("tasks") === "ready";
            // AC: @api-contract ac-task-storage-incompatibility-* — return 409 with
            // recovery guidance instead of an unhandled error when the cache is
            // not yet warm and the disk read hits a legacy/unmigrated project.
            let tasks: LoadedTask[];
            try {
              tasks = tasksDomainReady
                ? (cache!.getTaskIndex() as unknown as LoadedTask[])
                : await resolveTaskDataManager(await getCtx()).loadAllTasks(await getCtx());
            } catch (err) {
              const conflict = taskStorageIncompatibilityResponse(err, { cache });
              if (conflict) return errorResponse(conflict.status, conflict.body);
              throw err;
            }
            if (cachedItems) {
              const index = new ReferenceIndex(
                tasks ?? [],
                cachedItems as unknown as LoadedSpecItem[],
              );
              const result = index.resolve(params.ref);
              if (result.ok) {
                resolvedUlid = result.ulid;
              }
            }
          }

          // AC: @daemon-entity-cache ac-detail-on-demand — check detail cache
          if (resolvedUlid && cache) {
            const cachedDetail = cache.getItemDetail(resolvedUlid);
            if (cachedDetail) {
              // Serve from detail cache — no initContext() needed on this path
              // Use the full item index for parent map so nested items resolve correctly
              const parentMapSource = (itemsDomainReady ? cache!.getItemIndex() : null) ?? [
                cachedDetail,
              ];
              const parentMap = computeParentMap(parentMapSource);
              // AC: @ui-breadcrumb ac-10 — resolve the full ancestor chain from
              // the in-memory item index (no disk walk, no list fetch).
              const ancestors = buildItemAncestors(
                indexItemsByUlid(parentMapSource),
                parentMap,
                cachedDetail._ulid,
              );
              let acceptanceCriteriaWithCoverage = cachedDetail.acceptance_criteria;
              if (cachedDetail.acceptance_criteria && cachedDetail.acceptance_criteria.length > 0) {
                try {
                  const ctx = await getCtx();
                  const coveredACs = await getCachedTestCoverage(
                    projectContext.path,
                    ctx.config.coverage.scan_paths,
                    ctx.config.coverage.exclude_patterns,
                  );
                  acceptanceCriteriaWithCoverage = computeACCoverage(cachedDetail, coveredACs);
                } catch {
                  // Coverage scan failed - leave as-is
                }
              }
              // AC: @api-contract ac-envelope - Unified envelope response
              return wrapResponse(
                {
                  _ulid: cachedDetail._ulid,
                  slugs: cachedDetail.slugs,
                  title: cachedDetail.title,
                  type: cachedDetail.type,
                  status: cachedDetail.status,
                  tags: cachedDetail.tags,
                  parent: parentMap.get(cachedDetail._ulid),
                  ancestors,
                  description: cachedDetail.description,
                  acceptance_criteria: acceptanceCriteriaWithCoverage,
                  traits: cachedDetail.traits,
                  relationships: cachedDetail.relationships,
                  created_at: cachedDetail.created_at,
                  _sourceFile: cachedDetail._sourceFile,
                },
                { cacheDomainState: itemsDomainState },
              );
            }
          }

          // Detail not in cache — load from disk
          const items = await loadAllItems(await getCtx());
          // AC: @daemon-entity-cache ac-serve-from-memory — use cached tasks when available
          // AC: @api-contract ac-task-storage-incompatibility-* — translate task-storage
          // failures into a structured 409 instead of a 500.
          let tasks;
          try {
            tasks =
              (cache && cache.getDomainState("tasks") === "ready" ? cache.getTaskIndex() : null) ??
              (await resolveTaskDataManager(await getCtx()).loadAllTasks(await getCtx()));
          } catch (err) {
            const conflict = taskStorageIncompatibilityResponse(err, { cache });
            if (conflict) return errorResponse(conflict.status, conflict.body);
            throw err;
          }
          const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);

          // Compute parent relationships from path structure
          const parentMap = computeParentMap(items);

          // Use already-resolved ULID if available, otherwise resolve from disk-loaded index
          const result = resolvedUlid
            ? { ok: true as const, ulid: resolvedUlid, item: null }
            : index.resolve(params.ref);

          if (!result.ok) {
            // AC: @trait-api-endpoint ac-2 - Return 404 with error details
            return errorResponse(404, {
              error: "not_found",
              message: `Item reference "${params.ref}" not found`,
              suggestion: "Use kspec item list or kspec search to find valid item references",
            });
          }

          // Find the item
          const item = items.find((i) => i._ulid === result.ulid);
          if (!item) {
            return errorResponse(404, {
              error: "not_found",
              message: `Reference "${params.ref}" is not a spec item`,
              suggestion: "This reference might point to a task instead",
            });
          }

          // AC: @daemon-entity-cache ac-detail-on-demand — store in cache for subsequent requests
          if (cache && itemsDomainReady) {
            cache.setItemDetail(item._ulid, item);
          }

          // AC: @web-dashboard ac-15 - Compute test coverage for acceptance criteria
          // Uses cached coverage scan for performance (avoids re-scanning on every request)
          let acceptanceCriteriaWithCoverage = item.acceptance_criteria;
          if (item.acceptance_criteria && item.acceptance_criteria.length > 0) {
            try {
              const ctx = await getCtx();
              const coveredACs = await getCachedTestCoverage(
                projectContext.path,
                ctx.config.coverage.scan_paths,
                ctx.config.coverage.exclude_patterns,
              );
              acceptanceCriteriaWithCoverage = computeACCoverage(item, coveredACs);
            } catch (err) {
              // Coverage scan failed - leave as undefined
              console.warn("AC coverage scan failed:", err);
            }
          }

          // AC: @ui-breadcrumb ac-10 — resolve the full ancestor chain from the
          // disk-loaded item set (parent map already computed above).
          const ancestors = buildItemAncestors(indexItemsByUlid(items), parentMap, item._ulid);

          // AC: @api-contract ac-10 - Return full item with acceptance_criteria, traits, relationships
          // AC: @api-contract ac-envelope - Unified envelope response
          return wrapResponse(
            {
              _ulid: item._ulid,
              slugs: item.slugs,
              title: item.title,
              type: item.type,
              status: item.status,
              tags: item.tags,
              parent: parentMap.get(item._ulid),
              ancestors,
              description: item.description,
              acceptance_criteria: acceptanceCriteriaWithCoverage,
              traits: item.traits,
              relationships: item.relationships,
              created_at: item.created_at,
              _sourceFile: item._sourceFile,
            },
            { cacheDomainState: itemsDomainState },
          );
        },
        {
          params: t.Object({
            ref: t.String(),
          }),
        },
      )

      // AC: @api-contract ac-11 - Get tasks linked to spec item
      // AC: @daemon-entity-cache ac-serve-from-memory — use cached indexes when available
      .get(
        "/:ref/tasks",
        async ({ params, error: errorResponse, projectContext }) => {
          // AC: @daemon-entity-cache ac-serve-from-memory — defer initContext on cache hits
          const cache = getEntityCache?.(projectContext.path);
          const tasksDomainReady = cache && cache.getDomainState("tasks") === "ready";
          const itemsDomainReady = cache && cache.getDomainState("items") === "ready";

          let items: LoadedSpecItem[];
          let tasks: LoadedTask[];

          if (tasksDomainReady && itemsDomainReady) {
            // TaskSummary/ItemSummary have _ulid + slugs + spec_ref — sufficient for
            // ReferenceIndex + AlignmentIndex linkage
            tasks = (cache!.getTaskIndex() ?? []) as unknown as LoadedTask[];
            items = (cache!.getItemIndex() ?? []) as unknown as LoadedSpecItem[];
          } else {
            // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
            // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
            const ctx = await initContext(projectContext.path, { syncMode: "skip" });
            items = await loadAllItems(ctx);
            // AC: @api-contract ac-task-storage-incompatibility-* — surface a structured 409
            try {
              tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
            } catch (err) {
              const conflict = taskStorageIncompatibilityResponse(err, { cache });
              if (conflict) return errorResponse(conflict.status, conflict.body);
              throw err;
            }
          }

          const refIndex = new ReferenceIndex(tasks, items);
          const alignIndex = new AlignmentIndex(tasks, items);
          alignIndex.buildLinks(refIndex);

          // Resolve ref
          const result = refIndex.resolve(params.ref);

          if (!result.ok) {
            return errorResponse(404, {
              error: "not_found",
              message: `Item reference "${params.ref}" not found`,
              suggestion: "Use kspec item list to find valid item references",
            });
          }

          const item = items.find((i) => i._ulid === result.ulid);
          if (!item) {
            return errorResponse(404, {
              error: "not_found",
              message: `Reference "${params.ref}" is not a spec item`,
            });
          }

          // AC: @api-contract ac-11 - Get tasks via AlignmentIndex
          const linkedTasks = alignIndex.getTasksForSpec(result.ulid);

          // Return tasks with summary info
          // TaskSummary has notes_count/todos_count directly; LoadedTask has notes/todos arrays
          const result_items = linkedTasks.map((task) => {
            const t = task as LoadedTask & { notes_count?: number; todos_count?: number };
            return {
              _ulid: t._ulid,
              slugs: t.slugs,
              title: t.title,
              type: t.type || "task",
              status: t.status,
              priority: t.priority,
              spec_ref: t.spec_ref,
              tags: t.tags || [],
              depends_on: t.depends_on || [],
              started_at: t.started_at,
              completed_at: t.completed_at,
              created_at: t.created_at,
              notes_count: t.notes_count ?? t.notes?.length ?? 0,
              todos_count: t.todos_count ?? t.todos?.length ?? 0,
            };
          });

          // AC: @api-contract ac-envelope - Unified envelope response
          return wrapResponse(result_items, { total: result_items.length });
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

          let items: LoadedSpecItem[];
          let tasks: LoadedTask[];
          let sessionsDir: string;

          if (tasksDomainReady && itemsDomainReady) {
            // TaskSummary/ItemSummary have _ulid + slugs — sufficient for ReferenceIndex + AlignmentIndex
            tasks = (cache!.getTaskIndex() ?? []) as unknown as LoadedTask[];
            items = (cache!.getItemIndex() ?? []) as unknown as LoadedSpecItem[];
            sessionsDir = join(projectContext.path, ".kspec-sessions");
          } else {
            // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
            const ctx = await initContext(projectContext.path, { syncMode: "skip" });
            items = await loadAllItems(ctx);
            // AC: @api-contract ac-task-storage-incompatibility-* — surface a structured 409
            try {
              tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
            } catch (err) {
              const conflict = taskStorageIncompatibilityResponse(err, { cache });
              if (conflict) return errorResponse(conflict.status, conflict.body);
              throw err;
            }
            sessionsDir = ctx.sessionsDir;
          }

          const result = await getRelatedSessionsForItem({
            itemRef: params.ref,
            items,
            tasks,
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
  );
}
