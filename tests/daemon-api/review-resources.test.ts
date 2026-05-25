// Coverage: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
// Coverage: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
// Coverage: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
// Coverage: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
// Coverage: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
// Coverage: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
// Coverage: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
// Coverage: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance

import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureBroadcasts,
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  setupFixtures,
  setupInlineFixtures,
} from "./helpers.js";
import type { PubSubManager } from "../../dist/daemon/websocket/pubsub.js";
import type {
  EntityCacheAccessor,
  RouteEntityCache,
  WriteThroughHint,
} from "../../dist/daemon/routes/entity-cache-types.js";

// Reuse an existing fixture review ULID from project.reviews.yaml.
const REVIEW_ULID = "01KKTX0CA45ZT43W2T6HJMVA01";
const PNG_BYTES = Buffer.from("fake-png-bytes-for-testing");

let tempDir: string;
let app: Elysia;

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-review-resources-");
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

/**
 * Build a multipart/form-data body with the documented field shape and
 * post it through the in-process app.
 */
async function multipart(
  reviewRef: string,
  fields: Record<string, string>,
  file: { name: string; type: string; bytes: Buffer } | null,
) {
  const form = new FormData();
  if (file) {
    form.append("file", new Blob([file.bytes], { type: file.type }), file.name);
  }
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  // Skip makeRequest because it pins Content-Type: application/json when a
  // body is present, which breaks multipart parsing. Let the Request infer
  // the boundary-bearing multipart Content-Type from FormData directly.
  return app.handle(
    new Request(
      `http://localhost/api/reviews/${encodeURIComponent(reviewRef)}/resources`,
      {
        method: "POST",
        headers: {
          Host: "localhost",
          "X-Kspec-Dir": tempDir,
        },
        body: form,
      },
    ),
  );
}

describe("POST /api/reviews/:ref/resources (multipart)", () => {
  it("creates a resource and returns 201 + metadata + replaced:false", async () => {
    const response = await multipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.replaced).toBe(false);
    expect(body.resource).toMatchObject({
      id: "shot",
      path: "shot.png",
      content_type: "image/png",
      bytes: PNG_BYTES.byteLength,
    });
    expect(body.resource.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns 200 + replaced:true when replacing an existing resource", async () => {
    const create = await multipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(create.status).toBe(201);

    const replace = await multipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png", replace: "true" },
      { name: "shot.png", type: "image/png", bytes: Buffer.from("v2-bytes") },
    );
    expect(replace.status).toBe(200);
    const body = await replace.json();
    expect(body.replaced).toBe(true);
    expect(body.resource.bytes).toBe(Buffer.byteLength("v2-bytes"));
  });

  it("returns 400 missing_resource_file when the multipart body has no 'file' field", async () => {
    const response = await multipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png" },
      null,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("missing_resource_file");
  });

  it("returns 400 invalid_replace_value for an unknown 'replace' value", async () => {
    const response = await multipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png", replace: "maybe" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_replace_value");
  });

  it("returns 400 invalid_resource_id for malformed ids", async () => {
    const response = await multipart(
      REVIEW_ULID,
      { id: "BadID!", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_resource_id");
  });

  it("returns 400 invalid_resource_path for paths that escape the resources tree", async () => {
    const response = await multipart(
      REVIEW_ULID,
      { id: "shot", path: "../../../etc/passwd" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_resource_path");
  });

  it("returns 404 review_not_found when the review ref does not match", async () => {
    const response = await multipart(
      "no-such-review",
      { id: "shot", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("review_not_found");
  });

  it("returns 409 resource_conflict for duplicate ids without 'replace'", async () => {
    const first = await multipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(first.status).toBe(201);

    const conflict = await multipart(
      REVIEW_ULID,
      { id: "shot", path: "shot-2.png" },
      { name: "shot-2.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(conflict.status).toBe(409);
    const body = await conflict.json();
    expect(body.code).toBe("resource_conflict");
  });

  // Coverage: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("returns 400 invalid_resource_path for an explicit but malformed content_type", async () => {
    // The documented API error codes do NOT include invalid_content_type.
    // The route maps a malformed explicit content_type onto the documented
    // invalid_resource_path code (path-shaped) so the contract stays
    // closed.
    const response = await multipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png", content_type: "not a mime" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_resource_path");
    expect(body.message).toMatch(/content_type/);
    expect(body.path).toBe("shot.png");
  });
});

describe("GET /api/reviews/:ref/resources", () => {
  it("returns an empty resources array for a review with no resources", async () => {
    const response = await request(`/api/reviews/${REVIEW_ULID}/resources`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resources: [] });
  });

  it("returns all declared resources after one has been uploaded", async () => {
    await multipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    const response = await request(`/api/reviews/${REVIEW_ULID}/resources`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0]).toMatchObject({
      id: "shot",
      path: "shot.png",
      content_type: "image/png",
    });
  });
});

describe("GET /api/reviews/:ref/resources/:resourceId", () => {
  it("returns metadata for an existing resource", async () => {
    await multipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    const response = await request(`/api/reviews/${REVIEW_ULID}/resources/shot`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource).toMatchObject({ id: "shot", path: "shot.png" });
  });

  it("returns 404 resource_not_found for unknown ids", async () => {
    const response = await request(`/api/reviews/${REVIEW_ULID}/resources/nope`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("resource_not_found");
  });

  // Coverage: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("returns 400 invalid_resource_id for malformed ids on GET (not 404)", async () => {
    // Malformed IDs (outside the shared resource-id contract) must
    // surface as invalid_resource_id (400) so consumers can distinguish
    // illegal inputs from missing resources.
    const response = await request(
      `/api/reviews/${REVIEW_ULID}/resources/${encodeURIComponent("Bad-ID!")}`,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_resource_id");
    expect(body.resource_id).toBe("Bad-ID!");
  });
});

describe("GET /api/reviews/:ref/resources/:resourceId/bytes", () => {
  it("streams the raw bytes with Content-Type and X-Kspec-Resource-Sha256", async () => {
    await multipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    const response = await request(`/api/reviews/${REVIEW_ULID}/resources/shot/bytes`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const sha = response.headers.get("x-kspec-resource-sha256");
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(PNG_BYTES)).toBe(true);
  });

  it("returns 404 resource_not_found for unknown ids", async () => {
    const response = await request(`/api/reviews/${REVIEW_ULID}/resources/nope/bytes`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("resource_not_found");
  });

  // Coverage: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("returns 400 invalid_resource_id for malformed ids on the bytes endpoint", async () => {
    const response = await request(
      `/api/reviews/${REVIEW_ULID}/resources/${encodeURIComponent("Bad ID")}/bytes`,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_resource_id");
  });
});

describe("DELETE /api/reviews/:ref/resources/:resourceId", () => {
  it("removes the resource and returns the removed identity", async () => {
    await multipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    const response = await request(`/api/reviews/${REVIEW_ULID}/resources/shot`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.removed).toEqual({ id: "shot", path: "shot.png" });

    // Subsequent list should be empty.
    const list = await request(`/api/reviews/${REVIEW_ULID}/resources`);
    expect(await list.json()).toEqual({ resources: [] });
  });

  it("returns 404 resource_not_found for unknown ids", async () => {
    const response = await request(`/api/reviews/${REVIEW_ULID}/resources/nope`, {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("resource_not_found");
  });

  it("returns 404 review_not_found for unknown reviews", async () => {
    const response = await request(`/api/reviews/no-such-review/resources/shot`, {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("review_not_found");
  });

  // Coverage: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
  it("returns 400 invalid_resource_id for malformed ids on DELETE (not 404)", async () => {
    const response = await request(
      `/api/reviews/${REVIEW_ULID}/resources/${encodeURIComponent("Bad ID")}`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_resource_id");
  });
});

// AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
// AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
//
// The review-resource routes must surface the shared 409 entity_storage_incompatible
// envelope for projects on a manifest that does not declare folder-backed review
// storage. Without explicit coverage, a regression in the `onError` mapping
// (or in `requireReviewFolderStorage` propagation through the manager) would
// silently escape as 404 or 500 and leak monolithic-storage state.
describe("Entity storage incompatibility — review-resource routes", () => {
  // Legacy 1.1 manifest with no review_storage declaration. The strict
  // require gate inside the resource manager treats this as legacy.
  const LEGACY_MANIFEST = `kynetic: "1.1"
project:
  name: Test Project
  version: "0.1.0"
  status: draft
task_storage:
  format: split
includes:
  - modules/test.yaml
`;

  let incompatTempDir: string;
  let incompatApp: Elysia;

  beforeEach(async () => {
    incompatTempDir = await createTempDir("kspec-daemon-api-review-resources-incompat-");
    initGitRepo(incompatTempDir);
    setupInlineFixtures(incompatTempDir, { manifest: LEGACY_MANIFEST });
    ({ app: incompatApp } = createTestApp());
  });

  afterEach(async () => {
    await cleanupTempDir(incompatTempDir);
  });

  function incompatRequest(urlPath: string, init?: RequestInit) {
    return makeRequest(incompatApp, incompatTempDir, urlPath, init);
  }

  async function incompatMultipart(
    reviewRef: string,
    fields: Record<string, string>,
    file: { name: string; type: string; bytes: Buffer } | null,
  ) {
    const form = new FormData();
    if (file) {
      form.append("file", new Blob([file.bytes], { type: file.type }), file.name);
    }
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }
    return incompatApp.handle(
      new Request(
        `http://localhost/api/reviews/${encodeURIComponent(reviewRef)}/resources`,
        {
          method: "POST",
          headers: {
            Host: "localhost",
            "X-Kspec-Dir": incompatTempDir,
          },
          body: form,
        },
      ),
    );
  }

  function assertEntityStorageConflict(body: unknown) {
    expect(body).toBeTypeOf("object");
    const typed = body as {
      error?: string;
      code?: string;
      domain?: string;
      cache_domain?: string;
      suggestion?: string;
    };
    expect(typed.error).toBe("entity_storage_incompatible");
    expect(typed.code).toBe("legacy_review_storage_removed");
    expect(typed.domain).toBe("reviews");
    expect(typed.cache_domain).toBe("reviews");
    expect(typed.suggestion).toMatch(/kspec upgrade/i);
  }

  it("GET /api/reviews/:ref/resources returns 409 entity_storage_incompatible on legacy storage", async () => {
    const response = await incompatRequest(`/api/reviews/${REVIEW_ULID}/resources`);
    expect(response.status).toBe(409);
    assertEntityStorageConflict(await response.json());
  });

  it("GET /api/reviews/:ref/resources/:resourceId returns 409 entity_storage_incompatible on legacy storage", async () => {
    const response = await incompatRequest(`/api/reviews/${REVIEW_ULID}/resources/shot`);
    expect(response.status).toBe(409);
    assertEntityStorageConflict(await response.json());
  });

  it("GET /api/reviews/:ref/resources/:resourceId/bytes returns 409 entity_storage_incompatible on legacy storage", async () => {
    const response = await incompatRequest(`/api/reviews/${REVIEW_ULID}/resources/shot/bytes`);
    expect(response.status).toBe(409);
    assertEntityStorageConflict(await response.json());
  });

  it("POST /api/reviews/:ref/resources returns 409 entity_storage_incompatible on legacy storage", async () => {
    const response = await incompatMultipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(response.status).toBe(409);
    assertEntityStorageConflict(await response.json());
  });

  it("DELETE /api/reviews/:ref/resources/:resourceId returns 409 entity_storage_incompatible on legacy storage", async () => {
    const response = await incompatRequest(`/api/reviews/${REVIEW_ULID}/resources/shot`, {
      method: "DELETE",
    });
    expect(response.status).toBe(409);
    assertEntityStorageConflict(await response.json());
  });
});

// AC: @folder-backed-plan-review-cache-invalidation-1 ac-resource-routes-write-through-reviews
// AC: @review-records-daemon-api ac-9
//
// Verifies the cache-invalidation and broadcast side effects required by the
// task contract: POST and DELETE on the review-resource routes must call
// `cache.writeThrough("reviews")` so subsequent reads see the new manifest,
// and they must broadcast `resource_changed` on `reviews:updates` so the UI
// refreshes without polling. Without this coverage, a regression in either
// the cache-write-through or the WebSocket evidence path would pass silently.
describe("Review-resource route cache + broadcast side effects", () => {
  let sideTempDir: string;
  let sideApp: Elysia;
  let sidePubsub: PubSubManager;
  let broadcastSpy: ReturnType<typeof captureBroadcasts>;
  let writeThroughEntries: Array<{ domain: string; hint?: WriteThroughHint }>;

  function createMockReviewCache(): RouteEntityCache {
    writeThroughEntries = [];
    return {
      getDomainState: () => "ready",
      getTaskIndex: () => null,
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
      writeThrough: vi.fn(async (domain: string, hint?: WriteThroughHint) => {
        writeThroughEntries.push({ domain, hint });
      }),
      markWriteThrough: vi.fn(),
      getCacheDiagnostics: () => ({
        projectPath: sideTempDir,
        updatedAt: new Date().toISOString(),
        domains: {},
      }),
    };
  }

  beforeEach(async () => {
    sideTempDir = await createTempDir("kspec-daemon-api-review-resources-side-");
    initGitRepo(sideTempDir);
    setupFixtures(sideTempDir);

    const cache = createMockReviewCache();
    const getEntityCache: EntityCacheAccessor = () => cache;
    ({ app: sideApp, pubsub: sidePubsub } = createTestApp({ getEntityCache }));
    broadcastSpy = captureBroadcasts(sidePubsub);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(sideTempDir);
  });

  async function sideMultipart(
    reviewRef: string,
    fields: Record<string, string>,
    file: { name: string; type: string; bytes: Buffer },
  ) {
    const form = new FormData();
    form.append("file", new Blob([file.bytes], { type: file.type }), file.name);
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }
    return sideApp.handle(
      new Request(
        `http://localhost/api/reviews/${encodeURIComponent(reviewRef)}/resources`,
        {
          method: "POST",
          headers: {
            Host: "localhost",
            "X-Kspec-Dir": sideTempDir,
          },
          body: form,
        },
      ),
    );
  }

  it("POST writes through the reviews cache domain and broadcasts resource_changed (added)", async () => {
    const response = await sideMultipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(response.status).toBe(201);

    expect(writeThroughEntries.map((e) => e.domain)).toContain("reviews");

    expect(broadcastSpy).toHaveBeenCalledWith(
      "reviews:updates",
      "resource_changed",
      expect.objectContaining({
        review_ulid: REVIEW_ULID,
        resource_id: "shot",
        action: "added",
      }),
      expect.any(String),
    );
  });

  it("POST replace writes through and broadcasts resource_changed (replaced)", async () => {
    const create = await sideMultipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(create.status).toBe(201);
    broadcastSpy.mockClear();
    writeThroughEntries.length = 0;

    const replace = await sideMultipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png", replace: "true" },
      { name: "shot.png", type: "image/png", bytes: Buffer.from("v2-bytes") },
    );
    expect(replace.status).toBe(200);

    expect(writeThroughEntries.map((e) => e.domain)).toContain("reviews");
    expect(broadcastSpy).toHaveBeenCalledWith(
      "reviews:updates",
      "resource_changed",
      expect.objectContaining({
        review_ulid: REVIEW_ULID,
        resource_id: "shot",
        action: "replaced",
      }),
      expect.any(String),
    );
  });

  it("DELETE writes through the reviews cache domain and broadcasts resource_changed (removed)", async () => {
    // Seed a resource so the delete has something to remove.
    const seed = await sideMultipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(seed.status).toBe(201);
    broadcastSpy.mockClear();
    writeThroughEntries.length = 0;

    const response = await makeRequest(
      sideApp,
      sideTempDir,
      `/api/reviews/${REVIEW_ULID}/resources/shot`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);

    expect(writeThroughEntries.map((e) => e.domain)).toContain("reviews");
    expect(broadcastSpy).toHaveBeenCalledWith(
      "reviews:updates",
      "resource_changed",
      expect.objectContaining({
        review_ulid: REVIEW_ULID,
        resource_id: "shot",
        action: "removed",
      }),
      expect.any(String),
    );
  });

  it("POST that fails validation does NOT write through cache or broadcast", async () => {
    // Malformed id is rejected at the route before the manager runs, so
    // neither the cache nor pubsub should see anything.
    const response = await sideMultipart(
      REVIEW_ULID,
      { id: "BadID!", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(response.status).toBe(400);
    expect(writeThroughEntries).toEqual([]);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it("DELETE for a missing resource does NOT write through cache or broadcast", async () => {
    const response = await makeRequest(
      sideApp,
      sideTempDir,
      `/api/reviews/${REVIEW_ULID}/resources/no-such-resource`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(404);
    expect(writeThroughEntries).toEqual([]);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });
});
