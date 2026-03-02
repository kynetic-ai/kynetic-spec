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
import type { TaskStateChange } from '../../../agent-runtime/dispatch.js';

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

      const change: TaskStateChange = {
        taskId: body.task_id,
        taskRef: body.task_ref ?? `@${body.task_id}`,
        fromStatus: body.from_status as TaskStateChange['fromStatus'],
        toStatus: body.to_status as TaskStateChange['toStatus'],
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

      engine = new DispatchEngine({ projectDir });
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
