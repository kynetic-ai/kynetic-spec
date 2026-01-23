/**
 * Inbox API Routes
 *
 * REST endpoints for inbox item operations:
 * - GET /api/inbox - list all items
 * - POST /api/inbox - create item
 * - DELETE /api/inbox/:ref - delete item
 *
 * AC Coverage:
 * - ac-12: GET /api/inbox returns items ordered by created_at desc
 * - ac-13: POST /api/inbox creates item with generated ULID
 * - ac-14: DELETE /api/inbox/:ref removes item
 */

import { Elysia, t } from 'elysia';
import {
  initContext,
  loadInboxItems,
  createInboxItem,
  saveInboxItem,
  deleteInboxItem,
  findInboxItemByRef,
  ReferenceIndex,
  type InboxItemInput,
} from '../../../src/parser/index.js';
import { commitIfShadow } from '../../../src/parser/shadow.js';
import type { PubSubManager } from '../websocket/pubsub';

interface InboxRouteOptions {
  kspecDir: string;
  pubsub: PubSubManager;
}

export function createInboxRoutes(options: InboxRouteOptions) {
  const { kspecDir, pubsub } = options;

  return new Elysia({ prefix: '/api/inbox' })
    // AC: @api-contract ac-12 - List inbox items ordered by created_at desc
    .get('/', async () => {
      const ctx = await initContext(kspecDir);
      const items = await loadInboxItems(ctx);

      // AC: @api-contract ac-12 - Sort by created_at descending (newest first)
      const sorted = [...items].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      return {
        items: sorted,
        total: sorted.length,
      };
    })

    // AC: @api-contract ac-13 - Create inbox item
    .post(
      '/',
      async ({ body, error: errorResponse }) => {
        const ctx = await initContext(kspecDir);

        // AC: @trait-api-endpoint ac-3 - Validate body
        if (!body.text || typeof body.text !== 'string' || body.text.trim().length === 0) {
          return errorResponse(400, {
            error: 'validation_error',
            details: [
              {
                field: 'text',
                message: 'Text is required and must be a non-empty string',
              },
            ],
          });
        }

        // Create inbox item input
        const input: InboxItemInput = {
          text: body.text,
          tags: body.tags,
          added_by: body.added_by,
        };

        // AC: @api-contract ac-13 - Generate ULID and create item
        const item = createInboxItem(input);

        // Save and commit
        await saveInboxItem(ctx, item);
        await commitIfShadow(ctx, `inbox: add item ${item._ulid}`);

        // Broadcast update
        pubsub.broadcast('inbox:updates', 'inbox_item_created', {
          ulid: item._ulid,
        });

        // AC: @api-contract ac-13 - Return item with generated ULID
        return {
          success: true,
          item,
        };
      },
      {
        body: t.Object({
          text: t.String(),
          tags: t.Optional(t.Array(t.String())),
          added_by: t.Optional(t.String()),
        }),
      }
    )

    // AC: @api-contract ac-14 - Delete inbox item
    .delete(
      '/:ref',
      async ({ params, error: errorResponse }) => {
        const ctx = await initContext(kspecDir);
        const items = await loadInboxItems(ctx);
        const index = new ReferenceIndex(ctx);

        // Resolve ref
        const result = index.resolve(params.ref);
        if (!result.ok) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Inbox item reference "${params.ref}" not found`,
            suggestion: 'Use kspec inbox list to find valid inbox item references',
          });
        }

        // Verify it's an inbox item
        const item = findInboxItemByRef(items, result.ulid);
        if (!item) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Reference "${params.ref}" is not an inbox item`,
          });
        }

        // AC: @api-contract ac-14 - Delete item
        await deleteInboxItem(ctx, result.ulid);
        await commitIfShadow(ctx, `inbox: delete ${params.ref}`);

        // Broadcast update
        pubsub.broadcast('inbox:updates', 'inbox_item_deleted', {
          ref: params.ref,
          ulid: result.ulid,
        });

        // AC: @api-contract ac-14 - Return success confirmation
        return {
          success: true,
          deleted: result.ulid,
        };
      },
      {
        params: t.Object({
          ref: t.String(),
        }),
      }
    );
}
