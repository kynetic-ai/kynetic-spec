import * as fs from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/test-base';

test.describe('Plans View', () => {
	test.beforeEach(async ({ page, daemon }) => {
		await page.goto('/plans');
		await expect(page.getByRole('heading', { name: 'Plans', exact: true })).toBeVisible();
	});

	const MISMATCHED_EMBEDDED_PLAN_CONTENT = `# Active Plan
This plan is actively being implemented.

## Specs

\`\`\`yaml
- title: Unknown Spec
  slug: not-derived
  type: feature
\`\`\`

## Implementation Notes

Fallback should keep this YAML visible.
`;

	const LIVE_EMBEDDED_PLAN_CONTENT = `# Active Plan
This plan is actively being implemented.

## Specs

\`\`\`yaml
- title: Test Feature
  type: feature
\`\`\`

## Tasks

derive_from_specs: true

\`\`\`yaml
- title: Add markdown rendering trait to existing specs
  slug: test-task-ready
  priority: 2
\`\`\`

## Implementation Notes

Runtime fetch coverage should observe the real batch request.
`;

	const EMBEDDED_BATCH_ITEMS = [
		{
			kind: 'item',
			ulid: '01KF1645CBDJYHWBPYWRN3HYPJ',
			slugs: ['test-feature'],
			title: 'Test Feature',
			type: 'feature',
			status: 'in_progress',
			maturity: 'draft',
			traits: ['@test-trait'],
			ac_count: 2
		},
		{
			kind: 'task',
			ulid: '01KG0RR8CB8N4YGP991WD7XS9R',
			slugs: ['test-task-in-progress'],
			title: 'In progress task',
			status: 'in_progress',
			priority: 3,
			spec_ref: '@test-feature'
		},
		{
			kind: 'task',
			ulid: '01KG0RRFCC9N4YGP991WD7XSCP',
			slugs: ['test-task-completed'],
			title: 'Completed task',
			status: 'completed',
			priority: 3,
			spec_ref: '@test-feature'
		},
		{
			kind: 'task',
			ulid: '01KG0RR6CA45ZT43W2T6HJMVA1',
			slugs: ['test-task-ready'],
			title: 'Ready task',
			status: 'pending',
			priority: 2,
			spec_ref: '@test-feature',
			assignee: '@alice'
		}
	];

	async function stubActivePlanContent(page: Page, content: string) {
		await page.route('**/api/plans/test-plan-active', async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			await route.fulfill({
				status: response.status(),
				contentType: 'application/json',
				body: JSON.stringify({ ...body, content })
			});
		});
	}

	async function expandActivePlan(page: Page) {
		const activePlan = page.getByTestId('plan-card').filter({ hasText: 'Active Implementation Plan' });
		await expect(activePlan).toBeVisible();
		await activePlan.getByTestId('plan-expand-toggle').click();
		await expect(activePlan.getByTestId('plan-content-section')).toBeVisible({ timeout: 10000 });
		return activePlan;
	}

	async function stubEmbeddedBatchItems(page: Page) {
		await page.route('**/api/items/batch', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ items: EMBEDDED_BATCH_ITEMS, unresolved: [] })
			});
		});
	}

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

		const rendered = activePlan.getByTestId('plan-content-rendered').first();
		await expect(rendered).toBeVisible();

		// The first markdown block preserves the intro prose even when later
		// sections are replaced by embedded spec/task cards.
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
		await expect(activePlan.getByTestId('plan-content-rendered').first()).toBeVisible({
			timeout: 10000
		});

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
		await expect(activePlan.getByTestId('plan-content-rendered').first()).toBeVisible({
			timeout: 10000
		});

		// Collapse
		await toggle.click();
		await expect(activePlan.getByTestId('plan-content-section')).not.toBeVisible();

		// Re-expand — should show content immediately without loading skeleton
		await toggle.click();
		await expect(activePlan.getByTestId('plan-content-rendered').first()).toBeVisible();
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

	// ── AC: @plan-embedded-views ac-1..ac-8 — Embedded spec/task cards inside rendered plan markdown ──

	// AC: @plan-embedded-views ac-1
	// AC: @plan-embedded-views ac-8
	test('renders embedded spec cards alongside surrounding markdown prose', async ({ page }) => {
		await stubEmbeddedBatchItems(page);
		const activePlan = await expandActivePlan(page);

		const specCard = activePlan
			.getByTestId('plan-embedded-spec-card')
			.filter({ hasText: 'Test Feature' });
		await expect(specCard).toBeVisible({ timeout: 10000 });
		await expect(specCard).toContainText('feature');
		await expect(specCard).toContainText('In Progress');
		await expect(specCard).toContainText('Draft');
		await expect(specCard).toContainText('@test-trait');
		await expect(specCard).toContainText('2 ACs');

		const notesBlock = activePlan
			.getByTestId('plan-content-rendered')
			.filter({ hasText: 'Implementation Notes' });
		await expect(notesBlock.locator('h2')).toContainText('Implementation Notes');
		await expect(notesBlock.locator('code')).toContainText('npm test');
	});

	// AC: @plan-embedded-views ac-2
	test('renders derived task cards from fenced derive_from_specs content with task metadata', async ({
		page
	}) => {
		await stubEmbeddedBatchItems(page);
		const activePlan = await expandActivePlan(page);

		const taskCards = activePlan.getByTestId('plan-embedded-task-card');
		await expect(taskCards).toHaveCount(3, { timeout: 10000 });

		const readyTaskCard = taskCards.filter({ hasText: 'Ready task' });
		await expect(readyTaskCard).toBeVisible();
		await expect(readyTaskCard).toContainText('Pending');
		await expect(readyTaskCard).toContainText('P2');
		await expect(readyTaskCard).toContainText('@alice');
	});

	// AC: @plan-embedded-views ac-1
	// AC: @plan-embedded-views ac-2
	// AC: @plan-embedded-views ac-9
	test('issues the live batch fetch and renders title-derived specs plus full derive_from_specs tasks', async ({
		page
	}) => {
		await stubActivePlanContent(page, LIVE_EMBEDDED_PLAN_CONTENT);

		const batchRequests: string[][] = [];
		await page.route('**/api/items/batch', async (route) => {
			const body = route.request().postDataJSON() as { refs?: string[] };
			batchRequests.push(body.refs ?? []);
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ items: EMBEDDED_BATCH_ITEMS, unresolved: [] })
			});
		});

		const activePlan = await expandActivePlan(page);
		await page.waitForRequest('**/api/items/batch');

		expect(batchRequests).toHaveLength(1);
		expect(batchRequests[0]).toEqual(
			expect.arrayContaining([
				'@test-feature',
				'@test-task-in-progress',
				'@test-task-completed',
				'@test-task-ready'
			])
		);

		const specCard = activePlan
			.getByTestId('plan-embedded-spec-card')
			.filter({ hasText: 'Test Feature' });
		await expect(specCard).toBeVisible({ timeout: 10000 });

		const taskCards = activePlan.getByTestId('plan-embedded-task-card');
		await expect(taskCards).toHaveCount(3, { timeout: 10000 });
	});

	// AC: @plan-embedded-views ac-3
	test('clicking an embedded spec card navigates to the spec detail route', async ({ page }) => {
		await stubEmbeddedBatchItems(page);
		const activePlan = await expandActivePlan(page);

		const specCard = activePlan
			.getByTestId('plan-embedded-spec-card')
			.filter({ hasText: 'Test Feature' });
		await Promise.all([
			page.waitForURL(/\/specs\?ref=test-feature/, { timeout: 10000 }),
			specCard.click()
		]);
		await expect(page.getByRole('heading', { name: 'Spec Items' })).toBeVisible();
		await expect(page).toHaveURL(/\/specs\?ref=test-feature/);
		await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
	});

	// AC: @plan-embedded-views ac-3
	test('clicking an embedded task card opens the task detail view', async ({ page }) => {
		await stubEmbeddedBatchItems(page);
		const activePlan = await expandActivePlan(page);

		const taskCard = activePlan
			.getByTestId('plan-embedded-task-card')
			.filter({ hasText: 'Ready task' });
		await Promise.all([
			page.waitForURL(/\/tasks\?ref=test-task-ready/, { timeout: 10000 }),
			taskCard.click()
		]);

		const detailPanel = page.getByTestId('task-detail-panel');
		await expect(detailPanel).toBeVisible();
		await expect(detailPanel.getByTestId('task-detail-title')).toContainText('Ready task');
	});

	// AC: @plan-embedded-views ac-4
	test('falls back to rendered yaml code blocks when embedded refs do not match derived refs', async ({
		page
	}) => {
		await stubActivePlanContent(page, MISMATCHED_EMBEDDED_PLAN_CONTENT);
		const activePlan = await expandActivePlan(page);

		await expect(activePlan.getByTestId('plan-embedded-spec-card')).toHaveCount(0);
		await expect(activePlan.getByTestId('plan-content-rendered').locator('pre code')).toContainText(
			'slug: not-derived'
		);
	});

	// AC: @plan-embedded-views ac-5
	test('shows embedded loading skeletons while batch item summaries are still loading', async ({
		page
	}) => {
		let releaseBatch: (() => void) | undefined;
		const batchGate = new Promise<void>((resolve) => {
			releaseBatch = resolve;
		});
		await page.route('**/api/items/batch', async (route) => {
			await batchGate;
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ items: EMBEDDED_BATCH_ITEMS, unresolved: [] })
			});
		});

		const activePlan = await expandActivePlan(page);
		await expect(activePlan.getByTestId('plan-embedded-spec-loading')).toBeVisible();
		await expect(activePlan.getByTestId('plan-embedded-task-loading')).toBeVisible();

		releaseBatch?.();
		await expect(activePlan.getByTestId('plan-embedded-spec-card').first()).toBeVisible({
			timeout: 10000
		});
	});

	// AC: @plan-embedded-views ac-6
	test('shows embedded error UI and raw yaml fallback when batch item loading fails', async ({
		page
	}) => {
		await page.route('**/api/items/batch', async (route) => {
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ error: 'internal_error', message: 'Embedded batch failed' })
			});
		});

		const activePlan = await expandActivePlan(page);

		const taskError = activePlan.getByTestId('plan-embedded-task-error');
		await expect(taskError).toBeVisible({ timeout: 10000 });
		await expect(taskError).toContainText('Failed to load embedded task details');
		await expect(taskError.locator('pre code')).toContainText('derive_from_specs: true');
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

	// AC: @01KM46FW ac-1
	test('GET /api/plans/:ref excludes cancelled tasks from summary metrics', async ({ request, daemon }) => {
		const tasksPath = `${daemon.tempDir}/project.tasks.yaml`;
		const taskContent = await fs.readFile(tasksPath, 'utf-8');
		await fs.writeFile(
			tasksPath,
			taskContent.replace('status: pending', 'status: cancelled')
		);

		const response = await request.get(`${daemon.baseUrl}/api/plans/test-plan-active`, {
			headers: { 'X-Kspec-Dir': daemon.tempDir }
		});

		expect(response.status()).toBe(200);

		const body = await response.json();
		expect(body.task_count).toBe(2);
		expect(body.task_progress).toEqual({
			total: 2,
			completed: 1,
			in_progress: 1,
			pending: 0,
			blocked: 0
		});
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
