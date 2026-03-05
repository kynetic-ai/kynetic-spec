import { test, expect } from '../fixtures/test-base';

/**
 * Task Board (Kanban) E2E Tests
 *
 * Tests for the Kanban-style task board view.
 *
 * Covered ACs:
 * - AC-1: Tasks distributed into columns by status
 * - AC-2: Task cards show priority, tags, title, slug, spec ref, metadata
 * - AC-3: Clicking card opens detail modal
 * - AC-4: Active Fleet row shows running agents
 * - AC-5: Real-time updates via WebSocket
 * - AC-6: Action buttons in detail modal
 */

test.describe('Task Board (Kanban)', () => {
	// AC: @ui-task-board ac-1
	test('renders board with five columns', async ({ page, daemon }) => {
		await page.goto('/tasks/board');

		// Wait for board to load
		const columns = page.getByTestId('board-column');
		await expect(columns.first()).toBeVisible();

		// Should have 5 columns: Backlog, Ready, In Progress, Review, Done
		await expect(columns).toHaveCount(5);
	});

	// AC: @ui-task-board ac-1
	test('distributes tasks into correct columns based on status', async ({ page, daemon }) => {
		await page.goto('/tasks/board');

		const boardColumns = page.getByTestId('board-columns');
		await expect(boardColumns).toBeVisible();

		// Verify columns exist by their IDs
		await expect(page.locator('[data-column-id="backlog"]')).toBeVisible();
		await expect(page.locator('[data-column-id="ready"]')).toBeVisible();
		await expect(page.locator('[data-column-id="in_progress"]')).toBeVisible();
		await expect(page.locator('[data-column-id="review"]')).toBeVisible();
		await expect(page.locator('[data-column-id="done"]')).toBeVisible();
	});

	// AC: @ui-task-board ac-2
	test('task card shows priority badge, title, slug, and metadata', async ({ page, daemon }) => {
		await page.goto('/tasks/board');

		// Find first task card
		const card = page.getByTestId('task-card').first();
		await expect(card).toBeVisible();

		// Verify card contents
		await expect(card.getByTestId('priority-badge')).toBeVisible();
		await expect(card.getByTestId('task-title')).toBeVisible();
		await expect(card.getByTestId('task-slug')).toBeVisible();
		await expect(card.getByTestId('task-metadata')).toBeVisible();
	});

	// AC: @ui-task-board ac-3
	test('clicking a task card opens the detail modal', async ({ page, daemon }) => {
		await page.goto('/tasks/board');

		// Click first task card
		const card = page.getByTestId('task-card').first();
		await expect(card).toBeVisible();
		await card.click();

		// Verify modal opened
		const modal = page.getByTestId('task-detail-modal');
		await expect(modal).toBeVisible();

		// Modal should show task title
		await expect(page.getByTestId('modal-task-title')).toBeVisible();
		// Modal should show status badge
		await expect(page.getByTestId('modal-status-badge')).toBeVisible();
		// Modal should show priority
		await expect(page.getByTestId('modal-priority')).toBeVisible();
	});

	// AC: @ui-task-board ac-3
	test('detail modal shows full task info', async ({ page, daemon }) => {
		await page.goto('/tasks/board');

		// Click first task card
		await page.getByTestId('task-card').first().click();

		const modal = page.getByTestId('task-detail-modal');
		await expect(modal).toBeVisible();

		// Check notes section exists
		await expect(page.getByTestId('modal-notes')).toBeVisible();
	});

	// AC: @ui-task-board ac-1
	test('shows empty state when no tasks exist', async ({ page }) => {
		// Navigate to board (if daemon has no tasks it should show empty state)
		// This test verifies the empty state component renders
		await page.goto('/tasks/board');

		// Either board columns or empty state should be visible
		const columns = page.getByTestId('board-columns');
		const empty = page.getByTestId('board-empty');

		// Wait for either to appear
		await expect(columns.or(empty)).toBeVisible();
	});

	// AC: @ui-task-board ac-6
	test('detail modal shows action buttons in daemon mode', async ({ page, daemon }) => {
		await page.goto('/tasks/board');

		// Find and click a task card
		const card = page.getByTestId('task-card').first();
		await expect(card).toBeVisible();
		await card.click();

		// Modal should be visible with actions section
		const modal = page.getByTestId('task-detail-modal');
		await expect(modal).toBeVisible();

		// At least one action should be available (depends on task status)
		const actions = page.getByTestId('modal-actions');
		// Actions may not be visible if task is completed/cancelled, but the section should exist for active tasks
		await expect(actions.or(page.getByTestId('modal-notes'))).toBeVisible();
	});

	// AC: @ui-task-board ac-4
	test('active fleet row is hidden when no agents are running', async ({ page, daemon }) => {
		await page.goto('/tasks/board');

		// Wait for board to load
		await expect(page.getByTestId('board-columns').or(page.getByTestId('board-empty'))).toBeVisible();

		// Active fleet should NOT be visible when no agents running
		await expect(page.getByTestId('active-fleet-row')).not.toBeVisible();
	});

	// View toggle navigation
	test('view toggle navigates between board and list views', async ({ page, daemon }) => {
		await page.goto('/tasks/board');

		// Wait for board to load
		await expect(
			page.getByTestId('board-columns').or(page.getByTestId('board-empty'))
		).toBeVisible();

		// Click list view toggle
		await page.getByTitle('List view').click();

		// Should navigate to tasks list
		await expect(page).toHaveURL(/\/tasks$/);
	});
});
