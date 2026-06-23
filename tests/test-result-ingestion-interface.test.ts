import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Elysia } from "elysia";
import type {
  EntityCacheAccessor,
  RouteEntityCache,
} from "../dist/daemon/routes/entity-cache-types.js";
import type { PubSubManager } from "../dist/daemon/websocket/pubsub.js";
import { cleanupTempDir, createTempDir, initGitRepo, kspec, testUlid } from "./helpers/cli.js";
import { captureBroadcasts, createTestApp, makeRequest } from "./daemon-api/helpers.js";
import {
  initContext,
  loadTestRun,
  readVerificationStamp,
  resolveAcFreshness,
  writeVerificationStamp,
} from "../src/parser/index.js";
import type { TestResultRunRecordInput } from "../src/schema/test-result-runs.js";
import type { VerificationStampInput } from "../src/schema/verification-records.js";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SECOND_RUN_ID = "01BRZ3NDEKTSV4RRFFQ69G5FAV";
const SESSION_ID = "01CRZ3NDEKTSV4RRFFQ69G5FAV";

interface IngestionProject {
  tempDir: string;
  featureUlid: string;
}

async function writeProjectFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function setupIngestionProject(name: string): Promise<IngestionProject> {
  const tempDir = await createTempDir(`kspec-ingestion-${name}-`);
  const featureUlid = testUlid("FEAT", 30);
  initGitRepo(tempDir);
  await fs.mkdir(path.join(tempDir, ".kspec"), { recursive: true });
  await writeProjectFile(
    path.join(tempDir, "kynetic.yaml"),
    [
      'kynetic: "1.1"',
      "project:",
      `  name: ${name}`,
      "includes:",
      "  - specs/widget.yaml",
      "",
    ].join("\n"),
  );
  await writeProjectFile(
    path.join(tempDir, "specs", "widget.yaml"),
    [
      `- _ulid: ${featureUlid}`,
      "  title: Portable Widget",
      "  slugs: [portable-widget]",
      "  type: feature",
      "  description: Neutral ingestion interface fixture.",
      "  acceptance_criteria:",
      "    - id: ac-renders-widget",
      "      given: a portable widget exists",
      "      when: a normalized result references it",
      "      then: the ingestion interface maps it to the criterion",
      "",
    ].join("\n"),
  );
  execSync('git add -A && git commit -m "fixture"', { cwd: tempDir, stdio: "pipe" });
  return { tempDir, featureUlid };
}

function normalizedPayload(
  overrides: Partial<TestResultRunRecordInput> = {},
): TestResultRunRecordInput {
  return {
    format: 1,
    run: {
      id: RUN_ID,
      completed_at: "2026-06-23T12:00:00.000Z",
      started_at: "2026-06-23T11:59:00.000Z",
      duration_ms: 60000,
    },
    producer: {
      kind: "local",
      label: "neutral-runner",
      command: "touch daemon-command-was-run",
      code_revision: "abc123",
    },
    cases: [
      {
        id: "case-mapped",
        display_name: "maps a portable widget criterion",
        status: "passed",
        location: { file: "checks/widget.contract", line: 7 },
        refs: [{ item_ref: "@portable-widget", ac_id: "ac-renders-widget" }],
      },
      {
        id: "case-unmapped",
        display_name: "keeps an unmapped neutral case",
        status: "skipped",
        refs: [],
      },
      {
        id: "case-invalid",
        display_name: "keeps invalid mapping diagnostics",
        status: "failed",
        refs: [{ item_ref: "@portable-widget", ac_id: "ac-missing" }],
      },
    ],
    ...overrides,
  };
}

async function writePayload(tempDir: string, payload: unknown): Promise<string> {
  const payloadPath = path.join(tempDir, "payload.json");
  await fs.writeFile(payloadPath, JSON.stringify(payload, null, 2));
  return payloadPath;
}

function parseJson(stdout: string) {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function existingStamp(overrides: Partial<VerificationStampInput> = {}): VerificationStampInput {
  return {
    verified_at: "2026-06-22T10:00:00.000Z",
    actor: "previous-verifier",
    provenance: "validation",
    commit: "before-ingestion",
    ...overrides,
  };
}

function createCacheTracker(): {
  getEntityCache: EntityCacheAccessor;
  writeThrough: RouteEntityCache["writeThrough"];
} {
  const writeThrough = vi.fn<RouteEntityCache["writeThrough"]>(async () => {});
  const cache = { writeThrough } as unknown as RouteEntityCache;
  const getEntityCache = vi.fn<EntityCacheAccessor>(() => cache);
  return { getEntityCache, writeThrough };
}

describe("test result ingestion interface", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      await cleanupTempDir(dir);
    }
  });

  // AC: @test-result-ingestion-interface ac-cli-daemon-equivalence
  // AC: @ingested-run-verification-stamps ac-passing-mapped-writes-stamp
  // AC: @ingested-run-verification-stamps ac-stamp-store-contract-preserved
  // AC: @ingested-run-verification-stamps ac-stamp-cli-daemon-equivalence
  // AC: @test-result-acquisition ac-1
  // AC: @test-result-acquisition ac-2
  // AC: @test-result-ingestion-interface ac-no-daemon-execution
  // AC: @test-result-ingestion-interface ac-actor-source-attribution
  // AC: @test-result-ingestion-interface ac-session-attribution-optional
  // AC: @trait-json-output ac-1
  // AC: @trait-json-output ac-2
  // AC: @trait-json-output ac-4
  // AC: @trait-json-output ac-5 — N/A: ingestion summary contains no timestamps
  // AC: @trait-json-output ac-6 — N/A: ingestion has no alternate formatting flags
  // AC: @trait-semantic-exit-codes ac-1
  // AC: @trait-error-guidance ac-3 — N/A: missing AC mappings are retained diagnostics, not ref lookup failures
  // AC: @trait-error-guidance ac-4 — N/A: ingestion has no state transition
  it("stores equivalent runs and summaries through CLI and daemon", async () => {
    const cliProject = await setupIngestionProject("cli");
    const daemonProject = await setupIngestionProject("daemon");
    tempDirs.push(cliProject.tempDir, daemonProject.tempDir);
    const cliPayloadPath = await writePayload(cliProject.tempDir, normalizedPayload());
    const daemonPayload = normalizedPayload({
      run: { ...normalizedPayload().run, id: SECOND_RUN_ID },
    });
    const { app, pubsub } = createTestApp();
    const broadcasts = captureBroadcasts(pubsub);

    const cli = kspec(
      `coverage test-result ingest --file ${JSON.stringify(cliPayloadPath)} --session ${SESSION_ID} --json`,
      cliProject.tempDir,
      { env: { KSPEC_AUTHOR: "Jacob Chapel" } },
    );
    expect(cli.exitCode).toBe(0);
    const cliSummary = parseJson(cli.stdout);

    const daemonResponse = await makeRequest(
      app,
      daemonProject.tempDir,
      `/api/coverage/test-results/runs?session_id=${SESSION_ID}`,
      {
        method: "POST",
        body: JSON.stringify(daemonPayload),
      },
    );
    const daemonText = await daemonResponse.text();
    expect(daemonResponse.status, daemonText).toBe(200);
    const daemonBody = JSON.parse(daemonText);
    const daemonSummary = daemonBody.data;

    const cliStored = await loadTestRun(
      await initContext(cliProject.tempDir, { syncMode: "skip" }),
      RUN_ID,
    );
    const daemonStored = await loadTestRun(
      await initContext(daemonProject.tempDir, { syncMode: "skip" }),
      SECOND_RUN_ID,
    );

    expect(cliStored?.mapping).toEqual(daemonStored?.mapping);
    expect(cliStored?.producer).toMatchObject({
      actor: "Jacob Chapel",
      agent_session: SESSION_ID,
      kind: "local",
      label: "neutral-runner",
      command: "touch daemon-command-was-run",
    });
    expect(daemonStored?.producer).toEqual(cliStored?.producer);
    expect(existsSync(path.join(daemonProject.tempDir, "daemon-command-was-run"))).toBe(false);
    expect({ ...cliSummary, run_id: "<run>" }).toEqual({
      ...daemonSummary,
      run_id: "<run>",
    });
    expect(cliSummary).toMatchObject({
      stamps_written_count: 1,
      non_positive_mapped_case_count: 0,
    });
    expect(cliStored?.verification_effects).toEqual(daemonStored?.verification_effects);
    expect(cliStored?.verification_effects.stamps_written).toEqual([
      {
        case_id: "case-mapped",
        item_ulid: cliProject.featureUlid,
        ac_id: "ac-renders-widget",
        verified_at: "2026-06-23T12:00:00.000Z",
      },
    ]);
    expect(cliStored?.verification_effects.non_positive_mapped_cases).toEqual([]);

    const cliStamp = await readVerificationStamp(
      await initContext(cliProject.tempDir, { syncMode: "skip" }),
      cliProject.featureUlid,
      "ac-renders-widget",
    );
    const daemonStamp = await readVerificationStamp(
      await initContext(daemonProject.tempDir, { syncMode: "skip" }),
      daemonProject.featureUlid,
      "ac-renders-widget",
    );
    expect(cliStamp).toEqual({
      verified_at: "2026-06-23T12:00:00.000Z",
      actor: "Jacob Chapel",
      provenance: "ingestion",
      commit: "abc123",
      session: SESSION_ID,
    });
    expect(daemonStamp).toEqual(cliStamp);
    expect(broadcasts).toHaveBeenCalledWith(
      "items:updates",
      "coverage_evidence_changed",
      expect.objectContaining({
        run_id: SECOND_RUN_ID,
        affected_item_refs: ["@portable-widget"],
        stamps_written_count: 1,
        non_positive_mapped_case_count: 0,
        unmapped_count: 1,
        invalid_mapping_count: 1,
      }),
      daemonProject.tempDir,
    );
  });

  // AC: @ingested-run-verification-stamps ac-nonpassing-no-positive-stamp
  // AC: @ingested-run-verification-stamps ac-unmapped-no-stamp
  // AC: @test-result-acquisition ac-2
  it("records non-positive mapped evidence without writing positive stamps", async () => {
    const project = await setupIngestionProject("non-positive");
    tempDirs.push(project.tempDir);
    const payloadPath = await writePayload(
      project.tempDir,
      normalizedPayload({
        cases: [
          {
            id: "case-failed",
            display_name: "failed mapped case",
            status: "failed",
            refs: [{ item_ref: "@portable-widget", ac_id: "ac-renders-widget" }],
          },
          {
            id: "case-errored",
            display_name: "errored mapped case",
            status: "errored",
            refs: [{ item_ref: "@portable-widget", ac_id: "ac-renders-widget" }],
          },
          {
            id: "case-skipped",
            display_name: "skipped mapped case",
            status: "skipped",
            refs: [{ item_ref: "@portable-widget", ac_id: "ac-renders-widget" }],
          },
          {
            id: "case-unknown",
            display_name: "unknown mapped case",
            status: "unknown",
            refs: [{ item_ref: "@portable-widget", ac_id: "ac-renders-widget" }],
          },
          {
            id: "case-unmapped",
            display_name: "unmapped case",
            status: "passed",
            refs: [],
          },
          {
            id: "case-invalid",
            display_name: "invalid mapped case",
            status: "passed",
            refs: [{ item_ref: "@portable-widget", ac_id: "ac-missing" }],
          },
        ],
      }),
    );

    const result = kspec(
      `coverage test-result ingest --file ${JSON.stringify(payloadPath)} --json`,
      project.tempDir,
    );

    expect(result.exitCode).toBe(0);
    const summary = parseJson(result.stdout);
    expect(summary).toMatchObject({
      stamps_written_count: 0,
      non_positive_mapped_case_count: 4,
      mapped_criterion_count: 4,
      unmapped_count: 1,
      invalid_mapping_count: 1,
    });

    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    const stored = await loadTestRun(ctx, RUN_ID);
    expect(stored?.verification_effects.stamps_written).toEqual([]);
    expect(stored?.verification_effects.non_positive_mapped_cases).toEqual([
      {
        case_id: "case-failed",
        item_ulid: project.featureUlid,
        item_ref: "@portable-widget",
        ac_id: "ac-renders-widget",
        status: "failed",
      },
      {
        case_id: "case-errored",
        item_ulid: project.featureUlid,
        item_ref: "@portable-widget",
        ac_id: "ac-renders-widget",
        status: "errored",
      },
      {
        case_id: "case-skipped",
        item_ulid: project.featureUlid,
        item_ref: "@portable-widget",
        ac_id: "ac-renders-widget",
        status: "skipped",
      },
      {
        case_id: "case-unknown",
        item_ulid: project.featureUlid,
        item_ref: "@portable-widget",
        ac_id: "ac-renders-widget",
        status: "unknown",
      },
    ]);
    expect(stored?.mapping.unmapped.map((entry) => entry.case_id)).toEqual(["case-unmapped"]);
    expect(stored?.mapping.invalid.map((entry) => entry.case_id)).toEqual(["case-invalid"]);
    await expect(
      readVerificationStamp(ctx, project.featureUlid, "ac-renders-widget"),
    ).resolves.toBeUndefined();
  });

  // AC: @ingested-run-verification-stamps ac-passing-mapped-writes-stamp
  // AC: @ingested-run-verification-stamps ac-latest-ingested-run-freshness
  // AC: @annotation-freshness-provenance ac-2
  // AC: @test-result-acquisition ac-3
  it("replaces existing stamps and freshness resolves to latest ingested evidence", async () => {
    const project = await setupIngestionProject("freshness");
    tempDirs.push(project.tempDir);
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    await writeVerificationStamp(ctx, project.featureUlid, "ac-renders-widget", existingStamp());

    const firstPayloadPath = await writePayload(project.tempDir, normalizedPayload());
    const first = kspec(
      `coverage test-result ingest --file ${JSON.stringify(firstPayloadPath)} --json`,
      project.tempDir,
      { env: { KSPEC_AUTHOR: "first ingestion actor" } },
    );
    expect(first.exitCode).toBe(0);

    const secondPayloadPath = await writePayload(
      project.tempDir,
      normalizedPayload({
        run: {
          id: SECOND_RUN_ID,
          completed_at: "2026-06-23T13:00:00.000Z",
          started_at: "2026-06-23T12:59:00.000Z",
          duration_ms: 60000,
        },
        producer: {
          kind: "ci",
          label: "neutral-ci-runner",
          code_revision: "def456",
        },
      }),
    );
    const second = kspec(
      `coverage test-result ingest --file ${JSON.stringify(secondPayloadPath)} --json`,
      project.tempDir,
      { env: { KSPEC_AUTHOR: "second ingestion actor" } },
    );
    expect(second.exitCode).toBe(0);

    const refreshedCtx = await initContext(project.tempDir, { syncMode: "skip" });
    const stamp = await readVerificationStamp(
      refreshedCtx,
      project.featureUlid,
      "ac-renders-widget",
    );
    expect(stamp).toEqual({
      verified_at: "2026-06-23T13:00:00.000Z",
      actor: "second ingestion actor",
      provenance: "ingestion",
      commit: "def456",
    });

    const freshness = await resolveAcFreshness(
      refreshedCtx,
      project.featureUlid,
      "ac-renders-widget",
      [],
    );
    expect(freshness).toMatchObject({
      kind: "freshness",
      value: {
        source: "recorded",
        timestamp: "2026-06-23T13:00:00.000Z",
        commit: "def456",
        stamp: {
          provenance: "ingestion",
          actor: "second ingestion actor",
        },
      },
    });
  });

  // AC: @ingested-run-verification-stamps ac-stamp-store-contract-preserved
  it("rolls back the run write when the verification stamp write is refused", async () => {
    const project = await setupIngestionProject("rollback");
    tempDirs.push(project.tempDir);
    const verificationPath = path.join(
      project.tempDir,
      "coverage",
      "verifications",
      `${project.featureUlid}.yaml`,
    );
    await writeProjectFile(
      verificationPath,
      ["format: 999", "acs:", "  ac-renders-widget:", "    actor: old", ""].join("\n"),
    );
    const payloadPath = await writePayload(project.tempDir, normalizedPayload());

    const result = kspec(
      `coverage test-result ingest --file ${JSON.stringify(payloadPath)} --json`,
      project.tempDir,
      { expectFail: true },
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("verification_record_format_newer_than_supported");
    expect(
      existsSync(path.join(project.tempDir, "coverage", "test-runs", "runs", RUN_ID, "run.yaml")),
    ).toBe(false);
    await expect(
      readVerificationStamp(
        await initContext(project.tempDir, { syncMode: "skip" }),
        project.featureUlid,
        "ac-renders-widget",
      ),
    ).rejects.toThrow("verification_record_format_newer_than_supported");
  });

  // AC: @test-result-ingestion-interface ac-dry-run-preview
  // AC: @trait-dry-run ac-1
  // AC: @trait-dry-run ac-2
  // AC: @trait-dry-run ac-3
  // AC: @trait-dry-run ac-5 — N/A: ingestion exposes no --force option
  // AC: @trait-dry-run ac-6
  it("previews CLI ingestion without writing run files", async () => {
    const project = await setupIngestionProject("dry-run");
    tempDirs.push(project.tempDir);
    const payloadPath = await writePayload(project.tempDir, normalizedPayload());

    const result = kspec(
      `coverage test-result ingest --file ${JSON.stringify(payloadPath)} --dry-run --json`,
      project.tempDir,
    );

    expect(result.exitCode).toBe(0);
    const summary = parseJson(result.stdout);
    expect(summary).toMatchObject({
      run_id: RUN_ID,
      dry_run: true,
      stored: false,
      case_count: 3,
      mapped_criterion_count: 1,
      unmapped_count: 1,
      invalid_mapping_count: 1,
    });
    expect(
      existsSync(path.join(project.tempDir, "coverage", "test-runs", "runs", RUN_ID, "run.yaml")),
    ).toBe(false);
  });

  // AC: @test-result-ingestion-interface ac-dry-run-preview
  // AC: @trait-dry-run ac-1
  // AC: @trait-dry-run ac-2
  // AC: @trait-dry-run ac-3
  // AC: @trait-dry-run ac-6
  it("previews daemon ingestion without write-through or broadcasts", async () => {
    const project = await setupIngestionProject("daemon-dry-run");
    tempDirs.push(project.tempDir);
    const { getEntityCache, writeThrough } = createCacheTracker();
    const { app, pubsub } = createTestApp({ getEntityCache });
    const broadcasts = captureBroadcasts(pubsub);

    const response = await makeRequest(
      app,
      project.tempDir,
      "/api/coverage/test-results/runs?dry_run=true",
      {
        method: "POST",
        body: JSON.stringify(normalizedPayload()),
      },
    );

    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    const body = JSON.parse(responseText);
    expect(body.data).toMatchObject({
      run_id: RUN_ID,
      dry_run: true,
      stored: false,
      case_count: 3,
      mapped_criterion_count: 1,
      unmapped_count: 1,
      invalid_mapping_count: 1,
      affected_item_refs: ["@portable-widget"],
      event_scopes: [
        { type: "item", ref: "@portable-widget", reason: "mapped_criteria" },
        { type: "project", ref: "@project", reason: "unmapped_results" },
        { type: "project", ref: "@project", reason: "invalid_mappings" },
      ],
    });
    expect(broadcasts).not.toHaveBeenCalled();
    expect(writeThrough).not.toHaveBeenCalled();
    expect(existsSync(path.join(project.tempDir, "coverage", "test-runs"))).toBe(false);
    expect(
      await loadTestRun(await initContext(project.tempDir, { syncMode: "skip" }), RUN_ID),
    ).toBeUndefined();
  });

  // AC: @test-result-ingestion-interface ac-dry-run-preview
  // AC: @trait-json-output ac-3
  // AC: @trait-semantic-exit-codes ac-2
  // AC: @trait-semantic-exit-codes ac-3 — N/A: ingestion has no confirmation prompt
  // AC: @trait-semantic-exit-codes ac-5 — N/A: ingestion is not a query command
  // AC: @trait-semantic-exit-codes ac-6
  // AC: @trait-semantic-exit-codes ac-7 — N/A: ingestion has no batch partial-success mode
  // AC: @trait-semantic-exit-codes ac-8
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  // AC: @trait-error-guidance ac-5
  // AC: @trait-error-guidance ac-6
  // AC: @trait-dry-run ac-4
  it("returns structured JSON validation guidance without changing state", async () => {
    const project = await setupIngestionProject("invalid");
    tempDirs.push(project.tempDir);
    const payloadPath = await writePayload(project.tempDir, {
      run: { id: RUN_ID },
      producer: { kind: "local", label: "neutral-runner" },
      cases: [],
    });

    const result = kspec(
      `coverage test-result ingest --file ${JSON.stringify(payloadPath)} --dry-run --json`,
      project.tempDir,
      { expectFail: true },
    );

    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.stderr) as { error: string; details: { details: unknown[] } };
    expect(body.error).toBe("Invalid test-result ingestion input.");
    expect(Array.isArray(body.details.details)).toBe(true);
    expect(result.stdout).toBe("");
    expect(existsSync(path.join(project.tempDir, "coverage", "test-runs"))).toBe(false);
  });

  // AC: @test-result-ingestion-interface ac-mutation-pipeline-order
  // AC: @trait-api-endpoint ac-1
  // AC: @trait-api-endpoint ac-5
  // AC: @trait-api-endpoint ac-6
  it("daemon broadcasts after the run is readable and includes request id", async () => {
    const project = await setupIngestionProject("event-order");
    tempDirs.push(project.tempDir);
    const { app, pubsub } = createTestApp();
    const observedReadable: boolean[] = [];
    vi.spyOn(pubsub as PubSubManager, "broadcast").mockImplementation((topic, event) => {
      if (topic === "items:updates" && event === "coverage_evidence_changed") {
        observedReadable.push(
          existsSync(
            path.join(project.tempDir, "coverage", "test-runs", "runs", RUN_ID, "run.yaml"),
          ),
        );
      }
    });

    const response = await makeRequest(
      app as Elysia,
      project.tempDir,
      "/api/coverage/test-results/runs",
      {
        method: "POST",
        body: JSON.stringify(normalizedPayload()),
      },
    );

    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
    expect(observedReadable).toEqual([true]);
    expect(
      await loadTestRun(await initContext(project.tempDir, { syncMode: "skip" }), RUN_ID),
    ).toBeTruthy();
  });

  // AC: @test-result-ingestion-interface ac-static-mode-readonly
  // AC: @trait-semantic-exit-codes ac-4
  it("refuses daemon ingestion in read-only/static mode", async () => {
    const project = await setupIngestionProject("readonly");
    tempDirs.push(project.tempDir);
    const payloadPath = await writePayload(project.tempDir, normalizedPayload());

    const cliResult = kspec(
      `coverage test-result ingest --file ${JSON.stringify(payloadPath)} --json`,
      project.tempDir,
      { expectFail: true, env: { KSPEC_STATIC_MODE: "1" } },
    );
    expect(cliResult.exitCode).toBe(3);

    const { app } = createTestApp();

    const response = await makeRequest(app, project.tempDir, "/api/coverage/test-results/runs", {
      method: "POST",
      headers: { "X-Kspec-Static": "true" },
      body: JSON.stringify(normalizedPayload()),
    });

    const responseText = await response.text();
    expect(response.status, responseText).toBe(409);
    const body = JSON.parse(responseText);
    expect(body).toMatchObject({
      error: "read_only",
      code: "test_result_ingestion_read_only",
    });
    expect(existsSync(path.join(project.tempDir, "coverage", "test-runs"))).toBe(false);
  });

  // AC: @trait-api-endpoint ac-3
  // AC: @trait-api-endpoint ac-2 — N/A: accepted invalid AC mappings are retained diagnostics, not 404 ref failures
  // AC: @trait-api-endpoint ac-4 — N/A: ingestion is a mutation endpoint, not a paginated list endpoint
  it("returns 400 details for invalid daemon bodies", async () => {
    const project = await setupIngestionProject("api-invalid");
    tempDirs.push(project.tempDir);
    const { app } = createTestApp();

    const response = await makeRequest(app, project.tempDir, "/api/coverage/test-results/runs", {
      method: "POST",
      body: JSON.stringify({ cases: [] }),
    });

    const responseText = await response.text();
    expect(response.status, responseText).toBe(400);
    const body = JSON.parse(responseText);
    expect(body.error).toBe("validation_error");
    expect(Array.isArray(body.details)).toBe(true);
  });
});
