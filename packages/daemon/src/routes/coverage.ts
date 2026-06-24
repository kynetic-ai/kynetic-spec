import { Elysia, t } from "elysia";
import { ulid } from "ulidx";
import {
  getCachedCoverageStateReadModel,
  initContext,
  ingestTestResultRun,
  invalidateCoverageStateReadModelCache,
  TestResultIngestionReadOnlyError,
  TestResultIngestionValidationError,
  type TestResultIngestionResult,
} from "../../parser/index.js";
import type {
  CoverageCriterionStateDetail,
  CoverageItemStateSummary,
  CoverageStateSummary,
  CoverageUnmappedResultSummary,
} from "@kynetic-ai/shared";
import type { PubSubManager } from "../websocket/pubsub.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";
import { buildCoverageStateChangedEventForIngestion } from "./coverage-state-events.js";
import { runRouteMutation } from "./mutation-pipeline.js";
import { wrapResponse } from "./response-envelope.js";

interface CoverageRouteOptions {
  pubsub: PubSubManager;
  getEntityCache?: EntityCacheAccessor;
}

function truthyQueryFlag(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "";
}

function readOnlyRequest(request: Request): boolean {
  return (
    request.headers.get("X-Kspec-Static") === "true" ||
    request.headers.get("X-Kspec-Read-Only") === "true"
  );
}

function validationBody(error: TestResultIngestionValidationError) {
  return {
    error: "validation_error",
    message: error.message,
    details: error.details,
    suggestion: error.suggestion,
    run_id: error.runId,
    dry_run: error.dryRun,
  };
}

function emptyCoverageSummary(): CoverageStateSummary {
  return {
    counts: { covered: 0, failing: 0, not_yet: 0, re_verify: 0 },
    denominator: 0,
    latest_run_id: null,
    unmapped_result_count: 0,
    invalid_result_count: 0,
  };
}

function parsePagination(query: {
  limit?: string;
  offset?: string;
}): { ok: true; limit: number; offset: number } | { ok: false; field: "limit" | "offset" } {
  const parse = (field: "limit" | "offset", fallback: number) => {
    const value = query[field];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) return null;
    return Number(value);
  };
  const limit = parse("limit", 50);
  if (limit === null) return { ok: false, field: "limit" };
  const offset = parse("offset", 0);
  if (offset === null) return { ok: false, field: "offset" };
  return { ok: true, limit, offset };
}

function paginationError(field: "limit" | "offset") {
  return {
    error: "validation_error",
    details: [{ field, message: `${field} must be a non-negative integer` }],
  };
}

function itemNotFound(ref: string, candidates: string[]) {
  const nearest =
    candidates.find((candidate) =>
      candidate.toLowerCase().includes(ref.replace(/^@/, "").toLowerCase().slice(0, 6)),
    ) ?? candidates[0];
  return {
    error: "not_found",
    message: `Coverage item reference "${ref}" not found`,
    suggestion: nearest
      ? `Use a valid item reference such as ${nearest}`
      : "Use kspec item list or kspec search to find valid item references",
  };
}

function criterionNotFound(ref: string, acId: string) {
  return {
    error: "not_found",
    message: `Coverage criterion "${ref} ${acId}" not found`,
    suggestion: "Use GET /api/coverage/state/items/:ref to list available criteria",
  };
}

export function createCoverageRoutes(options: CoverageRouteOptions) {
  const { pubsub, getEntityCache } = options;

  return (
    new Elysia({ prefix: "/api/coverage" })
      // AC: @trait-api-endpoint ac-6 — X-Request-Id header for tracing.
      .onTransform(({ set }) => {
        set.headers["X-Request-Id"] = ulid();
      })
      .get("/state/summary", async ({ projectContext }) => {
        const cache = getEntityCache?.(projectContext.path);
        const itemsDomainState = cache?.getDomainState("items");
        if (cache && itemsDomainState === "loading") {
          return wrapResponse(emptyCoverageSummary(), { cacheDomainState: "loading" });
        }
        const ctx = await initContext(projectContext.path, { syncMode: "skip" });
        const model = await getCachedCoverageStateReadModel(ctx);
        return wrapResponse(model.summary, { cacheDomainState: itemsDomainState });
      })
      .get(
        "/state/items/:ref",
        async ({ params, projectContext, error: errorResponse }) => {
          const cache = getEntityCache?.(projectContext.path);
          const itemsDomainState = cache?.getDomainState("items");
          if (cache && itemsDomainState === "loading") {
            return wrapResponse(null as CoverageItemStateSummary | null, {
              cacheDomainState: "loading",
            });
          }
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          const model = await getCachedCoverageStateReadModel(ctx);
          const item = model.items[params.ref] ?? model.items[`@${params.ref}`];
          if (!item) {
            const refs = Object.values(model.items)
              .map((candidate) => candidate.item_ref)
              .filter((value, index, arr) => arr.indexOf(value) === index)
              .toSorted();
            return errorResponse(404, itemNotFound(params.ref, refs));
          }
          return wrapResponse(item, { cacheDomainState: itemsDomainState });
        },
        {
          params: t.Object({
            ref: t.String(),
          }),
        },
      )
      .get(
        "/state/criteria/:ref/:acId",
        async ({ params, projectContext, error: errorResponse }) => {
          const cache = getEntityCache?.(projectContext.path);
          const itemsDomainState = cache?.getDomainState("items");
          if (cache && itemsDomainState === "loading") {
            return wrapResponse(null as CoverageCriterionStateDetail | null, {
              cacheDomainState: "loading",
            });
          }
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          const model = await getCachedCoverageStateReadModel(ctx);
          const item = model.items[params.ref] ?? model.items[`@${params.ref}`];
          if (!item) {
            const refs = Object.values(model.items)
              .map((candidate) => candidate.item_ref)
              .filter((value, index, arr) => arr.indexOf(value) === index)
              .toSorted();
            return errorResponse(404, itemNotFound(params.ref, refs));
          }
          const criterion = model.criteria[`${item.item_ulid} ${params.acId}`];
          if (!criterion) {
            return errorResponse(404, criterionNotFound(item.item_ref, params.acId));
          }
          return wrapResponse(criterion, { cacheDomainState: itemsDomainState });
        },
        {
          params: t.Object({
            ref: t.String(),
            acId: t.String(),
          }),
        },
      )
      .get(
        "/state/unmapped",
        async ({ query, projectContext, error: errorResponse }) => {
          const pagination = parsePagination(query);
          if (!pagination.ok) {
            return errorResponse(400, paginationError(pagination.field));
          }
          const cache = getEntityCache?.(projectContext.path);
          const itemsDomainState = cache?.getDomainState("items");
          if (cache && itemsDomainState === "loading") {
            return wrapResponse([] as CoverageUnmappedResultSummary[], {
              cacheDomainState: "loading",
              total: 0,
              offset: pagination.offset,
              limit: pagination.limit,
            });
          }
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          const model = await getCachedCoverageStateReadModel(ctx);
          const total = model.unmapped_results.length;
          const data = model.unmapped_results.slice(
            pagination.offset,
            pagination.offset + pagination.limit,
          );
          return wrapResponse(data, {
            cacheDomainState: itemsDomainState,
            total,
            offset: pagination.offset,
            limit: pagination.limit,
          });
        },
        {
          query: t.Object({
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )
      .post(
        "/test-results/runs",
        async ({ body, query, request, error: errorResponse, projectContext }) => {
          const projectPath = projectContext?.path ?? request.headers.get("X-Kspec-Dir");
          if (!projectPath) {
            return errorResponse(400, {
              error: "validation_error",
              details: [{ field: "project", message: "Project context is required." }],
            });
          }
          const ctx = await initContext(projectPath);
          const dryRun = truthyQueryFlag(query.dry_run);

          const ingest = async (skipCommit: boolean): Promise<TestResultIngestionResult> =>
            ingestTestResultRun(ctx, body, {
              actor: query.actor,
              sessionId: query.session_id,
              dryRun,
              readOnly: readOnlyRequest(request),
              skipCommit,
            });

          let result: TestResultIngestionResult;
          try {
            if (dryRun) {
              result = await ingest(false);
            } else {
              result = await runRouteMutation({
                ctx,
                projectPath,
                getEntityCache,
                pubsub,
                apply: () => ingest(true),
                commit: ({ summary }) => ({
                  operation: "test result run",
                  ref: `@${summary.run_id}`,
                  detail: "ingested normalized run",
                }),
                writeThrough: [{ domain: "items" }],
                events: ({ events }) => events,
              });
            }
          } catch (err) {
            if (err instanceof TestResultIngestionReadOnlyError) {
              return errorResponse(409, {
                error: "read_only",
                message: err.message,
                suggestion: err.suggestion,
                code: err.code,
              });
            }
            if (err instanceof TestResultIngestionValidationError) {
              return errorResponse(400, validationBody(err));
            }
            throw err;
          }

          invalidateCoverageStateReadModelCache(projectPath);
          if (!result.summary.dry_run && result.summary.stored) {
            const refreshedModel = await getCachedCoverageStateReadModel(ctx);
            pubsub.broadcast(
              "items:updates",
              "coverage_state_changed",
              buildCoverageStateChangedEventForIngestion(result.summary, refreshedModel),
              projectPath,
            );
          }
          return wrapResponse(result.summary);
        },
        {
          body: t.Any(),
          query: t.Object({
            dry_run: t.Optional(t.String()),
            actor: t.Optional(t.String()),
            session_id: t.Optional(t.String()),
          }),
        },
      )
  );
}
