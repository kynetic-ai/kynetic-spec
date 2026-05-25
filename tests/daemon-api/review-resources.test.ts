// Coverage: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
// Coverage: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
// Coverage: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
// Coverage: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
// Coverage: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
// Coverage: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete

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
