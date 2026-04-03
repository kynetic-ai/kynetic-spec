import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import * as bootstrapModule from "../src/agent-runtime/bootstrap.js";
import * as workspaceModule from "../src/agent-runtime/workspace.js";
import { DispatchEngine, type SyncStateEvent } from "../src/agent-runtime/dispatch.js";
import { cleanupTempDir, createTempDir, initGitRepo } from "./helpers/cli.js";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

/**
 * Set up a bare remote repo and a local project repo with origin pointing to it.
 * Returns { projectDir, remoteDir }. Both on "dev" as the base branch.
 */
async function setupProjectWithRemote(): Promise<{
  projectDir: string;
  remoteDir: string;
}> {
  const remoteDir = await createTempDir("kspec-degraded-remote-");
  git(remoteDir, "init --bare");

  const projectDir = await createTempDir("kspec-degraded-project-");
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
  await fs.writeFile(path.join(projectDir, "project.tasks.yaml"), "tasks: []\n", "utf-8");
}

/**
 * Create divergence: commit locally on dev AND push a different commit on remote.
 */
async function createDivergence(projectDir: string, remoteDir: string): Promise<void> {
  // Local commit on dev
  await fs.writeFile(path.join(projectDir, "local-only.txt"), "local\n", "utf-8");
  git(projectDir, "add local-only.txt");
  git(projectDir, 'commit -m "local only commit"');

  // Remote commit via clone
  const cloneDir = await createTempDir("kspec-degraded-clone-");
  try {
    git(cloneDir, `clone "${remoteDir}" .`);
    git(cloneDir, 'config user.email "test@example.com"');
    git(cloneDir, 'config user.name "Test User"');
    git(cloneDir, "checkout dev");
    await fs.writeFile(path.join(cloneDir, "remote-only.txt"), "remote\n", "utf-8");
    git(cloneDir, "add remote-only.txt");
    git(cloneDir, 'commit -m "remote only commit"');
    git(cloneDir, "push origin dev");
  } finally {
    await cleanupTempDir(cloneDir);
  }
}

/**
 * Create remote-only divergence (force push rebase) to simulate rewritten history
 * where the local branch has no unique commits ahead.
 */
async function createRemoteRewrite(projectDir: string, remoteDir: string): Promise<void> {
  // First, ensure local is in sync with remote
  git(projectDir, "fetch origin");
  git(projectDir, "merge --ff-only origin/dev");

  // Now force-push a rebased history on the remote via a clone
  const cloneDir = await createTempDir("kspec-degraded-clone-");
  try {
    git(cloneDir, `clone "${remoteDir}" .`);
    git(cloneDir, 'config user.email "test@example.com"');
    git(cloneDir, 'config user.name "Test User"');
    git(cloneDir, "checkout dev");
    // Rewrite history: reset to before the "dev branch" commit, then make a new one
    git(cloneDir, "reset --soft HEAD~1");
    git(cloneDir, 'commit -m "rewritten dev branch"');
    git(cloneDir, "push --force origin dev");
  } finally {
    await cleanupTempDir(cloneDir);
  }
  // Now local's dev points to a commit that is no longer in remote's history,
  // but local has 0 commits *ahead* of the rewritten remote (since the remote
  // rewrote the commit local points to). fetch will update origin/dev to the
  // new tip, and local dev is still at the old tip — git merge --ff-only will fail.
}

async function createUnsafeSharedCheckoutDrift(projectDir: string, branch: string): Promise<void> {
  const previousTip = git(projectDir, `rev-parse ${branch}`);

  git(projectDir, "checkout --detach");
  await fs.writeFile(path.join(projectDir, "dev.txt"), "dev\ndrifted\n", "utf-8");
  git(projectDir, "add dev.txt");
  git(projectDir, 'commit -m "unsafe drift tip"');
  const branchTip = git(projectDir, "rev-parse HEAD");

  git(projectDir, `checkout ${branch}`);
  git(projectDir, `reset --hard ${previousTip}`);
  git(projectDir, `update-ref refs/heads/${branch} ${branchTip}`);

  await fs.writeFile(path.join(projectDir, "dev.txt"), "dev\nlocal-change\n", "utf-8");
}

describe("dispatch engine degraded state", () => {
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

  // AC: @dispatch-remote-branch-sync ac-divergence-enters-degraded
  it("enters degraded state when fast-forward sync fails due to divergence", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    await createDivergence(projectDir, remoteDir);

    const result = await engine._syncTarget();
    expect(result).toBe("diverged");

    const syncStatus = engine.getTargetSyncStatus();
    expect(syncStatus.degraded.active).toBe(true);
    expect(syncStatus.degraded.reason).toBeTruthy();
    expect(syncStatus.degraded.enteredAt).toBeTruthy();

    const degraded = engine.getDegradedState();
    expect(degraded).toHaveLength(1);
    expect(degraded[0].branch).toBe("dev");
    expect(degraded[0].reason).toContain("dev");
    expect(degraded[0].enteredAt).toBeInstanceOf(Date);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-divergence-log-classification
  // AC: @dispatch-remote-branch-sync ac-divergence-log-target
  // AC: @dispatch-remote-branch-sync ac-divergence-log-resolution
  it("distinguishes unpushed merges from remote rewrite in degraded reason", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Case 1: Local has unpushed commits (divergence where local is ahead)
    await createDivergence(projectDir, remoteDir);
    await engine._syncTarget();

    const degraded1 = engine.getDegradedState();
    expect(degraded1).toHaveLength(1);
    expect(degraded1[0].reason).toContain("dev");
    expect(degraded1[0].reason).toContain("unpushed merges");
    expect(degraded1[0].reason).toContain("git push");

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-divergence-log-classification (remote rewrite case)
  // AC: @dispatch-remote-branch-sync ac-divergence-log-target
  // AC: @dispatch-remote-branch-sync ac-divergence-log-resolution
  it("identifies remote history rewrite in degraded guidance", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Case: Remote history was rewritten (force push).
    // After createRemoteRewrite, local and remote share the same base but remote
    // has a rewritten tip. _syncTargetBranch will fetch then try ff-only merge.
    await createRemoteRewrite(projectDir, remoteDir);
    await engine._syncTarget();

    const degraded = engine.getDegradedState();
    expect(degraded).toHaveLength(1);
    expect(degraded[0].reason).toContain("dev");
    // Should contain guidance about resetting to match remote
    expect(degraded[0].reason).toContain("git reset --hard");
    // Should identify the divergence pattern
    expect(degraded[0].reason).toContain("diverged");

    await engine.stop();
  });

  // AC: @dispatch-shared-checkout-safety ac-3
  // AC: @dispatch-shared-checkout-safety ac-4
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  it("degrades with branch-specific repair guidance when shared-checkout drift would overwrite local changes", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    await createUnsafeSharedCheckoutDrift(projectDir, "dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    const result = await engine._syncTarget();
    expect(result).toBe("unsafe_target");

    const syncStatus = engine.getTargetSyncStatus();
    expect(syncStatus.degraded.active).toBe(true);
    expect(syncStatus.baseBranch).toBe("dev");
    expect(syncStatus.degraded.reason).toContain('integration target "dev"');
    expect(syncStatus.degraded.reason).toContain("working tree has tracked modifications");
    expect(syncStatus.degraded.reason).toContain("git checkout dev && git reset --hard dev");
    expect(git(projectDir, "status --short")).toContain("dev.txt");

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-degraded-no-provision
  // AC: @dispatch-remote-branch-sync ac-degraded-task-queued
  // AC: @dispatch-remote-branch-sync ac-degraded-healthy-unblocked
  it("defers only tasks targeting degraded branches while allowing healthy targets to provision", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    const worker = { id: "test-worker", concurrency: { max_concurrent: 1 } } as any;
    const degradedEntry = {
      agent: worker,
      change: {
        taskId: "task-degraded",
        taskRef: "@task-degraded",
        fromStatus: "pending",
        toStatus: "pending",
        timestamp: Date.now(),
      },
      retryCount: 0,
      nextRetryAt: 0,
      enqueuedAtMs: Date.now(),
      sequence: 0,
      starvationDeferrals: 0,
    };
    const healthyEntry = {
      agent: worker,
      change: {
        taskId: "task-healthy",
        taskRef: "@task-healthy",
        fromStatus: "pending",
        toStatus: "pending",
        timestamp: Date.now(),
      },
      retryCount: 0,
      nextRetryAt: 0,
      enqueuedAtMs: Date.now(),
      sequence: 1,
      starvationDeferrals: 0,
    };

    (engine as any).queues.set(worker.id, [degradedEntry, healthyEntry]);
    (engine as any)._enterDegradedState("plan/alpha", "plan/alpha diverged");

    vi.spyOn(engine as any, "_resolveQueueEntryTargetBranch").mockImplementation(async (entry: any) =>
      entry.change.taskRef === "@task-degraded" ? "plan/alpha" : "dev",
    );
    const spawnSpy = vi.spyOn(engine as any, "_spawnInvocation").mockResolvedValue(true);

    await (engine as any)._drainQueues([worker]);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith(worker, healthyEntry);
    expect((engine as any).queues.get(worker.id)).toEqual([degradedEntry]);
    expect(engine.getStatus().running).toBe(true);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-degraded-inflight-continues
  it("lets an already-started invocation finish after its target enters degraded state", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    let resolveInvocation!: (result: any) => void;
    const invocationStarted = new Promise<void>((resolve) => {
      vi.spyOn(invocationModule, "runInvocation").mockImplementation(async () => {
        resolve();
        return await new Promise((innerResolve) => {
          resolveInvocation = innerResolve;
        });
      });
    });

    vi.spyOn(workspaceModule, "provisionDispatchWorkspace").mockResolvedValue({
      cwd: projectDir,
      metadataPath: path.join(projectDir, "dispatch-workspace.yaml"),
      metadata: {
        workspaceId: "ws-1",
        baseBranch: "dev",
        mergeTargetBranch: "dev",
        canonicalBranch: "dispatch/task/task-impl-degraded-state/01kn8t1a",
        canonicalBranchHead: git(projectDir, "rev-parse HEAD"),
        integrationTargetBranch: "dev",
        integrationTargetCommit: git(projectDir, "rev-parse HEAD"),
        publicationMode: "manual_merge",
        integrationState: "clean",
        integrationOutcome: "pending",
        worktreeRoot: projectDir,
        bootstrap: { status: "prepared", lastRole: "worker" },
      },
    } as any);
    vi.spyOn(bootstrapModule, "ensureWorkspaceBootstrap").mockImplementation(async ({ metadata }) => ({
      metadata,
    }));
    vi.spyOn(workspaceModule, "validateDispatchWorkspaceForInvocation").mockImplementation(
      async ({ workspace }) =>
        ({
          workspace,
          repaired: false,
        }) as any,
    );
    vi.spyOn(workspaceModule, "markDispatchWorkspaceActive").mockResolvedValue(null);
    vi.spyOn(workspaceModule, "markDispatchWorkspaceIdle").mockResolvedValue(undefined);

    const events: Array<{ type: string; status: string }> = [];
    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
      onInvocationEvent: (event) => events.push({ type: event.type, status: event.status }),
    });
    (engine as any).running = true;
    vi.spyOn(engine as any, "_buildDispatchPrompt").mockResolvedValue("test prompt");
    vi.spyOn(engine as any, "_evaluateAllTasks").mockResolvedValue(undefined);
    vi.spyOn(engine as any, "_serializedDrain").mockResolvedValue(undefined);

    const agent = {
      id: "test-worker",
      name: "Test Worker",
      adapter: "mock-acp",
      concurrency: { max_concurrent: 1 },
      capabilities: [],
      tools: [],
      conventions: [],
      dispatch: [],
      skills: [],
      auto_approve: false,
    } as any;
    const entry = {
      agent,
      change: {
        taskId: "task-inflight",
        taskRef: "@task-inflight",
        fromStatus: "pending",
        toStatus: "pending",
        timestamp: Date.now(),
        task: {
          title: "Task Inflight",
          slugs: ["task-inflight"],
          status: "pending",
        },
      },
      retryCount: 0,
      nextRetryAt: 0,
      enqueuedAtMs: Date.now(),
      sequence: 0,
      starvationDeferrals: 0,
    };

    expect(await (engine as any)._spawnInvocation(agent, entry)).toBe(true);
    await invocationStarted;
    expect(engine.getStatus().activeInvocations).toBe(1);

    (engine as any)._enterDegradedState("dev", "dev diverged");
    expect(engine.getDegradedState().map((state) => state.branch)).toEqual(["dev"]);
    expect(engine.getStatus().activeInvocations).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["started"]);

    resolveInvocation({
      exitCode: 0,
      stdout: "",
      stderr: "",
      outcome: "success",
      durationMs: 1,
      turnCount: 1,
    });

    await Promise.allSettled(Array.from((engine as any).runningInvocations));
    expect(engine.getStatus().activeInvocations).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["started", "completed"]);
  });

  // AC: @dispatch-remote-branch-sync ac-degraded-status-api
  it("includes degraded state in status responses", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Before degraded
    const syncStatusBefore = engine.getTargetSyncStatus();
    expect(syncStatusBefore.degraded.active).toBe(false);
    expect(syncStatusBefore.degraded.reason).toBe("");
    expect(syncStatusBefore.degraded.enteredAt).toBeNull();

    const degradedBefore = engine.getDegradedState();
    expect(degradedBefore).toEqual([]);

    // Enter degraded
    await createDivergence(projectDir, remoteDir);
    await engine._syncTarget();

    // After degraded
    const syncStatusAfter = engine.getTargetSyncStatus();
    expect(syncStatusAfter.degraded.active).toBe(true);
    expect(typeof syncStatusAfter.degraded.reason).toBe("string");
    expect(syncStatusAfter.degraded.reason.length).toBeGreaterThan(0);
    expect(syncStatusAfter.degraded.enteredAt).toBeTruthy();
    // enteredAt should be a valid ISO string
    expect(() => new Date(syncStatusAfter.degraded.enteredAt!)).not.toThrow();

    const degradedAfter = engine.getDegradedState();
    expect(degradedAfter).toHaveLength(1);
    expect(degradedAfter[0].branch).toBe("dev");
    expect(degradedAfter[0].reason.length).toBeGreaterThan(0);
    expect(degradedAfter[0].enteredAt).toBeInstanceOf(Date);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-degraded-status-broadcast
  // AC: @dispatch-remote-branch-sync ac-degraded-status-broadcast-target
  it("broadcasts sync_state events on enter and exit degraded state", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const syncEvents: SyncStateEvent[] = [];
    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
      onSyncStateEvent: (event) => syncEvents.push(event),
    });
    await engine.start();

    // Enter degraded
    await createDivergence(projectDir, remoteDir);
    await engine._syncTarget();

    expect(syncEvents).toHaveLength(1);
    expect(syncEvents[0].type).toBe("sync_state");
    expect(syncEvents[0].branch).toBe("dev");
    expect(syncEvents[0].degraded).toBe(true);
    expect(syncEvents[0].reason).toBeTruthy();
    expect(syncEvents[0].enteredAt).toBeTruthy();

    // Resolve divergence — reset local to match remote
    git(projectDir, "reset --hard origin/dev");

    // Sync again — should recover
    const result = await engine._syncTarget();
    expect(result === "up_to_date" || result === "synced").toBe(true);

    expect(syncEvents).toHaveLength(2);
    expect(syncEvents[1].type).toBe("sync_state");
    expect(syncEvents[1].branch).toBe("dev");
    expect(syncEvents[1].degraded).toBe(false);
    expect(syncEvents[1].reason).toBe("");
    expect(syncEvents[1].enteredAt).toBeNull();
    expect(syncEvents[1].recoveredAfterMs).toBeGreaterThanOrEqual(0);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-degraded-auto-recover
  it("exits degraded state when a subsequent sync succeeds", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Enter degraded
    await createDivergence(projectDir, remoteDir);
    await engine._syncTarget();
    expect(engine.getDegradedState()).toHaveLength(1);

    // Resolve: reset local to match remote (operator intervention)
    git(projectDir, "reset --hard origin/dev");

    // Next sync should recover
    const result = await engine._syncTarget();
    expect(result === "up_to_date" || result === "synced").toBe(true);
    expect(engine.getDegradedState()).toEqual([]);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-degraded-recovery-logged
  // AC: @dispatch-remote-branch-sync ac-degraded-recovery-logged-duration
  it("logs recovery with the duration the engine was degraded", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const logSpy = vi.spyOn(console, "log");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Enter degraded
    await createDivergence(projectDir, remoteDir);
    await engine._syncTarget();

    // Resolve: reset local
    git(projectDir, "reset --hard origin/dev");

    // Recover
    await engine._syncTarget();

    // Check that recovery was logged with duration
    const recoveryLogs = logSpy.mock.calls.filter((call) =>
      String(call[0]).includes("Recovered from degraded state"),
    );
    expect(recoveryLogs.length).toBeGreaterThanOrEqual(1);
    expect(String(recoveryLogs[0][0])).toContain("dev");
    expect(String(recoveryLogs[0][0])).toMatch(/after \d+s/);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-repeated-transient-escalation
  it("logs escalated warning after 5+ consecutive transient failures with failure count and duration", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Point remote to a non-existent path to cause fetch failures
    git(projectDir, "remote set-url origin /nonexistent/path");

    const warnSpy = vi.spyOn(console, "warn");

    // Trigger 5 failures to reach escalation threshold
    for (let i = 0; i < 5; i++) {
      await engine._syncTarget();
    }

    // Check escalation warning
    const escalationWarnings = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes("Persistent connectivity issues"),
    );
    expect(escalationWarnings.length).toBeGreaterThanOrEqual(1);
    const lastWarning = String(escalationWarnings[escalationWarnings.length - 1][0]);
    expect(lastWarning).toContain("5 consecutive");
    expect(lastWarning).toMatch(/over \d+s/);

    // Engine should NOT be degraded (transient failures don't degrade)
    expect(engine.getDegradedState()).toEqual([]);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-repeated-transient-no-degrade
  it("does not enter degraded state from transient failures even after escalation threshold", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Cause transient failures
    git(projectDir, "remote set-url origin /nonexistent/path");

    // Trigger 10 failures (well beyond threshold of 5)
    for (let i = 0; i < 10; i++) {
      const result = await engine._syncTarget();
      expect(result).toBe("transient_failure");
    }

    // Engine must NOT be degraded
    expect(engine.getDegradedState()).toEqual([]);
    expect(engine.getTargetSyncStatus().consecutiveFailures).toBe(10);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-repeated-transient-escalation (counter reset)
  it("resets transient failure counter and timestamp on successful sync", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Simulate previous transient failures
    (engine as any)._consecutiveSyncFailures.set("dev", 7);
    (engine as any)._firstSyncFailureTimestamps.set("dev", Date.now() - 60_000);

    // Successful sync should reset both
    const cloneDir = await createTempDir("kspec-degraded-clone-");
    try {
      git(cloneDir, `clone "${remoteDir}" .`);
      git(cloneDir, 'config user.email "test@example.com"');
      git(cloneDir, 'config user.name "Test User"');
      git(cloneDir, "checkout dev");
      await fs.writeFile(path.join(cloneDir, "new.txt"), "new\n", "utf-8");
      git(cloneDir, "add new.txt");
      git(cloneDir, 'commit -m "new commit"');
      git(cloneDir, "push origin dev");
    } finally {
      await cleanupTempDir(cloneDir);
    }

    const result = await engine._syncTarget();
    expect(result).toBe("synced");
    expect(engine.getTargetSyncStatus().consecutiveFailures).toBe(0);
    expect((engine as any)._firstSyncFailureTimestamps.has("dev")).toBe(false);

    await engine.stop();
  });

  // Additional: degraded state prevents re-entry on repeated diverged syncs
  it("does not re-enter degraded state if already degraded", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const syncEvents: SyncStateEvent[] = [];
    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
      onSyncStateEvent: (event) => syncEvents.push(event),
    });
    await engine.start();

    // Enter degraded
    await createDivergence(projectDir, remoteDir);
    await engine._syncTarget();
    expect(syncEvents).toHaveLength(1);

    // Sync again while still diverged — should NOT fire another enter event
    await engine._syncTarget();
    expect(syncEvents).toHaveLength(1); // Still just the original enter event
    expect(engine.getDegradedState()).toHaveLength(1);

    await engine.stop();
  });

  // Additional: recovery triggers queue drain for queued tasks
  it("triggers queue drain after recovering from degraded state", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Enter degraded
    await createDivergence(projectDir, remoteDir);
    await engine._syncTarget();
    expect(engine.getDegradedState()).toHaveLength(1);

    // Spy on _serializedDrain to verify it's called on recovery
    const drainSpy = vi.spyOn(engine as any, "_serializedDrain");

    // Resolve and recover
    git(projectDir, "reset --hard origin/dev");
    await engine._syncTarget();

    expect(engine.getDegradedState()).toEqual([]);
    // _serializedDrain should have been called as part of recovery
    expect(drainSpy).toHaveBeenCalled();

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-degraded-recovery-requeues
  it("triggers a drain when one degraded target recovers even if another target remains degraded", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    (engine as any)._enterDegradedState("dev", "dev diverged");
    (engine as any)._enterDegradedState("plan/alpha", "plan/alpha diverged");

    const drainSpy = vi.spyOn(engine as any, "_serializedDrain").mockResolvedValue(undefined);

    (engine as any)._exitDegradedState("dev");

    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(engine.getDegradedState()).toHaveLength(1);
    expect(engine.getDegradedState()[0].branch).toBe("plan/alpha");

    await engine.stop();
  });
});
