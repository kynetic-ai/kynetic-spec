/**
 * Integration tests for the task-storage incompatibility 409 contract across
 * the daemon API surface.
 *
 * Each test mounts a project on a legacy (kynetic 1.0, monolithic) manifest
 * that resolveTaskDataManager() rejects deterministically, then asserts that
 * routes which need task data return a structured 409 with the
 * task_storage_incompatible discriminator instead of:
 *   - collapsing into 404 not_found (the pre-fix behavior for /api/tasks/:ref
 *     and mutation routes), or
 *   - escaping as an unhandled 500 (the pre-fix behavior for GET /api/tasks,
 *     /api/aggregation/tasks/summary, /api/refs, etc.).
 *
 * AC: @api-contract ac-task-storage-incompatibility-conflict-status
 * AC: @api-contract ac-task-storage-incompatibility-error-code
 * AC: @api-contract ac-task-storage-incompatibility-guidance
 * AC: @api-contract ac-task-storage-incompatibility-not-not-found
 * AC: @api-contract ac-task-storage-incompatibility-field-context
 * AC: @api-contract ac-task-storage-incompatibility-cache-domain-context
 * AC: @api-contract ac-task-storage-incompatibility-cache-state-context
 */

import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  LEGACY_INLINE_MANIFEST,
  makeRequest,
  requestJson,
  setupInlineFixtures,
  testUlid,
} from "./helpers.js";

const TASK_ULID = testUlid("TASK", 1);
const SPEC_ULID = testUlid("SPEC", 2);

let tempDir: string;
let app: Elysia;

function setupLegacyFixtures(dir: string) {
  setupInlineFixtures(dir, {
    manifest: LEGACY_INLINE_MANIFEST,
    modules: {
      "test.yaml": `features:
  - _ulid: "${SPEC_ULID}"
    slugs:
      - test-feature
    title: "Test Feature"
    type: feature
    description: "A test feature"
    created: "2026-01-01T00:00:00Z"
`,
    },
    tasksFile: `tasks:
  - _ulid: "${TASK_ULID}"
    slugs:
      - task-test
    title: "Test Task"
    description: "A test task"
    status: pending
    type: task
    spec_ref: "@test-feature"
    created_at: "2026-01-01T00:00:00Z"
`,
  });
}

interface TaskStorageIncompatibleBody {
  error: string;
  message?: string;
  suggestion?: string;
  code?: string;
  field?: string;
  cache_domain?: string;
  cache_domain_state?: string;
}

function assertIsTaskStorageConflict(body: unknown): TaskStorageIncompatibleBody {
  expect(body).toBeTypeOf("object");
  const typed = body as TaskStorageIncompatibleBody;
  expect(typed.error).toBe("task_storage_incompatible");
  expect(typed.message).toMatch(/monolithic task storage format has been removed/i);
  expect(typed.suggestion).toMatch(/kspec task migrate/i);
  expect(typed.code).toBe("legacy_task_storage_removed");
  expect(typed.field).toBe("task_storage.format");
  expect(typed.cache_domain).toBe("tasks");
  return typed;
}

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-task-storage-conflict-");
  initGitRepo(tempDir);
  setupLegacyFixtures(tempDir);
  ({ app } = createTestApp());
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

describe("Task storage incompatibility — tasks routes", () => {
  // AC: @api-contract ac-task-storage-incompatibility-conflict-status
  // AC: @api-contract ac-task-storage-incompatibility-error-code
  // AC: @api-contract ac-task-storage-incompatibility-guidance
  // AC: @api-contract ac-task-storage-incompatibility-field-context
  it("GET /api/tasks returns 409 with structured migration guidance", async () => {
    const response = await request("/api/tasks");
    expect(response.status).toBe(409);
    const body = await response.json();
    assertIsTaskStorageConflict(body);
  });

  // AC: @api-contract ac-task-storage-incompatibility-not-not-found
  // AC: @api-contract ac-task-storage-incompatibility-conflict-status
  it("GET /api/tasks/:ref is 409 (not 404) with structured guidance", async () => {
    const response = await request("/api/tasks/@task-test");
    expect(response.status).not.toBe(404);
    expect(response.status).toBe(409);
    const body = await response.json();
    const typed = assertIsTaskStorageConflict(body);
    // Must not echo a not_found error code even if the underlying load failed.
    expect(typed.error).not.toBe("not_found");
  });

  // AC: @api-contract ac-task-storage-incompatibility-not-not-found
  // AC: @api-contract ac-task-storage-incompatibility-conflict-status
  it("POST /api/tasks/:ref/start surfaces structured 409 instead of 404", async () => {
    const response = await requestJson(app, tempDir, "POST", "/api/tasks/@task-test/start");
    expect(response.status).toBe(409);
    const body = await response.json();
    const typed = assertIsTaskStorageConflict(body);
    expect(typed.error).not.toBe("not_found");
  });

  // AC: @api-contract ac-task-storage-incompatibility-not-not-found
  it("POST /api/tasks/:ref/note surfaces structured 409 instead of 404", async () => {
    const response = await requestJson(app, tempDir, "POST", "/api/tasks/@task-test/note", {
      content: "hello",
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    assertIsTaskStorageConflict(body);
  });
});

describe("Task storage incompatibility — non-tasks.ts routes", () => {
  // AC: @api-contract ac-task-storage-incompatibility-conflict-status
  // AC: @api-contract ac-task-storage-incompatibility-error-code
  // AC: @api-contract ac-task-storage-incompatibility-guidance
  // AC: @api-contract ac-task-storage-incompatibility-cache-domain-context
  it("GET /api/aggregation/tasks/summary returns 409 with structured guidance", async () => {
    const response = await request("/api/aggregation/tasks/summary");
    expect(response.status).toBe(409);
    const body = await response.json();
    assertIsTaskStorageConflict(body);
  });

  // AC: @api-contract ac-task-storage-incompatibility-conflict-status
  // AC: @api-contract ac-task-storage-incompatibility-error-code
  it("GET /api/aggregation/validation returns 409 with structured guidance", async () => {
    const response = await request("/api/aggregation/validation");
    expect(response.status).toBe(409);
    const body = await response.json();
    assertIsTaskStorageConflict(body);
  });

  // AC: @api-contract ac-task-storage-incompatibility-conflict-status
  // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
  // /api/plans now installs the plan-storage gate at the route entry, so a
  // legacy project surfaces `entity_storage_incompatible` (the plan-storage
  // contract) BEFORE the handler attempts to load task data for progress
  // computation. The 409 + structured-guidance contract is still satisfied,
  // just under the plan-storage discriminator instead of task-storage.
  it("GET /api/plans returns 409 with structured guidance (entity_storage discriminator)", async () => {
    const response = await request("/api/plans");
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; suggestion?: string };
    expect(body.error).toBe("entity_storage_incompatible");
    expect(body.suggestion).toMatch(/kspec upgrade/i);
  });

  // AC: @api-contract ac-task-storage-incompatibility-conflict-status
  it("GET /api/alignment returns 409 with structured guidance", async () => {
    const response = await request("/api/alignment");
    expect(response.status).toBe(409);
    const body = await response.json();
    assertIsTaskStorageConflict(body);
  });

  // AC: @api-contract ac-task-storage-incompatibility-conflict-status
  it("GET /api/items/:ref/tasks returns 409 with structured guidance", async () => {
    const response = await request(`/api/items/@test-feature/tasks`);
    expect(response.status).toBe(409);
    const body = await response.json();
    assertIsTaskStorageConflict(body);
  });
});

describe("Task storage incompatibility — context fields", () => {
  // AC: @api-contract ac-task-storage-incompatibility-cache-domain-context
  // AC: @api-contract ac-task-storage-incompatibility-cache-state-context
  it("includes cache_domain context on the structured response", async () => {
    const response = await request("/api/tasks");
    expect(response.status).toBe(409);
    const body = await response.json();
    const typed = assertIsTaskStorageConflict(body);
    expect(typed.cache_domain).toBe("tasks");
  });

  // AC: @api-contract ac-task-storage-incompatibility-field-context
  it("identifies the affected configuration field", async () => {
    const response = await request("/api/tasks");
    const body = await response.json();
    const typed = assertIsTaskStorageConflict(body);
    expect(typed.field).toBe("task_storage.format");
  });
});
