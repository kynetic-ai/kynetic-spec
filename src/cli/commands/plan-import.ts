/**
 * Plan import CLI command
 * AC: @plan-import-content-only ac-draft-default through ac-module-stored
 * AC: @plan-import-format-guidance ac-missing-title-fails-import
 * AC: @plan-import-format-guidance ac-empty-plan-import-warns
 * AC: @plan-import-format-guidance ac-ac-shape-mismatch-fails-import
 * AC: @plan-import-format-guidance ac-ac-shape-mismatch-describes-shape
 * AC: @plan-import-format-guidance ac-help-describes-format
 * AC: @plan-import-format-guidance ac-error-no-external-references
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { markMutating } from "../command-annotations.js";
import {
  buildIndexes,
  createPlan,
  findPlanByRef,
  initContext,
  mutatePlanAtomically,
  type LoadedPlan,
  loadPlans,
  savePlan,
  type LoadedSpecItem,
} from "../../parser/index.js";
import { parsePlanDocument } from "../../parser/plan-document.js";
import {
  PlanImportResourceError,
  assertMarkdownLinksResolveAgainstPlan,
  persistPlanResourcesFromSibling,
  validatePlanImportResources,
} from "../../parser/plan-resource-import.js";
import { getPlanDir } from "../../parser/plan-storage-manager.js";
import { appendPlanRevision, getCurrentShadowCommit } from "../../parser/plan-revisions.js";
import { commitIfShadow } from "../../parser/shadow.js";
import { type Note, type PlanInput, PlanStatusSchema } from "../../schema/index.js";
import { errors } from "../../strings/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, isJsonMode, output, success, warn } from "../output.js";
import { resolveCliActor } from "../actor.js";
import { ulid } from "ulid";

interface ImportOptions {
  into?: string;
  module?: string;
  dryRun?: boolean;
  update?: boolean;
  json?: boolean;
  status?: string;
  reason?: string;
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
  changes: string[];
  note_message: string | null;
}

/**
 * Register plan import command.
 * AC: @plan-import-content-only ac-module-optional, ac-status-override, ac-update-ignored
 */
export function registerPlanImportCommand(planCommand: Command): void {
  markMutating(planCommand.command("import <path>"))
    .description("Import a plan document as stored content without deriving work")
    .option("--into <ref>", "Update an existing draft or approved plan with file content")
    .option("--module <ref>", "Optional module to store on the plan for later derive")
    .option("--status <status>", "Initial plan status (default: draft)")
    .option("--dry-run", "Show the plan record that would be created without saving")
    .option("--update", "Ignored for content-only import; derivation happens separately")
    .option("--reason <text>", "Reason note when updating an existing plan via --into")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      // AC: @plan-import-format-guidance ac-help-describes-format
      `
Format:
  Import stores the markdown document as plan content. Specs and tasks are not
  created during import; use "kspec plan derive" after approval to materialize
  the stored document.

  Required structural elements:
    - Title: A top-level heading (# Title) as the first significant element
    - Specs section: ## Specs containing a YAML code block with spec definitions
    - Tasks section: ## Tasks with derive_from_specs: true or a YAML code block
    - Acceptance criteria: Each AC requires id, given, when, and then fields

  Minimal example (copy-pasteable):

    # My Plan Title

    ## Specs

    \`\`\`yaml
    - title: My Feature
      slug: my-feature
      type: feature
      acceptance_criteria:
        - id: ac-basic
          given: |
            a precondition
          when: |
            an action occurs
          then: |
            the expected outcome
    \`\`\`

    ## Tasks

    derive_from_specs: true

Examples:
  $ kspec plan import ./plan.md
  $ kspec plan import ./plan.md --status approved --json
  $ kspec plan import ./plan.md --module @core --dry-run
  $ kspec plan import ./edited.md --into @plan-ref --reason "Addressed review feedback"`,
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

  if (options.into) {
    await importIntoExistingPlan(ctx, fullPath, content, options);
    return;
  }

  // Validate document structure before import
  // AC: @plan-import-format-guidance ac-missing-title-fails-import
  // AC: @plan-import-format-guidance ac-ac-shape-mismatch-fails-import
  // AC: @plan-import-format-guidance ac-ac-shape-mismatch-describes-shape
  // AC: @plan-import-format-guidance ac-error-no-external-references
  const parsed = parsePlanDocument(content);

  // Fail on structural errors (missing title, AC shape mismatches)
  const structuralErrors = parsed.errors.filter(
    (e) => e.type === "missing_title" || e.type === "ac_shape",
  );
  if (structuralErrors.length > 0) {
    for (const err of structuralErrors) {
      error(err.message);
    }
    process.exit(EXIT_CODES.USAGE_ERROR);
  }

  // Validate sibling resources.yaml + ./resources/<rel> markdown links before
  // any save. Persisting the plan first and then failing the resource copy
  // would leave the plan record without its declared sidecars.
  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  let resourceValidation: Awaited<ReturnType<typeof validatePlanImportResources>> | null = null;
  try {
    resourceValidation = await validatePlanImportResources(fullPath, content);
  } catch (err) {
    exitOnPlanImportResourceError(err);
  }

  if (options.update) {
    warn(
      "--update is ignored for content-only import. Use `kspec plan derive` to materialize specs and tasks.",
    );
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

    storedModuleRef = options.module.startsWith("@") ? options.module : `@${options.module}`;
  }

  const title = parsed.title;
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
    changes: [],
    note_message: null,
  };

  // Emit warnings for empty plans
  // AC: @plan-import-format-guidance ac-empty-plan-import-warns
  const emptyPlanWarnings = parsed.warnings.filter((w) => w.type === "empty_plan");
  for (const w of emptyPlanWarnings) {
    warn(w.message);
  }

  if (options.dryRun) {
    emitImportResult(preview, { dryRun: true, warnings: emptyPlanWarnings.map((w) => w.message) });
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

  await saveImportedPlan(
    ctx,
    plan,
    preview,
    emptyPlanWarnings.map((w) => w.message),
    resourceValidation,
  );
}

async function saveImportedPlan(
  ctx: Awaited<ReturnType<typeof initContext>>,
  plan: ReturnType<typeof createPlan>,
  preview: ImportPreview,
  warnings: string[] = [],
  resourceValidation: Awaited<ReturnType<typeof validatePlanImportResources>> | null = null,
): Promise<void> {
  await savePlan(ctx, plan);
  if (resourceValidation && resourceValidation.manifest.resources.length > 0) {
    try {
      // Plan directory now exists at .kspec/plans/<plan-ulid>/ — copy the
      // declared sibling files into resources/, write the manifest, and
      // refresh the lean index so resource_summary lands in the same
      // logical mutation as the resource files.
      // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
      // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
      await persistPlanResourcesFromSibling(ctx, plan._ulid, resourceValidation);
    } catch (err) {
      exitOnPlanImportResourceError(err);
    }
  }
  await commitIfShadow(
    ctx.shadow,
    "plan-import",
    plan.slugs[0] || plan._ulid.slice(0, 8),
    plan.title,
  );
  emitImportResult(
    {
      ...preview,
      ref: plan.slugs[0] ? `@${plan.slugs[0]}` : `@${plan._ulid}`,
    },
    { dryRun: false, createdAt: plan.created_at, warnings },
  );
}

/**
 * Map a {@link PlanImportResourceError} to the existing import-with-guidance
 * exit path so the CLI surface stays consistent. Non-typed errors propagate.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
 */
function exitOnPlanImportResourceError(err: unknown): never {
  if (err instanceof PlanImportResourceError) {
    exitImportWithGuidance(err.message, EXIT_CODES.USAGE_ERROR, undefined, {
      code: err.code,
      resource_id: err.resourceId ?? null,
      path: err.path ?? null,
      source_file: err.sourceFile ?? null,
      line: err.line ?? null,
    });
  }
  throw err;
}

async function importIntoExistingPlan(
  ctx: Awaited<ReturnType<typeof initContext>>,
  fullPath: string,
  content: string,
  options: ImportOptions,
): Promise<void> {
  const foundPlan = await findPlanByRef(ctx, options.into!);
  if (!foundPlan) {
    exitImportWithGuidance(
      errors.reference.planNotFound(options.into!),
      EXIT_CODES.NOT_FOUND,
      "Check available plans with: kspec plan list",
      { ref: options.into, entity: "plan" },
    );
  }

  // Validate document structure for --into re-imports (AC shape, empty-plan warnings).
  // Missing title is not an error for --into — the existing plan title is preserved
  // (AC: @plan-import-into ac-into-no-title).
  const parsed = parsePlanDocument(content);
  const structuralErrors = parsed.errors.filter((e) => e.type === "ac_shape");
  if (structuralErrors.length > 0) {
    for (const err of structuralErrors) {
      error(err.message);
    }
    process.exit(EXIT_CODES.USAGE_ERROR);
  }

  const emptyPlanWarnings = parsed.warnings.filter((w) => w.type === "empty_plan");
  for (const w of emptyPlanWarnings) {
    warn(w.message);
  }

  // Re-imports must resolve any ./resources/<rel> markdown link against the
  // existing plan's resources.yaml. Users attach resources via
  // `kspec plan resource add` before pointing markdown at them.
  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  try {
    await assertMarkdownLinksResolveAgainstPlan(
      getPlanDir(ctx, foundPlan._ulid),
      content,
      fullPath,
    );
  } catch (err) {
    exitOnPlanImportResourceError(err);
  }

  const titleFromFile = extractOptionalPlanTitle(content);
  const nextTitle = titleFromFile ?? foundPlan.title;
  const noteMessage = options.reason || "Content updated from file";
  const preview: ImportPreview = {
    ref: foundPlan.slugs[0] ? `@${foundPlan.slugs[0]}` : `@${foundPlan._ulid}`,
    title: nextTitle,
    status: foundPlan.status,
    content,
    module_ref: foundPlan.module_ref ?? null,
    source_path: fullPath,
    derived_specs: [...foundPlan.derived_specs],
    derived_tasks: [...foundPlan.derived_tasks],
    changes: titleFromFile ? ["title", "content"] : ["content"],
    note_message: noteMessage,
  };

  if (options.module) {
    warn("--module is ignored with --into. Existing plan module assignment is unchanged.");
  }
  if (options.update) {
    warn("--update is ignored with --into. Existing plan specs are not modified during re-import.");
  }
  if (options.status) {
    warn("--status is ignored with --into. Existing plan status is unchanged.");
  }

  assertImportIntoAllowed(foundPlan);

  const warningMessages = emptyPlanWarnings.map((w) => w.message);

  if (options.dryRun) {
    emitImportResult(preview, { dryRun: true, warnings: warningMessages });
    return;
  }

  // AC: @actor-identity-resolution ac-7 ac-8 — import writes canonicalize the
  // author through the same shared utility as daemon and CLI writes.
  const author = await resolveCliActor(ctx, undefined, "author");
  const note = createPlanNote(noteMessage, author);
  const updatedPlan = await mutatePlanAtomically(ctx, foundPlan, (latestPlan) => {
    assertImportIntoAllowed(latestPlan);
    return {
      ...latestPlan,
      title: nextTitle,
      content,
      notes: [...latestPlan.notes, note],
    };
  });

  await commitIfShadow(
    ctx.shadow,
    "plan-import",
    updatedPlan.slugs[0] || updatedPlan._ulid.slice(0, 8),
    updatedPlan.title,
  );
  if (ctx.shadow?.enabled) {
    const contentCommit = getCurrentShadowCommit(ctx);
    const revisionPlan = await appendPlanRevision(ctx, updatedPlan, {
      author,
      note: noteMessage,
      shadowCommit: contentCommit,
    });
    await commitIfShadow(
      ctx.shadow,
      "plan-revision",
      revisionPlan.slugs[0] || revisionPlan._ulid.slice(0, 8),
      `revision ${revisionPlan.revisions.at(-1)?.ordinal}`,
    );
  }
  emitImportResult(preview, {
    dryRun: false,
    createdAt: updatedPlan.created_at,
    warnings: warningMessages,
  });
}

function assertImportIntoAllowed(plan: LoadedPlan): void {
  if (plan.status === "active") {
    exitImportWithGuidance(
      "Cannot update active plan. Derive is a one-shot operation.",
      EXIT_CODES.CONFLICT,
      "Create a new plan iteration instead of re-importing into an active plan.",
      {
        current_status: plan.status,
        valid_statuses: ["draft", "approved"],
      },
    );
  }

  if (plan.status === "completed" || plan.status === "rejected") {
    exitImportWithGuidance(
      "Cannot update plan in terminal status",
      EXIT_CODES.CONFLICT,
      "Reopen or replace the plan with a new draft/approved plan.",
      {
        current_status: plan.status,
        valid_statuses: ["draft", "approved"],
      },
    );
  }
}

function createPlanNote(content: string, author?: string): Note {
  return {
    _ulid: ulid(),
    created_at: new Date().toISOString(),
    author,
    content,
  };
}

function exitImportWithGuidance(
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

function emitImportResult(
  preview: ImportPreview,
  options: { dryRun: boolean; createdAt?: string; warnings?: string[] },
): void {
  const warnings = options.warnings ?? [];
  const payload: Record<string, unknown> = {
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
    changes: preview.changes,
    note_message: preview.note_message,
  };

  // AC: @plan-import-format-guidance ac-empty-plan-import-warns — include warnings in JSON output
  if (warnings.length > 0) {
    payload.warnings = warnings;
  }

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
  if (preview.changes.length > 0) {
    console.log(`Changes: ${preview.changes.join(", ")}`);
  }
  if (preview.note_message) {
    console.log(`Note: ${preview.note_message}`);
  }

  if (!options.dryRun) {
    success("Imported plan content");
  }
}

function extractOptionalPlanTitle(content: string): string | null {
  const firstSignificantLine = content.split("\n").find((line) => line.trim() !== "");
  const titleMatch = firstSignificantLine?.match(/^#\s+(.+)$/);
  return titleMatch ? titleMatch[1].trim() : null;
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
