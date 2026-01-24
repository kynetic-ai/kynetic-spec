import { test, expect } from '../fixtures/test-base';

test.describe('Smoke Tests', () => {
  test('page loads and shows sidebar', async ({ page, daemon }) => {
    await page.goto('/');

    // Sidebar navigation is visible
    await expect(page.getByTestId('sidebar-nav')).toBeVisible();

    // Connection status shows connected
    const connectionStatus = page.getByTestId('connection-status');
    await expect(connectionStatus).toBeVisible();
    await expect(connectionStatus).toContainText(/connected/i);
  });

  test('dashboard page loads with navigation', async ({ page, daemon }) => {
    await page.goto('/');

    // Should see the kspec header
    await expect(page.getByText('kspec').first()).toBeVisible();

    // Should see the Dashboard heading
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('can load tasks page', async ({ page, daemon }) => {
    // Navigate directly to tasks page
    await page.goto('/tasks');

    // Wait for page to load - check for the heading
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();

    // Task list should be visible
    await expect(page.getByTestId('task-list')).toBeVisible({ timeout: 15000 });
  });

  test('can load items page', async ({ page, daemon }) => {
    await page.goto('/items');

    // Wait for page to load - check for the heading
    await expect(page.getByRole('heading', { name: 'Items' })).toBeVisible();
  });

  test('can load inbox page', async ({ page, daemon }) => {
    await page.goto('/inbox');

    // Wait for page to load - check for the heading
    await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  });
});
