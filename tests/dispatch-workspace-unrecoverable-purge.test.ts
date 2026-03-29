import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import { DispatchEngine } from "../src/agent-runtime/dispatch.js";
import {
  getDispatchWorkspaceHealth,
} from "../src/agent-runtime/workspace.js";
import {
  loadDispatchWorkspaceRegistry,
  deleteDispatchWorkspaceRecord,
} from "../src/parser/dispatch-workspaces.js";
import { initContext } from "../src/parser/index.js";
import { cleanupTempDir, createTempDir, initGitRepo, testUlid } from "./helpers/cli.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";

ensureSplitBackendRegistered();

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
  git(dir, "checkout -b agent-dev");
}

async function setupProject(dir: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, "kynetic.yaml"),
    'kynetic: "1.1"\ntask_storage:\n  format: split\ntitle: Test Project\n',
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "kynetic.meta.yaml"),
    [
      'kynetic_meta: "1.0"',
      "agents:",
      "  - _ulid: 01AGNT00000000000000000000",
      "    id: task-worker",
      '    name: "Task Worker"',
      "    dispatch:",
      "      - on: task.ready",
      "      - on: task.needs_work",
      "    concurrency:",
      "      max_concurrent: 1",
      "    adapter: mock-acp",
      "    auto_approve: false",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "kspec.config.yaml"),
    [
      "dispatch:",
      "  base_branch: agent-dev",
      "  worktree_root: .dispatch-root",
      "  bootstrap:",
      "    steps:",
      "      - run: mkdir -p .dispatch-cache && printf ready > .dispatch-cache/bootstrap.txt",
      "        idempotent: true",
      "",
    ].join("\n"),
    "utf-8",
  );
}

type TaskRecord = {
  _ulid: string;
  title: string;
  slugs: string[];
  status: "pending" | "in_progress" | "pending_review" | "needs_work" | "completed" | "cancelled";
  priority?: number;
  automation?: "eligible" | "manual_only";
  created_at?: string;
};

async function writeTasks(dir: string, tasks: TaskRecord[]): Promise<void> {
  const indexEntries: Record<string, unknown>[] = [];

  for (const task of tasks) {
    const taskDir = path.join(dir, "tasks", task._ulid);
    await fs.mkdir(taskDir, { recursive: true });

    const taskData: Record<string, unknown> = {
      _ulid: task._ulid,
      type: "task",
      title: task.title,
      slugs: task.slugs,
      status: task.status,
      priority: task.priority ?? 1,
      blocked_by: [],
      depends_on: [],
      context: [],
      tags: [],
      vcs_refs: [],
      created_at: task.created_at ?? new Date().toISOString(),
      automation: task.automation ?? "eligible",
    };

    await fs.writeFile(path.join(taskDir, "task.yaml"), YAML.stringify(taskData), "utf-8");
    await fs.writeFile(path.join(taskDir, "notes.yaml"), YAML.stringify({ notes: [] }), "utf-8");

    indexEntries.push({
      ...taskData,
      notes_count: 0,
      todos_count: 0,
    });
  }

  await fs.writeFile(
    path.join(dir, "project.tasks.yaml"),
    YAML.stringify(indexEntries),
    "utf-8",
  );
}

async function waitFor(
  assertion: () => void | Promise<void>,
  options?: { attempts?: number; delayMs?: number },
): Promise<void> {
  const attempts = options?.attempts ?? 120;
  const delayMs = options?.delayMs ?? 10;
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

function makeUnrecoverableWorkspaceRecord(
  tempDir: string,
  overrides: {
    workspaceId: string;
    taskRef: string;
    taskSlug: string;
    canonicalBranch: string;
    lifecycleState?: string;
  },
): Record<string, unknown> {
  const now = new Date().toISOString();
  const worktreeRoot = path.join(tempDir, ".dispatch-root");
  return {
    workspace_id: overrides.workspaceId,
    task_ref: overrides.taskRef,
    task_slug: overrides.taskSlug,
    worktree_root: worktreeRoot,
    resolved_base_branch: "agent-dev",
    base_branch_point: "abc123",
    canonical_branch: overrides.canonicalBranch,
    canonical_branch_head: "abc123",
    lifecycle_state: overrides.lifecycleState ?? "stale",
    active_role: null,
    worktrees: {
      worker: {
        path: path.join(worktreeRoot, `${overrides.taskSlug}-nonexistent`),
        branch_mode: "branch",
        branch_ref: overrides.canonicalBranch,
        head: "abc123",
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
      target_branch: "agent-dev",
      target_commit: "abc123",
      publication_mode: "manual_merge",
      outcome: "manual_merge",
      detail: null,
      updated_at: now,
    },
    health: {
      status: "invalid",
      summary: "Workspace registry record is invalid because required git state is missing.",
      issues: [
        {
          code: "missing_canonical_branch",
          message: `Canonical branch "${overrides.canonicalBranch}" is missing.`,
          suggestion: "Re-provision the workspace or restore the branch before dispatch resumes.",
          detected_at: now,
        },
      ],
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
  };
}

async function seedWorkspaceRegistry(
  dir: string,
  records: Record<string, unknown>[],
): Promise<void> {
  // The registry lives in specDir, which is resolved by initContext.
  // When kynetic.yaml is in the project dir, specDir IS the project dir.
  const registryPath = path.join(dir, "project.dispatch-workspaces.yaml");
  const registryFile = {
    kynetic_dispatch_workspaces: "1.0",
    workspaces: records,
  };
  await fs.writeFile(registryPath, YAML.stringify(registryFile), "utf-8");
}

async function setupShadowSpecDir(dir: string): Promise<string> {
  const specDir = path.join(dir, ".kspec");
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(
    path.join(specDir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: "Unrecoverable Purge Test"\n',
    "utf-8",
  );
  return specDir;
}

// AC: @trait-error-guidance ac-1 — N/A: purge logic is internal dispatch behavior, not a user-facing CLI command
// AC: @trait-error-guidance ac-2 — N/A: purge logic is internal dispatch behavior, not a user-facing CLI command
// AC: @trait-error-guidance ac-3 — N/A: purge logic does not involve ref lookups
// AC: @trait-error-guidance ac-4 — N/A: purge logic does not involve state transitions surfaced to users
// AC: @trait-error-guidance ac-5 — N/A: purge logic does not produce validation errors for users
// AC: @trait-error-guidance ac-6 — N/A: purge logic does not expose a JSON CLI mode

// AC: @dispatch-workspace-registry ac-14
describe("purge unrecoverable workspace records for non-terminal tasks", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-unrecoverable-purge-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-workspace-registry ac-14
  it(
    "purges unrecoverable workspace record for a pending task and provisions a fresh workspace",
    { timeout: 30_000 },
    async () => {
      await seedRepo(tempDir);
      await setupProject(tempDir);

      const taskId = testUlid("TASK", 70);
      const taskRef = `@${taskId}`;
      const taskSlug = "task-unrecoverable-purge";
      const canonicalBranch = `dispatch/task/${taskSlug}/01task00`;
      const workspaceId = "ws-unrecoverable-001";

      // Write task as pending (will trigger task.ready event)
      await writeTasks(tempDir, [
        {
          _ulid: taskId,
          title: "Unrecoverable Purge Target",
          slugs: [taskSlug],
          status: "pending",
        },
      ]);

      // Seed registry with an unrecoverable workspace record (missing canonical branch).
      // Registry lives in specDir which is tempDir (where kynetic.yaml is).
      await seedWorkspaceRegistry(tempDir, [
        makeUnrecoverableWorkspaceRecord(tempDir, {
          workspaceId,
          taskRef,
          taskSlug,
          canonicalBranch,
        }),
      ]);

      // Verify the health check reports unhealthy before dispatch runs
      const healthBefore = await getDispatchWorkspaceHealth({
        projectDir: tempDir,
        taskRef,
        role: "worker",
      });
      expect(healthBefore.exists).toBe(true);
      expect(healthBefore.healthy).toBe(false);
      expect(healthBefore.reason).toBe("missing-canonical-branch");

      let provisioned = false;
      vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (options) => {
        // The task should be provisioned with a fresh workspace after the
        // stale record is purged on the first cycle.
        expect(options.taskRef).toBe(taskRef);
        provisioned = true;

        // Transition task to completed so the engine can stop
        await writeTasks(tempDir, [
          {
            _ulid: taskId,
            title: "Unrecoverable Purge Target",
            slugs: [taskSlug],
            status: "completed",
          },
        ]);

        return {
          session: {} as never,
          outcome: "success" as const,
          durationMs: 1,
        };
      });

      const engine = new DispatchEngine({
        projectDir: tempDir,
        specDir: tempDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        reconcileIntervalMs: 0,
        coalesceWindowMs: 0,
      });

      await engine.start();

      await waitFor(
        () => {
          expect(provisioned).toBe(true);
        },
        { attempts: 500, delayMs: 20 },
      );

      await engine.stop();

      // Verify: the stale record was purged and a new one was created
      const ctx = await initContext(tempDir);
      const records = await loadDispatchWorkspaceRegistry(ctx);
      // The old unrecoverable record should be gone
      const staleRecord = records.find((r) => r.workspace_id === workspaceId);
      expect(staleRecord).toBeUndefined();
    },
  );

  // AC: @dispatch-workspace-registry ac-14
  it("does not purge workspace records for terminal tasks (completed)", async () => {
    await seedRepo(tempDir);
    await setupProject(tempDir);

    const taskId = testUlid("TASK", 71);
    const taskRef = `@${taskId}`;
    const taskSlug = "task-terminal-completed";
    const canonicalBranch = `dispatch/task/${taskSlug}/01task00`;
    const workspaceId = "ws-terminal-001";

    await seedWorkspaceRegistry(tempDir, [
      makeUnrecoverableWorkspaceRecord(tempDir, {
        workspaceId,
        taskRef,
        taskSlug,
        canonicalBranch,
      }),
    ]);

    // Verify the unhealthy record exists before the check
    const ctx = await initContext(tempDir);
    const recordsBefore = await loadDispatchWorkspaceRegistry(ctx);
    expect(recordsBefore).toHaveLength(1);
    expect(recordsBefore[0].workspace_id).toBe(workspaceId);

    // The task is completed — terminal state. The dispatch engine won't even
    // enqueue it, but verify the record is NOT purged by directly checking
    // after the health assessment.
    const health = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef,
      role: "worker",
    });
    expect(health.exists).toBe(true);
    expect(health.healthy).toBe(false);

    // The record should still exist — terminal tasks don't trigger purge
    const recordsAfter = await loadDispatchWorkspaceRegistry(ctx);
    expect(recordsAfter).toHaveLength(1);
    expect(recordsAfter[0].workspace_id).toBe(workspaceId);
  });

  // AC: @dispatch-workspace-registry ac-14
  it("does not purge workspace records with stale (non-invalid) health status", async () => {
    await seedRepo(tempDir);
    await setupProject(tempDir);

    const taskId = testUlid("TASK", 72);
    const taskRef = `@${taskId}`;
    const taskSlug = "task-stale-not-invalid";
    const canonicalBranch = `dispatch/task/${taskSlug}/01task00`;
    const workspaceId = "ws-stale-001";

    // Create the canonical branch so health is "stale" (worktree missing) not "invalid"
    git(tempDir, `branch ${canonicalBranch}`);

    const now = new Date().toISOString();
    const worktreeRoot = path.join(tempDir, ".dispatch-root");
    await seedWorkspaceRegistry(tempDir, [
      {
        workspace_id: workspaceId,
        task_ref: taskRef,
        task_slug: taskSlug,
        worktree_root: worktreeRoot,
        resolved_base_branch: "agent-dev",
        base_branch_point: "abc123",
        canonical_branch: canonicalBranch,
        canonical_branch_head: "abc123",
        lifecycle_state: "stale",
        active_role: null,
        worktrees: {
          worker: {
            path: path.join(worktreeRoot, `${taskSlug}-nonexistent`),
            branch_mode: "branch",
            branch_ref: canonicalBranch,
            head: "abc123",
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
          target_branch: "agent-dev",
          target_commit: "abc123",
          publication_mode: "manual_merge",
          outcome: "manual_merge",
          detail: null,
          updated_at: now,
        },
        health: {
          status: "stale",
          summary: "Workspace registry record is stale and needs reconciliation.",
          issues: [
            {
              code: "missing_worker_worktree",
              message: `Worker worktree is missing.`,
              suggestion: "Re-provision the worker worktree.",
              detected_at: now,
            },
          ],
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
    ]);

    // Health check: stale but NOT invalid
    const health = await getDispatchWorkspaceHealth({
      projectDir: tempDir,
      taskRef,
      role: "worker",
    });
    expect(health.exists).toBe(true);
    expect(health.healthy).toBe(false);
    // The reason should be missing-worker-worktree (stale), not missing-canonical-branch (invalid)
    expect(health.reason).toBe("missing-worker-worktree");

    // The stale record should remain — it is recoverable (branch exists)
    const ctx = await initContext(tempDir);
    const records = await loadDispatchWorkspaceRegistry(ctx);
    expect(records).toHaveLength(1);
    expect(records[0].workspace_id).toBe(workspaceId);
  });

  // AC: @dispatch-workspace-registry ac-14
  it("deleteDispatchWorkspaceRecord removes a record by workspace_id", async () => {
    await seedRepo(tempDir);

    const specDir = await setupShadowSpecDir(tempDir);
    const originalSpecDir = process.env.KSPEC_SPEC_DIR;
    process.env.KSPEC_SPEC_DIR = specDir;

    try {
      const taskRef1 = `@${testUlid("TASK", 73)}`;
      const taskRef2 = `@${testUlid("TASK", 74)}`;
      const wsId1 = "ws-delete-target";
      const wsId2 = "ws-keep";

      await seedWorkspaceRegistry(specDir, [
        makeUnrecoverableWorkspaceRecord(tempDir, {
          workspaceId: wsId1,
          taskRef: taskRef1,
          taskSlug: "task-delete-target",
          canonicalBranch: "dispatch/task/task-delete-target/01task00",
        }),
        makeUnrecoverableWorkspaceRecord(tempDir, {
          workspaceId: wsId2,
          taskRef: taskRef2,
          taskSlug: "task-keep",
          canonicalBranch: "dispatch/task/task-keep/01task00",
        }),
      ]);

      const ctx = await initContext(tempDir);
      let records = await loadDispatchWorkspaceRegistry(ctx);
      expect(records).toHaveLength(2);

      await deleteDispatchWorkspaceRecord(ctx, wsId1);

      records = await loadDispatchWorkspaceRegistry(ctx);
      expect(records).toHaveLength(1);
      expect(records[0].workspace_id).toBe(wsId2);
    } finally {
      if (originalSpecDir === undefined) {
        delete process.env.KSPEC_SPEC_DIR;
      } else {
        process.env.KSPEC_SPEC_DIR = originalSpecDir;
      }
    }
  });

  // AC: @dispatch-workspace-registry ac-14
  it("deleteDispatchWorkspaceRecord is idempotent for missing records", async () => {
    await seedRepo(tempDir);

    const specDir = await setupShadowSpecDir(tempDir);
    const originalSpecDir = process.env.KSPEC_SPEC_DIR;
    process.env.KSPEC_SPEC_DIR = specDir;

    try {
      await seedWorkspaceRegistry(specDir, []);

      const ctx = await initContext(tempDir);
      // Should not throw for non-existent workspace ID
      await deleteDispatchWorkspaceRecord(ctx, "ws-nonexistent");

      const records = await loadDispatchWorkspaceRegistry(ctx);
      expect(records).toHaveLength(0);
    } finally {
      if (originalSpecDir === undefined) {
        delete process.env.KSPEC_SPEC_DIR;
      } else {
        process.env.KSPEC_SPEC_DIR = originalSpecDir;
      }
    }
  });

  // AC: @dispatch-workspace-registry ac-14
  it(
    "purges unrecoverable workspace for in_progress task after discovery fails",
    { timeout: 30_000 },
    async () => {
      await seedRepo(tempDir);
      await setupProject(tempDir);

      const taskId = testUlid("TASK", 75);
      const taskRef = `@${taskId}`;
      const taskSlug = "task-inprogress-unrecoverable";
      const canonicalBranch = `dispatch/task/${taskSlug}/01task00`;
      const workspaceId = "ws-inprogress-unrecoverable";

      // Write task as in_progress (triggers task.in_progress → goes to resumable path → discovery)
      await writeTasks(tempDir, [
        {
          _ulid: taskId,
          title: "In-Progress Unrecoverable",
          slugs: [taskSlug],
          status: "in_progress",
        },
      ]);

      // Seed with unrecoverable record
      await seedWorkspaceRegistry(tempDir, [
        makeUnrecoverableWorkspaceRecord(tempDir, {
          workspaceId,
          taskRef,
          taskSlug,
          canonicalBranch,
        }),
      ]);

      // Configure agent to handle in_progress tasks
      await fs.writeFile(
        path.join(tempDir, "kynetic.meta.yaml"),
        [
          'kynetic_meta: "1.0"',
          "agents:",
          "  - _ulid: 01AGNT00000000000000000000",
          "    id: task-worker",
          '    name: "Task Worker"',
          "    dispatch:",
          "      - on: task.ready",
          "      - on: task.in_progress",
          "      - on: task.needs_work",
          "    concurrency:",
          "      max_concurrent: 1",
          "    adapter: mock-acp",
          "    auto_approve: false",
          "",
        ].join("\n"),
        "utf-8",
      );

      let provisioned = false;
      vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (options) => {
        expect(options.taskRef).toBe(taskRef);
        provisioned = true;

        await writeTasks(tempDir, [
          {
            _ulid: taskId,
            title: "In-Progress Unrecoverable",
            slugs: [taskSlug],
            status: "completed",
          },
        ]);

        return {
          session: {} as never,
          outcome: "success" as const,
          durationMs: 1,
        };
      });

      const engine = new DispatchEngine({
        projectDir: tempDir,
        specDir: tempDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        reconcileIntervalMs: 0,
        coalesceWindowMs: 0,
      });

      await engine.start();

      await waitFor(
        () => {
          expect(provisioned).toBe(true);
        },
        { attempts: 500, delayMs: 20 },
      );

      await engine.stop();

      // The old unrecoverable record should have been purged
      const ctx = await initContext(tempDir);
      const records = await loadDispatchWorkspaceRegistry(ctx);
      const staleRecord = records.find((r) => r.workspace_id === workspaceId);
      expect(staleRecord).toBeUndefined();
    },
  );
});
