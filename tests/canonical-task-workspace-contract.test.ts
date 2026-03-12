import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import { DispatchEngine } from "../src/agent-runtime/dispatch.js";
import {
  provisionDispatchWorkspace,
  resolveDispatchWorkspaceCleanupState,
} from "../src/agent-runtime/workspace.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  testUlid,
} from "./helpers/cli.js";

const MOCK_KSPEC_CLI = path.join(__dirname, "mocks", "kspec-capture-mock.cjs");

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

async function seedRepo(dir: string): Promise<void> {
  initGitRepo(dir);
  await fs.writeFile(path.join(dir, "README.md"), "seed\n", "utf-8");
  git(dir, "add README.md");
  git(dir, 'commit -m "init"');
}

async function setupProjectWithReviewerAgent(dir: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: Test Project\n',
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "kynetic.meta.yaml"),
    [
      'kynetic_meta: "1.0"',
      "agents:",
      "  - _ulid: 01AGNT00000000000000000000",
      "    id: pr-reviewer",
      '    name: "PR Reviewer"',
      "    dispatch:",
      "      - on: task.pending_review",
      "    concurrency:",
      "      max_concurrent: 1",
      "    adapter: mock-acp",
      "    auto_approve: false",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(path.join(dir, "project.tasks.yaml"), "tasks: []\n", "utf-8");
}

describe("canonical task workspace contract", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-canonical-task-workspace-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @canonical-task-workspace-contract ac-1
  // AC: @canonical-task-workspace-contract ac-5
  it("creates one canonical task branch with deterministic naming and records the branch point commit", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    const baseCommit = git(tempDir, "rev-parse agent-dev");

    const taskRef = `@${testUlid("TASK", 11)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Implement Canonical Task Workspace Contract",
        slugs: ["task-implement-canonical-task-workspace-contract"],
      },
    });

    expect(workspace.metadata.canonicalBranch).toBe(
      "dispatch/task/task-implement-canonical-task-workspace-contract/01task00",
    );
    expect(workspace.cwd).toBe(
      path.join(tempDir, ".kspec-worktrees", "task-implement-canonical-task-workspace-contract-01task00"),
    );
    expect(workspace.metadata.baseBranch).toBe("agent-dev");
    expect(workspace.metadata.baseBranchPoint).toBe(baseCommit);
    expect(workspace.metadata.canonicalBranchHead).toBe(baseCommit);
    expect(workspace.metadata.workerWorktreeDir).toBe(workspace.cwd);
    expect(workspace.metadata.reviewerWorktreeDir).toBeNull();
  });

  // AC: @canonical-task-workspace-contract ac-2
  // AC: @canonical-task-workspace-contract ac-4
  it("reuses the same canonical worker branch lineage across repeated worker and fix-cycle preparation", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 12)}`;
    const first = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Canonical Branch Reuse",
        slugs: ["task-canonical-branch-reuse"],
      },
    });

    await fs.writeFile(path.join(first.cwd, "worker.txt"), "worker change\n", "utf-8");
    git(first.cwd, "add worker.txt");
    git(first.cwd, 'commit -m "worker progress"');
    const workerHead = git(first.cwd, "rev-parse HEAD");

    git(tempDir, "checkout main");
    const second = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "worker",
      task: {
        title: "Canonical Branch Reuse",
        slugs: ["task-canonical-branch-reuse"],
      },
    });

    expect(second.cwd).toBe(first.cwd);
    expect(second.metadata.canonicalBranch).toBe(first.metadata.canonicalBranch);
    expect(second.metadata.baseBranchPoint).toBe(first.metadata.baseBranchPoint);
    expect(second.metadata.canonicalBranchHead).toBe(workerHead);
  });

  // AC: @canonical-task-workspace-contract ac-3
  it("creates reviewer snapshots as detached worktrees without checking out the canonical branch twice", async () => {
    await seedRepo(tempDir);
    await setupProjectWithReviewerAgent(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskId = testUlid("TASK", 13);
    const taskRef = `@${taskId}`;
    const workerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Canonical Reviewer Snapshot",
        slugs: ["task-canonical-reviewer-snapshot"],
      },
    });

    await fs.writeFile(path.join(workerWorkspace.cwd, "review-target.txt"), "v1\n", "utf-8");
    git(workerWorkspace.cwd, "add review-target.txt");
    git(workerWorkspace.cwd, 'commit -m "worker change for review"');
    const canonicalHead = git(workerWorkspace.cwd, "rev-parse HEAD");

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as never,
      outcome: "success",
      durationMs: 1,
    });

    const engine = new DispatchEngine({
      projectDir: tempDir,
      specDir: tempDir,
      kspecCliPath: MOCK_KSPEC_CLI,
    });

    await engine.start();
    await engine.handleStateChange({
      taskId,
      taskRef,
      fromStatus: "in_progress",
      toStatus: "pending_review",
      timestamp: Date.now(),
      task: {
        _ulid: taskId,
        title: "Canonical Reviewer Snapshot",
        slugs: ["task-canonical-reviewer-snapshot"],
        status: "pending_review",
        type: "task",
        priority: 1,
        blocked_by: [],
        depends_on: [],
        context: [],
        tags: [],
        vcs_refs: [],
        notes: [],
        todos: [],
        created_at: new Date().toISOString(),
        automation: "eligible",
      } as never,
    });

    for (let i = 0; i < 40 && runSpy.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(runSpy).toHaveBeenCalledTimes(1);
    const invocation = runSpy.mock.calls[0][0];
    expect(invocation.cwd).toBe(
      path.join(tempDir, ".kspec-worktrees", "task-canonical-reviewer-snapshot-01task00-review"),
    );
    expect(invocation.cwd).not.toBe(workerWorkspace.cwd);
    expect(git(invocation.cwd, "rev-parse HEAD")).toBe(canonicalHead);
    expect(git(invocation.cwd, "branch --show-current")).toBe("");

    const worktreeList = git(tempDir, "worktree list --porcelain");
    const canonicalBranchMentions = worktreeList
      .split("\n")
      .filter((line) => line === `branch refs/heads/${workerWorkspace.metadata.canonicalBranch}`);
    expect(canonicalBranchMentions).toHaveLength(1);

    await engine.stop();
  });

  // AC: @canonical-task-workspace-contract ac-6
  it("marks canonical task branches cleanup-eligible after merge, abandonment, or reset reconciliation", () => {
    expect(resolveDispatchWorkspaceCleanupState({ integrationState: "merged" })).toEqual({
      cleanupEligible: true,
      cleanupReason: "integrated-into-base-branch",
    });
    expect(resolveDispatchWorkspaceCleanupState({ integrationState: "abandoned" })).toEqual({
      cleanupEligible: true,
      cleanupReason: "task-abandoned",
    });
    expect(resolveDispatchWorkspaceCleanupState({ integrationState: "reset" })).toEqual({
      cleanupEligible: true,
      cleanupReason: "task-reset",
    });
    expect(resolveDispatchWorkspaceCleanupState({ integrationState: "pending" })).toEqual({
      cleanupEligible: false,
      cleanupReason: null,
    });
  });
});
