import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import { DispatchEngine } from "../src/agent-runtime/dispatch.js";
import {
  provisionDispatchWorkspace,
  reconcileDispatchWorkspaceLifecycle,
  reconcileDispatchWorkspaceArtifacts,
  reapDispatchWorkspace,
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

async function waitFor(assertion: () => Promise<void>, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

describe("dispatch workspace cleanup", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-workspace-cleanup-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-workspace-cleanup-policy ac-1
  it("removes reviewer snapshots after review while keeping the canonical worker worktree", async () => {
    await seedRepo(tempDir);
    await setupProjectWithReviewerAgent(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskId = testUlid("TASK", 21);
    const taskRef = `@${taskId}`;
    const workerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Cleanup Reviewer Snapshot",
        slugs: ["task-cleanup-reviewer-snapshot"],
      },
    });

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
        title: "Cleanup Reviewer Snapshot",
        slugs: ["task-cleanup-reviewer-snapshot"],
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

    await waitFor(async () => {
      expect(runSpy).toHaveBeenCalledTimes(1);
      await expect(
        fs.access(path.join(tempDir, ".kspec-worktrees", "task-cleanup-reviewer-snapshot-01task00-review")),
      ).rejects.toThrow();
    });

    await fs.access(workerWorkspace.cwd);
    const metadata = JSON.parse(
      await fs.readFile(workerWorkspace.metadataPath, "utf-8"),
    ) as { reviewerWorktreeDir: string | null };
    expect(metadata.reviewerWorktreeDir).toBeNull();

    await engine.stop();
  });

  // AC: @dispatch-workspace-cleanup-policy ac-2
  // AC: @dispatch-workspace-cleanup-policy ac-3
  it("schedules closing cleanup and reaps dispatch worktrees plus canonical branch", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 22)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Reap Closed Workspace",
        slugs: ["task-reap-closed-workspace"],
      },
    });

    const reconciled = await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: {
        title: "Reap Closed Workspace",
        slugs: ["task-reap-closed-workspace"],
      },
    });

    expect(reconciled?.metadata.lifecycleState).toBe("closing");
    expect(reconciled?.metadata.cleanupScheduledAt).toBeTruthy();

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    await expect(fs.access(workspace.cwd)).rejects.toThrow();
    expect(git(tempDir, "branch --list dispatch/task/task-reap-closed-workspace/01task00")).toBe("");
  });

  // AC: @dispatch-workspace-cleanup-policy ac-4
  it("marks cleanup_blocked when branch deletion is attempted while the task still has active ownership", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 23)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Blocked Cleanup Workspace",
        slugs: ["task-blocked-cleanup-workspace"],
      },
    });

    await reconcileDispatchWorkspaceLifecycle({
      projectDir: tempDir,
      taskRef,
      cleanupState: { integrationState: "merged", taskStatus: "completed" },
      task: {
        title: "Blocked Cleanup Workspace",
        slugs: ["task-blocked-cleanup-workspace"],
      },
    });

    const result = await reapDispatchWorkspace(tempDir, taskRef, {
      activeTaskRefs: [taskRef],
      task: {
        title: "Blocked Cleanup Workspace",
        slugs: ["task-blocked-cleanup-workspace"],
      },
    });

    expect(result).toEqual({
      taskRef,
      action: "cleanup_blocked",
      blockedReason: "Cleanup blocked: canonical branch still has an active dispatch invocation.",
    });

    const metadata = JSON.parse(
      await fs.readFile(workspace.metadataPath, "utf-8"),
    ) as { lifecycleState: string; cleanupBlockedReason: string | null };
    expect(metadata.lifecycleState).toBe("cleanup_blocked");
    expect(metadata.cleanupBlockedReason).toContain("active dispatch invocation");
    await fs.access(workspace.cwd);
    expect(git(tempDir, "branch --list dispatch/task/task-blocked-cleanup-workspace/01task00")).toContain(
      "dispatch/task/task-blocked-cleanup-workspace/01task00",
    );
  });

  // AC: @dispatch-workspace-cleanup-policy ac-4
  it("marks cleanup_blocked when branch deletion is attempted before integration is resolved", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 25)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Unresolved Integration Cleanup Workspace",
        slugs: ["task-unresolved-integration-cleanup-workspace"],
      },
    });

    const result = await reapDispatchWorkspace(tempDir, taskRef, {
      task: {
        title: "Unresolved Integration Cleanup Workspace",
        slugs: ["task-unresolved-integration-cleanup-workspace"],
      },
    });

    expect(result).toEqual({
      taskRef,
      action: "cleanup_blocked",
      blockedReason:
        "Cleanup blocked: workspace integration outcome is unresolved, so the canonical branch must be retained.",
    });

    const metadata = JSON.parse(
      await fs.readFile(workspace.metadataPath, "utf-8"),
    ) as {
      lifecycleState: string;
      cleanupBlockedReason: string | null;
      cleanupScheduledAt: string | null;
    };
    expect(metadata.lifecycleState).toBe("cleanup_blocked");
    expect(metadata.cleanupBlockedReason).toContain("integration outcome is unresolved");
    expect(metadata.cleanupScheduledAt).toBeTruthy();
    await fs.access(workspace.cwd);
    expect(
      git(
        tempDir,
        "branch --list dispatch/task/task-unresolved-integration-cleanup-workspace/01task00",
      ),
    ).toContain("dispatch/task/task-unresolved-integration-cleanup-workspace/01task00");
  });

  // AC: @dispatch-workspace-cleanup-policy ac-5
  it("cleans orphaned dispatch worktrees and branches during reconciliation", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 24)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Orphan Cleanup Workspace",
        slugs: ["task-orphan-cleanup-workspace"],
      },
    });

    await fs.rm(workspace.metadataPath, { force: true });
    await fs.mkdir(path.join(tempDir, ".kspec-worktrees", "orphan-dir"), { recursive: true });
    await fs.writeFile(path.join(tempDir, ".kspec-worktrees", "orphan-dir", "leftover.txt"), "orphan\n", "utf-8");
    git(tempDir, "branch dispatch/task/orphaned/no-metadata");

    await reconcileDispatchWorkspaceArtifacts(tempDir);

    await expect(fs.access(workspace.cwd)).rejects.toThrow();
    await expect(fs.access(path.join(tempDir, ".kspec-worktrees", "orphan-dir"))).rejects.toThrow();
    expect(git(tempDir, "branch --list dispatch/task/task-orphan-cleanup-workspace/01task00")).toBe("");
    expect(git(tempDir, "branch --list dispatch/task/orphaned/no-metadata")).toBe("");
  });
});

// AC: @trait-error-guidance ac-1 — N/A: cleanup runs in the dispatch runtime and reports through task notes/logging, not direct CLI errors.
// AC: @trait-error-guidance ac-2 — N/A: dispatcher guidance is recorded in metadata/task notes rather than a user-facing command response here.
// AC: @trait-error-guidance ac-3 — N/A: cleanup reconciliation does not surface reference lookup errors to a direct CLI caller in this module test.
// AC: @trait-error-guidance ac-4 — N/A: invalid task state transitions are enforced by task commands, not by workspace cleanup helpers.
// AC: @trait-error-guidance ac-5 — N/A: cleanup helpers do not expose field-validation error payloads in this library-level path.
// AC: @trait-error-guidance ac-6 — N/A: workspace cleanup helpers do not implement a JSON CLI error mode.
