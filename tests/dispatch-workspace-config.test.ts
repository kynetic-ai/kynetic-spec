import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import { buildOrientationContext, DispatchEngine } from "../src/agent-runtime/dispatch.js";
import {
  DispatchWorkspaceError,
  resolveDispatchWorkspaceConfig,
  provisionDispatchWorkspace,
} from "../src/agent-runtime/workspace.js";
import {
  getDispatchWorkspaceRegistryPath,
  loadDispatchWorkspaceRegistry,
} from "../src/parser/dispatch-workspaces.js";
import { initContext } from "../src/parser/index.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  readTestOutput,
  testUlid,
} from "./helpers/cli.js";

async function createToolPath(options: { gh: boolean }): Promise<string> {
  const binDir = await createTempDir("kspec-dispatch-tools-");
  const gitPath = execSync("PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin command -v git", {
    encoding: "utf-8",
    shell: "/bin/bash",
  }).trim();
  await fs.writeFile(path.join(binDir, "git"), `#!/bin/sh\nexec "${gitPath}" "$@"\n`, {
    encoding: "utf-8",
    mode: 0o755,
  });
  if (options.gh) {
    await fs.writeFile(
      path.join(binDir, "gh"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "gh version 99.0.0"\n  exit 0\nfi\nexit 0\n',
      { encoding: "utf-8", mode: 0o755 },
    );
  }
  return binDir;
}

const MOCK_KSPEC_CLI = path.join(__dirname, "mocks", "kspec-capture-mock.cjs");

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

async function readWorkspaceRecord(
  registryPath: string,
  taskRef: string,
): Promise<Record<string, any>> {
  const raw = YAML.parse(await readTestOutput(registryPath)) as {
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

async function setupProjectWithAgent(dir: string): Promise<void> {
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
  await fs.writeFile(path.join(dir, "project.tasks.yaml"), "tasks: []\n", "utf-8");
}

async function writePlansFile(
  dir: string,
  plans: Array<{ _ulid: string; slug: string; title: string; branch: string | null }>,
): Promise<void> {
  await fs.writeFile(
    path.join(dir, "project.plans.yaml"),
    YAML.stringify({
      kynetic_plans: "1.0",
      plans: plans.map((plan) => ({
        _ulid: plan._ulid,
        slugs: [plan.slug],
        title: plan.title,
        content: "",
        status: "active",
        derived_tasks: [],
        derived_specs: [],
        source_path: null,
        module_ref: null,
        branch: plan.branch,
        created_at: "2026-04-01T00:00:00.000Z",
        approved_at: null,
        completed_at: null,
        notes: [],
      })),
    }),
    "utf-8",
  );
}

describe("dispatch workspace configuration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-workspace-config-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-workspace-configuration ac-3
  it("resolves configured relative worktree roots from the project root", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: agent-dev\n  worktree_root: custom/worktrees\n",
      "utf-8",
    );
    git(tempDir, "checkout -b agent-dev");

    const resolved = await resolveDispatchWorkspaceConfig(tempDir);

    expect(resolved.baseBranch).toBe("agent-dev");
    expect(resolved.baseBranchSource).toBe("configured");
    expect(resolved.worktreeRoot).toBe(path.join(tempDir, "custom", "worktrees"));
  });

  // AC: @dispatch-workspace-configuration ac-2
  it("falls back to remote HEAD when dispatch.base_branch is unset", async () => {
    const remoteDir = await createTempDir("kspec-dispatch-remote-");
    try {
      git(remoteDir, "init --bare");

      await seedRepo(tempDir);
      git(tempDir, "checkout -b agent-dev");
      await fs.writeFile(path.join(tempDir, "feature.txt"), "agent\n", "utf-8");
      git(tempDir, "add feature.txt");
      git(tempDir, 'commit -m "agent branch"');
      git(tempDir, `remote add origin "${remoteDir}"`);
      git(tempDir, "push -u origin main");
      git(tempDir, "push -u origin agent-dev");
      git(remoteDir, "symbolic-ref HEAD refs/heads/agent-dev");
      git(tempDir, "fetch origin");
      git(tempDir, "remote set-head origin --auto");

      const resolved = await resolveDispatchWorkspaceConfig(tempDir);

      expect(resolved.baseBranch).toBe("agent-dev");
      expect(resolved.baseBranchSource).toBe("remote-head");
    } finally {
      await cleanupTempDir(remoteDir);
    }
  });

  // AC: @plan-branch-dispatch-target ac-plan-branch-priority
  // AC: @plan-branch-dispatch-target ac-integration-target
  it("prefers a task plan branch over dispatch.base_branch during provisioning", async () => {
    await seedRepo(tempDir);
    await setupProjectWithAgent(tempDir);
    git(tempDir, "checkout -b dev");
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n  worktree_root: .dispatch-root\n",
      "utf-8",
    );
    await writePlansFile(tempDir, [
      {
        _ulid: testUlid("PNAA", 1),
        slug: "test-plan",
        title: "Test Plan",
        branch: "dev",
      },
    ]);

    const taskRef = `@${testUlid("TASK", 2)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Plan Branch Target",
        slugs: ["task-plan-branch-target"],
        plan_ref: "@test-plan",
      },
    });

    const record = await readWorkspaceRecord(workspace.metadataPath, taskRef);
    expect(record.resolved_base_branch).toBe("dev");
    expect(record.integration?.target_branch).toBe("dev");
    expect(workspace.metadata.baseBranch).toBe("dev");
    expect(workspace.metadata.integrationTargetBranch).toBe("dev");
  });

  // AC: @plan-branch-dispatch-target ac-submission-linkage-plan-target
  it("keeps plan branch as integration target when adopting a submitted branch", async () => {
    await seedRepo(tempDir);
    await setupProjectWithAgent(tempDir);
    git(tempDir, "checkout -b feat/ui-redesign");
    const planCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "checkout -b dispatch/task/adopt-plan-branch/01abcdef");
    await fs.writeFile(path.join(tempDir, "feature.txt"), "submitted\n", "utf-8");
    git(tempDir, "add feature.txt");
    git(tempDir, 'commit -m "submitted work"');
    const submittedCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "checkout main");
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n  worktree_root: .dispatch-root\n",
      "utf-8",
    );
    await writePlansFile(tempDir, [
      {
        _ulid: testUlid("PNAA", 11),
        slug: "ui-redesign-plan",
        title: "UI Redesign Plan",
        branch: "feat/ui-redesign",
      },
    ]);

    const taskRef = `@${testUlid("TASK", 11)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Adopt Plan Branch",
        slugs: ["task-adopt-plan-branch"],
        plan_ref: "@ui-redesign-plan",
      },
      taskStatus: "pending_review",
      submissionLinkage: {
        branch: "dispatch/task/adopt-plan-branch/01abcdef",
        commit: submittedCommit,
        remote: null,
        remote_url: null,
        upstream_ref: "feat/ui-redesign",
        review_url: null,
        captured_at: "2026-04-01T00:00:00.000Z",
      },
    });

    const record = await readWorkspaceRecord(workspace.metadataPath, taskRef);
    expect(record.canonical_branch).toBe("dispatch/task/adopt-plan-branch/01abcdef");
    expect(record.base_branch_point).toBe(planCommit);
    expect(record.integration?.target_branch).toBe("feat/ui-redesign");
    expect(workspace.metadata.integrationTargetBranch).toBe("feat/ui-redesign");
  });

  // AC: @plan-branch-dispatch-target ac-submission-linkage-plan-target
  it("passes plan_ref through dispatch-engine provisioning when adopting a submitted branch", async () => {
    await seedRepo(tempDir);
    await setupProjectWithAgent(tempDir);
    git(tempDir, "checkout -b feat/ui-redesign");
    git(tempDir, "checkout -b dispatch/task/engine-plan-adopt/01abcdef");
    await fs.writeFile(path.join(tempDir, "engine-feature.txt"), "submitted\n", "utf-8");
    git(tempDir, "add engine-feature.txt");
    git(tempDir, 'commit -m "submitted engine work"');
    const submittedCommit = git(tempDir, "rev-parse HEAD");
    git(tempDir, "checkout main");
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n  worktree_root: .dispatch-root\n",
      "utf-8",
    );
    await writePlansFile(tempDir, [
      {
        _ulid: testUlid("PNAA", 12),
        slug: "engine-ui-redesign-plan",
        title: "Engine UI Redesign Plan",
        branch: "feat/ui-redesign",
      },
    ]);

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as never,
      outcome: "success",
      durationMs: 1,
    });
    const engine = new DispatchEngine({
      projectDir: tempDir,
      specDir: tempDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
      reconcileIntervalMs: 0,
    });
    (engine as unknown as { running: boolean }).running = true;

    const taskId = testUlid("TASK", 12);
    const taskRef = `@${taskId}`;
    const agent = {
      _ulid: "01AGNTREVIEW00000000000000",
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

    const spawned = await (
      engine as unknown as { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> }
    )._spawnInvocation(agent, {
      agent,
      change: {
        taskId,
        taskRef,
        fromStatus: "in_progress",
        toStatus: "pending_review",
        timestamp: Date.now(),
        task: {
          _ulid: taskId,
          title: "Engine Plan Adopt",
          slugs: ["engine-plan-adopt"],
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
          plan_ref: "@engine-ui-redesign-plan",
          submission_linkage: {
            branch: "dispatch/task/engine-plan-adopt/01abcdef",
            commit: submittedCommit,
            remote: null,
            remote_url: null,
            upstream_ref: "feat/ui-redesign",
            review_url: null,
            captured_at: "2026-04-01T00:00:00.000Z",
          },
        },
      },
      retryCount: 0,
      nextRetryAt: 0,
      enqueuedAtMs: Date.now(),
      sequence: 1,
      starvationDeferrals: 0,
    });

    expect(spawned).toBe(true);
    await vi.waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
    const invocation = runSpy.mock.calls[0][0];
    expect(invocation.env?.KSPEC_DISPATCH_BASE_BRANCH).toBe("feat/ui-redesign");
    expect(invocation.env?.KSPEC_DISPATCH_MERGE_TARGET).toBe("feat/ui-redesign");
    expect(invocation.env?.KSPEC_DISPATCH_INTEGRATION_TARGET).toBe("feat/ui-redesign");

    const workspaceFile = invocation.env?.KSPEC_DISPATCH_WORKSPACE_FILE;
    expect(workspaceFile).toBeTruthy();
    const record = await readWorkspaceRecord(workspaceFile!, taskRef);
    expect(record.integration?.target_branch).toBe("feat/ui-redesign");
    await engine.stop();
  });

  // AC: @plan-branch-dispatch-target ac-no-plan-ref-passthrough
  it("keeps existing fallback behavior when the task has no plan reference", async () => {
    await seedRepo(tempDir);
    await setupProjectWithAgent(tempDir);
    git(tempDir, "checkout -b dev");
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n",
      "utf-8",
    );

    const resolved = await resolveDispatchWorkspaceConfig(tempDir, {
      taskRef: `@${testUlid("TASK", 3)}`,
      task: { title: "No Plan Ref", slugs: ["task-no-plan-ref"] },
    });

    expect(resolved.baseBranch).toBe("main");
    expect(resolved.baseBranchSource).toBe("configured");
  });

  // AC: @plan-branch-dispatch-target ac-null-branch-passthrough
  it("falls through to standard resolution when the linked plan branch is null", async () => {
    await seedRepo(tempDir);
    await setupProjectWithAgent(tempDir);
    git(tempDir, "checkout -b dev");
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n",
      "utf-8",
    );
    await writePlansFile(tempDir, [
      {
        _ulid: testUlid("PNAA", 2),
        slug: "null-branch-plan",
        title: "Null Branch Plan",
        branch: null,
      },
    ]);

    const resolved = await resolveDispatchWorkspaceConfig(tempDir, {
      taskRef: `@${testUlid("TASK", 4)}`,
      task: {
        title: "Null Branch",
        slugs: ["task-null-branch"],
        plan_ref: "@null-branch-plan",
      },
    });

    expect(resolved.baseBranch).toBe("main");
    expect(resolved.baseBranchSource).toBe("configured");
  });

  // AC: @plan-branch-dispatch-target ac-plan-branch-not-found
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  it("fails with plan-specific guidance when a linked plan branch cannot be found", async () => {
    await seedRepo(tempDir);
    await setupProjectWithAgent(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n",
      "utf-8",
    );
    await writePlansFile(tempDir, [
      {
        _ulid: testUlid("PNAA", 3),
        slug: "missing-branch-plan",
        title: "Missing Branch Plan",
        branch: "missing-branch",
      },
    ]);

    await expect(
      resolveDispatchWorkspaceConfig(tempDir, {
        taskRef: `@${testUlid("TASK", 5)}`,
        task: {
          title: "Missing Branch",
          slugs: ["task-missing-branch"],
          plan_ref: "@missing-branch-plan",
        },
      }),
    ).rejects.toMatchObject({
      name: "DispatchWorkspaceError",
      message: expect.stringContaining("@missing-branch-plan"),
      suggestion: expect.stringContaining('Create or fetch branch "missing-branch"'),
    } satisfies Partial<DispatchWorkspaceError>);
  });

  // AC: @plan-branch-dispatch-target ac-no-plan-ref-passthrough
  it("warns and falls back to standard resolution when the linked plan cannot be found", async () => {
    await seedRepo(tempDir);
    await setupProjectWithAgent(tempDir);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n",
      "utf-8",
    );

    const resolved = await resolveDispatchWorkspaceConfig(tempDir, {
      taskRef: `@${testUlid("TASK", 6)}`,
      task: {
        title: "Missing Plan",
        slugs: ["task-missing-plan"],
        plan_ref: "@missing-plan",
      },
    });

    expect(resolved.baseBranch).toBe("main");
    expect(resolved.baseBranchSource).toBe("configured");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("references plan @missing-plan"));
  });

  // AC: @dispatch-workspace-configuration ac-1
  // AC: @dispatch-workspace-configuration ac-2
  // AC: @dispatch-invocation-worktree-isolation ac-5
  it("provisions a task worktree and records the resolved merge target without drift", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  worktree_root: .dispatch-root\n",
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 1)}`;
    const first = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Implement Dispatch Config",
        slugs: ["task-implement-dispatch-workspace-config"],
      },
    });

    const metadata = await readWorkspaceRecord(first.metadataPath, taskRef);

    expect(first.cwd).toBe(
      path.join(tempDir, ".dispatch-root", "task-implement-dispatch-workspace-config-01task00"),
    );
    expect(metadata.resolved_base_branch).toBe("agent-dev");
    expect(metadata.integration?.target_branch).toBe("agent-dev");

    git(tempDir, "checkout main");
    const second = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Implement Dispatch Config",
        slugs: ["task-implement-dispatch-workspace-config"],
      },
    });
    const metadataAgain = await readWorkspaceRecord(second.metadataPath, taskRef);

    expect(second.cwd).toBe(first.cwd);
    expect(metadataAgain.resolved_base_branch).toBe("agent-dev");
    expect(metadataAgain.integration?.target_branch).toBe("agent-dev");
  });

  // AC: @dispatch-workspace-configuration ac-8
  it("fails with actionable guidance when a foreign-root registry record already exists for the task", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: agent-dev\n  worktree_root: .dispatch-root\n",
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 30)}`;
    const ctx = await initContext(tempDir);
    const registryPath = getDispatchWorkspaceRegistryPath(ctx);
    const now = "2026-03-18T00:00:00.000Z";
    const foreignRoot = path.join(tempDir, ".foreign-worktrees");
    const shortId = taskRef.slice(1, 9).toLowerCase();
    const canonicalBranch = `dispatch/task/task-foreign-record-provisioning/${shortId}`;

    await fs.writeFile(
      registryPath,
      YAML.stringify({
        kynetic_dispatch_workspaces: "1.0",
        workspaces: [
          {
            workspace_id: "dispatch-workspace-foreign",
            task_ref: taskRef,
            task_slug: "task-foreign-record-provisioning",
            worktree_root: foreignRoot,
            resolved_base_branch: "agent-dev",
            base_branch_point: "abc123",
            canonical_branch: canonicalBranch,
            canonical_branch_head: "abc123",
            lifecycle_state: "ready",
            active_role: null,
            worktrees: {
              worker: {
                path: path.join(foreignRoot, `task-foreign-record-provisioning-${shortId}`),
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

    await expect(
      provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        task: { title: "Foreign Record Provisioning", slugs: ["task-foreign-record-provisioning"] },
      }),
    ).rejects.toMatchObject({
      message: `Task ${taskRef} already has an open dispatch workspace in foreign worktree root "${foreignRoot}" (${path.join(foreignRoot, `task-foreign-record-provisioning-${shortId}`)}).`,
      suggestion: `Resume work from that checkout, or close/reset workspace "dispatch-workspace-foreign" before provisioning under "${path.join(tempDir, ".dispatch-root")}".`,
    });

    const records = await loadDispatchWorkspaceRegistry(ctx);
    expect(records.filter((record) => record.task_ref === taskRef)).toHaveLength(1);
    expect(records[0]?.worktree_root).toBe(foreignRoot);
  });

  // AC: @dispatch-workspace-configuration ac-1
  // AC: @dispatch-workspace-configuration ac-3
  // AC: @dispatch-invocation-worktree-isolation ac-1
  it("uses the provisioned worktree cwd for dispatched invocations", async () => {
    await seedRepo(tempDir);
    await setupProjectWithAgent(tempDir);
    git(tempDir, "checkout -b agent-dev");
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: agent-dev\n  worktree_root: .dispatch-root\n",
      "utf-8",
    );

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as never,
      outcome: "success",
      durationMs: 1,
    });

    const engine = new DispatchEngine({
      projectDir: tempDir,
      specDir: tempDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    await engine.start();
    const taskId = testUlid("TASK", 2);
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: {
        _ulid: taskId,
        title: "Dispatch Runtime Task",
        slugs: ["dispatch-runtime-task"],
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
    const invocation = runSpy.mock.calls[0][0];
    expect(invocation.cwd).toBe(
      path.join(tempDir, ".dispatch-root", "dispatch-runtime-task-01task00"),
    );
    expect(invocation.env?.KSPEC_DISPATCH_BASE_BRANCH).toBe("agent-dev");
    expect(invocation.env?.KSPEC_DISPATCH_MERGE_TARGET).toBe("agent-dev");

    await engine.stop();
  });

  // AC: @dispatch-workspace-configuration ac-4
  it("fails with actionable guidance when dispatch.base_branch is invalid", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: missing-branch\n  worktree_root: .dispatch-root\n",
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 3)}`;

    await expect(
      provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        task: { title: "Broken Dispatch Config", slugs: ["broken-dispatch-config"] },
      }),
    ).rejects.toMatchObject({
      name: "DispatchWorkspaceError",
      message:
        'Configured dispatch.base_branch "missing-branch" does not exist in this repository.',
      suggestion:
        "Create or fetch that branch, or update kspec.config.yaml to a valid base branch.",
    } satisfies Partial<DispatchWorkspaceError>);
  });

  // AC: @dispatch-workspace-configuration ac-4
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  it("fails with actionable guidance when default 'main' fallback does not exist", async () => {
    // Create a repo with a non-main default branch, detach HEAD so resolveCurrentBranch returns null
    git(tempDir, "init -b develop");
    git(tempDir, 'config user.email "test@example.com"');
    git(tempDir, 'config user.name "Test User"');
    await fs.writeFile(path.join(tempDir, "README.md"), "seed\n", "utf-8");
    git(tempDir, "add README.md");
    git(tempDir, 'commit -m "init"');
    git(tempDir, "checkout --detach");

    await expect(resolveDispatchWorkspaceConfig(tempDir)).rejects.toMatchObject({
      name: "DispatchWorkspaceError",
      message:
        "No base branch could be resolved: no configured dispatch.base_branch, no remote HEAD, " +
        'no current branch, and default "main" does not exist.',
      suggestion:
        "Set dispatch.base_branch in kspec.config.yaml, or ensure the repository has a main branch.",
    } satisfies Partial<DispatchWorkspaceError>);
  });

  // AC: @dispatch-workspace-configuration ac-2
  it("falls back to validated 'main' when no remote HEAD and detached HEAD", async () => {
    // Repo with "main" branch, no remote, detached HEAD — default fallback should succeed
    await seedRepo(tempDir);
    git(tempDir, "checkout --detach");

    const resolved = await resolveDispatchWorkspaceConfig(tempDir);

    expect(resolved.baseBranch).toBe("main");
    expect(resolved.baseBranchSource).toBe("default");
    expect(resolved.baseBranchStartPoint).toBe("main");
  });

  // AC: @dispatch-workspace-configuration ac-4
  it("fails with actionable guidance when dispatch.worktree_root resolves inside .kspec", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    await fs.mkdir(path.join(tempDir, ".kspec"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: agent-dev\n  worktree_root: .kspec/worktrees\n",
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 4)}`;

    await expect(
      provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        task: { title: "Broken Dispatch Root", slugs: ["broken-dispatch-root"] },
      }),
    ).rejects.toMatchObject({
      name: "DispatchWorkspaceError",
      message: `Resolved dispatch worktree root "${path.join(tempDir, ".kspec", "worktrees")}" is inside the shadow worktree.`,
      suggestion: "Set dispatch.worktree_root to a directory outside .kspec/.",
    } satisfies Partial<DispatchWorkspaceError>);
  });

  // AC: @dispatch-workspace-configuration ac-8
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  it("fails with actionable guidance when the canonical branch is already attached in a foreign checkout", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b agent-dev");
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: agent-dev\n  worktree_root: .dispatch-root\n",
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 5)}`;
    const slug = "foreign-collision-task";
    const canonicalBranch = `dispatch/task/${slug}/${taskRef.slice(1, 9).toLowerCase()}`;
    const foreignRoot = path.join(tempDir, ".foreign-worktrees");
    const foreignWorktreeDir = path.join(
      foreignRoot,
      `${slug}-${taskRef.slice(1, 9).toLowerCase()}`,
    );
    await fs.mkdir(foreignRoot, { recursive: true });
    git(tempDir, `worktree add -b ${canonicalBranch} ${foreignWorktreeDir} agent-dev`);

    await expect(
      provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        task: { title: "Foreign Collision Task", slugs: [slug] },
      }),
    ).rejects.toMatchObject({
      name: "DispatchWorkspaceError",
      message: `Dispatch canonical branch "${canonicalBranch}" is already attached to foreign worktree "${foreignWorktreeDir}" outside this checkout's worktree root "${path.join(tempDir, ".dispatch-root")}".`,
      suggestion: `Remove or relocate the foreign worktree in the other checkout, then retry dispatch from "${path.join(tempDir, ".dispatch-root")}".`,
    } satisfies Partial<DispatchWorkspaceError>);
  });
});

// AC: @dispatch-workspace-configuration ac-5
describe("dispatch publication mode configuration", () => {
  let tempDir: string;
  let originalPath: string | undefined;
  let toolDirs: string[];

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-pubmode-");
    originalPath = process.env.PATH;
    toolDirs = [];
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    vi.restoreAllMocks();
    for (const dir of toolDirs) {
      await cleanupTempDir(dir);
    }
    await cleanupTempDir(tempDir);
  });

  it("resolves publication_mode from config", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  publication_mode: manual_merge\n",
      "utf-8",
    );

    const resolved = await resolveDispatchWorkspaceConfig(tempDir);
    expect(resolved.publicationMode).toBe("manual_merge");
  });

  it("defaults publication_mode to auto when not configured", async () => {
    await seedRepo(tempDir);

    const resolved = await resolveDispatchWorkspaceConfig(tempDir);
    expect(resolved.publicationMode).toBe("auto");
  });

  it("manual_merge config overrides auto-detection when gh is available", async () => {
    await seedRepo(tempDir);
    git(tempDir, "remote add origin https://github.com/example/repo.git");
    const toolDir = await createToolPath({ gh: true });
    toolDirs.push(toolDir);
    process.env.PATH = `${toolDir}:${originalPath ?? ""}`;

    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  publication_mode: manual_merge\n",
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 50)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Config Override Test", slugs: ["task-config-override"] },
    });

    expect(workspace.metadata.publicationMode).toBe("manual_merge");
  });

  it("pull_request config overrides auto-detection when gh is unavailable", async () => {
    await seedRepo(tempDir);
    const toolDir = await createToolPath({ gh: false });
    toolDirs.push(toolDir);
    process.env.PATH = `${toolDir}:${originalPath ?? ""}`;

    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  publication_mode: pull_request\n",
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 51)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "PR Override Test", slugs: ["task-pr-override"] },
    });

    expect(workspace.metadata.publicationMode).toBe("pull_request");
  });

  it("auto preserves environment-based detection", async () => {
    await seedRepo(tempDir);
    git(tempDir, "remote add origin https://github.com/example/repo.git");
    const toolDir = await createToolPath({ gh: true });
    toolDirs.push(toolDir);
    process.env.PATH = `${toolDir}:${originalPath ?? ""}`;

    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  publication_mode: auto\n",
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 52)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Auto Mode Test", slugs: ["task-auto-mode"] },
    });

    expect(workspace.metadata.publicationMode).toBe("pull_request");
  });
});

// AC: @dispatch-workspace-configuration ac-6
// AC: @dispatch-workspace-configuration ac-7
// AC: @trait-error-guidance ac-3 — N/A: stale target errors reference config keys, not kspec item refs
// AC: @trait-error-guidance ac-4 — N/A: stale target detection is not a state transition error
// AC: @trait-error-guidance ac-5 — N/A: stale target detection is not a field validation error
// AC: @trait-error-guidance ac-6 — N/A: stale target error is thrown before any CLI output mode applies
describe("stale integration target detection", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-stale-target-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-workspace-configuration ac-6
  it("auto-updates integration target when config changes and integration is pending", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");
    // Add a commit on dev so its tip differs from main
    await fs.writeFile(path.join(tempDir, "dev-file.txt"), "dev\n", "utf-8");
    git(tempDir, "add dev-file.txt");
    git(tempDir, 'commit -m "dev commit"');
    const devHead = git(tempDir, "rev-parse HEAD");
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n",
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 60)}`;

    // Initial provision with base_branch=main
    const first = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Stale Target Test", slugs: ["task-stale-target"] },
    });
    const firstRecord = await readWorkspaceRecord(first.metadataPath, taskRef);
    expect(firstRecord.integration?.target_branch).toBe("main");
    const mainCommit = firstRecord.integration?.target_commit as string;
    expect(mainCommit).toBeTruthy();

    // Change config to base_branch=dev
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: dev\n",
      "utf-8",
    );

    // Re-provision — should auto-update since integration is pending
    const second = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Stale Target Test", slugs: ["task-stale-target"] },
    });
    const secondRecord = await readWorkspaceRecord(second.metadataPath, taskRef);

    expect(secondRecord.integration?.target_branch).toBe("dev");
    expect(secondRecord.resolved_base_branch).toBe("dev");
    // target_commit must also update to the new branch's tip, not stay stale
    expect(secondRecord.integration?.target_commit).not.toBe(mainCommit);
    expect(secondRecord.integration?.target_commit).toBe(devHead);
  });

  // AC: @plan-branch-dispatch-target ac-stale-target-detected
  // AC: @plan-branch-dispatch-target ac-stale-target-updated
  it("retargets an existing workspace when the linked plan later gains a branch", async () => {
    await seedRepo(tempDir);
    await setupProjectWithAgent(tempDir);
    git(tempDir, "checkout -b dev");
    const devHead = git(tempDir, "rev-parse dev");
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n",
      "utf-8",
    );
    await writePlansFile(tempDir, [
      {
        _ulid: testUlid("PNAA", 4),
        slug: "stale-plan",
        title: "Stale Plan",
        branch: null,
      },
    ]);

    const taskRef = `@${testUlid("TASK", 65)}`;
    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Plan Retarget Test",
        slugs: ["task-plan-retarget"],
        plan_ref: "@stale-plan",
      },
    });
    const initialRecord = await readWorkspaceRecord(
      getDispatchWorkspaceRegistryPath(await initContext(tempDir)),
      taskRef,
    );
    expect(initialRecord.integration?.target_branch).toBe("main");

    await writePlansFile(tempDir, [
      {
        _ulid: testUlid("PNAA", 4),
        slug: "stale-plan",
        title: "Stale Plan",
        branch: "dev",
      },
    ]);

    const second = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Plan Retarget Test",
        slugs: ["task-plan-retarget"],
        plan_ref: "@stale-plan",
      },
    });
    const secondRecord = await readWorkspaceRecord(second.metadataPath, taskRef);

    expect(secondRecord.integration?.target_branch).toBe("dev");
    expect(secondRecord.resolved_base_branch).toBe("dev");
    expect(secondRecord.base_branch_point).toBe(devHead);
    expect(secondRecord.integration?.target_commit).toBe(devHead);
    expect(second.metadata.integrationTargetBranch).toBe("dev");
    expect(second.metadata.baseBranchPoint).toBe(devHead);
    expect(second.metadata.integrationTargetCommit).toBe(devHead);
  });

  // AC: @dispatch-workspace-configuration ac-6
  it("throws with actionable guidance when config changes but integration is active", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n",
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 61)}`;

    // Initial provision with base_branch=main
    const first = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Active Integration Test", slugs: ["task-active-integration"] },
    });

    // Mutate the registry to simulate active integration (merged state)
    const raw = YAML.parse(await readTestOutput(first.metadataPath)) as {
      workspaces: Array<Record<string, any>>;
    };
    const ws = raw.workspaces.find((w) => w.task_ref === taskRef);
    ws!.integration.status = "merged";
    await fs.writeFile(first.metadataPath, YAML.stringify(raw), "utf-8");

    // Change config to base_branch=dev
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: dev\n",
      "utf-8",
    );

    // Re-provision — should throw since integration is active
    await expect(
      provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        task: { title: "Active Integration Test", slugs: ["task-active-integration"] },
      }),
    ).rejects.toMatchObject({
      name: "DispatchWorkspaceError",
      message: expect.stringContaining("cannot be silently retargeted"),
      suggestion: expect.stringContaining("revert dispatch.base_branch"),
    } satisfies Partial<DispatchWorkspaceError>);
  });

  // AC: @dispatch-workspace-configuration ac-6
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  it("error includes description and suggested resolution for active integration conflict", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n",
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 62)}`;
    const first = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Error Guidance Test", slugs: ["task-error-guidance"] },
    });

    // Mutate to in_progress integration
    const raw = YAML.parse(await readTestOutput(first.metadataPath)) as {
      workspaces: Array<Record<string, any>>;
    };
    const ws = raw.workspaces.find((w) => w.task_ref === taskRef);
    ws!.integration.status = "in_progress";
    await fs.writeFile(first.metadataPath, YAML.stringify(raw), "utf-8");

    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: dev\n",
      "utf-8",
    );

    try {
      await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        task: { title: "Error Guidance Test", slugs: ["task-error-guidance"] },
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const error = err as DispatchWorkspaceError;
      // AC: @trait-error-guidance ac-1 — includes description of what went wrong
      expect(error.message).toContain("main");
      expect(error.message).toContain("dev");
      expect(error.message).toContain("in_progress");
      // AC: @trait-error-guidance ac-2 — includes suggested action to resolve
      expect(error.suggestion).toContain("revert dispatch.base_branch");
      expect(error.suggestion).toContain("reset the workspace integration state");
    }
  });

  // AC: @dispatch-workspace-configuration ac-7
  it("dispatch prompt reflects updated integration target after re-provisioning", async () => {
    await seedRepo(tempDir);
    git(tempDir, "checkout -b dev");
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n",
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 63)}`;

    // Initial provision targeting main
    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Prompt Target Test", slugs: ["task-prompt-target"] },
    });

    // Change config to dev
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: dev\n",
      "utf-8",
    );

    // Re-provision — should update target to dev
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Prompt Target Test", slugs: ["task-prompt-target"] },
    });

    // Verify metadata reflects the updated target
    expect(workspace.metadata.integrationTargetBranch).toBe("dev");
    expect(workspace.metadata.mergeTargetBranch).toBe("dev");

    // Verify the orientation context (dispatch prompt) reflects the update
    const orientation = buildOrientationContext(
      taskRef,
      "task.ready",
      { title: "Prompt Target Test" },
      workspace.metadata,
      "worker",
    );

    expect(orientation).toContain("Integration target: dev");
    expect(orientation).not.toContain("Integration target: main");
  });

  // AC: @dispatch-workspace-configuration ac-6
  it("preserves integration target when config matches existing record", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n",
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 64)}`;

    await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "No Change Test", slugs: ["task-no-change"] },
    });

    // Re-provision with same config — should keep same target
    const second = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "No Change Test", slugs: ["task-no-change"] },
    });

    const record = await readWorkspaceRecord(second.metadataPath, taskRef);
    expect(record.integration?.target_branch).toBe("main");
  });
});
