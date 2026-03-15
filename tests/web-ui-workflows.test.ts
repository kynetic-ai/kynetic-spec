/**
 * Workflows Page Static Analysis Tests
 *
 * Verifies the workflows page has proper structure: data-testid attributes,
 * required UI elements, loading/empty/error states, and AC annotations.
 *
 * AC: @ui-workflows-view ac-1 — Each workflow shows id, description, ordered steps
 * with names, trigger type, and loop variant indicator. Start button initiates workflow.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WEB_UI_SRC = join(process.cwd(), "packages", "web-ui", "src");
const WORKFLOWS_PAGE = join(WEB_UI_SRC, "routes", "workflows", "+page.svelte");
const WORKFLOWS_PAGE_TS = join(WEB_UI_SRC, "routes", "workflows", "+page.ts");
const API_CLIENT = join(WEB_UI_SRC, "lib", "api.ts");
const API_STATIC = join(WEB_UI_SRC, "lib", "api-static.ts");

let pageSrc = "";
let pageTs = "";
let apiSrc = "";
let apiStaticSrc = "";

function loadSources() {
  pageSrc = readFileSync(WORKFLOWS_PAGE, "utf-8");
  pageTs = readFileSync(WORKFLOWS_PAGE_TS, "utf-8");
  apiSrc = readFileSync(API_CLIENT, "utf-8");
  apiStaticSrc = readFileSync(API_STATIC, "utf-8");
}

loadSources();

// AC: @ui-workflows-view ac-1
describe("workflows page structure (@ui-workflows-view ac-1)", () => {
  it("page file exists", () => {
    expect(existsSync(WORKFLOWS_PAGE)).toBe(true);
  });

  it("disables SSR", () => {
    expect(pageTs).toContain("export const ssr = false");
  });

  it("imports fetchWorkflows from api", () => {
    expect(pageSrc).toContain("fetchWorkflows");
    expect(pageSrc).toContain("from '$lib/api'");
  });

  it("imports Workflow type from shared", () => {
    expect(pageSrc).toContain("Workflow");
    expect(pageSrc).toContain("@kynetic-ai/shared");
  });

  it("uses Svelte 5 runes for state", () => {
    expect(pageSrc).toContain("$state");
    expect(pageSrc).not.toMatch(/\$:\s/); // No Svelte 4 reactive declarations
  });
});

// AC: @ui-workflows-view ac-1 — workflow id, description, steps, trigger, loop indicator
describe("workflow card content (@ui-workflows-view ac-1)", () => {
  it("shows workflow id", () => {
    expect(pageSrc).toContain('data-testid="workflow-id"');
    expect(pageSrc).toContain("workflow.id");
  });

  it("shows workflow description", () => {
    expect(pageSrc).toContain('data-testid="workflow-description"');
    expect(pageSrc).toContain("workflow.description");
  });

  it("shows trigger type badge", () => {
    expect(pageSrc).toContain('data-testid="workflow-trigger"');
    expect(pageSrc).toContain("workflow.trigger");
  });

  it("shows loop variant indicator", () => {
    expect(pageSrc).toContain('data-testid="workflow-loop"');
    expect(pageSrc).toContain("workflow.mode === 'loop'");
  });

  it("shows based_on variant indicator", () => {
    expect(pageSrc).toContain('data-testid="workflow-variant"');
    expect(pageSrc).toContain("workflow.based_on");
  });

  it("shows ordered steps", () => {
    expect(pageSrc).toContain('data-testid="workflow-steps"');
    expect(pageSrc).toContain('data-testid="workflow-step"');
    expect(pageSrc).toContain("{#each workflow.steps as step, i}");
  });

  it("shows step type icons for action, check, and decision", () => {
    expect(pageSrc).toContain("step.type === 'check'");
    expect(pageSrc).toContain("step.type === 'decision'");
  });

  it("shows on_fail for check steps", () => {
    expect(pageSrc).toContain("step.on_fail");
  });

  it("shows options for decision steps", () => {
    expect(pageSrc).toContain("step.options");
  });

  it("has Start button", () => {
    expect(pageSrc).toContain('data-testid="workflow-start-btn"');
    expect(pageSrc).toMatch(/Start/);
  });

  it("Start button copies kspec workflow start command", () => {
    expect(pageSrc).toContain("kspec workflow start @");
    expect(pageSrc).toContain("navigator.clipboard.writeText");
  });
});

// AC: @ui-workflows-view ac-1 — loading, empty, error states
describe("loading, empty, and error states (@ui-workflows-view ac-1)", () => {
  it("has loading skeleton", () => {
    expect(pageSrc).toContain('data-testid="workflows-loading"');
    expect(pageSrc).toContain("ds-shimmer");
  });

  it("has empty state with icon and message", () => {
    expect(pageSrc).toContain('data-testid="workflows-empty"');
    expect(pageSrc).toContain("No workflows defined");
  });

  it("has error state", () => {
    expect(pageSrc).toContain('data-testid="workflows-error"');
    expect(pageSrc).toContain('role="alert"');
  });

  it("has static mode aware empty state", () => {
    expect(pageSrc).toContain("isStaticMode()");
    expect(pageSrc).toContain("No workflow data available in the snapshot");
  });
});

// API client tests
describe("fetchWorkflows API function", () => {
  it("fetchWorkflows function exists in api.ts", () => {
    expect(apiSrc).toContain("export async function fetchWorkflows");
  });

  it("calls /api/meta/workflows endpoint", () => {
    expect(apiSrc).toContain("/api/meta/workflows");
  });

  it("supports static mode", () => {
    expect(apiSrc).toContain("fetchWorkflowsStatic");
  });

  it("static fallback exists", () => {
    expect(apiStaticSrc).toContain("export function fetchWorkflowsStatic");
  });

  it("static fallback reads from snapshot", () => {
    expect(apiStaticSrc).toContain("snapshot.workflows");
  });
});

// Real-time updates via TanStack Query + centralized WS invalidation
describe("real-time updates", () => {
  it("uses TanStack Query for data freshness (WS handled by centralized wiring)", () => {
    expect(pageSrc).toContain("createQuery");
    expect(pageSrc).toContain("queryKeys.workflows");
  });

  it("gates query on project initialization", () => {
    expect(pageSrc).toContain("isProjectInitialized()");
  });
});
