import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import * as dispatchWorkspaceRegistryModule from "../src/parser/dispatch-workspaces.js";
import { DispatchEngine } from "../src/agent-runtime/dispatch.js";
import { initContext } from "../src/parser/index.js";
import {
  findDispatchWorkspaceByTaskRef,
  getDispatchWorkspaceRegistryPath,
  loadDispatchWorkspaceRegistry,
  saveDispatchWorkspaceRecord,
} from "../src/parser/dispatch-workspaces.js";
import {
  cleanupReviewerDispatchWorkspace,
  markDispatchWorkspaceActive,
  provisionDispatchWorkspace,
  reconcileDispatchWorkspaceRegistry,
  type DispatchWorkspaceMetadata,
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

async function setupShadowSpecDir(dir: string): Promise<string> {
  const specDir = path.join(dir, ".kspec");
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(
    path.join(specDir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: "Dispatch Registry Test"\n',
    "utf-8",
  );
  return specDir;
}

async function readWorkspaceRecord(
  registryPath: string,
  taskRef: string,
): Promise<Record<string, any>> {
  const raw = YAML.parse(await fs.readFile(registryPath, "utf-8")) as {
    workspaces?: Array<Record<string, any>>;
  };
  return raw.workspaces?.find((workspace) => workspace.task_ref === taskRef) ?? {};
}

async function waitForWorkspaceRecord(
  registryPath: string,
  taskRef: string,
  predicate: (record: Record<string, any>) => boolean,
  timeoutMs: number = 2000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let record = await readWorkspaceRecord(registryPath, taskRef);

  while (!predicate(record) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    record = await readWorkspaceRecord(registryPath, taskRef);
  }

  return record;
}

async function waitForLoadedWorkspaceRecord(
  projectDir: string,
  taskRef: string,
  predicate: (record: Awaited<ReturnType<typeof findDispatchWorkspaceByTaskRef>>) => boolean,
  timeoutMs: number = 2000,
): Promise<NonNullable<Awaited<ReturnType<typeof findDispatchWorkspaceByTaskRef>>>> {
  const deadline = Date.now() + timeoutMs;
  let record = await findDispatchWorkspaceByTaskRef(
    await initContext(projectDir),
    taskRef,
  );

  while ((!record || !predicate(record)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    record = await findDispatchWorkspaceByTaskRef(
      await initContext(projectDir),
      taskRef,
    );
  }

  if (!record) {
    throw new Error(`Workspace record for ${taskRef} was not available before timeout.`);
  }

  return record;
}

async function setupProjectWithWorkerAgent(dir: string): Promise<void> {
  const specTarget = process.env.KSPEC_SPEC_DIR
    ? path.resolve(process.env.KSPEC_SPEC_DIR)
    : dir;
  await fs.writeFile(
    path.join(specTarget, "kynetic.yaml"),
    'kynetic: "1"\ntitle: Test Project\n',
    "utf-8",
  );
  await fs.writeFile(
    path.join(specTarget, "kynetic.meta.yaml"),
    [
      'kynetic_meta: "1.0"',
      "agents:",
      "  - _ulid: 01AGNT00000000000000000000",
      "    id: task-worker",
      '    name: "Task Worker"',
      "    dispatch:",
      "      - on: task.ready",
      "      - on: task.pending_review",
      "    concurrency:",
      "      max_concurrent: 1",
      "    adapter: mock-acp",
      "    auto_approve: false",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(path.join(specTarget, "project.tasks.yaml"), "tasks: []\n", "utf-8");
}

// AC: @trait-error-guidance ac-1 — N/A: dispatch workspace registry is internal runtime state, not a user-facing CLI command
// AC: @trait-error-guidance ac-2 — N/A: dispatch workspace registry is internal runtime state, not a user-facing CLI command
// AC: @trait-error-guidance ac-3 — N/A: dispatch workspace registry is internal runtime state, not a user-facing ref lookup surface
// AC: @trait-error-guidance ac-4 — N/A: lifecycle states are persisted internally, not surfaced as CLI transition errors here
// AC: @trait-error-guidance ac-5 — N/A: schema validation is exercised through parser/runtime tests, not CLI error rendering
// AC: @trait-error-guidance ac-6 — N/A: registry persistence does not expose a JSON CLI mode

describe("dispatch workspace registry", () => {
  let tempDir: string;
  let specDir: string;
  let originalSpecDir: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-workspace-registry-");
    specDir = await setupShadowSpecDir(tempDir);
    originalSpecDir = process.env.KSPEC_SPEC_DIR;
    process.env.KSPEC_SPEC_DIR = specDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalSpecDir === undefined) {
      delete process.env.KSPEC_SPEC_DIR;
    } else {
      process.env.KSPEC_SPEC_DIR = originalSpecDir;
    }
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-workspace-registry ac-1
  // AC: @dispatch-workspace-registry ac-3
  it("persists canonical workspace records in the shadow registry with required fields", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 21)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Persistent Dispatch Workspace Registry",
        slugs: ["task-persistent-dispatch-workspace-registry"],
      },
    });

    expect(workspace.metadataPath).toBe(path.join(specDir, "project.dispatch-workspaces.yaml"));
    const record = await readWorkspaceRecord(workspace.metadataPath, taskRef);

    expect(record).toMatchObject({
      workspace_id: workspace.metadata.workspaceId,
      task_ref: taskRef,
      resolved_base_branch: "agent-dev",
      base_branch_point: workspace.metadata.baseBranchPoint,
      canonical_branch: workspace.metadata.canonicalBranch,
      canonical_branch_head: workspace.metadata.canonicalBranchHead,
      lifecycle_state: "ready",
      worktree_root: workspace.metadata.worktreeRoot,
      worktrees: {
        worker: {
          path: workspace.metadata.workerWorktreeDir,
          branch_mode: "branch",
          branch_ref: workspace.metadata.canonicalBranch,
        },
      },
      bootstrap: {
        status: "not_run",
      },
      integration: {
        status: "pending",
        target_branch: "agent-dev",
      },
      health: {
        status: "healthy",
      },
      cleanup: {
        eligible: false,
      },
    });
    expect(record.timestamps.created_at).toBeTruthy();
    expect(record.timestamps.updated_at).toBeTruthy();
    expect(record.timestamps.last_reconciled_at).toBeTruthy();
  });

  // AC: @dispatch-workspace-registry ac-6
  it("persists a provisioning lifecycle record before the final ready snapshot", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const saveSpy = vi.spyOn(dispatchWorkspaceRegistryModule, "saveDispatchWorkspaceRecord");
    const taskRef = `@${testUlid("TASK", 26)}`;

    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Provisioning Lifecycle Capture",
        slugs: ["task-provisioning-lifecycle-capture"],
      },
    });

    expect(saveSpy).toHaveBeenCalled();
    expect(saveSpy.mock.calls[0]?.[1]).toMatchObject({
      task_ref: taskRef,
      lifecycle_state: "provisioning",
      bootstrap: {
        status: "not_run",
      },
    });
    expect(saveSpy.mock.calls.at(-1)?.[1]).toMatchObject({
      task_ref: taskRef,
      lifecycle_state: "ready",
    });
  });

  // AC: @dispatch-workspace-registry ac-2
  it("rejects multiple open workspace records for the same task", async () => {
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);
    const now = new Date().toISOString();
    const taskRef = `@${testUlid("TASK", 22)}`;

    const makeRecord = (workspaceId: string, lifecycleState: DispatchWorkspaceMetadata["lifecycleState"]) => ({
      workspace_id: workspaceId,
      task_ref: taskRef,
      task_slug: "task-duplicate-dispatch-registry",
      worktree_root: path.join(tempDir, ".kspec-worktrees"),
      resolved_base_branch: "main",
      base_branch_point: "abc123",
      canonical_branch: `dispatch/task/task-duplicate-dispatch-registry/${workspaceId.slice(-8).toLowerCase()}`,
      canonical_branch_head: "abc123",
      lifecycle_state: lifecycleState,
      active_role: null,
      worktrees: {
        worker: {
          path: path.join(tempDir, ".kspec-worktrees", workspaceId),
          branch_mode: "branch" as const,
          branch_ref: "dispatch/task/task-duplicate/01task00",
          head: "abc123",
          last_seen_at: now,
        },
        reviewer: null,
      },
      bootstrap: {
        status: "not_run" as const,
        detail: null,
        updated_at: now,
      },
      integration: {
        status: "pending" as const,
        target_branch: "main",
        detail: null,
        updated_at: now,
      },
      health: {
        status: "healthy" as const,
        summary: "healthy",
        issues: [],
        updated_at: now,
      },
      cleanup: {
        status: "not_scheduled" as const,
        eligible: false,
        reason: null,
        detail: null,
        updated_at: now,
      },
      timestamps: {
        created_at: now,
        updated_at: now,
        last_reconciled_at: now,
        last_active_at: null,
        closed_at: null,
      },
      _sourceFile: registryPath,
    });

    await saveDispatchWorkspaceRecord(ctx, makeRecord("dispatch-workspace-one", "ready"));
    await expect(
      saveDispatchWorkspaceRecord(ctx, makeRecord("dispatch-workspace-two", "active")),
    ).rejects.toThrow(/multiple active dispatch workspace records/i);
  });

  it("hydrates legacy integration metadata when older registry records are reloaded", async () => {
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);
    const now = new Date().toISOString();
    const taskRef = `@${testUlid("TASK", 28)}`;

    await fs.writeFile(
      registryPath,
      YAML.stringify({
        kynetic_dispatch_workspaces: "1.0",
        workspaces: [
          {
            workspace_id: "dispatch-workspace-legacy",
            task_ref: taskRef,
            task_slug: "task-legacy-dispatch-registry",
            worktree_root: path.join(tempDir, ".kspec-worktrees"),
            resolved_base_branch: "main",
            base_branch_point: "abc123",
            canonical_branch: "dispatch/task/task-legacy-dispatch-registry/legacy",
            canonical_branch_head: "def456",
            lifecycle_state: "ready",
            active_role: null,
            worktrees: {
              worker: {
                path: path.join(tempDir, ".kspec-worktrees", "dispatch-workspace-legacy"),
                branch_mode: "branch",
                branch_ref: "dispatch/task/task-legacy-dispatch-registry/legacy",
                head: "def456",
                last_seen_at: now,
              },
              reviewer: null,
            },
            bootstrap: {
              status: "not_run",
              detail: null,
              updated_at: now,
            },
            integration: {
              status: "pending",
              target_branch: "main",
              detail: null,
              updated_at: now,
            },
            health: {
              status: "healthy",
              summary: "healthy",
              issues: [],
              updated_at: now,
            },
            cleanup: {
              status: "not_scheduled",
              eligible: false,
              reason: null,
              detail: null,
              updated_at: now,
            },
            timestamps: {
              created_at: now,
              updated_at: now,
              last_reconciled_at: now,
              last_active_at: null,
              closed_at: null,
            },
          },
        ],
      }),
      "utf-8",
    );

    const [record] = await loadDispatchWorkspaceRegistry(ctx);
    expect(record?.integration).toMatchObject({
      status: "pending",
      target_branch: "main",
      target_commit: "abc123",
      publication_mode: "manual_merge",
      outcome: "manual_merge",
    });
  });

  // AC: @dispatch-workspace-registry ac-4
  // AC: @dispatch-workspace-registry ac-5
  it("reloads registry state on startup and marks missing worktrees stale with recovery data", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 23)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Restart Registry Reconciliation",
        slugs: ["task-restart-registry-reconciliation"],
      },
    });

    await fs.rm(workspace.metadata.workerWorktreeDir, { recursive: true, force: true });

    const engine = new DispatchEngine({
      projectDir: tempDir,
      specDir: specDir,
      kspecCliPath: MOCK_KSPEC_CLI,
    });
    await engine.start();

    const record = await readWorkspaceRecord(workspace.metadataPath, taskRef);
    expect(record.lifecycle_state).toBe("stale");
    expect(record.health.status).toBe("stale");
    expect(record.health.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_worker_worktree",
          suggestion: expect.stringMatching(/re-provision/i),
        }),
      ]),
    );

    await engine.stop();
  });

  // AC: @dispatch-workspace-registry ac-6
  it("preserves a live active workspace role during periodic reconciliation", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 27)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Preserve Active Role",
        slugs: ["task-preserve-active-role"],
      },
    });

    await markDispatchWorkspaceActive({
      projectDir: tempDir,
      taskRef,
      role: "worker",
    });
    await reconcileDispatchWorkspaceRegistry(
      tempDir,
      new Map([[taskRef, "in_progress" as const]]),
      new Map([[taskRef, "worker" as const]]),
    );

    const record = await readWorkspaceRecord(workspace.metadataPath, taskRef);
    expect(record.lifecycle_state).toBe("active");
    expect(record.active_role).toBe("worker");
  });

  // AC: @dispatch-workspace-registry ac-6
  // AC: @dispatch-workspace-registry ac-7
  it("persists lifecycle transitions across explicit dispatch workspace lifecycle states", async () => {
    await seedRepo(tempDir);
    await setupProjectWithWorkerAgent(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskId = testUlid("TASK", 24);
    const taskRef = `@${taskId}`;
    let releaseInvocation!: () => void;
    const invocationGate = new Promise<void>((resolve) => {
      releaseInvocation = resolve;
    });
    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockImplementation(async () => {
      await invocationGate;
      return { session: {} as never, outcome: "success", durationMs: 1 };
    });

    const engine = new DispatchEngine({
      projectDir: tempDir,
      specDir: specDir,
      kspecCliPath: MOCK_KSPEC_CLI,
    });
    await engine.start();

    await engine.handleStateChange({
      taskId,
      taskRef,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: {
        _ulid: taskId,
        title: "Lifecycle Persistence",
        slugs: ["task-lifecycle-persistence"],
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

    for (let i = 0; i < 40 && runSpy.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runSpy).toHaveBeenCalledTimes(1);

    const registryPath = getDispatchWorkspaceRegistryPath(await initContext(tempDir));
    for (let i = 0; i < 40; i++) {
      try {
        await fs.access(registryPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    let record = await readWorkspaceRecord(
      registryPath,
      taskRef,
    );
    expect(record.lifecycle_state).toBe("active");
    expect(record.active_role).toBe("worker");
    expect(record.timestamps.last_active_at).toBeTruthy();

    releaseInvocation();
    for (let i = 0; i < 40 && engine.getStatus().activeInvocations > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await engine.handleStateChange({
      taskId,
      taskRef,
      fromStatus: "in_progress",
      toStatus: "pending_review",
      timestamp: Date.now(),
      task: {
        _ulid: taskId,
        title: "Lifecycle Persistence",
        slugs: ["task-lifecycle-persistence"],
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

    record = await waitForWorkspaceRecord(
      registryPath,
      taskRef,
      (current) => current.lifecycle_state === "integrating",
    );
    expect(record.lifecycle_state).toBe("integrating");
    expect(record.integration.status).toBe("pending");

    await engine.handleStateChange({
      taskId,
      taskRef,
      fromStatus: "pending_review",
      toStatus: "completed",
      timestamp: Date.now(),
      task: {
        _ulid: taskId,
        title: "Lifecycle Persistence",
        slugs: ["task-lifecycle-persistence"],
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

    record = await waitForWorkspaceRecord(
      registryPath,
      taskRef,
      (current) => current.lifecycle_state === "closing",
    );
    expect(record.lifecycle_state).toBe("closing");
    expect(record.integration.status).toBe("merged");
    expect(record.cleanup).toMatchObject({
      eligible: true,
      reason: "integrated-into-base-branch",
      status: "scheduled",
    });

    const reloaded = await waitForLoadedWorkspaceRecord(
      tempDir,
      taskRef,
      (current) => current.lifecycle_state === "closing",
    );
    expect(reloaded?.lifecycle_state).toBe("closing");

    await engine.stop();

    await reconcileDispatchWorkspaceRegistry(
      tempDir,
      new Map([[taskRef, "in_progress" as const]]),
    );
    record = await readWorkspaceRecord(registryPath, taskRef);
    expect(record.lifecycle_state).toBe("ready");
    expect(record.integration.status).toBe("reset");
    expect(record.cleanup).toMatchObject({
      eligible: true,
      reason: "task-reset",
      status: "scheduled",
    });

    await fs.rm(record.worktrees.worker.path, { recursive: true, force: true });
    await reconcileDispatchWorkspaceRegistry(
      tempDir,
      new Map([[taskRef, "in_progress" as const]]),
    );
    record = await readWorkspaceRecord(registryPath, taskRef);
    expect(record.lifecycle_state).toBe("stale");
    expect(record.health.status).toBe("stale");

    git(tempDir, "worktree prune");
    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Lifecycle Persistence",
        slugs: ["task-lifecycle-persistence"],
      },
    });
    record = await readWorkspaceRecord(registryPath, taskRef);
    expect(record.health.status).toBe("healthy");

    record.cleanup.status = "blocked";
    record.cleanup.eligible = false;
    record.cleanup.reason = "cleanup-safety-check";
    record.cleanup.detail = "cleanup-safety-check";
    await saveDispatchWorkspaceRecord(await initContext(tempDir), {
      ...record,
      _sourceFile: registryPath,
    });
    await reconcileDispatchWorkspaceRegistry(
      tempDir,
      new Map([[taskRef, "completed" as const]]),
    );
    record = await readWorkspaceRecord(registryPath, taskRef);
    expect(record.lifecycle_state).toBe("cleanup_blocked");

    record.cleanup.status = "completed";
    record.cleanup.eligible = true;
    record.cleanup.reason = "integrated-into-base-branch";
    record.cleanup.detail = "integrated-into-base-branch";
    await saveDispatchWorkspaceRecord(await initContext(tempDir), {
      ...record,
      _sourceFile: registryPath,
    });
    await reconcileDispatchWorkspaceRegistry(
      tempDir,
      new Map([[taskRef, "completed" as const]]),
    );
    record = await readWorkspaceRecord(registryPath, taskRef);
    expect(record.lifecycle_state).toBe("closed");
    expect(record.timestamps.closed_at).toBeTruthy();
  });

  it("keeps closing lifecycle when reviewer cleanup sees stale worker metadata", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");

    const taskRef = `@${testUlid("TASK", 27)}`;
    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: {
        title: "Reviewer Cleanup Lifecycle Race",
        slugs: ["task-reviewer-cleanup-lifecycle-race"],
      },
    });

    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);
    const existingRecord = await findDispatchWorkspaceByTaskRef(ctx, taskRef, { includeClosed: true });
    expect(existingRecord?.worktrees.reviewer?.path).toBeTruthy();

    const now = new Date().toISOString();
    await saveDispatchWorkspaceRecord(ctx, {
      ...existingRecord!,
      lifecycle_state: "closing",
      integration: {
        ...existingRecord!.integration,
        status: "merged",
        outcome: "merged",
        detail: "integration:merged",
        updated_at: now,
      },
      cleanup: {
        ...existingRecord!.cleanup,
        status: "scheduled",
        eligible: true,
        reason: "integrated-into-base-branch",
        detail: "integrated-into-base-branch",
        updated_at: now,
      },
      timestamps: {
        ...existingRecord!.timestamps,
        updated_at: now,
        last_reconciled_at: now,
      },
      _sourceFile: registryPath,
    });

    await cleanupReviewerDispatchWorkspace(tempDir, taskRef, {
      title: "Reviewer Cleanup Lifecycle Race",
      slugs: ["task-reviewer-cleanup-lifecycle-race"],
    });

    const record = await readWorkspaceRecord(registryPath, taskRef);
    expect(record.lifecycle_state).toBe("closing");
    expect(record.cleanup.eligible).toBe(true);
    expect(record.integration.status).toBe("merged");
    expect(record.worktrees.reviewer).toBeNull();
  });

  it("rejects malformed registry content instead of resetting the registry from an empty baseline", async () => {
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);

    await fs.writeFile(
      registryPath,
      [
        'kynetic_dispatch_workspaces: "1.0"',
        "workspaces:",
        "  - workspace_id: broken-registry",
        "    task_ref: not-a-ref",
      ].join("\n"),
      "utf-8",
    );

    await expect(loadDispatchWorkspaceRegistry(ctx)).rejects.toThrow(
      /task_ref/i,
    );
    await expect(
      saveDispatchWorkspaceRecord(ctx, {
        workspace_id: "dispatch-workspace-one",
        task_ref: `@${testUlid("TASK", 25)}`,
        task_slug: "task-malformed-registry",
        worktree_root: path.join(tempDir, ".kspec-worktrees"),
        resolved_base_branch: "main",
        base_branch_point: "abc123",
        canonical_branch: "dispatch/task/task-malformed-registry/registry",
        canonical_branch_head: "abc123",
        lifecycle_state: "ready",
        active_role: null,
        worktrees: {
          worker: {
            path: path.join(tempDir, ".kspec-worktrees", "dispatch-workspace-one"),
            branch_mode: "branch",
            branch_ref: "dispatch/task/task-malformed-registry/registry",
            head: "abc123",
            last_seen_at: new Date().toISOString(),
          },
          reviewer: null,
        },
        bootstrap: {
          status: "not_run",
          detail: null,
          updated_at: new Date().toISOString(),
        },
        integration: {
          status: "pending",
          target_branch: "main",
          detail: null,
          updated_at: new Date().toISOString(),
        },
        health: {
          status: "healthy",
          summary: "healthy",
          issues: [],
          updated_at: new Date().toISOString(),
        },
        cleanup: {
          status: "not_scheduled",
          eligible: false,
          reason: null,
          detail: null,
          updated_at: new Date().toISOString(),
        },
        timestamps: {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_reconciled_at: new Date().toISOString(),
          last_active_at: null,
          closed_at: null,
        },
        _sourceFile: registryPath,
      }),
    ).rejects.toThrow(/task_ref/i);

    const raw = await fs.readFile(registryPath, "utf-8");
    expect(raw).toContain("task_ref: not-a-ref");
  });
});
