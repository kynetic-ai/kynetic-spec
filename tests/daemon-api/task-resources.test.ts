/**
 * Daemon task resource bytes/list/metadata route tests.
 *
 * Exercises the task-scoped resource routes added by
 * @add-task-resource-bytes-routes:
 *   - GET /api/tasks/:ref/resources                       (resolved projection)
 *   - GET /api/tasks/:ref/resources/:resourceId           (single projection)
 *   - GET /api/tasks/:ref/resources/:resourceId/bytes     (drift-safe bytes)
 *
 * The routes reuse the shared task resource resolver, so drift status matches
 * `kspec task get --json`, the agent context, and the task-detail route. Byte
 * serving is drift-safe: only `present` references stream bytes; drift, missing,
 * and unresolved references each refuse with a structured non-2xx naming the
 * status. Plan-owned refs resolve through the source plan's manifest; task-owned
 * copies resolve through the current task's manifest.
 *
 * Spec: @task-resource-resolution-api-contract
 *       @live-task-resource-markdown-rendering
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";

import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  setupFixtures,
} from "./helpers.js";
import { seedSplitTask, testUlid } from "../helpers/cli.js";

let tempDir: string;
let app: Elysia;

const TASK_ULID = testUlid("TRB", 1);
const TASK_SLUG = "task-with-byte-resources";
const TASK_REF = `@${TASK_SLUG}`;

const PLAN_ULID = testUlid("TRB", 2);
const PLAN_SLUG = "byte-source-plan";

// Plan-owned present resource bytes (served through the plan manifest).
const PLAN_IMAGE_BYTES = Buffer.from("plan-owned-flow-diagram-bytes");
// Task-owned (materialized copy) present resource bytes.
const TASK_COPY_BYTES = Buffer.from("task-owned-home-screen-copy-bytes");
// Drift: recorded hash != current on-disk hash.
const DRIFT_RECORDED_BYTES = Buffer.from("doc-version-at-derivation");
const DRIFT_CURRENT_BYTES = Buffer.from("doc-changed-after-derivation-DIFFERENT");

const PLAN_IMAGE_SHA = sha256(PLAN_IMAGE_BYTES);
const TASK_COPY_SHA = sha256(TASK_COPY_BYTES);
const DRIFT_RECORDED_SHA = sha256(DRIFT_RECORDED_BYTES);
const DRIFT_CURRENT_SHA = sha256(DRIFT_CURRENT_BYTES);
const MISSING_RECORDED_SHA = sha256(Buffer.from("never-on-disk"));
const GHOST_RECORDED_SHA = sha256(Buffer.from("owner-plan-deleted"));

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

/**
 * The task's recorded resource_refs spanning every resolution status:
 * plan-owned present, task-owned present (materialized copy), task-owned drift,
 * task-owned missing, and plan-owned unresolved (owner plan does not exist).
 *
 * The present refs (`plan-diagram`, `task-home`) record the hash of the bytes
 * actually seeded for this project so they resolve `present` regardless of
 * which project's bytes are on disk — that is what lets the multi-project
 * routing test seed different bytes per project without tripping drift.
 */
function taskResourceRefs(planImageSha: string, taskCopySha: string) {
  return [
    {
      owner_type: "plan",
      owner_ref: `@${PLAN_SLUG}`,
      id: "plan-diagram",
      path: "diagrams/flow.png",
      sha256: planImageSha,
      git_commit: null,
      git_path: null,
      recorded_at: "2026-01-01T00:00:00.000Z",
    },
    {
      owner_type: "task",
      owner_ref: TASK_ULID,
      id: "task-home",
      path: "screens/home.png",
      sha256: taskCopySha,
      git_commit: null,
      git_path: null,
      recorded_at: "2026-01-01T00:00:00.000Z",
    },
    {
      owner_type: "task",
      owner_ref: TASK_ULID,
      id: "drift-doc",
      path: "docs/b.md",
      sha256: DRIFT_RECORDED_SHA,
      git_commit: null,
      git_path: null,
      recorded_at: "2026-01-01T00:00:00.000Z",
    },
    {
      owner_type: "task",
      owner_ref: TASK_ULID,
      id: "missing-one",
      path: "gone/c.txt",
      sha256: MISSING_RECORDED_SHA,
      git_commit: null,
      git_path: null,
      recorded_at: "2026-01-01T00:00:00.000Z",
    },
    {
      owner_type: "plan",
      owner_ref: "@ghost-plan",
      id: "ghost-ref",
      path: "x/y.png",
      sha256: GHOST_RECORDED_SHA,
      git_commit: null,
      git_path: null,
      recorded_at: "2026-01-01T00:00:00.000Z",
    },
  ];
}

/**
 * Seed a folder-backed plan whose manifest declares the plan-owned resource the
 * task references. Mirrors tests/daemon-api/plan-resources.test.ts so the bytes
 * the daemon resolves are deterministic.
 */
function seedSourcePlan(dir: string, imageBytes: Buffer): void {
  execSync(`rm -rf ${path.join(dir, ".kspec", "plans")}`);
  writeFileSync(
    path.join(dir, ".kspec", "project.plans.yaml"),
    yamlStringify({
      kynetic_plans: "1.0",
      plans: [
        {
          _ulid: PLAN_ULID,
          slugs: [PLAN_SLUG],
          title: "Byte Source Plan",
          status: "active",
          derived_tasks: [],
          derived_specs: [],
          source_path: null,
          created_at: "2026-01-15T10:00:00Z",
          approved_at: "2026-01-16T12:00:00Z",
          completed_at: null,
        },
      ],
    }),
  );

  const planDir = path.join(dir, ".kspec", "plans", PLAN_ULID);
  const resourcesDir = path.join(planDir, "resources", "diagrams");
  mkdirSync(resourcesDir, { recursive: true });
  writeFileSync(
    path.join(planDir, "plan.yaml"),
    yamlStringify({
      _ulid: PLAN_ULID,
      slugs: [PLAN_SLUG],
      title: "Byte Source Plan",
      status: "active",
      derived_tasks: [],
      derived_specs: [],
      source_path: null,
      created_at: "2026-01-15T10:00:00Z",
      approved_at: "2026-01-16T12:00:00Z",
      completed_at: null,
    }),
  );
  writeFileSync(path.join(planDir, "plan.md"), "# Byte Source Plan\n");
  writeFileSync(path.join(planDir, "resources", "diagrams", "flow.png"), imageBytes);
  writeFileSync(
    path.join(planDir, "resources.yaml"),
    yamlStringify({
      resources: [
        {
          id: "plan-diagram",
          label: null,
          path: "diagrams/flow.png",
          content_type: "image/png",
          bytes: imageBytes.length,
          sha256: sha256(imageBytes),
          git_commit: null,
          git_path: null,
          description: null,
        },
      ],
    }),
  );
}

/**
 * Seed the task-owned resource bytes + manifest. `screens/home.png` is the
 * materialized copy (present); `docs/b.md` is on disk with DIFFERENT bytes than
 * the recorded hash (drift); `gone/c.txt` is absent from the manifest entirely
 * (missing).
 */
function seedTaskResourceManifest(dir: string, copyBytes: Buffer, driftBytes: Buffer): void {
  const taskDir = path.join(dir, ".kspec", "tasks", TASK_ULID);
  const resourcesDir = path.join(taskDir, "resources");
  mkdirSync(path.join(resourcesDir, "screens"), { recursive: true });
  mkdirSync(path.join(resourcesDir, "docs"), { recursive: true });
  writeFileSync(path.join(resourcesDir, "screens", "home.png"), copyBytes);
  writeFileSync(path.join(resourcesDir, "docs", "b.md"), driftBytes);

  writeFileSync(
    path.join(taskDir, "resources.yaml"),
    yamlStringify({
      resources: [
        {
          id: "task-home",
          label: null,
          path: "screens/home.png",
          content_type: "image/png",
          bytes: copyBytes.length,
          sha256: sha256(copyBytes),
          git_commit: null,
          git_path: null,
          description: null,
        },
        {
          id: "drift-doc",
          label: null,
          path: "docs/b.md",
          content_type: "text/markdown",
          bytes: driftBytes.length,
          sha256: sha256(driftBytes),
          git_commit: null,
          git_path: null,
          description: null,
        },
      ],
    }),
  );
}

function seedTask(dir: string, planImageSha: string, taskCopySha: string): void {
  seedSplitTask(path.join(dir, ".kspec"), {
    _ulid: TASK_ULID,
    slugs: [TASK_SLUG],
    title: "Task with byte resources",
    type: "task",
    status: "in_progress",
    priority: 1,
    depends_on: [],
    blocked_by: [],
    tags: [],
    notes: [],
    todos: [],
    created_at: "2026-01-01T00:00:00.000Z",
    resource_refs: taskResourceRefs(planImageSha, taskCopySha),
  });
}

/** Seed a full project (plan + task + manifests) with the given resource bytes. */
function seedProject(
  dir: string,
  bytes: { planImage: Buffer; taskCopy: Buffer; driftCurrent: Buffer },
): void {
  seedSourcePlan(dir, bytes.planImage);
  seedTask(dir, sha256(bytes.planImage), sha256(bytes.taskCopy));
  seedTaskResourceManifest(dir, bytes.taskCopy, bytes.driftCurrent);
}

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-task-resource-bytes-");
  initGitRepo(tempDir);
  setupFixtures(tempDir);
  seedProject(tempDir, {
    planImage: PLAN_IMAGE_BYTES,
    taskCopy: TASK_COPY_BYTES,
    driftCurrent: DRIFT_CURRENT_BYTES,
  });
  ({ app } = createTestApp());
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

describe("GET /api/tasks/:ref/resources (list)", () => {
  // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resolved-resources
  // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resource-base-url
  it("returns the resolved_resources projection plus a task-scoped base url", async () => {
    const response = await request(`/api/tasks/${TASK_REF}/resources`);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.resources_base_url).toBe(`/api/tasks/${TASK_ULID}/resources`);
    expect(Array.isArray(body.resolved_resources)).toBe(true);
    const byId = Object.fromEntries(
      (body.resolved_resources as Array<{ id: string; status: string }>).map((r) => [r.id, r]),
    );
    expect(byId["plan-diagram"].status).toBe("present");
    expect(byId["task-home"].status).toBe("present");
    expect(byId["drift-doc"].status).toBe("drift");
    expect(byId["missing-one"].status).toBe("missing");
    expect(byId["ghost-ref"].status).toBe("unresolved");
  });

  // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-refuse-drifted-or-missing-ref
  it("returns 404 task_not_found for an unknown task ref", async () => {
    const response = await request(`/api/tasks/@no-such-task/resources`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("task_not_found");
  });
});

describe("GET /api/tasks/:ref/resources/:resourceId (metadata)", () => {
  // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resolved-resources
  it("returns a single present resolved-resource projection entry", async () => {
    const response = await request(`/api/tasks/${TASK_REF}/resources/plan-diagram`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resolved_resource.id).toBe("plan-diagram");
    expect(body.resolved_resource.status).toBe("present");
    expect(body.resolved_resource.owner_type).toBe("plan");
    expect(body.resolved_resource.content_type).toBe("image/png");
  });

  // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-refuse-drifted-or-missing-ref
  // The detail route reports the exact status for a drifted reference (200,
  // status: "drift") and never streams bytes — the projection carries the
  // diverging recorded vs current hashes for the UI to surface.
  it("reports drift status on the detail route without streaming bytes", async () => {
    const response = await request(`/api/tasks/${TASK_REF}/resources/drift-doc`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resolved_resource.status).toBe("drift");
    expect(body.resolved_resource.recorded_sha256).toBe(DRIFT_RECORDED_SHA);
    expect(body.resolved_resource.current_sha256).toBe(DRIFT_CURRENT_SHA);
    expect(body.resolved_resource.recorded_sha256).not.toBe(body.resolved_resource.current_sha256);
  });

  // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-refuse-drifted-or-missing-ref
  it("returns 404 resource_not_found when the task has no matching resource id", async () => {
    const response = await request(`/api/tasks/${TASK_REF}/resources/does-not-exist`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("resource_not_found");
  });
});

describe("GET /api/tasks/:ref/resources/:resourceId/bytes (present)", () => {
  // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-serve-present-plan-owned-ref
  it("serves plan-owned bytes with content headers from the current resource", async () => {
    const response = await request(`/api/tasks/${TASK_REF}/resources/plan-diagram/bytes`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(PLAN_IMAGE_BYTES.length));
    expect(response.headers.get("x-kspec-resource-sha256")).toBe(PLAN_IMAGE_SHA);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.equals(PLAN_IMAGE_BYTES)).toBe(true);
  });

  // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-serve-present-task-owned-copy
  it("serves task-owned copy bytes with content headers from the task manifest", async () => {
    const response = await request(`/api/tasks/${TASK_REF}/resources/task-home/bytes`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(TASK_COPY_BYTES.length));
    expect(response.headers.get("x-kspec-resource-sha256")).toBe(TASK_COPY_SHA);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.equals(TASK_COPY_BYTES)).toBe(true);
  });
});

describe("GET /api/tasks/:ref/resources/:resourceId/bytes (drift-safe refusal)", () => {
  // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-refuse-drifted-or-missing-ref
  // AC: @live-task-resource-markdown-rendering ac-drifted-task-resource-is-visible-not-silent
  // Drift refuses with 409 naming the status and serves NONE of the changed
  // on-disk bytes — the user-facing guard against silently substituting bytes
  // that differ from the version recorded at derivation.
  it("refuses drifted references with 409 and never streams the changed bytes", async () => {
    const response = await request(`/api/tasks/${TASK_REF}/resources/drift-doc/bytes`);
    expect(response.status).toBe(409);
    expect(response.headers.get("x-kspec-resource-sha256")).toBeNull();
    const body = await response.json();
    expect(body.status).toBe("drift");
    expect(body.code).toBe("resource_drift");
    // The refusal body is structured JSON — not the drifted file bytes.
    expect(JSON.stringify(body)).not.toContain(DRIFT_CURRENT_BYTES.toString());
  });

  // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-refuse-drifted-or-missing-ref
  it("refuses missing references with 404 naming the missing status", async () => {
    const response = await request(`/api/tasks/${TASK_REF}/resources/missing-one/bytes`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.status).toBe("missing");
    expect(body.code).toBe("resource_missing");
  });

  // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-refuse-drifted-or-missing-ref
  it("refuses unresolved references with 404 naming the unresolved status", async () => {
    const response = await request(`/api/tasks/${TASK_REF}/resources/ghost-ref/bytes`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.status).toBe("unresolved");
    expect(body.code).toBe("resource_unresolved");
  });

  // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-refuse-drifted-or-missing-ref
  it("returns 404 resource_not_found for an unknown resource id", async () => {
    const response = await request(`/api/tasks/${TASK_REF}/resources/unknown-id/bytes`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("resource_not_found");
  });
});

describe("selected-project routing (multi-project daemon)", () => {
  let projectA: string; // default
  let projectB: string; // selected non-default

  beforeEach(async () => {
    projectA = await createTempDir("kspec-task-bytes-default-a-");
    projectB = await createTempDir("kspec-task-bytes-selected-b-");
    initGitRepo(projectA);
    initGitRepo(projectB);
    setupFixtures(projectA);
    setupFixtures(projectB);
    // Same task + resource id in both projects, but DIFFERENT bytes, so a
    // request that silently falls back to the default returns A's bytes.
    seedProject(projectA, {
      planImage: Buffer.from("PROJECT-A-plan-image"),
      taskCopy: Buffer.from("PROJECT-A-task-copy"),
      driftCurrent: DRIFT_CURRENT_BYTES,
    });
    seedProject(projectB, {
      planImage: Buffer.from("PROJECT-B-plan-image"),
      taskCopy: Buffer.from("PROJECT-B-task-copy"),
      driftCurrent: DRIFT_CURRENT_BYTES,
    });

    const built = createTestApp();
    app = built.app;
    built.manager.registerProject(projectA, true);
    built.manager.registerProject(projectB, false);
  });

  afterEach(async () => {
    await cleanupTempDir(projectA);
    await cleanupTempDir(projectB);
  });

  /**
   * Browser-style fetch: NO `X-Kspec-Dir` header (an `<img src>` / `<a href>`
   * request cannot send one), selected-project path travels as `?kspec_dir=`.
   */
  function browserFetch(target: string) {
    return app.handle(
      new Request(`http://localhost${target}`, {
        method: "GET",
        headers: { Host: "localhost" },
      }),
    );
  }

  // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-serve-present-plan-owned-ref
  // AC: @live-task-resource-markdown-rendering ac-drifted-task-resource-is-visible-not-silent
  //     — a browser-issued task bytes URL carrying the selected project's
  //       kspec_dir (and no X-Kspec-Dir header) returns the SELECTED project's
  //       bytes, not the default project's.
  it("serves the selected project's bytes for a kspec_dir-scoped URL", async () => {
    const target = `/api/tasks/${TASK_ULID}/resources/plan-diagram/bytes?kspec_dir=${encodeURIComponent(projectB)}`;
    const response = await browserFetch(target);
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.toString()).toBe("PROJECT-B-plan-image");
    expect(bytes.toString()).not.toBe("PROJECT-A-plan-image");
  });

  // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-serve-present-plan-owned-ref
  //     — with no project context the browser fetch resolves to the default
  //       project (A), pinning the default-routing direction.
  it("serves the default project's bytes when no project context is supplied", async () => {
    const target = `/api/tasks/${TASK_ULID}/resources/plan-diagram/bytes`;
    const response = await browserFetch(target);
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.toString()).toBe("PROJECT-A-plan-image");
  });
});
