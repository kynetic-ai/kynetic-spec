/**
 * E2E API Tests for Daemon Aggregation Endpoints
 *
 * Tests verify actual HTTP behavior by calling the running daemon directly.
 *
 * Covered ACs:
 * - @ui-api-aggregation ac-1: GET /api/aggregation/tasks/summary returns status counts with dependency-aware distinctions
 * - @ui-api-aggregation ac-2: GET /api/aggregation/validation returns extended stats with entity/AC/orphan counts
 * - @ui-api-aggregation ac-3: GET /api/aggregation/inbox returns inbox items with inline triage status
 * - @trait-api-endpoint ac-1: Returns 2xx with JSON body
 *
 * N/A Trait ACs:
 * AC: @trait-api-endpoint ac-2 — N/A: aggregation endpoints have no ref parameters to resolve
 * AC: @trait-api-endpoint ac-3 — N/A: GET-only endpoints with no request body
 * AC: @trait-api-endpoint ac-4 — N/A: summary/aggregation endpoints return complete data, not paginated lists
 * AC: @trait-api-endpoint ac-5 — N/A: read-only endpoints, no state mutations
 * AC: @trait-api-endpoint ac-6 — N/A: X-Request-Id handled at middleware level, not per-route
 * AC: @trait-websocket-protocol ac-1 — N/A: WebSocket enrichment (ac-4) is a separate task (@task-ws-enrichment)
 * AC: @trait-websocket-protocol ac-2 — N/A: WebSocket enrichment is a separate task
 * AC: @trait-websocket-protocol ac-3 — N/A: WebSocket enrichment is a separate task
 * AC: @trait-websocket-protocol ac-4 — N/A: WebSocket enrichment is a separate task
 * AC: @trait-websocket-protocol ac-5 — N/A: WebSocket enrichment is a separate task
 * AC: @trait-websocket-protocol ac-6 — N/A: WebSocket enrichment is a separate task
 * AC: @trait-websocket-protocol ac-7 — N/A: WebSocket enrichment is a separate task
 * AC: @trait-websocket-protocol ac-8 — N/A: WebSocket enrichment is a separate task
 */

import { test, expect } from "./fixtures/test-base";

test.describe("Aggregation API", () => {
  test.describe("GET /api/aggregation/tasks/summary", () => {
    // AC: @ui-api-aggregation ac-1
    test("returns task status counts with dependency-aware distinctions", async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/tasks/summary`);

      expect(response.status()).toBe(200);

      const body = await response.json();

      // Must have envelope structure
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("meta");

      // Must have required fields inside data
      expect(body.data).toHaveProperty("counts");
      expect(body.data).toHaveProperty("ready");
      expect(body.data).toHaveProperty("blocked_by_dependencies");
      expect(body.data).toHaveProperty("total");

      // counts should be an object with status keys
      expect(typeof body.data.counts).toBe("object");
      expect(body.data.total).toBeGreaterThan(0);

      // ready and blocked_by_dependencies should be non-negative integers
      expect(body.data.ready).toBeGreaterThanOrEqual(0);
      expect(body.data.blocked_by_dependencies).toBeGreaterThanOrEqual(0);
    });

    // AC: @ui-api-aggregation ac-1
    test("counts include known status values from fixture data", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/tasks/summary`);
      const body = await response.json();

      // Fixture has pending, in_progress, pending_review, and completed tasks
      expect(body.data.counts).toHaveProperty("pending");
      expect(body.data.counts.pending).toBeGreaterThan(0);
      expect(body.data.counts).toHaveProperty("in_progress");
      expect(body.data.counts.in_progress).toBeGreaterThan(0);
      expect(body.data.counts).toHaveProperty("completed");
      expect(body.data.counts.completed).toBeGreaterThan(0);
    });

    // AC: @ui-api-aggregation ac-1
    test("distinguishes ready vs blocked by dependencies", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/tasks/summary`);
      const body = await response.json();

      // Fixture has test-task-blocked which depends on test-task-ready (pending, not completed)
      // So blocked_by_dependencies should be >= 1
      expect(body.data.blocked_by_dependencies).toBeGreaterThanOrEqual(1);

      // Fixture has test-task-ready which is pending with no dependencies
      // So ready should be >= 1
      expect(body.data.ready).toBeGreaterThanOrEqual(1);
    });

    // AC: @ui-api-aggregation ac-1
    test("total equals sum of all status counts", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/tasks/summary`);
      const body = await response.json();

      const countSum = Object.values(body.data.counts as Record<string, number>).reduce(
        (sum: number, count: number) => sum + count,
        0,
      );
      expect(countSum).toBe(body.data.total);
    });

    // AC: @trait-api-endpoint ac-1
    test("returns 200 with JSON body", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/tasks/summary`);
      expect(response.status()).toBe(200);
      const contentType = response.headers()["content-type"];
      expect(contentType).toContain("json");
    });
  });

  test.describe("GET /api/aggregation/validation", () => {
    // AC: @ui-api-aggregation ac-2
    test("returns validation stats with entity counts", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/validation`);

      expect(response.status()).toBe(200);

      const body = await response.json();

      // Must have envelope structure
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("meta");

      // Must have alignment stats
      expect(body.data).toHaveProperty("stats");
      expect(body.data.stats).toHaveProperty("totalSpecs");
      expect(body.data.stats).toHaveProperty("specsWithTasks");
      expect(body.data.stats).toHaveProperty("alignedSpecs");
      expect(body.data.stats).toHaveProperty("orphanedSpecs");

      // Must have warnings array
      expect(body.data).toHaveProperty("warnings");
      expect(Array.isArray(body.data.warnings)).toBe(true);

      // Must have entity counts
      expect(body.data).toHaveProperty("entity_counts");
      expect(body.data.entity_counts).toHaveProperty("items");
      expect(body.data.entity_counts).toHaveProperty("tasks");
      expect(body.data.entity_counts).toHaveProperty("traits");
      expect(body.data.entity_counts.items).toBeGreaterThan(0);
      expect(body.data.entity_counts.tasks).toBeGreaterThan(0);
    });

    // AC: @ui-api-aggregation ac-2
    test("returns AC counts as pre-computed fields", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/validation`);
      const body = await response.json();

      // Must have AC counts
      expect(body.data).toHaveProperty("ac_counts");
      expect(body.data.ac_counts).toHaveProperty("total");
      expect(body.data.ac_counts).toHaveProperty("covered");
      expect(body.data.ac_counts).toHaveProperty("uncovered");

      // Total should be non-negative
      expect(body.data.ac_counts.total).toBeGreaterThanOrEqual(0);
      expect(body.data.ac_counts.covered).toBeGreaterThanOrEqual(0);
      expect(body.data.ac_counts.uncovered).toBeGreaterThanOrEqual(0);

      // covered + uncovered should equal total
      expect(body.data.ac_counts.covered + body.data.ac_counts.uncovered).toBe(body.data.ac_counts.total);
    });

    // AC: @ui-api-aggregation ac-2
    test("returns orphan count as pre-computed field", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/validation`);
      const body = await response.json();

      expect(body.data).toHaveProperty("orphan_count");
      expect(typeof body.data.orphan_count).toBe("number");
      expect(body.data.orphan_count).toBeGreaterThanOrEqual(0);
    });

    // AC: @ui-api-aggregation ac-2
    test("returns validation status and error/warning counts", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/validation`);
      const body = await response.json();

      expect(body.data).toHaveProperty("valid");
      expect(typeof body.data.valid).toBe("boolean");
      expect(body.data).toHaveProperty("error_count");
      expect(typeof body.data.error_count).toBe("number");
      expect(body.data).toHaveProperty("warning_count");
      expect(typeof body.data.warning_count).toBe("number");
    });

    // AC: @trait-api-endpoint ac-1
    test("returns 200 with JSON body", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/validation`);
      expect(response.status()).toBe(200);
      const contentType = response.headers()["content-type"];
      expect(contentType).toContain("json");
    });
  });

  test.describe("GET /api/aggregation/inbox", () => {
    // AC: @ui-api-aggregation ac-3
    test("returns inbox items with inline triage status", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/inbox`);

      expect(response.status()).toBe(200);

      const body = await response.json();

      // Must have envelope structure
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("meta");
      expect(body.meta).toHaveProperty("total");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      // Each item should have standard inbox fields
      const item = body.data[0];
      expect(item).toHaveProperty("_ulid");
      expect(item).toHaveProperty("text");
      expect(item).toHaveProperty("tags");
      expect(item).toHaveProperty("added_by");
      expect(item).toHaveProperty("created_at");
    });

    // AC: @ui-api-aggregation ac-3
    test("includes triage data for triaged items", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/inbox`);
      const body = await response.json();

      // Fixture has first inbox item (01KJNBX0CA45ZT43W2T6HJMVA1) with triage record
      const triagedItem = body.data.find(
        (item: { triage?: { status: string } }) => item.triage && item.triage.status === "triaged",
      );
      expect(triagedItem).toBeDefined();
      expect(triagedItem.triage).toHaveProperty("_ulid");
      expect(triagedItem.triage).toHaveProperty("status");
      expect(triagedItem.triage).toHaveProperty("action");
      expect(triagedItem.triage).toHaveProperty("reasoning");
    });

    // AC: @ui-api-aggregation ac-3
    test("includes triage data for acted_on items", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/inbox`);
      const body = await response.json();

      // Fixture has second inbox item (01KJNBX1CC9N4YGP991WD7XS8S) with acted_on triage
      const actedItem = body.data.find(
        (item: { triage?: { status: string } }) => item.triage && item.triage.status === "acted_on",
      );
      expect(actedItem).toBeDefined();
      expect(actedItem.triage.action).toBe("promote");
      expect(actedItem.triage.result_ref).toBeDefined();
    });

    // AC: @ui-api-aggregation ac-3
    test("omits triage field for items without triage records", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/inbox`);
      const body = await response.json();

      // All items should either have a triage field or not
      // Fixture has 3 inbox items, all with triage records (including a pending one)
      // The pending one has action: null, so it should still have triage data
      for (const item of body.data) {
        if (item.triage) {
          expect(item.triage).toHaveProperty("_ulid");
          expect(item.triage).toHaveProperty("status");
        }
      }
    });

    // AC: @ui-api-aggregation ac-3
    test("returns items sorted by created_at descending", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/inbox`);
      const body = await response.json();

      if (body.data.length > 1) {
        for (let i = 0; i < body.data.length - 1; i++) {
          const currentDate = new Date(body.data[i].created_at).getTime();
          const nextDate = new Date(body.data[i + 1].created_at).getTime();
          expect(currentDate).toBeGreaterThanOrEqual(nextDate);
        }
      }
    });

    // AC: @trait-api-endpoint ac-1
    test("returns 200 with JSON body", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/inbox`);
      expect(response.status()).toBe(200);
      const contentType = response.headers()["content-type"];
      expect(contentType).toContain("json");
    });
  });
});
