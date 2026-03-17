/**
 * Review API Routes — Verdict, Check, and Lifecycle Mutations
 *
 * REST endpoints for review verdict recording, check reporting,
 * and lifecycle transitions.
 *
 * AC Coverage:
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
  findReviewByRef,
  mutateReviewAtomically,
  submitVerdict,
  transitionLifecycle,
  computeDisposition,
  loadAllTasks,
  handleVerdictTaskTransition,
  VALID_TRANSITIONS,
} from '../../parser/index.js';
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
} from '../../schema/index.js';

interface ReviewsRouteOptions {
  pubsub: PubSubManager;
}

const VALID_DECISIONS: ReviewVerdictDecision[] = ['approve', 'request_changes', 'comment'];
const VALID_CHECK_STATUSES: ReviewCheckStatus[] = ['pass', 'fail', 'running', 'skipped'];
const VALID_LIFECYCLE_TARGETS: ReviewLifecycleState[] = ['open', 'closed', 'archived'];

export function createReviewsRoutes(options: ReviewsRouteOptions) {
  const { pubsub } = options;

  return new Elysia({ prefix: '/api/reviews' })

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
          decision: t.Optional(t.String()),
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
          status: t.Optional(t.String()),
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
          target: t.Optional(t.String()),
          actor: t.Optional(t.String()),
        })),
      }
    );
}
