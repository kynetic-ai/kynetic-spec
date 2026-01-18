/**
 * Validation warning and status messages
 */

import chalk from 'chalk';

/**
 * Alignment validation messages
 */
export const alignment = {
  ok: chalk.green('Alignment: OK'),
  warnings: (count: number) => chalk.yellow(`Alignment warnings: ${count}`),

  orphanedSpecs: {
    header: chalk.yellow('\nOrphaned specs (no implementation status):'),
    item: (ref: string, title: string) => `  ${ref}: ${title}`,
    truncated: (remaining: number) =>
      chalk.gray(`  ... and ${remaining} more (use --verbose to see all)`),
  },

  statusMismatches: {
    header: chalk.yellow('\nStatus mismatches (task status != spec implementation):'),
    item: (ref: string, title: string, taskStatus: string, specImpl: string) =>
      `  ${ref}: ${title} (task=${taskStatus}, spec=${specImpl})`,
  },

  staleImplementation: {
    header: chalk.yellow('\nStale implementation status (task completed but spec not implemented):'),
    item: (ref: string, title: string) => `  ${ref}: ${title}`,
  },

  noFixes: chalk.gray('No auto-fixable issues found.'),
  fixesApplied: (count: number, files: number) =>
    chalk.cyan(`✓ Applied ${count} fix(es) to ${files} file(s):`),
} as const;

/**
 * Shadow branch status messages
 */
export const shadowBranch = {
  header: chalk.bold('Shadow Branch Status'),

  healthy: chalk.green.bold('✓ Shadow branch is healthy'),

  notInitialized: {
    status: chalk.yellow('○ Shadow branch not initialized'),
    hint: chalk.gray('Run `kspec init` to set up shadow branch'),
  },

  hasIssues: {
    status: chalk.red.bold('✗ Shadow branch has issues'),
    repair: chalk.gray('Run `kspec shadow repair` to fix issues'),
    reinitialize: chalk.gray('Or `kspec init --force` to reinitialize'),
  },
} as const;
