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
} from '../../parser/index.js';
import { getSessionCache } from '../../sessions/cache.js';

export function createSessionRoutes() {
  return new Elysia({ prefix: '/api/sessions' })

    // List all sessions with summaries
    // AC: @session-legacy-migration ac-read-fallback ac-list-merge — detect-and-warn for legacy sessions
    // AC: @session-summary-cache ac-cache-build — Uses cached summaries instead of re-reading all files
    .get('/', async ({ projectContext }) => {
      const ctx = await initContext(projectContext.path);
      // AC: @session-summary-cache ac-cache-build — Per-project cache scoped by sessionsDir
      const sessionCache = getSessionCache(ctx.sessionsDir);
      const summaries = await sessionCache.getAll(ctx.sessionsDir);

      // Sort by started_at descending (most recent first)
      summaries.sort((a, b) =>
        new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
      );

      // Detect legacy sessions and include warning in response
      const legacyCount = await countLegacySessions(ctx.specDir);

      return {
        items: summaries,
        total: summaries.length,
        ...(legacyCount > 0 ? {
          warning: `${legacyCount} legacy session(s) found in .kspec/sessions/. Run \`kspec session migrate\` to move them to .kspec-sessions/.`,
        } : {}),
      };
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
