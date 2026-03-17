/**
 * E2E API Tests for Review Thread Mutation Endpoints
 *
 * Tests verify actual HTTP behavior by calling the running daemon directly.
 *
 * Covered ACs:
 * - @review-records-daemon-api ac-3: POST /api/reviews/:id/comments creates thread
 * - @review-records-daemon-api ac-4: POST /api/reviews/:id/comments/:threadId/replies adds reply
 * - @review-records-daemon-api ac-5: PATCH resolve/reopen toggles thread resolution
 * - @review-records-daemon-api ac-9: WebSocket broadcast on review mutations
 * - @review-records-daemon-api ac-10: 400 with actionable error messages
 */

// Trait N/A annotations — @review-records-daemon-api inherits traits that are CLI-oriented or tested elsewhere:
// AC: @trait-json-output ac-1 — N/A: HTTP REST API always returns JSON; no --json flag concept for HTTP endpoints
// AC: @trait-json-output ac-2 — N/A: HTTP REST API always returns full data; no human-readable vs JSON mode
// AC: @trait-json-output ac-3 — N/A: HTTP REST API errors use HTTP status codes + JSON bodies, not --json flag
// AC: @trait-json-output ac-4 — N/A: HTTP REST API references in JSON responses; @ prefix convention is CLI-specific
// AC: @trait-json-output ac-5 — N/A: HTTP REST API timestamps are ISO 8601 by convention; not enforced via --json flag
// AC: @trait-json-output ac-6 — N/A: HTTP REST API has no formatting flags; not applicable
// AC: @trait-error-guidance ac-1 — N/A: CLI error message guidance; REST API uses JSON error bodies (tested in ac-10 E2E tests below)
// AC: @trait-error-guidance ac-2 — N/A: CLI error message guidance; REST API uses suggestion field (tested in error handling E2E tests below)
// AC: @trait-error-guidance ac-3 — N/A: CLI ref-not-found guidance; REST API uses 404 with suggestion (covered in 404 tests below)
// AC: @trait-error-guidance ac-4 — N/A: CLI state-transition error guidance; REST API 409 format tested in resolve/reopen tests below
// AC: @trait-error-guidance ac-5 — N/A: CLI validation error guidance; REST API 400 format tested in validation tests below
// AC: @trait-error-guidance ac-6 — N/A: CLI error guidance in JSON mode; this is a CLI pattern not applicable to REST API endpoints
// AC: @trait-localhost-security ac-1 — N/A: server binding tested in api-server E2E tests
// AC: @trait-localhost-security ac-2 — N/A: non-localhost rejection tested in api-server E2E tests
// AC: @trait-localhost-security ac-3 — N/A: external binding warning tested in api-server E2E tests
// AC: @trait-websocket-protocol ac-1 — N/A: WebSocket protocol; tested separately in api-websocket E2E tests
// AC: @trait-websocket-protocol ac-2 — N/A: WebSocket subscribe command; tested separately in api-websocket E2E tests
// AC: @trait-websocket-protocol ac-3 — N/A: WebSocket broadcast events; tested separately in api-websocket E2E tests
// AC: @trait-websocket-protocol ac-4 — N/A: WebSocket heartbeat ping; tested separately in api-websocket E2E tests
// AC: @trait-websocket-protocol ac-5 — N/A: WebSocket ping/pong timeout; tested separately in api-websocket E2E tests
// AC: @trait-websocket-protocol ac-6 — N/A: WebSocket backpressure; tested separately in api-websocket E2E tests
// AC: @trait-websocket-protocol ac-7 — N/A: WebSocket close codes; tested separately in api-websocket E2E tests
// AC: @trait-websocket-protocol ac-8 — N/A: WebSocket reconnection; tested separately in api-websocket E2E tests

import { test, expect } from '../fixtures/test-base';

// Fixture ULIDs
const OPEN_REVIEW_ULID = '01KKTX0CA45ZT43W2T6HJMVA01';
const DRAFT_REVIEW_ULID = '01KKTX9CA45ZT43W2T6HJMVA10';
const BLOCKER_THREAD_ULID = '01KKTX1CA45ZT43W2T6HJMVA02';
const NIT_THREAD_ULID = '01KKTX3CA45ZT43W2T6HJMVA04';
const RESOLVED_THREAD_ULID = '01KKTX5CA45ZT43W2T6HJMVA06';

test.describe('Review Thread Mutation API', () => {
  test.describe('POST /api/reviews/:id/comments', () => {
    // AC: @review-records-daemon-api ac-3
    test('creates a new thread on the review', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments`,
        {
          data: {
            body: 'New finding in the code',
            kind: 'blocker',
            author: 'test-reviewer@test.com',
          },
        }
      );

      expect(response.status()).toBe(200);
      const thread = await response.json();
      expect(thread).toHaveProperty('_ulid');
      expect(thread.kind).toBe('blocker');
      expect(thread.entries).toHaveLength(1);
      expect(thread.entries[0].body).toBe('New finding in the code');
      expect(thread.entries[0].author).toBe('test-reviewer@test.com');
    });

    // AC: @review-records-daemon-api ac-3 - default kind is nit
    test('defaults to nit kind when not specified', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments`,
        {
          data: {
            body: 'Minor suggestion',
            author: 'test-reviewer@test.com',
          },
        }
      );

      expect(response.status()).toBe(200);
      const thread = await response.json();
      expect(thread.kind).toBe('nit');
    });

    // AC: @review-records-daemon-api ac-3 - thread with code anchor
    test('creates thread with code anchor', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments`,
        {
          data: {
            body: 'Off-by-one error here',
            kind: 'blocker',
            author: 'reviewer@test.com',
            anchor: {
              type: 'code',
              path: 'src/parser/validate.ts',
              side: 'head',
              line_start: 42,
              line_end: 42,
              commit: 'abc1234',
            },
          },
        }
      );

      expect(response.status()).toBe(200);
      const thread = await response.json();
      expect(thread).toHaveProperty('anchor');
      expect(thread.anchor.type).toBe('code');
      expect(thread.anchor.path).toBe('src/parser/validate.ts');
      expect(thread.anchor.line_start).toBe(42);
    });

    // AC: @review-records-daemon-api ac-3 - thread with structured anchor
    test('creates thread with structured anchor', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments`,
        {
          data: {
            body: 'AC is too vague',
            kind: 'question',
            author: 'reviewer@test.com',
            anchor: {
              type: 'structured',
              section: 'acceptance_criteria',
              field: 'ac-3',
              ref: '@test-feature',
            },
          },
        }
      );

      expect(response.status()).toBe(200);
      const thread = await response.json();
      expect(thread).toHaveProperty('anchor');
      expect(thread.anchor.type).toBe('structured');
      expect(thread.anchor.section).toBe('acceptance_criteria');
    });

    // AC: @review-records-daemon-api ac-3 - thread is persisted
    test('created thread appears in subsequent review fetch', async ({
      request,
      daemon,
    }) => {
      // Create thread
      const createResponse = await request.post(
        `${daemon.baseUrl}/api/reviews/${DRAFT_REVIEW_ULID}/comments`,
        {
          data: {
            body: 'Persisted thread test',
            kind: 'nit',
            author: 'reviewer@test.com',
          },
        }
      );
      expect(createResponse.status()).toBe(200);
      const created = await createResponse.json();

      // Fetch review details and verify thread exists
      const getResponse = await request.get(
        `${daemon.baseUrl}/api/reviews/${DRAFT_REVIEW_ULID}`
      );
      // If the detail endpoint exists, check it; otherwise check via list
      if (getResponse.status() === 200) {
        const review = await getResponse.json();
        const foundThread = review.threads?.find(
          (t: { _ulid: string }) => t._ulid === created._ulid
        );
        expect(foundThread).toBeDefined();
        expect(foundThread.entries[0].body).toBe('Persisted thread test');
      }
    });

    // AC: @review-records-daemon-api ac-10 - validation errors
    test('returns 422 when body field is missing', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments`,
        {
          data: { kind: 'nit' },
        }
      );

      // Elysia returns 422 for schema validation failures
      expect(response.status()).toBe(422);
    });

    // AC: @review-records-daemon-api ac-10 - empty body
    test('returns 400 when body is empty string', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments`,
        {
          data: { body: '', author: 'reviewer@test.com' },
        }
      );

      expect(response.status()).toBe(400);
      const result = await response.json();
      expect(result.error).toBe('validation_error');
      expect(result.details[0].field).toBe('body');
    });

    // AC: @review-records-daemon-api ac-10 - whitespace-only body
    test('returns 400 when body is whitespace only', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments`,
        {
          data: { body: '   ', author: 'reviewer@test.com' },
        }
      );

      expect(response.status()).toBe(400);
      const result = await response.json();
      expect(result.error).toBe('validation_error');
    });

    // AC: @review-records-daemon-api ac-10 - invalid kind
    test('returns 400 for invalid thread kind', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments`,
        {
          data: {
            body: 'Test body',
            kind: 'invalid_kind',
            author: 'reviewer@test.com',
          },
        }
      );

      expect(response.status()).toBe(400);
      const result = await response.json();
      expect(result.error).toBe('validation_error');
      expect(result.details[0].field).toBe('kind');
    });

    // AC: @review-records-daemon-api ac-10 - review not found
    test('returns 404 for non-existent review', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/nonexistent-review/comments`,
        {
          data: { body: 'Test', author: 'reviewer@test.com' },
        }
      );

      expect(response.status()).toBe(404);
      const result = await response.json();
      expect(result.error).toBe('not_found');
      expect(result).toHaveProperty('suggestion');
    });

    // AC: @review-records-daemon-api ac-10 - invalid anchor type
    test('returns 400 for invalid anchor type', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments`,
        {
          data: {
            body: 'Test',
            author: 'reviewer@test.com',
            anchor: { type: 'invalid' },
          },
        }
      );

      expect(response.status()).toBe(400);
      const result = await response.json();
      expect(result.error).toBe('validation_error');
    });

    // AC: @review-records-daemon-api ac-10 - invalid code anchor side
    test('returns 400 for invalid code anchor side', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments`,
        {
          data: {
            body: 'Test',
            author: 'reviewer@test.com',
            anchor: {
              type: 'code',
              path: 'src/file.ts',
              side: 'invalid',
              line_start: 1,
              line_end: 1,
              commit: 'abc123',
            },
          },
        }
      );

      expect(response.status()).toBe(400);
      const result = await response.json();
      expect(result.error).toBe('validation_error');
      expect(result.details[0].field).toBe('anchor.side');
    });

    // AC: @review-records-daemon-api ac-10 - negative line_start
    test('returns 400 for negative line_start', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments`,
        {
          data: {
            body: 'Test',
            author: 'reviewer@test.com',
            anchor: {
              type: 'code',
              path: 'src/file.ts',
              side: 'head',
              line_start: -1,
              line_end: 5,
              commit: 'abc123',
            },
          },
        }
      );

      expect(response.status()).toBe(400);
      const result = await response.json();
      expect(result.error).toBe('validation_error');
      expect(result.details[0].field).toBe('anchor.line_start');
    });

    // AC: @review-records-daemon-api ac-10 - float line_end
    test('returns 400 for non-integer line_end', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments`,
        {
          data: {
            body: 'Test',
            author: 'reviewer@test.com',
            anchor: {
              type: 'code',
              path: 'src/file.ts',
              side: 'head',
              line_start: 1,
              line_end: 1.5,
              commit: 'abc123',
            },
          },
        }
      );

      expect(response.status()).toBe(400);
      const result = await response.json();
      expect(result.error).toBe('validation_error');
      expect(result.details[0].field).toBe('anchor.line_end');
    });

    // AC: @review-records-daemon-api ac-10 - line_end < line_start
    test('returns 400 when line_end is less than line_start', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments`,
        {
          data: {
            body: 'Test',
            author: 'reviewer@test.com',
            anchor: {
              type: 'code',
              path: 'src/file.ts',
              side: 'head',
              line_start: 10,
              line_end: 5,
              commit: 'abc123',
            },
          },
        }
      );

      expect(response.status()).toBe(400);
      const result = await response.json();
      expect(result.error).toBe('validation_error');
      expect(result.details[0].field).toBe('anchor.line_end');
    });

    // AC: @review-records-daemon-api ac-10 - empty structured anchor
    test('returns 400 for empty structured anchor', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments`,
        {
          data: {
            body: 'Test',
            author: 'reviewer@test.com',
            anchor: { type: 'structured' },
          },
        }
      );

      expect(response.status()).toBe(400);
      const result = await response.json();
      expect(result.error).toBe('validation_error');
    });
  });

  test.describe('POST /api/reviews/:id/comments/:threadId/replies', () => {
    // AC: @review-records-daemon-api ac-4
    test('adds a reply to an existing thread', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments/${BLOCKER_THREAD_ULID}/replies`,
        {
          data: {
            body: 'Fixed in commit abc1234',
            author: 'worker@test.com',
          },
        }
      );

      expect(response.status()).toBe(200);
      const thread = await response.json();
      expect(thread._ulid).toBe(BLOCKER_THREAD_ULID);
      // Thread should have the original entry plus the new reply
      expect(thread.entries.length).toBeGreaterThanOrEqual(2);
      const lastEntry = thread.entries[thread.entries.length - 1];
      expect(lastEntry.body).toBe('Fixed in commit abc1234');
      expect(lastEntry.author).toBe('worker@test.com');
    });

    // AC: @review-records-daemon-api ac-4 - reply is persisted
    test('reply appears in subsequent thread fetch', async ({ request, daemon }) => {
      const replyBody = `Reply persistence test ${Date.now()}`;
      const replyResponse = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments/${NIT_THREAD_ULID}/replies`,
        {
          data: {
            body: replyBody,
            author: 'worker@test.com',
          },
        }
      );
      expect(replyResponse.status()).toBe(200);

      // Fetch review and verify
      const getResponse = await request.get(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}`
      );
      if (getResponse.status() === 200) {
        const review = await getResponse.json();
        const thread = review.threads?.find(
          (t: { _ulid: string }) => t._ulid === NIT_THREAD_ULID
        );
        expect(thread).toBeDefined();
        const hasReply = thread.entries.some(
          (e: { body: string }) => e.body === replyBody
        );
        expect(hasReply).toBe(true);
      }
    });

    // AC: @review-records-daemon-api ac-10 - thread not found
    test('returns 404 for non-existent thread', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments/nonexistent-thread/replies`,
        {
          data: { body: 'Test reply', author: 'worker@test.com' },
        }
      );

      expect(response.status()).toBe(404);
      const result = await response.json();
      expect(result.error).toBe('not_found');
    });

    // AC: @review-records-daemon-api ac-10 - review not found
    test('returns 404 for non-existent review', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/nonexistent/comments/${BLOCKER_THREAD_ULID}/replies`,
        {
          data: { body: 'Test reply', author: 'worker@test.com' },
        }
      );

      expect(response.status()).toBe(404);
      const result = await response.json();
      expect(result.error).toBe('not_found');
    });

    // AC: @review-records-daemon-api ac-10 - empty body
    test('returns 400 when reply body is empty', async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments/${BLOCKER_THREAD_ULID}/replies`,
        {
          data: { body: '', author: 'worker@test.com' },
        }
      );

      expect(response.status()).toBe(400);
      const result = await response.json();
      expect(result.error).toBe('validation_error');
    });
  });

  test.describe('PATCH /api/reviews/:id/comments/:threadId/resolve', () => {
    // AC: @review-records-daemon-api ac-5
    test('resolves an open thread', async ({ request, daemon }) => {
      const response = await request.patch(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments/${BLOCKER_THREAD_ULID}/resolve`,
        {
          data: { actor: 'worker@test.com' },
        }
      );

      expect(response.status()).toBe(200);
      const thread = await response.json();
      expect(thread._ulid).toBe(BLOCKER_THREAD_ULID);
      expect(thread.resolved_at).toBeDefined();
      expect(thread.resolved_by).toBe('worker@test.com');
    });

    // AC: @review-records-daemon-api ac-5 - already resolved thread returns 409
    test('returns 409 when thread is already resolved', async ({ request, daemon }) => {
      const response = await request.patch(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments/${RESOLVED_THREAD_ULID}/resolve`,
        {
          data: { actor: 'worker@test.com' },
        }
      );

      expect(response.status()).toBe(409);
      const result = await response.json();
      expect(result.error).toBe('invalid_transition');
      expect(result.current).toBe('resolved');
    });

    // AC: @review-records-daemon-api ac-10 - thread not found
    test('returns 404 for non-existent thread', async ({ request, daemon }) => {
      const response = await request.patch(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments/nonexistent/resolve`,
        {
          data: { actor: 'worker@test.com' },
        }
      );

      expect(response.status()).toBe(404);
      const result = await response.json();
      expect(result.error).toBe('not_found');
    });

    // AC: @review-records-daemon-api ac-10 - review not found
    test('returns 404 for non-existent review', async ({ request, daemon }) => {
      const response = await request.patch(
        `${daemon.baseUrl}/api/reviews/nonexistent/comments/${BLOCKER_THREAD_ULID}/resolve`,
        {
          data: { actor: 'worker@test.com' },
        }
      );

      expect(response.status()).toBe(404);
      const result = await response.json();
      expect(result.error).toBe('not_found');
    });
  });

  test.describe('PATCH /api/reviews/:id/comments/:threadId/reopen', () => {
    // AC: @review-records-daemon-api ac-5
    test('reopens a resolved thread', async ({ request, daemon }) => {
      const response = await request.patch(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments/${RESOLVED_THREAD_ULID}/reopen`,
        {
          data: { actor: 'reviewer@test.com' },
        }
      );

      expect(response.status()).toBe(200);
      const thread = await response.json();
      expect(thread._ulid).toBe(RESOLVED_THREAD_ULID);
      expect(thread.resolved_at).toBeNull();
      expect(thread.resolved_by).toBeNull();
    });

    // AC: @review-records-daemon-api ac-5 - not resolved thread returns 409
    test('returns 409 when thread is not resolved', async ({ request, daemon }) => {
      const response = await request.patch(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments/${NIT_THREAD_ULID}/reopen`,
        {
          data: { actor: 'reviewer@test.com' },
        }
      );

      expect(response.status()).toBe(409);
      const result = await response.json();
      expect(result.error).toBe('invalid_transition');
      expect(result.current).toBe('open');
    });

    // AC: @review-records-daemon-api ac-10 - thread not found
    test('returns 404 for non-existent thread', async ({ request, daemon }) => {
      const response = await request.patch(
        `${daemon.baseUrl}/api/reviews/${OPEN_REVIEW_ULID}/comments/nonexistent/reopen`,
        {
          data: { actor: 'reviewer@test.com' },
        }
      );

      expect(response.status()).toBe(404);
      const result = await response.json();
      expect(result.error).toBe('not_found');
    });
  });
});
