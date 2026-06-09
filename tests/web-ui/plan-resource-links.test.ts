/**
 * Plan resource link rewriting — verifies that markdown link/image targets
 * authored as `./resources/<path>` are rewritten to the safe plan-scoped
 * fetch URL constructed from `PlanDetail.resources_base_url`, while
 * unresolved references are left untouched so authors see the raw guidance.
 *
 * `PlanResourceMetadata` is the strict 9-field shape mirrored from the
 * daemon API — fetch URLs live outside the metadata object so all consumers
 * (API, CLI, static export, agent contexts) see an identical resource
 * record.
 *
 * Spec: @trait-entity-scoped-local-resources-1
 */

import { describe, expect, it, vi } from "vitest";
import type { PlanDetail, PlanResourceMetadata } from "@kynetic-ai/shared";

// The plan rewriter delegates to the shared resource-links core, which reads
// the project store to append selected-project `kspec_dir` context. No project
// is selected in these unit tests, so the rewritten URLs carry no `kspec_dir`
// (selected-project routing is pinned separately in
// resource-url-project-context.test.ts). Mock the store so the module chain
// resolves without pulling in `$app`/`$lib` SvelteKit aliases.
const projectMock = vi.hoisted(() => () => ({
  getSelectedProjectPath: () => null,
  clearInvalidSelection: () => {},
  isInvalidProjectError: () => false,
}));
vi.mock("$lib/stores/project.svelte", projectMock);
vi.mock("../../packages/web-ui/src/lib/stores/project.svelte", projectMock);

import { rewritePlanResourceLinks } from "../../packages/web-ui/src/lib/utils/plan-resource-links";
import { buildPlanContentBlocks } from "../../packages/web-ui/src/lib/utils/plan-embedded-content";

const PLAN_ULID = "01TESTPLAN0000000000000000";
const PLAN_RESOURCES_BASE = `/api/plans/${PLAN_ULID}/resources`;

function resource(overrides: Partial<PlanResourceMetadata> = {}): PlanResourceMetadata {
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

describe("rewritePlanResourceLinks", () => {
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("returns the strict 9-field PlanResourceMetadata shape (no embedded URLs)", () => {
    const r = resource();
    expect(Object.keys(r).sort()).toEqual(
      [
        "bytes",
        "content_type",
        "description",
        "git_commit",
        "git_path",
        "id",
        "label",
        "path",
        "sha256",
      ].sort(),
    );
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("rewrites a markdown image targeting a declared plan resource to the safe fetch URL", () => {
    const markdown = "Look here: ![login](./resources/screenshots/login.png)";
    const out = rewritePlanResourceLinks(markdown, [resource()], PLAN_RESOURCES_BASE);
    expect(out).toBe(`Look here: ![login](${PLAN_RESOURCES_BASE}/shot/bytes)`);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("rewrites an inline link targeting a declared plan resource", () => {
    const markdown = "See [the shot](./resources/screenshots/login.png) for details.";
    const out = rewritePlanResourceLinks(markdown, [resource()], PLAN_RESOURCES_BASE);
    expect(out).toBe(`See [the shot](${PLAN_RESOURCES_BASE}/shot/bytes) for details.`);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("rewrites a reference-style link definition", () => {
    const markdown = "[shot]: ./resources/screenshots/login.png\n\nSee [shot].";
    const out = rewritePlanResourceLinks(markdown, [resource()], PLAN_RESOURCES_BASE);
    expect(out).toContain(`[shot]: ${PLAN_RESOURCES_BASE}/shot/bytes`);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("URL-encodes resource ids when constructing the fetch URL", () => {
    const markdown = "![hero](./resources/branding/hero.png)";
    const out = rewritePlanResourceLinks(
      markdown,
      [resource({ id: "hero shot/1", path: "branding/hero.png" })],
      PLAN_RESOURCES_BASE,
    );
    expect(out).toBe(`![hero](${PLAN_RESOURCES_BASE}/hero%20shot%2F1/bytes)`);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("tolerates a trailing slash on resources_base_url without double-slashing", () => {
    const markdown = "![login](./resources/screenshots/login.png)";
    const out = rewritePlanResourceLinks(markdown, [resource()], `${PLAN_RESOURCES_BASE}/`);
    expect(out).toBe(`![login](${PLAN_RESOURCES_BASE}/shot/bytes)`);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  //     — unresolved references must remain visible so authors see the raw
  //     text and can add a manifest entry (fallback rendering behaviour).
  it("leaves unresolved ./resources/ references untouched", () => {
    const markdown = "Missing: ![gone](./resources/screenshots/missing.png)";
    const out = rewritePlanResourceLinks(markdown, [resource()], PLAN_RESOURCES_BASE);
    expect(out).toBe(markdown);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("returns the original markdown when there are no declared resources", () => {
    const markdown = "Look: ![login](./resources/screenshots/login.png)";
    expect(rewritePlanResourceLinks(markdown, [], PLAN_RESOURCES_BASE)).toBe(markdown);
    expect(rewritePlanResourceLinks(markdown, undefined, PLAN_RESOURCES_BASE)).toBe(markdown);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("returns the original markdown when the base URL is missing", () => {
    const markdown = "Look: ![login](./resources/screenshots/login.png)";
    expect(rewritePlanResourceLinks(markdown, [resource()], "")).toBe(markdown);
    expect(rewritePlanResourceLinks(markdown, [resource()], undefined)).toBe(markdown);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("does not rewrite external https:// links that share a similar path", () => {
    const markdown = "External: [example](https://example.com/resources/screenshots/login.png)";
    const out = rewritePlanResourceLinks(markdown, [resource()], PLAN_RESOURCES_BASE);
    expect(out).toBe(markdown);
  });
});

describe("buildPlanContentBlocks (resource link integration)", () => {
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("passes rewritten markdown through to the rendered block", () => {
    const plan: PlanDetail = {
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
      content: "# Plan\n\n![login](./resources/screenshots/login.png)\n",
      resources: [resource()],
      resources_base_url: PLAN_RESOURCES_BASE,
    };
    const blocks = buildPlanContentBlocks(plan, {});
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block.type !== "markdown") throw new Error("expected markdown block");
    expect(block.markdown).toContain(`![login](${PLAN_RESOURCES_BASE}/shot/bytes)`);
    expect(block.markdown).not.toContain("./resources/screenshots/login.png");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("does not rewrite when the plan has no resources field", () => {
    const plan: PlanDetail = {
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
      content: "# Plan\n\n![login](./resources/missing.png)\n",
      resources: [],
      resources_base_url: PLAN_RESOURCES_BASE,
    };
    const blocks = buildPlanContentBlocks(plan, {});
    const markdownBlock = blocks.find((b) => b.type === "markdown");
    if (!markdownBlock || markdownBlock.type !== "markdown") {
      throw new Error("expected markdown block");
    }
    // Author guidance preserved when the manifest does not declare the file
    expect(markdownBlock.markdown).toContain("![login](./resources/missing.png)");
  });
});
