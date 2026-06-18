import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import * as workspaceModule from "../src/agent-runtime/workspace.js";
import { DispatchEngine } from "../src/agent-runtime/dispatch.js";
import {
  ensureWorkspaceBootstrap,
  DispatchBootstrapError,
} from "../src/agent-runtime/bootstrap.js";
import { DAEMON_RUNTIME_MODE_ENV_KEYS } from "../src/cli/commands/serve.js";
import {
  provisionDispatchWorkspace,
  purgeDispatchWorkspaceRecord,
  validateDispatchWorkspaceForInvocation,
  DispatchWorkspaceError,
} from "../src/agent-runtime/workspace.js";
import type { Agent } from "../src/schema/meta.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  readTestOutput,
  testUlid,
} from "./helpers/cli.js";
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

async function setupProject(
  dir: string,
  options?: {
    dispatchConfig?: string;
    agentBootstrap?: string;
    dispatchOn?: "task.ready" | "task.pending_review";
    agentId?: string;
  },
): Promise<void> {
  const dispatchOn = options?.dispatchOn ?? "task.ready";
  const agentId = options?.agentId ?? "dispatch-worker";
  await fs.writeFile(
    path.join(dir, "kynetic.yaml"),
    'kynetic: "1.1"\ntitle: Test Project\ntask_storage:\n  format: split\n',
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "kynetic.meta.yaml"),
    [
      'kynetic_meta: "1.0"',
      "agents:",
      "  - _ulid: 01AGNT00000000000000000000",
      `    id: ${agentId}`,
      '    name: "Dispatch Agent"',
      "    dispatch:",
      `      - on: ${dispatchOn}`,
      "    concurrency:",
      "      max_concurrent: 1",
      "    adapter: mock-acp",
      "    auto_approve: false",
      ...(options?.agentBootstrap
        ? [
            "    bootstrap:",
            "      steps:",
            ...options.agentBootstrap.split("\n").map((line) => `        ${line}`),
          ]
        : []),
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(path.join(dir, "project.tasks.yaml"), "tasks: []\n", "utf-8");
  if (options?.dispatchConfig) {
    await fs.writeFile(path.join(dir, "kspec.config.yaml"), options.dispatchConfig, "utf-8");
  }
}

function makeAgent(overrides?: Partial<Agent>): Agent {
  return {
    _ulid: testUlid("AGNT"),
    id: "bootstrap-agent",
    name: "Bootstrap Agent",
    capabilities: [],
    tools: [],
    conventions: [],
    dispatch: [],
    skills: [],
    concurrency: { max_concurrent: 1 },
    auto_approve: false,
    tags: [],
    ...overrides,
  };
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

async function updateWorkspaceRecord(
  registryPath: string,
  taskRef: string,
  mutate: (workspace: Record<string, any>) => void,
): Promise<void> {
  const raw = YAML.parse(await readTestOutput(registryPath)) as {
    kynetic_dispatch_workspaces?: string;
    workspaces?: Array<Record<string, any>>;
  };
  const workspaces = raw.workspaces ?? [];
  const workspace = workspaces.find((entry) => entry.task_ref === taskRef);
  if (!workspace) {
    throw new Error(`Workspace record not found for ${taskRef}`);
  }
  mutate(workspace);
  await fs.writeFile(
    registryPath,
    YAML.stringify({
      kynetic_dispatch_workspaces: raw.kynetic_dispatch_workspaces ?? "1.0",
      workspaces,
    }),
    "utf-8",
  );
}

describe("dispatch runtime bootstrap contract", { timeout: 60_000 }, () => {
  // AC: @trait-error-guidance ac-3 — N/A: pre-invocation workspace validation does not resolve user-supplied refs.
  // AC: @trait-error-guidance ac-4 — N/A: the validation path does not perform or report invalid task state transitions.
  // AC: @trait-error-guidance ac-5 — N/A: workspace validation failures are runtime diagnostics, not schema validation errors.
  // AC: @trait-error-guidance ac-6 — N/A: validateDispatchWorkspaceForInvocation is a runtime helper and has no JSON output mode.
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-bootstrap-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-1
  it("runs configured dispatch and agent bootstrap before delivering the prompt", async () => {
    await seedRepo(tempDir);
    await setupProject(tempDir, {
      dispatchConfig: [
        "dispatch:",
        "  base_branch: agent-dev",
        "  bootstrap:",
        "    steps:",
        "      - run: mkdir -p .dispatch-cache && printf project > .dispatch-cache/project.txt",
      ].join("\n"),
      agentBootstrap: [
        "- run: mkdir -p .dispatch-cache && printf agent > .dispatch-cache/agent.txt",
      ].join("\n"),
    });

    const runSpy = vi
      .spyOn(invocationModule, "runInvocation")
      .mockImplementation(async (options) => {
        await expect(
          readTestOutput(path.join(options.cwd, ".dispatch-cache", "project.txt")),
        ).resolves.toBe("project");
        await expect(
          readTestOutput(path.join(options.cwd, ".dispatch-cache", "agent.txt")),
        ).resolves.toBe("agent");
        return {
          session: {} as never,
          outcome: "success",
          durationMs: 1,
        };
      });

    const engine = new DispatchEngine({
      projectDir: tempDir,
      specDir: tempDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    await engine.start();
    const taskId = testUlid("TASK", 21);
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: {
        _ulid: taskId,
        title: "Bootstrap Before Prompt",
        slugs: ["bootstrap-before-prompt"],
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

    for (let i = 0; i < 50 && runSpy.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(runSpy).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-2
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  it("fails bootstrap when tracked source mutations are not explicitly allowed", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      [
        "dispatch:",
        "  base_branch: agent-dev",
        "  bootstrap:",
        "    steps:",
        "      - run: printf changed >> README.md",
      ].join("\n"),
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 22)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Tracked Mutation Bootstrap", slugs: ["tracked-mutation-bootstrap"] },
    });

    await expect(
      ensureWorkspaceBootstrap({
        projectDir: tempDir,
        workspaceDir: workspace.cwd,
        metadataPath: workspace.metadataPath,
        metadata: workspace.metadata,
        role: "worker",
        agent: makeAgent(),
        env: {},
      }),
    ).rejects.toMatchObject({
      name: "DispatchBootstrapError",
      suggestion: expect.stringContaining("opt in"),
    } satisfies Partial<DispatchBootstrapError>);

    const record = await readWorkspaceRecord(workspace.metadataPath, taskRef);
    expect(record.bootstrap.roleStates.worker.status).toBe("failed");
    expect(record.bootstrap.roleStates.worker.failureMessage).toContain("allow_tracked_changes");
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-3
  it("reuses valid worker bootstrap state for reviewer preflight instead of rerunning it", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      [
        "dispatch:",
        "  base_branch: agent-dev",
        "  bootstrap:",
        "    steps:",
        "      - run: mkdir -p .dispatch-cache && printf worker > .dispatch-cache/worker-only.txt",
        "        roles: [worker]",
      ].join("\n"),
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 23)}`;
    const workerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Reviewer Bootstrap Reuse", slugs: ["reviewer-bootstrap-reuse"] },
    });

    await ensureWorkspaceBootstrap({
      projectDir: tempDir,
      workspaceDir: workerWorkspace.cwd,
      metadataPath: workerWorkspace.metadataPath,
      metadata: workerWorkspace.metadata,
      role: "worker",
      agent: makeAgent(),
      env: {},
    });

    const reviewerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: { title: "Reviewer Bootstrap Reuse", slugs: ["reviewer-bootstrap-reuse"] },
    });
    const result = await ensureWorkspaceBootstrap({
      projectDir: tempDir,
      workspaceDir: reviewerWorkspace.cwd,
      metadataPath: reviewerWorkspace.metadataPath,
      metadata: reviewerWorkspace.metadata,
      role: "reviewer",
      agent: makeAgent(),
      env: {},
    });

    expect(result.reused).toBe(true);
    expect(result.ranSteps).toBe(false);
    await expect(
      readTestOutput(path.join(workerWorkspace.cwd, ".dispatch-cache", "worker-only.txt")),
    ).resolves.toBe("worker");
    await expect(
      fs.stat(path.join(reviewerWorkspace.cwd, ".dispatch-cache", "worker-only.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const record = await readWorkspaceRecord(workerWorkspace.metadataPath, taskRef);
    expect(record.bootstrap.roleStates.worker.status).toBe("succeeded");
    expect(record.bootstrap.roleStates.reviewer.status).toBe("succeeded");
    expect(record.bootstrap.roleStates.reviewer.steps).toEqual([]);
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-3
  it("does not let reviewer bootstrap readiness skip the first worker bootstrap run", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      [
        "dispatch:",
        "  base_branch: agent-dev",
        "  bootstrap:",
        "    steps:",
        "      - run: mkdir -p .dispatch-cache && printf worker > .dispatch-cache/worker-ready.txt",
        "        roles: [worker]",
        "      - run: mkdir -p .dispatch-cache && printf reviewer > .dispatch-cache/reviewer-ready.txt",
        "        roles: [reviewer]",
        "        idempotent: true",
      ].join("\n"),
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 29)}`;
    const reviewerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: { title: "Reviewer First Bootstrap", slugs: ["reviewer-first-bootstrap"] },
    });

    const reviewerResult = await ensureWorkspaceBootstrap({
      projectDir: tempDir,
      workspaceDir: reviewerWorkspace.cwd,
      metadataPath: reviewerWorkspace.metadataPath,
      metadata: reviewerWorkspace.metadata,
      role: "reviewer",
      agent: makeAgent(),
      env: {},
    });

    expect(reviewerResult.reused).toBe(false);
    expect(reviewerResult.ranSteps).toBe(true);
    await expect(
      readTestOutput(path.join(reviewerWorkspace.cwd, ".dispatch-cache", "reviewer-ready.txt")),
    ).resolves.toBe("reviewer");

    const workerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Reviewer First Bootstrap", slugs: ["reviewer-first-bootstrap"] },
    });
    const workerResult = await ensureWorkspaceBootstrap({
      projectDir: tempDir,
      workspaceDir: workerWorkspace.cwd,
      metadataPath: workerWorkspace.metadataPath,
      metadata: workerWorkspace.metadata,
      role: "worker",
      agent: makeAgent(),
      env: {},
    });

    expect(workerResult.reused).toBe(false);
    expect(workerResult.ranSteps).toBe(true);
    await expect(
      readTestOutput(path.join(workerWorkspace.cwd, ".dispatch-cache", "worker-ready.txt")),
    ).resolves.toBe("worker");

    const record = await readWorkspaceRecord(workerWorkspace.metadataPath, taskRef);
    expect(record.bootstrap.roleStates.reviewer.status).toBe("succeeded");
    expect(record.bootstrap.roleStates.worker.status).toBe("succeeded");
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-3
  it("rejects a fresh reviewer workspace when required bootstrap steps are not reviewer-safe", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      [
        "dispatch:",
        "  base_branch: agent-dev",
        "  bootstrap:",
        "    steps:",
        "      - run: mkdir -p .dispatch-cache && echo reviewer > .dispatch-cache/reviewer-first",
      ].join("\n"),
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 28)}`;
    const reviewerWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      role: "reviewer",
      task: { title: "Reviewer Requires Safe Steps", slugs: ["reviewer-requires-safe-steps"] },
    });

    await expect(
      ensureWorkspaceBootstrap({
        projectDir: tempDir,
        workspaceDir: reviewerWorkspace.cwd,
        metadataPath: reviewerWorkspace.metadataPath,
        metadata: reviewerWorkspace.metadata,
        role: "reviewer",
        agent: makeAgent(),
        env: {},
      }),
    ).rejects.toMatchObject({
      name: "DispatchBootstrapError",
      suggestion: expect.stringContaining("worker workspace"),
    } satisfies Partial<DispatchBootstrapError>);

    const record = await readWorkspaceRecord(reviewerWorkspace.metadataPath, taskRef);
    expect(record.bootstrap.roleStates.reviewer.status).toBe("failed");
    expect(record.bootstrap.roleStates.reviewer.failureMessage).toContain(
      "cannot safely rerun non-idempotent steps",
    );
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-4
  it(
    "records explicit bootstrap invalidation reasons for config, head, and prior failure changes",
    { timeout: 30_000 },
    async () => {
      await seedRepo(tempDir);
      const configPath = path.join(tempDir, "kspec.config.yaml");
      await fs.writeFile(
        configPath,
        [
          "dispatch:",
          "  base_branch: agent-dev",
          "  bootstrap:",
          "    steps:",
          "      - run: mkdir -p .dispatch-cache && echo run >> .dispatch-cache/history",
        ].join("\n"),
        "utf-8",
      );

      const taskRef = `@${testUlid("TASK", 24)}`;
      let workspace = await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        task: {
          title: "Bootstrap Invalidation Signals",
          slugs: ["bootstrap-invalidation-signals"],
        },
      });

      let bootstrapped = await ensureWorkspaceBootstrap({
        projectDir: tempDir,
        workspaceDir: workspace.cwd,
        metadataPath: workspace.metadataPath,
        metadata: workspace.metadata,
        role: "worker",
        agent: makeAgent(),
        env: {},
      });

      await fs.writeFile(
        configPath,
        [
          "dispatch:",
          "  base_branch: agent-dev",
          "  bootstrap:",
          "    steps:",
          "      - run: mkdir -p .dispatch-cache && echo run >> .dispatch-cache/history",
          "        idempotent: true",
        ].join("\n"),
        "utf-8",
      );
      workspace = await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        task: {
          title: "Bootstrap Invalidation Signals",
          slugs: ["bootstrap-invalidation-signals"],
        },
      });
      bootstrapped = await ensureWorkspaceBootstrap({
        projectDir: tempDir,
        workspaceDir: workspace.cwd,
        metadataPath: workspace.metadataPath,
        metadata: workspace.metadata,
        role: "worker",
        agent: makeAgent(),
        env: {},
      });
      expect(bootstrapped.metadata.bootstrap.invalidationReasons).toContain(
        "bootstrap-config-changed",
      );

      await fs.writeFile(path.join(workspace.cwd, "runtime.txt"), "runtime\n", "utf-8");
      git(workspace.cwd, "add runtime.txt");
      git(workspace.cwd, 'commit -m "runtime change"');
      workspace = await provisionDispatchWorkspace({
        projectDir: tempDir,
        taskRef,
        task: {
          title: "Bootstrap Invalidation Signals",
          slugs: ["bootstrap-invalidation-signals"],
        },
      });
      bootstrapped = await ensureWorkspaceBootstrap({
        projectDir: tempDir,
        workspaceDir: workspace.cwd,
        metadataPath: workspace.metadataPath,
        metadata: workspace.metadata,
        role: "worker",
        agent: makeAgent(),
        env: {},
      });
      expect(bootstrapped.metadata.bootstrap.invalidationReasons).toContain(
        "canonical-branch-head-changed",
      );

      await updateWorkspaceRecord(workspace.metadataPath, taskRef, (record) => {
        record.bootstrap.status = "failed";
        record.bootstrap.roleStates.worker.status = "failed";
      });
      const failedRecord = await readWorkspaceRecord(workspace.metadataPath, taskRef);
      bootstrapped = await ensureWorkspaceBootstrap({
        projectDir: tempDir,
        workspaceDir: workspace.cwd,
        metadataPath: workspace.metadataPath,
        metadata: {
          ...workspace.metadata,
          bootstrap: failedRecord.bootstrap,
          bootstrapState: failedRecord.bootstrap,
        },
        role: "worker",
        agent: makeAgent(),
        env: {},
      });
      expect(bootstrapped.metadata.bootstrap.invalidationReasons).toContain(
        "prior-bootstrap-failed",
      );
    },
  );

  // AC: @dispatch-runtime-bootstrap-contract ac-5
  it("reuses prior bootstrap results on later worker invocations when no invalidation signal exists", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      [
        "dispatch:",
        "  base_branch: agent-dev",
        "  bootstrap:",
        "    steps:",
        '      - run: mkdir -p .dispatch-cache && count_file=.dispatch-cache/count && count=$(cat "$count_file" 2>/dev/null || echo 0) && echo $((count + 1)) > "$count_file"',
      ].join("\n"),
      "utf-8",
    );

    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef: `@${testUlid("TASK", 25)}`,
      task: { title: "Worker Bootstrap Reuse", slugs: ["worker-bootstrap-reuse"] },
    });

    await ensureWorkspaceBootstrap({
      projectDir: tempDir,
      workspaceDir: workspace.cwd,
      metadataPath: workspace.metadataPath,
      metadata: workspace.metadata,
      role: "worker",
      agent: makeAgent(),
      env: {},
    });
    const reused = await ensureWorkspaceBootstrap({
      projectDir: tempDir,
      workspaceDir: workspace.cwd,
      metadataPath: workspace.metadataPath,
      metadata: {
        ...workspace.metadata,
        bootstrap: (await readWorkspaceRecord(workspace.metadataPath, workspace.metadata.taskRef))
          .bootstrap,
        bootstrapState: (
          await readWorkspaceRecord(workspace.metadataPath, workspace.metadata.taskRef)
        ).bootstrap,
      },
      role: "worker",
      agent: makeAgent(),
      env: {},
    });

    expect(reused.reused).toBe(true);
    await expect(
      readTestOutput(path.join(workspace.cwd, ".dispatch-cache", "count")),
    ).resolves.toBe("1\n");
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-7
  it("validates a newly provisioned workspace as executable before launch handoff", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      ["dispatch:", "  base_branch: agent-dev"].join("\n"),
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 31)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Pre Invocation Validation Fresh",
        slugs: ["pre-invocation-validation-fresh"],
      },
    });

    const validated = await validateDispatchWorkspaceForInvocation({
      projectDir: tempDir,
      taskRef,
      workspace,
      task: {
        title: "Pre Invocation Validation Fresh",
        slugs: ["pre-invocation-validation-fresh"],
      },
      taskStatus: "pending",
    });

    expect(validated.repaired).toBe(false);
    expect(validated.workspace.cwd).toBe(workspace.cwd);
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-7
  it("runs the same pre-invocation validation gate for a reused workspace", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      ["dispatch:", "  base_branch: agent-dev"].join("\n"),
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 32)}`;
    const firstWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Pre Invocation Validation Reuse",
        slugs: ["pre-invocation-validation-reuse"],
      },
    });
    await validateDispatchWorkspaceForInvocation({
      projectDir: tempDir,
      taskRef,
      workspace: firstWorkspace,
      task: {
        title: "Pre Invocation Validation Reuse",
        slugs: ["pre-invocation-validation-reuse"],
      },
      taskStatus: "pending",
    });

    const reusedWorkspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Pre Invocation Validation Reuse",
        slugs: ["pre-invocation-validation-reuse"],
      },
    });
    const validated = await validateDispatchWorkspaceForInvocation({
      projectDir: tempDir,
      taskRef,
      workspace: reusedWorkspace,
      task: {
        title: "Pre Invocation Validation Reuse",
        slugs: ["pre-invocation-validation-reuse"],
      },
      taskStatus: "pending",
    });

    expect(validated.repaired).toBe(false);
    expect(validated.workspace.cwd).toBe(reusedWorkspace.cwd);
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-8
  // AC: @dispatch-runtime-bootstrap-contract ac-9
  it("repairs a worker workspace deleted before invocation and revalidates it", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      ["dispatch:", "  base_branch: agent-dev"].join("\n"),
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 33)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Pre Invocation Validation Repair",
        slugs: ["pre-invocation-validation-repair"],
      },
    });

    git(tempDir, `worktree remove --force "${workspace.cwd}"`);

    const validated = await validateDispatchWorkspaceForInvocation({
      projectDir: tempDir,
      taskRef,
      workspace,
      task: {
        title: "Pre Invocation Validation Repair",
        slugs: ["pre-invocation-validation-repair"],
      },
      taskStatus: "pending",
    });

    expect(validated.repaired).toBe(true);
    expect(validated.workspace.cwd).toBe(workspace.cwd);
    await expect(fs.stat(validated.workspace.cwd)).resolves.toBeTruthy();
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-8
  // AC: @dispatch-runtime-bootstrap-contract ac-9
  it("repairs a workspace that exists but fails the executability probe", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      ["dispatch:", "  base_branch: agent-dev"].join("\n"),
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 36)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Pre Invocation Validation Probe Repair",
        slugs: ["pre-invocation-validation-probe-repair"],
      },
    });

    await fs.chmod(workspace.cwd, 0o000);
    try {
      const validated = await validateDispatchWorkspaceForInvocation({
        projectDir: tempDir,
        taskRef,
        workspace,
        task: {
          title: "Pre Invocation Validation Probe Repair",
          slugs: ["pre-invocation-validation-probe-repair"],
        },
        taskStatus: "pending",
      });

      expect(validated.repaired).toBe(true);
      expect(validated.workspace.cwd).toBe(workspace.cwd);
      await expect(fs.stat(validated.workspace.cwd)).resolves.toBeTruthy();
    } finally {
      await fs.chmod(workspace.cwd, 0o755).catch(() => undefined);
    }
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-8
  // AC: @dispatch-runtime-bootstrap-contract ac-10
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  it("fails validation with actionable diagnostics when no trustworthy recovery path exists", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      ["dispatch:", "  base_branch: agent-dev"].join("\n"),
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 34)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Pre Invocation Validation Unrecoverable",
        slugs: ["pre-invocation-validation-unrecoverable"],
      },
    });
    const record = await readWorkspaceRecord(workspace.metadataPath, taskRef);

    git(tempDir, `worktree remove --force "${workspace.cwd}"`);
    await purgeDispatchWorkspaceRecord(tempDir, taskRef, record.workspace_id as string);

    await expect(
      validateDispatchWorkspaceForInvocation({
        projectDir: tempDir,
        taskRef,
        workspace,
        task: {
          title: "Pre Invocation Validation Unrecoverable",
          slugs: ["pre-invocation-validation-unrecoverable"],
        },
        taskStatus: "pending",
      }),
    ).rejects.toMatchObject({
      name: "DispatchWorkspaceError",
      message: expect.stringContaining("failure: missing"),
      suggestion: expect.stringContaining("retry dispatch"),
    } satisfies Partial<DispatchWorkspaceError>);
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-8
  // AC: @dispatch-runtime-bootstrap-contract ac-10
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  it("does not attempt recovery from an invalid canonical workspace record", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      ["dispatch:", "  base_branch: agent-dev"].join("\n"),
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 37)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: {
        title: "Pre Invocation Validation Invalid Record",
        slugs: ["pre-invocation-validation-invalid-record"],
      },
    });

    git(tempDir, `worktree remove --force "${workspace.cwd}"`);
    git(tempDir, `branch -D ${workspace.metadata.canonicalBranch}`);

    await expect(
      validateDispatchWorkspaceForInvocation({
        projectDir: tempDir,
        taskRef,
        workspace,
        task: {
          title: "Pre Invocation Validation Invalid Record",
          slugs: ["pre-invocation-validation-invalid-record"],
        },
        taskStatus: "pending",
      }),
    ).rejects.toMatchObject({
      name: "DispatchWorkspaceError",
      message: expect.stringContaining("no trustworthy canonical workspace record exists"),
      suggestion: expect.stringContaining("branch lineage"),
    } satisfies Partial<DispatchWorkspaceError>);
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-6
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  it("records actionable bootstrap failure detail and blocks the task before invocation", async () => {
    await seedRepo(tempDir);
    const notes: Array<{ taskRef: string; note: string }> = [];
    const blocks: Array<{ taskRef: string; reason: string }> = [];
    await setupProject(tempDir, {
      dispatchConfig: [
        "dispatch:",
        "  base_branch: agent-dev",
        "  bootstrap:",
        "    steps:",
        "      - run: exit 7",
      ].join("\n"),
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
      coalesceWindowMs: 0,
      taskBookkeeping: {
        addTaskNote: async (taskRef, note) => {
          notes.push({ taskRef, note });
        },
        blockTask: async (taskRef, reason) => {
          blocks.push({ taskRef, reason });
        },
      },
    });

    await engine.start();
    const taskId = testUlid("TASK", 26);
    const taskRef = `@${taskId}`;
    await engine.handleStateChange({
      taskId,
      taskRef,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: {
        _ulid: taskId,
        title: "Bootstrap Failure Blocks Task",
        slugs: ["bootstrap-failure-blocks-task"],
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

    for (let i = 0; i < 30 && blocks.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(runSpy).not.toHaveBeenCalled();
    expect(
      notes.some((note) => note.taskRef === taskRef && note.note.includes("Suggested action")),
    ).toBe(true);
    expect(blocks.some((block) => block.taskRef === taskRef)).toBe(true);

    const registryPath = path.join(tempDir, "project.dispatch-workspaces.yaml");
    const record = await readWorkspaceRecord(registryPath, taskRef);
    expect(record.bootstrap.roleStates.worker.status).toBe("failed");
    expect(record.bootstrap.roleStates.worker.failureMessage).toContain("exit code 7");

    await engine.stop();
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-6
  // AC: @trait-error-guidance ac-1
  it("preserves tail of bootstrap output so error detail at end of stream is captured", async () => {
    await seedRepo(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      [
        "dispatch:",
        "  base_branch: agent-dev",
        "  bootstrap:",
        "    steps:",
        "      - run: python3 -c \"import sys; sys.stdout.write('A' * 5000); sys.stderr.write('BOOTSTRAP_TAIL_SENTINEL_XYZ123'); sys.exit(1)\"",
      ].join("\n"),
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 36)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Bootstrap Tail Capture", slugs: ["bootstrap-tail-capture"] },
    });

    await expect(
      ensureWorkspaceBootstrap({
        projectDir: tempDir,
        workspaceDir: workspace.cwd,
        metadataPath: workspace.metadataPath,
        metadata: workspace.metadata,
        role: "worker",
        agent: makeAgent(),
        env: {},
      }),
    ).rejects.toThrow(DispatchBootstrapError);

    const record = await readWorkspaceRecord(workspace.metadataPath, taskRef);
    expect(record.bootstrap.roleStates.worker.status).toBe("failed");
    // The sentinel is at the end of the combined output (after 5000 chars of filler).
    // With a 4000-char tail slice, the sentinel must be preserved.
    expect(record.bootstrap.roleStates.worker.failureMessage).toContain(
      "BOOTSTRAP_TAIL_SENTINEL_XYZ123",
    );
    const failedStep = record.bootstrap.roleStates.worker.steps.find(
      (s: { status: string }) => s.status === "failed",
    );
    expect(failedStep).toBeDefined();
    expect(failedStep.output).toContain("BOOTSTRAP_TAIL_SENTINEL_XYZ123");
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-8
  // AC: @dispatch-runtime-bootstrap-contract ac-10
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  it("blocks the task instead of launching the agent when pre-invocation validation fails", async () => {
    await seedRepo(tempDir);
    const notes: Array<{ taskRef: string; note: string }> = [];
    const blocks: Array<{ taskRef: string; reason: string }> = [];
    await setupProject(tempDir, {
      dispatchConfig: ["dispatch:", "  base_branch: agent-dev"].join("\n"),
    });

    const validationSpy = vi.spyOn(workspaceModule, "validateDispatchWorkspaceForInvocation");
    validationSpy.mockRejectedValue(
      new DispatchWorkspaceError(
        'Pre-invocation workspace validation failed for @task at "/tmp/bad" (failure: not-runnable). Recovery attempt: none. Next action: inspect the workspace path before retrying.',
        "Inspect the workspace path before retrying dispatch.",
      ),
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
      taskBookkeeping: {
        addTaskNote: async (taskRef, note) => {
          notes.push({ taskRef, note });
        },
        blockTask: async (taskRef, reason) => {
          blocks.push({ taskRef, reason });
        },
      },
    });

    await engine.start();
    const taskId = testUlid("TASK", 35);
    const taskRef = `@${taskId}`;
    await engine.handleStateChange({
      taskId,
      taskRef,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: {
        _ulid: taskId,
        title: "Validation Failure Blocks Task",
        slugs: ["validation-failure-blocks-task"],
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

    for (let i = 0; i < 30 && blocks.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(runSpy).not.toHaveBeenCalled();
    expect(
      notes.some(
        (note) =>
          note.taskRef === taskRef &&
          note.note.includes("Pre-invocation workspace validation failed"),
      ),
    ).toBe(true);
    expect(blocks.some((block) => block.taskRef === taskRef)).toBe(true);

    await engine.stop();
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-11
  it("runs the declared command string without modification or addition by the dispatcher", async () => {
    await seedRepo(tempDir);
    const captureFile = path.join(tempDir, "bootstrap-fidelity-capture.txt");
    const declaredCommand = `printf '%s' "EXACT_COMMAND_STRING" > ${JSON.stringify(captureFile)}`;
    await setupProject(tempDir, {
      dispatchConfig: [
        "dispatch:",
        "  base_branch: agent-dev",
        "  bootstrap:",
        "    steps:",
        `      - run: ${declaredCommand}`,
      ].join("\n"),
    });

    const taskRef = `@${testUlid("TASK", 41)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Command Fidelity Test", slugs: ["command-fidelity-test"] },
    });

    const result = await ensureWorkspaceBootstrap({
      projectDir: tempDir,
      workspaceDir: workspace.cwd,
      metadataPath: workspace.metadataPath,
      metadata: workspace.metadata,
      role: "worker",
      agent: makeAgent(),
      env: {},
    });

    // Verify the command produced the expected output (proves it executed)
    await expect(readTestOutput(captureFile)).resolves.toBe("EXACT_COMMAND_STRING");
    // Verify the metadata recorded exactly the declared command — no prefix/suffix added
    expect(result.metadata.bootstrap.steps).toHaveLength(1);
    expect(result.metadata.bootstrap.steps[0].run).toBe(declaredCommand);
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-11
  it("produces zero spawns when no bootstrap steps are configured even for a Node-like workspace", async () => {
    await seedRepo(tempDir);
    await setupProject(tempDir, {
      dispatchConfig: ["dispatch:", "  base_branch: agent-dev"].join("\n"),
    });

    const taskRef = `@${testUlid("TASK", 42)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "No Steps Zero Spawns", slugs: ["no-steps-zero-spawns"] },
    });

    // Seed the workspace with Node project markers (package.json + lockfile).
    // If implicit bootstrap inference for package-based projects were
    // reintroduced, this workspace would trigger synthetic install/build
    // steps. With the inference removed, zero spawns must still result.
    await fs.writeFile(
      path.join(workspace.cwd, "package.json"),
      JSON.stringify({ name: "test-project", version: "1.0.0", scripts: { build: "echo ok" } }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(workspace.cwd, "package-lock.json"),
      JSON.stringify({ name: "test-project", lockfileVersion: 3, packages: {} }),
      "utf-8",
    );

    const result = await ensureWorkspaceBootstrap({
      projectDir: tempDir,
      workspaceDir: workspace.cwd,
      metadataPath: workspace.metadataPath,
      metadata: workspace.metadata,
      role: "worker",
      agent: makeAgent(),
      env: {},
    });

    expect(result.ranSteps).toBe(false);
    expect(result.metadata.bootstrap.steps).toEqual([]);
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-12
  it("strips daemon runtime mode env vars from bootstrap step subprocess environment", async () => {
    await seedRepo(tempDir);
    await setupProject(tempDir, {
      dispatchConfig: [
        "dispatch:",
        "  base_branch: agent-dev",
        "  bootstrap:",
        "    steps:",
        "      - run: mkdir -p .dispatch-cache && env > .dispatch-cache/env-dump.txt",
      ].join("\n"),
    });

    const taskRef = `@${testUlid("TASK", 43)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Env Isolation Test", slugs: ["env-isolation-test"] },
    });

    // Set all daemon runtime env keys on the current process to simulate
    // the daemon environment leaking into the dispatcher
    const savedEnv: Record<string, string | undefined> = {};
    for (const key of DAEMON_RUNTIME_MODE_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      process.env[key] = "test-sentinel-value";
    }

    try {
      await ensureWorkspaceBootstrap({
        projectDir: tempDir,
        workspaceDir: workspace.cwd,
        metadataPath: workspace.metadataPath,
        metadata: workspace.metadata,
        role: "worker",
        agent: makeAgent(),
        env: {},
      });

      const envDump = await readTestOutput(
        path.join(workspace.cwd, ".dispatch-cache", "env-dump.txt"),
      );
      const envLines = new Map(
        envDump
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => {
            const eqIndex = line.indexOf("=");
            return [line.slice(0, eqIndex), line.slice(eqIndex + 1)] as [string, string];
          }),
      );

      for (const key of DAEMON_RUNTIME_MODE_ENV_KEYS) {
        expect(envLines.has(key)).toBe(false);
      }
    } finally {
      for (const key of DAEMON_RUNTIME_MODE_ENV_KEYS) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    }
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-13
  it("preserves the declared order of bootstrap step commands", async () => {
    await seedRepo(tempDir);
    const orderFile = path.join(tempDir, "bootstrap-order.txt");
    await setupProject(tempDir, {
      dispatchConfig: [
        "dispatch:",
        "  base_branch: agent-dev",
        "  bootstrap:",
        "    steps:",
        `      - run: printf S1 >> ${JSON.stringify(orderFile)}`,
        "        name: step-1",
        `      - run: printf S2 >> ${JSON.stringify(orderFile)}`,
        "        name: step-2",
        `      - run: printf S3 >> ${JSON.stringify(orderFile)}`,
        "        name: step-3",
      ].join("\n"),
    });

    const taskRef = `@${testUlid("TASK", 44)}`;
    const workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Step Order Test", slugs: ["step-order-test"] },
    });

    await ensureWorkspaceBootstrap({
      projectDir: tempDir,
      workspaceDir: workspace.cwd,
      metadataPath: workspace.metadataPath,
      metadata: workspace.metadata,
      role: "worker",
      agent: makeAgent(),
      env: {},
    });

    await expect(readTestOutput(orderFile)).resolves.toBe("S1S2S3");
  });
});
