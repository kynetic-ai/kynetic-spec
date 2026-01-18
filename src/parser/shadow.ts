/**
 * Shadow branch utilities for transparent spec/task state tracking.
 *
 * Shadow branch concept:
 * - Orphan branch (kspec-meta) stores kspec state
 * - .kspec/ directory is a git worktree pointing to shadow branch
 * - Main branch gitignores .kspec/
 * - All kspec read/write operations target .kspec/
 * - Changes auto-commit to shadow branch
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Shadow branch configuration
 */
export interface ShadowConfig {
  /** Whether shadow branch is enabled/detected */
  enabled: boolean;
  /** Path to .kspec/ worktree directory */
  worktreeDir: string;
  /** Shadow branch name (default: kspec-meta) */
  branchName: string;
  /** Project root (where .kspec/ lives) */
  projectRoot: string;
}

/**
 * Shadow branch status
 */
export interface ShadowStatus {
  exists: boolean;
  healthy: boolean;
  branchExists: boolean;
  worktreeExists: boolean;
  worktreeLinked: boolean;
  error?: string;
}

/**
 * Error types for shadow branch issues
 */
export class ShadowError extends Error {
  constructor(
    message: string,
    public code: 'NOT_INITIALIZED' | 'WORKTREE_DISCONNECTED' | 'DIRECTORY_MISSING' | 'GIT_ERROR',
    public suggestion: string
  ) {
    super(message);
    this.name = 'ShadowError';
  }
}

/**
 * Default shadow branch name
 */
export const SHADOW_BRANCH_NAME = 'kspec-meta';

/**
 * Default shadow worktree directory
 */
export const SHADOW_WORKTREE_DIR = '.kspec';

/**
 * Check if debug mode is enabled.
 * Debug mode can be enabled via:
 * - KSPEC_DEBUG=1 environment variable
 * - --verbose flag passed to commands
 *
 * When enabled, shadow branch operations output detailed information.
 */
export function isDebugMode(verboseFlag?: boolean): boolean {
  return process.env.KSPEC_DEBUG === '1' || verboseFlag === true;
}

/**
 * Check if we're in a git repository
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    execSync('git rev-parse --git-dir', {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the git root directory
 */
export function getGitRoot(dir: string): string | null {
  try {
    const result = execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();
    return result;
  } catch {
    return null;
  }
}

/**
 * Check if a branch exists
 */
export async function branchExists(dir: string, branchName: string): Promise<boolean> {
  try {
    execSync(`git show-ref --verify --quiet refs/heads/${branchName}`, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a directory is a valid git worktree
 */
export async function isValidWorktree(worktreeDir: string): Promise<boolean> {
  try {
    // Check if .git file exists (worktrees have a .git file, not directory)
    const gitPath = path.join(worktreeDir, '.git');
    const stat = await fs.stat(gitPath);

    if (stat.isFile()) {
      // Read the .git file to verify it points to a worktree
      const content = await fs.readFile(gitPath, 'utf-8');
      return content.trim().startsWith('gitdir:');
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Detect shadow branch configuration from a directory.
 * Returns shadow config if .kspec/ exists and is valid.
 */
export async function detectShadow(startDir: string): Promise<ShadowConfig | null> {
  const gitRoot = getGitRoot(startDir);
  if (!gitRoot) {
    return null;
  }

  const worktreeDir = path.join(gitRoot, SHADOW_WORKTREE_DIR);

  try {
    await fs.access(worktreeDir);

    // Verify it's a valid worktree
    if (await isValidWorktree(worktreeDir)) {
      return {
        enabled: true,
        worktreeDir,
        branchName: SHADOW_BRANCH_NAME,
        projectRoot: gitRoot,
      };
    }

    // Directory exists but not a valid worktree
    return null;
  } catch {
    // .kspec/ doesn't exist
    return null;
  }
}

/**
 * Get detailed shadow branch status
 */
export async function getShadowStatus(projectRoot: string): Promise<ShadowStatus> {
  const worktreeDir = path.join(projectRoot, SHADOW_WORKTREE_DIR);

  const status: ShadowStatus = {
    exists: false,
    healthy: false,
    branchExists: false,
    worktreeExists: false,
    worktreeLinked: false,
  };

  // Check if we're in a git repo
  if (!(await isGitRepo(projectRoot))) {
    status.error = 'Not a git repository';
    return status;
  }

  // Check if branch exists
  status.branchExists = await branchExists(projectRoot, SHADOW_BRANCH_NAME);

  // Check if worktree directory exists
  try {
    await fs.access(worktreeDir);
    status.worktreeExists = true;
  } catch {
    status.worktreeExists = false;
  }

  // Check if worktree is properly linked
  if (status.worktreeExists) {
    status.worktreeLinked = await isValidWorktree(worktreeDir);
  }

  // Determine overall status
  status.exists = status.branchExists || status.worktreeExists;
  status.healthy = status.branchExists && status.worktreeExists && status.worktreeLinked;

  if (!status.healthy && status.exists) {
    if (!status.branchExists) {
      status.error = 'Shadow branch missing but worktree exists';
    } else if (!status.worktreeExists) {
      status.error = 'Shadow branch exists but worktree missing';
    } else if (!status.worktreeLinked) {
      status.error = 'Worktree exists but not properly linked';
    }
  }

  return status;
}

/**
 * Create an appropriate ShadowError based on status
 */
export function createShadowError(status: ShadowStatus): ShadowError {
  if (!status.branchExists && !status.worktreeExists) {
    return new ShadowError(
      'Shadow branch not initialized',
      'NOT_INITIALIZED',
      'Run `kspec init` to create shadow branch and worktree.'
    );
  }

  if (status.branchExists && !status.worktreeExists) {
    return new ShadowError(
      '.kspec/ directory missing',
      'DIRECTORY_MISSING',
      'Run `kspec shadow repair` to recreate the worktree.'
    );
  }

  if (status.worktreeExists && !status.worktreeLinked) {
    return new ShadowError(
      'Worktree disconnected from git',
      'WORKTREE_DISCONNECTED',
      'Run `kspec shadow repair` to fix the worktree link.'
    );
  }

  return new ShadowError(
    status.error || 'Unknown shadow branch error',
    'GIT_ERROR',
    'Check git status and try `kspec shadow repair`.'
  );
}

/**
 * Auto-commit changes to shadow branch.
 * Called after write operations when shadow is enabled.
 *
 * @param worktreeDir Path to .kspec/ directory
 * @param message Commit message
 * @param verbose Enable debug output (defaults to KSPEC_DEBUG env var)
 * @returns true if commit succeeded, false if nothing to commit
 */
export async function shadowAutoCommit(
  worktreeDir: string,
  message: string,
  verbose?: boolean
): Promise<boolean> {
  const debug = isDebugMode(verbose);

  try {
    if (debug) {
      console.error(`[DEBUG] Shadow auto-commit: git add -A (cwd: ${worktreeDir})`);
    }

    // Stage all changes
    execSync('git add -A', {
      cwd: worktreeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Check if there are staged changes
    try {
      if (debug) {
        console.error(`[DEBUG] Shadow auto-commit: git diff --cached --quiet`);
      }

      execSync('git diff --cached --quiet', {
        cwd: worktreeDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // No error = no changes
      if (debug) {
        console.error(`[DEBUG] Shadow auto-commit: No changes to commit`);
      }
      return false;
    } catch {
      // Error = there are changes, proceed with commit
    }

    if (debug) {
      console.error(`[DEBUG] Shadow auto-commit: git commit -m "${message}"`);
    }

    // Commit with message
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: worktreeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (debug) {
      console.error(`[DEBUG] Shadow auto-commit: Success`);
    }

    return true;
  } catch (error) {
    // AC: Only log error if debug mode enabled
    if (debug) {
      console.error('Shadow auto-commit failed:', error);
    }
    return false;
  }
}

/**
 * Generate commit message for a kspec operation.
 */
export function generateCommitMessage(
  operation: string,
  ref?: string,
  detail?: string
): string {
  const parts: string[] = [];

  switch (operation) {
    case 'task-start':
      parts.push(`Start @${ref}`);
      break;
    case 'task-complete':
      parts.push(`Complete @${ref}`);
      if (detail) parts.push(`: ${detail}`);
      break;
    case 'task-note':
      parts.push(`Note on @${ref}`);
      break;
    case 'task-add':
      parts.push(`Add task: ${detail || ref}`);
      break;
    case 'inbox-add':
      parts.push(`Inbox: ${detail?.slice(0, 50)}${(detail?.length || 0) > 50 ? '...' : ''}`);
      break;
    case 'inbox-promote':
      parts.push(`Promote to @${ref}`);
      break;
    case 'item-add':
      parts.push(`Add @${ref}`);
      break;
    case 'item-set':
      parts.push(`Update @${ref}`);
      break;
    case 'item-delete':
      parts.push(`Delete @${ref}`);
      break;
    case 'derive':
      parts.push(`Derive from @${ref}`);
      break;
    default:
      parts.push(operation);
      if (ref) parts.push(` @${ref}`);
  }

  return parts.join('');
}

/**
 * Resolve a path relative to shadow worktree if enabled.
 * Falls back to original path if shadow is not enabled.
 */
export function resolveShadowPath(
  originalPath: string,
  shadowConfig: ShadowConfig | null,
  projectRoot: string
): string {
  if (!shadowConfig?.enabled) {
    return originalPath;
  }

  // If the path is within the project root, rewrite to shadow worktree
  const relativePath = path.relative(projectRoot, originalPath);

  // Skip if path is outside project or already in .kspec
  if (relativePath.startsWith('..') || relativePath.startsWith(SHADOW_WORKTREE_DIR)) {
    return originalPath;
  }

  // Handle spec/ -> .kspec/ mapping
  if (relativePath.startsWith('spec/') || relativePath.startsWith('spec\\')) {
    const specRelative = relativePath.slice(5); // Remove 'spec/'
    return path.join(shadowConfig.worktreeDir, specRelative);
  }

  // For task/inbox files at root, move to .kspec
  if (relativePath.endsWith('.tasks.yaml') || relativePath.endsWith('.inbox.yaml')) {
    return path.join(shadowConfig.worktreeDir, relativePath);
  }

  return originalPath;
}

/**
 * Commit changes to shadow branch if enabled.
 * This is the primary interface for CLI commands to trigger auto-commit.
 *
 * @param shadowConfig Shadow configuration (from KspecContext.shadow)
 * @param operation Operation type (e.g., 'task-start', 'task-complete')
 * @param ref Reference slug or ULID (optional)
 * @param detail Additional detail for commit message (optional)
 * @param verbose Enable debug output (defaults to KSPEC_DEBUG env var)
 * @returns true if committed, false if shadow not enabled or nothing to commit
 */
export async function commitIfShadow(
  shadowConfig: ShadowConfig | null,
  operation: string,
  ref?: string,
  detail?: string,
  verbose?: boolean
): Promise<boolean> {
  if (!shadowConfig?.enabled) {
    return false;
  }

  const message = generateCommitMessage(operation, ref, detail);
  const committed = await shadowAutoCommit(shadowConfig.worktreeDir, message, verbose);

  // AC-1: Fire-and-forget push after each commit
  if (committed) {
    shadowPushAsync(shadowConfig.worktreeDir, verbose);
  }

  return committed;
}

/**
 * Check if shadow is required but not available, and throw appropriate error.
 * Use this at the start of commands that require shadow mode.
 *
 * @param shadowConfig Shadow configuration from context
 * @param projectRoot Project root for status check
 * @throws ShadowError if shadow is not properly configured
 */
export async function requireShadow(
  shadowConfig: ShadowConfig | null,
  projectRoot: string
): Promise<void> {
  if (shadowConfig?.enabled) {
    return; // Shadow is available
  }

  const status = await getShadowStatus(projectRoot);
  throw createShadowError(status);
}

/**
 * Format a ShadowError for display in CLI.
 * Returns a user-friendly message with suggestion.
 */
export function formatShadowError(error: ShadowError): string {
  return `${error.message}\n\nSuggestion: ${error.suggestion}`;
}

/**
 * Result from shadow initialization
 */
export interface ShadowInitResult {
  success: boolean;
  branchCreated: boolean;
  worktreeCreated: boolean;
  gitignoreUpdated: boolean;
  initialCommit: boolean;
  alreadyExists: boolean;
  /** Whether shadow was created from existing remote branch */
  createdFromRemote: boolean;
  /** Whether new branch was pushed to remote to establish tracking */
  pushedToRemote: boolean;
  error?: string;
}

/**
 * Options for shadow initialization
 */
export interface ShadowInitOptions {
  /** Project name for manifest */
  projectName?: string;
  /** Force reinitialize even if exists */
  force?: boolean;
}

/**
 * Check if a remote exists (default: origin)
 */
export async function hasRemote(projectRoot: string, remoteName = 'origin'): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`git remote get-url ${remoteName}`, {
      cwd: projectRoot,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a branch exists on a remote
 */
export async function remoteBranchExists(
  projectRoot: string,
  branchName: string,
  remoteName = 'origin'
): Promise<boolean> {
  try {
    execSync(`git show-ref --verify --quiet refs/remotes/${remoteName}/${branchName}`, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch from remote to ensure refs are up to date.
 * Returns true if fetch succeeded, false otherwise.
 */
export async function fetchRemote(projectRoot: string, remoteName = 'origin'): Promise<boolean> {
  try {
    await execAsync(`git fetch ${remoteName}`, {
      cwd: projectRoot,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Push shadow branch to remote with tracking.
 * Returns true if push succeeded, false otherwise.
 */
export async function pushShadowBranch(
  worktreeDir: string,
  remoteName = 'origin'
): Promise<boolean> {
  try {
    await execAsync(`git push -u ${remoteName} ${SHADOW_BRANCH_NAME}`, {
      cwd: worktreeDir,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if shadow branch has remote tracking configured.
 * AC-4: Used to determine whether sync should be attempted.
 */
export async function hasRemoteTracking(worktreeDir: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `git config branch.${SHADOW_BRANCH_NAME}.remote`,
      { cwd: worktreeDir }
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Ensure shadow branch has remote tracking configured.
 * AC-8: If shadow has no tracking but main branch has origin remote,
 * automatically configure tracking to origin/kspec-meta.
 *
 * @param worktreeDir Path to .kspec/ worktree
 * @param projectRoot Git repository root
 * @returns true if tracking is now configured (was already or just set up)
 */
export async function ensureRemoteTracking(
  worktreeDir: string,
  projectRoot: string
): Promise<boolean> {
  // Check if already has tracking
  if (await hasRemoteTracking(worktreeDir)) {
    return true;
  }

  // Check if main branch has origin remote
  if (!(await hasRemote(projectRoot))) {
    return false;
  }

  // Set up tracking for shadow branch to origin/kspec-meta
  try {
    await execAsync(
      `git config branch.${SHADOW_BRANCH_NAME}.remote origin`,
      { cwd: worktreeDir }
    );
    await execAsync(
      `git config branch.${SHADOW_BRANCH_NAME}.merge refs/heads/${SHADOW_BRANCH_NAME}`,
      { cwd: worktreeDir }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Result from a sync operation
 */
export interface ShadowSyncResult {
  success: boolean;
  pulled: boolean;
  pushed: boolean;
  hadConflict: boolean;
  error?: string;
}

/**
 * Fire-and-forget push to remote.
 * AC-1: Called after each auto-commit when tracking is configured.
 * AC-8: Automatically sets up tracking if main branch has remote.
 * Silently ignores errors - the local commit succeeded regardless.
 */
export async function shadowPushAsync(worktreeDir: string): Promise<void> {
  // AC-8: Auto-configure tracking if main has remote but shadow doesn't
  const projectRoot = path.dirname(worktreeDir);
  await ensureRemoteTracking(worktreeDir, projectRoot);

  // Check if tracking is configured before attempting push
  if (!(await hasRemoteTracking(worktreeDir))) {
    return; // AC-4: silently skip if no tracking
  }

  try {
    // Don't await - fire and forget
    execAsync('git push', { cwd: worktreeDir }).catch(() => {
      // Silently ignore push failures - local state is correct
    });
  } catch {
    // Ignore
  }
}

/**
 * Pull remote changes to shadow branch.
 * AC-2: Called at session start to sync before operations.
 * AC-6: Uses --ff-only first, falls back to --rebase.
 * AC-3: On conflict, returns failure with suggestion.
 * AC-8: Automatically sets up tracking if main branch has remote.
 */
export async function shadowPull(worktreeDir: string): Promise<ShadowSyncResult> {
  const result: ShadowSyncResult = {
    success: false,
    pulled: false,
    pushed: false,
    hadConflict: false,
  };

  // AC-8: Auto-configure tracking if main has remote but shadow doesn't
  const projectRoot = path.dirname(worktreeDir);
  await ensureRemoteTracking(worktreeDir, projectRoot);

  // AC-4: Skip if no remote tracking
  if (!(await hasRemoteTracking(worktreeDir))) {
    result.success = true;
    return result;
  }

  // Check if remote branch exists before attempting pull
  // Fetch first to ensure refs are up to date
  await fetchRemote(projectRoot);
  const remoteHasBranch = await remoteBranchExists(projectRoot, SHADOW_BRANCH_NAME);
  if (!remoteHasBranch) {
    // Remote branch doesn't exist yet - nothing to pull, but success
    result.success = true;
    return result;
  }

  try {
    // Try fast-forward only first (cleanest)
    await execAsync('git pull --ff-only', { cwd: worktreeDir });
    result.success = true;
    result.pulled = true;
    return result;
  } catch {
    // Fast-forward failed, try rebase
  }

  try {
    // AC-6: Fall back to rebase
    await execAsync('git pull --rebase', { cwd: worktreeDir });
    result.success = true;
    result.pulled = true;
    return result;
  } catch {
    // Rebase failed - likely conflict
  }

  // AC-3: Conflict detected - abort rebase and report
  try {
    await execAsync('git rebase --abort', { cwd: worktreeDir });
  } catch {
    // May not be in rebase state, ignore
  }

  result.hadConflict = true;
  result.error = 'Sync conflict detected. Run `kspec shadow resolve` to fix.';
  return result;
}

/**
 * Full sync operation: pull then push.
 * Used by session start and explicit sync commands.
 */
export async function shadowSync(worktreeDir: string): Promise<ShadowSyncResult> {
  // First pull
  const pullResult = await shadowPull(worktreeDir);
  if (!pullResult.success) {
    return pullResult;
  }

  // Then push (only if tracking configured, checked inside)
  if (await hasRemoteTracking(worktreeDir)) {
    try {
      await execAsync('git push', { cwd: worktreeDir });
      pullResult.pushed = true;
    } catch {
      // Push failed - not a critical error, local state is correct
      // Could be permissions, network, etc.
    }
  }

  return pullResult;
}

/**
 * Check if .gitignore has uncommitted changes
 */
async function hasUncommittedGitignore(projectRoot: string): Promise<boolean> {
  try {
    // Check both staged and unstaged changes to .gitignore
    const { stdout } = await execAsync('git status --porcelain .gitignore', {
      cwd: projectRoot,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Commit only .gitignore with a message
 */
async function commitGitignore(projectRoot: string): Promise<void> {
  await execAsync('git add .gitignore', { cwd: projectRoot });
  await execAsync('git commit -m "chore: add .kspec/ to .gitignore for shadow branch"', {
    cwd: projectRoot,
  });
}

/**
 * Add .kspec/ to .gitignore if not already present.
 * Fails if .gitignore has uncommitted changes.
 * Commits the change after adding.
 */
async function ensureGitignore(projectRoot: string): Promise<boolean> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const entry = `${SHADOW_WORKTREE_DIR}/`;

  // Fail fast if .gitignore has uncommitted changes
  if (await hasUncommittedGitignore(projectRoot)) {
    throw new ShadowError(
      '.gitignore has uncommitted changes',
      'GIT_ERROR',
      'Commit or stash your .gitignore changes before running kspec init.'
    );
  }

  try {
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
    } catch {
      // File doesn't exist, will create
    }

    // Check if already present (handle various formats)
    const lines = content.split('\n');
    const patterns = [
      SHADOW_WORKTREE_DIR,
      `${SHADOW_WORKTREE_DIR}/`,
      `/${SHADOW_WORKTREE_DIR}`,
      `/${SHADOW_WORKTREE_DIR}/`,
    ];

    for (const line of lines) {
      const trimmed = line.trim();
      if (patterns.includes(trimmed)) {
        return false; // Already present
      }
    }

    // Add to gitignore
    const newContent = content.endsWith('\n') || content === ''
      ? `${content}${entry}\n`
      : `${content}\n${entry}\n`;

    await fs.writeFile(gitignorePath, newContent, 'utf-8');

    // Commit the change
    await commitGitignore(projectRoot);

    return true;
  } catch (error) {
    if (error instanceof ShadowError) {
      throw error;
    }
    throw new ShadowError(
      `Failed to update .gitignore: ${error}`,
      'GIT_ERROR',
      'Check file permissions for .gitignore'
    );
  }
}

/**
 * Generate initial manifest content for shadow branch
 */
function generateShadowManifest(projectName: string): string {
  return `# ${projectName} - Kynetic Spec
# Generated by kspec init

kynetic: "1.0"

project:
  name: "${projectName}"
  version: "0.1.0"
  status: draft
  description: |
    Add your project description here.

# Module includes
includes:
  - modules/main.yaml

# Configuration
config:
  validation:
    strict_refs: true
    require_acceptance: false
`;
}

/**
 * Generate initial module content
 */
function generateShadowModule(projectName: string): string {
  return `# ${projectName} - Main Module
# Add your spec items here

items: []
`;
}

/**
 * Generate initial tasks file
 */
function generateShadowTasks(projectName: string): string {
  return `# ${projectName} - Tasks
# Track implementation work here

tasks: []
`;
}

/**
 * Generate initial inbox file
 */
function generateShadowInbox(): string {
  return `# Inbox - Quick Capture
# Ideas and notes that haven't been triaged yet

items: []
`;
}

/**
 * Convert project name to slug (kebab-case)
 */
function toSlug(projectName: string): string {
  return projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Initialize shadow branch and worktree.
 * Creates orphan branch, worktree, updates gitignore, and creates initial structure.
 *
 * @param projectRoot Git repository root
 * @param options Initialization options
 * @returns Result indicating what was created
 */
export async function initializeShadow(
  projectRoot: string,
  options: ShadowInitOptions = {}
): Promise<ShadowInitResult> {
  const result: ShadowInitResult = {
    success: false,
    branchCreated: false,
    worktreeCreated: false,
    gitignoreUpdated: false,
    initialCommit: false,
    alreadyExists: false,
    createdFromRemote: false,
    pushedToRemote: false,
  };

  // Check if we're in a git repo
  if (!(await isGitRepo(projectRoot))) {
    result.error = 'Not a git repository';
    return result;
  }

  const worktreeDir = path.join(projectRoot, SHADOW_WORKTREE_DIR);

  // Check current status
  const status = await getShadowStatus(projectRoot);

  // Handle existing shadow branch
  if (status.healthy && !options.force) {
    result.alreadyExists = true;
    result.success = true;
    return result;
  }

  // Derive project name if not provided
  const projectName = options.projectName || path.basename(projectRoot)
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  const slug = toSlug(projectName);

  // Check for remote shadow branch (AC-4: fetch to ensure refs are up to date)
  const remoteExists = await hasRemote(projectRoot);
  let remoteHasShadow = false;
  if (remoteExists) {
    await fetchRemote(projectRoot); // Best effort, ignore failures
    remoteHasShadow = await remoteBranchExists(projectRoot, SHADOW_BRANCH_NAME);
  }

  try {
    // Step 1: Update .gitignore first (before creating .kspec/)
    result.gitignoreUpdated = await ensureGitignore(projectRoot);

    // Step 2: Create worktree with orphan branch (or attach to existing branch)
    if (!status.worktreeExists || !status.worktreeLinked) {
      // Remove existing directory if present but not linked
      if (status.worktreeExists && !status.worktreeLinked) {
        await fs.rm(worktreeDir, { recursive: true, force: true });
      }

      // Remove stale worktree reference if any
      try {
        await execAsync(`git worktree remove ${SHADOW_WORKTREE_DIR} --force`, {
          cwd: projectRoot,
        });
      } catch {
        // Ignore - worktree may not exist in git's list
      }

      if (remoteHasShadow) {
        // AC-1: Remote has shadow branch - create worktree from it with tracking
        await execAsync(
          `git worktree add ${SHADOW_WORKTREE_DIR} ${SHADOW_BRANCH_NAME}`,
          { cwd: projectRoot }
        );
        // Set up tracking for the branch
        await execAsync(
          `git branch --set-upstream-to=origin/${SHADOW_BRANCH_NAME} ${SHADOW_BRANCH_NAME}`,
          { cwd: projectRoot }
        );
        result.createdFromRemote = true;
      } else if (!status.branchExists) {
        // AC-2/AC-3: No remote branch or no remote - create orphan branch
        await execAsync(
          `git worktree add --orphan -b ${SHADOW_BRANCH_NAME} ${SHADOW_WORKTREE_DIR}`,
          { cwd: projectRoot }
        );
        result.branchCreated = true;
      } else {
        // Attach to existing local branch
        await execAsync(
          `git worktree add ${SHADOW_WORKTREE_DIR} ${SHADOW_BRANCH_NAME}`,
          { cwd: projectRoot }
        );
      }

      result.worktreeCreated = true;
    }

    // Step 3: Create initial structure if empty (only for new branches, not remote)
    const manifestPath = path.join(worktreeDir, `${slug}.yaml`);
    const modulesDir = path.join(worktreeDir, 'modules');
    const moduleFilePath = path.join(modulesDir, 'main.yaml');
    const tasksPath = path.join(worktreeDir, `${slug}.tasks.yaml`);
    const inboxPath = path.join(worktreeDir, `${slug}.inbox.yaml`);

    let filesCreated = false;

    // Only create files if manifest doesn't exist (remote branches will have files)
    try {
      // Look for any .yaml manifest file (project name may differ)
      const files = await fs.readdir(worktreeDir);
      const hasManifest = files.some(f => f.endsWith('.yaml') && !f.includes('.tasks.') && !f.includes('.inbox.'));
      if (!hasManifest) {
        throw new Error('No manifest found');
      }
    } catch {
      // Manifest doesn't exist, create initial structure
      await fs.mkdir(modulesDir, { recursive: true });
      await fs.writeFile(manifestPath, generateShadowManifest(projectName), 'utf-8');
      await fs.writeFile(moduleFilePath, generateShadowModule(projectName), 'utf-8');
      await fs.writeFile(tasksPath, generateShadowTasks(projectName), 'utf-8');
      await fs.writeFile(inboxPath, generateShadowInbox(), 'utf-8');
      filesCreated = true;
    }

    // Step 4: Initial commit if files were created
    if (filesCreated) {
      result.initialCommit = await shadowAutoCommit(
        worktreeDir,
        `Initialize ${projectName} spec`
      );
    }

    // Step 5: AC-2: Push new branch to remote to establish tracking
    if (result.branchCreated && remoteExists && !remoteHasShadow) {
      result.pushedToRemote = await pushShadowBranch(worktreeDir);
    }

    result.success = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}

/**
 * Repair a broken shadow branch setup.
 * Handles cases where worktree is disconnected or directory is missing.
 *
 * @param projectRoot Git repository root
 * @returns Result indicating what was repaired
 */
export async function repairShadow(projectRoot: string): Promise<ShadowInitResult> {
  const status = await getShadowStatus(projectRoot);

  if (status.healthy) {
    return {
      success: true,
      branchCreated: false,
      worktreeCreated: false,
      gitignoreUpdated: false,
      initialCommit: false,
      alreadyExists: true,
      createdFromRemote: false,
      pushedToRemote: false,
    };
  }

  if (!status.branchExists) {
    // Can't repair without a branch - need full init
    return {
      success: false,
      branchCreated: false,
      worktreeCreated: false,
      gitignoreUpdated: false,
      initialCommit: false,
      alreadyExists: false,
      createdFromRemote: false,
      pushedToRemote: false,
      error: 'Shadow branch does not exist. Run `kspec init` instead.',
    };
  }

  // Branch exists but worktree is broken - repair it
  const worktreeDir = path.join(projectRoot, SHADOW_WORKTREE_DIR);

  try {
    // Remove stale worktree reference
    try {
      await execAsync(`git worktree remove ${SHADOW_WORKTREE_DIR} --force`, {
        cwd: projectRoot,
      });
    } catch {
      // Ignore - worktree may not be in git's list
    }

    // Remove directory if exists (handles corrupted .git file case)
    await fs.rm(worktreeDir, { recursive: true, force: true });

    // Prune stale worktree references (cleans up orphaned entries)
    try {
      await execAsync('git worktree prune', { cwd: projectRoot });
    } catch {
      // Ignore - prune is best-effort
    }

    // Recreate worktree
    await execAsync(
      `git worktree add ${SHADOW_WORKTREE_DIR} ${SHADOW_BRANCH_NAME}`,
      { cwd: projectRoot }
    );

    return {
      success: true,
      branchCreated: false,
      worktreeCreated: true,
      gitignoreUpdated: false,
      initialCommit: false,
      alreadyExists: false,
      createdFromRemote: false,
      pushedToRemote: false,
    };
  } catch (error) {
    return {
      success: false,
      branchCreated: false,
      worktreeCreated: false,
      gitignoreUpdated: false,
      initialCommit: false,
      alreadyExists: false,
      createdFromRemote: false,
      pushedToRemote: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
