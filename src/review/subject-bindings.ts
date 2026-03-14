import type {
  ReviewCodeSubject,
  ReviewPlanSubject,
  ReviewTaskSubject,
  ReviewSpecSubject,
  ReviewExternalSubject,
  ReviewSubject,
  ReviewSubjectVersion,
  ReviewCheck,
  ReviewVerdict,
} from "../schema/review-records.js";
import { computeContentHash } from "../parser/skill-render.js";

// --- Subject Binding Factories ---

// AC: @review-subject-bindings ac-1
// AC: @review-subject-bindings ac-3
/**
 * Create a code subject binding with git compare semantics.
 * Commits are the authoritative identity; branch names are optional metadata.
 */
export function createCodeSubject(opts: {
  base_commit: string;
  head_commit: string;
  merge_base_commit?: string;
  base_branch?: string;
  head_branch?: string;
}): ReviewCodeSubject {
  return {
    type: "code",
    base_commit: opts.base_commit,
    head_commit: opts.head_commit,
    ...(opts.merge_base_commit !== undefined && {
      merge_base_commit: opts.merge_base_commit,
    }),
    ...(opts.base_branch !== undefined && {
      base_branch: opts.base_branch,
    }),
    ...(opts.head_branch !== undefined && {
      head_branch: opts.head_branch,
    }),
  };
}

// AC: @review-subject-bindings ac-1
// AC: @review-subject-bindings ac-4
/**
 * Create a plan subject binding with shadow branch commit and content hash.
 */
export function createPlanSubject(opts: {
  ref: string;
  shadow_commit: string;
  content_hash: string;
}): ReviewPlanSubject {
  return {
    type: "plan",
    ref: opts.ref,
    shadow_commit: opts.shadow_commit,
    content_hash: opts.content_hash,
  };
}

// AC: @review-subject-bindings ac-1
// AC: @review-subject-bindings ac-4
/**
 * Create a task subject binding with shadow branch commit and content hash.
 */
export function createTaskSubject(opts: {
  ref: string;
  shadow_commit: string;
  content_hash: string;
}): ReviewTaskSubject {
  return {
    type: "task",
    ref: opts.ref,
    shadow_commit: opts.shadow_commit,
    content_hash: opts.content_hash,
  };
}

// AC: @review-subject-bindings ac-1
// AC: @review-subject-bindings ac-4
/**
 * Create a spec subject binding with shadow branch commit and content hash.
 */
export function createSpecSubject(opts: {
  ref: string;
  shadow_commit: string;
  content_hash: string;
}): ReviewSpecSubject {
  return {
    type: "spec",
    ref: opts.ref,
    shadow_commit: opts.shadow_commit,
    content_hash: opts.content_hash,
  };
}

// AC: @review-subject-bindings ac-1
// AC: @review-subject-bindings ac-2
/**
 * Create an external subject binding.
 * External identifiers are linkage metadata — the local kspec ref
 * (if present via related_refs on the review record) remains authoritative.
 */
export function createExternalSubject(opts: {
  url: string;
  external_id?: string;
  provider?: string;
}): ReviewExternalSubject {
  return {
    type: "external",
    url: opts.url,
    ...(opts.external_id !== undefined && {
      external_id: opts.external_id,
    }),
    ...(opts.provider !== undefined && { provider: opts.provider }),
  };
}

// --- Subject Version Extraction ---

/**
 * Extract the current subject version from a subject binding.
 * This is used to create applies_to_version values for checks and verdicts.
 */
export function extractSubjectVersion(
  subject: ReviewSubject,
): ReviewSubjectVersion {
  if (subject.type === "code") {
    return {
      type: "code_compare",
      base_commit: subject.base_commit,
      head_commit: subject.head_commit,
    };
  }
  // plan, task, spec all use content_hash
  if (
    subject.type === "plan" ||
    subject.type === "task" ||
    subject.type === "spec"
  ) {
    return {
      type: "entity_version",
      content_hash: subject.content_hash,
    };
  }
  // external subjects don't have versioning — use URL as a synthetic hash
  return {
    type: "entity_version",
    content_hash: computeContentHash(subject.url),
  };
}

// --- Staleness Detection ---

// AC: @review-subject-bindings ac-5
/**
 * Result of a staleness check on a single check or verdict.
 */
export interface StalenessResult {
  stale: boolean;
  reason?: string;
}

// AC: @review-subject-bindings ac-5
/**
 * Determine if a check or verdict is stale relative to the current subject version.
 *
 * For code subjects: compares base_commit and head_commit.
 * For shadow-branch subjects (plan, task, spec): compares content_hash,
 * NOT shadow branch HEAD, to avoid self-invalidation on review mutations.
 */
export function isVersionStale(
  appliesTo: ReviewSubjectVersion,
  currentVersion: ReviewSubjectVersion,
): StalenessResult {
  // Type mismatch means the subject kind changed — always stale
  if (appliesTo.type !== currentVersion.type) {
    return {
      stale: true,
      reason: `Version type changed from ${appliesTo.type} to ${currentVersion.type}`,
    };
  }

  if (
    appliesTo.type === "code_compare" &&
    currentVersion.type === "code_compare"
  ) {
    const commitChanged =
      appliesTo.base_commit !== currentVersion.base_commit ||
      appliesTo.head_commit !== currentVersion.head_commit;
    if (commitChanged) {
      return {
        stale: true,
        reason: "Code compare commits have changed",
      };
    }
    return { stale: false };
  }

  if (
    appliesTo.type === "entity_version" &&
    currentVersion.type === "entity_version"
  ) {
    if (appliesTo.content_hash !== currentVersion.content_hash) {
      return {
        stale: true,
        reason: "Entity content hash has changed",
      };
    }
    return { stale: false };
  }

  return { stale: false };
}

// AC: @review-subject-bindings ac-5
/**
 * Find all stale checks in a review given the current subject version.
 */
export function findStaleChecks(
  checks: readonly ReviewCheck[],
  currentVersion: ReviewSubjectVersion,
): Array<{ check: ReviewCheck; index: number; result: StalenessResult }> {
  return checks
    .map((check, index) => ({
      check,
      index,
      result: isVersionStale(check.applies_to_version, currentVersion),
    }))
    .filter((entry) => entry.result.stale);
}

// AC: @review-subject-bindings ac-5
/**
 * Find all stale verdicts in a review given the current subject version.
 */
export function findStaleVerdicts(
  verdicts: readonly ReviewVerdict[],
  currentVersion: ReviewSubjectVersion,
): Array<{ verdict: ReviewVerdict; index: number; result: StalenessResult }> {
  return verdicts
    .map((verdict, index) => ({
      verdict,
      index,
      result: isVersionStale(verdict.applies_to_version, currentVersion),
    }))
    .filter((entry) => entry.result.stale);
}
