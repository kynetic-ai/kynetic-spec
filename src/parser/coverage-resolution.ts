import { createHash } from "node:crypto";
import type {
  CoverageCriterionStateDetail,
  CoverageLatestRunEvidenceSummary,
  CoverageItemStateSummary,
  CoverageStateSnapshot,
  CoverageUnmappedResultSummary,
} from "@kynetic-ai/shared";
import {
  assertCoverageResolutionWritable,
  buildCoverageResolutionPreconditionDiagnostic,
  COVERAGE_RESOLUTION_STALE_TARGET_CODE,
  CoverageResolutionReadOnlyError,
  type CoverageResolutionAction,
  type CoverageResolutionEffect,
  type CoverageResolutionPreconditionDiagnostic,
  type CoverageResolutionRequest,
  type CoverageResolutionResponse,
  type CoverageResolutionTarget,
} from "../schema/coverage-resolution.js";
import { CoverageResolutionResponseSchema } from "../schema/coverage-resolution.js";
import type { ActorWriteValidationError, ActorWriteResolution } from "../identity/actor-write.js";
import { resolveActorForContext } from "../identity/actor-write-context.js";
import type { TaskInput } from "../schema/task.js";
import {
  findItemByRef,
  initContext,
  loadAllItems,
  updateSpecItemFromCurrent,
  type KspecContext,
  type LoadedSpecItem,
  type LoadedTask,
} from "./yaml.js";
import {
  getCachedCoverageStateReadModel,
  invalidateCoverageStateReadModelCache,
} from "./coverage-state-read-model.js";
import {
  readCriterionFreshnessComparison,
  type CriterionComparisonVersion,
  type CriterionTextComparison,
} from "./coverage-freshness-comparison.js";
import { commitIfShadow } from "./shadow.js";
import { resolveTaskDataManager } from "./task-data-manager.js";
import { writeVerificationStampWithoutCommit } from "./verification-record-store.js";

export { CoverageResolutionReadOnlyError };

export const COVERAGE_RESOLUTION_TARGET_NOT_FOUND_CODE = "coverage_resolution_target_not_found";
export const COVERAGE_RESOLUTION_CRITERION_NOT_FOUND_CODE =
  "coverage_resolution_criterion_not_found";
export const COVERAGE_RESOLUTION_AMBIGUOUS_TARGET_CODE = "coverage_resolution_ambiguous_target";
export const COVERAGE_RESOLUTION_ACTOR_INVALID_CODE = "coverage_resolution_actor_invalid";
export const COVERAGE_RESOLUTION_SPEC_TEXT_UNAVAILABLE_CODE =
  "coverage_resolution_spec_text_unavailable";

const EXPLICIT_REVERIFY_REQUIREMENT =
  "criterion is currently in the re-verify bucket with positive non-failing evidence";
const DISPATCH_FIX_REQUIREMENT =
  "criterion is currently in the failing, not-yet, or re-verify bucket";
const DISPATCH_FIX_IDEMPOTENCY_PREFIX = "Coverage-Resolution-Key:";

export type ExplicitReverifyCoverageResolutionRequest = Extract<
  CoverageResolutionRequest,
  { action: "explicit-reverify" }
>;
export type DispatchFixCoverageResolutionRequest = Extract<
  CoverageResolutionRequest,
  { action: "dispatch-fix" }
>;

export interface ApplyExplicitReverificationOptions {
  readOnly?: boolean;
  items?: LoadedSpecItem[];
  loadReadModel?: (ctx: KspecContext) => Promise<CoverageStateSnapshot>;
  now?: () => string;
  resolveActor?: (
    ctx: KspecContext,
    options: { explicit?: string | null; field?: string },
  ) => Promise<ActorWriteResolution>;
  writeStamp?: typeof writeVerificationStampWithoutCommit;
}

export interface ApplyDispatchFixOptions {
  readOnly?: boolean;
  items?: LoadedSpecItem[];
  loadReadModel?: (ctx: KspecContext) => Promise<CoverageStateSnapshot>;
}

export class CoverageResolutionTargetNotFoundError extends Error {
  readonly code: string;
  readonly target: string;
  readonly suggestion: string;

  constructor(options: { code: string; target: string; message: string; suggestion: string }) {
    super(options.message);
    this.name = "CoverageResolutionTargetNotFoundError";
    this.code = options.code;
    this.target = options.target;
    this.suggestion = options.suggestion;
  }
}

export class CoverageResolutionStaleTargetError extends Error {
  readonly code = COVERAGE_RESOLUTION_STALE_TARGET_CODE;
  readonly expectedFingerprint: string;
  readonly currentFingerprint: string;
  readonly suggestion =
    "Refresh the coverage detail and retry with the latest current fingerprint.";

  constructor(options: { expectedFingerprint: string; currentFingerprint: string }) {
    super("Coverage resolution target changed since the preview was generated.");
    this.name = "CoverageResolutionStaleTargetError";
    this.expectedFingerprint = options.expectedFingerprint;
    this.currentFingerprint = options.currentFingerprint;
  }
}

export class CoverageResolutionActorError extends Error {
  readonly code = COVERAGE_RESOLUTION_ACTOR_INVALID_CODE;
  readonly details: ActorWriteValidationError;
  readonly suggestion: string;

  constructor(details: ActorWriteValidationError) {
    super(details.message);
    this.name = "CoverageResolutionActorError";
    this.details = details;
    this.suggestion = details.message;
  }
}

export class CoverageResolutionSpecTextUnavailableError extends Error {
  readonly code = COVERAGE_RESOLUTION_SPEC_TEXT_UNAVAILABLE_CODE;
  readonly suggestion: string;

  constructor(options: { message: string; suggestion: string }) {
    super(options.message);
    this.name = "CoverageResolutionSpecTextUnavailableError";
    this.suggestion = options.suggestion;
  }
}

export interface ResolvedCoverageTarget {
  ctx: KspecContext;
  item: CoverageItemStateSummary;
  specItem: LoadedSpecItem;
  criterion: CoverageCriterionStateDetail;
  criterionText: {
    given: string;
    when: string;
    then: string;
  };
  fingerprint: string;
}

export interface ResolveCoverageTargetOptions {
  request: CoverageResolutionRequest | { target: CoverageResolutionTarget };
  items?: LoadedSpecItem[];
  loadReadModel?: (ctx: KspecContext) => Promise<CoverageStateSnapshot>;
}

type SpecTextRevertRequest = Extract<CoverageResolutionRequest, { action: "spec-text-revert" }>;

export interface SpecTextRevertOptions {
  request: SpecTextRevertRequest;
  readOnly?: boolean;
  items?: LoadedSpecItem[];
  loadReadModel?: (ctx: KspecContext) => Promise<CoverageStateSnapshot>;
  readComparison?: (
    item: LoadedSpecItem,
    acId: string,
    version: CriterionComparisonVersion,
  ) => Promise<CriterionTextComparison>;
}

type CriterionText = {
  given: string;
  when: string;
  then: string;
};

interface SpecTextRevertPlan {
  target: ResolvedCoverageTarget;
  previousText: CriterionText;
  changedFields: Array<"given" | "when" | "then">;
  priorCommit: string | null;
  priorTimestamp: string | null;
}

function isContext(project: string | KspecContext): project is KspecContext {
  return typeof project !== "string";
}

async function resolveContext(project: string | KspecContext): Promise<KspecContext> {
  return isContext(project) ? project : initContext(project, { syncMode: "skip" });
}

function targetRef(target: CoverageResolutionTarget): string {
  if (target.item_ref && target.item_ulid) {
    throw new CoverageResolutionTargetNotFoundError({
      code: COVERAGE_RESOLUTION_AMBIGUOUS_TARGET_CODE,
      target: `${target.item_ref} / ${target.item_ulid}`,
      message: "Coverage resolution target must use exactly one item identifier.",
      suggestion: "Retry with either item_ref or item_ulid, not both.",
    });
  }
  return target.item_ref ?? target.item_ulid ?? "";
}

function uniqueItemRefs(model: CoverageStateSnapshot): string[] {
  return [
    ...new Set(
      Object.values(model.items)
        .map((candidate) => candidate.item_ref)
        .filter((ref) => ref.length > 0),
    ),
  ].toSorted();
}

function nearestItemSuggestion(ref: string, candidates: readonly string[]): string {
  const cleanRef = ref.replace(/^@/, "").toLowerCase();
  const nearest =
    candidates.find((candidate) =>
      candidate.toLowerCase().includes(cleanRef.slice(0, Math.min(cleanRef.length, 6))),
    ) ?? candidates[0];
  return nearest
    ? `Use a valid coverage item reference such as ${nearest}, or run kspec search "${cleanRef}" to find the item.`
    : `Run kspec search "${cleanRef}" or kspec item list to find a valid item reference.`;
}

function resolveCoverageItem(
  model: CoverageStateSnapshot,
  target: CoverageResolutionTarget,
): CoverageItemStateSummary {
  const ref = targetRef(target);
  const item =
    model.items[ref] ??
    model.items[`@${ref}`] ??
    (target.item_ulid
      ? Object.values(model.items).find((candidate) => candidate.item_ulid === target.item_ulid)
      : undefined);
  if (item) return item;

  throw new CoverageResolutionTargetNotFoundError({
    code: COVERAGE_RESOLUTION_TARGET_NOT_FOUND_CODE,
    target: ref,
    message: `Coverage item reference "${ref}" was not found in the current coverage state.`,
    suggestion: nearestItemSuggestion(ref, uniqueItemRefs(model)),
  });
}

function resolveCoverageCriterion(
  model: CoverageStateSnapshot,
  item: CoverageItemStateSummary,
  acId: string,
): CoverageCriterionStateDetail {
  const criterion = model.criteria[`${item.item_ulid} ${acId}`];
  if (criterion) return criterion;

  throw new CoverageResolutionTargetNotFoundError({
    code: COVERAGE_RESOLUTION_CRITERION_NOT_FOUND_CODE,
    target: `${item.item_ref} ${acId}`,
    message: `Coverage criterion "${item.item_ref} ${acId}" was not found in the current coverage state.`,
    suggestion: `Use the coverage item detail for ${item.item_ref} to inspect available criteria before retrying.`,
  });
}

function resolveSpecItem(
  items: readonly LoadedSpecItem[],
  item: CoverageItemStateSummary,
): LoadedSpecItem {
  const specItem =
    findItemByRef([...items], item.item_ulid) ?? findItemByRef([...items], item.item_ref);
  if (!specItem) {
    throw new CoverageResolutionTargetNotFoundError({
      code: COVERAGE_RESOLUTION_TARGET_NOT_FOUND_CODE,
      target: item.item_ref,
      message: `Coverage item "${item.item_ref}" is present in coverage state but not in loaded spec items.`,
      suggestion: "Refresh project context and retry after the spec item is available.",
    });
  }
  return specItem;
}

function resolveCriterionText(specItem: LoadedSpecItem, acId: string) {
  const criterion = specItem.acceptance_criteria?.find((candidate) => candidate.id === acId);
  if (!criterion) {
    throw new CoverageResolutionTargetNotFoundError({
      code: COVERAGE_RESOLUTION_CRITERION_NOT_FOUND_CODE,
      target: `@${specItem.slugs[0] ?? specItem._ulid} ${acId}`,
      message: `Acceptance criterion "${acId}" was not found on the loaded spec item.`,
      suggestion: "Refresh project context and retry after the acceptance criterion is available.",
    });
  }
  return {
    given: criterion.given,
    when: criterion.when,
    then: criterion.then,
  };
}

export function fingerprintCoverageCriterionText(options: {
  itemUlid: string;
  acId: string;
  given: string;
  when: string;
  then: string;
}): string {
  const canonical = JSON.stringify({
    item_ulid: options.itemUlid,
    ac_id: options.acId,
    given: options.given,
    when: options.when,
    then: options.then,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf-8").digest("hex")}`;
}

function assertExpectedFingerprint(
  request: CoverageResolutionRequest | { target: CoverageResolutionTarget },
  currentFingerprint: string,
): void {
  if (!("expected_current_fingerprint" in request)) return;
  const expected = request.expected_current_fingerprint;
  if (expected && expected !== currentFingerprint) {
    throw new CoverageResolutionStaleTargetError({
      expectedFingerprint: expected,
      currentFingerprint,
    });
  }
}

export async function resolveCoverageTarget(
  project: string | KspecContext,
  options: ResolveCoverageTargetOptions,
): Promise<ResolvedCoverageTarget> {
  const ctx = await resolveContext(project);
  const model = await (options.loadReadModel ?? getCachedCoverageStateReadModel)(ctx);
  const item = resolveCoverageItem(model, options.request.target);
  const criterion = resolveCoverageCriterion(model, item, options.request.target.ac_id);
  const specItems = options.items ?? (await loadAllItems(ctx));
  const specItem = resolveSpecItem(specItems, item);
  const criterionText = resolveCriterionText(specItem, criterion.ac_id);
  const fingerprint = fingerprintCoverageCriterionText({
    itemUlid: item.item_ulid,
    acId: criterion.ac_id,
    ...criterionText,
  });
  assertExpectedFingerprint(options.request, fingerprint);
  return {
    ctx,
    item,
    specItem,
    criterion,
    criterionText,
    fingerprint,
  };
}

function targetSummary(target: ResolvedCoverageTarget): CoverageResolutionResponse["target"] {
  return {
    item_ulid: target.item.item_ulid,
    item_ref: target.item.item_ref,
    item_title: target.item.item_title,
    ac_id: target.criterion.ac_id,
    current_fingerprint: target.fingerprint,
  };
}

function currentSummary(target: ResolvedCoverageTarget): CoverageResolutionResponse["current"] {
  return {
    presentation: target.criterion.presentation,
    state: target.criterion.state,
    rule: target.criterion.explanation.rule,
    latest_run_id: target.criterion.explanation.latestRunId,
    source_evidence_ids: target.criterion.explanation.sourceEvidenceIds,
    secondary_causes: target.criterion.explanation.secondaryReverifyCauses.map((cause) => ({
      cause: cause.cause,
      source_evidence_ids: cause.sourceEvidenceIds,
      ...(cause.detail !== undefined ? { detail: cause.detail } : {}),
    })),
  };
}

function affectedCriterionScope(
  target: ResolvedCoverageTarget,
): CoverageResolutionResponse["affected_scopes"] {
  return [
    {
      type: "criterion",
      item_ulid: target.item.item_ulid,
      ac_id: target.criterion.ac_id,
    },
  ];
}

export function buildCoverageResolutionDryRunResponse(options: {
  action: CoverageResolutionAction;
  target: ResolvedCoverageTarget;
  effects: CoverageResolutionEffect[];
  diagnostics?: CoverageResolutionPreconditionDiagnostic[];
}): CoverageResolutionResponse {
  return CoverageResolutionResponseSchema.parse({
    action: options.action,
    dry_run: true,
    stored: false,
    target: targetSummary(options.target),
    current: currentSummary(options.target),
    diagnostics: options.diagnostics ?? [],
    effects: options.effects,
    affected_scopes: affectedCriterionScope(options.target),
  });
}

function buildCoverageResolutionResponse(options: {
  action: CoverageResolutionAction;
  dryRun: boolean;
  stored: boolean;
  target: ResolvedCoverageTarget;
  diagnostics: CoverageResolutionPreconditionDiagnostic[];
  effects: CoverageResolutionEffect[];
}): CoverageResolutionResponse {
  return CoverageResolutionResponseSchema.parse({
    action: options.action,
    dry_run: options.dryRun,
    stored: options.stored,
    target: targetSummary(options.target),
    current: currentSummary(options.target),
    diagnostics: options.diagnostics,
    effects: options.effects,
    affected_scopes: affectedCriterionScope(options.target),
  });
}

function hasLatestFailedOrErroredResult(criterion: CoverageCriterionStateDetail): boolean {
  return criterion.latest_run_evidence.some(
    (evidence) => evidence.status === "failed" || evidence.status === "errored",
  );
}

function explicitReverificationSuggestion(target: ResolvedCoverageTarget): string {
  if (target.criterion.presentation === "covered") {
    return "Refresh the coverage detail; this criterion is already covered.";
  }
  if (target.criterion.presentation === "not_yet") {
    return "Add coverage evidence for this criterion before re-verifying it.";
  }
  if (
    target.criterion.presentation === "failing" ||
    hasLatestFailedOrErroredResult(target.criterion)
  ) {
    return "Fix failing tests before re-verifying this criterion.";
  }
  return "Refresh the coverage detail and retry once the criterion has positive non-failing evidence.";
}

function canExplicitlyReverify(target: ResolvedCoverageTarget): boolean {
  return (
    target.criterion.presentation === "re_verify" &&
    target.criterion.explanation.rule === "positive_evidence_requires_reverification" &&
    target.criterion.explanation.sourceEvidenceIds.length > 0 &&
    !hasLatestFailedOrErroredResult(target.criterion)
  );
}

function explicitReverificationDiagnostic(
  target: ResolvedCoverageTarget,
): CoverageResolutionPreconditionDiagnostic {
  const satisfied = canExplicitlyReverify(target);
  return buildCoverageResolutionPreconditionDiagnostic({
    criterion: target.criterion,
    requirement: EXPLICIT_REVERIFY_REQUIREMENT,
    satisfied,
    suggestion: satisfied
      ? "Write a re-verification stamp for the current positive evidence."
      : explicitReverificationSuggestion(target),
  });
}

function selectComparableCommit(
  request: ExplicitReverifyCoverageResolutionRequest,
  target: ResolvedCoverageTarget,
): string | undefined {
  if (request.commit) return request.commit.commit;
  if (request.commit === null) return undefined;

  const positiveRunCommit = target.criterion.latest_run_evidence.find(
    (evidence) =>
      evidence.status !== "failed" &&
      evidence.status !== "errored" &&
      typeof evidence.code_revision === "string" &&
      evidence.code_revision.length > 0,
  )?.code_revision;
  return (
    positiveRunCommit ??
    target.criterion.freshness.bootstrap?.commit ??
    target.criterion.freshness.recorded?.commit ??
    undefined
  );
}

function verificationStampEffect(options: {
  operation: "would_write_stamp" | "wrote_stamp";
  target: ResolvedCoverageTarget;
  actor: string;
  verifiedAt: string;
  commit?: string;
  sessionId?: string | null;
}): CoverageResolutionEffect {
  return {
    kind: "verification_stamp",
    operation: options.operation,
    item_ulid: options.target.item.item_ulid,
    ac_id: options.target.criterion.ac_id,
    provenance: "re_verification",
    actor: options.actor,
    verified_at: options.verifiedAt,
    ...(options.commit ? { commit: options.commit } : {}),
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
  };
}

function cacheInvalidationEffect(
  operation: "would_invalidate" | "invalidated",
  target: ResolvedCoverageTarget,
): CoverageResolutionEffect {
  return {
    kind: "cache_event",
    operation,
    scopes: affectedCriterionScope(target),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf-8")
    .digest("hex")}`;
}

function dispatchFixIssueFingerprint(target: ResolvedCoverageTarget): string {
  return sha256Json({
    item_ulid: target.item.item_ulid,
    ac_id: target.criterion.ac_id,
    presentation: target.criterion.presentation,
    state: target.criterion.state,
    rule: target.criterion.explanation.rule,
    latest_run_id: target.criterion.explanation.latestRunId,
    source_evidence_ids: target.criterion.explanation.sourceEvidenceIds.toSorted(),
    secondary_causes: target.criterion.explanation.secondaryReverifyCauses.map((cause) => ({
      cause: cause.cause,
      detail: cause.detail ?? null,
      source_evidence_ids: cause.sourceEvidenceIds.toSorted(),
    })),
    latest_run_evidence: target.criterion.latest_run_evidence.map((evidence) => ({
      run_id: evidence.run_id,
      case_id: evidence.case_id,
      status: evidence.status,
      completed_at: evidence.completed_at,
      code_revision: evidence.code_revision,
      producer: evidence.producer,
    })),
    freshness: target.criterion.freshness,
    unmapped_result_references: target.criterion.unmapped_result_references,
  });
}

function dispatchFixIdempotencyKey(target: ResolvedCoverageTarget): string {
  return sha256Json({
    action: "dispatch-fix",
    item_ulid: target.item.item_ulid,
    ac_id: target.criterion.ac_id,
    issue_fingerprint: dispatchFixIssueFingerprint(target),
  });
}

function canDispatchFix(target: ResolvedCoverageTarget, allowCovered: boolean): boolean {
  return target.criterion.presentation !== "covered" || allowCovered;
}

function dispatchFixSuggestion(target: ResolvedCoverageTarget, allowCovered: boolean): string {
  if (target.criterion.presentation === "covered" && allowCovered) {
    return "Create ordinary task work for this covered criterion because the caller explicitly requested it.";
  }
  if (target.criterion.presentation === "covered") {
    return "Refresh the coverage detail; this criterion is already covered.";
  }
  return "Create ordinary task work for a human or configured dispatch worker to repair the coverage issue.";
}

function dispatchFixDiagnostic(
  target: ResolvedCoverageTarget,
  allowCovered: boolean,
): CoverageResolutionPreconditionDiagnostic {
  const satisfied = canDispatchFix(target, allowCovered);
  return buildCoverageResolutionPreconditionDiagnostic({
    criterion: target.criterion,
    requirement: DISPATCH_FIX_REQUIREMENT,
    satisfied,
    suggestion: dispatchFixSuggestion(target, allowCovered),
  });
}

function formatEvidenceIds(ids: readonly string[]): string {
  return ids.length > 0 ? ids.map((id) => `- ${id}`).join("\n") : "- None reported";
}

function formatLatestRunEvidence(evidence: readonly CoverageLatestRunEvidenceSummary[]): string {
  if (evidence.length === 0) return "- None reported";
  return evidence
    .map((entry) =>
      [
        `- Run: ${entry.run_id}`,
        `  Case: ${entry.case_id}`,
        `  Display: ${entry.display_name}`,
        `  Status: ${entry.status}`,
        `  Completed: ${entry.completed_at}`,
        `  Producer: ${entry.producer.kind}/${entry.producer.label}`,
        `  Code revision: ${entry.code_revision ?? "not reported"}`,
      ].join("\n"),
    )
    .join("\n");
}

function formatFreshness(target: ResolvedCoverageTarget): string {
  const lines = [
    `- Bootstrap: ${
      target.criterion.freshness.bootstrap
        ? JSON.stringify(target.criterion.freshness.bootstrap)
        : "not reported"
    }`,
    `- Recorded: ${
      target.criterion.freshness.recorded
        ? JSON.stringify(target.criterion.freshness.recorded)
        : "not reported"
    }`,
  ];
  if (target.criterion.freshness.secondary_causes.length > 0) {
    lines.push("- Secondary causes:");
    for (const cause of target.criterion.freshness.secondary_causes) {
      lines.push(
        `  - ${cause.cause}: ${cause.detail ?? "no detail"} (${cause.sourceEvidenceIds.join(", ")})`,
      );
    }
  }
  return lines.join("\n");
}

function formatUnmappedResults(results: readonly CoverageUnmappedResultSummary[]): string {
  if (results.length === 0) return "- None reported";
  return results
    .map((entry) =>
      [
        `- ${entry.kind}: ${entry.reason}`,
        `  Run: ${entry.run_id}`,
        `  Case: ${entry.case_id}`,
        `  Display: ${entry.display_name ?? "not reported"}`,
        `  Producer: ${entry.producer.kind}/${entry.producer.label}`,
        `  Item ref: ${entry.item_ref ?? "not mapped"}`,
        `  AC id: ${entry.ac_id ?? "not mapped"}`,
      ].join("\n"),
    )
    .join("\n");
}

function taskRef(task: LoadedTask): string {
  return `@${task.slugs[0] ?? task._ulid}`;
}

function taskTitle(target: ResolvedCoverageTarget): string {
  return `Fix coverage for ${target.item.item_ref} ${target.criterion.ac_id}`;
}

function dispatchFixTaskBody(options: {
  target: ResolvedCoverageTarget;
  idempotencyKey: string;
}): string {
  const { target, idempotencyKey } = options;
  const currentCause =
    target.criterion.explanation.secondaryReverifyCauses[0]?.cause ??
    (target.criterion.presentation === "covered" ? "covered" : target.criterion.state);
  return [
    `${DISPATCH_FIX_IDEMPOTENCY_PREFIX} ${idempotencyKey}`,
    "",
    "## Coverage Target",
    "",
    `Item: ${target.item.item_ref} — ${target.item.item_title}`,
    `Item ULID: ${target.item.item_ulid}`,
    `Acceptance Criterion: ${target.criterion.ac_id}`,
    "",
    "Current AC Text:",
    `- Given: ${target.criterionText.given}`,
    `- When: ${target.criterionText.when}`,
    `- Then: ${target.criterionText.then}`,
    "",
    "## Coverage State",
    "",
    `Presentation Bucket: ${target.criterion.presentation}`,
    `Internal State: ${target.criterion.state}`,
    `Current Cause: ${currentCause}`,
    "",
    "Machine-Readable Explanation:",
    "```json",
    JSON.stringify(canonicalize(target.criterion.explanation), null, 2),
    "```",
    "",
    "Source Evidence IDs:",
    formatEvidenceIds(target.criterion.explanation.sourceEvidenceIds),
    "",
    "Latest Run Evidence:",
    formatLatestRunEvidence(target.criterion.latest_run_evidence),
    "",
    "Freshness Detail:",
    formatFreshness(target),
    "",
    "Unmapped or Invalid Result References:",
    formatUnmappedResults(target.criterion.unmapped_result_references),
    "",
    "## Suggested Repair Checklist",
    "",
    "- Inspect the referenced kspec item and acceptance criterion.",
    "- Add or repair behavioral evidence for the criterion.",
    "- Fix failing or errored result cases when latest run evidence reports them.",
    "- Update stale annotations or mappings when freshness causes point to mapping drift.",
    "- Re-run the project's normal validation workflow after the repair.",
    "",
    "Existing Dispatch Policy:",
    "This is an ordinary kspec task. Existing task automation fields may make it eligible for the configured dispatch engine, but this coverage action does not start an agent process.",
  ].join("\n");
}

function taskEffect(options: {
  operation: "would_create_task" | "would_reuse_task" | "created_task" | "reused_task";
  target: ResolvedCoverageTarget;
  automationEligible: boolean;
  idempotencyKey: string;
  task?: LoadedTask;
}): CoverageResolutionEffect {
  return {
    kind: "task",
    operation: options.operation,
    task_ref: options.task ? taskRef(options.task) : null,
    title: taskTitle(options.target),
    automation_eligible: options.automationEligible,
    idempotency_key: options.idempotencyKey,
  };
}

function isUnresolvedTask(task: LoadedTask): boolean {
  return task.status !== "completed" && task.status !== "cancelled";
}

function taskHasIdempotencyKey(task: LoadedTask, idempotencyKey: string): boolean {
  const marker = `${DISPATCH_FIX_IDEMPOTENCY_PREFIX} ${idempotencyKey}`;
  return task.description?.split(/\r?\n/).some((line) => line.trim() === marker) ?? false;
}

async function findExistingDispatchFixTask(
  ctx: KspecContext,
  idempotencyKey: string,
): Promise<LoadedTask | undefined> {
  const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
  return tasks.find(
    (task) => isUnresolvedTask(task) && taskHasIdempotencyKey(task, idempotencyKey),
  );
}

async function createDispatchFixTask(options: {
  ctx: KspecContext;
  target: ResolvedCoverageTarget;
  idempotencyKey: string;
  automationEligible: boolean;
}): Promise<LoadedTask> {
  const input: TaskInput = {
    title: taskTitle(options.target),
    description: dispatchFixTaskBody({
      target: options.target,
      idempotencyKey: options.idempotencyKey,
    }),
    spec_ref: options.target.item.item_ref,
    priority: 2,
    tags: ["coverage", "dispatch-fix"],
    automation: options.automationEligible ? "eligible" : undefined,
  };
  return resolveTaskDataManager(options.ctx).createTask(options.ctx, input, {
    operation: "coverage-dispatch-fix",
    ref: options.target.item.item_ref,
    detail: `${options.target.item.item_ref} ${options.target.criterion.ac_id}`,
  });
}

function hasStaleSpecTextCause(target: ResolvedCoverageTarget): boolean {
  return (
    target.criterion.state === "stale_spec_text" ||
    target.criterion.explanation.secondaryReverifyCauses.some(
      (cause) => cause.cause === "stale_spec_text",
    ) ||
    target.criterion.freshness.secondary_causes.some((cause) => cause.cause === "stale_spec_text")
  );
}

function comparisonVersion(target: ResolvedCoverageTarget): CriterionComparisonVersion | null {
  const recorded = target.criterion.freshness.recorded;
  if (recorded) {
    return {
      atCommit: recorded.commit ?? null,
      atTimestamp: recorded.timestamp || recorded.verified_at,
    };
  }

  const bootstrap = target.criterion.freshness.bootstrap;
  if (bootstrap) {
    return {
      atCommit: bootstrap.commit ?? null,
      atTimestamp: bootstrap.timestamp ?? undefined,
    };
  }

  return null;
}

function specTextUnavailable(
  message: string,
  suggestion: string,
): CoverageResolutionSpecTextUnavailableError {
  return new CoverageResolutionSpecTextUnavailableError({ message, suggestion });
}

function changedTextFields(
  previous: CriterionText,
  current: CriterionText,
): Array<"given" | "when" | "then"> {
  return (["given", "when", "then"] as const).filter((field) => previous[field] !== current[field]);
}

async function resolveSpecTextRevertPlan(
  project: string | KspecContext,
  options: SpecTextRevertOptions,
): Promise<SpecTextRevertPlan> {
  const target = await resolveCoverageTarget(project, options);
  if (!hasStaleSpecTextCause(target)) {
    throw specTextUnavailable(
      `Coverage criterion "${target.item.item_ref} ${target.criterion.ac_id}" does not currently have stale spec text.`,
      "Refresh the coverage detail and choose spec-text revert only for stale spec text causes.",
    );
  }

  const version = comparisonVersion(target);
  if (!version || (!version.atCommit && !version.atTimestamp)) {
    throw specTextUnavailable(
      `Coverage criterion "${target.item.item_ref} ${target.criterion.ac_id}" lacks comparable prior verification metadata.`,
      "Refresh the coverage detail after recording comparable verification metadata.",
    );
  }

  const comparison = await (options.readComparison ?? readCriterionFreshnessComparison)(
    target.specItem,
    target.criterion.ac_id,
    version,
  );
  if (comparison.status !== "changed" || !comparison.previous || !comparison.previousCommit) {
    throw specTextUnavailable(
      comparison.detail ??
        `Prior criterion text for "${target.item.item_ref} ${target.criterion.ac_id}" could not be resolved.`,
      "Refresh the coverage detail; if the prior criterion text is still unavailable, edit the criterion manually.",
    );
  }

  const previousText = {
    given: comparison.previous.given,
    when: comparison.previous.when,
    then: comparison.previous.then,
  };
  const changedFields = changedTextFields(previousText, target.criterionText);
  if (changedFields.length === 0) {
    throw specTextUnavailable(
      `Coverage criterion "${target.item.item_ref} ${target.criterion.ac_id}" already matches the prior criterion text.`,
      "Refresh the coverage detail before retrying spec-text revert.",
    );
  }

  return {
    target,
    previousText,
    changedFields,
    priorCommit: comparison.previousCommit,
    priorTimestamp: version.atTimestamp ?? null,
  };
}

function specTextRevertSummary(plan: SpecTextRevertPlan): string {
  return `Revert ${plan.target.item.item_ref} ${plan.target.criterion.ac_id} (${plan.target.item.item_title}) spec text fields: ${plan.changedFields.join(", ")}`;
}

function specTextEffect(
  plan: SpecTextRevertPlan,
  operation: "would_edit_fields" | "edited_fields",
): CoverageResolutionEffect {
  return {
    kind: "spec_text",
    operation,
    item_ulid: plan.target.item.item_ulid,
    ac_id: plan.target.criterion.ac_id,
    fields: plan.changedFields,
    current_text: plan.target.criterionText,
    prior_text: plan.previousText,
    prior_commit: plan.priorCommit,
    prior_timestamp: plan.priorTimestamp,
    summary: specTextRevertSummary(plan),
  };
}

async function resolveCoverageResolutionActor(
  ctx: KspecContext,
  request: ExplicitReverifyCoverageResolutionRequest,
  options: ApplyExplicitReverificationOptions,
): Promise<string> {
  const actorResult = await (options.resolveActor ?? resolveActorForContext)(ctx, {
    explicit: request.actor,
    field: "actor",
  });
  if (!actorResult.ok) {
    throw new CoverageResolutionActorError(actorResult.error);
  }
  return actorResult.actor;
}

export async function applyExplicitReverification(
  ctx: KspecContext,
  request: ExplicitReverifyCoverageResolutionRequest,
  options: ApplyExplicitReverificationOptions = {},
): Promise<CoverageResolutionResponse> {
  assertCoverageResolutionWritable({
    readOnly: options.readOnly,
    dryRun: request.dry_run,
  });

  const target = await resolveCoverageTarget(ctx, {
    request,
    items: options.items,
    loadReadModel: options.loadReadModel,
  });
  const diagnostic = explicitReverificationDiagnostic(target);
  if (!diagnostic.satisfied) {
    return buildCoverageResolutionResponse({
      action: request.action,
      dryRun: request.dry_run,
      stored: false,
      target,
      diagnostics: [diagnostic],
      effects: [],
    });
  }

  const actor = await resolveCoverageResolutionActor(ctx, request, options);
  const verifiedAt = (options.now ?? (() => new Date().toISOString()))();
  const commit = selectComparableCommit(request, target);
  const stampEffect = verificationStampEffect({
    operation: request.dry_run ? "would_write_stamp" : "wrote_stamp",
    target,
    actor,
    verifiedAt,
    commit,
    sessionId: request.session_id,
  });

  if (request.dry_run) {
    return buildCoverageResolutionDryRunResponse({
      action: request.action,
      target,
      diagnostics: [diagnostic],
      effects: [stampEffect, cacheInvalidationEffect("would_invalidate", target)],
    });
  }

  await (options.writeStamp ?? writeVerificationStampWithoutCommit)(
    ctx,
    target.item.item_ulid,
    target.criterion.ac_id,
    {
      verified_at: verifiedAt,
      actor,
      provenance: "re_verification",
      ...(commit ? { commit } : {}),
      ...(request.session_id ? { session: request.session_id } : {}),
    },
  );
  invalidateCoverageStateReadModelCache(ctx.rootDir);

  const postWriteTarget = await resolveCoverageTarget(ctx, {
    request,
    items: options.items,
    loadReadModel: options.loadReadModel,
  });

  return buildCoverageResolutionResponse({
    action: request.action,
    dryRun: false,
    stored: true,
    target: postWriteTarget,
    diagnostics: [diagnostic],
    effects: [stampEffect, cacheInvalidationEffect("invalidated", target)],
  });
}

export async function applyDispatchFixRequest(
  ctx: KspecContext,
  request: DispatchFixCoverageResolutionRequest,
  options: ApplyDispatchFixOptions = {},
): Promise<CoverageResolutionResponse> {
  assertCoverageResolutionWritable({
    readOnly: options.readOnly,
    dryRun: request.dry_run,
  });

  const target = await resolveCoverageTarget(ctx, {
    request,
    items: options.items,
    loadReadModel: options.loadReadModel,
  });
  const diagnostic = dispatchFixDiagnostic(target, request.allow_covered);
  if (!diagnostic.satisfied) {
    return buildCoverageResolutionResponse({
      action: request.action,
      dryRun: request.dry_run,
      stored: false,
      target,
      diagnostics: [diagnostic],
      effects: [],
    });
  }

  const idempotencyKey = dispatchFixIdempotencyKey(target);
  const existingTask = request.allow_duplicate
    ? undefined
    : await findExistingDispatchFixTask(ctx, idempotencyKey);
  if (existingTask) {
    return buildCoverageResolutionResponse({
      action: request.action,
      dryRun: request.dry_run,
      stored: false,
      target,
      diagnostics: [diagnostic],
      effects: [
        taskEffect({
          operation: request.dry_run ? "would_reuse_task" : "reused_task",
          target,
          task: existingTask,
          automationEligible: existingTask.automation === "eligible",
          idempotencyKey,
        }),
      ],
    });
  }

  if (request.dry_run) {
    return buildCoverageResolutionDryRunResponse({
      action: request.action,
      target,
      diagnostics: [diagnostic],
      effects: [
        taskEffect({
          operation: "would_create_task",
          target,
          automationEligible: request.automation_eligible,
          idempotencyKey,
        }),
        cacheInvalidationEffect("would_invalidate", target),
      ],
    });
  }

  const task = await createDispatchFixTask({
    ctx,
    target,
    idempotencyKey,
    automationEligible: request.automation_eligible,
  });
  invalidateCoverageStateReadModelCache(ctx.rootDir);

  return buildCoverageResolutionResponse({
    action: request.action,
    dryRun: false,
    stored: true,
    target,
    diagnostics: [diagnostic],
    effects: [
      taskEffect({
        operation: "created_task",
        target,
        task,
        automationEligible: task.automation === "eligible",
        idempotencyKey,
      }),
      cacheInvalidationEffect("invalidated", target),
    ],
  });
}

export async function previewSpecTextRevert(
  project: string | KspecContext,
  options: SpecTextRevertOptions,
): Promise<CoverageResolutionResponse> {
  const plan = await resolveSpecTextRevertPlan(project, options);
  return buildCoverageResolutionDryRunResponse({
    action: "spec-text-revert",
    target: plan.target,
    diagnostics: [
      {
        code: "coverage_resolution_precondition_satisfied",
        message: "Spec-text revert precondition is satisfied.",
        current_presentation: plan.target.criterion.presentation,
        current_state: plan.target.criterion.state,
        current_cause: "stale_spec_text",
        missing_requirement: "current stale_spec_text cause with resolvable prior criterion text",
        satisfied: true,
        suggestion: "Apply the spec-text revert with the current fingerprint to store the edit.",
      },
    ],
    effects: [
      specTextEffect(plan, "would_edit_fields"),
      cacheInvalidationEffect("would_invalidate", plan.target),
    ],
  });
}

export async function applySpecTextRevert(
  project: string | KspecContext,
  options: SpecTextRevertOptions,
): Promise<CoverageResolutionResponse> {
  assertCoverageResolutionWritable({
    readOnly: options.readOnly,
    dryRun: options.request.dry_run,
  });
  if (options.request.dry_run) {
    return previewSpecTextRevert(project, options);
  }

  const plan = await resolveSpecTextRevertPlan(project, options);
  let lockedCriterionText = plan.target.criterionText;
  let lockedFingerprint = plan.target.fingerprint;
  const updatedSpecItem = await updateSpecItemFromCurrent(
    plan.target.ctx,
    plan.target.specItem,
    (currentItem) => {
      lockedCriterionText = resolveCriterionText(currentItem, plan.target.criterion.ac_id);
      lockedFingerprint = fingerprintCoverageCriterionText({
        itemUlid: plan.target.item.item_ulid,
        acId: plan.target.criterion.ac_id,
        ...lockedCriterionText,
      });
      assertExpectedFingerprint(options.request, lockedFingerprint);

      const existingCriteria = currentItem.acceptance_criteria ?? [];
      const criterionIndex = existingCriteria.findIndex(
        (criterion) => criterion.id === plan.target.criterion.ac_id,
      );
      if (criterionIndex < 0) {
        throw new CoverageResolutionTargetNotFoundError({
          code: COVERAGE_RESOLUTION_CRITERION_NOT_FOUND_CODE,
          target: `${plan.target.item.item_ref} ${plan.target.criterion.ac_id}`,
          message: `Acceptance criterion "${plan.target.criterion.ac_id}" was not found on the loaded spec item.`,
          suggestion:
            "Refresh project context and retry after the acceptance criterion is available.",
        });
      }

      return {
        acceptance_criteria: existingCriteria.map((criterion, index) =>
          index === criterionIndex
            ? {
                ...criterion,
                ...Object.fromEntries(
                  plan.changedFields.map((field) => [field, plan.previousText[field]]),
                ),
              }
            : criterion,
        ),
      };
    },
  );
  await commitIfShadow(
    plan.target.ctx.shadow,
    "item-ac-set",
    plan.target.item.item_ref,
    `${plan.target.criterion.ac_id} spec-text-revert`,
  );
  invalidateCoverageStateReadModelCache(plan.target.ctx.rootDir);

  return buildCoverageResolutionResponse({
    action: "spec-text-revert",
    dryRun: false,
    stored: true,
    target: {
      ...plan.target,
      specItem: updatedSpecItem as LoadedSpecItem,
      criterionText: lockedCriterionText,
      fingerprint: lockedFingerprint,
    },
    diagnostics: [
      {
        code: "coverage_resolution_precondition_satisfied",
        message: "Spec-text revert precondition is satisfied.",
        current_presentation: plan.target.criterion.presentation,
        current_state: plan.target.criterion.state,
        current_cause: "stale_spec_text",
        missing_requirement: "current stale_spec_text cause with resolvable prior criterion text",
        satisfied: true,
        suggestion: "Refresh coverage state to inspect the post-mutation criterion status.",
      },
    ],
    effects: [
      specTextEffect(plan, "edited_fields"),
      cacheInvalidationEffect("invalidated", plan.target),
    ],
  });
}
