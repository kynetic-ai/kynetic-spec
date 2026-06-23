/**
 * Normalized test-result run store tests.
 *
 * The fixtures in this file deliberately use neutral project names, package
 * layouts, producer labels, and test paths so the store contract is not shaped
 * around kynetic-spec's own test runner output.
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
  type TestResultRunRecordInput,
} from "../src/schema/test-result-runs.js";
import {
  TestResultRunRecordFormatCompatibilityError,
  TEST_RESULT_RUN_FORMAT_NEWER_THAN_SUPPORTED_CODE,
  computeTestRunIndexDrift,
  getLatestTestRun,
  getTestRunDir,
  getTestRunFilePath,
  getTestRunIndexPath,
  loadTestRun,
  loadTestRunIndex,
  rebuildTestRunIndex,
  writeTestRun,
  writeTestRunIndex,
} from "../src/parser/test-result-run-store.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  readTestOutput,
  testUlid,
} from "./helpers/cli.js";
import { initContext, writeYamlFilePreserveFormat } from "../src/parser/yaml.js";

const FIXED_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

interface NeutralProject {
  tempDir: string;
  specDir: string;
  modulesDir: string;
  sourceDir: string;
}

async function setupNeutralProject(name: string): Promise<NeutralProject> {
  const tempDir = await createTempDir(`kspec-test-runs-${name}-`);
  const specDir = tempDir;
  const modulesDir = path.join(specDir, "modules");
  const sourceDir = path.join(tempDir, "workspace-src");
  await fs.mkdir(modulesDir, { recursive: true });
  await fs.mkdir(sourceDir, { recursive: true });
  initGitRepo(tempDir);
  await writeYamlFilePreserveFormat(path.join(specDir, "kynetic.yaml"), {
    project: { name },
    includes: ["modules/neutral.yaml"],
  });
  await writeYamlFilePreserveFormat(path.join(modulesDir, "neutral.yaml"), [
    {
      _ulid: testUlid("FEAT", 1),
      title: "Portable Widget Behavior",
      slugs: ["portable-widget-behavior"],
      type: "feature",
      description: "A neutral feature used by normalized result store tests.",
      acceptance_criteria: [
        {
          id: "ac-portable",
          given: "a neutral project fixture",
          when: "a normalized case references this criterion",
          then: "the criterion reference can be stored without project-specific paths",
        },
      ],
    },
  ]);
  await fs.writeFile(path.join(sourceDir, "component.alpha"), "source before ingestion\n");
  return { tempDir, specDir, modulesDir, sourceDir };
}

async function snapshotFiles(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".test-home") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        snapshot.set(path.relative(root, fullPath), await readTestOutput(fullPath));
      }
    }
  };
  await walk(root);
  return snapshot;
}

function expectSnapshotUnchanged(before: Map<string, string>, after: Map<string, string>): void {
  expect([...after.keys()].toSorted()).toEqual([...before.keys()].toSorted());
  for (const [file, content] of before) {
    expect(after.get(file), file).toBe(content);
  }
}

function validRun(overrides: Partial<TestResultRunRecordInput> = {}): TestResultRunRecordInput {
  return {
    format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
    run: {
      id: FIXED_RUN_ID,
      completed_at: "2026-06-22T21:15:00.000Z",
      started_at: "2026-06-22T21:14:10.000Z",
      duration_ms: 50000,
    },
    producer: {
      kind: "local",
      label: "neutral-local-runner",
      command: "neutral test command",
      code_revision: "abc123",
      native: {
        run_id: "producer-owned-id",
      },
    },
    cases: [
      {
        id: "case-stable-id-1",
        display_name: "accepts explicit portable criterion references",
        suite_path: ["adapter contract"],
        status: "passed",
        duration_ms: 12,
        location: {
          file: "checks/portable-contract.check",
          line: 42,
        },
        refs: [{ item_ref: "@portable-widget-behavior", ac_id: "ac-portable" }],
      },
      {
        id: "case-stable-id-2",
        display_name: "plain case without accepted criterion mapping",
        suite_path: ["adapter contract"],
        status: "skipped",
        refs: [],
      },
    ],
    mapping: {
      attributed: [
        {
          case_id: "case-stable-id-1",
          item_ulid: testUlid("FEAT", 1),
          item_ref: "@portable-widget-behavior",
          ac_id: "ac-portable",
          status: "passed",
        },
      ],
      unmapped: [
        {
          case_id: "case-stable-id-2",
          reason: "no_refs",
          display_name: "plain case without accepted criterion mapping",
        },
      ],
      invalid: [],
    },
    verification_effects: {
      stamps_written: [
        {
          case_id: "case-stable-id-1",
          item_ulid: testUlid("FEAT", 1),
          ac_id: "ac-portable",
          verified_at: "2026-06-22T21:15:00.000Z",
        },
      ],
      non_positive_mapped_cases: [],
    },
    ...overrides,
  };
}

describe("test result run store", () => {
  let project: NeutralProject;

  beforeEach(async () => {
    project = await setupNeutralProject("aurora-neutral");
  });

  afterEach(async () => {
    await cleanupTempDir(project.tempDir);
  });

  // AC: @test-result-run-store ac-normalized-run-persistence
  // AC: @test-result-run-store ac-fixed-storage-layout
  // AC: @normalized-test-result-ingestion-contract ac-owned-envelope
  // AC: @normalized-test-result-ingestion-contract ac-status-vocabulary
  // AC: @normalized-test-result-ingestion-contract ac-stable-case-identity
  // AC: @normalized-test-result-ingestion-contract ac-location-optional
  // AC: @normalized-test-result-ingestion-contract ac-diagnostics-preserved
  // AC: @normalized-test-result-ingestion-contract ac-producer-metadata
  // AC: @trait-type-safe-input ac-3
  // AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
  // AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
  // AC: @trait-folder-backed-entity-1 ac-index-entry-created-with-folder
  it("persists the normalized run envelope in the fixed sidecar layout with a bounded index", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    const record = await writeTestRun(ctx, validRun());

    const runPath = getTestRunFilePath(ctx, FIXED_RUN_ID);
    const indexPath = getTestRunIndexPath(ctx);
    expect(runPath).toBe(
      path.join(project.specDir, "coverage", "test-runs", "runs", FIXED_RUN_ID, "run.yaml"),
    );
    expect(existsSync(runPath)).toBe(true);
    expect(existsSync(indexPath)).toBe(true);

    const loaded = await loadTestRun(ctx, FIXED_RUN_ID);
    expect(loaded).toEqual(record);
    expect(loaded?.cases[0]).toMatchObject({
      id: "case-stable-id-1",
      display_name: "accepts explicit portable criterion references",
      status: "passed",
      location: { file: "checks/portable-contract.check", line: 42 },
      refs: [{ item_ref: "@portable-widget-behavior", ac_id: "ac-portable" }],
    });
    expect(loaded?.cases[1].status).toBe("skipped");
    expect(loaded?.producer).toMatchObject({
      kind: "local",
      label: "neutral-local-runner",
      command: "neutral test command",
      code_revision: "abc123",
      native: { run_id: "producer-owned-id" },
    });

    const index = await loadTestRunIndex(ctx);
    const entry = index?.runs[FIXED_RUN_ID];
    expect(index?.latest_run_id).toBe(FIXED_RUN_ID);
    expect(entry).toEqual({
      path: `runs/${FIXED_RUN_ID}/run.yaml`,
      completed_at: "2026-06-22T21:15:00.000Z",
      producer: { kind: "local", label: "neutral-local-runner" },
      code_revision: "abc123",
      totals: {
        cases: 2,
        mapped: 1,
        unmapped: 1,
        invalid: 0,
        passed: 1,
        failed: 0,
        errored: 0,
        skipped: 1,
        unknown: 0,
        stamps_written: 1,
      },
    });
    expect(entry).not.toHaveProperty("cases");
    expect(entry).not.toHaveProperty("mapping");
    expect(entry).not.toHaveProperty("diagnostic");
  });

  // AC: @test-result-run-store ac-framework-neutral-storage
  // AC: @test-result-run-store ac-latest-run-query
  // AC: @normalized-test-result-ingestion-contract ac-producer-metadata
  it("stores different producer runs through the same schema and resolves latest by completed time then run id", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    const olderId = testUlid("RUN", 1);
    const tieLowId = testUlid("RUN", 2);
    const tieHighId = testUlid("RUN", 3);

    await writeTestRun(
      ctx,
      validRun({
        run: { id: olderId, completed_at: "2026-06-22T20:00:00.000Z" },
        producer: { kind: "local", label: "alpha-shell-runner" },
        cases: [
          {
            id: "case-alpha",
            display_name: "alpha command case",
            status: "passed",
            refs: [],
          },
        ],
      }),
    );
    await writeTestRun(
      ctx,
      validRun({
        run: { id: tieLowId, completed_at: "2026-06-22T22:00:00.000Z" },
        producer: {
          kind: "ci",
          label: "beta-ci",
          ci_url: "https://ci.example.test/runs/42",
        },
        cases: [
          {
            id: "case-beta",
            display_name: "beta CI case",
            suite_path: ["remote validation"],
            status: "failed",
            diagnostic: "Expected portable result, received framework-native payload.",
            refs: [],
          },
        ],
      }),
    );
    await writeTestRun(
      ctx,
      validRun({
        run: { id: tieHighId, completed_at: "2026-06-22T22:00:00.000Z" },
        producer: {
          kind: "agent",
          label: "gamma-agent",
          agent_session: testUlid("SESS", 1),
        },
        cases: [
          {
            id: "case-gamma",
            display_name: "gamma session case",
            status: "errored",
            diagnostic: "runner process exited before reporting assertions",
            refs: [],
          },
        ],
      }),
    );

    const latest = await getLatestTestRun(ctx);
    expect(latest?.run.id).toBe(tieHighId);
    expect(latest?.producer.kind).toBe("agent");

    const index = await loadTestRunIndex(ctx);
    expect(index?.latest_run_id).toBe(tieHighId);
    expect(
      Object.values(index?.runs ?? {})
        .map((entry) => entry.producer.kind)
        .toSorted(),
    ).toEqual(["agent", "ci", "local"]);
  });

  // AC: @test-result-run-store ac-sidecar-only
  it("writes only the metadata sidecar and leaves spec/source files unchanged", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    const beforeSpecs = await snapshotFiles(project.specDir);
    const beforeSource = await snapshotFiles(project.sourceDir);

    await writeTestRun(ctx, validRun());

    const afterSpecs = await snapshotFiles(project.specDir);
    const afterSource = await snapshotFiles(project.sourceDir);
    const sidecarFiles = new Set([
      path.join("coverage", "test-runs", "index.yaml"),
      path.join("coverage", "test-runs", "runs", FIXED_RUN_ID, "run.yaml"),
    ]);
    for (const sidecar of sidecarFiles) {
      afterSpecs.delete(sidecar);
    }
    expectSnapshotUnchanged(beforeSpecs, afterSpecs);
    expectSnapshotUnchanged(beforeSource, afterSource);
  });

  // AC: @test-result-run-store ac-invalid-run-rejected
  // AC: @trait-type-safe-input ac-1
  // AC: @trait-type-safe-input ac-2
  it("rejects missing envelope fields and invalid statuses with diagnostics before mutating the store", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    await writeTestRun(ctx, validRun());
    const before = await snapshotFiles(path.join(project.specDir, "coverage"));

    const invalid = {
      format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
      producer: { kind: "local", label: "bad-runner" },
      cases: [{ id: "bad-case", display_name: "bad case", status: "flaky" }],
    };

    await expect(writeTestRun(ctx, invalid as unknown as TestResultRunRecordInput)).rejects.toThrow(
      /run|status|passed|failed|errored|skipped|unknown/i,
    );
    const after = await snapshotFiles(path.join(project.specDir, "coverage"));
    expectSnapshotUnchanged(before, after);
  });

  // AC: @test-result-run-store ac-invalid-run-rejected
  // AC: @normalized-test-result-ingestion-contract ac-owned-envelope
  // AC: @normalized-test-result-ingestion-contract ac-producer-metadata
  // AC: @trait-type-safe-input ac-1
  // AC: @trait-type-safe-input ac-3
  it("rejects native fields outside the namespaced native extension object", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    await writeTestRun(ctx, validRun());
    expect((await loadTestRun(ctx, FIXED_RUN_ID))?.producer.native).toEqual({
      run_id: "producer-owned-id",
    });
    const before = await snapshotFiles(path.join(project.specDir, "coverage"));

    const invalid = validRun({
      run: {
        id: testUlid("RUN", 4),
        completed_at: "2026-06-22T21:30:00.000Z",
      },
      producer: {
        kind: "ci",
        label: "delta-framework-runner",
        native: { retained: true },
        junit: { suite: "native sibling field" },
      } as unknown as TestResultRunRecordInput["producer"],
      cases: [
        {
          id: "case-delta",
          display_name: "delta framework case",
          status: "passed",
          refs: [],
        },
      ],
    });

    await expect(writeTestRun(ctx, invalid)).rejects.toThrow(/producer|junit|unrecognized/i);
    expectSnapshotUnchanged(before, await snapshotFiles(path.join(project.specDir, "coverage")));

    const invalidTopLevel = {
      ...validRun({
        run: {
          id: testUlid("RUN", 5),
          completed_at: "2026-06-22T21:31:00.000Z",
        },
      }),
      junit: { suite: "native top-level field" },
    };

    await expect(
      writeTestRun(ctx, invalidTopLevel as unknown as TestResultRunRecordInput),
    ).rejects.toThrow(/junit|unrecognized/i);
    expectSnapshotUnchanged(before, await snapshotFiles(path.join(project.specDir, "coverage")));

    const invalidCaseNative = validRun({
      run: {
        id: testUlid("RUN", 6),
        completed_at: "2026-06-22T21:32:00.000Z",
      },
      cases: [
        {
          id: "case-epsilon",
          display_name: "epsilon framework case",
          status: "passed",
          refs: [],
          junit: { testcase: "native case field" },
        } as unknown as TestResultRunRecordInput["cases"][number],
      ],
    });

    await expect(writeTestRun(ctx, invalidCaseNative)).rejects.toThrow(/junit|unrecognized/i);
    expectSnapshotUnchanged(before, await snapshotFiles(path.join(project.specDir, "coverage")));
  });

  // AC: @test-result-run-store ac-forward-compatible-records
  // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
  it("preserves supported-format unknown fields and unknown files across read and update cycles", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    await writeTestRun(ctx, validRun());
    const runPath = getTestRunFilePath(ctx, FIXED_RUN_ID);
    const runDir = getTestRunDir(ctx, FIXED_RUN_ID);
    await writeYamlFilePreserveFormat(runPath, {
      ...(await loadTestRun(ctx, FIXED_RUN_ID)),
      future_top_level: { keep: true },
      producer: {
        ...(await loadTestRun(ctx, FIXED_RUN_ID))!.producer,
        future_producer_field: "kept",
      },
    });
    await fs.writeFile(path.join(runDir, "producer-artifact.txt"), "not owned by the store\n");

    const loaded = await loadTestRun(ctx, FIXED_RUN_ID);
    expect((loaded as unknown as Record<string, unknown>).future_top_level).toEqual({ keep: true });
    expect((loaded!.producer as unknown as Record<string, unknown>).future_producer_field).toBe(
      "kept",
    );

    await writeTestRun(
      ctx,
      validRun({
        run: {
          id: FIXED_RUN_ID,
          completed_at: "2026-06-22T21:16:00.000Z",
        },
      }),
    );
    const updated = await loadTestRun(ctx, FIXED_RUN_ID);
    expect((updated as unknown as Record<string, unknown>).future_top_level).toEqual({
      keep: true,
    });
    expect((updated!.producer as unknown as Record<string, unknown>).future_producer_field).toBe(
      "kept",
    );
    expect(await readTestOutput(path.join(runDir, "producer-artifact.txt"))).toBe(
      "not owned by the store\n",
    );
  });

  // AC: @test-result-run-store ac-newer-record-format-refused
  it("refuses newer index and run record formats without blocking unrelated project reads", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });

    await expect(
      writeTestRun(
        ctx,
        validRun({
          format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT + 1,
          run: {
            id: testUlid("RUN", 5),
            completed_at: "2026-06-22T23:00:00.000Z",
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: TEST_RESULT_RUN_FORMAT_NEWER_THAN_SUPPORTED_CODE,
      declaredVersion: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT + 1,
      maxSupportedVersion: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
    } satisfies Partial<TestResultRunRecordFormatCompatibilityError>);
    expect(existsSync(path.join(project.specDir, "coverage", "test-runs"))).toBe(false);

    await expect(
      writeTestRunIndex(ctx, {
        format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT + 1,
        runs: {},
      }),
    ).rejects.toMatchObject({
      code: TEST_RESULT_RUN_FORMAT_NEWER_THAN_SUPPORTED_CODE,
      declaredVersion: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT + 1,
      maxSupportedVersion: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
    } satisfies Partial<TestResultRunRecordFormatCompatibilityError>);
    expect(existsSync(path.join(project.specDir, "coverage", "test-runs"))).toBe(false);

    await writeTestRun(ctx, validRun());

    await writeYamlFilePreserveFormat(getTestRunIndexPath(ctx), {
      format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT + 1,
      runs: {},
    });
    await expect(loadTestRunIndex(ctx)).rejects.toMatchObject({
      code: TEST_RESULT_RUN_FORMAT_NEWER_THAN_SUPPORTED_CODE,
      declaredVersion: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT + 1,
      maxSupportedVersion: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
    } satisfies Partial<TestResultRunRecordFormatCompatibilityError>);

    const unrelatedCtx = await initContext(project.tempDir, { syncMode: "skip" });
    expect(unrelatedCtx.manifest.project.name).toBe("aurora-neutral");
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  // AC: @trait-folder-backed-entity-1 ac-index-repair-converges
  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  // AC: @trait-folder-backed-entity-1 ac-semantic-defaults-do-not-drift
  it("detects index drift, repairs from run folders, and converges without semantic default churn", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    await writeTestRun(
      ctx,
      validRun({
        producer: { kind: "local", label: "neutral-local-runner" },
        mapping: { attributed: [], unmapped: [], invalid: [] },
      }),
    );
    await writeYamlFilePreserveFormat(getTestRunIndexPath(ctx), {
      format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
      runs: {
        [FIXED_RUN_ID]: {
          path: `runs/${FIXED_RUN_ID}/run.yaml`,
          completed_at: "2026-06-22T21:15:00.000Z",
          producer: { kind: "local", label: "neutral-local-runner" },
          code_revision: null,
          totals: {
            cases: 0,
            mapped: 0,
            unmapped: 0,
            invalid: 0,
            passed: 0,
            failed: 0,
            errored: 0,
            skipped: 0,
            unknown: 0,
            stamps_written: 0,
          },
        },
      },
      latest_run_id: FIXED_RUN_ID,
    });

    const drift = await computeTestRunIndexDrift(ctx);
    expect(drift.updated).toBe(1);
    expect(drift.changes).toEqual([
      { kind: "update", ref: FIXED_RUN_ID, path: getTestRunDir(ctx, FIXED_RUN_ID) },
    ]);

    await rebuildTestRunIndex(ctx);
    const clean = await computeTestRunIndexDrift(ctx);
    expect(clean.changes).toEqual([]);
    expect(clean.conflicts).toEqual([]);

    const rebuiltIndex = await loadTestRunIndex(ctx);
    await writeYamlFilePreserveFormat(getTestRunIndexPath(ctx), {
      ...rebuiltIndex,
      runs: {
        ...rebuiltIndex!.runs,
        [FIXED_RUN_ID]: {
          ...rebuiltIndex!.runs[FIXED_RUN_ID],
          code_revision: null,
        },
      },
    });
    const semanticClean = await computeTestRunIndexDrift(ctx);
    expect(semanticClean.changes).toEqual([]);

    await writeTestRun(
      ctx,
      validRun({
        run: {
          id: FIXED_RUN_ID,
          completed_at: "2026-06-22T21:20:00.000Z",
        },
        cases: [
          {
            id: "case-after-repair",
            display_name: "case after repair",
            status: "unknown",
            refs: [],
          },
        ],
      }),
    );
    const index = await loadTestRunIndex(ctx);
    expect(index?.runs[FIXED_RUN_ID].completed_at).toBe("2026-06-22T21:20:00.000Z");
    expect(index?.runs[FIXED_RUN_ID].totals.unknown).toBe(1);
  });
});
