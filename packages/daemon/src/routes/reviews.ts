/**
 * Reviews API Routes
 *
 * REST endpoints for review record operations:
 * - GET /api/reviews - list reviews with filters, pagination, and sorting
 * - GET /api/reviews/:ref - get single review with full detail
 *
 * AC Coverage:
 * - @review-records-daemon-api ac-1: GET /api/reviews with pagination and filtering
 * - @review-records-daemon-api ac-2: GET /api/reviews/:ref with full detail
 */

import { Elysia, t } from 'elysia';
import {
  initContext,
  loadReviewRecords,
  findReviewByRef,
  loadAllTasks,
  loadAllItems,
  loadPlans,
  ReferenceIndex,
  computeDisposition,
  getUnresolvedBlockers,
  type LoadedReviewRecord,
} from '../../parser/index.js';
import { extractSubjectVersion } from '../../review/subject-bindings.js';
import { evaluateGates } from '../../review/checks.js';
import type { ReviewSummary, ReviewDetail } from '@kynetic-ai/shared';
import { resolveRefTitle, resolveRefEntries } from './ref-resolution.js';

interface ReviewsRouteOptions {}

/**
 * Extract the subject type string from a review subject.
 */
function getSubjectType(subject: { type: string }): string {
  return subject.type;
}

/**
 * Extract a ref from the subject if it has one (task, plan, spec subjects).
 */
function getSubjectRef(subject: { type: string; ref?: string }): string | undefined {
  if ('ref' in subject && typeof subject.ref === 'string') {
    return subject.ref;
  }
  return undefined;
}

/**
 * Map a loaded review to a ReviewSummary.
 */
function toReviewSummary(
  review: LoadedReviewRecord,
  index: ReferenceIndex,
): ReviewSummary {
  const disposition = computeDisposition(review);
  const currentVersion = extractSubjectVersion(review.subject);
  const gateResult = evaluateGates(review.checks, currentVersion);
  const unresolvedBlockers = getUnresolvedBlockers(review);
  const subjectRef = getSubjectRef(review.subject);

  return {
    _ulid: review._ulid,
    slugs: review.slugs,
    title: review.title,
    lifecycle_state: review.lifecycle_state,
    disposition,
    gate_state: gateResult.state,
    subject_type: getSubjectType(review.subject),
    subject_ref: subjectRef,
    subject_title: resolveRefTitle(index, subjectRef),
    author: review.author,
    related_refs: review.related_refs,
    resolved_related_refs: resolveRefEntries(index, review.related_refs),
    threads_total: review.threads.length,
    threads_resolved: review.threads.filter((t) => !!t.resolved_at).length,
    threads_unresolved_blockers: unresolvedBlockers.length,
    verdicts_count: review.verdicts.length,
    checks_count: review.checks.length,
    created_at: review.created_at,
    updated_at: review.updated_at,
  };
}

/**
 * Map a loaded review to a ReviewDetail.
 */
function toReviewDetail(
  review: LoadedReviewRecord,
  index: ReferenceIndex,
): ReviewDetail {
  return {
    ...toReviewSummary(review, index),
    subject: review.subject,
    threads: review.threads,
    checks: review.checks,
    verdicts: review.verdicts,
    events: review.events,
    notes: review.notes,
    external_links: review.external_links,
  };
}

/**
 * Check if a review matches a task filter.
 * Matches if the review's subject is a task with the given ref,
 * or if the ref appears in related_refs.
 */
function matchesTaskFilter(review: LoadedReviewRecord, taskRef: string): boolean {
  const cleanRef = taskRef.startsWith('@') ? taskRef.slice(1) : taskRef;

  // Check subject ref (task subjects)
  const subjectRef = getSubjectRef(review.subject);
  if (subjectRef) {
    const cleanSubjectRef = subjectRef.startsWith('@') ? subjectRef.slice(1) : subjectRef;
    if (cleanSubjectRef === cleanRef) return true;
  }

  // Check related_refs
  return review.related_refs.some((ref) => {
    const clean = ref.startsWith('@') ? ref.slice(1) : ref;
    return clean === cleanRef;
  });
}

/**
 * Check if a review matches a branch filter.
 * Only applies to code-type subjects with base_branch or head_branch.
 */
function matchesBranchFilter(review: LoadedReviewRecord, branch: string): boolean {
  if (review.subject.type !== 'code') return false;
  const codeSubject = review.subject as { base_branch?: string; head_branch?: string };
  return codeSubject.base_branch === branch || codeSubject.head_branch === branch;
}

export function createReviewsRoutes(options: ReviewsRouteOptions = {}) {
  return new Elysia({ prefix: '/api/reviews' })
    // AC: @review-records-daemon-api ac-1 - List reviews with filters, pagination, and sorting
    .get(
      '/',
      async ({ query, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const reviews = await loadReviewRecords(ctx);
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const plans = await loadPlans(ctx);
        const index = new ReferenceIndex(tasks, items, [], plans, reviews);

        let filtered: LoadedReviewRecord[] = reviews;

        // AC: @review-records-daemon-api ac-1 - Default to open reviews
        if (query.status) {
          const statusFilters = Array.isArray(query.status) ? query.status : [query.status];
          filtered = filtered.filter((r) => statusFilters.includes(r.lifecycle_state));
        } else {
          // Default: show open reviews only
          filtered = filtered.filter((r) => r.lifecycle_state === 'open');
        }

        // Filter by disposition (computed)
        if (query.disposition) {
          const dispositionFilters = Array.isArray(query.disposition)
            ? query.disposition
            : [query.disposition];
          filtered = filtered.filter((r) =>
            dispositionFilters.includes(computeDisposition(r)),
          );
        }

        // Filter by subject type
        if (query['subject-type']) {
          const typeFilters = Array.isArray(query['subject-type'])
            ? query['subject-type']
            : [query['subject-type']];
          filtered = filtered.filter((r) =>
            typeFilters.includes(getSubjectType(r.subject)),
          );
        }

        // Filter by reviewer (author)
        if (query.reviewer) {
          filtered = filtered.filter((r) => r.author === query.reviewer);
        }

        // Filter by linked task (subject-ref or related-refs)
        if (query.task) {
          filtered = filtered.filter((r) => matchesTaskFilter(r, query.task!));
        }

        // Filter by subject branch (base-branch or head-branch for code reviews)
        if (query.branch) {
          filtered = filtered.filter((r) => matchesBranchFilter(r, query.branch!));
        }

        // Sort
        const sortField = query.sort || '-created_at';
        const descending = sortField.startsWith('-');
        const field = descending ? sortField.slice(1) : sortField;

        const sorted = [...filtered].sort((a, b) => {
          let aVal: string;
          let bVal: string;

          if (field === 'updated_at') {
            aVal = a.updated_at || a.created_at;
            bVal = b.updated_at || b.created_at;
          } else if (field === 'title') {
            aVal = a.title;
            bVal = b.title;
          } else {
            // Default: created_at
            aVal = a.created_at;
            bVal = b.created_at;
          }

          const cmp = aVal.localeCompare(bVal);
          return descending ? -cmp : cmp;
        });

        // Pagination
        const total = sorted.length;
        const offset = Number(query.offset) || 0;
        const limit = Number(query.limit) || total;
        const paginated = sorted.slice(offset, offset + limit);

        const summaries: ReviewSummary[] = paginated.map((r) =>
          toReviewSummary(r, index),
        );

        return {
          items: summaries,
          total,
          offset,
          limit,
        };
      },
      {
        query: t.Object({
          status: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          disposition: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          'subject-type': t.Optional(t.Union([t.String(), t.Array(t.String())])),
          reviewer: t.Optional(t.String()),
          task: t.Optional(t.String()),
          branch: t.Optional(t.String()),
          sort: t.Optional(t.String()),
          limit: t.Optional(t.String()),
          offset: t.Optional(t.String()),
        }),
      },
    )
    // AC: @review-records-daemon-api ac-2 - Get single review with full detail
    .get(
      '/:ref',
      async ({ params, error: errorResponse, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const reviews = await loadReviewRecords(ctx);
        const review = findReviewByRef(reviews, params.ref);

        if (!review) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Review reference "${params.ref}" not found`,
            suggestion: 'Use kspec review list to find valid review references',
          });
        }

        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const plans = await loadPlans(ctx);
        const index = new ReferenceIndex(tasks, items, [], plans, reviews);

        return toReviewDetail(review, index);
      },
    );
}
