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

	// ── AC: @ui-plans-view ac-2 — Expandable plan content rendered as formatted markdown, loaded on demand ──

	// AC: @ui-plans-view ac-2
	test('shows expand toggle button on each plan card', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const cards = page.getByTestId('plan-card');
		const count = await cards.count();
		expect(count).toBeGreaterThan(0);

		// Each card should have a "Show Content" expand toggle
		for (let i = 0; i < count; i++) {
			const card = cards.nth(i);
			const toggle = card.getByTestId('plan-expand-toggle');
			await expect(toggle).toBeVisible();
			await expect(toggle).toContainText('Show Content');
		}
	});

	// AC: @ui-plans-view ac-2
	test('clicking expand toggle loads and renders plan content as markdown', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const activePlan = page.getByTestId('plan-card').filter({ hasText: 'Active Implementation Plan' });
		await expect(activePlan).toBeVisible();

		// Click expand toggle
		const toggle = activePlan.getByTestId('plan-expand-toggle');
		await toggle.click();

		// Content section should appear with rendered markdown
		const contentSection = activePlan.getByTestId('plan-content-section');
		await expect(contentSection).toBeVisible({ timeout: 10000 });

		const rendered = activePlan.getByTestId('plan-content-rendered');
		await expect(rendered).toBeVisible();

		// Fixture content is "# Active Plan\nThis plan is actively being implemented."
		// Rendered as markdown, should have an h1 and paragraph text
		await expect(rendered.locator('h1')).toContainText('Active Plan');
		await expect(rendered).toContainText('actively being implemented');
	});

	// AC: @ui-plans-view ac-2
	test('toggle button text changes to Hide Content when expanded', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const activePlan = page.getByTestId('plan-card').filter({ hasText: 'Active Implementation Plan' });
		const toggle = activePlan.getByTestId('plan-expand-toggle');

		await expect(toggle).toContainText('Show Content');
		await toggle.click();

		// Wait for content to load
		await expect(activePlan.getByTestId('plan-content-rendered')).toBeVisible({ timeout: 10000 });

		// Button should now say "Hide Content"
		await expect(toggle).toContainText('Hide Content');
	});

	// AC: @ui-plans-view ac-2
	test('clicking Hide Content collapses the content section', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const activePlan = page.getByTestId('plan-card').filter({ hasText: 'Active Implementation Plan' });
		const toggle = activePlan.getByTestId('plan-expand-toggle');

		// Expand
		await toggle.click();
		await expect(activePlan.getByTestId('plan-content-section')).toBeVisible({ timeout: 10000 });

		// Collapse
		await toggle.click();
		await expect(activePlan.getByTestId('plan-content-section')).not.toBeVisible();

		// Button should revert to "Show Content"
		await expect(toggle).toContainText('Show Content');
	});

	// AC: @ui-plans-view ac-2
	test('expand toggle has correct aria attributes', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const activePlan = page.getByTestId('plan-card').filter({ hasText: 'Active Implementation Plan' });
		const toggle = activePlan.getByTestId('plan-expand-toggle');

		// Initially not expanded
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');

		// Click to expand
		await toggle.click();
		await expect(activePlan.getByTestId('plan-content-section')).toBeVisible({ timeout: 10000 });
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	});

	// AC: @ui-plans-view ac-2
	test('content is cached after first load — re-expand does not show loading state', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		const activePlan = page.getByTestId('plan-card').filter({ hasText: 'Active Implementation Plan' });
		const toggle = activePlan.getByTestId('plan-expand-toggle');

		// First expand — content loads
		await toggle.click();
		await expect(activePlan.getByTestId('plan-content-rendered')).toBeVisible({ timeout: 10000 });

		// Collapse
		await toggle.click();
		await expect(activePlan.getByTestId('plan-content-section')).not.toBeVisible();

		// Re-expand — should show content immediately without loading skeleton
		await toggle.click();
		await expect(activePlan.getByTestId('plan-content-rendered')).toBeVisible();
		// Loading skeleton should not appear for cached content
		await expect(activePlan.getByTestId('plan-content-loading')).not.toBeVisible();
	});

	// AC: @ui-plans-view ac-2
	test('shows error state when plan content API fails', async ({ page }) => {
		const plansList = page.getByTestId('plans-list');
		await expect(plansList).toBeVisible({ timeout: 10000 });

		// Intercept the detail endpoint to return an error
		await page.route('**/api/plans/test-plan-active', (route) =>
			route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ error: 'internal_error', message: 'Failed to load plan' })
			})
		);

		const activePlan = page.getByTestId('plan-card').filter({ hasText: 'Active Implementation Plan' });
		const toggle = activePlan.getByTestId('plan-expand-toggle');
		await toggle.click();

		// Should show error state
		const errorEl = activePlan.getByTestId('plan-content-error');
		await expect(errorEl).toBeVisible({ timeout: 10000 });
	});

	// ── AC: @ui-plans-view ac-2 — API endpoint tests ──

	// AC: @ui-plans-view ac-2
	test('GET /api/plans/:ref returns plan detail with content', async ({ request, daemon }) => {
		const response = await request.get(`${daemon.baseUrl}/api/plans/test-plan-active`, {
			headers: { 'X-Kspec-Dir': daemon.tempDir }
		});

		expect(response.status()).toBe(200);

		const body = await response.json();

		// Should have all PlanSummary fields
		expect(body).toHaveProperty('_ulid', '01KG0RRPCA45ZT43W2T6HJMVP1');
		expect(body).toHaveProperty('title', 'Active Implementation Plan');
		expect(body).toHaveProperty('status', 'active');
		expect(body).toHaveProperty('slugs');
		expect(body.slugs).toContain('test-plan-active');
		expect(body).toHaveProperty('task_progress');
		expect(body).toHaveProperty('spec_count');
		expect(body).toHaveProperty('task_count');

		// Should include content field (the key AC-2 requirement)
		expect(body).toHaveProperty('content');
		expect(body.content).toContain('Active Plan');
		expect(body.content).toContain('actively being implemented');
	});

	// AC: @ui-plans-view ac-2
	test('GET /api/plans/:ref returns 404 for non-existent plan', async ({ request, daemon }) => {
		const response = await request.get(`${daemon.baseUrl}/api/plans/non-existent-plan`, {
			headers: { 'X-Kspec-Dir': daemon.tempDir }
		});

		expect(response.status()).toBe(404);

		const body = await response.json();
		expect(body).toHaveProperty('error', 'not_found');
	});

	// AC: @ui-plans-view ac-2
	test('GET /api/plans/:ref works with ULID reference', async ({ request, daemon }) => {
		const response = await request.get(`${daemon.baseUrl}/api/plans/01KG0RRPCA45ZT43W2T6HJMVP1`, {
			headers: { 'X-Kspec-Dir': daemon.tempDir }
		});

		expect(response.status()).toBe(200);

		const body = await response.json();
		expect(body).toHaveProperty('title', 'Active Implementation Plan');
		expect(body).toHaveProperty('content');
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
