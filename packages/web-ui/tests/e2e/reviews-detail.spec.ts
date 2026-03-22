/**
 * E2E Tests for Review Detail Page
 *
 * Tests verify the /reviews/[id] page renders correctly with all sections.
 * Uses route mocking for reliable, deterministic page rendering tests.
 *
 * Covered ACs:
 * - @review-records-web-ui ac-2: Detail page shows threads, checks, verdicts, disposition
 * - @review-records-web-ui ac-8: Markdown rendering with syntax highlighting
 * - @review-records-web-ui ac-9: Author identity and relative timestamp on entries
 * - @review-records-web-ui ac-10: Empty state messages for sections with no items
 * - @review-records-web-ui ac-11: Revision dropdown for same-subject reviews
 */

import { test, expect } from '../fixtures/test-base';

const REVIEW_ULID = '01KKTX0CA45ZT43W2T6HJMVA01';
const SIBLING_ULID = '01KKV0TCA45ZT43W2T6HJMVB03';

/** Full review detail with threads, checks, and verdicts */
function mockReviewDetail() {
	return {
		_ulid: REVIEW_ULID,
		slugs: ['test-review-open'],
		title: 'Review of test task',
		lifecycle_state: 'open',
		disposition: 'changes_requested',
		subject: {
			type: 'task',
			ref: '@test-task-pending-review',
			shadow_commit: 'abc1234',
			content_hash: 'hash123',
		},
		author: 'reviewer@test.com',
		related_refs: [],
		threads: [
			{
				_ulid: '01KKTX1CA45ZT43W2T6HJMVA02',
				kind: 'blocker',
				entries: [
					{
						_ulid: '01KKTX2CA45ZT43W2T6HJMVA03',
						author: 'reviewer@test.com',
						body: 'Missing error handling for edge case',
						created_at: '2026-03-15T10:00:00Z',
					},
				],
			},
			{
				_ulid: '01KKTX3CA45ZT43W2T6HJMVA04',
				kind: 'nit',
				entries: [
					{
						_ulid: '01KKTX4CA45ZT43W2T6HJMVA05',
						author: 'reviewer@test.com',
						body: 'Consider renaming this variable',
						created_at: '2026-03-15T10:05:00Z',
					},
				],
			},
			{
				_ulid: '01KKTX5CA45ZT43W2T6HJMVA06',
				kind: 'question',
				resolved_at: '2026-03-15T11:00:00Z',
				resolved_by: 'worker@test.com',
				entries: [
					{
						_ulid: '01KKTX6CA45ZT43W2T6HJMVA07',
						author: 'reviewer@test.com',
						body: 'Why was this approach chosen?',
						created_at: '2026-03-15T10:10:00Z',
					},
					{
						_ulid: '01KKTX7CA45ZT43W2T6HJMVA08',
						author: 'worker@test.com',
						body: 'Because it handles concurrent writes better',
						created_at: '2026-03-15T10:30:00Z',
					},
				],
			},
			{
				_ulid: '01KKV0RCA45ZT43W2T6HJMVB01',
				kind: 'blocker',
				entries: [
					{
						_ulid: '01KKV0SCA45ZT43W2T6HJMVB02',
						author: 'reviewer@test.com',
						body: 'Found a **critical bug** in `validateInput()`:\n\n```typescript\nif (input.length > MAX_LENGTH) {\n  return null; // should throw Error\n}\n```\n\nThis silently returns `null` instead of throwing.',
						created_at: '2026-03-15T10:15:00Z',
					},
				],
			},
		],
		checks: [
			{
				name: 'vitest',
				status: 'pass',
				required: true,
				runner: 'vitest',
				evidence: 'All 342 tests passed',
				applies_to_version: { type: 'entity_version', content_hash: 'hash123' },
				created_at: '2026-03-15T10:30:00Z',
			},
			{
				name: 'lint',
				status: 'fail',
				required: true,
				runner: 'eslint',
				evidence: '3 errors found',
				applies_to_version: { type: 'entity_version', content_hash: 'hash123' },
				created_at: '2026-03-15T10:31:00Z',
			},
			{
				name: 'coverage',
				status: 'pass',
				required: false,
				runner: 'vitest',
				evidence: '87% coverage',
				applies_to_version: { type: 'entity_version', content_hash: 'stale-hash' },
				created_at: '2026-03-15T09:00:00Z',
			},
		],
		verdicts: [
			{
				reviewer: 'reviewer@test.com',
				role: 'reviewer',
				decision: 'request_changes',
				applies_to_version: { type: 'entity_version', content_hash: 'hash123' },
				created_at: '2026-03-15T11:00:00Z',
			},
		],
		events: [],
		notes: [],
		external_links: [],
		examined_commit: null,
		created_at: '2026-03-15T09:00:00Z',
		updated_at: '2026-03-15T11:00:00Z',
	};
}

/** Empty review for testing empty states */
function mockEmptyReview() {
	return {
		_ulid: '01KKTX9CA45ZT43W2T6HJMVA10',
		slugs: ['test-review-draft'],
		title: 'Draft review',
		lifecycle_state: 'draft',
		disposition: 'pending',
		subject: {
			type: 'task',
			ref: '@test-task-ready',
			shadow_commit: 'def5678',
			content_hash: 'hash456',
		},
		author: 'reviewer@test.com',
		related_refs: [],
		threads: [],
		checks: [],
		verdicts: [],
		events: [],
		notes: [],
		external_links: [],
		examined_commit: null,
		created_at: '2026-03-15T08:00:00Z',
		updated_at: null,
	};
}

/** Sibling reviews for revision selector test */
function mockSiblingReviews() {
	return {
		items: [
			{
				_ulid: REVIEW_ULID,
				slugs: ['test-review-open'],
				title: 'Review of test task',
				lifecycle_state: 'open',
				disposition: 'changes_requested',
				subject_type: 'task',
				subject_ref: '@test-task-pending-review',
				author: 'reviewer@test.com',
				related_refs: [],
				thread_count: 4,
				unresolved_blocker_count: 2,
				check_count: 3,
				verdict_count: 1,
				created_at: '2026-03-15T09:00:00Z',
				updated_at: '2026-03-15T11:00:00Z',
			},
			{
				_ulid: SIBLING_ULID,
				slugs: ['test-review-sibling'],
				title: 'Review of test task (cycle 2)',
				lifecycle_state: 'closed',
				disposition: 'approved',
				subject_type: 'task',
				subject_ref: '@test-task-pending-review',
				author: 'reviewer@test.com',
				related_refs: [],
				thread_count: 0,
				unresolved_blocker_count: 0,
				check_count: 0,
				verdict_count: 1,
				created_at: '2026-03-16T12:00:00Z',
				updated_at: '2026-03-16T14:00:00Z',
			},
		],
		total: 2,
		offset: 0,
		limit: 2,
	};
}

function routeDetailMock(reviewData: ReturnType<typeof mockReviewDetail>) {
	return (route: any) => {
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(reviewData),
		});
	};
}

function routeSiblingsMock(siblingData: ReturnType<typeof mockSiblingReviews>) {
	return (route: any) => {
		const url = new URL(route.request().url());
		const subjectType = url.searchParams.get('subject_type');

		// Filter by subject_type if specified
		let items = siblingData.items;
		if (subjectType) {
			items = items.filter((r) => r.subject_type === subjectType);
		}

		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ...siblingData, items, total: items.length }),
		});
	};
}

test.describe('Review Detail Page', () => {
	test.describe('Header and Metadata', () => {
		// AC: @review-records-web-ui ac-2 — Review detail shows title and badges
		test('displays review title and disposition badge', async ({ page, daemon }) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			await expect(page.getByTestId('review-title')).toHaveText('Review of test task');
			await expect(page.getByTestId('review-disposition-badge')).toContainText('Changes Requested');
			await expect(page.getByTestId('review-lifecycle-badge')).toContainText('Open');
		});

		// AC: @review-records-web-ui ac-2 — Subject info with type and ref
		test('displays subject type and ref link', async ({ page, daemon }) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			await expect(page.getByTestId('review-subject-info')).toContainText('Task');
			await expect(page.getByTestId('review-subject-link')).toBeVisible();
		});

		// AC: @review-records-web-ui ac-9 — Author and timestamp displayed
		test('displays author and creation time', async ({ page, daemon }) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			await expect(page.getByTestId('review-author')).toContainText('reviewer@test.com');
			await expect(page.getByTestId('review-created-at')).toBeVisible();
		});

		test('has back navigation to reviews list', async ({ page, daemon }) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			const backLink = page.getByTestId('back-to-reviews');
			await expect(backLink).toBeVisible();
			await expect(backLink).toHaveAttribute('href', /\/reviews$/);
		});
	});

	test.describe('Threads Section', () => {
		// AC: @review-records-web-ui ac-2 — Threads displayed with entries, resolution state, kind badges
		test('displays threads with kind badges and entries', async ({ page, daemon }) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			await expect(page.getByTestId('threads-section')).toBeVisible();

			// Unresolved threads shown directly (3: 2 blockers + 1 nit)
			const threadItems = page.getByTestId('thread-item');
			// 3 unresolved directly visible + 1 resolved in details (but details collapsed)
			await expect(threadItems).toHaveCount(3);
		});

		// AC: @review-records-web-ui ac-2 — Kind badges with correct labels
		test('shows correct kind badges (blocker, question, nit)', async ({ page, daemon }) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			const kindBadges = page.getByTestId('thread-kind-badge');
			// 3 unresolved visible: 2 Blocker + 1 Nit
			const badgeTexts: string[] = [];
			const count = await kindBadges.count();
			for (let i = 0; i < count; i++) {
				badgeTexts.push(await kindBadges.nth(i).textContent() ?? '');
			}
			expect(badgeTexts.filter((t) => t.includes('Blocker')).length).toBe(2);
			expect(badgeTexts.filter((t) => t.includes('Nit')).length).toBe(1);
		});

		// AC: @review-records-web-ui ac-2 — Resolution state shown
		test('shows resolved threads in collapsible section', async ({ page, daemon }) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			// Resolved threads toggle should exist
			const toggle = page.getByTestId('resolved-threads-toggle');
			await expect(toggle).toBeVisible();
			await expect(toggle).toContainText('1 resolved thread');

			// Click to expand
			await toggle.click();

			// Now the resolved thread should be visible
			const allThreads = page.getByTestId('thread-item');
			await expect(allThreads).toHaveCount(4);
		});

		// AC: @review-records-web-ui ac-9 — Author and timestamp on thread entries
		test('shows author and relative timestamp on thread entries', async ({ page, daemon }) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			const entryAuthors = page.getByTestId('entry-author');
			await expect(entryAuthors.first()).toContainText('reviewer@test.com');

			const entryTimestamps = page.getByTestId('entry-timestamp');
			await expect(entryTimestamps.first()).toBeVisible();
		});

		// AC: @review-records-web-ui ac-8 — Markdown rendering in thread bodies
		test('renders markdown with syntax highlighting in thread bodies', async ({ page, daemon }) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			// The 4th thread (index 2 in visible, 0-based) has markdown with code block
			// Find the thread with markdown content
			const entryBodies = page.getByTestId('entry-body');

			// One of the entries should have rendered HTML with <strong> (from **critical bug**)
			const markdownEntry = page.locator('[data-testid="entry-body"] strong');
			await expect(markdownEntry.first()).toBeVisible();

			// Should have rendered code block with <pre><code>
			const codeBlock = page.locator('[data-testid="entry-body"] pre code');
			await expect(codeBlock.first()).toBeVisible();

			// Should have rendered inline code with <code> for `validateInput()`
			const inlineCode = page.locator('[data-testid="entry-body"] code:not(pre code)');
			await expect(inlineCode.first()).toBeVisible();
		});
	});

	test.describe('Checks Section', () => {
		// AC: @review-records-web-ui ac-2 — Checks show pass/fail with staleness
		test('displays checks with pass/fail status', async ({ page, daemon }) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			await expect(page.getByTestId('checks-section')).toBeVisible();
			const checkItems = page.getByTestId('check-item');
			await expect(checkItems).toHaveCount(3);

			// Check names visible
			const checkNames = page.getByTestId('check-name');
			await expect(checkNames.nth(0)).toHaveText('vitest');
			await expect(checkNames.nth(1)).toHaveText('lint');
			await expect(checkNames.nth(2)).toHaveText('coverage');

			// Status badges
			const statusBadges = page.getByTestId('check-status-badge');
			await expect(statusBadges.nth(0)).toContainText('Pass');
			await expect(statusBadges.nth(1)).toContainText('Fail');
			await expect(statusBadges.nth(2)).toContainText('Pass');
		});

		// AC: @review-records-web-ui ac-2 — Staleness indicator on checks
		test('shows stale badge on checks with non-matching version', async ({ page, daemon }) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			// Third check (coverage) has content_hash "stale-hash" but subject has "hash123"
			const staleBadges = page.getByTestId('check-stale-badge');
			await expect(staleBadges).toHaveCount(1);
			await expect(staleBadges.first()).toContainText('Stale');
		});

		// AC: @review-records-web-ui ac-2 — Check evidence displayed
		test('shows evidence text for checks', async ({ page, daemon }) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			const evidence = page.getByTestId('check-evidence');
			await expect(evidence.first()).toContainText('All 342 tests passed');
		});
	});

	test.describe('Verdicts Section', () => {
		// AC: @review-records-web-ui ac-2 — Verdicts show reviewer decisions
		test('displays verdicts with reviewer and decision', async ({ page, daemon }) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			await expect(page.getByTestId('verdicts-section')).toBeVisible();
			const verdictItems = page.getByTestId('verdict-item');
			await expect(verdictItems).toHaveCount(1);

			await expect(page.getByTestId('verdict-decision-badge').first()).toContainText('Changes Requested');
			await expect(page.getByTestId('verdict-reviewer').first()).toContainText('reviewer@test.com');
			await expect(page.getByTestId('verdict-timestamp').first()).toBeVisible();
		});
	});

	test.describe('Empty States', () => {
		// AC: @review-records-web-ui ac-10 — Empty state for threads
		test('shows empty state when review has no threads', async ({ page, daemon }) => {
			const detail = mockEmptyReview();
			await page.route(`**/api/reviews/${detail._ulid}`, routeDetailMock(detail as any));
			await page.route('**/api/reviews?*', (route: any) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ items: [], total: 0, offset: 0, limit: 0 }),
				});
			});
			await page.goto(`/reviews/${detail._ulid}`);

			await expect(page.getByTestId('threads-empty')).toBeVisible();
			await expect(page.getByTestId('threads-empty')).toContainText('No threads yet');
		});

		// AC: @review-records-web-ui ac-10 — Empty state for checks
		test('shows empty state when review has no checks', async ({ page, daemon }) => {
			const detail = mockEmptyReview();
			await page.route(`**/api/reviews/${detail._ulid}`, routeDetailMock(detail as any));
			await page.route('**/api/reviews?*', (route: any) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ items: [], total: 0, offset: 0, limit: 0 }),
				});
			});
			await page.goto(`/reviews/${detail._ulid}`);

			await expect(page.getByTestId('checks-empty')).toBeVisible();
			await expect(page.getByTestId('checks-empty')).toContainText('No checks recorded');
		});

		// AC: @review-records-web-ui ac-10 — Empty state for verdicts
		test('shows empty state when review has no verdicts', async ({ page, daemon }) => {
			const detail = mockEmptyReview();
			await page.route(`**/api/reviews/${detail._ulid}`, routeDetailMock(detail as any));
			await page.route('**/api/reviews?*', (route: any) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ items: [], total: 0, offset: 0, limit: 0 }),
				});
			});
			await page.goto(`/reviews/${detail._ulid}`);

			await expect(page.getByTestId('verdicts-empty')).toBeVisible();
			await expect(page.getByTestId('verdicts-empty')).toContainText('No verdicts yet');
		});
	});

	test.describe('Revision Selector', () => {
		// AC: @review-records-web-ui ac-11 — Revision dropdown for same-subject reviews
		test('shows revision selector when multiple reviews exist for same subject', async ({
			page,
			daemon,
		}) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			const selector = page.getByTestId('revision-selector');
			await expect(selector).toBeVisible();

			const dropdown = selector.locator('select');
			const options = dropdown.locator('option');
			await expect(options).toHaveCount(2);

			// First option: current review
			await expect(options.nth(0)).toContainText('Review of test task');
			// Second option: sibling review
			await expect(options.nth(1)).toContainText('Review of test task (cycle 2)');
		});

		// AC: @review-records-web-ui ac-11 — Selecting a revision navigates to it
		test('navigating to a sibling review changes the URL', async ({ page, daemon }) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			await page.route(`**/api/reviews/${SIBLING_ULID}`, routeDetailMock({
				...detail,
				_ulid: SIBLING_ULID,
				slugs: ['test-review-sibling'],
				title: 'Review of test task (cycle 2)',
			}));
			await page.route('**/api/reviews?*', routeSiblingsMock(mockSiblingReviews()));
			await page.goto(`/reviews/${REVIEW_ULID}`);

			const selector = page.getByTestId('revision-selector');
			await expect(selector).toBeVisible();

			// Select the sibling review
			const dropdown = selector.locator('select');
			await dropdown.selectOption(SIBLING_ULID);

			// URL should change
			await page.waitForURL(`**/reviews/${SIBLING_ULID}`);
		});

		// AC: @review-records-web-ui ac-11 — No selector when only one review
		test('hides revision selector when only one review exists for subject', async ({
			page,
			daemon,
		}) => {
			const detail = mockReviewDetail();
			await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
			// Return only one review in siblings
			await page.route('**/api/reviews?*', (route: any) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						items: [mockSiblingReviews().items[0]],
						total: 1,
						offset: 0,
						limit: 1,
					}),
				});
			});
			await page.goto(`/reviews/${REVIEW_ULID}`);

			// Wait for content to render
			await expect(page.getByTestId('review-title')).toBeVisible();
			// Selector should not be visible
			await expect(page.getByTestId('revision-selector')).not.toBeVisible();
		});
	});

	test.describe('Error Handling', () => {
		test('shows error message when review not found', async ({ page, daemon }) => {
			await page.route('**/api/reviews/nonexistent*', (route: any) => {
				route.fulfill({
					status: 404,
					contentType: 'application/json',
					body: JSON.stringify({
						error: 'not_found',
						message: 'Review "nonexistent" not found',
					}),
				});
			});
			await page.goto('/reviews/nonexistent');

			await expect(page.getByTestId('error-message')).toBeVisible();
		});
	});
});
