/**
 * Session create action and environment injection.
 *
 * Creates new sessions with optional budget and injects session ID into agent environments.
 */

import { initContext } from "../../../parser/index.js";
import {
  type EnvInjectionResult,
  createSessionWithBudget,
  validateSessionId,
  injectClaudeCodeEnv,
  injectCodexEnv,
  injectGeminiEnv,
  injectOpenCodeEnv,
  getFallbackInjectionInstructions,
} from "../../../sessions/store.js";
import { ulid } from "ulid";
import { EXIT_CODES } from "../../exit-codes.js";
import { error, info, output, success, warn } from "../../output.js";

/**
 * Detect agent harness and perform environment injection.
 *
 * AC: @session-creation-and-env-injection ac-inject-claude
 * AC: @session-creation-and-env-injection ac-inject-codex
 * AC: @session-creation-and-env-injection ac-inject-fallback
 */
async function performEnvInjection(sessionId: string): Promise<EnvInjectionResult> {
  // Detect Claude Code
  if (
    process.env.CLAUDECODE === "1" ||
    process.env.CLAUDE_CODE_ENTRYPOINT ||
    process.env.CLAUDE_PROJECT_DIR
  ) {
    return injectClaudeCodeEnv(sessionId);
  }

  // Detect Codex CLI
  if (process.env.CODEX_SANDBOX) {
    return injectCodexEnv(sessionId);
  }

  // Detect Gemini CLI
  if (process.env.GEMINI_CLI === "1") {
    return injectGeminiEnv(sessionId);
  }

  // Detect OpenCode
  if (process.env.OPENCODE_CONFIG_DIR || process.env.OPENCODE_CONFIG) {
    return injectOpenCodeEnv(sessionId);
  }

  // Fallback for unknown harnesses
  return getFallbackInjectionInstructions(sessionId);
}

/**
 * Action handler for `kspec session create`.
 *
 * Creates a new session with optional budget and environment injection.
 *
 * AC: @session-creation-and-env-injection ac-create
 * AC: @session-creation-and-env-injection ac-budget
 * AC: @session-creation-and-env-injection ac-budget-local
 * AC: @session-creation-and-env-injection ac-inject-claude
 * AC: @session-creation-and-env-injection ac-inject-codex
 * AC: @session-creation-and-env-injection ac-inject-fallback
 *
 * Exit codes documented per @trait-semantic-exit-codes ac-8:
 * - 0: Session created successfully
 * - 1: Validation error (invalid budget value)
 * - 3: Runtime error (filesystem failure)
 */
export async function sessionCreateAction(options: {
  agentType: string;
  budget?: string;
  inject?: boolean;
  taskId?: string;
}): Promise<void> {
  try {
    const ctx = await initContext();

    // AC: @session-creation-and-env-injection ac-invalid-session
    // Validate existing KSPEC_SESSION_ID if set — warn user if it's stale/corrupt
    const existingSessionId = process.env.KSPEC_SESSION_ID;
    if (existingSessionId) {
      const validation = await validateSessionId(ctx.sessionsDir, existingSessionId);
      if (!validation.valid) {
        warn(`Current KSPEC_SESSION_ID (${existingSessionId}) is invalid: ${validation.error}`);
        info(validation.suggestion || "Creating a new session will generate a fresh ID.");
      }
    }

    // Validate budget if provided
    // AC: @trait-error-guidance ac-5 - indicate which field/value failed
    let budgetNum: number | undefined;
    if (options.budget !== undefined) {
      // Use Number() instead of parseInt to reject "3.5", "3abc", "1e2" etc.
      budgetNum = Number(options.budget);
      if (
        isNaN(budgetNum) ||
        budgetNum <= 0 ||
        !Number.isInteger(budgetNum) ||
        !/^\d+$/.test(options.budget)
      ) {
        // AC: @trait-error-guidance ac-2, ac-5 - include suggested action and field info
        // AC: @trait-error-guidance ac-6 - guidance included in structured error
        error(`Invalid budget value: "${options.budget}". Must be a positive integer.`, {
          suggestion: "Usage: kspec session create --budget <positive-integer>",
        });
        process.exit(EXIT_CODES.USAGE_ERROR);
      }
    }

    // Generate session ID
    const sessionId = ulid();

    // AC: @session-creation-and-env-injection ac-create, ac-budget, ac-budget-local
    const result = await createSessionWithBudget(ctx.sessionsDir, {
      id: sessionId,
      agent_type: options.agentType,
      task_id: options.taskId,
      budget: budgetNum,
    });

    // Handle environment injection if requested
    let injection: EnvInjectionResult | null = null;
    if (options.inject) {
      injection = await performEnvInjection(sessionId);
    }

    // Build output data
    const outputData: Record<string, unknown> = {
      session_id: result.session_id,
      agent_type: result.session.agent_type,
      status: result.session.status,
      started_at: result.session.started_at,
    };

    if (result.session.task_id) {
      outputData.task_id = result.session.task_id;
    }

    if (result.budget) {
      outputData.budget = {
        max_per_cycle: result.budget.max_per_cycle,
        started_this_cycle: result.budget.started_this_cycle,
      };
    }

    if (injection) {
      outputData.env_injection = {
        method: injection.method,
        injected: injection.injected,
        description: injection.description,
        ...(injection.path ? { path: injection.path } : {}),
      };
    }

    // AC: @trait-json-output ac-1, ac-2, ac-5 - JSON with all data, ISO timestamps
    output(outputData, () => {
      // AC: @session-creation-and-env-injection ac-create - print session ID to stdout
      success(`Created session: ${sessionId}`, { session_id: sessionId });
      info(`Agent type: ${options.agentType}`);

      if (result.budget) {
        info(`Budget: ${result.budget.max_per_cycle} tasks per cycle`);
      }

      if (injection) {
        if (injection.injected) {
          info(injection.description);
        } else {
          // AC: @session-creation-and-env-injection ac-inject-fallback
          console.log(injection.description);
        }
      }
    });
  } catch (err) {
    // AC: @trait-error-guidance ac-1 - describe what went wrong
    // AC: @trait-json-output ac-3 - error as JSON object
    error("Failed to create session", err);
    process.exit(EXIT_CODES.ERROR);
  }
}
