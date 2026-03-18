/**
 * E2E Tests for Code Diff Viewer
 *
 * Tests the diff viewer component on the review detail page for code reviews.
 * Uses route mocking for reliable, deterministic rendering tests.
 *
 * AC: @review-code-diff-viewer ac-1 — File list shows all changed files with diff stats, expandable
 * AC: @review-code-diff-viewer ac-2 — Unified diff with syntax highlighting, line numbers, color coding
 * AC: @review-code-diff-viewer ac-3 — Collapsed unchanged regions with "Show N more lines" expansion
 * AC: @review-code-diff-viewer ac-4 — Click-to-comment creates thread with code anchor
 * AC: @review-code-diff-viewer ac-5 — Existing threads shown inline at anchored positions
 * AC: @review-code-diff-viewer ac-6 — Lazy loading for 20+ changed files
 */

import { test, expect } from '../fixtures/test-base';

const CODE_REVIEW_ULID = '01KKV1ACA45ZT43W2T6HJMVB10';

/** Code review detail with base/head commits */
function mockCodeReviewDetail(threads: any[] = []) {
	return {
		_ulid: CODE_REVIEW_ULID,
		slugs: ['test-code-review-main-1'],
		title: 'Code review for feat/review-detail',
		lifecycle_state: 'open',
		disposition: 'pending',
		subject: {
			type: 'code',
			base_commit: 'aaa11111',
			head_commit: 'bbb22222',
			base_branch: 'dev',
			head_branch: 'feat/review-detail',
		},
		author: 'reviewer@test.com',
		related_refs: [],
		threads,
		checks: [],
		verdicts: [],
		events: [],
		notes: [],
		external_links: [],
		examined_commit: 'bbb22222',
		created_at: '2026-03-14T08:00:00Z',
		updated_at: null,
	};
}

/** Mock diff response with 3 files: added, modified, deleted */
function mockDiffResponse() {
	return {
		base: 'aaa11111',
		head: 'bbb22222',
		files: [
			{
				oldPath: 'src/utils/helper.ts',
				newPath: 'src/utils/helper.ts',
				status: 'modified',
				stats: { additions: 5, deletions: 2 },
				hunks: [
					{
						header: '@@ -10,7 +10,10 @@ function existing() {',
						oldStart: 10,
						oldCount: 7,
						newStart: 10,
						newCount: 10,
						changes: [
							{ type: 'unchanged', content: 'function existing() {', oldLineNumber: 10, newLineNumber: 10 },
							{ type: 'unchanged', content: '  const x = 1;', oldLineNumber: 11, newLineNumber: 11 },
							{ type: 'deleted', content: '  return x;', oldLineNumber: 12, newLineNumber: null },
							{ type: 'deleted', content: '}', oldLineNumber: 13, newLineNumber: null },
							{ type: 'added', content: '  const y = 2;', oldLineNumber: null, newLineNumber: 12 },
							{ type: 'added', content: '  return x + y;', oldLineNumber: null, newLineNumber: 13 },
							{ type: 'added', content: '}', oldLineNumber: null, newLineNumber: 14 },
							{ type: 'unchanged', content: '', oldLineNumber: 14, newLineNumber: 15 },
							{ type: 'added', content: 'export function newHelper() {', oldLineNumber: null, newLineNumber: 16 },
							{ type: 'added', content: '  return true;', oldLineNumber: null, newLineNumber: 17 },
						],
					},
				],
			},
			{
				oldPath: '/dev/null',
				newPath: 'src/new-file.ts',
				status: 'added',
				stats: { additions: 3, deletions: 0 },
				hunks: [
					{
						header: '@@ -0,0 +1,3 @@',
						oldStart: 0,
						oldCount: 0,
						newStart: 1,
						newCount: 3,
						changes: [
							{ type: 'added', content: 'export const VERSION = "1.0.0";', oldLineNumber: null, newLineNumber: 1 },
							{ type: 'added', content: 'export const NAME = "kspec";', oldLineNumber: null, newLineNumber: 2 },
							{ type: 'added', content: 'export default { VERSION, NAME };', oldLineNumber: null, newLineNumber: 3 },
						],
					},
				],
			},
			{
				oldPath: 'src/old-file.ts',
				newPath: '/dev/null',
				status: 'deleted',
				stats: { additions: 0, deletions: 4 },
				hunks: [
					{
						header: '@@ -1,4 +0,0 @@',
						oldStart: 1,
						oldCount: 4,
						newStart: 0,
						newCount: 0,
						changes: [
							{ type: 'deleted', content: '// deprecated module', oldLineNumber: 1, newLineNumber: null },
							{ type: 'deleted', content: 'export function old() {', oldLineNumber: 2, newLineNumber: null },
							{ type: 'deleted', content: '  return false;', oldLineNumber: 3, newLineNumber: null },
							{ type: 'deleted', content: '}', oldLineNumber: 4, newLineNumber: null },
						],
					},
				],
			},
		],
		stats: {
			totalFiles: 3,
			totalAdditions: 8,
			totalDeletions: 6,
		},
	};
}

/** Mock diff response with multiple hunks and collapsed context between them */
function mockDiffWithMultipleHunks() {
	return {
		base: 'aaa11111',
		head: 'bbb22222',
		files: [
			{
				oldPath: 'src/multi-hunk.ts',
				newPath: 'src/multi-hunk.ts',
				status: 'modified',
				stats: { additions: 2, deletions: 2 },
				hunks: [
					{
						header: '@@ -1,3 +1,3 @@',
						oldStart: 1,
						oldCount: 3,
						newStart: 1,
						newCount: 3,
						changes: [
							{ type: 'unchanged', content: 'import { foo } from "./foo";', oldLineNumber: 1, newLineNumber: 1 },
							{ type: 'deleted', content: 'const OLD = 1;', oldLineNumber: 2, newLineNumber: null },
							{ type: 'added', content: 'const NEW = 2;', oldLineNumber: null, newLineNumber: 2 },
							{ type: 'unchanged', content: '', oldLineNumber: 3, newLineNumber: 3 },
						],
					},
					{
						header: '@@ -50,3 +50,3 @@',
						oldStart: 50,
						oldCount: 3,
						newStart: 50,
						newCount: 3,
						changes: [
							{ type: 'unchanged', content: 'function update() {', oldLineNumber: 50, newLineNumber: 50 },
							{ type: 'deleted', content: '  return OLD;', oldLineNumber: 51, newLineNumber: null },
							{ type: 'added', content: '  return NEW;', oldLineNumber: null, newLineNumber: 51 },
							{ type: 'unchanged', content: '}', oldLineNumber: 52, newLineNumber: 52 },
						],
					},
				],
			},
		],
		stats: {
			totalFiles: 1,
			totalAdditions: 2,
			totalDeletions: 2,
		},
	};
}

/** Mock diff response with 21 files for lazy loading test */
function mockLargeDiffResponse() {
	const files = [];
	for (let i = 0; i < 21; i++) {
		files.push({
			oldPath: `src/file-${i}.ts`,
			newPath: `src/file-${i}.ts`,
			status: 'modified',
			stats: { additions: 1, deletions: 1 },
			// In lazy mode, hunks are empty until file is expanded
			hunks: [],
		});
	}
	return {
		base: 'aaa11111',
		head: 'bbb22222',
		files,
		stats: {
			totalFiles: 21,
			totalAdditions: 21,
			totalDeletions: 21,
		},
	};
}

/** Mock single file diff response (for lazy loading) */
function mockFileDiffResponse(index: number) {
	return {
		base: 'aaa11111',
		head: 'bbb22222',
		file: {
			oldPath: `src/file-${index}.ts`,
			newPath: `src/file-${index}.ts`,
			status: 'modified',
			stats: { additions: 1, deletions: 1 },
			hunks: [
				{
					header: '@@ -1,3 +1,3 @@',
					oldStart: 1,
					oldCount: 3,
					newStart: 1,
					newCount: 3,
					changes: [
						{ type: 'unchanged', content: '// file ' + index, oldLineNumber: 1, newLineNumber: 1 },
						{ type: 'deleted', content: 'const old = ' + index + ';', oldLineNumber: 2, newLineNumber: null },
						{ type: 'added', content: 'const updated = ' + index + ';', oldLineNumber: null, newLineNumber: 2 },
						{ type: 'unchanged', content: 'export default {};', oldLineNumber: 3, newLineNumber: 3 },
					],
				},
			],
		},
	};
}

/** Code-anchored thread at a specific line */
function mockCodeThread(id: string, path: string, lineStart: number, side: 'base' | 'head', kind: string, body: string, resolved = false) {
	return {
		_ulid: id,
		kind,
		anchor: {
			type: 'code',
			path,
			side,
			line_start: lineStart,
			line_end: lineStart,
			commit: side === 'base' ? 'aaa11111' : 'bbb22222',
		},
		...(resolved ? { resolved_at: '2026-03-15T11:00:00Z', resolved_by: 'worker@test.com' } : {}),
		entries: [
			{
				_ulid: id + '-entry-1',
				author: 'reviewer@test.com',
				body,
				created_at: '2026-03-15T10:00:00Z',
			},
		],
	};
}

/** Setup route mocks for the review detail page with a code review */
async function setupCodeReviewMocks(page: any, review: any, diff: any) {
	await page.route(`**/api/reviews/${review._ulid}`, (route: any) => {
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(review),
		});
	});

	await page.route('**/api/reviews?*', (route: any) => {
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items: [], total: 0, offset: 0, limit: 0 }),
		});
	});

	await page.route('**/api/diff?*', (route: any) => {
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(diff),
		});
	});
}

test.describe('Code Diff Viewer', () => {
	// AC: @review-code-diff-viewer ac-1
	test.describe('File List with Diff Stats (AC-1)', () => {
		test('shows file list with all changed files and their stats', async ({ page, daemon }) => {
			const review = mockCodeReviewDetail();
			const diff = mockDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			// Diff viewer section should be visible
			await expect(page.getByTestId('diff-viewer-section')).toBeVisible();
			await expect(page.getByTestId('code-diff-viewer')).toBeVisible();

			// File list should show all 3 files
			const fileList = page.getByTestId('diff-file-list');
			await expect(fileList).toBeVisible();
			await expect(page.getByTestId('diff-file-count')).toContainText('3 files changed');

			// Total stats
			await expect(page.getByTestId('diff-total-additions')).toContainText('+8');
			await expect(page.getByTestId('diff-total-deletions')).toContainText('-6');

			// Each file entry shows status and stats
			const entries = page.getByTestId('diff-file-entry');
			await expect(entries).toHaveCount(3);

			// Modified file
			const modifiedEntry = page.locator('[data-testid="diff-file-entry"][data-file-path="src/utils/helper.ts"]');
			await expect(modifiedEntry.getByTestId('diff-file-status')).toHaveText('M');

			// Added file
			const addedEntry = page.locator('[data-testid="diff-file-entry"][data-file-path="src/new-file.ts"]');
			await expect(addedEntry.getByTestId('diff-file-status')).toHaveText('A');

			// Deleted file
			const deletedEntry = page.locator('[data-testid="diff-file-entry"][data-file-path="src/old-file.ts"]');
			await expect(deletedEntry.getByTestId('diff-file-status')).toHaveText('D');
		});

		test('clicking a file in the file list expands it and shows diff content', async ({ page, daemon }) => {
			const review = mockCodeReviewDetail();
			const diff = mockDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			// File should not be expanded initially
			const fileView = page.locator('[data-testid="diff-file-view"][data-file-path="src/utils/helper.ts"]');
			await expect(fileView.getByTestId('diff-file-content')).not.toBeVisible();

			// Click the file entry in the file list
			const entry = page.locator('[data-testid="diff-file-entry"][data-file-path="src/utils/helper.ts"]');
			await entry.click();

			// File should now be expanded showing diff content
			await expect(fileView.getByTestId('diff-file-content')).toBeVisible();
			await expect(fileView.getByTestId('diff-hunk')).toBeVisible();
		});

		test('clicking file header toggles expansion', async ({ page, daemon }) => {
			const review = mockCodeReviewDetail();
			const diff = mockDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			const fileView = page.locator('[data-testid="diff-file-view"][data-file-path="src/new-file.ts"]');

			// Click to expand
			await fileView.getByTestId('diff-file-header').click();
			await expect(fileView.getByTestId('diff-file-content')).toBeVisible();

			// Click again to collapse
			await fileView.getByTestId('diff-file-header').click();
			await expect(fileView.getByTestId('diff-file-content')).not.toBeVisible();
		});
	});

	// AC: @review-code-diff-viewer ac-2
	test.describe('Unified Diff with Syntax Highlighting (AC-2)', () => {
		test('shows unified diff with old and new line numbers', async ({ page, daemon }) => {
			const review = mockCodeReviewDetail();
			const diff = mockDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			// Expand the modified file
			const fileView = page.locator('[data-testid="diff-file-view"][data-file-path="src/utils/helper.ts"]');
			await fileView.getByTestId('diff-file-header').click();
			await expect(fileView.getByTestId('diff-file-content')).toBeVisible();

			// Hunk header should be visible
			await expect(fileView.getByTestId('diff-hunk-header')).toContainText('@@ -10,7 +10,10 @@');

			// Check line numbers are present
			const lines = fileView.getByTestId('diff-line');
			await expect(lines.first()).toBeVisible();

			// Unchanged line should have both old and new line numbers
			const unchangedLine = fileView.locator('[data-testid="diff-line"][data-line-type="unchanged"]').first();
			await expect(unchangedLine.getByTestId('diff-old-line-number')).toHaveText('10');
			await expect(unchangedLine.getByTestId('diff-new-line-number')).toHaveText('10');
		});

		test('shows added lines in green and deleted lines in red', async ({ page, daemon }) => {
			const review = mockCodeReviewDetail();
			const diff = mockDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			// Expand the modified file
			const fileView = page.locator('[data-testid="diff-file-view"][data-file-path="src/utils/helper.ts"]');
			await fileView.getByTestId('diff-file-header').click();

			// Added lines should exist with proper type attribute
			const addedLines = fileView.locator('[data-testid="diff-line"][data-line-type="added"]');
			await expect(addedLines.first()).toBeVisible();
			// Added lines should only have new line number
			await expect(addedLines.first().getByTestId('diff-old-line-number')).toHaveText('');

			// Deleted lines should exist with proper type attribute
			const deletedLines = fileView.locator('[data-testid="diff-line"][data-line-type="deleted"]');
			await expect(deletedLines.first()).toBeVisible();
			// Deleted lines should only have old line number
			await expect(deletedLines.first().getByTestId('diff-new-line-number')).toHaveText('');
		});

		test('renders code content with syntax highlighting for .ts files', async ({ page, daemon }) => {
			const review = mockCodeReviewDetail();
			const diff = mockDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			// Expand the added file (TypeScript)
			const fileView = page.locator('[data-testid="diff-file-view"][data-file-path="src/new-file.ts"]');
			await fileView.getByTestId('diff-file-header').click();

			// Check that highlighted code contains hljs spans (syntax highlighting applied)
			const codeLine = fileView.locator('[data-testid="diff-line"]').first();
			// highlight.js wraps tokens in <span class="hljs-...">
			const highlightedContent = codeLine.locator('.hljs-keyword, .hljs-string, .hljs-attr, .hljs-title');
			// At least some syntax highlighting should be applied to TypeScript code
			await expect(highlightedContent.first()).toBeVisible();
		});
	});

	// AC: @review-code-diff-viewer ac-3
	test.describe('Collapsed Unchanged Regions (AC-3)', () => {
		test('shows "Show N more lines" button between hunks with collapsed context', async ({ page, daemon }) => {
			const review = mockCodeReviewDetail();
			const diff = mockDiffWithMultipleHunks();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			// Expand the multi-hunk file
			const fileView = page.locator('[data-testid="diff-file-view"][data-file-path="src/multi-hunk.ts"]');
			await fileView.getByTestId('diff-file-header').click();

			// Both hunks should be visible
			const hunks = fileView.getByTestId('diff-hunk');
			await expect(hunks).toHaveCount(2);

			// Between the hunks, a "Show N more lines" button should appear
			// Hunk 1 ends at line 3, hunk 2 starts at line 50, so 46 lines collapsed
			const expandButton = fileView.getByTestId('expand-context-between');
			await expect(expandButton).toBeVisible();
			await expect(expandButton).toContainText('Show 46 more lines');
		});

		test('shows "Show N more lines above" when first hunk does not start at line 1', async ({ page, daemon }) => {
			// Create a diff where the first hunk starts at line 10
			const diff = {
				base: 'aaa11111',
				head: 'bbb22222',
				files: [{
					oldPath: 'src/middle-change.ts',
					newPath: 'src/middle-change.ts',
					status: 'modified',
					stats: { additions: 1, deletions: 1 },
					hunks: [{
						header: '@@ -10,3 +10,3 @@',
						oldStart: 10,
						oldCount: 3,
						newStart: 10,
						newCount: 3,
						changes: [
							{ type: 'unchanged', content: 'function foo() {', oldLineNumber: 10, newLineNumber: 10 },
							{ type: 'deleted', content: '  return 1;', oldLineNumber: 11, newLineNumber: null },
							{ type: 'added', content: '  return 2;', oldLineNumber: null, newLineNumber: 11 },
							{ type: 'unchanged', content: '}', oldLineNumber: 12, newLineNumber: 12 },
						],
					}],
				}],
				stats: { totalFiles: 1, totalAdditions: 1, totalDeletions: 1 },
			};

			const review = mockCodeReviewDetail();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			const fileView = page.locator('[data-testid="diff-file-view"][data-file-path="src/middle-change.ts"]');
			await fileView.getByTestId('diff-file-header').click();

			// Should show "Show 9 more lines above" since hunk starts at line 10
			const expandUp = fileView.getByTestId('expand-context-up');
			await expect(expandUp).toBeVisible();
			await expect(expandUp).toContainText('Show 9 more lines above');
		});
	});

	// AC: @review-code-diff-viewer ac-4
	test.describe('Click-to-Comment (AC-4)', () => {
		test('shows comment button on hover and opens inline comment form', async ({ page, daemon }) => {
			const review = mockCodeReviewDetail();
			const diff = mockDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			// Expand the modified file
			const fileView = page.locator('[data-testid="diff-file-view"][data-file-path="src/utils/helper.ts"]');
			await fileView.getByTestId('diff-file-header').click();

			// Hover over a line to make comment button visible
			const addedLine = fileView.locator('[data-testid="diff-line"][data-line-type="added"]').first();
			await addedLine.hover();

			// The comment button uses CSS invisible/group-hover:visible — force click
			const commentBtn = addedLine.getByTestId('diff-line-comment-button');
			await commentBtn.click({ force: true });

			// Comment form should appear inline
			const commentForm = fileView.getByTestId('diff-comment-form');
			await expect(commentForm).toBeVisible();

			// Form should have kind selector, body input, submit and cancel buttons
			await expect(commentForm.locator('#diff-comment-kind')).toBeVisible();
			await expect(commentForm.getByTestId('diff-comment-body')).toBeVisible();
			await expect(commentForm.getByTestId('diff-comment-submit')).toBeVisible();
			await expect(commentForm.getByTestId('diff-comment-cancel')).toBeVisible();
		});

		test('submitting comment form creates a thread with code anchor', async ({ page, daemon }) => {
			const review = mockCodeReviewDetail();
			const diff = mockDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			// Track the thread creation request
			let threadRequest: any = null;
			await page.route(`**/api/reviews/${CODE_REVIEW_ULID}/threads`, (route: any) => {
				const request = route.request();
				threadRequest = JSON.parse(request.postData() || '{}');
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						_ulid: '01TEST000000000000000001',
						kind: threadRequest.kind,
						anchor: threadRequest.anchor,
						entries: [{
							_ulid: '01TEST000000000000000002',
							author: 'tester@test.com',
							body: threadRequest.body,
							created_at: new Date().toISOString(),
						}],
					}),
				});
			});

			// Also mock the review refetch after mutation
			await page.route(`**/api/reviews/${CODE_REVIEW_ULID}`, (route: any) => {
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(review),
				});
			});

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			// Expand file and click comment button
			const fileView = page.locator('[data-testid="diff-file-view"][data-file-path="src/utils/helper.ts"]');
			await fileView.getByTestId('diff-file-header').click();

			const addedLine = fileView.locator('[data-testid="diff-line"][data-line-type="added"]').first();
			await addedLine.hover();
			await addedLine.getByTestId('diff-line-comment-button').click({ force: true });

			// Fill in the comment form
			const form = fileView.getByTestId('diff-comment-form');
			await form.locator('#diff-comment-kind').selectOption('blocker');
			await form.getByTestId('diff-comment-body').fill('Critical issue on this line');
			await form.getByTestId('diff-comment-submit').click();

			// Verify the request had a code anchor
			expect(threadRequest).not.toBeNull();
			expect(threadRequest.kind).toBe('blocker');
			expect(threadRequest.body).toBe('Critical issue on this line');
			expect(threadRequest.anchor).toEqual({
				type: 'code',
				path: 'src/utils/helper.ts',
				side: 'head',
				line_start: 12,
				line_end: 12,
				commit: 'bbb22222',
			});
		});

		test('cancel button closes comment form without submitting', async ({ page, daemon }) => {
			const review = mockCodeReviewDetail();
			const diff = mockDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			const fileView = page.locator('[data-testid="diff-file-view"][data-file-path="src/utils/helper.ts"]');
			await fileView.getByTestId('diff-file-header').click();

			const addedLine = fileView.locator('[data-testid="diff-line"][data-line-type="added"]').first();
			await addedLine.hover();
			await addedLine.getByTestId('diff-line-comment-button').click({ force: true });

			await expect(fileView.getByTestId('diff-comment-form')).toBeVisible();
			await fileView.getByTestId('diff-comment-cancel').click();
			await expect(fileView.getByTestId('diff-comment-form')).not.toBeVisible();
		});

		test('submit button is disabled when comment body is empty', async ({ page, daemon }) => {
			const review = mockCodeReviewDetail();
			const diff = mockDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			const fileView = page.locator('[data-testid="diff-file-view"][data-file-path="src/utils/helper.ts"]');
			await fileView.getByTestId('diff-file-header').click();

			const addedLine = fileView.locator('[data-testid="diff-line"][data-line-type="added"]').first();
			await addedLine.hover();
			await addedLine.getByTestId('diff-line-comment-button').click({ force: true });

			await expect(fileView.getByTestId('diff-comment-submit')).toBeDisabled();

			// Type something and it should be enabled
			await fileView.getByTestId('diff-comment-body').fill('A comment');
			await expect(fileView.getByTestId('diff-comment-submit')).toBeEnabled();
		});
	});

	// AC: @review-code-diff-viewer ac-5
	test.describe('Inline Thread Rendering (AC-5)', () => {
		test('existing threads are shown inline at their anchored position in the diff', async ({ page, daemon }) => {
			const threads = [
				mockCodeThread(
					'01THREAD00000000000001',
					'src/utils/helper.ts',
					12,
					'head',
					'blocker',
					'This return value is incorrect'
				),
				mockCodeThread(
					'01THREAD00000000000002',
					'src/utils/helper.ts',
					13,
					'head',
					'nit',
					'Consider a more descriptive name'
				),
			];
			const review = mockCodeReviewDetail(threads);
			const diff = mockDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			// Expand the file
			const fileView = page.locator('[data-testid="diff-file-view"][data-file-path="src/utils/helper.ts"]');
			await fileView.getByTestId('diff-file-header').click();

			// Inline threads should be rendered
			const inlineThreads = fileView.getByTestId('diff-inline-thread');
			await expect(inlineThreads).toHaveCount(2);

			// First thread should be a blocker
			const blockerThread = fileView.locator('[data-testid="diff-inline-thread"][data-thread-kind="blocker"]');
			await expect(blockerThread).toBeVisible();

			// Second thread should be a nit
			const nitThread = fileView.locator('[data-testid="diff-inline-thread"][data-thread-kind="nit"]');
			await expect(nitThread).toBeVisible();
		});

		test('thread shows kind badge, author, and entry count', async ({ page, daemon }) => {
			const threads = [
				mockCodeThread(
					'01THREAD00000000000003',
					'src/utils/helper.ts',
					12,
					'head',
					'question',
					'Why this approach?'
				),
			];
			const review = mockCodeReviewDetail(threads);
			const diff = mockDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			const fileView = page.locator('[data-testid="diff-file-view"][data-file-path="src/utils/helper.ts"]');
			await fileView.getByTestId('diff-file-header').click();

			const thread = fileView.getByTestId('diff-inline-thread');
			await expect(thread).toBeVisible();
			// Should contain 'Question' kind badge text
			await expect(thread).toContainText('Question');
			// Should show author
			await expect(thread).toContainText('reviewer@test.com');
			// Should show comment count
			await expect(thread).toContainText('1 comment');
		});

		test('file header shows thread count indicator', async ({ page, daemon }) => {
			const threads = [
				mockCodeThread('01THREAD00000000000004', 'src/utils/helper.ts', 12, 'head', 'blocker', 'Issue 1'),
				mockCodeThread('01THREAD00000000000005', 'src/utils/helper.ts', 13, 'head', 'nit', 'Minor thing', true),
			];
			const review = mockCodeReviewDetail(threads);
			const diff = mockDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			// The file header should show thread count
			const fileView = page.locator('[data-testid="diff-file-view"][data-file-path="src/utils/helper.ts"]');
			const threadCount = fileView.getByTestId('diff-file-thread-count');
			await expect(threadCount).toBeVisible();
			await expect(threadCount).toContainText('1 open');
			await expect(threadCount).toContainText('1 resolved');
		});
	});

	// AC: @review-code-diff-viewer ac-6
	test.describe('Lazy Loading for 20+ Files (AC-6)', () => {
		test('shows all file headers and stats immediately for 21+ files', async ({ page, daemon }) => {
			const review = mockCodeReviewDetail();
			const diff = mockLargeDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			// File list should show all 21 files
			await expect(page.getByTestId('diff-file-count')).toContainText('21 files changed');
			const entries = page.getByTestId('diff-file-entry');
			await expect(entries).toHaveCount(21);

			// File views should be rendered with headers (stats visible immediately)
			const fileViews = page.getByTestId('diff-file-view');
			await expect(fileViews).toHaveCount(21);
		});

		test('lazy-loads diff content when a file is expanded', async ({ page, daemon }) => {
			const review = mockCodeReviewDetail();
			const diff = mockLargeDiffResponse();
			await setupCodeReviewMocks(page, review, diff);

			// Mock the lazy file diff endpoint
			let lazyLoadCalled = false;
			await page.route('**/api/diff/file?*', (route: any) => {
				lazyLoadCalled = true;
				const url = new URL(route.request().url());
				const path = url.searchParams.get('path') || '';
				const index = parseInt(path.replace('src/file-', '').replace('.ts', ''), 10);
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(mockFileDiffResponse(index)),
				});
			});

			await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

			// Initially no file content should be expanded
			await expect(page.getByTestId('diff-file-content')).toHaveCount(0);

			// Click to expand the first file
			const firstFile = page.getByTestId('diff-file-view').first();
			await firstFile.getByTestId('diff-file-header').click();

			// Should lazy-load and show the diff content
			await expect(firstFile.getByTestId('diff-file-content')).toBeVisible({ timeout: 5000 });
			await expect(firstFile.getByTestId('diff-hunk')).toBeVisible({ timeout: 5000 });

			// Verify the lazy load endpoint was called
			expect(lazyLoadCalled).toBe(true);
		});
	});
});
