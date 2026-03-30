import { rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  setupFixtures,
} from "./helpers.js";
import { seedSplitTask } from "../helpers/cli.js";

let tempDir: string;
let app: Elysia;

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-plans-");
  initGitRepo(tempDir);
  setupFixtures(tempDir);
  ({ app } = createTestApp());
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

describe("Plans API", () => {
  // AC: @ui-plans-view ac-2
  it("GET /api/plans/:ref returns 404 for non-existent plan references", async () => {
    const response = await request("/api/plans/non-existent-plan");

    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe("not_found");
    expect(body.message).toContain("non-existent-plan");
  });

  // AC: @01KM46FW ac-1
  it("GET /api/plans/:ref excludes cancelled tasks while preserving plan_ref-linked task counts", async () => {
    const kspecDir = path.join(tempDir, ".kspec");

    writeFileSync(
      path.join(kspecDir, "project.plans.yaml"),
      `kynetic_plans: "1.0"
plans:
  - _ulid: 01KG0RRPCA45ZT43W2T6HJMVP1
    slugs:
      - test-plan-active
    title: Active Implementation Plan
    content: |
      # Active Plan
    status: active
    derived_tasks: []
    derived_specs: []
    source_path: null
    created_at: "2026-01-15T10:00:00Z"
    approved_at: "2026-01-16T12:00:00Z"
    completed_at: null
    notes: []
`,
    );

    rmSync(path.join(kspecDir, "tasks"), { recursive: true, force: true });
    writeFileSync(path.join(kspecDir, "project.tasks.yaml"), "");

    seedSplitTask(kspecDir, {
      _ulid: "01KG0RR8CB8N4YGP991WD7XS9R",
      slugs: ["test-task-in-progress"],
      title: "In progress task",
      type: "task",
      status: "in_progress",
      priority: 3,
      plan_ref: "@01KG0RRP",
      depends_on: [],
      notes: [],
      todos: [],
      created_at: "2026-01-01T00:00:00Z",
    });

    seedSplitTask(kspecDir, {
      _ulid: "01KG0RRFCC9N4YGP991WD7XSCP",
      slugs: ["test-task-completed"],
      title: "Completed task",
      type: "task",
      status: "completed",
      priority: 3,
      plan_ref: "@test-plan-active",
      depends_on: [],
      notes: [],
      todos: [],
      created_at: "2026-01-01T00:00:00Z",
    });

    seedSplitTask(kspecDir, {
      _ulid: "01KG0RR6CA45ZT43W2T6HJMVA1",
      slugs: ["test-task-ready"],
      title: "Ready task",
      type: "task",
      status: "pending",
      priority: 2,
      plan_ref: "@test-plan-active",
      depends_on: [],
      notes: [],
      todos: [],
      created_at: "2026-01-01T00:00:00Z",
    });

    seedSplitTask(kspecDir, {
      _ulid: "01KG0RR7CC9N4YGP991WD7XS8S",
      slugs: ["test-task-cancelled"],
      title: "Cancelled task",
      type: "task",
      status: "cancelled",
      priority: 1,
      plan_ref: "@test-plan-active",
      depends_on: [],
      notes: [],
      todos: [],
      created_at: "2026-01-01T00:00:00Z",
    });

    const response = await request("/api/plans/test-plan-active");

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data.task_count).toBe(3);
    expect(body.data.task_progress).toEqual({
      total: 3,
      completed: 1,
      in_progress: 1,
      pending: 1,
      blocked: 0,
    });
  });
});
