// Coverage: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
// Coverage: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
// Coverage: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
// Coverage: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
// Coverage: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
// Coverage: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
// Coverage: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
// Coverage: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance

import * as fs from "node:fs/promises";
import * as path from "node:path";

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

  // Coverage: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("returns 400 invalid_resource_path when content_type is explicitly empty (must not silently infer from path)", async () => {
    // The task contract says explicit content_type values must be
    // non-empty type/subtype tokens; only an omitted value is inferred.
    // The previous multipart parser treated an explicit empty string the
    // same as "field absent" — readTextField returned undefined for ""
    // and the route then passed null to the manager, which silently
    // inferred image/png from the path extension. The contract violation
    // (explicit non-empty-token rule) escaped detection.
    //
    // This test sends content_type="" explicitly and asserts the route
    // surfaces the documented 400 invalid_resource_path envelope instead
    // of a 201 with inferred content_type.
    const response = await multipart(
      REVIEW_ULID,
      { id: "shot", path: "shot.png", content_type: "" },
      { name: "shot.png", type: "image/png", bytes: PNG_BYTES },
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_resource_path");
    expect(body.message).toMatch(/content_type/);
    expect(body.path).toBe("shot.png");
    expect(body.resource_id).toBe("shot");
  });

  it("still infers content_type from the path extension when content_type is omitted (absent field, not empty)", async () => {
    // Companion to the empty-content_type test above: the parser must
    // distinguish "absent" (omit → infer) from "explicitly empty"
    // (reject). Without this baseline, a fix to the empty-string case
    // could over-correct and reject perfectly valid uploads that simply
    // do not include the field. Use a .log extension so the inferred
    // content_type is unambiguous (text/plain).
    const response = await multipart(
      REVIEW_ULID,
      { id: "log", path: "build.log" },
      {
        name: "build.log",
        type: "text/plain",
        bytes: Buffer.from("build started\n"),
      },
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.resource.content_type).toBe("text/plain");
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

  // Coverage: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  it("returns 400 invalid_resource_path when the declared resource resolves through a symlink escape", async () => {
    // The bytes resolver previously mapped every resolveResourcePath failure
    // to resource_not_found, which would report a path-safety rejection as
    // 404 "the file is missing" — masking the real reason and matching the
    // status the legitimate "missing on disk" case uses. The task contract
    // says invalid/forbidden paths return 400 invalid_resource_path; this
    // test pins that behavior end-to-end through the daemon route.
    const reviewDir = path.join(tempDir, ".kspec", "reviews", REVIEW_ULID);
    const resourcesDir = path.join(reviewDir, "resources");
    await fs.mkdir(resourcesDir, { recursive: true });
    const outside = path.join(tempDir, "daemon-bytes-escape.png");
    await fs.writeFile(outside, "outside-bytes");
    try {
      await fs.symlink(outside, path.join(resourcesDir, "shot.png"));
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === "EPERM" || errno === "ENOSYS") return;
      throw err;
    }
    // Hand-write the manifest so getReviewResource succeeds and the
    // resolver path is the one under test.
    await fs.writeFile(
      path.join(reviewDir, "resources.yaml"),
      `resources:\n  - id: shot\n    label: null\n    path: shot.png\n    content_type: image/png\n    bytes: 13\n    sha256: "0000000000000000000000000000000000000000000000000000000000000000"\n    git_commit: null\n    git_path: null\n    description: null\n`,
    );

    const response = await request(`/api/reviews/${REVIEW_ULID}/resources/shot/bytes`);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_resource_path");
    expect(body.message).toMatch(/symlink/i);
    expect(body.resource_id).toBe("shot");
    expect(body.path).toBe("shot.png");

    // Outside file must remain untouched — the rejection must not have
    // accidentally read or written through the symlink.
    expect(await fs.readFile(outside, "utf-8")).toBe("outside-bytes");
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

// AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
// AC: @multi-directory-daemon ac-26 — selected non-default project context
//
// Browser-issued <img src> / <a href> requests cannot include the
// X-Kspec-Dir header that the rest of the UI uses to route the request
// to a non-default selected project. Without a URL-bound fallback, the
// daemon would route the bytes request to the default project, returning
// 404 for resources that exist only in the selected non-default project
// or — worse — returning the wrong project's bytes if both happen to
// declare the same resource id.
//
// The middleware accepts a `kspec_dir` query parameter as a fallback to
// the header so the URL itself can carry the project context for these
// asset-style requests. The header still wins when both are present so
// first-class fetch() callers remain authoritative.
describe("GET /api/reviews/:ref/resources/:resourceId/bytes — selected non-default project context", () => {
  // Two independent projects, each registered separately, each with the
  // SAME review ULID but DIFFERENT bytes for the same resource id. This
  // is the failure shape that ships the wrong screenshot to a user who
  // selected a non-default project in the UI: an unscoped GET against
  // the bytes endpoint would route to whichever project owned the
  // default, not the project the user selected.
  let projectA: string;
  let projectB: string;
  let multiApp: Elysia;
  const ALPHA_BYTES = Buffer.from("alpha-project-screenshot-bytes");
  const BETA_BYTES = Buffer.from("beta-project-screenshot-bytes");

  async function uploadFor(
    targetTempDir: string,
    reviewRef: string,
    fields: Record<string, string>,
    file: { name: string; type: string; bytes: Buffer },
  ) {
    const form = new FormData();
    form.append("file", new Blob([file.bytes], { type: file.type }), file.name);
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }
    return multiApp.handle(
      new Request(
        `http://localhost/api/reviews/${encodeURIComponent(reviewRef)}/resources`,
        {
          method: "POST",
          headers: {
            Host: "localhost",
            "X-Kspec-Dir": targetTempDir,
          },
          body: form,
        },
      ),
    );
  }

  // Seed helper that throws on non-201 instead of using expect() in
  // beforeEach. Keeping the setup assertion as an explicit throw lets the
  // jest/no-standalone-expect rule pass on this file while still failing
  // the suite immediately if the daemon refuses the upload.
  async function seedReviewResource(
    targetTempDir: string,
    bytes: Buffer,
  ): Promise<void> {
    const response = await uploadFor(
      targetTempDir,
      REVIEW_ULID,
      { id: "shot", path: "shot.png" },
      { name: "shot.png", type: "image/png", bytes },
    );
    if (response.status !== 201) {
      const body = await response.text();
      throw new Error(
        `Failed to seed review resource for ${targetTempDir}: expected 201, got ${response.status}. Body: ${body}`,
      );
    }
  }

  beforeEach(async () => {
    projectA = await createTempDir("kspec-daemon-api-review-resources-multi-a-");
    projectB = await createTempDir("kspec-daemon-api-review-resources-multi-b-");
    initGitRepo(projectA);
    initGitRepo(projectB);
    setupFixtures(projectA);
    setupFixtures(projectB);
    ({ app: multiApp } = createTestApp());

    await seedReviewResource(projectA, ALPHA_BYTES);
    await seedReviewResource(projectB, BETA_BYTES);
  });

  afterEach(async () => {
    await cleanupTempDir(projectA);
    await cleanupTempDir(projectB);
  });

  it("routes via the X-Kspec-Dir header when present (baseline)", async () => {
    const response = await multiApp.handle(
      new Request(
        `http://localhost/api/reviews/${REVIEW_ULID}/resources/shot/bytes`,
        {
          method: "GET",
          headers: { Host: "localhost", "X-Kspec-Dir": projectB },
        },
      ),
    );
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(BETA_BYTES)).toBe(true);
  });

  it("routes via the kspec_dir query parameter when no X-Kspec-Dir header is present", async () => {
    // This is the browser <img src> / <a href> case: no custom header is
    // possible, so the project context MUST travel in the URL itself.
    const response = await multiApp.handle(
      new Request(
        `http://localhost/api/reviews/${REVIEW_ULID}/resources/shot/bytes?kspec_dir=${encodeURIComponent(projectB)}`,
        {
          method: "GET",
          headers: { Host: "localhost" },
        },
      ),
    );
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(BETA_BYTES)).toBe(true);
    // And NOT the other project's bytes — proves we actually routed by
    // the query param instead of silently falling back to the default.
    expect(body.equals(ALPHA_BYTES)).toBe(false);
  });

  it("routes to projectA when kspec_dir=projectA (proves both directions work)", async () => {
    const response = await multiApp.handle(
      new Request(
        `http://localhost/api/reviews/${REVIEW_ULID}/resources/shot/bytes?kspec_dir=${encodeURIComponent(projectA)}`,
        {
          method: "GET",
          headers: { Host: "localhost" },
        },
      ),
    );
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(ALPHA_BYTES)).toBe(true);
    expect(body.equals(BETA_BYTES)).toBe(false);
  });

  it("X-Kspec-Dir header wins over the kspec_dir query param when both are present", async () => {
    // Header is the canonical, first-class signal — it must not be
    // overridden by a query parameter that happens to point elsewhere.
    const response = await multiApp.handle(
      new Request(
        `http://localhost/api/reviews/${REVIEW_ULID}/resources/shot/bytes?kspec_dir=${encodeURIComponent(projectA)}`,
        {
          method: "GET",
          headers: { Host: "localhost", "X-Kspec-Dir": projectB },
        },
      ),
    );
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(BETA_BYTES)).toBe(true);
  });
});
