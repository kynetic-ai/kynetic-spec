/**
 * Tests for worktree-aware submission linkage capture.
 *
 * Verifies that captureSubmissionLinkage records git context from the
 * active code checkout (worktree) rather than the main repository
 * working tree.
 *
 * AC: @portable-task-submission-linkage ac-worktree-branch, ac-worktree-branch-isolation,
 *     ac-worktree-commit, ac-worktree-remote
 */

import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { captureSubmissionLinkage } from "../src/utils/git.js";
import { cleanupTempDir, createTempDir, initGitRepo } from "./helpers/cli.js";

const cleanupDirs: string[] = [];

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

/**
 * Set up a main repo with a linked worktree on a different branch.
 * Main repo stays on mainBranch; worktree checks out worktreeBranch.
 */
async function setupWorktreeEnvironment(opts?: {
  mainBranch?: string;
  worktreeBranch?: string;
}): Promise<{
  mainDir: string;
  worktreeDir: string;
  mainBranch: string;
  worktreeBranch: string;
}> {
  const mainBranch = opts?.mainBranch ?? "main";
  const worktreeBranch = opts?.worktreeBranch ?? "feat/worktree-task";

  const mainDir = await createTempDir("kspec-linkage-wt-main-");
  cleanupDirs.push(mainDir);
  initGitRepo(mainDir);
  git(mainDir, 'commit --allow-empty -m "init"');

  // Create the worktree branch from main and add a commit
  git(mainDir, `checkout -b ${worktreeBranch}`);
  git(mainDir, `commit --allow-empty -m "worktree work"`);

  // Go back to main so the worktree can check out the branch
  git(mainDir, `checkout ${mainBranch}`);

  const worktreeBase = await createTempDir("kspec-linkage-wt-code-");
  cleanupDirs.push(worktreeBase);
  const worktreeDir = path.join(worktreeBase, "wt");
  git(mainDir, `worktree add "${worktreeDir}" ${worktreeBranch}`);

  return { mainDir, worktreeDir, mainBranch, worktreeBranch };
}

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await cleanupTempDir(dir);
    }
  }
});

describe("captureSubmissionLinkage from git worktree", () => {
  // AC: @portable-task-submission-linkage ac-worktree-branch
  it("records the worktree's checked-out branch, not the main checkout's branch", async () => {
    const { mainDir, worktreeDir, worktreeBranch, mainBranch } =
      await setupWorktreeEnvironment();

    // Verify the main repo is on a different branch
    expect(git(mainDir, "branch --show-current")).toBe(mainBranch);

    const linkage = captureSubmissionLinkage(worktreeDir);
    expect(linkage).not.toBeNull();
    expect(linkage!.branch).toBe(worktreeBranch);
    expect(linkage!.branch).not.toBe(mainBranch);
  });

  // AC: @portable-task-submission-linkage ac-worktree-branch-isolation
  it("is not affected by the main repository working tree's checked-out branch", async () => {
    const { mainDir, worktreeDir, worktreeBranch } = await setupWorktreeEnvironment({
      worktreeBranch: "feat/isolated-task",
    });

    // Switch the main repo to yet another branch
    git(mainDir, "checkout -b dev");
    git(mainDir, 'commit --allow-empty -m "dev work"');

    // Capture from the worktree — should still get the worktree branch
    const linkage = captureSubmissionLinkage(worktreeDir);
    expect(linkage).not.toBeNull();
    expect(linkage!.branch).toBe("feat/isolated-task");
    expect(linkage!.branch).not.toBe("dev");
    expect(linkage!.branch).not.toBe("main");
  });

  // AC: @portable-task-submission-linkage ac-worktree-commit
  it("records the worktree's HEAD commit, not the main checkout's HEAD", async () => {
    const { mainDir, worktreeDir } = await setupWorktreeEnvironment();

    // Add a commit only in the worktree
    git(worktreeDir, 'commit --allow-empty -m "worktree-only commit"');
    const worktreeHead = git(worktreeDir, "rev-parse HEAD");
    const mainHead = git(mainDir, "rev-parse HEAD");

    // Verify the commits are different
    expect(worktreeHead).not.toBe(mainHead);

    const linkage = captureSubmissionLinkage(worktreeDir);
    expect(linkage).not.toBeNull();
    expect(linkage!.commit).toBe(worktreeHead);
    expect(linkage!.commit).not.toBe(mainHead);
  });

  // AC: @portable-task-submission-linkage ac-worktree-remote
  it("records the worktree branch's tracking configuration", async () => {
    const mainDir = await createTempDir("kspec-linkage-wt-remote-main-");
    cleanupDirs.push(mainDir);
    initGitRepo(mainDir);
    git(mainDir, 'commit --allow-empty -m "init"');

    // Create a bare remote
    const bareDir = `${mainDir}-bare`;
    cleanupDirs.push(bareDir);
    execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });
    git(mainDir, `remote add origin "${bareDir}"`);
    git(mainDir, "push origin main");

    // Create and push the worktree branch with upstream tracking
    git(mainDir, "checkout -b feat/tracked-task");
    git(mainDir, 'commit --allow-empty -m "tracked work"');
    git(mainDir, "push -u origin feat/tracked-task");

    // Go back to main
    git(mainDir, "checkout main");

    // Create worktree
    const worktreeBase = await createTempDir("kspec-linkage-wt-remote-code-");
    cleanupDirs.push(worktreeBase);
    const worktreeDir = path.join(worktreeBase, "wt");
    git(mainDir, `worktree add "${worktreeDir}" feat/tracked-task`);

    const linkage = captureSubmissionLinkage(worktreeDir);
    expect(linkage).not.toBeNull();
    expect(linkage!.branch).toBe("feat/tracked-task");
    expect(linkage!.remote).toBe("origin");
    expect(linkage!.remote_url).toContain(bareDir);
    expect(linkage!.upstream_ref).toBe("refs/heads/feat/tracked-task");
  });

  // AC: @portable-task-submission-linkage ac-worktree-remote
  it("records null remote when the worktree branch has no upstream tracking", async () => {
    const { worktreeDir } = await setupWorktreeEnvironment();

    // No remote configured — linkage should still work with null remote
    const linkage = captureSubmissionLinkage(worktreeDir);
    expect(linkage).not.toBeNull();
    expect(linkage!.remote).toBeNull();
    expect(linkage!.remote_url).toBeNull();
    expect(linkage!.upstream_ref).toBeNull();
  });

  // AC: @trait-error-guidance ac-1 — N/A: captureSubmissionLinkage is best-effort, returns null on error
  // AC: @trait-error-guidance ac-2 — N/A: no user-facing errors from linkage capture
  // AC: @trait-error-guidance ac-3 — N/A: linkage capture does not do ref lookups
  // AC: @trait-error-guidance ac-4 — N/A: linkage capture does not introduce state transitions
  // AC: @trait-error-guidance ac-5 — N/A: linkage validation handled by Zod schema
  // AC: @trait-error-guidance ac-6 — N/A: linkage errors covered by existing JSON error handling
});
