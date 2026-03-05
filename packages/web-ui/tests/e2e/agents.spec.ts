/**
 * E2E Tests for Agent and Dispatch View
 *
 * Tests verify the /agents page renders agent definitions, dispatch status,
 * and active invocations correctly.
 *
 * Covered ACs:
 * - @ui-agent-dispatch ac-1: Agent definitions show name, triggers, active/completed counts
 * - @ui-agent-dispatch ac-2: Dispatch running with stop button and active invocations
 * - @ui-agent-dispatch ac-3: Dispatch stopped with no active invocations
 */

import { test, expect } from '../fixtures/test-base';

const DAEMON_URL = 'http://localhost:3456';

test.describe('Agent and Dispatch View', () => {
  test.describe('Dispatch Stopped State (AC-3)', () => {
    // AC: @ui-agent-dispatch ac-3
    test('shows dispatch status as stopped initially', async ({ page, daemon }) => {
      await page.goto('/agents');

      const dispatchStatus = page.getByTestId('dispatch-status');
      await expect(dispatchStatus).toBeVisible();

      const badge = page.getByTestId('dispatch-status-badge');
      await expect(badge).toContainText('Stopped');
    });

    // AC: @ui-agent-dispatch ac-3
    test('shows stopped indicator when dispatch is not running', async ({ page, daemon }) => {
      await page.goto('/agents');

      const indicator = page.getByTestId('dispatch-indicator-stopped');
      await expect(indicator).toBeVisible();
    });

    // AC: @ui-agent-dispatch ac-3
    test('shows no active invocations when dispatch is stopped', async ({ page, daemon }) => {
      await page.goto('/agents');

      const invocationsSection = page.getByTestId('active-invocations-section');
      await expect(invocationsSection).toHaveCount(0);
    });
  });

  test.describe('Agent Definitions (AC-1)', () => {
    // AC: @ui-agent-dispatch ac-1
    test('renders agent cards from meta definitions', async ({ page, daemon }) => {
      await page.goto('/agents');

      // Wait for loading to finish
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      const section = page.getByTestId('agent-definitions-section');
      await expect(section).toBeVisible();

      // Fixture has 2 agents: task-worker and pr-reviewer
      const taskWorkerCard = page.getByTestId('agent-card-task-worker');
      await expect(taskWorkerCard).toBeVisible();

      const prReviewerCard = page.getByTestId('agent-card-pr-reviewer');
      await expect(prReviewerCard).toBeVisible();
    });

    // AC: @ui-agent-dispatch ac-1
    test('agent card shows name', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      const card = page.getByTestId('agent-card-task-worker');
      const name = card.getByTestId('agent-name');
      await expect(name).toContainText('Task Worker');
    });

    // AC: @ui-agent-dispatch ac-1
    test('agent card shows triggers', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      const card = page.getByTestId('agent-card-task-worker');
      const triggers = card.getByTestId('agent-trigger');
      // task-worker has 3 triggers: ready, in_progress, needs_work
      await expect(triggers).toHaveCount(3);
    });

    // AC: @ui-agent-dispatch ac-1
    test('agent card shows active invocation count', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      const card = page.getByTestId('agent-card-task-worker');
      const activeCount = card.getByTestId('agent-active-count');
      await expect(activeCount).toBeVisible();
      await expect(activeCount).toContainText('0');
    });

    // AC: @ui-agent-dispatch ac-1
    test('agent card shows completed count', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      const card = page.getByTestId('agent-card-task-worker');
      const completedCount = card.getByTestId('agent-completed-count');
      await expect(completedCount).toBeVisible();
      await expect(completedCount).toContainText('0');
    });

    // AC: @ui-agent-dispatch ac-1
    test('pr-reviewer agent shows pending_review trigger', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      const card = page.getByTestId('agent-card-pr-reviewer');
      const triggers = card.getByTestId('agent-trigger');
      await expect(triggers).toHaveCount(1);
      await expect(triggers.first()).toContainText('pending_review');
    });
  });

  test.describe('Dispatch Running State (AC-2)', () => {
    // AC: @ui-agent-dispatch ac-2
    test('shows dispatch as running after start', async ({ page, daemon, request }) => {
      // Start dispatch via API
      await request.post(`${DAEMON_URL}/api/agent/dispatch`, {
        data: { action: 'start' },
        headers: { 'Content-Type': 'application/json' },
      });

      await page.goto('/agents');

      const badge = page.getByTestId('dispatch-status-badge');
      await expect(badge).toContainText('Running');

      const indicator = page.getByTestId('dispatch-indicator-running');
      await expect(indicator).toBeVisible();

      // Clean up
      await request.post(`${DAEMON_URL}/api/agent/dispatch`, {
        data: { action: 'stop' },
        headers: { 'Content-Type': 'application/json' },
      });
    });

    // AC: @ui-agent-dispatch ac-2
    test('shows stop button when dispatch is running', async ({ page, daemon, request }) => {
      await request.post(`${DAEMON_URL}/api/agent/dispatch`, {
        data: { action: 'start' },
        headers: { 'Content-Type': 'application/json' },
      });

      await page.goto('/agents');

      const toggleButton = page.getByTestId('dispatch-toggle-button');
      await expect(toggleButton).toBeVisible();
      await expect(toggleButton).toContainText('Stop');

      // Clean up
      await request.post(`${DAEMON_URL}/api/agent/dispatch`, {
        data: { action: 'stop' },
        headers: { 'Content-Type': 'application/json' },
      });
    });

    // AC: @ui-agent-dispatch ac-2
    test('clicking stop button stops dispatch', async ({ page, daemon, request }) => {
      await request.post(`${DAEMON_URL}/api/agent/dispatch`, {
        data: { action: 'start' },
        headers: { 'Content-Type': 'application/json' },
      });

      await page.goto('/agents');

      // Click stop
      const toggleButton = page.getByTestId('dispatch-toggle-button');
      await toggleButton.click();

      // Wait for status to update
      const badge = page.getByTestId('dispatch-status-badge');
      await expect(badge).toContainText('Stopped');
    });

    // AC: @ui-agent-dispatch ac-2
    test('clicking start button starts dispatch', async ({ page, daemon }) => {
      await page.goto('/agents');

      const toggleButton = page.getByTestId('dispatch-toggle-button');
      await expect(toggleButton).toContainText('Start');

      await toggleButton.click();

      // Wait for status to update
      const badge = page.getByTestId('dispatch-status-badge');
      await expect(badge).toContainText('Running');

      // Clean up - stop dispatch
      await toggleButton.click();
      await expect(badge).toContainText('Stopped');
    });
  });

  test.describe('Loading and Error States', () => {
    test('shows loading skeleton initially', async ({ page, daemon }) => {
      // Delay API responses so the skeleton is reliably visible
      await page.route('**/api/agent/status', async (route) => {
        await new Promise((r) => setTimeout(r, 500));
        await route.continue();
      });
      await page.route('**/api/meta/agents', async (route) => {
        await new Promise((r) => setTimeout(r, 500));
        await route.continue();
      });

      await page.goto('/agents');

      // Skeleton should be visible while API calls are delayed
      const skeleton = page.getByTestId('agents-loading');
      await expect(skeleton).toBeVisible();

      // Eventually loading finishes and content appears
      await expect(page.getByTestId('dispatch-section')).toBeVisible({ timeout: 5000 });
    });

    test('error message displays on API failure', async ({ page, daemon }) => {
      // Intercept API calls and return errors
      await page.route('**/api/agent/status', (route) => {
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'internal_error', message: 'Daemon unavailable' }),
        });
      });
      await page.route('**/api/meta/agents', (route) => {
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'internal_error', message: 'Daemon unavailable' }),
        });
      });

      await page.goto('/agents');

      // Error message should be displayed with API error message
      const errorMessage = page.getByTestId('error-message');
      await expect(errorMessage).toBeVisible();
      await expect(errorMessage).toContainText('Daemon unavailable');
    });
  });

  test.describe('Empty State', () => {
    test('shows agent definitions section', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      const section = page.getByTestId('agent-definitions-section');
      await expect(section).toBeVisible();
    });

    // AC: @ui-agent-dispatch ac-2 — Empty state for active invocations when dispatch is running
    test('shows actionable empty state when dispatch is running with no active invocations', async ({ page, daemon, request }) => {
      // Start dispatch so it's enabled
      await request.post(`${DAEMON_URL}/api/agent/dispatch`, {
        data: { action: 'start' },
        headers: { 'Content-Type': 'application/json' },
      });

      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      // Active invocations section should be visible (dispatch is running)
      const invocationsSection = page.getByTestId('active-invocations-section');
      await expect(invocationsSection).toBeVisible();

      // Empty state should be shown with actionable guidance
      const emptyState = page.getByTestId('active-invocations-empty');
      await expect(emptyState).toBeVisible();
      await expect(emptyState).toContainText('No active invocations');
      await expect(emptyState).toContainText('kspec tasks ready --eligible');

      // Clean up
      await request.post(`${DAEMON_URL}/api/agent/dispatch`, {
        data: { action: 'stop' },
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  test.describe('Accessibility', () => {
    test('has aria-live region for invocation announcements', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      // The live region should exist for screen reader announcements
      const liveRegion = page.getByTestId('invocation-live-region');
      await expect(liveRegion).toBeAttached();
      await expect(liveRegion).toHaveAttribute('aria-live', 'assertive');
    });

    test('active invocations section has aria-live attribute', async ({ page, daemon, request }) => {
      // Start dispatch to make the section appear
      await request.post(`${DAEMON_URL}/api/agent/dispatch`, {
        data: { action: 'start' },
        headers: { 'Content-Type': 'application/json' },
      });

      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      const invocationsSection = page.getByTestId('active-invocations-section');
      await expect(invocationsSection).toHaveAttribute('aria-live', 'polite');

      // Clean up
      await request.post(`${DAEMON_URL}/api/agent/dispatch`, {
        data: { action: 'stop' },
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  test.describe('Navigation', () => {
    test('agents page is accessible from sidebar', async ({ page, daemon }) => {
      await page.goto('/');

      const agentsLink = page.getByTestId('nav-link-agents');
      await expect(agentsLink).toBeVisible();

      await agentsLink.click();
      await expect(page).toHaveURL(/\/agents/);
    });
  });
});
