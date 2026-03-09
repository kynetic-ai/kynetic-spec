/**
 * Session checkpoint logic.
 *
 * Checks for uncommitted work before ending a session (stop hook).
 */

import {
  type KspecContext,
  loadAllItems,
  loadAllTasks,
  ReferenceIndex,
} from "../../../parser/index.js";
import { getSession } from "../../../sessions/store.js";
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
import { getDisplayRef } from "./format.js";

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
  const allItems = await loadAllItems(ctx);
  const refIndex = new ReferenceIndex(allTasks, allItems);

  // Filter in-progress tasks by session scope
  // AC: @cmd-session-checkpoint ac-session-scope
  // AC: @cmd-session-checkpoint ac-no-session-scope
  // AC: @cmd-session-checkpoint ac-session-failsafe
  const sessionId = process.env.KSPEC_SESSION_ID || null;
  const sessionActiveCache = new Map<string, boolean>();
  async function isSessionActive(sid: string): Promise<boolean> {
    if (sessionActiveCache.has(sid)) return sessionActiveCache.get(sid)!;
    const session = await getSession(ctx.sessionsDir, sid);
    // Fail-safe: if lookup fails (null), treat as NOT active → include task
    const active = session?.status === "active";
    sessionActiveCache.set(sid, active);
    return active;
  }

  const inProgressTasks = [];
  for (const t of allTasks) {
    if (t.status !== "in_progress") continue;
    if (!t.session_id) {
      // Unclaimed — always include
      inProgressTasks.push(t);
    } else if (t.session_id === sessionId) {
      // Mine — always include
      inProgressTasks.push(t);
    } else if (!(await isSessionActive(t.session_id))) {
      // Owning session is gone/closed/corrupt — include (orphaned)
      inProgressTasks.push(t);
    }
    // else: active other session — skip
  }
  for (const task of inProgressTasks) {
    const ref = getDisplayRef({
      ref: refIndex.shortUlid(task._ulid),
      slug: task.slugs[0] || null,
    });
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
        `${step++}. Submit the task if you've completed the objectives and no AC are left uncovered\notherwise leave it in progress for a future session`,
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
      "Use: kspec task submit @task if task is done",
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
