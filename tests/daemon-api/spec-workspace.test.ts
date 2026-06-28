import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  setupInlineFixtures,
  testUlid,
} from "./helpers.js";

const MODULE_ULID = testUlid("MOD", 901);
const FEATURE_ULID = testUlid("FEAT", 902);
const REQUIREMENT_ULID = testUlid("REQ", 903);
const TASK_ULID = testUlid("TASK", 904);
const PLAN_ULID = testUlid("PLAN", 905);
const SESSION_ULID = testUlid("SESS", 906);

async function json(response: Response): Promise<any> {
  return JSON.parse(await response.text());
}

function writeSession(projectDir: string): void {
  const sessionDir = join(projectDir, ".kspec-sessions", SESSION_ULID);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "session.yaml"),
    [
      `id: ${SESSION_ULID}`,
      "agent_type: codex-acp",
      "agent_id: task-worker",
      "status: completed",
      "session_type: invocation",
      "trigger: task.in_progress",
      "task_id: '@workspace-task'",
      "started_at: 2026-06-28T09:30:00.000Z",
      "ended_at: 2026-06-28T09:45:00.000Z",
      "",
    ].join("\n"),
  );
  writeFileSync(join(sessionDir, "events.jsonl"), "");
}

async function setupSpecWorkspaceProject(): Promise<string> {
  const tempDir = await createTempDir("spec-workspace-api-");
  initGitRepo(tempDir);
  setupInlineFixtures(tempDir, {
    modules: {
      "test.yaml": [
        `_ulid: ${MODULE_ULID}`,
        "slugs: [workspace-module]",
        "title: Workspace Module",
        "type: module",
        "description: Module root",
        "features:",
        `  - _ulid: ${FEATURE_ULID}`,
        "    slugs: [workspace-feature]",
        "    title: Workspace Feature",
        "    type: feature",
        "    tags: [workspace]",
        "    description: Feature detail",
        "    requirements:",
        `      - _ulid: ${REQUIREMENT_ULID}`,
        "        slugs: [workspace-requirement]",
        "        title: Workspace Requirement",
        "        type: requirement",
        "        description: Requirement detail",
        "        acceptance_criteria:",
        "          - id: ac-ready",
        "            given: a workspace fixture",
        "            when: projection is requested",
        "            then: coverage state is projected",
        "          - id: ac-empty",
        "            given: a second criterion",
        "            when: projection is requested",
        "            then: it appears as a sibling",
        "",
      ].join("\n"),
    },
    splitTasks: [
      {
        _ulid: TASK_ULID,
        slugs: ["workspace-task"],
        title: "Workspace linked task",
        type: "task",
        status: "in_progress",
        priority: 1,
        spec_ref: "@workspace-requirement",
        tags: ["workspace"],
        created_at: "2026-06-28T09:00:00.000Z",
      },
    ],
    plans: [
      'kynetic_plans: "1.0"',
      "plans:",
      `  - _ulid: ${PLAN_ULID}`,
      "    slugs: [workspace-plan]",
      "    title: Workspace Plan",
      "    status: active",
      "    derived_specs:",
      "      - '@workspace-requirement'",
      "    derived_tasks:",
      "      - '@workspace-task'",
      "    notes_count: 0",
      "    created_at: 2026-06-28T08:00:00Z",
      "",
    ].join("\n"),
  });
  writeSession(tempDir);
  execSync('git add -A && git commit -m "add linked workspace session"', {
    cwd: tempDir,
    stdio: "pipe",
  });
  return tempDir;
}

describe("spec workspace projection API", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await cleanupTempDir(dir);
    }
  });

  // AC: @unified-spec-workspace-data-projection ac-bounded-root-projection
  // AC: @unified-spec-workspace-data-projection ac-coverage-source-of-truth
  // AC: @trait-api-endpoint ac-1
  // AC: @trait-api-endpoint ac-4
  // AC: @trait-api-endpoint ac-6
  it("serves a bounded root projection with corpus counts and coverage summary", async () => {
    const tempDir = await setupSpecWorkspaceProject();
    tempDirs.push(tempDir);
    const { app } = createTestApp();

    const rootResponse = await makeRequest(app, tempDir, "/api/spec-workspace/root?limit=1");
    const root = await json(rootResponse);
    const coverage = await json(await makeRequest(app, tempDir, "/api/coverage/state/summary"));

    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get("X-Request-Id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(root.meta).toMatchObject({ total: 1, limit: 1, offset: 0 });
    expect(root.data).toMatchObject({
      kind: "root",
      corpus: {
        items: 3,
        acceptance_criteria: 2,
        by_type: { module: 1, feature: 1, requirement: 1 },
      },
      coverage_summary: coverage.data,
      pagination: { total: 1, limit: 1, offset: 0, has_more: false },
    });
    expect(root.data.top_level_nodes).toHaveLength(1);
    expect(root.data.top_level_nodes[0]).toMatchObject({
      ref: "@workspace-module",
      child_count: 1,
      coverage_counts: { covered: 0, failing: 0, not_yet: 0, re_verify: 0 },
    });
  });

  // AC: @unified-spec-workspace-data-projection ac-node-detail-projection
  // AC: @unified-spec-workspace-data-projection ac-linked-work-definition
  it("serves node detail with ancestors, bounded child sections, criteria, and linked work", async () => {
    const tempDir = await setupSpecWorkspaceProject();
    tempDirs.push(tempDir);
    const { app } = createTestApp();

    const response = await makeRequest(
      app,
      tempDir,
      "/api/spec-workspace/nodes/@workspace-requirement?limit=1",
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      kind: "node",
      node: {
        ref: "@workspace-requirement",
        acceptance_criteria_count: 2,
        linked_work_counts: { task: 1, session: 1, plan: 1 },
      },
      ancestors: [
        { ref: MODULE_ULID, title: "Workspace Module", kind: "module" },
        { ref: FEATURE_ULID, title: "Workspace Feature", kind: "feature" },
        { ref: REQUIREMENT_ULID, title: "Workspace Requirement", kind: "requirement" },
      ],
      child_sections: [],
      acceptance_criteria: [
        expect.objectContaining({ id: "ac-ready", coverage: expect.any(Object) }),
        expect.objectContaining({ id: "ac-empty" }),
      ],
    });
    expect(body.data.linked_work).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task",
          inclusion_rule: expect.stringContaining("task.spec_ref"),
          total: 1,
          items: [expect.objectContaining({ ref: "@workspace-task", status: "in_progress" })],
        }),
        expect.objectContaining({
          kind: "plan",
          inclusion_rule: expect.stringContaining("derived_specs"),
          total: 1,
          items: [expect.objectContaining({ ref: "@workspace-plan", status: "active" })],
        }),
        expect.objectContaining({
          kind: "session",
          inclusion_rule: expect.stringContaining("task_id"),
          total: 1,
          items: [expect.objectContaining({ ref: SESSION_ULID, status: "completed" })],
        }),
        expect.objectContaining({
          kind: "review",
          unavailable: expect.objectContaining({ status: "unavailable" }),
        }),
      ]),
    );
  });

  // AC: @unified-spec-workspace-data-projection ac-ac-detail-projection
  it("serves criterion detail with parent chain, evidence summaries, siblings, and links", async () => {
    const tempDir = await setupSpecWorkspaceProject();
    tempDirs.push(tempDir);
    const { app } = createTestApp();

    const response = await makeRequest(
      app,
      tempDir,
      "/api/spec-workspace/criteria/@workspace-requirement/ac-ready",
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      kind: "criterion",
      parent: { ref: "@workspace-requirement" },
      criterion: {
        id: "ac-ready",
        given: "a workspace fixture",
        coverage: expect.objectContaining({
          ac_id: "ac-ready",
          presentation: "not_yet",
        }),
      },
      evidence: {
        latest_run: [],
        unmapped_results: [],
        reverify_causes: [],
      },
      siblings: [
        expect.objectContaining({ id: "ac-ready" }),
        expect.objectContaining({ id: "ac-empty" }),
      ],
    });
    expect(
      body.data.linked_work.find((group: { kind: string }) => group.kind === "task").total,
    ).toBe(1);
  });

  // AC: @unified-spec-workspace-data-projection ac-endpoint-contract
  // AC: @unified-spec-workspace-data-projection ac-error-guidance-contract
  // AC: @unified-spec-workspace-data-projection ac-error-boundaries
  // AC: @trait-api-endpoint ac-2
  // AC: @trait-api-endpoint ac-3
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  // AC: @trait-error-guidance ac-3
  // AC: @trait-error-guidance ac-5
  // AC: @trait-error-guidance ac-6
  it("returns guided errors for missing refs, missing criteria, and invalid pagination", async () => {
    const tempDir = await setupSpecWorkspaceProject();
    tempDirs.push(tempDir);
    const { app } = createTestApp();

    const missingNode = await json(
      await makeRequest(app, tempDir, "/api/spec-workspace/nodes/@missing-node"),
    );
    const missingCriterionResponse = await makeRequest(
      app,
      tempDir,
      "/api/spec-workspace/criteria/@workspace-requirement/ac-missing",
    );
    const missingCriterion = await json(missingCriterionResponse);
    const invalidPaginationResponse = await makeRequest(
      app,
      tempDir,
      "/api/spec-workspace/root?limit=abc",
    );
    const invalidPagination = await json(invalidPaginationResponse);

    expect(missingNode).toMatchObject({
      error: "not_found",
      message: expect.stringContaining("@missing-node"),
      suggestion: expect.stringContaining("kspec search"),
    });
    expect(missingCriterionResponse.status).toBe(404);
    expect(missingCriterion).toMatchObject({
      error: "not_found",
      message: expect.stringContaining("ac-missing"),
      suggestion: expect.stringContaining("available criteria"),
    });
    expect(invalidPaginationResponse.status).toBe(400);
    expect(invalidPagination).toMatchObject({
      error: "validation_error",
      details: [{ field: "limit", message: expect.stringContaining("non-negative integer") }],
      suggestion: expect.stringContaining("pagination"),
    });
  });

  // AC: @unified-spec-workspace-data-projection ac-read-endpoints-do-not-commit
  // AC: @trait-api-endpoint ac-5 — N/A: spec workspace projection endpoints are read-only.
  // AC: @trait-error-guidance ac-4 — N/A: spec workspace projection endpoints do not perform state transitions.
  it("does not commit or mutate state while serving read projections", async () => {
    const tempDir = await setupSpecWorkspaceProject();
    tempDirs.push(tempDir);
    const before = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf8" }).trim();
    const { app } = createTestApp();

    await makeRequest(app, tempDir, "/api/spec-workspace/root");
    await makeRequest(app, tempDir, "/api/spec-workspace/nodes/@workspace-requirement");
    await makeRequest(app, tempDir, "/api/spec-workspace/criteria/@workspace-requirement/ac-ready");

    const after = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf8" }).trim();
    const status = execSync("git status --short", { cwd: tempDir, encoding: "utf8" }).trim();
    expect(after).toBe(before);
    expect(status).toBe("");
  });
});
