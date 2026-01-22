import * as path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import type { LoadedSpecItem, LoadedTask } from "../../parser/index.js";
import {
  AlignmentIndex,
  type AlignmentWarning,
  type CompletenessWarning,
  type ConventionValidationResult,
  expandIncludePattern,
  type FixResult,
  findTaskFiles,
  fixFiles,
  initContext,
  loadAllItems,
  loadAllTasks,
  loadMetaContext,
  ReferenceIndex,
  type ValidationResult,
  validate,
  validateConventions,
} from "../../parser/index.js";
import { validation as validationStrings } from "../../strings/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, output } from "../output.js";

/**
 * Staleness warning types
 * AC: @stale-status-detection
 */
interface StalenessWarning {
  type:
    | "parent-pending-children-done"
    | "spec-implemented-no-task"
    | "task-done-spec-not-started";
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

  return warnings;
}

/**
 * Format staleness warnings for display
 * AC: @stale-status-detection ac-4
 */
function formatStalenessWarnings(
  warnings: StalenessWarning[],
  verbose: boolean,
): void {
  if (warnings.length === 0) {
    console.log(chalk.green("Staleness: OK"));
    return;
  }

  console.log(chalk.yellow(`\nStaleness warnings: ${warnings.length}`));

  // Group by type
  const parentPending = warnings.filter(
    (w) => w.type === "parent-pending-children-done",
  );
  const specNoTask = warnings.filter(
    (w) => w.type === "spec-implemented-no-task",
  );
  const taskDoneSpecNot = warnings.filter(
    (w) => w.type === "task-done-spec-not-started",
  );

  if (parentPending.length > 0) {
    console.log(
      chalk.yellow(`  Parent pending, children done: ${parentPending.length}`),
    );
    const shown = verbose ? parentPending : parentPending.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.yellow(`    ! ${w.message}`));
    }
    if (!verbose && parentPending.length > 3) {
      console.log(chalk.gray(`    ... and ${parentPending.length - 3} more`));
    }
  }

  if (specNoTask.length > 0) {
    console.log(
      chalk.yellow(`  Spec implemented, no task: ${specNoTask.length}`),
    );
    const shown = verbose ? specNoTask : specNoTask.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.yellow(`    ! ${w.message}`));
    }
    if (!verbose && specNoTask.length > 3) {
      console.log(chalk.gray(`    ... and ${specNoTask.length - 3} more`));
    }
  }

  if (taskDoneSpecNot.length > 0) {
    console.log(
      chalk.yellow(`  Task done, spec not started: ${taskDoneSpecNot.length}`),
    );
    const shown = verbose ? taskDoneSpecNot : taskDoneSpecNot.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.yellow(`    ! ${w.message}`));
    }
    if (!verbose && taskDoneSpecNot.length > 3) {
      console.log(chalk.gray(`    ... and ${taskDoneSpecNot.length - 3} more`));
    }
  }
}

/**
 * Format convention validation results for display
 * AC: @convention-definitions ac-3, ac-4
 */
function formatConventionValidationResult(
  result: ConventionValidationResult,
): void {
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
  console.log(
    chalk.gray(`\nConventions checked: ${result.stats.conventionsChecked}`),
  );
  console.log(
    chalk.gray(`Conventions skipped: ${result.stats.conventionsSkipped}`),
  );
}

/**
 * Format completeness warnings for display
 * AC: @spec-completeness ac-4
 */
function formatCompletenessWarnings(
  warnings: CompletenessWarning[],
  verbose: boolean,
): void {
  if (warnings.length === 0) {
    console.log(chalk.green("Completeness: OK"));
    return;
  }

  console.log(chalk.yellow(`\nCompleteness warnings: ${warnings.length}`));

  // Group by type
  const missingAC = warnings.filter(
    (w) => w.type === "missing_acceptance_criteria",
  );
  const missingDesc = warnings.filter((w) => w.type === "missing_description");
  const statusMismatch = warnings.filter(
    (w) => w.type === "status_inconsistency",
  );
  const missingTestCoverage = warnings.filter(
    (w) => w.type === "missing_test_coverage",
  );
  const automationNoSpec = warnings.filter(
    (w) => w.type === "automation_eligible_no_spec",
  );

  // AC: @spec-completeness ac-4
  // Show summary with counts by issue type
  if (missingAC.length > 0) {
    console.log(
      chalk.yellow(`  Missing acceptance criteria: ${missingAC.length}`),
    );
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
    console.log(
      chalk.yellow(`  Status inconsistencies: ${statusMismatch.length}`),
    );
    for (const w of statusMismatch) {
      console.log(chalk.yellow(`    ! ${w.message}`));
      if (w.details) {
        console.log(chalk.gray(`      ${w.details}`));
      }
    }
  }

  if (missingTestCoverage.length > 0) {
    console.log(
      chalk.yellow(`  Missing test coverage: ${missingTestCoverage.length}`),
    );
    const shown = verbose
      ? missingTestCoverage
      : missingTestCoverage.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.yellow(`    ! ${w.itemRef} - ${w.itemTitle}`));
      if (w.details) {
        console.log(chalk.gray(`      ${w.details}`));
      }
    }
    if (!verbose && missingTestCoverage.length > 3) {
      console.log(
        chalk.gray(`    ... and ${missingTestCoverage.length - 3} more`),
      );
    }
  }

  // AC: @task-automation-eligibility ac-21, ac-23
  if (automationNoSpec.length > 0) {
    console.log(
      chalk.yellow(`  Automation without spec: ${automationNoSpec.length}`),
    );
    const shown = verbose ? automationNoSpec : automationNoSpec.slice(0, 3);
    for (const w of shown) {
      console.log(chalk.yellow(`    ! ${w.itemRef} - ${w.itemTitle}`));
      console.log(chalk.gray(`      ${w.message}`));
    }
    if (!verbose && automationNoSpec.length > 3) {
      console.log(
        chalk.gray(`    ... and ${automationNoSpec.length - 3} more`),
      );
    }
  }
}

/**
 * Format alignment warnings for display
 */
function formatAlignmentWarnings(
  warnings: AlignmentWarning[],
  verbose: boolean,
): void {
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
    console.log(
      chalk.yellow(`  Orphaned specs (no tasks): ${orphaned.length}`),
    );
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
  files.push(
    ...allTaskFiles.filter(
      (f) => !f.includes("fixtures") && !f.includes("test"),
    ),
  );

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
function formatValidationResult(
  result: ValidationResult,
  verbose: boolean,
): void {
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
    console.log(
      chalk.yellow(`\nReference warnings: ${result.refWarnings.length}`),
    );
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
        chalk.gray(
          `  ... and ${result.refWarnings.length - 5} more (use -v to see all)`,
        ),
      );
    }
  }

  // AC: @trait-edge-cases ac-2
  // Trait cycle errors
  if (result.traitCycleErrors.length > 0) {
    console.log(
      chalk.red(`\nTrait cycle errors: ${result.traitCycleErrors.length}`),
    );
    for (const err of result.traitCycleErrors) {
      console.log(chalk.red(`  ✗ ${err.traitRef} - ${err.traitTitle}`));
      console.log(chalk.gray(`    ${err.message}`));
    }
  }

  // Orphans (warnings, not errors)
  if (result.orphans.length > 0) {
    console.log(
      chalk.yellow(`\nOrphans (not referenced): ${result.orphans.length}`),
    );
    if (verbose) {
      for (const orphan of result.orphans) {
        console.log(
          chalk.yellow(
            `  ○ ${orphan.ulid.slice(0, 8)} [${orphan.type}] ${orphan.title}`,
          ),
        );
      }
    } else {
      // Show first few
      const shown = result.orphans.slice(0, 5);
      for (const orphan of shown) {
        console.log(
          chalk.yellow(
            `  ○ ${orphan.ulid.slice(0, 8)} [${orphan.type}] ${orphan.title}`,
          ),
        );
      }
      if (result.orphans.length > 5) {
        console.log(
          chalk.gray(
            `  ... and ${result.orphans.length - 5} more (use -v to see all)`,
          ),
        );
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
    .option(
      "--staleness",
      "Check for stale status mismatches between specs and tasks",
    )
    .option(
      "--fix",
      "Auto-fix issues where possible (invalid ULIDs, missing timestamps)",
    )
    .option("-v, --verbose", "Show detailed output")
    .option("--strict", "Treat orphans and staleness warnings as errors")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(validationStrings.noManifest);
          console.log(validationStrings.initHint);
          process.exit(EXIT_CODES.ERROR);
        }

        // Determine which checks to run
        const runAll =
          !options.schema &&
          !options.refs &&
          !options.orphans &&
          !options.alignment &&
          !options.completeness &&
          !options.conventions;
        const validateOptions = {
          schema: runAll || options.schema,
          refs: runAll || options.refs,
          orphans: runAll || options.orphans,
          completeness: runAll || options.completeness,
        };

        const result = await validate(ctx, validateOptions);

        // In strict mode, orphans are errors
        if (options.strict && result.orphans.length > 0) {
          result.valid = false;
        }

        output(result, () => formatValidationResult(result, options.verbose));

        // Run auto-fix if requested
        if (options.fix) {
          const filesToFix = await collectFixableFiles(ctx);
          const fixResult = await fixFiles(filesToFix);
          formatFixResult(fixResult);

          // Re-run validation after fixes to show updated status
          if (fixResult.fixesApplied.length > 0) {
            console.log(validationStrings.revalidating);
            const revalidateResult = await validate(ctx, validateOptions);
            if (revalidateResult.valid) {
              console.log(validationStrings.nowPasses);
            } else {
              console.log(validationStrings.issuesRemain);
            }
            // Update result for exit code
            result.valid = revalidateResult.valid;
            result.schemaErrors = revalidateResult.schemaErrors;
            result.refErrors = revalidateResult.refErrors;
          }
        }

        // Run alignment check if requested or running all checks
        if (options.alignment || runAll) {
          const tasks = await loadAllTasks(ctx);
          const items = await loadAllItems(ctx);
          const refIndex = new ReferenceIndex(tasks, items);
          const alignmentIndex = new AlignmentIndex(tasks, items);
          alignmentIndex.buildLinks(refIndex);

          const alignmentWarnings = alignmentIndex.findAlignmentWarnings();
          formatAlignmentWarnings(alignmentWarnings, options.verbose);

          // Show alignment stats
          const stats = alignmentIndex.getStats();
          console.log(
            validationStrings.alignmentStats(
              stats.specsWithTasks,
              stats.totalSpecs,
              stats.alignedSpecs,
            ),
          );
        }

        // Show completeness warnings if any
        // AC: @spec-completeness ac-4
        if (result.completenessWarnings.length > 0) {
          formatCompletenessWarnings(
            result.completenessWarnings,
            options.verbose,
          );
        }

        // Run convention validation if requested
        // AC: @convention-definitions ac-3, ac-4
        if (options.conventions) {
          try {
            const metaCtx = await loadMetaContext(ctx);
            if (metaCtx && metaCtx.conventions.length > 0) {
              // For now, we just validate that conventions are well-formed
              // Full validation against actual content (commits, notes, etc.)
              // would require additional content gathering logic
              const conventionResult = validateConventions(
                metaCtx.conventions,
                {},
              );
              formatConventionValidationResult(conventionResult);

              if (!conventionResult.valid) {
                result.valid = false;
              }
            } else {
              console.log(
                chalk.gray("No conventions defined in meta manifest"),
              );
            }
          } catch (_err) {
            console.log(
              chalk.yellow(
                "Warning: Could not load meta manifest for convention validation",
              ),
            );
          }
        }

        // Run staleness checks if requested
        // AC: @stale-status-detection ac-4, ac-5
        if (options.staleness) {
          const tasks = await loadAllTasks(ctx);
          const items = await loadAllItems(ctx);
          const refIndex = new ReferenceIndex(tasks, items);

          const stalenessWarnings = checkStaleness(items, tasks, refIndex);
          formatStalenessWarnings(stalenessWarnings, options.verbose);

          // AC: @stale-status-detection ac-5 (staleness-exit-code)
          // With --strict, staleness warnings cause validation failure
          if (options.strict && stalenessWarnings.length > 0) {
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
        }

        if (!result.valid) {
          process.exit(EXIT_CODES.ERROR);
        }
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
    .option(
      "--fix",
      "Auto-fix issues where possible (invalid ULIDs, missing timestamps)",
    )
    .option("-v, --verbose", "Show detailed output")
    .option("--strict", "Treat orphans as errors")
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(validationStrings.noManifest);
          process.exit(EXIT_CODES.ERROR);
        }

        const runAll =
          !options.schema &&
          !options.refs &&
          !options.orphans &&
          !options.completeness;
        const validateOptions = {
          schema: runAll || options.schema,
          refs: runAll || options.refs,
          orphans: runAll || options.orphans,
          completeness: runAll || options.completeness,
        };

        const result = await validate(ctx, validateOptions);

        if (options.strict && result.orphans.length > 0) {
          result.valid = false;
        }

        output(result, () => formatValidationResult(result, options.verbose));

        // Run auto-fix if requested
        if (options.fix) {
          const filesToFix = await collectFixableFiles(ctx);
          const fixResult = await fixFiles(filesToFix);
          formatFixResult(fixResult);

          // Re-run validation after fixes
          if (fixResult.fixesApplied.length > 0) {
            console.log(validationStrings.revalidating);
            const revalidateResult = await validate(ctx, validateOptions);
            if (revalidateResult.valid) {
              console.log(validationStrings.nowPasses);
            } else {
              console.log(validationStrings.issuesRemain);
            }
            result.valid = revalidateResult.valid;
          }
        }

        if (!result.valid) {
          process.exit(EXIT_CODES.ERROR);
        }
      } catch (err) {
        error(validationStrings.lintFailed, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
