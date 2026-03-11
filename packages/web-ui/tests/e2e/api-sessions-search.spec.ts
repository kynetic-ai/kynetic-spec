/**
 * E2E API Tests for Session Text Search
 *
 * Covered ACs:
 * - @session-text-search ac-api-search
 * - @session-text-search ac-scope-narrowing
 * - @trait-api-endpoint ac-1
 * - @trait-api-endpoint ac-2
 * - @trait-api-endpoint ac-6
 *
 * N/A coverage:
 * - @trait-api-endpoint ac-3 — N/A: GET /api/sessions/search does not accept a request body.
 * - @trait-api-endpoint ac-4 — N/A: search results are bounded by limit, not offset/limit pagination.
 * - @trait-api-endpoint ac-5 — N/A: the search endpoint is read-only and does not mutate shadow state.
 */

import { test, expect } from '../fixtures/test-base';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as YAML from 'yaml';

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
		events: Array<{ type: string; text: string }>;
	}
): void {
	const sessionDir = join(dir, sessionId);
	mkdirSync(sessionDir, { recursive: true });

	writeFileSync(
		join(sessionDir, 'session.yaml'),
		YAML.stringify({
			id: sessionId,
			agent_type: opts.agentType ?? 'claude-agent-acp',
			agent_id: opts.agentId ?? 'worker',
			status: opts.status ?? 'completed',
			trigger: opts.trigger ?? 'task.ready',
			task_id: opts.taskId,
			started_at: opts.startedAt ?? '2026-03-01T10:00:00.000Z'
		})
	);

	writeFileSync(
		join(sessionDir, 'events.jsonl'),
		opts.events
			.map((event, index) =>
				JSON.stringify({
					seq: index,
					ts: Date.parse(opts.startedAt ?? '2026-03-01T10:00:00.000Z') + index * 1000,
					type: event.type,
					session_id: sessionId,
					data: { message: event.text }
				})
			)
			.join('\n') + '\n'
	);
}

test.describe('Session Search API', () => {
	// AC: @session-text-search ac-api-search
	// AC: @session-text-search ac-scope-narrowing
	// AC: @trait-api-endpoint ac-1
	test('returns grouped matches and narrows the search set with metadata filters', async ({
		request,
		daemon
	}) => {
		const sessionsDir = join(daemon.tempDir, '.kspec-sessions');
		mkdirSync(sessionsDir, { recursive: true });

		writeSession(sessionsDir, '01KSEARCH000000000000000001', {
			agentId: 'worker',
			status: 'completed',
			taskId: '@test-task-ready',
			startedAt: '2026-03-01T10:00:00.000Z',
			events: [
				{ type: 'session.start', text: 'Starting run' },
				{ type: 'session.update', text: 'Error handling added to daemon search' }
			]
		});

		writeSession(sessionsDir, '01KSEARCH000000000000000002', {
			agentId: 'pr-reviewer',
			status: 'failed',
			taskId: '@test-task-ready',
			startedAt: '2026-02-01T10:00:00.000Z',
			events: [{ type: 'session.update', text: 'Error handling in unrelated review' }]
		});

		const response = await request.get(
			`${daemon.baseUrl}/api/sessions/search?q=error+handling&status=completed&agent_id=worker&since=2026-03-01&task_id=@test-task-ready`
		);
		expect(response.status()).toBe(200);

		const body = await response.json();
		expect(body.query).toBe('error handling');
		expect(body.total_sessions).toBe(1);
		expect(body.total_matches).toBe(1);
		expect(body.items).toHaveLength(1);
		expect(body.items[0].session_id).toBe('01KSEARCH000000000000000001');
		expect(body.items[0].matches[0]).toMatchObject({
			session_id: '01KSEARCH000000000000000001',
			event_seq: 1,
			event_type: 'session.update'
		});
		expect(typeof body.items[0].matches[0].timestamp).toBe('number');
		expect(body.items[0].matches[0].content_excerpt).toContain('Error handling');
	});

	// AC: @trait-api-endpoint ac-2
	test('returns 404 for an unknown task filter', async ({ request, daemon }) => {
		const response = await request.get(
			`${daemon.baseUrl}/api/sessions/search?q=error&task_id=@missing-task`
		);
		expect(response.status()).toBe(404);

		const body = await response.json();
		expect(body.error).toBe('not_found');
		expect(body.message).toContain('@missing-task');
		expect(body.suggestion).toContain('/api/tasks');
	});

	// AC: @trait-api-endpoint ac-6
	test('includes x-request-id on search responses', async ({ request, daemon }) => {
		const response = await request.get(`${daemon.baseUrl}/api/sessions/search?q=error`);
		expect(response.status()).toBe(200);
		expect(response.headers()['x-request-id']).toBeTruthy();
	});
});
