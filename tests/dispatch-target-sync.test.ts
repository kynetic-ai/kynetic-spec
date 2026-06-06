import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import * as dispatchWorkspaceRegistryModule from "../src/parser/dispatch-workspaces.js";
import * as workspaceModule from "../src/agent-runtime/workspace.js";
import { DispatchEngine } from "../src/agent-runtime/dispatch.js";
import { initContext } from "../src/parser/index.js";
import { saveDispatchWorkspaceRecord } from "../src/parser/dispatch-workspaces.js";
import type { LoadedDispatchWorkspaceRecord } from "../src/parser/dispatch-workspaces.js";
import { kspecOutput as kspec, kspecJson } from "./helpers/cli.js";
import { cleanupTempDir, createTempDir, initGitRepo, testUlid } from "./helpers/cli.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";

ensureSplitBackendRegistered();

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
    env: workspaceModule.buildDispatchGitEnv(),
  }).trim();
}

function gitSucceeds(cwd: string, command: string): boolean {
  try {
    execSync(`git ${command}`, {
      cwd,
      stdio: "pipe",
      encoding: "utf-8",
      env: workspaceModule.buildDispatchGitEnv(),
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
    [
      "dispatch:",
      `  base_branch: ${baseBranch}`,
      "  sync_interval: 60",
      "  remote_sync: true",
      "agent:",
      "  skills:",
      '    task_work: "$kspec-task-work"',
      '    pr_review: "$kspec-review"',
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(path.join(projectDir, "project.tasks.yaml"), "tasks: []\n", "utf-8");
}

function createWorkspaceRecord(
  projectDir: string,
  {
    taskRef,
    taskSlug,
    targetBranch,
    lifecycleState = "ready",
    workspaceId = testUlid("WS"),
    taskId,
  }: {
    taskRef: string;
    taskSlug: string;
    targetBranch: string;
    lifecycleState?: LoadedDispatchWorkspaceRecord["lifecycle_state"];
    workspaceId?: string;
    taskId?: string;
  },
): LoadedDispatchWorkspaceRecord {
  const timestamp = new Date().toISOString();
  const branchHead = git(projectDir, "rev-parse HEAD");
  return {
    workspace_id: workspaceId,
    task_id: taskId,
    task_ref: taskRef,
    task_slug: taskSlug,
    worktree_root: projectDir,
    resolved_base_branch: "dev",
    base_branch_point: branchHead,
    canonical_branch: `dispatch/task/${taskSlug}/${workspaceId.toLowerCase()}`,
    canonical_branch_head: branchHead,
    branch_provenance: {
      ownership: "dispatcher-managed",
      source: "provisioned",
      remote_ref: null,
      adopted_from: null,
      adopted_at: null,
      rehydrated: null,
    },
    lifecycle_state: lifecycleState,
    active_role: lifecycleState === "closed" ? null : "worker",
    worktrees: {
      worker: {
        path: path.join(projectDir, ".dispatch-worktrees", workspaceId.toLowerCase()),
        branch_mode: "branch",
        branch_ref: `dispatch/task/${taskSlug}/${workspaceId.toLowerCase()}`,
        head: branchHead,
        last_seen_at: timestamp,
      },
      reviewer: null,
    },
    bootstrap: {
      status: "not_run",
      configHash: null,
      canonicalBranchHead: null,
      lastRunAt: null,
      invalidationReasons: [],
      steps: [],
      failureMessage: null,
      lastRole: null,
      roleStates: {
        worker: {
          status: "not_run",
          configHash: null,
          canonicalBranchHead: null,
          lastRunAt: null,
          invalidationReasons: [],
          steps: [],
          failureMessage: null,
        },
        reviewer: {
          status: "not_run",
          configHash: null,
          canonicalBranchHead: null,
          lastRunAt: null,
          invalidationReasons: [],
          steps: [],
          failureMessage: null,
        },
      },
    },
    integration: {
      status: "pending",
      target_branch: targetBranch,
      target_commit: branchHead,
      publication_mode: "manual_merge",
      outcome: "manual_merge",
      detail: null,
      updated_at: timestamp,
    },
    health: {
      status: "healthy",
      summary: "healthy",
      issues: [],
      updated_at: timestamp,
    },
    cleanup: {
      status: lifecycleState === "closed" ? "completed" : "not_scheduled",
      eligible: lifecycleState === "closed",
      reason: lifecycleState === "closed" ? "closed" : null,
      detail: null,
      updated_at: timestamp,
    },
    timestamps: {
      created_at: timestamp,
      updated_at: timestamp,
      last_reconciled_at: timestamp,
      last_active_at: timestamp,
      closed_at: lifecycleState === "closed" ? timestamp : null,
    },
  };
}

async function saveWorkspaceRecord(
  projectDir: string,
  options: {
    taskRef: string;
    taskSlug: string;
    targetBranch: string;
    lifecycleState?: LoadedDispatchWorkspaceRecord["lifecycle_state"];
    workspaceId?: string;
    taskId?: string;
  },
): Promise<void> {
  const ctx = await initContext(projectDir);
  const record = createWorkspaceRecord(projectDir, options);
  await saveDispatchWorkspaceRecord(ctx, record);
}

async function setupWorktreeLaunchedProjectWithRemote(): Promise<{
  sourceDir: string;
  sharedCheckoutDir: string;
  remoteDir: string;
}> {
  const remoteDir = await createTempDir("kspec-target-sync-worktree-remote-");
  git(remoteDir, "init --bare");

  const sourceDir = await createTempDir("kspec-target-sync-worktree-source-");
  initGitRepo(sourceDir);
  await fs.writeFile(path.join(sourceDir, "README.md"), "seed\n", "utf-8");
  git(sourceDir, "add README.md");
  git(sourceDir, 'commit -m "init"');

  const defaultBranch = git(sourceDir, "branch --show-current");
  git(sourceDir, "checkout -b dev");
  await fs.writeFile(path.join(sourceDir, "dev.txt"), "dev\n", "utf-8");
  git(sourceDir, "add dev.txt");
  git(sourceDir, 'commit -m "dev branch"');
  git(sourceDir, `remote add origin "${remoteDir}"`);
  git(sourceDir, "push -u origin dev");
  git(sourceDir, `checkout ${defaultBranch}`);

  const sharedCheckoutDir = `${sourceDir}-shared-checkout`;
  execSync(`git worktree add "${sharedCheckoutDir}" dev`, {
    cwd: sourceDir,
    stdio: "pipe",
    env: workspaceModule.buildDispatchGitEnv(),
  });

  return { sourceDir, sharedCheckoutDir, remoteDir };
}

async function setupPoisonRepo(): Promise<string> {
  const poisonDir = await createTempDir("kspec-target-sync-poison-");
  initGitRepo(poisonDir);
  await fs.writeFile(path.join(poisonDir, "README.md"), "poison\n", "utf-8");
  git(poisonDir, "add README.md");
  git(poisonDir, 'commit -m "init poison repo"');
  git(poisonDir, "checkout -b dev");
  await fs.writeFile(path.join(poisonDir, "poison.txt"), "poison\n", "utf-8");
  git(poisonDir, "add poison.txt");
  git(poisonDir, 'commit -m "poison dev branch"');
  return poisonDir;
}

async function withPoisonedGitContext<T>(poisonDir: string, run: () => Promise<T>): Promise<T> {
  const originalGitDir = process.env.GIT_DIR;
  const originalGitWorkTree = process.env.GIT_WORK_TREE;
  const originalGitIndexFile = process.env.GIT_INDEX_FILE;

  process.env.GIT_DIR = path.join(poisonDir, ".git");
  process.env.GIT_WORK_TREE = poisonDir;
  process.env.GIT_INDEX_FILE = path.join(poisonDir, ".git", "index");

  try {
    return await run();
  } finally {
    if (originalGitDir === undefined) {
      delete process.env.GIT_DIR;
    } else {
      process.env.GIT_DIR = originalGitDir;
    }
    if (originalGitWorkTree === undefined) {
      delete process.env.GIT_WORK_TREE;
    } else {
      process.env.GIT_WORK_TREE = originalGitWorkTree;
    }
    if (originalGitIndexFile === undefined) {
      delete process.env.GIT_INDEX_FILE;
    } else {
      process.env.GIT_INDEX_FILE = originalGitIndexFile;
    }
  }
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
    git(cloneDir, 'config user.email "test@example.com"');
    git(cloneDir, 'config user.name "Test User"');
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

async function createTrackedBranch(
  projectDir: string,
  branch: string,
  fileName: string,
  content: string,
  message: string,
): Promise<string> {
  const previousBranch = git(projectDir, "branch --show-current");
  try {
    git(projectDir, `checkout -b ${branch} dev`);
    await fs.writeFile(path.join(projectDir, fileName), content, "utf-8");
    git(projectDir, `add ${fileName}`);
    git(projectDir, `commit -m "${message}"`);
    git(projectDir, `push -u origin ${branch}`);
    return git(projectDir, `rev-parse ${branch}`);
  } finally {
    git(projectDir, `checkout ${previousBranch}`);
  }
}

async function cloneRemote(remoteDir: string): Promise<string> {
  const cloneDir = await createTempDir("kspec-target-sync-reviewer-");
  git(cloneDir, `clone "${remoteDir}" .`);
  git(cloneDir, 'config user.email "test@example.com"');
  git(cloneDir, 'config user.name "Test User"');
  return cloneDir;
}

async function cleanupTempDirWithRetry(dir: string, retries = 3): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await cleanupTempDir(dir);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "ENOTEMPTY" && code !== "EBUSY") || attempt === retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

// AC: @trait-error-guidance ac-1 — N/A: internal dispatch engine sync, not a user-facing CLI command.
// AC: @trait-error-guidance ac-2 — N/A: internal dispatch engine sync, not a user-facing CLI command.
// AC: @trait-error-guidance ac-3 — N/A: internal dispatch engine sync, not a user-facing CLI command.
// AC: @trait-error-guidance ac-4 — N/A: internal dispatch engine sync, not a user-facing CLI command.
// AC: @trait-error-guidance ac-5 — N/A: internal dispatch engine sync, not a user-facing CLI command.
// AC: @trait-error-guidance ac-6 — N/A: internal dispatch engine sync, not a user-facing CLI command.

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
    if (projectDir) await cleanupTempDirWithRetry(projectDir);
    if (remoteDir) await cleanupTempDirWithRetry(remoteDir);
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

  // AC: @dispatch-remote-branch-sync ac-pull-target-on-start
  // AC: @dispatch-remote-branch-sync ac-active-target-rebuilt-on-start
  it("syncs non-base active integration targets from the workspace registry on engine start", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    await createTrackedBranch(
      projectDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\n",
      "create plan alpha",
    );
    await saveWorkspaceRecord(projectDir, {
      taskRef: "@01TASK00000000000000000011",
      taskSlug: "task-plan-alpha",
      targetBranch: "plan/alpha",
    });

    const localBefore = git(projectDir, "rev-parse plan/alpha");
    const remoteTip = await pushRemoteCommit(
      remoteDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\nremote\n",
      "remote alpha advance",
    );
    expect(localBefore).not.toBe(remoteTip);

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    expect(git(projectDir, "rev-parse plan/alpha")).toBe(remoteTip);
    expect(new Set(engine.getTargetSyncStatus().activeTargets)).toEqual(
      new Set(["dev", "plan/alpha"]),
    );

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-pull-target-on-start
  // AC: @dispatch-remote-branch-sync ac-pull-target-on-start-before-bootstrap
  it("syncs each active integration target only once during engine start", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    await createTrackedBranch(
      projectDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\n",
      "create plan alpha",
    );
    await saveWorkspaceRecord(projectDir, {
      taskRef: "@01TASK00000000000000000011",
      taskSlug: "task-plan-alpha",
      targetBranch: "plan/alpha",
    });

    const remoteTip = await pushRemoteCommit(
      remoteDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\nremote\n",
      "remote alpha advance",
    );

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    const syncTargetSpy = vi.spyOn(engine as any, "_syncTarget");

    await engine.start();

    expect(git(projectDir, "rev-parse plan/alpha")).toBe(remoteTip);
    const syncedTargets = syncTargetSpy.mock.calls.map(([branch]) => branch);
    expect(syncedTargets).toEqual(["dev", "plan/alpha"]);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-active-target-includes-base
  it("includes the configured base branch in the active target set even without workspaces", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    expect(engine.getTargetSyncStatus().activeTargets).toEqual(["dev"]);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-active-target-rebuilt-on-start
  it("rebuilds the active target set from distinct non-closed workspace targets on start", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    vi.spyOn(dispatchWorkspaceRegistryModule, "loadDispatchWorkspaceRegistry").mockResolvedValue([
      createWorkspaceRecord(projectDir, {
        taskRef: "@01TASK00000000000000000001",
        taskSlug: "task-plan-alpha",
        targetBranch: "plan/alpha",
      }),
      createWorkspaceRecord(projectDir, {
        taskRef: "@01TASK00000000000000000002",
        taskSlug: "task-plan-beta",
        targetBranch: "plan/beta",
      }),
      createWorkspaceRecord(projectDir, {
        taskRef: "@01TASK00000000000000000003",
        taskSlug: "task-plan-alpha-2",
        targetBranch: "plan/alpha",
      }),
      createWorkspaceRecord(projectDir, {
        taskRef: "@01TASK00000000000000000004",
        taskSlug: "task-closed-plan-gamma",
        targetBranch: "plan/gamma",
        lifecycleState: "closed",
      }),
    ]);

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await (engine as any)._initTargetSync();

    expect(new Set(engine.getTargetSyncStatus().activeTargets)).toEqual(
      new Set(["dev", "plan/alpha", "plan/beta"]),
    );
  });

  // AC: @dispatch-remote-branch-sync ac-active-target-removed-on-cleanup
  it("removes an orphaned integration target after cleanup but never removes the configured base branch", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);

    const orphanedWorkspaceId = testUlid("WS", 1);
    await saveWorkspaceRecord(projectDir, {
      taskRef: "@01TASK00000000000000000005",
      taskSlug: "task-plan-cleanup",
      targetBranch: "plan/cleanup",
      workspaceId: orphanedWorkspaceId,
    });

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    expect(new Set(engine.getTargetSyncStatus().activeTargets)).toEqual(
      new Set(["dev", "plan/cleanup"]),
    );

    await saveWorkspaceRecord(projectDir, {
      taskRef: "@01TASK00000000000000000005",
      taskSlug: "task-plan-cleanup",
      targetBranch: "plan/cleanup",
      lifecycleState: "closed",
      workspaceId: orphanedWorkspaceId,
    });

    await (engine as any)._removeActiveTargetIfOrphaned("plan/cleanup");
    await (engine as any)._removeActiveTargetIfOrphaned("dev");

    expect(engine.getTargetSyncStatus().activeTargets).toEqual(["dev"]);

    await engine.stop();
  });

  it("keeps active target resolution shared between startup bookkeeping and direct helper updates", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    await (engine as any)._addActiveTarget("plan/shared");

    expect(new Set((engine as any)._resolveActiveTargets())).toEqual(
      new Set(["dev", "plan/shared"]),
    );
    expect(new Set(engine.getTargetSyncStatus().activeTargets)).toEqual(
      new Set(["dev", "plan/shared"]),
    );
    expect((engine as any)._resolveBaseBranch()).toBe("dev");
    expect((engine as any)._resolveBaseBranch("plan/shared")).toBe("plan/shared");
    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-push-target-after-merge
  it("pushes the workspace-specific integration target after merge without pushing the base branch", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);

    git(projectDir, "checkout -b plan/alpha dev");
    git(projectDir, "push -u origin plan/alpha");

    await fs.writeFile(path.join(projectDir, "dev-only.txt"), "dev only\n", "utf-8");
    git(projectDir, "checkout dev");
    git(projectDir, "add dev-only.txt");
    git(projectDir, 'commit -m "dev only commit"');
    const localDevHead = git(projectDir, "rev-parse dev");
    const remoteDevHeadBefore = git(projectDir, "rev-parse origin/dev");

    git(projectDir, "checkout plan/alpha");
    await fs.writeFile(path.join(projectDir, "plan-only.txt"), "plan only\n", "utf-8");
    git(projectDir, "add plan-only.txt");
    git(projectDir, 'commit -m "plan only commit"');
    const localPlanHead = git(projectDir, "rev-parse plan/alpha");
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    await (engine as any)._pushIntegrationTargetAsync("plan/alpha", "post-merge");

    git(projectDir, "fetch origin");
    expect(git(projectDir, "rev-parse origin/plan/alpha")).toBe(localPlanHead);
    expect(git(projectDir, "rev-parse origin/dev")).toBe(remoteDevHeadBefore);
    expect(git(projectDir, "rev-parse dev")).toBe(localDevHead);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-concurrent-merge-same-target
  // AC: @dispatch-remote-branch-sync ac-concurrent-merge-fix-cycle
  it("rejects the stale second reviewer push on the same target and returns that task to fix cycle", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);

    await createTrackedBranch(
      projectDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\n",
      "create plan alpha",
    );
    await createTrackedBranch(
      projectDir,
      "dispatch/task/concurrent-merge-first/01ws1111111111111111111111",
      "first-change.txt",
      "first reviewer change\n",
      "first reviewer branch",
    );
    const taskRef = "@concurrent-merge-second";
    const reviewRef = "@concurrent-merge-review";
    const taskTitle = "Concurrent merge stale reviewer";

    kspec(
      'plan add --title "Alpha Plan" --content "Plan alpha content" --slug alpha-plan',
      projectDir,
    );
    kspec('plan set @alpha-plan --branch "plan/alpha"', projectDir);
    kspec(
      `task add --title "${taskTitle}" --slug concurrent-merge-second --plan-ref @alpha-plan`,
      projectDir,
    );
    kspec("task start @concurrent-merge-second", projectDir);

    const workerWorkspace = await workspaceModule.provisionDispatchWorkspace({
      projectDir,
      taskRef,
      taskStatus: "in_progress",
      task: {
        title: taskTitle,
        slugs: ["concurrent-merge-second"],
        plan_ref: "@alpha-plan",
      },
    });
    await fs.writeFile(
      path.join(workerWorkspace.cwd, "second-change.txt"),
      "second reviewer change\n",
      "utf-8",
    );
    git(workerWorkspace.cwd, "add second-change.txt");
    git(workerWorkspace.cwd, 'commit -m "second reviewer branch"');
    git(workerWorkspace.cwd, "push -u origin HEAD");

    kspec("task submit @concurrent-merge-second", projectDir);
    kspec(
      'review add --title "Concurrent merge stale reviewer" --slug concurrent-merge-review --subject-type task --subject-ref @concurrent-merge-second',
      projectDir,
    );

    const reviewerAgent = {
      _ulid: testUlid("AGNT"),
      id: "pr-reviewer",
      name: "PR Reviewer",
      capabilities: [],
      tools: [],
      conventions: [],
      skills: [],
      dispatch: [{ on: "task.pending_review" }],
      adapter: "mock-acp",
      auto_approve: false,
      concurrency: { max_concurrent: 1 },
    };
    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    const originalPushIntegrationTarget = workspaceModule.pushIntegrationTarget;
    let resolvePushResult!: (value: workspaceModule.PushIntegrationTargetResult) => void;
    const pushResultPromise = new Promise<workspaceModule.PushIntegrationTargetResult>(
      (resolve) => {
        resolvePushResult = resolve;
      },
    );
    const pushSpy = vi
      .spyOn(workspaceModule, "pushIntegrationTarget")
      .mockImplementation(
        async (...args: Parameters<typeof workspaceModule.pushIntegrationTarget>) => {
          const result = await originalPushIntegrationTarget(...args);
          resolvePushResult(result);
          return result;
        },
      );

    let reviewerOneDir: string | null = null;
    try {
      reviewerOneDir = await cloneRemote(remoteDir);

      git(reviewerOneDir, "checkout -b plan/alpha origin/plan/alpha");
      git(
        reviewerOneDir,
        'merge --no-ff origin/dispatch/task/concurrent-merge-first/01ws1111111111111111111111 -m "Merge first reviewer branch"',
      );
      const firstMergedHead = git(reviewerOneDir, "rev-parse HEAD");

      git(reviewerOneDir, "push origin HEAD:plan/alpha");
      git(projectDir, "checkout plan/alpha");
      git(
        projectDir,
        `merge --no-ff ${workerWorkspace.metadata.canonicalBranch} -m "Merge second reviewer branch"`,
      );
      const secondMergedHead = git(projectDir, "rev-parse HEAD");

      git(projectDir, "fetch origin plan/alpha");
      expect(git(projectDir, "rev-parse origin/plan/alpha")).toBe(firstMergedHead);
      expect(git(projectDir, "rev-parse origin/plan/alpha")).not.toBe(secondMergedHead);

      vi.spyOn(invocationModule, "runInvocation").mockImplementation(async () => {
        kspec(
          "review verdict @concurrent-merge-review --decision request_changes --reviewer stale-reviewer",
          projectDir,
        );
        return {
          session: {} as any,
          outcome: "success",
          durationMs: 1,
          turnCount: 1,
        };
      });

      const task = kspecJson<any>("task get @concurrent-merge-second --json", projectDir);
      const entry = {
        agent: reviewerAgent,
        change: {
          taskRef,
          fromStatus: "in_progress",
          toStatus: "pending_review",
          task,
        },
        retryCount: 0,
        nextRetryAt: 0,
        enqueuedAtMs: Date.now(),
        sequence: 1,
      };

      await (engine as any)._spawnInvocation(reviewerAgent, entry);

      const pushResult = await pushResultPromise;
      expect(pushSpy).toHaveBeenCalledWith(projectDir, "plan/alpha", "origin");
      expect(pushResult.pushed).toBe(false);
      expect(pushResult.skipped).toBe(false);
      expect(pushResult.error).toMatch(/non-fast-forward|\[rejected\]|fetch first/i);

      const updatedTask = kspecJson<{ status: string; review_ref: string | null }>(
        "task get @concurrent-merge-second --json",
        projectDir,
      );
      expect(updatedTask.status).toBe("needs_work");
      expect(updatedTask.review_ref).toBe(reviewRef);

      const review = kspecJson<{ lifecycle_state: string; disposition: string }>(
        "review get @concurrent-merge-review --json",
        projectDir,
      );
      expect(review.lifecycle_state).toBe("closed");
      expect(review.disposition).toBe("changes_requested");
    } finally {
      vi.restoreAllMocks();
      await engine.stop();
      if (reviewerOneDir) await cleanupTempDir(reviewerOneDir);
    }
  });

  // AC: @dispatch-remote-branch-sync ac-push-target-periodic
  // AC: @dispatch-remote-branch-sync ac-push-target-periodic-retry
  it("pushes every active integration target with local commits during periodic reconciliation", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);

    git(projectDir, "checkout -b plan/alpha dev");
    git(projectDir, "push -u origin plan/alpha");

    await saveWorkspaceRecord(projectDir, {
      taskRef: "@01TASK00000000000000000006",
      taskSlug: "task-plan-alpha-push",
      targetBranch: "plan/alpha",
    });

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    git(projectDir, "checkout dev");
    await fs.writeFile(path.join(projectDir, "dev-periodic.txt"), "dev periodic\n", "utf-8");
    git(projectDir, "add dev-periodic.txt");
    git(projectDir, 'commit -m "dev periodic commit"');
    const localDevHead = git(projectDir, "rev-parse dev");

    git(projectDir, "checkout plan/alpha");
    await fs.writeFile(path.join(projectDir, "plan-periodic.txt"), "plan periodic\n", "utf-8");
    git(projectDir, "add plan-periodic.txt");
    git(projectDir, 'commit -m "plan periodic commit"');
    const localPlanHead = git(projectDir, "rev-parse plan/alpha");
    git(projectDir, "checkout dev");

    await (engine as any)._reconcile();

    git(projectDir, "fetch origin");
    expect(git(projectDir, "rev-parse origin/dev")).toBe(localDevHead);
    expect(git(projectDir, "rev-parse origin/plan/alpha")).toBe(localPlanHead);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-push-target-periodic
  it("does not degrade a clean active target during periodic reconciliation when another worktree owns the branch checkout", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);

    git(projectDir, "checkout -b human-feature dev");

    const occupiedWorktreeDir = await createTempDir("kspec-target-sync-occupied-");
    execSync(`git worktree add --force "${occupiedWorktreeDir}" dev`, {
      cwd: projectDir,
      stdio: "pipe",
      env: workspaceModule.buildDispatchGitEnv(),
    });

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    const pushSpy = vi.spyOn(workspaceModule, "pushIntegrationTarget");

    try {
      pushSpy.mockClear();
      (engine as any).dispatchRemote = "origin";
      (engine as any)._activeTargets = new Set(["dev"]);

      await (engine as any)._pushActiveTargetsAsync("periodic-sync");

      expect(pushSpy).not.toHaveBeenCalled();
      expect(engine.getTargetSyncStatus().degraded.active).toBe(false);
    } finally {
      execSync(`git worktree remove --force "${occupiedWorktreeDir}"`, {
        cwd: projectDir,
        stdio: "pipe",
        env: workspaceModule.buildDispatchGitEnv(),
      });
      await cleanupTempDir(occupiedWorktreeDir);
    }
  });

  // AC: @dispatch-remote-branch-sync ac-target-push-serialization
  it("skips a second push when the same integration target is already being pushed", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);

    await fs.writeFile(path.join(projectDir, "dev-serialization.txt"), "serialization\n", "utf-8");
    git(projectDir, "add dev-serialization.txt");
    git(projectDir, 'commit -m "dev serialization commit"');

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    let releaseFirstPush: (() => void) | null = null;
    const startedBranches: string[] = [];
    vi.spyOn(workspaceModule, "resolveDispatchIntegrationMutationScope").mockImplementation(
      async (_projectDir, branch) => ({
        projectDir,
        integrationBranch: branch,
        currentBranch: "dev",
        targetBranchCheckedOut: false,
        mutationCwd: null,
      }),
    );
    vi.spyOn(workspaceModule, "pushIntegrationTarget").mockImplementation(
      async (_projectDir, branch) => {
        startedBranches.push(branch);
        await new Promise<void>((resolve) => {
          releaseFirstPush = resolve;
        });
        return { pushed: true, skipped: false, error: null };
      },
    );

    const firstPush = (engine as any)._pushIntegrationTargetAsync("dev", "post-merge");
    await vi.waitFor(() => {
      expect(startedBranches).toEqual(["dev"]);
    });

    expect((engine as any)._targetPushesInProgress.has("dev")).toBe(true);

    await (engine as any)._pushIntegrationTargetAsync("dev", "periodic-sync");

    expect(startedBranches).toEqual(["dev"]);

    releaseFirstPush?.();
    await firstPush;

    expect((engine as any)._targetPushesInProgress.has("dev")).toBe(false);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-target-push-cross-branch-concurrency
  it("allows pushes to different integration targets to proceed concurrently", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);

    git(projectDir, "checkout -b plan/alpha dev");
    git(projectDir, "push -u origin plan/alpha");

    git(projectDir, "checkout dev");
    await fs.writeFile(path.join(projectDir, "dev-concurrency.txt"), "dev concurrency\n", "utf-8");
    git(projectDir, "add dev-concurrency.txt");
    git(projectDir, 'commit -m "dev concurrency commit"');

    git(projectDir, "checkout plan/alpha");
    await fs.writeFile(
      path.join(projectDir, "plan-concurrency.txt"),
      "plan concurrency\n",
      "utf-8",
    );
    git(projectDir, "add plan-concurrency.txt");
    git(projectDir, 'commit -m "plan concurrency commit"');
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    const releaseByBranch = new Map<string, () => void>();
    const startedBranches: string[] = [];
    vi.spyOn(workspaceModule, "resolveDispatchIntegrationMutationScope").mockImplementation(
      async (_projectDir, branch) => ({
        projectDir,
        integrationBranch: branch,
        currentBranch: "dev",
        targetBranchCheckedOut: false,
        mutationCwd: null,
      }),
    );
    vi.spyOn(workspaceModule, "pushIntegrationTarget").mockImplementation(
      async (_projectDir, branch) => {
        startedBranches.push(branch);
        await new Promise<void>((resolve) => {
          releaseByBranch.set(branch, resolve);
        });
        return { pushed: true, skipped: false, error: null };
      },
    );

    const devPush = (engine as any)._pushIntegrationTargetAsync("dev", "periodic-sync");
    const planPush = (engine as any)._pushIntegrationTargetAsync("plan/alpha", "periodic-sync");
    await vi.waitFor(() => {
      expect(new Set(startedBranches)).toEqual(new Set(["dev", "plan/alpha"]));
    });

    expect((engine as any)._targetPushesInProgress.has("dev")).toBe(true);
    expect((engine as any)._targetPushesInProgress.has("plan/alpha")).toBe(true);

    releaseByBranch.get("dev")?.();
    releaseByBranch.get("plan/alpha")?.();
    await Promise.all([devPush, planPush]);

    expect((engine as any)._targetPushesInProgress.size).toBe(0);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-target-push-cross-branch-concurrency
  it("allows concurrent pushes to different integration targets with real branches", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);

    git(projectDir, "checkout -b plan/alpha dev");
    git(projectDir, "push -u origin plan/alpha");

    git(projectDir, "checkout dev");
    await fs.writeFile(path.join(projectDir, "dev-concurrency.txt"), "dev concurrency\n", "utf-8");
    git(projectDir, "add dev-concurrency.txt");
    git(projectDir, 'commit -m "dev concurrency commit"');

    git(projectDir, "checkout plan/alpha");
    await fs.writeFile(
      path.join(projectDir, "plan-concurrency.txt"),
      "plan concurrency\n",
      "utf-8",
    );
    git(projectDir, "add plan-concurrency.txt");
    git(projectDir, 'commit -m "plan concurrency commit"');
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    const releaseByBranch = new Map<string, () => void>();
    const startedBranches: string[] = [];
    vi.spyOn(workspaceModule, "resolveDispatchIntegrationMutationScope").mockImplementation(
      async (_projectDir, branch) => ({
        projectDir,
        integrationBranch: branch,
        currentBranch: "dev",
        targetBranchCheckedOut: false,
        mutationCwd: null,
      }),
    );
    vi.spyOn(workspaceModule, "pushIntegrationTarget").mockImplementation(
      async (_projectDir, branch) => {
        startedBranches.push(branch);
        await new Promise<void>((resolve) => {
          releaseByBranch.set(branch, resolve);
        });
        return { pushed: true, skipped: false, error: null };
      },
    );

    const devPush = (engine as any)._pushIntegrationTargetAsync("dev", "periodic-sync");
    const planPush = (engine as any)._pushIntegrationTargetAsync("plan/alpha", "periodic-sync");
    await vi.waitFor(() => {
      expect(new Set(startedBranches)).toEqual(new Set(["dev", "plan/alpha"]));
    });

    expect((engine as any)._targetPushesInProgress.has("dev")).toBe(true);
    expect((engine as any)._targetPushesInProgress.has("plan/alpha")).toBe(true);

    releaseByBranch.get("dev")?.();
    releaseByBranch.get("plan/alpha")?.();
    await Promise.all([devPush, planPush]);

    expect((engine as any)._targetPushesInProgress.size).toBe(0);

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
      const result = await engine._syncTarget();

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
    expect(
      await workspaceModule.ensureDispatchIntegrationTargetCheckoutCoherence(projectDir, "dev"),
    ).toEqual({
      repaired: false,
      drifted: false,
      previousCommit: null,
    });

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
    expect(
      await workspaceModule.ensureDispatchIntegrationTargetCheckoutCoherence(projectDir, "dev"),
    ).toEqual({
      repaired: false,
      drifted: false,
      previousCommit: null,
    });

    await engine.stop();
  });

  // AC: @dispatch-shared-checkout-safety ac-3
  it("refuses automatic repair when staged tracked changes appear after a known coherent branch tip", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const previousTip = git(projectDir, "rev-parse dev");
    await fs.writeFile(path.join(projectDir, "dev.txt"), "dev\nsynced\n", "utf-8");
    git(projectDir, "add dev.txt");
    git(projectDir, 'commit -m "advance dev tip"');

    expect(
      await workspaceModule.ensureDispatchIntegrationTargetCheckoutCoherence(projectDir, "dev"),
    ).toEqual({
      repaired: false,
      drifted: false,
      previousCommit: null,
    });

    git(projectDir, `checkout ${previousTip} -- dev.txt`);
    git(projectDir, "add dev.txt");

    await expect(
      workspaceModule.ensureDispatchIntegrationTargetCheckoutCoherence(projectDir, "dev"),
    ).rejects.toThrowError(
      /staged tracked changes after dispatch already observed this branch tip as coherent/,
    );
    expect(git(projectDir, "diff --cached --name-only")).toContain("dev.txt");
    expect(git(projectDir, "rev-parse HEAD")).not.toBe(previousTip);
  });

  // AC: @dispatch-integration-mutation-scope ac-1
  it("sanitizes inherited git context before direct integration-target git commands", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout dev");

    const poisonDir = await setupPoisonRepo();
    try {
      await withPoisonedGitContext(poisonDir, async () => {
        const result = await workspaceModule.runDispatchIntegrationTargetGit(projectDir, "dev", [
          "rev-parse",
          "--show-toplevel",
        ]);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(projectDir);
      });

      expect(git(poisonDir, "rev-parse --show-toplevel")).toBe(poisonDir);
      expect(git(poisonDir, "rev-parse HEAD")).not.toBe(git(projectDir, "rev-parse HEAD"));
    } finally {
      await cleanupTempDir(poisonDir);
    }
  });

  // AC: @dispatch-integration-mutation-scope ac-1
  // AC: @dispatch-integration-mutation-scope ac-2
  it("syncs the integration branch while leaving a different checked-out branch untouched", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout -b human-feature");

    const remoteTip = await pushRemoteCommit(
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

    expect(git(projectDir, "rev-parse dev")).toBe(remoteTip);
    const result = await engine._syncTarget();

    expect(result).toBe("up_to_date");
    expect(git(projectDir, "branch --show-current")).toBe("human-feature");
    expect(git(projectDir, "rev-parse human-feature")).toBe(humanHeadBefore);
    expect(git(projectDir, "rev-parse dev")).toBe(remoteTip);
    expect(localDevBefore).not.toBe(remoteTip);
    expect(engine.getDegradedState()).toEqual([]);

    await engine.stop();
  });

  // AC: @dispatch-integration-mutation-scope ac-1
  // AC: @dispatch-integration-mutation-scope ac-3
  // AC: @dispatch-integration-mutation-scope ac-4
  it("restores a missing local integration branch from remote and syncs it without touching the current branch", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout -b human-feature");

    const humanHeadBefore = git(projectDir, "rev-parse human-feature");
    git(projectDir, "branch -D dev");
    git(projectDir, "update-ref -d refs/remotes/origin/dev");

    const remoteTip = await pushRemoteCommit(
      remoteDir,
      "dev",
      "remote-restored.txt",
      "restored\n",
      "remote restored branch",
    );

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    expect(git(projectDir, "rev-parse dev")).toBe(remoteTip);
    const result = await engine._syncTarget();

    expect(result).toBe("up_to_date");
    expect(git(projectDir, "branch --show-current")).toBe("human-feature");
    expect(git(projectDir, "rev-parse human-feature")).toBe(humanHeadBefore);
    expect(git(projectDir, "rev-parse dev")).toBe(remoteTip);
    expect(engine.getDegradedState()).toEqual([]);

    await engine.stop();
  });

  // AC: @dispatch-integration-mutation-scope ac-1
  // AC: @dispatch-integration-mutation-scope ac-2
  // AC: @dispatch-integration-mutation-scope ac-4
  // AC: @dispatch-integration-mutation-scope ac-auxiliary-target-checkout-refusal-identifies-blocker
  it("refuses non-checked-out sync when an auxiliary worktree has the integration branch checked out", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout -b human-feature");

    const auxiliaryWorktreeDir = `${projectDir}-integration-owner`;
    execSync(`git worktree add "${auxiliaryWorktreeDir}" dev`, {
      cwd: projectDir,
      stdio: "pipe",
      env: workspaceModule.buildDispatchGitEnv(),
    });
    // Mark the worktree as a dispatch auxiliary worktree by writing the
    // workspace metadata marker file. This is the canonical auxiliary
    // classification signal.
    await fs.writeFile(
      path.join(auxiliaryWorktreeDir, ".kspec-dispatch-workspace.json"),
      `${JSON.stringify({ role: "helper", purpose: "test" })}\n`,
      "utf-8",
    );

    try {
      const humanHeadBefore = git(projectDir, "rev-parse human-feature");
      const localDevBefore = git(projectDir, "rev-parse dev");
      const auxiliaryHeadBefore = git(auxiliaryWorktreeDir, "rev-parse HEAD");

      await pushRemoteCommit(
        remoteDir,
        "dev",
        "remote-blocked.txt",
        "blocked\n",
        "blocked by aux worktree",
      );

      const engine = new DispatchEngine({
        projectDir,
        reconcileIntervalMs: 0,
        coalesceWindowMs: 0,
      });
      await engine.start();

      expect(engine.getDegradedState()).toHaveLength(1);
      expect(engine.getDegradedState()[0].kind).toBe("occupied-checkout");
      expect(engine.getDegradedState()[0].reason.toLowerCase()).toContain("auxiliary");
      expect(engine.getDegradedState()[0].reason).toContain(auxiliaryWorktreeDir);
      expect(git(projectDir, "branch --show-current")).toBe("human-feature");
      expect(git(projectDir, "rev-parse human-feature")).toBe(humanHeadBefore);
      expect(git(projectDir, "rev-parse dev")).toBe(localDevBefore);
      expect(git(auxiliaryWorktreeDir, "rev-parse HEAD")).toBe(auxiliaryHeadBefore);
      expect(await engine._syncTarget()).toBe("unsafe_target");

      await engine.stop();
    } finally {
      git(projectDir, `worktree remove --force "${auxiliaryWorktreeDir}"`);
    }
  });

  // AC: @dispatch-integration-mutation-scope ac-clean-occupied-target-checkout-is-valid-mutation-surface
  // AC: @dispatch-remote-branch-sync ac-clean-occupied-target-sync-and-push
  it("syncs through a clean eligible non-auxiliary occupied target checkout without entering degraded state", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout -b human-feature");

    // A plain, user/project-owned worktree that happens to have the
    // integration target branch checked out. No dispatch metadata, not
    // under the dispatch worktree root.
    const eligibleOccupied = `${projectDir}-user-dev-checkout`;
    execSync(`git worktree add "${eligibleOccupied}" dev`, {
      cwd: projectDir,
      stdio: "pipe",
      env: workspaceModule.buildDispatchGitEnv(),
    });

    try {
      const humanHeadBefore = git(projectDir, "rev-parse human-feature");

      const remoteTip = await pushRemoteCommit(
        remoteDir,
        "dev",
        "eligible-occupied-sync.txt",
        "eligible\n",
        "advance remote during clean occupancy",
      );

      const engine = new DispatchEngine({
        projectDir,
        reconcileIntervalMs: 0,
        coalesceWindowMs: 0,
      });
      await engine.start();

      // Sync should not degrade the engine: the occupied checkout is an
      // eligible mutation surface and the sync flows through it.
      const result = await engine._syncTarget();
      expect(["synced", "up_to_date"]).toContain(result);
      expect(engine.getDegradedState()).toEqual([]);

      // Dispatch root stays on its current branch — sync did not move it.
      expect(git(projectDir, "branch --show-current")).toBe("human-feature");
      expect(git(projectDir, "rev-parse human-feature")).toBe(humanHeadBefore);

      // The eligible occupied worktree advanced to the remote tip and the
      // local dev ref matches it (branch-coherent merge).
      expect(git(projectDir, "rev-parse dev")).toBe(remoteTip);
      expect(git(eligibleOccupied, "rev-parse HEAD")).toBe(remoteTip);
      expect(git(eligibleOccupied, "branch --show-current")).toBe("dev");

      // No tracked drift in the occupied checkout after the merge.
      const status = execSync("git status --porcelain --untracked-files=no", {
        cwd: eligibleOccupied,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(status).toBe("");

      await engine.stop();
    } finally {
      git(projectDir, `worktree remove --force "${eligibleOccupied}"`);
    }
  });

  // AC: @dispatch-remote-branch-sync ac-clean-occupied-target-sync-and-push
  // AC: @dispatch-integration-mutation-scope ac-clean-occupied-target-checkout-is-valid-mutation-surface
  it("does not degrade a clean eligible occupied target during start-time sync", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout -b human-feature");

    const eligibleOccupied = `${projectDir}-user-dev-start`;
    execSync(`git worktree add "${eligibleOccupied}" dev`, {
      cwd: projectDir,
      stdio: "pipe",
      env: workspaceModule.buildDispatchGitEnv(),
    });

    try {
      const engine = new DispatchEngine({
        projectDir,
        reconcileIntervalMs: 0,
        coalesceWindowMs: 0,
      });
      await engine.start();

      // Start-time target sync ran without entering degraded state because the
      // occupied checkout is an eligible mutation surface.
      expect(engine.getDegradedState()).toEqual([]);
      expect(engine.getTargetSyncStatus().degraded.active).toBe(false);

      await engine.stop();
    } finally {
      git(projectDir, `worktree remove --force "${eligibleOccupied}"`);
    }
  });

  // AC: @dispatch-integration-mutation-scope ac-dirty-occupied-target-refusal-identifies-blocker
  it("refuses a sync when the eligible occupied target checkout has tracked modifications", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout -b human-feature");

    const dirtyOccupied = `${projectDir}-user-dev-dirty`;
    execSync(`git worktree add "${dirtyOccupied}" dev`, {
      cwd: projectDir,
      stdio: "pipe",
      env: workspaceModule.buildDispatchGitEnv(),
    });
    // Add tracked modifications to make the eligible occupied checkout
    // unsafe to mutate.
    await fs.writeFile(path.join(dirtyOccupied, "dev.txt"), "dev\nuser tracked drift\n", "utf-8");

    try {
      const engine = new DispatchEngine({
        projectDir,
        reconcileIntervalMs: 0,
        coalesceWindowMs: 0,
      });
      await engine.start();

      expect(engine.getDegradedState()).toHaveLength(1);
      const degraded = engine.getDegradedState()[0];
      expect(degraded.kind).toBe("occupied-checkout");
      expect(degraded.reason.toLowerCase()).toMatch(/tracked modifications|uncommitted/);
      expect(degraded.reason).toContain(dirtyOccupied);
      expect(degraded.reason.toLowerCase()).toMatch(/commit|stash|discard|detach/);

      // The dirty tracked drift in the occupant remains untouched.
      const occupiedStatus = execSync("git status --porcelain -- dev.txt", {
        cwd: dirtyOccupied,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(occupiedStatus).toBe(" M dev.txt\n");

      await engine.stop();
    } finally {
      // Clean up tracked drift before removal.
      execSync(`git -C "${dirtyOccupied}" checkout -- dev.txt`, { stdio: "pipe" });
      git(projectDir, `worktree remove --force "${dirtyOccupied}"`);
    }
  });

  // AC: @dispatch-integration-mutation-scope ac-dirty-occupied-target-refusal-identifies-blocker
  // AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
  it("refuses a sync when the occupied target checkout has an untracked file at a path the incoming remote commit writes", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout -b human-feature");

    const hazardOccupied = `${projectDir}-user-dev-overwrite`;
    execSync(`git worktree add "${hazardOccupied}" dev`, {
      cwd: projectDir,
      stdio: "pipe",
      env: workspaceModule.buildDispatchGitEnv(),
    });

    // Push a new file on remote, then drop an untracked file at the same path
    // in the eligible occupied checkout. The fast-forward sync would have to
    // overwrite that untracked file — Git refuses such a checkout, and dispatch
    // must classify this as an occupied-checkout blocker instead of divergence
    // so the operator gets cleanup guidance rather than a remote-reset hint.
    const hazardFile = "remote-only-overwrite.txt";
    await pushRemoteCommit(remoteDir, "dev", hazardFile, "remote\n", "remote adds overwrite file");
    await fs.writeFile(path.join(hazardOccupied, hazardFile), "local untracked content\n", "utf-8");

    const localDevBefore = git(projectDir, "rev-parse dev");
    const hazardHeadBefore = git(hazardOccupied, "rev-parse HEAD");

    try {
      const engine = new DispatchEngine({
        projectDir,
        reconcileIntervalMs: 0,
        coalesceWindowMs: 0,
      });
      await engine.start();

      expect(engine.getDegradedState()).toHaveLength(1);
      const degraded = engine.getDegradedState()[0];
      expect(degraded.kind).toBe("occupied-checkout");
      expect(degraded.reason).toContain(hazardOccupied);
      expect(degraded.reason).toContain(hazardFile);
      // Recovery guidance must name a cleanup action against the occupied
      // checkout, not a remote-reset action against the branch.
      expect(degraded.reason.toLowerCase()).toMatch(/remove|stash|commit|detach/);
      expect(degraded.reason.toLowerCase()).not.toMatch(/rewritten|reset --hard/);

      expect(await engine._syncTarget()).toBe("unsafe_target");

      // Refs and worktree state are untouched: no merge was attempted because
      // the hazard is detected before ref movement.
      expect(git(projectDir, "rev-parse dev")).toBe(localDevBefore);
      expect(git(hazardOccupied, "rev-parse HEAD")).toBe(hazardHeadBefore);
      // The untracked hazard file is still present in the occupied checkout.
      const occupiedHazardStatus = execSync(`git status --porcelain -- "${hazardFile}"`, {
        cwd: hazardOccupied,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(occupiedHazardStatus).toBe(`?? ${hazardFile}\n`);

      await engine.stop();
    } finally {
      await fs.rm(path.join(hazardOccupied, hazardFile), { force: true });
      git(projectDir, `worktree remove --force "${hazardOccupied}"`);
    }
  });

  // AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
  it("recovers from untracked-overwrite-hazard degraded state after the blocking file is removed", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout -b human-feature");

    const hazardOccupied = `${projectDir}-user-dev-overwrite-recover`;
    execSync(`git worktree add "${hazardOccupied}" dev`, {
      cwd: projectDir,
      stdio: "pipe",
      env: workspaceModule.buildDispatchGitEnv(),
    });

    const hazardFile = "recovery-target.txt";
    const remoteTip = await pushRemoteCommit(
      remoteDir,
      "dev",
      hazardFile,
      "remote\n",
      "remote adds recovery target file",
    );
    await fs.writeFile(path.join(hazardOccupied, hazardFile), "local untracked content\n", "utf-8");

    try {
      const engine = new DispatchEngine({
        projectDir,
        reconcileIntervalMs: 0,
        coalesceWindowMs: 0,
      });
      await engine.start();

      expect(engine.getDegradedState()).toHaveLength(1);
      expect(engine.getDegradedState()[0].kind).toBe("occupied-checkout");

      // Operator follows the guidance: remove the blocking untracked file.
      await fs.rm(path.join(hazardOccupied, hazardFile));

      // Subsequent sync clears degraded state and advances both the eligible
      // checkout and the local dev ref to the remote tip.
      const result = await engine._syncTarget();
      expect(["synced", "up_to_date"]).toContain(result);
      expect(engine.getDegradedState()).toEqual([]);
      expect(git(projectDir, "rev-parse dev")).toBe(remoteTip);
      expect(git(hazardOccupied, "rev-parse HEAD")).toBe(remoteTip);

      await engine.stop();
    } finally {
      git(projectDir, `worktree remove --force "${hazardOccupied}"`);
    }
  });

  // AC: @dispatch-integration-mutation-scope ac-dirty-occupied-target-refusal-identifies-blocker
  // AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
  //
  // Directory/file hazard direction 1: remote adds a path under a directory
  // that does not yet exist locally, but the occupied checkout has an
  // untracked FILE at the same name. Git refuses the fast-forward with
  // "untracked working tree files would be overwritten by merge: <dir>".
  // Dispatch must detect this before attempting the merge so degraded state
  // is occupied-checkout (with cleanup guidance) and not divergence.
  it("refuses a sync when the occupied checkout has an untracked file blocking a directory the incoming commit creates", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout -b human-feature");

    const hazardOccupied = `${projectDir}-user-dev-dirfile`;
    execSync(`git worktree add "${hazardOccupied}" dev`, {
      cwd: projectDir,
      stdio: "pipe",
      env: workspaceModule.buildDispatchGitEnv(),
    });

    // Push a remote commit that adds a file under conflict-dir/, then drop
    // an untracked FILE named conflict-dir in the occupied checkout. The
    // merge cannot create the directory because the name is taken.
    const hazardName = "conflict-dir";
    const cloneDir = await createTempDir("kspec-target-sync-dirfile-clone-");
    try {
      git(cloneDir, `clone "${remoteDir}" .`);
      git(cloneDir, 'config user.email "test@example.com"');
      git(cloneDir, 'config user.name "Test User"');
      git(cloneDir, "checkout dev");
      await fs.mkdir(path.join(cloneDir, hazardName), { recursive: true });
      await fs.writeFile(path.join(cloneDir, hazardName, "remote.txt"), "remote\n", "utf-8");
      git(cloneDir, `add ${hazardName}/remote.txt`);
      git(cloneDir, 'commit -m "remote adds file under conflict-dir"');
      git(cloneDir, "push origin dev");
    } finally {
      await cleanupTempDir(cloneDir);
    }

    await fs.writeFile(path.join(hazardOccupied, hazardName), "local untracked\n", "utf-8");

    const localDevBefore = git(projectDir, "rev-parse dev");
    const hazardHeadBefore = git(hazardOccupied, "rev-parse HEAD");

    try {
      const engine = new DispatchEngine({
        projectDir,
        reconcileIntervalMs: 0,
        coalesceWindowMs: 0,
      });
      await engine.start();

      expect(engine.getDegradedState()).toHaveLength(1);
      const degraded = engine.getDegradedState()[0];
      expect(degraded.kind).toBe("occupied-checkout");
      expect(degraded.reason).toContain(hazardOccupied);
      expect(degraded.reason).toContain(hazardName);
      expect(degraded.reason.toLowerCase()).toMatch(/remove|stash|commit|detach/);
      expect(degraded.reason.toLowerCase()).not.toMatch(/rewritten|reset --hard/);

      expect(await engine._syncTarget()).toBe("unsafe_target");

      // Refs and worktree state untouched.
      expect(git(projectDir, "rev-parse dev")).toBe(localDevBefore);
      expect(git(hazardOccupied, "rev-parse HEAD")).toBe(hazardHeadBefore);

      await engine.stop();
    } finally {
      await fs.rm(path.join(hazardOccupied, hazardName), { force: true });
      git(projectDir, `worktree remove --force "${hazardOccupied}"`);
    }
  });

  // AC: @dispatch-integration-mutation-scope ac-dirty-occupied-target-refusal-identifies-blocker
  // AC: @dispatch-remote-branch-sync ac-unsafe-occupied-checkout-degraded-recovery
  //
  // Directory/file hazard direction 2: remote adds a FILE at a name that the
  // occupied checkout already holds as a directory of untracked content. Git
  // refuses with "Updating the following directories would lose untracked
  // files in them". Same dispatch contract: this is an occupied-checkout
  // blocker, not divergence.
  it("refuses a sync when the occupied checkout has an untracked directory blocking a file the incoming commit creates", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout -b human-feature");

    const hazardOccupied = `${projectDir}-user-dev-filedir`;
    execSync(`git worktree add "${hazardOccupied}" dev`, {
      cwd: projectDir,
      stdio: "pipe",
      env: workspaceModule.buildDispatchGitEnv(),
    });

    // Remote commits a file at path "config-blob". The occupied checkout
    // has an untracked directory of the same name with files inside.
    const hazardName = "config-blob";
    await pushRemoteCommit(
      remoteDir,
      "dev",
      hazardName,
      "remote file content\n",
      "remote adds config-blob as a file",
    );

    await fs.mkdir(path.join(hazardOccupied, hazardName), { recursive: true });
    await fs.writeFile(
      path.join(hazardOccupied, hazardName, "user-notes.txt"),
      "local untracked\n",
      "utf-8",
    );

    const localDevBefore = git(projectDir, "rev-parse dev");
    const hazardHeadBefore = git(hazardOccupied, "rev-parse HEAD");

    try {
      const engine = new DispatchEngine({
        projectDir,
        reconcileIntervalMs: 0,
        coalesceWindowMs: 0,
      });
      await engine.start();

      expect(engine.getDegradedState()).toHaveLength(1);
      const degraded = engine.getDegradedState()[0];
      expect(degraded.kind).toBe("occupied-checkout");
      expect(degraded.reason).toContain(hazardOccupied);
      // The untracked path Git would name is the file inside the directory.
      expect(degraded.reason).toContain(hazardName);
      expect(degraded.reason.toLowerCase()).toMatch(/remove|stash|commit|detach/);
      expect(degraded.reason.toLowerCase()).not.toMatch(/rewritten|reset --hard/);

      expect(await engine._syncTarget()).toBe("unsafe_target");

      expect(git(projectDir, "rev-parse dev")).toBe(localDevBefore);
      expect(git(hazardOccupied, "rev-parse HEAD")).toBe(hazardHeadBefore);

      await engine.stop();
    } finally {
      await fs.rm(path.join(hazardOccupied, hazardName), { recursive: true, force: true });
      git(projectDir, `worktree remove --force "${hazardOccupied}"`);
    }
  });

  // AC: @dispatch-integration-mutation-scope ac-clean-occupied-target-checkout-is-valid-mutation-surface
  //
  // Path-prefix tightness: an untracked file whose name shares a leading
  // string with a changed path but is not a directory-segment prefix (e.g.,
  // "config" vs "config.yaml") must NOT be flagged as a hazard. Otherwise
  // the hazard check would over-refuse clean eligible checkouts.
  it("does not refuse a sync when an untracked file is only a string prefix of a changed path (not a path-segment prefix)", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout -b human-feature");

    const cleanOccupied = `${projectDir}-user-dev-prefix`;
    execSync(`git worktree add "${cleanOccupied}" dev`, {
      cwd: projectDir,
      stdio: "pipe",
      env: workspaceModule.buildDispatchGitEnv(),
    });

    // Remote adds "config.yaml"; occupied checkout has unrelated untracked
    // file "config". These are sibling entries — Git is fine with both.
    const remotePath = "config.yaml";
    const remoteTip = await pushRemoteCommit(
      remoteDir,
      "dev",
      remotePath,
      "yaml: true\n",
      "remote adds config.yaml",
    );
    await fs.writeFile(path.join(cleanOccupied, "config"), "unrelated\n", "utf-8");

    try {
      const engine = new DispatchEngine({
        projectDir,
        reconcileIntervalMs: 0,
        coalesceWindowMs: 0,
      });
      await engine.start();

      expect(engine.getDegradedState()).toEqual([]);
      const result = await engine._syncTarget();
      expect(["synced", "up_to_date"]).toContain(result);
      expect(git(projectDir, "rev-parse dev")).toBe(remoteTip);
      expect(git(cleanOccupied, "rev-parse HEAD")).toBe(remoteTip);

      await engine.stop();
    } finally {
      git(projectDir, `worktree remove --force "${cleanOccupied}"`);
    }
  });

  // AC: @dispatch-integration-mutation-scope ac-auxiliary-target-checkout-refusal-identifies-blocker
  it("refuses to use a worker-style auxiliary worktree under the dispatch worktree root as a mutation surface", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    git(projectDir, "checkout -b human-feature");

    // Place the occupied worktree under the project's .kspec-worktrees/
    // directory, which is the configured dispatch worktree root by default.
    const dispatchRoot = path.join(projectDir, ".kspec-worktrees");
    await fs.mkdir(dispatchRoot, { recursive: true });
    const auxOccupied = path.join(dispatchRoot, "leaked-dev");
    execSync(`git worktree add "${auxOccupied}" dev`, {
      cwd: projectDir,
      stdio: "pipe",
      env: workspaceModule.buildDispatchGitEnv(),
    });

    try {
      const engine = new DispatchEngine({
        projectDir,
        reconcileIntervalMs: 0,
        coalesceWindowMs: 0,
      });
      await engine.start();

      expect(engine.getDegradedState()).toHaveLength(1);
      expect(engine.getDegradedState()[0].kind).toBe("occupied-checkout");
      expect(engine.getDegradedState()[0].reason.toLowerCase()).toContain("auxiliary");
      expect(engine.getDegradedState()[0].reason).toContain(auxOccupied);

      await engine.stop();
    } finally {
      git(projectDir, `worktree remove --force "${auxOccupied}"`);
    }
  });

  // AC: @dispatch-integration-mutation-scope ac-1
  // AC: @dispatch-integration-mutation-scope ac-2
  // AC: @dispatch-integration-mutation-scope ac-3
  it("syncs the intended linked shared checkout even when inherited git env points at another repo", async () => {
    const {
      sourceDir,
      sharedCheckoutDir,
      remoteDir: worktreeRemoteDir,
    } = await setupWorktreeLaunchedProjectWithRemote();
    const poisonDir = await setupPoisonRepo();

    try {
      await setupProjectFiles(sharedCheckoutDir);
      const sourceHeadBefore = git(sourceDir, "rev-parse HEAD");
      const remoteTip = await pushRemoteCommit(
        worktreeRemoteDir,
        "dev",
        "linked-shared-checkout.txt",
        "linked\n",
        "linked shared checkout sync",
      );

      await withPoisonedGitContext(poisonDir, async () => {
        const engine = new DispatchEngine({
          projectDir: sharedCheckoutDir,
          reconcileIntervalMs: 0,
          coalesceWindowMs: 0,
        });
        await engine.start();

        expect(["synced", "up_to_date"]).toContain(await engine._syncTarget());
        expect(git(sharedCheckoutDir, "rev-parse dev")).toBe(remoteTip);
        expect(git(sharedCheckoutDir, "branch --show-current")).toBe("dev");
        expect(git(sourceDir, "rev-parse HEAD")).toBe(sourceHeadBefore);
        expect(git(poisonDir, "rev-parse HEAD")).not.toBe(remoteTip);

        await engine.stop();
      });
    } finally {
      git(sourceDir, `worktree remove --force "${sharedCheckoutDir}"`);
      await cleanupTempDir(sourceDir);
      await cleanupTempDir(worktreeRemoteDir);
      await cleanupTempDir(poisonDir);
    }
  });

  // AC: @dispatch-remote-branch-sync ac-pull-ff-only
  // AC: @dispatch-remote-branch-sync ac-pull-no-merge-commits
  it("advances local branch only via fast-forward — no merge commits", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);

    // Push a new commit on remote
    const cloneDir = await createTempDir("kspec-target-sync-clone-");
    try {
      git(cloneDir, `clone "${remoteDir}" .`);
      git(cloneDir, 'config user.email "test@example.com"');
      git(cloneDir, 'config user.name "Test User"');
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
      git(cloneDir, 'config user.email "test@example.com"');
      git(cloneDir, 'config user.name "Test User"');
      git(cloneDir, "checkout dev");
      await fs.writeFile(path.join(cloneDir, "periodic.txt"), "periodic\n", "utf-8");
      git(cloneDir, "add periodic.txt");
      git(cloneDir, 'commit -m "periodic commit"');
      git(cloneDir, "push origin dev");
    } finally {
      await cleanupTempDir(cloneDir);
    }

    // Reconcile when sync is NOT stale — should NOT sync
    await (engine as any)._reconcile();
    const tipAfterFreshReconcile = git(projectDir, "rev-parse dev");
    expect(tipAfterFreshReconcile).toBe(afterStartTip);

    // Make sync stale by backdating the timestamp beyond sync_interval
    (engine as any)._targetSyncTimestamps.set("dev", Date.now() - 120_000);

    // Reconcile when sync IS stale — should sync
    await (engine as any)._reconcile();
    const tipAfterStaleReconcile = git(projectDir, "rev-parse dev");
    expect(tipAfterStaleReconcile).not.toBe(afterStartTip);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-per-target-staleness
  // AC: @dispatch-remote-branch-sync ac-per-target-staleness-isolation
  it("tracks staleness per target so syncing one branch does not refresh another", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    await createTrackedBranch(
      projectDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\n",
      "create plan alpha",
    );
    await saveWorkspaceRecord(projectDir, {
      taskRef: "@01TASK00000000000000000017",
      taskSlug: "task-plan-alpha-staleness",
      targetBranch: "plan/alpha",
    });

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    (engine as any)._targetSyncTimestamps.set("dev", Date.now() - 120_000);
    (engine as any)._targetSyncTimestamps.set("plan/alpha", 0);

    await pushRemoteCommit(
      remoteDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\nremote\n",
      "remote alpha advance",
    );

    const beforeDevTimestamp = engine.getTargetSyncStatus().targetSyncTimestamps.dev;
    expect((engine as any)._isTargetSyncStale("dev")).toBe(true);
    expect((engine as any)._isTargetSyncStale("plan/alpha")).toBe(true);

    await (engine as any)._syncTarget("plan/alpha");

    const syncStatus = engine.getTargetSyncStatus();
    expect(syncStatus.targetSyncTimestamps["plan/alpha"]).toBeGreaterThan(0);
    expect(syncStatus.targetSyncTimestamps.dev).toBe(beforeDevTimestamp);
    expect((engine as any)._isTargetSyncStale("dev")).toBe(true);
    expect((engine as any)._isTargetSyncStale("plan/alpha")).toBe(false);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-push-target-periodic
  it("pushes non-base active integration targets during periodic reconciliation", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    await createTrackedBranch(
      projectDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\n",
      "create plan alpha",
    );
    await saveWorkspaceRecord(projectDir, {
      taskRef: "@01TASK00000000000000000012",
      taskSlug: "task-plan-alpha-push",
      targetBranch: "plan/alpha",
    });

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    git(projectDir, "checkout plan/alpha");
    await fs.writeFile(path.join(projectDir, "plan-alpha.txt"), "alpha\nlocal\n", "utf-8");
    git(projectDir, "add plan-alpha.txt");
    git(projectDir, 'commit -m "local alpha merge result"');
    const localTip = git(projectDir, "rev-parse plan/alpha");
    git(projectDir, "checkout dev");

    await (engine as any)._reconcile();
    git(projectDir, "fetch origin plan/alpha");

    expect(git(projectDir, "rev-parse origin/plan/alpha")).toBe(localTip);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-pull-target-periodic-deferred
  it("defers periodic sync only for the reviewer target while syncing other stale targets", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    await createTrackedBranch(
      projectDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\n",
      "create plan alpha",
    );
    await saveWorkspaceRecord(projectDir, {
      taskRef: "@TASK123",
      taskSlug: "task-review-alpha",
      targetBranch: "plan/alpha",
    });
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

    expect(await (engine as any)._activeReviewerTargets()).toEqual(new Set(["plan/alpha"]));

    await pushRemoteCommit(remoteDir, "dev", "deferred-dev.txt", "deferred\n", "deferred dev");
    const deferredPlanTip = await pushRemoteCommit(
      remoteDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\ndeferred\n",
      "deferred alpha",
    );

    const tipBefore = git(projectDir, "rev-parse dev");
    const alphaBefore = git(projectDir, "rev-parse plan/alpha");

    // Make both targets stale so the only differentiator is reviewer activity.
    (engine as any)._targetSyncTimestamps.set("dev", Date.now() - 120_000);
    (engine as any)._targetSyncTimestamps.set("plan/alpha", Date.now() - 120_000);

    await (engine as any)._reconcile();

    const tipAfter = git(projectDir, "rev-parse dev");
    const alphaAfter = git(projectDir, "rev-parse plan/alpha");
    expect(tipAfter).not.toBe(tipBefore);
    expect(alphaAfter).toBe(alphaBefore);

    invocationDetails.delete("test-reviewer-session");
    expect(await (engine as any)._activeReviewerTargets()).toEqual(new Set());

    await (engine as any)._reconcile();

    const alphaAfterSecondReconcile = git(projectDir, "rev-parse plan/alpha");
    expect(alphaAfterSecondReconcile).toBe(deferredPlanTip);

    await engine.stop();
  });

  // AC: @dispatch-canonical-task-identity ac-cross-agent-exclusivity-uses-canonical-task
  it("matches the active reviewer target by canonical task id when the registry record keeps a stale display ref", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    await createTrackedBranch(
      projectDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\n",
      "create plan alpha",
    );

    // The persisted workspace record carries the canonical task_id but a STALE
    // display ref (@old-slug) — e.g. the task's primary slug changed after the
    // record was written.
    const canonicalTaskUlid = testUlid("RVTASK", 1);
    await saveWorkspaceRecord(projectDir, {
      taskId: canonicalTaskUlid,
      taskRef: "@old-slug",
      taskSlug: "old-slug",
      targetBranch: "plan/alpha",
    });
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // The reviewer was started under a DIFFERENT display alias (@new-slug) but
    // carries the same canonical taskId. Identity must match by canonical id, not
    // the display ref, so the reviewer's integration target is still collected.
    const invocationDetails = (engine as any).activeInvocationDetails as Map<string, any>;
    invocationDetails.set("reviewer-canonical-session", {
      invocationId: "rev-inv",
      sessionId: "rev-session",
      agentId: "pr-reviewer",
      agentName: "PR Reviewer",
      taskId: canonicalTaskUlid,
      taskRef: "@new-slug",
      role: "reviewer",
      startedAtMs: Date.now(),
    });

    expect(await (engine as any)._activeReviewerTargets()).toEqual(new Set(["plan/alpha"]));

    // And the periodic sync defers that reviewer target: a remote advance on
    // plan/alpha is not pulled while the canonical-matched reviewer is active.
    const alphaBefore = git(projectDir, "rev-parse plan/alpha");
    await pushRemoteCommit(
      remoteDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\nadvanced\n",
      "advance alpha",
    );
    (engine as any)._targetSyncTimestamps.set("plan/alpha", Date.now() - 120_000);
    await (engine as any)._reconcile();
    expect(git(projectDir, "rev-parse plan/alpha")).toBe(alphaBefore);

    invocationDetails.delete("reviewer-canonical-session");
    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-pull-target-before-provision
  it("evaluates pre-provision sync staleness per target branch", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    await createTrackedBranch(
      projectDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\n",
      "create plan alpha",
    );
    git(projectDir, "checkout dev");

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    (engine as any)._targetSyncTimestamps.set("dev", 0);
    (engine as any)._targetSyncTimestamps.set("plan/alpha", Date.now());

    expect((engine as any)._isTargetSyncStale("dev")).toBe(true);
    expect((engine as any)._isTargetSyncStale("plan/alpha")).toBe(false);

    (engine as any)._targetSyncTimestamps.set("dev", Date.now());
    (engine as any)._targetSyncTimestamps.set("plan/alpha", Date.now() - 120_000);
    expect((engine as any)._isTargetSyncStale("dev")).toBe(false);
    expect((engine as any)._isTargetSyncStale("plan/alpha")).toBe(true);

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-partial-sync-continues
  it("continues syncing remaining targets when one target sync throws during iteration", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    await createTrackedBranch(
      projectDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\n",
      "create plan alpha",
    );
    await saveWorkspaceRecord(projectDir, {
      taskRef: "@01TASK00000000000000000018",
      taskSlug: "task-plan-alpha-partial",
      targetBranch: "plan/alpha",
    });

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    await pushRemoteCommit(remoteDir, "dev", "partial-dev.txt", "partial\n", "partial dev");
    (engine as any)._targetSyncTimestamps.set("dev", Date.now() - 120_000);
    (engine as any)._targetSyncTimestamps.set("plan/alpha", Date.now() - 120_000);

    const originalSyncTarget = (engine as any)._syncTarget.bind(engine);
    const syncSpy = vi
      .spyOn(engine as any, "_syncTarget")
      .mockImplementation(async (branch: string) => {
        if (branch === "plan/alpha") {
          throw new Error("simulated target failure");
        }
        return await originalSyncTarget(branch);
      });

    const warnSpy = vi.spyOn(console, "warn");
    const devBefore = git(projectDir, "rev-parse dev");

    await (engine as any)._syncAllActiveTargets({ staleOnly: true });

    const devAfter = git(projectDir, "rev-parse dev");
    expect(syncSpy).toHaveBeenCalledWith("dev");
    expect(syncSpy).toHaveBeenCalledWith("plan/alpha");
    expect(devAfter).not.toBe(devBefore);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Target sync failed for plan/alpha; continuing"),
    );

    await engine.stop();
  });

  // AC: @dispatch-remote-branch-sync ac-partial-sync-scoped-degradation
  // AC: @dispatch-remote-branch-sync ac-divergence-scoped-to-target
  it("keeps degradation scoped to the failed target when a later target sync succeeds", async () => {
    ({ projectDir, remoteDir } = await setupProjectWithRemote());
    await setupProjectFiles(projectDir);
    await createTrackedBranch(
      projectDir,
      "plan/alpha",
      "plan-alpha.txt",
      "alpha\n",
      "create plan alpha",
    );
    await saveWorkspaceRecord(projectDir, {
      taskRef: "@01TASK00000000000000000019",
      taskSlug: "task-plan-alpha-degraded-scope",
      targetBranch: "plan/alpha",
    });

    const engine = new DispatchEngine({
      projectDir,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    await engine.start();

    await fs.writeFile(path.join(projectDir, "dev-local.txt"), "local divergence\n", "utf-8");
    git(projectDir, "add dev-local.txt");
    git(projectDir, 'commit -m "local divergence on dev"');
    await pushRemoteCommit(
      remoteDir,
      "dev",
      "dev-remote.txt",
      "remote divergence\n",
      "remote divergence on dev",
    );

    const planAlphaBefore = git(projectDir, "rev-parse plan/alpha");
    const planAlphaRemoteHead = await pushRemoteCommit(
      remoteDir,
      "plan/alpha",
      "plan-alpha-remote.txt",
      "plan alpha remote\n",
      "remote update on plan alpha",
    );

    (engine as any)._targetSyncTimestamps.set("dev", Date.now() - 120_000);
    (engine as any)._targetSyncTimestamps.set("plan/alpha", Date.now() - 120_000);

    await (engine as any)._syncAllActiveTargets({ staleOnly: true });

    const syncStatus = engine.getTargetSyncStatus();
    const degradedTargets = syncStatus.degradedTargets.map((target) => target.branch);
    expect(degradedTargets).toEqual(["dev"]);
    expect(syncStatus.degraded.active).toBe(true);
    expect(syncStatus.degraded.reason).toContain("dev");
    expect(git(projectDir, "rev-parse plan/alpha")).toBe(planAlphaRemoteHead);
    expect(git(projectDir, "rev-parse plan/alpha")).not.toBe(planAlphaBefore);
    expect(syncStatus.targetSyncTimestamps["plan/alpha"]).toBeGreaterThan(0);
    expect(syncStatus.targetSyncTimestamps.dev ?? 0).toBeLessThan(
      syncStatus.targetSyncTimestamps["plan/alpha"],
    );

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
    const result = await engine._syncTarget();

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
    const mutationSurfaceSpy = vi.spyOn(workspaceModule, "runGitInMutationSurface");

    await pushRemoteCommit(remoteDir, "dev", "timeout-check.txt", "timeout\n", "timeout check");

    const result = await engine._syncTarget();

    expect(result).toBe("synced");
    expect(targetGitSpy).toHaveBeenNthCalledWith(1, projectDir, "dev", ["fetch", "origin", "dev"], {
      timeout: 30_000,
    });
    // The working-tree merge now runs through runGitInMutationSurface so the
    // command can target an eligible occupied checkout when one exists. The
    // ff-only merge must still preserve its 10s timeout.
    expect(mutationSurfaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationBranch: "dev",
        mutationCwd: projectDir,
      }),
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
    (engine as any)._consecutiveSyncFailures.set("dev", 3);

    // Push a new commit and sync successfully
    const cloneDir = await createTempDir("kspec-target-sync-clone-");
    try {
      git(cloneDir, `clone "${remoteDir}" .`);
      git(cloneDir, 'config user.email "test@example.com"');
      git(cloneDir, 'config user.name "Test User"');
      git(cloneDir, "checkout dev");
      await fs.writeFile(path.join(cloneDir, "reset.txt"), "reset\n", "utf-8");
      git(cloneDir, "add reset.txt");
      git(cloneDir, 'commit -m "reset counter"');
      git(cloneDir, "push origin dev");
    } finally {
      await cleanupTempDir(cloneDir);
    }

    const result = await engine._syncTarget();
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
    await fs.writeFile(path.join(projectDir, "project.tasks.yaml"), "tasks: []\n", "utf-8");

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
    const syncWarnings = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes("Target sync"),
    );
    expect(syncWarnings).toHaveLength(0);

    // No sync log messages
    const syncLogs = logSpy.mock.calls.filter((call) =>
      String(call[0]).includes("Target sync enabled"),
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
    await fs.writeFile(path.join(projectDir, "project.tasks.yaml"), "tasks: []\n", "utf-8");

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

    const result = await engine._syncTarget();
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
    const result = await engine._syncTarget();
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
    (engine as any)._targetSyncRunning.add("dev");
    const result = await engine._syncTarget();
    expect(result).toBe("skipped");

    // Clear the guard
    (engine as any)._targetSyncRunning.delete("dev");

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
    const result = await engine._syncTarget();
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
