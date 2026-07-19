import { test, expect } from "./fixtures/test-base";

async function waitForConnected(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("connection-status")).toContainText("Connected", {
    timeout: 10_000,
  });
}

test.describe("WebSocket UI Behavior", () => {
  // AC: @web-dashboard ac-29
  test("shows connected status in the sidebar when the daemon-backed UI loads", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/tasks");
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await waitForConnected(page);
  });

  // AC: @web-dashboard ac-33
  // AC: @ui-data-freshness ac-3
  test("updates the tasks list after an external task mutation without a page refresh", async ({
    page,
    daemon,
  }) => {
    await page.goto("/tasks");
    await waitForConnected(page);

    const readyTask = page.getByTestId("task-list-item").filter({ hasText: "Ready task" });
    await expect(readyTask).toBeVisible();
    await expect(readyTask.getByTestId("task-status-badge")).toContainText(/pending/i);

    const response = await page.request.post(
      `${daemon.baseUrl}/api/tasks/01KG0RR6CA45ZT43W2T6HJMVA1/start`,
    );
    expect(response.ok()).toBe(true);

    await expect(readyTask.getByTestId("task-status-badge")).toContainText(/in progress/i, {
      timeout: 10_000,
    });
  });

  // AC: @ui-data-freshness ac-3
  // AC: @ui-data-freshness ac-4
  test("increments the inbox sidebar badge and renders the new item after an external inbox write", async ({
    page,
    daemon,
  }) => {
    await page.goto("/inbox");
    await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
    await waitForConnected(page);

    const inboxBadge = page.getByTestId("badge-inbox");
    await expect(inboxBadge).toBeVisible();
    const initialCount = Number((await inboxBadge.textContent())?.trim() ?? "0");

    const text = `WebSocket inbox item ${Date.now()}`;
    const response = await page.request.post(`${daemon.baseUrl}/api/inbox`, {
      data: { text },
    });
    expect(response.ok()).toBe(true);

    await expect
      .poll(async () => Number((await inboxBadge.textContent())?.trim() ?? "0"))
      .toBe(initialCount + 1);
    await expect(page.getByTestId("inbox-item").first()).toContainText(text);
  });

  // AC: @web-dashboard ac-28
  // AC: @web-dashboard ac-29
  test("shows disconnection and reconnects after the daemon restarts", async ({ page, daemon }) => {
    // Reconnect timing is governed by the spec'd exponential backoff
    // (ac-28: 1s, 2s, 4s... capped at 30s), so attempts land at cumulative
    // ~1s, 3s, 7s, 15s, 31s after the disconnect. daemon.stop()/start()
    // serialize on the global port-start lock shared by every parallel
    // worker, so under a full-suite run the daemon can be down >15s and the
    // first reconnect attempt after restart can be a full 30s backoff gap
    // away. Budget the test for that worst case instead of assuming an
    // early backoff attempt lands after the restart.
    test.setTimeout(120_000);

    await page.goto("/");
    await waitForConnected(page);

    const connectionStatus = page.getByTestId("connection-status");

    await daemon.stop();
    // After >10s offline the badge upgrades from "Disconnected" to
    // "Connection Lost" (ac-29). Accept either as disconnection evidence so
    // a slow stop under lock contention cannot strand this assertion on a
    // label that has already moved on.
    await expect(connectionStatus).toContainText(/Disconnected|Connection Lost/, {
      timeout: 10_000,
    });

    await daemon.start();
    // 45s covers the 30s worst-case backoff gap between daemon readiness
    // and the next reconnect attempt, plus the attempt itself.
    await expect(connectionStatus).toContainText("Connected", { timeout: 45_000 });
  });
});
