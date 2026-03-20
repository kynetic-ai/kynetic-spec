import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as YAML from "yaml";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import { DispatchEngine } from "../src/agent-runtime/dispatch.js";
import {
  ensureWorkspaceBootstrap,
  DispatchBootstrapError,
} from "../src/agent-runtime/bootstrap.js";
import { provisionDispatchWorkspace } from "../src/agent-runtime/workspace.js";
import type { Agent } from "../src/schema/meta.js";
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
    'kynetic: "1"\ntitle: Test Project\n',
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
        ? ["    bootstrap:", "      steps:", ...options.agentBootstrap.split("\n").map((line) => `        ${line}`)]
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

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
}

async function setupLocalFileDependencyProject(dir: string): Promise<void> {
  const dependencyDir = path.join(dir, "deps", "local-dep");
  await fs.mkdir(dependencyDir, { recursive: true });
  await fs.writeFile(
    path.join(dependencyDir, "package.json"),
    JSON.stringify({
      name: "local-dep",
      version: "1.0.0",
      main: "index.js",
    }, null, 2),
    "utf-8",
  );
  await fs.writeFile(path.join(dependencyDir, "index.js"), "module.exports = 'ok';\n", "utf-8");
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "dispatch-bootstrap-fixture",
      private: true,
      version: "1.0.0",
      dependencies: {
        "local-dep": "file:./deps/local-dep",
      },
    }, null, 2),
    "utf-8",
  );
  execSync("npm install --package-lock-only", {
    cwd: dir,
    stdio: "pipe",
    encoding: "utf-8",
  });
  git(dir, "add package.json package-lock.json deps/local-dep/package.json deps/local-dep/index.js");
  git(dir, 'commit -m "fixture: add local dependency bootstrap project"');
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

async function updateWorkspaceRecord(
  registryPath: string,
  taskRef: string,
  mutate: (workspace: Record<string, any>) => void,
): Promise<void> {
  const raw = YAML.parse(await fs.readFile(registryPath, "utf-8")) as {
    kynetic_dispatch_workspaces?: string;
    workspaces?: Array<Record<string, any>>;
  };
  const workspaces = raw.workspaces ?? [];
  const workspace = workspaces.find((entry) => entry.task_ref === taskRef);
  if (!workspace) {
    throw new Error(`Workspace record not found for ${taskRef}`);
  }
  mutate(workspace);
  await fs.writeFile(registryPath, YAML.stringify({
    kynetic_dispatch_workspaces: raw.kynetic_dispatch_workspaces ?? "1.0",
    workspaces,
  }), "utf-8");
}

describe("dispatch runtime bootstrap contract", () => {
  let tempDir: string;
  let originalCaptureFile: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-dispatch-bootstrap-");
    originalCaptureFile = process.env.KSPEC_CAPTURE_FILE;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalCaptureFile === undefined) {
      delete process.env.KSPEC_CAPTURE_FILE;
    } else {
      process.env.KSPEC_CAPTURE_FILE = originalCaptureFile;
    }
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

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (options) => {
      await expect(fs.readFile(path.join(options.cwd, ".dispatch-cache", "project.txt"), "utf-8")).resolves.toBe("project");
      await expect(fs.readFile(path.join(options.cwd, ".dispatch-cache", "agent.txt"), "utf-8")).resolves.toBe("agent");
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
      fs.readFile(path.join(workerWorkspace.cwd, ".dispatch-cache", "worker-only.txt"), "utf-8"),
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
      fs.readFile(path.join(reviewerWorkspace.cwd, ".dispatch-cache", "reviewer-ready.txt"), "utf-8"),
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
      fs.readFile(path.join(workerWorkspace.cwd, ".dispatch-cache", "worker-ready.txt"), "utf-8"),
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
  it("records explicit bootstrap invalidation reasons for config, head, and prior failure changes", async () => {
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
      task: { title: "Bootstrap Invalidation Signals", slugs: ["bootstrap-invalidation-signals"] },
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
      task: { title: "Bootstrap Invalidation Signals", slugs: ["bootstrap-invalidation-signals"] },
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
    expect(bootstrapped.metadata.bootstrap.invalidationReasons).toContain("bootstrap-config-changed");

    await fs.writeFile(path.join(workspace.cwd, "runtime.txt"), "runtime\n", "utf-8");
    git(workspace.cwd, "add runtime.txt");
    git(workspace.cwd, 'commit -m "runtime change"');
    workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Bootstrap Invalidation Signals", slugs: ["bootstrap-invalidation-signals"] },
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
    expect(bootstrapped.metadata.bootstrap.invalidationReasons).toContain("canonical-branch-head-changed");

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
    expect(bootstrapped.metadata.bootstrap.invalidationReasons).toContain("prior-bootstrap-failed");
  });

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
        "      - run: mkdir -p .dispatch-cache && count_file=.dispatch-cache/count && count=$(cat \"$count_file\" 2>/dev/null || echo 0) && echo $((count + 1)) > \"$count_file\"",
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
        bootstrap: (await readWorkspaceRecord(
          workspace.metadataPath,
          workspace.metadata.taskRef,
        )).bootstrap,
        bootstrapState: (await readWorkspaceRecord(
          workspace.metadataPath,
          workspace.metadata.taskRef,
        )).bootstrap,
      },
      role: "worker",
      agent: makeAgent(),
      env: {},
    });

    expect(reused.reused).toBe(true);
    await expect(
      fs.readFile(path.join(workspace.cwd, ".dispatch-cache", "count"), "utf-8"),
    ).resolves.toBe("1\n");
  });

  it("repairs missing direct dependencies before reusing a previously successful bootstrap", async () => {
    await seedRepo(tempDir);
    await setupLocalFileDependencyProject(tempDir);
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      [
        "dispatch:",
        "  base_branch: agent-dev",
      ].join("\n"),
      "utf-8",
    );

    const taskRef = `@${testUlid("TASK", 30)}`;
    let workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Dependency Repair Bootstrap", slugs: ["dependency-repair-bootstrap"] },
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
    await expect(
      fs.stat(path.join(workspace.cwd, "node_modules", "local-dep")),
    ).resolves.toBeTruthy();

    await fs.rm(path.join(workspace.cwd, "node_modules"), { recursive: true, force: true });

    workspace = await provisionDispatchWorkspace({
      projectDir: tempDir,
      taskRef,
      task: { title: "Dependency Repair Bootstrap", slugs: ["dependency-repair-bootstrap"] },
    });
    const record = await readWorkspaceRecord(workspace.metadataPath, taskRef);
    const repaired = await ensureWorkspaceBootstrap({
      projectDir: tempDir,
      workspaceDir: workspace.cwd,
      metadataPath: workspace.metadataPath,
      metadata: {
        ...workspace.metadata,
        bootstrap: record.bootstrap,
        bootstrapState: record.bootstrap,
      },
      role: "worker",
      agent: makeAgent(),
      env: {},
    });

    expect(repaired.reused).toBe(false);
    expect(repaired.ranSteps).toBe(true);
    expect(repaired.metadata.bootstrap.invalidationReasons).toContain("workspace-dependencies-missing");
    expect(
      repaired.metadata.bootstrap.steps.some((step) => step.name === "install-workspace-dependencies"),
    ).toBe(true);
    await expect(
      fs.stat(path.join(workspace.cwd, "node_modules", "local-dep")),
    ).resolves.toBeTruthy();
  });

  // AC: @dispatch-runtime-bootstrap-contract ac-6
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  it("records actionable bootstrap failure detail and blocks the task before invocation", async () => {
    await seedRepo(tempDir);
    const captureFile = path.join(tempDir, "captured-cli.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;
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

    for (let i = 0; i < 30; i++) {
      if ((await fs.stat(captureFile).catch(() => null)) !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(runSpy).not.toHaveBeenCalled();
    const calls = await readJson<Array<{ args: string[] }>>(captureFile);
    expect(calls.some((call) => call.args[0] === "task" && call.args[1] === "note" && call.args[3].includes("Suggested action"))).toBe(true);
    expect(calls.some((call) => call.args[0] === "task" && call.args[1] === "block")).toBe(true);

    const registryPath = path.join(tempDir, "project.dispatch-workspaces.yaml");
    const record = await readWorkspaceRecord(registryPath, taskRef);
    expect(record.bootstrap.roleStates.worker.status).toBe("failed");
    expect(record.bootstrap.roleStates.worker.failureMessage).toContain("exit code 7");

    await engine.stop();
  });
});
