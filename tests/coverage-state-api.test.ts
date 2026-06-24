import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KspecSnapshot } from "../packages/shared/src/api.js";
import type { TestResultRunRecordInput } from "../src/schema/test-result-runs.js";
import { initContext, writeTestRun } from "../src/parser/index.js";
import { getCachedCoverageStateReadModel } from "../src/parser/coverage-state-read-model.js";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  setupInlineFixtures,
  testUlid,
} from "./daemon-api/helpers.js";

const ITEM_ULID = testUlid("FEAT", 501);
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const modeState = vi.hoisted(() => ({
  snapshot: null as KspecSnapshot | null,
  staticMode: true,
}));

const modeMock = vi.hoisted(() => () => ({
  getSnapshot: () => modeState.snapshot,
  isStaticMode: () => modeState.staticMode,
  assertWritable: (operation: string) => {
    if (modeState.staticMode) {
      throw new Error(`Cannot ${operation} in read-only mode.`);
    }
  },
  ReadOnlyModeError: class ReadOnlyModeError extends Error {
    constructor(operation: string) {
      super(`Cannot ${operation} in read-only mode.`);
    }
  },
}));

vi.mock("$lib/stores/mode.svelte", modeMock);
vi.mock("../packages/web-ui/src/lib/stores/mode.svelte", modeMock);

async function setupCoverageApiProject(): Promise<string> {
  const tempDir = await createTempDir("coverage-state-api-");
  initGitRepo(tempDir);
  setupInlineFixtures(tempDir, {
    skipCommit: true,
    manifest: [
      'kynetic: "1.1"',
      "task_storage:",
      "  format: split",
      "project:",
      "  name: Coverage State API Fixture",
      "includes:",
      "  - modules/coverage.yaml",
      "coverage:",
      "  scan_paths:",
      "    - tests",
      "",
    ].join("\n"),
    modules: {
      "coverage.yaml": [
        `- _ulid: ${ITEM_ULID}`,
        "  slugs: [coverage-api-widget]",
        "  title: Coverage API Widget",
        "  type: feature",
        "  description: Fixture for daemon coverage-state API behavior.",
        "  acceptance_criteria:",
        "    - id: ac-covered",
        "      given: covered criterion",
        "      when: state is requested",
        "      then: it is covered",
        "    - id: ac-failing",
        "      given: failing criterion",
        "      when: state is requested",
        "      then: it is failing",
        "    - id: ac-empty",
        "      given: empty criterion",
        "      when: state is requested",
        "      then: it is not yet covered",
        "",
      ].join("\n"),
    },
  });
  mkdirSync(path.join(tempDir, "tests"), { recursive: true });
  writeFileSync(
    path.join(tempDir, "kspec.config.yaml"),
    ["coverage:", "  scan_paths:", "    - tests", ""].join("\n"),
  );
  writeFileSync(
    path.join(tempDir, "tests", "coverage-api.test.ts"),
    [
      "// AC: @coverage-api-widget ac-covered",
      "it('covers the widget criterion', () => {});",
      "",
    ].join("\n"),
  );
  const ctx = await initContext(tempDir, { syncMode: "skip" });
  await writeTestRun(ctx, normalizedRun(), { skipCommit: true });
  execSync('git add -A && git commit -m "coverage state api fixture"', {
    cwd: tempDir,
    stdio: "pipe",
  });
  return tempDir;
}

function normalizedRun(): TestResultRunRecordInput {
  return {
    format: 1,
    run: {
      id: RUN_ID,
      completed_at: "2026-06-24T12:00:00.000Z",
    },
    producer: {
      kind: "local",
      label: "neutral-runner",
      code_revision: "coverage-api-revision",
    },
    cases: [
      {
        id: "case-failing",
        display_name: "fails mapped criterion",
        status: "failed",
        refs: [{ item_ref: "@coverage-api-widget", ac_id: "ac-failing" }],
      },
      {
        id: "case-unmapped",
        display_name: "has no mapping",
        status: "passed",
        refs: [],
      },
      {
        id: "case-invalid",
        display_name: "has invalid mapping",
        status: "failed",
        refs: [{ item_ref: "@coverage-api-widget", ac_id: "ac-missing" }],
      },
    ],
  };
}

async function json(response: Response): Promise<any> {
  return JSON.parse(await response.text());
}

describe("coverage state daemon API", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      await cleanupTempDir(dir);
    }
  });

  // AC: @coverage-state-api-cache ac-corpus-rollup
  // AC: @coverage-state-api-cache ac-server-computed
  // AC: @trait-api-endpoint ac-1
  // AC: @trait-api-endpoint ac-6
  it("serves server-computed corpus rollups with tracing headers", async () => {
    const tempDir = await setupCoverageApiProject();
    tempDirs.push(tempDir);
    const { app } = createTestApp();

    const response = await makeRequest(app, tempDir, "/api/coverage/state/summary");
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body).toMatchObject({
      data: {
        denominator: 3,
        counts: { covered: 1, failing: 1, not_yet: 1, re_verify: 0 },
        latest_run_id: RUN_ID,
      },
      meta: { cache_status: "ready" },
    });
  });

  // AC: @coverage-state-api-cache ac-item-and-ac-detail
  it("serves item rollups and criterion details with evidence and freshness fields", async () => {
    const tempDir = await setupCoverageApiProject();
    tempDirs.push(tempDir);
    const { app } = createTestApp();

    const itemResponse = await makeRequest(
      app,
      tempDir,
      "/api/coverage/state/items/@coverage-api-widget",
    );
    const criterionResponse = await makeRequest(
      app,
      tempDir,
      "/api/coverage/state/criteria/@coverage-api-widget/ac-failing",
    );

    const itemBody = await json(itemResponse);
    const criterionBody = await json(criterionResponse);

    expect(itemResponse.status).toBe(200);
    expect(itemBody.data).toMatchObject({
      item_ref: "@coverage-api-widget",
      counts: { covered: 1, failing: 1, not_yet: 1, re_verify: 0 },
      criteria: expect.arrayContaining([
        expect.objectContaining({ ac_id: "ac-failing", presentation: "failing" }),
      ]),
    });
    expect(criterionResponse.status).toBe(200);
    expect(criterionBody.data).toMatchObject({
      item_ref: "@coverage-api-widget",
      ac_id: "ac-failing",
      state: "failing_result",
      presentation: "failing",
      explanation: {
        rule: "latest_failed_or_errored_result",
        latestRunId: RUN_ID,
      },
      latest_run_evidence: [
        expect.objectContaining({ run_id: RUN_ID, case_id: "case-failing", status: "failed" }),
      ],
      freshness: expect.any(Object),
      unmapped_result_references: [],
    });
  });

  // AC: @coverage-state-api-cache ac-item-and-ac-detail
  // AC: @trait-api-endpoint ac-4
  it("paginates unmapped result summaries", async () => {
    const tempDir = await setupCoverageApiProject();
    tempDirs.push(tempDir);
    const { app } = createTestApp();

    const response = await makeRequest(
      app,
      tempDir,
      "/api/coverage/state/unmapped?limit=1&offset=1",
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.meta).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ kind: "unmapped", case_id: "case-unmapped" });
  });

  // AC: @coverage-state-api-cache ac-cache-invalidation
  it("refreshes cached state after test-run ingestion mutates coverage evidence", async () => {
    const tempDir = await setupCoverageApiProject();
    tempDirs.push(tempDir);
    const { app } = createTestApp();

    const before = await json(await makeRequest(app, tempDir, "/api/coverage/state/summary"));
    const ingestResponse = await makeRequest(app, tempDir, "/api/coverage/test-results/runs", {
      method: "POST",
      body: JSON.stringify({
        ...normalizedRun(),
        run: { id: "01BRZ3NDEKTSV4RRFFQ69G5FAV", completed_at: "2026-06-24T12:30:00.000Z" },
        cases: [
          {
            id: "case-covered",
            display_name: "covers mapped criterion",
            status: "passed",
            refs: [{ item_ref: "@coverage-api-widget", ac_id: "ac-failing" }],
          },
        ],
      }),
    });
    const after = await json(await makeRequest(app, tempDir, "/api/coverage/state/summary"));

    expect(ingestResponse.status).toBe(200);
    expect(before.data.counts.failing).toBe(1);
    expect(after.data.counts.failing).toBe(0);
    expect(after.data.counts.covered).toBe(2);
  });

  // AC: @coverage-state-events ac-event-topic
  // AC: @coverage-state-events ac-event-canonical-identity
  // AC: @coverage-state-events ac-event-after-cache
  // AC: @coverage-state-events ac-no-event-storm
  // AC: @mutation-event-naming ac-3
  // AC: @trait-websocket-protocol ac-2
  // AC: @trait-websocket-protocol ac-3
  // AC: @trait-websocket-protocol ac-6
  it("broadcasts one typed coverage-state event after the recomputed cache is readable", async () => {
    const tempDir = await setupCoverageApiProject();
    tempDirs.push(tempDir);
    const { app, pubsub } = createTestApp();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const observedAfterCache: Promise<unknown>[] = [];
    const broadcastSpy = vi.spyOn(pubsub, "broadcast").mockImplementation((topic, event, data) => {
      if (topic === "items:updates" && event === "coverage_state_changed") {
        observedAfterCache.push(
          getCachedCoverageStateReadModel(ctx).then((model) => ({
            counts: model.summary.counts,
            affected: data.affected,
          })),
        );
      }
    });

    const response = await makeRequest(app, tempDir, "/api/coverage/test-results/runs", {
      method: "POST",
      body: JSON.stringify({
        ...normalizedRun(),
        run: { id: "01CRZ3NDEKTSV4RRFFQ69G5FAV", completed_at: "2026-06-24T12:45:00.000Z" },
        cases: [
          {
            id: "case-covered",
            display_name: "covers mapped criterion",
            status: "passed",
            refs: [{ item_ref: "@coverage-api-widget", ac_id: "ac-failing" }],
          },
          {
            id: "case-covered-2",
            display_name: "covers another mapped criterion",
            status: "passed",
            refs: [{ item_ref: "@coverage-api-widget", ac_id: "ac-covered" }],
          },
          {
            id: "case-unmapped",
            display_name: "still has no mapping",
            status: "passed",
            refs: [],
          },
        ],
      }),
    });

    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    const coverageStateCalls = broadcastSpy.mock.calls.filter(
      ([topic, event]) => topic === "items:updates" && event === "coverage_state_changed",
    );
    expect(coverageStateCalls).toHaveLength(1);
    expect(coverageStateCalls[0]).toMatchObject([
      "items:updates",
      "coverage_state_changed",
      {
        action: "changed",
        family: "coverage_state",
        run_id: "01CRZ3NDEKTSV4RRFFQ69G5FAV",
        refresh: {
          project_summary: true,
          unmapped_results: true,
        },
        affected: {
          items: [
            {
              item_ref: "@coverage-api-widget",
              item_ulid: ITEM_ULID,
              ac_ids: ["ac-covered", "ac-failing"],
              buckets: ["covered", "re_verify"],
            },
          ],
        },
      },
      tempDir,
    ]);
    const afterCache = await Promise.all(observedAfterCache);
    expect(afterCache).toEqual([
      {
        counts: expect.objectContaining({ failing: 0 }),
        affected: {
          items: [
            {
              item_ref: "@coverage-api-widget",
              item_ulid: ITEM_ULID,
              ac_ids: ["ac-covered", "ac-failing"],
              buckets: ["covered", "re_verify"],
            },
          ],
        },
      },
    ]);
  });

  // AC: @trait-websocket-protocol ac-1 — N/A: coverage-state events do not change connection establishment.
  // AC: @trait-websocket-protocol ac-4 — N/A: coverage-state events do not change heartbeat timing.
  // AC: @trait-websocket-protocol ac-5 — N/A: coverage-state events do not change pong-timeout handling.
  // AC: @trait-websocket-protocol ac-7 — N/A: coverage-state events do not change close codes.
  // AC: @trait-websocket-protocol ac-8 — N/A: coverage-state events use the existing reconnect sequence reset.
  it("documents inherited websocket lifecycle cases as existing foundation behavior", () => {
    expect(true).toBe(true);
  });

  // AC: @trait-api-endpoint ac-2
  it("returns structured 404 for invalid coverage refs", async () => {
    const tempDir = await setupCoverageApiProject();
    tempDirs.push(tempDir);
    const { app } = createTestApp();

    const response = await makeRequest(app, tempDir, "/api/coverage/state/items/@missing-widget");
    const body = await json(response);

    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      error: "not_found",
      message: expect.stringContaining("@missing-widget"),
      suggestion: expect.stringContaining("coverage-api-widget"),
    });
  });

  // AC: @trait-api-endpoint ac-3
  it("returns structured 400 details for invalid pagination query", async () => {
    const tempDir = await setupCoverageApiProject();
    tempDirs.push(tempDir);
    const { app } = createTestApp();

    const response = await makeRequest(app, tempDir, "/api/coverage/state/unmapped?limit=abc");
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: "validation_error",
      details: [{ field: "limit", message: "limit must be a non-negative integer" }],
    });
  });

  // AC: @trait-api-endpoint ac-5 — N/A: coverage-state API reads do not mutate state.
  it("documents mutation endpoint trait case as non-applicable for read endpoints", () => {
    expect(true).toBe(true);
  });
});

describe("coverage state static API", () => {
  // AC: @coverage-state-api-cache ac-static-snapshot
  it("serves last-computed coverage state from static snapshots and refuses ingestion", async () => {
    modeState.snapshot = {
      version: "1.0.0",
      exported_at: "2026-06-24T13:00:00.000Z",
      project: { name: "Static Coverage" },
      tasks: [],
      items: [],
      inbox: [],
      plans: [],
      reviews: [],
      triage: [],
      session: null,
      observations: [],
      agents: [],
      workflows: [],
      conventions: [],
      coverage_state: {
        summary: {
          counts: { covered: 1, failing: 0, not_yet: 0, re_verify: 0 },
          denominator: 1,
          latest_run_id: RUN_ID,
          unmapped_result_count: 0,
          invalid_result_count: 0,
        },
        items: {},
        criteria: {},
        unmapped_results: [],
      },
      alignment: {
        stats: { totalSpecs: 0, specsWithTasks: 0, alignedSpecs: 0, orphanedSpecs: 0 },
        warnings: [],
      },
    } as KspecSnapshot;

    const { fetchCoverageStateSummaryStatic, ingestCoverageTestResultStatic } =
      await import("../packages/web-ui/src/lib/api-static.js");

    expect(fetchCoverageStateSummaryStatic()).toMatchObject({
      data: {
        counts: { covered: 1, failing: 0, not_yet: 0, re_verify: 0 },
        denominator: 1,
      },
      meta: { cache_status: "ready" },
    });
    expect(() => ingestCoverageTestResultStatic()).toThrow(
      "Cannot ingest coverage test results in read-only mode.",
    );
  });
});
