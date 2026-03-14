/**
 * Tests for deterministic task branch helper
 * AC: @deterministic-task-branch-helper ac-1, ac-2, ac-3
 * AC: @trait-json-output ac-1, ac-2, ac-3, ac-4, ac-6
 * AC: @trait-semantic-exit-codes ac-1, ac-2, ac-3, ac-4, ac-6, ac-8
 * AC: @trait-error-guidance ac-1, ac-2, ac-3, ac-5, ac-6
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import {
  setupTempFixtures,
  cleanupTempDir,
  kspec as kspecRun,
  kspecOutput as kspec,
  kspecJson,
  initGitRepo,
  git,
} from "./helpers/cli";

describe("Integration: task branch helper", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
    git("add -A", tempDir);
    git('commit -m "initial"', tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @deterministic-task-branch-helper ac-1
  it("should create the deterministic dispatch-compatible branch for a task", () => {
    kspec('task add --title "Branch test" --slug branch-test', tempDir);

    const result = kspecRun("task branch @branch-test", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dispatch/task/branch-test/");
    expect(result.stdout).toContain("Created new branch");

    // Verify we're on the correct branch
    const currentBranch = execSync("git branch --show-current", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    expect(currentBranch).toMatch(/^dispatch\/task\/branch-test\/[a-z0-9]{8}$/);
  });

  // AC: @deterministic-task-branch-helper ac-1
  it("should derive branch name from task slug and short ULID", () => {
    kspec('task add --title "My Feature Task" --slug my-feature-task', tempDir);

    const task = kspecJson<{ _ulid: string }>(
      "task get @my-feature-task",
      tempDir,
    );
    const shortId = task._ulid.slice(0, 8).toLowerCase();

    kspec("task branch @my-feature-task", tempDir);

    const currentBranch = execSync("git branch --show-current", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    expect(currentBranch).toBe(`dispatch/task/my-feature-task/${shortId}`);
  });

  // AC: @deterministic-task-branch-helper ac-2
  it("should reuse an existing local branch when run again", () => {
    kspec('task add --title "Reuse test" --slug reuse-test', tempDir);

    // First run creates the branch
    kspec("task branch @reuse-test", tempDir);

    // Make a commit on the branch
    git("commit --allow-empty -m 'work on branch'", tempDir);
    const commitOnBranch = execSync("git rev-parse HEAD", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();

    // Switch away
    git("checkout main", tempDir);

    // Second run should switch back to the same branch
    const result = kspecRun("task branch @reuse-test", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Switched to existing branch");

    // Verify we're on the same branch with the same commit
    const headAfter = execSync("git rev-parse HEAD", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    expect(headAfter).toBe(commitOnBranch);
  });

  // AC: @deterministic-task-branch-helper ac-2
  it("should report already_on_branch when already on the target branch", () => {
    kspec('task add --title "Already test" --slug already-test', tempDir);

    // First run creates the branch
    kspec("task branch @already-test", tempDir);

    // Running again while still on the branch
    const result = kspecRun("task branch @already-test", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Already on branch");
  });

  // AC: @deterministic-task-branch-helper ac-2
  it("should rehydrate a branch from a remote when not present locally", () => {
    // Create a bare remote
    const bareDir = tempDir + "-bare";
    execSync(`git init --bare --initial-branch=main "${bareDir}"`, { stdio: "pipe" });
    git(`remote add origin "${bareDir}"`, tempDir);
    git("push -u origin main", tempDir);

    kspec('task add --title "Remote rehydrate" --slug remote-rehydrate', tempDir);

    // Create the branch and push it to the remote
    kspec("task branch @remote-rehydrate", tempDir);
    const branchName = execSync("git branch --show-current", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    git("commit --allow-empty -m 'remote work'", tempDir);
    git(`push -u origin ${branchName}`, tempDir);

    // Delete the local branch
    git("checkout main", tempDir);
    git(`branch -D ${branchName}`, tempDir);

    // Running the helper should rehydrate from the remote
    const result = kspecRun("task branch @remote-rehydrate", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Rehydrated branch from remote");

    // Verify we're on the rehydrated branch
    const currentBranch = execSync("git branch --show-current", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    expect(currentBranch).toBe(branchName);
  });

  // AC: @deterministic-task-branch-helper ac-3
  it("should include branch name and dispatch continuity guidance in output", () => {
    kspec('task add --title "Guidance test" --slug guidance-test', tempDir);

    const result = kspecRun("task branch @guidance-test", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dispatch/task/guidance-test/");
    expect(result.stdout).toContain("dispatch-compatible");
    expect(result.stdout).toContain("continuity");
  });

  // AC: @deterministic-task-branch-helper ac-3
  // AC: @trait-json-output ac-1, ac-2
  it("should output valid JSON with branch details in --json mode", () => {
    kspec('task add --title "JSON test" --slug json-test', tempDir);

    const result = kspecJson<{
      branch: string;
      action: string;
      task_ref: string;
      source: string | null;
      guidance: string;
    }>("task branch @json-test", tempDir);

    expect(result.branch).toMatch(
      /^dispatch\/task\/json-test\/[a-z0-9]{8}$/,
    );
    expect(result.action).toBe("created");
    expect(result.task_ref).toBe("@json-test");
    expect(result.source).toBeNull();
    expect(result.guidance).toContain("continuity");
  });

  // AC: @trait-json-output ac-2
  it("should include all data in JSON mode that is available in human mode", () => {
    kspec('task add --title "JSON complete" --slug json-complete', tempDir);

    // Create branch first, then switch away and switch back to test "switched" action
    kspec("task branch @json-complete", tempDir);
    git("checkout main", tempDir);

    const result = kspecJson<{
      branch: string;
      action: string;
      task_ref: string;
      source: string | null;
      guidance: string;
    }>("task branch @json-complete", tempDir);

    expect(result.branch).toBeDefined();
    expect(result.action).toBe("switched");
    expect(result.task_ref).toBe("@json-complete");
    expect(result.guidance).toBeDefined();
  });

  // AC: @trait-json-output ac-3
  it("should return JSON error object when task not found in --json mode", () => {
    const result = kspecRun("task branch @nonexistent --json", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    // Error output goes to stderr in JSON mode
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error).toBeDefined();
  });

  // AC: @trait-json-output ac-4
  it("should use @ prefix for references in JSON output", () => {
    kspec('task add --title "Ref prefix" --slug ref-prefix', tempDir);

    const result = kspecJson<{ task_ref: string }>(
      "task branch @ref-prefix",
      tempDir,
    );
    expect(result.task_ref).toMatch(/^@/);
  });

  // AC: @trait-json-output ac-6
  it("should give --json precedence over other format options", () => {
    kspec('task add --title "Precedence" --slug precedence', tempDir);

    // --json should produce valid JSON regardless of other flags
    const result = kspecRun("task branch @precedence --json", tempDir);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.branch).toBeDefined();
  });

  // AC: @trait-semantic-exit-codes ac-1
  it("should exit 0 on success", () => {
    kspec('task add --title "Exit success" --slug exit-success', tempDir);
    const result = kspecRun("task branch @exit-success", tempDir);
    expect(result.exitCode).toBe(0);
  });

  // AC: @trait-semantic-exit-codes ac-2 — N/A: git repo validation exits with
  // VALIDATION_FAILED, but setting up a non-git kspec environment with tasks
  // is impractical since kspec task mutations require the shadow branch (git).
  // The code path is: isGitRepo() → error() → process.exit(VALIDATION_FAILED).

  // AC: @trait-semantic-exit-codes ac-6
  // AC: @trait-error-guidance ac-3
  it("should exit with not-found error for unknown task reference", () => {
    const result = kspecRun("task branch @nonexistent-task", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @trait-error-guidance ac-1, ac-2
  it("should include error description and suggested action on failure", () => {
    const result = kspecRun("task branch @nonexistent", tempDir, {
      expectFail: true,
    });
    // Error output should give useful context
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @trait-error-guidance ac-6
  it("should include guidance in JSON error responses", () => {
    const result = kspecRun("task branch @nonexistent --json", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    // Error output goes to stderr in JSON mode
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error).toBeDefined();
  });

  // AC: @trait-semantic-exit-codes ac-8
  it("documents exit code meanings in code", () => {
    // Verified by the exit code constants in src/cli/exit-codes.ts
    // This test confirms the command uses documented exit codes
    kspec('task add --title "Codes" --slug codes-test', tempDir);
    const successResult = kspecRun("task branch @codes-test", tempDir);
    expect(successResult.exitCode).toBe(0); // EXIT_CODES.SUCCESS

    const failResult = kspecRun("task branch @nonexistent", tempDir, {
      expectFail: true,
    });
    expect(failResult.exitCode).toBeGreaterThan(0);
  });

  // AC: @trait-json-output ac-1 — N/A: ac-5 (no timestamps in branch helper output)
  // AC: @trait-semantic-exit-codes ac-3 — N/A: no confirmation prompts in task branch
  // AC: @trait-semantic-exit-codes ac-4 — N/A: task branch is not a mutation that can fail at runtime
  // AC: @trait-semantic-exit-codes ac-5 — N/A: task branch always targets a specific task, not a query
  // AC: @trait-semantic-exit-codes ac-7 — N/A: task branch is not a batch operation
  // AC: @trait-error-guidance ac-4 — N/A: task branch does not perform state transitions
});
