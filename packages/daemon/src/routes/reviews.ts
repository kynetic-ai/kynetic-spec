/**
 * Review API Routes
 *
 * REST endpoints for review record operations:
 * - GET /api/reviews - list reviews with filters and pagination
 * - GET /api/reviews/:id - get single review with full detail
 * - POST /api/reviews/:id/comments - create thread
 * - POST /api/reviews/:id/comments/:threadId/replies - add reply
 * - PATCH /api/reviews/:id/comments/:threadId/resolve - resolve thread
 * - PATCH /api/reviews/:id/comments/:threadId/reopen - reopen thread
 *
 * AC Coverage:
 * - @review-records-daemon-api ac-1: GET /api/reviews returns paginated list with filtering
 * - @review-records-daemon-api ac-2: GET /api/reviews/:id returns full review detail
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
import type { ReviewAnchor, ReviewRecord } from '../../schema/index.js';
import { resolveRefTitle } from './ref-resolution.js';

interface ReviewsRouteOptions {
  pubsub: PubSubManager;
}

/**
 * Build a ReviewSummary from a full ReviewRecord.
 * Extracts subject type, linked task ref, and computed counts.
 */
function toReviewSummary(review: ReviewRecord, index?: ReferenceIndex) {
  const disposition = computeDisposition(review);
  const unresolvedBlockers = getUnresolvedBlockers(review);

  // Determine linked task ref
  let taskRef: string | undefined;
  if (review.subject.type === 'task') {
    taskRef = review.subject.ref;
  } else if (review.related_refs.length > 0) {
    taskRef = review.related_refs[0];
  }

  // Resolve task title via ReferenceIndex (consistent with tasks.ts pattern)
  const taskTitle = taskRef ? resolveRefTitle(index!, taskRef) : null;

  return {
    _ulid: review._ulid,
    slugs: review.slugs,
    title: review.title,
    lifecycle_state: review.lifecycle_state,
    disposition,
    subject_type: review.subject.type,
    subject_ref: 'ref' in review.subject ? review.subject.ref : undefined,
    author: review.author,
    related_refs: review.related_refs,
    task_ref: taskRef,
    task_title: taskTitle,
    thread_count: review.threads.length,
    unresolved_blocker_count: unresolvedBlockers.length,
    check_count: review.checks.length,
    verdict_count: review.verdicts.length,
    created_at: review.created_at,
    updated_at: review.updated_at,
  };
}

export function createReviewsRoutes(options: ReviewsRouteOptions) {
  const { pubsub } = options;

  return new Elysia({ prefix: '/api/reviews' })

    // AC: @review-records-daemon-api ac-1 - List reviews with filters and pagination
    .get(
      '/',
      async ({ query, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const reviews = await loadReviewRecords(ctx);
        const tasks = await loadAllTasks(ctx);
        const specItems = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks, specItems);

        // Apply filters
        let filtered = reviews;

        // Status filter (lifecycle_state) — default to 'open' if not specified
        const statusFilters = query.status
          ? (Array.isArray(query.status) ? query.status : [query.status])
          : ['open'];
        if (statusFilters.length > 0 && statusFilters[0] !== 'all') {
          filtered = filtered.filter((r) => statusFilters.includes(r.lifecycle_state));
        }

        // Disposition filter (computed)
        if (query.disposition) {
          const dispFilters = Array.isArray(query.disposition) ? query.disposition : [query.disposition];
          filtered = filtered.filter((r) => dispFilters.includes(computeDisposition(r)));
        }

        // Subject type filter
        if (query.subject_type) {
          const subjectFilters = Array.isArray(query.subject_type) ? query.subject_type : [query.subject_type];
          filtered = filtered.filter((r) => subjectFilters.includes(r.subject.type));
        }

        // Reviewer filter
        if (query.reviewer) {
          filtered = filtered.filter((r) => r.author === query.reviewer);
        }

        // Task filter (matches subject ref for task reviews, or related_refs)
        if (query.task) {
          const taskFilter = query.task;
          filtered = filtered.filter((r) => {
            if (r.subject.type === 'task' && 'ref' in r.subject) {
              const ref = r.subject.ref;
              if (ref === taskFilter || ref === `@${taskFilter}` || `@${ref}` === taskFilter) {
                return true;
              }
            }
            return r.related_refs.some((rr) =>
              rr === taskFilter || rr === `@${taskFilter}` || `@${rr}` === taskFilter
            );
          });
        }

        // Sort
        const sortField = query.sort || 'created_at';
        const sortDir = query.sort_dir === 'asc' ? 1 : -1;
        filtered.sort((a, b) => {
          let aVal: string | number;
          let bVal: string | number;
          switch (sortField) {
            case 'title':
              aVal = a.title.toLowerCase();
              bVal = b.title.toLowerCase();
              break;
            case 'lifecycle_state':
              aVal = a.lifecycle_state;
              bVal = b.lifecycle_state;
              break;
            case 'updated_at':
              aVal = a.updated_at || a.created_at;
              bVal = b.updated_at || b.created_at;
              break;
            case 'created_at':
            default:
              aVal = a.created_at;
              bVal = b.created_at;
              break;
          }
          if (aVal < bVal) return -sortDir;
          if (aVal > bVal) return sortDir;
          return 0;
        });

        // Pagination
        const total = filtered.length;
        const offset = Number(query.offset) || 0;
        const limit = Number(query.limit) || total;
        const paginated = filtered.slice(offset, offset + limit);

        const items = paginated.map((r) => toReviewSummary(r, index));

        return { items, total, offset, limit };
      },
      {
        query: t.Object({
          status: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          disposition: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          subject_type: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          reviewer: t.Optional(t.String()),
          task: t.Optional(t.String()),
          sort: t.Optional(t.String()),
          sort_dir: t.Optional(t.String()),
          limit: t.Optional(t.String()),
          offset: t.Optional(t.String()),
        }),
      }
    )

    // AC: @review-records-daemon-api ac-2 - Get single review by ref
    .get(
      '/:id',
      async ({ params, error: errorResponse, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const reviews = await loadReviewRecords(ctx);
        const review = findReviewByRef(reviews, params.id);

        if (!review) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Review "${params.id}" not found`,
            suggestion: 'Use GET /api/reviews to list available reviews',
          });
        }

        return {
          ...review,
          disposition: computeDisposition(review),
        };
      },
      {
        params: t.Object({
          id: t.String(),
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
