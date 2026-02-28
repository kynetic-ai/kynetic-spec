/**
 * Ralph command - automated task loop via ACP.
 *
 * Runs an ACP-compliant agent in a loop to process tasks autonomously.
 * Uses session event storage for full audit trail and streaming output.
 */

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
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
  loadMetaContext,
  type LoadedSkill,
  loadAllTasks,
  type LoadedTask,
  ReferenceIndex,
} from "../../parser/index.js";
import { resolveSkillReferenceTokensForPlatform } from "../../parser/skill-render.js";
import {
  buildWrapUpContext,
  createCliRenderer,
  createTranslator,
  DEFAULT_SUBAGENT_PREFIX,
  DEFAULT_WRAPUP_TIMEOUT,
  type ExitReason,
  RALPH_PROMPT_TIMEOUT,
  runSubagent,
  runWrapUpAgent,
  type SubagentContext,
  WRAPUP_AGENT_PREFIX,
} from "../../ralph/index.js";
import {
  appendEvent,
  closeSession,
  createSessionWithBudget,
  getSessionBudgetPath,
  getSessionDir,
  injectEnvForAdapter,
  isEndLoopRequested,
  removeEnvForAdapter,
  requestEndLoop,
  resetBudget,
  saveSessionContext,
} from "../../sessions/index.js";
import { errors } from "../../strings/index.js";
import { getCurrentBranch } from "../../utils/git.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, success, warn } from "../output.js";
import {
  gatherSessionContext,
  type ActiveTaskSummary,
  type SessionStartContext,
} from "./session.js";


// ─── Explicit Task Scope ─────────────────────────────────────────────────────

/**
 * Parsed explicit task scope for --tasks flag.
 * AC: @cli-ralph ac-21
 */
interface ExplicitTaskScope {
  /** Original refs as provided by user */
  refs: string[];
  /** Resolved ULIDs for the tasks */
  ulids: string[];
}

/**
 * Parse and validate --tasks flag value.
 * Returns resolved ULIDs for the specified task refs.
 * AC: @cli-ralph ac-21
 *
 * @throws Error if any ref cannot be resolved or is not a task
 */
async function parseExplicitTasks(
  ctx: KspecContext,
  tasksArg: string,
): Promise<ExplicitTaskScope> {
  const refs = tasksArg.split(",").map((r) => r.trim()).filter(Boolean);

  if (refs.length === 0) {
    throw new Error("--tasks requires at least one task reference");
  }

  // Load tasks and items for resolution
  const tasks = await loadAllTasks(ctx);
  const items = await loadAllItems(ctx);
  const index = new ReferenceIndex(tasks, items);

  const ulids: string[] = [];

  for (const ref of refs) {
    const result = index.resolve(ref);
    if (!result.ok) {
      throw new Error(`Cannot resolve task reference: ${ref}`);
    }

    // Verify it's a task (not a spec item)
    const task = tasks.find((t) => t._ulid === result.ulid);
    if (!task) {
      throw new Error(`Reference ${ref} is not a task`);
    }

    ulids.push(result.ulid);
  }

  return { refs, ulids };
}

/**
 * Filter session context to only include tasks from explicit scope.
 * AC: @cli-ralph ac-21
 */
function filterByExplicitTasks(
  ctx: SessionStartContext,
  scope: ExplicitTaskScope,
): SessionStartContext {
  // Task refs in context are short ULIDs (variable length from shortUlid())
  // Check if the context ref is a prefix of any explicit ULID
  const matchesScope = (taskRef: string) => {
    return scope.ulids.some((ulid) => ulid.startsWith(taskRef));
  };

  return {
    ...ctx,
    active_tasks: ctx.active_tasks.filter((t) => matchesScope(t.ref)),
    pending_review_tasks: ctx.pending_review_tasks.filter((t) => matchesScope(t.ref)),
    ready_tasks: ctx.ready_tasks.filter((t) => matchesScope(t.ref)),
  };
}

/**
 * Check if all explicit tasks are completed or blocked.
 * AC: @cli-ralph ac-21
 */
async function allExplicitTasksDone(
  ctx: KspecContext,
  scope: ExplicitTaskScope,
): Promise<{ done: boolean; statuses: Map<string, string> }> {
  const tasks = await loadAllTasks(ctx);
  const statuses = new Map<string, string>();

  for (const ulid of scope.ulids) {
    const task = tasks.find((t) => t._ulid === ulid);
    if (task) {
      statuses.set(ulid.slice(0, 8), task.status);
    }
  }

  // Check if all are completed or blocked
  const done = scope.ulids.every((ulid) => {
    const status = statuses.get(ulid.slice(0, 8));
    return status === "completed" || status === "blocked";
  });

  return { done, statuses };
}

// ─── Prompt Template ─────────────────────────────────────────────────────────

type RalphPromptPlatform = "claude-code" | "codex" | "unknown";

type SkillOrigin = LoadedSkill["origin"];

const FALLBACK_CORE_SKILLS = new Set(["task-work", "reflect", "review"]);
const ADAPTER_VALIDATION_PROBES = [["--help"], ["--version"]];
const TERMINAL_PREVIEW_MAX_BYTES = 64 * 1024;
const TOOL_OUTPUT_DIR = "tool-output";

/**
 * Map adapter IDs to prompt rendering platforms.
 */
export function getPromptPlatformForAdapter(adapterId: string): RalphPromptPlatform {
  switch (adapterId) {
    case "claude-agent-acp":
    case "claude-code-acp":
      return "claude-code";
    case "codex-acp":
      return "codex";
    default:
      return "unknown";
  }
}

/**
 * Build skill origin map from meta skills.
 */
async function loadSkillOriginsForRalph(ctx: KspecContext): Promise<Map<string, SkillOrigin>> {
  const meta = await loadMetaContext(ctx);
  const origins = new Map<string, SkillOrigin>();
  for (const skill of meta.skills) {
    origins.set(skill.id, skill.origin);
  }
  // Fallback for core skills frequently used by ralph, even if core skills
  // were not loaded into project meta for any reason.
  for (const coreSkill of FALLBACK_CORE_SKILLS) {
    if (!origins.has(coreSkill)) {
      origins.set(coreSkill, "core");
    }
  }
  return origins;
}

/**
 * Normalize legacy literal invocation syntax for a target platform.
 * Keeps backward compatibility for existing slash-style config values.
 */
function normalizeLegacyInvocation(
  invocation: string,
  platform: RalphPromptPlatform,
): string {
  if (platform === "codex") {
    if (/^\/kspec:([a-z0-9][a-z0-9-]*)$/.test(invocation)) {
      return invocation.replace(
        /^\/kspec:([a-z0-9][a-z0-9-]*)$/,
        (_m, skillId: string) => `$kspec-${skillId}`,
      );
    }
    if (/^\/([a-z0-9][a-z0-9-]*)$/.test(invocation)) {
      return invocation.replace(
        /^\/([a-z0-9][a-z0-9-]*)$/,
        (_m, skillId: string) => `$${skillId}`,
      );
    }
  }

  if (platform === "claude-code") {
    if (/^\$kspec-([a-z0-9][a-z0-9-]*)$/.test(invocation)) {
      return invocation.replace(
        /^\$kspec-([a-z0-9][a-z0-9-]*)$/,
        (_m, skillId: string) => `/kspec:${skillId}`,
      );
    }
    if (/^\$([a-z0-9][a-z0-9-]*)$/.test(invocation)) {
      return invocation.replace(
        /^\$([a-z0-9][a-z0-9-]*)$/,
        (_m, skillId: string) => `/${skillId}`,
      );
    }
  }

  return invocation;
}

/**
 * Resolve configured skill invocation string for a specific platform.
 * Supports portable {skill:<id>} syntax and legacy literal strings.
 */
export function resolveRalphSkillInvocation(
  invocation: string,
  platform: RalphPromptPlatform,
  skillOrigins: Map<string, SkillOrigin>,
): string {
  if (platform === "unknown") {
    return invocation;
  }

  const tokenResolved = resolveSkillReferenceTokensForPlatform(
    invocation,
    platform,
    skillOrigins,
  );
  if (tokenResolved !== invocation) {
    return tokenResolved;
  }

  return normalizeLegacyInvocation(invocation, platform);
}

// AC: @ralph-skill-delegation ac-1, ac-2, ac-3
function buildTaskWorkPrompt(
  sessionCtx: SessionStartContext,
  iteration: number,
  maxLoops: number,
  sessionId: string,
  skillTaskWork: string,
  focus?: string,
  explicitTaskScope?: ExplicitTaskScope,
): string {
  const focusSection = focus
    ? `
## Session Focus (applies to ALL iterations)

> **${focus}**

Keep this focus in mind throughout your work. It takes priority over default task selection.
`
    : "";

  // AC: @cli-ralph ac-21 - Explicit task scope indicator in prompt
  const taskScopeSection = explicitTaskScope
    ? `
## Explicit Task Scope

This session is scoped to specific tasks: ${explicitTaskScope.refs.join(", ")}

**Only work on these tasks.** The loop will exit when all listed tasks are completed or blocked.
`
    : "";

  const modeDescription = explicitTaskScope
    ? "Loop mode means: no confirmations, auto-resolve decisions, explicit task scope (only the listed tasks)."
    : "Loop mode means: no confirmations, auto-resolve decisions, automation-eligible tasks only.";

  return `# Kspec Automation Session - Task Work

**Session ID:** \`${sessionId}\`
**Iteration:** ${iteration} of ${maxLoops}
**Mode:** Automated (no human in the loop)
${focusSection}${taskScopeSection}

## Current State
\`\`\`json
${JSON.stringify(sessionCtx, null, 2)}
\`\`\`

## Instructions

Run the task-work skill in loop mode:

\`\`\`
${skillTaskWork} loop
\`\`\`

${modeDescription}

**Normal flow:** Work on a task, create a PR, then stop responding. Ralph continues automatically —
it checks for remaining eligible tasks at the start of each iteration and exits the loop itself when none remain.

**Do NOT call \`end-loop\` after completing a task.** Simply stop responding.
\`end-loop\` is a rare escape hatch for when work is stalling across multiple iterations with no progress — not a normal exit path.
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
  skillReflect: string,
): string {
  const isFinal = iteration === maxLoops;

  return `# Kspec Automation Session - Reflection

**Session ID:** \`${sessionId}\`
**Iteration:** ${iteration} of ${maxLoops}
**Phase:** Post-task reflection

## Instructions

Run the reflect skill in loop mode:

\`\`\`
${skillReflect} loop
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
type AdapterValidationRunner = (
  command: string,
  args: string[],
  options: { encoding: "utf-8"; stdio: "pipe" },
) => { status: number | null };

/**
 * Check whether an adapter package appears to be installed and executable.
 * Uses multiple non-installing probes because CLIs differ on supported flags.
 */
export function isAdapterPackageAvailable(
  adapterPackage: string,
  runner: AdapterValidationRunner = spawnSync,
): boolean {
  for (const probeArgs of ADAPTER_VALIDATION_PROBES) {
    const result = runner(
      "npx",
      ["--no-install", adapterPackage, ...probeArgs],
      {
        encoding: "utf-8",
        stdio: "pipe",
      },
    );

    if (result.status === 0) {
      return true;
    }
  }

  return false;
}

/**
 * Validate that the specified ACP adapter package exists.
 * Uses npx --no-install probes to check both global and local node_modules.
 *
 * @throws {Error} Never throws - exits process with code 3 if validation fails
 */
function validateAdapter(adapterPackage: string, adapterId?: string): void {
  if (!isAdapterPackageAvailable(adapterPackage)) {
    const label =
      adapterId && adapterId !== adapterPackage
        ? `${adapterId} (${adapterPackage})`
        : adapterPackage;
    error(
      `Adapter not found: ${label}. Install with: npm install -g ${adapterPackage}`,
    );
    process.exit(EXIT_CODES.NOT_FOUND);
  }
}

interface HandleRequestOptions {
  yolo: boolean;
  specDir?: string;
  sessionId?: string;
}

interface TerminalRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdout_path?: string;
  stderr_path?: string;
  stdout_bytes: number;
  stderr_bytes: number;
  preview_truncated: boolean;
}

interface TerminalRunOptions {
  command: string;
  cwd: string;
  timeout: number;
  toolCallId: string | number;
  specDir?: string;
  sessionId?: string;
  previewMaxBytes?: number;
}

interface StreamCaptureState {
  bytes: number;
  previewBytes: number;
  previewParts: string[];
  truncated: boolean;
  stream?: WriteStream;
}

function sanitizeToolCallId(toolCallId: string | number): string {
  const raw = String(toolCallId).trim();
  if (!raw) {
    return "tool-call";
  }

  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function updateStreamPreview(
  state: StreamCaptureState,
  chunk: Buffer,
  maxPreviewBytes: number,
): void {
  state.bytes += chunk.length;
  const remaining = maxPreviewBytes - state.previewBytes;

  if (remaining <= 0) {
    state.truncated = true;
    return;
  }

  if (chunk.length > remaining) {
    state.previewParts.push(chunk.subarray(0, remaining).toString("utf-8"));
    state.previewBytes += remaining;
    state.truncated = true;
    return;
  }

  state.previewParts.push(chunk.toString("utf-8"));
  state.previewBytes += chunk.length;
}

function closeStream(stream?: WriteStream): Promise<void> {
  if (!stream) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      stream.off("finish", onFinish);
      reject(err);
    };
    const onFinish = () => {
      stream.off("error", onError);
      resolve();
    };

    stream.once("error", onError);
    stream.once("finish", onFinish);
    stream.end();
  });
}

/**
 * Execute terminal/run request with bounded in-memory preview and streamed
 * session artifacts for full stdout/stderr retention.
 */
export async function runTerminalCommandWithArtifacts(
  options: TerminalRunOptions,
): Promise<TerminalRunResult> {
  const previewMaxBytes = options.previewMaxBytes ?? TERMINAL_PREVIEW_MAX_BYTES;
  const shouldWriteArtifacts = Boolean(options.specDir && options.sessionId);

  let stdoutPath: string | undefined;
  let stderrPath: string | undefined;
  if (shouldWriteArtifacts) {
    const outputDir = path.join(
      getSessionDir(options.specDir!, options.sessionId!),
      TOOL_OUTPUT_DIR,
    );
    await fs.mkdir(outputDir, { recursive: true });
    const safeToolCallId = sanitizeToolCallId(options.toolCallId);
    stdoutPath = path.join(outputDir, `${safeToolCallId}.stdout.log`);
    stderrPath = path.join(outputDir, `${safeToolCallId}.stderr.log`);
  }

  const stdoutState: StreamCaptureState = {
    bytes: 0,
    previewBytes: 0,
    previewParts: [],
    truncated: false,
    stream: stdoutPath ? createWriteStream(stdoutPath) : undefined,
  };
  const stderrState: StreamCaptureState = {
    bytes: 0,
    previewBytes: 0,
    previewParts: [],
    truncated: false,
    stream: stderrPath ? createWriteStream(stderrPath) : undefined,
  };

  return await new Promise<TerminalRunResult>((resolve, reject) => {
    let settled = false;
    const child = spawn(options.command, [], {
      cwd: options.cwd,
      shell: true,
      timeout: options.timeout,
    });

    const finalize = async (
      exitCode: number,
      errorMessage?: string,
    ): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;

      if (errorMessage) {
        const errChunk = Buffer.from(errorMessage, "utf-8");
        stderrState.stream?.write(errChunk);
        updateStreamPreview(stderrState, errChunk, previewMaxBytes);
      }

      try {
        await Promise.all([
          closeStream(stdoutState.stream),
          closeStream(stderrState.stream),
        ]);
      } catch (streamErr) {
        reject(streamErr);
        return;
      }

      resolve({
        stdout: stdoutState.previewParts.join(""),
        stderr: stderrState.previewParts.join(""),
        exitCode,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        stdout_bytes: stdoutState.bytes,
        stderr_bytes: stderrState.bytes,
        preview_truncated: stdoutState.truncated || stderrState.truncated,
      });
    };

    child.stdout?.on("data", (data) => {
      const chunk = Buffer.isBuffer(data)
        ? data
        : Buffer.from(String(data), "utf-8");
      stdoutState.stream?.write(chunk);
      updateStreamPreview(stdoutState, chunk, previewMaxBytes);
    });

    child.stderr?.on("data", (data) => {
      const chunk = Buffer.isBuffer(data)
        ? data
        : Buffer.from(String(data), "utf-8");
      stderrState.stream?.write(chunk);
      updateStreamPreview(stderrState, chunk, previewMaxBytes);
    });

    child.on("close", (code) => {
      void finalize(code ?? 1);
    });

    child.on("error", (err) => {
      void finalize(1, err.message);
    });
  });
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
  options: HandleRequestOptions,
): Promise<void> {
  try {
    switch (method) {
      case "session/request_permission": {
        const p = params as RequestPermissionRequest;
        // In yolo mode, auto-approve all permissions
        // In normal mode, would need to implement permission UI
        const permissionOptions = p.options || [];

        if (options.yolo) {
          // Find an "allow" option (prefer allow_always, then allow_once)
          const allowOption =
            permissionOptions.find((o) => o.kind === "allow_always") ||
            permissionOptions.find((o) => o.kind === "allow_once");

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

        const result = await runTerminalCommandWithArtifacts({
          command,
          cwd,
          timeout,
          toolCallId: id,
          specDir: options.specDir,
          sessionId: options.sessionId,
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
 * Get the current status of a task.
 * AC: @ralph-subagent-spawning ac-12
 */
function getTaskStatus(taskRef: string): string | null {
  const result = spawnSync("kspec", ["task", "get", taskRef, "--json"], {
    encoding: "utf-8",
    stdio: "pipe",
  });

  if (result.status !== 0) {
    warn(`Failed to check task status for ${taskRef}: ${result.stderr}`);
    return null;
  }

  try {
    return JSON.parse(result.stdout).status;
  } catch {
    warn(`Failed to parse task status for ${taskRef}`);
    return null;
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
  // Use current task set CLI to mark automation status
  const result = spawnSync(
    "kspec",
    [
      "task",
      "set",
      taskRef,
      "--automation",
      "needs_review",
      "--reason",
      reason,
    ],
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
 * Post a comment on the open PR for a task's branch, noting incomplete review.
 * Uses `gh pr list --head <branch>` to find the PR and add a warning.
 */
async function commentOnPRReviewIncomplete(branch: string, reason: string): Promise<void> {
  if (!branch || branch === "unknown") {
    return;
  }

  const prListResult = spawnSync(
    "gh",
    ["pr", "list", "--state", "open", "--head", branch, "--json", "number", "--jq", ".[0].number"],
    { encoding: "utf-8", stdio: "pipe" },
  );

  const prNumber = prListResult.stdout?.trim();
  if (!prNumber || prListResult.status !== 0) {
    // No open PR found — may already be merged or branch has no PR
    return;
  }

  const body = `⚠️ **Review incomplete**: ${reason}\n\nThis PR was not fully reviewed by the ralph review subagent. Manual review recommended before merging.`;
  const commentResult = spawnSync(
    "gh",
    ["pr", "comment", prNumber, "--body", body],
    { encoding: "utf-8", stdio: "pipe" },
  );

  if (commentResult.status !== 0) {
    warn(`Failed to comment on PR #${prNumber}: ${commentResult.stderr}`);
  } else {
    info(`${DEFAULT_SUBAGENT_PREFIX} Posted review-incomplete comment on PR #${prNumber}`);
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
    specDir: string;
    sessionId: string;
    maxRetries: number;
    maxFailures: number;
    cwd: string;
    subagentTimeout: number;
    autoApproveArgs?: string[];
    prReviewSkillName: string;
  },
  consecutiveFailures: { count: number },
): Promise<boolean> {
  if (pendingReviewTasks.length === 0) {
    return true;
  }

  // Visual separator for subagent section
  console.log("");
  console.log(chalk.cyan(`${"═".repeat(60)}`));
  console.log(chalk.cyan.bold(`${DEFAULT_SUBAGENT_PREFIX} Processing Pending Review Tasks`));
  console.log(chalk.cyan(`${"═".repeat(60)}`));
  console.log("");

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
          timeout: options.subagentTimeout,
          outputPrefix: DEFAULT_SUBAGENT_PREFIX,
          skillName: options.prReviewSkillName,
        },
        {
          yolo: options.yolo,
          cwd: options.cwd,
          extraArgs: options.autoApproveArgs,
          handleRequest: (client, reqId, method, params) =>
            handleRequest(client, reqId, method, params, {
              yolo: options.yolo,
              specDir: options.specDir,
              sessionId: options.sessionId,
            }),
        },
      );

      if (result.timedOut) {
        // AC: @ralph-subagent-spawning ac-9
        warn(
          `${DEFAULT_SUBAGENT_PREFIX} Subagent timed out for ${task.ref}`,
        );
        const timeoutMinutes = Math.round(options.subagentTimeout / 60000);
        await markTaskNeedsReview(
          task.ref,
          `Subagent timed out after ${timeoutMinutes} minutes`,
        );
        await commentOnPRReviewIncomplete(subagentCtx.gitBranch, `Review subagent timed out after ${timeoutMinutes} minutes for task ${task.ref}.`);
        consecutiveFailures.count++;
      } else if (!result.success) {
        // AC: @ralph-subagent-spawning ac-7
        error(
          `${DEFAULT_SUBAGENT_PREFIX} Subagent failed for ${task.ref}: ${result.error}`,
        );
        await commentOnPRReviewIncomplete(subagentCtx.gitBranch, `Review subagent failed for task ${task.ref}: ${result.error}`);
        consecutiveFailures.count++;
      } else {
        // AC: @ralph-subagent-spawning ac-12 - Verify task outcome
        const currentStatus = getTaskStatus(task.ref);

        if (currentStatus === "completed") {
          success(`${DEFAULT_SUBAGENT_PREFIX} Completed: ${task.ref}`);
          consecutiveFailures.count = 0;
        } else if (currentStatus === "needs_work") {
          // Expected: reviewer found issues, kicked back to worker
          info(`${DEFAULT_SUBAGENT_PREFIX} Review completed for ${task.ref} — issues found, kicked back to worker`);
          // NOT a failure — the review worked correctly
          consecutiveFailures.count = 0;
        } else if (currentStatus === "pending_review") {
          // Subagent didn't transition or merge — count as soft failure
          warn(
            `${DEFAULT_SUBAGENT_PREFIX} Subagent completed but task ${task.ref} unchanged`,
          );
          await markTaskNeedsReview(
            task.ref,
            "Subagent completed but did not merge or kick back. Review required.",
          );
          consecutiveFailures.count++;
        } else {
          warn(`${DEFAULT_SUBAGENT_PREFIX} Task ${task.ref} in unexpected state: ${currentStatus}`);
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

  // Visual separator at end of subagent section
  console.log("");
  console.log(chalk.cyan(`${"═".repeat(60)}`));
  console.log(chalk.cyan.bold(`${DEFAULT_SUBAGENT_PREFIX} Completed Review Processing`));
  console.log(chalk.cyan(`${"═".repeat(60)}`));
  console.log("");

  return true;
}

// ─── Command Registration ────────────────────────────────────────────────────

export function registerRalphCommand(program: Command): void {
  const ralph = program
    .command("ralph")
    .description("Ralph automated task loop and agent control");

  // end-loop subcommand - allows agent to signal loop termination
  // AC: @session-end-loop-signal ac-signal
  ralph
    .command("end-loop")
    .description("End the ralph loop gracefully (stops all remaining iterations)")
    .option("--reason <reason>", "Reason for ending the loop")
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const sessionId = process.env.KSPEC_SESSION_ID;

        if (!sessionId) {
          // AC: @trait-error-guidance ac-1, ac-2
          warn("No active ralph session detected (KSPEC_SESSION_ID not set).");
          info("This command requires an active session. It is designed to be called by agents during a ralph loop.");
          info("Suggestion: Ensure KSPEC_SESSION_ID is set, or start a session with: kspec session create --agent-type ralph");
          process.exit(EXIT_CODES.VALIDATION_FAILED);
          return;
        }

        // AC: @session-end-loop-signal ac-signal - Write end-loop state to session
        const updated = await requestEndLoop(ctx.specDir, sessionId, options.reason);

        if (!updated) {
          // AC: @trait-error-guidance ac-1, ac-2
          error(`Session not found: ${sessionId}`);
          info("Suggestion: Check session ID with: kspec session log list");
          process.exit(EXIT_CODES.NOT_FOUND);
          return;
        }

        success("Loop end signal sent");
        if (options.reason) {
          info(`Reason: ${options.reason}`);
        }
      } catch (err) {
        // AC: @trait-error-guidance ac-1
        error("Failed to signal end-loop", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // Main ralph run command (default behavior when ralph is called directly)
  ralph
    .command("run", { isDefault: true })
    .description("Run ACP agent in a loop to process ready tasks")
    .argument("[args...]", "")
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
    .option("--subagent-timeout <minutes>", "Review subagent timeout in minutes", "20")
    .option("--adapter <id>", "Agent adapter to use", "claude-agent-acp")
    .option("--worker-adapter <id>", "Adapter for task-work agent (overrides --adapter)")
    .option("--reviewer-adapter <id>", "Adapter for review subagent (overrides --adapter)")
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
    .option(
      "--tasks <refs>",
      "Explicit task scope: only work on these tasks (comma-separated refs, e.g., @task1,@task2)",
    )
    .action(async (args: string[], options) => {
      // Check for unknown subcommands that fell through to default
      // Only check args that look like subcommand names (alphanumeric with hyphens, no quotes)
      if (args.length > 0) {
        const unknownCmd = args[0];
        // Skip if it looks like a malformed option or quoted argument
        const looksLikeSubcommand = /^[a-z][a-z0-9-]*$/i.test(unknownCmd);
        if (looksLikeSubcommand) {
          if (unknownCmd === "end-iteration") {
            error(`Unknown command: ${unknownCmd}. Did you mean 'end-loop'?`);
            info("The command was renamed from 'end-iteration' to 'end-loop' to clarify it ends the entire loop.");
          } else {
            error(`Unknown command: ${unknownCmd}`);
          }
          info("Run 'kspec ralph --help' to see available commands.");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }
      }
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

        const subagentTimeout = parseInt(options.subagentTimeout, 10);
        if (Number.isNaN(subagentTimeout) || subagentTimeout < 1) {
          error("--subagent-timeout must be a positive integer (minutes)");
          process.exit(EXIT_CODES.ERROR);
        }

        const restartEvery = parseInt(options.restartEvery, 10);
        if (Number.isNaN(restartEvery) || restartEvery < 0) {
          error("--restart-every must be a non-negative integer");
          process.exit(EXIT_CODES.ERROR);
        }

        // AC: @ralph-session-budget-integration ac-create-budget
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

        // AC: @ralph-per-role-adapters ac-3, ac-4, ac-5
        // Resolve per-role adapters with precedence: role flag > --adapter > default
        const workerAdapterId = options.workerAdapter ?? options.adapter;
        const reviewerAdapterId = options.reviewerAdapter ?? options.adapter;

        const workerAdapter = resolveAdapter(workerAdapterId);
        const reviewerAdapter = resolveAdapter(reviewerAdapterId);

        // AC: @ralph-per-role-adapters ac-6, ac-9, ac-11
        // Validate adapter packages — deduplicate when same ID
        const adapterIdsToValidate = new Set([workerAdapterId, reviewerAdapterId]);
        for (const id of adapterIdsToValidate) {
          const resolved = resolveAdapter(id);
          const isDefault = id === "claude-agent-acp" || id === "claude-code-acp";
          const skip =
            resolved.command !== "npx" ||
            !resolved.args[0] ||
            (options.dryRun && isDefault);

          if (!skip) {
            validateAdapter(resolved.args[0], id);
          }
        }

        // Build auto-approve extra args per adapter (applied per-spawn to prevent cross-role leakage)
        const workerAutoApproveArgs = options.yolo
          ? workerAdapter.autoApproveArgs
          : undefined;
        const reviewerAutoApproveArgs = options.yolo
          ? reviewerAdapter.autoApproveArgs
          : undefined;

        const restartInfo =
          restartEvery > 0 ? `, restart every ${restartEvery}` : "";
        const maxTasksInfo =
          maxTasks === 0 ? "unlimited" : `${maxTasks}`;

        // Initialize kspec context early to validate --tasks
        const ctx = await initContext();

        // AC: @cli-ralph ac-21 - Parse explicit task scope
        let explicitTaskScope: ExplicitTaskScope | undefined;
        if (options.tasks) {
          try {
            explicitTaskScope = await parseExplicitTasks(ctx, options.tasks);
            info(`Explicit task scope: ${explicitTaskScope.refs.join(", ")}`);
          } catch (err) {
            error(`Invalid --tasks argument: ${(err as Error).message}`);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
        }

        const skillOrigins = await loadSkillOriginsForRalph(ctx);
        const workerPromptPlatform = getPromptPlatformForAdapter(workerAdapterId);
        const reviewerPromptPlatform = getPromptPlatformForAdapter(reviewerAdapterId);
        const workerTaskWorkSkill = resolveRalphSkillInvocation(
          ctx.config.ralph.skills.task_work,
          workerPromptPlatform,
          skillOrigins,
        );
        const workerReflectSkill = resolveRalphSkillInvocation(
          ctx.config.ralph.skills.reflect,
          workerPromptPlatform,
          skillOrigins,
        );
        const reviewerPrReviewSkill = resolveRalphSkillInvocation(
          ctx.config.ralph.skills.pr_review,
          reviewerPromptPlatform,
          skillOrigins,
        );

        const taskScopeInfo = explicitTaskScope
          ? `, tasks=${explicitTaskScope.refs.join(",")}`
          : "";
        const adapterInfo = workerAdapterId === reviewerAdapterId
          ? `adapter=${workerAdapterId}`
          : `worker=${workerAdapterId}, reviewer=${reviewerAdapterId}`;
        info(
          `Starting ralph loop (${adapterInfo}, max ${maxLoops} iterations, ${maxRetries} retries, ${maxFailures} max failures${restartInfo}, max-tasks=${maxTasksInfo}${taskScopeInfo})`,
        );
        if (options.focus) {
          info(`Focus: ${options.focus}`);
        }
        const specDir = ctx.specDir;

        // Create session for event tracking
        const sessionId = ulid();

        // Set session env vars on this process so all spawned agents
        // (main worker, subagent, wrap-up) inherit them via process.env.
        // KSPEC_RALPH_SESSION: Used by codex skill safety guard to detect ralph context.
        // KSPEC_SESSION_ID: Used by kspec task start for budget enforcement.
        // AC: @ralph-session-budget-integration ac-env-inject
        process.env.KSPEC_RALPH_SESSION = sessionId;
        process.env.KSPEC_SESSION_ID = sessionId;

        // AC: @ralph-session-budget-integration ac-create-budget
        // Create session with budget. When maxTasks=0 (unlimited), no budget.json is created.
        await createSessionWithBudget(specDir, {
          id: sessionId,
          agent_type: workerAdapterId,
          budget: maxTasks,
        });

        // AC: @ralph-per-role-adapters ac-6, ac-7
        // Adapter IDs for harness-specific env injection/cleanup.
        // Deduplicate by harness target, not just adapter ID. claude-code-acp is
        // an alias for claude-agent-acp — both inject to the same Claude Code
        // settings file. Without normalization, injecting twice would clobber the
        // previousValue and break cleanup restoration.
        const normalizeForEnv = (id: string) =>
          id === "claude-code-acp" ? "claude-agent-acp" : id;
        const uniqueAdapterIds = [...new Set([
          normalizeForEnv(workerAdapterId),
          normalizeForEnv(reviewerAdapterId),
        ])];

        // Everything after session creation is wrapped in try/finally to guarantee
        // budget cleanup even if pre-loop setup (event logging, signal handlers) throws.
        // AC: @ralph-session-budget-integration ac-session-close-all-paths
        let consecutiveFailures = 0;
        let agent: SpawnedAgent | null = null;
        let acpSessionId: string | null = null;
        let exitReason: ExitReason | null = null;
        let lastIterationCtx: SessionStartContext | null = null;
        let lastErrorMessage: string | undefined;
        // AC: @ralph-per-role-adapters ac-7
        // Track previous env values per adapter for cleanup restoration
        const previousEnvValues = new Map<string, string | null | undefined>();
        const recentTaskRefs: string[] = [];
        const sessionIterationMap = new Map<string, number>();

        // Signal handler refs — declared here so finally can remove them
        // AC: @ralph-task-limit ac-signal-cleanup
        const signalCleanup = (signal: string) => {
          info(`Received ${signal}, cleaning up...`);
          if (agent) {
            agent.kill();
          }
          // AC: @ralph-session-budget-integration ac-session-close-all-paths
          // Must use async IIFE — signal handlers are called synchronously,
          // but cleanup needs async I/O. The IIFE keeps the event loop alive
          // until cleanup completes, then exits explicitly.
          void (async () => {
            try {
              await Promise.all([
                fs.unlink(getSessionBudgetPath(specDir, sessionId)).catch(() => {}),
                closeSession(specDir, sessionId, "abandoned", `Received ${signal}`),
                ...uniqueAdapterIds.map((id) =>
                  removeEnvForAdapter(id, previousEnvValues.get(id)),
                ),
              ]);
            } catch {
              // Best-effort cleanup — don't let errors prevent exit
            } finally {
              process.exit(0);
            }
          })();
        };
        const sigintHandler = () => { signalCleanup("SIGINT"); };
        const sigtermHandler = () => { signalCleanup("SIGTERM"); };

        try {
          // AC: @session-end-loop-signal ac-session-close-signal
          // Install signal handlers FIRST, before any async work, so signals
          // during startup (e.g. during appendEvent) still trigger cleanup.
          // AC: @ralph-session-budget-integration ac-session-close-all-paths
          process.on("SIGINT", sigintHandler);
          process.on("SIGTERM", sigtermHandler);

          // AC: @ralph-per-role-adapters ac-6, ac-7
          // Inject KSPEC_SESSION_ID into agent harness config for each unique adapter.
          // Process env alone is insufficient — some harnesses (e.g., Claude Code)
          // sandbox child processes and don't forward arbitrary parent env vars.
          // AC: @ralph-session-budget-integration ac-env-inject
          for (const id of uniqueAdapterIds) {
            const injectionResult = await injectEnvForAdapter(id, sessionId);
            previousEnvValues.set(id, injectionResult?.previousValue);
          }

          // AC: @ralph-per-role-adapters ac-12
          // Log session start with both adapter IDs
          await appendEvent(specDir, {
            session_id: sessionId,
            type: "session.start",
            data: {
              adapter: workerAdapterId,
              workerAdapter: workerAdapterId,
              reviewerAdapter: reviewerAdapterId,
              maxLoops,
              maxRetries,
              maxFailures,
              maxTasks,
              yolo: options.yolo,
              focus: options.focus,
              explicitTasks: explicitTaskScope?.refs,
            },
          });

          // Create translator and renderer for this session
          const translator = createTranslator();
          const renderer = createCliRenderer();

          for (let iteration = 1; iteration <= maxLoops; iteration++) {
            renderer.newSection?.(`Iteration ${iteration}/${maxLoops}`);

            // AC: @ralph-session-budget-integration ac-reset-iteration
            // Reset budget counter at iteration start (no-op when no budget exists)
            await resetBudget(specDir, sessionId);

            // AC: @session-end-loop-signal ac-detect - Check session state for end-loop
            const endLoopState = await isEndLoopRequested(specDir, sessionId);
            if (endLoopState?.requested) {
              info(`End-loop already requested for this session. Exiting.`);
              exitReason = "end_loop_signal";
              break;
            }

            // Gather fresh context each iteration
            // AC: @cli-ralph ac-16 - Only automation-eligible tasks (unless explicit scope)
            // AC: @cli-ralph ac-21 - With explicit task scope, ignore automation eligibility
            let sessionCtx = await gatherSessionContext(ctx, {
              limit: "10",
              eligible: !explicitTaskScope, // Skip eligibility filter if explicit scope
            });

            // AC: @cli-ralph ac-21 - Filter to explicit tasks if scope is set
            if (explicitTaskScope) {
              sessionCtx = filterByExplicitTasks(sessionCtx, explicitTaskScope);
            }

            // AC: @ralph-subagent-spawning ac-8 - Process pending_review tasks BEFORE main iteration
            // AC: @ralph-per-role-adapters ac-2 - Use reviewer adapter for review subagents
            // This wraps consecutiveFailures in an object so it can be mutated by the helper
            const failureTracker = { count: consecutiveFailures };
            const continueLoop = await processPendingReviewTasks(
              ctx,
              reviewerAdapter,
              sessionCtx.pending_review_tasks,
              {
                yolo: options.yolo,
                maxRetries,
                maxFailures,
                cwd: process.cwd(),
                specDir,
                sessionId,
                subagentTimeout: subagentTimeout * 60 * 1000,
                autoApproveArgs: reviewerAutoApproveArgs,
                prReviewSkillName: reviewerPrReviewSkill,
              },
              failureTracker,
            );
            consecutiveFailures = failureTracker.count;

            if (!continueLoop) {
              exitReason = "max_failures";
              lastIterationCtx = sessionCtx;
              break;
            }

            // AC: @cli-ralph ac-20 - Refresh context after pending_review processing
            // If pending_review tasks were processed, they may have completed and unblocked
            // dependent tasks. Re-gather context to detect newly available tasks.
            let currentCtx = sessionCtx;
            if (sessionCtx.pending_review_tasks.length > 0) {
              currentCtx = await gatherSessionContext(ctx, {
                limit: "10",
                eligible: !explicitTaskScope,
              });
              if (explicitTaskScope) {
                currentCtx = filterByExplicitTasks(currentCtx, explicitTaskScope);
              }
            }

            // AC: @cli-ralph ac-21 - Check explicit task completion
            if (explicitTaskScope) {
              const { done, statuses } = await allExplicitTasksDone(ctx, explicitTaskScope);
              if (done) {
                const statusList = Array.from(statuses.entries())
                  .map(([ref, status]) => `${ref}: ${status}`)
                  .join(", ");
                info(`All explicit tasks completed or blocked (${statusList}). Exiting loop.`);
                exitReason = "explicit_tasks_done";
                lastIterationCtx = currentCtx;
                break;
              }
            }

            // Check for automation-eligible tasks (ready or in_progress)
            // AC: @cli-ralph ac-19
            const hasActiveTasks = currentCtx.active_tasks.length > 0;
            const hasReadyTasks = currentCtx.ready_tasks.length > 0;

            if (!hasActiveTasks && !hasReadyTasks) {
              if (explicitTaskScope) {
                info("No explicit tasks available (ready or in_progress). Exiting loop.");
              } else {
                info("No automation-eligible tasks (ready or in_progress). Exiting loop.");
              }
              exitReason = "no_tasks";
              lastIterationCtx = currentCtx;
              break;
            }

            // AC: @loop-mode-error-handling - Track tasks in progress for failure handling
            const tasksInProgressAtStart = sessionCtx.active_tasks;
            const iterationStartTime = new Date();

            // Build prompts - task-work first, then reflect
            // AC: @cli-ralph ac-21 - Include explicit task scope in prompt
            const taskWorkPrompt = buildTaskWorkPrompt(
              currentCtx,
              iteration,
              maxLoops,
              sessionId,
              workerTaskWorkSkill,
              options.focus,
              explicitTaskScope,
            );
            const reflectPrompt = buildReflectPrompt(
              iteration,
              maxLoops,
              sessionId,
              workerReflectSkill,
            );

            // AC: @cli-ralph ac-21
            // AC: @ralph-per-role-adapters ac-10
            if (options.dryRun) {
              console.log(
                chalk.yellow("=== DRY RUN - Configuration ===\n"),
              );
              console.log(`  worker-adapter: ${workerAdapterId}`);
              console.log(`  reviewer-adapter: ${reviewerAdapterId}`);
              console.log(`  max-loops: ${maxLoops}`);
              console.log(`  max-tasks: ${maxTasks === 0 ? "unlimited" : maxTasks}`);
              console.log(`  max-retries: ${maxRetries}`);
              console.log(`  max-failures: ${maxFailures}`);
              console.log(`  restart-every: ${restartEvery === 0 ? "never" : restartEvery}`);
              console.log(`  worker-task-work-skill: ${workerTaskWorkSkill}`);
              console.log(`  worker-reflect-skill: ${workerReflectSkill}`);
              console.log(`  reviewer-pr-review-skill: ${reviewerPrReviewSkill}`);
              if (explicitTaskScope) {
                console.log(`  explicit-tasks: ${explicitTaskScope.refs.join(", ")}`);
              }
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
                  active: currentCtx.active_tasks.map((t) => t.ref),
                  ready: currentCtx.ready_tasks.map((t) => t.ref),
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
                // AC: @ralph-per-role-adapters ac-1 - Use worker adapter for task-work
                if (!agent) {
                  info("Spawning ACP agent...");
                  // AC: @ralph-session-budget-integration ac-env-inject
                  // AC: @ralph-adapter-auto-approve ac-1, ac-2, ac-3
                  agent = await spawnAndInitialize(workerAdapter, {
                    cwd: process.cwd(),
                    env: { KSPEC_SESSION_ID: sessionId },
                    extraArgs: workerAutoApproveArgs,
                    clientOptions: {
                      clientInfo: {
                        name: "kspec-ralph",
                        version: packageVersion,
                      },
                      methodTimeouts: {
                        "session/prompt": RALPH_PROMPT_TIMEOUT,
                        "session/resume": RALPH_PROMPT_TIMEOUT,
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

                      // Log raw update event (async, non-blocking)
                      // Look up iteration by ACP session ID so late updates from
                      // a previous session are attributed to the correct iteration
                      const eventIteration = sessionIterationMap.get(_sid) ?? 0;
                      appendEvent(specDir, {
                        session_id: sessionId,
                        type: "session.update",
                        data: { iteration: eventIteration, update },
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
                        {
                          yolo: options.yolo,
                          specDir,
                          sessionId,
                        },
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
                sessionIterationMap.set(acpSessionId, iteration);

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

              // Track task refs from this iteration for wrap-up context
              for (const t of sessionCtx.active_tasks) {
                if (!recentTaskRefs.includes(t.ref)) {
                  recentTaskRefs.push(t.ref);
                }
              }
              lastIterationCtx = sessionCtx;


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
                exitReason = "max_failures";
                lastErrorMessage = lastError?.message;
                lastIterationCtx = sessionCtx;
                break;
              }

              info("Continuing to next iteration...");
            }
          }

          // If loop completed all iterations without breaking
          if (exitReason === null) {
            exitReason = "max_iterations";
          }
        } catch (loopErr) {
          // AC: @session-end-loop-signal ac-session-close-error
          // Unrecoverable error during loop execution
          exitReason = exitReason ?? "error";
          lastErrorMessage = (loopErr as Error).message;
          error("Unrecoverable error in ralph loop", loopErr);
        } finally {
          // Remove signal handlers to avoid double cleanup
          process.off("SIGINT", sigintHandler);
          process.off("SIGTERM", sigtermHandler);

          // Clean up agent
          if (agent) {
            agent.kill();
            agent = null;
          }

          // AC: @ralph-session-budget-integration ac-session-close-all-paths
          // AC: @ralph-per-role-adapters ac-7 - Clean up env for all unique adapters
          await fs.unlink(getSessionBudgetPath(specDir, sessionId)).catch(() => {});
          for (const id of uniqueAdapterIds) {
            await removeEnvForAdapter(id, previousEnvValues.get(id));
          }

          // Clean up session env vars
          delete process.env.KSPEC_RALPH_SESSION;
          delete process.env.KSPEC_SESSION_ID;

          // AC: @ralph-wrap-up-agent-on-loop-exit ac-1, ac-2, ac-3, ac-4, ac-5
          // Spawn wrap-up agent if not dry-run and we have an exit reason
          if (!options.dryRun && exitReason) {
            console.log("");
            console.log(chalk.cyan(`${"═".repeat(60)}`));
            console.log(chalk.cyan.bold(`${WRAPUP_AGENT_PREFIX} Starting Wrap-Up`));
            console.log(chalk.cyan(`${"═".repeat(60)}`));
            console.log("");

            const inProgressTasks = lastIterationCtx?.active_tasks || [];
            const pendingReviewTasks = lastIterationCtx?.pending_review_tasks || [];

            const wrapUpCtx = buildWrapUpContext(
              exitReason,
              sessionId,
              maxLoops, // Use maxLoops as iteration (we're at the end)
              maxLoops,
              inProgressTasks,
              pendingReviewTasks,
              recentTaskRefs,
              process.cwd(),
              lastErrorMessage,
            );

            info(`Exit reason: ${exitReason}`);
            info(`Working tree: ${wrapUpCtx.workingTree.clean ? "clean" : "has uncommitted changes"}`);

            // AC: @ralph-per-role-adapters ac-8 - Wrap-up uses worker adapter
            const wrapUpResult = await runWrapUpAgent(
              workerAdapter,
              wrapUpCtx,
              {
                yolo: options.yolo,
                cwd: process.cwd(),
                extraArgs: workerAutoApproveArgs,
                handleRequest: (client, reqId, method, params) =>
                  handleRequest(client, reqId, method, params, {
                    yolo: options.yolo,
                    specDir,
                    sessionId,
                  }),
              },
              DEFAULT_WRAPUP_TIMEOUT,
            );

            // Log wrap-up result
            await appendEvent(specDir, {
              session_id: sessionId,
              type: "session.wrapup",
              data: {
                exitReason,
                result: wrapUpResult,
              },
            });

            if (wrapUpResult.skipped) {
              info(`${WRAPUP_AGENT_PREFIX} Skipped: ${wrapUpResult.skipReason}`);
            } else if (wrapUpResult.timedOut) {
              warn(`${WRAPUP_AGENT_PREFIX} Timed out after ${DEFAULT_WRAPUP_TIMEOUT / 1000}s`);
            } else if (!wrapUpResult.success) {
              warn(`${WRAPUP_AGENT_PREFIX} Failed: ${wrapUpResult.error}`);
            } else {
              success(`${WRAPUP_AGENT_PREFIX} Completed`);
            }

            console.log("");
            console.log(chalk.cyan(`${"═".repeat(60)}`));
            console.log(chalk.cyan.bold(`${WRAPUP_AGENT_PREFIX} Wrap-Up Complete`));
            console.log(chalk.cyan(`${"═".repeat(60)}`));
            console.log("");
          }

          // Log session end and close session with appropriate status/reason
          // AC: @session-end-loop-signal ac-session-close-normal, ac-session-close-error
          const isErrorExit =
            consecutiveFailures >= maxFailures ||
            exitReason === "max_failures" ||
            exitReason === "error";
          const status = isErrorExit ? "abandoned" : "completed";
          const closeReason = exitReason === "max_failures"
            ? `Max failures reached (${consecutiveFailures}/${maxFailures})${lastErrorMessage ? `: ${lastErrorMessage}` : ""}`
            : exitReason === "error"
              ? `Unrecoverable error${lastErrorMessage ? `: ${lastErrorMessage}` : ""}`
              : exitReason === "end_loop_signal"
                ? "Agent requested end of loop"
                : exitReason === "max_iterations"
                  ? `Completed all ${maxLoops} iterations`
                  : exitReason === "no_tasks"
                    ? "No eligible tasks remaining"
                    : exitReason === "explicit_tasks_done"
                      ? "All explicit tasks completed"
                      : `Loop ended: ${exitReason}`;
          await appendEvent(specDir, {
            session_id: sessionId,
            type: "session.end",
            data: {
              status,
              consecutiveFailures,
              exitReason,
              closeReason,
            },
          });
          await closeSession(specDir, sessionId, status, closeReason);
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
