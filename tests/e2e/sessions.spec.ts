/**
 * E2E Tests for Session History View
 *
 * Tests verify the /sessions page renders session list with required metadata
 * and navigates to session detail on click.
 *
 * Covered ACs:
 * - @ui-session-history ac-1: Session list shows ID, agent type, task ref, status, duration, age
 * - @ui-session-history ac-2: Click navigates to /sessions/:id
 * - @session-list-infinite-scroll ac-initial-load: First page loads with skeleton, shows count
 * - @session-list-infinite-scroll ac-scroll-load: IntersectionObserver triggers next page
 * - @session-list-infinite-scroll ac-scroll-end: End of list indicator when all loaded
 * - @session-list-infinite-scroll ac-filter-reset: Filter change resets to page 1
 * - @session-list-infinite-scroll ac-live-update: WebSocket updates total and shows indicator
 *
 * Trait ACs:
 * - @ui-url-panel-state ac-4: Filter URL mutations use goto() and stay reactive.
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { test, expect } from "./fixtures/test-base";

/** Wrap data in the unified API response envelope. */
function envelope<T>(data: T, meta?: Record<string, unknown>) {
  return { data, meta: { cache_status: "ready" as const, ...meta } };
}

/** Generate a session with a specific index for stable ordering. */
function makeSession(
  index: number,
  overrides: Partial<{
    status: string;
    agent_type: string;
    agent_id: string;
    trigger: string;
    task_id: string;
    started_at: string;
    ended_at: string;
    duration_ms: number;
    event_count: number;
    iteration_count: number;
    tasks_completed: number;
  }> = {},
) {
  const padded = String(index).padStart(3, "0");
  return {
    id: `01JTEST00000000000000000${padded}`,
    status: overrides.status ?? "completed",
    agent_type: overrides.agent_type ?? "task-worker",
    agent_id: overrides.agent_id ?? "worker",
    session_type: "invocation" as const,
    trigger: overrides.trigger ?? "task.ready",
    task_id: overrides.task_id,
    started_at:
      overrides.started_at ??
      `2026-03-${String(Math.max(1, 28 - index)).padStart(2, "0")}T10:00:00.000Z`,
    ended_at:
      overrides.ended_at ??
      `2026-03-${String(Math.max(1, 28 - index)).padStart(2, "0")}T11:00:00.000Z`,
    duration_ms: overrides.duration_ms ?? 3600000,
    event_count: overrides.event_count ?? 10,
    iteration_count: overrides.iteration_count ?? 1,
    tasks_completed: overrides.tasks_completed ?? 0,
  };
}

/** Mock session data for API interception — legacy 3-session set for existing tests. */
function mockSessions() {
  return {
    items: [
      {
        id: "01JTEST0000000000000000001",
        status: "completed",
        agent_type: "task-worker",
        agent_id: "worker",
        session_type: "invocation",
        trigger: "task.ready",
        task_id: "01JTASK0000000000000000001",
        started_at: "2026-03-04T10:00:00.000Z",
        ended_at: "2026-03-04T11:30:00.000Z",
        duration_ms: 5400000,
        event_count: 42,
        iteration_count: 3,
        tasks_completed: 1,
      },
      {
        id: "01JTEST0000000000000000002",
        status: "active",
        agent_type: "pr-reviewer",
        agent_id: "pr-reviewer",
        session_type: "invocation",
        trigger: "task.pending_review",
        task_id: "01JTASK0000000000000000002",
        started_at: "2026-03-05T08:00:00.000Z",
        duration_ms: 60000,
        event_count: 10,
        iteration_count: 1,
        tasks_completed: 0,
      },
      {
        id: "01JTEST0000000000000000003",
        status: "failed",
        agent_type: "task-worker",
        agent_id: "worker",
        session_type: "loop",
        trigger: "manual",
        started_at: "2026-03-03T14:00:00.000Z",
        ended_at: "2026-03-03T14:05:00.000Z",
        duration_ms: 300000,
        event_count: 5,
        iteration_count: 0,
        tasks_completed: 0,
      },
    ],
    total: 3,
    offset: 0,
    limit: 25,
  };
}

/** Route handler that serves mock sessions with pagination and filtering support. */
function mockSessionsRoute(sessions: ReturnType<typeof mockSessions>) {
  return (route: any) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? String(sessions.total));
    const triggerParam = url.searchParams.get("trigger");
    const statusParam = url.searchParams.getAll("status");
    const agentTypeParam = url.searchParams.get("agent_type");
    const agentIdParam = url.searchParams.get("agent_id");
    const sinceParam = url.searchParams.get("since");

    let filtered = sessions.items;
    if (triggerParam === "manual") {
      filtered = filtered.filter((s: any) => s.trigger === "manual");
    } else if (triggerParam === "dispatched") {
      filtered = filtered.filter((s: any) => s.trigger?.startsWith("task."));
    }
    if (statusParam.length > 0) {
      filtered = filtered.filter((s: any) => statusParam.includes(s.status));
    }
    if (agentTypeParam) {
      filtered = filtered.filter((s: any) => s.agent_type === agentTypeParam);
    }
    if (agentIdParam) {
      filtered = filtered.filter((s: any) => s.agent_id === agentIdParam);
    }
    if (sinceParam) {
      const sinceMs = new Date(sinceParam).getTime();
      filtered = filtered.filter((s: any) => new Date(s.started_at).getTime() >= sinceMs);
    }

    const total = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        envelope(
          { items: paginated, unfiltered_total: sessions.items.length },
          { total, offset, limit },
        ),
      ),
    });
  };
}

function mockSearchRoute(options?: { delayMs?: number; onRequest?: (url: URL) => void }) {
  return async (route: any) => {
    const url = new URL(route.request().url());
    options?.onRequest?.(url);
    const query = url.searchParams.get("q") ?? "";
    const statusParam = url.searchParams.getAll("status");
    const agentIdParam = url.searchParams.get("agent_id");
    let items =
      query.toLowerCase() === "error handling"
        ? [
            {
              session_id: "01JTEST0000000000000000001",
              agent_type: "task-worker",
              started_at: "2026-03-04T10:00:00.000Z",
              status: "completed",
              agent_id: "worker",
              matches: [
                {
                  session_id: "01JTEST0000000000000000001",
                  event_seq: 4,
                  timestamp: Date.parse("2026-03-04T10:15:00.000Z"),
                  event_type: "session.update",
                  content_excerpt: "Error handling added to the worker session",
                },
              ],
            },
            {
              session_id: "01JTEST0000000000000000003",
              agent_type: "task-worker",
              started_at: "2026-03-03T14:00:00.000Z",
              status: "failed",
              agent_id: "worker",
              matches: [
                {
                  session_id: "01JTEST0000000000000000003",
                  event_seq: 2,
                  timestamp: Date.parse("2026-03-03T14:02:00.000Z"),
                  event_type: "session.error",
                  content_excerpt: "Error handling failed after a timeout retry",
                },
              ],
            },
          ]
        : [];

    if (statusParam.length > 0) {
      items = items.filter((item: any) => statusParam.includes(item.status));
    }
    if (agentIdParam) {
      items = items.filter((item: any) => item.agent_id === agentIdParam);
    }

    if (options?.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }

    const totalMatches = items.reduce((sum: number, item: any) => sum + item.matches.length, 0);

    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          items,
          total_sessions: items.length,
          total_matches: totalMatches,
          query,
        },
        meta: { cache_status: "ready" },
      }),
    });
  };
}

async function writeSessionFixture(
  projectRoot: string,
  options: {
    id: string;
    status: "active" | "completed" | "abandoned" | "timed_out" | "failed";
    startedAt: string;
    endedAt?: string;
    agentType?: string;
    agentId?: string;
    trigger?: string;
    taskId?: string;
  },
) {
  const sessionDir = join(projectRoot, ".kspec-sessions", options.id);
  await mkdir(sessionDir, { recursive: true });
  const endedAtLine = options.endedAt ? `ended_at: "${options.endedAt}"\n` : "";
  const taskIdLine = options.taskId ? `task_id: "${options.taskId}"\n` : "";

  await writeFile(
    join(sessionDir, "session.yaml"),
    `id: "${options.id}"
${taskIdLine}agent_type: "${options.agentType ?? "task-worker"}"
agent_id: "${options.agentId ?? "worker"}"
trigger: "${options.trigger ?? "manual"}"
status: "${options.status}"
started_at: "${options.startedAt}"
${endedAtLine}`,
    "utf-8",
  );
  await writeFile(join(sessionDir, "events.jsonl"), "", "utf-8");
}

test.describe("Session History View", () => {
  test.describe("Session List (AC-1)", () => {
    // AC: @ui-session-history ac-1
    test("shows session list with required metadata fields", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");

      const list = page.getByTestId("sessions-list");
      await expect(list).toBeVisible();

      const rows = page.getByTestId("session-row");
      await expect(rows).toHaveCount(3);
    });

    // AC: @ui-session-history ac-1 — Status badge visible
    // AC: @ui-view-header ac-2 — session state on the list is the shared status token
    test("shows status badge for each session", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      const rows = page.getByTestId("session-row");
      // The list renders the shared StatusBadge (capitalized label + token attributes),
      // not a bespoke lowercase status helper — same token the detail header uses.
      const completedBadge = rows.nth(0).getByTestId("session-status-badge");
      await expect(completedBadge).toContainText("Completed");
      await expect(completedBadge).toHaveAttribute("data-status-domain", "session");
      await expect(completedBadge).toHaveAttribute("data-status-state", "completed");
      await expect(rows.nth(1).getByTestId("session-status-badge")).toContainText("Active");
      await expect(rows.nth(2).getByTestId("session-status-badge")).toContainText("Failed");
    });

    // AC: @ui-session-history ac-1 — Session ID displayed
    test("shows session ID for each row", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      const ids = page.getByTestId("session-id");
      await expect(ids).toHaveCount(3);
      await expect(ids.nth(0)).toContainText("01JTEST0");
    });

    // AC: @ui-session-history ac-1 — Agent type displayed
    test("shows agent type for each row", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      const rows = page.getByTestId("session-row");
      await expect(rows.nth(0)).toContainText("task-worker");
      await expect(rows.nth(1)).toContainText("pr-reviewer");
    });

    // AC: @ui-session-history ac-1 — Task ref displayed when present
    test("shows task ref when session has a task_id", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      const taskRefs = page.getByTestId("session-task-ref");
      await expect(taskRefs).toHaveCount(2);
      await expect(taskRefs.nth(0)).toContainText("@01JTASK0");
    });

    // AC: @ui-session-history ac-1 — Duration displayed
    test("shows duration for each row", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      const durations = page.getByTestId("session-duration");
      await expect(durations).toHaveCount(3);
      await expect(durations.nth(0)).toContainText("1h 30m");
    });

    // AC: @ui-session-history ac-1 — Age displayed
    test("shows age for each row", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      const ages = page.getByTestId("session-age");
      await expect(ages).toHaveCount(3);
      for (let i = 0; i < 3; i++) {
        await expect(ages.nth(i)).not.toBeEmpty();
      }
    });

    // AC: @ui-session-history ac-1 — Sorted by most recent first
    test("sessions are sorted by most recent first", async ({ page, daemon: _daemon }) => {
      const sorted = mockSessions();
      sorted.items = [sorted.items[1], sorted.items[0], sorted.items[2]];

      await page.route("**/api/sessions*", mockSessionsRoute(sorted));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      const rows = page.getByTestId("session-row");
      await expect(rows.nth(0)).toHaveAttribute("data-session-id", "01JTEST0000000000000000002");
      await expect(rows.nth(1)).toHaveAttribute("data-session-id", "01JTEST0000000000000000001");
      await expect(rows.nth(2)).toHaveAttribute("data-session-id", "01JTEST0000000000000000003");
    });
  });

  test.describe("Session Navigation (AC-2)", () => {
    // AC: @ui-session-history ac-2
    // AC: @ui-view-header ac-6 — session detail presents the standard view header
    test("clicking a session navigates to /sessions/:id and shows stream view", async ({
      page,
      daemon: _daemon,
    }) => {
      const sessionDetail = mockSessions().items[0];

      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));

      await page.route("**/api/sessions/01JTEST0000000000000000001", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(envelope(sessionDetail)),
        });
      });

      await page.route("**/api/sessions/01JTEST0000000000000000001/events", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: { events: [] }, meta: { total: 0, cache_status: "ready" } }),
        });
      });

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      const firstRow = page.getByTestId("session-row").first();
      await firstRow.getByTestId("session-id").click();

      await expect(page).toHaveURL(/\/sessions\/01JTEST0000000000000000001/);
      await expect(page.getByTestId("session-stream")).toBeVisible({ timeout: 5000 });

      // AC: @ui-view-header ac-6 — the detail header is the standard ViewHeader,
      // with a token-driven status badge and server-resolved child counts.
      await expect(page.getByTestId("view-header")).toBeVisible();
      await expect(page.getByTestId("session-status-badge")).toBeVisible();
      await expect(page.getByTestId("view-header-count-events")).toBeVisible();

      // AC: @ui-view-header ac-5 — back navigation is a header action inside the
      // actions zone, never in the empty leading chrome reservation.
      const backLink = page.getByTestId("back-to-sessions");
      await expect(backLink).toBeVisible();
      await expect(
        page.getByTestId("view-header-actions").getByTestId("back-to-sessions"),
      ).toBeVisible();
      await expect(page.getByTestId("view-header-leading")).toBeEmpty();
    });

    // AC: @ui-session-history ac-2
    test("session row links point to correct detail URL", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      const firstRow = page.getByTestId("session-row").first();
      const href = await firstRow.getAttribute("href");
      expect(href).toContain("/sessions/01JTEST0000000000000000001");
    });
  });

  test.describe("Empty State", () => {
    test("shows empty state when no sessions exist", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope({ items: [], unfiltered_total: 0 }, { total: 0, offset: 0, limit: 25 }),
          ),
        });
      });

      await page.goto("/sessions");

      const emptyState = page.getByTestId("sessions-empty");
      await expect(emptyState).toBeVisible();
      await expect(emptyState).toContainText("No sessions yet");
    });
  });

  test.describe("Loading State", () => {
    test("shows loading skeleton while fetching", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", async (route) => {
        await new Promise((r) => setTimeout(r, 500));
        const sessions = mockSessions();
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope(
              { items: sessions.items, unfiltered_total: sessions.total },
              { total: sessions.total, offset: sessions.offset, limit: sessions.limit },
            ),
          ),
        });
      });

      await page.goto("/sessions");

      const skeleton = page.getByTestId("sessions-loading");
      await expect(skeleton).toBeVisible();

      await expect(page.getByTestId("sessions-list")).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("Error State", () => {
    test("shows error message on API failure", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", (route) => {
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal_error", message: "Daemon unavailable" }),
        });
      });

      await page.goto("/sessions");

      const errorMessage = page.getByTestId("sessions-error");
      await expect(errorMessage).toBeVisible();
    });
  });

  test.describe("Session Type Indicators", () => {
    // AC: @ui-session-history ac-1 — Trigger labels distinguish dispatched vs manual
    test("shows trigger label for each session", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      const labels = page.getByTestId("session-trigger-label");
      await expect(labels).toHaveCount(3);
      await expect(labels.nth(0)).toContainText("Dispatched: Task Ready");
      await expect(labels.nth(1)).toContainText("Dispatched: PR Review");
      await expect(labels.nth(2)).toContainText("Manual Run");
    });

    test("shows trigger icon for each session", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      const icons = page.getByTestId("session-trigger-icon");
      await expect(icons).toHaveCount(3);
    });
  });

  test.describe("Trigger Filter", () => {
    // AC: @session-filter-controls ac-trigger-filter
    test("filter controls are visible when sessions exist", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      const filterControls = page.getByTestId("session-filter-controls");
      await expect(filterControls).toBeVisible();
      await expect(page.getByTestId("session-filter-trigger")).toBeVisible();
    });

    // AC: @session-filter-controls ac-trigger-filter — Filter change triggers new API call
    test("dispatched filter shows only dispatched sessions", async ({ page, daemon: _daemon }) => {
      const apiCalls: string[] = [];

      await page.route("**/api/sessions*", (route) => {
        apiCalls.push(route.request().url());
        mockSessionsRoute(mockSessions())(route);
      });

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      // Use the select dropdown to choose "Dispatched"
      await page.getByTestId("session-filter-trigger").click();
      await page.getByRole("option", { name: "Dispatched" }).click();

      // Wait for the filtered result
      await expect(page.getByTestId("session-row")).toHaveCount(2);

      // Verify URL updated with trigger param
      await expect(page).toHaveURL(/trigger=dispatched/);

      // Verify a new API request was made with trigger param
      const dispatchedCalls = apiCalls.filter((url) => url.includes("trigger=dispatched"));
      expect(dispatchedCalls.length).toBeGreaterThan(0);
    });

    // AC: @session-filter-controls ac-trigger-filter
    test("manual filter shows only manual sessions", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      await page.getByTestId("session-filter-trigger").click();
      await page.getByRole("option", { name: "Manual" }).click();

      const rows = page.getByTestId("session-row");
      await expect(rows).toHaveCount(1);
      await expect(rows.nth(0)).toHaveAttribute("data-session-id", "01JTEST0000000000000000003");

      // AC: @ui-url-panel-state ac-4 — URL updated via goto()
      await expect(page).toHaveURL(/trigger=manual/);
    });
  });

  test.describe("Session Search", () => {
    // AC: @session-text-search ac-ui-search
    test("submitting search persists q in the URL and shows grouped matches", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.route("**/api/sessions/search*", mockSearchRoute());
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      await page.getByTestId("session-search-input").fill("error handling");
      await page.getByTestId("session-search-submit").click();

      await expect(page).toHaveURL(/q=error(\+|%20)handling/);
      await expect(page.getByTestId("session-search-results")).toBeVisible();
      await expect(page.getByTestId("session-search-session")).toHaveCount(2);
      await expect(page.getByTestId("session-search-match").first()).toContainText(
        "Error handling added",
      );
    });

    // AC: @session-text-search ac-empty-query
    test("submitting an empty search clears q and keeps the unfiltered session list", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.route("**/api/sessions/search*", mockSearchRoute());
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions?q=error+handling");
      await expect(page.getByTestId("session-search-results")).toBeVisible();

      await page.getByTestId("session-search-input").fill("   ");
      await page.getByTestId("session-search-submit").click();

      await expect(page).not.toHaveURL(/[?&]q=/);
      await expect(page.getByTestId("sessions-list")).toBeVisible();
      await expect(page.getByTestId("session-row")).toHaveCount(3);
    });

    // AC: @session-text-search ac-api-search
    test("search results group matching excerpts by session and preserve the search query in the URL", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.route("**/api/sessions/search*", mockSearchRoute());
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      await page.getByTestId("session-search-input").fill("error handling");
      await page.getByTestId("session-search-submit").click();

      await expect(page).toHaveURL(/q=error(\+|%20)handling/);
      await expect(page.getByTestId("session-search-results")).toBeVisible();
      await expect(page.getByTestId("session-search-count")).toContainText(
        "2 matches across 2 sessions",
      );
      await expect(page.getByTestId("session-search-session")).toHaveCount(2);
      await expect(page.getByTestId("session-search-match").nth(0)).toContainText(
        "Error handling added to the worker session",
      );
      await expect(page.getByTestId("session-search-match").nth(1)).toContainText(
        "Error handling failed after a timeout retry",
      );
    });

    // AC: @session-text-search ac-api-search
    test("search with no matching excerpts shows the filtered empty state", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.route("**/api/sessions/search*", mockSearchRoute());
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      await page.getByTestId("session-search-input").fill("missing phrase");
      await page.getByTestId("session-search-submit").click();

      await expect(page).toHaveURL(/q=missing(\+|%20)phrase/);
      await expect(page.getByTestId("sessions-empty")).toBeVisible();
      await expect(page.getByTestId("sessions-empty")).toContainText("No matching sessions");
      await expect(page.getByTestId("sessions-empty")).toContainText(
        "Try adjusting your search or filters.",
      );
    });

    // AC: @session-text-search ac-performance
    test("search requests include active metadata filters and the UI shows only narrowed results", async ({
      page,
      daemon: _daemon,
    }) => {
      const searchRequests: string[] = [];

      await page.route(
        "**/api/sessions/search*",
        mockSearchRoute({
          onRequest: (url) => searchRequests.push(url.search),
        }),
      );
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      await page.getByTestId("session-search-input").fill("error handling");
      await page.getByTestId("session-search-submit").click();
      await expect(page.getByTestId("session-search-session")).toHaveCount(2);

      await page.getByTestId("session-filter-status-completed").click();

      await expect(page).toHaveURL(/q=error(\+|%20)handling/);
      await expect(page).toHaveURL(/status=completed/);
      await expect(page.getByTestId("session-search-count")).toContainText(
        "1 match across 1 session",
      );
      await expect(page.getByTestId("session-search-session")).toHaveCount(1);
      await expect(page.getByTestId("session-search-session").first()).toHaveAttribute(
        "data-session-id",
        "01JTEST0000000000000000001",
      );
      expect(searchRequests.some((search) => search.includes("status=completed"))).toBe(true);
    });

    // AC: @session-text-search ac-performance
    test("typing quickly does not fire a search request per keystroke before submit", async ({
      page,
      daemon: _daemon,
    }) => {
      const searchRequests: string[] = [];

      await page.route(
        "**/api/sessions/search*",
        mockSearchRoute({
          delayMs: 25,
          onRequest: (url) => searchRequests.push(url.search),
        }),
      );
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      const input = page.getByTestId("session-search-input");
      await input.click();
      await input.pressSequentially("error handling", { delay: 10 });

      await page.waitForTimeout(200);
      expect(searchRequests).toHaveLength(0);

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/sessions/search") && response.request().method() === "GET",
      );
      await page.getByTestId("session-search-submit").click();
      await responsePromise;

      await expect(page.getByTestId("session-search-results")).toBeVisible();
      expect(searchRequests).toHaveLength(1);
      expect(searchRequests[0]).toContain("q=error+handling");
    });
  });

  test.describe("Navigation", () => {
    test("sessions page is accessible from sidebar", async ({ page, daemon: _daemon }) => {
      await page.goto("/");

      const sessionsLink = page.getByTestId("nav-link-sessions");
      await expect(sessionsLink).toBeVisible();

      await sessionsLink.click();
      await expect(page).toHaveURL(/\/sessions/);
    });
  });

  // AC: @gh-pages-export ac-22
  test.describe("Static Mode (@gh-pages-export ac-22)", () => {
    test("session detail shows read-only message in static mode", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.route("**/health", (route) => {
        route.fulfill({ status: 503, body: "Service Unavailable" });
      });

      const snapshot = {
        version: "0.1.0",
        exported_at: "2026-03-08T00:00:00.000Z",
        project: { name: "Test" },
        tasks: [],
        items: [],
        inbox: [],
        session: null,
        observations: [],
        agents: [],
        workflows: [],
        conventions: [],
      };

      await page.route("**/kspec-snapshot.json", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(snapshot),
        });
      });

      await page.goto("/sessions/01JTEST0000000000000000001");

      const staticMessage = page.getByTestId("session-static-message");
      await expect(staticMessage).toBeVisible({ timeout: 10000 });
      await expect(staticMessage).toContainText(
        "Session history is not included in the static export",
      );
    });

    test("session detail does not attempt API calls in static mode", async ({
      page,
      daemon: _daemon,
    }) => {
      let sessionApiFetched = false;

      await page.route("**/health", (route) => {
        route.fulfill({ status: 503, body: "Service Unavailable" });
      });

      const snapshot = {
        version: "0.1.0",
        exported_at: "2026-03-08T00:00:00.000Z",
        project: { name: "Test" },
        tasks: [],
        items: [],
        inbox: [],
        session: null,
        observations: [],
        agents: [],
        workflows: [],
        conventions: [],
      };

      await page.route("**/kspec-snapshot.json", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(snapshot),
        });
      });

      await page.route("**/api/sessions/**", (route) => {
        sessionApiFetched = true;
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope({
              id: "test",
              status: "completed",
              agent_type: "worker",
              events: [],
              total: 0,
            }),
          ),
        });
      });

      await page.goto("/sessions/01JTEST0000000000000000001");

      await expect(page.getByTestId("session-static-message")).toBeVisible({ timeout: 10000 });
      expect(sessionApiFetched).toBe(false);
    });
  });

  // ─── Infinite Scroll Tests ───

  test.describe("Infinite Scroll", () => {
    // AC: @session-list-infinite-scroll ac-initial-load
    test("initial load fetches only first page of sessions", async ({ page, daemon: _daemon }) => {
      const allSessions = Array.from({ length: 50 }, (_, i) => makeSession(i + 1));
      const requestUrls: string[] = [];

      await page.route("**/api/sessions*", (route) => {
        const url = new URL(route.request().url());
        requestUrls.push(url.search);
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "25");

        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope(
              {
                items: allSessions.slice(offset, offset + limit),
                unfiltered_total: allSessions.length,
              },
              { total: allSessions.length, offset, limit },
            ),
          ),
        });
      });

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      // Should show only 25 rows initially
      const rows = page.getByTestId("session-row");
      await expect(rows).toHaveCount(25);

      // Should show total count "25 of 50 sessions"
      const count = page.getByTestId("sessions-count");
      await expect(count).toContainText("25 of 50 sessions");
    });

    // AC: @session-list-infinite-scroll ac-initial-load — Loading skeleton shows during fetch
    test("shows loading skeleton during initial fetch", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", async (route) => {
        await new Promise((r) => setTimeout(r, 500));
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope(
              { items: [makeSession(1)], unfiltered_total: 1 },
              { total: 1, offset: 0, limit: 25 },
            ),
          ),
        });
      });

      await page.goto("/sessions");

      // Skeleton should appear immediately
      await expect(page.getByTestId("sessions-loading")).toBeVisible();

      // Content replaces skeleton
      await expect(page.getByTestId("sessions-list")).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId("sessions-loading")).not.toBeVisible();
    });

    // AC: @session-list-infinite-scroll ac-scroll-load
    test("scrolling near bottom triggers next page load", async ({ page, daemon: _daemon }) => {
      const allSessions = Array.from({ length: 50 }, (_, i) => makeSession(i + 1));
      let _pagesFetched = 0;

      await page.route("**/api/sessions*", (route) => {
        const url = new URL(route.request().url());
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "25");
        _pagesFetched++;

        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope(
              {
                items: allSessions.slice(offset, offset + limit),
                unfiltered_total: allSessions.length,
              },
              { total: allSessions.length, offset, limit },
            ),
          ),
        });
      });

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();
      await expect(page.getByTestId("session-row")).toHaveCount(25);

      // Scroll to trigger the sentinel IntersectionObserver
      await page.getByTestId("scroll-sentinel").scrollIntoViewIfNeeded();

      // Wait for second page to load
      await expect(page.getByTestId("session-row")).toHaveCount(50, { timeout: 5000 });

      // Count should update
      await expect(page.getByTestId("sessions-count")).toContainText("50 of 50 sessions");
    });

    // AC: @session-list-infinite-scroll ac-scroll-load — Already-loaded sessions remain in place
    test("previously loaded sessions remain when next page loads", async ({
      page,
      daemon: _daemon,
    }) => {
      const allSessions = Array.from({ length: 30 }, (_, i) => makeSession(i + 1));

      await page.route("**/api/sessions*", (route) => {
        const url = new URL(route.request().url());
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "25");

        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope(
              {
                items: allSessions.slice(offset, offset + limit),
                unfiltered_total: allSessions.length,
              },
              { total: allSessions.length, offset, limit },
            ),
          ),
        });
      });

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      // Capture first session's ID
      const firstRow = page.getByTestId("session-row").first();
      const firstId = await firstRow.getAttribute("data-session-id");

      // Scroll to load more
      await page.getByTestId("scroll-sentinel").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("session-row")).toHaveCount(30, { timeout: 5000 });

      // First session should still be first
      const firstRowAfter = page.getByTestId("session-row").first();
      await expect(firstRowAfter).toHaveAttribute("data-session-id", firstId!);
    });

    // AC: @session-list-infinite-scroll ac-scroll-end
    test("shows end of list indicator when all sessions loaded", async ({
      page,
      daemon: _daemon,
    }) => {
      const allSessions = Array.from({ length: 10 }, (_, i) => makeSession(i + 1));

      await page.route("**/api/sessions*", (route) => {
        const url = new URL(route.request().url());
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "25");

        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope(
              {
                items: allSessions.slice(offset, offset + limit),
                unfiltered_total: allSessions.length,
              },
              { total: allSessions.length, offset, limit },
            ),
          ),
        });
      });

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      // All 10 sessions fit in one page (limit=25)
      await expect(page.getByTestId("session-row")).toHaveCount(10);

      // End of list indicator should be visible
      await expect(page.getByTestId("sessions-end-of-list")).toBeVisible();
      await expect(page.getByTestId("sessions-end-of-list")).toContainText(
        "All 10 sessions loaded",
      );

      // Sentinel should NOT be present (no more pages)
      await expect(page.getByTestId("scroll-sentinel")).not.toBeVisible();
    });

    // AC: @session-list-infinite-scroll ac-scroll-end — No more requests after all loaded
    test("does not make additional requests after all sessions loaded", async ({
      page,
      daemon: _daemon,
    }) => {
      const allSessions = Array.from({ length: 30 }, (_, i) => makeSession(i + 1));
      let requestCount = 0;

      await page.route("**/api/sessions*", (route) => {
        const url = new URL(route.request().url());
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "25");
        requestCount++;

        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope(
              {
                items: allSessions.slice(offset, offset + limit),
                unfiltered_total: allSessions.length,
              },
              { total: allSessions.length, offset, limit },
            ),
          ),
        });
      });

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      // Load page 2 via scroll
      await page.getByTestId("scroll-sentinel").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("session-row")).toHaveCount(30, { timeout: 5000 });
      await expect(page.getByTestId("sessions-end-of-list")).toBeVisible();

      const countAfterFullLoad = requestCount;

      // Wait a bit and verify no more requests
      await page.waitForTimeout(500);
      expect(requestCount).toBe(countAfterFullLoad);
    });

    // AC: @session-list-infinite-scroll ac-filter-reset — Filter change resets to page 1
    test("changing filter resets list to page 1", async ({ page, daemon: _daemon }) => {
      const allSessions = Array.from({ length: 50 }, (_, i) =>
        makeSession(i + 1, {
          trigger: i < 30 ? "task.ready" : "manual",
        }),
      );

      await page.route("**/api/sessions*", (route) => {
        const url = new URL(route.request().url());
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "25");
        const triggerParam = url.searchParams.get("trigger");

        let filtered = allSessions;
        if (triggerParam === "manual") {
          filtered = filtered.filter((s) => s.trigger === "manual");
        } else if (triggerParam === "dispatched") {
          filtered = filtered.filter((s) => s.trigger?.startsWith("task."));
        }

        const total = filtered.length;
        const paginated = filtered.slice(offset, offset + limit);

        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope(
              { items: paginated, unfiltered_total: allSessions.length },
              { total, offset, limit },
            ),
          ),
        });
      });

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();
      await expect(page.getByTestId("session-row")).toHaveCount(25);
      await expect(page.getByTestId("sessions-count")).toContainText("25 of 50 sessions");

      // Switch to manual filter via select dropdown — should reset to page 1 with filtered results
      await page.getByTestId("session-filter-trigger").click();
      await page.getByRole("option", { name: "Manual" }).click();

      // Manual sessions = 20 (indices 30-49), all fit in one page
      await expect(page.getByTestId("session-row")).toHaveCount(20, { timeout: 5000 });
      // AC: @session-filter-controls ac-filter-counts — Shows filtered vs total in filter controls
      await expect(page.getByTestId("session-filter-count")).toContainText("20 of 50 sessions");

      // Switch to dispatched — should reset again
      await page.getByTestId("session-filter-trigger").click();
      await page.getByRole("option", { name: "Dispatched" }).click();
      await expect(page.getByTestId("session-row")).toHaveCount(25, { timeout: 5000 });
      await expect(page.getByTestId("session-filter-count")).toContainText("30 of 50 sessions");
    });

    // AC: @session-list-infinite-scroll ac-filter-reset — Previously loaded items cleared
    test("filter change clears previously loaded items", async ({ page, daemon: _daemon }) => {
      const allSessions = Array.from({ length: 30 }, (_, i) =>
        makeSession(i + 1, {
          trigger: i < 15 ? "task.ready" : "manual",
          agent_type: i < 15 ? "task-worker" : "manual-worker",
        }),
      );

      await page.route("**/api/sessions*", (route) => {
        const url = new URL(route.request().url());
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "25");
        const triggerParam = url.searchParams.get("trigger");

        let filtered = allSessions;
        if (triggerParam === "manual") {
          filtered = filtered.filter((s) => s.trigger === "manual");
        } else if (triggerParam === "dispatched") {
          filtered = filtered.filter((s) => s.trigger?.startsWith("task."));
        }

        const total = filtered.length;
        const paginated = filtered.slice(offset, offset + limit);

        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope(
              { items: paginated, unfiltered_total: allSessions.length },
              { total, offset, limit },
            ),
          ),
        });
      });

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      // Initially shows all 30 sessions
      await expect(page.getByTestId("session-row")).toHaveCount(25);

      // Switch to manual filter via select dropdown
      await page.getByTestId("session-filter-trigger").click();
      await page.getByRole("option", { name: "Manual" }).click();
      await expect(page.getByTestId("session-row")).toHaveCount(15, { timeout: 5000 });

      // All visible sessions should be manual-worker type
      const rows = page.getByTestId("session-row");
      const count = await rows.count();
      for (let i = 0; i < count; i++) {
        await expect(rows.nth(i)).toContainText("manual-worker");
      }
    });

    // AC: @session-list-infinite-scroll ac-live-update — New sessions indicator
    test("new sessions indicator is hidden when no new sessions arrive", async ({
      page,
      daemon: _daemon,
    }) => {
      const sessions = [makeSession(1)];

      await page.route("**/api/sessions*", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope(
              { items: sessions, unfiltered_total: sessions.length },
              { total: sessions.length, offset: 0, limit: 25 },
            ),
          ),
        });
      });

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      // The new sessions indicator should NOT be visible when no events arrived
      await expect(page.getByTestId("new-sessions-indicator")).not.toBeVisible();
    });

    // AC: @session-list-infinite-scroll ac-live-update-source-agnostic
    test("refreshes from sessions-topic updates as well as agent-origin updates", async ({
      page,
      daemon,
      request,
    }) => {
      const agentType = "source-agnostic-worker";
      const firstSessionId = "01JTESTSOURCEAGNTSESSION000001";
      const secondSessionId = "01JTESTSOURCEAGNTSESSION000002";
      const thirdSessionId = "01JTESTSOURCEAGNTSESSION000003";

      await writeSessionFixture(daemon.tempDir, {
        id: firstSessionId,
        status: "completed",
        startedAt: "2026-03-20T10:00:00.000Z",
        endedAt: "2026-03-20T10:05:00.000Z",
        agentType,
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

      await expect
        .poll(async () => {
          const response = await request.get(
            `${daemon.baseUrl}/api/sessions?agent_type=${agentType}`,
          );
          const body = await response.json();
          return body.meta?.total ?? 0;
        })
        .toBe(1);

      await page.goto(`/sessions?agent_type=${agentType}`);
      await expect(page.getByTestId("sessions-list")).toBeVisible();
      await expect(page.getByTestId("session-row")).toHaveCount(1);
      await expect(page.getByTestId("session-row").first()).toHaveAttribute(
        "data-session-id",
        firstSessionId,
      );
      await page.evaluate(async () => {
        const ws = ((window as any).__test_ws_instances as WebSocket[] | undefined)?.find(
          (socket) => socket.readyState === WebSocket.OPEN,
        );
        if (!ws) {
          throw new Error("WebSocket not connected");
        }

        const subscribeToTopic = (topicName: string) =>
          new Promise<void>((resolve, reject) => {
            const requestId = `sub-${topicName}-${Date.now()}-${Math.random()}`;
            const timeout = window.setTimeout(() => {
              ws.removeEventListener("message", handleMessage);
              reject(new Error(`Timed out waiting for subscribe ack for ${topicName}`));
            }, 5000);

            const handleMessage = (event: MessageEvent) => {
              try {
                const data = JSON.parse(String(event.data));
                if (data.ack === true && data.request_id === requestId && data.success) {
                  window.clearTimeout(timeout);
                  ws.removeEventListener("message", handleMessage);
                  resolve();
                }
              } catch {
                // Ignore non-JSON frames.
              }
            };

            ws.addEventListener("message", handleMessage);
            ws.send(
              JSON.stringify({
                action: "subscribe",
                request_id: requestId,
                payload: { topics: [topicName] },
              }),
            );
          });

        await subscribeToTopic("sessions");
        await subscribeToTopic("agents");
      });

      await writeSessionFixture(daemon.tempDir, {
        id: secondSessionId,
        status: "active",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        agentType,
      });

      // Keep one assertion on the real daemon -> WebSocket -> UI path so the
      // watcher-backed sessions-topic fanout remains covered end-to-end.
      await expect(page.getByTestId("session-row")).toHaveCount(2, { timeout: 5000 });
      await expect(page.getByTestId("session-row").first()).toHaveAttribute(
        "data-session-id",
        secondSessionId,
      );
      await expect(
        page.getByTestId("session-row").first().getByTestId("session-status-badge"),
      ).toHaveAttribute("data-status-state", "active");

      await writeSessionFixture(daemon.tempDir, {
        id: thirdSessionId,
        status: "active",
        startedAt: new Date(Date.now() - 30_000).toISOString(),
        agentType,
      });

      await expect
        .poll(async () => {
          const response = await request.get(
            `${daemon.baseUrl}/api/sessions?agent_type=${agentType}`,
          );
          const body = await response.json();
          return body.meta?.total ?? 0;
        })
        .toBe(3);

      const agentsTopicInjected = await page.evaluate((sessionId: string) => {
        const instances = (window as any).__test_ws_instances as WebSocket[];
        const ws = instances?.find((s) => s.readyState === WebSocket.OPEN);
        if (!ws) return false;

        ws.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              msg_id: "test-source-agnostic-agents",
              seq: 9996,
              timestamp: new Date().toISOString(),
              topic: "agents",
              event: "agent_invocation",
              data: {
                session_id: sessionId,
                agent_id: "task-worker",
                task_id: null,
                status: "started",
                timestamp: Date.now(),
              },
            }),
          }),
        );
        return true;
      }, thirdSessionId);
      expect(agentsTopicInjected).toBe(true);

      await expect(page.getByTestId("session-row")).toHaveCount(3, { timeout: 3000 });
      await expect(page.getByTestId("session-row").first()).toHaveAttribute(
        "data-session-id",
        thirdSessionId,
      );
      await expect(
        page.getByTestId("session-row").first().getByTestId("session-status-badge"),
      ).toHaveAttribute("data-status-state", "active");
    });

    // AC: @session-list-infinite-scroll ac-live-update — Total count updates on new session
    test("total count increments when WebSocket event arrives", async ({
      page,
      daemon: _daemon,
    }) => {
      const sessions = Array.from({ length: 5 }, (_, i) => makeSession(i + 1));
      const newSession = makeSession(6, {
        status: "active",
        started_at: "2026-03-29T10:00:00.000Z",
        ended_at: undefined,
      });
      let callCount = 0;

      await page.route("**/api/sessions*", (route) => {
        callCount++;
        const currentSessions = callCount > 1 ? [newSession, ...sessions] : sessions;
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope(
              { items: currentSessions, unfiltered_total: currentSessions.length },
              { total: currentSessions.length, offset: 0, limit: 25 },
            ),
          ),
        });
      });

      // Capture WebSocket instances for event injection
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

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();
      await expect(page.getByTestId("sessions-count")).toContainText("5 of 5 sessions");

      // Inject agent_invocation started event via WebSocket
      const injected = await page.evaluate(() => {
        const instances = (window as any).__test_ws_instances as WebSocket[];
        const ws = instances?.find((s) => s.readyState === WebSocket.OPEN);
        if (!ws) return false;

        const msg = JSON.stringify({
          msg_id: "test-live-001",
          seq: 9999,
          timestamp: new Date().toISOString(),
          topic: "agents",
          event: "agent_invocation",
          data: {
            session_id: "new-session-001",
            agent_id: "task-worker",
            task_id: null,
            status: "started",
            timestamp: Date.now(),
          },
        });
        ws.dispatchEvent(new MessageEvent("message", { data: msg }));
        return true;
      });
      expect(injected).toBe(true);

      // Total count should update to 6 (5 + 1 new)
      await expect(page.getByTestId("sessions-count")).toContainText("of 6 sessions", {
        timeout: 3000,
      });
      await expect(page.getByTestId("session-row").first()).toContainText(
        newSession.id.slice(0, 8),
      );
    });

    // AC: @session-list-infinite-scroll ac-live-update — At-top prepend behavior
    test("re-fetches page when user is at top and new session arrives", async ({
      page,
      daemon: _daemon,
    }) => {
      let fetchCount = 0;
      const sessions = Array.from({ length: 3 }, (_, i) => makeSession(i + 1));

      await page.route("**/api/sessions*", (route) => {
        fetchCount++;
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope(
              { items: sessions, unfiltered_total: sessions.length },
              { total: sessions.length, offset: 0, limit: 25 },
            ),
          ),
        });
      });

      // Capture WebSocket instances
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

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();
      const fetchCountBeforeEvent = fetchCount;

      // User is at top (default position) — inject new session event
      const injected = await page.evaluate(() => {
        const instances = (window as any).__test_ws_instances as WebSocket[];
        const ws = instances?.find((s) => s.readyState === WebSocket.OPEN);
        if (!ws) return false;

        const msg = JSON.stringify({
          msg_id: "test-live-002",
          seq: 9998,
          timestamp: new Date().toISOString(),
          topic: "agents",
          event: "agent_invocation",
          data: {
            session_id: "new-session-002",
            agent_id: "task-worker",
            task_id: null,
            status: "started",
            timestamp: Date.now(),
          },
        });
        ws.dispatchEvent(new MessageEvent("message", { data: msg }));
        return true;
      });
      expect(injected).toBe(true);

      // At top: should trigger a re-fetch (loadInitialPage), not show indicator
      await page.waitForTimeout(500);
      expect(fetchCount).toBeGreaterThan(fetchCountBeforeEvent);

      // Indicator should NOT show when at top
      await expect(page.getByTestId("new-sessions-indicator")).not.toBeVisible();
    });

    // AC: @session-list-infinite-scroll ac-live-update-scrolled
    test("shows indicator when an in-list update arrives while the user is scrolled down", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.setViewportSize({ width: 1280, height: 480 });

      // Need enough sessions to enable scrolling
      const sessions = Array.from({ length: 25 }, (_, i) => makeSession(i + 1));
      let requestCount = 0;

      await page.route("**/api/sessions*", (route) => {
        requestCount++;
        const currentSessions =
          requestCount > 1
            ? sessions.map((session, index) =>
                index === 10 ? { ...session, status: "failed" as const } : session,
              )
            : sessions;
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope(
              { items: currentSessions, unfiltered_total: 50 },
              { total: 50, offset: 0, limit: 25 },
            ),
          ),
        });
      });

      // Capture WebSocket instances
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

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      // Scroll down past the top threshold — the real scroll container is
      // the layout's <main class="overflow-auto">, not the page div
      const scrollTop = await page.locator("main.overflow-auto").evaluate((main) => {
        const element = main as HTMLElement;
        Object.defineProperty(element, "scrollTop", {
          configurable: true,
          value: 500,
        });
        element.dispatchEvent(new Event("scroll"));
        return element.scrollTop;
      });
      expect(scrollTop).toBeGreaterThan(80);

      // Inject a sessions update while scrolled down. The total count and first
      // row stay the same, so this only surfaces if the page detects in-list changes.
      const targetSessionId = sessions[10].id;
      const injected = await page.evaluate((sessionId: string) => {
        const instances = (window as any).__test_ws_instances as WebSocket[];
        const ws = instances?.find((s) => s.readyState === WebSocket.OPEN);
        if (!ws) return false;

        const msg = JSON.stringify({
          msg_id: "test-live-003",
          seq: 9997,
          timestamp: new Date().toISOString(),
          topic: "sessions",
          event: "session_changed",
          data: {
            session_id: sessionId,
            path: `.kspec-sessions/${sessionId}/session.yaml`,
          },
        });
        ws.dispatchEvent(new MessageEvent("message", { data: msg }));
        return true;
      }, targetSessionId);
      expect(injected).toBe(true);

      // Indicator should appear when scrolled down
      await expect(page.getByTestId("new-sessions-indicator")).toBeVisible({ timeout: 3000 });
      await expect(page.getByTestId("new-sessions-indicator")).toContainText("1 new session");

      // Count stays unchanged because this is an in-place status update rather than a new row.
      await expect(page.getByTestId("sessions-count")).toContainText("25 of 50 sessions");
    });

    // AC: @session-list-infinite-scroll ac-live-update — Clicking indicator refreshes
    test("clicking new sessions indicator refreshes the list", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.setViewportSize({ width: 1280, height: 480 });

      let callCount = 0;
      const sessions = Array.from({ length: 25 }, (_, i) => makeSession(i + 1));
      const newSession = makeSession(26, {
        status: "active",
        started_at: "2026-03-30T10:00:00.000Z",
        ended_at: undefined,
      });

      await page.route("**/api/sessions*", (route) => {
        callCount++;
        const currentSessions = callCount > 1 ? [newSession, ...sessions.slice(0, 24)] : sessions;
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            envelope(
              { items: currentSessions, unfiltered_total: 51 },
              { total: 51, offset: 0, limit: 25 },
            ),
          ),
        });
      });

      // Capture WebSocket instances
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

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      // Scroll down to trigger indicator behavior — layout's <main> is the scroll container
      const scrollTop = await page.locator("main.overflow-auto").evaluate((main) => {
        const element = main as HTMLElement;
        Object.defineProperty(element, "scrollTop", {
          configurable: true,
          value: 500,
        });
        element.dispatchEvent(new Event("scroll"));
        return element.scrollTop;
      });
      expect(scrollTop).toBeGreaterThan(80);

      // Inject event while scrolled
      await page.evaluate(() => {
        const instances = (window as any).__test_ws_instances as WebSocket[];
        const ws = instances?.find((s) => s.readyState === WebSocket.OPEN);
        if (!ws) return;
        ws.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              msg_id: "test-live-004",
              seq: 9996,
              timestamp: new Date().toISOString(),
              topic: "agents",
              event: "agent_invocation",
              data: {
                session_id: "new-session-004",
                agent_id: "task-worker",
                task_id: null,
                status: "started",
                timestamp: Date.now(),
              },
            }),
          }),
        );
      });

      await expect(page.getByTestId("new-sessions-indicator")).toBeVisible({ timeout: 3000 });
      const callsBeforeClick = callCount;

      // Click the indicator to refresh
      await page.getByTestId("new-sessions-indicator").click();

      // Should trigger a new fetch
      await page.waitForTimeout(500);
      expect(callCount).toBeGreaterThan(callsBeforeClick);
      await expect(page.getByTestId("session-row").first()).toContainText(
        newSession.id.slice(0, 8),
      );

      // Indicator should disappear after refresh
      await expect(page.getByTestId("new-sessions-indicator")).not.toBeVisible();
    });
  });

  // ─── Session Filter Controls Tests ───

  test.describe("Session Filter Controls", () => {
    // AC: @session-filter-controls ac-status-filter
    test("status filter appends repeated status params and filters sessions", async ({
      page,
      daemon: _daemon,
    }) => {
      const sessions = mockSessions();
      await page.route("**/api/sessions*", mockSessionsRoute(sessions));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      await page.getByTestId("session-filter-status-completed").click();
      await expect(page).toHaveURL(/status=completed/);
      await expect(page.getByTestId("session-row")).toHaveCount(1);

      await page.getByTestId("session-filter-status-failed").click();

      // URL should preserve repeated status params.
      await expect(page).toHaveURL(/status=completed/);
      await expect(page).toHaveURL(/status=failed/);

      // Completed + failed sessions remain.
      await expect(page.getByTestId("session-row")).toHaveCount(2);
    });

    // AC: @session-filter-controls ac-agent-filter
    test("agent filter updates URL with agent_id and filters sessions", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      await page.getByTestId("session-filter-agent").click();
      await page.getByRole("option", { name: "pr-reviewer" }).click();

      await expect(page).toHaveURL(/agent_id=pr-reviewer/);
      await expect(page.getByTestId("session-row")).toHaveCount(1);
      await expect(page.getByTestId("session-row").first()).toContainText("pr-reviewer");
    });

    // AC: @session-filter-controls ac-agent-type-filter
    test("agent type filter updates URL with agent_type and filters sessions", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      await page.getByTestId("session-filter-agent-type").click();
      await page.getByRole("option", { name: "pr-reviewer" }).click();

      await expect(page).toHaveURL(/agent_type=pr-reviewer/);
      await expect(page.getByTestId("session-row")).toHaveCount(1);
      await expect(page.getByTestId("session-row").first()).toContainText("pr-reviewer");
    });

    // AC: @session-filter-controls ac-date-filter
    test("date filter updates URL with since param", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      await page.getByTestId("session-filter-date").click();
      await page.getByRole("option", { name: "Today" }).click();

      // URL should update with a concrete since date.
      await expect(page).toHaveURL(/since=/);
    });

    // AC: @session-filter-controls ac-clear-filters
    test("clear filters button removes all filter params from URL", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));

      // Navigate with filters already in URL
      await page.goto("/sessions?trigger=manual&status=completed&agent_id=worker");
      await expect(page.getByTestId("session-filter-controls")).toBeVisible();

      // Clear filters button should be visible
      const clearBtn = page.getByTestId("session-clear-filters");
      await expect(clearBtn).toBeVisible();

      await clearBtn.click();

      // URL should be clean
      await expect(page).toHaveURL(/\/sessions$/);
    });

    // AC: @session-filter-controls ac-filter-counts
    test("shows filtered vs total count when filters active", async ({ page, daemon: _daemon }) => {
      const sessions = mockSessions();
      await page.route("**/api/sessions*", mockSessionsRoute(sessions));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      // Apply a filter
      await page.getByTestId("session-filter-trigger").click();
      await page.getByRole("option", { name: "Manual" }).click();

      // Should show filtered count
      await expect(page.getByTestId("session-filter-count")).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId("session-filter-count")).toContainText("of");
    });

    test("does not fetch the full session dataset to seed filter controls", async ({
      page,
      daemon: _daemon,
    }) => {
      const sessions = {
        items: Array.from({ length: 80 }, (_, index) =>
          makeSession(index + 1, {
            agent_type: index < 40 ? "task-worker" : "pr-reviewer",
            agent_id: index < 40 ? "worker" : "reviewer",
            trigger: index % 2 === 0 ? "manual" : "task.ready",
          }),
        ),
        total: 80,
        offset: 0,
        limit: 25,
      };
      const requestedLimits: number[] = [];

      await page.route("**/api/sessions*", (route) => {
        const url = new URL(route.request().url());
        requestedLimits.push(Number(url.searchParams.get("limit") ?? "0"));
        return mockSessionsRoute(sessions)(route);
      });

      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      expect(requestedLimits.length).toBeGreaterThan(0);
      expect(requestedLimits.every((limit) => limit <= 25)).toBe(true);
      expect(requestedLimits).not.toContain(80);
    });

    // AC: @session-filter-controls ac-filter-counts — No count when no filters
    test("does not show filter count when no filters active", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));
      await page.goto("/sessions");
      await expect(page.getByTestId("sessions-list")).toBeVisible();

      // Filter count should NOT be visible without filters
      await expect(page.getByTestId("session-filter-count")).not.toBeVisible();
    });

    // AC: @ui-url-panel-state ac-4 — Filters persist in URL on page load
    test("filters load from URL params on page navigation", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/sessions*", mockSessionsRoute(mockSessions()));

      // Navigate directly with filter params
      await page.goto("/sessions?trigger=manual&status=failed&agent_id=worker");
      await expect(page.getByTestId("session-filter-controls")).toBeVisible();

      // Only the matching manual session should be shown.
      await expect(page.getByTestId("session-row")).toHaveCount(1);
    });
  });
});
