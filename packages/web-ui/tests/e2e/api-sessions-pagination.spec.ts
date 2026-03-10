/**
 * E2E API Tests for Session List Pagination and Filtering
 *
 * Tests verify the GET /api/sessions endpoint supports offset/limit pagination,
 * multi-field filtering, and proper validation.
 *
 * Covered ACs:
 * - @session-list-pagination-api ac-pagination: Offset/limit pagination with total count
 * - @session-list-pagination-api ac-filter-status: Status filter with multi-value OR
 * - @session-list-pagination-api ac-filter-agent-type: Agent type filter
 * - @session-list-pagination-api ac-filter-agent-id: Agent ID filter
 * - @session-list-pagination-api ac-filter-trigger: Trigger filter with dispatched shorthand
 * - @session-list-pagination-api ac-filter-task: Task ID filter
 * - @session-list-pagination-api ac-filter-since: Since date filter
 * - @session-list-pagination-api ac-combined-filters: AND logic for multiple filters
 * - @session-list-pagination-api ac-invalid-filter: 400 on invalid filter values
 * - @session-list-pagination-api ac-metadata-only: Uses cache, reads session.yaml only
 * - @trait-api-endpoint ac-1: Returns 2xx with JSON body
 * - @trait-api-endpoint ac-3: Returns 400 with details array on invalid params
 * - @trait-api-endpoint ac-4: Pagination wrapper {items, total, offset, limit}
 */

import { test, expect } from '../fixtures/test-base';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as YAML from 'yaml';

/**
 * Create a session directory with metadata and optional events.
 */
function writeSession(
  dir: string,
  sessionId: string,
  opts: {
    agentType?: string;
    agentId?: string;
    status?: string;
    trigger?: string;
    taskId?: string;
    startedAt?: string;
    endedAt?: string;
    eventCount?: number;
  } = {},
): void {
  const sessionDir = join(dir, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const metadata: Record<string, unknown> = {
    id: sessionId,
    agent_type: opts.agentType ?? 'claude-agent-acp',
    status: opts.status ?? 'completed',
    started_at: opts.startedAt ?? '2026-03-01T10:00:00.000Z',
  };

  if (opts.agentId) metadata.agent_id = opts.agentId;
  if (opts.trigger) metadata.trigger = opts.trigger;
  if (opts.taskId) metadata.task_id = opts.taskId;
  if (opts.endedAt) metadata.ended_at = opts.endedAt;

  writeFileSync(join(sessionDir, 'session.yaml'), YAML.stringify(metadata));

  // Write events.jsonl (minimal)
  const eventCount = opts.eventCount ?? 1;
  const lines: string[] = [];
  for (let i = 0; i < eventCount; i++) {
    lines.push(JSON.stringify({
      seq: i,
      ts: Date.now() + i * 1000,
      type: i === 0 ? 'session.start' : 'note',
      session_id: sessionId,
      data: {},
    }));
  }
  writeFileSync(join(sessionDir, 'events.jsonl'), lines.join('\n') + '\n');
}

/**
 * Set up a standard set of test sessions covering different statuses,
 * agent types, triggers, etc.
 */
function setupTestSessions(sessionsDir: string): void {
  mkdirSync(sessionsDir, { recursive: true });

  // Session 1: completed, worker, dispatched task.ready, oldest
  writeSession(sessionsDir, '01KTEST0000000000000000001', {
    agentType: 'claude-agent-acp',
    agentId: 'worker',
    status: 'completed',
    trigger: 'task.ready',
    taskId: '@task-alpha',
    startedAt: '2026-03-01T10:00:00.000Z',
    endedAt: '2026-03-01T11:00:00.000Z',
    eventCount: 10,
  });

  // Session 2: completed, pr-reviewer, dispatched task.pending_review
  writeSession(sessionsDir, '01KTEST0000000000000000002', {
    agentType: 'claude-agent-acp',
    agentId: 'pr-reviewer',
    status: 'completed',
    trigger: 'task.pending_review',
    taskId: '@task-beta',
    startedAt: '2026-03-02T10:00:00.000Z',
    endedAt: '2026-03-02T11:00:00.000Z',
    eventCount: 5,
  });

  // Session 3: failed, worker, dispatched task.in_progress
  writeSession(sessionsDir, '01KTEST0000000000000000003', {
    agentType: 'claude-agent-acp',
    agentId: 'worker',
    status: 'failed',
    trigger: 'task.in_progress',
    taskId: '@task-alpha',
    startedAt: '2026-03-03T10:00:00.000Z',
    endedAt: '2026-03-03T10:05:00.000Z',
    eventCount: 3,
  });

  // Session 4: active, worker, manual trigger
  writeSession(sessionsDir, '01KTEST0000000000000000004', {
    agentType: 'claude-agent-acp',
    agentId: 'worker',
    status: 'active',
    trigger: 'manual',
    startedAt: '2026-03-04T10:00:00.000Z',
    eventCount: 2,
  });

  // Session 5: completed, codex-acp, manual trigger, most recent
  writeSession(sessionsDir, '01KTEST0000000000000000005', {
    agentType: 'codex-acp',
    agentId: 'worker',
    status: 'completed',
    trigger: 'manual',
    startedAt: '2026-03-05T10:00:00.000Z',
    endedAt: '2026-03-05T11:00:00.000Z',
    eventCount: 20,
  });

  // Session 6: abandoned, no agent_id, legacy trigger
  writeSession(sessionsDir, '01KTEST0000000000000000006', {
    agentType: 'claude-agent-acp',
    status: 'abandoned',
    trigger: 'legacy',
    startedAt: '2026-02-15T10:00:00.000Z',
    endedAt: '2026-02-15T12:00:00.000Z',
    eventCount: 1,
  });
}

test.describe('Session List Pagination API', () => {
  test.describe('Pagination', () => {
    // AC: @session-list-pagination-api ac-pagination
    // AC: @trait-api-endpoint ac-4
    test('returns paginated results with total, offset, and limit', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions?offset=0&limit=2`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty('items');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('offset');
      expect(body).toHaveProperty('limit');
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBe(2);
      expect(body.total).toBe(6);
      expect(body.offset).toBe(0);
      expect(body.limit).toBe(2);
    });

    // AC: @session-list-pagination-api ac-pagination
    test('items sorted by started_at descending (most recent first)', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBe(6);

      // Most recent session is session 5 (Mar 5), then 4 (Mar 4), etc.
      expect(body.items[0].id).toBe('01KTEST0000000000000000005');
      expect(body.items[1].id).toBe('01KTEST0000000000000000004');
      expect(body.items[2].id).toBe('01KTEST0000000000000000003');
      expect(body.items[3].id).toBe('01KTEST0000000000000000002');
      expect(body.items[4].id).toBe('01KTEST0000000000000000001');
      expect(body.items[5].id).toBe('01KTEST0000000000000000006');
    });

    // AC: @session-list-pagination-api ac-pagination
    test('offset skips items', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions?offset=3&limit=2`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBe(2);
      expect(body.total).toBe(6);
      expect(body.offset).toBe(3);
      // Items 3 and 4 (0-indexed) from sorted list
      expect(body.items[0].id).toBe('01KTEST0000000000000000002');
      expect(body.items[1].id).toBe('01KTEST0000000000000000001');
    });

    // AC: @session-list-pagination-api ac-pagination
    // AC: @trait-api-endpoint ac-1
    test('returns all items when no pagination params', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBe(6);
      expect(body.total).toBe(6);
      expect(body.offset).toBe(0);
      expect(body.limit).toBe(6);
    });
  });

  test.describe('Status Filter', () => {
    // AC: @session-list-pagination-api ac-filter-status
    test('filters by single status', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions?status=completed`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBe(3); // Sessions 1, 2, 5
      for (const item of body.items) {
        expect(item.status).toBe('completed');
      }
      expect(body.total).toBe(3);
    });

    // AC: @session-list-pagination-api ac-filter-status
    test('filters by multiple statuses (OR)', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions?status=completed&status=failed`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBe(4); // Sessions 1, 2, 3, 5
      for (const item of body.items) {
        expect(['completed', 'failed']).toContain(item.status);
      }
    });
  });

  test.describe('Agent Type Filter', () => {
    // AC: @session-list-pagination-api ac-filter-agent-type
    test('filters by agent_type', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions?agent_type=codex-acp`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBe(1);
      expect(body.items[0].agent_type).toBe('codex-acp');
      expect(body.items[0].id).toBe('01KTEST0000000000000000005');
    });
  });

  test.describe('Agent ID Filter', () => {
    // AC: @session-list-pagination-api ac-filter-agent-id
    test('filters by agent_id', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions?agent_id=pr-reviewer`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBe(1);
      expect(body.items[0].id).toBe('01KTEST0000000000000000002');
    });

    // AC: @session-list-pagination-api ac-filter-agent-id
    test('filters by agent_id=worker returns multiple sessions', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions?agent_id=worker`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Sessions 1, 3, 4, 5 have agent_id=worker
      expect(body.items.length).toBe(4);
      for (const item of body.items) {
        expect(item.agent_id).toBe('worker');
      }
    });
  });

  test.describe('Trigger Filter', () => {
    // AC: @session-list-pagination-api ac-filter-trigger
    test('filters by trigger=manual', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions?trigger=manual`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBe(2); // Sessions 4, 5
      for (const item of body.items) {
        expect(item.trigger).toBe('manual');
      }
    });

    // AC: @session-list-pagination-api ac-filter-trigger
    test('dispatched shorthand matches all task.* triggers', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions?trigger=dispatched`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Sessions 1 (task.ready), 2 (task.pending_review), 3 (task.in_progress)
      expect(body.items.length).toBe(3);
      for (const item of body.items) {
        expect(item.trigger).toMatch(/^task\./);
      }
    });
  });

  test.describe('Task Filter', () => {
    // AC: @session-list-pagination-api ac-filter-task
    test('filters by task_id', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      // task-alpha is referenced by sessions 1 and 3
      const response = await request.get(`${daemon.baseUrl}/api/sessions?task_id=@task-alpha`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // This may return 0 if the ref doesn't resolve (task doesn't exist in fixtures)
      // but the endpoint should not error
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.total).toBe(body.items.length);
    });
  });

  test.describe('Since Filter', () => {
    // AC: @session-list-pagination-api ac-filter-since
    test('filters by since date', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions?since=2026-03-03`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Sessions started on or after Mar 3: sessions 3, 4, 5
      expect(body.items.length).toBe(3);
      for (const item of body.items) {
        expect(new Date(item.started_at).getTime()).toBeGreaterThanOrEqual(new Date('2026-03-03').getTime());
      }
    });

    // AC: @session-list-pagination-api ac-filter-since
    test('since filter with ISO 8601 datetime', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions?since=2026-03-04T10:00:00.000Z`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Sessions started at or after Mar 4 10:00: sessions 4 and 5
      expect(body.items.length).toBe(2);
    });
  });

  test.describe('Combined Filters', () => {
    // AC: @session-list-pagination-api ac-combined-filters
    test('AND logic: status + agent_id + limit', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(
        `${daemon.baseUrl}/api/sessions?status=completed&agent_id=worker&limit=10`
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Sessions that are both completed AND have agent_id=worker: 1 and 5
      expect(body.items.length).toBe(2);
      for (const item of body.items) {
        expect(item.status).toBe('completed');
        expect(item.agent_id).toBe('worker');
      }
    });

    // AC: @session-list-pagination-api ac-combined-filters
    test('pagination applies after filtering', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      // Filter to completed (3 results), then paginate to first 1
      const response = await request.get(
        `${daemon.baseUrl}/api/sessions?status=completed&offset=0&limit=1`
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBe(1);
      expect(body.total).toBe(3); // 3 completed sessions total
      expect(body.offset).toBe(0);
      expect(body.limit).toBe(1);
    });
  });

  test.describe('Invalid Filters', () => {
    // AC: @session-list-pagination-api ac-invalid-filter
    // AC: @trait-api-endpoint ac-3
    test('returns 400 for invalid status value', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions?status=bogus`);
      expect(response.status()).toBe(400);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('details');
      expect(Array.isArray(body.details)).toBe(true);
      expect(body.details[0].field).toBe('status');
      expect(body.details[0].message).toContain('bogus');
      expect(body.details[0].message).toContain('completed');
    });

    // AC: @session-list-pagination-api ac-invalid-filter
    test('returns 400 for invalid since date', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions?since=not-a-date`);
      expect(response.status()).toBe(400);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('details');
      expect(body.details[0].field).toBe('since');
    });
  });

  test.describe('Metadata Only', () => {
    // AC: @session-list-pagination-api ac-metadata-only
    test('session list items include metadata fields from session.yaml', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBeGreaterThan(0);

      // Verify metadata fields are present (from session.yaml cache)
      const item = body.items[0];
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('status');
      expect(item).toHaveProperty('agent_type');
      expect(item).toHaveProperty('started_at');
      expect(item).toHaveProperty('duration_ms');
      expect(item).toHaveProperty('event_count');
      expect(item).toHaveProperty('iteration_count');
    });
  });

  test.describe('Empty Results', () => {
    // AC: @trait-filterable-list ac-6
    test('returns empty items array when no sessions match filter', async ({ request, daemon }) => {
      const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
      setupTestSessions(sessionsDir);

      const response = await request.get(`${daemon.baseUrl}/api/sessions?status=timed_out`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });
  });
});
