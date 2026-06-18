/**
 * Review CLI commands
 *
 * AC: @review-cli-commands ac-1 — CLI provides commands for core review workflow
 * AC: @review-cli-commands ac-2 — Output includes subject, lifecycle, disposition, gate, threads, linkage
 * AC: @review-cli-commands ac-3 — Compatible with batch-oriented mutation flows
 *
 * AC: @review-cli-creation-and-query ac-1, ac-2, ac-3, ac-4, ac-5
 * AC: @review-cli-mutation-commands ac-1, ac-1b, ac-2, ac-3, ac-4, ac-5, ac-6, ac-7
 * AC: @review-cli-task-linkage ac-1, ac-2
 */

import type { Command } from "commander";
import { ulid } from "ulid";
import { markMutating } from "../command-annotations.js";
import {
  computeDisposition,
  createReviewRecord,
  findReviewByRef,
  handleVerdictTaskTransition,
  initContext,
  linkReviewToTasks,
  type LoadedReviewRecord,
  loadReviewRecords,
  mutateReviewAtomically,
  saveReviewRecord,
  shortestUniqueUlid,
  submitVerdict,
  transitionLifecycle,
} from "../../parser/index.js";
import { resolveTaskDataManager } from "../../parser/task-data-manager.js";
import { resolveCliActor } from "../actor.js";
import { commitIfShadow } from "../../parser/shadow.js";
import { evaluateGates } from "../../review/checks.js";
import { extractSubjectVersion } from "../../review/subject-bindings.js";
import type {
  ReviewAnchor,
  ReviewCheck,
  ReviewEvent,
  ReviewLifecycleState,
  ReviewRecord,
  ReviewSubject,
  ReviewThread,
  ReviewThreadKind,
  ReviewVerdictDecision,
} from "../../schema/index.js";
import {
  ReviewDispositionSchema,
  ReviewCheckStatusSchema,
  ReviewLifecycleStateSchema,
  ReviewSpecAcAnchorSchema,
  ReviewThreadKindSchema,
} from "../../schema/index.js";
import { errors } from "../../strings/index.js";
import { CommandExitError } from "../batch-context.js";
import { EXIT_CODES } from "../exit-codes.js";
import { describeEnumValues } from "../enum-help.js";
import { error, info, isJsonMode, output, success, warn } from "../output.js";
import { formatRelativeTime as formatRelativeTimeUtil } from "../../utils/time.js";
import { validateEnumOption } from "../validators.js";
import { registerReviewResourceCommands } from "./review-resource.js";

// --- Helpers ---

function formatRelativeTime(dateStr: string): string {
  return formatRelativeTimeUtil(new Date(dateStr));
}

/**
 * Exit with error guidance for review commands.
 * AC: @trait-error-guidance ac-1, ac-2
 */
function exitWithGuidance(
  message: string,
  exitCode: number,
  suggestion?: string,
  details?: Record<string, unknown>,
): never {
  if (suggestion) {
    if (isJsonMode()) {
      error(message, {
        ...details,
        suggestion,
        guidance: suggestion,
      });
    } else {
      error(message);
      console.error(`Suggestion: ${suggestion}`);
    }
  } else {
    error(message, isJsonMode() ? details : undefined);
  }

  process.exit(exitCode);
}

/**
 * Resolve a review reference (ULID, short ULID, or slug).
 * AC: @trait-error-guidance ac-3
 */
function resolveReviewRef(ref: string, reviews: LoadedReviewRecord[]): LoadedReviewRecord {
  const found = findReviewByRef(reviews, ref);
  if (!found) {
    exitWithGuidance(
      errors.reference.reviewNotFound(ref),
      EXIT_CODES.NOT_FOUND,
      "Check available reviews with: kspec review list",
      { ref, entity: "review" },
    );
  }
  return found;
}

function shortReviewRef(review: LoadedReviewRecord, reviews: LoadedReviewRecord[]): string {
  return shortestUniqueUlid(
    review._ulid,
    reviews.map((r) => r._ulid),
  );
}

/**
 * Compute gate state from checks using shared evaluateGates.
 * AC: @review-cli-commands ac-2
 */
function computeGateState(review: ReviewRecord): string {
  const currentVersion = extractSubjectVersion(review.subject);
  return evaluateGates(review.checks, currentVersion).state;
}

/**
 * Compute thread state summary.
 */
function computeThreadState(review: ReviewRecord): {
  total: number;
  resolved: number;
  unresolved: number;
  blockers_unresolved: number;
} {
  const total = review.threads.length;
  const resolved = review.threads.filter((t) => t.resolved_at).length;
  const unresolved = total - resolved;
  const blockers_unresolved = review.threads.filter(
    (t) => t.kind === "blocker" && !t.resolved_at,
  ).length;
  return { total, resolved, unresolved, blockers_unresolved };
}

/**
 * Format subject for display.
 */
function formatSubject(subject: ReviewSubject): string {
  switch (subject.type) {
    case "code":
      return `code: ${subject.base_commit.slice(0, 8)}..${subject.head_commit.slice(0, 8)}${subject.head_branch ? ` (${subject.head_branch})` : ""}`;
    case "plan":
      return `plan: ${subject.ref}`;
    case "task":
      return `task: ${subject.ref}`;
    case "spec":
      return `spec: ${subject.ref}`;
    case "external":
      return `external: ${subject.url}`;
  }
}

/**
 * Build JSON output for a review with computed fields.
 * AC: @review-cli-commands ac-2
 * AC: @trait-json-output ac-2, ac-4, ac-5
 */
function buildReviewOutput(
  review: LoadedReviewRecord,
  _reviews: LoadedReviewRecord[],
): Record<string, unknown> {
  const threadState = computeThreadState(review);
  return {
    _ulid: review._ulid,
    ref: `@${review.slugs[0] || review._ulid}`,
    slugs: review.slugs,
    title: review.title,
    lifecycle_state: review.lifecycle_state,
    disposition: computeDisposition(review),
    gate_state: computeGateState(review),
    subject: review.subject,
    author: review.author,
    related_refs: review.related_refs,
    threads: review.threads,
    thread_state: threadState,
    checks: review.checks,
    verdicts: review.verdicts,
    events: review.events,
    notes: review.notes,
    external_links: review.external_links,
    examined_commit: review.examined_commit,
    created_at: review.created_at,
    updated_at: review.updated_at,
  };
}

/**
 * Format review details for human-readable output.
 * AC: @review-cli-commands ac-2
 */
function formatReviewDetails(review: LoadedReviewRecord, _reviews: LoadedReviewRecord[]): void {
  const disposition = computeDisposition(review);
  const gateState = computeGateState(review);
  const threadState = computeThreadState(review);

  console.log(review.title);
  console.log("─".repeat(40));
  console.log(`ULID:         ${review._ulid}`);
  if (review.slugs.length > 0) {
    console.log(`Slugs:        ${review.slugs.join(", ")}`);
  }
  console.log(`Lifecycle:    ${review.lifecycle_state}`);
  console.log(`Disposition:  ${disposition}`);
  console.log(`Gate:         ${gateState}`);
  console.log(`Subject:      ${formatSubject(review.subject)}`);
  console.log(`Author:       ${review.author}`);
  if (review.examined_commit) {
    console.log(`Examined:     ${review.examined_commit}`);
  }
  console.log(`Created:      ${review.created_at} (${formatRelativeTime(review.created_at)})`);
  if (review.updated_at) {
    console.log(`Updated:      ${review.updated_at} (${formatRelativeTime(review.updated_at)})`);
  }

  if (review.related_refs.length > 0) {
    console.log(`\n─── Related Refs ───`);
    for (const ref of review.related_refs) {
      console.log(`  ${ref}`);
    }
  }

  if (review.external_links.length > 0) {
    console.log(`\n─── External Links ───`);
    for (const link of review.external_links) {
      console.log(`  ${link.label || link.url}${link.provider ? ` (${link.provider})` : ""}`);
      if (link.label) console.log(`    ${link.url}`);
    }
  }

  if (review.threads.length > 0) {
    console.log(
      `\n─── Threads (${threadState.unresolved} unresolved, ${threadState.blockers_unresolved} blockers) ───`,
    );
    for (const thread of review.threads) {
      const resolved = thread.resolved_at ? "✓" : "○";
      const anchor = thread.anchor
        ? thread.anchor.type === "code"
          ? ` ${thread.anchor.path}:${thread.anchor.line_start}`
          : thread.anchor.type === "structured"
            ? ` ${thread.anchor.section || thread.anchor.field || thread.anchor.ref || ""}`
            : ""
        : "";
      console.log(`  ${resolved} [${thread.kind}]${anchor} (${thread.entries.length} entries)`);
      if (thread.entries.length > 0) {
        const first = thread.entries[0];
        const body = first.body.length > 80 ? `${first.body.slice(0, 77)}...` : first.body;
        console.log(`    ${first.author}: ${body}`);
      }
    }
  }

  if (review.checks.length > 0) {
    console.log(`\n─── Checks ───`);
    for (const check of review.checks) {
      const required = check.required ? "(required)" : "(optional)";
      console.log(
        `  ${check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "○"} ${check.name} ${required} — ${check.status}`,
      );
    }
  }

  if (review.verdicts.length > 0) {
    console.log(`\n─── Verdicts ───`);
    for (const verdict of review.verdicts) {
      console.log(
        `  ${verdict.reviewer} (${verdict.role}): ${verdict.decision} — ${formatRelativeTime(verdict.created_at)}`,
      );
    }
  }

  if (review.events.length > 0) {
    console.log(`\n─── Events (${review.events.length}) ───`);
    for (const event of review.events.slice(-10)) {
      console.log(
        `  ${event.event_type} by ${event.actor} — ${formatRelativeTime(event.timestamp)}`,
      );
    }
    if (review.events.length > 10) {
      console.log(`  ... and ${review.events.length - 10} more`);
    }
  }
}

/**
 * Create an event entry.
 * AC: @review-record-core-model ac-4
 */
function createEvent(
  eventType: ReviewEvent["event_type"],
  actor: string,
  payload: Record<string, unknown> = {},
): ReviewEvent {
  return {
    _ulid: ulid(),
    event_type: eventType,
    actor,
    timestamp: new Date().toISOString(),
    payload,
  };
}

/**
 * Parse subject from CLI flags.
 * AC: @review-cli-creation-and-query ac-1, ac-2, ac-ref-subject-remains-ref-subject,
 *     ac-code-subject-created-only-when-requested, ac-ambiguous-review-subject-rejected,
 *     ac-version-context-does-not-change-subject
 */
function parseSubjectFromOptions(options: Record<string, unknown>): ReviewSubject {
  const subjectType = options.subjectType as string | undefined;
  const hasRefSubjectInput = Boolean(options.subjectRef);
  const hasCodeSubjectInput = Boolean(
    options.base || options.head || options.mergeBase || options.baseBranch || options.headBranch,
  );
  const hasExternalSubjectInput = Boolean(options.url || options.externalId || options.provider);

  const inferSubjectType = (): "task" | "code" | "external" => {
    const inferredTypes = [
      hasRefSubjectInput ? "task" : null,
      hasCodeSubjectInput ? "code" : null,
      hasExternalSubjectInput ? "external" : null,
    ].filter((value): value is "task" | "code" | "external" => value !== null);

    if (inferredTypes.length > 1) {
      exitWithGuidance(
        "Ambiguous review subject. Provide one subject input kind or make the subject explicit with matching flags.",
        EXIT_CODES.USAGE_ERROR,
        "Use exactly one of: --subject-ref [--subject-type plan|task|spec], --base/--head, or --url",
        { field: "subject", value: "ambiguous" },
      );
    }

    return inferredTypes[0] || "task";
  };

  const resolvedSubjectType = subjectType || inferSubjectType();

  if (
    resolvedSubjectType === "plan" ||
    resolvedSubjectType === "task" ||
    resolvedSubjectType === "spec"
  ) {
    if (hasCodeSubjectInput || hasExternalSubjectInput) {
      exitWithGuidance(
        `Subject type ${resolvedSubjectType} cannot be combined with code or external subject flags`,
        EXIT_CODES.USAGE_ERROR,
        "Use --subject-ref for plan/task/spec reviews. Use --examined-commit for review context, not --base/--head.",
        { field: "subject-type", value: resolvedSubjectType },
      );
    }

    if (!options.subjectRef) {
      exitWithGuidance(
        "Subject is required. Provide --subject-ref for plan/task/spec, or --base/--head for code, or --url for external",
        EXIT_CODES.USAGE_ERROR,
        "Usage: kspec review add --title '...' --subject-ref @ref [--subject-type plan|task|spec]",
        { field: "subject", value: "missing" },
      );
    }

    return {
      type: resolvedSubjectType,
      ref: (options.subjectRef as string).startsWith("@")
        ? (options.subjectRef as string)
        : `@${options.subjectRef as string}`,
      shadow_commit: "",
      content_hash: "",
    };
  }

  if (resolvedSubjectType === "code") {
    if (hasRefSubjectInput || hasExternalSubjectInput) {
      exitWithGuidance(
        "Code subject cannot be combined with --subject-ref or external subject flags",
        EXIT_CODES.USAGE_ERROR,
        "Use only --base/--head for code reviews, or remove --subject-type code.",
        { field: "subject-type", value: "code" },
      );
    }

    if (!options.base || !options.head) {
      exitWithGuidance(
        "Code subject requires --base and --head commit refs",
        EXIT_CODES.USAGE_ERROR,
        "Usage: kspec review add --title '...' --subject-type code --base <commit> --head <commit>",
        { field: "base/head", value: "missing" },
      );
    }
    const subject: ReviewSubject = {
      type: "code" as const,
      base_commit: options.base as string,
      head_commit: options.head as string,
    };
    if (options.mergeBase) {
      (subject as Record<string, unknown>).merge_base_commit = options.mergeBase as string;
    }
    if (options.baseBranch) {
      (subject as Record<string, unknown>).base_branch = options.baseBranch as string;
    }
    if (options.headBranch) {
      (subject as Record<string, unknown>).head_branch = options.headBranch as string;
    }
    return subject;
  }

  if (resolvedSubjectType === "external") {
    if (hasRefSubjectInput || hasCodeSubjectInput) {
      exitWithGuidance(
        "External subject cannot be combined with --subject-ref or code subject flags",
        EXIT_CODES.USAGE_ERROR,
        "Use only --url [--external-id --provider] for external reviews.",
        { field: "subject-type", value: "external" },
      );
    }

    if (!options.url) {
      exitWithGuidance(
        "External subject requires --url",
        EXIT_CODES.USAGE_ERROR,
        "Usage: kspec review add --title '...' --subject-type external --url <url>",
        { field: "url", value: "missing" },
      );
    }
    const subject: ReviewSubject = {
      type: "external" as const,
      url: options.url as string,
    };
    if (options.externalId) {
      (subject as Record<string, unknown>).external_id = options.externalId as string;
    }
    if (options.provider) {
      (subject as Record<string, unknown>).provider = options.provider as string;
    }
    return subject;
  }

  exitWithGuidance(
    `Invalid subject type: ${resolvedSubjectType}. Must be one of: plan, task, spec, code, external`,
    EXIT_CODES.USAGE_ERROR,
    "Valid subject types: plan, task, spec, code, external",
    { field: "subject-type", value: resolvedSubjectType },
  );
}

// --- Command Registration ---

export function registerReviewCommands(program: Command): void {
  const review = program.command("review").description("Manage first-party review records");

  // kspec review rebuild-index
  // AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  registerReviewRebuildIndexCommand(review);

  // kspec review resource add|list|get|remove
  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  registerReviewResourceCommands(review);

  // --- review add ---
  // AC: @review-cli-creation-and-query ac-1, ac-2, ac-5
  // AC: @review-cli-commands ac-1
  markMutating(
    review
      .command("add")
      .description("Create a new review record")
      .requiredOption("--title <title>", "Review title")
      .option("--slug <slug>", "Custom slug for the review")
      .option("--subject-type <type>", "Subject type: plan, task, spec, code, external")
      .option("--subject-ref <ref>", "Subject reference (for plan/task/spec)")
      .option("--base <commit>", "Base commit (for code subjects)")
      .option("--head <commit>", "Head commit (for code subjects)")
      .option("--merge-base <commit>", "Merge base commit (for code subjects)")
      .option("--base-branch <branch>", "Base branch name (for code subjects)")
      .option("--head-branch <branch>", "Head branch name (for code subjects)")
      .option("--url <url>", "External URL (for external subjects)")
      .option("--external-id <id>", "External identifier (for external subjects)")
      .option("--provider <provider>", "External provider (for external subjects)")
      .option("--related-ref <ref...>", "Related references (e.g. task refs)")
      .option("--author <author>", "Review author (defaults to configured author)")
      .option("--examined-commit <commit>", "Commit hash the reviewer is examining")
      .action(async (options) => {
        try {
          const ctx = await initContext();
          const author = await resolveCliActor(ctx, options.author, "author");
          const subject = parseSubjectFromOptions(options);

          // AC: @review-fix-cycle-diff ac-1 — capture examined commit
          const examinedCommit: string | null =
            (options.examinedCommit as string | undefined) ||
            process.env.KSPEC_DISPATCH_CANONICAL_HEAD ||
            null;

          const review = createReviewRecord({
            title: options.title,
            slugs: options.slug ? [options.slug] : [],
            subject,
            author,
            related_refs: options.relatedRef || [],
            examined_commit: examinedCommit,
            events: [createEvent("lifecycle_change", author, { to: "draft" })],
          });

          await saveReviewRecord(ctx, { ...review, _sourceFile: undefined });

          // AC: @review-task-lifecycle-integration ac-2, ac-3
          // Auto-link review to task(s) via review_ref (skipCommit in linkReviewToTasks)
          const allTasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
          const linkResult = await linkReviewToTasks(ctx, review, allTasks);

          // AC: @trait-shadow-commit ac-1, ac-2, ac-3
          // Single atomic commit: review creation + task linkage
          const linkSuffix =
            linkResult.linkedTasks.length > 0
              ? ` (linked to ${linkResult.linkedTasks.length} task(s))`
              : "";
          await commitIfShadow(
            ctx.shadow,
            "review-add",
            review.slugs[0] || review._ulid.slice(0, 8),
            `${options.title}${linkSuffix}`,
          );

          const reviews = await loadReviewRecords(ctx);
          const shortRef = shortReviewRef({ ...review, _sourceFile: undefined }, reviews);

          output(buildReviewOutput({ ...review, _sourceFile: undefined }, reviews), () => {
            success(
              `Created review: ${shortRef}${review.slugs.length > 0 ? ` (${review.slugs[0]})` : ""}`,
            );
          });
        } catch (err) {
          if (err instanceof CommandExitError) throw err;
          error(errors.failures.createReview, err);
          process.exit(EXIT_CODES.ERROR);
        }
      }),
  );

  // --- review get ---
  // AC: @review-cli-creation-and-query ac-3
  // AC: @review-cli-commands ac-2
  review
    .command("get <ref>")
    .description("Show review details")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const reviews = await loadReviewRecords(ctx);
        const found = resolveReviewRef(ref, reviews);

        output(buildReviewOutput(found, reviews), () => {
          formatReviewDetails(found, reviews);
        });
      } catch (err) {
        if (err instanceof CommandExitError) throw err;
        error(errors.failures.getReview, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // --- review list ---
  // AC: @review-cli-creation-and-query ac-4
  // AC: @trait-filterable-list ac-1, ac-3, ac-4, ac-5, ac-6, ac-7, ac-8
  review
    .command("list")
    .description("List review records")
    .option("--status <status>", "Filter by lifecycle state (draft, open, closed, archived)")
    .option(
      "--disposition <disposition>",
      "Filter by computed disposition (pending, approved, changes_requested)",
    )
    .option("--subject-type <type>", "Filter by subject type")
    .option("--reviewer <reviewer>", "Filter by reviewer who has submitted a verdict")
    .option(
      "--task <ref>",
      "Filter reviews linked to a specific task (via subject, related_refs, or review_ref)",
    )
    .option("--limit <n>", "Limit results", parseInt)
    .option("--offset <n>", "Skip first N results", parseInt)
    .option("--count", "Show only the count of matching items")
    .action(async (options) => {
      try {
        const ctx = await initContext();
        let reviews = await loadReviewRecords(ctx);

        // Apply filters
        // AC: @trait-filterable-list ac-1
        if (options.status) {
          const statusResult = validateEnumOption(
            options.status,
            ReviewLifecycleStateSchema.options,
            "review lifecycle state",
          );
          if (!statusResult.ok) {
            exitWithGuidance(
              statusResult.error,
              EXIT_CODES.VALIDATION_FAILED,
              `Valid statuses: ${ReviewLifecycleStateSchema.options.join(", ")}`,
              { field: "status", value: options.status },
            );
          }
          reviews = reviews.filter((r) => r.lifecycle_state === statusResult.value);
        }

        if (options.disposition) {
          const dispositionResult = validateEnumOption(
            options.disposition,
            ReviewDispositionSchema.options,
            "review disposition",
          );
          if (!dispositionResult.ok) {
            exitWithGuidance(
              dispositionResult.error,
              EXIT_CODES.VALIDATION_FAILED,
              `Valid dispositions: ${ReviewDispositionSchema.options.join(", ")}`,
              { field: "disposition", value: options.disposition },
            );
          }
          reviews = reviews.filter((r) => computeDisposition(r) === dispositionResult.value);
        }

        if (options.subjectType) {
          reviews = reviews.filter((r) => r.subject.type === options.subjectType);
        }

        if (options.reviewer) {
          reviews = reviews.filter((r) => r.verdicts.some((v) => v.reviewer === options.reviewer));
        }

        // AC: @review-cli-task-linkage ac-1, ac-2 — filter by task ref
        if (options.task) {
          const taskRef = options.task.startsWith("@") ? options.task : `@${options.task}`;
          const taskRefNoAt = taskRef.slice(1);

          // Also check task.review_ref to find reviews linked via the task schema
          const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
          const task = tasks.find(
            (t) =>
              t._ulid === taskRefNoAt ||
              t._ulid.toLowerCase().startsWith(taskRefNoAt.toLowerCase()) ||
              t.slugs.includes(taskRefNoAt),
          );
          const reviewRefFromTask = task?.review_ref ?? null;

          reviews = reviews.filter(
            (r) =>
              r.related_refs.includes(taskRef) ||
              (r.subject.type === "task" && r.subject.ref === taskRef) ||
              (reviewRefFromTask &&
                (r._ulid === reviewRefFromTask.replace(/^@/, "") ||
                  r.slugs.includes(reviewRefFromTask.replace(/^@/, "")))),
          );
        }

        const total = reviews.length;

        // AC: @trait-filterable-list ac-8 — count mode
        if (options.count) {
          output({ count: total }, () => {
            console.log(String(total));
          });
          return;
        }

        // AC: @trait-filterable-list ac-4 — offset
        if (options.offset) {
          reviews = reviews.slice(options.offset);
        }

        // AC: @trait-filterable-list ac-3 — limit
        if (options.limit) {
          reviews = reviews.slice(0, options.limit);
        }

        // AC: @trait-filterable-list ac-6 — empty results
        if (total === 0) {
          output({ reviews: [], total: 0, message: "No reviews found" }, () => {
            info("No reviews found");
          });
          return;
        }

        // Build output data
        const allReviews = await loadReviewRecords(ctx);
        const outputData = {
          reviews: reviews.map((r) => ({
            _ulid: r._ulid,
            ref: `@${r.slugs[0] || r._ulid}`,
            slugs: r.slugs,
            title: r.title,
            lifecycle_state: r.lifecycle_state,
            disposition: computeDisposition(r),
            gate_state: computeGateState(r),
            subject_type: r.subject.type,
            author: r.author,
            threads: computeThreadState(r),
            created_at: r.created_at,
          })),
          total,
          showing: reviews.length,
        };

        // AC: @trait-filterable-list ac-7 — summary
        output(outputData, () => {
          console.log(`Reviews (${reviews.length}/${total}):`);
          for (const r of reviews) {
            const shortRef = shortReviewRef(r, allReviews);
            const disposition = computeDisposition(r);
            const threadState = computeThreadState(r);
            const threadSummary =
              threadState.total > 0
                ? ` [${threadState.unresolved}/${threadState.total} threads]`
                : "";
            console.log(
              `  ${shortRef} ${r.lifecycle_state}/${disposition} ${r.title}${threadSummary}`,
            );
          }
        });
      } catch (err) {
        if (err instanceof CommandExitError) throw err;
        error(errors.failures.listReviews, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // --- review comment add ---
  // AC: @review-cli-mutation-commands ac-1
  markMutating(
    review
      .command("comment <ref>")
      .description("Add a comment thread to a review")
      .requiredOption("--body <body>", "Comment body")
      .option(
        "--kind <kind>",
        describeEnumValues("Thread kind", ReviewThreadKindSchema.options),
        "nit",
      )
      .option("--path <path>", "Code anchor: file path")
      .option("--side <side>", "Code anchor: base or head")
      .option("--line-start <n>", "Code anchor: start line", parseInt)
      .option("--line-end <n>", "Code anchor: end line", parseInt)
      .option("--commit <commit>", "Code anchor: commit")
      .option("--section <section>", "Structured anchor: section")
      .option("--field <field>", "Structured anchor: field")
      .option("--anchor-ref <ref>", "Structured anchor: ref")
      .option("--spec-ref <ref>", "Spec AC anchor: spec reference")
      .option("--ac-id <id>", "Spec AC anchor: acceptance criterion id")
      .option("--author <author>", "Comment author")
      .action(async (ref: string, options) => {
        try {
          const ctx = await initContext();
          const reviews = await loadReviewRecords(ctx);
          const found = resolveReviewRef(ref, reviews);
          const author = await resolveCliActor(ctx, options.author, "author");

          // Validate thread kind
          // AC: @trait-error-guidance ac-5
          const validKinds = ReviewThreadKindSchema.options;
          if (!validKinds.includes(options.kind)) {
            exitWithGuidance(
              `Invalid thread kind: ${options.kind}`,
              EXIT_CODES.USAGE_ERROR,
              `Valid kinds: ${validKinds.join(", ")}`,
              { field: "kind", value: options.kind },
            );
          }

          // Build anchor if provided
          let anchor: ReviewAnchor | undefined;
          if (options.path) {
            anchor = {
              type: "code" as const,
              path: options.path,
              side: (options.side || "head") as "base" | "head",
              line_start: options.lineStart || 1,
              line_end: options.lineEnd || options.lineStart || 1,
              commit: options.commit || "",
            };
          } else if (options.specRef || options.acId) {
            const specAcAnchor = {
              type: "spec_ac" as const,
              spec_ref: options.specRef,
              criterion_id: options.acId,
            };
            const parsedAnchor = ReviewSpecAcAnchorSchema.safeParse(specAcAnchor);
            if (!parsedAnchor.success) {
              const issue = parsedAnchor.error.issues[0];
              const field = issue?.path.join(".") || "anchor";
              exitWithGuidance(
                `Invalid spec AC anchor ${field}: ${issue?.message || "invalid value"}`,
                EXIT_CODES.USAGE_ERROR,
                "Use --spec-ref with a valid @reference and --ac-id with an ac-prefixed criterion id.",
                { field, value: (specAcAnchor as Record<string, unknown>)[field] },
              );
            }
            anchor = parsedAnchor.data;
          } else if (options.section || options.field || options.anchorRef) {
            anchor = {
              type: "structured" as const,
              ...(options.section ? { section: options.section } : {}),
              ...(options.field ? { field: options.field } : {}),
              ...(options.anchorRef ? { ref: options.anchorRef } : {}),
            };
          }

          const threadId = ulid();
          const entryId = ulid();
          const now = new Date().toISOString();

          const newThread: ReviewThread = {
            _ulid: threadId,
            kind: options.kind as ReviewThreadKind,
            ...(anchor ? { anchor } : {}),
            entries: [
              {
                _ulid: entryId,
                author,
                body: options.body,
                created_at: now,
              },
            ],
          };

          await mutateReviewAtomically(ctx, found, (latest) => ({
            ...latest,
            threads: [...latest.threads, newThread],
            events: [
              ...latest.events,
              createEvent("thread_created", author, {
                thread_ulid: threadId,
                kind: options.kind,
              }),
            ],
            updated_at: now,
          }));

          await commitIfShadow(
            ctx.shadow,
            "review-comment",
            found.slugs[0] || found._ulid.slice(0, 8),
          );

          output({ thread_ulid: threadId, review_ulid: found._ulid }, () => {
            success(`Added ${options.kind} thread to review ${shortReviewRef(found, reviews)}`);
          });
        } catch (err) {
          if (err instanceof CommandExitError) throw err;
          error(errors.failures.addReviewComment, err);
          process.exit(EXIT_CODES.ERROR);
        }
      }),
  );

  // --- review reply ---
  // AC: @review-cli-mutation-commands ac-1b
  markMutating(
    review
      .command("reply <ref>")
      .description("Reply to an existing review thread")
      .requiredOption("--thread <ulid>", "Thread ULID to reply to")
      .requiredOption("--body <body>", "Reply body")
      .option("--author <author>", "Reply author")
      .action(async (ref: string, options) => {
        try {
          const ctx = await initContext();
          const reviews = await loadReviewRecords(ctx);
          const found = resolveReviewRef(ref, reviews);
          const author = await resolveCliActor(ctx, options.author, "author");
          const now = new Date().toISOString();

          const threadRef = options.thread.startsWith("@")
            ? options.thread.slice(1)
            : options.thread;
          const threadIndex = found.threads.findIndex(
            (t) =>
              t._ulid === threadRef || t._ulid.toLowerCase().startsWith(threadRef.toLowerCase()),
          );
          if (threadIndex === -1) {
            exitWithGuidance(
              `Thread not found: ${options.thread}`,
              EXIT_CODES.NOT_FOUND,
              `Check threads with: kspec review get ${ref}`,
              { ref: options.thread, entity: "thread" },
            );
          }

          const entryId = ulid();

          await mutateReviewAtomically(ctx, found, (latest) => {
            const threads = [...latest.threads];
            threads[threadIndex] = {
              ...threads[threadIndex],
              entries: [
                ...threads[threadIndex].entries,
                {
                  _ulid: entryId,
                  author,
                  body: options.body,
                  created_at: now,
                },
              ],
            };
            return {
              ...latest,
              threads,
              events: [
                ...latest.events,
                createEvent("thread_replied", author, {
                  thread_ulid: found.threads[threadIndex]._ulid,
                }),
              ],
              updated_at: now,
            };
          });

          await commitIfShadow(
            ctx.shadow,
            "review-reply",
            found.slugs[0] || found._ulid.slice(0, 8),
          );

          output(
            { thread_ulid: found.threads[threadIndex]._ulid, review_ulid: found._ulid },
            () => {
              success(`Replied to thread on review ${shortReviewRef(found, reviews)}`);
            },
          );
        } catch (err) {
          if (err instanceof CommandExitError) throw err;
          error(errors.failures.replyToReviewThread, err);
          process.exit(EXIT_CODES.ERROR);
        }
      }),
  );

  // --- review check ---
  // AC: @review-cli-mutation-commands ac-2
  markMutating(
    review
      .command("check <ref>")
      .description("Add a check result to a review")
      .requiredOption("--name <name>", "Check name")
      .requiredOption("--status <status>", "Check status: pass, fail, running, skipped")
      .option("--required", "Mark check as required (default: true)")
      .option("--no-required", "Mark check as not required")
      .option("--runner <runner>", "Check runner identifier")
      .option("--evidence <evidence>", "Evidence payload or link")
      .option("--author <author>", "Actor for the event")
      .action(async (ref: string, options) => {
        try {
          const ctx = await initContext();
          const reviews = await loadReviewRecords(ctx);
          const found = resolveReviewRef(ref, reviews);
          const author = await resolveCliActor(ctx, options.author, "author");
          const now = new Date().toISOString();

          // Validate check status
          // AC: @trait-error-guidance ac-5
          const statusResult = validateEnumOption(
            options.status,
            ReviewCheckStatusSchema.options,
            "check status",
          );
          if (!statusResult.ok) {
            exitWithGuidance(
              statusResult.error,
              EXIT_CODES.VALIDATION_FAILED,
              `Valid statuses: ${ReviewCheckStatusSchema.options.join(", ")}`,
              { field: "status", value: options.status },
            );
          }

          // AC: @review-cli-mutation-commands ac-2 — auto-derive version from review subject
          const version = extractSubjectVersion(found.subject);

          // `runner` is the tool/command that executed the check (e.g.
          // "npm test", "kspec"), not a human/agent actor — it is persisted
          // verbatim. The event actor (who recorded the check) is the canonical
          // `author` resolved above.
          const newCheck: ReviewCheck = {
            name: options.name,
            status: statusResult.value as ReviewCheck["status"],
            required: options.required !== false,
            ...(options.runner ? { runner: options.runner } : {}),
            ...(options.evidence ? { evidence: options.evidence } : {}),
            applies_to_version: version,
            created_at: now,
            completed_at: statusResult.value !== "running" ? now : null,
          };

          await mutateReviewAtomically(ctx, found, (latest) => ({
            ...latest,
            checks: [...latest.checks, newCheck],
            events: [
              ...latest.events,
              createEvent("check_added", author, {
                name: options.name,
                status: statusResult.value,
              }),
            ],
            updated_at: now,
          }));

          await commitIfShadow(
            ctx.shadow,
            "review-check",
            found.slugs[0] || found._ulid.slice(0, 8),
            options.name,
          );

          output(
            { check_name: options.name, status: statusResult.value, review_ulid: found._ulid },
            () => {
              success(
                `Added check "${options.name}" (${statusResult.value}) to review ${shortReviewRef(found, reviews)}`,
              );
            },
          );
        } catch (err) {
          if (err instanceof CommandExitError) throw err;
          error(errors.failures.addReviewCheck, err);
          process.exit(EXIT_CODES.ERROR);
        }
      }),
  );

  // --- review verdict ---
  // AC: @review-cli-mutation-commands ac-3
  markMutating(
    review
      .command("verdict <ref>")
      .description("Set a verdict on a review")
      .requiredOption("--decision <decision>", "Verdict: approve, request_changes, comment")
      .option("--reviewer <reviewer>", "Reviewer identity")
      .option("--role <role>", "Reviewer role", "reviewer")
      .action(async (ref: string, options) => {
        try {
          const ctx = await initContext();
          const reviews = await loadReviewRecords(ctx);
          const found = resolveReviewRef(ref, reviews);
          const reviewer = await resolveCliActor(ctx, options.reviewer, "reviewer");

          // Validate decision
          // AC: @trait-error-guidance ac-5
          const validDecisions = ["approve", "request_changes", "comment"];
          if (!validDecisions.includes(options.decision)) {
            exitWithGuidance(
              `Invalid verdict decision: ${options.decision}`,
              EXIT_CODES.USAGE_ERROR,
              `Valid decisions: ${validDecisions.join(", ")}`,
              { field: "decision", value: options.decision },
            );
          }

          // AC: @review-record-per-cycle-lifecycle ac-1 — auto-close on approve/request_changes
          const shouldAutoClose =
            options.decision === "approve" || options.decision === "request_changes";

          const updated = await mutateReviewAtomically(ctx, found, (latest) => {
            const withVerdict = submitVerdict(latest, {
              reviewer,
              decision: options.decision as ReviewVerdictDecision,
              role: options.role,
            });

            // Auto-close if approve or request_changes
            if (shouldAutoClose && withVerdict.lifecycle_state !== "closed") {
              return transitionLifecycle(withVerdict, "closed", reviewer);
            }

            return withVerdict;
          });

          // AC: @review-task-lifecycle-integration ac-4
          // Auto-transition tasks to needs_work on changes_requested verdict
          const allTasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
          const transitioned = await handleVerdictTaskTransition(
            ctx,
            found,
            options.decision as ReviewVerdictDecision,
            allTasks,
            reviewer,
          );

          // Single atomic commit: review verdict + any task transitions
          const transitionedCount = transitioned.filter((t) => t.transitioned).length;
          await commitIfShadow(
            ctx.shadow,
            "review-verdict",
            found.slugs[0] || found._ulid.slice(0, 8),
            `${options.decision}${shouldAutoClose ? " (auto-closed)" : ""}${transitionedCount > 0 ? ` (${transitionedCount} task(s) → needs_work)` : ""}`,
          );

          output(
            {
              decision: options.decision,
              reviewer,
              review_ulid: found._ulid,
              lifecycle_state: updated.lifecycle_state,
            },
            () => {
              success(
                `Recorded verdict "${options.decision}" by ${reviewer} on review ${shortReviewRef(found, reviews)}`,
              );
              if (shouldAutoClose) {
                info(`Review auto-closed`);
              }
              for (const t of transitioned.filter((t) => t.transitioned)) {
                info(`Task @${t.slug || t.ulid} transitioned to needs_work`);
              }
            },
          );
        } catch (err) {
          if (err instanceof CommandExitError) throw err;
          error(errors.failures.setReviewVerdict, err);
          process.exit(EXIT_CODES.ERROR);
        }
      }),
  );

  // --- review resolve ---
  // AC: @review-cli-mutation-commands ac-4
  markMutating(
    review
      .command("resolve <ref>")
      .description("Resolve a review thread")
      .requiredOption("--thread <ulid>", "Thread ULID to resolve")
      .option("--author <author>", "Actor")
      .action(async (ref: string, options) => {
        try {
          const ctx = await initContext();
          const reviews = await loadReviewRecords(ctx);
          const found = resolveReviewRef(ref, reviews);
          const author = await resolveCliActor(ctx, options.author, "author");
          const now = new Date().toISOString();

          const threadRef = options.thread.startsWith("@")
            ? options.thread.slice(1)
            : options.thread;
          const threadIndex = found.threads.findIndex(
            (t) =>
              t._ulid === threadRef || t._ulid.toLowerCase().startsWith(threadRef.toLowerCase()),
          );
          if (threadIndex === -1) {
            exitWithGuidance(
              `Thread not found: ${options.thread}`,
              EXIT_CODES.NOT_FOUND,
              `Check threads with: kspec review get ${ref}`,
              { ref: options.thread, entity: "thread" },
            );
          }

          if (found.threads[threadIndex].resolved_at) {
            exitWithGuidance(
              `Thread is already resolved`,
              EXIT_CODES.USAGE_ERROR,
              `Use kspec review reopen ${ref} --thread ${options.thread} to reopen`,
              { current_state: "resolved", valid_next: ["reopen"] },
            );
          }

          await mutateReviewAtomically(ctx, found, (latest) => {
            const threads = [...latest.threads];
            threads[threadIndex] = {
              ...threads[threadIndex],
              resolved_at: now,
              resolved_by: author,
            };
            return {
              ...latest,
              threads,
              events: [
                ...latest.events,
                createEvent("thread_resolved", author, {
                  thread_ulid: found.threads[threadIndex]._ulid,
                }),
              ],
              updated_at: now,
            };
          });

          await commitIfShadow(
            ctx.shadow,
            "review-resolve",
            found.slugs[0] || found._ulid.slice(0, 8),
          );

          output(
            { thread_ulid: found.threads[threadIndex]._ulid, review_ulid: found._ulid },
            () => {
              success(`Resolved thread on review ${shortReviewRef(found, reviews)}`);
            },
          );
        } catch (err) {
          if (err instanceof CommandExitError) throw err;
          error(errors.failures.resolveReviewThread, err);
          process.exit(EXIT_CODES.ERROR);
        }
      }),
  );

  // --- review reopen ---
  // AC: @review-cli-mutation-commands ac-4
  markMutating(
    review
      .command("reopen <ref>")
      .description("Reopen a resolved review thread")
      .requiredOption("--thread <ulid>", "Thread ULID to reopen")
      .option("--author <author>", "Actor")
      .action(async (ref: string, options) => {
        try {
          const ctx = await initContext();
          const reviews = await loadReviewRecords(ctx);
          const found = resolveReviewRef(ref, reviews);
          const author = await resolveCliActor(ctx, options.author, "author");
          const now = new Date().toISOString();

          const threadRef = options.thread.startsWith("@")
            ? options.thread.slice(1)
            : options.thread;
          const threadIndex = found.threads.findIndex(
            (t) =>
              t._ulid === threadRef || t._ulid.toLowerCase().startsWith(threadRef.toLowerCase()),
          );
          if (threadIndex === -1) {
            exitWithGuidance(
              `Thread not found: ${options.thread}`,
              EXIT_CODES.NOT_FOUND,
              `Check threads with: kspec review get ${ref}`,
              { ref: options.thread, entity: "thread" },
            );
          }

          if (!found.threads[threadIndex].resolved_at) {
            exitWithGuidance(
              `Thread is not resolved`,
              EXIT_CODES.USAGE_ERROR,
              `Use kspec review resolve ${ref} --thread ${options.thread} to resolve`,
              { current_state: "unresolved", valid_next: ["resolve"] },
            );
          }

          await mutateReviewAtomically(ctx, found, (latest) => {
            const threads = [...latest.threads];
            threads[threadIndex] = {
              ...threads[threadIndex],
              resolved_at: null,
              resolved_by: null,
            };
            return {
              ...latest,
              threads,
              events: [
                ...latest.events,
                createEvent("thread_reopened", author, {
                  thread_ulid: found.threads[threadIndex]._ulid,
                }),
              ],
              updated_at: now,
            };
          });

          await commitIfShadow(
            ctx.shadow,
            "review-reopen",
            found.slugs[0] || found._ulid.slice(0, 8),
          );

          output(
            { thread_ulid: found.threads[threadIndex]._ulid, review_ulid: found._ulid },
            () => {
              success(`Reopened thread on review ${shortReviewRef(found, reviews)}`);
            },
          );
        } catch (err) {
          if (err instanceof CommandExitError) throw err;
          error(errors.failures.reopenReviewThread, err);
          process.exit(EXIT_CODES.ERROR);
        }
      }),
  );

  // --- review open ---
  // AC: @review-cli-mutation-commands ac-5
  markMutating(
    review
      .command("open <ref>")
      .description("Open a review (transition from draft to open)")
      .option("--author <author>", "Actor")
      .action(async (ref: string, options) => {
        try {
          const ctx = await initContext();
          const reviews = await loadReviewRecords(ctx);
          const found = resolveReviewRef(ref, reviews);
          const author = await resolveCliActor(ctx, options.author, "author");
          const now = new Date().toISOString();

          // AC: @trait-error-guidance ac-4
          if (found.lifecycle_state !== "draft" && found.lifecycle_state !== "closed") {
            exitWithGuidance(
              `Cannot open review: current state is ${found.lifecycle_state}`,
              EXIT_CODES.VALIDATION_FAILED,
              `Review can only be opened from draft or closed state`,
              {
                current_state: found.lifecycle_state,
                valid_from: ["draft", "closed"],
              },
            );
          }

          await mutateReviewAtomically(ctx, found, (latest) => ({
            ...latest,
            lifecycle_state: "open" as ReviewLifecycleState,
            events: [
              ...latest.events,
              createEvent("lifecycle_change", author, {
                from: latest.lifecycle_state,
                to: "open",
              }),
            ],
            updated_at: now,
          }));

          await commitIfShadow(
            ctx.shadow,
            "review-open",
            found.slugs[0] || found._ulid.slice(0, 8),
          );

          output({ lifecycle_state: "open", review_ulid: found._ulid }, () => {
            success(`Opened review ${shortReviewRef(found, reviews)}`);
          });
        } catch (err) {
          if (err instanceof CommandExitError) throw err;
          error(errors.failures.openReview, err);
          process.exit(EXIT_CODES.ERROR);
        }
      }),
  );

  // --- review close ---
  // AC: @review-cli-mutation-commands ac-5
  markMutating(
    review
      .command("close <ref>")
      .description("Close a review")
      .option("--author <author>", "Actor")
      .action(async (ref: string, options) => {
        try {
          const ctx = await initContext();
          const reviews = await loadReviewRecords(ctx);
          const found = resolveReviewRef(ref, reviews);
          const author = await resolveCliActor(ctx, options.author, "author");
          const now = new Date().toISOString();

          // AC: @trait-error-guidance ac-4
          if (found.lifecycle_state === "closed") {
            exitWithGuidance(
              `Review is already closed`,
              EXIT_CODES.VALIDATION_FAILED,
              `Current state: closed`,
              { current_state: "closed", valid_next: ["open", "archive"] },
            );
          }
          if (found.lifecycle_state === "archived") {
            exitWithGuidance(
              `Cannot close review: current state is archived`,
              EXIT_CODES.VALIDATION_FAILED,
              `Archived reviews cannot be modified`,
              { current_state: "archived", valid_next: [] },
            );
          }

          await mutateReviewAtomically(ctx, found, (latest) => ({
            ...latest,
            lifecycle_state: "closed" as ReviewLifecycleState,
            events: [
              ...latest.events,
              createEvent("lifecycle_change", author, {
                from: latest.lifecycle_state,
                to: "closed",
              }),
            ],
            updated_at: now,
          }));

          await commitIfShadow(
            ctx.shadow,
            "review-close",
            found.slugs[0] || found._ulid.slice(0, 8),
          );

          output({ lifecycle_state: "closed", review_ulid: found._ulid }, () => {
            success(`Closed review ${shortReviewRef(found, reviews)}`);
          });
        } catch (err) {
          if (err instanceof CommandExitError) throw err;
          error(errors.failures.closeReview, err);
          process.exit(EXIT_CODES.ERROR);
        }
      }),
  );

  // --- review archive ---
  // AC: @review-cli-mutation-commands ac-5
  // AC: @review-cli-mutation-commands ac-7 — No delete command exists; destructive operations are
  // deferred to future work and will require explicit safety behavior (--force / confirmation)
  // separate from close/archive lifecycle transitions.
  markMutating(
    review
      .command("archive <ref>")
      .description("Archive a review (permanent)")
      .option("--author <author>", "Actor")
      .action(async (ref: string, options) => {
        try {
          const ctx = await initContext();
          const reviews = await loadReviewRecords(ctx);
          const found = resolveReviewRef(ref, reviews);
          const author = await resolveCliActor(ctx, options.author, "author");
          const now = new Date().toISOString();

          // AC: @trait-error-guidance ac-4
          if (found.lifecycle_state === "archived") {
            exitWithGuidance(
              `Review is already archived`,
              EXIT_CODES.VALIDATION_FAILED,
              `Current state: archived`,
              { current_state: "archived", valid_next: [] },
            );
          }

          await mutateReviewAtomically(ctx, found, (latest) => ({
            ...latest,
            lifecycle_state: "archived" as ReviewLifecycleState,
            events: [
              ...latest.events,
              createEvent("lifecycle_change", author, {
                from: latest.lifecycle_state,
                to: "archived",
              }),
            ],
            updated_at: now,
          }));

          await commitIfShadow(
            ctx.shadow,
            "review-archive",
            found.slugs[0] || found._ulid.slice(0, 8),
          );

          output({ lifecycle_state: "archived", review_ulid: found._ulid }, () => {
            success(`Archived review ${shortReviewRef(found, reviews)}`);
          });
        } catch (err) {
          if (err instanceof CommandExitError) throw err;
          error(errors.failures.archiveReview, err);
          process.exit(EXIT_CODES.ERROR);
        }
      }),
  );

  // --- review refresh ---
  // AC: @review-cli-mutation-commands ac-6
  markMutating(
    review
      .command("refresh <ref>")
      .description("Update subject compare context after new commits")
      .requiredOption("--head <commit>", "New head commit")
      .option("--base <commit>", "New base commit (if changed)")
      .option("--author <author>", "Actor")
      .action(async (ref: string, options) => {
        try {
          const ctx = await initContext();
          const reviews = await loadReviewRecords(ctx);
          const found = resolveReviewRef(ref, reviews);
          const author = await resolveCliActor(ctx, options.author, "author");
          const now = new Date().toISOString();

          if (found.subject.type !== "code") {
            exitWithGuidance(
              `Refresh is only supported for code subjects (current: ${found.subject.type})`,
              EXIT_CODES.USAGE_ERROR,
              "Only code reviews support refresh with --head/--base",
              { field: "subject.type", value: found.subject.type },
            );
          }

          await mutateReviewAtomically(ctx, found, (latest) => {
            const subject = { ...latest.subject } as Record<string, unknown>;
            const previousHead = (subject as { head_commit: string }).head_commit;
            subject.head_commit = options.head;
            if (options.base) {
              subject.base_commit = options.base;
            }
            return {
              ...latest,
              subject: subject as ReviewSubject,
              events: [
                ...latest.events,
                createEvent("subject_refreshed", author, {
                  previous_head: previousHead,
                  new_head: options.head,
                  ...(options.base ? { new_base: options.base } : {}),
                }),
              ],
              updated_at: now,
            };
          });

          await commitIfShadow(
            ctx.shadow,
            "review-refresh",
            found.slugs[0] || found._ulid.slice(0, 8),
          );

          output({ review_ulid: found._ulid, new_head: options.head }, () => {
            success(`Refreshed subject on review ${shortReviewRef(found, reviews)}`);
          });
        } catch (err) {
          if (err instanceof CommandExitError) throw err;
          error(errors.failures.refreshReview, err);
          process.exit(EXIT_CODES.ERROR);
        }
      }),
  );

  // --- review for-task ---
  // AC: @review-cli-task-linkage ac-1, ac-2
  review
    .command("for-task <ref>")
    .description("Find reviews linked to a task")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const reviews = await loadReviewRecords(ctx);
        const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
        const cleanRef = ref.startsWith("@") ? ref : `@${ref}`;
        const cleanRefNoAt = cleanRef.startsWith("@") ? cleanRef.slice(1) : cleanRef;

        // Find reviews by related_refs or subject ref
        const matches = reviews.filter(
          (r) =>
            r.related_refs.includes(cleanRef) ||
            (r.subject.type === "task" && r.subject.ref === cleanRef),
        );

        // AC: @review-cli-task-linkage ac-2 — also resolve via task's review_ref field
        const task = tasks.find(
          (t) =>
            t._ulid === cleanRefNoAt ||
            t._ulid.toLowerCase().startsWith(cleanRefNoAt.toLowerCase()) ||
            t.slugs.includes(cleanRefNoAt),
        );
        if (task?.review_ref) {
          const linkedReview = findReviewByRef(reviews, task.review_ref);
          if (linkedReview && !matches.some((m) => m._ulid === linkedReview._ulid)) {
            matches.push(linkedReview);
          }
        }

        if (matches.length === 0) {
          output({ reviews: [], total: 0, task_ref: cleanRef }, () => {
            info(`No reviews found for task ${cleanRef}`);
          });
          return;
        }

        const outputData = {
          reviews: matches.map((r) => ({
            _ulid: r._ulid,
            ref: `@${r.slugs[0] || r._ulid}`,
            title: r.title,
            lifecycle_state: r.lifecycle_state,
            disposition: computeDisposition(r),
            gate_state: computeGateState(r),
            created_at: r.created_at,
          })),
          total: matches.length,
          task_ref: cleanRef,
        };

        output(outputData, () => {
          console.log(`Reviews for ${cleanRef} (${matches.length}):`);
          for (const r of matches) {
            const shortRef = shortReviewRef(r, reviews);
            const disposition = computeDisposition(r);
            console.log(`  ${shortRef} ${r.lifecycle_state}/${disposition} ${r.title}`);
          }
        });
      } catch (err) {
        if (err instanceof CommandExitError) throw err;
        error(errors.failures.findReviewsForTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}

/**
 * Register `kspec review rebuild-index`. Validates that the lean index in
 * `.kspec/project.reviews.yaml` agrees with the per-review folders under
 * `.kspec/reviews/<ulid>/`. Exit codes and JSON envelope are defined by
 * @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
 * and @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders.
 *
 * Flag semantics:
 *   default       — validate, exit 1 on drift, never writes
 *   --dry-run     — same as default, never writes (explicit preview marker)
 *   --repair      — rewrite the lean index from folders
 *   --force       — only with --repair; permits dropping stale entries
 *                   whose folders are missing
 *   --json        — emits a structured envelope (status, summary, changes,
 *                   conflicts) and uses exit codes 0/1/2 per status
 */
function registerReviewRebuildIndexCommand(review: Command): void {
  markMutating(review.command("rebuild-index"))
    .description("Rebuild the review index from .kspec/reviews/<ulid>/ folders")
    .option("--repair", "Rewrite .kspec/project.reviews.yaml from review folders")
    .option("--force", "With --repair, drop stale index entries whose folders are missing")
    .option("--dry-run", "Report drift without writing — same as default")
    .addHelpText(
      "after",
      `
Exit codes:
  0  clean or repaired
  1  drift detected without --repair
  2  blocked by conflicts (e.g. stale entry without --force)

Examples:
  $ kspec review rebuild-index                  # validate, fail if drift
  $ kspec review rebuild-index --dry-run        # preview drift only
  $ kspec review rebuild-index --repair         # apply additive drift
  $ kspec review rebuild-index --repair --force # drop stale index entries`,
    )
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const isDryRun = Boolean(options.dryRun);
        const isRepair = Boolean(options.repair) && !isDryRun;
        const isForce = Boolean(options.force);

        if (isForce && !options.repair) {
          error("--force can only be used with --repair");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        const { computeReviewIndexDrift, rebuildReviewIndex, getReviewIndexFilePath } =
          await import("../../parser/review-storage-manager.js");

        const report = await computeReviewIndexDrift(ctx, { force: isForce });
        const driftCount = report.changes.length;
        const conflictCount = report.conflicts.length;

        const baseEnvelope = {
          domain: "reviews",
          dry_run: isDryRun,
          repair: isRepair,
          force: isForce,
          summary: {
            folders: report.folders,
            index_entries: report.indexEntries,
            added: report.added,
            updated: report.updated,
            removed_stale: report.removedStale,
            conflicts: conflictCount,
          },
          changes: report.changes.map((c) => ({
            kind: c.kind,
            ref: c.ref,
            path: c.path,
          })),
          conflicts: report.conflicts.map((c) => ({
            code: c.code,
            ref: c.ref,
            path: c.path,
            message: c.message,
          })),
        };

        // Blocked: conflicts that cannot be cleared by the current flag set.
        if (conflictCount > 0) {
          output({ ...baseEnvelope, status: "blocked" }, () => {
            warn(
              `${conflictCount} conflict(s) prevent index rebuild. ` +
                `Use --force with --repair where applicable.`,
            );
            for (const conflict of report.conflicts) {
              const refSuffix = conflict.ref ? ` (ref: ${conflict.ref})` : "";
              console.error(`  ${conflict.code}: ${conflict.message}${refSuffix}`);
            }
          });
          process.exit(2);
        }

        // Clean: no drift at all.
        if (driftCount === 0) {
          output({ ...baseEnvelope, status: "clean" }, () => {
            success(`Review index is up to date (${report.folders} folder(s))`);
          });
          return;
        }

        // Repair path — write the new index from folders.
        if (isRepair) {
          await rebuildReviewIndex(ctx, { force: isForce });
          await commitIfShadow(
            ctx.shadow,
            "review-rebuild-index",
            undefined,
            `${report.added} added, ${report.updated} updated, ${report.removedStale} stale dropped`,
          );
          output({ ...baseEnvelope, status: "repaired" }, () => {
            for (const change of report.changes) {
              console.log(`  ${change.kind}  ${change.ref}  (${change.path})`);
            }
            success(
              `Rebuilt review index from ${report.folders} folder(s): ` +
                `${report.added} added, ${report.updated} updated, ` +
                `${report.removedStale} stale dropped`,
            );
          });
          return;
        }

        // Drift detected but not repairing — print summary and exit 1.
        const indexPath = getReviewIndexFilePath(ctx);
        output({ ...baseEnvelope, status: "drift" }, () => {
          if (isDryRun) {
            warn("DRY RUN — no changes will be written");
          }
          for (const change of report.changes) {
            console.log(`  ${change.kind}  ${change.ref}  (${change.path})`);
          }
          info(
            `${driftCount} drift change(s) found. ` +
              `Re-run with --repair to rewrite ${indexPath}.`,
          );
        });
        process.exit(1);
      } catch (err) {
        error("Failed to rebuild review index", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
