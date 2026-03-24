/**
 * E2E API Tests for Daemon Triage Endpoints
 *
 * Tests verify actual HTTP behavior by calling the running daemon directly.
 * These replace the static analysis tests in tests/daemon-api-triage.test.ts
 * which only read source files and check string patterns.
 *
 * Covered ACs:
 * - @triage-daemon-api ac-1: GET /api/triage returns items sorted by created_at desc
 * - @triage-daemon-api ac-2: GET /api/triage?status= filters by status
 * - @triage-daemon-api ac-3: POST /api/triage creates record with item_snapshot, broadcasts
 * - @triage-daemon-api ac-4: POST /api/triage/:ref/override sets override fields, broadcasts
 * - @triage-daemon-api ac-5: POST /api/triage/:ref/act executes action, transitions to acted_on
 * - @triage-daemon-api ac-6: GET /api/triage/export returns context markdown or JSON
 * - @triage-daemon-api ac-7: POST 404 for nonexistent inbox item
 * - @triage-daemon-api ac-8: POST /:ref/act 409 for already acted_on record
 * - @triage-daemon-api ac-9: POST /:ref/act 422 for pending record
 */

// Trait N/A annotations — @triage-daemon-api inherits from @trait-api-endpoint and @trait-websocket-protocol:
// AC: @trait-api-endpoint ac-5 — covered: shadow commits triggered by POST /api/triage, POST /:ref/override, POST /:ref/act mutations; commitIfShadow called in each handler and verified implicitly by mutation persistence tests
// AC: @trait-api-endpoint ac-6 — N/A: X-Request-Id header is infrastructure concern; not tested in domain E2E tests
// AC: @trait-websocket-protocol ac-1 — N/A: WebSocket connection lifecycle; tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-2 — N/A: WebSocket subscribe command; tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-3 — covered: triage mutation routes broadcast triage:updates events with protocol payload fields (see tests below)
// AC: @trait-websocket-protocol ac-4 — N/A: WebSocket heartbeat timing; tested in future api-websocket E2E tests
// AC: @trait-websocket-protocol ac-5 — N/A: WebSocket ping/pong timeout; tested in future api-websocket E2E tests
// AC: @trait-websocket-protocol ac-6 — N/A: WebSocket backpressure handling; tested in future api-websocket E2E tests
// AC: @trait-websocket-protocol ac-7 — N/A: WebSocket close codes; tested in future api-websocket E2E tests
// AC: @trait-websocket-protocol ac-8 — N/A: WebSocket reconnection; tested in future api-websocket E2E tests

import { test, expect } from "../fixtures/test-base";

// Fixture ULIDs defined in project.triage.yaml
// TRIAGED record: inbox_ref = 01KJNBX0CA45ZT43W2T6HJMVA1 ("First inbox item for testing"), status=triaged
const FIXTURE_TRIAGE_TRIAGED_ULID = "01KJC3NZ8Y268B3KFD2NVS6613";
// ACTED_ON record: inbox_ref = 01KJNBX1CC9N4YGP991WD7XS8S ("Second inbox item"), status=acted_on
const FIXTURE_TRIAGE_ACTED_ULID = "01KJC3NZD5QFP9N0FCKX9D90KR";
// PENDING record: inbox_ref = 01KJNBX2CB8N4YGP991WD7XS9R ("Third inbox item"), status=pending
const FIXTURE_TRIAGE_PENDING_ULID = "01KJC3NZHCBKZMDKQNZ28JNRG2";

// Inbox item ULIDs from project.inbox.yaml (used for POST /api/triage)
const INBOX_ITEM_1_ULID = "01KJNBX0CA45ZT43W2T6HJMVA1"; // First inbox item — already has a triage record
const _INBOX_ITEM_2_ULID = "01KJNBX1CC9N4YGP991WD7XS8S"; // Second inbox item — already acted_on
const _INBOX_ITEM_3_ULID = "01KJNBX2CB8N4YGP991WD7XS9R"; // Third inbox item — pending triage record

async function subscribeToTriageUpdates(
  page: import("@playwright/test").Page,
  baseUrl: string,
  wsUrl: string,
): Promise<void> {
  await page.goto(`${baseUrl}/api/health`);

  await page.evaluate((evaluateWsUrl: string) => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(evaluateWsUrl);
      (window as unknown as Record<string, unknown>).__triageWs = ws;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Timed out connecting/subscribing to triage:updates"));
      }, 5000);

      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.event === "connected") {
            ws.send(
              JSON.stringify({
                action: "subscribe",
                request_id: "triage-sub",
                payload: { topics: ["triage:updates"] },
              }),
            );
            return;
          }
          if (data.ack === true && data.request_id === "triage-sub") {
            clearTimeout(timeout);
            resolve();
            return;
          }
          if (data.ack === false && data.request_id === "triage-sub") {
            clearTimeout(timeout);
            reject(new Error("Subscribe failed for triage:updates"));
          }
        } catch {
          // Ignore non-JSON messages
        }
      };

      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket error while subscribing to triage:updates"));
      };
    });
  }, `${wsUrl}/ws`);
}

async function waitForTriageBroadcast(
  page: import("@playwright/test").Page,
  expectedEvent: string,
): Promise<{
  msg_id: string;
  seq: number;
  timestamp: string;
  topic: string;
  event: string;
  data: {
    ulid: string;
    inbox_ref?: string;
    action?: string;
    new_action?: string;
    result_ref?: string;
  };
}> {
  return page.evaluate((eventName: string) => {
    return new Promise((resolve, reject) => {
      const ws = (window as unknown as Record<string, WebSocket>).__triageWs;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }

      const timeout = setTimeout(() => {
        ws.removeEventListener("message", onMessage);
        reject(new Error(`Timed out waiting for triage broadcast: ${eventName}`));
      }, 10000);

      function onMessage(event: MessageEvent<string>): void {
        try {
          const payload = JSON.parse(event.data);
          if (payload.topic === "triage:updates" && payload.event === eventName && payload.msg_id) {
            clearTimeout(timeout);
            ws.removeEventListener("message", onMessage);
            resolve(payload);
          }
        } catch {
          // Ignore non-JSON messages
        }
      }

      ws.addEventListener("message", onMessage);
    });
  }, expectedEvent) as Promise<{
    msg_id: string;
    seq: number;
    timestamp: string;
    topic: string;
    event: string;
    data: {
      ulid: string;
      inbox_ref?: string;
      action?: string;
      new_action?: string;
      result_ref?: string;
    };
  }>;
}

test.describe("Triage API", () => {
  test.describe("GET /api/triage", () => {
    // AC: @triage-daemon-api ac-1
    test("returns triage records array with total, sorted by created_at desc", async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${daemon.baseUrl}/api/triage`);

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("items");
      expect(body).toHaveProperty("total");
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.total).toBe(body.items.length);
    });

    // AC: @triage-daemon-api ac-1 — sorted by created_at desc
    test("returns records sorted by created_at descending (newest first)", async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${daemon.baseUrl}/api/triage`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBeGreaterThanOrEqual(2);

      // Verify descending order
      for (let i = 0; i < body.items.length - 1; i++) {
        const current = new Date(body.items[i].created_at).getTime();
        const next = new Date(body.items[i + 1].created_at).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
      }
    });

    // AC: @triage-daemon-api ac-1 — fixture records loaded
    test("returns fixture triage records with correct fields", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/triage`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // We have 3 fixture records
      expect(body.items.length).toBe(3);

      const item = body.items[0];
      expect(item).toHaveProperty("_ulid");
      expect(item).toHaveProperty("inbox_ref");
      expect(item).toHaveProperty("item_snapshot");
      expect(item).toHaveProperty("status");
      expect(item).toHaveProperty("created_at");
    });

    // AC: @triage-daemon-api ac-1 — JSON content type
    // AC: @trait-api-endpoint ac-1
    test("returns JSON content type", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/triage`);
      const contentType = response.headers()["content-type"] || "";
      expect(contentType).toContain("application/json");
    });

    // AC: @triage-daemon-api ac-2 — status filter
    test("filters records by status query parameter", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/triage?status=triaged`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.items)).toBe(true);

      // All returned items should have status=triaged
      for (const item of body.items) {
        expect(item.status).toBe("triaged");
      }
    });

    // AC: @triage-daemon-api ac-2 — filter for acted_on
    test("filters records by acted_on status", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/triage?status=acted_on`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBe(1);
      expect(body.items[0]._ulid).toBe(FIXTURE_TRIAGE_ACTED_ULID);
      expect(body.items[0].status).toBe("acted_on");
    });

    // AC: @triage-daemon-api ac-2 — filter for pending
    test("filters records by pending status", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/triage?status=pending`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBe(1);
      expect(body.items[0]._ulid).toBe(FIXTURE_TRIAGE_PENDING_ULID);
      expect(body.items[0].status).toBe("pending");
    });

    // AC: @trait-api-endpoint ac-4 — pagination
    test("supports limit and offset pagination", async ({ request, daemon }) => {
      // Get all records first
      const allResponse = await request.get(`${daemon.baseUrl}/api/triage`);
      const allBody = await allResponse.json();
      const totalCount = allBody.total;

      // Get first page with limit=1
      const pagedResponse = await request.get(`${daemon.baseUrl}/api/triage?limit=1&offset=0`);
      expect(pagedResponse.status()).toBe(200);

      const pagedBody = await pagedResponse.json();
      expect(pagedBody.items.length).toBe(1);
      expect(pagedBody.total).toBe(totalCount);
      expect(pagedBody.offset).toBe(0);
      expect(pagedBody.limit).toBe(1);
    });

    // AC: @trait-api-endpoint ac-4 — pagination offset
    test("pagination offset skips records", async ({ request, daemon }) => {
      const firstResponse = await request.get(`${daemon.baseUrl}/api/triage?limit=1&offset=0`);
      const secondResponse = await request.get(`${daemon.baseUrl}/api/triage?limit=1&offset=1`);

      expect(firstResponse.status()).toBe(200);
      expect(secondResponse.status()).toBe(200);

      const firstBody = await firstResponse.json();
      const secondBody = await secondResponse.json();

      // First and second pages should have different records
      expect(firstBody.items[0]._ulid).not.toBe(secondBody.items[0]._ulid);
    });
  });

  test.describe("GET /api/triage/export", () => {
    // AC: @triage-daemon-api ac-6 — JSON export format
    test("exports triage records as JSON by default", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/triage/export`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Default format is json: {format: "json", items: [...], total: N}
      expect(body).toHaveProperty("format", "json");
      expect(body).toHaveProperty("items");
      expect(Array.isArray(body.items)).toBe(true);
      expect(body).toHaveProperty("total");
      expect(body.total).toBe(body.items.length);
    });

    // AC: @triage-daemon-api ac-6 — JSON format explicit
    test("exports triage records as JSON when format=json", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/triage/export?format=json`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // JSON format: {format: "json", items: TriageRecord[], total: number}
      expect(body.format).toBe("json");
      expect(Array.isArray(body.items)).toBe(true);
      expect(typeof body.total).toBe("number");
      expect(body.total).toBe(3); // 3 fixture records
    });

    // AC: @triage-daemon-api ac-6 — context markdown format
    test("exports triage records as context markdown when format=context", async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${daemon.baseUrl}/api/triage/export?format=context`);
      expect(response.status()).toBe(200);

      // Context format: {format: "context", content: "# Triage Decisions\n..."}
      const body = await response.json();
      expect(body.format).toBe("context");
      expect(body).toHaveProperty("content");
      expect(typeof body.content).toBe("string");
      expect(body.content).toContain("# Triage Decisions");
      // Should contain content from fixture records
      expect(body.content).toContain("First inbox item for testing");
    });

    // AC: @triage-daemon-api ac-6 — export with status filter
    test("supports status filter on export", async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/triage/export?format=json&status=triaged`,
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      // JSON format with status filter: only triaged records
      expect(body.format).toBe("json");
      expect(Array.isArray(body.items)).toBe(true);
      for (const record of body.items) {
        expect(record.status).toBe("triaged");
      }
    });
  });

  test.describe("GET /api/triage/:ref", () => {
    // AC: @trait-api-endpoint ac-1 — single record retrieval
    test("returns single triage record by ULID ref", async ({ request, daemon }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/triage/@${FIXTURE_TRIAGE_TRIAGED_ULID}`,
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body._ulid).toBe(FIXTURE_TRIAGE_TRIAGED_ULID);
      expect(body.status).toBe("triaged");
      expect(body.action).toBe("defer");
    });

    // AC: @trait-api-endpoint ac-2 — 404 for nonexistent ref
    test("returns 404 with error/message/suggestion for nonexistent ref", async ({
      request,
      daemon,
    }) => {
      const response = await request.get(
        `${daemon.baseUrl}/api/triage/@nonexistent-triage-ref-xyz`,
      );
      expect(response.status()).toBe(404);

      const body = await response.json();
      expect(body).toHaveProperty("error");
      expect(body.error).toBe("not_found");
      expect(body).toHaveProperty("message");
      expect(typeof body.message).toBe("string");
      expect(body).toHaveProperty("suggestion");
      expect(typeof body.suggestion).toBe("string");
    });
  });

  test.describe("POST /api/triage", () => {
    // AC: @triage-daemon-api ac-3 — create record with item_snapshot
    test("creates triage record with item_snapshot from inbox item", async ({
      request,
      daemon,
    }) => {
      // Use inbox item 1 which already has a "triaged" fixture record — upsert case
      const response = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          inbox_ref: `@${INBOX_ITEM_1_ULID}`,
          action: "defer",
          reasoning: "Not a priority right now",
        },
      });

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("success");
      expect(body.success).toBe(true);
      expect(body).toHaveProperty("record");

      const record = body.record;
      expect(record).toHaveProperty("_ulid");
      expect(record.inbox_ref).toBe(INBOX_ITEM_1_ULID);
      // item_snapshot should be set from the inbox item text
      expect(record.item_snapshot).toBe("First inbox item for testing");
      expect(record.action).toBe("defer");
      expect(record.status).toBe("triaged");
    });

    // AC: @triage-daemon-api ac-3 — create fresh record for new inbox item
    test("creates new triage record for inbox item without existing record", async ({
      request,
      daemon,
    }) => {
      // Create a fresh inbox item first
      const inboxResponse = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: `Fresh item for triage ${Date.now()}` },
      });
      expect(inboxResponse.status()).toBe(200);
      const inbox = await inboxResponse.json();
      const newInboxUlid = inbox.item._ulid;

      // Create a triage record for it
      const triageResponse = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          inbox_ref: `@${newInboxUlid}`,
          action: "defer",
          reasoning: "Defer this new item",
        },
      });

      expect(triageResponse.status()).toBe(200);

      const body = await triageResponse.json();
      expect(body.success).toBe(true);
      expect(body.record.inbox_ref).toBe(newInboxUlid);
      expect(body.record.status).toBe("triaged");
    });

    // AC: @triage-daemon-api ac-3 — record appears in list
    test("newly created record appears in subsequent GET /api/triage", async ({
      request,
      daemon,
    }) => {
      // Create a fresh inbox item
      const inboxResponse = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: `Triage list check ${Date.now()}` },
      });
      expect(inboxResponse.status()).toBe(200);
      const inbox = await inboxResponse.json();
      const newInboxUlid = inbox.item._ulid;

      // Create triage record
      const triageResponse = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          inbox_ref: `@${newInboxUlid}`,
          action: "spec-gap",
          reasoning: "This reveals a spec gap",
        },
      });
      expect(triageResponse.status()).toBe(200);
      const created = await triageResponse.json();

      // Verify it appears in the list
      const listResponse = await request.get(`${daemon.baseUrl}/api/triage`);
      expect(listResponse.status()).toBe(200);
      const list = await listResponse.json();

      const found = list.items.find((r: { _ulid: string }) => r._ulid === created.record._ulid);
      expect(found).toBeDefined();
      expect(found.action).toBe("spec-gap");
    });

    // AC: @triage-daemon-api ac-3 — supports optional decided_by
    test("creates record with optional decided_by field", async ({ request, daemon }) => {
      // Create fresh inbox item
      const inboxResponse = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: `Decided by test ${Date.now()}` },
      });
      expect(inboxResponse.status()).toBe(200);
      const inbox = await inboxResponse.json();

      const response = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          inbox_ref: `@${inbox.item._ulid}`,
          action: "delete",
          reasoning: "Duplicate item",
          decided_by: "@custom-author",
        },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.record.decided_by).toBe("@custom-author");
    });

    // AC: @triage-daemon-api ac-3 — broadcasts triage:updates
    // AC: @trait-websocket-protocol ac-3
    test("broadcasts triage_record_created to subscribed clients", async ({
      request,
      page,
      daemon,
    }) => {
      await subscribeToTriageUpdates(page, daemon.baseUrl, daemon.wsUrl);

      // Create a fresh inbox item for deterministic broadcast data
      const inboxResponse = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: `Broadcast create test ${Date.now()}` },
      });
      expect(inboxResponse.status()).toBe(200);
      const inbox = await inboxResponse.json();

      const broadcastPromise = waitForTriageBroadcast(page, "triage_record_created");
      const triageResponse = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          inbox_ref: `@${inbox.item._ulid}`,
          action: "defer",
          reasoning: "Broadcast check",
        },
      });

      expect(triageResponse.status()).toBe(200);
      const triage = await triageResponse.json();
      const broadcast = await broadcastPromise;

      expect(broadcast.topic).toBe("triage:updates");
      expect(broadcast.event).toBe("triage_record_created");
      expect(typeof broadcast.msg_id).toBe("string");
      expect(typeof broadcast.seq).toBe("number");
      expect(typeof broadcast.timestamp).toBe("string");
      expect(broadcast.data.ulid).toBe(triage.record._ulid);
      expect(broadcast.data.inbox_ref).toBe(inbox.item._ulid);
      expect(broadcast.data.action).toBe("defer");
    });

    // AC: @triage-daemon-api ac-7 — 404 for nonexistent inbox item
    test("returns 404 for nonexistent inbox item reference", async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          inbox_ref: "@01ZZZZZZZZZZZZZZZZZZZZZZZY",
          action: "defer",
          reasoning: "Should fail",
        },
      });

      expect(response.status()).toBe(404);

      const body = await response.json();
      expect(body.error).toBe("not_found");
      expect(body).toHaveProperty("message");
      expect(body).toHaveProperty("suggestion");
    });

    // AC: @trait-api-endpoint ac-3 — validation error for invalid action
    test("returns 400 with validation details for invalid action", async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          inbox_ref: `@${INBOX_ITEM_1_ULID}`,
          action: "invalid-action-xyz",
          reasoning: "Test invalid action",
        },
      });

      expect(response.status()).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("validation_error");
      expect(body).toHaveProperty("details");
      expect(Array.isArray(body.details)).toBe(true);
      expect(body.details[0].field).toBe("action");
    });

    // AC: @trait-api-endpoint ac-3 — missing required fields → Elysia validation
    test("returns 422 when required fields are missing", async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          // Missing inbox_ref, action, reasoning
        },
      });

      expect(response.status()).toBe(422);
    });
  });

  test.describe("POST /api/triage/:ref/override", () => {
    // AC: @triage-daemon-api ac-4 — override sets fields and updates action
    test("sets override fields and updates action on triaged record", async ({
      request,
      daemon,
    }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/triage/@${FIXTURE_TRIAGE_TRIAGED_ULID}/override`,
        {
          data: {
            action: "promote",
            reasoning: "Changed my mind, this should be promoted",
          },
        },
      );

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body).toHaveProperty("record");

      const record = body.record;
      expect(record.action).toBe("promote");
      expect(record.override_reasoning).toBe("Changed my mind, this should be promoted");
      expect(record).toHaveProperty("override_by");
      expect(record).toHaveProperty("override_at");
    });

    // AC: @triage-daemon-api ac-4 — override on acted_on re-triages it
    test("resets acted_on record back to triaged status on override", async ({
      request,
      daemon,
    }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/triage/@${FIXTURE_TRIAGE_ACTED_ULID}/override`,
        {
          data: {
            action: "defer",
            reasoning: "Actually defer this one",
          },
        },
      );

      expect(response.status()).toBe(200);

      const body = await response.json();
      // After override, acted_on → triaged (so it can be re-acted)
      expect(body.record.status).toBe("triaged");
      expect(body.record.acted_at).toBeUndefined();
      expect(body.record.result_ref).toBeUndefined();
    });

    // AC: @triage-daemon-api ac-4 — override with custom override_by
    test("accepts optional override_by field", async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/triage/@${FIXTURE_TRIAGE_TRIAGED_ULID}/override`,
        {
          data: {
            action: "delete",
            reasoning: "Override by specific author",
            override_by: "@specific-reviewer",
          },
        },
      );

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.record.override_by).toBe("@specific-reviewer");
    });

    // AC: @triage-daemon-api ac-4 — broadcasts triage:updates
    // AC: @trait-websocket-protocol ac-3
    test("broadcasts triage_record_updated when overriding a record", async ({
      request,
      page,
      daemon,
    }) => {
      // Create a record first so this test is not fixture-dependent.
      const inboxResponse = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: `Broadcast override test ${Date.now()}` },
      });
      expect(inboxResponse.status()).toBe(200);
      const inbox = await inboxResponse.json();

      const triageResponse = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          inbox_ref: `@${inbox.item._ulid}`,
          action: "defer",
          reasoning: "Initial decision",
        },
      });
      expect(triageResponse.status()).toBe(200);
      const triage = await triageResponse.json();

      await subscribeToTriageUpdates(page, daemon.baseUrl, daemon.wsUrl);

      const broadcastPromise = waitForTriageBroadcast(page, "triage_record_updated");
      const response = await request.post(
        `${daemon.baseUrl}/api/triage/@${triage.record._ulid}/override`,
        {
          data: {
            action: "promote",
            reasoning: "Broadcast override check",
          },
        },
      );

      expect(response.status()).toBe(200);
      const body = await response.json();
      const broadcast = await broadcastPromise;

      expect(broadcast.topic).toBe("triage:updates");
      expect(broadcast.event).toBe("triage_record_updated");
      expect(broadcast.data.ulid).toBe(body.record._ulid);
      expect(broadcast.data.action).toBe("override");
      expect(broadcast.data.new_action).toBe("promote");
    });

    // AC: @trait-api-endpoint ac-2 — 404 for nonexistent ref
    test("returns 404 for nonexistent triage record ref", async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/triage/@nonexistent-triage-ref-xyz/override`,
        {
          data: {
            action: "defer",
            reasoning: "Should fail",
          },
        },
      );

      expect(response.status()).toBe(404);

      const body = await response.json();
      expect(body.error).toBe("not_found");
      expect(body).toHaveProperty("message");
      expect(body).toHaveProperty("suggestion");
    });

    // AC: @trait-api-endpoint ac-3 — invalid action validation
    test("returns 400 for invalid action on override", async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/triage/@${FIXTURE_TRIAGE_TRIAGED_ULID}/override`,
        {
          data: {
            action: "invalid-action",
            reasoning: "Test",
          },
        },
      );

      expect(response.status()).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("validation_error");
      expect(body.details[0].field).toBe("action");
    });
  });

  test.describe("POST /api/triage/:ref/act", () => {
    // AC: @triage-daemon-api ac-5 — execute action on triaged record
    test("executes action and transitions record to acted_on", async ({ request, daemon }) => {
      // First create a fresh inbox item and triage record in 'triaged' status
      const inboxResponse = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: `Act test item ${Date.now()}` },
      });
      expect(inboxResponse.status()).toBe(200);
      const inbox = await inboxResponse.json();

      // Create triage record
      const triageResponse = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          inbox_ref: `@${inbox.item._ulid}`,
          action: "delete",
          reasoning: "This item is stale and should be deleted",
        },
      });
      expect(triageResponse.status()).toBe(200);
      const triage = await triageResponse.json();
      const triageRef = triage.record._ulid;

      // Act on it (delete action — removes the inbox item)
      const actResponse = await request.post(`${daemon.baseUrl}/api/triage/@${triageRef}/act`);

      expect(actResponse.status()).toBe(200);

      const body = await actResponse.json();
      expect(body.success).toBe(true);
      expect(body.record.status).toBe("acted_on");
      expect(body.record).toHaveProperty("acted_at");
    });

    // AC: @triage-daemon-api ac-5 — defer action
    test("executes defer action successfully", async ({ request, daemon }) => {
      // Create a fresh inbox item + triage record for defer action
      const inboxResponse = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: `Defer act test ${Date.now()}` },
      });
      expect(inboxResponse.status()).toBe(200);
      const inbox = await inboxResponse.json();

      const triageResponse = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          inbox_ref: `@${inbox.item._ulid}`,
          action: "defer",
          reasoning: "Not now",
        },
      });
      expect(triageResponse.status()).toBe(200);
      const triage = await triageResponse.json();

      const actResponse = await request.post(
        `${daemon.baseUrl}/api/triage/@${triage.record._ulid}/act`,
      );

      expect(actResponse.status()).toBe(200);
      const body = await actResponse.json();
      expect(body.record.status).toBe("acted_on");
      expect(body.record.action).toBe("defer");
    });

    // AC: @triage-daemon-api ac-5 — acted record appears updated in list
    test("acted record status appears as acted_on in GET /api/triage", async ({
      request,
      daemon,
    }) => {
      // Create fresh inbox item + triage + act
      const inboxResponse = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: `List verification act ${Date.now()}` },
      });
      const inbox = await inboxResponse.json();

      const triageResponse = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          inbox_ref: `@${inbox.item._ulid}`,
          action: "defer",
          reasoning: "Defer",
        },
      });
      const triage = await triageResponse.json();

      await request.post(`${daemon.baseUrl}/api/triage/@${triage.record._ulid}/act`);

      // Verify the list reflects acted_on status
      const listResponse = await request.get(`${daemon.baseUrl}/api/triage?status=acted_on`);
      const list = await listResponse.json();
      const found = list.items.find((r: { _ulid: string }) => r._ulid === triage.record._ulid);
      expect(found).toBeDefined();
      expect(found.status).toBe("acted_on");
    });

    // AC: @triage-daemon-api ac-5 — broadcasts triage:updates
    // AC: @trait-websocket-protocol ac-3
    test("broadcasts triage_record_acted with result_ref when action is executed", async ({
      request,
      page,
      daemon,
    }) => {
      // Create inbox item + triaged record with promote action so act yields result_ref
      const inboxResponse = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: `Broadcast act test ${Date.now()}` },
      });
      expect(inboxResponse.status()).toBe(200);
      const inbox = await inboxResponse.json();

      const triageResponse = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          inbox_ref: `@${inbox.item._ulid}`,
          action: "promote",
          reasoning: "Promote for broadcast test",
        },
      });
      expect(triageResponse.status()).toBe(200);
      const triage = await triageResponse.json();

      await subscribeToTriageUpdates(page, daemon.baseUrl, daemon.wsUrl);

      const broadcastPromise = waitForTriageBroadcast(page, "triage_record_acted");
      const actResponse = await request.post(
        `${daemon.baseUrl}/api/triage/@${triage.record._ulid}/act`,
      );
      expect(actResponse.status()).toBe(200);
      const acted = await actResponse.json();
      const broadcast = await broadcastPromise;

      expect(broadcast.topic).toBe("triage:updates");
      expect(broadcast.event).toBe("triage_record_acted");
      expect(broadcast.data.ulid).toBe(acted.record._ulid);
      expect(broadcast.data.action).toBe("promote");
      expect(acted.record.result_ref).toBeTruthy();
      expect(broadcast.data.result_ref).toBe(acted.record.result_ref);
    });

    // AC: @triage-daemon-api ac-8 — 409 for already acted_on record
    test("returns 409 when acting on already acted_on record", async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/triage/@${FIXTURE_TRIAGE_ACTED_ULID}/act`,
      );

      expect(response.status()).toBe(409);

      const body = await response.json();
      expect(body.error).toBe("invalid_transition");
      expect(body).toHaveProperty("message");
      expect(body.message).toContain("acted on");
      expect(body).toHaveProperty("current");
      expect(body).toHaveProperty("suggestion");
    });

    // AC: @triage-daemon-api ac-9 — 422 for pending record
    test("returns 422 when acting on pending record with no decision", async ({
      request,
      daemon,
    }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/triage/@${FIXTURE_TRIAGE_PENDING_ULID}/act`,
      );

      expect(response.status()).toBe(422);

      const body = await response.json();
      expect(body.error).toBe("incomplete_record");
      expect(body).toHaveProperty("message");
      expect(body.message).toContain("Complete triage first");
      expect(body).toHaveProperty("suggestion");
    });

    // AC: @trait-api-endpoint ac-2 — 404 for nonexistent ref
    test("returns 404 for nonexistent triage record ref", async ({ request, daemon }) => {
      const response = await request.post(
        `${daemon.baseUrl}/api/triage/@nonexistent-triage-xyz/act`,
      );

      expect(response.status()).toBe(404);

      const body = await response.json();
      expect(body.error).toBe("not_found");
      expect(body).toHaveProperty("message");
      expect(body).toHaveProperty("suggestion");
    });
  });

  test.describe("Upsert correctness", () => {
    // AC: @triage-daemon-api ac-3 — upsert on inbox_ref (one record per inbox item)
    test("second POST for same inbox item updates existing record (upsert)", async ({
      request,
      daemon,
    }) => {
      // Create fresh inbox item
      const inboxResponse = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: `Upsert test ${Date.now()}` },
      });
      expect(inboxResponse.status()).toBe(200);
      const inbox = await inboxResponse.json();
      const inboxUlid = inbox.item._ulid;

      // First triage — defer
      const firstResponse = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          inbox_ref: `@${inboxUlid}`,
          action: "defer",
          reasoning: "First decision",
        },
      });
      expect(firstResponse.status()).toBe(200);
      const firstBody = await firstResponse.json();
      const firstUlid = firstBody.record._ulid;

      // Second triage — spec-gap (should upsert, same ULID)
      const secondResponse = await request.post(`${daemon.baseUrl}/api/triage`, {
        data: {
          inbox_ref: `@${inboxUlid}`,
          action: "spec-gap",
          reasoning: "Changed mind",
        },
      });
      expect(secondResponse.status()).toBe(200);
      const secondBody = await secondResponse.json();

      // Same ULID (upsert, not duplicate)
      expect(secondBody.record._ulid).toBe(firstUlid);
      expect(secondBody.record.action).toBe("spec-gap");

      // Only 1 record for this inbox item
      const listResponse = await request.get(`${daemon.baseUrl}/api/triage`);
      const list = await listResponse.json();
      const recordsForItem = list.items.filter(
        (r: { inbox_ref: string }) => r.inbox_ref === inboxUlid,
      );
      expect(recordsForItem.length).toBe(1);
    });
  });
});
