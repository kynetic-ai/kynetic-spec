/**
 * Ref Index API Route
 *
 * Lightweight endpoint for resolving arbitrary refs to display metadata.
 * Returns a map of all resolvable refs (tasks, items, traits) with
 * title, type, and status. Both ULID and slug keys are included.
 *
 * AC Coverage:
 * - @ui-api-ref-resolution ac-4: Returns map of all resolvable refs with display metadata
 * - @ui-api-ref-resolution ac-5: Payload is significantly smaller than full entity lists
 * - @trait-api-endpoint ac-1: Returns 2xx with JSON body
 * - @trait-api-endpoint ac-6: Includes X-Request-Id header (via middleware)
 */

import { Elysia } from "elysia";
import {
  initContext,
  loadAllItems,
  loadPlans,
  ReferenceIndex,
  resolveTaskDataManager,
  type LoadedTask,
  type LoadedSpecItem,
} from "../../parser/index.js";
import { buildRefIndex } from "./ref-resolution.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";

interface RefsRouteOptions {
  getEntityCache?: EntityCacheAccessor;
}

export function createRefsRoutes(options: RefsRouteOptions = {}) {
  const { getEntityCache } = options;

  return (
    new Elysia({ prefix: "/api/refs" })

      // AC: @ui-api-ref-resolution ac-4, ac-5 - Lightweight ref index endpoint
      // AC: @trait-api-endpoint ac-1 - Returns 2xx with JSON body
      // AC: @daemon-entity-cache ac-serve-from-memory — serve from cache when available
      .get("/", async ({ projectContext }) => {
        // AC: @daemon-entity-cache ac-serve-from-memory — try cache for tasks, items, and plans
        const cache = getEntityCache?.(projectContext.path);
        const tasksDomainState = cache?.getDomainState("tasks");
        const itemsDomainState = cache?.getDomainState("items");
        const plansDomainState = cache?.getDomainState("plans");

        // AC: @daemon-entity-cache ac-serve-from-memory — defer initContext to avoid
        // disk/git work when all domains are served from cache
        let _ctx: Awaited<ReturnType<typeof initContext>> | null = null;
        const getCtx = async () => {
          if (!_ctx) _ctx = await initContext(projectContext.path);
          return _ctx;
        };

        const [tasks, items, plans] = await Promise.all([
          cache && tasksDomainState === "ready" && cache.getTaskIndex()
            ? Promise.resolve(cache.getTaskIndex()!)
            : getCtx().then((ctx) => resolveTaskDataManager(ctx).loadAllTasks(ctx)),
          cache && itemsDomainState === "ready" && cache.getItemIndex()
            ? Promise.resolve(cache.getItemIndex()!)
            : getCtx().then((ctx) => loadAllItems(ctx)),
          cache && plansDomainState === "ready" && cache.getPlansIndex()
            ? Promise.resolve(cache.getPlansIndex()!)
            : getCtx().then((ctx) => loadPlans(ctx)),
        ]);
        // TaskSummary and ItemSummary are structurally compatible with ReferenceIndex's
        // needs (indexItem uses _ulid + slugs; buildRefIndex uses title, type, status)
        const index = new ReferenceIndex(
          tasks as unknown as LoadedTask[],
          items as unknown as LoadedSpecItem[],
          [],
          plans,
        );
        const refs = buildRefIndex(index);

        return { refs };
      })
  );
}
