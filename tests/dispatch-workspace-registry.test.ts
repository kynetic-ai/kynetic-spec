import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import { DispatchEngine } from "../src/agent-runtime/dispatch.js";
import { initContext } from "../src/parser/index.js";
import {
  findDispatchWorkspaceByTaskRef,
  getDispatchWorkspaceRegistryPath,
  saveDispatchWorkspaceRecord,
} from "../src/parser/dispatch-workspaces.js";
import {
  provisionDispatchWorkspace,
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
        status: "not_started",
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
        status: "not_started" as const,
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
  // AC: @dispatch-workspace-registry ac-7
  it("persists lifecycle transitions for active, integrating, and closing states", async () => {
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

    record = await readWorkspaceRecord(registryPath, taskRef);
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

    record = await readWorkspaceRecord(registryPath, taskRef);
    expect(record.lifecycle_state).toBe("closing");
    expect(record.integration.status).toBe("merged");
    expect(record.cleanup).toMatchObject({
      eligible: true,
      reason: "integrated-into-base-branch",
      status: "scheduled",
    });

    const reloaded = await findDispatchWorkspaceByTaskRef(
      await initContext(tempDir),
      taskRef,
    );
    expect(reloaded?.lifecycle_state).toBe("closing");

    await engine.stop();
  });
});
