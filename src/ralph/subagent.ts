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
  /** Timeout in milliseconds (default: 10 minutes) */
  timeout: number;
  /** Output prefix for distinguishing subagent output */
  outputPrefix: string;
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

/** Default subagent timeout: 10 minutes */
export const DEFAULT_SUBAGENT_TIMEOUT = 10 * 60 * 1000;

/** Default output prefix for subagent */
export const DEFAULT_SUBAGENT_PREFIX = "[REVIEW SUBAGENT]";

// ============================================================================
// Prompt Builder
// ============================================================================

/**
 * Build the prompt for a PR review subagent.
 * AC: @ralph-subagent-spawning ac-2, ac-10
 */
export function buildSubagentPrompt(context: SubagentContext): string {
  const specSection = context.specWithACs
    ? `
## Linked Spec with Acceptance Criteria

\`\`\`json
${JSON.stringify(context.specWithACs, null, 2)}
\`\`\`

**Verify all ACs have test coverage before merging.**
`
    : "";

  return `# PR Review Subagent

You are a subagent spawned by ralph to review and merge a PR.

## Task Reference
\`${context.taskRef}\`

## Git Branch
\`${context.gitBranch}\`

## Task Details

\`\`\`json
${JSON.stringify(context.taskDetails, null, 2)}
\`\`\`
${specSection}
## Instructions

Run the PR review skill to review and merge the PR for this task:

\`\`\`
/pr-review ${context.taskRef}
\`\`\`

This will:
1. Run local review (AC coverage verification)
2. Check spec alignment
3. Wait for CI to pass
4. Merge the PR if all gates pass

**Exit when:**
- PR is merged successfully
- PR cannot be merged (quality gates failed, needs human review)
- No PR found for this task

Do NOT start new work. Your only job is to get this specific PR merged.
`;
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
  const prompt = buildSubagentPrompt(context);
  let agent: SpawnedAgent | null = null;

  try {
    // AC: @ralph-subagent-spawning ac-1 - Spawn new ACP process
    agent = await spawnAndInitialize(adapter, {
      cwd: options.cwd,
      clientOptions: {
        clientInfo: {
          name: "kspec-ralph-subagent",
          version: "1.0.0",
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
