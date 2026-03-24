/**
 * E2E API Tests for Daemon Inbox Endpoints
 *
 * Tests verify actual HTTP behavior by calling the running daemon directly.
 * These replace the static analysis tests in tests/daemon-api-inbox.test.ts
 * which only read source files and check string patterns.
 *
 * Covered ACs:
 * - @api-contract ac-12: GET /api/inbox returns items ordered by created_at desc
 * - @api-contract ac-13: POST /api/inbox creates item with generated ULID
 * - @api-contract ac-14: DELETE /api/inbox/:ref removes item, returns success confirmation
 */

import { test, expect } from "../fixtures/test-base";

test.describe("Inbox API", () => {
  test.describe("GET /api/inbox", () => {
    // AC: @api-contract ac-12
    test("returns inbox items as array with total", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/inbox`);

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("items");
      expect(body).toHaveProperty("total");
      expect(Array.isArray(body.items)).toBe(true);
      // Fixtures include 3 inbox items
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.total).toBe(body.items.length);
    });

    // AC: @api-contract ac-12 - ordered by created_at desc
    test("returns items ordered by created_at descending (newest first)", async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${daemon.baseUrl}/api/inbox`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      const items = body.items;
      // Fixtures have 3 items with different created_at timestamps
      expect(items.length).toBeGreaterThanOrEqual(2);

      // Verify descending order
      for (let i = 0; i < items.length - 1; i++) {
        const current = new Date(items[i].created_at).getTime();
        const next = new Date(items[i + 1].created_at).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
      }
    });

    // AC: @api-contract ac-12 - item fields
    test("each inbox item has required fields", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/inbox`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBeGreaterThan(0);

      const item = body.items[0];
      expect(item).toHaveProperty("_ulid");
      expect(item).toHaveProperty("text");
      expect(item).toHaveProperty("created_at");
      expect(item).toHaveProperty("tags");
      expect(Array.isArray(item.tags)).toBe(true);
    });

    // AC: @api-contract ac-12 - fixture data integrity
    test("returns the fixture inbox items in correct order", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/inbox`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Fixture has 3 items ordered by created_at:
      // 01KJNBX0CA...: 2026-01-01T10:00:00Z (newest)
      // 01KJNBX1CC...: 2026-01-01T09:00:00Z
      // 01KJNBX2CB...: 2026-01-01T08:00:00Z (oldest)
      expect(body.items.length).toBe(3);
      expect(body.items[0].text).toBe("First inbox item for testing");
      expect(body.items[1].text).toBe("Second inbox item with different tags");
      expect(body.items[2].text).toBe("Third inbox item - oldest");
    });

    // AC: @api-contract ac-12 (response format) - JSON content type
    test("returns JSON content type", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/inbox`);
      const contentType = response.headers()["content-type"] || "";
      expect(contentType).toContain("application/json");
    });
  });

  test.describe("POST /api/inbox", () => {
    // AC: @api-contract ac-13
    test("creates inbox item and returns it with generated ULID", async ({ request, daemon }) => {
      const itemText = `E2E test inbox item ${Date.now()}`;
      const response = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: itemText },
      });

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("success");
      expect(body.success).toBe(true);
      expect(body).toHaveProperty("item");

      const item = body.item;
      expect(item).toHaveProperty("_ulid");
      expect(typeof item._ulid).toBe("string");
      expect(item._ulid.length).toBeGreaterThan(0);
      expect(item.text).toBe(itemText);
    });

    // AC: @api-contract ac-13 - ULID is auto-generated (not provided by client)
    test("assigns a ULID to the new item", async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: "ULID assignment test" },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();

      // ULID should be a valid 26-character Crockford base32 string
      expect(body.item._ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    // AC: @api-contract ac-13 - created item appears in list
    test("newly created item appears in subsequent GET /api/inbox", async ({ request, daemon }) => {
      const itemText = `Created item check ${Date.now()}`;
      const createResponse = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: itemText },
      });
      expect(createResponse.status()).toBe(200);
      const created = await createResponse.json();

      // Now list inbox items
      const listResponse = await request.get(`${daemon.baseUrl}/api/inbox`);
      expect(listResponse.status()).toBe(200);
      const list = await listResponse.json();

      // Find our newly created item
      const found = list.items.find((i: { _ulid: string }) => i._ulid === created.item._ulid);
      expect(found).toBeDefined();
      expect(found.text).toBe(itemText);
    });

    // AC: @api-contract ac-13 - supports optional tags
    test("creates item with optional tags", async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: "Tagged item", tags: ["feature", "dx"] },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.item.tags).toEqual(["feature", "dx"]);
    });

    // AC: @api-contract ac-13 - supports optional added_by
    test("creates item with optional added_by field", async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: "Item by author", added_by: "@testuser" },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.item.added_by).toBe("@testuser");
    });

    // AC: @api-contract ac-13 - created_at is set
    test("created item has a created_at timestamp", async ({ request, daemon }) => {
      const before = new Date().getTime();
      const response = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: "Timestamp test item" },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      const after = new Date().getTime();

      const createdAt = new Date(body.item.created_at).getTime();
      // created_at should be within the test window
      expect(createdAt).toBeGreaterThanOrEqual(before - 5000); // 5s tolerance
      expect(createdAt).toBeLessThanOrEqual(after + 5000);
    });

    // Error: missing text field — Elysia validates body schema, returns 422
    test("returns 422 when text field is missing", async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: {},
      });

      expect(response.status()).toBe(422);
    });

    // Error: empty text — handler validation returns 400
    test("returns 400 when text is empty string", async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: "" },
      });

      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("validation_error");
      expect(body).toHaveProperty("details");
      expect(Array.isArray(body.details)).toBe(true);
      expect(body.details[0].field).toBe("text");
    });

    // Error: whitespace-only text — handler validation returns 400
    test("returns 400 when text is whitespace only", async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: "   " },
      });

      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("validation_error");
    });
  });

  test.describe("DELETE /api/inbox/:ref", () => {
    // AC: @api-contract ac-14
    test("deletes an inbox item and returns success confirmation", async ({ request, daemon }) => {
      // First create an item to delete
      const createResponse = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: "Item to delete" },
      });
      expect(createResponse.status()).toBe(200);
      const created = await createResponse.json();
      const ulid = created.item._ulid;

      // Delete it using its ULID ref
      const deleteResponse = await request.delete(`${daemon.baseUrl}/api/inbox/@${ulid}`);
      expect(deleteResponse.status()).toBe(200);

      const body = await deleteResponse.json();
      expect(body).toHaveProperty("success");
      expect(body.success).toBe(true);
      expect(body).toHaveProperty("deleted");
      expect(body.deleted).toBe(ulid);
    });

    // AC: @api-contract ac-14 - item is actually removed from list
    test("deleted item no longer appears in GET /api/inbox", async ({ request, daemon }) => {
      // Create an item
      const createResponse = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: "Item to verify deletion" },
      });
      expect(createResponse.status()).toBe(200);
      const created = await createResponse.json();
      const ulid = created.item._ulid;

      // Delete it
      const deleteResponse = await request.delete(`${daemon.baseUrl}/api/inbox/@${ulid}`);
      expect(deleteResponse.status()).toBe(200);

      // Verify it's gone
      const listResponse = await request.get(`${daemon.baseUrl}/api/inbox`);
      const list = await listResponse.json();
      const found = list.items.find((i: { _ulid: string }) => i._ulid === ulid);
      expect(found).toBeUndefined();
    });

    // AC: @api-contract ac-14 - can delete using full ULID ref
    test("deletes item using full ULID ref", async ({ request, daemon }) => {
      // Create a new item to delete
      const createResponse = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: "Full ULID ref deletion test" },
      });
      expect(createResponse.status()).toBe(200);
      const created = await createResponse.json();
      const ulid = created.item._ulid;

      // Delete using the full ULID
      const deleteResponse = await request.delete(`${daemon.baseUrl}/api/inbox/@${ulid}`);
      expect(deleteResponse.status()).toBe(200);
      const body = await deleteResponse.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(ulid);
    });

    // AC: @api-contract ac-14 - error handling
    // AC: @trait-api-endpoint ac-2 - 404 with {error, message, suggestion}
    test("returns 404 with message and suggestion for non-existent inbox ref", async ({
      request,
      daemon,
    }) => {
      const response = await request.delete(
        `${daemon.baseUrl}/api/inbox/@nonexistent-inbox-ref-xyz`,
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

    // Error: can delete fixture items by ULID
    test("can delete an existing fixture item by ULID", async ({ request, daemon }) => {
      // Use the third fixture item (oldest) to avoid affecting ordering tests
      const ulid = "01KJNBX2CB8N4YGP991WD7XS9R";

      const deleteResponse = await request.delete(`${daemon.baseUrl}/api/inbox/@${ulid}`);
      expect(deleteResponse.status()).toBe(200);

      const body = await deleteResponse.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(ulid);

      // Verify list now has 2 items
      const listResponse = await request.get(`${daemon.baseUrl}/api/inbox`);
      const list = await listResponse.json();
      expect(list.items.length).toBe(2);
    });
  });

  test.describe("Inbox ordering invariant", () => {
    // AC: @api-contract ac-12 - newly created items appear at top (newest first)
    test("newly created item appears at top of list (most recent first)", async ({
      request,
      daemon,
    }) => {
      // Wait a moment to ensure new item has a later timestamp
      await new Promise((r) => setTimeout(r, 10));

      const response = await request.post(`${daemon.baseUrl}/api/inbox`, {
        data: { text: "Should be at top" },
      });
      expect(response.status()).toBe(200);
      const created = await response.json();

      const listResponse = await request.get(`${daemon.baseUrl}/api/inbox`);
      const list = await listResponse.json();

      // Newest item should be first since fixture items are from 2026-01-01
      expect(list.items[0]._ulid).toBe(created.item._ulid);
    });
  });
});
