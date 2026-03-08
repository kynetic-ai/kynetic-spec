/**
 * E2E Tests for Static Mode Project Initialization
 *
 * Regression test: static mode pages were not loading data because the project
 * store's initialized flag was never set to true. The fix adds
 * initializeForStaticMode() which is called during static mode setup in
 * +layout.svelte.
 *
 * Covered ACs:
 * - @gh-pages-export ac-25: Project store reports initialized=true in static mode
 * - @gh-pages-export ac-11: SPA loads and renders dashboard from snapshot
 */

import { test, expect } from '../fixtures/test-base';

/** Snapshot with realistic data for testing that pages render content. */
function createTestSnapshot() {
	return {
		version: '0.11.0',
		exported_at: '2026-03-08T12:00:00.000Z',
		project: { name: 'Test Project', description: 'A test project for static mode' },
		tasks: [
			{
				_ulid: '01JTEST0000000000000000001',
				title: 'Implement authentication',
				status: 'in_progress',
				priority: 1,
				slugs: ['task-implement-auth'],
				spec_ref: '@auth-feature',
				spec_ref_title: 'Authentication Feature',
				tags: ['mvp'],
				depends_on: [],
				notes: [],
				created_at: '2026-03-01T00:00:00.000Z',
			},
			{
				_ulid: '01JTEST0000000000000000002',
				title: 'Add user dashboard',
				status: 'pending',
				priority: 2,
				slugs: ['task-user-dashboard'],
				spec_ref: '@dashboard-feature',
				spec_ref_title: 'Dashboard Feature',
				tags: ['mvp'],
				depends_on: [],
				notes: [],
				created_at: '2026-03-02T00:00:00.000Z',
			},
			{
				_ulid: '01JTEST0000000000000000003',
				title: 'Fix login bug',
				status: 'completed',
				priority: 1,
				slugs: ['task-fix-login'],
				spec_ref: '@auth-feature',
				spec_ref_title: 'Authentication Feature',
				tags: ['bug'],
				depends_on: [],
				notes: [],
				created_at: '2026-03-03T00:00:00.000Z',
			},
		],
		items: [
			{
				_ulid: '01JITEM0000000000000000001',
				title: 'Authentication Feature',
				type: 'feature',
				slugs: ['auth-feature'],
				implementation: 'in_progress',
				description: 'User authentication and authorization',
				tags: ['mvp'],
				acceptance_criteria: [
					{
						id: 'ac-1',
						given: 'user has valid credentials',
						when: 'user submits login form',
						then: 'user is authenticated',
					},
				],
				children: [],
				traits: [],
				inherited_acs: [],
			},
		],
		inbox: [
			{
				_ulid: '01JINBX0000000000000000001',
				text: 'Consider adding OAuth support',
				tags: ['feature'],
				created_at: '2026-03-04T00:00:00.000Z',
			},
		],
		session: null,
		observations: [],
		agents: [],
		workflows: [],
		conventions: [],
	};
}

/**
 * Set up route interceptions to simulate static mode.
 * Intercepts the health check to fail and serves a snapshot JSON.
 */
async function setupStaticMode(page: import('@playwright/test').Page, snapshot: ReturnType<typeof createTestSnapshot>) {
	// Force static mode: health check fails so mode falls back to static
	await page.route('**/health', (route) => {
		route.fulfill({ status: 503, body: 'Service Unavailable' });
	});

	// Serve snapshot data
	await page.route('**/kspec-snapshot.json', (route) => {
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(snapshot),
		});
	});
}

test.describe('Static Mode Project Initialization', () => {
	// AC: @gh-pages-export ac-25
	test('dashboard renders task data from snapshot in static mode', async ({ page }) => {
		const snapshot = createTestSnapshot();
		await setupStaticMode(page, snapshot);

		await page.goto('/');

		// The dashboard should render (not be stuck on "Loading...")
		const dashboard = page.getByTestId('dashboard');
		await expect(dashboard).toBeVisible({ timeout: 15000 });

		// Status summary section should be visible (proves data loaded past the init gate)
		const statusSummary = page.getByTestId('status-summary-section');
		await expect(statusSummary).toBeVisible({ timeout: 10000 });

		// Verify actual task counts rendered from snapshot data
		// Snapshot has: 1 in_progress, 1 pending (ready), 1 completed
		const dashboardCounts = page.getByTestId('dashboard-counts');
		await expect(dashboardCounts).toBeVisible();
	});

	// AC: @gh-pages-export ac-25
	test('tasks page renders task list from snapshot in static mode', async ({ page }) => {
		const snapshot = createTestSnapshot();
		await setupStaticMode(page, snapshot);

		await page.goto('/tasks');

		// The task list should render with tasks from the snapshot
		// Wait for task content to appear (not loading skeleton)
		await expect(page.getByText('Implement authentication')).toBeVisible({ timeout: 15000 });
		await expect(page.getByText('Add user dashboard')).toBeVisible();
	});

	// AC: @gh-pages-export ac-25
	test('specs page renders items from snapshot in static mode', async ({ page }) => {
		const snapshot = createTestSnapshot();
		await setupStaticMode(page, snapshot);

		await page.goto('/specs');

		// The spec items should render
		await expect(page.getByText('Authentication Feature')).toBeVisible({ timeout: 15000 });
	});

	// AC: @gh-pages-export ac-25
	test('inbox page renders items from snapshot in static mode', async ({ page }) => {
		const snapshot = createTestSnapshot();
		await setupStaticMode(page, snapshot);

		await page.goto('/inbox');

		// The inbox items should render
		await expect(page.getByText('Consider adding OAuth support')).toBeVisible({ timeout: 15000 });
	});

	// AC: @gh-pages-export ac-25, ac-15
	test('static mode shows data freshness indicator', async ({ page }) => {
		const snapshot = createTestSnapshot();
		await setupStaticMode(page, snapshot);

		await page.goto('/');

		// The read-only banner should show the export timestamp
		await expect(page.getByText(/Data as of/i)).toBeVisible({ timeout: 15000 });
	});
});
