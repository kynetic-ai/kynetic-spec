import { test, expect } from "./fixtures/test-base";

test.describe("Command Palette / Search", () => {
  test.beforeEach(async ({ page, daemon: _daemon }) => {
    await page.goto("/");
    // Wait for SvelteKit hydration — desktop nav testids appear once the app shell is interactive.
    await expect(page.getByTestId("nav-link-tasks")).toBeVisible({ timeout: 10000 });
  });

  /** Helper: open the command palette using the platform-appropriate shortcut */
  async function openPalette(page: import("@playwright/test").Page) {
    await page.keyboard.press("Control+k");
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible();
    return palette;
  }

  /**
   * Helper: open palette, search for a term, and wait for actual search results
   * to appear in the DOM. This ensures the debounce timer has fired, the API
   * request has completed, and results have rendered.
   */
  async function searchAndWaitForResults(page: import("@playwright/test").Page, query: string) {
    await openPalette(page);
    const input = page.getByTestId("command-palette-input");
    await input.fill(query);
    // Wait for at least one search result item to appear — this proves
    // debounce fired, API responded, and results rendered
    await expect(page.getByTestId("search-result-item").first()).toBeVisible({
      timeout: 5000,
    });
  }

  test.describe("Keyboard Shortcuts", () => {
    // AC: @web-dashboard ac-23
    // AC: @ui-shortcut-registry ac-3 — the platform's conventional primary modifier resolves the chord
    test("opens with Cmd+K on Mac", async ({ page }) => {
      // The central registry resolves the palette's primary modifier per
      // platform (Cmd on macOS, Ctrl elsewhere), so this test must actually
      // emulate macOS for Meta+K to resolve. Override navigator.platform before
      // the bundle loads, then reload so the registry detects "mac".
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "platform", {
          configurable: true,
          get: () => "MacIntel",
        });
      });
      await page.reload();
      await expect(page.getByTestId("nav-link-tasks")).toBeVisible({ timeout: 10000 });

      await page.keyboard.press("Meta+k");

      const palette = page.getByTestId("command-palette");
      await expect(palette).toBeVisible({ timeout: 5000 });

      const input = page.getByTestId("command-palette-input");
      await expect(input).toBeVisible();
    });

    // AC: @web-dashboard ac-23
    test("opens with Ctrl+K on Windows/Linux", async ({ page }) => {
      await page.keyboard.press("Control+k");

      const palette = page.getByTestId("command-palette");
      await expect(palette).toBeVisible({ timeout: 5000 });

      const input = page.getByTestId("command-palette-input");
      await expect(input).toBeVisible();
    });

    // AC: @web-dashboard ac-23
    test("closes when pressing Cmd+K again", async ({ page }) => {
      const palette = await openPalette(page);

      // Close palette by pressing shortcut again
      await page.keyboard.press("Control+k");
      await expect(palette).not.toBeVisible();
    });

    // AC: @web-dashboard ac-23
    test("shows placeholder text in search input", async ({ page }) => {
      await openPalette(page);

      const input = page.getByTestId("command-palette-input");
      await expect(input).toHaveAttribute("placeholder", /search/i);
    });
  });

  test.describe("Search Functionality", () => {
    // AC: @web-dashboard ac-24
    test("debounces search by 300ms", async ({ page }) => {
      // Track when the search API request fires
      let searchRequestTimestamp = 0;
      await page.route("**/api/search*", async (route) => {
        searchRequestTimestamp = Date.now();
        await route.continue();
      });

      await openPalette(page);

      const input = page.getByTestId("command-palette-input");
      await expect(input).toBeVisible();

      const fillTimestamp = Date.now();
      await input.fill("test");

      // Wait for actual search results to appear — this proves the debounce
      // timer fired and the API returned results
      await expect(page.getByTestId("search-result-item").first()).toBeVisible({
        timeout: 5000,
      });

      // Verify the search request was delayed by at least ~250ms (debounce is 300ms,
      // allow some tolerance for timing)
      expect(searchRequestTimestamp).toBeGreaterThan(0);
      expect(searchRequestTimestamp - fillTimestamp).toBeGreaterThanOrEqual(250);
    });

    // AC: @web-dashboard ac-24
    test("shows loading state during search", async ({ page }) => {
      // Delay the search API response to ensure the loading state is visible
      await page.route("**/api/search*", async (route) => {
        await new Promise((r) => setTimeout(r, 500));
        await route.continue();
      });

      await openPalette(page);

      const input = page.getByTestId("command-palette-input");
      await input.fill("test");

      // The CommandPalette sets loading=true immediately on input, then renders
      // <Command.Loading>Searching...</Command.Loading> — verify it appears
      await expect(page.getByText("Searching...")).toBeVisible({ timeout: 2000 });
    });

    // AC: @web-dashboard ac-24
    test("shows no results message for non-matching query", async ({ page }) => {
      await openPalette(page);

      const input = page.getByTestId("command-palette-input");
      await input.fill("xyzabc123nonexistent987");

      // Wait for debounce + API response, then Command.Empty renders "No results found."
      await expect(page.getByText("No results found.")).toBeVisible({
        timeout: 5000,
      });
    });

    // AC: @web-dashboard ac-24
    test("groups results by type (tasks, items, inbox)", async ({ page }) => {
      // Search for "test" — matches tasks (test-task-*), items (test-feature, etc.),
      // and inbox items (tagged "test") in the fixture data
      await searchAndWaitForResults(page, "test");

      // Verify results are grouped — fixture data has both tasks and spec items
      // matching "test", so both group headings should be visible.
      await expect(page.getByTestId("search-group-task")).toBeVisible();
      await expect(page.getByTestId("search-group-item")).toBeVisible();
    });

    // AC: @web-dashboard ac-24
    test("clears results when search input is cleared", async ({ page }) => {
      // First get results
      await searchAndWaitForResults(page, "test");

      const input = page.getByTestId("command-palette-input");
      await input.clear();

      // After clearing, result items should disappear (query is empty → results=[])
      await expect(page.getByTestId("search-result-item")).toHaveCount(0, {
        timeout: 2000,
      });
    });
  });

  test.describe("Navigation", () => {
    // AC: @web-dashboard ac-25
    test("clicking result navigates to detail view", async ({ page }) => {
      await searchAndWaitForResults(page, "test");

      const firstResult = page.getByTestId("search-result-item").first();
      await firstResult.click();

      // Palette should close after selection
      const palette = page.getByTestId("command-palette");
      await expect(palette).not.toBeVisible({ timeout: 2000 });

      // URL should have changed to a detail view route.
      // /items redirects to /specs, so include both in the pattern.
      await page.waitForURL(/\/(tasks|items|specs|inbox|observations|meta)/);
    });

    // AC: @web-dashboard ac-25
    test("navigation includes query parameter for selected item", async ({ page }) => {
      await searchAndWaitForResults(page, "test");

      const firstResult = page.getByTestId("search-result-item").first();
      await firstResult.click();

      // Wait for navigation to complete — URL should contain selected= query param
      await page.waitForURL(/selected=/);
      expect(page.url()).toContain("selected=");
    });

    // AC: @web-dashboard ac-25
    test("palette resets state after navigation", async ({ page }) => {
      await searchAndWaitForResults(page, "test");

      const firstResult = page.getByTestId("search-result-item").first();
      await firstResult.click();

      // Wait for palette to close
      const palette = page.getByTestId("command-palette");
      await expect(palette).not.toBeVisible();

      // Open palette again
      await page.keyboard.press("Control+k");
      await expect(palette).toBeVisible();

      // Input should be cleared (handleSelect resets query to '')
      const inputValue = await page.getByTestId("command-palette-input").inputValue();
      expect(inputValue).toBe("");
    });
  });

  test.describe("Accessibility", () => {
    // AC: @web-dashboard ac-23
    test("dialog has proper ARIA attributes", async ({ page }) => {
      await openPalette(page);

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
    });

    // AC: @web-dashboard ac-24, ac-25
    test("search results are keyboard navigable", async ({ page }) => {
      await searchAndWaitForResults(page, "test");

      // Press down arrow to navigate results
      await page.keyboard.press("ArrowDown");

      // The cmdk component should highlight the first result via aria-selected
      const selectedItem = page.locator('[data-testid="search-result-item"][aria-selected="true"]');
      await expect(selectedItem).toBeVisible({ timeout: 2000 });
    });

    // AC: @web-dashboard ac-23
    test("Escape key closes palette", async ({ page }) => {
      const palette = await openPalette(page);

      // Press Escape
      await page.keyboard.press("Escape");

      // Palette should close
      await expect(palette).not.toBeVisible();
    });
  });
});
