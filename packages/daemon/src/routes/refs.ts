/**
 * Refs Index API Route
 *
 * Lightweight ref-to-display-metadata endpoint for resolving arbitrary refs
 * without fetching full entity lists.
 *
 * - GET /api/refs/index - returns map of all refs keyed by ULID and slug
 *
 * AC Coverage:
 * - @ui-api-ref-resolution ac-4: Returns map with title, type, status per ref
 * - @ui-api-ref-resolution ac-5: Lightweight payload (no descriptions, notes, ACs, tags)
 * - @trait-api-endpoint ac-1: Returns 2xx with JSON body
 * - @trait-api-endpoint ac-6: Includes X-Request-Id header (via middleware)
 */

import { Elysia } from 'elysia';
import {
  initContext,
  loadAllItems,
  loadAllTasks,
  type LoadedSpecItem,
} from '../../parser/index.js';
import type { RefIndexEntry, RefIndexResponse } from '@kynetic-ai/shared';

/**
 * Extract a displayable status string from a spec item's status field.
 * Spec items store status as { maturity, implementation } or as a string.
 */
function getItemStatus(item: LoadedSpecItem): string | undefined {
  if (typeof item.status === 'string') {
    return item.status;
  }
  return item.status?.implementation;
}

export function createRefsRoutes() {
  return new Elysia({ prefix: '/api/refs' })
    // AC: @ui-api-ref-resolution ac-4 — lightweight index of all refs
    // AC: @ui-api-ref-resolution ac-5 — only display metadata, no heavyweight fields
    // AC: @trait-api-endpoint ac-1 — returns 2xx with JSON body
    .get('/index', async ({ projectContext }): Promise<RefIndexResponse> => {
      const ctx = await initContext(projectContext.path);
      const [tasks, items] = await Promise.all([
        loadAllTasks(ctx),
        loadAllItems(ctx),
      ]);

      const refs: Record<string, RefIndexEntry> = {};

      // Index tasks by ULID and slugs
      for (const task of tasks) {
        const entry: RefIndexEntry = {
          title: task.title,
          type: task.type || 'task',
          status: task.status,
        };
        refs[task._ulid] = entry;
        for (const slug of task.slugs) {
          refs[slug] = entry;
        }
      }

      // Index spec items (including traits) by ULID and slugs
      for (const item of items) {
        const entry: RefIndexEntry = {
          title: item.title,
          type: item.type || 'item',
          status: getItemStatus(item),
        };
        refs[item._ulid] = entry;
        for (const slug of item.slugs) {
          refs[slug] = entry;
        }
      }

      return { refs };
    });
}
