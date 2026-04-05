import { test, expect } from "./fixtures/test-base";

test.describe("Smoke Tests", () => {
  // AC: @daemon-runtime-adapter ac-http-parity
  // AC: @daemon-runtime-adapter ac-websocket-parity
  test("page loads and shows sidebar", async ({ page, daemon: _daemon }) => {
    await page.goto("/");

    // Sidebar navigation renders the dashboard entry in the desktop shell
    await expect(page.getByTestId("nav-link-dashboard")).toBeVisible();

    // Connection status shows connected
    const connectionStatus = page.getByTestId("connection-status");
    await expect(connectionStatus).toBeVisible();
    await expect(connectionStatus).toContainText(/connected/i);
  });
  test("dashboard page loads with navigation", async ({ page, daemon: _daemon }) => {
    await page.goto("/");

    // Should see the kspec header
    await expect(page.getByText("kspec").first()).toBeVisible();

    // Should see the Dashboard heading
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("can load tasks page", async ({ page, daemon: _daemon }) => {
    // Navigate directly to tasks page
    await page.goto("/tasks");

    // Wait for page to load - check for the heading
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();

    // Task list should be visible
    await expect(page.getByTestId("task-list")).toBeVisible({ timeout: 15000 });
  });

  test("can load items page", async ({ page, daemon: _daemon }) => {
    await page.goto("/items");

    // Wait for page to load - check for the heading
    await expect(page.getByRole("heading", { name: "Items" })).toBeVisible();
  });

  test("can load inbox page", async ({ page, daemon: _daemon }) => {
    await page.goto("/inbox");

    // Wait for page to load - check for the heading
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  });

  // AC: @streaming-markdown-component ac-7
  // AC: @ws-session-event-streaming ac-message-start
  // AC: @ws-session-event-streaming ac-message-progress
  test("live session output renders markdown with the blinking streaming cursor", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.route("**/api/sessions/test-session-stream", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "test-session-stream",
            status: "active",
            agent_type: "task-worker",
            agent_id: "worker",
            session_type: "invocation",
            trigger: "task.ready",
            task_id: null,
            started_at: "2026-03-11T11:00:00.000Z",
            duration_ms: 1000,
            event_count: 0,
            iteration_count: 1,
            tasks_completed: 0,
          },
          meta: { cache_status: "ready" },
        }),
      });
    });

    await page.route("**/api/sessions/test-session-stream/events*", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { events: [] }, meta: { total: 0, cache_status: "ready" } }),
      });
    });

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

    await page.goto("/sessions/test-session-stream");
    await expect(page.getByTestId("session-stream")).toBeVisible();

    // Send message_start first (new WS protocol), then message_progress with content
    const injected = await page.evaluate(() => {
      const instances = (window as any).__test_ws_instances as WebSocket[];
      const ws = instances?.find((socket) => socket.readyState === WebSocket.OPEN);
      if (!ws) return false;

      ws.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            msg_id: "test-stream-001",
            seq: 9998,
            timestamp: new Date().toISOString(),
            topic: "agents",
            event: "message_start",
            data: {
              session_id: "test-session-stream",
            },
          }),
        }),
      );

      ws.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            msg_id: "test-stream-002",
            seq: 9999,
            timestamp: new Date().toISOString(),
            topic: "agents",
            event: "message_progress",
            data: {
              session_id: "test-session-stream",
              text: "Hello **markdown**\n",
            },
          }),
        }),
      );

      return true;
    });

    expect(injected).toBe(true);

    // Content renders inside a message block via StreamingMarkdown
    const messageBlock = page.getByTestId("message-block");
    await expect(messageBlock).toBeVisible();
    await expect(messageBlock.locator('[data-testid="streaming-markdown"] strong')).toHaveText(
      "markdown",
    );

    const cursor = page.locator(".ds-streaming-cursor");
    await expect(cursor).toBeVisible();
    await expect
      .poll(async () => cursor.evaluate((node) => getComputedStyle(node).animationName))
      .toContain("cursor-blink");
  });
});
