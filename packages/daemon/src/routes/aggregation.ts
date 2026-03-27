/**
 * Aggregation API Routes
 *
 * Pre-computed server-side aggregation endpoints:
 * - GET /api/aggregation/tasks/summary - Task status counts with dependency-aware distinctions
 * - GET /api/aggregation/validation - Extended validation/alignment stats with entity and AC counts
 * - GET /api/aggregation/inbox - Inbox items with inline triage status
 *
 * AC Coverage:
 * - @ui-api-aggregation ac-1: Task status summary with ready vs blocked distinctions
 * - @ui-api-aggregation ac-2: Validation/alignment stats with entity counts, AC counts, orphan counts
 * - @ui-api-aggregation ac-3: Inbox items with inline triage status
 */

import { Elysia } from "elysia";
import {
  initContext,
  loadInboxItems,
  loadTriageRecords,
  findTriageRecordByInboxRef,
  validate,
  AlignmentIndex,
  ReferenceIndex,
  areDependenciesMet,
  resolveTaskDataManager,
} from "../../parser/index.js";
import { TriageActionSchema, TriageStatusSchema } from "../../schema/index.js";
import type { LoadedTask, LoadedSpecItem } from "../../parser/index.js";
import type {
  TaskStatusSummary,
  ValidationAggregation,
  InboxItemWithTriage,
} from "@kynetic-ai/shared";
import type { EntityCacheAccessor } from "./entity-cache-types.js";

interface AggregationRouteOptions {
  getEntityCache?: EntityCacheAccessor;
}

export function createAggregationRoutes(_options: AggregationRouteOptions = {}) {
  const { getEntityCache } = _options;

  return (
    new Elysia({ prefix: "/api/aggregation" })
      // AC: @ui-api-aggregation ac-1 - Task status summary with dependency-aware distinctions
      // AC: @daemon-read-path ac-no-per-request-sync, ac-index-from-cache — serve from cached task index
      .get("/tasks/summary", async ({ projectContext }) => {
        const cache = getEntityCache?.(projectContext.path);
        const tasksDomainState = cache?.getDomainState("tasks");

        // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
        if (cache && tasksDomainState === "loading") {
          return { counts: {}, ready: 0, blocked_by_dependencies: 0, total: 0, _cache_status: "loading" as const };
        }

        let tasks: LoadedTask[];
        if (cache && tasksDomainState === "ready") {
          const cachedTasks = cache.getTaskIndex();
          if (cachedTasks) {
            // AC: @daemon-read-path ac-index-from-cache — build from cached data
            tasks = cachedTasks as unknown as LoadedTask[];
          } else {
            const ctx = await initContext(projectContext.path);
            tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
          }
        } else {
          const ctx = await initContext(projectContext.path);
          tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
        }

        // Count tasks by status
        const counts: Record<string, number> = {};
        for (const task of tasks) {
          counts[task.status] = (counts[task.status] || 0) + 1;
        }

        // Dependency-aware distinctions: ready vs blocked by incomplete dependencies
        let ready = 0;
        let blockedByDependencies = 0;
        for (const task of tasks) {
          if (task.status !== "pending" && task.status !== "needs_work") continue;
          if (task.blocked_by.length > 0) {
            blockedByDependencies++;
          } else if (!areDependenciesMet(task, tasks)) {
            blockedByDependencies++;
          } else {
            ready++;
          }
        }

        const result: TaskStatusSummary = {
          counts,
          ready,
          blocked_by_dependencies: blockedByDependencies,
          total: tasks.length,
        };

        return result;
      })

      // AC: @ui-api-aggregation ac-2 - Extended validation/alignment stats
      // AC: @daemon-read-path ac-index-from-cache — build alignment/reference indexes from cached entity data
      // Note: validate() requires full context for deep schema/ref validation,
      // but index building uses cached entity data when available.
      .get("/validation", async ({ projectContext }) => {
        const cache = getEntityCache?.(projectContext.path);
        const tasksDomainState = cache?.getDomainState("tasks");
        const itemsDomainState = cache?.getDomainState("items");

        // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
        if (cache && (tasksDomainState === "loading" || itemsDomainState === "loading")) {
          return {
            stats: { totalSpecs: 0, specsWithTasks: 0, alignedSpecs: 0, orphanedSpecs: 0 },
            warnings: [],
            entity_counts: { items: 0, tasks: 0, traits: 0 },
            ac_counts: { total: 0, covered: 0, uncovered: 0 },
            orphan_count: 0,
            valid: true,
            error_count: 0,
            warning_count: 0,
            _cache_status: "loading" as const,
          };
        }

        // Resolve tasks and items from cache when available
        // AC: @daemon-read-path ac-index-from-cache — indexes built from cached data
        let tasks: LoadedTask[];
        if (cache && tasksDomainState === "ready") {
          tasks = (cache.getTaskIndex() ?? []) as unknown as LoadedTask[];
        } else {
          const ctx = await initContext(projectContext.path);
          tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
        }

        let items: LoadedSpecItem[];
        if (cache && itemsDomainState === "ready") {
          items = (cache.getItemIndex() ?? []) as unknown as LoadedSpecItem[];
        } else {
          const { loadAllItems } = await import("../../parser/index.js");
          const ctx = await initContext(projectContext.path);
          items = await loadAllItems(ctx);
        }

        // Build reference index from cached data for alignment resolution
        const refIndex = new ReferenceIndex(tasks, items);

        // Run validation for error/warning counts and completeness data
        // Note: validate() performs deep schema/ref/completeness checks that
        // require full context — this is computational, not index building
        const ctx = await initContext(projectContext.path);
        const validationResult = await validate(ctx);

        // Build alignment index from cached data
        const alignIndex = new AlignmentIndex(tasks, items);
        alignIndex.buildLinks(refIndex);
        const alignStats = alignIndex.getStats();
        const alignWarnings = alignIndex.findAlignmentWarnings();

        // Entity counts
        const traitCount = items.filter((item) => item.type === "trait").length;

        // AC counts from completeness warnings
        // Count total ACs across all non-trait items
        // When serving from cache, ItemSummary has acceptance_criteria_count;
        // when from disk, LoadedSpecItem has acceptance_criteria array.
        let totalACs = 0;
        for (const item of items) {
          if (item.type !== "trait") {
            const asAny = item as Record<string, unknown>;
            totalACs += typeof asAny.acceptance_criteria_count === "number"
              ? asAny.acceptance_criteria_count
              : (item.acceptance_criteria?.length || 0);
          }
        }

        // Count uncovered ACs from completeness warnings
        // Each warning represents one item with N uncovered ACs listed in details
        // Details format: "Uncovered: ac-1, ac-2, ac-3"
        const uncoveredWarnings = validationResult.completenessWarnings.filter(
          (w) => w.type === "missing_test_coverage" && w.subtype === "own_ac",
        );
        let uncoveredCount = 0;
        for (const warning of uncoveredWarnings) {
          if (warning.details) {
            // Parse "Uncovered: ac-1, ac-2, ac-3" to count individual ACs
            const acList = warning.details.replace(/^Uncovered:\s*/, "");
            uncoveredCount += acList.split(",").filter((s) => s.trim().length > 0).length;
          }
        }
        const coveredCount = Math.max(0, totalACs - uncoveredCount);

        const result: ValidationAggregation = {
          stats: {
            totalSpecs: alignStats.totalSpecs,
            specsWithTasks: alignStats.specsWithTasks,
            alignedSpecs: alignStats.alignedSpecs,
            orphanedSpecs: alignStats.orphanedSpecs,
          },
          warnings: alignWarnings,
          entity_counts: {
            items: validationResult.stats.itemsChecked,
            tasks: validationResult.stats.tasksChecked,
            traits: traitCount,
          },
          ac_counts: {
            total: totalACs,
            covered: coveredCount,
            uncovered: uncoveredCount,
          },
          orphan_count: validationResult.orphans.length,
          valid: validationResult.valid,
          error_count: validationResult.schemaErrors.length + validationResult.refErrors.length,
          warning_count:
            validationResult.refWarnings.length + validationResult.completenessWarnings.length,
        };

        return result;
      })

      // AC: @ui-api-aggregation ac-3 - Inbox items with inline triage status
      // AC: @daemon-read-path ac-no-per-request-sync, ac-index-from-cache — serve from cached inbox and triage indexes
      .get("/inbox", async ({ projectContext }) => {
        const cache = getEntityCache?.(projectContext.path);
        const inboxDomainState = cache?.getDomainState("inbox");
        const triageDomainState = cache?.getDomainState("triage");

        // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
        if (cache && (inboxDomainState === "loading" || triageDomainState === "loading")) {
          return { items: [], total: 0, _cache_status: "loading" as const };
        }

        let _ctx: Awaited<ReturnType<typeof initContext>> | null = null;
        const getCtx = async () => {
          if (!_ctx) _ctx = await initContext(projectContext.path);
          return _ctx;
        };

        let inboxItems;
        if (cache && inboxDomainState === "ready") {
          inboxItems = cache.getInboxIndex();
        }
        if (!inboxItems) {
          const ctx = await getCtx();
          inboxItems = await loadInboxItems(ctx);
        }

        let triageRecords;
        if (cache && triageDomainState === "ready") {
          triageRecords = cache.getTriageIndex();
        }
        if (!triageRecords) {
          const ctx = await getCtx();
          triageRecords = await loadTriageRecords(ctx);
        }

        // Sort by created_at descending (newest first)
        const sorted = [...inboxItems].toSorted(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );

        // Merge triage status inline
        const items: InboxItemWithTriage[] = sorted.map((item) => {
          // Find matching triage record by inbox_ref (works with both full and index records)
          const triageRecord = triageRecords!.find(
            (r) => r.inbox_ref === item._ulid,
          );

          const result: InboxItemWithTriage = {
            _ulid: item._ulid,
            text: item.text,
            tags: item.tags,
            added_by: item.added_by,
            created_at: item.created_at,
          };

          if (triageRecord) {
            const triageStatus = TriageStatusSchema.safeParse(triageRecord.status);
            const triageAction = triageRecord.action
              ? TriageActionSchema.safeParse(triageRecord.action)
              : null;
            result.triage = {
              _ulid: triageRecord._ulid,
              status: triageStatus.success ? triageStatus.data : "pending",
              action: triageAction?.success ? triageAction.data : undefined,
              reasoning: triageRecord.reasoning,
              decided_by: triageRecord.decided_by,
              acted_at: triageRecord.acted_at,
              result_ref: triageRecord.result_ref,
            };
          }

          return result;
        });

        return {
          items,
          total: items.length,
        };
      })
  );
}
