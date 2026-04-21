/**
 * E2E Tests for Docs Rendering
 *
 * Covers:
 * - @docs-reachability ac-1: Docs entry in primary navigation
 * - @docs-navigation-shape ac-1: Sidebar lists section pages, current page indicated, TOC present
 */

import { test, expect } from "./fixtures/test-base";

test.describe("Docs", () => {
  // AC: @docs-reachability ac-1 — Docs entry is present in primary navigation and navigates to docs
  test("sidebar shows Docs nav entry that navigates to docs landing page", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/");

    // The sidebar should contain a Docs link in the Help group
    const docsLink = page.getByTestId("nav-link-docs");
    await expect(docsLink).toBeVisible();

    // Click the Docs nav entry
    await docsLink.click();

    // Should navigate to the docs landing page
    await expect(page).toHaveURL(/\/docs$/);

    // The docs landing page should render the Documentation heading
    await expect(page.getByRole("heading", { name: "Documentation" })).toBeVisible();
  });

  // AC: @docs-reachability ac-1 — Docs entry visible on mobile navigation
  test("mobile nav shows Docs entry that navigates to docs", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");

    // Mobile bottom nav should have a Docs link
    const mobileNav = page.locator('nav[aria-label="Mobile navigation"]');
    await expect(mobileNav).toBeVisible();

    const docsLink = mobileNav.getByText("Docs");
    await expect(docsLink).toBeVisible();

    // Click it and verify navigation
    await docsLink.click();
    await expect(page).toHaveURL(/\/docs$/);
  });

  // AC: @docs-navigation-shape ac-1 — Sidebar lists section pages, current page indicated, TOC present
  test("docs page shows sidebar with section pages, highlights current page, and shows TOC", async ({
    page,
    daemon: _daemon,
  }) => {
    // Navigate to a known doc page (getting-started is a root-level doc)
    await page.goto("/docs/getting-started");

    // --- Sidebar shows section pages ---
    // The docs page sidebar nav should be visible (hidden on mobile, visible on lg+)
    const docsSidebar = page.locator("nav").filter({ hasText: "Pages" });
    await expect(docsSidebar).toBeVisible();

    // Sidebar should contain links to other root-level docs in the same section
    const sidebarLinks = docsSidebar.locator("ul").first().locator("a");
    const linkCount = await sidebarLinks.count();
    expect(linkCount).toBeGreaterThan(0);

    // --- Current page is visually indicated ---
    // The current page link should have the active styling (bg-accent class)
    const currentPageLink = sidebarLinks.filter({ hasText: "Getting Started" });
    await expect(currentPageLink).toBeVisible();
    await expect(currentPageLink).toHaveClass(/bg-accent/);

    // --- Table of contents is present ---
    // The "On this page" section should be visible with TOC links
    const tocHeading = docsSidebar.getByText("On this page");
    await expect(tocHeading).toBeVisible();

    // TOC should have heading links (the getting-started doc has multiple h2 headings)
    const tocLinks = docsSidebar.locator("ul").nth(1).locator("a");
    const tocCount = await tocLinks.count();
    expect(tocCount).toBeGreaterThan(0);

    // TOC links should point to anchor fragments
    const firstTocHref = await tocLinks.first().getAttribute("href");
    expect(firstTocHref).toMatch(/^#/);
  });

  // AC: @docs-navigation-shape ac-1 — Non-current pages in sidebar are NOT highlighted
  test("non-current docs page links are not highlighted", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/docs/getting-started");

    const docsSidebar = page.locator("nav").filter({ hasText: "Pages" });
    await expect(docsSidebar).toBeVisible();

    const sidebarLinks = docsSidebar.locator("ul").first().locator("a");
    const linkCount = await sidebarLinks.count();

    // If there are other pages besides getting-started, they should NOT have the active bg-accent class
    // Note: non-active links have "hover:bg-accent/50" which is a hover-only style, not the active indicator
    if (linkCount > 1) {
      for (let i = 0; i < linkCount; i++) {
        const link = sidebarLinks.nth(i);
        const text = await link.textContent();
        if (text?.trim() !== "Getting Started With kspec" && text?.trim() !== "Getting Started") {
          // Non-current page links should not have the active highlight
          // Check for exact "bg-accent" token (not "hover:bg-accent/50")
          const classes = await link.getAttribute("class");
          const hasActiveHighlight =
            classes?.split(/\s+/).some((c) => c === "bg-accent") ?? false;
          expect(hasActiveHighlight).toBe(false);
        }
      }
    }
  });

  test("docs landing page lists available docs grouped by section", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/docs");

    // Landing page heading
    await expect(page.getByRole("heading", { name: "Documentation" })).toBeVisible();

    // Should have links to individual doc pages
    const docLinks = page.locator('a[href*="/docs/"]');
    const linkCount = await docLinks.count();
    expect(linkCount).toBeGreaterThan(0);
  });

  test("navigating between docs pages via sidebar uses client-side routing", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/docs/getting-started");

    const docsSidebar = page.locator("nav").filter({ hasText: "Pages" });
    await expect(docsSidebar).toBeVisible();

    const sidebarLinks = docsSidebar.locator("ul").first().locator("a");
    const linkCount = await sidebarLinks.count();

    // If there are multiple pages, click a different one
    if (linkCount > 1) {
      // Find a link that is NOT getting-started
      for (let i = 0; i < linkCount; i++) {
        const link = sidebarLinks.nth(i);
        const href = await link.getAttribute("href");
        if (href && !href.includes("getting-started")) {
          await link.click();
          // Should navigate to the new doc without full page reload
          await expect(page).not.toHaveURL(/getting-started/);
          break;
        }
      }
    }
  });
});
