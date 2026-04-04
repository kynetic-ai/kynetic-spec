// AC: @api-contract ac-22 — 404 error shapes for invalid refs
// AC: @api-contract ac-23 — 400/422 validation error shapes
// AC: @api-contract ac-24 — 409 state transition error shapes
// AC: @trait-api-endpoint ac-2 — 404 with {error, message, suggestion}
// AC: @trait-api-endpoint ac-3 — 400 with {error, details:[{field,message}]}

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
  tempDir = await createTempDir("kspec-daemon-api-errors-");
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

describe("404 Not Found Errors", () => {
  // AC: @api-contract ac-22
  it("tasks 404 for unknown ref", async () => {
    const response = await request("/api/tasks/@nonexistent-ref-xyz");
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toBe("not_found");
    expect(body).toHaveProperty("message");
    expect(typeof body.message).toBe("string");
    expect(body).toHaveProperty("suggestion");
    expect(typeof body.suggestion).toBe("string");
  });

  // AC: @api-contract ac-22
  it("items 404 for unknown ref", async () => {
    const response = await request("/api/items/@nonexistent-item-xyz");
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toBe("not_found");
    expect(body).toHaveProperty("message");
    expect(typeof body.message).toBe("string");
    expect(body).toHaveProperty("suggestion");
    expect(typeof body.suggestion).toBe("string");
  });

  // AC: @api-contract ac-22
  it("inbox 404 for unknown ref", async () => {
    const response = await request("/api/inbox/@nonexistent-inbox-xyz");
    expect(response.status).toBe(404);
  });

  // AC: @api-contract ac-22
  it("suggestion field includes helpful guidance for task ref", async () => {
    const response = await request("/api/tasks/@nonexistent-task-xyz");
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.suggestion).toBeTruthy();
    expect(body.suggestion.toLowerCase()).toMatch(/kspec|task|list/i);
  });

  // AC: @api-contract ac-22 — POST endpoints also return 404 for invalid refs
  it("POST start returns 404 for unknown task ref", async () => {
    const response = await request("/api/tasks/@nonexistent-task-xyz/start", {
      method: "POST",
    });
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toBe("not_found");
    expect(body).toHaveProperty("message");
    expect(body).toHaveProperty("suggestion");
  });

  // AC: @api-contract ac-22 — note endpoint also 404
  it("POST note returns 404 for unknown task ref", async () => {
    const response = await request("/api/tasks/@nonexistent-task-xyz/note", {
      method: "POST",
      body: JSON.stringify({ content: "test note" }),
    });
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toBe("not_found");
    expect(body).toHaveProperty("message");
  });
});

describe("400 Validation Errors", () => {
  // AC: @api-contract ac-23 — Elysia schema validation for missing fields
  // Note: Elysia on Bun returns 422 for schema violations, but the middleware's
  // onError handler normalizes all VALIDATION errors to 400 with a structured body.
  it("POST note with empty body returns 400 (validation error)", async () => {
    const response = await request("/api/tasks/@test-task-in-progress/note", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(body).toHaveProperty("details");
    expect(Array.isArray(body.details)).toBe(true);
  });

  // AC: @api-contract ac-23
  it("POST inbox with empty body returns 400 (validation error)", async () => {
    const response = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(body).toHaveProperty("details");
    expect(Array.isArray(body.details)).toBe(true);
  });

  // AC: @api-contract ac-23 — custom handler validation returns 400
  it("POST inbox with whitespace-only text returns 400", async () => {
    const response = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ text: "   " }),
    });
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(body).toHaveProperty("details");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details[0]).toHaveProperty("field");
    expect(body.details[0].field).toBe("text");
  });

  // AC: @api-contract ac-23 — triage action validation
  it("POST triage with invalid action returns 400", async () => {
    // First create an inbox item to triage
    const inboxResponse = await request("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ text: `Error handling test ${Date.now()}` }),
    });
    expect(inboxResponse.status).toBe(200);
    const inbox = await inboxResponse.json();

    const response = await request("/api/triage", {
      method: "POST",
      body: JSON.stringify({
        inbox_ref: `@${inbox.item._ulid}`,
        action: "invalid-action-xyz",
        reasoning: "Test invalid action",
      }),
    });
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("validation_error");
    expect(body).toHaveProperty("details");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details[0]).toHaveProperty("field");
    expect(body.details[0].field).toBe("action");
  });
});

describe("409 State Transition Errors", () => {
  // AC: @api-contract ac-24
  it("start on already in_progress task returns 409", async () => {
    const response = await request("/api/tasks/@test-task-in-progress/start", {
      method: "POST",
    });
    expect(response.status).toBe(409);

    const body = await response.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toBe("invalid_transition");
    expect(body).toHaveProperty("current");
    expect(body.current).toBe("in_progress");
    expect(body).toHaveProperty("valid_transitions");
    expect(Array.isArray(body.valid_transitions)).toBe(true);
  });

  // Note: starting a completed task is allowed by the route handler (transitions
  // back to in_progress). This matches kspec CLI behavior where task start works
  // from any non-in_progress state. Only in_progress → in_progress is rejected.

  // AC: @api-contract ac-24
  it("409 valid_transitions does not include the current state", async () => {
    const response = await request("/api/tasks/@test-task-in-progress/start", {
      method: "POST",
    });
    expect(response.status).toBe(409);

    const body = await response.json();
    expect(Array.isArray(body.valid_transitions)).toBe(true);
    expect(body.valid_transitions.length).toBeGreaterThan(0);
    expect(body.valid_transitions).not.toContain("in_progress");
  });
});

describe("Error response consistency", () => {
  // AC: @api-contract ac-22 — consistent 404 shape across endpoints
  it("all 404 responses have consistent error/message/suggestion shape", async () => {
    const endpoints = ["/api/tasks/@nonexistent-xyz", "/api/items/@nonexistent-xyz"];

    for (const endpoint of endpoints) {
      const response = await request(endpoint);
      // Verify 404 with error shape for endpoint
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body).toHaveProperty("error");
      expect(body).toHaveProperty("message");
      expect(body).toHaveProperty("suggestion");
    }
  });

  // AC: @api-contract ac-22 — 404 content type is JSON
  it("404 responses have JSON content type", async () => {
    const response = await request("/api/tasks/@nonexistent-ref-xyz");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
