import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractAcceptanceCriterionRefsFromText } from "../src/parser/test-result-ac-tokens.js";
import { initContext, loadTestRun } from "../src/parser/index.js";
import {
  CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
  type TestResultRunRecordInput,
} from "../src/schema/test-result-runs.js";
import { cleanupTempDir, createTempDir, initGitRepo, kspec, testUlid } from "./helpers/cli.js";

const EXPLICIT_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TOKEN_RUN_ID = "01BRZ3NDEKTSV4RRFFQ69G5FAV";
const NORMALIZED_AFTER_NATIVE_RUN_ID = "01CRZ3NDEKTSV4RRFFQ69G5FAV";

interface ProducerContractProject {
  tempDir: string;
  featureUlid: string;
  specRef: string;
  acId: string;
  sourceFile: string;
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function setupProducerProject(options: {
  name: string;
  manifestIncludes: string[];
  specPath: string;
  sourcePath: string;
  specSlug: string;
  acId: string;
}): Promise<ProducerContractProject> {
  const tempDir = await createTempDir(`kspec-producer-contract-${options.name}-`);
  const featureUlid = testUlid("FEAT", options.name === "explicit" ? 41 : 42);
  initGitRepo(tempDir);
  await writeFile(
    path.join(tempDir, "kynetic.yaml"),
    [
      'kynetic: "1.1"',
      "project:",
      `  name: ${options.name}-portable-suite`,
      "includes:",
      ...options.manifestIncludes.map((include) => `  - ${include}`),
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(tempDir, options.specPath),
    [
      `- _ulid: ${featureUlid}`,
      "  title: Portable Contract",
      `  slugs: [${options.specSlug}]`,
      "  type: feature",
      "  description: Neutral producer contract fixture.",
      "  acceptance_criteria:",
      `    - id: ${options.acId}`,
      "      given: a portable producer emits a normalized case",
      "      when: the run is ingested",
      "      then: the case is attributed to this criterion",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(tempDir, options.sourcePath), "source before ingestion\n");
  return {
    tempDir,
    featureUlid,
    specRef: `@${options.specSlug}`,
    acId: options.acId,
    sourceFile: options.sourcePath,
  };
}

function producerPayload(options: {
  runId: string;
  producer: TestResultRunRecordInput["producer"];
  specRef: string;
  acId: string;
  cases?: TestResultRunRecordInput["cases"];
}): TestResultRunRecordInput {
  return {
    format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
    run: {
      id: options.runId,
      completed_at: "2026-06-23T18:00:00.000Z",
      started_at: "2026-06-23T17:59:30.000Z",
      duration_ms: 30000,
    },
    producer: options.producer,
    cases: options.cases ?? [
      {
        id: "portable-contract/checks-explicit-ref",
        display_name: "checks explicit normalized ref",
        suite_path: ["producer contract", "explicit refs"],
        status: "passed",
        duration_ms: 18,
        location: { file: "acceptance/portable-contract.check", line: 12 },
        refs: [{ item_ref: options.specRef, ac_id: options.acId }],
      },
      {
        id: "portable-contract/retains-diagnostics",
        display_name: "retains failed diagnostic text",
        suite_path: ["producer contract", "diagnostics"],
        status: "failed",
        diagnostic: "expected portable output, received empty stream",
        refs: [{ item_ref: options.specRef, ac_id: options.acId }],
      },
      {
        id: "portable-contract/locationless-skipped",
        display_name: "keeps locationless skipped case",
        status: "skipped",
        refs: [],
      },
    ],
  };
}

async function writePayload(tempDir: string, name: string, payload: unknown): Promise<string> {
  const payloadPath = path.join(tempDir, `${name}.json`);
  await fs.writeFile(payloadPath, JSON.stringify(payload, null, 2));
  return payloadPath;
}

function expectSuccessfulIngestion(result: ReturnType<typeof kspec>): Record<string, unknown> {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("test result producer contract fixtures", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await cleanupTempDir(dir);
    }
  });

  // AC: @normalized-test-result-ingestion-contract ac-owned-envelope
  // AC: @normalized-test-result-ingestion-contract ac-status-vocabulary
  // AC: @normalized-test-result-ingestion-contract ac-stable-case-identity
  // AC: @normalized-test-result-ingestion-contract ac-location-optional
  // AC: @normalized-test-result-ingestion-contract ac-diagnostics-preserved
  // AC: @normalized-test-result-ingestion-contract ac-producer-metadata
  it("ingests explicit normalized refs in a neutral package-style layout", async () => {
    const project = await setupProducerProject({
      name: "explicit",
      manifestIncludes: ["docs/specs/product-contract.yaml"],
      specPath: "docs/specs/product-contract.yaml",
      sourcePath: "packages/service/checks/portable-contract.check",
      specSlug: "portable-contract",
      acId: "ac-accepts-normalized-ref",
    });
    tempDirs.push(project.tempDir);

    const payloadPath = await writePayload(
      project.tempDir,
      "explicit-normalized",
      producerPayload({
        runId: EXPLICIT_RUN_ID,
        specRef: project.specRef,
        acId: project.acId,
        producer: {
          kind: "ci",
          label: "portable-linux-contracts",
          ci_url: "https://ci.example.invalid/runs/portable-42",
          code_revision: "abc123",
          native: { adapter_run_id: "ci-run-42" },
        },
      }),
    );

    const result = kspec(
      `coverage test-result ingest --file ${JSON.stringify(payloadPath)} --json`,
      project.tempDir,
    );
    const summary = expectSuccessfulIngestion(result);
    expect(summary).toMatchObject({
      run_id: EXPLICIT_RUN_ID,
      case_count: 3,
      mapped_criterion_count: 2,
      unmapped_count: 1,
      invalid_mapping_count: 0,
      stamps_written_count: 1,
      non_positive_mapped_case_count: 1,
      affected_item_refs: [project.specRef],
    });

    const stored = await loadTestRun(
      await initContext(project.tempDir, { syncMode: "skip" }),
      EXPLICIT_RUN_ID,
    );
    expect(stored?.producer).toMatchObject({
      kind: "ci",
      label: "portable-linux-contracts",
      ci_url: "https://ci.example.invalid/runs/portable-42",
      code_revision: "abc123",
      native: { adapter_run_id: "ci-run-42" },
    });
    expect(stored?.mapping.attributed).toEqual([
      {
        case_id: "portable-contract/checks-explicit-ref",
        item_ulid: project.featureUlid,
        item_ref: project.specRef,
        ac_id: project.acId,
        status: "passed",
      },
      {
        case_id: "portable-contract/retains-diagnostics",
        item_ulid: project.featureUlid,
        item_ref: project.specRef,
        ac_id: project.acId,
        status: "failed",
      },
    ]);
    expect(stored?.verification_effects.stamps_written).toEqual([
      {
        case_id: "portable-contract/checks-explicit-ref",
        item_ulid: project.featureUlid,
        ac_id: project.acId,
        verified_at: "2026-06-23T18:00:00.000Z",
      },
    ]);
    expect(stored?.verification_effects.non_positive_mapped_cases).toEqual([
      {
        case_id: "portable-contract/retains-diagnostics",
        item_ulid: project.featureUlid,
        item_ref: project.specRef,
        ac_id: project.acId,
        status: "failed",
      },
    ]);
    expect(stored?.cases.find((testCase) => testCase.id.endsWith("retains-diagnostics"))).toEqual(
      expect.objectContaining({
        diagnostic: "expected portable output, received empty stream",
      }),
    );
    expect(stored?.cases.find((testCase) => testCase.id.endsWith("locationless-skipped"))).toEqual(
      expect.not.objectContaining({ location: expect.anything() }),
    );
    expect(existsSync(path.join(project.tempDir, project.sourceFile))).toBe(true);
  });

  // AC: @normalized-test-result-ingestion-contract ac-owned-envelope
  // AC: @normalized-test-result-ingestion-contract ac-status-vocabulary
  // AC: @normalized-test-result-ingestion-contract ac-stable-case-identity
  // AC: @normalized-test-result-ingestion-contract ac-location-optional
  // AC: @normalized-test-result-ingestion-contract ac-diagnostics-preserved
  // AC: @normalized-test-result-ingestion-contract ac-producer-metadata
  it("ingests token-extracted refs in a second neutral repository layout", async () => {
    const project = await setupProducerProject({
      name: "token",
      manifestIncludes: ["catalog/features/portable-contract.yaml"],
      specPath: "catalog/features/portable-contract.yaml",
      sourcePath: "apps/desktop/spec-checks/portable-contract.case",
      specSlug: "portable-display",
      acId: "ac-renders-display",
    });
    tempDirs.push(project.tempDir);

    const nativeCaseName = `renders display from native title AC: ${project.specRef} ${project.acId}`;
    const refs = extractAcceptanceCriterionRefsFromText(nativeCaseName);
    const payload = producerPayload({
      runId: TOKEN_RUN_ID,
      specRef: project.specRef,
      acId: project.acId,
      producer: {
        kind: "agent",
        label: "portable-agent-checks",
        agent_session: "01DRZ3NDEKTSV4RRFFQ69G5FAV",
        code_revision: "def456",
      },
      cases: [
        {
          id: "portable-display/native-token-case",
          display_name: nativeCaseName,
          suite_path: ["native adapter", "display checks"],
          status: "passed",
          refs,
        },
        {
          id: "portable-display/unknown-mapped-case",
          display_name: "unknown native case remains diagnostic only",
          status: "unknown",
          refs: [{ item_ref: project.specRef, ac_id: project.acId }],
        },
        {
          id: "portable-display/locationless-skipped-case",
          display_name: "locationless skipped native case",
          status: "skipped",
          refs: [],
        },
      ],
    });
    const payloadPath = await writePayload(project.tempDir, "token-normalized", payload);

    const result = kspec(
      `coverage test-result ingest --file ${JSON.stringify(payloadPath)} --json`,
      project.tempDir,
    );
    const summary = expectSuccessfulIngestion(result);
    expect(summary).toMatchObject({
      run_id: TOKEN_RUN_ID,
      case_count: 3,
      mapped_criterion_count: 2,
      unmapped_count: 1,
      invalid_mapping_count: 0,
      stamps_written_count: 1,
      non_positive_mapped_case_count: 1,
      affected_item_refs: [project.specRef],
    });

    const stored = await loadTestRun(
      await initContext(project.tempDir, { syncMode: "skip" }),
      TOKEN_RUN_ID,
    );
    expect(refs).toEqual([{ item_ref: project.specRef, ac_id: project.acId }]);
    expect(stored?.producer).toMatchObject({
      kind: "agent",
      label: "portable-agent-checks",
      agent_session: "01DRZ3NDEKTSV4RRFFQ69G5FAV",
      code_revision: "def456",
    });
    expect(stored?.cases[0]).toEqual(
      expect.objectContaining({
        id: "portable-display/native-token-case",
        display_name: nativeCaseName,
        refs: [{ item_ref: project.specRef, ac_id: project.acId }],
      }),
    );
    expect(stored?.mapping.attributed).toEqual([
      {
        case_id: "portable-display/native-token-case",
        item_ulid: project.featureUlid,
        item_ref: project.specRef,
        ac_id: project.acId,
        status: "passed",
      },
      {
        case_id: "portable-display/unknown-mapped-case",
        item_ulid: project.featureUlid,
        item_ref: project.specRef,
        ac_id: project.acId,
        status: "unknown",
      },
    ]);
    expect(stored?.verification_effects.stamps_written).toHaveLength(1);
    expect(stored?.verification_effects.non_positive_mapped_cases).toEqual([
      {
        case_id: "portable-display/unknown-mapped-case",
        item_ulid: project.featureUlid,
        item_ref: project.specRef,
        ac_id: project.acId,
        status: "unknown",
      },
    ]);
  });

  // AC: @normalized-test-result-ingestion-contract ac-owned-envelope
  // AC: @trait-type-safe-input ac-1
  // AC: @trait-type-safe-input ac-2
  // AC: @trait-type-safe-input ac-3
  it("rejects framework-native payloads until an adapter submits the normalized envelope", async () => {
    const project = await setupProducerProject({
      name: "native-boundary",
      manifestIncludes: ["requirements/portable-contract.yaml"],
      specPath: "requirements/portable-contract.yaml",
      sourcePath: "src/checks/portable-contract.case",
      specSlug: "portable-boundary",
      acId: "ac-normalized-only",
    });
    tempDirs.push(project.tempDir);
    const nativePayloadPath = await writePayload(project.tempDir, "native-framework-result", {
      success: true,
      suites: [
        {
          title: "native adapter input",
          cases: [
            {
              title: `accepts only normalized input AC: ${project.specRef} ${project.acId}`,
              outcome: "ok",
            },
          ],
        },
      ],
    });

    const rejected = kspec(
      `coverage test-result ingest --file ${JSON.stringify(nativePayloadPath)} --json`,
      project.tempDir,
      { expectFail: true },
    );

    expect(rejected.exitCode).toBe(1);
    const errorBody = JSON.parse(rejected.stderr) as {
      details: { details: Array<{ field: string; message: string }> };
    };
    expect(errorBody.details.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "run" }),
        expect.objectContaining({ field: "producer" }),
        expect.objectContaining({ field: "cases" }),
      ]),
    );
    expect(existsSync(path.join(project.tempDir, "coverage", "test-runs"))).toBe(false);

    const normalizedPayloadPath = await writePayload(
      project.tempDir,
      "native-framework-result-normalized",
      producerPayload({
        runId: NORMALIZED_AFTER_NATIVE_RUN_ID,
        specRef: project.specRef,
        acId: project.acId,
        producer: {
          kind: "other",
          label: "native-format-adapter",
          native: { suite_count: 1 },
        },
        cases: [
          {
            id: "portable-boundary/normalized-after-native",
            display_name: "accepts only normalized input",
            status: "passed",
            refs: [{ item_ref: project.specRef, ac_id: project.acId }],
          },
        ],
      }),
    );
    const accepted = kspec(
      `coverage test-result ingest --file ${JSON.stringify(normalizedPayloadPath)} --json`,
      project.tempDir,
    );

    expectSuccessfulIngestion(accepted);
    const stored = await loadTestRun(
      await initContext(project.tempDir, { syncMode: "skip" }),
      NORMALIZED_AFTER_NATIVE_RUN_ID,
    );
    expect(stored?.producer).toMatchObject({
      kind: "other",
      label: "native-format-adapter",
      native: { suite_count: 1 },
    });
    expect(stored?.mapping.attributed).toEqual([
      expect.objectContaining({
        case_id: "portable-boundary/normalized-after-native",
        item_ref: project.specRef,
        ac_id: project.acId,
        status: "passed",
      }),
    ]);
  });

  // AC: @trait-type-safe-input ac-1
  // AC: @trait-type-safe-input ac-2
  // AC: @trait-type-safe-input ac-3
  it("reports schema-derived valid alternatives for invalid normalized status values", async () => {
    const project = await setupProducerProject({
      name: "status-boundary",
      manifestIncludes: ["contracts/portable-status.yaml"],
      specPath: "contracts/portable-status.yaml",
      sourcePath: "checks/portable-status.case",
      specSlug: "portable-status",
      acId: "ac-status-boundary",
    });
    tempDirs.push(project.tempDir);
    const payloadPath = await writePayload(
      project.tempDir,
      "invalid-status",
      producerPayload({
        runId: EXPLICIT_RUN_ID,
        specRef: project.specRef,
        acId: project.acId,
        producer: {
          kind: "local",
          label: "portable-status-checks",
          command: "node checks/status.js",
        },
        cases: [
          {
            id: "portable-status/native-success-word",
            display_name: "native success word is not normalized",
            status: "success" as "passed",
            refs: [{ item_ref: project.specRef, ac_id: project.acId }],
          },
        ],
      }),
    );

    const result = kspec(
      `coverage test-result ingest --file ${JSON.stringify(payloadPath)} --json`,
      project.tempDir,
      { expectFail: true },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cases.0.status");
    expect(result.stderr).toContain("passed");
    expect(result.stderr).toContain("failed");
    expect(result.stderr).toContain("errored");
    expect(result.stderr).toContain("skipped");
    expect(result.stderr).toContain("unknown");
    expect(existsSync(path.join(project.tempDir, "coverage", "test-runs"))).toBe(false);
  });
});
