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
 * - @session-event-detail-endpoint ac-single-event-fetch: Single event by seq with blob resolution
 * - @session-event-detail-endpoint ac-blob-resolution: Blob pointers resolved to full content
 * - @session-event-detail-endpoint ac-not-found: 404 for missing session or seq
 */

import { join } from "path";
import { Elysia, t } from "elysia";
import {
  getSession,
  readEvents,
  readEventBySeq,
  deduplicatePhasedToolCalls,
  resolveSessionId,
  resolveSessionBlobPointers,
  getBudget,
  searchSessionEvents,
  getSessionLogSummary,
  type SessionLogSummary,
  type SessionIdResolution,
} from "../../sessions/store.js";
import { countLegacySessions } from "../../sessions/legacy.js";
import {
  initContext,
  loadAllItems,
  ReferenceIndex,
  AlignmentIndex,
  resolveTaskDataManager,
  type KspecContext,
  type LoadedTask,
  type LoadedSpecItem,
} from "../../parser/index.js";
import {
  BreadcrumbAncestryResolver,
  type AncestryItemInput,
  type AncestryTaskInput,
} from "../../lib/breadcrumb-ancestry.js";
import type { BreadcrumbAncestor } from "@kynetic-ai/shared";
import { resolveRefTitle } from "./ref-resolution.js";
import { SessionStatusSchema, SessionTriggerSchema } from "../../sessions/types.js";
import { parseTimeSpec } from "../../utils/time.js";
import { enumArrayUnion } from "./enum-utils.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";
import { wrapResponse } from "./response-envelope.js";
import { listSessionSummariesFromDisk } from "./session-summary-utils.js";
import { taskStorageIncompatibilityResponse } from "./task-storage-error.js";

interface SessionRouteOptions {
  getEntityCache?: EntityCacheAccessor;
}

const VALID_SESSION_TRIGGER_FILTERS = [...SessionTriggerSchema.options, "dispatched"] as const;

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
  return [...summaries].toSorted(
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
    const normalized = summary.task_id.startsWith("@") ? summary.task_id.slice(1) : summary.task_id;
    return refs.has(summary.task_id) || refs.has(normalized);
  });
}

async function filterSessionSummaries(
  getCtx: (() => Promise<KspecContext>) | KspecContext,
  query: SessionListQuery,
  options?: { getEntityCache?: EntityCacheAccessor; projectPath?: string; preferDisk?: boolean },
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
          code?: string;
          field?: string;
          cache_domain?: string;
          cache_domain_state?: string;
        };
      };
    }
> {
  // Support both lazy factory and pre-initialized context for backward compatibility
  const resolveCtx = typeof getCtx === "function" ? getCtx : async () => getCtx;

  const validStatuses = SessionStatusSchema.options;
  const statusValues = normalizeValues(query.status);
  const invalidStatuses = statusValues.filter(
    (status) => !validStatuses.includes(status as (typeof validStatuses)[number]),
  );
  if (invalidStatuses.length > 0) {
    return {
      error: {
        status: 400,
        body: {
          error: "invalid_filter",
          details: [
            {
              field: "status",
              message: `Invalid status value(s): ${invalidStatuses.join(", ")}. Valid values: ${validStatuses.join(", ")}`,
            },
          ],
        },
      },
    };
  }

  // AC: @daemon-entity-cache ac-serve-from-memory — use unified cache session index when available
  const entityCache = options?.projectPath ? options.getEntityCache?.(options.projectPath) : null;
  const sessionsDomainReady =
    !options?.preferDisk && entityCache && entityCache.getDomainState("sessions") === "ready";

  let allSummaries: SessionLogSummary[];
  if (sessionsDomainReady) {
    allSummaries = entityCache!.getSessionIndex() ?? [];
  } else {
    // AC: @daemon-entity-cache ac-graceful-degradation — fall back to disk-backed
    // metadata summaries while the unified cache is warming or degraded.
    const ctx = await resolveCtx();
    allSummaries = await listSessionSummariesFromDisk(ctx.sessionsDir, entityCache);
  }

  let filtered = sortSessionSummaries(allSummaries);
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
        if (value === "dispatched") return summary.trigger!.startsWith("task.");
        return summary.trigger === value;
      });
    });
  }

  let tasks: LoadedTask[] | null = null;
  let items: Awaited<ReturnType<typeof loadAllItems>> | null = null;
  // AC: @daemon-entity-cache ac-serve-from-memory — use cached task/item indexes for alignment filtering
  type EnsureAlignmentResult =
    | { tasks: LoadedTask[]; items: LoadedSpecItem[] }
    | { conflict: ReturnType<typeof taskStorageIncompatibilityResponse> };
  const ensureAlignmentContext = async (): Promise<EnsureAlignmentResult> => {
    if (!tasks) {
      const tasksDomainReady = entityCache && entityCache.getDomainState("tasks") === "ready";
      if (tasksDomainReady) {
        // TaskSummary has _ulid, slugs, spec_ref, title, status — sufficient for ReferenceIndex + AlignmentIndex
        tasks = (entityCache!.getTaskIndex() ?? []) as unknown as LoadedTask[];
      } else {
        const ctx = await resolveCtx();
        try {
          tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
        } catch (err) {
          // AC: @api-contract ac-task-storage-incompatibility-* — propagate the
          // structured 409 envelope back to the caller instead of throwing.
          const conflict = taskStorageIncompatibilityResponse(err, { cache: entityCache });
          if (conflict) return { conflict };
          throw err;
        }
      }
    }
    if (!items) {
      const itemsDomainReady = entityCache && entityCache.getDomainState("items") === "ready";
      if (itemsDomainReady) {
        // ItemSummary has _ulid, slugs — sufficient for ReferenceIndex + AlignmentIndex
        items = (entityCache!.getItemIndex() ?? []) as unknown as LoadedSpecItem[];
      } else {
        const ctx = await resolveCtx();
        items = await loadAllItems(ctx);
      }
    }
    return { tasks: tasks!, items: items! };
  };

  if (query.task_id) {
    const alignment = await ensureAlignmentContext();
    if ("conflict" in alignment) {
      const conflict = alignment.conflict!;
      return { error: { status: conflict.status, body: conflict.body } };
    }
    const { tasks: loadedTasks, items: loadedItems } = alignment;
    const refIndex = new ReferenceIndex(loadedTasks, loadedItems);
    const resolved = refIndex.resolve(
      query.task_id.startsWith("@") ? query.task_id.slice(1) : query.task_id,
    );
    if (!resolved.ok) {
      return {
        error: {
          status: 404,
          body: {
            error: "not_found",
            message: `Task reference "${query.task_id}" not found`,
            suggestion: "Use GET /api/tasks or kspec task list to find valid task references",
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
    const alignment = await ensureAlignmentContext();
    if ("conflict" in alignment) {
      const conflict = alignment.conflict!;
      return { error: { status: conflict.status, body: conflict.body } };
    }
    const { tasks: loadedTasks, items: loadedItems } = alignment;
    const refIndex = new ReferenceIndex(loadedTasks, loadedItems);
    const alignmentIndex = new AlignmentIndex(loadedTasks, loadedItems);
    alignmentIndex.buildLinks(refIndex);

    const resolved = refIndex.resolve(
      query.spec_ref.startsWith("@") ? query.spec_ref.slice(1) : query.spec_ref,
    );
    if (!resolved.ok) {
      return {
        error: {
          status: 404,
          body: {
            error: "not_found",
            message: `Spec reference "${query.spec_ref}" not found`,
            suggestion: "Use GET /api/items or kspec item list to find valid spec references",
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
            error: "invalid_filter",
            details: [
              {
                field: "since",
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

  if (
    !options?.preferDisk &&
    sessionsDomainReady &&
    filtered.length === 0 &&
    (query.task_id || query.spec_ref)
  ) {
    const diskResult = await filterSessionSummaries(getCtx, query, {
      ...options,
      preferDisk: true,
    });
    if ("error" in diskResult || diskResult.summaries.length > 0) {
      return diskResult;
    }
  }

  return { summaries: filtered, unfilteredTotal };
}

export function createSessionRoutes(_options: SessionRouteOptions = {}) {
  const { getEntityCache } = _options;

  return (
    new Elysia({ prefix: "/api/sessions" })

      // List all sessions with summaries, pagination, and filtering
      // AC: @session-legacy-migration ac-read-fallback ac-list-merge — detect-and-warn for legacy sessions
      // AC: @daemon-entity-cache ac-serve-from-memory — Uses unified cache session index when available
      // AC: @session-list-pagination-api ac-pagination — offset/limit pagination with total
      // AC: @session-list-pagination-api ac-metadata-only — Only reads session.yaml, uses cache
      // AC: @ui-api-ref-resolution ac-1 — Include task_title resolved server-side
      .get(
        "/",
        async ({ query, error: errorResponse, projectContext }) => {
          // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
          const warmingCache = getEntityCache?.(projectContext.path);
          const sessionsDomainState = warmingCache?.getDomainState("sessions");
          if (warmingCache && sessionsDomainState === "loading") {
            return wrapResponse([] as never[], {
              cacheDomainState: "loading",
              total: 0,
              offset: 0,
              limit: 0,
            });
          }

          // AC: @daemon-entity-cache ac-serve-from-memory — defer initContext to avoid
          // disk/git work on cache hits. Only initialize when disk fallback is needed.
          let _ctx: KspecContext | null = null;
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const getCtx = async () => {
            if (!_ctx) _ctx = await initContext(projectContext.path, { syncMode: "skip" });
            return _ctx;
          };

          const filteredResult = await filterSessionSummaries(getCtx, query, {
            getEntityCache,
            projectPath: projectContext.path,
          });
          if ("error" in filteredResult) {
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
          // AC: @daemon-entity-cache ac-serve-from-memory — use cached tasks/items when available
          // AC: @api-contract ac-task-storage-incompatibility-* — bubble up a structured 409
          // when this enrichment hits the legacy/unmigrated storage state; the existing
          // generic catch downgrade still applies to other non-critical failures.
          let refIndex: ReferenceIndex | null = null;
          const taskIdsPresent = paginated.some((s) => s.task_id);
          if (taskIdsPresent) {
            try {
              const cache = getEntityCache?.(projectContext.path);
              const tasksDomainReady = cache && cache.getDomainState("tasks") === "ready";
              const itemsDomainReady = cache && cache.getDomainState("items") === "ready";
              let tasks: LoadedTask[] | undefined;
              try {
                tasks = tasksDomainReady
                  ? (cache!.getTaskIndex() as unknown as LoadedTask[])
                  : await resolveTaskDataManager(await getCtx()).loadAllTasks(await getCtx());
              } catch (storageErr) {
                const conflict = taskStorageIncompatibilityResponse(storageErr, { cache });
                if (conflict) return errorResponse(conflict.status, conflict.body);
                throw storageErr;
              }
              const items = itemsDomainReady
                ? (cache!.getItemIndex() as unknown as LoadedSpecItem[])
                : await loadAllItems(await getCtx());
              refIndex = new ReferenceIndex(tasks ?? [], items ?? []);
            } catch {
              // Non-critical — task_title will be null
            }
          }
          const enriched = paginated.map((s) => ({
            ...s,
            task_title: s.task_id && refIndex ? resolveRefTitle(refIndex, s.task_id) : null,
          }));

          // Detect legacy sessions and include warning in response.
          // AC: @daemon-entity-cache ac-serve-from-memory — only scan for legacy sessions
          // when we already have a context (i.e. the disk fallback path was taken). When
          // serving entirely from cache, skip the legacy count to avoid initContext() and
          // disk I/O, which would negate the cache benefit.
          let legacyCount = 0;
          if (_ctx) {
            legacyCount = await countLegacySessions(_ctx.specDir);
          }

          // AC: @session-filter-controls ac-filter-counts — Include unfiltered_total in response
          return wrapResponse(
            {
              items: enriched,
              unfiltered_total: unfilteredTotal,
              ...(legacyCount > 0
                ? {
                    warning: `${legacyCount} legacy session(s) found in .kspec/sessions/. Run \`kspec session migrate\` to move them to .kspec-sessions/.`,
                  }
                : {}),
            },
            { total, offset, limit, cacheDomainState: sessionsDomainState },
          );
        },
        {
          query: t.Object({
            status: t.Optional(enumArrayUnion(SessionStatusSchema.options)),
            agent_type: t.Optional(t.Union([t.String(), t.Array(t.String())])),
            agent_id: t.Optional(t.Union([t.String(), t.Array(t.String())])),
            // Preserve the existing "dispatched" shorthand for any task.* trigger.
            trigger: t.Optional(enumArrayUnion(VALID_SESSION_TRIGGER_FILTERS)),
            task_id: t.Optional(t.String()),
            spec_ref: t.Optional(t.String()),
            since: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )

      // AC: @session-text-search ac-api-search
      // AC: @session-text-search ac-scope-narrowing — metadata filters narrow the scanned sessions first
      .get(
        "/search",
        async ({ query, error: errorResponse, projectContext }) => {
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          const normalizedQuery = query.q.trim();
          if (normalizedQuery.length === 0) {
            return wrapResponse({
              items: [],
              total_sessions: 0,
              total_matches: 0,
              query: "",
            });
          }

          const filteredResult = await filterSessionSummaries(ctx, query, {
            getEntityCache,
            projectPath: projectContext.path,
          });
          if ("error" in filteredResult) {
            return errorResponse(filteredResult.error.status, filteredResult.error.body);
          }

          const limit = Number(query.limit) || 50;
          const items = await searchSessionEvents(ctx.sessionsDir, normalizedQuery, {
            sessionSummaries: filteredResult.summaries,
            limit,
          });
          const totalMatches = items.reduce((sum, session) => sum + session.matches.length, 0);

          return wrapResponse({
            items,
            total_sessions: items.length,
            total_matches: totalMatches,
            query: normalizedQuery,
          });
        },
        {
          query: t.Object({
            q: t.String(),
            status: t.Optional(enumArrayUnion(SessionStatusSchema.options)),
            agent_type: t.Optional(t.Union([t.String(), t.Array(t.String())])),
            agent_id: t.Optional(t.Union([t.String(), t.Array(t.String())])),
            // Preserve the existing "dispatched" shorthand for any task.* trigger.
            trigger: t.Optional(enumArrayUnion(VALID_SESSION_TRIGGER_FILTERS)),
            task_id: t.Optional(t.String()),
            spec_ref: t.Optional(t.String()),
            since: t.Optional(t.String()),
            limit: t.Optional(t.String()),
          }),
        },
      )

      // Get single session metadata
      // AC: @ui-session-stream ac-4 — Includes spec context, budget, and task info
      // AC: @session-legacy-migration ac-read-fallback — detect-and-warn for legacy sessions
      // AC: @daemon-entity-cache ac-detail-on-demand — check unified cache for session detail
      .get("/:id", async ({ params, error: errorResponse, projectContext }) => {
        // AC: @daemon-entity-cache ac-warming-availability — return loading indicator during warmup
        const entityCache = getEntityCache?.(projectContext.path);
        const sessionsDomainState = entityCache?.getDomainState("sessions");
        if (entityCache && sessionsDomainState === "loading") {
          return wrapResponse(null, { cacheDomainState: "loading" });
        }

        // AC: @daemon-entity-cache ac-serve-from-memory — defer initContext to avoid disk/git
        // work on cache hits. sessionsDir can be derived directly from projectContext.path.
        const sessionsDir = join(projectContext.path, ".kspec-sessions");
        let _ctx: KspecContext | null = null;
        // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
        const getCtx = async () => {
          if (!_ctx) _ctx = await initContext(projectContext.path, { syncMode: "skip" });
          return _ctx;
        };

        // AC: @daemon-entity-cache ac-detail-on-demand — check unified cache first
        const sessionsDomainReady = sessionsDomainState === "ready";

        // AC: @daemon-entity-cache ac-serve-from-memory — resolve session ID from cache when
        // available to avoid disk scan; fall back to disk-based resolution otherwise.
        // AC: @daemon-entity-cache ac-session-bounded-index — the index only keeps N most recent
        // sessions, so a cache miss must fall back to disk to find older sessions by ID.
        let resolution: SessionIdResolution;
        if (sessionsDomainReady) {
          const index = entityCache!.getSessionIndex();
          if (index) {
            const sessionIds = index.map((s) => s.id);
            // Exact match
            if (sessionIds.includes(params.id)) {
              resolution = { ok: true, id: params.id };
            } else {
              // Prefix match
              const matches = sessionIds.filter((id) => id.startsWith(params.id));
              if (matches.length === 1) {
                resolution = { ok: true, id: matches[0] };
              } else if (matches.length > 1) {
                resolution = { ok: false, error: "ambiguous", matches };
              } else {
                // Not in bounded index — fall back to disk to find sessions outside
                // the retained window (older sessions still accessible by ID on demand)
                resolution = await resolveSessionId(sessionsDir, params.id);
              }
            }
          } else {
            // Cache ready but empty index — fall back to disk
            resolution = await resolveSessionId(sessionsDir, params.id);
          }
        } else {
          resolution = await resolveSessionId(sessionsDir, params.id);
        }

        if (!resolution.ok) {
          if (resolution.error === "ambiguous") {
            return errorResponse(400, {
              error: "ambiguous_id",
              message: `Ambiguous session ID: ${params.id} matches ${resolution.matches.length} sessions`,
              suggestion: "Provide a longer prefix to uniquely identify the session",
            });
          }
          return errorResponse(404, {
            error: "not_found",
            message: `Session not found: ${params.id}`,
            suggestion: "Use GET /api/sessions to list available sessions",
          });
        }

        let detail: SessionLogSummary | null = null;

        if (sessionsDomainReady) {
          // Try the detail cache, then fall back to the index
          detail = entityCache!.getSessionDetail(resolution.id);
          if (!detail) {
            // Check if the session is in the index
            const index = entityCache!.getSessionIndex();
            detail = index?.find((s) => s.id === resolution.id) ?? null;
          }
        }

        if (!detail) {
          detail = await getSessionLogSummary(sessionsDir, resolution.id);
        }

        if (!detail) {
          return errorResponse(404, {
            error: "not_found",
            message: `Session not found: ${params.id}`,
            suggestion: "Use GET /api/sessions to list available sessions",
          });
        }

        // Store in entity cache detail tier for subsequent requests
        if (sessionsDomainReady) {
          entityCache!.setSessionDetail(resolution.id, detail);
        }

        const metadata = await getSession(sessionsDir, resolution.id);

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
            // AC: @daemon-entity-cache ac-serve-from-memory — use cached tasks for task_title resolution
            // AC: @daemon-read-path ac-no-per-request-sync — never fall back to disk reads.
            // When tasks/items domains aren't ready, omit task_title and spec_context
            // (non-critical enrichment) rather than calling initContext()/loadAll*.
            const tasksDomainReady = entityCache && entityCache.getDomainState("tasks") === "ready";
            const itemsDomainReady = entityCache && entityCache.getDomainState("items") === "ready";

            if (tasksDomainReady && itemsDomainReady) {
              const tasks = entityCache!.getTaskIndex() as unknown as LoadedTask[];

              // For spec_context we need full spec items with acceptance_criteria content.
              // AC: @daemon-read-path ac-no-per-request-sync — use cached item details
              // (populated eagerly during domain load) instead of per-request disk reads.
              const items: LoadedSpecItem[] = entityCache!.getAllItemDetails() ?? [];
              const index = new ReferenceIndex(tasks ?? [], items ?? []);
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
                        description: ac.description ?? ac.given ?? "",
                      })),
                    };
                  }
                }
              }
            }
            // else: tasks/items domains not ready — skip enrichment.
            // task_title and spec_context remain null; client sees them once cache is warm.
          } catch {
            // Non-critical — spec context is optional
          }
        }

        // AC: @ui-breadcrumb ac-10 — server-resolved breadcrumb ancestor chain.
        // A task-scoped session's chain is its owning task's chain (spec chain
        // plus the task) plus the session; a session with no owning task is a
        // single-segment chain. Built from the cached task/item indexes when
        // warm (no per-request disk read, per ac-no-per-request-sync); when the
        // cache is cold the chain degrades to the session segment alone, the
        // same warm-up degradation task_title/spec_context already use.
        let ancestors: BreadcrumbAncestor[];
        const ancestryTasksReady = entityCache?.getDomainState("tasks") === "ready";
        const ancestryItemsReady = entityCache?.getDomainState("items") === "ready";
        if (metadata?.task_id && ancestryTasksReady && ancestryItemsReady) {
          const resolver = new BreadcrumbAncestryResolver({
            items: (entityCache!.getItemIndex() ?? []) as AncestryItemInput[],
            tasks: (entityCache!.getTaskIndex() ?? []) as unknown as AncestryTaskInput[],
          });
          ancestors = resolver.forSession({ id: resolution.id, task_ref: metadata.task_id });
        } else {
          ancestors = new BreadcrumbAncestryResolver({ items: [] }).forSession({
            id: resolution.id,
          });
        }

        // AC: @ui-session-stream ac-4 — Include budget info
        let budget: { max_per_cycle: number; started_this_cycle: number } | null = null;
        try {
          budget = await getBudget(sessionsDir, resolution.id);
        } catch {
          // No budget configured — that's fine
        }

        // Detect legacy sessions and include warning in response.
        // AC: @daemon-entity-cache ac-serve-from-memory — skip initContext when serving
        // entirely from cache (sessionsDomainReady). Otherwise, initialize context to
        // get specDir for legacy session detection.
        let legacyCount = 0;
        if (!sessionsDomainReady) {
          const ctx = await getCtx();
          legacyCount = await countLegacySessions(ctx.specDir);
        } else if (_ctx) {
          legacyCount = await countLegacySessions(_ctx.specDir);
        }

        return wrapResponse(
          {
            ...detail,
            task_id: metadata?.task_id,
            task_title,
            agent_id: metadata?.agent_id,
            trigger: metadata?.trigger ?? "legacy",
            spec_context,
            budget,
            ancestors,
            ...(legacyCount > 0
              ? {
                  warning: `${legacyCount} legacy session(s) found in .kspec/sessions/. Run \`kspec session migrate\` to move them to .kspec-sessions/.`,
                }
              : {}),
          },
          { cacheDomainState: sessionsDomainState },
        );
      })

      // Get session events
      // AC: @session-legacy-migration ac-read-fallback — detect-and-warn for legacy sessions
      .get(
        "/:id/events",
        async ({ params, query, error: errorResponse, projectContext }) => {
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });

          const resolution = await resolveSessionId(ctx.sessionsDir, params.id);
          if (!resolution.ok) {
            if (resolution.error === "ambiguous") {
              return errorResponse(400, {
                error: "ambiguous_id",
                message: `Ambiguous session ID: ${params.id} matches ${resolution.matches.length} sessions`,
                suggestion: "Provide a longer prefix to uniquely identify the session",
              });
            }
            return errorResponse(404, {
              error: "not_found",
              message: `Session not found: ${params.id}`,
              suggestion: "Use GET /api/sessions to list available sessions",
            });
          }

          let events = await readEvents(ctx.sessionsDir, resolution.id);

          // Deduplicate phased tool calls
          events = deduplicatePhasedToolCalls(events);

          // Filter by since_seq if provided (for incremental loading)
          const sinceSeq =
            query.since_seq !== undefined ? parseInt(query.since_seq, 10) : undefined;
          if (sinceSeq !== undefined && !isNaN(sinceSeq)) {
            events = events.filter((e) => e.seq > sinceSeq);
          }

          // Detect legacy sessions and include warning in response
          const legacyCount = await countLegacySessions(ctx.specDir);

          return wrapResponse(
            {
              events,
              ...(legacyCount > 0
                ? {
                    warning: `${legacyCount} legacy session(s) found in .kspec/sessions/. Run \`kspec session migrate\` to move them to .kspec-sessions/.`,
                  }
                : {}),
            },
            { total: events.length },
          );
        },
        {
          query: t.Object({
            since_seq: t.Optional(t.String()),
          }),
        },
      )

      // Get single session event by sequence number with blob resolution
      // AC: @session-event-detail-endpoint ac-single-event-fetch — Returns full event for seq
      // AC: @session-event-detail-endpoint ac-blob-resolution — Blob pointers resolved to full content
      // AC: @session-event-detail-endpoint ac-not-found — 404 for missing session or seq
      // AC: @trait-api-endpoint ac-1 — Returns 2xx with JSON body on success
      // AC: @trait-api-endpoint ac-2 — Returns 404 for invalid session or seq ref
      .get("/:id/events/:seq", async ({ params, error: errorResponse, projectContext }) => {
        // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
        const ctx = await initContext(projectContext.path, { syncMode: "skip" });

        // Resolve session ID (supports prefix matching)
        const resolution = await resolveSessionId(ctx.sessionsDir, params.id);
        if (!resolution.ok) {
          if (resolution.error === "ambiguous") {
            return errorResponse(400, {
              error: "ambiguous_id",
              message: `Ambiguous session ID: ${params.id} matches ${resolution.matches.length} sessions`,
              suggestion: "Provide a longer prefix to uniquely identify the session",
            });
          }
          return errorResponse(404, {
            error: "not_found",
            message: `Session not found: ${params.id}`,
            suggestion: "Use GET /api/sessions to list available sessions",
          });
        }

        // Parse and validate seq parameter
        const seq = parseInt(params.seq, 10);
        if (isNaN(seq) || seq < 0) {
          return errorResponse(400, {
            error: "invalid_parameter",
            details: [
              {
                field: "seq",
                message: `Invalid sequence number: "${params.seq}". Must be a non-negative integer.`,
              },
            ],
          });
        }

        // Targeted single-event read
        const event = await readEventBySeq(ctx.sessionsDir, resolution.id, seq);
        if (!event) {
          return errorResponse(404, {
            error: "not_found",
            message: `Event with seq ${seq} not found in session ${params.id}`,
            suggestion: "Use GET /api/sessions/:id/events to list available events",
          });
        }

        // Resolve blob pointers in event data
        const resolvedData = await resolveSessionBlobPointers(
          ctx.sessionsDir,
          resolution.id,
          event.data,
        );

        return wrapResponse({
          ...event,
          data: resolvedData,
        });
      })
  );
}
