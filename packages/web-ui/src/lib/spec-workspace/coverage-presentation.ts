import type {
  CoverageBucketCounts,
  CoverageCriterionStateDetail,
  SpecWorkspaceCriterionSummary,
  SpecWorkspaceUnavailableSection,
} from "@kynetic-ai/shared";
import {
  COVERAGE_STATES,
  resolveStatusToken,
  type CoverageState,
  type StatusToken,
} from "../ds/status-tokens";

export type CoverageFilterState = CoverageState | "all";

export interface CoverageBucketPresentation extends StatusToken {
  state: CoverageState;
}

export interface CoverageRollupSegment extends CoverageBucketPresentation {
  count: number;
  percent: number;
}

export interface CoverageRollup {
  denominator: number;
  segments: CoverageRollupSegment[];
}

export interface CoverageStateFilter {
  state: CoverageFilterState;
  label: string;
  count: number;
}

export interface ReverifySummary {
  count: number;
  causeLabels: string[];
  href: string;
}

export interface CoverageReadiness {
  state: "ready" | "warming" | "retry" | "unavailable";
  message: string | null;
  suggestion: string | null;
  blockingNavigation: false;
}

const CAUSE_LABELS: Record<string, string> = {
  stale_spec_text: "Spec text changed",
  stale_annotation_or_mapping: "Annotation or mapping changed",
  stale_test_result: "Test result is stale",
  unknown_freshness: "Freshness unknown",
};

export function isCoverageFilterState(value: string | null): value is CoverageFilterState {
  return value === "all" || COVERAGE_STATES.includes(value as CoverageState);
}

export function coverageBucketToken(state: CoverageState): CoverageBucketPresentation {
  return { state, ...resolveStatusToken("coverage", state) };
}

export function coverageCauseText(cause: string): string {
  return CAUSE_LABELS[cause] ?? cause.replaceAll("_", " ");
}

export function presentationForCriterion(criterion: SpecWorkspaceCriterionSummary): CoverageState {
  return criterion.coverage?.presentation ?? "not_yet";
}

export function buildCoverageRollup(
  counts: CoverageBucketCounts,
  denominator: number,
): CoverageRollup {
  const safeDenominator = Math.max(0, denominator);
  return {
    denominator: safeDenominator,
    segments: COVERAGE_STATES.map((state) => {
      const count = counts[state];
      return {
        ...coverageBucketToken(state),
        count,
        percent: safeDenominator > 0 ? Math.round((count / safeDenominator) * 100) : 0,
      };
    }),
  };
}

export function coverageAttentionState(
  counts: CoverageBucketCounts,
  denominator: number,
): CoverageState | null {
  if (denominator <= 0) return null;
  if (counts.failing > 0) return "failing";
  if (counts.re_verify > 0) return "re_verify";
  if (counts.not_yet > 0) return "not_yet";
  return "covered";
}

export function buildCoverageStateFilters(
  criteria: SpecWorkspaceCriterionSummary[],
): CoverageStateFilter[] {
  const counts: Record<CoverageState, number> = {
    covered: 0,
    failing: 0,
    not_yet: 0,
    re_verify: 0,
  };
  for (const criterion of criteria) {
    counts[presentationForCriterion(criterion)] += 1;
  }

  return [
    { state: "all", label: "All", count: criteria.length },
    ...COVERAGE_STATES.map((state) => ({
      state,
      label: coverageBucketToken(state).label,
      count: counts[state],
    })),
  ];
}

export function filterCriteriaByCoverageState(
  criteria: SpecWorkspaceCriterionSummary[],
  filter: CoverageFilterState,
): SpecWorkspaceCriterionSummary[] {
  if (filter === "all") return criteria;
  return criteria.filter((criterion) => presentationForCriterion(criterion) === filter);
}

function secondaryCauses(
  criterion: SpecWorkspaceCriterionSummary,
): CoverageCriterionStateDetail["freshness"]["secondary_causes"] {
  if (criterion.coverage?.presentation !== "re_verify") return [];
  return [
    ...(criterion.coverage.freshness.secondary_causes ?? []),
    ...(criterion.coverage.explanation.secondaryReverifyCauses ?? []),
  ];
}

export function reverifyCauseLabels(criteria: SpecWorkspaceCriterionSummary[]): string[] {
  const labels = new Set<string>();
  for (const criterion of criteria) {
    for (const cause of secondaryCauses(criterion)) {
      labels.add(coverageCauseText(cause.cause));
    }
  }
  return [...labels].toSorted((a, b) => a.localeCompare(b));
}

export function buildReverifySummary(
  criteria: SpecWorkspaceCriterionSummary[],
  scopeRef: string,
  validatePath: string,
  acId?: string,
): ReverifySummary {
  const reverifyCriteria = criteria.filter(
    (criterion) => presentationForCriterion(criterion) === "re_verify",
  );
  const params = new URLSearchParams();
  params.set("spec_ref", scopeRef);
  params.set("coverage", "re_verify");
  if (acId) params.set("ac", acId);
  return {
    count: reverifyCriteria.length,
    causeLabels: reverifyCauseLabels(reverifyCriteria),
    href: `${validatePath}?${params.toString()}`,
  };
}

export function buildCoverageReadiness(input: {
  cacheWarming: boolean;
  unavailableSections: SpecWorkspaceUnavailableSection[];
  errorMessage?: string | null;
}): CoverageReadiness {
  if (input.cacheWarming) {
    return {
      state: "warming",
      message: "Coverage state is warming.",
      suggestion: "Spec navigation remains available while coverage refreshes.",
      blockingNavigation: false,
    };
  }
  if (input.errorMessage) {
    return {
      state: "retry",
      message: input.errorMessage,
      suggestion: "Retry or refresh the workspace coverage query.",
      blockingNavigation: false,
    };
  }
  const unavailable = input.unavailableSections.find(
    (section) => section.kind === "coverage" || section.kind === "static_snapshot",
  );
  if (unavailable) {
    return {
      state: "unavailable",
      message: unavailable.reason,
      suggestion: unavailable.suggestion,
      blockingNavigation: false,
    };
  }
  return {
    state: "ready",
    message: null,
    suggestion: null,
    blockingNavigation: false,
  };
}
