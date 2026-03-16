/**
 * Review verdict aggregation, disposition computation,
 * verdict submission, subject refresh, and lifecycle transitions.
 *
 * Pure computation functions operate on in-memory ReviewRecord data.
 * Mutation helpers produce updated records for the caller to persist
 * via saveReviewRecord / mutateReviewAtomically.
 *
 * Delegates to existing primitives from review/subject-bindings,
 * review/checks, and parser/review-threads for version extraction,
 * staleness detection, gate evaluation, and thread operations.
 */

import { ulid } from "ulid";
import type {
  ReviewRecord,
  ReviewSubject,
  ReviewSubjectVersion,
  ReviewVerdict,
  ReviewDisposition,
  ReviewLifecycleState,
  ReviewEvent,
  ReviewVerdictDecision,
} from "../schema/index.js";
import {
  extractSubjectVersion,
  isVersionStale,
} from "../review/subject-bindings.js";
import { evaluateGates } from "../review/checks.js";
import { getUnresolvedBlockers } from "./review-threads.js";

// ---------------------------------------------------------------------------
// Verdict aggregation
// ---------------------------------------------------------------------------

/**
 * Return the latest non-stale verdict per reviewer.
 *
 * A verdict is stale if its applies_to_version does not match the
 * current subject version. Among current verdicts from the same
 * reviewer, only the most recent (by created_at) is kept.
 *
 * AC: @review-verdicts-and-resolution-lifecycle ac-7 — stale exclusion
 * AC: @review-verdicts-and-resolution-lifecycle ac-8 — latest per reviewer
 */
export function getEffectiveVerdicts(
  verdicts: ReviewVerdict[],
  currentVersion: ReviewSubjectVersion,
): ReviewVerdict[] {
  // Filter to current verdicts only (not stale)
  const current = verdicts.filter(
    (v) => !isVersionStale(v.applies_to_version, currentVersion).stale,
  );

  // Group by reviewer, keep latest
  const byReviewer = new Map<string, ReviewVerdict>();
  for (const v of current) {
    const existing = byReviewer.get(v.reviewer);
    if (!existing || v.created_at > existing.created_at) {
      byReviewer.set(v.reviewer, v);
    }
  }

  return Array.from(byReviewer.values());
}

// ---------------------------------------------------------------------------
// Disposition computation
// ---------------------------------------------------------------------------

/**
 * Compute the aggregate review disposition from verdicts, checks, and threads.
 *
 * The disposition is "approved" only when ALL of these conditions hold:
 * 1. Gate state is "passing" (all required checks pass for current version)
 * 2. No unresolved blocker threads
 * 3. No current changes_requested verdicts (per getEffectiveVerdicts)
 * 4. At least one current approve verdict exists
 *
 * If any blocker is open (gates failing, blocker threads, changes_requested),
 * disposition is "changes_requested".
 *
 * Otherwise disposition is "pending" (no blockers but insufficient approvals).
 *
 * AC: @review-verdicts-and-resolution-lifecycle ac-4 — blockers prevent approval
 * AC: @review-verdicts-and-resolution-lifecycle ac-5 — aggregation rule
 */
export function computeDisposition(review: ReviewRecord): ReviewDisposition {
  const currentVersion = extractSubjectVersion(review.subject);
  const effectiveVerdicts = getEffectiveVerdicts(
    review.verdicts,
    currentVersion,
  );
  const gateResult = evaluateGates(review.checks, currentVersion);
  const unresolvedBlockers = getUnresolvedBlockers(review);

  const hasChangesRequested = effectiveVerdicts.some(
    (v) => v.decision === "request_changes",
  );

  // Any blocker → changes_requested
  if (
    gateResult.state === "failing" ||
    unresolvedBlockers.length > 0 ||
    hasChangesRequested
  ) {
    return "changes_requested";
  }

  const hasApproval = effectiveVerdicts.some((v) => v.decision === "approve");

  // No blockers and at least one approval → approved
  if (gateResult.state === "passing" && hasApproval) {
    return "approved";
  }

  // No blockers but no approval yet → pending
  return "pending";
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

function createEvent(
  eventType: ReviewEvent["event_type"],
  actor: string,
  payload: Record<string, unknown> = {},
): ReviewEvent {
  return {
    _ulid: ulid(),
    event_type: eventType,
    actor,
    timestamp: new Date().toISOString(),
    payload,
  };
}

// ---------------------------------------------------------------------------
// Verdict submission
// ---------------------------------------------------------------------------

/**
 * Submit a verdict on a review.
 *
 * Records the verdict with applies_to_version derived from the review's
 * current subject, appends a verdict_submitted event, and updates
 * updated_at. Returns a new review record (does not mutate in place).
 *
 * AC: @review-verdicts-and-resolution-lifecycle ac-1 — verdict recording
 * AC: @review-verdicts-and-resolution-lifecycle ac-6 — reviewer, role, timestamp
 */
export function submitVerdict(
  review: ReviewRecord,
  input: {
    reviewer: string;
    decision: ReviewVerdictDecision;
    role?: string;
  },
): ReviewRecord {
  const now = new Date().toISOString();
  const currentVersion = extractSubjectVersion(review.subject);

  const verdict: ReviewVerdict = {
    reviewer: input.reviewer,
    role: input.role ?? "reviewer",
    decision: input.decision,
    applies_to_version: currentVersion,
    created_at: now,
  };

  const event = createEvent("verdict_submitted", input.reviewer, {
    decision: input.decision,
    applies_to_version: currentVersion,
  });

  return {
    ...review,
    verdicts: [...review.verdicts, verdict],
    events: [...review.events, event],
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------
// Subject refresh (re-review cycle support)
// ---------------------------------------------------------------------------

/**
 * Refresh the subject version on a review, recording the change
 * in the event log. This supports iterative re-review cycles where
 * the subject has been updated.
 *
 * AC: @review-verdicts-and-resolution-lifecycle ac-7 — stale verdict detection via subject refresh
 */
export function refreshSubject(
  review: ReviewRecord,
  newSubject: ReviewSubject,
  actor: string,
): ReviewRecord {
  const now = new Date().toISOString();
  const previousVersion = extractSubjectVersion(review.subject);
  const newVersion = extractSubjectVersion(newSubject);

  const event = createEvent("subject_refreshed", actor, {
    previous_version: previousVersion,
    new_version: newVersion,
  });

  return {
    ...review,
    subject: newSubject,
    events: [...review.events, event],
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<ReviewLifecycleState, ReviewLifecycleState[]> =
  {
    draft: ["open", "closed"],
    open: ["closed"],
    closed: ["open", "archived"],
    archived: [],
  };

/**
 * Transition a review to a new lifecycle state.
 *
 * AC: @review-verdicts-and-resolution-lifecycle ac-9 — closed/archived terminal handling
 */
export function transitionLifecycle(
  review: ReviewRecord,
  newState: ReviewLifecycleState,
  actor: string,
): ReviewRecord {
  const allowed = VALID_TRANSITIONS[review.lifecycle_state];
  if (!allowed.includes(newState)) {
    throw new Error(
      `Invalid lifecycle transition: ${review.lifecycle_state} → ${newState}`,
    );
  }

  const now = new Date().toISOString();
  const event = createEvent("lifecycle_change", actor, {
    from: review.lifecycle_state,
    to: newState,
  });

  return {
    ...review,
    lifecycle_state: newState,
    events: [...review.events, event],
    updated_at: now,
  };
}
