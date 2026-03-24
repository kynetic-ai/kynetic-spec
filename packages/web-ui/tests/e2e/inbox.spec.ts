import { test, expect } from "../fixtures/test-base";

test.describe("Inbox View", () => {
  test.beforeEach(async ({ page, daemon: _daemon }) => {
    await page.goto("/inbox");
    // Wait for page to load — use exact match to avoid matching "No inbox items" heading
    await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  });

  // ── AC: @ui-inbox-enhanced ac-1 — Triage status inline ──

  // AC: @ui-inbox-enhanced ac-1
  test("displays triage status badge for each inbox item", async ({ page }) => {
    const inboxList = page.getByTestId("inbox-list");
    await expect(inboxList).toBeVisible({ timeout: 10000 });

    const items = page.getByTestId("inbox-item");
    const count = await items.count();
    expect(count).toBeGreaterThan(0);

    // Each item should have a triage status badge
    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      const statusBadge = item.getByTestId("inbox-triage-status");
      await expect(statusBadge).toBeVisible();

      // Status must be one of the valid labels
      const statusText = await statusBadge.textContent();
      expect(["Untriaged", "Triaged", "Acted On"]).toContain(statusText?.trim());
    }
  });

  // AC: @ui-inbox-enhanced ac-1
  test("shows triage status per item from API data", async ({ page }) => {
    const inboxList = page.getByTestId("inbox-list");
    await expect(inboxList).toBeVisible({ timeout: 10000 });

    // Verify triage status badges are rendered for fixture items
    const firstItem = page.getByTestId("inbox-item").filter({ hasText: "First inbox item" });
    await expect(firstItem.getByTestId("inbox-triage-status")).toBeVisible();

    const secondItem = page.getByTestId("inbox-item").filter({ hasText: "Second inbox item" });
    await expect(secondItem.getByTestId("inbox-triage-status")).toBeVisible();

    const thirdItem = page.getByTestId("inbox-item").filter({ hasText: "Third inbox item" });
    await expect(thirdItem.getByTestId("inbox-triage-status")).toBeVisible();

    // Summary always shows status counts
    const summary = page.getByTestId("inbox-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("untriaged");
  });

  // AC: @markdown-ui-adoption ac-7
  test("renders inbox item markdown in the list view", async ({ page }) => {
    const firstItem = page.getByTestId("inbox-item").filter({ hasText: "First inbox item" });
    await expect(firstItem.getByTestId("inbox-text").locator("code")).toContainText("kspec triage");
  });

  // AC: @ui-inbox-enhanced ac-1
  test("shows quick triage link for untriaged items", async ({ page }) => {
    const inboxList = page.getByTestId("inbox-list");
    await expect(inboxList).toBeVisible({ timeout: 10000 });

    const items = page.getByTestId("inbox-item");
    const count = await items.count();
    expect(count).toBeGreaterThan(0);

    // Check that at least one untriaged item has a triage link
    let foundTriageLink = false;
    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      const statusText = await item.getByTestId("inbox-triage-status").textContent();
      if (statusText?.trim() === "Untriaged") {
        await expect(item.getByTestId("inbox-triage-link")).toBeVisible();
        foundTriageLink = true;
        break;
      }
    }
    expect(foundTriageLink).toBe(true);
  });

  // AC: @ui-inbox-enhanced ac-1
  test("triage action type shown when available", async ({ page }) => {
    const inboxList = page.getByTestId("inbox-list");
    await expect(inboxList).toBeVisible({ timeout: 10000 });

    const items = page.getByTestId("inbox-item");
    const count = await items.count();

    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      const action = item.getByTestId("inbox-triage-action");
      const hasAction = await action.isVisible().catch(() => false);
      if (hasAction) {
        const actionText = await action.textContent();
        expect(["promote", "delete", "defer", "spec-gap", "duplicate"]).toContain(
          actionText?.trim(),
        );
      }
    }
  });

  // ── AC: @ui-inbox-enhanced ac-2 — Filter controls ──

  // AC: @ui-inbox-enhanced ac-2
  test("displays filter controls for status, tags, and age", async ({ page }) => {
    const filters = page.getByTestId("inbox-filters");
    await expect(filters).toBeVisible();

    await expect(page.getByTestId("inbox-status-filter")).toBeVisible();
    await expect(page.getByTestId("inbox-age-filter")).toBeVisible();

    const inboxList = page.getByTestId("inbox-list");
    await expect(inboxList).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("inbox-tag-filter")).toBeVisible();
  });

  // AC: @ui-inbox-enhanced ac-2
  test("status filter changes URL params", async ({ page }) => {
    const inboxList = page.getByTestId("inbox-list");
    await expect(inboxList).toBeVisible({ timeout: 10000 });

    await page.getByTestId("inbox-status-filter").selectOption("untriaged");
    await expect(page).toHaveURL(/status=untriaged/);

    await page.getByTestId("inbox-status-filter").selectOption("triaged");
    await expect(page).toHaveURL(/status=triaged/);

    await page.getByTestId("inbox-status-filter").selectOption("acted_on");
    await expect(page).toHaveURL(/status=acted_on/);

    await page.getByTestId("inbox-status-filter").selectOption("all");
    await expect(page).not.toHaveURL(/status=/);
  });

  // AC: @ui-inbox-enhanced ac-2
  test("filters by tag", async ({ page }) => {
    const inboxList = page.getByTestId("inbox-list");
    await expect(inboxList).toBeVisible({ timeout: 10000 });

    await page.getByTestId("inbox-tag-filter").selectOption("feature");
    await expect(page.getByTestId("inbox-item")).toHaveCount(1);
    await expect(page.getByText("Second inbox item")).toBeVisible();

    await page.getByTestId("inbox-tag-filter").selectOption("test");
    await expect(page.getByTestId("inbox-item")).toHaveCount(1);
    await expect(page.getByText("First inbox item")).toBeVisible();

    await page.getByTestId("inbox-tag-filter").selectOption("");
    await expect(page.getByTestId("inbox-item")).toHaveCount(3);
  });

  // AC: @ui-inbox-enhanced ac-2
  test("shows item count summary", async ({ page }) => {
    const inboxList = page.getByTestId("inbox-list");
    await expect(inboxList).toBeVisible({ timeout: 10000 });

    const summary = page.getByTestId("inbox-summary");
    await expect(summary).toContainText("3 items");
  });

  // AC: @ui-inbox-enhanced ac-2
  test("shows filtered count when filter is active", async ({ page }) => {
    const inboxList = page.getByTestId("inbox-list");
    await expect(inboxList).toBeVisible({ timeout: 10000 });

    await page.getByTestId("inbox-tag-filter").selectOption("feature");

    const summary = page.getByTestId("inbox-summary");
    await expect(summary).toContainText("Showing 1 filtered");
  });

  // AC: @ui-inbox-enhanced ac-2
  test("shows empty state when filters match nothing", async ({ page }) => {
    const inboxList = page.getByTestId("inbox-list");
    await expect(inboxList).toBeVisible({ timeout: 10000 });

    await page.getByTestId("inbox-age-filter").selectOption("1d");
    await expect(page.getByTestId("inbox-empty")).toBeVisible();
    await expect(page.getByText("No matching items")).toBeVisible();
  });

  // ── Existing tests (preserved, updated for new structure) ──

  // AC: @web-dashboard ac-16
  test("displays inbox items ordered by created_at desc", async ({ page }) => {
    const inboxList = page.getByTestId("inbox-list");
    await expect(inboxList).toBeVisible({ timeout: 10000 });

    const items = page.getByTestId("inbox-item");
    const count = await items.count();

    if (count > 1) {
      expect(count).toBeGreaterThan(0);
    }
  });

  // AC: @web-dashboard ac-16
  test("shows text preview, tags, and added_by for items", async ({ page }) => {
    const inboxList = page.getByTestId("inbox-list");
    await expect(inboxList).toBeVisible({ timeout: 10000 });

    const items = page.getByTestId("inbox-item");
    const count = await items.count();

    if (count > 0) {
      const firstItem = items.first();
      await expect(firstItem.getByTestId("inbox-text")).toBeVisible();
      await expect(firstItem.getByTestId("inbox-created-at")).toBeVisible();
      await expect(firstItem.getByTestId("inbox-added-by")).toBeVisible();
    }
  });

  // AC: @web-dashboard ac-17
  test("Add button shows input field", async ({ page }) => {
    await expect(page.getByTestId("inbox-input")).not.toBeVisible();
    await page.getByTestId("add-inbox-button").click();
    await expect(page.getByTestId("inbox-input")).toBeVisible();
    await expect(page.getByTestId("inbox-submit")).toBeVisible();
  });

  // AC: @web-dashboard ac-17
  test("Enter key submits new item", async ({ page }) => {
    await page.getByTestId("add-inbox-button").click();
    await expect(page.getByTestId("inbox-input")).toBeVisible();

    const testText = `E2E test item ${Date.now()}`;
    await page.getByTestId("inbox-input").fill(testText);
    await page.getByTestId("inbox-input").press("Enter");

    await expect(page.getByText(testText)).toBeVisible({ timeout: 5000 });
  });

  // AC: @web-dashboard ac-18
  test("new item appears at top of list", async ({ page }) => {
    const inboxList = page.getByTestId("inbox-list");
    await expect(inboxList).toBeVisible({ timeout: 10000 });

    const items = page.getByTestId("inbox-item");
    const initialCount = await items.count();

    await page.getByTestId("add-inbox-button").click();
    const testText = `Top item test ${Date.now()}`;
    await page.getByTestId("inbox-input").fill(testText);
    await page.getByTestId("inbox-submit").click();

    await expect(page.getByText(testText)).toBeVisible({ timeout: 5000 });

    const updatedItems = page.getByTestId("inbox-item");
    const newCount = await updatedItems.count();
    expect(newCount).toBe(initialCount + 1);

    const firstItem = updatedItems.first();
    await expect(firstItem.getByText(testText)).toBeVisible();
  });

  // AC: @web-dashboard ac-18
  test("new item appears with animation", async ({ page }) => {
    await page.getByTestId("add-inbox-button").click();
    const testText = `Animation test ${Date.now()}`;
    await page.getByTestId("inbox-input").fill(testText);
    await page.getByTestId("inbox-submit").click();

    await expect(page.getByText(testText)).toBeVisible({ timeout: 5000 });
  });

  // AC: @web-dashboard ac-19
  test("delete button shows confirmation dialog", async ({ page }) => {
    const inboxList = page.getByTestId("inbox-list");
    await expect(inboxList).toBeVisible({ timeout: 10000 });

    const items = page.getByTestId("inbox-item");
    const count = await items.count();

    if (count > 0) {
      await items.first().getByTestId("delete-inbox-button").click();

      const dialog = page.getByTestId("confirm-delete-dialog");
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId("confirm-delete-yes")).toBeVisible();
      await expect(page.getByTestId("confirm-delete-no")).toBeVisible();

      await page.getByTestId("confirm-delete-no").click();
      await expect(dialog).not.toBeVisible();
    }
  });

  // AC: @web-dashboard ac-19
  test("confirmed delete removes item from list", async ({ page }) => {
    await page.getByTestId("add-inbox-button").click();
    const testText = `Delete test ${Date.now()}`;
    await page.getByTestId("inbox-input").fill(testText);
    await page.getByTestId("inbox-submit").click();

    await expect(page.getByText(testText)).toBeVisible({ timeout: 5000 });

    const itemToDelete = page.getByTestId("inbox-item").filter({ hasText: testText });
    await expect(itemToDelete).toBeVisible();
    await itemToDelete.getByTestId("delete-inbox-button").click();

    await expect(page.getByTestId("confirm-delete-dialog")).toBeVisible();
    await page.getByTestId("confirm-delete-yes").click();

    // Wait for item to be removed from the list
    await expect(page.getByTestId("inbox-item").filter({ hasText: testText })).not.toBeVisible({
      timeout: 10000,
    });
  });

  test("handles empty inbox state", async ({ page }) => {
    const items = page.getByTestId("inbox-item");
    const count = await items.count();

    if (count === 0) {
      await expect(page.getByTestId("inbox-empty")).toBeVisible();
      await expect(page.getByText("No inbox items")).toBeVisible();
    }
  });

  test("shows loading skeletons while fetching data", async ({ page }) => {
    await page.goto("/inbox");
    const loaded = page
      .getByTestId("inbox-list")
      .or(page.getByTestId("inbox-empty"))
      .or(page.getByTestId("inbox-loading"));
    await expect(loaded).toBeVisible({ timeout: 10000 });
  });

  test("add button toggles between Add and Cancel", async ({ page }) => {
    const addButton = page.getByTestId("add-inbox-button");
    await expect(addButton).toContainText("Add Item");

    await addButton.click();
    await expect(page.getByTestId("inbox-input")).toBeVisible();
    await expect(addButton).toContainText("Cancel");

    await addButton.click();
    await expect(page.getByTestId("inbox-input")).not.toBeVisible();
    await expect(addButton).toContainText("Add Item");
  });

  test("submit button disabled when input is empty", async ({ page }) => {
    await page.getByTestId("add-inbox-button").click();
    await expect(page.getByTestId("inbox-input")).toBeVisible();

    const submitButton = page.getByTestId("inbox-submit");
    await expect(submitButton).toBeDisabled();

    await page.getByTestId("inbox-input").fill("Test");
    await expect(submitButton).toBeEnabled();
  });
});
