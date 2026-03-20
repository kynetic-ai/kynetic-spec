import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { Elysia } from 'elysia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir, initGitRepo, testUlid } from './helpers/cli.js';
import { projectContextMiddleware } from '../dist/daemon/middleware/project-context.ts';
import { createTasksRoutes } from '../dist/daemon/routes/tasks.ts';
import { createItemsRoutes } from '../dist/daemon/routes/items.ts';
import { createReviewsRoutes } from '../dist/daemon/routes/reviews.ts';
import { createTriageRoutes } from '../dist/daemon/routes/triage.ts';
import { createPlansRoutes } from '../dist/daemon/routes/plans.ts';
import { createSessionRoutes } from '../dist/daemon/routes/sessions.ts';
import { createValidationRoutes } from '../dist/daemon/routes/validation.ts';
import { createMetaRoutes } from '../dist/daemon/routes/meta.ts';
import { PubSubManager } from '../dist/daemon/websocket/pubsub.ts';

const REVIEW_OPEN_ULID = testUlid('RVOP', 1);
const TASK_ULID = testUlid('TASK', 2);
const SPEC_ULID = testUlid('SPEC', 3);

let tempDir: string;
let app: Elysia;

function makeRequest(urlPath: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${urlPath}`, {
    method: init.method ?? 'GET',
    headers: {
      Host: 'localhost',
      'X-Kspec-Dir': tempDir,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body,
  }));
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
  - _ulid: "${SPEC_ULID}"
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
    type: task
    automation: eligible
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
    threads: []
    events: []
    related_refs: []
    created_at: "2026-01-01T00:00:00Z"
    updated_at: "2026-01-01T00:00:00Z"
`,
  );

  writeFileSync(
    path.join(tempDir, 'project.plans.yaml'),
    `kynetic_plans: "1.0"
plans: []
`,
  );

  writeFileSync(
    path.join(tempDir, 'project.triage.yaml'),
    `kynetic_triage: "1.0"
records: []
`,
  );

  writeFileSync(
    path.join(tempDir, 'kynetic.meta.yaml'),
    `kynetic_meta: "1.0"
agents: []
observations: []
workflows: []
conventions: []
`,
  );

  execSync('git add -A && git commit -m "kspec project setup"', { cwd: tempDir, stdio: 'pipe' });
}

describe('Daemon API input validation', () => {
  beforeEach(async () => {
    tempDir = await createTempDir('kspec-daemon-api-input-validation-');
    initGitRepo(tempDir);
    setupFixtures();

    const pubsub = new PubSubManager();
    const { middleware } = projectContextMiddleware();
    app = new Elysia()
      .use(middleware)
      .use(createTasksRoutes({ pubsub }))
      .use(createItemsRoutes())
      .use(createReviewsRoutes({ pubsub }))
      .use(createTriageRoutes({ pubsub }))
      .use(createPlansRoutes())
      .use(createSessionRoutes())
      .use(createValidationRoutes())
      .use(createMetaRoutes());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @api-input-type-safety ac-1
  // AC: @api-input-type-safety ac-4
  // AC: @trait-type-safe-input ac-1
  // AC: @trait-type-safe-input ac-2
  // AC: @trait-type-safe-input ac-3
  // AC: @trait-api-endpoint ac-3
  it('rejects invalid mutation enum values before the review handler executes', async () => {
    const before = readFileSync(path.join(tempDir, 'project.reviews.yaml'), 'utf8');

    const response = await makeRequest(`/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      method: 'POST',
      body: JSON.stringify({
        decision: 'invalid_decision',
        reviewer: 'reviewer@example.com',
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('validation_error');
    expect(body.details[0].field).toBe('decision');
    expect(body.details[0].message).toContain('approve');
    expect(body.details[0].message).toContain('request_changes');

    const after = readFileSync(path.join(tempDir, 'project.reviews.yaml'), 'utf8');
    expect(after).toBe(before);
  });

  // AC: @api-input-type-safety ac-2
  it('allows valid mutation enum values to execute normally', async () => {
    const response = await makeRequest(`/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      method: 'POST',
      body: JSON.stringify({
        decision: 'approve',
        reviewer: 'reviewer@example.com',
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.decision).toBe('approve');
    expect(body.reviewer).toBe('reviewer@example.com');
  });

  // AC: @api-input-type-safety ac-3
  it('rejects invalid enum query filters across daemon list and search endpoints', async () => {
    const cases = [
      ['/api/tasks?status=invalid_status', 'pending'],
      ['/api/items?type=invalid_type', 'feature'],
      ['/api/reviews?status=invalid_status', 'open'],
      ['/api/triage?status=invalid_status', 'triaged'],
      ['/api/plans?status=invalid_status', 'draft'],
      ['/api/sessions?status=invalid_status', 'active'],
      ['/api/search?q=test&type=invalid_type', 'feature'],
      ['/api/meta/observations?type=invalid_type', 'friction'],
    ] as const;

    for (const [url, expectedValue] of cases) {
      const response = await makeRequest(url);
      expect(response.status, url).toBe(400);
      const body = await response.json();
      expect(body.error, url).toBe('validation_error');
      expect(body.details[0].message, url).toContain(expectedValue);
    }
  });

  // AC: @api-input-type-safety ac-4
  it('derives tightened daemon enum schemas from canonical schema options', () => {
    const expectations = [
      ['packages/daemon/src/routes/tasks.ts', 'TaskStatusSchema.options'],
      ['packages/daemon/src/routes/tasks.ts', 'AutomationStatusSchema.options'],
      ['packages/daemon/src/routes/items.ts', 'ItemTypeSchema.options'],
      ['packages/daemon/src/routes/reviews.ts', 'ReviewVerdictDecisionSchema.options'],
      ['packages/daemon/src/routes/triage.ts', 'TriageActionSchema.options'],
      ['packages/daemon/src/routes/plans.ts', 'PlanStatusSchema.options'],
      ['packages/daemon/src/routes/sessions.ts', 'SessionStatusSchema.options'],
      ['packages/daemon/src/routes/validation.ts', 'TaskStatusSchema.options'],
    ] as const;

    for (const [relativePath, snippet] of expectations) {
      const source = readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      expect(source, relativePath).toContain(snippet);
    }
  });
});
