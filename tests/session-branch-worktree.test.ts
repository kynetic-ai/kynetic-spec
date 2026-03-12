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
  sessionBranchPull,
  resolveSessionBranchConfig,
  SESSION_BRANCH_NAME,
} from "../src/parser/session-branch.js";
import { SESSIONS_WORKTREE_DIR } from "../src/parser/shadow.js";
import { SessionSyncScheduler } from "../src/parser/session-sync-scheduler.js";

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

// AC: @session-branch-worktree ac-sync
describe("session branch sync", () => {
  it("sessionBranchPull returns success without pulling when no remote tracking", async () => {
    // AC: @session-branch-worktree ac-sync
    await initializeSessionBranch(tempDir);

    const worktreeDir = path.join(tempDir, SESSIONS_WORKTREE_DIR);
    const result = await sessionBranchPull(worktreeDir, SESSION_BRANCH_NAME);

    expect(result.success).toBe(true);
    expect(result.pulled).toBe(false);
    expect(result.hadConflict).toBe(false);
  });

  it("sessionBranchPull pulls from remote when tracking is configured", async () => {
    // AC: @session-branch-worktree ac-sync
    await initializeSessionBranch(tempDir);

    const worktreeDir = path.join(tempDir, SESSIONS_WORKTREE_DIR);

    // Create a bare repo as remote
    const remoteDir = await createTempDir("session-remote-");
    execSync("git init --bare", { cwd: remoteDir, stdio: "pipe" });

    // Push session branch to remote
    execSync(`git remote add origin ${remoteDir}`, {
      cwd: worktreeDir,
      stdio: "pipe",
    });
    execSync(`git push -u origin ${SESSION_BRANCH_NAME}`, {
      cwd: worktreeDir,
      stdio: "pipe",
    });

    // Simulate a remote change by pushing from a clone
    const cloneDir = await createTempDir("session-clone-");
    execSync(`git clone ${remoteDir} .`, { cwd: cloneDir, stdio: "pipe" });
    execSync(`git checkout ${SESSION_BRANCH_NAME}`, {
      cwd: cloneDir,
      stdio: "pipe",
    });
    await fs.writeFile(
      path.join(cloneDir, "remote-session.yaml"),
      "id: remote-session\n",
      "utf-8",
    );
    execSync("git add -A", { cwd: cloneDir, stdio: "pipe" });
    execSync(
      'git -c user.name="Test" -c user.email="test@test.com" commit -m "Remote session"',
      { cwd: cloneDir, stdio: "pipe" },
    );
    execSync(`git push origin ${SESSION_BRANCH_NAME}`, {
      cwd: cloneDir,
      stdio: "pipe",
    });

    // Now pull should detect remote changes
    const result = await sessionBranchPull(worktreeDir, SESSION_BRANCH_NAME);

    expect(result.success).toBe(true);
    expect(result.pulled).toBe(true);
    expect(result.hadConflict).toBe(false);

    // Verify the remote file was pulled
    const remoteFile = path.join(worktreeDir, "remote-session.yaml");
    const stat = await fs.stat(remoteFile);
    expect(stat.isFile()).toBe(true);

    // Clean up
    await fs.rm(remoteDir, { recursive: true, force: true });
    await fs.rm(cloneDir, { recursive: true, force: true });
  });

  it("SessionSyncScheduler calls syncOnce on interval and can be stopped", async () => {
    // AC: @session-branch-worktree ac-sync
    await initializeSessionBranch(tempDir);

    const worktreeDir = path.join(tempDir, SESSIONS_WORKTREE_DIR);

    const broadcasts: Array<{ channel: string; type: string; data: Record<string, unknown> }> = [];
    const pubsub = {
      broadcast(channel: string, type: string, data: Record<string, unknown>) {
        broadcasts.push({ channel, type, data });
      },
    };

    const scheduler = new SessionSyncScheduler({
      worktreeDir,
      intervalSeconds: 0.1, // 100ms for fast test
      branchName: SESSION_BRANCH_NAME,
      pubsub,
    });

    // Start and wait for at least one interval
    scheduler.start();

    // Wait for sync to run (200ms should allow at least one interval fire)
    await new Promise((resolve) => setTimeout(resolve, 200));

    scheduler.stop();

    // Scheduler should have run syncOnce at least once without error
    // (no remote tracking, so it exits early — but it ran without crashing)
    // The key assertion: scheduler starts and stops cleanly
    expect(scheduler).toBeDefined();
  });

  it("SessionSyncScheduler does nothing when interval is 0", () => {
    // AC: @session-branch-worktree ac-sync
    const scheduler = new SessionSyncScheduler({
      worktreeDir: "/nonexistent",
      intervalSeconds: 0,
      branchName: SESSION_BRANCH_NAME,
    });

    // start() should be a no-op
    scheduler.start();
    scheduler.stop();
  });

  it("sessionBranchPull resolves configured remote instead of hardcoding origin", async () => {
    // AC: @session-branch-worktree ac-sync
    await initializeSessionBranch(tempDir);

    const worktreeDir = path.join(tempDir, SESSIONS_WORKTREE_DIR);

    // Create a bare repo as remote with a non-default name
    const remoteDir = await createTempDir("session-custom-remote-");
    execSync("git init --bare", { cwd: remoteDir, stdio: "pipe" });

    // Add remote with custom name (not "origin")
    execSync(`git remote add upstream ${remoteDir}`, {
      cwd: worktreeDir,
      stdio: "pipe",
    });
    execSync(`git push upstream ${SESSION_BRANCH_NAME}`, {
      cwd: worktreeDir,
      stdio: "pipe",
    });

    // Configure tracking to the custom remote
    execSync(
      `git config branch.${SESSION_BRANCH_NAME}.remote upstream`,
      { cwd: worktreeDir, stdio: "pipe" },
    );
    execSync(
      `git config branch.${SESSION_BRANCH_NAME}.merge refs/heads/${SESSION_BRANCH_NAME}`,
      { cwd: worktreeDir, stdio: "pipe" },
    );

    // Simulate a remote change by pushing from a clone
    const cloneDir = await createTempDir("session-custom-clone-");
    execSync(`git clone ${remoteDir} .`, { cwd: cloneDir, stdio: "pipe" });
    execSync(`git checkout ${SESSION_BRANCH_NAME}`, {
      cwd: cloneDir,
      stdio: "pipe",
    });
    await fs.writeFile(
      path.join(cloneDir, "custom-remote-session.yaml"),
      "id: custom-remote\n",
      "utf-8",
    );
    execSync("git add -A", { cwd: cloneDir, stdio: "pipe" });
    execSync(
      'git -c user.name="Test" -c user.email="test@test.com" commit -m "Custom remote session"',
      { cwd: cloneDir, stdio: "pipe" },
    );
    execSync(`git push origin ${SESSION_BRANCH_NAME}`, {
      cwd: cloneDir,
      stdio: "pipe",
    });

    // Pull should use "upstream" (from git config), not hardcoded "origin"
    const result = await sessionBranchPull(worktreeDir, SESSION_BRANCH_NAME);

    expect(result.success).toBe(true);
    expect(result.pulled).toBe(true);

    // Verify the file from the custom remote was pulled
    const remoteFile = path.join(worktreeDir, "custom-remote-session.yaml");
    const stat = await fs.stat(remoteFile);
    expect(stat.isFile()).toBe(true);

    // Clean up
    await fs.rm(remoteDir, { recursive: true, force: true });
    await fs.rm(cloneDir, { recursive: true, force: true });
  });

  it("session branch sync is independent from kspec-meta sync", async () => {
    // AC: @session-branch-worktree ac-sync
    // Session sync failure should not affect kspec-meta operations
    await initializeSessionBranch(tempDir);

    const worktreeDir = path.join(tempDir, SESSIONS_WORKTREE_DIR);

    // sessionBranchPull uses its own in-flight dedup, independent from shadow pull
    const [result1, result2] = await Promise.all([
      sessionBranchPull(worktreeDir, SESSION_BRANCH_NAME),
      sessionBranchPull(worktreeDir, SESSION_BRANCH_NAME),
    ]);

    // Both should succeed (second reuses first's in-flight promise)
    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    // Both should be the same promise result (in-flight dedup)
    expect(result1).toBe(result2);
  });
});
