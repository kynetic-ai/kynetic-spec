/**
 * Agent Dispatch API Routes
 *
 * REST endpoints for agent dispatch engine management:
 * - POST /api/agent/dispatch/start  - Start the dispatch engine (legacy)
 * - POST /api/agent/dispatch/stop   - Stop the dispatch engine (legacy)
 * - GET  /api/agent/dispatch/status - Get dispatch engine status (internal format)
 * - POST /api/agent/dispatch        - Unified start/stop via action field
 * - GET  /api/agent/status          - Public status with dispatch_enabled, active_invocations, queue_depth, agent_definitions
 * - POST /api/agent/events          - Post a task state change event (from CLI)
 * - POST /api/agent/event           - Alias for /api/agent/events (legacy)
 *
 * AC Coverage:
 * - @daemon-agent-dispatch ac-2: CLI posts state change event to POST /api/agent/events
 * - @daemon-agent-dispatch ac-3, ac-4: WebSocket broadcast on invocation start/complete/fail
 * - @daemon-agent-dispatch ac-5: GET /api/agent/status returns public status shape
 * - @daemon-agent-dispatch ac-6: POST /api/agent/dispatch with action start|stop
 * - @daemon-agent-dispatch ac-7: Event emission fails silently when engine not running
 * - @agent-dispatch-engine ac-4: CLI posts state change event to daemon
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Elysia, t } from "elysia";
import { DispatchEngine } from "../../agent-runtime/dispatch.js";
import type {
  TaskStateChange,
  TaskStatus,
  InvocationEvent,
  SyncStateEvent,
  DispatchControlLifecycleEvent,
} from "../../agent-runtime/dispatch.js";
import {
  assertTaskLifecycleTransition,
  DispatchCleanupError,
  DispatchLifecycleTransitionError,
  resolveGlobalLifecycleTransition,
} from "../../agent-runtime/dispatch.js";
import {
  getOrCreateDispatchControlStore,
  projectDispatchCleanupState,
} from "../../agent-runtime/dispatch-control-store.js";
import { DispatchShadowTransactionError } from "../../agent-runtime/dispatch-shadow-transaction.js";
import { ScheduleEngine } from "../../agent-runtime/schedule-engine.js";
import { HookExecutor } from "../../agent-runtime/hook-executor.js";
import { JoinAccumulator } from "../../agent-runtime/join-accumulator.js";
import { ActionExecutor, type AgentSpawner } from "../../agent-runtime/action-executor.js";
import { SessionRegistry } from "../../agent-runtime/session-registry.js";
import { DEFAULT_KSPEC_CLI_PATH, runInvocation } from "../../agent-runtime/invocation.js";
import {
  normalizeTaskIdentity,
  buildTaskRefResolver,
  requireCanonicalTaskIdentity,
  TaskIdentityResolutionError,
  type CanonicalTaskIdentity,
} from "../../agent-runtime/task-identity.js";
import { ulid } from "ulid";
import {
  initContext,
  loadMetaContext,
  loadAllItems,
  ReferenceIndex,
  resolveProjectRoots,
  resolveTaskDataManager,
} from "../../parser/index.js";
import { getCompletedSessionCountsByAgent } from "../../sessions/store.js";
import { TaskStatusSchema } from "../../schema/common.js";
import type { PubSubManager } from "../websocket/pubsub.js";
import type { SessionEventData } from "@kynetic-ai/shared";
import type { DispatchControlErrorCode, DispatchLifecycleStatus } from "@kynetic-ai/shared";
import { enumUnion } from "./enum-utils.js";
import {
  resolveEffectiveRunners,
  type EffectiveRunnerRegistry,
} from "../../agents/runner-config.js";
import {
  diagnoseRegistryLoad,
  summarizeRegistryLoadFailure,
  type RegistryLoadFailure,
} from "../../agents/registry-load-failure.js";

const VALID_TASK_STATUSES = new Set(TaskStatusSchema.options);

// Singleton dispatch engine per project path
const engines: Map<string, DispatchEngine> = new Map();
// Singleton schedule engine per project path (started alongside dispatch)
const scheduleEngines: Map<string, ScheduleEngine> = new Map();
// Singleton hook executor per project path (started alongside dispatch)
const hookExecutors: Map<string, HookExecutor> = new Map();
// Singleton join accumulator per project path (started alongside dispatch)
const joinAccumulators: Map<string, JoinAccumulator> = new Map();
// Singleton session registry per project path (shared with action executors for session_prompt actions)
// AC: @session-prompt-action ac-1
// Session registries are owned by DispatchEngine instances — use engine.sessionRegistry

export interface AgentDispatchRouteOptions {
  defaultProjectPath?: string;
  /** PubSubManager for broadcasting agent invocation events to WebSocket clients */
  pubsub?: PubSubManager;
}

// Session registry is created by DispatchEngine and accessed via engine.sessionRegistry

/**
 * Create a new dispatch engine with optional WebSocket broadcast wiring.
 * AC: @daemon-agent-dispatch ac-3, ac-4
 */
function createEngine(projectDir: string, cwd?: string, pubsub?: PubSubManager): DispatchEngine {
  return new DispatchEngine({
    projectDir,
    cwd,
    kspecCliPath: DEFAULT_KSPEC_CLI_PATH,
    onInvocationEvent: pubsub
      ? (event: InvocationEvent) => {
          // AC: @ui-api-aggregation ac-4 - Include task_title for display
          // AC: @runner-resolution-and-preflight ac-dispatched-event-records-runner
          pubsub.broadcast(
            "agents",
            "agent_invocation",
            {
              session_id: event.session_id,
              agent_id: event.agent_id,
              task_id: event.task_id ?? null,
              task_title: event.task_title ?? null,
              status: event.status,
              timestamp: event.timestamp,
              ...(event.resolved_adapter ? { resolved_adapter: event.resolved_adapter } : {}),
              ...(event.runner ? { runner: event.runner } : {}),
            },
            projectDir,
          );
        }
      : undefined,
    // AC: @session-event-broadcast ac-replaces-text-chunks
    // AC: @cli-agent-commands ac-13, @daemon-agent-dispatch ac-8
    onSessionEvent: pubsub
      ? (event: SessionEventData) => {
          pubsub.broadcast("agents", event.type, event, projectDir);
        }
      : undefined,
    // AC: @dispatch-remote-branch-sync ac-degraded-status-broadcast
    onSyncStateEvent: pubsub
      ? (event: SyncStateEvent) => {
          pubsub.broadcast("agents", event.type, event, projectDir);
        }
      : undefined,
    onDispatchControlEvent: pubsub
      ? (event: DispatchControlLifecycleEvent) => {
          pubsub.broadcast("agents", event.type, event.data, projectDir);
        }
      : undefined,
  });
}

function serializeDegradedTargets(engine: DispatchEngine): Array<{
  branch: string;
  reason: string;
  enteredAt: string;
  kind: string;
}> {
  return engine.getDegradedState().map((target) => ({
    branch: target.branch,
    reason: target.reason,
    enteredAt: target.enteredAt.toISOString(),
    kind: target.kind,
  }));
}

function serializeDegradedSummary(
  degradedTargets: Array<{ branch: string; reason: string; enteredAt: string; kind: string }>,
): {
  active: boolean;
  reason: string;
  enteredAt: string | null;
} {
  const firstTarget = degradedTargets[0];
  if (!firstTarget) {
    return { active: false, reason: "", enteredAt: null };
  }
  return {
    active: true,
    reason: firstTarget.reason,
    enteredAt: firstTarget.enteredAt,
  };
}

const CONTROL_ERROR_STATUS: Record<DispatchControlErrorCode, number> = {
  validation_failed: 400,
  task_not_found: 404,
  task_identity_ambiguous: 409,
  task_identity_mismatch: 409,
  invalid_transition: 409,
  control_store_unavailable: 503,
  control_store_corrupt: 503,
  control_commit_failed: 503,
  cancellation_timeout: 500,
  cancellation_failed: 500,
  session_closure_failed: 500,
  cleanup_ownership_mismatch: 409,
  cleanup_process_birth_mismatch: 409,
  cleanup_leader_missing_group_alive: 409,
  cleanup_identity_unverifiable: 503,
  cleanup_group_unverifiable: 503,
  internal_error: 500,
};

const CONTROL_ERROR_COPY: Record<
  DispatchControlErrorCode,
  { message: string; suggestion: string }
> = {
  validation_failed: {
    message: "Invalid lifecycle control request",
    suggestion: "Correct the typed request fields and retry.",
  },
  task_not_found: {
    message: "Task not found",
    suggestion: "Use an existing canonical task identifier or resolvable task reference.",
  },
  task_identity_ambiguous: {
    message: "Task identity is ambiguous",
    suggestion: "Retry with the canonical task identifier.",
  },
  task_identity_mismatch: {
    message: "Task identity fields do not agree",
    suggestion: "Use matching task_id and task_ref values.",
  },
  invalid_transition: {
    message: "Invalid dispatch lifecycle transition",
    suggestion: "Refresh lifecycle status and choose an allowed action.",
  },
  control_store_unavailable: {
    message: "Dispatch control store is unavailable",
    suggestion: "Restore the project shadow worktree and retry.",
  },
  control_store_corrupt: {
    message: "Dispatch control store is corrupt",
    suggestion: "Repair the committed dispatch control data and retry.",
  },
  control_commit_failed: {
    message: "Dispatch control commit failed",
    suggestion: "Resolve the shadow worktree commit failure and retry.",
  },
  cancellation_timeout: {
    message: "Dispatch cancellation timed out",
    suggestion: "Retry hard stop after inspecting the controlled process.",
  },
  cancellation_failed: {
    message: "Dispatch cancellation failed",
    suggestion: "Inspect durable cleanup evidence and retry hard stop.",
  },
  session_closure_failed: {
    message: "Dispatch session closure failed",
    suggestion: "Inspect durable session evidence and retry hard stop.",
  },
  cleanup_ownership_mismatch: {
    message: "Dispatch cleanup ownership does not match",
    suggestion: "Verify the recorded invocation ownership before retrying.",
  },
  cleanup_process_birth_mismatch: {
    message: "Dispatch cleanup process identity does not match",
    suggestion: "Verify the recorded process identity before retrying.",
  },
  cleanup_leader_missing_group_alive: {
    message: "Dispatch cleanup process group remains alive",
    suggestion: "Inspect the recorded process group before retrying.",
  },
  cleanup_identity_unverifiable: {
    message: "Dispatch cleanup identity cannot be verified",
    suggestion: "Restore process identity evidence before retrying.",
  },
  cleanup_group_unverifiable: {
    message: "Dispatch cleanup process group cannot be verified",
    suggestion: "Restore process-group evidence before retrying.",
  },
  internal_error: {
    message: "Dispatch lifecycle operation failed",
    suggestion: "Retry after checking daemon health.",
  },
};

function lifecycleErrorCode(error: unknown, projectDir?: string): DispatchControlErrorCode {
  if (error instanceof DispatchLifecycleTransitionError) return "invalid_transition";
  if (error instanceof TaskIdentityResolutionError) {
    switch (error.code) {
      case "missing-task-identity":
        return "validation_failed";
      case "unresolved-task-ref":
        return "task_not_found";
      case "ambiguous-task-ref":
      case "duplicate-task-slug":
        return "task_identity_ambiguous";
      case "task-id-ref-mismatch":
        return "task_identity_mismatch";
      case "task-identity-unavailable":
        return "control_store_unavailable";
    }
  }
  if (error instanceof DispatchCleanupError) return error.code;
  if (error instanceof DispatchShadowTransactionError) return "control_commit_failed";
  const degradedCode = projectDir ? lifecycleStoreErrorCode(projectDir) : null;
  if (degradedCode) return degradedCode;
  return "internal_error";
}

function lifecycleStoreErrorCode(
  projectDir: string,
): "control_store_corrupt" | "control_store_unavailable" | null {
  const store = getOrCreateDispatchControlStore(projectDir);
  const kind = store.getDegradedKind();
  if (kind === "corrupt") return "control_store_corrupt";
  if (kind === "unavailable" || store.getDegradedReason()) return "control_store_unavailable";
  return null;
}

function preferredTaskRef(task: { _ulid: string; slugs?: string[] } | undefined): string | null {
  const slug = task?.slugs?.[0];
  return slug ? `@${slug}` : task ? `@${task._ulid}` : null;
}

function hasRealShadowWorktree(projectDir: string): boolean {
  try {
    const marker = readFileSync(path.join(projectDir, ".kspec", ".git"), "utf8").trim();
    if (!marker.startsWith("gitdir:")) return false;
    const gitDir = marker.slice("gitdir:".length).trim();
    const resolved = path.isAbsolute(gitDir) ? gitDir : path.resolve(projectDir, ".kspec", gitDir);
    return existsSync(path.join(resolved, "HEAD")) && existsSync(path.join(resolved, "commondir"));
  } catch {
    return false;
  }
}

async function serializeLifecycleStatus(
  projectDir: string,
  engine: DispatchEngine | undefined,
  degradedTargets = engine ? serializeDegradedTargets(engine) : [],
): Promise<DispatchLifecycleStatus> {
  const engineLifecycle = engine?.getLifecycleStatus();
  const snapshot = hasRealShadowWorktree(projectDir)
    ? (engine
        ? getOrCreateDispatchControlStore(projectDir).getPublication()
        : await getOrCreateDispatchControlStore(projectDir).loadCommitted()
      ).snapshot
    : {
        version: 1 as const,
        revision: 0,
        global: { authority: engineLifecycle?.globalAuthority ?? ("stopped" as const) },
        tasks: {},
        pending_cleanup: {},
      };
  const base = engineLifecycle ?? {
    globalAuthority: snapshot.global.authority,
    projection: snapshot.global.authority,
    activeCount: 0,
    queueDepth: 0,
    heldCount: 0,
    heldTaskIds: [],
    cleanupState: projectDispatchCleanupState(snapshot),
  };
  const tasks = await (async () => {
    if (!hasRealShadowWorktree(projectDir)) return [];
    const ctx = await initContext(projectDir);
    return resolveTaskDataManager(ctx).loadAllTasks(ctx);
  })();
  const tasksById = new Map(tasks.map((task) => [task._ulid, task]));
  const taskControls = Object.entries(snapshot.tasks)
    .map(([taskId, control]) => {
      const task = tasksById.get(taskId);
      return {
        task_id: taskId,
        task_ref: preferredTaskRef(task),
        title: task?.title ?? null,
        mode: control.mode,
        reason: control.reason,
        actor: control.actor,
        source: control.source,
        controlled_at: control.controlled_at,
        updated_at: control.updated_at,
        cleanup_state: projectDispatchCleanupState(snapshot, { scope: "task", task_id: taskId }),
      };
    })
    .toSorted((left, right) => left.task_id.localeCompare(right.task_id));
  const heldTasks = base.heldTaskIds
    .map((taskId) => {
      const task = tasksById.get(taskId);
      const taskControl = snapshot.tasks[taskId];
      const globalHolds = snapshot.global.authority !== "running";
      const control = globalHolds ? snapshot.global : taskControl;
      if (!control || (globalHolds && snapshot.global.authority === "running")) return null;
      const fallbackTimestamp = task?.created_at ?? "1970-01-01T00:00:00.000Z";
      return {
        task_id: taskId,
        task_ref: preferredTaskRef(task),
        title: task?.title ?? null,
        scope: globalHolds ? ("global" as const) : ("task" as const),
        mode: globalHolds ? snapshot.global.authority : taskControl!.mode,
        reason: control.reason ?? "dispatch stopped",
        actor: control.actor ?? "dispatch-engine",
        source: control.source ?? ("recovery" as const),
        controlled_at: control.controlled_at ?? fallbackTimestamp,
        updated_at: control.updated_at ?? fallbackTimestamp,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .toSorted((left, right) => left.task_id.localeCompare(right.task_id));
  return {
    global_authority: base.globalAuthority,
    projection: base.projection,
    cleanup_state: base.cleanupState,
    active_count: base.activeCount,
    queue_depth: base.queueDepth,
    held_count: heldTasks.length,
    held_tasks: heldTasks,
    task_controls: taskControls,
    degraded_targets: degradedTargets,
  };
}

async function serializeInternalStatus(projectDir: string, engine: DispatchEngine) {
  const status = engine.getStatus();
  const degradedTargets = serializeDegradedTargets(engine);
  const lifecycle = await serializeLifecycleStatus(projectDir, engine, degradedTargets);
  return {
    ...status,
    degraded: serializeDegradedSummary(degradedTargets),
    degradedTargets,
    globalAuthority: lifecycle.global_authority,
    projection: lifecycle.projection,
    cleanupState: lifecycle.cleanup_state,
    heldCount: lifecycle.held_count,
    heldTasks: lifecycle.held_tasks,
    taskControls: lifecycle.task_controls,
  };
}

async function serializeInternalStatusWithoutEngine(projectDir: string) {
  const lifecycle = await serializeLifecycleStatus(projectDir, undefined);
  return {
    running: false,
    activeInvocations: 0,
    queuedInvocations: 0,
    invocations: [],
    degraded: { active: false, reason: "", enteredAt: null },
    degradedTargets: [],
    globalAuthority: lifecycle.global_authority,
    projection: lifecycle.projection,
    cleanupState: lifecycle.cleanup_state,
    heldCount: lifecycle.held_count,
    heldTasks: lifecycle.held_tasks,
    taskControls: lifecycle.task_controls,
  };
}

/**
 * Create an AgentSpawner callback for automation subsystem action executors.
 *
 * Resolves agent definitions from meta config, spawns invocations via
 * runInvocation with the project root as working directory, and returns
 * a trackable invocation ID.
 *
 * AC: @automation-action-type-completeness ac-1, ac-2, ac-3, ac-4
 */
export function createAutomationAgentSpawner(projectDir: string): AgentSpawner {
  return async (options) => {
    const ctx = await initContext(projectDir);
    const meta = await loadMetaContext(ctx);
    const agentDef = meta.agents.find((a) => a.id === options.agent_id);

    if (!agentDef) {
      throw new Error(
        `Agent "${options.agent_id}" not found in project configuration. ` +
          `Available agents: ${meta.agents.map((a) => a.id).join(", ") || "(none)"}`,
      );
    }

    // AC: @dispatch-agent-action-input ac-4 — propagate correlation_id and group_id
    // via env vars so the spawned agent inherits the event correlation chain
    const env: Record<string, string> = {};
    if (options.correlation_id) {
      env.KSPEC_CORRELATION_ID = options.correlation_id;
    }
    if (options.group_id) {
      env.KSPEC_COMPOSITION_GROUP_ID = options.group_id;
    }

    // AC: @dispatch-canonical-task-identity ac-automation-agent-actions-canonicalize-task-binding
    // AC: @dispatch-canonical-task-identity ac-project-invocation-callers-supply-canonical-task-id
    // Task-bound automation invocations resolve the binding to canonical task
    // identity through the same normalization rules dispatch uses, BEFORE the
    // session/invocation is created. The canonical full task ULID becomes the
    // invocation task_id; the chosen human-readable ref is retained only as the
    // display task_ref. Unresolved, ambiguous, or mismatched bindings fail the
    // action run here so no session or invocation payload is created for a raw
    // ref. Non-task-scoped actions (no task_ref and no task_id) are unchanged.
    let canonicalTaskId: string | undefined;
    let displayTaskRef: string | undefined;
    const hasTaskBinding =
      (typeof options.task_ref === "string" && options.task_ref.length > 0) ||
      (typeof options.task_id === "string" && options.task_id.length > 0);
    if (hasTaskBinding) {
      const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
      const resolution = normalizeTaskIdentity(
        {
          taskId: options.task_id,
          taskRef: options.task_ref,
          source: `automation/agent-action(${options.agent_id})`,
        },
        buildTaskRefResolver(tasks),
      );
      if (!resolution.ok) {
        throw new Error(
          `Cannot run task-bound agent action for "${options.agent_id}": ${resolution.diagnostic}`,
        );
      }
      canonicalTaskId = resolution.identity.taskId;
      displayTaskRef = resolution.identity.displayRef;
    }

    const sessionId = ulid();
    const result = await runInvocation({
      agent: agentDef,
      specDir: ctx.specDir,
      cwd: projectDir,
      taskId: canonicalTaskId,
      taskRef: displayTaskRef,
      prompt: options.prompt ?? `Run as agent "${options.agent_id}".`,
      trigger: "manual",
      timeoutMinutes: options.timeout_minutes,
      sessionId,
      ...(Object.keys(env).length > 0 && { env }),
    });

    return { invocation_id: result.session.id };
  };
}

/**
 * Start the schedule engine for a project, integrating with the dispatch engine's event bus.
 * AC: @dispatch-schedule-entities ac-1 through ac-6
 */
async function startScheduleEngine(
  projectDir: string,
  engine: DispatchEngine,
  pubsub?: PubSubManager,
): Promise<void> {
  // Create action executor wired to the event bus, agent spawner, and engine's session registry
  // AC: @automation-action-type-completeness ac-1, ac-5
  const actionExecutor = new ActionExecutor({
    projectDir,
    kspecCliPath: DEFAULT_KSPEC_CLI_PATH,
    sessionRegistry: engine.sessionRegistry,
    agentSpawner: createAutomationAgentSpawner(projectDir),
    onActionRunEvent: (event) => {
      // Emit action lifecycle events on the shared bus
      // AC: @automation-action-type-completeness ac-5 — include error and failure_reason for diagnosability
      engine.eventBus.emit({
        event_type: event.type,
        source_type: "schedule_engine",
        source_id: event.event_context.source_id ?? "schedule-engine",
        payload: {
          action_run_id: event.action_run.action_run_id,
          action_type: event.action_run.action_type,
          schedule_id: event.event_context.schedule_id,
          source_name: event.action_run.source_name,
          ...(event.action_run.duration_ms !== undefined && {
            duration_ms: event.action_run.duration_ms,
          }),
          ...(event.action_run.invocation_id && { session_id: event.action_run.invocation_id }),
          ...(event.action_run.error && { error: event.action_run.error }),
          ...(event.action_run.failure_reason && {
            failure_reason: event.action_run.failure_reason,
          }),
        },
        causation_id: event.event_context.causation_id,
        correlation_id: event.event_context.correlation_id,
      });
    },
    notifyBroadcast: pubsub
      ? (topic, event, data) => {
          pubsub.broadcast(topic, event, data, projectDir);
        }
      : undefined,
  });

  const scheduleEngine = new ScheduleEngine({
    projectDir,
    eventBus: engine.eventBus,
    actionExecutor,
  });
  scheduleEngines.set(projectDir, scheduleEngine);
  await scheduleEngine.start();
}

/**
 * Stop the schedule engine for a project.
 */
async function stopScheduleEngine(projectDir: string): Promise<void> {
  const scheduleEngine = scheduleEngines.get(projectDir);
  if (scheduleEngine) {
    await scheduleEngine.stop();
    scheduleEngines.delete(projectDir);
  }
}

/**
 * Start the hook executor for a project, wired to the dispatch engine's event bus.
 * AC: @automation-api ac-1, ac-6
 */
async function startHookExecutor(
  projectDir: string,
  engine: DispatchEngine,
  pubsub?: PubSubManager,
): Promise<void> {
  const ctx = await initContext(projectDir);
  const meta = await loadMetaContext(ctx);

  // AC: @automation-action-type-completeness ac-2, ac-5
  const actionExecutor = new ActionExecutor({
    projectDir,
    kspecCliPath: DEFAULT_KSPEC_CLI_PATH,
    sessionRegistry: engine.sessionRegistry,
    agentSpawner: createAutomationAgentSpawner(projectDir),
    onActionRunEvent: (event) => {
      // AC: @automation-action-type-completeness ac-5 — include error and failure_reason for diagnosability
      engine.eventBus.emit({
        event_type: event.type,
        source_type: "api",
        source_id: event.event_context.source_id ?? "hook-executor",
        payload: {
          action_run_id: event.action_run.action_run_id,
          action_type: event.action_run.action_type,
          source_name: event.action_run.source_name,
          ...(event.action_run.duration_ms !== undefined && {
            duration_ms: event.action_run.duration_ms,
          }),
          ...(event.action_run.invocation_id && { session_id: event.action_run.invocation_id }),
          ...(event.action_run.error && { error: event.action_run.error }),
          ...(event.action_run.failure_reason && {
            failure_reason: event.action_run.failure_reason,
          }),
        },
        causation_id: event.event_context.causation_id,
        correlation_id: event.event_context.correlation_id,
      });
    },
    notifyBroadcast: pubsub
      ? (topic, event, data) => {
          pubsub.broadcast(topic, event, data, projectDir);
        }
      : undefined,
  });

  const hookExecutor = new HookExecutor({
    eventBus: engine.eventBus,
    actionExecutor,
    hooks: meta.hooks,
  });
  hookExecutor.start();
  hookExecutors.set(projectDir, hookExecutor);
}

/**
 * Stop the hook executor for a project.
 */
function stopHookExecutor(projectDir: string): void {
  const hookExecutor = hookExecutors.get(projectDir);
  if (hookExecutor) {
    hookExecutor.stop();
    hookExecutors.delete(projectDir);
  }
}

/**
 * Start the join accumulator for a project, wired to the dispatch engine's event bus.
 * AC: @automation-api ac-5
 */
async function startJoinAccumulator(
  projectDir: string,
  engine: DispatchEngine,
  pubsub?: PubSubManager,
): Promise<void> {
  const ctx = await initContext(projectDir);
  const meta = await loadMetaContext(ctx);

  // Compositions are on the parsed manifest, not on MetaContext
  const compositions = meta.manifest?.compositions ?? [];
  if (compositions.length === 0) return;

  // AC: @automation-action-type-completeness ac-3, ac-5
  const actionExecutor = new ActionExecutor({
    projectDir,
    kspecCliPath: DEFAULT_KSPEC_CLI_PATH,
    sessionRegistry: engine.sessionRegistry,
    agentSpawner: createAutomationAgentSpawner(projectDir),
    onActionRunEvent: (event) => {
      // AC: @automation-action-type-completeness ac-5 — include error and failure_reason for diagnosability
      engine.eventBus.emit({
        event_type: event.type,
        source_type: "api",
        source_id: event.event_context.source_id ?? "join-accumulator",
        payload: {
          action_run_id: event.action_run.action_run_id,
          action_type: event.action_run.action_type,
          source_name: event.action_run.source_name,
          group_id: event.event_context.group_id,
          config_id: event.event_context.config_id,
          ...(event.action_run.duration_ms !== undefined && {
            duration_ms: event.action_run.duration_ms,
          }),
          ...(event.action_run.invocation_id && { session_id: event.action_run.invocation_id }),
          ...(event.action_run.error && { error: event.action_run.error }),
          ...(event.action_run.failure_reason && {
            failure_reason: event.action_run.failure_reason,
          }),
        },
        causation_id: event.event_context.causation_id,
        correlation_id: event.event_context.correlation_id,
      });
    },
    notifyBroadcast: pubsub
      ? (topic, event, data) => {
          pubsub.broadcast(topic, event, data, projectDir);
        }
      : undefined,
  });

  const accumulator = new JoinAccumulator({
    eventBus: engine.eventBus,
    actionExecutor,
  });
  accumulator.start(compositions);
  joinAccumulators.set(projectDir, accumulator);
}

/**
 * Stop the join accumulator for a project.
 */
function stopJoinAccumulator(projectDir: string): void {
  const accumulator = joinAccumulators.get(projectDir);
  if (accumulator) {
    accumulator.stop();
    joinAccumulators.delete(projectDir);
  }
}

/**
 * Stop and clean up the session registry for a project.
 * Closes all active sessions and removes the registry.
 * AC: @session-prompt-action ac-1
 */
function stopSessionRegistry(projectDir: string): void {
  const engine = engines.get(projectDir);
  if (engine) {
    engine.sessionRegistry.closeAll("Dispatch engine stopping");
  }
}

const stateChangeBodySchema = t.Object({
  task_id: t.String(),
  task_ref: t.Optional(t.String()),
  from_status: enumUnion(TaskStatusSchema.options),
  to_status: enumUnion(TaskStatusSchema.options),
  timestamp: t.Optional(t.Number()),
});

type StateChangeBody = {
  task_id: string;
  task_ref?: string;
  from_status: string;
  to_status: string;
  timestamp?: number;
};

function processStateChangeEvent(
  engine: DispatchEngine | undefined,
  body: StateChangeBody,
): { accepted: boolean; reason?: string } {
  if (!engine || !engine.getStatus().running) {
    return { accepted: false, reason: "Dispatch engine not running" };
  }

  if (!VALID_TASK_STATUSES.has(body.from_status) || !VALID_TASK_STATUSES.has(body.to_status)) {
    return {
      accepted: false,
      reason: `Invalid status: from_status="${body.from_status}" to_status="${body.to_status}". Valid values: ${[...VALID_TASK_STATUSES].join(", ")}`,
    };
  }

  const change: TaskStateChange = {
    taskId: body.task_id,
    taskRef: body.task_ref ?? `@${body.task_id}`,
    fromStatus: body.from_status as TaskStatus,
    toStatus: body.to_status as TaskStatus,
    timestamp: body.timestamp ?? Date.now(),
  };

  engine.handleStateChange(change).catch((err) => {
    console.error("[dispatch] Error handling state change event:", err);
  });

  return { accepted: true };
}

export function resolveDispatchCwd(projectDir: string, requestedCwd: string | null): string {
  if (requestedCwd && !path.isAbsolute(requestedCwd)) {
    throw new Error("Dispatch cwd must be an absolute path");
  }
  const cwd = requestedCwd ? path.resolve(requestedCwd) : projectDir;

  if (cwd === projectDir) {
    return cwd;
  }

  const projectRoots = resolveProjectRoots(projectDir);
  const cwdRoots = resolveProjectRoots(cwd);
  if (!projectRoots || !cwdRoots || projectRoots.mainRoot !== cwdRoots.mainRoot) {
    throw new Error("Dispatch cwd must belong to the same git project");
  }

  return cwd;
}

async function ensureDispatchEngine(
  projectDir: string,
  requestedCwd: string,
  pubsub?: PubSubManager,
): Promise<{ engine: DispatchEngine; created: boolean }> {
  const existing = engines.get(projectDir);
  if (existing) return { engine: existing, created: false };
  const engine = createEngine(projectDir, requestedCwd, pubsub);
  engines.set(projectDir, engine);
  try {
    await engine.start();
    await startScheduleEngine(projectDir, engine, pubsub);
    await startHookExecutor(projectDir, engine, pubsub);
    await startJoinAccumulator(projectDir, engine, pubsub);
    return { engine, created: true };
  } catch (error) {
    engines.delete(projectDir);
    throw error;
  }
}

async function preflightLifecycleAction(
  projectDir: string,
  input:
    | { scope: "global"; action: "start" | "pause" | "resume" | "stop" }
    | {
        scope: "task";
        action: "pause" | "resume" | "stop";
        taskId?: string;
        taskRef?: string;
      },
): Promise<CanonicalTaskIdentity | null> {
  if (!hasRealShadowWorktree(projectDir)) return null;
  const store = getOrCreateDispatchControlStore(projectDir);
  const snapshot = (await store.loadCommitted()).snapshot;
  if (store.getDegradedReason()) {
    throw new Error("Dispatch control store is degraded");
  }
  if (input.scope === "global") {
    if (input.action !== "stop") resolveGlobalLifecycleTransition(snapshot, input.action);
    return null;
  }
  const identity = await requireCanonicalTaskIdentity(projectDir, {
    taskId: input.taskId,
    taskRef: input.taskRef,
    source: `daemon/dispatch-control-${input.action}`,
  });
  assertTaskLifecycleTransition(snapshot, identity.taskId, input.action);
  return identity;
}

async function stopDispatchEngine(
  projectDir: string,
  engine: DispatchEngine,
  closeRegistry: boolean,
): Promise<void> {
  // Commit/retry the durable hard stop before tearing down runtime helpers.
  // A cleanup failure must leave the same engine lifecycle-capable for retry.
  if (hasRealShadowWorktree(projectDir)) {
    await engine.applyGlobalLifecycleAction("stop", {
      actor: "api",
      source: "api",
    });
  }
  stopJoinAccumulator(projectDir);
  stopHookExecutor(projectDir);
  await stopScheduleEngine(projectDir);
  if (closeRegistry) stopSessionRegistry(projectDir);
  await engine.stop();
}

const lifecycleControlBodySchema = t.Object({
  scope: t.Union([t.Literal("global"), t.Literal("task")]),
  action: t.Union([t.Literal("start"), t.Literal("pause"), t.Literal("resume"), t.Literal("stop")]),
  task_ref: t.Optional(t.String()),
  task_id: t.Optional(t.String()),
  reason: t.Optional(t.String()),
});

export function createAgentDispatchRoutes(options: AgentDispatchRouteOptions = {}) {
  const { pubsub } = options;

  return (
    new Elysia({ prefix: "/api/agent" })

      // AC: @daemon-agent-dispatch ac-2, ac-7 - CLI posts state change event to daemon
      // AC: @agent-dispatch-engine ac-4
      .post(
        "/events",
        ({ body, projectContext }) => {
          return processStateChangeEvent(engines.get(projectContext.path), body);
        },
        { body: stateChangeBodySchema },
      )

      // Legacy alias — same as /events
      .post(
        "/event",
        ({ body, projectContext }) => {
          return processStateChangeEvent(engines.get(projectContext.path), body);
        },
        { body: stateChangeBodySchema },
      )

      // Canonical lifecycle control boundary.
      // AC: @daemon-agent-dispatch ac-6
      // AC: @daemon-agent-dispatch ac-control-error-current-status
      // AC: @daemon-agent-dispatch ac-control-missing-identity
      // AC: @daemon-agent-dispatch ac-control-ref-canonicalization
      // AC: @daemon-agent-dispatch ac-control-identity-mismatch
      // AC: @daemon-agent-dispatch ac-control-failure-no-success
      // AC: @daemon-agent-dispatch ac-cleanup-failure-no-success
      .post(
        "/dispatch/control",
        async ({ body, projectContext, request, set }) => {
          const projectDir = projectContext.path;
          let engine = engines.get(projectDir);
          let preflightIdentity: CanonicalTaskIdentity | null = null;
          try {
            if (
              (body.scope === "global" &&
                (body.task_id !== undefined || body.task_ref !== undefined)) ||
              (body.scope === "task" &&
                (body.action === "start" ||
                  (body.task_id === undefined && body.task_ref === undefined)))
            ) {
              const current = await serializeLifecycleStatus(projectDir, engine);
              const copy = CONTROL_ERROR_COPY.validation_failed;
              set.status = 400;
              return {
                ok: false,
                data: current,
                error: { code: "validation_failed" as const, ...copy },
              };
            }
            let requestedCwd: string;
            try {
              requestedCwd = resolveDispatchCwd(projectDir, request.headers.get("X-Kspec-Cwd"));
            } catch {
              const current = await serializeLifecycleStatus(projectDir, engine);
              set.status = 400;
              return {
                ok: false,
                data: current,
                error: {
                  code: "validation_failed" as const,
                  ...CONTROL_ERROR_COPY.validation_failed,
                },
              };
            }
            if (engine && engine.getCwd() !== requestedCwd) {
              const current = await serializeLifecycleStatus(projectDir, engine);
              const copy = CONTROL_ERROR_COPY.invalid_transition;
              set.status = 409;
              return {
                ok: false,
                data: current,
                error: { code: "invalid_transition" as const, ...copy },
              };
            }
            if (!engine) {
              preflightIdentity = await preflightLifecycleAction(
                projectDir,
                body.scope === "global"
                  ? { scope: "global", action: body.action }
                  : {
                      scope: "task",
                      action: body.action,
                      taskId: body.task_id,
                      taskRef: body.task_ref,
                    },
              );
            }
            ({ engine } = await ensureDispatchEngine(projectDir, requestedCwd, pubsub));
            const result =
              body.scope === "global"
                ? await engine.applyGlobalLifecycleAction(body.action, {
                    reason: body.reason,
                    actor: "api",
                    source: "api",
                  })
                : await engine.applyTaskLifecycleAction(body.action, {
                    taskId: preflightIdentity?.taskId ?? body.task_id,
                    taskRef: preflightIdentity?.displayRef ?? body.task_ref,
                    reason: body.reason,
                    actor: "api",
                    source: "api",
                  });
            const status = await serializeLifecycleStatus(projectDir, engine);
            return {
              ok: true,
              data: {
                ...status,
                outcome: result.outcome,
                ...(body.scope === "task"
                  ? {
                      task_id: result.taskId,
                      task_ref: result.taskRef ?? null,
                    }
                  : {}),
              },
              error: null,
            };
          } catch (error) {
            const code = lifecycleErrorCode(error, projectDir);
            const copy = CONTROL_ERROR_COPY[code];
            set.status = CONTROL_ERROR_STATUS[code];
            const current = await serializeLifecycleStatus(projectDir, engine).catch(async () => {
              const snapshot = await getOrCreateDispatchControlStore(projectDir).loadCommitted();
              return {
                global_authority: snapshot.snapshot.global.authority,
                projection: snapshot.snapshot.global.authority,
                cleanup_state: projectDispatchCleanupState(snapshot.snapshot),
                active_count: 0,
                queue_depth: 0,
                held_count: 0,
                held_tasks: [],
                task_controls: [],
                degraded_targets: [],
              } satisfies DispatchLifecycleStatus;
            });
            return { ok: false, data: current, error: { code, ...copy } };
          }
        },
        { body: lifecycleControlBodySchema },
      )

      // AC: @daemon-agent-dispatch ac-6 - Unified dispatch start/stop via action field
      .post(
        "/dispatch",
        async ({ body, projectContext, request, set }) => {
          const projectDir = projectContext.path;

          if (body.action === "start") {
            let requestedCwd: string;
            try {
              requestedCwd = resolveDispatchCwd(projectDir, request.headers.get("X-Kspec-Cwd"));
            } catch {
              set.status = 400;
              return {
                dispatch_enabled: false,
                error: "Invalid dispatch working directory",
              };
            }

            let engine = engines.get(projectDir);
            if (engine?.getStatus().running) {
              if (engine.getCwd() !== requestedCwd) {
                set.status = 409;
                return {
                  dispatch_enabled: true,
                  error: "Dispatch is already running for another project",
                };
              }
              if (!hasRealShadowWorktree(projectDir)) {
                return { dispatch_enabled: true, reason: "Already running" };
              }
            }

            const priorRunning = engine?.getStatus().running ?? false;
            try {
              if (!engine) {
                await preflightLifecycleAction(projectDir, {
                  scope: "global",
                  action: "start",
                });
              }
              ({ engine } = await ensureDispatchEngine(projectDir, requestedCwd, pubsub));
              if (hasRealShadowWorktree(projectDir)) {
                const result = await engine.applyGlobalLifecycleAction("start", {
                  actor: "api",
                  source: "api",
                });
                return result.outcome === "noop"
                  ? { dispatch_enabled: true, reason: "Already running" }
                  : { dispatch_enabled: true };
              }
              return { dispatch_enabled: true };
            } catch (error) {
              const code = lifecycleErrorCode(error, projectDir);
              set.status = CONTROL_ERROR_STATUS[code];
              return {
                dispatch_enabled: priorRunning,
                ...(code === "invalid_transition"
                  ? { error: "Invalid dispatch lifecycle transition" }
                  : {}),
                error_code: code,
              };
            }
          } else {
            const engine = engines.get(projectDir);
            if (!engine) {
              return { dispatch_enabled: false, reason: "No engine running" };
            }

            const priorRunning = engine.getStatus().running;
            try {
              await stopDispatchEngine(projectDir, engine, false);
              engines.delete(projectDir);
              return { dispatch_enabled: false };
            } catch (error) {
              const code = lifecycleErrorCode(error, projectDir);
              const cleanupPending = error instanceof DispatchCleanupError;
              set.status = CONTROL_ERROR_STATUS[code];
              return {
                dispatch_enabled: cleanupPending ? false : priorRunning,
                ...(code === "invalid_transition"
                  ? { error: "Invalid dispatch lifecycle transition" }
                  : cleanupPending
                    ? { reason: "cleanup_pending" }
                    : {}),
                error_code: code,
              };
            }
          }
        },
        {
          body: t.Object({
            action: t.Union([t.Literal("start"), t.Literal("stop")]),
          }),
        },
      )

      // Start dispatch engine (legacy route)
      .post("/dispatch/start", async ({ projectContext, request, set }) => {
        const projectDir = projectContext.path;
        let requestedCwd: string;
        try {
          requestedCwd = resolveDispatchCwd(projectDir, request.headers.get("X-Kspec-Cwd"));
        } catch {
          set.status = 400;
          return {
            started: false,
            error: "Invalid dispatch working directory",
          };
        }

        let engine = engines.get(projectDir);
        if (engine?.getStatus().running) {
          if (engine.getCwd() !== requestedCwd) {
            set.status = 409;
            return {
              started: false,
              error: "Dispatch is already running for another project",
              status: await serializeInternalStatus(projectDir, engine),
            };
          }
          if (!hasRealShadowWorktree(projectDir)) {
            return {
              started: false,
              reason: "Already running",
              status: await serializeInternalStatus(projectDir, engine),
            };
          }
        }

        try {
          if (!engine) {
            await preflightLifecycleAction(projectDir, {
              scope: "global",
              action: "start",
            });
          }
          ({ engine } = await ensureDispatchEngine(projectDir, requestedCwd, pubsub));
          if (hasRealShadowWorktree(projectDir)) {
            const result = await engine.applyGlobalLifecycleAction("start", {
              actor: "api",
              source: "api",
            });
            return result.outcome === "noop"
              ? {
                  started: false,
                  reason: "Already running",
                  status: await serializeInternalStatus(projectDir, engine),
                }
              : { started: true, status: await serializeInternalStatus(projectDir, engine) };
          }
          return { started: true, status: await serializeInternalStatus(projectDir, engine) };
        } catch (error) {
          const code = lifecycleErrorCode(error, projectDir);
          set.status = CONTROL_ERROR_STATUS[code];
          return {
            started: false,
            ...(code === "invalid_transition"
              ? {
                  error: "Invalid dispatch lifecycle transition",
                  status: engine
                    ? await serializeInternalStatus(projectDir, engine)
                    : await serializeInternalStatusWithoutEngine(projectDir),
                }
              : {}),
            error_code: code,
          };
        }
      })

      // Stop dispatch engine (legacy route)
      .post("/dispatch/stop", async ({ projectContext, set }) => {
        const projectDir = projectContext.path;
        const engine = engines.get(projectDir);

        if (!engine) {
          return { stopped: false, reason: "No engine running" };
        }

        try {
          await stopDispatchEngine(projectDir, engine, true);
          engines.delete(projectDir);
          return { stopped: true };
        } catch (error) {
          const code = lifecycleErrorCode(error, projectDir);
          const cleanupPending = error instanceof DispatchCleanupError;
          set.status = CONTROL_ERROR_STATUS[code];
          return {
            stopped: false,
            ...(code === "invalid_transition"
              ? { reason: "invalid_transition" }
              : cleanupPending
                ? { reason: "cleanup_pending" }
                : {}),
            error_code: code,
          };
        }
      })

      // Get dispatch engine status (internal format)
      // AC: @dispatch-remote-branch-sync ac-degraded-status-api
      .get("/dispatch/status", async ({ projectContext, set }) => {
        const engine = engines.get(projectContext.path);

        if (!engine) {
          const base = {
            running: false,
            activeInvocations: 0,
            queuedInvocations: 0,
            invocations: [],
            degraded: { active: false, reason: "", enteredAt: null },
            degradedTargets: [],
          };
          try {
            const lifecycle = await serializeLifecycleStatus(projectContext.path, undefined);
            const degradedCode = hasRealShadowWorktree(projectContext.path)
              ? lifecycleStoreErrorCode(projectContext.path)
              : null;
            if (degradedCode) {
              set.status = 503;
              return {
                ...base,
                globalAuthority: lifecycle.global_authority,
                projection: lifecycle.projection,
                cleanupState: lifecycle.cleanup_state,
                heldCount: lifecycle.held_count,
                heldTasks: lifecycle.held_tasks,
                taskControls: lifecycle.task_controls,
                error_code: degradedCode,
              };
            }
            return {
              ...base,
              globalAuthority: lifecycle.global_authority,
              projection: lifecycle.projection,
              cleanupState: lifecycle.cleanup_state,
              heldCount: lifecycle.held_count,
              heldTasks: lifecycle.held_tasks,
              taskControls: lifecycle.task_controls,
            };
          } catch {
            set.status = 500;
            return {
              ...base,
              globalAuthority: "stopped" as const,
              projection: "stopped" as const,
              cleanupState: { status: "idle" as const, entries: [] },
              heldCount: 0,
              heldTasks: [],
              taskControls: [],
              error_code: "internal_error" as const,
            };
          }
        }

        const status = engine.getStatus();
        const degradedTargets = serializeDegradedTargets(engine);
        let lifecycle: DispatchLifecycleStatus;
        try {
          lifecycle = await serializeLifecycleStatus(projectContext.path, engine, degradedTargets);
        } catch {
          const current = engine.getLifecycleStatus();
          set.status = 500;
          return {
            ...status,
            degraded: serializeDegradedSummary(degradedTargets),
            degradedTargets,
            globalAuthority: current.globalAuthority,
            projection: current.projection,
            cleanupState: current.cleanupState,
            heldCount: 0,
            heldTasks: [],
            taskControls: [],
            error_code: "internal_error" as const,
          };
        }
        const internalStatus = {
          ...status,
          degraded: serializeDegradedSummary(degradedTargets),
          degradedTargets,
          globalAuthority: lifecycle.global_authority,
          projection: lifecycle.projection,
          cleanupState: lifecycle.cleanup_state,
          heldCount: lifecycle.held_count,
          heldTasks: lifecycle.held_tasks,
          taskControls: lifecycle.task_controls,
        };
        const degradedCode = hasRealShadowWorktree(projectContext.path)
          ? lifecycleStoreErrorCode(projectContext.path)
          : null;
        if (degradedCode) {
          set.status = 503;
          return { ...internalStatus, error_code: degradedCode };
        }
        return internalStatus;
      })

      // AC: @daemon-agent-dispatch ac-5 - Public status endpoint
      // AC: @ui-api-ref-resolution ac-1 - Include task_title for active invocations
      // AC: @dispatch-remote-branch-sync ac-degraded-status-api
      // AC: @runner-operator-surfaces ac-daemon-dispatch-active-api-includes-runner
      // AC: @runner-operator-surfaces ac-daemon-dispatch-queued-api-includes-runner
      .get("/status", async ({ projectContext, set }) => {
        const projectDir = projectContext.path;
        const engine = engines.get(projectDir);
        const engineStatus = engine?.getStatus();

        let agentDefinitions: Array<{
          id: string;
          name: string;
          adapter: string;
          resolved_adapter: string;
          runner?: string;
          runner_validation?: {
            status: "valid" | "invalid";
            diagnostics: ReadonlyArray<{
              reason: string;
              message: string;
              details?: Readonly<Record<string, unknown>>;
            }>;
          };
          completed_sessions: number;
        }> = [];
        let completedCounts: Record<string, number> = {};
        let refIndex: ReferenceIndex | null = null;
        let runnerRegistry: EffectiveRunnerRegistry = { runners: {} };
        let registryLoadFailures: readonly RegistryLoadFailure[] = [];
        try {
          const ctx = await initContext(projectDir);
          const [meta, counts, tasks, items] = await Promise.all([
            loadMetaContext(ctx),
            getCompletedSessionCountsByAgent(ctx.specDir),
            resolveTaskDataManager(ctx).loadAllTasks(ctx),
            loadAllItems(ctx),
          ]);
          completedCounts = counts;
          refIndex = new ReferenceIndex(tasks, items);
          // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
          // Resolve runner registry once per status request so each agent's
          // resolved adapter mirrors what the dispatch engine would observe
          // at preflight. Capture registry-load failures so runner-backed
          // agents report `runner_registry_unavailable` rather than
          // collapsing the diagnostic into a missing-name message.
          try {
            const resolved = await resolveEffectiveRunners({
              projectRoot: ctx.projectRoot,
              shadowWorktreeDir: ctx.specDir,
            });
            runnerRegistry = resolved.registry;
            // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
            registryLoadFailures = diagnoseRegistryLoad(resolved);
          } catch {
            // Optional: runner registry is not required for this endpoint.
          }
          agentDefinitions = meta.agents.map((a) => {
            const runnerEntry = a.runner ? runnerRegistry.runners[a.runner] : undefined;
            const resolved = runnerEntry?.adapter ?? a.adapter ?? "claude-agent-acp";
            const definition: (typeof agentDefinitions)[number] = {
              id: a.id,
              name: a.name,
              // Legacy `adapter` field preserved for clients that read it.
              // AC: @agent-runner-configuration ac-adapter-field-backcompat
              adapter: resolved,
              resolved_adapter: resolved,
              ...(a.runner ? { runner: a.runner } : {}),
              completed_sessions: completedCounts[a.id] ?? 0,
            };
            // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
            // Attach the registry-load diagnostic to any runner-backed agent
            // when the registry is unavailable — including the mixed-layer
            // case where the agent's runner survives from one layer but
            // another layer is malformed. A surviving runner entry must not
            // mask the failing layer; operators need the failing config path
            // before relying on a runner resolved from a partial registry.
            if (a.runner && registryLoadFailures.length > 0) {
              definition.runner_validation = {
                status: "invalid",
                diagnostics: registryLoadFailures.map((failure) => ({
                  reason: "runner_registry_unavailable",
                  message:
                    `Runner registry unavailable: ${summarizeRegistryLoadFailure(failure)}. ` +
                    `Fix the ${failure.layer} runner config before relying on runner "${a.runner}".`,
                  details: {
                    runner: a.runner,
                    agent: a.id,
                    layer: failure.layer,
                    config_path: failure.config_path,
                    issues: failure.issues.map((issue) => ({ ...issue })),
                  },
                })),
              };
            }
            return definition;
          });
        } catch {
          // Agent definitions unavailable — return empty array
        }

        const degradedTargets = engine ? serializeDegradedTargets(engine) : [];
        let lifecycle: DispatchLifecycleStatus;
        try {
          lifecycle = await serializeLifecycleStatus(projectDir, engine, degradedTargets);
        } catch {
          const current = engine?.getLifecycleStatus();
          const data: DispatchLifecycleStatus = {
            global_authority: current?.globalAuthority ?? "stopped",
            projection: current?.projection ?? "stopped",
            cleanup_state: current?.cleanupState ?? { status: "idle", entries: [] },
            active_count: current?.activeCount ?? 0,
            queue_depth: current?.queueDepth ?? 0,
            held_count: 0,
            held_tasks: [],
            task_controls: [],
            degraded_targets: degradedTargets,
          };
          set.status = 500;
          return {
            ok: false,
            data,
            error: { code: "internal_error" as const, ...CONTROL_ERROR_COPY.internal_error },
          };
        }
        const publicStatus = {
          dispatch_enabled: engineStatus?.running ?? false,
          active_invocations:
            engineStatus?.invocations?.map((inv) => {
              let task_title: string | null = null;
              if (inv.taskRef && refIndex) {
                const result = refIndex.resolve(inv.taskRef);
                if (result.ok) {
                  task_title = (result.item as { title?: string }).title ?? null;
                }
              }
              return {
                session_id: inv.sessionId,
                agent_id: inv.agentId,
                task_ref: inv.taskRef ?? null,
                task_title,
                elapsed_ms: inv.elapsedMs,
                // AC: @runner-operator-surfaces ac-daemon-dispatch-active-api-includes-runner
                resolved_adapter: inv.resolvedAdapter,
                ...(inv.runner ? { runner: inv.runner } : {}),
              };
            }) ?? [],
          // AC: @runner-operator-surfaces ac-daemon-dispatch-queued-api-includes-runner
          queued_invocations:
            engineStatus?.queued?.map((q) => {
              let task_title: string | null = null;
              if (q.taskRef && refIndex) {
                const result = refIndex.resolve(q.taskRef);
                if (result.ok) {
                  task_title = (result.item as { title?: string }).title ?? null;
                }
              }
              const runnerEntry = q.runner ? runnerRegistry.runners[q.runner] : undefined;
              const resolved = runnerEntry?.adapter ?? q.adapter ?? "claude-agent-acp";
              return {
                agent_id: q.agentId,
                task_ref: q.taskRef ?? null,
                task_title,
                wait_ms: q.waitMs,
                resolved_adapter: resolved,
                ...(q.runner ? { runner: q.runner } : {}),
              };
            }) ?? [],
          queue_depth: engineStatus?.queuedInvocations ?? 0,
          agent_definitions: agentDefinitions,
          // AC: @dispatch-remote-branch-sync ac-degraded-status-api
          degraded: serializeDegradedSummary(degradedTargets),
          degraded_targets: degradedTargets,
          global_authority: lifecycle.global_authority,
          projection: lifecycle.projection,
          cleanup_state: lifecycle.cleanup_state,
          held_count: lifecycle.held_count,
          held_tasks: lifecycle.held_tasks,
          task_controls: lifecycle.task_controls,
        };
        const degradedCode = hasRealShadowWorktree(projectDir)
          ? lifecycleStoreErrorCode(projectDir)
          : null;
        if (degradedCode) {
          set.status = 503;
          return {
            ok: false,
            data: lifecycle,
            error: {
              code: degradedCode,
              ...CONTROL_ERROR_COPY[degradedCode],
            },
          };
        }
        return publicStatus;
      })
  );
}

/**
 * Get the dispatch engine for a project path (for integration with file watcher).
 */
export function getDispatchEngine(projectDir: string): DispatchEngine | undefined {
  return engines.get(projectDir);
}

/**
 * Get the schedule engine for a project path (for automation API).
 */
export function getScheduleEngine(projectDir: string): ScheduleEngine | undefined {
  return scheduleEngines.get(projectDir);
}

/**
 * Get the hook executor for a project path (for automation API).
 */
export function getHookExecutor(projectDir: string): HookExecutor | undefined {
  return hookExecutors.get(projectDir);
}

/**
 * Get the join accumulator for a project path (for automation API).
 */
export function getJoinAccumulator(projectDir: string): JoinAccumulator | undefined {
  return joinAccumulators.get(projectDir);
}

/**
 * Get the session registry for a project path.
 * Returns undefined if no dispatch engine is running for the project.
 * AC: @session-prompt-action ac-1
 */
export function getSessionRegistry(projectDir: string): SessionRegistry | undefined {
  return engines.get(projectDir)?.sessionRegistry;
}

/**
 * Stop all active dispatch engines. Called on daemon shutdown.
 * AC: @agent-dispatch-engine ac-11 - daemon shutdown stops active engines
 */
export async function stopAllEngines(): Promise<void> {
  // Stop hook executors and join accumulators first (synchronous)
  for (const [, hookExecutor] of hookExecutors) {
    hookExecutor.stop();
  }
  hookExecutors.clear();

  for (const [, accumulator] of joinAccumulators) {
    accumulator.stop();
  }
  joinAccumulators.clear();

  // Session registries are owned by dispatch engines and closed during engine.stop()

  const stopPromises: Promise<void>[] = [];
  // Stop schedule engines
  for (const [projectDir, scheduleEngine] of scheduleEngines) {
    stopPromises.push(
      scheduleEngine.stop().catch((err) => {
        console.error(`[schedule-engine] Error stopping for ${projectDir}:`, err);
      }),
    );
  }
  await Promise.all(stopPromises);
  scheduleEngines.clear();

  // Then stop dispatch engines
  const dispatchStopPromises: Promise<void>[] = [];
  for (const [projectDir, engine] of engines) {
    console.log(`[dispatch] Stopping engine for ${projectDir}...`);
    dispatchStopPromises.push(
      engine.stop().catch((err) => {
        console.error(`[dispatch] Error stopping engine for ${projectDir}:`, err);
      }),
    );
  }
  await Promise.all(dispatchStopPromises);
  engines.clear();
  console.log("[dispatch] All engines stopped");
}
