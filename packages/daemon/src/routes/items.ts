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

import { Elysia, t } from 'elysia';
import {
  initContext,
  loadAllItems,
  loadAllTasks,
  ReferenceIndex,
  AlignmentIndex,
  type LoadedSpecItem,
} from '../../parser/index.js';

interface ItemsRouteOptions {}

/**
 * Compute parent ULIDs for items based on _path and _sourceFile.
 * Items are nested when they share the same source file and
 * one item's path is a prefix of another's path.
 */
function computeParentMap(items: LoadedSpecItem[]): Map<string, string | undefined> {
  const parentMap = new Map<string, string | undefined>();

  // Group items by source file
  const byFile = new Map<string, LoadedSpecItem[]>();
  for (const item of items) {
    const file = item._sourceFile || '';
    if (!byFile.has(file)) {
      byFile.set(file, []);
    }
    byFile.get(file)!.push(item);
  }

  // For each file, determine parent relationships based on path
  for (const [, fileItems] of byFile) {
    // Sort by path length (shorter paths are potential parents)
    const sorted = [...fileItems].sort((a, b) => {
      const aLen = a._path?.length || 0;
      const bLen = b._path?.length || 0;
      return aLen - bLen;
    });

    for (const item of sorted) {
      const itemPath = item._path;

      if (!itemPath) {
        // Root item in file - no parent
        parentMap.set(item._ulid, undefined);
        continue;
      }

      // Find the closest parent by matching path prefix
      // Path format: "features[0].requirements[0]"
      // Parent path: "features[0]" or undefined (root item)
      const lastDot = itemPath.lastIndexOf('.');
      const parentPath = lastDot > -1 ? itemPath.substring(0, lastDot) : undefined;

      // Find parent item
      let parentUlid: string | undefined;
      if (parentPath === undefined) {
        // Direct child of the root item (the item with no path)
        const rootItem = fileItems.find(i => !i._path);
        parentUlid = rootItem?._ulid;
      } else {
        // Find item with matching parent path
        const parentItem = fileItems.find(i => i._path === parentPath);
        parentUlid = parentItem?._ulid;
      }

      parentMap.set(item._ulid, parentUlid);
    }
  }

  return parentMap;
}

export function createItemsRoutes(options: ItemsRouteOptions = {}) {
  // No closure-scoped kspecDir needed - comes from middleware

  return new Elysia({ prefix: '/api/items' })
    // AC: @api-contract ac-8, ac-9 - List items with type filter
    .get(
      '/',
      async ({ query, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const ctx = await initContext(projectContext.path);
        const items = await loadAllItems(ctx);

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
          const maturityFilters = Array.isArray(query.maturity) ? query.maturity : [query.maturity];
          filtered = filtered.filter((item) => {
            if (typeof item.status === 'object' && item.status?.maturity) {
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
            if (typeof item.status === 'object' && item.status?.implementation) {
              return implFilters.includes(item.status.implementation);
            }
            return false;
          });
        }

        // Tag filter (not in ACs but useful)
        if (query.tag) {
          const tagFilters = Array.isArray(query.tag) ? query.tag : [query.tag];
          filtered = filtered.filter((item) =>
            item.tags?.some((t) => tagFilters.includes(t))
          );
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
          created_at: item.created_at,
          acceptance_criteria_count: item.acceptance_criteria?.length || 0,
        }));

        // AC: @trait-api-endpoint ac-4 - Return pagination wrapper
        return {
          items: result,
          total,
          offset,
          limit,
        };
      },
      {
        query: t.Object({
          type: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          maturity: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          implementation: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          tag: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          limit: t.Optional(t.String()),
          offset: t.Optional(t.String()),
        }),
      }
    )

    // AC: @api-contract ac-10 - Get single item by ref
    .get(
      '/:ref',
      async ({ params, error: errorResponse, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const ctx = await initContext(projectContext.path);
        const items = await loadAllItems(ctx);
        const tasks = await loadAllTasks(ctx);
        const index = new ReferenceIndex(tasks, items);

        // Compute parent relationships from path structure
        const parentMap = computeParentMap(items);

        // AC: @api-contract ac-10, @trait-api-endpoint ac-2 - Resolve ref via ReferenceIndex
        const result = index.resolve(params.ref);

        if (!result.ok) {
          // AC: @trait-api-endpoint ac-2 - Return 404 with error details
          return errorResponse(404, {
            error: 'not_found',
            message: `Item reference "${params.ref}" not found`,
            suggestion: 'Use kspec item list or kspec search to find valid item references',
          });
        }

        // Find the item
        const item = items.find((i) => i._ulid === result.ulid);
        if (!item) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Reference "${params.ref}" is not a spec item`,
            suggestion: 'This reference might point to a task instead',
          });
        }

        // AC: @api-contract ac-10 - Return full item with acceptance_criteria, traits, relationships
        return {
          _ulid: item._ulid,
          slugs: item.slugs,
          title: item.title,
          type: item.type,
          status: item.status,
          tags: item.tags,
          parent: parentMap.get(item._ulid),
          description: item.description,
          acceptance_criteria: item.acceptance_criteria,
          traits: item.traits,
          relationships: item.relationships,
          created_at: item.created_at,
          _sourceFile: item._sourceFile,
        };
      },
      {
        params: t.Object({
          ref: t.String(),
        }),
      }
    )

    // AC: @api-contract ac-11 - Get tasks linked to spec item
    .get(
      '/:ref/tasks',
      async ({ params, error: errorResponse, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const ctx = await initContext(projectContext.path);
        const items = await loadAllItems(ctx);
        const tasks = await loadAllTasks(ctx);
        const refIndex = new ReferenceIndex(tasks, items);
        const alignIndex = new AlignmentIndex(tasks, items);
        alignIndex.buildLinks(refIndex);

        // Resolve ref
        const result = refIndex.resolve(params.ref);

        if (!result.ok) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Item reference "${params.ref}" not found`,
            suggestion: 'Use kspec item list to find valid item references',
          });
        }

        const item = items.find((i) => i._ulid === result.ulid);
        if (!item) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Reference "${params.ref}" is not a spec item`,
          });
        }

        // AC: @api-contract ac-11 - Get tasks via AlignmentIndex
        const linkedTasks = alignIndex.getTasksForSpec(result.ulid);

        // Return tasks with summary info
        const result_items = linkedTasks.map((task) => ({
          _ulid: task._ulid,
          slugs: task.slugs,
          title: task.title,
          status: task.status,
          priority: task.priority,
          started_at: task.started_at,
          completed_at: task.completed_at,
          notes_count: task.notes?.length || 0,
          todos_count: task.todos?.length || 0,
        }));

        return {
          items: result_items,
          total: result_items.length,
        };
      },
      {
        params: t.Object({
          ref: t.String(),
        }),
      }
    );
}
