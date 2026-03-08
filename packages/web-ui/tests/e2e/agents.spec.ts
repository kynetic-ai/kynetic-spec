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
 * - @ui-agent-dispatch ac-4: Agent editing with inline edit form
 * - @ui-agent-dispatch ac-5: Trigger rows display filter criteria with inline editing
 * - @ui-agent-dispatch ac-6: New task.ready/task.needs_work triggers default automation to eligible
 * - @ui-agent-dispatch ac-7: Tag filter with removable chips
 * - @ui-agent-dispatch ac-8: Priority filter threshold editing
 * - @ui-agent-dispatch ac-9: Save persists full dispatch rules including filters
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

  test.describe('Agent Editing (AC-4)', () => {
    // AC: @ui-agent-dispatch ac-4
    test('edit button opens dialog with agent fields pre-populated', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      // Click edit on task-worker agent
      const editButton = page.getByTestId('agent-edit-button-task-worker');
      await expect(editButton).toBeVisible();
      await editButton.click();

      // Dialog should open
      const dialog = page.getByTestId('agent-edit-dialog');
      await expect(dialog).toBeVisible();

      // Title should show the agent id
      const title = page.getByTestId('agent-edit-title');
      await expect(title).toContainText('task-worker');

      // Name field should be pre-populated
      const nameInput = page.getByTestId('agent-edit-name');
      await expect(nameInput).toHaveValue('Task Worker');
    });

    // AC: @ui-agent-dispatch ac-4
    test('edit dialog shows dispatch triggers with add/remove', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // Should show existing triggers
      const triggers = page.getByTestId('agent-edit-triggers');
      await expect(triggers).toBeVisible();

      // task-worker has 3 triggers: ready, in_progress, needs_work
      // So pending_review should be available to add
      const addPendingReview = page.getByTestId('add-trigger-task.pending_review');
      await expect(addPendingReview).toBeVisible();
    });

    // AC: @ui-agent-dispatch ac-4
    test('edit dialog shows prompt template textarea', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      const promptTemplate = page.getByTestId('agent-edit-prompt-template');
      await expect(promptTemplate).toBeVisible();
    });

    // AC: @ui-agent-dispatch ac-4
    test('cancel discards changes and closes dialog', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // Modify name
      const nameInput = page.getByTestId('agent-edit-name');
      await nameInput.fill('Modified Name');

      // Cancel
      await page.getByTestId('agent-edit-cancel').click();

      // Dialog should close
      await expect(page.getByTestId('agent-edit-dialog')).toHaveCount(0);

      // Card name should still be original
      const card = page.getByTestId('agent-card-task-worker');
      await expect(card.getByTestId('agent-name')).toContainText('Task Worker');
    });

    // AC: @ui-agent-dispatch ac-4
    test('save persists changes via PATCH API and updates card', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // Modify description
      const descInput = page.getByTestId('agent-edit-description');
      await descInput.fill('Updated description via E2E test');

      // Save
      await page.getByTestId('agent-edit-save').click();

      // Dialog should close
      await expect(page.getByTestId('agent-edit-dialog')).toHaveCount(0);

      // Verify the update persisted by reloading
      await page.reload();
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      const card = page.getByTestId('agent-card-task-worker');
      await expect(card).toContainText('Updated description via E2E test');
    });

    // AC: @ui-agent-dispatch ac-4
    test('edit form shows error on save failure', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // Intercept PATCH to simulate failure
      await page.route('**/api/meta/agents/task-worker', (route) => {
        if (route.request().method() === 'PATCH') {
          route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'internal_error', message: 'Save failed' }),
          });
        } else {
          route.continue();
        }
      });

      // Save
      await page.getByTestId('agent-edit-save').click();

      // Error should be displayed
      const errorMsg = page.getByTestId('agent-edit-error');
      await expect(errorMsg).toBeVisible();
      await expect(errorMsg).toContainText('Save failed');
    });

    // AC: @ui-agent-dispatch ac-4
    test('trigger management: add and remove triggers', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // Remove a trigger (needs_work)
      const removeButton = page.getByTestId('remove-trigger-task.needs_work');
      await expect(removeButton).toBeVisible();
      await removeButton.click();

      // Add pending_review trigger
      const addButton = page.getByTestId('add-trigger-task.pending_review');
      await expect(addButton).toBeVisible();
      await addButton.click();

      // needs_work should now be available to add
      await expect(page.getByTestId('add-trigger-task.needs_work')).toBeVisible();
    });
  });

  test.describe('Filter Display on Agent Cards', () => {
    // AC: @ui-agent-dispatch ac-5
    test('agent card shows filter badges for automation, tags, and priority', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      const card = page.getByTestId('agent-card-task-worker');

      // Fixture has task.ready with filter: { automation: eligible, tags: [mvp], priority: 3 }
      await expect(card.getByTestId('filter-badge-automation').first()).toContainText('eligible');
      await expect(card.getByTestId('filter-badge-tag').first()).toContainText('mvp');
      await expect(card.getByTestId('filter-badge-priority').first()).toContainText('p≤3');
    });
  });

  test.describe('Dispatch Filter Editing (AC-5 through AC-9)', () => {
    // AC: @ui-agent-dispatch ac-5
    test('trigger rows display filter criteria with inline editing controls', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // The task.ready trigger row should show filter controls
      const triggerRow = page.getByTestId('trigger-row-task.ready');
      await expect(triggerRow).toBeVisible();

      // Automation dropdown present
      const automationSelect = page.getByTestId('trigger-automation-task.ready');
      await expect(automationSelect).toBeVisible();

      // Tags section present
      const tagsContainer = page.getByTestId('trigger-tags-task.ready');
      await expect(tagsContainer).toBeVisible();

      // Priority input present
      const priorityInput = page.getByTestId('trigger-priority-task.ready');
      await expect(priorityInput).toBeVisible();
    });

    // AC: @ui-agent-dispatch ac-5
    test('trigger row shows existing automation filter value', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // task.ready has automation: eligible in fixture
      const automationTrigger = page.getByTestId('trigger-automation-task.ready');
      await expect(automationTrigger).toContainText('eligible');
    });

    // AC: @ui-agent-dispatch ac-5
    test('trigger row shows existing tags as chips', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // task.ready has tags: [mvp] in fixture
      const tagsContainer = page.getByTestId('trigger-tags-task.ready');
      await expect(tagsContainer).toContainText('mvp');
    });

    // AC: @ui-agent-dispatch ac-5
    test('trigger row shows existing priority filter value', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // task.ready has priority: 3 in fixture
      const priorityInput = page.getByTestId('trigger-priority-task.ready');
      await expect(priorityInput).toHaveValue('3');
    });

    // AC: @ui-agent-dispatch ac-6
    test('new task.ready trigger defaults automation to eligible', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      // Open pr-reviewer which has pending_review but not task.ready
      await page.getByTestId('agent-edit-button-pr-reviewer').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // Add task.ready trigger
      const addButton = page.getByTestId('add-trigger-task.ready');
      await expect(addButton).toBeVisible();
      await addButton.click();

      // New trigger should auto-default automation to eligible
      const triggerRow = page.getByTestId('trigger-row-task.ready');
      await expect(triggerRow).toBeVisible();

      const automationTrigger = page.getByTestId('trigger-automation-task.ready');
      await expect(automationTrigger).toContainText('eligible');
    });

    // AC: @ui-agent-dispatch ac-6
    test('new task.needs_work trigger defaults automation to eligible', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      // Open pr-reviewer which doesn't have task.needs_work
      await page.getByTestId('agent-edit-button-pr-reviewer').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // Add task.needs_work trigger
      const addButton = page.getByTestId('add-trigger-task.needs_work');
      await expect(addButton).toBeVisible();
      await addButton.click();

      // Should auto-default automation to eligible
      const automationTrigger = page.getByTestId('trigger-automation-task.needs_work');
      await expect(automationTrigger).toContainText('eligible');
    });

    // AC: @ui-agent-dispatch ac-6
    test('new task.pending_review trigger does NOT default automation to eligible', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // task.pending_review should be available to add (not already on task-worker)
      const addButton = page.getByTestId('add-trigger-task.pending_review');
      await addButton.click();

      // Should show 'any' (no default automation for pending_review)
      const automationTrigger = page.getByTestId('trigger-automation-task.pending_review');
      await expect(automationTrigger).toContainText('any');
    });

    // AC: @ui-agent-dispatch ac-7
    test('can add tag filter chips via input', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // Add a new tag to the task.ready trigger
      const tagInput = page.getByTestId('trigger-tag-input-task.ready');
      await tagInput.fill('cli');
      await tagInput.press('Enter');

      // New tag should appear as a chip
      const tagsContainer = page.getByTestId('trigger-tags-task.ready');
      await expect(tagsContainer).toContainText('cli');

      // Original tag should still be there
      await expect(tagsContainer).toContainText('mvp');
    });

    // AC: @ui-agent-dispatch ac-7
    test('can remove tag filter chips', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // Remove the mvp tag from task.ready
      const removeTag = page.getByTestId('remove-filter-tag-mvp');
      await expect(removeTag).toBeVisible();
      await removeTag.click();

      // mvp should no longer be in the tags container
      const tagsContainer = page.getByTestId('trigger-tags-task.ready');
      await expect(tagsContainer).not.toContainText('mvp');
    });

    // AC: @ui-agent-dispatch ac-8
    test('can set priority filter threshold', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // Change priority on task.ready from 3 to 5
      const priorityInput = page.getByTestId('trigger-priority-task.ready');
      await priorityInput.fill('5');

      // Verify the input reflects new value
      await expect(priorityInput).toHaveValue('5');
    });

    // AC: @ui-agent-dispatch ac-9
    test('save persists dispatch rules including filter objects', async ({ page, daemon }) => {
      await page.goto('/agents');
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      // Add a new tag to task.ready trigger
      const tagInput = page.getByTestId('trigger-tag-input-task.ready');
      await tagInput.fill('dispatch');
      await tagInput.press('Enter');

      // Save the agent
      await page.getByTestId('agent-edit-save').click();
      await expect(page.getByTestId('agent-edit-dialog')).toHaveCount(0);

      // Reload and verify filters persisted
      await page.reload();
      await expect(page.getByTestId('agents-loading')).toHaveCount(0);

      // Open edit again and verify the tag is still there
      await page.getByTestId('agent-edit-button-task-worker').click();
      await expect(page.getByTestId('agent-edit-dialog')).toBeVisible();

      const tagsContainer = page.getByTestId('trigger-tags-task.ready');
      await expect(tagsContainer).toContainText('dispatch');
      await expect(tagsContainer).toContainText('mvp');

      // Verify automation filter also persisted
      const automationTrigger = page.getByTestId('trigger-automation-task.ready');
      await expect(automationTrigger).toContainText('eligible');

      // Verify priority filter persisted
      const priorityInput = page.getByTestId('trigger-priority-task.ready');
      await expect(priorityInput).toHaveValue('3');
    });
  });
});
