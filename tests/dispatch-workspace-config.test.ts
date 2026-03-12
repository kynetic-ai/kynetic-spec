import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import { DispatchEngine } from "../src/agent-runtime/dispatch.js";
import {
  DispatchWorkspaceError,
  resolveDispatchWorkspaceConfig,
  provisionDispatchWorkspace,
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

async function setupProjectWithAgent(dir: string): Promise<void> {
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

  // AC: @dispatch-workspace-configuration ac-1
  // AC: @dispatch-workspace-configuration ac-2
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
      task: { title: "Implement Dispatch Config", slugs: ["task-implement-dispatch-workspace-config"] },
    });

    const metadata = await readWorkspaceRecord(first.metadataPath, taskRef);

    expect(first.cwd).toBe(path.join(tempDir, ".dispatch-root", "task-implement-dispatch-workspace-config-01task00"));
    expect(metadata.resolved_base_branch).toBe("agent-dev");
    expect(metadata.integration?.target_branch).toBe("agent-dev");

    git(tempDir, "checkout main");
    const second = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Implement Dispatch Config", slugs: ["task-implement-dispatch-workspace-config"] },
    });
    const metadataAgain = await readWorkspaceRecord(second.metadataPath, taskRef);

    expect(second.cwd).toBe(first.cwd);
    expect(metadataAgain.resolved_base_branch).toBe("agent-dev");
    expect(metadataAgain.integration?.target_branch).toBe("agent-dev");
  });

  // AC: @dispatch-workspace-configuration ac-1
  // AC: @dispatch-workspace-configuration ac-3
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
    expect(invocation.cwd).toBe(path.join(tempDir, ".dispatch-root", "dispatch-runtime-task-01task00"));
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
});
