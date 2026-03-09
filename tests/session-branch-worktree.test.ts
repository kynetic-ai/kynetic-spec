/**
 * Tests for session branch worktree management.
 *
 * AC: @session-branch-worktree — all ACs
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createTempDir, initGitRepo, git } from "./helpers/cli.js";

import {
  initializeSessionBranch,
  getSessionBranchStatus,
  repairSessionBranch,
  sessionBranchAutoCommit,
  resolveSessionBranchConfig,
  SESSION_BRANCH_NAME,
} from "../src/parser/session-branch.js";
import { SESSIONS_WORKTREE_DIR } from "../src/parser/shadow.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempDir("session-branch-test-");
  initGitRepo(tempDir);
  // Need at least one commit on main for worktree operations
  await fs.writeFile(path.join(tempDir, "README.md"), "# Test\n", "utf-8");
  git("add -A", tempDir);
  git('commit -m "Initial commit"', tempDir);
});

afterEach(async () => {
  // Clean up worktrees before removing temp dir
  try {
    execSync("git worktree list --porcelain", {
      cwd: tempDir,
      encoding: "utf-8",
    });
    execSync(`git worktree remove ${SESSIONS_WORKTREE_DIR} --force 2>/dev/null || true`, {
      cwd: tempDir,
      stdio: "pipe",
    });
  } catch {
    // Ignore cleanup errors
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

// AC: @session-branch-worktree ac-init
describe("session branch initialization", () => {
  it("creates orphan branch and worktree at .kspec-sessions/", async () => {
    // AC: @session-branch-worktree ac-init
    const result = await initializeSessionBranch(tempDir);

    expect(result.success).toBe(true);
    expect(result.branchCreated).toBe(true);
    expect(result.worktreeCreated).toBe(true);

    // Verify worktree directory exists
    const worktreeDir = path.join(tempDir, SESSIONS_WORKTREE_DIR);
    const stat = await fs.stat(worktreeDir);
    expect(stat.isDirectory()).toBe(true);

    // Verify it's a proper git worktree (.git file, not directory)
    const gitPath = path.join(worktreeDir, ".git");
    const gitStat = await fs.stat(gitPath);
    expect(gitStat.isFile()).toBe(true);

    // Verify branch exists
    const branches = execSync("git branch --list kspec-sessions", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    expect(branches).toContain("kspec-sessions");
  });

  it("uses custom branch name when provided", async () => {
    // AC: @session-branch-worktree ac-init
    const customName = "my-sessions";
    const result = await initializeSessionBranch(tempDir, customName);

    expect(result.success).toBe(true);

    // Verify custom branch exists
    const branches = execSync(`git branch --list ${customName}`, {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    expect(branches).toContain(customName);
  });

  it("returns alreadyExists when worktree is healthy", async () => {
    // AC: @session-branch-worktree ac-init
    await initializeSessionBranch(tempDir);
    const result = await initializeSessionBranch(tempDir);

    expect(result.success).toBe(true);
    expect(result.alreadyExists).toBe(true);
    expect(result.branchCreated).toBe(false);
    expect(result.worktreeCreated).toBe(false);
  });

  it("fails gracefully for non-git directory", async () => {
    // AC: @session-branch-worktree ac-init
    const nonGit = await createTempDir("non-git-");
    const result = await initializeSessionBranch(nonGit);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Not a git repository");

    await fs.rm(nonGit, { recursive: true, force: true });
  });
});

// AC: @session-branch-worktree ac-status
describe("session branch status", () => {
  it("reports healthy when branch and worktree exist", async () => {
    // AC: @session-branch-worktree ac-status
    await initializeSessionBranch(tempDir);
    const status = await getSessionBranchStatus(tempDir);

    expect(status.healthy).toBe(true);
    expect(status.branchExists).toBe(true);
    expect(status.worktreeExists).toBe(true);
    expect(status.worktreeLinked).toBe(true);
  });

  it("reports not exists when nothing initialized", async () => {
    // AC: @session-branch-worktree ac-status
    const status = await getSessionBranchStatus(tempDir);

    expect(status.healthy).toBe(false);
    expect(status.exists).toBe(false);
    expect(status.branchExists).toBe(false);
    expect(status.worktreeExists).toBe(false);
  });

  it("reports unhealthy when worktree directory is deleted", async () => {
    // AC: @session-branch-worktree ac-status
    await initializeSessionBranch(tempDir);

    // Remove the worktree directory to simulate corruption
    const worktreeDir = path.join(tempDir, SESSIONS_WORKTREE_DIR);
    await fs.rm(worktreeDir, { recursive: true, force: true });

    const status = await getSessionBranchStatus(tempDir);

    expect(status.healthy).toBe(false);
    expect(status.branchExists).toBe(true);
    expect(status.worktreeExists).toBe(false);
    expect(status.error).toContain("worktree missing");
  });
});

// AC: @session-branch-worktree ac-repair
describe("session branch repair", () => {
  it("repairs broken worktree by recreating it", async () => {
    // AC: @session-branch-worktree ac-repair
    await initializeSessionBranch(tempDir);

    // Break the worktree
    const worktreeDir = path.join(tempDir, SESSIONS_WORKTREE_DIR);
    await fs.rm(worktreeDir, { recursive: true, force: true });

    // Verify it's broken
    const brokenStatus = await getSessionBranchStatus(tempDir);
    expect(brokenStatus.healthy).toBe(false);

    // Repair
    const result = await repairSessionBranch(tempDir);
    expect(result.success).toBe(true);
    expect(result.worktreeCreated).toBe(true);

    // Verify it's healthy again
    const healthyStatus = await getSessionBranchStatus(tempDir);
    expect(healthyStatus.healthy).toBe(true);
  });

  it("returns alreadyExists when worktree is healthy", async () => {
    // AC: @session-branch-worktree ac-repair
    await initializeSessionBranch(tempDir);
    const result = await repairSessionBranch(tempDir);

    expect(result.success).toBe(true);
    expect(result.alreadyExists).toBe(true);
  });

  it("fails when branch does not exist", async () => {
    // AC: @session-branch-worktree ac-repair
    const result = await repairSessionBranch(tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not exist");
  });
});

// AC: @session-branch-worktree ac-commit-boundaries
describe("session branch auto-commit", () => {
  it("commits changes to the session worktree", async () => {
    // AC: @session-branch-worktree ac-commit-boundaries
    await initializeSessionBranch(tempDir);

    const worktreeDir = path.join(tempDir, SESSIONS_WORKTREE_DIR);

    // Create a session file
    const sessionDir = path.join(worktreeDir, "test-session");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session.yaml"),
      "id: test-session\nstatus: active\n",
      "utf-8",
    );

    // Auto-commit
    const committed = await sessionBranchAutoCommit(
      worktreeDir,
      "session: create (test-session)",
    );
    expect(committed).toBe(true);

    // Verify commit exists on session branch
    const log = execSync("git log --oneline -1 kspec-sessions", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    expect(log).toContain("session: create");
  });

  it("returns false when there are no changes", async () => {
    // AC: @session-branch-worktree ac-commit-boundaries
    await initializeSessionBranch(tempDir);

    const worktreeDir = path.join(tempDir, SESSIONS_WORKTREE_DIR);
    const committed = await sessionBranchAutoCommit(
      worktreeDir,
      "session: no-op",
    );
    expect(committed).toBe(false);
  });
});

// resolveSessionBranchConfig
describe("resolveSessionBranchConfig", () => {
  it('returns config when storage is "branch"', () => {
    const config = resolveSessionBranchConfig("/project", {
      sessions: { storage: "branch", branch: "my-sessions" },
    });

    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!.branchName).toBe("my-sessions");
    expect(config!.worktreeDir).toBe(
      path.join("/project", SESSIONS_WORKTREE_DIR),
    );
  });

  it("uses default branch name when not configured", () => {
    const config = resolveSessionBranchConfig("/project", {
      sessions: { storage: "branch" },
    });

    expect(config).not.toBeNull();
    expect(config!.branchName).toBe(SESSION_BRANCH_NAME);
  });

  it('returns null when storage is "local"', () => {
    const config = resolveSessionBranchConfig("/project", {
      sessions: { storage: "local" },
    });

    expect(config).toBeNull();
  });

  it("returns null when manifest is null", () => {
    const config = resolveSessionBranchConfig("/project", null);

    expect(config).toBeNull();
  });

  it("returns null when sessions config is missing", () => {
    const config = resolveSessionBranchConfig("/project", {});

    expect(config).toBeNull();
  });
});
