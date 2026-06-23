import { z } from "zod";
import { AcIdSchema, DateTimeSchema, RefSchema, UlidSchema } from "./common.js";

/**
 * Normalized completed-test-run schema.
 *
 * Producers translate framework-native output into this kspec-owned envelope
 * before the core store sees it. Native producer metadata may be retained only
 * under the explicitly namespaced `producer.native` extension object.
 *
 * Spec: @test-result-run-store
 *       @normalized-test-result-ingestion-contract
 */

/** Maximum test-result run record format understood by this build. */
export const CURRENT_TEST_RESULT_RUN_RECORD_FORMAT = 1;

export const TestResultProducerKindSchema = z.enum(["local", "ci", "agent", "other"]);

export const TestResultCaseStatusSchema = z.enum([
  "passed",
  "failed",
  "errored",
  "skipped",
  "unknown",
]);

const ExtensionObjectSchema = z.record(z.string(), z.unknown());

const TestResultProducerShape = {
  kind: TestResultProducerKindSchema,
  label: z.string().min(1, "producer label is required"),
  command: z.string().min(1).nullable().optional(),
  ci_url: z.string().url().nullable().optional(),
  agent_session: UlidSchema.nullable().optional(),
  code_revision: z.string().min(1).nullable().optional(),
  native: ExtensionObjectSchema.optional(),
};

export const TestResultProducerSchema = z.object(TestResultProducerShape).passthrough();

export const TestResultProducerInputSchema = z.object(TestResultProducerShape).strict();

export const NormalizedTestRunMetadataSchema = z
  .object({
    id: UlidSchema,
    completed_at: DateTimeSchema,
    started_at: DateTimeSchema.nullable().optional(),
    duration_ms: z.number().nonnegative().nullable().optional(),
  })
  .passthrough();

export const TestResultCaseLocationSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive().optional(),
  })
  .passthrough();

export const TestResultCriterionRefSchema = z
  .object({
    item_ref: RefSchema,
    ac_id: AcIdSchema,
  })
  .passthrough();

export const NormalizedTestCaseSchema = z
  .object({
    id: z.string().min(1, "case stable id is required"),
    display_name: z.string().min(1, "case display name is required"),
    suite_path: z.array(z.string().min(1)).nullable().optional(),
    status: TestResultCaseStatusSchema,
    duration_ms: z.number().nonnegative().nullable().optional(),
    location: TestResultCaseLocationSchema.nullable().optional(),
    diagnostic: z.string().nullable().optional(),
    refs: z.array(TestResultCriterionRefSchema).default([]),
  })
  .passthrough();

export const TestResultAttributedMappingSchema = z
  .object({
    case_id: z.string().min(1),
    item_ulid: UlidSchema,
    item_ref: RefSchema,
    ac_id: AcIdSchema,
    status: TestResultCaseStatusSchema,
  })
  .passthrough();

export const TestResultUnmappedCaseSchema = z
  .object({
    case_id: z.string().min(1),
    reason: z.string().min(1),
    display_name: z.string().min(1).optional(),
  })
  .passthrough();

export const TestResultInvalidMappingSchema = z
  .object({
    case_id: z.string().min(1),
    item_ref: z.string().min(1).optional(),
    ac_id: z.string().min(1).optional(),
    reason: z.string().min(1),
    display_name: z.string().min(1).optional(),
  })
  .passthrough();

export const TestResultMappingSummarySchema = z
  .object({
    attributed: z.array(TestResultAttributedMappingSchema).default([]),
    unmapped: z.array(TestResultUnmappedCaseSchema).default([]),
    invalid: z.array(TestResultInvalidMappingSchema).default([]),
  })
  .passthrough();

export const TestResultVerificationStampEffectSchema = z
  .object({
    case_id: z.string().min(1),
    item_ulid: UlidSchema,
    ac_id: AcIdSchema,
    verified_at: DateTimeSchema,
  })
  .passthrough();

export const TestResultNonPositiveMappedCaseSchema = z
  .object({
    case_id: z.string().min(1),
    item_ulid: UlidSchema.optional(),
    item_ref: RefSchema.optional(),
    ac_id: AcIdSchema.optional(),
    status: TestResultCaseStatusSchema,
  })
  .passthrough();

export const TestResultVerificationEffectsSchema = z
  .object({
    stamps_written: z.array(TestResultVerificationStampEffectSchema).default([]),
    non_positive_mapped_cases: z.array(TestResultNonPositiveMappedCaseSchema).default([]),
  })
  .passthrough();

export const TestResultRunRecordSchema = z
  .object({
    format: z.number().int().positive().default(CURRENT_TEST_RESULT_RUN_RECORD_FORMAT),
    run: NormalizedTestRunMetadataSchema,
    producer: TestResultProducerSchema,
    cases: z.array(NormalizedTestCaseSchema).min(1, "at least one test case is required"),
    mapping: TestResultMappingSummarySchema.default({
      attributed: [],
      unmapped: [],
      invalid: [],
    }),
    verification_effects: TestResultVerificationEffectsSchema.default({
      stamps_written: [],
      non_positive_mapped_cases: [],
    }),
  })
  .passthrough();

export const TestResultRunRecordInputSchema = z
  .object({
    format: z.number().int().positive().default(CURRENT_TEST_RESULT_RUN_RECORD_FORMAT),
    run: NormalizedTestRunMetadataSchema,
    producer: TestResultProducerInputSchema,
    cases: z.array(NormalizedTestCaseSchema).min(1, "at least one test case is required"),
    mapping: TestResultMappingSummarySchema.default({
      attributed: [],
      unmapped: [],
      invalid: [],
    }),
    verification_effects: TestResultVerificationEffectsSchema.default({
      stamps_written: [],
      non_positive_mapped_cases: [],
    }),
  })
  .passthrough();

export const TestRunIndexProducerSchema = z
  .object({
    kind: TestResultProducerKindSchema,
    label: z.string().min(1),
  })
  .passthrough();

export const TestRunIndexTotalsSchema = z
  .object({
    cases: z.number().int().nonnegative(),
    mapped: z.number().int().nonnegative(),
    unmapped: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    stamps_written: z.number().int().nonnegative(),
  })
  .passthrough();

export const TestRunIndexEntrySchema = z
  .object({
    path: z.string().min(1),
    completed_at: DateTimeSchema,
    producer: TestRunIndexProducerSchema,
    code_revision: z.string().min(1).nullable().optional(),
    totals: TestRunIndexTotalsSchema,
  })
  .passthrough();

export const TestRunIndexSchema = z
  .object({
    format: z.number().int().positive().default(CURRENT_TEST_RESULT_RUN_RECORD_FORMAT),
    runs: z.record(UlidSchema, TestRunIndexEntrySchema).default({}),
    latest_run_id: UlidSchema.optional(),
  })
  .passthrough();

export type TestResultProducerKind = z.infer<typeof TestResultProducerKindSchema>;
export type TestResultCaseStatus = z.infer<typeof TestResultCaseStatusSchema>;
export type TestResultProducer = z.infer<typeof TestResultProducerSchema>;
export type TestResultProducerInput = z.input<typeof TestResultProducerInputSchema>;
export type NormalizedTestRunMetadata = z.infer<typeof NormalizedTestRunMetadataSchema>;
export type NormalizedTestCase = z.infer<typeof NormalizedTestCaseSchema>;
export type TestResultCriterionRef = z.infer<typeof TestResultCriterionRefSchema>;
export type TestResultMappingSummary = z.infer<typeof TestResultMappingSummarySchema>;
export type TestResultVerificationEffects = z.infer<typeof TestResultVerificationEffectsSchema>;
export type TestResultRunRecord = z.infer<typeof TestResultRunRecordSchema>;
export type TestResultRunRecordInput = z.input<typeof TestResultRunRecordInputSchema>;
export type TestRunIndexEntry = z.infer<typeof TestRunIndexEntrySchema>;
export type TestRunIndex = z.infer<typeof TestRunIndexSchema>;
