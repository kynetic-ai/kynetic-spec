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
    await page.goto("/");
    await waitForConnected(page);

    const connectionStatus = page.getByTestId("connection-status");

    await daemon.stop();
    await expect(connectionStatus).toContainText("Disconnected", { timeout: 2_000 });

    await daemon.start();
    await expect(connectionStatus).toContainText("Connected", { timeout: 10_000 });
  });
});
