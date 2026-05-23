/**
 * Integration tests for the entity-storage incompatibility 409 contract
 * across daemon API routes that touch plan, review, or resource data.
 *
 * Each test mounts a project with a manifest that the lenient route-entry
 * gate rejects and asserts that the routes return a structured 409 with
 * `entity_storage_incompatible` instead of escaping as 404 or 500.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 */

import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  setupInlineFixtures,
} from "./helpers.js";

const MISSING_FOLDER_DECLARATION_MANIFEST = `kynetic: "1.2"
project:
  name: Test Project
  version: "0.1.0"
  status: draft
task_storage:
  format: split
includes:
  - modules/test.yaml
`;

const EXPLICIT_NON_FOLDER_PLAN_STORAGE_MANIFEST = `kynetic: "1.1"
project:
  name: Test Project
  version: "0.1.0"
  status: draft
task_storage:
  format: split
plan_storage:
  format: monolithic
includes:
  - modules/test.yaml
`;

const EXPLICIT_NON_FOLDER_REVIEW_STORAGE_MANIFEST = `kynetic: "1.1"
project:
  name: Test Project
  version: "0.1.0"
  status: draft
task_storage:
  format: split
review_storage:
  format: monolithic
includes:
  - modules/test.yaml
`;

interface EntityStorageConflictBody {
  error: string;
  message?: string;
  suggestion?: string;
  code?: string;
  field?: string;
  cache_domain?: string;
  cache_domain_state?: string;
  domain?: string;
}

function assertIsEntityStorageConflict(body: unknown): EntityStorageConflictBody {
  expect(body).toBeTypeOf("object");
  const typed = body as EntityStorageConflictBody;
  expect(typed.error).toBe("entity_storage_incompatible");
  expect(typed.suggestion).toMatch(/kspec upgrade/i);
  return typed;
}

let tempDir: string;
let app: Elysia;

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-entity-storage-conflict-");
  initGitRepo(tempDir);
  ({ app } = createTestApp());
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

describe("Entity storage incompatibility — 1.2 without folder declaration", () => {
  beforeEach(() => {
    // 1.2 manifest WITHOUT plan_storage / review_storage declarations.
    // The lenient gate fires missing_*_folder_storage on these.
    setupInlineFixtures(tempDir, { manifest: MISSING_FOLDER_DECLARATION_MANIFEST });
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
  // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
  it("GET /api/plans returns 409 with missing_plan_folder_storage", async () => {
    const response = await request("/api/plans");
    expect(response.status).toBe(409);
    const body = await response.json();
    const typed = assertIsEntityStorageConflict(body);
    expect(typed.code).toBe("missing_plan_folder_storage");
    expect(typed.field).toBe("plan_storage.format");
    expect(typed.domain).toBe("plans");
    expect(typed.cache_domain).toBe("plans");
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
  // The plans /:ref route must not collapse a storage incompatibility into 404.
  it("GET /api/plans/:ref returns 409 (not 404) with structured guidance", async () => {
    const response = await request("/api/plans/@some-ref");
    expect(response.status).not.toBe(404);
    expect(response.status).toBe(409);
    const body = await response.json();
    const typed = assertIsEntityStorageConflict(body);
    expect(typed.error).not.toBe("not_found");
    expect(typed.code).toBe("missing_plan_folder_storage");
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
  it("GET /api/reviews returns 409 with missing_review_folder_storage", async () => {
    const response = await request("/api/reviews");
    expect(response.status).toBe(409);
    const body = await response.json();
    const typed = assertIsEntityStorageConflict(body);
    expect(typed.code).toBe("missing_review_folder_storage");
    expect(typed.field).toBe("review_storage.format");
    expect(typed.domain).toBe("reviews");
    expect(typed.cache_domain).toBe("reviews");
  });
});

describe("Entity storage incompatibility — explicit non-folder format on plans", () => {
  beforeEach(() => {
    // Project explicitly declares plan_storage.format = monolithic — broken
    // manifest regardless of kynetic version. Lenient gate fires.
    setupInlineFixtures(tempDir, { manifest: EXPLICIT_NON_FOLDER_PLAN_STORAGE_MANIFEST });
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
  // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
  it("GET /api/plans returns 409 with missing_plan_folder_storage", async () => {
    const response = await request("/api/plans");
    expect(response.status).toBe(409);
    const body = await response.json();
    const typed = assertIsEntityStorageConflict(body);
    expect(typed.code).toBe("missing_plan_folder_storage");
    expect(typed.message).toMatch(/monolithic|folder-backed/i);
  });
});

describe("Entity storage incompatibility — explicit non-folder format on reviews", () => {
  beforeEach(() => {
    setupInlineFixtures(tempDir, { manifest: EXPLICIT_NON_FOLDER_REVIEW_STORAGE_MANIFEST });
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
  it("GET /api/reviews returns 409 with missing_review_folder_storage", async () => {
    const response = await request("/api/reviews");
    expect(response.status).toBe(409);
    const body = await response.json();
    const typed = assertIsEntityStorageConflict(body);
    expect(typed.code).toBe("missing_review_folder_storage");
    expect(typed.message).toMatch(/monolithic|folder-backed/i);
  });
});

describe("Entity storage compatibility — legacy projects pass lenient gate", () => {
  beforeEach(() => {
    // Legacy 1.1 project with NO plan_storage / review_storage declarations.
    // Lenient gate passes; routes serve existing monolithic data.
    setupInlineFixtures(tempDir, {
      plans: `kynetic_plans: "1.0"\nplans: []\n`,
      reviews: `kynetic_reviews: "1.0"\nreviews: []\n`,
    });
  });

  it("GET /api/plans returns 200 on legacy 1.1 projects without storage_* declarations", async () => {
    const response = await request("/api/plans");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toBeTypeOf("object");
  });

  it("GET /api/reviews returns 200 on legacy 1.1 projects without storage_* declarations", async () => {
    const response = await request("/api/reviews");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toBeTypeOf("object");
  });
});
