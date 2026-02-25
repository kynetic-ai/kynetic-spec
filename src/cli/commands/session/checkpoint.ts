/**
 * Session checkpoint logic.
 *
 * Checks for uncommitted work before ending a session (stop hook).
 */

import {
  type KspecContext,
  loadAllTasks,
} from "../../../parser/index.js";
import {
  formatCommitGuidance,
  getWorkingTreeStatus,
  isGitRepo,
} from "../../../utils/index.js";
import type {
  CheckpointIssue,
  CheckpointOptions,
  CheckpointResult,
} from "./types.js";

/**
 * Perform session checkpoint - check for uncommitted work before ending session.
 *
 * This is designed for use as a Claude Code stop hook. It checks for:
 * - Uncommitted git changes (staged, unstaged, untracked)
 * - Tasks in in_progress status
 * - Incomplete todos on active tasks
 *
 * Returns a structured result indicating whether the session can end cleanly.
 */
export async function performCheckpoint(
  ctx: KspecContext,
  options: CheckpointOptions,
): Promise<CheckpointResult> {
  const issues: CheckpointIssue[] = [];
  const instructions: string[] = [];

  // Load tasks
  const allTasks = await loadAllTasks(ctx);

  // Check for in-progress tasks
  const inProgressTasks = allTasks.filter((t) => t.status === "in_progress");
  for (const task of inProgressTasks) {
    const ref = task.slugs[0]
      ? `@${task.slugs[0]}`
      : `@${task._ulid.slice(0, 8)}`;
    issues.push({
      type: "in_progress_task",
      description: `Task ${ref} is still in progress: ${task.title}`,
      details: {
        ref,
        title: task.title,
        started_at: task.started_at,
      },
    });

    // Check for incomplete todos on this task
    const incompleteTodos = task.todos.filter((t) => !t.done);
    for (const todo of incompleteTodos) {
      issues.push({
        type: "incomplete_todo",
        description: `Incomplete todo on ${ref}: ${todo.text}`,
        details: {
          task_ref: ref,
          todo_id: todo.id,
          text: todo.text,
        },
      });
    }
  }

  // Check for uncommitted git changes
  if (isGitRepo(ctx.rootDir)) {
    const workingTree = getWorkingTreeStatus(ctx.rootDir);
    if (!workingTree.clean) {
      const changeCount =
        workingTree.staged.length +
        workingTree.unstaged.length +
        workingTree.untracked.length;

      issues.push({
        type: "uncommitted_changes",
        description: `${changeCount} uncommitted changes in working tree`,
        details: {
          staged: workingTree.staged.length,
          unstaged: workingTree.unstaged.length,
          untracked: workingTree.untracked.length,
        },
      });
    }
  }

  // Build instructions based on issues
  if (issues.length > 0 && !options.force) {
    instructions.push(
      "If you've been instructed to ignore this message or are working on",
    );
    instructions.push(
      "unrelated things to any in progress tasks then disregard this message,",
    );
    instructions.push("otherwise before ending this session, please:");

    const hasInProgress = issues.some((i) => i.type === "in_progress_task");
    const hasUncommitted = issues.some((i) => i.type === "uncommitted_changes");
    const hasIncompleteTodos = issues.some((i) => i.type === "incomplete_todo");

    let step = 1;

    if (hasInProgress) {
      instructions.push(
        `${step++}. Read in-progress task notes to get full context of the current task status`,
      );
      instructions.push(
        `${step++}. Add notes documenting current state if any context is missing from this session`,
      );
      instructions.push(
        `${step++}. Complete the task if you've completed the objectives and no AC are left uncovered\notherwise leave it in progress for a future session`,
      );
    }

    if (hasIncompleteTodos) {
      instructions.push(
        `${step++}. Complete or acknowledge incomplete todos on active tasks`,
      );
    }

    if (hasUncommitted) {
      instructions.push(
        `${step++}. Commit your changes with a descriptive message`,
      );

      // Add WIP commit guidance if there are in-progress tasks
      if (inProgressTasks.length > 0) {
        const task = inProgressTasks[0];
        const guidance = formatCommitGuidance(task, { wip: true });
        instructions.push("");
        instructions.push("Suggested WIP commit:");
        instructions.push(`  ${guidance.message}`);
        instructions.push("");
        for (const trailer of guidance.trailers) {
          instructions.push(`  ${trailer}`);
        }
      }
    }

    instructions.push("");
    instructions.push("Use: kspec task @task to get current task state");
    instructions.push(
      'Use: kspec task note @task "Progress notes..." to document state',
    );
    instructions.push(
      'Use: kspec task complete @task --reason "Summary" if task is done',
    );
  }

  // Allow stop if:
  // - No issues found
  // - --force flag passed
  // - This is a retry (stop_hook_active = true from previous block)
  const isRetry = options.stopHookActive === true;
  const ok = issues.length === 0 || options.force === true || isRetry;

  let message: string;
  if (isRetry && issues.length > 0) {
    message = `[kspec] Session checkpoint: ${issues.length} issue(s) acknowledged - allowing stop`;
  } else if (ok) {
    message = "[kspec] Session checkpoint passed - ready to end session";
  } else {
    message = `[kspec] Session checkpoint: ${issues.length} issue(s) need attention`;
  }

  return {
    ok,
    message,
    issues,
    instructions,
  };
}
