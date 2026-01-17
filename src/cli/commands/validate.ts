import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  initContext,
  validate,
  loadAllTasks,
  loadAllItems,
  AlignmentIndex,
  ReferenceIndex,
  fixFiles,
  findTaskFiles,
  expandIncludePattern,
  type ValidationResult,
  type AlignmentWarning,
  type FixResult,
} from '../../parser/index.js';
import { output, success, error, info } from '../output.js';

/**
 * Format alignment warnings for display
 */
function formatAlignmentWarnings(warnings: AlignmentWarning[], verbose: boolean): void {
  if (warnings.length === 0) {
    console.log(chalk.green('Alignment: OK'));
    return;
  }

  console.log(chalk.yellow(`\nAlignment warnings: ${warnings.length}`));

  // Group by type
  const orphaned = warnings.filter(w => w.type === 'orphaned_spec');
  const mismatches = warnings.filter(w => w.type === 'status_mismatch');
  const stale = warnings.filter(w => w.type === 'stale_implementation');

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
    console.log(chalk.gray('\nNo auto-fixable issues found.'));
    return;
  }

  console.log(chalk.cyan(`\n✓ Applied ${result.fixesApplied.length} fix(es) to ${result.filesModified} file(s):`));

  for (const fix of result.fixesApplied) {
    const typeLabel = {
      ulid_regenerated: 'ULID regenerated',
      timestamp_added: 'Timestamp added',
      status_added: 'Status added',
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
async function collectFixableFiles(ctx: { rootDir: string; specDir?: string; manifest?: { includes?: string[] } | null; manifestPath?: string | null }): Promise<string[]> {
  const files: string[] = [];

  // Task files (exclude test fixtures)
  const taskFiles = await findTaskFiles(ctx.rootDir);
  const specTaskFiles = await findTaskFiles(path.join(ctx.rootDir, 'spec'));
  const allTaskFiles = [...new Set([...taskFiles, ...specTaskFiles])];
  files.push(...allTaskFiles.filter(f => !f.includes('fixtures') && !f.includes('test')));

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
  const inboxPath = path.join(ctx.rootDir, 'spec', 'kynetic.inbox.yaml');
  try {
    await import('node:fs/promises').then(fs => fs.access(inboxPath));
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
    console.log(chalk.green.bold('✓ Validation passed'));
  } else {
    console.log(chalk.red.bold('✗ Validation failed'));
  }

  console.log(chalk.gray('─'.repeat(40)));
  console.log(`Files checked: ${result.stats.filesChecked}`);
  console.log(`Items checked: ${result.stats.itemsChecked}`);
  console.log(`Tasks checked: ${result.stats.tasksChecked}`);

  // AC-meta-manifest-2: Display meta summary line
  if (result.metaStats) {
    console.log(`Meta: ${result.metaStats.agents} agents, ${result.metaStats.workflows} workflows, ${result.metaStats.conventions} conventions`);
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
    console.log(chalk.green('\nSchema: OK'));
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
    console.log(chalk.green('References: OK'));
  }

  // Orphans (warnings, not errors)
  if (result.orphans.length > 0) {
    console.log(chalk.yellow(`\nOrphans (not referenced): ${result.orphans.length}`));
    if (verbose) {
      for (const orphan of result.orphans) {
        console.log(chalk.yellow(`  ○ ${orphan.ulid.slice(0, 8)} [${orphan.type}] ${orphan.title}`));
      }
    } else {
      // Show first few
      const shown = result.orphans.slice(0, 5);
      for (const orphan of shown) {
        console.log(chalk.yellow(`  ○ ${orphan.ulid.slice(0, 8)} [${orphan.type}] ${orphan.title}`));
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
    .command('validate')
    .description('Validate spec files')
    .option('--schema', 'Check schema conformance only')
    .option('--refs', 'Check reference resolution only')
    .option('--orphans', 'Find orphaned items only')
    .option('--alignment', 'Check spec-task alignment')
    .option('--fix', 'Auto-fix issues where possible (invalid ULIDs, missing timestamps)')
    .option('-v, --verbose', 'Show detailed output')
    .option('--strict', 'Treat orphans as errors')
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error('No kspec manifest found');
          console.log('Run `kspec init` to create a new project');
          process.exit(1);
        }

        // Determine which checks to run
        const runAll = !options.schema && !options.refs && !options.orphans && !options.alignment;
        const validateOptions = {
          schema: runAll || options.schema,
          refs: runAll || options.refs,
          orphans: runAll || options.orphans,
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
            console.log(chalk.gray('\nRe-validating after fixes...'));
            const revalidateResult = await validate(ctx, validateOptions);
            if (revalidateResult.valid) {
              console.log(chalk.green.bold('✓ Validation now passes'));
            } else {
              console.log(chalk.yellow('Some issues remain after auto-fix'));
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
          console.log(chalk.gray(`\nAlignment stats: ${stats.specsWithTasks}/${stats.totalSpecs} specs have tasks, ${stats.alignedSpecs} aligned`));
        }

        if (!result.valid) {
          process.exit(1);
        }
      } catch (err) {
        error('Validation failed', err);
        process.exit(1);
      }
    });

  // Alias: kspec lint
  program
    .command('lint')
    .description('Alias for validate with style checks')
    .option('--schema', 'Check schema conformance only')
    .option('--refs', 'Check reference resolution only')
    .option('--orphans', 'Find orphaned items only')
    .option('--fix', 'Auto-fix issues where possible (invalid ULIDs, missing timestamps)')
    .option('-v, --verbose', 'Show detailed output')
    .option('--strict', 'Treat orphans as errors')
    .action(async (options) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error('No kspec manifest found');
          process.exit(1);
        }

        const runAll = !options.schema && !options.refs && !options.orphans;
        const validateOptions = {
          schema: runAll || options.schema,
          refs: runAll || options.refs,
          orphans: runAll || options.orphans,
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
            console.log(chalk.gray('\nRe-validating after fixes...'));
            const revalidateResult = await validate(ctx, validateOptions);
            if (revalidateResult.valid) {
              console.log(chalk.green.bold('✓ Validation now passes'));
            } else {
              console.log(chalk.yellow('Some issues remain after auto-fix'));
            }
            result.valid = revalidateResult.valid;
          }
        }

        if (!result.valid) {
          process.exit(1);
        }
      } catch (err) {
        error('Lint failed', err);
        process.exit(1);
      }
    });
}
