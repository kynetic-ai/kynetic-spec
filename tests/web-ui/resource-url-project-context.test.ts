/**
 * Resource URL project-context contract tests.
 *
 * In live multi-project mode the daemon serves several registered projects.
 * Browser-issued requests for resource bytes come from `<img src>` / `<a href>`
 * elements, which cannot set the `X-Kspec-Dir` header the rest of the API
 * relies on. The selected project's path must therefore travel inside the URL
 * itself as a `?kspec_dir=` query parameter; otherwise the daemon falls back to
 * its default project and a non-default selected project's resources 404 or
 * load the wrong bytes.
 *
 * This file pins that contract from two directions:
 *
 *   - PLAN (it.fails until the fix lands): plan markdown `./resources/<path>`
 *     references rewritten via `buildPlanContentBlocks` must carry the selected
 *     project's `kspec_dir`. The plan rewrite is project-unaware today, so the
 *     contract tests fail-as-expected; the sibling task
 *     `@generalize-live-ui-resource-markdown-rewriting` makes the rewrite
 *     project-aware and flips these to `it` (FLIPPED-ON-FIX protocol — see
 *     tests/lint-no-leaky-test-daemon.test.ts).
 *
 *   - REVIEW (normal it — passing comparator): `reviewResourceBytesUrl` already
 *     appends `kspec_dir`, and these tests are the working browser-URL
 *     comparator the plan/task rewrites are being brought up to parity with.
 *
 * SCOPE — these are URL-SHAPE unit pins (does the rewritten / built URL carry
 * the selected project's kspec_dir?). The ACs' HTTP "Then" clauses — fetching
 * the produced URL WITHOUT `X-Kspec-Dir` in a multi-project daemon returns the
 * selected project's resource bytes instead of the default project's bytes or a
 * 404 — are asserted end-to-end against the real daemon resource routes in
 * tests/daemon-api/resource-url-browser-fetch-contract.test.ts.
 *
 * Spec: @live-plan-resource-url-project-context
 * Spec: @live-review-resource-url-project-context
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanDetail, PlanResourceMetadata } from "@kynetic-ai/shared";

const modeState = vi.hoisted(() => ({
  staticMode: false,
}));

const projectState = vi.hoisted(() => ({
  selectedPath: null as string | null,
}));

const modeMock = vi.hoisted(() => () => ({
  getSnapshot: () => null,
  isStaticMode: () => modeState.staticMode,
  assertWritable: () => {},
  ReadOnlyModeError: class ReadOnlyModeError extends Error {},
}));

const projectMock = vi.hoisted(() => () => ({
  getSelectedProjectPath: () => projectState.selectedPath,
  clearInvalidSelection: () => {},
  isInvalidProjectError: () => false,
}));

const constantsMock = vi.hoisted(() => () => ({
  DAEMON_API_BASE: "http://localhost:3456",
}));

vi.mock("$lib/stores/mode.svelte", modeMock);
vi.mock("../../packages/web-ui/src/lib/stores/mode.svelte", modeMock);
vi.mock("$lib/stores/project.svelte", projectMock);
vi.mock("../../packages/web-ui/src/lib/stores/project.svelte", projectMock);
vi.mock("$lib/constants", constantsMock);
vi.mock("../../packages/web-ui/src/lib/constants", constantsMock);

vi.mock("$lib/api-static", () => ({}));
vi.mock("../../packages/web-ui/src/lib/api-static", () => ({}));

import { reviewResourceBytesUrl } from "../../packages/web-ui/src/lib/api";
import { buildPlanContentBlocks } from "../../packages/web-ui/src/lib/utils/plan-embedded-content";

const PLAN_ULID = "01TESTPLAN0000000000000000";
const PLAN_RESOURCES_BASE = `/api/plans/${PLAN_ULID}/resources`;
const SELECTED_PROJECT = "/home/me/other-project";
const SELECTED_PROJECT_QS = "%2Fhome%2Fme%2Fother-project";

function planResource(overrides: Partial<PlanResourceMetadata> = {}): PlanResourceMetadata {
  return {
    id: "shot",
    label: null,
    path: "screenshots/login.png",
    content_type: "image/png",
    bytes: 4,
    sha256: "a".repeat(64),
    git_commit: null,
    git_path: null,
    description: null,
    ...overrides,
  };
}

function planWith(content: string, resources: PlanResourceMetadata[]): PlanDetail {
  return {
    _ulid: PLAN_ULID,
    slugs: ["test-plan"],
    title: "Test Plan",
    status: "active",
    created_at: "2026-03-12T00:00:00.000Z",
    derived_specs: [],
    derived_tasks: [],
    spec_count: 0,
    task_count: 0,
    task_progress: { total: 0, completed: 0, in_progress: 0, pending: 0, blocked: 0 },
    content,
    resources,
    resources_base_url: PLAN_RESOURCES_BASE,
  };
}

function firstMarkdown(plan: PlanDetail): string {
  const blocks = buildPlanContentBlocks(plan, {});
  const block = blocks.find((b) => b.type === "markdown");
  if (!block || block.type !== "markdown") throw new Error("expected markdown block");
  return block.markdown;
}

beforeEach(() => {
  modeState.staticMode = false;
  projectState.selectedPath = SELECTED_PROJECT;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plan resource URLs preserve selected-project context", () => {
  // AC: @live-plan-resource-url-project-context ac-plan-image-routes-to-selected-project
  // A plan markdown image referencing a declared resource must rewrite to a URL
  // that carries the selected non-default project's kspec_dir so the browser
  // fetches that project's plan resource bytes rather than the default
  // project's bytes or a not-found response.
  it.fails("rewrites a plan image target to a URL carrying the selected project's kspec_dir", () => {
    const plan = planWith("# Plan\n\n![login](./resources/screenshots/login.png)\n", [
      planResource(),
    ]);
    const markdown = firstMarkdown(plan);
    expect(markdown).toContain(
      `![login](${PLAN_RESOURCES_BASE}/shot/bytes?kspec_dir=${SELECTED_PROJECT_QS})`,
    );
  });

  // AC: @live-plan-resource-url-project-context ac-plan-doc-link-routes-to-selected-project
  // A plan markdown document link referencing a declared resource must rewrite
  // to a URL carrying the selected project's kspec_dir so opening it returns
  // that project's plan resource document bytes.
  it.fails("rewrites a plan document link to a URL carrying the selected project's kspec_dir", () => {
    const plan = planWith("# Plan\n\nSee [the spec](./resources/docs/spec.md).\n", [
      planResource({ id: "specdoc", path: "docs/spec.md", content_type: "text/markdown" }),
    ]);
    const markdown = firstMarkdown(plan);
    expect(markdown).toContain(
      `[the spec](${PLAN_RESOURCES_BASE}/specdoc/bytes?kspec_dir=${SELECTED_PROJECT_QS})`,
    );
  });

  // AC: @live-plan-resource-url-project-context ac-plan-image-routes-to-selected-project
  //     — when no project is selected the rewrite emits the plan-scoped bytes
  //     URL without a kspec_dir query (default project routing). This already
  //     holds today (the base plan rewrite is project-context-free), and must
  //     keep holding once the project-aware kspec_dir append lands — so it is a
  //     normal `it`, not `it.fails`.
  it("rewrites a plan image target without kspec_dir when no project is selected", () => {
    projectState.selectedPath = null;
    const plan = planWith("# Plan\n\n![login](./resources/screenshots/login.png)\n", [
      planResource(),
    ]);
    const markdown = firstMarkdown(plan);
    expect(markdown).toContain(`![login](${PLAN_RESOURCES_BASE}/shot/bytes)`);
    expect(markdown).not.toContain("kspec_dir");
  });
});

describe("review resource URLs preserve selected-project context (passing comparator)", () => {
  // AC: @live-review-resource-url-project-context ac-review-image-routes-to-selected-project
  // The working comparator: review image preview URLs already append the
  // selected project's kspec_dir so the browser fetches that project's review
  // image bytes.
  it("builds a review image bytes URL carrying the selected project's kspec_dir", () => {
    projectState.selectedPath = SELECTED_PROJECT;
    expect(reviewResourceBytesUrl("@review-1", "screenshot")).toBe(
      `http://localhost:3456/api/reviews/%40review-1/resources/screenshot/bytes?kspec_dir=${SELECTED_PROJECT_QS}`,
    );
  });

  // AC: @live-review-resource-url-project-context ac-review-doc-link-routes-to-selected-project
  // Same builder for document resources: opening a review document link returns
  // the selected project's review document bytes.
  it("builds a review document bytes URL carrying the selected project's kspec_dir", () => {
    projectState.selectedPath = SELECTED_PROJECT;
    expect(reviewResourceBytesUrl("@review-1", "design-doc")).toBe(
      `http://localhost:3456/api/reviews/%40review-1/resources/design-doc/bytes?kspec_dir=${SELECTED_PROJECT_QS}`,
    );
  });

  // AC: @live-review-resource-url-project-context ac-review-image-routes-to-selected-project
  //     — with no project selected the URL omits kspec_dir (default routing).
  it("omits kspec_dir from review bytes URLs when no project is selected", () => {
    projectState.selectedPath = null;
    expect(reviewResourceBytesUrl("@review-1", "screenshot")).toBe(
      "http://localhost:3456/api/reviews/%40review-1/resources/screenshot/bytes",
    );
  });
});
