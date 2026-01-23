/**
 * Validation and Search API Routes
 *
 * REST endpoints for search and validation operations:
 * - GET /api/search?q=query - Search across all items/tasks/inbox/meta
 * - GET /api/validate - Run full validation
 * - GET /api/alignment - Get alignment stats and warnings
 *
 * AC Coverage:
 * - ac-19: GET /api/search?q=query searches across all entities
 * - ac-20: GET /api/validate returns ValidationResult
 * - ac-21: GET /api/alignment returns AlignmentIndex stats
 */

import { Elysia, t } from 'elysia';
import {
  initContext,
  buildIndexes,
  loadInboxItems,
  loadMetaContext,
  validate,
  AlignmentIndex,
  type LoadedSpecItem,
  type LoadedTask,
  type LoadedInboxItem,
} from '../../parser/index.js';
import type {
  LoadedAgent,
  LoadedWorkflow,
  LoadedObservation,
  LoadedConvention,
} from '../../parser/meta.js';
import { grepItem } from '../../utils/grep.js';

interface ValidationRouteOptions {
  kspecDir: string;
}

export function createValidationRoutes(options: ValidationRouteOptions) {
  const { kspecDir } = options;

  return new Elysia({ prefix: '/api' })
    // AC: @api-contract ac-19 - Search across all entities
    .get(
      '/search',
      async ({ query }) => {
        const ctx = await initContext(kspecDir);
        const { tasks, items } = await buildIndexes(ctx);

        const pattern = query.q;
        if (!pattern) {
          return {
            results: [],
            total: 0,
          };
        }

        const limit = query.limit ? parseInt(query.limit, 10) : 50;

        interface SearchResult {
          type:
            | 'item'
            | 'task'
            | 'inbox'
            | 'observation'
            | 'agent'
            | 'workflow'
            | 'convention';
          ulid: string;
          title: string;
          matchedFields: string[];
        }

        const results: SearchResult[] = [];

        // AC: @api-contract ac-19 - Search spec items
        if (!query.tasksOnly) {
          for (const item of items) {
            // Apply type filter if provided
            if (query.type && item.type !== query.type) continue;

            const match = grepItem(item as unknown as Record<string, unknown>, pattern);
            if (match) {
              results.push({
                type: 'item',
                ulid: item._ulid,
                title: item.title,
                matchedFields: match.matchedFields,
              });
            }
          }
        }

        // AC: @api-contract ac-19 - Search tasks
        if (!query.itemsOnly) {
          for (const task of tasks) {
            // Apply status filter if provided
            if (query.status && task.status !== query.status) continue;

            const match = grepItem(task as unknown as Record<string, unknown>, pattern);
            if (match) {
              results.push({
                type: 'task',
                ulid: task._ulid,
                title: task.title,
                matchedFields: match.matchedFields,
              });
            }
          }
        }

        // AC: @api-contract ac-19 - Search inbox items
        if (!query.itemsOnly && !query.tasksOnly) {
          const inboxItems = await loadInboxItems(ctx);
          for (const inboxItem of inboxItems) {
            const match = grepItem(inboxItem as unknown as Record<string, unknown>, pattern);
            if (match) {
              results.push({
                type: 'inbox',
                ulid: inboxItem._ulid,
                title: inboxItem.text,
                matchedFields: match.matchedFields,
              });
            }
          }
        }

        // AC: @api-contract ac-19 - Search meta entities
        if (!query.itemsOnly && !query.tasksOnly) {
          const metaCtx = await loadMetaContext(ctx);

          // Search observations
          for (const observation of metaCtx.observations) {
            const match = grepItem(observation as unknown as Record<string, unknown>, pattern);
            if (match) {
              results.push({
                type: 'observation',
                ulid: observation._ulid,
                title: observation.content,
                matchedFields: match.matchedFields,
              });
            }
          }

          // Search agents
          for (const agent of metaCtx.agents) {
            const match = grepItem(agent as unknown as Record<string, unknown>, pattern);
            if (match) {
              results.push({
                type: 'agent',
                ulid: agent._ulid,
                title: `${agent.id} - ${agent.name}`,
                matchedFields: match.matchedFields,
              });
            }
          }

          // Search workflows
          for (const workflow of metaCtx.workflows) {
            const match = grepItem(workflow as unknown as Record<string, unknown>, pattern);
            if (match) {
              results.push({
                type: 'workflow',
                ulid: workflow._ulid,
                title: workflow.id,
                matchedFields: match.matchedFields,
              });
            }
          }

          // Search conventions
          for (const convention of metaCtx.conventions) {
            const match = grepItem(convention as unknown as Record<string, unknown>, pattern);
            if (match) {
              results.push({
                type: 'convention',
                ulid: convention._ulid,
                title: convention.domain,
                matchedFields: match.matchedFields,
              });
            }
          }
        }

        // Apply limit
        const limitedResults = results.slice(0, limit);

        // AC: @api-contract ac-19 - Return search results with matched fields
        return {
          results: limitedResults,
          total: results.length,
          showing: limitedResults.length,
        };
      },
      {
        query: t.Object({
          q: t.Optional(t.String()),
          type: t.Optional(t.String()),
          status: t.Optional(t.String()),
          itemsOnly: t.Optional(t.String()),
          tasksOnly: t.Optional(t.String()),
          limit: t.Optional(t.String()),
        }),
      }
    )

    // AC: @api-contract ac-20 - Run full validation
    .get('/validate', async () => {
      const ctx = await initContext(kspecDir);

      // AC: @api-contract ac-20 - Run validation and return ValidationResult
      const result = await validate(ctx);

      return {
        valid: result.valid,
        schemaErrors: result.schemaErrors,
        refErrors: result.refErrors,
        refWarnings: result.refWarnings,
        orphans: result.orphans,
        completenessWarnings: result.completenessWarnings,
        traitCycles: result.traitCycles,
      };
    })

    // AC: @api-contract ac-21 - Get alignment stats and warnings
    .get('/alignment', async () => {
      const ctx = await initContext(kspecDir);
      const { tasks, items, refIndex } = await buildIndexes(ctx);

      // AC: @api-contract ac-21 - Create AlignmentIndex and get stats
      const alignIndex = new AlignmentIndex(tasks, items);
      alignIndex.buildLinks(refIndex);

      const stats = alignIndex.getStats();
      const warnings = alignIndex.findAlignmentWarnings();

      return {
        stats: {
          totalSpecs: stats.totalSpecs,
          specsWithTasks: stats.specsWithTasks,
          alignedSpecs: stats.alignedSpecs,
          orphanedSpecs: stats.orphanedSpecs,
        },
        warnings,
      };
    });
}
