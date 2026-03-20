/**
 * Plan CLI commands
 * AC: @plan-crud ac-1, ac-2, ac-3, ac-4, ac-7, ac-8, ac-9, ac-30, ac-31
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { markMutating } from "../command-annotations.js";
import {
  addChildItem,
  addProjectLevelTraitItem,
  buildIndexes,
  createPlan,
  createSpecItem,
  createTask,
  findPlanByRef,
  filterPlansByStatus,
  getAuthor,
  initContext,
  type LoadedPlan,
  type LoadedSpecItem,
  loadAllTasks,
  loadPlans,
  mutatePlanAtomically,
  savePlan,
  saveTask,
  shortestUniqueUlid,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import {
  parsePlanDocument,
  topologicalSort,
  type ParseError,
  type PlanSpec,
  type PlanTask,
} from "../../parser/plan-document.js";
import type {
  Note,
  PlanInput,
  SpecItemInput,
  TaskInput,
} from "../../schema/index.js";
import { errors } from "../../strings/index.js";
import { fieldLabels } from "../../strings/labels.js";
import { formatRelativeTime as formatRelativeTimeUtil } from "../../utils/time.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, isJsonMode, output, success, warn } from "../output.js";
import { ulid } from "ulid";
import { registerPlanImportCommand } from "./plan-import.js";
import {
  getLinkedPlanSummaryTasks,
  isCountedInPlanSummary,
} from "../../lib/plan-summary.js";

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
    exitDeriveWithGuidance(
      errors.reference.planNotFound(ref),
      EXIT_CODES.NOT_FOUND,
      "Check available plans with: kspec plan list",
      {
        ref,
        entity: "plan",
      },
    );
  }

  return plan;
}

function shortPlanRef(plan: LoadedPlan, plans: LoadedPlan[]): string {
  return shortestUniqueUlid(
    plan._ulid,
    plans.map((candidate) => candidate._ulid),
  );
}

async function resolveDeriveModuleRef(
  ctx: Awaited<ReturnType<typeof initContext>>,
  plans: LoadedPlan[],
  foundPlan: LoadedPlan,
  moduleOption?: string,
): Promise<string | null> {
  const moduleRef = moduleOption ?? foundPlan.module_ref ?? null;
  if (!moduleRef) {
    return null;
  }

  const { refIndex } = await buildIndexes(ctx, plans);
  const moduleResult = refIndex.resolve(moduleRef);
  if (!moduleResult.ok) {
    exitDeriveWithGuidance(
      errors.reference.itemNotFound(moduleRef),
      EXIT_CODES.NOT_FOUND,
      "Check available modules with: kspec item list --type module",
      {
        ref: moduleRef,
        entity: "module",
      },
    );
  }

  const moduleItem = moduleResult.item as LoadedSpecItem;
  if (moduleItem.type !== "module") {
    exitDeriveWithGuidance(
      `${moduleRef} is not a module (type: ${moduleItem.type})`,
      EXIT_CODES.USAGE_ERROR,
      "Pass a module @ref from: kspec item list --type module",
      {
        field: "module",
        value: moduleItem.type,
      },
    );
  }

  return moduleRef.startsWith("@") ? moduleRef : `@${moduleRef}`;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

function toRef(ref: string): string {
  return ref.startsWith("@") ? ref : `@${ref}`;
}

function canonicalRef(item: { _ulid: string; slugs: string[] }): string {
  return `@${item.slugs[0] || item._ulid}`;
}

function nextUniqueSlug(baseSlug: string, reservedSlugs: Set<string>): string {
  let slug = baseSlug;
  let counter = 1;
  while (reservedSlugs.has(slug)) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
  reservedSlugs.add(slug);
  return slug;
}

function createNote(content: string, author?: string): Note {
  return {
    _ulid: ulid(),
    created_at: new Date().toISOString(),
    author,
    content,
  };
}

interface DeriveOptions {
  module?: string;
  tasks?: boolean;
  dryRun?: boolean;
}

interface DeriveWarning {
  kind: "spec" | "task" | "plan";
  ref?: string;
  message: string;
}

interface DeriveSkipped {
  kind: "spec" | "task";
  ref: string;
  title: string;
  reason: string;
}

interface DeriveResult {
  dry_run: boolean;
  plan_ref: string;
  module_ref: string;
  created_specs: string[];
  created_tasks: string[];
  skipped: DeriveSkipped[];
  errors: Array<{ type: string; message: string }>;
}

interface MaterializedSpec {
  localSlug: string;
  ref: string;
  item: LoadedSpecItem;
  source: PlanSpec;
}

interface PendingTaskPlan {
  localKey: string;
  ref: string;
  input: TaskInput;
}

function exitDeriveWithGuidance(
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

function emitDeriveResult(result: DeriveResult): void {
  output(result, () => {
    if (result.dry_run) {
      console.log("Dry run - no changes made\n");
    }

    console.log(`Plan: ${result.plan_ref}`);
    console.log(`Module: ${result.module_ref}`);
    console.log(`Created specs: ${result.created_specs.length}`);
    for (const ref of result.created_specs) {
      console.log(`  - ${ref}`);
    }

    console.log(`Created tasks: ${result.created_tasks.length}`);
    for (const ref of result.created_tasks) {
      console.log(`  - ${ref}`);
    }

    if (result.skipped.length > 0) {
      console.log(`Skipped: ${result.skipped.length}`);
      for (const skipped of result.skipped) {
        console.log(`  - ${skipped.ref} (${skipped.title}): ${skipped.reason}`);
      }
    }

    if (result.errors.length > 0) {
      console.log(`Errors: ${result.errors.length}`);
      for (const err of result.errors) {
        console.log(`  - [${err.type}] ${err.message}`);
      }
    }
  });
}

function reportWarnings(warnings: DeriveWarning[]): void {
  for (const warning of warnings) {
    warn(warning.ref ? `${warning.ref}: ${warning.message}` : warning.message);
  }
}

function normalizeSpecTraits(
  spec: PlanSpec,
  refIndex: Awaited<ReturnType<typeof buildIndexes>>["refIndex"],
  createdSpecs: Map<string, MaterializedSpec>,
  warnings: DeriveWarning[],
): string[] {
  const normalized = new Set<string>();

  for (const rawTrait of spec.traits || []) {
    const traitRef = toRef(rawTrait);
    const localTrait = createdSpecs.get(traitRef.slice(1));
    if (localTrait?.item.type === "trait") {
      normalized.add(localTrait.ref);
      continue;
    }

    const resolved = refIndex.resolve(traitRef);
    if (resolved.ok) {
      const item = resolved.item as LoadedSpecItem;
      if (item.type !== "trait") {
        warnings.push({
          kind: "spec",
          ref: spec.slug ? `@${spec.slug}` : undefined,
          message: `${traitRef} resolved to ${item.type}, not a trait. Storing normalized reference for later review.`,
        });
        normalized.add(traitRef);
        continue;
      }

      normalized.add(canonicalRef(item));
      continue;
    }

    normalized.add(traitRef);
  }

  return [...normalized];
}

function normalizeSpecDependencies(
  spec: PlanSpec,
  refIndex: Awaited<ReturnType<typeof buildIndexes>>["refIndex"],
  createdSpecs: Map<string, MaterializedSpec>,
  warnings: DeriveWarning[],
): string[] {
  return (spec.depends_on || []).map((rawDependency) => {
    const dependencyRef = toRef(rawDependency);
    const localDependency = createdSpecs.get(dependencyRef.slice(1));
    if (localDependency) {
      return localDependency.ref;
    }

    const resolved = refIndex.resolve(dependencyRef);
    if (resolved.ok) {
      const item = resolved.item as LoadedSpecItem;
      return canonicalRef(item);
    }

    warnings.push({
      kind: "spec",
      ref: spec.slug ? `@${spec.slug}` : undefined,
      message: `Unresolved dependency ${dependencyRef}. Keeping the reference as-is for later resolution.`,
    });
    return dependencyRef;
  });
}

async function materializePlanSpecs(
  ctx: Awaited<ReturnType<typeof initContext>>,
  foundPlan: LoadedPlan,
  moduleRef: string,
  parsedPlan: ReturnType<typeof parsePlanDocument>,
  refIndex: Awaited<ReturnType<typeof buildIndexes>>["refIndex"],
  items: LoadedSpecItem[],
  reservedSlugs: Set<string>,
  dryRun: boolean,
  warnings: DeriveWarning[],
  skipped: DeriveSkipped[],
): Promise<MaterializedSpec[]> {
  const sortResult = topologicalSort(parsedPlan.specs);
  if (sortResult.error) {
    exitDeriveWithGuidance(
      sortResult.error.message,
      EXIT_CODES.USAGE_ERROR,
      "Fix the parent references in the plan content so they form an acyclic tree.",
      {
        type: sortResult.error.type,
      },
    );
  }

  const createdSpecs = new Map<string, MaterializedSpec>();
  const materialized: MaterializedSpec[] = [];

  const moduleResult = refIndex.resolve(moduleRef);
  if (!moduleResult.ok) {
    exitDeriveWithGuidance(
      errors.reference.itemNotFound(moduleRef),
      EXIT_CODES.NOT_FOUND,
      "Check available modules with: kspec item list --type module",
      {
        ref: moduleRef,
        entity: "module",
      },
    );
  }
  const moduleItem = moduleResult.item as LoadedSpecItem;

  for (const spec of sortResult.sorted) {
    const localSlug = spec.slug || slugify(spec.title);
    const itemType = (spec.type || "feature") as SpecItemInput["type"];
    const itemSlug = nextUniqueSlug(localSlug, reservedSlugs);
    const itemRef = `@${itemSlug}`;

    let parent: LoadedSpecItem | null = null;

    if (!(itemType === "trait" && !spec.parent)) {
      if (spec.parent) {
        const localParent = createdSpecs.get(
          spec.parent.startsWith("@") ? spec.parent.slice(1) : spec.parent,
        );
        if (localParent) {
          parent = localParent.item;
        } else {
          const resolvedParent = refIndex.resolve(spec.parent);
          if (!resolvedParent.ok) {
            const reason = `Parent ${toRef(spec.parent)} not found. Use an existing @ref or add the parent spec to the plan.`;
            warnings.push({ kind: "spec", ref: itemRef, message: reason });
            skipped.push({
              kind: "spec",
              ref: itemRef,
              title: spec.title,
              reason,
            });
            continue;
          }
          parent = resolvedParent.item as LoadedSpecItem;
        }
      } else {
        parent = moduleItem;
      }
    }

    const input: SpecItemInput = {
      title: spec.title,
      type: itemType,
      slugs: [itemSlug],
      description: spec.description,
      priority: spec.priority,
      tags: [],
      acceptance_criteria: spec.acceptance_criteria,
      depends_on: normalizeSpecDependencies(spec, refIndex, createdSpecs, warnings),
      implements: [],
      relates_to: [],
      tests: [],
      traits: normalizeSpecTraits(spec, refIndex, createdSpecs, warnings),
      notes: [],
    };

    const newItem = createSpecItem(input);

    let createdItem: LoadedSpecItem;
    if (dryRun) {
      createdItem = {
        ...newItem,
        _sourceFile: parent?._sourceFile,
      } as LoadedSpecItem;
    } else if (itemType === "trait" && !spec.parent) {
      const addResult = await addProjectLevelTraitItem(ctx, newItem);
      createdItem = {
        ...(addResult.item as LoadedSpecItem),
        _sourceFile: ctx.manifestPath || undefined,
        _path: addResult.path,
      };
    } else {
      const addResult = await addChildItem(ctx, parent!, newItem);
      createdItem = {
        ...(addResult.item as LoadedSpecItem),
        _sourceFile: parent!._sourceFile,
        _path: addResult.path,
      };
    }

    const materializedSpec: MaterializedSpec = {
      localSlug,
      ref: itemRef,
      item: createdItem,
      source: spec,
    };
    createdSpecs.set(localSlug, materializedSpec);
    materialized.push(materializedSpec);
  }

  return materialized;
}

function buildTaskPlans(
  planRef: string,
  specItems: MaterializedSpec[],
  deriveFromSpecs: boolean | undefined,
  additionalTasks: PlanTask[] | undefined,
  refIndex: Awaited<ReturnType<typeof buildIndexes>>["refIndex"],
  allTasks: Awaited<ReturnType<typeof loadAllTasks>>,
  reservedSlugs: Set<string>,
  author: string | undefined,
  warnings: DeriveWarning[],
): PendingTaskPlan[] {
  const taskPlans: PendingTaskPlan[] = [];
  const specTaskRefByLocalSlug = new Map<string, string>();
  const taskRefByLocalKey = new Map<string, string>();
  const shouldDeriveFromSpecs = deriveFromSpecs !== false;

  if (shouldDeriveFromSpecs) {
    for (const specItem of specItems) {
      const taskSlug = nextUniqueSlug(
        slugify(`implement-${specItem.source.title}`),
        reservedSlugs,
      );
      const taskRef = `@${taskSlug}`;
      specTaskRefByLocalSlug.set(specItem.localSlug, taskRef);
      taskRefByLocalKey.set(specItem.localSlug, taskRef);
    }
  }

  for (const task of additionalTasks || []) {
    const localKey = task.slug || slugify(task.title);
    const taskSlug = nextUniqueSlug(task.slug || localKey, reservedSlugs);
    taskRefByLocalKey.set(localKey, `@${taskSlug}`);
  }

  if (shouldDeriveFromSpecs) {
    for (const specItem of specItems) {
      const taskRef = specTaskRefByLocalSlug.get(specItem.localSlug)!;
      const taskSlug = taskRef.slice(1);
      const dependsOn = (specItem.item.depends_on || []).map((dependencyRef) => {
        const localDependency = specTaskRefByLocalSlug.get(dependencyRef.slice(1));
        return localDependency || dependencyRef;
      });

      const notes = specItem.source.implementation_notes
        ? [createNote(specItem.source.implementation_notes, author)]
        : [];

      taskPlans.push({
        localKey: specItem.localSlug,
        ref: taskRef,
        input: {
          title: `Implement ${specItem.source.title}`,
          type: "task",
          slugs: [taskSlug],
          spec_ref: specItem.ref,
          plan_ref: planRef,
          priority: specItem.source.priority ?? 3,
          tags: [],
          depends_on: dependsOn,
          notes,
          origin: "derived",
          derivation: "auto",
        },
      });
    }
  }

  for (const task of additionalTasks || []) {
    const localKey = task.slug || slugify(task.title);
    const taskRef = taskRefByLocalKey.get(localKey)!;
    const taskSlug = taskRef.slice(1);

    const specRef = task.spec_ref
      ? (() => {
          const localSpec = specItems.find(
            (candidate) =>
              candidate.localSlug ===
              (task.spec_ref!.startsWith("@")
                ? task.spec_ref!.slice(1)
                : task.spec_ref!),
          );
          if (localSpec) {
            return localSpec.ref;
          }

          const resolved = refIndex.resolve(task.spec_ref!);
          if (resolved.ok) {
            return canonicalRef(resolved.item as LoadedSpecItem);
          }

          warnings.push({
            kind: "task",
            ref: taskRef,
            message: `Unresolved spec_ref ${toRef(task.spec_ref!)} on additional task. Keeping normalized reference.`,
          });
          return toRef(task.spec_ref!);
        })()
      : null;

    const dependsOn = (task.depends_on || []).map((dependencyRef) => {
      const normalized = toRef(dependencyRef);
      const localTaskDependency = taskRefByLocalKey.get(normalized.slice(1));
      if (localTaskDependency) {
        return localTaskDependency;
      }

      const resolved = refIndex.resolve(normalized);
      if (resolved.ok) {
        return canonicalRef(resolved.item as LoadedSpecItem);
      }

      warnings.push({
        kind: "task",
        ref: taskRef,
        message: `Unresolved depends_on ${normalized} on additional task. Keeping normalized reference.`,
      });
      return normalized;
    });

    taskPlans.push({
      localKey,
      ref: taskRef,
      input: {
        title: task.title,
        type: "task",
        slugs: [taskSlug],
        description: task.description,
        spec_ref: specRef,
        plan_ref: planRef,
        priority: task.priority ?? 3,
        tags: task.tags || [],
        depends_on: dependsOn,
        notes: [],
        origin: "derived",
      },
    });
  }

  const existingTaskSlugs = new Set(allTasks.flatMap((task) => task.slugs));
  for (const taskPlan of taskPlans) {
    if (existingTaskSlugs.has(taskPlan.input.slugs?.[0] || "")) {
      warnings.push({
        kind: "task",
        ref: taskPlan.ref,
        message: "Task slug collided with existing work and was renumbered.",
      });
    }
  }

  return taskPlans;
}

/**
 * Register the 'plan' command group
 */
export function registerPlanCommands(program: Command): void {
  const plan = program
    .command("plan")
    .description("Manage implementation plans");

  // Register plan import subcommand
  registerPlanImportCommand(plan);

  // kspec plan add
  // AC: @plan-crud ac-1, ac-2
  markMutating(plan.command("add"))
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

        // Validate title is non-empty
        if (!options.title || options.title.trim().length === 0) {
          error("Plan title cannot be empty.");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        // Generate URL-safe slug from title
        const generateSlug = (title: string): string => {
          return title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 50);
        };

        // Auto-namespace plan slugs with "plan-" prefix to prevent collision with spec slugs
        // If user provides a slug, check for collision with spec items and plans
        // If no slug provided, auto-generate with "plan-" prefix and ensure uniqueness
        const plans = await loadPlans(ctx);
        let planSlug = options.slug || `plan-${generateSlug(options.title)}`;

        // Check for collision with spec items and plans
        const { refIndex } = await buildIndexes(ctx, plans);
        if (options.slug) {
          // Manual slug: check for collision across all namespaces (specs/tasks/plans)
          if (!refIndex.isSlugAvailable(options.slug)) {
            error(`Slug "${options.slug}" collides with existing item. Use a different slug or omit --slug for auto-namespaced slug.`);
            process.exit(EXIT_CODES.CONFLICT);
          }
        } else {
          // Auto-generated slug: ensure uniqueness across all namespaces
          let counter = 1;
          const baseSlug = planSlug;
          while (!refIndex.isSlugAvailable(planSlug)) {
            planSlug = `${baseSlug}-${counter}`;
            counter++;
          }
        }

        const input: PlanInput = {
          title: options.title,
          content,
          status: options.status || "draft",
          slugs: [planSlug],
        };

        const newPlan = createPlan(input);
        await savePlan(ctx, newPlan);
        const planRef = shortPlanRef(newPlan, [...plans, newPlan]);

        // AC: @plan-crud ac-1 - auto-commit to shadow branch
        await commitIfShadow(ctx.shadow, "plan-add", newPlan.slugs[0] || newPlan._ulid.slice(0, 8), options.title);

        success(`Created plan: ${planRef} - ${newPlan.title}`, {
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

          if (foundPlan.module_ref) {
            console.log(`Module:   ${foundPlan.module_ref}`);
          }

          if (foundPlan.source_path) {
            console.log(`Source:   ${foundPlan.source_path}`);
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

  // kspec plan export <ref>
  // AC: @plan-export ac-stdout, ac-output-file, ac-empty, ac-not-found, ac-json
  plan
    .command("export <ref>")
    .description("Export stored plan content to stdout or a file")
    .option("--output <path>", "Write plan content to the specified file")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec plan export @plan-ref
  $ kspec plan export @plan-ref --output ./plan.md
  $ kspec plan export @plan-ref --json`,
    )
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const foundPlan = await findPlanByRef(ctx, ref);

        if (!foundPlan) {
          error(errors.reference.planNotFound(ref));
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        if (foundPlan.content.length === 0) {
          error("Plan has no content to export");
          process.exit(EXIT_CODES.USAGE_ERROR);
        }

        if (isJsonMode()) {
          output(foundPlan);
          return;
        }

        if (options.output) {
          const outputPath = path.resolve(process.cwd(), options.output);
          try {
            await fs.writeFile(outputPath, foundPlan.content, "utf-8");
          } catch (err) {
            error(`Failed to write plan export file: ${options.output}`, err);
            process.exit(EXIT_CODES.ERROR);
          }
          success(`Exported plan content to ${options.output}`);
          return;
        }

        process.stdout.write(foundPlan.content);
      } catch (err) {
        error("Failed to export plan", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec plan set <ref>
  // AC: @plan-crud ac-3, ac-4
  markMutating(plan.command("set <ref>"))
    .description("Update plan fields")
    .option("--title <title>", "Update title")
    .option("--status <status>", "Update status")
    .option("--slug <slug>", "Add a slug")
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const plans = await loadPlans(ctx);
        const foundPlan = resolvePlanRef(ref, plans);
        const foundPlanRef = shortPlanRef(foundPlan, plans);
        const terminalTransitionError = "__PLAN_TERMINAL_STATUS_TRANSITION__";

        const changes: string[] = [];

        if (options.slug) {
          if (!foundPlan.slugs.includes(options.slug)) {
            // Check for collision with specs/tasks/plans
            const { refIndex } = await buildIndexes(ctx, plans);
            if (!refIndex.isSlugAvailable(options.slug)) {
              error(`Slug "${options.slug}" collides with existing item. Use a different slug.`);
              process.exit(EXIT_CODES.CONFLICT);
            }
          }
        }

        if (!options.title && !options.status && !options.slug) {
          info("No changes specified");
          return;
        }

        let updatedPlan: LoadedPlan;
        try {
          updatedPlan = await mutatePlanAtomically(ctx, foundPlan, (latestPlan) => {
            // AC: @plan-crud ac-4 - prevent transitions from terminal states
            if (
              options.status &&
              (latestPlan.status === "completed" ||
                latestPlan.status === "rejected")
            ) {
              throw new Error(terminalTransitionError);
            }

            const nextPlan: LoadedPlan = {
              ...latestPlan,
              slugs: [...latestPlan.slugs],
              derived_tasks: [...latestPlan.derived_tasks],
              derived_specs: [...latestPlan.derived_specs],
              notes: [...latestPlan.notes],
            };

            if (options.title) {
              nextPlan.title = options.title;
              changes.push("title");
            }

            if (options.status) {
              const oldStatus = latestPlan.status;
              nextPlan.status = options.status;
              changes.push(`status: ${oldStatus} → ${options.status}`);

              // AC: @plan-crud ac-3 - set approved_at timestamp when transitioning to approved
              if (options.status === "approved" && !nextPlan.approved_at) {
                nextPlan.approved_at = new Date().toISOString();
              }
            }

            if (options.slug && !nextPlan.slugs.includes(options.slug)) {
              nextPlan.slugs.push(options.slug);
              changes.push(`slug: +${options.slug}`);
            }

            return nextPlan;
          });
        } catch (err) {
          if (
            err instanceof Error &&
            err.message === terminalTransitionError
          ) {
            error("Cannot transition from terminal status");
            process.exit(EXIT_CODES.CONFLICT);
          }
          throw err;
        }

        if (changes.length === 0) {
          info("No changes specified");
          return;
        }

        await commitIfShadow(
          ctx.shadow,
          "plan-set",
          updatedPlan.slugs[0] || updatedPlan._ulid.slice(0, 8),
          changes.join(", "),
        );

        success(`Updated plan: ${foundPlanRef}`, {
          changes,
          plan: updatedPlan,
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
        const tasks = await loadAllTasks(ctx);

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
            const ref = shortPlanRef(p, plans);
            const age = formatRelativeTime(p.created_at);
            const taskCount = getLinkedPlanSummaryTasks(p, tasks).filter((task) =>
              isCountedInPlanSummary(task),
            ).length;
            const taskLabel =
              taskCount > 0 ? ` [${taskCount} task${taskCount > 1 ? "s" : ""}]` : "";

            console.log(
              `  ${ref} [${p.status}]${taskLabel} ${p.title}`,
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
  markMutating(plan.command("note <ref> <text>"))
    .description("Add a note to a plan")
    .action(async (ref: string, text: string) => {
      try {
        const ctx = await initContext();
        const author = getAuthor(ctx.config?.identity?.author);
        const plans = await loadPlans(ctx);
        const foundPlan = resolvePlanRef(ref, plans);
        const foundPlanRef = shortPlanRef(foundPlan, plans);

        // AC: @plan-crud ac-9 - append note with ULID, timestamp, author
        const note = {
          _ulid: ulid(),
          created_at: new Date().toISOString(),
          author,
          content: text,
        };

        const updatedPlan = await mutatePlanAtomically(
          ctx,
          foundPlan,
          (latestPlan) => ({
            ...latestPlan,
            notes: [...latestPlan.notes, note],
          }),
        );

        await commitIfShadow(
          ctx.shadow,
          "plan-note",
          updatedPlan.slugs[0] || updatedPlan._ulid.slice(0, 8),
        );

        success(`Added note to plan: ${foundPlanRef}`, {
          note,
        });
      } catch (err) {
        error(errors.failures.addPlanNote, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec plan derive <ref>
  // AC: @plan-derive-enhanced ac-parse-content through ac-commit
  markMutating(plan.command("derive <ref>"))
    .description("Materialize plan content into specs and optional tasks")
    .option(
      "--module <ref>",
      "Module context for derivation (overrides stored plan module)",
    )
    .option("--tasks", "Also derive implementation tasks after creating specs")
    .option("--dry-run", "Preview derived specs/tasks without saving changes")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec plan derive @plan-ref --module @core
  $ kspec plan derive @plan-ref --tasks
  $ kspec plan derive @plan-ref --module @core --tasks --dry-run`,
    )
    .action(async (ref: string, options: DeriveOptions) => {
      try {
        const ctx = await initContext();
        const plans = await loadPlans(ctx);
        const foundPlan = resolvePlanRef(ref, plans);
        const planRef = canonicalRef(foundPlan);
        const author = getAuthor(ctx.config?.identity?.author);

        if (foundPlan.status === "active") {
          exitDeriveWithGuidance(
            "Plan already derived. Manage specs directly via kspec item set.",
            EXIT_CODES.CONFLICT,
            `Update derived work directly, for example: kspec item set ${planRef} ...`,
            {
              current_status: foundPlan.status,
              valid_next_states: ["manage-derived-work"],
            },
          );
        }

        if (foundPlan.status !== "approved") {
          exitDeriveWithGuidance(
            `Plan must be in approved status to derive (current: ${foundPlan.status})`,
            EXIT_CODES.CONFLICT,
            `Approve the plan first with: kspec plan set ${planRef} --status approved`,
            {
              current_status: foundPlan.status,
              valid_next_states: ["approved"],
            },
          );
        }

        const parsedPlan = parsePlanDocument(foundPlan.content);
        const errorsList: Array<{ type: string; message: string }> = [];
        const warnings: DeriveWarning[] = [];
        const skipped: DeriveSkipped[] = [];

        for (const parseError of parsedPlan.errors) {
          if (parseError.type === "yaml") {
            exitDeriveWithGuidance(
              parseError.message,
              EXIT_CODES.USAGE_ERROR,
              "Fix the YAML block in the plan document and run kspec plan derive again.",
              {
                type: parseError.type,
              },
            );
          }
          errorsList.push({
            type: parseError.type,
            message: parseError.message,
          });
        }

        const hasSpecsToMaterialize = parsedPlan.specs.length > 0;
        const hasManualTasksToMaterialize = Boolean(
          options.tasks &&
            parsedPlan.tasks.additional_tasks &&
            parsedPlan.tasks.additional_tasks.length > 0,
        );

        if (!hasSpecsToMaterialize && !hasManualTasksToMaterialize) {
          exitDeriveWithGuidance(
            "Plan does not define derivable work. Add specs or run with --tasks when the plan defines manual tasks.",
            EXIT_CODES.USAGE_ERROR,
            "Add a ## Specs section with a ```yaml fenced block, or define tasks in ## Tasks and re-run with --tasks.",
          );
        }

        let moduleRef = "";
        if (hasSpecsToMaterialize) {
          const resolvedModuleRef = await resolveDeriveModuleRef(
            ctx,
            plans,
            foundPlan,
            options.module,
          );
          if (!resolvedModuleRef) {
            exitDeriveWithGuidance(
              "Plan derive requires --module when the plan has no stored module ref",
              EXIT_CODES.USAGE_ERROR,
              `Re-run with a module, for example: kspec plan derive ${planRef} --module @your-module`,
              {
                field: "module",
                value: null,
              },
            );
          }
          moduleRef = resolvedModuleRef;
        } else {
          moduleRef = foundPlan.module_ref ?? options.module ?? "";
        }

        const { refIndex, items, tasks } = await buildIndexes(ctx, plans);
        const reservedSlugs = new Set([
          ...plans.flatMap((plan) => plan.slugs),
          ...items.flatMap((item) => item.slugs),
          ...tasks.flatMap((task) => task.slugs),
        ]);

        const materializedSpecs = hasSpecsToMaterialize
          ? await materializePlanSpecs(
              ctx,
              foundPlan,
              moduleRef,
              parsedPlan,
              refIndex,
              items,
              reservedSlugs,
              Boolean(options.dryRun),
              warnings,
              skipped,
            )
          : [];

        const createdSpecRefs = materializedSpecs.map((item) => item.ref);

        let taskPlans: PendingTaskPlan[] = [];
        if (options.tasks) {
          taskPlans = buildTaskPlans(
            planRef,
            materializedSpecs,
            parsedPlan.tasks.derive_from_specs,
            parsedPlan.tasks.additional_tasks,
            refIndex,
            tasks,
            reservedSlugs,
            author,
            warnings,
          );
        }

        const createdTaskRefs = taskPlans.map((taskPlan) => taskPlan.ref);

        if (!options.dryRun) {
          for (const taskPlan of taskPlans) {
            const newTask = createTask(taskPlan.input);
            await saveTask(ctx, newTask);
          }

          const updatedPlan = await mutatePlanAtomically(ctx, foundPlan, (latestPlan) => {
            const nextPlan: LoadedPlan = {
              ...latestPlan,
              slugs: [...latestPlan.slugs],
              derived_tasks: [...latestPlan.derived_tasks],
              derived_specs: [...latestPlan.derived_specs],
              notes: [...latestPlan.notes],
            };

            for (const specRef of createdSpecRefs) {
              if (!nextPlan.derived_specs.includes(specRef)) {
                nextPlan.derived_specs.push(specRef);
              }
            }

            for (const taskRef of createdTaskRefs) {
              if (!nextPlan.derived_tasks.includes(taskRef)) {
                nextPlan.derived_tasks.push(taskRef);
              }
            }

            nextPlan.status = "active";

            if (parsedPlan.implementationNotes?.trim()) {
              nextPlan.notes.push(createNote(parsedPlan.implementationNotes.trim(), author));
            }

            return nextPlan;
          });

          await commitIfShadow(
            ctx.shadow,
            "plan-derive",
            updatedPlan.slugs[0] || updatedPlan._ulid.slice(0, 8),
            `${createdSpecRefs.length} specs${options.tasks ? `, ${createdTaskRefs.length} tasks` : ""}`,
          );
        } else if (parsedPlan.implementationNotes?.trim()) {
          warnings.push({
            kind: "plan",
            ref: planRef,
            message: "Global implementation notes would be added to the plan during execution.",
          });
        }

        reportWarnings(warnings);
        emitDeriveResult({
          dry_run: Boolean(options.dryRun),
          plan_ref: planRef,
          module_ref: moduleRef,
          created_specs: createdSpecRefs,
          created_tasks: createdTaskRefs,
          skipped,
          errors: errorsList,
        });
      } catch (err) {
        error("Failed to derive plan content", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
