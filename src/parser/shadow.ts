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

import { exec, execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isBatchMode } from "../cli/batch-context.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

// Import getVerboseMode for checking CLI --debug-shadow flag
// We use a getter function to avoid issues with circular dependencies
let getVerboseModeFunc: (() => boolean) | null = null;

export function setVerboseModeGetter(getter: () => boolean): void {
  getVerboseModeFunc = getter;
}

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
    public code:
      | "NOT_INITIALIZED"
      | "WORKTREE_DISCONNECTED"
      | "DIRECTORY_MISSING"
      | "GIT_ERROR"
      | "RUNNING_FROM_SHADOW",
    public suggestion: string,
  ) {
    super(message);
    this.name = "ShadowError";
  }
}

/**
 * Default shadow branch name
 */
export const SHADOW_BRANCH_NAME = "kspec-meta";

/**
 * Default shadow worktree directory
 */
export const SHADOW_WORKTREE_DIR = ".kspec";

/**
 * Options for shadow branch operations.
 *
 * AC: @config-shadow ac-7 — all fields optional for backward compatibility
 *
 * When not provided, functions use SHADOW_BRANCH_NAME and SHADOW_WORKTREE_DIR constants.
 */
export interface ShadowOptions {
  /** Branch name (default: kspec-meta) */
  branchName?: string;
  /** Worktree directory name (default: .kspec) */
  directory?: string;
  /**
   * Remote target for push/pull. Can be:
   * - Named remote (e.g., "origin", "specs-origin")
   * - Local filesystem path (starts with /, ./, or ~)
   * - Git URL (contains :// or starts with git@)
   */
  remote?: string;
  /** Type of remote (detected from remote string) */
  remoteType?: "named" | "path" | "url";
}

/**
 * Get effective branch name from options or default.
 * AC: @config-shadow ac-7 — backward compat when called without config
 */
function getBranchName(options?: ShadowOptions): string {
  return options?.branchName ?? SHADOW_BRANCH_NAME;
}

/**
 * Get effective directory name from options or default.
 * AC: @config-shadow ac-7 — backward compat when called without config
 */
function getDirectoryName(options?: ShadowOptions): string {
  return options?.directory ?? SHADOW_WORKTREE_DIR;
}

/**
 * Check if debug mode is enabled.
 * Debug mode can be enabled via:
 * - KSPEC_DEBUG=1 environment variable
 * - Verbose flag (passed from CLI --debug-shadow option)
 *
 * When enabled, shadow branch operations output detailed information.
 */
export function isDebugMode(verboseFlag?: boolean): boolean {
  if (process.env.KSPEC_DEBUG === "1") {
    return true;
  }
  if (verboseFlag === true) {
    return true;
  }
  // Check CLI --debug-shadow flag via getter
  if (getVerboseModeFunc?.()) {
    return true;
  }
  return false;
}

/**
 * Check if we're in a git repository
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    execSync("git rev-parse --git-dir", {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
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
    const result = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    return result;
  } catch {
    return null;
  }
}

/**
 * Check if a branch exists
 */
export async function branchExists(
  dir: string,
  branchName: string,
): Promise<boolean> {
  try {
    execSync(`git show-ref --verify --quiet refs/heads/${branchName}`, {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
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
    const gitPath = path.join(worktreeDir, ".git");
    const stat = await fs.stat(gitPath);

    if (stat.isFile()) {
      // Read the .git file to verify it points to a worktree
      const content = await fs.readFile(gitPath, "utf-8");
      return content.trim().startsWith("gitdir:");
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Detect if running from inside the shadow worktree directory.
 * Returns the main project root if detected, null otherwise.
 *
 * AC: @config-shadow ac-8 — detects custom worktree directories using git metadata
 *
 * Detection logic:
 * 1. Check if .git is a file (worktrees have .git files, not directories)
 * 2. Read the gitdir reference from the .git file
 * 3. Check if it points to a worktree for kspec (pattern: <project>/.git/worktrees/...)
 *
 * For custom directories, we detect ANY worktree that:
 * - Has a kspec manifest in it (indicating it's a kspec shadow worktree)
 * - Or has a worktree name containing "kspec" or the configured directory name
 *
 * @param cwd Current working directory
 * @param configuredDirectory Optional configured directory name for matching
 */
export async function detectRunningFromShadowWorktree(
  cwd: string,
  configuredDirectory?: string,
): Promise<string | null> {
  try {
    const gitPath = path.join(cwd, ".git");
    const stat = await fs.stat(gitPath);

    // Worktrees have a .git file, not directory
    if (!stat.isFile()) {
      return null;
    }

    const content = await fs.readFile(gitPath, "utf-8");
    const match = content.trim().match(/^gitdir:\s*(.+)$/);
    if (!match) {
      return null;
    }

    const gitdir = match[1];

    // Check if this is a worktree (pattern: <project>/.git/worktrees/<name>)
    if (gitdir.includes(".git/worktrees/")) {
      const worktreesMatch = gitdir.match(/^(.+)\/\.git\/worktrees\//);
      if (worktreesMatch) {
        const mainProjectRoot = worktreesMatch[1];
        const cwdBase = path.basename(cwd);
        const worktreeName = path.basename(gitdir);

        // AC: ac-8 — check multiple patterns for shadow worktree detection
        const directoryToCheck = configuredDirectory || SHADOW_WORKTREE_DIR;

        // Check if directory name matches default, configured, or worktree contains "kspec"
        if (
          cwdBase === SHADOW_WORKTREE_DIR ||
          cwdBase === directoryToCheck ||
          worktreeName.includes("kspec")
        ) {
          return mainProjectRoot;
        }

        // Additional check: see if this directory has a kspec manifest
        // This catches custom directories that don't have "kspec" in the name
        try {
          const files = await fs.readdir(cwd);
          const hasKspecManifest = files.some(
            (f) =>
              (f.endsWith(".yaml") || f.endsWith(".yml")) &&
              !f.includes(".tasks.") &&
              !f.includes(".inbox."),
          );
          // Check for modules directory or tasks file as additional signals
          const hasModules = files.includes("modules");
          const hasTasksFile = files.some((f) => f.includes(".tasks."));

          if (hasKspecManifest && (hasModules || hasTasksFile)) {
            return mainProjectRoot;
          }
        } catch {
          // Ignore read errors
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Detect shadow branch configuration from a directory.
 * Returns shadow config if worktree directory exists and is valid.
 *
 * AC: @config-shadow ac-1 ac-2 — uses configured branch/directory names
 * AC: @config-shadow ac-7 — defaults to constants when options not provided
 *
 * @param startDir Directory to start detection from
 * @param options Optional shadow configuration (branch name, directory)
 */
export async function detectShadow(
  startDir: string,
  options?: ShadowOptions,
): Promise<ShadowConfig | null> {
  const gitRoot = getGitRoot(startDir);
  if (!gitRoot) {
    return null;
  }

  const directoryName = getDirectoryName(options);
  const branchName = getBranchName(options);
  const worktreeDir = path.join(gitRoot, directoryName);

  try {
    await fs.access(worktreeDir);

    // Verify it's a valid worktree
    if (await isValidWorktree(worktreeDir)) {
      return {
        enabled: true,
        worktreeDir,
        branchName,
        projectRoot: gitRoot,
      };
    }

    // Directory exists but not a valid worktree
    return null;
  } catch {
    // Worktree directory doesn't exist
    return null;
  }
}

/**
 * Get detailed shadow branch status.
 *
 * AC: @config-shadow ac-1 ac-2 — uses configured branch/directory names
 * AC: @config-shadow ac-7 — defaults to constants when options not provided
 *
 * @param projectRoot Git repository root
 * @param options Optional shadow configuration
 */
export async function getShadowStatus(
  projectRoot: string,
  options?: ShadowOptions,
): Promise<ShadowStatus> {
  const directoryName = getDirectoryName(options);
  const branchName = getBranchName(options);
  const worktreeDir = path.join(projectRoot, directoryName);

  const status: ShadowStatus = {
    exists: false,
    healthy: false,
    branchExists: false,
    worktreeExists: false,
    worktreeLinked: false,
  };

  // Check if we're in a git repo
  if (!(await isGitRepo(projectRoot))) {
    status.error = "Not a git repository";
    return status;
  }

  // Check if branch exists
  status.branchExists = await branchExists(projectRoot, branchName);

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
  status.healthy =
    status.branchExists && status.worktreeExists && status.worktreeLinked;

  if (!status.healthy && status.exists) {
    if (!status.branchExists) {
      status.error = "Shadow branch missing but worktree exists";
    } else if (!status.worktreeExists) {
      status.error = "Shadow branch exists but worktree missing";
    } else if (!status.worktreeLinked) {
      status.error = "Worktree exists but not properly linked";
    }
  }

  return status;
}

/**
 * Result from checking config mismatch.
 */
export interface ShadowConfigMismatch {
  /** Whether there is a mismatch */
  hasMismatch: boolean;
  /** Mismatched branch name (detected vs configured) */
  branchMismatch?: { detected: string; configured: string };
  /** Mismatched directory (detected vs configured) */
  directoryMismatch?: { detected: string; configured: string };
  /** Guidance message for the user */
  guidance?: string;
}

/**
 * Check if detected shadow branch settings match the configuration.
 *
 * AC: @config-shadow ac-9 — detect mismatch and guide user to migrate
 *
 * This function detects when:
 * - A shadow branch exists with default settings (kspec-meta, .kspec)
 * - But config specifies different settings
 *
 * @param projectRoot Git repository root
 * @param configuredBranch Configured branch name
 * @param configuredDirectory Configured directory name
 */
export async function checkConfigMismatch(
  projectRoot: string,
  configuredBranch: string,
  configuredDirectory: string,
): Promise<ShadowConfigMismatch> {
  const result: ShadowConfigMismatch = { hasMismatch: false };

  // First check if default shadow exists
  const defaultStatus = await getShadowStatus(projectRoot, {
    branchName: SHADOW_BRANCH_NAME,
    directory: SHADOW_WORKTREE_DIR,
  });

  if (!defaultStatus.healthy) {
    // No existing shadow with defaults - no mismatch possible
    return result;
  }

  // Check if configured settings differ from defaults
  const branchDiffers = configuredBranch !== SHADOW_BRANCH_NAME;
  const directoryDiffers = configuredDirectory !== SHADOW_WORKTREE_DIR;

  if (!branchDiffers && !directoryDiffers) {
    // Config matches defaults - no mismatch
    return result;
  }

  // There's a mismatch - existing shadow uses defaults but config specifies different values
  result.hasMismatch = true;

  if (branchDiffers) {
    result.branchMismatch = {
      detected: SHADOW_BRANCH_NAME,
      configured: configuredBranch,
    };
  }

  if (directoryDiffers) {
    result.directoryMismatch = {
      detected: SHADOW_WORKTREE_DIR,
      configured: configuredDirectory,
    };
  }

  // Build guidance message
  const parts: string[] = [];
  if (result.branchMismatch) {
    parts.push(
      `branch "${SHADOW_BRANCH_NAME}" (config wants "${configuredBranch}")`,
    );
  }
  if (result.directoryMismatch) {
    parts.push(
      `directory "${SHADOW_WORKTREE_DIR}" (config wants "${configuredDirectory}")`,
    );
  }

  result.guidance = [
    `Shadow branch exists with ${parts.join(" and ")}.`,
    "",
    "To migrate to configured settings:",
    "  1. Export your specs: kspec export --all > backup.yaml",
    "  2. Remove existing shadow: rm -rf .kspec && git branch -D kspec-meta",
    "  3. Re-initialize: kspec init",
    "  4. Import specs: kspec import backup.yaml",
    "",
    "Or update kspec.config.yaml to match existing settings.",
  ].join("\n");

  return result;
}

/**
 * Create an appropriate ShadowError based on status
 */
export function createShadowError(status: ShadowStatus): ShadowError {
  if (!status.branchExists && !status.worktreeExists) {
    return new ShadowError(
      "Shadow branch not initialized",
      "NOT_INITIALIZED",
      "Run `kspec init` to create shadow branch and worktree.",
    );
  }

  if (status.branchExists && !status.worktreeExists) {
    return new ShadowError(
      ".kspec/ directory missing",
      "DIRECTORY_MISSING",
      "Run `kspec shadow repair` to recreate the worktree.",
    );
  }

  if (status.worktreeExists && !status.worktreeLinked) {
    return new ShadowError(
      "Worktree disconnected from git",
      "WORKTREE_DISCONNECTED",
      "Run `kspec shadow repair` to fix the worktree link.",
    );
  }

  return new ShadowError(
    status.error || "Unknown shadow branch error",
    "GIT_ERROR",
    "Check git status and try `kspec shadow repair`.",
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
  verbose?: boolean,
): Promise<boolean> {
  const debug = isDebugMode(verbose);

  try {
    if (debug) {
      console.error(
        `[DEBUG] Shadow auto-commit: git add -A (cwd: ${worktreeDir})`,
      );
    }

    // Stage all changes
    execSync("git add -A", {
      cwd: worktreeDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Check if there are staged changes
    try {
      if (debug) {
        console.error(`[DEBUG] Shadow auto-commit: git diff --cached --quiet`);
      }

      execSync("git diff --cached --quiet", {
        cwd: worktreeDir,
        stdio: ["pipe", "pipe", "pipe"],
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
    // Set KSPEC_SHADOW_COMMIT=1 to signal authorized commit to git hooks
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: worktreeDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, KSPEC_SHADOW_COMMIT: "1" },
    });

    if (debug) {
      console.error(`[DEBUG] Shadow auto-commit: Success`);
    }

    return true;
  } catch (error) {
    // AC: Only log error if debug mode enabled
    if (debug) {
      console.error("Shadow auto-commit failed:", error);
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
  detail?: string,
): string {
  const parts: string[] = [];

  switch (operation) {
    case "task-start":
      parts.push(`Start @${ref}`);
      break;
    case "task-complete":
      parts.push(`Complete @${ref}`);
      if (detail) parts.push(`: ${detail}`);
      break;
    case "task-note":
      parts.push(`Note on @${ref}`);
      break;
    case "task-add":
      parts.push(`Add task: ${detail || ref}`);
      break;
    case "inbox-add":
      parts.push(
        `Inbox: ${detail?.slice(0, 50)}${(detail?.length || 0) > 50 ? "..." : ""}`,
      );
      break;
    case "inbox-promote":
      parts.push(`Promote to @${ref}`);
      break;
    case "item-add":
      parts.push(`Add @${ref}`);
      break;
    case "item-set":
      parts.push(`Update @${ref}`);
      break;
    case "item-delete":
      parts.push(`Delete @${ref}`);
      break;
    case "derive":
      parts.push(`Derive from @${ref}`);
      break;
    default:
      parts.push(operation);
      if (ref) parts.push(` @${ref}`);
  }

  return parts.join("");
}

/**
 * Resolve a path relative to shadow worktree if enabled.
 * Falls back to original path if shadow is not enabled.
 *
 * Uses the worktreeDir from shadowConfig for custom directory support.
 */
export function resolveShadowPath(
  originalPath: string,
  shadowConfig: ShadowConfig | null,
  projectRoot: string,
): string {
  if (!shadowConfig?.enabled) {
    return originalPath;
  }

  // If the path is within the project root, rewrite to shadow worktree
  const relativePath = path.relative(projectRoot, originalPath);

  // Get the directory name from the worktree path (supports custom directories)
  const worktreeDirName = path.basename(shadowConfig.worktreeDir);

  // Skip if path is outside project or already in shadow worktree
  if (
    relativePath.startsWith("..") ||
    relativePath.startsWith(worktreeDirName)
  ) {
    return originalPath;
  }

  // Handle spec/ -> shadow worktree mapping
  if (relativePath.startsWith("spec/") || relativePath.startsWith("spec\\")) {
    const specRelative = relativePath.slice(5); // Remove 'spec/'
    return path.join(shadowConfig.worktreeDir, specRelative);
  }

  // For task/inbox files at root, move to shadow worktree
  if (
    relativePath.endsWith(".tasks.yaml") ||
    relativePath.endsWith(".inbox.yaml")
  ) {
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
  verbose?: boolean,
): Promise<boolean> {
  // Suppress auto-commits during atomic batch execution
  if (isBatchMode()) {
    return false;
  }

  if (!shadowConfig?.enabled) {
    return false;
  }

  const message = generateCommitMessage(operation, ref, detail);
  const committed = await shadowAutoCommit(
    shadowConfig.worktreeDir,
    message,
    verbose,
  );

  // AC: @shadow-sync ac-1 - Fire-and-forget push after each commit
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
  projectRoot: string,
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
 * Options for shadow initialization.
 *
 * AC: @config-shadow ac-1 ac-2 — branch and directory configurable
 */
export interface ShadowInitOptions {
  /** Project name for manifest */
  projectName?: string;
  /** Force reinitialize even if exists */
  force?: boolean;
  /** Shadow branch/directory/remote configuration */
  shadow?: ShadowOptions;
}

/**
 * Check if a remote exists (default: origin)
 */
export async function hasRemote(
  projectRoot: string,
  remoteName = "origin",
): Promise<boolean> {
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
  remoteName = "origin",
): Promise<boolean> {
  try {
    execSync(
      `git show-ref --verify --quiet refs/remotes/${remoteName}/${branchName}`,
      {
        cwd: projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch from remote to ensure refs are up to date.
 * Returns true if fetch succeeded, false otherwise.
 */
export async function fetchRemote(
  projectRoot: string,
  remoteName = "origin",
): Promise<boolean> {
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
 *
 * AC: @config-shadow ac-3 — uses configured remote name
 * AC: @config-shadow ac-7 — defaults to origin when not provided
 *
 * @param worktreeDir Path to shadow worktree
 * @param remoteName Remote name (default: origin)
 * @param options Optional shadow configuration
 */
export async function pushShadowBranch(
  worktreeDir: string,
  remoteName = "origin",
  options?: ShadowOptions,
): Promise<boolean> {
  const branchName = getBranchName(options);
  try {
    await execAsync(`git push -u ${remoteName} ${branchName}`, {
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
 *
 * AC: @config-shadow ac-7 — backward compat when called without config
 *
 * @param worktreeDir Path to shadow worktree
 * @param options Optional shadow configuration
 */
export async function hasRemoteTracking(
  worktreeDir: string,
  options?: ShadowOptions,
): Promise<boolean> {
  const branchName = getBranchName(options);
  try {
    const { stdout } = await execAsync(
      `git config branch.${branchName}.remote`,
      { cwd: worktreeDir },
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
 * AC: @config-shadow ac-3 ac-4 ac-5 — handles different remote types
 * AC: @config-shadow ac-6 — error with guidance if named remote doesn't exist
 * AC: @config-shadow ac-7 — backward compat when called without config
 *
 * @param worktreeDir Path to shadow worktree
 * @param projectRoot Git repository root
 * @param options Optional shadow configuration
 * @returns Result with success status and error details if applicable
 */
export async function ensureRemoteTracking(
  worktreeDir: string,
  projectRoot: string,
  options?: ShadowOptions,
): Promise<EnsureRemoteTrackingResult> {
  const branchName = getBranchName(options);

  // Check if already has tracking
  if (await hasRemoteTracking(worktreeDir, options)) {
    return { success: true };
  }

  // Determine remote name to use
  let remoteName = "origin";

  if (options?.remote) {
    const remoteType = options.remoteType ?? "named";

    if (remoteType === "named") {
      // AC: ac-3 — use the named remote directly
      remoteName = options.remote;

      // AC: ac-6 — verify the named remote exists with guidance
      if (!(await hasRemote(projectRoot, remoteName))) {
        // Named remote doesn't exist - provide helpful guidance
        return {
          success: false,
          missingRemote: remoteName,
          guidance: `Remote '${remoteName}' does not exist. To fix this:\n` +
            `  1. Add the remote: git remote add ${remoteName} <url>\n` +
            `  2. Or update kspec.config.yaml to use an existing remote\n` +
            `  3. Or remove shadow.remote to use the default 'origin' remote`,
        };
      }
    } else if (remoteType === "path" || remoteType === "url") {
      // AC: ac-4 ac-5 — add a git remote for path/URL if not already present
      const specRemoteName = "kspec-specs";
      const hasSpecsRemote = await hasRemote(projectRoot, specRemoteName);

      if (!hasSpecsRemote) {
        try {
          // Expand tilde for paths if needed
          let remoteTarget = options.remote;
          if (remoteType === "path" && remoteTarget.startsWith("~")) {
            remoteTarget = remoteTarget.replace(
              /^~/,
              process.env.HOME || process.env.USERPROFILE || "~",
            );
          }

          await execAsync(`git remote add ${specRemoteName} "${remoteTarget}"`, {
            cwd: projectRoot,
          });
        } catch {
          // Remote add failed - may already exist with different URL
          return { success: false };
        }
      }

      remoteName = specRemoteName;
    }
  } else {
    // No remote configured - check if main branch has origin
    if (!(await hasRemote(projectRoot))) {
      return { success: false };
    }
  }

  // Set up tracking for shadow branch
  try {
    await execAsync(`git config branch.${branchName}.remote ${remoteName}`, {
      cwd: worktreeDir,
    });
    await execAsync(
      `git config branch.${branchName}.merge refs/heads/${branchName}`,
      { cwd: worktreeDir },
    );
    return { success: true };
  } catch {
    return { success: false };
  }
}

/**
 * Result from ensuring remote tracking
 * AC: @config-shadow ac-6 — includes error details when named remote doesn't exist
 */
export interface EnsureRemoteTrackingResult {
  success: boolean;
  /** Error when remote doesn't exist (AC-6) */
  missingRemote?: string;
  /** Guidance message for user */
  guidance?: string;
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
 *
 * AC: @config-shadow ac-7 — backward compat when called without config
 *
 * @param worktreeDir Path to shadow worktree
 * @param verbose Enable debug output
 * @param options Optional shadow configuration
 */
export async function shadowPushAsync(
  worktreeDir: string,
  verbose?: boolean,
  options?: ShadowOptions,
): Promise<void> {
  const debug = isDebugMode(verbose);

  // AC: @shadow-sync ac-8 - Auto-configure tracking if main has remote but shadow doesn't
  const projectRoot = path.dirname(worktreeDir);
  const trackingResult = await ensureRemoteTracking(worktreeDir, projectRoot, options);

  // AC: @config-shadow ac-6 — log guidance if named remote doesn't exist
  if (!trackingResult.success && trackingResult.missingRemote) {
    if (debug) {
      console.error(`[DEBUG] Shadow push: ${trackingResult.guidance}`);
    }
    return;
  }

  // Check if tracking is configured before attempting push
  if (!(await hasRemoteTracking(worktreeDir, options))) {
    if (debug) {
      console.error(
        "[DEBUG] Shadow push: No remote tracking configured, skipping",
      );
    }
    return; // AC: @shadow-sync ac-4 - silently skip if no tracking
  }

  try {
    if (debug) {
      console.error(`[DEBUG] Shadow push: git push (cwd: ${worktreeDir})`);
    }

    // Don't await - fire and forget
    execAsync("git push", { cwd: worktreeDir }).catch((err) => {
      if (debug) {
        console.error("[DEBUG] Shadow push failed:", err);
      }
      // Silently ignore push failures - local state is correct
    });
  } catch (err) {
    if (debug) {
      console.error("[DEBUG] Shadow push error:", err);
    }
  }
}

/**
 * Pull remote changes to shadow branch.
 * AC-2: Called at session start to sync before operations.
 * AC-6: Uses --ff-only first, falls back to --rebase.
 * AC-3: On conflict, returns failure with suggestion.
 * AC-8: Automatically sets up tracking if main branch has remote.
 *
 * AC: @config-shadow ac-7 — backward compat when called without config
 *
 * @param worktreeDir Path to shadow worktree
 * @param options Optional shadow configuration
 */
export async function shadowPull(
  worktreeDir: string,
  options?: ShadowOptions,
): Promise<ShadowSyncResult> {
  const branchName = getBranchName(options);
  const result: ShadowSyncResult = {
    success: false,
    pulled: false,
    pushed: false,
    hadConflict: false,
  };

  // AC: @shadow-sync ac-8 - Auto-configure tracking if main has remote but shadow doesn't
  const projectRoot = path.dirname(worktreeDir);
  const trackingResult = await ensureRemoteTracking(worktreeDir, projectRoot, options);

  // AC: @config-shadow ac-6 — error with guidance if named remote doesn't exist
  if (!trackingResult.success && trackingResult.missingRemote) {
    result.error = trackingResult.guidance;
    return result;
  }

  // AC: @shadow-sync ac-4 - Skip if no remote tracking
  if (!(await hasRemoteTracking(worktreeDir, options))) {
    result.success = true;
    return result;
  }

  // Check if remote branch exists before attempting pull
  // Fetch first to ensure refs are up to date
  await fetchRemote(projectRoot);
  const remoteHasBranch = await remoteBranchExists(projectRoot, branchName);
  if (!remoteHasBranch) {
    // Remote branch doesn't exist yet - nothing to pull, but success
    result.success = true;
    return result;
  }

  try {
    // Try fast-forward only first (cleanest)
    await execAsync("git pull --ff-only", { cwd: worktreeDir });
    result.success = true;
    result.pulled = true;
    return result;
  } catch {
    // Fast-forward failed, try rebase
  }

  try {
    // AC: @shadow-sync ac-6 - Fall back to rebase
    await execAsync("git pull --rebase", { cwd: worktreeDir });
    result.success = true;
    result.pulled = true;
    return result;
  } catch {
    // Rebase failed - likely conflict
  }

  // AC: @shadow-sync ac-3 - Conflict detected - abort rebase and report
  try {
    await execAsync("git rebase --abort", { cwd: worktreeDir });
  } catch {
    // May not be in rebase state, ignore
  }

  result.hadConflict = true;
  result.error = "Sync conflict detected. Run `kspec shadow resolve` to fix.";
  return result;
}

/**
 * Full sync operation: pull then push.
 * Used by session start and explicit sync commands.
 *
 * AC: @config-shadow ac-7 — backward compat when called without config
 *
 * @param worktreeDir Path to shadow worktree
 * @param options Optional shadow configuration
 */
export async function shadowSync(
  worktreeDir: string,
  options?: ShadowOptions,
): Promise<ShadowSyncResult> {
  // First pull
  const pullResult = await shadowPull(worktreeDir, options);
  if (!pullResult.success) {
    return pullResult;
  }

  // Then push (only if tracking configured, checked inside)
  if (await hasRemoteTracking(worktreeDir, options)) {
    try {
      await execAsync("git push", { cwd: worktreeDir });
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
    const { stdout } = await execAsync("git status --porcelain .gitignore", {
      cwd: projectRoot,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Commit only .gitignore with a message.
 *
 * @param projectRoot Git repository root
 * @param directoryName Shadow directory name (for commit message)
 */
async function commitGitignore(
  projectRoot: string,
  directoryName: string,
): Promise<void> {
  await execAsync("git add .gitignore", { cwd: projectRoot });
  await execAsync(
    `git commit -m "chore: add ${directoryName}/ to .gitignore for shadow branch"`,
    {
      cwd: projectRoot,
    },
  );
}

/**
 * Add shadow directory to .gitignore if not already present.
 * Fails if .gitignore has uncommitted changes.
 * Commits the change after adding.
 *
 * AC: @config-shadow ac-2 — uses configured directory name
 * AC: @config-shadow ac-7 — defaults to .kspec when not provided
 *
 * @param projectRoot Git repository root
 * @param options Optional shadow configuration
 */
async function ensureGitignore(
  projectRoot: string,
  options?: ShadowOptions,
): Promise<boolean> {
  const directoryName = getDirectoryName(options);
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const entry = `${directoryName}/`;

  // Fail fast if .gitignore has uncommitted changes
  if (await hasUncommittedGitignore(projectRoot)) {
    throw new ShadowError(
      ".gitignore has uncommitted changes",
      "GIT_ERROR",
      "Commit or stash your .gitignore changes before running kspec init.",
    );
  }

  try {
    let content = "";
    try {
      content = await fs.readFile(gitignorePath, "utf-8");
    } catch {
      // File doesn't exist, will create
    }

    // Check if already present (handle various formats)
    const lines = content.split("\n");
    const patterns = [
      directoryName,
      `${directoryName}/`,
      `/${directoryName}`,
      `/${directoryName}/`,
    ];

    for (const line of lines) {
      const trimmed = line.trim();
      if (patterns.includes(trimmed)) {
        return false; // Already present
      }
    }

    // Add to gitignore
    const newContent =
      content.endsWith("\n") || content === ""
        ? `${content}${entry}\n`
        : `${content}\n${entry}\n`;

    await fs.writeFile(gitignorePath, newContent, "utf-8");

    // Commit the change
    await commitGitignore(projectRoot, directoryName);

    return true;
  } catch (error) {
    if (error instanceof ShadowError) {
      throw error;
    }
    throw new ShadowError(
      `Failed to update .gitignore: ${error}`,
      "GIT_ERROR",
      "Check file permissions for .gitignore",
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
 * Get the kspec package root directory.
 * Navigates from dist/parser/ to package root.
 */
function getPackageRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

/**
 * Install pre-commit hook to protect kspec-meta branch.
 * Hook prevents direct commits to shadow branch unless KSPEC_SHADOW_COMMIT=1.
 *
 * Note: Git worktrees use hooks from the main .git/hooks directory (via commondir),
 * not from .git/worktrees/-kspec/hooks. So we install to main hooks directory.
 *
 * The hook source is located in the kspec package's templates/hooks/ directory.
 *
 * @param projectRoot Git repository root
 * @returns true if hook was installed, false if already exists
 */
async function installShadowHook(projectRoot: string): Promise<boolean> {
  const hooksDir = path.join(projectRoot, ".git", "hooks");
  const hookPath = path.join(hooksDir, "pre-commit");

  // Look for hook in package templates directory
  const packageRoot = getPackageRoot();
  const sourceHookPath = path.join(packageRoot, "templates", "hooks", "pre-commit");

  try {
    // Check if source hook exists in package templates
    try {
      await fs.access(sourceHookPath);
    } catch {
      // Source hook doesn't exist - skip installation
      return false;
    }

    // Check if hook already exists
    try {
      await fs.access(hookPath);
      // Hook exists - don't overwrite (user may have custom hooks)
      return false;
    } catch {
      // Hook doesn't exist - install it
    }

    // Copy hook from package templates
    const hookContent = await fs.readFile(sourceHookPath, "utf-8");
    await fs.writeFile(hookPath, hookContent, { mode: 0o755 });
    return true;
  } catch (_error) {
    // Silently fail - hook installation is optional
    return false;
  }
}

/**
 * Convert project name to slug (kebab-case)
 */
function toSlug(projectName: string): string {
  return projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Configure git merge driver for kspec YAML files.
 * AC: @yaml-merge-driver ac-12
 *
 * Configures the merge driver in .git/config and adds .gitattributes in the shadow branch.
 *
 * @param projectRoot Git repository root
 * @param worktreeDir Path to shadow worktree directory
 * @returns true if configuration was successful
 */
async function configureMergeDriver(
  projectRoot: string,
  worktreeDir: string,
): Promise<boolean> {
  try {
    // Step 1: Configure merge driver in .git/config
    const kspecPath = execSync("which kspec", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // Add merge driver configuration to git config
    try {
      execSync(
        `git config merge.kspec.name "Kspec YAML semantic merge driver"`,
        {
          cwd: projectRoot,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      execSync(
        `git config merge.kspec.driver "${kspecPath} merge-driver %O %A %B --non-interactive"`,
        {
          cwd: projectRoot,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      // Config may fail if already set - check if it's set correctly
      try {
        const existingDriver = execSync("git config merge.kspec.driver", {
          cwd: projectRoot,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();

        if (!existingDriver.includes("kspec merge-driver")) {
          throw new Error("Merge driver config exists but is incorrect");
        }
      } catch {
        throw error; // Re-throw original error
      }
    }

    // Step 2: Create .gitattributes in shadow branch
    const gitattributesPath = path.join(worktreeDir, ".gitattributes");

    // Check if .gitattributes exists
    let existingContent = "";
    try {
      existingContent = await fs.readFile(gitattributesPath, "utf-8");
    } catch {
      // File doesn't exist, that's fine
    }

    // Check if merge driver is already configured
    if (!existingContent.includes("merge=kspec")) {
      const attributesContent = existingContent
        ? existingContent + "\n"
        : "# Git attributes for kspec\n\n";

      await fs.writeFile(
        gitattributesPath,
        attributesContent + "*.yaml merge=kspec\n*.yml merge=kspec\n",
        "utf-8",
      );

      // Commit .gitattributes to shadow branch
      await shadowAutoCommit(worktreeDir, "Configure kspec merge driver");
    }

    return true;
  } catch (_error) {
    // Silently fail - merge driver configuration is optional
    return false;
  }
}

/**
 * Initialize shadow branch and worktree.
 * Creates orphan branch, worktree, updates gitignore, and creates initial structure.
 *
 * AC: @config-shadow ac-1 — creates orphan branch with configured name
 * AC: @config-shadow ac-2 — creates worktree at configured directory
 * AC: @config-shadow ac-7 — defaults to constants when options not provided
 *
 * @param projectRoot Git repository root
 * @param options Initialization options
 * @returns Result indicating what was created
 */
export async function initializeShadow(
  projectRoot: string,
  options: ShadowInitOptions = {},
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
    result.error = "Not a git repository";
    return result;
  }

  // AC: ac-1 ac-2 — use configured branch/directory or defaults
  const branchName = getBranchName(options.shadow);
  const directoryName = getDirectoryName(options.shadow);
  const worktreeDir = path.join(projectRoot, directoryName);

  // Check current status with configured options
  const status = await getShadowStatus(projectRoot, options.shadow);

  // Handle existing shadow branch
  if (status.healthy && !options.force) {
    result.alreadyExists = true;
    result.success = true;
    return result;
  }

  // Derive project name if not provided
  const projectName =
    options.projectName ||
    path
      .basename(projectRoot)
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

  const slug = toSlug(projectName);

  // Determine remote name to use
  let remoteName = "origin";
  if (options.shadow?.remote && options.shadow.remoteType === "named") {
    remoteName = options.shadow.remote;
  }

  // Check for remote shadow branch (AC-4: fetch to ensure refs are up to date)
  const remoteExists = await hasRemote(projectRoot, remoteName);
  let remoteHasShadow = false;
  if (remoteExists) {
    await fetchRemote(projectRoot, remoteName); // Best effort, ignore failures
    remoteHasShadow = await remoteBranchExists(projectRoot, branchName, remoteName);
  }

  try {
    // Step 1: Update .gitignore first (before creating worktree)
    result.gitignoreUpdated = await ensureGitignore(projectRoot, options.shadow);

    // Step 2: Create worktree with orphan branch (or attach to existing branch)
    if (!status.worktreeExists || !status.worktreeLinked) {
      // Remove existing directory if present but not linked
      if (status.worktreeExists && !status.worktreeLinked) {
        await fs.rm(worktreeDir, { recursive: true, force: true });
      }

      // Remove stale worktree reference if any
      try {
        await execAsync(`git worktree remove "${directoryName}" --force`, {
          cwd: projectRoot,
        });
      } catch {
        // Ignore - worktree may not exist in git's list
      }

      if (remoteHasShadow) {
        // AC: @shadow-init-remote ac-1 - Remote has shadow branch - create worktree from it with tracking
        await execAsync(
          `git worktree add "${directoryName}" ${branchName}`,
          { cwd: projectRoot },
        );
        // Set up tracking for the branch
        await execAsync(
          `git branch --set-upstream-to=${remoteName}/${branchName} ${branchName}`,
          { cwd: projectRoot },
        );
        result.createdFromRemote = true;
      } else if (!status.branchExists) {
        // AC: @shadow-init-remote ac-2 ac-3 - No remote branch or no remote - create orphan branch
        // AC: @config-shadow ac-1 — use configured branch name
        await execAsync(
          `git worktree add --orphan -b ${branchName} "${directoryName}"`,
          { cwd: projectRoot },
        );
        result.branchCreated = true;
      } else {
        // Attach to existing local branch
        await execAsync(
          `git worktree add "${directoryName}" ${branchName}`,
          { cwd: projectRoot },
        );
      }

      result.worktreeCreated = true;
    }

    // Step 3: Create initial structure if empty (only for new branches, not remote)
    const manifestPath = path.join(worktreeDir, `${slug}.yaml`);
    const modulesDir = path.join(worktreeDir, "modules");
    const moduleFilePath = path.join(modulesDir, "main.yaml");
    const tasksPath = path.join(worktreeDir, `${slug}.tasks.yaml`);
    const inboxPath = path.join(worktreeDir, `${slug}.inbox.yaml`);

    let filesCreated = false;

    // Only create files if manifest doesn't exist (remote branches will have files)
    try {
      // Look for any .yaml manifest file (project name may differ)
      const files = await fs.readdir(worktreeDir);
      const hasManifest = files.some(
        (f) =>
          f.endsWith(".yaml") &&
          !f.includes(".tasks.") &&
          !f.includes(".inbox."),
      );
      if (!hasManifest) {
        throw new Error("No manifest found");
      }
    } catch {
      // Manifest doesn't exist, create initial structure
      await fs.mkdir(modulesDir, { recursive: true });
      await fs.writeFile(
        manifestPath,
        generateShadowManifest(projectName),
        "utf-8",
      );
      await fs.writeFile(
        moduleFilePath,
        generateShadowModule(projectName),
        "utf-8",
      );
      await fs.writeFile(tasksPath, generateShadowTasks(projectName), "utf-8");
      await fs.writeFile(inboxPath, generateShadowInbox(), "utf-8");
      filesCreated = true;
    }

    // Step 4: Initial commit if files were created
    if (filesCreated) {
      result.initialCommit = await shadowAutoCommit(
        worktreeDir,
        `Initialize ${projectName} spec`,
      );
    }

    // Step 5: AC-2: Push new branch to remote to establish tracking
    if (result.branchCreated && remoteExists && !remoteHasShadow) {
      result.pushedToRemote = await pushShadowBranch(worktreeDir, remoteName, options.shadow);
    }

    // Step 6: Install pre-commit hook to protect shadow branch
    await installShadowHook(projectRoot);

    // Step 7: Configure merge driver for semantic YAML merging
    // AC: @yaml-merge-driver ac-12
    await configureMergeDriver(projectRoot, worktreeDir);

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
 * AC: @config-shadow ac-7 — backward compat when called without config
 *
 * @param projectRoot Git repository root
 * @param options Optional shadow configuration
 * @returns Result indicating what was repaired
 */
export async function repairShadow(
  projectRoot: string,
  options?: ShadowOptions,
): Promise<ShadowInitResult> {
  const branchName = getBranchName(options);
  const directoryName = getDirectoryName(options);
  const status = await getShadowStatus(projectRoot, options);

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
      error: "Shadow branch does not exist. Run `kspec init` instead.",
    };
  }

  // Branch exists but worktree is broken - repair it
  const worktreeDir = path.join(projectRoot, directoryName);

  try {
    // Remove stale worktree reference
    try {
      await execAsync(`git worktree remove "${directoryName}" --force`, {
        cwd: projectRoot,
      });
    } catch {
      // Ignore - worktree may not be in git's list
    }

    // Remove directory if exists (handles corrupted .git file case)
    await fs.rm(worktreeDir, { recursive: true, force: true });

    // Prune stale worktree references (cleans up orphaned entries)
    try {
      await execAsync("git worktree prune", { cwd: projectRoot });
    } catch {
      // Ignore - prune is best-effort
    }

    // Recreate worktree
    await execAsync(
      `git worktree add "${directoryName}" ${branchName}`,
      { cwd: projectRoot },
    );

    // Install pre-commit hook
    await installShadowHook(projectRoot);

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
