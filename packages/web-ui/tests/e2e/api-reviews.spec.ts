/**
 * E2E API Tests for Daemon Reviews Endpoints
 *
 * Tests verify actual HTTP behavior by calling the running daemon directly.
 *
 * Covered ACs:
 * - @review-records-daemon-api ac-1: GET /api/reviews returns paginated list with filters
 * - @review-records-daemon-api ac-2: GET /api/reviews/:id returns full review detail
 */

import { test, expect } from '../fixtures/test-base';

test.describe('Reviews API', () => {
  test.describe('GET /api/reviews', () => {
    // AC: @review-records-daemon-api ac-1 - default returns open reviews only
    test('defaults to open reviews when no status filter', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/reviews`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty('items');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('offset');
      expect(body).toHaveProperty('limit');
      expect(Array.isArray(body.items)).toBe(true);

      // Only open reviews should be returned by default
      for (const review of body.items) {
        expect(review.lifecycle_state).toBe('open');
      }

      // Fixture has exactly 1 open review
      expect(body.total).toBe(1);
    });

    // AC: @review-records-daemon-api ac-1 - returns required summary fields
    test('returns reviews with required summary fields', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/reviews?status=open`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBeGreaterThan(0);

      const review = body.items[0];
      expect(review).toHaveProperty('_ulid');
      expect(review).toHaveProperty('slugs');
      expect(review).toHaveProperty('title');
      expect(review).toHaveProperty('lifecycle_state');
      expect(review).toHaveProperty('disposition');
      expect(review).toHaveProperty('gate_state');
      expect(review).toHaveProperty('subject_type');
      expect(review).toHaveProperty('author');
      expect(review).toHaveProperty('threads_total');
      expect(review).toHaveProperty('threads_resolved');
      expect(review).toHaveProperty('threads_unresolved_blockers');
      expect(review).toHaveProperty('verdicts_count');
      expect(review).toHaveProperty('checks_count');
      expect(review).toHaveProperty('created_at');
    });

    // AC: @review-records-daemon-api ac-1 - computed disposition
    test('includes computed disposition in summary', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/reviews?status=open`);
      const body = await response.json();
      const review = body.items[0];

      // The open code review has a changes_requested verdict and unresolved blocker
      expect(review.disposition).toBe('changes_requested');
    });

    // AC: @review-records-daemon-api ac-1 - status filter
    test('filters by lifecycle_state', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/reviews?status=closed`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.total).toBe(1);
      for (const review of body.items) {
        expect(review.lifecycle_state).toBe('closed');
      }
    });

    // AC: @review-records-daemon-api ac-1 - multi-value status filter
    test('filters by multiple status values', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews?status=open&status=draft`,
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Fixture has 1 open + 1 draft
      expect(body.total).toBe(2);
      for (const review of body.items) {
        expect(['open', 'draft']).toContain(review.lifecycle_state);
      }
    });

    // AC: @review-records-daemon-api ac-1 - disposition filter
    test('filters by disposition', async ({ request, daemon }) => {
      // Get all reviews first, then filter by disposition
      const allResponse = await request.get(
        `${daemon.baseUrl}/api/reviews?status=open&status=closed&status=draft&status=archived`,
      );
      const allBody = await allResponse.json();
      expect(allBody.total).toBeGreaterThan(0);

      const response = await request.get(
        `${daemon.baseUrl}/api/reviews?status=open&status=closed&status=draft&status=archived&disposition=changes_requested`,
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      for (const review of body.items) {
        expect(review.disposition).toBe('changes_requested');
      }
    });

    // AC: @review-records-daemon-api ac-1 - subject-type filter
    test('filters by subject-type', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews?status=open&status=closed&status=draft&subject-type=code`,
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.total).toBe(1);
      expect(body.items[0].subject_type).toBe('code');
    });

    // AC: @review-records-daemon-api ac-1 - reviewer filter
    test('filters by reviewer (author)', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews?status=open&status=closed&status=draft&reviewer=alice`,
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      for (const review of body.items) {
        expect(review.author).toBe('alice');
      }
    });

    // AC: @review-records-daemon-api ac-1 - linked task filter
    test('filters by linked task', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews?status=open&task=test-task-in-progress`,
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.total).toBe(1);
      expect(body.items[0].slugs).toContain('test-review-open-code');
    });

    // AC: @review-records-daemon-api ac-1 - branch filter
    test('filters by subject branch', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews?status=open&status=closed&status=draft&branch=feat/test-task-in-progress`,
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.total).toBe(1);
      expect(body.items[0].subject_type).toBe('code');
    });

    // AC: @review-records-daemon-api ac-1 - sort parameter
    test('supports sort parameter', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews?status=open&status=closed&status=draft&sort=title`,
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.total).toBeGreaterThan(1);

      // Verify ascending title order
      for (let i = 1; i < body.items.length; i++) {
        expect(body.items[i].title.localeCompare(body.items[i - 1].title)).toBeGreaterThanOrEqual(0);
      }
    });

    // AC: @review-records-daemon-api ac-1 - pagination
    test('supports pagination with offset and limit', async ({ request, daemon }) => {
      const page1 = await request.get(
        `${daemon.baseUrl}/api/reviews?status=open&status=closed&status=draft&limit=1&offset=0`,
      );
      const page2 = await request.get(
        `${daemon.baseUrl}/api/reviews?status=open&status=closed&status=draft&limit=1&offset=1`,
      );

      const body1 = await page1.json();
      const body2 = await page2.json();

      expect(body1.items.length).toBe(1);
      expect(body2.items.length).toBe(1);
      expect(body1.total).toBe(3);
      expect(body2.total).toBe(3);
      expect(body1.items[0]._ulid).not.toBe(body2.items[0]._ulid);
    });

    // AC: @review-records-daemon-api ac-1 - resolved related refs
    test('includes resolved related refs', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/reviews?status=open`);
      const body = await response.json();
      const review = body.items[0];

      expect(review.related_refs.length).toBeGreaterThan(0);
      expect(review.resolved_related_refs).toBeDefined();
      expect(review.resolved_related_refs.length).toBe(review.related_refs.length);

      // Each resolved entry has ref, title, status
      for (const entry of review.resolved_related_refs) {
        expect(entry).toHaveProperty('ref');
        expect(entry).toHaveProperty('title');
        expect(entry).toHaveProperty('status');
      }
    });

    // AC: @review-records-daemon-api ac-1 - thread summary counts
    test('includes thread summary counts', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/reviews?status=open`);
      const body = await response.json();
      const review = body.items[0];

      // The open review has 2 threads (1 blocker unresolved, 1 nit resolved)
      expect(review.threads_total).toBe(2);
      expect(review.threads_resolved).toBe(1);
      expect(review.threads_unresolved_blockers).toBe(1);
    });

    // AC: @review-records-daemon-api ac-1 - empty result set
    test('returns empty items for no-match filter', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews?status=archived`,
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  test.describe('GET /api/reviews/:ref', () => {
    // AC: @review-records-daemon-api ac-2 - returns full review by slug
    test('returns full review detail by slug', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews/test-review-open-code`,
      );
      expect(response.status()).toBe(200);

      const review = await response.json();
      expect(review._ulid).toBe('01KG0RRJCC9N4YGP991WD7XSRV');
      expect(review.title).toContain('feat/test-task-in-progress');
      expect(review.lifecycle_state).toBe('open');
    });

    // AC: @review-records-daemon-api ac-2 - includes threads
    test('includes threads with entries and anchors', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews/test-review-open-code`,
      );
      const review = await response.json();

      expect(Array.isArray(review.threads)).toBe(true);
      expect(review.threads.length).toBe(2);

      // First thread is a blocker with code anchor
      const blockerThread = review.threads.find(
        (t: { kind: string }) => t.kind === 'blocker',
      );
      expect(blockerThread).toBeDefined();
      expect(blockerThread.anchor).toBeDefined();
      expect(blockerThread.anchor.type).toBe('code');
      expect(blockerThread.anchor.path).toBe('src/main.ts');
      expect(blockerThread.entries.length).toBeGreaterThan(0);
    });

    // AC: @review-records-daemon-api ac-2 - includes checks
    test('includes checks', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews/test-review-open-code`,
      );
      const review = await response.json();

      expect(Array.isArray(review.checks)).toBe(true);
      expect(review.checks.length).toBe(2);

      const testCheck = review.checks.find(
        (c: { name: string }) => c.name === 'tests',
      );
      expect(testCheck).toBeDefined();
      expect(testCheck.status).toBe('pass');
      expect(testCheck.required).toBe(true);
    });

    // AC: @review-records-daemon-api ac-2 - includes verdicts
    test('includes verdicts', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews/test-review-open-code`,
      );
      const review = await response.json();

      expect(Array.isArray(review.verdicts)).toBe(true);
      expect(review.verdicts.length).toBe(1);
      expect(review.verdicts[0].reviewer).toBe('bob');
      expect(review.verdicts[0].decision).toBe('request_changes');
    });

    // AC: @review-records-daemon-api ac-2 - includes events
    test('includes events', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews/test-review-open-code`,
      );
      const review = await response.json();

      expect(Array.isArray(review.events)).toBe(true);
      expect(review.events.length).toBe(2);

      const lifecycleEvent = review.events.find(
        (e: { event_type: string }) => e.event_type === 'lifecycle_change',
      );
      expect(lifecycleEvent).toBeDefined();
    });

    // AC: @review-records-daemon-api ac-2 - includes computed disposition
    test('includes computed disposition', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews/test-review-open-code`,
      );
      const review = await response.json();

      expect(review.disposition).toBe('changes_requested');
      expect(review.gate_state).toBe('failing');
    });

    // AC: @review-records-daemon-api ac-2 - includes full subject
    test('includes full subject object', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews/test-review-open-code`,
      );
      const review = await response.json();

      expect(review.subject).toBeDefined();
      expect(review.subject.type).toBe('code');
      expect(review.subject.base_commit).toBe('abc123');
      expect(review.subject.head_commit).toBe('def456');
      expect(review.subject.base_branch).toBe('main');
      expect(review.subject.head_branch).toBe('feat/test-task-in-progress');
    });

    // AC: @review-records-daemon-api ac-2 - includes notes and external_links
    test('includes notes and external_links', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews/test-review-open-code`,
      );
      const review = await response.json();

      expect(Array.isArray(review.notes)).toBe(true);
      expect(review.notes.length).toBe(1);
      expect(review.notes[0].author).toBe('alice');

      expect(Array.isArray(review.external_links)).toBe(true);
      expect(review.external_links.length).toBe(1);
      expect(review.external_links[0].provider).toBe('github');
    });

    // AC: @review-records-daemon-api ac-2 - resolves by ULID
    test('resolves by full ULID', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews/01KG0RRJCC9N4YGP991WD7XSRV`,
      );
      expect(response.status()).toBe(200);

      const review = await response.json();
      expect(review.slugs).toContain('test-review-open-code');
    });

    // AC: @review-records-daemon-api ac-2 - 404 for unknown ref
    test('returns 404 for unknown reference', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews/nonexistent-review`,
      );
      expect(response.status()).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('not_found');
      expect(body.message).toContain('nonexistent-review');
      expect(body.suggestion).toBeDefined();
    });

    // AC: @review-records-daemon-api ac-2 - closed review with approved disposition
    test('returns closed review with approved disposition', async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/reviews/test-review-closed`,
      );
      expect(response.status()).toBe(200);

      const review = await response.json();
      expect(review.lifecycle_state).toBe('closed');
      expect(review.disposition).toBe('approved');
      expect(review.subject.type).toBe('task');
      expect(review.subject.ref).toBe('@test-task-completed');
    });
  });
});
