/**
 * Cache warming view state E2E tests.
 *
 * Verifies that actual route components render the correct UI branches
 * when the daemon responds with cache_status: "loading" (CacheWarmingError).
 *
 * Tests exercise real rendered views — not reimplemented logic — to prove
 * that skeletons appear during warming and CacheWarmingBanner appears after
 * the retry ceiling is reached.
 *
 * AC: @ui-data-freshness ac-warming-skeleton — skeleton displayed instead of empty content
 * AC: @ui-data-freshness ac-warming-timeout — error state with manual retry after 30s
 */

import { test, expect } from "../fixtures/test-base";

/** Return a response envelope with cache_status: "loading" (triggers CacheWarmingError). */
function warmingEnvelope<T>(data: T, meta?: Record<string, unknown>) {
  return { data, meta: { cache_status: "loading" as const, ...meta } };
}

/** Return a normal response envelope with cache_status: "ready". */
function readyEnvelope<T>(data: T, meta?: Record<string, unknown>) {
  return { data, meta: { cache_status: "ready" as const, ...meta } };
}

const emptyTasksResponse = { items: [], total: 0, offset: 0, limit: 50 };
const emptyInboxResponse = { items: [], total: 0, offset: 0, limit: 50 };
const emptyTriageRecords: never[] = [];

/**
 * Intercept all common sidebar/health API calls so pages don't fail on
 * unrelated endpoints. These always return ready.
 */
async function interceptCommonAPIs(page: import("@playwright/test").Page) {
  // Health check
  await page.route("**/api/health", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok" }),
    });
  });

  // Badge counts used by sidebar
  await page.route("**/api/inbox/count*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(readyEnvelope({ count: 0 })),
    });
  });

  await page.route("**/api/tasks/summary*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(readyEnvelope({ total: 0, by_status: {} })),
    });
  });

  // Session context
  await page.route("**/api/session-context*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(readyEnvelope(null)),
    });
  });

  // Agent status
  await page.route("**/api/agents/status*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(readyEnvelope({ dispatch: { status: "stopped" } })),
    });
  });
}

test.describe("Cache Warming View States", () => {
  // AC: @ui-data-freshness ac-warming-skeleton
  test.describe("skeleton during cache warming", () => {
    test("tasks list shows loading skeleton while cache is warming", async ({
      page,
      daemon: _daemon,
    }) => {
      await interceptCommonAPIs(page);

      // All task API calls return cache_status: "loading"
      await page.route("**/api/tasks?*", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(warmingEnvelope(emptyTasksResponse)),
        });
      });
      await page.route(/\/api\/tasks$/, (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(warmingEnvelope(emptyTasksResponse)),
        });
      });

      await page.goto("/tasks");

      // During retries, isLoading stays true — loading skeleton should appear
      const skeleton = page.getByTestId("tasks-loading");
      await expect(skeleton).toBeVisible({ timeout: 5000 });

      // The task list should NOT be visible (data hasn't loaded)
      await expect(page.getByTestId("task-list")).not.toBeVisible();
    });

    test("tasks list transitions to real data when cache becomes ready", async ({
      page,
      daemon: _daemon,
    }) => {
      await interceptCommonAPIs(page);

      let requestCount = 0;
      const taskItems = [
        {
          _ulid: "01KG0RR6CA45ZT43W2T6HJMVA1",
          slugs: ["test-task"],
          title: "Test Task",
          type: "task",
          status: "pending",
          priority: 2,
          tags: [],
          depends_on: [],
          created_at: "2026-01-01T00:00:00Z",
        },
      ];

      // First few requests return "loading", then switch to "ready"
      await page.route(/\/api\/tasks/, (route) => {
        requestCount++;
        if (requestCount <= 2) {
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(warmingEnvelope(emptyTasksResponse)),
          });
        } else {
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(
              readyEnvelope({ items: taskItems, total: 1, offset: 0, limit: 50 }),
            ),
          });
        }
      });

      await page.goto("/tasks");

      // Should show skeleton initially
      await expect(page.getByTestId("tasks-loading")).toBeVisible({ timeout: 5000 });

      // After cache becomes ready, real content should appear
      await expect(page.getByTestId("task-list")).toBeVisible({ timeout: 15000 });
    });
  });

  // AC: @ui-data-freshness ac-warming-timeout
  test.describe("timeout banner after retries exhausted", () => {
    test("shows CacheWarmingBanner after all retries fail on tasks page", async ({
      page,
      daemon: _daemon,
    }) => {
      // Install fake timers to fast-forward retry delays
      await page.clock.install();

      await interceptCommonAPIs(page);

      // Always return cache_status: "loading" — retries will never succeed
      await page.route(/\/api\/tasks/, (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(warmingEnvelope(emptyTasksResponse)),
        });
      });

      await page.goto("/tasks");
      // Advance time to let the page scripts run
      await page.clock.runFor(500);

      // Fast-forward through 15 retries × 2s delay = 30s
      // TanStack Query uses setTimeout for retryDelay, so fake timers control it
      for (let i = 0; i < 20; i++) {
        await page.clock.runFor(2500);
      }

      // After retries are exhausted, the CacheWarmingBanner should appear
      const banner = page.getByTestId("cache-warming-timeout");
      await expect(banner).toBeVisible({ timeout: 5000 });

      // Banner should display the entity name
      await expect(banner).toContainText("Unable to load tasks");

      // Banner should have a retry button
      const retryButton = page.getByTestId("cache-warming-retry");
      await expect(retryButton).toBeVisible();
      await expect(retryButton).toBeEnabled();
    });

    test("retry button resets queries and returns to loading state", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.clock.install();

      await interceptCommonAPIs(page);

      let requestCount = 0;
      const taskItems = [
        {
          _ulid: "01KG0RR6CA45ZT43W2T6HJMVA1",
          slugs: ["test-task"],
          title: "Test After Retry",
          type: "task",
          status: "pending",
          priority: 2,
          tags: [],
          depends_on: [],
          created_at: "2026-01-01T00:00:00Z",
        },
      ];

      // First phase: always return loading (until we click retry)
      // After retry: return ready data
      await page.route(/\/api\/tasks/, (route) => {
        requestCount++;
        // After ~20 requests (initial + retries), switch to ready
        if (requestCount > 20) {
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(
              readyEnvelope({ items: taskItems, total: 1, offset: 0, limit: 50 }),
            ),
          });
        } else {
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(warmingEnvelope(emptyTasksResponse)),
          });
        }
      });

      await page.goto("/tasks");
      await page.clock.runFor(500);

      // Exhaust retries
      for (let i = 0; i < 20; i++) {
        await page.clock.runFor(2500);
      }

      // Banner should be visible
      await expect(page.getByTestId("cache-warming-timeout")).toBeVisible({ timeout: 5000 });

      // Click retry button
      await page.getByTestId("cache-warming-retry").click();
      await page.clock.runFor(500);

      // After retry with ready data, task list should appear
      // The reset triggers a fresh query which now returns ready data
      for (let i = 0; i < 5; i++) {
        await page.clock.runFor(2500);
      }

      await expect(page.getByTestId("task-list")).toBeVisible({ timeout: 10000 });
    });
  });

  // AC: @ui-data-freshness ac-warming-skeleton — sessions search mode cache warming
  // AC: @ui-data-freshness ac-warming-timeout — sessions search mode timeout banner
  test.describe("sessions search mode cache warming", () => {
    test("shows skeleton while search query is warming", async ({
      page,
      daemon: _daemon,
    }) => {
      await interceptCommonAPIs(page);

      // Sessions list returns ready (won't be fetched in search mode)
      await page.route("**/api/sessions?*", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(readyEnvelope({ items: [], total: 0, offset: 0, limit: 25 })),
        });
      });

      // Sessions search returns cache_status: "loading"
      await page.route("**/api/sessions/search*", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(warmingEnvelope({ items: [], total_sessions: 0, total_matches: 0, query: "test" })),
        });
      });

      await page.goto("/sessions?q=test");

      // During retries, searchLoading stays true — loading skeleton should appear
      const skeleton = page.getByTestId("sessions-loading");
      await expect(skeleton).toBeVisible({ timeout: 5000 });
    });

    test("shows timeout banner when search query exhausts retries", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.clock.install();

      await interceptCommonAPIs(page);

      // Sessions search always returns cache_status: "loading"
      await page.route("**/api/sessions/search*", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(warmingEnvelope({ items: [], total_sessions: 0, total_matches: 0, query: "test" })),
        });
      });

      await page.goto("/sessions?q=test");
      await page.clock.runFor(500);

      // Fast-forward through retries
      for (let i = 0; i < 20; i++) {
        await page.clock.runFor(2500);
      }

      // Banner should be visible with sessions entity name
      const banner = page.getByTestId("cache-warming-timeout");
      await expect(banner).toBeVisible({ timeout: 5000 });
      await expect(banner).toContainText("Unable to load sessions");
    });
  });

  // AC: @ui-data-freshness ac-warming-timeout — triage page resets both queries
  test.describe("triage page dual-query retry", () => {
    test("triage page shows timeout banner when either query has warming error", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.clock.install();

      await interceptCommonAPIs(page);

      // Merged inbox returns ready, but triage records returns loading
      await page.route("**/api/inbox/merged*", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(readyEnvelope(emptyInboxResponse)),
        });
      });

      await page.route("**/api/triage*", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(warmingEnvelope(emptyTriageRecords)),
        });
      });

      await page.goto("/triage");
      await page.clock.runFor(500);

      // Fast-forward through retries
      for (let i = 0; i < 20; i++) {
        await page.clock.runFor(2500);
      }

      // Banner should show for triage data
      const banner = page.getByTestId("cache-warming-timeout");
      await expect(banner).toBeVisible({ timeout: 5000 });
      await expect(banner).toContainText("Unable to load triage data");
    });
  });
});
