import type {
  CoverageCriterionStateDetail,
  SpecWorkspaceCriterionSummary,
} from "@kynetic-ai/shared";

export type CoverageResolutionAction = "explicit-reverify" | "spec-text-revert" | "dispatch-fix";

export interface CoverageResolutionTarget {
  item_ref: string;
  ac_id: string;
}

export interface CoverageResolutionRequest {
  action: CoverageResolutionAction;
  target: CoverageResolutionTarget;
  dry_run?: boolean;
  expected_current_fingerprint?: string;
  automation_eligible?: boolean;
}

export interface CoverageResolutionAffectedScope {
  type: "criterion" | "item" | "project";
  item_ulid?: string;
  ac_id?: string;
  ref?: "@project";
}

export type CoverageResolutionEffect =
  | {
      kind: "verification_stamp";
      operation: "would_write_stamp" | "wrote_stamp";
      item_ulid: string;
      ac_id: string;
      provenance: "re_verification";
      actor?: string | null;
      verified_at?: string | null;
      commit?: string | null;
      session_id?: string | null;
    }
  | {
      kind: "spec_text";
      operation: "would_edit_fields" | "edited_fields";
      item_ulid: string;
      ac_id: string;
      fields: Array<"given" | "when" | "then">;
      current_text: { given: string; when: string; then: string };
      prior_text: { given: string; when: string; then: string };
      prior_commit?: string | null;
      prior_timestamp?: string | null;
      summary: string;
    }
  | {
      kind: "task";
      operation: "would_create_task" | "would_reuse_task" | "created_task" | "reused_task";
      task_ref?: string | null;
      title?: string;
      automation_eligible: boolean;
      idempotency_key?: string;
    }
  | {
      kind: "cache_event";
      operation: "would_invalidate" | "invalidated" | "would_broadcast" | "broadcast";
      scopes: CoverageResolutionAffectedScope[];
    };

export interface CoverageResolutionDiagnostic {
  code: string;
  message: string;
  current_presentation: CoverageCriterionStateDetail["presentation"];
  current_state: string;
  current_cause: string | null;
  missing_requirement: string;
  satisfied: boolean;
  suggestion: string;
}

export interface CoverageResolutionResponse {
  action: CoverageResolutionAction;
  dry_run: boolean;
  stored: boolean;
  target: {
    item_ulid: string;
    item_ref: string;
    item_title: string;
    ac_id: string;
    current_fingerprint: string;
  };
  current: {
    presentation: CoverageCriterionStateDetail["presentation"];
    state: string;
    rule: string;
    latest_run_id: string | null;
    source_evidence_ids: string[];
    secondary_causes: Array<{ cause: string; source_evidence_ids: string[]; detail?: string }>;
  };
  diagnostics: CoverageResolutionDiagnostic[];
  effects: CoverageResolutionEffect[];
  affected_scopes: CoverageResolutionAffectedScope[];
}

export interface CoverageResolutionActionModel {
  action: CoverageResolutionAction;
  label: string;
  summary: string;
  available: boolean;
  disabledReason: string | null;
}

export interface CoverageResolutionPanelModel {
  stateLabel: string;
  readOnly: boolean;
  hasCoverage: boolean;
  actions: CoverageResolutionActionModel[];
  guidance: string | null;
}

const READ_ONLY_GUIDANCE =
  "Resolution actions are disabled in read-only/static mode. Open a live daemon-backed workspace to store changes.";

function hasFailedOrErroredResult(coverage: CoverageCriterionStateDetail): boolean {
  return coverage.latest_run_evidence.some(
    (evidence) => evidence.status === "failed" || evidence.status === "errored",
  );
}

function reverifyCauses(coverage: CoverageCriterionStateDetail): string[] {
  return [
    ...coverage.freshness.secondary_causes.map((cause) => cause.cause),
    ...coverage.explanation.secondaryReverifyCauses.map((cause) => cause.cause),
  ];
}

function hasStaleSpecTextCause(coverage: CoverageCriterionStateDetail): boolean {
  return reverifyCauses(coverage).includes("stale_spec_text");
}

function canExplicitlyReverify(coverage: CoverageCriterionStateDetail): boolean {
  return (
    coverage.presentation === "re_verify" &&
    coverage.explanation.rule === "positive_evidence_requires_reverification" &&
    coverage.explanation.sourceEvidenceIds.length > 0 &&
    !hasFailedOrErroredResult(coverage)
  );
}

function disabledReasonForAction(
  action: CoverageResolutionAction,
  coverage: CoverageCriterionStateDetail | null,
  readOnly: boolean,
): string | null {
  if (readOnly) return READ_ONLY_GUIDANCE;
  if (!coverage) {
    return "Coverage state is unavailable for this criterion, so no resolution action can be selected.";
  }
  if (action === "explicit-reverify") {
    if (canExplicitlyReverify(coverage)) return null;
    if (coverage.presentation === "covered") return "This criterion is already covered.";
    if (coverage.presentation === "not_yet") {
      return "Add positive evidence before explicitly re-verifying this criterion.";
    }
    if (coverage.presentation === "failing" || hasFailedOrErroredResult(coverage)) {
      return "Fix failing evidence before explicitly re-verifying this criterion.";
    }
    return "Explicit re-verification requires stale positive evidence.";
  }
  if (action === "spec-text-revert") {
    return hasStaleSpecTextCause(coverage)
      ? null
      : "Spec-text revert requires a stale spec-text cause with a resolvable prior criterion.";
  }
  if (coverage.presentation === "covered") {
    return "This criterion is already covered; dispatch fix is only offered for unresolved coverage work.";
  }
  return null;
}

export function buildCoverageResolutionPanelModel(input: {
  criterion: SpecWorkspaceCriterionSummary;
  readOnly: boolean;
}): CoverageResolutionPanelModel {
  const coverage = input.criterion.coverage;
  const actions: CoverageResolutionActionModel[] = [
    {
      action: "explicit-reverify",
      label: "Re-verify",
      summary: "Record a re-verification stamp for current positive evidence.",
      available: false,
      disabledReason: null,
    },
    {
      action: "spec-text-revert",
      label: "Revert Spec Text",
      summary: "Preview and restore the prior acceptance-criterion text.",
      available: false,
      disabledReason: null,
    },
    {
      action: "dispatch-fix",
      label: "Request Fix",
      summary: "Create or reuse ordinary task work for this coverage issue.",
      available: false,
      disabledReason: null,
    },
  ].map((entry) => {
    const disabledReason = disabledReasonForAction(entry.action, coverage, input.readOnly);
    return { ...entry, available: disabledReason === null, disabledReason };
  });

  const availableCount = actions.filter((action) => action.available).length;
  return {
    stateLabel: coverage?.presentation ?? "not_yet",
    readOnly: input.readOnly,
    hasCoverage: Boolean(coverage),
    actions,
    guidance: input.readOnly
      ? READ_ONLY_GUIDANCE
      : availableCount === 0
        ? "No resolution action is currently available for this criterion."
        : null,
  };
}

export function coverageResolutionTarget(input: {
  parentRef: string;
  criterion: SpecWorkspaceCriterionSummary;
}): CoverageResolutionTarget {
  return {
    item_ref: input.criterion.coverage?.item_ref ?? input.parentRef,
    ac_id: input.criterion.id,
  };
}

export function resolutionEffectSummary(effect: CoverageResolutionEffect): string {
  if (effect.kind === "verification_stamp") {
    return effect.operation === "would_write_stamp"
      ? "Would write a re-verification stamp."
      : "Wrote a re-verification stamp.";
  }
  if (effect.kind === "spec_text") {
    const fields = effect.fields.join(", ");
    return effect.operation === "would_edit_fields"
      ? `Would restore prior ${fields} text.`
      : `Restored prior ${fields} text.`;
  }
  if (effect.kind === "task") {
    const title = effect.title ? `: ${effect.title}` : "";
    if (effect.operation === "would_create_task")
      return `Would create a dispatch-fix task${title}.`;
    if (effect.operation === "would_reuse_task")
      return `Would reuse ${effect.task_ref ?? "an existing task"}${title}.`;
    if (effect.operation === "created_task")
      return `Created ${effect.task_ref ?? "a task"}${title}.`;
    return `Reused ${effect.task_ref ?? "an existing task"}${title}.`;
  }
  const scopes = effect.scopes.map((scope) => {
    if (scope.type === "criterion") return `${scope.item_ulid} ${scope.ac_id}`;
    if (scope.type === "item") return scope.item_ulid;
    return scope.ref ?? "@project";
  });
  return `${effect.operation.replaceAll("_", " ")} for ${scopes.join(", ")}.`;
}

export function taskEffectsFromResolution(
  response: CoverageResolutionResponse | null,
): Extract<CoverageResolutionEffect, { kind: "task" }>[] {
  return (
    response?.effects.filter(
      (effect): effect is Extract<CoverageResolutionEffect, { kind: "task" }> =>
        effect.kind === "task",
    ) ?? []
  );
}

export function storedResultMessage(response: CoverageResolutionResponse): string {
  if (response.stored)
    return "Resolution stored. The workspace will refresh from coverage-state events.";
  if (response.effects.some((effect) => effect.kind === "task")) {
    return "No new state was stored because existing task work matched this request.";
  }
  return "No state was stored for this resolution response.";
}
