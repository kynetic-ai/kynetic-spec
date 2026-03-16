/**
 * Session checkpoint logic.
 *
 * Checks for uncommitted git changes before ending a session (stop hook).
 */

import type { KspecContext } from "../../../parser/index.js";
import {
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
 *
 * Returns a structured result indicating whether the session can end cleanly.
 */
export async function performCheckpoint(
  ctx: KspecContext,
  options: CheckpointOptions,
): Promise<CheckpointResult> {
  const issues: CheckpointIssue[] = [];
  const instructions: string[] = [];

  // AC: @cmd-session-checkpoint ac-git-only
  // Check for uncommitted git changes only
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
      "Before ending this session, please commit your changes:",
    );
    instructions.push(
      "1. Commit your changes with a descriptive message",
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
