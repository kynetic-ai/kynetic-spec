import chalk from "chalk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { markMutating } from "../command-annotations.js";
import {
  checkSlugUniqueness,
  createNote,
  createTodo,
  findReviewByRef,
  getAuthor,
  initContext,
  type LoadedSpecItem,
  type LoadedTask,
  loadAllItems,
  loadReviewRecords,
  ReferenceIndex,
  scanTestCoverage,
  syncSpecImplementationStatus,
  type KspecContext,
} from "../../parser/index.js";
import {
  resolveTaskDataManager,
  type ShadowCommitOptions,
  type TaskSummary,
} from "../../parser/task-data-manager.js";
import { commitIfShadow } from "../../parser/shadow.js";
import { AutomationStatusSchema, normalizeRefInput, TaskTypeSchema } from "../../schema/index.js";
import { ulidPattern } from "../../schema/common.js";
import type { AutomationStatus, Task, TaskInput } from "../../schema/index.js";
import { alignmentCheck, errors } from "../../strings/index.js";
import { formatCommitGuidance, printCommitGuidance } from "../../utils/commit.js";
import { captureSubmissionLinkage, getCurrentBranch, isGitRepo } from "../../utils/git.js";
import { executeBatchOperation, formatBatchOutput } from "../batch.js";
import {
  computeDispatchBranchName,
  findBranchOnRemote,
  gitCheckout,
  gitCheckoutNew,
  gitCreateBranchFrom,
  gitRefExists,
  reportBranchResult,
} from "../branch-helper.js";
import { EXIT_CODES } from "../exit-codes.js";
import { parseTagsArray } from "../parse-utils.js";
import {
  annotateNotesWithSuperseded,
  error,
  formatTaskDetails,
  info,
  showChangeDiff,
  warn,
  isJsonMode,
  output,
  success,
} from "../output.js";
import { parsePriority, validateEnumOption, validateSpecRef } from "../validators.js";
import { describeEnumValues } from "../enum-help.js";
import { addListOptions, listTasksAction } from "./tasks.js";
import { findClosestCommand } from "../suggest.js";
import { checkBudget, incrementBudget, isEndLoopRequested } from "../../sessions/store.js";
import { postDispatchEvent } from "../dispatch-events.js";

/**
 * Find a task by reference with detailed error reporting.
 * Uses ReferenceIndex for resolution and TaskDataManager to load full details.
 * Returns the task or exits with appropriate error.
 * AC: @task-data-manager ac-1 — callers don't know about storage format
 */
async function resolveTaskRef(
  ref: string,
  tasks: TaskSummary[],
  index: ReferenceIndex,
  ctx: import("../../parser/yaml.js").KspecContext,
): Promise<LoadedTask> {
  const result = index.resolve(ref);

  if (!result.ok) {
    switch (result.error) {
      case "not_found":
        error(errors.reference.taskNotFound(ref));
        break;
      case "ambiguous":
        error(errors.reference.ambiguous(ref));
        for (const candidate of result.candidates) {
          const task = tasks.find((t) => t._ulid === candidate);
          const slug = task?.slugs[0] || "";
          console.error(`  - ${index.shortUlid(candidate)} ${slug ? `(${slug})` : ""}`);
        }
        break;
      case "duplicate_slug":
        error(errors.reference.slugMapsToMultiple(ref));
        for (const candidate of result.candidates) {
          console.error(`  - ${index.shortUlid(candidate)}`);
        }
        break;
    }
    // AC: @cli-exit-codes ac-consistent-usage - NOT_FOUND for missing resources
    process.exit(EXIT_CODES.NOT_FOUND);
  }

  // Check if it's actually a task (not a spec item or meta item)
  const taskSummary = tasks.find((t) => t._ulid === result.ulid);
  if (!taskSummary) {
    error(errors.reference.notTask(ref));
    // AC: @cli-exit-codes ac-consistent-usage - NOT_FOUND for missing resources
    process.exit(EXIT_CODES.NOT_FOUND);
  }

  // Load full task details via the data manager
  // AC: @task-data-manager ac-3 — assembles complete task transparently
  return resolveTaskDataManager(ctx).getTask(ctx, result.ulid);
}

/**
 * Batch-compatible resolver that returns null instead of calling process.exit().
 * Resolves ref against the summary array to verify it's a task.
 * AC: @multi-ref-batch ac-4, ac-8 - Partial failure handling and ref resolution
 * AC: @task-data-manager ac-1 — callers don't know about storage format
 */
function resolveTaskRefForBatch(
  ref: string,
  tasks: TaskSummary[],
  index: ReferenceIndex,
): { task: TaskSummary | null; error?: string } {
  const result = index.resolve(ref);

  if (!result.ok) {
    let errorMsg: string;
    switch (result.error) {
      case "not_found":
        errorMsg = `Reference "${ref}" not found`;
        break;
      case "ambiguous":
        errorMsg = `Reference "${ref}" is ambiguous (matches ${result.candidates.length} items)`;
        break;
      case "duplicate_slug":
        errorMsg = `Slug "${ref}" maps to multiple items`;
        break;
    }
    return { task: null, error: errorMsg };
  }

  // Check if it's actually a task (not a spec item or meta item)
  const taskSummary = tasks.find((t) => t._ulid === result.ulid);
  if (!taskSummary) {
    return { task: null, error: `Reference "${ref}" is not a task` };
  }

  return { task: taskSummary };
}

function getTaskDisplayRef(task: Pick<LoadedTask, "_ulid" | "slugs">): string {
  return `@${task.slugs[0] || task._ulid}`;
}

function taskIdentityMatches(value: unknown, task: Pick<LoadedTask, "_ulid" | "slugs">): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const normalized = value.trim().replace(/^@/, "");
  return normalized === task._ulid || task.slugs.includes(normalized);
}

function metadataMatchesCurrentTaskAndCheckout(
  metadata: Record<string, unknown>,
  task: Pick<LoadedTask, "_ulid" | "slugs">,
  rootDir: string,
): boolean {
  const taskMatches =
    taskIdentityMatches(metadata.taskId, task) ||
    taskIdentityMatches(metadata.taskRef, task) ||
    taskIdentityMatches(metadata.taskSlug, task);
  if (!taskMatches) return false;

  const checkout = path.resolve(rootDir);
  const worktreeDirs = [metadata.workerWorktreeDir, metadata.reviewerWorktreeDir]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => path.resolve(value));
  return worktreeDirs.includes(checkout);
}

async function readMatchingWorkspaceIntegrationTarget(
  ctx: KspecContext,
  task: Pick<LoadedTask, "_ulid" | "slugs">,
): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(ctx.rootDir, ".kspec-dispatch-workspace.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!metadataMatchesCurrentTaskAndCheckout(parsed, task, ctx.rootDir)) {
      return null;
    }

    const target =
      typeof parsed.integrationTargetBranch === "string" && parsed.integrationTargetBranch.trim()
        ? parsed.integrationTargetBranch.trim()
        : typeof parsed.mergeTargetBranch === "string" && parsed.mergeTargetBranch.trim()
          ? parsed.mergeTargetBranch.trim()
          : null;
    return target;
  } catch {
    return null;
  }
}

function branchAvailableForSubmissionFallback(branch: string): boolean {
  return gitRefExists(`refs/heads/${branch}`) || findBranchOnRemote(branch) !== null;
}

async function resolvePlanBranchSubmissionFallback(
  ctx: KspecContext,
  task: Pick<LoadedTask, "plan_ref">,
): Promise<string | null> {
  const planRef = typeof task.plan_ref === "string" ? task.plan_ref.trim() : "";
  if (!planRef) return null;

  try {
    const { findPlanByRef } = await import("../../parser/plans.js");
    const plan = await findPlanByRef(ctx, planRef);
    const planBranch = typeof plan?.branch === "string" ? plan.branch.trim() : "";
    if (!planBranch) return null;
    return branchAvailableForSubmissionFallback(planBranch) ? planBranch : null;
  } catch {
    return null;
  }
}

async function resolveSubmissionLinkageFallbackUpstreamRef(
  ctx: KspecContext,
  task: Pick<LoadedTask, "_ulid" | "slugs" | "plan_ref">,
): Promise<string | null> {
  const workspaceTarget = await readMatchingWorkspaceIntegrationTarget(ctx, task);
  if (workspaceTarget) {
    return workspaceTarget;
  }

  const planBranch = await resolvePlanBranchSubmissionFallback(ctx, task);
  if (planBranch) {
    return planBranch;
  }

  return ctx.config?.dispatch?.base_branch?.trim() || null;
}

/**
 * Helper function to update task fields.
 * Used by both single-ref and batch modes of task set.
 * AC: @spec-task-set-batch ac-1, ac-2, ac-4, ac-5
 */
async function setTaskFields(
  foundTask: TaskSummary | LoadedTask,
  ctx: any,
  tasks: TaskSummary[],
  items: LoadedSpecItem[],
  _allMetaItems: any[],
  index: ReferenceIndex,
  options: any,
): Promise<{
  success: boolean;
  message?: string;
  error?: string;
  data?: unknown;
}> {
  try {
    // Check slug uniqueness if adding a new slug
    if (options.slug) {
      const slugCheck = checkSlugUniqueness(index, [options.slug], foundTask._ulid);
      if (!slugCheck.ok) {
        return {
          success: false,
          error: `Slug "${slugCheck.slug}" already exists on ${slugCheck.existingUlid}`,
        };
      }
    }

    const changes: Array<{ field: string; before: unknown; after: unknown }> = [];
    let noChangesMessage: string | undefined;

    if (options.specRef !== undefined) {
      // Handle 'null' string to clear spec_ref
      if (options.specRef !== "null") {
        // Validate the spec ref exists and is a spec item
        const specResult = index.resolve(options.specRef);
        if (!specResult.ok) {
          return {
            success: false,
            error: errors.reference.specRefNotFound(options.specRef),
          };
        }
        // Check it's not a task
        const isTask = tasks.some((t) => t._ulid === specResult.ulid);
        if (isTask) {
          return {
            success: false,
            error: errors.reference.specRefIsTask(options.specRef),
          };
        }
      }
    }

    if (options.metaRef !== undefined) {
      // Handle 'null' string to clear meta_ref
      if (options.metaRef !== "null") {
        // Validate the meta ref exists and is a meta item
        const metaRefResult = index.resolve(options.metaRef);
        if (!metaRefResult.ok) {
          return {
            success: false,
            error: errors.reference.metaRefNotFound(options.metaRef),
          };
        }

        // Check if the resolved item is a meta item (not a spec item or task)
        const isTask = tasks.some((t) => t._ulid === metaRefResult.ulid);
        const isSpecItem = items.some((i) => i._ulid === metaRefResult.ulid);

        if (isTask || isSpecItem) {
          return {
            success: false,
            error: errors.reference.metaRefPointsToSpec(options.metaRef),
          };
        }
      }
    }

    if (options.planRef !== undefined) {
      // Handle 'null' string to clear plan_ref
      if (options.planRef !== "null") {
        // First check if it's a task or spec item (wrong type)
        const cleanRef = options.planRef.startsWith("@")
          ? options.planRef.slice(1)
          : options.planRef;

        const isTask = tasks.some(
          (t) =>
            t.slugs.includes(cleanRef) ||
            t._ulid === cleanRef ||
            t._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()),
        );
        const isSpecItem = items.some(
          (i) =>
            i.slugs.includes(cleanRef) ||
            i._ulid === cleanRef ||
            i._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()),
        );

        if (isTask || isSpecItem) {
          return {
            success: false,
            error: `Reference "${options.planRef}" is not a plan`,
          };
        }

        // Now check if the plan exists
        const { findPlanByRef } = await import("../../parser/plans.js");
        const plan = await findPlanByRef(ctx, options.planRef);

        if (!plan) {
          return {
            success: false,
            error: `Plan reference not found: ${options.planRef}`,
          };
        }
      }
    }

    // Validate review URL if provided and not clearing
    if (options.reviewUrl !== undefined && options.reviewUrl !== "null") {
      try {
        // oxlint-disable-next-line no-new
        new URL(options.reviewUrl);
      } catch {
        return { success: false, error: `Invalid review URL: ${options.reviewUrl}` };
      }
    }

    let parsedPriority: number | undefined;
    if (options.priority) {
      const priorityResult = parsePriority(options.priority);
      if (!priorityResult.ok) {
        return { success: false, error: priorityResult.error };
      }
      parsedPriority = priorityResult.value;
    }

    const parsedTags = options.tag ? parseTagsArray(options.tag) : [];

    if (options.dependsOn) {
      // Validate all dependency refs
      for (const depRef of options.dependsOn) {
        const depResult = index.resolve(depRef);
        if (!depResult.ok) {
          return {
            success: false,
            error: errors.reference.depNotFound(depRef),
          };
        }
        // Ensure the dependency is a task, not a spec item
        const isTask = tasks.some((t) => t._ulid === depResult.ulid);
        if (!isTask) {
          return {
            success: false,
            error: `Reference "${depRef}" is not a task`,
          };
        }
      }
    }

    // AC: @task-automation-eligibility ac-5, ac-11, ac-12, ac-18
    // Handle automation status changes
    // Note: --no-automation sets options.automation to false, so check that first
    let validatedAutomation: AutomationStatus | undefined;
    if (options.automation !== undefined && options.automation !== false) {
      const automationResult = validateEnumOption(
        options.automation,
        AutomationStatusSchema.options,
        "automation status",
      );
      if (!automationResult.ok) {
        return { success: false, error: automationResult.error };
      }

      // AC: @task-automation-eligibility ac-18 - require reason for needs_review
      if (options.automation === "needs_review" && !options.reason) {
        return {
          success: false,
          error: "Setting automation to needs_review requires --reason flag explaining why",
        };
      }

      validatedAutomation = automationResult.value;
    }

    const setCommitOpts: ShadowCommitOptions = {
      operation: "task-set",
      ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
    };
    const submissionLinkageFallback =
      options.submissionLinkage && isGitRepo(ctx.rootDir)
        ? await resolveSubmissionLinkageFallbackUpstreamRef(
            ctx,
            await resolveTaskDataManager(ctx).getTask(ctx, foundTask._ulid),
          )
        : null;
    const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
      ctx,
      foundTask._ulid,
      (latestTask) => {
        const nextTask: Task = { ...latestTask };
        const mutationChanges: Array<{ field: string; before: unknown; after: unknown }> = [];

        if (options.title && options.title !== latestTask.title) {
          nextTask.title = options.title;
          mutationChanges.push({ field: "title", before: latestTask.title, after: options.title });
        }

        if (options.description !== undefined) {
          if (options.description === "null" || options.description.trim() === "") {
            if (latestTask.description !== undefined) {
              const before = latestTask.description;
              delete nextTask.description;
              mutationChanges.push({ field: "description", before, after: null });
            }
          } else if (options.description !== latestTask.description) {
            mutationChanges.push({
              field: "description",
              before: latestTask.description,
              after: options.description,
            });
            nextTask.description = options.description;
          }
        }

        if (options.specRef !== undefined) {
          if (options.specRef === "null") {
            if (latestTask.spec_ref != null) {
              mutationChanges.push({ field: "spec_ref", before: latestTask.spec_ref, after: null });
              nextTask.spec_ref = null;
            }
          } else {
            const newVal = normalizeRefInput(options.specRef);
            if (newVal !== latestTask.spec_ref) {
              mutationChanges.push({
                field: "spec_ref",
                before: latestTask.spec_ref,
                after: newVal,
              });
              nextTask.spec_ref = newVal;
            }
          }
        }

        if (options.metaRef !== undefined) {
          if (options.metaRef === "null") {
            if (latestTask.meta_ref != null) {
              mutationChanges.push({ field: "meta_ref", before: latestTask.meta_ref, after: null });
              nextTask.meta_ref = null;
            }
          } else {
            const newVal = normalizeRefInput(options.metaRef);
            if (newVal !== latestTask.meta_ref) {
              mutationChanges.push({
                field: "meta_ref",
                before: latestTask.meta_ref,
                after: newVal,
              });
              nextTask.meta_ref = newVal;
            }
          }
        }

        if (options.planRef !== undefined) {
          if (options.planRef === "null") {
            if (latestTask.plan_ref != null) {
              mutationChanges.push({ field: "plan_ref", before: latestTask.plan_ref, after: null });
              nextTask.plan_ref = null;
            }
          } else {
            const newVal = normalizeRefInput(options.planRef);
            if (newVal !== latestTask.plan_ref) {
              mutationChanges.push({
                field: "plan_ref",
                before: latestTask.plan_ref,
                after: newVal,
              });
              nextTask.plan_ref = newVal;
            }
          }
        }

        if (options.reviewUrl !== undefined) {
          if (options.reviewUrl === "null") {
            if (latestTask.review_url != null) {
              mutationChanges.push({
                field: "review_url",
                before: latestTask.review_url,
                after: null,
              });
              delete nextTask.review_url;
            }
          } else if (options.reviewUrl !== latestTask.review_url) {
            mutationChanges.push({
              field: "review_url",
              before: latestTask.review_url,
              after: options.reviewUrl,
            });
            nextTask.review_url = options.reviewUrl;
          }
        }

        if (parsedPriority !== undefined && parsedPriority !== latestTask.priority) {
          mutationChanges.push({
            field: "priority",
            before: latestTask.priority,
            after: parsedPriority,
          });
          nextTask.priority = parsedPriority;
        }

        if (options.slug && !nextTask.slugs.includes(options.slug)) {
          const before = [...latestTask.slugs];
          nextTask.slugs = [...nextTask.slugs, options.slug];
          mutationChanges.push({ field: "slugs", before, after: nextTask.slugs });
        }

        if (parsedTags.length > 0) {
          const newTags = parsedTags.filter((tag: string) => !nextTask.tags.includes(tag));
          if (newTags.length > 0) {
            const before = [...latestTask.tags];
            nextTask.tags = [...nextTask.tags, ...newTags];
            mutationChanges.push({ field: "tags", before, after: nextTask.tags });
          }
        }

        if (options.dependsOn) {
          const before = [...latestTask.depends_on];
          nextTask.depends_on = options.dependsOn.map(normalizeRefInput);
          mutationChanges.push({ field: "depends_on", before, after: nextTask.depends_on });
        }

        if (options.clearDeps) {
          if (latestTask.depends_on.length === 0) {
            // AC: @spec-task-clear-deps ac-2 - No changes needed
            noChangesMessage = "No changes: task has no dependencies to clear";
            return latestTask;
          }
          const before = [...latestTask.depends_on];
          nextTask.depends_on = [];
          mutationChanges.push({ field: "depends_on", before, after: [] });

          // AC: @task-set ac-author
          const note = createNote(
            `Dependencies cleared (was: ${latestTask.depends_on.join(", ")})`,
            getAuthor(ctx.config?.identity?.author),
          );
          nextTask.notes = [...nextTask.notes, note];
        }

        if (options.automation === false) {
          if (latestTask.automation != null) {
            mutationChanges.push({
              field: "automation",
              before: latestTask.automation,
              after: null,
            });
            delete nextTask.automation;
          }
        } else if (validatedAutomation && validatedAutomation !== latestTask.automation) {
          mutationChanges.push({
            field: "automation",
            before: latestTask.automation,
            after: validatedAutomation,
          });
          nextTask.automation = validatedAutomation;

          if (options.reason) {
            const note = createNote(
              `Automation status set to ${validatedAutomation}: ${options.reason}`,
              getAuthor(ctx.config?.identity?.author),
            );
            nextTask.notes = [...nextTask.notes, note];
          }
        }

        // AC: @portable-task-submission-linkage ac-4 — repair/backfill or clear submission linkage
        if (options.clearSubmissionLinkage) {
          if (latestTask.submission_linkage != null) {
            mutationChanges.push({
              field: "submission_linkage",
              before: latestTask.submission_linkage,
              after: null,
            });
            nextTask.submission_linkage = null;
          }
        } else if (options.submissionLinkage) {
          // AC: @portable-task-submission-linkage ac-worktree-branch — use rootDir
          // (active code checkout root) so worktree context captures the correct branch
          const linkage = isGitRepo(ctx.rootDir)
            ? captureSubmissionLinkage(
                ctx.rootDir,
                latestTask.review_url,
                submissionLinkageFallback,
              )
            : null;
          if (linkage) {
            mutationChanges.push({
              field: "submission_linkage",
              before: latestTask.submission_linkage,
              after: linkage,
            });
            nextTask.submission_linkage = linkage;
          }
        }

        changes.splice(0, changes.length, ...mutationChanges);
        // Set detail on commitOpts so TaskDataManager's shadow commit includes changed fields
        setCommitOpts.detail = mutationChanges.map((c) => c.field).join(", ");
        return nextTask;
      },
      setCommitOpts,
    );

    if (noChangesMessage) {
      return {
        success: true,
        message: noChangesMessage,
        data: { task: updatedTask },
      };
    }

    // AC: @spec-task-set-batch ac-4 - Warn on no changes, don't fail
    if (changes.length === 0) {
      return {
        success: true,
        message: "No changes specified",
        data: { task: updatedTask },
      };
    }

    const changedFields = changes.map((c) => c.field).join(", ");

    return {
      success: true,
      message: `Updated task: ${index.shortUlid(updatedTask._ulid)} (${changedFields})`,
      data: { task: updatedTask, changes },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Register the 'task' command group (singular - operations on individual tasks)
 */
export function registerTaskCommands(program: Command): void {
  const task = program
    .command("task")
    .description("Operations on individual tasks")
    .allowUnknownOption()
    .allowExcessArguments();

  // AC: @command-group-default-actions ac-bare-task, ac-unknown-subcommand
  // Default action when no subcommand is given (e.g. `kspec task` or `kspec task --status pending`)
  task.action(async (_options: Record<string, unknown>, cmd: Command) => {
    const { Command: Cmd } = await import("commander");
    const listCmd = addListOptions(new Cmd("_list"));
    listCmd.exitOverride();
    try {
      listCmd.parse(cmd.args, { from: "user" });
    } catch {
      console.error(chalk.gray(`Run 'kspec task --help' to see available subcommands`));
      process.exit(EXIT_CODES.ERROR);
    }

    // AC: @command-group-default-actions ac-unknown-subcommand
    if (listCmd.args.length > 0) {
      const unknownCmd = listCmd.args[0];
      const subcommandNames = cmd.commands.map((c: Command) => c.name());
      const suggestion = findClosestCommand(unknownCmd, subcommandNames);
      console.error(chalk.red(`error: unknown command 'task ${unknownCmd}'`));
      if (suggestion) {
        console.error(chalk.yellow(`Did you mean: kspec task ${suggestion}?`));
      } else {
        console.error(chalk.gray(`Run 'kspec task --help' to see available subcommands`));
      }
      process.exit(EXIT_CODES.ERROR);
    }

    // AC: @command-group-default-actions ac-bare-with-options
    await listTasksAction(listCmd.opts());
  });

  // kspec task list - alias for 'kspec tasks list'
  task
    .command("list")
    .description("List all tasks (alias for 'kspec tasks list')")
    .option("-s, --status <status>", "Filter by status")
    .option("-t, --type <type>", "Filter by type")
    .option("--tag <tag>", "Filter by tag")
    .option("--meta-ref <ref>", "Filter by meta reference")
    .option("-g, --grep <pattern>", "Search content with regex pattern")
    .option("-v, --verbose", "Show more details")
    .option("--full", "Show full details (notes, todos, timestamps)")
    .option("--count", "Show only the count of matching tasks")
    .action(async (options) => {
      await listTasksAction(options);
    });

  // kspec task get <ref>
  task
    .command("get <ref>")
    .description("Get task details")
    .option("--all", "Show all notes including superseded ones")
    .option("--activity", "Show full activity timeline")
    .action(async (ref: string, options: { all?: boolean; activity?: boolean }) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const _items = await loadAllItems(ctx);

        // Build all indexes including TraitIndex
        const { refIndex: index, traitIndex } = await (async () => {
          const { buildIndexes } = await import("../../parser/index.js");
          return buildIndexes(ctx);
        })();

        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        // AC: @trait-display ac-3 - task get shows inherited AC sections
        // Get inherited traits if task has spec_ref
        let inheritedTraits: Array<{
          trait: {
            ulid: string;
            slug: string;
            title: string;
            description?: string;
          };
          acs: Array<{
            id: string;
            given?: string;
            when?: string;
            then?: string;
          }>;
        }> = [];
        if (foundTask.spec_ref) {
          const specResult = index.resolve(foundTask.spec_ref);
          if (specResult.ok) {
            const specUlid = specResult.ulid;
            const inheritedAC = traitIndex.getInheritedAC(specUlid);
            const traitsByTrait = new Map<
              string,
              {
                trait: (typeof inheritedAC)[0]["trait"];
                acs: Array<{
                  id: string;
                  given?: string;
                  when?: string;
                  then?: string;
                }>;
              }
            >();
            for (const { trait, ac } of inheritedAC) {
              if (!traitsByTrait.has(trait.ulid)) {
                traitsByTrait.set(trait.ulid, { trait, acs: [] });
              }
              traitsByTrait.get(trait.ulid)?.acs.push(ac);
            }
            inheritedTraits = Array.from(traitsByTrait.values());
          }
        }

        // Load review records once — used for both active review display and activity timeline
        const allReviews = await loadReviewRecords(ctx);

        // AC: @review-cli-task-linkage ac-1 — resolve active review for task
        let activeReview: {
          ref: string;
          title: string;
          lifecycle_state: string;
          disposition: string;
        } | null = null;
        if (foundTask.review_ref) {
          const { computeDisposition } = await import("../../parser/index.js");
          const found = findReviewByRef(allReviews, foundTask.review_ref);
          if (found) {
            activeReview = {
              ref: `@${found.slugs[0] || found._ulid}`,
              title: found.title,
              lifecycle_state: found.lifecycle_state,
              disposition: computeDisposition(found),
            };
          }
        }

        // AC: @task-activity-in-file ac-1, ac-2, ac-3 — load activity timeline
        // AC: @task-activity-timeline ac-1, ac-2, ac-3 — load activity timeline
        let activity: import("../../utils/activity.js").ActivityEntry[] = [];
        try {
          const { assembleActivityFromFiles } = await import("../../utils/activity.js");

          // Primary: read history entries from task.yaml and notes from task record.
          // AC: @task-activity-in-file ac-1 — assembled from persisted data, no VCS queries
          const resolvedManager = resolveTaskDataManager(ctx);
          const historyEntries = await resolvedManager.getTaskHistory(ctx, foundTask._ulid);
          activity = assembleActivityFromFiles(historyEntries, foundTask.notes);

          // AC: @task-activity-timeline ac-3 — merge review events into timeline
          const taskRef = `@${foundTask.slugs[0] || foundTask._ulid}`;
          const linkedReviews = allReviews.filter(
            (r) =>
              r.related_refs.includes(taskRef) ||
              (r.subject.type === "task" && r.subject.ref === taskRef) ||
              r._ulid ===
                (foundTask.review_ref?.startsWith("@")
                  ? foundTask.review_ref.slice(1)
                  : foundTask.review_ref),
          );
          for (const review of linkedReviews) {
            const reviewRef = `@${review.slugs[0] || review._ulid}`;
            for (const event of review.events) {
              activity.push({
                type:
                  event.event_type === "verdict_submitted"
                    ? "submitted"
                    : event.event_type === "lifecycle_change"
                      ? "state_change"
                      : "review_linked",
                timestamp: event.timestamp,
                author: event.actor,
                summary: `Review ${reviewRef}: ${event.event_type.replace(/_/g, " ")}`,
                commitHash: "",
                source: "review",
              });
            }
          }

          // Re-sort chronologically (oldest first) after merging all sources
          activity.sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          );
        } catch {
          // Activity is best-effort — don't fail task get if activity assembly fails
        }

        // Resolve task resource_refs against owning entities so drift is
        // visible on every consumer surface (CLI text, --json, agent
        // context). The resolver is best-effort and returns an empty list
        // when the task has no resource_refs.
        // AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
        let projectedResources: ReturnType<
          typeof import("../../parser/task-resource-resolver.js").projectResolvedTaskResources
        > = [];
        if (foundTask.resource_refs && foundTask.resource_refs.length > 0) {
          const { resolveTaskResources, projectResolvedTaskResources } =
            await import("../../parser/task-resource-resolver.js");
          const resolved = await resolveTaskResources(ctx, foundTask);
          projectedResources = projectResolvedTaskResources(resolved);
        }

        // Build JSON output with inherited traits (AC: @trait-display ac-2)
        // Always include all notes in JSON output with superseded computed field
        // AC: @review-cli-task-linkage ac-1 — include resolved review summary in JSON
        // AC: @task-activity-timeline ac-4 — include activity in JSON output
        // AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible — include resolved resources
        const jsonOutput = {
          ...foundTask,
          notes: annotateNotesWithSuperseded(foundTask.notes),
          ...(activeReview && { active_review: activeReview }),
          ...(activity.length > 0 && { activity }),
          ...(projectedResources.length > 0 && { resolved_resources: projectedResources }),
          ...(inheritedTraits.length > 0 && {
            inherited_traits: inheritedTraits.map(({ trait, acs }) => ({
              ref: `@${trait.slug}`,
              title: trait.title,
              acceptance_criteria: acs,
            })),
          }),
        };

        output(jsonOutput, () => {
          formatTaskDetails(foundTask, index, {
            showAllNotes: options.all,
            activeReview,
            activity,
            showFullActivity: options.activity,
            resourceRefs: projectedResources,
          });

          // AC: @trait-display ac-3, ac-4, ac-5 - Show inherited AC per trait in labeled sections
          if (inheritedTraits.length > 0) {
            for (const { trait, acs } of inheritedTraits) {
              console.log(chalk.gray(`\n─── Inherited from @${trait.slug} ───`));
              for (const ac of acs) {
                console.log(chalk.cyan(`  [${ac.id}]`) + chalk.gray(` (from @${trait.slug})`));
                if (ac.given) console.log(`    Given: ${ac.given}`);
                if (ac.when) console.log(`    When: ${ac.when}`);
                if (ac.then) console.log(`    Then: ${ac.then}`);
              }
            }
          }
        });
      } catch (err) {
        error(errors.failures.getTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task add
  markMutating(task.command("add"))
    .description("Create a new task")
    .requiredOption("--title <title>", "Task title")
    .option("--description <description>", "Task description")
    .option("--type <type>", describeEnumValues("Task type", TaskTypeSchema.options), "task")
    .option("--spec-ref <ref>", "Reference to spec item")
    .option("--meta-ref <ref>", "Reference to meta item (workflow, agent, or convention)")
    .option("--plan-ref <ref>", "Reference to plan this task is derived from")
    .option("--priority <n>", "Priority (1-5 or P1-P5)", "3")
    .option("--slug <slug>", "Human-friendly slug")
    .option("--tag <tag...>", "Tags")
    .option("--depends-on <refs...>", "Set task dependencies")
    .option(
      "--automation <status>",
      describeEnumValues("Automation eligibility", AutomationStatusSchema.options),
    )
    .addHelpText(
      "after",
      `
Examples:
  $ kspec task add --title "Implement feature" --spec-ref @feature-spec
  $ kspec task add --title "Fix bug" --type bug --priority 1
  $ kspec task add --title "Multi-tag task" --tag cli urgent`,
    )
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);

        // Load meta items for validation
        const { loadMetaContext } = await import("../../parser/meta.js");
        const metaContext = await loadMetaContext(ctx);
        const allMetaItems = [
          ...metaContext.agents,
          ...metaContext.workflows,
          ...metaContext.conventions,
          ...metaContext.observations,
        ];

        // Build index for reference validation
        const refIndex = new ReferenceIndex(tasks as unknown as LoadedTask[], items, allMetaItems);

        // Check slug uniqueness if provided
        if (options.slug) {
          const slugCheck = checkSlugUniqueness(refIndex, [options.slug]);
          if (!slugCheck.ok) {
            error(errors.slug.alreadyExists(slugCheck.slug, slugCheck.existingUlid));
            process.exit(EXIT_CODES.CONFLICT);
          }
        }

        // Validate meta_ref if provided (AC-meta-ref-3, AC-meta-ref-4)
        if (options.metaRef) {
          const metaRefResult = refIndex.resolve(options.metaRef);

          if (!metaRefResult.ok) {
            error(errors.reference.metaRefNotFound(options.metaRef));
            process.exit(EXIT_CODES.NOT_FOUND);
          }

          // Check if the resolved item is a meta item (not a spec item or task)
          const isTask = tasks.some((t) => t._ulid === metaRefResult.ulid);
          const isSpecItem = items.some((i) => i._ulid === metaRefResult.ulid);

          if (isTask || isSpecItem) {
            error(errors.reference.metaRefPointsToSpec(options.metaRef));
            process.exit(EXIT_CODES.NOT_FOUND);
          }
        }

        // Validate spec_ref if provided — must point to a spec item, not a task or meta item
        if (options.specRef) {
          const specRefResult = validateSpecRef(
            options.specRef,
            refIndex,
            tasks as unknown as LoadedTask[],
            items,
          );
          if (!specRefResult.ok) {
            error(specRefResult.error);
            process.exit(EXIT_CODES.NOT_FOUND);
          }
        }

        // AC: @task-automation-eligibility ac-13 - validate automation if provided
        let automationValue: AutomationStatus | undefined;
        if (options.automation) {
          const automationResult = validateEnumOption(
            options.automation,
            AutomationStatusSchema.options,
            "automation status",
          );
          if (!automationResult.ok) {
            error(automationResult.error);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          automationValue = automationResult.value;
        }

        // Validate plan_ref if provided (AC: @plan-derive-enhanced ac-task-refs, ac-bidirectional-links)
        if (options.planRef) {
          // First check if it's a task or spec item (wrong type)
          const cleanRef = options.planRef.startsWith("@")
            ? options.planRef.slice(1)
            : options.planRef;

          const isTask = tasks.some(
            (t) =>
              t.slugs.includes(cleanRef) ||
              t._ulid === cleanRef ||
              t._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()),
          );
          const isSpecItem = items.some(
            (i) =>
              i.slugs.includes(cleanRef) ||
              i._ulid === cleanRef ||
              i._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()),
          );

          if (isTask || isSpecItem) {
            error(`Reference "${options.planRef}" is not a plan`);
            process.exit(EXIT_CODES.NOT_FOUND);
          }

          // Now check if the plan exists
          const { findPlanByRef } = await import("../../parser/plans.js");
          const plan = await findPlanByRef(ctx, options.planRef);

          if (!plan) {
            error(`Plan reference not found: ${options.planRef}`);
            process.exit(EXIT_CODES.NOT_FOUND);
          }
        }

        // AC: @task-add-depends-on ac-2 - Validate dependency refs
        if (options.dependsOn) {
          for (const depRef of options.dependsOn) {
            const depResult = refIndex.resolve(depRef);
            if (!depResult.ok) {
              error(errors.reference.depNotFound(depRef));
              process.exit(EXIT_CODES.NOT_FOUND);
            }
            // Ensure the dependency is a task, not a spec item
            const isTask = tasks.some((t) => t._ulid === depResult.ulid);
            if (!isTask) {
              error(`Reference "${depRef}" is not a task`);
              process.exit(EXIT_CODES.NOT_FOUND);
            }
          }
        }

        // Validate priority
        const priorityResult = parsePriority(options.priority);
        if (!priorityResult.ok) {
          error(priorityResult.error);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        const taskTypeResult = validateEnumOption(
          options.type || "task",
          TaskTypeSchema.options,
          "task type",
        );
        if (!taskTypeResult.ok) {
          error(taskTypeResult.error);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // AC: @spec-task-add-description ac-6 - Omit description if empty string
        const descriptionValue =
          options.description && options.description.trim() !== ""
            ? options.description
            : undefined;

        const input: TaskInput = {
          title: options.title,
          description: descriptionValue,
          type: taskTypeResult.value,
          spec_ref: options.specRef ? normalizeRefInput(options.specRef) : null,
          meta_ref: options.metaRef ? normalizeRefInput(options.metaRef) : null,
          plan_ref: options.planRef ? normalizeRefInput(options.planRef) : null,
          priority: priorityResult.value,
          slugs: options.slug ? [options.slug] : [],
          tags: parseTagsArray(options.tag),
          depends_on: (options.dependsOn || []).map(normalizeRefInput),
          automation: automationValue,
        };

        // AC: @task-data-manager ac-1, ac-4 — create via task data manager
        const newTask = await resolveTaskDataManager(ctx).createTask(ctx, input, {
          operation: "task-add",
          ref: input.slugs?.[0] || undefined,
          detail: input.title,
        });

        // Build index including the new task for accurate short ULID
        const index = new ReferenceIndex(
          [...tasks, newTask] as unknown as LoadedTask[],
          items,
          allMetaItems,
        );
        success(`Created task: ${index.shortUlid(newTask._ulid)}`, {
          task: newTask,
        });
      } catch (err) {
        error(errors.failures.createTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task set <ref>
  markMutating(task.command("set [ref]"))
    .description("Update task fields")
    .option("--refs <refs...>", "Update multiple tasks (AC: @spec-task-set-batch ac-1)")
    .option("--title <title>", "Update task title")
    .option("--description <description>", "Update task description (use 'null' to clear)")
    .option("--spec-ref <ref>", "Link to spec item (use 'null' to clear)")
    .option("--meta-ref <ref>", "Link to meta item (use 'null' to clear)")
    .option("--plan-ref <ref>", "Link to plan (use 'null' to clear)")
    .option("--review-url <url>", "Set review URL (use 'null' to clear)")
    .option("--priority <n>", "Set priority (1-5 or P1-P5)")
    .option("--slug <slug>", "Add a slug alias")
    .option("--tag <tag...>", "Add tags")
    .option("--depends-on <refs...>", "Set dependencies (replaces existing)")
    .option("--clear-deps", "Clear all dependencies")
    .option(
      "--automation <status>",
      describeEnumValues("Set automation eligibility", AutomationStatusSchema.options),
    )
    .option("--no-automation", "Clear automation status (return to unassessed)")
    .option("--reason <reason>", "Reason for status change (required when setting needs_review)")
    .option("--status <status>", "Reject with error - use state transition commands instead")
    .option(
      "--submission-linkage",
      "Repair/backfill submission linkage from current git context (AC: @portable-task-submission-linkage ac-4)",
    )
    .option(
      "--clear-submission-linkage",
      "Clear submission linkage (AC: @portable-task-submission-linkage ac-4)",
    )
    .addHelpText(
      "after",
      `
Examples:
  $ kspec task set @task-slug --priority 2
  $ kspec task set @task-slug --description "Updated context"
  $ kspec task set @task-slug --depends-on @dep1 @dep2
  $ kspec task set @task-slug --tag cli urgent
  $ kspec task set @task-slug --submission-linkage  # capture current git context
  $ kspec task set --refs @task1 @task2 --priority 3`,
    )
    .action(async (ref: string | undefined, options) => {
      try {
        // AC: @spec-task-clear-deps ac-3 - Mutual exclusivity check
        if (options.clearDeps && options.dependsOn) {
          error("Cannot use --clear-deps and --depends-on together");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);

        // Load meta items for validation
        const { loadMetaContext } = await import("../../parser/meta.js");
        const metaContext = await loadMetaContext(ctx);
        const allMetaItems = [
          ...metaContext.agents,
          ...metaContext.workflows,
          ...metaContext.conventions,
          ...metaContext.observations,
        ];

        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items, allMetaItems);

        // AC: @task-set ac-1, @trait-error-guidance ac-1, ac-2, ac-4
        // Reject --status flag with context-aware error message
        if (options.status !== undefined) {
          let currentStatus: import("../../schema/common.js").TaskStatus | undefined;
          let priorStatus: import("../../schema/common.js").TaskStatus | null | undefined;

          // Try to resolve the task to get current status for a better error message
          if (ref) {
            try {
              const foundTask = await resolveTaskRef(ref, tasks, index, ctx);
              currentStatus = foundTask.status;
              priorStatus = foundTask.prior_status;
            } catch {
              // Task resolution failed - still show the error, just without current status
            }
          }

          const rejection = errors.status.statusSetRejection(
            options.status as string,
            currentStatus,
            priorStatus,
          );
          error(rejection.message, isJsonMode() ? rejection.details : rejection.details.guidance);
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // AC: @trait-multi-ref-batch ac-8 - Deduplicate refs
        const refsFlag = options.refs ? [...new Set(options.refs as string[])] : undefined;

        // Batch mode or single mode?
        if (refsFlag && refsFlag.length > 0) {
          // Batch mode - AC: @spec-task-set-batch ac-1, ac-2, ac-5
          const result = await executeBatchOperation({
            positionalRef: ref,
            refsFlag,
            context: { ctx, tasks, items, allMetaItems, index, options },
            items: tasks,
            index,
            resolveRef: (refStr: string, taskList: TaskSummary[], idx: ReferenceIndex) => {
              const result = resolveTaskRefForBatch(refStr, taskList, idx);
              return { item: result.task, error: result.error };
            },
            executeOperation: async (task: TaskSummary, context) => {
              return await setTaskFields(
                task,
                context.ctx,
                context.tasks,
                context.items,
                context.allMetaItems,
                context.index,
                context.options,
              );
            },
            getUlid: (task: TaskSummary) => task._ulid,
          });

          formatBatchOutput(result, "Set");
        } else {
          // Single mode - existing behavior
          if (!ref) {
            error("Either provide a positional ref or use --refs flag");
            process.exit(EXIT_CODES.USAGE_ERROR);
          }

          const foundTask = await resolveTaskRef(ref, tasks, index, ctx);
          const result = await setTaskFields(
            foundTask,
            ctx,
            tasks,
            items,
            allMetaItems,
            index,
            options,
          );

          if (!result.success) {
            error(result.error || "Failed to update task");
            process.exit(EXIT_CODES.ERROR);
          }

          if (result.message) {
            // AC: @spec-task-set-batch ac-4 - Warn on no changes
            if (result.message.includes("No changes")) {
              if (isJsonMode()) {
                output({ success: true, message: result.message });
              } else {
                warn(result.message);
              }
            } else {
              success(result.message, result.data as Record<string, unknown> | undefined);

              // Show before→after diff in text mode
              const data = result.data as
                | { changes?: Array<{ field: string; before: unknown; after: unknown }> }
                | undefined;
              if (data?.changes) {
                showChangeDiff(data.changes);
              }
            }
          }
        }
      } catch (err) {
        error(errors.failures.updateTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task patch <ref>
  markMutating(task.command("patch <ref>"))
    .description("Update task with JSON data")
    .option("--data <json>", "JSON object with fields to update")
    .option("--dry-run", "Show what would change without writing")
    .option("--allow-unknown", "Allow unknown fields (for extending format)")
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);

        // Load meta items for validation
        const { loadMetaContext } = await import("../../parser/meta.js");
        const metaContext = await loadMetaContext(ctx);
        const allMetaItems = [
          ...metaContext.agents,
          ...metaContext.workflows,
          ...metaContext.conventions,
          ...metaContext.observations,
        ];

        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items, allMetaItems);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        // Get JSON data from --data flag or stdin
        let jsonData: string;
        if (options.data) {
          jsonData = options.data;
        } else {
          const isTTY =
            process.env.KSPEC_TEST_TTY === "1" ||
            process.env.KSPEC_TEST_TTY === "true" ||
            process.stdin.isTTY;
          if (isTTY) {
            error(errors.validation.noPatchData);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }

          // Read from stdin
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk);
          }
          jsonData = Buffer.concat(chunks).toString("utf-8");
          if (!jsonData.trim()) {
            error(errors.validation.noPatchData);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
        }

        // Parse JSON
        let patchData: Record<string, unknown>;
        try {
          patchData = JSON.parse(jsonData);
        } catch (parseErr) {
          error(errors.validation.invalidJson, parseErr);
          process.exit(EXIT_CODES.ERROR);
        }

        // Validate against TaskInputSchema (partial)
        const { TaskInputSchema } = await import("../../schema/index.js");

        // Create a partial schema for validation
        const partialSchema = options.allowUnknown
          ? TaskInputSchema.partial().passthrough()
          : TaskInputSchema.partial().strict();

        let validatedPatch: Partial<TaskInput>;
        try {
          validatedPatch = partialSchema.parse(patchData);
        } catch (validationErr) {
          error(errors.validation.invalidPatchData(String(validationErr)), validationErr);
          process.exit(EXIT_CODES.ERROR);
        }

        // Check for unknown fields if strict mode
        if (!options.allowUnknown) {
          const knownFields = Object.keys(TaskInputSchema.shape);
          const providedFields = Object.keys(patchData);
          const unknownFields = providedFields.filter((f) => !knownFields.includes(f));

          if (unknownFields.length > 0) {
            error(errors.validation.unknownFields(unknownFields));
            process.exit(EXIT_CODES.ERROR);
          }
        }

        // Track changes for output
        const changes = Object.keys(validatedPatch);

        if (options.dryRun) {
          const dryRunTask: Task = { ...foundTask, ...validatedPatch };
          info("Dry run - no changes will be written");
          info(`Would update: ${changes.join(", ")}`);
          output({ changes, updated: dryRunTask }, () => {
            console.log(`\nChanges: ${changes.join(", ")}\n`);
            return formatTaskDetails(dryRunTask, index);
          });
          return;
        }

        // AC: @task-data-manager ac-1, ac-4 — mutate via task data manager
        const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
          ctx,
          foundTask._ulid,
          (latestTask) => ({
            ...latestTask,
            ...validatedPatch,
          }),
          {
            operation: "task-patch",
            ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
            detail: changes.join(", "),
          },
        );
        success(`Patched task: ${index.shortUlid(updatedTask._ulid)} (${changes.join(", ")})`, {
          task: updatedTask,
        });
      } catch (err) {
        error(errors.failures.patchTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task start <ref>
  markMutating(task.command("start <ref>"))
    .description("Start working on a task (pending|needs_work -> in_progress)")
    .option("--no-sync", "Skip syncing spec implementation status")
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        if (foundTask.status === "in_progress") {
          warn("Task is already in progress");
          output(foundTask, () => formatTaskDetails(foundTask));
          return;
        }

        if (foundTask.status !== "pending" && foundTask.status !== "needs_work") {
          error(errors.status.cannotStart(foundTask.status));
          process.exit(EXIT_CODES.VALIDATION_FAILED); // Exit code 4 = invalid state
        }

        // AC: @session-scoped-task-claiming ac-startable - warn if claimed by another session
        const sessionId = process.env.KSPEC_SESSION_ID || null;
        if (foundTask.session_id && sessionId && foundTask.session_id !== sessionId) {
          warn(`Task was claimed by session ${foundTask.session_id.slice(0, 8)}...`);
        }

        // AC: @session-end-loop-signal ac-block-task - Block if end-loop requested
        if (sessionId) {
          const endLoopState = await isEndLoopRequested(ctx.sessionsDir, sessionId);
          if (endLoopState?.requested) {
            error(
              `Cannot start task: loop is ending for session ${sessionId.slice(0, 8)}...${endLoopState.reason ? ` Reason: ${endLoopState.reason}` : ""}`,
            );
            info(
              "The current session has been signaled to end. Wrap up current work instead of starting new tasks.",
            );
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
        }

        // AC: @task-budget-enforcement ac-block-start, ac-no-session, ac-no-budget, ac-needs-work-no-increment
        // Check budget before starting — only when session is set.
        // Skip budget check for needs_work→in_progress (fix cycles): the task
        // already consumed a budget slot when originally started; blocking it
        // would prevent completing already-assigned work.
        if (foundTask.status !== "needs_work") {
          const budgetCheck = await checkBudget(ctx.sessionsDir, sessionId || undefined);
          if (!budgetCheck.allowed) {
            error(budgetCheck.reason!);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
        }

        // Update status
        // AC: @session-scoped-task-claiming ac-stamp, ac-no-env
        // AC: @task-data-manager ac-1, ac-4 — mutate via task data manager
        let transitionFromStatus: Task["status"] = foundTask.status;
        const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
          ctx,
          foundTask._ulid,
          (latestTask) => {
            transitionFromStatus = latestTask.status;
            return {
              ...latestTask,
              status: "in_progress",
              started_at: new Date().toISOString(),
              ...(sessionId ? { session_id: sessionId } : {}),
            };
          },
          {
            operation: "task-start",
            ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
          },
        );

        // AC: @task-budget-enforcement ac-increment, ac-resume-no-increment, ac-needs-work-no-increment
        // Increment budget counter after successful start, but only for
        // genuine pending→in_progress transitions. Resume case returns early
        // above. needs_work→in_progress is a fix cycle (task already consumed
        // a budget slot when originally started) — don't double-count it.
        if (sessionId && transitionFromStatus === "pending") {
          await incrementBudget(ctx.sessionsDir, sessionId);
        }

        // AC: @daemon-agent-dispatch ac-2, ac-7 - Notify daemon of state change (fire-and-forget)
        postDispatchEvent({
          taskId: updatedTask._ulid,
          taskRef: `@${updatedTask.slugs[0] || updatedTask._ulid}`,
          fromStatus: transitionFromStatus,
          toStatus: updatedTask.status,
          projectPath: ctx.projectRoot,
        });

        success(`Started task: ${index.shortUlid(updatedTask._ulid)}`, {
          task: updatedTask,
        });

        // Show spec context and AC guidance (suppressed in JSON mode)
        if (!isJsonMode() && foundTask.spec_ref) {
          const specResult = index.resolve(foundTask.spec_ref);
          if (specResult.ok) {
            const specItem = items.find((i) => i._ulid === specResult.ulid);
            if (specItem) {
              console.log("");
              console.log("--- Spec Context ---");
              console.log(`Implementing: ${specItem.title}`);
              if (specItem.description) {
                console.log(`\n${specItem.description}`);
              }

              if (specItem.acceptance_criteria && specItem.acceptance_criteria.length > 0) {
                console.log(`\nAcceptance Criteria (${specItem.acceptance_criteria.length}):`);
                for (const ac of specItem.acceptance_criteria) {
                  console.log(`  [${ac.id}]`);
                  console.log(`    Given: ${ac.given}`);
                  console.log(`    When: ${ac.when}`);
                  console.log(`    Then: ${ac.then}`);
                }
                console.log("");
                console.log(
                  "Remember: Add test coverage for each AC and mark tests with // AC: @spec-ref ac-N",
                );
              }
              console.log("");
            }
          }
        }

        // Sync spec implementation status (unless --no-sync)
        if (options.sync !== false && foundTask.spec_ref) {
          const updatedTasks = tasks.map((t) =>
            t._ulid === updatedTask._ulid ? { ...t, ...updatedTask } : t,
          );
          const syncResult = await syncSpecImplementationStatus(
            ctx,
            updatedTask,
            updatedTasks,
            items,
            index,
          );
          if (syncResult) {
            info(
              `Synced spec "${syncResult.specTitle}" implementation: ${syncResult.previousStatus} -> ${syncResult.newStatus}`,
            );
            // Commit the spec status change
            await commitIfShadow(
              ctx.shadow,
              "spec-sync",
              syncResult.specUlid.slice(0, 8),
              `${syncResult.previousStatus} -> ${syncResult.newStatus}`,
            );
          }
        }
      } catch (err) {
        error(errors.failures.startTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task complete <ref> | --refs <refs...>
  // AC: @multi-ref-batch ac-1 - Basic multi-ref syntax
  // AC: @multi-ref-batch ac-2 - Backward compatibility
  markMutating(task.command("complete [ref]"))
    .description("Complete a task (pending_review -> completed)")
    .option("--refs <refs...>", "Complete multiple tasks by ref")
    .option("--reason <reason>", "Completion reason/notes")
    .option("--skip-review", "Skip review requirement (requires --reason)")
    .option("--force", "Force completion from any state (bypasses submit requirement)")
    .option("--no-sync", "Skip syncing spec implementation status")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec task complete @task-slug --reason "Merged in PR #123"
  $ kspec task complete @task-slug --force --reason "Design task, no code to review"
  $ kspec task complete --refs @task1 @task2 --reason "Batch completion"`,
    )
    .action(async (ref: string | undefined, options) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);

        // AC: @spec-completion-enforcement ac-8
        if (options.skipReview && !options.reason) {
          error(errors.status.skipReviewRequiresReason);
          process.exit(EXIT_CODES.ERROR);
        }

        // AC: @multi-ref-batch ac-1, ac-2, ac-3, ac-4
        const result = await executeBatchOperation({
          positionalRef: ref,
          refsFlag: options.refs,
          context: { ctx, tasks, items, index, options },
          items: tasks,
          index,
          resolveRef: (refStr, taskList, idx) => {
            const resolved = resolveTaskRefForBatch(refStr, taskList, idx);
            return { item: resolved.task, error: resolved.error };
          },
          executeOperation: async (foundTask, { ctx, tasks, items, index, options }) => {
            try {
              const forcingCompletion = options.force;
              const now = new Date().toISOString();
              let transitionFromStatus: Task["status"] = foundTask.status as Task["status"];
              let forcedFromNonStandard = false;
              let forceStateDetail: string | undefined;
              // AC: @task-data-manager ac-1, ac-4 — mutate via task data manager
              const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
                ctx,
                foundTask._ulid,
                (latestTask) => {
                  transitionFromStatus = latestTask.status;

                  // AC: @spec-completion-enforcement ac-6
                  if (latestTask.status === "completed") {
                    throw new Error(errors.status.completeAlreadyCompleted);
                  }

                  // AC: @spec-completion-enforcement ac-7 - Allow skip-review bypass
                  if (!options.skipReview && !forcingCompletion) {
                    // AC: @spec-completion-enforcement ac-2
                    if (latestTask.status === "in_progress") {
                      throw new Error(errors.status.completeRequiresReview);
                    }

                    // AC: @spec-completion-enforcement ac-3
                    if (latestTask.status === "pending") {
                      throw new Error(errors.status.completeRequiresStart);
                    }

                    // AC: @spec-completion-enforcement ac-4
                    if (latestTask.status === "blocked") {
                      throw new Error(errors.status.completeBlockedTask);
                    }

                    // AC: @spec-completion-enforcement ac-5
                    if (latestTask.status === "cancelled") {
                      throw new Error(errors.status.completeCancelledTask);
                    }

                    // AC: @spec-completion-enforcement ac-1 - Only pending_review allowed
                    if (latestTask.status !== "pending_review") {
                      throw new Error(errors.status.cannotComplete(latestTask.status));
                    }
                  }

                  // AC: @spec-completion-enforcement ac-7 - Document skip-review reason
                  // AC: @spec-completion-enforcement ac-author
                  let taskNotes = latestTask.notes;
                  if (options.skipReview && options.reason) {
                    const skipNote = createNote(
                      `Completed with --skip-review: ${options.reason}`,
                      getAuthor(ctx.config?.identity?.author),
                    );
                    taskNotes = [...taskNotes, skipNote];
                  }

                  // AC: @task-commands ac-1 - Document force completion from non-standard state
                  forcedFromNonStandard =
                    forcingCompletion && latestTask.status !== "pending_review";
                  if (forcedFromNonStandard) {
                    forceStateDetail = `from ${latestTask.status} state`;
                    if (latestTask.status === "blocked") {
                      const blockedBy = latestTask.blocked_by.join("; ");
                      forceStateDetail += `. Was blocked by: ${blockedBy || "(dependency-blocked)"}`;
                    }
                    let forceMessage = `Completed with --force ${forceStateDetail}`;
                    if (options.reason) {
                      forceMessage += `. Reason: ${options.reason}`;
                    }
                    const forceNote = createNote(
                      forceMessage,
                      getAuthor(ctx.config?.identity?.author),
                    );
                    taskNotes = [...taskNotes, forceNote];
                  }

                  return {
                    ...latestTask,
                    status: "completed",
                    completed_at: now,
                    closed_reason: options.reason || null,
                    started_at: latestTask.started_at || now,
                    notes: taskNotes,
                  };
                },
                {
                  operation: "task-complete",
                  ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
                  detail: options.reason,
                },
              );

              // AC: @daemon-agent-dispatch ac-2, ac-7 - Notify daemon of state change (fire-and-forget)
              postDispatchEvent({
                taskId: updatedTask._ulid,
                taskRef: `@${updatedTask.slugs[0] || updatedTask._ulid}`,
                fromStatus: transitionFromStatus,
                toStatus: updatedTask.status,
                projectPath: ctx.projectRoot,
              });

              // Sync spec implementation status (unless --no-sync)
              if (options.sync !== false && foundTask.spec_ref) {
                const updatedTasks = tasks.map((t) =>
                  t._ulid === updatedTask._ulid ? { ...t, ...updatedTask } : t,
                );
                const syncResult = await syncSpecImplementationStatus(
                  ctx,
                  updatedTask,
                  updatedTasks,
                  items,
                  index,
                );
                if (syncResult && !isJsonMode()) {
                  info(
                    `Synced spec "${syncResult.specTitle}" implementation: ${syncResult.previousStatus} -> ${syncResult.newStatus}`,
                  );
                  await commitIfShadow(
                    ctx.shadow,
                    "spec-sync",
                    syncResult.specUlid.slice(0, 8),
                    `${syncResult.previousStatus} -> ${syncResult.newStatus}`,
                  );
                }
              }

              // Show AC reminder for single-ref mode only (not in batch)
              if (!options.refs && foundTask.spec_ref && !isJsonMode()) {
                const specResult = index.resolve(foundTask.spec_ref);
                if (specResult.ok && specResult.item) {
                  const specItem = items.find((i) => i._ulid === specResult.ulid);
                  if (specItem?.acceptance_criteria && specItem.acceptance_criteria.length > 0) {
                    const count = specItem.acceptance_criteria.length;
                    console.log(
                      `\n⚠ Linked spec ${foundTask.spec_ref} has ${count} acceptance criteri${count === 1 ? "on" : "a"} - verify they are covered\n`,
                    );
                  }
                }
              }

              // AC: @task-commands ac-1 - Show warning when force-completing from non-standard state
              let warningMsg: string | undefined;
              if (forcedFromNonStandard) {
                warningMsg = `Task was force-completed ${forceStateDetail}`;
                if (!isJsonMode()) {
                  warn(warningMsg);
                }
              }

              return {
                success: true,
                message: `Completed task: ${index.shortUlid(updatedTask._ulid)}`,
                data: updatedTask,
                ...(warningMsg && { warning: warningMsg }),
              };
            } catch (err) {
              return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          },
          getUlid: (task) => task._ulid,
        });

        // AC: @multi-ref-batch ac-5, ac-6
        formatBatchOutput(result, "Complete");

        // Show commit guidance for single-ref mode only
        if (!options.refs && result.success && result.results.length === 1 && !isJsonMode()) {
          const taskData = result.results[0].data as Task | undefined;
          if (taskData) {
            const guidance = formatCommitGuidance(taskData);
            printCommitGuidance(guidance);
          }
        }
      } catch (err) {
        error(errors.failures.completeTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task submit <ref>
  // Transitions in_progress → pending_review (code done, awaiting merge)
  // AC: @task-submit ac-submit-1, ac-submit-2, ac-submit-3
  markMutating(task.command("submit <ref>"))
    .description("Submit task for review (transitions to pending_review)")
    .option("--review-url <url>", "PR or review URL")
    .action(async (ref: string, options: { reviewUrl?: string }) => {
      try {
        // AC: @task-submit ac-submit-3 - Validate URL before any state change
        if (options.reviewUrl !== undefined) {
          try {
            // oxlint-disable-next-line no-new
            new URL(options.reviewUrl);
          } catch {
            error(`Invalid review URL: ${options.reviewUrl}`);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
        }

        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        // AC: @portable-task-submission-linkage ac-1, ac-3, ac-5, ac-worktree-branch — capture git context
        // Use rootDir (active code checkout root) so worktree context captures the correct branch
        const submissionLinkageFallback = isGitRepo(ctx.rootDir)
          ? await resolveSubmissionLinkageFallbackUpstreamRef(ctx, foundTask)
          : null;
        const linkage = isGitRepo(ctx.rootDir)
          ? captureSubmissionLinkage(ctx.rootDir, options.reviewUrl, submissionLinkageFallback)
          : null;

        // AC: @task-data-manager ac-1, ac-4 — mutate via task data manager
        let transitionFromStatus: Task["status"] = foundTask.status;
        const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
          ctx,
          foundTask._ulid,
          (latestTask) => {
            transitionFromStatus = latestTask.status;
            if (latestTask.status !== "in_progress") {
              return latestTask;
            }

            return {
              ...latestTask,
              status: "pending_review",
              submitted_at: new Date().toISOString(),
              // AC: @task-submit ac-submit-2
              ...(options.reviewUrl !== undefined && { review_url: options.reviewUrl }),
              // AC: @portable-task-submission-linkage ac-1
              ...(linkage && { submission_linkage: linkage }),
            };
          },
          {
            operation: "task-submit",
            ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
          },
        );

        if (transitionFromStatus !== "in_progress") {
          error(
            `Cannot submit task with status: ${transitionFromStatus}. Task must be in_progress.`,
          );
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // AC: @daemon-agent-dispatch ac-2, ac-7 - Notify daemon of state change (fire-and-forget)
        postDispatchEvent({
          taskId: updatedTask._ulid,
          taskRef: `@${updatedTask.slugs[0] || updatedTask._ulid}`,
          fromStatus: transitionFromStatus,
          toStatus: updatedTask.status,
          projectPath: ctx.projectRoot,
        });

        success(`Submitted task for review: ${index.shortUlid(updatedTask._ulid)}`, {
          task: updatedTask,
        });

        // AC: @portable-task-submission-linkage ac-3 — warn on detached HEAD
        if (linkage && !linkage.branch) {
          warn(
            "Submitted from detached HEAD — submission linkage has no branch name. " +
              "Dispatch review continuity may require an explicit branch. " +
              "Use `kspec task set @ref --submission-linkage` to repair.",
          );
        }
      } catch (err) {
        error(errors.failures.updateTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task needs-work <ref>
  // Reviewer kicks back a task for worker to fix
  markMutating(task.command("needs-work <ref>"))
    .description("Kick task back to worker for fixes (pending_review -> needs_work)")
    .requiredOption("--reason <reason>", "Description of issues found")
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        // AC: @task-data-manager ac-1, ac-4 — mutate via task data manager
        let transitionFromStatus: Task["status"] = foundTask.status;
        let cycleNumber = 0;
        const needsWorkCommitOpts: ShadowCommitOptions = {
          operation: "task-needs-work",
          ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
        };
        const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
          ctx,
          foundTask._ulid,
          (latestTask) => {
            transitionFromStatus = latestTask.status;
            if (latestTask.status !== "pending_review") {
              return latestTask;
            }

            // Track fix cycle count from existing kickback notes
            const existingKickbacks = latestTask.notes.filter((note) =>
              note.content.includes("[FIX_CYCLE:"),
            ).length;
            cycleNumber = existingKickbacks + 1;

            const note = createNote(
              `[FIX_CYCLE: ${cycleNumber}] Review findings: ${options.reason}`,
              getAuthor(ctx.config?.identity?.author),
            );

            // Set detail on commitOpts so TaskDataManager's shadow commit includes cycle info
            needsWorkCommitOpts.detail = `cycle ${cycleNumber}`;

            // AC: @session-scoped-task-claiming ac-claim-clear
            return {
              ...latestTask,
              status: "needs_work",
              session_id: null,
              notes: [...latestTask.notes, note],
            };
          },
          needsWorkCommitOpts,
        );

        if (transitionFromStatus !== "pending_review") {
          error(errors.status.cannotNeedsWork(transitionFromStatus));
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // AC: @daemon-agent-dispatch ac-2, ac-7 - Notify daemon of state change (fire-and-forget)
        postDispatchEvent({
          taskId: updatedTask._ulid,
          taskRef: `@${updatedTask.slugs[0] || updatedTask._ulid}`,
          fromStatus: transitionFromStatus,
          toStatus: updatedTask.status,
          projectPath: ctx.projectRoot,
        });

        success(
          `Kicked back task: ${index.shortUlid(updatedTask._ulid)} (fix cycle ${cycleNumber})`,
          { task: updatedTask },
        );
      } catch (err) {
        error(errors.failures.needsWorkTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task block <ref>
  markMutating(task.command("block <ref>"))
    .description("Block a task")
    .requiredOption("--reason <reason>", "Reason for blocking")
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        // AC: @task-data-manager ac-1, ac-4 — mutate via task data manager
        let transitionFromStatus: Task["status"] = foundTask.status;
        const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
          ctx,
          foundTask._ulid,
          (latestTask) => {
            transitionFromStatus = latestTask.status;
            if (latestTask.status === "completed" || latestTask.status === "cancelled") {
              return latestTask;
            }

            // AC: @state-blocked ac-1 — save current status for restoration on unblock
            // Preserve the first non-blocked prior_status on repeated block calls
            return {
              ...latestTask,
              status: "blocked",
              prior_status:
                latestTask.status === "blocked" ? latestTask.prior_status : latestTask.status,
              blocked_by: [...latestTask.blocked_by, options.reason],
            };
          },
          {
            operation: "task-block",
            ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
          },
        );

        if (transitionFromStatus === "completed" || transitionFromStatus === "cancelled") {
          error(errors.status.cannotBlock(transitionFromStatus));
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // AC: @daemon-agent-dispatch ac-2, ac-7 - Notify daemon of state change (fire-and-forget)
        postDispatchEvent({
          taskId: updatedTask._ulid,
          taskRef: `@${updatedTask.slugs[0] || updatedTask._ulid}`,
          fromStatus: transitionFromStatus,
          toStatus: updatedTask.status,
          projectPath: ctx.projectRoot,
        });

        success(`Blocked task: ${index.shortUlid(updatedTask._ulid)}`, {
          task: updatedTask,
        });
      } catch (err) {
        error(errors.failures.blockTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task unblock <ref>
  markMutating(task.command("unblock <ref>"))
    .description("Unblock a task")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        // AC: @task-data-manager ac-1, ac-4 — mutate via task data manager
        let transitionFromStatus: Task["status"] = foundTask.status;
        const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
          ctx,
          foundTask._ulid,
          (latestTask) => {
            transitionFromStatus = latestTask.status;
            if (latestTask.status !== "blocked") {
              return latestTask;
            }

            // AC: @task-unblock ac-1 — restore prior status, fall back to pending
            // AC: @session-scoped-task-claiming ac-claim-clear
            return {
              ...latestTask,
              status: latestTask.prior_status ?? "pending",
              prior_status: null,
              blocked_by: [],
              session_id: null,
            };
          },
          {
            operation: "task-unblock",
            ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
          },
        );

        if (transitionFromStatus !== "blocked") {
          warn("Task is not blocked");
          return;
        }

        // AC: @daemon-agent-dispatch ac-2, ac-7 - Notify daemon of state change (fire-and-forget)
        postDispatchEvent({
          taskId: updatedTask._ulid,
          taskRef: `@${updatedTask.slugs[0] || updatedTask._ulid}`,
          fromStatus: transitionFromStatus,
          toStatus: updatedTask.status,
          projectPath: ctx.projectRoot,
        });

        success(`Unblocked task: ${index.shortUlid(updatedTask._ulid)}`, {
          task: updatedTask,
        });
      } catch (err) {
        error(errors.failures.unblockTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task cancel <ref> | --refs <refs...>
  // AC: @multi-ref-batch ac-1, ac-2
  markMutating(task.command("cancel [ref]"))
    .description("Cancel a task")
    .option("--refs <refs...>", "Cancel multiple tasks by ref")
    .option("--reason <reason>", "Cancellation reason")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec task cancel @task-slug --reason "No longer needed"
  $ kspec task cancel --refs @task1 @task2 --reason "Superseded by @new-task"`,
    )
    .action(async (ref: string | undefined, options) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);

        const result = await executeBatchOperation({
          positionalRef: ref,
          refsFlag: options.refs,
          context: { ctx, tasks, items, index, options },
          items: tasks,
          index,
          resolveRef: (refStr, taskList, idx) => {
            const resolved = resolveTaskRefForBatch(refStr, taskList, idx);
            return { item: resolved.task, error: resolved.error };
          },
          executeOperation: async (foundTask, { ctx, tasks, index, options }) => {
            try {
              if (foundTask.status === "completed" || foundTask.status === "cancelled") {
                return {
                  success: false,
                  error: `Task is already ${foundTask.status}`,
                };
              }

              const downstreamTasks = tasks.filter((task) =>
                task.depends_on.some((depRef) => {
                  const resolved = index.resolve(depRef);
                  return resolved.ok && resolved.ulid === foundTask._ulid;
                }),
              );

              // AC: @task-data-manager ac-1, ac-4 — mutate via task data manager
              const allRefs = [foundTask, ...downstreamTasks].map((t) => t._ulid);
              const [updatedTask] = await resolveTaskDataManager(ctx).mutateTasks(
                ctx,
                allRefs,
                (latestTasks) => {
                  const latestCancelledTask = latestTasks[0];
                  const cancelledTaskRef = getTaskDisplayRef(latestCancelledTask);
                  const cancellationReason = options.reason ? ` Reason: ${options.reason}` : "";

                  const updatedTasks = latestTasks.map((latestTask, taskIndex) => {
                    if (taskIndex === 0) {
                      return {
                        ...latestTask,
                        status: "cancelled" as const,
                        closed_reason: options.reason || null,
                      };
                    }

                    const remainingDependencies = latestTask.depends_on.filter((depRef) => {
                      const resolved = index.resolve(depRef);
                      return !resolved.ok || resolved.ulid !== latestCancelledTask._ulid;
                    });

                    const removedDependencyCount =
                      latestTask.depends_on.length - remainingDependencies.length;
                    if (removedDependencyCount === 0) {
                      return latestTask;
                    }

                    const cleanupNote = createNote(
                      `Cancelled dependency cleanup: removed ${cancelledTaskRef} from depends_on because the upstream task was cancelled.${cancellationReason}`,
                      getAuthor(ctx.config?.identity?.author),
                    );

                    return {
                      ...latestTask,
                      depends_on: remainingDependencies,
                      notes: [...latestTask.notes, cleanupNote],
                    };
                  });

                  return updatedTasks;
                },
                {
                  operation: "task-cancel",
                  ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
                },
              );

              return {
                success: true,
                message: `Cancelled task: ${index.shortUlid(updatedTask._ulid)}`,
                data: updatedTask,
              };
            } catch (err) {
              return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          },
          getUlid: (task) => task._ulid,
        });

        formatBatchOutput(result, "Cancel");
      } catch (err) {
        error(errors.failures.cancelTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task reset <ref>
  // AC: @spec-task-reset ac-1, ac-2, ac-3, ac-4, ac-5, ac-6
  markMutating(task.command("reset <ref>"))
    .description("Reset a task to pending state")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        // AC: @task-data-manager ac-1, ac-4 — mutate via task data manager
        let previousStatus: Task["status"] = foundTask.status;
        const clearedFields: string[] = [];
        // AC: @spec-task-reset ac-3 - Shadow commit with message task-reset
        const resetCommitOpts: ShadowCommitOptions = {
          operation: "task-reset",
          ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
        };
        const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
          ctx,
          foundTask._ulid,
          (latestTask) => {
            previousStatus = latestTask.status;

            // AC: @spec-task-reset ac-2 - Error if already pending
            if (latestTask.status === "pending") {
              return latestTask;
            }

            // Set detail on commitOpts so TaskDataManager's shadow commit includes previous status
            resetCommitOpts.detail = `from ${latestTask.status}`;

            // AC: @spec-task-reset ac-1 - Reset to pending, clear completion-related fields
            const nextTask: Task = {
              ...latestTask,
              status: "pending",
            };
            clearedFields.splice(0, clearedFields.length);

            // Clear timestamps and reasons based on previous status
            if (latestTask.completed_at !== undefined && latestTask.completed_at !== null) {
              nextTask.completed_at = null;
              clearedFields.push("completed_at");
            }
            if (latestTask.started_at !== undefined && latestTask.started_at !== null) {
              nextTask.started_at = null;
              clearedFields.push("started_at");
            }
            if (latestTask.closed_reason !== undefined && latestTask.closed_reason !== null) {
              nextTask.closed_reason = null;
              clearedFields.push("closed_reason");
            }
            if (latestTask.blocked_by.length > 0) {
              nextTask.blocked_by = [];
              clearedFields.push("blocked_by");
            }
            if (latestTask.prior_status) {
              nextTask.prior_status = null;
              clearedFields.push("prior_status");
            }
            // AC: @session-scoped-task-claiming ac-claim-clear
            if (latestTask.session_id) {
              nextTask.session_id = null;
              clearedFields.push("session_id");
            }

            // AC: @spec-task-reset ac-4 - Add note documenting the reset
            // AC: @spec-task-reset ac-author
            const hadCancelReason = latestTask.closed_reason && latestTask.status === "cancelled";
            const cancelReasonText = hadCancelReason
              ? ` (was cancelled: ${latestTask.closed_reason})`
              : "";
            const noteContent = `Reset from ${latestTask.status} to pending${cancelReasonText}`;
            const note = createNote(noteContent, getAuthor(ctx.config?.identity?.author));
            nextTask.notes = [...nextTask.notes, note];

            return nextTask;
          },
          resetCommitOpts,
        );

        if (previousStatus === "pending") {
          error("Task is already pending");
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // AC: @spec-task-reset ac-6 - JSON output includes previous_status, new_status, cleared_fields
        const jsonOutput = {
          task: updatedTask,
          previous_status: previousStatus,
          new_status: "pending" as const,
          cleared_fields: clearedFields,
        };

        output(jsonOutput, () => {
          success(
            `Reset task: ${index.shortUlid(updatedTask._ulid)} (${previousStatus} → pending)`,
            undefined,
          );
          if (clearedFields.length > 0) {
            info(`Cleared fields: ${clearedFields.join(", ")}`);
          }
        });
      } catch (err) {
        error("Failed to reset task", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task delete <ref> | --refs <refs...>
  // AC: @multi-ref-batch ac-1, ac-2
  markMutating(task.command("delete [ref]"))
    .description("Delete a task permanently")
    .option("--refs <refs...>", "Delete multiple tasks by ref")
    .option("--force", "Skip confirmation (required for --refs)")
    .option("--dry-run", "Show what would be deleted without deleting")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec task delete @task-slug
  $ kspec task delete --refs @task1 @task2 --force
  $ kspec task delete --refs @task1 @task2 --dry-run`,
    )
    .action(async (ref: string | undefined, options) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);

        // For batch mode (--refs), require --force
        if (options.refs && options.refs.length > 0 && !options.force && !options.dryRun) {
          error("Batch delete requires --force flag");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        const result = await executeBatchOperation({
          positionalRef: ref,
          refsFlag: options.refs,
          context: { ctx, tasks, items, index, options },
          items: tasks,
          index,
          resolveRef: (refStr, taskList, idx) => {
            const resolved = resolveTaskRefForBatch(refStr, taskList, idx);
            return { item: resolved.task, error: resolved.error };
          },
          executeOperation: async (foundTask, { ctx, index, options }) => {
            try {
              const taskDisplay = `${foundTask.title} (${index.shortUlid(foundTask._ulid)})`;

              if (options.dryRun) {
                return {
                  success: true,
                  message: `Would delete: ${taskDisplay}`,
                };
              }

              // For single-ref mode (not --refs), prompt for confirmation unless --force
              if (!options.refs && !options.force) {
                const readline = await import("node:readline");
                const rl = readline.createInterface({
                  input: process.stdin,
                  output: process.stdout,
                });

                const answer = await new Promise<string>((resolve) => {
                  rl.question(`Delete task "${taskDisplay}"? [y/N] `, resolve);
                });
                rl.close();

                if (answer.toLowerCase() !== "y") {
                  return {
                    success: false,
                    error: "Deletion cancelled by user",
                  };
                }
              }

              // AC: @task-data-manager ac-1, ac-4 — delete via task data manager
              await resolveTaskDataManager(ctx).deleteTask(ctx, foundTask._ulid, {
                operation: "task-delete",
                ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
                detail: foundTask.title,
              });

              return {
                success: true,
                message: `Deleted task: ${taskDisplay}`,
              };
            } catch (err) {
              return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          },
          getUlid: (task) => task._ulid,
        });

        formatBatchOutput(result, "Delete");
      } catch (err) {
        error(errors.failures.deleteTask, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task note <ref> <message>
  markMutating(task.command("note <ref> <message>"))
    .description("Add a note to a task")
    .option("--author <author>", "Note author")
    .option("--supersedes <ulid>", "ULID of note this supersedes")
    .action(async (ref: string, message: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        const note = createNote(message, options.author, options.supersedes);

        // AC: @task-data-manager ac-1, ac-4 — mutate via task data manager
        const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
          ctx,
          foundTask._ulid,
          (latestTask) => ({
            ...latestTask,
            notes: [...latestTask.notes, note],
          }),
          {
            operation: "task-note",
            ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
          },
        );
        success(`Added note to task: ${index.shortUlid(updatedTask._ulid)}`, {
          note,
        });

        // Proactive alignment guidance for tasks with spec_ref
        if (foundTask.spec_ref) {
          console.log("");
          console.log(alignmentCheck.header);
          console.log(alignmentCheck.beyondSpec);
          console.log(alignmentCheck.updateSpec(foundTask.spec_ref));
          console.log(alignmentCheck.addAC);

          // Check if linked spec has acceptance criteria and remind about test coverage
          const specResult = index.resolve(foundTask.spec_ref);
          if (specResult.ok && specResult.item) {
            const specItem = specResult.item as {
              acceptance_criteria?: unknown[];
            };
            if (specItem.acceptance_criteria && specItem.acceptance_criteria.length > 0) {
              console.log("");
              console.log(alignmentCheck.testCoverage(specItem.acceptance_criteria.length));
            }
          }
        }
      } catch (err) {
        error(errors.failures.addNote, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task notes <ref>
  task
    .command("notes <ref>")
    .description("Show notes for a task")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        output(foundTask.notes, () => {
          if (foundTask.notes.length === 0) {
            console.log("No notes");
          } else {
            for (const note of foundTask.notes) {
              const author = note.author || "unknown";
              console.log(`[${note.created_at}] ${author}:`);
              console.log(note.content);
              console.log("");
            }
          }
        });
      } catch (err) {
        error(errors.failures.getNotes, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task review <ref>
  task
    .command("review <ref>")
    .description("Get task context for review (task details, spec, ACs, git diff)")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        // Import getDiffSince from utils
        const { getDiffSince } = await import("../../utils/index.js");

        // Gather review context
        const reviewContext: {
          task: typeof foundTask;
          spec: LoadedSpecItem | null;
          diff: string | null;
          started_at: string | null;
          testCoverage?: { covered: string[]; uncovered: string[] };
        } = {
          task: foundTask,
          spec: null,
          diff: null,
          started_at: foundTask.started_at || null,
        };

        // Get spec item if task has spec_ref
        if (foundTask.spec_ref) {
          const specResult = index.resolve(foundTask.spec_ref);
          if (specResult.ok) {
            const specItem = items.find((i) => i._ulid === specResult.ulid);
            reviewContext.spec = specItem || null;

            // Check test coverage for ACs if spec has them
            if (specItem?.acceptance_criteria && specItem.acceptance_criteria.length > 0) {
              const coveredACs = await scanTestCoverage(
                ctx.rootDir,
                ctx.config.coverage.scan_paths,
                ctx.config.coverage.exclude_patterns,
              );
              const covered: string[] = [];
              const uncovered: string[] = [];

              for (const ac of specItem.acceptance_criteria) {
                // Build possible references
                const possibleRefs: string[] = [];
                if (specItem.slugs && specItem.slugs.length > 0) {
                  possibleRefs.push(`@${specItem.slugs[0]} ${ac.id}`);
                  possibleRefs.push(`@${specItem.slugs[0]}`);
                }
                for (let prefixLength = 8; prefixLength <= specItem._ulid.length; prefixLength++) {
                  const prefix = specItem._ulid.slice(0, prefixLength);
                  possibleRefs.push(`@${prefix} ${ac.id}`);
                  possibleRefs.push(`@${prefix}`);
                }

                const isCovered = possibleRefs.some((ref) => coveredACs.has(ref));
                if (isCovered) {
                  covered.push(ac.id);
                } else {
                  uncovered.push(ac.id);
                }
              }

              reviewContext.testCoverage = { covered, uncovered };
            }
          }
        }

        // Get git diff since task started
        if (foundTask.started_at) {
          const startedDate = new Date(foundTask.started_at);
          reviewContext.diff = getDiffSince(startedDate, ctx.rootDir);
        }

        output(reviewContext, () => {
          console.log("=".repeat(60));
          console.log("Task Review Context");
          console.log("=".repeat(60));
          console.log();

          // Task details
          console.log("TASK DETAILS");
          console.log("-".repeat(60));
          console.log(formatTaskDetails(foundTask, index));
          console.log();

          // Spec details
          if (reviewContext.spec) {
            console.log("LINKED SPEC");
            console.log("-".repeat(60));
            console.log(`Title: ${reviewContext.spec.title}`);
            console.log(`Type: ${reviewContext.spec.type}`);
            if (reviewContext.spec.description) {
              console.log(`\nDescription:\n${reviewContext.spec.description}`);
            }
            if (
              reviewContext.spec.acceptance_criteria &&
              reviewContext.spec.acceptance_criteria.length > 0
            ) {
              console.log(
                `\nAcceptance Criteria (${reviewContext.spec.acceptance_criteria.length}):`,
              );
              for (const ac of reviewContext.spec.acceptance_criteria) {
                const isCovered = reviewContext.testCoverage?.covered.includes(ac.id);
                const coverageMarker = isCovered ? chalk.green("✓") : chalk.yellow("○");
                console.log(`  ${coverageMarker} [${ac.id}]`);
                console.log(`    Given: ${ac.given}`);
                console.log(`    When: ${ac.when}`);
                console.log(`    Then: ${ac.then}`);
              }

              // Test coverage summary
              if (reviewContext.testCoverage) {
                const { covered, uncovered } = reviewContext.testCoverage;
                console.log();
                if (uncovered.length === 0) {
                  console.log(chalk.green(`  ✓ All ${covered.length} AC(s) have test coverage`));
                } else {
                  console.log(
                    chalk.yellow(
                      `  Test coverage: ${covered.length}/${covered.length + uncovered.length} ACs covered`,
                    ),
                  );
                  console.log(chalk.yellow(`  Missing coverage for: ${uncovered.join(", ")}`));
                }
              }
            }
            console.log();
          }

          // Git diff
          if (reviewContext.diff) {
            console.log("CHANGES SINCE TASK STARTED");
            console.log("-".repeat(60));
            console.log(`Started at: ${foundTask.started_at}`);
            console.log();
            console.log(reviewContext.diff);
            console.log();
          } else if (foundTask.started_at) {
            console.log("CHANGES SINCE TASK STARTED");
            console.log("-".repeat(60));
            console.log(`Started at: ${foundTask.started_at}`);
            console.log("No changes detected");
            console.log();
          }

          console.log("=".repeat(60));
          console.log("Review Checklist:");
          console.log("- Does the implementation match the task description?");
          if (reviewContext.spec) {
            console.log("- Are all acceptance criteria covered?");
            console.log("- Is test coverage adequate?");
          }
          console.log("- Are there any gaps or issues?");
          console.log("=".repeat(60));
        });
      } catch (err) {
        error("Failed to generate review context", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task todos <ref>
  task
    .command("todos <ref>")
    .description("Show todos for a task")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        output(foundTask.todos, () => {
          if (foundTask.todos.length === 0) {
            console.log("No todos");
          } else {
            for (const todo of foundTask.todos) {
              const status = todo.done ? "[x]" : "[ ]";
              const doneInfo = todo.done && todo.done_at ? ` (done ${todo.done_at})` : "";
              console.log(`${status} ${todo.id}. ${todo.text}${doneInfo}`);
            }
          }
        });
      } catch (err) {
        error(errors.failures.getTodos, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // Create subcommand group for todo operations
  const todoCmd = task.command("todo").description("Manage task todos");

  // kspec task todo add <ref> <text>
  markMutating(todoCmd.command("add <ref> <text>"))
    .description("Add a todo to a task")
    .option("--author <author>", "Todo author")
    .action(async (ref: string, text: string, options) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        // AC: @task-data-manager ac-1, ac-4 — mutate via task data manager
        let todo = createTodo(1, text, options.author);
        const updatedTask = await resolveTaskDataManager(ctx).mutateTask(
          ctx,
          foundTask._ulid,
          (latestTask) => {
            // Calculate next ID (max existing + 1, or 1 if none)
            const nextId =
              latestTask.todos.length > 0
                ? Math.max(...latestTask.todos.map((entry) => entry.id)) + 1
                : 1;

            todo = createTodo(nextId, text, options.author);

            return {
              ...latestTask,
              todos: [...latestTask.todos, todo],
            };
          },
          {
            operation: "task-todo-add",
            ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
          },
        );
        success(`Added todo #${todo.id} to task: ${index.shortUlid(updatedTask._ulid)}`, { todo });
      } catch (err) {
        error(errors.failures.addTodo, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task todo done <ref> <id>
  markMutating(todoCmd.command("done <ref> <id>"))
    .description("Mark a todo as done")
    .action(async (ref: string, idStr: string) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        const id = parseInt(idStr, 10);
        if (Number.isNaN(id)) {
          error(errors.todo.invalidId(idStr));
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // AC: @task-data-manager ac-1, ac-4 — mutate via task data manager
        let todoState: "not_found" | "already_done" | "updated" | undefined;
        let updatedTodo: Task["todos"][number] | undefined;
        await resolveTaskDataManager(ctx).mutateTask(
          ctx,
          foundTask._ulid,
          (latestTask) => {
            const todoIndex = latestTask.todos.findIndex((todo) => todo.id === id);
            if (todoIndex === -1) {
              todoState = "not_found";
              return latestTask;
            }

            if (latestTask.todos[todoIndex].done) {
              todoState = "already_done";
              updatedTodo = latestTask.todos[todoIndex];
              return latestTask;
            }

            const updatedTodos = [...latestTask.todos];
            updatedTodos[todoIndex] = {
              ...updatedTodos[todoIndex],
              done: true,
              done_at: new Date().toISOString(),
            };
            updatedTodo = updatedTodos[todoIndex];
            return {
              ...latestTask,
              todos: updatedTodos,
            };
          },
          {
            operation: "task-todo-done",
            ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
          },
        );

        if (todoState === "not_found") {
          error(errors.todo.notFound(id));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        if (todoState === "already_done") {
          warn(`Todo #${id} is already done`);
          return;
        }
        success(`Marked todo #${id} as done`, {
          todo: updatedTodo,
        });
      } catch (err) {
        error(errors.failures.markTodoDone, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task todo undone <ref> <id>
  markMutating(todoCmd.command("undone <ref> <id>"))
    .description("Mark a todo as not done")
    .action(async (ref: string, idStr: string) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        const id = parseInt(idStr, 10);
        if (Number.isNaN(id)) {
          error(errors.todo.invalidId(idStr));
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // AC: @task-data-manager ac-1, ac-4 — mutate via task data manager
        let todoState: "not_found" | "already_not_done" | "updated" | undefined;
        let updatedTodo: Task["todos"][number] | undefined;
        await resolveTaskDataManager(ctx).mutateTask(
          ctx,
          foundTask._ulid,
          (latestTask) => {
            const todoIndex = latestTask.todos.findIndex((todo) => todo.id === id);
            if (todoIndex === -1) {
              todoState = "not_found";
              return latestTask;
            }

            if (!latestTask.todos[todoIndex].done) {
              todoState = "already_not_done";
              updatedTodo = latestTask.todos[todoIndex];
              return latestTask;
            }

            const updatedTodos = [...latestTask.todos];
            updatedTodos[todoIndex] = {
              ...updatedTodos[todoIndex],
              done: false,
              done_at: undefined,
            };
            updatedTodo = updatedTodos[todoIndex];
            return {
              ...latestTask,
              todos: updatedTodos,
            };
          },
          {
            operation: "task-todo-undone",
            ref: foundTask.slugs[0] || index.shortUlid(foundTask._ulid),
          },
        );

        if (todoState === "not_found") {
          error(errors.todo.notFound(id));
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        if (todoState === "already_not_done") {
          warn(`Todo #${id} is not done`);
          return;
        }
        success(`Marked todo #${id} as not done`, {
          todo: updatedTodo,
        });
      } catch (err) {
        error(errors.failures.markTodoNotDone, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task branch <ref>
  // AC: @deterministic-task-branch-helper ac-1, ac-2, ac-3
  task
    .command("branch <ref>")
    .description("Create or resume the deterministic dispatch-compatible branch for a task")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
        const foundTask = await resolveTaskRef(ref, tasks, index, ctx);

        // AC: @trait-error-guidance ac-1, ac-2
        if (!isGitRepo()) {
          error("Not a git repository. Run this command from inside a git repo.");
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // AC: @deterministic-task-branch-helper ac-1
        // Compute the deterministic branch name using the dispatch naming contract
        const branchName = computeDispatchBranchName(foundTask._ulid, foundTask);

        // AC: @deterministic-task-branch-helper ac-2
        // Check if the branch already exists locally
        const localExists = gitRefExists(`refs/heads/${branchName}`);

        if (localExists) {
          // Branch exists locally — switch to it
          const currentBranch = getCurrentBranch();
          if (currentBranch === branchName) {
            // Already on the branch
            reportBranchResult({
              branch: branchName,
              action: "already_on_branch",
              subject: {
                label: "Task",
                ref: `@${foundTask.slugs[0] || foundTask._ulid}`,
                jsonKey: "task_ref",
              },
              guidance:
                "Using this dispatch-compatible branch preserves reviewer and fix-cycle continuity for manual work.",
            });
          } else {
            gitCheckout(branchName);
            reportBranchResult({
              branch: branchName,
              action: "switched",
              subject: {
                label: "Task",
                ref: `@${foundTask.slugs[0] || foundTask._ulid}`,
                jsonKey: "task_ref",
              },
              guidance:
                "Using this dispatch-compatible branch preserves reviewer and fix-cycle continuity for manual work.",
            });
          }
          return;
        }

        // AC: @deterministic-task-branch-helper ac-2
        // Check remotes for the branch and rehydrate if found
        const remoteSource = findBranchOnRemote(branchName);
        if (remoteSource) {
          gitCreateBranchFrom(branchName, remoteSource);
          gitCheckout(branchName);
          reportBranchResult({
            branch: branchName,
            action: "rehydrated",
            source: remoteSource,
            subject: {
              label: "Task",
              ref: `@${foundTask.slugs[0] || foundTask._ulid}`,
              jsonKey: "task_ref",
            },
            guidance:
              "Using this dispatch-compatible branch preserves reviewer and fix-cycle continuity for manual work.",
          });
          return;
        }

        // Branch does not exist anywhere — create it
        gitCheckoutNew(branchName);
        reportBranchResult({
          branch: branchName,
          action: "created",
          subject: {
            label: "Task",
            ref: `@${foundTask.slugs[0] || foundTask._ulid}`,
            jsonKey: "task_ref",
          },
          guidance:
            "Using this dispatch-compatible branch preserves reviewer and fix-cycle continuity for manual work.",
        });
      } catch (err) {
        error(errors.failures.taskBranch, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec task migrate
  // AC: @task-storage-migration ac-1, ac-2, ac-3, ac-4, ac-5, ac-6, ac-7, ac-8
  markMutating(
    task
      .command("migrate")
      .description("Migrate tasks from monolithic format to per-task directory format")
      .option("--dry-run", "Preview migration without making changes")
      .option("--force", "Skip confirmation prompt"),
  ).action(async (options) => {
    try {
      const ctx = await initContext();

      // AC: @trait-dry-run ac-5 — dry-run takes precedence over --force
      const isDryRun = !!options.dryRun;

      // Import split backend utilities
      const {
        getTasksDir,
        getTaskDir,
        getTaskFilePath,
        getNotesFilePath,
        getIndexFilePath,
        toIndexEntry,
        listTaskDirs,
      } = await import("../../parser/split-backend.js");
      const { extractRawTaskArray, toYaml, readYamlFile } = await import("../../parser/yaml.js");
      const { TaskSchema } = await import("../../schema/task.js");
      const { ulid: generateUlid } = await import("ulid");
      const { runWithBuffer, mkdirBufferAware, writeFileBufferAware } =
        await import("../../cli/batch-write-buffer.js");

      const indexPath = getIndexFilePath(ctx);

      // Helper: upgrade manifest to kynetic 1.1 with task_storage.format: "split".
      // Called from every success path (including early-returns for already-migrated)
      // so that the version gate in resolveTaskDataManager() stops blocking.
      async function upgradeManifestToSplit(): Promise<void> {
        if (!ctx.manifestPath) return;
        const { readYamlFile: readManifest, writeYamlFilePreserveFormat } =
          await import("../../parser/yaml.js");
        const manifest = await readManifest<Record<string, unknown>>(ctx.manifestPath);
        if (!manifest) return;
        // Bump kynetic version to 1.1
        manifest.kynetic = "1.1";
        // Set task_storage.format = "split"
        if (!manifest.task_storage || typeof manifest.task_storage !== "object") {
          manifest.task_storage = { format: "split" };
        } else {
          (manifest.task_storage as Record<string, unknown>).format = "split";
        }
        await writeYamlFilePreserveFormat(ctx.manifestPath, manifest);
      }

      // Read the raw task entries from project.tasks.yaml
      const { rawTasks, useTasksWrapper, wrapperObj } = await extractRawTaskArray(indexPath);

      if (rawTasks.length === 0) {
        // AC: @task-storage-migration ac-6 — already migrated (no monolithic entries)
        if (!isDryRun) {
          await upgradeManifestToSplit();
          await commitIfShadow(ctx.shadow, "chore: upgrade manifest to split task storage format");
        }
        const resultData = {
          ...(isDryRun ? { dry_run: true } : {}),
          migrated: 0,
          backfilled: 0,
          notes_total: 0,
          warnings: [] as string[],
          already_migrated: true,
        };
        output(resultData, () => {
          if (isDryRun) {
            warn("DRY RUN — no changes will be written");
            console.log();
          }
          success("Already migrated — no monolithic tasks found.");
        });
        return;
      }

      // Identify which entries are lean index entries (have `notes_count` as number)
      // vs monolithic entries (everything else — including malformed notes).
      // A lean index entry uses scalar counts; any entry without `notes_count`
      // as a number is treated as monolithic and migrated (AC-5: malformed
      // tasks migrate with a warning rather than being silently skipped).
      const monolithicEntries: Array<{ raw: Record<string, unknown>; index: number }> = [];
      const leanEntries: Array<{ raw: Record<string, unknown>; index: number }> = [];

      for (let i = 0; i < rawTasks.length; i++) {
        const entry = rawTasks[i];
        if (!entry || typeof entry !== "object") continue;
        const rec = entry as Record<string, unknown>;

        if (typeof rec.notes_count === "number") {
          leanEntries.push({ raw: rec, index: i });
        } else {
          monolithicEntries.push({ raw: rec, index: i });
        }
      }

      // Check which monolithic entries already have per-task directories
      const existingDirs = new Set(await listTaskDirs(ctx));

      // AC: @task-storage-migration ac-5 — tasks with missing/invalid _ulid get
      // a generated ULID and a warning, then migrate normally
      const generatedUlids = new Set<string>();
      for (const entry of monolithicEntries) {
        const rawUlid = entry.raw._ulid;
        if (typeof rawUlid !== "string" || !rawUlid || !ulidPattern.test(rawUlid)) {
          const generated = generateUlid();
          entry.raw._ulid = generated;
          generatedUlids.add(generated);
        }
      }

      // Entries that need migration: monolithic entries without existing dirs
      const toMigrate = monolithicEntries.filter((e) => !existingDirs.has(e.raw._ulid as string));

      // Entries that are already in both formats (monolithic + dir exists) — just need index cleanup
      const alreadyMigrated = monolithicEntries.filter((e) =>
        existingDirs.has(e.raw._ulid as string),
      );

      if (toMigrate.length === 0 && alreadyMigrated.length === 0) {
        // AC: @task-storage-migration ac-6 — all entries are already lean index entries
        if (!isDryRun) {
          await upgradeManifestToSplit();
          await commitIfShadow(ctx.shadow, "chore: upgrade manifest to split task storage format");
        }
        const resultData = {
          ...(isDryRun ? { dry_run: true } : {}),
          migrated: 0,
          backfilled: 0,
          notes_total: 0,
          warnings: [] as string[],
          already_migrated: true,
        };
        output(resultData, () => {
          if (isDryRun) {
            warn("DRY RUN — no changes will be written");
            console.log();
          }
          success("Already migrated — no monolithic tasks to process.");
        });
        return;
      }

      const warnings: string[] = [];
      let totalNotes = 0;

      // Validate tasks and collect migration data
      interface MigrationTask {
        ulid: string;
        rawData: Record<string, unknown>;
        notes: unknown[];
        coreData: Record<string, unknown>;
        indexEntry: Record<string, unknown>;
        isBackfill: boolean;
        validationWarning?: string;
      }
      const migrationTasks: MigrationTask[] = [];

      for (const entry of toMigrate) {
        const raw = entry.raw;
        const ulid = raw._ulid as string;
        const notes = Array.isArray(raw.notes) ? raw.notes : [];
        totalNotes += notes.length;

        // AC: @task-storage-migration ac-5 — warn when _ulid was missing/invalid and generated
        if (generatedUlids.has(ulid)) {
          warnings.push(
            `Task "${raw.title ?? "(untitled)"}": missing or invalid _ulid — generated ${ulid}`,
          );
        }

        // AC: @task-storage-migration ac-5 — try validation, warn on failure, migrate raw data
        const parsed = TaskSchema.safeParse(raw);
        let coreData: Record<string, unknown>;
        let indexEntry: Record<string, unknown>;

        if (parsed.success) {
          // Clean task: separate notes from core data
          const { notes: _n, _sourceFile: _sf, ...core } = parsed.data as Record<string, unknown>;
          coreData = core;
          indexEntry = toIndexEntry(parsed.data);
        } else {
          // AC: @task-storage-migration ac-5 — preserve raw data with warning
          const validationMsg = `Task ${ulid}: validation warning — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
          warnings.push(validationMsg);

          // Use raw data as-is, stripping notes for the core file
          const { notes: _n, _sourceFile: _sf, ...core } = raw;
          coreData = core;

          // Build a best-effort index entry from raw data
          indexEntry = {
            _ulid: ulid,
            slugs: Array.isArray(raw.slugs) ? raw.slugs : [],
            title: raw.title ?? "",
            type: raw.type ?? "task",
            status: raw.status ?? "pending",
            priority: raw.priority ?? 3,
            tags: Array.isArray(raw.tags) ? raw.tags : [],
            depends_on: Array.isArray(raw.depends_on) ? raw.depends_on : [],
            blocked_by: Array.isArray(raw.blocked_by) ? raw.blocked_by : [],
            created_at: raw.created_at ?? new Date().toISOString(),
            notes_count: notes.length,
            todos_count: Array.isArray(raw.todos) ? raw.todos.length : 0,
          };
          // Include optional fields if present
          for (const field of [
            "assignee",
            "automation",
            "spec_ref",
            "plan_ref",
            "review_ref",
            "started_at",
            "submitted_at",
            "completed_at",
          ]) {
            if (raw[field] !== undefined && raw[field] !== null) {
              indexEntry[field] = raw[field];
            }
          }
        }

        // Determine if this is a backfill (previous migration already happened)
        const isBackfill = existingDirs.size > 0 || leanEntries.length > 0;

        migrationTasks.push({
          ulid,
          rawData: raw,
          notes,
          coreData,
          indexEntry,
          isBackfill,
          validationWarning: parsed.success ? undefined : warnings[warnings.length - 1],
        });
      }

      const migrateCount = migrationTasks.filter((t) => !t.isBackfill).length;
      const backfillCount = migrationTasks.filter((t) => t.isBackfill).length;

      // AC: @trait-dry-run ac-1, ac-2, ac-3 — dry-run shows preview without changes
      if (isDryRun) {
        const resultData = {
          dry_run: true,
          migrated: migrateCount,
          backfilled: backfillCount,
          notes_total: totalNotes,
          warnings,
          already_migrated: false,
          tasks: migrationTasks.map((t) => ({
            ulid: t.ulid,
            title: (t.coreData.title as string) || "",
            notes_count: t.notes.length,
            is_backfill: t.isBackfill,
            has_warning: !!t.validationWarning,
          })),
        };
        // AC: @trait-dry-run ac-6 — JSON output includes dry_run boolean field
        output(resultData, () => {
          // AC: @trait-dry-run ac-3 — clear indication this is a preview
          warn("DRY RUN — no changes will be written");
          console.log();
          info(`Would migrate ${migrateCount} task(s), backfill ${backfillCount} task(s)`);
          info(`Total notes: ${totalNotes}`);
          if (warnings.length > 0) {
            console.log();
            warn(`${warnings.length} validation warning(s):`);
            for (const w of warnings) {
              console.log(`  ${chalk.yellow("!")} ${w}`);
            }
          }
          console.log();
          for (const t of migrationTasks) {
            const label = t.isBackfill ? chalk.cyan("[backfill]") : chalk.green("[migrate]");
            const warnLabel = t.validationWarning ? chalk.yellow(" [warning]") : "";
            console.log(
              `  ${label}${warnLabel} ${t.coreData.title || t.ulid} (${t.notes.length} notes)`,
            );
          }
        });
        return;
      }

      // AC: @task-storage-migration ac-8 — all changes in single atomic commit
      await runWithBuffer(ctx.specDir, async () => {
        // Ensure tasks directory exists
        const tasksDir = getTasksDir(ctx);
        await mkdirBufferAware(tasksDir);

        // AC: @task-storage-migration ac-1 — create per-task directories with core data and notes
        for (const task of migrationTasks) {
          const taskDir = getTaskDir(ctx, task.ulid);
          const taskFilePath = getTaskFilePath(ctx, task.ulid);
          const notesFilePath = getNotesFilePath(ctx, task.ulid);

          await mkdirBufferAware(taskDir);

          // Write task.yaml (core data without notes, with empty history)
          await writeFileBufferAware(taskFilePath, toYaml(task.coreData));

          // Write notes.yaml
          await writeFileBufferAware(notesFilePath, toYaml({ notes: task.notes }));
        }

        // AC: @task-storage-migration ac-2 — rewrite index with lean entries
        // Build new index: keep existing lean entries + add new index entries from migrated tasks
        // Also convert any remaining monolithic entries that had existing dirs to lean format
        const newIndex: Record<string, unknown>[] = [];

        // Existing lean entries stay as-is
        for (const entry of leanEntries) {
          newIndex.push(entry.raw);
        }

        // Already-migrated entries (monolithic format but dir exists) — convert to lean
        // AC: @task-storage-migration ac-7 — don't affect existing per-task data
        // Read canonical data from per-task directories, NOT from stale monolithic entries
        for (const entry of alreadyMigrated) {
          const ulid = entry.raw._ulid as string;
          const taskFilePath = getTaskFilePath(ctx, ulid);
          const notesFilePath = getNotesFilePath(ctx, ulid);

          // Read canonical core data from the per-task directory and build
          // the index entry directly — avoids round-tripping through TaskSchema
          // which rejects sparse/placeholder notes arrays
          let canonicalBuilt = false;
          try {
            const rawCore = await readYamlFile<unknown>(taskFilePath);
            if (rawCore && typeof rawCore === "object") {
              const coreObj = rawCore as Record<string, unknown>;

              // Read canonical notes count
              let notesCount = 0;
              try {
                const rawNotes = await readYamlFile<unknown>(notesFilePath);
                if (rawNotes && typeof rawNotes === "object" && "notes" in rawNotes) {
                  const notesWrapper = rawNotes as Record<string, unknown>;
                  notesCount = Array.isArray(notesWrapper.notes) ? notesWrapper.notes.length : 0;
                } else if (Array.isArray(rawNotes)) {
                  notesCount = rawNotes.length;
                }
              } catch {
                // Notes file doesn't exist — zero notes
              }

              // Build index entry directly from canonical data
              const indexEntry: Record<string, unknown> = {
                _ulid: coreObj._ulid ?? ulid,
                slugs: Array.isArray(coreObj.slugs) ? coreObj.slugs : [],
                title: coreObj.title ?? "",
                type: coreObj.type ?? "task",
                status: coreObj.status ?? "pending",
                priority: coreObj.priority ?? 3,
                tags: Array.isArray(coreObj.tags) ? coreObj.tags : [],
                depends_on: Array.isArray(coreObj.depends_on) ? coreObj.depends_on : [],
                blocked_by: Array.isArray(coreObj.blocked_by) ? coreObj.blocked_by : [],
                created_at: coreObj.created_at ?? new Date().toISOString(),
                notes_count: notesCount,
                todos_count: Array.isArray(coreObj.todos) ? coreObj.todos.length : 0,
              };
              for (const field of [
                "assignee",
                "automation",
                "spec_ref",
                "plan_ref",
                "review_ref",
                "started_at",
                "submitted_at",
                "completed_at",
                "session_id",
              ]) {
                if (coreObj[field] !== undefined && coreObj[field] !== null) {
                  indexEntry[field] = coreObj[field];
                }
              }
              newIndex.push(indexEntry);
              canonicalBuilt = true;
            }
          } catch {
            // Per-task dir read failed — fall through to monolithic fallback
          }

          // Fallback: if canonical read failed, use monolithic data
          if (!canonicalBuilt) {
            const raw = entry.raw;
            const notes = Array.isArray(raw.notes) ? raw.notes : [];
            const fallbackEntry: Record<string, unknown> = {
              _ulid: raw._ulid,
              slugs: Array.isArray(raw.slugs) ? raw.slugs : [],
              title: raw.title ?? "",
              type: raw.type ?? "task",
              status: raw.status ?? "pending",
              priority: raw.priority ?? 3,
              tags: Array.isArray(raw.tags) ? raw.tags : [],
              depends_on: Array.isArray(raw.depends_on) ? raw.depends_on : [],
              blocked_by: Array.isArray(raw.blocked_by) ? raw.blocked_by : [],
              created_at: raw.created_at ?? new Date().toISOString(),
              notes_count: notes.length,
              todos_count: Array.isArray(raw.todos) ? raw.todos.length : 0,
            };
            for (const field of [
              "assignee",
              "automation",
              "spec_ref",
              "plan_ref",
              "review_ref",
              "started_at",
              "submitted_at",
              "completed_at",
              "session_id",
            ]) {
              if (raw[field] !== undefined && raw[field] !== null) {
                fallbackEntry[field] = raw[field];
              }
            }
            newIndex.push(fallbackEntry);
          }
        }

        // Newly migrated entries
        for (const task of migrationTasks) {
          newIndex.push(task.indexEntry);
        }

        // Write the lean index
        if (useTasksWrapper && wrapperObj) {
          await writeFileBufferAware(indexPath, toYaml({ ...wrapperObj, tasks: newIndex }));
        } else {
          await writeFileBufferAware(indexPath, toYaml(newIndex));
        }
      });

      // After successful migration, update manifest: set task_storage.format = "split"
      // and bump kynetic version to 1.1. This replaces the separate activate command.
      await upgradeManifestToSplit();

      // AC: @task-storage-migration ac-8 — single atomic shadow branch commit
      await commitIfShadow(
        ctx.shadow,
        `feat: migrate ${migrationTasks.length} task(s) to per-task directory format`,
      );

      const resultData = {
        migrated: migrateCount,
        backfilled: backfillCount,
        notes_total: totalNotes,
        warnings,
        already_migrated: false,
      };
      output(resultData, () => {
        if (migrateCount > 0) {
          success(`Migrated ${migrateCount} task(s) to per-task directory format`);
        }
        if (backfillCount > 0) {
          success(`Backfilled ${backfillCount} task(s) into per-task directories`);
        }
        info(`Total notes migrated: ${totalNotes}`);
        if (warnings.length > 0) {
          console.log();
          warn(`${warnings.length} validation warning(s):`);
          for (const w of warnings) {
            console.log(`  ${chalk.yellow("!")} ${w}`);
          }
        }
      });
    } catch (err) {
      // AC: @trait-error-guidance ac-1 — description of what went wrong
      // AC: @trait-error-guidance ac-2 — suggested action
      // AC: @trait-error-guidance ac-6 — guidance in structured error object
      if (isJsonMode()) {
        output({
          success: false,
          error: String(err instanceof Error ? err.message : err),
          suggestion:
            "Check that .kspec/ directory exists and shadow branch is healthy. Run 'kspec shadow status' for diagnostics.",
        });
      } else {
        error("Failed to migrate tasks", err instanceof Error ? err.message : err);
        info(
          "Check that .kspec/ directory exists and shadow branch is healthy. Run 'kspec shadow status' for diagnostics.",
        );
      }
      process.exit(EXIT_CODES.ERROR);
    }
  });

  // kspec task rebuild-index
  // AC: @task-index-rebuild ac-1, ac-2, ac-3, ac-4
  task
    .command("rebuild-index")
    .description("Rebuild the task index from per-task directories")
    .option("--repair", "Overwrite the index with the rebuilt version")
    .option("--dry-run", "Show what would change without applying")
    .option("--force", "Used with --repair to skip confirmation")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        // AC: @trait-dry-run ac-5 — dry-run takes precedence over --repair
        const isDryRun = !!options.dryRun;
        const isRepair = !!options.repair && !isDryRun;

        // Import split backend utilities
        const { listTaskDirs, toIndexEntry, getIndexFilePath } =
          await import("../../parser/split-backend.js");
        const { readYamlFile } = await import("../../parser/yaml.js");
        const { TaskDataManager } = await import("../../parser/task-data-manager.js");

        // AC: @task-index-rebuild ac-4 — report when no per-task directories exist
        const ulids = await listTaskDirs(ctx);
        if (ulids.length === 0) {
          // AC: @trait-error-guidance ac-1 — description of what went wrong
          // AC: @trait-error-guidance ac-2 — suggested action to resolve
          // AC: @trait-error-guidance ac-6 — guidance in structured error object
          error("No per-task directories found in .kspec/tasks/", {
            suggestion:
              "Run 'kspec task migrate' to convert legacy task storage to per-task directories.",
          });
          if (!isJsonMode()) {
            info(
              "Run 'kspec task migrate' to convert legacy task storage to per-task directories.",
            );
          }
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // AC: @task-index-rebuild ac-1 — scan all task directories and extract indexed fields
        // Use a split-mode TaskDataManager to load tasks from per-task files
        const splitManager = new TaskDataManager("split");
        const allTasks = await splitManager.loadAllTasks(ctx);
        const newEntries: Record<string, unknown>[] = allTasks.map((t) => toIndexEntry(t));
        const newEntriesByUlid = new Map(newEntries.map((e) => [e._ulid as string, e]));

        // Read current index entries for comparison
        const indexPath = getIndexFilePath(ctx);
        let currentEntries: Record<string, unknown>[] = [];
        try {
          const raw = await readYamlFile<unknown>(indexPath);
          if (Array.isArray(raw)) {
            currentEntries = raw.filter(
              (e): e is Record<string, unknown> => !!e && typeof e === "object",
            );
          } else if (raw && typeof raw === "object" && "tasks" in raw) {
            const wrapper = raw as Record<string, unknown>;
            if (Array.isArray(wrapper.tasks)) {
              currentEntries = wrapper.tasks.filter(
                (e): e is Record<string, unknown> => !!e && typeof e === "object",
              );
            }
          }
        } catch {
          // Index file may not exist — treat as empty
        }
        const currentByUlid = new Map(
          currentEntries
            .filter((e) => typeof e._ulid === "string")
            .map((e) => [e._ulid as string, e]),
        );

        // AC: @task-index-rebuild ac-2 — report differences
        const { indexEntriesEqual } = await import("../../parser/split-backend.js");

        interface IndexDiff {
          type: "added" | "removed" | "changed";
          ulid: string;
          title?: string;
          fields?: Array<{
            field: string;
            before: unknown;
            after: unknown;
          }>;
        }
        const diffs: IndexDiff[] = [];

        // Find added entries (in per-task dirs but not in index)
        for (const [ulid, newEntry] of newEntriesByUlid) {
          const currentEntry = currentByUlid.get(ulid);
          if (!currentEntry) {
            diffs.push({
              type: "added",
              ulid,
              title: newEntry.title as string,
            });
          } else if (!indexEntriesEqual(currentEntry, newEntry)) {
            // Changed entries — compare all fields present in the new entry
            const fields: IndexDiff["fields"] = [];
            const allKeys = new Set([...Object.keys(newEntry), ...Object.keys(currentEntry)]);
            for (const field of allKeys) {
              if (field === "_ulid") continue; // Skip identity field
              const before = currentEntry[field];
              const after = newEntry[field];
              if (before === after) continue;
              if (before === undefined && after === undefined) continue;
              // Deep comparison for arrays
              if (Array.isArray(before) && Array.isArray(after)) {
                if (
                  before.length === after.length &&
                  before.every((v: unknown, i: number) => v === after[i])
                )
                  continue;
              }
              fields.push({ field, before, after });
            }
            if (fields.length > 0) {
              diffs.push({
                type: "changed",
                ulid,
                title: (newEntry.title || currentEntry.title) as string,
                fields,
              });
            }
          }
        }

        // Find removed entries (in index but not in per-task dirs)
        for (const [ulid, currentEntry] of currentByUlid) {
          if (!newEntriesByUlid.has(ulid)) {
            diffs.push({
              type: "removed",
              ulid,
              title: currentEntry.title as string,
            });
          }
        }

        const resultData = {
          ...(isDryRun ? { dry_run: true } : {}),
          task_dirs_found: ulids.length,
          index_entries_current: currentEntries.length,
          index_entries_rebuilt: newEntries.length,
          differences: diffs,
          repaired: false,
        };

        if (diffs.length === 0) {
          output(resultData, () => {
            if (isDryRun) {
              warn("DRY RUN — no changes will be written");
              console.log();
            }
            success(`Index is up to date (${newEntries.length} tasks)`);
          });
          return;
        }

        // AC: @trait-dry-run ac-3 — clear indication that this is a preview
        if (isDryRun) {
          output(resultData, () => {
            warn("DRY RUN — no changes will be written");
            console.log();
            printDiffs(diffs);
            console.log();
            info(`${diffs.length} difference(s) found. Use --repair to apply changes.`);
          });
          return;
        }

        // No --repair: just report diffs
        if (!isRepair) {
          output(resultData, () => {
            printDiffs(diffs);
            console.log();
            info(`${diffs.length} difference(s) found. Use --repair to overwrite the index.`);
          });
          return;
        }

        // AC: @task-index-rebuild ac-3 — confirm before repairing unless --force
        if (!options.force) {
          if (isJsonMode()) {
            error("Confirmation required. Use --force with --json to proceed");
            process.exit(EXIT_CODES.USAGE_ERROR);
          }

          const isTTY =
            process.env.KSPEC_TEST_TTY === "1" ||
            process.env.KSPEC_TEST_TTY === "true" ||
            process.stdin.isTTY;
          if (!isTTY) {
            error("Non-interactive environment. Use --force to proceed");
            process.exit(EXIT_CODES.USAGE_ERROR);
          }

          const readline = await import("node:readline");
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          const answer = await new Promise<string>((resolve) => {
            rl.question(
              `Overwrite index with ${newEntries.length} entries (${diffs.length} change(s))? [y/N] `,
              resolve,
            );
          });
          rl.close();

          if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
            info("Index repair cancelled");
            return;
          }
        }

        // AC: @task-index-rebuild ac-3 — repair mode: overwrite index
        const result = await splitManager.rebuildIndex(ctx);

        await commitIfShadow(ctx.shadow, `fix: rebuild task index from per-task directories`);

        resultData.repaired = true;

        output(resultData, () => {
          printDiffs(diffs);
          console.log();
          success(`Index rebuilt from ${result.count} per-task directories`);
        });
      } catch (err) {
        // AC: @trait-error-guidance ac-1 — includes description of what went wrong
        // AC: @trait-error-guidance ac-2 — includes suggested action
        // AC: @trait-error-guidance ac-6 — guidance in structured error object
        if (isJsonMode()) {
          output({
            success: false,
            error: String(err instanceof Error ? err.message : err),
            suggestion:
              "Check that .kspec/ directory exists and shadow branch is healthy. Run 'kspec shadow status' for diagnostics.",
          });
        } else {
          error("Failed to rebuild index", err instanceof Error ? err.message : err);
          info(
            "Check that .kspec/ directory exists and shadow branch is healthy. Run 'kspec shadow status' for diagnostics.",
          );
        }
        process.exit(EXIT_CODES.ERROR);
      }
    });
}

/**
 * Print index diff details in human-readable format.
 */
function printDiffs(
  diffs: Array<{
    type: "added" | "removed" | "changed";
    ulid: string;
    title?: string;
    fields?: Array<{ field: string; before: unknown; after: unknown }>;
  }>,
): void {
  const added = diffs.filter((d) => d.type === "added");
  const removed = diffs.filter((d) => d.type === "removed");
  const changed = diffs.filter((d) => d.type === "changed");

  if (added.length > 0) {
    console.log(chalk.green(`  Added (${added.length}):`));
    for (const d of added) {
      console.log(chalk.green(`    + ${d.title} (${d.ulid})`));
    }
  }
  if (removed.length > 0) {
    console.log(chalk.red(`  Removed (${removed.length}):`));
    for (const d of removed) {
      console.log(chalk.red(`    - ${d.title} (${d.ulid})`));
    }
  }
  if (changed.length > 0) {
    console.log(chalk.yellow(`  Changed (${changed.length}):`));
    for (const d of changed) {
      console.log(chalk.yellow(`    ~ ${d.title} (${d.ulid})`));
      if (d.fields) {
        showChangeDiff(d.fields);
      }
    }
  }
}
