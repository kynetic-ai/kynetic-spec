/**
 * Plan resource API route tests.
 *
 * Covers the resource list/metadata/bytes/upload/delete endpoints layered on
 * the folder-backed plan storage manager and the shared entity-local-resources
 * trait foundation.
 *
 * Spec: @folder-backed-plan-storage-1
 *       @trait-entity-scoped-local-resources-1
 *       @entity-folder-migration-and-compatibility-1
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as yamlStringify } from "yaml";

import {
  cleanupTempDir,
  captureBroadcasts,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  setupFixtures,
  setupInlineFixtures,
} from "./helpers.js";

let tempDir: string;
let app: Elysia;
let pubsub: ReturnType<typeof createTestApp>["pubsub"];

const PLAN_ULID = "01KG0RRPCA45ZT43W2T6HJMVP1";
const PLAN_SLUG = "test-plan-active";
const PLAN_REF = `@${PLAN_SLUG}`;

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

/**
 * Seed a single plan into the folder-backed layout the daemon expects, with
 * an optional declared resource manifest. setupFixtures already wires the
 * 1.2 manifest and creates folder shells for fixture plans, but the
 * resource-API tests need a curated plan with deterministic resource bytes
 * so the manifest stays predictable.
 */
function writePlanFolderWithResources(opts: {
  planUlid?: string;
  planSlug?: string;
  resources?: Array<{ id: string; path: string; bytes: Buffer; contentType: string }>;
}) {
  const planUlid = opts.planUlid ?? PLAN_ULID;
  const planSlug = opts.planSlug ?? PLAN_SLUG;
  const planDir = path.join(tempDir, ".kspec", "plans", planUlid);
  const resourcesDir = path.join(planDir, "resources");
  mkdirSync(planDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });

  writeFileSync(
    path.join(planDir, "plan.yaml"),
    yamlStringify({
      _ulid: planUlid,
      slugs: [planSlug],
      title: "Active Plan",
      status: "active",
      derived_tasks: [],
      derived_specs: [],
      source_path: null,
      created_at: "2026-01-15T10:00:00Z",
      approved_at: "2026-01-16T12:00:00Z",
      completed_at: null,
    }),
  );
  writeFileSync(path.join(planDir, "plan.md"), "# Active Plan\n");

  if (opts.resources && opts.resources.length > 0) {
    const manifestEntries = opts.resources.map((r) => {
      const abs = path.join(resourcesDir, r.path);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, r.bytes);
      const sha = require("node:crypto").createHash("sha256").update(r.bytes).digest("hex");
      return {
        id: r.id,
        label: null,
        path: r.path,
        content_type: r.contentType,
        bytes: r.bytes.length,
        sha256: sha,
        git_commit: null,
        git_path: null,
        description: null,
      };
    });
    writeFileSync(
      path.join(planDir, "resources.yaml"),
      yamlStringify({ resources: manifestEntries }),
    );
  }
}

describe("Plan Resource API", () => {
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-daemon-api-plan-resources-");
    initGitRepo(tempDir);
    setupFixtures(tempDir);
    // Replace the fixture-derived plan folders with one curated active plan
    // so resource expectations are deterministic.
    execSync(`rm -rf ${path.join(tempDir, ".kspec", "plans")}`);
    writeFileSync(
      path.join(tempDir, ".kspec", "project.plans.yaml"),
      `kynetic_plans: "1.0"\nplans:\n  - _ulid: ${PLAN_ULID}\n    slugs:\n      - ${PLAN_SLUG}\n    title: Active Plan\n    status: active\n    derived_tasks: []\n    derived_specs: []\n    source_path: null\n    created_at: "2026-01-15T10:00:00Z"\n    approved_at: "2026-01-16T12:00:00Z"\n    completed_at: null\n`,
    );
    ({ app, pubsub } = createTestApp());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // ── List ──────────────────────────────────────────────────────────────────

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("GET /api/plans/:ref/resources returns an empty list when no resources are declared", async () => {
    writePlanFolderWithResources({});
    const response = await request(`/api/plans/${PLAN_REF}/resources`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resources).toEqual([]);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("GET /api/plans/:ref/resources returns the strict 9-field ResourceMetadata shape (no embedded URLs)", async () => {
    const buf = Buffer.from("hello world");
    writePlanFolderWithResources({
      resources: [{ id: "hello-txt", path: "hello.txt", bytes: buf, contentType: "text/plain" }],
    });
    const response = await request(`/api/plans/${PLAN_REF}/resources`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0]).toEqual({
      id: "hello-txt",
      label: null,
      path: "hello.txt",
      content_type: "text/plain",
      bytes: buf.length,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      git_commit: null,
      git_path: null,
      description: null,
    });
    // Resource metadata is the exact 9-field contract — bytes_url, base_url,
    // or any other URL pointer must not leak into individual resource entries.
    expect(body.resources[0]).not.toHaveProperty("bytes_url");
    expect(body.resources[0]).not.toHaveProperty("base_url");
    expect(body.resources[0]).not.toHaveProperty("url");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("GET /api/plans/:ref/resources/:resourceId returns the strict 9-field shape", async () => {
    writePlanFolderWithResources({
      resources: [
        {
          id: "shot",
          path: "screenshots/login.png",
          bytes: Buffer.from([1, 2, 3]),
          contentType: "image/png",
        },
      ],
    });
    const response = await request(`/api/plans/${PLAN_REF}/resources/shot`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource).toEqual({
      id: "shot",
      label: null,
      path: "screenshots/login.png",
      content_type: "image/png",
      bytes: 3,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      git_commit: null,
      git_path: null,
      description: null,
    });
    expect(body.resource).not.toHaveProperty("bytes_url");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("GET /api/plans/:ref/resources/:resourceId returns 404 for an unknown resource", async () => {
    writePlanFolderWithResources({});
    const response = await request(`/api/plans/${PLAN_REF}/resources/ghost`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("resource_not_found");
    expect(body.code).toBe("resource_not_found");
    expect(body.resource_id).toBe("ghost");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("GET /api/plans/:ref/resources returns plan_not_found for an unknown plan", async () => {
    writePlanFolderWithResources({});
    const response = await request("/api/plans/@nope-not-here/resources");
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("plan_not_found");
  });

  // ── Bytes ─────────────────────────────────────────────────────────────────

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("GET /api/plans/:ref/resources/:resourceId/bytes streams the file with content-type and sha256 headers", async () => {
    const payload = Buffer.from("hello world\n");
    writePlanFolderWithResources({
      resources: [
        { id: "greeting", path: "greeting.txt", bytes: payload, contentType: "text/plain" },
      ],
    });
    const response = await request(`/api/plans/${PLAN_REF}/resources/greeting/bytes`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("x-kspec-resource-sha256")).toMatch(/^[0-9a-f]{64}$/);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(payload)).toBe(true);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  it("GET /api/plans/:ref/resources/:resourceId/bytes returns 404 for a missing resource id", async () => {
    writePlanFolderWithResources({});
    const response = await request(`/api/plans/${PLAN_REF}/resources/ghost/bytes`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("resource_not_found");
  });

  // ── POST: multipart upload ───────────────────────────────────────────────

  async function postUpload(opts: {
    file?: Blob | null;
    id?: string;
    path?: string;
    label?: string;
    description?: string;
    contentType?: string;
    replace?: string;
  }) {
    const form = new FormData();
    if (opts.file !== undefined && opts.file !== null) form.append("file", opts.file, "upload.bin");
    if (opts.id !== undefined) form.append("id", opts.id);
    if (opts.path !== undefined) form.append("path", opts.path);
    if (opts.label !== undefined) form.append("label", opts.label);
    if (opts.description !== undefined) form.append("description", opts.description);
    if (opts.contentType !== undefined) form.append("content_type", opts.contentType);
    if (opts.replace !== undefined) form.append("replace", opts.replace);
    return request(`/api/plans/${PLAN_REF}/resources`, { method: "POST", body: form });
  }

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  // AC: @shared-mutation-pipeline ac-2
  it("POST /api/plans/:ref/resources creates a new resource and returns 201", async () => {
    writePlanFolderWithResources({});
    const broadcastSpy = captureBroadcasts(pubsub);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    const response = await postUpload({
      file: blob,
      id: "shot",
      path: "screenshots/login.png",
      contentType: "image/png",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.replaced).toBe(false);
    expect(body.resource.id).toBe("shot");
    expect(body.resource.path).toBe("screenshots/login.png");
    expect(body.resource.bytes).toBe(4);
    expect(body.resource.content_type).toBe("image/png");
    expect(body.resource).not.toHaveProperty("bytes_url");
    expect(broadcastSpy).toHaveBeenCalledWith(
      "plans:updates",
      "plan_resource_changed",
      {
        plan_ulid: PLAN_ULID,
        resource_id: "shot",
        action: "added",
      },
      tempDir,
    );

    // Verify the file landed on disk via the documented bytes endpoint —
    // clients construct this URL from `PlanDetail.resources_base_url`, not
    // from a field embedded in the metadata.
    const verify = await request(`/api/plans/${PLAN_REF}/resources/shot/bytes`);
    expect(verify.status).toBe(200);
    expect(Buffer.from(await verify.arrayBuffer()).equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("POST with replace=true overwrites an existing resource and returns 200", async () => {
    writePlanFolderWithResources({
      resources: [
        { id: "shot", path: "shot.png", bytes: Buffer.from([1]), contentType: "image/png" },
      ],
    });
    const newBytes = Buffer.from([9, 9, 9]);
    const blob = new Blob([newBytes], { type: "image/png" });
    const response = await postUpload({
      file: blob,
      id: "shot",
      path: "shot.png",
      replace: "true",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.replaced).toBe(true);
    expect(body.resource.bytes).toBe(3);
    const verify = await request(`/api/plans/${PLAN_REF}/resources/shot/bytes`);
    expect(Buffer.from(await verify.arrayBuffer()).equals(newBytes)).toBe(true);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("POST without the file field returns 400 missing_resource_file", async () => {
    writePlanFolderWithResources({});
    const form = new FormData();
    form.append("id", "shot");
    form.append("path", "shot.png");
    const response = await request(`/api/plans/${PLAN_REF}/resources`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("missing_resource_file");
    expect(body.code).toBe("missing_resource_file");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("POST with an invalid id returns 400 invalid_resource_id", async () => {
    writePlanFolderWithResources({});
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    const response = await postUpload({
      file: blob,
      id: "Bad ID!",
      path: "ok.png",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_resource_id");
    expect(body.resource_id).toBe("Bad ID!");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  it("POST with an unsafe path returns 400 invalid_resource_path", async () => {
    writePlanFolderWithResources({});
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    const response = await postUpload({
      file: blob,
      id: "shot",
      path: "../escape.png",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_resource_path");
    expect(body.resource_id).toBe("shot");
    expect(body.path).toBe("../escape.png");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("POST replace=1 is treated as true; replace=0 as false; replace=garbage as 400", async () => {
    writePlanFolderWithResources({
      resources: [
        { id: "shot", path: "shot.png", bytes: Buffer.from([1]), contentType: "image/png" },
      ],
    });

    // replace=1 — should succeed with 200 (replaced)
    const blobOne = new Blob([new Uint8Array([2])], { type: "image/png" });
    const resOne = await postUpload({ file: blobOne, id: "shot", path: "shot.png", replace: "1" });
    expect(resOne.status).toBe(200);
    expect((await resOne.json()).replaced).toBe(true);

    // replace=0 — should refuse with 409 (id already present)
    const blobZero = new Blob([new Uint8Array([3])], { type: "image/png" });
    const resZero = await postUpload({
      file: blobZero,
      id: "shot",
      path: "shot.png",
      replace: "0",
    });
    expect(resZero.status).toBe(409);
    expect((await resZero.json()).error).toBe("resource_conflict");

    // replace=garbage — 400 invalid_replace_value
    const blobBad = new Blob([new Uint8Array([4])], { type: "image/png" });
    const resBad = await postUpload({
      file: blobBad,
      id: "other",
      path: "other.png",
      replace: "yes",
    });
    expect(resBad.status).toBe(400);
    expect((await resBad.json()).error).toBe("invalid_replace_value");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("POST without replace on an existing id returns 409 resource_conflict", async () => {
    writePlanFolderWithResources({
      resources: [
        { id: "shot", path: "shot.png", bytes: Buffer.from([1]), contentType: "image/png" },
      ],
    });
    const blob = new Blob([new Uint8Array([5])], { type: "image/png" });
    const response = await postUpload({ file: blob, id: "shot", path: "shot.png" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("resource_conflict");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("POST whose path collides with a different id returns 409 resource_conflict", async () => {
    writePlanFolderWithResources({
      resources: [
        { id: "first", path: "shared.png", bytes: Buffer.from([1]), contentType: "image/png" },
      ],
    });
    const blob = new Blob([new Uint8Array([2])], { type: "image/png" });
    const response = await postUpload({
      file: blob,
      id: "second",
      path: "shared.png",
      replace: "true",
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("resource_conflict");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("POST without explicit content_type infers it from the path extension", async () => {
    writePlanFolderWithResources({});
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const response = await postUpload({ file: blob, id: "shot", path: "shot.png" });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.resource.content_type).toBe("image/png");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("POST with an unknown extension falls back to application/octet-stream", async () => {
    writePlanFolderWithResources({});
    const blob = new Blob([new Uint8Array([1])]);
    const response = await postUpload({ file: blob, id: "mystery", path: "mystery.unknownext" });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.resource.content_type).toBe("application/octet-stream");
  });

  // ── DELETE ────────────────────────────────────────────────────────────────

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
  // AC: @shared-mutation-pipeline ac-2
  it("DELETE /api/plans/:ref/resources/:resourceId removes the resource and file", async () => {
    writePlanFolderWithResources({
      resources: [
        { id: "shot", path: "shot.png", bytes: Buffer.from([1]), contentType: "image/png" },
      ],
    });
    const broadcastSpy = captureBroadcasts(pubsub);
    const response = await request(`/api/plans/${PLAN_REF}/resources/shot`, { method: "DELETE" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.removed).toEqual({ id: "shot", path: "shot.png" });
    expect(broadcastSpy).toHaveBeenCalledWith(
      "plans:updates",
      "plan_resource_changed",
      {
        plan_ulid: PLAN_ULID,
        resource_id: "shot",
        action: "removed",
      },
      tempDir,
    );

    // Subsequent get returns 404
    const after = await request(`/api/plans/${PLAN_REF}/resources/shot`);
    expect(after.status).toBe(404);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
  it("DELETE returns 404 for an unknown resource id", async () => {
    writePlanFolderWithResources({});
    const response = await request(`/api/plans/${PLAN_REF}/resources/ghost`, { method: "DELETE" });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("resource_not_found");
  });

  // ── Plan list/detail include resources ───────────────────────────────────

  // AC: @folder-backed-plan-storage-1 ac-plan-document-sidecar-is-authoritative
  // AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("GET /api/plans/:ref returns resources and the safe resources_base_url on the detail response", async () => {
    writePlanFolderWithResources({
      resources: [
        { id: "shot", path: "shot.png", bytes: Buffer.from([1, 2, 3]), contentType: "image/png" },
      ],
    });
    const response = await request(`/api/plans/${PLAN_REF}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.content).toContain("# Active Plan");
    expect(body.data.resources).toHaveLength(1);
    expect(body.data.resources[0].id).toBe("shot");
    // PlanResourceMetadata stays strict — URL pointers live as a sibling on
    // PlanDetail, not inside the resource entries.
    expect(body.data.resources[0]).not.toHaveProperty("bytes_url");
    expect(body.data.resources_base_url).toBe(`/api/plans/${PLAN_ULID}/resources`);
    // Detail also surfaces the bounded resource summary so dashboard widgets
    // and the list route share an identical projection.
    expect(body.data.resource_summary).toEqual({ count: 1, total_bytes: 3 });
  });

  // AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
  it("GET /api/plans returns the bounded resource_summary on each plan in the list (disk-fallback path)", async () => {
    writePlanFolderWithResources({
      resources: [
        { id: "shot", path: "shot.png", bytes: Buffer.from([1, 2]), contentType: "image/png" },
      ],
    });
    const response = await request("/api/plans");
    expect(response.status).toBe(200);
    const body = await response.json();
    const plan = body.data.find((p: { _ulid: string }) => p._ulid === PLAN_ULID);
    expect(plan).toBeDefined();
    // List responses surface only the bounded summary — never the full
    // metadata array (which is served by the dedicated resource endpoints
    // and the per-plan detail route).
    expect(plan.resource_summary).toEqual({ count: 1, total_bytes: 2 });
    expect(plan.resources).toBeUndefined();
  });
});

// ── Cache-ready list path projects resource_summary ──────────────────────────

describe("Plan list — cache-ready resource_summary projection", () => {
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-daemon-api-plan-resources-cache-");
    initGitRepo(tempDir);
    setupFixtures(tempDir);
    execSync(`rm -rf ${path.join(tempDir, ".kspec", "plans")}`);
    writeFileSync(
      path.join(tempDir, ".kspec", "project.plans.yaml"),
      `kynetic_plans: "1.0"\nplans:\n  - _ulid: ${PLAN_ULID}\n    slugs:\n      - ${PLAN_SLUG}\n    title: Active Plan\n    status: active\n    derived_tasks: []\n    derived_specs: []\n    source_path: null\n    created_at: "2026-01-15T10:00:00Z"\n    approved_at: "2026-01-16T12:00:00Z"\n    completed_at: null\n`,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
  //     — the cache-hit fast path must surface the bounded resource_summary
  //     carried by PlanIndexSummary; without this projection, resource-bearing
  //     plans would look resource-free on the normal cached list endpoint.
  it("projects PlanIndexSummary.resource_summary on the cache-ready list response", async () => {
    writePlanFolderWithResources({
      resources: [
        { id: "shot", path: "shot.png", bytes: Buffer.from([1, 2, 3]), contentType: "image/png" },
        {
          id: "hero",
          path: "hero.png",
          bytes: Buffer.from([1, 2, 3, 4, 5]),
          contentType: "image/png",
        },
      ],
    });

    // Cache-ready fake: returns a PlanIndexSummary carrying the bounded
    // resource_summary (count + total_bytes) the route should project. The
    // fake reports plans/tasks as "ready" so the route hits the cache fast
    // path without falling back to disk-based loadPlans/loadAllTasks.
    const cacheStub = {
      getDomainState: (domain: string) =>
        domain === "plans" || domain === "tasks" ? "ready" : "unloaded",
      getPlansIndex: () => [
        {
          _ulid: PLAN_ULID,
          slugs: [PLAN_SLUG],
          title: "Active Plan",
          status: "active",
          created_at: "2026-01-15T10:00:00Z",
          approved_at: "2026-01-16T12:00:00Z",
          completed_at: null,
          source_path: null,
          module_ref: null,
          derived_tasks: [],
          derived_specs: [],
          resource_summary: { count: 2, total_bytes: 8 },
        },
      ],
      getTaskIndex: () => [],
      // Stubs for unused methods on this code path.
      getTaskDetail: () => null,
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

    ({ app } = createTestApp({
      getEntityCache: () => cacheStub as never,
    }));

    const response = await request("/api/plans");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meta.cache_status).toBe("ready");
    const plan = body.data.find((p: { _ulid: string }) => p._ulid === PLAN_ULID);
    expect(plan).toBeDefined();
    expect(plan.resource_summary).toEqual({ count: 2, total_bytes: 8 });
    // List responses still surface no per-resource metadata array — that
    // lives on the detail route and the dedicated /resources endpoints.
    expect(plan.resources).toBeUndefined();
  });

  // AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
  it("projects {count:0,total_bytes:0} on the cache-ready list response for resource-less plans", async () => {
    writePlanFolderWithResources({});

    const cacheStub = {
      getDomainState: (domain: string) =>
        domain === "plans" || domain === "tasks" ? "ready" : "unloaded",
      getPlansIndex: () => [
        {
          _ulid: PLAN_ULID,
          slugs: [PLAN_SLUG],
          title: "Active Plan",
          status: "active",
          created_at: "2026-01-15T10:00:00Z",
          approved_at: "2026-01-16T12:00:00Z",
          completed_at: null,
          source_path: null,
          module_ref: null,
          derived_tasks: [],
          derived_specs: [],
        },
      ],
      getTaskIndex: () => [],
      getTaskDetail: () => null,
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

    ({ app } = createTestApp({
      getEntityCache: () => cacheStub as never,
    }));

    const response = await request("/api/plans");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meta.cache_status).toBe("ready");
    const plan = body.data.find((p: { _ulid: string }) => p._ulid === PLAN_ULID);
    expect(plan.resource_summary).toEqual({ count: 0, total_bytes: 0 });
  });
});

// ── Storage incompatibility envelope ─────────────────────────────────────────

describe("Plan Resource API — storage incompatibility", () => {
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-daemon-api-plan-resources-incompat-");
    initGitRepo(tempDir);
    // Set up a legacy kynetic 1.0 project — folder-backed plan storage is
    // required by the resource API contract.
    setupInlineFixtures(tempDir, {
      manifest: `kynetic: "1.0"
project:
  name: Legacy
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
tasks_file: project.tasks.yaml
`,
      tasksFile: "tasks: []\n",
      plans: `kynetic_plans: "1.0"\nplans: []\n`,
    });
    ({ app } = createTestApp());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
  it("GET /api/plans/:ref/resources on a legacy project returns the shared 409 envelope", async () => {
    const response = await request("/api/plans/@anything/resources");
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("entity_storage_incompatible");
    expect(typeof body.message).toBe("string");
    expect(body.domain).toBe("plans");
  });
});

// ── Resource-storage gate: folder-backed plans alone are not sufficient ──────

describe("Plan Resource API — missing resource_storage declaration", () => {
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-daemon-api-plan-resources-no-rs-");
    initGitRepo(tempDir);
    // Project declares folder-backed plan storage but does NOT declare
    // `resource_storage.format: entity_scoped`. The resource API contract
    // covers the entity-scoped local resource trait, so this state must
    // surface the structured 409 envelope instead of returning HTTP 200
    // with an empty resources list.
    setupInlineFixtures(tempDir, {
      manifest: `kynetic: "1.2"
task_storage:
  format: split
plan_storage:
  format: folder
review_storage:
  format: folder
project:
  name: Missing Resource Storage
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
`,
      plans: `kynetic_plans: "1.0"\nplans:\n  - _ulid: ${PLAN_ULID}\n    slugs:\n      - ${PLAN_SLUG}\n    title: Active Plan\n    status: active\n    derived_tasks: []\n    derived_specs: []\n    source_path: null\n    created_at: "2026-01-15T10:00:00Z"\n    approved_at: "2026-01-16T12:00:00Z"\n    completed_at: null\n`,
    });
    ({ app } = createTestApp());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("GET /api/plans/:ref/resources surfaces 409 entity_storage_incompatible with domain=resources", async () => {
    const response = await request(`/api/plans/${PLAN_REF}/resources`);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("entity_storage_incompatible");
    expect(typeof body.message).toBe("string");
    // The failing gate is the resource-storage gate, so the structured
    // envelope must point at resource_storage.format and the resources
    // domain — not the plans domain — so the client can surface a
    // resource-specific fix-up suggestion.
    expect(body.field).toBe("resource_storage.format");
    expect(body.domain).toBe("resources");
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
  it("GET /api/plans/:ref/resources/:id, POST, and DELETE also surface 409 entity_storage_incompatible", async () => {
    const getOne = await request(`/api/plans/${PLAN_REF}/resources/shot`);
    expect(getOne.status).toBe(409);
    expect((await getOne.json()).error).toBe("entity_storage_incompatible");

    const getBytes = await request(`/api/plans/${PLAN_REF}/resources/shot/bytes`);
    expect(getBytes.status).toBe(409);
    expect((await getBytes.json()).error).toBe("entity_storage_incompatible");

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1])], { type: "image/png" }), "x.png");
    form.append("id", "shot");
    form.append("path", "shot.png");
    const post = await request(`/api/plans/${PLAN_REF}/resources`, { method: "POST", body: form });
    expect(post.status).toBe(409);
    expect((await post.json()).error).toBe("entity_storage_incompatible");

    const del = await request(`/api/plans/${PLAN_REF}/resources/shot`, { method: "DELETE" });
    expect(del.status).toBe(409);
    expect((await del.json()).error).toBe("entity_storage_incompatible");
  });
});

// ── Upload safety: pre-existing symlinked resources/ root ────────────────────

describe("Plan Resource API — POST symlink safety", () => {
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-daemon-api-plan-resources-symlink-");
    initGitRepo(tempDir);
    setupFixtures(tempDir);
    execSync(`rm -rf ${path.join(tempDir, ".kspec", "plans")}`);
    writeFileSync(
      path.join(tempDir, ".kspec", "project.plans.yaml"),
      `kynetic_plans: "1.0"\nplans:\n  - _ulid: ${PLAN_ULID}\n    slugs:\n      - ${PLAN_SLUG}\n    title: Active Plan\n    status: active\n    derived_tasks: []\n    derived_specs: []\n    source_path: null\n    created_at: "2026-01-15T10:00:00Z"\n    approved_at: "2026-01-16T12:00:00Z"\n    completed_at: null\n`,
    );
    ({ app } = createTestApp());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  it("POST rejects uploads when the plan's resources/ directory is a symlink, without writing bytes outside the entity tree", async () => {
    // Seed the plan folder with metadata + plan.md (no real resources/ dir).
    const planDir = path.join(tempDir, ".kspec", "plans", PLAN_ULID);
    mkdirSync(planDir, { recursive: true });
    writeFileSync(
      path.join(planDir, "plan.yaml"),
      yamlStringify({
        _ulid: PLAN_ULID,
        slugs: [PLAN_SLUG],
        title: "Active Plan",
        status: "active",
        derived_tasks: [],
        derived_specs: [],
        source_path: null,
        created_at: "2026-01-15T10:00:00Z",
        approved_at: "2026-01-16T12:00:00Z",
        completed_at: null,
      }),
    );
    writeFileSync(path.join(planDir, "plan.md"), "# Active Plan\n");

    // Create an outside directory and point `<planDir>/resources` at it via
    // a symlink. This is the hostile state the route must catch BEFORE
    // materialising any bytes — otherwise fs.mkdir(..., {recursive:true})
    // would silently accept the symlink and fs.writeFile would land the
    // upload outside the entity tree.
    const outside = path.join(tempDir, "outside-target");
    mkdirSync(outside, { recursive: true });
    const fsSync = require("node:fs") as typeof import("node:fs");
    fsSync.symlinkSync(outside, path.join(planDir, "resources"));

    const blob = new Blob([new Uint8Array([7, 7, 7, 7])], { type: "image/png" });
    const form = new FormData();
    form.append("file", blob, "shot.png");
    form.append("id", "shot");
    form.append("path", "shot.png");
    const response = await request(`/api/plans/${PLAN_REF}/resources`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_resource_path");
    expect(body.message).toMatch(/symlink/i);

    // Critical: no upload bytes were written under the symlinked target.
    // The directory must remain empty — proving the path safety check fired
    // before fs.writeFile ran against the symlinked tree.
    const outsideEntries = fsSync.readdirSync(outside);
    expect(outsideEntries).toEqual([]);
  });
});
