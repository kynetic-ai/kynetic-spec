import { z } from "zod";
import { AcIdSchema, DateTimeSchema, RefSchema, UlidSchema } from "./common.js";

export const COVERAGE_RESOLUTION_ACTIONS = [
  "explicit-reverify",
  "spec-text-revert",
  "dispatch-fix",
] as const;

export const COVERAGE_RESOLUTION_READ_ONLY_CODE = "coverage_resolution_read_only";
export const COVERAGE_RESOLUTION_STALE_TARGET_CODE = "coverage_resolution_stale_target";

export class CoverageResolutionReadOnlyError extends Error {
  readonly code = COVERAGE_RESOLUTION_READ_ONLY_CODE;
  readonly suggestion =
    "Use a live writable kspec project or daemon-backed workspace to apply coverage resolution actions.";

  constructor() {
    super("Coverage resolution mutations are unavailable in read-only/static export mode.");
    this.name = "CoverageResolutionReadOnlyError";
  }
}

export const CoverageResolutionActionSchema = z.enum(COVERAGE_RESOLUTION_ACTIONS);

export const CoverageResolutionTargetSchema = z
  .object({
    item_ref: z.string().min(1).optional(),
    item_ulid: UlidSchema.optional(),
    ac_id: AcIdSchema,
  })
  .strict()
  .refine((target) => Boolean(target.item_ref) !== Boolean(target.item_ulid), {
    path: ["item_ref"],
    message: "Exactly one of item_ref or item_ulid is required.",
  });

export const CoverageResolutionCommitMetadataSchema = z
  .object({
    commit: z.string().min(1),
    branch: z.string().min(1).nullable().optional(),
    remote_url: z.string().min(1).nullable().optional(),
  })
  .strict();

const CoverageResolutionBaseRequestSchema = z
  .object({
    target: CoverageResolutionTargetSchema,
    dry_run: z.boolean().default(false),
    expected_current_fingerprint: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
    actor: z.string().min(1).nullable().optional(),
    session_id: UlidSchema.nullable().optional(),
    commit: CoverageResolutionCommitMetadataSchema.nullable().optional(),
  })
  .strict();

export const ExplicitReverifyCoverageResolutionRequestSchema =
  CoverageResolutionBaseRequestSchema.extend({
    action: z.literal("explicit-reverify"),
  }).strict();

export const SpecTextRevertCoverageResolutionRequestSchema =
  CoverageResolutionBaseRequestSchema.extend({
    action: z.literal("spec-text-revert"),
  }).strict();

export const DispatchFixCoverageResolutionRequestSchema =
  CoverageResolutionBaseRequestSchema.extend({
    action: z.literal("dispatch-fix"),
    automation_eligible: z.boolean().default(false),
    allow_duplicate: z.boolean().default(false),
  }).strict();

export const CoverageResolutionRequestSchema = z.discriminatedUnion("action", [
  ExplicitReverifyCoverageResolutionRequestSchema,
  SpecTextRevertCoverageResolutionRequestSchema,
  DispatchFixCoverageResolutionRequestSchema,
]);

export const CoverageResolutionTargetSummarySchema = z
  .object({
    item_ulid: UlidSchema,
    item_ref: RefSchema,
    item_title: z.string().min(1),
    ac_id: AcIdSchema,
    current_fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export const CoverageResolutionAffectedScopeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("criterion"),
      item_ulid: UlidSchema,
      ac_id: AcIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("item"),
      item_ulid: UlidSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("project"),
      ref: z.literal("@project").default("@project"),
    })
    .strict(),
]);

export const CoverageResolutionPreconditionDiagnosticSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    current_presentation: z.enum(["covered", "failing", "not_yet", "re_verify"]),
    current_state: z.string().min(1),
    current_cause: z.string().min(1).nullable(),
    missing_requirement: z.string().min(1),
    satisfied: z.boolean(),
    suggestion: z.string().min(1),
  })
  .strict();

export const CoverageResolutionEffectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("verification_stamp"),
      operation: z.enum(["would_write_stamp", "wrote_stamp"]),
      item_ulid: UlidSchema,
      ac_id: AcIdSchema,
      provenance: z.literal("re_verification"),
      actor: z.string().min(1).nullable().optional(),
      verified_at: DateTimeSchema.nullable().optional(),
      commit: z.string().min(1).nullable().optional(),
      session_id: UlidSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("spec_text"),
      operation: z.enum(["would_edit_fields", "edited_fields"]),
      item_ulid: UlidSchema,
      ac_id: AcIdSchema,
      fields: z.array(z.enum(["given", "when", "then"])).min(1),
      prior_commit: z.string().min(1).nullable().optional(),
      prior_timestamp: DateTimeSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task"),
      operation: z.enum(["would_create_task", "would_reuse_task", "created_task", "reused_task"]),
      task_ref: RefSchema.nullable().optional(),
      title: z.string().min(1).optional(),
      automation_eligible: z.boolean().default(false),
      idempotency_key: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cache_event"),
      operation: z.enum(["would_invalidate", "invalidated", "would_broadcast", "broadcast"]),
      scopes: z.array(CoverageResolutionAffectedScopeSchema),
    })
    .strict(),
]);

export const CoverageResolutionResponseSchema = z
  .object({
    action: CoverageResolutionActionSchema,
    dry_run: z.boolean(),
    stored: z.boolean(),
    target: CoverageResolutionTargetSummarySchema,
    current: z
      .object({
        presentation: z.enum(["covered", "failing", "not_yet", "re_verify"]),
        state: z.string().min(1),
        rule: z.string().min(1),
        latest_run_id: z.string().min(1).nullable(),
        source_evidence_ids: z.array(z.string()),
        secondary_causes: z.array(
          z
            .object({
              cause: z.string().min(1),
              source_evidence_ids: z.array(z.string()),
              detail: z.string().min(1).optional(),
            })
            .strict(),
        ),
      })
      .strict(),
    diagnostics: z.array(CoverageResolutionPreconditionDiagnosticSchema),
    effects: z.array(CoverageResolutionEffectSchema),
    affected_scopes: z.array(CoverageResolutionAffectedScopeSchema),
  })
  .strict();

export type CoverageResolutionAction = z.infer<typeof CoverageResolutionActionSchema>;
export type CoverageResolutionTarget = z.infer<typeof CoverageResolutionTargetSchema>;
export type CoverageResolutionRequest = z.infer<typeof CoverageResolutionRequestSchema>;
export type CoverageResolutionTargetSummary = z.infer<typeof CoverageResolutionTargetSummarySchema>;
export type CoverageResolutionAffectedScope = z.infer<typeof CoverageResolutionAffectedScopeSchema>;
export type CoverageResolutionPreconditionDiagnostic = z.infer<
  typeof CoverageResolutionPreconditionDiagnosticSchema
>;
export type CoverageResolutionEffect = z.infer<typeof CoverageResolutionEffectSchema>;
export type CoverageResolutionResponse = z.infer<typeof CoverageResolutionResponseSchema>;

export function assertCoverageResolutionWritable(options: {
  readOnly?: boolean;
  dryRun?: boolean;
}): void {
  if (options.readOnly === true && options.dryRun !== true) {
    throw new CoverageResolutionReadOnlyError();
  }
}

export function buildCoverageResolutionPreconditionDiagnostic(options: {
  criterion: {
    presentation: CoverageResolutionPreconditionDiagnostic["current_presentation"];
    state: string;
    explanation: {
      secondaryReverifyCauses?: readonly { cause: string }[];
    };
  };
  requirement: string;
  satisfied: boolean;
  suggestion?: string;
}): CoverageResolutionPreconditionDiagnostic {
  const currentCause =
    options.criterion.state === "covered"
      ? null
      : (options.criterion.explanation.secondaryReverifyCauses?.[0]?.cause ??
        options.criterion.state);
  return {
    code: options.satisfied
      ? "coverage_resolution_precondition_satisfied"
      : "coverage_resolution_precondition_failed",
    message: options.satisfied
      ? "Coverage resolution precondition is satisfied."
      : "Coverage resolution precondition is not satisfied.",
    current_presentation: options.criterion.presentation,
    current_state: options.criterion.state,
    current_cause: currentCause,
    missing_requirement: options.requirement,
    satisfied: options.satisfied,
    suggestion:
      options.suggestion ??
      (options.satisfied
        ? "Continue with the requested coverage resolution action."
        : "Refresh the coverage detail and choose an action that matches the current state."),
  };
}
