import { test, expect } from '../fixtures/test-base';

/**
 * Project Selector E2E Tests
 *
 * Tests for multi-project support in the web UI.
 * These tests document expected behavior and will be enabled
 * once the ProjectSelector component is implemented.
 *
 * Covered ACs:
 * - AC-25: Project selector shown when multiple projects registered
 * - AC-26: Project selection sets X-Kspec-Dir header
 * - AC-27: UI reloads data on project change
 */

test.describe('Project Selector', () => {
  // AC: @multi-directory-daemon ac-25
  test.skip('shows project selector when multiple projects registered', async ({ page, daemon }) => {
    // Register a second project via API
    await fetch('http://localhost:3456/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: daemon.tempDir + '-second' }),
    });

    await page.goto('/');

    // Project selector should be visible
    const projectSelector = page.getByTestId('project-selector');
    await expect(projectSelector).toBeVisible();

    // Should show both projects
    await projectSelector.click();
    const projectList = page.getByRole('listbox');
    await expect(projectList.getByText(daemon.tempDir)).toBeVisible();
    await expect(projectList.getByText(daemon.tempDir + '-second')).toBeVisible();
  });

  // AC: @multi-directory-daemon ac-25
  test.skip('hides project selector when only one project registered', async ({ page, daemon }) => {
    await page.goto('/');

    // Project selector should not be visible with single project
    const projectSelector = page.getByTestId('project-selector');
    await expect(projectSelector).not.toBeVisible();
  });

  // AC: @multi-directory-daemon ac-26
  test.skip('sets X-Kspec-Dir header when project selected', async ({ page, daemon }) => {
    // Register second project
    const secondProjectPath = daemon.tempDir + '-second';
    await fetch('http://localhost:3456/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: secondProjectPath }),
    });

    await page.goto('/');

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();

    // Set up request interception AFTER clicking selector to avoid race condition
    const requestPromise = page.waitForRequest((request) => {
      return request.url().includes('/api/tasks');
    });

    // Click the option to trigger project change
    await page.getByRole('option', { name: secondProjectPath }).click();

    // Wait for API request triggered by selection
    const request = await requestPromise;

    // Verify X-Kspec-Dir header is set correctly
    expect(request.headers()['x-kspec-dir']).toBe(secondProjectPath);
  });

  // AC: @multi-directory-daemon ac-26
  test.skip('includes X-Kspec-Dir header in all API requests after selection', async ({
    page,
    daemon,
  }) => {
    // Register second project
    const secondProjectPath = daemon.tempDir + '-second';
    await fetch('http://localhost:3456/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: secondProjectPath }),
    });

    await page.goto('/');

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();
    await page.getByRole('option', { name: secondProjectPath }).click();

    // Test multiple API endpoints
    const endpoints = [
      { path: '/tasks', apiUrl: '/api/tasks' },
      { path: '/items', apiUrl: '/api/items' },
      { path: '/inbox', apiUrl: '/api/inbox' },
      { path: '/', apiUrl: '/api/meta/session' },
    ];

    for (const { path, apiUrl } of endpoints) {
      // Set up request interception before navigation
      const requestPromise = page.waitForRequest((request) => {
        return request.url().includes(apiUrl);
      });

      // Navigate to trigger API call
      await page.goto(path);

      const request = await requestPromise;
      expect(request.headers()['x-kspec-dir']).toBe(secondProjectPath);
    }
  });

  // AC: @multi-directory-daemon ac-27
  test.skip('reloads task data when project selection changes', async ({ page, daemon }) => {
    // Register second project with different tasks
    const secondProjectPath = daemon.tempDir + '-second';
    await fetch('http://localhost:3456/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: secondProjectPath }),
    });

    await page.goto('/tasks');

    // Wait for initial load
    const taskList = page.getByTestId('task-list');
    await expect(taskList).toBeVisible();

    // Set up request interception before selecting project
    const reloadPromise = page.waitForRequest((request) => {
      return request.url().includes('/api/tasks') &&
             request.headers()['x-kspec-dir'] === secondProjectPath;
    });

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();
    await page.getByRole('option', { name: secondProjectPath }).click();

    // Wait for API request to confirm data reload happened
    await reloadPromise;

    // Verify we're seeing different data (or empty state)
    // This validates that the UI reloaded data from the new project
  });

  // AC: @multi-directory-daemon ac-27
  test.skip('reloads spec items when project selection changes', async ({ page, daemon }) => {
    // Register second project
    const secondProjectPath = daemon.tempDir + '-second';
    await fetch('http://localhost:3456/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: secondProjectPath }),
    });

    await page.goto('/items');

    // Wait for initial load
    const itemsContainer = page.getByTestId('items-tree');
    await expect(itemsContainer).toBeVisible();

    // Set up request interception before selecting project
    const reloadPromise = page.waitForRequest((request) => {
      return request.url().includes('/api/items') &&
             request.headers()['x-kspec-dir'] === secondProjectPath;
    });

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();
    await page.getByRole('option', { name: secondProjectPath }).click();

    // Wait for API request to confirm data reload happened
    await reloadPromise;
  });

  // AC: @multi-directory-daemon ac-27
  test.skip('reloads inbox items when project selection changes', async ({ page, daemon }) => {
    // Register second project
    const secondProjectPath = daemon.tempDir + '-second';
    await fetch('http://localhost:3456/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: secondProjectPath }),
    });

    await page.goto('/inbox');

    // Wait for initial load
    const inboxContainer = page.getByTestId('inbox-list');
    await expect(inboxContainer).toBeVisible();

    // Set up request interception before selecting project
    const reloadPromise = page.waitForRequest((request) => {
      return request.url().includes('/api/inbox') &&
             request.headers()['x-kspec-dir'] === secondProjectPath;
    });

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();
    await page.getByRole('option', { name: secondProjectPath }).click();

    // Wait for API request to confirm data reload happened
    await reloadPromise;
  });

  // AC: @multi-directory-daemon ac-25
  test.skip('preserves selected project across page navigation', async ({ page, daemon }) => {
    // Register second project
    const secondProjectPath = daemon.tempDir + '-second';
    await fetch('http://localhost:3456/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: secondProjectPath }),
    });

    await page.goto('/');

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();
    await page.getByRole('option', { name: secondProjectPath }).click();

    // Navigate to different pages
    await page.goto('/tasks');
    await expect(projectSelector).toHaveText(new RegExp(secondProjectPath));

    await page.goto('/items');
    await expect(projectSelector).toHaveText(new RegExp(secondProjectPath));

    await page.goto('/inbox');
    await expect(projectSelector).toHaveText(new RegExp(secondProjectPath));
  });

  // AC: @multi-directory-daemon ac-27
  test.skip('shows loading state while reloading data after project change', async ({
    page,
    daemon,
  }) => {
    // Register second project
    const secondProjectPath = daemon.tempDir + '-second';
    await fetch('http://localhost:3456/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: secondProjectPath }),
    });

    await page.goto('/tasks');

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();
    await page.getByRole('option', { name: secondProjectPath }).click();

    // Should show loading indicator while fetching new data
    const loadingIndicator = page.getByTestId('loading-indicator');
    await expect(loadingIndicator).toBeVisible();

    // Loading should disappear once data is loaded
    await expect(loadingIndicator).not.toBeVisible({ timeout: 5000 });
  });

  // AC: @multi-directory-daemon ac-26
  test.skip('defaults to first registered project if no selection made', async ({
    page,
    daemon,
  }) => {
    // Register second project
    const secondProjectPath = daemon.tempDir + '-second';
    await fetch('http://localhost:3456/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: secondProjectPath }),
    });

    // Set up request interception before navigation
    const requestPromise = page.waitForRequest((request) => {
      return request.url().includes('/api/tasks');
    });

    // Navigate to /tasks - should trigger API call with default project
    await page.goto('/tasks');
    const request = await requestPromise;

    // Should use first registered project (daemon.tempDir) as default
    expect(request.headers()['x-kspec-dir']).toBe(daemon.tempDir);
  });
});
