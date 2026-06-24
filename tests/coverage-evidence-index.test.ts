/**
 * Coverage evidence index tests.
 *
 * The fixtures here use neutral project names, layouts, and normalized
 * producer labels so evidence indexing stays independent of this repository's
 * own package structure and test framework.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  buildCoverageEvidenceIndex,
  loadCoverageEvidenceIndex,
  type CoverageEvidenceEntry,
} from "../src/parser/coverage-evidence-index.js";
import {
  CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
  type TestResultRunRecord,
} from "../src/schema/test-result-runs.js";
import type { LoadedSpecItem } from "../src/parser/yaml.js";
import { initContext, writeYamlFilePreserveFormat } from "../src/parser/yaml.js";
import { writeTestRun, writeTestRunIndex } from "../src/parser/test-result-run-store.js";
import { cleanupTempDir, createTempDir, initGitRepo, testUlid } from "./helpers/cli.js";

const ITEM_A = testUlid("FEAT", 101);
const ITEM_B = testUlid("FEAT", 102);
const ITEM_C = testUlid("FEAT", 103);
const RUN_OLD = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RUN_NEWER = "01BRZ3NDEKTSV4RRFFQ69G5FAV";
const RUN_TIE_WINNER = "01CRZ3NDEKTSV4RRFFQ69G5FAV";
const RUN_UNINDEXED = "01DRZ3NDEKTSV4RRFFQ69G5FAV";

function makeItem(
  ulid: string,
  slug: string,
  acIds: string[],
  sourceFile = "/neutral/specs/feature.yaml",
): LoadedSpecItem {
  return {
    _ulid: ulid,
    _sourceFile: sourceFile,
    title: `Neutral ${slug}`,
    slugs: [slug],
    type: "feature",
    description: "Neutral feature fixture for evidence index behavior.",
    acceptance_criteria: acIds.map((id) => ({
      id,
      given: "a neutral project",
      when: "coverage evidence is indexed",
      then: "the evidence is joined by criterion identity",
    })),
  };
}

function runRecord(options: {
  id: string;
  completedAt: string;
  producerLabel?: string;
  producerKind?: "local" | "ci" | "agent" | "other";
  mapped?: Array<{
    caseId: string;
    displayName: string;
    itemUlid: string;
    itemRef: string;
    acId: string;
    status: "passed" | "failed" | "errored" | "skipped" | "unknown";
    locationFile?: string;
  }>;
  unmapped?: Array<{ caseId: string; displayName: string; reason: string }>;
  invalid?: Array<{
    caseId: string;
    displayName: string;
    reason: string;
    itemRef?: string;
    acId?: string;
  }>;
}): TestResultRunRecord {
  const mapped = options.mapped ?? [];
  const unmapped = options.unmapped ?? [];
  const invalid = options.invalid ?? [];
  return {
    format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
    run: {
      id: options.id,
      completed_at: options.completedAt,
    },
    producer: {
      kind: options.producerKind ?? "local",
      label: options.producerLabel ?? "neutral-producer",
      command: "neutral test command",
      code_revision: `revision-${options.id}`,
      native: { ignored_native_payload: true },
    },
    cases: [
      ...mapped.map((mapping) => ({
        id: mapping.caseId,
        display_name: mapping.displayName,
        suite_path: ["neutral suite"],
        status: mapping.status,
        location: {
          file: mapping.locationFile ?? "neutral-tests/cases.spec.ts",
          line: 12,
        },
        refs: [{ item_ref: mapping.itemRef, ac_id: mapping.acId }],
      })),
      ...unmapped.map((entry) => ({
        id: entry.caseId,
        display_name: entry.displayName,
        suite_path: ["neutral suite"],
        status: "passed" as const,
        refs: [],
      })),
      ...invalid.map((entry) => ({
        id: entry.caseId,
        display_name: entry.displayName,
        suite_path: ["neutral suite"],
        status: "failed" as const,
        refs: [{ item_ref: entry.itemRef, ac_id: entry.acId }],
      })),
    ],
    mapping: {
      attributed: mapped.map((mapping) => ({
        case_id: mapping.caseId,
        item_ulid: mapping.itemUlid,
        item_ref: mapping.itemRef,
        ac_id: mapping.acId,
        status: mapping.status,
      })),
      unmapped: unmapped.map((entry) => ({
        case_id: entry.caseId,
        display_name: entry.displayName,
        reason: entry.reason,
      })),
      invalid: invalid.map((entry) => ({
        case_id: entry.caseId,
        display_name: entry.displayName,
        reason: entry.reason,
        ...(entry.itemRef ? { item_ref: entry.itemRef } : {}),
        ...(entry.acId ? { ac_id: entry.acId } : {}),
      })),
    },
    verification_effects: {
      stamps_written: [],
      non_positive_mapped_cases: mapped
        .filter((mapping) => mapping.status !== "passed")
        .map((mapping) => ({
          case_id: mapping.caseId,
          item_ulid: mapping.itemUlid,
          item_ref: mapping.itemRef,
          ac_id: mapping.acId,
          status: mapping.status,
        })),
    },
  };
}

function entryBySlug(
  entries: readonly CoverageEvidenceEntry[],
  slug: string,
  acId: string,
): CoverageEvidenceEntry {
  const entry = entries.find(
    (candidate) => candidate.itemRef === `@${slug}` && candidate.acId === acId,
  );
  if (!entry) throw new Error(`missing entry for @${slug} ${acId}`);
  return entry;
}

describe("coverage evidence index", () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(async () => {
    for (const dir of tempDirs) await cleanupTempDir(dir);
  });

  // AC: @coverage-evidence-index ac-one-entry-per-criterion
  it("creates exactly one entry for every loaded acceptance criterion even without evidence", () => {
    const index = buildCoverageEvidenceIndex({
      items: [
        makeItem(ITEM_A, "alpha-widget", ["ac-first", "ac-second"]),
        makeItem(ITEM_B, "beta-widget", ["ac-only"]),
      ],
    });

    expect(index.entries.map((entry) => `${entry.itemRef} ${entry.acId}`)).toEqual([
      "@alpha-widget ac-first",
      "@alpha-widget ac-second",
      "@beta-widget ac-only",
    ]);
    expect(new Set(index.entries.map((entry) => entry.criterionKey)).size).toBe(3);
    expect(entryBySlug(index.entries, "alpha-widget", "ac-second").evidence).toEqual([]);
  });

  // AC: @coverage-evidence-index ac-evidence-sources-labeled
  it("labels annotation, bootstrap freshness, recorded verification, and ingested result evidence", () => {
    const index = buildCoverageEvidenceIndex({
      items: [makeItem(ITEM_A, "alpha-widget", ["ac-first"])],
      annotations: [
        {
          specRef: "@alpha-widget",
          acIds: ["ac-first"],
          malformedTokens: [],
          file: "/portable/tests/alpha.contract.ts",
          line: 7,
        },
      ],
      freshness: [
        {
          itemUlid: ITEM_A,
          acId: "ac-first",
          recorded: {
            source: "recorded",
            timestamp: "2026-06-22T10:00:00.000Z",
            commit: "recorded-revision",
            stamp: {
              verified_at: "2026-06-22T10:00:00.000Z",
              actor: "reviewer",
              provenance: "validation",
              commit: "recorded-revision",
            },
          },
          bootstrap: {
            source: "bootstrap",
            timestamp: "2026-06-21T10:00:00.000Z",
            commit: "bootstrap-revision",
          },
        },
      ],
      testRuns: [
        runRecord({
          id: RUN_NEWER,
          completedAt: "2026-06-23T10:00:00.000Z",
          mapped: [
            {
              caseId: "case-alpha",
              displayName: "alpha portable behavior",
              itemUlid: ITEM_A,
              itemRef: "@alpha-widget",
              acId: "ac-first",
              status: "passed",
            },
          ],
        }),
      ],
    });

    const entry = entryBySlug(index.entries, "alpha-widget", "ac-first");
    expect(entry.evidence.map((evidence) => evidence.source)).toEqual([
      "annotation",
      "bootstrap_freshness",
      "recorded_verification",
      "ingested_result",
    ]);
    expect(entry.annotations[0]?.source).toBe("annotation");
    expect(entry.bootstrapFreshness?.source).toBe("bootstrap_freshness");
    expect(entry.recordedVerification?.source).toBe("recorded_verification");
    expect(entry.latestIngestedResults[0]?.source).toBe("ingested_result");
  });

  // AC: @coverage-evidence-index ac-latest-result-selection
  it("selects only the latest relevant mapped result by completed time and run id tie-break", () => {
    const index = buildCoverageEvidenceIndex({
      items: [makeItem(ITEM_A, "alpha-widget", ["ac-first"])],
      testRuns: [
        runRecord({
          id: RUN_OLD,
          completedAt: "2026-06-22T10:00:00.000Z",
          mapped: [
            {
              caseId: "case-old",
              displayName: "older passing result",
              itemUlid: ITEM_A,
              itemRef: "@alpha-widget",
              acId: "ac-first",
              status: "passed",
            },
          ],
        }),
        runRecord({
          id: RUN_NEWER,
          completedAt: "2026-06-23T10:00:00.000Z",
          mapped: [
            {
              caseId: "case-lower-id",
              displayName: "same time lower run id",
              itemUlid: ITEM_A,
              itemRef: "@alpha-widget",
              acId: "ac-first",
              status: "failed",
            },
          ],
        }),
        runRecord({
          id: RUN_TIE_WINNER,
          completedAt: "2026-06-23T10:00:00.000Z",
          mapped: [
            {
              caseId: "case-tie-winner",
              displayName: "same time higher run id",
              itemUlid: ITEM_A,
              itemRef: "@alpha-widget",
              acId: "ac-first",
              status: "errored",
            },
          ],
        }),
      ],
    });

    const entry = entryBySlug(index.entries, "alpha-widget", "ac-first");
    expect(entry.latestRunId).toBe(RUN_TIE_WINNER);
    expect(entry.latestIngestedResults.map((evidence) => evidence.caseId)).toEqual([
      "case-tie-winner",
    ]);
    expect(entry.evidence.filter((evidence) => evidence.source === "ingested_result")).toHaveLength(
      1,
    );
  });

  // AC: @coverage-evidence-index ac-unmapped-separated
  it("keeps unmapped and invalid cases out of criterion entries", () => {
    const index = buildCoverageEvidenceIndex({
      items: [makeItem(ITEM_A, "alpha-widget", ["ac-first"])],
      testRuns: [
        runRecord({
          id: RUN_NEWER,
          completedAt: "2026-06-23T10:00:00.000Z",
          mapped: [
            {
              caseId: "case-mapped",
              displayName: "mapped result",
              itemUlid: ITEM_A,
              itemRef: "@alpha-widget",
              acId: "ac-first",
              status: "passed",
            },
          ],
          unmapped: [
            {
              caseId: "case-unmapped",
              displayName: "unmapped result",
              reason: "no acceptance criterion ref",
            },
          ],
          invalid: [
            {
              caseId: "case-invalid",
              displayName: "invalid result",
              reason: "unknown criterion",
              itemRef: "@alpha-widget",
              acId: "ac-missing",
            },
          ],
        }),
      ],
    });

    const entry = entryBySlug(index.entries, "alpha-widget", "ac-first");
    expect(entry.latestIngestedResults.map((evidence) => evidence.caseId)).toEqual(["case-mapped"]);
    expect(
      entry.evidence.map((evidence) => ("caseId" in evidence ? evidence.caseId : undefined)),
    ).not.toContain("case-unmapped");
    expect(index.unmappedResults.map((evidence) => [evidence.kind, evidence.caseId])).toEqual([
      ["unmapped", "case-unmapped"],
      ["invalid", "case-invalid"],
    ]);
    expect(new Set(index.unmappedResults.map((evidence) => evidence.source))).toEqual(
      new Set(["unmapped_result"]),
    );
  });

  // AC: @coverage-evidence-index ac-framework-neutral-input
  it("produces equivalent indexes for different neutral layouts with equivalent normalized records", () => {
    const serviceApp = {
      item: makeItem(ITEM_A, "service-contract", ["ac-portable"], "/srv/specs/contracts.yaml"),
      annotationFile: "/srv/apps/service/specs/contract.test.ts",
      producerLabel: "tap-normalizer",
      caseLocation: "apps/service/specs/contract.test.ts",
    };
    const docsPortal = {
      item: makeItem(ITEM_C, "docs-contract", ["ac-portable"], "/portal/catalog/requirements.yaml"),
      annotationFile: "/portal/checks/specs/contract.check",
      producerLabel: "junit-normalizer",
      caseLocation: "quality/specs/contract.check",
    };

    const buildNeutral = (fixture: typeof serviceApp) =>
      buildCoverageEvidenceIndex({
        items: [fixture.item],
        annotations: [
          {
            specRef: `@${fixture.item.slugs?.[0]}`,
            acIds: ["ac-portable"],
            malformedTokens: [],
            file: fixture.annotationFile,
            line: 3,
          },
        ],
        testRuns: [
          runRecord({
            id: RUN_NEWER,
            completedAt: "2026-06-23T10:00:00.000Z",
            producerLabel: fixture.producerLabel,
            mapped: [
              {
                caseId: "case-portable",
                displayName: "portable behavior",
                itemUlid: fixture.item._ulid,
                itemRef: `@${fixture.item.slugs?.[0]}`,
                acId: "ac-portable",
                status: "passed",
                locationFile: fixture.caseLocation,
              },
            ],
          }),
        ],
      });

    const first = entryBySlug(buildNeutral(serviceApp).entries, "service-contract", "ac-portable");
    const second = entryBySlug(buildNeutral(docsPortal).entries, "docs-contract", "ac-portable");

    expect({
      evidenceSources: first.evidence.map((evidence) => evidence.source),
      resultStatuses: first.latestIngestedResults.map((evidence) => evidence.status),
      unmappedCount: 0,
    }).toEqual({
      evidenceSources: second.evidence.map((evidence) => evidence.source),
      resultStatuses: second.latestIngestedResults.map((evidence) => evidence.status),
      unmappedCount: 0,
    });
  });

  // AC: @coverage-evidence-index ac-no-client-side-join
  it("loads a backend-joined index from project context and only indexed accepted runs", async () => {
    const tempDir = await createTempDir("coverage-evidence-index-context-");
    tempDirs.push(tempDir);
    initGitRepo(tempDir);
    await fs.mkdir(path.join(tempDir, "modules"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "quality"), { recursive: true });
    await writeYamlFilePreserveFormat(path.join(tempDir, "kynetic.yaml"), {
      project: { name: "portable-context-project" },
      includes: ["modules/specs.yaml"],
    });
    await writeYamlFilePreserveFormat(path.join(tempDir, "kspec.config.yaml"), {
      coverage: { scan_paths: ["quality/"] },
    });
    await writeYamlFilePreserveFormat(path.join(tempDir, "modules", "specs.yaml"), [
      makeItem(ITEM_A, "context-widget", ["ac-one"], "modules/specs.yaml"),
    ]);
    await fs.writeFile(
      path.join(tempDir, "quality", "context-widget.test.ts"),
      '// AC: @context-widget ac-one\nit("covers context widget", () => {});\n',
    );

    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const indexedRun = await writeTestRun(ctx, {
      format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
      run: { id: RUN_NEWER, completed_at: "2026-06-23T10:00:00.000Z" },
      producer: {
        kind: "ci",
        label: "portable-ci-normalizer",
        command: "portable-ci test",
      },
      cases: [
        {
          id: "case-indexed",
          display_name: "indexed accepted case",
          status: "passed",
          refs: [{ item_ref: "@context-widget", ac_id: "ac-one" }],
        },
      ],
    });

    const unindexedRun = runRecord({
      id: RUN_UNINDEXED,
      completedAt: "2026-06-24T10:00:00.000Z",
      producerLabel: "should-not-be-read",
      mapped: [
        {
          caseId: "case-unindexed",
          displayName: "newer but unindexed case",
          itemUlid: ITEM_A,
          itemRef: "@context-widget",
          acId: "ac-one",
          status: "failed",
        },
      ],
    });
    await fs.mkdir(path.join(tempDir, "coverage", "test-runs", "runs", RUN_UNINDEXED), {
      recursive: true,
    });
    await writeYamlFilePreserveFormat(
      path.join(tempDir, "coverage", "test-runs", "runs", RUN_UNINDEXED, "run.yaml"),
      unindexedRun,
    );
    await writeTestRunIndex(ctx, {
      format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
      runs: {
        [RUN_NEWER]: {
          path: `runs/${RUN_NEWER}/run.yaml`,
          completed_at: indexedRun.run.completed_at,
          producer: { kind: indexedRun.producer.kind, label: indexedRun.producer.label },
          totals: {
            cases: 1,
            mapped: 1,
            unmapped: 0,
            invalid: 0,
            passed: 1,
            failed: 0,
            errored: 0,
            skipped: 0,
            unknown: 0,
            stamps_written: 0,
          },
        },
      },
      latest_run_id: RUN_NEWER,
    });

    const index = await loadCoverageEvidenceIndex(ctx);
    const entry = entryBySlug(index.entries, "context-widget", "ac-one");

    expect(entry.evidence.map((evidence) => evidence.source)).toEqual([
      "annotation",
      "ingested_result",
    ]);
    expect(entry.latestIngestedResults.map((evidence) => evidence.caseId)).toEqual([
      "case-indexed",
    ]);
    expect(index.entriesByCriterion[`${ITEM_A} ac-one`]).toMatchObject({
      itemRef: "@context-widget",
      acId: "ac-one",
    });
  });
});
