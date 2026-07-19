/**
 * Tests for portable task submission linkage
 * AC: @portable-task-submission-linkage ac-1, ac-2, ac-3, ac-4, ac-5
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
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
  upstream_ref: string | null;
  review_url: string | null;
  captured_at: string;
}

interface TaskWithLinkage {
  _ulid?: string;
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

  function createPlanScopedTask(slug: string): void {
    kspec(
      'plan add --title "UI Redesign Plan" --content "Plan branch linkage" --slug ui-redesign-plan',
      tempDir,
    );
    kspec('plan set @ui-redesign-plan --branch "feat/ui-redesign"', tempDir);
    kspec(`task add --title "${slug}" --slug ${slug}`, tempDir);
    kspec(`task set @${slug} --plan-ref @ui-redesign-plan`, tempDir);
  }

  function writeMatchingWorkspaceMetadata(taskSlug: string): void {
    fs.writeFileSync(
      path.join(tempDir, ".kspec-dispatch-workspace.json"),
      `${JSON.stringify(
        {
          workspaceId: `dispatch-workspace-${taskSlug}`,
          taskId: null,
          taskRef: `@${taskSlug}`,
          taskSlug,
          integrationTargetBranch: "feat/ui-redesign",
          mergeTargetBranch: "feat/ui-redesign",
          canonicalBranch: `dispatch/task/${taskSlug}/01abcdef`,
          workerWorktreeDir: tempDir,
          reviewerWorktreeDir: null,
          publicationMode: "manual_merge",
        },
        null,
        2,
      )}\n`,
    );
  }

  // AC: @portable-task-submission-linkage ac-1
  it("should capture branch and commit on submit from named branch", () => {
    // Create a named branch
    git("checkout -b feat/test-branch", tempDir);
    git("commit --allow-empty -m 'work on branch'", tempDir);

    kspec('task add --title "Linkage test" --slug linkage-test', tempDir);
    kspec("task start @linkage-test", tempDir);
    kspec("task submit @linkage-test", tempDir);

    const task = kspecJson<TaskWithLinkage>("task get @linkage-test --json", tempDir);
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
    kspec('task submit @url-linkage --review-url "https://github.com/org/repo/pull/42"', tempDir);

    const task = kspecJson<TaskWithLinkage>("task get @url-linkage --json", tempDir);
    expect(task.submission_linkage).toBeDefined();
    expect(task.submission_linkage!.review_url).toBe("https://github.com/org/repo/pull/42");
  });

  // AC: @portable-task-submission-linkage ac-1
  it("should capture remote, remote_url, and upstream_ref when upstream is configured", () => {
    // Create a bare remote to track
    const bareDir = `${tempDir}-bare`;
    execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });
    git(`remote add origin "${bareDir}"`, tempDir);
    git("checkout -b feat/remote-test", tempDir);
    git("push -u origin feat/remote-test", tempDir);

    kspec('task add --title "Remote test" --slug remote-test', tempDir);
    kspec("task start @remote-test", tempDir);
    kspec("task submit @remote-test", tempDir);

    const task = kspecJson<TaskWithLinkage>("task get @remote-test --json", tempDir);
    expect(task.submission_linkage).toBeDefined();
    expect(task.submission_linkage!.remote).toBe("origin");
    expect(task.submission_linkage!.remote_url).toContain(bareDir);
    expect(task.submission_linkage!.upstream_ref).toBe("refs/heads/feat/remote-test");

    // Cleanup bare repo
    execSync(`rm -rf "${bareDir}"`, { stdio: "pipe" });
  });

  // AC: @portable-task-submission-linkage ac-1
  it("should capture upstream_ref when local branch tracks a differently named remote branch", () => {
    // Create a bare remote and push a branch under a different name
    const bareDir = `${tempDir}-bare-diverge`;
    execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });
    git(`remote add origin "${bareDir}"`, tempDir);

    // Push local main as "release/v1" on the remote, then create a local
    // branch that tracks the differently named remote branch
    git("push origin main:release/v1", tempDir);
    git("checkout -b my-local-branch", tempDir);
    git("branch --set-upstream-to=origin/release/v1", tempDir);
    git("commit --allow-empty -m 'diverge work'", tempDir);

    kspec('task add --title "Diverge upstream" --slug diverge-upstream', tempDir);
    kspec("task start @diverge-upstream", tempDir);
    kspec("task submit @diverge-upstream", tempDir);

    const task = kspecJson<TaskWithLinkage>("task get @diverge-upstream --json", tempDir);
    expect(task.submission_linkage).toBeDefined();
    expect(task.submission_linkage!.branch).toBe("my-local-branch");
    expect(task.submission_linkage!.remote).toBe("origin");
    // The upstream ref should be the REMOTE branch name, not the local branch name
    expect(task.submission_linkage!.upstream_ref).toBe("refs/heads/release/v1");

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

    const task = kspecJson<TaskWithLinkage>("task get @json-linkage --json", tempDir);
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

    kspec('task add --title "Detached test" --slug detached-test', tempDir);
    kspec("task start @detached-test", tempDir);

    const result = kspecRun("task submit @detached-test", tempDir);
    expect(result.stdout).toContain("Submitted task for review");

    // Should warn about detached HEAD
    expect(result.stdout + result.stderr).toMatch(/detached HEAD|no branch name/i);

    const task = kspecJson<TaskWithLinkage>("task get @detached-test --json", tempDir);
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

    kspec('task add --title "Detached display" --slug detached-display', tempDir);
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

    const before = kspecJson<TaskWithLinkage>("task get @repair-test --json", tempDir);
    expect(before.submission_linkage).toBeDefined();
    const originalCommit = before.submission_linkage!.commit;

    // Make a new commit (simulating branch rename / PR head change)
    git("commit --allow-empty -m 'new work'", tempDir);

    // Repair: re-capture from current git context
    kspec("task set @repair-test --submission-linkage", tempDir);

    const after = kspecJson<TaskWithLinkage>("task get @repair-test --json", tempDir);
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

    const before = kspecJson<TaskWithLinkage>("task get @clear-linkage --json", tempDir);
    expect(before.submission_linkage).toBeDefined();

    kspec("task set @clear-linkage --clear-submission-linkage", tempDir);

    const after = kspecJson<TaskWithLinkage>("task get @clear-linkage --json", tempDir);
    expect(after.submission_linkage).toBeNull();
    // Status preserved
    expect(after.status).toBe("pending_review");
  });

  // AC: @portable-task-submission-linkage ac-4
  it("should backfill linkage on task that predates linkage capture", () => {
    // Create task without going through submit (simulating old task)
    kspec('task add --title "Backfill test" --slug backfill-test', tempDir);

    const before = kspecJson<TaskWithLinkage>("task get @backfill-test --json", tempDir);
    expect(before.submission_linkage).toBeUndefined();

    // Backfill from current git context
    kspec("task set @backfill-test --submission-linkage", tempDir);

    const after = kspecJson<TaskWithLinkage>("task get @backfill-test --json", tempDir);
    expect(after.submission_linkage).toBeDefined();
    expect(after.submission_linkage!.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  // AC: @portable-task-submission-linkage ac-5
  it("should fall back to dispatch config base_branch for upstream_ref when no git upstream tracking", () => {
    // Write dispatch config with base_branch
    fs.writeFileSync(path.join(tempDir, "kspec.config.yaml"), "dispatch:\n  base_branch: dev\n");

    // Create a branch without upstream tracking
    git("checkout -b feat/no-upstream", tempDir);
    git("commit --allow-empty -m 'feature work'", tempDir);

    kspec('task add --title "Dispatch fallback" --slug dispatch-fallback', tempDir);
    kspec("task start @dispatch-fallback", tempDir);
    kspec("task submit @dispatch-fallback", tempDir);

    const task = kspecJson<TaskWithLinkage>("task get @dispatch-fallback --json", tempDir);
    expect(task.submission_linkage).toBeDefined();
    expect(task.submission_linkage!.branch).toBe("feat/no-upstream");
    // No git upstream tracking, but dispatch config provides fallback
    expect(task.submission_linkage!.upstream_ref).toBe("dev");
  });

  // AC: @portable-task-submission-linkage ac-5
  // AC: @plan-branch-dispatch-target ac-submission-linkage-plan-target
  it("should prefer matching manual_merge workspace integration target over dispatch config fallback on submit", () => {
    fs.writeFileSync(path.join(tempDir, "kspec.config.yaml"), "dispatch:\n  base_branch: dev\n");
    git("branch dev", tempDir);
    git("branch feat/ui-redesign", tempDir);
    git("checkout -b dispatch/task/plan-submit-fallback/01abcdef", tempDir);
    git("commit --allow-empty -m 'plan scoped submit work'", tempDir);

    createPlanScopedTask("plan-submit-fallback");
    writeMatchingWorkspaceMetadata("plan-submit-fallback");

    kspec("task start @plan-submit-fallback", tempDir);
    kspec("task submit @plan-submit-fallback", tempDir);

    const task = kspecJson<TaskWithLinkage>("task get @plan-submit-fallback --json", tempDir);
    expect(task.submission_linkage).toBeDefined();
    expect(task.submission_linkage!.branch).toBe("dispatch/task/plan-submit-fallback/01abcdef");
    expect(task.submission_linkage!.upstream_ref).toBe("feat/ui-redesign");
  });

  // AC: @portable-task-submission-linkage ac-5
  // AC: @plan-branch-dispatch-target ac-submission-linkage-plan-target
  it("should prefer available owning plan branch over dispatch config fallback when repairing linkage", () => {
    fs.writeFileSync(path.join(tempDir, "kspec.config.yaml"), "dispatch:\n  base_branch: dev\n");
    git("branch dev", tempDir);
    git("branch feat/ui-redesign", tempDir);
    git("checkout -b dispatch/task/plan-repair-fallback/01abcdef", tempDir);
    git("commit --allow-empty -m 'plan scoped repair work'", tempDir);

    createPlanScopedTask("plan-repair-fallback");

    kspec("task set @plan-repair-fallback --submission-linkage", tempDir);

    const task = kspecJson<TaskWithLinkage>("task get @plan-repair-fallback --json", tempDir);
    expect(task.submission_linkage).toBeDefined();
    expect(task.submission_linkage!.branch).toBe("dispatch/task/plan-repair-fallback/01abcdef");
    expect(task.submission_linkage!.upstream_ref).toBe("feat/ui-redesign");
  });

  // AC: @portable-task-submission-linkage ac-5
  it("should prefer git upstream tracking over dispatch config fallback", () => {
    // Write dispatch config with base_branch
    fs.writeFileSync(path.join(tempDir, "kspec.config.yaml"), "dispatch:\n  base_branch: dev\n");

    // Create bare remote and set up upstream tracking
    const bareDir = `${tempDir}-bare-precedence`;
    execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });
    git(`remote add origin "${bareDir}"`, tempDir);
    git("checkout -b feat/with-upstream", tempDir);
    git("push -u origin feat/with-upstream", tempDir);

    kspec('task add --title "Upstream precedence" --slug upstream-precedence', tempDir);
    kspec("task start @upstream-precedence", tempDir);
    kspec("task submit @upstream-precedence", tempDir);

    const task = kspecJson<TaskWithLinkage>("task get @upstream-precedence --json", tempDir);
    expect(task.submission_linkage).toBeDefined();
    // Git upstream tracking takes precedence over dispatch config
    expect(task.submission_linkage!.upstream_ref).toBe("refs/heads/feat/with-upstream");

    execSync(`rm -rf "${bareDir}"`, { stdio: "pipe" });
  });

  // AC: @trait-error-guidance ac-1 — N/A: submission linkage capture is best-effort, not error-producing
  // AC: @trait-error-guidance ac-2 — N/A: no user-facing errors from linkage capture itself
  // AC: @trait-error-guidance ac-3 — N/A: submission linkage uses task refs, not linkage-specific refs
  // AC: @trait-error-guidance ac-4 — N/A: submission linkage does not introduce new state transitions
  // AC: @trait-error-guidance ac-5 — N/A: linkage validation is handled by Zod schema, not custom errors
  // AC: @trait-error-guidance ac-6 — N/A: linkage errors would be schema validation, covered by existing JSON error handling
});
