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

    // Intercept API requests to verify header
    const requestPromise = page.waitForRequest((request) => {
      return request.url().includes('/api/tasks');
    });

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();
    await page.getByRole('option', { name: secondProjectPath }).click();

    // Wait for API request
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
    const endpoints = ['/api/tasks', '/api/items', '/api/inbox', '/api/meta/session'];

    for (const endpoint of endpoints) {
      const requestPromise = page.waitForRequest((request) => {
        return request.url().includes(endpoint);
      });

      // Navigate to trigger API call
      if (endpoint === '/api/tasks') await page.goto('/tasks');
      if (endpoint === '/api/items') await page.goto('/items');
      if (endpoint === '/api/inbox') await page.goto('/inbox');
      if (endpoint === '/api/meta/session') await page.goto('/');

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

    // Get initial task list content
    const taskList = page.getByTestId('task-list');
    const initialContent = await taskList.textContent();

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();
    await page.getByRole('option', { name: secondProjectPath }).click();

    // Wait for task list to reload
    await expect(taskList).not.toHaveText(initialContent || '');

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

    // Get initial items content
    const itemsContainer = page.getByTestId('items-tree');
    const initialContent = await itemsContainer.textContent();

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();
    await page.getByRole('option', { name: secondProjectPath }).click();

    // Wait for items to reload
    await expect(itemsContainer).not.toHaveText(initialContent || '');
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

    // Get initial inbox content
    const inboxContainer = page.getByTestId('inbox-list');
    const initialContent = await inboxContainer.textContent();

    // Select second project
    const projectSelector = page.getByTestId('project-selector');
    await projectSelector.click();
    await page.getByRole('option', { name: secondProjectPath }).click();

    // Wait for inbox to reload
    await expect(inboxContainer).not.toHaveText(initialContent || '');
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

    await page.goto('/');

    // Intercept first API request
    const requestPromise = page.waitForRequest((request) => {
      return request.url().includes('/api/');
    });

    await page.goto('/tasks');
    const request = await requestPromise;

    // Should use first registered project (daemon.tempDir)
    expect(request.headers()['x-kspec-dir']).toBe(daemon.tempDir);
  });
});
