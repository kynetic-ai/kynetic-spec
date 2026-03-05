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
 * - @ui-session-stream ac-4: Session metadata for context panel
 */

import { Elysia, t } from 'elysia';
import {
  getSession,
  listSessions,
  readEvents,
  deduplicatePhasedToolCalls,
  getSessionLogSummary,
  getAllSessionLogSummaries,
  resolveSessionId,
} from '../../sessions/store.js';
import { initContext } from '../../parser/index.js';

export function createSessionRoutes() {
  return new Elysia({ prefix: '/api/sessions' })

    // List all sessions with summaries
    .get('/', async ({ projectContext }) => {
      const ctx = await initContext(projectContext.path);
      const summaries = await getAllSessionLogSummaries(ctx.specDir);

      // Sort by started_at descending (most recent first)
      summaries.sort((a, b) =>
        new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
      );

      return {
        items: summaries,
        total: summaries.length,
      };
    })

    // Get single session metadata
    .get('/:id', async ({ params, projectContext }) => {
      const ctx = await initContext(projectContext.path);

      // Resolve session ID (supports prefix matching)
      const resolution = await resolveSessionId(ctx.specDir, params.id);
      if (!resolution.ok) {
        if (resolution.error === 'ambiguous') {
          throw new Error(`Ambiguous session ID: ${params.id} matches ${resolution.matches.length} sessions`);
        }
        throw new Error(`Session not found: ${params.id}`);
      }

      const detail = await getSessionLogSummary(ctx.specDir, resolution.id);
      if (!detail) {
        throw new Error(`Session not found: ${params.id}`);
      }

      const metadata = await getSession(ctx.specDir, resolution.id);

      return {
        ...detail,
        task_id: metadata?.task_id,
        agent_id: metadata?.agent_id,
        trigger: metadata?.trigger ?? 'legacy',
      };
    })

    // Get session events
    .get('/:id/events', async ({ params, query, projectContext }) => {
      const ctx = await initContext(projectContext.path);

      const resolution = await resolveSessionId(ctx.specDir, params.id);
      if (!resolution.ok) {
        if (resolution.error === 'ambiguous') {
          throw new Error(`Ambiguous session ID: ${params.id} matches ${resolution.matches.length} sessions`);
        }
        throw new Error(`Session not found: ${params.id}`);
      }

      let events = await readEvents(ctx.specDir, resolution.id);

      // Deduplicate phased tool calls
      events = deduplicatePhasedToolCalls(events);

      // Filter by since_seq if provided (for incremental loading)
      const sinceSeq = query.since_seq !== undefined ? parseInt(query.since_seq, 10) : undefined;
      if (sinceSeq !== undefined && !isNaN(sinceSeq)) {
        events = events.filter(e => e.seq > sinceSeq);
      }

      return {
        events,
        total: events.length,
      };
    }, {
      query: t.Object({
        since_seq: t.Optional(t.String()),
      }),
    });
}
