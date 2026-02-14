/**
 * Ralph Wrap-Up Agent Module
 *
 * Handles spawning a wrap-up subagent when the ralph loop exits.
 * The wrap-up agent ensures the workspace is in a clean state:
 * - Identifies uncommitted changes and reports what they relate to
 * - Commits, stashes, or flags changes for human review
 * - Produces a brief exit summary
 *
 * AC: @ralph-wrap-up-agent-on-loop-exit
 */

import type { AgentAdapter } from "../agents/adapters.js";
import { spawnAndInitialize, type SpawnedAgent } from "../agents/spawner.js";
import type { SessionUpdate } from "../acp/index.js";
import type { LoadedTask } from "../parser/index.js";
import { getWorkingTreeStatus, type GitWorkingTree } from "../utils/git.js";
import { createTranslator } from "./events.js";
import { createPrefixedRenderer } from "./cli-renderer.js";
import { RALPH_PROMPT_TIMEOUT } from "./subagent.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Exit reason for ralph loop.
 * AC: @ralph-wrap-up-agent-on-loop-exit ac-1
 */
export type ExitReason =
  | "no_tasks"
  | "end_loop_signal"
  | "max_iterations"
  | "error"
  | "max_failures"
  | "explicit_tasks_done";

/**
 * Context provided to the wrap-up agent.
 * AC: @ralph-wrap-up-agent-on-loop-exit ac-2
 */
export interface WrapUpContext {
  /** Why the loop is exiting */
  exitReason: ExitReason;
  /** Session ID for reference */
  sessionId: string;
  /** Current iteration number */
  iteration: number;
  /** Max iterations configured */
  maxIterations: number;
  /** Working tree status from git */
  workingTree: GitWorkingTree;
  /** Tasks that were in progress when loop ended */
  inProgressTasks: Array<{ ref: string; title: string }>;
  /** Tasks that were pending review when loop ended */
  pendingReviewTasks: Array<{ ref: string; title: string }>;
  /** Recent task refs worked on this session (for relating changes) */
  recentTaskRefs: string[];
  /** Error message if exit was due to error */
  errorMessage?: string;
}

/**
 * Result of running the wrap-up agent.
 * AC: @ralph-wrap-up-agent-on-loop-exit ac-4, ac-5
 */
export interface WrapUpResult {
  /** Whether wrap-up completed successfully */
  success: boolean;
  /** Whether the wrap-up agent timed out */
  timedOut: boolean;
  /** Error message if failed */
  error?: string;
  /** Whether wrap-up was skipped (e.g., clean working tree, nothing to do) */
  skipped: boolean;
  /** Reason for skipping if skipped */
  skipReason?: string;
}

/**
 * Options for running the wrap-up agent.
 */
export interface WrapUpOptions {
  /** Whether to auto-approve tool requests */
  yolo: boolean;
  /** Working directory */
  cwd: string;
  /** Tool request handler */
  handleRequest: (
    client: SpawnedAgent["client"],
    reqId: string | number,
    method: string,
    params: unknown,
  ) => Promise<void>;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default wrap-up agent timeout: 2 minutes.
 * AC: @ralph-wrap-up-agent-on-loop-exit ac-5
 */
export const DEFAULT_WRAPUP_TIMEOUT = 2 * 60 * 1000;

/** Output prefix for wrap-up agent */
export const WRAPUP_AGENT_PREFIX = "[WRAP-UP]";

// ============================================================================
// Context Builder
// ============================================================================

/**
 * Build wrap-up context from current state.
 * AC: @ralph-wrap-up-agent-on-loop-exit ac-2
 */
export function buildWrapUpContext(
  exitReason: ExitReason,
  sessionId: string,
  iteration: number,
  maxIterations: number,
  inProgressTasks: Array<{ ref: string; title: string }>,
  pendingReviewTasks: Array<{ ref: string; title: string }>,
  recentTaskRefs: string[],
  cwd?: string,
  errorMessage?: string,
): WrapUpContext {
  const workingTree = getWorkingTreeStatus(cwd);

  return {
    exitReason,
    sessionId,
    iteration,
    maxIterations,
    workingTree,
    inProgressTasks,
    pendingReviewTasks,
    recentTaskRefs,
    errorMessage,
  };
}

/**
 * Check if wrap-up is needed.
 * Wrap-up is skipped if working tree is clean and no in-progress tasks.
 *
 * Key insight: wrap-up's job is to handle uncommitted changes and summarize
 * task state. If the working tree is clean and no tasks are in progress,
 * there's nothing for wrap-up to do regardless of exit reason.
 */
export function isWrapUpNeeded(context: WrapUpContext): {
  needed: boolean;
  reason?: string;
} {
  // Always need wrap-up if there are uncommitted changes
  if (!context.workingTree.clean) {
    return { needed: true };
  }

  // Need wrap-up if there are tasks still in progress
  if (context.inProgressTasks.length > 0) {
    return { needed: true };
  }

  // Clean tree, no in-progress tasks - nothing to clean up
  // This applies even for error exits - if there's nothing to clean,
  // spawning a wrap-up agent just adds latency without benefit
  return {
    needed: false,
    reason: "Working tree is clean and no tasks in progress",
  };
}

// ============================================================================
// Prompt Builder
// ============================================================================

/**
 * Build the prompt for the wrap-up agent.
 * AC: @ralph-wrap-up-agent-on-loop-exit ac-2, ac-3, ac-4
 */
export function buildWrapUpPrompt(context: WrapUpContext): string {
  const exitReasonDescriptions: Record<ExitReason, string> = {
    no_tasks: "No automation-eligible tasks available",
    end_loop_signal: "Agent explicitly requested end of loop",
    max_iterations: `Reached maximum iterations (${context.maxIterations})`,
    error: `Error occurred: ${context.errorMessage || "Unknown error"}`,
    max_failures: "Reached maximum consecutive failures",
    explicit_tasks_done: "All explicitly scoped tasks completed or blocked",
  };

  const workingTreeSection = context.workingTree.clean
    ? "**Working tree is clean.** No uncommitted changes."
    : `**Uncommitted changes detected:**

Staged (${context.workingTree.staged.length}):
${context.workingTree.staged.length > 0 ? context.workingTree.staged.map((f) => `  - ${f.path} (${f.status})`).join("\n") : "  (none)"}

Unstaged (${context.workingTree.unstaged.length}):
${context.workingTree.unstaged.length > 0 ? context.workingTree.unstaged.map((f) => `  - ${f.path} (${f.status})`).join("\n") : "  (none)"}

Untracked (${context.workingTree.untracked.length}):
${context.workingTree.untracked.length > 0 ? context.workingTree.untracked.map((f) => `  - ${f}`).join("\n") : "  (none)"}`;

  const taskStateSection = `
**In-progress tasks (${context.inProgressTasks.length}):**
${context.inProgressTasks.length > 0 ? context.inProgressTasks.map((t) => `  - ${t.ref}: ${t.title}`).join("\n") : "  (none)"}

**Pending review tasks (${context.pendingReviewTasks.length}):**
${context.pendingReviewTasks.length > 0 ? context.pendingReviewTasks.map((t) => `  - ${t.ref}: ${t.title}`).join("\n") : "  (none)"}

**Recent task refs worked this session:**
${context.recentTaskRefs.length > 0 ? context.recentTaskRefs.map((r) => `  - ${r}`).join("\n") : "  (none)"}`;

  return `# Ralph Wrap-Up Agent

You are a wrap-up agent spawned at the end of a ralph automation session.
Your job is to ensure the workspace is in a clean state before the process terminates.

## Exit Information

**Session ID:** \`${context.sessionId}\`
**Iteration:** ${context.iteration} of ${context.maxIterations}
**Exit Reason:** ${exitReasonDescriptions[context.exitReason]}

## Working Tree Status

${workingTreeSection}

## Task State
${taskStateSection}

## Instructions

Your responsibilities are:

### 1. Handle Uncommitted Changes (if any)

For each uncommitted change, determine what to do:

- **If changes relate to a known task** (match file patterns to recent task refs):
  - Commit them with an appropriate message including the task ref
  - Example: \`git commit -m "wip: partial work on @task-ref\\n\\nRalph session ended before completion."\`

- **If changes are test files, build artifacts, or generated code:**
  - Commit them if they look intentional
  - Or add to .gitignore if they shouldn't be tracked

- **If changes are unclear or potentially destructive:**
  - Stash them with a descriptive message: \`git stash push -m "ralph-wrapup: [description]"\`
  - Or flag them for human review by leaving uncommitted but documenting

**CRITICAL:** Do NOT discard any work. Every change must be preserved somehow (commit, stash, or documented).

### 2. Produce Exit Summary

After handling any changes, output a brief summary:

\`\`\`
=== RALPH SESSION EXIT SUMMARY ===
Session: ${context.sessionId}
Exit reason: [reason]
Changes handled: [what was committed/stashed/flagged]
Tasks in progress: [list or "none"]
Tasks pending review: [list or "none"]
Human attention needed: [yes/no - if yes, explain what needs attention]
\`\`\`

### 3. Exit

Once cleanup is complete and summary is output, stop. Do not start new work.

## Timeout Warning

You have 2 minutes to complete wrap-up. If you cannot complete in time, prioritize:
1. Preserving uncommitted changes (stash if can't commit quickly)
2. Outputting a minimal summary

Do not let wrap-up block shutdown indefinitely.
`;
}

// ============================================================================
// Wrap-Up Runner
// ============================================================================

/**
 * Run the wrap-up agent.
 *
 * AC: @ralph-wrap-up-agent-on-loop-exit ac-1 (spawn), ac-2 (inspect),
 *     ac-3 (handle changes), ac-4 (summary), ac-5 (timeout)
 *
 * @param adapter - Agent adapter to use for spawning
 * @param context - Wrap-up context
 * @param options - Runtime options
 * @param timeout - Timeout in ms (default: 2 minutes)
 * @returns Result indicating success/failure/timeout/skipped
 */
export async function runWrapUpAgent(
  adapter: AgentAdapter,
  context: WrapUpContext,
  options: WrapUpOptions,
  timeout: number = DEFAULT_WRAPUP_TIMEOUT,
): Promise<WrapUpResult> {
  // Check if wrap-up is needed
  const { needed, reason } = isWrapUpNeeded(context);
  if (!needed) {
    return {
      success: true,
      timedOut: false,
      skipped: true,
      skipReason: reason,
    };
  }

  const prompt = buildWrapUpPrompt(context);
  let agent: SpawnedAgent | null = null;

  try {
    // AC: @ralph-wrap-up-agent-on-loop-exit ac-1 - Spawn wrap-up agent
    agent = await spawnAndInitialize(adapter, {
      cwd: options.cwd,
      clientOptions: {
        clientInfo: {
          name: "kspec-ralph-wrapup",
          version: "1.0.0",
        },
        methodTimeouts: {
          "session/prompt": RALPH_PROMPT_TIMEOUT,
          "session/resume": RALPH_PROMPT_TIMEOUT,
        },
      },
    });

    // Set up streaming output with prefix
    const translator = createTranslator();
    const renderer = createPrefixedRenderer(WRAPUP_AGENT_PREFIX);

    agent.client.on("update", (_sid: string, update: SessionUpdate) => {
      const event = translator.translate(update);
      if (event) {
        renderer.render(event);
      }
    });

    // Set up tool request handler
    agent.client.on(
      "request",
      (reqId: string | number, method: string, params: unknown) => {
        options
          .handleRequest(agent!.client, reqId, method, params)
          .catch((err) => {
            agent!.client.respondError(reqId, -32000, err.message);
          });
      },
    );

    // Create ACP session
    const acpSessionId = await agent.client.newSession({
      cwd: options.cwd,
      mcpServers: [],
    });

    // AC: @ralph-wrap-up-agent-on-loop-exit ac-5 - Timeout handling
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("WRAPUP_TIMEOUT")), timeout);
    });

    // Send prompt and wait for completion
    const promptPromise = agent.client.prompt({
      sessionId: acpSessionId,
      prompt: [{ type: "text", text: prompt }],
    });

    // Race between completion and timeout
    await Promise.race([promptPromise, timeoutPromise]);

    return { success: true, timedOut: false, skipped: false };
  } catch (err) {
    const error = err as Error;

    // AC: @ralph-wrap-up-agent-on-loop-exit ac-5 - Timeout detection
    if (error.message === "WRAPUP_TIMEOUT") {
      return { success: false, timedOut: true, skipped: false };
    }

    return { success: false, timedOut: false, skipped: false, error: error.message };
  } finally {
    // Always clean up the agent process
    if (agent) {
      agent.kill();
    }
  }
}
