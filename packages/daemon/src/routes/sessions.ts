/**
 * Session API Routes
 *
 * REST endpoints for session data:
 * - GET /api/sessions - list sessions with summaries
 * - GET /api/sessions/:id - get session metadata and detail
 * - GET /api/sessions/:id/events - get session events from events.jsonl
 *
 * AC Coverage:
 * - @ui-session-stream ac-1: Session events as structured blocks
 * - @ui-session-stream ac-4: Session metadata, spec context, budget for context panel
 * - @session-legacy-migration ac-read-fallback: Detect-and-warn on all session read endpoints
 * - @session-summary-cache ac-cache-build: Cache built on first list request
 * - @session-summary-cache ac-cache-invalidate: Cache refreshed via directory listing diff
 * - @session-summary-cache ac-active-refresh: Active sessions recomputed on each request
 */

import { Elysia, t } from 'elysia';
import {
  getSession,
  readEvents,
  deduplicatePhasedToolCalls,
  resolveSessionId,
  getBudget,
} from '../../sessions/store.js';
import {
  countLegacySessions,
} from '../../sessions/legacy.js';
import {
  initContext,
  loadAllTasks,
  loadAllItems,
  ReferenceIndex,
  AlignmentIndex,
} from '../../parser/index.js';
import { getSessionCache } from '../../sessions/cache.js';
import { SessionStatusSchema } from '../../sessions/types.js';

export function createSessionRoutes() {
  return new Elysia({ prefix: '/api/sessions' })

    // List all sessions with summaries, pagination, and filtering
    // AC: @session-legacy-migration ac-read-fallback ac-list-merge — detect-and-warn for legacy sessions
    // AC: @session-summary-cache ac-cache-build — Uses cached summaries instead of re-reading all files
    // AC: @session-list-pagination-api ac-pagination — offset/limit pagination with total
    // AC: @session-list-pagination-api ac-metadata-only — Only reads session.yaml, uses cache
    .get('/', async ({ query, error: errorResponse, projectContext }) => {
      const ctx = await initContext(projectContext.path);

      // AC: @session-list-pagination-api ac-invalid-filter — Validate status values
      const validStatuses = SessionStatusSchema.options;
      if (query.status) {
        const statusValues = Array.isArray(query.status) ? query.status : [query.status];
        const invalid = statusValues.filter(s => !validStatuses.includes(s as typeof validStatuses[number]));
        if (invalid.length > 0) {
          return errorResponse(400, {
            error: 'invalid_filter',
            details: [{
              field: 'status',
              message: `Invalid status value(s): ${invalid.join(', ')}. Valid values: ${validStatuses.join(', ')}`,
            }],
          });
        }
      }

      // AC: @session-summary-cache ac-cache-build — Per-project cache scoped by sessionsDir
      const sessionCache = getSessionCache(ctx.sessionsDir);
      const summaries = await sessionCache.getAll(ctx.sessionsDir);

      // AC: @session-list-pagination-api ac-pagination — Sort by started_at descending (most recent first)
      summaries.sort((a, b) =>
        new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
      );

      // Apply filters — all are AND'd together
      // AC: @session-list-pagination-api ac-combined-filters
      let filtered = summaries;

      // AC: @session-list-pagination-api ac-filter-status — Multi-value OR filter
      if (query.status) {
        const statusFilters = Array.isArray(query.status) ? query.status : [query.status];
        filtered = filtered.filter(s => statusFilters.includes(s.status));
      }

      // AC: @session-list-pagination-api ac-filter-agent-type
      if (query.agent_type) {
        const agentTypeFilters = Array.isArray(query.agent_type) ? query.agent_type : [query.agent_type];
        filtered = filtered.filter(s => agentTypeFilters.includes(s.agent_type));
      }

      // AC: @session-list-pagination-api ac-filter-agent-id
      if (query.agent_id) {
        const agentIdFilters = Array.isArray(query.agent_id) ? query.agent_id : [query.agent_id];
        filtered = filtered.filter(s => s.agent_id != null && agentIdFilters.includes(s.agent_id));
      }

      // AC: @session-list-pagination-api ac-filter-trigger — with "dispatched" shorthand
      if (query.trigger) {
        const triggerFilters = Array.isArray(query.trigger) ? query.trigger : [query.trigger];
        filtered = filtered.filter(s => {
          if (!s.trigger) return false;
          return triggerFilters.some(tf => {
            if (tf === 'dispatched') return s.trigger!.startsWith('task.');
            return s.trigger === tf;
          });
        });
      }

      // AC: @session-list-pagination-api ac-filter-task
      // AC: @trait-api-endpoint ac-2 — 404 for unknown task_id ref
      if (query.task_id) {
        const taskRef = query.task_id.startsWith('@') ? query.task_id.slice(1) : query.task_id;
        // Resolve the task ref to find matching sessions
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const refIndex = new ReferenceIndex(tasks, items);
        const resolved = refIndex.resolve(taskRef);
        if (resolved.ok) {
          // Match by ULID or any slug
          const matchTask = tasks.find(t => t._ulid === resolved.ulid);
          const matchRefs = new Set<string>([resolved.ulid]);
          if (matchTask) {
            for (const slug of matchTask.slugs) matchRefs.add(slug);
            matchRefs.add(`@${resolved.ulid}`);
            for (const slug of matchTask.slugs) matchRefs.add(`@${slug}`);
          }
          filtered = filtered.filter(s => {
            if (!s.task_id) return false;
            const tid = s.task_id.startsWith('@') ? s.task_id.slice(1) : s.task_id;
            return matchRefs.has(tid) || matchRefs.has(s.task_id);
          });
        } else {
          return errorResponse(404, {
            error: 'not_found',
            message: `Task reference "${query.task_id}" not found`,
            suggestion: 'Use GET /api/tasks or kspec task list to find valid task references',
          });
        }
      }

      // AC: @session-list-pagination-api ac-filter-spec-ref — resolve spec to linked tasks
      // AC: @trait-api-endpoint ac-2 — 404 for unknown spec_ref
      if (query.spec_ref) {
        const specRef = query.spec_ref.startsWith('@') ? query.spec_ref.slice(1) : query.spec_ref;
        const tasks = await loadAllTasks(ctx);
        const items = await loadAllItems(ctx);
        const refIndex = new ReferenceIndex(tasks, items);
        const alignIndex = new AlignmentIndex(tasks, items);
        alignIndex.buildLinks(refIndex);

        const specResult = refIndex.resolve(specRef);
        if (specResult.ok) {
          const linkedTasks = alignIndex.getTasksForSpec(specResult.ulid);
          const taskRefs = new Set<string>();
          for (const t of linkedTasks) {
            taskRefs.add(t._ulid);
            for (const slug of t.slugs) taskRefs.add(slug);
            taskRefs.add(`@${t._ulid}`);
            for (const slug of t.slugs) taskRefs.add(`@${slug}`);
          }
          filtered = filtered.filter(s => {
            if (!s.task_id) return false;
            const tid = s.task_id.startsWith('@') ? s.task_id.slice(1) : s.task_id;
            return taskRefs.has(tid) || taskRefs.has(s.task_id);
          });
        } else {
          return errorResponse(404, {
            error: 'not_found',
            message: `Spec reference "${query.spec_ref}" not found`,
            suggestion: 'Use GET /api/items or kspec item list to find valid spec references',
          });
        }
      }

      // AC: @session-list-pagination-api ac-filter-since
      if (query.since) {
        const sinceDate = new Date(query.since);
        if (isNaN(sinceDate.getTime())) {
          return errorResponse(400, {
            error: 'invalid_filter',
            details: [{
              field: 'since',
              message: `Invalid date value: "${query.since}". Use ISO 8601 format (e.g., 2025-03-01 or 2025-03-01T00:00:00Z).`,
            }],
          });
        }
        const sinceMs = sinceDate.getTime();
        filtered = filtered.filter(s => new Date(s.started_at).getTime() >= sinceMs);
      }

      // AC: @session-list-pagination-api ac-pagination — Apply pagination after filtering
      // AC: @trait-api-endpoint ac-4 — {items, total, offset, limit} wrapper
      const total = filtered.length;
      const offset = Number(query.offset) || 0;
      const limit = Number(query.limit) || total;
      const paginated = filtered.slice(offset, offset + limit);

      // Detect legacy sessions and include warning in response
      const legacyCount = await countLegacySessions(ctx.specDir);

      return {
        items: paginated,
        total,
        offset,
        limit,
        ...(legacyCount > 0 ? {
          warning: `${legacyCount} legacy session(s) found in .kspec/sessions/. Run \`kspec session migrate\` to move them to .kspec-sessions/.`,
        } : {}),
      };
    }, {
      query: t.Object({
        status: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        agent_type: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        agent_id: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        trigger: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        task_id: t.Optional(t.String()),
        spec_ref: t.Optional(t.String()),
        since: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
    })

    // Get single session metadata
    // AC: @ui-session-stream ac-4 — Includes spec context, budget, and task info
    // AC: @session-legacy-migration ac-read-fallback — detect-and-warn for legacy sessions
    .get('/:id', async ({ params, error: errorResponse, projectContext }) => {
      const ctx = await initContext(projectContext.path);

      // Resolve session ID (supports prefix matching)
      const resolution = await resolveSessionId(ctx.sessionsDir, params.id);
      if (!resolution.ok) {
        if (resolution.error === 'ambiguous') {
          return errorResponse(400, {
            error: 'ambiguous_id',
            message: `Ambiguous session ID: ${params.id} matches ${resolution.matches.length} sessions`,
            suggestion: 'Provide a longer prefix to uniquely identify the session',
          });
        }
        return errorResponse(404, {
          error: 'not_found',
          message: `Session not found: ${params.id}`,
          suggestion: 'Use GET /api/sessions to list available sessions',
        });
      }

      const sessionCache = getSessionCache(ctx.sessionsDir);
      const detail = await sessionCache.get(ctx.sessionsDir, resolution.id);
      if (!detail) {
        return errorResponse(404, {
          error: 'not_found',
          message: `Session not found: ${params.id}`,
          suggestion: 'Use GET /api/sessions to list available sessions',
        });
      }

      const metadata = await getSession(ctx.sessionsDir, resolution.id);

      // AC: @ui-session-stream ac-4 — Resolve spec context from task's spec_ref
      let spec_context: {
        spec_ref: string;
        title: string;
        acceptance_criteria: Array<{ id: string; description: string }>;
      } | null = null;

      if (metadata?.task_id) {
        try {
          const tasks = await loadAllTasks(ctx);
          const items = await loadAllItems(ctx);
          const index = new ReferenceIndex(tasks, items);
          const taskResult = index.resolve(metadata.task_id);
          if (taskResult.ok) {
            const task = taskResult.item as { spec_ref?: string };
            if (task.spec_ref) {
              const specResult = index.resolve(task.spec_ref);
              if (specResult.ok) {
                const specItem = specResult.item as {
                  title: string;
                  acceptance_criteria?: Array<{ description?: string; given?: string }>;
                };
                spec_context = {
                  spec_ref: task.spec_ref,
                  title: specItem.title,
                  acceptance_criteria: (specItem.acceptance_criteria ?? []).map((ac, i) => ({
                    id: `ac-${i + 1}`,
                    description: ac.description ?? ac.given ?? '',
                  })),
                };
              }
            }
          }
        } catch {
          // Non-critical — spec context is optional
        }
      }

      // AC: @ui-session-stream ac-4 — Include budget info
      let budget: { max_per_cycle: number; started_this_cycle: number } | null = null;
      try {
        budget = await getBudget(ctx.sessionsDir, resolution.id);
      } catch {
        // No budget configured — that's fine
      }

      // Detect legacy sessions and include warning in response
      const legacyCount = await countLegacySessions(ctx.specDir);

      return {
        ...detail,
        task_id: metadata?.task_id,
        agent_id: metadata?.agent_id,
        trigger: metadata?.trigger ?? 'legacy',
        spec_context,
        budget,
        ...(legacyCount > 0 ? {
          warning: `${legacyCount} legacy session(s) found in .kspec/sessions/. Run \`kspec session migrate\` to move them to .kspec-sessions/.`,
        } : {}),
      };
    })

    // Get session events
    // AC: @session-legacy-migration ac-read-fallback — detect-and-warn for legacy sessions
    .get('/:id/events', async ({ params, query, error: errorResponse, projectContext }) => {
      const ctx = await initContext(projectContext.path);

      const resolution = await resolveSessionId(ctx.sessionsDir, params.id);
      if (!resolution.ok) {
        if (resolution.error === 'ambiguous') {
          return errorResponse(400, {
            error: 'ambiguous_id',
            message: `Ambiguous session ID: ${params.id} matches ${resolution.matches.length} sessions`,
            suggestion: 'Provide a longer prefix to uniquely identify the session',
          });
        }
        return errorResponse(404, {
          error: 'not_found',
          message: `Session not found: ${params.id}`,
          suggestion: 'Use GET /api/sessions to list available sessions',
        });
      }

      let events = await readEvents(ctx.sessionsDir, resolution.id);

      // Deduplicate phased tool calls
      events = deduplicatePhasedToolCalls(events);

      // Filter by since_seq if provided (for incremental loading)
      const sinceSeq = query.since_seq !== undefined ? parseInt(query.since_seq, 10) : undefined;
      if (sinceSeq !== undefined && !isNaN(sinceSeq)) {
        events = events.filter(e => e.seq > sinceSeq);
      }

      // Detect legacy sessions and include warning in response
      const legacyCount = await countLegacySessions(ctx.specDir);

      return {
        events,
        total: events.length,
        ...(legacyCount > 0 ? {
          warning: `${legacyCount} legacy session(s) found in .kspec/sessions/. Run \`kspec session migrate\` to move them to .kspec-sessions/.`,
        } : {}),
      };
    }, {
      query: t.Object({
        since_seq: t.Optional(t.String()),
      }),
    });
}
