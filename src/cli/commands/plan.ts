/**
 * Plan CLI commands
 * AC: @plan-crud ac-1, ac-2, ac-3, ac-4, ac-7, ac-8, ac-9, ac-30, ac-31
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import {
  createPlan,
  createTask,
  findPlanByRef,
  filterPlansByStatus,
  getAuthor,
  initContext,
  type LoadedPlan,
  loadAllTasks,
  loadPlans,
  savePlan,
  saveTask,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import type { PlanInput, TaskInput } from "../../schema/index.js";
import { errors } from "../../strings/index.js";
import { fieldLabels } from "../../strings/labels.js";
import { formatRelativeTime as formatRelativeTimeUtil } from "../../utils/time.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, output, success } from "../output.js";
import { ulid } from "ulid";

/**
 * Format relative time for display
 */
function formatRelativeTime(dateStr: string): string {
  return formatRelativeTimeUtil(new Date(dateStr));
}

/**
 * Resolve plan ref with error handling
 * AC: @plan-crud ac-8 - get plan by reference
 */
function resolvePlanRef(ref: string, plans: LoadedPlan[]): LoadedPlan {
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;
  const plan = plans.find(
    (p) =>
      p._ulid === cleanRef ||
      p._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
      p.slugs.includes(cleanRef),
  );

  if (!plan) {
    error(errors.reference.planNotFound(ref));
    process.exit(EXIT_CODES.NOT_FOUND);
  }

  return plan;
}

/**
 * Register the 'plan' command group
 */
export function registerPlanCommands(program: Command): void {
  const plan = program
    .command("plan")
    .description("Manage implementation plans");

  // kspec plan add
  // AC: @plan-crud ac-1, ac-2
  plan
    .command("add")
    .description("Create a new plan")
    .requiredOption("--title <title>", "Plan title")
    .option("--content <text>", "Plan content (markdown)")
    .option("--content-file <path>", "Read content from markdown file")
    .option("--status <status>", "Initial status (default: draft)")
    .option("--slug <slug>", "Optional slug for the plan")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec plan add --title "User Auth" --content "Implement JWT auth..."
  $ kspec plan add --title "API Refactor" --content-file ./plan.md`,
    )
    .action(async (options) => {
      try {
        const ctx = await initContext();

        // Validate content options
        if (options.content && options.contentFile) {
          error(
            "Cannot specify both --content and --content-file. Choose one.",
          );
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // Read content from file if specified
        // AC: @plan-crud ac-2
        let content = options.content || "";
        if (options.contentFile) {
          const contentPath = path.resolve(process.cwd(), options.contentFile);
          try {
            content = await fs.readFile(contentPath, "utf-8");
          } catch (err) {
            error(`Failed to read content file: ${options.contentFile}`, err);
            process.exit(EXIT_CODES.ERROR);
          }
        }

        const input: PlanInput = {
          title: options.title,
          content,
          status: options.status || "draft",
          slugs: options.slug ? [options.slug] : [],
        };

        const newPlan = createPlan(input);
        await savePlan(ctx, newPlan);

        // AC: @plan-crud ac-1 - auto-commit to shadow branch
        await commitIfShadow(ctx.shadow, "plan-add", newPlan.slugs[0] || newPlan._ulid.slice(0, 8), options.title);

        success(`Created plan: ${newPlan._ulid.slice(0, 8)} - ${newPlan.title}`, {
          plan: newPlan,
        });
      } catch (err) {
        error(errors.failures.createPlan, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec plan get <ref>
  // AC: @plan-crud ac-8, ac-30
  plan
    .command("get <ref>")
    .description("Show plan details")
    .option("--json", "Output as JSON")
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const plans = await loadPlans(ctx);
        const foundPlan = resolvePlanRef(ref, plans);

        // AC: @plan-crud ac-30 - JSON output
        output(foundPlan, () => {
          // AC: @plan-crud ac-8 - full plan display
          console.log(`${fieldLabels.ulid}     ${foundPlan._ulid}`);
          console.log(`${fieldLabels.title}    ${foundPlan.title}`);
          console.log(`${fieldLabels.status}   ${foundPlan.status}`);

          if (foundPlan.slugs.length > 0) {
            console.log(`Slugs:    ${foundPlan.slugs.join(", ")}`);
          }

          console.log(
            `${fieldLabels.created}  ${foundPlan.created_at} (${formatRelativeTime(foundPlan.created_at)})`,
          );

          if (foundPlan.approved_at) {
            console.log(
              `Approved: ${foundPlan.approved_at} (${formatRelativeTime(foundPlan.approved_at)})`,
            );
          }

          if (foundPlan.completed_at) {
            console.log(
              `Completed: ${foundPlan.completed_at} (${formatRelativeTime(foundPlan.completed_at)})`,
            );
          }

          // Show derived work
          if (
            foundPlan.derived_tasks.length > 0 ||
            foundPlan.derived_specs.length > 0
          ) {
            console.log("\nDerived Work:");
            if (foundPlan.derived_specs.length > 0) {
              console.log(
                `  Specs: ${foundPlan.derived_specs.join(", ")}`,
              );
            }
            if (foundPlan.derived_tasks.length > 0) {
              console.log(
                `  Tasks: ${foundPlan.derived_tasks.join(", ")}`,
              );
            }
          }

          // Show content
          if (foundPlan.content) {
            console.log("\n─── Content ───");
            console.log(foundPlan.content);
          }

          // Show notes
          if (foundPlan.notes.length > 0) {
            console.log("\n─── Notes ───");
            for (const note of foundPlan.notes) {
              const age = formatRelativeTime(note.created_at);
              const author = note.author ? ` by ${note.author}` : "";
              console.log(`\n[${age}${author}]`);
              console.log(note.content);
            }
          }
        });
      } catch (err) {
        error(errors.failures.getPlan, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec plan set <ref>
  // AC: @plan-crud ac-3, ac-4
  plan
    .command("set <ref>")
    .description("Update plan fields")
    .option("--title <title>", "Update title")
    .option("--status <status>", "Update status")
    .option("--slug <slug>", "Add a slug")
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const plans = await loadPlans(ctx);
        const foundPlan = resolvePlanRef(ref, plans);

        // AC: @plan-crud ac-4 - prevent transitions from terminal states
        if (
          options.status &&
          (foundPlan.status === "completed" || foundPlan.status === "rejected")
        ) {
          error("Cannot transition from terminal status");
          process.exit(EXIT_CODES.CONFLICT);
        }

        const changes: string[] = [];

        if (options.title) {
          foundPlan.title = options.title;
          changes.push("title");
        }

        if (options.status) {
          const oldStatus = foundPlan.status;
          foundPlan.status = options.status;
          changes.push(`status: ${oldStatus} → ${options.status}`);

          // AC: @plan-crud ac-3 - set approved_at timestamp when transitioning to approved
          if (options.status === "approved" && !foundPlan.approved_at) {
            foundPlan.approved_at = new Date().toISOString();
          }
        }

        if (options.slug) {
          if (!foundPlan.slugs.includes(options.slug)) {
            foundPlan.slugs.push(options.slug);
            changes.push(`slug: +${options.slug}`);
          }
        }

        if (changes.length === 0) {
          info("No changes specified");
          return;
        }

        await savePlan(ctx, foundPlan);
        await commitIfShadow(
          ctx.shadow,
          "plan-set",
          foundPlan.slugs[0] || foundPlan._ulid.slice(0, 8),
          changes.join(", "),
        );

        success(`Updated plan: ${foundPlan._ulid.slice(0, 8)}`, {
          changes,
          plan: foundPlan,
        });
      } catch (err) {
        error(errors.failures.updatePlan, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec plan list
  // AC: @plan-crud ac-7, ac-31
  plan
    .command("list")
    .description("List plans")
    .option("--status <status>", "Filter by status")
    .option("--json", "Output as JSON array")
    .action(async (options) => {
      try {
        const ctx = await initContext();
        let plans = await loadPlans(ctx);

        // AC: @plan-crud ac-7 - status filter
        if (options.status) {
          plans = filterPlansByStatus(plans, options.status);
        }

        // Sort by created date (newest first)
        plans.sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );

        // AC: @plan-crud ac-31 - JSON output
        output(plans, () => {
          if (plans.length === 0) {
            console.log("No plans found");
            return;
          }

          console.log(`Plans (${plans.length}):\n`);

          for (const p of plans) {
            const ref = p._ulid.slice(0, 8);
            const age = formatRelativeTime(p.created_at);
            const taskCount = p.derived_tasks.length;
            const tasks =
              taskCount > 0 ? ` [${taskCount} task${taskCount > 1 ? "s" : ""}]` : "";

            console.log(
              `  ${ref} [${p.status}]${tasks} ${p.title}`,
            );
            console.log(`         Created ${age}`);

            if (p.approved_at) {
              console.log(
                `         Approved ${formatRelativeTime(p.approved_at)}`,
              );
            }

            console.log("");
          }
        });
      } catch (err) {
        error(errors.failures.listPlans, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec plan note <ref> <text>
  // AC: @plan-crud ac-9
  plan
    .command("note <ref> <text>")
    .description("Add a note to a plan")
    .action(async (ref: string, text: string) => {
      try {
        const ctx = await initContext();
        const author = getAuthor();
        const plans = await loadPlans(ctx);
        const foundPlan = resolvePlanRef(ref, plans);

        // AC: @plan-crud ac-9 - append note with ULID, timestamp, author
        const note = {
          _ulid: ulid(),
          created_at: new Date().toISOString(),
          author,
          content: text,
        };

        foundPlan.notes.push(note);
        await savePlan(ctx, foundPlan);
        await commitIfShadow(
          ctx.shadow,
          "plan-note",
          foundPlan.slugs[0] || foundPlan._ulid.slice(0, 8),
        );

        success(`Added note to plan: ${foundPlan._ulid.slice(0, 8)}`, {
          note,
        });
      } catch (err) {
        error(errors.failures.addPlanNote, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec plan derive <ref>
  // AC: @plan-derive ac-5, ac-6
  plan
    .command("derive <ref>")
    .description("Create a task from a plan")
    .option("--title <title>", "Override task title")
    .option("--priority <n>", "Set task priority (1-5)", parseInt)
    .addHelpText(
      "after",
      `
Examples:
  $ kspec plan derive @plan-ref
  $ kspec plan derive @plan-ref --title "Custom title"
  $ kspec plan derive @plan-ref --priority 1`,
    )
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const plans = await loadPlans(ctx);
        const tasks = await loadAllTasks(ctx);
        const foundPlan = resolvePlanRef(ref, plans);

        // AC: @plan-derive ac-5 - check plan status
        if (foundPlan.status !== "approved" && foundPlan.status !== "active") {
          error(
            `Plan must be in 'approved' or 'active' status to derive tasks (current: ${foundPlan.status})`,
          );
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // Generate task slug from plan title
        const generateSlug = (title: string): string => {
          return title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 50);
        };

        // Generate task title and slug
        const taskTitle = options.title || `Implement: ${foundPlan.title}`;
        let taskSlug = generateSlug(taskTitle);

        // Ensure slug uniqueness
        let slugSuffix = 1;
        const originalSlug = taskSlug;
        while (tasks.some((t) => t.slugs.includes(taskSlug))) {
          taskSlug = `${originalSlug}-${slugSuffix}`;
          slugSuffix++;
        }

        // AC: @plan-derive ac-5 - create task with plan_ref
        const planRef = foundPlan.slugs[0]
          ? `@${foundPlan.slugs[0]}`
          : `@${foundPlan._ulid.slice(0, 8)}`;

        const taskInput: TaskInput = {
          title: taskTitle,
          type: "task",
          plan_ref: planRef,
          priority: options.priority ?? 3,
          slugs: [taskSlug],
          tags: [],
          depends_on: [],
          notes: [],
        };

        const newTask = createTask(taskInput);
        await saveTask(ctx, newTask);

        // AC: @plan-derive ac-5 - update plan's derived_tasks array
        const taskRef = `@${taskSlug}`;
        if (!foundPlan.derived_tasks.includes(taskRef)) {
          foundPlan.derived_tasks.push(taskRef);
        }

        // AC: @plan-derive ac-5 - transition plan to active if not already
        if (foundPlan.status === "approved") {
          foundPlan.status = "active";
        }

        await savePlan(ctx, foundPlan);

        await commitIfShadow(
          ctx.shadow,
          "plan-derive",
          foundPlan.slugs[0] || foundPlan._ulid.slice(0, 8),
          taskTitle,
        );

        success(`Created task from plan: ${taskRef}`, {
          task: newTask,
          plan: foundPlan,
        });
      } catch (err) {
        error("Failed to derive task from plan", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
