import { test, expect } from '../fixtures/test-base';

/**
 * Dashboard View E2E Tests
 *
 * Tests for the dashboard view in the web dashboard.
 *
 * Covered ACs:
 * - AC-1: Dashboard shows task overview counts (ready, in_progress, pending_review, blocked, completed)
 * - AC-2: Counts animate on WebSocket updates (skipped - daemon WebSocket limitation)
 * - AC-3: Click task count badge navigates to filtered task list
 * - AC-20: Session focus displayed in sidebar
 * - AC-21: Observations count badge in sidebar
 */

test.describe('Dashboard View', () => {
	test.describe('Task Overview (AC-1)', () => {
		// AC: @web-dashboard ac-1
		test('displays task counts container', async ({ page, daemon }) => {
			await page.goto('/');

			const countsContainer = page.getByTestId('dashboard-counts');
			await expect(countsContainer).toBeVisible();
		});

		// AC: @web-dashboard ac-1
		test('displays all status count badges', async ({ page, daemon }) => {
			await page.goto('/');

			// Verify each status count badge is visible
			await expect(page.getByTestId('task-count-ready')).toBeVisible();
			await expect(page.getByTestId('task-count-in_progress')).toBeVisible();
			await expect(page.getByTestId('task-count-pending_review')).toBeVisible();
			await expect(page.getByTestId('task-count-blocked')).toBeVisible();
			await expect(page.getByTestId('task-count-completed')).toBeVisible();
		});

		// AC: @web-dashboard ac-1
		test('shows correct count values from fixtures', async ({ page, daemon }) => {
			await page.goto('/');

			// Wait for counts to load (no longer shows "...")
			await expect(page.getByTestId('task-count-ready')).not.toContainText('...');

			// Based on fixture data:
			// - 1 pending (test-task-ready) with no deps = ready
			// - 1 pending (test-task-blocked) with unmet dep = blocked
			// - 1 in_progress
			// - 1 pending_review
			// - 1 completed
			const readyCount = page.getByTestId('task-count-ready');
			await expect(readyCount).toContainText('1');

			const inProgressCount = page.getByTestId('task-count-in_progress');
			await expect(inProgressCount).toContainText('1');

			const pendingReviewCount = page.getByTestId('task-count-pending_review');
			await expect(pendingReviewCount).toContainText('1');

			const blockedCount = page.getByTestId('task-count-blocked');
			await expect(blockedCount).toContainText('1');

			const completedCount = page.getByTestId('task-count-completed');
			await expect(completedCount).toContainText('1');
		});
	});

	test.describe('Count Navigation (AC-3)', () => {
		// AC: @web-dashboard ac-3
		test('clicking ready count navigates to pending tasks', async ({ page, daemon }) => {
			await page.goto('/');

			// Wait for counts to load
			await expect(page.getByTestId('task-count-ready')).not.toContainText('...');

			const readyBadge = page.getByTestId('task-count-ready');
			await readyBadge.click();

			await page.waitForURL(/\/tasks\?status=pending/);
			expect(page.url()).toContain('/tasks');
			expect(page.url()).toContain('status=pending');
		});

		// AC: @web-dashboard ac-3
		test('clicking in_progress count navigates to in_progress tasks', async ({ page, daemon }) => {
			await page.goto('/');

			await expect(page.getByTestId('task-count-in_progress')).not.toContainText('...');

			const badge = page.getByTestId('task-count-in_progress');
			await badge.click();

			await page.waitForURL(/\/tasks\?status=in_progress/);
			expect(page.url()).toContain('status=in_progress');
		});

		// AC: @web-dashboard ac-3
		test('clicking pending_review count navigates to pending_review tasks', async ({
			page,
			daemon
		}) => {
			await page.goto('/');

			await expect(page.getByTestId('task-count-pending_review')).not.toContainText('...');

			const badge = page.getByTestId('task-count-pending_review');
			await badge.click();

			await page.waitForURL(/\/tasks\?status=pending_review/);
			expect(page.url()).toContain('status=pending_review');
		});

		// AC: @web-dashboard ac-3
		test('clicking blocked count navigates to blocked tasks', async ({ page, daemon }) => {
			await page.goto('/');

			await expect(page.getByTestId('task-count-blocked')).not.toContainText('...');

			const badge = page.getByTestId('task-count-blocked');
			await badge.click();

			await page.waitForURL(/\/tasks\?status=blocked/);
			expect(page.url()).toContain('status=blocked');
		});

		// AC: @web-dashboard ac-3
		test('clicking completed count navigates to completed tasks', async ({ page, daemon }) => {
			await page.goto('/');

			await expect(page.getByTestId('task-count-completed')).not.toContainText('...');

			const badge = page.getByTestId('task-count-completed');
			await badge.click();

			await page.waitForURL(/\/tasks\?status=completed/);
			expect(page.url()).toContain('status=completed');
		});
	});

	test.describe('WebSocket Updates (AC-2)', () => {
		// AC: @web-dashboard ac-2
		// Skipped: Daemon WebSocket upgrade returns 200 instead of 101 in E2E environment.
		// The UI code correctly handles WebSocket updates when connection is available.
		// See AGENTS.md "CI Limitations" for details.
		test.skip('counts animate on WebSocket update', async ({ page, daemon }) => {
			await page.goto('/');

			// Would need to:
			// 1. Wait for initial counts to load
			// 2. Trigger task update via API
			// 3. Verify count changes without page refresh
			// 4. Check for animation class on updated count
		});
	});

	test.describe('Session Focus (AC-20)', () => {
		// AC: @web-dashboard ac-20
		test('displays session focus when set', async ({ page, daemon }) => {
			await page.goto('/');

			// Fixture has focus set to "E2E testing"
			const focusElement = page.getByTestId('session-focus');
			await expect(focusElement).toBeVisible();
			await expect(focusElement).toContainText('E2E testing');
		});
	});

	test.describe('Observations Badge (AC-21)', () => {
		// AC: @web-dashboard ac-21
		test('shows observations badge when unresolved exist', async ({ page, daemon }) => {
			await page.goto('/');

			// Fixture has 2 unresolved observations
			const badge = page.getByTestId('observations-badge');
			await expect(badge).toBeVisible();
		});

		// AC: @web-dashboard ac-21
		test('shows correct observations count', async ({ page, daemon }) => {
			await page.goto('/');

			const count = page.getByTestId('observations-count');
			await expect(count).toBeVisible();
			await expect(count).toContainText('2');
		});
	});

	test.describe('Responsive Layout', () => {
		// AC: @web-dashboard ac-26
		test('dashboard adapts to mobile viewport', async ({ page, daemon }) => {
			await page.setViewportSize({ width: 375, height: 667 });
			await page.goto('/');

			const counts = page.getByTestId('dashboard-counts');
			await expect(counts).toBeVisible();

			// All count badges should still be accessible
			await expect(page.getByTestId('task-count-ready')).toBeVisible();
		});

		// AC: @web-dashboard ac-27
		test('dashboard shows full grid on desktop', async ({ page, daemon }) => {
			await page.setViewportSize({ width: 1280, height: 720 });
			await page.goto('/');

			const counts = page.getByTestId('dashboard-counts');
			await expect(counts).toBeVisible();

			// All count badges should be visible in grid layout
			await expect(page.getByTestId('task-count-ready')).toBeVisible();
			await expect(page.getByTestId('task-count-completed')).toBeVisible();
		});
	});
});
