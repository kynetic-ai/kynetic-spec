import { describe, expect, it } from "vitest";
import type {
  CoverageBucketCounts,
  CoverageCriterionStateDetail,
  SpecWorkspaceCriterionSummary,
  SpecWorkspaceUnavailableSection,
} from "@kynetic-ai/shared";

import {
  buildCoverageRollup,
  buildCoverageStateFilters,
  buildCoverageReadiness,
  buildReverifySummary,
  coverageAttentionState,
  coverageBucketToken,
  coverageCauseText,
  filterCriteriaByCoverageState,
} from "../../packages/web-ui/src/lib/spec-workspace/coverage-presentation";

const counts: CoverageBucketCounts = { covered: 3, failing: 1, not_yet: 2, re_verify: 4 };

function criterion(
  id: string,
  presentation: CoverageCriterionStateDetail["presentation"] | null,
  causes: CoverageCriterionStateDetail["freshness"]["secondary_causes"] = [],
): SpecWorkspaceCriterionSummary {
  return {
    id,
    given: `given ${id}`,
    when: `when ${id}`,
    then: `then ${id}`,
    coverage: presentation
      ? {
          criterion_key: `item ${id}`,
          item_ulid: "01ITEM0000000000000000000",
          item_ref: "@item",
          item_title: "Item",
          ac_id: id,
          state: presentation,
          presentation,
          explanation: {
            rule: presentation === "re_verify" ? "freshness_requires_reverification" : presentation,
            sourceEvidenceIds: [],
            latestRunId: null,
            secondaryReverifyCauses: causes,
          },
          latest_run_evidence: [],
          freshness: { bootstrap: null, recorded: null, secondary_causes: causes },
          unmapped_result_references: [],
        }
      : null,
  };
}

describe("spec workspace coverage presentation", () => {
  // AC: @spec-workspace-coverage-state-presentation ac-four-bucket-tokens
  it("uses one shared token and secondary re-verify cause text for each four-bucket state", () => {
    expect(coverageBucketToken("covered")).toMatchObject({
      state: "covered",
      label: "Covered",
      glyph: "●",
    });
    expect(coverageBucketToken("failing")).toMatchObject({
      state: "failing",
      label: "Failing",
      glyph: "✗",
    });
    expect(coverageBucketToken("not_yet")).toMatchObject({
      state: "not_yet",
      label: "Not Yet",
      glyph: "○",
    });
    expect(coverageBucketToken("re_verify")).toMatchObject({
      state: "re_verify",
      label: "Re-verify",
      glyph: "⟳",
    });
    expect(coverageCauseText("stale_spec_text")).toBe("Spec text changed");
    expect(coverageCauseText("stale_annotation_or_mapping")).toBe("Annotation or mapping changed");
    expect(coverageCauseText("stale_test_result")).toBe("Test result is stale");
    expect(coverageCauseText("unknown_freshness")).toBe("Freshness unknown");
  });

  // AC: @spec-workspace-coverage-state-presentation ac-rollup-bars
  it("builds rollup segments whose counts and denominator match the backend projection", () => {
    const rollup = buildCoverageRollup(counts, 10);

    expect(rollup.denominator).toBe(10);
    expect(rollup.segments.map((segment) => [segment.state, segment.count])).toEqual([
      ["covered", 3],
      ["failing", 1],
      ["not_yet", 2],
      ["re_verify", 4],
    ]);
    expect(rollup.segments.map((segment) => segment.percent)).toEqual([30, 10, 20, 40]);
  });

  // AC: @spec-workspace-coverage-state-presentation ac-requirement-state-filter
  it("counts and filters only the current page criteria by backend presentation bucket", () => {
    const criteria = [
      criterion("ac-covered", "covered"),
      criterion("ac-failing", "failing"),
      criterion("ac-reverify", "re_verify"),
      criterion("ac-not-yet", "not_yet"),
    ];

    expect(
      buildCoverageStateFilters(criteria).map((filter) => [filter.state, filter.count]),
    ).toEqual([
      ["all", 4],
      ["covered", 1],
      ["failing", 1],
      ["not_yet", 1],
      ["re_verify", 1],
    ]);
    expect(filterCriteriaByCoverageState(criteria, "re_verify").map((entry) => entry.id)).toEqual([
      "ac-reverify",
    ]);
    expect(filterCriteriaByCoverageState(criteria, "all").map((entry) => entry.id)).toEqual([
      "ac-covered",
      "ac-failing",
      "ac-reverify",
      "ac-not-yet",
    ]);
  });

  // AC: @spec-workspace-coverage-state-presentation ac-reverify-banner
  it("summarizes scoped re-verify counts, cause classes, and validate links", () => {
    const criteria = [
      criterion("ac-1", "re_verify", [
        { cause: "stale_spec_text", sourceEvidenceIds: [], detail: "Given changed" },
      ]),
      criterion("ac-2", "re_verify", [{ cause: "unknown_freshness", sourceEvidenceIds: [] }]),
      criterion("ac-3", "covered"),
    ];

    expect(buildReverifySummary(criteria, "@requirement", "/validate")).toMatchObject({
      count: 2,
      causeLabels: ["Freshness unknown", "Spec text changed"],
      href: "/validate?spec_ref=%40requirement&coverage=re_verify",
    });
  });

  // AC: @spec-workspace-coverage-state-presentation ac-failing-dominates-visual-priority
  it("prioritizes failing over re-verify and keeps not-yet distinct", () => {
    expect(coverageAttentionState({ covered: 0, failing: 1, not_yet: 0, re_verify: 4 }, 5)).toBe(
      "failing",
    );
    expect(coverageAttentionState({ covered: 0, failing: 0, not_yet: 1, re_verify: 4 }, 5)).toBe(
      "re_verify",
    );
    expect(coverageAttentionState({ covered: 0, failing: 0, not_yet: 2, re_verify: 0 }, 2)).toBe(
      "not_yet",
    );
  });

  // AC: @spec-workspace-coverage-state-presentation ac-no-legacy-covered-fallback
  it("treats missing projection state as not yet instead of falling back to legacy covered booleans", () => {
    const criteria = [criterion("ac-legacy", null)];

    expect(
      buildCoverageStateFilters(criteria).find((filter) => filter.state === "not_yet"),
    ).toMatchObject({
      count: 1,
    });
    expect(filterCriteriaByCoverageState(criteria, "covered")).toEqual([]);
  });

  // AC: @spec-workspace-coverage-state-presentation ac-warming-and-unavailable-state
  it("reports coverage warming or unavailable state without hiding the rest of the workspace", () => {
    const unavailable: SpecWorkspaceUnavailableSection[] = [
      {
        kind: "coverage",
        status: "unavailable",
        reason: "Coverage state is not in the static snapshot.",
        suggestion: "Open the live daemon workspace to refresh coverage state.",
      },
    ];

    expect(buildCoverageReadiness({ cacheWarming: true, unavailableSections: [] })).toMatchObject({
      state: "warming",
      blockingNavigation: false,
    });
    expect(
      buildCoverageReadiness({ cacheWarming: false, unavailableSections: unavailable }),
    ).toMatchObject({
      state: "unavailable",
      message: "Coverage state is not in the static snapshot.",
      blockingNavigation: false,
    });
  });
});
