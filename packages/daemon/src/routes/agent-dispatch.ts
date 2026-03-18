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

import path from 'node:path';
import { Elysia, t } from 'elysia';
import { DispatchEngine } from '../../agent-runtime/dispatch.js';
import type { TaskStateChange, TaskStatus, InvocationEvent, SyncStateEvent } from '../../agent-runtime/dispatch.js';
import { DEFAULT_KSPEC_CLI_PATH } from '../../agent-runtime/invocation.js';
import { initContext, loadMetaContext, loadAllTasks, loadAllItems, ReferenceIndex, resolveProjectRoots } from '../../parser/index.js';
import { getCompletedSessionCountsByAgent } from '../../sessions/store.js';
import type { PubSubManager } from '../websocket/pubsub.js';
import type { SessionEventData } from '@kynetic-ai/shared';

const VALID_TASK_STATUSES = new Set<string>([
  "pending", "in_progress", "pending_review", "needs_work", "blocked", "completed", "cancelled",
]);

// Singleton dispatch engine per project path
const engines: Map<string, DispatchEngine> = new Map();

export interface AgentDispatchRouteOptions {
  defaultProjectPath?: string;
  /** PubSubManager for broadcasting agent invocation events to WebSocket clients */
  pubsub?: PubSubManager;
}

/**
 * Create a new dispatch engine with optional WebSocket broadcast wiring.
 * AC: @daemon-agent-dispatch ac-3, ac-4
 */
function createEngine(
  projectDir: string,
  cwd?: string,
  pubsub?: PubSubManager,
): DispatchEngine {
  return new DispatchEngine({
    projectDir,
    cwd,
    kspecCliPath: DEFAULT_KSPEC_CLI_PATH,
    onInvocationEvent: pubsub
      ? (event: InvocationEvent) => {
          // AC: @ui-api-aggregation ac-4 - Include task_title for display
          pubsub.broadcast('agents', 'agent_invocation', {
            session_id: event.session_id,
            agent_id: event.agent_id,
            task_id: event.task_id ?? null,
            task_title: event.task_title ?? null,
            status: event.status,
            timestamp: event.timestamp,
          }, projectDir);
        }
      : undefined,
    // AC: @session-event-broadcast ac-replaces-text-chunks
    // AC: @cli-agent-commands ac-13, @daemon-agent-dispatch ac-8
    onSessionEvent: pubsub
      ? (event: SessionEventData) => {
          pubsub.broadcast('agents', event.type, event, projectDir);
        }
      : undefined,
    // AC: @dispatch-remote-branch-sync ac-degraded-status-broadcast
    onSyncStateEvent: pubsub
      ? (event: SyncStateEvent) => {
          pubsub.broadcast('agents', event.type, event, projectDir);
        }
      : undefined,
  });
}

const stateChangeBodySchema = t.Object({
  task_id: t.String(),
  task_ref: t.Optional(t.String()),
  from_status: t.String(),
  to_status: t.String(),
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
    return { accepted: false, reason: 'Dispatch engine not running' };
  }

  if (!VALID_TASK_STATUSES.has(body.from_status) || !VALID_TASK_STATUSES.has(body.to_status)) {
    return { accepted: false, reason: `Invalid status: from_status="${body.from_status}" to_status="${body.to_status}". Valid values: ${[...VALID_TASK_STATUSES].join(", ")}` };
  }

  const change: TaskStateChange = {
    taskId: body.task_id,
    taskRef: body.task_ref ?? `@${body.task_id}`,
    fromStatus: body.from_status as TaskStatus,
    toStatus: body.to_status as TaskStatus,
    timestamp: body.timestamp ?? Date.now(),
  };

  engine.handleStateChange(change).catch((err) => {
    console.error('[dispatch] Error handling state change event:', err);
  });

  return { accepted: true };
}

export function resolveDispatchCwd(
  projectDir: string,
  requestedCwd: string | null,
): string {
  if (requestedCwd && !path.isAbsolute(requestedCwd)) {
    throw new Error('Dispatch cwd must be an absolute path');
  }
  const cwd = requestedCwd ? path.resolve(requestedCwd) : projectDir;

  if (cwd === projectDir) {
    return cwd;
  }

  const projectRoots = resolveProjectRoots(projectDir);
  const cwdRoots = resolveProjectRoots(cwd);
  if (!projectRoots || !cwdRoots || projectRoots.mainRoot !== cwdRoots.mainRoot) {
    throw new Error('Dispatch cwd must belong to the same git project');
  }

  return cwd;
}

export function createAgentDispatchRoutes(options: AgentDispatchRouteOptions = {}) {
  const { pubsub } = options;

  return new Elysia({ prefix: '/api/agent' })

    // AC: @daemon-agent-dispatch ac-2, ac-7 - CLI posts state change event to daemon
    // AC: @agent-dispatch-engine ac-4
    .post('/events', ({ body, projectContext }) => {
      return processStateChangeEvent(engines.get(projectContext.path), body);
    }, { body: stateChangeBodySchema })

    // Legacy alias — same as /events
    .post('/event', ({ body, projectContext }) => {
      return processStateChangeEvent(engines.get(projectContext.path), body);
    }, { body: stateChangeBodySchema })

    // AC: @daemon-agent-dispatch ac-6 - Unified dispatch start/stop via action field
    .post('/dispatch', async ({ body, projectContext, request, set }) => {
      const projectDir = projectContext.path;

      if (body.action === 'start') {
        let requestedCwd: string;
        try {
          requestedCwd = resolveDispatchCwd(projectDir, request.headers.get('X-Kspec-Cwd'));
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
          return { dispatch_enabled: true, reason: 'Already running' };
        }

        engine = createEngine(projectDir, requestedCwd, pubsub);
        engines.set(projectDir, engine);
        await engine.start();

        return { dispatch_enabled: true };
      } else {
        const engine = engines.get(projectDir);
        if (!engine) {
          return { dispatch_enabled: false, reason: 'No engine running' };
        }

        await engine.stop();
        engines.delete(projectDir);

        return { dispatch_enabled: false };
      }
    }, {
      body: t.Object({
        action: t.Union([t.Literal('start'), t.Literal('stop')]),
      }),
    })

    // Start dispatch engine (legacy route)
    .post('/dispatch/start', async ({ projectContext, request, set }) => {
      const projectDir = projectContext.path;
      let requestedCwd: string;
      try {
        requestedCwd = resolveDispatchCwd(projectDir, request.headers.get('X-Kspec-Cwd'));
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
        return { started: false, reason: 'Already running', status: engine.getStatus() };
      }

      // AC: @agent-dispatch-engine ac-10 - pass kspecCliPath so task notes work from daemon-started engine
      engine = createEngine(projectDir, requestedCwd, pubsub);
      engines.set(projectDir, engine);

      await engine.start();

      return { started: true, status: engine.getStatus() };
    })

    // Stop dispatch engine (legacy route)
    .post('/dispatch/stop', async ({ projectContext }) => {
      const projectDir = projectContext.path;
      const engine = engines.get(projectDir);

      if (!engine) {
        return { stopped: false, reason: 'No engine running' };
      }

      await engine.stop();
      engines.delete(projectDir);

      return { stopped: true };
    })

    // Get dispatch engine status (internal format)
    // AC: @dispatch-remote-branch-sync ac-degraded-status-api
    .get('/dispatch/status', ({ projectContext }) => {
      const engine = engines.get(projectContext.path);

      if (!engine) {
        return {
          running: false,
          activeInvocations: 0,
          queuedInvocations: 0,
          invocations: [],
          degraded: { active: false, reason: '', enteredAt: null },
        };
      }

      const status = engine.getStatus();
      const degraded = engine.getDegradedState();
      return {
        ...status,
        degraded: {
          active: degraded.active,
          reason: degraded.reason,
          enteredAt: degraded.enteredAt?.toISOString() ?? null,
        },
      };
    })

    // AC: @daemon-agent-dispatch ac-5 - Public status endpoint
    // AC: @ui-api-ref-resolution ac-1 - Include task_title for active invocations
    // AC: @dispatch-remote-branch-sync ac-degraded-status-api
    .get('/status', async ({ projectContext }) => {
      const projectDir = projectContext.path;
      const engine = engines.get(projectDir);
      const engineStatus = engine?.getStatus();

      let agentDefinitions: Array<{ id: string; name: string; adapter: string; completed_sessions: number }> = [];
      let completedCounts: Record<string, number> = {};
      let refIndex: ReferenceIndex | null = null;
      try {
        const ctx = await initContext(projectDir);
        const [meta, counts, tasks, items] = await Promise.all([
          loadMetaContext(ctx),
          getCompletedSessionCountsByAgent(ctx.specDir),
          loadAllTasks(ctx),
          loadAllItems(ctx),
        ]);
        completedCounts = counts;
        refIndex = new ReferenceIndex(tasks, items);
        agentDefinitions = meta.agents.map((a) => ({
          id: a.id,
          name: a.name,
          adapter: a.adapter ?? 'claude-agent-acp',
          completed_sessions: completedCounts[a.id] ?? 0,
        }));
      } catch {
        // Agent definitions unavailable — return empty array
      }

      const degradedState = engine?.getDegradedState();
      return {
        dispatch_enabled: engineStatus?.running ?? false,
        active_invocations: engineStatus?.invocations?.map((inv) => {
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
          };
        }) ?? [],
        queue_depth: engineStatus?.queuedInvocations ?? 0,
        agent_definitions: agentDefinitions,
        // AC: @dispatch-remote-branch-sync ac-degraded-status-api
        degraded: degradedState ? {
          active: degradedState.active,
          reason: degradedState.reason,
          enteredAt: degradedState.enteredAt?.toISOString() ?? null,
        } : { active: false, reason: '', enteredAt: null },
      };
    });
}

/**
 * Get the dispatch engine for a project path (for integration with file watcher).
 */
export function getDispatchEngine(projectDir: string): DispatchEngine | undefined {
  return engines.get(projectDir);
}

/**
 * Stop all active dispatch engines. Called on daemon shutdown.
 * AC: @agent-dispatch-engine ac-11 - daemon shutdown stops active engines
 */
export async function stopAllEngines(): Promise<void> {
  const stopPromises: Promise<void>[] = [];
  for (const [projectDir, engine] of engines) {
    console.log(`[dispatch] Stopping engine for ${projectDir}...`);
    stopPromises.push(
      engine.stop().catch((err) => {
        console.error(`[dispatch] Error stopping engine for ${projectDir}:`, err);
      })
    );
  }
  await Promise.all(stopPromises);
  engines.clear();
  console.log('[dispatch] All engines stopped');
}
