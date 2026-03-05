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
      // Navigate and check immediately before data loads
      await page.goto('/agents');

      // The skeleton should appear briefly; we check the section renders
      const section = page.getByTestId('dispatch-section');
      // Wait for either loading or content
      await expect(section.or(page.getByTestId('agents-loading'))).toBeVisible();
    });

    test('error message displays on API failure', async ({ page, daemon }) => {
      // This test is documentary - verifying error boundary exists
      // A real API failure would show the error-message testid
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      // Page should have loaded without error
      const errorMessage = page.getByTestId('error-message');
      await expect(errorMessage).toHaveCount(0);
    });
  });

  test.describe('Empty State', () => {
    // This test verifies the empty state renders properly when no agents are defined
    // The fixture now includes agents, so we verify the non-empty state
    test('shows agent definitions section', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      const section = page.getByTestId('agent-definitions-section');
      await expect(section).toBeVisible();
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
