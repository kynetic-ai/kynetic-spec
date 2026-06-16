import * as path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import type { LoadedSpecItem, LoadedTask } from "../../parser/index.js";
import {
  AlignmentIndex,
  type AlignmentWarning,
  checkACSchemaReferences,
  type CompletenessWarning,
  type ConventionValidationResult,
  expandIncludePattern,
  type FixResult,
  findTaskFiles,
  fixFiles,
  initContext,
  loadAllItems,
  resolveTaskDataManager,
  loadMetaContext,
  ReferenceIndex,
  type ValidationResult,
  validate,
  validateConventions,
} from "../../parser/index.js";
import { type SkillValidationResult, validateSkills } from "../../parser/validate-skills.js";
import { validation as validationStrings } from "../../strings/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, isStructuredMode, output, warn } from "../output.js";

/**
 * Staleness warning types
 * AC: @stale-status-detection
 */
interface StalenessWarning {
  type:
    | "parent-pending-children-done"
    | "spec-implemented-no-task"
    | "task-done-spec-not-started"
    | "automation-blocking";
  message: string;
  refs: string[];
}

/**
 * Check for stale status mismatches between specs and tasks
 * AC: @stale-status-detection ac-1, ac-2, ac-3
 */
function checkStaleness(
  items: LoadedSpecItem[],
  tasks: LoadedTask[],
  refIndex: ReferenceIndex,
): StalenessWarning[] {
  const warnings: StalenessWarning[] = [];

  // AC: @stale-status-detection ac-1 (parent-pending-children-done)
  // Check if task with dependencies is pending but all dependencies are completed
  for (const task of tasks) {
    // Only check pending/in_progress tasks with dependencies
    if (task.status !== "pending" && task.status !== "in_progress") continue;
    if (!task.depends_on || task.depends_on.length === 0) continue;

    // Resolve all dependency tasks
    const depTasks = task.depends_on
      .map((depRef) => {
        const result = refIndex.resolve(depRef);
        if (!result.ok) return null;
        return tasks.find((t) => t._ulid === result.ulid);
      })
      .filter((t): t is LoadedTask => t !== null);

    if (depTasks.length === 0) continue;

    // Check if all dependencies are completed and their linked specs are implemented
    const allDepsDone = depTasks.every((depTask) => {
      if (depTask.status !== "completed") return false;

      // If the dep task has a spec_ref, check if that spec is implemented
      if (depTask.spec_ref) {
        const result = refIndex.resolve(depTask.spec_ref);
        if (!result.ok) return true; // Missing spec ref doesn't block
        const spec = items.find((item) => item._ulid === result.ulid);
        return spec?.status?.implementation === "implemented";
      }
      return true;
    });

    if (allDepsDone) {
      const taskRef = task.slugs[0] || refIndex.shortUlid(task._ulid);
      warnings.push({
        type: "parent-pending-children-done",
        message: `Task @${taskRef} is ${task.status} but all dependencies are completed. Consider completing or reviewing.`,
        refs: [task._ulid],
      });
    }
  }

  // AC: @stale-status-detection ac-2 (spec-implemented-no-task)
  // Check if spec is implemented but has no completed tasks
  for (const item of items) {
    if (item.status?.implementation !== "implemented") continue;

    // AC: @trait-retrospective ac-1
    // Skip retrospective specs from staleness warnings
    const isRetrospective = item.traits?.includes("@trait-retrospective");
    if (isRetrospective) continue;

    // Find completed tasks that reference this spec
    const completedTasks = tasks.filter((task) => {
      if (task.status !== "completed" || !task.spec_ref) return false;
      const result = refIndex.resolve(task.spec_ref);
      return result.ok && result.ulid === item._ulid;
    });

    if (completedTasks.length === 0) {
      const specRef = item.slugs[0] || refIndex.shortUlid(item._ulid);
      warnings.push({
        type: "spec-implemented-no-task",
        message: `Spec @${specRef} is implemented but has no completed tasks. Verify implementation or link existing task.`,
        refs: [item._ulid],
      });
    }
  }

  // AC: @stale-status-detection ac-3 (task-done-spec-not-started)
  // Check if task is completed but spec is still not_started
  for (const task of tasks) {
    if (task.status !== "completed") continue;
    if (!task.spec_ref) continue;

    // Resolve spec reference
    const result = refIndex.resolve(task.spec_ref);
    if (!result.ok) continue;

    const spec = items.find((item) => item._ulid === result.ulid);
    if (!spec) continue;

    if (spec.status?.implementation === "not_started") {
      const taskRef = task.slugs[0] || refIndex.shortUlid(task._ulid);
      const specRef = spec.slugs[0] || refIndex.shortUlid(spec._ulid);
      warnings.push({
        type: "task-done-spec-not-started",
        message: `Task @${taskRef} completed but spec @${specRef} is not_started. Update spec status.`,
        refs: [task._ulid, spec._ulid],
      });
    }
  }

  // AC: @validation ac-1
  // Check for manual_only parents blocking eligible children
  for (const parentTask of tasks) {
    if (parentTask.automation !== "manual_only") continue;

    // Find tasks that depend on this parent
    const dependentTasks = tasks.filter((t) =>
      t.depends_on?.some((depRef) => {
        const result = refIndex.resolve(depRef);
        return result.ok && result.ulid === parentTask._ulid;
      }),
    );

    // Filter for eligible children
    const eligibleChildren = dependentTasks.filter((t) => t.automation === "eligible");

    if (eligibleChildren.length > 0) {
      const parentRef = parentTask.slugs[0] || refIndex.shortUlid(parentTask._ulid);
      const childRefs = eligibleChildren.map(
        (c) => `@${c.slugs[0] || refIndex.shortUlid(c._ulid)}`,
      );

      warnings.push({
        type: "automation-blocking",
        message: `Task @${parentRef} is manual_only and blocks ${eligibleChildren.length} eligible child task(s): ${childRefs.join(", ")}`,
        refs: [parentTask._ulid, ...eligibleChildren.map((c) => c._ulid)],
      });
    }
  }

  return warnings;
}

/**
 * Format staleness warnings for display
 * AC: @stale-status-detection ac-4
 */
function formatStalenessWarnings(warnings: StalenessWarning[], verbose: boolean): void {
  if (warnings.length === 0) {
    console.log(chalk.green("Staleness: OK"));
    return;
  }

  console.log(chalk.yellow(`\nStaleness warnings: ${warnings.length}`));

  // Group by type
  const parentPending = warnings.filter((w) => w.type === "parent-pending-children-done");
  const specNoTask = warnings.filter((w) => w.type === "spec-implemented-no-task");
  const taskDoneSpecNot = warnings.filter((w) => w.type === "task-done-spec-not-started");
  const automationBlocking = warnings.filter((w) => w.type === "automation-blocking");

  if (parentPending.length > 0) {
    console.log(chalk.yellow(`  Parent pending, children done: ${parentPending.length}`));
    const shown = verbose ? parentPending : parentPending.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.yellow(`    ! ${w.message}`));
    }
    if (!verbose && parentPending.length > 3) {
      console.log(chalk.gray(`    ... and ${parentPending.length - 3} more`));
    }
  }

  if (specNoTask.length > 0) {
    console.log(chalk.yellow(`  Spec implemented, no task: ${specNoTask.length}`));
    const shown = verbose ? specNoTask : specNoTask.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.yellow(`    ! ${w.message}`));
    }
    if (!verbose && specNoTask.length > 3) {
      console.log(chalk.gray(`    ... and ${specNoTask.length - 3} more`));
    }
  }

  if (taskDoneSpecNot.length > 0) {
    console.log(chalk.yellow(`  Task done, spec not started: ${taskDoneSpecNot.length}`));
    const shown = verbose ? taskDoneSpecNot : taskDoneSpecNot.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.yellow(`    ! ${w.message}`));
    }
    if (!verbose && taskDoneSpecNot.length > 3) {
      console.log(chalk.gray(`    ... and ${taskDoneSpecNot.length - 3} more`));
    }
  }

  if (automationBlocking.length > 0) {
    console.log(chalk.yellow(`  Automation blocking: ${automationBlocking.length}`));
    const shown = verbose ? automationBlocking : automationBlocking.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.yellow(`    ! ${w.message}`));
    }
    if (!verbose && automationBlocking.length > 3) {
      console.log(chalk.gray(`    ... and ${automationBlocking.length - 3} more`));
    }
  }
}

/**
 * AC schema drift warning type
 */
interface ACDriftWarning {
  type: "ac_schema_field_mismatch";
  itemRef: string;
  itemTitle: string;
  message: string;
  details?: string;
}

/**
 * Format AC schema drift warnings for display
 */
function formatDriftWarnings(warnings: CompletenessWarning[], verbose: boolean): void {
  // Filter to only drift warnings
  const driftWarnings = warnings.filter(
    (w) => w.type === "ac_schema_field_mismatch",
  ) as ACDriftWarning[];

  if (driftWarnings.length === 0) {
    console.log(chalk.green("AC Schema Drift: OK"));
    return;
  }

  console.log(chalk.yellow(`\nAC Schema Drift warnings: ${driftWarnings.length}`));

  // Group by item
  const byItem = new Map<string, ACDriftWarning[]>();
  for (const w of driftWarnings) {
    const existing = byItem.get(w.itemRef) || [];
    existing.push(w);
    byItem.set(w.itemRef, existing);
  }

  const itemEntries = [...byItem.entries()];
  const shown = verbose ? itemEntries : itemEntries.slice(0, 5);

  for (const [itemRef, itemWarnings] of shown) {
    const firstWarning = itemWarnings[0];
    console.log(chalk.yellow(`  ${itemRef} - ${firstWarning.itemTitle}`));
    for (const w of itemWarnings) {
      console.log(chalk.yellow(`    ! ${w.message}`));
      if (w.details) {
        console.log(chalk.gray(`      ${w.details}`));
      }
    }
  }

  if (!verbose && itemEntries.length > 5) {
    console.log(chalk.gray(`  ... and ${itemEntries.length - 5} more items with drift`));
  }
}

/**
 * Format convention validation results for display
 * AC: @convention-definitions ac-3, ac-4
 */
function formatConventionValidationResult(result: ConventionValidationResult): void {
  if (result.valid && result.skipped.length === 0) {
    console.log(chalk.green("Conventions: OK"));
    return;
  }

  // AC: @convention-definitions ac-4
  // Skipped prose conventions
  if (result.skipped.length > 0) {
    for (const domain of result.skipped) {
      console.log(chalk.gray(`ℹ Skipping prose convention: ${domain}`));
    }
  }

  // AC: @convention-definitions ac-3
  // Validation errors
  if (result.errors.length > 0) {
    console.log(chalk.red(`\nConvention violations: ${result.errors.length}`));
    for (const err of result.errors) {
      console.log(chalk.red(`  ✗ ${err.domain}`));
      console.log(chalk.gray(`    ${err.message}`));
      if (err.expected) {
        console.log(chalk.gray(`    Expected: ${err.expected}`));
      }
      if (err.location) {
        console.log(chalk.gray(`    Location: ${err.location}`));
      }
    }
  } else {
    console.log(chalk.green("\nConventions: OK"));
  }

  // Stats
  console.log(chalk.gray(`\nConventions checked: ${result.stats.conventionsChecked}`));
  console.log(chalk.gray(`Conventions skipped: ${result.stats.conventionsSkipped}`));
}

/**
 * Format skill validation results for display
 */
function formatSkillValidationResult(result: SkillValidationResult, verbose: boolean): void {
  if (result.filesChecked === 0) {
    console.log(chalk.gray("Skills: No skill files found"));
    return;
  }

  if (result.valid) {
    console.log(chalk.green(`Skills: OK (${result.filesChecked} files checked)`));
    return;
  }

  console.log(chalk.red(`\nSkill validation errors: ${result.errors.length}`));
  console.log(chalk.gray(`Files checked: ${result.filesChecked}`));

  // Group errors by file
  const errorsByFile = new Map<string, typeof result.errors>();
  for (const err of result.errors) {
    const existing = errorsByFile.get(err.file) || [];
    existing.push(err);
    errorsByFile.set(err.file, existing);
  }

  for (const [file, errors] of errorsByFile.entries()) {
    console.log(chalk.yellow(`\n  ${file}:`));
    const shown = verbose ? errors : errors.slice(0, 5);
    for (const err of shown) {
      const location = err.line ? `:${err.line}` : "";
      console.log(chalk.red(`    ✗ ${err.type}${location}`));
      console.log(chalk.gray(`      ${err.message}`));
    }
    if (!verbose && errors.length > 5) {
      console.log(chalk.gray(`    ... and ${errors.length - 5} more`));
    }
  }
}

/**
 * Format completeness warnings for display
 * AC: @spec-completeness ac-4
 */
function formatCompletenessWarnings(warnings: CompletenessWarning[], verbose: boolean): void {
  if (warnings.length === 0) {
    console.log(chalk.green("Completeness: OK"));
    return;
  }

  console.log(chalk.yellow(`\nCompleteness warnings: ${warnings.length}`));

  // Group by type
  const missingAC = warnings.filter((w) => w.type === "missing_acceptance_criteria");
  const missingDesc = warnings.filter((w) => w.type === "missing_description");
  const statusMismatch = warnings.filter((w) => w.type === "status_inconsistency");
  const missingOwnACCoverage = warnings.filter(
    (w) => w.type === "missing_test_coverage" && w.subtype !== "trait_ac",
  );
  const missingTraitACCoverage = warnings.filter(
    (w) => w.type === "missing_test_coverage" && w.subtype === "trait_ac",
  );
  const automationNoSpec = warnings.filter((w) => w.type === "automation_eligible_no_spec");

  // AC: @spec-completeness ac-4
  // Show summary with counts by issue type
  if (missingAC.length > 0) {
    console.log(chalk.yellow(`  Missing acceptance criteria: ${missingAC.length}`));
    const shown = verbose ? missingAC : missingAC.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.gray(`    ○ ${w.itemRef} - ${w.itemTitle}`));
    }
    if (!verbose && missingAC.length > 3) {
      console.log(chalk.gray(`    ... and ${missingAC.length - 3} more`));
    }
  }

  if (missingDesc.length > 0) {
    console.log(chalk.yellow(`  Missing descriptions: ${missingDesc.length}`));
    const shown = verbose ? missingDesc : missingDesc.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.gray(`    ○ ${w.itemRef} - ${w.itemTitle}`));
    }
    if (!verbose && missingDesc.length > 3) {
      console.log(chalk.gray(`    ... and ${missingDesc.length - 3} more`));
    }
  }

  if (statusMismatch.length > 0) {
    console.log(chalk.yellow(`  Status inconsistencies: ${statusMismatch.length}`));
    for (const w of statusMismatch) {
      console.log(chalk.yellow(`    ! ${w.message}`));
      if (w.details) {
        console.log(chalk.gray(`      ${w.details}`));
      }
    }
  }

  if (missingOwnACCoverage.length > 0) {
    console.log(chalk.yellow(`  Missing own AC coverage: ${missingOwnACCoverage.length}`));
    const shown = verbose ? missingOwnACCoverage : missingOwnACCoverage.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.yellow(`    ! ${w.itemRef} - ${w.itemTitle}`));
      if (w.details) {
        console.log(chalk.gray(`      ${w.details}`));
      }
    }
    if (!verbose && missingOwnACCoverage.length > 3) {
      console.log(chalk.gray(`    ... and ${missingOwnACCoverage.length - 3} more`));
    }
  }

  if (missingTraitACCoverage.length > 0) {
    console.log(chalk.yellow(`  Missing trait AC coverage: ${missingTraitACCoverage.length}`));
    const shown = verbose ? missingTraitACCoverage : missingTraitACCoverage.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.yellow(`    ! ${w.itemRef} - ${w.itemTitle}`));
      if (w.details) {
        console.log(chalk.gray(`      ${w.details}`));
      }
    }
    if (!verbose && missingTraitACCoverage.length > 3) {
      console.log(chalk.gray(`    ... and ${missingTraitACCoverage.length - 3} more`));
    }
  }

  // AC: @task-automation-eligibility ac-21, ac-23
  if (automationNoSpec.length > 0) {
    console.log(chalk.yellow(`  Automation without spec: ${automationNoSpec.length}`));
    const shown = verbose ? automationNoSpec : automationNoSpec.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.yellow(`    ! ${w.itemRef} - ${w.itemTitle}`));
      console.log(chalk.gray(`      ${w.message}`));
    }
    if (!verbose && automationNoSpec.length > 3) {
      console.log(chalk.gray(`    ... and ${automationNoSpec.length - 3} more`));
    }
  }

  // AC: @ac-verification-record-store ac-unresolvable-keys-tolerated
  // Orphaned verification records must be visible in the human report, not just counted.
  const orphanedVerifications = warnings.filter((w) => w.type === "orphaned_verification_record");
  if (orphanedVerifications.length > 0) {
    console.log(chalk.yellow(`  Orphaned verification records: ${orphanedVerifications.length}`));
    const shown = verbose ? orphanedVerifications : orphanedVerifications.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.yellow(`    ! ${w.itemRef} - ${w.itemTitle}`));
      console.log(chalk.gray(`      ${w.message}`));
      if (w.details) {
        console.log(chalk.gray(`      ${w.details}`));
      }
    }
    if (!verbose && orphanedVerifications.length > 3) {
      console.log(chalk.gray(`    ... and ${orphanedVerifications.length - 3} more`));
    }
  }

  // Invalid AC annotations in test files — grouped by subtype for actionable repair
  const invalidAnnotations = warnings.filter((w) => w.type === "invalid_ac_annotation");
  if (invalidAnnotations.length > 0) {
    console.log(chalk.yellow(`  Invalid AC annotations: ${invalidAnnotations.length}`));

    const subtypeLabels: Record<string, string> = {
      unresolved_target: "Unresolved targets",
      non_spec_target: "Non-spec/trait targets",
      missing_ac_id: "Missing AC ids",
      blanket_ref: "Blanket refs (no coverage credit)",
    };

    const grouped = new Map<string, typeof invalidAnnotations>();
    for (const w of invalidAnnotations) {
      const key = w.subtype ?? "other";
      const list = grouped.get(key) ?? [];
      list.push(w);
      grouped.set(key, list);
    }

    for (const [subtype, group] of grouped) {
      const label = subtypeLabels[subtype] ?? subtype;
      console.log(chalk.yellow(`    ${label}: ${group.length}`));
      const shown = verbose ? group : group.slice(0, 3);
      for (const w of shown) {
        console.log(chalk.yellow(`      ! ${w.message}`));
        if (w.details) {
          console.log(chalk.gray(`        ${w.details}`));
        }
      }
      if (!verbose && group.length > 3) {
        console.log(chalk.gray(`      ... and ${group.length - 3} more`));
      }
    }
  }
}

/**
 * Format alignment warnings for display
 */
function formatAlignmentWarnings(warnings: AlignmentWarning[], verbose: boolean): void {
  if (warnings.length === 0) {
    console.log(chalk.green("Alignment: OK"));
    return;
  }

  console.log(chalk.yellow(`\nAlignment warnings: ${warnings.length}`));

  // Group by type
  const orphaned = warnings.filter((w) => w.type === "orphaned_spec");
  const mismatches = warnings.filter((w) => w.type === "status_mismatch");
  const stale = warnings.filter((w) => w.type === "stale_implementation");

  if (orphaned.length > 0) {
    console.log(chalk.yellow(`  Orphaned specs (no tasks): ${orphaned.length}`));
    const shown = verbose ? orphaned : orphaned.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.gray(`    ○ ${w.specTitle}`));
    }
    if (!verbose && orphaned.length > 3) {
      console.log(chalk.gray(`    ... and ${orphaned.length - 3} more`));
    }
  }

  if (mismatches.length > 0) {
    console.log(chalk.yellow(`  Status mismatches: ${mismatches.length}`));
    for (const w of mismatches) {
      console.log(chalk.yellow(`    ! ${w.specTitle}`));
      console.log(chalk.gray(`      ${w.message}`));
    }
  }

  if (stale.length > 0) {
    console.log(chalk.yellow(`  Stale implementation status: ${stale.length}`));
    for (const w of stale) {
      console.log(chalk.yellow(`    ! ${w.message}`));
    }
  }
}

/**
 * Format fix results for display
 */
function formatFixResult(result: FixResult): void {
  if (result.fixesApplied.length === 0) {
    console.log(chalk.gray("\nNo auto-fixable issues found."));
    return;
  }

  console.log(
    chalk.cyan(
      `\n✓ Applied ${result.fixesApplied.length} fix(es) to ${result.filesModified} file(s):`,
    ),
  );

  for (const fix of result.fixesApplied) {
    const typeLabel = {
      ulid_regenerated: "ULID regenerated",
      timestamp_added: "Timestamp added",
      status_added: "Status added",
    }[fix.type];

    const shortFile = path.basename(fix.file);
    console.log(chalk.cyan(`  ✓ ${shortFile}:${fix.path} - ${typeLabel}`));
  }

  if (result.errors.length > 0) {
    console.log(chalk.yellow(`\nFix errors: ${result.errors.length}`));
    for (const err of result.errors) {
      console.log(chalk.yellow(`  ! ${err.file}: ${err.message}`));
    }
  }
}

/**
 * Collect all files that can be fixed
 */
async function collectFixableFiles(ctx: {
  rootDir: string;
  specDir?: string;
  manifest?: { includes?: string[] } | null;
  manifestPath?: string | null;
}): Promise<string[]> {
  const files: string[] = [];

  // Task files (exclude test fixtures)
  const taskFiles = await findTaskFiles(ctx.rootDir);
  const specTaskFiles = await findTaskFiles(path.join(ctx.rootDir, "spec"));
  const allTaskFiles = [...new Set([...taskFiles, ...specTaskFiles])];
  files.push(...allTaskFiles.filter((f) => !f.includes("fixtures") && !f.includes("test")));

  // Spec files from includes
  if (ctx.manifest && ctx.manifestPath) {
    const manifestDir = path.dirname(ctx.manifestPath);
    const includes = ctx.manifest.includes || [];

    for (const include of includes) {
      const expandedPaths = await expandIncludePattern(include, manifestDir);
      files.push(...expandedPaths);
    }
  }

  // Inbox file
  const inboxPath = path.join(ctx.rootDir, "spec", "kynetic.inbox.yaml");
  try {
    await import("node:fs/promises").then((fs) => fs.access(inboxPath));
    files.push(inboxPath);
  } catch {
    // Inbox file doesn't exist, skip
  }

  return [...new Set(files)];
}

/**
 * Format validation result for display
 */
function formatValidationResult(result: ValidationResult, verbose: boolean): void {
  // Header
  if (result.valid) {
    console.log(chalk.green.bold("✓ Validation passed"));
  } else {
    console.log(chalk.red.bold("✗ Validation failed"));
  }

  console.log(chalk.gray("─".repeat(40)));
  console.log(`Files checked: ${result.stats.filesChecked}`);
  console.log(`Items checked: ${result.stats.itemsChecked}`);
  console.log(`Tasks checked: ${result.stats.tasksChecked}`);

  // AC-meta-manifest-2: Display meta summary line
  if (result.metaStats) {
    console.log(
      `Meta: ${result.metaStats.agents} agents, ${result.metaStats.workflows} workflows, ${result.metaStats.conventions} conventions`,
    );
  }

  // Schema errors
  if (result.schemaErrors.length > 0) {
    console.log(chalk.red(`\nSchema errors: ${result.schemaErrors.length}`));
    for (const err of result.schemaErrors) {
      const location = err.path ? `${err.file}:${err.path}` : err.file;
      console.log(chalk.red(`  ✗ ${location}`));
      console.log(chalk.gray(`    ${err.message}`));
      if (verbose && err.details) {
        console.log(chalk.gray(`    ${JSON.stringify(err.details)}`));
      }
    }
  } else {
    console.log(chalk.green("\nSchema: OK"));
  }

  // Reference errors
  if (result.refErrors.length > 0) {
    console.log(chalk.red(`\nReference errors: ${result.refErrors.length}`));
    for (const err of result.refErrors) {
      const location = err.sourceFile
        ? `${err.sourceFile} (${err.field})`
        : `${err.sourceUlid?.slice(0, 8)} (${err.field})`;
      console.log(chalk.red(`  ✗ ${err.ref}`));
      console.log(chalk.gray(`    ${err.message}`));
      console.log(chalk.gray(`    in: ${location}`));
    }
  } else {
    console.log(chalk.green("References: OK"));
  }

  // Reference warnings (deprecated targets)
  if (result.refWarnings.length > 0) {
    console.log(chalk.yellow(`\nReference warnings: ${result.refWarnings.length}`));
    const shown = verbose ? result.refWarnings : result.refWarnings.slice(0, 5);
    for (const warn of shown) {
      const location = warn.sourceFile
        ? `${warn.sourceFile} (${warn.field})`
        : `${warn.sourceUlid?.slice(0, 8)} (${warn.field})`;
      console.log(chalk.yellow(`  ⚠ ${warn.ref}`));
      console.log(chalk.gray(`    ${warn.message}`));
      console.log(chalk.gray(`    in: ${location}`));
    }
    if (!verbose && result.refWarnings.length > 5) {
      console.log(
        chalk.gray(`  ... and ${result.refWarnings.length - 5} more (use -v to see all)`),
      );
    }
  }

  // AC: @trait-edge-cases ac-2
  // Trait cycle errors
  if (result.traitCycleErrors.length > 0) {
    console.log(chalk.red(`\nTrait cycle errors: ${result.traitCycleErrors.length}`));
    for (const err of result.traitCycleErrors) {
      console.log(chalk.red(`  ✗ ${err.traitRef} - ${err.traitTitle}`));
      console.log(chalk.gray(`    ${err.message}`));
    }
  }

  // Orphans (warnings, not errors)
  if (result.orphans.length > 0) {
    console.log(chalk.yellow(`\nOrphans (not referenced): ${result.orphans.length}`));
    if (verbose) {
      for (const orphan of result.orphans) {
        console.log(
          chalk.yellow(`  ○ ${orphan.ulid.slice(0, 8)} [${orphan.type}] ${orphan.title}`),
        );
      }
    } else {
      // Show first few
      const shown = result.orphans.slice(0, 5);
      for (const orphan of shown) {
        console.log(
          chalk.yellow(`  ○ ${orphan.ulid.slice(0, 8)} [${orphan.type}] ${orphan.title}`),
        );
      }
      if (result.orphans.length > 5) {
        console.log(chalk.gray(`  ... and ${result.orphans.length - 5} more (use -v to see all)`));
      }
    }
  }
}

/**
 * Register validate command
 */
export function registerValidateCommand(program: Command): void {
  program
    .command("validate")
    .description("Validate spec files")
    .option("--schema", "Check schema conformance only")
    .option("--refs", "Check reference resolution only")
    .option("--orphans", "Find orphaned items only")
    .option("--alignment", "Check spec-task alignment")
    .option(
      "--completeness",
      "Check spec completeness (missing AC, descriptions, status inconsistencies)",
    )
    .option("--conventions", "Validate conventions")
    .option("--staleness", "Check for stale status mismatches between specs and tasks")
    .option("--skills", "Validate skill files (.claude/skills/*/SKILL.md)")
    .option("--drift", "Check AC field references against actual schema (catches spec prose drift)")
    .option("--fix", "Auto-fix issues where possible (invalid ULIDs, missing timestamps)")
    .option("-v, --verbose", "Show detailed output")
    .option("--strict", "Treat orphans and staleness warnings as errors")
    .option("--warnings-ok", "Return success exit code (0) when warnings are present but no errors")
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const structuredOutput = isStructuredMode();

        if (!ctx.manifestPath) {
          error(validationStrings.noManifest);
          if (!structuredOutput) {
            console.log(validationStrings.initHint);
          }
          process.exit(EXIT_CODES.ERROR);
        }

        // Track warnings from all sources for exit code determination
        let additionalWarningCount = 0;

        // Determine which checks to run. Coerce to booleans so we pass explicit
        // false values to parser validation when a check is not selected.
        const selectedChecks = {
          schema: Boolean(options.schema),
          refs: Boolean(options.refs),
          orphans: Boolean(options.orphans),
          alignment: Boolean(options.alignment),
          completeness: Boolean(options.completeness),
          conventions: Boolean(options.conventions),
          staleness: Boolean(options.staleness),
          skills: Boolean(options.skills),
          drift: Boolean(options.drift),
        };
        const runAll = !Object.values(selectedChecks).some(Boolean);

        // AC: @config-validation ac-4 — CLI --strict overrides config strict_refs
        // If --strict is passed, use strict behavior regardless of config
        // Otherwise, use config value (which defaults to false)
        const strictRefs = options.strict ? true : ctx.config.validation.strict_refs;
        const requireAcceptance = ctx.config.validation.require_acceptance;

        const validateOptions = {
          schema: runAll || selectedChecks.schema,
          refs: runAll || selectedChecks.refs,
          orphans: runAll || selectedChecks.orphans,
          completeness: runAll || selectedChecks.completeness,
          // AC: @config-validation ac-2 ac-3 ac-4 — wire config into validation
          strictRefs,
          requireAcceptance,
        };

        const result = await validate(ctx, validateOptions);

        // In strict mode, orphans are errors
        if (options.strict && result.orphans.length > 0) {
          result.valid = false;
        }

        // --- Collect all additional validation data before any output ---
        // AC: @trait-json-output ac-1 — ensure all stdout is valid JSON in --json mode

        // Auto-fix if requested
        let fixResult: FixResult | undefined;
        if (options.fix) {
          const filesToFix = await collectFixableFiles(ctx);
          fixResult = await fixFiles(filesToFix);

          // Re-run validation after fixes to show updated status
          if (fixResult.fixesApplied.length > 0) {
            if (!structuredOutput) {
              console.log(validationStrings.revalidating);
            }
            const revalidateResult = await validate(ctx, validateOptions);
            if (!structuredOutput) {
              if (revalidateResult.valid) {
                console.log(validationStrings.nowPasses);
              } else {
                console.log(validationStrings.issuesRemain);
              }
            }
            // Update result for exit code
            result.valid = revalidateResult.valid;
            result.schemaErrors = revalidateResult.schemaErrors;
            result.refErrors = revalidateResult.refErrors;
          }
        }

        // Run alignment check if requested or running all checks
        let alignmentWarnings: AlignmentWarning[] | undefined;
        let alignmentStats:
          | { specsWithTasks: number; totalSpecs: number; alignedSpecs: number }
          | undefined;
        if (selectedChecks.alignment || runAll) {
          const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
          const items = await loadAllItems(ctx);
          const refIndex = new ReferenceIndex(tasks, items);
          const alignmentIndex = new AlignmentIndex(tasks, items);
          alignmentIndex.buildLinks(refIndex);

          alignmentWarnings = alignmentIndex.findAlignmentWarnings();
          additionalWarningCount += alignmentWarnings.length;
          alignmentStats = alignmentIndex.getStats();
        }

        // Run convention validation if requested
        // AC: @convention-definitions ac-3, ac-4
        let conventionResult: ConventionValidationResult | undefined;
        if (selectedChecks.conventions) {
          try {
            const metaCtx = await loadMetaContext(ctx);
            if (metaCtx && metaCtx.conventions.length > 0) {
              conventionResult = validateConventions(metaCtx.conventions, {});

              if (!conventionResult.valid) {
                result.valid = false;
              }
            }
          } catch {
            // Convention loading failure is non-fatal
          }
        }

        // Run staleness checks if requested
        // AC: @stale-status-detection ac-4, ac-5
        let stalenessWarnings: StalenessWarning[] | undefined;
        let stalenessWarningCount = 0;
        if (selectedChecks.staleness) {
          const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
          const items = await loadAllItems(ctx);
          const refIndex = new ReferenceIndex(tasks, items);

          stalenessWarnings = checkStaleness(items, tasks, refIndex);
          stalenessWarningCount = stalenessWarnings.length;

          // AC: @stale-status-detection ac-5 (staleness-exit-code)
          // With --strict, staleness warnings cause validation failure
          if (options.strict && stalenessWarnings.length > 0) {
            result.valid = false;
          }
        }

        // Run skill file validation if requested or running all checks
        let skillResult: SkillValidationResult | undefined;
        if (runAll || selectedChecks.skills) {
          skillResult = await validateSkills(ctx.rootDir);

          if (!skillResult.valid) {
            result.valid = false;
          }
        }

        // Run AC schema drift checks if requested
        let driftWarnings: CompletenessWarning[] | undefined;
        let driftWarningCount = 0;
        if (selectedChecks.drift) {
          const items = await loadAllItems(ctx);
          driftWarnings = checkACSchemaReferences(items);
          driftWarningCount = driftWarnings.length;

          // With --strict, drift warnings cause validation failure
          if (options.strict && driftWarnings.length > 0) {
            result.valid = false;
          }
        }

        // --- Output: structured mode emits a single JSON object, text mode uses formatters ---
        if (structuredOutput) {
          // AC: @trait-json-output ac-1, ac-2 — single valid JSON object with all data
          const fullResult: Record<string, unknown> = { ...result };
          if (alignmentWarnings !== undefined) {
            fullResult.alignmentWarnings = alignmentWarnings;
            fullResult.alignmentStats = alignmentStats;
          }
          if (conventionResult !== undefined) {
            fullResult.conventionValidation = conventionResult;
          }
          if (stalenessWarnings !== undefined) {
            fullResult.stalenessWarnings = stalenessWarnings;
          }
          if (skillResult !== undefined) {
            fullResult.skillValidation = skillResult;
          }
          if (driftWarnings !== undefined) {
            fullResult.driftWarnings = driftWarnings;
          }
          if (fixResult !== undefined) {
            fullResult.fixResult = fixResult;
          }
          output(fullResult);
        } else {
          // Human-readable output
          formatValidationResult(result, options.verbose);

          if (fixResult) {
            formatFixResult(fixResult);
          }

          if (alignmentWarnings !== undefined) {
            formatAlignmentWarnings(alignmentWarnings, options.verbose);
            if (alignmentStats) {
              console.log(
                validationStrings.alignmentStats(
                  alignmentStats.specsWithTasks,
                  alignmentStats.totalSpecs,
                  alignmentStats.alignedSpecs,
                ),
              );
            }
          }

          // AC: @spec-completeness ac-4
          if (result.completenessWarnings.length > 0) {
            formatCompletenessWarnings(result.completenessWarnings, options.verbose);
          }

          // AC: @convention-definitions ac-3, ac-4
          if (selectedChecks.conventions) {
            if (conventionResult) {
              formatConventionValidationResult(conventionResult);
            } else {
              console.log(chalk.gray("No conventions defined in meta manifest"));
            }
          }

          if (stalenessWarnings !== undefined) {
            formatStalenessWarnings(stalenessWarnings, options.verbose);
          }

          if (skillResult !== undefined) {
            formatSkillValidationResult(skillResult, options.verbose);
          }

          if (driftWarnings !== undefined) {
            formatDriftWarnings(driftWarnings, options.verbose);
          }
        }

        // Determine exit code based on errors vs warnings
        // Errors: schema, refs, trait cycles, conventions, skills (result.valid = false)
        // Warnings: orphans, alignment, completeness, staleness, drift, ref warnings
        const hasErrors = !result.valid;
        const hasWarnings =
          result.orphans.length > 0 ||
          result.refWarnings.length > 0 ||
          result.completenessWarnings.length > 0 ||
          additionalWarningCount > 0 ||
          stalenessWarningCount > 0 ||
          driftWarningCount > 0;

        if (hasErrors) {
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        } else if (hasWarnings) {
          if (options.warningsOk) {
            warn(
              `Validation produced warnings; exiting 0 due to --warnings-ok (default is ${EXIT_CODES.VALIDATION_WARNINGS}).`,
            );
            process.exit(EXIT_CODES.SUCCESS);
          }
          warn(
            `Validation produced warnings; exiting ${EXIT_CODES.VALIDATION_WARNINGS}. Use --warnings-ok to treat warnings as success.`,
          );
          process.exit(EXIT_CODES.VALIDATION_WARNINGS);
        }
        // Otherwise exit 0 (success)
      } catch (err) {
        error(validationStrings.failed, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // Alias: kspec lint
  program
    .command("lint")
    .description("Alias for validate with style checks")
    .option("--schema", "Check schema conformance only")
    .option("--refs", "Check reference resolution only")
    .option("--orphans", "Find orphaned items only")
    .option(
      "--completeness",
      "Check spec completeness (missing AC, descriptions, status inconsistencies)",
    )
    .option("--fix", "Auto-fix issues where possible (invalid ULIDs, missing timestamps)")
    .option("-v, --verbose", "Show detailed output")
    .option("--strict", "Treat orphans as errors")
    .option("--warnings-ok", "Return success exit code (0) when warnings are present but no errors")
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const structuredOutput = isStructuredMode();

        if (!ctx.manifestPath) {
          error(validationStrings.noManifest);
          process.exit(EXIT_CODES.ERROR);
        }

        const selectedChecks = {
          schema: Boolean(options.schema),
          refs: Boolean(options.refs),
          orphans: Boolean(options.orphans),
          completeness: Boolean(options.completeness),
        };
        const runAll = !Object.values(selectedChecks).some(Boolean);

        // AC: @config-validation ac-4 — CLI --strict overrides config strict_refs
        const strictRefs = options.strict ? true : ctx.config.validation.strict_refs;
        const requireAcceptance = ctx.config.validation.require_acceptance;

        const validateOptions = {
          schema: runAll || selectedChecks.schema,
          refs: runAll || selectedChecks.refs,
          orphans: runAll || selectedChecks.orphans,
          completeness: runAll || selectedChecks.completeness,
          strictRefs,
          requireAcceptance,
        };

        const result = await validate(ctx, validateOptions);

        if (options.strict && result.orphans.length > 0) {
          result.valid = false;
        }

        // AC: @trait-json-output ac-1 — collect all data before output
        let fixResult: FixResult | undefined;
        if (options.fix) {
          const filesToFix = await collectFixableFiles(ctx);
          fixResult = await fixFiles(filesToFix);

          // Re-run validation after fixes
          if (fixResult.fixesApplied.length > 0) {
            if (!structuredOutput) {
              console.log(validationStrings.revalidating);
            }
            const revalidateResult = await validate(ctx, validateOptions);
            if (!structuredOutput) {
              if (revalidateResult.valid) {
                console.log(validationStrings.nowPasses);
              } else {
                console.log(validationStrings.issuesRemain);
              }
            }
            result.valid = revalidateResult.valid;
          }
        }

        // Output: structured mode emits single JSON, text mode uses formatters
        if (structuredOutput) {
          const fullResult: Record<string, unknown> = { ...result };
          if (fixResult !== undefined) {
            fullResult.fixResult = fixResult;
          }
          output(fullResult);
        } else {
          formatValidationResult(result, options.verbose);
          if (fixResult) {
            formatFixResult(fixResult);
          }
        }

        // Determine exit code based on errors vs warnings
        const hasErrors = !result.valid;
        const hasWarnings =
          result.orphans.length > 0 ||
          result.refWarnings.length > 0 ||
          result.completenessWarnings.length > 0;

        if (hasErrors) {
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        } else if (hasWarnings) {
          if (options.warningsOk) {
            warn(
              `Validation produced warnings; exiting 0 due to --warnings-ok (default is ${EXIT_CODES.VALIDATION_WARNINGS}).`,
            );
            process.exit(EXIT_CODES.SUCCESS);
          }
          warn(
            `Validation produced warnings; exiting ${EXIT_CODES.VALIDATION_WARNINGS}. Use --warnings-ok to treat warnings as success.`,
          );
          process.exit(EXIT_CODES.VALIDATION_WARNINGS);
        }
        // Otherwise exit 0 (success)
      } catch (err) {
        error(validationStrings.lintFailed, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
