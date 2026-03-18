/**
 * Automation API Routes
 *
 * REST endpoints for hook, schedule, event, and composition management.
 * Used by CLI (for runtime queries and manual triggers) and web UI (for CRUD and status).
 *
 * AC Coverage:
 * - @automation-api ac-1: GET /api/hooks — list configured hooks with enabled state
 * - @automation-api ac-2: GET /api/schedules/:id/status — schedule runtime status
 * - @automation-api ac-3: POST /api/schedules/:id/trigger — manually trigger a schedule
 * - @automation-api ac-4: GET /api/events/recent — recent events from ring buffer
 * - @automation-api ac-5: GET /api/compositions/:config_id/activations — composition activation status
 * - @automation-api ac-6: POST /api/events/emit — emit a test event on the bus
 *
 * Spec: @automation-api
 * Task: @task-daemon-api
 */

import { Elysia, t } from 'elysia';
import { initContext, loadMetaContext } from '../../parser/index.js';
import { getDispatchEngine, getScheduleEngine, getJoinAccumulator } from './agent-dispatch.js';
import type { PubSubManager } from '../websocket/pubsub.js';
import type { EventEnvelope } from '../../agent-runtime/event-bus.js';
import { matchesFilter, type Hook } from '../../schema/hooks.js';

export interface AutomationRouteOptions {
  pubsub?: PubSubManager;
}

export function createAutomationRoutes(options: AutomationRouteOptions = {}) {
  return new Elysia({ prefix: '/api' })

    // ─── Hooks ───────────────────────────────────────────────────────────────

    // AC: @automation-api ac-1 — List all configured hooks with enabled state
    // AC: @trait-api-endpoint ac-1 — Returns 2xx with JSON body
    // AC: @trait-api-endpoint ac-4 — Pagination support
    .get('/hooks', async ({ query, projectContext }) => {
      const ctx = await initContext(projectContext.path);
      const meta = await loadMetaContext(ctx);

      const hooks = meta.hooks.map((hook) => ({
        id: hook._ulid,
        name: hook.name,
        on: hook.on,
        filter: hook.filter ?? null,
        action_type: hook.action.type,
        enabled: hook.enabled,
      }));

      // AC: @trait-api-endpoint ac-4 — Pagination
      const total = hooks.length;
      const offset = Number(query.offset) || 0;
      const limit = Number(query.limit) || total;
      const paginated = hooks.slice(offset, offset + limit);

      return {
        items: paginated,
        total,
        offset,
        limit,
      };
    }, {
      query: t.Object({
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
    })

    // ─── Schedules ───────────────────────────────────────────────────────────

    // AC: @automation-api ac-2 — Schedule runtime status
    // AC: @trait-api-endpoint ac-1 — Returns 2xx with JSON body
    // AC: @trait-api-endpoint ac-2 — 404 if schedule not found
    .get('/schedules/:id/status', ({ params, set, projectContext }) => {
      const scheduleEngine = getScheduleEngine(projectContext.path);

      if (!scheduleEngine) {
        set.status = 404;
        return {
          error: 'not_found',
          message: 'No schedule engine running for project',
          suggestion: 'Start the dispatch engine first with POST /api/agent/dispatch',
        };
      }

      const status = scheduleEngine.getScheduleStatus(params.id);

      if (!status) {
        set.status = 404;
        return {
          error: 'not_found',
          message: `Schedule "${params.id}" not found`,
          suggestion: 'Use GET /api/schedules to list all schedules',
        };
      }

      // AC: @automation-api ac-2 — Include next_tick, last_tick, run_count,
      // active_run_count, active_run_ids, and current overlap state
      const overlapState = status.active_run_count > 0
        ? (status.buffered ? 'running_buffered' : 'running')
        : 'idle';

      return {
        id: status.id,
        name: status.name,
        enabled: status.enabled,
        cron: status.cron,
        timezone: status.timezone,
        overlap_policy: status.overlap_policy,
        next_tick: status.next_tick,
        last_tick: status.last_tick,
        run_count: status.run_count,
        active_run_count: status.active_run_count,
        active_run_ids: status.active_run_ids,
        overlap_state: overlapState,
      };
    }, {
      params: t.Object({
        id: t.String(),
      }),
    })

    // AC: @automation-api ac-3 — Manually trigger a schedule
    // AC: @trait-api-endpoint ac-1 — Returns 2xx with JSON body
    // AC: @trait-api-endpoint ac-2 — 404 if schedule not found
    .post('/schedules/:id/trigger', async ({ params, set, projectContext }) => {
      const scheduleEngine = getScheduleEngine(projectContext.path);

      if (!scheduleEngine) {
        set.status = 404;
        return {
          error: 'not_found',
          message: 'No schedule engine running for project',
          suggestion: 'Start the dispatch engine first with POST /api/agent/dispatch',
        };
      }

      const result = await scheduleEngine.triggerSchedule(params.id);

      if (!result.accepted && result.reason?.startsWith('Schedule not found')) {
        set.status = 404;
        return {
          error: 'not_found',
          message: `Schedule "${params.id}" not found`,
          suggestion: 'Use GET /api/schedules to list all schedules',
        };
      }

      // AC: @automation-api ac-3 — Response indicates trigger outcome
      let outcome: 'accepted' | 'buffered' | 'skipped';
      if (result.accepted) {
        outcome = 'accepted';
      } else if (result.reason?.includes('Buffered')) {
        outcome = 'buffered';
      } else {
        outcome = 'skipped';
      }

      return {
        outcome,
        accepted: result.accepted,
        reason: result.reason ?? null,
      };
    }, {
      params: t.Object({
        id: t.String(),
      }),
    })

    // GET /api/schedules — List all schedules with pagination
    // AC: @trait-api-endpoint ac-4 — Pagination support
    .get('/schedules', async ({ query, projectContext }) => {
      const ctx = await initContext(projectContext.path);
      const meta = await loadMetaContext(ctx);
      const scheduleEngine = getScheduleEngine(projectContext.path);

      // Build schedule list combining config and runtime state
      const runtimeStatuses = scheduleEngine?.getStatus() ?? [];
      const runtimeMap = new Map(runtimeStatuses.map((s) => [s.id, s]));

      const schedules = meta.schedules.map((schedule) => {
        const runtime = runtimeMap.get(schedule.id);
        return {
          id: schedule.id,
          name: schedule.name,
          enabled: schedule.enabled,
          cron: schedule.cron,
          timezone: schedule.timezone,
          overlap_policy: schedule.overlap_policy,
          next_tick: runtime?.next_tick ?? null,
          last_tick: runtime?.last_tick ?? null,
          run_count: runtime?.run_count ?? 0,
          active_run_count: runtime?.active_run_count ?? 0,
        };
      });

      // AC: @trait-api-endpoint ac-4 — Pagination
      const total = schedules.length;
      const offset = Number(query.offset) || 0;
      const limit = Number(query.limit) || total;
      const paginated = schedules.slice(offset, offset + limit);

      return {
        items: paginated,
        total,
        offset,
        limit,
      };
    }, {
      query: t.Object({
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
    })

    // ─── Events ──────────────────────────────────────────────────────────────

    // AC: @automation-api ac-4 — Recent events from ring buffer
    // AC: @trait-api-endpoint ac-1 — Returns 2xx with JSON body
    .get('/events/recent', ({ query, projectContext }) => {
      const engine = getDispatchEngine(projectContext.path);
      let events: EventEnvelope[] = [];

      if (engine) {
        events = engine.eventBus.getRecentEvents();
      }

      // AC: @automation-api ac-4 — Filter by event type if specified
      if (query.type) {
        events = events.filter((e) => e.event_type === query.type);
      }

      // AC: @trait-api-endpoint ac-4 — Pagination
      const total = events.length;
      const offset = Number(query.offset) || 0;
      const limit = Number(query.limit) || total;
      const paginated = events.slice(offset, offset + limit);

      return {
        items: paginated.map((e) => ({
          event_id: e.event_id,
          event_type: e.event_type,
          emitted_at: new Date(e.emitted_at).toISOString(),
          source_type: e.source_type,
          source_id: e.source_id,
          causation_id: e.causation_id,
          correlation_id: e.correlation_id,
          payload: e.payload,
        })),
        total,
        offset,
        limit,
      };
    }, {
      query: t.Object({
        type: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
    })

    // AC: @automation-api ac-6 — Emit a test event on the bus
    // AC: @trait-api-endpoint ac-1 — Returns 2xx with JSON body
    // AC: @trait-api-endpoint ac-3 — Returns 400 on validation error
    .post('/events/emit', async ({ body, set, projectContext }) => {
      const engine = getDispatchEngine(projectContext.path);

      if (!engine) {
        set.status = 400;
        return {
          error: 'engine_not_running',
          details: [{ field: 'dispatch', message: 'Dispatch engine is not running. Start it first with POST /api/agent/dispatch' }],
        };
      }

      // Load hooks to determine which will match (before emitting)
      let hooks: Hook[] = [];
      try {
        const ctx = await initContext(projectContext.path);
        const meta = await loadMetaContext(ctx);
        hooks = meta.hooks;
      } catch {
        // Proceed without hook matching info
      }

      // Emit on the bus as manual source
      const emitResult = engine.eventBus.emit({
        event_type: body.event_type,
        source_type: 'manual',
        source_id: 'api',
        payload: body.payload ?? {},
      });

      if (!emitResult.accepted) {
        return {
          accepted: false,
          reason: emitResult.reason ?? null,
          matched_hooks: [],
        };
      }

      // AC: @automation-api ac-6 — Report which hooks matched this event.
      // Hook execution happens asynchronously via HookExecutor's bus subscription.
      // We report names of hooks whose filters match; action_run_ids are not
      // available synchronously for async actions (per AC-6).
      const event = emitResult.event!;
      const envelope: Record<string, unknown> = {
        event_id: event.event_id,
        event_type: event.event_type,
        emitted_at: event.emitted_at,
        source_type: event.source_type,
        source_id: event.source_id,
        causation_id: event.causation_id,
        correlation_id: event.correlation_id,
      };

      const matchedHooks = hooks
        .filter((hook) =>
          hook.enabled &&
          hook.on === body.event_type &&
          matchesFilter(hook.filter, envelope, body.payload ?? {}),
        )
        .map((hook) => ({
          name: hook.name,
          action_run_id: null as string | null,
        }));

      return {
        accepted: true,
        event_id: event.event_id,
        matched_hooks: matchedHooks,
      };
    }, {
      body: t.Object({
        event_type: t.String(),
        payload: t.Optional(t.Record(t.String(), t.Unknown())),
      }),
    })

    // ─── Compositions ────────────────────────────────────────────────────────

    // AC: @automation-api ac-5 — Composition activation status
    // AC: @trait-api-endpoint ac-1 — Returns 2xx with JSON body
    // AC: @trait-api-endpoint ac-2 — 404 if composition not found
    .get('/compositions/:config_id/activations', ({ params, set, projectContext }) => {
      const joinAccumulator = getJoinAccumulator(projectContext.path);

      if (!joinAccumulator) {
        set.status = 404;
        return {
          error: 'not_found',
          message: 'No composition engine running for project',
          suggestion: 'Start the dispatch engine first with POST /api/agent/dispatch',
        };
      }

      const activeGroups = joinAccumulator.getActiveGroups();

      // Filter activations for the requested config_id
      const activations: Array<{
        activation_id: string;
        group_id: string;
        completed_count: number;
        failed_count: number;
        total_members: number;
        member_action_run_ids: string[];
        timeout_remaining_ms: number | null;
        first_run_at: string | null;
      }> = [];

      for (const [groupId, group] of activeGroups) {
        if (group.config_id !== params.config_id) continue;

        // Calculate timeout remaining if applicable
        let timeoutRemaining: number | null = null;
        if (group.first_run_at && group.timeout_handle) {
          const elapsed = Date.now() - group.first_run_at;
          timeoutRemaining = Math.max(0, elapsed);
        }

        activations.push({
          activation_id: group.activation_id,
          group_id: groupId,
          completed_count: group.completed_count,
          failed_count: group.failed_count,
          total_members: group.members.length,
          member_action_run_ids: group.members.map((m) => m.action_run_id),
          timeout_remaining_ms: timeoutRemaining,
          first_run_at: group.first_run_at
            ? new Date(group.first_run_at).toISOString()
            : null,
        });
      }

      return {
        config_id: params.config_id,
        activations,
      };
    }, {
      params: t.Object({
        config_id: t.String(),
      }),
    });
}
