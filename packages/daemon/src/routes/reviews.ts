/**
 * Review API Routes — List, Detail, Thread, Verdict, Check, and Lifecycle
 *
 * REST endpoints for review record operations:
 * - GET /api/reviews - list reviews with filters and pagination
 * - GET /api/reviews/:id - get single review with full detail
 * - POST /api/reviews/:id/comments - create thread
 * - POST /api/reviews/:id/comments/:threadId/replies - add reply
 * - PATCH /api/reviews/:id/comments/:threadId/resolve - resolve thread
 * - PATCH /api/reviews/:id/comments/:threadId/reopen - reopen thread
 * - POST /api/reviews/:id/verdicts - record verdict
 * - POST /api/reviews/:id/checks - record check
 * - PATCH /api/reviews/:id/lifecycle - transition lifecycle state
 *
 * AC Coverage:
 * - @review-records-daemon-api ac-1: GET /api/reviews returns paginated list with filtering
 * - @review-records-daemon-api ac-2: GET /api/reviews/:id returns full review detail
 * - @review-records-web-ui ac-7: GET /api/reviews?task= for task detail integration
 * - @review-records-daemon-api ac-3: POST /api/reviews/:id/comments creates thread
 * - @review-records-daemon-api ac-4: POST /api/reviews/:id/comments/:threadId/replies adds reply
 * - @review-records-daemon-api ac-5: PATCH resolve/reopen toggles resolution state
 * - @review-records-daemon-api ac-6: POST /api/reviews/:id/verdicts records verdict, recomputes disposition
 * - @review-records-daemon-api ac-7: POST /api/reviews/:id/checks records check, updates gate evaluation
 * - @review-records-daemon-api ac-8: PATCH /api/reviews/:id/lifecycle transitions lifecycle state
 * - @review-records-daemon-api ac-9: WebSocket broadcast on mutations
 * - @review-records-daemon-api ac-10: 400 with actionable error messages for invalid input
 */

import { Elysia, t } from 'elysia';
import { ulid } from 'ulidx';
import {
  initContext,
  loadReviewRecords,
  loadAllTasks,
  loadAllItems,
  ReferenceIndex,
  findReviewByRef,
  mutateReviewAtomically,
  submitVerdict,
  transitionLifecycle,
  computeDisposition,
  handleVerdictTaskTransition,
  VALID_TRANSITIONS,
  addThreadAtomic,
  addReplyAtomic,
  resolveThreadAtomic,
  reopenThreadAtomic,
} from '../../parser/index.js';
import { getUnresolvedBlockers } from '../../parser/review-threads.js';
import { createCheck } from '../../review/checks.js';
import { evaluateGates } from '../../review/checks.js';
import { extractSubjectVersion } from '../../review/subject-bindings.js';
import { commitIfShadow } from '../../parser/shadow.js';
import type { PubSubManager } from '../websocket/pubsub';
import type {
  ReviewVerdictDecision,
  ReviewLifecycleState,
  ReviewCheckStatus,
  ReviewEvent,
  ReviewAnchor,
  ReviewRecord,
} from '../../schema/index.js';
import {
  ReviewAnchorTypeSchema,
  ReviewCheckStatusSchema,
  ReviewCodeAnchorSideSchema,
  ReviewDispositionSchema,
  ReviewLifecycleStateSchema,
  ReviewSubjectSchema,
  ReviewThreadKindSchema,
  ReviewVerdictDecisionSchema,
} from '../../schema/index.js';
import { resolveRefTitle } from './ref-resolution.js';
import { enumArrayUnion, enumUnion } from './enum-utils.js';

interface ReviewsRouteOptions {
  pubsub: PubSubManager;
}

const VALID_DECISIONS: readonly ReviewVerdictDecision[] = ReviewVerdictDecisionSchema.options;
const VALID_CHECK_STATUSES: readonly ReviewCheckStatus[] = ReviewCheckStatusSchema.options;
const VALID_THREAD_KINDS = ReviewThreadKindSchema.options;
const VALID_ANCHOR_TYPES = ReviewAnchorTypeSchema.options;
const VALID_CODE_ANCHOR_SIDES = ReviewCodeAnchorSideSchema.options;
const VALID_REVIEW_SUBJECT_TYPES = ReviewSubjectSchema.options.map((option) => option.shape.type.value);
const VALID_LIFECYCLE_TARGETS: readonly ReviewLifecycleState[] = [
  ...ReviewLifecycleStateSchema.options.filter((state) => state !== 'draft'),
];

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
    head_branch: review.subject.type === 'code' ? review.subject.head_branch : undefined,
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
    // AC: @review-records-web-ui ac-7 - Task filter for task detail page integration
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

        if (query.subject_ref) {
          filtered = filtered.filter(
            (r) => 'ref' in r.subject && r.subject.ref === query.subject_ref
          );
        }

        if (query.head_branch) {
          filtered = filtered.filter(
            (r) => r.subject.type === 'code' && r.subject.head_branch === query.head_branch
          );
        }

        // Reviewer filter
        if (query.reviewer) {
          filtered = filtered.filter((r) => r.author === query.reviewer);
        }

        // AC: @review-records-web-ui ac-7 — Task filter for task detail page integration
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
          status: t.Optional(enumArrayUnion(ReviewLifecycleStateSchema.options)),
          disposition: t.Optional(enumArrayUnion(ReviewDispositionSchema.options)),
          subject_type: t.Optional(enumArrayUnion(VALID_REVIEW_SUBJECT_TYPES)),
          subject_ref: t.Optional(t.String()),
          head_branch: t.Optional(t.String()),
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
        if (body.kind && !VALID_THREAD_KINDS.includes(body.kind)) {
          return errorResponse(400, {
            error: 'validation_error',
            message: `Invalid thread kind "${body.kind}"`,
            details: [
              {
                field: 'kind',
                message: `Kind must be one of: ${VALID_THREAD_KINDS.join(', ')}`,
              },
            ],
          });
        }

        // Build anchor if provided
        let anchor: ReviewAnchor | undefined;
        if (body.anchor) {
          if (!body.anchor.type || typeof body.anchor.type !== 'string') {
            return errorResponse(400, {
              error: 'validation_error',
              message: 'Invalid anchor type',
              details: [
                {
                  field: 'anchor.type',
                  message: `Anchor type must be one of: ${VALID_ANCHOR_TYPES.join(', ')}`,
                },
              ],
            });
          }

          if (!VALID_ANCHOR_TYPES.includes(body.anchor.type)) {
            return errorResponse(400, {
              error: 'validation_error',
              message: `Invalid anchor type "${body.anchor.type}"`,
              details: [
                {
                  field: 'anchor.type',
                  message: `Anchor type must be one of: ${VALID_ANCHOR_TYPES.join(', ')}`,
                },
              ],
            });
          }

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
            if (!VALID_CODE_ANCHOR_SIDES.includes(body.anchor.side)) {
              return errorResponse(400, {
                error: 'validation_error',
                message: `Invalid anchor side "${body.anchor.side}"`,
                details: [
                  {
                    field: 'anchor.side',
                    message: `Side must be one of: ${VALID_CODE_ANCHOR_SIDES.join(', ')}`,
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
          kind: t.Optional(enumUnion(ReviewThreadKindSchema.options)),
          author: t.Optional(t.String()),
          anchor: t.Optional(t.Object({
            type: t.Optional(enumUnion(ReviewAnchorTypeSchema.options)),
            path: t.Optional(t.String()),
            side: t.Optional(enumUnion(ReviewCodeAnchorSideSchema.options)),
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
    )

    // AC: @review-records-daemon-api ac-6 - Record verdict on review
    .post(
      '/:id/verdicts',
      async ({ params, body, set, projectContext }) => {
        // AC: @review-records-daemon-api ac-10 - validate required fields
        if (!body.decision || typeof body.decision !== 'string') {
          set.status = 400;
          return {
            error: 'validation_error',
            message: 'Invalid input: decision is required',
            details: [
              {
                field: 'decision',
                message: `Decision is required and must be one of: ${VALID_DECISIONS.join(', ')}`,
              },
            ],
          };
        }

        if (!VALID_DECISIONS.includes(body.decision as ReviewVerdictDecision)) {
          set.status = 400;
          return {
            error: 'validation_error',
            message: `Invalid verdict decision "${body.decision}"`,
            details: [
              {
                field: 'decision',
                message: `Decision must be one of: ${VALID_DECISIONS.join(', ')}`,
              },
            ],
          };
        }

        if (!body.reviewer || typeof body.reviewer !== 'string' || body.reviewer.trim().length === 0) {
          set.status = 400;
          return {
            error: 'validation_error',
            message: 'Invalid input: reviewer is required',
            details: [
              {
                field: 'reviewer',
                message: 'Reviewer is required and must be a non-empty string',
              },
            ],
          };
        }

        const ctx = await initContext(projectContext.path);
        const reviews = await loadReviewRecords(ctx);
        const review = findReviewByRef(reviews, params.id);

        if (!review) {
          set.status = 404;
          return {
            error: 'not_found',
            message: `Review "${params.id}" not found`,
            suggestion: 'Use kspec review list to find valid review references',
          };
        }

        // Guard: reject mutations on archived (terminal-state) reviews
        if (review.lifecycle_state === 'archived') {
          set.status = 400;
          return {
            error: 'invalid_state',
            message: 'Cannot add verdicts to an archived review',
            current_state: 'archived',
            suggestion: '"archived" is a terminal state — archived reviews are immutable',
          };
        }

        const decision = body.decision as ReviewVerdictDecision;
        const reviewer = body.reviewer;

        // AC: @review-record-per-cycle-lifecycle ac-1 — auto-close on approve/request_changes
        const shouldAutoClose = decision === 'approve' || decision === 'request_changes';

        const updated = await mutateReviewAtomically(ctx, review, (latest) => {
          const withVerdict = submitVerdict(latest, {
            reviewer,
            decision,
            role: body.role || undefined,
          });

          // Auto-close if approve or request_changes
          if (shouldAutoClose && withVerdict.lifecycle_state !== 'closed') {
            return transitionLifecycle(withVerdict, 'closed', reviewer);
          }

          return withVerdict;
        });

        await commitIfShadow(
          ctx.shadow,
          'review-verdict',
          review.slugs[0] || review._ulid.slice(0, 8),
          `${decision}${shouldAutoClose ? ' (auto-closed)' : ''}`,
        );

        // AC: @review-task-lifecycle-integration ac-4
        // Auto-transition tasks to needs_work on changes_requested verdict
        if (decision === 'request_changes') {
          const allTasks = await loadAllTasks(ctx);
          const transitioned = await handleVerdictTaskTransition(
            ctx,
            updated,
            decision,
            allTasks,
            reviewer,
          );
          if (transitioned.some((tr) => tr.transitioned)) {
            await commitIfShadow(
              ctx.shadow,
              'review-verdict-task-transition',
              review.slugs[0] || review._ulid.slice(0, 8),
              'tasks transitioned to needs_work',
            );
          }
        }

        // AC: @review-records-daemon-api ac-9 - WebSocket broadcast
        pubsub.broadcast('reviews:updates', 'verdict_submitted', {
          review_ulid: updated._ulid,
          decision,
          reviewer,
          lifecycle_state: updated.lifecycle_state,
          disposition: computeDisposition(updated),
        }, projectContext.path);

        // Return verdict with recomputed disposition
        return {
          review_ulid: updated._ulid,
          decision,
          reviewer,
          lifecycle_state: updated.lifecycle_state,
          disposition: computeDisposition(updated),
        };
      },
      {
        params: t.Object({
          id: t.String(),
        }),
        body: t.Object({
          decision: t.Optional(enumUnion(ReviewVerdictDecisionSchema.options)),
          reviewer: t.Optional(t.String()),
          role: t.Optional(t.String()),
        }),
      }
    )

    // AC: @review-records-daemon-api ac-7 - Record check on review
    .post(
      '/:id/checks',
      async ({ params, body, set, projectContext }) => {
        // AC: @review-records-daemon-api ac-10 - validate required fields
        if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
          set.status = 400;
          return {
            error: 'validation_error',
            message: 'Invalid input: name is required',
            details: [
              {
                field: 'name',
                message: 'Name is required and must be a non-empty string',
              },
            ],
          };
        }

        if (!body.status || typeof body.status !== 'string') {
          set.status = 400;
          return {
            error: 'validation_error',
            message: 'Invalid input: status is required',
            details: [
              {
                field: 'status',
                message: `Status is required and must be one of: ${VALID_CHECK_STATUSES.join(', ')}`,
              },
            ],
          };
        }

        if (!VALID_CHECK_STATUSES.includes(body.status as ReviewCheckStatus)) {
          set.status = 400;
          return {
            error: 'validation_error',
            message: `Invalid check status "${body.status}"`,
            details: [
              {
                field: 'status',
                message: `Status must be one of: ${VALID_CHECK_STATUSES.join(', ')}`,
              },
            ],
          };
        }

        const ctx = await initContext(projectContext.path);
        const reviews = await loadReviewRecords(ctx);
        const review = findReviewByRef(reviews, params.id);

        if (!review) {
          set.status = 404;
          return {
            error: 'not_found',
            message: `Review "${params.id}" not found`,
            suggestion: 'Use kspec review list to find valid review references',
          };
        }

        // Guard: reject mutations on archived (terminal-state) reviews
        if (review.lifecycle_state === 'archived') {
          set.status = 400;
          return {
            error: 'invalid_state',
            message: 'Cannot add checks to an archived review',
            current_state: 'archived',
            suggestion: '"archived" is a terminal state — archived reviews are immutable',
          };
        }

        // Derive applies_to_version from the current review subject
        const appliesTo = extractSubjectVersion(review.subject);

        const check = createCheck({
          name: body.name,
          status: body.status as ReviewCheckStatus,
          applies_to_version: appliesTo,
          required: body.required !== false, // defaults to true
          runner: body.runner || undefined,
          evidence: body.evidence || undefined,
        });

        const now = new Date().toISOString();
        const checkEvent: ReviewEvent = {
          _ulid: ulid(),
          event_type: 'check_added',
          actor: body.runner || 'anonymous',
          timestamp: now,
          payload: {
            name: body.name,
            status: body.status,
          },
        };

        const updated = await mutateReviewAtomically(ctx, review, (latest) => ({
          ...latest,
          checks: [...latest.checks, check],
          events: [...latest.events, checkEvent],
          updated_at: now,
        }));

        await commitIfShadow(
          ctx.shadow,
          'review-check',
          review.slugs[0] || review._ulid.slice(0, 8),
          `${body.name}: ${body.status}`,
        );

        // Compute gate evaluation for the response
        const currentVersion = extractSubjectVersion(updated.subject);
        const gateResult = evaluateGates(updated.checks, currentVersion);

        // AC: @review-records-daemon-api ac-9 - WebSocket broadcast
        pubsub.broadcast('reviews:updates', 'check_added', {
          review_ulid: updated._ulid,
          check_name: body.name,
          check_status: body.status,
          gate_state: gateResult.state,
        }, projectContext.path);

        return {
          review_ulid: updated._ulid,
          check,
          gate_state: gateResult.state,
          gate_summary: gateResult.summary,
        };
      },
      {
        params: t.Object({
          id: t.String(),
        }),
        body: t.Object({
          name: t.Optional(t.String()),
          status: t.Optional(enumUnion(ReviewCheckStatusSchema.options)),
          runner: t.Optional(t.String()),
          evidence: t.Optional(t.String()),
          required: t.Optional(t.Boolean()),
        }),
      }
    )

    // AC: @review-records-daemon-api ac-8 - Lifecycle transition
    .patch(
      '/:id/lifecycle',
      async ({ params, body, set, projectContext }) => {
        // Manual validation before initContext to return proper 400s
        const target = body?.target;
        if (!target || typeof target !== 'string') {
          set.status = 400;
          return {
            error: 'validation_error',
            message: 'Invalid input: target state is required',
            details: [
              {
                field: 'target',
                message: `Target is required and must be one of: ${VALID_LIFECYCLE_TARGETS.join(', ')}`,
              },
            ],
          };
        }

        if (!VALID_LIFECYCLE_TARGETS.includes(target as ReviewLifecycleState)) {
          set.status = 400;
          return {
            error: 'validation_error',
            message: `Invalid lifecycle target "${target}"`,
            details: [
              {
                field: 'target',
                message: `Target must be one of: ${VALID_LIFECYCLE_TARGETS.join(', ')}`,
              },
            ],
          };
        }

        const ctx = await initContext(projectContext.path);
        const reviews = await loadReviewRecords(ctx);
        const review = findReviewByRef(reviews, params.id);

        if (!review) {
          set.status = 404;
          return {
            error: 'not_found',
            message: `Review "${params.id}" not found`,
            suggestion: 'Use kspec review list to find valid review references',
          };
        }

        const lifecycleTarget = target as ReviewLifecycleState;
        const actor = body?.actor || 'anonymous';
        const allowed = VALID_TRANSITIONS[review.lifecycle_state];

        // AC: @review-records-daemon-api ac-8, ac-10 - invalid transition returns 400
        if (!allowed.includes(lifecycleTarget)) {
          set.status = 400;
          return {
            error: 'invalid_transition',
            message: `Cannot transition from "${review.lifecycle_state}" to "${lifecycleTarget}"`,
            current_state: review.lifecycle_state,
            valid_transitions: allowed,
            suggestion: allowed.length > 0
              ? `Valid transitions from "${review.lifecycle_state}": ${allowed.join(', ')}`
              : `"${review.lifecycle_state}" is a terminal state with no valid transitions`,
          };
        }

        try {
          const updated = await mutateReviewAtomically(ctx, review, (latest) => {
            return transitionLifecycle(latest, lifecycleTarget, actor);
          });

          await commitIfShadow(
            ctx.shadow,
            'review-lifecycle',
            review.slugs[0] || review._ulid.slice(0, 8),
            `${review.lifecycle_state} → ${lifecycleTarget}`,
          );

          // AC: @review-records-daemon-api ac-9 - WebSocket broadcast
          pubsub.broadcast('reviews:updates', 'lifecycle_changed', {
            review_ulid: updated._ulid,
            from: review.lifecycle_state,
            to: lifecycleTarget,
            actor,
          }, projectContext.path);

          return {
            review_ulid: updated._ulid,
            lifecycle_state: updated.lifecycle_state,
            previous_state: review.lifecycle_state,
          };
        } catch (err) {
          set.status = 400;
          return {
            error: 'invalid_transition',
            message: err instanceof Error ? err.message : 'Failed to transition lifecycle',
          };
        }
      },
      {
        params: t.Object({
          id: t.String(),
        }),
        body: t.Optional(t.Object({
          target: t.Optional(enumUnion(VALID_LIFECYCLE_TARGETS)),
          actor: t.Optional(t.String()),
        })),
      }
    );
}
