// AC: @spec-daemon-meta ac-1 — N/A: meta endpoint is read-only, no write path tested here
// AC: @spec-daemon-meta ac-2 — N/A: authentication not applicable to local daemon
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
  tempDir = await createTempDir("kspec-daemon-api-meta-");
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

describe("Meta API", () => {
  it("returns session context", async () => {
    const response = await request("/api/meta/session");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toBeDefined();
  });

  it("session context includes focus field", async () => {
    const response = await request("/api/meta/session");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.focus).toBeDefined();
    expect(typeof body.data.focus).toBe("string");
  });

  it("session context focus matches fixture value", async () => {
    const response = await request("/api/meta/session");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.focus).toContain("E2E testing");
  });

  it("returns agents list", async () => {
    const response = await request("/api/meta/agents");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.meta.total).toBe("number");
  });

  it("fixture has 2 agents (task-worker, pr-reviewer)", async () => {
    const response = await request("/api/meta/agents");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBe(2);
    expect(body.meta.total).toBe(2);
  });

  it("agent entries have required fields", async () => {
    const response = await request("/api/meta/agents");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThan(0);
    const agent = body.data[0];
    expect(agent).toHaveProperty("id");
    expect(agent).toHaveProperty("name");
  });

  it("fixture agents include task-worker", async () => {
    const response = await request("/api/meta/agents");
    expect(response.status).toBe(200);
    const body = await response.json();
    const taskWorker = body.data.find(
      (a: { id: string }) => a.id === "task-worker"
    );
    expect(taskWorker).toBeDefined();
  });

  it("fixture agents include pr-reviewer", async () => {
    const response = await request("/api/meta/agents");
    expect(response.status).toBe(200);
    const body = await response.json();
    const prReviewer = body.data.find(
      (a: { id: string }) => a.id === "pr-reviewer"
    );
    expect(prReviewer).toBeDefined();
  });

  it("returns workflows list", async () => {
    const response = await request("/api/meta/workflows");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.meta.total).toBe("number");
  });

  it("fixture has 2 workflows (spec-first, session-start)", async () => {
    const response = await request("/api/meta/workflows");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBe(2);
    expect(body.meta.total).toBe(2);
  });

  it("workflow entries have required fields", async () => {
    const response = await request("/api/meta/workflows");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThan(0);
    const workflow = body.data[0];
    expect(workflow).toHaveProperty("id");
  });

  it("fixture workflows include spec-first", async () => {
    const response = await request("/api/meta/workflows");
    expect(response.status).toBe(200);
    const body = await response.json();
    const specFirst = body.data.find(
      (w: { id: string }) => w.id === "spec-first"
    );
    expect(specFirst).toBeDefined();
  });

  it("fixture workflows include session-start", async () => {
    const response = await request("/api/meta/workflows");
    expect(response.status).toBe(200);
    const body = await response.json();
    const sessionStart = body.data.find(
      (w: { id: string }) => w.id === "session-start"
    );
    expect(sessionStart).toBeDefined();
  });

  it("returns observations list", async () => {
    const response = await request("/api/meta/observations");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.meta.total).toBe("number");
  });

  it("fixture has 2 unresolved observations", async () => {
    const response = await request("/api/meta/observations");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBe(2);
    expect(body.meta.total).toBe(2);
  });

  it("observation entries have required fields", async () => {
    const response = await request("/api/meta/observations");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThan(0);
    const obs = body.data[0];
    // Entities use _ulid, not id
    expect(obs).toHaveProperty("_ulid");
    expect(obs).toHaveProperty("content");
    expect(obs).toHaveProperty("type");
  });

  it("observations include friction type", async () => {
    const response = await request("/api/meta/observations");
    expect(response.status).toBe(200);
    const body = await response.json();
    const frictionObs = body.data.find(
      (o: { type: string }) => o.type === "friction"
    );
    expect(frictionObs).toBeDefined();
  });

  it("friction observation content matches fixture", async () => {
    const response = await request("/api/meta/observations");
    expect(response.status).toBe(200);
    const body = await response.json();
    const frictionObs = body.data.find(
      (o: { type: string }) => o.type === "friction"
    );
    expect(frictionObs).toBeDefined();
    expect(frictionObs.content).toContain("Test friction observation");
  });

  it("observations include success type", async () => {
    const response = await request("/api/meta/observations");
    expect(response.status).toBe(200);
    const body = await response.json();
    const successObs = body.data.find(
      (o: { type: string }) => o.type === "success"
    );
    expect(successObs).toBeDefined();
  });

  it("filters resolved observations when resolved=false", async () => {
    const response = await request("/api/meta/observations?resolved=false");
    expect(response.status).toBe(200);
    const body = await response.json();
    // All fixture observations are unresolved
    const resolved = body.data.filter(
      (o: { resolved?: boolean }) => o.resolved === true
    );
    expect(resolved.length).toBe(0);
  });
});

describe("Search API", () => {
  it("GET /api/search returns results shape", async () => {
    const response = await request("/api/search?q=test");
    expect(response.status).toBe(200);
    const body = await response.json();
    // Search returns {data: {results, total, showing}, meta: {...}}
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data.results)).toBe(true);
  });

  it("results have entity type field", async () => {
    const response = await request("/api/search?q=test");
    expect(response.status).toBe(200);
    const body = await response.json();
    if (body.data.results.length > 0) {
      const result = body.data.results[0];
      expect(result).toHaveProperty("type");
    }
  });

  it("results have total field in data", async () => {
    const response = await request("/api/search?q=test");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveProperty("total");
  });

  it("respects limit parameter", async () => {
    const response = await request("/api/search?q=test&limit=1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.results.length).toBeLessThanOrEqual(1);
  });

  it("returns empty results for no matches", async () => {
    const response = await request(
      "/api/search?q=zzznomatchxxx99999uniquestring"
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.results.length).toBe(0);
  });

  it("returns JSON content type", async () => {
    const response = await request("/api/search?q=test");
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("Validation API", () => {
  it("GET /api/validate returns status 200", async () => {
    const response = await request("/api/validate");
    expect(response.status).toBe(200);
  });

  it("validate response has data field", async () => {
    const response = await request("/api/validate");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toBeDefined();
  });

  it("validate response includes valid field", async () => {
    const response = await request("/api/validate");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.data.valid).toBe("boolean");
  });

  it("validate response includes schemaErrors array", async () => {
    const response = await request("/api/validate");
    expect(response.status).toBe(200);
    const body = await response.json();
    // Route returns schemaErrors, refErrors, orphans (not generic "errors")
    expect(Array.isArray(body.data.schemaErrors)).toBe(true);
    expect(Array.isArray(body.data.refErrors)).toBe(true);
    expect(Array.isArray(body.data.orphans)).toBe(true);
  });

  it("fixture validation returns known errors from test fixture data", async () => {
    const response = await request("/api/validate");
    expect(response.status).toBe(200);
    const body = await response.json();
    // The e2e fixture has known issues:
    // - tasks[6]._ulid has an invalid ULID format
    // - @test-plan plan_ref reference not found
    // These are pre-existing fixture data issues, not production bugs.
    expect(body.data.schemaErrors.length).toBe(1);
    expect(body.data.schemaErrors[0].message).toBe("Invalid ULID format");
    expect(body.data.refErrors.length).toBe(1);
    expect(body.data.refErrors[0].ref).toBe("@test-plan");
  });

  it("GET /api/alignment returns status 200", async () => {
    const response = await request("/api/alignment");
    expect(response.status).toBe(200);
  });

  it("alignment response has data field", async () => {
    const response = await request("/api/alignment");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toBeDefined();
  });

  it("alignment response includes stats object", async () => {
    const response = await request("/api/alignment");
    expect(response.status).toBe(200);
    const body = await response.json();
    // Alignment route returns {stats: {...}, warnings: [...]}
    expect(body.data.stats).toBeDefined();
    expect(typeof body.data.stats.totalSpecs).toBe("number");
  });

  it("alignment response includes warnings array", async () => {
    const response = await request("/api/alignment");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data.warnings)).toBe(true);
  });

  it("returns JSON content type", async () => {
    const response = await request("/api/validate");
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
