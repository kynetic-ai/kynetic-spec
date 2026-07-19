import { describe, expect, it, vi } from "vitest";
import type { BatchItemSummary, PlanDetail } from "@kynetic-ai/shared";

// buildPlanContentBlocks rewrites `./resources/<path>` markdown via the shared
// resource-links core, which reads the project store for selected-project
// `kspec_dir` context. Mock the store (no project selected) so the module
// chain resolves without `$app`/`$lib` SvelteKit aliases; selected-project
// routing is pinned in tests/web-ui/resource-url-project-context.test.ts.
const projectMock = vi.hoisted(() => () => ({
  getSelectedProjectPath: () => null,
  clearInvalidSelection: () => {},
  isInvalidProjectError: () => false,
}));
vi.mock("$lib/stores/project.svelte", projectMock);
vi.mock("../packages/web-ui/src/lib/stores/project.svelte", projectMock);

import { buildPlanContentBlocks } from "../packages/web-ui/src/lib/utils/plan-embedded-content";

function createPlan(overrides: Partial<PlanDetail> = {}): PlanDetail {
  return {
    _ulid: "01TESTPLANEMBEDDEDVIEWS000001",
    slugs: ["plan-embedded-views-test"],
    title: "Plan Embedded Views",
    status: "active",
    created_at: "2026-03-10T00:00:00.000Z",
    derived_specs: ["@alpha-spec", "@beta-spec"],
    derived_tasks: ["@task-alpha", "@task-beta"],
    spec_count: 2,
    task_count: 2,
    task_progress: {
      total: 2,
      completed: 0,
      in_progress: 1,
      pending: 1,
      blocked: 0,
    },
    content: "",
    ...overrides,
  };
}

function createBatchItems(): BatchItemSummary[] {
  return [
    {
      kind: "item",
      ulid: "01SPECALPHA0000000000000001",
      slugs: ["alpha-spec"],
      title: "Alpha Spec",
      type: "feature",
      status: "in_progress",
      maturity: "draft",
      traits: ["@trait-markdown-rendering"],
      ac_count: 3,
    },
    {
      kind: "item",
      ulid: "01SPECBETA00000000000000002",
      slugs: ["beta-spec"],
      title: "Beta Spec",
      type: "requirement",
      status: "implemented",
      maturity: "stable",
      traits: [],
      ac_count: 1,
    },
    {
      kind: "task",
      ulid: "01TASKALPHA0000000000000001",
      slugs: ["task-alpha"],
      title: "Task Alpha",
      status: "pending",
      priority: 2,
      spec_ref: "@alpha-spec",
      assignee: "@tester",
    },
    {
      kind: "task",
      ulid: "01TASKBETA00000000000000002",
      slugs: ["task-beta"],
      title: "Task Beta",
      status: "in_progress",
      priority: 1,
    },
  ];
}

describe("plan embedded views (@plan-embedded-views)", () => {
  it("replaces matched specs YAML with embedded spec blocks while preserving surrounding markdown", () => {
    const plan = createPlan({
      content: `# Demo Plan

## Specs

\`\`\`yaml
- title: Alpha Spec
  slug: alpha-spec
  type: feature
- title: Beta Spec
  slug: beta-spec
  type: requirement
\`\`\`

## Implementation Notes

Regular markdown paragraph with **formatting**.
`,
    });

    const blocks = buildPlanContentBlocks(plan, { batchItems: createBatchItems() });

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({
      type: "markdown",
      markdown: expect.stringContaining("## Specs"),
    });
    expect(blocks[1]).toMatchObject({
      type: "embedded",
      embedType: "spec",
      state: "ready",
      refs: ["@alpha-spec", "@beta-spec"],
    });
    expect(blocks[2]).toMatchObject({
      type: "markdown",
      markdown: expect.stringContaining("## Implementation Notes"),
    });
  });

  it("maps Tasks sections with derive_from_specs outside the fenced block to embedded task cards", () => {
    const plan = createPlan({
      content: `# Demo Plan

## Tasks

derive_from_specs: true

\`\`\`yaml
- title: Manual follow-up
  slug: unrelated-manual-task
\`\`\`
`,
    });

    const blocks = buildPlanContentBlocks(plan, { batchItems: createBatchItems() });
    const embedded = blocks.find((block) => block.type === "embedded");

    expect(embedded).toMatchObject({
      type: "embedded",
      embedType: "task",
      state: "ready",
      refs: ["@task-alpha", "@task-beta"],
    });
  });

  it("maps task sections to derived task cards even when derive_from_specs appears after the manual yaml list", () => {
    const plan = createPlan({
      content: `# Demo Plan

## Tasks

\`\`\`yaml
- title: Manual follow-up
  slug: unrelated-manual-task
\`\`\`

derive_from_specs: true
`,
    });

    const blocks = buildPlanContentBlocks(plan, { batchItems: createBatchItems() });
    const embedded = blocks.find((block) => block.type === "embedded");

    expect(embedded).toMatchObject({
      type: "embedded",
      embedType: "task",
      state: "ready",
      refs: ["@task-alpha", "@task-beta"],
    });
  });

  it("maps fenced derive_from_specs directives to embedded task cards", () => {
    const plan = createPlan({
      content: `# Demo Plan

## Tasks

\`\`\`yaml
derive_from_specs: true
\`\`\`
`,
    });

    const blocks = buildPlanContentBlocks(plan, { batchItems: createBatchItems() });
    const embedded = blocks.find((block) => block.type === "embedded");

    expect(embedded).toMatchObject({
      type: "embedded",
      embedType: "task",
      state: "ready",
      refs: ["@task-alpha", "@task-beta"],
    });
  });

  it("falls back to markdown code blocks when yaml slugs do not match derived refs", () => {
    const plan = createPlan({
      content: `## Specs

\`\`\`yaml
- title: Wrong Spec
  slug: not-derived
\`\`\`
`,
    });

    const blocks = buildPlanContentBlocks(plan, { batchItems: createBatchItems() });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "markdown",
      markdown: expect.stringContaining("slug: not-derived"),
    });
  });

  it("exposes loading placeholders for embedded card areas while batch data is pending", () => {
    const plan = createPlan({
      content: `## Specs

\`\`\`yaml
- title: Alpha Spec
  slug: alpha-spec
\`\`\`
`,
    });

    const blocks = buildPlanContentBlocks(plan, { batchLoading: true });

    expect(blocks[1]).toMatchObject({
      type: "embedded",
      embedType: "spec",
      state: "loading",
    });
  });

  it("falls back to code blocks with an error state when embedded batch loading fails", () => {
    const plan = createPlan({
      content: `## Tasks

\`\`\`yaml
- title: Task Alpha
  slug: task-alpha
\`\`\`
`,
    });

    const blocks = buildPlanContentBlocks(plan, { batchError: "boom" });

    expect(blocks[1]).toMatchObject({
      type: "embedded",
      embedType: "task",
      state: "error",
      errorMessage: "boom",
    });
  });

  it("uses manual task yaml refs when derive_from_specs is absent", () => {
    const plan = createPlan({
      content: `## Tasks

\`\`\`yaml
- title: Task Alpha
  slug: task-alpha
\`\`\`
`,
    });

    const blocks = buildPlanContentBlocks(plan, { batchItems: createBatchItems() });
    const embedded = blocks.find((block) => block.type === "embedded");

    expect(embedded).toMatchObject({
      type: "embedded",
      embedType: "task",
      state: "ready",
      refs: ["@task-alpha"],
    });
  });
});
