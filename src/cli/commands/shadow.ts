import { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'node:child_process';
import {
  getShadowStatus,
  repairShadow,
  getGitRoot,
  shadowSync,
  hasRemoteTracking,
  SHADOW_BRANCH_NAME,
  SHADOW_WORKTREE_DIR,
  type ShadowStatus,
} from '../../parser/shadow.js';
import { output, success, error, info, warn } from '../output.js';

/**
 * Format shadow status for display
 */
function formatShadowStatus(status: ShadowStatus, gitRoot: string): void {
  console.log(chalk.bold('Shadow Branch Status'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`Project root: ${gitRoot}`);
  console.log(`Branch name:  ${SHADOW_BRANCH_NAME}`);
  console.log(`Worktree:     ${SHADOW_WORKTREE_DIR}/`);
  console.log();

  if (status.healthy) {
    console.log(chalk.green.bold('✓ Shadow branch is healthy'));
    console.log(chalk.green('  ✓ Branch exists'));
    console.log(chalk.green('  ✓ Worktree exists'));
    console.log(chalk.green('  ✓ Worktree linked'));
  } else if (!status.exists) {
    console.log(chalk.yellow('○ Shadow branch not initialized'));
    console.log(chalk.gray('  Run `kspec init` to set up shadow branch'));
  } else {
    console.log(chalk.red.bold('✗ Shadow branch has issues'));
    console.log(status.branchExists
      ? chalk.green('  ✓ Branch exists')
      : chalk.red('  ✗ Branch missing'));
    console.log(status.worktreeExists
      ? chalk.green('  ✓ Worktree exists')
      : chalk.red('  ✗ Worktree missing'));
    console.log(status.worktreeLinked
      ? chalk.green('  ✓ Worktree linked')
      : chalk.red('  ✗ Worktree not linked'));

    if (status.error) {
      console.log();
      console.log(chalk.yellow(`Issue: ${status.error}`));
    }

    if (status.branchExists) {
      console.log();
      console.log(chalk.gray('Run `kspec shadow repair` to fix'));
    } else {
      console.log();
      console.log(chalk.gray('Run `kspec init --force` to reinitialize'));
    }
  }
}

/**
 * Register shadow commands
 */
export function registerShadowCommands(program: Command): void {
  const shadow = program
    .command('shadow')
    .description('Manage shadow branch for spec storage');

  shadow
    .command('status')
    .description('Show shadow branch status')
    .action(async () => {
      try {
        const gitRoot = getGitRoot(process.cwd());

        if (!gitRoot) {
          error('Not a git repository');
          process.exit(1);
        }

        const status = await getShadowStatus(gitRoot);

        output(
          { ...status, gitRoot, branchName: SHADOW_BRANCH_NAME, worktreeDir: SHADOW_WORKTREE_DIR },
          () => formatShadowStatus(status, gitRoot)
        );

        if (!status.healthy && status.exists) {
          process.exit(1);
        }
      } catch (err) {
        error('Failed to get shadow status', err);
        process.exit(1);
      }
    });

  shadow
    .command('repair')
    .description('Repair broken shadow branch worktree')
    .action(async () => {
      try {
        const gitRoot = getGitRoot(process.cwd());

        if (!gitRoot) {
          error('Not a git repository');
          process.exit(1);
        }

        const status = await getShadowStatus(gitRoot);

        if (status.healthy) {
          info('Shadow branch is already healthy, nothing to repair');
          return;
        }

        if (!status.branchExists) {
          error('Shadow branch does not exist');
          console.log(chalk.gray('Run `kspec init` to create a new shadow branch'));
          process.exit(1);
        }

        info('Repairing shadow branch worktree...');

        const result = await repairShadow(gitRoot);

        if (result.success) {
          if (result.alreadyExists) {
            info('Shadow branch is already healthy');
          } else {
            success('Shadow branch repaired', {
              worktreeCreated: result.worktreeCreated,
            });
            console.log(chalk.green(`  ✓ Recreated worktree: ${SHADOW_WORKTREE_DIR}/`));
          }
        } else {
          error(`Repair failed: ${result.error}`);
          process.exit(1);
        }
      } catch (err) {
        error('Failed to repair shadow branch', err);
        process.exit(1);
      }
    });

  shadow
    .command('log')
    .description('Show recent shadow branch commits')
    .option('-n, --count <n>', 'Number of commits to show', '10')
    .action(async (options) => {
      try {
        const gitRoot = getGitRoot(process.cwd());

        if (!gitRoot) {
          error('Not a git repository');
          process.exit(1);
        }

        const status = await getShadowStatus(gitRoot);

        if (!status.healthy) {
          if (!status.branchExists) {
            warn('Shadow branch does not exist');
            console.log(chalk.gray('Run `kspec init` to set up shadow branch'));
          } else {
            warn('Shadow branch has issues');
            console.log(chalk.gray('Run `kspec shadow repair` to fix'));
          }
          process.exit(1);
        }

        const count = parseInt(options.count, 10) || 10;

        const log = execSync(
          `git log --oneline -n ${count} ${SHADOW_BRANCH_NAME}`,
          { cwd: gitRoot, encoding: 'utf-8' }
        ).trim();

        if (!log) {
          info('No commits in shadow branch');
          return;
        }

        console.log(chalk.bold(`Recent commits on ${SHADOW_BRANCH_NAME}:`));
        console.log(chalk.gray('─'.repeat(40)));
        console.log(log);
      } catch (err) {
        error('Failed to get shadow log', err);
        process.exit(1);
      }
    });

  // AC-5: Shadow resolve command for conflict resolution
  shadow
    .command('resolve')
    .description('Resolve shadow branch sync conflicts')
    .option('--theirs', 'Accept all remote changes, discard local')
    .option('--ours', 'Keep all local changes, discard remote')
    .action(async (options) => {
      try {
        const gitRoot = getGitRoot(process.cwd());

        if (!gitRoot) {
          error('Not a git repository');
          process.exit(1);
        }

        const status = await getShadowStatus(gitRoot);

        if (!status.healthy) {
          error('Shadow branch not healthy');
          console.log(chalk.gray('Run `kspec shadow repair` first'));
          process.exit(1);
        }

        const worktreeDir = `${gitRoot}/${SHADOW_WORKTREE_DIR}`;

        // Check if there's a rebase in progress
        let inRebase = false;
        try {
          execSync('git rebase --show-current-patch', {
            cwd: worktreeDir,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          inRebase = true;
        } catch {
          // Not in rebase
        }

        if (options.theirs) {
          // Accept remote changes
          info('Accepting remote changes...');
          if (inRebase) {
            execSync('git rebase --abort', { cwd: worktreeDir, stdio: 'inherit' });
          }
          execSync(`git fetch origin ${SHADOW_BRANCH_NAME}`, { cwd: worktreeDir, stdio: 'inherit' });
          execSync(`git reset --hard origin/${SHADOW_BRANCH_NAME}`, { cwd: worktreeDir, stdio: 'inherit' });
          success('Resolved: accepted all remote changes');
        } else if (options.ours) {
          // Keep local changes
          info('Keeping local changes...');
          if (inRebase) {
            execSync('git rebase --abort', { cwd: worktreeDir, stdio: 'inherit' });
          }
          // Force push to override remote
          try {
            execSync('git push --force-with-lease', { cwd: worktreeDir, stdio: 'inherit' });
            success('Resolved: kept local changes and pushed to remote');
          } catch {
            warn('Could not push local changes to remote');
            console.log(chalk.gray('Local changes are preserved, but remote may differ'));
          }
        } else {
          // Interactive guidance
          console.log(chalk.bold('Shadow Branch Conflict Resolution'));
          console.log(chalk.gray('─'.repeat(40)));

          if (inRebase) {
            console.log(chalk.yellow('A rebase is currently in progress.'));
            console.log();
          }

          console.log('Options:');
          console.log();
          console.log(chalk.cyan('  kspec shadow resolve --theirs'));
          console.log(chalk.gray('    Accept all remote changes, discard local uncommitted work'));
          console.log();
          console.log(chalk.cyan('  kspec shadow resolve --ours'));
          console.log(chalk.gray('    Keep local changes and force-push to remote'));
          console.log();
          console.log(chalk.cyan('  Manual resolution:'));
          console.log(chalk.gray(`    cd ${SHADOW_WORKTREE_DIR}`));
          if (inRebase) {
            console.log(chalk.gray('    # Edit conflicting files'));
            console.log(chalk.gray('    git add <resolved-files>'));
            console.log(chalk.gray('    git rebase --continue'));
          } else {
            console.log(chalk.gray('    git pull --rebase'));
            console.log(chalk.gray('    # Resolve any conflicts, then:'));
            console.log(chalk.gray('    git push'));
          }
        }
      } catch (err) {
        error('Failed to resolve conflicts', err);
        process.exit(1);
      }
    });

  // Explicit sync command
  shadow
    .command('sync')
    .description('Manually sync shadow branch with remote (pull then push)')
    .action(async () => {
      try {
        const gitRoot = getGitRoot(process.cwd());

        if (!gitRoot) {
          error('Not a git repository');
          process.exit(1);
        }

        const status = await getShadowStatus(gitRoot);

        if (!status.healthy) {
          error('Shadow branch not healthy');
          console.log(chalk.gray('Run `kspec shadow repair` first'));
          process.exit(1);
        }

        const worktreeDir = `${gitRoot}/${SHADOW_WORKTREE_DIR}`;

        if (!(await hasRemoteTracking(worktreeDir))) {
          info('No remote tracking configured for shadow branch');
          console.log(chalk.gray('Shadow changes are local only'));
          return;
        }

        info('Syncing shadow branch...');

        const result = await shadowSync(worktreeDir);

        if (result.hadConflict) {
          warn('Sync conflict detected');
          console.log(chalk.gray('Run `kspec shadow resolve` to fix'));
          process.exit(1);
        }

        if (result.pulled && result.pushed) {
          success('Shadow branch synced (pulled and pushed)');
        } else if (result.pulled) {
          success('Shadow branch synced (pulled, nothing to push)');
        } else if (result.pushed) {
          success('Shadow branch synced (pushed, nothing to pull)');
        } else {
          info('Shadow branch already in sync');
        }
      } catch (err) {
        error('Failed to sync shadow branch', err);
        process.exit(1);
      }
    });
}
