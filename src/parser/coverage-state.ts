/**
 * Pure per-acceptance-criterion coverage-state derivation.
 *
 * Precedence is intentionally explicit and deterministic:
 * 1. Latest mapped failed/errored result -> failing.
 * 2. No positive evidence -> not_yet.
 * 3. Positive evidence with stale or unknown freshness -> re_verify.
 * 4. Current positive evidence -> covered.
 */

import type {
  CoverageAnnotationEvidence,
  CoverageBootstrapFreshnessEvidence,
  CoverageEvidenceEntry,
  CoverageIngestedResultEvidence,
  CoverageRecordedVerificationEvidence,
} from "./coverage-evidence-index.js";

export const COVERAGE_PRESENTATION_BUCKETS = [
  "covered",
  "failing",
  "not_yet",
  "re_verify",
] as const;

export type CoveragePresentationBucket = (typeof COVERAGE_PRESENTATION_BUCKETS)[number];

export type CoverageInternalState =
  | "covered"
  | "failing_result"
  | "no_positive_evidence"
  | "stale_spec_text"
  | "stale_annotation_or_mapping"
  | "stale_test_result"
  | "unknown_freshness";

export type CoverageReverifyCause = Extract<
  CoverageInternalState,
  "stale_spec_text" | "stale_annotation_or_mapping" | "stale_test_result" | "unknown_freshness"
>;

export type CoverageStateRule =
  | "latest_failed_or_errored_result"
  | "no_positive_evidence"
  | "positive_evidence_requires_reverification"
  | "current_positive_evidence";

export interface CoverageStateFreshnessFinding {
  cause: CoverageReverifyCause;
  sourceEvidenceIds?: readonly string[];
  detail?: string;
}

export type CoverageStateInput = CoverageEvidenceEntry & {
  /**
   * Optional freshness/comparison findings attached by the freshness comparison
   * layer. The state engine consumes them but remains side-effect-free.
   */
  freshnessFindings?: readonly CoverageStateFreshnessFinding[];
};

export interface CoverageStateCauseExplanation {
  cause: CoverageReverifyCause;
  sourceEvidenceIds: string[];
  detail?: string;
}

export interface CoverageStateExplanation {
  rule: CoverageStateRule;
  sourceEvidenceIds: string[];
  latestRunId: string | null;
  secondaryReverifyCauses: CoverageStateCauseExplanation[];
}

export interface CoverageStateResult {
  criterionKey: string;
  itemUlid: string;
  itemRef: string;
  acId: string;
  state: CoverageInternalState;
  presentation: CoveragePresentationBucket;
  explanation: CoverageStateExplanation;
}

const REVERIFY_CAUSE_ORDER: Record<CoverageReverifyCause, number> = {
  stale_spec_text: 0,
  stale_annotation_or_mapping: 1,
  stale_test_result: 2,
  unknown_freshness: 3,
};

export function deriveCoverageState(entry: CoverageStateInput): CoverageStateResult {
  const failingResults = sortIngestedEvidence(
    entry.latestIngestedResults.filter(
      (evidence) => evidence.status === "failed" || evidence.status === "errored",
    ),
  );
  if (failingResults.length > 0) {
    return result(entry, "failing_result", "latest_failed_or_errored_result", {
      sourceEvidenceIds: failingResults.map(evidenceId),
      latestRunId: entry.latestRunId,
    });
  }

  const positiveEvidence = collectPositiveEvidence(entry);
  if (positiveEvidence.length === 0) {
    return result(entry, "no_positive_evidence", "no_positive_evidence", {
      sourceEvidenceIds: [],
      latestRunId: entry.latestRunId,
    });
  }

  const reverifyCauses = collectReverifyCauses(entry);
  if (reverifyCauses.length > 0) {
    const [winningCause, ...secondaryCauses] = reverifyCauses;
    return result(entry, winningCause!.cause, "positive_evidence_requires_reverification", {
      sourceEvidenceIds: positiveEvidence,
      latestRunId: entry.latestRunId,
      secondaryReverifyCauses: secondaryCauses,
    });
  }

  return result(entry, "covered", "current_positive_evidence", {
    sourceEvidenceIds: positiveEvidence,
    latestRunId: entry.latestRunId,
  });
}

export function presentationForCoverageState(
  state: CoverageInternalState,
): CoveragePresentationBucket {
  switch (state) {
    case "covered":
      return "covered";
    case "failing_result":
      return "failing";
    case "no_positive_evidence":
      return "not_yet";
    case "stale_spec_text":
    case "stale_annotation_or_mapping":
    case "stale_test_result":
    case "unknown_freshness":
      return "re_verify";
  }
}

function result(
  entry: CoverageStateInput,
  state: CoverageInternalState,
  rule: CoverageStateRule,
  options: {
    sourceEvidenceIds: readonly string[];
    latestRunId: string | null;
    secondaryReverifyCauses?: readonly CoverageStateCauseExplanation[];
  },
): CoverageStateResult {
  return {
    criterionKey: entry.criterionKey,
    itemUlid: entry.itemUlid,
    itemRef: entry.itemRef,
    acId: entry.acId,
    state,
    presentation: presentationForCoverageState(state),
    explanation: {
      rule,
      sourceEvidenceIds: [...options.sourceEvidenceIds].toSorted(compareStrings),
      latestRunId: options.latestRunId,
      secondaryReverifyCauses: [...(options.secondaryReverifyCauses ?? [])],
    },
  };
}

function collectPositiveEvidence(entry: CoverageStateInput): string[] {
  return [
    ...sortAnnotations(entry.annotations)
      .filter((annotation) => annotation.notApplicable !== true)
      .map(evidenceId),
    ...(entry.recordedVerification ? [evidenceId(entry.recordedVerification)] : []),
    ...sortIngestedEvidence(
      entry.latestIngestedResults.filter((evidence) => evidence.status === "passed"),
    ).map(evidenceId),
  ].toSorted(compareStrings);
}

function collectReverifyCauses(entry: CoverageStateInput): CoverageStateCauseExplanation[] {
  const causes: CoverageStateCauseExplanation[] = [
    ...implicitRecordedFreshnessCauses(entry),
    ...implicitRunFreshnessCauses(entry),
    ...(entry.freshnessFindings ?? []).map(normalizeFreshnessFinding),
  ];
  return dedupeCauses(causes).toSorted(compareReverifyCause);
}

function implicitRecordedFreshnessCauses(
  entry: CoverageStateInput,
): CoverageStateCauseExplanation[] {
  const recorded = entry.recordedVerification;
  if (!recorded) return [];

  const causes: CoverageStateCauseExplanation[] = [];
  const bootstrap = entry.bootstrapFreshness;
  if (isBootstrapNewerThanRecorded(bootstrap, recorded)) {
    causes.push({
      cause: "stale_annotation_or_mapping",
      sourceEvidenceIds: [evidenceId(recorded), evidenceId(bootstrap!)].toSorted(compareStrings),
      detail: "recorded verification is older than annotation freshness",
    });
  }
  if (!recorded.commit || (bootstrap && (!bootstrap.commit || !bootstrap.timestamp))) {
    causes.push({
      cause: "unknown_freshness",
      sourceEvidenceIds: [
        evidenceId(recorded),
        ...(bootstrap ? [evidenceId(bootstrap)] : []),
      ].toSorted(compareStrings),
      detail: "recorded verification lacks comparable freshness metadata",
    });
  }
  return causes;
}

function implicitRunFreshnessCauses(entry: CoverageStateInput): CoverageStateCauseExplanation[] {
  return sortIngestedEvidence(
    entry.latestIngestedResults.filter(
      (evidence) => evidence.status === "passed" && !evidence.codeRevision,
    ),
  ).map((evidence) => ({
    cause: "unknown_freshness",
    sourceEvidenceIds: [evidenceId(evidence)],
    detail: "passing ingested result lacks comparable code revision metadata",
  }));
}

function isBootstrapNewerThanRecorded(
  bootstrap: CoverageBootstrapFreshnessEvidence | null,
  recorded: CoverageRecordedVerificationEvidence,
): boolean {
  if (!bootstrap?.timestamp) return false;
  return bootstrap.timestamp.localeCompare(recorded.timestamp) > 0;
}

function normalizeFreshnessFinding(
  finding: CoverageStateFreshnessFinding,
): CoverageStateCauseExplanation {
  return {
    cause: finding.cause,
    sourceEvidenceIds: [...(finding.sourceEvidenceIds ?? [])].toSorted(compareStrings),
    ...(finding.detail !== undefined ? { detail: finding.detail } : {}),
  };
}

function dedupeCauses(
  causes: readonly CoverageStateCauseExplanation[],
): CoverageStateCauseExplanation[] {
  const deduped = new Map<string, CoverageStateCauseExplanation>();
  for (const cause of causes) {
    deduped.set(JSON.stringify([cause.cause, cause.sourceEvidenceIds, cause.detail ?? ""]), cause);
  }
  return Array.from(deduped.values());
}

function evidenceId(
  evidence:
    | CoverageAnnotationEvidence
    | CoverageRecordedVerificationEvidence
    | CoverageBootstrapFreshnessEvidence
    | CoverageIngestedResultEvidence,
): string {
  switch (evidence.source) {
    case "annotation":
      return `annotation:${evidence.file}:${evidence.line}:${evidence.itemUlid}:${evidence.acId}`;
    case "recorded_verification":
      return `recorded_verification:${evidence.itemUlid}:${evidence.acId}:${evidence.timestamp}`;
    case "bootstrap_freshness":
      return `bootstrap_freshness:${evidence.itemUlid}:${evidence.acId}:${evidence.timestamp ?? "unknown"}`;
    case "ingested_result":
      return `ingested_result:${evidence.runId}:${evidence.caseId}`;
  }
}

function sortAnnotations(
  annotations: readonly CoverageAnnotationEvidence[],
): CoverageAnnotationEvidence[] {
  return [...annotations].toSorted((a, b) => compareStrings(evidenceId(a), evidenceId(b)));
}

function sortIngestedEvidence(
  results: readonly CoverageIngestedResultEvidence[],
): CoverageIngestedResultEvidence[] {
  return [...results].toSorted((a, b) => compareStrings(evidenceId(a), evidenceId(b)));
}

function compareReverifyCause(
  a: CoverageStateCauseExplanation,
  b: CoverageStateCauseExplanation,
): number {
  const byCause = REVERIFY_CAUSE_ORDER[a.cause] - REVERIFY_CAUSE_ORDER[b.cause];
  if (byCause !== 0) return byCause;
  const byEvidence = a.sourceEvidenceIds.join("\0").localeCompare(b.sourceEvidenceIds.join("\0"));
  if (byEvidence !== 0) return byEvidence;
  return (a.detail ?? "").localeCompare(b.detail ?? "");
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b);
}
