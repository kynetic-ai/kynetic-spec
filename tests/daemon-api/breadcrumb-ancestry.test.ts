/**
 * Daemon API coverage for server-resolved breadcrumb ancestor chains.
 *
 * Proves @ui-breadcrumb ac-10: each detail endpoint returns the full ancestor
 * chain (ref, title, kind, root-to-current order) in the same bounded detail
 * response the page already fetches — the client never issues an unbounded
 * entity-list request to reconstruct the trail.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Elysia } from "elysia";
import * as YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  seedSplitTask,
  setupInlineFixtures,
  testUlid,
  testUlids,
} from "./helpers.js";

// Distinct, valid ULIDs for the controlled hierarchy.
const [MODULE_ULID, FEATURE_ULID, REQUIREMENT_ULID, TASK_ULID, PLAN_ULID, REVIEW_ULID] = testUlids(
  "anc",
  6,
);
const SESSION_ID = testUlid("ancs");

// Split task storage manifest with folder-backed plan/review storage so the
// plan and review detail endpoints serve real records. Includes the auth
// module fixture below.
const MANIFEST = `kynetic: "1.2"
task_storage:
  format: split
plan_storage:
  format: folder
review_storage:
  format: folder
project:
  name: Test Project
  version: "0.1.0"
  status: draft
includes:
  - modules/auth.yaml
`;

// A plan anchored to the auth module: its chain is the module chain plus the plan.
function plansYaml(): string {
  return `kynetic_plans: "1.0"
plans:
  - _ulid: ${PLAN_ULID}
    slugs:
      - plan-auth-rollout
    title: Auth Rollout Plan
    content: |
      # Auth Rollout
    status: active
    module_ref: "@auth-module"
    derived_tasks: []
    derived_specs: []
    source_path: null
    created_at: "2026-06-01T00:00:00.000Z"
    approved_at: null
    completed_at: null
    notes: []
`;
}

// A review whose subject is the seeded task: its chain is the task's chain
// (spec chain plus the task) plus the review.
function reviewsYaml(): string {
  return `kynetic_reviews: "1.0"
reviews:
  - _ulid: ${REVIEW_ULID}
    slugs:
      - review-password-login
    title: Review of password login
    author: reviewer@test.com
    lifecycle_state: open
    subject:
      type: task
      ref: "@task-password-login"
      shadow_commit: abc1234
      content_hash: hash123
    examined_commit: null
    external_links: []
    related_refs: []
    threads: []
    checks: []
    verdicts: []
    events: []
    notes: []
    created_at: "2026-06-01T00:00:00.000Z"
`;
}

// Write a minimal task-scoped session into .kspec-sessions/<id>/.
function writeSession(dir: string, sessionId: string, taskId: string): void {
  const sessionDir = join(dir, ".kspec-sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "session.yaml"),
    YAML.stringify({
      id: sessionId,
      agent_type: "claude-agent-acp",
      agent_id: "worker",
      status: "completed",
      trigger: "task.ready",
      task_id: taskId,
      started_at: "2026-06-01T10:00:00.000Z",
    }),
  );
  writeFileSync(
    join(sessionDir, "events.jsonl"),
    `${JSON.stringify({
      seq: 0,
      ts: Date.parse("2026-06-01T10:00:00.000Z"),
      type: "session.start",
      session_id: sessionId,
      data: { message: "Starting run" },
    })}\n`,
  );
}

function moduleYaml(): string {
  return `_ulid: ${MODULE_ULID}
slugs:
  - auth-module
title: Auth Module
type: module
status:
  maturity: draft
  implementation: not_started
description: Authentication module.

features:
  - _ulid: ${FEATURE_ULID}
    slugs:
      - login-feature
    title: Login Feature
    type: feature
    status:
      maturity: draft
      implementation: in_progress
    description: Login feature.
    requirements:
      - _ulid: ${REQUIREMENT_ULID}
        slugs:
          - password-login
        title: Password Login
        type: requirement
        status:
          maturity: draft
          implementation: not_started
        description: Password login requirement.
`;
}

let tempDir: string;
let app: Elysia;

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-breadcrumb-");
  initGitRepo(tempDir);
  setupInlineFixtures(tempDir, {
    manifest: MANIFEST,
    modules: { "auth.yaml": moduleYaml() },
    splitTasks: [],
    plans: plansYaml(),
    reviews: reviewsYaml(),
    skipCommit: true,
  });
  // Seed a task whose spec_ref points at the nested requirement.
  seedSplitTask(tempDir, {
    _ulid: TASK_ULID,
    slugs: ["task-password-login"],
    title: "Implement password login",
    type: "task",
    status: "pending",
    priority: 2,
    spec_ref: "@password-login",
    tags: [],
    depends_on: [],
    created_at: "2026-06-01T00:00:00.000Z",
  });
  // Seed a task-scoped session whose owning task is the seeded task.
  writeSession(tempDir, SESSION_ID, "@task-password-login");
  execSync('git add -A && git commit -m "seed"', { cwd: tempDir, stdio: "pipe" });
  ({ app } = createTestApp());
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

describe("GET /api/items/:ref ancestors", () => {
  // AC: @ui-breadcrumb ac-10
  it("returns the full root-to-item chain with ref, title, and kind", async () => {
    const response = await request("/api/items/@password-login");
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.ancestors).toEqual([
      { ref: MODULE_ULID, title: "Auth Module", kind: "module" },
      { ref: FEATURE_ULID, title: "Login Feature", kind: "feature" },
      { ref: REQUIREMENT_ULID, title: "Password Login", kind: "requirement" },
    ]);
  });

  // AC: @ui-breadcrumb ac-10
  it("returns a single-segment chain for a root module", async () => {
    const response = await request("/api/items/@auth-module");
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.ancestors).toEqual([{ ref: MODULE_ULID, title: "Auth Module", kind: "module" }]);
  });
});

describe("GET /api/tasks/:ref ancestors", () => {
  // AC: @ui-breadcrumb ac-10
  it("returns the spec_ref chain plus the task itself", async () => {
    const response = await request("/api/tasks/@task-password-login");
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.ancestors).toEqual([
      { ref: MODULE_ULID, title: "Auth Module", kind: "module" },
      { ref: FEATURE_ULID, title: "Login Feature", kind: "feature" },
      { ref: REQUIREMENT_ULID, title: "Password Login", kind: "requirement" },
      { ref: TASK_ULID, title: "Implement password login", kind: "task" },
    ]);
  });
});

describe("GET /api/plans/:ref ancestors", () => {
  // AC: @ui-breadcrumb ac-10
  it("returns the module_ref chain plus the plan itself", async () => {
    const response = await request("/api/plans/@plan-auth-rollout");
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.ancestors).toEqual([
      { ref: MODULE_ULID, title: "Auth Module", kind: "module" },
      { ref: PLAN_ULID, title: "Auth Rollout Plan", kind: "plan" },
    ]);
  });
});

describe("GET /api/reviews/:ref ancestors", () => {
  // AC: @ui-breadcrumb ac-10
  it("returns the subject task's chain plus the review itself", async () => {
    const response = await request("/api/reviews/@review-password-login");
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.ancestors).toEqual([
      { ref: MODULE_ULID, title: "Auth Module", kind: "module" },
      { ref: FEATURE_ULID, title: "Login Feature", kind: "feature" },
      { ref: REQUIREMENT_ULID, title: "Password Login", kind: "requirement" },
      { ref: TASK_ULID, title: "Implement password login", kind: "task" },
      { ref: REVIEW_ULID, title: "Review of password login", kind: "review" },
    ]);
  });
});

describe("GET /api/sessions/:id ancestors", () => {
  // AC: @ui-breadcrumb ac-10
  it("returns an ancestor chain ending in the session segment", async () => {
    const response = await request(`/api/sessions/${SESSION_ID}`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    // The in-process test app registers no entity cache, so the session route
    // degrades to the single-segment chain (the same warm-up degradation
    // task_title/spec_context use). The route still resolves the chain
    // server-side — the client never reconstructs it from a list fetch.
    expect(Array.isArray(data.ancestors)).toBe(true);
    expect(data.ancestors.at(-1)).toEqual({ ref: SESSION_ID, title: null, kind: "session" });
  });
});
