/**
 * E2E API Tests for Daemon Tasks Endpoints
 *
 * Tests verify actual HTTP behavior by calling the running daemon directly.
 * These replace the static analysis tests in tests/daemon-api-tasks.test.ts
 * which only read source files and check string patterns.
 *
 * Covered ACs:
 * - @api-contract ac-2: GET /api/tasks returns tasks with expected fields
 * - @api-contract ac-3: GET /api/tasks?status filter (multi-value)
 * - @api-contract ac-4: GET /api/tasks pagination {items, total, offset, limit}
 * - @api-contract ac-5: GET /api/tasks/:ref returns full task with notes, todos, deps
 * - @api-contract ac-6: POST /api/tasks/:ref/start transitions to in_progress
 * - @api-contract ac-7: POST /api/tasks/:ref/note appends note
 */

import { test, expect } from '../fixtures/test-base';

const DAEMON_URL = 'http://localhost:3456';

test.describe('Tasks API', () => {
  // Ensure daemon is running for all tests via fixture
  test.beforeEach(async ({ daemon }) => {
    // daemon fixture ensures daemon is running
  });

  test.describe('GET /api/tasks', () => {
    // AC: @api-contract ac-2
    test('returns tasks with required fields', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/tasks`);

      expect(response.status()).toBe(200);

      const body = await response.json();

      // Response should have items array (paginated format)
      expect(body).toHaveProperty('items');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('offset');
      expect(body).toHaveProperty('limit');
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);

      // Each task should have required fields
      const task = body.items[0];
      expect(task).toHaveProperty('_ulid');
      expect(task).toHaveProperty('title');
      expect(task).toHaveProperty('status');
      expect(task).toHaveProperty('priority');
      // notes_count is derived field
      expect(task).toHaveProperty('notes_count');
    });

    // AC: @api-contract ac-2 - spec_ref field
    test('returns tasks with spec_ref field when present', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/tasks`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.items)).toBe(true);

      // Find a task with spec_ref
      const taskWithSpecRef = body.items.find(
        (t: { spec_ref?: string }) => t.spec_ref !== undefined && t.spec_ref !== null
      );
      if (taskWithSpecRef) {
        expect(typeof taskWithSpecRef.spec_ref).toBe('string');
        expect(taskWithSpecRef.spec_ref).toMatch(/^@/);
      }
    });

    // AC: @api-contract ac-3 - status filter (single value)
    test('filters tasks by single status value', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/tasks?status=pending`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.items)).toBe(true);

      // All returned tasks should have pending status
      for (const task of body.items) {
        expect(task.status).toBe('pending');
      }
    });

    // AC: @api-contract ac-3 - status filter (multi-value)
    test('filters tasks by multiple status values', async ({ request, daemon }) => {
      const response = await request.get(
        `${DAEMON_URL}/api/tasks?status=pending&status=in_progress`
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.items)).toBe(true);

      // All returned tasks should have pending or in_progress status
      for (const task of body.items) {
        expect(['pending', 'in_progress']).toContain(task.status);
      }
    });

    // AC: @api-contract ac-3 - comma-separated status filter
    test('filters tasks by comma-separated status values', async ({ request, daemon }) => {
      const response = await request.get(
        `${DAEMON_URL}/api/tasks?status=pending,in_progress`
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.items)).toBe(true);

      // All returned tasks should match the filter
      for (const task of body.items) {
        expect(['pending', 'in_progress']).toContain(task.status);
      }
    });

    // AC: @api-contract ac-4 - pagination shape
    test('returns paginated response with {items, total, offset, limit}', async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${DAEMON_URL}/api/tasks?offset=0&limit=2`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty('items');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('offset');
      expect(body).toHaveProperty('limit');

      expect(typeof body.total).toBe('number');
      expect(body.offset).toBe(0);
      expect(body.limit).toBe(2);
      expect(body.items.length).toBeLessThanOrEqual(2);
    });

    // AC: @api-contract ac-4 - pagination offset
    test('respects offset parameter for pagination', async ({ request, daemon }) => {
      // Get first page
      const page1 = await request.get(`${DAEMON_URL}/api/tasks?offset=0&limit=2`);
      expect(page1.status()).toBe(200);
      const body1 = await page1.json();

      // Fixtures have 5 tasks — there must be more than 2 for pagination to be meaningful
      expect(body1.total).toBeGreaterThan(2);
      expect(body1.items.length).toBe(2);

      // Get second page
      const page2 = await request.get(`${DAEMON_URL}/api/tasks?offset=2&limit=2`);
      expect(page2.status()).toBe(200);
      const body2 = await page2.json();

      // Pages should have different items
      const ids1 = body1.items.map((t: { _ulid: string }) => t._ulid);
      const ids2 = body2.items.map((t: { _ulid: string }) => t._ulid);
      // No overlap between pages
      for (const id of ids2) {
        expect(ids1).not.toContain(id);
      }
    });

    // AC: @api-contract ac-4 - total count is consistent
    test('total count is consistent across paginated requests', async ({ request, daemon }) => {
      const response1 = await request.get(`${DAEMON_URL}/api/tasks?offset=0&limit=2`);
      const response2 = await request.get(`${DAEMON_URL}/api/tasks?offset=2&limit=2`);

      const body1 = await response1.json();
      const body2 = await response2.json();

      // Total should be the same across pages
      expect(body1.total).toBe(body2.total);
    });
  });

  test.describe('GET /api/tasks/:ref', () => {
    // AC: @api-contract ac-5 - resolve by slug
    test('resolves task by slug and returns full task', async ({ request, daemon }) => {
      // Use a known task slug from fixtures
      const response = await request.get(`${DAEMON_URL}/api/tasks/@test-task-ready`);
      expect(response.status()).toBe(200);

      const task = await response.json();
      expect(task).toHaveProperty('_ulid');
      expect(task).toHaveProperty('title');
      expect(task).toHaveProperty('status');
      expect(task).toHaveProperty('priority');
      expect(task).toHaveProperty('notes');
      expect(task).toHaveProperty('todos');
      expect(task).toHaveProperty('depends_on');
    });

    // AC: @api-contract ac-5 - returns notes array
    test('returns task with notes array', async ({ request, daemon }) => {
      // test-task-in-progress has a note in the fixture
      const response = await request.get(`${DAEMON_URL}/api/tasks/@test-task-in-progress`);
      expect(response.status()).toBe(200);

      const task = await response.json();
      expect(Array.isArray(task.notes)).toBe(true);
      expect(task.notes.length).toBeGreaterThan(0);

      const note = task.notes[0];
      expect(note).toHaveProperty('_ulid');
      expect(note).toHaveProperty('content');
      expect(note).toHaveProperty('created_at');
    });

    // AC: @api-contract ac-5 - returns dependencies
    test('returns task with depends_on array', async ({ request, daemon }) => {
      // test-task-blocked depends on test-task-ready
      const response = await request.get(`${DAEMON_URL}/api/tasks/@test-task-blocked`);
      expect(response.status()).toBe(200);

      const task = await response.json();
      expect(Array.isArray(task.depends_on)).toBe(true);
      expect(task.depends_on.length).toBeGreaterThan(0);
    });

    // AC: @api-contract ac-5 - resolve by ULID
    test('resolves task by ULID prefix', async ({ request, daemon }) => {
      // First get the task to find its ULID
      const listResponse = await request.get(`${DAEMON_URL}/api/tasks`);
      const body = await listResponse.json();
      expect(body.items.length).toBeGreaterThan(0);

      const firstTask = body.items[0];
      // Get by full ULID
      const response = await request.get(`${DAEMON_URL}/api/tasks/@${firstTask._ulid}`);
      expect(response.status()).toBe(200);

      const task = await response.json();
      expect(task._ulid).toBe(firstTask._ulid);
    });

    // AC: @api-contract ac-5 (error handling) - 404 for invalid ref
    test('returns 404 for non-existent task ref', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/tasks/@nonexistent-task-xyz`);
      expect(response.status()).toBe(404);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toBe('not_found');
    });
  });

  test.describe('POST /api/tasks/:ref/start', () => {
    // AC: @api-contract ac-6 - transition to in_progress
    test('transitions pending task to in_progress', async ({ request, daemon }) => {
      // Use a fresh fixture — test-task-ready starts as pending
      const startResponse = await request.post(
        `${DAEMON_URL}/api/tasks/@test-task-ready/start`,
        { data: {} }
      );
      expect(startResponse.status()).toBe(200);

      const updatedTask = await startResponse.json();
      expect(updatedTask.status).toBe('in_progress');
      expect(updatedTask).toHaveProperty('started_at');
      expect(updatedTask.started_at).toBeTruthy();
    });

    // AC: @api-contract ac-6 - returns updated task with full shape
    test('response includes full task shape after start', async ({ request, daemon }) => {
      // test-task-ready starts as pending — transition it and verify full response shape
      const startResponse = await request.post(
        `${DAEMON_URL}/api/tasks/@test-task-ready/start`,
        { data: {} }
      );

      // May already be in_progress from previous test in this suite (Playwright runs tests
      // within a describe block sequentially), so accept 200 or 409 only if the 409 body
      // confirms the task is already in_progress (meaning our first /start test succeeded)
      const status = startResponse.status();
      if (status === 200) {
        const task = await startResponse.json();
        expect(task).toHaveProperty('_ulid');
        expect(task).toHaveProperty('status');
        expect(task.status).toBe('in_progress');
        expect(task).toHaveProperty('title');
        expect(task).toHaveProperty('started_at');
      } else {
        // Should be 409 because test-task-ready was already started in the previous test
        expect(status).toBe(409);
        const body = await startResponse.json();
        expect(body.error).toBe('invalid_transition');
        // Verify it's in_progress (not some other invalid state)
        expect(body.current).toBe('in_progress');
      }
    });

    // AC: @api-contract ac-6 (error handling) - 404 for invalid ref
    test('returns 404 for non-existent task', async ({ request, daemon }) => {
      const response = await request.post(
        `${DAEMON_URL}/api/tasks/@nonexistent-task-xyz/start`,
        { data: {} }
      );
      expect(response.status()).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('not_found');
    });

    // AC: @api-contract ac-6 (error handling) - 409 for invalid state transition
    test('returns 409 with transition info for invalid state transition', async ({
      request,
      daemon,
    }) => {
      // test-task-completed is in completed state — cannot be started
      const response = await request.post(
        `${DAEMON_URL}/api/tasks/@test-task-completed/start`,
        { data: {} }
      );
      expect(response.status()).toBe(409);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toBe('invalid_transition');
      expect(body).toHaveProperty('current');
      expect(body).toHaveProperty('valid_transitions');
      expect(Array.isArray(body.valid_transitions)).toBe(true);
    });
  });

  test.describe('POST /api/tasks/:ref/note', () => {
    // AC: @api-contract ac-7 - append note
    test('appends note to task and returns updated task', async ({ request, daemon }) => {
      const noteContent = `E2E test note ${Date.now()}`;
      const response = await request.post(
        `${DAEMON_URL}/api/tasks/@test-task-in-progress/note`,
        {
          data: { content: noteContent, author: '@test' },
        }
      );
      expect(response.status()).toBe(200);

      const updatedTask = await response.json();
      expect(updatedTask).toHaveProperty('notes');
      expect(Array.isArray(updatedTask.notes)).toBe(true);

      // The new note should be in the notes array
      const addedNote = updatedTask.notes.find(
        (n: { content: string }) => n.content === noteContent
      );
      expect(addedNote).toBeDefined();
      expect(addedNote.content).toBe(noteContent);
    });

    // AC: @api-contract ac-7 - note has required fields
    test('created note has ulid, content, created_at', async ({ request, daemon }) => {
      const noteContent = `Note field check ${Date.now()}`;
      const response = await request.post(
        `${DAEMON_URL}/api/tasks/@test-task-in-progress/note`,
        {
          data: { content: noteContent },
        }
      );
      expect(response.status()).toBe(200);

      const updatedTask = await response.json();
      const notes = updatedTask.notes;
      const newNote = notes[notes.length - 1]; // most recently added note

      expect(newNote).toHaveProperty('_ulid');
      expect(newNote).toHaveProperty('content');
      expect(newNote).toHaveProperty('created_at');
      expect(typeof newNote._ulid).toBe('string');
      expect(newNote._ulid.length).toBeGreaterThan(0);
    });

    // AC: @api-contract ac-7 (error handling) - 400 for missing content
    test('returns 400 validation error when content is missing', async ({ request, daemon }) => {
      const response = await request.post(
        `${DAEMON_URL}/api/tasks/@test-task-in-progress/note`,
        { data: {} }
      );
      expect(response.status()).toBe(400);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toBe('validation_error');
    });

    // AC: @api-contract ac-7 (error handling) - 404 for invalid ref
    test('returns 404 for non-existent task', async ({ request, daemon }) => {
      const response = await request.post(
        `${DAEMON_URL}/api/tasks/@nonexistent-task-xyz/note`,
        { data: { content: 'test note' } }
      );
      expect(response.status()).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('not_found');
    });
  });

  test.describe('Content-Type and Response Format', () => {
    // AC: @api-contract ac-1 (partial) - JSON content type
    test('returns JSON content type for all endpoints', async ({ request, daemon }) => {
      const endpoints = [
        { method: 'GET', url: `${DAEMON_URL}/api/tasks` },
        { method: 'GET', url: `${DAEMON_URL}/api/tasks/@test-task-ready` },
      ];

      for (const endpoint of endpoints) {
        const response = await request.get(endpoint.url);
        const contentType = response.headers()['content-type'] || '';
        expect(contentType).toContain('application/json');
      }
    });

    // AC: @api-contract ac-2 - items have consistent shape across list and detail
    test('list and detail responses have consistent task fields', async ({ request, daemon }) => {
      // Get list
      const listResponse = await request.get(`${DAEMON_URL}/api/tasks`);
      const listBody = await listResponse.json();
      expect(listBody.items.length).toBeGreaterThan(0);

      const listTask = listBody.items[0];
      const listRef = listTask._ulid || (listTask.slugs && listTask.slugs[0]);
      expect(listRef).toBeTruthy();

      // Get detail
      const detailResponse = await request.get(`${DAEMON_URL}/api/tasks/@${listRef}`);
      expect(detailResponse.status()).toBe(200);
      const detailTask = await detailResponse.json();

      // Core fields should be consistent
      expect(detailTask._ulid).toBe(listTask._ulid);
      expect(detailTask.title).toBe(listTask.title);
      expect(detailTask.status).toBe(listTask.status);
    });
  });
});
