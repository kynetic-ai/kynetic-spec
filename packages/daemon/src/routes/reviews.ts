/**
 * Review API Routes — List, Detail, Thread, Verdict, Check, and Lifecycle
 *
 * REST endpoints for review record operations:
 * - GET /api/reviews - list reviews with filters and pagination
 * - GET /api/reviews/:id - get single review with full detail
 * - POST /api/reviews/:id/comments - create thread
 * - POST /api/reviews/:id/comments/:threadId/replies - add reply
 * - PATCH /api/reviews/:id/comments/:threadId/resolve - resolve thread
 * - PATCH /api/reviews/:id/comments/:threadId/reopen - reopen thread
 * - POST /api/reviews/:id/verdicts - record verdict
 * - POST /api/reviews/:id/checks - record check
 * - PATCH /api/reviews/:id/lifecycle - transition lifecycle state
 *
 * AC Coverage:
 * - @review-records-daemon-api ac-1: GET /api/reviews returns paginated list with filtering
 * - @review-records-daemon-api ac-2: GET /api/reviews/:id returns full review detail
 * - @review-records-web-ui ac-7: GET /api/reviews?task= for task detail integration
 * - @review-records-daemon-api ac-3: POST /api/reviews/:id/comments creates thread
 * - @review-records-daemon-api ac-4: POST /api/reviews/:id/comments/:threadId/replies adds reply
 * - @review-records-daemon-api ac-5: PATCH resolve/reopen toggles resolution state
 * - @review-records-daemon-api ac-6: POST /api/reviews/:id/verdicts records verdict, recomputes disposition
 * - @review-records-daemon-api ac-7: POST /api/reviews/:id/checks records check, updates gate evaluation
 * - @review-records-daemon-api ac-8: PATCH /api/reviews/:id/lifecycle transitions lifecycle state
 * - @review-records-daemon-api ac-9: WebSocket broadcast on mutations
 * - @review-records-daemon-api ac-10: 400 with actionable error messages for invalid input
 */

import { Elysia, t } from "elysia";
import { ulid } from "ulidx";
import {
  initContext,
  loadReviewRecords,
  loadAllItems,
  ReferenceIndex,
  findReviewByRef,
  mutateReviewAtomically,
  submitVerdict,
  transitionLifecycle,
  computeDisposition,
  handleVerdictTaskTransition,
  VALID_TRANSITIONS,
  addThreadAtomic,
  addReplyAtomic,
  resolveThreadAtomic,
  reopenThreadAtomic,
  resolveTaskDataManager,
  type LoadedTask,
  type LoadedSpecItem,
} from "../../parser/index.js";
import { getUnresolvedBlockers } from "../../parser/review-threads.js";
import { createCheck } from "../../review/checks.js";
import { evaluateGates } from "../../review/checks.js";
import { extractSubjectVersion } from "../../review/subject-bindings.js";
import { commitIfShadow } from "../../parser/shadow.js";
import type { PubSubManager } from "../websocket/pubsub.js";
import type {
  ReviewVerdictDecision,
  ReviewLifecycleState,
  ReviewCheckStatus,
  ReviewEvent,
  ReviewAnchor,
  ReviewRecord,
} from "../../schema/index.js";
import {
  ReviewAnchorTypeSchema,
  ReviewCheckStatusSchema,
  ReviewCodeAnchorSideSchema,
  ReviewDispositionSchema,
  ReviewLifecycleStateSchema,
  ReviewSubjectSchema,
  ReviewThreadKindSchema,
  ReviewVerdictDecisionSchema,
} from "../../schema/index.js";
import { resolveRefTitle } from "./ref-resolution.js";
import { resolveWriteActor, toValidationErrorBody } from "./actor-resolution.js";
import { enumArrayUnion, enumUnion } from "./enum-utils.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";
import type { ReviewIndexSummary } from "../../daemon/entity-cache.js";
import { wrapResponse } from "./response-envelope.js";
import { taskStorageIncompatibilityResponse } from "./task-storage-error.js";
import { entityStorageIncompatibilityResponse } from "./entity-storage-error.js";
import { requireReviewFolderStorage } from "../../parser/entity-storage-compatibility.js";
import { loadResourceManifest as loadReviewResourceManifest } from "../../parser/entity-local-resources.js";
import { getReviewDir as getReviewDirForResources } from "../../parser/review-storage-manager.js";

interface ReviewsRouteOptions {
  pubsub: PubSubManager;
  getEntityCache?: EntityCacheAccessor;
}

const VALID_DECISIONS: readonly ReviewVerdictDecision[] = ReviewVerdictDecisionSchema.options;
const VALID_CHECK_STATUSES: readonly ReviewCheckStatus[] = ReviewCheckStatusSchema.options;
const VALID_THREAD_KINDS = ReviewThreadKindSchema.options;
const VALID_ANCHOR_TYPES = ReviewAnchorTypeSchema.options;
const VALID_CODE_ANCHOR_SIDES = ReviewCodeAnchorSideSchema.options;
const VALID_REVIEW_SUBJECT_TYPES = ReviewSubjectSchema.options.map(
  (option) => option.shape.type.value,
);
const VALID_LIFECYCLE_TARGETS: readonly ReviewLifecycleState[] =
  ReviewLifecycleStateSchema.options.filter((state) => state !== "draft");

/**
 * Build a ReviewSummary from a full ReviewRecord.
 * Extracts subject type, linked task ref, and computed counts.
 */
function toReviewSummary(review: ReviewRecord, index?: ReferenceIndex) {
  const disposition = computeDisposition(review);
  const unresolvedBlockers = getUnresolvedBlockers(review);

  // Determine linked task ref
  let taskRef: string | undefined;
  if (review.subject.type === "task") {
    taskRef = review.subject.ref;
  } else if (review.related_refs.length > 0) {
    taskRef = review.related_refs[0];
  }

  // Resolve task title via ReferenceIndex (consistent with tasks.ts pattern)
  const taskTitle = taskRef ? resolveRefTitle(index!, taskRef) : null;

  return {
    _ulid: review._ulid,
    slugs: review.slugs,
    title: review.title,
    lifecycle_state: review.lifecycle_state,
    disposition,
    subject_type: review.subject.type,
    subject_ref: "ref" in review.subject ? review.subject.ref : undefined,
    head_branch: review.subject.type === "code" ? review.subject.head_branch : undefined,
    author: review.author,
    related_refs: review.related_refs,
    task_ref: taskRef,
    task_title: taskTitle,
    thread_count: review.threads.length,
    unresolved_blocker_count: unresolvedBlockers.length,
    check_count: review.checks.length,
    verdict_count: review.verdicts.length,
    created_at: review.created_at,
    updated_at: review.updated_at,
  };
}

/**
 * Build a ReviewSummary from a ReviewIndexSummary (pre-computed in cache).
 * Uses the already-computed disposition and counts from the index tier.
 */
function indexSummaryToReviewSummary(review: ReviewIndexSummary, index?: ReferenceIndex) {
  // Determine linked task ref
  let taskRef: string | undefined;
  if (review.subject.type === "task") {
    taskRef = (review.subject as { ref: string }).ref;
  } else if (review.related_refs.length > 0) {
    taskRef = review.related_refs[0];
  }

  // Resolve task title via ReferenceIndex
  const taskTitle = taskRef && index ? resolveRefTitle(index, taskRef) : null;

  return {
    _ulid: review._ulid,
    slugs: review.slugs,
    title: review.title,
    lifecycle_state: review.lifecycle_state,
    disposition: review.disposition,
    subject_type: review.subject.type,
    subject_ref: "ref" in review.subject ? (review.subject as { ref: string }).ref : undefined,
    head_branch:
      review.subject.type === "code"
        ? (review.subject as { head_branch?: string }).head_branch
        : undefined,
    author: review.author,
    related_refs: review.related_refs,
    task_ref: taskRef,
    task_title: taskTitle,
    thread_count: review.thread_count,
    unresolved_blocker_count: review.unresolved_blocker_count,
    check_count: review.check_count,
    verdict_count: review.verdict_count,
    created_at: review.created_at,
    updated_at: review.updated_at,
  };
}

export function createReviewsRoutes(options: ReviewsRouteOptions) {
  const { pubsub, getEntityCache } = options;

  return (
    new Elysia({ prefix: "/api/reviews" })
      // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
      //     — translate review-storage incompatibility into a structured 409 instead
      //     of letting it escape as an unhandled 500. Per-route try/catch wrappers
      //     would otherwise need to be added at every loadReviewRecords / mutate /
      //     save call site; an onError handler keeps coverage uniform.
      .onError(({ error: err, set }) => {
        const conflict = entityStorageIncompatibilityResponse(err, {
          cache: getEntityCache
            ? // Reviews onError lacks request context; cache lookup is best-effort
              null
            : null,
        });
        if (conflict) {
          set.status = conflict.status;
          return conflict.body;
        }
      })

      // AC: @review-records-daemon-api ac-1 - List reviews with filters and pagination
      // AC: @review-records-web-ui ac-7 - Task filter for task detail page integration
      .get(
        "/",
        async ({ query, error: errorResponse, projectContext }) => {
          // AC: @daemon-entity-cache ac-serve-from-memory — defer initContext for cache hits
          const cache = getEntityCache?.(projectContext.path);

          let _ctx: Awaited<ReturnType<typeof initContext>> | null = null;
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const getCtx = async () => {
            if (!_ctx) _ctx = await initContext(projectContext.path, { syncMode: "skip" });
            return _ctx;
          };

          // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
          const reviewsDomainState = cache?.getDomainState("reviews");
          if (cache && reviewsDomainState === "loading") {
            return wrapResponse([] as never[], {
              cacheDomainState: "loading",
              total: 0,
              offset: 0,
              limit: 0,
            });
          }

          // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
          // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
          //     — review routes require folder-backed review storage. Reject
          //     legacy projects (kynetic < 1.2 with no review_storage
          //     declaration), 1.2 projects missing the declaration, and partial
          //     folder layouts with a structured 409 before serving any data.
          //
          // AC: @daemon-read-path ac-no-per-request-sync — skip the gate when
          //     the cache has already proved this project is compatible at
          //     load time. The cache loader runs requireReviewFolderStorage()
          //     before loadReviewRecords() during warm-up, so a "ready"
          //     reviews domain means the strict gate already passed —
          //     incompatible projects mark the domain "degraded" and fall
          //     through to the gate-at-route-entry path below.
          if (!cache || reviewsDomainState !== "ready") {
            try {
              await requireReviewFolderStorage(await getCtx());
            } catch (err) {
              const conflict = entityStorageIncompatibilityResponse(err, { cache });
              if (conflict) return errorResponse(conflict.status, conflict.body);
              throw err;
            }
          }

          // Try cache for reviews (index tier has ReviewIndexSummary, disk gives full records)
          // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
          //     — translate review-storage incompatibility into a structured 409.
          const cachedReviews =
            cache && reviewsDomainState === "ready" ? cache.getReviewsIndex() : null;
          const fromCache = !!cachedReviews;
          let reviews: (
            | ReviewIndexSummary
            | Awaited<ReturnType<typeof loadReviewRecords>>[number]
          )[];
          if (cachedReviews) {
            reviews = cachedReviews;
          } else {
            const ctx = await getCtx();
            try {
              reviews = await loadReviewRecords(ctx);
            } catch (err) {
              const conflict = entityStorageIncompatibilityResponse(err, { cache });
              if (conflict) return errorResponse(conflict.status, conflict.body);
              throw err;
            }
          }

          // Try cache for tasks and items (for ref resolution)
          // AC: @api-contract ac-task-storage-incompatibility-* — translate the storage
          // error into a 409 so the reviews list does not surface as a 500.
          const tasksDomainState = cache?.getDomainState("tasks");
          const itemsDomainState = cache?.getDomainState("items");
          let tasks;
          try {
            tasks =
              (cache && tasksDomainState === "ready" ? cache.getTaskIndex() : null) ??
              (await resolveTaskDataManager(await getCtx()).loadAllTasks(await getCtx()));
          } catch (err) {
            const conflict = taskStorageIncompatibilityResponse(err, { cache });
            if (conflict) return errorResponse(conflict.status, conflict.body);
            throw err;
          }
          const specItems =
            (cache && itemsDomainState === "ready" ? cache.getItemIndex() : null) ??
            (await loadAllItems(await getCtx()));
          const index = new ReferenceIndex(
            tasks as unknown as LoadedTask[],
            specItems as unknown as LoadedSpecItem[],
          );

          // Apply filters — both ReviewIndexSummary and LoadedReviewRecord share these fields
          let filtered = reviews;

          // Status filter (lifecycle_state) — default to 'open' if not specified
          const statusFilters = query.status
            ? Array.isArray(query.status)
              ? query.status
              : [query.status]
            : ["open"];
          filtered = filtered.filter((r) => statusFilters.includes(r.lifecycle_state));

          // Disposition filter — pre-computed for index summaries, computed for full records
          if (query.disposition) {
            const dispFilters = Array.isArray(query.disposition)
              ? query.disposition
              : [query.disposition];
            filtered = filtered.filter((r) =>
              dispFilters.includes(
                "disposition" in r && typeof r.disposition === "string"
                  ? r.disposition
                  : computeDisposition(r as ReviewRecord),
              ),
            );
          }

          // Subject type filter
          if (query.subject_type) {
            const subjectFilters = Array.isArray(query.subject_type)
              ? query.subject_type
              : [query.subject_type];
            filtered = filtered.filter((r) => subjectFilters.includes(r.subject.type));
          }

          if (query.subject_ref) {
            filtered = filtered.filter(
              (r) => "ref" in r.subject && r.subject.ref === query.subject_ref,
            );
          }

          if (query.head_branch) {
            filtered = filtered.filter(
              (r) => r.subject.type === "code" && r.subject.head_branch === query.head_branch,
            );
          }

          // Reviewer filter
          if (query.reviewer) {
            filtered = filtered.filter((r) => r.author === query.reviewer);
          }

          // AC: @review-records-web-ui ac-7 — Task filter for task detail page integration
          // Task filter (matches subject ref for task reviews, or related_refs)
          if (query.task) {
            const taskFilter = query.task;
            filtered = filtered.filter((r) => {
              if (r.subject.type === "task" && "ref" in r.subject) {
                const ref = r.subject.ref;
                if (ref === taskFilter || ref === `@${taskFilter}` || `@${ref}` === taskFilter) {
                  return true;
                }
              }
              return r.related_refs.some(
                (rr) => rr === taskFilter || rr === `@${taskFilter}` || `@${rr}` === taskFilter,
              );
            });
          }

          // Sort
          const sortField = query.sort || "created_at";
          const sortDir = query.sort_dir === "asc" ? 1 : -1;
          filtered.sort((a, b) => {
            let aVal: string | number;
            let bVal: string | number;
            switch (sortField) {
              case "title":
                aVal = a.title.toLowerCase();
                bVal = b.title.toLowerCase();
                break;
              case "lifecycle_state":
                aVal = a.lifecycle_state;
                bVal = b.lifecycle_state;
                break;
              case "updated_at":
                aVal = a.updated_at || a.created_at;
                bVal = b.updated_at || b.created_at;
                break;
              case "created_at":
              default:
                aVal = a.created_at;
                bVal = b.created_at;
                break;
            }
            if (aVal < bVal) return -sortDir;
            if (aVal > bVal) return sortDir;
            return 0;
          });

          // Pagination
          const total = filtered.length;
          const offset = Number(query.offset) || 0;
          const limit = Number(query.limit) || total;
          const paginated = filtered.slice(offset, offset + limit);

          // Map to response summaries — use pre-computed values for cache index, compute for disk
          const items = fromCache
            ? paginated.map((r) => indexSummaryToReviewSummary(r as ReviewIndexSummary, index))
            : paginated.map((r) => toReviewSummary(r as ReviewRecord, index));

          return wrapResponse(items, {
            total,
            offset,
            limit,
            cacheDomainState: reviewsDomainState,
          });
        },
        {
          query: t.Object({
            status: t.Optional(enumArrayUnion(ReviewLifecycleStateSchema.options)),
            disposition: t.Optional(enumArrayUnion(ReviewDispositionSchema.options)),
            subject_type: t.Optional(enumArrayUnion(VALID_REVIEW_SUBJECT_TYPES)),
            subject_ref: t.Optional(t.String()),
            head_branch: t.Optional(t.String()),
            reviewer: t.Optional(t.String()),
            task: t.Optional(t.String()),
            sort: t.Optional(t.String()),
            sort_dir: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )

      // AC: @review-records-daemon-api ac-2 - Get single review by ref
      // AC: @daemon-entity-cache ac-detail-on-demand — serve from cache detail tier
      .get(
        "/:id",
        async ({ params, error: errorResponse, projectContext }) => {
          // AC: @daemon-entity-cache ac-serve-from-memory — defer initContext for cache hits
          const cache = getEntityCache?.(projectContext.path);
          const reviewsDomainState = cache?.getDomainState("reviews");

          // AC: @daemon-entity-cache ac-warming-availability — return loading indicator during warmup
          if (cache && reviewsDomainState === "loading") {
            return wrapResponse(null, { cacheDomainState: "loading" });
          }

          // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
          // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
          //     — review detail routes share the list route's contract: legacy
          //     and partial-layout projects must surface a structured 409, not
          //     fall through to a 404 or serve monolithic data.
          //
          // AC: @daemon-read-path ac-no-per-request-sync — skip the gate when
          //     the cache has already proved this project is compatible. See
          //     the list route for the full rationale (cache loader runs the
          //     strict gate at warm-up, so a "ready" domain proves compatibility).
          if (!cache || reviewsDomainState !== "ready") {
            try {
              const ctx = await initContext(projectContext.path, { syncMode: "skip" });
              await requireReviewFolderStorage(ctx);
            } catch (err) {
              const conflict = entityStorageIncompatibilityResponse(err, { cache });
              if (conflict) return errorResponse(conflict.status, conflict.body);
              throw err;
            }
          }

          let review;
          if (cache && reviewsDomainState === "ready") {
            // Find ULID in index, then load full record from detail tier
            const cachedIndex = cache.getReviewsIndex();
            if (cachedIndex) {
              const cleanRef = params.id.startsWith("@") ? params.id.slice(1) : params.id;
              const match = cachedIndex.find(
                (r) =>
                  r._ulid === cleanRef ||
                  r._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
                  r.slugs.includes(cleanRef),
              );
              if (match) {
                review = cache.getReviewDetail(match._ulid);
              }
            }
          }
          if (!review) {
            // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
            const ctx = await initContext(projectContext.path, { syncMode: "skip" });
            const reviews = await loadReviewRecords(ctx);
            review = findReviewByRef(reviews, params.id);
            // Cache the loaded detail for subsequent requests
            if (review && cache) {
              cache.setReviewDetail(review._ulid, review);
            }
          }

          if (!review) {
            return errorResponse(404, {
              error: "not_found",
              message: `Review "${params.id}" not found`,
              suggestion: "Use GET /api/reviews to list available reviews",
            });
          }

          // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
          //     — surface the review's declared resource metadata so the web
          //     UI detail page can render previews / download links without
          //     a separate fetch (and so static snapshots round-trip through
          //     the same ReviewDetail shape).
          const ctxForResources = await initContext(projectContext.path, { syncMode: "skip" });
          const reviewDir = getReviewDirForResources(ctxForResources, review._ulid);
          let resourceManifest: { resources: Array<Record<string, unknown>> } = { resources: [] };
          try {
            resourceManifest = await loadReviewResourceManifest(reviewDir);
          } catch {
            resourceManifest = { resources: [] };
          }

          return wrapResponse(
            {
              ...review,
              disposition: computeDisposition(review),
              resources: resourceManifest.resources,
            },
            { cacheDomainState: reviewsDomainState },
          );
        },
        {
          params: t.Object({
            id: t.String(),
          }),
        },
      )

      // AC: @review-records-daemon-api ac-3 - Create thread on review
      .post(
        "/:id/comments",
        async ({ params, body, error: errorResponse, projectContext }) => {
          const ctx = await initContext(projectContext.path);
          // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
          // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
          //     — review mutation routes require folder-backed review storage,
          //     same as the list/detail reads. The onError handler translates
          //     the thrown EntityStorageCompatibilityError into a structured
          //     409 response.
          await requireReviewFolderStorage(ctx);
          const reviews = await loadReviewRecords(ctx);
          const review = findReviewByRef(reviews, params.id);

          if (!review) {
            // AC: @review-records-daemon-api ac-10 - actionable error
            return errorResponse(404, {
              error: "not_found",
              message: `Review "${params.id}" not found`,
              suggestion: "Use kspec review list to find valid review references",
            });
          }

          // AC: @review-records-daemon-api ac-10 - validate required fields
          if (!body.body || typeof body.body !== "string" || body.body.trim().length === 0) {
            return errorResponse(400, {
              error: "validation_error",
              message: "Invalid input: body is required",
              details: [
                {
                  field: "body",
                  message: "Body is required and must be a non-empty string",
                },
              ],
            });
          }

          // Validate kind if provided
          if (body.kind && !VALID_THREAD_KINDS.includes(body.kind)) {
            return errorResponse(400, {
              error: "validation_error",
              message: `Invalid thread kind "${body.kind}"`,
              details: [
                {
                  field: "kind",
                  message: `Kind must be one of: ${VALID_THREAD_KINDS.join(", ")}`,
                },
              ],
            });
          }

          // Build anchor if provided
          let anchor: ReviewAnchor | undefined;
          if (body.anchor) {
            if (!body.anchor.type || typeof body.anchor.type !== "string") {
              return errorResponse(400, {
                error: "validation_error",
                message: "Invalid anchor type",
                details: [
                  {
                    field: "anchor.type",
                    message: `Anchor type must be one of: ${VALID_ANCHOR_TYPES.join(", ")}`,
                  },
                ],
              });
            }

            if (!VALID_ANCHOR_TYPES.includes(body.anchor.type)) {
              return errorResponse(400, {
                error: "validation_error",
                message: `Invalid anchor type "${body.anchor.type}"`,
                details: [
                  {
                    field: "anchor.type",
                    message: `Anchor type must be one of: ${VALID_ANCHOR_TYPES.join(", ")}`,
                  },
                ],
              });
            }

            if (body.anchor.type === "code") {
              if (
                !body.anchor.path ||
                !body.anchor.side ||
                body.anchor.line_start == null ||
                body.anchor.line_end == null ||
                !body.anchor.commit
              ) {
                return errorResponse(400, {
                  error: "validation_error",
                  message: "Invalid code anchor: missing required fields",
                  details: [
                    {
                      field: "anchor",
                      message:
                        "Code anchor requires path, side (base|head), line_start, line_end, and commit",
                    },
                  ],
                });
              }
              // Validate side field
              if (!VALID_CODE_ANCHOR_SIDES.includes(body.anchor.side)) {
                return errorResponse(400, {
                  error: "validation_error",
                  message: `Invalid anchor side "${body.anchor.side}"`,
                  details: [
                    {
                      field: "anchor.side",
                      message: `Side must be one of: ${VALID_CODE_ANCHOR_SIDES.join(", ")}`,
                    },
                  ],
                });
              }
              // Validate line_start and line_end are positive integers with line_end >= line_start
              if (!Number.isInteger(body.anchor.line_start) || body.anchor.line_start < 1) {
                return errorResponse(400, {
                  error: "validation_error",
                  message: "Invalid anchor line_start: must be a positive integer",
                  details: [
                    {
                      field: "anchor.line_start",
                      message: "line_start must be an integer greater than 0",
                    },
                  ],
                });
              }
              if (!Number.isInteger(body.anchor.line_end) || body.anchor.line_end < 1) {
                return errorResponse(400, {
                  error: "validation_error",
                  message: "Invalid anchor line_end: must be a positive integer",
                  details: [
                    {
                      field: "anchor.line_end",
                      message: "line_end must be an integer greater than 0",
                    },
                  ],
                });
              }
              if (body.anchor.line_end < body.anchor.line_start) {
                return errorResponse(400, {
                  error: "validation_error",
                  message: "Invalid anchor: line_end must be >= line_start",
                  details: [
                    {
                      field: "anchor.line_end",
                      message: `line_end (${body.anchor.line_end}) must be greater than or equal to line_start (${body.anchor.line_start})`,
                    },
                  ],
                });
              }
              anchor = {
                type: "code",
                path: body.anchor.path,
                side: body.anchor.side as "base" | "head",
                line_start: body.anchor.line_start,
                line_end: body.anchor.line_end,
                commit: body.anchor.commit,
              };
            } else if (body.anchor.type === "structured") {
              // Require at least one meaningful field for structured anchors
              if (
                !body.anchor.section &&
                !body.anchor.field &&
                !body.anchor.path &&
                !body.anchor.ref
              ) {
                return errorResponse(400, {
                  error: "validation_error",
                  message:
                    "Invalid structured anchor: at least one of section, field, path, or ref is required",
                  details: [
                    {
                      field: "anchor",
                      message:
                        "Structured anchor must have at least one of: section, field, path, ref",
                    },
                  ],
                });
              }
              anchor = {
                type: "structured",
                ...(body.anchor.section ? { section: body.anchor.section } : {}),
                ...(body.anchor.field ? { field: body.anchor.field } : {}),
                ...(body.anchor.path ? { path: body.anchor.path } : {}),
                ...(body.anchor.ref ? { ref: body.anchor.ref } : {}),
              };
            } else {
              return errorResponse(400, {
                error: "validation_error",
                message: `Invalid anchor type "${body.anchor.type}"`,
                details: [
                  {
                    field: "anchor.type",
                    message: 'Anchor type must be "code" or "structured"',
                  },
                ],
              });
            }
          }

          // AC: @actor-identity-resolution ac-6 ac-8 — resolve through the shared
          // author precedence + classifier; never persist an anonymous placeholder
          // or an out-of-pool free-form author.
          const authorResult = await resolveWriteActor(
            ctx,
            getEntityCache,
            projectContext.path,
            body.author,
            "author",
          );
          if (!authorResult.ok) {
            return errorResponse(400, toValidationErrorBody(authorResult));
          }
          const author = authorResult.actor;

          const { review: updatedReview, thread } = await addThreadAtomic(ctx, review, {
            author,
            body: body.body,
            kind: (body.kind as "blocker" | "question" | "nit") || undefined,
            anchor,
          });

          await commitIfShadow(ctx.shadow, `review: add thread to ${params.id}`);

          // AC: @daemon-entity-cache ac-write-through — update cache before response
          const threadCache = getEntityCache?.(projectContext.path);
          if (threadCache) {
            await threadCache.writeThrough("reviews");
          }

          // AC: @review-records-daemon-api ac-9 - WebSocket broadcast
          pubsub.broadcast(
            "reviews:updates",
            "thread_created",
            {
              review_ulid: updatedReview._ulid,
              thread_ulid: thread._ulid,
              kind: thread.kind,
              author,
            },
            projectContext.path,
          );

          return thread;
        },
        {
          params: t.Object({
            id: t.String(),
          }),
          body: t.Object({
            body: t.String(),
            kind: t.Optional(enumUnion(ReviewThreadKindSchema.options)),
            author: t.Optional(t.String()),
            anchor: t.Optional(
              t.Object({
                type: t.Optional(enumUnion(ReviewAnchorTypeSchema.options)),
                path: t.Optional(t.String()),
                side: t.Optional(enumUnion(ReviewCodeAnchorSideSchema.options)),
                line_start: t.Optional(t.Number()),
                line_end: t.Optional(t.Number()),
                commit: t.Optional(t.String()),
                section: t.Optional(t.String()),
                field: t.Optional(t.String()),
                ref: t.Optional(t.String()),
              }),
            ),
          }),
        },
      )

      // AC: @review-records-daemon-api ac-4 - Add reply to thread
      .post(
        "/:id/comments/:threadId/replies",
        async ({ params, body, error: errorResponse, projectContext }) => {
          const ctx = await initContext(projectContext.path);
          // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
          // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
          //     — review mutation routes require folder-backed review storage,
          //     same as the list/detail reads. The onError handler translates
          //     the thrown EntityStorageCompatibilityError into a structured
          //     409 response.
          await requireReviewFolderStorage(ctx);
          const reviews = await loadReviewRecords(ctx);
          const review = findReviewByRef(reviews, params.id);

          if (!review) {
            return errorResponse(404, {
              error: "not_found",
              message: `Review "${params.id}" not found`,
              suggestion: "Use kspec review list to find valid review references",
            });
          }

          // Check thread exists
          const thread = review.threads.find((th) => th._ulid === params.threadId);
          if (!thread) {
            // AC: @review-records-daemon-api ac-10 - actionable error for invalid thread
            return errorResponse(404, {
              error: "not_found",
              message: `Thread "${params.threadId}" not found on review "${params.id}"`,
              suggestion: "Use GET /api/reviews/:id to see available threads",
            });
          }

          // AC: @review-records-daemon-api ac-10 - validate required fields
          if (!body.body || typeof body.body !== "string" || body.body.trim().length === 0) {
            return errorResponse(400, {
              error: "validation_error",
              message: "Invalid input: body is required",
              details: [
                {
                  field: "body",
                  message: "Body is required and must be a non-empty string",
                },
              ],
            });
          }

          // AC: @actor-identity-resolution ac-6 ac-8 — canonical author or rejection.
          const replyAuthorResult = await resolveWriteActor(
            ctx,
            getEntityCache,
            projectContext.path,
            body.author,
            "author",
          );
          if (!replyAuthorResult.ok) {
            return errorResponse(400, toValidationErrorBody(replyAuthorResult));
          }
          const replyAuthor = replyAuthorResult.actor;

          try {
            const { review: updatedReview, entry } = await addReplyAtomic(ctx, review, {
              threadUlid: params.threadId,
              author: replyAuthor,
              body: body.body,
            });

            await commitIfShadow(
              ctx.shadow,
              `review: reply to thread ${params.threadId} on ${params.id}`,
            );

            // AC: @daemon-entity-cache ac-write-through — update cache before response
            const replyCache = getEntityCache?.(projectContext.path);
            if (replyCache) {
              await replyCache.writeThrough("reviews");
            }

            // AC: @review-records-daemon-api ac-9 - WebSocket broadcast
            pubsub.broadcast(
              "reviews:updates",
              "thread_replied",
              {
                review_ulid: updatedReview._ulid,
                thread_ulid: params.threadId,
                entry_ulid: entry._ulid,
                author: replyAuthor,
              },
              projectContext.path,
            );

            // Return the updated thread
            const updatedThread = updatedReview.threads.find((t) => t._ulid === params.threadId);
            return updatedThread;
          } catch (err) {
            return errorResponse(400, {
              error: "operation_failed",
              message: err instanceof Error ? err.message : "Failed to add reply",
            });
          }
        },
        {
          params: t.Object({
            id: t.String(),
            threadId: t.String(),
          }),
          body: t.Object({
            body: t.String(),
            author: t.Optional(t.String()),
          }),
        },
      )

      // AC: @review-records-daemon-api ac-5 - Resolve thread
      .patch(
        "/:id/comments/:threadId/resolve",
        async ({ params, body, error: errorResponse, projectContext }) => {
          const ctx = await initContext(projectContext.path);
          // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
          // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
          //     — review mutation routes require folder-backed review storage,
          //     same as the list/detail reads. The onError handler translates
          //     the thrown EntityStorageCompatibilityError into a structured
          //     409 response.
          await requireReviewFolderStorage(ctx);
          const reviews = await loadReviewRecords(ctx);
          const review = findReviewByRef(reviews, params.id);

          if (!review) {
            return errorResponse(404, {
              error: "not_found",
              message: `Review "${params.id}" not found`,
              suggestion: "Use kspec review list to find valid review references",
            });
          }

          // Check thread exists
          const thread = review.threads.find((t) => t._ulid === params.threadId);
          if (!thread) {
            return errorResponse(404, {
              error: "not_found",
              message: `Thread "${params.threadId}" not found on review "${params.id}"`,
              suggestion: "Use GET /api/reviews/:id to see available threads",
            });
          }

          // Already resolved
          if (thread.resolved_at) {
            return errorResponse(409, {
              error: "invalid_transition",
              message: `Thread "${params.threadId}" is already resolved`,
              current: "resolved",
              valid_transitions: ["reopen"],
            });
          }

          // AC: @actor-identity-resolution ac-6 ac-8 — canonical actor or rejection.
          const resolveActorResult = await resolveWriteActor(
            ctx,
            getEntityCache,
            projectContext.path,
            body?.actor,
            "actor",
          );
          if (!resolveActorResult.ok) {
            return errorResponse(400, toValidationErrorBody(resolveActorResult));
          }
          const resolveActor = resolveActorResult.actor;

          try {
            const updatedReview = await resolveThreadAtomic(ctx, review, {
              threadUlid: params.threadId,
              actor: resolveActor,
            });

            await commitIfShadow(
              ctx.shadow,
              `review: resolve thread ${params.threadId} on ${params.id}`,
            );

            // AC: @daemon-entity-cache ac-write-through — update cache before response
            const resolveCache = getEntityCache?.(projectContext.path);
            if (resolveCache) {
              await resolveCache.writeThrough("reviews");
            }

            // AC: @review-records-daemon-api ac-9 - WebSocket broadcast
            pubsub.broadcast(
              "reviews:updates",
              "thread_resolved",
              {
                review_ulid: updatedReview._ulid,
                thread_ulid: params.threadId,
                actor: resolveActor,
              },
              projectContext.path,
            );

            const updatedThread = updatedReview.threads.find((t) => t._ulid === params.threadId);
            return updatedThread;
          } catch (err) {
            return errorResponse(400, {
              error: "operation_failed",
              message: err instanceof Error ? err.message : "Failed to resolve thread",
            });
          }
        },
        {
          params: t.Object({
            id: t.String(),
            threadId: t.String(),
          }),
          body: t.Optional(
            t.Object({
              actor: t.Optional(t.String()),
            }),
          ),
        },
      )

      // AC: @review-records-daemon-api ac-5 - Reopen thread
      .patch(
        "/:id/comments/:threadId/reopen",
        async ({ params, body, error: errorResponse, projectContext }) => {
          const ctx = await initContext(projectContext.path);
          // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
          // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
          //     — review mutation routes require folder-backed review storage,
          //     same as the list/detail reads. The onError handler translates
          //     the thrown EntityStorageCompatibilityError into a structured
          //     409 response.
          await requireReviewFolderStorage(ctx);
          const reviews = await loadReviewRecords(ctx);
          const review = findReviewByRef(reviews, params.id);

          if (!review) {
            return errorResponse(404, {
              error: "not_found",
              message: `Review "${params.id}" not found`,
              suggestion: "Use kspec review list to find valid review references",
            });
          }

          // Check thread exists
          const thread = review.threads.find((t) => t._ulid === params.threadId);
          if (!thread) {
            return errorResponse(404, {
              error: "not_found",
              message: `Thread "${params.threadId}" not found on review "${params.id}"`,
              suggestion: "Use GET /api/reviews/:id to see available threads",
            });
          }

          // Not resolved
          if (!thread.resolved_at) {
            return errorResponse(409, {
              error: "invalid_transition",
              message: `Thread "${params.threadId}" is not resolved`,
              current: "open",
              valid_transitions: ["resolve"],
            });
          }

          // AC: @actor-identity-resolution ac-6 ac-8 — canonical actor or rejection.
          const reopenActorResult = await resolveWriteActor(
            ctx,
            getEntityCache,
            projectContext.path,
            body?.actor,
            "actor",
          );
          if (!reopenActorResult.ok) {
            return errorResponse(400, toValidationErrorBody(reopenActorResult));
          }
          const reopenActor = reopenActorResult.actor;

          try {
            const updatedReview = await reopenThreadAtomic(ctx, review, {
              threadUlid: params.threadId,
              actor: reopenActor,
            });

            await commitIfShadow(
              ctx.shadow,
              `review: reopen thread ${params.threadId} on ${params.id}`,
            );

            // AC: @daemon-entity-cache ac-write-through — update cache before response
            const reopenCache = getEntityCache?.(projectContext.path);
            if (reopenCache) {
              await reopenCache.writeThrough("reviews");
            }

            // AC: @review-records-daemon-api ac-9 - WebSocket broadcast
            pubsub.broadcast(
              "reviews:updates",
              "thread_reopened",
              {
                review_ulid: updatedReview._ulid,
                thread_ulid: params.threadId,
                actor: reopenActor,
              },
              projectContext.path,
            );

            const updatedThread = updatedReview.threads.find((t) => t._ulid === params.threadId);
            return updatedThread;
          } catch (err) {
            return errorResponse(400, {
              error: "operation_failed",
              message: err instanceof Error ? err.message : "Failed to reopen thread",
            });
          }
        },
        {
          params: t.Object({
            id: t.String(),
            threadId: t.String(),
          }),
          body: t.Optional(
            t.Object({
              actor: t.Optional(t.String()),
            }),
          ),
        },
      )

      // AC: @review-records-daemon-api ac-6 - Record verdict on review
      .post(
        "/:id/verdicts",
        async ({ params, body, set, projectContext }) => {
          // AC: @review-records-daemon-api ac-10 - validate required fields
          if (!body.decision || typeof body.decision !== "string") {
            set.status = 400;
            return {
              error: "validation_error",
              message: "Invalid input: decision is required",
              details: [
                {
                  field: "decision",
                  message: `Decision is required and must be one of: ${VALID_DECISIONS.join(", ")}`,
                },
              ],
            };
          }

          if (!VALID_DECISIONS.includes(body.decision as ReviewVerdictDecision)) {
            set.status = 400;
            return {
              error: "validation_error",
              message: `Invalid verdict decision "${body.decision}"`,
              details: [
                {
                  field: "decision",
                  message: `Decision must be one of: ${VALID_DECISIONS.join(", ")}`,
                },
              ],
            };
          }

          if (
            !body.reviewer ||
            typeof body.reviewer !== "string" ||
            body.reviewer.trim().length === 0
          ) {
            set.status = 400;
            return {
              error: "validation_error",
              message: "Invalid input: reviewer is required",
              details: [
                {
                  field: "reviewer",
                  message: "Reviewer is required and must be a non-empty string",
                },
              ],
            };
          }

          const ctx = await initContext(projectContext.path);
          // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
          // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
          //     — review mutation routes require folder-backed review storage,
          //     same as the list/detail reads. The onError handler translates
          //     the thrown EntityStorageCompatibilityError into a structured
          //     409 response.
          await requireReviewFolderStorage(ctx);
          const reviews = await loadReviewRecords(ctx);
          const review = findReviewByRef(reviews, params.id);

          if (!review) {
            set.status = 404;
            return {
              error: "not_found",
              message: `Review "${params.id}" not found`,
              suggestion: "Use kspec review list to find valid review references",
            };
          }

          // Guard: reject mutations on archived (terminal-state) reviews
          if (review.lifecycle_state === "archived") {
            set.status = 400;
            return {
              error: "invalid_state",
              message: "Cannot add verdicts to an archived review",
              current_state: "archived",
              suggestion: '"archived" is a terminal state — archived reviews are immutable',
            };
          }

          const decision = body.decision as ReviewVerdictDecision;

          // AC: @actor-identity-resolution ac-7 ac-8 — persist the canonical
          // reviewer identity; reject an out-of-pool free-form reviewer.
          const reviewerResult = await resolveWriteActor(
            ctx,
            getEntityCache,
            projectContext.path,
            body.reviewer,
            "reviewer",
          );
          if (!reviewerResult.ok) {
            set.status = 400;
            return toValidationErrorBody(reviewerResult);
          }
          const reviewer = reviewerResult.actor;

          // AC: @review-record-per-cycle-lifecycle ac-1 — auto-close on approve/request_changes
          const shouldAutoClose = decision === "approve" || decision === "request_changes";

          const updated = await mutateReviewAtomically(ctx, review, (latest) => {
            const withVerdict = submitVerdict(latest, {
              reviewer,
              decision,
              role: body.role || undefined,
            });

            // Auto-close if approve or request_changes
            if (shouldAutoClose && withVerdict.lifecycle_state !== "closed") {
              return transitionLifecycle(withVerdict, "closed", reviewer);
            }

            return withVerdict;
          });

          await commitIfShadow(
            ctx.shadow,
            "review-verdict",
            review.slugs[0] || review._ulid.slice(0, 8),
            `${decision}${shouldAutoClose ? " (auto-closed)" : ""}`,
          );

          let transitionedTaskUlids: string[] = [];

          // AC: @review-task-lifecycle-integration ac-4
          // Auto-transition tasks to needs_work on changes_requested verdict
          // AC: @api-contract ac-task-storage-incompatibility-* — surface storage
          // incompatibility as a structured 409 instead of a 500. The verdict has
          // already been committed; the response signals the post-verdict task
          // transition could not run because of the project's storage state.
          if (decision === "request_changes") {
            let allTasks;
            try {
              allTasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
            } catch (err) {
              const verdictCache = getEntityCache?.(projectContext.path);
              const conflict = taskStorageIncompatibilityResponse(err, { cache: verdictCache });
              if (conflict) {
                if (verdictCache) {
                  await verdictCache.writeThrough("reviews");
                }
                return errorResponse(conflict.status, conflict.body);
              }
              throw err;
            }
            const transitioned = await handleVerdictTaskTransition(
              ctx,
              updated,
              decision,
              allTasks,
              reviewer,
            );
            if (transitioned.some((tr) => tr.transitioned)) {
              await commitIfShadow(
                ctx.shadow,
                "review-verdict-task-transition",
                review.slugs[0] || review._ulid.slice(0, 8),
                "tasks transitioned to needs_work",
              );
            }
            transitionedTaskUlids = transitioned
              .filter((taskTransition) => taskTransition.transitioned)
              .map((taskTransition) => taskTransition.ulid);
          }

          // AC: @daemon-entity-cache ac-write-through — update cache before response
          // Verdict submission can transition linked tasks (e.g. request_changes → needs_work),
          // so write-through both reviews and tasks domains.
          const verdictCache = getEntityCache?.(projectContext.path);
          if (verdictCache) {
            await verdictCache.writeThrough("reviews");
            if (transitionedTaskUlids.length > 0) {
              await Promise.all(
                transitionedTaskUlids.map((ulid) => verdictCache.writeThrough("tasks", { ulid })),
              );
            }
          }

          // AC: @review-records-daemon-api ac-9 - WebSocket broadcast
          pubsub.broadcast(
            "reviews:updates",
            "verdict_submitted",
            {
              review_ulid: updated._ulid,
              decision,
              reviewer,
              lifecycle_state: updated.lifecycle_state,
              disposition: computeDisposition(updated),
            },
            projectContext.path,
          );

          // Return verdict with recomputed disposition
          return {
            review_ulid: updated._ulid,
            decision,
            reviewer,
            lifecycle_state: updated.lifecycle_state,
            disposition: computeDisposition(updated),
          };
        },
        {
          params: t.Object({
            id: t.String(),
          }),
          body: t.Object({
            decision: t.Optional(enumUnion(ReviewVerdictDecisionSchema.options)),
            reviewer: t.Optional(t.String()),
            role: t.Optional(t.String()),
          }),
        },
      )

      // AC: @review-records-daemon-api ac-7 - Record check on review
      .post(
        "/:id/checks",
        async ({ params, body, set, projectContext }) => {
          // AC: @review-records-daemon-api ac-10 - validate required fields
          if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
            set.status = 400;
            return {
              error: "validation_error",
              message: "Invalid input: name is required",
              details: [
                {
                  field: "name",
                  message: "Name is required and must be a non-empty string",
                },
              ],
            };
          }

          if (!body.status || typeof body.status !== "string") {
            set.status = 400;
            return {
              error: "validation_error",
              message: "Invalid input: status is required",
              details: [
                {
                  field: "status",
                  message: `Status is required and must be one of: ${VALID_CHECK_STATUSES.join(", ")}`,
                },
              ],
            };
          }

          if (!VALID_CHECK_STATUSES.includes(body.status as ReviewCheckStatus)) {
            set.status = 400;
            return {
              error: "validation_error",
              message: `Invalid check status "${body.status}"`,
              details: [
                {
                  field: "status",
                  message: `Status must be one of: ${VALID_CHECK_STATUSES.join(", ")}`,
                },
              ],
            };
          }

          const ctx = await initContext(projectContext.path);
          // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
          // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
          //     — review mutation routes require folder-backed review storage,
          //     same as the list/detail reads. The onError handler translates
          //     the thrown EntityStorageCompatibilityError into a structured
          //     409 response.
          await requireReviewFolderStorage(ctx);
          const reviews = await loadReviewRecords(ctx);
          const review = findReviewByRef(reviews, params.id);

          if (!review) {
            set.status = 404;
            return {
              error: "not_found",
              message: `Review "${params.id}" not found`,
              suggestion: "Use kspec review list to find valid review references",
            };
          }

          // Guard: reject mutations on archived (terminal-state) reviews
          if (review.lifecycle_state === "archived") {
            set.status = 400;
            return {
              error: "invalid_state",
              message: "Cannot add checks to an archived review",
              current_state: "archived",
              suggestion: '"archived" is a terminal state — archived reviews are immutable',
            };
          }

          // Derive applies_to_version from the current review subject
          const appliesTo = extractSubjectVersion(review.subject);

          // AC: @actor-identity-resolution ac-6 ac-8 — resolve the event actor
          // (who recorded the check) through the shared author precedence +
          // classifier; never persist an anonymous placeholder. `runner` is the
          // tool/command that executed the check (e.g. "npm test", "kspec"), not
          // a human/agent actor, so it is persisted verbatim and not classified.
          const checkActorResult = await resolveWriteActor(
            ctx,
            getEntityCache,
            projectContext.path,
            undefined,
            "actor",
          );
          if (!checkActorResult.ok) {
            set.status = 400;
            return toValidationErrorBody(checkActorResult);
          }
          const checkActor = checkActorResult.actor;

          const check = createCheck({
            name: body.name,
            status: body.status as ReviewCheckStatus,
            applies_to_version: appliesTo,
            required: body.required !== false, // defaults to true
            runner: body.runner || undefined,
            evidence: body.evidence || undefined,
          });

          const now = new Date().toISOString();
          const checkEvent: ReviewEvent = {
            _ulid: ulid(),
            event_type: "check_added",
            actor: checkActor,
            timestamp: now,
            payload: {
              name: body.name,
              status: body.status,
            },
          };

          const updated = await mutateReviewAtomically(ctx, review, (latest) => ({
            ...latest,
            checks: [...latest.checks, check],
            events: [...latest.events, checkEvent],
            updated_at: now,
          }));

          await commitIfShadow(
            ctx.shadow,
            "review-check",
            review.slugs[0] || review._ulid.slice(0, 8),
            `${body.name}: ${body.status}`,
          );

          // AC: @daemon-entity-cache ac-write-through — update cache before response
          const checkCache = getEntityCache?.(projectContext.path);
          if (checkCache) {
            await checkCache.writeThrough("reviews");
          }

          // Compute gate evaluation for the response
          const currentVersion = extractSubjectVersion(updated.subject);
          const gateResult = evaluateGates(updated.checks, currentVersion);

          // AC: @review-records-daemon-api ac-9 - WebSocket broadcast
          pubsub.broadcast(
            "reviews:updates",
            "check_added",
            {
              review_ulid: updated._ulid,
              check_name: body.name,
              check_status: body.status,
              gate_state: gateResult.state,
            },
            projectContext.path,
          );

          return {
            review_ulid: updated._ulid,
            check,
            gate_state: gateResult.state,
            gate_summary: gateResult.summary,
          };
        },
        {
          params: t.Object({
            id: t.String(),
          }),
          body: t.Object({
            name: t.Optional(t.String()),
            status: t.Optional(enumUnion(ReviewCheckStatusSchema.options)),
            runner: t.Optional(t.String()),
            evidence: t.Optional(t.String()),
            required: t.Optional(t.Boolean()),
          }),
        },
      )

      // AC: @review-records-daemon-api ac-8 - Lifecycle transition
      .patch(
        "/:id/lifecycle",
        async ({ params, body, set, projectContext }) => {
          // Manual validation before initContext to return proper 400s
          const target = body?.target;
          if (!target || typeof target !== "string") {
            set.status = 400;
            return {
              error: "validation_error",
              message: "Invalid input: target state is required",
              details: [
                {
                  field: "target",
                  message: `Target is required and must be one of: ${VALID_LIFECYCLE_TARGETS.join(", ")}`,
                },
              ],
            };
          }

          if (!VALID_LIFECYCLE_TARGETS.includes(target as ReviewLifecycleState)) {
            set.status = 400;
            return {
              error: "validation_error",
              message: `Invalid lifecycle target "${target}"`,
              details: [
                {
                  field: "target",
                  message: `Target must be one of: ${VALID_LIFECYCLE_TARGETS.join(", ")}`,
                },
              ],
            };
          }

          const ctx = await initContext(projectContext.path);
          // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
          // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
          //     — review mutation routes require folder-backed review storage,
          //     same as the list/detail reads. The onError handler translates
          //     the thrown EntityStorageCompatibilityError into a structured
          //     409 response.
          await requireReviewFolderStorage(ctx);
          const reviews = await loadReviewRecords(ctx);
          const review = findReviewByRef(reviews, params.id);

          if (!review) {
            set.status = 404;
            return {
              error: "not_found",
              message: `Review "${params.id}" not found`,
              suggestion: "Use kspec review list to find valid review references",
            };
          }

          const lifecycleTarget = target as ReviewLifecycleState;

          // AC: @actor-identity-resolution ac-6 ac-8 — canonical actor or rejection.
          const lifecycleActorResult = await resolveWriteActor(
            ctx,
            getEntityCache,
            projectContext.path,
            body?.actor,
            "actor",
          );
          if (!lifecycleActorResult.ok) {
            set.status = 400;
            return toValidationErrorBody(lifecycleActorResult);
          }
          const actor = lifecycleActorResult.actor;
          const allowed = VALID_TRANSITIONS[review.lifecycle_state];

          // AC: @review-records-daemon-api ac-8, ac-10 - invalid transition returns 400
          if (!allowed.includes(lifecycleTarget)) {
            set.status = 400;
            return {
              error: "invalid_transition",
              message: `Cannot transition from "${review.lifecycle_state}" to "${lifecycleTarget}"`,
              current_state: review.lifecycle_state,
              valid_transitions: allowed,
              suggestion:
                allowed.length > 0
                  ? `Valid transitions from "${review.lifecycle_state}": ${allowed.join(", ")}`
                  : `"${review.lifecycle_state}" is a terminal state with no valid transitions`,
            };
          }

          try {
            const updated = await mutateReviewAtomically(ctx, review, (latest) => {
              return transitionLifecycle(latest, lifecycleTarget, actor);
            });

            await commitIfShadow(
              ctx.shadow,
              "review-lifecycle",
              review.slugs[0] || review._ulid.slice(0, 8),
              `${review.lifecycle_state} → ${lifecycleTarget}`,
            );

            // AC: @daemon-entity-cache ac-write-through — update cache before response
            const lifecycleCache = getEntityCache?.(projectContext.path);
            if (lifecycleCache) {
              await lifecycleCache.writeThrough("reviews");
            }

            // AC: @review-records-daemon-api ac-9 - WebSocket broadcast
            pubsub.broadcast(
              "reviews:updates",
              "lifecycle_changed",
              {
                review_ulid: updated._ulid,
                from: review.lifecycle_state,
                to: lifecycleTarget,
                actor,
              },
              projectContext.path,
            );

            return {
              review_ulid: updated._ulid,
              lifecycle_state: updated.lifecycle_state,
              previous_state: review.lifecycle_state,
            };
          } catch (err) {
            set.status = 400;
            return {
              error: "invalid_transition",
              message: err instanceof Error ? err.message : "Failed to transition lifecycle",
            };
          }
        },
        {
          params: t.Object({
            id: t.String(),
          }),
          body: t.Optional(
            t.Object({
              target: t.Optional(enumUnion(VALID_LIFECYCLE_TARGETS)),
              actor: t.Optional(t.String()),
            }),
          ),
        },
      )
  );
}
