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

ensureSplitBackendRegistered();
const liveHarnesses: Array<Awaited<ReturnType<typeof createGlobalLifecycleHarness>>> = [];

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

async function createGlobalLifecycleHarness(authority: "stopped" | "running" | "paused") {
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
  seedSplitTask(projectDir, {
    _ulid: taskId,
    type: "task",
    title: "Lifecycle task",
    slugs: ["task-lifecycle"],
    status: "pending",
    priority: 1,
    automation: "eligible",
    depends_on: [],
    blocked_by: [],
    tags: [],
    notes: [],
    created_at: new Date().toISOString(),
  });
  const store = new MemoryControlStore(control(authority));
  const engine = new DispatchEngine({
    projectDir,
    specDir: projectDir,
    reconcileIntervalMs: 0,
    coalesceWindowMs: 0,
    lifecycleStore: store,
  });
  const candidateStarts: string[] = [];
  vi.spyOn(
    engine as unknown as {
      _spawnInvocation: (agent: unknown, entry: { change: { taskId: string } }) => Promise<boolean>;
    },
    "_spawnInvocation",
  ).mockImplementation(async (_agent, entry) => {
    candidateStarts.push(entry.change.taskId);
    return true;
  });
  const harness = { engine, store, taskId, candidateStarts, projectDir };
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
  // AC: @dispatch-lifecycle-control-authority ac-global-start-is-idempotent
  // AC: @dispatch-lifecycle-control-authority ac-controls-do-not-change-readiness
  // AC: @dispatch-lifecycle-control-authority ac-controls-do-not-change-degraded-targets
  it("starts stopped authority with unrelated cleanup without mutating readiness or degraded targets", async () => {
    const harness = await createGlobalLifecycleHarness("stopped");
    const taskCleanupId = testUlid("CLN", 2);
    harness.store.publish({
      ...control("stopped", 2),
      pending_cleanup: {
        [harness.taskId]: { cleanup_id: taskCleanupId, status: "pending", phase: "owned" },
      },
    });
    await harness.engine.start();
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
