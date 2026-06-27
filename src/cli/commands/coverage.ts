import { readFile } from "node:fs/promises";
import chalk from "chalk";
import { Command } from "commander";
import { ZodError } from "zod";
import { markMutating } from "../command-annotations.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, output } from "../output.js";
import {
  applyDispatchFixRequest,
  applyExplicitReverification,
  applySpecTextRevert,
  CoverageResolutionActorError,
  CoverageResolutionReadOnlyError,
  CoverageResolutionSpecTextUnavailableError,
  CoverageResolutionStaleTargetError,
  CoverageResolutionTargetNotFoundError,
  initContext,
  ingestTestResultRun,
} from "../../parser/index.js";
import {
  TestResultIngestionReadOnlyError,
  TestResultIngestionValidationError,
  type TestResultIngestionSummary,
} from "../../parser/test-result-ingestion.js";
import {
  CoverageResolutionRequestSchema,
  type CoverageResolutionAction,
  type CoverageResolutionRequest,
  type CoverageResolutionResponse,
} from "../../schema/coverage-resolution.js";

const INGEST_RUNTIME_ERROR_EXIT_CODE = 3;
const COVERAGE_RESOLUTION_RUNTIME_ERROR_EXIT_CODE = 3;

interface IngestOptions {
  file?: string;
  dryRun?: boolean;
  actor?: string;
  session?: string;
}

interface CoverageResolveOptions {
  item: string;
  ac: string;
  dryRun?: boolean;
  actor?: string;
  session?: string;
  expectedFingerprint?: string;
  commit?: string;
  automationEligible?: boolean;
  allowDuplicate?: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function readPayload(pathArg: string | undefined, options: IngestOptions): Promise<unknown> {
  const source = options.file ?? pathArg;
  const raw = !source || source === "-" ? await readStdin() : await readFile(source, "utf-8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new TestResultIngestionValidationError("Invalid JSON test-result payload.", {
      details: [
        {
          field: "payload",
          message: err instanceof Error ? err.message : "Payload must be valid JSON.",
        },
      ],
      suggestion: "Provide a normalized test-result run JSON file or pipe JSON on stdin.",
      dryRun: options.dryRun === true,
    });
  }
}

function printHumanSummary(summary: TestResultIngestionSummary): void {
  const mode = summary.dry_run ? "Previewed" : "Ingested";
  console.log(`${chalk.green("OK")} ${mode} test-result run @${summary.run_id}`);
  console.log(`Cases: ${summary.case_count}`);
  console.log(`Mapped criteria: ${summary.mapped_criterion_count}`);
  console.log(`Unmapped cases: ${summary.unmapped_count}`);
  console.log(`Invalid mappings: ${summary.invalid_mapping_count}`);
  console.log(`Verification stamps written: ${summary.stamps_written_count}`);
  console.log(`Non-positive mapped cases: ${summary.non_positive_mapped_case_count}`);
  console.log(`Actor: ${summary.actor}`);
  console.log(
    `Affected items: ${
      summary.affected_item_refs.length > 0 ? summary.affected_item_refs.join(", ") : "none"
    }`,
  );
  if (summary.dry_run) {
    console.log(chalk.yellow("Dry run: no files, commits, cache updates, or events were written."));
  }
}

function printIngestionError(err: unknown): never {
  if (err instanceof TestResultIngestionReadOnlyError) {
    error("Cannot ingest test-result run in read-only/static mode.", {
      message: err.message,
      suggestion: err.suggestion,
      code: err.code,
    });
    process.exit(INGEST_RUNTIME_ERROR_EXIT_CODE);
  }

  if (err instanceof TestResultIngestionValidationError) {
    error("Invalid test-result ingestion input.", {
      message: err.message,
      details: err.details,
      suggestion: err.suggestion,
      code: err.code,
      run_id: err.runId,
      dry_run: err.dryRun,
    });
    process.exit(EXIT_CODES.ERROR);
  }

  error("Failed to ingest test-result run.", {
    message: err instanceof Error ? err.message : String(err),
    suggestion: "Check that the input file is readable and the project is writable.",
  });
  process.exit(INGEST_RUNTIME_ERROR_EXIT_CODE);
}

function coverageResolutionRequest(
  action: CoverageResolutionAction,
  options: CoverageResolveOptions,
): CoverageResolutionRequest {
  return CoverageResolutionRequestSchema.parse({
    action,
    target: {
      item_ref: options.item,
      ac_id: options.ac,
    },
    dry_run: options.dryRun === true,
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.session ? { session_id: options.session } : {}),
    ...(options.expectedFingerprint
      ? { expected_current_fingerprint: options.expectedFingerprint }
      : {}),
    ...(options.commit ? { commit: { commit: options.commit } } : {}),
    ...(action === "dispatch-fix"
      ? {
          automation_eligible: options.automationEligible === true,
          allow_duplicate: options.allowDuplicate === true,
        }
      : {}),
  });
}

function hasFailedPrecondition(response: CoverageResolutionResponse): boolean {
  return response.diagnostics.some((diagnostic) => !diagnostic.satisfied);
}

function formatEffect(effect: CoverageResolutionResponse["effects"][number]): string {
  switch (effect.kind) {
    case "verification_stamp":
      return `${effect.operation} for ${effect.item_ulid} ${effect.ac_id}`;
    case "spec_text":
      return `${effect.operation} ${effect.fields.join(", ")} (${effect.summary})`;
    case "task":
      return `${effect.operation} ${effect.task_ref ?? effect.title ?? "task"}`;
    case "cache_event":
      return `${effect.operation} for ${effect.scopes.map((scope) => scope.type).join(", ")}`;
  }
}

function printCoverageResolutionSummary(response: CoverageResolutionResponse): void {
  const label = response.dry_run
    ? chalk.yellow("PREVIEW")
    : response.stored
      ? chalk.green("OK")
      : chalk.red("REJECTED");
  console.log(
    `${label} ${response.action} for ${response.target.item_ref} ${response.target.ac_id}`,
  );
  console.log(
    `State: ${response.current.presentation} (${response.current.state}, rule ${response.current.rule})`,
  );
  console.log(`Stored: ${response.stored ? "yes" : "no"}`);
  console.log(`Fingerprint: ${response.target.current_fingerprint}`);
  if (response.effects.length > 0) {
    console.log("Effects:");
    for (const effect of response.effects) {
      console.log(`- ${formatEffect(effect)}`);
    }
  }
  if (response.affected_scopes.length > 0) {
    console.log(
      `Affected scopes: ${response.affected_scopes
        .map((scope) =>
          scope.type === "criterion"
            ? `${scope.item_ulid} ${scope.ac_id}`
            : scope.type === "item"
              ? scope.item_ulid
              : scope.ref,
        )
        .join(", ")}`,
    );
  }
  for (const diagnostic of response.diagnostics) {
    const prefix = diagnostic.satisfied ? chalk.green("satisfied") : chalk.red("failed");
    console.log(`Precondition ${prefix}: ${diagnostic.missing_requirement}`);
    console.log(`  ${diagnostic.message}`);
    console.log(chalk.yellow("  Suggestion:"), diagnostic.suggestion);
  }
  if (response.dry_run) {
    console.log(chalk.yellow("Dry run: no files, commits, cache updates, or events were written."));
  }
}

function zodDetails(err: ZodError): Array<{ field: string; message: string }> {
  return err.issues.map((issue) => ({
    field: issue.path.join(".") || "request",
    message: issue.message,
  }));
}

function printCoverageResolutionError(err: unknown): never {
  if (err instanceof CoverageResolutionReadOnlyError) {
    error("Cannot apply coverage resolution in read-only/static mode.", {
      message: err.message,
      suggestion: err.suggestion,
      code: err.code,
    });
    process.exit(COVERAGE_RESOLUTION_RUNTIME_ERROR_EXIT_CODE);
  }

  if (err instanceof ZodError) {
    error("Invalid coverage resolution input.", {
      message: "Coverage resolution request failed validation.",
      details: zodDetails(err),
      suggestion: "Check --item, --ac, and action-specific flags before retrying.",
      code: "coverage_resolution_validation_error",
    });
    process.exit(EXIT_CODES.ERROR);
  }

  if (err instanceof CoverageResolutionTargetNotFoundError) {
    error("Coverage resolution target was not found.", {
      message: err.message,
      suggestion: err.suggestion,
      code: err.code,
      target: err.target,
    });
    process.exit(EXIT_CODES.ERROR);
  }

  if (err instanceof CoverageResolutionStaleTargetError) {
    error("Coverage resolution target changed.", {
      message: err.message,
      suggestion: err.suggestion,
      code: err.code,
      expected_current_fingerprint: err.expectedFingerprint,
      current_fingerprint: err.currentFingerprint,
    });
    process.exit(EXIT_CODES.ERROR);
  }

  if (err instanceof CoverageResolutionSpecTextUnavailableError) {
    error("Spec-text revert is unavailable for the current target.", {
      message: err.message,
      suggestion: err.suggestion,
      code: err.code,
    });
    process.exit(EXIT_CODES.ERROR);
  }

  if (err instanceof CoverageResolutionActorError) {
    error("Invalid coverage resolution actor.", {
      message: err.message,
      details: [{ field: err.details.field, message: err.details.message }],
      suggestion: err.suggestion,
      code: err.code,
    });
    process.exit(EXIT_CODES.ERROR);
  }

  error("Failed to apply coverage resolution.", {
    message: err instanceof Error ? err.message : String(err),
    suggestion: "Refresh coverage state and retry the requested resolution action.",
  });
  process.exit(COVERAGE_RESOLUTION_RUNTIME_ERROR_EXIT_CODE);
}

async function runCoverageResolution(
  action: CoverageResolutionAction,
  options: CoverageResolveOptions,
): Promise<void> {
  try {
    const request = coverageResolutionRequest(action, options);
    const ctx = await initContext();
    const readOnly = process.env.KSPEC_STATIC_MODE === "1" || process.env.KSPEC_READ_ONLY === "1";
    const response =
      request.action === "explicit-reverify"
        ? await applyExplicitReverification(ctx, request, { readOnly })
        : request.action === "spec-text-revert"
          ? await applySpecTextRevert(ctx, { request, readOnly })
          : await applyDispatchFixRequest(ctx, request, { readOnly });

    output(response, () => printCoverageResolutionSummary(response));
    if (hasFailedPrecondition(response)) {
      process.exit(EXIT_CODES.ERROR);
    }
  } catch (err) {
    printCoverageResolutionError(err);
  }
}

function addCoverageResolutionCommonOptions(command: Command): Command {
  return command
    .requiredOption("--item <ref>", "Item ref for the coverage criterion")
    .requiredOption("--ac <id>", "Acceptance criterion id")
    .option("--dry-run", "Validate and preview the resolution without writing")
    .option("--actor <actor>", "Actor to attribute the resolution to")
    .option("--session <ulid>", "Optional kspec session ULID to attach");
}

export function registerCoverageCommands(program: Command): void {
  const coverage = program.command("coverage").description("Coverage and evidence commands");
  const resolve = coverage
    .command("resolve")
    .description(
      "Resolve coverage-state issues with explicit reverify, spec-text revert, or dispatch-fix actions",
    );

  markMutating(
    addCoverageResolutionCommonOptions(
      resolve.command("reverify").description("Explicitly re-verify a stale covered criterion"),
    ).option("--commit <sha>", "Optional comparable code commit for the verification stamp"),
  ).action((options: CoverageResolveOptions) =>
    runCoverageResolution("explicit-reverify", options),
  );

  markMutating(
    addCoverageResolutionCommonOptions(
      resolve
        .command("revert-spec-text")
        .description("Apply the prior acceptance criterion text for a stale spec-text cause"),
    ).option(
      "--expected-fingerprint <sha256>",
      "Expected current criterion text fingerprint from a preview",
    ),
  ).action((options: CoverageResolveOptions) => runCoverageResolution("spec-text-revert", options));

  markMutating(
    addCoverageResolutionCommonOptions(
      resolve
        .command("dispatch-fix")
        .description("Create or reuse ordinary task work for a coverage issue"),
    )
      .option("--automation-eligible", "Mark newly created dispatch-fix task automation eligible")
      .option("--allow-duplicate", "Create a new task even when an open matching fix task exists"),
  ).action((options: CoverageResolveOptions) => runCoverageResolution("dispatch-fix", options));

  const testResult = coverage
    .command("test-result")
    .description("Completed normalized test-result commands");

  markMutating(testResult.command("ingest [file]"))
    .description("Ingest a completed normalized test-result run from a JSON file or stdin")
    .option("--file <path>", "Read normalized JSON payload from file")
    .option("--dry-run", "Validate and preview ingestion without writing")
    .option("--actor <actor>", "Actor to attribute the ingestion to")
    .option("--session <ulid>", "Optional kspec session ULID to attach to the run")
    .action(async (file: string | undefined, options: IngestOptions) => {
      try {
        const payload = await readPayload(file, options);
        const ctx = await initContext();
        const result = await ingestTestResultRun(ctx, payload, {
          actor: options.actor,
          sessionId: options.session,
          dryRun: options.dryRun === true,
          readOnly: process.env.KSPEC_STATIC_MODE === "1" || process.env.KSPEC_READ_ONLY === "1",
        });

        output(result.summary, () => printHumanSummary(result.summary));
      } catch (err) {
        printIngestionError(err);
      }
    });
}
