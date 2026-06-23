import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
  type TestResultRunRecordInput,
} from "../src/schema/test-result-runs.js";
import { extractAcceptanceCriterionRefsFromText } from "../src/parser/test-result-ac-tokens.js";
import { loadTestRun, writeTestRun } from "../src/parser/test-result-run-store.js";
import { initContext, writeYamlFilePreserveFormat } from "../src/parser/yaml.js";
import { cleanupTempDir, createTempDir, initGitRepo, testUlid } from "./helpers/cli.js";

interface MappingProject {
  tempDir: string;
  featureUlid: string;
  secondaryUlid: string;
}

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

async function setupMappingProject(name: string): Promise<MappingProject> {
  const tempDir = await createTempDir(`kspec-test-result-ac-mapping-${name}-`);
  const modulesDir = path.join(tempDir, "spec-catalog");
  const sourceDir = path.join(tempDir, "service-src");
  const featureUlid = testUlid("FEAT", 11);
  const secondaryUlid = testUlid("FEAT", 12);
  await fs.mkdir(modulesDir, { recursive: true });
  await fs.mkdir(sourceDir, { recursive: true });
  initGitRepo(tempDir);
  await writeYamlFilePreserveFormat(path.join(tempDir, "kynetic.yaml"), {
    project: { name },
    includes: ["spec-catalog/product.yaml"],
  });
  await writeYamlFilePreserveFormat(path.join(modulesDir, "product.yaml"), [
    {
      _ulid: featureUlid,
      title: "Portable Widget",
      slugs: ["portable-widget"],
      type: "feature",
      description: "A neutral feature used by mapper tests.",
      acceptance_criteria: [
        {
          id: "ac-renders-widget",
          given: "a portable widget exists",
          when: "a normalized test references this criterion",
          then: "the mapper attributes the case to this criterion",
        },
        {
          id: "ac-saves-widget",
          given: "a portable widget can be saved",
          when: "a normalized test references the save criterion",
          then: "the mapper attributes the case to the save criterion",
        },
      ],
    },
    {
      _ulid: secondaryUlid,
      title: "Remote Catalog",
      slugs: ["remote-catalog"],
      type: "requirement",
      description: "A second neutral spec item.",
      acceptance_criteria: [
        {
          id: "ac-syncs-catalog",
          given: "a remote catalog exists",
          when: "a normalized test references the catalog criterion",
          then: "the mapper attributes the case to this criterion",
        },
      ],
    },
  ]);
  await fs.writeFile(path.join(sourceDir, "widget.impl"), "neutral source fixture\n");
  return { tempDir, featureUlid, secondaryUlid };
}

function runInput(cases: TestResultRunRecordInput["cases"]): TestResultRunRecordInput {
  return {
    format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
    run: {
      id: RUN_ID,
      completed_at: "2026-06-23T03:00:00.000Z",
    },
    producer: {
      kind: "local",
      label: "neutral-contract-runner",
      command: "neutral check command",
    },
    cases,
  };
}

describe("test result AC mapping", () => {
  let project: MappingProject;

  beforeEach(async () => {
    project = await setupMappingProject("lumen-lab");
  });

  afterEach(async () => {
    await cleanupTempDir(project.tempDir);
  });

  // AC: @test-result-ac-mapping ac-explicit-mapping
  it("attributes explicit normalized refs to existing acceptance criteria", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });

    const stored = await writeTestRun(
      ctx,
      runInput([
        {
          id: "case-explicit",
          display_name: "explicit portable widget criterion",
          status: "passed",
          refs: [{ item_ref: "@portable-widget", ac_id: "ac-renders-widget" }],
        },
      ]),
    );

    expect(stored.mapping.attributed).toEqual([
      {
        case_id: "case-explicit",
        item_ulid: project.featureUlid,
        item_ref: "@portable-widget",
        ac_id: "ac-renders-widget",
        status: "passed",
      },
    ]);
    expect(stored.mapping.unmapped).toEqual([]);
    expect(stored.mapping.invalid).toEqual([]);
  });

  // AC: @test-result-ac-mapping ac-token-mapping-before-core
  it("handles token-derived refs exactly like explicit normalized refs", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    const refs = extractAcceptanceCriterionRefsFromText(
      "renders widgets AC: @portable-widget ac-renders-widget",
    );

    const stored = await writeTestRun(
      ctx,
      runInput([
        {
          id: "case-token",
          display_name: "framework name with agreed token",
          status: "passed",
          refs,
        },
      ]),
    );

    expect(refs).toEqual([{ item_ref: "@portable-widget", ac_id: "ac-renders-widget" }]);
    expect(stored.mapping.attributed).toEqual([
      expect.objectContaining({
        case_id: "case-token",
        item_ulid: project.featureUlid,
        item_ref: "@portable-widget",
        ac_id: "ac-renders-widget",
        status: "passed",
      }),
    ]);
    expect(stored.cases[0].refs).toEqual(refs);
  });

  // AC: @test-result-ac-mapping ac-invalid-mapping-reported
  it("records malformed, missing-item, and missing-AC refs as invalid without attribution", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });

    const stored = await writeTestRun(
      ctx,
      runInput([
        {
          id: "case-malformed",
          display_name: "malformed reference case",
          status: "failed",
          refs: [{ item_ref: "portable-widget", ac_id: "ac-renders-widget" }],
        },
        {
          id: "case-missing-item",
          display_name: "missing item reference case",
          status: "passed",
          refs: [{ item_ref: "@missing-widget", ac_id: "ac-renders-widget" }],
        },
        {
          id: "case-missing-ac",
          display_name: "missing criterion reference case",
          status: "errored",
          refs: [{ item_ref: "@portable-widget", ac_id: "ac-not-real" }],
        },
      ]),
    );

    expect(stored.mapping.attributed).toEqual([]);
    expect(stored.mapping.invalid).toEqual([
      {
        case_id: "case-malformed",
        item_ref: "portable-widget",
        ac_id: "ac-renders-widget",
        reason: "malformed_ref",
        display_name: "malformed reference case",
      },
      {
        case_id: "case-missing-item",
        item_ref: "@missing-widget",
        ac_id: "ac-renders-widget",
        reason: "missing_item",
        display_name: "missing item reference case",
      },
      {
        case_id: "case-missing-ac",
        item_ref: "@portable-widget",
        ac_id: "ac-not-real",
        reason: "missing_ac_id",
        display_name: "missing criterion reference case",
      },
    ]);
  });

  // AC: @test-result-ac-mapping ac-unmapped-results-retained
  it("retains cases with no refs as unmapped cases on the stored run", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });

    await writeTestRun(
      ctx,
      runInput([
        {
          id: "case-no-refs",
          display_name: "neutral case without mapping",
          status: "skipped",
          refs: [],
        },
      ]),
    );
    const loaded = await loadTestRun(ctx, RUN_ID);

    expect(loaded?.cases).toEqual([
      expect.objectContaining({
        id: "case-no-refs",
        display_name: "neutral case without mapping",
        status: "skipped",
        refs: [],
      }),
    ]);
    expect(loaded?.mapping.unmapped).toEqual([
      {
        case_id: "case-no-refs",
        reason: "no_refs",
        display_name: "neutral case without mapping",
      },
    ]);
  });

  // AC: @test-result-ac-mapping ac-multiple-criteria
  it("attributes one case outcome to multiple criteria without duplicating the case payload", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });

    const stored = await writeTestRun(
      ctx,
      runInput([
        {
          id: "case-multi",
          display_name: "one case covers several criteria",
          status: "unknown",
          refs: [
            { item_ref: "@portable-widget", ac_id: "ac-renders-widget" },
            { item_ref: "@portable-widget", ac_id: "ac-saves-widget" },
            { item_ref: "@remote-catalog", ac_id: "ac-syncs-catalog" },
          ],
        },
      ]),
    );

    expect(stored.cases).toHaveLength(1);
    expect(stored.mapping.attributed).toEqual([
      {
        case_id: "case-multi",
        item_ulid: project.featureUlid,
        item_ref: "@portable-widget",
        ac_id: "ac-renders-widget",
        status: "unknown",
      },
      {
        case_id: "case-multi",
        item_ulid: project.featureUlid,
        item_ref: "@portable-widget",
        ac_id: "ac-saves-widget",
        status: "unknown",
      },
      {
        case_id: "case-multi",
        item_ulid: project.secondaryUlid,
        item_ref: "@remote-catalog",
        ac_id: "ac-syncs-catalog",
        status: "unknown",
      },
    ]);
  });

  // AC: @test-result-ac-mapping ac-no-project-name-assumption
  it("maps by the loaded spec corpus in a neutral project with unrelated names and paths", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });

    const stored = await writeTestRun(
      ctx,
      runInput([
        {
          id: "case-neutral-layout",
          display_name: "unrelated test path still maps by normalized refs",
          suite_path: ["third party harness", "artifact import"],
          location: { file: "checks/not-kynetic-spec.contract", line: 7 },
          status: "passed",
          refs: [{ item_ref: `@${project.featureUlid}`, ac_id: "ac-saves-widget" }],
        },
      ]),
    );

    expect(stored.producer.label).toBe("neutral-contract-runner");
    expect(stored.cases[0].location?.file).toBe("checks/not-kynetic-spec.contract");
    expect(stored.mapping.attributed).toEqual([
      {
        case_id: "case-neutral-layout",
        item_ulid: project.featureUlid,
        item_ref: "@portable-widget",
        ac_id: "ac-saves-widget",
        status: "passed",
      },
    ]);
  });
});
