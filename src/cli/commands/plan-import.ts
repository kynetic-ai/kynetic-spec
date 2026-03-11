/**
 * Plan import CLI command
 * AC: @plan-import-content-only ac-draft-default through ac-module-stored
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { markMutating } from "../command-annotations.js";
import {
  buildIndexes,
  createPlan,
  initContext,
  loadPlans,
  savePlan,
  type LoadedSpecItem,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import {
  type PlanInput,
  PlanStatusSchema,
} from "../../schema/index.js";
import { errors } from "../../strings/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, isJsonMode, output, success, warn } from "../output.js";

interface ImportOptions {
  module?: string;
  dryRun?: boolean;
  update?: boolean;
  json?: boolean;
  status?: string;
}

interface ImportPreview {
  ref: string;
  title: string;
  status: string;
  content: string;
  module_ref: string | null;
  source_path: string;
  derived_specs: string[];
  derived_tasks: string[];
}

/**
 * Register plan import command.
 * AC: @plan-import-content-only ac-module-optional, ac-status-override, ac-update-ignored
 */
export function registerPlanImportCommand(planCommand: Command): void {
  markMutating(planCommand.command("import <path>"))
    .description("Import a plan document as stored content without deriving work")
    .option("--module <ref>", "Optional module to store on the plan for later derive")
    .option("--status <status>", "Initial plan status (default: draft)")
    .option("--dry-run", "Show the plan record that would be created without saving")
    .option("--update", "Ignored for content-only import; derivation happens separately")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Format:
  Import stores the markdown document as plan content. Specs and tasks are not
  created during import; use "kspec plan derive" after approval to materialize
  the stored document.

Examples:
  $ kspec plan import ./plan.md
  $ kspec plan import ./plan.md --status approved --json
  $ kspec plan import ./plan.md --module @core --dry-run`,
    )
    .action(async (planPath: string, options: ImportOptions) => {
      try {
        await importPlan(planPath, options);
      } catch (err) {
        error("Failed to import plan", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}

/**
 * Import plan document as content-only storage.
 * AC: @plan-import-content-only ac-draft-default through ac-module-stored
 */
async function importPlan(planPath: string, options: ImportOptions): Promise<void> {
  const ctx = await initContext();
  const fullPath = path.resolve(process.cwd(), planPath);

  let content: string;
  try {
    content = await fs.readFile(fullPath, "utf-8");
  } catch (err) {
    error(`Failed to read plan file: ${planPath}`, err);
    process.exit(EXIT_CODES.USAGE_ERROR);
  }

  if (options.update) {
    warn("--update is ignored for content-only import. Use `kspec plan derive` to materialize specs and tasks.");
  }

  const statusResult = PlanStatusSchema.safeParse(options.status || "draft");
  if (!statusResult.success) {
    error(
      `Invalid status: '${options.status}'. Valid values: ${PlanStatusSchema.options.join(", ")}`,
    );
    process.exit(EXIT_CODES.USAGE_ERROR);
  }

  const plans = await loadPlans(ctx);
  const { refIndex } = await buildIndexes(ctx, plans);

  let storedModuleRef: string | null = null;
  if (options.module) {
    const moduleResult = refIndex.resolve(options.module);
    if (!moduleResult.ok) {
      error(errors.reference.itemNotFound(options.module));
      process.exit(EXIT_CODES.NOT_FOUND);
    }

    const moduleItem = moduleResult.item as LoadedSpecItem;
    if (moduleItem.type !== "module") {
      error(`${options.module} is not a module (type: ${moduleItem.type})`);
      process.exit(EXIT_CODES.USAGE_ERROR);
    }

    storedModuleRef = options.module.startsWith("@")
      ? options.module
      : `@${options.module}`;
  }

  const title = extractPlanTitle(content);
  const planSlug = nextAvailablePlanSlug(title, refIndex);
  const preview: ImportPreview = {
    ref: `@${planSlug}`,
    title,
    status: statusResult.data,
    content,
    module_ref: storedModuleRef,
    source_path: fullPath,
    derived_specs: [],
    derived_tasks: [],
  };

  if (options.dryRun) {
    emitImportResult(preview, { dryRun: true });
    return;
  }

  const planInput: PlanInput = {
    title,
    content,
    status: statusResult.data,
    slugs: [planSlug],
    source_path: fullPath,
    module_ref: storedModuleRef,
  };
  const plan = createPlan(planInput);

  await saveImportedPlan(ctx, plan, preview);
}

async function saveImportedPlan(
  ctx: Awaited<ReturnType<typeof initContext>>,
  plan: ReturnType<typeof createPlan>,
  preview: ImportPreview,
): Promise<void> {
  await savePlan(ctx, plan);
  await commitIfShadow(ctx.shadow, "plan-import", plan.slugs[0] || plan._ulid.slice(0, 8), plan.title);
  emitImportResult(
    {
      ...preview,
      ref: plan.slugs[0] ? `@${plan.slugs[0]}` : `@${plan._ulid}`,
    },
    { dryRun: false, createdAt: plan.created_at },
  );
}

function emitImportResult(
  preview: ImportPreview,
  options: { dryRun: boolean; createdAt?: string },
): void {
  const payload = {
    dry_run: options.dryRun,
    plan_ref: preview.ref,
    title: preview.title,
    status: preview.status,
    module_ref: preview.module_ref,
    source_path: preview.source_path,
    created_at: options.createdAt ?? null,
    derived_specs: preview.derived_specs,
    derived_tasks: preview.derived_tasks,
    content: preview.content,
  };

  if (isJsonMode()) {
    output(payload);
    return;
  }

  if (options.dryRun) {
    console.log("Dry run - no changes made\n");
  }

  console.log(`Plan: ${preview.ref}`);
  console.log(`Title: ${preview.title}`);
  console.log(`Status: ${preview.status}`);
  if (preview.module_ref) {
    console.log(`Stored module: ${preview.module_ref}`);
  }
  console.log(`Source: ${preview.source_path}`);
  console.log("Content stored: full document");
  console.log("Derived specs: 0");
  console.log("Derived tasks: 0");

  if (!options.dryRun) {
    success("Imported plan content");
  }
}

function extractPlanTitle(content: string): string {
  const titleMatch = content.match(/^#\s+(.+)$/m);
  return titleMatch ? titleMatch[1].trim() : "Untitled Plan";
}

function nextAvailablePlanSlug(
  title: string,
  refIndex: Awaited<ReturnType<typeof buildIndexes>>["refIndex"],
): string {
  let planSlug = `plan-${generateSlug(title)}`;
  let counter = 1;
  const baseSlug = planSlug;
  while (!refIndex.isSlugAvailable(planSlug)) {
    planSlug = `${baseSlug}-${counter}`;
    counter++;
  }
  return planSlug;
}

/**
 * Generate URL-safe slug from title.
 */
function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}
