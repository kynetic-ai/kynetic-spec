/**
 * E2E Tests for Review Detail Page
 *
 * Tests verify the /reviews/[id] page renders correctly with all sections.
 * Uses route mocking for reliable, deterministic page rendering tests.
 *
 * Covered ACs:
 * - @review-records-web-ui ac-2: Detail page shows threads, checks, verdicts, disposition
 * - @review-records-web-ui ac-8: Markdown rendering with syntax highlighting
 * - @review-records-web-ui ac-9: Author identity and relative timestamp on entries
 * - @review-records-web-ui ac-10: Empty state messages for sections with no items
 * - @review-records-web-ui ac-11: Revision dropdown for same-subject reviews
 */

import { test, expect } from "./fixtures/test-base";

const REVIEW_ULID = "01KKTX0CA45ZT43W2T6HJMVA01";
const SIBLING_ULID = "01KKV0TCA45ZT43W2T6HJMVB03";

/** Full review detail with threads, checks, and verdicts */
function mockReviewDetail() {
  return {
    _ulid: REVIEW_ULID,
    slugs: ["test-review-open"],
    title: "Review of test task",
    lifecycle_state: "open",
    disposition: "changes_requested",
    subject: {
      type: "task",
      ref: "@test-task-pending-review",
      shadow_commit: "abc1234",
      content_hash: "hash123",
    },
    author: "reviewer@test.com",
    related_refs: [],
    threads: [
      {
        _ulid: "01KKTX1CA45ZT43W2T6HJMVA02",
        kind: "blocker",
        entries: [
          {
            _ulid: "01KKTX2CA45ZT43W2T6HJMVA03",
            author: "reviewer@test.com",
            body: "Missing error handling for edge case",
            created_at: "2026-03-15T10:00:00Z",
          },
        ],
      },
      {
        _ulid: "01KKTX3CA45ZT43W2T6HJMVA04",
        kind: "nit",
        entries: [
          {
            _ulid: "01KKTX4CA45ZT43W2T6HJMVA05",
            author: "reviewer@test.com",
            body: "Consider renaming this variable",
            created_at: "2026-03-15T10:05:00Z",
          },
        ],
      },
      {
        _ulid: "01KKTX5CA45ZT43W2T6HJMVA06",
        kind: "question",
        resolved_at: "2026-03-15T11:00:00Z",
        resolved_by: "worker@test.com",
        entries: [
          {
            _ulid: "01KKTX6CA45ZT43W2T6HJMVA07",
            author: "reviewer@test.com",
            body: "Why was this approach chosen?",
            created_at: "2026-03-15T10:10:00Z",
          },
          {
            _ulid: "01KKTX7CA45ZT43W2T6HJMVA08",
            author: "worker@test.com",
            body: "Because it handles concurrent writes better",
            created_at: "2026-03-15T10:30:00Z",
          },
        ],
      },
      {
        _ulid: "01KKV0RCA45ZT43W2T6HJMVB01",
        kind: "blocker",
        entries: [
          {
            _ulid: "01KKV0SCA45ZT43W2T6HJMVB02",
            author: "reviewer@test.com",
            body: "Found a **critical bug** in `validateInput()`:\n\n```typescript\nif (input.length > MAX_LENGTH) {\n  return null; // should throw Error\n}\n```\n\nThis silently returns `null` instead of throwing.",
            created_at: "2026-03-15T10:15:00Z",
          },
        ],
      },
    ],
    checks: [
      {
        name: "vitest",
        status: "pass",
        required: true,
        runner: "vitest",
        evidence: "All 342 tests passed",
        applies_to_version: { type: "entity_version", content_hash: "hash123" },
        created_at: "2026-03-15T10:30:00Z",
      },
      {
        name: "lint",
        status: "fail",
        required: true,
        runner: "eslint",
        evidence: "3 errors found",
        applies_to_version: { type: "entity_version", content_hash: "hash123" },
        created_at: "2026-03-15T10:31:00Z",
      },
      {
        name: "coverage",
        status: "pass",
        required: false,
        runner: "vitest",
        evidence: "87% coverage",
        applies_to_version: { type: "entity_version", content_hash: "stale-hash" },
        created_at: "2026-03-15T09:00:00Z",
      },
    ],
    verdicts: [
      {
        reviewer: "reviewer@test.com",
        role: "reviewer",
        decision: "request_changes",
        applies_to_version: { type: "entity_version", content_hash: "hash123" },
        created_at: "2026-03-15T11:00:00Z",
      },
    ],
    events: [],
    notes: [],
    external_links: [],
    examined_commit: null,
    // Server-resolved breadcrumb ancestor chain (root → current review). Seven
    // segments exercises the 7+ tier: root + collapse(4) + one ancestor + current.
    ancestors: [
      { ref: "@web-ui-system", title: "Web UI System", kind: "module" },
      { ref: "@web-dashboard", title: "Web Dashboard", kind: "feature" },
      { ref: "@plans-view", title: "Plans View", kind: "feature" },
      { ref: "@embedded-views", title: "Plan Content Embedded Views", kind: "requirement" },
      { ref: "@ac-1", title: "AC-1", kind: "requirement" },
      { ref: "@test-task-pending-review", title: "Test task", kind: "task" },
      { ref: `@${REVIEW_ULID}`, title: "Review of test task", kind: "review" },
    ],
    created_at: "2026-03-15T09:00:00Z",
    updated_at: "2026-03-15T11:00:00Z",
  };
}

/** Empty review for testing empty states */
function mockEmptyReview() {
  return {
    _ulid: "01KKTX9CA45ZT43W2T6HJMVA10",
    slugs: ["test-review-draft"],
    title: "Draft review",
    lifecycle_state: "draft",
    disposition: "pending",
    subject: {
      type: "task",
      ref: "@test-task-ready",
      shadow_commit: "def5678",
      content_hash: "hash456",
    },
    author: "reviewer@test.com",
    related_refs: [],
    threads: [],
    checks: [],
    verdicts: [],
    events: [],
    notes: [],
    external_links: [],
    examined_commit: null,
    created_at: "2026-03-15T08:00:00Z",
    updated_at: null,
  };
}

/** Sibling reviews for revision selector test */
function mockSiblingReviews() {
  return {
    items: [
      {
        _ulid: REVIEW_ULID,
        slugs: ["test-review-open"],
        title: "Review of test task",
        lifecycle_state: "open",
        disposition: "changes_requested",
        subject_type: "task",
        subject_ref: "@test-task-pending-review",
        author: "reviewer@test.com",
        related_refs: [],
        thread_count: 4,
        unresolved_blocker_count: 2,
        check_count: 3,
        verdict_count: 1,
        created_at: "2026-03-15T09:00:00Z",
        updated_at: "2026-03-15T11:00:00Z",
      },
      {
        _ulid: SIBLING_ULID,
        slugs: ["test-review-sibling"],
        title: "Review of test task (cycle 2)",
        lifecycle_state: "closed",
        disposition: "approved",
        subject_type: "task",
        subject_ref: "@test-task-pending-review",
        author: "reviewer@test.com",
        related_refs: [],
        thread_count: 0,
        unresolved_blocker_count: 0,
        check_count: 0,
        verdict_count: 1,
        created_at: "2026-03-16T12:00:00Z",
        updated_at: "2026-03-16T14:00:00Z",
      },
    ],
    total: 2,
    offset: 0,
    limit: 2,
  };
}

function routeDetailMock(reviewData: ReturnType<typeof mockReviewDetail>) {
  return (route: any) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: reviewData, meta: { cache_status: "ready" } }),
    });
  };
}

function routeSiblingsMock(siblingData: ReturnType<typeof mockSiblingReviews>) {
  return (route: any) => {
    const url = new URL(route.request().url());
    const subjectType = url.searchParams.get("subject_type");

    // Filter by subject_type if specified
    let items = siblingData.items;
    if (subjectType) {
      items = items.filter((r) => r.subject_type === subjectType);
    }

    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: items,
        meta: { cache_status: "ready", total: items.length, offset: 0, limit: items.length },
      }),
    });
  };
}

test.describe("Review Detail Page", () => {
  test.describe("Header and Metadata", () => {
    // AC: @review-records-web-ui ac-2 — Review detail shows title and badges
    test("displays review title and disposition badge", async ({ page, daemon: _daemon }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      await expect(page.getByTestId("review-title")).toHaveText("Review of test task");
      await expect(page.getByTestId("review-disposition-badge")).toContainText("Changes Requested");
      await expect(page.getByTestId("review-lifecycle-badge")).toContainText("Open");
    });

    // AC: @review-records-web-ui ac-2 — Subject info with type and ref
    test("displays subject type and ref link", async ({ page, daemon: _daemon }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      await expect(page.getByTestId("review-subject-info")).toContainText("Task");
      await expect(page.getByTestId("review-subject-link")).toBeVisible();
    });

    // AC: @review-records-web-ui ac-9 — Author and timestamp displayed
    test("displays author and creation time", async ({ page, daemon: _daemon }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      await expect(page.getByTestId("review-author")).toContainText("reviewer@test.com");
      await expect(page.getByTestId("review-created-at")).toBeVisible();
    });

    // AC: @ui-breadcrumb ac-1, ac-3, ac-9 — the adaptive breadcrumb replaces the
    // ad-hoc back link, showing the server-resolved hierarchy with the current
    // review emphasized and the deep middle collapsed behind one indicator.
    test("shows the adaptive breadcrumb with collapsed ancestors and emphasized current", async ({
      page,
      daemon: _daemon,
    }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      const crumb = page.getByTestId("breadcrumb");
      await expect(crumb).toBeVisible();
      // 7 segments → root + collapse indicator + one ancestor + current.
      await expect(crumb.getByTestId("breadcrumb-current")).toContainText("Review of test task");
      const collapse = crumb.getByTestId("breadcrumb-collapse");
      await expect(collapse).toBeVisible();
      await expect(collapse).toContainText("4"); // four middle segments collapsed
      // Root and the single nearest ancestor stay visible as links.
      await expect(crumb.getByTestId("breadcrumb-segment")).toHaveCount(2);
    });

    // AC: @ui-breadcrumb ac-5, ac-7, ac-8 — clicking the indicator opens an overlay
    // popover listing collapsed segments as links, shifting no surrounding content.
    test("opens the collapsed-segment popover on click without layout shift", async ({
      page,
      daemon: _daemon,
    }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      const title = page.getByTestId("review-title");
      const before = await title.boundingBox();

      await page.getByTestId("breadcrumb-collapse").click();
      const popover = page.getByTestId("breadcrumb-popover");
      await expect(popover).toBeVisible();
      // Collapsed segments listed in hierarchy order as links.
      const items = popover.getByTestId("breadcrumb-popover-item");
      await expect(items).toHaveCount(4);
      await expect(items.first()).toContainText("Web Dashboard");
      await expect(items.last()).toContainText("AC-1");

      // AC: @ui-breadcrumb ac-8 — overlay popover does not move page content.
      const after = await title.boundingBox();
      expect(after?.x).toBeCloseTo(before?.x ?? 0, 0);
      expect(after?.y).toBeCloseTo(before?.y ?? 0, 0);
    });

    // AC: @ui-breadcrumb ac-6 — keyboard: open, arrow to move, Enter to navigate, Escape to close.
    test("navigates the popover by keyboard and closes on Escape", async ({
      page,
      daemon: _daemon,
    }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      const collapse = page.getByTestId("breadcrumb-collapse");
      await collapse.focus();
      await page.keyboard.press("Enter"); // open by keyboard, never hover (ac-7)
      const popover = page.getByTestId("breadcrumb-popover");
      await expect(popover).toBeVisible();

      // Escape closes without navigating away from the review.
      await page.keyboard.press("Escape");
      await expect(popover).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/reviews/${REVIEW_ULID}`));

      // Re-open and arrow-navigate to the first collapsed segment, then Enter.
      await collapse.focus();
      await page.keyboard.press("Enter");
      await expect(popover).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      // The first collapsed segment is a feature → routes to the specs surface.
      await page.waitForURL(/\/specs\?ref=/);
    });
  });

  test.describe("Threads Section", () => {
    // AC: @review-records-web-ui ac-2 — Threads displayed with entries, resolution state, kind badges
    test("displays threads with kind badges and entries", async ({ page, daemon: _daemon }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      await expect(page.getByTestId("threads-section")).toBeVisible();

      // Only the unresolved threads render before the resolved section is expanded.
      const threadItems = page.getByTestId("thread-item");
      await expect(threadItems).toHaveCount(3);
      await expect(page.getByTestId("resolved-threads-toggle")).toContainText("1 resolved thread");
    });

    // AC: @review-records-web-ui ac-2 — Kind badges with correct labels
    test("shows correct kind badges (blocker, question, nit)", async ({
      page,
      daemon: _daemon,
    }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      // Wait for threads section to render
      await expect(page.getByTestId("threads-section")).toBeVisible();

      // Verify badge content by checking individual thread items
      const threadItems = page.getByTestId("thread-item");
      const _count = await threadItems.count();
      // Each thread-item contains a kind badge; check visible ones
      const blockerCount = await page
        .locator('[data-testid="thread-kind-badge"]:visible')
        .filter({ hasText: "Blocker" })
        .count();
      const nitCount = await page
        .locator('[data-testid="thread-kind-badge"]:visible')
        .filter({ hasText: "Nit" })
        .count();
      expect(blockerCount).toBe(2);
      expect(nitCount).toBe(1);
    });

    // AC: @review-records-web-ui ac-2 — Resolution state shown
    test("shows resolved threads in collapsible section", async ({ page, daemon: _daemon }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      // Resolved threads toggle should exist
      const toggle = page.getByTestId("resolved-threads-toggle");
      await expect(toggle).toBeVisible();
      await expect(toggle).toContainText("1 resolved thread");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");

      // Toggle via keyboard to avoid pointer actionability races while still
      // exercising the real button-driven disclosure state change.
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");

      // Now the resolved thread content should be rendered and visible
      const resolvedSection = page.getByTestId("resolved-threads-section");
      await expect(resolvedSection).toBeVisible();

      const resolvedThread = page.locator('[data-thread-id="01KKTX5CA45ZT43W2T6HJMVA06"]');
      await expect(resolvedThread).toBeVisible();
      await expect(resolvedThread.getByTestId("thread-status")).toContainText("Resolved");
    });

    // AC: @review-records-web-ui ac-9 — Author and timestamp on thread entries
    test("shows author and relative timestamp on thread entries", async ({
      page,
      daemon: _daemon,
    }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      const entryAuthors = page.getByTestId("entry-author");
      await expect(entryAuthors.first()).toContainText("reviewer@test.com");

      const entryTimestamps = page.getByTestId("entry-timestamp");
      await expect(entryTimestamps.first()).toBeVisible();
    });

    // AC: @review-records-web-ui ac-8 — Markdown rendering in thread bodies
    test("renders markdown with syntax highlighting in thread bodies", async ({
      page,
      daemon: _daemon,
    }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      // The 4th thread (index 2 in visible, 0-based) has markdown with code block
      // Find the thread with markdown content
      const _entryBodies = page.getByTestId("entry-body");

      // One of the entries should have rendered HTML with <strong> (from **critical bug**)
      const markdownEntry = page.locator('[data-testid="entry-body"] strong');
      await expect(markdownEntry.first()).toBeVisible();

      // Should have rendered code block with <pre><code>
      const codeBlock = page.locator('[data-testid="entry-body"] pre code');
      await expect(codeBlock.first()).toBeVisible();

      // Should have rendered inline code with <code> for `validateInput()`
      const inlineCode = page.locator('[data-testid="entry-body"] code:not(pre code)');
      await expect(inlineCode.first()).toBeVisible();
    });
  });

  test.describe("Checks Section", () => {
    // AC: @review-records-web-ui ac-2 — Checks show pass/fail with staleness
    test("displays checks with pass/fail status", async ({ page, daemon: _daemon }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      await expect(page.getByTestId("checks-section")).toBeVisible();
      const checkItems = page.getByTestId("check-item");
      await expect(checkItems).toHaveCount(3);

      // Check names visible
      const checkNames = page.getByTestId("check-name");
      await expect(checkNames.nth(0)).toHaveText("vitest");
      await expect(checkNames.nth(1)).toHaveText("lint");
      await expect(checkNames.nth(2)).toHaveText("coverage");

      // Status badges
      const statusBadges = page.getByTestId("check-status-badge");
      await expect(statusBadges.nth(0)).toContainText("Pass");
      await expect(statusBadges.nth(1)).toContainText("Fail");
      await expect(statusBadges.nth(2)).toContainText("Pass");
    });

    // AC: @review-records-web-ui ac-2 — Staleness indicator on checks
    test("shows stale badge on checks with non-matching version", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.goto(`/reviews/${REVIEW_ULID}`);

      // Use the seeded fixture instead of a route-mocked variant so the staleness
      // assertion tracks the current review-detail response shape end-to-end.
      const staleBadges = page.getByTestId("check-stale-badge");
      await expect(staleBadges).toHaveCount(1);
      await expect(staleBadges.first()).toContainText("Stale");
    });

    // AC: @review-records-web-ui ac-2 — Check evidence displayed
    test("shows evidence text for checks", async ({ page, daemon: _daemon }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      const evidence = page.getByTestId("check-evidence");
      await expect(evidence.first()).toContainText("All 342 tests passed");
    });
  });

  test.describe("Verdicts Section", () => {
    // AC: @review-records-web-ui ac-2 — Verdicts show reviewer decisions
    test("displays verdicts with reviewer and decision", async ({ page, daemon: _daemon }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      await expect(page.getByTestId("verdicts-section")).toBeVisible();
      const verdictItems = page.getByTestId("verdict-item");
      await expect(verdictItems).toHaveCount(1);

      await expect(page.getByTestId("verdict-decision-badge").first()).toContainText(
        "Changes Requested",
      );
      await expect(page.getByTestId("verdict-reviewer").first()).toContainText("reviewer@test.com");
      await expect(page.getByTestId("verdict-timestamp").first()).toBeVisible();
    });
  });

  test.describe("Empty States", () => {
    // AC: @review-records-web-ui ac-10 — Empty state for threads
    test("shows empty state when review has no threads", async ({ page, daemon: _daemon }) => {
      const detail = mockEmptyReview();
      await page.route(`**/api/reviews/${detail._ulid}`, routeDetailMock(detail as any));
      await page.route("**/api/reviews?*", (route: any) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [], total: 0, offset: 0, limit: 0 }),
        });
      });
      await page.goto(`/reviews/${detail._ulid}`);

      await expect(page.getByTestId("threads-empty")).toBeVisible();
      await expect(page.getByTestId("threads-empty")).toContainText("No threads yet");
    });

    // AC: @review-records-web-ui ac-10 — Empty state for checks
    test("shows empty state when review has no checks", async ({ page, daemon: _daemon }) => {
      const detail = mockEmptyReview();
      await page.route(`**/api/reviews/${detail._ulid}`, routeDetailMock(detail as any));
      await page.route("**/api/reviews?*", (route: any) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [], total: 0, offset: 0, limit: 0 }),
        });
      });
      await page.goto(`/reviews/${detail._ulid}`);

      await expect(page.getByTestId("checks-empty")).toBeVisible();
      await expect(page.getByTestId("checks-empty")).toContainText("No checks recorded");
    });

    // AC: @review-records-web-ui ac-10 — Empty state for verdicts
    test("shows empty state when review has no verdicts", async ({ page, daemon: _daemon }) => {
      const detail = mockEmptyReview();
      await page.route(`**/api/reviews/${detail._ulid}`, routeDetailMock(detail as any));
      await page.route("**/api/reviews?*", (route: any) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [], total: 0, offset: 0, limit: 0 }),
        });
      });
      await page.goto(`/reviews/${detail._ulid}`);

      await expect(page.getByTestId("verdicts-empty")).toBeVisible();
      await expect(page.getByTestId("verdicts-empty")).toContainText("No verdicts yet");
    });
  });

  test.describe("Revision Selector", () => {
    // AC: @review-records-web-ui ac-11 — Revision dropdown for same-subject reviews
    test("shows revision selector when multiple reviews exist for same subject", async ({
      page,
      daemon: _daemon,
    }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      const selector = page.getByTestId("revision-selector");
      await expect(selector).toBeVisible();

      const dropdown = selector.locator("select");
      const options = dropdown.locator("option");
      await expect(options).toHaveCount(2);

      // First option: current review
      await expect(options.nth(0)).toContainText("Review of test task");
      // Second option: sibling review
      await expect(options.nth(1)).toContainText("Review of test task (cycle 2)");
    });

    // AC: @review-records-web-ui ac-11 — Selecting a revision navigates to it
    test("navigating to a sibling review changes the URL", async ({ page, daemon: _daemon }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      await page.route(
        `**/api/reviews/${SIBLING_ULID}`,
        routeDetailMock({
          ...detail,
          _ulid: SIBLING_ULID,
          slugs: ["test-review-sibling"],
          title: "Review of test task (cycle 2)",
        }),
      );
      await page.route("**/api/reviews?*", routeSiblingsMock(mockSiblingReviews()));
      await page.goto(`/reviews/${REVIEW_ULID}`);

      const selector = page.getByTestId("revision-selector");
      await expect(selector).toBeVisible();

      // Select the sibling review
      const dropdown = selector.locator("select");
      await dropdown.selectOption(SIBLING_ULID);

      // URL should change
      await page.waitForURL(`**/reviews/${SIBLING_ULID}`);
    });

    // AC: @review-records-web-ui ac-11 — No selector when only one review
    test("hides revision selector when only one review exists for subject", async ({
      page,
      daemon: _daemon,
    }) => {
      const detail = mockReviewDetail();
      await page.route(`**/api/reviews/${REVIEW_ULID}`, routeDetailMock(detail));
      // Return only one review in siblings
      await page.route("**/api/reviews?*", (route: any) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [mockSiblingReviews().items[0]],
            total: 1,
            offset: 0,
            limit: 1,
          }),
        });
      });
      await page.goto(`/reviews/${REVIEW_ULID}`);

      // Wait for content to render
      await expect(page.getByTestId("review-title")).toBeVisible();
      // Selector should not be visible
      await expect(page.getByTestId("revision-selector")).not.toBeVisible();
    });
  });

  test.describe("Error Handling", () => {
    test("shows error message when review not found", async ({ page, daemon: _daemon }) => {
      await page.route("**/api/reviews/nonexistent*", (route: any) => {
        route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            error: "not_found",
            message: 'Review "nonexistent" not found',
          }),
        });
      });
      await page.goto("/reviews/nonexistent");

      await expect(page.getByTestId("error-message")).toBeVisible();
    });
  });
});
