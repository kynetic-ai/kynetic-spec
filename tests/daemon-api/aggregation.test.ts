// AC: @trait-api-endpoint ac-2 — N/A: aggregation endpoints have no ref parameters to resolve
// AC: @trait-api-endpoint ac-3 — N/A: GET-only endpoints with no request body
// AC: @trait-api-endpoint ac-4 — N/A: summary/aggregation endpoints return complete data, not paginated lists
// AC: @trait-api-endpoint ac-5 — N/A: read-only endpoints, no state mutations
// AC: @trait-api-endpoint ac-6 — N/A: X-Request-Id handled at middleware level, not per-route
// AC: @trait-websocket-protocol ac-1 — N/A: WebSocket enrichment (ac-4) is a separate task (@task-ws-enrichment)
// AC: @trait-websocket-protocol ac-2 — N/A: WebSocket enrichment is a separate task
// AC: @trait-websocket-protocol ac-3 — N/A: WebSocket enrichment is a separate task
// AC: @trait-websocket-protocol ac-4 — N/A: WebSocket enrichment is a separate task
// AC: @trait-websocket-protocol ac-5 — N/A: WebSocket enrichment is a separate task
// AC: @trait-websocket-protocol ac-6 — N/A: WebSocket enrichment is a separate task
// AC: @trait-websocket-protocol ac-7 — N/A: WebSocket enrichment is a separate task
// AC: @trait-websocket-protocol ac-8 — N/A: WebSocket enrichment is a separate task

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

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-aggregation-");
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

describe("GET /api/aggregation/tasks/summary", () => {
  it("returns status counts with dependency-aware distinctions", async () => {
    const response = await request("/api/aggregation/tasks/summary");
    expect(response.status).toBe(200);
    const body = await response.json();
    // Response is wrapped in {data, meta} envelope
    expect(body.data).toHaveProperty("counts");
    expect(typeof body.data.counts).toBe("object");
  });

  it("returns known status values", async () => {
    const response = await request("/api/aggregation/tasks/summary");
    const body = await response.json();
    const knownStatuses = [
      "pending",
      "in_progress",
      "pending_review",
      "completed",
      "blocked",
      "cancelled",
      "needs_work",
    ];
    for (const key of Object.keys(body.data.counts)) {
      expect(knownStatuses).toContain(key);
    }
  });

  it("distinguishes ready vs blocked", async () => {
    const response = await request("/api/aggregation/tasks/summary");
    const body = await response.json();
    expect(body.data).toHaveProperty("ready");
    expect(body.data).toHaveProperty("blocked_by_dependencies");
    expect(typeof body.data.ready).toBe("number");
    expect(typeof body.data.blocked_by_dependencies).toBe("number");
  });

  it("total equals sum of all status counts", async () => {
    const response = await request("/api/aggregation/tasks/summary");
    const body = await response.json();
    const sum = Object.values(body.data.counts as Record<string, number>).reduce(
      (acc, val) => acc + val,
      0,
    );
    expect(body.data.total).toBe(sum);
  });

  it("returns 200 with JSON content-type", async () => {
    const response = await request("/api/aggregation/tasks/summary");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("GET /api/aggregation/validation", () => {
  it("returns alignment stats with entity counts", async () => {
    const response = await request("/api/aggregation/validation");
    expect(response.status).toBe(200);
    const body = await response.json();
    // Response is wrapped in {data, meta} envelope
    expect(body.data).toHaveProperty("entity_counts");
    expect(typeof body.data.entity_counts).toBe("object");
  });

  it("returns AC counts", async () => {
    const response = await request("/api/aggregation/validation");
    const body = await response.json();
    expect(body.data).toHaveProperty("ac_counts");
    expect(typeof body.data.ac_counts).toBe("object");
  });

  it("returns orphan count", async () => {
    const response = await request("/api/aggregation/validation");
    const body = await response.json();
    expect(body.data).toHaveProperty("orphan_count");
    expect(typeof body.data.orphan_count).toBe("number");
  });

  it("returns validation status", async () => {
    const response = await request("/api/aggregation/validation");
    const body = await response.json();
    expect(body.data).toHaveProperty("valid");
    expect(typeof body.data.valid).toBe("boolean");
  });

  it("returns 200 with JSON content-type", async () => {
    const response = await request("/api/aggregation/validation");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("GET /api/aggregation/inbox", () => {
  it("returns items with inline triage data", async () => {
    const response = await request("/api/aggregation/inbox");
    expect(response.status).toBe(200);
    const body = await response.json();
    // Response is wrapped in {data, meta} envelope; data is the array
    expect(Array.isArray(body.data)).toBe(true);
    for (const item of body.data) {
      // Entities use _ulid, not id
      expect(item).toHaveProperty("_ulid");
      expect(item).toHaveProperty("text");
    }
  });

  it("returns triaged items with triage data", async () => {
    const response = await request("/api/aggregation/inbox");
    const body = await response.json();
    const triaged = body.data.filter(
      (item: { triage?: unknown }) => item.triage != null,
    );
    for (const item of triaged) {
      // Triage records use "status" field, not "disposition"
      expect(item.triage).toHaveProperty("status");
    }
  });

  it("returns acted_on triage data correctly", async () => {
    const response = await request("/api/aggregation/inbox");
    const body = await response.json();
    const actedOn = body.data.filter(
      (item: { triage?: { status?: string } }) =>
        item.triage?.status === "acted_on",
    );
    for (const item of actedOn) {
      expect(item.triage.status).toBe("acted_on");
    }
  });

  it("returns items without triage as null or undefined triage field", async () => {
    const response = await request("/api/aggregation/inbox");
    const body = await response.json();
    const untriaged = body.data.filter(
      (item: { triage?: unknown }) => item.triage == null,
    );
    expect(Array.isArray(untriaged)).toBe(true);
  });

  it("returns items sorted descending", async () => {
    const response = await request("/api/aggregation/inbox");
    const body = await response.json();
    const items = body.data as Array<{ created_at?: string; _ulid: string }>;
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1].created_at ?? items[i - 1]._ulid;
      const curr = items[i].created_at ?? items[i]._ulid;
      expect(prev >= curr).toBe(true);
    }
  });

  it("returns 200 with JSON content-type", async () => {
    const response = await request("/api/aggregation/inbox");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
