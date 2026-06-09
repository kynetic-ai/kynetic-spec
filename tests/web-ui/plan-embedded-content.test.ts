import { describe, expect, it, vi } from "vitest";

// buildPlanContentBlocks rewrites `./resources/<path>` markdown via the shared
// resource-links core, which reads the project store for selected-project
// `kspec_dir` context. Mock the store (no project selected) so the module
// chain resolves without `$app`/`$lib` aliases; selected-project routing is
// pinned separately in resource-url-project-context.test.ts.
const projectMock = vi.hoisted(() => () => ({
  getSelectedProjectPath: () => null,
  clearInvalidSelection: () => {},
  isInvalidProjectError: () => false,
}));
vi.mock("$lib/stores/project.svelte", projectMock);
vi.mock("../../packages/web-ui/src/lib/stores/project.svelte", projectMock);

import { buildPlanContentBlocks } from "../../packages/web-ui/src/lib/utils/plan-embedded-content";

const basePlan = {
  _ulid: "01TESTPLANEMBED000000000000",
  slugs: ["test-plan"],
  title: "Test Plan",
  status: "active",
  created_at: "2026-03-12T00:00:00.000Z",
  approved_at: undefined,
  completed_at: undefined,
  spec_count: 1,
  task_count: 3,
  task_progress: {
    total: 3,
    completed: 0,
    in_progress: 0,
    pending: 3,
    blocked: 0,
  },
};

describe("buildPlanContentBlocks", () => {
  // AC: @plan-embedded-views ac-1
  it("embeds spec blocks when plan yaml omits explicit slugs but titles match derived specs", () => {
    const blocks = buildPlanContentBlocks(
      {
        ...basePlan,
        content: `# Example

## Specs

\`\`\`yaml
- title: Dead Code and Deduplication Sweep
  type: feature
\`\`\`
`,
        derived_specs: ["@dead-code-and-deduplication-sweep"],
        derived_tasks: [],
      },
      { batchLoading: true },
    );

    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "embedded",
          embedType: "spec",
          state: "loading",
          refs: ["@dead-code-and-deduplication-sweep"],
        }),
      ]),
    );
  });

  // AC: @plan-embedded-views ac-2
  // AC: @plan-embedded-views ac-9
  it("prefers derive_from_specs over adjacent manual task yaml when both are present", () => {
    const blocks = buildPlanContentBlocks(
      {
        ...basePlan,
        content: `# Example

## Tasks

derive_from_specs: true

\`\`\`yaml
- title: Add markdown rendering trait to existing specs
  slug: task-add-markdown-trait
  priority: 1
\`\`\`
`,
        derived_specs: [],
        derived_tasks: [
          "@implement-markdown-rendering-trait",
          "@implement-prose-typography-setup",
          "@task-add-markdown-trait",
        ],
      },
      { batchLoading: true },
    );

    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "embedded",
          embedType: "task",
          state: "loading",
          refs: [
            "@implement-markdown-rendering-trait",
            "@implement-prose-typography-setup",
            "@task-add-markdown-trait",
          ],
        }),
      ]),
    );
  });

  // AC: @plan-embedded-views ac-2
  // AC: @plan-embedded-views ac-9
  it("still prefers derive_from_specs when the manual task yaml appears before the directive", () => {
    const blocks = buildPlanContentBlocks(
      {
        ...basePlan,
        content: `# Example

## Tasks

\`\`\`yaml
- title: Add markdown rendering trait to existing specs
  slug: task-add-markdown-trait
  priority: 1
\`\`\`

derive_from_specs: true
`,
        derived_specs: [],
        derived_tasks: [
          "@implement-markdown-rendering-trait",
          "@implement-prose-typography-setup",
          "@task-add-markdown-trait",
        ],
      },
      { batchLoading: true },
    );

    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "embedded",
          embedType: "task",
          state: "loading",
          refs: [
            "@implement-markdown-rendering-trait",
            "@implement-prose-typography-setup",
            "@task-add-markdown-trait",
          ],
        }),
      ]),
    );
  });

  // AC: @plan-embedded-views ac-2
  it("uses manual task refs when derive_from_specs is not enabled", () => {
    const blocks = buildPlanContentBlocks(
      {
        ...basePlan,
        content: `# Example

## Tasks

\`\`\`yaml
- title: Add markdown rendering trait to existing specs
  slug: task-add-markdown-trait
\`\`\`
`,
        derived_specs: [],
        derived_tasks: [
          "@implement-markdown-rendering-trait",
          "@implement-prose-typography-setup",
          "@task-add-markdown-trait",
        ],
      },
      { batchLoading: true },
    );

    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "embedded",
          embedType: "task",
          state: "loading",
          refs: ["@task-add-markdown-trait"],
        }),
      ]),
    );
  });
});
