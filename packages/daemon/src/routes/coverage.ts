import { Elysia, t } from "elysia";
import { ulid } from "ulidx";
import { ZodError } from "zod";
import {
  applyDispatchFixRequest,
  applyExplicitReverification,
  applySpecTextRevert,
  CoverageResolutionActorError,
  CoverageResolutionReadOnlyError,
  CoverageResolutionSpecTextUnavailableError,
  CoverageResolutionStaleTargetError,
  CoverageResolutionTargetNotFoundError,
  getCachedCoverageStateReadModel,
  initContext,
  ingestTestResultRun,
  invalidateCoverageStateReadModelCache,
  TestResultIngestionReadOnlyError,
  TestResultIngestionValidationError,
  type TestResultIngestionResult,
} from "../../parser/index.js";
import {
  CoverageResolutionRequestSchema,
  type CoverageResolutionAction,
  type CoverageResolutionRequest,
  type CoverageResolutionResponse,
} from "../../schema/coverage-resolution.js";
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

function zodValidationBody(error: ZodError) {
  return {
    error: "validation_error",
    details: error.issues.map((issue) => ({
      field: issue.path.join(".") || "request",
      message: issue.message,
    })),
  };
}

function preconditionFailureBody(response: CoverageResolutionResponse) {
  const diagnostic = response.diagnostics.find((entry) => !entry.satisfied);
  return {
    error: "precondition_failed",
    message: diagnostic?.message ?? "Coverage resolution precondition failed.",
    suggestion:
      diagnostic?.suggestion ??
      "Refresh the coverage detail and choose an action for the current state.",
    details: response.diagnostics,
    response,
  };
}

function hasFailedPrecondition(response: CoverageResolutionResponse): boolean {
  return response.diagnostics.some((entry) => !entry.satisfied);
}

function parseResolutionRequest(
  action: CoverageResolutionAction,
  body: unknown,
  query: { dry_run?: string; actor?: string; session_id?: string },
): CoverageResolutionRequest {
  const raw = body && typeof body === "object" && !Array.isArray(body) ? { ...body } : {};
  if (
    "action" in raw &&
    typeof raw.action === "string" &&
    raw.action.length > 0 &&
    raw.action !== action
  ) {
    throw new ZodError([
      {
        code: "custom",
        path: ["action"],
        message: `Request action must match route action "${action}".`,
      },
    ]);
  }
  return CoverageResolutionRequestSchema.parse({
    ...raw,
    action,
    ...(query.dry_run !== undefined ? { dry_run: truthyQueryFlag(query.dry_run) } : {}),
    ...(!("actor" in raw) && query.actor ? { actor: query.actor } : {}),
    ...(!("session_id" in raw) && query.session_id ? { session_id: query.session_id } : {}),
  });
}

function coverageResolutionCommit(response: CoverageResolutionResponse) {
  return {
    operation: `coverage resolve ${response.action}`,
    ref: response.target.item_ref,
    detail: `${response.target.ac_id} ${response.stored ? "stored" : "checked"}`,
  };
}

function coverageResolutionWriteThrough(response: CoverageResolutionResponse) {
  if (!response.stored) return [];
  const domains = new Set<string>(["items"]);
  if (response.effects.some((effect) => effect.kind === "task")) {
    domains.add("tasks");
  }
  return [...domains].map((domain) => ({ domain }));
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

  async function handleCoverageResolution(
    action: CoverageResolutionAction,
    routeOptions: {
      body: unknown;
      query: { dry_run?: string; actor?: string; session_id?: string };
      request: Request;
      projectContext?: { path?: string };
      errorResponse: (status: number, body: unknown) => unknown;
    },
  ) {
    const projectPath =
      routeOptions.projectContext?.path ?? routeOptions.request.headers.get("X-Kspec-Dir");
    if (!projectPath) {
      return routeOptions.errorResponse(400, {
        error: "validation_error",
        details: [{ field: "project", message: "Project context is required." }],
      });
    }

    let resolutionRequest: CoverageResolutionRequest;
    try {
      resolutionRequest = parseResolutionRequest(action, routeOptions.body, routeOptions.query);
    } catch (err) {
      if (err instanceof ZodError) {
        return routeOptions.errorResponse(400, zodValidationBody(err));
      }
      throw err;
    }

    const ctx = await initContext(projectPath);
    const readOnly = readOnlyRequest(routeOptions.request);
    const apply = (skipCommit: boolean): Promise<CoverageResolutionResponse> => {
      switch (resolutionRequest.action) {
        case "explicit-reverify":
          return applyExplicitReverification(ctx, resolutionRequest, { readOnly });
        case "spec-text-revert":
          return applySpecTextRevert(ctx, {
            request: resolutionRequest,
            readOnly,
            skipCommit,
          });
        case "dispatch-fix":
          return applyDispatchFixRequest(ctx, resolutionRequest, {
            readOnly,
            skipCommit,
          });
      }
    };

    try {
      const result = resolutionRequest.dry_run
        ? await apply(false)
        : await runRouteMutation({
            ctx,
            projectPath,
            getEntityCache,
            pubsub,
            apply: () => apply(true),
            commit: coverageResolutionCommit,
            writeThrough: coverageResolutionWriteThrough,
            events: () => [],
          });

      if (hasFailedPrecondition(result)) {
        return routeOptions.errorResponse(409, preconditionFailureBody(result));
      }
      return wrapResponse(result);
    } catch (err) {
      if (err instanceof CoverageResolutionReadOnlyError) {
        return routeOptions.errorResponse(409, {
          error: "read_only",
          message: err.message,
          suggestion: err.suggestion,
          code: err.code,
        });
      }
      if (err instanceof CoverageResolutionTargetNotFoundError) {
        return routeOptions.errorResponse(404, {
          error: "not_found",
          message: err.message,
          suggestion: err.suggestion,
          code: err.code,
          target: err.target,
        });
      }
      if (err instanceof CoverageResolutionStaleTargetError) {
        return routeOptions.errorResponse(409, {
          error: "stale_target",
          message: err.message,
          suggestion: err.suggestion,
          code: err.code,
          expected_current_fingerprint: err.expectedFingerprint,
          current_fingerprint: err.currentFingerprint,
        });
      }
      if (err instanceof CoverageResolutionSpecTextUnavailableError) {
        return routeOptions.errorResponse(409, {
          error: "precondition_failed",
          message: err.message,
          suggestion: err.suggestion,
          code: err.code,
        });
      }
      if (err instanceof CoverageResolutionActorError) {
        return routeOptions.errorResponse(400, {
          error: "validation_error",
          details: [{ field: err.details.field, message: err.details.message }],
          suggestion: err.suggestion,
          code: err.code,
        });
      }
      throw err;
    }
  }

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
        "/resolve/reverify",
        ({ body, query, request, error: errorResponse, projectContext }) =>
          handleCoverageResolution("explicit-reverify", {
            body,
            query,
            request,
            projectContext,
            errorResponse,
          }),
        {
          body: t.Any(),
          query: t.Object({
            dry_run: t.Optional(t.String()),
            actor: t.Optional(t.String()),
            session_id: t.Optional(t.String()),
          }),
        },
      )
      .post(
        "/resolve/revert-spec-text",
        ({ body, query, request, error: errorResponse, projectContext }) =>
          handleCoverageResolution("spec-text-revert", {
            body,
            query,
            request,
            projectContext,
            errorResponse,
          }),
        {
          body: t.Any(),
          query: t.Object({
            dry_run: t.Optional(t.String()),
            actor: t.Optional(t.String()),
            session_id: t.Optional(t.String()),
          }),
        },
      )
      .post(
        "/resolve/dispatch-fix",
        ({ body, query, request, error: errorResponse, projectContext }) =>
          handleCoverageResolution("dispatch-fix", {
            body,
            query,
            request,
            projectContext,
            errorResponse,
          }),
        {
          body: t.Any(),
          query: t.Object({
            dry_run: t.Optional(t.String()),
            actor: t.Optional(t.String()),
            session_id: t.Optional(t.String()),
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
