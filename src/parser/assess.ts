/**
 * Task automation assessment logic.
 *
 * Provides criteria checking for task automation eligibility.
 * AC: @tasks-assess-automation
 */

import type { ReferenceIndex } from "./refs.js";
import type { LoadedSpecItem, LoadedTask } from "./yaml.js";

// ============================================================
// TYPES
// ============================================================

/**
 * Criterion check result
 */
export interface CriterionResult {
  pass: boolean;
  /** For skipped criteria (neutral) */
  skipped?: boolean;
  /** Additional context */
  detail?: string;
}

/**
 * Full assessment result for a task
 * AC: @tasks-assess-automation ac-3, ac-4
 */
export interface TaskAssessment {
  taskRef: string;
  taskUlid: string;
  taskTitle: string;
  taskType: string;
  criteria: {
    has_spec_ref: CriterionResult & { spec_ref?: string };
    spec_has_acs: CriterionResult & { ac_count?: number };
    not_spike: CriterionResult;
  };
  recommendation: "review_for_eligible" | "needs_review" | "manual_only";
  reason: string;
}

/**
 * Assessment summary counts
 * AC: @tasks-assess-automation ac-5, ac-25
 */
export interface AssessmentSummary {
  review_for_eligible: number;
  needs_review: number;
  manual_only: number;
  total: number;
}

// ============================================================
// ASSESSMENT LOGIC
// ============================================================

/**
 * Assess a single task's automation eligibility
 * AC: @tasks-assess-automation ac-8 through ac-16
 */
export function assessTask(
  task: LoadedTask,
  index: ReferenceIndex,
  items: LoadedSpecItem[],
): TaskAssessment {
  const taskRef =
    task.slugs.length > 0 ? `@${task.slugs[0]}` : `@${task._ulid.slice(0, 8)}`;
  const taskType = task.type || "task";

  // AC: @tasks-assess-automation ac-8, ac-9 - Check has_spec_ref
  const hasSpecRefResult = checkHasSpecRef(task, index);

  // AC: @tasks-assess-automation ac-10, ac-11 - Check spec_has_acs
  const specHasAcsResult = checkSpecHasAcs(task, index, items);

  // AC: @tasks-assess-automation ac-12, ac-13 - Check not_spike
  const notSpikeResult = checkNotSpike(task);

  // Compute recommendation
  // AC: @tasks-assess-automation ac-14, ac-15, ac-16
  const { recommendation, reason } = computeRecommendation(
    hasSpecRefResult,
    specHasAcsResult,
    notSpikeResult,
    taskType,
  );

  return {
    taskRef,
    taskUlid: task._ulid,
    taskTitle: task.title,
    taskType,
    criteria: {
      has_spec_ref: hasSpecRefResult,
      spec_has_acs: specHasAcsResult,
      not_spike: notSpikeResult,
    },
    recommendation,
    reason,
  };
}

/**
 * Check if task has spec_ref pointing to resolvable spec
 * AC: @tasks-assess-automation ac-8, ac-9
 */
function checkHasSpecRef(
  task: LoadedTask,
  index: ReferenceIndex,
): CriterionResult & { spec_ref?: string } {
  if (!task.spec_ref) {
    return { pass: false, detail: "missing" };
  }

  const resolved = index.resolve(task.spec_ref);
  if (!resolved.ok) {
    return { pass: false, detail: "unresolvable", spec_ref: task.spec_ref };
  }

  return { pass: true, spec_ref: task.spec_ref };
}

/**
 * Check if linked spec has acceptance criteria
 * AC: @tasks-assess-automation ac-10, ac-11
 */
function checkSpecHasAcs(
  task: LoadedTask,
  index: ReferenceIndex,
  items: LoadedSpecItem[],
): CriterionResult & { ac_count?: number } {
  // AC: @tasks-assess-automation ac-11 - skipped if no spec_ref
  if (!task.spec_ref) {
    return { pass: false, skipped: true, detail: "no spec to check" };
  }

  const resolved = index.resolve(task.spec_ref);
  if (!resolved.ok) {
    return { pass: false, skipped: true, detail: "spec not resolvable" };
  }

  // Find the spec item
  const specItem = items.find((i) => i._ulid === resolved.ulid);
  if (!specItem) {
    return { pass: false, skipped: true, detail: "spec not found in items" };
  }

  const acCount = specItem.acceptance_criteria?.length || 0;
  if (acCount === 0) {
    return {
      pass: false,
      ac_count: 0,
      detail: "spec has no acceptance criteria",
    };
  }

  return { pass: true, ac_count: acCount };
}

/**
 * Check if task type is not spike
 * AC: @tasks-assess-automation ac-12, ac-13
 */
function checkNotSpike(task: LoadedTask): CriterionResult {
  const taskType = task.type || "task";
  if (taskType === "spike") {
    return { pass: false, detail: "type: spike" };
  }
  return { pass: true, detail: `type: ${taskType}` };
}

/**
 * Compute recommendation based on criteria results
 * AC: @tasks-assess-automation ac-14, ac-15, ac-16
 */
function computeRecommendation(
  hasSpecRef: CriterionResult,
  specHasAcs: CriterionResult,
  notSpike: CriterionResult,
  _taskType: string,
): { recommendation: TaskAssessment["recommendation"]; reason: string } {
  // AC: @tasks-assess-automation ac-14 - Spikes are always manual_only
  if (!notSpike.pass) {
    return {
      recommendation: "manual_only",
      reason: "Spikes output knowledge, not automatable code",
    };
  }

  // AC: @tasks-assess-automation ac-15 - Missing spec or no ACs → needs_review
  const reasons: string[] = [];
  if (!hasSpecRef.pass) {
    reasons.push("missing spec_ref");
  }
  if (!specHasAcs.pass && !specHasAcs.skipped) {
    reasons.push("spec has no acceptance criteria");
  } else if (specHasAcs.skipped && !hasSpecRef.pass) {
    // Only add this if spec is missing (not if spec is unresolvable)
  }

  if (reasons.length > 0) {
    return {
      recommendation: "needs_review",
      reason: reasons.join(", "),
    };
  }

  // AC: @tasks-assess-automation ac-16 - All criteria pass → review_for_eligible
  return {
    recommendation: "review_for_eligible",
    reason: "Criteria pass - verify spec is appropriate and ACs are adequate",
  };
}

/**
 * Filter tasks for assessment
 * AC: @tasks-assess-automation ac-1, ac-2, ac-27, ac-28
 */
export function filterTasksForAssessment(
  tasks: LoadedTask[],
  options: { all?: boolean; taskRef?: string },
  index: ReferenceIndex,
): LoadedTask[] {
  let filtered = tasks;

  // AC: @tasks-assess-automation ac-28 - Exclude non-pending tasks
  filtered = filtered.filter((t) => t.status === "pending");

  // AC: @tasks-assess-automation ac-6 - Single task assessment
  if (options.taskRef) {
    const resolved = index.resolve(options.taskRef);
    if (!resolved.ok) {
      return []; // Will be handled by caller
    }
    filtered = filtered.filter((t) => t._ulid === resolved.ulid);
    return filtered;
  }

  // AC: @tasks-assess-automation ac-1, ac-27 - Filter by unassessed unless --all
  if (!options.all) {
    filtered = filtered.filter((t) => !t.automation);
  }

  return filtered;
}

/**
 * Compute summary counts from assessments
 * AC: @tasks-assess-automation ac-5, ac-25
 */
export function computeSummary(
  assessments: TaskAssessment[],
): AssessmentSummary {
  const summary: AssessmentSummary = {
    review_for_eligible: 0,
    needs_review: 0,
    manual_only: 0,
    total: assessments.length,
  };

  for (const assessment of assessments) {
    summary[assessment.recommendation]++;
  }

  return summary;
}

/**
 * Determine what changes auto mode would make
 * AC: @tasks-assess-automation ac-17, ac-18, ac-21
 */
export interface AutoModeChange {
  taskRef: string;
  taskUlid: string;
  taskTitle: string;
  action: "set_manual_only" | "set_needs_review" | "no_change";
  newStatus?: "manual_only" | "needs_review";
  reason: string;
}

export function computeAutoModeChanges(
  assessments: TaskAssessment[],
): AutoModeChange[] {
  return assessments.map((assessment) => {
    // AC: @tasks-assess-automation ac-17 - Spikes → manual_only
    if (assessment.recommendation === "manual_only") {
      return {
        taskRef: assessment.taskRef,
        taskUlid: assessment.taskUlid,
        taskTitle: assessment.taskTitle,
        action: "set_manual_only" as const,
        newStatus: "manual_only" as const,
        reason: assessment.reason,
      };
    }

    // AC: @tasks-assess-automation ac-17 - Missing criteria → needs_review
    if (assessment.recommendation === "needs_review") {
      return {
        taskRef: assessment.taskRef,
        taskUlid: assessment.taskUlid,
        taskTitle: assessment.taskTitle,
        action: "set_needs_review" as const,
        newStatus: "needs_review" as const,
        reason: assessment.reason,
      };
    }

    // AC: @tasks-assess-automation ac-18, ac-21 - review_for_eligible → no change
    return {
      taskRef: assessment.taskRef,
      taskUlid: assessment.taskUlid,
      taskTitle: assessment.taskTitle,
      action: "no_change" as const,
      reason: "Passes criteria - requires agent/human review to mark eligible",
    };
  });
}
