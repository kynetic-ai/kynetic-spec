/**
 * Session API Routes
 *
 * REST endpoints for session data:
 * - GET /api/sessions - list sessions with summaries
 * - GET /api/sessions/:id - get session metadata and detail
 * - GET /api/sessions/:id/events - get session events from events.jsonl
 * - GET /api/sessions/:id/events/:seq - get single event with blob resolution
 *
 * AC Coverage:
 * - @ui-session-stream ac-1: Session events as structured blocks
 * - @ui-session-stream ac-4: Session metadata, spec context, budget for context panel
 * - @session-legacy-migration ac-read-fallback: Detect-and-warn on all session read endpoints
 * - @session-summary-cache ac-cache-build: Cache built on first list request
 * - @session-summary-cache ac-cache-invalidate: Cache refreshed via directory listing diff
 * - @session-summary-cache ac-active-refresh: Active sessions recomputed on each request
 * - @session-event-detail-endpoint ac-single-event-fetch: Single event by seq with blob resolution
 * - @session-event-detail-endpoint ac-blob-resolution: Blob pointers resolved to full content
 * - @session-event-detail-endpoint ac-not-found: 404 for missing session or seq
 */

import { Elysia, t } from 'elysia';
import {
  getSession,
  readEvents,
  readEventBySeq,
  deduplicatePhasedToolCalls,
  resolveSessionId,
  resolveSessionBlobPointers,
  getBudget,
  searchSessionEvents,
  type SessionLogSummary,
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
  type KspecContext,
} from '../../parser/index.js';
import { resolveRefTitle } from './ref-resolution.js';
import { getSessionCache } from '../../sessions/cache.js';
import { SessionStatusSchema, SessionTriggerSchema } from '../../sessions/types.js';
import { parseTimeSpec } from '../../utils/time.js';
import { enumArrayUnion } from './enum-utils.js';

type SessionListQuery = {
  status?: string | string[];
  agent_type?: string | string[];
  agent_id?: string | string[];
  trigger?: string | string[];
  task_id?: string;
  spec_ref?: string;
  since?: string;
};

function normalizeValues(value?: string | string[]): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function sortSessionSummaries(summaries: SessionLogSummary[]): SessionLogSummary[] {
  return [...summaries].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
  );
}

function buildTaskRefSet(task: { _ulid: string; slugs: string[] }): Set<string> {
  const refs = new Set<string>([task._ulid, `@${task._ulid}`]);
  for (const slug of task.slugs) {
    refs.add(slug);
    refs.add(`@${slug}`);
  }
  return refs;
}

function filterSessionsByTaskRefs(
  summaries: SessionLogSummary[],
  refs: Set<string>,
): SessionLogSummary[] {
  return summaries.filter((summary) => {
    if (!summary.task_id) return false;
    const normalized = summary.task_id.startsWith('@')
      ? summary.task_id.slice(1)
      : summary.task_id;
    return refs.has(summary.task_id) || refs.has(normalized);
  });
}

async function filterSessionSummaries(
  ctx: KspecContext,
  query: SessionListQuery,
): Promise<
  | { summaries: SessionLogSummary[]; unfilteredTotal: number }
  | {
      error: {
        status: number;
        body: {
          error: string;
          message?: string;
          suggestion?: string;
          details?: Array<{ field: string; message: string }>;
        };
      };
    }
> {
  const validStatuses = SessionStatusSchema.options;
  const statusValues = normalizeValues(query.status);
  const invalidStatuses = statusValues.filter(
    (status) => !validStatuses.includes(status as typeof validStatuses[number]),
  );
  if (invalidStatuses.length > 0) {
    return {
      error: {
        status: 400,
        body: {
          error: 'invalid_filter',
          details: [
            {
              field: 'status',
              message: `Invalid status value(s): ${invalidStatuses.join(', ')}. Valid values: ${validStatuses.join(', ')}`,
            },
          ],
        },
      },
    };
  }

  const sessionCache = getSessionCache(ctx.sessionsDir);
  let filtered = sortSessionSummaries(await sessionCache.getAll(ctx.sessionsDir));
  // AC: @session-filter-controls ac-filter-counts — Capture unfiltered total before applying filters
  const unfilteredTotal = filtered.length;

  if (statusValues.length > 0) {
    filtered = filtered.filter((summary) => statusValues.includes(summary.status));
  }

  const agentTypeValues = normalizeValues(query.agent_type);
  if (agentTypeValues.length > 0) {
    filtered = filtered.filter((summary) => agentTypeValues.includes(summary.agent_type));
  }

  const agentIdValues = normalizeValues(query.agent_id);
  if (agentIdValues.length > 0) {
    filtered = filtered.filter(
      (summary) => summary.agent_id != null && agentIdValues.includes(summary.agent_id),
    );
  }

  const triggerValues = normalizeValues(query.trigger);
  if (triggerValues.length > 0) {
    filtered = filtered.filter((summary) => {
      if (!summary.trigger) return false;
      return triggerValues.some((value) => {
        if (value === 'dispatched') return summary.trigger!.startsWith('task.');
        return summary.trigger === value;
      });
    });
  }

  let tasks: Awaited<ReturnType<typeof loadAllTasks>> | null = null;
  let items: Awaited<ReturnType<typeof loadAllItems>> | null = null;
  const ensureAlignmentContext = async () => {
    if (!tasks) tasks = await loadAllTasks(ctx);
    if (!items) items = await loadAllItems(ctx);
    return { tasks, items };
  };

  if (query.task_id) {
    const { tasks: loadedTasks, items: loadedItems } = await ensureAlignmentContext();
    const refIndex = new ReferenceIndex(loadedTasks, loadedItems);
    const resolved = refIndex.resolve(
      query.task_id.startsWith('@') ? query.task_id.slice(1) : query.task_id,
    );
    if (!resolved.ok) {
      return {
        error: {
          status: 404,
          body: {
            error: 'not_found',
            message: `Task reference "${query.task_id}" not found`,
            suggestion: 'Use GET /api/tasks or kspec task list to find valid task references',
          },
        },
      };
    }

    const matchTask = loadedTasks.find((task) => task._ulid === resolved.ulid);
    if (matchTask) {
      filtered = filterSessionsByTaskRefs(filtered, buildTaskRefSet(matchTask));
    } else {
      filtered = [];
    }
  }

  if (query.spec_ref) {
    const { tasks: loadedTasks, items: loadedItems } = await ensureAlignmentContext();
    const refIndex = new ReferenceIndex(loadedTasks, loadedItems);
    const alignmentIndex = new AlignmentIndex(loadedTasks, loadedItems);
    alignmentIndex.buildLinks(refIndex);

    const resolved = refIndex.resolve(
      query.spec_ref.startsWith('@') ? query.spec_ref.slice(1) : query.spec_ref,
    );
    if (!resolved.ok) {
      return {
        error: {
          status: 404,
          body: {
            error: 'not_found',
            message: `Spec reference "${query.spec_ref}" not found`,
            suggestion: 'Use GET /api/items or kspec item list to find valid spec references',
          },
        },
      };
    }

    const taskRefs = new Set<string>();
    for (const task of alignmentIndex.getTasksForSpec(resolved.ulid)) {
      for (const ref of buildTaskRefSet(task)) {
        taskRefs.add(ref);
      }
    }
    filtered = filterSessionsByTaskRefs(filtered, taskRefs);
  }

  if (query.since) {
    const sinceDate = parseTimeSpec(query.since);
    if (!sinceDate) {
      return {
        error: {
          status: 400,
          body: {
            error: 'invalid_filter',
            details: [
              {
                field: 'since',
                message: `Invalid time value: "${query.since}". Use ISO 8601 format or a relative value like 7d, 24h, 2w, or 1m.`,
              },
            ],
          },
        },
      };
    }
    filtered = filtered.filter(
      (summary) => new Date(summary.started_at).getTime() >= sinceDate.getTime(),
    );
  }

  return { summaries: filtered, unfilteredTotal };
}

export function createSessionRoutes() {
  return new Elysia({ prefix: '/api/sessions' })

    // List all sessions with summaries, pagination, and filtering
    // AC: @session-legacy-migration ac-read-fallback ac-list-merge — detect-and-warn for legacy sessions
    // AC: @session-summary-cache ac-cache-build — Uses cached summaries instead of re-reading all files
    // AC: @session-list-pagination-api ac-pagination — offset/limit pagination with total
    // AC: @session-list-pagination-api ac-metadata-only — Only reads session.yaml, uses cache
    // AC: @ui-api-ref-resolution ac-1 — Include task_title resolved server-side
    .get('/', async ({ query, error: errorResponse, projectContext }) => {
      const ctx = await initContext(projectContext.path);
      const filteredResult = await filterSessionSummaries(ctx, query);
      if ('error' in filteredResult) {
        return errorResponse(filteredResult.error.status, filteredResult.error.body);
      }
      const filtered = filteredResult.summaries;
      const { unfilteredTotal } = filteredResult;

      // AC: @session-list-pagination-api ac-pagination — Apply pagination after filtering
      // AC: @trait-api-endpoint ac-4 — {items, total, offset, limit} wrapper
      const total = filtered.length;
      const offset = Number(query.offset) || 0;
      const limit = Number(query.limit) || total;
      const paginated = filtered.slice(offset, offset + limit);

      // AC: @ui-api-ref-resolution ac-1 — Resolve task_title for session summaries
      let refIndex: ReferenceIndex | null = null;
      const taskIdsPresent = paginated.some((s) => s.task_id);
      if (taskIdsPresent) {
        try {
          const tasks = await loadAllTasks(ctx);
          const items = await loadAllItems(ctx);
          refIndex = new ReferenceIndex(tasks, items);
        } catch {
          // Non-critical — task_title will be null
        }
      }
      const enriched = paginated.map((s) => ({
        ...s,
        task_title: s.task_id && refIndex ? resolveRefTitle(refIndex, s.task_id) : null,
      }));

      // Detect legacy sessions and include warning in response
      const legacyCount = await countLegacySessions(ctx.specDir);

      // AC: @session-filter-controls ac-filter-counts — Include unfiltered_total in response
      return {
        items: enriched,
        total,
        unfiltered_total: unfilteredTotal,
        offset,
        limit,
        ...(legacyCount > 0 ? {
          warning: `${legacyCount} legacy session(s) found in .kspec/sessions/. Run \`kspec session migrate\` to move them to .kspec-sessions/.`,
        } : {}),
      };
    }, {
      query: t.Object({
        status: t.Optional(enumArrayUnion(SessionStatusSchema.options)),
        agent_type: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        agent_id: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        trigger: t.Optional(enumArrayUnion(SessionTriggerSchema.options)),
        task_id: t.Optional(t.String()),
        spec_ref: t.Optional(t.String()),
        since: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
    })

    // AC: @session-text-search ac-api-search
    // AC: @session-text-search ac-scope-narrowing — metadata filters narrow the scanned sessions first
    .get('/search', async ({ query, error: errorResponse, projectContext }) => {
      const ctx = await initContext(projectContext.path);
      const normalizedQuery = query.q.trim();
      if (normalizedQuery.length === 0) {
        return {
          items: [],
          total_sessions: 0,
          total_matches: 0,
          query: '',
        };
      }

      const filteredResult = await filterSessionSummaries(ctx, query);
      if ('error' in filteredResult) {
        return errorResponse(filteredResult.error.status, filteredResult.error.body);
      }

      const limit = Number(query.limit) || 50;
      const items = await searchSessionEvents(ctx.sessionsDir, normalizedQuery, {
        sessionSummaries: filteredResult.summaries,
        limit,
      });
      const totalMatches = items.reduce((sum, session) => sum + session.matches.length, 0);

      return {
        items,
        total_sessions: items.length,
        total_matches: totalMatches,
        query: normalizedQuery,
      };
    }, {
      query: t.Object({
        q: t.String(),
        status: t.Optional(enumArrayUnion(SessionStatusSchema.options)),
        agent_type: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        agent_id: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        trigger: t.Optional(enumArrayUnion(SessionTriggerSchema.options)),
        task_id: t.Optional(t.String()),
        spec_ref: t.Optional(t.String()),
        since: t.Optional(t.String()),
        limit: t.Optional(t.String()),
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
      // AC: @ui-api-ref-resolution ac-1 — Resolve task_title
      let spec_context: {
        spec_ref: string;
        title: string;
        acceptance_criteria: Array<{ id: string; description: string }>;
      } | null = null;
      let task_title: string | null = null;

      if (metadata?.task_id) {
        try {
          const tasks = await loadAllTasks(ctx);
          const items = await loadAllItems(ctx);
          const index = new ReferenceIndex(tasks, items);
          const taskResult = index.resolve(metadata.task_id);
          if (taskResult.ok) {
            const task = taskResult.item as { title?: string; spec_ref?: string };
            task_title = task.title ?? null;
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
        task_title,
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
    })

    // Get single session event by sequence number with blob resolution
    // AC: @session-event-detail-endpoint ac-single-event-fetch — Returns full event for seq
    // AC: @session-event-detail-endpoint ac-blob-resolution — Blob pointers resolved to full content
    // AC: @session-event-detail-endpoint ac-not-found — 404 for missing session or seq
    // AC: @trait-api-endpoint ac-1 — Returns 2xx with JSON body on success
    // AC: @trait-api-endpoint ac-2 — Returns 404 for invalid session or seq ref
    .get('/:id/events/:seq', async ({ params, error: errorResponse, projectContext }) => {
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

      // Parse and validate seq parameter
      const seq = parseInt(params.seq, 10);
      if (isNaN(seq) || seq < 0) {
        return errorResponse(400, {
          error: 'invalid_parameter',
          details: [{
            field: 'seq',
            message: `Invalid sequence number: "${params.seq}". Must be a non-negative integer.`,
          }],
        });
      }

      // Targeted single-event read
      const event = await readEventBySeq(ctx.sessionsDir, resolution.id, seq);
      if (!event) {
        return errorResponse(404, {
          error: 'not_found',
          message: `Event with seq ${seq} not found in session ${params.id}`,
          suggestion: 'Use GET /api/sessions/:id/events to list available events',
        });
      }

      // Resolve blob pointers in event data
      const resolvedData = await resolveSessionBlobPointers(
        ctx.sessionsDir,
        resolution.id,
        event.data,
      );

      return {
        ...event,
        data: resolvedData,
      };
    });
}
