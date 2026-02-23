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
 * - @triage-daemon-api ac-4: PUT override sets override fields
 * - @triage-daemon-api ac-5: PUT act executes and transitions
 * - @triage-daemon-api ac-6: GET export with format parameter
 * - @triage-daemon-api ac-7: POST 404 for nonexistent inbox item
 * - @triage-daemon-api ac-8: PUT act 409 for already acted
 * - @triage-daemon-api ac-9: PUT act 422 for pending record
 */

import { Elysia, t } from 'elysia';
import { ulid } from 'ulidx';
import {
  initContext,
  loadTriageRecords,
  saveTriageRecord,
  findTriageRecordByRef,
  findTriageRecordByInboxRef,
  loadInboxItems,
  findInboxItemByRef,
  loadAllTasks,
  loadAllItems,
  ReferenceIndex,
  getAuthor,
  createObservation,
  saveObservation,
  createTask,
  saveTask,
  deleteInboxItem,
  type LoadedTriageRecord,
} from '../../parser/index.js';
import { commitIfShadow } from '../../parser/shadow.js';
import type { TriageAction } from '../../schema/index.js';
import type { PubSubManager } from '../websocket/pubsub';

interface TriageRouteOptions {
  pubsub: PubSubManager;
}

const VALID_ACTIONS = ['promote', 'delete', 'defer', 'spec-gap', 'duplicate'];

/**
 * Truncate text for display
 */
function truncateText(text: string, maxLen: number = 60): string {
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length <= maxLen) return firstLine;
  return `${firstLine.slice(0, maxLen - 3)}...`;
}

/**
 * Format a triage record for context export
 * AC: @triage-daemon-api ac-6
 */
function formatTriageContext(record: LoadedTriageRecord): string {
  const lines: string[] = [];
  lines.push(`### ${record._ulid.slice(0, 8)} — ${truncateText(record.item_snapshot, 80)}`);
  lines.push('');
  lines.push(`**Item:** ${record.item_snapshot}`);
  lines.push(`**Status:** ${record.status}`);
  if (record.action) lines.push(`**Action:** ${record.action}`);
  if (record.reasoning) lines.push(`**Reasoning:** ${record.reasoning}`);
  if (record.decided_by) lines.push(`**Decided by:** ${record.decided_by}`);
  if (record.evidence_refs.length > 0) {
    lines.push(`**Evidence:** ${record.evidence_refs.join(', ')}`);
  }
  if (record.override_reasoning) {
    lines.push(`**Override:** ${record.override_reasoning} (by ${record.override_by || 'unknown'})`);
  }
  if (record.acted_at) {
    lines.push(`**Acted at:** ${record.acted_at}`);
    if (record.result_ref) lines.push(`**Result:** ${record.result_ref}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Execute a triage action (reused from CLI logic)
 * AC: @triage-daemon-api ac-5
 */
async function executeTriageAction(
  record: LoadedTriageRecord,
  ctx: Awaited<ReturnType<typeof initContext>>,
): Promise<{ resultRef?: string }> {
  const action = record.action;
  if (!action) return {};

  switch (action) {
    case 'promote': {
      const task = createTask({
        title: record.item_snapshot.split('\n')[0].slice(0, 100),
        type: 'task',
        priority: 3,
        spec_ref: null,
        tags: [],
        description: record.item_snapshot,
      });
      await saveTask(ctx, task);
      const tasks = await loadAllTasks(ctx);
      const items = await loadAllItems(ctx);
      const index = new ReferenceIndex(tasks, items);
      const taskRef = `@${index.shortUlid(task._ulid)}`;
      return { resultRef: taskRef };
    }

    case 'delete':
    case 'duplicate': {
      const inboxItems = await loadInboxItems(ctx);
      const inboxItem = findInboxItemByRef(inboxItems, record.inbox_ref);
      if (inboxItem) {
        await deleteInboxItem(ctx, inboxItem._ulid);
      }
      return {};
    }

    case 'defer': {
      return {};
    }

    case 'spec-gap': {
      const content = `[spec-gap] ${record.item_snapshot}\n\nReasoning: ${record.reasoning || ''}`;
      const observation = createObservation('question', content, {
        configAuthor: ctx.config?.identity?.author,
      });
      await saveObservation(ctx, observation);
      const obsRef = `@${observation._ulid.slice(0, 8)}`;
      return { resultRef: obsRef };
    }

    default:
      return {};
  }
}

export function createTriageRoutes(options: TriageRouteOptions) {
  const { pubsub } = options;

  return new Elysia({ prefix: '/api/triage' })
    // AC: @triage-daemon-api ac-1, ac-2 - List triage records with filters and pagination
    // AC: @trait-api-endpoint ac-1, ac-4 - JSON response with pagination wrapper
    .get(
      '/',
      async ({ query, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const ctx = await initContext(projectContext.path);
        const records = await loadTriageRecords(ctx);

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
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );

        // AC: @trait-api-endpoint ac-4 - Pagination with limit and offset
        const total = filtered.length;
        const offset = Number(query.offset) || 0;
        const limit = Number(query.limit) || total;

        const paginated = filtered.slice(offset, offset + limit);

        return {
          items: paginated,
          total,
          offset,
          limit,
        };
      },
      {
        query: t.Object({
          status: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          action: t.Optional(t.Union([t.String(), t.Array(t.String())])),
          limit: t.Optional(t.String()),
          offset: t.Optional(t.String()),
        }),
      }
    )

    // AC: @triage-daemon-api ac-6 - Export triage records
    // NOTE: This route MUST be defined before /:ref to avoid "export" being parsed as a ref
    .get(
      '/export',
      async ({ query, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const ctx = await initContext(projectContext.path);
        let records = await loadTriageRecords(ctx);

        // Optional status filter on export
        if (query.status) {
          const statusFilters = Array.isArray(query.status) ? query.status : [query.status];
          records = records.filter((r) => statusFilters.includes(r.status));
        }

        const format = query.format || 'json';

        if (format === 'context') {
          // AC: @triage-daemon-api ac-6 - Context markdown format
          if (records.length === 0) {
            return { format: 'context', content: 'No triage decisions recorded.' };
          }
          let content = '# Triage Decisions\n\n';
          for (const record of records) {
            content += formatTriageContext(record);
          }
          return { format: 'context', content };
        }

        // AC: @triage-daemon-api ac-6 - JSON format (default)
        return {
          format: 'json',
          items: records,
          total: records.length,
        };
      },
      {
        query: t.Object({
          format: t.Optional(t.String()),
          status: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        }),
      }
    )

    // AC: @triage-daemon-api ac-3 - Record a triage decision
    // AC: @trait-api-endpoint ac-1, ac-3, ac-5 - JSON response, validation, shadow commit
    .post(
      '/',
      async ({ body, error: errorResponse, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const ctx = await initContext(projectContext.path);

        // AC: @trait-api-endpoint ac-3 - Validate action
        if (!VALID_ACTIONS.includes(body.action)) {
          return errorResponse(400, {
            error: 'validation_error',
            details: [
              {
                field: 'action',
                message: `Action must be one of: ${VALID_ACTIONS.join(', ')}`,
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
            error: 'not_found',
            message: `Inbox item reference "${body.inbox_ref}" not found`,
            suggestion: 'Use kspec inbox list or GET /api/inbox to find valid inbox item references',
          });
        }

        const author = body.decided_by || getAuthor(ctx.config?.identity?.author);
        const evidenceRefs = body.evidence_refs
          ? body.evidence_refs.map((r: string) => r.startsWith('@') ? r : `@${r}`)
          : [];

        // Check if a record already exists for this inbox item (upsert case)
        const existingRecords = await loadTriageRecords(ctx);
        const existing = findTriageRecordByInboxRef(existingRecords, inboxItem._ulid);

        // AC: @triage-daemon-api ac-3 - Create record with item_snapshot
        const record: LoadedTriageRecord = {
          _ulid: existing?._ulid || ulid(),
          inbox_ref: inboxItem._ulid,
          item_snapshot: inboxItem.text,
          status: 'triaged',
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
        await commitIfShadow(ctx.shadow, `triage: record ${savedRecord._ulid.slice(0, 8)} as ${savedRecord.action}`);

        // AC: @triage-daemon-api ac-3 - Broadcast triage:updates via WebSocket
        // AC: @trait-websocket-protocol ac-3 - Broadcast event
        pubsub.broadcast('triage:updates', 'triage_record_created', {
          ulid: savedRecord._ulid,
          inbox_ref: savedRecord.inbox_ref,
          action: savedRecord.action,
        }, projectContext.path);

        // AC: @trait-api-endpoint ac-1 - Return 2xx with JSON body
        return {
          success: true,
          record: savedRecord,
        };
      },
      {
        body: t.Object({
          inbox_ref: t.String(),
          action: t.String(),
          reasoning: t.String(),
          decided_by: t.Optional(t.String()),
          evidence_refs: t.Optional(t.Array(t.String())),
        }),
      }
    )

    // GET single triage record
    .get(
      '/:ref',
      async ({ params, error: errorResponse, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const ctx = await initContext(projectContext.path);
        const records = await loadTriageRecords(ctx);

        // AC: @trait-api-endpoint ac-2 - Resolve ref
        const record = findTriageRecordByRef(records, params.ref);
        if (!record) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Triage record reference "${params.ref}" not found`,
            suggestion: 'Use kspec triage list or GET /api/triage to find valid triage record references',
          });
        }

        return record;
      },
      {
        params: t.Object({
          ref: t.String(),
        }),
      }
    )

    // AC: @triage-daemon-api ac-4 - Override a triage decision
    // AC: @trait-api-endpoint ac-1, ac-5 - JSON response, shadow commit
    .post(
      '/:ref/override',
      async ({ params, body, error: errorResponse, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const ctx = await initContext(projectContext.path);
        const records = await loadTriageRecords(ctx);

        // AC: @trait-api-endpoint ac-2 - Resolve ref
        const record = findTriageRecordByRef(records, params.ref);
        if (!record) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Triage record reference "${params.ref}" not found`,
            suggestion: 'Use kspec triage list or GET /api/triage to find valid triage record references',
          });
        }

        // AC: @trait-api-endpoint ac-3 - Validate action
        if (!VALID_ACTIONS.includes(body.action)) {
          return errorResponse(400, {
            error: 'validation_error',
            details: [
              {
                field: 'action',
                message: `Action must be one of: ${VALID_ACTIONS.join(', ')}`,
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
        if (record.status === 'acted_on') {
          record.status = 'triaged';
          record.acted_at = undefined;
          record.result_ref = undefined;
        }

        await saveTriageRecord(ctx, record);

        // AC: @trait-api-endpoint ac-5 - Shadow commit
        await commitIfShadow(ctx.shadow, `triage: override ${record._ulid.slice(0, 8)}`);

        // AC: @triage-daemon-api ac-4 - Broadcast triage:updates
        pubsub.broadcast('triage:updates', 'triage_record_updated', {
          ulid: record._ulid,
          action: 'override',
          new_action: record.action,
        }, projectContext.path);

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
          action: t.String(),
          reasoning: t.String(),
          override_by: t.Optional(t.String()),
        }),
      }
    )

    // AC: @triage-daemon-api ac-5, ac-8, ac-9 - Execute a triage action
    // AC: @trait-api-endpoint ac-1, ac-5 - JSON response, shadow commit
    .post(
      '/:ref/act',
      async ({ params, error: errorResponse, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const ctx = await initContext(projectContext.path);
        const records = await loadTriageRecords(ctx);

        // AC: @trait-api-endpoint ac-2 - Resolve ref
        const record = findTriageRecordByRef(records, params.ref);
        if (!record) {
          return errorResponse(404, {
            error: 'not_found',
            message: `Triage record reference "${params.ref}" not found`,
            suggestion: 'Use kspec triage list or GET /api/triage to find valid triage record references',
          });
        }

        // AC: @triage-daemon-api ac-8 - Already acted on → 409
        if (record.status === 'acted_on') {
          return errorResponse(409, {
            error: 'invalid_transition',
            message: 'Triage record has already been acted on',
            current: record.status,
            suggestion: 'Use override to change the decision before acting again',
          });
        }

        // AC: @triage-daemon-api ac-9 - Pending (no decision) → 422
        if (record.status === 'pending') {
          return errorResponse(422, {
            error: 'incomplete_record',
            message: 'No decision has been recorded for this triage record. Complete triage first.',
            suggestion: 'Use POST /api/triage to record a decision, or kspec triage record <inbox-ref> --action <action> --reasoning <text>',
          });
        }

        // AC: @triage-daemon-api ac-5 - Execute the action
        const result = await executeTriageAction(record, ctx);

        // Transition to acted_on
        record.status = 'acted_on';
        record.acted_at = new Date().toISOString();
        if (result.resultRef) {
          record.result_ref = result.resultRef;
        }
        record.updated_at = new Date().toISOString();

        await saveTriageRecord(ctx, record);

        // AC: @trait-api-endpoint ac-5 - Shadow commit
        await commitIfShadow(ctx.shadow, `triage: act ${record._ulid.slice(0, 8)}`);

        // AC: @triage-daemon-api ac-5 - Broadcast triage:updates
        pubsub.broadcast('triage:updates', 'triage_record_acted', {
          ulid: record._ulid,
          action: record.action,
          result_ref: record.result_ref,
        }, projectContext.path);

        return {
          success: true,
          record,
        };
      },
      {
        params: t.Object({
          ref: t.String(),
        }),
      }
    );
}
