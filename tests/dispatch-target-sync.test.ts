import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import * as workspaceModule from "../src/agent-runtime/workspace.js";
import { DispatchEngine, type TargetSyncResult } from "../src/agent-runtime/dispatch.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  testUlid,
} from "./helpers/cli.js";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

function gitSucceeds(cwd: string, command: string): boolean {
  try {
    execSync(`git ${command}`, {
      cwd,
      stdio: "pipe",
      encoding: "utf-8",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Set up a bare remote repo and a local project repo with origin pointing to it.
 * Returns { projectDir, remoteDir }. Both on "dev" as the base branch.
 */
async function setupProjectWithRemote(): Promise<{
  projectDir: string;
  remoteDir: string;
}> {
  const remoteDir = await createTempDir("kspec-target-sync-remote-");
  git(remoteDir, "init --bare");

  const projectDir = await createTempDir("kspec-target-sync-project-");
  initGitRepo(projectDir);
  await fs.writeFile(path.join(projectDir, "README.md"), "seed\n", "utf-8");
  git(projectDir, "add README.md");
  git(projectDir, 'commit -m "init"');
  git(projectDir, "checkout -b dev");
  await fs.writeFile(path.join(projectDir, "dev.txt"), "dev\n", "utf-8");
  git(projectDir, "add dev.txt");
  git(projectDir, 'commit -m "dev branch"');
  git(projectDir, `remote add origin "${remoteDir}"`);
  git(projectDir, "push -u origin dev");

  return { projectDir, remoteDir };
}

async function setupProjectFiles(projectDir: string, baseBranch = "dev"): Promise<void> {
  await fs.writeFile(
    path.join(projectDir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: Test Project\n',
    "utf-8",
  );
  await fs.writeFile(
    path.join(projectDir, "kynetic.meta.yaml"),
    [
      'kynetic_meta: "1.0"',
      "agents:",
      "  - _ulid: 01AGNT00000000000000000000",
      "    id: test-worker",
      '    name: "Test Worker"',
      "    dispatch:",
      "      - on: task.ready",
      "    concurrency:",
      "      max_concurrent: 1",
      "    adapter: mock-acp",
      "    auto_approve: false",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    path.join(projectDir, "kspec.config.yaml"),
    `dispatch:\n  base_branch: ${baseBranch}\n  sync_interval: 60\n  remote_sync: true\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(projectDir, "project.tasks.yaml"),
    "tasks: []\n",
    "utf-8",
  );
}

async function pushRemoteCommit(
  remoteDir: string,
  branch: string,
  fileName: string,
  content: string,
  message: string,
): Promise<string> {
  const cloneDir = await createTempDir("kspec-target-sync-clone-");
  try {
    git(cloneDir, `clone "${remoteDir}" .`);
    git(cloneDir, `checkout ${branch}`);
    await fs.writeFile(path.join(cloneDir, fileName), content, "utf-8");
    git(cloneDir, `add ${fileName}`);
    git(cloneDir, `commit -m "${message}"`);
    git(cloneDir, `push origin ${branch}`);
    return git(cloneDir, `rev-parse ${branch}`);
  } finally {
    await cleanupTempDir(cloneDir);
  }
}

describe("dispatch target branch sync", () => {
  let projectDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    } as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (projectDir) await cleanupTempDir(projectDir);
    if (remoteDir) await cleanupTempDir(remoteDir);
  });

  // AC: @dispatch-remote-branch-sync ac-pull-target-on-start
  it("syncs integration target from remote on engine start before bootstrap", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);

    // Push a new commit to remote via a clone so local is behind
    await pushRemoteCommit(
      remoteDir,
      "dev",
      "new-feature.txt",
      "feature\n",
      "new feature on remote",
    );

    // Confirm local is behind
    const localBefore = git(projectDir, "rev-parse dev");
    git(projectDir, "fetch origin");
    const remoteTip = git(projectDir, "rev-parse origin/dev");
    expect(localBefore).not.toBe(remoteTip);

    // Reset fetch so engine sees a stale state
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // After start, local dev should match remote tip
    const localAfter = git(projectDir, "rev-parse dev");
    expect(localAfter).toBe(remoteTip);

    const syncStatus = engine.getTargetSyncStatus();
    expect(syncStatus.enabled).toBe(true);
    expect(syncStatus.lastSyncTimestamp).toBeGreaterThan(0);

    await engine.stop();
  });

  // AC: @dispatch-integration-mutation-scope ac-1
  // AC: @dispatch-integration-mutation-scope ac-2
  it("syncs only the shared checkout while leaving task worktrees untouched", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const taskWorktreeDir = `${projectDir}-task-worktree`;
    execSync(`git worktree add "${taskWorktreeDir}" -b feat/task-sync-surface`, {
      cwd: projectDir,
      stdio: "pipe",
    });

    try {
      const taskHeadBefore = git(taskWorktreeDir, "rev-parse HEAD");
      const taskStatusBefore = git(taskWorktreeDir, "status --short");
      const remoteTip = await pushRemoteCommit(
        remoteDir,
        "dev",
        "shared-checkout.txt",
        "shared\n",
        "shared checkout sync",
      );

      const engine = new DispatchEngine({
        projectDir,
        reconcileIntervalMs: 0,
        coalesceWindowMs: 0,
      });
      await engine.start();

      expect(git(projectDir, "rev-parse dev")).toBe(remoteTip);
      expect(git(taskWorktreeDir, "rev-parse HEAD")).toBe(taskHeadBefore);
      expect(git(taskWorktreeDir, "status --short")).toBe(taskStatusBefore);

      await engine.stop();
    } finally {
      git(projectDir, `worktree remove --force "${taskWorktreeDir}"`);
    }
  });

  // AC: @dispatch-integration-mutation-scope ac-3
  it("reuses the same shared checkout mutation surface across repeated syncs", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const taskWorktreeDir = `${projectDir}-task-worktree-repeat`;
    execSync(`git worktree add "${taskWorktreeDir}" -b feat/task-sync-repeat`, {
      cwd: projectDir,
      stdio: "pipe",
    });

    try {
      const taskHeadBefore = git(taskWorktreeDir, "rev-parse HEAD");
      const firstRemoteTip = await pushRemoteCommit(
        remoteDir,
        "dev",
        "first-sync.txt",
        "first\n",
        "first sync commit",
      );

      const engine = new DispatchEngine({
        projectDir,
        reconcileIntervalMs: 0,
        coalesceWindowMs: 0,
      });
      await engine.start();

      expect(git(projectDir, "branch --show-current")).toBe("dev");
      expect(git(projectDir, "rev-parse dev")).toBe(firstRemoteTip);
      expect(git(taskWorktreeDir, "rev-parse HEAD")).toBe(taskHeadBefore);

      const secondRemoteTip = await pushRemoteCommit(
        remoteDir,
        "dev",
        "second-sync.txt",
        "second\n",
        "second sync commit",
      );
      const result = await engine._syncTargetBranch();

      expect(result).toBe("synced");
      expect(git(projectDir, "branch --show-current")).toBe("dev");
      expect(git(projectDir, "rev-parse dev")).toBe(secondRemoteTip);
      expect(git(taskWorktreeDir, "rev-parse HEAD")).toBe(taskHeadBefore);

      await engine.stop();
    } finally {
      git(projectDir, `worktree remove --force "${taskWorktreeDir}"`);
    }
  });

  // AC: @dispatch-shared-checkout-safety ac-1
  // AC: @dispatch-shared-checkout-safety ac-2
  it("repairs clean shared-checkout drift before syncing the integration target", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const previousTip = git(projectDir, "rev-parse dev");
    const branchTip = await pushRemoteCommit(
      remoteDir,
      "dev",
      "dev.txt",
      "dev\nremote drift\n",
      "remote drift tip",
    );
    git(projectDir, "fetch origin");
    git(projectDir, `update-ref refs/heads/dev ${branchTip}`);

    expect(git(projectDir, "rev-parse HEAD")).toBe(branchTip);
    expect(git(projectDir, "status --short")).toContain("dev.txt");

    const remoteTip = await pushRemoteCommit(
      remoteDir,
      "dev",
      "dev.txt",
      "dev\nremote drift\nremote after drift\n",
      "remote after drift",
    );

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    expect(previousTip).not.toBe(branchTip);
    expect(git(projectDir, "rev-parse dev")).toBe(remoteTip);
    expect(gitSucceeds(projectDir, "diff --quiet")).toBe(true);
    expect(gitSucceeds(projectDir, "diff --cached --quiet")).toBe(true);
    expect(await workspaceModule.ensureDispatchIntegrationTargetCheckoutCoherence(projectDir, "dev")).toEqual({
      repaired: false,
      drifted: false,
      previousCommit: null,
    });

    await engine.stop();
  });

  // AC: @dispatch-integration-mutation-scope ac-4
  it("refuses sync with actionable guidance when the shared checkout is on another branch", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout -b human-feature");

    await pushRemoteCommit(
      remoteDir,
      "dev",
      "remote-ahead.txt",
      "ahead\n",
      "remote ahead",
    );

    const humanHeadBefore = git(projectDir, "rev-parse human-feature");
    const localDevBefore = git(projectDir, "rev-parse dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    const result = await engine._syncTargetBranch();

    expect(result).toBe("unsafe_target");
    expect(git(projectDir, "rev-parse human-feature")).toBe(humanHeadBefore);
    expect(git(projectDir, "rev-parse dev")).toBe(localDevBefore);
    expect(engine.getDegradedState().active).toBe(true);
    expect(engine.getDegradedState().reason).toContain('current branch is "human-feature"');
    expect(engine.getDegradedState().reason).toContain('Check out "dev"');

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-pull-ff-only
  it("advances local branch only via fast-forward — no merge commits", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);

    // Push a new commit on remote
    const cloneDir = await createTempDir("kspec-target-sync-clone-");
    try {
      git(cloneDir, `clone "${remoteDir}" .`);
      git(cloneDir, "checkout dev");
      await fs.writeFile(path.join(cloneDir, "ff-test.txt"), "ff\n", "utf-8");
      git(cloneDir, "add ff-test.txt");
      git(cloneDir, 'commit -m "ff commit"');
      git(cloneDir, "push origin dev");
    } finally {
      await cleanupTempDir(cloneDir);
    }

    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Verify no merge commits — the last commit message should be "ff commit"
    const lastCommitMsg = git(projectDir, "log -1 --format=%s");
    expect(lastCommitMsg).toBe("ff commit");

    // Verify linear history (no merges)
    const mergeCommits = git(projectDir, "log --merges --oneline dev");
    expect(mergeCommits).toBe("");

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-pull-target-periodic
  it("syncs target branch during periodic reconciliation when stale and no reviewer is active", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();
    const afterStartTip = git(projectDir, "rev-parse dev");

    // Push a new commit to remote
    const cloneDir = await createTempDir("kspec-target-sync-clone-");
    try {
      git(cloneDir, `clone "${remoteDir}" .`);
      git(cloneDir, "checkout dev");
      await fs.writeFile(path.join(cloneDir, "periodic.txt"), "periodic\n", "utf-8");
      git(cloneDir, "add periodic.txt");
      git(cloneDir, 'commit -m "periodic commit"');
      git(cloneDir, "push origin dev");
    } finally {
      await cleanupTempDir(cloneDir);
    }

    // Reconcile when sync is NOT stale — should NOT sync
    // (engine.start() just synced, so _lastTargetSyncTimestamp is recent)
    await (engine as any)._reconcile();
    const tipAfterFreshReconcile = git(projectDir, "rev-parse dev");
    expect(tipAfterFreshReconcile).toBe(afterStartTip);

    // Make sync stale by backdating the timestamp beyond sync_interval
    (engine as any)._lastTargetSyncTimestamp = Date.now() - 120_000;

    // Reconcile when sync IS stale — should sync
    await (engine as any)._reconcile();
    const tipAfterStaleReconcile = git(projectDir, "rev-parse dev");
    expect(tipAfterStaleReconcile).not.toBe(afterStartTip);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-pull-target-periodic-deferred
  it("defers periodic sync when a reviewer invocation is active", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Simulate a reviewer being active by accessing internal state
    const invocationDetails = (engine as any).activeInvocationDetails as Map<string, any>;
    invocationDetails.set("test-reviewer-session", {
      invocationId: "test-inv",
      sessionId: "test-session",
      agentId: "test-reviewer",
      agentName: "Test Reviewer",
      taskRef: "@TASK123",
      role: "reviewer",
      startedAtMs: Date.now(),
    });

    // Verify reviewer detection
    expect((engine as any)._hasActiveReviewerInvocation()).toBe(true);

    // Push new commit to remote
    const cloneDir = await createTempDir("kspec-target-sync-clone-");
    try {
      git(cloneDir, `clone "${remoteDir}" .`);
      git(cloneDir, "checkout dev");
      await fs.writeFile(path.join(cloneDir, "deferred.txt"), "deferred\n", "utf-8");
      git(cloneDir, "add deferred.txt");
      git(cloneDir, 'commit -m "deferred commit"');
      git(cloneDir, "push origin dev");
    } finally {
      await cleanupTempDir(cloneDir);
    }

    const tipBefore = git(projectDir, "rev-parse dev");

    // Make sync stale so the only gate tested is the reviewer check
    (engine as any)._lastTargetSyncTimestamp = Date.now() - 120_000;

    // Trigger reconciliation — sync should be skipped because reviewer is active
    await (engine as any)._reconcile();

    const tipAfter = git(projectDir, "rev-parse dev");
    expect(tipAfter).toBe(tipBefore); // Should NOT have synced

    // Remove the reviewer and reconcile again — now it should sync (still stale)
    invocationDetails.delete("test-reviewer-session");
    expect((engine as any)._hasActiveReviewerInvocation()).toBe(false);

    await (engine as any)._reconcile();

    const tipAfterSecondReconcile = git(projectDir, "rev-parse dev");
    expect(tipAfterSecondReconcile).not.toBe(tipBefore);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-pull-target-before-provision
  it("syncs target branch before workspace provisioning when stale", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Manually set lastSyncTimestamp to 0 to simulate staleness
    (engine as any)._lastTargetSyncTimestamp = 0;

    expect((engine as any)._isTargetSyncStale()).toBe(true);

    // Set a recent timestamp — should not be stale
    (engine as any)._lastTargetSyncTimestamp = Date.now();
    expect((engine as any)._isTargetSyncStale()).toBe(false);

    // Set an old timestamp — should be stale
    (engine as any)._lastTargetSyncTimestamp = Date.now() - 120_000;
    expect((engine as any)._isTargetSyncStale()).toBe(true);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-transient-no-degrade
  it("logs transient fetch failures as warnings without degrading", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Point remote to a non-existent URL to cause fetch failure
    git(projectDir, "remote set-url origin /nonexistent/path");

    const warnSpy = vi.spyOn(console, "warn");
    const result = await engine._syncTargetBranch();

    expect(result).toBe("transient_failure");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[dispatch] Target sync fetch failed"),
    );

    const syncStatus = engine.getTargetSyncStatus();
    expect(syncStatus.consecutiveFailures).toBe(1);

    // Engine still running — not degraded
    expect(engine.getStatus().running).toBe(true);

    await engine.stop();
  });

  it("preserves fetch and ff-only merge timeouts through the isolated target helper", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    const targetGitSpy = vi.spyOn(workspaceModule, "runDispatchIntegrationTargetGit");

    await pushRemoteCommit(
      remoteDir,
      "dev",
      "timeout-check.txt",
      "timeout\n",
      "timeout check",
    );

    const result = await engine._syncTargetBranch();

    expect(result).toBe("synced");
    expect(targetGitSpy).toHaveBeenNthCalledWith(
      1,
      projectDir,
      "dev",
      ["fetch", "origin", "dev"],
      { timeout: 30_000 },
    );
    expect(targetGitSpy).toHaveBeenNthCalledWith(
      2,
      projectDir,
      "dev",
      ["merge", "--ff-only", "origin/dev"],
      { timeout: 10_000 },
    );

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-transient-no-degrade (counter reset)
  it("resets consecutive failure counter on successful sync", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Simulate previous failures
    (engine as any)._consecutiveTransientFailures = 3;

    // Push a new commit and sync successfully
    const cloneDir = await createTempDir("kspec-target-sync-clone-");
    try {
      git(cloneDir, `clone "${remoteDir}" .`);
      git(cloneDir, "checkout dev");
      await fs.writeFile(path.join(cloneDir, "reset.txt"), "reset\n", "utf-8");
      git(cloneDir, "add reset.txt");
      git(cloneDir, 'commit -m "reset counter"');
      git(cloneDir, "push origin dev");
    } finally {
      await cleanupTempDir(cloneDir);
    }

    const result = await engine._syncTargetBranch();
    expect(result).toBe("synced");
    expect(engine.getTargetSyncStatus().consecutiveFailures).toBe(0);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-no-remote
  it("skips all sync operations silently when no remote is configured", async () => {
    projectDir = await createTempDir("kspec-target-sync-no-remote-");
    remoteDir = ""; // No remote dir
    initGitRepo(projectDir);
    await fs.writeFile(path.join(projectDir, "README.md"), "seed\n", "utf-8");
    git(projectDir, "add README.md");
    git(projectDir, 'commit -m "init"');
    git(projectDir, "checkout -b dev");

    await fs.writeFile(
      path.join(projectDir, "kynetic.yaml"),
      'kynetic: "1"\ntitle: Test Project\n',
      "utf-8",
    );
    await fs.writeFile(
      path.join(projectDir, "kynetic.meta.yaml"),
      [
        'kynetic_meta: "1.0"',
        "agents:",
        "  - _ulid: 01AGNT00000000000000000000",
        "    id: test-worker",
        '    name: "Test Worker"',
        "    dispatch:",
        "      - on: task.ready",
        "    concurrency:",
        "      max_concurrent: 1",
        "    adapter: mock-acp",
        "    auto_approve: false",
        "",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(projectDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: dev\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(projectDir, "project.tasks.yaml"),
      "tasks: []\n",
      "utf-8",
    );

    const logSpy = vi.spyOn(console, "log");
    const warnSpy = vi.spyOn(console, "warn");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    const syncStatus = engine.getTargetSyncStatus();
    expect(syncStatus.enabled).toBe(false);

    // No warnings about sync failures
    const syncWarnings = warnSpy.mock.calls.filter(
      (call) => String(call[0]).includes("Target sync"),
    );
    expect(syncWarnings).toHaveLength(0);

    // No sync log messages
    const syncLogs = logSpy.mock.calls.filter(
      (call) => String(call[0]).includes("Target sync enabled"),
    );
    expect(syncLogs).toHaveLength(0);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-no-remote (explicit remote_sync=false)
  it("skips sync when remote_sync is explicitly disabled in config", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());

    await fs.writeFile(
      path.join(projectDir, "kynetic.yaml"),
      'kynetic: "1"\ntitle: Test Project\n',
      "utf-8",
    );
    await fs.writeFile(
      path.join(projectDir, "kynetic.meta.yaml"),
      [
        'kynetic_meta: "1.0"',
        "agents:",
        "  - _ulid: 01AGNT00000000000000000000",
        "    id: test-worker",
        '    name: "Test Worker"',
        "    dispatch:",
        "      - on: task.ready",
        "    concurrency:",
        "      max_concurrent: 1",
        "    adapter: mock-acp",
        "    auto_approve: false",
        "",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(projectDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: dev\n  remote_sync: false\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(projectDir, "project.tasks.yaml"),
      "tasks: []\n",
      "utf-8",
    );

    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    const syncStatus = engine.getTargetSyncStatus();
    expect(syncStatus.enabled).toBe(false);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-pull-ff-only (diverged case)
  it("returns diverged when local and remote have diverged", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Create divergence: commit locally on dev
    await fs.writeFile(path.join(projectDir, "local-only.txt"), "local\n", "utf-8");
    git(projectDir, "add local-only.txt");
    git(projectDir, 'commit -m "local only commit"');

    // And push a different commit on remote via clone
    const cloneDir = await createTempDir("kspec-target-sync-clone-");
    try {
      git(cloneDir, `clone "${remoteDir}" .`);
      git(cloneDir, "checkout dev");
      await fs.writeFile(path.join(cloneDir, "remote-only.txt"), "remote\n", "utf-8");
      git(cloneDir, "add remote-only.txt");
      git(cloneDir, 'commit -m "remote only commit"');
      git(cloneDir, "push origin dev");
    } finally {
      await cleanupTempDir(cloneDir);
    }

    const result = await engine._syncTargetBranch();
    expect(result).toBe("diverged");

    await engine.stop();
  });

  it("returns up_to_date when local already matches remote", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Sync again without any changes — should be up_to_date
    const result = await engine._syncTargetBranch();
    expect(result === "up_to_date").toBe(true);

    await engine.stop();
  });

  it("uses running guard to prevent concurrent syncs", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Simulate a sync already running
    (engine as any)._targetSyncRunning = true;
    const result = await engine._syncTargetBranch();
    expect(result).toBe("skipped");

    // Clear the guard
    (engine as any)._targetSyncRunning = false;

    await engine.stop();
  });

  it("returns skipped when sync is not enabled", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Disable sync
    (engine as any)._remoteSyncEnabled = false;
    const result = await engine._syncTargetBranch();
    expect(result).toBe("skipped");

    await engine.stop();
  });

  it("reports sync status via getTargetSyncStatus()", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    const status = engine.getTargetSyncStatus();
    expect(status.enabled).toBe(true);
    expect(status.remote).toBe("origin");
    expect(status.baseBranch).toBe("dev");
    expect(status.lastSyncTimestamp).toBeGreaterThan(0);
    expect(status.consecutiveFailures).toBe(0);
    expect(status.syncRunning).toBe(false);

    await engine.stop();
  });
});
