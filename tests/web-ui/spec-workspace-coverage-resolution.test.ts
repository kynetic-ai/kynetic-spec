import { describe, expect, it } from "vitest";
import type {
  CoverageCriterionStateDetail,
  SpecWorkspaceCriterionSummary,
} from "@kynetic-ai/shared";

import {
  buildCoverageResolutionPanelModel,
  coverageResolutionTarget,
  isStaleCoverageResolutionConflict,
  resolutionEffectSummary,
  storedResultMessage,
  taskEffectsFromResolution,
  type CoverageResolutionResponse,
} from "../../packages/web-ui/src/lib/spec-workspace/coverage-resolution";

function coverage(
  overrides: Partial<CoverageCriterionStateDetail> = {},
): CoverageCriterionStateDetail {
  return {
    criterion_key: "01ITEM0000000000000000000:ac-1",
    item_ulid: "01ITEM0000000000000000000",
    item_ref: "@item",
    item_title: "Item",
    ac_id: "ac-1",
    state: "covered",
    presentation: "covered",
    explanation: {
      rule: "covered_by_latest_positive_evidence",
      sourceEvidenceIds: [],
      latestRunId: null,
      secondaryReverifyCauses: [],
    },
    latest_run_evidence: [],
    freshness: { bootstrap: null, recorded: null, secondary_causes: [] },
    unmapped_result_references: [],
    ...overrides,
  };
}

function criterion(
  overrides: Partial<CoverageCriterionStateDetail> | null,
): SpecWorkspaceCriterionSummary {
  return {
    id: "ac-1",
    given: "given",
    when: "when",
    then: "then",
    coverage: overrides ? coverage(overrides) : null,
  };
}

function response(overrides: Partial<CoverageResolutionResponse> = {}): CoverageResolutionResponse {
  return {
    action: "dispatch-fix",
    dry_run: false,
    stored: true,
    target: {
      item_ulid: "01ITEM0000000000000000000",
      item_ref: "@item",
      item_title: "Item",
      ac_id: "ac-1",
      current_fingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    current: {
      presentation: "failing",
      state: "failing_latest_result",
      rule: "latest_result_failed",
      latest_run_id: "run-1",
      source_evidence_ids: [],
      secondary_causes: [],
    },
    diagnostics: [],
    effects: [],
    affected_scopes: [],
    ...overrides,
  };
}

describe("spec workspace coverage resolution panels", () => {
  // AC: @spec-workspace-coverage-resolution-panels ac-resolution-visibility
  it("disables unsupported actions with explicit guidance instead of offering doomed mutations", () => {
    const model = buildCoverageResolutionPanelModel({
      criterion: criterion({ presentation: "covered", state: "covered" }),
      readOnly: false,
    });

    expect(model.actions.every((action) => !action.available)).toBe(true);
    expect(model.guidance).toBe("No resolution action is currently available for this criterion.");
    expect(model.actions.find((action) => action.action === "dispatch-fix")).toMatchObject({
      disabledReason:
        "This criterion is already covered; dispatch fix is only offered for unresolved coverage work.",
    });
  });

  // AC: @spec-workspace-coverage-resolution-panels ac-dry-run-before-apply
  it("summarizes dry-run stored effects and affected scopes before confirmation", () => {
    const preview = response({
      action: "spec-text-revert",
      dry_run: true,
      stored: false,
      effects: [
        {
          kind: "spec_text",
          operation: "would_edit_fields",
          item_ulid: "01ITEM0000000000000000000",
          ac_id: "ac-1",
          fields: ["given", "then"],
          current_text: { given: "new given", when: "when", then: "new then" },
          prior_text: { given: "old given", when: "when", then: "old then" },
          summary: "Revert @item ac-1 spec text fields: given, then",
        },
        {
          kind: "cache_event",
          operation: "would_invalidate",
          scopes: [{ type: "criterion", item_ulid: "01ITEM0000000000000000000", ac_id: "ac-1" }],
        },
      ],
    });

    expect(preview.effects.map(resolutionEffectSummary)).toEqual([
      "Would restore prior given, then text.",
      "would invalidate for 01ITEM0000000000000000000 ac-1.",
    ]);
  });

  // AC: @spec-workspace-coverage-resolution-panels ac-explicit-reverify-action
  it("offers explicit reverify only for stale positive evidence that can be refreshed by the shared endpoint", () => {
    const model = buildCoverageResolutionPanelModel({
      criterion: criterion({
        presentation: "re_verify",
        state: "stale_positive_evidence",
        explanation: {
          rule: "positive_evidence_requires_reverification",
          sourceEvidenceIds: ["evidence-1"],
          latestRunId: "run-1",
          secondaryReverifyCauses: [],
        },
        latest_run_evidence: [
          {
            run_id: "run-1",
            completed_at: "2026-06-28T00:00:00.000Z",
            case_id: "case-1",
            display_name: "passes",
            status: "passed",
            producer: { kind: "vitest", label: "vitest" },
            code_revision: "abc123",
          },
        ],
      }),
      readOnly: false,
    });

    expect(model.actions.find((action) => action.action === "explicit-reverify")).toMatchObject({
      available: true,
      disabledReason: null,
    });
  });

  // AC: @spec-workspace-coverage-resolution-panels ac-spec-text-revert-action
  it("offers spec-text revert only for stale spec text and targets the current coverage item", () => {
    const staleCriterion = criterion({
      presentation: "re_verify",
      state: "stale_spec_text",
      freshness: {
        bootstrap: null,
        recorded: null,
        secondary_causes: [{ cause: "stale_spec_text", sourceEvidenceIds: [] }],
      },
    });

    const model = buildCoverageResolutionPanelModel({ criterion: staleCriterion, readOnly: false });

    expect(model.actions.find((action) => action.action === "spec-text-revert")).toMatchObject({
      available: true,
    });
    expect(coverageResolutionTarget({ parentRef: "@parent", criterion: staleCriterion })).toEqual({
      item_ref: "@item",
      ac_id: "ac-1",
    });
  });

  // AC: @spec-workspace-coverage-resolution-panels ac-spec-text-revert-action
  it("detects stale spec-text revert conflicts so the workspace can refresh after explaining the change", () => {
    expect(
      isStaleCoverageResolutionConflict({
        code: "coverage_resolution_stale_target",
        currentFingerprint:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        expectedCurrentFingerprint:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toBe(true);
    expect(
      isStaleCoverageResolutionConflict({
        code: "coverage_resolution_precondition_failed",
        currentFingerprint:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expectedCurrentFingerprint:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toBe(false);
  });

  // AC: @spec-workspace-coverage-resolution-panels ac-dispatch-fix-action
  it("presents task refs returned by dispatch-fix responses without composing client-side task records", () => {
    const applied = response({
      effects: [
        {
          kind: "task",
          operation: "created_task",
          task_ref: "@task-fix-coverage",
          title: "Fix coverage for @item ac-1",
          automation_eligible: true,
          idempotency_key: "abc123",
        },
      ],
    });

    expect(taskEffectsFromResolution(applied)).toEqual([
      expect.objectContaining({
        task_ref: "@task-fix-coverage",
        title: "Fix coverage for @item ac-1",
      }),
    ]);
    expect(applied.effects.map(resolutionEffectSummary)).toContain(
      "Created @task-fix-coverage: Fix coverage for @item ac-1.",
    );
  });

  // AC: @spec-workspace-coverage-resolution-panels ac-readonly-resolution-refusal
  it("keeps current state visible but disables all confirmations in read-only mode", () => {
    const model = buildCoverageResolutionPanelModel({
      criterion: criterion({ presentation: "failing", state: "latest_result_failed" }),
      readOnly: true,
    });

    expect(model.readOnly).toBe(true);
    expect(model.stateLabel).toBe("failing");
    expect(model.actions.every((action) => !action.available)).toBe(true);
    expect(model.guidance).toContain("read-only/static mode");
  });

  // AC: @spec-workspace-coverage-resolution-panels ac-resolution-event-refresh
  it("treats stored mutation success as event-backed refresh guidance instead of local fake state", () => {
    expect(storedResultMessage(response({ stored: true }))).toBe(
      "Resolution stored. The workspace will refresh from coverage-state events.",
    );
  });
});
