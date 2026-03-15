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

import { Elysia } from 'elysia';
import {
  initContext,
  loadAllTasks,
  loadAllItems,
  loadPlans,
  ReferenceIndex,
} from '../../parser/index.js';
import { buildRefIndex } from './ref-resolution.js';

export function createRefsRoutes() {
  return new Elysia({ prefix: '/api/refs' })

    // AC: @ui-api-ref-resolution ac-4, ac-5 - Lightweight ref index endpoint
    // AC: @trait-api-endpoint ac-1 - Returns 2xx with JSON body
    .get('/', async ({ projectContext }) => {
      const ctx = await initContext(projectContext.path);
      const [tasks, items, plans] = await Promise.all([
        loadAllTasks(ctx),
        loadAllItems(ctx),
        loadPlans(ctx),
      ]);
      const index = new ReferenceIndex(tasks, items, [], plans);
      const refs = buildRefIndex(index);

      return { refs };
    });
}
