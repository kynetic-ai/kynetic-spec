/**
 * Agent Invocation Lifecycle — Multi-Turn
 *
 * Per-invocation session creation, ACP agent spawn, prompt delivery,
 * event logging, timeout handling, and structured completion tracking.
 *
 * The invocation runner implements an event-driven turn loop: after the
 * first prompt returns, the session transitions to idle state instead of
 * tearing down. A prompt queue accepts follow-up prompts from any source.
 * The runner loops: wait for prompt → send → wait for turn completion →
 * idle → repeat. The loop exits when a close is requested, the abort signal
 * fires, or the grace period expires with no queued prompts.
 *
 * Backward compatibility: when idleGracePeriodMs is 0 (the default) and no
 * prompts are queued, the session closes immediately after the first turn —
 * identical to the previous single-turn behavior.
 *
 * AC: @agent-invocation-lifecycle ac-1 through ac-11
 * AC: @multi-turn-session-lifecycle ac-1, ac-2, ac-3, ac-4, ac-8, ac-9,
 *      ac-10, ac-15, ac-16, ac-17
 */

import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { fileURLToPath } from "node:url";
import { ulid } from "ulid";
import type { Agent, SessionMode } from "../schema/meta.js";
import { buildPromptWithSkills } from "./prompts.js";
import {
  preflightRunnerInvocation,
  resolveRunnerInvocation,
  RunnerResolutionError,
  type RunnerInvocation,
} from "../agents/runners.js";
import { resolveEffectiveRunners, type EffectiveRunnerRegistry } from "../agents/runner-config.js";
import { diagnoseRegistryLoad, type RegistryLoadFailure } from "../agents/registry-load-failure.js";
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
import type { SessionHandle, SessionRegistry, SessionState } from "./session-registry.js";

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
 * Default maximum prompt queue depth.
 * AC: @multi-turn-session-lifecycle ac-17
 */
export const DEFAULT_MAX_PROMPT_QUEUE_DEPTH = 64;

/**
 * Default idle grace period in milliseconds.
 *
 * When a session enters idle with a session registry (meaning external
 * sources can deliver prompts asynchronously), this grace period gives
 * those sources time to deliver before the queue closes.
 *
 * The configurable grace period (task-idle-grace-period) will extend
 * this with per-agent configuration. This default ensures the session
 * stays open long enough for async prompt delivery without hanging
 * indefinitely.
 *
 * 5000 ms is the healthy default for dispatch agents with session.idle
 * hooks — it gives hook handlers (e.g. session_prompt for reflection)
 * enough time to queue a follow-up prompt before auto-close. Agents
 * can override this via session.idle_grace_period_ms.
 *
 * AC: @multi-turn-session-lifecycle ac-2
 * AC: @multi-turn-session-lifecycle ac-idle-hook-prompt-window
 */
export const DEFAULT_IDLE_GRACE_MS = 5000;

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

// ─── Prompt Queue ─────────────────────────────────────────────────────────────

/**
 * FIFO queue for follow-up prompts delivered to an active session.
 *
 * Consumers wait via waitForPrompt() which resolves when a prompt is
 * enqueued. Producers call enqueue() to deliver prompts. The queue has
 * a configurable maximum depth — enqueue() throws PromptQueueFullError
 * when the limit is reached. SessionHandle.sendPrompt() wraps enqueue()
 * and converts synchronous throws into rejected promises.
 *
 * AC: @multi-turn-session-lifecycle ac-8, ac-9, ac-17
 */
export class PromptQueue {
  private readonly queue: string[] = [];
  private waiter: { resolve: (prompt: string | null) => void } | null = null;
  private closed = false;

  constructor(private readonly maxDepth: number = DEFAULT_MAX_PROMPT_QUEUE_DEPTH) {}

  /**
   * Enqueue a prompt for delivery. If a consumer is waiting, delivers
   * immediately. Otherwise queues for later consumption.
   *
   * AC: @multi-turn-session-lifecycle ac-8 — queued when session is prompting
   * AC: @multi-turn-session-lifecycle ac-9 — FIFO ordering
   * AC: @multi-turn-session-lifecycle ac-17 — rejects when queue is full
   */
  enqueue(prompt: string): void {
    if (this.closed) {
      throw new Error("Prompt queue is closed");
    }
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve(prompt);
      return;
    }
    if (this.queue.length >= this.maxDepth) {
      throw new PromptQueueFullError(this.maxDepth);
    }
    this.queue.push(prompt);
  }

  /**
   * Wait for the next prompt. Resolves immediately if a prompt is
   * already queued, otherwise waits until one is enqueued or the
   * queue is closed.
   *
   * Returns null when the queue is closed with no pending prompts.
   */
  waitForPrompt(): Promise<string | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise<string | null>((resolve) => {
      this.waiter = { resolve };
    });
  }

  /**
   * Close the queue, discarding any pending prompts.
   * Resolves any waiting consumer with null.
   *
   * AC: @multi-turn-session-lifecycle ac-10, ac-16
   */
  close(): string[] {
    const discarded = [...this.queue];
    this.queue.length = 0;
    this.closed = true;
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve(null);
    }
    return discarded;
  }

  get pending(): number {
    return this.queue.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Idle context passed to the onIdle callback.
 * AC: @multi-turn-session-lifecycle ac-3
 */
export interface SessionIdleContext {
  sessionId: string;
  agentId: string;
  /**
   * Canonical full task ULID — the authoritative task identity when the session
   * is task-scoped. Identity consumers key off this, never the display ref.
   * AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
   */
  taskId: string | undefined;
  /** Display task ref for human-readable surfaces only; never an identity key. */
  taskRef: string | undefined;
  turnCount: number;
  stopReason: string | undefined;
  turnDurationMs: number;
}

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
  /**
   * Canonical full task ULID — the authoritative task identity for this
   * invocation. Dispatch resolves this via task-identity normalization and
   * passes it separately from the display ref so persisted session metadata and
   * session event history record identity (not a display alias). When omitted
   * (legacy/manual callers that never canonicalized), the display ref is used as
   * a best-effort identity fallback.
   * AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
   */
  taskId?: string;
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
  /**
   * Explicit adapter override (e.g., `kspec agent run --adapter <id>`).
   * Bypasses runner resolution and uses the override adapter directly.
   * AC: @cli-agent-commands ac-7
   */
  adapterOverride?: string;
  /**
   * Pre-loaded effective runner registry. When omitted, runInvocation
   * loads the layered runner config from the project root derived from
   * `specDir`. Tests can pass `{ runners: {} }` to skip the load entirely.
   * AC: @runner-resolution-and-preflight ac-one-shot-uses-runner-resolution
   * AC: @runner-resolution-and-preflight ac-dispatch-uses-runner-resolution
   */
  runnerRegistry?: EffectiveRunnerRegistry;
  /**
   * Pre-computed registry-load failures (one per failing config layer).
   * When supplied alongside `runnerRegistry`, the resolver surfaces a
   * `runner_registry_unavailable` diagnostic before any prompt is sent.
   * Omitted callers fall back to the internal layered loader, which
   * derives both fields itself.
   *
   * AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
   * AC: @runner-resolution-and-preflight ac-registry-load-failure-blocks-runner-spawn
   */
  runnerRegistryLoadFailures?: readonly RegistryLoadFailure[];
  /** Extra environment variables for the spawned agent */
  env?: Record<string, string>;
  /** Shared lock file used to serialize shadow mutations across dispatch worktrees */
  mutationLockFile?: string;
  /** Called for each streaming update from the agent */
  onUpdate?: (update: SessionUpdate) => void;
  /**
   * Called after each event is appended to events.jsonl.
   * Used by the daemon to increment live event counters in the entity cache.
   * AC: @daemon-entity-cache ac-session-event-tracking
   */
  onEventAppended?: (sessionId: string) => void;
  /** Path to kspec CLI (defaults to the package CLI entrypoint under cli/) */
  kspecCliPath?: string;
  /** Abort signal for graceful cancellation (AC-11) */
  abortSignal?: AbortSignal;
  /** Pre-assigned session ID (generated if not provided) */
  sessionId?: string;
  /**
   * Called when the session transitions to idle after a turn completes.
   * This is the hook point for emitting session.idle events on the event bus.
   * AC: @multi-turn-session-lifecycle ac-3
   */
  onIdle?: (context: SessionIdleContext) => void;
  /**
   * Session registry to register/unregister the session handle.
   * When provided, the runner creates a SessionHandle and registers it
   * before the first prompt, unregisters on session close.
   * AC: @active-session-registry ac-1, ac-2
   */
  sessionRegistry?: SessionRegistry;
  /**
   * Maximum depth of the prompt queue.
   * AC: @multi-turn-session-lifecycle ac-17
   */
  maxPromptQueueDepth?: number;
  /**
   * Grace period in milliseconds to wait for async prompt sources before
   * closing the queue after a turn completes with no queued prompts.
   * Defaults to 0 (immediate close, preserving single-turn backward compat).
   * Set to a positive value when async prompt delivery is enabled (e.g.,
   * session.idle hooks exist).
   * AC: @multi-turn-session-lifecycle ac-2, ac-11
   */
  idleGracePeriodMs?: number;
  /**
   * Session mode controlling auto-close behavior.
   * - "auto_close" (default): close when grace period expires with no prompt.
   * - "persistent": stay idle until explicit close, idle timeout, or prompt.
   * AC: @multi-turn-session-lifecycle ac-6
   */
  sessionMode?: SessionMode;
  /**
   * Maximum time in milliseconds a session can remain in idle state
   * before being forcibly closed. When set, an idle timeout timer starts
   * each time the session enters idle and is cleared when a prompt arrives.
   * On expiry, a session.idle_timeout event is logged and the session closes.
   * AC: @multi-turn-session-lifecycle ac-7
   */
  idleTimeoutMs?: number;
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
  /**
   * Number of turns completed in this session.
   * AC: @multi-turn-session-lifecycle ac-13, ac-14
   */
  turnCount: number;
}

/**
 * Internal state tracked during invocation execution.
 */
interface InvocationState {
  sessionId: string;
  specDir: string;
  taskRef: string | undefined;
  adapterId: string;
  runnerId: string | null;
  previousEnvValue?: string | null;
  agent: SpawnedAgent | null;
  acpSessionId: string | null;
  /** Resolver cleanup hook to run after session close. */
  runnerCleanup?: (() => Promise<void>) | undefined;
  /**
   * Runner contract redactor — scrubs resolved secret values from any
   * diagnostic string written to session events, task notes, close reasons,
   * block reasons, or other operator-visible surfaces.
   *
   * AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
   */
  redact: (text: string) => string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a kspec CLI command asynchronously.
 *
 * `env` is overlaid on top of the inherited host `process.env`. When
 * `stripFromHostEnv` is supplied, those keys are removed from the host
 * inheritance *before* the overlay — used by mutation helpers to drop
 * runner-resolved `env.secrets` so a `user_env`-sourced binding cannot
 * leak from the parent's process.env into kspec subprocesses.
 *
 * AC: @agent-dispatch-engine ac-28 — async to avoid blocking the event loop
 * AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
 * AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
 */
async function runKspecCli(
  args: string[],
  cwd: string,
  kspecCliPath: string,
  env?: Record<string, string>,
  stripFromHostEnv?: readonly string[],
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  try {
    let spawnEnv: NodeJS.ProcessEnv;
    if (stripFromHostEnv && stripFromHostEnv.length > 0) {
      const sanitizedHost: NodeJS.ProcessEnv = { ...process.env };
      for (const key of stripFromHostEnv) {
        delete sanitizedHost[key];
      }
      spawnEnv = env ? { ...sanitizedHost, ...env } : sanitizedHost;
    } else {
      spawnEnv = env ? { ...process.env, ...env } : process.env;
    }
    const result = await execFileAsync(process.execPath, [kspecCliPath, ...args], {
      encoding: "utf-8",
      cwd,
      env: spawnEnv,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: 0,
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      status: typeof e.code === "number" ? e.code : e.killed ? null : 1,
    };
  }
}

/**
 * Add a note to a task via kspec CLI.
 */
async function addTaskNote(
  taskRef: string,
  note: string,
  cwd: string,
  kspecCliPath: string,
  env?: Record<string, string>,
  strict = false,
  stripFromHostEnv?: readonly string[],
): Promise<void> {
  const result = await runKspecCli(
    ["task", "note", taskRef, note],
    cwd,
    kspecCliPath,
    env,
    stripFromHostEnv,
  );
  if (strict && result.status !== 0) {
    throw new DispatchMutationError(
      `Dispatch mutation failed while writing task note for ${taskRef}: ${result.stderr || result.stdout || "kspec task note exited non-zero"}`,
    );
  }
}

/**
 * Block a task via kspec CLI.
 */
async function blockTask(
  taskRef: string,
  reason: string,
  cwd: string,
  kspecCliPath: string,
  env?: Record<string, string>,
  strict = false,
  stripFromHostEnv?: readonly string[],
): Promise<void> {
  const result = await runKspecCli(
    ["task", "block", taskRef, "--reason", reason],
    cwd,
    kspecCliPath,
    env,
    stripFromHostEnv,
  );
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
  canonicalTaskId: string,
  displayRef: string | undefined,
  agentId: string,
): Promise<number> {
  const sessionIds = await listSessions(sessionsDir);
  const sessions = await Promise.all(
    sessionIds.map((sessionId) => getSession(sessionsDir, sessionId)),
  );

  // Match by canonical task identity. Fall back to the display ref so historical
  // sessions persisted before task_id carried the canonical ULID (task_id held a
  // display ref) still count toward the same task's failure streak.
  // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
  const relevantSessions = sessions
    .filter((session): session is SessionMetadata => session !== null)
    .filter((session) => {
      const sameAgent = (session.agent_id ?? session.agent_type) === agentId;
      if (!sameAgent) return false;
      if (session.task_id === canonicalTaskId) return true;
      if (displayRef !== undefined) {
        return session.task_ref === displayRef || session.task_id === displayRef;
      }
      return false;
    })
    .map((session) => ({
      ...session,
      invocationOutcome: toInvocationOutcome(session),
      sortMs: new Date(session.ended_at ?? session.started_at).getTime(),
    }))
    .filter((session) => session.invocationOutcome !== null && Number.isFinite(session.sortMs))
    .toSorted((a, b) => b.sortMs - a.sortMs);

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
 * Run an agent invocation with multi-turn lifecycle support.
 *
 * Creates a session, spawns the agent, injects KSPEC_SESSION_ID,
 * sends the initial prompt, then enters a turn loop. After each turn
 * completes, the session transitions to idle and the onIdle callback
 * fires. If a follow-up prompt is queued (via the session handle's
 * prompt queue), the next turn begins. Otherwise, the session closes.
 *
 * The session handle is registered in the session registry (if provided)
 * so that external components (action executors, hooks) can deliver
 * follow-up prompts to the live session.
 *
 * AC: @agent-invocation-lifecycle ac-1 through ac-11
 * AC: @multi-turn-session-lifecycle ac-1, ac-2, ac-3, ac-4, ac-8, ac-9,
 *      ac-10, ac-15, ac-16, ac-17
 */
export async function runInvocation(options: InvocationOptions): Promise<InvocationResult> {
  const {
    agent,
    specDir,
    cwd,
    taskId,
    taskRef,
    trigger,
    autoApprove = agent.auto_approve,
    env = {},
    mutationLockFile,
    onUpdate,
    onEventAppended,
    kspecCliPath = DEFAULT_KSPEC_CLI_PATH,
    abortSignal,
    onIdle,
    sessionRegistry,
    maxPromptQueueDepth = DEFAULT_MAX_PROMPT_QUEUE_DEPTH,
    idleGracePeriodMs = 0,
    sessionMode = "auto_close",
    idleTimeoutMs,
  } = options;

  // Canonical task identity for persisted session metadata and session event
  // history: prefer the resolved canonical task id, falling back to the display
  // ref only for legacy/manual callers that never canonicalized. The display
  // ref is retained separately for human-readable surfaces and CLI command text.
  // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
  const canonicalTaskId = taskId ?? taskRef;
  const displayTaskRef = taskRef;

  // AC: @session-storage-path-resolution ac-resolver
  // Sessions live in .kspec-sessions/ at project root, not inside .kspec/
  const sessionsDir = options.sessionsDir ?? path.join(path.dirname(specDir), ".kspec-sessions");

  const startTime = Date.now();
  const sessionId = options.sessionId ?? ulid();

  // ─── Resolve runner invocation contract ─────────────────────────────────
  // AC: @runner-resolution-and-preflight ac-one-shot-uses-runner-resolution
  // AC: @runner-resolution-and-preflight ac-dispatch-uses-runner-resolution
  // AC: @runner-resolution-and-preflight ac-invalid-runner-blocks-before-prompt
  //
  // The resolver runs BEFORE any prompt is built or sent — failures here
  // surface as exceptions without spawning the adapter process. The resolver
  // synthesizes the kspec-required invocation variables
  // (KSPEC_NO_DAEMON, KSPEC_SESSION_ID, KSPEC_SHADOW_MUTATION_LOCK_FILE) so
  // they are part of the resolved contract for both runner-backed and
  // implicit/legacy paths.
  // AC: @runner-invocation-semantics ac-session-env-injected-through-runner
  let runnerRegistry: EffectiveRunnerRegistry;
  let runnerRegistryLoadFailures: readonly RegistryLoadFailure[];
  if (options.runnerRegistry !== undefined) {
    runnerRegistry = options.runnerRegistry;
    runnerRegistryLoadFailures = options.runnerRegistryLoadFailures ?? [];
  } else {
    // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
    // AC: @runner-resolution-and-preflight ac-registry-load-failure-blocks-runner-spawn
    // Load layer state ourselves so the resolver sees both the registry
    // and any registry-load failures. A runner-backed agent that cannot
    // resolve because the registry is unloadable surfaces as
    // `runner_registry_unavailable` rather than `unknown_runner`.
    const loaded = await loadRunnerRegistrySafely(specDir);
    runnerRegistry = loaded.registry;
    runnerRegistryLoadFailures = loaded.failures;
  }

  const contract: RunnerInvocation = resolveRunnerInvocation({
    agent,
    registry: runnerRegistry,
    cwd,
    sessionId,
    autoApprove,
    env,
    mutationLockFile,
    adapterOverride: options.adapterOverride,
    registryLoadFailures: runnerRegistryLoadFailures,
  });

  // Preflight runner-configured executables before any prompt is built.
  // Surfaces unspawnable commands as typed diagnostics (RunnerResolutionError
  // with reason "unspawnable_command") so failures are visible in the same
  // shape as other runner-resolution errors and never leak as anonymous spawn
  // ENOENTs.
  //
  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  await preflightRunnerInvocation(contract);

  const adapterId = contract.adapterId;
  const adapter = contract.adapter;
  const extraArgs = contract.extraArgs;
  // Capture the runner contract's redactor so every diagnostic write below
  // (session events, close reasons, task notes, block reasons, adapter
  // stderr) scrubs any resolved secret value before persisting.
  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  const redact = contract.redact;

  // Resolve timeout: option overrides agent budget (applies to total session duration)
  const timeoutMinutes = options.timeoutMinutes ?? agent.budget?.timeout_minutes ?? 30;
  const timeoutMs = timeoutMinutes * 60 * 1000;
  // Keep ACP request timeout slightly above invocation timeout so the outer
  // lifecycle controls timeout behavior (cancel + timeout note), not framing.
  const promptRequestTimeoutMs = Math.max(1, Math.ceil(timeoutMs + 5_000));

  // Resolve skill content for prompt
  // AC: @agent-invocation-lifecycle ac-7
  // AC: @runner-invocation-semantics ac-skill-formatting-uses-resolved-adapter
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
    runnerId: contract.runnerId,
    previousEnvValue: undefined,
    agent: null,
    acpSessionId: null,
    runnerCleanup: contract.cleanup,
    redact,
  };

  const invocationEnv: Record<string, string> = contract.env;
  // Sanitized env passed to internal kspec mutation subprocesses
  // (`kspec task note`, `kspec task block`). Resolved env.secrets and
  // runner env.set/env.pass/env.inherit values live in `contract.env` and
  // are intended for the adapter spawn only; they must NEVER reach kspec
  // subprocesses whose only need is the dispatch contract (KSPEC_NO_DAEMON,
  // KSPEC_SESSION_ID, KSPEC_SHADOW_MUTATION_LOCK_FILE).
  //
  // Two defenses run together below:
  //   - `mutationEnv` contains only kspec-required vars, so the overlay
  //     itself can never inject a secret.
  //   - `mutationSecretStripKeys` lists the env var names that were
  //     resolved from `env.secrets`, so the spawner strips them from
  //     `process.env` before overlay — closing the `user_env` leak path
  //     where the parent's process.env already mirrors the secret.
  //
  // AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  const mutationEnv: Record<string, string> = contract.mutationEnv;
  const mutationSecretStripKeys: readonly string[] = contract.secretEnvKeys;

  // ─── Prompt queue for multi-turn ─────────────────────────────────────────
  // AC: @multi-turn-session-lifecycle ac-8, ac-9, ac-17
  const promptQueue = new PromptQueue(maxPromptQueueDepth);

  // Session state for the handle
  // AC: @multi-turn-session-lifecycle ac-1, ac-2
  let sessionState: SessionState = "prompting";
  let closeRequested = false;
  let closeReason: string | undefined;
  let turnCount = 0;

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
    // AC: @daemon-entity-cache ac-session-event-tracking — notify cache of new event
    onEventAppended?.(sessionId);
  };

  // ─── Session handle for registry ─────────────────────────────────────────
  // AC: @active-session-registry ac-1
  // AC: @multi-turn-session-lifecycle ac-2, ac-4
  const sessionHandle: SessionHandle = {
    sendPrompt(prompt: string): Promise<void> {
      if (sessionState === "closed") {
        return Promise.reject(new Error("Session is closed"));
      }
      // AC: @multi-turn-session-lifecycle ac-4 — deliver prompt
      // AC: @multi-turn-session-lifecycle ac-8 — queue when prompting
      // AC: @multi-turn-session-lifecycle ac-17 — reject when full
      try {
        promptQueue.enqueue(prompt);
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    },
    getState(): SessionState {
      return sessionState;
    },
    requestClose(reason: string): void {
      // AC: @multi-turn-session-lifecycle ac-10
      closeRequested = true;
      closeReason = reason;
      // Close the prompt queue so the turn loop wakes up and exits
      promptQueue.close();
    },
  };

  // ─── Create session ───────────────────────────────────────────────────────
  // AC: @agent-invocation-lifecycle ac-1
  // AC: @runner-resolution-and-preflight ac-session-metadata-records-runner
  const session = await createSession(sessionsDir, {
    id: sessionId,
    agent_type: adapterId,
    agent_id: agent.id,
    trigger,
    // Canonical task identity is the persisted task_id; the display ref is kept
    // separate. AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
    task_id: canonicalTaskId,
    task_ref: displayTaskRef,
    // Conditionally include runner so legacy invocations omit the field.
    ...(contract.runnerId ? { runner: contract.runnerId } : {}),
  });

  // ─── Log agent.dispatched event ───────────────────────────────────────────
  // AC: @runner-resolution-and-preflight ac-dispatched-event-records-runner
  await appendSessionEvent({
    type: "agent.dispatched",
    data: {
      task_id: canonicalTaskId,
      task_ref: displayTaskRef,
      agent_id: agent.id,
      adapter: adapterId,
      trigger,
      // runner is present only when a named runner resolved the invocation.
      ...(contract.runnerId ? { runner: contract.runnerId } : {}),
    },
  });

  try {
    // ─── Inject KSPEC_SESSION_ID ──────────────────────────────────────────
    // AC: @agent-invocation-lifecycle ac-2
    const injectionResult = await injectEnvForAdapter(adapterId, sessionId);
    state.previousEnvValue = injectionResult?.previousValue;

    // ─── Spawn agent ──────────────────────────────────────────────────────
    // The contract env already contains KSPEC_SESSION_ID + KSPEC_NO_DAEMON
    // (synthesized by the resolver), so the spawner consumes it verbatim
    // without re-overlaying session-id mid-flight.
    // AC: @runner-invocation-semantics ac-session-env-injected-through-runner
    state.agent = await spawnAndInitialize(adapter, {
      cwd: contract.cwd,
      env: invocationEnv,
      extraArgs: [...extraArgs],
      // Runner-backed invocations turn off host process.env inheritance so
      // the runner's env.inherit/pass/set policy is the only source of host
      // env in the child.
      // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
      inheritParentEnv: contract.inheritParentEnv,
      // Pass the resolved redactor so adapter stderr cannot leak resolved
      // secret values to operator-visible output.
      // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
      redact,
      clientOptions: {
        methodTimeouts: {
          "session/prompt": promptRequestTimeoutMs,
        },
      },
    });

    // ─── Create ACP session ───────────────────────────────────────────────
    // AC: @runner-process-invocation-inputs ac-runner-cwd-is-invocation-only
    state.acpSessionId = await state.agent.client.newSession({
      cwd: contract.cwd,
      mcpServers: [],
    });

    // ─── Log agent.started event ──────────────────────────────────────────
    await appendSessionEvent({
      type: "agent.started",
      data: {
        task_id: canonicalTaskId,
        task_ref: displayTaskRef,
        agent_id: agent.id,
        acp_session_id: state.acpSessionId,
      },
    });

    // ─── Register session handle ─────────────────────────────────────────
    // Register inside try block after successful session creation to prevent
    // dead handles in the registry. The finally block's unregister() is
    // guaranteed to run for cleanup.
    // AC: @active-session-registry ac-1, ac-2
    if (sessionRegistry) {
      sessionRegistry.register(sessionId, sessionHandle);
    }

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

    // ─── Session-level timeout (applies to total session duration) ────────
    // AC: @agent-invocation-lifecycle ac-3
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new InvocationTimeoutError(timeoutMinutes));
      }, timeoutMs);
    });

    // AC: @invocation-initial-activity-watchdog ac-1, ac-5
    const stallTimeoutSeconds =
      agent.budget?.initial_response_timeout_seconds ?? DEFAULT_INITIAL_RESPONSE_TIMEOUT_SECONDS;
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
            abortSignal.addEventListener("abort", () => reject(new InvocationAbortedError()), {
              once: true,
            });
          }
        })
      : null;

    // ─── Turn loop ────────────────────────────────────────────────────────
    // AC: @multi-turn-session-lifecycle ac-1, ac-2, ac-4
    let currentPromptText: string = fullPrompt;
    let lastStopReason: string | undefined;
    let idleGraceHandle: ReturnType<typeof setTimeout> | undefined;
    let idleTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // ─── Prompting state ─────────────────────────────────────────────
        sessionState = "prompting";
        const turnStartTime = Date.now();

        const promptPromise: Promise<{ stopReason: string }> = state.agent.client.prompt({
          sessionId: state.acpSessionId,
          prompt: [{ type: "text", text: currentPromptText }],
        });

        const racers: Array<Promise<{ stopReason: string } | never>> = [
          promptPromise,
          timeoutPromise,
        ];
        // Stall watchdog only applies to the first turn
        if (turnCount === 0) {
          racers.push(stallPromise);
        }
        if (abortPromise) racers.push(abortPromise);

        let promptResult: { stopReason: string };
        try {
          promptResult = await Promise.race(racers);
        } finally {
          // Clear stall handle after first turn (it only applies to initial response)
          if (turnCount === 0) {
            clearTimeout(stallHandle);
          }
        }

        turnCount++;
        lastStopReason = promptResult.stopReason;
        const turnDurationMs = Date.now() - turnStartTime;

        // ─── Log turn completion event ─────────────────────────────────
        // AC: @multi-turn-session-lifecycle ac-1
        await appendSessionEvent({
          type: "agent.turn_completed",
          data: {
            task_id: canonicalTaskId,
            task_ref: displayTaskRef,
            turn_count: turnCount,
            stop_reason: promptResult.stopReason,
            turn_duration_ms: turnDurationMs,
          },
        });

        // ─── Check for close request ───────────────────────────────────
        // AC: @multi-turn-session-lifecycle ac-10
        if (closeRequested) {
          // Discard queued prompts and break
          promptQueue.close();
          break;
        }

        // ─── Transition to idle ────────────────────────────────────────
        // AC: @multi-turn-session-lifecycle ac-1, ac-2
        sessionState = "idle";

        // AC: @multi-turn-session-lifecycle ac-3 — emit idle event
        onIdle?.({
          sessionId,
          agentId: agent.id,
          taskId: canonicalTaskId,
          taskRef: displayTaskRef,
          turnCount,
          stopReason: promptResult.stopReason,
          turnDurationMs,
        });

        // ─── Wait for next prompt or close ─────────────────────────────
        // AC: @multi-turn-session-lifecycle ac-2, ac-4
        //
        // Yield a microtask to let synchronous onIdle callbacks enqueue
        // prompts before checking the queue.
        await Promise.resolve();

        // Check if a close was requested during idle callback
        if (closeRequested) {
          promptQueue.close();
          break;
        }

        // If no prompt was queued during the idle transition, decide
        // whether to keep the session open or close it based on session
        // mode and grace period configuration.
        //
        // Three modes of operation:
        //
        // 1. auto_close + grace period = 0: close immediately.
        //    Preserves backward compatibility: single-turn invocations
        //    exit after one turn with no delay.
        //    AC: @multi-turn-session-lifecycle ac-11
        //
        // 2. auto_close + grace period > 0: wait for async sources to
        //    deliver prompts within the grace period, then close.
        //    AC: @multi-turn-session-lifecycle ac-5
        //
        // 3. persistent: do not auto-close on grace period expiry.
        //    Session stays idle until a prompt arrives, an explicit
        //    close is requested, or the idle timeout fires.
        //    AC: @multi-turn-session-lifecycle ac-6
        if (promptQueue.pending === 0 && !promptQueue.isClosed) {
          if (sessionMode === "auto_close") {
            if (idleGracePeriodMs <= 0) {
              promptQueue.close();
            } else {
              // Grace period: wait briefly for async prompt sources
              // before closing the queue. This races with waitForPrompt
              // below — if a prompt arrives first, the grace timer is
              // cleared after the race resolves.
              // AC: @multi-turn-session-lifecycle ac-5
              idleGraceHandle = setTimeout(() => {
                if (promptQueue.pending === 0 && !promptQueue.isClosed) {
                  promptQueue.close();
                }
              }, idleGracePeriodMs);
            }
          }
          // persistent mode: no grace-based close — only idle timeout,
          // explicit close, or session-level timeout will end the session.
          // AC: @multi-turn-session-lifecycle ac-6
        }

        // AC: @multi-turn-session-lifecycle ac-7 — idle timeout timer
        // Start an idle timeout timer if configured. This fires when the
        // session has been idle for longer than idleTimeoutMs. It applies
        // in both auto_close and persistent modes.
        let idleTimeoutPromise: Promise<never> | null = null;
        if (idleTimeoutMs != null && idleTimeoutMs > 0) {
          idleTimeoutPromise = new Promise<never>((_, reject) => {
            idleTimeoutHandle = setTimeout(() => {
              reject(new InvocationIdleTimeoutError(idleTimeoutMs));
            }, idleTimeoutMs);
          });
        }

        // Race the prompt queue against the session timeout, idle timeout, and abort
        const nextPromptPromise = promptQueue.waitForPrompt();
        const idleRacers: Array<Promise<string | null | never>> = [
          nextPromptPromise,
          timeoutPromise as Promise<never>,
        ];
        if (idleTimeoutPromise) idleRacers.push(idleTimeoutPromise);
        if (abortPromise) idleRacers.push(abortPromise as Promise<never>);

        const nextPrompt = await Promise.race(idleRacers);

        // Clear the grace and idle timeout timers — either a prompt
        // arrived, the session timed out, or the queue closed. The
        // timers must not fire during a subsequent turn.
        clearTimeout(idleGraceHandle);
        idleGraceHandle = undefined;
        clearTimeout(idleTimeoutHandle);
        idleTimeoutHandle = undefined;

        if (nextPrompt === null) {
          // Queue closed or no more prompts — exit turn loop
          break;
        }

        // AC: @multi-turn-session-lifecycle ac-10 — re-check close after dequeue
        // A close request may have arrived after the prompt was dequeued.
        // Honor the close: discard the prompt and exit rather than starting
        // another turn with a session that was asked to stop.
        if (closeRequested) {
          promptQueue.close();
          break;
        }

        // AC: @multi-turn-session-lifecycle ac-4 — deliver follow-up prompt
        currentPromptText = nextPrompt;
      }
    } finally {
      // Clear all timer handles regardless of how we exit
      clearTimeout(timeoutHandle);
      clearTimeout(stallHandle);
      clearTimeout(idleGraceHandle);
      clearTimeout(idleTimeoutHandle);
    }

    // ─── Log agent.completed event ────────────────────────────────────────
    // AC: @agent-invocation-lifecycle ac-4
    const durationMs = Date.now() - startTime;
    await appendSessionEvent({
      type: "agent.completed",
      data: {
        task_id: canonicalTaskId,
        task_ref: displayTaskRef,
        outcome: "success",
        stop_reason: lastStopReason,
        duration_ms: durationMs,
        turn_count: turnCount,
      },
    });

    // ─── Close session as completed ───────────────────────────────────────
    const sessionCloseReason = closeReason ?? "Invocation completed normally";
    const finalSession = await closeSession(
      sessionsDir,
      sessionId,
      "completed",
      sessionCloseReason,
    );

    return {
      session: finalSession ?? session,
      outcome: "success",
      stopReason: lastStopReason,
      durationMs,
      turnCount,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;

    // AC: @multi-turn-session-lifecycle ac-15, ac-16
    // On any error, close the prompt queue so waiters fail
    const discardedPrompts = promptQueue.close();
    if (discardedPrompts.length > 0) {
      // AC: @multi-turn-session-lifecycle ac-16 — log discarded prompts
      // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
      await appendSessionEvent({
        type: "session.prompts_discarded",
        data: {
          session_id: sessionId,
          discarded_count: discardedPrompts.length,
          reason: redact(err instanceof Error ? err.message : String(err)),
        },
      });
    }

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
          task_id: canonicalTaskId,
          task_ref: displayTaskRef,
          timeout_minutes: timeoutMinutes,
          duration_ms: durationMs,
          turn_count: turnCount,
        },
      });

      const finalSession = await closeSession(
        sessionsDir,
        sessionId,
        "timed_out",
        `Timeout after ${timeoutMinutes} minutes`,
      );

      // Add timeout note to task (only when a task is bound)
      if (taskRef) {
        await addTaskNote(
          taskRef,
          `[AGENT-TIMEOUT] Invocation timed out after ${timeoutMinutes} minutes`,
          cwd,
          kspecCliPath,
          mutationEnv,
          Boolean(mutationLockFile),
          mutationSecretStripKeys,
        );
      }

      return {
        session: finalSession ?? session,
        outcome: "timed_out",
        error: redact(err.message),
        durationMs,
        turnCount,
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

      const finalSession = await closeSession(
        sessionsDir,
        sessionId,
        "failed",
        "Invocation aborted by shutdown",
      );

      return {
        session: finalSession ?? session,
        outcome: "failed",
        error: redact(err.message),
        durationMs,
        turnCount,
      };
    }

    if (err instanceof InvocationIdleTimeoutError) {
      // ─── Handle idle timeout ────────────────────────────────────────
      // AC: @multi-turn-session-lifecycle ac-7
      try {
        if (state.acpSessionId && state.agent) {
          await state.agent.client.cancel(state.acpSessionId);
        }
      } catch {
        // Best-effort cancel
      }

      await appendSessionEvent({
        type: "session.idle_timeout",
        data: {
          session_id: sessionId,
          task_id: canonicalTaskId,
          task_ref: displayTaskRef,
          idle_timeout_ms: err.idleTimeoutMs,
          duration_ms: durationMs,
          turn_count: turnCount,
        },
      });

      const finalSession = await closeSession(
        sessionsDir,
        sessionId,
        "timed_out",
        `Session idle timeout after ${err.idleTimeoutMs}ms`,
      );

      return {
        session: finalSession ?? session,
        outcome: "timed_out",
        error: redact(err.message),
        durationMs,
        turnCount,
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
          task_id: canonicalTaskId,
          task_ref: displayTaskRef,
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
        error: redact(err.message),
        durationMs,
        turnCount,
      };
    }

    // ─── Handle failure ──────────────────────────────────────────────────
    // AC: @agent-invocation-lifecycle ac-5
    // AC: @multi-turn-session-lifecycle ac-15
    //
    // Scrub the raw error message through the runner contract's redactor
    // before it touches any operator-visible surface (session event, session
    // close reason, task note, block reason, returned InvocationResult).
    // Spawn errors and ACP RPC errors can include adapter-side text that
    // happens to contain a resolved secret literal — redaction at the
    // boundary blocks the leak regardless of the failure origin.
    // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
    const rawErrorMessage = err instanceof Error ? err.message : String(err);
    const errorMessage = redact(rawErrorMessage);

    await appendSessionEvent({
      type: "agent.failed",
      data: {
        task_id: canonicalTaskId,
        task_ref: displayTaskRef,
        outcome: "failed",
        error: errorMessage,
        reason: errorMessage,
        duration_ms: durationMs,
        turn_count: turnCount,
      },
    });

    const finalSession = await closeSession(
      sessionsDir,
      sessionId,
      "failed",
      `Invocation failed: ${errorMessage}`,
    );

    // Add failure note to task and check retry threshold (only when a task is bound)
    if (taskRef) {
      await addTaskNote(
        taskRef,
        `[AGENT-FAIL] Invocation failed: ${errorMessage}`,
        cwd,
        kspecCliPath,
        mutationEnv,
        Boolean(mutationLockFile),
        mutationSecretStripKeys,
      );

      // ─── Check retry threshold ────────────────────────────────────────────
      // AC: @agent-invocation-lifecycle ac-9
      const retryLimit = agent.budget?.max_retries ?? 3;
      const consecutiveFailures = await getConsecutiveFailureCount(
        sessionsDir,
        canonicalTaskId ?? taskRef,
        displayTaskRef,
        agent.id,
      );

      if (consecutiveFailures >= retryLimit) {
        await blockTask(
          taskRef,
          `Agent ${agent.id} failed ${consecutiveFailures} consecutive times: ${errorMessage}`,
          cwd,
          kspecCliPath,
          mutationEnv,
          Boolean(mutationLockFile),
          mutationSecretStripKeys,
        );
      }
    }

    return {
      session: finalSession ?? session,
      outcome: "failed",
      error: errorMessage,
      durationMs,
      turnCount,
    };
  } finally {
    // ─── Cleanup ──────────────────────────────────────────────────────────
    // AC: @agent-invocation-lifecycle ac-8

    // Mark session as closed so handle rejects further prompts
    sessionState = "closed";

    // Close prompt queue to release any waiters
    // AC: @multi-turn-session-lifecycle ac-16
    promptQueue.close();

    // Unregister from session registry
    // AC: @active-session-registry ac-2
    if (sessionRegistry) {
      sessionRegistry.unregister(sessionId);
    }

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

    // Run resolver cleanup hook (no-op for runner kinds without temp state).
    if (state.runnerCleanup) {
      try {
        await state.runnerCleanup();
      } catch {
        // Best-effort: cleanup must never propagate failures.
      }
    }
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

/**
 * Thrown when a session has been idle longer than the configured idle
 * timeout (idleTimeoutMs). Distinct from InvocationTimeoutError which
 * covers total session duration.
 * AC: @multi-turn-session-lifecycle ac-7
 */
export class InvocationIdleTimeoutError extends Error {
  constructor(public readonly idleTimeoutMs: number) {
    super(`Session idle timeout after ${idleTimeoutMs}ms`);
    this.name = "InvocationIdleTimeoutError";
  }
}

export class DispatchMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchMutationError";
  }
}

/**
 * Thrown when the prompt queue is full and a new prompt is submitted.
 * AC: @multi-turn-session-lifecycle ac-17
 */
export class PromptQueueFullError extends Error {
  constructor(public readonly maxDepth: number) {
    super(`Prompt queue is full (maximum depth: ${maxDepth})`);
    this.name = "PromptQueueFullError";
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load the effective runner registry from the project derived from `specDir`.
 *
 * Returns an empty registry on I/O failure so legacy invocations (no project
 * or system runner config on disk) behave identically to the pre-runner code
 * path. Parse / validation failures are captured as `failures` so the
 * resolver can surface them as `runner_registry_unavailable` for runner-backed
 * agents instead of collapsing them into `unknown_runner`.
 */
async function loadRunnerRegistrySafely(specDir: string): Promise<{
  registry: EffectiveRunnerRegistry;
  failures: readonly RegistryLoadFailure[];
}> {
  try {
    const projectRoot = path.dirname(specDir);
    const result = await resolveEffectiveRunners({
      projectRoot,
      shadowWorktreeDir: specDir,
    });
    return {
      registry: result.registry,
      failures: diagnoseRegistryLoad(result),
    };
  } catch {
    return { registry: { runners: {} }, failures: [] };
  }
}

// Surface RunnerResolutionError to callers without re-importing from agents.
export { RunnerResolutionError };
