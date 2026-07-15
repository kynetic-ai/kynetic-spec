import { afterEach, describe, expect, it, vi } from "vitest";
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
  DispatchControlMutation,
  DispatchControlPublication,
} from "../src/agent-runtime/dispatch-control-store.js";
import { createMissingDispatchControl } from "../src/schema/dispatch-control.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import { initContext, resolveTaskDataManager } from "../src/parser/index.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  seedSplitTask,
  testUlid,
} from "./helpers/cli.js";

ensureSplitBackendRegistered();

class MemoryControlStore implements DispatchLifecycleAuthorityStore {
  private publication: DispatchControlPublication;
  private committed: DispatchControl;
  private listener: ((publication: DispatchControlPublication) => void) | undefined;
  writes = 0;

  constructor(snapshot: DispatchControl) {
    this.committed = snapshot;
    this.publication = { snapshot, token: { revision: snapshot.revision, commit_oid: "memory" } };
  }

  setPublicationListener(
    _key: string,
    listener: (publication: DispatchControlPublication) => void,
  ): void {
    this.listener = listener;
  }

  async loadCommitted(): Promise<DispatchControlPublication> {
    this.listener?.(this.publication);
    return this.publication;
  }

  getPublication(): DispatchControlPublication {
    return this.publication;
  }

  getDegradedReason(): string | null {
    return null;
  }

  async mutate(
    _operation: string,
    mutation: DispatchControlMutation,
  ): Promise<DispatchControlPublication> {
    let next: DispatchControl | null;
    try {
      next = await mutation(structuredClone(this.committed));
    } catch (error) {
      this.publish(this.committed);
      throw error;
    }
    if (next === null) {
      this.publish(this.committed);
      return this.publication;
    }
    this.writes++;
    this.committed = next;
    this.publish(next);
    return this.publication;
  }

  publish(snapshot: DispatchControl): void {
    this.committed = snapshot;
    this.publication = {
      snapshot,
      token: { revision: snapshot.revision, commit_oid: `memory-${snapshot.revision}` },
    };
    this.listener?.(this.publication);
  }
}

function control(authority: "stopped" | "running" | "paused" = "running"): DispatchControl {
  return { ...createMissingDispatchControl(), revision: 1, global: { authority } };
}

type TaskLifecycleHarness = Awaited<ReturnType<typeof createTaskLifecycleHarness>>;
const harnesses: TaskLifecycleHarness[] = [];

async function createTaskLifecycleHarness(
  authority: "stopped" | "running" | "paused" = "running",
  options: { coalesceWindowMs?: number; taskAStatus?: "pending" | "completed" } = {},
) {
  const projectDir = await createTempDir("dispatch-task-lifecycle-");
  initGitRepo(projectDir);
  const taskA = testUlid("TASK", 1);
  const taskB = testUlid("TASK", 2);
  await fs.writeFile(
    path.join(projectDir, "kynetic.yaml"),
    YAML.stringify({ kynetic: "1.1", title: "Task lifecycle", task_storage: { format: "split" } }),
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
          concurrency: { max_concurrent: 2 },
          dispatch: [{ on: "task.ready" }],
        },
      ],
    }),
  );
  const writeTask = (
    taskId: string,
    status: "pending" | "completed",
    slug = taskId === taskA ? "task-alpha" : "task-beta",
  ) =>
    seedSplitTask(projectDir, {
      _ulid: taskId,
      type: "task",
      title: slug,
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
  writeTask(taskA, options.taskAStatus ?? "pending");
  writeTask(taskB, "pending");
  const loadTask = async (taskId: string) => {
    const ctx = await initContext(projectDir);
    return (await resolveTaskDataManager(ctx).loadAllTasks(ctx)).find(
      (task) => task._ulid === taskId,
    )!;
  };
  const store = new MemoryControlStore(control(authority));
  const engine = new DispatchEngine({
    projectDir,
    specDir: projectDir,
    reconcileIntervalMs: 0,
    coalesceWindowMs: options.coalesceWindowMs ?? 0,
    lifecycleStore: store,
  });
  const starts: string[] = [];
  vi.spyOn(
    engine as unknown as {
      _spawnInvocation: (agent: unknown, entry: { change: { taskId: string } }) => Promise<boolean>;
    },
    "_spawnInvocation",
  ).mockImplementation(async (_agent, entry) => {
    starts.push(entry.change.taskId);
    return true;
  });
  const harness = { projectDir, taskA, taskB, store, engine, starts, writeTask, loadTask };
  harnesses.push(harness);
  return harness;
}

function holdTaskIngress() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait: () => promise, release };
}

function recordTaskStart(harness: TaskLifecycleHarness): string[] {
  return harness.starts.slice();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    harnesses.splice(0).map(async ({ engine, projectDir }) => {
      await engine.stop().catch(() => undefined);
      await cleanupTempDir(projectDir);
    }),
  );
});

describe("canonical task pause and resume", () => {
  // AC: @dispatch-lifecycle-control-authority ac-task-control-uses-canonical-identity
  // AC: @dispatch-lifecycle-control-authority ac-task-pause-is-idempotent
  it("canonicalizes a slug before one durable pause record is applied", async () => {
    const harness = await createTaskLifecycleHarness("running", { taskAStatus: "completed" });
    await harness.engine.start();

    const [first, second] = await Promise.all([
      harness.engine.applyTaskLifecycleAction("pause", {
        taskRef: "@task-alpha",
        reason: "  hold alpha\u0000 now ",
        actor: "operator",
        source: "cli",
      }),
      harness.engine.applyTaskLifecycleAction("pause", { taskId: harness.taskA }),
    ]);

    expect(first).toMatchObject({ outcome: "applied", taskId: harness.taskA });
    expect(second).toMatchObject({ outcome: "noop", taskId: harness.taskA });
    expect(Object.keys(harness.store.getPublication().snapshot.tasks)).toEqual([harness.taskA]);
    expect(harness.store.getPublication().snapshot.tasks[harness.taskA]).toMatchObject({
      mode: "paused",
      reason: "hold alpha now",
      actor: "operator",
      source: "cli",
    });
    expect(harness.store.writes).toBe(1);
  });

  // AC: @dispatch-lifecycle-control-authority ac-task-paused-work-does-not-start
  // AC: @dispatch-lifecycle-control-authority ac-task-control-preserves-unrelated-task-control
  // AC: @dispatch-lifecycle-control-authority ac-task-control-preserves-global-authority
  it("holds task A across event, coalesced, retry, reconcile, and post-invocation drains while B remains independent", async () => {
    const harness = await createTaskLifecycleHarness("running", {
      coalesceWindowMs: 5,
      taskAStatus: "completed",
    });
    await harness.engine.start();
    await harness.engine.applyTaskLifecycleAction("pause", { taskRef: "@task-alpha" });
    harness.writeTask(harness.taskA, "pending");
    const taskA = await harness.loadTask(harness.taskA);

    await harness.engine.handleStateChange({
      taskId: harness.taskA,
      taskRef: "@task-alpha",
      fromStatus: "completed",
      toStatus: "pending",
      timestamp: Date.now(),
      task: taskA,
    });
    const internal = harness.engine as unknown as {
      coalesceTimers: Map<string, ReturnType<typeof setTimeout>>;
      _reconcile: () => Promise<void>;
      _serializedDrain: () => Promise<void>;
      _evaluateAllTasks: (options: { skipIfActive: boolean }) => Promise<number>;
    };
    await vi.waitFor(() => expect(internal.coalesceTimers.size).toBe(0));
    await internal._reconcile();
    await internal._serializedDrain();
    await internal._evaluateAllTasks({ skipIfActive: true });
    await internal._serializedDrain();

    expect(recordTaskStart(harness)).toContain(harness.taskB);
    expect(recordTaskStart(harness)).not.toContain(harness.taskA);
    expect(harness.engine.getLifecycleStatus().heldTaskIds).toContain(harness.taskA);
    expect(harness.store.getPublication().snapshot.global.authority).toBe("running");
  });

  // AC: @dispatch-lifecycle-control-authority ac-task-pause-allows-active-completion
  // AC: @dispatch-lifecycle-control-authority ac-task-pause-keeps-active-session-open
  it("does not cancel active task A work or close its session when A is paused", async () => {
    const harness = await createTaskLifecycleHarness("running", { taskAStatus: "completed" });
    await harness.engine.start();
    let closeReason: string | null = null;
    harness.engine.sessionRegistry.register("active-a", {
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
    internal.activeInvocationDetails.set("active-a", {
      invocationId: "active-a",
      sessionId: "active-a",
      agentId: "worker",
      agentName: "Worker",
      taskId: harness.taskA,
      taskRef: "@task-alpha",
      startedAtMs: Date.now(),
      resolvedAdapter: "mock-acp",
    });

    await harness.engine.applyTaskLifecycleAction("pause", { taskRef: "@task-alpha" });

    expect(harness.engine.getStatus().activeInvocations).toBe(1);
    expect(harness.engine.sessionRegistry.get("active-a")).toBeDefined();
    expect(closeReason).toBeNull();
  });

  it("allows task metadata control during global cleanup without releasing work", async () => {
    const harness = await createTaskLifecycleHarness("running", { taskAStatus: "completed" });
    harness.store.publish({
      ...control("running"),
      revision: 2,
      pending_cleanup: {
        global: {
          cleanup_id: testUlid("CLN", 8),
          status: "pending",
          phase: "owned",
        },
      },
    });
    await harness.engine.start();

    await harness.engine.applyTaskLifecycleAction("pause", { taskRef: "@task-alpha" });
    harness.writeTask(harness.taskA, "pending");
    const resumed = await harness.engine.applyTaskLifecycleAction("resume", {
      taskRef: "@task-alpha",
    });

    expect(resumed.outcome).toBe("applied");
    expect(harness.store.getPublication().snapshot.pending_cleanup.global).toBeDefined();
    expect(recordTaskStart(harness)).toEqual([]);
  });

  // AC: @dispatch-lifecycle-control-authority ac-task-resume-obeys-global-authority
  it.each(["paused", "stopped"] as const)(
    "releases task metadata but starts no work while global authority is %s",
    async (authority) => {
      const harness = await createTaskLifecycleHarness(authority);
      harness.store.publish({
        ...control(authority),
        revision: 2,
        tasks: {
          [harness.taskA]: {
            mode: "paused",
            reason: "hold",
            actor: "operator",
            source: "api",
            controlled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        },
      });
      await harness.engine.start();

      const result = await harness.engine.applyTaskLifecycleAction("resume", {
        taskRef: "@task-alpha",
      });

      expect(result.outcome).toBe("applied");
      expect(harness.store.getPublication().snapshot.tasks[harness.taskA]).toBeUndefined();
      expect(recordTaskStart(harness)).toEqual([]);
    },
  );

  // AC: @dispatch-lifecycle-control-authority ac-task-resume-is-idempotent
  it("serializes concurrent and repeated resume into at most one canonical task A start", async () => {
    const harness = await createTaskLifecycleHarness("running", { taskAStatus: "completed" });
    await harness.engine.start();
    await harness.engine.applyTaskLifecycleAction("pause", { taskRef: "@task-alpha" });
    harness.writeTask(harness.taskA, "pending");
    const barrier = holdTaskIngress();
    const internal = harness.engine as unknown as {
      _evaluateAllTasks: (options: { skipIfActive: boolean }) => Promise<number>;
    };
    const evaluate = internal._evaluateAllTasks.bind(harness.engine);
    vi.spyOn(internal, "_evaluateAllTasks").mockImplementationOnce(async (options) => {
      await barrier.wait();
      return evaluate(options);
    });

    const resumes = Promise.all([
      harness.engine.applyTaskLifecycleAction("resume", { taskRef: "@task-alpha" }),
      harness.engine.applyTaskLifecycleAction("resume", { taskId: harness.taskA }),
    ]);
    barrier.release();
    const results = await resumes;
    const repeated = await harness.engine.applyTaskLifecycleAction("resume", {
      taskRef: "@task-alpha",
    });

    expect(results.map((result) => result.outcome).toSorted()).toEqual(["applied", "noop"]);
    expect(repeated.outcome).toBe("noop");
    expect(recordTaskStart(harness).filter((taskId) => taskId === harness.taskA)).toHaveLength(1);
  });

  it("resumes stopped task A only when its matching cleanup is idle", async () => {
    const harness = await createTaskLifecycleHarness("running", { taskAStatus: "completed" });
    const timestamp = new Date().toISOString();
    harness.store.publish({
      ...control("running"),
      revision: 2,
      tasks: {
        [harness.taskA]: {
          mode: "stopped",
          reason: "stop A",
          actor: "operator",
          source: "api",
          controlled_at: timestamp,
          updated_at: timestamp,
        },
        [harness.taskB]: {
          mode: "paused",
          reason: "hold B",
          actor: "operator",
          source: "api",
          controlled_at: timestamp,
          updated_at: timestamp,
        },
      },
    });
    await harness.engine.start();

    const result = await harness.engine.applyTaskLifecycleAction("resume", {
      taskRef: "@task-alpha",
    });

    expect(result).toMatchObject({ outcome: "applied", taskId: harness.taskA });
    expect(harness.store.getPublication().snapshot.tasks[harness.taskA]).toBeUndefined();
    expect(harness.store.getPublication().snapshot.tasks[harness.taskB]?.mode).toBe("paused");
  });

  it("rejects pause from stopped and rejects an unresolved alias before mutation", async () => {
    const harness = await createTaskLifecycleHarness("running", { taskAStatus: "completed" });
    const timestamp = new Date().toISOString();
    const snapshot: DispatchControl = {
      ...control("running"),
      revision: 2,
      tasks: {
        [harness.taskA]: {
          mode: "stopped",
          reason: "stop A",
          actor: "operator",
          source: "api",
          controlled_at: timestamp,
          updated_at: timestamp,
        },
      },
    };
    harness.store.publish(snapshot);
    await harness.engine.start();

    await expect(
      harness.engine.applyTaskLifecycleAction("pause", { taskRef: "@task-alpha" }),
    ).rejects.toBeInstanceOf(DispatchLifecycleTransitionError);
    await expect(
      harness.engine.applyTaskLifecycleAction("pause", { taskRef: "@missing-task" }),
    ).rejects.toMatchObject({ code: "unresolved-task-ref" });
    expect(harness.store.getPublication().snapshot).toEqual(snapshot);
    expect(harness.store.writes).toBe(0);
  });

  it.each(["pending", "failed"] as const)(
    "rejects task A resume while matching cleanup is %s without changing A or B",
    async (status) => {
      const harness = await createTaskLifecycleHarness("running", { taskAStatus: "completed" });
      const timestamp = new Date().toISOString();
      const snapshot: DispatchControl = {
        ...control("running"),
        revision: 2,
        tasks: {
          [harness.taskA]: {
            mode: "stopped",
            reason: "stop A",
            actor: "operator",
            source: "api",
            controlled_at: timestamp,
            updated_at: timestamp,
          },
          [harness.taskB]: {
            mode: "paused",
            reason: "hold B",
            actor: "operator",
            source: "api",
            controlled_at: timestamp,
            updated_at: timestamp,
          },
        },
        pending_cleanup: {
          [harness.taskA]: {
            cleanup_id: testUlid("CLN", 1),
            status,
            phase: "owned",
            ...(status === "failed" ? { error_code: "cancellation_failed" as const } : {}),
          },
        },
      };
      harness.store.publish(snapshot);
      await harness.engine.start();
      const writes = harness.store.writes;

      await expect(
        harness.engine.applyTaskLifecycleAction("resume", { taskRef: "@task-alpha" }),
      ).rejects.toBeInstanceOf(DispatchLifecycleTransitionError);

      expect(harness.store.writes).toBe(writes);
      expect(harness.store.getPublication().snapshot).toEqual(snapshot);
      expect(recordTaskStart(harness)).toEqual([]);
    },
  );
});
