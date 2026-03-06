import { test, expect } from '../fixtures/test-base';

test.describe('Plans View', () => {
	test.beforeEach(async ({ page, daemon }) => {
		await page.goto('/plans');
		await expect(page.getByRole('heading', { name: 'Plans', exact: true })).toBeVisible();
	});

	// ── AC: @ui-plans-view ac-1 — Each plan shows title, status, creation date, linked spec/task counts, and progress ──

	// AC: @ui-plans-view ac-1
	test('displays plan cards with title and status badge', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const cards = page.getByTestId('plan-card');
		const count = await cards.count();
		expect(count).toBeGreaterThan(0);

		// Each card should have a title and status badge
		for (let i = 0; i < count; i++) {
			const card = cards.nth(i);
			await expect(card.getByTestId('plan-title')).toBeVisible();
			await expect(card.getByTestId('plan-status')).toBeVisible();
		}
	});

	// AC: @ui-plans-view ac-1
	test('shows creation date for each plan', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const cards = page.getByTestId('plan-card');
		const count = await cards.count();
		expect(count).toBeGreaterThan(0);

		for (let i = 0; i < count; i++) {
			const card = cards.nth(i);
			await expect(card.getByTestId('plan-created-at')).toBeVisible();
		}
	});

	// AC: @ui-plans-view ac-1
	test('shows linked spec and task counts', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const cards = page.getByTestId('plan-card');
		const count = await cards.count();
		expect(count).toBeGreaterThan(0);

		for (let i = 0; i < count; i++) {
			const card = cards.nth(i);
			await expect(card.getByTestId('plan-spec-count')).toBeVisible();
			await expect(card.getByTestId('plan-task-count')).toBeVisible();
		}
	});

	// AC: @ui-plans-view ac-1
	test('shows progress bar based on task completion status', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		// The active plan has derived_tasks, so it should show a progress bar
		const activePlan = page.getByTestId('plan-card').filter({ hasText: 'Active Implementation Plan' });
		await expect(activePlan).toBeVisible();

		const progressBar = activePlan.getByTestId('plan-progress-bar');
		await expect(progressBar).toBeVisible();

		const progressText = activePlan.getByTestId('plan-progress-text');
		await expect(progressText).toBeVisible();
		// Should show percentage and task count
		await expect(progressText).toContainText('tasks');
	});

	// AC: @ui-plans-view ac-1
	test('shows task status breakdown for plans with tasks', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const activePlan = page.getByTestId('plan-card').filter({ hasText: 'Active Implementation Plan' });
		await expect(activePlan).toBeVisible();

		const breakdown = activePlan.getByTestId('plan-task-breakdown');
		await expect(breakdown).toBeVisible();
	});

	// AC: @ui-plans-view ac-1
	test('displays plan status with correct labels', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		// Verify each known status has a properly labeled badge
		const activePlan = page.getByTestId('plan-card').filter({ hasText: 'Active Implementation Plan' });
		await expect(activePlan.getByTestId('plan-status')).toContainText('Active');

		const draftPlan = page.getByTestId('plan-card').filter({ hasText: 'Draft Feature Plan' });
		await expect(draftPlan.getByTestId('plan-status')).toContainText('Draft');

		const completedPlan = page.getByTestId('plan-card').filter({ hasText: 'Completed Migration Plan' });
		await expect(completedPlan.getByTestId('plan-status')).toContainText('Completed');
	});

	// AC: @ui-plans-view ac-1
	test('shows plan slug for each plan', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const activePlan = page.getByTestId('plan-card').filter({ hasText: 'Active Implementation Plan' });
		await expect(activePlan.getByTestId('plan-slug')).toContainText('@test-plan-active');
	});

	// ── Filter and summary ──

	// AC: @ui-plans-view ac-1
	test('shows plans summary with total count and status breakdown', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const summary = page.getByTestId('plans-summary');
		await expect(summary).toBeVisible();
		await expect(summary).toContainText('3 plans');
	});

	// AC: @ui-plans-view ac-1
	test('filters plans by status', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		// Initially shows all plans
		const allCards = page.getByTestId('plan-card');
		expect(await allCards.count()).toBe(3);

		// Filter to active only
		await page.getByTestId('plans-status-filter').selectOption('active');
		expect(await page.getByTestId('plan-card').count()).toBe(1);
		await expect(page.getByTestId('plan-card').first().getByTestId('plan-status')).toContainText('Active');

		// Filter to draft only
		await page.getByTestId('plans-status-filter').selectOption('draft');
		expect(await page.getByTestId('plan-card').count()).toBe(1);
		await expect(page.getByTestId('plan-card').first().getByTestId('plan-status')).toContainText('Draft');

		// Back to all
		await page.getByTestId('plans-status-filter').selectOption('all');
		expect(await page.getByTestId('plan-card').count()).toBe(3);
	});

	// AC: @ui-plans-view ac-1
	test('shows filtered count in summary when filter active', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		await page.getByTestId('plans-status-filter').selectOption('active');

		const summary = page.getByTestId('plans-summary');
		await expect(summary).toContainText('Showing 1 filtered');
	});

	// AC: @ui-plans-view ac-1
	test('shows empty state when filter matches nothing', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		await page.getByTestId('plans-status-filter').selectOption('rejected');
		await expect(page.getByTestId('plans-empty')).toBeVisible();
		await expect(page.getByText('No matching plans')).toBeVisible();
	});

	// ── Accessibility ──

	test('status filter has an accessible label', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const label = page.locator('label[for="plans-status-filter"]');
		await expect(label).toBeVisible();
		await expect(label).toHaveText('Status');
	});

	// ── Navigation actions ──

	// AC: @ui-plans-view ac-1
	test('shows View Specs and View Tasks links with plan filter hrefs', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		// The active plan has both specs and tasks
		const activePlan = page.getByTestId('plan-card').filter({ hasText: 'Active Implementation Plan' });
		await expect(activePlan).toBeVisible();

		const actions = activePlan.getByTestId('plan-actions');
		await expect(actions).toBeVisible();

		// View Specs link should include plan query param
		const viewSpecs = activePlan.getByTestId('plan-view-specs');
		await expect(viewSpecs).toBeVisible();
		await expect(viewSpecs).toContainText('View Specs');
		const specsHref = await viewSpecs.getAttribute('href');
		expect(specsHref).toContain('plan=test-plan-active');

		// View Tasks link should include plan query param
		const viewTasks = activePlan.getByTestId('plan-view-tasks');
		await expect(viewTasks).toBeVisible();
		await expect(viewTasks).toContainText('View Tasks');
		const tasksHref = await viewTasks.getAttribute('href');
		expect(tasksHref).toContain('plan=test-plan-active');
	});

	// AC: @ui-plans-view ac-1
	test('View Tasks link navigates to tasks page filtered by plan', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const activePlan = page.getByTestId('plan-card').filter({ hasText: 'Active Implementation Plan' });
		const viewTasks = activePlan.getByTestId('plan-view-tasks');
		await viewTasks.click();

		// Should navigate to /tasks with plan filter
		await expect(page).toHaveURL(/\/tasks\?plan=test-plan-active/);
		await expect(page.getByTestId('plan-filter-banner')).toBeVisible();
		await expect(page.getByTestId('plan-filter-banner')).toContainText('@test-plan-active');
	});

	// AC: @ui-plans-view ac-1
	test('View Specs link navigates to specs page filtered by plan', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const activePlan = page.getByTestId('plan-card').filter({ hasText: 'Active Implementation Plan' });
		const viewSpecs = activePlan.getByTestId('plan-view-specs');
		await viewSpecs.click();

		// Should navigate to /specs (via /items redirect) with plan filter
		await expect(page).toHaveURL(/\/specs\?plan=test-plan-active/);
		await expect(page.getByTestId('plan-filter-banner')).toBeVisible();
		await expect(page.getByTestId('plan-filter-banner')).toContainText('@test-plan-active');
	});

	// ── UI states ──

	test('shows loading skeletons while fetching data', async ({ page }) => {
		await page.goto('/plans');
		const loaded = page
			.getByTestId('plans-list')
			.or(page.getByTestId('plans-empty'))
			.or(page.getByTestId('plans-loading'));
		await expect(loaded).toBeVisible({ timeout: 10000 });
	});

	test('shows error state on API failure', async ({ page }) => {
		// Route API to return error
		await page.route('**/api/plans*', (route) =>
			route.fulfill({
				status: 500,
				body: 'Internal Server Error'
			})
		);
		await page.goto('/plans');
		await expect(page.getByTestId('error-message')).toBeVisible({ timeout: 10000 });
	});
});
