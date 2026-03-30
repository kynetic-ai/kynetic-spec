// AC: @trait-api-endpoint ac-2 — N/A: POST /api/items/batch reports missing refs in an
// unresolved array by design instead of failing the whole batch with 404.
// AC: @trait-api-endpoint ac-4 — N/A: POST /api/items/batch returns {items, unresolved};
// it is a batch lookup endpoint, not a paginated list endpoint.
// AC: @trait-api-endpoint ac-5 — N/A: POST /api/items/batch is read-only and does not mutate shadow state.

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
  tempDir = await createTempDir("kspec-daemon-api-items-");
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

describe("GET /api/items", () => {
  // AC: @spec-api-items ac-1
  it("returns items with required fields", async () => {
    const response = await request("/api/items");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("meta");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    const item = body.data[0];
    expect(item).toHaveProperty("_ulid");
    expect(item).toHaveProperty("slugs");
    expect(item).toHaveProperty("type");
    expect(item).toHaveProperty("title");
  });

  // AC: @spec-api-items ac-2
  it("returns different types", async () => {
    const response = await request("/api/items");
    expect(response.status).toBe(200);
    const body = await response.json();
    const types = new Set(body.data.map((i: { type: string }) => i.type));
    expect(types.size).toBeGreaterThan(1);
  });

  // AC: @spec-api-items ac-3
  it("items include slugs", async () => {
    const response = await request("/api/items");
    expect(response.status).toBe(200);
    const body = await response.json();
    for (const item of body.data) {
      expect(Array.isArray(item.slugs)).toBe(true);
      expect(item.slugs.length).toBeGreaterThan(0);
    }
  });

  describe("type filter", () => {
    // AC: @spec-api-items ac-4
    it("filters by single type", async () => {
      const response = await request("/api/items?type=feature");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.length).toBeGreaterThan(0);
      for (const item of body.data) {
        expect(item.type).toBe("feature");
      }
    });

    // AC: @spec-api-items ac-4
    it("filters by multiple types", async () => {
      const response = await request("/api/items?type=feature&type=requirement");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.length).toBeGreaterThan(0);
      for (const item of body.data) {
        expect(["feature", "requirement"]).toContain(item.type);
      }
    });

    // AC: @spec-api-items ac-4
    it("type exclusion returns no items of that type", async () => {
      const allResponse = await request("/api/items");
      const allBody = await allResponse.json();
      const allTypes = new Set(
        allBody.data.map((i: { type: string }) => i.type)
      );

      // Pick a type that exists, exclude it, verify it's absent
      const excludeType = [...allTypes][0] as string;
      const response = await request(
        `/api/items?type=${[...allTypes].filter((t) => t !== excludeType).join("&type=")}`
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      for (const item of body.data) {
        expect(item.type).not.toBe(excludeType);
      }
    });
  });

  describe("pagination", () => {
    // AC: @spec-api-items ac-5
    it("returns pagination shape", async () => {
      const response = await request("/api/items?limit=2");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("meta");
      expect(body.meta).toHaveProperty("total");
      expect(body.meta).toHaveProperty("limit");
      expect(body.meta).toHaveProperty("offset");
      expect(body.data.length).toBeLessThanOrEqual(2);
    });

    // AC: @spec-api-items ac-5
    it("pagination offsets work", async () => {
      const page1 = await request("/api/items?limit=1&offset=0");
      const page2 = await request("/api/items?limit=1&offset=1");
      expect(page1.status).toBe(200);
      expect(page2.status).toBe(200);
      const body1 = await page1.json();
      const body2 = await page2.json();
      expect(body1.data.length).toBe(1);
      expect(body2.data.length).toBe(1);
      expect(body1.data[0]._ulid).not.toBe(body2.data[0]._ulid);
    });
  });
});

describe("GET /api/items/:ref", () => {
  // AC: @spec-api-items ac-6
  it("resolves item by slug", async () => {
    const response = await request("/api/items/@test-feature");
    expect(response.status).toBe(200);
    const body = await response.json();
    const item = body.data;
    expect(item.slugs).toContain("test-feature");
    expect(item).toHaveProperty("_ulid");
    expect(item).toHaveProperty("type");
    expect(item).toHaveProperty("title");
  });

  // AC: @spec-api-items ac-7
  it("returns acceptance_criteria", async () => {
    const response = await request("/api/items/@test-feature");
    expect(response.status).toBe(200);
    const body = await response.json();
    const item = body.data;
    expect(item).toHaveProperty("acceptance_criteria");
    expect(Array.isArray(item.acceptance_criteria)).toBe(true);
  });

  // AC: @spec-api-items ac-8
  it("returns traits", async () => {
    const response = await request("/api/items/@test-feature");
    expect(response.status).toBe(200);
    const body = await response.json();
    const item = body.data;
    expect(item).toHaveProperty("traits");
    expect(Array.isArray(item.traits)).toBe(true);
  });

  // AC: @spec-api-items ac-9
  it("returns description", async () => {
    const response = await request("/api/items/@test-feature");
    expect(response.status).toBe(200);
    const body = await response.json();
    const item = body.data;
    expect(item).toHaveProperty("description");
  });

  // AC: @spec-api-items ac-6
  it("resolves item by ULID", async () => {
    const response = await request(
      "/api/items/@01KF1645CBDJYHWBPYWRN3HYPJ"
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data._ulid).toBe("01KF1645CBDJYHWBPYWRN3HYPJ");
  });

  // AC: @trait-api-endpoint ac-2
  it("returns 404 for unknown ref", async () => {
    const response = await request("/api/items/@nonexistent-item");
    expect(response.status).toBe(404);
  });

  // AC: @trait-api-endpoint ac-3
  it("returns JSON content type", async () => {
    const response = await request("/api/items/@test-feature");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("GET /api/items/:ref/tasks", () => {
  // AC: @spec-api-items ac-10
  it("returns linked tasks", async () => {
    const response = await request("/api/items/@test-feature/tasks");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("meta");
    expect(Array.isArray(body.data)).toBe(true);
  });

  // AC: @spec-api-items ac-10
  it("task entries include summary fields", async () => {
    const response = await request("/api/items/@test-feature/tasks");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThan(0);
    const task = body.data[0];
    expect(task).toHaveProperty("_ulid");
    expect(task).toHaveProperty("slugs");
    expect(task).toHaveProperty("title");
    expect(task).toHaveProperty("status");
  });

  // AC: @spec-api-items ac-10
  it("returns total matches", async () => {
    const response = await request("/api/items/@test-feature/tasks");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meta).toHaveProperty("total");
    expect(typeof body.meta.total).toBe("number");
    expect(body.meta.total).toBe(body.data.length);
  });

  // AC: @spec-api-items ac-10
  it("tasks have spec_ref matching the item", async () => {
    const response = await request("/api/items/@test-feature/tasks");
    expect(response.status).toBe(200);
    const body = await response.json();
    for (const task of body.data) {
      expect(task.spec_ref).toContain("test-feature");
    }
  });

  // AC: @trait-api-endpoint ac-2
  it("returns 404 for unknown item ref", async () => {
    const response = await request("/api/items/@nonexistent-item/tasks");
    expect(response.status).toBe(404);
  });

  // AC: @spec-api-items ac-10
  it("returns empty array when no tasks linked", async () => {
    const response = await request("/api/items/@test-requirement/tasks");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("data");
    expect(Array.isArray(body.data)).toBe(true);
  });
});

describe("POST /api/items/batch", () => {
  // AC: @spec-api-items ac-11
  it("valid refs return item summaries", async () => {
    const response = await request("/api/items/batch", {
      method: "POST",
      body: JSON.stringify({
        refs: ["@test-feature", "@test-requirement"],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(2);
    const allSlugs = body.items.flatMap((i: { slugs: string[] }) => i.slugs);
    expect(allSlugs).toContain("test-feature");
    expect(allSlugs).toContain("test-requirement");
  });

  // AC: @spec-api-items ac-12
  it("unresolved refs are reported separately", async () => {
    const response = await request("/api/items/batch", {
      method: "POST",
      body: JSON.stringify({
        refs: ["@test-feature", "@nonexistent-item"],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("unresolved");
    expect(Array.isArray(body.unresolved)).toBe(true);
    expect(body.unresolved).toContain("@nonexistent-item");
    expect(body.items.length).toBe(1);
  });

  // AC: @spec-api-items ac-11
  it("task refs return task summaries alongside item summaries", async () => {
    const response = await request("/api/items/batch", {
      method: "POST",
      body: JSON.stringify({
        refs: [
          "@01KF1645CBDJYHWBPYWRN3HYPJ",
          "@01KG0RR6CA45ZT43W2T6HJMVA1",
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    const ulids = body.items.map((i: { ulid: string }) => i.ulid);
    expect(ulids).toContain("01KF1645CBDJYHWBPYWRN3HYPJ");
    expect(ulids).toContain("01KG0RR6CA45ZT43W2T6HJMVA1");
  });

  // AC: @spec-api-items ac-11
  it("empty batch returns empty items and unresolved arrays", async () => {
    const response = await request("/api/items/batch", {
      method: "POST",
      body: JSON.stringify({ refs: [] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toEqual([]);
    expect(body.unresolved).toEqual([]);
  });

  // AC: @spec-api-items ac-13
  it("rejects batch larger than 100 refs", async () => {
    const refs = Array.from(
      { length: 101 },
      (_, i) => `@item-${String(i).padStart(3, "0")}`
    );
    const response = await request("/api/items/batch", {
      method: "POST",
      body: JSON.stringify({ refs }),
    });
    expect(response.status).toBe(400);
  });

  // AC: @spec-api-items ac-13
  it("returns validation error for missing refs field", async () => {
    const response = await request("/api/items/batch", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
