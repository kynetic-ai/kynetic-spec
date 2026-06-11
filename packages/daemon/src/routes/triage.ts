/**
 * Triage API Routes
 *
 * REST endpoints for triage operations:
 * - GET /api/triage - list records with filters and pagination
 * - GET /api/triage/export - export records for agent handoff
 * - POST /api/triage - record a triage decision
 * - GET /api/triage/:ref - get single record
 * - POST /api/triage/:ref/override - override a decision
 * - POST /api/triage/:ref/act - execute a triage action
 *
 * AC Coverage:
 * - @triage-daemon-api ac-1: GET list sorted by created_at desc
 * - @triage-daemon-api ac-2: Status filter on GET list
 * - @triage-daemon-api ac-3: POST creates record with snapshot
 * - @triage-daemon-api ac-4: POST /:ref/override sets override fields
 * - @triage-daemon-api ac-5: POST /:ref/act executes and transitions
 * - @triage-daemon-api ac-6: GET export with format parameter
 * - @triage-daemon-api ac-7: POST 404 for nonexistent inbox item
 * - @triage-daemon-api ac-8: POST /:ref/act 409 for already acted
 * - @triage-daemon-api ac-9: POST /:ref/act 422 for pending record
 */

import { Elysia, t } from "elysia";
import { ulid } from "ulidx";
import {
  initContext,
  loadAllItems,
  ReferenceIndex,
  loadTriageRecords,
  saveTriageRecord,
  findTriageRecordByRef,
  findTriageRecordByInboxRef,
  loadInboxItems,
  findInboxItemByRef,
  getAuthor,
  resolveTaskDataManager,
  type LoadedTriageRecord,
  type LoadedTask,
  type LoadedSpecItem,
} from "../../parser/index.js";
import { resolveRefEntries } from "./ref-resolution.js";
import { commitIfShadow } from "../../parser/shadow.js";
import { normalizeRefInput, TriageActionSchema, TriageStatusSchema } from "../../schema/index.js";
import type { TriageAction } from "../../schema/index.js";
import { exportTriageRecords } from "../../export/triage.js";
import { executeTriageAction, VALID_ACTIONS } from "../../triage/index.js";
import type { PubSubManager } from "../websocket/pubsub.js";
import { enumArrayUnion, enumUnion } from "./enum-utils.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";
import { wrapResponse } from "./response-envelope.js";
import { taskStorageIncompatibilityResponse } from "./task-storage-error.js";

interface TriageRouteOptions {
  pubsub: PubSubManager;
  getEntityCache?: EntityCacheAccessor;
}

// VALID_ACTIONS and executeTriageAction imported from shared triage module

export function createTriageRoutes(options: TriageRouteOptions) {
  const { pubsub, getEntityCache } = options;

  return (
    new Elysia({ prefix: "/api/triage" })
      // AC: @triage-daemon-api ac-1, ac-2 - List triage records with filters and pagination
      // AC: @trait-api-endpoint ac-1, ac-4 - JSON response with pagination wrapper
      .get(
        "/",
        async ({ query, projectContext }) => {
          // AC: @daemon-entity-cache ac-serve-from-memory — use cached triage records when ready
          const cache = getEntityCache?.(projectContext.path);
          const triageDomainState = cache?.getDomainState("triage");

          // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
          if (cache && triageDomainState === "loading") {
            return wrapResponse([] as never[], {
              cacheDomainState: "loading",
              total: 0,
              offset: 0,
              limit: 0,
            });
          }

          let _ctx: Awaited<ReturnType<typeof initContext>> | null = null;
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const getCtx = async () => {
            if (!_ctx) _ctx = await initContext(projectContext.path, { syncMode: "skip" });
            return _ctx;
          };

          let records;
          if (cache && triageDomainState === "ready") {
            records = cache.getTriageIndex();
          }
          if (!records) {
            // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
            const ctx = await getCtx();
            records = await loadTriageRecords(ctx);
          }

          // Apply filters
          let filtered = records;

          // AC: @triage-daemon-api ac-2 - Status filter
          if (query.status) {
            const statusFilters = Array.isArray(query.status) ? query.status : [query.status];
            filtered = filtered.filter((r) => statusFilters.includes(r.status));
          }

          // Action filter
          if (query.action) {
            const actionFilters = Array.isArray(query.action) ? query.action : [query.action];
            filtered = filtered.filter((r) => r.action && actionFilters.includes(r.action));
          }

          // AC: @triage-daemon-api ac-1 - Sort by created_at descending (newest first)
          filtered.sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
          );

          // AC: @trait-api-endpoint ac-4 - Pagination with limit and offset
          const total = filtered.length;
          const offset = Number(query.offset) || 0;
          const limit = Number(query.limit) || total;

          const paginated = filtered.slice(offset, offset + limit);

          // AC: @ui-api-ref-resolution ac-2 - Resolve evidence_refs titles
          const hasEvidenceRefs = paginated.some((r) => r.evidence_refs?.length > 0);
          let refIndex: ReferenceIndex | null = null;
          if (hasEvidenceRefs) {
            try {
              // AC: @daemon-entity-cache ac-serve-from-memory — try cache for tasks and items
              const tasksDomainState = cache?.getDomainState("tasks");
              const itemsDomainState = cache?.getDomainState("items");
              const tasks =
                (cache && tasksDomainState === "ready" ? cache.getTaskIndex() : null) ??
                (await resolveTaskDataManager(await getCtx()).loadAllTasks(await getCtx()));
              const items =
                (cache && itemsDomainState === "ready" ? cache.getItemIndex() : null) ??
                (await loadAllItems(await getCtx()));
              refIndex = new ReferenceIndex(
                tasks as unknown as LoadedTask[],
                items as unknown as LoadedSpecItem[],
              );
            } catch {
              // Non-critical
            }
          }
          const enriched = refIndex
            ? paginated.map((r) => ({
                ...r,
                resolved_evidence_refs: resolveRefEntries(refIndex!, r.evidence_refs),
              }))
            : paginated;

          return wrapResponse(enriched, {
            total,
            offset,
            limit,
            cacheDomainState: triageDomainState,
          });
        },
        {
          query: t.Object({
            status: t.Optional(enumArrayUnion(TriageStatusSchema.options)),
            action: t.Optional(enumArrayUnion(TriageActionSchema.options)),
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )

      // AC: @triage-daemon-api ac-6 - Export triage records
      // NOTE: This route MUST be defined before /:ref to avoid "export" being parsed as a ref
      .get(
        "/export",
        async ({ query, projectContext }) => {
          // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
          const cache = getEntityCache?.(projectContext.path);
          const triageDomainState = cache?.getDomainState("triage");
          if (cache && triageDomainState === "loading") {
            return wrapResponse([] as never[], { cacheDomainState: "loading" });
          }

          // Export requires full triage records (item_snapshot, reasoning, etc.)
          // — the index tier (TriageIndexSummary) strips those fields.
          // Always load full records from disk for export.
          // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          let records = await loadTriageRecords(ctx);

          // Optional status filter on export
          if (query.status) {
            const statusFilters = Array.isArray(query.status) ? query.status : [query.status];
            records = records.filter((r) => statusFilters.includes(r.status));
          }

          const format = (query.format || "json") as "json" | "context";

          // AC: @triage-daemon-api ac-6 - Export via shared formatter
          // AC: @triage-agent-export ac-1, ac-2, ac-3, ac-4
          return exportTriageRecords(records, format);
        },
        {
          query: t.Object({
            format: t.Optional(t.String()),
            status: t.Optional(enumArrayUnion(TriageStatusSchema.options)),
          }),
        },
      )

      // AC: @triage-daemon-api ac-3 - Record a triage decision
      // AC: @trait-api-endpoint ac-1, ac-3, ac-5 - JSON response, validation, shadow commit
      .post(
        "/",
        async ({ body, error: errorResponse, projectContext }) => {
          // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
          const ctx = await initContext(projectContext.path);

          // AC: @trait-api-endpoint ac-3 - Validate action
          if (!VALID_ACTIONS.includes(body.action)) {
            return errorResponse(400, {
              error: "validation_error",
              details: [
                {
                  field: "action",
                  message: `Action must be one of: ${VALID_ACTIONS.join(", ")}`,
                },
              ],
            });
          }

          // AC: @triage-daemon-api ac-7 - Validate inbox item exists
          const inboxItems = await loadInboxItems(ctx);
          const inboxItem = findInboxItemByRef(inboxItems, body.inbox_ref);
          if (!inboxItem) {
            // AC: @trait-api-endpoint ac-2 - 404 with error guidance
            return errorResponse(404, {
              error: "not_found",
              message: `Inbox item reference "${body.inbox_ref}" not found`,
              suggestion:
                "Use kspec inbox list or GET /api/inbox to find valid inbox item references",
            });
          }

          const author = body.decided_by || getAuthor(ctx.config?.identity?.author);
          const evidenceRefs = body.evidence_refs ? body.evidence_refs.map(normalizeRefInput) : [];

          // Check if a record already exists for this inbox item (upsert case)
          const existingRecords = await loadTriageRecords(ctx);
          const existing = findTriageRecordByInboxRef(existingRecords, inboxItem._ulid);

          // AC: @triage-daemon-api ac-3 - Create record with item_snapshot
          const record: LoadedTriageRecord = {
            _ulid: existing?._ulid || ulid(),
            inbox_ref: inboxItem._ulid,
            item_snapshot: inboxItem.text,
            status: "triaged",
            action: body.action as TriageAction,
            reasoning: body.reasoning,
            decided_by: author,
            evidence_refs: evidenceRefs,
            created_at: existing?.created_at || new Date().toISOString(),
          };

          await saveTriageRecord(ctx, record);

          // Reload to get the persisted record (saveTriageRecord may upsert by inbox_ref)
          const savedRecords = await loadTriageRecords(ctx);
          const savedRecord = findTriageRecordByInboxRef(savedRecords, inboxItem._ulid) || record;

          // AC: @trait-api-endpoint ac-5 - Shadow commit
          await commitIfShadow(
            ctx.shadow,
            `triage: record ${savedRecord._ulid.slice(0, 8)} as ${savedRecord.action}`,
          );

          // AC: @daemon-entity-cache ac-write-through — update cache before response
          const createTriageCache = getEntityCache?.(projectContext.path);
          if (createTriageCache) {
            await createTriageCache.writeThrough("triage");
          }

          // AC: @triage-daemon-api ac-3 - Broadcast triage:updates via WebSocket
          // AC: @trait-websocket-protocol ac-3 - Broadcast event
          pubsub.broadcast(
            "triage:updates",
            "triage_record_created",
            {
              ulid: savedRecord._ulid,
              inbox_ref: savedRecord.inbox_ref,
              action: savedRecord.action,
            },
            projectContext.path,
          );

          // AC: @trait-api-endpoint ac-1 - Return 2xx with JSON body
          return {
            success: true,
            record: savedRecord,
          };
        },
        {
          body: t.Object({
            inbox_ref: t.String(),
            action: enumUnion(TriageActionSchema.options),
            reasoning: t.String(),
            decided_by: t.Optional(t.String()),
            evidence_refs: t.Optional(t.Array(t.String())),
          }),
        },
      )

      // GET single triage record
      // AC: @ui-api-ref-resolution ac-2 - Resolve evidence_refs titles
      // AC: @daemon-entity-cache ac-detail-on-demand — serve from cache detail tier
      .get(
        "/:ref",
        async ({ params, error: errorResponse, projectContext }) => {
          // AC: @daemon-entity-cache ac-serve-from-memory — defer initContext for cache hits
          const cache = getEntityCache?.(projectContext.path);
          let _ctx: Awaited<ReturnType<typeof initContext>> | null = null;
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const getCtx = async () => {
            if (!_ctx) _ctx = await initContext(projectContext.path, { syncMode: "skip" });
            return _ctx;
          };

          const triageDomainState = cache?.getDomainState("triage");

          // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
          if (cache && triageDomainState === "loading") {
            return wrapResponse(null, { cacheDomainState: "loading" });
          }

          // AC: @daemon-entity-cache ac-detail-on-demand — resolve via index, load from detail tier
          let record: LoadedTriageRecord | undefined;
          if (cache && triageDomainState === "ready") {
            const cachedIndex = cache.getTriageIndex();
            if (cachedIndex) {
              const cleanRef = params.ref.startsWith("@") ? params.ref.slice(1) : params.ref;
              const match = cachedIndex.find(
                (r) =>
                  r._ulid === cleanRef || r._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()),
              );
              if (match) {
                record = cache.getTriageDetail(match._ulid) ?? undefined;
              }
            }
          }
          if (!record) {
            // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
            const ctx = await getCtx();
            const records = await loadTriageRecords(ctx);
            // AC: @trait-api-endpoint ac-2 - Resolve ref
            record = findTriageRecordByRef(records, params.ref);
            // Cache the loaded detail for subsequent requests
            if (record && cache) {
              cache.setTriageDetail(record._ulid, record);
            }
          }

          if (!record) {
            return errorResponse(404, {
              error: "not_found",
              message: `Triage record reference "${params.ref}" not found`,
              suggestion:
                "Use kspec triage list or GET /api/triage to find valid triage record references",
            });
          }

          // AC: @ui-api-ref-resolution ac-2 - Resolve evidence_refs
          if (record.evidence_refs?.length > 0) {
            try {
              // AC: @daemon-entity-cache ac-serve-from-memory — try cache for tasks and items
              const tasksDomainState = cache?.getDomainState("tasks");
              const itemsDomainState = cache?.getDomainState("items");
              const tasks =
                (cache && tasksDomainState === "ready" ? cache.getTaskIndex() : null) ??
                (await resolveTaskDataManager(await getCtx()).loadAllTasks(await getCtx()));
              const items =
                (cache && itemsDomainState === "ready" ? cache.getItemIndex() : null) ??
                (await loadAllItems(await getCtx()));
              const refIndex = new ReferenceIndex(
                tasks as unknown as LoadedTask[],
                items as unknown as LoadedSpecItem[],
              );
              return wrapResponse(
                {
                  ...record,
                  resolved_evidence_refs: resolveRefEntries(refIndex, record.evidence_refs),
                },
                { cacheDomainState: triageDomainState },
              );
            } catch {
              // Non-critical
            }
          }

          return wrapResponse(record, { cacheDomainState: triageDomainState });
        },
        {
          params: t.Object({
            ref: t.String(),
          }),
        },
      )

      // AC: @triage-daemon-api ac-4 - Override a triage decision
      // AC: @trait-api-endpoint ac-1, ac-5 - JSON response, shadow commit
      .post(
        "/:ref/override",
        async ({ params, body, error: errorResponse, projectContext }) => {
          // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
          const ctx = await initContext(projectContext.path);
          const records = await loadTriageRecords(ctx);

          // AC: @trait-api-endpoint ac-2 - Resolve ref
          const record = findTriageRecordByRef(records, params.ref);
          if (!record) {
            return errorResponse(404, {
              error: "not_found",
              message: `Triage record reference "${params.ref}" not found`,
              suggestion:
                "Use kspec triage list or GET /api/triage to find valid triage record references",
            });
          }

          // AC: @trait-api-endpoint ac-3 - Validate action
          if (!VALID_ACTIONS.includes(body.action)) {
            return errorResponse(400, {
              error: "validation_error",
              details: [
                {
                  field: "action",
                  message: `Action must be one of: ${VALID_ACTIONS.join(", ")}`,
                },
              ],
            });
          }

          const overrideBy = body.override_by || getAuthor(ctx.config?.identity?.author);

          // AC: @triage-daemon-api ac-4 - Set override fields and update action
          record.override_reasoning = body.reasoning;
          record.override_by = overrideBy;
          record.override_at = new Date().toISOString();
          record.action = body.action as TriageAction;
          record.updated_at = new Date().toISOString();

          // Re-triage if already acted on (allows re-acting with new action)
          // Clear stale execution metadata to avoid leaking previous action results
          if (record.status === "acted_on") {
            record.status = "triaged";
            record.acted_at = undefined;
            record.result_ref = undefined;
          }

          await saveTriageRecord(ctx, record);

          // AC: @trait-api-endpoint ac-5 - Shadow commit
          await commitIfShadow(ctx.shadow, `triage: override ${record._ulid.slice(0, 8)}`);

          // AC: @daemon-entity-cache ac-write-through — update cache before response
          const overrideCache = getEntityCache?.(projectContext.path);
          if (overrideCache) {
            await overrideCache.writeThrough("triage");
          }

          // AC: @triage-daemon-api ac-4 - Broadcast triage:updates
          pubsub.broadcast(
            "triage:updates",
            "triage_record_updated",
            {
              ulid: record._ulid,
              action: "override",
              new_action: record.action,
            },
            projectContext.path,
          );

          return {
            success: true,
            record,
          };
        },
        {
          params: t.Object({
            ref: t.String(),
          }),
          body: t.Object({
            action: enumUnion(TriageActionSchema.options),
            reasoning: t.String(),
            override_by: t.Optional(t.String()),
          }),
        },
      )

      // AC: @triage-daemon-api ac-5, ac-8, ac-9 - Execute a triage action
      // AC: @trait-api-endpoint ac-1, ac-5 - JSON response, shadow commit
      .post(
        "/:ref/act",
        async ({ params, error: errorResponse, projectContext }) => {
          // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
          const ctx = await initContext(projectContext.path);
          const records = await loadTriageRecords(ctx);

          // AC: @trait-api-endpoint ac-2 - Resolve ref
          const record = findTriageRecordByRef(records, params.ref);
          if (!record) {
            return errorResponse(404, {
              error: "not_found",
              message: `Triage record reference "${params.ref}" not found`,
              suggestion:
                "Use kspec triage list or GET /api/triage to find valid triage record references",
            });
          }

          // AC: @triage-daemon-api ac-8 - Already acted on → 409
          if (record.status === "acted_on") {
            return errorResponse(409, {
              error: "invalid_transition",
              message: "Triage record has already been acted on",
              current: record.status,
              suggestion: "Use override to change the decision before acting again",
            });
          }

          // AC: @triage-daemon-api ac-9 - Pending (no decision) → 422
          if (record.status === "pending") {
            return errorResponse(422, {
              error: "incomplete_record",
              message:
                "No decision has been recorded for this triage record. Complete triage first.",
              suggestion:
                "Use POST /api/triage to record a decision, or kspec triage record <inbox-ref> --action <action> --reasoning <text>",
            });
          }

          // AC: @triage-daemon-api ac-5 - Execute the action
          // AC: @api-contract ac-task-storage-incompatibility-* — promote actions
          // call resolveTaskDataManager(ctx).createTask(); surface the deterministic
          // storage error as a structured 409 instead of a 500.
          let result: Awaited<ReturnType<typeof executeTriageAction>>;
          try {
            result = await executeTriageAction(record, ctx);
          } catch (err) {
            const actCacheForError = getEntityCache?.(projectContext.path);
            const conflict = taskStorageIncompatibilityResponse(err, { cache: actCacheForError });
            if (conflict) return errorResponse(conflict.status, conflict.body);
            throw err;
          }

          // Transition to acted_on
          record.status = "acted_on";
          record.acted_at = new Date().toISOString();
          if (result.resultRef) {
            record.result_ref = result.resultRef;
          }
          record.updated_at = new Date().toISOString();

          await saveTriageRecord(ctx, record);

          // AC: @trait-api-endpoint ac-5 - Shadow commit
          await commitIfShadow(ctx.shadow, `triage: act ${record._ulid.slice(0, 8)}`);

          // AC: @daemon-entity-cache ac-write-through — update cache before response
          // executeTriageAction performs cross-domain mutations depending on action:
          //   promote → creates task + deletes inbox item
          //   delete/duplicate → deletes inbox item
          //   spec-gap → saves observation (meta domain)
          const actCache = getEntityCache?.(projectContext.path);
          if (actCache) {
            await actCache.writeThrough("triage");
            const action = record.action;
            if (action === "promote") {
              const createdTask = result.resultRef
                ? await resolveTaskDataManager(ctx)
                    .getTask(ctx, result.resultRef)
                    .catch(() => undefined)
                : undefined;
              await actCache.writeThrough(
                "tasks",
                createdTask ? { ulid: createdTask._ulid } : undefined,
              );
              await actCache.writeThrough("inbox");
            } else if (action === "delete" || action === "duplicate") {
              await actCache.writeThrough("inbox");
            } else if (action === "spec-gap") {
              await actCache.writeThrough("meta");
            }
          }

          // AC: @triage-daemon-api ac-5 - Broadcast triage:updates
          pubsub.broadcast(
            "triage:updates",
            "triage_record_acted",
            {
              ulid: record._ulid,
              action: record.action,
              result_ref: record.result_ref,
            },
            projectContext.path,
          );

          return {
            success: true,
            record,
          };
        },
        {
          params: t.Object({
            ref: t.String(),
          }),
        },
      )
  );
}
