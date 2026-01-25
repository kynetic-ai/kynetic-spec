/**
 * Loop mode error handling utilities.
 *
 * Tracks per-task failures with [LOOP-FAIL:N] prefix in notes.
 * Escalates to automation:needs_review after 3 failures.
 */

import type { Note, Task } from "../schema/task.js";

/**
 * Parse the failure count from a [LOOP-FAIL:N] prefixed note.
 * Returns 0 if no match found.
 *
 * AC: @loop-mode-error-handling ac-4
 */
export function parseFailureCount(noteContent: string): number {
  const match = noteContent.match(/^\[LOOP-FAIL:(\d+)\]/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Get the current failure count for a task by examining its notes.
 * Returns the highest failure count found, or 0 if no failures recorded.
 *
 * AC: @loop-mode-error-handling ac-4
 */
export function getTaskFailureCount(task: Task): number {
  if (!task.notes || task.notes.length === 0) {
    return 0;
  }

  let maxCount = 0;
  for (const note of task.notes) {
    const count = parseFailureCount(note.content);
    if (count > maxCount) {
      maxCount = count;
    }
  }

  return maxCount;
}

/**
 * Create a failure note with [LOOP-FAIL:N] prefix.
 * Increments N based on prior failure count.
 *
 * AC: @loop-mode-error-handling ac-1, ac-3, ac-4
 */
export function createFailureNote(
  taskRef: string,
  errorDescription: string,
  priorFailureCount: number,
): string {
  const newCount = priorFailureCount + 1;
  return `[LOOP-FAIL:${newCount}] Task ${taskRef} failed: ${errorDescription}`;
}

/**
 * Check if failure count has reached the escalation threshold.
 * Threshold is 3 failures.
 *
 * AC: @loop-mode-error-handling ac-5
 */
export function shouldEscalate(failureCount: number): boolean {
  return failureCount >= 3;
}

/**
 * Determine if an iteration result represents a failure.
 *
 * Failures include:
 * - Tests fail
 * - PR blocked
 * - Exception thrown
 * - Agent reports cannot complete
 *
 * AC: @loop-mode-error-handling ac-7
 */
export function isIterationFailure(result: {
  succeeded?: boolean;
  error?: Error;
  stopReason?: string;
}): boolean {
  // Explicit success flag
  if (result.succeeded === false) {
    return true;
  }

  // Error was thrown
  if (result.error) {
    return true;
  }

  // Agent cancelled (stopped working)
  if (result.stopReason === "cancelled") {
    return true;
  }

  return false;
}

/**
 * Check if an in_progress task has made progress in this iteration.
 * Progress is indicated by new notes added after the startTime.
 *
 * AC: @loop-mode-error-handling ac-8
 */
export function hasTaskProgress(
  task: Task,
  iterationStartTime: Date,
): boolean {
  if (!task.notes || task.notes.length === 0) {
    return false;
  }

  // Check if any notes were created after iteration start
  for (const note of task.notes) {
    const noteTime = new Date(note.created_at);
    if (noteTime > iterationStartTime) {
      // Exclude LOOP-FAIL notes from progress check
      if (!note.content.startsWith("[LOOP-FAIL:")) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Result of processing a failed iteration for a task.
 */
export interface TaskFailureResult {
  taskRef: string;
  failureCount: number;
  escalated: boolean;
  noteAdded: boolean;
}

/**
 * Process failed iteration for tasks that were in progress.
 * Adds LOOP-FAIL notes for tasks without progress and escalates at threshold.
 *
 * This function should be called after an iteration fails to track per-task failures.
 *
 * AC: @loop-mode-error-handling ac-1, ac-2, ac-3, ac-4, ac-5, ac-8
 *
 * @param tasksInProgress - Tasks that were in_progress at iteration start
 * @param currentTasks - Current state of all tasks (after iteration)
 * @param iterationStartTime - When the iteration started
 * @param errorDescription - Description of what went wrong
 * @returns Array of results for each processed task
 */
export function processFailedIteration(
  tasksInProgress: Task[],
  currentTasks: Task[],
  iterationStartTime: Date,
  errorDescription: string,
): TaskFailureResult[] {
  const results: TaskFailureResult[] = [];

  // Create a map of current task state for quick lookup
  const currentTaskMap = new Map<string, Task>();
  for (const task of currentTasks) {
    currentTaskMap.set(task._ulid, task);
  }

  // Process each task that was in progress
  for (const originalTask of tasksInProgress) {
    const currentTask = currentTaskMap.get(originalTask._ulid);

    // Skip if task no longer exists or is no longer in_progress
    // (it may have been completed/cancelled/submitted during the iteration)
    if (!currentTask || currentTask.status !== "in_progress") {
      continue;
    }

    // Check if task made progress
    const madeProgress = hasTaskProgress(currentTask, iterationStartTime);

    // AC: @loop-mode-error-handling ac-8
    // If task is still in_progress but made no progress, count as implicit failure
    if (!madeProgress) {
      const priorCount = getTaskFailureCount(currentTask);
      const newCount = priorCount + 1;
      const escalate = shouldEscalate(newCount);

      results.push({
        taskRef: currentTask._ulid,
        failureCount: newCount,
        escalated: escalate,
        noteAdded: true, // Note will be added by caller
      });
    }
  }

  return results;
}
