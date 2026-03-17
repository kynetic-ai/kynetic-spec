/**
 * Review API Routes — List and Thread Mutations
 *
 * REST endpoints for review operations:
 * - GET /api/reviews - list with filters (task, status) and pagination
 * - POST /api/reviews/:id/comments - create thread
 * - POST /api/reviews/:id/comments/:threadId/replies - add reply
 * - PATCH /api/reviews/:id/comments/:threadId/resolve - resolve thread
 * - PATCH /api/reviews/:id/comments/:threadId/reopen - reopen thread
 *
 * AC Coverage:
 * - @review-records-daemon-api ac-1: GET /api/reviews returns paginated list with filters
 * - @review-records-web-ui ac-7: GET /api/reviews?task= for task detail integration
 * - @review-records-daemon-api ac-3: POST /api/reviews/:id/comments creates thread
 * - @review-records-daemon-api ac-4: POST /api/reviews/:id/comments/:threadId/replies adds reply
 * - @review-records-daemon-api ac-5: PATCH resolve/reopen toggles resolution state
 * - @review-records-daemon-api ac-9: WebSocket broadcast on mutations
 * - @review-records-daemon-api ac-10: 400 with actionable error messages for invalid input
 */

import { Elysia, t } from 'elysia';
import {
  initContext,
  loadReviewRecords,
  loadAllTasks,
  loadAllItems,
  ReferenceIndex,
  findReviewByRef,
  computeDisposition,
  addThreadAtomic,
  addReplyAtomic,
  resolveThreadAtomic,
  reopenThreadAtomic,
} from '../../parser/index.js';
import { getUnresolvedBlockers } from '../../parser/review-threads.js';
import { commitIfShadow } from '../../parser/shadow.js';
import type { PubSubManager } from '../websocket/pubsub';
import type { ReviewAnchor } from '../../schema/index.js';

interface ReviewsRouteOptions {
  pubsub: PubSubManager;
}

export function createReviewsRoutes(options: ReviewsRouteOptions) {
  const { pubsub } = options;

  return new Elysia({ prefix: '/api/reviews' })

    // AC: @review-records-daemon-api ac-1 - List reviews with filters
    // AC: @review-records-web-ui ac-7 - Task filter for task detail page integration
    .get(
      '/',
      async ({ query, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const reviews = await loadReviewRecords(ctx);

        let filtered = reviews;

        // Filter by task: match reviews where subject.type === 'task' and subject.ref matches,
        // or the task ref appears in related_refs
        if (query.task) {
          const taskRef = query.task.startsWith('@') ? query.task.slice(1) : query.task;
          // Also resolve ULID/slug for the task
          const tasks = await loadAllTasks(ctx);
          const items = await loadAllItems(ctx);
          const index = new ReferenceIndex(tasks, items);
          const resolved = index.resolve(taskRef);
          const taskUlid = resolved.ok ? resolved.ulid : null;
          const taskSlugs = taskUlid
            ? tasks.find((t) => t._ulid === taskUlid)?.slugs ?? []
            : [];

          filtered = filtered.filter((review) => {
            // Check subject
            if (review.subject.type === 'task') {
              const subjectRef = (review.subject as { ref?: string }).ref;
              if (subjectRef) {
                const normSubject = subjectRef.startsWith('@') ? subjectRef.slice(1) : subjectRef;
                if (normSubject === taskUlid || taskSlugs.includes(normSubject) || normSubject === taskRef) {
                  return true;
                }
              }
            }
            // Check related_refs
            return review.related_refs.some((r) => {
              const normR = r.startsWith('@') ? r.slice(1) : r;
              return normR === taskUlid || taskSlugs.includes(normR) || normR === taskRef;
            });
          });
        }

        // Filter by status (lifecycle_state)
        if (query.status) {
          const statusFilters = Array.isArray(query.status) ? query.status : [query.status];
          filtered = filtered.filter((r) => statusFilters.includes(r.lifecycle_state));
        }

        // Sort by created_at descending (newest first)
        filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        // Pagination
        const total = filtered.length;
        const offset = Number(query.offset) || 0;
        const limit = Number(query.limit) || total;
        const paginated = filtered.slice(offset, offset + limit);

        const items = paginated.map((review) => {
          const disposition = computeDisposition(review);
          const unresolvedBlockers = getUnresolvedBlockers(review);
          return {
            _ulid: review._ulid,
            slugs: review.slugs,
            title: review.title,
            lifecycle_state: review.lifecycle_state,
            disposition,
            subject_type: review.subject.type,
            subject_ref: 'ref' in review.subject ? (review.subject as { ref?: string }).ref : undefined,
            author: review.author,
            thread_count: review.threads.length,
            unresolved_blocker_count: unresolvedBlockers.length,
            created_at: review.created_at,
          };
        });

        return {
          items,
          total,
          offset,
          limit,
        };
      },
      {
        query: t.Object({
          task: t.Optional(t.String()),
          status: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          limit: t.Optional(t.String()),
          offset: t.Optional(t.String()),
        }),
      }
    )

    // AC: @review-records-daemon-api ac-3 - Create thread on review
    .post(
      '/:id/comments',
      async ({ params, body, error: errorResponse, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const reviews = await loadReviewRecords(ctx);
        const review = findReviewByRef(reviews, params.id);

        if (!review) {
          // AC: @review-records-daemon-api ac-10 - actionable error
          return errorResponse(404, {
            error: 'not_found',
            message: `Review "${params.id}" not found`,
            suggestion: 'Use kspec review list to find valid review references',
          });
        }

        // AC: @review-records-daemon-api ac-10 - validate required fields
        if (!body.body || typeof body.body !== 'string' || body.body.trim().length === 0) {
          return errorResponse(400, {
            error: 'validation_error',
            message: 'Invalid input: body is required',
            details: [
              {
                field: 'body',
                message: 'Body is required and must be a non-empty string',
              },
            ],
          });
        }

        // Validate kind if provided
        const validKinds = ['blocker', 'question', 'nit'];
        if (body.kind && !validKinds.includes(body.kind)) {
          return errorResponse(400, {
            error: 'validation_error',
            message: `Invalid thread kind "${body.kind}"`,
            details: [
              {
                field: 'kind',
                message: `Kind must be one of: ${validKinds.join(', ')}`,
              },
            ],
          });
        }

        // Build anchor if provided
        let anchor: ReviewAnchor | undefined;
        if (body.anchor) {
          if (body.anchor.type === 'code') {
            if (!body.anchor.path || !body.anchor.side || body.anchor.line_start == null || body.anchor.line_end == null || !body.anchor.commit) {
              return errorResponse(400, {
                error: 'validation_error',
                message: 'Invalid code anchor: missing required fields',
                details: [
                  {
                    field: 'anchor',
                    message: 'Code anchor requires path, side (base|head), line_start, line_end, and commit',
                  },
                ],
              });
            }
            // Validate side field
            const validSides = ['base', 'head'];
            if (!validSides.includes(body.anchor.side)) {
              return errorResponse(400, {
                error: 'validation_error',
                message: `Invalid anchor side "${body.anchor.side}"`,
                details: [
                  {
                    field: 'anchor.side',
                    message: 'Side must be "base" or "head"',
                  },
                ],
              });
            }
            // Validate line_start and line_end are positive integers with line_end >= line_start
            if (!Number.isInteger(body.anchor.line_start) || body.anchor.line_start < 1) {
              return errorResponse(400, {
                error: 'validation_error',
                message: 'Invalid anchor line_start: must be a positive integer',
                details: [
                  {
                    field: 'anchor.line_start',
                    message: 'line_start must be an integer greater than 0',
                  },
                ],
              });
            }
            if (!Number.isInteger(body.anchor.line_end) || body.anchor.line_end < 1) {
              return errorResponse(400, {
                error: 'validation_error',
                message: 'Invalid anchor line_end: must be a positive integer',
                details: [
                  {
                    field: 'anchor.line_end',
                    message: 'line_end must be an integer greater than 0',
                  },
                ],
              });
            }
            if (body.anchor.line_end < body.anchor.line_start) {
              return errorResponse(400, {
                error: 'validation_error',
                message: 'Invalid anchor: line_end must be >= line_start',
                details: [
                  {
                    field: 'anchor.line_end',
                    message: `line_end (${body.anchor.line_end}) must be greater than or equal to line_start (${body.anchor.line_start})`,
                  },
                ],
              });
            }
            anchor = {
              type: 'code',
              path: body.anchor.path,
              side: body.anchor.side as 'base' | 'head',
              line_start: body.anchor.line_start,
              line_end: body.anchor.line_end,
              commit: body.anchor.commit,
            };
          } else if (body.anchor.type === 'structured') {
            // Require at least one meaningful field for structured anchors
            if (!body.anchor.section && !body.anchor.field && !body.anchor.path && !body.anchor.ref) {
              return errorResponse(400, {
                error: 'validation_error',
                message: 'Invalid structured anchor: at least one of section, field, path, or ref is required',
                details: [
                  {
                    field: 'anchor',
                    message: 'Structured anchor must have at least one of: section, field, path, ref',
                  },
                ],
              });
            }
            anchor = {
              type: 'structured',
              ...(body.anchor.section ? { section: body.anchor.section } : {}),
              ...(body.anchor.field ? { field: body.anchor.field } : {}),
              ...(body.anchor.path ? { path: body.anchor.path } : {}),
              ...(body.anchor.ref ? { ref: body.anchor.ref } : {}),
            };
          } else {
            return errorResponse(400, {
              error: 'validation_error',
              message: `Invalid anchor type "${body.anchor.type}"`,
              details: [
                {
                  field: 'anchor.type',
                  message: 'Anchor type must be "code" or "structured"',
                },
              ],
            });
          }
        }

        const { review: updatedReview, thread } = await addThreadAtomic(ctx, review, {
          author: body.author || 'anonymous',
          body: body.body,
          kind: (body.kind as 'blocker' | 'question' | 'nit') || undefined,
          anchor,
        });

        await commitIfShadow(ctx.shadow, `review: add thread to ${params.id}`);

        // AC: @review-records-daemon-api ac-9 - WebSocket broadcast
        pubsub.broadcast('reviews:updates', 'thread_created', {
          review_ulid: updatedReview._ulid,
          thread_ulid: thread._ulid,
          kind: thread.kind,
          author: body.author || 'anonymous',
        }, projectContext.path);

        return thread;
      },
      {
        params: t.Object({
          id: t.String(),
        }),
        body: t.Object({
          body: t.String(),
          kind: t.Optional(t.String()),
          author: t.Optional(t.String()),
          anchor: t.Optional(t.Object({
            type: t.String(),
            path: t.Optional(t.String()),
            side: t.Optional(t.String()),
            line_start: t.Optional(t.Number()),
            line_end: t.Optional(t.Number()),
            commit: t.Optional(t.String()),
            section: t.Optional(t.String()),
            field: t.Optional(t.String()),
            ref: t.Optional(t.String()),
          })),
        }),
      }
    )

    // AC: @review-records-daemon-api ac-4 - Add reply to thread
    .post(
      '/:id/comments/:threadId/replies',
      async ({ params, body, error: errorResponse, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const reviews = await loadReviewRecords(ctx);
        const review = findReviewByRef(reviews, params.id);

        if (!review) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Review "${params.id}" not found`,
            suggestion: 'Use kspec review list to find valid review references',
          });
        }

        // Check thread exists
        const thread = review.threads.find((t) => t._ulid === params.threadId);
        if (!thread) {
          // AC: @review-records-daemon-api ac-10 - actionable error for invalid thread
          return errorResponse(404, {
            error: 'not_found',
            message: `Thread "${params.threadId}" not found on review "${params.id}"`,
            suggestion: 'Use GET /api/reviews/:id to see available threads',
          });
        }

        // AC: @review-records-daemon-api ac-10 - validate required fields
        if (!body.body || typeof body.body !== 'string' || body.body.trim().length === 0) {
          return errorResponse(400, {
            error: 'validation_error',
            message: 'Invalid input: body is required',
            details: [
              {
                field: 'body',
                message: 'Body is required and must be a non-empty string',
              },
            ],
          });
        }

        try {
          const { review: updatedReview, entry } = await addReplyAtomic(ctx, review, {
            threadUlid: params.threadId,
            author: body.author || 'anonymous',
            body: body.body,
          });

          await commitIfShadow(ctx.shadow, `review: reply to thread ${params.threadId} on ${params.id}`);

          // AC: @review-records-daemon-api ac-9 - WebSocket broadcast
          pubsub.broadcast('reviews:updates', 'thread_replied', {
            review_ulid: updatedReview._ulid,
            thread_ulid: params.threadId,
            entry_ulid: entry._ulid,
            author: body.author || 'anonymous',
          }, projectContext.path);

          // Return the updated thread
          const updatedThread = updatedReview.threads.find((t) => t._ulid === params.threadId);
          return updatedThread;
        } catch (err) {
          return errorResponse(400, {
            error: 'operation_failed',
            message: err instanceof Error ? err.message : 'Failed to add reply',
          });
        }
      },
      {
        params: t.Object({
          id: t.String(),
          threadId: t.String(),
        }),
        body: t.Object({
          body: t.String(),
          author: t.Optional(t.String()),
        }),
      }
    )

    // AC: @review-records-daemon-api ac-5 - Resolve thread
    .patch(
      '/:id/comments/:threadId/resolve',
      async ({ params, body, error: errorResponse, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const reviews = await loadReviewRecords(ctx);
        const review = findReviewByRef(reviews, params.id);

        if (!review) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Review "${params.id}" not found`,
            suggestion: 'Use kspec review list to find valid review references',
          });
        }

        // Check thread exists
        const thread = review.threads.find((t) => t._ulid === params.threadId);
        if (!thread) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Thread "${params.threadId}" not found on review "${params.id}"`,
            suggestion: 'Use GET /api/reviews/:id to see available threads',
          });
        }

        // Already resolved
        if (thread.resolved_at) {
          return errorResponse(409, {
            error: 'invalid_transition',
            message: `Thread "${params.threadId}" is already resolved`,
            current: 'resolved',
            valid_transitions: ['reopen'],
          });
        }

        try {
          const updatedReview = await resolveThreadAtomic(ctx, review, {
            threadUlid: params.threadId,
            actor: body?.actor || 'anonymous',
          });

          await commitIfShadow(ctx.shadow, `review: resolve thread ${params.threadId} on ${params.id}`);

          // AC: @review-records-daemon-api ac-9 - WebSocket broadcast
          pubsub.broadcast('reviews:updates', 'thread_resolved', {
            review_ulid: updatedReview._ulid,
            thread_ulid: params.threadId,
            actor: body?.actor || 'anonymous',
          }, projectContext.path);

          const updatedThread = updatedReview.threads.find((t) => t._ulid === params.threadId);
          return updatedThread;
        } catch (err) {
          return errorResponse(400, {
            error: 'operation_failed',
            message: err instanceof Error ? err.message : 'Failed to resolve thread',
          });
        }
      },
      {
        params: t.Object({
          id: t.String(),
          threadId: t.String(),
        }),
        body: t.Optional(t.Object({
          actor: t.Optional(t.String()),
        })),
      }
    )

    // AC: @review-records-daemon-api ac-5 - Reopen thread
    .patch(
      '/:id/comments/:threadId/reopen',
      async ({ params, body, error: errorResponse, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const reviews = await loadReviewRecords(ctx);
        const review = findReviewByRef(reviews, params.id);

        if (!review) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Review "${params.id}" not found`,
            suggestion: 'Use kspec review list to find valid review references',
          });
        }

        // Check thread exists
        const thread = review.threads.find((t) => t._ulid === params.threadId);
        if (!thread) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Thread "${params.threadId}" not found on review "${params.id}"`,
            suggestion: 'Use GET /api/reviews/:id to see available threads',
          });
        }

        // Not resolved
        if (!thread.resolved_at) {
          return errorResponse(409, {
            error: 'invalid_transition',
            message: `Thread "${params.threadId}" is not resolved`,
            current: 'open',
            valid_transitions: ['resolve'],
          });
        }

        try {
          const updatedReview = await reopenThreadAtomic(ctx, review, {
            threadUlid: params.threadId,
            actor: body?.actor || 'anonymous',
          });

          await commitIfShadow(ctx.shadow, `review: reopen thread ${params.threadId} on ${params.id}`);

          // AC: @review-records-daemon-api ac-9 - WebSocket broadcast
          pubsub.broadcast('reviews:updates', 'thread_reopened', {
            review_ulid: updatedReview._ulid,
            thread_ulid: params.threadId,
            actor: body?.actor || 'anonymous',
          }, projectContext.path);

          const updatedThread = updatedReview.threads.find((t) => t._ulid === params.threadId);
          return updatedThread;
        } catch (err) {
          return errorResponse(400, {
            error: 'operation_failed',
            message: err instanceof Error ? err.message : 'Failed to reopen thread',
          });
        }
      },
      {
        params: t.Object({
          id: t.String(),
          threadId: t.String(),
        }),
        body: t.Optional(t.Object({
          actor: t.Optional(t.String()),
        })),
      }
    );
}
