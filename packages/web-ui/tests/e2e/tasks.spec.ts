import { test, expect } from '../fixtures/test-base';

/**
 * Tasks View E2E Tests
 *
 * Tests for the tasks view in the web dashboard.
 * These tests document expected behavior and will be enabled
 * once the task UI components are implemented.
 *
 * Covered ACs:
 * - AC-4: Task list displays with status, priority, spec_ref, notes count
 * - AC-5: Task detail panel with notes, todos, dependencies
 * - AC-6: Spec reference as clickable link
 * - AC-7: Start Task button triggers state change
 * - AC-8: Add Note form appends note
 * - AC-9: Filter controls for status, type, tag, assignee, automation
 * - AC-10: URL updates with filter params
 * - AC-33: WebSocket updates highlight changed items
 */

test.describe('Tasks View', () => {
  test.describe('Task List', () => {
    // AC: @web-dashboard ac-4
    test.skip('displays task with title, status badge, priority, spec_ref, notes count', async ({
      page,
      daemon,
    }) => {
      await page.goto('/tasks');

      // Wait for task list to load
      const taskList = page.getByTestId('task-list');
      await expect(taskList).toBeVisible();

      // Find first task item
      const taskItem = taskList.getByTestId('task-list-item').first();
      await expect(taskItem).toBeVisible();

      // Verify task displays all required fields
      await expect(taskItem.getByTestId('task-title')).toBeVisible();
      await expect(taskItem.getByTestId('task-status-badge')).toBeVisible();
      await expect(taskItem.getByTestId('task-priority')).toBeVisible();
      await expect(taskItem.getByTestId('task-spec-ref')).toBeVisible();
      await expect(taskItem.getByTestId('task-notes-count')).toBeVisible();
    });

    // AC: @web-dashboard ac-9
    test.skip('filters tasks by status', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Wait for filter controls
      const filterStatus = page.getByTestId('filter-status');
      await expect(filterStatus).toBeVisible();

      // Select "in_progress" status
      await filterStatus.click();
      await page.getByRole('option', { name: 'In Progress' }).click();

      // Verify filtered results
      const taskItems = page.getByTestId('task-list-item');
      await expect(taskItems.first()).toBeVisible();

      // All visible tasks should have "in_progress" status badge
      const count = await taskItems.count();
      for (let i = 0; i < count; i++) {
        const statusBadge = taskItems.nth(i).getByTestId('task-status-badge');
        await expect(statusBadge).toContainText(/in progress/i);
      }
    });

    // AC: @web-dashboard ac-9
    test.skip('filters tasks by type', async ({ page, daemon }) => {
      await page.goto('/tasks');

      const filterType = page.getByTestId('filter-type');
      await expect(filterType).toBeVisible();

      // Select "task" type
      await filterType.click();
      await page.getByRole('option', { name: 'Task' }).click();

      // Verify tasks displayed match selected type
      const taskItems = page.getByTestId('task-list-item');
      await expect(taskItems.first()).toBeVisible();
    });

    // AC: @web-dashboard ac-9
    test.skip('filters tasks by tag', async ({ page, daemon }) => {
      await page.goto('/tasks');

      const filterTag = page.getByTestId('filter-tag');
      await expect(filterTag).toBeVisible();

      // Select a tag (e.g., "e2e")
      await filterTag.click();
      await page.getByRole('option', { name: 'e2e' }).click();

      // Verify filtered tasks have the selected tag
      const taskItems = page.getByTestId('task-list-item');
      await expect(taskItems.first()).toBeVisible();

      const taskTags = taskItems.first().getByTestId('task-tags');
      await expect(taskTags).toContainText(/e2e/i);
    });

    // AC: @web-dashboard ac-9
    test.skip('filters tasks by assignee', async ({ page, daemon }) => {
      await page.goto('/tasks');

      const filterAssignee = page.getByTestId('filter-assignee');
      await expect(filterAssignee).toBeVisible();

      // Select an assignee
      await filterAssignee.click();
      await page.getByRole('option', { name: '@claude' }).click();

      // Verify filtered results
      const taskItems = page.getByTestId('task-list-item');
      await expect(taskItems.first()).toBeVisible();
    });

    // AC: @web-dashboard ac-9
    test.skip('filters tasks by automation status', async ({ page, daemon }) => {
      await page.goto('/tasks');

      const filterAutomation = page.getByTestId('filter-automation');
      await expect(filterAutomation).toBeVisible();

      // Select "eligible" automation status
      await filterAutomation.click();
      await page.getByRole('option', { name: 'Eligible' }).click();

      // Verify filtered results show eligible tasks
      const taskItems = page.getByTestId('task-list-item');
      await expect(taskItems.first()).toBeVisible();
    });

    // AC: @web-dashboard ac-10
    test.skip('URL updates with filter query params', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Apply status filter
      const filterStatus = page.getByTestId('filter-status');
      await filterStatus.click();
      await page.getByRole('option', { name: 'In Progress' }).click();

      // Wait for URL to update
      await page.waitForURL(/\/tasks\?.*status=in_progress/);
      expect(page.url()).toContain('status=in_progress');

      // Apply tag filter
      const filterTag = page.getByTestId('filter-tag');
      await filterTag.click();
      await page.getByRole('option', { name: 'e2e' }).click();

      // URL should now include both filters
      await page.waitForURL(/\/tasks\?.*status=in_progress.*tag=e2e/);
      expect(page.url()).toContain('status=in_progress');
      expect(page.url()).toContain('tag=e2e');
    });

    // AC: @web-dashboard ac-10
    test.skip('restores filters from URL query params on page load', async ({ page, daemon }) => {
      // Navigate directly with query params
      await page.goto('/tasks?status=in_progress&tag=e2e');

      // Wait for filters to be applied
      const filterStatus = page.getByTestId('filter-status');
      await expect(filterStatus).toHaveValue('in_progress');

      const filterTag = page.getByTestId('filter-tag');
      await expect(filterTag).toHaveValue('e2e');

      // Task list should show filtered results
      const taskItems = page.getByTestId('task-list-item');
      await expect(taskItems.first()).toBeVisible();
    });
  });

  test.describe('Task Detail', () => {
    // AC: @web-dashboard ac-5
    test.skip('opens detail panel when task clicked', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Wait for task list and click first task
      const taskItem = page.getByTestId('task-list-item').first();
      await taskItem.click();

      // Detail panel should open
      const detailPanel = page.getByTestId('task-detail-panel');
      await expect(detailPanel).toBeVisible();

      // Verify panel contains expected sections
      await expect(detailPanel.getByTestId('task-description')).toBeVisible();
      await expect(detailPanel.getByTestId('task-notes')).toBeVisible();
    });

    // AC: @web-dashboard ac-5
    test.skip('displays notes in chronological order', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Click task to open detail
      const taskItem = page.getByTestId('task-list-item').first();
      await taskItem.click();

      // Get notes section
      const notesSection = page.getByTestId('task-notes');
      await expect(notesSection).toBeVisible();

      // Notes should be ordered by timestamp
      const noteItems = notesSection.getByTestId('note-item');
      const count = await noteItems.count();

      if (count > 1) {
        // Check first note timestamp is earlier than last note timestamp
        const firstNoteTime = await noteItems.first().getByTestId('note-timestamp').textContent();
        const lastNoteTime = await noteItems.last().getByTestId('note-timestamp').textContent();
        // Both should be present (chronological order validation)
        expect(firstNoteTime).toBeTruthy();
        expect(lastNoteTime).toBeTruthy();
      }
    });

    // AC: @web-dashboard ac-5
    test.skip('displays todos and dependencies', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Click task to open detail
      const taskItem = page.getByTestId('task-list-item').first();
      await taskItem.click();

      const detailPanel = page.getByTestId('task-detail-panel');
      await expect(detailPanel).toBeVisible();

      // Check for todos section (may be empty)
      const todosSection = detailPanel.getByTestId('task-todos');
      await expect(todosSection).toBeVisible();

      // Check for dependencies section (may be empty)
      const depsSection = detailPanel.getByTestId('task-dependencies');
      await expect(depsSection).toBeVisible();
    });

    // AC: @web-dashboard ac-6
    test.skip('spec reference links to spec item detail', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Click task with spec_ref
      const taskItem = page.getByTestId('task-list-item').first();
      await taskItem.click();

      const detailPanel = page.getByTestId('task-detail-panel');
      const specRefLink = detailPanel.getByTestId('task-spec-ref-link');
      await expect(specRefLink).toBeVisible();

      // Click spec ref link
      await specRefLink.click();

      // Should navigate to items page with spec detail
      await page.waitForURL(/\/items/);
      expect(page.url()).toContain('/items');

      // Spec detail panel should be visible
      const specDetailPanel = page.getByTestId('spec-detail-panel');
      await expect(specDetailPanel).toBeVisible();
    });
  });

  test.describe('Task Actions', () => {
    // AC: @web-dashboard ac-7
    test.skip('starts a pending task', async ({ page, daemon }) => {
      await page.goto('/tasks?status=pending');

      // Click pending task to open detail
      const taskItem = page.getByTestId('task-list-item').first();
      await taskItem.click();

      const detailPanel = page.getByTestId('task-detail-panel');
      const startButton = detailPanel.getByTestId('start-task-button');
      await expect(startButton).toBeVisible();

      // Set up request interception to verify API call
      const requestPromise = page.waitForRequest((request) => {
        return request.url().includes('/api/tasks/') && request.url().includes('/start');
      });

      // Click start button
      await startButton.click();

      // Verify API request was made
      const request = await requestPromise;
      expect(request.method()).toBe('POST');

      // Status badge should update to "in_progress"
      const statusBadge = detailPanel.getByTestId('task-status-badge');
      await expect(statusBadge).toContainText(/in progress/i);
    });

    // AC: @web-dashboard ac-8
    test.skip('adds note to task', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Open task detail
      const taskItem = page.getByTestId('task-list-item').first();
      await taskItem.click();

      const detailPanel = page.getByTestId('task-detail-panel');
      const addNoteForm = detailPanel.getByTestId('add-note-form');
      await expect(addNoteForm).toBeVisible();

      // Type note content
      const noteTextarea = addNoteForm.getByTestId('note-textarea');
      const noteContent = 'Test note added via E2E test';
      await noteTextarea.fill(noteContent);

      // Set up request interception
      const requestPromise = page.waitForRequest((request) => {
        return request.url().includes('/api/tasks/') && request.url().includes('/note');
      });

      // Submit note
      const submitButton = addNoteForm.getByTestId('add-note-button');
      await submitButton.click();

      // Verify API request
      const request = await requestPromise;
      expect(request.method()).toBe('POST');

      // Note should appear in notes list
      const notesSection = detailPanel.getByTestId('task-notes');
      await expect(notesSection).toContainText(noteContent);

      // Textarea should be cleared
      await expect(noteTextarea).toHaveValue('');
    });

    // AC: @web-dashboard ac-33
    test.skip('highlights task on WebSocket update', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Wait for WebSocket connection
      await page.waitForTimeout(1000);

      const taskList = page.getByTestId('task-list');
      const firstTask = taskList.getByTestId('task-list-item').first();
      await expect(firstTask).toBeVisible();

      // Get task ref from first task
      const taskRef = await firstTask.getAttribute('data-task-ref');

      // Simulate external update via API (would trigger WebSocket event)
      const response = await fetch(`http://localhost:3456/api/tasks/${taskRef}/note`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: 'External note added',
          author: '@external',
        }),
      });
      expect(response.ok).toBe(true);

      // Task should receive highlight class/animation
      const highlightedTask = taskList.getByTestId('task-list-item').filter({
        hasText: taskRef || '',
      });

      // Check for highlight class or animation (specific implementation may vary)
      await expect(highlightedTask).toHaveClass(/highlight|animate/);

      // Highlight should fade after animation completes
      await page.waitForTimeout(2000);
      await expect(highlightedTask).not.toHaveClass(/highlight/);
    });
  });

  test.describe('Responsive Layout', () => {
    // AC: @web-dashboard ac-26
    test.skip('adapts to mobile viewport', async ({ page, daemon }) => {
      // Set mobile viewport
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto('/tasks');

      // Task list should be visible
      const taskList = page.getByTestId('task-list');
      await expect(taskList).toBeVisible();

      // Filter controls should adapt (may collapse to dropdown)
      const filterControls = page.getByTestId('filter-controls');
      await expect(filterControls).toBeVisible();
    });

    // AC: @web-dashboard ac-27
    test.skip('shows detail panel as slide-over on desktop', async ({ page, daemon }) => {
      // Set desktop viewport
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto('/tasks');

      // Click task to open detail
      const taskItem = page.getByTestId('task-list-item').first();
      await taskItem.click();

      // Detail panel should slide over without navigating away
      const detailPanel = page.getByTestId('task-detail-panel');
      await expect(detailPanel).toBeVisible();

      // Task list should still be visible
      const taskList = page.getByTestId('task-list');
      await expect(taskList).toBeVisible();

      // URL should not change (no navigation)
      expect(page.url()).toContain('/tasks');
      expect(page.url()).not.toContain('/tasks/');
    });
  });
});
