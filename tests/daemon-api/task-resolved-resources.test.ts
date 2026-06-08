/**
 * Daemon task-detail resolved-resources API tests.
 *
 * Exercises GET /api/tasks/:ref reporting the task's derived resource_refs as a
 * bounded resolved-resource projection with drift status plus a task-scoped
 * `resources_base_url`, and verifies the index tier (task list) never carries
 * resource bytes/manifests. The route reuses the shared resolver
 * (resolveTaskResources + projectResolvedTaskResources) so drift semantics
 * match `kspec task get --json` and the agent context.
 *
 * Spec: @task-resource-resolution-api-contract
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import type { ResolvedTaskResourceSummary, TaskDetail } from "@kynetic-ai/shared";

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

// Deterministic identities so resource expectations stay predictable.
const TASK_ULID = testUlid("TRR", 1);
const TASK_SLUG = "task-with-resources";
const TASK_REF = `@${TASK_SLUG}`;
const PLAIN_TASK_ULID = testUlid("TRR", 2);
const PLAIN_TASK_SLUG = "task-without-resources";

const PRESENT_BYTES = Buffer.from("alpha-present-resource-bytes");
const DRIFT_RECORDED_BYTES = Buffer.from("doc-original-version");
const DRIFT_CURRENT_BYTES = Buffer.from("doc-changed-after-derivation");

const PRESENT_SHA = sha256(PRESENT_BYTES);
const DRIFT_RECORDED_SHA = sha256(DRIFT_RECORDED_BYTES);
const DRIFT_CURRENT_SHA = sha256(DRIFT_CURRENT_BYTES);
const MISSING_RECORDED_SHA = sha256(Buffer.from("never-on-disk"));

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

/**
 * The task's recorded resource_refs (what `kspec plan derive` would persist).
 * Three task-owned references covering present, drift, and missing resolution.
 */
function taskResourceRefs() {
  return [
    {
      owner_type: "task",
      owner_ref: TASK_ULID,
      id: "present-png",
      path: "img/a.png",
      sha256: PRESENT_SHA,
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
  ];
}

/**
 * Write the task-owned resource bytes + manifest into the task's folder. The
 * `missing-one` reference is intentionally absent from the manifest so the
 * resolver reports it as `missing`. The drift entry's current bytes differ
 * from the recorded hash so the resolver reports `drift`.
 */
function seedTaskResourceManifest(): void {
  const taskDir = path.join(tempDir, ".kspec", "tasks", TASK_ULID);
  const resourcesDir = path.join(taskDir, "resources");
  mkdirSync(path.join(resourcesDir, "img"), { recursive: true });
  mkdirSync(path.join(resourcesDir, "docs"), { recursive: true });
  writeFileSync(path.join(resourcesDir, "img", "a.png"), PRESENT_BYTES);
  writeFileSync(path.join(resourcesDir, "docs", "b.md"), DRIFT_CURRENT_BYTES);

  writeFileSync(
    path.join(taskDir, "resources.yaml"),
    yamlStringify({
      resources: [
        {
          id: "present-png",
          label: null,
          path: "img/a.png",
          content_type: "image/png",
          bytes: PRESENT_BYTES.length,
          sha256: PRESENT_SHA,
          git_commit: null,
          git_path: null,
          description: null,
        },
        {
          id: "drift-doc",
          label: null,
          path: "docs/b.md",
          content_type: "text/markdown",
          bytes: DRIFT_CURRENT_BYTES.length,
          sha256: DRIFT_CURRENT_SHA,
          git_commit: null,
          git_path: null,
          description: null,
        },
      ],
    }),
  );
}

function seedTaskWithResources(): void {
  seedSplitTask(path.join(tempDir, ".kspec"), {
    _ulid: TASK_ULID,
    slugs: [TASK_SLUG],
    title: "Task with resources",
    type: "task",
    status: "in_progress",
    priority: 1,
    depends_on: [],
    blocked_by: [],
    tags: [],
    notes: [],
    todos: [],
    created_at: "2026-01-01T00:00:00.000Z",
    resource_refs: taskResourceRefs(),
  });
  seedTaskResourceManifest();
}

function seedPlainTask(): void {
  seedSplitTask(path.join(tempDir, ".kspec"), {
    _ulid: PLAIN_TASK_ULID,
    slugs: [PLAIN_TASK_SLUG],
    title: "Task without resources",
    type: "task",
    status: "pending",
    priority: 2,
    depends_on: [],
    blocked_by: [],
    tags: [],
    notes: [],
    todos: [],
    created_at: "2026-01-01T00:00:00.000Z",
  });
}

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-task-resources-");
  initGitRepo(tempDir);
  setupFixtures(tempDir);
  seedTaskWithResources();
  seedPlainTask();
  ({ app } = createTestApp());
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

describe("Task detail resolved resources", () => {
  // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resolved-resources
  it("exposes resolved_resources with the full per-entry field set", async () => {
    const response = await request(`/api/tasks/${TASK_REF}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const task = body.data as TaskDetail;

    expect(Array.isArray(task.resolved_resources)).toBe(true);
    expect(task.resolved_resources).toHaveLength(3);

    const present = task.resolved_resources!.find((r) => r.id === "present-png")!;
    // Every field the AC enumerates: owner type/ref, id, relative path,
    // content type, byte size, recorded + current hash, status, message.
    expect(present).toEqual<ResolvedTaskResourceSummary>({
      owner_type: "task",
      owner_ref: TASK_ULID,
      id: "present-png",
      path: "img/a.png",
      content_type: "image/png",
      byte_size: PRESENT_BYTES.length,
      status: "present",
      recorded_sha256: PRESENT_SHA,
      current_sha256: PRESENT_SHA,
      recorded_git_commit: null,
      current_git_commit: null,
      message: expect.stringContaining("matches the version recorded"),
    });
  });

  // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resolved-resources
  it("reports drift status with diverging recorded vs current hashes", async () => {
    const response = await request(`/api/tasks/${TASK_REF}`);
    const body = await response.json();
    const task = body.data as TaskDetail;

    const drift = task.resolved_resources!.find((r) => r.id === "drift-doc")!;
    expect(drift.status).toBe("drift");
    expect(drift.recorded_sha256).toBe(DRIFT_RECORDED_SHA);
    expect(drift.current_sha256).toBe(DRIFT_CURRENT_SHA);
    expect(drift.recorded_sha256).not.toBe(drift.current_sha256);
    // Content type and byte size come from the current owner manifest entry.
    expect(drift.content_type).toBe("text/markdown");
    expect(drift.byte_size).toBe(DRIFT_CURRENT_BYTES.length);
  });

  // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resolved-resources
  it("reports missing references with null current-manifest metadata", async () => {
    const response = await request(`/api/tasks/${TASK_REF}`);
    const body = await response.json();
    const task = body.data as TaskDetail;

    const missing = task.resolved_resources!.find((r) => r.id === "missing-one")!;
    expect(missing.status).toBe("missing");
    expect(missing.recorded_sha256).toBe(MISSING_RECORDED_SHA);
    expect(missing.current_sha256).toBeNull();
    expect(missing.content_type).toBeNull();
    expect(missing.byte_size).toBeNull();
  });

  // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resource-base-url
  it("exposes a task-scoped resources_base_url for byte construction", async () => {
    const response = await request(`/api/tasks/${TASK_REF}`);
    const body = await response.json();
    const task = body.data as TaskDetail;

    expect(task.resources_base_url).toBe(`/api/tasks/${TASK_ULID}/resources`);
    // The documented client construction yields a task-scoped bytes URL that
    // never requires the caller to know plan-owned vs task-owned ownership.
    const bytesUrl = `${task.resources_base_url}/${encodeURIComponent("present-png")}/bytes`;
    expect(bytesUrl).toBe(`/api/tasks/${TASK_ULID}/resources/present-png/bytes`);
  });

  // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resolved-resources
  // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resource-base-url
  it("omits both resource fields for tasks without resource_refs", async () => {
    const response = await request(`/api/tasks/@${PLAIN_TASK_SLUG}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const task = body.data as TaskDetail;

    expect(task.resolved_resources).toBeUndefined();
    expect(task.resources_base_url).toBeUndefined();
  });

  // AC: @task-resource-resolution-api-contract ac-task-detail-exposes-resolved-resources
  // Cache-hit path: a task served from the entity cache still flows through the
  // resolver, so resolved_resources/resources_base_url are populated identically
  // to the disk-fallback path.
  it("populates resolved resources on the cache-hit path", async () => {
    const cachedTask = {
      _ulid: TASK_ULID,
      slugs: [TASK_SLUG],
      title: "Task with resources",
      type: "task",
      status: "in_progress",
      priority: 1,
      depends_on: [],
      blocked_by: [],
      tags: [],
      notes: [],
      todos: [],
      created_at: "2026-01-01T00:00:00.000Z",
      resource_refs: taskResourceRefs(),
    };

    const cacheStub = {
      getDomainState: (domain: string) => (domain === "tasks" ? "ready" : "unloaded"),
      getTaskIndex: () => [cachedTask],
      getTaskDetail: () => cachedTask,
      getTaskHistory: () => null,
      setTaskDetail: () => {},
      getAllTaskDetails: () => null,
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
      writeThrough: async () => {},
      markWriteThrough: () => {},
      getCacheDiagnostics: () => ({}) as never,
    };

    ({ app } = createTestApp({ getEntityCache: () => cacheStub as never }));

    const response = await request(`/api/tasks/${TASK_REF}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const task = body.data as TaskDetail;

    expect(body.meta.cache_status).toBe("ready");
    expect(task.resolved_resources).toHaveLength(3);
    expect(task.resolved_resources!.map((r) => r.status).toSorted()).toEqual([
      "drift",
      "missing",
      "present",
    ]);
    expect(task.resources_base_url).toBe(`/api/tasks/${TASK_ULID}/resources`);
  });

  // AC: @task-resource-resolution-api-contract ac-task-resource-index-stays-bounded
  // The task list (index tier) must not embed resource bytes or the resolved
  // projection — those belong only to the detail route.
  it("keeps the task list index bounded with no resource projection or bytes", async () => {
    const response = await request("/api/tasks?limit=200");
    expect(response.status).toBe(200);
    const body = await response.json();
    const listed = (body.data as Array<Record<string, unknown>>).find((t) => t._ulid === TASK_ULID);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty("resolved_resources");
    expect(listed).not.toHaveProperty("resources_base_url");
    expect(listed).not.toHaveProperty("resource_refs");
    // No field on any list entry carries raw resource bytes.
    for (const entry of body.data as Array<Record<string, unknown>>) {
      expect(entry).not.toHaveProperty("resources_base_url");
      expect(entry).not.toHaveProperty("resolved_resources");
    }
  });
});
