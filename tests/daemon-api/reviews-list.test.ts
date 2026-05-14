// AC: @review-records-daemon-api ac-1 — GET /api/reviews returns paginated list with filtering
// AC: @review-records-daemon-api ac-2 — GET /api/reviews/:id returns full review detail
// AC: @review-records-daemon-api ac-10 — invalid data returns 400 with actionable error (404 case)
// AC: @trait-json-output ac-1 — N/A: daemon API endpoints always return JSON, no --json flag
// AC: @trait-json-output ac-2 — N/A: daemon API endpoints always return JSON, no --json flag
// AC: @trait-json-output ac-3 — N/A: daemon API endpoints always return JSON, no --json flag
// AC: @trait-json-output ac-4 — N/A: daemon API endpoints always return JSON, no --json flag
// AC: @trait-json-output ac-5 — N/A: daemon API endpoints always return JSON, no --json flag
// AC: @trait-json-output ac-6 — N/A: daemon API endpoints always return JSON, no --json flag
// AC: @trait-error-guidance ac-1 — N/A: error guidance is a CLI trait, not applicable to daemon API
// AC: @trait-error-guidance ac-2 — N/A: error guidance is a CLI trait, not applicable to daemon API
// AC: @trait-error-guidance ac-3 — N/A: error guidance is a CLI trait, not applicable to daemon API
// AC: @trait-error-guidance ac-4 — N/A: error guidance is a CLI trait, not applicable to daemon API
// AC: @trait-error-guidance ac-5 — N/A: error guidance is a CLI trait, not applicable to daemon API
// AC: @trait-error-guidance ac-6 — N/A: error guidance is a CLI trait, not applicable to daemon API
// AC: @trait-localhost-security ac-loopback-default — N/A: review-list route handler tests do not invoke app.listen(); default loopback bind is exercised in tests/cli-serve.test.ts (daemon child startup).
// AC: @trait-localhost-security ac-loopback-rejects-nonlocal — N/A: localhostOnly middleware is a server-level concern, exercised in tests/daemon-api/server.test.ts and tests/daemon-server.test.ts.
// AC: @trait-localhost-security ac-external-host-explicit — N/A: explicit non-loopback bind is exercised in tests/cli-serve.test.ts where daemon.host is configured.
// AC: @trait-localhost-security ac-external-warning — N/A: external-bind warning is surfaced from the CLI lifecycle path and exercised in tests/cli-serve.test.ts.
// AC: @trait-websocket-protocol ac-1 — N/A: WebSocket lifecycle not tested in review list API tests
// AC: @trait-websocket-protocol ac-2 — N/A: WebSocket subscribe not tested in review list API tests
// AC: @trait-websocket-protocol ac-3 — N/A: WebSocket broadcast not tested in review list API tests
// AC: @trait-websocket-protocol ac-4 — N/A: WebSocket heartbeat not tested in review list API tests
// AC: @trait-websocket-protocol ac-5 — N/A: WebSocket ping/pong not tested in review list API tests
// AC: @trait-websocket-protocol ac-6 — N/A: WebSocket backpressure not tested in review list API tests
// AC: @trait-websocket-protocol ac-7 — N/A: WebSocket close codes not tested in review list API tests
// AC: @trait-websocket-protocol ac-8 — N/A: WebSocket reconnection not tested in review list API tests

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
const DRAFT_REVIEW_ULID = "01KKTX9CA45ZT43W2T6HJMVA10";
const SIBLING_REVIEW_ULID = "01KKV0TCA45ZT43W2T6HJMVB03";
const CODE_REVIEW_ULID = "01KKV1ACA45ZT43W2T6HJMVB10";
const CODE_REVIEW_SIBLING_ULID = "01KKV1BCA45ZT43W2T6HJMVB11";
const PENDING_REVIEW_TASK_ULID = "01KG0RRDCC9N4YGP991WD7XSPR";

// Status filter for "all" statuses — the route does not support a literal "all" value;
// list each lifecycle_state explicitly.
const STATUS_ALL = "status=draft&status=open&status=closed&status=archived";

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-reviews-list-");
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

describe("Review List API (GET /api/reviews)", () => {
  it("returns paginated list shape", async () => {
    const response = await request("/api/reviews");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("meta");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toHaveProperty("total");
    expect(body.meta).toHaveProperty("offset");
    expect(body.meta).toHaveProperty("limit");
  });

  it("review summary includes all required fields", async () => {
    const response = await request("/api/reviews");
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.length).toBeGreaterThan(0);
    const review = data[0];
    expect(review).toHaveProperty("_ulid");
    expect(review).toHaveProperty("title");
    expect(review).toHaveProperty("lifecycle_state");
    expect(review).toHaveProperty("disposition");
    expect(review).toHaveProperty("subject_type");
    expect(review).toHaveProperty("author");
    expect(review).toHaveProperty("thread_count");
    expect(review).toHaveProperty("unresolved_blocker_count");
    expect(review).toHaveProperty("check_count");
    expect(review).toHaveProperty("verdict_count");
    expect(review).toHaveProperty("created_at");
  });

  it("defaults to status=open", async () => {
    const response = await request("/api/reviews");
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.length).toBeGreaterThan(0);
    for (const review of data) {
      expect(review.lifecycle_state).toBe("open");
    }
  });

  it("filters by status=draft", async () => {
    const response = await request("/api/reviews?status=draft");
    expect(response.status).toBe(200);
    const { data } = await response.json();
    for (const review of data) {
      expect(review.lifecycle_state).toBe("draft");
    }
    const ulids = data.map((r: { _ulid: string }) => r._ulid);
    expect(ulids).toContain(DRAFT_REVIEW_ULID);
  });

  it("filters by status=all returns all statuses", async () => {
    const response = await request(`/api/reviews?${STATUS_ALL}`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    const statuses = new Set(data.map((r: { lifecycle_state: string }) => r.lifecycle_state));
    expect(statuses.size).toBeGreaterThan(1);
  });

  it("filters by disposition", async () => {
    const response = await request(`/api/reviews?${STATUS_ALL}&disposition=changes_requested`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    for (const review of data) {
      expect(review.disposition).toBe("changes_requested");
    }
  });

  it("filters by subject_type", async () => {
    const response = await request(`/api/reviews?${STATUS_ALL}&subject_type=task`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.length).toBeGreaterThan(0);
    for (const review of data) {
      expect(review.subject_type).toBe("task");
    }
  });

  it("returns empty results for unmatched filter", async () => {
    // Default status is open; no open reviews have disposition=approved
    const response = await request("/api/reviews?disposition=approved");
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data).toEqual([]);
  });

  it("sorts descending by default (newest first)", async () => {
    const response = await request(`/api/reviews?${STATUS_ALL}`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    if (data.length >= 2) {
      const dates = data.map((r: { created_at: string }) => new Date(r.created_at).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
      }
    }
  });

  it("sorts ascending when sort_dir=asc", async () => {
    const response = await request(`/api/reviews?${STATUS_ALL}&sort_dir=asc`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    if (data.length >= 2) {
      const dates = data.map((r: { created_at: string }) => new Date(r.created_at).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeLessThanOrEqual(dates[i]);
      }
    }
  });

  it("paginates results", async () => {
    const response = await request(`/api/reviews?${STATUS_ALL}&limit=2&offset=0`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeLessThanOrEqual(2);
    expect(body.meta.limit).toBe(2);
    expect(body.meta.offset).toBe(0);
  });

  it("resolves task title for task-linked reviews", async () => {
    const response = await request(`/api/reviews?${STATUS_ALL}`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    const openReview = data.find((r: { _ulid: string }) => r._ulid === OPEN_REVIEW_ULID);
    expect(openReview).toBeDefined();
    expect(openReview.task_ref).toBe("@test-task-pending-review");
    expect(openReview.task_title).toBe("Pending review task");
  });

  it("includes computed thread/blocker/check/verdict counts", async () => {
    const response = await request(`/api/reviews?${STATUS_ALL}`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    const openReview = data.find((r: { _ulid: string }) => r._ulid === OPEN_REVIEW_ULID);
    expect(openReview).toBeDefined();
    expect(openReview.thread_count).toBe(4);
    expect(openReview.unresolved_blocker_count).toBe(2);
    expect(openReview.check_count).toBe(3);
    expect(openReview.verdict_count).toBe(1);
  });

  it("returns correct disposition badge for changes_requested", async () => {
    const response = await request(`/api/reviews?${STATUS_ALL}`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    const openReview = data.find((r: { _ulid: string }) => r._ulid === OPEN_REVIEW_ULID);
    expect(openReview).toBeDefined();
    expect(openReview.disposition).toBe("changes_requested");
  });

  it("returns JSON content type", async () => {
    const response = await request("/api/reviews");
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("filters by task ref", async () => {
    const response = await request(`/api/reviews?${STATUS_ALL}&task=@test-task-pending-review`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.length).toBeGreaterThan(0);
    for (const review of data) {
      expect(review.task_ref).toBe("@test-task-pending-review");
    }
    const ulids = data.map((r: { _ulid: string }) => r._ulid);
    expect(ulids).toContain(OPEN_REVIEW_ULID);
  });

  // The API task filter matches against subject.ref (slug), not ULID resolution.
  // ULID-based task filtering is not currently implemented — this test verifies
  // the filter returns empty when given a raw ULID that doesn't match any ref string.
  it("task filter with raw ULID returns empty (no ULID resolution)", async () => {
    const response = await request(`/api/reviews?${STATUS_ALL}&task=${PENDING_REVIEW_TASK_ULID}`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data).toEqual([]);
  });

  it("returns empty list for unlinked task", async () => {
    const response = await request(`/api/reviews?${STATUS_ALL}&task=@test-task-not-in-review`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data).toEqual([]);
  });

  it("finds sibling reviews by subject_ref", async () => {
    const response = await request(
      `/api/reviews?${STATUS_ALL}&subject_ref=@test-task-pending-review`,
    );
    expect(response.status).toBe(200);
    const { data } = await response.json();
    const ulids = data.map((r: { _ulid: string }) => r._ulid);
    expect(ulids).toContain(SIBLING_REVIEW_ULID);
  });

  it("finds sibling reviews by head_branch", async () => {
    const response = await request(`/api/reviews?${STATUS_ALL}&head_branch=feat/review-detail`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    const ulids = data.map((r: { _ulid: string }) => r._ulid);
    expect(ulids).toContain(CODE_REVIEW_ULID);
    expect(ulids).toContain(CODE_REVIEW_SIBLING_ULID);
  });
});

describe("Review Detail API (GET /api/reviews/:id)", () => {
  it("returns full detail by ULID with all contract fields", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("data");
    const review = body.data;
    expect(review._ulid).toBe(OPEN_REVIEW_ULID);
    expect(review.title).toBe("Review of test task");
    expect(review.lifecycle_state).toBe("open");
    expect(review).toHaveProperty("disposition");
    expect(review).toHaveProperty("threads");
    expect(review).toHaveProperty("checks");
    expect(review).toHaveProperty("verdicts");
    expect(review).toHaveProperty("events");
    expect(review).toHaveProperty("subject");
  });

  it("includes threads with entries and resolution state", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}`);
    expect(response.status).toBe(200);
    const { data: review } = await response.json();
    expect(Array.isArray(review.threads)).toBe(true);
    expect(review.threads.length).toBe(4);

    // First blocker thread
    const blockerThread = review.threads.find(
      (t: { _ulid: string }) => t._ulid === "01KKTX1CA45ZT43W2T6HJMVA02",
    );
    expect(blockerThread).toBeDefined();
    expect(blockerThread.kind).toBe("blocker");
    expect(blockerThread.entries.length).toBeGreaterThan(0);
    expect(blockerThread.entries[0].body).toBe("Missing error handling for edge case");

    // Resolved question thread
    const resolvedThread = review.threads.find(
      (t: { kind: string; resolved_at: string | null }) =>
        t.kind === "question" && t.resolved_at !== null,
    );
    expect(resolvedThread).toBeDefined();
    expect(resolvedThread.resolved_by).toBe("worker@test.com");
    expect(resolvedThread.entries.length).toBe(2);
  });

  it("includes computed disposition", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}`);
    expect(response.status).toBe(200);
    const { data: review } = await response.json();
    expect(review.disposition).toBe("changes_requested");
  });

  it("returns detail for an empty review (draft) with empty arrays", async () => {
    const response = await request(`/api/reviews/${DRAFT_REVIEW_ULID}`);
    expect(response.status).toBe(200);
    const { data: review } = await response.json();
    expect(review._ulid).toBe(DRAFT_REVIEW_ULID);
    expect(review.lifecycle_state).toBe("draft");
    expect(review.threads).toEqual([]);
    expect(review.checks).toEqual([]);
    expect(review.verdicts).toEqual([]);
  });

  it("returns 404 for unknown review with error shape", async () => {
    const response = await request("/api/reviews/01AAAAAAAAAAAAAAAAAAAAAA99");
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("not_found");
    expect(body).toHaveProperty("suggestion");
  });

  it("includes subject info", async () => {
    const response = await request(`/api/reviews/${OPEN_REVIEW_ULID}`);
    expect(response.status).toBe(200);
    const { data: review } = await response.json();
    expect(review).toHaveProperty("subject");
    expect(review.subject).toHaveProperty("type");
    expect(review.subject).toHaveProperty("ref");
  });
});
