/**
 * Tests for the detached reviewer merge helper script.
 *
 * Simulates the dispatch reviewer environment: a detached HEAD worktree
 * (reviewer snapshot) that runs the merge helper to integrate the canonical
 * branch into the occupied integration target.
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestSubprocessEnv, cleanupTempDir, createTempDir, initGitRepo } from "./helpers/cli.js";

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
  /** Main repo (bare-like project root where branches live) */
  projectDir: string;
  /** Worktree that has the integration target branch checked out (simulates worker/main worktree) */
  integrationWorktreeDir: string;
  /** Detached HEAD worktree simulating the reviewer snapshot */
  reviewerWorktreeDir: string;
  /** The canonical (task) branch name */
  canonicalBranch: string;
  /** The pinned canonical head commit SHA (reviewed snapshot) */
  canonicalHead: string;
  /** The integration target branch name */
  mergeTarget: string;
}

/**
 * Set up a test environment that mimics dispatch reviewer context:
 *
 * 1. A main git repo with an initial commit on "main"
 * 2. A "dev" branch (integration target) checked out in a separate worktree
 * 3. A canonical task branch with a diverging commit
 * 4. A detached HEAD worktree at the canonical branch tip (reviewer snapshot)
 */
async function setupMergeTestEnv(): Promise<MergeTestEnv> {
  const projectDir = await createTempDir("kspec-merge-helper-");
  cleanupDirs.push(projectDir);

  // Initialize the main repo
  initGitRepo(projectDir);
  execSync('git commit --allow-empty -m "initial commit"', {
    cwd: projectDir,
    stdio: "pipe",
  });

  // Create the integration target branch "dev" from main
  execSync("git branch dev", { cwd: projectDir, stdio: "pipe" });

  // Create the canonical task branch with a diverging commit
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

  // Capture the canonical head (the reviewed commit) before switching branches
  const canonicalHead = execSync(`git rev-parse HEAD`, {
    cwd: projectDir,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

  // Switch back to main so worktrees can be created
  execSync("git checkout main", { cwd: projectDir, stdio: "pipe" });

  // Create integration target worktree (simulates the occupied dev worktree)
  const worktreeBase = await createTempDir("kspec-merge-wt-");
  cleanupDirs.push(worktreeBase);

  const integrationWorktreeDir = path.join(worktreeBase, "dev-wt");
  execSync(`git worktree add "${integrationWorktreeDir}" dev`, {
    cwd: projectDir,
    stdio: "pipe",
  });

  // Create detached reviewer worktree at the canonical branch tip
  const reviewerWorktreeDir = path.join(worktreeBase, "reviewer-wt");
  execSync(
    `git worktree add --detach "${reviewerWorktreeDir}" "${canonicalBranch}"`,
    { cwd: projectDir, stdio: "pipe" },
  );

  return {
    projectDir,
    integrationWorktreeDir,
    reviewerWorktreeDir,
    canonicalBranch,
    canonicalHead,
    mergeTarget: "dev",
  };
}

/**
 * Build a clean env for the merge helper, stripping all KSPEC_DISPATCH_* vars
 * from the parent process and layering only the explicitly passed vars.
 */
function buildMergeHelperEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const base = buildTestSubprocessEnv(overrides);
  // Strip all dispatch env vars so tests that omit a var don't inherit the parent's
  for (const key of Object.keys(base)) {
    if (key.startsWith("KSPEC_DISPATCH_") && !(key in overrides)) {
      delete base[key];
    }
  }
  return base;
}

/**
 * Run the merge helper script from a given working directory with dispatch env vars.
 */
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

afterEach(async () => {
  // Remove worktrees before cleaning up temp dirs
  for (const dir of [...cleanupDirs].reverse()) {
    try {
      // Try to remove all worktrees first
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
  // AC: @detached-reviewer-merge-helper ac-occupied-target-clean-refresh
  describe("occupied target clean refresh", () => {
    it("merges canonical branch into integration target and refreshes the occupied worktree", async () => {
      const env = await setupMergeTestEnv();

      // Verify the feature file does not exist in the integration worktree before merge
      const beforeExists = await fs
        .access(path.join(env.integrationWorktreeDir, "feature.txt"))
        .then(() => true)
        .catch(() => false);
      expect(beforeExists).toBe(false);

      // Run the merge helper from the reviewer worktree
      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("success: merged");
      expect(result.stdout).toContain(env.canonicalBranch);
      expect(result.stdout).toContain(env.mergeTarget);
      expect(result.stdout).toContain("occupied worktree refreshed");

      // Verify the integration target ref advanced
      const newTargetHead = execSync("git rev-parse HEAD", {
        cwd: env.integrationWorktreeDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      const canonicalHead = execSync(
        `git rev-parse "refs/heads/${env.canonicalBranch}"`,
        {
          cwd: env.projectDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      ).trim();

      // The canonical head should be an ancestor of the new target
      const isAncestor = execSync(
        `git merge-base --is-ancestor "${canonicalHead}" "${newTargetHead}" && echo yes || echo no`,
        {
          cwd: env.projectDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      ).trim();
      expect(isAncestor).toBe("yes");

      // Verify the feature file exists in the occupied integration worktree
      const content = await fs.readFile(
        path.join(env.integrationWorktreeDir, "feature.txt"),
        "utf-8",
      );
      expect(content).toBe("feature content\n");

      // Verify the occupied worktree index is clean
      const status = execSync("git status --porcelain", {
        cwd: env.integrationWorktreeDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      expect(status).toBe("");
    });
  });

  // AC: @detached-reviewer-merge-helper ac-occupied-target-clean-refresh
  describe("canonical head pinning", () => {
    it("merges the pinned reviewed commit, not the advanced branch tip", async () => {
      const env = await setupMergeTestEnv();

      // Advance the canonical branch PAST the reviewed commit
      execSync(`git checkout "${env.canonicalBranch}"`, {
        cwd: env.projectDir,
        stdio: "pipe",
      });
      await fs.writeFile(
        path.join(env.projectDir, "unreviewed.txt"),
        "unreviewed content\n",
      );
      execSync("git add unreviewed.txt", { cwd: env.projectDir, stdio: "pipe" });
      execSync('git commit -m "feat: unreviewed change"', {
        cwd: env.projectDir,
        stdio: "pipe",
      });
      execSync("git checkout main", { cwd: env.projectDir, stdio: "pipe" });

      // Run the merge helper with the original pinned canonical head
      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("success: merged");

      // The reviewed feature file should be present
      const content = await fs.readFile(
        path.join(env.integrationWorktreeDir, "feature.txt"),
        "utf-8",
      );
      expect(content).toBe("feature content\n");

      // The unreviewed file should NOT be present — we merged the pinned commit, not the tip
      const unreviewedExists = await fs
        .access(path.join(env.integrationWorktreeDir, "unreviewed.txt"))
        .then(() => true)
        .catch(() => false);
      expect(unreviewedExists).toBe(false);

      // The warning about drift should appear on stderr
      expect(result.stderr).toContain("advanced past the reviewed commit");
    });
  });

  // AC: @detached-reviewer-merge-helper ac-helper-no-op-merge
  describe("no-op merge", () => {
    it("reports no-op when canonical head is already integrated", async () => {
      const env = await setupMergeTestEnv();

      // First, merge so the canonical branch is integrated
      execSync(
        `git -C "${env.integrationWorktreeDir}" merge --no-ff "${env.canonicalBranch}" -m "pre-merge"`,
        { stdio: "pipe" },
      );

      const targetHeadBefore = execSync("git rev-parse HEAD", {
        cwd: env.integrationWorktreeDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      // Now run the helper — should be a no-op
      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("no-op");
      expect(result.stdout).toContain("already integrated");

      // Verify the target ref did NOT move
      const targetHeadAfter = execSync("git rev-parse HEAD", {
        cwd: env.integrationWorktreeDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      expect(targetHeadAfter).toBe(targetHeadBefore);

      // Verify the occupied worktree is still clean
      const status = execSync("git status --porcelain", {
        cwd: env.integrationWorktreeDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      expect(status).toBe("");
    });
  });

  // AC: @detached-reviewer-merge-helper ac-helper-refuses-dirty-target
  describe("dirty target refusal", () => {
    it("refuses to merge when occupied integration worktree has tracked modifications", async () => {
      const env = await setupMergeTestEnv();

      // Create an initial file and commit it in the integration worktree so we can modify it
      await fs.writeFile(
        path.join(env.integrationWorktreeDir, "existing.txt"),
        "original\n",
      );
      execSync("git add existing.txt", {
        cwd: env.integrationWorktreeDir,
        stdio: "pipe",
      });
      execSync('git commit -m "add existing file"', {
        cwd: env.integrationWorktreeDir,
        stdio: "pipe",
      });

      // Now make it dirty with a tracked modification
      await fs.writeFile(
        path.join(env.integrationWorktreeDir, "existing.txt"),
        "modified\n",
      );

      const targetHeadBefore = execSync("git rev-parse HEAD", {
        cwd: env.integrationWorktreeDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("uncommitted changes");
      expect(result.stderr).toContain("Recovery");

      // Verify the target ref did NOT move
      const targetHeadAfter = execSync("git rev-parse HEAD", {
        cwd: env.integrationWorktreeDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      expect(targetHeadAfter).toBe(targetHeadBefore);
    });

    it("refuses to merge when occupied integration worktree has staged drift", async () => {
      const env = await setupMergeTestEnv();

      // Stage a new file without committing
      await fs.writeFile(
        path.join(env.integrationWorktreeDir, "staged.txt"),
        "staged content\n",
      );
      execSync("git add staged.txt", {
        cwd: env.integrationWorktreeDir,
        stdio: "pipe",
      });

      const targetHeadBefore = execSync("git rev-parse HEAD", {
        cwd: env.integrationWorktreeDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("uncommitted changes");

      // Verify the target ref did NOT move
      const targetHeadAfter = execSync("git rev-parse HEAD", {
        cwd: env.integrationWorktreeDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      expect(targetHeadAfter).toBe(targetHeadBefore);
    });

    // AC: @detached-reviewer-merge-helper ac-helper-refuses-dirty-target
    it("allows merge when occupied integration worktree has only untracked files", async () => {
      const env = await setupMergeTestEnv();

      // Create an untracked file in the integration worktree (no git add)
      await fs.writeFile(
        path.join(env.integrationWorktreeDir, "scratch.tmp"),
        "untracked scratch file\n",
      );

      // The merge should succeed — untracked files are not tracked modifications or staged drift
      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("success: merged");

      // The feature file should be present after merge
      const content = await fs.readFile(
        path.join(env.integrationWorktreeDir, "feature.txt"),
        "utf-8",
      );
      expect(content).toBe("feature content\n");
    });
  });

  // AC: @detached-reviewer-merge-helper ac-helper-safe-conflict-exit
  describe("conflict exit", () => {
    it("stops on conflict without advancing target ref and provides guidance", async () => {
      const env = await setupMergeTestEnv();

      // Create a conflicting file on the integration branch
      await fs.writeFile(
        path.join(env.integrationWorktreeDir, "feature.txt"),
        "conflicting content on dev\n",
      );
      execSync("git add feature.txt", {
        cwd: env.integrationWorktreeDir,
        stdio: "pipe",
      });
      execSync('git commit -m "add conflicting feature on dev"', {
        cwd: env.integrationWorktreeDir,
        stdio: "pipe",
      });

      const targetHeadBefore = execSync("git rev-parse HEAD", {
        cwd: env.integrationWorktreeDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      const result = runMergeHelper(env.reviewerWorktreeDir, {
        KSPEC_DISPATCH_CANONICAL_BRANCH: env.canonicalBranch,
        KSPEC_DISPATCH_CANONICAL_HEAD: env.canonicalHead,
        KSPEC_DISPATCH_MERGE_TARGET: env.mergeTarget,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("merge conflict");
      // AC: target ref was not advanced
      expect(result.stderr).toContain("NOT been advanced");
      // AC: occupied worktree was restored
      expect(result.stderr).toContain("restored to its pre-merge state");
      // AC: instructs returning the task via needs_work
      expect(result.stderr).toContain("needs_work");
      // AC: does NOT instruct inline/simple/textual conflict resolution
      expect(result.stderr).not.toContain("resolve inline");
      expect(result.stderr).not.toContain("simple/textual");
      expect(result.stderr).not.toContain("re-run");

      // Verify the target ref did NOT move
      const targetHeadAfter = execSync("git rev-parse HEAD", {
        cwd: env.integrationWorktreeDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      expect(targetHeadAfter).toBe(targetHeadBefore);

      // Verify the occupied worktree is clean (merge was aborted)
      const status = execSync("git status --porcelain", {
        cwd: env.integrationWorktreeDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      expect(status).toBe("");
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
