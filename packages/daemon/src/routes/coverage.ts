import { Elysia, t } from "elysia";
import { ulid } from "ulidx";
import {
  initContext,
  ingestTestResultRun,
  TestResultIngestionReadOnlyError,
  TestResultIngestionValidationError,
  type TestResultIngestionResult,
} from "../../parser/index.js";
import type { PubSubManager } from "../websocket/pubsub.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";
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

export function createCoverageRoutes(options: CoverageRouteOptions) {
  const { pubsub, getEntityCache } = options;

  return (
    new Elysia({ prefix: "/api/coverage" })
      // AC: @trait-api-endpoint ac-6 — X-Request-Id header for tracing.
      .onTransform(({ set }) => {
        set.headers["X-Request-Id"] = ulid();
      })
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
