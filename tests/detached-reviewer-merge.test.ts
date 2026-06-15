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
  for (const dir of cleanupDirs.toReversed()) {
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
    // AC: @detached-reviewer-merge-helper ac-helper-uses-ephemeral-target-worktree-when-target-free
    // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-new-target-branch-lock
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
      const featureInTarget = execSync(`git show "refs/heads/${env.mergeTarget}:feature.txt"`, {
        cwd: env.projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(featureInTarget).toBe("feature content\n");

      // No worktree remains checked out on the target branch.
      const targetWorktreesAfter = listTargetWorktrees(env);
      expect(targetWorktreesAfter).toEqual([]);
    });
  });

  describe("canonical head pinning", () => {
    // AC: @detached-reviewer-merge-helper ac-helper-uses-ephemeral-target-worktree-when-target-free
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
      const featureInTarget = execSync(`git show "refs/heads/${env.mergeTarget}:feature.txt"`, {
        cwd: env.projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
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
  // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-new-target-branch-lock
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

  // AC: @detached-reviewer-merge-helper ac-helper-merges-in-clean-occupied-target-checkout
  // AC: @detached-reviewer-merge-helper ac-helper-does-not-break-checked-out-target
  // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-new-target-branch-lock
  describe("clean eligible occupied target checkout", () => {
    it("merges through an existing eligible non-auxiliary target checkout and leaves it coherent with the new tip", async () => {
      const env = await setupMergeTestEnv({ checkoutTarget: true });
      expect(env.integrationWorktreeDir).not.toBeNull();
      const occupied = env.integrationWorktreeDir!;

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      const reviewerHeadBefore = revParse(env.reviewerWorktreeDir, "HEAD");
      const reviewerCommitBefore = execSync('git rev-parse --verify "HEAD"', {
        cwd: env.reviewerWorktreeDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const targetWorktreesBefore = listTargetWorktrees(env);
      expect(targetWorktreesBefore).toEqual([occupied]);

      // Untracked file in the occupied checkout that the merge would NOT touch.
      // Eligibility must accept this: only files git reports would be
      // overwritten count as an overwrite hazard.
      await fs.writeFile(path.join(occupied, "untracked.scratch"), "scratch\n");

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(
        result.exitCode,
        `helper failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain("success: merged");
      // The helper announces that it merged through the existing checkout
      // rather than via a temporary worktree.
      expect(result.stdout).toContain(occupied);

      // Target ref advanced.
      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).not.toBe(targetHeadBefore);

      // The occupied worktree is still on the target branch with HEAD now at
      // the new target tip (checkout-aware merge, not behind the checkout).
      const occupiedHead = revParse(occupied, "HEAD");
      expect(occupiedHead).toBe(targetHeadAfter);
      const occupiedBranch = execSync("git branch --show-current", {
        cwd: occupied,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      expect(occupiedBranch).toBe(env.mergeTarget);

      // No tracked drift in the occupied checkout after the merge.
      const occupiedStatus = execSync("git status --porcelain --untracked-files=no", {
        cwd: occupied,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(occupiedStatus).toBe("");

      // Untracked scratch file is preserved.
      const untrackedExists = await fs
        .stat(path.join(occupied, "untracked.scratch"))
        .then(() => true)
        .catch(() => false);
      expect(untrackedExists).toBe(true);

      // Detached reviewer snapshot was NOT mutated.
      expect(revParse(env.reviewerWorktreeDir, "HEAD")).toBe(reviewerHeadBefore);
      expect(reviewerHeadBefore).toBe(reviewerCommitBefore);

      // No new helper-owned auxiliary worktree was added; only the
      // pre-existing eligible occupied worktree still holds the target.
      const targetWorktreesAfter = listTargetWorktrees(env);
      expect(targetWorktreesAfter).toEqual([occupied]);
    });

    // AC: @detached-reviewer-merge-helper ac-helper-merges-in-clean-occupied-target-checkout
    it("accepts harmless untracked/ignored files in the eligible occupied checkout", async () => {
      const env = await setupMergeTestEnv({ checkoutTarget: true });
      const occupied = env.integrationWorktreeDir!;

      // Ignored file (.gitignored) and untracked-but-irrelevant file.
      await fs.writeFile(path.join(occupied, ".gitignore"), "*.log\n");
      execSync("git add .gitignore", { cwd: occupied, stdio: "pipe" });
      execSync('git commit -m "add ignore"', { cwd: occupied, stdio: "pipe" });
      await fs.writeFile(path.join(occupied, "debug.log"), "ignored\n");
      await fs.writeFile(path.join(occupied, "irrelevant.scratch"), "untracked\n");

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(
        result.exitCode,
        `helper failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain("success: merged");

      // Untracked & ignored files are still present.
      const ignoredExists = await fs
        .stat(path.join(occupied, "debug.log"))
        .then(() => true)
        .catch(() => false);
      expect(ignoredExists).toBe(true);
      const scratchExists = await fs
        .stat(path.join(occupied, "irrelevant.scratch"))
        .then(() => true)
        .catch(() => false);
      expect(scratchExists).toBe(true);
    });
  });

  // AC: @detached-reviewer-merge-helper ac-helper-refuses-dirty-target
  // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-new-target-branch-lock
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
      expect(result.stderr).toContain("tracked modifications");
      expect(result.stderr).toContain(occupied);
      expect(result.stderr).toContain("Recovery");
      expect(result.stderr).toContain("NOT been moved");

      // Target ref unchanged.
      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);

      // The pre-existing dirty checkout remains dirty and was not overwritten.
      const occupiedStatus = execSync("git status --short -- existing.txt", {
        cwd: occupied,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(occupiedStatus).toBe(" M existing.txt\n");
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
      expect(result.stderr).toContain("staged drift");
      expect(result.stderr).toContain(occupied);

      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);
    });

    // AC: @detached-reviewer-merge-helper ac-helper-refuses-dirty-target
    it("refuses when occupied integration worktree has an in-progress merge", async () => {
      const env = await setupMergeTestEnv({ checkoutTarget: true });
      const occupied = env.integrationWorktreeDir!;

      // Set up a divergent commit on a side branch so a merge in occupied
      // produces a true in-progress state we can leave behind.
      await fs.writeFile(path.join(occupied, "trunk.txt"), "trunk\n");
      execSync("git add trunk.txt", { cwd: occupied, stdio: "pipe" });
      execSync('git commit -m "trunk commit"', { cwd: occupied, stdio: "pipe" });

      execSync("git checkout -b inflight-branch", { cwd: occupied, stdio: "pipe" });
      await fs.writeFile(path.join(occupied, "trunk.txt"), "side\n");
      execSync("git add trunk.txt", { cwd: occupied, stdio: "pipe" });
      execSync('git commit -m "side commit"', { cwd: occupied, stdio: "pipe" });

      execSync(`git checkout ${env.mergeTarget}`, { cwd: occupied, stdio: "pipe" });
      await fs.writeFile(path.join(occupied, "trunk.txt"), "trunk2\n");
      execSync("git add trunk.txt", { cwd: occupied, stdio: "pipe" });
      execSync('git commit -m "trunk2 commit"', { cwd: occupied, stdio: "pipe" });

      // Start a merge that conflicts so MERGE_HEAD persists.
      const mergeProbe = spawnSync("git", ["merge", "--no-ff", "inflight-branch"], {
        cwd: occupied,
        encoding: "utf-8",
      });
      expect(mergeProbe.status).not.toBe(0);

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("in-progress merge");
      expect(result.stderr).toContain(occupied);
      expect(result.stderr).toContain("NOT been moved");

      // Target ref unchanged.
      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);

      // In-progress merge is still present (we did not abort it for the user).
      const mergeHeadPath = execSync("git rev-parse --git-path MERGE_HEAD", {
        cwd: occupied,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const mergeHeadFullPath = path.isAbsolute(mergeHeadPath)
        ? mergeHeadPath
        : path.join(occupied, mergeHeadPath);
      const stillInProgress = await fs
        .stat(mergeHeadFullPath)
        .then(() => true)
        .catch(() => false);
      expect(stillInProgress).toBe(true);
    });

    // AC: @detached-reviewer-merge-helper ac-helper-refuses-dirty-target
    it("refuses when the required merge would overwrite untracked files in the occupied checkout", async () => {
      const env = await setupMergeTestEnv({ checkoutTarget: true });
      const occupied = env.integrationWorktreeDir!;

      // The canonical branch added feature.txt. Stage an untracked feature.txt
      // in the occupied checkout that git would refuse to overwrite.
      await fs.writeFile(path.join(occupied, "feature.txt"), "untracked locally-authored\n");

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain("would overwrite");
      expect(result.stderr).toContain(occupied);
      expect(result.stderr).toContain("NOT been moved");

      // Target ref unchanged.
      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);

      // The untracked file is preserved unchanged (test-managed fixture under
      // a temp git repo, not project source — oxlint disabled inline).
      // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- temp git repo fixture
      const fileContent = await fs.readFile(path.join(occupied, "feature.txt"), "utf-8");
      // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- temp git repo fixture
      expect(fileContent).toBe("untracked locally-authored\n");
    });

    // AC: @detached-reviewer-merge-helper ac-helper-refuses-dirty-target
    //
    // Directory/file hazard direction 2: the merge would write a FILE at a
    // path the occupied checkout holds as an untracked DIRECTORY. Git emits
    // a different error shape here ("Updating the following directories
    // would lose untracked files in them") than the file-vs-file case, but
    // the helper must still recognize it as an untracked-overwrite hazard
    // and emit cleanup guidance rather than a generic merge-failed message.
    it("refuses when the required merge would lose untracked files in a directory at a path the merge would write", async () => {
      const env = await setupMergeTestEnv({ checkoutTarget: true });
      const occupied = env.integrationWorktreeDir!;

      // The canonical branch added feature.txt as a file. Replace it locally
      // with an untracked directory of the same name containing untracked
      // content. Git refuses such a checkout because the merge would have to
      // lose the directory's untracked entries to create the incoming file.
      await fs.mkdir(path.join(occupied, "feature.txt"), { recursive: true });
      await fs.writeFile(
        path.join(occupied, "feature.txt", "user-notes.md"),
        "scratch notes that must not be lost\n",
      );

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      // Helper-emitted line names the unsafe checkout; underlying git error
      // is included in stderr and uses the directory variant of the message.
      expect(result.stderr.toLowerCase()).toContain("would overwrite");
      expect(result.stderr.toLowerCase()).toContain("would lose untracked files");
      expect(result.stderr).toContain(occupied);
      expect(result.stderr).toContain("NOT been moved");

      // Target ref unchanged.
      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);

      // The untracked directory and its contents are preserved unchanged.
      // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- temp git repo fixture
      const fileContent = await fs.readFile(
        path.join(occupied, "feature.txt", "user-notes.md"),
        "utf-8",
      );
      // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- temp git repo fixture
      expect(fileContent).toBe("scratch notes that must not be lost\n");
    });
  });

  // AC: @detached-reviewer-merge-helper ac-helper-refuses-auxiliary-target-lock
  // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-new-target-branch-lock
  describe("auxiliary target lock refusal", () => {
    it("refuses when the target is checked out in a worktree carrying the dispatch metadata file", async () => {
      const env = await setupMergeTestEnv({ checkoutTarget: true });
      const occupied = env.integrationWorktreeDir!;

      // Mark the occupied worktree as a dispatch auxiliary worktree by
      // writing the dispatch metadata marker file. This simulates a leaked
      // worker/reviewer/helper/plan-scoped checkout that happened to have
      // the integration target branch checked out.
      await fs.writeFile(
        path.join(occupied, ".kspec-dispatch-workspace.json"),
        `${JSON.stringify({ role: "helper", purpose: "test" })}\n`,
      );

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      const targetWorktreesBefore = listTargetWorktrees(env);
      expect(targetWorktreesBefore).toEqual([occupied]);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain("auxiliary");
      expect(result.stderr).toContain(occupied);
      // Guidance points to cleanup/detach of the auxiliary worktree.
      expect(result.stderr.toLowerCase()).toMatch(/git worktree remove|checkout --detach/);
      // Helper does NOT instruct the reviewer to check out the target manually.
      expect(result.stderr).not.toContain(`check out '${env.mergeTarget}' in a worktree`);
      expect(result.stderr).not.toContain(`check out "${env.mergeTarget}" in a worktree`);

      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);

      // No new auxiliary checkout was added (the original auxiliary remains).
      const targetWorktreesAfter = listTargetWorktrees(env);
      expect(targetWorktreesAfter).toEqual([occupied]);
    });

    it("refuses when the target is checked out inside the configured worktree root (path-based)", async () => {
      const env = await setupMergeTestEnv();
      // Place the occupied worktree under the worktreeBase and pass it via
      // KSPEC_DISPATCH_WORKTREE_ROOT to simulate a dispatch-created aux
      // worktree placed in the configured dispatch worktree root.
      const auxRoot = path.join(env.worktreeBase, "dispatch-root");
      await fs.mkdir(auxRoot, { recursive: true });
      const auxOccupied = path.join(auxRoot, "aux-target");
      execSync(`git worktree add "${auxOccupied}" ${env.mergeTarget}`, {
        cwd: env.projectDir,
        stdio: "pipe",
      });

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
        KSPEC_DISPATCH_WORKTREE_ROOT: auxRoot,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain("auxiliary");
      expect(result.stderr).toContain(auxOccupied);

      // Target ref unchanged.
      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);
    });
  });

  // AC: @detached-reviewer-merge-helper ac-helper-merges-in-clean-occupied-target-checkout
  describe("ambiguous occupancy refusal", () => {
    it("refuses when the target branch is checked out in more than one eligible worktree", async () => {
      // Git forbids checking out the same branch twice without --force on the
      // second add. Use --force to manufacture the ambiguity scenario.
      const env = await setupMergeTestEnv({ checkoutTarget: true });
      const occupied = env.integrationWorktreeDir!;
      const secondOccupied = path.join(env.worktreeBase, "dev-wt-2");
      execSync(`git worktree add --force "${secondOccupied}" ${env.mergeTarget}`, {
        cwd: env.projectDir,
        stdio: "pipe",
      });

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain("multiple");
      expect(result.stderr).toContain(occupied);
      expect(result.stderr).toContain(secondOccupied);
      expect(result.stderr).toContain("NOT been moved");

      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);
    });
  });

  // AC: @detached-reviewer-merge-helper ac-helper-safe-conflict-exit
  // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-new-target-branch-lock
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
      // Regression: conflict guidance must not steer the reviewer back to
      // checking out the integration target manually or refreshing a
      // persistent occupied worktree.
      expect(result.stderr).not.toContain(`check out '${env.mergeTarget}' in a worktree`);
      expect(result.stderr.toLowerCase()).not.toContain("occupied worktree refreshed");
      expect(result.stderr.toLowerCase()).not.toContain("occupied-worktree refresh");

      // Target ref unchanged.
      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);

      // No helper-owned worktree remains on the target branch in git's view.
      const targetWorktreesAfter = listTargetWorktrees(env);
      expect(targetWorktreesAfter).toEqual([]);

      // Regression: the helper's scratch dir (mktemp under TMPDIR with
      // kspec-merge-helper. prefix) must be removed from disk on the
      // conflict path. A leftover scratch dir means the temporary target
      // worktree was not cleaned up.
      const tmpRoot = process.env.TMPDIR || "/tmp";
      const tmpEntries = await fs.readdir(tmpRoot).catch(() => [] as string[]);
      const leftoverHelperScratch = tmpEntries.filter((name) =>
        name.startsWith("kspec-merge-helper."),
      );
      // Other concurrent tests may legitimately use kspec-merge-helper. dirs,
      // so we cannot assert global absence. Instead, assert that every
      // candidate scratch dir either no longer has a target subpath or has
      // been pruned from `git worktree list`.
      for (const name of leftoverHelperScratch) {
        const candidate = path.join(tmpRoot, name, "target");
        const exists = await fs
          .stat(candidate)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          // The candidate scratch must NOT still be registered as a worktree
          // on the target ref of OUR test project. Other test projects'
          // helper scratches are not our concern.
          const wtList = listTargetWorktrees(env);
          expect(wtList, `helper scratch ${candidate} should not hold our target ref`).toEqual([]);
        }
      }
    });

    // AC: @detached-reviewer-merge-helper ac-helper-safe-conflict-exit
    // AC: @detached-reviewer-merge-helper ac-helper-does-not-break-checked-out-target
    it("aborts the merge in an eligible occupied checkout, restores the worktree, and leaves the target ref unchanged", async () => {
      const env = await setupMergeTestEnv({ checkoutTarget: true });
      const occupied = env.integrationWorktreeDir!;

      // Add a conflicting commit to the target in the occupied checkout.
      await fs.writeFile(path.join(occupied, "feature.txt"), "conflicting content on dev\n");
      execSync("git add feature.txt", { cwd: occupied, stdio: "pipe" });
      execSync('git commit -m "add conflicting feature on dev"', {
        cwd: occupied,
        stdio: "pipe",
      });

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      const occupiedHeadBefore = revParse(occupied, "HEAD");
      expect(occupiedHeadBefore).toBe(targetHeadBefore);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("merge conflict");
      expect(result.stderr).toContain("NOT been advanced");
      // The helper's conflict guidance should reference the existing
      // checkout's restoration, not a non-existent temporary worktree.
      expect(result.stderr).toContain(occupied);
      expect(result.stderr).not.toContain("temporary target worktree");

      // Target ref unchanged.
      const targetHeadAfter = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      expect(targetHeadAfter).toBe(targetHeadBefore);

      // Occupied checkout is restored to its pre-merge state (no MERGE_HEAD,
      // worktree HEAD still at pre-merge target tip, no unmerged files).
      expect(revParse(occupied, "HEAD")).toBe(occupiedHeadBefore);
      const mergeHeadPath = execSync("git rev-parse --git-path MERGE_HEAD", {
        cwd: occupied,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const mergeHeadFullPath = path.isAbsolute(mergeHeadPath)
        ? mergeHeadPath
        : path.join(occupied, mergeHeadPath);
      const mergeHeadStillThere = await fs
        .stat(mergeHeadFullPath)
        .then(() => true)
        .catch(() => false);
      expect(mergeHeadStillThere).toBe(false);

      // No unmerged paths.
      const unmerged = execSync("git diff --name-only --diff-filter=U", {
        cwd: occupied,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(unmerged).toBe("");
    });
  });

  // Regression: the integration target is checked out in the PRIMARY repository
  // worktree (not a linked worktree). Git reports operation marker paths
  // relative to that checkout (e.g. ".git/MERGE_HEAD"), so a helper that tests
  // the raw marker path from its own cwd (the detached reviewer snapshot)
  // probes the wrong filesystem location and misses both an in-progress
  // operation (preflight) and a conflicted-merge MERGE_HEAD (post-merge).
  describe("primary repository worktree as integration target checkout", () => {
    // AC: @detached-reviewer-merge-helper ac-helper-safe-conflict-exit
    // AC: @detached-reviewer-merge-helper ac-helper-does-not-break-checked-out-target
    // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-new-target-branch-lock
    it("aborts cleanly and reports conflict guidance when the primary target checkout conflicts", async () => {
      const env = await setupMergeTestEnv();

      // Check the integration target out in the PRIMARY repo worktree.
      execSync(`git checkout ${env.mergeTarget}`, { cwd: env.projectDir, stdio: "pipe" });

      // Conflicting commit on the target: canonical added feature.txt, so a
      // diverging feature.txt on the target forces a true merge conflict.
      await fs.writeFile(path.join(env.projectDir, "feature.txt"), "conflicting content on dev\n");
      execSync("git add feature.txt", { cwd: env.projectDir, stdio: "pipe" });
      execSync('git commit -m "add conflicting feature on dev"', {
        cwd: env.projectDir,
        stdio: "pipe",
      });

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      const primaryHeadBefore = revParse(env.projectDir, "HEAD");
      expect(primaryHeadBefore).toBe(targetHeadBefore);

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      // Recognized as a conflict in a pre-existing checkout — not a generic
      // "merge failed" misclassification and not a severe cleanup failure.
      expect(result.stderr).toContain("merge conflict detected");
      expect(result.stderr).toContain("NOT been advanced");
      expect(result.stderr).toContain(env.projectDir);
      expect(result.stderr).not.toContain("error: merge failed");
      expect(result.stderr).not.toContain("SEVERE");
      expect(result.stderr).not.toContain("temporary target worktree");

      // Target ref unchanged and primary checkout HEAD unchanged.
      expect(revParse(env.projectDir, `refs/heads/${env.mergeTarget}`)).toBe(targetHeadBefore);
      expect(revParse(env.projectDir, "HEAD")).toBe(primaryHeadBefore);

      // No MERGE_HEAD lingering in the primary checkout.
      const mergeHeadPath = execSync("git rev-parse --git-path MERGE_HEAD", {
        cwd: env.projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const mergeHeadFullPath = path.isAbsolute(mergeHeadPath)
        ? mergeHeadPath
        : path.join(env.projectDir, mergeHeadPath);
      const mergeHeadStillThere = await fs
        .stat(mergeHeadFullPath)
        .then(() => true)
        .catch(() => false);
      expect(mergeHeadStillThere).toBe(false);

      // Clean tracked status (the abort fully restored the checkout).
      const status = execSync("git status --porcelain --untracked-files=no", {
        cwd: env.projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      expect(status).toBe("");

      // No unmerged paths in the index.
      const unmerged = execSync("git diff --name-only --diff-filter=U", {
        cwd: env.projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(unmerged).toBe("");
      // No leftover conflict markers in the working tree. `git diff --check`
      // exits nonzero if any tracked file contains conflict markers; a clean
      // exit proves the abort removed them (behavioral, not content-scanning).
      const conflictMarkerCheck = spawnSync("git", ["diff", "--check"], {
        cwd: env.projectDir,
        encoding: "utf-8",
      });
      expect(conflictMarkerCheck.status).toBe(0);
    });

    // AC: @detached-reviewer-merge-helper ac-helper-refuses-dirty-target
    // AC: @detached-reviewer-merge-helper ac-helper-does-not-break-checked-out-target
    it("refuses before merging when the primary target checkout already has an in-progress merge", async () => {
      const env = await setupMergeTestEnv();

      // Check the integration target out in the PRIMARY repo worktree.
      execSync(`git checkout ${env.mergeTarget}`, { cwd: env.projectDir, stdio: "pipe" });

      // Manufacture a genuine in-progress (conflicted) merge in the primary
      // worktree that the operator must be able to finish or abort themselves.
      await fs.writeFile(path.join(env.projectDir, "trunk.txt"), "trunk\n");
      execSync("git add trunk.txt", { cwd: env.projectDir, stdio: "pipe" });
      execSync('git commit -m "trunk commit"', { cwd: env.projectDir, stdio: "pipe" });

      execSync("git checkout -b inflight-branch", { cwd: env.projectDir, stdio: "pipe" });
      await fs.writeFile(path.join(env.projectDir, "trunk.txt"), "side\n");
      execSync("git add trunk.txt", { cwd: env.projectDir, stdio: "pipe" });
      execSync('git commit -m "side commit"', { cwd: env.projectDir, stdio: "pipe" });

      execSync(`git checkout ${env.mergeTarget}`, { cwd: env.projectDir, stdio: "pipe" });
      await fs.writeFile(path.join(env.projectDir, "trunk.txt"), "trunk2\n");
      execSync("git add trunk.txt", { cwd: env.projectDir, stdio: "pipe" });
      execSync('git commit -m "trunk2 commit"', { cwd: env.projectDir, stdio: "pipe" });

      const mergeProbe = spawnSync("git", ["merge", "--no-ff", "inflight-branch"], {
        cwd: env.projectDir,
        encoding: "utf-8",
      });
      expect(mergeProbe.status).not.toBe(0);

      const mergeHeadPath = execSync("git rev-parse --git-path MERGE_HEAD", {
        cwd: env.projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const mergeHeadFullPath = path.isAbsolute(mergeHeadPath)
        ? mergeHeadPath
        : path.join(env.projectDir, mergeHeadPath);
      const inProgressBefore = await fs
        .stat(mergeHeadFullPath)
        .then(() => true)
        .catch(() => false);
      expect(inProgressBefore).toBe(true);
      // Record the in-progress merge's recorded other-side commit via git
      // (behavioral) so we can prove the helper left it byte-for-byte intact.
      const mergeHeadRefBefore = revParse(env.projectDir, "MERGE_HEAD");

      const targetHeadBefore = revParse(env.projectDir, `refs/heads/${env.mergeTarget}`);
      const primaryHeadBefore = revParse(env.projectDir, "HEAD");

      // The helper runs from the detached reviewer snapshot — a DIFFERENT cwd
      // than the primary checkout that holds the in-progress merge.
      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      // Refused at preflight with the specific in-progress-operation message —
      // not the generic recovery hint (which also mentions "in-progress
      // merge"), and not a misclassification as a dirty/tracked-modification
      // checkout, which is exactly how the pre-fix helper mis-handled a primary
      // checkout whose relative MERGE_HEAD path it failed to resolve.
      expect(result.stderr).toContain("with an in-progress merge operation");
      expect(result.stderr).not.toContain("uncommitted changes");
      expect(result.stderr).toContain(env.projectDir);
      expect(result.stderr).toContain("NOT been moved");
      expect(result.stderr).not.toContain("merge conflict detected");
      expect(result.stderr).not.toContain("error: merge failed");

      // Target ref and primary checkout HEAD unchanged.
      expect(revParse(env.projectDir, `refs/heads/${env.mergeTarget}`)).toBe(targetHeadBefore);
      expect(revParse(env.projectDir, "HEAD")).toBe(primaryHeadBefore);

      // The operator's in-progress merge is left fully intact.
      const inProgressAfter = await fs
        .stat(mergeHeadFullPath)
        .then(() => true)
        .catch(() => false);
      expect(inProgressAfter).toBe(true);
      const mergeHeadRefAfter = revParse(env.projectDir, "MERGE_HEAD");
      expect(mergeHeadRefAfter).toBe(mergeHeadRefBefore);
    });
  });

  // AC: @detached-reviewer-merge-helper ac-helper-leaves-no-new-target-branch-lock
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
