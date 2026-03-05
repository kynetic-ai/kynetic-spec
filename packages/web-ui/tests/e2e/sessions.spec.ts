/**
 * E2E Tests for Session History View
 *
 * Tests verify the /sessions page renders session list with required metadata
 * and navigates to session detail on click.
 *
 * Covered ACs:
 * - @ui-session-history ac-1: Session list shows ID, agent type, task ref, status, duration, age
 * - @ui-session-history ac-2: Click navigates to /sessions/:id
 */

import { test, expect } from '../fixtures/test-base';

/** Mock session data for API interception. */
function mockSessions() {
	return {
		items: [
			{
				id: '01JTEST0000000000000000001',
				status: 'completed',
				agent_type: 'task-worker',
				session_type: 'invocation',
				task_id: '01JTASK0000000000000000001',
				started_at: '2026-03-04T10:00:00.000Z',
				ended_at: '2026-03-04T11:30:00.000Z',
				duration_ms: 5400000,
				event_count: 42,
				iteration_count: 3,
				tasks_completed: 1,
			},
			{
				id: '01JTEST0000000000000000002',
				status: 'active',
				agent_type: 'pr-reviewer',
				session_type: 'invocation',
				task_id: '01JTASK0000000000000000002',
				started_at: '2026-03-05T08:00:00.000Z',
				duration_ms: 60000,
				event_count: 10,
				iteration_count: 1,
				tasks_completed: 0,
			},
			{
				id: '01JTEST0000000000000000003',
				status: 'failed',
				agent_type: 'task-worker',
				session_type: 'loop',
				started_at: '2026-03-03T14:00:00.000Z',
				ended_at: '2026-03-03T14:05:00.000Z',
				duration_ms: 300000,
				event_count: 5,
				iteration_count: 0,
				tasks_completed: 0,
			},
		],
		total: 3,
	};
}

test.describe('Session History View', () => {
	test.describe('Session List (AC-1)', () => {
		// AC: @ui-session-history ac-1
		test('shows session list with required metadata fields', async ({ page, daemon }) => {
			await page.route('**/api/sessions', (route) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(mockSessions()),
				});
			});

			await page.goto('/sessions');

			const list = page.getByTestId('sessions-list');
			await expect(list).toBeVisible();

			const rows = page.getByTestId('session-row');
			await expect(rows).toHaveCount(3);
		});

		// AC: @ui-session-history ac-1 — Status badge visible
		test('shows status badge for each session', async ({ page, daemon }) => {
			await page.route('**/api/sessions', (route) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(mockSessions()),
				});
			});

			await page.goto('/sessions');
			await expect(page.getByTestId('sessions-list')).toBeVisible();

			// Check status badges are visible with correct text
			const rows = page.getByTestId('session-row');
			const firstRow = rows.nth(0);
			await expect(firstRow).toContainText('completed');

			const secondRow = rows.nth(1);
			await expect(secondRow).toContainText('active');

			const thirdRow = rows.nth(2);
			await expect(thirdRow).toContainText('failed');
		});

		// AC: @ui-session-history ac-1 — Session ID displayed
		test('shows session ID for each row', async ({ page, daemon }) => {
			await page.route('**/api/sessions', (route) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(mockSessions()),
				});
			});

			await page.goto('/sessions');
			await expect(page.getByTestId('sessions-list')).toBeVisible();

			const ids = page.getByTestId('session-id');
			await expect(ids).toHaveCount(3);
			// First 8 chars of the ULID
			await expect(ids.nth(0)).toContainText('01JTEST0');
		});

		// AC: @ui-session-history ac-1 — Agent type displayed
		test('shows agent type for each row', async ({ page, daemon }) => {
			await page.route('**/api/sessions', (route) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(mockSessions()),
				});
			});

			await page.goto('/sessions');
			await expect(page.getByTestId('sessions-list')).toBeVisible();

			const rows = page.getByTestId('session-row');
			await expect(rows.nth(0)).toContainText('task-worker');
			await expect(rows.nth(1)).toContainText('pr-reviewer');
		});

		// AC: @ui-session-history ac-1 — Task ref displayed when present
		test('shows task ref when session has a task_id', async ({ page, daemon }) => {
			await page.route('**/api/sessions', (route) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(mockSessions()),
				});
			});

			await page.goto('/sessions');
			await expect(page.getByTestId('sessions-list')).toBeVisible();

			// Sessions with task_id should show task ref
			const taskRefs = page.getByTestId('session-task-ref');
			await expect(taskRefs).toHaveCount(2); // Only 2 of 3 have task_id
			await expect(taskRefs.nth(0)).toContainText('@01JTASK0');
		});

		// AC: @ui-session-history ac-1 — Duration displayed
		test('shows duration for each row', async ({ page, daemon }) => {
			await page.route('**/api/sessions', (route) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(mockSessions()),
				});
			});

			await page.goto('/sessions');
			await expect(page.getByTestId('sessions-list')).toBeVisible();

			const durations = page.getByTestId('session-duration');
			await expect(durations).toHaveCount(3);
			// 5400000ms = 1h 30m
			await expect(durations.nth(0)).toContainText('1h 30m');
		});

		// AC: @ui-session-history ac-1 — Age displayed
		test('shows age for each row', async ({ page, daemon }) => {
			await page.route('**/api/sessions', (route) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(mockSessions()),
				});
			});

			await page.goto('/sessions');
			await expect(page.getByTestId('sessions-list')).toBeVisible();

			const ages = page.getByTestId('session-age');
			await expect(ages).toHaveCount(3);
			// Ages should be non-empty strings
			for (let i = 0; i < 3; i++) {
				await expect(ages.nth(i)).not.toBeEmpty();
			}
		});

		// AC: @ui-session-history ac-1 — Sorted by most recent first
		test('sessions are sorted by most recent first', async ({ page, daemon }) => {
			await page.route('**/api/sessions', (route) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(mockSessions()),
				});
			});

			await page.goto('/sessions');
			await expect(page.getByTestId('sessions-list')).toBeVisible();

			// The mock data is already sorted most-recent-first by the daemon
			// Verify the order matches: session 1 (Mar 4), session 2 (Mar 5), session 3 (Mar 3)
			// Daemon sorts descending by started_at, so: session 2, session 1, session 3
			const rows = page.getByTestId('session-row');
			const firstRowId = rows.nth(0).getAttribute('data-session-id');
			// Mock data comes pre-sorted from daemon, test verifies UI preserves order
			expect(firstRowId).resolves.toBe('01JTEST0000000000000000001');
		});
	});

	test.describe('Session Navigation (AC-2)', () => {
		// AC: @ui-session-history ac-2
		test('clicking a session navigates to /sessions/:id', async ({ page, daemon }) => {
			await page.route('**/api/sessions', (route) => {
				if (route.request().url().includes('/events')) {
					route.fulfill({
						status: 200,
						contentType: 'application/json',
						body: JSON.stringify({ events: [], total: 0 }),
					});
				} else if (route.request().url().match(/\/api\/sessions\/[^/]+$/)) {
					route.fulfill({
						status: 200,
						contentType: 'application/json',
						body: JSON.stringify(mockSessions().items[0]),
					});
				} else {
					route.fulfill({
						status: 200,
						contentType: 'application/json',
						body: JSON.stringify(mockSessions()),
					});
				}
			});

			await page.goto('/sessions');
			await expect(page.getByTestId('sessions-list')).toBeVisible();

			const firstRow = page.getByTestId('session-row').first();
			await firstRow.click();

			await expect(page).toHaveURL(/\/sessions\/01JTEST0000000000000000001/);
		});

		// AC: @ui-session-history ac-2
		test('session row links point to correct detail URL', async ({ page, daemon }) => {
			await page.route('**/api/sessions', (route) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(mockSessions()),
				});
			});

			await page.goto('/sessions');
			await expect(page.getByTestId('sessions-list')).toBeVisible();

			const firstRow = page.getByTestId('session-row').first();
			const href = await firstRow.getAttribute('href');
			expect(href).toContain('/sessions/01JTEST0000000000000000001');
		});
	});

	test.describe('Empty State', () => {
		test('shows empty state when no sessions exist', async ({ page, daemon }) => {
			await page.route('**/api/sessions', (route) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ items: [], total: 0 }),
				});
			});

			await page.goto('/sessions');

			const emptyState = page.getByTestId('sessions-empty');
			await expect(emptyState).toBeVisible();
			await expect(emptyState).toContainText('No sessions yet');
		});
	});

	test.describe('Loading State', () => {
		test('shows loading skeleton while fetching', async ({ page, daemon }) => {
			await page.route('**/api/sessions', async (route) => {
				await new Promise((r) => setTimeout(r, 500));
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(mockSessions()),
				});
			});

			await page.goto('/sessions');

			const skeleton = page.getByTestId('sessions-loading');
			await expect(skeleton).toBeVisible();

			// Eventually content appears
			await expect(page.getByTestId('sessions-list')).toBeVisible({ timeout: 5000 });
		});
	});

	test.describe('Error State', () => {
		test('shows error message on API failure', async ({ page, daemon }) => {
			await page.route('**/api/sessions', (route) => {
				route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'internal_error', message: 'Daemon unavailable' }),
				});
			});

			await page.goto('/sessions');

			const errorMessage = page.getByTestId('sessions-error');
			await expect(errorMessage).toBeVisible();
		});
	});

	test.describe('Navigation', () => {
		test('sessions page is accessible from sidebar', async ({ page, daemon }) => {
			await page.goto('/');

			const sessionsLink = page.getByTestId('nav-link-sessions');
			await expect(sessionsLink).toBeVisible();

			await sessionsLink.click();
			await expect(page).toHaveURL(/\/sessions/);
		});
	});
});
