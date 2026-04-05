/**
 * API Tests for Daemon Agent Dispatch Integration
 *
 * Covered ACs:
 * - @daemon-agent-dispatch ac-2: POST /api/agent/events accepts task state change events
 * - @daemon-agent-dispatch ac-5: GET /api/agent/status returns dispatch_enabled, active_invocations, queue_depth, agent_definitions
 * - @daemon-agent-dispatch ac-6: POST /api/agent/dispatch with action start|stop returns dispatch_enabled
 * - @daemon-agent-dispatch ac-7: Event emission fails silently when engine not running
 */

// Trait N/A annotations
// AC: @daemon-agent-dispatch ac-1 — N/A: file watcher integration is tested implicitly via the dispatch engine; isolated watcher+diffing behavior is covered in unit tests
// AC: @daemon-agent-dispatch ac-3, ac-4 — N/A: actual invocation broadcasts require a real agent adapter (claude-agent-acp) which cannot run in vitest; event callback wiring is verified by unit tests
// AC: @trait-api-endpoint ac-2 — N/A: agent dispatch endpoints use project context, not item refs
// AC: @trait-api-endpoint ac-4 — N/A: agent dispatch endpoints do not support pagination
// AC: @trait-api-endpoint ac-5 — N/A: agent dispatch endpoints operate on daemon state, not shadow branch
// AC: @trait-api-endpoint ac-6 — N/A: X-Request-Id header is infrastructure concern; not tested in domain E2E tests

import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDispatchEngine, stopAllEngines } from "../../dist/daemon/routes/agent-dispatch.js";
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
  // Ensure all dispatch engines are stopped to prevent leaked state
  // between tests (engines are module-level singletons keyed by project path).
  await stopAllEngines();
  await cleanupTempDir(tempDir);
});

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

describe("GET /api/agent/status", () => {
  // AC: @daemon-agent-dispatch ac-5
  it("returns dispatch_enabled, active_invocations, queue_depth, agent_definitions", async () => {
    const response = await request("/api/agent/status");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("dispatch_enabled");
    expect(typeof body.dispatch_enabled).toBe("boolean");

    expect(body).toHaveProperty("active_invocations");
    expect(Array.isArray(body.active_invocations)).toBe(true);

    expect(body).toHaveProperty("queue_depth");
    expect(typeof body.queue_depth).toBe("number");

    expect(body).toHaveProperty("agent_definitions");
    expect(Array.isArray(body.agent_definitions)).toBe(true);
  });

  // AC: @daemon-agent-dispatch ac-5
  it("returns dispatch_enabled=false when engine not started", async () => {
    const response = await request("/api/agent/status");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.dispatch_enabled).toBe(false);
    expect(body.active_invocations).toEqual([]);
    expect(body.queue_depth).toBe(0);
  });

  it("returns JSON content type", async () => {
    const response = await request("/api/agent/status");
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  // AC: @dispatch-remote-branch-sync ac-degraded-status-api
  // AC: @dispatch-remote-branch-sync ac-degraded-status-api-reason
  // AC: @dispatch-remote-branch-sync ac-degraded-status-api-timestamp
  it("returns per-target degraded targets alongside the compatibility summary", async () => {
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });

    const engine = getDispatchEngine(tempDir);
    expect(engine).toBeDefined();
    (engine as any)._enterDegradedState("plan/alpha", 'integration target "plan/alpha" diverged');

    const response = await request("/api/agent/status");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.degraded).toEqual({
      active: true,
      reason: 'integration target "plan/alpha" diverged',
      enteredAt: expect.any(String),
    });
    expect(body.degraded_targets).toEqual([
      {
        branch: "plan/alpha",
        reason: 'integration target "plan/alpha" diverged',
        enteredAt: expect.any(String),
      },
    ]);
  });
});

describe("POST /api/agent/dispatch", () => {
  // AC: @daemon-agent-dispatch ac-6
  it("starts dispatch engine with action=start", async () => {
    const response = await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("dispatch_enabled");
    expect(body.dispatch_enabled).toBe(true);
  });

  // AC: @daemon-agent-dispatch ac-6
  it("stops dispatch engine with action=stop", async () => {
    // Start first
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });

    const response = await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "stop" }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("dispatch_enabled");
    expect(body.dispatch_enabled).toBe(false);
  });

  // AC: @daemon-agent-dispatch ac-6
  it("returns dispatch_enabled=true when GET /api/agent/status is called after start", async () => {
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });

    const statusResponse = await request("/api/agent/status");
    expect(statusResponse.status).toBe(200);

    const body = await statusResponse.json();
    expect(body.dispatch_enabled).toBe(true);
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
    const body = await statusResponse.json();
    expect(body.dispatch_enabled).toBe(false);
  });

  // AC: @trait-api-endpoint ac-3
  it("returns 400 for invalid action", async () => {
    const response = await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "restart" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("POST /api/agent/events", () => {
  // AC: @daemon-agent-dispatch ac-2, ac-7
  it("returns accepted=false with reason when dispatch engine not running", async () => {
    const response = await request("/api/agent/events", {
      method: "POST",
      body: JSON.stringify({
        task_id: "01JXXXXXXXXXXXXXXXXXXXXXXXXX",
        from_status: "in_progress",
        to_status: "pending",
        timestamp: Date.now(),
      }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    // AC: @daemon-agent-dispatch ac-7 - silent fail when engine not running
    expect(body.accepted).toBe(false);
    expect(body.reason).toBeDefined();
  });

  // AC: @daemon-agent-dispatch ac-2
  it("returns accepted=true when dispatch engine is running", async () => {
    // Start the engine first
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });

    const response = await request("/api/agent/events", {
      method: "POST",
      body: JSON.stringify({
        task_id: "01JXXXXXXXXXXXXXXXXXXXXXXXXX",
        task_ref: "@test-task",
        from_status: "in_progress",
        to_status: "pending",
        timestamp: Date.now(),
      }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.accepted).toBe(true);
  });

  // AC: @daemon-agent-dispatch ac-2
  it("POST /api/agent/event (legacy alias) returns accepted=false when engine not running", async () => {
    const response = await request("/api/agent/event", {
      method: "POST",
      body: JSON.stringify({
        task_id: "01JXXXXXXXXXXXXXXXXXXXXXXXXX",
        from_status: "pending",
        to_status: "in_progress",
        timestamp: Date.now(),
      }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.accepted).toBe(false);
  });
});

describe("GET /api/agent/dispatch/status (internal)", () => {
  // AC: @daemon-agent-dispatch ac-5 (internal route for backwards compat)
  it("returns running=false when engine not started", async () => {
    const response = await request("/api/agent/dispatch/status");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("running");
    expect(body.running).toBe(false);
  });

  // AC: @dispatch-remote-branch-sync ac-degraded-status-api
  // AC: @dispatch-remote-branch-sync ac-degraded-status-api-reason
  // AC: @dispatch-remote-branch-sync ac-degraded-status-api-timestamp
  it("returns per-target degraded targets on the internal status route", async () => {
    await request("/api/agent/dispatch/start", { method: "POST" });

    const engine = getDispatchEngine(tempDir);
    expect(engine).toBeDefined();
    (engine as any)._enterDegradedState("plan/alpha", 'integration target "plan/alpha" diverged');

    const response = await request("/api/agent/dispatch/status");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.degraded).toEqual({
      active: true,
      reason: 'integration target "plan/alpha" diverged',
      enteredAt: expect.any(String),
    });
    expect(body.degradedTargets).toEqual([
      {
        branch: "plan/alpha",
        reason: 'integration target "plan/alpha" diverged',
        enteredAt: expect.any(String),
      },
    ]);
  });
});

describe("Legacy dispatch start/stop routes", () => {
  it("POST /api/agent/dispatch/start starts the engine", async () => {
    const response = await request("/api/agent/dispatch/start", {
      method: "POST",
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.started).toBe(true);

    // Verify engine is running
    const statusResponse = await request("/api/agent/dispatch/status");
    const status = await statusResponse.json();
    expect(status.running).toBe(true);
  });

  it("POST /api/agent/dispatch/stop stops the engine", async () => {
    // Start first
    await request("/api/agent/dispatch/start", { method: "POST" });

    const response = await request("/api/agent/dispatch/stop", {
      method: "POST",
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.stopped).toBe(true);

    // Verify engine is stopped
    const statusResponse = await request("/api/agent/dispatch/status");
    const status = await statusResponse.json();
    expect(status.running).toBe(false);
  });
});

describe("@trait-api-endpoint: all dispatch endpoints return 2xx", () => {
  // AC: @trait-api-endpoint ac-1 — valid requests return 2xx
  it("all dispatch endpoints return 2xx for valid requests", async () => {
    const statusResp = await request("/api/agent/status");
    expect(statusResp.status).toBe(200);

    const dispatchStatusResp = await request("/api/agent/dispatch/status");
    expect(dispatchStatusResp.status).toBe(200);

    const eventResp = await request("/api/agent/events", {
      method: "POST",
      body: JSON.stringify({
        task_id: "01JXXXXXXXXXXXXXXXXXXXXXXXXX",
        from_status: "pending",
        to_status: "in_progress",
      }),
    });
    expect(eventResp.status).toBe(200);
  });

  // AC: @trait-api-endpoint ac-3 — invalid body returns 400
  it("POST /api/agent/dispatch with invalid action returns 400", async () => {
    const response = await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "restart" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
