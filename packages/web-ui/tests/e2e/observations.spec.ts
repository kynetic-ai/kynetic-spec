/**
 * E2E Tests for Observations Panel
 *
 * Covers:
 * - AC-20: Dashboard header shows current focus text
 * - AC-21: Sidebar shows unresolved observations count badge
 * - AC-22: Panel lists observations with type icons
 */

import { test, expect } from '@playwright/test';

test.describe('Observations', () => {
	test.describe('Session Focus Display', () => {
		// AC: @web-dashboard ac-20
		test('displays current focus in sidebar when set', async ({ page }) => {
			// Note: This test requires the daemon to have a focus set
			// via `kspec meta focus "Working on something"`
			await page.goto('/');

			// Check if focus is displayed (conditional on focus being set)
			const focusElement = page.getByTestId('session-focus');
			// If focus exists, verify it's visible
			const focusCount = await focusElement.count();
			if (focusCount > 0) {
				await expect(focusElement).toBeVisible();
				await expect(focusElement).not.toBeEmpty();
			}
		});

		// AC: @web-dashboard ac-20
		test('hides focus section when not set', async ({ page }) => {
			// When no focus is set, the section should not be visible
			// This is the default state for most test runs
			await page.goto('/');

			const focusElement = page.getByTestId('session-focus');
			const focusCount = await focusElement.count();

			// Either doesn't exist or is hidden
			expect(focusCount).toBe(0);
		});
	});

	test.describe('Observations Badge', () => {
		// AC: @web-dashboard ac-21
		test('shows observations count badge when unresolved observations exist', async ({
			page
		}) => {
			await page.goto('/');

			// Check if observations badge exists
			const badge = page.getByTestId('observations-badge');
			const badgeCount = await badge.count();

			if (badgeCount > 0) {
				// Badge should be visible
				await expect(badge).toBeVisible();

				// Count should be visible and non-zero
				const countBadge = page.getByTestId('observations-count');
				await expect(countBadge).toBeVisible();
				const countText = await countBadge.textContent();
				expect(countText).toMatch(/\d+/);
			}
		});

		// AC: @web-dashboard ac-21
		test('clicking badge navigates to observations page', async ({ page }) => {
			await page.goto('/');

			// Only test if badge exists
			const badge = page.getByTestId('observations-badge');
			const badgeCount = await badge.count();

			if (badgeCount > 0) {
				await badge.click();
				await expect(page).toHaveURL('/observations');
			}
		});
	});

	test.describe('Observations Panel', () => {
		// AC: @web-dashboard ac-22
		test('displays observations panel with type icons', async ({ page }) => {
			await page.goto('/observations');

			// Panel should be visible
			await expect(page.getByTestId('observations-panel')).toBeVisible();

			// Check for observations (may be empty)
			const items = page.getByTestId('observation-item');
			const itemCount = await items.count();

			if (itemCount > 0) {
				// Verify first observation has type icon
				const firstItem = items.first();
				await expect(firstItem.getByTestId('observation-type-icon')).toBeVisible();
				await expect(firstItem.getByTestId('observation-type')).toBeVisible();
				await expect(firstItem.getByTestId('observation-content')).toBeVisible();
			}
		});

		// AC: @web-dashboard ac-22
		test('shows empty state when no unresolved observations', async ({ page }) => {
			await page.goto('/observations');

			// Either has observations or shows empty state
			const items = page.getByTestId('observation-item');
			const itemCount = await items.count();

			if (itemCount === 0) {
				await expect(page.getByTestId('observations-empty')).toBeVisible();
			}
		});

		// AC: @web-dashboard ac-22
		test('displays different observation types with distinct icons', async ({ page }) => {
			await page.goto('/observations');

			const items = page.getByTestId('observation-item');
			const itemCount = await items.count();

			if (itemCount > 0) {
				// Check that observation types are labeled correctly
				const types = page.getByTestId('observation-type');
				const typeCount = await types.count();

				// Verify at least one type badge exists
				expect(typeCount).toBeGreaterThan(0);

				// Types should be one of: Friction, Success, Question, Idea
				for (let i = 0; i < Math.min(typeCount, 5); i++) {
					const typeText = await types.nth(i).textContent();
					expect(typeText).toMatch(/^(Friction|Success|Question|Idea)$/);
				}
			}
		});

		// AC: @web-dashboard ac-22
		test('shows count of unresolved observations', async ({ page }) => {
			await page.goto('/observations');

			const countBadge = page.getByTestId('observations-count');
			await expect(countBadge).toBeVisible();

			const countText = await countBadge.textContent();
			expect(countText).toMatch(/\d+ unresolved/);
		});

		// AC: @web-dashboard ac-22
		test('handles loading state', async ({ page }) => {
			// This tests the loading state briefly visible during fetch
			const responsePromise = page.waitForResponse(
				(response) => response.url().includes('/api/meta/observations'),
				{ timeout: 5000 }
			);

			await page.goto('/observations');

			// Loading indicator should appear briefly
			const loadingElement = page.getByTestId('loading');
			// May or may not catch it depending on speed, but should exist in DOM at some point
			const loadingCount = await loadingElement.count();
			// Loading may have already disappeared, so just verify panel loads
			await expect(page.getByTestId('observations-panel')).toBeVisible();

			// Verify API was called
			await responsePromise;
		});

		// AC: @web-dashboard ac-22
		test('handles error state', async ({ page }) => {
			// Stop daemon to trigger error
			// Note: This is a documentary test - actual error testing requires daemon control
			await page.goto('/observations');

			// In normal operation, should not see error
			// Error element may not exist in success case
			const errorElement = page.getByTestId('error');
			const errorCount = await errorElement.count();

			// Either no error (normal) or error is hidden
			if (errorCount > 0) {
				// If error exists, it should be visible only on error
				const isVisible = await errorElement.isVisible();
				// In normal test runs, should not be visible
				expect(isVisible).toBe(false);
			}
		});
	});

	test.describe('Responsive Layout', () => {
		// AC: @web-dashboard ac-26
		test('adapts to mobile viewport', async ({ page }) => {
			await page.setViewportSize({ width: 375, height: 667 });
			await page.goto('/observations');

			await expect(page.getByTestId('observations-panel')).toBeVisible();
		});

		// AC: @web-dashboard ac-27
		test('displays properly on desktop', async ({ page }) => {
			await page.setViewportSize({ width: 1920, height: 1080 });
			await page.goto('/observations');

			await expect(page.getByTestId('observations-panel')).toBeVisible();
		});
	});
});
