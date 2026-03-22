/**
 * E2E Tests for Automation View — Dispatch Trigger Editing
 *
 * Tests verify the /automation page's dispatch triggers section supports
 * full inline editing: add/remove triggers, filter criteria (automation,
 * tags, priority), defaults, and save persistence.
 *
 * Covered ACs:
 * - @ui-automation-view ac-1: Automation view shows agent dispatch triggers
 * - @ui-automation-view ac-5: Inline editing of trigger event type and filter criteria
 */

import { test, expect } from '../fixtures/test-base';

test.describe('Automation View — Dispatch Triggers', () => {
  test.describe('Trigger Display (AC-1)', () => {
    // AC: @ui-automation-view ac-1
    test('shows dispatch triggers section with agent cards', async ({ page, daemon }) => {
      await page.goto('/automation');

      // Wait for loading to finish
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      const section = page.getByTestId('dispatch-triggers-section');
      await expect(section).toBeVisible();

      // Fixture has 2 agents: task-worker and pr-reviewer
      const taskWorkerCard = page.getByTestId('trigger-card-task-worker');
      await expect(taskWorkerCard).toBeVisible();

      const prReviewerCard = page.getByTestId('trigger-card-pr-reviewer');
      await expect(prReviewerCard).toBeVisible();
    });

    // AC: @ui-automation-view ac-1
    test('trigger cards show filter badges for automation, tags, and priority', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      const card = page.getByTestId('trigger-card-task-worker');
      // Fixture has task.ready with filter: { automation: eligible, tags: [mvp], priority: 3 }
      await expect(card).toContainText('eligible');
      await expect(card).toContainText('mvp');
      await expect(card).toContainText('p≤3');
    });
  });

  test.describe('Trigger Editing (AC-5)', () => {
    // AC: @ui-automation-view ac-5
    test('edit button opens dialog with trigger rows', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      await page.getByTestId('edit-triggers-task-worker').click();
      const dialog = page.getByTestId('trigger-edit-dialog');
      await expect(dialog).toBeVisible();

      // Should show existing triggers
      const triggers = page.getByTestId('trigger-edit-triggers');
      await expect(triggers).toBeVisible();

      // Title should mention the agent
      const title = page.getByTestId('trigger-edit-title');
      await expect(title).toContainText('Dispatch Triggers');
    });

    // AC: @ui-automation-view ac-5
    test('trigger row shows filter criteria with inline editing controls', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      await page.getByTestId('edit-triggers-task-worker').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

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

    // AC: @ui-automation-view ac-5
    test('trigger row shows existing automation filter value', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      await page.getByTestId('edit-triggers-task-worker').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

      // task.ready has automation: eligible in fixture
      const automationTrigger = page.getByTestId('trigger-automation-task.ready');
      await expect(automationTrigger).toContainText('eligible');
    });

    // AC: @ui-automation-view ac-5
    test('trigger row shows existing tags as chips', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      await page.getByTestId('edit-triggers-task-worker').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

      // task.ready has tags: [mvp] in fixture
      const tagsContainer = page.getByTestId('trigger-tags-task.ready');
      await expect(tagsContainer).toContainText('mvp');
    });

    // AC: @ui-automation-view ac-5
    test('trigger row shows existing priority filter value', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      await page.getByTestId('edit-triggers-task-worker').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

      // task.ready has priority: 3 in fixture
      const priorityInput = page.getByTestId('trigger-priority-task.ready');
      await expect(priorityInput).toHaveValue('3');
    });

    // AC: @ui-automation-view ac-5 — new task.ready defaults automation to eligible
    test('new task.ready trigger defaults automation to eligible', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      // Open pr-reviewer which has pending_review but not task.ready
      await page.getByTestId('edit-triggers-pr-reviewer').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

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

    // AC: @ui-automation-view ac-5 — new task.needs_work defaults automation to eligible
    test('new task.needs_work trigger defaults automation to eligible', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      // Open pr-reviewer which doesn't have task.needs_work
      await page.getByTestId('edit-triggers-pr-reviewer').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

      // Add task.needs_work trigger
      const addButton = page.getByTestId('add-trigger-task.needs_work');
      await expect(addButton).toBeVisible();
      await addButton.click();

      // Should auto-default automation to eligible
      const automationTrigger = page.getByTestId('trigger-automation-task.needs_work');
      await expect(automationTrigger).toContainText('eligible');
    });

    // AC: @ui-automation-view ac-5 — non-task.ready events don't default to eligible
    test('new task.pending_review trigger does NOT default automation to eligible', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      await page.getByTestId('edit-triggers-task-worker').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

      // task.pending_review should be available to add (not already on task-worker)
      const addButton = page.getByTestId('add-trigger-task.pending_review');
      await addButton.click();

      // Should show 'any' (no default automation for pending_review)
      const automationTrigger = page.getByTestId('trigger-automation-task.pending_review');
      await expect(automationTrigger).toContainText('any');
    });

    // AC: @ui-automation-view ac-5 — tag filter chip management
    test('can add tag filter chips via input', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      await page.getByTestId('edit-triggers-task-worker').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

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

    // AC: @ui-automation-view ac-5 — tag filter chip removal
    test('can remove tag filter chips', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      await page.getByTestId('edit-triggers-task-worker').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

      // Remove the mvp tag from task.ready
      const removeTag = page.getByTestId('remove-filter-tag-mvp');
      await expect(removeTag).toBeVisible();
      await removeTag.click();

      // mvp should no longer be in the tags container
      const tagsContainer = page.getByTestId('trigger-tags-task.ready');
      await expect(tagsContainer).not.toContainText('mvp');
    });

    // AC: @ui-automation-view ac-5 — priority filter threshold editing
    test('can set priority filter threshold', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      await page.getByTestId('edit-triggers-task-worker').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

      // Change priority on task.ready from 3 to 5
      const priorityInput = page.getByTestId('trigger-priority-task.ready');
      await priorityInput.fill('5');

      // Verify the input reflects new value
      await expect(priorityInput).toHaveValue('5');
    });

    // AC: @ui-automation-view ac-5 — trigger add/remove management
    test('trigger management: add and remove triggers', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      await page.getByTestId('edit-triggers-task-worker').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

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

    // AC: @ui-automation-view ac-5 — save persists dispatch rules including filter objects
    test('save persists dispatch rules including filter objects', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      await page.getByTestId('edit-triggers-task-worker').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

      // Add a new tag to task.ready trigger
      const tagInput = page.getByTestId('trigger-tag-input-task.ready');
      await tagInput.fill('dispatch');
      await tagInput.press('Enter');

      // Save the triggers
      await page.getByTestId('trigger-edit-save').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toHaveCount(0);

      // Reload and verify filters persisted
      await page.reload();
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      // Open edit again and verify the tag is still there
      await page.getByTestId('edit-triggers-task-worker').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

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

    test('cancel discards changes and closes dialog', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      await page.getByTestId('edit-triggers-task-worker').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

      // Remove a trigger
      const removeButton = page.getByTestId('remove-trigger-task.needs_work');
      await removeButton.click();

      // Cancel
      await page.getByTestId('trigger-edit-cancel').click();

      // Dialog should close
      await expect(page.getByTestId('trigger-edit-dialog')).toHaveCount(0);

      // Card should still show all original triggers
      const card = page.getByTestId('trigger-card-task-worker');
      await expect(card).toContainText('task.needs_work');
    });

    test('shows error on save failure', async ({ page, daemon }) => {
      await page.goto('/automation');
      await expect(page.getByTestId('automation-loading')).toHaveCount(0);

      await page.getByTestId('edit-triggers-task-worker').click();
      await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

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
      await page.getByTestId('trigger-edit-save').click();

      // Error should be displayed
      const errorMsg = page.getByTestId('trigger-edit-error');
      await expect(errorMsg).toBeVisible();
      await expect(errorMsg).toContainText('Save failed');
    });
  });
});
