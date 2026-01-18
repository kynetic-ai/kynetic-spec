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

/**
 * General validation messages
 */
export const validation = {
  noManifest: 'No kspec manifest found',
  initHint: 'Run `kspec init` to create a new project',
  failed: 'Validation failed',
  lintFailed: 'Lint failed',

  revalidating: chalk.gray('\nRe-validating after fixes...'),
  nowPasses: chalk.green.bold('✓ Validation now passes'),
  issuesRemain: chalk.yellow('Some issues remain after auto-fix'),

  alignmentStats: (specsWithTasks: number, totalSpecs: number, aligned: number) =>
    chalk.gray(
      `\nAlignment stats: ${specsWithTasks}/${totalSpecs} specs have tasks, ${aligned} aligned`
    ),
} as const;

/**
 * Shadow command messages
 */
export const shadowCommands = {
  notGitRepo: 'Not a git repository',
  statusFailed: 'Failed to get shadow status',

  repair: {
    alreadyHealthy: 'Shadow branch is already healthy, nothing to repair',
    branchNotExist: 'Shadow branch does not exist',
    initHint: chalk.gray('Run `kspec init` to create a new shadow branch'),
    repairing: 'Repairing shadow branch worktree...',
    stillHealthy: 'Shadow branch is already healthy',
    repaired: 'Shadow branch repaired',
    worktreeCreated: (dir: string) => chalk.green(`  ✓ Recreated worktree: ${dir}/`),
    failed: (error: string) => `Repair failed: ${error}`,
    commandFailed: 'Failed to repair shadow branch',
  },

  log: {
    branchNotExist: 'Shadow branch does not exist',
    initHint: chalk.gray('Run `kspec init` to set up shadow branch'),
    hasIssues: 'Shadow branch has issues',
    repairHint: chalk.gray('Run `kspec shadow repair` to fix'),
    noCommits: 'No commits in shadow branch',
    failed: 'Failed to get shadow log',
  },

  resolve: {
    notHealthy: 'Shadow branch not healthy',
    repairHint: chalk.gray('Run `kspec shadow repair` first'),
    acceptingRemote: 'Accepting remote changes...',
    acceptedRemote: 'Resolved: accepted all remote changes',
    keepingLocal: 'Keeping local changes...',
    keptLocal: 'Resolved: kept local changes and pushed to remote',
    pushFailed: 'Could not push local changes to remote',
    localPreserved: chalk.gray('Local changes are preserved, but remote may differ'),
    failed: 'Failed to resolve conflicts',

    interactive: {
      header: chalk.bold('Shadow Branch Conflict Resolution'),
      separator: chalk.gray('─'.repeat(40)),
      rebaseInProgress: chalk.yellow('A rebase is currently in progress.'),
      options: 'Options:',

      theirs: {
        command: chalk.cyan('  kspec shadow resolve --theirs'),
        description: chalk.gray('    Accept all remote changes, discard local uncommitted work'),
      },
      ours: {
        command: chalk.cyan('  kspec shadow resolve --ours'),
        description: chalk.gray('    Keep local changes and force-push to remote'),
      },
      manual: {
        header: chalk.cyan('  Manual resolution:'),
        cdCommand: (dir: string) => chalk.gray(`    cd ${dir}`),
        rebaseSteps: [
          chalk.gray('    # Edit conflicting files'),
          chalk.gray('    git add <resolved-files>'),
          chalk.gray('    git rebase --continue'),
        ],
        pullSteps: [
          chalk.gray('    git pull --rebase'),
          chalk.gray('    # Resolve any conflicts, then:'),
          chalk.gray('    git push'),
        ],
      },
    },
  },

  sync: {
    notHealthy: 'Shadow branch not healthy',
    repairHint: chalk.gray('Run `kspec shadow repair` first'),
    noRemote: 'No remote tracking configured for shadow branch',
    localOnly: chalk.gray('Shadow changes are local only'),
    syncing: 'Syncing shadow branch...',
    conflictDetected: 'Sync conflict detected',
    resolveHint: chalk.gray('Run `kspec shadow resolve` to fix'),
    syncedBoth: 'Shadow branch synced (pulled and pushed)',
    syncedPull: 'Shadow branch synced (pulled, nothing to push)',
    syncedPush: 'Shadow branch synced (pushed, nothing to pull)',
    alreadyInSync: 'Shadow branch already in sync',
    failed: 'Failed to sync shadow branch',
  },
} as const;
