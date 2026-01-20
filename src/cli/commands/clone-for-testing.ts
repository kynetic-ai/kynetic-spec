import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { ulid } from 'ulid';
import { output, error as outputError } from '../output.js';
import { EXIT_CODES } from '../exit-codes.js';

// AC: @cmd-clone-for-testing ac-1
/**
 * Creates isolated repo copy for testing
 * - Clones source repo to destination
 * - Removes remote origin for isolation
 * - Preserves all branches including kspec-meta
 */
function cloneRepo(source: string, dest: string): { success: boolean; error?: string } {
  // Clone with --mirror to get all branches
  const cloneResult = spawnSync('git', [
    'clone',
    '--mirror',
    source,
    path.join(dest, '.git')
  ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  if (cloneResult.status !== 0) {
    return { success: false, error: cloneResult.stderr };
  }

  // Convert bare mirror repo to normal repo
  const configResult = spawnSync('git', [
    'config',
    '--bool',
    'core.bare',
    'false'
  ], { cwd: dest, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  if (configResult.status !== 0) {
    return { success: false, error: configResult.stderr };
  }

  // Reset working tree to populate files
  const resetResult = spawnSync('git', ['reset', '--hard'], {
    cwd: dest,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (resetResult.status !== 0) {
    return { success: false, error: resetResult.stderr };
  }

  // Remove remote references for true isolation
  const remoteResult = spawnSync('git', ['remote', 'remove', 'origin'], {
    cwd: dest,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Don't fail if no remote exists
  // remoteResult.status will be non-zero if origin doesn't exist, which is fine

  return { success: true };
}

// AC: @cmd-clone-for-testing ac-2
/**
 * Sets up .kspec worktree if kspec-meta branch exists
 */
function setupWorktree(repoPath: string): { success: boolean; error?: string } {
  // Check for kspec-meta branch
  const branchCheck = spawnSync('git', [
    'branch', '--list', 'kspec-meta'
  ], { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  if (!branchCheck.stdout.trim()) {
    // No kspec-meta branch, nothing to do
    return { success: true };
  }

  // Create .kspec worktree
  const worktreePath = path.join(repoPath, '.kspec');
  const worktreeResult = spawnSync('git', [
    'worktree', 'add', '.kspec', 'kspec-meta'
  ], { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  if (worktreeResult.status !== 0) {
    return { success: false, error: worktreeResult.stderr };
  }

  return { success: true };
}

// AC: @cmd-clone-for-testing ac-3
/**
 * Checkout specified branch
 */
function checkoutBranch(repoPath: string, branch: string): { success: boolean; error?: string; currentBranch: string } {
  const checkoutResult = spawnSync('git', ['checkout', branch], {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (checkoutResult.status !== 0) {
    return { success: false, error: checkoutResult.stderr, currentBranch: '' };
  }

  // Get current branch name
  const branchResult = spawnSync('git', ['branch', '--show-current'], {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return { success: true, currentBranch: branchResult.stdout.trim() };
}

/**
 * Get current branch name
 */
function getCurrentBranch(repoPath: string): string {
  const branchResult = spawnSync('git', ['branch', '--show-current'], {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return branchResult.stdout.trim() || 'main';
}

/**
 * Register the 'clone-for-testing' command
 */
export function registerCloneForTestingCommand(program: Command): void {
  program
    .command('clone-for-testing [dest] [source]')
    .description('Create isolated repo copy for testing')
    .option('--branch <name>', 'Branch to checkout after cloning')
    .option('--json', 'Output result as JSON')
    .action(async (dest: string | undefined, source: string | undefined, options: { branch?: string; json?: boolean }) => {
      // Default source to current directory
      if (!source) {
        source = process.cwd();
      }

    try {
      // AC: @cmd-clone-for-testing ac-4
      // Generate temp dest if not provided
      if (!dest) {
        dest = path.join(os.tmpdir(), `kspec-test-${ulid().slice(0, 8).toLowerCase()}`);
      }

      // Create destination directory
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }

      // Clone the repo
      const cloneResult = cloneRepo(source, dest);
      if (!cloneResult.success) {
        outputError(`Failed to clone repository: ${cloneResult.error}`);
        process.exit(EXIT_CODES.ERROR);
      }

      // Setup worktree if kspec-meta exists
      const worktreeResult = setupWorktree(dest);
      if (!worktreeResult.success) {
        outputError(`Failed to setup worktree: ${worktreeResult.error}`);
        process.exit(EXIT_CODES.ERROR);
      }

      // Checkout specified branch if provided
      let currentBranch = getCurrentBranch(dest);
      if (options.branch) {
        const checkoutResult = checkoutBranch(dest, options.branch);
        if (!checkoutResult.success) {
          outputError(`Failed to checkout branch '${options.branch}': ${checkoutResult.error}`);
          process.exit(EXIT_CODES.ERROR);
        }
        currentBranch = checkoutResult.currentBranch;
      }

      // AC: @cmd-clone-for-testing ac-5
      // Output result
      if (options.json) {
        // Output raw JSON object (not wrapped in success object)
        console.log(JSON.stringify({ path: dest, branch: currentBranch }));
      } else {
        output({ path: dest, branch: currentBranch }, () => {
          console.log(`Created test repo at: ${dest}`);
          if (options.branch) {
            console.log(`Checked out branch: ${currentBranch}`);
          }
        });
      }
      } catch (err) {
        outputError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
