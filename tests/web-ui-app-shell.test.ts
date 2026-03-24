/**
 * App Shell and Navigation Tests
 *
 * Static analysis tests for the app shell restructuring.
 * Verifies navigation groups, badge counts, /items redirect,
 * and Observations visibility.
 *
 * Spec: @ui-app-shell
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WEB_UI_SRC = join(process.cwd(), "packages", "web-ui", "src");
const SIDEBAR_PATH = join(WEB_UI_SRC, "lib", "components", "Sidebar.svelte");
const MOBILE_NAV_PATH = join(WEB_UI_SRC, "lib", "components", "MobileNav.svelte");
const ITEMS_REDIRECT_PATH = join(WEB_UI_SRC, "routes", "items", "+page.svelte");
const SPECS_PAGE_PATH = join(WEB_UI_SRC, "routes", "specs", "+page.svelte");
const LAYOUT_PATH = join(WEB_UI_SRC, "routes", "+layout.svelte");

let sidebarSrc = "";
let mobileNavSrc = "";
let itemsRedirectSrc = "";
let specsPageSrc = "";
let layoutSrc = "";

// Load source files
function loadSources() {
  sidebarSrc = readFileSync(SIDEBAR_PATH, "utf-8");
  mobileNavSrc = readFileSync(MOBILE_NAV_PATH, "utf-8");
  itemsRedirectSrc = readFileSync(ITEMS_REDIRECT_PATH, "utf-8");
  specsPageSrc = readFileSync(SPECS_PAGE_PATH, "utf-8");
  layoutSrc = readFileSync(LAYOUT_PATH, "utf-8");
}

loadSources();

// AC: @ui-app-shell ac-1
describe("grouped sidebar navigation (@ui-app-shell ac-1)", () => {
  it("has four navigation groups: Work, Specs, Capture, Config", () => {
    expect(sidebarSrc).toContain("label: 'Work'");
    expect(sidebarSrc).toContain("label: 'Specs'");
    expect(sidebarSrc).toContain("label: 'Capture'");
    expect(sidebarSrc).toContain("label: 'Config'");
  });

  describe("Work group", () => {
    it("contains Dashboard nav item", () => {
      expect(sidebarSrc).toContain("label: 'Dashboard'");
      expect(sidebarSrc).toContain("path: '/'");
    });

    it("contains Tasks nav item", () => {
      expect(sidebarSrc).toContain("label: 'Tasks'");
      expect(sidebarSrc).toContain("path: '/tasks'");
    });

    it("contains Agents nav item", () => {
      expect(sidebarSrc).toContain("label: 'Agents'");
      expect(sidebarSrc).toContain("path: '/agents'");
    });

    it("contains Sessions nav item", () => {
      expect(sidebarSrc).toContain("label: 'Sessions'");
      expect(sidebarSrc).toContain("path: '/sessions'");
    });
  });

  describe("Specs group", () => {
    it("contains Specs nav item", () => {
      expect(sidebarSrc).toContain("label: 'Specs'");
      expect(sidebarSrc).toContain("path: '/specs'");
    });

    it("contains Plans nav item", () => {
      expect(sidebarSrc).toContain("label: 'Plans'");
      expect(sidebarSrc).toContain("path: '/plans'");
    });

    it("contains Validate nav item", () => {
      expect(sidebarSrc).toContain("label: 'Validate'");
      expect(sidebarSrc).toContain("path: '/validate'");
    });
  });

  describe("Capture group", () => {
    it("contains Inbox nav item", () => {
      expect(sidebarSrc).toContain("label: 'Inbox'");
      expect(sidebarSrc).toContain("path: '/inbox'");
    });

    it("contains Observations nav item", () => {
      expect(sidebarSrc).toContain("label: 'Observations'");
      expect(sidebarSrc).toContain("path: '/observations'");
    });

    it("contains Triage nav item", () => {
      expect(sidebarSrc).toContain("label: 'Triage'");
      expect(sidebarSrc).toContain("path: '/triage'");
    });
  });

  describe("Config group", () => {
    it("contains Workflows nav item", () => {
      expect(sidebarSrc).toContain("label: 'Workflows'");
      expect(sidebarSrc).toContain("path: '/workflows'");
    });

    it("contains Settings nav item", () => {
      expect(sidebarSrc).toContain("label: 'Settings'");
      expect(sidebarSrc).toContain("path: '/settings'");
    });
  });

  it("sidebar is collapsible via SidebarRail", () => {
    expect(sidebarSrc).toContain("SidebarRail");
  });

  it("navigation groups are collapsible with toggle buttons", () => {
    expect(sidebarSrc).toContain("toggleGroup");
    expect(sidebarSrc).toContain("collapsedGroups");
  });

  it("uses lucide icons for navigation items", () => {
    expect(sidebarSrc).toContain("lucide-svelte");
    expect(sidebarSrc).toContain("LayoutDashboard");
    expect(sidebarSrc).toContain("ListTodo");
    expect(sidebarSrc).toContain("Bot");
    expect(sidebarSrc).toContain("FileText");
  });

  it("renders icons in nav items with correct sizing", () => {
    expect(sidebarSrc).toContain('class="h-4 w-4"');
  });

  it("all new route pages exist", () => {
    const routes = ["agents", "sessions", "specs", "plans", "validate", "workflows", "settings"];
    for (const route of routes) {
      const routePath = join(WEB_UI_SRC, "routes", route, "+page.svelte");
      expect(existsSync(routePath), `route /${route} should exist`).toBe(true);
    }
  });
});

// AC: @ui-app-shell ac-2
describe("badge counts on nav items (@ui-app-shell ac-2)", () => {
  it("fetches inbox count via TanStack Query", () => {
    expect(sidebarSrc).toContain("fetchInbox");
    expect(sidebarSrc).toContain("inboxCountQuery");
  });

  it("fetches unresolved observations count via TanStack Query", () => {
    expect(sidebarSrc).toContain("fetchObservations");
    expect(sidebarSrc).toContain("observationsCountQuery");
  });

  it("fetches pending review tasks count via TanStack Query", () => {
    expect(sidebarSrc).toContain("fetchTasks");
    expect(sidebarSrc).toContain("pendingReviewCountQuery");
    expect(sidebarSrc).toContain("pending_review");
  });

  it("uses SidebarMenuBadge component for count display", () => {
    expect(sidebarSrc).toContain("SidebarMenuBadge");
  });

  it("assigns badgeKey to Inbox nav item", () => {
    expect(sidebarSrc).toContain("badgeKey: 'inbox'");
  });

  it("assigns badgeKey to Observations nav item", () => {
    expect(sidebarSrc).toContain("badgeKey: 'observations'");
  });

  it("assigns badgeKey to Tasks nav item for pending review", () => {
    expect(sidebarSrc).toContain("badgeKey: 'pendingReview'");
  });

  it("only shows badge when count > 0", () => {
    expect(sidebarSrc).toContain("getBadgeCount(item.badgeKey) > 0");
  });

  it("includes data-testid on badges for testing", () => {
    expect(sidebarSrc).toContain('data-testid="badge-');
  });

  // AC: @ui-data-freshness ac-4 — No polling; uses TanStack Query with WS invalidation
  it("does not use polling intervals", () => {
    expect(sidebarSrc).not.toContain("setInterval");
    expect(sidebarSrc).not.toContain("clearInterval");
  });

  it("uses createQuery for data fetching", () => {
    expect(sidebarSrc).toContain("createQuery");
    expect(sidebarSrc).toContain("queryKeys");
  });

  it("gates queries on project initialization", () => {
    expect(sidebarSrc).toContain("isProjectInitialized()");
  });
});

// AC: @ui-app-shell ac-3
describe("/items to /specs redirect (@ui-app-shell ac-3)", () => {
  it("/items page redirects to /specs", () => {
    expect(itemsRedirectSrc).toContain("goto");
    expect(itemsRedirectSrc).toContain("/specs");
  });

  it("preserves query parameters during redirect", () => {
    expect(itemsRedirectSrc).toContain("$page.url.search");
    expect(itemsRedirectSrc).toContain("queryString");
  });

  it("uses replaceState to avoid back-button loops", () => {
    expect(itemsRedirectSrc).toContain("replaceState: true");
  });

  it("/specs page exists and renders spec items", () => {
    expect(specsPageSrc).toContain("fetchItems");
    expect(specsPageSrc).toContain("ItemTree");
    expect(specsPageSrc).toContain("ItemDetail");
  });

  it("/specs page has loading skeleton state", () => {
    expect(specsPageSrc).toContain("Skeleton");
    expect(specsPageSrc).toContain("{#if loading}");
  });

  it("/specs page has error state", () => {
    expect(specsPageSrc).toContain("error");
    expect(specsPageSrc).toContain('role="alert"');
  });

  it("/specs page supports deep linking via ?ref= param", () => {
    expect(specsPageSrc).toContain("searchParams.get('ref')");
  });
});

// AC: @ui-app-shell ac-4
describe("Observations nav always visible (@ui-app-shell ac-4)", () => {
  it("Observations is a regular nav item, not conditionally rendered", () => {
    // The old sidebar hid observations behind an `if unresolvedObservationsCount > 0` check.
    // The new sidebar includes Observations as a permanent entry in the Capture group.
    expect(sidebarSrc).toContain("path: '/observations'");
    expect(sidebarSrc).toContain("label: 'Observations'");

    // Verify Observations is in the navGroups array (always rendered),
    // not in a conditional block
    const navGroupsSection = sidebarSrc.slice(
      sidebarSrc.indexOf("const navGroups"),
      sidebarSrc.indexOf("];", sidebarSrc.indexOf("const navGroups")) + 2,
    );
    expect(navGroupsSection).toContain("Observations");
  });

  it("Observations badge only shows when count > 0, but item is always visible", () => {
    // Badge is conditional, nav item is not
    expect(sidebarSrc).toContain("badgeKey: 'observations'");
    // The getBadgeCount check gates the badge, not the nav item
    expect(sidebarSrc).toContain("getBadgeCount(item.badgeKey) > 0");
  });
});

// Additional: layout structure
describe("layout structure", () => {
  it("imports and renders Sidebar component", () => {
    expect(layoutSrc).toContain("import Sidebar");
    expect(layoutSrc).toContain("<Sidebar />");
  });

  it("imports and renders MobileNav component", () => {
    expect(layoutSrc).toContain("import MobileNav");
    expect(layoutSrc).toContain("<MobileNav />");
  });

  it("uses SidebarProvider for layout context", () => {
    expect(layoutSrc).toContain("SidebarProvider");
    expect(layoutSrc).toContain("SidebarInset");
  });

  it("hides desktop sidebar on mobile", () => {
    expect(layoutSrc).toContain('class="hidden md:block"');
  });
});
