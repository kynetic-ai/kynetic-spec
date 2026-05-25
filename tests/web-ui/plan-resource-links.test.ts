/**
 * Plan resource link rewriting — verifies that markdown link/image targets
 * authored as `./resources/<path>` are rewritten to the safe plan-scoped
 * `bytes_url` exposed by the daemon API, while unresolved references are
 * left untouched so authors see the raw guidance.
 *
 * Spec: @trait-entity-scoped-local-resources-1
 */

import { describe, expect, it } from "vitest";
import type { PlanDetail, PlanResourceMetadata } from "@kynetic-ai/shared";

import { rewritePlanResourceLinks } from "../../packages/web-ui/src/lib/utils/plan-resource-links";
import { buildPlanContentBlocks } from "../../packages/web-ui/src/lib/utils/plan-embedded-content";

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
    bytes_url: "/api/plans/01TESTPLAN0000000000000000/resources/shot/bytes",
    ...overrides,
  };
}

describe("rewritePlanResourceLinks", () => {
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("rewrites a markdown image targeting a declared plan resource to the safe bytes URL", () => {
    const markdown = "Look here: ![login](./resources/screenshots/login.png)";
    const out = rewritePlanResourceLinks(markdown, [resource()]);
    expect(out).toBe(
      "Look here: ![login](/api/plans/01TESTPLAN0000000000000000/resources/shot/bytes)",
    );
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("rewrites an inline link targeting a declared plan resource", () => {
    const markdown = "See [the shot](./resources/screenshots/login.png) for details.";
    const out = rewritePlanResourceLinks(markdown, [resource()]);
    expect(out).toBe(
      "See [the shot](/api/plans/01TESTPLAN0000000000000000/resources/shot/bytes) for details.",
    );
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("rewrites a reference-style link definition", () => {
    const markdown = "[shot]: ./resources/screenshots/login.png\n\nSee [shot].";
    const out = rewritePlanResourceLinks(markdown, [resource()]);
    expect(out).toContain("[shot]: /api/plans/01TESTPLAN0000000000000000/resources/shot/bytes");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  //     — unresolved references must remain visible so authors see the raw
  //     text and can add a manifest entry (fallback rendering behaviour).
  it("leaves unresolved ./resources/ references untouched", () => {
    const markdown = "Missing: ![gone](./resources/screenshots/missing.png)";
    const out = rewritePlanResourceLinks(markdown, [resource()]);
    expect(out).toBe(markdown);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("returns the original markdown when there are no declared resources", () => {
    const markdown = "Look: ![login](./resources/screenshots/login.png)";
    expect(rewritePlanResourceLinks(markdown, [])).toBe(markdown);
    expect(rewritePlanResourceLinks(markdown, undefined)).toBe(markdown);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("does not rewrite external https:// links that share a similar path", () => {
    const markdown = "External: [example](https://example.com/resources/screenshots/login.png)";
    const out = rewritePlanResourceLinks(markdown, [resource()]);
    expect(out).toBe(markdown);
  });
});

describe("buildPlanContentBlocks (resource link integration)", () => {
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("passes rewritten markdown through to the rendered block", () => {
    const plan: PlanDetail = {
      _ulid: "01TESTPLAN0000000000000000",
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
    };
    const blocks = buildPlanContentBlocks(plan, {});
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block.type !== "markdown") throw new Error("expected markdown block");
    expect(block.markdown).toContain(
      "![login](/api/plans/01TESTPLAN0000000000000000/resources/shot/bytes)",
    );
    expect(block.markdown).not.toContain("./resources/screenshots/login.png");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("does not rewrite when the plan has no resources field", () => {
    const plan: PlanDetail = {
      _ulid: "01TESTPLAN0000000000000000",
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
