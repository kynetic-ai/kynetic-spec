// Coverage: @review-records-daemon-api ac-1
// Coverage: @review-records-daemon-api ac-2
// Coverage: @review-records-daemon-api ac-3
// Coverage: @review-records-daemon-api ac-4
// Coverage: @review-records-daemon-api ac-5 — N/A: thread pagination not required for review thread operations
// Coverage: @review-records-daemon-api ac-6 — N/A: bulk thread operations not in scope

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

let tempDir: string;
let app: Elysia;

// Fixture ULIDs from tests/e2e/fixtures/project.reviews.yaml
const OPEN_REVIEW_ULID = "01KKTX0CA45ZT43W2T6HJMVA01";
const _DRAFT_REVIEW_ULID = "01KKTX9CA45ZT43W2T6HJMVA10";
const BLOCKER_THREAD_ULID = "01KKTX1CA45ZT43W2T6HJMVA02";
const _NIT_THREAD_ULID = "01KKTX3CA45ZT43W2T6HJMVA04";
const RESOLVED_THREAD_ULID = "01KKTX5CA45ZT43W2T6HJMVA06";

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-reviews-threads-");
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

describe("POST /api/reviews/:id/comments", () => {
  it("creates a blocker thread", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "This is a blocker.", kind: "blocker" }),
    });
    expect(response.status).toBe(200);
    const thread = await response.json();
    expect(thread).toHaveProperty("_ulid");
    expect(thread.kind).toBe("blocker");
    expect(thread.entries[0].body).toBe("This is a blocker.");
  });

  it("creates a nit thread (default kind)", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "Minor nit here." }),
    });
    expect(response.status).toBe(200);
    const thread = await response.json();
    expect(thread.kind).toBe("nit");
  });

  it("creates a thread with a code anchor", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: "Check this line.",
        kind: "blocker",
        anchor: {
          type: "code",
          path: "src/index.ts",
          side: "head",
          line_start: 10,
          line_end: 12,
          commit: "abc1234",
        },
      }),
    });
    expect(response.status).toBe(200);
    const thread = await response.json();
    expect(thread.anchor).toMatchObject({
      type: "code",
      path: "src/index.ts",
      side: "head",
      line_start: 10,
      line_end: 12,
    });
  });

  it("creates a thread with a structured anchor", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: "Check this spec item.",
        kind: "nit",
        anchor: {
          type: "structured",
          ref: "@some-spec-item",
        },
      }),
    });
    expect(response.status).toBe(200);
    const thread = await response.json();
    expect(thread.anchor).toMatchObject({
      type: "structured",
      ref: "@some-spec-item",
    });
  });

  // AC: @review-spec-ac-anchors ac-typed-anchor-stored
  it("creates a thread with a typed spec AC anchor", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: "Check this acceptance criterion.",
        kind: "nit",
        anchor: {
          type: "spec_ac",
          spec_ref: "@some-spec-item",
          criterion_id: "ac-1",
        },
      }),
    });
    expect(response.status).toBe(200);
    const thread = await response.json();
    expect(thread.anchor).toEqual({
      type: "spec_ac",
      spec_ref: "@some-spec-item",
      criterion_id: "ac-1",
    });
  });

  it("persists the new thread on the review", async () => {
    const createResponse = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "Persist check.", kind: "nit" }),
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();

    const getResponse = await request(`/api/reviews/${OPEN_REVIEW_ULID}`);
    expect(getResponse.status).toBe(200);
    const { data: review } = await getResponse.json();
    const found = review.threads.find((t: { _ulid: string }) => t._ulid === created._ulid);
    expect(found).toBeDefined();
    expect(found.entries[0].body).toBe("Persist check.");
  });

  it("returns 400 when body is missing", async () => {
    // Elysia schema validation (missing required 'body' field) is
    // normalized to 400 by the onError handler.
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for empty body string", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "" }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for whitespace-only body", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "   " }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid kind", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "Some comment.", kind: "invalid_kind" }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 404 for unknown review", async () => {
    const response = await request("/api/reviews/01AAAAAAAAAAAAAAAAAAAAAA99/comments", {
      method: "POST",
      body: JSON.stringify({ body: "This won't work.", kind: "nit" }),
    });
    expect(response.status).toBe(404);
  });

  it("returns 400 for invalid anchor type", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: "Bad anchor.",
        kind: "nit",
        anchor: { type: "unknown_type" },
      }),
    });
    expect(response.status).toBe(400);
  });

  // AC: @review-spec-ac-anchors ac-anchor-field-validation
  it("returns 400 for invalid spec AC anchor fields without storing a thread", async () => {
    const beforeResponse = await request(`/api/reviews/${OPEN_REVIEW_ULID}`);
    expect(beforeResponse.status).toBe(200);
    const { data: beforeReview } = await beforeResponse.json();
    const beforeCount = beforeReview.threads.length;

    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: "Bad spec AC anchor.",
        kind: "nit",
        anchor: {
          type: "spec_ac",
          spec_ref: "some-spec-item",
          criterion_id: "criterion-1",
        },
      }),
    });
    expect(response.status).toBe(400);
    const error = await response.json();
    expect(JSON.stringify(error)).toContain("anchor.spec_ref");

    const afterResponse = await request(`/api/reviews/${OPEN_REVIEW_ULID}`);
    expect(afterResponse.status).toBe(200);
    const { data: afterReview } = await afterResponse.json();
    expect(afterReview.threads).toHaveLength(beforeCount);
  });

  it("returns 400 for invalid code anchor side", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: "Bad side.",
        kind: "nit",
        anchor: {
          type: "code",
          path: "src/index.ts",
          side: "neither",
          line_start: 1,
          line_end: 1,
          commit: "abc123",
        },
      }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for negative line_start", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: "Negative line.",
        kind: "nit",
        anchor: {
          type: "code",
          path: "src/index.ts",
          side: "head",
          line_start: -1,
          line_end: 5,
          commit: "abc123",
        },
      }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for float line_end", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: "Float line end.",
        kind: "nit",
        anchor: {
          type: "code",
          path: "src/index.ts",
          side: "head",
          line_start: 1,
          line_end: 2.5,
          commit: "abc123",
        },
      }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 when line_end is less than line_start", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: "Bad range.",
        kind: "nit",
        anchor: {
          type: "code",
          path: "src/index.ts",
          side: "head",
          line_start: 10,
          line_end: 5,
          commit: "abc123",
        },
      }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for empty structured anchor ref", async () => {
    // A structured anchor with only ref="" has no meaningful field,
    // so the route rejects it.
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: "Empty ref.",
        kind: "nit",
        anchor: { type: "structured", ref: "" },
      }),
    });
    expect(response.status).toBe(400);
  });
});

describe("POST /api/reviews/:id/comments/:threadId/replies", () => {
  it("adds a reply to an existing thread", async () => {
    const response = await request(
      `/api/reviews/${OPEN_REVIEW_ULID}/comments/${BLOCKER_THREAD_ULID}/replies`,
      {
        method: "POST",
        body: JSON.stringify({ body: "Acknowledged, will fix." }),
      },
    );
    expect(response.status).toBe(200);
    // Route returns the full updated thread
    const thread = await response.json();
    expect(thread).toHaveProperty("_ulid");
    expect(thread._ulid).toBe(BLOCKER_THREAD_ULID);
    const lastEntry = thread.entries[thread.entries.length - 1];
    expect(lastEntry.body).toBe("Acknowledged, will fix.");
  });

  it("persists the reply on the thread", async () => {
    const replyResponse = await request(
      `/api/reviews/${OPEN_REVIEW_ULID}/comments/${BLOCKER_THREAD_ULID}/replies`,
      {
        method: "POST",
        body: JSON.stringify({ body: "Persist reply check." }),
      },
    );
    expect(replyResponse.status).toBe(200);

    const getResponse = await request(`/api/reviews/${OPEN_REVIEW_ULID}`);
    expect(getResponse.status).toBe(200);
    const { data: review } = await getResponse.json();
    const thread = review.threads.find((t: { _ulid: string }) => t._ulid === BLOCKER_THREAD_ULID);
    expect(thread).toBeDefined();
    const hasReply = thread.entries.some(
      (e: { body: string }) => e.body === "Persist reply check.",
    );
    expect(hasReply).toBe(true);
  });

  it("returns 404 for unknown thread", async () => {
    const response = await request(
      `/api/reviews/${OPEN_REVIEW_ULID}/comments/01AAAAAAAAAAAAAAAAAAAAAA99/replies`,
      {
        method: "POST",
        body: JSON.stringify({ body: "Won't work." }),
      },
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 for unknown review", async () => {
    const response = await request(
      `/api/reviews/01AAAAAAAAAAAAAAAAAAAAAA99/comments/${BLOCKER_THREAD_ULID}/replies`,
      {
        method: "POST",
        body: JSON.stringify({ body: "Won't work." }),
      },
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 for empty body", async () => {
    const response = await request(
      `/api/reviews/${OPEN_REVIEW_ULID}/comments/${BLOCKER_THREAD_ULID}/replies`,
      {
        method: "POST",
        body: JSON.stringify({ body: "" }),
      },
    );
    expect(response.status).toBe(400);
  });
});

describe("PATCH /api/reviews/:id/comments/:threadId/resolve", () => {
  it("resolves an open thread", async () => {
    const response = await request(
      `/api/reviews/${OPEN_REVIEW_ULID}/comments/${BLOCKER_THREAD_ULID}/resolve`,
      { method: "PATCH" },
    );
    expect(response.status).toBe(200);
    const thread = await response.json();
    expect(thread.resolved_at).toBeDefined();
    expect(thread.resolved_at).not.toBeNull();
  });

  it("returns 409 when thread is already resolved", async () => {
    const response = await request(
      `/api/reviews/${OPEN_REVIEW_ULID}/comments/${RESOLVED_THREAD_ULID}/resolve`,
      { method: "PATCH" },
    );
    expect(response.status).toBe(409);
  });

  it("returns 404 for unknown thread", async () => {
    const response = await request(
      `/api/reviews/${OPEN_REVIEW_ULID}/comments/01AAAAAAAAAAAAAAAAAAAAAA99/resolve`,
      { method: "PATCH" },
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 for unknown review", async () => {
    const response = await request(
      `/api/reviews/01AAAAAAAAAAAAAAAAAAAAAA99/comments/${BLOCKER_THREAD_ULID}/resolve`,
      { method: "PATCH" },
    );
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/reviews/:id/comments/:threadId/reopen", () => {
  it("reopens a resolved thread", async () => {
    const response = await request(
      `/api/reviews/${OPEN_REVIEW_ULID}/comments/${RESOLVED_THREAD_ULID}/reopen`,
      { method: "PATCH" },
    );
    expect(response.status).toBe(200);
    const thread = await response.json();
    expect(thread.resolved_at).toBeNull();
  });

  it("returns 409 when thread is not resolved", async () => {
    const response = await request(
      `/api/reviews/${OPEN_REVIEW_ULID}/comments/${BLOCKER_THREAD_ULID}/reopen`,
      { method: "PATCH" },
    );
    expect(response.status).toBe(409);
  });

  it("returns 404 for unknown thread", async () => {
    const response = await request(
      `/api/reviews/${OPEN_REVIEW_ULID}/comments/01AAAAAAAAAAAAAAAAAAAAAA99/reopen`,
      { method: "PATCH" },
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 for unknown review", async () => {
    const response = await request(
      `/api/reviews/01AAAAAAAAAAAAAAAAAAAAAA99/comments/${RESOLVED_THREAD_ULID}/reopen`,
      { method: "PATCH" },
    );
    expect(response.status).toBe(404);
  });
});
