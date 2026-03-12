import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer } from "vite";
import type { BatchItemSummary, PlanDetail } from "@kynetic-ai/shared";
import { buildPlanContentBlocks } from "../packages/web-ui/src/lib/utils/plan-embedded-content";

type WebUiViteServer = Awaited<ReturnType<typeof createServer>>;
const WEB_UI_ROOT = join(process.cwd(), "packages", "web-ui");
const ORIGINAL_CWD = process.cwd();
let webUiViteServer: WebUiViteServer;

beforeAll(async () => {
	process.chdir(WEB_UI_ROOT);
	webUiViteServer = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: "custom"
	});
	process.chdir(ORIGINAL_CWD);
}, 30_000);

afterAll(async () => {
	if (!webUiViteServer) return;

	await Promise.race([
		webUiViteServer.close(),
		new Promise<void>((resolve) => setTimeout(resolve, 5_000))
	]);
}, 10_000);

async function transformWebUiModule(path: string): Promise<string> {
	const transformed = await webUiViteServer.transformRequest(path);
	if (!transformed?.code) {
		throw new Error(`Expected transformed output for ${path}`);
	}
	return transformed.code;
}

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
			blocked: 0
		},
		content: "",
		...overrides
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
			ac_count: 3
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
			ac_count: 1
		},
		{
			kind: "task",
			ulid: "01TASKALPHA0000000000000001",
			slugs: ["task-alpha"],
			title: "Task Alpha",
			status: "pending",
			priority: 2,
			spec_ref: "@alpha-spec",
			assignee: "@tester"
		},
		{
			kind: "task",
			ulid: "01TASKBETA00000000000000002",
			slugs: ["task-beta"],
			title: "Task Beta",
			status: "in_progress",
			priority: 1
		}
	];
}

describe("plan embedded views (@plan-embedded-views)", () => {
	// AC: @plan-embedded-views ac-1
	// AC: @plan-embedded-views ac-8
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
`
		});

		const blocks = buildPlanContentBlocks(plan, { batchItems: createBatchItems() });

		expect(blocks).toHaveLength(3);
		expect(blocks[0]).toMatchObject({
			type: "markdown",
			markdown: expect.stringContaining("## Specs")
		});
		expect(blocks[1]).toMatchObject({
			type: "embedded",
			embedType: "spec",
			state: "ready",
			refs: ["@alpha-spec", "@beta-spec"]
		});
		expect(blocks[2]).toMatchObject({
			type: "markdown",
			markdown: expect.stringContaining("## Implementation Notes")
		});
	});

	// AC: @plan-embedded-views ac-2
	it("maps Tasks sections with derive_from_specs outside the fenced block to embedded task cards", () => {
		const plan = createPlan({
			content: `# Demo Plan

## Tasks

derive_from_specs: true

\`\`\`yaml
- title: Manual follow-up
  slug: unrelated-manual-task
\`\`\`
`
		});

		const blocks = buildPlanContentBlocks(plan, { batchItems: createBatchItems() });
		const embedded = blocks.find((block) => block.type === "embedded");

		expect(embedded).toMatchObject({
			type: "embedded",
			embedType: "task",
			state: "ready",
			refs: ["@task-alpha", "@task-beta"]
		});
	});

	// AC: @plan-embedded-views ac-2
	it("maps fenced derive_from_specs directives to embedded task cards", () => {
		const plan = createPlan({
			content: `# Demo Plan

## Tasks

\`\`\`yaml
derive_from_specs: true
\`\`\`
`
		});

		const blocks = buildPlanContentBlocks(plan, { batchItems: createBatchItems() });
		const embedded = blocks.find((block) => block.type === "embedded");

		expect(embedded).toMatchObject({
			type: "embedded",
			embedType: "task",
			state: "ready",
			refs: ["@task-alpha", "@task-beta"]
		});
	});

	// AC: @plan-embedded-views ac-4
	it("falls back to markdown code blocks when yaml slugs do not match derived refs", () => {
		const plan = createPlan({
			content: `## Specs

\`\`\`yaml
- title: Wrong Spec
  slug: not-derived
\`\`\`
`
		});

		const blocks = buildPlanContentBlocks(plan, { batchItems: createBatchItems() });

		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			type: "markdown",
			markdown: expect.stringContaining("slug: not-derived")
		});
	});

	// AC: @plan-embedded-views ac-5
	it("exposes loading placeholders for embedded card areas while batch data is pending", () => {
		const plan = createPlan({
			content: `## Specs

\`\`\`yaml
- title: Alpha Spec
  slug: alpha-spec
\`\`\`
`
		});

		const blocks = buildPlanContentBlocks(plan, { batchLoading: true });

		expect(blocks[1]).toMatchObject({
			type: "embedded",
			embedType: "spec",
			state: "loading"
		});
	});

	// AC: @plan-embedded-views ac-6
	it("falls back to code blocks with an error state when embedded batch loading fails", () => {
		const plan = createPlan({
			content: `## Tasks

\`\`\`yaml
- title: Task Alpha
  slug: task-alpha
\`\`\`
`
		});

		const blocks = buildPlanContentBlocks(plan, { batchError: "boom" });

		expect(blocks[1]).toMatchObject({
			type: "embedded",
			embedType: "task",
			state: "error",
			errorMessage: "boom"
		});
	});

	// AC: @plan-embedded-views ac-3
	it("uses existing item/task detail navigation patterns for embedded cards", async () => {
		const componentSource = await transformWebUiModule(
			"/src/lib/components/plans/PlanEmbeddedBlocks.svelte"
		);

		expect(componentSource).toContain('/items?ref=');
		expect(componentSource).toContain('/tasks?ref=');
		expect(componentSource).toContain('data-testid="plan-embedded-spec-card"');
		expect(componentSource).toContain('data-testid="plan-embedded-task-card"');
	});

	// AC: @plan-embedded-views ac-7
	it("keeps embedded spec cards connected to the structured acceptance-criteria detail view", async () => {
		const [embeddedSource, detailSource] = await Promise.all([
			transformWebUiModule("/src/lib/components/plans/PlanEmbeddedBlocks.svelte"),
			transformWebUiModule("/src/lib/components/ItemDetail.svelte")
		]);

		expect(embeddedSource).toContain("Open spec detail to review full acceptance criteria.");
		expect(detailSource).toContain('data-testid="ac-given-full"');
		expect(detailSource).toContain('data-testid="ac-when-full"');
		expect(detailSource).toContain('data-testid="ac-then-full"');
	});
});
