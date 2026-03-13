import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
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

async function readWorkspaceRecord(registryPath: string, taskRef: string): Promise<Record<string, any>> {
  const raw = YAML.parse(await fs.readFile(registryPath, "utf-8")) as {
    workspaces?: Array<Record<string, any>>;
  };
  return raw.workspaces?.find((workspace) => workspace.task_ref === taskRef) ?? {};
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
  // AC: @dispatch-invocation-worktree-isolation ac-3
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
  // AC: @dispatch-invocation-worktree-isolation ac-2
  it("creates reviewer snapshots as detached worktrees without checking out the canonical branch twice", async () => {
    await seedRepo(tempDir);
    await setupProjectWithReviewerAgent(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 13)}`;
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

    const reviewerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: {
        title: "Canonical Reviewer Snapshot",
        slugs: ["task-canonical-reviewer-snapshot"],
      },
    });
    expect(reviewerWorkspace.cwd).toBe(
      path.join(tempDir, ".kspec-worktrees", "task-canonical-reviewer-snapshot-01task00-review"),
    );
    expect(reviewerWorkspace.cwd).not.toBe(workerWorkspace.cwd);
    expect(git(reviewerWorkspace.cwd, "rev-parse HEAD")).toBe(canonicalHead);
    expect(git(reviewerWorkspace.cwd, "branch --show-current")).toBe("");

    const worktreeList = git(tempDir, "worktree list --porcelain");
    const canonicalBranchMentions = worktreeList
      .split("\n")
      .filter((line) => line === `branch refs/heads/${workerWorkspace.metadata.canonicalBranch}`);
    expect(canonicalBranchMentions).toHaveLength(1);
  });

  // AC: @dispatch-workspace-orientation-prompt ac-2
  it("persists orientation metadata into the workspace file for worker and reviewer provisioning", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 16)}`;
    const workerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Workspace Orientation Metadata",
        slugs: ["task-workspace-orientation-metadata"],
      },
    });

    const workerMetadata = JSON.parse(
      await fs.readFile(path.join(workerWorkspace.cwd, ".kspec-dispatch-workspace.json"), "utf-8"),
    ) as Record<string, any>;
    expect(workerMetadata).toMatchObject({
      taskRef,
      canonicalBranch: workerWorkspace.metadata.canonicalBranch,
      integrationTargetBranch: "agent-dev",
      publicationMode: workerWorkspace.metadata.publicationMode,
      workerWorktreeDir: workerWorkspace.cwd,
      reviewerWorktreeDir: null,
      healthStatus: "healthy",
    });
    expect(workerMetadata.bootstrap.roleStates.worker.status).toBe("not_run");
    expect(workerMetadata.bootstrap.roleStates.reviewer.status).toBe("not_run");

    const reviewerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: {
        title: "Workspace Orientation Metadata",
        slugs: ["task-workspace-orientation-metadata"],
      },
    });

    const reviewerMetadata = JSON.parse(
      await fs.readFile(path.join(workerWorkspace.cwd, ".kspec-dispatch-workspace.json"), "utf-8"),
    ) as Record<string, any>;
    expect(reviewerWorkspace.cwd).toMatch(/-review$/);
    expect(reviewerMetadata).toMatchObject({
      taskRef,
      canonicalBranch: workerWorkspace.metadata.canonicalBranch,
      integrationTargetBranch: "agent-dev",
      publicationMode: reviewerWorkspace.metadata.publicationMode,
      workerWorktreeDir: workerWorkspace.cwd,
      reviewerWorktreeDir: reviewerWorkspace.cwd,
      healthStatus: "healthy",
    });
    expect(reviewerMetadata.bootstrap.roleStates.worker.status).toBe("not_run");
    expect(reviewerMetadata.bootstrap.roleStates.reviewer.status).toBe("not_run");
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

  // AC: @canonical-task-workspace-contract ac-6
  it("persists cleanup eligibility into canonical workspace metadata during runtime reconciliation", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const completedTaskId = testUlid("TASK", 14);
    const completedTaskRef = `@${completedTaskId}`;
    const completedWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef: completedTaskRef,
      task: {
        title: "Cleanup Eligibility Completed",
        slugs: ["task-cleanup-eligibility-completed"],
      },
    });

    const cancelledTaskId = testUlid("TASK", 15);
    const cancelledTaskRef = `@${cancelledTaskId}`;
    const cancelledWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef: cancelledTaskRef,
      task: {
        title: "Cleanup Eligibility Cancelled",
        slugs: ["task-cleanup-eligibility-cancelled"],
      },
    });

    const engine = new DispatchEngine({
      projectDir: tempDir,
      specDir: tempDir,
      kspecCliPath: MOCK_KSPEC_CLI,
    });
    await engine.start();

    await engine.handleStateChange({
      taskId: completedTaskId,
      taskRef: completedTaskRef,
      fromStatus: "pending_review",
      toStatus: "completed",
      timestamp: Date.now(),
      task: {
        _ulid: completedTaskId,
        title: "Cleanup Eligibility Completed",
        slugs: ["task-cleanup-eligibility-completed"],
        status: "completed",
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

    let completedMetadata = await readWorkspaceRecord(
      completedWorkspace.metadataPath,
      completedTaskRef,
    );
    expect(completedMetadata).toMatchObject({
      cleanup: {
        eligible: true,
        reason: "integrated-into-base-branch",
      },
    });

    await engine.handleStateChange({
      taskId: completedTaskId,
      taskRef: completedTaskRef,
      fromStatus: "completed",
      toStatus: "pending",
      timestamp: Date.now(),
      task: {
        _ulid: completedTaskId,
        title: "Cleanup Eligibility Completed",
        slugs: ["task-cleanup-eligibility-completed"],
        status: "pending",
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

    completedMetadata = await readWorkspaceRecord(
      completedWorkspace.metadataPath,
      completedTaskRef,
    );
    expect(completedMetadata).toMatchObject({
      cleanup: {
        eligible: true,
        reason: "task-reset",
      },
    });

    await engine.handleStateChange({
      taskId: cancelledTaskId,
      taskRef: cancelledTaskRef,
      fromStatus: "in_progress",
      toStatus: "cancelled",
      timestamp: Date.now(),
      task: {
        _ulid: cancelledTaskId,
        title: "Cleanup Eligibility Cancelled",
        slugs: ["task-cleanup-eligibility-cancelled"],
        status: "cancelled",
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

    const cancelledMetadata = await readWorkspaceRecord(
      cancelledWorkspace.metadataPath,
      cancelledTaskRef,
    );
    expect(cancelledMetadata).toMatchObject({
      cleanup: {
        eligible: true,
        reason: "task-abandoned",
      },
    });

    await engine.stop();
  });
});

// AC: @trait-error-guidance ac-1 — N/A: dispatch worktree isolation is an internal runtime surface,
// not a user-facing CLI command.
// AC: @trait-error-guidance ac-2 — N/A: actionable guidance is captured in task notes/block reasons,
// not CLI stderr/stdout for this library surface.
// AC: @trait-error-guidance ac-3 — N/A: these tests do not exercise missing ref lookup UX.
// AC: @trait-error-guidance ac-4 — N/A: invalid state transition messaging belongs to task CLI flows.
// AC: @trait-error-guidance ac-5 — N/A: no structured field validation errors are surfaced here.
// AC: @trait-error-guidance ac-6 — N/A: this runtime surface has no --json error mode.
