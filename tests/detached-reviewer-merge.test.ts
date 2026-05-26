/**
 * Tests for the detached reviewer merge helper script.
 *
 * Simulates the dispatch reviewer environment: a detached HEAD worktree
 * (reviewer snapshot) that runs the merge helper. The helper performs the
 * merge in a helper-owned temporary target worktree it creates and removes
 * itself; it does not require the integration target branch to be checked
 * out anywhere ahead of time.
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTestSubprocessEnv,
  cleanupTempDir,
  createTempDir,
  initGitRepo,
} from "./helpers/cli.js";

const SCRIPT_PATH = path.resolve(
  __dirname,
  "..",
  "templates",
  "skills",
  "merge",
  "scripts",
  "detached-reviewer-merge.sh",
);

const cleanupDirs: string[] = [];

interface MergeTestEnv {
  /** Main repo root where branches live. */
  projectDir: string;
  /**
   * Pre-existing non-helper worktree that has the integration target branch
   * checked out. Only created when `setupMergeTestEnv({ checkoutTarget: true })`.
   */
  integrationWorktreeDir: string | null;
  /** Detached HEAD worktree simulating the reviewer snapshot. */
  reviewerWorktreeDir: string;
  /** The canonical (task) branch name. */
  canonicalBranch: string;
  /** The pinned canonical head commit SHA (reviewed snapshot). */
  canonicalHead: string;
  /** The integration target branch name. */
  mergeTarget: string;
  /** Shared scratch dir for additional worktrees. */
  worktreeBase: string;
}

/**
 * Set up a test environment that mimics dispatch reviewer context:
 *
 * 1. A main git repo with an initial commit on "main"
 * 2. A "dev" branch (integration target) — by default NOT checked out anywhere
 * 3. A canonical task branch with a diverging commit
 * 4. A detached HEAD worktree at the canonical branch tip (reviewer snapshot)
 *
 * Pass `checkoutTarget: true` to additionally check out the integration
 * target branch in a separate worktree (simulating a pre-existing
 * non-helper checkout that the helper must refuse to disturb).
 */
async function setupMergeTestEnv(
  options: { checkoutTarget?: boolean } = {},
): Promise<MergeTestEnv> {
  const projectDir = await createTempDir("kspec-merge-helper-");
  cleanupDirs.push(projectDir);

  initGitRepo(projectDir);
  execSync('git commit --allow-empty -m "initial commit"', {
    cwd: projectDir,
    stdio: "pipe",
  });

  execSync("git branch dev", { cwd: projectDir, stdio: "pipe" });

  const canonicalBranch = "dispatch/task/test-task/01ABC123";
  execSync(`git checkout -b "${canonicalBranch}"`, {
    cwd: projectDir,
    stdio: "pipe",
  });
  await fs.writeFile(path.join(projectDir, "feature.txt"), "feature content\n");
  execSync("git add feature.txt", { cwd: projectDir, stdio: "pipe" });
  execSync('git commit -m "feat: add feature"', {
    cwd: projectDir,
    stdio: "pipe",
  });

  const canonicalHead = execSync(`git rev-parse HEAD`, {
    cwd: projectDir,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

  execSync("git checkout main", { cwd: projectDir, stdio: "pipe" });

  const worktreeBase = await createTempDir("kspec-merge-wt-");
  cleanupDirs.push(worktreeBase);

  let integrationWorktreeDir: string | null = null;
  if (options.checkoutTarget) {
    integrationWorktreeDir = path.join(worktreeBase, "dev-wt");
    execSync(`git worktree add "${integrationWorktreeDir}" dev`, {
      cwd: projectDir,
      stdio: "pipe",
    });
  }

  const reviewerWorktreeDir = path.join(worktreeBase, "reviewer-wt");
  execSync(`git worktree add --detach "${reviewerWorktreeDir}" "${canonicalBranch}"`, {
    cwd: projectDir,
    stdio: "pipe",
  });

  return {
    projectDir,
    integrationWorktreeDir,
    reviewerWorktreeDir,
    canonicalBranch,
    canonicalHead,
    mergeTarget: "dev",
    worktreeBase,
  };
}

/**
 * Run a callback inside a temporary worktree checked out on the given branch,
 * then remove the worktree before returning. Used by tests to advance the
 * target branch (no-op pre-merge or conflict setup) without leaving the
 * target branch checked out anywhere.
 */
async function withTempBranchWorktree(
  env: MergeTestEnv,
  branch: string,
  cb: (worktreeDir: string) => Promise<void> | void,
): Promise<void> {
  const tempWorktreeDir = path.join(env.worktreeBase, `tmp-${Date.now()}-${Math.random()}`);
  execSync(`git worktree add "${tempWorktreeDir}" "${branch}"`, {
    cwd: env.projectDir,
    stdio: "pipe",
  });
  try {
    await cb(tempWorktreeDir);
  } finally {
    execSync(`git worktree remove --force "${tempWorktreeDir}"`, {
      cwd: env.projectDir,
      stdio: "pipe",
    });
  }
}

/**
 * Build a clean env for the merge helper, stripping all KSPEC_DISPATCH_* vars
 * from the parent process and layering only the explicitly passed vars.
 */
function buildMergeHelperEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const base = buildTestSubprocessEnv(overrides);
  for (const key of Object.keys(base)) {
    if (key.startsWith("KSPEC_DISPATCH_") && !(key in overrides)) {
      delete base[key];
    }
  }
  return base;
}

function runMergeHelper(
  cwd: string,
  env: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bash", [SCRIPT_PATH], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: buildMergeHelperEnv(env),
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

function listTargetWorktrees(env: MergeTestEnv): string[] {
  const output = execSync("git worktree list --porcelain", {
    cwd: env.projectDir,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const targetRef = `refs/heads/${env.mergeTarget}`;
  const results: string[] = [];
  let currentPath = "";
  let currentBranch = "";
  for (const rawLine of output.split("\n")) {
    if (rawLine.startsWith("worktree ")) {
      currentPath = rawLine.slice("worktree ".length);
      currentBranch = "";
    } else if (rawLine.startsWith("branch ")) {
      currentBranch = rawLine.slice("branch ".length);
    } else if (rawLine === "") {
      if (currentBranch === targetRef && currentPath !== "") {
        results.push(currentPath);
      }
      currentPath = "";
      currentBranch = "";
    }
  }
  if (currentBranch === targetRef && currentPath !== "") {
    results.push(currentPath);
  }
  return results;
}

function revParse(repoCwd: string, ref: string): string {
  return execSync(`git rev-parse "${ref}"`, {
    cwd: repoCwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

afterEach(async () => {
  for (const dir of [...cleanupDirs].reverse()) {
    try {
      const output = execSync("git worktree list --porcelain", {
        cwd: dir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          const wtPath = line.slice("worktree ".length);
          if (wtPath !== dir) {
            try {
              execSync(`git worktree remove --force "${wtPath}"`, {
                cwd: dir,
                stdio: "pipe",
              });
            } catch {
              // Worktree may already be cleaned up
            }
          }
        }
      }
    } catch {
      // Not a git repo or already cleaned up
    }
  }
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await cleanupTempDir(dir);
    }
  }
});

describe("detached-reviewer-merge helper", () => {
  describe("ephemeral target worktree merge", () => {
    // AC: @detached-reviewer-merge-helper ac-helper-uses-ephemeral-target-worktree
    // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-target-branch-lock
    it("creates a temporary target worktree, advances the target ref, and removes the worktree on success", async () => {
      const env = await setupMergeTestEnv();

      const targetWorktreesBefore = listTargetWorktrees(env);
      expect(targetWorktreesBefore).toEqual([]);

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("success: merged");
      expect(result.stdout).toContain(env.canonicalBranch);
      expect(result.stdout).toContain(env.mergeTarget);

      // Target ref advanced.
      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).not.toBe(targetHeadBefore);

      // Canonical commit is reachable from the new target tip.
      const isAncestor = execSync(
        `git merge-base --is-ancestor "${env.canonicalHead}" "${targetHeadAfter}" && echo yes || echo no`,
        { cwd: env.projectDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      expect(isAncestor).toBe("yes");

      // The reviewed feature file lives in the target branch tree.
      const featureInTarget = execSync(
        `git show "refs/heads/${env.mergeTarget}:feature.txt"`,
        { cwd: env.projectDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      expect(featureInTarget).toBe("feature content\n");

      // No worktree remains checked out on the target branch.
      const targetWorktreesAfter = listTargetWorktrees(env);
      expect(targetWorktreesAfter).toEqual([]);
    });
  });

  describe("canonical head pinning", () => {
    // AC: @detached-reviewer-merge-helper ac-helper-uses-ephemeral-target-worktree
    it("merges the pinned reviewed commit, not the advanced branch tip", async () => {
      const env = await setupMergeTestEnv();

      // Advance the canonical branch past the reviewed commit.
      execSync(`git checkout "${env.canonicalBranch}"`, {
        cwd: env.projectDir,
        stdio: "pipe",
      });
      await fs.writeFile(path.join(env.projectDir, "unreviewed.txt"), "unreviewed content\n");
      execSync("git add unreviewed.txt", { cwd: env.projectDir, stdio: "pipe" });
      execSync('git commit -m "feat: unreviewed change"', {
        cwd: env.projectDir,
        stdio: "pipe",
      });
      execSync("git checkout main", { cwd: env.projectDir, stdio: "pipe" });

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("success: merged");
      expect(result.stderr).toContain("advanced past the reviewed commit");

      // Reviewed feature file is in the target branch.
      const featureInTarget = execSync(
        `git show "refs/heads/${env.mergeTarget}:feature.txt"`,
        { cwd: env.projectDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      expect(featureInTarget).toBe("feature content\n");

      // Unreviewed change is NOT in the target branch — we merged the pinned commit.
      const showUnreviewed = spawnSync(
        "git",
        ["show", `refs/heads/${env.mergeTarget}:unreviewed.txt`],
        { cwd: env.projectDir, encoding: "utf-8" },
      );
      expect(showUnreviewed.status).not.toBe(0);
    });
  });

  // AC: @detached-reviewer-merge-helper ac-helper-no-op-merge
  // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-target-branch-lock
  describe("no-op merge", () => {
    it("reports no-op when canonical head is already integrated and does not create any target worktree", async () => {
      const env = await setupMergeTestEnv();

      // Pre-integrate the canonical branch into the target via a temporary
      // worktree that is removed before invoking the helper.
      await withTempBranchWorktree(env, env.mergeTarget, (worktreeDir) => {
        execSync(`git merge --no-ff "${env.canonicalBranch}" -m "pre-merge"`, {
          cwd: worktreeDir,
          stdio: "pipe",
        });
      });

      const targetWorktreesBefore = listTargetWorktrees(env);
      expect(targetWorktreesBefore).toEqual([]);

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("no-op");
      expect(result.stdout).toContain("already integrated");

      // Target ref did not move.
      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);

      // No persistent target worktree was created.
      const targetWorktreesAfter = listTargetWorktrees(env);
      expect(targetWorktreesAfter).toEqual([]);
    });

    // AC: @detached-reviewer-merge-helper ac-helper-no-op-merge
    it("reports no-op without dirtying a pre-existing occupied target checkout", async () => {
      const env = await setupMergeTestEnv({ checkoutTarget: true });
      expect(env.integrationWorktreeDir).not.toBeNull();
      const occupied = env.integrationWorktreeDir!;

      // Pre-integrate the canonical branch into the target in the occupied checkout.
      execSync(`git merge --no-ff "${env.canonicalBranch}" -m "pre-merge"`, {
        cwd: occupied,
        stdio: "pipe",
      });

      // Create a harmless untracked file in the occupied checkout so we can
      // verify the helper leaves the worktree untouched.
      await fs.writeFile(path.join(occupied, "untracked.scratch"), "scratch\n");

      const occupiedStatusBefore = execSync("git status --porcelain", {
        cwd: occupied,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("no-op");

      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);

      // Occupied checkout state is unchanged.
      const occupiedStatusAfter = execSync("git status --porcelain", {
        cwd: occupied,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(occupiedStatusAfter).toBe(occupiedStatusBefore);
    });
  });

  // AC: @detached-reviewer-merge-helper ac-helper-occupied-target-refuses-with-free-branch-guidance
  // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-target-branch-lock
  describe("occupied target refusal (clean)", () => {
    it("refuses before moving refs and identifies the blocking worktree with free-branch guidance", async () => {
      const env = await setupMergeTestEnv({ checkoutTarget: true });
      expect(env.integrationWorktreeDir).not.toBeNull();
      const occupied = env.integrationWorktreeDir!;

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      const targetWorktreesBefore = listTargetWorktrees(env);
      expect(targetWorktreesBefore).toEqual([occupied]);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      // Identifies the blocking worktree by path.
      expect(result.stderr).toContain(occupied);
      // Refuses before moving refs.
      expect(result.stderr).toContain("NOT been moved");
      // Guidance to free or detach the existing checkout.
      expect(result.stderr.toLowerCase()).toMatch(/detach|remove/);
      // Does NOT instruct the reviewer to check out the target branch in another worktree.
      expect(result.stderr.toLowerCase()).not.toMatch(/check out .*(in|to)/);

      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);

      // No new auxiliary worktree was added on the target branch.
      const targetWorktreesAfter = listTargetWorktrees(env);
      expect(targetWorktreesAfter).toEqual([occupied]);
    });

    // AC: @detached-reviewer-merge-helper ac-helper-occupied-target-refuses-with-free-branch-guidance
    it("refuses when the occupied target worktree contains only untracked files", async () => {
      const env = await setupMergeTestEnv({ checkoutTarget: true });
      const occupied = env.integrationWorktreeDir!;

      await fs.writeFile(
        path.join(occupied, "scratch.tmp"),
        "untracked scratch file\n",
      );

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(occupied);
      expect(result.stderr).toContain("NOT been moved");
      // Untracked files are not tracked modifications: the refusal should
      // be the generic occupied-target refusal, not the dirty-checkout one.
      expect(result.stderr).not.toContain("uncommitted changes");
    });
  });

  // AC: @detached-reviewer-merge-helper ac-helper-refuses-dirty-target
  // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-target-branch-lock
  describe("dirty target refusal", () => {
    it("refuses when occupied integration worktree has tracked modifications", async () => {
      const env = await setupMergeTestEnv({ checkoutTarget: true });
      const occupied = env.integrationWorktreeDir!;

      // Add and commit a file so we can modify it (tracked modification).
      await fs.writeFile(path.join(occupied, "existing.txt"), "original\n");
      execSync("git add existing.txt", { cwd: occupied, stdio: "pipe" });
      execSync('git commit -m "add existing file"', { cwd: occupied, stdio: "pipe" });

      await fs.writeFile(path.join(occupied, "existing.txt"), "modified\n");

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      // Identifies the dirty pre-existing checkout.
      expect(result.stderr).toContain("uncommitted changes");
      expect(result.stderr).toContain(occupied);
      expect(result.stderr).toContain("Recovery");
      expect(result.stderr).toContain("NOT been moved");

      // Target ref unchanged.
      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);

      // The pre-existing dirty checkout was not overwritten.
      const occupiedContent = await fs.readFile(
        path.join(occupied, "existing.txt"),
        "utf-8",
      );
      expect(occupiedContent).toBe("modified\n");
    });

    it("refuses when occupied integration worktree has staged drift", async () => {
      const env = await setupMergeTestEnv({ checkoutTarget: true });
      const occupied = env.integrationWorktreeDir!;

      await fs.writeFile(path.join(occupied, "staged.txt"), "staged content\n");
      execSync("git add staged.txt", { cwd: occupied, stdio: "pipe" });

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("uncommitted changes");
      expect(result.stderr).toContain(occupied);

      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);
    });
  });

  // AC: @detached-reviewer-merge-helper ac-helper-safe-conflict-exit
  // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-target-branch-lock
  describe("conflict exit", () => {
    it("aborts the merge in the helper-owned worktree, removes it, and leaves the target ref unchanged", async () => {
      const env = await setupMergeTestEnv();

      // Create a conflicting commit on the target branch via a temporary
      // worktree that is removed before invoking the helper.
      await withTempBranchWorktree(env, env.mergeTarget, async (worktreeDir) => {
        await fs.writeFile(path.join(worktreeDir, "feature.txt"), "conflicting content on dev\n");
        execSync("git add feature.txt", { cwd: worktreeDir, stdio: "pipe" });
        execSync('git commit -m "add conflicting feature on dev"', {
          cwd: worktreeDir,
          stdio: "pipe",
        });
      });

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      const targetWorktreesBefore = listTargetWorktrees(env);
      expect(targetWorktreesBefore).toEqual([]);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("merge conflict");
      expect(result.stderr).toContain("NOT been advanced");
      // References cleanup of the helper-owned temporary worktree, not a
      // refresh of any occupied integration worktree.
      expect(result.stderr).toContain("temporary target worktree");
      expect(result.stderr).toContain("needs_work");
      expect(result.stderr).not.toContain("resolve inline");
      expect(result.stderr).not.toContain("simple/textual");

      // Target ref unchanged.
      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);

      // No helper-owned worktree remains on the target branch.
      const targetWorktreesAfter = listTargetWorktrees(env);
      expect(targetWorktreesAfter).toEqual([]);
    });
  });

  // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-target-branch-lock
  describe("post-error worktree state", () => {
    it("leaves no auxiliary worktree on the target branch after a missing-canonical error", async () => {
      const env = await setupMergeTestEnv();

      const targetWorktreesBefore = listTargetWorktrees(env);
      expect(targetWorktreesBefore).toEqual([]);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: "0000000000000000000000000000000000000000",
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);

      const targetWorktreesAfter = listTargetWorktrees(env);
      expect(targetWorktreesAfter).toEqual([]);
    });
  });

  describe("environment contract", () => {
    it("fails when KSPEC_DISPATCH_CANONICAL_BRANCH is not set", async () => {
      const env = await setupMergeTestEnv();

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("KSPEC_DISPATCH_CANONICAL_BRANCH");
    });

    it("fails when KSPEC_DISPATCH_MERGE_TARGET is not set", async () => {
      const env = await setupMergeTestEnv();

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("KSPEC_DISPATCH_MERGE_TARGET");
    });

    it("fails when KSPEC_DISPATCH_CANONICAL_HEAD is not set", async () => {
      const env = await setupMergeTestEnv();

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("KSPEC_DISPATCH_CANONICAL_HEAD");
    });
  });
});
