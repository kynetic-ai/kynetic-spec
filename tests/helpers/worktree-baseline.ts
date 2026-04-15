/**
 * Helpers for asserting that a main working tree's shadow worktree is
 * unchanged after a shadow-lifecycle command runs from elsewhere.
 *
 * Used by the regression tests that close the shadow-worktree
 * cross-contamination guard ACs on @worktree-support.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ShadowBaseline {
  /** Full output of `git worktree list --porcelain` run from mainRoot */
  worktreeListPorcelain: string;
  /**
   * SHA of the shadow branch tip (kspec-meta by default) or null if the
   * branch does not exist in this repo.
   */
  shadowBranchSha: string | null;
  /** Raw content of .kspec/.git, or null if the file does not exist */
  dotGitPointer: string | null;
  /** mtime of .kspec/ as a millisecond timestamp, or null if it doesn't exist */
  dirMtimeMs: number | null;
  /** inode of .kspec/, or null if it doesn't exist */
  dirInode: number | null;
  /** Existence flag — helps distinguish "missing" from "changed" in assertions */
  dirExists: boolean;
}

/**
 * Capture a baseline snapshot of the shadow worktree state rooted at mainRoot.
 *
 * Records four independent signals so that assertions detect:
 *   - worktree admin entry changes (worktreeListPorcelain)
 *   - shadow branch tip changes (shadowBranchSha)
 *   - .git gitdir pointer rewrites (dotGitPointer)
 *   - directory re-creation that a naive existence check would miss
 *     (dirMtimeMs + dirInode)
 */
export function captureShadowBaseline(
  mainRoot: string,
  worktreeDirName: string = ".kspec",
  shadowBranch: string = "kspec-meta",
): ShadowBaseline {
  const shadowDir = path.join(mainRoot, worktreeDirName);

  let worktreeListPorcelain = "";
  try {
    worktreeListPorcelain = execSync("git worktree list --porcelain", {
      cwd: mainRoot,
      encoding: "utf-8",
    });
  } catch {
    worktreeListPorcelain = "";
  }

  let shadowBranchSha: string | null = null;
  try {
    shadowBranchSha = execSync(`git rev-parse ${shadowBranch}`, {
      cwd: mainRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    shadowBranchSha = null;
  }

  let dotGitPointer: string | null = null;
  try {
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- reading the test-generated .kspec/.git worktree pointer to detect silent mutation by a concurrent command; this is test state, not source code.
    dotGitPointer = fs.readFileSync(path.join(shadowDir, ".git"), "utf-8");
  } catch {
    dotGitPointer = null;
  }

  let dirMtimeMs: number | null = null;
  let dirInode: number | null = null;
  let dirExists = false;
  try {
    const stat = fs.statSync(shadowDir);
    dirExists = true;
    dirMtimeMs = stat.mtimeMs;
    dirInode = stat.ino;
  } catch {
    dirExists = false;
  }

  return {
    worktreeListPorcelain,
    shadowBranchSha,
    dotGitPointer,
    dirMtimeMs,
    dirInode,
    dirExists,
  };
}

/**
 * Assert two baselines are byte-for-byte equivalent for the fields that
 * would be disturbed by a destructive shadow-lifecycle command.
 *
 * The test failure message identifies which individual signal diverged.
 */
export function assertShadowUnchanged(
  before: ShadowBaseline,
  after: ShadowBaseline,
  context: string = "shadow baseline",
): void {
  const diffs: string[] = [];
  if (before.dirExists !== after.dirExists) {
    diffs.push(`dirExists changed: ${before.dirExists} -> ${after.dirExists}`);
  }
  if (before.worktreeListPorcelain !== after.worktreeListPorcelain) {
    diffs.push(
      `git worktree list --porcelain changed:\nBEFORE:\n${before.worktreeListPorcelain}\nAFTER:\n${after.worktreeListPorcelain}`,
    );
  }
  if (before.shadowBranchSha !== after.shadowBranchSha) {
    diffs.push(
      `shadow branch SHA changed: ${before.shadowBranchSha} -> ${after.shadowBranchSha}`,
    );
  }
  if (before.dotGitPointer !== after.dotGitPointer) {
    diffs.push(
      `.kspec/.git pointer changed:\nBEFORE: ${before.dotGitPointer}\nAFTER:  ${after.dotGitPointer}`,
    );
  }
  if (before.dirInode !== after.dirInode) {
    diffs.push(`.kspec/ inode changed: ${before.dirInode} -> ${after.dirInode}`);
  }
  if (before.dirMtimeMs !== after.dirMtimeMs) {
    diffs.push(
      `.kspec/ mtime changed: ${before.dirMtimeMs} -> ${after.dirMtimeMs}`,
    );
  }

  if (diffs.length > 0) {
    throw new Error(`${context} — shadow state mutated:\n${diffs.join("\n\n")}`);
  }
}

/**
 * Create a linked git worktree attached to HEAD and return its absolute path.
 *
 * Uses `git worktree add --detach` to avoid needing a separate branch.
 * The caller is responsible for cleanup (via cleanupTempDir on the parent
 * directory that contains both main and linked worktrees).
 */
export function addLinkedWorktree(mainRoot: string, subdir: string): string {
  const linkedPath = path.join(mainRoot, subdir);
  execSync(`git worktree add --detach ${subdir}`, {
    cwd: mainRoot,
    stdio: "pipe",
  });
  return linkedPath;
}
