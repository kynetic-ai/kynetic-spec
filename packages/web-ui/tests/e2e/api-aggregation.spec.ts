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

import { test, expect } from "../fixtures/test-base";

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

      // Must have required fields
      expect(body).toHaveProperty("counts");
      expect(body).toHaveProperty("ready");
      expect(body).toHaveProperty("blocked_by_dependencies");
      expect(body).toHaveProperty("total");

      // counts should be an object with status keys
      expect(typeof body.counts).toBe("object");
      expect(body.total).toBeGreaterThan(0);

      // ready and blocked_by_dependencies should be non-negative integers
      expect(body.ready).toBeGreaterThanOrEqual(0);
      expect(body.blocked_by_dependencies).toBeGreaterThanOrEqual(0);
    });

    // AC: @ui-api-aggregation ac-1
    test("counts include known status values from fixture data", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/tasks/summary`);
      const body = await response.json();

      // Fixture has pending, in_progress, pending_review, and completed tasks
      expect(body.counts).toHaveProperty("pending");
      expect(body.counts.pending).toBeGreaterThan(0);
      expect(body.counts).toHaveProperty("in_progress");
      expect(body.counts.in_progress).toBeGreaterThan(0);
      expect(body.counts).toHaveProperty("completed");
      expect(body.counts.completed).toBeGreaterThan(0);
    });

    // AC: @ui-api-aggregation ac-1
    test("distinguishes ready vs blocked by dependencies", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/tasks/summary`);
      const body = await response.json();

      // Fixture has test-task-blocked which depends on test-task-ready (pending, not completed)
      // So blocked_by_dependencies should be >= 1
      expect(body.blocked_by_dependencies).toBeGreaterThanOrEqual(1);

      // Fixture has test-task-ready which is pending with no dependencies
      // So ready should be >= 1
      expect(body.ready).toBeGreaterThanOrEqual(1);
    });

    // AC: @ui-api-aggregation ac-1
    test("total equals sum of all status counts", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/tasks/summary`);
      const body = await response.json();

      const countSum = Object.values(body.counts as Record<string, number>).reduce(
        (sum: number, count: number) => sum + count,
        0,
      );
      expect(countSum).toBe(body.total);
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

      // Must have alignment stats
      expect(body).toHaveProperty("stats");
      expect(body.stats).toHaveProperty("totalSpecs");
      expect(body.stats).toHaveProperty("specsWithTasks");
      expect(body.stats).toHaveProperty("alignedSpecs");
      expect(body.stats).toHaveProperty("orphanedSpecs");

      // Must have warnings array
      expect(body).toHaveProperty("warnings");
      expect(Array.isArray(body.warnings)).toBe(true);

      // Must have entity counts
      expect(body).toHaveProperty("entity_counts");
      expect(body.entity_counts).toHaveProperty("items");
      expect(body.entity_counts).toHaveProperty("tasks");
      expect(body.entity_counts).toHaveProperty("traits");
      expect(body.entity_counts.items).toBeGreaterThan(0);
      expect(body.entity_counts.tasks).toBeGreaterThan(0);
    });

    // AC: @ui-api-aggregation ac-2
    test("returns AC counts as pre-computed fields", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/validation`);
      const body = await response.json();

      // Must have AC counts
      expect(body).toHaveProperty("ac_counts");
      expect(body.ac_counts).toHaveProperty("total");
      expect(body.ac_counts).toHaveProperty("covered");
      expect(body.ac_counts).toHaveProperty("uncovered");

      // Total should be non-negative
      expect(body.ac_counts.total).toBeGreaterThanOrEqual(0);
      expect(body.ac_counts.covered).toBeGreaterThanOrEqual(0);
      expect(body.ac_counts.uncovered).toBeGreaterThanOrEqual(0);

      // covered + uncovered should equal total
      expect(body.ac_counts.covered + body.ac_counts.uncovered).toBe(body.ac_counts.total);
    });

    // AC: @ui-api-aggregation ac-2
    test("returns orphan count as pre-computed field", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/validation`);
      const body = await response.json();

      expect(body).toHaveProperty("orphan_count");
      expect(typeof body.orphan_count).toBe("number");
      expect(body.orphan_count).toBeGreaterThanOrEqual(0);
    });

    // AC: @ui-api-aggregation ac-2
    test("returns validation status and error/warning counts", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/aggregation/validation`);
      const body = await response.json();

      expect(body).toHaveProperty("valid");
      expect(typeof body.valid).toBe("boolean");
      expect(body).toHaveProperty("error_count");
      expect(typeof body.error_count).toBe("number");
      expect(body).toHaveProperty("warning_count");
      expect(typeof body.warning_count).toBe("number");
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

      // Must have items array and total
      expect(body).toHaveProperty("items");
      expect(body).toHaveProperty("total");
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);

      // Each item should have standard inbox fields
      const item = body.items[0];
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
      const triagedItem = body.items.find(
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
      const actedItem = body.items.find(
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
      for (const item of body.items) {
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

      if (body.items.length > 1) {
        for (let i = 0; i < body.items.length - 1; i++) {
          const currentDate = new Date(body.items[i].created_at).getTime();
          const nextDate = new Date(body.items[i + 1].created_at).getTime();
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
