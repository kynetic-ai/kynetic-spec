/**
 * Review-task integration: sync rules and linkage.
 *
 * Implements the synchronization rules between review records and task
 * lifecycle without replacing the lightweight task workflow model.
 *
 * AC: @review-task-lifecycle-integration ac-1 - review_ref linkage
 * AC: @review-task-lifecycle-integration ac-2 - auto-set review_ref on task subject
 * AC: @review-task-lifecycle-integration ac-3 - auto-set review_ref on related task
 * AC: @review-task-lifecycle-integration ac-4 - verdict drives task transition
 * AC: @review-task-lifecycle-integration ac-5 - inconsistent linkage warning
 * AC: @review-task-lifecycle-integration ac-6 - history preserved through fix cycles
 * AC: @review-task-lifecycle-integration ac-7 - external links as compatibility
 */

import type { ReviewRecord, ReviewVerdictDecision } from "../schema/index.js";
import type { KspecContext, LoadedTask } from "./yaml.js";
import { createNote, getAuthor, mutateTaskAtomically } from "./yaml.js";
import { findReviewByRef, loadReviewRecords, type LoadedReviewRecord } from "./reviews.js";

/**
 * Result of linking a review to task(s).
 */
export interface ReviewTaskLinkResult {
  /** Tasks that had their review_ref updated. */
  linkedTasks: Array<{ ulid: string; slug?: string }>;
}

/**
 * Link a newly created review to associated tasks by setting review_ref.
 *
 * AC: @review-task-lifecycle-integration ac-2 - task subject auto-link
 * AC: @review-task-lifecycle-integration ac-3 - related_refs auto-link
 *
 * When a review is created with:
 * - A task subject (type: "task"): sets review_ref on the subject task
 * - related_refs containing task refs: sets review_ref on each related task
 *
 * Uses the first slug as the review ref, falling back to @ULID.
 */
export async function linkReviewToTasks(
  ctx: KspecContext,
  review: ReviewRecord,
  allTasks: LoadedTask[],
): Promise<ReviewTaskLinkResult> {
  const result: ReviewTaskLinkResult = { linkedTasks: [] };
  const reviewRef = review.slugs.length > 0
    ? `@${review.slugs[0]}`
    : `@${review._ulid}`;

  // Collect task refs to link
  const taskRefsToLink = new Set<string>();

  // AC: @review-task-lifecycle-integration ac-2 - task subject
  if (review.subject.type === "task") {
    taskRefsToLink.add(review.subject.ref);
  }

  // AC: @review-task-lifecycle-integration ac-3 - related_refs
  for (const ref of review.related_refs) {
    // Only link refs that resolve to tasks
    const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;
    const matchedTask = allTasks.find(
      (t) =>
        t._ulid === cleanRef ||
        t._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
        t.slugs.includes(cleanRef),
    );
    if (matchedTask) {
      taskRefsToLink.add(ref);
    }
  }

  // Set review_ref on each matched task
  for (const taskRef of taskRefsToLink) {
    const cleanRef = taskRef.startsWith("@") ? taskRef.slice(1) : taskRef;
    const task = allTasks.find(
      (t) =>
        t._ulid === cleanRef ||
        t._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
        t.slugs.includes(cleanRef),
    );
    if (!task) continue;

    await mutateTaskAtomically(ctx, task, (latestTask) => ({
      ...latestTask,
      review_ref: reviewRef,
    }));

    result.linkedTasks.push({
      ulid: task._ulid,
      slug: task.slugs[0],
    });
  }

  return result;
}

/**
 * Handle verdict-driven task transition.
 *
 * AC: @review-task-lifecycle-integration ac-4
 *
 * When a changes_requested verdict is recorded on a review:
 * - If the review has a task subject, transition that task to needs_work
 * - If the review has related task refs, transition those tasks to needs_work
 *
 * Only transitions tasks that are currently in pending_review.
 * Returns the list of tasks that were transitioned.
 */
export async function handleVerdictTaskTransition(
  ctx: KspecContext,
  review: ReviewRecord,
  decision: ReviewVerdictDecision,
  allTasks: LoadedTask[],
  reviewer?: string,
): Promise<Array<{ ulid: string; slug?: string; transitioned: boolean }>> {
  if (decision !== "request_changes") {
    return [];
  }

  const results: Array<{ ulid: string; slug?: string; transitioned: boolean }> = [];

  // Collect task refs from subject and related_refs
  const taskRefsToCheck = new Set<string>();

  if (review.subject.type === "task") {
    taskRefsToCheck.add(review.subject.ref);
  }

  for (const ref of review.related_refs) {
    const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;
    const matchedTask = allTasks.find(
      (t) =>
        t._ulid === cleanRef ||
        t._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
        t.slugs.includes(cleanRef),
    );
    if (matchedTask) {
      taskRefsToCheck.add(ref);
    }
  }

  for (const taskRef of taskRefsToCheck) {
    const cleanRef = taskRef.startsWith("@") ? taskRef.slice(1) : taskRef;
    const task = allTasks.find(
      (t) =>
        t._ulid === cleanRef ||
        t._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
        t.slugs.includes(cleanRef),
    );
    if (!task) continue;

    if (task.status !== "pending_review") {
      results.push({ ulid: task._ulid, slug: task.slugs[0], transitioned: false });
      continue;
    }

    // Count existing fix cycles for cycle numbering
    const existingKickbacks = task.notes.filter((note) =>
      note.content.includes("[FIX_CYCLE:"),
    ).length;
    const cycleNumber = existingKickbacks + 1;

    await mutateTaskAtomically(ctx, task, (latestTask) => {
      if (latestTask.status !== "pending_review") {
        return latestTask;
      }

      const note = createNote(
        `[FIX_CYCLE: ${cycleNumber}] Review verdict: changes_requested${reviewer ? ` by ${reviewer}` : ""}`,
        getAuthor(ctx.config?.identity?.author),
      );

      return {
        ...latestTask,
        status: "needs_work" as const,
        session_id: null,
        notes: [...latestTask.notes, note],
      };
    });

    results.push({ ulid: task._ulid, slug: task.slugs[0], transitioned: true });
  }

  return results;
}

/**
 * Warning about inconsistent review linkage on a task.
 *
 * AC: @review-task-lifecycle-integration ac-5
 */
export interface ReviewLinkageWarning {
  taskRef: string;
  taskTitle: string;
  message: string;
}

/**
 * Check tasks for inconsistent review linkage.
 *
 * AC: @review-task-lifecycle-integration ac-5
 *
 * Surfaces warnings when:
 * - A task is in pending_review with no review_ref
 * - A task is in pending_review with a review_ref pointing at a closed/archived review
 */
export function checkReviewLinkageConsistency(
  tasks: LoadedTask[],
  reviews: LoadedReviewRecord[],
): ReviewLinkageWarning[] {
  const warnings: ReviewLinkageWarning[] = [];

  for (const task of tasks) {
    if (task.status !== "pending_review") continue;

    const taskRef = task.slugs[0] ? `@${task.slugs[0]}` : `@${task._ulid}`;

    if (!task.review_ref) {
      warnings.push({
        taskRef,
        taskTitle: task.title,
        message: `Task ${taskRef} is in pending_review but has no review_ref — review linkage is missing`,
      });
      continue;
    }

    // Check if review_ref points to a valid, non-closed review
    const review = findReviewByRef(reviews, task.review_ref);
    if (!review) {
      warnings.push({
        taskRef,
        taskTitle: task.title,
        message: `Task ${taskRef} has review_ref ${task.review_ref} but the review record was not found`,
      });
    } else if (review.lifecycle_state === "closed" || review.lifecycle_state === "archived") {
      warnings.push({
        taskRef,
        taskTitle: task.title,
        message: `Task ${taskRef} is in pending_review but review_ref ${task.review_ref} is ${review.lifecycle_state}`,
      });
    }
  }

  return warnings;
}
