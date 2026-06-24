import { describe, expect, it } from "vitest";
import {
  buildCoverageEvidenceIndex,
  type CoverageEvidenceEntry,
} from "../src/parser/coverage-evidence-index.js";
import { deriveCoverageState, type CoverageStateInput } from "../src/parser/coverage-state.js";
import {
  CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
  type TestResultRunRecord,
} from "../src/schema/test-result-runs.js";
import type { LoadedSpecItem } from "../src/parser/yaml.js";
import { testUlid } from "./helpers/cli.js";

const ITEM_A = testUlid("FEAT", 201);
const RUN_OLD = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RUN_NEW = "01BRZ3NDEKTSV4RRFFQ69G5FAV";

function makeItem(acIds: string[]): LoadedSpecItem {
  return {
    _ulid: ITEM_A,
    _sourceFile: "neutral/specs/feature.yaml",
    title: "Neutral Coverage Feature",
    slugs: ["neutral-coverage"],
    type: "feature",
    description: "Neutral feature fixture for coverage-state behavior.",
    acceptance_criteria: acIds.map((id) => ({
      id,
      given: "a neutral project",
      when: "coverage state is derived",
      then: "the result is deterministic",
    })),
  };
}

function runRecord(options: {
  id: string;
  completedAt: string;
  codeRevision?: string | null;
  mapped: Array<{
    caseId: string;
    acId: string;
    status: "passed" | "failed" | "errored" | "skipped" | "unknown";
  }>;
}): TestResultRunRecord {
  return {
    format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
    run: {
      id: options.id,
      completed_at: options.completedAt,
    },
    producer: {
      kind: "local",
      label: "neutral-runner",
      command: "neutral test command",
      code_revision:
        options.codeRevision === undefined ? `revision-${options.id}` : options.codeRevision,
    },
    cases: options.mapped.map((mapping) => ({
      id: mapping.caseId,
      display_name: mapping.caseId,
      status: mapping.status,
      refs: [{ item_ref: "@neutral-coverage", ac_id: mapping.acId }],
    })),
    mapping: {
      attributed: options.mapped.map((mapping) => ({
        case_id: mapping.caseId,
        item_ulid: ITEM_A,
        item_ref: "@neutral-coverage",
        ac_id: mapping.acId,
        status: mapping.status,
      })),
      unmapped: [],
      invalid: [],
    },
    verification_effects: {
      stamps_written: [],
      non_positive_mapped_cases: options.mapped
        .filter((mapping) => mapping.status !== "passed")
        .map((mapping) => ({
          case_id: mapping.caseId,
          item_ulid: ITEM_A,
          item_ref: "@neutral-coverage",
          ac_id: mapping.acId,
          status: mapping.status,
        })),
    },
  };
}

function entryFor(options: {
  acId?: string;
  annotations?: Array<{ notApplicable?: boolean; line?: number }>;
  recorded?: { timestamp: string; commit: string | null };
  bootstrap?: { timestamp: string | null; commit: string | null };
  testRuns?: TestResultRunRecord[];
}): CoverageEvidenceEntry {
  const acId = options.acId ?? "ac-one";
  const index = buildCoverageEvidenceIndex({
    items: [makeItem([acId])],
    annotations: (options.annotations ?? []).map((annotation, annotationIndex) => ({
      specRef: "@neutral-coverage",
      acIds: [acId],
      malformedTokens: [],
      file: "neutral/tests/coverage.test.ts",
      line: annotation.line ?? annotationIndex + 1,
      ...(annotation.notApplicable
        ? { notApplicable: true, naReason: "not part of this test" }
        : {}),
    })),
    freshness:
      options.recorded || options.bootstrap
        ? [
            {
              itemUlid: ITEM_A,
              acId,
              recorded: options.recorded
                ? {
                    source: "recorded",
                    timestamp: options.recorded.timestamp,
                    commit: options.recorded.commit,
                    stamp: {
                      verified_at: options.recorded.timestamp,
                      actor: "reviewer",
                      provenance: "validation",
                      ...(options.recorded.commit ? { commit: options.recorded.commit } : {}),
                    },
                  }
                : null,
              bootstrap: options.bootstrap
                ? {
                    source: "bootstrap",
                    timestamp: options.bootstrap.timestamp,
                    commit: options.bootstrap.commit,
                  }
                : null,
            },
          ]
        : [],
    testRuns: options.testRuns ?? [],
  });
  const entry = index.entries[0];
  if (!entry) throw new Error("missing coverage evidence entry");
  return entry;
}

describe("coverage state derivation", () => {
  // AC: @coverage-state-engine ac-total-state
  // AC: @coverage-state-engine ac-covered-requires-current-positive-evidence
  // AC: @coverage-state-engine ac-four-presentation-buckets
  // AC: @coverage-state-presentation ac-1
  // AC: @ac-coverage-applicability ac-1
  it("derives one covered state and explanation from positive annotation evidence", () => {
    const state = deriveCoverageState(entryFor({ annotations: [{}] }));

    expect(state).toMatchObject({
      state: "covered",
      presentation: "covered",
      explanation: {
        rule: "current_positive_evidence",
        latestRunId: null,
      },
    });
    expect(state.explanation.sourceEvidenceIds).toEqual([
      `annotation:neutral/tests/coverage.test.ts:1:${ITEM_A}:ac-one`,
    ]);
    expect(state.explanation.secondaryReverifyCauses).toEqual([]);
  });

  // AC: @coverage-state-engine ac-no-not-applicable-state
  // AC: @coverage-state-engine ac-not-yet-for-no-positive-evidence
  // AC: @ac-coverage-applicability ac-2
  it("treats N/A annotations and skipped or unknown results as no positive evidence", () => {
    const state = deriveCoverageState(
      entryFor({
        annotations: [{ notApplicable: true }],
        testRuns: [
          runRecord({
            id: RUN_NEW,
            completedAt: "2026-06-23T10:00:00.000Z",
            mapped: [
              { caseId: "case-skipped", acId: "ac-one", status: "skipped" },
              { caseId: "case-unknown", acId: "ac-one", status: "unknown" },
            ],
          }),
        ],
      }),
    );

    expect(state.state).toBe("no_positive_evidence");
    expect(state.presentation).toBe("not_yet");
    expect(state.state).not.toBe("not_applicable");
    expect(state.explanation.sourceEvidenceIds).toEqual([]);
  });

  // AC: @coverage-state-engine ac-failing-dominates-covered
  it("lets a latest failed or errored mapped result dominate older pass and static annotation evidence", () => {
    const failed = deriveCoverageState(
      entryFor({
        annotations: [{}],
        testRuns: [
          runRecord({
            id: RUN_OLD,
            completedAt: "2026-06-22T10:00:00.000Z",
            mapped: [{ caseId: "case-old-pass", acId: "ac-one", status: "passed" }],
          }),
          runRecord({
            id: RUN_NEW,
            completedAt: "2026-06-23T10:00:00.000Z",
            mapped: [{ caseId: "case-new-fail", acId: "ac-one", status: "failed" }],
          }),
        ],
      }),
    );
    const errored = deriveCoverageState(
      entryFor({
        annotations: [{}],
        testRuns: [
          runRecord({
            id: RUN_NEW,
            completedAt: "2026-06-23T10:00:00.000Z",
            mapped: [{ caseId: "case-new-error", acId: "ac-one", status: "errored" }],
          }),
        ],
      }),
    );

    expect(failed).toMatchObject({
      state: "failing_result",
      presentation: "failing",
      explanation: {
        rule: "latest_failed_or_errored_result",
        latestRunId: RUN_NEW,
      },
    });
    expect(failed.explanation.sourceEvidenceIds).toEqual([
      `ingested_result:${RUN_NEW}:case-new-fail`,
    ]);
    expect(errored.presentation).toBe("failing");
  });

  // AC: @coverage-state-engine ac-covered-requires-current-positive-evidence
  it("covers recorded stamps, passing latest runs, and passing runs after older failures", () => {
    const recordedOnly = deriveCoverageState(
      entryFor({
        recorded: {
          timestamp: "2026-06-23T10:00:00.000Z",
          commit: "recorded-revision",
        },
      }),
    );
    const passingAfterFailure = deriveCoverageState(
      entryFor({
        testRuns: [
          runRecord({
            id: RUN_OLD,
            completedAt: "2026-06-22T10:00:00.000Z",
            mapped: [{ caseId: "case-old-fail", acId: "ac-one", status: "failed" }],
          }),
          runRecord({
            id: RUN_NEW,
            completedAt: "2026-06-23T10:00:00.000Z",
            mapped: [{ caseId: "case-new-pass", acId: "ac-one", status: "passed" }],
          }),
        ],
      }),
    );

    expect(recordedOnly).toMatchObject({
      state: "covered",
      presentation: "covered",
      explanation: { rule: "current_positive_evidence", latestRunId: null },
    });
    expect(passingAfterFailure).toMatchObject({
      state: "covered",
      presentation: "covered",
      explanation: { rule: "current_positive_evidence", latestRunId: RUN_NEW },
    });
    expect(passingAfterFailure.explanation.sourceEvidenceIds).toEqual([
      `ingested_result:${RUN_NEW}:case-new-pass`,
    ]);
  });

  // AC: @coverage-state-engine ac-reverify-for-stale-evidence
  it("returns re-verify for stale positive evidence and reports winning plus secondary causes", () => {
    const entry: CoverageStateInput = {
      ...entryFor({
        recorded: {
          timestamp: "2026-06-22T10:00:00.000Z",
          commit: "recorded-revision",
        },
        bootstrap: {
          timestamp: "2026-06-23T10:00:00.000Z",
          commit: "bootstrap-revision",
        },
      }),
      freshnessFindings: [
        {
          cause: "stale_test_result",
          sourceEvidenceIds: ["ingested_result:run:case"],
          detail: "mapped test changed after the run",
        },
        {
          cause: "stale_spec_text",
          sourceEvidenceIds: ["criterion:text"],
          detail: "criterion text changed after verification",
        },
      ],
    };

    const state = deriveCoverageState(entry);

    expect(state).toMatchObject({
      state: "stale_spec_text",
      presentation: "re_verify",
      explanation: {
        rule: "positive_evidence_requires_reverification",
        latestRunId: null,
      },
    });
    expect(state.explanation.secondaryReverifyCauses.map((cause) => cause.cause)).toEqual([
      "stale_annotation_or_mapping",
      "stale_test_result",
    ]);
  });

  // AC: @coverage-state-engine ac-reverify-for-stale-evidence
  it("returns re-verify with unknown freshness when required comparison metadata is absent", () => {
    const state = deriveCoverageState(
      entryFor({
        testRuns: [
          runRecord({
            id: RUN_NEW,
            completedAt: "2026-06-23T10:00:00.000Z",
            codeRevision: null,
            mapped: [{ caseId: "case-new-pass", acId: "ac-one", status: "passed" }],
          }),
        ],
      }),
    );

    expect(state).toMatchObject({
      state: "unknown_freshness",
      presentation: "re_verify",
      explanation: {
        rule: "positive_evidence_requires_reverification",
        latestRunId: RUN_NEW,
      },
    });
    expect(state.explanation.sourceEvidenceIds).toEqual([
      `ingested_result:${RUN_NEW}:case-new-pass`,
    ]);
  });

  // AC: @coverage-state-engine ac-deterministic-precedence
  it("produces equivalent output for equivalent inputs with different fact order", () => {
    const base = entryFor({
      annotations: [{ line: 2 }, { line: 1 }],
      testRuns: [
        runRecord({
          id: RUN_NEW,
          completedAt: "2026-06-23T10:00:00.000Z",
          mapped: [
            { caseId: "case-b", acId: "ac-one", status: "passed" },
            { caseId: "case-a", acId: "ac-one", status: "passed" },
          ],
        }),
      ],
    });
    const reversed: CoverageStateInput = {
      ...base,
      evidence: base.evidence.toReversed(),
      annotations: base.annotations.toReversed(),
      latestIngestedResults: base.latestIngestedResults.toReversed(),
      freshnessFindings: [
        { cause: "stale_test_result", sourceEvidenceIds: ["z"] },
        { cause: "stale_annotation_or_mapping", sourceEvidenceIds: ["a"] },
      ],
    };
    const equivalent: CoverageStateInput = {
      ...base,
      freshnessFindings: [
        { cause: "stale_annotation_or_mapping", sourceEvidenceIds: ["a"] },
        { cause: "stale_test_result", sourceEvidenceIds: ["z"] },
      ],
    };

    expect(deriveCoverageState(reversed)).toEqual(deriveCoverageState(equivalent));
  });
});
