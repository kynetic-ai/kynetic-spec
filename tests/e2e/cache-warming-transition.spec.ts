/**
 * Cache warming to ready transition — full-stack E2E tests.
 *
 * These tests exercise the full daemon -> WebSocket -> TanStack Query -> Svelte
 * path using a real delayed project registration rather than route interception.
 *
 * AC: @ui-data-freshness ac-warming-skeleton
 * AC: @ui-data-freshness ac-warming-auto-transition
 * AC: @ui-data-freshness ac-warming-retry-fallback
 * AC: @ui-data-freshness ac-warming-timeout
 */

import { test, expect, type Page, type Request } from "./fixtures/test-base";

declare global {
  interface Window {
    __kspecWsMessages?: Array<{
      topic?: string;
      event?: string;
      data?: Record<string, unknown>;
    }>;
  }
}

const CACHE_WARMING_RETRY_DELAY_MS = 2000;

function secondProjectPath(daemon: { tempDir: string }) {
  return `${daemon.tempDir}-second`;
}

function isTasksRequestForProject(request: Request, projectPath: string): boolean {
  const url = request.url();
  return (
    request.method() === "GET" &&
    (url.endsWith("/api/tasks") || url.includes("/api/tasks?")) &&
    request.headers()["x-kspec-dir"] === projectPath
  );
}

async function installWsRecorder(page: Page) {
  await page.addInitScript(() => {
    window.__kspecWsMessages = [];

    const NativeWebSocket = window.WebSocket;
    class RecordingWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          try {
            const parsed = JSON.parse(String(event.data)) as {
              topic?: string;
              event?: string;
              data?: Record<string, unknown>;
            };
            window.__kspecWsMessages?.push(parsed);
          } catch {
            // Ignore non-JSON frames such as pings/acks.
          }
        });
      }
    }

    window.WebSocket = RecordingWebSocket;
  });
}

async function setDelay(baseUrl: string, projectPath: string) {
  const res = await fetch(`${baseUrl}/api/__test__/cache/delay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath }),
  });
  if (!res.ok) throw new Error(`Failed to set test delay: ${await res.text()}`);
}

async function releaseDelay(baseUrl: string, projectPath: string) {
  const res = await fetch(`${baseUrl}/api/__test__/cache/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath }),
  });
  if (!res.ok) throw new Error(`Failed to release test delay: ${await res.text()}`);
}

async function waitForDomainState(
  baseUrl: string,
  projectPath: string,
  domain: string,
  expectedState: string,
  timeoutMs = 10000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${baseUrl}/api/debug/cache-status`);
    if (res.ok) {
      const data = await res.json();
      const project = data.projects?.find(
        (candidate: { path: string }) => candidate.path === projectPath,
      );
      if (project?.domains?.[domain]?.state === expectedState) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(
    `Domain "${domain}" did not reach state "${expectedState}" within ${timeoutMs}ms`,
  );
}

async function waitForDomainReadyEvent(
  page: Page,
  projectPath: string,
  domain: string,
  timeoutMs = 10000,
) {
  await page.waitForFunction(
    ({ expectedProjectPath, expectedDomain }) =>
      window.__kspecWsMessages?.some(
        (message) =>
          message.topic === "cache:status" &&
          message.event === "domain_ready" &&
          message.data?.projectPath === expectedProjectPath &&
          message.data?.domain === expectedDomain,
      ) ?? false,
    { expectedProjectPath: projectPath, expectedDomain: domain },
    { timeout: timeoutMs },
  );
}

async function selectSecondProject(page: Page, projectPath: string) {
  const projectSelector = page.getByTestId("project-selector");
  await expect(projectSelector).toBeVisible({ timeout: 10000 });

  const projectReload = page.waitForRequest((request) =>
    isTasksRequestForProject(request, projectPath),
  );

  await projectSelector.click();

  const dropdownContent = page.locator('[data-slot="select-content"]');
  await expect(dropdownContent).toBeVisible({ timeout: 5000 });
  await dropdownContent
    .locator('[data-slot="select-item"]')
    .filter({ hasText: "second" })
    .click();

  await projectReload;
  await expect(projectSelector).toContainText("second");
}

test.describe("Cache Warming Full-Stack Integration", () => {
  // AC: @ui-data-freshness ac-warming-skeleton
  test("shows a loading skeleton instead of persisting empty data while a new project's cache is warming", async ({
    page,
    daemon,
  }) => {
    const projectPath = secondProjectPath(daemon);

    await installWsRecorder(page);
    await setDelay(daemon.baseUrl, projectPath);
    await daemon.createSecondProject();

    try {
      await page.goto("/tasks");
      await page.waitForLoadState("networkidle");
      await selectSecondProject(page, projectPath);

      const skeleton = page.getByTestId("tasks-loading");
      await expect(skeleton).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId("task-list")).not.toBeVisible();
      await expect(page.getByText("No tasks found")).not.toBeVisible();

      await page.goto("/");
      await page.goto("/tasks");
      await expect(skeleton).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId("task-list")).not.toBeVisible();
    } finally {
      await releaseDelay(daemon.baseUrl, projectPath);
    }
  });

  // AC: @ui-data-freshness ac-warming-auto-transition
  // AC: @ui-data-freshness ac-warming-retry-fallback
  test("retries while warming and then refetches immediately when the domain_ready WebSocket event arrives", async ({
    page,
    daemon,
  }) => {
    const projectPath = secondProjectPath(daemon);
    const taskRequestTimes: number[] = [];

    await installWsRecorder(page);
    page.on("request", (request) => {
      if (isTasksRequestForProject(request, projectPath)) {
        taskRequestTimes.push(Date.now());
      }
    });

    await setDelay(daemon.baseUrl, projectPath);
    await daemon.createSecondProject();

    try {
      await page.goto("/tasks");
      await page.waitForLoadState("networkidle");
      await selectSecondProject(page, projectPath);

      const skeleton = page.getByTestId("tasks-loading");
      await expect(skeleton).toBeVisible({ timeout: 10000 });

      const requestCountAtSkeleton = taskRequestTimes.length;
      await expect
        .poll(() => taskRequestTimes.length, {
          timeout: 10000,
          message: "expected cache-warming retry fallback to issue another tasks request",
        })
        .toBeGreaterThan(requestCountAtSkeleton);

      const releaseStartedAt = Date.now();
      await releaseDelay(daemon.baseUrl, projectPath);

      await waitForDomainState(daemon.baseUrl, projectPath, "tasks", "ready");
      await waitForDomainReadyEvent(page, projectPath, "tasks");

      await expect
        .poll(
          () => {
            const timestamp = taskRequestTimes.find(
              (candidate) => candidate >= releaseStartedAt,
            );
            return timestamp ? timestamp - releaseStartedAt : Number.POSITIVE_INFINITY;
          },
          {
            timeout: 10000,
            message: "expected an immediate tasks refetch after the domain_ready event",
          },
        )
        .toBeLessThan(CACHE_WARMING_RETRY_DELAY_MS);

      const taskList = page.getByTestId("task-list");
      await expect(taskList).toBeVisible({ timeout: 15000 });
      await expect(taskList).toContainText("No tasks found");
      await expect(skeleton).not.toBeVisible();
    } catch (error) {
      await releaseDelay(daemon.baseUrl, projectPath);
      throw error;
    }
  });

  // AC: @ui-data-freshness ac-warming-timeout
  test("shows the timeout banner after the retry ceiling and recovers through the manual Retry button", async ({
    page,
    daemon,
  }) => {
    test.setTimeout(70000);

    const projectPath = secondProjectPath(daemon);

    await installWsRecorder(page);
    await setDelay(daemon.baseUrl, projectPath);
    await daemon.createSecondProject();

    try {
      await page.goto("/tasks");
      await page.waitForLoadState("networkidle");
      await selectSecondProject(page, projectPath);

      await expect(page.getByTestId("tasks-loading")).toBeVisible({ timeout: 10000 });

      await page.waitForTimeout(35000);

      const banner = page.getByTestId("cache-warming-timeout");
      await expect(banner).toBeVisible({ timeout: 10000 });
      await expect(banner).toContainText("Unable to load tasks");
      await expect(page.getByTestId("tasks-loading")).not.toBeVisible();

      const retryButton = page.getByTestId("cache-warming-retry");
      await expect(retryButton).toBeVisible();
      await expect(retryButton).toBeEnabled();

      await Promise.all([
        expect(page.getByTestId("tasks-loading")).toBeVisible({ timeout: 10000 }),
        retryButton.click(),
      ]);

      await releaseDelay(daemon.baseUrl, projectPath);

      const taskList = page.getByTestId("task-list");
      await expect(taskList).toBeVisible({ timeout: 15000 });
      await expect(taskList).toContainText("No tasks found");
      await expect(page.getByTestId("cache-warming-timeout")).not.toBeVisible();
    } catch (error) {
      await releaseDelay(daemon.baseUrl, projectPath);
      throw error;
    }
  });
});
