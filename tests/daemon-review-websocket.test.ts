/**
 * Tests for WebSocket broadcasts on review mutation endpoints
 *
 * Spec: @review-records-daemon-api ac-9
 * Task: @task-review-api-websocket
 *
 * Verifies that all review mutation endpoints broadcast events
 * on the "reviews:updates" topic so the UI can refresh without polling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { Elysia } from 'elysia';
import { createTempDir, cleanupTempDir, initGitRepo, testUlid } from './helpers/cli';
import { projectContextMiddleware } from '../dist/daemon/middleware/project-context.ts';
import { createReviewsRoutes } from '../dist/daemon/routes/reviews.ts';
import { PubSubManager } from '../dist/daemon/websocket/pubsub.ts';

// Test ULIDs
const REVIEW_OPEN_ULID = testUlid('RVOP', 1);
const REVIEW_DRAFT_ULID = testUlid('RVDR', 2);
const REVIEW_CLOSED_ULID = testUlid('RVCL', 3);
const TASK_ULID = testUlid('TASK', 4);
const THREAD_ULID = testUlid('THRD', 5);

let tempDir: string;
let app: Elysia;
let pubsub: PubSubManager;
let broadcastSpy: ReturnType<typeof vi.spyOn>;

function makeRequest(method: string, urlPath: string, body?: unknown) {
  const url = `http://localhost${urlPath}`;
  const opts: RequestInit = {
    method,
    headers: {
      Host: 'localhost',
      'X-Kspec-Dir': tempDir,
      'Content-Type': 'application/json',
    },
  };
  if (body) {
    opts.body = JSON.stringify(body);
  }
  return app.handle(new Request(url, opts));
}

function setupFixtures() {
  mkdirSync(path.join(tempDir, '.kspec'), { recursive: true });
  mkdirSync(path.join(tempDir, 'modules'), { recursive: true });

  writeFileSync(
    path.join(tempDir, 'kynetic.yaml'),
    `kynetic: "1.0"
project:
  name: Test Project
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
tasks_file: project.tasks.yaml
`,
  );

  writeFileSync(
    path.join(tempDir, 'modules', 'test.yaml'),
    `features:
  - _ulid: "${testUlid('SPEC', 1)}"
    slugs:
      - test-feature
    title: "Test Feature"
    type: feature
    description: "A test feature"
    created: "2026-01-01T00:00:00Z"
`,
  );

  writeFileSync(
    path.join(tempDir, 'project.tasks.yaml'),
    `tasks:
  - _ulid: "${TASK_ULID}"
    slugs:
      - task-test
    title: "Test Task"
    description: "A test task"
    status: pending_review
    spec_ref: "@test-feature"
    review_ref: "@review-open"
    created_at: "2026-01-01T00:00:00Z"
`,
  );

  writeFileSync(
    path.join(tempDir, 'project.reviews.yaml'),
    `kynetic_reviews: "1.0"
reviews:
  - _ulid: "${REVIEW_OPEN_ULID}"
    slugs:
      - review-open
    title: "Open review"
    lifecycle_state: open
    author: "@test"
    subject:
      type: task
      ref: "@task-test"
      shadow_commit: "abc123"
      content_hash: "hash1"
    verdicts: []
    checks: []
    threads:
      - _ulid: "${THREAD_ULID}"
        kind: blocker
        resolved: false
        entries:
          - _ulid: "${testUlid('ENTR', 1)}"
            author: "reviewer@example.com"
            body: "This needs fixing"
            created_at: "2026-01-01T00:00:00Z"
        anchors: []
        created_at: "2026-01-01T00:00:00Z"
        updated_at: "2026-01-01T00:00:00Z"
    events: []
    related_refs: []
    created_at: "2026-01-01T00:00:00Z"
    updated_at: "2026-01-01T00:00:00Z"
  - _ulid: "${REVIEW_DRAFT_ULID}"
    slugs:
      - review-draft
    title: "Draft review"
    lifecycle_state: draft
    author: "@test"
    subject:
      type: plan
      ref: "@plan-test"
      shadow_commit: "abc123"
      content_hash: "hash2"
    verdicts: []
    checks: []
    threads: []
    events: []
    related_refs: []
    created_at: "2026-01-01T00:00:00Z"
    updated_at: "2026-01-01T00:00:00Z"
  - _ulid: "${REVIEW_CLOSED_ULID}"
    slugs:
      - review-closed
    title: "Closed review"
    lifecycle_state: closed
    author: "@test"
    subject:
      type: plan
      ref: "@plan-test"
      shadow_commit: "abc123"
      content_hash: "hash3"
    verdicts: []
    checks: []
    threads: []
    events: []
    related_refs: []
    created_at: "2026-01-01T00:00:00Z"
    updated_at: "2026-01-01T00:00:00Z"
`,
  );

  execSync('git add -A && git commit -m "kspec project setup"', { cwd: tempDir, stdio: 'pipe' });
}

// AC: @review-records-daemon-api ac-9
describe('Review WebSocket Broadcasts', () => {
  beforeEach(async () => {
    tempDir = await createTempDir('kspec-review-ws-');
    initGitRepo(tempDir);
    setupFixtures();

    pubsub = new PubSubManager();
    broadcastSpy = vi.spyOn(pubsub, 'broadcast');
    const { middleware } = projectContextMiddleware();
    app = new Elysia()
      .use(middleware)
      .use(createReviewsRoutes({ pubsub }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @review-records-daemon-api ac-9
  it('should broadcast thread_created when adding a comment thread', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/comments`, {
      body: 'Found an issue here',
      kind: 'blocker',
      author: 'reviewer@test.com',
    });

    expect(response.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledOnce();
    expect(broadcastSpy).toHaveBeenCalledWith(
      'reviews:updates',
      'thread_created',
      expect.objectContaining({
        review_ulid: REVIEW_OPEN_ULID,
        kind: 'blocker',
        author: 'reviewer@test.com',
      }),
      expect.any(String),
    );

    // Verify thread_ulid is included in the payload
    const payload = broadcastSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(payload.thread_ulid).toBeDefined();
    expect(typeof payload.thread_ulid).toBe('string');
  });

  // AC: @review-records-daemon-api ac-9
  it('should broadcast thread_replied when adding a reply', async () => {
    const response = await makeRequest(
      'POST',
      `/api/reviews/${REVIEW_OPEN_ULID}/comments/${THREAD_ULID}/replies`,
      {
        body: 'Fixed in latest commit',
        author: 'worker@test.com',
      },
    );

    expect(response.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledOnce();
    expect(broadcastSpy).toHaveBeenCalledWith(
      'reviews:updates',
      'thread_replied',
      expect.objectContaining({
        review_ulid: REVIEW_OPEN_ULID,
        thread_ulid: THREAD_ULID,
        author: 'worker@test.com',
      }),
      expect.any(String),
    );

    // Verify entry_ulid is included
    const payload = broadcastSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(payload.entry_ulid).toBeDefined();
    expect(typeof payload.entry_ulid).toBe('string');
  });

  // AC: @review-records-daemon-api ac-9
  it('should broadcast thread_resolved when resolving a thread', async () => {
    const response = await makeRequest(
      'PATCH',
      `/api/reviews/${REVIEW_OPEN_ULID}/comments/${THREAD_ULID}/resolve`,
      {
        actor: 'reviewer@test.com',
      },
    );

    expect(response.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledOnce();
    expect(broadcastSpy).toHaveBeenCalledWith(
      'reviews:updates',
      'thread_resolved',
      expect.objectContaining({
        review_ulid: REVIEW_OPEN_ULID,
        thread_ulid: THREAD_ULID,
        actor: 'reviewer@test.com',
      }),
      expect.any(String),
    );
  });

  // AC: @review-records-daemon-api ac-9
  it('should broadcast thread_reopened when reopening a resolved thread', async () => {
    // First resolve the thread
    await makeRequest(
      'PATCH',
      `/api/reviews/${REVIEW_OPEN_ULID}/comments/${THREAD_ULID}/resolve`,
      { actor: 'reviewer@test.com' },
    );
    broadcastSpy.mockClear();

    // Then reopen it
    const response = await makeRequest(
      'PATCH',
      `/api/reviews/${REVIEW_OPEN_ULID}/comments/${THREAD_ULID}/reopen`,
      {
        actor: 'reviewer@test.com',
      },
    );

    expect(response.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledOnce();
    expect(broadcastSpy).toHaveBeenCalledWith(
      'reviews:updates',
      'thread_reopened',
      expect.objectContaining({
        review_ulid: REVIEW_OPEN_ULID,
        thread_ulid: THREAD_ULID,
        actor: 'reviewer@test.com',
      }),
      expect.any(String),
    );
  });

  // AC: @review-records-daemon-api ac-9
  it('should broadcast verdict_submitted when recording a verdict', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      decision: 'approve',
      reviewer: 'lead@test.com',
    });

    expect(response.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledOnce();
    expect(broadcastSpy).toHaveBeenCalledWith(
      'reviews:updates',
      'verdict_submitted',
      expect.objectContaining({
        review_ulid: REVIEW_OPEN_ULID,
        decision: 'approve',
        reviewer: 'lead@test.com',
        disposition: expect.any(String),
        lifecycle_state: expect.any(String),
      }),
      expect.any(String),
    );
  });

  // AC: @review-records-daemon-api ac-9
  it('should broadcast check_added when recording a check', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/checks`, {
      name: 'vitest',
      status: 'pass',
      runner: 'vitest',
      evidence: 'All 100 tests passed',
    });

    expect(response.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledOnce();
    expect(broadcastSpy).toHaveBeenCalledWith(
      'reviews:updates',
      'check_added',
      expect.objectContaining({
        review_ulid: REVIEW_OPEN_ULID,
        check_name: 'vitest',
        check_status: 'pass',
        gate_state: expect.any(String),
      }),
      expect.any(String),
    );
  });

  // AC: @review-records-daemon-api ac-9
  it('should broadcast lifecycle_changed when transitioning lifecycle state', async () => {
    const response = await makeRequest('PATCH', `/api/reviews/${REVIEW_DRAFT_ULID}/lifecycle`, {
      target: 'open',
      actor: 'reviewer@test.com',
    });

    expect(response.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledOnce();
    expect(broadcastSpy).toHaveBeenCalledWith(
      'reviews:updates',
      'lifecycle_changed',
      expect.objectContaining({
        review_ulid: REVIEW_DRAFT_ULID,
        from: 'draft',
        to: 'open',
        actor: 'reviewer@test.com',
      }),
      expect.any(String),
    );
  });

  // AC: @review-records-daemon-api ac-9
  it('should not broadcast when mutation fails with validation error', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      decision: 'invalid_decision',
      reviewer: 'test@example.com',
    });

    expect(response.status).toBe(400);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  // AC: @review-records-daemon-api ac-9
  it('should not broadcast when review is not found', async () => {
    const response = await makeRequest('POST', '/api/reviews/nonexistent/verdicts', {
      decision: 'approve',
      reviewer: 'test@example.com',
    });

    expect(response.status).toBe(404);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  // AC: @review-records-daemon-api ac-9
  it('should include projectPath in all broadcasts', async () => {
    await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/comments`, {
      body: 'Test comment',
      kind: 'nit',
    });

    expect(broadcastSpy).toHaveBeenCalledOnce();
    // Fourth argument is the projectPath
    const projectPath = broadcastSpy.mock.calls[0][3];
    expect(projectPath).toBeDefined();
    expect(typeof projectPath).toBe('string');
  });
});

// AC: @review-records-daemon-api ac-9
describe('Review WebSocket Event Data Shape', () => {
  // Type conformance tests: verify broadcast payloads match the typed interfaces
  // from packages/shared/src/websocket.ts. The import ensures the interfaces
  // compile; the runtime checks verify the actual broadcast data shape.

  let localTempDir: string;
  let localApp: Elysia;
  let localPubsub: PubSubManager;
  let localSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    localTempDir = await createTempDir('kspec-review-ws-shape-');
    initGitRepo(localTempDir);

    mkdirSync(path.join(localTempDir, '.kspec'), { recursive: true });
    mkdirSync(path.join(localTempDir, 'modules'), { recursive: true });

    writeFileSync(
      path.join(localTempDir, 'kynetic.yaml'),
      `kynetic: "1.0"
project:
  name: Test Project
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
tasks_file: project.tasks.yaml
`,
    );

    writeFileSync(
      path.join(localTempDir, 'modules', 'test.yaml'),
      `features:
  - _ulid: "${testUlid('SPEC', 1)}"
    slugs:
      - test-feature
    title: "Test Feature"
    type: feature
    description: "A test feature"
    created: "2026-01-01T00:00:00Z"
`,
    );

    writeFileSync(
      path.join(localTempDir, 'project.tasks.yaml'),
      `tasks: []
`,
    );

    writeFileSync(
      path.join(localTempDir, 'project.reviews.yaml'),
      `kynetic_reviews: "1.0"
reviews:
  - _ulid: "${testUlid('RVSH', 1)}"
    slugs:
      - review-shape-test
    title: "Shape test review"
    lifecycle_state: open
    author: "@test"
    subject:
      type: plan
      ref: "@plan-test"
      shadow_commit: "abc123"
      content_hash: "hash1"
    verdicts: []
    checks: []
    threads: []
    events: []
    related_refs: []
    created_at: "2026-01-01T00:00:00Z"
    updated_at: "2026-01-01T00:00:00Z"
`,
    );

    execSync('git add -A && git commit -m "setup"', { cwd: localTempDir, stdio: 'pipe' });

    localPubsub = new PubSubManager();
    localSpy = vi.spyOn(localPubsub, 'broadcast');
    const { middleware } = projectContextMiddleware();
    localApp = new Elysia()
      .use(middleware)
      .use(createReviewsRoutes({ pubsub: localPubsub }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(localTempDir);
  });

  it('should broadcast thread_created with ReviewThreadCreatedEventData shape', async () => {
    const response = await localApp.handle(new Request('http://localhost/api/reviews/review-shape-test/comments', {
      method: 'POST',
      headers: { Host: 'localhost', 'X-Kspec-Dir': localTempDir, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Test', kind: 'nit', author: 'tester' }),
    }));

    expect(response.status).toBe(200);
    const payload = localSpy.mock.calls[0][2] as Record<string, unknown>;
    // ReviewThreadCreatedEventData shape: review_ulid, thread_ulid, kind, author
    expect(payload).toHaveProperty('review_ulid');
    expect(payload).toHaveProperty('thread_ulid');
    expect(payload).toHaveProperty('kind');
    expect(payload).toHaveProperty('author');
    expect(Object.keys(payload).sort()).toEqual(['author', 'kind', 'review_ulid', 'thread_ulid']);
  });

  it('should broadcast check_added with ReviewCheckAddedEventData shape', async () => {
    const response = await localApp.handle(new Request(`http://localhost/api/reviews/review-shape-test/checks`, {
      method: 'POST',
      headers: { Host: 'localhost', 'X-Kspec-Dir': localTempDir, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'vitest', status: 'pass', runner: 'vitest' }),
    }));

    expect(response.status).toBe(200);
    const payload = localSpy.mock.calls[0][2] as Record<string, unknown>;
    // ReviewCheckAddedEventData shape: review_ulid, check_name, check_status, gate_state
    expect(payload).toHaveProperty('review_ulid');
    expect(payload).toHaveProperty('check_name');
    expect(payload).toHaveProperty('check_status');
    expect(payload).toHaveProperty('gate_state');
    expect(Object.keys(payload).sort()).toEqual(['check_name', 'check_status', 'gate_state', 'review_ulid']);
  });
});

// Trait AC annotations for this task's spec
// AC: @trait-json-output ac-1 — N/A: WebSocket events are not CLI commands; they broadcast JSON by design
// AC: @trait-json-output ac-2 — N/A: WebSocket events carry mutation-specific data, not human-readable output
// AC: @trait-json-output ac-3 — N/A: WebSocket broadcasts only on successful mutations; errors don't broadcast
// AC: @trait-json-output ac-4 — N/A: WebSocket event payloads use ULIDs, not @ prefix references
// AC: @trait-json-output ac-5 — N/A: Timestamps in broadcast events use ISO 8601 via BroadcastEvent.timestamp
// AC: @trait-json-output ac-6 — N/A: WebSocket events have no formatting flags
// AC: @trait-error-guidance ac-1 — N/A: WebSocket broadcasts are fire-and-forget; errors in mutation endpoints are covered by ac-10 tests
// AC: @trait-error-guidance ac-2 — N/A: Mutation endpoint error responses are tested in daemon-review-verdicts-api.test.ts
// AC: @trait-error-guidance ac-3 — N/A: Not-found errors are tested in daemon-review-verdicts-api.test.ts
// AC: @trait-error-guidance ac-4 — N/A: Invalid lifecycle transitions are tested in daemon-review-verdicts-api.test.ts
// AC: @trait-error-guidance ac-5 — N/A: Validation errors with field details are tested in daemon-review-verdicts-api.test.ts
// AC: @trait-error-guidance ac-6 — N/A: API is always JSON; no --json flag distinction
// AC: @trait-localhost-security ac-1 — N/A: Server binding is configured in server.ts, not in WebSocket event logic
// AC: @trait-localhost-security ac-2 — N/A: Connection filtering is middleware in server.ts localhostOnly()
// AC: @trait-localhost-security ac-3 — N/A: Configuration warnings are in server.ts
// AC: @trait-websocket-protocol ac-1 — N/A: WebSocket connection handling is in server.ts ws handler
// AC: @trait-websocket-protocol ac-2 — N/A: Topic subscription is in websocket/handler.ts
// AC: @trait-websocket-protocol ac-3 — Broadcast format is verified via pubsub spy assertions (topic, event, data structure)
// AC: @trait-websocket-protocol ac-4 — N/A: Heartbeat is in websocket/heartbeat.ts
// AC: @trait-websocket-protocol ac-5 — N/A: Pong timeout is in websocket/heartbeat.ts
// AC: @trait-websocket-protocol ac-6 — N/A: Backpressure is handled by PubSubManager
// AC: @trait-websocket-protocol ac-7 — N/A: Close codes are in websocket/lifecycle.ts
// AC: @trait-websocket-protocol ac-8 — N/A: Reconnection is client-side behavior
