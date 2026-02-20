/**
 * Plan import CLI command
 * AC: @plan-import ac-11 through ac-33
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { markMutating } from "../command-annotations.js";
import {
  addChildItem,
  buildIndexes,
  createPlan,
  createSpecItem,
  createTask,
  getAuthor,
  initContext,
  loadAllTasks,
  loadPlans,
  savePlan,
  saveTask,
  updateSpecItem,
  type LoadedSpecItem,
} from "../../parser/index.js";
import {
  parsePlanDocument,
  topologicalSort,
  validateParentRefs,
  type PlanSpec,
} from "../../parser/plan-document.js";
import { commitIfShadow } from "../../parser/shadow.js";
import type { PlanInput, SpecItemInput, TaskInput } from "../../schema/index.js";
import { errors } from "../../strings/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, isJsonMode, output, success, warn } from "../output.js";
import { ulid } from "ulid";

/**
 * Register plan import command
 * AC: @plan-import ac-11, ac-15, ac-32
 */
export function registerPlanImportCommand(planCommand: Command): void {
  markMutating(planCommand.command("import <path>"))
    .description("Import plan document and auto-generate specs/tasks")
    .requiredOption(
      "--module <ref>",
      "Module to add specs under (e.g., @core-module)",
    )
    .option("--dry-run", "Show what would be created without making changes")
    .option("--update", "Update existing specs instead of skipping them")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Format:
  Plan documents use markdown with a ## Specs section containing a fenced
  YAML code block. The YAML must be wrapped in triple-backtick yaml markers:

    ## Specs
    \`\`\`yaml
    - title: My Feature
      type: feature
    \`\`\`

  Without the fenced code block, specs will not be detected.

Examples:
  $ kspec plan import ./plan.md --module @core
  $ kspec plan import ./plan.md --module @api --dry-run
  $ kspec plan import ./plan.md --module @features --update --json`,
    )
    .action(async (planPath: string, options) => {
      try {
        await importPlan(planPath, options);
      } catch (err) {
        error("Failed to import plan", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}

/**
 * Import operation result
 */
interface ImportResult {
  createdSpecs: string[];
  updatedSpecs: string[];
  createdTasks: string[];
  errors: Array<{ message: string; spec?: PlanSpec }>;
  skipped: Array<{ slug: string; reason: string }>;
  planRef: string;
}

/**
 * Import plan document and create specs/tasks
 * AC: @plan-import ac-11 through ac-33
 */
async function importPlan(
  planPath: string,
  options: { module: string; dryRun?: boolean; update?: boolean },
): Promise<void> {
  // JSON mode is set by global preAction hook

  const ctx = await initContext();
  const author = getAuthor(ctx.config?.identity?.author);

  // Read plan file
  // AC: @plan-import ac-21 - Handle file read errors
  const fullPath = path.resolve(process.cwd(), planPath);
  let content: string;
  try {
    content = await fs.readFile(fullPath, "utf-8");
  } catch (err) {
    error(`Failed to read plan file: ${planPath}`, err);
    process.exit(EXIT_CODES.USAGE_ERROR);
  }

  // Parse plan document
  // AC: @plan-import ac-11, ac-12, ac-13, ac-21, ac-22
  const parsed = parsePlanDocument(content);

  // Report parsing errors
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      if (err.type === "yaml") {
        // AC: @plan-import ac-21 - YAML parse errors (fatal)
        error(err.message);
        process.exit(EXIT_CODES.USAGE_ERROR);
      } else if (err.type === "validation") {
        // AC: @plan-import ac-22 - Validation errors (non-fatal, add to warnings)
        warn(err.message);
      }
    }
  }

  // Load plans for cross-namespace slug safety
  const plans = await loadPlans(ctx);

  // Build indexes to check existing specs (include plans for cross-namespace slug safety)
  const { refIndex, items } = await buildIndexes(ctx, plans);
  const existingSpecRefs = new Set<string>();
  for (const item of items) {
    for (const slug of (item as LoadedSpecItem).slugs || []) {
      existingSpecRefs.add(slug);
    }
    existingSpecRefs.add(item._ulid.slice(0, 8));
  }

  // Resolve module reference
  const moduleResult = refIndex.resolve(options.module);
  if (!moduleResult.ok) {
    error(errors.reference.itemNotFound(options.module));
    process.exit(EXIT_CODES.NOT_FOUND);
  }

  const moduleItem = moduleResult.item as LoadedSpecItem;

  // Verify it's a module
  if (moduleItem.type !== "module") {
    error(`${options.module} is not a module (type: ${moduleItem.type})`);
    process.exit(EXIT_CODES.USAGE_ERROR);
  }

  // Validate parent references
  // AC: @plan-import ac-17, ac-33
  const parentErrors = validateParentRefs(parsed.specs, existingSpecRefs);
  parsed.errors.push(...parentErrors);

  // Sort specs topologically
  // AC: @plan-import ac-16, ac-18
  const { sorted, error: sortError } = topologicalSort(parsed.specs);
  if (sortError) {
    // AC: @plan-import ac-18 - Circular dependency detection
    error(sortError.message);
    process.exit(EXIT_CODES.USAGE_ERROR);
  }

  // Create plan record
  // AC: @plan-import ac-24, ac-28
  // Auto-namespace plan slugs with "plan-" prefix to prevent collision with spec slugs
  // Ensure uniqueness across all namespaces (plans + specs + tasks via refIndex)
  let planSlug = `plan-${generateSlug(parsed.title)}`;
  let counter = 1;
  const baseSlug = planSlug;
  while (!refIndex.isSlugAvailable(planSlug)) {
    planSlug = `${baseSlug}-${counter}`;
    counter++;
  }

  // Track all slugs created during this import (refIndex is stale after mutations)
  const importReservedSlugs = new Set<string>([planSlug]);

  const planInput: PlanInput = {
    title: parsed.title,
    content: parsed.content,
    status: "active",
    slugs: [planSlug],
    source_path: fullPath,
  };

  const newPlan = createPlan(planInput);
  const planRef = `@${planSlug}`;

  // AC: @plan-import ac-13 - Attach global implementation notes to plan record
  if (parsed.implementationNotes) {
    newPlan.notes.push({
      _ulid: ulid(),
      created_at: new Date().toISOString(),
      author,
      content: `Implementation notes:\n\n${parsed.implementationNotes}`,
    });
  }

  // Initialize result
  const result: ImportResult = {
    createdSpecs: [],
    updatedSpecs: [],
    createdTasks: [],
    errors: [],
    skipped: [],
    planRef,
  };

  // Add parser validation errors to result
  // AC: @plan-import ac-22, ac-29 - Include parser validation errors in summary
  for (const err of parsed.errors) {
    if (err.type === "validation") {
      result.errors.push({ message: err.message });
    }
  }

  // Track newly created specs for parent resolution
  // AC: @plan-import ac-16 - Resolve local references
  const createdSpecsMap = new Map<string, LoadedSpecItem>();

  // Process specs
  // AC: @plan-import ac-14, ac-16, ac-17, ac-22, ac-23, ac-25, ac-26, ac-29
  for (let i = 0; i < sorted.length; i++) {
    const spec = sorted[i];
    try {
      // Validate required fields first
      // AC: @plan-import ac-22
      if (!spec.title) {
        const errMsg = `Spec at index ${i} missing required field: title`;
        warn(errMsg);
        result.errors.push({ message: errMsg, spec });
        continue;
      }

      const specSlug = spec.slug || generateSlug(spec.title);
      const specRef = `@${specSlug}`;

      // Check against slugs reserved during this import (plan slug, earlier specs)
      if (importReservedSlugs.has(specSlug)) {
        warn(`Spec slug "${specSlug}" collides with another item in this import, skipping`);
        result.skipped.push({ slug: specSlug, reason: "Slug collision within import" });
        continue;
      }

      // Check if spec already exists in pre-import state
      const exists = refIndex.resolve(specRef);

      if (exists.ok && !options.update) {
        // AC: @plan-import ac-14, ac-25 - Skip existing specs
        warn(`Skipping existing spec: ${specRef}`);
        result.skipped.push({ slug: specSlug, reason: "Already exists" });
        continue;
      }

      if (exists.ok && options.update) {
        // AC: @plan-import ac-26 - Update existing spec
        // Updates: description, type, tags, traits, and acceptance_criteria
        const existingSpec = exists.item as LoadedSpecItem;

        if (options.dryRun) {
          info(`Would update spec: ${specRef}`);
          result.updatedSpecs.push(specRef);
        } else {
          // Build updates from plan spec
          const updates: Partial<SpecItemInput> = {};

          if (spec.description !== undefined) {
            updates.description = spec.description;
          }
          if (spec.type !== undefined) {
            updates.type = spec.type as SpecItemInput["type"];
          }
          if (spec.traits !== undefined) {
            updates.traits = spec.traits.map(t => t.startsWith('@') ? t : `@${t}`);
          }
          if (spec.acceptance_criteria !== undefined) {
            updates.acceptance_criteria = spec.acceptance_criteria;
          }

          await updateSpecItem(ctx, existingSpec, updates);
          info(`Updated spec: ${specRef}`);
          result.updatedSpecs.push(specRef);
        }
        continue;
      }

      // Resolve parent reference
      // AC: @plan-import ac-16, ac-17
      let parent: LoadedSpecItem | null = null;
      if (spec.parent) {
        const parentRef = spec.parent.startsWith("@")
          ? spec.parent
          : `@${spec.parent}`;

        // Check if parent was just created in this import
        const parentSlug = parentRef.slice(1);
        if (createdSpecsMap.has(parentSlug)) {
          parent = createdSpecsMap.get(parentSlug)!;
        } else {
          // Check existing specs
          const parentResult = refIndex.resolve(parentRef);

          if (!parentResult.ok) {
            // AC: @plan-import ac-17, ac-33 - Missing parent with hint
            const errMsg = `Parent ${parentRef} not found. Check parent exists or define it earlier in plan`;
            warn(errMsg);
            result.errors.push({ message: errMsg, spec });
            result.skipped.push({ slug: specSlug, reason: "Missing parent" });
            continue;
          }

          parent = parentResult.item as LoadedSpecItem;
        }
      }

      if (options.dryRun) {
        // AC: @plan-import ac-15 - Dry run mode
        info(
          `Would create spec: ${specRef} ${spec.parent ? `under ${spec.parent}` : "(root)"}`,
        );
        result.createdSpecs.push(specRef);
        importReservedSlugs.add(specSlug);

        // Track would-be created spec for parent resolution in dry-run
        const dryRunSpec = createSpecItem({
          title: spec.title,
          type: (spec.type as any) || "feature",
          slugs: [specSlug],
          description: spec.description,
          ...(spec.acceptance_criteria ? { acceptance_criteria: spec.acceptance_criteria } : {}),
          priority: undefined,
          tags: [],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: (spec.traits || []).map(t => t.startsWith('@') ? t : `@${t}`),
          notes: [],
        }) as LoadedSpecItem;
        createdSpecsMap.set(specSlug, dryRunSpec);
      } else {
        // Create spec item
        const specInput: SpecItemInput = {
          title: spec.title,
          type: (spec.type as any) || "feature",
          slugs: [specSlug],
          description: spec.description,
          priority: undefined,
          tags: [],
          depends_on: [],
          implements: [],
          relates_to: [],
          tests: [],
          traits: (spec.traits || []).map(t => t.startsWith('@') ? t : `@${t}`),
          notes: [],
        };

        // Add acceptance criteria if present
        if (spec.acceptance_criteria) {
          specInput.acceptance_criteria = spec.acceptance_criteria;
        }

        const newSpec = createSpecItem(specInput);

        // Add spec to parent (or module if no parent)
        const actualParent = parent || moduleItem;
        const addResult = await addChildItem(ctx, actualParent, newSpec);

        // Track the created spec for parent resolution
        // Need to construct LoadedSpecItem with _sourceFile and _path for nested specs
        const createdSpec: LoadedSpecItem = {
          ...(addResult.item as LoadedSpecItem),
          _sourceFile: actualParent._sourceFile,
          _path: addResult.path,
        };
        createdSpecsMap.set(specSlug, createdSpec);

        result.createdSpecs.push(specRef);
        importReservedSlugs.add(specSlug);
        newPlan.derived_specs.push(specRef);

        info(`Created spec: ${specRef}`);
      }
    } catch (err) {
      const errMsg = `Failed to create spec "${spec.title}": ${err instanceof Error ? err.message : String(err)}`;
      warn(errMsg);
      result.errors.push({ message: errMsg, spec });
    }
  }

  // Derive tasks from specs
  // AC: @plan-import ac-12, ac-13, ac-19, ac-20
  if (parsed.tasks.derive_from_specs && result.createdSpecs.length > 0) {
    const tasks = await loadAllTasks(ctx);
    // Combine existing task slugs + all slugs reserved during this import (plan + specs)
    const importSlugs = new Set([
      ...tasks.flatMap((t) => t.slugs),
      ...importReservedSlugs,
    ]);

    for (const specRef of result.createdSpecs) {
      // Get spec from createdSpecsMap (works in both dry-run and real mode)
      const specSlug = specRef.slice(1);
      const spec = createdSpecsMap.get(specSlug);
      if (!spec) continue;

      // AC: @plan-import ac-20 - Task title follows "Implement X" pattern
      const taskTitle = `Implement ${spec.title}`;
      const taskSlug = generateSlug(taskTitle);

      // Ensure slug uniqueness across all namespaces + this import's slugs
      let uniqueSlug = taskSlug;
      let counter = 1;
      while (importSlugs.has(uniqueSlug) || !refIndex.isSlugAvailable(uniqueSlug)) {
        uniqueSlug = `${taskSlug}-${counter}`;
        counter++;
      }
      importSlugs.add(uniqueSlug);
      importReservedSlugs.add(uniqueSlug);

      if (options.dryRun) {
        info(`Would derive task: @${uniqueSlug} from ${specRef}`);
        result.createdTasks.push(`@${uniqueSlug}`);
      } else {
        // AC: @plan-import ac-19 - Task has both spec_ref and plan_ref
        const taskInput: TaskInput = {
          title: taskTitle,
          type: "task",
          spec_ref: specRef,
          plan_ref: planRef,
          priority: 3,
          slugs: [uniqueSlug],
          tags: [],
          depends_on: [],
          notes: [],
        };

        const newTask = createTask(taskInput);

        // AC: @plan-import ac-13 - Scoped implementation notes
        const planSpec = parsed.specs.find(s =>
          (s.slug || generateSlug(s.title)) === specSlug
        );
        if (planSpec?.implementation_notes) {
          // Per-spec notes go directly to this task
          newTask.notes.push({
            _ulid: ulid(),
            created_at: new Date().toISOString(),
            author,
            content: `Implementation notes:\n\n${planSpec.implementation_notes}`,
          });
        } else if (parsed.implementationNotes) {
          // No per-spec notes — reference the plan
          newTask.notes.push({
            _ulid: ulid(),
            created_at: new Date().toISOString(),
            author,
            content: `See plan ${planRef} for implementation notes`,
          });
        }

        await saveTask(ctx, newTask);
        result.createdTasks.push(`@${uniqueSlug}`);
        newPlan.derived_tasks.push(`@${uniqueSlug}`);

        info(`Derived task: @${uniqueSlug}`);
      }
    }
  }

  // Create manual tasks
  // AC: @plan-import ac-27
  if (parsed.tasks.additional_tasks) {
    // Reload tasks to catch any created by derive loop above
    // Combine with all slugs reserved during this import (plan + specs)
    const manualTasks = await loadAllTasks(ctx);
    const manualImportSlugs = new Set([
      ...manualTasks.flatMap((t) => t.slugs),
      ...importReservedSlugs,
    ]);

    for (const taskDef of parsed.tasks.additional_tasks) {
      const taskSlug = taskDef.slug || generateSlug(taskDef.title);

      // Ensure slug uniqueness across all namespaces + this import's slugs
      let uniqueSlug = taskSlug;
      let counter = 1;
      while (manualImportSlugs.has(uniqueSlug) || !refIndex.isSlugAvailable(uniqueSlug)) {
        uniqueSlug = `${taskSlug}-${counter}`;
        counter++;
      }
      manualImportSlugs.add(uniqueSlug);

      if (options.dryRun) {
        info(`Would create manual task: @${uniqueSlug}`);
        result.createdTasks.push(`@${uniqueSlug}`);
      } else {
        // AC: @plan-import ac-27 - Manual tasks have plan_ref but no spec_ref
        const taskInput: TaskInput = {
          title: taskDef.title,
          type: "task",
          plan_ref: planRef,
          priority: taskDef.priority || 3,
          slugs: [uniqueSlug],
          tags: taskDef.tags || [],
          depends_on: [],
          notes: [],
        };

        if (taskDef.description) {
          taskInput.notes = [
            {
              _ulid: ulid(),
              created_at: new Date().toISOString(),
              author,
              content: taskDef.description,
            },
          ];
        }

        const newTask = createTask(taskInput);
        await saveTask(ctx, newTask);
        result.createdTasks.push(`@${uniqueSlug}`);
        newPlan.derived_tasks.push(`@${uniqueSlug}`);

        info(`Created manual task: @${uniqueSlug}`);
      }
    }
  }

  // Save plan record
  // AC: @plan-import ac-24
  if (!options.dryRun) {
    await savePlan(ctx, newPlan);
    await commitIfShadow(ctx.shadow, "plan-import", planSlug, parsed.title);
  }

  // AC: @plan-import ac-23, ac-29 - Summary output
  const successCount =
    result.createdSpecs.length +
    result.updatedSpecs.length +
    result.createdTasks.length;
  const errorCount = result.errors.length + result.skipped.length;

  // AC: @plan-import ac-32 - JSON output
  if (isJsonMode()) {
    output({
      plan: planRef,
      created_specs: result.createdSpecs,
      updated_specs: result.updatedSpecs,
      created_tasks: result.createdTasks,
      errors: result.errors,
      skipped: result.skipped,
    });
  } else {
    // Human-readable output
    if (options.dryRun) {
      console.log("\nDry run - no changes made\n");
    }

    console.log(`Plan: ${planRef}`);
    console.log(`Created ${result.createdSpecs.length} specs`);
    if (result.updatedSpecs.length > 0) {
      console.log(`Updated ${result.updatedSpecs.length} specs`);
    }
    console.log(`Created ${result.createdTasks.length} tasks`);

    if (result.errors.length > 0) {
      console.log(`\nErrors (${result.errors.length}):`);
      for (const err of result.errors) {
        console.log(`  - ${err.message}`);
      }
    }

    if (result.skipped.length > 0) {
      console.log(`\nSkipped (${result.skipped.length}):`);
      for (const skip of result.skipped) {
        console.log(`  - @${skip.slug}: ${skip.reason}`);
      }
    }

    // AC: @plan-import ac-15, ac-23 - Exit code 0 on success
    if (!options.dryRun && successCount > 0) {
      success(
        `\nImported plan: ${successCount} items created, ${errorCount} errors`,
      );
    }
  }  // end of else block (non-JSON output)

  // Exit code logic
  // AC: @plan-import ac-15 - Dry run exits 0
  // AC: @plan-import ac-23 - Success with some errors still exits 0
  process.exit(EXIT_CODES.SUCCESS);
}

/**
 * Generate URL-safe slug from title
 */
function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}
