import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  DispatchEngine,
  DispatchLifecycleTransitionError,
  type DispatchLifecycleAuthorityStore,
} from "../src/agent-runtime/dispatch.js";
import type {
  DispatchControl,
  DispatchControlPublication,
  DispatchControlMutation,
} from "../src/agent-runtime/dispatch-control-store.js";
import { createMissingDispatchControl } from "../src/schema/dispatch-control.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  seedSplitTask,
  testUlid,
} from "./helpers/cli.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import { initContext, resolveTaskDataManager } from "../src/parser/index.js";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import * as workspaceModule from "../src/agent-runtime/workspace.js";
import * as bootstrapModule from "../src/agent-runtime/bootstrap.js";

ensureSplitBackendRegistered();
const liveHarnesses: Array<Awaited<ReturnType<typeof createGlobalLifecycleHarness>>> = [];
const MOCK_KSPEC_CLI = path.join(__dirname, "mocks", "kspec-capture-mock.cjs");

class MemoryControlStore implements DispatchLifecycleAuthorityStore {
  private publication: DispatchControlPublication;
  private committedSnapshot: DispatchControl;
  private listener: ((publication: DispatchControlPublication) => void) | undefined;
  writes = 0;

  constructor(snapshot: DispatchControl) {
    this.committedSnapshot = snapshot;
    this.publication = { snapshot, token: { revision: snapshot.revision, commit_oid: "memory" } };
  }

  setPublicationListener(
    _key: string,
    listener: (publication: DispatchControlPublication) => void,
  ) {
    this.listener = listener;
  }

  async loadCommitted() {
    this.listener?.(this.publication);
    return this.publication;
  }

  getPublication() {
    return this.publication;
  }

  getDegradedReason() {
    return null;
  }

  async mutate(_operation: string, mutation: DispatchControlMutation) {
    let snapshot: DispatchControl | null;
    try {
      snapshot = await mutation(structuredClone(this.committedSnapshot));
    } catch (error) {
      this.publish(this.committedSnapshot);
      throw error;
    }
    if (snapshot === null) {
      this.publish(this.committedSnapshot);
      return this.publication;
    }
    this.writes++;
    this.committedSnapshot = snapshot;
    this.publication = {
      snapshot,
      token: { revision: snapshot.revision, commit_oid: `memory-${snapshot.revision}` },
    };
    this.listener?.(this.publication);
    return this.publication;
  }

  publish(snapshot: DispatchControl) {
    this.committedSnapshot = snapshot;
    this.publication = {
      snapshot,
      token: { revision: snapshot.revision, commit_oid: `external-${snapshot.revision}` },
    };
    this.listener?.(this.publication);
  }

  commitWithoutPublishing(snapshot: DispatchControl) {
    this.committedSnapshot = snapshot;
  }
}

function control(authority: "stopped" | "running" | "paused", revision = 1): DispatchControl {
  return { ...createMissingDispatchControl(), revision, global: { authority } };
}

type HarnessTaskStatus = "pending" | "completed";

interface GlobalLifecycleHarnessOptions {
  taskStatus?: HarnessTaskStatus;
  coalesceWindowMs?: number;
  recordCandidateStarts?: boolean;
}

async function createGlobalLifecycleHarness(
  authority: "stopped" | "running" | "paused",
  options: GlobalLifecycleHarnessOptions = {},
) {
  const projectDir = await createTempDir("dispatch-global-lifecycle-");
  initGitRepo(projectDir);
  const taskId = testUlid("TASK", 1);
  await fs.writeFile(
    path.join(projectDir, "kynetic.yaml"),
    YAML.stringify({ kynetic: "1.1", title: "Lifecycle", task_storage: { format: "split" } }),
  );
  await fs.writeFile(
    path.join(projectDir, "kynetic.meta.yaml"),
    YAML.stringify({
      kynetic_meta: "1.0",
      agents: [
        {
          _ulid: testUlid("AGNT", 1),
          id: "worker",
          name: "Worker",
          adapter: "mock-acp",
          capabilities: [],
          tools: [],
          conventions: [],
          skills: [],
          auto_approve: false,
          concurrency: { max_concurrent: 1 },
          dispatch: [{ on: "task.ready" }],
        },
      ],
    }),
  );
  const writeTask = (
    id: string,
    status: HarnessTaskStatus,
    slug = id === taskId ? "task-lifecycle" : `task-${id.toLowerCase()}`,
  ) =>
    seedSplitTask(projectDir, {
      _ulid: id,
      type: "task",
      title: "Lifecycle task",
      slugs: [slug],
      status,
      priority: 1,
      automation: "eligible",
      depends_on: [],
      blocked_by: [],
      tags: [],
      notes: [],
      created_at: new Date().toISOString(),
    });
  const loadTask = async (id = taskId) => {
    const ctx = await initContext(projectDir);
    return (await resolveTaskDataManager(ctx).loadAllTasks(ctx)).find((task) => task._ulid === id)!;
  };
  writeTask(taskId, options.taskStatus ?? "pending");
  const store = new MemoryControlStore(control(authority));
  const engine = new DispatchEngine({
    projectDir,
    specDir: projectDir,
    kspecCliPath: MOCK_KSPEC_CLI,
    reconcileIntervalMs: 0,
    coalesceWindowMs: options.coalesceWindowMs ?? 0,
    lifecycleStore: store,
  });
  const candidateStarts: string[] = [];
  if (options.recordCandidateStarts !== false) {
    vi.spyOn(
      engine as unknown as {
        _spawnInvocation: (
          agent: unknown,
          entry: { change: { taskId: string } },
        ) => Promise<boolean>;
      },
      "_spawnInvocation",
    ).mockImplementation(async (_agent, entry) => {
      candidateStarts.push(entry.change.taskId);
      return true;
    });
  }
  const harness = { engine, store, taskId, candidateStarts, projectDir, writeTask, loadTask };
  liveHarnesses.push(harness);
  return harness;
}

function holdIngress() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait: () => promise, release };
}

function recordCandidateStart(harness: Awaited<ReturnType<typeof createGlobalLifecycleHarness>>) {
  return harness.candidateStarts.slice();
}

function mockInvocationInfrastructure(projectDir: string) {
  const metadata = {
    workspaceId: "lifecycle-workspace",
    taskRef: "@task-lifecycle",
    taskSlug: "task-lifecycle",
    canonicalBranch: "dispatch/task/lifecycle/test",
    canonicalBranchHead: "abc123",
    integrationTargetBranch: "dev",
    publicationMode: "manual_merge",
    lifecycleState: "ready",
    activeRole: null,
    workerWorktreeDir: projectDir,
    reviewerWorktreeDir: null,
    bootstrap: {
      status: "ready",
      lastRole: "worker",
      roleStates: {
        worker: { status: "ready", steps: [], invalidationReasons: [] },
        reviewer: { status: "not_run", steps: [], invalidationReasons: [] },
      },
    },
  };
  vi.spyOn(workspaceModule, "getDispatchWorkspaceHealth").mockResolvedValue({
    exists: true,
    healthy: true,
    reason: null,
    metadata: metadata as never,
  });
  vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceRegistry").mockResolvedValue();
  vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceArtifacts").mockResolvedValue();
  vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceLifecycle").mockResolvedValue();
  vi.spyOn(workspaceModule, "provisionDispatchWorkspace").mockResolvedValue({
    cwd: projectDir,
    metadataPath: path.join(projectDir, ".kspec-dispatch-workspace.json"),
    metadata: metadata as never,
  });
  const provisioned = {
    cwd: projectDir,
    metadataPath: path.join(projectDir, ".kspec-dispatch-workspace.json"),
    metadata: metadata as never,
  };
  vi.spyOn(workspaceModule, "markDispatchWorkspaceActive").mockResolvedValue(provisioned);
  vi.spyOn(workspaceModule, "markDispatchWorkspaceIdle").mockResolvedValue(provisioned);
  vi.spyOn(bootstrapModule, "ensureWorkspaceBootstrap").mockResolvedValue({
    metadata: metadata as never,
  });
}

describe("global dispatch lifecycle authority", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(async () => {
    await Promise.all(
      liveHarnesses.splice(0).map(async ({ engine, projectDir }) => {
        await engine.stop().catch(() => undefined);
        await cleanupTempDir(projectDir);
      }),
    );
  });

  // AC: @dispatch-lifecycle-control-authority ac-controls-survive-restart
  // AC: @dispatch-lifecycle-control-authority ac-global-paused-work-does-not-start
  it.each(["stopped", "paused", "running"] as const)(
    "loads %s authority before bootstrap scheduling",
    async (authority) => {
      const harness = await createGlobalLifecycleHarness(authority);
      await harness.engine.start();
      expect(recordCandidateStart(harness)).toHaveLength(authority === "running" ? 1 : 0);
      expect(harness.engine.getLifecycleStatus().globalAuthority).toBe(authority);
      await harness.engine.stop();
    },
  );

  it.each([
    { authority: "paused", action: "start" },
    { authority: "stopped", action: "pause" },
    { authority: "stopped", action: "resume" },
  ] as const)(
    "rejects $action from $authority with idle cleanup without reconstructing",
    async ({ authority, action }) => {
      const harness = await createGlobalLifecycleHarness(authority, { taskStatus: "completed" });
      await harness.engine.start();
      const internal = harness.engine as unknown as {
        _evaluateAllTasks: (options: { skipIfActive: boolean }) => Promise<number>;
      };
      const evaluate = vi.spyOn(internal, "_evaluateAllTasks");

      await expect(harness.engine.applyGlobalLifecycleAction(action)).rejects.toBeInstanceOf(
        DispatchLifecycleTransitionError,
      );

      expect(harness.store.writes).toBe(0);
      expect(evaluate).not.toHaveBeenCalled();
      expect(recordCandidateStart(harness)).toEqual([]);
    },
  );

  // AC: @dispatch-lifecycle-control-authority ac-global-paused-work-does-not-start
  it("holds event-enqueued work while global authority is paused", async () => {
    const harness = await createGlobalLifecycleHarness("paused", { taskStatus: "completed" });
    await harness.engine.start();
    harness.writeTask(harness.taskId, "pending");
    const task = await harness.loadTask();

    await harness.engine.handleStateChange({
      taskId: harness.taskId,
      taskRef: `@${harness.taskId}`,
      fromStatus: "completed",
      toStatus: "pending",
      timestamp: Date.now(),
      task,
    });

    expect(recordCandidateStart(harness)).toEqual([]);
    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "paused",
      heldCount: 1,
      heldTaskIds: [harness.taskId],
    });
  });

  // AC: @dispatch-lifecycle-control-authority ac-global-paused-work-does-not-start
  it("rechecks paused authority when a coalesced event timer expires", async () => {
    const harness = await createGlobalLifecycleHarness("running", {
      taskStatus: "completed",
      coalesceWindowMs: 5,
    });
    await harness.engine.start();
    harness.writeTask(harness.taskId, "pending");
    const task = await harness.loadTask();

    await harness.engine.handleStateChange({
      taskId: harness.taskId,
      taskRef: `@${harness.taskId}`,
      fromStatus: "completed",
      toStatus: "pending",
      timestamp: Date.now(),
      task,
    });
    harness.store.publish(control("paused", 2));
    const internal = harness.engine as unknown as {
      coalesceTimers: Map<string, ReturnType<typeof setTimeout>>;
    };
    await vi.waitFor(() => expect(internal.coalesceTimers.size).toBe(0));

    expect(recordCandidateStart(harness)).toEqual([]);
    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "paused",
      heldCount: 1,
    });
  });

  // AC: @dispatch-lifecycle-control-authority ac-global-paused-work-does-not-start
  it("rechecks authority after a reconciliation pass has crossed its entry guard", async () => {
    const harness = await createGlobalLifecycleHarness("running", { taskStatus: "completed" });
    await harness.engine.start();
    harness.writeTask(harness.taskId, "pending");
    const barrier = holdIngress();
    const internal = harness.engine as unknown as {
      _evaluateAllTasks: (options: { skipIfActive: boolean }) => Promise<number>;
      _reconcile: () => Promise<void>;
    };
    const evaluateCurrent = internal._evaluateAllTasks.bind(harness.engine);
    vi.spyOn(internal, "_evaluateAllTasks").mockImplementationOnce(async (options) => {
      await barrier.wait();
      return evaluateCurrent(options);
    });

    const reconciling = internal._reconcile();
    await vi.waitFor(() => expect(internal._evaluateAllTasks).toHaveBeenCalledOnce());
    harness.store.publish(control("paused", 2));
    barrier.release();
    await reconciling;

    expect(recordCandidateStart(harness)).toEqual([]);
    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "paused",
      heldCount: 1,
    });
  });

  // AC: @dispatch-lifecycle-control-authority ac-global-paused-work-does-not-start
  it("does not drain queued work when degraded recovery occurs after pause", async () => {
    const harness = await createGlobalLifecycleHarness("running", { taskStatus: "completed" });
    await harness.engine.start();
    harness.writeTask(harness.taskId, "pending");
    const internal = harness.engine as unknown as {
      _evaluateAllTasks: (options: { skipIfActive: boolean }) => Promise<number>;
      _enterDegradedState: (branch: string, reason: string) => void;
      _exitDegradedState: (branch: string) => void;
    };
    await internal._evaluateAllTasks({ skipIfActive: true });
    internal._enterDegradedState("dev", "test recovery barrier");

    harness.store.publish(control("paused", 2));
    internal._exitDegradedState("dev");
    await Promise.resolve();

    expect(recordCandidateStart(harness)).toEqual([]);
    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "paused",
      heldCount: 1,
    });
  });

  // AC: @dispatch-lifecycle-control-authority ac-global-paused-work-does-not-start
  it("keeps a failed invocation retry held when pause commits before its wake-up", async () => {
    const harness = await createGlobalLifecycleHarness("running", {
      recordCandidateStarts: false,
    });
    mockInvocationInfrastructure(harness.projectDir);
    const runInvocation = vi
      .spyOn(invocationModule, "runInvocation")
      .mockRejectedValue(new Error("transient lifecycle retry"));

    await harness.engine.start();
    await vi.waitFor(() => expect(runInvocation).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(harness.engine.getLifecycleStatus().queueDepth).toBe(1));
    await harness.engine.applyGlobalLifecycleAction("pause");
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(runInvocation).toHaveBeenCalledOnce();
    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "paused",
      heldCount: 1,
      heldTaskIds: [harness.taskId],
    });
  });

  // AC: @dispatch-lifecycle-control-authority ac-global-paused-work-does-not-start
  it("rechecks authority after post-invocation re-evaluation crosses its barrier", async () => {
    const harness = await createGlobalLifecycleHarness("running", {
      recordCandidateStarts: false,
    });
    mockInvocationInfrastructure(harness.projectDir);
    const invocationBarrier = holdIngress();
    const runInvocation = vi
      .spyOn(invocationModule, "runInvocation")
      .mockImplementation(async () => {
        await invocationBarrier.wait();
        return { session: {} as never, outcome: "success", durationMs: 1 };
      });

    await harness.engine.start();
    await vi.waitFor(() => expect(runInvocation).toHaveBeenCalledOnce());
    const currentTaskId = testUlid("TASK", 2);
    harness.writeTask(currentTaskId, "pending", "task-post-invocation-current");
    const postEvaluationBarrier = holdIngress();
    const internal = harness.engine as unknown as {
      _evaluateAllTasks: (options: { skipIfActive: boolean }) => Promise<number>;
    };
    const evaluateCurrent = internal._evaluateAllTasks.bind(harness.engine);
    vi.spyOn(internal, "_evaluateAllTasks").mockImplementationOnce(async (options) => {
      await postEvaluationBarrier.wait();
      return evaluateCurrent(options);
    });

    invocationBarrier.release();
    await vi.waitFor(() => expect(internal._evaluateAllTasks).toHaveBeenCalledOnce());
    await harness.engine.applyGlobalLifecycleAction("pause");
    postEvaluationBarrier.release();
    await vi.waitFor(() => expect(harness.engine.getLifecycleStatus().heldCount).toBe(2));

    expect(runInvocation).toHaveBeenCalledOnce();
    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "paused",
      heldCount: 2,
    });
    expect(harness.engine.getLifecycleStatus().heldTaskIds).toContain(currentTaskId);
  });

  // AC: @dispatch-lifecycle-control-authority ac-global-pause-authority
  // AC: @dispatch-lifecycle-control-authority ac-global-pause-allows-active-completion
  // AC: @dispatch-lifecycle-control-authority ac-global-pause-keeps-active-session-open
  // AC: @dispatch-lifecycle-control-authority ac-global-pause-is-idempotent
  it("pauses new starts without cancelling active work or closing its session", async () => {
    const harness = await createGlobalLifecycleHarness("running");
    await harness.engine.start();
    let closeReason: string | null = null;
    harness.engine.sessionRegistry.register("active-session", {
      sendPrompt: async () => undefined,
      getState: () => "idle",
      requestClose: (reason) => {
        closeReason = reason;
      },
    });
    const internal = harness.engine as unknown as {
      activeCount: Map<string, number>;
      activeInvocationDetails: Map<string, Record<string, unknown>>;
    };
    internal.activeCount.set("worker", 1);
    internal.activeInvocationDetails.set("active-invocation", {
      invocationId: "active-invocation",
      sessionId: "active-session",
      agentId: "worker",
      agentName: "Worker",
      taskId: harness.taskId,
      taskRef: `@${harness.taskId}`,
      startedAtMs: Date.now(),
      resolvedAdapter: "mock-acp",
    });
    const first = await harness.engine.applyGlobalLifecycleAction("pause", {
      reason: "  planned\u0000 maintenance  ",
      actor: "operator",
      source: "cli",
    });
    const second = await harness.engine.applyGlobalLifecycleAction("pause");
    expect(first.outcome).toBe("applied");
    expect(second.outcome).toBe("noop");
    expect(harness.engine.getLifecycleStatus().globalAuthority).toBe("paused");
    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      projection: "draining",
      activeCount: 1,
    });
    expect(harness.engine.sessionRegistry.get("active-session")).toBeDefined();
    expect(closeReason).toBeNull();
    expect(harness.store.writes).toBe(1);
    expect(harness.store.getPublication().snapshot.global).toMatchObject({
      authority: "paused",
      reason: "planned maintenance",
      actor: "operator",
      source: "cli",
    });
    await harness.engine.stop();
  });

  // AC: @dispatch-lifecycle-control-authority ac-global-paused-work-does-not-start
  it("does not dequeue a candidate after pause commits across an active drain barrier", async () => {
    const harness = await createGlobalLifecycleHarness("running");
    const barrier = holdIngress();
    const internal = harness.engine as unknown as {
      _pruneIneligibleQueueEntries: (...args: unknown[]) => Promise<void>;
    };
    const prune = internal._pruneIneligibleQueueEntries.bind(harness.engine);
    vi.spyOn(internal, "_pruneIneligibleQueueEntries").mockImplementationOnce(async (...args) => {
      await barrier.wait();
      await prune(...args);
    });

    const starting = harness.engine.start();
    await vi.waitFor(() => expect(internal._pruneIneligibleQueueEntries).toHaveBeenCalledOnce());
    harness.store.publish(control("paused", 2));
    barrier.release();
    await starting;

    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "paused",
      heldCount: 1,
    });
    expect(recordCandidateStart(harness)).toEqual([]);
    await harness.engine.stop();
  });

  // AC: @dispatch-lifecycle-control-authority ac-global-pause-authority
  it("evaluates pause against newer committed authority instead of stale publication", async () => {
    const harness = await createGlobalLifecycleHarness("running");
    harness.store.commitWithoutPublishing(control("stopped", 2));

    await expect(harness.engine.applyGlobalLifecycleAction("pause")).rejects.toBeInstanceOf(
      DispatchLifecycleTransitionError,
    );

    expect(harness.store.writes).toBe(0);
    expect(harness.store.getPublication().snapshot.global.authority).toBe("stopped");
    expect(harness.engine.getLifecycleStatus().globalAuthority).toBe("stopped");
  });

  // AC: @dispatch-lifecycle-control-authority ac-resume-reconciles-held-work
  // AC: @dispatch-lifecycle-control-authority ac-resume-reconciles-eligible-work
  // AC: @dispatch-lifecycle-control-authority ac-paused-reconstruction-uses-current-state
  // AC: @dispatch-lifecycle-control-authority ac-repeated-resume-does-not-duplicate
  // AC: @dispatch-lifecycle-control-authority ac-global-resume-is-idempotent
  it("reconstructs current eligible work once when paused authority resumes", async () => {
    const harness = await createGlobalLifecycleHarness("paused");
    await harness.engine.start();
    expect(harness.engine.getLifecycleStatus().heldCount).toBe(1);
    seedSplitTask(harness.projectDir, {
      _ulid: harness.taskId,
      type: "task",
      title: "Lifecycle task",
      slugs: ["task-lifecycle"],
      status: "completed",
      priority: 1,
      automation: "eligible",
      depends_on: [],
      blocked_by: [],
      tags: [],
      notes: [],
      created_at: new Date().toISOString(),
    });
    const currentTaskId = testUlid("TASK", 2);
    seedSplitTask(harness.projectDir, {
      _ulid: currentTaskId,
      type: "task",
      title: "Current lifecycle task",
      slugs: ["task-current-lifecycle"],
      status: "pending",
      priority: 1,
      automation: "eligible",
      depends_on: [],
      blocked_by: [],
      tags: [],
      notes: [],
      created_at: new Date().toISOString(),
    });
    const first = await harness.engine.applyGlobalLifecycleAction("resume");
    const second = await harness.engine.applyGlobalLifecycleAction("resume");
    expect(first.outcome).toBe("applied");
    expect(second.outcome).toBe("noop");
    expect(recordCandidateStart(harness)).toEqual([currentTaskId]);
    await harness.engine.stop();
  });

  it("contains and reports failed reconstruction from an external running publication", async () => {
    const harness = await createGlobalLifecycleHarness("paused");
    await harness.engine.start();
    const reconstructionError = new Error("external reconstruction failed");
    const internal = harness.engine as unknown as {
      _reconstructCurrentCandidates: () => Promise<void>;
    };
    vi.spyOn(internal, "_reconstructCurrentCandidates").mockRejectedValueOnce(reconstructionError);
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    harness.store.publish(control("running", 2));

    await vi.waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(
        "[dispatch] Lifecycle publication reconstruction error:",
        reconstructionError,
      ),
    );
    expect(harness.engine.getLifecycleStatus().globalAuthority).toBe("running");
    await harness.engine.stop();
  });

  // AC: @dispatch-lifecycle-control-authority ac-concurrent-resume-does-not-duplicate
  it("serializes concurrent resumes into one canonical candidate start", async () => {
    const harness = await createGlobalLifecycleHarness("paused");
    await harness.engine.start();
    const barrier = holdIngress();
    const internal = harness.engine as unknown as {
      _evaluateAllTasks: (o: { skipIfActive: boolean }) => Promise<number>;
    };
    const evaluateCurrent = internal._evaluateAllTasks.bind(harness.engine);
    vi.spyOn(internal, "_evaluateAllTasks").mockImplementationOnce(async (options) => {
      await barrier.wait();
      return evaluateCurrent(options);
    });
    const resumes = Promise.all([
      harness.engine.applyGlobalLifecycleAction("resume"),
      harness.engine.applyGlobalLifecycleAction("resume"),
    ]);
    barrier.release();
    const results = await resumes;
    expect(results.map((result) => result.outcome).toSorted()).toEqual(["applied", "noop"]);
    expect(recordCandidateStart(harness)).toEqual([harness.taskId]);
    expect(new Set(recordCandidateStart(harness)).size).toBe(recordCandidateStart(harness).length);
    await harness.engine.stop();
  });

  // AC: @dispatch-lifecycle-control-authority ac-stopped-reconstruction-uses-current-state
  it("reconstructs only current authoritative work when stopped authority starts", async () => {
    const harness = await createGlobalLifecycleHarness("stopped");
    await harness.engine.start();
    expect(harness.engine.getLifecycleStatus().heldTaskIds).toEqual([harness.taskId]);
    harness.writeTask(harness.taskId, "completed");
    const currentTaskId = testUlid("TASK", 2);
    harness.writeTask(currentTaskId, "pending", "task-current-after-stop");

    await harness.engine.applyGlobalLifecycleAction("start");

    expect(recordCandidateStart(harness)).toEqual([currentTaskId]);
    expect(harness.store.writes).toBe(1);
    expect(harness.engine.getLifecycleStatus().heldTaskIds).toEqual([]);
  });

  // AC: @dispatch-lifecycle-control-authority ac-global-start-is-idempotent
  // AC: @dispatch-lifecycle-control-authority ac-controls-do-not-change-readiness
  // AC: @dispatch-lifecycle-control-authority ac-controls-do-not-change-degraded-targets
  it("starts with unrelated cleanup without mutating readiness or an existing degraded target", async () => {
    const harness = await createGlobalLifecycleHarness("stopped");
    const taskCleanupId = testUlid("CLN", 2);
    harness.store.publish({
      ...control("stopped", 2),
      pending_cleanup: {
        [harness.taskId]: { cleanup_id: taskCleanupId, status: "pending", phase: "owned" },
      },
    });
    await harness.engine.start();
    const internal = harness.engine as unknown as {
      _enterDegradedState: (branch: string, reason: string) => void;
    };
    internal._enterDegradedState("plan/lifecycle", "preserve this degraded target");
    const ctx = await initContext(harness.projectDir);
    const beforeTask = (await resolveTaskDataManager(ctx).loadAllTasks(ctx)).find(
      (task) => task._ulid === harness.taskId,
    );
    const beforeDegraded = harness.engine.getDegradedState();
    expect((await harness.engine.applyGlobalLifecycleAction("start")).outcome).toBe("applied");
    expect((await harness.engine.applyGlobalLifecycleAction("start")).outcome).toBe("noop");
    const afterTask = (await resolveTaskDataManager(ctx).loadAllTasks(ctx)).find(
      (task) => task._ulid === harness.taskId,
    );
    expect(afterTask).toEqual(beforeTask);
    expect(harness.engine.getDegradedState()).toEqual(beforeDegraded);
    expect(recordCandidateStart(harness)).toHaveLength(0);
    expect(harness.engine.getLifecycleStatus()).toMatchObject({
      globalAuthority: "running",
      heldCount: 1,
      heldTaskIds: [harness.taskId],
    });
    await harness.engine.stop();
  });

  it.each(["pending", "failed"] as const)(
    "rejects start, pause, and resume while global cleanup is %s",
    async (status) => {
      const harness = await createGlobalLifecycleHarness("stopped");
      harness.store.publish({
        ...control("stopped", 2),
        pending_cleanup: {
          global: {
            cleanup_id: testUlid("CLN", 3),
            status,
            phase: "owned",
            ...(status === "failed" ? { error_code: "cancellation_failed" as const } : {}),
          },
        },
      });
      await harness.engine.start();
      const writes = harness.store.writes;
      for (const action of ["start", "pause", "resume"] as const) {
        await expect(harness.engine.applyGlobalLifecycleAction(action)).rejects.toBeInstanceOf(
          DispatchLifecycleTransitionError,
        );
      }
      expect(harness.store.writes).toBe(writes);
      expect(recordCandidateStart(harness)).toHaveLength(0);
      await harness.engine.stop();
    },
  );
});
