// AC: @spec-agent-dispatch ac-1
// AC: @spec-agent-dispatch ac-2
// AC: @spec-agent-dispatch ac-3
// AC: @trait-api-endpoint ac-1
// AC: @trait-api-endpoint ac-2
// AC: @trait-api-endpoint ac-3
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
  tempDir = await createTempDir("kspec-daemon-api-agentdispatch-");
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

describe("GET /api/agent/status", () => {
  it("returns a status object", async () => {
    const response = await request("/api/agent/status");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toBeDefined();
  });

  it("returns JSON content type", async () => {
    const response = await request("/api/agent/status");
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("returns dispatch_enabled false when not started", async () => {
    const response = await request("/api/agent/status");
    const body = (await response.json()) as { dispatch_enabled: boolean };
    expect(body.dispatch_enabled).toBe(false);
  });

  it("returns expected shape with required fields", async () => {
    const response = await request("/api/agent/status");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("dispatch_enabled");
  });
});

describe("POST /api/agent/dispatch", () => {
  it("starts dispatch with action=start", async () => {
    const response = await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });
    expect(response.status).toBe(200);

    // Clean up
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "stop" }),
    });
  });

  it("stops dispatch with action=stop", async () => {
    // Start first so stop has something to stop
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });

    const response = await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "stop" }),
    });
    expect(response.status).toBe(200);
  });

  it("status reflects dispatch_enabled=true after start", async () => {
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });

    const statusResponse = await request("/api/agent/status");
    const body = (await statusResponse.json()) as { dispatch_enabled: boolean };
    expect(body.dispatch_enabled).toBe(true);

    // Clean up
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "stop" }),
    });
  });

  it("status reflects dispatch_enabled=false after stop", async () => {
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "stop" }),
    });

    const statusResponse = await request("/api/agent/status");
    const body = (await statusResponse.json()) as { dispatch_enabled: boolean };
    expect(body.dispatch_enabled).toBe(false);
  });

  it("returns 400 for invalid action", async () => {
    const response = await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "invalid-action" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("POST /api/agent/events", () => {
  it("returns accepted=false when dispatch is not running", async () => {
    // The events endpoint expects task state change format: task_id, from_status, to_status
    const response = await request("/api/agent/events", {
      method: "POST",
      body: JSON.stringify({
        task_id: "01JXXXXXXXXXXXXXXXXXXXXXXXXX",
        from_status: "pending",
        to_status: "in_progress",
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accepted: boolean };
    expect(body.accepted).toBe(false);
  });

  it("returns accepted=true when dispatch is running", async () => {
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });

    const response = await request("/api/agent/events", {
      method: "POST",
      body: JSON.stringify({
        task_id: "01JXXXXXXXXXXXXXXXXXXXXXXXXX",
        task_ref: "@test-task",
        from_status: "pending",
        to_status: "in_progress",
        timestamp: Date.now(),
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);

    // Clean up
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "stop" }),
    });
  });

  it("legacy /api/agent/event alias works", async () => {
    const response = await request("/api/agent/event", {
      method: "POST",
      body: JSON.stringify({
        task_id: "01JXXXXXXXXXXXXXXXXXXXXXXXXX",
        from_status: "pending",
        to_status: "in_progress",
      }),
    });
    // Should respond (not 404)
    expect(response.status).not.toBe(404);
  });
});

describe("GET /api/agent/dispatch/status (internal)", () => {
  it("returns running=false when dispatch not started", async () => {
    const response = await request("/api/agent/dispatch/status");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { running: boolean };
    expect(body.running).toBe(false);
  });

  it("returns running=true after dispatch start", async () => {
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });

    const response = await request("/api/agent/dispatch/status");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { running: boolean };
    expect(body.running).toBe(true);

    // Clean up
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "stop" }),
    });
  });
});

describe("Legacy routes", () => {
  it("POST /api/agent/dispatch/start starts dispatch", async () => {
    const response = await request("/api/agent/dispatch/start", {
      method: "POST",
    });
    // Should respond (not 404)
    expect(response.status).not.toBe(404);

    // Clean up
    await request("/api/agent/dispatch/stop", { method: "POST" });
  });

  it("POST /api/agent/dispatch/stop stops dispatch", async () => {
    await request("/api/agent/dispatch/start", { method: "POST" });

    const response = await request("/api/agent/dispatch/stop", {
      method: "POST",
    });
    expect(response.status).not.toBe(404);
  });
});

describe("@trait-api-endpoint: all dispatch endpoints return 2xx", () => {
  it("GET /api/agent/status returns 2xx", async () => {
    const response = await request("/api/agent/status");
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
  });

  it("POST /api/agent/dispatch with valid action returns 2xx", async () => {
    const response = await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);

    // Clean up
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "stop" }),
    });
  });

  it("POST /api/agent/events returns 2xx", async () => {
    const response = await request("/api/agent/events", {
      method: "POST",
      body: JSON.stringify({
        task_id: "01JXXXXXXXXXXXXXXXXXXXXXXXXX",
        from_status: "pending",
        to_status: "in_progress",
      }),
    });
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
  });

  it("GET /api/agent/dispatch/status returns 2xx", async () => {
    const response = await request("/api/agent/dispatch/status");
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
  });

  it("POST /api/agent/dispatch with invalid action returns 400", async () => {
    const response = await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "bogus" }),
    });
    expect(response.status).toBe(400);
  });
});
