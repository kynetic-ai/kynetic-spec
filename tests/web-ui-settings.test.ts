/**
 * Settings Page Static Analysis Tests
 *
 * Verifies the settings page has proper structure: data-testid attributes,
 * required UI elements, loading/empty/error states, and AC annotations.
 *
 * AC: @ui-settings-view ac-1 — Displays project config (name, version, remote tracking),
 * conventions list from meta, daemon connection info (port, uptime, version), and shadow
 * branch status. Read-only for v1.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WEB_UI_SRC = join(process.cwd(), "packages", "web-ui", "src");
const SETTINGS_PAGE = join(WEB_UI_SRC, "routes", "settings", "+page.svelte");
const SETTINGS_PAGE_TS = join(WEB_UI_SRC, "routes", "settings", "+page.ts");
const API_CLIENT = join(WEB_UI_SRC, "lib", "api.ts");

let pageSrc = "";
let pageTs = "";
let apiSrc = "";

function loadSources() {
  pageSrc = readFileSync(SETTINGS_PAGE, "utf-8");
  pageTs = readFileSync(SETTINGS_PAGE_TS, "utf-8");
  apiSrc = readFileSync(API_CLIENT, "utf-8");
}

loadSources();

// AC: @ui-settings-view ac-1
describe("settings page structure (@ui-settings-view ac-1)", () => {
  it("page file exists", () => {
    expect(existsSync(SETTINGS_PAGE)).toBe(true);
  });

  it("disables SSR", () => {
    expect(pageTs).toContain("export const ssr = false");
  });

  it("imports settings API functions from api", () => {
    expect(pageSrc).toContain("fetchHealth");
    expect(pageSrc).toContain("fetchProjectConfig");
    expect(pageSrc).toContain("fetchShadowStatus");
    expect(pageSrc).toContain("fetchConventions");
    expect(pageSrc).toContain("from '$lib/api'");
  });

  it("imports Convention type from shared", () => {
    expect(pageSrc).toContain("Convention");
    expect(pageSrc).toContain("@kynetic-ai/shared");
  });

  it("uses Svelte 5 runes for state", () => {
    expect(pageSrc).toContain("$state");
    expect(pageSrc).toContain("$derived");
    expect(pageSrc).not.toMatch(/\$:\s/); // No Svelte 4 reactive declarations
  });
});

// AC: @ui-settings-view ac-1 — project config section
describe("project configuration section (@ui-settings-view ac-1)", () => {
  it("has project config card", () => {
    expect(pageSrc).toContain('data-testid="settings-project-config"');
  });

  it("shows project name", () => {
    expect(pageSrc).toContain('data-testid="config-project-name"');
    expect(pageSrc).toContain("projectConfig.project?.name");
  });

  it("shows project version", () => {
    expect(pageSrc).toContain('data-testid="config-project-version"');
    expect(pageSrc).toContain("projectConfig.project?.version");
  });

  it("shows remote tracking", () => {
    expect(pageSrc).toContain('data-testid="config-remote-tracking"');
    expect(pageSrc).toContain("projectConfig.remote_tracking");
  });

  it("shows spec version", () => {
    expect(pageSrc).toContain('data-testid="config-spec-version"');
    expect(pageSrc).toContain("projectConfig.spec_version");
  });

  it("shows root directory", () => {
    expect(pageSrc).toContain('data-testid="config-root-dir"');
    expect(pageSrc).toContain("projectConfig.root_dir");
  });
});

// AC: @ui-settings-view ac-1 — daemon connection section
describe("daemon connection section (@ui-settings-view ac-1)", () => {
  it("has daemon card", () => {
    expect(pageSrc).toContain('data-testid="settings-daemon"');
  });

  it("shows daemon status indicator", () => {
    expect(pageSrc).toContain('data-testid="daemon-status"');
    expect(pageSrc).toContain("Connected");
    expect(pageSrc).toContain("Disconnected");
  });

  it("shows daemon version", () => {
    expect(pageSrc).toContain('data-testid="daemon-version"');
    expect(pageSrc).toContain("health.version");
  });

  it("shows daemon uptime", () => {
    expect(pageSrc).toContain('data-testid="daemon-uptime"');
    expect(pageSrc).toContain("formatUptime");
  });

  it("shows daemon port", () => {
    expect(pageSrc).toContain('data-testid="daemon-port"');
    expect(pageSrc).toContain("projectConfig.daemon.port");
  });

  it("shows active connections", () => {
    expect(pageSrc).toContain('data-testid="daemon-connections"');
    expect(pageSrc).toContain("health.connections");
  });
});

// AC: @ui-settings-view ac-1 — shadow branch section
describe("shadow branch section (@ui-settings-view ac-1)", () => {
  it("has shadow card", () => {
    expect(pageSrc).toContain('data-testid="settings-shadow"');
  });

  it("shows shadow status", () => {
    expect(pageSrc).toContain('data-testid="shadow-status"');
    expect(pageSrc).toContain("shadowStatus.enabled");
    expect(pageSrc).toContain("shadowStatus.healthy");
  });

  it("shows branch name", () => {
    expect(pageSrc).toContain('data-testid="shadow-branch"');
    expect(pageSrc).toContain("shadowStatus.branch_name");
  });

  it("shows worktree directory", () => {
    expect(pageSrc).toContain('data-testid="shadow-worktree"');
    expect(pageSrc).toContain("shadowStatus.worktree_dir");
  });

  it("shows remote tracking status", () => {
    expect(pageSrc).toContain('data-testid="shadow-remote"');
    expect(pageSrc).toContain("shadowStatus.remote_tracking");
  });
});

// AC: @ui-settings-view ac-1 — conventions section
describe("conventions section (@ui-settings-view ac-1)", () => {
  it("has conventions card", () => {
    expect(pageSrc).toContain('data-testid="settings-conventions"');
  });

  it("shows convention domain", () => {
    expect(pageSrc).toContain('data-testid="convention-domain"');
    expect(pageSrc).toContain("convention.domain");
  });

  it("shows convention rules", () => {
    expect(pageSrc).toContain("convention.rules");
  });

  it("shows convention examples with good/bad", () => {
    expect(pageSrc).toContain("convention.examples");
    expect(pageSrc).toContain("example.good");
    expect(pageSrc).toContain("example.bad");
  });

  it("has expandable convention items", () => {
    expect(pageSrc).toContain('data-testid="convention-toggle"');
    expect(pageSrc).toContain('data-testid="convention-details"');
    expect(pageSrc).toContain("expandedDomains");
  });

  it("shows conventions count", () => {
    expect(pageSrc).toContain('data-testid="conventions-count"');
  });
});

// AC: @ui-settings-view ac-1 — loading, empty, error states
describe("loading, empty, and error states (@ui-settings-view ac-1)", () => {
  it("has loading skeleton for project config", () => {
    expect(pageSrc).toContain('data-testid="settings-project-loading"');
    expect(pageSrc).toContain("ds-shimmer");
  });

  it("has loading skeleton for daemon", () => {
    expect(pageSrc).toContain('data-testid="settings-daemon-loading"');
  });

  it("has loading skeleton for shadow", () => {
    expect(pageSrc).toContain('data-testid="settings-shadow-loading"');
  });

  it("has loading skeleton for conventions", () => {
    expect(pageSrc).toContain('data-testid="settings-conventions-loading"');
  });

  it("has error state for each section", () => {
    expect(pageSrc).toContain('data-testid="settings-project-error"');
    expect(pageSrc).toContain('data-testid="settings-daemon-error"');
    expect(pageSrc).toContain('data-testid="settings-shadow-error"');
    expect(pageSrc).toContain('data-testid="settings-conventions-error"');
  });

  it("uses role=alert on error states", () => {
    // Count occurrences of role="alert"
    const alertCount = (pageSrc.match(/role="alert"/g) || []).length;
    expect(alertCount).toBeGreaterThanOrEqual(4);
  });

  it("has empty state for conventions", () => {
    expect(pageSrc).toContain('data-testid="settings-conventions-empty"');
    expect(pageSrc).toContain("No conventions defined");
  });

  // AC: @gh-pages-export ac-24
  it("has static mode fallback", () => {
    expect(pageSrc).toContain("isStaticMode()");
    expect(pageSrc).toContain('data-testid="settings-daemon-static"');
    expect(pageSrc).toContain('data-testid="settings-shadow-static"');
  });
});

// Design token verification
describe("design tokens (@ui-settings-view ac-1)", () => {
  it("uses severity tokens for status indicators (not raw Tailwind colors)", () => {
    expect(pageSrc).toContain("bg-severity-success");
    expect(pageSrc).toContain("bg-severity-error");
    // Must NOT have raw color classes
    expect(pageSrc).not.toContain("text-emerald-");
    expect(pageSrc).not.toContain("bg-emerald-");
    expect(pageSrc).not.toContain("text-blue-");
    expect(pageSrc).not.toContain("text-amber-");
    expect(pageSrc).not.toContain("text-green-");
    expect(pageSrc).not.toContain("text-red-");
  });

  it("uses severity tokens for good/bad examples", () => {
    expect(pageSrc).toContain("text-severity-success");
    expect(pageSrc).toContain("text-severity-error");
  });
});

// API client tests
describe("settings API functions (@ui-settings-view ac-1)", () => {
  it("fetchHealth function exists in api.ts", () => {
    expect(apiSrc).toContain("export async function fetchHealth");
  });

  it("fetchHealth calls /api/health endpoint", () => {
    expect(apiSrc).toContain("/api/health");
  });

  it("fetchProjectConfig function exists in api.ts", () => {
    expect(apiSrc).toContain("export async function fetchProjectConfig");
  });

  it("fetchProjectConfig calls /api/meta/config endpoint", () => {
    expect(apiSrc).toContain("/api/meta/config");
  });

  it("fetchShadowStatus function exists in api.ts", () => {
    expect(apiSrc).toContain("export async function fetchShadowStatus");
  });

  it("fetchShadowStatus calls /api/meta/shadow endpoint", () => {
    expect(apiSrc).toContain("/api/meta/shadow");
  });

  it("fetchConventions function exists in api.ts", () => {
    expect(apiSrc).toContain("export async function fetchConventions");
  });

  it("fetchConventions calls /api/meta/conventions endpoint", () => {
    expect(apiSrc).toContain("/api/meta/conventions");
  });

  it("HealthResponse type is exported", () => {
    expect(apiSrc).toContain("export interface HealthResponse");
  });

  it("ProjectConfig type is exported", () => {
    expect(apiSrc).toContain("export interface ProjectConfig");
  });

  it("ShadowStatusResponse type is exported", () => {
    expect(apiSrc).toContain("export interface ShadowStatusResponse");
  });
});

// WebSocket subscription for live updates
describe("real-time updates (@ui-settings-view ac-1)", () => {
  it("subscribes to updates for live reload", () => {
    expect(pageSrc).toContain("subscribe");
    expect(pageSrc).toContain("unsubscribe");
  });

  it("responds to project version changes", () => {
    expect(pageSrc).toContain("getProjectVersion");
    expect(pageSrc).toContain("$effect");
  });
});

// API client endpoint coverage — verify the client calls the correct daemon endpoints
describe("API client endpoint coverage (@ui-settings-view ac-1)", () => {
  it("fetchHealth calls the daemon health endpoint", () => {
    expect(apiSrc).toContain("api/health");
  });

  it("fetchProjectConfig calls /api/meta/config", () => {
    expect(apiSrc).toContain("api/meta/config");
  });

  it("fetchShadowStatus calls /api/meta/shadow", () => {
    expect(apiSrc).toContain("api/meta/shadow");
  });

  it("fetchConventions calls /api/meta/conventions", () => {
    expect(apiSrc).toContain("api/meta/conventions");
  });

  it("ProjectConfig type includes remote_tracking field", () => {
    expect(apiSrc).toContain("remote_tracking");
  });

  it("ProjectConfig type includes daemon port", () => {
    expect(apiSrc).toContain("daemon: { port: number");
  });
});
