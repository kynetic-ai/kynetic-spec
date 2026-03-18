/**
 * E2E Tests for Review Interaction Controls
 *
 * Tests the UI controls for creating threads, replying, resolving/reopening,
 * and submitting verdicts on the review detail page.
 *
 * AC: @review-records-web-ui ac-3 — Add Comment: create new thread with body and kind selection
 * AC: @review-records-web-ui ac-4 — Reply: add reply to existing thread
 * AC: @review-records-web-ui ac-5 — Resolve/Reopen: toggle thread resolution state
 * AC: @review-records-web-ui ac-6 — Verdict submission with disposition update
 */

import { test, expect } from '../fixtures/test-base';

const OPEN_REVIEW_ULID = '01KKTX0CA45ZT43W2T6HJMVA01';
const DRAFT_REVIEW_ULID = '01KKTX9CA45ZT43W2T6HJMVA10';
const BLOCKER_THREAD_ULID = '01KKTX1CA45ZT43W2T6HJMVA02';
const RESOLVED_QUESTION_ULID = '01KKTX5CA45ZT43W2T6HJMVA06';

test.describe('Review Interaction Controls', () => {
  // AC: @review-records-web-ui ac-3
  test.describe('Add Comment (AC-3)', () => {
    test('shows Add Comment button and opens form', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      const addBtn = page.getByTestId('add-comment-button');
      await expect(addBtn).toBeVisible();

      await addBtn.click();
      await expect(page.getByTestId('add-comment-form')).toBeVisible();
      await expect(page.getByTestId('comment-kind-select')).toBeVisible();
      await expect(page.getByTestId('comment-body-input')).toBeVisible();
      await expect(page.getByTestId('comment-submit-button')).toBeVisible();
      await expect(page.getByTestId('comment-cancel-button')).toBeVisible();
    });

    test('creates a new thread with body and kind selection', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      // Open form
      await page.getByTestId('add-comment-button').click();

      // Select kind
      await page.getByTestId('comment-kind-select').selectOption('blocker');

      // Enter body
      await page.getByTestId('comment-body-input').fill('This is a new blocker comment from E2E test');

      // Submit
      await page.getByTestId('comment-submit-button').click();

      // Form should close after successful submission
      await expect(page.getByTestId('add-comment-form')).not.toBeVisible({ timeout: 5000 });

      // New thread should appear in the threads section
      const threadItems = page.getByTestId('thread-item');
      const lastThread = threadItems.last();
      await expect(lastThread.getByTestId('entry-body')).toContainText(
        'This is a new blocker comment from E2E test'
      );
    });

    test('cancel button closes the form without submitting', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      await page.getByTestId('add-comment-button').click();
      await expect(page.getByTestId('add-comment-form')).toBeVisible();

      await page.getByTestId('comment-body-input').fill('Should not be submitted');
      await page.getByTestId('comment-cancel-button').click();

      await expect(page.getByTestId('add-comment-form')).not.toBeVisible();
    });

    test('submit button is disabled when body is empty', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      await page.getByTestId('add-comment-button').click();
      await expect(page.getByTestId('comment-submit-button')).toBeDisabled();

      await page.getByTestId('comment-body-input').fill('Some content');
      await expect(page.getByTestId('comment-submit-button')).toBeEnabled();
    });

    test('can add a comment to a review with no existing threads', async ({ page, daemon }) => {
      await page.goto(`/reviews/${DRAFT_REVIEW_ULID}`);

      // Verify empty state
      await expect(page.getByTestId('threads-empty')).toBeVisible();

      // Add comment
      await page.getByTestId('add-comment-button').click();
      await page.getByTestId('comment-kind-select').selectOption('question');
      await page.getByTestId('comment-body-input').fill('First comment on draft review');
      await page.getByTestId('comment-submit-button').click();

      // Empty state should be replaced by the new thread
      await expect(page.getByTestId('threads-empty')).not.toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId('thread-item')).toBeVisible();
      await expect(
        page.getByTestId('thread-item').first().getByTestId('thread-kind-badge')
      ).toContainText('Question');
    });
  });

  // AC: @review-records-web-ui ac-4
  test.describe('Reply to Thread (AC-4)', () => {
    test('shows Reply button on threads and opens inline reply form', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      const firstThread = page.getByTestId('thread-item').first();
      const replyBtn = firstThread.getByTestId('thread-reply-button');
      await expect(replyBtn).toBeVisible();

      await replyBtn.click();
      await expect(firstThread.getByTestId('reply-form')).toBeVisible();
      await expect(firstThread.getByTestId('reply-body-input')).toBeVisible();
      await expect(firstThread.getByTestId('reply-submit-button')).toBeVisible();
    });

    test('adds a reply to a thread', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      const targetThread = page.locator(`[data-thread-id="${BLOCKER_THREAD_ULID}"]`);
      await expect(targetThread).toBeVisible();

      // Count entries before
      const entriesBefore = await targetThread.getByTestId('thread-entry').count();

      // Open reply form
      await targetThread.getByTestId('thread-reply-button').click();
      await targetThread.getByTestId('reply-body-input').fill('E2E test reply to blocker');
      await targetThread.getByTestId('reply-submit-button').click();

      // Reply form should close
      await expect(targetThread.getByTestId('reply-form')).not.toBeVisible({ timeout: 5000 });

      // New entry should appear
      await expect(targetThread.getByTestId('thread-entry')).toHaveCount(entriesBefore + 1, {
        timeout: 5000,
      });
      const lastEntry = targetThread.getByTestId('thread-entry').last();
      await expect(lastEntry.getByTestId('entry-body')).toContainText('E2E test reply to blocker');
    });

    test('cancel button closes reply form', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      const firstThread = page.getByTestId('thread-item').first();
      await firstThread.getByTestId('thread-reply-button').click();
      await expect(firstThread.getByTestId('reply-form')).toBeVisible();

      await firstThread.getByTestId('reply-cancel-button').click();
      await expect(firstThread.getByTestId('reply-form')).not.toBeVisible();
      // Reply button should reappear
      await expect(firstThread.getByTestId('thread-reply-button')).toBeVisible();
    });

    test('reply submit is disabled when body is empty', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      const firstThread = page.getByTestId('thread-item').first();
      await firstThread.getByTestId('thread-reply-button').click();
      await expect(firstThread.getByTestId('reply-submit-button')).toBeDisabled();
    });
  });

  // AC: @review-records-web-ui ac-5
  test.describe('Resolve/Reopen Thread (AC-5)', () => {
    test('shows Resolve button on open blocker/question threads', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      // Blocker thread should have a Resolve button
      const blockerThread = page.locator(`[data-thread-id="${BLOCKER_THREAD_ULID}"]`);
      await expect(blockerThread.getByTestId('thread-resolve-button')).toBeVisible();
    });

    test('resolves an open blocker thread and moves it to resolved section', async ({
      page,
      daemon,
    }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      const blockerThread = page.locator(`[data-thread-id="${BLOCKER_THREAD_ULID}"]`);
      await expect(blockerThread.getByTestId('thread-status')).toContainText('Open');

      // Click resolve
      await blockerThread.getByTestId('thread-resolve-button').click();

      // After query invalidation, the thread should move to resolved
      // Wait for the thread to show "Resolved" status
      await expect(
        page.locator(`[data-thread-id="${BLOCKER_THREAD_ULID}"]`).getByTestId('thread-status')
      ).toContainText('Resolved', { timeout: 5000 });
    });

    test('shows Reopen button on resolved blocker/question threads', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      // Open the resolved threads section
      const resolvedToggle = page.getByTestId('resolved-threads-toggle');
      if (await resolvedToggle.isVisible()) {
        await resolvedToggle.click();
      }

      // The resolved question thread should have a Reopen button
      const resolvedThread = page.locator(`[data-thread-id="${RESOLVED_QUESTION_ULID}"]`);
      await expect(resolvedThread.getByTestId('thread-reopen-button')).toBeVisible();
    });

    test('reopens a resolved thread', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      // Open resolved section
      const resolvedToggle = page.getByTestId('resolved-threads-toggle');
      if (await resolvedToggle.isVisible()) {
        await resolvedToggle.click();
      }

      const resolvedThread = page.locator(`[data-thread-id="${RESOLVED_QUESTION_ULID}"]`);
      await expect(resolvedThread.getByTestId('thread-status')).toContainText('Resolved');

      // Click reopen
      await resolvedThread.getByTestId('thread-reopen-button').click();

      // Thread should now show Open status
      await expect(
        page.locator(`[data-thread-id="${RESOLVED_QUESTION_ULID}"]`).getByTestId('thread-status')
      ).toContainText('Open', { timeout: 5000 });
    });
  });

  // AC: @review-records-web-ui ac-6
  test.describe('Verdict Submission (AC-6)', () => {
    test('shows verdict submission panel on interactive review', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      await expect(page.getByTestId('verdict-submission-section')).toBeVisible();
      await expect(page.getByTestId('verdict-decision-select')).toBeVisible();
      await expect(page.getByTestId('verdict-reviewer-input')).toBeVisible();
      await expect(page.getByTestId('verdict-submit-button')).toBeVisible();
    });

    test('submit button is disabled when reviewer is empty', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      await expect(page.getByTestId('verdict-submit-button')).toBeDisabled();

      await page.getByTestId('verdict-reviewer-input').fill('test@example.com');
      await expect(page.getByTestId('verdict-submit-button')).toBeEnabled();
    });

    test('submits a verdict and updates disposition', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      // Select decision
      await page.getByTestId('verdict-decision-select').selectOption('comment');

      // Enter reviewer
      await page.getByTestId('verdict-reviewer-input').fill('e2e-reviewer@test.com');

      // Submit
      await page.getByTestId('verdict-submit-button').click();

      // Wait for the verdict to appear in the verdicts section
      // A comment verdict should appear in the verdicts list
      await expect(page.getByTestId('verdict-item').last()).toContainText('e2e-reviewer@test.com', {
        timeout: 5000,
      });
    });

    test('submitting approve verdict updates disposition badge', async ({ page, daemon }) => {
      // Use the draft review which has no existing verdicts
      // First open it via lifecycle transition
      await page.goto(`/reviews/${DRAFT_REVIEW_ULID}`);

      // Select approve
      await page.getByTestId('verdict-decision-select').selectOption('approve');
      await page.getByTestId('verdict-reviewer-input').fill('approver@test.com');
      await page.getByTestId('verdict-submit-button').click();

      // Disposition should update to Approved (approve auto-closes the review)
      await expect(page.getByTestId('review-disposition-badge')).toContainText('Approved', {
        timeout: 5000,
      });
    });

    test('verdict decision options include all three types', async ({ page, daemon }) => {
      await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

      const select = page.getByTestId('verdict-decision-select');
      const options = select.locator('option');
      await expect(options).toHaveCount(3);
      await expect(options.nth(0)).toHaveValue('approve');
      await expect(options.nth(1)).toHaveValue('request_changes');
      await expect(options.nth(2)).toHaveValue('comment');
    });
  });
});
