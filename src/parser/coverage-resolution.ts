import { createHash } from "node:crypto";
import type {
  CoverageCriterionStateDetail,
  CoverageItemStateSummary,
  CoverageStateSnapshot,
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
import {
  findItemByRef,
  initContext,
  loadAllItems,
  type KspecContext,
  type LoadedSpecItem,
} from "./yaml.js";
import {
  getCachedCoverageStateReadModel,
  invalidateCoverageStateReadModelCache,
} from "./coverage-state-read-model.js";
import { writeVerificationStampWithoutCommit } from "./verification-record-store.js";

export { CoverageResolutionReadOnlyError };

export const COVERAGE_RESOLUTION_TARGET_NOT_FOUND_CODE = "coverage_resolution_target_not_found";
export const COVERAGE_RESOLUTION_CRITERION_NOT_FOUND_CODE =
  "coverage_resolution_criterion_not_found";
export const COVERAGE_RESOLUTION_AMBIGUOUS_TARGET_CODE = "coverage_resolution_ambiguous_target";
export const COVERAGE_RESOLUTION_ACTOR_INVALID_CODE = "coverage_resolution_actor_invalid";

const EXPLICIT_REVERIFY_REQUIREMENT =
  "criterion is currently in the re-verify bucket with positive non-failing evidence";

export type ExplicitReverifyCoverageResolutionRequest = Extract<
  CoverageResolutionRequest,
  { action: "explicit-reverify" }
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
