/**
 * Tests for Triage API endpoints
 *
 * Verifies triage routes are properly structured and integrated.
 * Uses static analysis pattern matching existing daemon API tests.
 *
 * AC Coverage:
 * - @triage-daemon-api ac-1: GET /api/triage returns items sorted by created_at desc
 * - @triage-daemon-api ac-2: Status filter on GET list
 * - @triage-daemon-api ac-3: POST creates record with item_snapshot and broadcasts
 * - @triage-daemon-api ac-4: Override sets override fields and broadcasts
 * - @triage-daemon-api ac-5: Act executes action, transitions to acted_on, broadcasts
 * - @triage-daemon-api ac-6: GET /api/triage/export with format parameter
 * - @triage-daemon-api ac-7: POST 404 for nonexistent inbox item
 * - @triage-daemon-api ac-8: Act 409 for already acted_on record
 * - @triage-daemon-api ac-9: Act 422 for pending record (no decision)
 *
 * Trait AC Coverage:
 * - @trait-api-endpoint ac-1: 2xx with JSON body
 * - @trait-api-endpoint ac-2: 404 with error/message/suggestion
 * - @trait-api-endpoint ac-3: 400 with validation error details
 * - @trait-api-endpoint ac-4: Pagination with limit/offset
 * - @trait-api-endpoint ac-5: Shadow commit on mutations
 * - @trait-websocket-protocol ac-3: Broadcast events on changes
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';

const ROUTES_PATH = join(process.cwd(), 'packages/daemon/src/routes/triage.ts');
const SERVER_PATH = join(process.cwd(), 'packages/daemon/src/server.ts');

describe('Triage API Endpoints', () => {
  // AC: @triage-daemon-api ac-1
  it('should have GET /api/triage route with created_at desc ordering', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // Route definition
    expect(content).toContain("prefix: '/api/triage'");
    expect(content).toContain(".get(");
    expect(content).toContain("'/'");

    // AC: @triage-daemon-api ac-1 - Sort by created_at descending
    expect(content).toContain('created_at');
    expect(content).toContain('.sort(');

    // Returns items with total
    expect(content).toContain('items:');
    expect(content).toContain('total');
  });

  // AC: @triage-daemon-api ac-2
  it('should support status filter on GET list', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // AC: @triage-daemon-api ac-2 - Status filter
    expect(content).toContain('query.status');
    expect(content).toContain('statusFilters');
    expect(content).toContain('.filter(');
  });

  // AC: @triage-daemon-api ac-3
  it('should have POST /api/triage route that creates record with snapshot', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // Route definition
    expect(content).toContain('.post(');

    // AC: @triage-daemon-api ac-3 - Create record with item_snapshot
    expect(content).toContain('item_snapshot: inboxItem.text');
    expect(content).toContain('saveTriageRecord');
    expect(content).toContain('commitIfShadow');

    // AC: @triage-daemon-api ac-3 - Broadcast via WebSocket
    expect(content).toContain("'triage:updates'");
    expect(content).toContain("'triage_record_created'");

    // Body schema
    expect(content).toContain('inbox_ref: t.String()');
    expect(content).toContain('action: t.String()');
    expect(content).toContain('reasoning: t.String()');
  });

  // AC: @triage-daemon-api ac-4
  it('should have POST /:ref/override route that sets override fields', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // Route definition
    expect(content).toContain("'/:ref/override'");

    // AC: @triage-daemon-api ac-4 - Set override fields
    expect(content).toContain('override_reasoning');
    expect(content).toContain('override_by');
    expect(content).toContain('override_at');

    // AC: @triage-daemon-api ac-4 - Update action
    expect(content).toContain('record.action = body.action');

    // AC: @triage-daemon-api ac-4 - Broadcast
    expect(content).toContain("'triage_record_updated'");

    // Shadow commit
    expect(content).toContain("triage: override");
  });

  // AC: @triage-daemon-api ac-5
  it('should have POST /:ref/act route that executes and transitions', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // Route definition
    expect(content).toContain("'/:ref/act'");

    // AC: @triage-daemon-api ac-5 - Execute action
    expect(content).toContain('executeTriageAction');

    // AC: @triage-daemon-api ac-5 - Transition to acted_on
    expect(content).toContain("record.status = 'acted_on'");
    expect(content).toContain('record.acted_at');
    expect(content).toContain('record.result_ref');

    // AC: @triage-daemon-api ac-5 - Broadcast
    expect(content).toContain("'triage_record_acted'");

    // Shadow commit
    expect(content).toContain("triage: act");
  });

  // AC: @triage-daemon-api ac-6
  it('should have GET /api/triage/export with format parameter', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // Route definition
    expect(content).toContain("'/export'");

    // AC: @triage-daemon-api ac-6 - Format parameter
    expect(content).toContain('query.format');

    // AC: @triage-daemon-api ac-6 - Context markdown format
    expect(content).toContain("format === 'context'");
    expect(content).toContain('formatTriageContext');

    // AC: @triage-daemon-api ac-6 - JSON format
    expect(content).toContain("format: 'json'");
  });

  // AC: @triage-daemon-api ac-7
  it('should return 404 for nonexistent inbox item on POST', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // AC: @triage-daemon-api ac-7 - Validate inbox item exists
    expect(content).toContain('findInboxItemByRef');
    expect(content).toContain('!inboxItem');
    expect(content).toContain('errorResponse(404');
    expect(content).toContain('not_found');
    expect(content).toContain('suggestion');
  });

  // AC: @triage-daemon-api ac-8
  it('should return 409 for act on already acted_on record', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // AC: @triage-daemon-api ac-8 - Already acted on → 409
    expect(content).toContain("record.status === 'acted_on'");
    expect(content).toContain('errorResponse(409');
    expect(content).toContain('invalid_transition');
    expect(content).toContain('already been acted on');
  });

  // AC: @triage-daemon-api ac-9
  it('should return 422 for act on pending record', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // AC: @triage-daemon-api ac-9 - Pending → 422
    expect(content).toContain("record.status === 'pending'");
    expect(content).toContain('errorResponse(422');
    expect(content).toContain('incomplete_record');
    expect(content).toContain('Complete triage first');
  });

  // Trait: @trait-api-endpoint ac-1
  it('should return JSON responses for successful operations', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // AC: @trait-api-endpoint ac-1 - Success returns JSON
    expect(content).toContain('success: true');
    expect(content).toContain('record');
  });

  // Trait: @trait-api-endpoint ac-2
  it('should return 404 with error/message/suggestion for invalid refs', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // AC: @trait-api-endpoint ac-2 - 404 structure
    expect(content).toContain("error: 'not_found'");
    expect(content).toContain('message:');
    expect(content).toContain('suggestion:');
  });

  // Trait: @trait-api-endpoint ac-3
  it('should return 400 with validation error details for invalid body', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // AC: @trait-api-endpoint ac-3 - Validation error structure
    expect(content).toContain('errorResponse(400');
    expect(content).toContain("error: 'validation_error'");
    expect(content).toContain('details:');
    expect(content).toContain('field:');
    expect(content).toContain('message:');
  });

  // Trait: @trait-api-endpoint ac-4
  it('should support pagination with limit and offset', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // AC: @trait-api-endpoint ac-4 - Pagination wrapper
    expect(content).toContain('query.limit');
    expect(content).toContain('query.offset');
    expect(content).toContain('offset,');
    expect(content).toContain('limit,');
    expect(content).toContain('.slice(offset, offset + limit)');
  });

  // Trait: @trait-api-endpoint ac-5
  it('should create shadow commits for all mutations', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // AC: @trait-api-endpoint ac-5 - Shadow commit on mutations
    // Count commitIfShadow calls — should appear for record, override, and act
    const commitCalls = (content.match(/commitIfShadow/g) || []).length;
    expect(commitCalls).toBeGreaterThanOrEqual(3);

    expect(content).toContain("triage: record");
    expect(content).toContain("triage: override");
    expect(content).toContain("triage: act");
  });

  // Trait: @trait-websocket-protocol ac-3
  it('should broadcast events via pubsub for all mutations', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // AC: @trait-websocket-protocol ac-3 - Broadcast events
    const broadcastCalls = (content.match(/pubsub\.broadcast/g) || []).length;
    expect(broadcastCalls).toBeGreaterThanOrEqual(3);

    // All broadcasts scoped to project
    expect(content).toContain('projectContext.path');
  });

  it('should use project context from middleware (not hardcoded kspecDir)', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // AC: @multi-directory-daemon ac-1, ac-24 - Project context from middleware
    expect(content).toContain('projectContext');
    expect(content).toContain('projectContext.path');
    expect(content).toContain('initContext(projectContext.path)');

    // Should NOT have hardcoded kspecDir
    expect(content).not.toContain('const ctx = await initContext(kspecDir)');
  });

  it('should be integrated into main server', async () => {
    const serverContent = await readFile(SERVER_PATH, 'utf-8');

    // Check import
    expect(serverContent).toContain("import { createTriageRoutes } from './routes/triage'");

    // Check usage
    expect(serverContent).toContain('createTriageRoutes');
    expect(serverContent).toContain('pubsubManager');
  });

  it('should use proper TypeScript types from parser', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // Check imports from parser
    expect(content).toContain("from '../../parser/index.js'");
    expect(content).toContain('initContext');
    expect(content).toContain('loadTriageRecords');
    expect(content).toContain('saveTriageRecord');
    expect(content).toContain('findTriageRecordByRef');
    expect(content).toContain('loadInboxItems');
    expect(content).toContain('findInboxItemByRef');
    expect(content).toContain('LoadedTriageRecord');
  });

  it('should validate body parameters with Elysia schema', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // Body schema validation for POST /api/triage
    expect(content).toContain('body: t.Object({');
    expect(content).toContain('inbox_ref: t.String()');
    expect(content).toContain('action: t.String()');
    expect(content).toContain('reasoning: t.String()');
    expect(content).toContain('t.Optional');
  });

  it('should define export route before /:ref to avoid route conflicts', async () => {
    const content = await readFile(ROUTES_PATH, 'utf-8');

    // Export route must come before /:ref to prevent "export" being parsed as ref
    const exportIndex = content.indexOf("'/export'");
    const refIndex = content.indexOf("'/:ref'");
    expect(exportIndex).toBeGreaterThan(-1);
    expect(refIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(refIndex);
  });

  describe('Action execution', () => {
    it('should implement executeTriageAction for all 5 action types', async () => {
      const content = await readFile(ROUTES_PATH, 'utf-8');

      // AC: @triage-daemon-api ac-5 - All action types handled
      expect(content).toContain("case 'promote':");
      expect(content).toContain("case 'delete':");
      expect(content).toContain("case 'defer':");
      expect(content).toContain("case 'spec-gap':");
      expect(content).toContain("case 'duplicate':");

      // Promote creates task
      expect(content).toContain('createTask');
      expect(content).toContain('saveTask');

      // Delete/duplicate removes inbox item
      expect(content).toContain('deleteInboxItem');

      // Spec-gap creates observation
      expect(content).toContain('createObservation');
      expect(content).toContain('saveObservation');
    });
  });

  describe('Export format', () => {
    it('should support context markdown format with structured output', async () => {
      const content = await readFile(ROUTES_PATH, 'utf-8');

      // AC: @triage-daemon-api ac-6 - Context format
      expect(content).toContain('formatTriageContext');
      expect(content).toContain('**Item:**');
      expect(content).toContain('**Status:**');
      expect(content).toContain('**Action:**');
      expect(content).toContain('**Reasoning:**');
      expect(content).toContain('**Decided by:**');
    });

    it('should handle empty records in export', async () => {
      const content = await readFile(ROUTES_PATH, 'utf-8');

      // AC: @triage-daemon-api ac-6 - Empty case
      expect(content).toContain('records.length === 0');
      expect(content).toContain('No triage decisions recorded');
    });
  });

  describe('Override edge cases', () => {
    it('should re-triage acted_on records on override', async () => {
      const content = await readFile(ROUTES_PATH, 'utf-8');

      // Override resets acted_on to triaged for re-acting
      expect(content).toContain("record.status === 'acted_on'");
      expect(content).toContain("record.status = 'triaged'");
    });
  });
});
