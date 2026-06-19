import { test, expect } from "./fixtures/test-base";

const OPEN_REVIEW_ULID = "01KKTX0CA45ZT43W2T6HJMVA01";
const DRAFT_REVIEW_ULID = "01KKTX9CA45ZT43W2T6HJMVA10";
const CODE_REVIEW_ULID = "01KKV1ACA45ZT43W2T6HJMVB10";

test.describe("Review Detail Page", () => {
  // AC: @review-records-web-ui ac-2
  // AC: @review-records-web-ui ac-8
  // AC: @review-records-web-ui ac-9
  // AC: @review-records-web-ui ac-11
  // AC: @ui-view-header ac-6 — review detail presents the standard view header
  test("renders review details, markdown thread bodies, and review-pass selector", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto(`/reviews/${OPEN_REVIEW_ULID}`);

    await expect(page.getByTestId("review-header")).toBeVisible();
    // AC: @ui-view-header ac-6 — the standard ViewHeader is the review header's chrome
    await expect(page.getByTestId("review-header").getByTestId("view-header")).toBeVisible();
    await expect(page.getByTestId("review-title")).toHaveText("Review of test task");
    await expect(page.getByTestId("review-disposition-badge")).toContainText("Changes Requested");
    await expect(page.getByTestId("review-lifecycle-badge")).toBeVisible();
    // Child counts (threads/checks/verdicts) come from the server-resolved detail payload.
    await expect(page.getByTestId("view-header-count-threads")).toBeVisible();

    await expect(page.getByTestId("revision-selector")).toBeVisible();
    const reviewPassSelect = page.locator("#revision-select");
    await expect(page.getByText("Review pass:")).toBeVisible();
    await expect(reviewPassSelect.locator("option")).toHaveCount(2);

    const firstThread = page.getByTestId("thread-item").first();
    await expect(firstThread.getByTestId("thread-kind-badge")).toContainText("Blocker");
    await expect(firstThread.getByTestId("thread-status")).toContainText("Open");

    const markdownThread = page.locator('[data-thread-id="01KKV0RCA45ZT43W2T6HJMVB01"]');
    await expect(markdownThread).toBeVisible();
    await expect(markdownThread.locator('[data-testid="entry-body"] strong')).toContainText(
      "critical bug",
    );
    await expect(markdownThread.locator('[data-testid="entry-body"] p code').first()).toContainText(
      "validateInput()",
    );
    await expect(markdownThread.locator('[data-testid="entry-body"] pre code')).toContainText(
      "return null;",
    );
    await expect(markdownThread.locator('[data-testid="entry-body"] a')).toHaveAttribute(
      "href",
      "https://example.com",
    );

    const entry = firstThread.getByTestId("thread-entry").first();
    await expect(entry.getByTestId("entry-author")).toContainText("reviewer@test.com");
    await expect(entry.getByTestId("entry-timestamp")).not.toBeEmpty();

    await expect(page.getByTestId("check-item")).toHaveCount(3);
    await expect(page.getByTestId("check-stale-badge")).toContainText("Stale");
    await expect(page.getByTestId("verdict-item")).toHaveCount(1);

    // AC: @ui-breadcrumb ac-9 — the detail page leads with the adaptive breadcrumb
    // (the ad-hoc "Back to Reviews" link was replaced); the current segment is the review.
    await expect(page.getByTestId("breadcrumb")).toBeVisible();
    await expect(page.getByTestId("breadcrumb-current")).toContainText("Review of test task");

    // Compare list/detail status-token parity by navigating to the reviews list.
    await page.goto("/reviews");
    await expect(page.getByRole("heading", { name: "Reviews" })).toBeVisible();

    // AC: @ui-view-header ac-2 — the list disposition/lifecycle badges draw from the
    // same shared status-token source as the detail header (one token per state on
    // every surface), not bespoke list-only Badge helpers.
    const listRow = page.locator('[data-review-ref="test-review-open"]');
    const listDisposition = listRow.getByTestId("review-disposition-badge");
    await expect(listDisposition).toHaveAttribute("data-status-domain", "review-disposition");
    await expect(listDisposition).toHaveAttribute("data-status-state", "changes_requested");
    await expect(listDisposition).toContainText("Changes Requested");
    await expect(listRow.getByTestId("review-lifecycle-badge")).toHaveAttribute(
      "data-status-domain",
      "review-lifecycle",
    );
  });

  // AC: @review-records-web-ui ac-10
  test("shows empty states when review has no threads, checks, or verdicts", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto(`/reviews/${DRAFT_REVIEW_ULID}`);

    await expect(page.getByTestId("threads-empty")).toContainText("No threads yet");
    await expect(page.getByTestId("checks-empty")).toContainText("No checks recorded");
    await expect(page.getByTestId("verdicts-empty")).toContainText("No verdicts yet");
    await expect(page.getByTestId("revision-selector")).toHaveCount(0);
  });

  // AC: @review-records-web-ui ac-11 — code-review pass grouping uses head_branch
  test("limits code review passes to the same head branch", async ({ page, daemon: _daemon }) => {
    await page.goto(`/reviews/${CODE_REVIEW_ULID}`);

    const reviewPassSelect = page.locator("#revision-select");
    await expect(reviewPassSelect).toBeVisible();
    await expect(reviewPassSelect.locator("option")).toHaveCount(2);
    await expect(reviewPassSelect.locator("option").nth(0)).toContainText(
      "Code review for feat/review-detail",
    );
    await expect(reviewPassSelect.locator("option").nth(1)).toContainText(
      "Code review for feat/review-detail (cycle 2)",
    );
  });
});
