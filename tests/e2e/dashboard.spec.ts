import { test, expect, getFixtureTaskCounts } from "./fixtures/test-base";

/**
 * Dashboard Overview E2E Tests
 *
 * Tests for the dashboard home view — "what's happening right now?"
 *
 * Covered ACs:
 * - AC: @ui-dashboard-overview ac-1 — Active work, status summary, needs-attention aggregation
 *
 * Legacy ACs preserved:
 * - AC: @web-dashboard ac-1, ac-3, ac-20
 *
 * Strategy: The built web UI hardcodes DAEMON_API_BASE to localhost:3456, but E2E
 * daemons run on ephemeral ports. Data-dependent tests use page.route() to intercept
 * browser-side API calls and fulfill with fixture-consistent data, validating the
 * full UI aggregation path (fetch → compute → render).
 */

// --- Mock data matching E2E fixture expectations ---

/** Wrap data in the unified API response envelope. */
function envelope<T>(data: T, meta?: Record<string, unknown>) {
  return { data, meta: { cache_status: "ready" as const, ...meta } };
}

/** Task data matching tests/e2e/fixtures/project.tasks.yaml */
function fixtureTasks() {
  const items = [
    {
      _ulid: "01KG0RR6CA45ZT43W2T6HJMVA1",
      slugs: ["test-task-ready"],
      title: "Ready task",
      type: "task",
      status: "pending",
      priority: 2,
      tags: ["test"],
      depends_on: [],
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      _ulid: "01KG0RR7CC9N4YGP991WD7XS8S",
      slugs: ["test-task-blocked"],
      title: "Test blocked task",
      type: "task",
      status: "pending",
      priority: 1,
      tags: ["e2e", "test"],
      depends_on: ["@test-task-ready"],
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      _ulid: "01KG0RR8CB8N4YGP991WD7XS9R",
      slugs: ["test-task-in-progress"],
      title: "In progress task",
      type: "task",
      status: "in_progress",
      priority: 3,
      tags: ["test"],
      depends_on: [],
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      _ulid: "01KG0RRDCC9N4YGP991WD7XSPR",
      slugs: ["test-task-pending-review"],
      title: "Pending review task",
      type: "task",
      status: "pending_review",
      priority: 2,
      tags: ["test"],
      depends_on: [],
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      _ulid: "01KG0RRFCC9N4YGP991WD7XSCP",
      slugs: ["test-task-completed"],
      title: "Completed task",
      type: "task",
      status: "completed",
      priority: 3,
      tags: ["test"],
      depends_on: [],
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  return envelope(items, { total: 5, limit: 50, offset: 0 });
}

/**
 * Task status summary matching fixtureTasks(): 2 pending (1 ready, 1 blocked
 * by an incomplete dependency), 1 in_progress, 1 pending_review, 1 completed.
 * Mirrors GET /api/aggregation/tasks/summary semantics.
 */
function fixtureTaskSummary() {
  return envelope({
    counts: { pending: 2, in_progress: 1, pending_review: 1, completed: 1 },
    ready: 1,
    blocked_by_dependencies: 1,
    total: 5,
  });
}

/** Inbox data: 3 items matching fixture */
function fixtureInbox() {
  return envelope([], { total: 3, limit: 0, offset: 0 });
}

/** Observations: 2 unresolved matching fixture */
function fixtureObservations() {
  return envelope([], { total: 2, limit: 50, offset: 0 });
}

/** Validation: some warnings to verify count aggregation */
function fixtureValidation() {
  return envelope({
    valid: false,
    schemaErrors: [],
    refErrors: [{ source: "test", ref: "@missing", message: "Missing ref" }],
    refWarnings: [{ source: "test", ref: "@warn", message: "Warning" }],
    orphans: [],
    completenessWarnings: [],
    traitCycles: [],
  });
}

/** Agent status: no dispatch running */
function fixtureAgentStatus() {
  return {
    dispatch_enabled: false,
    active_invocations: [],
    queued_tasks: [],
    agents: [],
  };
}

/**
 * Set up page.route() interceptors for all dashboard API calls.
 * Intercepts browser-side fetches to localhost:3456 and fulfills with fixture data.
 */
async function interceptDashboardAPIs(page: import("@playwright/test").Page) {
  // AC: @ui-dashboard-overview ac-counts-from-summary — dashboard counts come
  // from the pre-computed summary endpoint
  await page.route("**/api/aggregation/tasks/summary", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureTaskSummary()),
    });
  });

  // Filtered task list queries (e.g. the sidebar's pending_review count)
  // still go through /api/tasks.
  await page.route(/\/api\/tasks(\?|$)/, (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureTasks()),
    });
  });

  await page.route("**/api/inbox?*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureInbox()),
    });
  });

  await page.route("**/api/meta/observations?*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureObservations()),
    });
  });

  await page.route("**/api/validate", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureValidation()),
    });
  });

  await page.route("**/api/agent/status", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureAgentStatus()),
    });
  });
}

test.describe("Dashboard Overview", () => {
  // AC: @ui-dashboard-overview ac-1 — UI aggregation of active work
  test.describe("Active Work Section", () => {
    test("renders active work section", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.goto("/");
      const section = page.getByTestId("active-work-section");
      await expect(section).toBeVisible();
    });

    test("shows no-active-work empty state when no agents running", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.goto("/");
      const noWork = page.getByTestId("no-active-work");
      await expect(noWork).toBeVisible();
      await expect(noWork).toContainText("No agents currently running");
    });

    test("shows active fleet when agents are running", async ({ page }) => {
      // Override agent status to show active invocations
      await page.route("**/api/aggregation/tasks/summary", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(fixtureTaskSummary()),
        });
      });
      await page.route(/\/api\/tasks(\?|$)/, (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(fixtureTasks()),
        });
      });
      await page.route("**/api/inbox?*", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(fixtureInbox()),
        });
      });
      await page.route("**/api/meta/observations?*", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(fixtureObservations()),
        });
      });
      await page.route("**/api/validate", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(fixtureValidation()),
        });
      });
      await page.route("**/api/agent/status", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            dispatch_enabled: true,
            active_invocations: [
              {
                session_id: "01JTEST0000000000000000001",
                agent_id: "task-worker",
                task_ref: "@test-task-in-progress",
                elapsed_ms: 45000,
                status: "running",
              },
            ],
            queued_tasks: [],
            agents: [],
          }),
        });
      });

      await page.goto("/");
      const fleet = page.getByTestId("active-fleet-row");
      await expect(fleet).toBeVisible();
      const cards = page.getByTestId("fleet-card");
      await expect(cards).toHaveCount(1);
      await expect(cards.first()).toContainText("task-worker");
    });
  });

  // AC: @ui-dashboard-overview ac-1 — Status summary with correct counts
  test.describe("Status Summary", () => {
    test("displays status summary section with heading", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.goto("/");
      const section = page.getByTestId("status-summary-section");
      await expect(section).toBeVisible();
      await expect(section.locator("h2")).toContainText("Status Summary");
    });

    test("displays all 7 status count cards", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.goto("/");

      const countsContainer = page.getByTestId("dashboard-counts");
      await expect(countsContainer).toBeVisible();

      await expect(page.getByTestId("task-count-ready")).toBeVisible();
      await expect(page.getByTestId("task-count-in_progress")).toBeVisible();
      await expect(page.getByTestId("task-count-needs_work")).toBeVisible();
      await expect(page.getByTestId("task-count-pending_review")).toBeVisible();
      await expect(page.getByTestId("task-count-blocked")).toBeVisible();
      await expect(page.getByTestId("task-count-completed")).toBeVisible();
      await expect(page.getByTestId("task-count-cancelled")).toBeVisible();
    });

    test("count cards have status labels as text", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.goto("/");

      await expect(page.getByTestId("task-count-ready")).toContainText("Ready");
      await expect(page.getByTestId("task-count-in_progress")).toContainText("In Progress");
      await expect(page.getByTestId("task-count-needs_work")).toContainText("Needs Work");
      await expect(page.getByTestId("task-count-pending_review")).toContainText("Review");
      await expect(page.getByTestId("task-count-blocked")).toContainText("Blocked");
      await expect(page.getByTestId("task-count-completed")).toContainText("Completed");
      await expect(page.getByTestId("task-count-cancelled")).toContainText("Cancelled");
    });

    // AC: @ui-dashboard-overview ac-1 — Validates UI renders correct aggregated counts
    // AC: @ui-dashboard-overview ac-counts-from-summary
    // AC: @web-dashboard ac-1
    // Summary fixture: 2 pending (1 ready, 1 dep-blocked), 1 in_progress, 1 pending_review, 1 completed
    // Expected: ready=1 (summary.ready), in_progress=1, pending_review=1, blocked=0, completed=1
    test("renders correct aggregated counts from the summary endpoint", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.goto("/");
      await expect(page.getByTestId("status-summary-section")).toBeVisible();

      // Verify each count card renders the correct number
      await expect(page.getByTestId("task-count-ready")).toContainText("1");
      await expect(page.getByTestId("task-count-in_progress")).toContainText("1");
      await expect(page.getByTestId("task-count-needs_work")).toContainText("0");
      await expect(page.getByTestId("task-count-pending_review")).toContainText("1");
      // Blocked card counts only status=blocked tasks (summary.counts.blocked),
      // not summary.blocked_by_dependencies
      await expect(page.getByTestId("task-count-blocked")).toContainText("0");
      await expect(page.getByTestId("task-count-completed")).toContainText("1");
      await expect(page.getByTestId("task-count-cancelled")).toContainText("0");
    });

    // AC: @ui-dashboard-overview ac-counts-from-summary — counts come from the
    // pre-computed summary endpoint; no unfiltered full task list request is issued
    test("renders counts without fetching the full task list", async ({ page }) => {
      await interceptDashboardAPIs(page);

      const fullListRequests: string[] = [];
      let summaryRequested = false;
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/api/aggregation/tasks/summary")) {
          summaryRequested = true;
        }
        // Unfiltered list fetch = /api/tasks without a status filter (the
        // sidebar legitimately issues a filtered limit=0 count query)
        if (url.pathname.endsWith("/api/tasks") && !url.searchParams.has("status")) {
          fullListRequests.push(request.url());
        }
      });

      await page.goto("/");
      await expect(page.getByTestId("status-summary-section")).toBeVisible();
      await expect(page.getByTestId("task-count-ready")).toContainText("1");

      expect(summaryRequested).toBe(true);
      expect(fullListRequests).toEqual([]);
    });

    // AC: @web-dashboard ac-3
    test("clicking ready count navigates to pending tasks", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.goto("/");

      const readyCard = page.getByTestId("task-count-ready");
      await expect(readyCard).toBeVisible();
      await readyCard.click();
      await page.waitForURL(/\/tasks\?status=pending/);
      expect(page.url()).toContain("status=pending");
    });

    test("clicking in_progress count navigates to tasks", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.goto("/");

      const inProgressCard = page.getByTestId("task-count-in_progress");
      await expect(inProgressCard).toBeVisible();
      await inProgressCard.click();
      await page.waitForURL(/\/tasks\?status=in_progress/);
      expect(page.url()).toContain("status=in_progress");
    });

    test("clicking pending_review count navigates to tasks", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.goto("/");

      const pendingReviewCard = page.getByTestId("task-count-pending_review");
      await expect(pendingReviewCard).toBeVisible();
      await pendingReviewCard.click();
      await page.waitForURL(/\/tasks\?status=pending_review/);
      expect(page.url()).toContain("status=pending_review");
    });

    test("clicking blocked count navigates to tasks", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.goto("/");

      const blockedCard = page.getByTestId("task-count-blocked");
      await expect(blockedCard).toBeVisible();
      await blockedCard.click();
      await page.waitForURL(/\/tasks\?status=blocked/);
      expect(page.url()).toContain("status=blocked");
    });

    test("clicking completed count navigates to tasks", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.goto("/");

      const completedCard = page.getByTestId("task-count-completed");
      await expect(completedCard).toBeVisible();
      await completedCard.click();
      await page.waitForURL(/\/tasks\?status=completed/);
      expect(page.url()).toContain("status=completed");
    });
  });

  // AC: @ui-dashboard-overview ac-1 — Needs-attention aggregation
  test.describe("Needs Attention Section", () => {
    test("renders needs-attention section with heading", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.goto("/");

      const section = page.getByTestId("needs-attention-section");
      await expect(section).toBeVisible();
      await expect(section.locator("h2")).toContainText("Needs Attention");
    });

    // AC: @ui-dashboard-overview ac-1 — Aggregates inbox, observations, validation, blocked
    test("shows correct needs-attention counts from aggregated data", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.goto("/");

      // Fixture: 3 inbox items, 2 observations, 2 validation issues (1 refError + 1 refWarning), 0 blocked tasks
      // Total attention = 3 + 2 + 2 + 0 = 7
      const section = page.getByTestId("needs-attention-section");
      await expect(section).toBeVisible();

      // Inbox attention card
      const inboxCard = page.getByTestId("attention-inbox");
      await expect(inboxCard).toBeVisible();
      await expect(inboxCard).toContainText("3");
      await expect(inboxCard).toContainText("Untriaged inbox");

      // Observations attention card
      const obsCard = page.getByTestId("attention-observations");
      await expect(obsCard).toBeVisible();
      await expect(obsCard).toContainText("2");
      await expect(obsCard).toContainText("Unresolved observations");

      // Validation attention card
      const valCard = page.getByTestId("attention-validation");
      await expect(valCard).toBeVisible();
      await expect(valCard).toContainText("2");
      await expect(valCard).toContainText("Validation warnings");

      // Blocked attention card should NOT be visible (0 status=blocked tasks)
      await expect(page.getByTestId("attention-blocked")).not.toBeVisible();
    });

    test("shows no-attention empty state when all counts are zero", async ({ page }) => {
      // Override all APIs to return zero counts
      await page.route("**/api/aggregation/tasks/summary", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope({ counts: {}, ready: 0, blocked_by_dependencies: 0, total: 0 }),
          ),
        });
      });
      await page.route(/\/api\/tasks(\?|$)/, (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(envelope([], { total: 0, limit: 50, offset: 0 })),
        });
      });
      await page.route("**/api/inbox?*", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(envelope([], { total: 0, limit: 0, offset: 0 })),
        });
      });
      await page.route("**/api/meta/observations?*", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(envelope([], { total: 0, limit: 50, offset: 0 })),
        });
      });
      await page.route("**/api/validate", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope({
              valid: true,
              schemaErrors: [],
              refErrors: [],
              refWarnings: [],
              orphans: [],
              completenessWarnings: [],
              traitCycles: [],
            }),
          ),
        });
      });
      await page.route("**/api/agent/status", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(fixtureAgentStatus()),
        });
      });

      await page.goto("/");
      await expect(page.getByTestId("no-attention-needed")).toBeVisible();
    });

    test("attention cards link to correct pages", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.goto("/");

      // Wait for attention section to render
      const inboxCard = page.getByTestId("attention-inbox");
      await expect(inboxCard).toBeVisible();

      // Inbox card links to /inbox
      await expect(inboxCard).toHaveAttribute("href", /\/inbox/);

      // Observations card links to /observations
      await expect(page.getByTestId("attention-observations")).toHaveAttribute(
        "href",
        /\/observations/,
      );

      // Validation card links to /validate
      await expect(page.getByTestId("attention-validation")).toHaveAttribute("href", /\/validate/);
    });
  });

  test.describe("Loading and Error States", () => {
    test("renders dashboard container", async ({ page }) => {
      await page.goto("/");
      const dashboard = page.getByTestId("dashboard");
      await expect(dashboard).toBeVisible();
    });

    test("shows either skeleton or loaded content", async ({ page }) => {
      await page.goto("/");
      await expect(
        page.getByTestId("status-summary-section").or(page.getByTestId("dashboard-skeleton")),
      ).toBeVisible();
    });
  });

  test.describe("Responsive Layout", () => {
    test("dashboard adapts to mobile viewport", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto("/");

      const dashboard = page.getByTestId("dashboard");
      await expect(dashboard).toBeVisible();
      await expect(page.getByTestId("task-count-ready")).toBeVisible();
    });

    test("dashboard shows full grid on desktop", async ({ page }) => {
      await interceptDashboardAPIs(page);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto("/");

      const counts = page.getByTestId("dashboard-counts");
      await expect(counts).toBeVisible();
      await expect(page.getByTestId("task-count-ready")).toBeVisible();
      await expect(page.getByTestId("task-count-completed")).toBeVisible();
    });
  });

  // AC: @ui-dashboard-overview ac-1 — API contract verification
  // These verify the daemon API returns expected fixture data, independent of UI rendering.
  test.describe("API Contract Verification", () => {
    /** Poll an endpoint until its cache_status is "ready", then return the envelope. */
    async function fetchWhenReady(
      baseUrl: string,
      path: string,
      timeoutMs = 5000,
    ): Promise<{ data: unknown; meta: { cache_status: string; total?: number } }> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const response = await fetch(`${baseUrl}${path}`);
        expect(response.ok).toBe(true);
        const envelope = await response.json();
        if (envelope.meta?.cache_status === "ready") return envelope;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`Cache not ready for ${path} after ${timeoutMs}ms`);
    }

    test("daemon returns task counts matching fixture data", async ({ daemon }) => {
      const expectedCounts = getFixtureTaskCounts();
      const envelope = await fetchWhenReady(daemon.baseUrl, "/api/tasks");

      const tasks = envelope.data as Array<{ status: string }>;
      expect(tasks).toBeDefined();
      expect(tasks).toHaveLength(expectedCounts.total);

      const statusCounts: Record<string, number> = {};
      for (const task of tasks) {
        statusCounts[task.status] = (statusCounts[task.status] || 0) + 1;
      }

      // Verify each status count matches the fixture-derived expectation
      for (const [status, expectedCount] of Object.entries(expectedCounts.byStatus)) {
        expect(
          statusCounts[status] ?? 0,
          `Expected ${expectedCount} tasks with status "${status}"`,
        ).toBe(expectedCount);
      }
      // Verify no unexpected statuses appeared in the API response
      for (const [status, count] of Object.entries(statusCounts)) {
        expect(
          expectedCounts.byStatus[status] ?? 0,
          `Unexpected status "${status}" in API response with count ${count}`,
        ).toBe(count);
      }
    });

    // AC: @ui-dashboard-overview ac-counts-from-summary — the pre-computed
    // summary endpoint the dashboard consumes matches fixture task data
    test("daemon returns task status summary matching fixture data", async ({ daemon }) => {
      const expectedCounts = getFixtureTaskCounts();
      const summaryEnvelope = await fetchWhenReady(
        daemon.baseUrl,
        "/api/aggregation/tasks/summary",
      );

      const summary = summaryEnvelope.data as {
        counts: Record<string, number>;
        ready: number;
        blocked_by_dependencies: number;
        total: number;
      };

      expect(summary.total).toBe(expectedCounts.total);
      for (const [status, expectedCount] of Object.entries(expectedCounts.byStatus)) {
        expect(
          summary.counts[status] ?? 0,
          `Expected ${expectedCount} tasks with status "${status}"`,
        ).toBe(expectedCount);
      }
      // ready and blocked_by_dependencies partition the pending + needs_work tasks
      const pendingPool =
        (expectedCounts.byStatus["pending"] ?? 0) + (expectedCounts.byStatus["needs_work"] ?? 0);
      expect(summary.ready + summary.blocked_by_dependencies).toBe(pendingPool);
    });

    test("daemon returns inbox items", async ({ daemon }) => {
      const envelope = await fetchWhenReady(daemon.baseUrl, "/api/inbox");
      expect(envelope.meta.total).toBe(3);
    });

    test("daemon returns observations", async ({ daemon }) => {
      const envelope = await fetchWhenReady(
        daemon.baseUrl,
        "/api/meta/observations?resolved=false",
      );
      expect(envelope.meta.total).toBe(2);
    });

    test("daemon returns validation results", async ({ daemon }) => {
      const envelope = await fetchWhenReady(daemon.baseUrl, "/api/validate");
      const data = envelope.data as Record<string, unknown>;
      expect(data).toHaveProperty("valid");
      expect(data).toHaveProperty("schemaErrors");
      expect(data).toHaveProperty("refErrors");
      expect(data).toHaveProperty("refWarnings");
    });
  });
});
