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
  tempDir = await createTempDir("kspec-daemon-api-inbox-");
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

// Fixture inbox item ULIDs (from tests/e2e/fixtures/project.inbox.yaml)
const FIXTURE_ULID_1 = "01KJNBX0CA45ZT43W2T6HJMVA1";
const FIXTURE_ULID_2 = "01KJNBX1CC9N4YGP991WD7XS8S";
const FIXTURE_ULID_3 = "01KJNBX2CB8N4YGP991WD7XS9R";

describe("GET /api/inbox", () => {
  it("returns items as array with total", async () => {
    const response = await request("/api/inbox");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.meta.total).toBe("number");
  });

  it("returns items ordered by created_at descending", async () => {
    const response = await request("/api/inbox");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThanOrEqual(3);

    const timestamps = body.data.map((item: { created_at: string }) =>
      new Date(item.created_at).getTime(),
    );
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
    }
  });

  it("each item has required fields", async () => {
    const response = await request("/api/inbox");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThan(0);

    const item = body.data[0];
    expect(item).toHaveProperty("_ulid");
    expect(item).toHaveProperty("text");
    expect(item).toHaveProperty("created_at");
  });

  it("fixture data integrity: first item is newest", async () => {
    const response = await request("/api/inbox");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThanOrEqual(3);

    // Fixture items are ordered newest first (2026-01-01T10:00:00Z is newest)
    expect(body.data[0]._ulid).toBe(FIXTURE_ULID_1);
    // Fixture text includes backticks: "First inbox item for testing with `kspec triage`"
    expect(body.data[0].text).toContain("First inbox item for testing");
  });

  it("fixture data integrity: second item", async () => {
    const response = await request("/api/inbox");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThanOrEqual(3);

    expect(body.data[1]._ulid).toBe(FIXTURE_ULID_2);
    expect(body.data[1].text).toContain("Second inbox item");
  });

  it("fixture data integrity: third item is oldest", async () => {
    const response = await request("/api/inbox");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThanOrEqual(3);

    expect(body.data[2]._ulid).toBe(FIXTURE_ULID_3);
    expect(body.data[2].text).toContain("Third inbox item");
  });

  it("returns JSON content type", async () => {
    const response = await request("/api/inbox");
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("POST /api/inbox", () => {
  // POST /api/inbox returns { success: true, item: {...} } with status 200
  it("creates item and returns it with a ULID", async () => {
    const response = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ text: "A new inbox item" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.item).toBeDefined();
    expect(typeof body.item._ulid).toBe("string");
    expect(body.item._ulid.length).toBeGreaterThan(0);
  });

  it("assigns a ULID to the created item", async () => {
    const response = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ text: "Item needing a ULID" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    // ULIDs are 26 characters in Crockford base32
    expect(body.item._ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("newly created item appears in list", async () => {
    const createResponse = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ text: "Unique item for list check" }),
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();

    const listResponse = await request("/api/inbox");
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json();

    const found = list.data.find((item: { _ulid: string }) => item._ulid === created.item._ulid);
    expect(found).toBeDefined();
  });

  it("accepts optional tags", async () => {
    const response = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ text: "Tagged inbox item", tags: ["mvp", "cli"] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.item.tags).toEqual(expect.arrayContaining(["mvp", "cli"]));
  });

  it("accepts optional added_by", async () => {
    // `@task-worker` is a configured-agent variant; the shared actor-write
    // utility persists the canonical roster id (`task-worker`).
    const response = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ text: "Item with author", added_by: "@task-worker" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.item.added_by).toBe("task-worker");
  });

  it("sets created_at timestamp", async () => {
    const before = new Date().toISOString();
    const response = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ text: "Timestamped item" }),
    });
    const after = new Date().toISOString();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.item.created_at).toBeDefined();
    expect(body.item.created_at >= before).toBe(true);
    expect(body.item.created_at <= after).toBe(true);
  });

  // Elysia schema validation for missing required field normalized to 400 by onError handler
  it("returns 400 when text is missing", async () => {
    const response = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ tags: ["mvp"] }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 when text is empty string", async () => {
    const response = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ text: "" }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 when text is whitespace only", async () => {
    const response = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ text: "   " }),
    });
    expect(response.status).toBe(400);
  });
});

describe("DELETE /api/inbox/:ref", () => {
  // DELETE uses @-prefixed ULID in the URL, returns { success: true, deleted: <ulid> }
  it("deletes item and returns success", async () => {
    const createResponse = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ text: "Item to delete" }),
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();
    const ulid = created.item._ulid;

    const deleteResponse = await request(`/api/inbox/@${ulid}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    const body = await deleteResponse.json();
    expect(body.success).toBe(true);
    expect(body.deleted).toBe(ulid);
  });

  it("deleted item is removed from list", async () => {
    const createResponse = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ text: "Item to be removed from list" }),
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();
    const ulid = created.item._ulid;

    await request(`/api/inbox/@${ulid}`, { method: "DELETE" });

    const listResponse = await request("/api/inbox");
    const list = await listResponse.json();
    const found = list.data.find((item: { _ulid: string }) => item._ulid === ulid);
    expect(found).toBeUndefined();
  });

  it("deletes item by full ULID ref", async () => {
    const deleteResponse = await request(`/api/inbox/@${FIXTURE_ULID_3}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    const listResponse = await request("/api/inbox");
    const list = await listResponse.json();
    const found = list.data.find((item: { _ulid: string }) => item._ulid === FIXTURE_ULID_3);
    expect(found).toBeUndefined();
  });

  it("returns 404 for nonexistent item", async () => {
    const response = await request("/api/inbox/@01ZZZZZZZZZZZZZZZZZZZZZZZ0", { method: "DELETE" });
    expect(response.status).toBe(404);
  });

  it("deletes fixture item by ULID", async () => {
    const deleteResponse = await request(`/api/inbox/@${FIXTURE_ULID_1}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    const body = await deleteResponse.json();
    expect(body.success).toBe(true);
    expect(body.deleted).toBe(FIXTURE_ULID_1);

    const listResponse = await request("/api/inbox");
    const list = await listResponse.json();
    const found = list.data.find((item: { _ulid: string }) => item._ulid === FIXTURE_ULID_1);
    expect(found).toBeUndefined();
  });
});

describe("Inbox ordering invariant", () => {
  it("newly created item appears at the top of the list", async () => {
    const createResponse = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ text: "Brand new item" }),
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();

    const listResponse = await request("/api/inbox");
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json();

    // The newest item should be first
    expect(list.data[0]._ulid).toBe(created.item._ulid);
  });
});
