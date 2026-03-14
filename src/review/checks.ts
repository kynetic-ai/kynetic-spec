import type {
  ReviewCheck,
  ReviewCheckStatus,
  ReviewGateState,
  ReviewSubjectVersion,
} from "../schema/review-records.js";
import { isVersionStale } from "./subject-bindings.js";

// --- Check Recording Factories ---

// AC: @review-checks-and-gate-evaluation ac-1
/**
 * Create a check record with full field set.
 * Records the applies_to_version so gate evaluation knows which
 * reviewed state this check ran against.
 */
export function createCheck(opts: {
  name: string;
  status: ReviewCheckStatus;
  applies_to_version: ReviewSubjectVersion;
  required?: boolean;
  runner?: string;
  evidence?: string;
  created_at?: string;
  completed_at?: string | null;
}): ReviewCheck {
  return {
    name: opts.name,
    status: opts.status,
    required: opts.required ?? true,
    applies_to_version: opts.applies_to_version,
    created_at: opts.created_at ?? new Date().toISOString(),
    ...(opts.runner !== undefined && { runner: opts.runner }),
    ...(opts.evidence !== undefined && { evidence: opts.evidence }),
    ...(opts.completed_at !== undefined && {
      completed_at: opts.completed_at,
    }),
  };
}

// AC: @review-checks-and-gate-evaluation ac-2
/**
 * Create a first-party local check run.
 * Used when no external CI exists — agents or humans record verification
 * directly into the review record.
 */
export function createLocalCheck(opts: {
  name: string;
  status: ReviewCheckStatus;
  applies_to_version: ReviewSubjectVersion;
  runner: string;
  required?: boolean;
  evidence?: string;
  created_at?: string;
  completed_at?: string | null;
}): ReviewCheck {
  return createCheck({
    ...opts,
    runner: opts.runner,
  });
}

// AC: @review-checks-and-gate-evaluation ac-3
/**
 * Mirror an external CI check run into the review record.
 * Preserves the normalized local status model while storing the
 * external evidence link.
 */
export function mirrorExternalCheck(opts: {
  name: string;
  status: ReviewCheckStatus;
  applies_to_version: ReviewSubjectVersion;
  runner: string;
  evidence: string;
  required?: boolean;
  created_at?: string;
  completed_at?: string | null;
}): ReviewCheck {
  return createCheck({
    ...opts,
    runner: opts.runner,
    evidence: opts.evidence,
  });
}

// --- Gate Evaluation ---

/**
 * Result of evaluating a single logical check gate.
 */
export interface CheckGateResult {
  /** The logical check name */
  name: string;
  /** Whether this check is required for approval */
  required: boolean;
  /** The latest matching check run (or undefined if no fresh run exists) */
  latestRun: ReviewCheck | undefined;
  /** Whether this gate is satisfied (pass or skipped for required, always true for informational) */
  satisfied: boolean;
  /** Whether the latest run is stale relative to the current version */
  stale: boolean;
}

/**
 * Aggregate gate evaluation result.
 */
export interface GateEvaluationResult {
  /** Overall gate state */
  state: ReviewGateState;
  /** Per-check gate results */
  checks: CheckGateResult[];
  /** Summary counts */
  summary: {
    total: number;
    required: number;
    informational: number;
    passing: number;
    failing: number;
    stale: number;
    pending: number;
  };
}

// AC: @review-checks-and-gate-evaluation ac-4
// AC: @review-checks-and-gate-evaluation ac-5
// AC: @review-checks-and-gate-evaluation ac-6
/**
 * Evaluate the gate state of a review based on its check runs and the
 * current subject version.
 *
 * Gate evaluation:
 * 1. Groups checks by logical name
 * 2. For each name, finds the latest run whose applies_to_version matches
 *    the current subject version (ac-5)
 * 3. Stale checks (version mismatch) do not satisfy required gates (ac-6)
 * 4. Required checks must pass or be skipped; informational checks are
 *    always satisfied (ac-4)
 * 5. Aggregate state is "passing" if all required gates are satisfied,
 *    "failing" if any required gate is not satisfied, and "pending"
 *    if any required gate has no fresh run
 */
export function evaluateGates(
  checks: readonly ReviewCheck[],
  currentVersion: ReviewSubjectVersion,
): GateEvaluationResult {
  // Group checks by logical name, preserving insertion order
  const checksByName = new Map<string, ReviewCheck[]>();
  for (const check of checks) {
    const existing = checksByName.get(check.name);
    if (existing) {
      existing.push(check);
    } else {
      checksByName.set(check.name, [check]);
    }
  }

  const gateResults: CheckGateResult[] = [];
  let requiredCount = 0;
  let informationalCount = 0;
  let passingCount = 0;
  let failingCount = 0;
  let staleCount = 0;
  let pendingCount = 0;

  checksByName.forEach((runs, name) => {
    // Determine if any run for this check name was marked required
    const isRequired = runs.some((r) => r.required);

    // Find the latest run whose applies_to_version matches the current version.
    // "Latest" = last in array order (checks are appended chronologically).
    let latestFreshRun: ReviewCheck | undefined;
    for (let i = runs.length - 1; i >= 0; i--) {
      const staleness = isVersionStale(
        runs[i].applies_to_version,
        currentVersion,
      );
      if (!staleness.stale) {
        latestFreshRun = runs[i];
        break;
      }
    }

    const isStale = latestFreshRun === undefined && runs.length > 0;

    // Determine if this gate is satisfied
    let satisfied: boolean;
    if (!isRequired) {
      // Informational checks never block
      satisfied = true;
      informationalCount++;
    } else {
      requiredCount++;
      if (latestFreshRun === undefined) {
        // No fresh run — gate is pending (or stale)
        satisfied = false;
        if (isStale) {
          staleCount++;
        } else {
          pendingCount++;
        }
      } else if (
        latestFreshRun.status === "pass" ||
        latestFreshRun.status === "skipped"
      ) {
        satisfied = true;
        passingCount++;
      } else if (latestFreshRun.status === "running") {
        satisfied = false;
        pendingCount++;
      } else {
        // fail
        satisfied = false;
        failingCount++;
      }
    }

    gateResults.push({
      name,
      required: isRequired,
      latestRun: latestFreshRun,
      satisfied,
      stale: isStale,
    });
  });

  // Compute aggregate state
  let state: ReviewGateState;
  const requiredGates = gateResults.filter((g) => g.required);
  if (requiredGates.length === 0) {
    // No required gates — trivially passing
    state = "passing";
  } else if (requiredGates.every((g) => g.satisfied)) {
    state = "passing";
  } else if (
    requiredGates.some(
      (g) =>
        !g.satisfied &&
        g.latestRun !== undefined &&
        g.latestRun.status === "fail",
    )
  ) {
    state = "failing";
  } else {
    // Some required gates are not satisfied but none have explicit failures —
    // they're either stale or have no runs yet
    state = requiredGates.some((g) => g.stale) ? "failing" : "pending";
  }

  return {
    state,
    checks: gateResults,
    summary: {
      total: gateResults.length,
      required: requiredCount,
      informational: informationalCount,
      passing: passingCount,
      failing: failingCount,
      stale: staleCount,
      pending: pendingCount,
    },
  };
}
