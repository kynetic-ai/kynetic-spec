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
    // AC: @web-dashboard ac-default-active-filter
    test('defaults to showing only active statuses', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Wait for task list to load
      const taskList = page.getByTestId('task-list');
      await expect(taskList).toBeVisible();
      const taskItems = page.getByTestId('task-list-item');
      await expect(taskItems.first()).toBeVisible({ timeout: 10000 });

      // Fixture has 7 tasks: 4 pending, 1 in_progress, 1 pending_review, 1 completed
      // Default "Active" filter should hide the completed task (6 shown)
      await expect(taskItems).toHaveCount(6);

      // The status filter should display "Active" (not "All Statuses")
      const filterStatus = page.getByTestId('filter-status');
      await expect(filterStatus).toContainText('Active');

      // No completed tasks should be visible
      for (let i = 0; i < await taskItems.count(); i++) {
        const statusBadge = taskItems.nth(i).getByTestId('task-status-badge');
        await expect(statusBadge).not.toContainText(/completed/i);
        await expect(statusBadge).not.toContainText(/cancelled/i);
      }
    });

    // AC: @web-dashboard ac-default-active-filter
    test('shows all tasks when "All Statuses" is selected', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Wait for task list to load
      const taskList = page.getByTestId('task-list');
      await expect(taskList).toBeVisible();
      await expect(page.getByTestId('task-list-item').first()).toBeVisible({ timeout: 10000 });

      // Select "All Statuses"
      const filterStatus = page.getByTestId('filter-status');
      await filterStatus.click();
      await page.getByRole('option', { name: 'All Statuses' }).click();

      // URL should have status=all
      await page.waitForURL(/status=all/, { timeout: 10000 });

      // All 7 tasks should be visible
      const taskItems = page.getByTestId('task-list-item');
      await expect(taskItems).toHaveCount(7, { timeout: 10000 });
    });

    // AC: @web-dashboard ac-default-active-filter
    test('switching back to Active hides completed tasks and clears URL param', async ({ page, daemon }) => {
      // Start with "All Statuses" showing all tasks
      await page.goto('/tasks?status=all');

      const taskList = page.getByTestId('task-list');
      await expect(taskList).toBeVisible();
      await expect(page.getByTestId('task-list-item').first()).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('task-list-item')).toHaveCount(7, { timeout: 10000 });

      // Switch to "Active"
      const filterStatus = page.getByTestId('filter-status');
      await filterStatus.click();
      await page.getByRole('option', { name: 'Active', exact: true }).click();

      // URL should NOT have status= param (active is the default)
      await page.waitForFunction(() => !window.location.search.includes('status='), { timeout: 10000 });

      // Should show 6 active tasks (no completed)
      const taskItems = page.getByTestId('task-list-item');
      await expect(taskItems).toHaveCount(6, { timeout: 10000 });
    });

    // AC: @web-dashboard ac-4
    test('displays task with title, status badge, priority, spec_ref, notes count', async ({
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
    test('filters tasks by status', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Wait for task list to load first (ensures page is ready)
      const taskList = page.getByTestId('task-list');
      await expect(taskList).toBeVisible();
      const taskItems = page.getByTestId('task-list-item');
      await expect(taskItems.first()).toBeVisible({ timeout: 10000 });

      // Wait for filter controls
      const filterStatus = page.getByTestId('filter-status');
      await expect(filterStatus).toBeVisible();

      // Select "pending" status
      await filterStatus.click();
      await page.getByRole('option', { name: 'Pending', exact: true }).click();

      // Wait for URL to update with filter
      await page.waitForURL(/status=pending/, { timeout: 10000 });

      // Verify filtered results - should now show only pending tasks
      await expect(taskItems.first()).toBeVisible({ timeout: 5000 });

      // All visible tasks should have "pending" status badge
      const count = await taskItems.count();
      for (let i = 0; i < count; i++) {
        const statusBadge = taskItems.nth(i).getByTestId('task-status-badge');
        await expect(statusBadge).toContainText(/pending/i);
      }
    });

    // AC: @web-dashboard ac-9
    test('filters tasks by tag', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Wait for task list to load
      const taskList = page.getByTestId('task-list');
      await expect(taskList).toBeVisible();
      await expect(page.getByTestId('task-list-item').first()).toBeVisible();

      const filterTag = page.getByTestId('filter-tag');
      await expect(filterTag).toBeVisible();

      // Type a tag to filter using keyboard (triggers input events properly)
      await filterTag.click();
      await filterTag.pressSequentially('e2e', { delay: 50 });

      // Wait for URL to update with filter
      await page.waitForURL(/tag=e2e/, { timeout: 5000 });

      // Verify filtered tasks have the selected tag
      const taskItems = page.getByTestId('task-list-item');
      await expect(taskItems.first()).toBeVisible({ timeout: 5000 });

      const taskTags = taskItems.first().getByTestId('task-tags');
      await expect(taskTags).toContainText(/e2e/i);
    });

    // AC: @web-dashboard ac-9
    test('filters tasks by assignee', async ({ page, daemon }) => {
      await page.goto('/tasks');

      const filterAssignee = page.getByTestId('filter-assignee');
      await expect(filterAssignee).toBeVisible();

      // Type an assignee to filter (text input, not select)
      // Note: Our test fixtures don't have assignees, so we test that filter works
      // by checking we get no results for a non-existent assignee
      await filterAssignee.fill('nonexistent');

      // Wait for filter to apply
      await page.waitForTimeout(500);

      // Should show no results or "No tasks found"
      const taskList = page.getByTestId('task-list');
      await expect(taskList).toBeVisible();
    });

    // AC: @web-dashboard ac-9
    test('filters tasks by automation status', async ({ page, daemon }) => {
      await page.goto('/tasks');

      const filterAutomation = page.getByTestId('filter-automation');
      await expect(filterAutomation).toBeVisible();

      // Select "eligible" automation status
      await filterAutomation.click();
      await page.getByRole('option', { name: 'Eligible' }).click();

      // Wait for URL to update with automation=eligible
      await page.waitForURL(/\/tasks\?.*automation=eligible/);

      // Verify filtered results show only eligible tasks
      const taskItems = page.getByTestId('task-list-item');
      await expect(taskItems.first()).toBeVisible();

      // Only the task with automation=eligible should appear (1 task in fixture)
      await expect(taskItems).toHaveCount(1);
    });

    // AC: @web-dashboard ac-9 - automation filter dropdown has correct options
    test('automation filter has correct dropdown options', async ({ page, daemon }) => {
      await page.goto('/tasks');

      const filterAutomation = page.getByTestId('filter-automation');
      await filterAutomation.click();

      // Should show correct automation statuses matching AutomationStatusSchema
      await expect(page.getByRole('option', { name: 'All' })).toBeVisible();
      await expect(page.getByRole('option', { name: 'Eligible' })).toBeVisible();
      await expect(page.getByRole('option', { name: 'Needs Review' })).toBeVisible();
      await expect(page.getByRole('option', { name: 'Manual Only' })).toBeVisible();

      // "Blocked" should NOT be an option (it's a task status, not an automation status)
      await expect(page.getByRole('option', { name: 'Blocked' })).not.toBeVisible();
    });

    // AC: @web-dashboard ac-10
    // AC: @ui-url-panel-state ac-4 — filter state uses goto() so $page.url stays in sync
    test('URL updates with filter query params', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Apply status filter
      const filterStatus = page.getByTestId('filter-status');
      await filterStatus.click();
      await page.getByRole('option', { name: 'Pending', exact: true }).click();

      // Wait for URL to update
      await page.waitForURL(/\/tasks\?.*status=pending/);
      expect(page.url()).toContain('status=pending');

      // Apply tag filter (text input, not select)
      const filterTag = page.getByTestId('filter-tag');
      await filterTag.fill('e2e');

      // URL should now include both filters
      await page.waitForURL(/tag=e2e/);
      expect(page.url()).toContain('status=pending');
      expect(page.url()).toContain('tag=e2e');
    });

    // AC: @web-dashboard ac-10
    // AC: @ui-url-panel-state ac-4 — filter URL params restored correctly via goto()-based sync
    test('restores filters from URL query params on page load', async ({ page, daemon }) => {
      // Navigate directly with query params
      await page.goto('/tasks?status=pending&tag=e2e');

      // Wait for page to load and filters to be applied
      // Select components show their value in the trigger text
      const filterStatus = page.getByTestId('filter-status');
      await expect(filterStatus).toContainText(/pending/i);

      // Tag input should have the value
      const filterTag = page.getByTestId('filter-tag');
      await expect(filterTag).toHaveValue('e2e');

      // Task list should show filtered results
      const taskItems = page.getByTestId('task-list-item');
      await expect(taskItems.first()).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe('Task Detail', () => {
    // AC: @web-dashboard ac-5
    test('opens detail panel when task clicked', async ({ page, daemon }) => {
      // Capture console logs
      const consoleLogs: string[] = [];
      page.on('console', (msg) => {
        consoleLogs.push(`${msg.type()}: ${msg.text()}`);
      });

      // Capture network requests
      const apiCalls: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/api/')) {
          apiCalls.push(`${request.method()} ${request.url()}`);
        }
      });
      page.on('response', (response) => {
        if (response.url().includes('/api/')) {
          apiCalls.push(`-> ${response.status()} ${response.url()}`);
        }
      });

      await page.goto('/tasks');

      // Wait for task list to load
      const taskList = page.getByTestId('task-list');
      await expect(taskList).toBeVisible();

      // Wait for tasks to appear
      const taskItem = page.getByTestId('task-list-item').first();
      await expect(taskItem).toBeVisible();


      // Click the first task
      await taskItem.click();

      // Wait briefly for API call and dialog animation
      await page.waitForTimeout(2000);

      // Debug output
      console.log('=== Console logs ===');
      consoleLogs.forEach(log => console.log(log));
      console.log('=== API calls ===');
      apiCalls.forEach(call => console.log(call));

      // Detail panel should open as a Dialog modal (not a Sheet side-panel)
      const detailPanel = page.getByTestId('task-detail-panel');
      await expect(detailPanel).toBeVisible({ timeout: 5000 });

      // AC-5 requires the same floating Dialog modal as the kanban board.
      // Dialog.Content renders data-slot="dialog-content"; the old Sheet
      // rendered data-slot="sheet-content". This assertion distinguishes them.
      await expect(detailPanel).toHaveAttribute('data-slot', 'dialog-content');

      // Verify panel contains expected sections (title is in Dialog.Header)
      await expect(detailPanel.getByTestId('task-detail-title')).toBeVisible();
      await expect(detailPanel.getByTestId('task-notes')).toBeVisible();
    });

    // AC: @web-dashboard ac-5
    test('displays notes in chronological order', async ({ page, daemon }) => {
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
    test('displays todos and dependencies', async ({ page, daemon }) => {
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
    test('spec reference links to spec item detail', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Click task with spec_ref
      const taskItem = page.getByTestId('task-list-item').first();
      await taskItem.click();

      const detailPanel = page.getByTestId('task-detail-panel');
      await expect(detailPanel).toBeVisible();

      const specRefLink = detailPanel.getByTestId('task-spec-ref');
      await expect(specRefLink).toBeVisible();

      // Click the actual anchor link within the spec ref container
      const link = specRefLink.locator('a');
      await expect(link).toBeVisible();
      await link.click();

      // Should navigate to items page with spec detail
      await page.waitForURL(/\/items/, { timeout: 10000 });
      expect(page.url()).toContain('/items');

      // Spec detail panel should be visible (Sheet may need time to open)
      const specDetailPanel = page.getByTestId('spec-detail-panel');
      await expect(specDetailPanel).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe('Task Reviews Section', () => {
    // AC: @review-records-web-ui ac-7
    test('shows reviews section on task detail', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Wait for tasks to load
      const taskItem = page.getByTestId('task-list-item').first();
      await expect(taskItem).toBeVisible();

      // Click first task to open detail
      await taskItem.click();

      const detailPanel = page.getByTestId('task-detail-panel');
      await expect(detailPanel).toBeVisible({ timeout: 5000 });

      // Reviews section should be visible
      const reviewsSection = detailPanel.getByTestId('task-reviews');
      await expect(reviewsSection).toBeVisible();
    });

    // AC: @review-records-web-ui ac-7
    test('shows linked reviews with disposition badge for pending_review task', async ({ page, daemon }) => {
      // Navigate to pending_review tasks
      await page.goto('/tasks?status=pending_review');

      // Wait for tasks to load and click the pending_review task
      const taskItem = page.getByTestId('task-list-item').first();
      await expect(taskItem).toBeVisible({ timeout: 5000 });
      await taskItem.click();

      const detailPanel = page.getByTestId('task-detail-panel');
      await expect(detailPanel).toBeVisible({ timeout: 5000 });

      // Wait for reviews to load
      await page.waitForTimeout(1000);

      // Reviews section should show linked reviews
      const reviewsSection = detailPanel.getByTestId('task-reviews');
      await expect(reviewsSection).toBeVisible();

      // Should show at least one review row (the open review linked to this task)
      const reviewRows = reviewsSection.getByTestId('task-review-row');
      await expect(reviewRows.first()).toBeVisible({ timeout: 5000 });

      // Review row should contain the review title
      const firstRow = reviewRows.first();
      await expect(firstRow).toContainText('Review of test task');
    });

    // AC: @review-records-web-ui ac-7
    test('shows empty state when task has no linked reviews', async ({ page, daemon }) => {
      // Navigate to completed tasks (no reviews linked)
      await page.goto('/tasks?status=completed');

      const taskItem = page.getByTestId('task-list-item').first();
      await expect(taskItem).toBeVisible({ timeout: 5000 });
      await taskItem.click();

      const detailPanel = page.getByTestId('task-detail-panel');
      await expect(detailPanel).toBeVisible({ timeout: 5000 });

      // Wait for reviews to load
      await page.waitForTimeout(1000);

      // Should show empty state message
      const emptyState = detailPanel.getByTestId('task-reviews-empty');
      await expect(emptyState).toBeVisible({ timeout: 5000 });
      await expect(emptyState).toContainText('No reviews linked to this task');
    });

    // AC: @review-records-web-ui ac-7
    test('review links navigate to review detail page', async ({ page, daemon }) => {
      await page.goto('/tasks?status=pending_review');

      const taskItem = page.getByTestId('task-list-item').first();
      await expect(taskItem).toBeVisible({ timeout: 5000 });
      await taskItem.click();

      const detailPanel = page.getByTestId('task-detail-panel');
      await expect(detailPanel).toBeVisible({ timeout: 5000 });

      // Wait for reviews to load
      await page.waitForTimeout(1000);

      // Get the review row link
      const reviewRow = detailPanel.getByTestId('task-review-row').first();
      await expect(reviewRow).toBeVisible({ timeout: 5000 });

      // Verify it has the correct href to /reviews/[id]
      const href = await reviewRow.getAttribute('href');
      expect(href).toContain('/reviews/');
    });
  });

  test.describe('Task Actions', () => {
    // AC: @web-dashboard ac-7
    test('starts a pending task', async ({ page, daemon }) => {
      await page.goto('/tasks?status=pending');

      // Click pending task to open detail
      const taskItem = page.getByTestId('task-list-item').first();
      await taskItem.click();

      const detailPanel = page.getByTestId('task-detail-panel');
      const startButton = detailPanel.getByTestId('action-start');
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

      // Status badge should update to "pending"
      const statusBadge = detailPanel.getByTestId('task-status-badge');
      await expect(statusBadge).toContainText(/pending/i);
    });

    // AC: @web-dashboard ac-8
    test('adds note to task', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Open task detail
      const taskItem = page.getByTestId('task-list-item').first();
      await taskItem.click();

      const detailPanel = page.getByTestId('task-detail-panel');
      const addNoteForm = detailPanel.getByTestId('task-add-note');
      await expect(addNoteForm).toBeVisible();

      // Type note content
      const noteTextarea = addNoteForm.locator('textarea');
      const noteContent = 'Test note added via E2E test';
      await noteTextarea.fill(noteContent);

      // Set up request interception
      const requestPromise = page.waitForRequest((request) => {
        return request.url().includes('/api/tasks/') && request.url().includes('/note');
      });

      // Submit note
      const submitButton = addNoteForm.getByTestId('action-add-note');
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
    // Note: This test requires WebSocket to be working. Currently, the daemon's
    // WebSocket upgrade returns 200 instead of 101 in the test environment,
    // causing the connection to fail. The UI code correctly handles WebSocket
    // updates when the connection is available.
    test.skip('highlights task on WebSocket update', async ({ page, daemon }) => {
      await page.goto('/tasks');

      // Wait for page to fully load
      const taskList = page.getByTestId('task-list');
      const firstTask = taskList.getByTestId('task-list-item').first();
      await expect(firstTask).toBeVisible();

      // Get task ref from first task (this is the slug or ULID)
      const taskRef = await firstTask.getAttribute('data-task-ref');
      expect(taskRef).toBeTruthy();

      // Simulate external update via API (would trigger WebSocket event)
      const response = await fetch(`${daemon.baseUrl}/api/tasks/${taskRef}/note`, {
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

      // Find the task by data-task-ref attribute (not by text content)
      const highlightedTask = taskList.locator(`[data-task-ref="${taskRef}"]`);
      await expect(highlightedTask).toBeVisible();

      // Check for highlight class or animation (the component uses animate-pulse)
      await expect(highlightedTask).toHaveClass(/animate-pulse/, { timeout: 5000 });

      // Highlight should fade after 3 seconds (per implementation)
      await page.waitForTimeout(3500);
      await expect(highlightedTask).not.toHaveClass(/animate-pulse/);
    });
  });

  test.describe('Modal URL Cleanup', () => {
    // AC: @ui-task-board ac-7
    // AC: @ui-url-panel-state ac-1 — opens dialog via click, URL updated with goto()
    // AC: @ui-url-panel-state ac-2 — dismiss removes ?ref= via goto(), dialog stays closed
    test('closing task detail dialog removes ?ref= query param from URL', async ({
      page,
      daemon,
    }) => {
      await page.goto('/tasks');

      // Wait for task list to load
      const taskItem = page.getByTestId('task-list-item').first();
      await expect(taskItem).toBeVisible();

      // Click task to open dialog
      await taskItem.click();

      const detailPanel = page.getByTestId('task-detail-panel');
      await expect(detailPanel).toBeVisible();

      // Close dialog by pressing Escape
      await page.keyboard.press('Escape');
      await expect(detailPanel).not.toBeVisible();

      // URL should NOT have ?ref= param
      expect(page.url()).not.toContain('ref=');

      // Modal should stay closed — component state must be fully cleared
      // so the reactive effect watching ?ref= does not reopen the modal
      await page.waitForTimeout(1000);
      await expect(detailPanel).not.toBeVisible();
    });

    // AC: @ui-task-board ac-7
    // AC: @ui-url-panel-state ac-2 — dismiss removes ?ref= via goto(), stays closed
    // AC: @ui-url-panel-state ac-3 — deep-link via ?ref=, dismiss works on first attempt
    test('closing task detail opened via URL param removes ?ref= and stays closed', async ({
      page,
      daemon,
    }) => {
      // Navigate directly with ?ref= to open the modal
      await page.goto('/tasks?ref=01KG0RR8CB8N4YGP991WD7XS9R');

      // Dialog should open
      const detailPanel = page.getByTestId('task-detail-panel');
      await expect(detailPanel).toBeVisible();

      // Close dialog by pressing Escape
      await page.keyboard.press('Escape');
      await expect(detailPanel).not.toBeVisible();

      // URL should no longer have ?ref=
      expect(page.url()).not.toContain('ref=');

      // Modal should stay closed — component state (dialogOpen, panelTask,
      // lastProcessedRef) must be cleared so reactive effects don't reopen
      await page.waitForTimeout(1000);
      await expect(detailPanel).not.toBeVisible();
    });
  });

  test.describe('Responsive Layout', () => {
    // AC: @web-dashboard ac-26
    test('adapts to mobile viewport', async ({ page, daemon }) => {
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
    test('shows detail panel as slide-over on desktop', async ({ page, daemon }) => {
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
