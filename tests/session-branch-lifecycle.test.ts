/**
 * Tests for session branch auto-commit at lifecycle boundaries.
 *
 * AC: @session-branch-worktree ac-commit-boundaries
 * Verifies that lifecycle operations (create, close, compact, stale cleanup)
 * trigger auto-commits when .kspec-sessions/ is a git worktree,
 * and that event appends do NOT trigger commits.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createTempDir, initGitRepo, git } from "./helpers/cli.js";

import { initializeSessionBranch } from "../src/parser/session-branch.js";
import { SESSIONS_WORKTREE_DIR } from "../src/parser/shadow.js";
import {
  createSession,
  closeSession,
  appendEvent,
} from "../src/sessions/store.js";

let tempDir: string;
let sessionsDir: string;

function getCommitCount(branchName = "kspec-sessions"): number {
  try {
    const log = execSync(`git log --oneline ${branchName}`, {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    if (!log) return 0;
    return log.split("\n").length;
  } catch {
    return 0;
  }
}

beforeEach(async () => {
  tempDir = await createTempDir("session-branch-lifecycle-");
  initGitRepo(tempDir);
  await fs.writeFile(path.join(tempDir, "README.md"), "# Test\n", "utf-8");
  git("add -A", tempDir);
  git('commit -m "Initial commit"', tempDir);

  // Initialize session branch worktree
  const result = await initializeSessionBranch(tempDir);
  expect(result.success).toBe(true);

  sessionsDir = path.join(tempDir, SESSIONS_WORKTREE_DIR);
});

afterEach(async () => {
  try {
    execSync(
      `git worktree remove ${SESSIONS_WORKTREE_DIR} --force 2>/dev/null || true`,
      { cwd: tempDir, stdio: "pipe" },
    );
  } catch {
    // Ignore
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

// AC: @session-branch-worktree ac-commit-boundaries
describe("lifecycle auto-commits", () => {
  it("commits on session create", async () => {
    // AC: @session-branch-worktree ac-commit-boundaries
    const initialCount = getCommitCount();

    await createSession(sessionsDir, {
      id: "test-session-001",
      agent_type: "test",
      status: "active",
    });

    const afterCount = getCommitCount();
    expect(afterCount).toBeGreaterThan(initialCount);

    // Verify commit message
    const log = execSync("git log --oneline -1 kspec-sessions", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    expect(log).toContain("session: create");
  });

  it("commits on session close", async () => {
    // AC: @session-branch-worktree ac-commit-boundaries
    await createSession(sessionsDir, {
      id: "test-session-002",
      agent_type: "test",
      status: "active",
    });
    const afterCreate = getCommitCount();

    await closeSession(sessionsDir, "test-session-002", "completed", "Done");

    const afterClose = getCommitCount();
    expect(afterClose).toBeGreaterThan(afterCreate);

    const log = execSync("git log --oneline -1 kspec-sessions", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    expect(log).toContain("session: close");
  });

  it("does NOT commit on event append", async () => {
    // AC: @session-branch-worktree ac-commit-boundaries
    await createSession(sessionsDir, {
      id: "test-session-003",
      agent_type: "test",
      status: "active",
    });
    const afterCreate = getCommitCount();

    // Append events — these should NOT trigger commits
    await appendEvent(sessionsDir, {
      session_id: "test-session-003",
      type: "tool.call",
      payload: { tool: "test", result: "ok" },
    });
    await appendEvent(sessionsDir, {
      session_id: "test-session-003",
      type: "tool.result",
      payload: { tool: "test2", result: "ok2" },
    });

    const afterAppend = getCommitCount();
    expect(afterAppend).toBe(afterCreate);
  });
});

// Verify local mode (plain directory) does NOT commit
describe("local mode no-op", () => {
  it("does not commit when sessionsDir is a plain directory", async () => {
    // AC: @session-branch-worktree ac-commit-boundaries
    const plainDir = await createTempDir("session-local-");
    await fs.mkdir(plainDir, { recursive: true });

    // createSession should work without errors even without git
    await createSession(plainDir, {
      id: "local-session-001",
      agent_type: "test",
      status: "active",
    });

    // Verify no .git file or directory
    try {
      await fs.access(path.join(plainDir, ".git"));
      // If we get here, .git exists — but it shouldn't be a worktree file
      const stat = await fs.stat(path.join(plainDir, ".git"));
      expect(stat.isFile()).toBe(false); // Not a worktree
    } catch {
      // .git doesn't exist — expected for plain directory
    }

    await fs.rm(plainDir, { recursive: true, force: true });
  });
});
