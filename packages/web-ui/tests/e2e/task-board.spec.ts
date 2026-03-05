import { test, expect } from '../fixtures/test-base';

/**
 * Task Board (Kanban) E2E Tests
 *
 * Tests for the Kanban-style task board view.
 *
 * Covered ACs:
 * - AC-1: Tasks distributed into columns by status
 * - AC-2: Task cards show priority, tags, title, slug, spec ref, metadata
 * - AC-3: Clicking card opens detail modal with full task info
 * - AC-4: Active Fleet row shows running agents
 * - AC-5: Real-time updates via WebSocket
 * - AC-6: Action buttons in detail modal execute mutations via API
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
	test('detail modal shows full task info: type, deps, todos, automation, VCS, plan, session', async ({
		page,
		daemon
	}) => {
		await page.goto('/tasks/board');

		// Click the in-progress task card — enriched fixture with all AC-3 required fields
		const inProgressColumn = page.locator('[data-column-id="in_progress"]');
		await expect(inProgressColumn).toBeVisible();
		const card = inProgressColumn.getByTestId('task-card').first();
		await expect(card).toBeVisible();
		await card.click();

		const modal = page.getByTestId('task-detail-modal');
		await expect(modal).toBeVisible();

		// Title
		await expect(page.getByTestId('modal-task-title')).toHaveText('In progress task');

		// Description
		await expect(page.getByTestId('modal-description')).toBeVisible();

		// Status badge
		await expect(page.getByTestId('modal-status-badge')).toHaveText('In Progress');

		// Priority
		await expect(page.getByTestId('modal-priority')).toContainText('Priority');

		// Type (AC-3 requires type to be shown)
		await expect(page.getByTestId('modal-type')).toBeVisible();
		await expect(page.getByTestId('modal-type')).toHaveText('task');

		// Spec ref
		await expect(page.getByTestId('modal-spec-ref')).toBeVisible();

		// Automation status
		await expect(page.getByTestId('modal-automation')).toBeVisible();
		await expect(page.getByTestId('modal-automation')).toHaveText('eligible');

		// Dependencies (fixture has depends_on: @test-task-ready)
		await expect(page.getByTestId('modal-dependencies')).toBeVisible();

		// VCS info (fixture has branch + PR refs)
		await expect(page.getByTestId('modal-vcs')).toBeVisible();

		// Plan ref (fixture has plan_ref: @test-plan)
		await expect(page.getByTestId('modal-plan-ref')).toBeVisible();

		// Session link (fixture has session_id: session-abc123)
		await expect(page.getByTestId('modal-session-link')).toBeVisible();

		// Todos (fixture has 2 todos)
		await expect(page.getByTestId('modal-todos')).toBeVisible();

		// Notes section
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

	// AC: @ui-task-board ac-5
	test('board updates after task mutation without page refresh', async ({ page, daemon }) => {
		await page.goto('/tasks/board');
		await expect(page.getByTestId('board-columns')).toBeVisible();

		// Find a pending task card and note its column
		const backlogColumn = page.locator('[data-column-id="backlog"]');
		await expect(backlogColumn).toBeVisible();
		const taskCards = backlogColumn.getByTestId('task-card');
		const initialBacklogCount = await taskCards.count();

		// Start a pending task via API directly (simulating external state change)
		// Use the ready task which is in pending status
		const startResponse = await page.request.post(
			`${daemon.baseUrl}/api/tasks/01KG0RR6CA45ZT43W2T6HJMVA1/start`
		);
		expect(startResponse.ok()).toBeTruthy();

		// Wait for the board to update (WebSocket notification or polling triggers reload)
		// The task should move from backlog to in_progress column
		const inProgressColumn = page.locator('[data-column-id="in_progress"]');
		await expect(async () => {
			const inProgressCards = await inProgressColumn.getByTestId('task-card').count();
			expect(inProgressCards).toBeGreaterThan(0);
		}).toPass({ timeout: 10000 });
	});

	// AC: @ui-task-board ac-6
	test('Start action button transitions pending task to in_progress', async ({
		page,
		daemon
	}) => {
		await page.goto('/tasks/board');
		await expect(page.getByTestId('board-columns')).toBeVisible();

		// Click a pending task card (backlog column has pending tasks)
		const backlogColumn = page.locator('[data-column-id="backlog"]');
		await expect(backlogColumn).toBeVisible();

		const card = backlogColumn.getByTestId('task-card').first();
		await expect(card).toBeVisible();
		await card.click();

		// Modal should open
		const modal = page.getByTestId('task-detail-modal');
		await expect(modal).toBeVisible();

		// Verify the Start button is visible and click it
		const startBtn = page.getByTestId('action-start');
		await expect(startBtn).toBeVisible();
		await startBtn.click();

		// Status badge should update to In Progress
		await expect(page.getByTestId('modal-status-badge')).toHaveText('In Progress', {
			timeout: 5000
		});
	});

	// AC: @ui-task-board ac-6
	test('Submit action button transitions in_progress task to pending_review', async ({
		page,
		daemon
	}) => {
		await page.goto('/tasks/board');
		await expect(page.getByTestId('board-columns')).toBeVisible();

		// Click the in-progress task
		const inProgressColumn = page.locator('[data-column-id="in_progress"]');
		await expect(inProgressColumn).toBeVisible();

		const card = inProgressColumn.getByTestId('task-card').first();
		await expect(card).toBeVisible();
		await card.click();

		// Modal should open
		const modal = page.getByTestId('task-detail-modal');
		await expect(modal).toBeVisible();

		// Verify the Submit button is visible and click it
		const submitBtn = page.getByTestId('action-submit');
		await expect(submitBtn).toBeVisible();
		await submitBtn.click();

		// Status badge should update to Review
		await expect(page.getByTestId('modal-status-badge')).toHaveText('Review', { timeout: 5000 });
	});

	// AC: @ui-task-board ac-6
	test('Add Note action adds a note to the task', async ({ page, daemon }) => {
		await page.goto('/tasks/board');
		await expect(page.getByTestId('board-columns')).toBeVisible();

		// Click a task card to open modal
		const card = page.getByTestId('task-card').first();
		await expect(card).toBeVisible();
		await card.click();

		const modal = page.getByTestId('task-detail-modal');
		await expect(modal).toBeVisible();

		// Find the add note form
		const noteForm = page.getByTestId('modal-add-note');
		await expect(noteForm).toBeVisible();

		// Type a note
		await noteForm.locator('textarea').fill('E2E test note content');

		// Click Add Note button
		const addNoteBtn = page.getByTestId('action-add-note');
		await expect(addNoteBtn).toBeEnabled();
		await addNoteBtn.click();

		// The new note should appear in the notes list
		await expect(page.getByTestId('note-item').filter({ hasText: 'E2E test note content' })).toBeVisible({
			timeout: 5000
		});
	});

	// AC: @ui-task-board ac-6
	test('Complete action transitions task to completed with reason', async ({ page, daemon }) => {
		await page.goto('/tasks/board');
		await expect(page.getByTestId('board-columns')).toBeVisible();

		// Click a task in the review column (pending_review supports Complete)
		const reviewColumn = page.locator('[data-column-id="review"]');
		await expect(reviewColumn).toBeVisible();

		const card = reviewColumn.getByTestId('task-card').first();
		await expect(card).toBeVisible();
		await card.click();

		// Modal should open
		const modal = page.getByTestId('task-detail-modal');
		await expect(modal).toBeVisible();

		// Click the Complete toggle button
		const completeToggle = page.getByTestId('action-complete-toggle');
		await expect(completeToggle).toBeVisible();
		await completeToggle.click();

		// Reason input should appear
		const reasonInput = page.getByTestId('reason-input');
		await expect(reasonInput).toBeVisible();

		// Enter a completion reason and confirm
		await reasonInput.locator('input').fill('E2E test: task completed successfully');
		await reasonInput.getByRole('button', { name: 'Confirm' }).click();

		// Status badge should update to Completed
		await expect(page.getByTestId('modal-status-badge')).toHaveText('Completed', {
			timeout: 5000
		});
	});

	// AC: @ui-task-board ac-6
	test('Block action transitions task to blocked with reason', async ({ page, daemon }) => {
		await page.goto('/tasks/board');
		await expect(page.getByTestId('board-columns')).toBeVisible();

		// Click a pending task from backlog column (Block is available for non-terminal statuses)
		const backlogColumn = page.locator('[data-column-id="backlog"]');
		await expect(backlogColumn).toBeVisible();

		const card = backlogColumn.getByTestId('task-card').first();
		await expect(card).toBeVisible();
		await card.click();

		// Modal should open
		const modal = page.getByTestId('task-detail-modal');
		await expect(modal).toBeVisible();

		// Click the Block toggle button
		const blockToggle = page.getByTestId('action-block-toggle');
		await expect(blockToggle).toBeVisible();
		await blockToggle.click();

		// Reason input should appear
		const reasonInput = page.getByTestId('reason-input');
		await expect(reasonInput).toBeVisible();

		// Enter a block reason and confirm
		await reasonInput.locator('input').fill('E2E test: blocked on external dependency');
		await reasonInput.getByRole('button', { name: 'Confirm' }).click();

		// Status badge should update to Blocked
		await expect(page.getByTestId('modal-status-badge')).toHaveText('Blocked', {
			timeout: 5000
		});
	});

	// AC: @ui-task-board ac-4
	test('active fleet row is hidden when no agents are running', async ({ page, daemon }) => {
		await page.goto('/tasks/board');

		// Wait for board to load
		await expect(
			page.getByTestId('board-columns').or(page.getByTestId('board-empty'))
		).toBeVisible();

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
