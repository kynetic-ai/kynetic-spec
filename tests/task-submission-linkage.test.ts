/**
 * Tests for portable task submission linkage
 * AC: @portable-task-submission-linkage ac-1, ac-2, ac-3, ac-4
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

interface SubmissionLinkage {
  branch: string | null;
  commit: string;
  remote: string | null;
  remote_url: string | null;
  review_url: string | null;
  captured_at: string;
}

interface TaskWithLinkage {
  status: string;
  submitted_at?: string;
  review_url?: string;
  submission_linkage?: SubmissionLinkage | null;
}

describe("Integration: task submission linkage", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
    // Need an initial commit for HEAD to exist
    git("add -A", tempDir);
    git('commit -m "initial"', tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @portable-task-submission-linkage ac-1
  it("should capture branch and commit on submit from named branch", () => {
    // Create a named branch
    git("checkout -b feat/test-branch", tempDir);
    git("commit --allow-empty -m 'work on branch'", tempDir);

    kspec('task add --title "Linkage test" --slug linkage-test', tempDir);
    kspec("task start @linkage-test", tempDir);
    kspec("task submit @linkage-test", tempDir);

    const task = kspecJson<TaskWithLinkage>(
      "task get @linkage-test --json",
      tempDir,
    );
    expect(task.status).toBe("pending_review");
    expect(task.submission_linkage).toBeDefined();
    expect(task.submission_linkage!.branch).toBe("feat/test-branch");
    expect(task.submission_linkage!.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(task.submission_linkage!.captured_at).toBeDefined();
  });

  // AC: @portable-task-submission-linkage ac-1
  it("should include review URL in submission linkage when provided", () => {
    kspec('task add --title "URL linkage" --slug url-linkage', tempDir);
    kspec("task start @url-linkage", tempDir);
    kspec(
      'task submit @url-linkage --review-url "https://github.com/org/repo/pull/42"',
      tempDir,
    );

    const task = kspecJson<TaskWithLinkage>(
      "task get @url-linkage --json",
      tempDir,
    );
    expect(task.submission_linkage).toBeDefined();
    expect(task.submission_linkage!.review_url).toBe(
      "https://github.com/org/repo/pull/42",
    );
  });

  // AC: @portable-task-submission-linkage ac-1
  it("should capture remote and remote_url when upstream is configured", () => {
    // Create a bare remote to track
    const bareDir = tempDir + "-bare";
    execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });
    git(`remote add origin "${bareDir}"`, tempDir);
    git("checkout -b feat/remote-test", tempDir);
    git("push -u origin feat/remote-test", tempDir);

    kspec('task add --title "Remote test" --slug remote-test', tempDir);
    kspec("task start @remote-test", tempDir);
    kspec("task submit @remote-test", tempDir);

    const task = kspecJson<TaskWithLinkage>(
      "task get @remote-test --json",
      tempDir,
    );
    expect(task.submission_linkage).toBeDefined();
    expect(task.submission_linkage!.remote).toBe("origin");
    expect(task.submission_linkage!.remote_url).toContain(bareDir);

    // Cleanup bare repo
    execSync(`rm -rf "${bareDir}"`, { stdio: "pipe" });
  });

  // AC: @portable-task-submission-linkage ac-2
  it("should show submission linkage in task get human output", () => {
    git("checkout -b feat/display-test", tempDir);
    kspec('task add --title "Display test" --slug display-linkage', tempDir);
    kspec("task start @display-linkage", tempDir);
    kspec("task submit @display-linkage", tempDir);

    const output = kspec("task get @display-linkage", tempDir);
    expect(output).toContain("Submission Linkage");
    expect(output).toContain("feat/display-test");
    expect(output).toContain("Commit:");
  });

  // AC: @portable-task-submission-linkage ac-2
  it("should include submission_linkage as machine-readable state in JSON", () => {
    kspec('task add --title "JSON test" --slug json-linkage', tempDir);
    kspec("task start @json-linkage", tempDir);
    kspec("task submit @json-linkage", tempDir);

    const task = kspecJson<TaskWithLinkage>(
      "task get @json-linkage --json",
      tempDir,
    );
    expect(task.submission_linkage).toBeDefined();
    expect(typeof task.submission_linkage!.commit).toBe("string");
    expect(typeof task.submission_linkage!.captured_at).toBe("string");
    // branch is string or null
    expect(
      task.submission_linkage!.branch === null ||
        typeof task.submission_linkage!.branch === "string",
    ).toBe(true);
  });

  // AC: @portable-task-submission-linkage ac-3
  it("should record commit even with detached HEAD and warn", () => {
    // Create a commit and detach from it
    git("commit --allow-empty -m 'detach target'", tempDir);
    const commitHash = execSync("git rev-parse HEAD", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    git(`checkout ${commitHash}`, tempDir);

    kspec(
      'task add --title "Detached test" --slug detached-test',
      tempDir,
    );
    kspec("task start @detached-test", tempDir);

    const result = kspecRun("task submit @detached-test", tempDir);
    expect(result.stdout).toContain("Submitted task for review");

    // Should warn about detached HEAD
    expect(result.stdout + result.stderr).toMatch(
      /detached HEAD|no branch name/i,
    );

    const task = kspecJson<TaskWithLinkage>(
      "task get @detached-test --json",
      tempDir,
    );
    expect(task.submission_linkage).toBeDefined();
    expect(task.submission_linkage!.branch).toBeNull();
    expect(task.submission_linkage!.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  // AC: @portable-task-submission-linkage ac-3
  it("should show detached indicator in human display when branch is null", () => {
    git("commit --allow-empty -m 'detach target 2'", tempDir);
    const commitHash = execSync("git rev-parse HEAD", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    git(`checkout ${commitHash}`, tempDir);

    kspec(
      'task add --title "Detached display" --slug detached-display',
      tempDir,
    );
    kspec("task start @detached-display", tempDir);
    kspec("task submit @detached-display", tempDir);

    const output = kspec("task get @detached-display", tempDir);
    expect(output).toContain("(detached)");
  });

  // AC: @portable-task-submission-linkage ac-4
  it("should repair submission linkage via task set --submission-linkage", () => {
    // Submit from main (captures main branch linkage)
    kspec('task add --title "Repair test" --slug repair-test', tempDir);
    kspec("task start @repair-test", tempDir);
    kspec("task submit @repair-test", tempDir);

    const before = kspecJson<TaskWithLinkage>(
      "task get @repair-test --json",
      tempDir,
    );
    expect(before.submission_linkage).toBeDefined();
    const originalCommit = before.submission_linkage!.commit;

    // Make a new commit (simulating branch rename / PR head change)
    git("commit --allow-empty -m 'new work'", tempDir);

    // Repair: re-capture from current git context
    kspec("task set @repair-test --submission-linkage", tempDir);

    const after = kspecJson<TaskWithLinkage>(
      "task get @repair-test --json",
      tempDir,
    );
    expect(after.submission_linkage).toBeDefined();
    // Commit should be different after repair
    expect(after.submission_linkage!.commit).not.toBe(originalCommit);
    // Status should NOT have changed (no reset)
    expect(after.status).toBe("pending_review");
  });

  // AC: @portable-task-submission-linkage ac-4
  it("should clear submission linkage via task set --clear-submission-linkage", () => {
    kspec('task add --title "Clear test" --slug clear-linkage', tempDir);
    kspec("task start @clear-linkage", tempDir);
    kspec("task submit @clear-linkage", tempDir);

    const before = kspecJson<TaskWithLinkage>(
      "task get @clear-linkage --json",
      tempDir,
    );
    expect(before.submission_linkage).toBeDefined();

    kspec("task set @clear-linkage --clear-submission-linkage", tempDir);

    const after = kspecJson<TaskWithLinkage>(
      "task get @clear-linkage --json",
      tempDir,
    );
    expect(after.submission_linkage).toBeNull();
    // Status preserved
    expect(after.status).toBe("pending_review");
  });

  // AC: @portable-task-submission-linkage ac-4
  it("should backfill linkage on task that predates linkage capture", () => {
    // Create task without going through submit (simulating old task)
    kspec('task add --title "Backfill test" --slug backfill-test', tempDir);

    const before = kspecJson<TaskWithLinkage>(
      "task get @backfill-test --json",
      tempDir,
    );
    expect(before.submission_linkage).toBeUndefined();

    // Backfill from current git context
    kspec("task set @backfill-test --submission-linkage", tempDir);

    const after = kspecJson<TaskWithLinkage>(
      "task get @backfill-test --json",
      tempDir,
    );
    expect(after.submission_linkage).toBeDefined();
    expect(after.submission_linkage!.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  // AC: @trait-error-guidance ac-1 — N/A: submission linkage capture is best-effort, not error-producing
  // AC: @trait-error-guidance ac-2 — N/A: no user-facing errors from linkage capture itself
  // AC: @trait-error-guidance ac-3 — N/A: submission linkage uses task refs, not linkage-specific refs
  // AC: @trait-error-guidance ac-4 — N/A: submission linkage does not introduce new state transitions
  // AC: @trait-error-guidance ac-5 — N/A: linkage validation is handled by Zod schema, not custom errors
  // AC: @trait-error-guidance ac-6 — N/A: linkage errors would be schema validation, covered by existing JSON error handling
});
