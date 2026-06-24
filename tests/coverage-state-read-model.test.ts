import { describe, expect, it, vi } from "vitest";
import {
  buildCoverageEvidenceIndex,
  type CoverageEvidenceIndex,
} from "../src/parser/coverage-evidence-index.js";
import {
  buildCoverageStateReadModel,
  getCachedCoverageStateReadModel,
  invalidateCoverageStateReadModelCache,
} from "../src/parser/coverage-state-read-model.js";
import type { KspecContext, LoadedSpecItem } from "../src/parser/yaml.js";
import { testUlid } from "./helpers/cli.js";

const ITEM_A = testUlid("FEAT", 401);
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function makeItem(acIds: string[]): LoadedSpecItem {
  return {
    _ulid: ITEM_A,
    _sourceFile: "neutral/specs/feature.yaml",
    title: "Neutral Read Model Feature",
    slugs: ["neutral-read-model"],
    type: "feature",
    description: "Neutral fixture for coverage-state read model behavior.",
    acceptance_criteria: acIds.map((id) => ({
      id,
      given: "a neutral project",
      when: "coverage state is requested",
      then: "server-computed state is returned",
    })),
  };
}

function evidenceIndex(acCount: number): CoverageEvidenceIndex {
  const acIds = Array.from({ length: acCount }, (_, index) => `ac-${index + 1}`);
  return buildCoverageEvidenceIndex({
    items: [makeItem(acIds)],
    annotations: [
      {
        specRef: "@neutral-read-model",
        acIds: ["ac-1"],
        malformedTokens: [],
        file: "neutral/tests/coverage.test.ts",
        line: 1,
      },
    ],
    testRuns: [
      {
        format: 1,
        run: {
          id: RUN_ID,
          completed_at: "2026-06-24T10:00:00.000Z",
        },
        producer: {
          kind: "local",
          label: "neutral-runner",
          code_revision: "read-model-revision",
        },
        cases: [
          {
            id: "case-failing",
            display_name: "fails the second criterion",
            status: "failed",
            refs: [{ item_ref: "@neutral-read-model", ac_id: "ac-2" }],
          },
          {
            id: "case-unmapped",
            display_name: "unmapped neutral case",
            status: "passed",
            refs: [],
          },
        ],
        mapping: {
          attributed: [
            {
              case_id: "case-failing",
              item_ulid: ITEM_A,
              item_ref: "@neutral-read-model",
              ac_id: "ac-2",
              status: "failed",
            },
          ],
          unmapped: [
            {
              case_id: "case-unmapped",
              display_name: "unmapped neutral case",
              reason: "no refs supplied",
            },
          ],
          invalid: [],
        },
        verification_effects: {
          stamps_written: [],
          non_positive_mapped_cases: [
            {
              case_id: "case-failing",
              item_ulid: ITEM_A,
              item_ref: "@neutral-read-model",
              ac_id: "ac-2",
              status: "failed",
            },
          ],
        },
      },
    ],
  });
}

function fakeContext(rootDir: string): KspecContext {
  return {
    rootDir,
    specDir: rootDir,
    projectRoot: rootDir,
    manifest: null,
    config: {
      coverage: {
        scan_paths: ["neutral/tests"],
        exclude_patterns: [],
      },
    },
    shadow: {
      enabled: false,
      branch: "kspec-meta",
      directory: ".kspec",
      auto_sync: false,
      sync_interval: 0,
      remote: null,
      worktreeDir: null,
    },
  } as unknown as KspecContext;
}

describe("coverage state read model", () => {
  // AC: @coverage-state-api-cache ac-corpus-rollup
  // AC: @coverage-state-api-cache ac-item-and-ac-detail
  // AC: @coverage-state-api-cache ac-server-computed
  it("projects server-computed corpus, item, and criterion state from evidence", () => {
    const model = buildCoverageStateReadModel(evidenceIndex(3));

    expect(model.summary).toMatchObject({
      denominator: 3,
      counts: { covered: 1, failing: 1, not_yet: 1, re_verify: 0 },
      latest_run_id: RUN_ID,
    });
    expect(model.items["@neutral-read-model"]?.counts).toEqual(model.summary.counts);
    expect(model.criteria[`${ITEM_A} ac-2`]).toMatchObject({
      state: "failing_result",
      presentation: "failing",
      latest_run_evidence: [
        {
          run_id: RUN_ID,
          case_id: "case-failing",
          status: "failed",
        },
      ],
    });
  });

  // AC: @coverage-state-api-cache ac-performance-bounded
  it("reuses cached read models for repeated summary requests until invalidated", async () => {
    const ctx = fakeContext("/tmp/coverage-state-read-model-cache");
    const loadEvidenceIndex = vi.fn<() => Promise<CoverageEvidenceIndex>>(async () =>
      evidenceIndex(2),
    );

    const first = await getCachedCoverageStateReadModel(ctx, { loadEvidenceIndex });
    const second = await getCachedCoverageStateReadModel(ctx, { loadEvidenceIndex });

    expect(first).toBe(second);
    expect(loadEvidenceIndex).toHaveBeenCalledTimes(1);

    invalidateCoverageStateReadModelCache(ctx.rootDir);
    const third = await getCachedCoverageStateReadModel(ctx, { loadEvidenceIndex });

    expect(third).not.toBe(first);
    expect(loadEvidenceIndex).toHaveBeenCalledTimes(2);
  });

  // AC: @coverage-state-api-cache ac-cache-invalidation
  it("serves refreshed rollups after explicit invalidation", async () => {
    const ctx = fakeContext("/tmp/coverage-state-read-model-invalidated");
    const loadEvidenceIndex = vi.fn<() => Promise<CoverageEvidenceIndex>>();
    loadEvidenceIndex
      .mockResolvedValueOnce(evidenceIndex(2))
      .mockResolvedValueOnce(evidenceIndex(4));

    const before = await getCachedCoverageStateReadModel(ctx, { loadEvidenceIndex });
    invalidateCoverageStateReadModelCache(ctx.rootDir);
    const after = await getCachedCoverageStateReadModel(ctx, { loadEvidenceIndex });

    expect(before.summary.denominator).toBe(2);
    expect(after.summary.denominator).toBe(4);
  });
});
