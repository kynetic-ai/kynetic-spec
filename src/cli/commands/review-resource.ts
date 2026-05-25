/**
 * Review resource CLI commands — `kspec review resource add|list|get|remove`.
 *
 * Each command translates the structured error codes from
 * `review-resource-manager` into the exact CLI JSON envelope and exit codes
 * required by the @folder-backed-review-storage-1 task contract:
 *
 *   - JSON failure envelope:
 *       { "error": <message>, "code": <code>, "message": <message>,
 *         "resource_id": string|null, "path": string|null, "source_file": string|null }
 *   - Exit codes follow @trait-semantic-exit-codes:
 *       0  success
 *       1  validation failures, missing review/resource, conflicts,
 *          source-file failures (any validation error)
 *       2  user cancellation
 *       3  storage incompatibility or unexpected runtime IO
 *
 * Spec: @folder-backed-review-storage-1
 *       @trait-entity-scoped-local-resources-1
 */

import * as readline from "node:readline";

import chalk from "chalk";
import type { Command } from "commander";

import {
  addReviewResource,
  EntityStorageCompatibilityError,
  getReviewResource,
  initContext,
  isDeterministicEntityStorageIncompatibility,
  listReviewResources,
  removeReviewResource,
  type ReviewResourceError,
} from "../../parser/index.js";
import type { ResourceMetadata } from "../../schema/resources.js";
import { commitIfShadow } from "../../parser/shadow.js";
import { markMutating } from "../command-annotations.js";
import { isJsonMode, output, success } from "../output.js";

const EXIT_SUCCESS = 0;
const EXIT_VALIDATION = 1;
const EXIT_CANCELLED = 2;
const EXIT_STORAGE = 3;

interface CliErrorEnvelope {
  error: string;
  code: string;
  message: string;
  resource_id: string | null;
  path: string | null;
  source_file: string | null;
}

function toEnvelope(error: ReviewResourceError): CliErrorEnvelope {
  return {
    error: error.message,
    code: error.code,
    message: error.message,
    resource_id: error.resource_id ?? null,
    path: error.path ?? null,
    source_file: error.source_file ?? null,
  };
}

/**
 * Emit a structured failure to stderr (JSON envelope in --json mode, a
 * chalk-coloured line otherwise) and exit with the CLI's contract code.
 *
 * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 */
function exitWithResourceError(
  error: ReviewResourceError,
  exitCode: number = EXIT_VALIDATION,
): never {
  const envelope = toEnvelope(error);
  if (isJsonMode()) {
    process.stderr.write(`${JSON.stringify(envelope)}\n`);
  } else {
    process.stderr.write(`${chalk.red("✗")} ${envelope.message}\n`);
  }
  process.exit(exitCode);
}

/**
 * Map any deterministic entity-storage incompatibility raised by the
 * manager (or its underlying gate) onto the documented
 * `entity_storage_incompatible` envelope and exit code 3. Non-matching
 * errors are re-thrown so the surrounding handler can decide.
 */
function exitOnStorageIncompatibility(err: unknown): void {
  if (!isDeterministicEntityStorageIncompatibility(err)) return;
  const source = err as EntityStorageCompatibilityError;
  const envelope: CliErrorEnvelope = {
    error: source.message,
    code: "entity_storage_incompatible",
    message: source.message,
    resource_id: null,
    path: null,
    source_file: null,
  };
  if (isJsonMode()) {
    process.stderr.write(`${JSON.stringify(envelope)}\n`);
  } else {
    process.stderr.write(`${chalk.red("✗")} ${envelope.message}\n`);
    if (source.suggestion) {
      process.stderr.write(`  ${chalk.yellow("Suggestion:")} ${source.suggestion}\n`);
    }
  }
  process.exit(EXIT_STORAGE);
}

/**
 * Catch-all for unexpected runtime errors that escape after validation. The
 * CLI contract treats these as exit code 3 alongside storage incompatibility
 * so callers can distinguish "your inputs are bad" (1) from "something broke
 * mid-operation" (3).
 */
function exitOnUnexpected(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const envelope: CliErrorEnvelope = {
    error: message,
    code: "entity_storage_incompatible",
    message,
    resource_id: null,
    path: null,
    source_file: null,
  };
  if (isJsonMode()) {
    process.stderr.write(`${JSON.stringify(envelope)}\n`);
  } else {
    process.stderr.write(`${chalk.red("✗")} ${message}\n`);
  }
  process.exit(EXIT_STORAGE);
}

/**
 * Format a single ResourceMetadata as a text line. Mirrors the columns
 * used by the plan-resource CLI so users see the same shape across both
 * entity types (id, path, content_type, bytes).
 */
function formatResourceLine(resource: ResourceMetadata): string {
  return `${resource.id}  ${resource.path}  ${resource.content_type}  ${resource.bytes} bytes`;
}

// ── register ────────────────────────────────────────────────────────────────

/**
 * Register `kspec review resource <subcommand>` under the existing `review`
 * command. Called from review.ts after the existing subcommands are wired.
 */
export function registerReviewResourceCommands(review: Command): void {
  const resource = review
    .command("resource")
    .description("Manage local resource files attached to a review");

  // --- add ---
  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  // AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
  markMutating(
    resource
      .command("add <review-ref> <source-file>")
      .description("Attach a local resource file to a review")
      .requiredOption("--id <resource-id>", "Stable resource identifier")
      .requiredOption("--path <relative-path>", "Relative POSIX path under the review's resources/")
      .option("--label <label>", "Optional human-readable label")
      .option("--description <text>", "Optional free-form description")
      .option(
        "--content-type <mime>",
        "Explicit MIME type; inferred from --path extension when omitted",
      )
      .option("--replace", "Replace an existing resource id (allows updating bytes and metadata)")
      .action(async (reviewRef: string, sourceFile: string, options) => {
        try {
          const ctx = await initContext();
          const result = await addReviewResource(ctx, reviewRef, {
            id: options.id,
            relativePath: options.path,
            sourceFile,
            contentType: options.contentType ?? null,
            label: options.label ?? null,
            description: options.description ?? null,
            replace: Boolean(options.replace),
          });
          if (!result.ok) {
            const exit =
              result.error.code === "review_not_found"
                ? EXIT_VALIDATION
                : result.error.code === "resource_conflict"
                  ? EXIT_VALIDATION
                  : EXIT_VALIDATION;
            exitWithResourceError(
              { ...result.error, source_file: result.error.source_file ?? sourceFile },
              exit,
            );
          }
          await commitIfShadow(
            ctx.shadow,
            "review-resource-add",
            result.value.review.slugs[0] || result.value.review._ulid.slice(0, 8),
            `${options.id} → ${options.path}`,
          );
          output({ resource: result.value.resource, replaced: result.value.replaced }, () => {
            success(
              `${result.value.replaced ? "Replaced" : "Added"} review resource ${options.id} (${options.path})`,
            );
          });
        } catch (err) {
          exitOnStorageIncompatibility(err);
          exitOnUnexpected(err);
        }
      }),
  );

  // --- list ---
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  resource
    .command("list <review-ref>")
    .description("List resources attached to a review")
    .action(async (reviewRef: string) => {
      try {
        const ctx = await initContext();
        const result = await listReviewResources(ctx, reviewRef);
        if (!result.ok) {
          exitWithResourceError(result.error);
        }
        output({ resources: result.value.resources }, () => {
          if (result.value.resources.length === 0) {
            console.log(chalk.gray("(no resources)"));
            return;
          }
          for (const r of result.value.resources) {
            console.log(formatResourceLine(r));
          }
        });
      } catch (err) {
        exitOnStorageIncompatibility(err);
        exitOnUnexpected(err);
      }
    });

  // --- get ---
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  resource
    .command("get <review-ref> <resource-id>")
    .description("Show metadata for one review resource")
    .action(async (reviewRef: string, resourceId: string) => {
      try {
        const ctx = await initContext();
        const result = await getReviewResource(ctx, reviewRef, resourceId);
        if (!result.ok) {
          exitWithResourceError(result.error);
        }
        output({ resource: result.value.resource }, () => {
          const r = result.value.resource;
          console.log(`id:           ${r.id}`);
          console.log(`path:         ${r.path}`);
          console.log(`label:        ${r.label ?? ""}`);
          console.log(`description:  ${r.description ?? ""}`);
          console.log(`content_type: ${r.content_type}`);
          console.log(`bytes:        ${r.bytes}`);
          console.log(`sha256:       ${r.sha256}`);
          console.log(`git_commit:   ${r.git_commit ?? ""}`);
          console.log(`git_path:     ${r.git_path ?? ""}`);
        });
      } catch (err) {
        exitOnStorageIncompatibility(err);
        exitOnUnexpected(err);
      }
    });

  // --- remove ---
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
  markMutating(
    resource
      .command("remove <review-ref> <resource-id>")
      .description("Remove a review resource (manifest entry + owned file)")
      .option("--force", "Skip the interactive confirmation prompt")
      .action(async (reviewRef: string, resourceId: string, options) => {
        try {
          const ctx = await initContext();
          // Confirm before we touch any state. Confirm rules per task contract:
          //   - --force: never prompt, never cancel.
          //   - non-interactive (no TTY, including --json): exit with
          //     confirmation_required + code 1 unless --force.
          //   - interactive: prompt and exit 2 (cancelled) on a "no" answer.
          if (!options.force) {
            const isTTY = process.env.KSPEC_TEST_TTY === "true" || process.stdin.isTTY;
            if (isJsonMode() || !isTTY) {
              const message = `Confirmation required to remove resource "${resourceId}" from review ${reviewRef}. Re-run with --force to proceed in non-interactive mode.`;
              if (isJsonMode()) {
                process.stderr.write(
                  `${JSON.stringify({
                    error: message,
                    code: "confirmation_required",
                    message,
                    resource_id: resourceId,
                    path: null,
                    source_file: null,
                  })}\n`,
                );
              } else {
                process.stderr.write(`${chalk.red("✗")} ${message}\n`);
              }
              process.exit(EXIT_VALIDATION);
            }
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            const answer = await new Promise<string>((resolve) => {
              rl.question(
                chalk.yellow(`Remove resource "${resourceId}" from review ${reviewRef}? [y/N] `),
                (response) => {
                  rl.close();
                  resolve(response);
                },
              );
            });
            if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
              const message = `Operation cancelled — resource "${resourceId}" was not removed.`;
              if (isJsonMode()) {
                process.stderr.write(
                  `${JSON.stringify({
                    error: message,
                    code: "operation_cancelled",
                    message,
                    resource_id: resourceId,
                    path: null,
                    source_file: null,
                  })}\n`,
                );
              } else {
                process.stderr.write(`${chalk.gray(message)}\n`);
              }
              process.exit(EXIT_CANCELLED);
            }
          }

          const result = await removeReviewResource(ctx, reviewRef, resourceId);
          if (!result.ok) {
            exitWithResourceError(result.error);
          }
          await commitIfShadow(
            ctx.shadow,
            "review-resource-remove",
            result.value.review.slugs[0] || result.value.review._ulid.slice(0, 8),
            `${result.value.removed.id} (${result.value.removed.path})`,
          );
          output({ removed: result.value.removed }, () => {
            success(
              `Removed review resource ${result.value.removed.id} (${result.value.removed.path})`,
            );
          });
        } catch (err) {
          exitOnStorageIncompatibility(err);
          exitOnUnexpected(err);
        }
      }),
  );

  // The default success exit is 0. Help text below is informational only;
  // commander reads --help from the description and option strings above.
  resource.addHelpText(
    "after",
    `
Exit codes:
  ${EXIT_SUCCESS}  success
  ${EXIT_VALIDATION}  validation failed, missing review/resource, conflict, or confirmation required
  ${EXIT_CANCELLED}  user cancelled an interactive prompt
  ${EXIT_STORAGE}  storage incompatibility or unexpected runtime error

Examples:
  $ kspec review resource add @review-1 ./screenshot.png --id login-bug --path screenshots/login.png
  $ kspec review resource list @review-1
  $ kspec review resource get @review-1 login-bug --json
  $ kspec review resource remove @review-1 login-bug --force`,
  );
}
