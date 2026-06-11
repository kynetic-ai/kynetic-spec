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

import { execFile, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ulid } from "ulid";
import { isBatchMode } from "../cli/batch-context.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

/**
 * Build an environment for shadow git subprocesses that prevents interactive
 * credential prompts. GIT_TERMINAL_PROMPT=0 tells git to fail immediately
 * instead of blocking on stdin when no credential helper is configured.
 * This prevents the daemon/dispatch engine from hanging indefinitely.
 */
function buildShadowGitEnv(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...(baseEnv ?? process.env), GIT_TERMINAL_PROMPT: "0" };
}

interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function runCommandSync(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });

  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout || "").toString(),
    stderr: (result.stderr || "").toString(),
  };
}

async function runGitAsync(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout = "", stderr = "" } = await execFileAsync("git", args, {
    cwd,
    env: buildShadowGitEnv(env),
    encoding: "utf-8",
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

async function stashBrokenWorktreeDir(worktreeDir: string): Promise<string | null> {
  const stat = await fs.stat(worktreeDir).catch(() => null);
  if (!stat) {
    return null;
  }

  const backupDir = `${worktreeDir}.repair-backup-${Date.now()}`;
  await fs.rename(worktreeDir, backupDir);
  return backupDir;
}

async function restoreStashedWorktreeDir(
  backupDir: string | null,
  worktreeDir: string,
): Promise<void> {
  if (!backupDir) {
    return;
  }

  await fs.rm(worktreeDir, { recursive: true, force: true });
  await fs.rename(backupDir, worktreeDir);
}

async function discardStashedWorktreeDir(backupDir: string | null): Promise<void> {
  if (!backupDir) {
    return;
  }

  await fs.rm(backupDir, { recursive: true, force: true });
}

type WorktreeDirState = "missing" | "non-directory" | "empty-directory" | "partial-directory";

/**
 * Inspect what currently exists at the shadow worktree location, for
 * failure reporting. Stats at call time so the description reflects the
 * actual outcome of a partially-failed restore (restoreStashedWorktreeDir
 * removes the worktree directory before renaming the backup into place —
 * if the rename fails, the location is usually empty and the backup is the
 * only copy of the prior shadow state, but a concurrent recreation of the
 * location can leave a directory or file behind).
 */
async function inspectWorktreeDirState(
  worktreeDir: string,
): Promise<{ state: WorktreeDirState; description: string }> {
  const stat = await fs.stat(worktreeDir).catch(() => null);
  if (!stat) {
    return {
      state: "missing",
      description: "now empty — the backup directory is the only copy of the prior shadow state",
    };
  }
  if (!stat.isDirectory()) {
    return {
      state: "non-directory",
      description:
        "occupied by a non-directory file — the backup directory holds the prior shadow state",
    };
  }
  const entries = await fs.readdir(worktreeDir).catch(() => null);
  if (entries && entries.length === 0) {
    return {
      state: "empty-directory",
      description:
        "an empty directory — the backup directory is the only copy of the prior shadow state",
    };
  }
  return {
    state: "partial-directory",
    description:
      "occupied by a partial or incomplete directory — the backup directory holds the prior shadow state",
  };
}

/**
 * Quote a path for literal use in a POSIX shell command. Double quotes
 * still let the shell expand `$`, backticks, and backslashes, so a path
 * containing those would make the command address a different path or fail
 * to parse. Single quotes suppress all expansion; embedded single quotes
 * use the standard close-escape-reopen idiom (' -> '\'').
 */
function shellQuotePath(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Build recovery steps that match the actual state of the worktree
 * location. `mv <backup> <worktreeDir>` only restores the backup when
 * nothing exists at the destination: if a directory is still there, mv
 * moves the backup *inside* it, and an existing file makes it fail. States
 * that leave something at the location therefore get an explicit
 * clear-the-destination step before the move.
 */
function buildRestoreRecoverySteps(
  state: WorktreeDirState,
  backupDir: string,
  worktreeDir: string,
): string[] {
  const quotedBackup = shellQuotePath(path.resolve(backupDir));
  const quotedWorktree = shellQuotePath(path.resolve(worktreeDir));
  const steps: string[] = [];
  if (state === "empty-directory") {
    steps.push(`Remove the leftover empty directory: rmdir ${quotedWorktree}`);
  } else if (state === "non-directory" || state === "partial-directory") {
    const leftover = state === "non-directory" ? "file" : "partial directory";
    const quotedAside = shellQuotePath(`${path.resolve(worktreeDir)}.failed-rebuild-${Date.now()}`);
    steps.push(`Move the leftover ${leftover} out of the way: mv ${quotedWorktree} ${quotedAside}`);
  }
  steps.push(`Move the backup back into place: mv ${quotedBackup} ${quotedWorktree}`);
  steps.push("Re-run: kspec shadow repair");
  return steps.map((step, index) => `  ${index + 1}. ${step}`);
}

/**
 * After a failed shadow rebuild, attempt to restore the stashed pre-repair
 * shadow directory and produce the user-facing error message.
 *
 * On restore success, the rebuild error is reported with a note that the
 * prior shadow state was restored. On restore failure, the message combines
 * the rebuild error, the restore error, the absolute path of the preserved
 * backup directory, the resulting state of the worktree location, and
 * concrete recovery steps. The backup directory is never deleted on this
 * path.
 *
 * AC: @broken-shadow-safety ac-preserve-on-failure
 * AC: @broken-shadow-safety ac-restore-failure-reports-state
 */
async function restoreStashedWorktreeDirAfterFailure(
  backupDir: string | null,
  worktreeDir: string,
  rebuildError: unknown,
): Promise<string> {
  const rebuildMessage =
    rebuildError instanceof Error ? rebuildError.message : String(rebuildError);
  if (!backupDir) {
    return rebuildMessage;
  }

  try {
    await restoreStashedWorktreeDir(backupDir, worktreeDir);
    return `${rebuildMessage}\nThe prior shadow directory state was restored to ${path.resolve(worktreeDir)}.`;
  } catch (restoreError) {
    const restoreMessage =
      restoreError instanceof Error ? restoreError.message : String(restoreError);
    const { state, description } = await inspectWorktreeDirState(worktreeDir);
    return [
      `Shadow rebuild failed: ${rebuildMessage}`,
      `Restoring the previous shadow directory also failed: ${restoreMessage}`,
      `The previous shadow directory is preserved at: ${path.resolve(backupDir)}`,
      `The shadow directory location (${path.resolve(worktreeDir)}) is ${description}.`,
      "Recovery steps:",
      ...buildRestoreRecoverySteps(state, backupDir, worktreeDir),
    ].join("\n");
  }
}

function runGitSync(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd,
    env: buildShadowGitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });

  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout || "").toString(),
  };
}

/**
 * Parse git version from `git --version` output.
 * Returns [major, minor, patch] or null if unparseable.
 */
export function getGitVersion(cwd?: string): [number, number, number] | null {
  const result = spawnSync("git", ["--version"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (result.error || result.status !== 0) return null;
  const match = (result.stdout || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Check if the installed git supports `git worktree add --orphan` (requires >= 2.42.0).
 */
export function gitSupportsOrphanWorktree(cwd?: string): boolean {
  const version = getGitVersion(cwd);
  if (!version) return false;
  const [major, minor] = version;
  return major > 2 || (major === 2 && minor >= 42);
}

/**
 * Fallback for creating an orphan branch when git < 2.42.
 *
 * Strategy:
 * 1. Create a temp bare repo in the OS temp directory
 * 2. Create an orphan branch with an empty commit there
 * 3. Push that branch to the project repo (via file:// protocol)
 * 4. Clean up the temp repo
 * 5. Attach using standard `git worktree add <dir> <branch>`
 *
 * This approach NEVER modifies the project's working tree.
 *
 * AC: @config-shadow ac-10
 */
export async function createOrphanBranchFallback(
  projectRoot: string,
  branchName: string,
  directoryName: string,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(tmpdir(), "kspec-orphan-"));

  try {
    // 1. Init a bare repo in the temp dir
    await runGitAsync(tmpDir, ["init", "--bare"]);

    // 2. Create the orphan branch using a temporary non-bare clone.
    //    We need a working tree to make a commit, so clone the bare repo.
    const workDir = await fs.mkdtemp(path.join(tmpdir(), "kspec-orphan-work-"));

    try {
      await runGitAsync(workDir, ["clone", tmpDir, "."]);
      await runGitAsync(workDir, ["config", "user.email", "kspec@localhost"]);
      await runGitAsync(workDir, ["config", "user.name", "kspec"]);

      // Create an orphan branch (checkout --orphan works on all git versions)
      await runGitAsync(workDir, ["checkout", "--orphan", branchName]);

      // Remove any files that might have been staged
      try {
        await runGitAsync(workDir, ["rm", "-rf", "."]);
      } catch {
        // May fail if nothing to remove (empty repo) - that's fine
      }

      // Create an empty initial commit
      await runGitAsync(workDir, ["commit", "--allow-empty", "-m", `Initialize ${branchName}`]);

      // Push the orphan branch back to the bare repo
      await runGitAsync(workDir, ["push", "origin", branchName]);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }

    // 3. Push from the temp bare repo to the project repo
    //    Use file:// protocol to ensure git treats it as a proper remote
    await runGitAsync(tmpDir, ["push", `file://${path.resolve(projectRoot)}`, branchName]);
  } finally {
    // 4. Clean up the temp bare repo
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  // 5. Attach worktree using standard git worktree add (no --orphan flag).
  //    AC: @worktree-support ac-shadow-ops-scoped-to-main — always pass the
  //    absolute worktree path so git cannot match a bare suffix across the
  //    shared worktree admin of linked worktrees (find_worktree_by_suffix).
  const worktreeDir = path.join(projectRoot, directoryName);
  await runGitAsync(projectRoot, ["worktree", "add", worktreeDir, branchName]);

  // 6. Remove all tracked files from the worktree since the fallback
  //    created an empty commit but `git worktree add` may still populate
  //    the index from the branch. Clear anything that appeared.
  try {
    const { stdout } = await runGitAsync(worktreeDir, ["ls-files"]);
    if (stdout.trim()) {
      await runGitAsync(worktreeDir, ["rm", "-rf", "."]);
    }
  } catch {
    // Nothing to remove — expected for an empty commit
  }
}

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
  artifactsDirExists: boolean;
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
      | "RUNNING_FROM_SHADOW"
      | "LINKED_WORKTREE_NOT_SUPPORTED",
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
 * Sessions storage directory name (at project root, separate from shadow worktree).
 * AC: @session-storage-modes ac-sessions-dir
 */
export const SESSIONS_WORKTREE_DIR = ".kspec-sessions";

/**
 * Transient plan working directory name at project root.
 */
export const TRANSIENT_PLANS_DIR = "plans";

export interface ProjectRoots {
  mainRoot: string;
  worktreeRoot: string;
  isWorktree: boolean;
}

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
 * Get effective remote name from options or default.
 * AC: @config-shadow ac-3 ac-7 — resolves configured remote for fetch/push/pull.
 * Named remotes use the name directly; path/URL remotes use the auto-created "kspec-specs".
 */
export function getRemoteName(options?: ShadowOptions): string {
  if (!options?.remote) return "origin";
  const remoteType = options.remoteType ?? "named";
  if (remoteType === "path" || remoteType === "url") return "kspec-specs";
  return options.remote;
}

/**
 * Resolve the remote target used for direct ls-remote/fetch queries.
 * Named remotes use the configured name, while path remotes expand "~".
 */
function getRemoteQueryTarget(options?: ShadowOptions): string {
  if (!options?.remote) return "origin";

  const remoteType = options.remoteType ?? "named";
  if (remoteType !== "path") {
    return options.remote;
  }

  if (options.remote.startsWith("~")) {
    return options.remote.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "~");
  }

  return options.remote;
}

/**
 * Check whether the shadow branch exists on the configured/default remote.
 */
export async function remoteShadowBranchExists(
  projectRoot: string,
  options?: ShadowOptions,
): Promise<boolean> {
  const branchName = getBranchName(options);
  const remoteType = options?.remoteType ?? "named";
  const remoteName = getRemoteName(options);
  const remoteQueryTarget = getRemoteQueryTarget(options);

  if (options?.remote) {
    if (remoteType === "named" && !(await hasRemote(projectRoot, remoteName))) {
      return false;
    }

    return remoteBranchExists(projectRoot, branchName, remoteQueryTarget);
  }

  if (!(await hasRemote(projectRoot, remoteName))) {
    return false;
  }

  return remoteBranchExists(projectRoot, branchName, remoteQueryTarget);
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
  return runGitSync(dir, ["rev-parse", "--git-dir"]).ok;
}

/**
 * Get the git root directory
 */
export function getGitRoot(dir: string): string | null {
  const result = runGitSync(dir, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) {
    return null;
  }
  return result.stdout.trim();
}

function isSubmoduleCommonDir(commonDir: string): boolean {
  const segments = path.normalize(commonDir).split(path.sep).filter(Boolean);
  const gitIndex = segments.lastIndexOf(".git");
  return gitIndex >= 0 && segments[gitIndex + 1] === "modules";
}

export function resolveProjectRoots(dir: string): ProjectRoots | null {
  const result = runGitSync(dir, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
  if (!result.ok) {
    return null;
  }

  const [rawTopLevel, rawCommonDir] = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!rawTopLevel || !rawCommonDir) {
    return null;
  }

  const worktreeRoot = path.resolve(rawTopLevel);
  const commonDir = path.isAbsolute(rawCommonDir)
    ? path.resolve(rawCommonDir)
    : path.resolve(worktreeRoot, rawCommonDir);

  if (isSubmoduleCommonDir(commonDir) || commonDir === path.join(worktreeRoot, ".git")) {
    return {
      mainRoot: worktreeRoot,
      worktreeRoot,
      isWorktree: false,
    };
  }

  return {
    mainRoot: path.dirname(commonDir),
    worktreeRoot,
    isWorktree: true,
  };
}

/**
 * Build the instructional message shown when a shadow-lifecycle command is
 * invoked from a linked git worktree. Shared between the function-level
 * guard and the command-level entry checks in init/setup so the wording
 * matches everywhere the user can hit this error.
 *
 * AC: @worktree-support ac-init-guidance-direction, ac-init-guidance-path,
 *     ac-setup-guidance-direction, ac-setup-guidance-path
 */
export function buildLinkedWorktreeMessage(
  command: string,
  mainRoot: string,
): { message: string; suggestion: string } {
  const message = `${command} must be run from the repo's main working tree, not a linked worktree. Main working tree: ${mainRoot}`;
  const suggestion = `cd ${mainRoot} && ${command}`;
  return { message, suggestion };
}

/**
 * Guard that asserts `projectRoot` is the main working tree of its git repo,
 * not a linked worktree created via `git worktree add`. Throws ShadowError
 * with code LINKED_WORKTREE_NOT_SUPPORTED if the check fails.
 *
 * This is defense-in-depth: command-layer callers should resolve mainRoot
 * before calling into shadow-lifecycle functions, but this guard catches
 * any future caller that forgets to do so. Passing the linked worktree root
 * to initializeShadow/repairShadow would otherwise allow git's shared
 * worktree admin (find_worktree_by_suffix) to silently mutate the main
 * working tree's shadow directory — the 2026-04-11 incident vector.
 *
 * AC: @worktree-support ac-shadow-ops-scoped-to-main
 *
 * @param projectRoot Path that SHOULD be the main working tree root.
 * @throws ShadowError when `projectRoot` is a linked worktree.
 */
export function assertMainWorkingTree(projectRoot: string): void {
  const roots = resolveProjectRoots(projectRoot);
  if (!roots) {
    // Not a git repo — let downstream code surface the real error.
    return;
  }
  if (roots.isWorktree) {
    const { message, suggestion } = buildLinkedWorktreeMessage(
      "Shadow worktree lifecycle operations",
      roots.mainRoot,
    );
    throw new ShadowError(message, "LINKED_WORKTREE_NOT_SUPPORTED", suggestion);
  }
}

/**
 * Check if a branch exists
 */
export async function branchExists(dir: string, branchName: string): Promise<boolean> {
  return runGitSync(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]).ok;
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

    const gitdir = path.resolve(cwd, match[1]);

    // Check if this is a worktree (pattern: <project>/.git/worktrees/<name>)
    if (gitdir.includes(".git/worktrees/")) {
      const worktreesMatch = gitdir.match(/^(.*?)[/\\]\.git[/\\]worktrees[/\\]/);
      if (worktreesMatch) {
        const mainProjectRoot = worktreesMatch[1];
        const cwdBase = path.basename(cwd);

        // AC: ac-8 — check multiple patterns for shadow worktree detection
        const directoryToCheck = configuredDirectory || SHADOW_WORKTREE_DIR;

        // Exact shadow directory names are always considered shadow worktrees.
        if (cwdBase === SHADOW_WORKTREE_DIR || cwdBase === directoryToCheck) {
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
  mainRoot?: string,
): Promise<ShadowConfig | null> {
  const gitRoot = mainRoot ?? getGitRoot(startDir);
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
    artifactsDirExists: false,
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

    // AC: @artifacts-directory ac-doctor-checks
    try {
      await fs.access(path.join(worktreeDir, "artifacts"));
      status.artifactsDirExists = true;
    } catch {
      status.artifactsDirExists = false;
    }
  }

  // Determine overall status
  status.exists = status.branchExists || status.worktreeExists;
  status.healthy = status.branchExists && status.worktreeExists && status.worktreeLinked;

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
    parts.push(`branch "${SHADOW_BRANCH_NAME}" (config wants "${configuredBranch}")`);
  }
  if (result.directoryMismatch) {
    parts.push(`directory "${SHADOW_WORKTREE_DIR}" (config wants "${configuredDirectory}")`);
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
      console.error(`[DEBUG] Shadow auto-commit: git add -A (cwd: ${worktreeDir})`);
    }

    // Stage all changes
    const addResult = runCommandSync("git", ["add", "-A"], { cwd: worktreeDir });
    if (!addResult.ok) {
      throw new Error(addResult.stderr || "git add failed");
    }

    // Check if there are staged changes
    try {
      if (debug) {
        console.error(`[DEBUG] Shadow auto-commit: git diff --cached --quiet`);
      }

      const diffResult = runCommandSync("git", ["diff", "--cached", "--quiet"], {
        cwd: worktreeDir,
      });
      if (!diffResult.ok) {
        throw new Error("changes staged");
      }
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
    const commitResult = runCommandSync("git", ["commit", "-m", message], {
      cwd: worktreeDir,
      env: { ...process.env, KSPEC_SHADOW_COMMIT: "1" },
    });
    if (!commitResult.ok) {
      throw new Error(commitResult.stderr || "git commit failed");
    }

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
export function generateCommitMessage(operation: string, ref?: string, detail?: string): string {
  const normalizedRef = normalizeCommitRef(ref);
  const detailFromRef = !detail && shouldTreatRefAsDetail(ref) ? ref : undefined;
  const effectiveRef = detailFromRef ? undefined : normalizedRef;
  const effectiveDetail = detail ?? detailFromRef;

  switch (operation) {
    case "task-start":
      return formatCommitOperation("Start Task", effectiveRef, effectiveDetail);
    case "task-complete":
      return formatCommitOperation("Complete Task", effectiveRef, effectiveDetail);
    case "task-note":
      return formatCommitOperation("Note Task", effectiveRef, effectiveDetail);
    case "task-add":
      return formatCommitOperation("Add Task", effectiveRef, effectiveDetail);
    case "task-set":
      return formatCommitOperation("Update Task", effectiveRef, effectiveDetail);
    case "task-patch":
      return formatCommitOperation("Patch Task", effectiveRef, effectiveDetail);
    case "task-submit":
      return formatCommitOperation("Submit Task", effectiveRef, effectiveDetail);
    case "task-needs-work":
      return formatCommitOperation("Needs Work Task", effectiveRef, effectiveDetail);
    case "task-block":
      return formatCommitOperation("Block Task", effectiveRef, effectiveDetail);
    case "task-unblock":
      return formatCommitOperation("Unblock Task", effectiveRef, effectiveDetail);
    case "task-cancel":
      return formatCommitOperation("Cancel Task", effectiveRef, effectiveDetail);
    case "task-reset":
      return formatCommitOperation("Reset Task", effectiveRef, effectiveDetail);
    case "task-delete":
      return formatCommitOperation("Delete Task", effectiveRef, effectiveDetail);
    case "inbox-add":
      return formatCommitOperation(
        "Add Inbox Item",
        effectiveRef,
        truncateCommitDetail(effectiveDetail),
      );
    case "inbox-promote":
      return formatCommitOperation("Promote Inbox Item", effectiveRef, effectiveDetail);
    case "inbox-delete":
      return formatCommitOperation("Delete Inbox Item", effectiveRef, effectiveDetail);
    case "inbox-set":
      return formatCommitOperation("Update Inbox Item", effectiveRef, effectiveDetail);
    case "inbox-note":
      return formatCommitOperation("Note Inbox Item", effectiveRef, effectiveDetail);
    case "item-add":
      return formatCommitOperation("Add Item", effectiveRef, effectiveDetail);
    case "item-set":
      return formatCommitOperation("Update Item", effectiveRef, effectiveDetail);
    case "item-delete":
      return formatCommitOperation("Delete Item", effectiveRef, effectiveDetail);
    case "item-patch":
      return formatCommitOperation("Patch Item", effectiveRef, effectiveDetail);
    case "item-note":
      return formatCommitOperation("Note Item", effectiveRef, effectiveDetail);
    case "item-ac-add":
      return formatCommitOperation("Add Item AC", effectiveRef, effectiveDetail);
    case "item-ac-set":
      return formatCommitOperation("Update Item AC", effectiveRef, effectiveDetail);
    case "item-ac-remove":
      return formatCommitOperation("Remove Item AC", effectiveRef, effectiveDetail);
    case "item-trait-add":
      return formatCommitOperation("Add Item Trait", effectiveRef, effectiveDetail);
    case "item-trait-remove":
      return formatCommitOperation("Remove Item Trait", effectiveRef, effectiveDetail);
    case "trait-add":
      return formatCommitOperation("Add Trait", effectiveRef, effectiveDetail);
    case "module-add":
      return formatCommitOperation("Add Module", effectiveRef, effectiveDetail);
    case "link-add":
      return formatCommitOperation("Add Link", effectiveRef, effectiveDetail);
    case "link-remove":
      return formatCommitOperation("Remove Link", effectiveRef, effectiveDetail);
    case "derive":
      return formatCommitOperation("Derive", effectiveRef, effectiveDetail);
    case "spec-sync":
      return formatCommitOperation("Sync Spec", effectiveRef, effectiveDetail);
    case "review-add":
      return formatCommitOperation("Add Review", effectiveRef, effectiveDetail);
    case "review-comment":
      return formatCommitOperation("Comment Review", effectiveRef, effectiveDetail);
    case "review-reply":
      return formatCommitOperation("Reply Review", effectiveRef, effectiveDetail);
    case "review-check":
      return formatCommitOperation("Check Review", effectiveRef, effectiveDetail);
    case "review-verdict":
      return formatCommitOperation("Verdict Review", effectiveRef, effectiveDetail);
    case "review-verdict-task-transition":
      return formatCommitOperation("Review Verdict Task Transition", effectiveRef, effectiveDetail);
    case "review-resolve":
      return formatCommitOperation("Resolve Review", effectiveRef, effectiveDetail);
    case "review-reopen":
      return formatCommitOperation("Reopen Review", effectiveRef, effectiveDetail);
    case "review-open":
      return formatCommitOperation("Open Review", effectiveRef, effectiveDetail);
    case "review-close":
      return formatCommitOperation("Close Review", effectiveRef, effectiveDetail);
    case "review-archive":
      return formatCommitOperation("Archive Review", effectiveRef, effectiveDetail);
    case "review-refresh":
      return formatCommitOperation("Refresh Review", effectiveRef, effectiveDetail);
    case "review-task-link":
      return formatCommitOperation("Link Review Task", effectiveRef, effectiveDetail);
    case "plan-add":
      return formatCommitOperation("Add Plan", effectiveRef, effectiveDetail);
    case "plan-set":
      return formatCommitOperation("Update Plan", effectiveRef, effectiveDetail);
    case "plan-note":
      return formatCommitOperation("Note Plan", effectiveRef, effectiveDetail);
    case "plan-derive":
      return formatCommitOperation("Derive Plan", effectiveRef, effectiveDetail);
    case "plan-import":
      return formatCommitOperation("Import Plan", effectiveRef, effectiveDetail);
    case "plan-delete":
      return formatCommitOperation("Delete Plan", effectiveRef, effectiveDetail);
    case "triage-record":
      return formatCommitOperation("Record Triage", effectiveRef, effectiveDetail);
    case "triage-act":
      return formatCommitOperation("Act Triage", effectiveRef, effectiveDetail);
    case "triage-override":
      return formatCommitOperation("Override Triage", effectiveRef, effectiveDetail);
    case "meta-observe":
      return formatCommitOperation("Observe Meta", effectiveRef, effectiveDetail);
    case "meta-observe-from-inbox":
      return formatCommitOperation("Observe Meta from Inbox", effectiveRef, effectiveDetail);
    case "observation-promote":
      return formatCommitOperation("Promote Observation", effectiveRef, effectiveDetail);
    case "observation-resolve":
      return formatCommitOperation("Resolve Observation", effectiveRef, effectiveDetail);
    case "skill-add":
      return formatCommitOperation("Add Skill", effectiveRef, effectiveDetail);
    case "skill-set":
      return formatCommitOperation("Update Skill", effectiveRef, effectiveDetail);
    case "skill-delete":
      return formatCommitOperation("Delete Skill", effectiveRef, effectiveDetail);
    case "skill-import":
      return formatCommitOperation("Import Skill", effectiveRef, effectiveDetail);
    case "skill-render":
      return formatCommitOperation("Render Skill", effectiveRef, effectiveDetail);
    case "skill-install-core":
      return formatCommitOperation("Install Core Skill", effectiveRef, effectiveDetail);
    case "skill-update":
      return formatCommitOperation("Update Skill", effectiveRef, effectiveDetail);
    case "hook-add":
      return formatCommitOperation("Add Hook", effectiveRef, effectiveDetail);
    case "hook-set":
      return formatCommitOperation("Update Hook", effectiveRef, effectiveDetail);
    case "hook-enable":
      return formatCommitOperation("Enable Hook", effectiveRef, effectiveDetail);
    case "hook-disable":
      return formatCommitOperation("Disable Hook", effectiveRef, effectiveDetail);
    case "hook-remove":
      return formatCommitOperation("Remove Hook", effectiveRef, effectiveDetail);
    case "schedule-add":
      return formatCommitOperation("Add Schedule", effectiveRef, effectiveDetail);
    case "schedule-set":
      return formatCommitOperation("Update Schedule", effectiveRef, effectiveDetail);
    case "schedule-enable":
      return formatCommitOperation("Enable Schedule", effectiveRef, effectiveDetail);
    case "schedule-disable":
      return formatCommitOperation("Disable Schedule", effectiveRef, effectiveDetail);
    case "schedule-remove":
      return formatCommitOperation("Remove Schedule", effectiveRef, effectiveDetail);
    case "workflow-start":
      return formatCommitOperation("Start Workflow", effectiveRef, effectiveDetail);
    case "workflow-abort":
      return formatCommitOperation("Abort Workflow", effectiveRef, effectiveDetail);
    case "workflow-complete":
      return formatCommitOperation("Complete Workflow", effectiveRef, effectiveDetail);
    case "workflow-pause":
      return formatCommitOperation("Pause Workflow", effectiveRef, effectiveDetail);
    case "workflow-resume":
      return formatCommitOperation("Resume Workflow", effectiveRef, effectiveDetail);
    case "workflow-next":
      return formatCommitOperation("Advance Workflow", effectiveRef, effectiveDetail);
    case "workflow-prune":
      return formatCommitOperation("Prune Workflow", effectiveRef, effectiveDetail);
    case "session-compact":
      return formatCommitOperation("Compact Session", effectiveRef, effectiveDetail);
    case "tasks-assess":
      return formatCommitOperation("Assess Tasks", effectiveRef, effectiveDetail);
    case "dispatch-workspace-registry":
      return formatCommitOperation(
        "Update Dispatch Workspace Registry",
        effectiveRef,
        effectiveDetail,
      );
    default:
      if (operation.startsWith("meta-add-")) {
        return formatCommitOperation(
          `Add ${titleizeOperationSuffix(operation, "meta-add-")}`,
          effectiveRef,
          effectiveDetail,
        );
      }
      if (operation.startsWith("meta-set-")) {
        return formatCommitOperation(
          `Update ${titleizeOperationSuffix(operation, "meta-set-")}`,
          effectiveRef,
          effectiveDetail,
        );
      }
      if (operation.startsWith("meta-delete-")) {
        return formatCommitOperation(
          `Delete ${titleizeOperationSuffix(operation, "meta-delete-")}`,
          effectiveRef,
          effectiveDetail,
        );
      }
      return operation + (effectiveRef ? ` ${effectiveRef}` : "");
  }
}

function normalizeCommitRef(ref?: string): string | undefined {
  if (!ref) return undefined;
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function shouldTreatRefAsDetail(ref?: string): boolean {
  return Boolean(ref && ref.includes(" "));
}

function formatCommitOperation(label: string, ref?: string, detail?: string): string {
  if (ref && detail) return `${label}: ${ref} - ${detail}`;
  if (ref) return `${label}: ${ref}`;
  if (detail) return `${label}: ${detail}`;
  return label;
}

function truncateCommitDetail(detail?: string): string | undefined {
  if (!detail) return undefined;
  return `${detail.slice(0, 50)}${detail.length > 50 ? "..." : ""}`;
}

function titleizeOperationSuffix(operation: string, prefix: string): string {
  return operation
    .slice(prefix.length)
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
  if (relativePath.startsWith("..") || relativePath.startsWith(worktreeDirName)) {
    return originalPath;
  }

  // Handle spec/ -> shadow worktree mapping
  if (relativePath.startsWith("spec/") || relativePath.startsWith("spec\\")) {
    const specRelative = relativePath.slice(5); // Remove 'spec/'
    return path.join(shadowConfig.worktreeDir, specRelative);
  }

  // For task/inbox files at root, move to shadow worktree
  if (relativePath.endsWith(".tasks.yaml") || relativePath.endsWith(".inbox.yaml")) {
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
  const committed = await shadowAutoCommit(shadowConfig.worktreeDir, message, verbose);

  // AC: @shadow-sync ac-1 - Fire-and-forget push after each commit
  // AC: @shadow-write-sync ac-write-always-syncs — writes always sync via push path
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
  /** Whether .kspec-sessions/ directory was created */
  sessionsDirectoryCreated?: boolean;
  /** Whether session branch worktree was created (sessions.storage=branch) */
  sessionBranchCreated?: boolean;
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
  /** Session storage configuration from manifest */
  sessions?: { storage?: string; branch?: string };
  /** Override for the dispatch worktree root (default: .kspec-worktrees) */
  worktreeRoot?: string;
}

/**
 * Check if a remote exists (default: origin)
 */
export async function hasRemote(projectRoot: string, remoteName = "origin"): Promise<boolean> {
  try {
    const { stdout } = await runGitAsync(projectRoot, ["remote", "get-url", remoteName]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a branch exists on a remote.
 * Uses git ls-remote to query the remote directly, which works in both
 * full and shallow clones.
 *
 * AC: @shadow-init-remote ac-5 — works in shallow clones
 */
export async function remoteBranchExists(
  projectRoot: string,
  branchName: string,
  remoteName = "origin",
): Promise<boolean> {
  try {
    const { stdout } = await runGitAsync(projectRoot, [
      "ls-remote",
      "--heads",
      remoteName,
      branchName,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Fetch from remote to ensure refs are up to date.
 * Returns true if fetch succeeded, false otherwise.
 */
export async function fetchRemote(projectRoot: string, remoteName = "origin"): Promise<boolean> {
  try {
    await runGitAsync(projectRoot, ["fetch", remoteName]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the local shadow branch has unpushed commits ahead of upstream.
 * Returns true if local is ahead, false otherwise (including when upstream
 * ref doesn't exist or an error occurs).
 *
 * @param worktreeDir Path to shadow worktree
 */
export async function isAheadOfUpstream(worktreeDir: string): Promise<boolean> {
  try {
    const { stdout } = await runGitAsync(worktreeDir, [
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{u}",
    ]);
    const [aheadStr] = stdout.trim().split("\t");
    const ahead = parseInt(aheadStr, 10);
    return ahead > 0;
  } catch {
    // No upstream ref or other error — not ahead
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
    await runGitAsync(worktreeDir, ["push", "-u", remoteName, branchName]);
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
    const { stdout } = await runGitAsync(worktreeDir, ["config", `branch.${branchName}.remote`]);
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
          guidance:
            `Remote '${remoteName}' does not exist. To fix this:\n` +
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

          await runGitAsync(projectRoot, ["remote", "add", specRemoteName, remoteTarget]);
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
    await runGitAsync(worktreeDir, ["config", `branch.${branchName}.remote`, remoteName]);
    await runGitAsync(worktreeDir, [
      "config",
      `branch.${branchName}.merge`,
      `refs/heads/${branchName}`,
    ]);
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

const SHADOW_PUSH_FAILURE_ESCALATION_THRESHOLD = 3;
const shadowPushFailureCounts = new Map<string, number>();

function summarizeShadowPushError(
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    if (lastLine.length <= 240) {
      return lastLine;
    }
    return `${lastLine.slice(0, 237)}...`;
  }

  if (code !== null) {
    return `git push exited with code ${code}`;
  }
  if (signal) {
    return `git push terminated by signal ${signal}`;
  }
  return "git push failed";
}

function noteShadowPushFailure(worktreeDir: string, reason: string): void {
  const nextCount = (shadowPushFailureCounts.get(worktreeDir) ?? 0) + 1;
  shadowPushFailureCounts.set(worktreeDir, nextCount);

  console.error(
    `[WARN] Shadow auto-push failed (consecutive: ${nextCount}). Local shadow commits were kept. ${reason}`,
  );

  if (nextCount >= SHADOW_PUSH_FAILURE_ESCALATION_THRESHOLD) {
    console.error(
      `[WARN] Shadow auto-push has failed ${nextCount} times in a row. Remote shadow state is stale. Run \`kspec shadow sync\` (or \`kspec shadow resolve\` if conflicts are reported).`,
    );
  }
}

function noteShadowPushSuccess(worktreeDir: string): void {
  shadowPushFailureCounts.delete(worktreeDir);
}

/**
 * Pull-rebase from remote before pushing, using the kspec merge driver for
 * YAML conflict resolution.
 *
 * AC: @config-shadow ac-11 — pull-rebase before push prevents divergence
 *
 * @returns true if pull succeeded (or was unnecessary), false on conflict
 */
async function pullRebaseBeforePush(
  worktreeDir: string,
  branchName: string,
  debug: boolean,
  _options?: ShadowOptions,
): Promise<boolean> {
  try {
    // Fetch latest remote state for the shadow branch specifically.
    // Using the worktree dir for fetch ensures we use the branch's tracking config.
    try {
      await runGitAsync(worktreeDir, ["fetch"]);
    } catch {
      if (debug) {
        console.error("[DEBUG] Shadow pull-rebase: fetch failed, skipping pull");
      }
      // Fetch failure is non-fatal — push may still succeed if already up to date
      return true;
    }

    // AC: @config-shadow ac-3 — resolve the configured remote name from git config
    // instead of hardcoding "origin", so custom shadow.remote setups work correctly
    const projectRoot = path.dirname(worktreeDir);
    let remoteName = "origin";
    try {
      const { stdout } = await runGitAsync(worktreeDir, ["config", `branch.${branchName}.remote`]);
      const configured = stdout.trim();
      if (configured) {
        remoteName = configured;
      }
    } catch {
      // Fall back to origin if config lookup fails
    }

    const remoteHasBranch = await remoteBranchExists(projectRoot, branchName, remoteName);
    if (!remoteHasBranch) {
      if (debug) {
        console.error("[DEBUG] Shadow pull-rebase: no remote branch yet, skipping pull");
      }
      return true;
    }

    // Check if there are any upstream changes to integrate.
    // If local is already at or ahead of remote, skip the pull.
    try {
      const { stdout } = await runGitAsync(worktreeDir, [
        "rev-list",
        "--count",
        `${branchName}..@{upstream}`,
      ]);
      const behindCount = parseInt(stdout.trim(), 10);
      if (behindCount === 0) {
        if (debug) {
          console.error("[DEBUG] Shadow pull-rebase: already up to date with remote");
        }
        return true;
      }
    } catch {
      // rev-list may fail if upstream isn't set — proceed with pull attempt
    }

    // Try fast-forward first (cleanest, no rebase needed)
    try {
      await runGitAsync(worktreeDir, ["pull", "--ff-only"]);
      if (debug) {
        console.error("[DEBUG] Shadow pull-rebase: fast-forward succeeded");
      }
      return true;
    } catch {
      // FF failed, need rebase
    }

    // Fall back to rebase — the kspec merge driver handles YAML conflicts
    try {
      await runGitAsync(worktreeDir, ["pull", "--rebase"]);
      if (debug) {
        console.error("[DEBUG] Shadow pull-rebase: rebase succeeded");
      }
      return true;
    } catch {
      // Rebase failed — abort and report
    }

    // Abort the failed rebase so local state is clean
    try {
      await runGitAsync(worktreeDir, ["rebase", "--abort"]);
    } catch {
      // May not be in rebase state
    }

    if (debug) {
      console.error("[DEBUG] Shadow pull-rebase: conflict detected, push skipped");
    }
    return false;
  } catch (err) {
    if (debug) {
      console.error("[DEBUG] Shadow pull-rebase error:", err);
    }
    // Pull failure is non-fatal — still attempt push
    return true;
  }
}

/**
 * Fire-and-forget push to remote with pull-rebase-before-push.
 * AC-1: Called after each auto-commit when tracking is configured.
 * AC-8: Automatically sets up tracking if main branch has remote.
 * AC: @config-shadow ac-11 — pull-rebase before push for bidirectional sync.
 * Push failures are surfaced as warnings, but local commits still succeed.
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
      console.error("[DEBUG] Shadow push: No remote tracking configured, skipping");
    }
    return; // AC: @shadow-sync ac-4 - silently skip if no tracking
  }

  // AC: @config-shadow ac-11 — pull-rebase before pushing to integrate remote changes
  // AC: @shadow-write-sync ac-write-always-syncs — writes always perform full sync
  const branchName = getBranchName(options);
  const pullOk = await pullRebaseBeforePush(worktreeDir, branchName, debug, options);
  if (!pullOk) {
    noteShadowPushFailure(
      worktreeDir,
      "Pull-rebase failed due to conflicts. Run `kspec shadow resolve` to fix.",
    );
    return;
  }

  try {
    if (debug) {
      console.error(`[DEBUG] Shadow push: git push (cwd: ${worktreeDir})`);
    }

    // Fire and forget: detached + unref allows CLI exit without waiting for push.
    // We still collect stderr and exit code while process is alive to surface failures.
    const child = spawn("git", ["push"], {
      cwd: worktreeDir,
      env: buildShadowGitEnv(),
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });

    const stderrChunks: string[] = [];
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });
    child.stderr?.resume();

    (child.stderr as { unref?: () => void } | null)?.unref?.();
    child.unref();
    if (debug) {
      console.error("[DEBUG] Shadow push: spawned background git push");
    }

    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      let settled = false;
      const finish = (result: {
        code: number | null;
        signal: NodeJS.Signals | null;
        error?: Error;
      }) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      child.once("error", (error) => finish({ code: null, signal: null, error }));
      child.once("close", (code, signal) => finish({ code, signal }));
    });

    if (exit.error) {
      noteShadowPushFailure(worktreeDir, exit.error.message);
      if (debug) {
        console.error("[DEBUG] Shadow push spawn error:", exit.error);
      }
      return;
    }

    if (exit.code !== 0) {
      const reason = summarizeShadowPushError(stderrChunks.join(""), exit.code, exit.signal);
      noteShadowPushFailure(worktreeDir, reason);
      return;
    }

    noteShadowPushSuccess(worktreeDir);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    noteShadowPushFailure(worktreeDir, reason);

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
// In-flight dedup: if a pull is already running for this worktree, piggyback
// on its result instead of starting a concurrent stash/pull/pop sequence.
const pullInflight = new Map<string, Promise<ShadowSyncResult>>();

export function shadowPull(
  worktreeDir: string,
  options?: ShadowOptions,
): Promise<ShadowSyncResult> {
  const key = path.resolve(worktreeDir);
  const existing = pullInflight.get(key);
  if (existing) {
    return existing;
  }
  const promise = shadowPullImpl(worktreeDir, options).finally(() => {
    pullInflight.delete(key);
  });
  pullInflight.set(key, promise);
  return promise;
}

async function shadowPullImpl(
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
  // AC: @config-shadow ac-3 — use configured remote instead of hardcoded origin
  const remoteName = getRemoteName(options);
  // Fetch first to ensure refs are up to date
  await fetchRemote(projectRoot, remoteName);
  const remoteHasBranch = await remoteBranchExists(projectRoot, branchName, remoteName);
  if (!remoteHasBranch) {
    // Remote branch doesn't exist yet - nothing to pull, but success
    result.success = true;
    return result;
  }

  // Stash uncommitted changes before pulling to avoid false conflict reports
  let stashed = false;
  try {
    const { stdout } = await runGitAsync(worktreeDir, ["stash", "push", "-m", "shadow-sync-auto"]);
    stashed = !stdout.includes("No local changes");
  } catch {
    // If stash fails, skip the pull entirely — don't risk reporting a false conflict
    result.success = true;
    return result;
  }

  const unstash = async () => {
    if (stashed) {
      try {
        await runGitAsync(worktreeDir, ["stash", "pop"]);
      } catch {
        // Stash pop conflict is unlikely but leave stash intact if it happens
      }
    }
  };

  try {
    // Try fast-forward only first (cleanest)
    await runGitAsync(worktreeDir, ["pull", "--ff-only"]);
    await unstash();
    result.success = true;
    result.pulled = true;
    return result;
  } catch {
    // Fast-forward failed, try rebase
  }

  try {
    // AC: @shadow-sync ac-6 - Fall back to rebase
    await runGitAsync(worktreeDir, ["pull", "--rebase"]);
    await unstash();
    result.success = true;
    result.pulled = true;
    return result;
  } catch {
    // Rebase failed - likely conflict
  }

  // AC: @shadow-sync ac-3 - Conflict detected - abort rebase and report
  try {
    await runGitAsync(worktreeDir, ["rebase", "--abort"]);
  } catch {
    // May not be in rebase state, ignore
  }

  await unstash();
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
      await runGitAsync(worktreeDir, ["push"]);
      pullResult.pushed = true;
    } catch {
      // Push failed - not a critical error, local state is correct
      // Could be permissions, network, etc.
    }
  }

  return pullResult;
}

// ─── Lazy Drift Check ────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 5000;

/**
 * Spawn a git command with a hard timeout. Returns stdout/stderr on success,
 * throws on non-zero exit or timeout. On timeout, sends SIGTERM then SIGKILL.
 *
 * Used for drift check fetch only — other git ops continue using runGitAsync.
 *
 * AC: @shadow-lazy-read-sync ac-fetch-timeout
 */
export function spawnGitWithTimeout(
  cwd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: buildShadowGitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
    });

    let promiseSettled = false;
    let processExited = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!processExited) child.kill("SIGKILL");
      }, 1000);
      promiseSettled = true;
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("close", (code) => {
      processExited = true;
      clearTimeout(timer);
      if (promiseSettled) return;
      promiseSettled = true;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`git ${args[0]} exited ${code}: ${stderr}`));
    });
  });
}

/**
 * Lightweight drift check: determine whether local shadow branch needs
 * to pull from remote. Uses FETCH_HEAD mtime to avoid redundant fetches,
 * and ahead/behind counts to decide if a pull is needed.
 *
 * AC: @shadow-lazy-read-sync ac-drift-check
 * AC: @shadow-lazy-read-sync ac-fetch-head-location
 * AC: @shadow-lazy-read-sync ac-fetch-head-freshness
 * AC: @shadow-lazy-read-sync ac-fetch-when-stale
 * AC: @shadow-lazy-read-sync ac-fetch-timeout-no-error
 * AC: @shadow-lazy-read-sync ac-fetch-timeout-debug-log
 * AC: @shadow-lazy-read-sync ac-pull-when-behind
 * AC: @shadow-lazy-read-sync ac-no-pull-when-ahead
 * AC: @shadow-lazy-read-sync ac-pull-when-diverged
 * AC: @shadow-lazy-read-sync ac-upstream-ref-missing
 * AC: @shadow-lazy-read-sync ac-no-drift-fast-path
 * AC: @shadow-lazy-read-sync ac-threshold-from-config
 *
 * @returns true if shadowPull() should be called, false if local state is current
 */
export async function shadowNeedsSync(
  worktreeDir: string,
  remoteName: string,
  thresholdMs: number,
): Promise<boolean> {
  // 1. Resolve FETCH_HEAD path for this worktree
  // AC: ac-fetch-head-location — use rev-parse --git-path from worktree dir
  const { stdout: fetchHeadRaw } = await runGitAsync(worktreeDir, [
    "rev-parse",
    "--git-path",
    "FETCH_HEAD",
  ]);
  const fetchHeadPath = path.resolve(worktreeDir, fetchHeadRaw.trim());

  // 2. Check freshness — if stale or missing, fetch with timeout
  // AC: ac-fetch-head-freshness, ac-fetch-when-stale
  let fetchNeeded = true;
  try {
    const stat = await fs.stat(fetchHeadPath);
    fetchNeeded = Date.now() - stat.mtimeMs > thresholdMs;
  } catch {
    // No FETCH_HEAD — need to fetch
  }

  if (fetchNeeded) {
    try {
      // AC: ac-fetch-timeout — kill if exceeds FETCH_TIMEOUT_MS
      await spawnGitWithTimeout(worktreeDir, ["fetch", remoteName], FETCH_TIMEOUT_MS);
    } catch (err) {
      // AC: ac-fetch-timeout-no-error — no error surfaced to user
      // AC: ac-fetch-timeout-debug-log — debug log if enabled
      if (isDebugEnabled()) {
        console.error(
          `[DEBUG] shadow drift-check: fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return false;
    }
  }

  // 3. Check ahead/behind — only sync when behind or diverged
  // AC: ac-pull-when-behind, ac-no-pull-when-ahead, ac-pull-when-diverged
  try {
    const { stdout } = await runGitAsync(worktreeDir, [
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{u}",
    ]);
    const [, behind] = stdout.trim().split("\t").map(Number);
    // AC: ac-no-drift-fast-path — behind === 0 means no pull needed
    return behind > 0;
  } catch {
    // AC: ac-upstream-ref-missing — force sync as safer default
    return true;
  }
}

/**
 * Check if debug logging is enabled (KSPEC_DEBUG=1 or --debug-shadow).
 */
function isDebugEnabled(): boolean {
  if (process.env.KSPEC_DEBUG === "1") return true;
  if (getVerboseModeFunc?.()) return true;
  return false;
}

/**
 * Check if .gitignore has uncommitted changes
 */
async function hasUncommittedGitignore(projectRoot: string): Promise<boolean> {
  try {
    // Check both staged and unstaged changes to .gitignore
    const { stdout } = await runGitAsync(projectRoot, ["status", "--porcelain", ".gitignore"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Add .kspec-sessions/ to root .gitignore if not already present.
 * Does NOT commit — caller is responsible for committing if needed.
 *
 * AC: @session-storage-modes ac-gitignore
 *
 * @param projectRoot Git repository root
 * @returns true if entry was added, false if already present
 */
export async function needsSessionsGitignore(projectRoot: string): Promise<boolean> {
  const gitignorePath = path.join(projectRoot, ".gitignore");

  let content = "";
  try {
    content = await fs.readFile(gitignorePath, "utf-8");
  } catch {
    // File doesn't exist — entry is needed
    return true;
  }

  const lines = content.split("\n");
  const patterns = [
    SESSIONS_WORKTREE_DIR,
    `${SESSIONS_WORKTREE_DIR}/`,
    `/${SESSIONS_WORKTREE_DIR}`,
    `/${SESSIONS_WORKTREE_DIR}/`,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (patterns.includes(trimmed)) {
      return false; // Already present
    }
  }

  return true;
}

export async function needsPlansGitignore(projectRoot: string): Promise<boolean> {
  const gitignorePath = path.join(projectRoot, ".gitignore");

  let content = "";
  try {
    content = await fs.readFile(gitignorePath, "utf-8");
  } catch {
    return true;
  }

  const lines = content.split("\n");
  const patterns = [
    TRANSIENT_PLANS_DIR,
    `${TRANSIENT_PLANS_DIR}/`,
    `/${TRANSIENT_PLANS_DIR}`,
    `/${TRANSIENT_PLANS_DIR}/`,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (patterns.includes(trimmed)) {
      return false;
    }
  }

  return true;
}

export async function ensureSessionsGitignore(projectRoot: string): Promise<boolean> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const entry = `${SESSIONS_WORKTREE_DIR}/`;

  try {
    const needed = await needsSessionsGitignore(projectRoot);
    if (!needed) {
      return false;
    }

    let content = "";
    try {
      content = await fs.readFile(gitignorePath, "utf-8");
    } catch {
      // File doesn't exist, will create
    }

    // Add to gitignore
    const newContent =
      content.endsWith("\n") || content === "" ? `${content}${entry}\n` : `${content}\n${entry}\n`;

    await fs.writeFile(gitignorePath, newContent, "utf-8");
    return true;
  } catch (error) {
    throw new ShadowError(
      `Failed to update .gitignore with sessions directory: ${error}`,
      "GIT_ERROR",
      "Check file permissions for .gitignore",
    );
  }
}

export async function ensurePlansGitignore(projectRoot: string): Promise<boolean> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const entry = `${TRANSIENT_PLANS_DIR}/`;

  try {
    const needed = await needsPlansGitignore(projectRoot);
    if (!needed) {
      return false;
    }

    let content = "";
    try {
      content = await fs.readFile(gitignorePath, "utf-8");
    } catch {
      // File doesn't exist, will create
    }

    const newContent =
      content.endsWith("\n") || content === "" ? `${content}${entry}\n` : `${content}\n${entry}\n`;

    await fs.writeFile(gitignorePath, newContent, "utf-8");
    return true;
  } catch (error) {
    throw new ShadowError(
      `Failed to update .gitignore with plans directory: ${error}`,
      "GIT_ERROR",
      "Check file permissions for .gitignore",
    );
  }
}

/**
 * Add sessions/ to .kspec/.gitignore to prevent legacy session data
 * from being tracked on kspec-meta shadow branch.
 *
 * AC: @session-legacy-migration ac-shadow-gitignore
 *
 * @param projectRoot Git repository root
 * @param options Optional shadow configuration for directory name
 * @returns true if entry was added, false if already present
 */
export async function needsShadowSessionsGitignore(
  projectRoot: string,
  options?: ShadowOptions,
): Promise<boolean> {
  const directoryName = getDirectoryName(options);
  const shadowGitignorePath = path.join(projectRoot, directoryName, ".gitignore");
  const entry = "sessions/";

  try {
    const content = await fs.readFile(shadowGitignorePath, "utf-8");
    const lines = content.split("\n");
    if (lines.some((line) => line.trim() === entry || line.trim() === "sessions")) {
      return false; // Already present
    }
    return true;
  } catch {
    // File doesn't exist — can't add to non-existent file
    return false;
  }
}

export async function ensureShadowSessionsGitignore(
  projectRoot: string,
  options?: ShadowOptions,
): Promise<boolean> {
  const directoryName = getDirectoryName(options);
  const shadowGitignorePath = path.join(projectRoot, directoryName, ".gitignore");
  const entry = "sessions/";

  try {
    const needed = await needsShadowSessionsGitignore(projectRoot, options);
    if (!needed) {
      return false;
    }

    let content = "";
    try {
      content = await fs.readFile(shadowGitignorePath, "utf-8");
    } catch {
      // File doesn't exist — this shouldn't happen since init creates it,
      // but handle gracefully
      return false;
    }

    // Add to gitignore
    const newContent =
      content.endsWith("\n") || content === "" ? `${content}${entry}\n` : `${content}\n${entry}\n`;

    await fs.writeFile(shadowGitignorePath, newContent, "utf-8");
    return true;
  } catch {
    // Non-fatal — shadow gitignore update is best-effort
    return false;
  }
}

/**
 * Generate initial manifest content for shadow branch
 */
function generateShadowManifest(projectName: string, defaultModuleUlid: string): string {
  return `# ${projectName} - Kynetic Spec
# Generated by kspec init

kynetic: "1.2"

project:
  name: "${projectName}"
  version: "0.1.0"
  status: draft
  description: |
    Add your project description here.

task_storage:
  format: split

plan_storage:
  format: folder

review_storage:
  format: folder

resource_storage:
  format: entity_scoped

# ULID of the default module created at init
default_module: "${defaultModuleUlid}"

# Module includes
includes:
  - modules/main.yaml
`;
}

/**
 * Generate initial module content as a referenceable module item.
 * Creates a real module with a ULID, slug, and type so that
 * plan derivation can target it without extra setup.
 */
function generateShadowModule(projectName: string, moduleUlid: string): string {
  return `_ulid: ${moduleUlid}
slugs:
  - main
title: "${projectName} - Main Module"
type: module
status:
  maturity: draft
  implementation: not_started
description: |
  Default module for ${projectName}. Add your spec items here.

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
  } catch {
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
async function configureMergeDriver(projectRoot: string, worktreeDir: string): Promise<boolean> {
  try {
    // Step 1: Configure merge driver in .git/config
    const kspecPathResult = runCommandSync("which", ["kspec"]);
    if (!kspecPathResult.ok) {
      throw new Error(kspecPathResult.stderr || "kspec executable not found");
    }
    const kspecPath = kspecPathResult.stdout.trim();

    // Add merge driver configuration to git config
    try {
      const setNameResult = runCommandSync(
        "git",
        ["config", "merge.kspec.name", "Kspec YAML semantic merge driver"],
        { cwd: projectRoot },
      );
      if (!setNameResult.ok) {
        throw new Error(setNameResult.stderr || "failed to set merge.kspec.name");
      }

      const setDriverResult = runCommandSync(
        "git",
        ["config", "merge.kspec.driver", `${kspecPath} merge-driver %O %A %B --non-interactive`],
        { cwd: projectRoot },
      );
      if (!setDriverResult.ok) {
        throw new Error(setDriverResult.stderr || "failed to set merge.kspec.driver");
      }
    } catch (error) {
      // Config may fail if already set - check if it's set correctly
      try {
        const existingDriverResult = runCommandSync("git", ["config", "merge.kspec.driver"], {
          cwd: projectRoot,
        });
        if (!existingDriverResult.ok) {
          throw new Error(existingDriverResult.stderr || "failed to read merge.kspec.driver", {
            cause: error,
          });
        }
        const existingDriver = existingDriverResult.stdout.trim();

        if (!existingDriver.includes("kspec merge-driver")) {
          throw new Error("Merge driver config exists but is incorrect", { cause: error });
        }

        // Ensure --non-interactive flag is present (older registrations may lack it)
        if (!existingDriver.includes("--non-interactive")) {
          const fixResult = runCommandSync(
            "git",
            [
              "config",
              "merge.kspec.driver",
              `${kspecPath} merge-driver %O %A %B --non-interactive`,
            ],
            { cwd: projectRoot },
          );
          if (!fixResult.ok) {
            throw new Error(
              fixResult.stderr || "failed to update merge.kspec.driver with --non-interactive",
              { cause: error },
            );
          }
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
        ? `${existingContent}\n`
        : "# Git attributes for kspec\n\n";

      await fs.writeFile(
        gitattributesPath,
        `${attributesContent}*.yaml merge=kspec\n*.yml merge=kspec\n`,
        "utf-8",
      );

      // Commit .gitattributes to shadow branch
      await shadowAutoCommit(worktreeDir, "Configure kspec merge driver");
    }

    return true;
  } catch {
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

  // AC: @worktree-support ac-shadow-ops-scoped-to-main — defense-in-depth guard.
  // Refuse to operate on shadow state when projectRoot is a linked worktree.
  // Command-layer callers should resolve mainRoot before delegating; this
  // guard ensures that a missed resolution surfaces loudly instead of
  // silently mutating the main working tree's shadow via find_worktree_by_suffix.
  try {
    assertMainWorkingTree(projectRoot);
  } catch (err) {
    if (err instanceof ShadowError) {
      result.error = err.message;
      return result;
    }
    throw err;
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

  // Check for remote shadow branch
  // AC: @shadow-init-remote ac-4 ac-5 — queries remote directly via ls-remote
  const remoteExists = await hasRemote(projectRoot, remoteName);
  let remoteHasShadow = false;
  if (remoteExists) {
    remoteHasShadow = await remoteBranchExists(projectRoot, branchName, remoteName);
  }

  let stashedWorktreeDir: string | null = null;
  try {
    // Step 1: Update .gitignore with managed block containing all transient entries
    // AC: @complete-auto-gitignore ac-all-transient-paths-present
    // AC: @complete-auto-gitignore ac-existing-entries-preserved
    // AC: @complete-auto-gitignore ac-kspec-entries-idempotent
    if (await hasUncommittedGitignore(projectRoot)) {
      throw new ShadowError(
        ".gitignore has uncommitted changes",
        "GIT_ERROR",
        "Commit or stash your .gitignore changes before running kspec init.",
      );
    }

    const { ensureKspecGitignore } = await import("./gitignore.js");
    const gitignoreResult = await ensureKspecGitignore(projectRoot, {
      shadowDir: directoryName,
      worktreeRoot: options.worktreeRoot,
      force: true, // init is an explicit scaffolding action — always create managed block
    });
    result.gitignoreUpdated = gitignoreResult.changed;

    if (gitignoreResult.changed) {
      await runGitAsync(projectRoot, ["add", ".gitignore"]);
      await runGitAsync(projectRoot, [
        "commit",
        "-m",
        "chore: add kspec transient directories to .gitignore",
      ]);
    }

    // Step 1d: Create .kspec-sessions/ directory
    // AC: @session-storage-modes ac-sessions-dir-autocreate
    const sessionsDir = path.join(projectRoot, SESSIONS_WORKTREE_DIR);
    await fs.mkdir(sessionsDir, { recursive: true });
    result.sessionsDirectoryCreated = true;

    // Step 2: Create worktree with orphan branch (or attach to existing branch)
    if (!status.worktreeExists || !status.worktreeLinked) {
      // Remove existing directory if present but not linked
      if (status.worktreeExists && !status.worktreeLinked) {
        stashedWorktreeDir = await stashBrokenWorktreeDir(worktreeDir);
      }

      // Remove stale worktree reference if any.
      // AC: @worktree-support ac-shadow-ops-scoped-to-main — pass the
      // absolute worktreeDir so git cannot match a bare suffix across
      // the shared worktree admin of linked worktrees.
      try {
        await runGitAsync(projectRoot, ["worktree", "remove", worktreeDir, "--force"]);
      } catch {
        // Ignore - worktree may not exist in git's list
      }

      if (remoteHasShadow) {
        // AC: @shadow-init-remote ac-1, ac-5 - Remote has shadow branch - fetch and create worktree
        // Fetch with refspec to create a local branch ref (required in shallow clones
        // where plain `git fetch origin kspec-meta` only populates FETCH_HEAD)
        await runGitAsync(projectRoot, ["fetch", remoteName, `${branchName}:${branchName}`]);
        await runGitAsync(projectRoot, ["worktree", "add", worktreeDir, branchName]);
        // Set up tracking for the branch
        // Use git config directly — `git branch --set-upstream-to` requires
        // the remote tracking ref to exist locally, which may not be the case
        // in shallow clones where we only fetched the branch itself
        await runGitAsync(projectRoot, ["config", `branch.${branchName}.remote`, remoteName]);
        await runGitAsync(projectRoot, [
          "config",
          `branch.${branchName}.merge`,
          `refs/heads/${branchName}`,
        ]);
        result.createdFromRemote = true;
      } else if (!status.branchExists) {
        // AC: @shadow-init-remote ac-2 ac-3 - No remote branch or no remote - create orphan branch
        // AC: @config-shadow ac-1 — use configured branch name
        // AC: @config-shadow ac-10 — fallback for git < 2.42
        if (gitSupportsOrphanWorktree(projectRoot)) {
          await runGitAsync(projectRoot, [
            "worktree",
            "add",
            "--orphan",
            "-b",
            branchName,
            worktreeDir,
          ]);
        } else {
          await createOrphanBranchFallback(projectRoot, branchName, directoryName);
        }
        result.branchCreated = true;
      } else {
        // Attach to existing local branch.
        // AC: @worktree-support ac-shadow-ops-scoped-to-main — absolute path.
        await runGitAsync(projectRoot, ["worktree", "add", worktreeDir, branchName]);
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
        (f) => f.endsWith(".yaml") && !f.includes(".tasks.") && !f.includes(".inbox."),
      );
      if (!hasManifest) {
        throw new Error("No manifest found");
      }
    } catch {
      // Manifest doesn't exist, create initial structure
      await fs.mkdir(modulesDir, { recursive: true });
      const defaultModuleUlid = ulid();
      await fs.writeFile(
        manifestPath,
        generateShadowManifest(projectName, defaultModuleUlid),
        "utf-8",
      );
      await fs.writeFile(
        moduleFilePath,
        generateShadowModule(projectName, defaultModuleUlid),
        "utf-8",
      );
      await fs.writeFile(tasksPath, generateShadowTasks(projectName), "utf-8");
      await fs.writeFile(inboxPath, generateShadowInbox(), "utf-8");

      // AC: @artifacts-directory ac-init-creates, ac-gitignore-entry
      const artifactsDir = path.join(worktreeDir, "artifacts");
      await fs.mkdir(artifactsDir, { recursive: true });
      // AC: @session-legacy-migration ac-shadow-gitignore — sessions/ not tracked on kspec-meta
      await fs.writeFile(
        path.join(worktreeDir, ".gitignore"),
        "# Ephemeral artifacts - reports, exports, generated files\n# Not tracked in shadow branch\nartifacts/\n\n# Sessions stored in .kspec-sessions/ at project root, not on shadow branch\nsessions/\n",
        "utf-8",
      );

      filesCreated = true;
    }

    // Step 4: Initial commit if files were created
    if (filesCreated) {
      result.initialCommit = await shadowAutoCommit(worktreeDir, `Initialize ${projectName} spec`);
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

    // Step 8: Initialize session branch worktree if sessions.storage is "branch"
    // AC: @session-branch-worktree ac-init
    if (options.sessions?.storage === "branch") {
      const { initializeSessionBranch } = await import("./session-branch.js");
      const sessionBranchName = options.sessions.branch || "kspec-sessions";
      const sessionResult = await initializeSessionBranch(projectRoot, sessionBranchName);
      if (sessionResult.success) {
        result.sessionBranchCreated = true;
      }
      // Non-fatal: session branch failure doesn't block shadow init
    }

    await discardStashedWorktreeDir(stashedWorktreeDir);
    result.success = true;
    return result;
  } catch (error) {
    // AC: @broken-shadow-safety ac-restore-failure-reports-state
    result.error = await restoreStashedWorktreeDirAfterFailure(
      stashedWorktreeDir,
      worktreeDir,
      error,
    );
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
  // AC: @worktree-support ac-shadow-ops-scoped-to-main — defense-in-depth.
  // Refuse to repair shadow state when projectRoot is a linked worktree.
  try {
    assertMainWorkingTree(projectRoot);
  } catch (err) {
    if (err instanceof ShadowError) {
      return {
        success: false,
        branchCreated: false,
        worktreeCreated: false,
        gitignoreUpdated: false,
        initialCommit: false,
        alreadyExists: false,
        createdFromRemote: false,
        pushedToRemote: false,
        error: err.message,
      };
    }
    throw err;
  }

  const branchName = getBranchName(options);
  const directoryName = getDirectoryName(options);
  const status = await getShadowStatus(projectRoot, options);
  const remoteQueryTarget = getRemoteQueryTarget(options);
  const remoteHasShadow = await remoteShadowBranchExists(projectRoot, options);

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

  if (!status.branchExists && !remoteHasShadow) {
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

  // The branch exists locally or remotely, but the worktree is broken - repair it.
  const worktreeDir = path.join(projectRoot, directoryName);
  let stashedWorktreeDir: string | null = null;

  try {
    // Remove stale worktree reference.
    // AC: @worktree-support ac-shadow-ops-scoped-to-main — pass absolute path.
    try {
      await runGitAsync(projectRoot, ["worktree", "remove", worktreeDir, "--force"]);
    } catch {
      // Ignore - worktree may not be in git's list
    }

    // Remove directory if exists (handles corrupted .git file case)
    stashedWorktreeDir = await stashBrokenWorktreeDir(worktreeDir);

    // Prune stale worktree references (cleans up orphaned entries)
    try {
      await runGitAsync(projectRoot, ["worktree", "prune"]);
    } catch {
      // Ignore - prune is best-effort
    }

    if (!status.branchExists && remoteHasShadow) {
      await runGitAsync(projectRoot, ["fetch", remoteQueryTarget, `${branchName}:${branchName}`]);
    }

    // Recreate worktree.
    // AC: @worktree-support ac-shadow-ops-scoped-to-main — absolute path.
    await runGitAsync(projectRoot, ["worktree", "add", worktreeDir, branchName]);

    if (remoteHasShadow) {
      const tracking = await ensureRemoteTracking(worktreeDir, projectRoot, options);
      if (!tracking.success) {
        throw new Error(tracking.guidance || "Failed to configure shadow branch remote tracking");
      }
    }

    await discardStashedWorktreeDir(stashedWorktreeDir);

    // Install pre-commit hook
    await installShadowHook(projectRoot);

    // AC: @artifacts-directory ac-repair-recreates
    const artifactsDir = path.join(worktreeDir, "artifacts");
    await fs.mkdir(artifactsDir, { recursive: true });

    return {
      success: true,
      branchCreated: false,
      worktreeCreated: true,
      gitignoreUpdated: false,
      initialCommit: false,
      alreadyExists: false,
      createdFromRemote: !status.branchExists && remoteHasShadow,
      pushedToRemote: false,
    };
  } catch (error) {
    // AC: @broken-shadow-safety ac-restore-failure-reports-state
    return {
      success: false,
      branchCreated: false,
      worktreeCreated: false,
      gitignoreUpdated: false,
      initialCommit: false,
      alreadyExists: false,
      createdFromRemote: false,
      pushedToRemote: false,
      error: await restoreStashedWorktreeDirAfterFailure(stashedWorktreeDir, worktreeDir, error),
    };
  }
}
