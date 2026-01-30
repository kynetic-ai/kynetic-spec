/**
 * Ralph command - automated task loop via ACP.
 *
 * Runs an ACP-compliant agent in a loop to process tasks autonomously.
 * Uses session event storage for full audit trail and streaming output.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { ulid } from "ulid";

// Read version from package.json for ACP client info
const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../../../package.json");

import type { ACPClient } from "../../acp/client.js";
import type {
  ReadTextFileRequest,
  RequestPermissionRequest,
  SessionUpdate,
  WriteTextFileRequest,
} from "../../acp/index.js";
import {
  type AgentAdapter,
  registerAdapter,
  resolveAdapter,
} from "../../agents/index.js";
import { type SpawnedAgent, spawnAndInitialize } from "../../agents/spawner.js";
import {
  initContext,
  type KspecContext,
  loadAllItems,
  loadAllTasks,
  type LoadedTask,
  ReferenceIndex,
} from "../../parser/index.js";
import {
  createCliRenderer,
  createTranslator,
  DEFAULT_SUBAGENT_PREFIX,
  DEFAULT_SUBAGENT_TIMEOUT,
  runSubagent,
  type SubagentContext,
} from "../../ralph/index.js";
import {
  appendEvent,
  createSession,
  saveSessionContext,
  updateSessionStatus,
} from "../../sessions/index.js";
import { errors } from "../../strings/index.js";
import { getCurrentBranch } from "../../utils/git.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, success, warn } from "../output.js";
import {
  gatherSessionContext,
  getIterationStats,
  type ActiveTaskSummary,
  type SessionContext,
} from "./session.js";

// ─── Task Limit Marker ──────────────────────────────────────────────────────

/**
 * Marker file schema for task limit enforcement.
 * AC: @ralph-task-limit ac-marker-format
 */
interface TaskLimitMarker {
  active: boolean;
  since: string; // ISO8601
  max: number;
  completed: number;
  sessionId: string;
}

const TASK_LIMIT_MARKER_PATH = ".claude/ralph-task-limit.json";
const STALE_MARKER_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/**
 * Write task limit marker file.
 * AC: @ralph-task-limit ac-wrapup, ac-marker-format
 */
async function writeTaskLimitMarker(
  rootDir: string,
  marker: TaskLimitMarker,
): Promise<void> {
  const markerPath = path.join(rootDir, TASK_LIMIT_MARKER_PATH);
  const dir = path.dirname(markerPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(markerPath, JSON.stringify(marker, null, 2));
}

/**
 * Read task limit marker file if it exists.
 */
async function readTaskLimitMarker(
  rootDir: string,
): Promise<TaskLimitMarker | null> {
  const markerPath = path.join(rootDir, TASK_LIMIT_MARKER_PATH);
  try {
    const content = await fs.readFile(markerPath, "utf-8");
    return JSON.parse(content) as TaskLimitMarker;
  } catch {
    return null;
  }
}

/**
 * Clear task limit marker file.
 * AC: @ralph-task-limit ac-reset
 */
async function clearTaskLimitMarker(rootDir: string): Promise<void> {
  const markerPath = path.join(rootDir, TASK_LIMIT_MARKER_PATH);
  try {
    await fs.unlink(markerPath);
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Clear stale marker files (older than 1 hour).
 * AC: @ralph-task-limit ac-reset
 */
async function clearStaleMarker(rootDir: string): Promise<boolean> {
  const marker = await readTaskLimitMarker(rootDir);
  if (!marker) return false;

  const markerAge = Date.now() - new Date(marker.since).getTime();
  if (markerAge > STALE_MARKER_THRESHOLD_MS) {
    await clearTaskLimitMarker(rootDir);
    return true;
  }
  return false;
}

/**
 * Detect if a Bash command is a task complete command.
 * AC: @ralph-task-limit ac-detection
 */
function detectTaskCompleteCommand(command: string): boolean {
  // Match variations of "kspec task complete"
  // Don't match "kspec task submit" - that's just status change to pending_review
  return /\bkspec\s+task\s+complete\b/.test(command);
}

/**
 * Extract Bash command from SessionUpdate if it's a tool_call or tool_call_update event.
 * Returns null if not a Bash tool call.
 */
function extractBashCommand(update: SessionUpdate): string | null {
  const u = update as Record<string, unknown>;

  // Check if this is a tool call event
  if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") {
    return null;
  }

  // Extract tool name - check various locations Claude Code uses
  let toolName: string | undefined;

  // Try _meta.claudeCode.toolName first (Claude Code pattern)
  const meta = u._meta as Record<string, unknown> | undefined;
  if (meta) {
    const claudeCode = meta.claudeCode as Record<string, unknown> | undefined;
    if (claudeCode?.toolName) {
      toolName = String(claudeCode.toolName);
    } else if (meta.toolName) {
      toolName = String(meta.toolName);
    }
  }

  // Fall back to name or title field
  if (!toolName && u.name) {
    toolName = String(u.name);
  }
  if (!toolName && u.title) {
    toolName = String(u.title);
  }

  // Check if it's a Bash tool (handle MCP prefix variations)
  if (!toolName) return null;
  const isBash = toolName === "Bash" || toolName.endsWith("__Bash");
  if (!isBash) return null;

  // Extract command from input
  const input = (u.rawInput || u.input || u.params) as Record<string, unknown> | undefined;
  if (!input) return null;

  const command = input.command;
  if (typeof command !== "string") return null;

  return command;
}

// ─── Prompt Template ─────────────────────────────────────────────────────────

// AC: @ralph-skill-delegation ac-1, ac-2, ac-3
function buildTaskWorkPrompt(
  sessionCtx: SessionContext,
  iteration: number,
  maxLoops: number,
  sessionId: string,
  focus?: string,
): string {
  const focusSection = focus
    ? `
## Session Focus (applies to ALL iterations)

> **${focus}**

Keep this focus in mind throughout your work. It takes priority over default task selection.
`
    : "";

  return `# Kspec Automation Session - Task Work

**Session ID:** \`${sessionId}\`
**Iteration:** ${iteration} of ${maxLoops}
**Mode:** Automated (no human in the loop)
${focusSection}

## Current State
\`\`\`json
${JSON.stringify(sessionCtx, null, 2)}
\`\`\`

## Instructions

Run the task-work skill in loop mode:

\`\`\`
/task-work loop
\`\`\`

Loop mode means: no confirmations, auto-resolve decisions, automation-eligible tasks only.

Exit when task work is complete or no eligible tasks remain.
`;
}

/**
 * Build the reflect prompt sent after task-work completes.
 * Ralph sends this as a separate prompt to ensure reflection always happens.
 */
function buildReflectPrompt(
  iteration: number,
  maxLoops: number,
  sessionId: string,
): string {
  const isFinal = iteration === maxLoops;

  return `# Kspec Automation Session - Reflection

**Session ID:** \`${sessionId}\`
**Iteration:** ${iteration} of ${maxLoops}
**Phase:** Post-task reflection

## Instructions

Run the reflect skill in loop mode:

\`\`\`
/reflect loop
\`\`\`

Loop mode means: high-confidence captures only, must search existing before capturing, no user prompts.
${
  isFinal
    ? `
**FINAL ITERATION** - This is the last chance to capture insights from this session.
`
    : ""
}
Exit when reflection is complete.
`;
}

// ─── Streaming Output ────────────────────────────────────────────────────────

// Translator and renderer are created per-session in the action handler.
// This allows the architecture to be reused by future TUI renderers.

// ─── Adapter Validation ──────────────────────────────────────────────────────

// AC: @ralph-adapter-validation valid-adapter-proceeds, invalid-adapter-error, validation-before-spawn
/**
 * Validate that the specified ACP adapter package exists.
 * Uses npx --no-install to check both global and local node_modules.
 *
 * @throws {Error} Never throws - exits process with code 3 if validation fails
 */
function validateAdapter(adapterPackage: string): void {
  // Use npx --no-install with --version to check if package exists
  // This checks both global and local node_modules, handles scoped packages
  const result = spawnSync(
    "npx",
    ["--no-install", adapterPackage, "--version"],
    {
      encoding: "utf-8",
      stdio: "pipe",
    },
  );

  if (result.status !== 0) {
    error(
      `Adapter package not found: ${adapterPackage}. Install with: npm install -g ${adapterPackage}`,
    );
    process.exit(EXIT_CODES.NOT_FOUND);
  }
}

// ─── Tool Request Handler ────────────────────────────────────────────────────

/**
 * Handle tool requests from ACP agent.
 * Implements file operations, terminal commands, and permission handling.
 */
async function handleRequest(
  client: ACPClient,
  id: string | number,
  method: string,
  params: unknown,
  yolo: boolean,
): Promise<void> {
  try {
    switch (method) {
      case "session/request_permission": {
        const p = params as RequestPermissionRequest;
        // In yolo mode, auto-approve all permissions
        // In normal mode, would need to implement permission UI
        const options = p.options || [];

        if (yolo) {
          // Find an "allow" option (prefer allow_always, then allow_once)
          const allowOption =
            options.find((o) => o.kind === "allow_always") ||
            options.find((o) => o.kind === "allow_once");

          if (allowOption) {
            client.respondPermission(id, {
              outcome: { outcome: "selected", optionId: allowOption.optionId },
            });
          } else {
            // No allow option available - cancel
            client.respondPermission(id, { outcome: { outcome: "cancelled" } });
          }
        } else {
          // TODO: Implement permission prompting
          client.respondPermission(id, { outcome: { outcome: "cancelled" } });
        }
        break;
      }

      case "file/read": {
        const p = params as ReadTextFileRequest;
        const content = await fs.readFile(p.path, "utf-8");
        client.respondReadTextFile(id, { content });
        break;
      }

      case "file/write": {
        const p = params as WriteTextFileRequest;
        await fs.mkdir(path.dirname(p.path), { recursive: true });
        await fs.writeFile(p.path, p.content, "utf-8");
        client.respondWriteTextFile(id, {});
        break;
      }

      case "terminal/run": {
        // Custom method (not part of ACP spec - ACP uses createTerminal instead)
        // TODO: Consider migrating to standard ACP terminal methods
        const p = params as {
          command: string;
          cwd?: string;
          timeout?: number;
        };
        const command = p.command;
        const cwd = p.cwd || process.cwd();
        const timeout = p.timeout || 60000;

        const result = await new Promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>((resolve) => {
          const child = spawn(command, [], {
            cwd,
            shell: true,
            timeout,
          });

          let stdout = "";
          let stderr = "";

          child.stdout?.on("data", (data) => {
            stdout += data.toString();
          });

          child.stderr?.on("data", (data) => {
            stderr += data.toString();
          });

          child.on("close", (code) => {
            resolve({ stdout, stderr, exitCode: code ?? 1 });
          });

          child.on("error", (err) => {
            resolve({ stdout, stderr: err.message, exitCode: 1 });
          });
        });

        // Using generic respond() since this is a custom method
        client.respond(id, result);
        break;
      }

      default:
        // Unknown method - return error
        client.respondError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    client.respondError(id, -32000, message);
  }
}

// ─── Subagent Support ─────────────────────────────────────────────────────────

/**
 * Build context for a PR review subagent.
 * AC: @ralph-subagent-spawning ac-10
 */
async function buildSubagentContext(
  ctx: KspecContext,
  taskRef: string,
): Promise<SubagentContext> {
  // Load all tasks and items
  const tasks = await loadAllTasks(ctx);
  const items = await loadAllItems(ctx);
  const index = new ReferenceIndex(tasks, items);

  // Resolve task reference
  const taskResult = index.resolve(taskRef);
  if (!taskResult.ok) {
    throw new Error(`Task not found: ${taskRef}`);
  }

  const task = tasks.find((t) => t._ulid === taskResult.ulid);
  if (!task) {
    throw new Error(`Task not found by ULID: ${taskResult.ulid}`);
  }

  // Get linked spec with ACs if spec_ref exists
  let specWithACs: Record<string, unknown> | null = null;
  if (task.spec_ref) {
    const specResult = index.resolve(task.spec_ref);
    if (specResult.ok) {
      const item = items.find((i) => i._ulid === specResult.ulid);
      if (item) {
        specWithACs = item as unknown as Record<string, unknown>;
      }
    }
  }

  // Get git branch
  const gitBranch = getCurrentBranch(ctx.rootDir) || "unknown";

  return {
    taskRef,
    taskDetails: task as unknown as Record<string, unknown>,
    specWithACs,
    gitBranch,
  };
}

/**
 * Check if a task was completed by the subagent.
 * AC: @ralph-subagent-spawning ac-12
 */
async function verifyTaskCompleted(taskRef: string): Promise<boolean> {
  const result = spawnSync("kspec", ["task", "get", taskRef, "--json"], {
    encoding: "utf-8",
    stdio: "pipe",
  });

  if (result.status !== 0) {
    warn(`Failed to check task status for ${taskRef}: ${result.stderr}`);
    return false;
  }

  try {
    const task = JSON.parse(result.stdout);
    return task.status === "completed";
  } catch {
    warn(`Failed to parse task status for ${taskRef}`);
    return false;
  }
}

/**
 * Mark a task as needing review due to subagent timeout.
 * AC: @ralph-subagent-spawning ac-9
 */
async function markTaskNeedsReview(
  taskRef: string,
  reason: string,
): Promise<void> {
  const { spawnSync } = await import("node:child_process");

  // Use kspec CLI to set automation status
  const result = spawnSync(
    "kspec",
    ["task", "set-automation", taskRef, "needs_review"],
    {
      encoding: "utf-8",
      stdio: "pipe",
    },
  );

  if (result.status !== 0) {
    warn(`Failed to mark task ${taskRef} as needs_review: ${result.stderr}`);
  }

  // Add a note explaining the timeout
  const noteResult = spawnSync(
    "kspec",
    ["task", "note", taskRef, `[RALPH SUBAGENT] ${reason}`],
    {
      encoding: "utf-8",
      stdio: "pipe",
    },
  );

  if (noteResult.status !== 0) {
    warn(`Failed to add timeout note to task ${taskRef}: ${noteResult.stderr}`);
  }
}

/**
 * Handle failed iteration by tracking per-task failures and escalating at threshold.
 * AC: @loop-mode-error-handling ac-1, ac-2, ac-3, ac-4, ac-5, ac-8
 */
async function handleIterationFailure(
  ctx: KspecContext,
  tasksInProgressAtStart: ActiveTaskSummary[],
  iterationStartTime: Date,
  errorDescription: string,
): Promise<void> {
  if (tasksInProgressAtStart.length === 0) {
    return;
  }

  // Re-load current tasks to check progress
  const currentTasks = await loadAllTasks(ctx);
  const index = new ReferenceIndex(currentTasks, await loadAllItems(ctx));

  // Convert ActiveTaskSummary to Task-like objects for processing
  const tasksInProgressFull = tasksInProgressAtStart
    .map((summary) => {
      const resolved = index.resolve(summary.ref);
      if (!resolved.ok) return undefined;
      // Check if the resolved item is a task (not a spec item or meta item)
      const item = resolved.item;
      if (!("status" in item)) return undefined; // Spec items don't have status
      return currentTasks.find((t) => t._ulid === resolved.ulid);
    })
    .filter((t): t is LoadedTask => t !== undefined && t.status === "in_progress");

  if (tasksInProgressFull.length === 0) {
    return;
  }

  // Process failures
  const { processFailedIteration, createFailureNote, getTaskFailureCount } = await import("../../ralph/index.js");

  const results = processFailedIteration(
    tasksInProgressFull,
    currentTasks,
    iterationStartTime,
    errorDescription,
  );

  // Add notes and escalate tasks
  for (const result of results) {
    const taskRef = result.taskRef;
    const task = currentTasks.find((t) => t._ulid === taskRef);
    if (!task) continue;

    const priorCount = result.failureCount - 1;
    const noteContent = createFailureNote(taskRef, errorDescription, priorCount);

    // Add LOOP-FAIL note
    const noteResult = spawnSync(
      "kspec",
      ["task", "note", `@${taskRef}`, noteContent],
      {
        encoding: "utf-8",
        stdio: "pipe",
        cwd: process.cwd(),
      },
    );

    if (noteResult.status !== 0) {
      warn(`Failed to add failure note to task ${taskRef}: ${noteResult.stderr}`);
      continue;
    }

    // AC: @loop-mode-error-handling ac-5 - Escalate at threshold
    if (result.escalated) {
      const escalateResult = spawnSync(
        "kspec",
        [
          "task",
          "set",
          `@${taskRef}`,
          "--automation",
          "needs_review",
          "--reason",
          `Loop mode: 3 consecutive failures without progress`,
        ],
        {
          encoding: "utf-8",
          stdio: "pipe",
          cwd: process.cwd(),
        },
      );

      if (escalateResult.status !== 0) {
        warn(`Failed to escalate task ${taskRef}: ${escalateResult.stderr}`);
      } else {
        info(`Escalated task ${taskRef} to automation:needs_review after 3 failures`);
      }
    }
  }
}

/**
 * Process pending_review tasks by spawning subagents.
 * AC: @ralph-subagent-spawning ac-6, ac-8
 */
async function processPendingReviewTasks(
  ctx: KspecContext,
  adapter: AgentAdapter,
  pendingReviewTasks: ActiveTaskSummary[],
  options: {
    yolo: boolean;
    maxRetries: number;
    maxFailures: number;
    cwd: string;
  },
  consecutiveFailures: { count: number },
): Promise<boolean> {
  if (pendingReviewTasks.length === 0) {
    return true;
  }

  info(
    `${DEFAULT_SUBAGENT_PREFIX} Found ${pendingReviewTasks.length} pending_review task(s)`,
  );

  // AC: @ralph-subagent-spawning ac-6 - Process one at a time
  for (const task of pendingReviewTasks) {
    info(`${DEFAULT_SUBAGENT_PREFIX} Processing: ${task.ref} - ${task.title}`);

    try {
      // Build context for this task
      const subagentCtx = await buildSubagentContext(ctx, task.ref);

      // AC: @ralph-subagent-spawning ac-1, ac-3 - Spawn and wait
      const result = await runSubagent(
        adapter,
        subagentCtx,
        {
          timeout: DEFAULT_SUBAGENT_TIMEOUT,
          outputPrefix: DEFAULT_SUBAGENT_PREFIX,
        },
        {
          yolo: options.yolo,
          cwd: options.cwd,
          handleRequest: (client, reqId, method, params) =>
            handleRequest(client, reqId, method, params, options.yolo),
        },
      );

      if (result.timedOut) {
        // AC: @ralph-subagent-spawning ac-9
        warn(
          `${DEFAULT_SUBAGENT_PREFIX} Subagent timed out for ${task.ref}`,
        );
        await markTaskNeedsReview(
          task.ref,
          "Subagent timed out after 10 minutes",
        );
        consecutiveFailures.count++;
      } else if (!result.success) {
        // AC: @ralph-subagent-spawning ac-7
        error(
          `${DEFAULT_SUBAGENT_PREFIX} Subagent failed for ${task.ref}: ${result.error}`,
        );
        consecutiveFailures.count++;
      } else {
        // AC: @ralph-subagent-spawning ac-12 - Verify task was completed
        const wasCompleted = await verifyTaskCompleted(task.ref);
        if (wasCompleted) {
          success(`${DEFAULT_SUBAGENT_PREFIX} Completed: ${task.ref}`);
          consecutiveFailures.count = 0;
        } else {
          // Task wasn't completed - subagent likely exited early
          warn(
            `${DEFAULT_SUBAGENT_PREFIX} Subagent succeeded but task ${task.ref} is still pending_review`,
          );
          await markTaskNeedsReview(
            task.ref,
            "Subagent merged PR but did not complete the task. Review required to verify merge and complete task manually.",
          );
          consecutiveFailures.count++;
        }
      }

      // Check if we've hit max failures
      if (consecutiveFailures.count >= options.maxFailures) {
        error(
          `${DEFAULT_SUBAGENT_PREFIX} Reached max failures (${options.maxFailures})`,
        );
        return false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(`${DEFAULT_SUBAGENT_PREFIX} Error processing ${task.ref}: ${message}`);
      consecutiveFailures.count++;

      if (consecutiveFailures.count >= options.maxFailures) {
        error(
          `${DEFAULT_SUBAGENT_PREFIX} Reached max failures (${options.maxFailures})`,
        );
        return false;
      }
    }
  }

  return true;
}

// ─── Command Registration ────────────────────────────────────────────────────

export function registerRalphCommand(program: Command): void {
  program
    .command("ralph")
    .description("Run ACP agent in a loop to process ready tasks")
    .option("--max-loops <n>", "Maximum iterations", "5")
    .option("--max-retries <n>", "Max retries per iteration on error", "3")
    .option(
      "--max-failures <n>",
      "Max consecutive failed iterations before exit",
      "3",
    )
    .option("--dry-run", "Show prompt without executing")
    .option("--yolo", "Use dangerously-skip-permissions (default)", true)
    .option("--no-yolo", "Require normal permission prompts")
    .option("--adapter <id>", "Agent adapter to use", "claude-code-acp")
    .option("--adapter-cmd <cmd>", "Custom adapter command (for testing)")
    .option(
      "--restart-every <n>",
      "Restart agent every N iterations to prevent OOM (0 = never)",
      "10",
    )
    .option(
      "--focus <instructions>",
      "Focus instructions included in every iteration prompt",
    )
    .option(
      "--max-tasks <n>",
      "Max tasks per iteration (0 = unlimited)",
      "1",
    )
    .action(async (options) => {
      try {
        const maxLoops = parseInt(options.maxLoops, 10);
        const maxRetries = parseInt(options.maxRetries, 10);
        const maxFailures = parseInt(options.maxFailures, 10);

        if (Number.isNaN(maxLoops) || maxLoops < 1) {
          error(errors.usage.maxLoopsPositive);
          process.exit(EXIT_CODES.ERROR);
        }

        if (Number.isNaN(maxRetries) || maxRetries < 0) {
          error(errors.usage.maxRetriesNonNegative);
          process.exit(EXIT_CODES.ERROR);
        }

        if (Number.isNaN(maxFailures) || maxFailures < 1) {
          error(errors.usage.maxFailuresPositive);
          process.exit(EXIT_CODES.ERROR);
        }

        const restartEvery = parseInt(options.restartEvery, 10);
        if (Number.isNaN(restartEvery) || restartEvery < 0) {
          error("--restart-every must be a non-negative integer");
          process.exit(EXIT_CODES.ERROR);
        }

        // AC: @ralph-task-limit ac-flag
        const maxTasks = parseInt(options.maxTasks, 10);
        if (Number.isNaN(maxTasks) || maxTasks < 0 || maxTasks > 999) {
          error("--max-tasks must be 0 (unlimited) or a positive integer up to 999");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // Handle custom adapter command for testing
        if (options.adapterCmd) {
          const parts = options.adapterCmd.split(/\s+/);
          const customAdapter: AgentAdapter = {
            command: parts[0],
            args: parts.slice(1),
            description: "Custom adapter via --adapter-cmd",
          };
          registerAdapter("custom", customAdapter);
          options.adapter = "custom";
        }

        // Resolve adapter
        const adapter = resolveAdapter(options.adapter);

        // Validate adapter package exists before proceeding
        // Skip validation for:
        // - Custom adapters (--adapter-cmd)
        // - Non-npx adapters
        // - Dry-run mode with default adapter (doesn't spawn agent, default may not be installed in CI)
        // Note: If user explicitly specifies --adapter, validate even in dry-run to catch typos
        const isDefaultAdapter = options.adapter === "claude-code-acp";
        const skipValidation =
          options.adapterCmd ||
          adapter.command !== "npx" ||
          !adapter.args[0] ||
          (options.dryRun && isDefaultAdapter);

        if (!skipValidation) {
          validateAdapter(adapter.args[0]);
        }

        // Add yolo flag to adapter args if needed
        if (options.yolo && options.adapter === "claude-code-acp") {
          adapter.args = [...adapter.args, "--dangerously-skip-permissions"];
        }

        const restartInfo =
          restartEvery > 0 ? `, restart every ${restartEvery}` : "";
        const maxTasksInfo =
          maxTasks === 0 ? "unlimited" : `${maxTasks}`;
        info(
          `Starting ralph loop (adapter=${options.adapter}, max ${maxLoops} iterations, ${maxRetries} retries, ${maxFailures} max failures${restartInfo}, max-tasks=${maxTasksInfo})`,
        );
        if (options.focus) {
          info(`Focus: ${options.focus}`);
        }

        // Initialize kspec context
        const ctx = await initContext();
        const specDir = ctx.specDir;

        // Create session for event tracking
        const sessionId = ulid();
        await createSession(specDir, {
          id: sessionId,
          agent_type: options.adapter,
          task_id: undefined, // Will be determined per iteration
        });

        // Log session start
        await appendEvent(specDir, {
          session_id: sessionId,
          type: "session.start",
          data: {
            adapter: options.adapter,
            maxLoops,
            maxRetries,
            maxFailures,
            maxTasks,
            yolo: options.yolo,
            focus: options.focus,
          },
        });

        let consecutiveFailures = 0;
        let agent: SpawnedAgent | null = null;
        let acpSessionId: string | null = null;

        // Create translator and renderer for this session
        const translator = createTranslator();
        const renderer = createCliRenderer();

        // Task limit state - tracks completions per iteration
        // AC: @ralph-task-limit ac-reset, ac-wrapup
        let taskLimitReached = false;
        let tasksCompletedThisIteration = 0;

        try {
          for (let iteration = 1; iteration <= maxLoops; iteration++) {
            renderer.newSection?.(`Iteration ${iteration}/${maxLoops}`);

            // AC: @ralph-task-limit ac-reset - Reset counter and clear stale markers at iteration start
            taskLimitReached = false;
            tasksCompletedThisIteration = 0;
            const wasStale = await clearStaleMarker(ctx.rootDir);
            if (wasStale) {
              info("Cleared stale task limit marker from previous session");
            }
            // Also clear any marker from previous iteration of this session
            await clearTaskLimitMarker(ctx.rootDir);

            // Gather fresh context each iteration (only automation-eligible tasks)
            // AC: @cli-ralph ac-16
            const sessionCtx = await gatherSessionContext(ctx, {
              limit: "10",
              eligible: true,
            });

            // AC: @ralph-subagent-spawning ac-8 - Process pending_review tasks BEFORE main iteration
            // This wraps consecutiveFailures in an object so it can be mutated by the helper
            const failureTracker = { count: consecutiveFailures };
            const continueLoop = await processPendingReviewTasks(
              ctx,
              adapter,
              sessionCtx.pending_review_tasks,
              {
                yolo: options.yolo,
                maxRetries,
                maxFailures,
                cwd: process.cwd(),
              },
              failureTracker,
            );
            consecutiveFailures = failureTracker.count;

            if (!continueLoop) {
              break;
            }

            // Check for automation-eligible tasks (ready or in_progress)
            // AC: @cli-ralph ac-19
            const hasActiveTasks = sessionCtx.active_tasks.length > 0;
            const hasReadyTasks = sessionCtx.ready_tasks.length > 0;

            if (!hasActiveTasks && !hasReadyTasks) {
              info("No automation-eligible tasks (ready or in_progress). Exiting loop.");
              break;
            }

            // AC: @loop-mode-error-handling - Track tasks in progress for failure handling
            const tasksInProgressAtStart = sessionCtx.active_tasks;
            const iterationStartTime = new Date();

            // Build prompts - task-work first, then reflect
            const taskWorkPrompt = buildTaskWorkPrompt(
              sessionCtx,
              iteration,
              maxLoops,
              sessionId,
              options.focus,
            );
            const reflectPrompt = buildReflectPrompt(
              iteration,
              maxLoops,
              sessionId,
            );

            // AC: @ralph-task-limit ac-dryrun
            if (options.dryRun) {
              console.log(
                chalk.yellow("=== DRY RUN - Configuration ===\n"),
              );
              console.log(`  max-loops: ${maxLoops}`);
              console.log(`  max-tasks: ${maxTasks === 0 ? "unlimited" : maxTasks}`);
              console.log(`  max-retries: ${maxRetries}`);
              console.log(`  max-failures: ${maxFailures}`);
              console.log(`  restart-every: ${restartEvery === 0 ? "never" : restartEvery}`);
              console.log(
                chalk.yellow("\n=== Task Work Prompt ===\n"),
              );
              console.log(taskWorkPrompt);
              console.log(chalk.yellow("\n=== Reflect Prompt ===\n"));
              console.log(reflectPrompt);
              console.log(chalk.yellow("\n=== END DRY RUN ==="));
              break;
            }

            // Log task-work prompt
            await appendEvent(specDir, {
              session_id: sessionId,
              type: "prompt.sent",
              data: {
                iteration,
                phase: "task-work",
                prompt: taskWorkPrompt,
                tasks: {
                  active: sessionCtx.active_tasks.map((t) => t.ref),
                  ready: sessionCtx.ready_tasks.map((t) => t.ref),
                },
              },
            });

            // Retry loop for this iteration
            let lastError: Error | null = null;
            let succeeded = false;

            for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
              if (attempt > 1) {
                console.log(
                  chalk.yellow(
                    `\nRetry attempt ${attempt - 1}/${maxRetries}...`,
                  ),
                );
              }

              try {
                // Spawn agent if not already running
                if (!agent) {
                  info("Spawning ACP agent...");
                  agent = await spawnAndInitialize(adapter, {
                    cwd: process.cwd(),
                    clientOptions: {
                      clientInfo: {
                        name: "kspec-ralph",
                        version: packageVersion,
                      },
                    },
                  });

                  // Set up streaming update handler with translator + renderer
                  agent.client.on(
                    "update",
                    (_sid: string, update: SessionUpdate) => {
                      // Translate ACP event to RalphEvent and render
                      const event = translator.translate(update);
                      if (event) {
                        renderer.render(event);
                      }

                      // AC: @ralph-task-limit ac-detection, ac-wrapup
                      // Detect task completions for limit enforcement
                      if (maxTasks > 0 && !taskLimitReached) {
                        const bashCmd = extractBashCommand(update);
                        if (bashCmd && detectTaskCompleteCommand(bashCmd)) {
                          // Pattern matched - verify via kspec query
                          getIterationStats(ctx, iterationStartTime)
                            .then(async (stats) => {
                              if (stats.tasks_completed >= maxTasks && !taskLimitReached) {
                                taskLimitReached = true;
                                tasksCompletedThisIteration = stats.tasks_completed;
                                info(`Task limit reached (${stats.tasks_completed}/${maxTasks})`);

                                // AC: @ralph-task-limit ac-marker-format, ac-wrapup
                                // Write marker file for hook enforcement
                                const marker: TaskLimitMarker = {
                                  active: true,
                                  since: iterationStartTime.toISOString(),
                                  max: maxTasks,
                                  completed: stats.tasks_completed,
                                  sessionId,
                                };
                                await writeTaskLimitMarker(ctx.rootDir, marker);

                                // Inject wrap-up message to agent
                                if (agent && acpSessionId) {
                                  const wrapUpMsg = `\n\n**TASK LIMIT REACHED** - ${stats.tasks_completed} task(s) completed this iteration (limit: ${maxTasks}).\n\nPlease wrap up your current work and exit cleanly. Do not start new tasks.\n\nCompleted tasks this iteration: ${stats.completed_refs.join(", ")}`;
                                  agent.client.prompt({
                                    sessionId: acpSessionId,
                                    prompt: [{ type: "text", text: wrapUpMsg }],
                                  }).catch(() => {
                                    // Ignore if message injection fails
                                  });
                                }
                              }
                            })
                            .catch(() => {
                              // Ignore query failures - detection is best-effort
                            });
                        }
                      }

                      // Log raw update event (async, non-blocking)
                      appendEvent(specDir, {
                        session_id: sessionId,
                        type: "session.update",
                        data: { iteration, update },
                      }).catch(() => {
                        // Ignore logging errors during streaming
                      });
                    },
                  );

                  // Set up tool request handler
                  agent.client.on(
                    "request",
                    (
                      reqId: string | number,
                      method: string,
                      params: unknown,
                    ) => {
                      // biome-ignore lint/style/noNonNullAssertion: agent is guaranteed to exist when callback is registered
                      handleRequest(
                        agent!.client,
                        reqId,
                        method,
                        params,
                        options.yolo,
                      ).catch((err) => {
                        // biome-ignore lint/style/noNonNullAssertion: agent is guaranteed to exist when callback is registered
                        agent!.client.respondError(reqId, -32000, err.message);
                      });
                    },
                  );
                }

                // Create fresh ACP session per iteration to keep context clean
                info("Creating ACP session...");
                acpSessionId = await agent.client.newSession({
                  cwd: process.cwd(),
                  mcpServers: [], // No MCP servers for now
                });

                // Phase 1: Task Work
                info("Sending task-work prompt to agent...");
                const taskWorkResponse = await agent.client.prompt({
                  sessionId: acpSessionId!,
                  prompt: [{ type: "text", text: taskWorkPrompt }],
                });

                // Log task-work completion
                await appendEvent(specDir, {
                  session_id: sessionId,
                  type: "session.update",
                  data: {
                    iteration,
                    phase: "task-work",
                    stopReason: taskWorkResponse.stopReason,
                    completed: true,
                  },
                });

                if (taskWorkResponse.stopReason === "cancelled") {
                  throw new Error(errors.usage.agentPromptCancelled);
                }

                // Phase 2: Reflect (always sent after task-work completes)
                info("Sending reflect prompt to agent...");
                await appendEvent(specDir, {
                  session_id: sessionId,
                  type: "prompt.sent",
                  data: {
                    iteration,
                    phase: "reflect",
                    prompt: reflectPrompt,
                  },
                });

                const reflectResponse = await agent.client.prompt({
                  sessionId: acpSessionId!,
                  prompt: [{ type: "text", text: reflectPrompt }],
                });

                // Log reflect completion
                await appendEvent(specDir, {
                  session_id: sessionId,
                  type: "session.update",
                  data: {
                    iteration,
                    phase: "reflect",
                    stopReason: reflectResponse.stopReason,
                    completed: true,
                  },
                });

                if (reflectResponse.stopReason === "cancelled") {
                  throw new Error(errors.usage.agentPromptCancelled);
                }

                succeeded = true;
                break;
              } catch (err) {
                lastError = err as Error;
                error(errors.failures.iterationFailed(lastError.message));

                // Clean up agent on error - will respawn next attempt
                if (agent) {
                  agent.kill();
                  agent = null;
                  acpSessionId = null;
                }
              }
            }

            if (succeeded) {
              console.log(); // Newline after streaming output

              // Save session context snapshot for audit trail
              await saveSessionContext(
                specDir,
                sessionId,
                iteration,
                sessionCtx,
              );

              success(`Completed iteration ${iteration}`);
              consecutiveFailures = 0;

              // Periodic agent restart to prevent OOM
              // AC: @cli-ralph ac-restart-periodic
              if (
                restartEvery > 0 &&
                iteration % restartEvery === 0 &&
                iteration < maxLoops
              ) {
                info(
                  `Restarting agent to prevent memory buildup (every ${restartEvery} iterations)...`,
                );
                if (agent) {
                  agent.kill();
                  agent = null;
                  acpSessionId = null;
                }
              }
            } else {
              consecutiveFailures++;
              error(
                errors.failures.iterationFailedAfterRetries(
                  iteration,
                  maxRetries,
                  consecutiveFailures,
                  maxFailures,
                ),
              );
              if (lastError) {
                error(errors.failures.lastError(lastError.message));
              }

              // AC: @loop-mode-error-handling - Track per-task failures
              const errorDesc = lastError?.message || "Iteration failed after retries";
              await handleIterationFailure(
                ctx,
                tasksInProgressAtStart,
                iterationStartTime,
                errorDesc,
              );

              if (consecutiveFailures >= maxFailures) {
                error(errors.failures.reachedMaxFailures(maxFailures));
                break;
              }

              info("Continuing to next iteration...");
            }
          }
        } finally {
          // Clean up agent
          if (agent) {
            agent.kill();
          }

          // AC: @ralph-task-limit ac-reset - Clear marker file when session ends
          await clearTaskLimitMarker(ctx.rootDir);

          // Log session end
          const status =
            consecutiveFailures >= maxFailures ? "abandoned" : "completed";
          await appendEvent(specDir, {
            session_id: sessionId,
            type: "session.end",
            data: {
              status,
              consecutiveFailures,
            },
          });
          await updateSessionStatus(specDir, sessionId, status);
        }

        console.log(chalk.green(`\n${"─".repeat(60)}`));
        success("Ralph loop completed");
        console.log(chalk.green(`${"─".repeat(60)}\n`));
      } catch (err) {
        error(errors.failures.ralphLoop, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
