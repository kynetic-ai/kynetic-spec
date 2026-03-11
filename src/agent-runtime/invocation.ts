/**
 * Agent Invocation Lifecycle
 *
 * Per-invocation session creation, ACP agent spawn, prompt delivery,
 * event logging, timeout handling, and structured completion tracking.
 *
 * This is the core building block used by both the dispatch engine and
 * CLI one-shot mode. Each invocation creates an isolated session with
 * its own event log and metadata.
 *
 * AC: @agent-invocation-lifecycle ac-1 through ac-11
 */

import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ulid } from "ulid";
import type { Agent } from "../schema/meta.js";
import { buildPromptWithSkills } from "./prompts.js";
import { resolveAdapter } from "../agents/adapters.js";
import { spawnAndInitialize } from "../agents/spawner.js";
import type { SpawnedAgent } from "../agents/spawner.js";
import type { RequestPermissionRequest, SessionUpdate } from "../acp/index.js";
import {
  createSession,
  closeSession,
  appendEvent,
  injectEnvForAdapter,
  removeEnvForAdapter,
} from "../sessions/store.js";
import type { SessionEventInput, SessionMetadata, SessionTrigger } from "../sessions/types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_KSPEC_CLI_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../bin/kspec.cjs",
);

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Options for running a single agent invocation.
 */
export interface InvocationOptions {
  /** The agent definition describing capabilities and configuration */
  agent: Agent;
  /** The spec directory (.kspec/) */
  specDir: string;
  /** The sessions directory (.kspec-sessions/). Derived from specDir if not set. */
  sessionsDir?: string;
  /** Working directory for spawned agent */
  cwd: string;
  /** Task reference being worked on (e.g., "@01KJP277A"). Optional — omit for unbound invocations. */
  taskRef?: string;
  /** The prompt to send to the agent */
  prompt: string;
  /** Trigger source for this invocation */
  trigger: SessionTrigger;
  /** Timeout in minutes (overrides agent.budget.timeout_minutes if set) */
  timeoutMinutes?: number;
  /** Whether to use auto-approve (yolo) args for adapter */
  autoApprove?: boolean;
  /** Extra environment variables for the spawned agent */
  env?: Record<string, string>;
  /** Called for each streaming update from the agent */
  onUpdate?: (update: SessionUpdate) => void;
  /** Path to kspec CLI (defaults to resolved bin/kspec.cjs) */
  kspecCliPath?: string;
  /** Abort signal for graceful cancellation (AC-11) */
  abortSignal?: AbortSignal;
  /** Pre-assigned session ID (generated if not provided) */
  sessionId?: string;
}

/**
 * Result of a completed agent invocation.
 */
export interface InvocationResult {
  /** Session that was created for this invocation */
  session: SessionMetadata;
  /** How the invocation ended */
  outcome: "success" | "timed_out" | "failed";
  /** Stop reason from ACP (e.g., "end_turn") if the invocation completed */
  stopReason?: string;
  /** Error message if the invocation failed */
  error?: string;
  /** Total duration in milliseconds */
  durationMs: number;
}

/**
 * Internal state tracked during invocation execution.
 */
interface InvocationState {
  sessionId: string;
  specDir: string;
  taskRef: string | undefined;
  adapterId: string;
  previousEnvValue?: string | null;
  agent: SpawnedAgent | null;
  acpSessionId: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a kspec CLI command synchronously.
 */
function runKspecCli(args: string[], cwd: string, kspecCliPath: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [kspecCliPath, ...args], {
    encoding: "utf-8",
    stdio: "pipe",
    cwd,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

/**
 * Add a note to a task via kspec CLI.
 */
function addTaskNote(taskRef: string, note: string, cwd: string, kspecCliPath: string): void {
  runKspecCli(["task", "note", taskRef, note], cwd, kspecCliPath);
}

/**
 * Block a task via kspec CLI.
 */
function blockTask(taskRef: string, reason: string, cwd: string, kspecCliPath: string): void {
  runKspecCli(["task", "block", taskRef, "--reason", reason], cwd, kspecCliPath);
}

/**
 * Get the consecutive failure count for a task from its notes.
 * Looks for AGENT-FAIL notes added by previous invocations.
 */
function getConsecutiveFailureCount(taskRef: string, cwd: string, kspecCliPath: string): number {
  const result = runKspecCli(["task", "get", taskRef, "--json"], cwd, kspecCliPath);
  if (result.status !== 0) return 0;

  try {
    const task = JSON.parse(result.stdout);
    const notes: Array<{ content: string }> = task.notes ?? [];
    // Count consecutive AGENT-FAIL notes from the end
    let count = 0;
    for (let i = notes.length - 1; i >= 0; i--) {
      if (notes[i].content?.includes("[AGENT-FAIL]")) {
        count++;
      } else {
        break;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Dispose a spawned agent, terminating the process if running.
 * AC: @agent-invocation-lifecycle ac-8
 */
function disposeAgent(agent: SpawnedAgent | null): null {
  if (agent) {
    try {
      agent.kill("SIGTERM");
    } catch {
      // Best-effort termination
    }
  }
  return null;
}

// ─── Core Invocation ──────────────────────────────────────────────────────────

/**
 * Run a single agent invocation for a task.
 *
 * Creates a session, spawns the agent, injects KSPEC_SESSION_ID,
 * sends the prompt, streams events, and closes the session on completion.
 *
 * AC: @agent-invocation-lifecycle ac-1 through ac-11
 */
export async function runInvocation(options: InvocationOptions): Promise<InvocationResult> {
  const {
    agent,
    specDir,
    cwd,
    taskRef,
    trigger,
    autoApprove = agent.auto_approve,
    env = {},
    onUpdate,
    kspecCliPath = DEFAULT_KSPEC_CLI_PATH,
    abortSignal,
  } = options;

  // AC: @session-storage-path-resolution ac-resolver
  // Sessions live in .kspec-sessions/ at project root, not inside .kspec/
  const sessionsDir = options.sessionsDir ?? path.join(path.dirname(specDir), ".kspec-sessions");

  const startTime = Date.now();
  const sessionId = options.sessionId ?? ulid();

  // Resolve adapter
  const adapterId = agent.adapter ?? "claude-agent-acp";
  const adapter = resolveAdapter(adapterId);

  // Build extra args for auto-approve
  const extraArgs = autoApprove ? (adapter.autoApproveArgs ?? []) : [];

  // Resolve timeout: option overrides agent budget
  const timeoutMinutes =
    options.timeoutMinutes ??
    agent.budget?.timeout_minutes ??
    30;
  const timeoutMs = timeoutMinutes * 60 * 1000;
  // Keep ACP request timeout slightly above invocation timeout so the outer
  // lifecycle controls timeout behavior (cancel + timeout note), not framing.
  const promptRequestTimeoutMs = Math.max(1, Math.ceil(timeoutMs + 5_000));

  // Resolve skill content for prompt
  // AC: @agent-invocation-lifecycle ac-7
  const fullPrompt = await buildPromptWithSkills({
    basePrompt: options.prompt,
    skillIds: agent.skills ?? [],
    specDir,
    adapterId,
  });

  const state: InvocationState = {
    sessionId,
    specDir,
    taskRef,
    adapterId,
    previousEnvValue: undefined,
    agent: null,
    acpSessionId: null,
  };

  // Serialize all per-session event writes so seq assignment and append order
  // are deterministic even when ACP update callbacks fire concurrently.
  let eventWriteQueue: Promise<void> = Promise.resolve();
  let nextEventSeq: number | undefined;

  const queueEventWrite = <T>(write: () => Promise<T>): Promise<T> => {
    const run = eventWriteQueue.then(write, write);
    eventWriteQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const appendSessionEvent = async (
    input: Omit<SessionEventInput, "session_id" | "seq">,
  ): Promise<void> => {
    const event = await queueEventWrite(() =>
      appendEvent(sessionsDir, {
        ...input,
        session_id: sessionId,
        seq: nextEventSeq,
      }),
    );
    nextEventSeq = event.seq + 1;
  };

  // ─── Create session ───────────────────────────────────────────────────────
  // AC: @agent-invocation-lifecycle ac-1
  const session = await createSession(sessionsDir, {
    id: sessionId,
    agent_type: adapterId,
    agent_id: agent.id,
    trigger,
    task_id: taskRef,
  });

  // ─── Log agent.dispatched event ───────────────────────────────────────────
  await appendSessionEvent({
    type: "agent.dispatched",
    data: {
      task_id: taskRef,
      agent_id: agent.id,
      adapter: adapterId,
      trigger,
    },
  });

  try {
    // ─── Inject KSPEC_SESSION_ID ──────────────────────────────────────────
    // AC: @agent-invocation-lifecycle ac-2
    const injectionResult = await injectEnvForAdapter(adapterId, sessionId);
    state.previousEnvValue = injectionResult?.previousValue;

    // ─── Spawn agent ──────────────────────────────────────────────────────
    state.agent = await spawnAndInitialize(adapter, {
      cwd,
      env: {
        ...env,
        KSPEC_SESSION_ID: sessionId,
      },
      extraArgs,
      clientOptions: {
        methodTimeouts: {
          "session/prompt": promptRequestTimeoutMs,
        },
      },
    });

    // ─── Create ACP session ───────────────────────────────────────────────
    state.acpSessionId = await state.agent.client.newSession({
      cwd,
      mcpServers: [],
    });

    // ─── Log agent.started event ──────────────────────────────────────────
    await appendSessionEvent({
      type: "agent.started",
      data: {
        task_id: taskRef,
        agent_id: agent.id,
        acp_session_id: state.acpSessionId,
      },
    });

    // ─── Register update handler ──────────────────────────────────────────
    // AC: @agent-invocation-lifecycle ac-6
    const updateHandler = async (acpSessionId: string, update: SessionUpdate) => {
      if (acpSessionId !== state.acpSessionId) return;

      // Log event to JSONL (with blob externalization from store.ts)
      await appendSessionEvent({
        type: "session.update",
        data: update,
      });

      onUpdate?.(update);
    };

    state.agent.client.on("update", updateHandler);

    // ─── Register permission request handler ──────────────────────────────
    // AC: @agent-invocation-lifecycle ac-11
    const requestHandler = (id: string | number, method: string, params: unknown) => {
      if (method === "session/request_permission") {
        if (autoApprove) {
          // Auto-approve: prefer allow_always, fall back to allow_once
          const permParams = params as RequestPermissionRequest;
          const allowOption =
            permParams.options?.find((o) => o.kind === "allow_always") ??
            permParams.options?.find((o) => o.kind === "allow_once");

          if (allowOption) {
            state.agent!.client.respondPermission(id, {
              outcome: { outcome: "selected", optionId: allowOption.optionId },
            });
          } else {
            state.agent!.client.respondPermission(id, {
              outcome: { outcome: "cancelled" },
            });
          }
        } else {
          // Non-auto-approve: deny the request
          state.agent!.client.respondPermission(id, {
            outcome: { outcome: "cancelled" },
          });
        }
      }
      // Other request types (ReadTextFile, WriteTextFile, etc.) are not handled here
    };

    state.agent.client.on("request", requestHandler);

    // ─── Send prompt with timeout ─────────────────────────────────────────
    // AC: @agent-invocation-lifecycle ac-3
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new InvocationTimeoutError(timeoutMinutes));
      }, timeoutMs);
    });

    // AC: @agent-dispatch-engine ac-11 - Abort signal for graceful cancellation
    const abortPromise = abortSignal
      ? new Promise<never>((_, reject) => {
          if (abortSignal.aborted) {
            reject(new InvocationAbortedError());
          } else {
            abortSignal.addEventListener("abort", () => reject(new InvocationAbortedError()), { once: true });
          }
        })
      : null;

    const promptPromise = state.agent.client.prompt({
      sessionId: state.acpSessionId,
      prompt: [{ type: "text", text: fullPrompt }],
    });

    let promptResult: Awaited<typeof promptPromise>;
    try {
      const racers: Array<Promise<typeof promptResult | never>> = [promptPromise, timeoutPromise];
      if (abortPromise) racers.push(abortPromise);
      promptResult = await Promise.race(racers);
    } finally {
      // Clear the timeout handle to prevent timer leaks whether prompt
      // resolves normally or the timeout fires.
      clearTimeout(timeoutHandle);
    }

    // ─── Log agent.completed event ────────────────────────────────────────
    // AC: @agent-invocation-lifecycle ac-4
    const durationMs = Date.now() - startTime;
    await appendSessionEvent({
      type: "agent.completed",
      data: {
        task_id: taskRef,
        outcome: "success",
        stop_reason: promptResult.stopReason,
        duration_ms: durationMs,
      },
    });

    // ─── Close session as completed ───────────────────────────────────────
    const finalSession = await closeSession(sessionsDir, sessionId, "completed", "Invocation completed normally");

    // Add success note to reset consecutive failure streak (only when a task is bound)
    // AC: @agent-invocation-lifecycle ac-9
    if (taskRef) {
      addTaskNote(
        taskRef,
        `[AGENT-SUCCESS] Invocation completed successfully`,
        cwd,
        kspecCliPath,
      );
    }

    return {
      session: finalSession ?? session,
      outcome: "success",
      stopReason: promptResult.stopReason,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;

    if (err instanceof InvocationTimeoutError) {
      // ─── Handle timeout ──────────────────────────────────────────────
      // AC: @agent-invocation-lifecycle ac-3
      try {
        if (state.acpSessionId && state.agent) {
          await state.agent.client.cancel(state.acpSessionId);
        }
      } catch {
        // Best-effort cancel
      }

      await appendSessionEvent({
        type: "agent.timeout",
        data: {
          task_id: taskRef,
          timeout_minutes: timeoutMinutes,
          duration_ms: durationMs,
        },
      });

      const finalSession = await closeSession(sessionsDir, sessionId, "timed_out", `Timeout after ${timeoutMinutes} minutes`);

      // Add timeout note to task (only when a task is bound)
      if (taskRef) {
        addTaskNote(
          taskRef,
          `[AGENT-TIMEOUT] Invocation timed out after ${timeoutMinutes} minutes`,
          cwd,
          kspecCliPath,
        );
      }

      return {
        session: finalSession ?? session,
        outcome: "timed_out",
        error: err.message,
        durationMs,
      };
    }

    if (err instanceof InvocationAbortedError) {
      // ─── Handle graceful abort (shutdown signal) ──────────────────────
      // AC: @agent-dispatch-engine ac-11
      try {
        if (state.acpSessionId && state.agent) {
          await state.agent.client.cancel(state.acpSessionId);
        }
      } catch {
        // Best-effort cancel
      }

      const finalSession = await closeSession(sessionsDir, sessionId, "failed", "Invocation aborted by shutdown");

      return {
        session: finalSession ?? session,
        outcome: "failed",
        error: err.message,
        durationMs,
      };
    }

    // ─── Handle failure ──────────────────────────────────────────────────
    // AC: @agent-invocation-lifecycle ac-5
    const errorMessage = err instanceof Error ? err.message : String(err);

    await appendSessionEvent({
      type: "agent.failed",
      data: {
        task_id: taskRef,
        error: errorMessage,
        duration_ms: durationMs,
      },
    });

    const finalSession = await closeSession(sessionsDir, sessionId, "failed", `Invocation failed: ${errorMessage}`);

    // Add failure note to task and check retry threshold (only when a task is bound)
    if (taskRef) {
      addTaskNote(
        taskRef,
        `[AGENT-FAIL] Invocation failed: ${errorMessage}`,
        cwd,
        kspecCliPath,
      );

      // ─── Check retry threshold ────────────────────────────────────────────
      // AC: @agent-invocation-lifecycle ac-9
      const retryLimit = agent.budget?.max_retries ?? 3;
      const consecutiveFailures = getConsecutiveFailureCount(taskRef, cwd, kspecCliPath);

      if (consecutiveFailures >= retryLimit) {
        blockTask(
          taskRef,
          `Agent ${agent.id} failed ${consecutiveFailures} consecutive times: ${errorMessage}`,
          cwd,
          kspecCliPath,
        );
      }
    }

    return {
      session: finalSession ?? session,
      outcome: "failed",
      error: errorMessage,
      durationMs,
    };
  } finally {
    // ─── Cleanup ──────────────────────────────────────────────────────────
    // AC: @agent-invocation-lifecycle ac-8

    // End ACP session
    if (state.acpSessionId && state.agent) {
      try {
        state.agent.client.endSession(state.acpSessionId);
      } catch {
        // Best-effort
      }
    }

    // Terminate agent process
    state.agent = disposeAgent(state.agent);

    // Restore env injection
    await removeEnvForAdapter(adapterId, state.previousEnvValue);
  }
}

// ─── Error Types ──────────────────────────────────────────────────────────────

/**
 * Thrown when an invocation exceeds its configured timeout.
 */
export class InvocationTimeoutError extends Error {
  constructor(public readonly timeoutMinutes: number) {
    super(`Agent invocation timed out after ${timeoutMinutes} minutes`);
    this.name = "InvocationTimeoutError";
  }
}

/**
 * Thrown when an invocation is aborted via AbortSignal (graceful shutdown).
 * AC: @agent-dispatch-engine ac-11
 */
export class InvocationAbortedError extends Error {
  constructor() {
    super("Agent invocation aborted by shutdown signal");
    this.name = "InvocationAbortedError";
  }
}
