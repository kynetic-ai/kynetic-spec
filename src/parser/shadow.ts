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
 * @returns true if commit succeeded, false if nothing to commit
 */
export async function shadowAutoCommit(
  worktreeDir: string,
  message: string
): Promise<boolean> {
  try {
    // Stage all changes
    execSync('git add -A', {
      cwd: worktreeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Check if there are staged changes
    try {
      execSync('git diff --cached --quiet', {
        cwd: worktreeDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // No error = no changes
      return false;
    } catch {
      // Error = there are changes, proceed with commit
    }

    // Commit with message
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: worktreeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return true;
  } catch (error) {
    // Log error but don't throw - auto-commit failure shouldn't break the operation
    console.error('Shadow auto-commit failed:', error);
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
 * @returns true if committed, false if shadow not enabled or nothing to commit
 */
export async function commitIfShadow(
  shadowConfig: ShadowConfig | null,
  operation: string,
  ref?: string,
  detail?: string
): Promise<boolean> {
  if (!shadowConfig?.enabled) {
    return false;
  }

  const message = generateCommitMessage(operation, ref, detail);
  return shadowAutoCommit(shadowConfig.worktreeDir, message);
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
