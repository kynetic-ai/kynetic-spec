import { ZodError } from "zod";
import { UlidSchema } from "../schema/common.js";
import type {
  TestResultMappingSummary,
  TestResultRunRecord,
  TestResultRunRecordInput,
} from "../schema/test-result-runs.js";
import { TestResultRunRecordInputSchema } from "../schema/test-result-runs.js";
import type { ActorWriteValidationError } from "../identity/actor-write.js";
import { resolveActorForContext } from "../identity/actor-write-context.js";
import type { MutationEventDescriptor } from "../mutation-pipeline.js";
import type { KspecContext } from "./yaml.js";
import { normalizeTestRunForWrite, writePreparedTestRun } from "./test-result-run-store.js";

export const TEST_RESULT_INGESTION_READ_ONLY_CODE = "test_result_ingestion_read_only";
export const TEST_RESULT_INGESTION_VALIDATION_CODE = "test_result_ingestion_validation_error";

export class TestResultIngestionReadOnlyError extends Error {
  readonly code = TEST_RESULT_INGESTION_READ_ONLY_CODE;
  readonly suggestion =
    "Use a live writable kspec project or daemon-backed workspace to ingest test results.";

  constructor() {
    super("Test-result ingestion is unavailable in read-only/static export mode.");
    this.name = "TestResultIngestionReadOnlyError";
  }
}

export class TestResultIngestionValidationError extends Error {
  readonly code = TEST_RESULT_INGESTION_VALIDATION_CODE;
  readonly details: Array<{ field: string; message: string }>;
  readonly suggestion: string;
  readonly runId?: string;
  readonly dryRun: boolean;

  constructor(
    message: string,
    options: {
      details: Array<{ field: string; message: string }>;
      suggestion: string;
      runId?: string;
      dryRun?: boolean;
    },
  ) {
    super(message);
    this.name = "TestResultIngestionValidationError";
    this.details = options.details;
    this.suggestion = options.suggestion;
    this.runId = options.runId;
    this.dryRun = options.dryRun === true;
  }
}

export interface TestResultIngestionOptions {
  actor?: string | null;
  sessionId?: string | null;
  dryRun?: boolean;
  readOnly?: boolean;
  skipCommit?: boolean;
}

export interface TestResultIngestionEventScope {
  type: "item" | "project";
  ref: string;
  reason: "mapped_criteria" | "unmapped_results" | "invalid_mappings";
}

export interface TestResultIngestionSummary {
  run_id: string;
  dry_run: boolean;
  actor: string;
  producer: TestResultRunRecord["producer"];
  case_count: number;
  mapped_criterion_count: number;
  unmapped_count: number;
  invalid_mapping_count: number;
  affected_item_refs: string[];
  event_scopes: TestResultIngestionEventScope[];
  mapping: TestResultMappingSummary;
  stored: boolean;
}

export interface TestResultIngestionResult {
  run: TestResultRunRecord;
  summary: TestResultIngestionSummary;
  events: MutationEventDescriptor[];
}

function validationDetailsFromZod(error: ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : "payload",
    message: issue.message,
  }));
}

function validationDetailsFromActor(
  error: ActorWriteValidationError,
): Array<{ field: string; message: string }> {
  return [{ field: error.field, message: error.message }];
}

function extractRunId(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const run = (input as Record<string, unknown>).run;
  if (!run || typeof run !== "object") return undefined;
  const id = (run as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

function throwValidationError(
  message: string,
  options: {
    details: Array<{ field: string; message: string }>;
    runId?: string;
    dryRun?: boolean;
  },
): never {
  throw new TestResultIngestionValidationError(message, {
    ...options,
    suggestion:
      "Submit a normalized kspec test-result run payload with required run, producer, and cases fields.",
  });
}

function resolveSessionId(inputSessionId: string | null | undefined): string | null | undefined {
  const candidate = inputSessionId;
  if (candidate === undefined || candidate === null || candidate.trim() === "") {
    return undefined;
  }
  const parsed = UlidSchema.safeParse(candidate);
  if (!parsed.success) {
    throwValidationError("Invalid test-result ingestion session id.", {
      details: [{ field: "session_id", message: "Session id must be a valid ULID." }],
      runId: undefined,
    });
  }
  return parsed.data;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted();
}

export function buildTestResultIngestionEventScopes(
  mapping: TestResultMappingSummary,
): TestResultIngestionEventScope[] {
  const scopes: TestResultIngestionEventScope[] = uniqueSorted(
    mapping.attributed.map((entry) => entry.item_ref),
  ).map((ref) => ({ type: "item", ref, reason: "mapped_criteria" }));

  if (mapping.unmapped.length > 0) {
    scopes.push({ type: "project", ref: "@project", reason: "unmapped_results" });
  }
  if (mapping.invalid.length > 0) {
    scopes.push({ type: "project", ref: "@project", reason: "invalid_mappings" });
  }
  return scopes;
}

export function summarizeTestResultIngestion(
  run: TestResultRunRecord,
  options: { dryRun: boolean; stored: boolean; actor: string },
): TestResultIngestionSummary {
  const affectedItemRefs = uniqueSorted(run.mapping.attributed.map((entry) => entry.item_ref));
  return {
    run_id: run.run.id,
    dry_run: options.dryRun,
    actor: options.actor,
    producer: run.producer,
    case_count: run.cases.length,
    mapped_criterion_count: run.mapping.attributed.length,
    unmapped_count: run.mapping.unmapped.length,
    invalid_mapping_count: run.mapping.invalid.length,
    affected_item_refs: affectedItemRefs,
    event_scopes: buildTestResultIngestionEventScopes(run.mapping),
    mapping: run.mapping,
    stored: options.stored,
  };
}

export function buildTestResultIngestionEvents(
  summary: TestResultIngestionSummary,
): MutationEventDescriptor[] {
  if (summary.dry_run) return [];
  return [
    {
      topic: "items:updates",
      event: "coverage_evidence_changed",
      data: {
        action: "changed",
        family: "coverage_evidence",
        run_id: summary.run_id,
        affected_item_refs: summary.affected_item_refs,
        event_scopes: summary.event_scopes,
        case_count: summary.case_count,
        mapped_criterion_count: summary.mapped_criterion_count,
        unmapped_count: summary.unmapped_count,
        invalid_mapping_count: summary.invalid_mapping_count,
      },
    },
  ];
}

export async function ingestTestResultRun(
  ctx: KspecContext,
  input: unknown,
  options: TestResultIngestionOptions = {},
): Promise<TestResultIngestionResult> {
  const dryRun = options.dryRun === true;
  if (options.readOnly === true) {
    throw new TestResultIngestionReadOnlyError();
  }

  const parsedInput = TestResultRunRecordInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throwValidationError("Invalid normalized test-result run payload.", {
      details: validationDetailsFromZod(parsedInput.error),
      runId: extractRunId(input),
      dryRun,
    });
  }

  const actorResult = await resolveActorForContext(ctx, {
    explicit: options.actor,
    field: "actor",
  });
  if (!actorResult.ok) {
    throwValidationError("Invalid test-result ingestion actor.", {
      details: validationDetailsFromActor(actorResult.error),
      runId: extractRunId(input),
      dryRun,
    });
  }

  let sessionId: string | null | undefined;
  try {
    sessionId = resolveSessionId(options.sessionId);
  } catch (err) {
    if (err instanceof TestResultIngestionValidationError) {
      throw new TestResultIngestionValidationError(err.message, {
        details: err.details,
        suggestion: err.suggestion,
        runId: extractRunId(input),
        dryRun,
      });
    }
    throw err;
  }

  const nextInput: TestResultRunRecordInput = {
    ...parsedInput.data,
    producer: {
      ...parsedInput.data.producer,
      actor: actorResult.actor,
      ...(sessionId !== undefined ? { agent_session: sessionId } : {}),
    },
  };

  let normalized: TestResultRunRecord;
  try {
    normalized = await normalizeTestRunForWrite(ctx, nextInput);
  } catch (err) {
    if (err instanceof ZodError) {
      throwValidationError("Invalid normalized test-result run payload.", {
        details: validationDetailsFromZod(err),
        runId: extractRunId(input),
        dryRun,
      });
    }
    throw err;
  }

  const run = dryRun
    ? normalized
    : await writePreparedTestRun(ctx, normalized, { skipCommit: options.skipCommit });
  const summary = summarizeTestResultIngestion(run, {
    dryRun,
    stored: !dryRun,
    actor: actorResult.actor,
  });

  return {
    run,
    summary,
    events: buildTestResultIngestionEvents(summary),
  };
}
