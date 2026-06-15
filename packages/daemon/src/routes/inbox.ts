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

import { Elysia, t } from "elysia";
import {
  initContext,
  loadInboxItems,
  createInboxItem,
  saveInboxItem,
  deleteInboxItem,
  findInboxItemByRef,
  type InboxItemInput,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import type { PubSubManager } from "../websocket/pubsub.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";
import { resolveWriteActor, toValidationErrorBody } from "./actor-resolution.js";
import { wrapResponse } from "./response-envelope.js";

interface InboxRouteOptions {
  pubsub: PubSubManager;
  getEntityCache?: EntityCacheAccessor;
}

export function createInboxRoutes(options: InboxRouteOptions) {
  const { pubsub, getEntityCache } = options;

  return (
    new Elysia({ prefix: "/api/inbox" })
      // AC: @api-contract ac-12 - List inbox items ordered by created_at desc
      // AC: @daemon-entity-cache ac-serve-from-memory — serve from cache when available
      .get("/", async ({ projectContext }) => {
        // AC: @daemon-entity-cache ac-serve-from-memory — use cached inbox when ready
        const cache = getEntityCache?.(projectContext.path);
        const inboxDomainState = cache?.getDomainState("inbox");

        // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
        if (cache && inboxDomainState === "loading") {
          return wrapResponse([] as never[], { cacheDomainState: "loading", total: 0 });
        }

        let items;
        if (cache && inboxDomainState === "ready") {
          items = cache.getInboxIndex();
        }
        if (!items) {
          // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          items = await loadInboxItems(ctx);
        }

        // AC: @api-contract ac-12 - Sort by created_at descending (newest first)
        const sorted = [...items].toSorted(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );

        // AC: @api-contract ac-envelope - Unified envelope response
        return wrapResponse(sorted, { total: sorted.length, cacheDomainState: inboxDomainState });
      })

      // AC: @api-contract ac-13 - Create inbox item
      .post(
        "/",
        async ({ body, error: errorResponse, projectContext }) => {
          // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
          const ctx = await initContext(projectContext.path);

          // AC: @trait-api-endpoint ac-3 - Validate body
          if (!body.text || typeof body.text !== "string" || body.text.trim().length === 0) {
            return errorResponse(400, {
              error: "validation_error",
              details: [
                {
                  field: "text",
                  message: "Text is required and must be a non-empty string",
                },
              ],
            });
          }

          // AC: @actor-identity-resolution ac-7 ac-8 — canonical added_by or rejection.
          const addedByResult = await resolveWriteActor(
            ctx,
            getEntityCache,
            projectContext.path,
            body.added_by,
            "added_by",
          );
          if (!addedByResult.ok) {
            return errorResponse(400, toValidationErrorBody(addedByResult));
          }

          // Create inbox item input
          const input: InboxItemInput = {
            text: body.text,
            tags: body.tags,
            added_by: addedByResult.actor,
          };

          // AC: @api-contract ac-13 - Generate ULID and create item
          // AC: @actor-identity-resolution ac-6 ac-8 — canonical added_by (already
          // resolved through the shared utility into input.added_by above).
          const item = createInboxItem(input, addedByResult.actor);

          // Save and commit
          await saveInboxItem(ctx, item);
          await commitIfShadow(ctx.shadow, `inbox: add item ${item._ulid}`);

          // AC: @daemon-entity-cache ac-write-through — update cache before response
          const createCache = getEntityCache?.(projectContext.path);
          if (createCache) {
            await createCache.writeThrough("inbox");
          }

          // Broadcast update
          // AC: @ui-api-aggregation ac-4 - Include full item data for in-place UI updates
          // AC: @multi-directory-daemon ac-18 - Broadcast scoped to request project
          pubsub.broadcast(
            "inbox:updates",
            "inbox_item_created",
            {
              ulid: item._ulid,
              text: item.text,
              tags: item.tags,
              added_by: item.added_by,
              created_at: item.created_at,
            },
            projectContext.path,
          );

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
        },
      )

      // AC: @api-contract ac-14 - Delete inbox item
      .delete(
        "/:ref",
        async ({ params, error: errorResponse, projectContext }) => {
          // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
          const ctx = await initContext(projectContext.path);
          const inboxItems = await loadInboxItems(ctx);

          // Resolve ref directly against inbox items (inbox items are not in
          // the general ReferenceIndex which only covers tasks/specs/plans/reviews)
          const item = findInboxItemByRef(inboxItems, params.ref);
          if (!item) {
            return errorResponse(404, {
              error: "not_found",
              message: `Inbox item reference "${params.ref}" not found`,
              suggestion: "Use kspec inbox list to find valid inbox item references",
            });
          }

          // AC: @api-contract ac-14 - Delete item
          await deleteInboxItem(ctx, item._ulid);
          await commitIfShadow(ctx.shadow, `inbox: delete ${params.ref}`);

          // AC: @daemon-entity-cache ac-write-through — update cache before response
          const deleteCache = getEntityCache?.(projectContext.path);
          if (deleteCache) {
            await deleteCache.writeThrough("inbox");
          }

          // Broadcast update
          // AC: @multi-directory-daemon ac-18 - Broadcast scoped to request project
          pubsub.broadcast(
            "inbox:updates",
            "inbox_item_deleted",
            {
              ref: params.ref,
              ulid: item._ulid,
            },
            projectContext.path,
          );

          // AC: @api-contract ac-14 - Return success confirmation
          return {
            success: true,
            deleted: item._ulid,
          };
        },
        {
          params: t.Object({
            ref: t.String(),
          }),
        },
      )
  );
}
