/**
 * E2E API Tests for Review List and Detail Endpoints
 *
 * Tests verify actual HTTP behavior by calling the running daemon directly.
 *
 * Covered ACs:
 * - @review-records-daemon-api ac-1: GET /api/reviews returns paginated list with filtering
 * - @review-records-daemon-api ac-2: GET /api/reviews/:id returns full review detail
 * - @review-records-web-ui ac-1: Review list with filtering, sorting, disposition badges
 * - @review-records-web-ui ac-7: GET /api/reviews?task= for task detail integration
 * - @review-records-web-ui ac-10: Empty state / empty results
 */

import { test, expect } from '../fixtures/test-base';

// Fixture ULIDs from project.reviews.yaml
const OPEN_REVIEW_ULID = '01KKTX0CA45ZT43W2T6HJMVA01';
const DRAFT_REVIEW_ULID = '01KKTX9CA45ZT43W2T6HJMVA10';
const SIBLING_REVIEW_ULID = '01KKV0TCA45ZT43W2T6HJMVB03';
const CODE_REVIEW_ULID = '01KKV1ACA45ZT43W2T6HJMVB10';
const CODE_REVIEW_SIBLING_ULID = '01KKV1BCA45ZT43W2T6HJMVB11';
const PENDING_REVIEW_TASK_ULID = '01KG0RRDCC9N4YGP991WD7XSPR';

test.describe('Review List API (GET /api/reviews)', () => {
  // AC: @review-records-daemon-api ac-1
  test('returns paginated review list with expected shape', async ({ request, daemon }) => {
    const response = await request.get(`${daemon.baseUrl}/api/reviews?status=all`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('offset');
    expect(body).toHaveProperty('limit');
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  // AC: @review-records-daemon-api ac-1
  test('review summary includes required fields', async ({ request, daemon }) => {
    const response = await request.get(`${daemon.baseUrl}/api/reviews?status=all`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    const review = body.items[0];
    expect(review).toHaveProperty('_ulid');
    expect(review).toHaveProperty('title');
    expect(review).toHaveProperty('lifecycle_state');
    expect(review).toHaveProperty('disposition');
    expect(review).toHaveProperty('subject_type');
    expect(review).toHaveProperty('author');
    expect(review).toHaveProperty('thread_count');
    expect(review).toHaveProperty('unresolved_blocker_count');
    expect(review).toHaveProperty('check_count');
    expect(review).toHaveProperty('verdict_count');
    expect(review).toHaveProperty('created_at');
  });

  // AC: @review-records-daemon-api ac-1 — default status filter is 'open'
  test('defaults to open reviews when no status filter specified', async ({ request, daemon }) => {
    const response = await request.get(`${daemon.baseUrl}/api/reviews`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    // Fixture has 1 open review — should only return open ones by default
    for (const review of body.items) {
      expect(review.lifecycle_state).toBe('open');
    }
    expect(body.items.length).toBeGreaterThan(0);
  });

  // AC: @review-records-daemon-api ac-1 — status filter
  // AC: @review-records-web-ui ac-1 — filtering by status
  test('filters reviews by status', async ({ request, daemon }) => {
    const response = await request.get(`${daemon.baseUrl}/api/reviews?status=draft`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.items.length).toBeGreaterThan(0);
    for (const review of body.items) {
      expect(review.lifecycle_state).toBe('draft');
    }
  });

  // AC: @review-records-daemon-api ac-1 — status=all returns all reviews
  test('status=all returns reviews in all lifecycle states', async ({ request, daemon }) => {
    const response = await request.get(`${daemon.baseUrl}/api/reviews?status=all`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    // Fixtures have both open and draft reviews
    expect(body.total).toBeGreaterThanOrEqual(2);
    const states = new Set(body.items.map((r: { lifecycle_state: string }) => r.lifecycle_state));
    expect(states.size).toBeGreaterThan(1);
  });

  // AC: @review-records-daemon-api ac-1 — disposition filter
  // AC: @review-records-web-ui ac-1 — filtering by disposition
  test('filters reviews by disposition', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews?status=all&disposition=pending`
    );
    expect(response.status()).toBe(200);

    const body = await response.json();
    // Both fixture reviews have no verdicts → disposition is 'pending'
    expect(body.items.length).toBeGreaterThan(0);
    for (const review of body.items) {
      expect(review.disposition).toBe('pending');
    }
  });

  // AC: @review-records-daemon-api ac-1 — subject_type filter
  // AC: @review-records-web-ui ac-1 — filtering by subject type
  test('filters reviews by subject type', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews?status=all&subject_type=task`
    );
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.items.length).toBeGreaterThan(0);
    for (const review of body.items) {
      expect(review.subject_type).toBe('task');
    }
  });

  // AC: @review-records-daemon-api ac-1 — empty result for non-matching filter
  // AC: @review-records-web-ui ac-10 — empty state
  test('returns empty items for non-matching filter', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews?status=all&subject_type=code`
    );
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  // AC: @review-records-daemon-api ac-1 — sorting
  // AC: @review-records-web-ui ac-1 — sortable columns
  test('sorts reviews by created_at desc by default', async ({ request, daemon }) => {
    const response = await request.get(`${daemon.baseUrl}/api/reviews?status=all`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.items.length).toBeGreaterThanOrEqual(2);

    // Default sort: created_at desc — most recent first
    const dates = body.items.map((r: { created_at: string }) => new Date(r.created_at).getTime());
    for (let i = 0; i < dates.length - 1; i++) {
      expect(dates[i]).toBeGreaterThanOrEqual(dates[i + 1]);
    }
  });

  // AC: @review-records-daemon-api ac-1 — ascending sort
  // AC: @review-records-web-ui ac-1 — sortable columns
  test('sorts reviews ascending when sort_dir=asc', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews?status=all&sort=created_at&sort_dir=asc`
    );
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.items.length).toBeGreaterThanOrEqual(2);

    const dates = body.items.map((r: { created_at: string }) => new Date(r.created_at).getTime());
    for (let i = 0; i < dates.length - 1; i++) {
      expect(dates[i]).toBeLessThanOrEqual(dates[i + 1]);
    }
  });

  // AC: @review-records-daemon-api ac-1 — pagination
  test('respects pagination parameters', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews?status=all&limit=1&offset=0`
    );
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.items.length).toBe(1);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(0);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  // AC: @review-records-daemon-api ac-1 — pagination offset
  test('pagination offset returns different items', async ({ request, daemon }) => {
    const page1 = await request.get(
      `${daemon.baseUrl}/api/reviews?status=all&limit=1&offset=0`
    );
    const page2 = await request.get(
      `${daemon.baseUrl}/api/reviews?status=all&limit=1&offset=1`
    );

    const body1 = await page1.json();
    const body2 = await page2.json();

    expect(body1.items.length).toBe(1);
    expect(body2.items.length).toBe(1);
    expect(body1.items[0]._ulid).not.toBe(body2.items[0]._ulid);
  });

  // AC: @review-records-daemon-api ac-1 — task title resolution via ReferenceIndex
  test('resolves task title for reviews with task subject', async ({ request, daemon }) => {
    const response = await request.get(`${daemon.baseUrl}/api/reviews?status=all`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    // Open review references @test-task-pending-review
    const openReview = body.items.find(
      (r: { _ulid: string }) => r._ulid === OPEN_REVIEW_ULID
    );
    expect(openReview).toBeDefined();
    expect(openReview.task_ref).toBe('@test-task-pending-review');
    expect(openReview.task_title).toBe('Pending review task');
  });

  // AC: @review-records-daemon-api ac-1 — review computed fields
  test('includes computed counts for threads, checks, and verdicts', async ({
    request,
    daemon,
  }) => {
    const response = await request.get(`${daemon.baseUrl}/api/reviews?status=all`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    const openReview = body.items.find(
      (r: { _ulid: string }) => r._ulid === OPEN_REVIEW_ULID
    );
    expect(openReview).toBeDefined();
    // Open review fixture has 4 threads, 2 unresolved blockers, 3 checks, 1 verdict
    expect(openReview.thread_count).toBe(4);
    expect(openReview.unresolved_blocker_count).toBe(2);
    expect(openReview.check_count).toBe(3);
    expect(openReview.verdict_count).toBe(1);
  });

  // AC: @review-records-web-ui ac-1 — disposition badge values
  test('returns disposition as a known value', async ({ request, daemon }) => {
    const response = await request.get(`${daemon.baseUrl}/api/reviews?status=all`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    const validDispositions = ['pending', 'approved', 'changes_requested'];
    for (const review of body.items) {
      expect(validDispositions).toContain(review.disposition);
    }
  });

  // AC: @review-records-daemon-api ac-1 — JSON content type
  test('returns JSON content type', async ({ request, daemon }) => {
    const response = await request.get(`${daemon.baseUrl}/api/reviews?status=all`);
    const contentType = response.headers()['content-type'] || '';
    expect(contentType).toContain('application/json');
  });

  // AC: @review-records-web-ui ac-7 — task filter by subject ref
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

  // AC: @review-records-web-ui ac-7 — task filter by ULID
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

  // AC: @review-records-web-ui ac-7 — task filter empty for unlinked task
  test('GET /api/reviews?task= returns empty for unlinked task', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews?task=test-task-completed`
    );
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data.items.length).toBe(0);
    expect(data.total).toBe(0);
  });

  // AC: @review-records-web-ui ac-11 — sibling lookup by subject_ref
  test('filters reviews by subject_ref for revision navigation', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews?status=all&subject_type=task&subject_ref=%40test-task-pending-review`
    );
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data.items).toHaveLength(2);
    expect(data.items.map((r: { _ulid: string }) => r._ulid)).toEqual(
      expect.arrayContaining([OPEN_REVIEW_ULID, SIBLING_REVIEW_ULID])
    );
  });

  // AC: @review-records-web-ui ac-11 — sibling lookup by head_branch for code reviews
  test('filters code reviews by head_branch for revision navigation', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews?status=all&subject_type=code&head_branch=feat%2Freview-detail`
    );
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data.items).toHaveLength(2);
    expect(data.items.map((r: { _ulid: string }) => r._ulid)).toEqual(
      expect.arrayContaining([CODE_REVIEW_ULID, CODE_REVIEW_SIBLING_ULID])
    );
    expect(
      data.items.every((r: { head_branch?: string }) => r.head_branch === 'feat/review-detail')
    ).toBe(true);
  });
});

test.describe('Review Detail API (GET /api/reviews/:id)', () => {
  // AC: @review-records-daemon-api ac-2
  test('returns full review detail by ULID', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}`
    );
    expect(response.status()).toBe(200);

    const review = await response.json();
    expect(review._ulid).toBe(OPEN_REVIEW_ULID);
    expect(review.title).toBe('Review of test task');
    expect(review.lifecycle_state).toBe('open');
    expect(review).toHaveProperty('disposition');
    expect(review).toHaveProperty('threads');
    expect(review).toHaveProperty('checks');
    expect(review).toHaveProperty('verdicts');
    expect(review).toHaveProperty('events');
    expect(review).toHaveProperty('subject');
  });

  // AC: @review-records-daemon-api ac-2 — threads with entries
  test('returns threads with entries and resolution state', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}`
    );
    expect(response.status()).toBe(200);

    const review = await response.json();
    expect(review.threads.length).toBe(4);

    // First blocker thread
    const blockerThread = review.threads.find(
      (t: { _ulid: string }) => t._ulid === '01KKTX1CA45ZT43W2T6HJMVA02'
    );
    expect(blockerThread).toBeDefined();
    expect(blockerThread.kind).toBe('blocker');
    expect(blockerThread.entries.length).toBeGreaterThan(0);
    expect(blockerThread.entries[0].body).toBe('Missing error handling for edge case');

    // Resolved question thread
    const resolvedThread = review.threads.find(
      (t: { kind: string; resolved_at: string | null }) =>
        t.kind === 'question' && t.resolved_at !== null
    );
    expect(resolvedThread).toBeDefined();
    expect(resolvedThread.resolved_by).toBe('worker@test.com');
    expect(resolvedThread.entries.length).toBe(2);
  });

  // AC: @review-records-daemon-api ac-2 — computed disposition
  test('includes computed disposition in detail response', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}`
    );
    expect(response.status()).toBe(200);

    const review = await response.json();
    // Has request_changes verdict → disposition is 'changes_requested'
    expect(review.disposition).toBe('changes_requested');
  });

  // AC: @review-records-daemon-api ac-2 — detail for empty review
  test('returns detail for review with no threads', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews/${DRAFT_REVIEW_ULID}`
    );
    expect(response.status()).toBe(200);

    const review = await response.json();
    expect(review._ulid).toBe(DRAFT_REVIEW_ULID);
    expect(review.threads).toEqual([]);
    expect(review.checks).toEqual([]);
    expect(review.verdicts).toEqual([]);
  });

  // AC: @review-records-daemon-api ac-2 — 404 for non-existent review
  test('returns 404 for non-existent review', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews/nonexistent-review`
    );
    expect(response.status()).toBe(404);

    const body = await response.json();
    expect(body.error).toBe('not_found');
    expect(body).toHaveProperty('suggestion');
  });

  // AC: @review-records-daemon-api ac-2 — subject information
  test('returns subject information in detail', async ({ request, daemon }) => {
    const response = await request.get(
      `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}`
    );
    expect(response.status()).toBe(200);

    const review = await response.json();
    expect(review.subject.type).toBe('task');
    expect(review.subject.ref).toBe('@test-task-pending-review');
  });
});
