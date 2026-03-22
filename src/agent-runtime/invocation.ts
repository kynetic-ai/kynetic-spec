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
import { fileURLToPath } from "node:url";
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
  getSession,
  listSessions,
  removeEnvForAdapter,
} from "../sessions/store.js";
import type { SessionEventInput, SessionMetadata, SessionTrigger } from "../sessions/types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export function resolveDefaultKspecCliPath(moduleUrl = import.meta.url): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return path.resolve(moduleDir, "../../dist/cli/index.js");
}

export const DEFAULT_KSPEC_CLI_PATH = resolveDefaultKspecCliPath();

/**
 * Default stall detection timeout in seconds.
 * AC: @invocation-initial-activity-watchdog ac-1, ac-5
 */
export const DEFAULT_INITIAL_RESPONSE_TIMEOUT_SECONDS = 120;

/**
 * Session update types that count as meaningful agent activity.
 * These prove the agent received the prompt and is processing it.
 * AC: @invocation-initial-activity-watchdog ac-1, ac-3
 */
const MEANINGFUL_UPDATE_TYPES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "usage_update",
]);

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
  /** Shared lock file used to serialize shadow mutations across dispatch worktrees */
  mutationLockFile?: string;
  /** Called for each streaming update from the agent */
  onUpdate?: (update: SessionUpdate) => void;
  /**
   * Called after each event is appended to events.jsonl.
   * Used by the daemon to increment live event counters in the session cache.
   * AC: @session-summary-cache ac-live-counter
   */
  onEventAppended?: (sessionId: string) => void;
  /** Path to kspec CLI (defaults to the package CLI entrypoint under cli/) */
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
  outcome: "success" | "timed_out" | "failed" | "stalled";
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
function runKspecCli(
  args: string[],
  cwd: string,
  kspecCliPath: string,
  env?: Record<string, string>,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [kspecCliPath, ...args], {
    encoding: "utf-8",
    stdio: "pipe",
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
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
function addTaskNote(
  taskRef: string,
  note: string,
  cwd: string,
  kspecCliPath: string,
  env?: Record<string, string>,
  strict = false,
): void {
  const result = runKspecCli(["task", "note", taskRef, note], cwd, kspecCliPath, env);
  if (strict && result.status !== 0) {
    throw new DispatchMutationError(
      `Dispatch mutation failed while writing task note for ${taskRef}: ${result.stderr || result.stdout || "kspec task note exited non-zero"}`,
    );
  }
}

/**
 * Block a task via kspec CLI.
 */
function blockTask(
  taskRef: string,
  reason: string,
  cwd: string,
  kspecCliPath: string,
  env?: Record<string, string>,
  strict = false,
): void {
  const result = runKspecCli(["task", "block", taskRef, "--reason", reason], cwd, kspecCliPath, env);
  if (strict && result.status !== 0) {
    throw new DispatchMutationError(
      `Dispatch mutation failed while blocking ${taskRef}: ${result.stderr || result.stdout || "kspec task block exited non-zero"}`,
    );
  }
}

function toInvocationOutcome(metadata: SessionMetadata): InvocationResult["outcome"] | null {
  switch (metadata.status) {
    case "completed":
      return "success";
    case "timed_out":
      return "timed_out";
    case "failed":
      return "failed";
    case "stalled":
      // AC: @invocation-initial-activity-watchdog ac-4
      // Stalled sessions are transient infrastructure issues, not agent logic failures.
      // Excluded from consecutive failure count by returning null.
      return null;
    default:
      return null;
  }
}

/**
 * Get the current consecutive failure count for a task/agent from prior
 * invocation outcomes recorded in session metadata.
 */
async function getConsecutiveFailureCount(
  sessionsDir: string,
  taskRef: string,
  agentId: string,
): Promise<number> {
  const sessionIds = await listSessions(sessionsDir);
  const sessions = await Promise.all(sessionIds.map((sessionId) => getSession(sessionsDir, sessionId)));

  const relevantSessions = sessions
    .filter((session): session is SessionMetadata => session !== null)
    .filter((session) =>
      session.task_id === taskRef &&
      (session.agent_id ?? session.agent_type) === agentId,
    )
    .map((session) => ({
      ...session,
      invocationOutcome: toInvocationOutcome(session),
      sortMs: new Date(session.ended_at ?? session.started_at).getTime(),
    }))
    .filter((session) => session.invocationOutcome !== null && Number.isFinite(session.sortMs))
    .sort((a, b) => b.sortMs - a.sortMs);

  let consecutiveFailures = 0;
  for (const session of relevantSessions) {
    if (session.invocationOutcome === "failed") {
      consecutiveFailures++;
      continue;
    }
    break;
  }

  return consecutiveFailures;
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
    mutationLockFile,
    onUpdate,
    onEventAppended,
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
    // AC: @session-summary-cache ac-live-counter — notify cache of new event
    onEventAppended?.(sessionId);
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
        ...(mutationLockFile
          ? { KSPEC_SHADOW_MUTATION_LOCK_FILE: mutationLockFile }
          : {}),
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

    // ─── Stall watchdog state ──────────────────────────────────────────────
    // AC: @invocation-initial-activity-watchdog ac-1, ac-3
    let stallResolved = false;
    let stallHandle: ReturnType<typeof setTimeout> | undefined;

    // ─── Register update handler ──────────────────────────────────────────
    // AC: @agent-invocation-lifecycle ac-6
    const updateHandler = async (acpSessionId: string, update: SessionUpdate) => {
      if (acpSessionId !== state.acpSessionId) return;

      // AC: @invocation-initial-activity-watchdog ac-3
      // Cancel stall timer on first meaningful activity
      if (!stallResolved && MEANINGFUL_UPDATE_TYPES.has(update.sessionUpdate)) {
        stallResolved = true;
        clearTimeout(stallHandle);
      }

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

    // AC: @invocation-initial-activity-watchdog ac-1, ac-5
    const stallTimeoutSeconds =
      agent.budget?.initial_response_timeout_seconds ??
      DEFAULT_INITIAL_RESPONSE_TIMEOUT_SECONDS;
    const stallPromise = new Promise<never>((_, reject) => {
      stallHandle = setTimeout(() => {
        if (!stallResolved) {
          reject(new InvocationStallError(stallTimeoutSeconds));
        }
      }, stallTimeoutSeconds * 1000);
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
      const racers: Array<Promise<typeof promptResult | never>> = [promptPromise, timeoutPromise, stallPromise];
      if (abortPromise) racers.push(abortPromise);
      promptResult = await Promise.race(racers);
    } finally {
      // Clear timer handles to prevent leaks whether prompt resolves
      // normally or one of the race promises fires.
      clearTimeout(timeoutHandle);
      clearTimeout(stallHandle);
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
          mutationLockFile
            ? { KSPEC_SHADOW_MUTATION_LOCK_FILE: mutationLockFile }
            : undefined,
          Boolean(mutationLockFile),
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

    if (err instanceof InvocationStallError) {
      // ─── Handle stall (no initial response) ───────────────────────────
      // AC: @invocation-initial-activity-watchdog ac-1, ac-2
      try {
        if (state.acpSessionId && state.agent) {
          await state.agent.client.cancel(state.acpSessionId);
        }
      } catch {
        // Best-effort cancel
      }

      await appendSessionEvent({
        type: "agent.stalled",
        data: {
          task_id: taskRef,
          stall_timeout_seconds: err.stallTimeoutSeconds,
          duration_ms: durationMs,
        },
      });

      const finalSession = await closeSession(
        sessionsDir,
        sessionId,
        "stalled",
        `No initial response within ${err.stallTimeoutSeconds}s`,
      );

      // AC: @invocation-initial-activity-watchdog ac-2
      // Do NOT add task note — stalls are transient infrastructure issues
      // Do NOT call getConsecutiveFailureCount — stalls are excluded

      return {
        session: finalSession ?? session,
        outcome: "stalled",
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
        outcome: "failed",
        error: errorMessage,
        reason: errorMessage,
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
        mutationLockFile
          ? { KSPEC_SHADOW_MUTATION_LOCK_FILE: mutationLockFile }
          : undefined,
        Boolean(mutationLockFile),
      );

      // ─── Check retry threshold ────────────────────────────────────────────
      // AC: @agent-invocation-lifecycle ac-9
      const retryLimit = agent.budget?.max_retries ?? 3;
      const consecutiveFailures = await getConsecutiveFailureCount(sessionsDir, taskRef, agent.id);

      if (consecutiveFailures >= retryLimit) {
        blockTask(
          taskRef,
          `Agent ${agent.id} failed ${consecutiveFailures} consecutive times: ${errorMessage}`,
          cwd,
          kspecCliPath,
          mutationLockFile
            ? { KSPEC_SHADOW_MUTATION_LOCK_FILE: mutationLockFile }
            : undefined,
          Boolean(mutationLockFile),
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
 * Thrown when an agent accepts a prompt but produces no meaningful output
 * within the configured stall timeout.
 * AC: @invocation-initial-activity-watchdog ac-1, ac-2
 */
export class InvocationStallError extends Error {
  constructor(public readonly stallTimeoutSeconds: number) {
    super(`Agent stalled: no initial response within ${stallTimeoutSeconds}s`);
    this.name = "InvocationStallError";
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

export class DispatchMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchMutationError";
  }
}
