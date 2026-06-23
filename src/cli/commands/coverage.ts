import { readFile } from "node:fs/promises";
import chalk from "chalk";
import { Command } from "commander";
import { markMutating } from "../command-annotations.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, output } from "../output.js";
import { initContext, ingestTestResultRun } from "../../parser/index.js";
import {
  TestResultIngestionReadOnlyError,
  TestResultIngestionValidationError,
  type TestResultIngestionSummary,
} from "../../parser/test-result-ingestion.js";

const INGEST_RUNTIME_ERROR_EXIT_CODE = 3;

interface IngestOptions {
  file?: string;
  dryRun?: boolean;
  actor?: string;
  session?: string;
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

export function registerCoverageCommands(program: Command): void {
  const coverage = program.command("coverage").description("Coverage and evidence commands");
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
