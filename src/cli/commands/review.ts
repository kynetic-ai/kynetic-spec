/**
 * Review CLI commands — creation and query
 *
 * AC: @review-cli-creation-and-query ac-1, ac-2, ac-3, ac-4, ac-5
 */

import type { Command } from "commander";
import chalk from "chalk";
import { markMutating } from "../command-annotations.js";
import {
  buildIndexes,
  createReviewRecord,
  findReviewByRef,
  getAuthor,
  initContext,
  loadReviewRecords,
  saveReviewRecord,
  type LoadedReviewRecord,
} from "../../parser/index.js";
import { checkSlugUniqueness } from "../../parser/refs.js";
import { commitIfShadow } from "../../parser/shadow.js";
import type {
  ReviewRecord,
  ReviewRecordInput,
  ReviewSubject,
  ReviewLifecycleState,
} from "../../schema/index.js";
import { errors } from "../../strings/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, output, success } from "../output.js";

// --- Formatting helpers ---

/**
 * Color a lifecycle state for display.
 */
function lifecycleColor(state: string): (text: string) => string {
  switch (state) {
    case "draft":
      return (t: string) => chalk.gray(t);
    case "open":
      return (t: string) => chalk.blue(t);
    case "closed":
      return (t: string) => chalk.green(t);
    case "archived":
      return (t: string) => chalk.dim.gray(t);
    default:
      return (t: string) => chalk.white(t);
  }
}

/**
 * Color a disposition for display.
 */
function dispositionColor(disposition: string): (text: string) => string {
  switch (disposition) {
    case "approved":
      return (t: string) => chalk.green(t);
    case "changes_requested":
      return (t: string) => chalk.red(t);
    case "pending":
      return (t: string) => chalk.yellow(t);
    default:
      return (t: string) => chalk.white(t);
  }
}

/**
 * Compute the disposition from verdicts.
 * If any verdict is request_changes, disposition is changes_requested.
 * If any verdict is approve and none request_changes, disposition is approved.
 * Otherwise pending.
 */
function computeDisposition(review: ReviewRecord): string {
  if (review.verdicts.length === 0) return "pending";
  const hasChangesRequested = review.verdicts.some(
    (v) => v.decision === "request_changes",
  );
  if (hasChangesRequested) return "changes_requested";
  const hasApproval = review.verdicts.some((v) => v.decision === "approve");
  if (hasApproval) return "approved";
  return "pending";
}

/**
 * Compute the gate state from checks.
 * If no checks, pending. If any required check is fail, failing.
 * If any required check is running/pending, pending.
 * Otherwise passing.
 */
function computeGateState(review: ReviewRecord): string {
  if (review.checks.length === 0) return "pending";
  const requiredChecks = review.checks.filter((c) => c.required);
  if (requiredChecks.length === 0) return "passing";
  const hasFailing = requiredChecks.some((c) => c.status === "fail");
  if (hasFailing) return "failing";
  const hasPending = requiredChecks.some(
    (c) => c.status === "running" || c.status === "skipped",
  );
  if (hasPending) return "pending";
  return "passing";
}

/**
 * Color a gate state for display.
 */
function gateColor(state: string): (text: string) => string {
  switch (state) {
    case "passing":
      return (t: string) => chalk.green(t);
    case "failing":
      return (t: string) => chalk.red(t);
    case "pending":
      return (t: string) => chalk.yellow(t);
    default:
      return (t: string) => chalk.white(t);
  }
}

/**
 * Format a subject binding for display.
 */
function formatSubject(subject: ReviewSubject): string {
  switch (subject.type) {
    case "code":
      return `code (${subject.base_commit.slice(0, 8)}..${subject.head_commit.slice(0, 8)})`;
    case "plan":
    case "task":
    case "spec":
      return `${subject.type} (@${subject.ref})`;
    case "external":
      return `external (${subject.url})`;
    default:
      return "unknown";
  }
}

/**
 * Format a review record for JSON output.
 * AC: @trait-json-output ac-2 — includes all data available in human-readable mode
 * AC: @trait-json-output ac-4 — references use @ prefix consistently
 * AC: @trait-json-output ac-5 — timestamps use ISO 8601 format
 */
function toJsonOutput(review: ReviewRecord): Record<string, unknown> {
  return {
    _ulid: review._ulid,
    slugs: review.slugs,
    title: review.title,
    lifecycle_state: review.lifecycle_state,
    disposition: computeDisposition(review),
    gate_state: computeGateState(review),
    subject: review.subject,
    author: review.author,
    related_refs: review.related_refs.map((r) =>
      r.startsWith("@") ? r : `@${r}`,
    ),
    threads: review.threads,
    checks: review.checks,
    verdicts: review.verdicts,
    events: review.events,
    notes: review.notes,
    external_links: review.external_links,
    created_at: review.created_at,
    updated_at: review.updated_at ?? null,
  };
}

/**
 * Format review details for human-readable output.
 * AC: @review-cli-creation-and-query ac-3
 */
function formatReviewDetails(review: ReviewRecord): void {
  console.log(chalk.bold(review.title));
  console.log(chalk.gray("─".repeat(40)));
  console.log(`ULID:        ${review._ulid}`);
  if (review.slugs.length > 0) {
    console.log(`Slugs:       ${review.slugs.join(", ")}`);
  }
  console.log(
    `Lifecycle:   ${lifecycleColor(review.lifecycle_state)(review.lifecycle_state)}`,
  );

  const disposition = computeDisposition(review);
  console.log(
    `Disposition: ${dispositionColor(disposition)(disposition)}`,
  );

  const gateState = computeGateState(review);
  console.log(
    `Gate:        ${gateColor(gateState)(gateState)}`,
  );

  console.log(`Subject:     ${formatSubject(review.subject)}`);
  console.log(`Author:      ${review.author}`);

  if (review.related_refs.length > 0) {
    console.log(
      `Related:     ${review.related_refs.map((r) => (r.startsWith("@") ? r : `@${r}`)).join(", ")}`,
    );
  }

  console.log(`Created:     ${review.created_at}`);
  if (review.updated_at) {
    console.log(`Updated:     ${review.updated_at}`);
  }

  // Threads
  if (review.threads.length > 0) {
    const resolved = review.threads.filter((t) => t.resolved_at).length;
    const unresolved = review.threads.length - resolved;
    console.log(
      `\n${chalk.bold("─── Threads ───")} (${review.threads.length} total, ${unresolved} unresolved)`,
    );
    for (const thread of review.threads) {
      const kindColor =
        thread.kind === "blocker"
          ? chalk.red
          : thread.kind === "question"
            ? chalk.yellow
            : chalk.gray;
      const resolvedLabel = thread.resolved_at
        ? chalk.green(" [resolved]")
        : "";
      const firstEntry =
        thread.entries.length > 0 ? thread.entries[0].body : "(empty)";
      const preview =
        firstEntry.length > 80 ? firstEntry.slice(0, 77) + "..." : firstEntry;
      console.log(
        `  ${kindColor(`[${thread.kind}]`)}${resolvedLabel} ${chalk.gray(preview)}`,
      );
    }
  }

  // Checks
  if (review.checks.length > 0) {
    console.log(
      `\n${chalk.bold("─── Checks ───")} (${review.checks.length})`,
    );
    for (const check of review.checks) {
      const statusColor =
        check.status === "pass"
          ? chalk.green
          : check.status === "fail"
            ? chalk.red
            : check.status === "running"
              ? chalk.blue
              : chalk.gray;
      const requiredLabel = check.required
        ? chalk.yellow(" [required]")
        : "";
      console.log(
        `  ${statusColor(`[${check.status}]`)}${requiredLabel} ${check.name}`,
      );
    }
  }

  // Verdicts
  if (review.verdicts.length > 0) {
    console.log(
      `\n${chalk.bold("─── Verdicts ───")} (${review.verdicts.length})`,
    );
    for (const verdict of review.verdicts) {
      const decisionColor =
        verdict.decision === "approve"
          ? chalk.green
          : verdict.decision === "request_changes"
            ? chalk.red
            : chalk.gray;
      console.log(
        `  ${decisionColor(`[${verdict.decision}]`)} ${verdict.reviewer} (${verdict.role}) — ${verdict.created_at}`,
      );
    }
  }

  // Events
  if (review.events.length > 0) {
    console.log(
      `\n${chalk.bold("─── Events ───")} (${review.events.length})`,
    );
    for (const event of review.events) {
      console.log(
        `  ${chalk.gray(`[${event.timestamp}]`)} ${event.event_type} by ${event.actor}`,
      );
    }
  }

  // Notes
  if (review.notes.length > 0) {
    console.log(
      `\n${chalk.bold("─── Notes ───")} (${review.notes.length})`,
    );
    for (const note of review.notes) {
      const author = note.author || "unknown";
      console.log(chalk.gray(`[${note.created_at}] ${author}:`));
      console.log(note.content);
    }
  }
}

/**
 * Format a review for list display.
 */
function formatReviewListItem(review: ReviewRecord): void {
  const shortUlid = review._ulid.slice(0, 8);
  const slugLabel =
    review.slugs.length > 0 ? ` (${review.slugs[0]})` : "";
  const stateLabel = lifecycleColor(review.lifecycle_state)(
    `[${review.lifecycle_state}]`,
  );
  const disposition = computeDisposition(review);
  const dispLabel = dispositionColor(disposition)(`[${disposition}]`);
  const subjectLabel = formatSubject(review.subject);

  console.log(
    `${shortUlid}${slugLabel} ${stateLabel} ${dispLabel} ${review.title}`,
  );
  console.log(chalk.gray(`    ${subjectLabel} — by ${review.author}`));
}

// --- Command registration ---

export function registerReviewCommands(program: Command): void {
  const review = program
    .command("review")
    .description("Review record operations")
    .allowUnknownOption()
    .allowExcessArguments();

  // Default action for bare "kspec review"
  review.action(async (_options, cmd: Command) => {
    cmd.help();
  });

  // --- kspec review add ---
  // AC: @review-cli-creation-and-query ac-1 — ref-backed subject
  // AC: @review-cli-creation-and-query ac-2 — code subject with base/head
  // AC: @review-cli-creation-and-query ac-5 — --slug flag
  markMutating(review.command("add"))
    .description("Create a new review record")
    .requiredOption("--title <title>", "Review title")
    .option("--subject-ref <ref>", "Subject reference (task, plan, or spec)")
    .option("--base-commit <sha>", "Base commit SHA (code subject)")
    .option("--head-commit <sha>", "Head commit SHA (code subject)")
    .option(
      "--merge-base-commit <sha>",
      "Merge base commit SHA (code subject, optional)",
    )
    .option("--base-branch <branch>", "Base branch name (code subject, optional)")
    .option("--head-branch <branch>", "Head branch name (code subject, optional)")
    .option("--slug <slug>", "Human-friendly slug for the review")
    .option("--related-ref <refs...>", "Related references (tasks, specs, etc.)")
    .option("--author <author>", "Review author (defaults to configured author)")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec review add --title "Review task-auth" --subject-ref @task-auth
  $ kspec review add --title "Code review" --base-commit abc123 --head-commit def456
  $ kspec review add --title "Plan review" --subject-ref @plan-auth --slug review-auth-plan`,
    )
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const { refIndex } = await buildIndexes(ctx);

        // Determine subject binding
        let subject: ReviewSubject;

        if (options.subjectRef) {
          // AC: @review-cli-creation-and-query ac-1 — ref-backed subject
          if (options.baseCommit || options.headCommit) {
            error(
              "Cannot use --subject-ref with --base-commit/--head-commit. Use one or the other.",
            );
            process.exit(EXIT_CODES.USAGE_ERROR);
          }

          const ref = options.subjectRef.startsWith("@")
            ? options.subjectRef.slice(1)
            : options.subjectRef;
          const result = refIndex.resolve(ref);

          if (!result.ok) {
            if (result.error === "ambiguous") {
              error(errors.reference.ambiguous(options.subjectRef));
              for (const candidate of result.candidates) {
                console.error(chalk.gray(`  ${candidate}`));
              }
            } else {
              error(errors.reference.refNotFound(options.subjectRef));
            }
            process.exit(EXIT_CODES.NOT_FOUND);
          }

          // Determine type from resolved item
          const item = result.item;
          let subjectType: "task" | "plan" | "spec";
          if ("status" in item && typeof item.status === "string") {
            subjectType = "task";
          } else if ("source" in item || ("title" in item && "status" in item && typeof item.status === "object" && item.status && "approval" in item.status)) {
            subjectType = "plan";
          } else {
            subjectType = "spec";
          }

          // For ref subjects, we use a placeholder shadow_commit and content_hash
          // These would be computed by the subject binding system in production
          subject = {
            type: subjectType,
            ref: `@${ref}`,
            shadow_commit: "pending",
            content_hash: "pending",
          } as ReviewSubject;
        } else if (options.baseCommit && options.headCommit) {
          // AC: @review-cli-creation-and-query ac-2 — code subject
          subject = {
            type: "code",
            base_commit: options.baseCommit,
            head_commit: options.headCommit,
            ...(options.mergeBaseCommit && {
              merge_base_commit: options.mergeBaseCommit,
            }),
            ...(options.baseBranch && { base_branch: options.baseBranch }),
            ...(options.headBranch && { head_branch: options.headBranch }),
          };
        } else if (options.baseCommit || options.headCommit) {
          error(
            "Both --base-commit and --head-commit are required for code subjects.",
          );
          process.exit(EXIT_CODES.USAGE_ERROR);
        } else {
          error(
            "Subject is required. Use --subject-ref <ref> or --base-commit/--head-commit.",
          );
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // AC: @review-cli-creation-and-query ac-5 — slug
        const slugs: string[] = [];
        if (options.slug) {
          const slugCheck = checkSlugUniqueness(refIndex, [options.slug]);
          if (!slugCheck.ok) {
            error(
              errors.slug.alreadyExists(slugCheck.slug, slugCheck.existingUlid),
            );
            process.exit(EXIT_CODES.CONFLICT);
          }
          slugs.push(options.slug);
        }

        // Determine author
        const author =
          options.author ?? getAuthor(ctx.config?.identity?.author) ?? "unknown";

        const input: ReviewRecordInput = {
          title: options.title,
          subject,
          author,
          slugs,
          related_refs: options.relatedRef ?? [],
        };

        const reviewRecord = createReviewRecord(input);
        const loaded: LoadedReviewRecord = {
          ...reviewRecord,
          _sourceFile: undefined,
        };

        await saveReviewRecord(ctx, loaded);

        // AC: @trait-shadow-commit ac-1, ac-2, ac-3
        await commitIfShadow(
          ctx.shadow,
          "review-add",
          reviewRecord._ulid.slice(0, 8),
          reviewRecord.title,
        );

        output(toJsonOutput(reviewRecord), () => {
          success(
            `Created review: ${reviewRecord._ulid.slice(0, 8)}${slugs.length > 0 ? ` (${slugs[0]})` : ""}`,
          );
          console.log(`  Title:   ${reviewRecord.title}`);
          console.log(`  Subject: ${formatSubject(reviewRecord.subject)}`);
          console.log(`  State:   ${reviewRecord.lifecycle_state}`);
          console.log(`  Author:  ${reviewRecord.author}`);
        });
      } catch (err) {
        error("Failed to create review", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // --- kspec review get ---
  // AC: @review-cli-creation-and-query ac-3
  review
    .command("get <ref>")
    .description("Show review record details")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec review get @review-auth
  $ kspec review get 01KKNR`,
    )
    .action(async (ref: string, _options) => {
      try {
        const ctx = await initContext();
        const reviews = await loadReviewRecords(ctx);

        const found = findReviewByRef(reviews, ref);
        if (!found) {
          error(`Review not found: ${ref}`);
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        // AC: @review-cli-creation-and-query ac-3 — show lifecycle, disposition, gate, threads, checks, verdicts, events, linkage
        output(toJsonOutput(found), () => {
          formatReviewDetails(found);
        });
      } catch (err) {
        error("Failed to get review", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // --- kspec review list ---
  // AC: @review-cli-creation-and-query ac-4
  // AC: @trait-filterable-list ac-1 through ac-8
  review
    .command("list")
    .description("List review records with optional filters")
    .option("--status <state>", "Filter by lifecycle state (draft, open, closed, archived)")
    .option("--disposition <disposition>", "Filter by computed disposition (pending, approved, changes_requested)")
    .option("--subject <ref>", "Filter by subject reference")
    .option("--reviewer <name>", "Filter by reviewer name")
    .option("--tag <value>", "Filter by related ref containing tag (for trait compatibility)")
    .option("--limit <n>", "Limit number of results")
    .option("--offset <n>", "Skip first N results")
    .option("--count", "Show only the count of matching items")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec review list
  $ kspec review list --status open
  $ kspec review list --disposition changes_requested
  $ kspec review list --subject @task-auth
  $ kspec review list --reviewer alice --json
  $ kspec review list --count`,
    )
    .action(async (options) => {
      try {
        const ctx = await initContext();
        let reviews = await loadReviewRecords(ctx);

        // AC: @trait-filterable-list ac-1 — filter by status
        if (options.status) {
          const validStates = ["draft", "open", "closed", "archived"];
          if (!validStates.includes(options.status)) {
            error(
              `Invalid lifecycle state: ${options.status}. Must be one of: ${validStates.join(", ")}`,
            );
            process.exit(EXIT_CODES.USAGE_ERROR);
          }
          reviews = reviews.filter(
            (r) => r.lifecycle_state === options.status,
          );
        }

        // AC: @review-cli-creation-and-query ac-4 — filter by disposition
        if (options.disposition) {
          const validDispositions = [
            "pending",
            "approved",
            "changes_requested",
          ];
          if (!validDispositions.includes(options.disposition)) {
            error(
              `Invalid disposition: ${options.disposition}. Must be one of: ${validDispositions.join(", ")}`,
            );
            process.exit(EXIT_CODES.USAGE_ERROR);
          }
          reviews = reviews.filter(
            (r) => computeDisposition(r) === options.disposition,
          );
        }

        // AC: @review-cli-creation-and-query ac-4 — filter by subject
        if (options.subject) {
          const subjectRef = options.subject.startsWith("@")
            ? options.subject.slice(1)
            : options.subject;
          reviews = reviews.filter((r) => {
            const s = r.subject;
            if ("ref" in s) {
              const sRef = s.ref.startsWith("@") ? s.ref.slice(1) : s.ref;
              return sRef === subjectRef || sRef.startsWith(subjectRef);
            }
            return false;
          });
        }

        // AC: @review-cli-creation-and-query ac-4 — filter by reviewer
        if (options.reviewer) {
          reviews = reviews.filter((r) =>
            r.verdicts.some((v) => v.reviewer === options.reviewer) ||
            r.author === options.reviewer,
          );
        }

        // AC: @trait-filterable-list ac-2 — filter by tag
        // Reviews don't have tags directly, but we can filter by related_refs
        if (options.tag) {
          reviews = reviews.filter((r) =>
            r.related_refs.some((ref) => {
              const clean = ref.startsWith("@") ? ref.slice(1) : ref;
              return clean.includes(options.tag);
            }),
          );
        }

        const totalMatching = reviews.length;

        // AC: @trait-filterable-list ac-8 — count mode
        if (options.count) {
          output({ count: totalMatching }, () => {
            console.log(String(totalMatching));
          });
          return;
        }

        // AC: @trait-filterable-list ac-4 — offset
        if (options.offset) {
          const offset = parseInt(options.offset, 10);
          if (isNaN(offset) || offset < 0) {
            error("--offset must be a non-negative integer");
            process.exit(EXIT_CODES.USAGE_ERROR);
          }
          reviews = reviews.slice(offset);
        }

        // AC: @trait-filterable-list ac-3 — limit
        if (options.limit) {
          const limit = parseInt(options.limit, 10);
          if (isNaN(limit) || limit < 1) {
            error("--limit must be a positive integer");
            process.exit(EXIT_CODES.USAGE_ERROR);
          }
          reviews = reviews.slice(0, limit);
        }

        // AC: @trait-filterable-list ac-6 — empty list message
        if (reviews.length === 0) {
          const hasFilters =
            options.status ||
            options.disposition ||
            options.subject ||
            options.reviewer ||
            options.tag;
          output([], () => {
            if (hasFilters) {
              info("No reviews matching the given filters.");
            } else {
              info("No reviews found.");
            }
          });
          return;
        }

        // Build JSON output with computed fields
        const jsonItems = reviews.map(toJsonOutput);

        output(jsonItems, () => {
          for (const r of reviews) {
            formatReviewListItem(r);
          }

          // AC: @trait-filterable-list ac-7 — summary
          const filterParts: string[] = [];
          if (options.status) filterParts.push(`status=${options.status}`);
          if (options.disposition)
            filterParts.push(`disposition=${options.disposition}`);
          if (options.subject) filterParts.push(`subject=${options.subject}`);
          if (options.reviewer)
            filterParts.push(`reviewer=${options.reviewer}`);
          if (options.tag) filterParts.push(`tag=${options.tag}`);

          const filterLabel =
            filterParts.length > 0
              ? ` (${filterParts.join(", ")})`
              : "";
          console.log(
            chalk.gray(
              `\n${totalMatching} review${totalMatching === 1 ? "" : "s"} found${filterLabel}`,
            ),
          );
        });
      } catch (err) {
        error("Failed to list reviews", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
