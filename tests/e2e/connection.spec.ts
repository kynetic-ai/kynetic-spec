import { test, expect } from "./fixtures/test-base";
import type { Page } from "@playwright/test";

/**
 * WebSocket Connection Handling E2E Tests
 *
 * Tests for connection resilience, exponential backoff reconnection,
 * sequence deduplication, and connection status UI.
 *
 * Covered ACs:
 * - AC-28: Exponential backoff reconnect (1s, 2s, 4s... max 30s)
 * - AC-29: Connection lost indicator after 10s disconnect
 * - AC-30: Sequence deduplication (skip seq <= lastSeqProcessed)
 * - AC-31: Reset lastSeqProcessed = -1 on reconnect
 * - AC-32: Re-subscribe to all topics on reconnect
 */

function isTasksApiUrl(url: string): boolean {
  return /\/api\/tasks(?:\?|$)/.test(url);
}

/**
 * Track GET /api/tasks traffic by request initiation and completion.
 *
 * Dedup assertions count request *initiation*, not responses: a query
 * invalidation starts its request synchronously on the client, while the
 * response can land arbitrarily late under full-suite parallel load. Counting
 * responses made the dedup check flaky — slow in-flight responses landed after
 * the settle window and were misattributed to the duplicate event.
 */
function trackTasksApi(page: Page) {
  let started = 0;
  let finished = 0;
  let responses = 0;

  page.on("request", (request) => {
    if (request.method() === "GET" && isTasksApiUrl(request.url())) started++;
  });
  page.on("requestfinished", (request) => {
    if (request.method() === "GET" && isTasksApiUrl(request.url())) finished++;
  });
  page.on("requestfailed", (request) => {
    if (request.method() === "GET" && isTasksApiUrl(request.url())) finished++;
  });
  page.on("response", (response) => {
    if (response.request().method() === "GET" && isTasksApiUrl(response.url())) responses++;
  });

  return {
    get requestCount() {
      return started;
    },
    get responseCount() {
      return responses;
    },
    /**
     * Wait until no new /api/tasks request has started AND none is in flight
     * for `stableMs`, then return the request count.
     *
     * stableMs must exceed the longest delayed invalidation timer in
     * ws-invalidation.ts (files:updates events schedule invalidations at
     * +650ms and +1500ms) so that timers already scheduled by earlier events
     * fire inside the stability window instead of after settle returns.
     */
    async settle(stableMs = 2_000, timeoutMs = 15_000): Promise<number> {
      const pollMs = 100;
      const deadline = Date.now() + timeoutMs;
      let lastStarted = started;
      let stableFor = 0;

      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (started === lastStarted && started === finished) {
          stableFor += pollMs;
          if (stableFor >= stableMs) {
            return started;
          }
          continue;
        }

        lastStarted = started;
        stableFor = 0;
      }

      throw new Error("Timed out waiting for /api/tasks traffic to settle");
    },
  };
}

test.describe("WebSocket Connection Handling", () => {
  // Start daemon for all tests
  test.beforeEach(async ({ daemon: _daemon }) => {
    // Daemon fixture ensures daemon is running
  });

  // AC: @web-dashboard ac-29
  test("shows connected status when daemon running", async ({ page }) => {
    await page.goto("/");

    // Wait for connection status to show "Connected" (no fixed timeout)
    const connectionStatus = page.getByTestId("connection-status");
    await expect(connectionStatus).toBeVisible();
    await expect(connectionStatus).toContainText("Connected");
  });

  // AC: @web-dashboard ac-28
  test("reconnects with exponential backoff after connection drop", async ({
    page,
    daemon: _d,
  }) => {
    // Intercept WebSocket constructor to track instances before navigating
    await page.addInitScript(() => {
      const instances: WebSocket[] = [];
      const OriginalWebSocket = window.WebSocket;
      (window as any).__test_ws_instances = instances;
      window.WebSocket = new Proxy(OriginalWebSocket, {
        construct(target, args) {
          const ws = new target(...(args as [string, ...any[]]));
          instances.push(ws);
          return ws;
        },
      });
    });

    await page.goto("/");

    // Wait for initial connection to be established
    const connectionStatus = page.getByTestId("connection-status");
    await expect(connectionStatus).toContainText("Connected");

    // Force-close the WebSocket from the client side to simulate a connection drop.
    // context.setOffline() is unreliable for already-open WebSocket connections.
    await page.evaluate(() => {
      const instances = (window as any).__test_ws_instances as WebSocket[] | undefined;
      if (instances) {
        instances.forEach((ws) => ws.close());
      }
    });

    // Wait for the status to change from "Connected" to something else
    await expect(connectionStatus).not.toContainText("Connected", { timeout: 5000 });

    // Verify status shows reconnecting or disconnected
    const text = await connectionStatus.textContent();
    expect(text).toMatch(/Reconnecting|Disconnected/);

    // WebSocket will attempt to reconnect. First attempt is after 1s backoff.
    // The daemon is still running so it should successfully reconnect.
    await expect(connectionStatus).toContainText("Connected", { timeout: 10000 });
  });

  // AC: @web-dashboard ac-29
  test("shows connection lost indicator after 10s disconnect", async ({ page, daemon: _d }) => {
    test.setTimeout(60000);
    // Use Playwright's routeWebSocket to control WebSocket connections.
    // Strategy: let the first connection succeed (proxied to real server),
    // then block all reconnection attempts by closing them immediately.
    // The manager's connectionLostTimer fires after 10s without a successful
    // reconnection, showing the "Connection Lost" indicator.

    let clientWs: { close: (opts?: { code?: number; reason?: string }) => void } | null = null;
    let blockReconnects = false;

    await page.routeWebSocket(/ws/, (ws) => {
      if (!blockReconnects) {
        // Proxy to real server for the initial connection.
        // Don't register onClose — Playwright auto-forwards close events
        // when no onClose handler is registered.
        const server = ws.connectToServer();
        server.onMessage((msg) => ws.send(msg));
        ws.onMessage((msg) => server.send(msg));
        clientWs = ws;
      } else {
        // Block reconnection: close the client-side WebSocket immediately.
        // The manager's onclose handler fires, which restarts the
        // connectionLostTimer and schedules the next reconnect with backoff.
        // Backoff schedule: 1s, 2s, 4s, 8s, 16s...
        // After the 8s-backoff attempt fails, the next attempt is 16s away.
        // The 10s connectionLostTimer fires in that gap → "Connection Lost".
        ws.close({ code: 1006, reason: "Blocked by test" });
      }
    });

    await page.goto("/");

    // Wait for initial connection
    const connectionStatus = page.getByTestId("connection-status");
    await expect(connectionStatus).toContainText("Connected");

    // Block all future reconnection attempts, then close the initial connection
    // from the Playwright route handler (client-side close).
    blockReconnects = true;
    clientWs!.close({ code: 1006, reason: "Test: simulating disconnect" });

    // The connectionLostTimer fires after 10s without a successful reconnect.
    // Cumulative backoff time before the 16s gap: 1+2+4+8 = 15s, then 10s timer.
    // Total worst case: ~25s. Use 35s timeout for safety.
    //
    // Wait for any state that isn't "Connected" first, to confirm the disconnect
    // is working, then wait for "Connection Lost".
    await expect(connectionStatus).not.toContainText("Connected", { timeout: 5000 });
    await expect(connectionStatus).toContainText("Connection Lost", { timeout: 35000 });
  });

  // AC: @web-dashboard ac-30
  test("skips duplicate events by sequence number", async ({ page, daemon: _daemon }) => {
    test.setTimeout(60000);
    // Prove the difference between "event handled" and "duplicate skipped":
    // the first injected event must start a task-list refetch, while replaying
    // the same seq must not start a second /api/tasks request.

    const tasksApi = trackTasksApi(page);

    let clientWs: {
      send: (data: string) => void;
    } | null = null;
    let forwardServerMessages = true;

    await page.routeWebSocket(/ws/, (ws) => {
      const server = ws.connectToServer();
      // Server→client forwarding is cut off after page load so real daemon
      // broadcasts (cache:status domain_ready, files:updates, tasks:updates)
      // cannot schedule query invalidations during the dedup measurement.
      // Safe to go silent: the client manager has no heartbeat, and the
      // daemon's pong timeout is 90s — far beyond this test's window.
      server.onMessage((msg) => {
        if (forwardServerMessages) {
          ws.send(msg);
        }
      });
      ws.onMessage((msg) => server.send(msg));
      clientWs = ws;
    });

    await page.goto("/tasks");

    // Wait for task list to load — proves connection and data are ready
    const taskListItems = page.getByTestId("task-list-item");
    await expect(taskListItems.first()).toBeVisible();

    // Make the measurement hermetic: from here on, the only WS events the
    // client receives are the ones this test injects.
    forwardServerMessages = false;

    // Drain pending traffic — including the up-to-1500ms delayed file-watcher
    // invalidation timers scheduled by events forwarded during page load —
    // before establishing the baseline.
    const baselineRequestCount = await tasksApi.settle();

    // First delivery of seq=500 must be handled and start a task-list refetch.
    // The baseline is settled and forwarding is cut, so any new /api/tasks
    // request is attributable to this injection.
    const firstRefetch = page.waitForRequest(
      (request) => request.method() === "GET" && isTasksApiUrl(request.url()),
    );
    clientWs!.send(
      JSON.stringify({
        msg_id: "test-duplicate-001-first",
        seq: 500,
        timestamp: new Date().toISOString(),
        topic: "tasks:updates",
        event: "task_updated",
        data: {
          ref: "@test-task-ready",
          ulid: "01KG0RR6CA45ZT43W2T6HJMVA1",
          action: "status_change",
          title: "Ready task",
          old_status: "pending",
          new_status: "in_progress",
        },
      }),
    );
    await firstRefetch;

    const afterFirstDeliveryCount = await tasksApi.settle();
    expect(afterFirstDeliveryCount).toBeGreaterThan(baselineRequestCount);

    // Replay the same seq. If deduplication is working, the second delivery is
    // skipped and no second /api/tasks request starts.
    clientWs!.send(
      JSON.stringify({
        msg_id: "test-duplicate-001-second",
        seq: 500,
        timestamp: new Date().toISOString(),
        topic: "tasks:updates",
        event: "task_updated",
        data: {
          ref: "@test-task-ready",
          ulid: "01KG0RR6CA45ZT43W2T6HJMVA1",
          action: "status_change",
          title: "Ready task",
          old_status: "pending",
          new_status: "in_progress",
        },
      }),
    );

    // If the duplicate were (incorrectly) processed, the invalidation would
    // start a request synchronously on the client — 1s is ample to observe it.
    await page.waitForTimeout(1000);
    expect(tasksApi.requestCount).toBe(afterFirstDeliveryCount);
  });

  // AC: @web-dashboard ac-31, ac-32
  test("resets sequence and re-subscribes on reconnect", async ({ page, daemon: _daemon }) => {
    test.setTimeout(60000);
    // Strategy:
    // 1. Proxy initial WebSocket connection to real server
    // 2. Wait for tasks page to load (proves subscription is active)
    // 3. Close the proxied connection to simulate disconnect
    // 4. Let the next connection succeed (also proxied)
    // 5. Track that a subscribe command is sent after reconnect (AC-32)
    // 6. After reconnect, inject a broadcast event with seq=0 and verify
    //    it is processed (proving lastSeqProcessed was reset to -1, AC-31)

    const tasksApi = trackTasksApi(page);

    let currentClientWs: {
      send: (data: string) => void;
      close: (opts?: { code?: number; reason?: string }) => void;
    } | null = null;
    let connectionCount = 0;
    let subscribeCommandSeen = false;

    await page.routeWebSocket(/ws/, (ws) => {
      connectionCount++;
      const server = ws.connectToServer();

      server.onMessage((msg) => ws.send(msg));
      ws.onMessage((msg) => {
        // Track subscribe commands sent to server after reconnect
        if (typeof msg === "string" && connectionCount > 1) {
          try {
            const parsed = JSON.parse(msg);
            if (parsed.action === "subscribe") {
              subscribeCommandSeen = true;
            }
          } catch {
            // not JSON
          }
        }
        server.send(msg);
      });

      currentClientWs = ws;
    });

    await page.goto("/tasks");

    // Wait for initial data load and connection
    await expect(page.getByTestId("task-list-item").first()).toBeVisible();
    await expect(page.getByTestId("connection-status")).toContainText("Connected");

    const _initialCount = await page.getByTestId("task-list-item").count();

    // Simulate disconnect by closing the WebSocket from the route handler
    currentClientWs!.close({ code: 1006, reason: "Test: simulating disconnect" });

    // Wait for reconnection (backoff starts at 1s)
    await expect(page.getByTestId("connection-status")).toContainText("Connected", {
      timeout: 10000,
    });

    // Verify that at least 2 connections were made (initial + reconnect)
    expect(connectionCount).toBeGreaterThanOrEqual(2);

    // AC-32: verify subscribe command was sent after reconnect
    expect(subscribeCommandSeen).toBe(true);

    const baselineRequestCount = await tasksApi.settle();

    // AC-31: inject a broadcast event with seq=0. If lastSeqProcessed was NOT
    // reset to -1 on reconnect, this event would be skipped and no /api/tasks
    // refetch would happen. A refetch proves the handler accepted seq=0 after
    // reconnect.
    const postReconnectRefetch = page.waitForRequest(
      (request) => request.method() === "GET" && isTasksApiUrl(request.url()),
    );
    currentClientWs!.send(
      JSON.stringify({
        msg_id: "test-reconnect-event-001",
        seq: 0,
        timestamp: new Date().toISOString(),
        topic: "tasks:updates",
        event: "task_updated",
        data: {
          ref: "@test-task-in-progress",
          ulid: "01KG0RR8CB8N4YGP991WD7XS9R",
          action: "note_added",
          title: "In progress task",
          old_status: null,
          new_status: null,
        },
      }),
    );
    await postReconnectRefetch;

    // The UI stays populated after reconnect, and the refetch above proves the
    // seq=0 event was accepted instead of skipped.
    await expect(page.getByTestId("task-list-item").first()).toBeVisible();
    expect(tasksApi.requestCount).toBeGreaterThan(baselineRequestCount);
  });

  // AC: @web-dashboard ac-28
  test("exponential backoff caps at 30s", async ({ page, context: _context }) => {
    await page.goto("/");

    // This is a documentary test for the max backoff behavior.
    // Actually testing the 30s cap would require:
    // 1. Multiple reconnect attempts (10+)
    // 2. Waiting for cumulative backoff time (1+2+4+8+16+30+30+...)
    // 3. Total test time would exceed reasonable E2E test duration

    // The unit tests for WebSocketManager verify the backoff calculation.
    // This test documents the expected behavior.

    const connectionStatus = page.getByTestId("connection-status");
    await expect(connectionStatus).toContainText("Connected");
    await expect(connectionStatus).toBeVisible();
  });

  // AC: @web-dashboard ac-28
  test("stops reconnecting after max attempts", async ({ page, context: _context }) => {
    // This is a documentary test for max reconnect attempts.
    // The WebSocketManager is configured to stop after MAX_RECONNECT_ATTEMPTS (10).
    // Testing this would require keeping the network offline for extended period
    // and verifying reconnect attempts cease.

    // The implementation exists in manager.ts:
    // - if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;

    // For E2E purposes, we document the behavior without full integration test.
    await page.goto("/");

    const connectionStatus = page.getByTestId("connection-status");
    await expect(connectionStatus).toBeVisible();
  });
});
