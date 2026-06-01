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
import { Elysia, t } from "elysia";
import { DispatchEngine } from "../../agent-runtime/dispatch.js";
import type {
  TaskStateChange,
  TaskStatus,
  InvocationEvent,
  SyncStateEvent,
} from "../../agent-runtime/dispatch.js";
import { ScheduleEngine } from "../../agent-runtime/schedule-engine.js";
import { HookExecutor } from "../../agent-runtime/hook-executor.js";
import { JoinAccumulator } from "../../agent-runtime/join-accumulator.js";
import { ActionExecutor, type AgentSpawner } from "../../agent-runtime/action-executor.js";
import { SessionRegistry } from "../../agent-runtime/session-registry.js";
import { DEFAULT_KSPEC_CLI_PATH, runInvocation } from "../../agent-runtime/invocation.js";
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

    const sessionId = ulid();
    const result = await runInvocation({
      agent: agentDef,
      specDir: ctx.specDir,
      cwd: projectDir,
      taskRef: options.task_ref,
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

      // AC: @daemon-agent-dispatch ac-6 - Unified dispatch start/stop via action field
      .post(
        "/dispatch",
        async ({ body, projectContext, request, set }) => {
          const projectDir = projectContext.path;

          if (body.action === "start") {
            let requestedCwd: string;
            try {
              requestedCwd = resolveDispatchCwd(projectDir, request.headers.get("X-Kspec-Cwd"));
            } catch (err) {
              set.status = 400;
              return {
                dispatch_enabled: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }

            let engine = engines.get(projectDir);
            if (engine?.getStatus().running) {
              if (engine.getCwd() !== requestedCwd) {
                set.status = 409;
                return {
                  dispatch_enabled: true,
                  error: `Dispatch engine already running for ${projectDir} with cwd ${engine.getCwd()}`,
                };
              }
              return { dispatch_enabled: true, reason: "Already running" };
            }

            engine = createEngine(projectDir, requestedCwd, pubsub);
            engines.set(projectDir, engine);
            await engine.start();
            await startScheduleEngine(projectDir, engine, pubsub);
            await startHookExecutor(projectDir, engine, pubsub);
            await startJoinAccumulator(projectDir, engine, pubsub);

            return { dispatch_enabled: true };
          } else {
            const engine = engines.get(projectDir);
            if (!engine) {
              return { dispatch_enabled: false, reason: "No engine running" };
            }

            stopJoinAccumulator(projectDir);
            stopHookExecutor(projectDir);
            await stopScheduleEngine(projectDir);
            await engine.stop();
            engines.delete(projectDir);

            return { dispatch_enabled: false };
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
        } catch (err) {
          set.status = 400;
          return {
            started: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }

        let engine = engines.get(projectDir);
        if (engine?.getStatus().running) {
          if (engine.getCwd() !== requestedCwd) {
            set.status = 409;
            return {
              started: false,
              error: `Dispatch engine already running for ${projectDir} with cwd ${engine.getCwd()}`,
              status: engine.getStatus(),
            };
          }
          return { started: false, reason: "Already running", status: engine.getStatus() };
        }

        // AC: @agent-dispatch-engine ac-10 - pass kspecCliPath so task notes work from daemon-started engine
        engine = createEngine(projectDir, requestedCwd, pubsub);
        engines.set(projectDir, engine);

        await engine.start();
        await startScheduleEngine(projectDir, engine, pubsub);
        await startHookExecutor(projectDir, engine, pubsub);
        await startJoinAccumulator(projectDir, engine, pubsub);

        return { started: true, status: engine.getStatus() };
      })

      // Stop dispatch engine (legacy route)
      .post("/dispatch/stop", async ({ projectContext }) => {
        const projectDir = projectContext.path;
        const engine = engines.get(projectDir);

        if (!engine) {
          return { stopped: false, reason: "No engine running" };
        }

        stopJoinAccumulator(projectDir);
        stopHookExecutor(projectDir);
        await stopScheduleEngine(projectDir);
        stopSessionRegistry(projectDir);
        await engine.stop();
        engines.delete(projectDir);

        return { stopped: true };
      })

      // Get dispatch engine status (internal format)
      // AC: @dispatch-remote-branch-sync ac-degraded-status-api
      .get("/dispatch/status", ({ projectContext }) => {
        const engine = engines.get(projectContext.path);

        if (!engine) {
          return {
            running: false,
            activeInvocations: 0,
            queuedInvocations: 0,
            invocations: [],
            degraded: { active: false, reason: "", enteredAt: null },
            degradedTargets: [],
          };
        }

        const status = engine.getStatus();
        const degradedTargets = serializeDegradedTargets(engine);
        return {
          ...status,
          degraded: serializeDegradedSummary(degradedTargets),
          degradedTargets,
        };
      })

      // AC: @daemon-agent-dispatch ac-5 - Public status endpoint
      // AC: @ui-api-ref-resolution ac-1 - Include task_title for active invocations
      // AC: @dispatch-remote-branch-sync ac-degraded-status-api
      // AC: @runner-operator-surfaces ac-daemon-dispatch-active-api-includes-runner
      // AC: @runner-operator-surfaces ac-daemon-dispatch-queued-api-includes-runner
      .get("/status", async ({ projectContext }) => {
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
        return {
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
        };
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
