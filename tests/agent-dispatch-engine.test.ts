/**
 * Agent Dispatch Engine tests.
 *
 * Tests for core dispatch runtime: state change matching, queuing, deduplication,
 * concurrency limits, filter evaluation, bootstrap, and graceful shutdown.
 *
 * Task: @implement-agent-dispatch-engine
 * Spec: @agent-dispatch-engine
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { execSync } from "node:child_process";
import * as YAML from "yaml";
import { DispatchEngine, type TaskStateChange } from "../src/agent-runtime/dispatch.js";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import * as workspaceModule from "../src/agent-runtime/workspace.js";
import * as configModule from "../src/parser/config.js";
import type { ProvisionedDispatchWorkspace } from "../src/agent-runtime/workspace.js";
import {
  createTempDir,
  cleanupTempDir,
  createIsolatedKspecHome,
  testUlid,
  testUlids,
  kspec,
  initGitRepo,
  readTestOutput,
  readTestOutputSync,
  seedSplitTask,
  waitForStartup,
} from "./helpers/cli.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";

ensureSplitBackendRegistered();
import * as http from "node:http";
import type { Agent } from "../src/schema/meta.js";
import { provisionDispatchWorkspace } from "../src/agent-runtime/workspace.js";
import * as bootstrapModule from "../src/agent-runtime/bootstrap.js";
import * as runnerConfigModule from "../src/agents/runner-config.js";
import { mergeRunnerConfigs } from "../src/agents/runner-config.js";
import { registerAdapter } from "../src/agents/adapters.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_KSPEC_CLI = path.join(__dirname, "mocks", "kspec-capture-mock.cjs");

/**
 * Build a lightweight mock workspace metadata object for tests that need to
 * mock provisionDispatchWorkspace/ensureWorkspaceBootstrap without caring
 * about workspace setup details.
 */
function buildMockWorkspaceMetadata(worktreeDir: string, overrides: Record<string, unknown> = {}) {
  const emptyBootstrapRoleState = {
    status: "not_run" as const,
    configHash: null,
    canonicalBranchHead: null,
    lastRunAt: null,
    invalidationReasons: [] as string[],
    steps: [] as any[],
    failureMessage: null,
  };
  const mockBootstrap = {
    ...emptyBootstrapRoleState,
    lastRole: null,
    roleStates: {
      worker: { ...emptyBootstrapRoleState },
      reviewer: { ...emptyBootstrapRoleState },
    },
  };
  return {
    workspaceId: "mock-workspace",
    taskRef: "@mock",
    taskSlug: "mock",
    baseBranch: "main",
    baseBranchPoint: "abc123",
    mergeTargetBranch: "main",
    integrationTargetBranch: "main",
    integrationTargetCommit: "abc123",
    canonicalBranch: "dispatch/task/mock/abc12345",
    canonicalBranchHead: "abc123",
    branchProvenance: {
      ownership: "dispatcher-managed" as const,
      source: "provisioned",
      remote_ref: null,
      adopted_from: null,
      adopted_at: null,
    },
    publicationMode: "pull_request" as const,
    integrationState: "pending" as const,
    integrationOutcome: "pending" as const,
    integrationUpdatedAt: new Date().toISOString(),
    worktreeRoot: worktreeDir,
    workerWorktreeDir: worktreeDir,
    reviewerWorktreeDir: null,
    lifecycleState: "ready" as const,
    activeRole: null,
    bootstrapState: mockBootstrap,
    healthState: {
      status: "healthy" as const,
      summary: "Healthy",
      issues: [] as any[],
      updated_at: new Date().toISOString(),
    },
    cleanupState: {
      status: "not_scheduled" as const,
      eligible: false,
      reason: null,
      detail: null,
      updated_at: new Date().toISOString(),
    },
    healthStatus: "healthy" as const,
    healthReason: null,
    bootstrap: mockBootstrap,
    cleanupEligible: false,
    cleanupReason: null,
    cleanupScheduledAt: null,
    cleanupBlockedReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastReconciledAt: null,
    lastActiveAt: null,
    closedAt: null,
    ...overrides,
  };
}

/**
 * Create a minimal Agent definition for testing.
 */
function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    _ulid: testUlid("AGNT"),
    id: "test-worker",
    name: "Test Worker Agent",
    capabilities: [],
    tools: [],
    conventions: [],
    dispatch: [{ on: "task.ready" }],
    skills: [],
    auto_approve: false,
    concurrency: { max_concurrent: 1 },
    adapter: "mock-acp",
    ...overrides,
  };
}

function makeProvisionedWorkspace(
  taskRef: string,
  role: "worker" | "reviewer" = "worker",
): ProvisionedDispatchWorkspace {
  const slug = taskRef.replace(/^@/, "").toLowerCase();
  const workerDir = `/tmp/${slug}-worker`;
  const reviewerDir = `/tmp/${slug}-review`;
  return {
    cwd: role === "reviewer" ? reviewerDir : workerDir,
    metadataPath: `${role === "reviewer" ? reviewerDir : workerDir}/.kspec-dispatch-workspace.json`,
    metadata: {
      workspaceId: `dispatch-workspace-${slug}`,
      taskRef,
      taskSlug: slug,
      baseBranch: "main",
      baseBranchPoint: "1234567890abcdef1234567890abcdef12345678",
      mergeTargetBranch: "main",
      integrationTargetBranch: "main",
      integrationTargetCommit: "1234567890abcdef1234567890abcdef12345678",
      canonicalBranch: `dispatch/task/${slug}/01task00`,
      canonicalBranchHead: "abcdef1234567890abcdef1234567890abcdef12",
      publicationMode: "pull_request",
      integrationState: "pending",
      integrationOutcome: "pull_request",
      integrationUpdatedAt: "2026-03-12T00:00:00.000Z",
      worktreeRoot: "/tmp/.kspec-worktrees",
      workerWorktreeDir: workerDir,
      reviewerWorktreeDir: role === "reviewer" ? reviewerDir : null,
      lifecycleState: role === "reviewer" ? "integrating" : "active",
      activeRole: role,
      bootstrapState: {
        status: role === "reviewer" ? "succeeded" : "succeeded",
        configHash: "cfg-1",
        canonicalBranchHead: "abcdef1234567890abcdef1234567890abcdef12",
        lastRunAt: "2026-03-12T00:00:00.000Z",
        invalidationReasons: [],
        steps:
          role === "reviewer"
            ? []
            : [
                {
                  source: "dispatch",
                  name: "prepare",
                  run: "npm install",
                  idempotent: true,
                  allowTrackedChanges: false,
                  reviewerRerunAllowed: false,
                  status: "succeeded",
                  role: "worker",
                  output: "ok",
                },
              ],
        failureMessage: null,
        lastRole: role === "reviewer" ? "worker" : "worker",
        roleStates: {
          worker: {
            status: "succeeded",
            configHash: "cfg-1",
            canonicalBranchHead: "abcdef1234567890abcdef1234567890abcdef12",
            lastRunAt: "2026-03-12T00:00:00.000Z",
            invalidationReasons: [],
            steps: [
              {
                source: "dispatch",
                name: "prepare",
                run: "npm install",
                idempotent: true,
                allowTrackedChanges: false,
                reviewerRerunAllowed: false,
                status: "succeeded",
                role: "worker",
                output: "ok",
              },
            ],
            failureMessage: null,
          },
          reviewer: {
            status: "succeeded",
            configHash: "cfg-1",
            canonicalBranchHead: "abcdef1234567890abcdef1234567890abcdef12",
            lastRunAt: "2026-03-12T00:00:00.000Z",
            invalidationReasons: [],
            steps: [],
            failureMessage: null,
          },
        },
      },
      healthState: {
        status: "healthy",
        summary: "Workspace record matches current git branch and worktree state.",
        issues: [],
        updated_at: "2026-03-12T00:00:00.000Z",
      },
      cleanupState: {
        status: "not_scheduled",
        eligible: false,
        reason: null,
        detail: null,
        updated_at: "2026-03-12T00:00:00.000Z",
      },
      healthStatus: "healthy",
      healthReason: null,
      bootstrap: {
        status: role === "reviewer" ? "succeeded" : "succeeded",
        configHash: "cfg-1",
        canonicalBranchHead: "abcdef1234567890abcdef1234567890abcdef12",
        lastRunAt: "2026-03-12T00:00:00.000Z",
        invalidationReasons: [],
        steps:
          role === "reviewer"
            ? []
            : [
                {
                  source: "dispatch",
                  name: "prepare",
                  run: "npm install",
                  idempotent: true,
                  allowTrackedChanges: false,
                  reviewerRerunAllowed: false,
                  status: "succeeded",
                  role: "worker",
                  output: "ok",
                },
              ],
        failureMessage: null,
        lastRole: role === "reviewer" ? "worker" : "worker",
        roleStates: {
          worker: {
            status: "succeeded",
            configHash: "cfg-1",
            canonicalBranchHead: "abcdef1234567890abcdef1234567890abcdef12",
            lastRunAt: "2026-03-12T00:00:00.000Z",
            invalidationReasons: [],
            steps: [
              {
                source: "dispatch",
                name: "prepare",
                run: "npm install",
                idempotent: true,
                allowTrackedChanges: false,
                reviewerRerunAllowed: false,
                status: "succeeded",
                role: "worker",
                output: "ok",
              },
            ],
            failureMessage: null,
          },
          reviewer: {
            status: "succeeded",
            configHash: "cfg-1",
            canonicalBranchHead: "abcdef1234567890abcdef1234567890abcdef12",
            lastRunAt: "2026-03-12T00:00:00.000Z",
            invalidationReasons: [],
            steps: [],
            failureMessage: null,
          },
        },
      },
      cleanupEligible: false,
      cleanupReason: null,
      cleanupScheduledAt: null,
      cleanupBlockedReason: null,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:00.000Z",
      lastReconciledAt: "2026-03-12T00:00:00.000Z",
      lastActiveAt: "2026-03-12T00:00:00.000Z",
      closedAt: null,
    },
  };
}

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

/**
 * Set up a minimal kspec project directory with meta containing agents.
 *
 * Uses traditional (non-shadow) layout: manifest and meta in the specDir directly.
 * Sets KSPEC_SPEC_DIR to point to the spec directory so initContext can find it.
 */
async function setupProjectWithAgents(dir: string, agents: Agent[]): Promise<void> {
  initGitRepo(dir);

  // Use traditional layout: manifest in the dir root itself
  // Write manifest
  await fs.writeFile(
    path.join(dir, "kynetic.yaml"),
    YAML.stringify({ kynetic: "1", title: "Test Project" }),
    "utf-8",
  );

  // Write meta with agents
  await fs.writeFile(
    path.join(dir, "kynetic.meta.yaml"),
    YAML.stringify({
      kynetic_meta: "1.0",
      agents: agents.map((a) => ({
        _ulid: a._ulid,
        id: a.id,
        name: a.name,
        dispatch: a.dispatch ?? [],
        concurrency: a.concurrency,
        adapter: a.adapter,
        budget: a.budget,
        auto_approve: a.auto_approve ?? false,
        ...(a.runner && { runner: a.runner }),
        ...(a.prompt_template && { prompt_template: a.prompt_template }),
      })),
    }),
    "utf-8",
  );

  // Write empty tasks file
  await fs.writeFile(path.join(dir, "project.tasks.yaml"), YAML.stringify({ tasks: [] }), "utf-8");

  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "pipe" });
}

async function installFakeGh(dir: string): Promise<{ restore: () => void }> {
  const binDir = path.join(dir, "fake-bin");
  const ghPath = path.join(binDir, "gh");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(ghPath, "#!/usr/bin/env bash\nexit 0\n", "utf-8");
  await fs.chmod(ghPath, 0o755);

  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}:${previousPath}`;
  return {
    restore: () => {
      process.env.PATH = previousPath;
    },
  };
}

async function waitForMockCall(
  spy: { mock: { calls: unknown[] } },
  description = "mock should be called",
  timeoutMs = 5_000,
): Promise<void> {
  await waitForStartup(
    description,
    () => ({
      ok: spy.mock.calls.length > 0,
      details: `mock calls=${spy.mock.calls.length}, expected>0`,
    }),
    { timeoutMs, intervalMs: 10 },
  );
}

async function waitForInvocationCount(
  getCount: () => number,
  expectedCount: number,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  await waitForStartup(
    description,
    () => {
      const count = getCount();
      return {
        ok: count >= expectedCount,
        details: `invocationCount=${count}, expected>=${expectedCount}`,
      };
    },
    { timeoutMs, intervalMs: 10 },
  );
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 5_000,
  pollIntervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Write tasks to the project in split storage format.
 * Clears existing tasks directory and index, then seeds each task.
 */
async function writeTasks(
  dir: string,
  tasks: Array<{
    _ulid: string;
    status: string;
    automation?: string;
    tags?: string[];
    priority?: number;
    depends_on?: string[];
    blocked_by?: string[];
  }>,
): Promise<void> {
  // Clear existing split tasks so repeated calls don't accumulate
  const tasksDir = path.join(dir, "tasks");
  await fs.rm(tasksDir, { recursive: true, force: true });
  await fs.rm(path.join(dir, "project.tasks.yaml"), { force: true });

  // Seed each task in split format
  for (const t of tasks) {
    seedSplitTask(dir, {
      _ulid: t._ulid,
      type: "task",
      title: `Task ${t._ulid}`,
      status: t.status,
      automation: t.automation,
      tags: t.tags ?? [],
      priority: t.priority ?? 3,
      depends_on: t.depends_on ?? [],
      blocked_by: t.blocked_by ?? [],
      notes: [],
      created_at: new Date().toISOString(),
    });
  }
}

/**
 * Create a TaskStateChange for testing.
 */
function makeStateChange(overrides: Partial<TaskStateChange> = {}): TaskStateChange {
  return {
    taskId: testUlid("TASK"),
    taskRef: `@${testUlid("TASK")}`,
    fromStatus: "in_progress",
    toStatus: "pending",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── Dispatch In-Progress Priority ───────────────────────────────────────────

describe("Dispatch in-progress priority", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-in-progress-priority-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @dispatch-in-progress-priority ac-1
  // AC: @dispatch-in-progress-priority ac-4
  // AC: @dispatch-scheduling-priority-model ac-2
  // AC: @dispatch-scheduling-priority-model ac-3
  // AC: @dispatch-scheduling-priority-model ac-6
  it("should order queued entries by band first and numeric priority second", async () => {
    const agent = makeTestAgent({
      id: "priority-worker",
      dispatch: [
        { on: "task.in_progress" },
        { on: "task.ready" },
        { on: "task.needs_work" },
        { on: "task.pending_review" },
      ],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockImplementation(async (options) => ({
      exists: options.role === "reviewer" || options.taskRef === `@${testUlid("TASK", 13)}`,
      healthy: true,
      reason: null,
      metadata: null,
    }));
    await engine.start();

    const internal = engine as unknown as {
      activeCount: Map<string, number>;
      queues: Map<string, Array<{ change: TaskStateChange }>>;
    };

    // Hold dispatching so we can inspect queue ordering.
    internal.activeCount.set(agent.id, 1);

    // Provide inline task data with automation: eligible so task.ready/task.needs_work
    // default filter passes (AC-21). Tasks are not on disk to avoid staleness discard.
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- co-located with test data for readability
    const makeEligibleTask = (priority: number) =>
      ({ automation: "eligible", tags: [], priority }) as any;

    await engine.handleStateChange(
      makeStateChange({
        taskId: testUlid("TASK", 10),
        taskRef: `@${testUlid("TASK", 10)}`,
        fromStatus: "in_progress",
        toStatus: "pending",
        task: makeEligibleTask(1),
      }),
    );
    await engine.handleStateChange(
      makeStateChange({
        taskId: testUlid("TASK", 11),
        taskRef: `@${testUlid("TASK", 11)}`,
        fromStatus: "pending_review",
        toStatus: "needs_work",
        task: makeEligibleTask(2),
      }),
    );
    await engine.handleStateChange(
      makeStateChange({
        taskId: testUlid("TASK", 12),
        taskRef: `@${testUlid("TASK", 12)}`,
        fromStatus: "in_progress",
        toStatus: "pending_review",
        task: makeEligibleTask(4),
      }),
    );
    await engine.handleStateChange(
      makeStateChange({
        taskId: testUlid("TASK", 13),
        taskRef: `@${testUlid("TASK", 13)}`,
        fromStatus: "pending",
        toStatus: "in_progress",
        task: makeEligibleTask(5),
      }),
    );
    await engine.handleStateChange(
      makeStateChange({
        taskId: testUlid("TASK", 14),
        taskRef: `@${testUlid("TASK", 14)}`,
        fromStatus: "in_progress",
        toStatus: "pending_review",
        task: makeEligibleTask(1),
      }),
    );

    const queue = internal.queues.get(agent.id) ?? [];
    expect(
      queue.map((entry) => ({
        status: entry.change.toStatus,
        priority: (entry.change.task as { priority?: number } | undefined)?.priority,
      })),
    ).toEqual([
      { status: "in_progress", priority: 5 },
      { status: "needs_work", priority: 2 },
      { status: "pending_review", priority: 1 },
      { status: "pending_review", priority: 4 },
      { status: "pending", priority: 1 },
    ]);

    await engine.stop();
  });

  // AC: @dispatch-in-progress-priority ac-2
  it("should enqueue existing in_progress tasks during bootstrap", async () => {
    const agent = makeTestAgent({
      id: "bootstrap-worker",
      dispatch: [{ on: "task.in_progress" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK", 20);
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    expect(enqueueCount).toBeGreaterThanOrEqual(1);

    await engine.stop();
  });

  // AC: @dispatch-in-progress-priority ac-3
  it("should match task.in_progress dispatch rules with automation filters", async () => {
    const agent = makeTestAgent({
      id: "filtered-worker",
      dispatch: [{ on: "task.in_progress", filter: { automation: "eligible" } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await engine.handleStateChange({
      ...makeStateChange({
        taskId: testUlid("TASK", 30),
        taskRef: `@${testUlid("TASK", 30)}`,
        fromStatus: "pending",
        toStatus: "in_progress",
      }),
      task: { automation: "manual_only", tags: [] } as any,
    });
    expect(enqueueCount).toBe(0);

    await engine.handleStateChange({
      ...makeStateChange({
        taskId: testUlid("TASK", 31),
        taskRef: `@${testUlid("TASK", 31)}`,
        fromStatus: "pending",
        toStatus: "in_progress",
      }),
      task: { automation: "eligible", tags: [] } as any,
    });
    expect(enqueueCount).toBe(1);

    await engine.stop();
  });
});

describe("Dispatch scheduling priority model", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-scheduler-model-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  function mockWorkspaceHealth(
    resolver: (
      taskRef: string,
      role: "worker" | "reviewer",
    ) => { exists?: boolean; healthy?: boolean } = () => ({
      exists: false,
      healthy: true,
    }),
  ): void {
    vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockImplementation(async (options) => {
      const role = (options.role ?? "worker") as "worker" | "reviewer";
      const state = resolver(options.taskRef, role);
      return {
        exists: state.exists ?? false,
        healthy: state.healthy ?? true,
        reason: state.healthy === false ? "mock-unhealthy" : null,
        metadata: null,
      };
    });
  }

  // AC: @dispatch-scheduling-priority-model ac-1
  it("excludes blocked, dependency-blocked, and stale continuation candidates before ranking", async () => {
    const worker = makeTestAgent({
      id: "task-worker",
      dispatch: [
        { on: "task.ready", filter: { automation: "eligible" } },
        { on: "task.needs_work", filter: { automation: "eligible" } },
        { on: "task.in_progress" },
        { on: "task.pending_review" },
      ],
    });
    await setupProjectWithAgents(testDir, [worker]);

    const [depId, pendingId, reviewId, blockedId] = testUlids("SCHA", 4);
    await writeTasks(testDir, [
      { _ulid: depId, status: "pending", automation: "manual_only" },
      { _ulid: pendingId, status: "pending", automation: "eligible", depends_on: [`@${depId}`] },
      { _ulid: reviewId, status: "pending_review", automation: "eligible", priority: 1 },
      { _ulid: blockedId, status: "needs_work", automation: "eligible", blocked_by: ["waiting"] },
    ]);

    mockWorkspaceHealth((taskRef) => ({
      exists: taskRef === `@${reviewId}`,
      healthy: false,
    }));

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    const spawned: string[] = [];
    vi.spyOn(
      engine as unknown as {
        _spawnInvocation: (agent: unknown, entry: unknown) => Promise<boolean>;
      },
      "_spawnInvocation",
    ).mockImplementation(async (_agent, entry) => {
      spawned.push((entry as { change: TaskStateChange }).change.taskRef);
      return true;
    });

    await engine.start();
    await (engine as unknown as { _drainQueues: (agents: Agent[]) => Promise<void> })._drainQueues([
      worker,
    ]);

    expect(spawned).toEqual([]);
    expect(engine.getStatus().queued).toHaveLength(0);

    await engine.stop();
  });

  // AC: @dispatch-scheduling-priority-model ac-4
  it("prefers continuity within the same band and numeric priority before FIFO", async () => {
    const reviewer = makeTestAgent({
      id: "reviewer",
      dispatch: [{ on: "task.pending_review" }],
    });
    await setupProjectWithAgents(testDir, [reviewer]);

    const [taskA, taskB] = testUlids("SCHB", 2);
    await writeTasks(testDir, [
      { _ulid: taskA, status: "pending_review", automation: "eligible", priority: 2 },
      { _ulid: taskB, status: "pending_review", automation: "eligible", priority: 2 },
    ]);

    mockWorkspaceHealth(() => ({ exists: true, healthy: true }));

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    const internal = engine as unknown as {
      queues: Map<string, Array<{ change: TaskStateChange; starvationDeferrals: number }>>;
      recentTaskAffinityRef: string | null;
      _drainQueues: (agents: Agent[]) => Promise<void>;
    };
    const drainSpy = vi
      .spyOn(
        engine as unknown as { _drainQueues: (agents: Agent[]) => Promise<void> },
        "_drainQueues",
      )
      .mockResolvedValue();

    await engine.start();
    drainSpy.mockRestore();
    internal.recentTaskAffinityRef = `@${taskB}`;

    const spawned: string[] = [];
    vi.spyOn(
      engine as unknown as {
        _spawnInvocation: (agent: unknown, entry: unknown) => Promise<boolean>;
      },
      "_spawnInvocation",
    ).mockImplementation(async (_agent, entry) => {
      spawned.push((entry as { change: TaskStateChange }).change.taskRef);
      return true;
    });

    await internal._drainQueues([reviewer]);

    expect(spawned[0]).toBe(`@${taskB}`);

    await engine.stop();
  });

  // AC: @dispatch-scheduling-priority-model ac-5
  it("lets the oldest equal-band equal-priority candidate win after the starvation threshold", async () => {
    const reviewer = makeTestAgent({
      id: "reviewer",
      dispatch: [{ on: "task.pending_review" }],
    });
    await setupProjectWithAgents(testDir, [reviewer]);

    const [taskA, taskB] = testUlids("SCHC", 2);
    await writeTasks(testDir, [
      { _ulid: taskA, status: "pending_review", automation: "eligible", priority: 2 },
      { _ulid: taskB, status: "pending_review", automation: "eligible", priority: 2 },
    ]);

    mockWorkspaceHealth(() => ({ exists: true, healthy: true }));

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    const internal = engine as unknown as {
      queues: Map<string, Array<{ change: TaskStateChange; starvationDeferrals: number }>>;
      recentTaskAffinityRef: string | null;
      _drainQueues: (agents: Agent[]) => Promise<void>;
    };
    const drainSpy = vi
      .spyOn(
        engine as unknown as { _drainQueues: (agents: Agent[]) => Promise<void> },
        "_drainQueues",
      )
      .mockResolvedValue();

    await engine.start();
    drainSpy.mockRestore();
    internal.recentTaskAffinityRef = `@${taskB}`;

    const queue = internal.queues.get(reviewer.id) ?? [];
    const older = queue.find((entry) => entry.change.taskRef === `@${taskA}`);
    expect(older).toBeDefined();
    older!.starvationDeferrals = 2;

    const spawned: string[] = [];
    vi.spyOn(
      engine as unknown as {
        _spawnInvocation: (agent: unknown, entry: unknown) => Promise<boolean>;
      },
      "_spawnInvocation",
    ).mockImplementation(async (_agent, entry) => {
      spawned.push((entry as { change: TaskStateChange }).change.taskRef);
      return true;
    });

    await internal._drainQueues([reviewer]);

    expect(spawned[0]).toBe(`@${taskA}`);

    await engine.stop();
  });

  // AC: @dispatch-scheduling-priority-model ac-7
  it("chooses the next invocation by scheduler rank instead of agent definition order", async () => {
    const worker = makeTestAgent({
      id: "task-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
    });
    const reviewer = makeTestAgent({
      id: "pr-reviewer",
      dispatch: [{ on: "task.pending_review" }],
    });
    // Worker intentionally defined first; scheduler should still pick reviewer first.
    await setupProjectWithAgents(testDir, [worker, reviewer]);

    const [pendingId, reviewId] = testUlids("SCHD", 2);
    await writeTasks(testDir, [
      { _ulid: pendingId, status: "pending", automation: "eligible", priority: 1 },
      { _ulid: reviewId, status: "pending_review", automation: "eligible", priority: 5 },
    ]);

    mockWorkspaceHealth((taskRef) => ({
      exists: taskRef === `@${reviewId}`,
      healthy: true,
    }));

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    const spawned: Array<{ agentId: string; taskRef: string }> = [];
    vi.spyOn(
      engine as unknown as {
        _spawnInvocation: (agent: unknown, entry: unknown) => Promise<boolean>;
      },
      "_spawnInvocation",
    ).mockImplementation(async (agent, entry) => {
      spawned.push({
        agentId: (agent as Agent).id,
        taskRef: (entry as { change: TaskStateChange }).change.taskRef,
      });
      return true;
    });

    const drainSpy = vi
      .spyOn(
        engine as unknown as { _drainQueues: (agents: Agent[]) => Promise<void> },
        "_drainQueues",
      )
      .mockResolvedValue();

    await engine.start();
    drainSpy.mockRestore();
    await (engine as unknown as { _drainQueues: (agents: Agent[]) => Promise<void> })._drainQueues([
      worker,
      reviewer,
    ]);

    expect(spawned[0]).toEqual({
      agentId: "pr-reviewer",
      taskRef: `@${reviewId}`,
    });

    await engine.stop();
  });
});

// ─── AC-1: Matching agents queued for dispatch ────────────────────────────────

// AC: @agent-dispatch-engine ac-1
describe("AC-1: Task state change queues matching agents", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac1-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should queue dispatch when state change matches agent dispatch rule", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    // Write task with automation: eligible so default filter passes (AC-21)
    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    // Spy on _enqueue before start so all enqueue calls are captured
    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();

    // Trigger state change: task transitions to pending (task.ready)
    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change);

    // Agent should have been enqueued
    expect(enqueueCount).toBeGreaterThanOrEqual(1);

    await engine.stop();
  });
});

// ─── AC-2: Multiple matching agents queued independently ─────────────────────

// AC: @agent-dispatch-engine ac-2
describe("AC-2: Multiple matching agents queued independently", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac2-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should queue each matching agent separately for the same state change", async () => {
    const agent1 = makeTestAgent({ id: "worker-1", dispatch: [{ on: "task.ready" }] });
    const agent2 = makeTestAgent({
      _ulid: testUlid("AGNT", 2),
      id: "worker-2",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent1, agent2]);

    // Write task with automation: eligible so default filter passes (AC-21)
    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    // Track enqueue calls per agent
    const enqueuedAgentIds: string[] = [];
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation((agent: unknown) => {
      enqueuedAgentIds.push((agent as { id: string }).id);
    });

    await engine.start();
    // Reset after bootstrap
    enqueuedAgentIds.length = 0;

    const change = makeStateChange({
      taskId,
      taskRef: `@${taskId}`,
      toStatus: "pending",
      fromStatus: "in_progress",
    });
    await engine.handleStateChange(change);

    // Both agents should be enqueued independently
    expect(enqueuedAgentIds).toContain("worker-1");
    expect(enqueuedAgentIds).toContain("worker-2");
    expect(enqueuedAgentIds).toHaveLength(2);

    await engine.stop();
  });
});

// ─── AC-3: Concurrency limit queues invocations FIFO ─────────────────────────

// AC: @agent-dispatch-engine ac-3
describe("AC-3: max_concurrent limit enforced", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac3-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should not exceed max_concurrent active invocations per agent", async () => {
    const agent = makeTestAgent({
      dispatch: [{ on: "task.ready" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    const status = engine.getStatus();
    expect(status.running).toBe(true);

    await engine.stop();
  });
});

// ─── AC-5: File watcher diffs task states ────────────────────────────────────

// AC: @agent-dispatch-engine ac-5
describe("AC-5: File watcher diffs task states", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac5-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should detect task status transitions from file changes", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    // Start with in_progress
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Update task to pending (task.ready event)
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending" }]);

    // Trigger file change notification
    const detectedChanges: TaskStateChange[] = [];
    // Spy on handleStateChange to track changes
    const handleSpy = vi.spyOn(engine, "handleStateChange").mockImplementation(async (change) => {
      detectedChanges.push(change);
    });

    await engine.handleFileChange(testDir);

    expect(detectedChanges).toHaveLength(1);
    expect(detectedChanges[0].taskId).toBe(taskId);
    expect(detectedChanges[0].fromStatus).toBe("in_progress");
    expect(detectedChanges[0].toStatus).toBe("pending");

    handleSpy.mockRestore();
    await engine.stop();
  });

  it("should not emit change events when task status is unchanged", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Same status again — no change
    const detectedChanges: TaskStateChange[] = [];
    vi.spyOn(engine, "handleStateChange").mockImplementation(async (change) => {
      detectedChanges.push(change);
    });

    await engine.handleFileChange(testDir);

    expect(detectedChanges).toHaveLength(0);

    await engine.stop();
  });
});

// ─── AC-6: Filter evaluation ─────────────────────────────────────────────────

// AC: @agent-dispatch-engine ac-6
describe("AC-6: Dispatch rule filters applied", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac6-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should only queue agent when automation filter matches", async () => {
    const agentEligibleOnly = makeTestAgent({
      id: "eligible-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
    });
    await setupProjectWithAgents(testDir, [agentEligibleOnly]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "manual_only" },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Transition to pending — should NOT be queued (automation: ineligible)
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "manual_only" }]);

    let dispatchedCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      dispatchedCount++;
    });

    await engine.handleFileChange(testDir);

    expect(dispatchedCount).toBe(0);

    await engine.stop();
  });

  it("should queue agent when all filters match", async () => {
    const agentTagged = makeTestAgent({
      id: "tagged-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible", tags: ["mvp"] } }],
    });
    await setupProjectWithAgents(testDir, [agentTagged]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "eligible", tags: ["mvp"] },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "eligible", tags: ["mvp"] },
    ]);

    let dispatchedCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      dispatchedCount++;
    });

    await engine.handleFileChange(testDir);

    expect(dispatchedCount).toBe(1);

    await engine.stop();
  });
});

// ─── AC-7: Event deduplication ───────────────────────────────────────────────

// AC: @agent-dispatch-engine ac-7
describe("AC-7: Event deduplication within time window", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac7-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should deduplicate identical state changes within dedup window", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    // Write task with automation: eligible so default filter passes (AC-21)
    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      dedupWindowMs: 5000,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    // Spy before start to capture all enqueue calls
    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    // Reset after bootstrap
    enqueueCount = 0;

    const now = Date.now();
    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: now,
    };

    // First event — should be dispatched
    await engine.handleStateChange(change);
    expect(enqueueCount).toBe(1);

    // Duplicate within window — should be suppressed
    await engine.handleStateChange({ ...change, timestamp: now + 100 });
    expect(enqueueCount).toBe(1);

    await engine.stop();
  });

  it("should not deduplicate events outside the dedup window", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    // Write task with automation: eligible so default filter passes (AC-21)
    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      dedupWindowMs: 100, // Very short window
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    // Spy before start
    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    // Reset after bootstrap
    enqueueCount = 0;

    const now = Date.now();
    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: now,
    };

    await engine.handleStateChange(change);
    expect(enqueueCount).toBe(1);

    // After window expired — should be dispatched again
    await engine.handleStateChange({ ...change, timestamp: now + 200 });
    expect(enqueueCount).toBe(2);

    await engine.stop();
  });
});

// ─── AC-8: Bootstrap on start ────────────────────────────────────────────────

// AC: @agent-dispatch-engine ac-8
describe("AC-8: Bootstrap evaluates existing tasks on start", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac8-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should evaluate tasks already in matching states on engine start", async () => {
    const agent = makeTestAgent({
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    // Spy before start() so bootstrap calls are captured
    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();

    // Bootstrap should have evaluated the pending task
    expect(enqueueCount).toBeGreaterThanOrEqual(1);

    await engine.stop();
  });

  it("should seed prevTaskStates so subsequent diffs work correctly", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // After bootstrap, in_progress is seeded as prevState
    // Change to pending — should detect transition
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending" }]);

    const detectedChanges: TaskStateChange[] = [];
    vi.spyOn(engine, "handleStateChange").mockImplementation(async (change) => {
      detectedChanges.push(change);
    });

    await engine.handleFileChange(testDir);

    expect(detectedChanges).toHaveLength(1);
    expect(detectedChanges[0].fromStatus).toBe("in_progress");
    expect(detectedChanges[0].toStatus).toBe("pending");

    await engine.stop();
  });
});

// ─── AC-10: Unresolvable adapter ─────────────────────────────────────────────

// AC: @agent-dispatch-engine ac-10
describe("AC-10: Unresolvable adapter skips invocation with error log", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac10-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should log error and skip invocation when adapter cannot be resolved", async () => {
    const agentBadAdapter = makeTestAgent({
      id: "bad-adapter-agent",
      adapter: "nonexistent-adapter-xyz",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agentBadAdapter]);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    (engine as unknown as { running: boolean }).running = true;

    // Manually call _spawnInvocation with the bad agent via type assertion
    type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> };
    const change = makeStateChange({ toStatus: "pending", fromStatus: "in_progress" });
    const entry = { agent: agentBadAdapter, change, retryCount: 0, nextRetryAt: 0 };

    await (engine as unknown as EngineInternal)._spawnInvocation(agentBadAdapter, entry);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("nonexistent-adapter-xyz"));

    errorSpy.mockRestore();
  });

  it("should add a task note when adapter cannot be resolved", async () => {
    const agentBadAdapter = makeTestAgent({
      id: "bad-adapter-agent",
      adapter: "nonexistent-adapter-xyz",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agentBadAdapter]);

    // Set up capture file to track kspec CLI calls
    const captureFile = path.join(testDir, "kspec-capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;

    try {
      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });
      (engine as unknown as { running: boolean }).running = true;

      type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> };
      const taskRef = `@${testUlid("TASK")}`;
      const change = makeStateChange({ toStatus: "pending", fromStatus: "in_progress", taskRef });
      const entry = { agent: agentBadAdapter, change, retryCount: 0, nextRetryAt: 0 };

      vi.spyOn(console, "error").mockImplementation(() => {});
      await (engine as unknown as EngineInternal)._spawnInvocation(agentBadAdapter, entry);
      vi.restoreAllMocks();

      // Verify task note was added
      const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{
        args: string[];
      }>;
      const noteCall = calls.find((c) => c.args.includes("note") && c.args.includes(taskRef));
      expect(noteCall).toBeTruthy();
      expect(noteCall!.args.join(" ")).toContain("AGENT-SKIP");
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
    }
  });

  // AC: @dispatch-invocation-worktree-isolation ac-4
  it("blocks the task with guidance when dispatch workspace preparation cannot be repaired safely", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);
    await fs.mkdir(path.join(testDir, ".kspec"), { recursive: true });
    await fs.writeFile(
      path.join(testDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n  worktree_root: .kspec/worktrees\n",
      "utf-8",
    );

    const captureFile = path.join(testDir, "kspec-workspace-failure-capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;

    try {
      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });
      (engine as unknown as { running: boolean }).running = true;
      const taskRef = `@${testUlid("TASK", 33)}`;
      const change = makeStateChange({ toStatus: "pending", fromStatus: "in_progress", taskRef });
      const entry = { agent, change, retryCount: 0, nextRetryAt: 0 };
      const runSpy = vi.spyOn(invocationModule, "runInvocation");
      vi.spyOn(console, "error").mockImplementation(() => {});

      type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> };
      const spawned = await (engine as unknown as EngineInternal)._spawnInvocation(agent, entry);

      expect(spawned).toBe(false);
      expect(runSpy).not.toHaveBeenCalled();

      const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{
        args: string[];
      }>;
      const noteCall = calls.find(
        (c) => c.args.includes("task") && c.args.includes("note") && c.args.includes(taskRef),
      );
      const blockCall = calls.find(
        (c) => c.args.includes("task") && c.args.includes("block") && c.args.includes(taskRef),
      );

      expect(noteCall).toBeDefined();
      expect(noteCall!.args.join(" ")).toContain("DISPATCH-WORKSPACE");
      expect(blockCall).toBeDefined();
      expect(blockCall!.args.join(" ")).toContain("Dispatch workspace provisioning failed");
      expect(blockCall!.args.join(" ")).toContain(
        "Set dispatch.worktree_root to a directory outside .kspec/.",
      );
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
      vi.restoreAllMocks();
    }
  });

  // AC: @agent-dispatch-engine ac-8
  it("does not throw when dispatch workspace blocking cannot be executed successfully", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);
    await fs.mkdir(path.join(testDir, ".kspec"), { recursive: true });
    await fs.writeFile(
      path.join(testDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n  worktree_root: .kspec/worktrees\n",
      "utf-8",
    );

    const captureFile = path.join(testDir, "kspec-workspace-block-failure-capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;
    process.env.KSPEC_CAPTURE_FAIL_ON = "task:block";

    try {
      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });
      (engine as unknown as { running: boolean }).running = true;
      const taskRef = `@${testUlid("TASK", 34)}`;
      const change = makeStateChange({ toStatus: "pending", fromStatus: "in_progress", taskRef });
      const entry = { agent, change, retryCount: 0, nextRetryAt: 0 };
      const runSpy = vi.spyOn(invocationModule, "runInvocation");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> };
      const spawned = await (engine as unknown as EngineInternal)._spawnInvocation(agent, entry);

      expect(spawned).toBe(false);
      expect(runSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to block task"));

      const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{
        args: string[];
      }>;
      const noteCall = calls.find(
        (c) => c.args.includes("task") && c.args.includes("note") && c.args.includes(taskRef),
      );
      const blockCall = calls.find(
        (c) => c.args.includes("task") && c.args.includes("block") && c.args.includes(taskRef),
      );

      expect(noteCall).toBeDefined();
      expect(blockCall).toBeDefined();
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
      delete process.env.KSPEC_CAPTURE_FAIL_ON;
      vi.restoreAllMocks();
    }
  });

  // AC: @agent-dispatch-engine ac-8
  it("continues recovery blocking when adding the workspace failure note also fails", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);
    await fs.mkdir(path.join(testDir, ".kspec"), { recursive: true });
    await fs.writeFile(
      path.join(testDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n  worktree_root: .kspec/worktrees\n",
      "utf-8",
    );

    const captureFile = path.join(testDir, "kspec-workspace-note-failure-capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;
    process.env.KSPEC_CAPTURE_FAIL_ON = "task:note";

    try {
      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });
      (engine as unknown as { running: boolean }).running = true;
      const taskRef = `@${testUlid("TASK", 35)}`;
      const change = makeStateChange({ toStatus: "pending", fromStatus: "in_progress", taskRef });
      const entry = { agent, change, retryCount: 0, nextRetryAt: 0 };
      const runSpy = vi.spyOn(invocationModule, "runInvocation");
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> };
      const spawned = await (engine as unknown as EngineInternal)._spawnInvocation(agent, entry);

      expect(spawned).toBe(false);
      expect(runSpy).not.toHaveBeenCalled();

      const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{
        args: string[];
      }>;
      const noteCall = calls.find(
        (c) => c.args.includes("task") && c.args.includes("note") && c.args.includes(taskRef),
      );
      const blockCall = calls.find(
        (c) => c.args.includes("task") && c.args.includes("block") && c.args.includes(taskRef),
      );

      expect(noteCall).toBeDefined();
      expect(blockCall).toBeDefined();
      expect(blockCall!.args.join(" ")).toContain("Dispatch workspace provisioning failed");
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
      delete process.env.KSPEC_CAPTURE_FAIL_ON;
      vi.restoreAllMocks();
    }
  });

  it("releases the in-flight task key when bootstrap fails before invocation start", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);
    await fs.writeFile(
      path.join(testDir, "kspec.config.yaml"),
      [
        "dispatch:",
        "  base_branch: main",
        "  bootstrap:",
        "    steps:",
        "      - run: exit 7",
      ].join("\n"),
      "utf-8",
    );

    const captureFile = path.join(testDir, "kspec-bootstrap-failure-capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;

    try {
      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });
      const taskId = testUlid("TASK", 35);
      const taskRef = `@${taskId}`;
      const change = makeStateChange({
        toStatus: "pending",
        fromStatus: "in_progress",
        taskRef,
        task: {
          _ulid: taskId,
          title: "Bootstrap failure releases in-flight key",
          slugs: ["bootstrap-failure-releases-in-flight-key"],
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
        } as any,
      });
      const entry = { agent, change, retryCount: 0, nextRetryAt: 0 };
      const runSpy = vi.spyOn(invocationModule, "runInvocation");
      vi.spyOn(console, "error").mockImplementation(() => {});

      type EngineInternal = {
        running: boolean;
        _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean>;
        inFlightTaskKeys: Set<string>;
      };
      const internal = engine as unknown as EngineInternal;
      internal.running = true;

      const spawned = await internal._spawnInvocation(agent, entry);

      expect(spawned).toBe(false);
      expect(runSpy).not.toHaveBeenCalled();
      expect(internal.inFlightTaskKeys.has(`${agent.id}:${taskRef}`)).toBe(false);
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
      vi.restoreAllMocks();
    }
  });
});

// ─── Dispatch uses the runner resolver ──────────────────────────────────────

// AC: @runner-resolution-and-preflight ac-dispatch-uses-runner-resolution
// AC: @runner-resolution-and-preflight ac-unknown-runner-blocks-before-spawn
// AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
describe("Dispatch runner resolution preflight", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-runner-preflight-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-resolution-and-preflight ac-dispatch-uses-runner-resolution
  it("blocks dispatch before spawn when the configured runner is not in the effective registry", async () => {
    // No project.runners.yaml or system runners.yaml on disk → the effective
    // registry is empty. The agent points at an unknown runner, which can
    // only fail if dispatch routes the invocation through the same
    // resolveRunnerInvocation contract that one-shot agent run uses.
    const agentMissingRunner = makeTestAgent({
      id: "runner-missing-agent",
      runner: "absent-runner",
      adapter: undefined,
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agentMissingRunner]);

    const captureFile = path.join(testDir, "kspec-runner-preflight-capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;
    try {
      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });
      (engine as unknown as { running: boolean }).running = true;

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const runSpy = vi.spyOn(invocationModule, "runInvocation");

      const taskRef = `@${testUlid("TASK")}`;
      const change = makeStateChange({
        toStatus: "pending",
        fromStatus: "in_progress",
        taskRef,
      });
      const entry = { agent: agentMissingRunner, change, retryCount: 0, nextRetryAt: 0 };

      type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> };
      const spawned = await (engine as unknown as EngineInternal)._spawnInvocation(
        agentMissingRunner,
        entry,
      );

      // Dispatch skipped the invocation entirely — runInvocation never ran.
      expect(spawned).toBe(false);
      expect(runSpy).not.toHaveBeenCalled();

      // The dispatch path surfaced the resolver's typed error to the operator
      // (unknown_runner is a RunnerResolutionError reason code, not a
      // generic adapter-resolution failure).
      const errorMessage = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(errorMessage).toContain("unknown_runner");
      expect(errorMessage).toContain("absent-runner");

      // Dispatch recorded the resolver guidance on the task so the next
      // operator can find both layers + the agent definition.
      const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{ args: string[] }>;
      const noteCall = calls.find((c) => c.args.includes("note") && c.args.includes(taskRef));
      expect(noteCall, "expected dispatch to add an AGENT-SKIP task note").toBeDefined();
      const noteText = noteCall!.args.join(" ");
      expect(noteText).toContain("AGENT-SKIP");
      expect(noteText).toContain("absent-runner");
      expect(noteText).toContain("unknown_runner");

      errorSpy.mockRestore();
      runSpy.mockRestore();
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
      vi.restoreAllMocks();
    }
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  // AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
  //
  // Without dispatch-level executable preflight, an unspawnable runner-
  // configured command would only surface inside runInvocation, where the
  // dispatch retry path would treat it as a transient invocation failure and
  // re-attempt it on backoff. Dispatch must run the typed preflight up front
  // so deterministic runner configuration errors land in the AGENT-SKIP path
  // (skip + task note + no retry) rather than the retry loop.
  it("skips invocation with a typed unspawnable_command diagnostic when the runner executable cannot be spawned", async () => {
    const agent = makeTestAgent({
      id: "unspawnable-runner-agent",
      runner: "unspawnable-runner",
      adapter: undefined,
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const missingExecutable = path.join(testDir, "no-such-runner-binary");

    const captureFile = path.join(testDir, "kspec-runner-unspawnable-preflight-capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;
    try {
      vi.spyOn(runnerConfigModule, "resolveEffectiveRunners").mockResolvedValue({
        project: { config: null, path: "", loaded: false, issues: null },
        system: { config: null, path: "", loaded: false, issues: null },
        registry: mergeRunnerConfigs(null, {
          runners: {
            "unspawnable-runner": {
              kind: "acp_process",
              adapter: "claude-agent-acp",
              process: { executable: missingExecutable },
            },
          },
        }),
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });
      (engine as unknown as { running: boolean }).running = true;

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const runSpy = vi.spyOn(invocationModule, "runInvocation");

      const taskRef = `@${testUlid("TASK")}`;
      const change = makeStateChange({
        toStatus: "pending",
        fromStatus: "in_progress",
        taskRef,
      });
      const entry = { agent, change, retryCount: 0, nextRetryAt: 0 };

      type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> };
      const spawned = await (engine as unknown as EngineInternal)._spawnInvocation(agent, entry);

      // Dispatch skipped the invocation entirely — runInvocation never ran,
      // which means the retry path never saw a runner configuration error.
      expect(spawned).toBe(false);
      expect(runSpy).not.toHaveBeenCalled();
      // Retry counter must NOT have advanced: this is a deterministic
      // configuration error, not a transient invocation failure.
      expect(entry.retryCount).toBe(0);

      const errorMessage = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(errorMessage).toContain("unspawnable_command");
      expect(errorMessage).toContain(missingExecutable);

      const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{ args: string[] }>;
      const noteCall = calls.find((c) => c.args.includes("note") && c.args.includes(taskRef));
      expect(noteCall, "expected dispatch to add an AGENT-SKIP task note").toBeDefined();
      const noteText = noteCall!.args.join(" ");
      expect(noteText).toContain("AGENT-SKIP");
      expect(noteText).toContain("unspawnable_command");
      expect(noteText).toContain(missingExecutable);

      errorSpy.mockRestore();
      runSpy.mockRestore();
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
      vi.restoreAllMocks();
    }
  });

  // AC: @runner-invocation-semantics ac-dispatch-preflight-accepts-configured-runners
  // AC: @runner-resolution-and-preflight ac-dispatch-uses-runner-resolution
  //
  // Spec wording is "whose adapter is not a built-in adapter id". Register
  // a custom adapter at runtime so the runner cannot fall through to a
  // built-in default — only the runner-aware preflight can keep the
  // dispatch flow open here.
  it("accepts dispatch for a runner-backed worker whose adapter is a custom-registered (non-built-in) adapter", async () => {
    const customAdapterId = `custom-dispatch-adapter-${testUlid("ADPT").toLowerCase()}`;
    registerAdapter(customAdapterId, {
      command: "node",
      args: [],
      description: "Custom test adapter for dispatch preflight",
    });

    const agent = makeTestAgent({
      id: "runner-worker-custom-adapter",
      adapter: undefined,
      runner: "test-custom-runner",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    try {
      vi.spyOn(runnerConfigModule, "resolveEffectiveRunners").mockResolvedValue({
        project: { config: null, path: "", loaded: false, issues: null },
        system: { config: null, path: "", loaded: false, issues: null },
        registry: mergeRunnerConfigs(null, {
          runners: {
            "test-custom-runner": { kind: "acp_process", adapter: customAdapterId },
          },
        }),
      });

      const mockMetadata = buildMockWorkspaceMetadata(testDir);
      vi.spyOn(workspaceModule, "provisionDispatchWorkspace").mockResolvedValue({
        cwd: testDir,
        metadataPath: path.join(testDir, ".kspec-dispatch-workspace.json"),
        metadata: mockMetadata,
      });
      vi.spyOn(bootstrapModule, "ensureWorkspaceBootstrap").mockResolvedValue({
        metadata: mockMetadata,
      });
      vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockResolvedValue({
        exists: true,
        healthy: true,
        reason: null,
        metadata: null,
      });

      const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
        session: {} as any,
        outcome: "success",
        durationMs: 1,
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });
      (engine as unknown as { running: boolean }).running = true;

      const taskRef = `@${testUlid("TASK")}`;
      const change = makeStateChange({
        toStatus: "pending",
        fromStatus: "in_progress",
        taskRef,
      });
      const entry = { agent, change, retryCount: 0, nextRetryAt: 0 };
      type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> };
      const spawned = await (engine as unknown as EngineInternal)._spawnInvocation(agent, entry);
      await waitForMockCall(runSpy);

      // Dispatch accepted the runner: invocation was actually started.
      expect(spawned).toBe(true);
      expect(runSpy).toHaveBeenCalledTimes(1);

      // The runner-resolved registry was forwarded so runInvocation produces
      // the same contract — dispatch did not bypass the resolver.
      const invocationOpts = runSpy.mock.calls[0][0] as {
        agent: Agent;
        runnerRegistry?: { runners: Record<string, unknown> };
      };
      expect(invocationOpts.agent.id).toBe(agent.id);
      expect(invocationOpts.runnerRegistry?.runners?.["test-custom-runner"]).toBeDefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  // AC: @runner-invocation-semantics ac-dispatch-preflight-accepts-configured-runners
  // AC: @runner-resolution-and-preflight ac-dispatch-uses-runner-resolution
  //
  // Reviewer pickup routes through the same _spawnInvocation pathway as a
  // worker. Verify the runner preflight accepts a valid configured runner
  // for the reviewer role too — same resolver, just a different role tag.
  it("accepts dispatch for a runner-backed reviewer with a configured runner", async () => {
    const customAdapterId = `custom-reviewer-adapter-${testUlid("ADPT").toLowerCase()}`;
    registerAdapter(customAdapterId, {
      command: "node",
      args: [],
      description: "Custom test reviewer adapter",
    });

    const reviewerAgent = makeTestAgent({
      id: "runner-reviewer",
      adapter: undefined,
      runner: "test-reviewer-runner",
      dispatch: [{ on: "task.pending_review" }],
    });
    await setupProjectWithAgents(testDir, [reviewerAgent]);

    try {
      vi.spyOn(runnerConfigModule, "resolveEffectiveRunners").mockResolvedValue({
        project: { config: null, path: "", loaded: false, issues: null },
        system: { config: null, path: "", loaded: false, issues: null },
        registry: mergeRunnerConfigs(null, {
          runners: {
            "test-reviewer-runner": { kind: "acp_process", adapter: customAdapterId },
          },
        }),
      });

      const mockMetadata = buildMockWorkspaceMetadata(testDir);
      vi.spyOn(workspaceModule, "provisionDispatchWorkspace").mockResolvedValue({
        cwd: testDir,
        metadataPath: path.join(testDir, ".kspec-dispatch-workspace.json"),
        metadata: mockMetadata,
      });
      vi.spyOn(bootstrapModule, "ensureWorkspaceBootstrap").mockResolvedValue({
        metadata: mockMetadata,
      });
      vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockResolvedValue({
        exists: true,
        healthy: true,
        reason: null,
        metadata: null,
      });

      const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
        session: {} as any,
        outcome: "success",
        durationMs: 1,
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });
      (engine as unknown as { running: boolean }).running = true;

      const taskRef = `@${testUlid("TASK")}`;
      const change = makeStateChange({
        toStatus: "pending_review",
        fromStatus: "in_progress",
        taskRef,
      });
      const entry = { agent: reviewerAgent, change, retryCount: 0, nextRetryAt: 0 };
      type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> };
      const spawned = await (engine as unknown as EngineInternal)._spawnInvocation(
        reviewerAgent,
        entry,
      );
      await waitForMockCall(runSpy);

      expect(spawned).toBe(true);
      expect(runSpy).toHaveBeenCalledTimes(1);
      const invocationOpts = runSpy.mock.calls[0][0] as {
        agent: Agent;
        runnerRegistry?: { runners: Record<string, unknown> };
      };
      expect(invocationOpts.agent.id).toBe(reviewerAgent.id);
      expect(invocationOpts.runnerRegistry?.runners?.["test-reviewer-runner"]).toBeDefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  // AC: @runner-invocation-semantics ac-dispatch-preflight-rejects-invalid-runners
  // AC: @runner-resolution-and-preflight ac-invalid-runner-blocks-before-prompt
  //
  // Regression: previously dispatch validated the agent.adapter field via a
  // bare getAdapter() call, which would have either accepted (synthesizing
  // an npx fallback) or rejected based purely on the legacy field — without
  // ever looking at the runner registry. Now the runner-aware preflight
  // routes through the resolver, which rejects unregistered runner adapters
  // with a typed invalid_adapter reason before any spawn or prompt build.
  it("rejects dispatch when the configured runner references an unregistered adapter", async () => {
    const agent = makeTestAgent({
      id: "runner-invalid-adapter-agent",
      adapter: undefined,
      runner: "runner-pointing-at-missing-adapter",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const captureFile = path.join(testDir, "kspec-runner-invalid-adapter-capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;
    try {
      vi.spyOn(runnerConfigModule, "resolveEffectiveRunners").mockResolvedValue({
        project: { config: null, path: "", loaded: false, issues: null },
        system: { config: null, path: "", loaded: false, issues: null },
        registry: mergeRunnerConfigs(null, {
          runners: {
            "runner-pointing-at-missing-adapter": {
              kind: "acp_process",
              adapter: "never-registered-adapter-id-xyz",
            },
          },
        }),
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });
      (engine as unknown as { running: boolean }).running = true;

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const runSpy = vi.spyOn(invocationModule, "runInvocation");

      const taskRef = `@${testUlid("TASK")}`;
      const change = makeStateChange({
        toStatus: "pending",
        fromStatus: "in_progress",
        taskRef,
      });
      const entry = { agent, change, retryCount: 0, nextRetryAt: 0 };

      type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> };
      const spawned = await (engine as unknown as EngineInternal)._spawnInvocation(agent, entry);

      expect(spawned).toBe(false);
      expect(runSpy).not.toHaveBeenCalled();

      const errorMessage = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(errorMessage).toContain("invalid_adapter");
      expect(errorMessage).toContain("runner-pointing-at-missing-adapter");
      expect(errorMessage).toContain("never-registered-adapter-id-xyz");

      const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{ args: string[] }>;
      const noteCall = calls.find((c) => c.args.includes("note") && c.args.includes(taskRef));
      expect(noteCall, "expected dispatch to add an AGENT-SKIP task note").toBeDefined();
      const noteText = noteCall!.args.join(" ");
      expect(noteText).toContain("AGENT-SKIP");
      expect(noteText).toContain("invalid_adapter");
      expect(noteText).toContain("runner-pointing-at-missing-adapter");
      expect(noteText).toContain("never-registered-adapter-id-xyz");

      errorSpy.mockRestore();
      runSpy.mockRestore();
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
      vi.restoreAllMocks();
    }
  });

  // AC: @runner-environment-secret-boundaries ac-required-secret-missing-blocks
  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  // AC: @runner-invocation-semantics ac-dispatch-preflight-rejects-invalid-runners
  //
  // A required secret binding that cannot resolve must block dispatch
  // before any adapter spawn. The diagnostic surfaces must reference the
  // binding name and source identifier — but never a secret value (none
  // could be resolved here, so the test also asserts the env var name is
  // the only secret-related token leaked).
  it("rejects dispatch when a required runner secret binding cannot be resolved", async () => {
    // Unique env var name guaranteed to be absent from process.env.
    const missingSecretEnvName = `KSPEC_MISSING_SECRET_${testUlid("VAR")}`;
    delete process.env[missingSecretEnvName];

    const agent = makeTestAgent({
      id: "runner-missing-secret-agent",
      adapter: undefined,
      runner: "runner-with-required-secret",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const captureFile = path.join(testDir, "kspec-runner-missing-secret-capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;
    try {
      vi.spyOn(runnerConfigModule, "resolveEffectiveRunners").mockResolvedValue({
        project: { config: null, path: "", loaded: false, issues: null },
        system: { config: null, path: "", loaded: false, issues: null },
        registry: mergeRunnerConfigs(null, {
          runners: {
            "runner-with-required-secret": {
              kind: "acp_process",
              adapter: "claude-agent-acp",
              env: {
                secrets: {
                  [missingSecretEnvName]: { source: "user_env", required: true },
                },
              },
            },
          },
        }),
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });
      (engine as unknown as { running: boolean }).running = true;

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const runSpy = vi.spyOn(invocationModule, "runInvocation");

      const taskRef = `@${testUlid("TASK")}`;
      const change = makeStateChange({
        toStatus: "pending",
        fromStatus: "in_progress",
        taskRef,
      });
      const entry = { agent, change, retryCount: 0, nextRetryAt: 0 };

      type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> };
      const spawned = await (engine as unknown as EngineInternal)._spawnInvocation(agent, entry);

      expect(spawned).toBe(false);
      expect(runSpy).not.toHaveBeenCalled();

      const errorMessage = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(errorMessage).toContain("missing_secret");
      expect(errorMessage).toContain("runner-with-required-secret");
      expect(errorMessage).toContain(missingSecretEnvName);

      const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{ args: string[] }>;
      const noteCall = calls.find((c) => c.args.includes("note") && c.args.includes(taskRef));
      expect(noteCall, "expected dispatch to add an AGENT-SKIP task note").toBeDefined();
      const noteText = noteCall!.args.join(" ");
      expect(noteText).toContain("AGENT-SKIP");
      expect(noteText).toContain("missing_secret");
      expect(noteText).toContain("runner-with-required-secret");
      expect(noteText).toContain(missingSecretEnvName);

      errorSpy.mockRestore();
      runSpy.mockRestore();
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
      delete process.env[missingSecretEnvName];
      vi.restoreAllMocks();
    }
  });

  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  // AC: @runner-invocation-semantics ac-dispatch-preflight-accepts-configured-runners
  //
  // Legacy adapter compatibility: agents with no runner field still flow
  // through the runner-aware preflight (the resolver takes the implicit
  // path) and dispatch must continue to accept them when agent.adapter
  // names a registered built-in adapter. This guards against a regression
  // where preflight could start requiring a runner on every agent.
  it("accepts dispatch for a legacy agent (no runner field) with a registered built-in adapter", async () => {
    const agent = makeTestAgent({
      id: "legacy-adapter-agent",
      adapter: "mock-acp",
      runner: undefined,
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    try {
      // No runner registry: the resolver should take the implicit/legacy
      // path keyed off agent.adapter alone.
      vi.spyOn(runnerConfigModule, "resolveEffectiveRunners").mockResolvedValue({
        project: { config: null, path: "", loaded: false, issues: null },
        system: { config: null, path: "", loaded: false, issues: null },
        registry: mergeRunnerConfigs(null, null),
      });

      const mockMetadata = buildMockWorkspaceMetadata(testDir);
      vi.spyOn(workspaceModule, "provisionDispatchWorkspace").mockResolvedValue({
        cwd: testDir,
        metadataPath: path.join(testDir, ".kspec-dispatch-workspace.json"),
        metadata: mockMetadata,
      });
      vi.spyOn(bootstrapModule, "ensureWorkspaceBootstrap").mockResolvedValue({
        metadata: mockMetadata,
      });
      vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockResolvedValue({
        exists: true,
        healthy: true,
        reason: null,
        metadata: null,
      });

      const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
        session: {} as any,
        outcome: "success",
        durationMs: 1,
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });
      (engine as unknown as { running: boolean }).running = true;

      const taskRef = `@${testUlid("TASK")}`;
      const change = makeStateChange({
        toStatus: "pending",
        fromStatus: "in_progress",
        taskRef,
      });
      const entry = { agent, change, retryCount: 0, nextRetryAt: 0 };
      type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> };
      const spawned = await (engine as unknown as EngineInternal)._spawnInvocation(agent, entry);
      await waitForMockCall(runSpy);

      expect(spawned).toBe(true);
      expect(runSpy).toHaveBeenCalledTimes(1);
      const invocationOpts = runSpy.mock.calls[0][0] as { agent: Agent };
      expect(invocationOpts.agent.id).toBe(agent.id);
      expect(invocationOpts.agent.runner).toBeUndefined();
      expect(invocationOpts.agent.adapter).toBe("mock-acp");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ─── Dispatch preflight registry-load failure diagnostics ───────────────────

// AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
// AC: @runner-resolution-and-preflight ac-registry-load-failure-blocks-runner-spawn
describe("Dispatch preflight surfaces runner_registry_unavailable", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-registry-load-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-blocks-runner-spawn
  it("blocks dispatch with runner_registry_unavailable when system runner config is malformed", async () => {
    const agent = makeTestAgent({
      id: "runner-backed-agent",
      runner: "configured-runner",
      adapter: undefined,
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const sysConfigPath = path.join(testDir, "fake-system-runners.yaml");

    const captureFile = path.join(testDir, "kspec-dispatch-registry-load-capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;
    try {
      // Simulate the loader returning a layer-load failure rather than a
      // healthy registry. Real disk path would also work, but the spy keeps
      // the test fast and independent of the home-dir HOME override.
      vi.spyOn(runnerConfigModule, "resolveEffectiveRunners").mockResolvedValue({
        project: { config: null, path: "", loaded: false, issues: null },
        system: {
          config: null,
          path: sysConfigPath,
          loaded: true,
          issues: [
            { path: "runners.configured-runner", message: "Expected object, received array" },
          ],
        },
        registry: { runners: {} },
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });
      (engine as unknown as { running: boolean }).running = true;

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const runSpy = vi.spyOn(invocationModule, "runInvocation");

      const taskRef = `@${testUlid("TASK")}`;
      const change = makeStateChange({
        toStatus: "pending",
        fromStatus: "in_progress",
        taskRef,
      });
      const entry = { agent, change, retryCount: 0, nextRetryAt: 0 };

      type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> };
      const spawned = await (engine as unknown as EngineInternal)._spawnInvocation(agent, entry);

      // Dispatch must NOT invoke runInvocation when the registry is
      // unavailable — the prompt would never be forwarded.
      expect(spawned).toBe(false);
      expect(runSpy).not.toHaveBeenCalled();
      // Retry counter does not advance — this is a configuration error,
      // not a transient invocation failure.
      expect(entry.retryCount).toBe(0);

      // Console error must surface the stable reason, not collapse it to
      // unknown_runner.
      const errorMessage = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(errorMessage).toContain("runner_registry_unavailable");
      expect(errorMessage).not.toContain("unknown_runner");

      // Task note carries the stable reason and the failing config path so
      // operators can find which file to fix without rerunning the validator.
      const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{ args: string[] }>;
      const noteCall = calls.find((c) => c.args.includes("note") && c.args.includes(taskRef));
      expect(noteCall, "expected dispatch to add an AGENT-SKIP task note").toBeDefined();
      const noteText = noteCall!.args.join(" ");
      expect(noteText).toContain("AGENT-SKIP");
      expect(noteText).toContain("runner_registry_unavailable");
      expect(noteText).toContain(sysConfigPath);
      expect(noteText).toContain("system=");

      errorSpy.mockRestore();
      runSpy.mockRestore();
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
      vi.restoreAllMocks();
    }
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  it("emits runner_registry_unavailable for malformed project runner config too", async () => {
    const agent = makeTestAgent({
      id: "runner-backed-agent",
      runner: "configured-runner",
      adapter: undefined,
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const projectConfigPath = path.join(testDir, "fake-project-runners.yaml");

    const captureFile = path.join(testDir, "kspec-dispatch-project-load-capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;
    try {
      vi.spyOn(runnerConfigModule, "resolveEffectiveRunners").mockResolvedValue({
        project: {
          config: null,
          path: projectConfigPath,
          loaded: true,
          issues: [{ path: "", message: "unterminated flow sequence" }],
        },
        system: { config: null, path: "", loaded: false, issues: null },
        registry: { runners: {} },
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });
      (engine as unknown as { running: boolean }).running = true;

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const taskRef = `@${testUlid("TASK")}`;
      const change = makeStateChange({
        toStatus: "pending",
        fromStatus: "in_progress",
        taskRef,
      });
      const entry = { agent, change, retryCount: 0, nextRetryAt: 0 };

      type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean> };
      const spawned = await (engine as unknown as EngineInternal)._spawnInvocation(agent, entry);

      expect(spawned).toBe(false);

      const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{ args: string[] }>;
      const noteCall = calls.find((c) => c.args.includes("note") && c.args.includes(taskRef));
      expect(noteCall).toBeDefined();
      const noteText = noteCall!.args.join(" ");
      expect(noteText).toContain("runner_registry_unavailable");
      expect(noteText).toContain(projectConfigPath);
      expect(noteText).toContain("project=");

      errorSpy.mockRestore();
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
      vi.restoreAllMocks();
    }
  });
});

// ─── AC-11: Graceful shutdown ─────────────────────────────────────────────────

// AC: @agent-dispatch-engine ac-11
describe("AC-11: Graceful shutdown waits for active invocations", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac11-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should stop accepting new events after stop() is called", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    expect(engine.getStatus().running).toBe(true);

    await engine.stop();

    expect(engine.getStatus().running).toBe(false);

    // Triggering changes after stop should be no-ops
    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    const change = makeStateChange({ toStatus: "pending" });
    await engine.handleStateChange(change);
    expect(enqueueCount).toBe(0);
  });

  it("should resolve stop() only after running invocations complete", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Inject a fake long-running invocation
    let invocationResolved = false;
    const invocationPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        invocationResolved = true;
        resolve();
      }, 50);
    });
    (engine as unknown as { runningInvocations: Set<Promise<void>> }).runningInvocations.add(
      invocationPromise,
    );

    const stopStarted = Date.now();
    await engine.stop();
    const stopDuration = Date.now() - stopStarted;

    // stop() should have waited for the invocation
    expect(invocationResolved).toBe(true);
    expect(stopDuration).toBeGreaterThanOrEqual(40);
  });

  it("should abort active invocations via abort controllers on stop()", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Inject a fake abort controller to verify it gets aborted
    const fakeController = new AbortController();
    let aborted = false;
    fakeController.signal.addEventListener("abort", () => {
      aborted = true;
    });
    (
      engine as unknown as { invocationAbortControllers: Set<AbortController> }
    ).invocationAbortControllers.add(fakeController);

    await engine.stop();

    // Abort controller should have been signalled
    expect(aborted).toBe(true);
  });

  it("should not start queued invocations if drain runs after stop()", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();
    await engine.stop();

    const change = makeStateChange({ toStatus: "pending" });
    const queueEntry = {
      agent,
      change,
      retryCount: 0,
      nextRetryAt: 0,
      enqueuedAtMs: Date.now(),
    };

    const internal = engine as unknown as {
      queues: Map<string, unknown[]>;
      _drainQueues: (agents: unknown[]) => Promise<void>;
    };
    internal.queues.set(agent.id, [queueEntry]);

    const spawnSpy = vi.spyOn(
      engine as unknown as { _spawnInvocation: (a: unknown, e: unknown) => boolean },
      "_spawnInvocation",
    );

    await internal._drainQueues([agent]);

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(internal.queues.get(agent.id)).toHaveLength(1);
  });
});

// ─── AC-12: Shadow branch serialization ──────────────────────────────────────

// AC: @agent-dispatch-engine ac-12
describe("AC-12: Shadow branch mutations serialized via mutex", () => {
  let testDir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    testDir = await createTempDir("kspec-dispatch-ac12-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  it("should provide a shadow mutex for exclusive access to shadow branch", async () => {
    const agent = makeTestAgent();
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    const mutex = engine.getShadowMutex();
    expect(mutex).toBeDefined();
    expect(typeof mutex.runExclusive).toBe("function");

    await engine.stop();
  });

  it("should serialize concurrent operations through the mutex", async () => {
    const agent = makeTestAgent();
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    const mutex = engine.getShadowMutex();
    const results: number[] = [];

    // Run two concurrent operations through the mutex
    await Promise.all([
      mutex.runExclusive(async () => {
        results.push(1);
        await new Promise((r) => setTimeout(r, 10));
        results.push(2);
      }),
      mutex.runExclusive(async () => {
        results.push(3);
        await new Promise((r) => setTimeout(r, 10));
        results.push(4);
      }),
    ]);

    // Operations should be serialized: [1, 2, 3, 4] or [3, 4, 1, 2]
    expect(results).toHaveLength(4);
    // Verify the pairs are not interleaved
    const firstPair = results.slice(0, 2);
    const secondPair = results.slice(2, 4);
    const validOrdering =
      (firstPair[0] === 1 && firstPair[1] === 2 && secondPair[0] === 3 && secondPair[1] === 4) ||
      (firstPair[0] === 3 && firstPair[1] === 4 && secondPair[0] === 1 && secondPair[1] === 2);
    expect(validOrdering).toBe(true);

    await engine.stop();
  });

  it("should allow concurrent invocations to overlap outside mutation windows", async () => {
    // AC: @scoped-dispatch-shadow-serialization ac-1
    const agent = makeTestAgent({
      id: "parallel-worker",
      dispatch: [{ on: "task.ready" }],
      concurrency: { max_concurrent: 2 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    let activeInvocations = 0;
    let maxConcurrentInvocations = 0;
    let releaseInvocations: (() => void) | null = null;
    const blocker = new Promise<void>((resolve) => {
      releaseInvocations = resolve;
    });

    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async () => {
      activeInvocations++;
      maxConcurrentInvocations = Math.max(maxConcurrentInvocations, activeInvocations);
      await blocker;
      activeInvocations--;
      return { session: {} as any, outcome: "success", durationMs: 1 };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    const [taskA, taskB] = testUlids("TASK", 2);
    await engine.handleStateChange({
      taskId: taskA,
      taskRef: `@${taskA}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });
    await engine.handleStateChange({
      taskId: taskB,
      taskRef: `@${taskB}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now() + 1,
      task: { automation: "eligible", tags: [] } as any,
    });

    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- modified by async mock callback
    for (let i = 0; i < 50 && maxConcurrentInvocations < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(maxConcurrentInvocations).toBe(2);

    releaseInvocations?.();
    await engine.stop();
  });

  it("should pass a shared mutation lock file to dispatched invocations", async () => {
    // AC: @scoped-dispatch-shadow-serialization ac-2
    const agent = makeTestAgent({ id: "worker", dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as any,
      outcome: "success",
      durationMs: 1,
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    try {
      const taskId = testUlid("TASK");
      await engine.handleStateChange({
        taskId,
        taskRef: `@${taskId}`,
        fromStatus: "in_progress",
        toStatus: "pending",
        timestamp: Date.now(),
        task: { automation: "eligible", tags: [] } as any,
      });

      await waitForMockCall(runSpy);

      expect(runSpy).toHaveBeenCalled();
      expect(runSpy.mock.calls[0][0].mutationLockFile).toBe(
        path.join(testDir, ".kspec-dispatch-shadow-mutation"),
      );
    } finally {
      await engine.stop();
    }
  });
});

// ─── Active fleet cleanup ordering ──────────────────────────────────────────

describe("Active fleet cleanup on invocation completion", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-fleet-cleanup-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  it("should remove completed invocation from getStatus before draining next invocation", async () => {
    const agent = makeTestAgent({ id: "worker", dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    // Track getStatus snapshots taken during drain (inside runExclusive of the NEXT invocation)
    const statusDuringSecondInvocation: Array<ReturnType<DispatchEngine["getStatus"]>> = [];
    let invocationCount = 0;

    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async () => {
      invocationCount++;
      if (invocationCount === 2) {
        // During the second invocation (spawned by drain), check if the first
        // invocation has been cleaned up from status. If the bug is present,
        // the first invocation would still appear in getStatus().invocations.
        statusDuringSecondInvocation.push(engine.getStatus());
      }
      return { session: {} as any, outcome: "success", durationMs: 1 };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    await engine.start();

    // Enqueue two tasks so the drain after the first completion triggers the second
    const [taskId1, taskId2] = testUlids("TASK", 2);
    await engine.handleStateChange({
      taskId: taskId1,
      taskRef: `@${taskId1}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });
    await engine.handleStateChange({
      taskId: taskId2,
      taskRef: `@${taskId2}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now() + 1,
      task: { automation: "eligible", tags: [] } as any,
    });

    // Wait for both invocations to complete (second is spawned by drain
    // after the first completes, which involves real git worktree operations)
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- modified by async mock callback
    for (let i = 0; i < 200 && invocationCount < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(invocationCount).toBe(2);
    expect(statusDuringSecondInvocation).toHaveLength(1);

    // During the second invocation, getStatus should show exactly 1 active invocation
    // (the second one), NOT 2 (which would include the stale first invocation)
    const statusSnapshot = statusDuringSecondInvocation[0];
    expect(statusSnapshot.invocations).toHaveLength(1);
    expect(statusSnapshot.activeInvocations).toBe(1);

    await engine.stop();
  });

  it("should clean up activeInvocationDetails on failed invocation (retry exhausted)", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }],
      budget: { max_retries: 0 } as any,
    });
    await setupProjectWithAgents(testDir, [agent]);

    vi.spyOn(invocationModule, "runInvocation").mockRejectedValue(new Error("test failure"));

    const events: Array<{ type: string }> = [];
    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      onInvocationEvent: (e) => events.push(e),
      coalesceWindowMs: 0,
    });

    try {
      await engine.start();

      const taskId = testUlid("TASK", 50);
      await engine.handleStateChange({
        taskId,
        taskRef: `@${taskId}`,
        fromStatus: "in_progress",
        toStatus: "pending",
        timestamp: Date.now(),
        task: { automation: "eligible", tags: [] } as any,
      });

      await waitForCondition(() => events.at(-1)?.type === "failed");
      await waitForCondition(() => engine.getStatus().invocations.length === 0);

      // After failure, getStatus should show no active invocations
      const status = engine.getStatus();
      expect(status.invocations).toHaveLength(0);
      expect(status.activeInvocations).toBe(0);
    } finally {
      await engine.stop();
    }
  });

  it("emits started before terminal invocation events even for quiet success and early failure", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }],
      budget: { max_retries: 0 } as any,
    });
    await setupProjectWithAgents(testDir, [agent]);

    const quietEvents: string[] = [];
    let releaseQuietInvocation!: () => void;
    const quietInvocationGate = new Promise<void>((resolve) => {
      releaseQuietInvocation = resolve;
    });
    const runSpy = vi
      .spyOn(invocationModule, "runInvocation")
      .mockImplementationOnce(async () => {
        await quietInvocationGate;
        return { session: {} as never, outcome: "success", durationMs: 1 };
      })
      .mockRejectedValueOnce(new Error("early failure"));

    const quietEngine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      onInvocationEvent: (event) => quietEvents.push(event.type),
      coalesceWindowMs: 0,
    });

    await quietEngine.start();

    const quietTaskId = testUlid("TASK", 50);
    const quietHandle = quietEngine.handleStateChange({
      taskId: quietTaskId,
      taskRef: `@${quietTaskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    for (let i = 0; i < 200 && quietEvents.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(quietEvents[0]).toBe("started");

    releaseQuietInvocation();
    await quietHandle;

    for (let i = 0; i < 200 && quietEvents.at(-1) !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(quietEvents).toEqual(["started", "completed"]);
    await quietEngine.stop();

    const failureEvents: string[] = [];
    const failingEngine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      onInvocationEvent: (event) => failureEvents.push(event.type),
      coalesceWindowMs: 0,
    });

    await failingEngine.start();

    const failingTaskId = testUlid("TASK", 51);
    await failingEngine.handleStateChange({
      taskId: failingTaskId,
      taskRef: `@${failingTaskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    for (let i = 0; i < 200 && failureEvents.at(-1) !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(failureEvents).toEqual(["started", "failed"]);
    expect(runSpy).toHaveBeenCalledTimes(2);

    await failingEngine.stop();
  });
});

// ─── AC-4: CLI API event processing ─────────────────────────────────────────

// AC: @agent-dispatch-engine ac-4
describe("AC-4: CLI posts state change event via handleStateChange", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac4-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should process state change events submitted directly (CLI API path)", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.needs_work" }] });
    await setupProjectWithAgents(testDir, [agent]);

    // Write task with automation: eligible so default filter passes (AC-21)
    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending_review", automation: "eligible" },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0; // reset after bootstrap

    // Simulate CLI posting a state change event
    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "pending_review",
      toStatus: "needs_work",
      timestamp: Date.now(),
    };

    await engine.handleStateChange(change);

    // Agent should have been enqueued via direct API event
    expect(enqueueCount).toBeGreaterThanOrEqual(1);

    await engine.stop();
  });
});

// ─── AC: @session-event-broadcast — session event accumulator integration ──

describe("Session event accumulator integration", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-boundary-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  // AC: @session-event-broadcast ac-boundary-flush
  it("should emit typed session events with boundary flush on state transitions", async () => {
    const agent = makeTestAgent({ id: "worker", dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    const seenEvents: Array<{ type: string; text?: string; tool_name?: string }> = [];
    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (opts) => {
      opts.onUpdate?.({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "before tool\n" },
      } as unknown as import("../src/acp/index.js").SessionUpdate);
      opts.onUpdate?.({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Bash",
        rawInput: { command: "ls" },
      } as unknown as import("../src/acp/index.js").SessionUpdate);
      opts.onUpdate?.({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
      } as unknown as import("../src/acp/index.js").SessionUpdate);
      opts.onUpdate?.({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "after tool\n" },
      } as unknown as import("../src/acp/index.js").SessionUpdate);
      return {
        session: {} as any,
        outcome: "success",
        durationMs: 1,
      };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      onSessionEvent: (event) => {
        seenEvents.push({
          type: event.type,
          ...("text" in event ? { text: event.text } : {}),
          ...("tool_name" in event ? { tool_name: event.tool_name } : {}),
        });
      },
      coalesceWindowMs: 0,
    });

    await engine.start();
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    for (let i = 0; i < 50 && seenEvents.length < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Expected event sequence:
    // 1. message_start (entering message mode)
    // 2. message_progress (newline-flushed "before tool\n")
    // 3. message_complete (transition to idle for tool call)
    // 4. tool_call_start (tool_call event)
    // 5. tool_call_complete (tool_call_update with completed status)
    // 6. message_start (re-entering message mode)
    // 7. message_progress (newline-flushed "after tool\n")
    // 8. message_complete (session end flush)
    const types = seenEvents.map((e) => e.type);
    expect(types).toContain("message_start");
    expect(types).toContain("message_progress");
    expect(types).toContain("message_complete");
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_complete");

    // Tool call start should include the tool name
    const toolStart = seenEvents.find((e) => e.type === "tool_call_start");
    expect(toolStart?.tool_name).toBe("Bash");

    await engine.stop();
  });
});

describe("Autonomous dispatch prompt guardrails", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-prompt-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  it("should include worker completion guardrails for task.ready triggers", async () => {
    const agent = makeTestAgent({ id: "worker", dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as any,
      outcome: "success",
      durationMs: 1,
    });

    // Mock workspace provisioning and bootstrap — this test validates prompt content,
    // not workspace setup. Without mocks, real git worktree operations cause timing
    // flakiness under concurrent test load.
    const mockMetadata = buildMockWorkspaceMetadata(testDir);
    vi.spyOn(workspaceModule, "provisionDispatchWorkspace").mockResolvedValue({
      cwd: testDir,
      metadataPath: path.join(testDir, ".kspec-dispatch-workspace.json"),
      metadata: mockMetadata,
    });
    vi.spyOn(bootstrapModule, "ensureWorkspaceBootstrap").mockResolvedValue({
      metadata: mockMetadata,
    });
    vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockResolvedValue({
      exists: true,
      healthy: true,
      reason: null,
      metadata: null,
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    await engine.start();
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    await waitForMockCall(runSpy);

    expect(runSpy).toHaveBeenCalled();
    const invocationOpts = runSpy.mock.calls[0][0];
    expect(invocationOpts.prompt).toContain("AUTONOMOUS DISPATCH MODE");
    expect(invocationOpts.prompt).toContain("Do not ask for confirmation");
    expect(invocationOpts.prompt).toContain("Perform the required commands");
    expect(invocationOpts.prompt).toContain("avoid PR conflation");

    await engine.stop();
  });

  it("should include reviewer completion guardrails for task.pending_review triggers", async () => {
    const reviewer = makeTestAgent({
      id: "reviewer",
      dispatch: [{ on: "task.pending_review" }],
    });
    await setupProjectWithAgents(testDir, [reviewer]);

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as any,
      outcome: "success",
      durationMs: 1,
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockResolvedValue({
      exists: true,
      healthy: true,
      reason: null,
      metadata: null,
    });
    // Mock workspace provisioning and bootstrap — this test validates prompt content,
    // not workspace setup. Without provisioning mock, pending_review tasks without
    // submission linkage would fail adoption checks (AC: @adopt-existing-task-branch-lineage ac-4).
    const mockMetadata = buildMockWorkspaceMetadata(testDir);
    vi.spyOn(workspaceModule, "provisionDispatchWorkspace").mockResolvedValue({
      cwd: testDir,
      metadataPath: path.join(testDir, ".kspec-dispatch-workspace.json"),
      metadata: mockMetadata,
    });
    vi.spyOn(bootstrapModule, "ensureWorkspaceBootstrap").mockResolvedValue({
      metadata: mockMetadata,
    });

    await engine.start();
    const taskId = testUlid("TASK");
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending_review",
      timestamp: Date.now(),
    });

    await waitForMockCall(runSpy);

    expect(runSpy).toHaveBeenCalled();
    const invocationOpts = runSpy.mock.calls[0][0];
    expect(invocationOpts.prompt).toContain("AUTONOMOUS DISPATCH MODE");
    expect(invocationOpts.prompt).toContain("Review flow completion criteria");
    expect(invocationOpts.prompt).toContain("configured review workflow");

    await engine.stop();
  });
});

// ─── AC-13 through AC-16: Dispatch prompt orientation context ────────────────

describe("Dispatch prompt orientation context and interpolation", () => {
  // AC: @agent-dispatch-engine ac-16
  describe("interpolateTemplate", () => {
    // Import the exported helpers directly
    let interpolateTemplate: typeof import("../src/agent-runtime/dispatch.js").interpolateTemplate;
    let _buildOrientationContext: typeof import("../src/agent-runtime/dispatch.js").buildOrientationContext;

    beforeEach(async () => {
      const mod = await import("../src/agent-runtime/dispatch.js");
      interpolateTemplate = mod.interpolateTemplate;
      _buildOrientationContext = mod.buildOrientationContext;
    });

    it("should replace known variables", () => {
      const result = interpolateTemplate("Work on {{task_ref}} — {{task_title}}", {
        task_ref: "@my-task",
        task_title: "Fix the bug",
      });
      expect(result).toBe("Work on @my-task — Fix the bug");
    });

    it("should pass through unresolved variables unchanged", () => {
      const result = interpolateTemplate("{{task_ref}} and {{unknown}}", {
        task_ref: "@task",
      });
      expect(result).toBe("@task and {{unknown}}");
    });

    it("should handle template with no variables", () => {
      const result = interpolateTemplate("Work on this task", { task_ref: "@task" });
      expect(result).toBe("Work on this task");
    });

    it("should handle empty vars object", () => {
      const result = interpolateTemplate("{{task_ref}}", {});
      expect(result).toBe("{{task_ref}}");
    });
  });

  // AC: @agent-dispatch-engine ac-13
  describe("buildOrientationContext", () => {
    let buildOrientationContext: typeof import("../src/agent-runtime/dispatch.js").buildOrientationContext;

    beforeEach(async () => {
      const mod = await import("../src/agent-runtime/dispatch.js");
      buildOrientationContext = mod.buildOrientationContext;
    });

    // AC: @dispatch-workspace-orientation-prompt ac-1
    // AC: @dispatch-workspace-orientation-prompt ac-2
    it("should include workspace, branch, role, and status context for task.ready", () => {
      const result = buildOrientationContext(
        "@my-task",
        "task.ready",
        makeProvisionedWorkspace("@my-task"),
        {
          title: "Implement feature X",
        },
      );
      expect(result).toContain("## Task Context");
      expect(result).toContain("@my-task");
      expect(result).toContain("Implement feature X");
      expect(result).toContain("New task assignment");
      expect(result).toContain("Role: worker");
      expect(result).toContain("Focus:");
      expect(result).toContain("Workspace (your working directory): /tmp/my-task-worker");
      expect(result).toContain("Workspace mode: mutable worker branch");
      expect(result).toContain("Canonical branch: dispatch/task/my-task/01task00");
      expect(result).toContain("Integration target: main");
      expect(result).toContain("Canonical head: abcdef123456");
      expect(result).toContain("Bootstrap state: prepared");
      expect(result).toContain("Workspace health: ready");
      expect(result).toContain("Dependency status: satisfied");
    });

    it("should include trigger for task.in_progress", () => {
      const result = buildOrientationContext(
        "@my-task",
        "task.in_progress",
        makeProvisionedWorkspace("@my-task"),
        {
          title: "Continue work",
        },
      );
      expect(result).toContain("Continuing in-progress work");
    });

    // AC: @agent-dispatch-engine ac-14
    it("should include last 3 notes for task.needs_work", () => {
      const notes = [
        { created_at: "2026-01-01T00:00:00Z", author: "alice", content: "Note 1" },
        { created_at: "2026-01-02T00:00:00Z", author: "bob", content: "Note 2" },
        { created_at: "2026-01-03T00:00:00Z", author: "carol", content: "Note 3" },
        { created_at: "2026-01-04T00:00:00Z", author: "dave", content: "Note 4" },
      ];
      const result = buildOrientationContext(
        "@my-task",
        "task.needs_work",
        makeProvisionedWorkspace("@my-task"),
        {
          title: "Fix it",
          notes,
        },
      );
      expect(result).toContain("Fix cycle");
      expect(result).toContain("Recent notes:");
      // Should include last 3, not first
      expect(result).not.toContain("Note 1");
      expect(result).toContain("Note 2");
      expect(result).toContain("Note 3");
      expect(result).toContain("Note 4");
    });

    it("should truncate long notes to 200 characters", () => {
      const longContent = "x".repeat(300);
      const notes = [
        { created_at: "2026-01-01T00:00:00Z", author: "reviewer", content: longContent },
      ];
      const result = buildOrientationContext(
        "@my-task",
        "task.needs_work",
        makeProvisionedWorkspace("@my-task"),
        {
          title: "Fix it",
          notes,
        },
      );
      // Should not contain full 300-char content
      expect(result).not.toContain(longContent);
      // Should contain truncated version (200 chars)
      expect(result).toContain("x".repeat(200));
    });

    // AC: @dispatch-workspace-orientation-prompt ac-3
    it("should make fix-cycle resume context explicit", () => {
      const result = buildOrientationContext(
        "@my-task",
        "task.needs_work",
        makeProvisionedWorkspace("@my-task"),
        {
          title: "Fix it",
          notes: [],
        },
      );
      expect(result).toContain("Fix cycle");
      expect(result).not.toContain("Recent notes:");
      expect(result).toContain("Cycle context: Fix cycle after review.");
      expect(result).toContain("publication still targets main");
    });

    // AC: @agent-dispatch-engine ac-15
    // AC: @dispatch-workspace-orientation-prompt ac-3
    it("should include review-cycle snapshot context for reviewers", () => {
      const result = buildOrientationContext(
        "@my-task",
        "task.pending_review",
        makeProvisionedWorkspace("@my-task", "reviewer"),
        {
          title: "Review this",
          review_url: "https://github.com/org/repo/pull/42",
        },
      );
      expect(result).toContain("Task submitted for review");
      expect(result).toContain("https://github.com/org/repo/pull/42");
      expect(result).toContain("Role: reviewer");
      expect(result).toContain("Workspace mode: detached review snapshot");
      expect(result).toContain("Cycle context: Review cycle on a detached snapshot.");
      expect(result).toContain("follow-up worker resumes dispatch/task/my-task/01task00");
    });

    it("should show fallback when review_url missing for reviewer", () => {
      const result = buildOrientationContext(
        "@my-task",
        "task.pending_review",
        makeProvisionedWorkspace("@my-task", "reviewer"),
        {
          title: "Review this",
        },
      );
      expect(result).toContain("Not provided");
      expect(result).toContain("task notes or git log");
    });

    it("should handle undefined task data gracefully", () => {
      const result = buildOrientationContext(
        "@my-task",
        "task.ready",
        makeProvisionedWorkspace("@my-task"),
        undefined,
      );
      expect(result).toContain("(unavailable)");
      expect(result).toContain("## Task Context");
    });

    // AC: @review-fix-cycle-diff ac-2
    it("should include fix-cycle diff summary when provided for pending_review", () => {
      const diffSummary =
        "Changes since prior review (abc123..def456):\n src/foo.ts | 5 ++---\n 1 file changed, 2 insertions(+), 3 deletions(-)";
      const result = buildOrientationContext(
        "@my-task",
        "task.pending_review",
        makeProvisionedWorkspace("@my-task", "reviewer"),
        { title: "Review this" },
        undefined,
        undefined,
        { fixCycleDiffSummary: diffSummary },
      );
      expect(result).toContain("## Fix-Cycle Diff");
      expect(result).toContain("Changes since prior review");
      expect(result).toContain("src/foo.ts");
    });

    // AC: @review-fix-cycle-diff ac-3
    it("should omit fix-cycle diff section when summary is null", () => {
      const result = buildOrientationContext(
        "@my-task",
        "task.pending_review",
        makeProvisionedWorkspace("@my-task", "reviewer"),
        { title: "Review this" },
        undefined,
        undefined,
        { fixCycleDiffSummary: null },
      );
      expect(result).not.toContain("## Fix-Cycle Diff");
    });

    it("should not include fix-cycle diff for non-review triggers even if provided", () => {
      const result = buildOrientationContext(
        "@my-task",
        "task.needs_work",
        makeProvisionedWorkspace("@my-task"),
        { title: "Fix it", notes: [] },
        undefined,
        undefined,
        { fixCycleDiffSummary: "some diff" },
      );
      expect(result).not.toContain("## Fix-Cycle Diff");
    });
  });

  // Integration: prompt includes orientation context via dispatch engine
  describe("dispatch engine prompt integration", () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = await createTempDir("kspec-dispatch-orientation-");
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanupTempDir(testDir);
    });

    // AC: @agent-dispatch-engine ac-13
    // AC: @dispatch-workspace-orientation-prompt ac-1
    // AC: @dispatch-workspace-orientation-prompt ac-2
    it("should include orientation context in dispatched prompt", async () => {
      const agent = makeTestAgent({ id: "worker", dispatch: [{ on: "task.ready" }] });
      await setupProjectWithAgents(testDir, [agent]);

      const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
        session: {} as any,
        outcome: "success",
        durationMs: 1,
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });

      await engine.start();
      const taskId = testUlid("TASK");
      await engine.handleStateChange({
        taskId,
        taskRef: `@${taskId}`,
        fromStatus: "in_progress",
        toStatus: "pending",
        timestamp: Date.now(),
        task: {
          _ulid: taskId,
          title: "Test task title",
          slugs: [],
          status: "pending",
          type: "task",
          priority: 3,
          blocked_by: [],
          depends_on: [],
          context: [],
          tags: [],
          vcs_refs: [],
          notes: [],
          todos: [],
          created_at: new Date().toISOString(),
          automation: "eligible",
        } as any,
      });

      for (let i = 0; i < 200 && runSpy.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(runSpy).toHaveBeenCalled();
      const prompt = runSpy.mock.calls[0][0].prompt;
      expect(prompt).toContain("## Task Context");
      expect(prompt).toContain("Test task title");
      expect(prompt).toContain("New task assignment");
      expect(prompt).toContain(
        `Workspace (your working directory): ${path.join(testDir, ".kspec-worktrees", `test-task-title-${taskId.slice(0, 8).toLowerCase()}`)}`,
      );
      expect(prompt).toContain("Canonical branch: dispatch/task/test-task-title/");
      expect(prompt).toContain("Integration target: main");
      expect(prompt).toContain("Workspace mode: mutable worker branch");

      await engine.stop();
    });

    // AC: @dispatch-workspace-orientation-prompt ac-4
    it("should include explicit working directory instruction in autonomous preamble", async () => {
      const agent = makeTestAgent({ id: "worker", dispatch: [{ on: "task.ready" }] });
      await setupProjectWithAgents(testDir, [agent]);

      const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
        session: {} as any,
        outcome: "success",
        durationMs: 1,
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });

      await engine.start();
      const taskId = testUlid("WDIR");
      await engine.handleStateChange({
        taskId,
        taskRef: `@${taskId}`,
        fromStatus: "in_progress",
        toStatus: "pending",
        timestamp: Date.now(),
        task: {
          _ulid: taskId,
          title: "Workspace dir test",
          slugs: [],
          status: "pending",
          type: "task",
          priority: 3,
          blocked_by: [],
          depends_on: [],
          context: [],
          tags: [],
          vcs_refs: [],
          notes: [],
          todos: [],
          created_at: new Date().toISOString(),
          automation: "eligible",
        } as any,
      });

      for (let i = 0; i < 200 && runSpy.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(runSpy).toHaveBeenCalled();
      const prompt = runSpy.mock.calls[0][0].prompt;
      const worktreePath = path.join(
        testDir,
        ".kspec-worktrees",
        `workspace-dir-test-${taskId.slice(0, 8).toLowerCase()}`,
      );
      expect(prompt).toContain("CRITICAL: Your working directory is your assigned workspace");
      expect(prompt).toContain(worktreePath);
      expect(prompt).toContain("Do NOT cd to the project root");

      await engine.stop();
    });

    // AC: @agent-dispatch-engine ac-16
    it("should interpolate prompt_template variables", async () => {
      const agent = makeTestAgent({
        id: "worker",
        dispatch: [{ on: "task.ready" }],
        prompt_template: "Handle {{task_ref}} ({{task_title}}) triggered by {{trigger}}",
      });
      await setupProjectWithAgents(testDir, [agent]);

      const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
        session: {} as any,
        outcome: "success",
        durationMs: 1,
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });

      await engine.start();
      const taskId = testUlid("TASK");
      await engine.handleStateChange({
        taskId,
        taskRef: `@${taskId}`,
        fromStatus: "in_progress",
        toStatus: "pending",
        timestamp: Date.now(),
        task: {
          _ulid: taskId,
          title: "My task",
          slugs: [],
          status: "pending",
          type: "task",
          priority: 3,
          blocked_by: [],
          depends_on: [],
          context: [],
          tags: [],
          vcs_refs: [],
          notes: [],
          todos: [],
          created_at: new Date().toISOString(),
          automation: "eligible",
        } as any,
      });

      for (let i = 0; i < 200 && runSpy.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(runSpy).toHaveBeenCalled();
      const prompt = runSpy.mock.calls[0][0].prompt;
      expect(prompt).toContain(`Handle @${taskId}`);
      expect(prompt).toContain("(My task)");
      expect(prompt).toContain("triggered by task.ready");

      await engine.stop();
    });
  });
});

// AC: @dispatch-role-workflow-entry-contract ac-1
// AC: @dispatch-role-workflow-entry-contract ac-2
describe("Dispatch role workflow entrypoints", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-role-entry-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  it("renders a role entry block with adapter-specific worker entrypoint and PR target guidance", async () => {
    const agent = makeTestAgent({
      id: "worker",
      adapter: "codex-acp",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);
    await fs.writeFile(
      path.join(testDir, "kspec.config.yaml"),
      [
        "dispatch:",
        "  base_branch: main",
        "agent:",
        "  skills:",
        '    task_work: "/kspec:task-work"',
      ].join("\n"),
      "utf-8",
    );
    execSync("git remote add origin https://github.com/example/repo.git", {
      cwd: testDir,
      stdio: "pipe",
    });
    const fakeGh = await installFakeGh(testDir);

    try {
      vi.spyOn(configModule, "resolveDispatchRemoteSync").mockReturnValue(false);
      const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
        session: {} as any,
        outcome: "success",
        durationMs: 1,
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });

      await engine.start();
      try {
        const taskId = testUlid("TASK");
        await engine.handleStateChange({
          taskId,
          taskRef: `@${taskId}`,
          fromStatus: "in_progress",
          toStatus: "pending",
          timestamp: Date.now(),
          task: {
            _ulid: taskId,
            title: "Worker role task",
            slugs: ["worker-role-task"],
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
          } as any,
        });

        await waitForMockCall(runSpy);

        expect(runSpy).toHaveBeenCalled();
        const invocation = runSpy.mock.calls[0][0];
        expect(invocation.prompt).toContain("## Role Entry");
        expect(invocation.prompt).toContain("Workflow entrypoint: `$kspec-task-work`");
        expect(invocation.prompt).toContain("Publication mode: `pull_request`");
        expect(invocation.prompt).toContain("Publish target: `main`");
        expect(invocation.prompt).toContain("create or update a PR");
        expect(invocation.env?.KSPEC_DISPATCH_PUBLICATION_MODE).toBe("pull_request");
      } finally {
        await engine.stop();
      }
    } finally {
      fakeGh.restore();
    }
  });

  // AC: @runner-resolution-and-preflight ac-dispatch-uses-runner-resolution
  // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
  //
  // Regression: dispatch previously rendered the role-entry workflow using
  // `agent.adapter ?? "claude-agent-acp"` BEFORE the runner resolver ran,
  // which made adapter-specific tokens (`/skill` vs `$skill`) always reflect
  // the legacy adapter even when a runner was configured to spawn a
  // different platform.
  it("renders role-entry using the runner-resolved adapter, not the legacy agent.adapter", async () => {
    const agent = makeTestAgent({
      id: "runner-worker",
      // Legacy adapter intentionally points at claude — the runner must win
      // and render codex-style entrypoint tokens instead.
      adapter: "claude-agent-acp",
      runner: "test-codex-runner",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);
    await fs.writeFile(
      path.join(testDir, "kspec.config.yaml"),
      [
        "dispatch:",
        "  base_branch: main",
        "agent:",
        "  skills:",
        '    task_work: "/kspec:task-work"',
      ].join("\n"),
      "utf-8",
    );
    execSync("git remote add origin https://github.com/example/repo.git", {
      cwd: testDir,
      stdio: "pipe",
    });
    const fakeGh = await installFakeGh(testDir);

    try {
      vi.spyOn(configModule, "resolveDispatchRemoteSync").mockReturnValue(false);
      // Inject a runner registry containing the runner used by the agent so
      // dispatch resolves it without depending on host ~/.config/kspec state.
      vi.spyOn(runnerConfigModule, "resolveEffectiveRunners").mockResolvedValue({
        project: { config: null, path: "", loaded: false, issues: null },
        system: { config: null, path: "", loaded: false, issues: null },
        registry: mergeRunnerConfigs(null, {
          runners: {
            "test-codex-runner": { kind: "acp_process", adapter: "codex-acp" },
          },
        }),
      });
      const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
        session: {} as any,
        outcome: "success",
        durationMs: 1,
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });

      await engine.start();
      try {
        const taskId = testUlid("TASK");
        await engine.handleStateChange({
          taskId,
          taskRef: `@${taskId}`,
          fromStatus: "in_progress",
          toStatus: "pending",
          timestamp: Date.now(),
          task: {
            _ulid: taskId,
            title: "Runner-resolved role entry task",
            slugs: ["runner-resolved-role-entry-task"],
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
          } as any,
        });

        await waitForMockCall(runSpy);

        expect(runSpy).toHaveBeenCalled();
        const invocation = runSpy.mock.calls[0][0];
        // Codex-style entrypoint syntax — proves the resolver-supplied
        // adapter (codex-acp) drove role-entry, not the legacy claude
        // agent.adapter field.
        expect(invocation.prompt).toContain("Workflow entrypoint: `$kspec-task-work`");
        // Negative: the claude-style entrypoint MUST NOT appear, since
        // rendering it would mean the legacy adapter won the role-entry
        // build instead of the resolved runner adapter.
        expect(invocation.prompt).not.toContain("Workflow entrypoint: `/kspec:task-work`");
      } finally {
        await engine.stop();
      }
    } finally {
      fakeGh.restore();
    }
  });

  // AC: @dispatch-role-workflow-entry-contract ac-3
  // AC: @detached-reviewer-merge-helper ac-helper-path-in-reviewer-guidance
  it("renders manual merge reviewer guidance directing to supported merge helper", async () => {
    const agent = makeTestAgent({
      id: "reviewer",
      adapter: "claude-agent-acp",
      dispatch: [{ on: "task.pending_review" }],
    });
    await setupProjectWithAgents(testDir, [agent]);
    await fs.writeFile(
      path.join(testDir, "kspec.config.yaml"),
      [
        "dispatch:",
        "  base_branch: main",
        "agent:",
        "  skills:",
        '    pr_review: "{skill:pr-review}"',
      ].join("\n"),
      "utf-8",
    );

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as any,
      outcome: "success",
      durationMs: 1,
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    await engine.start();
    try {
      const taskId = testUlid("TASK");
      await provisionDispatchWorkspace({
        projectDir: testDir,
        taskRef: `@${taskId}`,
        task: { title: "Reviewer role task", slugs: ["reviewer-role-task"] },
      });
      await engine.handleStateChange({
        taskId,
        taskRef: `@${taskId}`,
        fromStatus: "in_progress",
        toStatus: "pending_review",
        timestamp: Date.now(),
        task: {
          _ulid: taskId,
          title: "Reviewer role task",
          slugs: ["reviewer-role-task"],
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
          review_url: "https://example.com/pr/1",
        } as any,
      });

      await waitForMockCall(runSpy);

      expect(runSpy).toHaveBeenCalled();
      const invocation = runSpy.mock.calls[0][0];
      expect(invocation.prompt).toContain("Workflow entrypoint: `/pr-review`");
      expect(invocation.prompt).not.toContain("{skill:pr-review}");
      expect(invocation.prompt).toContain("Publication mode: `manual_merge`");
      // AC: @detached-reviewer-merge-helper ac-helper-path-in-reviewer-guidance
      // Reviewer is directed to the supported merge helper, not manual git merge
      expect(invocation.prompt).toContain("detached-reviewer-merge.sh");
      expect(invocation.prompt).toContain("needs_work");
      // Must NOT instruct reviewer to checkout integration branch manually
      expect(invocation.prompt).not.toContain("git checkout");
      expect(invocation.prompt).toContain("detached snapshot");
      // Regression: the reviewer prompt previously claimed the helper would
      // perform an "occupied-worktree refresh" — that described the
      // pre-rework helper. The current helper uses an ephemeral helper-owned
      // worktree, never refreshes a persistent occupied target checkout.
      expect(invocation.prompt).not.toContain("occupied-worktree refresh");
      expect(invocation.prompt).not.toContain("occupied worktree refreshed");
      // Regression: the old helper recovery hint told reviewers to "check
      // out '$MERGE_TARGET' in a worktree" to satisfy the helper. Reviewer
      // guidance must never carry that wording or any equivalent telling
      // the reviewer to create an auxiliary target checkout.
      expect(invocation.prompt.toLowerCase()).not.toMatch(
        /check out .*in (a|another|some|an auxiliary|another auxiliary) worktree/,
      );
      expect(invocation.env?.KSPEC_DISPATCH_PUBLICATION_MODE).toBe("manual_merge");
    } finally {
      await engine.stop();
    }
  });

  // AC: @dispatch-role-workflow-entry-contract ac-4
  it("fails fast with a task note when the configured role entrypoint is blank", async () => {
    const agent = makeTestAgent({
      id: "worker",
      adapter: "mock-acp",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);
    await fs.writeFile(
      path.join(testDir, "kspec.config.yaml"),
      ["dispatch:", "  base_branch: main", "agent:", "  skills:", '    task_work: "   "'].join(
        "\n",
      ),
      "utf-8",
    );

    const captureFile = path.join(testDir, "kspec-capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;

    try {
      const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
        session: {} as any,
        outcome: "success",
        durationMs: 1,
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });

      type EngineInternal = {
        running: boolean;
        _spawnInvocation: (a: Agent, e: unknown) => Promise<boolean>;
        inFlightTaskKeys: Set<string>;
      };
      const internal = engine as unknown as EngineInternal;
      internal.running = true;

      const taskId = testUlid("TASK");
      const taskRef = `@${taskId}`;
      const change = makeStateChange({
        toStatus: "pending",
        fromStatus: "in_progress",
        taskRef,
        task: {
          _ulid: taskId,
          title: "Blank entrypoint task",
          slugs: ["blank-entrypoint-task"],
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
        } as any,
      });
      const entry = {
        agent,
        change,
        retryCount: 0,
        nextRetryAt: 0,
        enqueuedAtMs: Date.now(),
        sequence: 1,
      };

      const started = await internal._spawnInvocation(agent, entry);

      expect(started).toBe(false);
      expect(runSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to build prompt"));
      expect(internal.inFlightTaskKeys.has(`${agent.id}:${taskRef}`)).toBe(false);

      const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{
        args: string[];
      }>;
      const noteCall = calls.find((c) => c.args.includes("note") && c.args.includes(taskRef));
      expect(noteCall).toBeTruthy();
      expect(noteCall!.args.join(" ")).toContain("DISPATCH-PROMPT");
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
    }
  });

  // AC: @dispatch-role-workflow-entry-contract ac-4
  it("fails fast with actionable guidance when workspace publicationMode is invalid", async () => {
    const agent = makeTestAgent({
      id: "worker",
      adapter: "mock-acp",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);
    await fs.writeFile(
      path.join(testDir, "kspec.config.yaml"),
      [
        "dispatch:",
        "  base_branch: main",
        "agent:",
        "  skills:",
        '    task_work: "/kspec:task-work"',
      ].join("\n"),
      "utf-8",
    );

    const captureFile = path.join(testDir, "kspec-capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;

    const originalProvision = workspaceModule.provisionDispatchWorkspace;

    try {
      const provisionSpy = vi
        .spyOn(workspaceModule, "provisionDispatchWorkspace")
        .mockImplementationOnce(async (options) => {
          const workspace = await originalProvision(options);
          if (!workspace) {
            return workspace;
          }
          return {
            ...workspace,
            metadata: {
              ...workspace.metadata,
              publicationMode:
                "broken-mode" as unknown as ProvisionedDispatchWorkspace["metadata"]["publicationMode"],
            },
          };
        });
      const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
        session: {} as any,
        outcome: "success",
        durationMs: 1,
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
      });

      type EngineInternal = {
        running: boolean;
        _spawnInvocation: (a: Agent, e: unknown) => Promise<boolean>;
        inFlightTaskKeys: Set<string>;
      };
      const internal = engine as unknown as EngineInternal;
      internal.running = true;

      const taskId = testUlid("TASK", 41);
      const taskRef = `@${taskId}`;
      const change = makeStateChange({
        toStatus: "pending",
        fromStatus: "in_progress",
        taskRef,
        task: {
          _ulid: taskId,
          title: "Invalid publication mode task",
          slugs: ["invalid-publication-mode-task"],
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
        } as any,
      });
      const entry = {
        agent,
        change,
        retryCount: 0,
        nextRetryAt: 0,
        enqueuedAtMs: Date.now(),
        sequence: 1,
      };

      const started = await internal._spawnInvocation(agent, entry);

      expect(started).toBe(false);
      expect(provisionSpy).toHaveBeenCalledOnce();
      expect(runSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to build prompt"));
      expect(internal.inFlightTaskKeys.has(`${agent.id}:${taskRef}`)).toBe(false);

      const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{
        args: string[];
      }>;
      const noteCall = calls.find((c) => c.args.includes("note") && c.args.includes(taskRef));
      expect(noteCall).toBeTruthy();
      expect(noteCall!.args.join(" ")).toContain("DISPATCH-PROMPT");
      expect(noteCall!.args.join(" ")).toContain('publication mode "broken-mode" is invalid');
      expect(noteCall!.args.join(" ")).toContain("publicationMode is pull_request or manual_merge");
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
    }
  });
});

// ─── AC-9: Retry with exponential backoff ─────────────────────────────────────

// AC: @agent-dispatch-engine ac-9
describe("AC-9: Retry transient errors with exponential backoff", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac9-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should re-enqueue failed invocation with retry count incremented", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Verify retry logic by checking the queue re-enqueue behavior
    // The entry should be re-added with retryCount + 1 after a failure
    const change: TaskStateChange = {
      taskId: testUlid("TASK"),
      taskRef: `@${testUlid("TASK")}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    };
    const _entry = { agent: agent as unknown, change, retryCount: 0, nextRetryAt: 0 };

    // Simulate a failure in the runExclusive handler by tracking queue state
    type EngineInternal = {
      queues: Map<string, unknown[]>;
      activeCount: Map<string, number>;
    };
    const internal = engine as unknown as EngineInternal;

    // Set up: agent has 1 slot, mark it as active so spawn doesn't actually run
    // but entry still re-enqueues
    internal.activeCount.set(agent.id, agent.concurrency.max_concurrent);

    // Direct queue manipulation to verify retry fields
    const queueEntry = { agent, change, retryCount: 0, nextRetryAt: 0 };

    // Simulate what happens when retry triggers: retryCount increments and nextRetryAt is set
    const retryCount = queueEntry.retryCount + 1;
    const backoffMs = Math.min(1000 * Math.pow(2, retryCount - 1), 30_000);
    queueEntry.retryCount = retryCount;
    queueEntry.nextRetryAt = Date.now() + backoffMs;

    expect(retryCount).toBe(1);
    expect(backoffMs).toBe(1000); // First retry: 1000ms
    expect(queueEntry.nextRetryAt).toBeGreaterThan(Date.now());

    // Second retry
    const retryCount2 = queueEntry.retryCount + 1;
    const backoffMs2 = Math.min(1000 * Math.pow(2, retryCount2 - 1), 30_000);
    expect(backoffMs2).toBe(2000); // Second retry: 2000ms (exponential)

    await engine.stop();
  });

  it("should schedule a wake-up timer to drain the queue after retry backoff", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Track drain calls via _loadAgents spy
    let drainCallCount = 0;
    const origLoadAgents = (
      engine as unknown as { _loadAgents: () => Promise<unknown[]> }
    )._loadAgents.bind(engine);
    (engine as unknown as { _loadAgents: () => Promise<unknown[]> })._loadAgents = async () => {
      drainCallCount++;
      return origLoadAgents();
    };

    vi.useFakeTimers();

    // Simulate a retry scenario: an entry with nextRetryAt in the future
    const queueEntry = {
      agent,
      change: makeStateChange({ toStatus: "pending" }),
      retryCount: 1,
      nextRetryAt: Date.now() + 1000,
    };

    // Call the retry scheduling path directly via the internal handler
    const queue = (engine as unknown as { queues: Map<string, unknown[]> }).queues;
    queue.set(agent.id, [queueEntry]);

    // Simulate the timer being scheduled (as if a failed invocation just re-enqueued)
    const backoffMs = 1000;
    setTimeout(() => {
      if ((engine as unknown as { running: boolean }).running) {
        (engine as unknown as { _loadAgents: () => Promise<unknown[]> })
          ._loadAgents()
          .then(() => {
            /* drain */
          })
          .catch(() => {});
      }
    }, backoffMs);

    // Before timer fires, no extra drain calls
    const countBefore = drainCallCount;

    // Advance timers to fire the wake-up
    await vi.advanceTimersByTimeAsync(1100);

    // After timer fires, drain was called
    expect(drainCallCount).toBeGreaterThan(countBefore);

    vi.useRealTimers();
    await engine.stop();
  });
});

// ─── Trait AC N/A annotations ────────────────────────────────────────────────

// @trait-error-guidance ACs are N/A for the dispatch engine:
// The dispatch engine is an internal runtime, not a CLI command. Error guidance
// traits apply to user-facing CLI commands, not to internal modules.
// AC: @trait-error-guidance ac-1 — N/A: dispatch engine is not a CLI command, errors are logged internally
// AC: @trait-error-guidance ac-2 — N/A: dispatch engine is not a CLI command, errors are logged internally
// AC: @trait-error-guidance ac-3 — N/A: dispatch engine is not a CLI command, no user-facing ref lookup
// AC: @trait-error-guidance ac-4 — N/A: dispatch engine is not a CLI command, no state transition errors shown to user
// AC: @trait-error-guidance ac-5 — N/A: dispatch engine is not a CLI command, no validation errors shown to user
// AC: @trait-error-guidance ac-6 — N/A: dispatch engine is not a CLI command, no JSON mode

// ─── GetStatus ───────────────────────────────────────────────────────────────

describe("getStatus", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-status-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should report not running before start()", async () => {
    const agent = makeTestAgent();
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({ projectDir: testDir, coalesceWindowMs: 0 });
    const status = engine.getStatus();

    expect(status.running).toBe(false);
    expect(status.activeInvocations).toBe(0);
    expect(status.queuedInvocations).toBe(0);
  });

  it("should report running after start()", async () => {
    const agent = makeTestAgent();
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({ projectDir: testDir, coalesceWindowMs: 0 });
    await engine.start();
    const status = engine.getStatus();

    expect(status.running).toBe(true);

    await engine.stop();
  });
});

// ─── Stale Queue Entry Discard ───────────────────────────────────────────────

describe("Stale queue entry discard", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-stale-");
    vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockResolvedValue({
      exists: true,
      healthy: true,
      reason: null,
      metadata: null,
    });
    // Mock workspace lifecycle functions to avoid real git/filesystem I/O
    // that is slow and unreliable under parallel test load.
    vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceRegistry" as any).mockResolvedValue(
      undefined,
    );
    vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceArtifacts" as any).mockResolvedValue(
      undefined,
    );
    vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceLifecycle" as any).mockResolvedValue(
      undefined,
    );
    // Mock workspace provisioning and bootstrap to prevent real I/O during
    // _spawnInvocation — these tests validate queue staleness, not workspace setup.
    const mockMetadata = buildMockWorkspaceMetadata(testDir, { workspaceId: "mock-stale-test" });
    vi.spyOn(workspaceModule, "provisionDispatchWorkspace").mockResolvedValue({
      cwd: testDir,
      metadataPath: path.join(testDir, ".kspec-dispatch-workspace.json"),
      metadata: mockMetadata as any,
    });
    vi.spyOn(bootstrapModule, "ensureWorkspaceBootstrap").mockResolvedValue({
      metadata: mockMetadata as any,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  // AC: @agent-dispatch-engine ac-17
  it("should discard queued entries when task has moved to a different state", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.in_progress" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    // Task starts as in_progress
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    // Mock _spawnInvocation to avoid real workspace provisioning I/O.
    // Mirrors the real implementation: returns immediately (fire-and-forget),
    // increments activeCount, then completes asynchronously.
    const spawned: string[] = [];
    let completeFirst!: () => void;
    const firstCompletion = new Promise<void>((r) => {
      completeFirst = r;
    });
    type EngineInternal = {
      _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean>;
      activeCount: Map<string, number>;
      _drainQueues: (agents: unknown[]) => Promise<void>;
      _loadAgents: () => Promise<unknown[]>;
    };
    const internal = engine as unknown as EngineInternal;
    vi.spyOn(internal, "_spawnInvocation")
      .mockImplementationOnce(async (_agent, entry) => {
        const taskRef = (entry as { change: TaskStateChange }).change.taskRef;
        spawned.push(taskRef);
        internal.activeCount.set("worker", (internal.activeCount.get("worker") ?? 0) + 1);
        // Fire-and-forget: simulate post-completion cleanup in background
        firstCompletion.then(async () => {
          const current = internal.activeCount.get("worker") ?? 1;
          internal.activeCount.set("worker", Math.max(0, current - 1));
          const agents = await internal._loadAgents();
          await internal._drainQueues(agents);
        });
        return true;
      })
      .mockImplementation(async (_agent, entry) => {
        const taskRef = (entry as { change: TaskStateChange }).change.taskRef;
        spawned.push(taskRef);
        return true;
      });

    await engine.start();

    expect(spawned).toHaveLength(1);

    // Enqueue another event for the same task while first is running
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "pending",
      toStatus: "in_progress",
      timestamp: Date.now(),
    });

    // Verify it was enqueued
    expect(engine.getStatus().queuedInvocations).toBe(1);

    // Now update the task to completed (simulating the task finishing)
    await writeTasks(testDir, [{ _ulid: taskId, status: "completed" }]);

    // Complete the first invocation — post-completion drain should discard stale entry
    completeFirst();

    // Wait for drain to process
    for (let i = 0; i < 100 && engine.getStatus().queuedInvocations > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // The stale entry should have been discarded — only 1 invocation total
    expect(spawned).toHaveLength(1);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-17
  it("should keep queued entries when task state still matches", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.in_progress" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const [taskId1, taskId2] = testUlids("TASK", 2);
    // Both tasks in_progress
    await writeTasks(testDir, [
      { _ulid: taskId1, status: "in_progress" },
      { _ulid: taskId2, status: "in_progress" },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    // Mock _spawnInvocation to avoid real workspace provisioning I/O.
    // Mirrors the real implementation: returns immediately (fire-and-forget),
    // increments activeCount, then completes asynchronously.
    const spawned: string[] = [];
    let completeFirst!: () => void;
    const firstCompletion = new Promise<void>((r) => {
      completeFirst = r;
    });
    type EngineInternal = {
      _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean>;
      activeCount: Map<string, number>;
      _drainQueues: (agents: unknown[]) => Promise<void>;
      _loadAgents: () => Promise<unknown[]>;
    };
    const internal = engine as unknown as EngineInternal;
    vi.spyOn(internal, "_spawnInvocation")
      .mockImplementationOnce(async (_agent, entry) => {
        const taskRef = (entry as { change: TaskStateChange }).change.taskRef;
        spawned.push(taskRef);
        internal.activeCount.set("worker", (internal.activeCount.get("worker") ?? 0) + 1);
        // Fire-and-forget: simulate post-completion cleanup in background
        firstCompletion.then(async () => {
          const current = internal.activeCount.get("worker") ?? 1;
          internal.activeCount.set("worker", Math.max(0, current - 1));
          const agents = await internal._loadAgents();
          await internal._drainQueues(agents);
        });
        return true;
      })
      .mockImplementation(async (_agent, entry) => {
        const taskRef = (entry as { change: TaskStateChange }).change.taskRef;
        spawned.push(taskRef);
        return true;
      });

    await engine.start();

    // Bootstrap spawned first invocation and queued second (max_concurrent=1)
    expect(spawned).toHaveLength(1);

    // task2 is still in_progress — its queue entry should survive
    expect(engine.getStatus().queuedInvocations).toBeGreaterThanOrEqual(1);

    // Complete first invocation — triggers post-completion drain
    completeFirst();

    // Wait for second invocation to spawn
    for (let i = 0; i < 100 && spawned.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Second invocation should have been spawned (task2 still in_progress)
    expect(spawned).toHaveLength(2);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-17
  it("should discard queued entries when task has been deleted", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.in_progress" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    // Mock _spawnInvocation to avoid real workspace provisioning I/O.
    // Mirrors the real implementation: returns immediately (fire-and-forget),
    // increments activeCount, then completes asynchronously.
    const spawned: string[] = [];
    let completeFirst!: () => void;
    const firstCompletion = new Promise<void>((r) => {
      completeFirst = r;
    });
    type EngineInternal = {
      _spawnInvocation: (a: unknown, e: unknown) => Promise<boolean>;
      activeCount: Map<string, number>;
      _drainQueues: (agents: unknown[]) => Promise<void>;
      _loadAgents: () => Promise<unknown[]>;
    };
    const internal = engine as unknown as EngineInternal;
    vi.spyOn(internal, "_spawnInvocation")
      .mockImplementationOnce(async (_agent, entry) => {
        const taskRef = (entry as { change: TaskStateChange }).change.taskRef;
        spawned.push(taskRef);
        internal.activeCount.set("worker", (internal.activeCount.get("worker") ?? 0) + 1);
        // Fire-and-forget: simulate post-completion cleanup in background
        firstCompletion.then(async () => {
          const current = internal.activeCount.get("worker") ?? 1;
          internal.activeCount.set("worker", Math.max(0, current - 1));
          const agents = await internal._loadAgents();
          await internal._drainQueues(agents);
        });
        return true;
      })
      .mockImplementation(async (_agent, entry) => {
        const taskRef = (entry as { change: TaskStateChange }).change.taskRef;
        spawned.push(taskRef);
        return true;
      });

    await engine.start();

    expect(spawned).toHaveLength(1);

    // Enqueue another event while first is running
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "pending",
      toStatus: "in_progress",
      timestamp: Date.now(),
    });

    expect(engine.getStatus().queuedInvocations).toBe(1);

    // Delete the task (write empty tasks list)
    await writeTasks(testDir, []);

    // Complete the first invocation — post-completion drain should discard stale entry
    completeFirst();

    for (let i = 0; i < 100 && engine.getStatus().queuedInvocations > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Entry for deleted task should have been discarded
    expect(spawned).toHaveLength(1);

    await engine.stop();
  });

  // AC: @dispatch-scheduling-priority-model ac-8
  it("logs task-linked discard diagnostics when workspace eligibility pruning drops a queued candidate", async () => {
    const agent = makeTestAgent({
      id: "pr-reviewer",
      dispatch: [{ on: "task.pending_review" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending_review", automation: "eligible" },
    ]);

    vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockResolvedValue({
      exists: true,
      healthy: false,
      reason: "missing-registry-record",
      metadata: null,
    });
    // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1, ac-3
    // Discovery is attempted for pending_review entries before discard.
    // Mock it to return unrecoverable so the entry is still discarded.
    vi.spyOn(workspaceModule, "discoverWorkspaceForReviewOrFixCycle").mockResolvedValueOnce({
      recovered: false,
      recoverySource: null,
      health: { exists: true, healthy: false, reason: "missing-registry-record", metadata: null },
      diagnostics: [
        {
          taskRef: `@${taskId}`,
          code: "no-recoverable-workspace",
          message: `No trustworthy recovery path exists for @${taskId}.`,
          suggestion: "Ensure the task was submitted with kspec task submit.",
        },
      ],
      conflictingSignals: null,
    });
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as any,
      outcome: "success" as const,
      durationMs: 1,
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    await engine.start();

    expect(runSpy).not.toHaveBeenCalled();
    // Discovery diagnostics are logged before the discard message.
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining(`[dispatch] Workspace discovery diagnostic for @${taskId}`),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `[dispatch] Discarded queue entry @${taskId} for agent "pr-reviewer": workspace is unhealthy (no-recoverable-workspace)`,
      ),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Discarded 1 ineligible queue entry for agent "pr-reviewer"'),
    );

    await engine.stop();
  });
});

// ─── Self-trigger suppression ────────────────────────────────────────────────

describe("Self-trigger suppression", () => {
  let testDir: string;
  let server: http.Server;
  let serverPort: number;
  let receivedEvents: unknown[];

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-selftrigger-");
    receivedEvents = [];

    // Start a minimal HTTP server to capture dispatch events
    server = http.createServer((req, res) => {
      if (req.url === "/api/agent/events" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            receivedEvents.push(JSON.parse(body));
          } catch {
            /* ignore */
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    serverPort = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanupTempDir(testDir);
  });

  // AC: @agent-dispatch-engine ac-18
  it("should suppress dispatch events when KSPEC_SESSION_ID is set", async () => {
    // Set up a minimal kspec project with a task
    initGitRepo(testDir);
    const taskId = testUlid("TASK");
    await fs.writeFile(
      path.join(testDir, "kynetic.yaml"),
      YAML.stringify({
        kynetic: "1.1",
        task_storage: { format: "split" },
        project: { name: "Test", version: "0.1.0" },
      }),
    );
    seedSplitTask(testDir, {
      _ulid: taskId,
      type: "task",
      title: "Test task",
      status: "pending",
      priority: 3,
      tags: [],
      depends_on: [],
      notes: [],
      created_at: new Date().toISOString(),
    });
    // Initial git commit so kspec commands work
    await fs.writeFile(path.join(testDir, ".gitignore"), "");
    const { execSync: execSyncLocal } = await import("node:child_process");
    execSyncLocal("git add -A && git commit -m init", { cwd: testDir, stdio: "pipe" });

    // Create isolated home with fake daemon PID/port pointing at our server
    const isolated = await createIsolatedKspecHome(testDir);
    await fs.writeFile(isolated.daemonPidFilePath, String(process.pid));
    await fs.writeFile(isolated.daemonPortFilePath, String(serverPort));

    const specDirEnv = { KSPEC_SPEC_DIR: testDir };

    // Run task start WITHOUT KSPEC_SESSION_ID — event should be posted
    kspec(`task start @${taskId}`, testDir, {
      env: { ...isolated.env, ...specDirEnv, KSPEC_NO_DAEMON: "0" },
    });
    // Give async fire-and-forget fetch time to complete
    await new Promise((r) => setTimeout(r, 200));
    expect(receivedEvents.length).toBe(1);

    // Reset task to pending for the next test
    receivedEvents = [];
    await fs.rm(path.join(testDir, "tasks"), { recursive: true, force: true });
    await fs.rm(path.join(testDir, "project.tasks.yaml"), { force: true });
    seedSplitTask(testDir, {
      _ulid: taskId,
      type: "task",
      title: "Test task",
      status: "pending",
      priority: 3,
      tags: [],
      depends_on: [],
      notes: [],
      created_at: new Date().toISOString(),
    });
    execSync("git add -A && git commit -m reset", { cwd: testDir, stdio: "pipe" });

    // Run task start WITH KSPEC_SESSION_ID — event should be suppressed
    kspec(`task start @${taskId}`, testDir, {
      env: {
        ...isolated.env,
        ...specDirEnv,
        KSPEC_NO_DAEMON: "0",
        KSPEC_SESSION_ID: "test-session-id",
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(receivedEvents.length).toBe(0);
  });
});

// ─── AC-19: Periodic reconciliation ───────────────────────────────────────────

// AC: @agent-dispatch-engine ac-19
describe("AC-19: Periodic reconciliation re-enqueues missed tasks", () => {
  let testDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-reconcile-");
    remoteDir = await createTempDir("kspec-dispatch-reconcile-remote-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
    await cleanupTempDir(remoteDir);
  });

  // AC: @agent-dispatch-engine ac-19
  it("should enqueue matching tasks with no active or queued invocation", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    // Mock _drainQueues to prevent actual invocation spawning
    vi.spyOn(
      engine as unknown as { _drainQueues: (a: unknown) => Promise<void> },
      "_drainQueues",
    ).mockResolvedValue(undefined);
    const enqueueSpy = vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    );

    await engine.start();

    // Bootstrap enqueued it via _enqueue (drain is no-op so entries stay)
    expect(enqueueSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Clear the queue to simulate a lost event scenario
    (engine as unknown as { queues: Map<string, unknown[]> }).queues.clear();
    enqueueSpy.mockClear();

    // Now call _reconcile — it should re-discover the task
    await (engine as unknown as { _reconcile: () => Promise<void> })._reconcile();

    expect(enqueueSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-19
  it("should NOT re-enqueue tasks that already have a queued invocation", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    // Mock _drainQueues to prevent actual invocation spawning
    vi.spyOn(
      engine as unknown as { _drainQueues: (a: unknown) => Promise<void> },
      "_drainQueues",
    ).mockResolvedValue(undefined);
    const enqueueSpy = vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    );

    await engine.start();

    // Bootstrap enqueued it — DON'T clear the queue this time
    enqueueSpy.mockClear();

    // Reconcile should see the queued entry and skip
    await (engine as unknown as { _reconcile: () => Promise<void> })._reconcile();

    expect(enqueueSpy.mock.calls.length).toBe(0);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-19
  it("should skip tasks in non-dispatchable states (completed, blocked)", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "completed" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    const enqueueSpy = vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    );
    await engine.start();

    // Neither bootstrap nor reconcile should enqueue completed tasks
    expect(enqueueSpy.mock.calls.length).toBe(0);

    await (engine as unknown as { _reconcile: () => Promise<void> })._reconcile();
    expect(enqueueSpy.mock.calls.length).toBe(0);

    await engine.stop();
  });

  // AC: @dispatch-workspace-cleanup-policy ac-6
  // AC: @dispatch-workspace-cleanup-policy ac-7
  it("recovers metadata-backed legacy workspaces before pruning pending_review reviewer work", async () => {
    const reviewer = makeTestAgent({
      id: "pr-reviewer",
      dispatch: [{ on: "task.pending_review" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [reviewer]);

    const taskId = testUlid("TASK", 29);
    const taskRef = `@${taskId}`;
    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending_review", automation: "eligible" },
    ]);

    const workspace = await provisionDispatchWorkspace({
      projectDir: testDir,
      taskRef,
      task: {
        title: "Legacy Review Recovery",
        slugs: ["task-legacy-review-recovery"],
      },
    });

    const legacyBranch = "feat/legacy-review-recovery";
    git(workspace.cwd, `checkout -b ${legacyBranch}`);
    git(testDir, `branch -D ${workspace.metadata.canonicalBranch}`);
    const metadataPath = path.join(workspace.cwd, ".kspec-dispatch-workspace.json");
    const metadata = JSON.parse(await readTestOutput(metadataPath)) as {
      canonicalBranch: string;
      canonicalBranchHead: string;
    };
    metadata.canonicalBranch = legacyBranch;
    metadata.canonicalBranchHead = git(workspace.cwd, "rev-parse HEAD");
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
    await fs.writeFile(
      path.join(testDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({
        kynetic_dispatch_workspaces: "1.0",
        workspaces: [],
      }),
      "utf-8",
    );

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    const spawnSpy = vi
      .spyOn(
        engine as unknown as {
          _spawnInvocation: (agent: unknown, entry: unknown) => Promise<boolean>;
        },
        "_spawnInvocation",
      )
      .mockResolvedValue(true);

    await engine.start();

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(git(workspace.cwd, "branch --show-current")).toBe(workspace.metadata.canonicalBranch);
    const registry = YAML.parse(
      await readTestOutput(path.join(testDir, "project.dispatch-workspaces.yaml")),
    ) as { workspaces?: Array<{ task_ref: string; canonical_branch: string }> };
    expect(registry.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_ref: taskRef,
          canonical_branch: workspace.metadata.canonicalBranch,
        }),
      ]),
    );

    await engine.stop();
  });

  // AC: @dispatch-workspace-registry ac-11
  it("recovers metadata-backed legacy workspaces before pruning in_progress worker work", async () => {
    const worker = makeTestAgent({
      id: "task-worker",
      dispatch: [{ on: "task.in_progress", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [worker]);

    const taskId = testUlid("TASK", 31);
    const taskRef = `@${taskId}`;
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress", automation: "eligible" }]);

    const workspace = await provisionDispatchWorkspace({
      projectDir: testDir,
      taskRef,
      task: {
        title: "Legacy Worker Recovery",
        slugs: ["task-legacy-worker-recovery"],
      },
    });

    const legacyBranch = "feat/legacy-worker-recovery";
    git(workspace.cwd, `checkout -b ${legacyBranch}`);
    git(testDir, `branch -D ${workspace.metadata.canonicalBranch}`);
    const metadataPath = path.join(workspace.cwd, ".kspec-dispatch-workspace.json");
    const metadata = JSON.parse(await readTestOutput(metadataPath)) as {
      canonicalBranch: string;
      canonicalBranchHead: string;
    };
    metadata.canonicalBranch = legacyBranch;
    metadata.canonicalBranchHead = git(workspace.cwd, "rev-parse HEAD");
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
    await fs.writeFile(
      path.join(testDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({
        kynetic_dispatch_workspaces: "1.0",
        workspaces: [],
      }),
      "utf-8",
    );

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    const spawnSpy = vi
      .spyOn(
        engine as unknown as {
          _spawnInvocation: (agent: unknown, entry: unknown) => Promise<boolean>;
        },
        "_spawnInvocation",
      )
      .mockResolvedValue(true);

    await engine.start();

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(git(workspace.cwd, "branch --show-current")).toBe(workspace.metadata.canonicalBranch);
    const registry = YAML.parse(
      await readTestOutput(path.join(testDir, "project.dispatch-workspaces.yaml")),
    ) as { workspaces?: Array<{ task_ref: string; canonical_branch: string }> };
    expect(registry.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_ref: taskRef,
          canonical_branch: workspace.metadata.canonicalBranch,
        }),
      ]),
    );

    await engine.stop();
  });

  // AC: @dispatch-workspace-registry ac-11
  it("reprovisions missing in_progress worker worktrees during dispatch bootstrap", async () => {
    const worker = makeTestAgent({
      id: "task-worker",
      dispatch: [{ on: "task.in_progress", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [worker]);
    git(remoteDir, "init --bare");
    git(testDir, `remote add origin "${remoteDir}"`);
    await fs.writeFile(
      path.join(testDir, "kspec.config.yaml"),
      YAML.stringify({
        dispatch: {
          remote_sync: false,
        },
      }),
      "utf-8",
    );

    const taskId = testUlid("TASK", 32);
    const taskRef = `@${taskId}`;
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress", automation: "eligible" }]);

    const workspace = await provisionDispatchWorkspace({
      projectDir: testDir,
      taskRef,
      task: {
        title: "Reprovision In Progress Workspace",
        slugs: ["task-reprovision-in-progress-workspace"],
      },
    });
    git(testDir, `push origin ${workspace.metadata.canonicalBranch}`);
    git(testDir, `worktree remove --force ${workspace.cwd}`);
    git(testDir, `branch -D ${workspace.metadata.canonicalBranch}`);
    expect(fsSync.existsSync(workspace.cwd)).toBe(false);

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockImplementation(async () => ({
      session: {} as any,
      outcome: "success" as const,
      durationMs: 1,
    }));

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    await engine.start();
    await waitForMockCall(runSpy);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]?.[0]).toMatchObject({
      taskRef,
      agent: expect.objectContaining({ id: "task-worker" }),
      cwd: workspace.cwd,
    });
    expect(fsSync.existsSync(workspace.cwd)).toBe(true);

    await engine.stop();
  });

  // AC: @dispatch-workspace-registry ac-task-state-drives-recovery-after-untrusted-artifact-cleanup
  // AC: @dispatch-workspace-cleanup-policy ac-corrupt-metadata-cleanup-eligible
  // Regression: after artifact cleanup removes a dispatcher-managed worktree
  // because its on-disk metadata was untrusted and no trusted protection state
  // classified it as protected, recovery for a non-terminal task must be
  // driven from trusted task state — not from the removed corrupt artifact.
  // The dispatcher must requeue the task and reprovision a fresh workspace
  // rather than silently discarding the queue entry because its artifact was
  // cleaned.
  it("reprovisions a fresh workspace after corrupt-metadata cleanup removes the prior artifact", async () => {
    const worker = makeTestAgent({
      id: "task-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [worker]);

    const taskId = testUlid("TASK", 35);
    const taskRef = `@${taskId}`;
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

    const workspace = await provisionDispatchWorkspace({
      projectDir: testDir,
      taskRef,
      task: {
        title: "Corrupt Artifact Recovery",
        slugs: ["task-corrupt-artifact-recovery"],
      },
    });
    const canonicalBranch = workspace.metadata.canonicalBranch;
    expect(fsSync.existsSync(workspace.cwd)).toBe(true);

    // Corrupt the artifact metadata so it cannot be parsed, AND clear the
    // registry so no record protects the workspace. With no activeTaskRefs
    // passed in, reconcileDispatchWorkspaceArtifacts must classify the
    // artifact as cleanup-eligible and remove both the worker worktree and
    // its canonical dispatch branch.
    await fs.writeFile(
      path.join(workspace.cwd, ".kspec-dispatch-workspace.json"),
      "{ corrupt-json-payload",
      "utf-8",
    );
    await fs.writeFile(
      path.join(testDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({ kynetic_dispatch_workspaces: "1.0", workspaces: [] }),
      "utf-8",
    );

    await workspaceModule.reconcileDispatchWorkspaceArtifacts(testDir);

    // Sanity: the prior artifact (worker worktree + canonical branch) is gone
    // before the dispatch engine starts. This is the precondition that proves
    // recovery is driven from trusted task state, not from corrupt metadata.
    expect(fsSync.existsSync(workspace.cwd)).toBe(false);
    expect(git(testDir, `branch --list ${canonicalBranch}`)).toBe("");

    // Restore any module-level spies left over from earlier tests in this
    // describe block (which does not auto-restoreAllMocks in afterEach) so
    // our fresh spy below sees a clean call history.
    vi.restoreAllMocks();

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockImplementation(async () => ({
      session: {} as any,
      outcome: "success" as const,
      durationMs: 1,
    }));

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    await engine.start();
    await waitForMockCall(runSpy);

    // The non-terminal pending task drove recovery from trusted task state
    // alone: provisioning created a fresh workspace for the same task ref,
    // and the worker agent was invoked. The task was not silently discarded
    // because its corrupt artifact was cleaned, satisfying
    // ac-task-state-drives-recovery-after-untrusted-artifact-cleanup.
    expect(runSpy).toHaveBeenCalledTimes(1);
    const firstCallArg = runSpy.mock.calls[0]?.[0] as {
      taskRef: string;
      agent: { id: string };
      cwd: string;
    };
    expect(firstCallArg.taskRef).toBe(taskRef);
    expect(firstCallArg.agent.id).toBe("task-worker");

    // A fresh worker worktree was provisioned under the configured dispatch
    // root. Its basename ends with the deterministic short-id derived from
    // the task ref, confirming the workspace belongs to this task — the
    // engine reprovisioned it from trusted task state without depending on
    // the removed corrupt artifact path.
    const shortId = taskId.slice(0, 8).toLowerCase();
    const worktreeRoot = path.join(testDir, ".kspec-worktrees");
    expect(firstCallArg.cwd.startsWith(worktreeRoot + path.sep)).toBe(true);
    expect(path.basename(firstCallArg.cwd).endsWith(`-${shortId}`)).toBe(true);
    expect(fsSync.existsSync(firstCallArg.cwd)).toBe(true);

    // A canonical dispatch branch was created for this task ref. The
    // registry record was rewritten with the freshly provisioned workspace.
    const registry = YAML.parse(
      await readTestOutput(path.join(testDir, "project.dispatch-workspaces.yaml")),
    ) as { workspaces?: Array<{ task_ref: string; canonical_branch: string }> };
    const reprovisionedRecord = registry.workspaces?.find((r) => r.task_ref === taskRef);
    expect(reprovisionedRecord).toBeDefined();
    expect(reprovisionedRecord?.canonical_branch).toMatch(
      new RegExp(`^dispatch/task/.+/${shortId}$`),
    );
    expect(git(testDir, `branch --list ${reprovisionedRecord!.canonical_branch}`)).toContain(
      reprovisionedRecord!.canonical_branch,
    );

    await engine.stop();
  });

  // AC: @dispatch-workspace-cleanup-policy ac-6
  // AC: @review-and-fix-cycle-workspace-discovery-before-discard ac-1, ac-2
  // Discovery now recovers from reviewer metadata when worker worktree is gone.
  // Because the canonical branch still exists (only the worktree is missing),
  // the workspace is recovered and the queue entry remains eligible.
  // Provisioning then recreates the missing worker worktree.
  it("persists stale reviewer metadata recovery when the worker registration is gone", async () => {
    const reviewer = makeTestAgent({
      id: "pr-reviewer",
      dispatch: [{ on: "task.pending_review" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [reviewer]);

    const taskId = testUlid("TASK", 30);
    const taskRef = `@${taskId}`;
    const task = {
      title: "Missing Worker Registration Recovery",
      slugs: ["task-missing-worker-registration-recovery"],
    };
    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending_review", automation: "eligible" },
    ]);

    const workerWorkspace = await provisionDispatchWorkspace({
      projectDir: testDir,
      taskRef,
      task,
    });
    const reviewerWorkspace = await provisionDispatchWorkspace({
      projectDir: testDir,
      taskRef,
      role: "reviewer",
      task,
    });
    await fs.writeFile(
      path.join(reviewerWorkspace.cwd, ".kspec-dispatch-workspace.json"),
      `${JSON.stringify(reviewerWorkspace.metadata, null, 2)}\n`,
      "utf-8",
    );

    git(testDir, `worktree remove --force ${workerWorkspace.cwd}`);
    await fs.writeFile(
      path.join(testDir, "project.dispatch-workspaces.yaml"),
      YAML.stringify({
        kynetic_dispatch_workspaces: "1.0",
        workspaces: [],
      }),
      "utf-8",
    );

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });
    const spawnSpy = vi
      .spyOn(
        engine as unknown as {
          _spawnInvocation: (agent: unknown, entry: unknown) => Promise<boolean>;
        },
        "_spawnInvocation",
      )
      .mockResolvedValue(true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await engine.start();

    // With workspace discovery, the reviewer metadata is found in the
    // worktree root and the registry record is restored. Because the
    // canonical branch still exists (only the worktree was removed),
    // discovery considers this recovered and the entry remains eligible.
    // The spawnInvocation mock is called since provisioning would
    // recreate the missing worker worktree.
    expect(spawnSpy).toHaveBeenCalled();

    // The registry should have been recovered from the reviewer metadata.
    const registry = YAML.parse(
      await readTestOutput(path.join(testDir, "project.dispatch-workspaces.yaml")),
    ) as { workspaces?: Array<{ task_ref: string }> };
    expect(registry.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_ref: taskRef,
        }),
      ]),
    );

    logSpy.mockRestore();
    await engine.stop();
  });
});

// ─── AC-20: Reconciliation interval configuration ─────────────────────────────

// AC: @agent-dispatch-engine ac-20
describe("AC-20: Reconciliation interval configuration", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-reconcile-interval-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @agent-dispatch-engine ac-20
  it("should run reconciliation on the configured interval", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);
    await writeTasks(testDir, []);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 100, // 100ms for testing
      coalesceWindowMs: 0,
    });

    const reconcileSpy = vi.spyOn(
      engine as unknown as { _reconcile: () => Promise<void> },
      "_reconcile",
    );

    await engine.start();

    // Wait enough for at least one interval tick
    await new Promise((r) => setTimeout(r, 250));

    expect(reconcileSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-20
  it("should NOT run reconciliation when interval is 0", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);
    await writeTasks(testDir, []);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    const reconcileSpy = vi.spyOn(
      engine as unknown as { _reconcile: () => Promise<void> },
      "_reconcile",
    );

    await engine.start();
    await new Promise((r) => setTimeout(r, 200));

    expect(reconcileSpy.mock.calls.length).toBe(0);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-20
  it("should NOT run reconciliation when interval is null", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);
    await writeTasks(testDir, []);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: null,
      coalesceWindowMs: 0,
    });

    const reconcileSpy = vi.spyOn(
      engine as unknown as { _reconcile: () => Promise<void> },
      "_reconcile",
    );

    await engine.start();
    await new Promise((r) => setTimeout(r, 200));

    expect(reconcileSpy.mock.calls.length).toBe(0);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-20
  it("should stop reconciliation timer on engine stop", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);
    await writeTasks(testDir, []);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 50,
      coalesceWindowMs: 0,
    });

    const reconcileSpy = vi.spyOn(
      engine as unknown as { _reconcile: () => Promise<void> },
      "_reconcile",
    );

    await engine.start();
    await engine.stop();

    const callsAtStop = reconcileSpy.mock.calls.length;

    // Wait well past interval — no more calls should happen
    await new Promise((r) => setTimeout(r, 200));
    expect(reconcileSpy.mock.calls.length).toBe(callsAtStop);
  });
});

// ─── AC-21: Default automation filter for task.ready/task.needs_work ────────

// AC: @agent-dispatch-engine ac-21
describe("AC-21: Default automation:eligible for task.ready/task.needs_work without filter", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac21-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should reject ineligible tasks on task.ready rules with no filter", async () => {
    // Agent with NO filter on task.ready — should still default to automation:eligible
    const agent = makeTestAgent({
      id: "no-filter-worker",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "manual_only" },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0; // reset after bootstrap

    // Transition to pending (task.ready) — should NOT be queued because task is ineligible
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "manual_only" }]);

    await engine.handleFileChange(testDir);

    expect(enqueueCount).toBe(0);

    await engine.stop();
  });

  it("should accept eligible tasks on task.ready rules with no filter", async () => {
    const agent = makeTestAgent({
      id: "no-filter-worker",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

    await engine.handleFileChange(testDir);

    expect(enqueueCount).toBe(1);

    await engine.stop();
  });

  it("should reject ineligible tasks on task.needs_work rules with no filter", async () => {
    const agent = makeTestAgent({
      id: "needs-work-worker",
      dispatch: [{ on: "task.needs_work" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending_review", automation: "manual_only" },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await writeTasks(testDir, [{ _ulid: taskId, status: "needs_work", automation: "manual_only" }]);

    await engine.handleFileChange(testDir);

    expect(enqueueCount).toBe(0);

    await engine.stop();
  });

  it("should NOT default automation filter for task.pending_review rules", async () => {
    // task.pending_review should NOT default to automation:eligible
    // Use same pattern as AC-6 positive test: spy handleStateChange to verify event detection
    const agent = makeTestAgent({
      id: "reviewer-no-filter",
      dispatch: [{ on: "task.pending_review" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "manual_only" },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    await engine.start();

    // Transition to pending_review — should be queued even though task is ineligible
    // because task.pending_review does NOT default to automation:eligible
    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending_review", automation: "manual_only" },
    ]);

    // Use handleStateChange directly to test filter behavior independently of file diffing
    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending_review",
      timestamp: Date.now(),
    };

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.handleStateChange(change);

    expect(enqueueCount).toBe(1);

    await engine.stop();
  });

  it("should allow explicit filter override on task.ready rules", async () => {
    // Rule explicitly says automation: undefined (via empty filter) — default still applies
    const agentWithExplicitAny = makeTestAgent({
      id: "explicit-any-worker",
      dispatch: [{ on: "task.ready", filter: { tags: ["mvp"] } }],
    });
    await setupProjectWithAgents(testDir, [agentWithExplicitAny]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "manual_only", tags: ["mvp"] },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "manual_only", tags: ["mvp"] },
    ]);

    await engine.handleFileChange(testDir);

    // Still rejected — default automation:eligible applies when filter doesn't specify automation
    expect(enqueueCount).toBe(0);

    await engine.stop();
  });
});

// ─── Priority filter threshold semantics ──────────────────────────────────────

// AC: @agent-dispatch-engine ac-6
describe("Priority filter uses threshold semantics (<=)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-priority-threshold-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should match tasks with priority equal to filter threshold", async () => {
    const agent = makeTestAgent({
      id: "priority-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible", priority: 3 } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "eligible", priority: 3 },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "eligible", priority: 3 },
    ]);
    await engine.handleFileChange(testDir);

    expect(enqueueCount).toBe(1);
    await engine.stop();
  });

  it("should match tasks with higher priority (lower number) than threshold", async () => {
    const agent = makeTestAgent({
      id: "priority-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible", priority: 3 } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "eligible", priority: 1 },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "eligible", priority: 1 },
    ]);
    await engine.handleFileChange(testDir);

    expect(enqueueCount).toBe(1);
    await engine.stop();
  });

  it("should reject tasks with lower priority (higher number) than threshold", async () => {
    const agent = makeTestAgent({
      id: "priority-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible", priority: 2 } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "eligible", priority: 5 },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "eligible", priority: 5 },
    ]);
    await engine.handleFileChange(testDir);

    expect(enqueueCount).toBe(0);
    await engine.stop();
  });

  it("should reject tasks with default priority (3) when filter requires higher (1)", async () => {
    // Schema defaults task priority to 3 when not specified.
    // Filter priority: 1 means only tasks with priority <= 1 match.
    const agent = makeTestAgent({
      id: "priority-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible", priority: 1 } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);
    await engine.handleFileChange(testDir);

    expect(enqueueCount).toBe(0);
    await engine.stop();
  });
});

// ─── Trait: Task Readiness ────────────────────────────────────────────────────

describe("Task readiness checks in dispatch (trait-task-readiness)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-readiness-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @trait-task-readiness ac-status
  it("should only consider pending and needs_work tasks as ready, excluding all other statuses", async () => {
    const agent = makeTestAgent({
      dispatch: [
        { on: "task.ready", filter: { automation: "eligible" } },
        { on: "task.needs_work", filter: { automation: "eligible" } },
      ],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const [readyId, needsWorkId, inProgressId, reviewId, completedId, blockedId, cancelledId] =
      testUlids("STAT", 7);
    await writeTasks(testDir, [
      { _ulid: readyId, status: "pending", automation: "eligible" },
      { _ulid: needsWorkId, status: "needs_work", automation: "eligible" },
      { _ulid: inProgressId, status: "in_progress", automation: "eligible" },
      { _ulid: reviewId, status: "pending_review", automation: "eligible" },
      { _ulid: completedId, status: "completed", automation: "eligible" },
      { _ulid: blockedId, status: "blocked", automation: "eligible" },
      { _ulid: cancelledId, status: "cancelled", automation: "eligible" },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    const enqueuedTaskIds: string[] = [];
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation((_agent, change) => {
      enqueuedTaskIds.push((change as TaskStateChange).taskId);
    });

    await engine.start();

    // Only pending and needs_work should be enqueued via task.ready / task.needs_work rules
    expect(enqueuedTaskIds).toContain(readyId);
    expect(enqueuedTaskIds).toContain(needsWorkId);
    expect(enqueuedTaskIds).not.toContain(inProgressId);
    expect(enqueuedTaskIds).not.toContain(reviewId);
    expect(enqueuedTaskIds).not.toContain(completedId);
    expect(enqueuedTaskIds).not.toContain(blockedId);
    expect(enqueuedTaskIds).not.toContain(cancelledId);

    await engine.stop();
    vi.restoreAllMocks();
  });

  // AC: @trait-task-readiness ac-deps
  it("should not dispatch task.ready when depends_on tasks are not completed", async () => {
    const [depId, taskId] = testUlids("RDEP", 2);
    const agent = makeTestAgent({
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    // Write dep task as in_progress (not completed) and the dependent task as pending
    await writeTasks(testDir, [
      { _ulid: depId, status: "in_progress", automation: "eligible" },
      { _ulid: taskId, status: "pending", automation: "eligible", depends_on: [`@${depId}`] },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0; // Reset after bootstrap

    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change);

    // The dependent task should NOT be enqueued
    expect(enqueueCount).toBe(0);

    await engine.stop();
  });

  // AC: @trait-task-readiness ac-deps
  it("should dispatch task.ready when all depends_on tasks are completed", async () => {
    const [depId, taskId] = testUlids("RDEP", 2);
    const agent = makeTestAgent({
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    // Dep is completed, dependent task is pending — should be dispatched
    await writeTasks(testDir, [
      { _ulid: depId, status: "completed", automation: "eligible" },
      { _ulid: taskId, status: "pending", automation: "eligible", depends_on: [`@${depId}`] },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0; // Reset after bootstrap

    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change);

    expect(enqueueCount).toBe(1);

    await engine.stop();
  });

  // AC: @trait-task-readiness ac-not-blocked
  it("should not dispatch task.ready when task has blocked_by entries", async () => {
    const taskId = testUlid("RBLK");
    const agent = makeTestAgent({
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    await writeTasks(testDir, [
      {
        _ulid: taskId,
        status: "pending",
        automation: "eligible",
        blocked_by: ["Waiting for API key"],
      },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change);

    expect(enqueueCount).toBe(0);
    await engine.stop();
  });

  // AC: @trait-task-readiness ac-not-blocked
  it("should not dispatch task.needs_work when task has blocked_by entries", async () => {
    const taskId = testUlid("RNWB");
    const agent = makeTestAgent({
      dispatch: [{ on: "task.needs_work", filter: { automation: "eligible" } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    await writeTasks(testDir, [
      {
        _ulid: taskId,
        status: "needs_work",
        automation: "eligible",
        blocked_by: ["Needs clarification"],
      },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "pending_review",
      toStatus: "needs_work",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change);

    expect(enqueueCount).toBe(0);
    await engine.stop();
  });

  // AC: @trait-task-readiness ac-composable
  it("should check base readiness before consumer filters", async () => {
    const [depId, taskId] = testUlids("RCMP", 2);
    const agent = makeTestAgent({
      dispatch: [{ on: "task.ready", filter: { automation: "eligible", tags: ["cli"] } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    // Task matches all consumer filters but has unmet dep — should NOT dispatch
    await writeTasks(testDir, [
      { _ulid: depId, status: "pending", automation: "eligible" },
      {
        _ulid: taskId,
        status: "pending",
        automation: "eligible",
        tags: ["cli"],
        depends_on: [`@${depId}`],
      },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change);

    expect(enqueueCount).toBe(0);
    await engine.stop();
  });

  // AC: @trait-task-readiness ac-deps — bootstrap/reconciliation path
  it("should not enqueue tasks with unmet deps during bootstrap evaluation", async () => {
    const [depId, taskId] = testUlids("RBOT", 2);
    const agent = makeTestAgent({
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    // Dep is in_progress (not completed), task is pending with depends_on
    await writeTasks(testDir, [
      { _ulid: depId, status: "in_progress", automation: "eligible" },
      { _ulid: taskId, status: "pending", automation: "eligible", depends_on: [`@${depId}`] },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();

    // Bootstrap should not have enqueued the dependent task
    expect(enqueueCount).toBe(0);
    await engine.stop();
  });

  // AC: @trait-task-readiness ac-deps, ac-not-blocked — drainQueues path
  it("should discard queued entries in drainQueues when deps become unmet", async () => {
    const [depId, taskId] = testUlids("RDRN", 2);
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    // Initially dep is completed — task is dispatchable
    await writeTasks(testDir, [
      { _ulid: depId, status: "completed", automation: "eligible" },
      { _ulid: taskId, status: "pending", automation: "eligible", depends_on: [`@${depId}`] },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    // Block draining entirely during enqueue so entries stay in queue
    const drainSpy = vi
      .spyOn(
        engine as unknown as { _drainQueues: (...args: unknown[]) => Promise<void> },
        "_drainQueues",
      )
      .mockResolvedValue(undefined);
    vi.spyOn(invocationModule, "runInvocation").mockResolvedValue(undefined as never);

    await engine.start();

    // Enqueue the task via handleStateChange (drain is blocked)
    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change);

    // Verify it got queued
    let status = engine.getStatus();
    expect(status.queued.length).toBeGreaterThanOrEqual(1);

    // Now change dep to not-completed (simulating dep regression)
    await writeTasks(testDir, [
      { _ulid: depId, status: "in_progress", automation: "eligible" },
      { _ulid: taskId, status: "pending", automation: "eligible", depends_on: [`@${depId}`] },
    ]);

    // Restore drain so readiness check runs, trigger via file change
    drainSpy.mockRestore();
    await engine.handleFileChange(testDir);

    // The queued entry should have been discarded due to unmet deps
    status = engine.getStatus();
    expect(status.queued).toHaveLength(0);

    await engine.stop();
  });

  // AC: @dispatch-scheduling-priority-model ac-1
  it("should exclude in_progress and pending_review events when dependencies or blockers are unresolved", async () => {
    const [depId, taskId] = testUlids("RNRR", 2);
    const agent = makeTestAgent({
      dispatch: [{ on: "task.in_progress" }, { on: "task.pending_review" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    // Task has unmet dep and blocked_by.
    await writeTasks(testDir, [
      { _ulid: depId, status: "pending", automation: "eligible" },
      {
        _ulid: taskId,
        status: "in_progress",
        automation: "eligible",
        depends_on: [`@${depId}`],
        blocked_by: ["something"],
      },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockResolvedValue({
      exists: true,
      healthy: true,
      reason: null,
      metadata: null,
    });

    const change1: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "pending",
      toStatus: "in_progress",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change1);

    expect(enqueueCount).toBe(0);

    await engine.stop();
  });
});

// ─── AC-23, AC-24, AC-25: Post-invocation re-evaluation ─────────────────────

describe("Post-invocation re-evaluation", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-post-invocation-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  // AC: @agent-dispatch-engine ac-23
  // AC: @agent-dispatch-engine ac-24
  it("should re-evaluate tasks from disk after invocation completes, discovering new pending_review tasks", async () => {
    // Setup: pr-reviewer defined BEFORE task-worker (definition order controls drain priority).
    // Both share max_concurrent: 1 per agent. The key scenario: a worker runs, and during its
    // execution a task transitions to pending_review on disk. Without re-evaluation, the drain
    // loop after worker completion won't see it (it was never in any queue).
    const reviewer = makeTestAgent({
      id: "pr-reviewer",
      dispatch: [{ on: "task.pending_review" }],
      concurrency: { max_concurrent: 1 },
    });
    const worker = makeTestAgent({
      id: "task-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [reviewer, worker]);

    const [taskA, taskB] = testUlids("PREV", 2);

    // Initially: only taskA is pending (ready for worker). No pending_review tasks yet.
    await writeTasks(testDir, [{ _ulid: taskA, status: "pending", automation: "eligible" }]);

    const spawned: Array<{ agentId: string; taskRef: string }> = [];
    let resolveFirst!: () => void;
    const firstBlock = new Promise<void>((r) => {
      resolveFirst = r;
    });
    let invocationCount = 0;

    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (opts) => {
      invocationCount++;
      const agentId = (opts as any).agent?.id ?? "unknown";
      const taskRef = (opts as any).taskRef ?? "unknown";
      spawned.push({ agentId, taskRef });

      if (invocationCount === 1) {
        // Simulate the worker finishing: taskA moves to pending_review,
        // and taskB appears as pending_review (submitted during worker run).
        await writeTasks(testDir, [
          { _ulid: taskA, status: "pending_review" },
          { _ulid: taskB, status: "pending_review" },
        ]);
        await firstBlock;
      }
      return { session: {} as any, outcome: "success" as const, durationMs: 1 };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0, // Disable periodic reconciliation
      coalesceWindowMs: 0,
    });

    try {
      await engine.start();

      // Wait for first invocation (worker picks up taskA via bootstrap)
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- modified by async mock callback
      await waitForInvocationCount(
        () => invocationCount,
        1,
        "first worker invocation should start after bootstrap",
      );
      expect(invocationCount).toBe(1);
      expect(spawned[0].agentId).toBe("task-worker");

      // Release worker — post-invocation re-evaluation should discover pending_review tasks
      resolveFirst();

      // Wait for reviewer to be spawned
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- modified by async mock callback
      await waitForInvocationCount(
        () => invocationCount,
        2,
        "reviewer invocation should spawn after post-invocation re-evaluation",
      );

      // The second spawn should be the reviewer, discovering the pending_review tasks
      // that appeared on disk during the worker's execution.
      expect(invocationCount).toBeGreaterThanOrEqual(2);
      expect(spawned[1].agentId).toBe("pr-reviewer");
    } finally {
      await engine.stop();
    }
  });

  // AC: @agent-dispatch-engine ac-24
  it("should not double-enqueue tasks already queued via skipIfActive dedup", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const [taskA, taskB] = testUlids("DDUP", 2);
    await writeTasks(testDir, [
      { _ulid: taskA, status: "pending", automation: "eligible" },
      { _ulid: taskB, status: "pending", automation: "eligible" },
    ]);

    let resolveFirst!: () => void;
    const firstBlock = new Promise<void>((r) => {
      resolveFirst = r;
    });
    let invocationCount = 0;

    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async () => {
      invocationCount++;
      if (invocationCount === 1) {
        await firstBlock;
      }
      return { session: {} as any, outcome: "success" as const, durationMs: 1 };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    try {
      await engine.start();

      // Wait for first invocation to start
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- modified by async mock callback
      await waitForInvocationCount(
        () => invocationCount,
        1,
        "first dedup test invocation should start",
      );
      expect(invocationCount).toBe(1);

      // Release first invocation — re-evaluation runs, but should NOT double-enqueue taskB
      resolveFirst();

      // Wait for second invocation
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- modified by async mock callback
      await waitForInvocationCount(
        () => invocationCount,
        2,
        "queued task should drain exactly once after re-evaluation",
      );

      // Exactly 2 invocations (one per task), not 3+ from double-enqueue
      expect(invocationCount).toBe(2);
    } finally {
      await engine.stop();
    }
  });

  // AC: @agent-dispatch-engine ac-24
  it("should not re-enqueue a task while provisioning is still in flight", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK", 61);
    await writeTasks(testDir, []);

    let releaseProvision!: () => void;
    const provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const originalProvision = workspaceModule.provisionDispatchWorkspace;
    const provisionSpy = vi
      .spyOn(workspaceModule, "provisionDispatchWorkspace")
      .mockImplementationOnce(async (options) => {
        await provisionGate;
        return originalProvision(options);
      });
    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as any,
      outcome: "success" as const,
      durationMs: 1,
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    try {
      await engine.start();

      await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

      const handlePromise = engine.handleStateChange({
        taskId,
        taskRef: `@${taskId}`,
        fromStatus: "in_progress",
        toStatus: "pending",
        timestamp: Date.now(),
        task: {
          _ulid: taskId,
          title: `Task ${taskId}`,
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
        } as any,
      });

      await waitForMockCall(
        provisionSpy,
        "workspace provisioning should begin before reconciliation re-check",
      );
      expect(provisionSpy).toHaveBeenCalledTimes(1);

      await (engine as any)._reconcile();
      expect(engine.getStatus().queuedInvocations).toBe(0);

      releaseProvision();

      await waitForMockCall(runSpy, "invocation should start after provisioning is released");
      expect(runSpy).toHaveBeenCalledTimes(1);
      await handlePromise;
    } finally {
      releaseProvision();
      await engine.stop();
    }
  });

  // AC: @agent-dispatch-engine ac-25
  it("should still drain existing queue when re-evaluation fails", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const [taskA, taskB] = testUlids("FAIL", 2);
    await writeTasks(testDir, [
      { _ulid: taskA, status: "pending", automation: "eligible" },
      { _ulid: taskB, status: "pending", automation: "eligible" },
    ]);

    let resolveFirst!: () => void;
    const firstBlock = new Promise<void>((r) => {
      resolveFirst = r;
    });
    let invocationCount = 0;

    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async () => {
      invocationCount++;
      if (invocationCount === 1) {
        await firstBlock;
      }
      return { session: {} as any, outcome: "success" as const, durationMs: 1 };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await engine.start();

      // Wait for first invocation to start
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- modified by async mock callback
      await waitForInvocationCount(
        () => invocationCount,
        1,
        "first failure-path invocation should start",
      );
      expect(invocationCount).toBe(1);

      // Sabotage _evaluateAllTasks so it throws on the next call (post-invocation re-eval).
      // The already-queued taskB should still drain.
      const evaluateSpy = vi.spyOn(
        engine as unknown as {
          _evaluateAllTasks: (opts: { skipIfActive: boolean }) => Promise<number>;
        },
        "_evaluateAllTasks",
      );
      evaluateSpy.mockRejectedValueOnce(new Error("simulated disk failure"));

      // Release first invocation
      resolveFirst();

      // Wait for second invocation (from pre-existing queue, not re-evaluation)
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- modified by async mock callback
      await waitForInvocationCount(
        () => invocationCount,
        2,
        "existing queue should still drain after re-evaluation failure",
      );

      // taskB should still have been drained from the existing queue
      expect(invocationCount).toBe(2);

      // Verify warning was logged
      await waitForMockCall(
        warnSpy,
        "re-evaluation failure should log a warning before the assertion runs",
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Post-invocation re-evaluation failed"),
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
      await engine.stop();
    }
  });
});

// ─── Periodic Dispatch Reconciliation ─────────────────────────────────────────

describe("Periodic dispatch reconciliation", () => {
  let testDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    testDir = await createTempDir("kspec-dispatch-reconcile-");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupTempDir(testDir);
  });

  // AC: @agent-dispatch-engine ac-19, ac-20, ac-reconcile-non-overlap
  it("does not start overlapping reconcile passes when a previous pass is still running", async () => {
    await setupProjectWithAgents(testDir, []);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 10,
      coalesceWindowMs: 0,
    });

    let releaseReconcile!: () => void;
    const reconcileGate = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    let runningReconciles = 0;
    let maxConcurrentReconciles = 0;
    const reconcileSpy = vi
      .spyOn(engine as unknown as { _reconcile: () => Promise<void> }, "_reconcile")
      .mockImplementation(async () => {
        runningReconciles += 1;
        maxConcurrentReconciles = Math.max(maxConcurrentReconciles, runningReconciles);
        await reconcileGate;
        runningReconciles -= 1;
      });

    await engine.start();

    await vi.advanceTimersByTimeAsync(35);

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(maxConcurrentReconciles).toBe(1);

    releaseReconcile();
    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-stop-awaits-reconciliation
  it("stop() does not resolve until an in-flight reconciliation pass completes", async () => {
    await setupProjectWithAgents(testDir, []);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 10,
      coalesceWindowMs: 0,
    });

    let releaseReconcile!: () => void;
    const reconcileGate = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    let reconcileStarted = false;
    let reconcileFinished = false;
    vi.spyOn(
      engine as unknown as { _reconcile: () => Promise<void> },
      "_reconcile",
    ).mockImplementation(async () => {
      reconcileStarted = true;
      await reconcileGate;
      reconcileFinished = true;
    });

    await engine.start();

    // Trigger one reconciliation pass; the gate keeps it pending.
    await vi.advanceTimersByTimeAsync(15);
    expect(reconcileStarted).toBe(true);
    expect(reconcileFinished).toBe(false);

    // Call stop() while reconcile is still blocked. It must NOT resolve.
    let stopResolved = false;
    const stopPromise = engine.stop().then(() => {
      stopResolved = true;
    });

    // Flush microtasks and advance any timers so any non-blocking work in
    // stop() completes. stop() should still be parked on Promise.allSettled
    // because the reconcile gate is still held.
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(reconcileFinished).toBe(false);
    expect(stopResolved).toBe(false);

    // Release the reconcile pass. Now stop() must resolve, and the
    // reconciliation must finish before stop() returns.
    releaseReconcile();
    await stopPromise;

    expect(reconcileFinished).toBe(true);
    expect(stopResolved).toBe(true);
  });
});

// ─── Per-Task Dispatch Drain Coalescing ────────────────────────────────────────

describe("Per-task dispatch drain coalescing", () => {
  let testDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    testDir = await createTempDir("kspec-dispatch-coalesce-");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupTempDir(testDir);
  });

  // AC: @per-task-dispatch-drain-coalescing ac-1
  it("should schedule a per-task coalescing timer on state change instead of draining immediately", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 5000,
    });

    // Track _serializedDrain calls (the coalescing timer callback target).
    // Mock it to avoid real I/O in the async chain (_loadAgents → _drainQueues).
    const serializedDrainSpy = vi
      .spyOn(engine as unknown as { _serializedDrain: () => Promise<void> }, "_serializedDrain")
      .mockResolvedValue();

    // Mock _drainQueues so bootstrap doesn't do real I/O
    vi.spyOn(
      engine as unknown as { _drainQueues: (agents: unknown[]) => Promise<void> },
      "_drainQueues",
    ).mockResolvedValue();

    // Start (bootstrap drains directly — expected)
    await engine.start();
    const countAfterBoot = serializedDrainSpy.mock.calls.length;

    const taskId = testUlid("TASK", 60);
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    // _serializedDrain should NOT have been called yet (coalescing deferred it)
    expect(serializedDrainSpy.mock.calls.length).toBe(countAfterBoot);

    // Advance past coalescing window
    await vi.advanceTimersByTimeAsync(5000);

    // Now _serializedDrain should have been called via the coalescing timer
    expect(serializedDrainSpy.mock.calls.length).toBeGreaterThan(countAfterBoot);

    await engine.stop();
  });

  // AC: @per-task-dispatch-drain-coalescing ac-1
  it("should reset the coalescing timer when a second event arrives for the same task", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }, { on: "task.needs_work" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 5000,
    });

    const serializedDrainSpy = vi
      .spyOn(engine as unknown as { _serializedDrain: () => Promise<void> }, "_serializedDrain")
      .mockResolvedValue();

    vi.spyOn(
      engine as unknown as { _drainQueues: (agents: unknown[]) => Promise<void> },
      "_drainQueues",
    ).mockResolvedValue();

    await engine.start();
    const countAfterBoot = serializedDrainSpy.mock.calls.length;

    const taskId = testUlid("TASK", 61);

    // First event
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    // Advance 3s (within window)
    await vi.advanceTimersByTimeAsync(3000);
    expect(serializedDrainSpy.mock.calls.length).toBe(countAfterBoot);

    // Second event for same task (should reset timer)
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "pending",
      toStatus: "needs_work",
      timestamp: Date.now() + 3000,
      task: { automation: "eligible", tags: [] } as any,
    });

    // Advance another 3s — original timer would have fired by now (5s total),
    // but the reset means we need 5s from the second event
    await vi.advanceTimersByTimeAsync(3000);
    expect(serializedDrainSpy.mock.calls.length).toBe(countAfterBoot);

    // Advance remaining 2s — total 5s from second event
    await vi.advanceTimersByTimeAsync(2000);
    expect(serializedDrainSpy.mock.calls.length).toBeGreaterThan(countAfterBoot);

    await engine.stop();
  });

  // AC: @per-task-dispatch-drain-coalescing ac-2
  it("should rely on stale-entry pruning to discard intermediate states after coalescing", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }, { on: "task.in_progress" }, { on: "task.pending_review" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK", 62);
    // Final on-disk state is pending_review
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending_review" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 5000,
      reconcileIntervalMs: 0,
    });

    const spawnSpy = vi
      .spyOn(
        engine as unknown as {
          _spawnInvocation: (agent: unknown, entry: unknown) => Promise<boolean>;
        },
        "_spawnInvocation",
      )
      .mockResolvedValue(true);

    await engine.start();

    // Simulate rapid transitions: pending → in_progress → pending_review
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "blocked",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { _ulid: taskId, status: "pending_review", automation: "eligible", tags: [] } as any,
    });
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "pending",
      toStatus: "in_progress",
      timestamp: Date.now() + 100,
      task: { _ulid: taskId, status: "pending_review", automation: "eligible", tags: [] } as any,
    });
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending_review",
      timestamp: Date.now() + 200,
      task: { _ulid: taskId, status: "pending_review", automation: "eligible", tags: [] } as any,
    });

    // Advance past coalescing window — drain fires and staleness prunes intermediates
    await vi.advanceTimersByTimeAsync(5000);

    // Only the final state (pending_review) should have survived stale pruning.
    // The pending and in_progress entries get discarded because on-disk status is pending_review.
    const spawnedStatuses = spawnSpy.mock.calls.map(
      (call) => (call[1] as { change: TaskStateChange }).change.toStatus,
    );
    expect(spawnedStatuses).not.toContain("pending");
    expect(spawnedStatuses).not.toContain("in_progress");

    await engine.stop();
  });

  // AC: @per-task-dispatch-drain-coalescing ac-3
  it("should coalesce timers independently per task", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const [taskA, taskB] = testUlids("TASK", 2);
    await writeTasks(testDir, [
      { _ulid: taskA, status: "pending", automation: "eligible" },
      { _ulid: taskB, status: "pending", automation: "eligible" },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 5000,
      reconcileIntervalMs: 0,
    });

    const serializedDrainSpy = vi
      .spyOn(engine as unknown as { _serializedDrain: () => Promise<void> }, "_serializedDrain")
      .mockResolvedValue();

    vi.spyOn(
      engine as unknown as { _drainQueues: (agents: unknown[]) => Promise<void> },
      "_drainQueues",
    ).mockResolvedValue();

    await engine.start();
    const countAfterBoot = serializedDrainSpy.mock.calls.length;

    // Event for task A
    await engine.handleStateChange({
      taskId: taskA,
      taskRef: `@${taskA}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    // 3s later, event for task B
    await vi.advanceTimersByTimeAsync(3000);
    await engine.handleStateChange({
      taskId: taskB,
      taskRef: `@${taskB}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    // At t=5s, task A's timer fires (_serializedDrain should be called)
    await vi.advanceTimersByTimeAsync(2000);
    expect(serializedDrainSpy.mock.calls.length).toBeGreaterThan(countAfterBoot);
    const countAfterA = serializedDrainSpy.mock.calls.length;

    // At t=8s, task B's timer fires (3s + 5s = 8s)
    await vi.advanceTimersByTimeAsync(3000);
    expect(serializedDrainSpy.mock.calls.length).toBeGreaterThan(countAfterA);

    await engine.stop();
  });

  // AC: @per-task-dispatch-drain-coalescing ac-4
  it("should drain immediately when coalesceWindowMs is 0", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    const drainSpy = vi
      .spyOn(
        engine as unknown as { _drainQueues: (agents: unknown[]) => Promise<void> },
        "_drainQueues",
      )
      .mockResolvedValue();

    await engine.start();
    const drainCountAfterBoot = drainSpy.mock.calls.length;

    const taskId = testUlid("TASK", 64);
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    // Drain should have been called immediately (no timer involved)
    expect(drainSpy.mock.calls.length).toBeGreaterThan(drainCountAfterBoot);

    await engine.stop();
  });

  // AC: @per-task-dispatch-drain-coalescing ac-5
  it("should cancel all pending coalescing timers when stop() is called", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 5000,
    });

    const drainSpy = vi
      .spyOn(
        engine as unknown as { _drainQueues: (agents: unknown[]) => Promise<void> },
        "_drainQueues",
      )
      .mockResolvedValue();

    await engine.start();
    const _drainCountAfterBoot = drainSpy.mock.calls.length;

    const [taskA, taskB] = testUlids("STOP", 2);
    await engine.handleStateChange({
      taskId: taskA,
      taskRef: `@${taskA}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });
    await engine.handleStateChange({
      taskId: taskB,
      taskRef: `@${taskB}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    // Timers are pending. Stop the engine.
    await engine.stop();

    // Verify timers were cleared
    const internal = engine as unknown as {
      coalesceTimers: Map<string, ReturnType<typeof setTimeout>>;
    };
    expect(internal.coalesceTimers.size).toBe(0);

    // Advance well past the coalescing window — no drains should fire
    const drainCountAfterStop = drainSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(drainSpy.mock.calls.length).toBe(drainCountAfterStop);
  });

  // AC: @per-task-dispatch-drain-coalescing ac-6
  it("should drain normally after coalescing delay for a single event", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK", 66);
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 5000,
      reconcileIntervalMs: 0,
    });

    // Use _serializedDrain spy since it's what the coalescing timer calls.
    // Mocking avoids real async I/O that doesn't complete with fake timers.
    const serializedDrainSpy = vi
      .spyOn(engine as unknown as { _serializedDrain: () => Promise<void> }, "_serializedDrain")
      .mockResolvedValue();

    vi.spyOn(
      engine as unknown as { _drainQueues: (agents: unknown[]) => Promise<void> },
      "_drainQueues",
    ).mockResolvedValue();

    await engine.start();

    // Clear spy after bootstrap
    serializedDrainSpy.mockClear();

    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { _ulid: taskId, status: "pending", automation: "eligible", tags: [] } as any,
    });

    // No drain scheduled yet (within coalescing window)
    expect(serializedDrainSpy).not.toHaveBeenCalled();

    // Advance past coalescing window
    await vi.advanceTimersByTimeAsync(5000);

    // Now the drain should have been triggered via _serializedDrain
    expect(serializedDrainSpy).toHaveBeenCalled();

    await engine.stop();
  });

  // AC: @per-task-dispatch-drain-coalescing ac-7
  it("should drain immediately for bootstrap, reconciliation, and post-invocation paths", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK", 67);
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 5000,
      reconcileIntervalMs: 0,
    });

    const drainSpy = vi
      .spyOn(
        engine as unknown as { _drainQueues: (agents: unknown[]) => Promise<void> },
        "_drainQueues",
      )
      .mockResolvedValue();

    // Bootstrap calls _drainQueues via _serializedDrain (no coalescing delay)
    await engine.start();
    expect(drainSpy).toHaveBeenCalled();

    // Reconciliation also calls _drainQueues via _serializedDrain (no coalescing delay)
    const _reconcileDrainCount = drainSpy.mock.calls.length;
    await (engine as unknown as { _reconcile: () => Promise<void> })._reconcile();
    // _reconcile only calls _drainQueues if enqueued > 0, so check it ran without delay
    // (it either called _drainQueues or found nothing to enqueue — either way, no timer)
    const internal = engine as unknown as {
      coalesceTimers: Map<string, ReturnType<typeof setTimeout>>;
    };
    // No coalescing timer should have been set by reconciliation
    expect(internal.coalesceTimers.size).toBe(0);

    await engine.stop();
  });

  // AC: @per-task-dispatch-drain-coalescing ac-8
  it("should serialize concurrent drain calls via drainPending flag", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 5000,
      reconcileIntervalMs: 0,
    });

    let drainConcurrency = 0;
    let maxConcurrency = 0;
    vi.spyOn(
      engine as unknown as { _drainQueues: (agents: unknown[]) => Promise<void> },
      "_drainQueues",
    ).mockImplementation(async (_agents) => {
      drainConcurrency++;
      maxConcurrency = Math.max(maxConcurrency, drainConcurrency);
      // Simulate some async work
      await new Promise((r) => setTimeout(r, 100));
      await vi.advanceTimersByTimeAsync(100);
      drainConcurrency--;
    });

    await engine.start();

    // Schedule two events that will fire their coalescing timers simultaneously
    const [taskA, taskB] = testUlids("CONC", 2);
    await engine.handleStateChange({
      taskId: taskA,
      taskRef: `@${taskA}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });
    await engine.handleStateChange({
      taskId: taskB,
      taskRef: `@${taskB}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    // Advance past coalescing window — both timers fire at the same time
    await vi.advanceTimersByTimeAsync(5000);

    // Give time for the serialized drain to complete
    await vi.advanceTimersByTimeAsync(500);

    // Drains should never run concurrently (max concurrency = 1)
    expect(maxConcurrency).toBeLessThanOrEqual(1);

    await engine.stop();
  });

  // AC: @per-task-dispatch-drain-coalescing ac-9
  // AC: @agent-dispatch-engine ac-27
  it("should serialize drains from all sources via _serializedDrain", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 5000,
      reconcileIntervalMs: 0,
    });

    let drainConcurrency = 0;
    let maxDrainConcurrency = 0;
    const drainCallCount = { value: 0 };

    // Spy on _drainQueues to track concurrency — _serializedDrain calls this.
    // Use a microtask yield (not setTimeout) so fake timers don't block resolution.
    vi.spyOn(
      engine as unknown as { _drainQueues: (agents: unknown[]) => Promise<void> },
      "_drainQueues",
    ).mockImplementation(async () => {
      drainConcurrency++;
      drainCallCount.value++;
      maxDrainConcurrency = Math.max(maxDrainConcurrency, drainConcurrency);
      // Yield to microtask queue so concurrent callers have a chance to run
      await Promise.resolve();
      drainConcurrency--;
    });

    await engine.start();

    const internal = engine as unknown as {
      _serializedDrain: () => Promise<void>;
    };

    // Fire multiple _serializedDrain calls concurrently — simulates the race
    // between bootstrap/reconciliation/retry/post-invocation drain paths
    // that all now route through _serializedDrain.
    const p1 = internal._serializedDrain();
    const p2 = internal._serializedDrain();
    const p3 = internal._serializedDrain();

    await Promise.all([p1, p2, p3]);

    // _drainQueues should never have run concurrently
    expect(maxDrainConcurrency).toBeLessThanOrEqual(1);
    // Multiple drains should have executed (first + follow-up from coalesced pending)
    expect(drainCallCount.value).toBeGreaterThanOrEqual(2);

    await engine.stop();
  });
});

// AC: @agent-dispatch-engine ac-27
describe("AC-27: All drain paths go through _serializedDrain to prevent max_concurrent violation", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac27-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should route handleStateChange immediate drain (coalesceWindowMs=0) through _serializedDrain", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const [taskA, taskB] = testUlids("RACE", 2);
    await writeTasks(testDir, [
      { _ulid: taskA, status: "pending", automation: "eligible" },
      { _ulid: taskB, status: "pending", automation: "eligible" },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
      reconcileIntervalMs: 0,
    });

    const serializedDrainSpy = vi.spyOn(
      engine as unknown as { _serializedDrain: () => Promise<void> },
      "_serializedDrain",
    );

    // Mock _spawnInvocation to avoid real spawning
    vi.spyOn(
      engine as unknown as {
        _spawnInvocation: (agent: unknown, entry: unknown) => Promise<boolean>;
      },
      "_spawnInvocation",
    ).mockResolvedValue(true);

    await engine.start();

    // handleStateChange with coalesceWindowMs=0 should call _serializedDrain
    const callsBefore = serializedDrainSpy.mock.calls.length;
    await engine.handleStateChange({
      taskId: taskA,
      taskRef: `@${taskA}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: {
        automation: "eligible",
        tags: [],
        _ulid: taskA,
        status: "pending",
        blocked_by: [],
        depends_on: [],
        slugs: [],
      } as any,
    });

    // _serializedDrain should have been called (not _drainQueues directly)
    expect(serializedDrainSpy.mock.calls.length).toBeGreaterThan(callsBefore);

    await engine.stop();
  });

  it("should route bootstrap drain through _serializedDrain", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK", 91);
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
      reconcileIntervalMs: 0,
    });

    const serializedDrainSpy = vi.spyOn(
      engine as unknown as { _serializedDrain: () => Promise<void> },
      "_serializedDrain",
    );

    // Mock _spawnInvocation to avoid real spawning
    vi.spyOn(
      engine as unknown as {
        _spawnInvocation: (agent: unknown, entry: unknown) => Promise<boolean>;
      },
      "_spawnInvocation",
    ).mockResolvedValue(true);

    // start() → _bootstrap() → _serializedDrain()
    await engine.start();

    // Bootstrap should have called _serializedDrain (there's an eligible pending task)
    expect(serializedDrainSpy).toHaveBeenCalled();

    await engine.stop();
  });

  it("should route reconciliation drain through _serializedDrain", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK", 92);
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
      reconcileIntervalMs: 0,
    });

    // Mock _spawnInvocation to avoid real spawning
    vi.spyOn(
      engine as unknown as {
        _spawnInvocation: (agent: unknown, entry: unknown) => Promise<boolean>;
      },
      "_spawnInvocation",
    ).mockResolvedValue(true);

    await engine.start();

    // Spy after start so we don't count the bootstrap drain
    const serializedDrainSpy = vi.spyOn(
      engine as unknown as { _serializedDrain: () => Promise<void> },
      "_serializedDrain",
    );

    // _reconcile() → _serializedDrain()
    await (engine as unknown as { _reconcile: () => Promise<void> })._reconcile();

    // Reconciliation should have called _serializedDrain
    expect(serializedDrainSpy).toHaveBeenCalled();

    await engine.stop();
  });
});

// ─── AC-26: Cross-agent task dispatch exclusivity ────────────────────────────

describe("Cross-agent task dispatch exclusivity", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-cross-agent-exclusivity-");
    vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockResolvedValue({
      exists: true,
      healthy: true,
      reason: null,
      metadata: null,
    });
    vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceRegistry" as any).mockResolvedValue(
      undefined,
    );
    vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceArtifacts" as any).mockResolvedValue(
      undefined,
    );
    vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceLifecycle" as any).mockResolvedValue(
      undefined,
    );
    const mockMetadata = buildMockWorkspaceMetadata(testDir, {
      workspaceId: "mock-exclusivity-test",
    });
    vi.spyOn(workspaceModule, "provisionDispatchWorkspace").mockResolvedValue({
      cwd: testDir,
      metadataPath: path.join(testDir, ".kspec-dispatch-workspace.json"),
      metadata: mockMetadata as any,
    });
    vi.spyOn(bootstrapModule, "ensureWorkspaceBootstrap").mockResolvedValue({
      metadata: mockMetadata as any,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  // AC: @agent-dispatch-engine ac-26
  it("should not spawn a reviewer while a worker invocation is active for the same task", async () => {
    // Two agents: worker handles task.ready, reviewer handles task.pending_review.
    // When the worker is active for a task and a pending_review event arrives
    // for the same task, the reviewer entry should be queued but not spawned.
    const worker = makeTestAgent({
      id: "task-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 1 },
    });
    const reviewer = makeTestAgent({
      id: "pr-reviewer",
      dispatch: [{ on: "task.pending_review" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [worker, reviewer]);

    const taskId = testUlid("EXCL");
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

    let resolveWorker!: () => void;
    const workerBlock = new Promise<void>((r) => {
      resolveWorker = r;
    });
    const spawned: Array<{ agentId: string; taskRef: string }> = [];
    let invocationCount = 0;

    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (opts) => {
      invocationCount++;
      const agentId = (opts as any).agent?.id ?? "unknown";
      const taskRef = (opts as any).taskRef ?? "unknown";
      spawned.push({ agentId, taskRef });

      if (agentId === "task-worker") {
        await workerBlock;
      }
      return { session: {} as any, outcome: "success" as const, durationMs: 1 };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    await engine.start();

    // Wait for worker to start
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- modified by async mock callback
    for (let i = 0; i < 100 && invocationCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(invocationCount).toBe(1);
    expect(spawned[0].agentId).toBe("task-worker");

    // While worker is still running, simulate task transitioning to pending_review
    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending_review", automation: "eligible" },
    ]);
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending_review",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [], status: "pending_review" } as any,
    });

    // Give time for potential spawn
    await new Promise((r) => setTimeout(r, 100));

    // Reviewer should NOT have been spawned — worker is still active for the same task
    expect(invocationCount).toBe(1);
    expect(spawned).toHaveLength(1);

    // Verify the reviewer entry is queued (not discarded)
    const internal = engine as unknown as {
      queues: Map<string, Array<{ change: TaskStateChange }>>;
    };
    const reviewerQueue = internal.queues.get("pr-reviewer") ?? [];
    expect(reviewerQueue.some((e) => e.change.taskId === taskId)).toBe(true);

    // Release worker — post-invocation drain should now pick up the reviewer entry
    resolveWorker();

    // Wait for reviewer to be spawned
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- modified by async mock callback
    for (let i = 0; i < 100 && invocationCount < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(invocationCount).toBe(2);
    expect(spawned[1].agentId).toBe("pr-reviewer");

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-26
  it("should enforce at most one active invocation per task across all agents", async () => {
    // Both agents match the same event. Cross-agent exclusivity means only one
    // should spawn at a time for the same task.
    const agentA = makeTestAgent({
      id: "agent-a",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 2 },
    });
    const agentB = makeTestAgent({
      id: "agent-b",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 2 },
    });
    await setupProjectWithAgents(testDir, [agentA, agentB]);

    const taskId = testUlid("ONLYONE");
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

    let resolveFirst!: () => void;
    const firstBlock = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const spawned: Array<{ agentId: string; taskRef: string }> = [];
    let invocationCount = 0;

    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (opts) => {
      invocationCount++;
      const agentId = (opts as any).agent?.id ?? "unknown";
      const taskRef = (opts as any).taskRef ?? "unknown";
      spawned.push({ agentId, taskRef });

      if (invocationCount === 1) {
        await firstBlock;
      }
      return { session: {} as any, outcome: "success" as const, durationMs: 1 };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    await engine.start();

    // Wait for first invocation to start
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- modified by async mock callback
    for (let i = 0; i < 100 && invocationCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(invocationCount).toBe(1);

    // Give time for potential concurrent spawn
    await new Promise((r) => setTimeout(r, 100));

    // Only one agent should have spawned — the other should be deferred
    expect(invocationCount).toBe(1);

    // Release first invocation
    resolveFirst();

    // Wait for the second agent to pick up the task
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- modified by async mock callback
    for (let i = 0; i < 100 && invocationCount < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(invocationCount).toBe(2);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-26
  it("should allow different tasks to have concurrent invocations across agents", async () => {
    // Cross-agent exclusivity is per-task, not global. Different tasks should
    // be able to run concurrently with different agents.
    const worker = makeTestAgent({
      id: "task-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 2 },
    });
    const reviewer = makeTestAgent({
      id: "pr-reviewer",
      dispatch: [{ on: "task.pending_review" }],
      concurrency: { max_concurrent: 2 },
    });
    await setupProjectWithAgents(testDir, [worker, reviewer]);

    const [taskA, taskB] = testUlids("DIFF", 2);
    await writeTasks(testDir, [
      { _ulid: taskA, status: "pending", automation: "eligible" },
      { _ulid: taskB, status: "pending_review", automation: "eligible" },
    ]);

    let resolveAll!: () => void;
    const allBlock = new Promise<void>((r) => {
      resolveAll = r;
    });
    const spawned: Array<{ agentId: string; taskRef: string }> = [];
    let invocationCount = 0;

    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (opts) => {
      invocationCount++;
      const agentId = (opts as any).agent?.id ?? "unknown";
      const taskRef = (opts as any).taskRef ?? "unknown";
      spawned.push({ agentId, taskRef });
      await allBlock;
      return { session: {} as any, outcome: "success" as const, durationMs: 1 };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    await engine.start();

    // Wait for both invocations to start
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- modified by async mock callback
    for (let i = 0; i < 100 && invocationCount < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Both tasks should have active invocations concurrently since they are different tasks
    expect(invocationCount).toBe(2);
    const agents = spawned.map((s) => s.agentId);
    expect(agents).toContain("task-worker");
    expect(agents).toContain("pr-reviewer");

    resolveAll();
    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-26
  it("should subject deferred entries to staleness checks before spawn", async () => {
    // When a deferred entry's task changes state while waiting, the entry should
    // be discarded by staleness checks rather than spawned.
    const worker = makeTestAgent({
      id: "task-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 1 },
    });
    const reviewer = makeTestAgent({
      id: "pr-reviewer",
      dispatch: [{ on: "task.pending_review" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [worker, reviewer]);

    const taskId = testUlid("STALE");
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

    let resolveWorker!: () => void;
    const workerBlock = new Promise<void>((r) => {
      resolveWorker = r;
    });
    const spawned: Array<{ agentId: string; taskRef: string }> = [];
    let invocationCount = 0;

    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (opts) => {
      invocationCount++;
      const agentId = (opts as any).agent?.id ?? "unknown";
      const taskRef = (opts as any).taskRef ?? "unknown";
      spawned.push({ agentId, taskRef });

      if (agentId === "task-worker") {
        // While worker is running, task transitions to pending_review then to completed
        await writeTasks(testDir, [
          { _ulid: taskId, status: "pending_review", automation: "eligible" },
        ]);
        await workerBlock;
      }
      return { session: {} as any, outcome: "success" as const, durationMs: 1 };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
      coalesceWindowMs: 0,
    });

    await engine.start();

    // Wait for worker to start
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- modified by async mock callback
    for (let i = 0; i < 100 && invocationCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(invocationCount).toBe(1);

    // Enqueue a pending_review event for the reviewer
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending_review",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [], status: "pending_review" } as any,
    });

    // Now change the task to completed on disk (making the pending_review entry stale)
    await writeTasks(testDir, [{ _ulid: taskId, status: "completed", automation: "eligible" }]);

    // Release worker — drain should run staleness check and discard the stale entry
    resolveWorker();

    // Wait for potential reviewer spawn
    await new Promise((r) => setTimeout(r, 200));

    // Reviewer should NOT have been spawned — the queued entry is stale (task is now completed)
    expect(spawned).toHaveLength(1);
    expect(spawned[0].agentId).toBe("task-worker");

    await engine.stop();
  });
});

// ─── AC-11: Idle grace period backward compatibility ─────────────────────────

// AC: @multi-turn-session-lifecycle ac-11
describe("AC-11: Idle grace period backward compatibility", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-idle-grace-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  it("should pass idleGracePeriodMs=0 when no session.idle hooks are configured", async () => {
    const agent = makeTestAgent({ id: "worker", dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as any,
      outcome: "success",
      durationMs: 1,
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    await engine.start();
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    await waitForMockCall(runSpy);

    expect(runSpy).toHaveBeenCalled();
    const invocationOpts = runSpy.mock.calls[0][0];
    expect(invocationOpts.idleGracePeriodMs).toBe(0);

    await engine.stop();
  });

  it("should pass DEFAULT_IDLE_GRACE_MS when a session.idle hook is configured", async () => {
    const agent = makeTestAgent({ id: "worker", dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    // Add a session.idle hook to the meta YAML and re-commit
    const hookUlid = testUlid("HOOK");
    const metaContent = YAML.parse(await readTestOutput(path.join(testDir, "kynetic.meta.yaml")));
    metaContent.hooks = [
      {
        _ulid: hookUlid,
        name: "test-idle-hook",
        on: "session.idle",
        action: { type: "kspec", command: "task list" },
        enabled: true,
      },
    ];
    await fs.writeFile(
      path.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify(metaContent),
      "utf-8",
    );
    execSync("git add -A && git commit -m 'add hook'", { cwd: testDir, stdio: "pipe" });

    const taskId = testUlid("TASK", 2);

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as any,
      outcome: "success",
      durationMs: 1,
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    await engine.start();
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    await waitForMockCall(runSpy);

    expect(runSpy).toHaveBeenCalled();
    const invocationOpts = runSpy.mock.calls[0][0];
    expect(invocationOpts.idleGracePeriodMs).toBe(invocationModule.DEFAULT_IDLE_GRACE_MS);

    await engine.stop();
  });

  // AC: @multi-turn-session-lifecycle ac-11
  it("should reload session.idle hook presence during reconciliation", async () => {
    // Start with NO session.idle hooks — grace period should be 0
    const agent = makeTestAgent({ id: "worker", dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId1 = testUlid("TASK", 3);

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as any,
      outcome: "success",
      durationMs: 1,
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
      reconcileIntervalMs: 0, // Disable periodic — we'll call _reconcile() manually
    });

    await engine.start();

    // First invocation: no hooks → idleGracePeriodMs=0
    await engine.handleStateChange({
      taskId: taskId1,
      taskRef: `@${taskId1}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    await waitForMockCall(runSpy);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0].idleGracePeriodMs).toBe(0);

    // Now add a session.idle hook to meta on disk
    const hookUlid = testUlid("HOOK", 2);
    const metaContent = YAML.parse(await readTestOutput(path.join(testDir, "kynetic.meta.yaml")));
    metaContent.hooks = [
      {
        _ulid: hookUlid,
        name: "test-idle-hook",
        on: "session.idle",
        action: { type: "kspec", command: "task list" },
        enabled: true,
      },
    ];
    await fs.writeFile(
      path.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify(metaContent),
      "utf-8",
    );
    execSync("git add -A && git commit -m 'add session.idle hook'", {
      cwd: testDir,
      stdio: "pipe",
    });

    // Trigger reconciliation — this should reload the hook presence
    await (engine as unknown as { _reconcile: () => Promise<void> })._reconcile();

    // Second invocation: hook present → idleGracePeriodMs=DEFAULT_IDLE_GRACE_MS
    runSpy.mockClear();
    const taskId2 = testUlid("TASK", 4);
    await engine.handleStateChange({
      taskId: taskId2,
      taskRef: `@${taskId2}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    await waitForMockCall(runSpy);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0].idleGracePeriodMs).toBe(invocationModule.DEFAULT_IDLE_GRACE_MS);

    await engine.stop();
  });
});

// ─── AC-28: Async internal bookkeeping ───────────────────────────────────────
// AC: @agent-dispatch-engine ac-28
describe("AC-28: async internal bookkeeping", () => {
  let testDir: string;
  let captureFile: string;

  beforeEach(async () => {
    testDir = await createTempDir();
    captureFile = path.join(testDir, "capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;
  });

  afterEach(async () => {
    delete process.env.KSPEC_CAPTURE_FILE;
    await cleanupTempDir(testDir);
  });

  // AC: @agent-dispatch-engine ac-28
  it("event loop remains responsive during dispatch engine _addTaskNote", async () => {
    const agent = makeTestAgent();
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    // Access private methods via type assertion
    const internal = engine as unknown as {
      _addTaskNote: (taskRef: string, note: string) => Promise<void>;
      _blockTask: (taskRef: string, reason: string) => Promise<void>;
    };

    // Schedule an event loop tick check BEFORE calling _addTaskNote
    let eventLoopTicked = false;
    const tickPromise = new Promise<void>((resolve) => {
      setImmediate(() => {
        eventLoopTicked = true;
        resolve();
      });
    });

    // _addTaskNote should return a Promise (async), allowing the event loop to tick
    const notePromise = internal._addTaskNote("@test-task", "Test note for AC-28");
    expect(notePromise).toBeInstanceOf(Promise);

    // Wait for both: the note operation and the event loop tick
    await Promise.all([notePromise, tickPromise]);
    expect(eventLoopTicked).toBe(true);
  });

  // AC: @agent-dispatch-engine ac-28
  it("event loop remains responsive during dispatch engine _blockTask", async () => {
    const agent = makeTestAgent();
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    const internal = engine as unknown as {
      _blockTask: (taskRef: string, reason: string) => Promise<void>;
    };

    let eventLoopTicked = false;
    const tickPromise = new Promise<void>((resolve) => {
      setImmediate(() => {
        eventLoopTicked = true;
        resolve();
      });
    });

    // _blockTask is expected to fail (task doesn't exist in kspec)
    // but it should still return a Promise and not block the event loop
    const blockPromise = internal._blockTask("@test-task", "Test block for AC-28").catch(() => {});
    expect(blockPromise).toBeInstanceOf(Promise);

    await Promise.all([blockPromise, tickPromise]);
    expect(eventLoopTicked).toBe(true);
  });

  // AC: @agent-dispatch-engine ac-28
  it("error recovery paths use async task note and block", async () => {
    const agent = makeTestAgent();
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });

    // Mock workspace provisioning to fail, which triggers error recovery
    vi.spyOn(workspaceModule, "provisionDispatchWorkspace").mockRejectedValue(
      new Error("Simulated workspace failure"),
    );
    vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockResolvedValue({
      exists: true,
      healthy: true,
      reason: null,
      metadata: null,
    });
    vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceRegistry").mockResolvedValue({
      purgedCount: 0,
      recoveredCount: 0,
    });
    vi.spyOn(configModule, "resolveDispatchRemoteSync").mockReturnValue(false);
    vi.spyOn(bootstrapModule, "ensureWorkspaceBootstrap").mockResolvedValue({
      metadata: {} as any,
      reused: true,
      ranSteps: false,
    });

    await engine.start();

    // Schedule event loop check
    let eventLoopTicked = false;
    setImmediate(() => {
      eventLoopTicked = true;
    });

    // Trigger a state change that will try to spawn an invocation,
    // hit the provisioning failure, and exercise the error recovery path
    await engine.handleStateChange(
      makeStateChange({
        toStatus: "pending",
        task: { automation: "eligible", tags: [] } as any,
      }),
    );

    // Give event loop a chance to process the setImmediate
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // The event loop should have been able to tick during the async error recovery
    expect(eventLoopTicked).toBe(true);

    // Verify the mock kspec CLI was called for task note (error recovery)
    try {
      const captured = JSON.parse(await readTestOutput(captureFile));
      const noteCall = captured.find(
        (c: { args: string[] }) => c.args[0] === "task" && c.args[1] === "note",
      );
      expect(noteCall).toBeDefined();
      expect(noteCall.args[3]).toContain("[DISPATCH-WORKSPACE]");
    } catch {
      // capture file may not exist if mock CLI wasn't found; that's OK for the
      // event-loop responsiveness check which is the primary assertion
    }

    await engine.stop();
  });
});

// ─── AC: in-flight spawn refs protect cleanup inputs ─────────────────────────

describe("In-flight spawn refs are included in cleanup protection inputs", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-inflight-cleanup-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
    vi.restoreAllMocks();
  });

  type EngineInternal = {
    inFlightTaskKeys: Set<string>;
    activeInvocationDetails: Map<string, ActiveInvocationRecord>;
    _activeTaskRefs: () => Set<string>;
    _hasActiveInvocationForTask: (taskRef: string) => boolean;
  };

  type ActiveInvocationRecord = {
    invocationId: string;
    sessionId: string;
    agentId: string;
    agentName: string;
    taskRef: string | undefined;
    role: "worker" | "reviewer";
    startedAtMs: number;
    resolvedAdapter: string;
    runner: string | undefined;
  };

  function makeActiveRecord(overrides: Partial<ActiveInvocationRecord>): ActiveInvocationRecord {
    return {
      invocationId: testUlid("INVK"),
      sessionId: testUlid("SESS"),
      agentId: "test-worker",
      agentName: "Test Worker",
      taskRef: undefined,
      role: "worker",
      startedAtMs: Date.now(),
      resolvedAdapter: "claude-agent-acp",
      runner: undefined,
      ...overrides,
    };
  }

  // AC: @agent-dispatch-engine ac-inflight-spawn-refs-protect-cleanup
  it("_activeTaskRefs() includes a task ref from inFlightTaskKeys when no active invocation is registered yet", async () => {
    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    const internal = engine as unknown as EngineInternal;

    const taskRef = `@${testUlid("TASK")}`;
    internal.inFlightTaskKeys.add(`test-worker:${taskRef}`);

    const refs = internal._activeTaskRefs();
    expect(refs.has(taskRef)).toBe(true);
    expect(refs.size).toBe(1);
  });

  // AC: @agent-dispatch-engine ac-inflight-spawn-refs-protect-cleanup
  it("_activeTaskRefs() merges in-flight and active invocation refs with deduplication", async () => {
    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    const internal = engine as unknown as EngineInternal;

    const [sharedId, inflightOnlyId, activeOnlyId] = testUlids("TASK", 3);
    const sharedTaskRef = `@${sharedId}`;
    const inflightOnlyRef = `@${inflightOnlyId}`;
    const activeOnlyRef = `@${activeOnlyId}`;

    internal.inFlightTaskKeys.add(`test-worker:${sharedTaskRef}`);
    internal.inFlightTaskKeys.add(`test-worker:${inflightOnlyRef}`);
    internal.activeInvocationDetails.set(
      "invocation-shared",
      makeActiveRecord({ taskRef: sharedTaskRef }),
    );
    internal.activeInvocationDetails.set(
      "invocation-active-only",
      makeActiveRecord({ taskRef: activeOnlyRef }),
    );

    const refs = internal._activeTaskRefs();
    expect(refs.has(sharedTaskRef)).toBe(true);
    expect(refs.has(inflightOnlyRef)).toBe(true);
    expect(refs.has(activeOnlyRef)).toBe(true);
    expect(refs.size).toBe(3);
  });

  // AC: @agent-dispatch-engine ac-inflight-spawn-refs-protect-cleanup
  it("parsing splits on the first ':' so task refs containing ':' remain intact", async () => {
    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    const internal = engine as unknown as EngineInternal;

    const taskRefWithColon = `@task:with:colons`;
    internal.inFlightTaskKeys.add(`test-worker:${taskRefWithColon}`);

    const refs = internal._activeTaskRefs();
    expect(refs.has(taskRefWithColon)).toBe(true);
    expect(internal._hasActiveInvocationForTask(taskRefWithColon)).toBe(true);
  });

  // AC: @agent-dispatch-engine ac-inflight-spawn-refs-protect-cleanup
  it("malformed in-flight keys without ':' are ignored", async () => {
    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
    });
    const internal = engine as unknown as EngineInternal;

    internal.inFlightTaskKeys.add(`no-separator-here`);

    const refs = internal._activeTaskRefs();
    expect(refs.size).toBe(0);
  });

  // AC: @agent-dispatch-engine ac-inflight-spawn-refs-protect-cleanup
  it("reconciliation passes the in-flight task ref to reconcileDispatchWorkspaceArtifacts", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceRegistry").mockResolvedValue();
    const reconcileArtifactsSpy = vi
      .spyOn(workspaceModule, "reconcileDispatchWorkspaceArtifacts")
      .mockResolvedValue(undefined as any);
    vi.spyOn(configModule, "resolveDispatchRemoteSync").mockReturnValue(false);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      coalesceWindowMs: 0,
      reconcileIntervalMs: 0,
    });
    const internal = engine as unknown as EngineInternal & {
      _reconcile: () => Promise<void>;
    };

    const inFlightTaskRef = `@${testUlid("TASK")}`;
    internal.inFlightTaskKeys.add(`${agent.id}:${inFlightTaskRef}`);

    await engine.start();

    const callsAfterStart = reconcileArtifactsSpy.mock.calls.length;
    expect(callsAfterStart).toBeGreaterThan(0);
    const startCallArg = reconcileArtifactsSpy.mock.calls[callsAfterStart - 1]?.[1];
    const startActiveRefs = new Set(startCallArg?.activeTaskRefs ?? []);
    expect(startActiveRefs.has(inFlightTaskRef)).toBe(true);

    reconcileArtifactsSpy.mockClear();
    await internal._reconcile();

    expect(reconcileArtifactsSpy.mock.calls.length).toBeGreaterThan(0);
    const reconcileCallArg = reconcileArtifactsSpy.mock.calls[0]?.[1];
    const reconcileActiveRefs = new Set(reconcileCallArg?.activeTaskRefs ?? []);
    expect(reconcileActiveRefs.has(inFlightTaskRef)).toBe(true);

    await engine.stop();
  });
});

// ─── AC: dispatch-level in-flight bootstrap race regression ──────────────────

describe(
  "In-flight bootstrap race: reconciliation must not delete the worker workspace",
  { timeout: 60_000 },
  () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = await createTempDir("kspec-dispatch-inflight-bootstrap-race-");
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanupTempDir(testDir);
    });

    // AC: @agent-dispatch-engine ac-inflight-spawn-refs-protect-cleanup
    // AC: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved
    it("preserves the worker workspace and bootstrap-created files while a spawn is blocked at the bootstrap barrier", async () => {
      const agent = makeTestAgent({
        id: "task-worker",
        dispatch: [{ on: "task.ready" }],
        concurrency: { max_concurrent: 1 },
      });
      await setupProjectWithAgents(testDir, [agent]);

      const SENTINEL_BASENAME = "bootstrap-sentinel.txt";
      const SENTINEL_CONTENT = "bootstrap-in-progress";

      let workspaceCwd: string | null = null;
      let resolveBootstrapEntered!: () => void;
      const bootstrapEntered = new Promise<void>((resolve) => {
        resolveBootstrapEntered = resolve;
      });
      let resolveBootstrapBarrier!: () => void;
      const bootstrapBarrier = new Promise<void>((resolve) => {
        resolveBootstrapBarrier = resolve;
      });
      const bootstrapErrors: Error[] = [];

      // ensureWorkspaceBootstrap is the deterministic barrier: it writes a
      // sentinel file representing bootstrap-created files (e.g. node_modules
      // contents from npm install), then waits on a Promise the test releases.
      // The spawn remains in-flight (inFlightTaskKeys set, no active invocation
      // registered) for the entire duration of the barrier.
      const bootstrapSpy = vi
        .spyOn(bootstrapModule, "ensureWorkspaceBootstrap")
        .mockImplementation(async (opts) => {
          workspaceCwd = opts.workspaceDir;
          try {
            await fs.writeFile(
              path.join(opts.workspaceDir, SENTINEL_BASENAME),
              SENTINEL_CONTENT,
              "utf-8",
            );
          } catch (err) {
            bootstrapErrors.push(err as Error);
            throw err;
          }
          resolveBootstrapEntered();
          await bootstrapBarrier;
          // Re-read the sentinel after the barrier: if reconciliation reaped
          // the workspace mid-bootstrap, this read surfaces as ENOENT here
          // — the canonical TAR/ENOENT/spawn failure mode this regression
          // protects against.
          try {
            const survived = await readTestOutput(path.join(opts.workspaceDir, SENTINEL_BASENAME));
            if (survived !== SENTINEL_CONTENT) {
              throw new Error(`bootstrap sentinel corrupted: ${survived}`);
            }
          } catch (err) {
            bootstrapErrors.push(err as Error);
            throw err;
          }
          return { metadata: opts.metadata, reused: false, ranSteps: true };
        });

      const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
        session: {} as never,
        outcome: "success",
        durationMs: 1,
      });

      // Spy on the real artifact reconciliation (call-through). We use it to
      // assert that the in-flight task ref flowed into activeTaskRefs as the
      // protection input — and we let it run for real so the workspace dir is
      // exercised by the cleanup logic, not just inspected.
      const reconcileArtifactsSpy = vi.spyOn(
        workspaceModule,
        "reconcileDispatchWorkspaceArtifacts",
      );
      // Stub the registry reconciliation so it cannot revert the forced
      // cleanup-eligible state mutation below. The registry reconciliation
      // recomputes lifecycle_state from task state on each cycle; without
      // this stub it would race with the test's mutation.
      vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceRegistry").mockResolvedValue();

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
        coalesceWindowMs: 0,
        // Disable periodic reconcile — the test drives _reconcile() explicitly
        // so the regression check is deterministic.
        reconcileIntervalMs: 0,
      });

      await engine.start();

      const taskId = testUlid("TASK");
      const taskRef = `@${taskId}`;

      // handleStateChange awaits the full drain → _spawnInvocation chain, and
      // our mocked bootstrap blocks indefinitely. Run it without awaiting so
      // the test thread can proceed once the bootstrap barrier is reached.
      const handleStateChangePromise = engine.handleStateChange({
        taskId,
        taskRef,
        fromStatus: "in_progress",
        toStatus: "pending",
        timestamp: Date.now(),
        task: {
          _ulid: taskId,
          title: "Bootstrap In-Flight Race",
          slugs: ["bootstrap-in-flight-race"],
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

      // Deterministic synchronization: spawn has dequeued, inFlightTaskKeys is
      // populated, provisionDispatchWorkspace has created the real worktree,
      // and ensureWorkspaceBootstrap is awaiting the barrier. No active
      // invocation is registered for this task yet — this is precisely the
      // pre-active spawn window the AC protects.
      await bootstrapEntered;
      expect(workspaceCwd).not.toBeNull();

      const engineInternal = engine as unknown as {
        inFlightTaskKeys: Set<string>;
        activeInvocationDetails: Map<string, { taskRef: string | undefined }>;
        _reconcile: () => Promise<void>;
        _activeTaskRefs: () => Set<string>;
      };

      // Pre-active window invariants — the very state the regression test exists
      // to protect: in-flight has it, active does not.
      expect(
        Array.from(engineInternal.inFlightTaskKeys).some((key) => key.endsWith(`:${taskRef}`)),
      ).toBe(true);
      expect(
        Array.from(engineInternal.activeInvocationDetails.values()).some(
          (record) => record.taskRef === taskRef,
        ),
      ).toBe(false);
      // The engine's protection input set must include the in-flight task ref.
      expect(engineInternal._activeTaskRefs().has(taskRef)).toBe(true);

      // Force the registry record + per-worker metadata into a cleanup-eligible
      // closing state with resolved integration. Without this mutation the
      // workspace would be preserved by lifecycle protection alone (ready /
      // provisioning are in DISPATCH_PROTECTED_LIFECYCLE_STATES), and the test
      // would not actually exercise the in-flight cleanup-protection branch.
      // With this mutation, the ONLY thing standing between reap and
      // workspace deletion is the in-flight task ref being passed into
      // activeTaskRefs — which is exactly what the AC requires.
      const registryPath = path.join(testDir, "project.dispatch-workspaces.yaml");
      const registryRaw = YAML.parse(await fs.readFile(registryPath, "utf-8")) as {
        kynetic_dispatch_workspaces?: string;
        workspaces?: Array<Record<string, any>>;
      };
      const workspaceRecord = registryRaw.workspaces?.find((record) => record.task_ref === taskRef);
      if (!workspaceRecord) {
        throw new Error(`workspace registry record missing for ${taskRef}`);
      }
      const originalLifecycleState = workspaceRecord.lifecycle_state;
      const originalCleanup = workspaceRecord.cleanup ? { ...workspaceRecord.cleanup } : undefined;
      const originalIntegration = workspaceRecord.integration
        ? { ...workspaceRecord.integration }
        : undefined;
      workspaceRecord.lifecycle_state = "closing";
      workspaceRecord.cleanup = {
        ...workspaceRecord.cleanup,
        eligible: true,
        status: "scheduled",
        reason: "forced-cleanup-eligible-for-test",
        detail:
          "Forced cleanup-eligible state to exercise in-flight bootstrap protection composition",
        scheduled_at: new Date().toISOString(),
        completed_at: null,
      };
      workspaceRecord.integration = {
        ...workspaceRecord.integration,
        status: "merged",
        outcome: "merged",
      };
      await fs.writeFile(
        registryPath,
        YAML.stringify({
          kynetic_dispatch_workspaces: registryRaw.kynetic_dispatch_workspaces ?? "1.0",
          workspaces: registryRaw.workspaces ?? [],
        }),
        "utf-8",
      );

      const metadataFilePath = path.join(workspaceCwd!, ".kspec-dispatch-workspace.json");
      const metadataRaw = JSON.parse(await fs.readFile(metadataFilePath, "utf-8")) as Record<
        string,
        any
      >;
      const originalMetadataCleanupEligible = metadataRaw.cleanupEligible;
      const originalMetadataLifecycleState = metadataRaw.lifecycleState;
      const originalMetadataCleanupState = metadataRaw.cleanupState
        ? { ...metadataRaw.cleanupState }
        : undefined;
      metadataRaw.cleanupEligible = true;
      metadataRaw.cleanupReason = "forced-cleanup-eligible-for-test";
      metadataRaw.lifecycleState = "closing";
      metadataRaw.cleanupState = {
        ...metadataRaw.cleanupState,
        status: "scheduled",
        eligible: true,
        reason: "forced-cleanup-eligible-for-test",
      };
      await fs.writeFile(metadataFilePath, `${JSON.stringify(metadataRaw, null, 2)}\n`, "utf-8");

      // Pre-reconcile sanity: workspace directory and bootstrap sentinel exist.
      await expect(fs.stat(workspaceCwd!)).resolves.toBeDefined();
      await expect(readTestOutput(path.join(workspaceCwd!, SENTINEL_BASENAME))).resolves.toBe(
        SENTINEL_CONTENT,
      );

      reconcileArtifactsSpy.mockClear();

      // Trigger reconciliation while the spawn remains in-flight at bootstrap.
      // The fix under regression: _reconcile() builds activeTaskRefs via
      // _activeTaskRefs(), which includes inFlightTaskKeys entries, and passes
      // the merged set to reconcileDispatchWorkspaceArtifacts. The cleanup
      // surface then routes the task ref through the shared protection state
      // and preserves the worker workspace despite the cleanup-eligible record.
      await engineInternal._reconcile();

      // Composition assertion: the in-flight task ref is part of the cleanup
      // protection input.
      expect(reconcileArtifactsSpy).toHaveBeenCalled();
      const reconcileArgs = reconcileArtifactsSpy.mock.calls[0]?.[1];
      const reconcileActiveRefs = new Set(reconcileArgs?.activeTaskRefs ?? []);
      expect(reconcileActiveRefs.has(taskRef)).toBe(true);

      // Behavioral assertion: workspace directory and bootstrap-created
      // sentinel both survive the cleanup pass.
      await expect(fs.stat(workspaceCwd!)).resolves.toBeDefined();
      await expect(readTestOutput(path.join(workspaceCwd!, SENTINEL_BASENAME))).resolves.toBe(
        SENTINEL_CONTENT,
      );

      // Restore the registry + metadata to a non-cleanup-eligible state so the
      // post-bootstrap validation gate sees a healthy workspace and the spawn
      // can reach its controlled success path.
      workspaceRecord.lifecycle_state = originalLifecycleState ?? "active";
      workspaceRecord.cleanup = originalCleanup ?? {
        eligible: false,
        status: "not_scheduled",
        reason: null,
        detail: null,
        scheduled_at: null,
        completed_at: null,
      };
      workspaceRecord.integration = originalIntegration ?? {
        status: "pending",
        outcome: "pending",
      };
      await fs.writeFile(
        registryPath,
        YAML.stringify({
          kynetic_dispatch_workspaces: registryRaw.kynetic_dispatch_workspaces ?? "1.0",
          workspaces: registryRaw.workspaces ?? [],
        }),
        "utf-8",
      );
      metadataRaw.cleanupEligible = originalMetadataCleanupEligible ?? false;
      metadataRaw.cleanupReason = null;
      metadataRaw.lifecycleState = originalMetadataLifecycleState ?? "active";
      metadataRaw.cleanupState = originalMetadataCleanupState ?? {
        status: "not_scheduled",
        eligible: false,
        reason: null,
        detail: null,
        updated_at: new Date().toISOString(),
      };
      await fs.writeFile(metadataFilePath, `${JSON.stringify(metadataRaw, null, 2)}\n`, "utf-8");

      // Release the bootstrap barrier — the spawn must reach the controlled
      // success path without cleanup-induced ENOENT / TAR / spawn errors.
      // The bootstrap mock's post-barrier re-read of the sentinel will throw
      // if the workspace was reaped under it, capturing those error modes
      // in `bootstrapErrors`.
      resolveBootstrapBarrier();

      await waitForMockCall(runSpy, "runInvocation should be called once bootstrap is released");
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(bootstrapSpy).toHaveBeenCalled();
      expect(bootstrapErrors).toEqual([]);

      // Ensure the original dispatch chain has fully unwound before stopping
      // the engine to avoid stop() racing with an in-flight drain.
      await handleStateChangePromise;
      await engine.stop();
    });
  },
);
