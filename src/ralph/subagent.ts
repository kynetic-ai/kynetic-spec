/**
 * Ralph Subagent Module
 *
 * Handles spawning and running subagents for dedicated tasks like PR review.
 * Subagents run sequentially - ralph waits for completion before continuing.
 */

import type { AgentAdapter } from "../agents/adapters.js";
import { spawnAndInitialize, type SpawnedAgent } from "../agents/spawner.js";
import type { SessionUpdate } from "../acp/index.js";
import { createTranslator } from "./events.js";
import { createPrefixedRenderer } from "./cli-renderer.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Context provided to a subagent for its task.
 * AC: @ralph-subagent-spawning ac-10
 */
export interface SubagentContext {
  /** Task reference (e.g., @task-slug) */
  taskRef: string;
  /** Full task details from kspec task get */
  taskDetails: Record<string, unknown>;
  /** Linked spec with acceptance criteria, if spec_ref exists */
  specWithACs: Record<string, unknown> | null;
  /** Current git branch */
  gitBranch: string;
}

/**
 * Configuration for subagent execution.
 */
export interface SubagentConfig {
  /** Timeout in milliseconds (default: 20 minutes) */
  timeout: number;
  /** Output prefix for distinguishing subagent output */
  outputPrefix: string;
  /** Skill invocation name for PR review (from config, defaults to SKILL_PR_REVIEW) */
  skillName?: string;
}

/**
 * Result of running a subagent.
 */
export interface SubagentResult {
  /** Whether the subagent completed successfully */
  success: boolean;
  /** Whether the subagent timed out */
  timedOut: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Options for running a subagent.
 */
export interface SubagentOptions {
  /** Whether to auto-approve tool requests */
  yolo: boolean;
  /** Working directory */
  cwd: string;
  /** Extra arguments to append to adapter args (e.g., auto-approve flags) */
  extraArgs?: string[];
  /** Tool request handler */
  handleRequest: (
    client: SpawnedAgent["client"],
    reqId: string | number,
    method: string,
    params: unknown,
  ) => Promise<void>;
}

// ============================================================================
// Default Configuration
// ============================================================================

/** Default subagent timeout: 20 minutes */
export const DEFAULT_SUBAGENT_TIMEOUT = 20 * 60 * 1000;

/** Maximum prompt size in bytes for subagent prompts before truncation kicks in.
 * Kept lower than worker prompts because reviewer subagents include additional
 * framing and have hit ACP parser limits with oversized JSON payloads. */
export const SUBAGENT_PROMPT_MAX_BYTES = 16 * 1024;

/** Maximum prompt size in bytes for worker prompts before truncation kicks in.
 * Worker prompts can retain the prior 32KB budget. */
export const WORKER_PROMPT_MAX_BYTES = 32 * 1024;

/** Default output prefix for subagent */
export const DEFAULT_SUBAGENT_PREFIX = "[REVIEW SUBAGENT]";

// ============================================================================
// Skill Invocation Names (Defaults)
// ============================================================================
// Ralph prompts reference skills by invocation name. Defaults use the kspec:
// namespace (core skills). Projects can override via kspec.config.yaml:
//   ralph:
//     skills:
//       task_work: "/my-task-work"
//       reflect: "/my-reflect"
//       pr_review: "/my-review"

/** Default skill invocation for task-work in ralph worker prompt */
export const SKILL_TASK_WORK = "/kspec:task-work";

/** Default skill invocation for reflect in ralph reflect prompt */
export const SKILL_REFLECT = "/kspec:reflect";

/** Default skill invocation for PR review in ralph subagent prompt */
export const SKILL_PR_REVIEW = "/kspec:review";

/**
 * Default ACP prompt timeout for ralph agents: 30 minutes.
 * The framing layer default (5 min) is too aggressive — API slowness,
 * extended thinking, and large context processing can exceed it even
 * with the keepalive mechanism (which resets on tool calls/notifications).
 */
export const RALPH_PROMPT_TIMEOUT = 30 * 60 * 1000;

// ============================================================================
// Prompt Truncation
// ============================================================================

/**
 * Build a compact summary stub for truncated sections.
 * Provides enough identity context to avoid a CLI call for basic triage.
 */
function compactSummary(data: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (data._ulid != null) summary._ulid = data._ulid;
  if (data.ulid != null) summary._ulid = data.ulid;
  if (data.title != null) summary.title = data.title;
  if (data.status != null) summary.status = data.status;
  if (data.spec_ref != null) summary.spec_ref = data.spec_ref;
  if (data.slug != null) summary.slug = data.slug;
  if (Array.isArray(data.acceptance_criteria)) {
    summary.ac_count = data.acceptance_criteria.length;
  }
  return summary;
}

/**
 * Represents a replaceable JSON section within a prompt.
 */
export interface PromptSection {
  /** Marker string that appears in the prompt (the full formatted section) */
  marker: string;
  /** Replacement text if this section is truncated */
  truncated: string;
  /** Byte size of the marker */
  size: number;
}

/**
 * Format a data object as a labeled markdown JSON section.
 * Returns the formatted string and a PromptSection for potential truncation.
 *
 * When not truncated: heading + ```json fence + pretty-printed JSON
 * When truncated: heading + blockquote with compact summary + CLI fetch command
 */
export function formatJsonSection(
  data: Record<string, unknown>,
  label: string,
  fetchCmd: string,
): { text: string; section: PromptSection } {
  const json = JSON.stringify(data, null, 2);
  const text = `### ${label}\n\n\`\`\`json\n${json}\n\`\`\``;
  const summary = JSON.stringify(compactSummary(data));
  const truncated = `### ${label}\n\n> **Truncated** (${Buffer.byteLength(json, "utf8")} bytes). Fetch full data:\n> \`\`\`\n> ${fetchCmd}\n> \`\`\`\n>\n> Summary: \`${summary}\``;

  return {
    text,
    section: {
      marker: text,
      truncated,
      size: Buffer.byteLength(text, "utf8"),
    },
  };
}

/**
 * Format a section as a compact summary + CLI fetch command.
 * Intended for subagent prompts to avoid embedding full JSON payloads.
 */
export function formatCompactSection(
  data: Record<string, unknown>,
  label: string,
  fetchCmd: string,
): { text: string; section: PromptSection } {
  const summary = JSON.stringify(compactSummary(data));
  const text = `### ${label}\n\n> Fetch full data:\n> \`\`\`\n> ${fetchCmd}\n> \`\`\`\n>\n> Summary: \`${summary}\``;
  const truncated = `### ${label}\n\n> **Truncated**. Fetch full data:\n> \`\`\`\n> ${fetchCmd}\n> \`\`\``;

  return {
    text,
    section: {
      marker: text,
      truncated,
      size: Buffer.byteLength(text, "utf8"),
    },
  };
}

/**
 * If the assembled prompt exceeds the byte budget, truncate the largest
 * section(s) until it fits. Sections are replaced largest-first.
 */
export function truncatePromptIfNeeded(
  prompt: string,
  sections: PromptSection[],
  maxBytes: number = SUBAGENT_PROMPT_MAX_BYTES,
): string {
  let totalBytes = Buffer.byteLength(prompt, "utf8");
  if (totalBytes <= maxBytes) return prompt;

  // Sort sections largest-first for greedy truncation
  const sorted = [...sections].sort((a, b) => b.size - a.size);
  let result = prompt;

  for (const section of sorted) {
    if (totalBytes <= maxBytes) break;
    // Only truncate if this section hasn't already been truncated
    if (!result.includes(section.marker)) continue;

    const savedBytes = Buffer.byteLength(section.marker, "utf8") -
      Buffer.byteLength(section.truncated, "utf8");
    result = result.replace(section.marker, section.truncated);
    totalBytes -= savedBytes;
  }

  return result;
}

// ============================================================================
// Prompt Builder
// ============================================================================

/**
 * Build the prompt for a PR review subagent.
 * AC: @ralph-subagent-spawning ac-2, ac-10, ac-12
 *
 * @param context - Task context for the subagent
 * @param skillName - Skill invocation name for PR review (from config or default)
 */
export function buildSubagentPrompt(context: SubagentContext, skillName: string = SKILL_PR_REVIEW): string {
  // Build compact identity sections to keep subagent payloads small.
  const taskSection = formatCompactSection(
    context.taskDetails,
    "Task Details",
    `kspec task get ${context.taskRef} --json`,
  );

  const sections: PromptSection[] = [taskSection.section];

  let specBlock = "";
  let specSection: PromptSection | null = null;
  if (context.specWithACs) {
    const specRef = (context.taskDetails.spec_ref as string) || "@spec";
    const formatted = formatCompactSection(
      context.specWithACs,
      "Linked Spec with Acceptance Criteria",
      `kspec item get ${specRef} --json`,
    );
    specBlock = `\n${formatted.text}\n\n**Verify all ACs have test coverage before merging.**\n`;
    specSection = formatted.section;
    sections.push(specSection);
  }

  const prompt = `# PR Review Subagent

You are a subagent spawned by ralph to REVIEW a PR and merge it only if clean.

## Role Boundary

You are a REVIEWER, not a fixer. Your responsibilities:
- Review code quality, AC coverage (own + trait), spec alignment
- Post findings as inline PR comments with severity (MUST-FIX:, SHOULD-FIX:, SUGGESTION:)
- Merge the PR ONLY if all quality gates pass (no MUST-FIX or SHOULD-FIX items)
- Complete the task after merge

You MUST NOT:
- Fix code issues yourself
- Push commits to the PR branch
- Add or modify tests
- Make any code changes

If you find issues:
1. Post them as inline PR comments with severity prefix
2. Transition the task to needs_work: \`kspec task needs-work ${context.taskRef} --reason "findings..."\`
3. Exit — the worker agent will fix issues in the next iteration

## Context

- **Task:** \`${context.taskRef}\`
- **Branch:** \`${context.gitBranch}\`

${taskSection.text}
${specBlock}
## Instructions

Run the PR review skill:

\`\`\`
${skillName} ${context.taskRef}
\`\`\`

The skill defines all review steps, quality gates, and merge criteria. Follow it completely.

Do NOT start new work. Do NOT fix code. Your only job is reviewing this task's PR, posting findings, and merging if clean.
`;

  return truncatePromptIfNeeded(prompt, sections, SUBAGENT_PROMPT_MAX_BYTES);
}

// ============================================================================
// Subagent Runner
// ============================================================================

/**
 * Run a subagent for a dedicated task.
 *
 * AC: @ralph-subagent-spawning ac-1 (spawn), ac-3 (sequential), ac-4 (output),
 *     ac-9 (timeout), ac-11 (prefix)
 *
 * @param adapter - Agent adapter to use for spawning
 * @param context - Task context for the subagent
 * @param config - Subagent configuration (timeout, prefix)
 * @param options - Runtime options (cwd, request handler)
 * @returns Result indicating success/failure/timeout
 */
export async function runSubagent(
  adapter: AgentAdapter,
  context: SubagentContext,
  config: SubagentConfig,
  options: SubagentOptions,
): Promise<SubagentResult> {
  const prompt = buildSubagentPrompt(context, config.skillName);
  let agent: SpawnedAgent | null = null;

  try {
    // AC: @ralph-subagent-spawning ac-1 - Spawn new ACP process
    // AC: @ralph-adapter-auto-approve ac-4
    agent = await spawnAndInitialize(adapter, {
      cwd: options.cwd,
      extraArgs: options.extraArgs,
      clientOptions: {
        clientInfo: {
          name: "kspec-ralph-subagent",
          version: "1.0.0",
        },
        methodTimeouts: {
          "session/prompt": RALPH_PROMPT_TIMEOUT,
          "session/resume": RALPH_PROMPT_TIMEOUT,
        },
      },
    });

    // AC: @ralph-subagent-spawning ac-4, ac-11 - Prefixed renderer for output
    const translator = createTranslator();
    const renderer = createPrefixedRenderer(config.outputPrefix);

    // Set up streaming update handler
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

    // AC: @ralph-subagent-spawning ac-9 - Timeout handling
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("SUBAGENT_TIMEOUT")),
        config.timeout,
      );
    });

    // AC: @ralph-subagent-spawning ac-3 - Ralph waits for completion
    const promptPromise = agent.client.prompt({
      sessionId: acpSessionId,
      prompt: [{ type: "text", text: prompt }],
    });

    // Race between completion and timeout
    await Promise.race([promptPromise, timeoutPromise]);

    return { success: true, timedOut: false };
  } catch (err) {
    const error = err as Error;

    // AC: @ralph-subagent-spawning ac-9 - Timeout detection
    if (error.message === "SUBAGENT_TIMEOUT") {
      return { success: false, timedOut: true };
    }

    return { success: false, timedOut: false, error: error.message };
  } finally {
    // Always clean up the agent process
    if (agent) {
      agent.kill();
    }
  }
}
