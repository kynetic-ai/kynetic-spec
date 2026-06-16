import { z } from "zod";
import { AcIdSchema, DateTimeSchema } from "./common.js";

/**
 * Per-acceptance-criterion verification record schema.
 *
 * A verification stamp records that a criterion's test mapping was confirmed:
 * when the verification happened, which actor performed it, and which
 * provenance class produced it. Stamps live in an operational sidecar within
 * the project's shadow-branch metadata, keyed by the owning item's canonical
 * ULID and the criterion id — spec source files never carry verification
 * state.
 *
 * Spec: @ac-verification-record-store
 */

/**
 * The maximum record-format version this build of the tool understands.
 * Stamp writes persist this version; newer-format gating (refusing to read
 * or write records that declare a greater version) is wired by
 * @coverage-record-compatibility. The constant lands here so the format
 * field has a single source of truth.
 */
export const CURRENT_VERIFICATION_RECORD_FORMAT = 1;

/**
 * Provenance classes a recorded verification stamp can carry.
 *
 * - validation     — confirmed by a validation pass
 * - ingestion      — confirmed by an ingested test run
 * - re_verification — confirmed by an explicit re-verification
 *
 * AC: @ac-verification-record-store ac-stamp-read-back
 */
export const VerificationProvenanceSchema = z.enum(["validation", "ingestion", "re_verification"]);

/**
 * A single verification stamp — the current verification state for one
 * acceptance criterion.
 *
 * `verified_at`, `actor`, and `provenance` are required: a write missing any
 * of them is rejected by schema validation, leaving stored state unchanged.
 * `commit` and `session` are optional. The session reference's full
 * validation, read exposure, and tolerant resolution semantics ship in
 * @verification-session-evidence; the field shape lands here so the schema
 * is defined once.
 *
 * AC: @ac-verification-record-store ac-stamp-read-back
 * AC: @ac-verification-record-store ac-incomplete-stamp-rejected
 */
export const VerificationStampSchema = z.object({
  verified_at: DateTimeSchema,
  actor: z.string().min(1, "actor is required"),
  provenance: VerificationProvenanceSchema,
  commit: z.string().min(1).optional(),
  session: z.string().min(1).optional(),
});

/**
 * A verification record — one per spec item, keyed on disk by the owning
 * item's ULID. Holds the map of acceptance-criterion id → current stamp.
 *
 * The live record keeps exactly one current stamp per criterion; superseded
 * stamps are recoverable through the shadow-branch commit history rather than
 * from the live record.
 *
 * AC: @ac-verification-record-store ac-keyed-by-canonical-identity
 * AC: @ac-verification-record-store ac-current-stamp-replacement
 * AC: @ac-verification-record-store ac-versioned-persistence
 */
export const VerificationRecordSchema = z.object({
  format: z.number().int().positive(),
  acs: z.record(AcIdSchema, VerificationStampSchema),
});

/** Input shape for writing a stamp — `verified_at`/`actor`/`provenance` required. */
export const VerificationStampInputSchema = VerificationStampSchema;

export type VerificationProvenance = z.infer<typeof VerificationProvenanceSchema>;
export type VerificationStamp = z.infer<typeof VerificationStampSchema>;
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;
export type VerificationStampInput = z.input<typeof VerificationStampInputSchema>;
