/**
 * Agent Dispatch API Routes
 *
 * REST endpoints for agent dispatch engine management:
 * - POST /api/agent/dispatch/start  - Start the dispatch engine
 * - POST /api/agent/dispatch/stop   - Stop the dispatch engine
 * - GET  /api/agent/dispatch/status - Get dispatch engine status
 * - POST /api/agent/event           - Post a task state change event
 *
 * AC Coverage:
 * - @agent-dispatch-engine ac-4: CLI posts state change event to daemon
 */

import { Elysia, t } from 'elysia';
import { DispatchEngine } from '../../../agent-runtime/dispatch.js';
import type { TaskStateChange, TaskStatus } from '../../../agent-runtime/dispatch.js';
import { DEFAULT_KSPEC_CLI_PATH } from '../../../agent-runtime/invocation.js';

const VALID_TASK_STATUSES = new Set<string>([
  "pending", "in_progress", "pending_review", "needs_work", "blocked", "completed", "cancelled",
]);

// Singleton dispatch engine per project path
const engines: Map<string, DispatchEngine> = new Map();

export interface AgentDispatchRouteOptions {
  defaultProjectPath?: string;
}

export function createAgentDispatchRoutes(options: AgentDispatchRouteOptions = {}) {
  return new Elysia({ prefix: '/api/agent' })

    // AC: @agent-dispatch-engine ac-4 - CLI posts state change event to daemon
    .post('/event', async ({ body, projectContext }) => {
      const projectDir = projectContext.path;
      const engine = engines.get(projectDir);

      if (!engine || !engine.getStatus().running) {
        return { accepted: false, reason: 'Dispatch engine not running' };
      }

      // Validate status values before casting
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

      // Process asynchronously — don't block the HTTP response
      engine.handleStateChange(change).catch((err) => {
        console.error('[dispatch] Error handling state change event:', err);
      });

      return { accepted: true };
    }, {
      body: t.Object({
        task_id: t.String(),
        task_ref: t.Optional(t.String()),
        from_status: t.String(),
        to_status: t.String(),
        timestamp: t.Optional(t.Number()),
      }),
    })

    // Start dispatch engine
    .post('/dispatch/start', async ({ projectContext }) => {
      const projectDir = projectContext.path;

      let engine = engines.get(projectDir);
      if (engine?.getStatus().running) {
        return { started: false, reason: 'Already running', status: engine.getStatus() };
      }

      // AC: @agent-dispatch-engine ac-10 - pass kspecCliPath so task notes work from daemon-started engine
      engine = new DispatchEngine({ projectDir, kspecCliPath: DEFAULT_KSPEC_CLI_PATH });
      engines.set(projectDir, engine);

      await engine.start();

      return { started: true, status: engine.getStatus() };
    })

    // Stop dispatch engine
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

    // Get dispatch engine status
    .get('/dispatch/status', async ({ projectContext }) => {
      const projectDir = projectContext.path;
      const engine = engines.get(projectDir);

      if (!engine) {
        return {
          running: false,
          activeInvocations: 0,
          queuedInvocations: 0,
          invocations: [],
        };
      }

      return engine.getStatus();
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
