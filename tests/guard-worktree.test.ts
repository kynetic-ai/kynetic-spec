/**
 * Tests for kspec guard worktree command.
 *
 * Tests the native TypeScript guard that replaces kspec-worktree-guard.sh.
 * Uses unit tests on the evaluateWorktreeGuard function and integration tests
 * via the CLI.
 */

import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { evaluateWorktreeGuard, type GuardOptions } from "../src/cli/commands/guard.js";
import { kspec, createTempDir, initGitRepo, git } from "./helpers/cli.js";
import * as fs from "node:fs";

// Standard test project root and shadow worktree path
const PROJECT_ROOT = "/home/user/project";
const SHADOW_ABS_PATH = `${PROJECT_ROOT}/.kspec`;
const defaultOpts: GuardOptions = { shadowAbsolutePath: SHADOW_ABS_PATH };

// ─── Unit tests for evaluateWorktreeGuard ───

describe("evaluateWorktreeGuard", () => {
  // AC: @native-guard-commands ac-worktree-allow
  describe("allows safe commands", () => {
    it("allows when no command is provided (not a Bash tool call)", () => {
      const result = evaluateWorktreeGuard({ tool_input: {} }, defaultOpts);
      expect(result.decision).toBe("allow");
    });

    it("allows when tool_input is missing", () => {
      const result = evaluateWorktreeGuard({}, defaultOpts);
      expect(result.decision).toBe("allow");
    });

    it("allows non-git commands outside .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "ls -la" },
          cwd: "/home/user/project",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("allows safe git commands outside .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git status" },
          cwd: "/home/user/project",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("allows safe git commands in .kspec (git status)", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git status" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("allows git checkout kspec-meta in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git checkout kspec-meta" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("allows git log in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git log --oneline" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("allows git diff in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git diff" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("allows git add and commit (non-amend) in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git add . && git commit -m 'update'" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("allows git push (non-force) in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git push origin kspec-meta" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    // Patterns in quoted arguments should be allowed (e.g. echo "git reset")
    it('allows patterns inside quoted strings (echo "git reset")', () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: 'echo "git reset --hard"' },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it('allows grep for dangerous patterns (grep "git stash")', () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "grep 'git stash' some-file.sh" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });
  });

  // AC: @native-guard-commands ac-worktree-guard
  describe("blocks dangerous commands in .kspec", () => {
    // Branch creation
    it("blocks git checkout -b in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git checkout -b new-branch" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
      expect(result.reason).toContain("kspec-worktree-guard");
    });

    it("blocks git checkout -B in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git checkout -B new-branch" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks git switch -c in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git switch -c new-branch" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks git switch --create in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git switch --create new-branch" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks git branch -c in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git branch -c old new" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks git branch -m in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git branch -m old new" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks git branch -M in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git branch -M old new" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    // History rewriting
    it("blocks git reset in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git reset --hard HEAD~1" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks git rebase in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git rebase main" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks git cherry-pick in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git cherry-pick abc123" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks git commit --amend in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git commit --amend -m 'fix'" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    // Force push
    it("blocks git push --force in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git push --force origin kspec-meta" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks git push -f in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git push -f origin kspec-meta" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    // Discarding changes
    it("blocks git stash in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git stash" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks git clean in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git clean -fd" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks git checkout -- in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git checkout -- file.yaml" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks git restore in .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git restore file.yaml" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });
  });

  // AC: @native-guard-commands ac-worktree-guard - kspec-meta deletion from anywhere
  describe("blocks kspec-meta branch deletion from anywhere", () => {
    it("blocks git branch -d kspec-meta outside .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git branch -d kspec-meta" },
          cwd: "/home/user/project",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
      expect(result.reason).toContain("kspec-meta");
    });

    it("blocks git branch -D kspec-meta outside .kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git branch -D kspec-meta" },
          cwd: "/home/user/project",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks quoted kspec-meta deletion (bypass attempt)", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: 'git "branch" -D kspec-meta' },
          cwd: "/home/user/project",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("allows deleting branches with kspec-meta prefix", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git branch -D kspec-meta-backup-2026-02-28" },
          cwd: "/home/user/project",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("blocks kspec-meta deletion even without shadowAbsolutePath", () => {
      // Branch deletion protection works without shadow path context
      const result = evaluateWorktreeGuard({
        tool_input: { command: "git branch -D kspec-meta" },
        cwd: "/home/user/project",
      });
      expect(result.decision).toBe("block");
      expect(result.reason).toContain("kspec-meta");
    });
  });

  // AC: @native-guard-commands ac-worktree-guard - cd to .kspec detection
  describe("detects .kspec context via cd commands", () => {
    it("blocks dangerous commands with cd .kspec prefix", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "cd .kspec && git reset --hard" },
          cwd: "/home/user/project",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks dangerous commands with cd to absolute .kspec path", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "cd /home/user/project/.kspec && git stash" },
          cwd: "/home/user/project",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });
  });

  // AC: @native-guard-commands ac-worktree-guard - cwd detection
  describe("detects .kspec context via cwd", () => {
    it("detects cwd ending with /.kspec", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git reset --hard" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("detects cwd containing /.kspec/", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git reset --hard" },
          cwd: "/home/user/project/.kspec/modules",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("detects Windows-style cwd with backslashes", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git reset --hard" },
          cwd: "C:\\Users\\dev\\project\\.kspec",
        },
        { shadowAbsolutePath: "C:\\Users\\dev\\project\\.kspec" },
      );
      expect(result.decision).toBe("block");
    });
  });

  // Anti-bypass: split-quote detection
  describe("catches split-quote bypass attempts", () => {
    it('blocks git "reset" --hard (split-quote bypass)', () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: 'git "reset" --hard' },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });
  });

  // AC: @native-guard-commands ac-worktree-guard — absolute path matching prevents false positives
  describe("does NOT false-positive on paths containing .kspec as substring", () => {
    it("allows git rebase in .kspec-worktrees dispatch worktree", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git rebase origin/dev" },
          cwd: "/home/user/project/.kspec-worktrees/dispatch/task/foo/01ABC123",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("allows git fetch in .kspec-worktrees directory", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git fetch origin" },
          cwd: "/home/user/project/.kspec-worktrees",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("allows git reset in .kspec-backup directory", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git reset --hard HEAD~1" },
          cwd: "/home/user/project/.kspec-backup",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("allows dangerous git ops in .kspec-data directory", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git clean -fd" },
          cwd: "/home/user/project/.kspec-data/something",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("still blocks dangerous commands in actual .kspec directory", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git rebase origin/dev" },
          cwd: "/home/user/project/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("still blocks dangerous commands in .kspec subdirectory", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git reset --hard" },
          cwd: "/home/user/project/.kspec/modules",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });
  });

  // AC: @native-guard-commands ac-worktree-guard — cd detection must also be exact
  describe("cd detection uses absolute path matching", () => {
    it("allows cd to .kspec-worktrees with dangerous git ops", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "cd .kspec-worktrees/task/foo && git rebase origin/dev" },
          cwd: "/home/user/project",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("blocks cd to .kspec with dangerous git ops", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "cd .kspec && git reset --hard" },
          cwd: "/home/user/project",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks cd to .kspec/subdir with dangerous git ops", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "cd .kspec/modules && git stash" },
          cwd: "/home/user/project",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("still blocks kspec-meta deletion from dispatch worktree", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git branch -D kspec-meta" },
          cwd: "/home/user/project/.kspec-worktrees/dispatch/task/foo/01ABC123",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("block");
      expect(result.reason).toContain("kspec-meta");
    });
  });

  // AC: @native-guard-commands ac-worktree-guard — configurable shadow directory via absolute path
  describe("respects configured shadow directory via absolute path", () => {
    const customOpts: GuardOptions = { shadowAbsolutePath: "/home/user/project/.specs" };

    it("blocks dangerous commands in custom shadow directory", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git reset --hard" },
          cwd: "/home/user/project/.specs",
        },
        customOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("blocks dangerous commands in custom shadow subdirectory", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git rebase main" },
          cwd: "/home/user/project/.specs/modules",
        },
        customOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("allows dangerous commands in default .kspec when custom dir is configured", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git reset --hard" },
          cwd: "/home/user/project/.kspec",
        },
        customOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("allows commands in directories with custom dir as substring prefix", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git rebase origin/dev" },
          cwd: "/home/user/project/.specs-worktrees/dispatch/task/foo/01ABC123",
        },
        customOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("blocks cd to custom shadow directory with dangerous ops", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "cd .specs && git reset --hard" },
          cwd: "/home/user/project",
        },
        customOpts,
      );
      expect(result.decision).toBe("block");
    });

    it("allows cd to .kspec when custom dir is .specs", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "cd .kspec && git reset --hard" },
          cwd: "/home/user/project",
        },
        customOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("still blocks kspec-meta branch deletion regardless of custom dir", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git branch -D kspec-meta" },
          cwd: "/home/user/project",
        },
        customOpts,
      );
      expect(result.decision).toBe("block");
    });
  });

  // AC: @native-guard-commands ac-worktree-guard — nested directory false positive prevention
  describe("does NOT false-positive on nested directories with same shadow dir name", () => {
    it("allows dangerous ops in unrelated nested .kspec directory", () => {
      // /repo/packages/demo/.kspec is NOT the project shadow worktree
      // The project shadow worktree is at /home/user/project/.kspec
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git reset --hard" },
          cwd: "/repo/packages/demo/.kspec",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("allows dangerous ops in unrelated nested .specs directory (custom config)", () => {
      const customOpts: GuardOptions = { shadowAbsolutePath: "/repo/.specs" };
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "git rebase main" },
          cwd: "/repo/packages/demo/.specs",
        },
        customOpts,
      );
      expect(result.decision).toBe("allow");
    });

    it("allows cd to unrelated nested .kspec directory", () => {
      const result = evaluateWorktreeGuard(
        {
          tool_input: { command: "cd /other/project/.kspec && git reset --hard" },
          cwd: "/home/user/project",
        },
        defaultOpts,
      );
      expect(result.decision).toBe("allow");
    });
  });

  // Fail-open behavior when no shadowAbsolutePath is provided
  describe("fails open without shadowAbsolutePath (except branch deletion)", () => {
    it("allows cwd-based detection without options", () => {
      const result = evaluateWorktreeGuard({
        tool_input: { command: "git reset --hard" },
        cwd: "/home/user/project/.kspec",
      });
      // Without shadowAbsolutePath, cwd-based detection is skipped
      expect(result.decision).toBe("allow");
    });

    it("still blocks kspec-meta deletion without options", () => {
      const result = evaluateWorktreeGuard({
        tool_input: { command: "git branch -D kspec-meta" },
        cwd: "/home/user/project",
      });
      expect(result.decision).toBe("block");
    });
  });
});

// ─── CLI integration tests ───

describe("kspec guard worktree CLI", () => {
  // The CLI handler resolves the project root via resolveProjectRoots(), which
  // finds the main repo root even when running from a dispatch worktree.
  // The shadow path is then resolved as path.resolve(mainRoot, config.shadow.directory).
  // When running in a dispatch worktree, mainRoot is the parent project, not the
  // worktree itself — so cliShadowCwd must point to the main project's .kspec/.
  const cliTestCwd = process.cwd();
  // Resolve mainRoot the same way the guard does: via git --git-common-dir
  const mainRoot = (() => {
    const { execSync } = require("node:child_process");
    const commonDir = execSync("git rev-parse --git-common-dir", {
      cwd: cliTestCwd,
      encoding: "utf-8",
    }).trim();
    const absCommon = path.isAbsolute(commonDir)
      ? path.resolve(commonDir)
      : path.resolve(cliTestCwd, commonDir);
    // If commonDir is <root>/.git, mainRoot is <root>
    return path.dirname(absCommon);
  })();
  const cliShadowCwd = path.resolve(mainRoot, ".kspec");

  // AC: @trait-semantic-exit-codes ac-1 - exit 0 on success
  it("exits 0 and outputs allow JSON for safe command", () => {
    const input = JSON.stringify({
      tool_input: { command: "git status" },
      cwd: cliTestCwd,
    });
    const result = kspec(`guard worktree`, cliTestCwd, {
      stdin: input,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.decision).toBe("allow");
  });

  // AC: @trait-semantic-exit-codes ac-1 - exit 0 on block (guard protocol)
  it("exits 0 and outputs block JSON for dangerous command", () => {
    const input = JSON.stringify({
      tool_input: { command: "git reset --hard" },
      cwd: cliShadowCwd,
    });
    const result = kspec(`guard worktree`, cliTestCwd, {
      stdin: input,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("kspec-worktree-guard");
  });

  // AC: @trait-json-output ac-1 - valid JSON with no ANSI codes
  it("outputs valid JSON with no ANSI color codes", () => {
    const input = JSON.stringify({
      tool_input: { command: "git stash" },
      cwd: cliShadowCwd,
    });
    const result = kspec(`guard worktree`, cliTestCwd, {
      stdin: input,
    });
    expect(result.exitCode).toBe(0);
    // Should be parseable JSON
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toBeDefined();
    // No ANSI escape codes
    // oxlint-disable-next-line eslint/no-control-regex -- intentionally matching ANSI escape sequence
    expect(result.stdout).not.toMatch(/\x1b\[/);
  });

  // AC: @trait-json-output ac-2 - JSON includes all data from human-readable mode
  it("JSON output includes decision and reason fields", () => {
    const input = JSON.stringify({
      tool_input: { command: "git reset --hard" },
      cwd: cliShadowCwd,
    });
    const result = kspec(`guard worktree`, cliTestCwd, {
      stdin: input,
    });
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toHaveProperty("decision");
    expect(parsed).toHaveProperty("reason");
  });

  // AC: @trait-json-output ac-3 - error returned as JSON with error field
  it("returns JSON error for invalid stdin input", () => {
    const result = kspec(`guard worktree`, cliTestCwd, {
      stdin: "not valid json{{{",
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toHaveProperty("error");
  });

  // AC: @trait-semantic-exit-codes ac-2 - validation error exit code 1
  it("exits 1 on invalid JSON input (validation error)", () => {
    const result = kspec(`guard worktree`, cliTestCwd, {
      stdin: "not json",
    });
    expect(result.exitCode).toBe(1);
  });

  // AC: @native-guard-commands ac-worktree-allow - empty input
  it("allows with empty stdin input", () => {
    const result = kspec(`guard worktree`, cliTestCwd, {
      stdin: "",
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.decision).toBe("allow");
  });

  // AC: @native-guard-commands ac-worktree-guard — guard invoked from shadow worktree
  describe("blocks dangerous ops when hook process runs inside shadow worktree", () => {
    let tempDir: string;
    let shadowDir: string;

    beforeEach(async () => {
      tempDir = await createTempDir();
      initGitRepo(tempDir);
      // Create an initial commit on main
      fs.writeFileSync(path.join(tempDir, "README.md"), "test");
      git("add .", tempDir);
      git('commit -m "init"', tempDir);
      // Create orphan branch kspec-meta with a commit
      git("checkout --orphan kspec-meta", tempDir);
      fs.writeFileSync(path.join(tempDir, "kynetic.yaml"), "version: 1");
      git("add .", tempDir);
      git('commit -m "init shadow"', tempDir);
      // Switch back to main and add .kspec as a worktree
      git("checkout main", tempDir);
      git("worktree add .kspec kspec-meta", tempDir);
      shadowDir = path.join(tempDir, ".kspec");
    });

    afterEach(() => {
      // Clean up worktree before temp dir removal
      try {
        git("worktree remove .kspec --force", tempDir);
      } catch {
        // ignore
      }
    });

    it("blocks dangerous command when process.cwd() is the shadow worktree", () => {
      const input = JSON.stringify({
        tool_input: { command: "git reset --hard" },
        cwd: shadowDir,
      });
      // Run guard with cwd inside the shadow worktree — this is the scenario
      // where the hook process itself starts from .kspec/
      const result = kspec("guard worktree", shadowDir, { stdin: input });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("kspec-worktree-guard");
    });

    it("allows safe command when process.cwd() is the shadow worktree", () => {
      const input = JSON.stringify({
        tool_input: { command: "git status" },
        cwd: shadowDir,
      });
      const result = kspec("guard worktree", shadowDir, { stdin: input });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.decision).toBe("allow");
    });
  });

  // ─── Trait AC coverage: N/A documentation ───
  //
  // AC: @trait-json-output ac-4 — N/A: guard output contains no @-prefixed references
  // AC: @trait-json-output ac-5 — N/A: guard output contains no timestamps
  // AC: @trait-json-output ac-6 — N/A: guard always outputs JSON (hook protocol);
  //   --json flag has no additional effect since the guard command always speaks JSON
  // AC: @trait-semantic-exit-codes ac-3 — N/A: guard has no confirmation prompts
  // AC: @trait-semantic-exit-codes ac-4 — covered by runtime error catch in guard.ts
  //   (exits NOT_FOUND=3 which maps to runtime error)
  // AC: @trait-semantic-exit-codes ac-5 — N/A: guard is not a query command
  // AC: @trait-semantic-exit-codes ac-6 — N/A: guard takes no user-facing flags
  //   (invalid usage handled by commander)
  // AC: @trait-semantic-exit-codes ac-7 — N/A: guard is not a batch command
  // AC: @trait-semantic-exit-codes ac-8 — documented in guard.ts source code via
  //   EXIT_CODES constants and JSDoc comments
});
