/**
 * Tests for review verdict, check, and lifecycle API endpoints
 *
 * Spec: @review-records-daemon-api
 * Task: @task-review-api-verdicts
 *
 * Tests the POST /api/reviews/:id/verdicts, POST /api/reviews/:id/checks,
 * and PATCH /api/reviews/:id/lifecycle route handlers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { Elysia } from 'elysia';
import { createTempDir, cleanupTempDir, initGitRepo, testUlid } from './helpers/cli';
import { projectContextMiddleware } from '../dist/daemon/middleware/project-context.ts';
import { createReviewsRoutes } from '../dist/daemon/routes/reviews.ts';
import { PubSubManager } from '../dist/daemon/websocket/pubsub.ts';

// Test ULIDs
const REVIEW_DRAFT_ULID = testUlid('RVDR', 1);
const REVIEW_OPEN_ULID = testUlid('RVOP', 2);
const REVIEW_CLOSED_ULID = testUlid('RVCL', 3);
const REVIEW_ARCHIVED_ULID = testUlid('RVAR', 4);
const REVIEW_CODE_ULID = testUlid('RVCO', 5);
const TASK_ULID = testUlid('TASK', 6);

let tempDir: string;
let app: Elysia;
let pubsub: PubSubManager;

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
  // Create .kspec/ so projectContextMiddleware accepts the directory
  mkdirSync(path.join(tempDir, '.kspec'), { recursive: true });
  mkdirSync(path.join(tempDir, 'modules'), { recursive: true });

  // Manifest
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

  // Spec item
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

  // Tasks
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

  // Reviews — various lifecycle states
  writeFileSync(
    path.join(tempDir, 'project.reviews.yaml'),
    `kynetic_reviews: "1.0"
reviews:
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
      content_hash: "hash1"
    verdicts: []
    checks: []
    threads: []
    events: []
    related_refs: []
    created_at: "2026-01-01T00:00:00Z"
    updated_at: "2026-01-01T00:00:00Z"
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
  - _ulid: "${REVIEW_ARCHIVED_ULID}"
    slugs:
      - review-archived
    title: "Archived review"
    lifecycle_state: archived
    author: "@test"
    subject:
      type: plan
      ref: "@plan-test"
      shadow_commit: "abc123"
      content_hash: "hash4"
    verdicts: []
    checks: []
    threads: []
    events: []
    related_refs: []
    created_at: "2026-01-01T00:00:00Z"
    updated_at: "2026-01-01T00:00:00Z"
  - _ulid: "${REVIEW_CODE_ULID}"
    slugs:
      - review-code
    title: "Code review"
    lifecycle_state: open
    author: "@test"
    subject:
      type: code
      base_commit: "aaa111"
      head_commit: "bbb222"
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

describe('Review Verdicts API', () => {
  beforeEach(async () => {
    tempDir = await createTempDir('kspec-review-verdicts-');
    initGitRepo(tempDir);
    setupFixtures();

    pubsub = new PubSubManager();
    const { middleware } = projectContextMiddleware();
    app = new Elysia()
      .use(middleware)
      .use(createReviewsRoutes({ pubsub }));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @review-records-daemon-api ac-6
  it('should record a verdict and return recomputed disposition', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      decision: 'approve',
      reviewer: 'test@example.com',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_ulid).toBe(REVIEW_OPEN_ULID);
    expect(body.decision).toBe('approve');
    expect(body.reviewer).toBe('test@example.com');
    expect(body.disposition).toBeDefined();
    // approve verdict with no failing gates → approved
    expect(body.disposition).toBe('approved');
  });

  // AC: @review-records-daemon-api ac-6
  it('should record a comment verdict without auto-closing', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      decision: 'comment',
      reviewer: 'test@example.com',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.decision).toBe('comment');
    // Comment verdict does not auto-close
    expect(body.lifecycle_state).toBe('open');
    // Comment only → pending disposition
    expect(body.disposition).toBe('pending');
  });

  // AC: @review-records-daemon-api ac-6
  it('should auto-close on approve verdict', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      decision: 'approve',
      reviewer: 'test@example.com',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lifecycle_state).toBe('closed');
  });

  // AC: @review-records-daemon-api ac-6
  it('should auto-close on request_changes verdict', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      decision: 'request_changes',
      reviewer: 'test@example.com',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lifecycle_state).toBe('closed');
    expect(body.disposition).toBe('changes_requested');
  });

  // AC: @review-records-daemon-api ac-6
  it('should record verdict by slug reference', async () => {
    const response = await makeRequest('POST', '/api/reviews/review-open/verdicts', {
      decision: 'approve',
      reviewer: 'test@example.com',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_ulid).toBe(REVIEW_OPEN_ULID);
  });

  // AC: @review-records-daemon-api ac-10
  // AC: @schema-derived-type-definitions ac-1
  it('should return 422 for invalid decision', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      decision: 'invalid_decision',
      reviewer: 'test@example.com',
    });

    expect(response.status).toBe(422);
  });

  // AC: @review-records-daemon-api ac-10
  it('should return 400 for missing reviewer', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      decision: 'approve',
      reviewer: '',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('validation_error');
    expect(body.details[0].field).toBe('reviewer');
  });

  // AC: @review-records-daemon-api ac-10
  it('should return 404 for non-existent review', async () => {
    const response = await makeRequest('POST', '/api/reviews/nonexistent/verdicts', {
      decision: 'approve',
      reviewer: 'test@example.com',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('not_found');
    expect(body.suggestion).toBeDefined();
  });

  // AC: @review-records-daemon-api ac-10
  it('should return 400 for verdict on archived review', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_ARCHIVED_ULID}/verdicts`, {
      decision: 'approve',
      reviewer: 'test@example.com',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_state');
    expect(body.current_state).toBe('archived');
    expect(body.suggestion).toContain('terminal state');
  });

  // AC: @review-records-daemon-api ac-10
  it('should return 400 for comment verdict on archived review', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_ARCHIVED_ULID}/verdicts`, {
      decision: 'comment',
      reviewer: 'test@example.com',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_state');
  });
});

describe('Review Checks API', () => {
  beforeEach(async () => {
    tempDir = await createTempDir('kspec-review-checks-api-');
    initGitRepo(tempDir);
    setupFixtures();

    pubsub = new PubSubManager();
    const { middleware } = projectContextMiddleware();
    app = new Elysia()
      .use(middleware)
      .use(createReviewsRoutes({ pubsub }));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @review-records-daemon-api ac-7
  it('should record a passing check and return gate evaluation', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/checks`, {
      name: 'vitest',
      status: 'pass',
      runner: 'vitest',
      evidence: 'All 342 tests passed',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_ulid).toBe(REVIEW_OPEN_ULID);
    expect(body.check).toBeDefined();
    expect(body.check.name).toBe('vitest');
    expect(body.check.status).toBe('pass');
    expect(body.check.required).toBe(true);
    expect(body.gate_state).toBeDefined();
    expect(body.gate_state).toBe('passing');
    expect(body.gate_summary).toBeDefined();
  });

  // AC: @review-records-daemon-api ac-7
  it('should record a failing check and report failing gate state', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/checks`, {
      name: 'lint',
      status: 'fail',
      runner: 'eslint',
      evidence: '3 errors found',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.check.status).toBe('fail');
    expect(body.gate_state).toBe('failing');
  });

  // AC: @review-records-daemon-api ac-7
  it('should record a non-required (informational) check', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/checks`, {
      name: 'coverage',
      status: 'pass',
      required: false,
      evidence: '87% coverage',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.check.required).toBe(false);
    // Informational check doesn't affect gate state
    expect(body.gate_state).toBe('passing');
  });

  // AC: @review-records-daemon-api ac-7
  it('should record check by slug reference', async () => {
    const response = await makeRequest('POST', '/api/reviews/review-open/checks', {
      name: 'test-suite',
      status: 'pass',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_ulid).toBe(REVIEW_OPEN_ULID);
  });

  // AC: @review-records-daemon-api ac-7
  it('should derive applies_to_version from review subject', async () => {
    // Code review has code_compare version
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_CODE_ULID}/checks`, {
      name: 'build',
      status: 'pass',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.check.applies_to_version).toBeDefined();
    expect(body.check.applies_to_version.type).toBe('code_compare');
    expect(body.check.applies_to_version.base_commit).toBe('aaa111');
    expect(body.check.applies_to_version.head_commit).toBe('bbb222');
  });

  // AC: @review-records-daemon-api ac-10
  it('should return 422 for invalid check status', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/checks`, {
      name: 'test',
      status: 'invalid_status',
    });

    expect(response.status).toBe(422);
  });

  // AC: @review-records-daemon-api ac-10
  it('should return 400 for missing name', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_OPEN_ULID}/checks`, {
      name: '',
      status: 'pass',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('validation_error');
    expect(body.details[0].field).toBe('name');
  });

  // AC: @review-records-daemon-api ac-10
  it('should return 404 for non-existent review', async () => {
    const response = await makeRequest('POST', '/api/reviews/nonexistent/checks', {
      name: 'test',
      status: 'pass',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('not_found');
  });

  // AC: @review-records-daemon-api ac-10
  it('should return 400 for check on archived review', async () => {
    const response = await makeRequest('POST', `/api/reviews/${REVIEW_ARCHIVED_ULID}/checks`, {
      name: 'vitest',
      status: 'pass',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_state');
    expect(body.current_state).toBe('archived');
    expect(body.suggestion).toContain('terminal state');
  });
});

describe('Review Lifecycle API', () => {
  beforeEach(async () => {
    tempDir = await createTempDir('kspec-review-lifecycle-api-');
    initGitRepo(tempDir);
    setupFixtures();

    pubsub = new PubSubManager();
    const { middleware } = projectContextMiddleware();
    app = new Elysia()
      .use(middleware)
      .use(createReviewsRoutes({ pubsub }));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @review-records-daemon-api ac-8
  it('should transition draft → open', async () => {
    const response = await makeRequest('PATCH', `/api/reviews/${REVIEW_DRAFT_ULID}/lifecycle`, {
      target: 'open',
      actor: 'test@example.com',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_ulid).toBe(REVIEW_DRAFT_ULID);
    expect(body.lifecycle_state).toBe('open');
    expect(body.previous_state).toBe('draft');
  });

  // AC: @review-records-daemon-api ac-8
  it('should transition draft → closed', async () => {
    const response = await makeRequest('PATCH', `/api/reviews/${REVIEW_DRAFT_ULID}/lifecycle`, {
      target: 'closed',
      actor: 'test@example.com',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lifecycle_state).toBe('closed');
    expect(body.previous_state).toBe('draft');
  });

  // AC: @review-records-daemon-api ac-8
  it('should transition open → closed', async () => {
    const response = await makeRequest('PATCH', `/api/reviews/${REVIEW_OPEN_ULID}/lifecycle`, {
      target: 'closed',
      actor: 'test@example.com',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lifecycle_state).toBe('closed');
    expect(body.previous_state).toBe('open');
  });

  // AC: @review-records-daemon-api ac-8
  it('should transition closed → open (reopen)', async () => {
    const response = await makeRequest('PATCH', `/api/reviews/${REVIEW_CLOSED_ULID}/lifecycle`, {
      target: 'open',
      actor: 'test@example.com',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lifecycle_state).toBe('open');
    expect(body.previous_state).toBe('closed');
  });

  // AC: @review-records-daemon-api ac-8
  it('should transition closed → archived', async () => {
    const response = await makeRequest('PATCH', `/api/reviews/${REVIEW_CLOSED_ULID}/lifecycle`, {
      target: 'archived',
      actor: 'test@example.com',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lifecycle_state).toBe('archived');
    expect(body.previous_state).toBe('closed');
  });

  // AC: @review-records-daemon-api ac-8
  it('should transition by slug reference', async () => {
    const response = await makeRequest('PATCH', '/api/reviews/review-draft/lifecycle', {
      target: 'open',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_ulid).toBe(REVIEW_DRAFT_ULID);
  });

  // AC: @review-records-daemon-api ac-8, ac-10 - invalid transition returns 400
  it('should return 422 for invalid transition open → draft', async () => {
    const response = await makeRequest('PATCH', `/api/reviews/${REVIEW_OPEN_ULID}/lifecycle`, {
      target: 'draft',
    });

    // 'draft' is not in VALID_LIFECYCLE_TARGETS, so framework validation rejects the payload.
    expect(response.status).toBe(422);
  });

  // AC: @review-records-daemon-api ac-8, ac-10 - invalid transition returns 400
  it('should return 400 for invalid transition open → archived (skip closed)', async () => {
    const response = await makeRequest('PATCH', `/api/reviews/${REVIEW_OPEN_ULID}/lifecycle`, {
      target: 'archived',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_transition');
    expect(body.current_state).toBe('open');
    expect(body.valid_transitions).toContain('closed');
    expect(body.suggestion).toBeDefined();
  });

  // AC: @review-records-daemon-api ac-8, ac-10
  it('should return 400 for transitions from archived (terminal state)', async () => {
    const response = await makeRequest('PATCH', `/api/reviews/${REVIEW_ARCHIVED_ULID}/lifecycle`, {
      target: 'open',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_transition');
    expect(body.current_state).toBe('archived');
    expect(body.valid_transitions).toHaveLength(0);
    expect(body.suggestion).toContain('terminal state');
  });

  // AC: @review-records-daemon-api ac-10
  it('should return 400 for missing target', async () => {
    const response = await makeRequest('PATCH', `/api/reviews/${REVIEW_OPEN_ULID}/lifecycle`, {
      actor: 'test@example.com',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('validation_error');
    expect(body.details[0].field).toBe('target');
  });

  // AC: @review-records-daemon-api ac-10
  it('should return 422 for invalid target value', async () => {
    const response = await makeRequest('PATCH', `/api/reviews/${REVIEW_OPEN_ULID}/lifecycle`, {
      target: 'invalid_state',
    });

    expect(response.status).toBe(422);
  });

  // AC: @review-records-daemon-api ac-10
  it('should return 404 for non-existent review', async () => {
    const response = await makeRequest('PATCH', '/api/reviews/nonexistent/lifecycle', {
      target: 'open',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('not_found');
  });
});

// Trait AC annotations
// AC: @trait-json-output ac-1 — N/A: These are REST API endpoints, not CLI commands; they always return JSON
// AC: @trait-json-output ac-2 — N/A: API endpoints always return full data; no human-readable mode
// AC: @trait-json-output ac-3 — N/A: API errors are always JSON objects with error field (tested via ac-10)
// AC: @trait-json-output ac-4 — N/A: API endpoints don't use @ prefix references in output
// AC: @trait-json-output ac-5 — N/A: Timestamps use ISO 8601 from the review library functions
// AC: @trait-json-output ac-6 — N/A: API endpoints have no formatting flags
// AC: @trait-error-guidance ac-1 — N/A: API error responses include error description (covered by ac-10 tests)
// AC: @trait-error-guidance ac-2 — N/A: API error responses include suggestion field (covered by ac-10 tests)
// AC: @trait-error-guidance ac-3 — N/A: API 404s include suggestion to use kspec review list (covered by tests)
// AC: @trait-error-guidance ac-4 — N/A: Lifecycle transition errors show current state and valid transitions (covered by tests)
// AC: @trait-error-guidance ac-5 — N/A: Validation errors indicate which field failed (covered by details array in tests)
// AC: @trait-error-guidance ac-6 — N/A: API is always JSON; no --json flag distinction
// AC: @trait-localhost-security ac-1 — N/A: Server binding is configured in server.ts, not in route handlers
// AC: @trait-localhost-security ac-2 — N/A: Connection filtering is middleware in server.ts localhostOnly()
// AC: @trait-localhost-security ac-3 — N/A: Configuration warnings are in server.ts
// AC: @trait-websocket-protocol ac-1 — N/A: WebSocket connection handling is in server.ts ws handler
// AC: @trait-websocket-protocol ac-2 — N/A: Topic subscription is in websocket/handler.ts
// AC: @trait-websocket-protocol ac-3 — N/A: Broadcast format is handled by PubSubManager (route just calls pubsub.broadcast)
// AC: @trait-websocket-protocol ac-4 — N/A: Heartbeat is in websocket/heartbeat.ts
// AC: @trait-websocket-protocol ac-5 — N/A: Pong timeout is in websocket/heartbeat.ts
// AC: @trait-websocket-protocol ac-6 — N/A: Backpressure is handled by PubSubManager
// AC: @trait-websocket-protocol ac-7 — N/A: Close codes are in websocket/lifecycle.ts
// AC: @trait-websocket-protocol ac-8 — N/A: Reconnection is client-side behavior
