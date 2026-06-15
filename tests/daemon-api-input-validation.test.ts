import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  FOLDER_BACKED_INLINE_MANIFEST,
  initGitRepo,
  makeRequest,
  requestJson,
  setupInlineFixtures,
  testUlid,
} from "./daemon-api/helpers.js";

// AC: @daemon-test-mode-boundaries ac-in-process-route-tests-no-child-process
// AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run

const REVIEW_OPEN_ULID = testUlid("RVOP", 1);
const TASK_ULID = testUlid("TASK", 2);
const SPEC_ULID = testUlid("SPEC", 3);

let tempDir: string;
let app: Elysia;

function setupValidationFixtures(dir: string) {
  setupInlineFixtures(dir, {
    // AC: @entity-folder-migration-and-compatibility-1 ac-new-projects-declare-folder-storage
    //   — folder-backed manifest so the daemon review-route gate passes and
    //   the verdict execution test can exercise the mutation path. Validation
    //   tests (400 cases) still fire at the Elysia schema layer before the
    //   gate, so they remain unaffected by the manifest change.
    manifest: FOLDER_BACKED_INLINE_MANIFEST,
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
    splitTasks: [
      {
        _ulid: TASK_ULID,
        slugs: ["task-test"],
        title: "Test Task",
        description: "A test task",
        status: "pending_review",
        type: "task",
        automation: "eligible",
        spec_ref: "@test-feature",
        review_ref: "@review-open",
        priority: 2,
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
    reviews: `kynetic_reviews: "1.0"
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
    plans: `kynetic_plans: "1.0"
plans: []
`,
    triage: `kynetic_triage: "1.0"
records: []
`,
    meta: `kynetic_meta: "1.0"
agents:
  - _ulid: ${testUlid("AGNT", 4)}
    id: reviewer
    name: Reviewer Agent
    description: Review agent
    adapter: claude-agent-acp
    dispatch: []
    capabilities: []
    tools: []
    skills: []
    concurrency:
      max_concurrent: 1
    auto_approve: false
observations: []
workflows: []
conventions: []
`,
  });
}

describe("Daemon API input validation", () => {
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-daemon-api-input-validation-");
    initGitRepo(tempDir);
    setupValidationFixtures(tempDir);
    ({ app } = createTestApp());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @api-input-type-safety ac-1
  // AC: @trait-type-safe-input ac-1
  // AC: @trait-type-safe-input ac-2
  // AC: @trait-type-safe-input ac-3
  // AC: @trait-api-endpoint ac-3
  it("rejects invalid mutation enum values before the review handler executes", async () => {
    const before = readFileSync(path.join(tempDir, "project.reviews.yaml"), "utf8");

    const response = await requestJson(
      app,
      tempDir,
      "POST",
      `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`,
      {
        decision: "invalid_decision",
        reviewer: "reviewer@example.com",
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(body.details[0].field).toBe("decision");
    expect(body.details[0].message).toContain("approve");
    expect(body.details[0].message).toContain("request_changes");

    const after = readFileSync(path.join(tempDir, "project.reviews.yaml"), "utf8");
    expect(after).toBe(before);
  });

  // AC: @api-input-type-safety ac-2
  it("allows valid mutation enum values to execute normally", async () => {
    const response = await requestJson(
      app,
      tempDir,
      "POST",
      `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`,
      {
        decision: "approve",
        reviewer: "reviewer@example.com",
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.decision).toBe("approve");
    // `reviewer@example.com` is an email-suffix variant of the configured
    // `reviewer` agent; the shared actor-write utility persists the canonical id.
    expect(body.reviewer).toBe("reviewer");
  });

  // AC: @api-input-type-safety ac-3
  it("rejects invalid enum query filters across daemon list and search endpoints", async () => {
    const cases = [
      ["/api/tasks?status=invalid_status", "pending"],
      ["/api/items?type=invalid_type", "feature"],
      ["/api/reviews?status=invalid_status", "open"],
      ["/api/reviews?subject_type=invalid_type", "task"],
      ["/api/triage?status=invalid_status", "triaged"],
      ["/api/plans?status=invalid_status", "draft"],
      ["/api/sessions?status=invalid_status", "active"],
      ["/api/search?q=test&type=invalid_type", "feature"],
      ["/api/meta/observations?type=invalid_type", "friction"],
    ] as const;

    for (const [url, expectedValue] of cases) {
      const response = await makeRequest(app, tempDir, url);
      // oxlint-disable-next-line jest/valid-expect -- vitest supports custom message as 2nd arg
      expect(response.status, url).toBe(400);
      const body = await response.json();
      // oxlint-disable-next-line jest/valid-expect -- vitest supports custom message as 2nd arg
      expect(body.error, url).toBe("validation_error");
      // oxlint-disable-next-line jest/valid-expect -- vitest supports custom message as 2nd arg
      expect(body.details[0].message, url).toContain(expectedValue);
    }
  });

  // AC: @api-input-type-safety ac-2
  it("keeps the supported dispatched session-trigger alias valid at the framework boundary", async () => {
    const response = await makeRequest(app, tempDir, "/api/sessions?trigger=dispatched");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toEqual([]);
    expect(body.meta.total).toBe(0);
  });
});
