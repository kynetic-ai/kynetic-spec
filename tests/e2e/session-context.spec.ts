import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "./fixtures/test-base";

async function writeSessionFixture(
  projectRoot: string,
  options: {
    id: string;
    taskId: string;
    status?: "active" | "completed" | "abandoned" | "timed_out" | "failed";
    startedAt: string;
    endedAt?: string;
    trigger?: string;
  },
) {
  const sessionDir = join(projectRoot, ".kspec-sessions", options.id);
  await mkdir(sessionDir, { recursive: true });
  const status = options.status ?? "completed";
  const trigger = options.trigger ?? "task.ready";
  const endedAtLine = options.endedAt ? `ended_at: "${options.endedAt}"\n` : "";

  await writeFile(
    join(sessionDir, "session.yaml"),
    `id: "${options.id}"
task_id: "${options.taskId}"
agent_type: "claude-agent-acp"
agent_id: "worker"
trigger: "${trigger}"
status: "${status}"
started_at: "${options.startedAt}"
${endedAtLine}`,
    "utf-8",
  );
  await writeFile(join(sessionDir, "events.jsonl"), "", "utf-8");
}

async function seedRelatedSessions(projectRoot: string) {
  await writeSessionFixture(projectRoot, {
    id: "session-task-ready",
    taskId: "@test-task-ready",
    startedAt: "2026-03-01T10:00:00Z",
    endedAt: "2026-03-01T10:05:00Z",
  });
  await writeSessionFixture(projectRoot, {
    id: "session-task-progress",
    taskId: "@test-task-in-progress",
    startedAt: "2026-03-01T12:00:00Z",
    endedAt: "2026-03-01T12:08:00Z",
    trigger: "task.in_progress",
  });
}

async function waitForRelatedSessionCount(
  request: APIRequestContext,
  url: string,
  expectedTotal: number,
) {
  await expect
    .poll(
      async () => {
        const response = await request.get(url);
        if (!response.ok()) {
          return -1;
        }

        const body = await response.json();
        return body.meta?.total ?? -1;
      },
      {
        timeout: 5000,
        message: `wait for ${url} to report ${expectedTotal} related session(s)`,
      },
    )
    .toBe(expectedTotal);
}

test.describe("Task and Spec Session Context", () => {
  // AC: @task-spec-session-context ac-api-task-sessions
  test("GET /api/tasks/:ref/sessions returns task-linked session summaries", async ({
    request,
    daemon,
  }) => {
    await seedRelatedSessions(daemon.tempDir);
    const url = `${daemon.baseUrl}/api/tasks/@test-task-ready/sessions`;
    await waitForRelatedSessionCount(request, url, 1);

    const response = await request.get(url);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.meta.total).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: "session-task-ready",
      task_id: "@test-task-ready",
      status: "completed",
      started_at: "2026-03-01T10:00:00Z",
    });
    expect(body.data[0].duration_ms).toBe(300000);
  });

  // AC: @task-spec-session-context ac-api-item-sessions
  test("GET /api/items/:ref/sessions returns sessions for tasks aligned to the spec", async ({
    request,
    daemon,
  }) => {
    await seedRelatedSessions(daemon.tempDir);
    const url = `${daemon.baseUrl}/api/items/@test-feature/sessions`;
    await waitForRelatedSessionCount(request, url, 2);

    const response = await request.get(url);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.meta.total).toBe(2);
    expect(body.data.map((item: { id: string }) => item.id)).toEqual([
      "session-task-progress",
      "session-task-ready",
    ]);
    expect(body.data.map((item: { task_id: string }) => item.task_id).toSorted()).toEqual([
      "@test-task-in-progress",
      "@test-task-ready",
    ]);
  });

  // AC: @task-spec-session-context ac-task-detail-sessions
  // AC: @task-spec-session-context ac-session-list-task-filter
  test("task detail lists related sessions and links to filtered sessions view", async ({
    page,
    daemon,
  }) => {
    await seedRelatedSessions(daemon.tempDir);
    await waitForRelatedSessionCount(
      page.request,
      `${daemon.baseUrl}/api/tasks/@test-task-ready/sessions`,
      1,
    );

    await page.goto("/tasks");

    const readyTask = page
      .getByTestId("task-list-item")
      .filter({ has: page.getByText("Ready task") })
      .first();
    await readyTask.click();

    const detailPanel = page.getByTestId("task-detail-panel");
    await expect(detailPanel).toBeVisible();

    const sessionsSection = detailPanel.getByTestId("task-related-sessions");
    await expect(sessionsSection).toBeVisible();
    const row = sessionsSection.getByTestId("task-related-sessions-row");
    await expect(row).toHaveCount(1);
    await expect(row.first()).toContainText("completed");
    await expect(row.first()).toContainText("5m 0s");
    await expect(row.first()).toHaveAttribute("href", /\/sessions\/session-task-ready$/);

    await sessionsSection.getByTestId("task-related-sessions-view-all").click();
    await page.waitForURL(/\/sessions\?task_id=%40test-task-ready/);

    const sessionRows = page.getByTestId("session-row");
    await expect(sessionRows).toHaveCount(1);
    await expect(page.getByTestId("session-task-ref")).toContainText("Ready task");
  });

  // AC: @task-spec-session-context ac-spec-detail-sessions
  // AC: @task-spec-session-context ac-session-list-spec-filter
  test("spec detail lists related sessions and links to spec-filtered sessions view", async ({
    page,
    daemon,
  }) => {
    await seedRelatedSessions(daemon.tempDir);
    await waitForRelatedSessionCount(page.request, `${daemon.baseUrl}/api/items/@test-feature/sessions`, 2);

    await page.goto("/items");

    const specTree = page.getByTestId("spec-tree").first();
    const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
    await moduleNode.locator("> div").first().getByTestId("expand-toggle").click();

    const childContainer = moduleNode.getByTestId("tree-node-child");
    const featureNode = childContainer.locator('[data-testid*="tree-node-feature"]').first();
    await featureNode.locator("> div").first().getByTestId("node-title").click();

    const detailPanel = page.getByTestId("spec-detail-panel");
    await expect(detailPanel).toBeVisible();

    const sessionsSection = detailPanel.getByTestId("item-related-sessions");
    await expect(sessionsSection).toBeVisible();
    const rows = sessionsSection.getByTestId("item-related-sessions-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("completed");
    await expect(rows.first()).toHaveAttribute("href", /\/sessions\/session-task-progress$/);

    await sessionsSection.getByTestId("item-related-sessions-view-all").click();
    await page.waitForURL(/\/sessions\?spec_ref=%40test-feature/);

    const sessionRows = page.getByTestId("session-row");
    await expect(sessionRows).toHaveCount(2);
    await expect(page.getByTestId("session-filter-count")).toContainText("2 of 2 sessions");
  });
});
