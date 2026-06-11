/**
 * Daemon API route-handler integration tests for triage endpoints.
 *
 * Ported from the (fully skipped) Playwright suite tests/e2e/api-triage.spec.ts.
 * Exercises the production createTriageRoutes handlers in-process via
 * createTestApp()/app.handle(); broadcast side effects are asserted with
 * captureBroadcasts(pubsub) instead of a real WebSocket client.
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
// @trait-api-endpoint ac-5 — covered behaviorally: the "Shadow commits" describe block below runs the
//   three mutation routes against a real kspec-meta worktree and asserts the semantic commit subjects.
// AC: @trait-api-endpoint ac-6 — N/A: X-Request-Id header is server-level infrastructure; not asserted in route-handler integration tests
// AC: @trait-websocket-protocol ac-1 — N/A: server connection lifecycle; tested in daemon-api/websocket-protocol.test.ts
// AC: @trait-websocket-protocol ac-2 — N/A: WebSocket subscribe command; tested in daemon-api/websocket-protocol.test.ts
// AC: @trait-websocket-protocol ac-3 — covered: triage mutation routes emit triage:updates broadcasts (asserted via captureBroadcasts below); the {msg_id, seq, timestamp, topic, event, data} envelope is applied by PubSubManager and tested in daemon-api/websocket-protocol.test.ts
// AC: @trait-websocket-protocol ac-4 — N/A: heartbeat timing tested in daemon-heartbeat.test.ts
// AC: @trait-websocket-protocol ac-5 — N/A: pong-timeout handling tested in daemon-heartbeat.test.ts
// AC: @trait-websocket-protocol ac-6 — N/A: backpressure handling is outside this triage-focused spec
// AC: @trait-websocket-protocol ac-7 — N/A: clean shutdown code tested in daemon-api/websocket-protocol.test.ts; timeout close code tested in daemon-heartbeat.test.ts
// AC: @trait-websocket-protocol ac-8 — N/A: reconnection behavior tested in tests/e2e/connection.spec.ts

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PubSubManager } from "../../dist/daemon/websocket/pubsub.js";
import {
  captureBroadcasts,
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  requestJson,
  setupFixtures,
  testUlid,
} from "./helpers.js";

// Fixture ULIDs defined in tests/e2e/fixtures/project.triage.yaml (setupFixtures
// copies the same files the Playwright daemon fixture used, so these match the
// constants from the retired E2E suite).
// TRIAGED record: inbox_ref = 01KJNBX0CA45ZT43W2T6HJMVA1 ("First inbox item for testing"), status=triaged
const FIXTURE_TRIAGE_TRIAGED_ULID = "01KJC3NZ8Y268B3KFD2NVS6613";
// ACTED_ON record: inbox_ref = 01KJNBX1CC9N4YGP991WD7XS8S ("Second inbox item"), status=acted_on
const FIXTURE_TRIAGE_ACTED_ULID = "01KJC3NZD5QFP9N0FCKX9D90KR";
// PENDING record: inbox_ref = 01KJNBX2CB8N4YGP991WD7XS9R ("Third inbox item"), status=pending
const FIXTURE_TRIAGE_PENDING_ULID = "01KJC3NZHCBKZMDKQNZ28JNRG2";

// Inbox item ULID from project.inbox.yaml (used for POST /api/triage upsert case)
const INBOX_ITEM_1_ULID = "01KJNBX0CA45ZT43W2T6HJMVA1"; // First inbox item — already has a triage record

let tempDir: string;
let app: Elysia;
let pubsub: PubSubManager;

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-triage-");
  initGitRepo(tempDir);
  setupFixtures(tempDir);
  ({ app, pubsub } = createTestApp());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDir(tempDir);
});

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

function postJson(urlPath: string, body?: unknown) {
  return requestJson(app, tempDir, "POST", urlPath, body);
}

/** Create a fresh inbox item and return its ULID. */
async function createInboxItem(text: string): Promise<string> {
  const response = await postJson("/api/inbox", { text });
  expect(response.status).toBe(200);
  const body = await response.json();
  return body.item._ulid;
}

/** Create a fresh inbox item plus a triaged record for it; returns both ULIDs. */
async function createTriagedRecord(
  text: string,
  action: string,
  reasoning: string,
): Promise<{ inboxUlid: string; record: { _ulid: string; [key: string]: unknown } }> {
  const inboxUlid = await createInboxItem(text);
  const response = await postJson("/api/triage", {
    inbox_ref: `@${inboxUlid}`,
    action,
    reasoning,
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  return { inboxUlid, record: body.record };
}

describe("GET /api/triage", () => {
  // AC: @triage-daemon-api ac-1
  it("returns triage records array with total, sorted by created_at desc", async () => {
    const response = await request("/api/triage");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("meta");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.meta.total).toBe(body.data.length);
  });

  // AC: @triage-daemon-api ac-1 — sorted by created_at desc
  it("returns records sorted by created_at descending (newest first)", async () => {
    const response = await request("/api/triage");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data.length).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < body.data.length - 1; i++) {
      const current = new Date(body.data[i].created_at).getTime();
      const next = new Date(body.data[i + 1].created_at).getTime();
      expect(current).toBeGreaterThanOrEqual(next);
    }
  });

  // AC: @triage-daemon-api ac-1 — fixture records loaded
  it("returns fixture triage records with correct fields", async () => {
    const response = await request("/api/triage");
    expect(response.status).toBe(200);

    const body = await response.json();
    // We have 3 fixture records
    expect(body.data.length).toBe(3);

    const item = body.data[0];
    expect(item).toHaveProperty("_ulid");
    expect(item).toHaveProperty("inbox_ref");
    expect(item).toHaveProperty("item_snapshot");
    expect(item).toHaveProperty("status");
    expect(item).toHaveProperty("created_at");
  });

  // AC: @triage-daemon-api ac-1 — JSON content type
  // AC: @trait-api-endpoint ac-1
  it("returns JSON content type", async () => {
    const response = await request("/api/triage");
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  // AC: @triage-daemon-api ac-2 — status filter
  it("filters records by status query parameter", async () => {
    const response = await request("/api/triage?status=triaged");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);

    for (const item of body.data) {
      expect(item.status).toBe("triaged");
    }
  });

  // AC: @triage-daemon-api ac-2 — filter for acted_on
  it("filters records by acted_on status", async () => {
    const response = await request("/api/triage?status=acted_on");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0]._ulid).toBe(FIXTURE_TRIAGE_ACTED_ULID);
    expect(body.data[0].status).toBe("acted_on");
  });

  // AC: @triage-daemon-api ac-2 — filter for pending
  it("filters records by pending status", async () => {
    const response = await request("/api/triage?status=pending");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0]._ulid).toBe(FIXTURE_TRIAGE_PENDING_ULID);
    expect(body.data[0].status).toBe("pending");
  });

  // AC: @trait-api-endpoint ac-4 — pagination
  it("supports limit and offset pagination", async () => {
    const allResponse = await request("/api/triage");
    const allBody = await allResponse.json();
    const totalCount = allBody.meta.total;

    const pagedResponse = await request("/api/triage?limit=1&offset=0");
    expect(pagedResponse.status).toBe(200);

    const pagedBody = await pagedResponse.json();
    expect(pagedBody.data.length).toBe(1);
    expect(pagedBody.meta.total).toBe(totalCount);
    expect(pagedBody.meta.offset).toBe(0);
    expect(pagedBody.meta.limit).toBe(1);
  });

  // AC: @trait-api-endpoint ac-4 — pagination offset
  it("pagination offset skips records", async () => {
    const firstResponse = await request("/api/triage?limit=1&offset=0");
    const secondResponse = await request("/api/triage?limit=1&offset=1");

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    const firstBody = await firstResponse.json();
    const secondBody = await secondResponse.json();

    expect(firstBody.data[0]._ulid).not.toBe(secondBody.data[0]._ulid);
  });
});

describe("GET /api/triage/export", () => {
  // AC: @triage-daemon-api ac-6 — JSON export format
  it("exports triage records as JSON by default", async () => {
    const response = await request("/api/triage/export");
    expect(response.status).toBe(200);

    const body = await response.json();
    // Default format is json: {format: "json", items: [...], total: N}
    expect(body).toHaveProperty("format", "json");
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body).toHaveProperty("total");
    expect(body.total).toBe(body.items.length);
  });

  // AC: @triage-daemon-api ac-6 — JSON format explicit
  it("exports triage records as JSON when format=json", async () => {
    const response = await request("/api/triage/export?format=json");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.format).toBe("json");
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body.total).toBe(3); // 3 fixture records
  });

  // AC: @triage-daemon-api ac-6 — context markdown format
  it("exports triage records as context markdown when format=context", async () => {
    const response = await request("/api/triage/export?format=context");
    expect(response.status).toBe(200);

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
  it("supports status filter on export", async () => {
    const response = await request("/api/triage/export?format=json&status=triaged");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.format).toBe("json");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const record of body.items) {
      expect(record.status).toBe("triaged");
    }
  });
});

describe("GET /api/triage/:ref", () => {
  // AC: @trait-api-endpoint ac-1 — single record retrieval
  it("returns single triage record by ULID ref", async () => {
    const response = await request(`/api/triage/@${FIXTURE_TRIAGE_TRIAGED_ULID}`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data._ulid).toBe(FIXTURE_TRIAGE_TRIAGED_ULID);
    expect(body.data.status).toBe("triaged");
    expect(body.data.action).toBe("defer");
  });

  // AC: @trait-api-endpoint ac-2 — 404 for nonexistent ref
  it("returns 404 with error/message/suggestion for nonexistent ref", async () => {
    const response = await request("/api/triage/@nonexistent-triage-ref-xyz");
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toBe("not_found");
    expect(body).toHaveProperty("message");
    expect(typeof body.message).toBe("string");
    expect(body).toHaveProperty("suggestion");
    expect(typeof body.suggestion).toBe("string");
  });
});

describe("POST /api/triage", () => {
  // AC: @triage-daemon-api ac-3 — create record with item_snapshot
  it("creates triage record with item_snapshot from inbox item", async () => {
    // Use inbox item 1 which already has a "triaged" fixture record — upsert case
    const response = await postJson("/api/triage", {
      inbox_ref: `@${INBOX_ITEM_1_ULID}`,
      action: "defer",
      reasoning: "Not a priority right now",
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("success");
    expect(body.success).toBe(true);
    expect(body).toHaveProperty("record");

    const record = body.record;
    expect(record).toHaveProperty("_ulid");
    expect(record.inbox_ref).toBe(INBOX_ITEM_1_ULID);
    // item_snapshot should be set from the inbox item text
    expect(record.item_snapshot).toContain("First inbox item for testing");
    expect(record.action).toBe("defer");
    expect(record.status).toBe("triaged");
  });

  // AC: @triage-daemon-api ac-3 — create fresh record for new inbox item
  it("creates new triage record for inbox item without existing record", async () => {
    const newInboxUlid = await createInboxItem(`Fresh item for triage ${Date.now()}`);

    const triageResponse = await postJson("/api/triage", {
      inbox_ref: `@${newInboxUlid}`,
      action: "defer",
      reasoning: "Defer this new item",
    });

    expect(triageResponse.status).toBe(200);

    const body = await triageResponse.json();
    expect(body.success).toBe(true);
    expect(body.record.inbox_ref).toBe(newInboxUlid);
    expect(body.record.status).toBe("triaged");
  });

  // AC: @triage-daemon-api ac-3 — record appears in list
  it("newly created record appears in subsequent GET /api/triage", async () => {
    const newInboxUlid = await createInboxItem(`Triage list check ${Date.now()}`);

    const triageResponse = await postJson("/api/triage", {
      inbox_ref: `@${newInboxUlid}`,
      action: "spec-gap",
      reasoning: "This reveals a spec gap",
    });
    expect(triageResponse.status).toBe(200);
    const created = await triageResponse.json();

    const listResponse = await request("/api/triage");
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json();

    const found = list.data.find((r: { _ulid: string }) => r._ulid === created.record._ulid);
    expect(found).toBeDefined();
    expect(found.action).toBe("spec-gap");
  });

  // AC: @triage-daemon-api ac-3 — supports optional decided_by
  it("creates record with optional decided_by field", async () => {
    const newInboxUlid = await createInboxItem(`Decided by test ${Date.now()}`);

    const response = await postJson("/api/triage", {
      inbox_ref: `@${newInboxUlid}`,
      action: "delete",
      reasoning: "Duplicate item",
      decided_by: "@custom-author",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.record.decided_by).toBe("@custom-author");
  });

  // AC: @triage-daemon-api ac-3 — broadcasts triage:updates
  // AC: @trait-websocket-protocol ac-3
  it("broadcasts triage_record_created on triage:updates", async () => {
    const newInboxUlid = await createInboxItem(`Broadcast create test ${Date.now()}`);

    const spy = captureBroadcasts(pubsub);
    const triageResponse = await postJson("/api/triage", {
      inbox_ref: `@${newInboxUlid}`,
      action: "defer",
      reasoning: "Broadcast check",
    });

    expect(triageResponse.status).toBe(200);
    const triage = await triageResponse.json();

    expect(spy).toHaveBeenCalledWith(
      "triage:updates",
      "triage_record_created",
      {
        ulid: triage.record._ulid,
        inbox_ref: newInboxUlid,
        action: "defer",
      },
      expect.any(String),
    );
  });

  // AC: @triage-daemon-api ac-7 — 404 for nonexistent inbox item
  it("returns 404 for nonexistent inbox item reference", async () => {
    const response = await postJson("/api/triage", {
      inbox_ref: "@01ZZZZZZZZZZZZZZZZZZZZZZZY",
      action: "defer",
      reasoning: "Should fail",
    });

    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe("not_found");
    expect(body).toHaveProperty("message");
    expect(body).toHaveProperty("suggestion");
  });

  // AC: @trait-api-endpoint ac-3 — validation error for invalid action
  it("returns 400 with validation details for invalid action", async () => {
    const response = await postJson("/api/triage", {
      inbox_ref: `@${INBOX_ITEM_1_ULID}`,
      action: "invalid-action-xyz",
      reasoning: "Test invalid action",
    });

    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(body).toHaveProperty("details");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details[0].field).toBe("action");
  });

  // AC: @trait-api-endpoint ac-3 — missing required fields → Elysia schema validation.
  // The retired E2E suite asserted Elysia's raw 422 here; the project-context
  // middleware's onError normalizes all VALIDATION errors to 400 with the
  // structured {error, details} body (see daemon-api/errors.test.ts).
  it("returns 400 validation error when required fields are missing", async () => {
    const response = await postJson("/api/triage", {});

    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(Array.isArray(body.details)).toBe(true);
  });
});

describe("POST /api/triage/:ref/override", () => {
  // AC: @triage-daemon-api ac-4 — override sets fields and updates action
  it("sets override fields and updates action on triaged record", async () => {
    const response = await postJson(`/api/triage/@${FIXTURE_TRIAGE_TRIAGED_ULID}/override`, {
      action: "promote",
      reasoning: "Changed my mind, this should be promoted",
    });

    expect(response.status).toBe(200);

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
  it("resets acted_on record back to triaged status on override", async () => {
    const response = await postJson(`/api/triage/@${FIXTURE_TRIAGE_ACTED_ULID}/override`, {
      action: "defer",
      reasoning: "Actually defer this one",
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    // After override, acted_on → triaged (so it can be re-acted)
    expect(body.record.status).toBe("triaged");
    expect(body.record.acted_at).toBeUndefined();
    expect(body.record.result_ref).toBeUndefined();
  });

  // AC: @triage-daemon-api ac-4 — override with custom override_by
  it("accepts optional override_by field", async () => {
    const response = await postJson(`/api/triage/@${FIXTURE_TRIAGE_TRIAGED_ULID}/override`, {
      action: "delete",
      reasoning: "Override by specific author",
      override_by: "@specific-reviewer",
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.record.override_by).toBe("@specific-reviewer");
  });

  // AC: @triage-daemon-api ac-4 — broadcasts triage:updates
  // AC: @trait-websocket-protocol ac-3
  it("broadcasts triage_record_updated when overriding a record", async () => {
    // Create a record first so this test is not fixture-dependent.
    const { record } = await createTriagedRecord(
      `Broadcast override test ${Date.now()}`,
      "defer",
      "Initial decision",
    );

    const spy = captureBroadcasts(pubsub);
    const response = await postJson(`/api/triage/@${record._ulid}/override`, {
      action: "promote",
      reasoning: "Broadcast override check",
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(spy).toHaveBeenCalledWith(
      "triage:updates",
      "triage_record_updated",
      {
        ulid: body.record._ulid,
        action: "override",
        new_action: "promote",
      },
      expect.any(String),
    );
  });

  // AC: @trait-api-endpoint ac-2 — 404 for nonexistent ref
  it("returns 404 for nonexistent triage record ref", async () => {
    const response = await postJson("/api/triage/@nonexistent-triage-ref-xyz/override", {
      action: "defer",
      reasoning: "Should fail",
    });

    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe("not_found");
    expect(body).toHaveProperty("message");
    expect(body).toHaveProperty("suggestion");
  });

  // AC: @trait-api-endpoint ac-3 — invalid action validation
  it("returns 400 for invalid action on override", async () => {
    const response = await postJson(`/api/triage/@${FIXTURE_TRIAGE_TRIAGED_ULID}/override`, {
      action: "invalid-action",
      reasoning: "Test",
    });

    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(body.details[0].field).toBe("action");
  });
});

describe("POST /api/triage/:ref/act", () => {
  // AC: @triage-daemon-api ac-5 — execute action on triaged record
  it("executes action and transitions record to acted_on", async () => {
    // Fresh inbox item + triage record in 'triaged' status with delete action
    const { record } = await createTriagedRecord(
      `Act test item ${Date.now()}`,
      "delete",
      "This item is stale and should be deleted",
    );

    const actResponse = await postJson(`/api/triage/@${record._ulid}/act`);

    expect(actResponse.status).toBe(200);

    const body = await actResponse.json();
    expect(body.success).toBe(true);
    expect(body.record.status).toBe("acted_on");
    expect(body.record).toHaveProperty("acted_at");
  });

  // AC: @triage-daemon-api ac-5 — defer action
  it("executes defer action successfully", async () => {
    const { record } = await createTriagedRecord(
      `Defer act test ${Date.now()}`,
      "defer",
      "Not now",
    );

    const actResponse = await postJson(`/api/triage/@${record._ulid}/act`);

    expect(actResponse.status).toBe(200);
    const body = await actResponse.json();
    expect(body.record.status).toBe("acted_on");
    expect(body.record.action).toBe("defer");
  });

  // AC: @triage-daemon-api ac-5 — acted record appears updated in list
  it("acted record status appears as acted_on in GET /api/triage", async () => {
    const { record } = await createTriagedRecord(
      `List verification act ${Date.now()}`,
      "defer",
      "Defer",
    );

    await postJson(`/api/triage/@${record._ulid}/act`);

    const listResponse = await request("/api/triage?status=acted_on");
    const list = await listResponse.json();
    const found = list.data.find((r: { _ulid: string }) => r._ulid === record._ulid);
    expect(found).toBeDefined();
    expect(found.status).toBe("acted_on");
  });

  // AC: @triage-daemon-api ac-5 — broadcasts triage:updates
  // AC: @trait-websocket-protocol ac-3
  it("broadcasts triage_record_acted with result_ref when action is executed", async () => {
    // Promote action so act yields a result_ref (the created task)
    const { record } = await createTriagedRecord(
      `Broadcast act test ${Date.now()}`,
      "promote",
      "Promote for broadcast test",
    );

    const spy = captureBroadcasts(pubsub);
    const actResponse = await postJson(`/api/triage/@${record._ulid}/act`);
    expect(actResponse.status).toBe(200);
    const acted = await actResponse.json();

    expect(acted.record.result_ref).toBeTruthy();
    expect(spy).toHaveBeenCalledWith(
      "triage:updates",
      "triage_record_acted",
      {
        ulid: acted.record._ulid,
        action: "promote",
        result_ref: acted.record.result_ref,
      },
      expect.any(String),
    );
  });

  // AC: @triage-daemon-api ac-8 — 409 for already acted_on record
  it("returns 409 when acting on already acted_on record", async () => {
    const response = await postJson(`/api/triage/@${FIXTURE_TRIAGE_ACTED_ULID}/act`);

    expect(response.status).toBe(409);

    const body = await response.json();
    expect(body.error).toBe("invalid_transition");
    expect(body).toHaveProperty("message");
    expect(body.message).toContain("acted on");
    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("suggestion");
  });

  // AC: @triage-daemon-api ac-9 — 422 for pending record
  it("returns 422 when acting on pending record with no decision", async () => {
    const response = await postJson(`/api/triage/@${FIXTURE_TRIAGE_PENDING_ULID}/act`);

    expect(response.status).toBe(422);

    const body = await response.json();
    expect(body.error).toBe("incomplete_record");
    expect(body).toHaveProperty("message");
    expect(body.message).toContain("Complete triage first");
    expect(body).toHaveProperty("suggestion");
  });

  // AC: @trait-api-endpoint ac-2 — 404 for nonexistent ref
  it("returns 404 for nonexistent triage record ref", async () => {
    const response = await postJson("/api/triage/@nonexistent-triage-xyz/act");

    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe("not_found");
    expect(body).toHaveProperty("message");
    expect(body).toHaveProperty("suggestion");
  });
});

describe("Shadow commits", () => {
  // setupFixtures() (used by the suite-level beforeEach) creates only a fake
  // worktree pointer — enough for shadow *detection*, but git commands inside
  // .kspec/ fail silently, so commitIfShadow never commits there. This block
  // builds a project whose .kspec/ is a REAL linked worktree on an orphan
  // kspec-meta branch so the mutation routes' shadow commits actually land
  // and their semantic messages can be asserted from git history.
  const SHADOW_INBOX_ULID = testUlid();
  let shadowProjectDir: string;

  beforeEach(async () => {
    shadowProjectDir = await createTempDir("kspec-daemon-api-triage-shadow-");
    initGitRepo(shadowProjectDir);
    writeFileSync(path.join(shadowProjectDir, "README.md"), "# Shadow commit test project\n");
    execSync('git add -A && git commit -m "initial"', { cwd: shadowProjectDir, stdio: "pipe" });

    // Orphan-style kspec-meta branch rooted at the empty tree, attached as
    // the .kspec worktree. Uses plumbing (mktree/commit-tree) instead of
    // `git worktree add --orphan`, which requires git >= 2.42.
    const emptyTree = execSync("git mktree", {
      cwd: shadowProjectDir,
      input: "",
      encoding: "utf-8",
    }).trim();
    const rootCommit = execSync(`git commit-tree ${emptyTree} -m "Initialize spec"`, {
      cwd: shadowProjectDir,
      encoding: "utf-8",
    }).trim();
    execSync(`git branch kspec-meta ${rootCommit}`, { cwd: shadowProjectDir, stdio: "pipe" });
    execSync("git worktree add .kspec kspec-meta", { cwd: shadowProjectDir, stdio: "pipe" });

    // Minimal shadow-mode project: in shadow mode specDir is .kspec/, so all
    // project files live inside the worktree.
    const specDir = path.join(shadowProjectDir, ".kspec");
    mkdirSync(path.join(specDir, "modules"), { recursive: true });
    writeFileSync(
      path.join(specDir, "kynetic.yaml"),
      `kynetic: "1.1"
task_storage:
  format: split
project:
  name: Shadow Commit Test
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
`,
    );
    writeFileSync(path.join(specDir, "modules", "test.yaml"), "features: []\n");
    writeFileSync(
      path.join(specDir, "project.inbox.yaml"),
      `inbox:
  - _ulid: "${SHADOW_INBOX_ULID}"
    text: Shadow commit test item
    tags: []
    added_by: test-user
    created_at: "2026-01-01T10:00:00Z"
`,
    );
    mkdirSync(path.join(shadowProjectDir, ".kspec-sessions"), { recursive: true });
    execSync('git add -A && git commit -m "seed project"', {
      cwd: specDir,
      stdio: "pipe",
    });
  });

  afterEach(async () => {
    await cleanupTempDir(shadowProjectDir);
  });

  function shadowCommitSubjects(): string[] {
    return execSync("git log --format=%s kspec-meta", {
      cwd: shadowProjectDir,
      encoding: "utf-8",
    })
      .trim()
      .split("\n");
  }

  // AC: @trait-api-endpoint ac-5
  it("each mutation route creates a semantic shadow commit on kspec-meta", async () => {
    const baselineCount = shadowCommitSubjects().length;

    // POST /api/triage — record a decision
    const recordResponse = await requestJson(app, shadowProjectDir, "POST", "/api/triage", {
      inbox_ref: `@${SHADOW_INBOX_ULID}`,
      action: "defer",
      reasoning: "Shadow commit assertion",
    });
    expect(recordResponse.status).toBe(200);
    const recordBody = await recordResponse.json();
    const shortUlid = recordBody.record._ulid.slice(0, 8);

    let subjects = shadowCommitSubjects();
    expect(subjects.length).toBe(baselineCount + 1);
    expect(subjects[0]).toBe(`triage: record ${shortUlid} as defer`);

    // POST /api/triage/:ref/override — override the decision
    const overrideResponse = await requestJson(
      app,
      shadowProjectDir,
      "POST",
      `/api/triage/@${recordBody.record._ulid}/override`,
      { action: "delete", reasoning: "Override for shadow commit assertion" },
    );
    expect(overrideResponse.status).toBe(200);

    subjects = shadowCommitSubjects();
    expect(subjects.length).toBe(baselineCount + 2);
    expect(subjects[0]).toBe(`triage: override ${shortUlid}`);

    // POST /api/triage/:ref/act — execute the action
    const actResponse = await requestJson(
      app,
      shadowProjectDir,
      "POST",
      `/api/triage/@${recordBody.record._ulid}/act`,
    );
    expect(actResponse.status).toBe(200);

    subjects = shadowCommitSubjects();
    expect(subjects.length).toBe(baselineCount + 3);
    expect(subjects[0]).toBe(`triage: act ${shortUlid}`);
  });
});

describe("Upsert correctness", () => {
  // AC: @triage-daemon-api ac-3 — upsert on inbox_ref (one record per inbox item)
  it("second POST for same inbox item updates existing record (upsert)", async () => {
    const inboxUlid = await createInboxItem(`Upsert test ${Date.now()}`);

    // First triage — defer
    const firstResponse = await postJson("/api/triage", {
      inbox_ref: `@${inboxUlid}`,
      action: "defer",
      reasoning: "First decision",
    });
    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json();
    const firstUlid = firstBody.record._ulid;

    // Second triage — spec-gap (should upsert, same ULID)
    const secondResponse = await postJson("/api/triage", {
      inbox_ref: `@${inboxUlid}`,
      action: "spec-gap",
      reasoning: "Changed mind",
    });
    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json();

    // Same ULID (upsert, not duplicate)
    expect(secondBody.record._ulid).toBe(firstUlid);
    expect(secondBody.record.action).toBe("spec-gap");

    // Only 1 record for this inbox item
    const listResponse = await request("/api/triage");
    const list = await listResponse.json();
    const recordsForItem = list.data.filter(
      (r: { inbox_ref: string }) => r.inbox_ref === inboxUlid,
    );
    expect(recordsForItem.length).toBe(1);
  });
});
