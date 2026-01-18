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
import { shadowCommands } from '../../strings/index.js';

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
          error(shadowCommands.notGitRepo);
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
        error(shadowCommands.statusFailed, err);
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
          error(shadowCommands.notGitRepo);
          process.exit(1);
        }

        const status = await getShadowStatus(gitRoot);

        if (status.healthy) {
          info(shadowCommands.repair.alreadyHealthy);
          return;
        }

        if (!status.branchExists) {
          error(shadowCommands.repair.branchNotExist);
          console.log(shadowCommands.repair.initHint);
          process.exit(1);
        }

        info(shadowCommands.repair.repairing);

        const result = await repairShadow(gitRoot);

        if (result.success) {
          if (result.alreadyExists) {
            info(shadowCommands.repair.stillHealthy);
          } else {
            success(shadowCommands.repair.repaired, {
              worktreeCreated: result.worktreeCreated,
            });
            console.log(shadowCommands.repair.worktreeCreated(SHADOW_WORKTREE_DIR));
          }
        } else {
          error(shadowCommands.repair.failed(result.error || 'Unknown error'));
          process.exit(1);
        }
      } catch (err) {
        error(shadowCommands.repair.commandFailed, err);
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
          error(shadowCommands.notGitRepo);
          process.exit(1);
        }

        const status = await getShadowStatus(gitRoot);

        if (!status.healthy) {
          if (!status.branchExists) {
            warn(shadowCommands.log.branchNotExist);
            console.log(shadowCommands.log.initHint);
          } else {
            warn(shadowCommands.log.hasIssues);
            console.log(shadowCommands.log.repairHint);
          }
          process.exit(1);
        }

        const count = parseInt(options.count, 10) || 10;

        const log = execSync(
          `git log --oneline -n ${count} ${SHADOW_BRANCH_NAME}`,
          { cwd: gitRoot, encoding: 'utf-8' }
        ).trim();

        if (!log) {
          info(shadowCommands.log.noCommits);
          return;
        }

        console.log(chalk.bold(`Recent commits on ${SHADOW_BRANCH_NAME}:`));
        console.log(chalk.gray('─'.repeat(40)));
        console.log(log);
      } catch (err) {
        error(shadowCommands.log.failed, err);
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
          error(shadowCommands.notGitRepo);
          process.exit(1);
        }

        const status = await getShadowStatus(gitRoot);

        if (!status.healthy) {
          error(shadowCommands.resolve.notHealthy);
          console.log(shadowCommands.resolve.repairHint);
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
          info(shadowCommands.resolve.acceptingRemote);
          if (inRebase) {
            execSync('git rebase --abort', { cwd: worktreeDir, stdio: 'inherit' });
          }
          execSync(`git fetch origin ${SHADOW_BRANCH_NAME}`, { cwd: worktreeDir, stdio: 'inherit' });
          execSync(`git reset --hard origin/${SHADOW_BRANCH_NAME}`, { cwd: worktreeDir, stdio: 'inherit' });
          success(shadowCommands.resolve.acceptedRemote);
        } else if (options.ours) {
          // Keep local changes
          info(shadowCommands.resolve.keepingLocal);
          if (inRebase) {
            execSync('git rebase --abort', { cwd: worktreeDir, stdio: 'inherit' });
          }
          // Force push to override remote
          try {
            execSync('git push --force-with-lease', { cwd: worktreeDir, stdio: 'inherit' });
            success(shadowCommands.resolve.keptLocal);
          } catch {
            warn(shadowCommands.resolve.pushFailed);
            console.log(shadowCommands.resolve.localPreserved);
          }
        } else {
          // Interactive guidance
          console.log(shadowCommands.resolve.interactive.header);
          console.log(shadowCommands.resolve.interactive.separator);

          if (inRebase) {
            console.log(shadowCommands.resolve.interactive.rebaseInProgress);
            console.log();
          }

          console.log(shadowCommands.resolve.interactive.options);
          console.log();
          console.log(shadowCommands.resolve.interactive.theirs.command);
          console.log(shadowCommands.resolve.interactive.theirs.description);
          console.log();
          console.log(shadowCommands.resolve.interactive.ours.command);
          console.log(shadowCommands.resolve.interactive.ours.description);
          console.log();
          console.log(shadowCommands.resolve.interactive.manual.header);
          console.log(shadowCommands.resolve.interactive.manual.cdCommand(SHADOW_WORKTREE_DIR));
          if (inRebase) {
            shadowCommands.resolve.interactive.manual.rebaseSteps.forEach((step) => console.log(step));
          } else {
            shadowCommands.resolve.interactive.manual.pullSteps.forEach((step) => console.log(step));
          }
        }
      } catch (err) {
        error(shadowCommands.resolve.failed, err);
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
          error(shadowCommands.notGitRepo);
          process.exit(1);
        }

        const status = await getShadowStatus(gitRoot);

        if (!status.healthy) {
          error(shadowCommands.sync.notHealthy);
          console.log(shadowCommands.sync.repairHint);
          process.exit(1);
        }

        const worktreeDir = `${gitRoot}/${SHADOW_WORKTREE_DIR}`;

        if (!(await hasRemoteTracking(worktreeDir))) {
          info(shadowCommands.sync.noRemote);
          console.log(shadowCommands.sync.localOnly);
          return;
        }

        info(shadowCommands.sync.syncing);

        const result = await shadowSync(worktreeDir);

        if (result.hadConflict) {
          warn(shadowCommands.sync.conflictDetected);
          console.log(shadowCommands.sync.resolveHint);
          process.exit(1);
        }

        if (result.pulled && result.pushed) {
          success(shadowCommands.sync.syncedBoth);
        } else if (result.pulled) {
          success(shadowCommands.sync.syncedPull);
        } else if (result.pushed) {
          success(shadowCommands.sync.syncedPush);
        } else {
          info(shadowCommands.sync.alreadyInSync);
        }
      } catch (err) {
        error(shadowCommands.sync.failed, err);
        process.exit(1);
      }
    });
}
