/**
 * Tests for review verdict, check, and lifecycle API endpoints
 *
 * Spec: @review-records-daemon-api
 * Task: @task-review-api-verdicts
 *
 * Tests the POST /api/reviews/:id/verdicts, POST /api/reviews/:id/checks,
 * and PATCH /api/reviews/:id/lifecycle route handlers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Elysia } from "elysia";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  requestJson,
  setupInlineFixtures,
  testUlid,
} from "./daemon-api/helpers.js";
import type {
  RouteEntityCache,
  EntityCacheAccessor,
} from "../dist/daemon/routes/entity-cache-types.js";
import {
  initContext,
  resolveTaskDataManager,
  type LoadedTask,
  type TaskSummary,
} from "../dist/parser/index.js";

// AC: @daemon-test-mode-boundaries ac-in-process-route-tests-no-child-process
// AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run

// Test ULIDs
const REVIEW_DRAFT_ULID = testUlid("RVDR", 1);
const REVIEW_OPEN_ULID = testUlid("RVOP", 2);
const REVIEW_CLOSED_ULID = testUlid("RVCL", 3);
const REVIEW_ARCHIVED_ULID = testUlid("RVAR", 4);
const REVIEW_CODE_ULID = testUlid("RVCO", 5);
const TASK_ULID = testUlid("TASK", 6);

let tempDir: string;
let app: Elysia;

// Pin the configured human identity so the reviewer/actor values these tests
// send (`test@example.com`) resolve in-pool through the shared actor-write
// utility rather than being rejected as out-of-pool free-form authors.
// AC: @actor-identity-resolution ac-6 ac-7 — writes resolve against the configured pool
let savedVerdictAuthor: string | undefined;
beforeEach(() => {
  savedVerdictAuthor = process.env.KSPEC_AUTHOR;
  process.env.KSPEC_AUTHOR = "test@example.com";
});
afterEach(() => {
  if (savedVerdictAuthor === undefined) {
    delete process.env.KSPEC_AUTHOR;
  } else {
    process.env.KSPEC_AUTHOR = savedVerdictAuthor;
  }
});

// AC: @entity-folder-migration-and-compatibility-1 ac-new-projects-declare-folder-storage
// AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
//   — kynetic 1.2 fixture with folder-backed plan/review/resource storage so
//   the daemon's requireReviewFolderStorage gate passes. setupInlineFixtures
//   auto-materialises matching `<dir>/reviews/<ulid>/review.yaml` shells so
//   the partial-layout detector treats the layout as consistent.
const SPLIT_MANIFEST = `kynetic: "1.2"
task_storage:
  format: split
plan_storage:
  format: folder
review_storage:
  format: folder
resource_storage:
  format: entity_scoped
project:
  name: Test Project
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
`;

const SPEC_MODULE = (specUlid: string) => `features:
  - _ulid: "${specUlid}"
    slugs:
      - test-feature
    title: "Test Feature"
    type: feature
    description: "A test feature"
    created: "2026-01-01T00:00:00Z"
`;

function reviewsFixtureYaml(): string {
  return `kynetic_reviews: "1.0"
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
`;
}

function setupReviewFixtures(dir: string) {
  setupInlineFixtures(dir, {
    manifest: SPLIT_MANIFEST,
    modules: { "test.yaml": SPEC_MODULE(testUlid("SPEC", 1)) },
    splitTasks: [
      {
        _ulid: TASK_ULID,
        slugs: ["task-test"],
        title: "Test Task",
        description: "A test task",
        status: "pending_review",
        spec_ref: "@test-feature",
        review_ref: "@review-open",
        created_at: "2026-01-01T00:00:00Z",
        notes: [],
      },
    ],
    reviews: reviewsFixtureYaml(),
  });
}

function request(method: string, urlPath: string, body?: unknown) {
  return requestJson(app, tempDir, method, urlPath, body);
}

describe("Review Verdicts API", () => {
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-review-verdicts-");
    initGitRepo(tempDir);
    setupReviewFixtures(tempDir);
    ({ app } = createTestApp());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @review-records-daemon-api ac-6
  it("should record a verdict and return recomputed disposition", async () => {
    const response = await request("POST", `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      decision: "approve",
      reviewer: "test@example.com",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_ulid).toBe(REVIEW_OPEN_ULID);
    expect(body.decision).toBe("approve");
    expect(body.reviewer).toBe("test@example.com");
    expect(body.disposition).toBeDefined();
    // approve verdict with no failing gates → approved
    expect(body.disposition).toBe("approved");
  });

  // AC: @review-records-daemon-api ac-6
  it("should record a comment verdict without auto-closing", async () => {
    const response = await request("POST", `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      decision: "comment",
      reviewer: "test@example.com",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.decision).toBe("comment");
    // Comment verdict does not auto-close
    expect(body.lifecycle_state).toBe("open");
    // Comment only → pending disposition
    expect(body.disposition).toBe("pending");
  });

  // AC: @review-records-daemon-api ac-6
  it("should auto-close on approve verdict", async () => {
    const response = await request("POST", `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      decision: "approve",
      reviewer: "test@example.com",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lifecycle_state).toBe("closed");
  });

  // AC: @review-records-daemon-api ac-6
  it("should auto-close on request_changes verdict", async () => {
    const response = await request("POST", `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      decision: "request_changes",
      reviewer: "test@example.com",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lifecycle_state).toBe("closed");
    expect(body.disposition).toBe("changes_requested");
  });

  // AC: @review-records-daemon-api ac-6
  it("should record verdict by slug reference", async () => {
    const response = await request("POST", "/api/reviews/review-open/verdicts", {
      decision: "approve",
      reviewer: "test@example.com",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_ulid).toBe(REVIEW_OPEN_ULID);
  });

  // AC: @review-records-daemon-api ac-10
  // AC: @schema-derived-type-definitions ac-1
  it("should return 400 at the API boundary for invalid decision", async () => {
    const response = await request("POST", `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      decision: "invalid_decision",
      reviewer: "test@example.com",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(body.details[0].field).toBe("decision");
    expect(body.details[0].message).toContain("approve");
  });

  // AC: @review-records-daemon-api ac-10
  it("should return 400 for missing reviewer", async () => {
    const response = await request("POST", `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`, {
      decision: "approve",
      reviewer: "",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(body.details[0].field).toBe("reviewer");
  });

  // AC: @review-records-daemon-api ac-10
  it("should return 404 for non-existent review", async () => {
    const response = await request("POST", "/api/reviews/nonexistent/verdicts", {
      decision: "approve",
      reviewer: "test@example.com",
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("not_found");
    expect(body.suggestion).toBeDefined();
  });

  // AC: @review-records-daemon-api ac-10
  it("should return 400 for verdict on archived review", async () => {
    const response = await request("POST", `/api/reviews/${REVIEW_ARCHIVED_ULID}/verdicts`, {
      decision: "approve",
      reviewer: "test@example.com",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_state");
    expect(body.current_state).toBe("archived");
    expect(body.suggestion).toContain("terminal state");
  });

  // AC: @review-records-daemon-api ac-10
  it("should return 400 for comment verdict on archived review", async () => {
    const response = await request("POST", `/api/reviews/${REVIEW_ARCHIVED_ULID}/verdicts`, {
      decision: "comment",
      reviewer: "test@example.com",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_state");
  });
});

describe("Review Checks API", () => {
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-review-checks-api-");
    initGitRepo(tempDir);
    setupReviewFixtures(tempDir);
    ({ app } = createTestApp());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @review-records-daemon-api ac-7
  it("should record a passing check and return gate evaluation", async () => {
    const response = await request("POST", `/api/reviews/${REVIEW_OPEN_ULID}/checks`, {
      name: "vitest",
      status: "pass",
      runner: "vitest",
      evidence: "All 342 tests passed",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_ulid).toBe(REVIEW_OPEN_ULID);
    expect(body.check).toBeDefined();
    expect(body.check.name).toBe("vitest");
    expect(body.check.status).toBe("pass");
    expect(body.check.required).toBe(true);
    expect(body.gate_state).toBeDefined();
    expect(body.gate_state).toBe("passing");
    expect(body.gate_summary).toBeDefined();
  });

  // AC: @review-records-daemon-api ac-7
  it("should record a failing check and report failing gate state", async () => {
    const response = await request("POST", `/api/reviews/${REVIEW_OPEN_ULID}/checks`, {
      name: "lint",
      status: "fail",
      runner: "eslint",
      evidence: "3 errors found",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.check.status).toBe("fail");
    expect(body.gate_state).toBe("failing");
  });

  // AC: @review-records-daemon-api ac-7
  it("should record a non-required (informational) check", async () => {
    const response = await request("POST", `/api/reviews/${REVIEW_OPEN_ULID}/checks`, {
      name: "coverage",
      status: "pass",
      required: false,
      evidence: "87% coverage",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.check.required).toBe(false);
    // Informational check doesn't affect gate state
    expect(body.gate_state).toBe("passing");
  });

  // AC: @review-records-daemon-api ac-7
  it("should record check by slug reference", async () => {
    const response = await request("POST", "/api/reviews/review-open/checks", {
      name: "test-suite",
      status: "pass",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_ulid).toBe(REVIEW_OPEN_ULID);
  });

  // AC: @review-records-daemon-api ac-7
  it("should derive applies_to_version from review subject", async () => {
    // Code review has code_compare version
    const response = await request("POST", `/api/reviews/${REVIEW_CODE_ULID}/checks`, {
      name: "build",
      status: "pass",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.check.applies_to_version).toBeDefined();
    expect(body.check.applies_to_version.type).toBe("code_compare");
    expect(body.check.applies_to_version.base_commit).toBe("aaa111");
    expect(body.check.applies_to_version.head_commit).toBe("bbb222");
  });

  // AC: @review-records-daemon-api ac-10
  it("should return 400 at the API boundary for invalid check status", async () => {
    const response = await request("POST", `/api/reviews/${REVIEW_OPEN_ULID}/checks`, {
      name: "test",
      status: "invalid_status",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(body.details[0].field).toBe("status");
    expect(body.details[0].message).toContain("pass");
  });

  // AC: @review-records-daemon-api ac-10
  it("should return 400 for missing name", async () => {
    const response = await request("POST", `/api/reviews/${REVIEW_OPEN_ULID}/checks`, {
      name: "",
      status: "pass",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(body.details[0].field).toBe("name");
  });

  // AC: @review-records-daemon-api ac-10
  it("should return 404 for non-existent review", async () => {
    const response = await request("POST", "/api/reviews/nonexistent/checks", {
      name: "test",
      status: "pass",
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("not_found");
  });

  // AC: @review-records-daemon-api ac-10
  it("should return 400 for check on archived review", async () => {
    const response = await request("POST", `/api/reviews/${REVIEW_ARCHIVED_ULID}/checks`, {
      name: "vitest",
      status: "pass",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_state");
    expect(body.current_state).toBe("archived");
    expect(body.suggestion).toContain("terminal state");
  });
});

describe("Review Lifecycle API", () => {
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-review-lifecycle-api-");
    initGitRepo(tempDir);
    setupReviewFixtures(tempDir);
    ({ app } = createTestApp());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @review-records-daemon-api ac-8
  it("should transition draft → open", async () => {
    const response = await request("PATCH", `/api/reviews/${REVIEW_DRAFT_ULID}/lifecycle`, {
      target: "open",
      actor: "test@example.com",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_ulid).toBe(REVIEW_DRAFT_ULID);
    expect(body.lifecycle_state).toBe("open");
    expect(body.previous_state).toBe("draft");
  });

  // AC: @review-records-daemon-api ac-8
  it("should transition draft → closed", async () => {
    const response = await request("PATCH", `/api/reviews/${REVIEW_DRAFT_ULID}/lifecycle`, {
      target: "closed",
      actor: "test@example.com",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lifecycle_state).toBe("closed");
    expect(body.previous_state).toBe("draft");
  });

  // AC: @review-records-daemon-api ac-8
  it("should transition open → closed", async () => {
    const response = await request("PATCH", `/api/reviews/${REVIEW_OPEN_ULID}/lifecycle`, {
      target: "closed",
      actor: "test@example.com",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lifecycle_state).toBe("closed");
    expect(body.previous_state).toBe("open");
  });

  // AC: @review-records-daemon-api ac-8
  it("should transition closed → open (reopen)", async () => {
    const response = await request("PATCH", `/api/reviews/${REVIEW_CLOSED_ULID}/lifecycle`, {
      target: "open",
      actor: "test@example.com",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lifecycle_state).toBe("open");
    expect(body.previous_state).toBe("closed");
  });

  // AC: @review-records-daemon-api ac-8
  it("should transition closed → archived", async () => {
    const response = await request("PATCH", `/api/reviews/${REVIEW_CLOSED_ULID}/lifecycle`, {
      target: "archived",
      actor: "test@example.com",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lifecycle_state).toBe("archived");
    expect(body.previous_state).toBe("closed");
  });

  // AC: @review-records-daemon-api ac-8
  it("should transition by slug reference", async () => {
    const response = await request("PATCH", "/api/reviews/review-draft/lifecycle", {
      target: "open",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.review_ulid).toBe(REVIEW_DRAFT_ULID);
  });

  // AC: @review-records-daemon-api ac-8, ac-10 - invalid transition returns 400
  it("should return 400 at the API boundary for invalid transition target open → draft", async () => {
    const response = await request("PATCH", `/api/reviews/${REVIEW_OPEN_ULID}/lifecycle`, {
      target: "draft",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(body.details[0].field).toBe("target");
    expect(body.details[0].message).toContain("open");
  });

  // AC: @review-records-daemon-api ac-8, ac-10 - invalid transition returns 400
  it("should return 400 for invalid transition open → archived (skip closed)", async () => {
    const response = await request("PATCH", `/api/reviews/${REVIEW_OPEN_ULID}/lifecycle`, {
      target: "archived",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_transition");
    expect(body.current_state).toBe("open");
    expect(body.valid_transitions).toContain("closed");
    expect(body.suggestion).toBeDefined();
  });

  // AC: @review-records-daemon-api ac-8, ac-10
  it("should return 400 for transitions from archived (terminal state)", async () => {
    const response = await request("PATCH", `/api/reviews/${REVIEW_ARCHIVED_ULID}/lifecycle`, {
      target: "open",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_transition");
    expect(body.current_state).toBe("archived");
    expect(body.valid_transitions).toHaveLength(0);
    expect(body.suggestion).toContain("terminal state");
  });

  // AC: @review-records-daemon-api ac-10
  it("should return 400 for missing target", async () => {
    const response = await request("PATCH", `/api/reviews/${REVIEW_OPEN_ULID}/lifecycle`, {
      actor: "test@example.com",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(body.details[0].field).toBe("target");
  });

  // AC: @review-records-daemon-api ac-10
  it("should return 400 at the API boundary for invalid target value", async () => {
    const response = await request("PATCH", `/api/reviews/${REVIEW_OPEN_ULID}/lifecycle`, {
      target: "invalid_state",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(body.details[0].field).toBe("target");
    expect(body.details[0].message).toContain("closed");
  });

  // AC: @review-records-daemon-api ac-10
  it("should return 404 for non-existent review", async () => {
    const response = await request("PATCH", "/api/reviews/nonexistent/lifecycle", {
      target: "open",
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("not_found");
  });
});

// Task: @01KPQ7RDHXBRGDZSDFF0XG13RT
// Integration test: verify that after a review verdict transitions a task,
// an immediate task read through the same cache-backed surface sees the new state.
describe("Review Verdict Task Consistency", () => {
  // Dedicated ULIDs for this describe block to avoid collisions
  const CONSIST_REVIEW_ULID = testUlid("CVRD", 1);
  const CONSIST_TASK_ULID = testUlid("CVTK", 2);

  let tempDir: string;
  let app: Elysia;

  /**
   * Build a mock RouteEntityCache whose writeThrough("tasks", { ulid })
   * reloads the specified task from disk and updates the in-memory tiers —
   * matching the real ProjectEntityCache behavior that makes subsequent
   * reads immediately consistent.
   */
  function createConsistencyCache(
    initialTaskIndex: TaskSummary[],
    initialTaskDetails: Map<string, LoadedTask>,
  ): RouteEntityCache {
    const taskIndex = [...initialTaskIndex];
    const taskDetails = new Map(initialTaskDetails);

    return {
      getDomainState: (domain: string) =>
        domain === "tasks" || domain === "reviews" ? "ready" : "unloaded",
      getTaskIndex: () => taskIndex,
      getTaskDetail: (ulid: string) => taskDetails.get(ulid) ?? null,
      getTaskHistory: () => null,
      setTaskDetail: (ulid, task) => taskDetails.set(ulid, task as LoadedTask),
      getAllTaskDetails: () => Array.from(taskDetails.values()),
      getItemIndex: () => null,
      getItemDetail: () => null,
      setItemDetail: () => {},
      getAllItemDetails: () => null,
      getSessionIndex: () => null,
      getSessionLiveEventCount: () => undefined,
      getSessionDetail: () => null,
      setSessionDetail: () => {},
      getPlansIndex: () => null,
      getPlanDetail: () => null,
      setPlanDetail: () => {},
      getInboxIndex: () => null,
      getTriageIndex: () => null,
      getTriageDetail: () => null,
      setTriageDetail: () => {},
      getReviewsIndex: () => null,
      getReviewDetail: () => null,
      setReviewDetail: () => {},
      getMetaIndex: () => null,
      getMetaDetail: () => null,
      setMetaDetail: () => {},
      getShadowInfo: () => null,
      getProjectConfig: () => null,
      getSessionContext: () => null,
      writeThrough: async (domain: string, hint?: { ulid?: string }) => {
        if (domain === "tasks" && hint?.ulid) {
          // Reload the task from disk — mirrors real ProjectEntityCache behavior
          const ctx = await initContext(tempDir, { syncMode: "skip" });
          const loaded = await resolveTaskDataManager(ctx).getTask(ctx, hint.ulid);
          // Update detail tier
          taskDetails.set(loaded._ulid, loaded);
          // Update index tier: rebuild summary from loaded task
          const existingIdx = taskIndex.findIndex((t) => t._ulid === loaded._ulid);
          const summary: TaskSummary = {
            _ulid: loaded._ulid,
            slugs: loaded.slugs,
            title: loaded.title,
            type: (loaded.type as TaskSummary["type"]) || "task",
            status: loaded.status,
            priority: loaded.priority,
            spec_ref: loaded.spec_ref,
            depends_on: loaded.depends_on,
            blocked_by: loaded.blocked_by || [],
            tags: loaded.tags,
            automation: loaded.automation,
            review_ref: loaded.review_ref ?? undefined,
            session_id: loaded.session_id,
            plan_ref: loaded.plan_ref,
            notes_count: loaded.notes?.length || 0,
            todos_count: loaded.todos?.length || 0,
            created_at: loaded.created_at,
            started_at: loaded.started_at,
            completed_at: loaded.completed_at,
            cancelled_at: loaded.cancelled_at,
          };
          if (existingIdx >= 0) {
            taskIndex[existingIdx] = summary;
          } else {
            taskIndex.push(summary);
          }
        }
        // For other domains, no-op (we only need tasks consistency for this test)
      },
      markWriteThrough: () => {},
      getCacheDiagnostics: () => ({
        projectPath: tempDir,
        domains: {},
      }),
    } as RouteEntityCache;
  }

  function setupConsistencyFixtures() {
    const consistSpecUlid = testUlid("CVSP", 1);
    // AC: @entity-folder-migration-and-compatibility-1 ac-new-projects-declare-folder-storage
    //   — folder-backed manifest so the daemon review route gate passes.
    setupInlineFixtures(tempDir, {
      manifest: `kynetic: "1.2"
task_storage:
  format: split
plan_storage:
  format: folder
review_storage:
  format: folder
resource_storage:
  format: entity_scoped
project:
  name: Consistency Test
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
`,
      modules: {
        "test.yaml": `features:
  - _ulid: "${consistSpecUlid}"
    slugs:
      - consist-feature
    title: "Consistency Feature"
    type: feature
    description: "Test feature for consistency"
    created: "2026-01-01T00:00:00Z"
`,
      },
      splitTasks: [
        {
          _ulid: CONSIST_TASK_ULID,
          slugs: ["consist-task"],
          title: "Consistency Test Task",
          description: "Task for testing verdict-then-read consistency",
          status: "pending_review",
          priority: 2,
          spec_ref: "@consist-feature",
          review_ref: `@${CONSIST_REVIEW_ULID}`,
          depends_on: [],
          blocked_by: [],
          tags: [],
          notes: [],
          todos: [],
          created_at: "2026-01-01T00:00:00Z",
          started_at: "2026-01-01T00:00:00Z",
        },
      ],
      reviews: `kynetic_reviews: "1.0"
reviews:
  - _ulid: "${CONSIST_REVIEW_ULID}"
    slugs:
      - consist-review
    title: "Consistency test review"
    lifecycle_state: open
    author: "@test"
    subject:
      type: task
      ref: "@consist-task"
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
    });
  }

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-verdict-consistency-");
    initGitRepo(tempDir);
    setupConsistencyFixtures();

    // Seed the cache with the task in pending_review state
    const initialSummary: TaskSummary = {
      _ulid: CONSIST_TASK_ULID,
      slugs: ["consist-task"],
      title: "Consistency Test Task",
      type: "task",
      status: "pending_review",
      priority: 2,
      spec_ref: "@consist-feature",
      depends_on: [],
      blocked_by: [],
      tags: [],
      notes_count: 0,
      todos_count: 0,
      created_at: "2026-01-01T00:00:00Z",
      started_at: "2026-01-01T00:00:00Z",
    };

    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const fullTask = await resolveTaskDataManager(ctx).getTask(ctx, CONSIST_TASK_ULID);
    const initialDetails = new Map<string, LoadedTask>();
    initialDetails.set(CONSIST_TASK_ULID, fullTask);

    const cache = createConsistencyCache([initialSummary], initialDetails);
    const getEntityCache: EntityCacheAccessor = () => cache;

    ({ app } = createTestApp({ getEntityCache }));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should return needs_work on immediate task read after request_changes verdict", async () => {
    // Step 1: Submit request_changes verdict — this triggers task transition
    const verdictResponse = await requestJson(
      app,
      tempDir,
      "POST",
      `/api/reviews/${CONSIST_REVIEW_ULID}/verdicts`,
      {
        decision: "request_changes",
        reviewer: "test@example.com",
      },
    );

    expect(verdictResponse.status).toBe(200);
    const verdictBody = await verdictResponse.json();
    expect(verdictBody.disposition).toBe("changes_requested");

    // Step 2: Immediately read the task through the cache-backed GET endpoint
    const taskResponse = await requestJson(app, tempDir, "GET", `/api/tasks/${CONSIST_TASK_ULID}`);

    expect(taskResponse.status).toBe(200);
    const taskBody = await taskResponse.json();

    // The regression: without proper cache consistency, this would return
    // "pending_review" (stale) instead of "needs_work" (fresh).
    expect(taskBody.data.status).toBe("needs_work");
  });

  it("should return pending_review on immediate task read after approve verdict (no task transition)", async () => {
    // Approve verdict does NOT transition the task — verify the cache
    // still serves the original state correctly.
    const verdictResponse = await requestJson(
      app,
      tempDir,
      "POST",
      `/api/reviews/${CONSIST_REVIEW_ULID}/verdicts`,
      {
        decision: "approve",
        reviewer: "test@example.com",
      },
    );

    expect(verdictResponse.status).toBe(200);
    const verdictBody = await verdictResponse.json();
    expect(verdictBody.disposition).toBe("approved");

    // Task should still be in pending_review — approve doesn't transition it
    const taskResponse = await requestJson(app, tempDir, "GET", `/api/tasks/${CONSIST_TASK_ULID}`);

    expect(taskResponse.status).toBe(200);
    const taskBody = await taskResponse.json();
    expect(taskBody.data.status).toBe("pending_review");
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
// AC: @trait-localhost-security ac-loopback-default — N/A: review-verdicts route handler tests do not invoke app.listen(); default loopback bind is exercised in tests/cli-serve.test.ts (daemon child startup).
// AC: @trait-localhost-security ac-loopback-rejects-nonlocal — N/A: localhostOnly middleware is a server-level concern, exercised in tests/daemon-api/server.test.ts and tests/daemon-server.test.ts.
// AC: @trait-localhost-security ac-external-host-explicit — N/A: explicit non-loopback bind is exercised in tests/cli-serve.test.ts where daemon.host is configured.
// AC: @trait-localhost-security ac-external-warning — N/A: external-bind warning is surfaced from the CLI lifecycle path and exercised in tests/cli-serve.test.ts.
// AC: @trait-websocket-protocol ac-1 — N/A: WebSocket connection handling is in server.ts ws handler
// AC: @trait-websocket-protocol ac-2 — N/A: Topic subscription is in websocket/handler.ts
// AC: @trait-websocket-protocol ac-3 — N/A: Broadcast format is handled by PubSubManager (route just calls pubsub.broadcast)
// AC: @trait-websocket-protocol ac-4 — N/A: Heartbeat is in websocket/heartbeat.ts
// AC: @trait-websocket-protocol ac-5 — N/A: Pong timeout is in websocket/heartbeat.ts
// AC: @trait-websocket-protocol ac-6 — N/A: Backpressure is handled by PubSubManager
// AC: @trait-websocket-protocol ac-7 — N/A: Close codes are in websocket/lifecycle.ts
// AC: @trait-websocket-protocol ac-8 — N/A: Reconnection is client-side behavior
