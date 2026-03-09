/**
 * Session branch worktree management.
 *
 * When sessions.storage is "branch", sessions are stored in a git worktree
 * on a named orphan branch (default: "kspec-sessions") at .kspec-sessions/.
 * This provides git-tracked session persistence independent of kspec-meta.
 *
 * AC: @session-branch-worktree — all ACs
 */

import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  branchExists,
  gitSupportsOrphanWorktree,
  createOrphanBranchFallback,
  isGitRepo,
  isValidWorktree,
  hasRemoteTracking,
  SESSIONS_WORKTREE_DIR,
  type ShadowSyncResult,
  type ShadowOptions,
} from "./shadow.js";
import { isBatchMode } from "../cli/batch-context.js";

const execFileAsync = promisify(execFile);

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default session branch name */
export const SESSION_BRANCH_NAME = "kspec-sessions";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Configuration for session branch mode */
export interface SessionBranchConfig {
  /** Whether session branch mode is enabled */
  enabled: boolean;
  /** Path to .kspec-sessions/ worktree directory */
  worktreeDir: string;
  /** Session branch name (default: kspec-sessions) */
  branchName: string;
  /** Project root */
  projectRoot: string;
}

/** Status of the session branch worktree */
export interface SessionBranchStatus {
  exists: boolean;
  healthy: boolean;
  branchExists: boolean;
  worktreeExists: boolean;
  worktreeLinked: boolean;
  error?: string;
}

/** Result from session branch initialization */
export interface SessionBranchInitResult {
  success: boolean;
  branchCreated: boolean;
  worktreeCreated: boolean;
  alreadyExists: boolean;
  error?: string;
}

// ─── Git Helpers ────────────────────────────────────────────────────────────

async function runGitAsync(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout = "", stderr = "" } = await execFileAsync("git", args, {
    cwd,
    env,
    encoding: "utf-8",
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

function isDebugMode(): boolean {
  return process.env.KSPEC_DEBUG === "1" || process.env.KSPEC_DEBUG === "true";
}

/**
 * Resolve the remote name for a branch from git config.
 * Falls back to "origin" if no tracking is configured.
 *
 * AC: @session-branch-worktree ac-sync — resolve configured remote instead of hardcoding "origin"
 */
async function resolveRemoteName(
  cwd: string,
  branchName: string,
): Promise<string> {
  try {
    const { stdout } = await runGitAsync(cwd, [
      "config",
      `branch.${branchName}.remote`,
    ]);
    const configured = stdout.trim();
    if (configured) {
      return configured;
    }
  } catch {
    // No tracking configured
  }
  return "origin";
}

// ─── Session Branch Status ──────────────────────────────────────────────────

/**
 * Get the status of the session branch worktree.
 *
 * AC: @session-branch-worktree ac-status
 */
export async function getSessionBranchStatus(
  projectRoot: string,
  branchName: string = SESSION_BRANCH_NAME,
): Promise<SessionBranchStatus> {
  const worktreeDir = path.join(projectRoot, SESSIONS_WORKTREE_DIR);

  const status: SessionBranchStatus = {
    exists: false,
    healthy: false,
    branchExists: false,
    worktreeExists: false,
    worktreeLinked: false,
  };

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
      status.error = "Session branch missing but worktree exists";
    } else if (!status.worktreeExists) {
      status.error = "Session branch exists but worktree missing";
    } else if (!status.worktreeLinked) {
      status.error = "Session worktree exists but not properly linked";
    }
  }

  return status;
}

// ─── Session Branch Init ────────────────────────────────────────────────────

/**
 * Initialize session branch worktree.
 * Creates an orphan branch and worktree at .kspec-sessions/.
 *
 * AC: @session-branch-worktree ac-init
 */
export async function initializeSessionBranch(
  projectRoot: string,
  branchName: string = SESSION_BRANCH_NAME,
): Promise<SessionBranchInitResult> {
  const result: SessionBranchInitResult = {
    success: false,
    branchCreated: false,
    worktreeCreated: false,
    alreadyExists: false,
  };

  if (!(await isGitRepo(projectRoot))) {
    result.error = "Not a git repository";
    return result;
  }

  const directoryName = SESSIONS_WORKTREE_DIR;
  const worktreeDir = path.join(projectRoot, directoryName);

  // Check current status
  const status = await getSessionBranchStatus(projectRoot, branchName);

  if (status.healthy) {
    result.alreadyExists = true;
    result.success = true;
    return result;
  }

  try {
    // Resolve remote name from git config instead of hardcoding "origin"
    // AC: @session-branch-worktree ac-sync
    const remoteName = await resolveRemoteName(projectRoot, branchName);
    let remoteHasBranch = false;
    try {
      const { stdout } = await runGitAsync(projectRoot, [
        "remote",
        "get-url",
        remoteName,
      ]);
      if (stdout.trim().length > 0) {
        const { stdout: lsOut } = await runGitAsync(projectRoot, [
          "ls-remote",
          "--heads",
          remoteName,
          branchName,
        ]);
        remoteHasBranch = lsOut.trim().length > 0;
      }
    } catch {
      // No remote configured
    }

    // Remove existing worktree/directory if broken
    if (status.worktreeExists && !status.worktreeLinked) {
      await fs.rm(worktreeDir, { recursive: true, force: true });
    }

    // Remove stale worktree reference
    try {
      await runGitAsync(projectRoot, [
        "worktree",
        "remove",
        directoryName,
        "--force",
      ]);
    } catch {
      // Ignore
    }

    // Prune stale worktree references
    try {
      await runGitAsync(projectRoot, ["worktree", "prune"]);
    } catch {
      // Ignore
    }

    if (remoteHasBranch) {
      // Fetch from remote and create worktree
      await runGitAsync(projectRoot, [
        "fetch",
        remoteName,
        `${branchName}:${branchName}`,
      ]);
      await runGitAsync(projectRoot, [
        "worktree",
        "add",
        directoryName,
        branchName,
      ]);
      // Set up tracking
      await runGitAsync(projectRoot, [
        "config",
        `branch.${branchName}.remote`,
        remoteName,
      ]);
      await runGitAsync(projectRoot, [
        "config",
        `branch.${branchName}.merge`,
        `refs/heads/${branchName}`,
      ]);
    } else if (!status.branchExists) {
      // Create orphan branch
      if (gitSupportsOrphanWorktree(projectRoot)) {
        await runGitAsync(projectRoot, [
          "worktree",
          "add",
          "--orphan",
          "-b",
          branchName,
          directoryName,
        ]);
      } else {
        await createOrphanBranchFallback(
          projectRoot,
          branchName,
          directoryName,
        );
      }
      result.branchCreated = true;

      // Create initial empty commit so the branch is valid
      await runGitAsync(worktreeDir, ["add", "-A"], {
        ...process.env,
        KSPEC_SHADOW_COMMIT: "1",
      });
      // Create a .gitkeep so the first commit has content
      await fs.writeFile(
        path.join(worktreeDir, ".gitkeep"),
        "# Session storage - managed by kspec\n",
        "utf-8",
      );
      await runGitAsync(worktreeDir, ["add", "-A"], {
        ...process.env,
        KSPEC_SHADOW_COMMIT: "1",
      });
      await runGitAsync(
        worktreeDir,
        ["commit", "-m", "Initialize session storage"],
        { ...process.env, KSPEC_SHADOW_COMMIT: "1" },
      );

      // Push to remote if available
      try {
        const { stdout } = await runGitAsync(projectRoot, [
          "remote",
          "get-url",
          remoteName,
        ]);
        if (stdout.trim().length > 0) {
          await runGitAsync(worktreeDir, [
            "push",
            "-u",
            remoteName,
            branchName,
          ]);
        }
      } catch {
        // No remote, fine
      }
    } else {
      // Attach to existing local branch
      await runGitAsync(projectRoot, [
        "worktree",
        "add",
        directoryName,
        branchName,
      ]);
    }

    result.worktreeCreated = true;
    result.success = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}

// ─── Session Branch Repair ──────────────────────────────────────────────────

/**
 * Repair a broken session branch worktree.
 *
 * AC: @session-branch-worktree ac-repair
 */
export async function repairSessionBranch(
  projectRoot: string,
  branchName: string = SESSION_BRANCH_NAME,
): Promise<SessionBranchInitResult> {
  const status = await getSessionBranchStatus(projectRoot, branchName);

  if (status.healthy) {
    return {
      success: true,
      branchCreated: false,
      worktreeCreated: false,
      alreadyExists: true,
    };
  }

  if (!status.branchExists) {
    return {
      success: false,
      branchCreated: false,
      worktreeCreated: false,
      alreadyExists: false,
      error:
        "Session branch does not exist. Run `kspec init` or `kspec setup` with sessions.storage=branch to initialize.",
    };
  }

  const directoryName = SESSIONS_WORKTREE_DIR;
  const worktreeDir = path.join(projectRoot, directoryName);

  try {
    // Remove stale worktree reference
    try {
      await runGitAsync(projectRoot, [
        "worktree",
        "remove",
        directoryName,
        "--force",
      ]);
    } catch {
      // Ignore
    }

    // Remove directory if exists
    await fs.rm(worktreeDir, { recursive: true, force: true });

    // Prune stale worktree references
    try {
      await runGitAsync(projectRoot, ["worktree", "prune"]);
    } catch {
      // Ignore
    }

    // Recreate worktree
    await runGitAsync(projectRoot, [
      "worktree",
      "add",
      directoryName,
      branchName,
    ]);

    return {
      success: true,
      branchCreated: false,
      worktreeCreated: true,
      alreadyExists: false,
    };
  } catch (error) {
    return {
      success: false,
      branchCreated: false,
      worktreeCreated: false,
      alreadyExists: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Session Branch Auto-Commit ─────────────────────────────────────────────

/**
 * Auto-commit changes to the session branch.
 * Called at session lifecycle boundaries (create, close, stale cleanup, compact).
 *
 * AC: @session-branch-worktree ac-commit-boundaries
 */
export async function sessionBranchAutoCommit(
  worktreeDir: string,
  message: string,
): Promise<boolean> {
  const debug = isDebugMode();

  try {
    if (debug) {
      console.error(
        `[DEBUG] Session branch auto-commit: git add -A (cwd: ${worktreeDir})`,
      );
    }

    // Stage all changes
    const addResult = spawnSync("git", ["add", "-A"], {
      cwd: worktreeDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (addResult.error || addResult.status !== 0) {
      throw new Error(addResult.stderr || "git add failed");
    }

    // Check if there are staged changes
    const diffResult = spawnSync(
      "git",
      ["diff", "--cached", "--quiet"],
      {
        cwd: worktreeDir,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      },
    );
    if (!diffResult.error && diffResult.status === 0) {
      // No changes
      if (debug) {
        console.error(
          `[DEBUG] Session branch auto-commit: No changes to commit`,
        );
      }
      return false;
    }

    if (debug) {
      console.error(
        `[DEBUG] Session branch auto-commit: git commit -m "${message}"`,
      );
    }

    // Commit with KSPEC_SHADOW_COMMIT=1 to authorize past git hooks
    const commitResult = spawnSync("git", ["commit", "-m", message], {
      cwd: worktreeDir,
      env: { ...process.env, KSPEC_SHADOW_COMMIT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (commitResult.error || commitResult.status !== 0) {
      throw new Error(commitResult.stderr || "git commit failed");
    }

    if (debug) {
      console.error(`[DEBUG] Session branch auto-commit: Success`);
    }

    return true;
  } catch (error) {
    if (debug) {
      console.error("Session branch auto-commit failed:", error);
    }
    return false;
  }
}

/**
 * Commit session changes if session branch mode is enabled.
 * Respects batch mode (suppresses commits during atomic batch execution).
 *
 * AC: @session-branch-worktree ac-commit-boundaries
 */
export async function commitIfSessionBranch(
  config: SessionBranchConfig | null,
  operation: string,
  sessionId?: string,
): Promise<boolean> {
  // Suppress auto-commits during atomic batch execution
  if (isBatchMode()) {
    return false;
  }

  if (!config?.enabled) {
    return false;
  }

  const message = sessionId
    ? `session: ${operation} (${sessionId})`
    : `session: ${operation}`;

  return sessionBranchAutoCommit(config.worktreeDir, message);
}

// ─── Session Branch Sync ────────────────────────────────────────────────────

/**
 * In-flight dedup for session branch pulls.
 *
 * AC: @session-branch-worktree ac-sync
 */
const sessionPullInflight = new Map<string, Promise<ShadowSyncResult>>();

/**
 * Pull remote changes for the session branch.
 * Uses in-flight dedup to prevent concurrent pulls.
 *
 * AC: @session-branch-worktree ac-sync
 */
export function sessionBranchPull(
  worktreeDir: string,
  branchName: string = SESSION_BRANCH_NAME,
): Promise<ShadowSyncResult> {
  const key = path.resolve(worktreeDir);
  const existing = sessionPullInflight.get(key);
  if (existing) {
    return existing;
  }
  const promise = sessionBranchPullImpl(worktreeDir, branchName).finally(() => {
    sessionPullInflight.delete(key);
  });
  sessionPullInflight.set(key, promise);
  return promise;
}

async function sessionBranchPullImpl(
  worktreeDir: string,
  branchName: string,
): Promise<ShadowSyncResult> {
  const result: ShadowSyncResult = {
    success: false,
    pulled: false,
    pushed: false,
    hadConflict: false,
  };

  // Check if remote tracking is configured
  const options: ShadowOptions = { branchName };
  if (!(await hasRemoteTracking(worktreeDir, options))) {
    result.success = true;
    return result;
  }

  // Resolve configured remote instead of hardcoding "origin"
  // AC: @session-branch-worktree ac-sync
  const projectRoot = path.dirname(worktreeDir);
  const remoteName = await resolveRemoteName(projectRoot, branchName);

  // Fetch
  try {
    await runGitAsync(projectRoot, ["fetch", remoteName]);
  } catch {
    result.success = true;
    return result;
  }

  // Check if remote branch exists
  try {
    const { stdout } = await runGitAsync(projectRoot, [
      "ls-remote",
      "--heads",
      remoteName,
      branchName,
    ]);
    if (stdout.trim().length === 0) {
      result.success = true;
      return result;
    }
  } catch {
    result.success = true;
    return result;
  }

  // Stash uncommitted changes
  let stashed = false;
  try {
    const { stdout } = await runGitAsync(worktreeDir, [
      "stash",
      "push",
      "-m",
      "session-sync-auto",
    ]);
    stashed = !stdout.includes("No local changes");
  } catch {
    result.success = true;
    return result;
  }

  const unstash = async () => {
    if (stashed) {
      try {
        await runGitAsync(worktreeDir, ["stash", "pop"]);
      } catch {
        // Leave stash intact if pop fails
      }
    }
  };

  try {
    // Try fast-forward
    await runGitAsync(worktreeDir, ["pull", "--ff-only"]);
    await unstash();
    result.success = true;
    result.pulled = true;
    return result;
  } catch {
    // Fast-forward failed
  }

  try {
    // Fall back to rebase
    await runGitAsync(worktreeDir, ["pull", "--rebase"]);
    await unstash();
    result.success = true;
    result.pulled = true;
    return result;
  } catch {
    // Rebase failed
  }

  // Abort rebase if in progress
  try {
    await runGitAsync(worktreeDir, ["rebase", "--abort"]);
  } catch {
    // May not be in rebase state
  }

  await unstash();
  result.hadConflict = true;
  result.error =
    "Session branch sync conflict detected. Run `kspec shadow resolve` to fix.";
  return result;
}

/**
 * Resolve session branch config from manifest.
 * Returns null if sessions.storage is not "branch".
 */
export function resolveSessionBranchConfig(
  projectRoot: string,
  manifest: { sessions?: { storage?: string; branch?: string } } | null,
): SessionBranchConfig | null {
  const storage = manifest?.sessions?.storage ?? "local";
  if (storage !== "branch") {
    return null;
  }

  const branchName = manifest?.sessions?.branch ?? SESSION_BRANCH_NAME;
  return {
    enabled: true,
    worktreeDir: path.join(projectRoot, SESSIONS_WORKTREE_DIR),
    branchName,
    projectRoot,
  };
}
