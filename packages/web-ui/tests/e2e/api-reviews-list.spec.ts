/**
 * E2E API Tests for Review List Endpoint
 *
 * Tests verify actual HTTP behavior by calling the running daemon directly.
 *
 * Covered ACs:
 * - @review-records-daemon-api ac-1: GET /api/reviews returns paginated list with filters
 * - @review-records-web-ui ac-7: GET /api/reviews?task= for task detail integration
 */

import { test, expect } from '../fixtures/test-base';

// Fixture ULIDs
const OPEN_REVIEW_ULID = '01KKTX0CA45ZT43W2T6HJMVA01';
const DRAFT_REVIEW_ULID = '01KKTX9CA45ZT43W2T6HJMVA10';
const PENDING_REVIEW_TASK_ULID = '01KG0RRDCC9N4YGP991WD7XSPR';

test.describe('Review List API', () => {
  // AC: @review-records-daemon-api ac-1
  test('GET /api/reviews returns all reviews', async ({ request, daemon }) => {
    const response = await request.get(`${daemon.baseUrl}/api/reviews`);
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data.items).toBeDefined();
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items.length).toBeGreaterThanOrEqual(2);
    expect(data.total).toBeGreaterThanOrEqual(2);
    expect(data.offset).toBe(0);

    // Verify review summary shape
    const review = data.items.find((r: { _ulid: string }) => r._ulid === OPEN_REVIEW_ULID);
    expect(review).toBeDefined();
    expect(review.slugs).toContain('test-review-open');
    expect(review.title).toBe('Review of test task');
    expect(review.lifecycle_state).toBe('open');
    expect(review.disposition).toBeDefined();
    expect(review.subject_type).toBe('task');
    expect(review.author).toBe('reviewer@test.com');
    expect(review.thread_count).toBe(3);
    expect(review.unresolved_blocker_count).toBeGreaterThanOrEqual(1);
    expect(review.created_at).toBeDefined();
  });

  // AC: @review-records-daemon-api ac-1
  test('GET /api/reviews supports status filter', async ({ request, daemon }) => {
    const response = await request.get(`${daemon.baseUrl}/api/reviews?status=open`);
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    for (const review of data.items) {
      expect(review.lifecycle_state).toBe('open');
    }
  });

  // AC: @review-records-daemon-api ac-1
  test('GET /api/reviews supports pagination', async ({ request, daemon }) => {
    const response = await request.get(`${daemon.baseUrl}/api/reviews?limit=1&offset=0`);
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data.items.length).toBe(1);
    expect(data.limit).toBe(1);
    expect(data.offset).toBe(0);
    expect(data.total).toBeGreaterThanOrEqual(2);
  });

  // AC: @review-records-web-ui ac-7
  test('GET /api/reviews?task= filters by task subject ref', async ({ request, daemon }) => {
    // The open review has subject.ref = "@test-task-pending-review"
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews?task=test-task-pending-review`
    );
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data.items.length).toBeGreaterThanOrEqual(1);

    const review = data.items.find((r: { _ulid: string }) => r._ulid === OPEN_REVIEW_ULID);
    expect(review).toBeDefined();
    expect(review.title).toBe('Review of test task');
  });

  // AC: @review-records-web-ui ac-7
  test('GET /api/reviews?task= filters by task ULID', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews?task=${PENDING_REVIEW_TASK_ULID}`
    );
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data.items.length).toBeGreaterThanOrEqual(1);

    const review = data.items.find((r: { _ulid: string }) => r._ulid === OPEN_REVIEW_ULID);
    expect(review).toBeDefined();
  });

  // AC: @review-records-web-ui ac-7
  test('GET /api/reviews?task= returns empty for unlinked task', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews?task=test-task-completed`
    );
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data.items.length).toBe(0);
    expect(data.total).toBe(0);
  });

  // AC: @review-records-daemon-api ac-1
  test('GET /api/reviews includes disposition computation', async ({ request, daemon }) => {
    const response = await request.get(`${daemon.baseUrl}/api/reviews`);
    const data = await response.json();

    // The open review has no verdicts, so disposition should be 'pending'
    const openReview = data.items.find((r: { _ulid: string }) => r._ulid === OPEN_REVIEW_ULID);
    expect(openReview).toBeDefined();
    expect(openReview.disposition).toBe('pending');
  });
});
