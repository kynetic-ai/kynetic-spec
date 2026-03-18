import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import { DispatchEngine, type TargetSyncResult, type SyncStateEvent } from "../src/agent-runtime/dispatch.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
} from "./helpers/cli.js";

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
  await fs.writeFile(
    path.join(projectDir, "project.tasks.yaml"),
    "tasks: []\n",
    "utf-8",
  );
}

/**
 * Create divergence: commit locally on dev AND push a different commit on remote.
 */
async function createDivergence(
  projectDir: string,
  remoteDir: string,
): Promise<void> {
  // Local commit on dev
  await fs.writeFile(path.join(projectDir, "local-only.txt"), "local\n", "utf-8");
  git(projectDir, "add local-only.txt");
  git(projectDir, 'commit -m "local only commit"');

  // Remote commit via clone
  const cloneDir = await createTempDir("kspec-degraded-clone-");
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
}

/**
 * Create remote-only divergence (force push rebase) to simulate rewritten history
 * where the local branch has no unique commits ahead.
 */
async function createRemoteRewrite(
  projectDir: string,
  remoteDir: string,
): Promise<void> {
  // First, ensure local is in sync with remote
  git(projectDir, "fetch origin");
  git(projectDir, "merge --ff-only origin/dev");

  // Now force-push a rebased history on the remote via a clone
  const cloneDir = await createTempDir("kspec-degraded-clone-");
  try {
    git(cloneDir, `clone "${remoteDir}" .`);
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

    const result = await engine._syncTargetBranch();
    expect(result).toBe("diverged");

    const syncStatus = engine.getTargetSyncStatus();
    expect(syncStatus.degraded.active).toBe(true);
    expect(syncStatus.degraded.reason).toBeTruthy();
    expect(syncStatus.degraded.enteredAt).toBeTruthy();

    const degraded = engine.getDegradedState();
    expect(degraded.active).toBe(true);
    expect(degraded.reason).toContain("dev");
    expect(degraded.enteredAt).toBeInstanceOf(Date);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-divergence-log-guidance
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
    await engine._syncTargetBranch();

    const degraded1 = engine.getDegradedState();
    expect(degraded1.active).toBe(true);
    expect(degraded1.reason).toContain("unpushed merges");
    expect(degraded1.reason).toContain("git push");

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-divergence-log-guidance (remote rewrite case)
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
    await engine._syncTargetBranch();

    const degraded = engine.getDegradedState();
    expect(degraded.active).toBe(true);
    // Should contain guidance about resetting to match remote
    expect(degraded.reason).toContain("git reset --hard");
    // Should identify the divergence pattern
    expect(degraded.reason).toContain("diverged");

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-degraded-no-provision
  it("blocks new workspace provisioning when degraded but allows in-flight to continue", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Enter degraded state
    await createDivergence(projectDir, remoteDir);
    await engine._syncTargetBranch();
    expect(engine.getDegradedState().active).toBe(true);

    // Verify the drain loop returns early (no new provisioning)
    // We test this by calling _drainQueues directly — it should return without
    // processing any queue entries
    const drainSpy = vi.spyOn(engine as any, "_selectNextCandidate");
    await (engine as any)._drainQueues([]);

    // _selectNextCandidate should NOT have been called because _drainQueues
    // returned early due to degraded state
    expect(drainSpy).not.toHaveBeenCalled();

    // Engine is still running (in-flight can continue)
    expect(engine.getStatus().running).toBe(true);

    await engine.stop();
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
    expect(degradedBefore.active).toBe(false);
    expect(degradedBefore.enteredAt).toBeNull();

    // Enter degraded
    await createDivergence(projectDir, remoteDir);
    await engine._syncTargetBranch();

    // After degraded
    const syncStatusAfter = engine.getTargetSyncStatus();
    expect(syncStatusAfter.degraded.active).toBe(true);
    expect(typeof syncStatusAfter.degraded.reason).toBe("string");
    expect(syncStatusAfter.degraded.reason.length).toBeGreaterThan(0);
    expect(syncStatusAfter.degraded.enteredAt).toBeTruthy();
    // enteredAt should be a valid ISO string
    expect(() => new Date(syncStatusAfter.degraded.enteredAt!)).not.toThrow();

    const degradedAfter = engine.getDegradedState();
    expect(degradedAfter.active).toBe(true);
    expect(degradedAfter.reason.length).toBeGreaterThan(0);
    expect(degradedAfter.enteredAt).toBeInstanceOf(Date);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-degraded-status-broadcast
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
    await engine._syncTargetBranch();

    expect(syncEvents).toHaveLength(1);
    expect(syncEvents[0].type).toBe("sync_state");
    expect(syncEvents[0].degraded).toBe(true);
    expect(syncEvents[0].reason).toBeTruthy();
    expect(syncEvents[0].enteredAt).toBeTruthy();

    // Resolve divergence — reset local to match remote
    git(projectDir, "reset --hard origin/dev");

    // Sync again — should recover
    const result = await engine._syncTargetBranch();
    expect(result === "up_to_date" || result === "synced").toBe(true);

    expect(syncEvents).toHaveLength(2);
    expect(syncEvents[1].type).toBe("sync_state");
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
    await engine._syncTargetBranch();
    expect(engine.getDegradedState().active).toBe(true);

    // Resolve: reset local to match remote (operator intervention)
    git(projectDir, "reset --hard origin/dev");

    // Next sync should recover
    const result = await engine._syncTargetBranch();
    expect(result === "up_to_date" || result === "synced").toBe(true);
    expect(engine.getDegradedState().active).toBe(false);
    expect(engine.getDegradedState().reason).toBe("");
    expect(engine.getDegradedState().enteredAt).toBeNull();

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-degraded-recovery-logged
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
    await engine._syncTargetBranch();

    // Resolve: reset local
    git(projectDir, "reset --hard origin/dev");

    // Recover
    await engine._syncTargetBranch();

    // Check that recovery was logged with duration
    const recoveryLogs = logSpy.mock.calls.filter(
      (call) => String(call[0]).includes("Recovered from degraded state"),
    );
    expect(recoveryLogs.length).toBeGreaterThanOrEqual(1);
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
      await engine._syncTargetBranch();
    }

    // Check escalation warning
    const escalationWarnings = warnSpy.mock.calls.filter(
      (call) => String(call[0]).includes("Persistent connectivity issues"),
    );
    expect(escalationWarnings.length).toBeGreaterThanOrEqual(1);
    const lastWarning = String(escalationWarnings[escalationWarnings.length - 1][0]);
    expect(lastWarning).toContain("5 consecutive");
    expect(lastWarning).toMatch(/over \d+s/);

    // Engine should NOT be degraded (transient failures don't degrade)
    expect(engine.getDegradedState().active).toBe(false);

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
      const result = await engine._syncTargetBranch();
      expect(result).toBe("transient_failure");
    }

    // Engine must NOT be degraded
    expect(engine.getDegradedState().active).toBe(false);
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
    (engine as any)._consecutiveTransientFailures = 7;
    (engine as any)._firstTransientFailureTimestamp = Date.now() - 60_000;

    // Successful sync should reset both
    const cloneDir = await createTempDir("kspec-degraded-clone-");
    try {
      git(cloneDir, `clone "${remoteDir}" .`);
      git(cloneDir, "checkout dev");
      await fs.writeFile(path.join(cloneDir, "new.txt"), "new\n", "utf-8");
      git(cloneDir, "add new.txt");
      git(cloneDir, 'commit -m "new commit"');
      git(cloneDir, "push origin dev");
    } finally {
      await cleanupTempDir(cloneDir);
    }

    const result = await engine._syncTargetBranch();
    expect(result).toBe("synced");
    expect(engine.getTargetSyncStatus().consecutiveFailures).toBe(0);
    expect((engine as any)._firstTransientFailureTimestamp).toBe(0);

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
    await engine._syncTargetBranch();
    expect(syncEvents).toHaveLength(1);

    // Sync again while still diverged — should NOT fire another enter event
    await engine._syncTargetBranch();
    expect(syncEvents).toHaveLength(1); // Still just the original enter event
    expect(engine.getDegradedState().active).toBe(true);

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
    await engine._syncTargetBranch();
    expect(engine.getDegradedState().active).toBe(true);

    // Spy on _serializedDrain to verify it's called on recovery
    const drainSpy = vi.spyOn(engine as any, "_serializedDrain");

    // Resolve and recover
    git(projectDir, "reset --hard origin/dev");
    await engine._syncTargetBranch();

    expect(engine.getDegradedState().active).toBe(false);
    // _serializedDrain should have been called as part of recovery
    expect(drainSpy).toHaveBeenCalled();

    await engine.stop();
  });
});
