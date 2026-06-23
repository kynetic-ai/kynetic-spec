import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Elysia } from "elysia";
import type { PubSubManager } from "../dist/daemon/websocket/pubsub.js";
import { cleanupTempDir, createTempDir, initGitRepo, kspec, testUlid } from "./helpers/cli.js";
import { captureBroadcasts, createTestApp, makeRequest } from "./daemon-api/helpers.js";
import { initContext, loadTestRun } from "../src/parser/index.js";
import type { TestResultRunRecordInput } from "../src/schema/test-result-runs.js";

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

describe("test result ingestion interface", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      await cleanupTempDir(dir);
    }
  });

  // AC: @test-result-ingestion-interface ac-cli-daemon-equivalence
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
    expect(broadcasts).toHaveBeenCalledWith(
      "items:updates",
      "coverage_evidence_changed",
      expect.objectContaining({
        run_id: SECOND_RUN_ID,
        affected_item_refs: ["@portable-widget"],
        unmapped_count: 1,
        invalid_mapping_count: 1,
      }),
      daemonProject.tempDir,
    );
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
