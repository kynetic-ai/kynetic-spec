/**
 * Review verdict aggregation, gate evaluation, staleness detection,
 * thread resolution, and lifecycle transitions.
 *
 * Pure computation functions operate on in-memory ReviewRecord data.
 * Mutation helpers produce updated records for the caller to persist
 * via saveReviewRecord / mutateReviewAtomically.
 */

import { ulid } from "ulid";
import type {
  ReviewRecord,
  ReviewSubject,
  ReviewSubjectVersion,
  ReviewVerdict,
  ReviewCheck,
  ReviewThread,
  ReviewDisposition,
  ReviewGateState,
  ReviewLifecycleState,
  ReviewEvent,
  ReviewVerdictDecision,
} from "../schema/index.js";

// ---------------------------------------------------------------------------
// Subject version extraction
// ---------------------------------------------------------------------------

/**
 * Extract the current subject version from a review's subject binding.
 *
 * For code subjects: returns { type: "code_compare", base_commit, head_commit }
 * For entity subjects (plan/task/spec): returns { type: "entity_version", content_hash }
 * For external subjects: returns undefined (no versioning contract)
 */
// AC: @review-verdicts-and-resolution-lifecycle ac-5, ac-7
export function getCurrentSubjectVersion(
  subject: ReviewSubject,
): ReviewSubjectVersion | undefined {
  switch (subject.type) {
    case "code":
      return {
        type: "code_compare",
        base_commit: subject.base_commit,
        head_commit: subject.head_commit,
      };
    case "plan":
    case "task":
    case "spec":
      return {
        type: "entity_version",
        content_hash: subject.content_hash,
      };
    case "external":
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Version freshness
// ---------------------------------------------------------------------------

/**
 * Check whether an applies_to_version matches the current subject version.
 *
 * For code_compare: both base_commit AND head_commit must match.
 * For entity_version: content_hash must match.
 * If currentVersion is undefined (external subject), always returns false
 * since there is no versioning contract.
 */
// AC: @review-verdicts-and-resolution-lifecycle ac-5, ac-7
export function isVersionCurrent(
  appliesTo: ReviewSubjectVersion,
  currentVersion: ReviewSubjectVersion | undefined,
): boolean {
  if (!currentVersion) return false;

  if (
    appliesTo.type === "code_compare" &&
    currentVersion.type === "code_compare"
  ) {
    return (
      appliesTo.base_commit === currentVersion.base_commit &&
      appliesTo.head_commit === currentVersion.head_commit
    );
  }

  if (
    appliesTo.type === "entity_version" &&
    currentVersion.type === "entity_version"
  ) {
    return appliesTo.content_hash === currentVersion.content_hash;
  }

  // Mismatched version types — treat as stale
  return false;
}

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
  currentVersion: ReviewSubjectVersion | undefined,
): ReviewVerdict[] {
  // Filter to current verdicts only
  const current = verdicts.filter((v) =>
    isVersionCurrent(v.applies_to_version, currentVersion),
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
// Gate evaluation
// ---------------------------------------------------------------------------

/**
 * Compute the aggregate gate state from check records.
 *
 * Only checks whose applies_to_version matches the current subject
 * version are considered. Among multiple runs of the same logical
 * check name, only the latest (by created_at) is used.
 *
 * Gate state rules:
 * - If any required check has status "fail" → "failing"
 * - If any required check has status "running" → "pending"
 * - If no required checks exist at all → "passing" (vacuously)
 * - If all required checks pass → "passing"
 * - Otherwise → "pending"
 */
// AC: @review-verdicts-and-resolution-lifecycle ac-4
export function computeGateState(
  checks: ReviewCheck[],
  currentVersion: ReviewSubjectVersion | undefined,
): ReviewGateState {
  // Filter to current checks
  const current = checks.filter((c) =>
    isVersionCurrent(c.applies_to_version, currentVersion),
  );

  // Deduplicate by name, keep latest
  const byName = new Map<string, ReviewCheck>();
  for (const c of current) {
    const existing = byName.get(c.name);
    if (!existing || c.created_at > existing.created_at) {
      byName.set(c.name, c);
    }
  }

  const requiredChecks = Array.from(byName.values()).filter((c) => c.required);

  if (requiredChecks.length === 0) return "passing";

  if (requiredChecks.some((c) => c.status === "fail")) return "failing";
  if (requiredChecks.some((c) => c.status === "running")) return "pending";
  if (requiredChecks.every((c) => c.status === "pass")) return "passing";

  return "pending";
}

// ---------------------------------------------------------------------------
// Thread blocking
// ---------------------------------------------------------------------------

/**
 * Check whether any blocker threads are unresolved.
 */
// AC: @review-verdicts-and-resolution-lifecycle ac-4
export function hasUnresolvedBlockerThreads(threads: ReviewThread[]): boolean {
  return threads.some((t) => t.kind === "blocker" && !t.resolved_at);
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
  const currentVersion = getCurrentSubjectVersion(review.subject);
  const effectiveVerdicts = getEffectiveVerdicts(
    review.verdicts,
    currentVersion,
  );
  const gateState = computeGateState(review.checks, currentVersion);
  const unresolvedBlockers = hasUnresolvedBlockerThreads(review.threads);

  const hasChangesRequested = effectiveVerdicts.some(
    (v) => v.decision === "request_changes",
  );

  // Any blocker → changes_requested
  if (gateState === "failing" || unresolvedBlockers || hasChangesRequested) {
    return "changes_requested";
  }

  const hasApproval = effectiveVerdicts.some((v) => v.decision === "approve");

  // No blockers and at least one approval → approved
  if (gateState === "passing" && hasApproval) {
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
  const currentVersion = getCurrentSubjectVersion(review.subject);

  if (!currentVersion) {
    throw new Error(
      "Cannot submit verdict: review subject has no versioning contract (external subject)",
    );
  }

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
// Thread resolution
// ---------------------------------------------------------------------------

/**
 * Mark a thread as resolved.
 *
 * AC: @review-verdicts-and-resolution-lifecycle ac-2 — thread resolution
 */
export function resolveThread(
  review: ReviewRecord,
  threadUlid: string,
  actor: string,
): ReviewRecord {
  const now = new Date().toISOString();
  const threadIndex = review.threads.findIndex((t) => t._ulid === threadUlid);

  if (threadIndex === -1) {
    throw new Error(`Thread not found: ${threadUlid}`);
  }

  if (review.threads[threadIndex].resolved_at) {
    throw new Error(`Thread already resolved: ${threadUlid}`);
  }

  const updatedThreads = review.threads.map((t, i) =>
    i === threadIndex ? { ...t, resolved_at: now, resolved_by: actor } : t,
  );

  const event = createEvent("thread_resolved", actor, {
    thread_ulid: threadUlid,
  });

  return {
    ...review,
    threads: updatedThreads,
    events: [...review.events, event],
    updated_at: now,
  };
}

/**
 * Reopen a previously resolved thread.
 */
export function reopenThread(
  review: ReviewRecord,
  threadUlid: string,
  actor: string,
): ReviewRecord {
  const now = new Date().toISOString();
  const threadIndex = review.threads.findIndex((t) => t._ulid === threadUlid);

  if (threadIndex === -1) {
    throw new Error(`Thread not found: ${threadUlid}`);
  }

  if (!review.threads[threadIndex].resolved_at) {
    throw new Error(`Thread is not resolved: ${threadUlid}`);
  }

  const updatedThreads = review.threads.map((t, i) =>
    i === threadIndex
      ? { ...t, resolved_at: null, resolved_by: null }
      : t,
  );

  const event = createEvent("thread_reopened", actor, {
    thread_ulid: threadUlid,
  });

  return {
    ...review,
    threads: updatedThreads,
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
 * AC: @review-verdicts-and-resolution-lifecycle ac-3 — re-review cycles
 */
export function refreshSubject(
  review: ReviewRecord,
  newSubject: ReviewSubject,
  actor: string,
): ReviewRecord {
  const now = new Date().toISOString();
  const previousVersion = getCurrentSubjectVersion(review.subject);
  const newVersion = getCurrentSubjectVersion(newSubject);

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
