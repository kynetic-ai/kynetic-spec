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

import { Elysia } from 'elysia';
import {
  initContext,
  loadAllTasks,
  loadAllItems,
  loadInboxItems,
  loadTriageRecords,
  findTriageRecordByInboxRef,
  buildIndexes,
  validate,
  AlignmentIndex,
  areDependenciesMet,
} from '../../parser/index.js';
import type {
  TaskStatusSummary,
  ValidationAggregation,
  InboxItemWithTriage,
} from '@kynetic-ai/shared';

interface AggregationRouteOptions {}

export function createAggregationRoutes(options: AggregationRouteOptions = {}) {
  return new Elysia({ prefix: '/api/aggregation' })
    // AC: @ui-api-aggregation ac-1 - Task status summary with dependency-aware distinctions
    .get('/tasks/summary', async ({ projectContext }) => {
      const ctx = await initContext(projectContext.path);
      const tasks = await loadAllTasks(ctx);

      // Count tasks by status
      const counts: Record<string, number> = {};
      for (const task of tasks) {
        counts[task.status] = (counts[task.status] || 0) + 1;
      }

      // Dependency-aware distinctions: ready vs blocked by incomplete dependencies
      let ready = 0;
      let blockedByDependencies = 0;
      for (const task of tasks) {
        if (task.status !== 'pending' && task.status !== 'needs_work') continue;
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
    .get('/validation', async ({ projectContext }) => {
      const ctx = await initContext(projectContext.path);
      const { tasks, items, refIndex } = await buildIndexes(ctx);

      // Run validation for error/warning counts and completeness data
      const validationResult = await validate(ctx);

      // Build alignment index
      const alignIndex = new AlignmentIndex(tasks, items);
      alignIndex.buildLinks(refIndex);
      const alignStats = alignIndex.getStats();
      const alignWarnings = alignIndex.findAlignmentWarnings();

      // Entity counts
      const traitCount = items.filter((item) => item.type === 'trait').length;

      // AC counts from completeness warnings
      // Count total ACs across all non-trait items
      let totalACs = 0;
      for (const item of items) {
        if (item.type !== 'trait') {
          totalACs += item.acceptance_criteria?.length || 0;
        }
      }

      // Count uncovered ACs from completeness warnings
      const uncoveredWarnings = validationResult.completenessWarnings.filter(
        (w) => w.type === 'missing_test_coverage' && w.subtype === 'own_ac'
      );
      // Each warning covers one item; parse details for individual AC count
      // The message format includes the count; use warning count as proxy for uncovered items
      const uncoveredCount = uncoveredWarnings.length;
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
        warning_count: validationResult.refWarnings.length + validationResult.completenessWarnings.length,
      };

      return result;
    })

    // AC: @ui-api-aggregation ac-3 - Inbox items with inline triage status
    .get('/inbox', async ({ projectContext }) => {
      const ctx = await initContext(projectContext.path);
      const inboxItems = await loadInboxItems(ctx);
      const triageRecords = await loadTriageRecords(ctx);

      // Sort by created_at descending (newest first)
      const sorted = [...inboxItems].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      // Merge triage status inline
      const items: InboxItemWithTriage[] = sorted.map((item) => {
        const triageRecord = findTriageRecordByInboxRef(triageRecords, item._ulid);

        const result: InboxItemWithTriage = {
          _ulid: item._ulid,
          text: item.text,
          tags: item.tags,
          added_by: item.added_by,
          created_at: item.created_at,
        };

        if (triageRecord) {
          result.triage = {
            _ulid: triageRecord._ulid,
            status: triageRecord.status as 'pending' | 'triaged' | 'acted_on',
            action: triageRecord.action as 'promote' | 'delete' | 'defer' | 'spec-gap' | 'duplicate' | undefined,
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
    });
}
