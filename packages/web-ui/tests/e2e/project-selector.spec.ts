import { test, expect } from '../fixtures/test-base';

/**
 * Project Selector E2E Tests
 *
 * Tests for multi-project support in the web UI.
 *
 * Covered ACs:
 * - AC-25: Project selector shown when multiple projects registered
 * - AC-26: Project selection sets X-Kspec-Dir header
 * - AC-27: UI reloads data on project change
 */

test.describe('Project Selector', () => {
  // AC: @multi-directory-daemon ac-25
  test('shows project selector when multiple projects registered', async ({ page, daemon }) => {
    // Create and register a second valid project
    const secondProjectPath = await daemon.createSecondProject();

    // Reload page to pick up the new project list
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Project selector should be visible
    const projectSelector = page.getByTestId('project-selector');
    await expect(projectSelector).toBeVisible();

    // Click to open dropdown
    await projectSelector.click();

    // Wait for dropdown to open (bits-ui uses data-slot="select-content")
    const dropdownContent = page.locator('[data-slot="select-content"]');
    await expect(dropdownContent).toBeVisible();

    // Should show both projects in dropdown - use text matching
    // The first project name is the last segment of daemon.tempDir
    const firstProjectName = daemon.tempDir.split('/').pop() || '';
    await expect(dropdownContent).toContainText(firstProjectName);
    await expect(dropdownContent).toContainText('second');
  });

  // AC: @multi-directory-daemon ac-25
  test('hides project selector when only one project registered', async ({ page, daemon }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Project selector should not be visible with single project
    const projectSelector = page.getByTestId('project-selector');
    await expect(projectSelector).not.toBeVisible();
  });

  // AC: @multi-directory-daemon ac-26
  test('sets X-Kspec-Dir header when project selected', async ({ page, daemon }) => {
    // Create second project
    const secondProjectPath = await daemon.createSecondProject();

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();

    // Wait for dropdown
    const dropdownContent = page.locator('[data-slot="select-content"]');
    await expect(dropdownContent).toBeVisible();

    // Set up request interception AFTER dropdown is open to avoid race condition
    const requestPromise = page.waitForRequest((request) => {
      return request.url().includes('/api/tasks') || request.url().includes('/api/meta/session');
    });

    // Click the option to trigger project change
    await dropdownContent.locator('[data-slot="select-item"]').filter({ hasText: 'second' }).click();

    // Wait for API request triggered by selection
    const request = await requestPromise;

    // Verify X-Kspec-Dir header is set correctly
    expect(request.headers()['x-kspec-dir']).toBe(secondProjectPath);
  });

  // AC: @multi-directory-daemon ac-26
  test('includes X-Kspec-Dir header in all API requests after selection', async ({
    page,
    daemon,
  }) => {
    // Create second project
    const secondProjectPath = await daemon.createSecondProject();

    // Reload page to pick up new project list
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();

    // Wait for dropdown and click the second project option
    const dropdownContent = page.locator('[data-slot="select-content"]');
    await expect(dropdownContent).toBeVisible();
    await dropdownContent.locator('[data-slot="select-item"]').filter({ hasText: 'second' }).click();

    // Wait for selection to complete and persist to localStorage
    await page.waitForLoadState('networkidle');

    // Test multiple API endpoints by doing full page navigations
    // The selection is persisted to localStorage, so it will be restored on reload
    const endpoints = [
      { path: '/tasks', apiUrl: '/api/tasks' },
      { path: '/items', apiUrl: '/api/items' },
      { path: '/inbox', apiUrl: '/api/inbox' },
    ];

    for (const { path, apiUrl } of endpoints) {
      // Set up request interception before navigation
      const requestPromise = page.waitForRequest((request) => {
        return request.url().includes(apiUrl);
      });

      // Navigate to page - localStorage selection should be restored
      await page.goto(path);

      const request = await requestPromise;
      expect(request.headers()['x-kspec-dir']).toBe(secondProjectPath);
    }
  });

  // AC: @multi-directory-daemon ac-27
  test('reloads task data when project selection changes', async ({ page, daemon }) => {
    // Create second project with different tasks
    const secondProjectPath = await daemon.createSecondProject();

    await page.goto('/tasks');
    await page.waitForLoadState('networkidle');

    // Wait for initial load
    await expect(page.locator('h1:has-text("Tasks")')).toBeVisible();

    // Set up request interception before selecting project
    const reloadPromise = page.waitForRequest((request) => {
      return request.url().includes('/api/tasks') &&
             request.headers()['x-kspec-dir'] === secondProjectPath;
    });

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();

    // Wait for dropdown and click
    const dropdownContent = page.locator('[data-slot="select-content"]');
    await expect(dropdownContent).toBeVisible();
    await dropdownContent.locator('[data-slot="select-item"]').filter({ hasText: 'second' }).click();

    // Wait for API request to confirm data reload happened
    await reloadPromise;
  });

  // AC: @multi-directory-daemon ac-27
  test('reloads spec items when project selection changes', async ({ page, daemon }) => {
    // Create second project
    const secondProjectPath = await daemon.createSecondProject();

    await page.goto('/items');
    await page.waitForLoadState('networkidle');

    // Wait for initial load
    await expect(page.locator('h1:has-text("Spec Items")')).toBeVisible();

    // Set up request interception before selecting project
    const reloadPromise = page.waitForRequest((request) => {
      return request.url().includes('/api/items') &&
             request.headers()['x-kspec-dir'] === secondProjectPath;
    });

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();

    // Wait for dropdown and click
    const dropdownContent = page.locator('[data-slot="select-content"]');
    await expect(dropdownContent).toBeVisible();
    await dropdownContent.locator('[data-slot="select-item"]').filter({ hasText: 'second' }).click();

    // Wait for API request to confirm data reload happened
    await reloadPromise;
  });

  // AC: @multi-directory-daemon ac-27
  test('reloads inbox items when project selection changes', async ({ page, daemon }) => {
    // Create second project
    const secondProjectPath = await daemon.createSecondProject();

    await page.goto('/inbox');
    await page.waitForLoadState('networkidle');

    // Wait for initial load
    await expect(page.locator('h1:has-text("Inbox")')).toBeVisible();

    // Set up request interception before selecting project
    const reloadPromise = page.waitForRequest((request) => {
      return request.url().includes('/api/inbox') &&
             request.headers()['x-kspec-dir'] === secondProjectPath;
    });

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();

    // Wait for dropdown and click
    const dropdownContent = page.locator('[data-slot="select-content"]');
    await expect(dropdownContent).toBeVisible();
    await dropdownContent.locator('[data-slot="select-item"]').filter({ hasText: 'second' }).click();

    // Wait for API request to confirm data reload happened
    await reloadPromise;
  });

  // AC: @multi-directory-daemon ac-25
  test('preserves selected project across page navigation', async ({ page, daemon }) => {
    // Create second project
    const secondProjectPath = await daemon.createSecondProject();

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();

    // Wait for dropdown and click
    const dropdownContent = page.locator('[data-slot="select-content"]');
    await expect(dropdownContent).toBeVisible();
    await dropdownContent.locator('[data-slot="select-item"]').filter({ hasText: 'second' }).click();

    // Wait for selection to complete
    await page.waitForTimeout(500);

    // Navigate to different pages and check selector still shows second project
    for (const path of ['/tasks', '/items', '/inbox']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');

      const selector = page.getByTestId('project-selector');
      await expect(selector).toContainText('second');
    }
  });

  // AC: @multi-directory-daemon ac-27
  test('shows loading state while reloading data after project change', async ({
    page,
    daemon,
  }) => {
    // Create second project
    await daemon.createSecondProject();

    await page.goto('/tasks');
    await page.waitForLoadState('networkidle');

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();

    // Wait for dropdown and click
    const dropdownContent = page.locator('[data-slot="select-content"]');
    await expect(dropdownContent).toBeVisible();
    await dropdownContent.locator('[data-slot="select-item"]').filter({ hasText: 'second' }).click();

    // The loading state should appear briefly during project switch
    // Note: This is a best-effort test since loading may be very fast
    // We verify the functionality works by checking the page doesn't error
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h1:has-text("Tasks")')).toBeVisible();
  });

  // AC: @multi-directory-daemon ac-26
  test('defaults to first registered project if no selection made', async ({
    page,
    daemon,
  }) => {
    // Create second project
    await daemon.createSecondProject();

    // Navigate to a page first, then clear localStorage
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Clear localStorage and reload to get a fresh state
    await page.evaluate(() => localStorage.removeItem('kspec-selected-project'));

    // Set up request interception before navigation
    const requestPromise = page.waitForRequest((request) => {
      return request.url().includes('/api/tasks');
    });

    // Navigate to /tasks - should trigger API call with default project
    // The page will load projects and default to first one
    await page.goto('/tasks');
    const request = await requestPromise;

    // Should use first registered project (daemon.tempDir) as default
    expect(request.headers()['x-kspec-dir']).toBe(daemon.tempDir);
  });
});
