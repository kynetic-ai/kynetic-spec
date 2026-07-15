import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  DispatchEngine,
  type DispatchLifecycleAuthorityStore,
} from "../src/agent-runtime/dispatch.js";
import type {
  DispatchControl,
  DispatchControlMutation,
  DispatchControlPublication,
} from "../src/agent-runtime/dispatch-control-store.js";
import { createMissingDispatchControl } from "../src/schema/dispatch-control.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import * as spawnerModule from "../src/agents/spawner.js";
import * as workspaceModule from "../src/agent-runtime/workspace.js";
import * as bootstrapModule from "../src/agent-runtime/bootstrap.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  seedSplitTask,
  testUlid,
} from "./helpers/cli.js";

ensureSplitBackendRegistered();
const MOCK_KSPEC_CLI = path.join(__dirname, "mocks", "kspec-capture-mock.cjs");

class MemoryControlStore implements DispatchLifecycleAuthorityStore {
  private publication: DispatchControlPublication;
  private listener: ((publication: DispatchControlPublication) => void) | undefined;

  constructor(snapshot: DispatchControl) {
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
    const next = await mutation(structuredClone(this.publication.snapshot));
    if (next) this.commit(next);
    return this.publication;
  }

  commit(snapshot: DispatchControl): void {
    this.publication = {
      snapshot,
      token: { revision: snapshot.revision, commit_oid: `memory-${snapshot.revision}` },
    };
    this.listener?.(this.publication);
  }
}

export function beforeCreateBarrier() {
  let release!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, wait: async () => (markEntered(), blocked), release };
}

export function artifactRecorder() {
  return { processes: 0, sessions: 0, handoffs: [] as invocationModule.InvocationCreateHandoff[] };
}

type SpawnGateHarness = Awaited<ReturnType<typeof createSpawnGateHarness>>;
const harnesses: SpawnGateHarness[] = [];

export async function createSpawnGateHarness(options: { realInvocation?: boolean } = {}) {
  const projectDir = await createTempDir("dispatch-spawn-gate-");
  initGitRepo(projectDir);
  const taskId = testUlid("TASK", 1);
  await fs.writeFile(
    path.join(projectDir, "kynetic.yaml"),
    YAML.stringify({ kynetic: "1.1", title: "Spawn gate", task_storage: { format: "split" } }),
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
          budget: { max_retries: 0 },
          dispatch: [{ on: "task.ready" }],
        },
      ],
    }),
  );
  seedSplitTask(projectDir, {
    _ulid: taskId,
    type: "task",
    title: "Spawn gate task",
    slugs: ["task-spawn-gate"],
    status: "pending",
    priority: 1,
    automation: "eligible",
    depends_on: [],
    blocked_by: [],
    tags: [],
    notes: [],
    created_at: new Date().toISOString(),
  });

  const initial = {
    ...createMissingDispatchControl(),
    revision: 1,
    global: { authority: "running" as const },
  };
  const store = new MemoryControlStore(initial);
  const engine = new DispatchEngine({
    projectDir,
    specDir: projectDir,
    kspecCliPath: MOCK_KSPEC_CLI,
    reconcileIntervalMs: 0,
    coalesceWindowMs: 0,
    lifecycleStore: store,
  });
  const metadata = {
    workspaceId: "spawn-gate-workspace",
    taskRef: "@task-spawn-gate",
    taskSlug: "task-spawn-gate",
    canonicalBranch: "dispatch/task/task-spawn-gate/test",
    canonicalBranchHead: "abc123",
    integrationTargetBranch: "dev",
    mergeTargetBranch: "dev",
    baseBranch: "dev",
    integrationTargetCommit: "abc123",
    publicationMode: "manual_merge",
    integrationState: "pending",
    integrationOutcome: "none",
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
  const provisioned = {
    cwd: projectDir,
    metadataPath: path.join(projectDir, ".kspec-dispatch-workspace.json"),
    metadata: metadata as never,
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
  vi.spyOn(workspaceModule, "provisionDispatchWorkspace").mockResolvedValue(provisioned);
  vi.spyOn(workspaceModule, "markDispatchWorkspaceActive").mockResolvedValue(provisioned);
  vi.spyOn(workspaceModule, "markDispatchWorkspaceIdle").mockResolvedValue(provisioned);
  vi.spyOn(bootstrapModule, "ensureWorkspaceBootstrap").mockResolvedValue({
    metadata: metadata as never,
  });

  const beforeCreate = beforeCreateBarrier();
  const completion = beforeCreateBarrier();
  const artifacts = artifactRecorder();
  const internal = engine as unknown as {
    _admitInvocationCreation: (input: unknown) => Promise<invocationModule.InvocationCreateHandoff>;
  };
  const admitInvocationCreation = internal._admitInvocationCreation.bind(engine);
  let markAdmissionSettled!: () => void;
  const admissionSettled = new Promise<void>((resolve) => {
    markAdmissionSettled = resolve;
  });
  vi.spyOn(internal, "_admitInvocationCreation").mockImplementation(async (input) => {
    await beforeCreate.wait();
    try {
      return await admitInvocationCreation(input);
    } finally {
      markAdmissionSettled();
    }
  });
  if (options.realInvocation) {
    vi.spyOn(spawnerModule, "spawnAndInitialize").mockImplementation(async () => {
      artifacts.processes++;
      throw new Error("adapter spawn must remain unreachable when lifecycle control wins");
    });
  }
  let completedNaturally = false;
  let observedAbort = false;
  if (!options.realInvocation) {
    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (invocationOptions) => {
      const handoff = await invocationOptions.beforeCreate?.();
      if (!handoff) throw new Error("dispatch invocation omitted the final create gate");
      artifacts.handoffs.push(handoff);
      artifacts.sessions++;
      artifacts.processes++;
      if (invocationOptions.abortSignal?.aborted) observedAbort = true;
      await completion.wait();
      if (invocationOptions.abortSignal?.aborted) observedAbort = true;
      completedNaturally = !observedAbort;
      return { session: {} as never, outcome: "success", durationMs: 1, turnCount: 1 };
    });
  }

  const refreshPersistedSessionCount = async () => {
    const sessionsDir = path.join(projectDir, ".kspec-sessions");
    artifacts.sessions = await fs
      .readdir(sessionsDir)
      .then((entries) => entries.length)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      });
  };

  const harness = {
    projectDir,
    taskId,
    store,
    engine,
    beforeCreate,
    completion,
    artifacts,
    admissionSettled,
    refreshPersistedSessionCount,
    get completedNaturally() {
      return completedNaturally;
    },
    get observedAbort() {
      return observedAbort;
    },
  };
  harnesses.push(harness);
  return harness;
}

function stopSnapshot(harness: SpawnGateHarness, scope: "global" | "task"): DispatchControl {
  const current = harness.store.getPublication().snapshot;
  const timestamp = new Date().toISOString();
  return {
    ...current,
    revision: current.revision + 1,
    ...(scope === "global" ? { global: { authority: "stopped" as const } } : {}),
    tasks:
      scope === "task"
        ? {
            ...current.tasks,
            [harness.taskId]: {
              mode: "stopped",
              reason: "stop won gate",
              actor: "test",
              source: "api",
              controlled_at: timestamp,
              updated_at: timestamp,
            },
          }
        : current.tasks,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    harnesses.splice(0).map(async ({ engine, projectDir, beforeCreate, completion }) => {
      beforeCreate.release();
      completion.release();
      await engine.stop().catch(() => undefined);
      await cleanupTempDir(projectDir);
    }),
  );
});

describe("final ordered dispatch create gate", () => {
  // AC: @dispatch-lifecycle-control-authority ac-final-gate-prevents-process-creation
  // AC: @dispatch-lifecycle-control-authority ac-final-gate-prevents-session-creation
  it.each(["global", "task"] as const)(
    "%s pause wins before creation and restores one held candidate",
    async (scope) => {
      const harness = await createSpawnGateHarness({ realInvocation: true });
      await harness.engine.start();
      await harness.beforeCreate.entered;

      if (scope === "global") {
        await harness.engine.applyGlobalLifecycleAction("pause");
      } else {
        await harness.engine.applyTaskLifecycleAction("pause", { taskId: harness.taskId });
      }
      harness.beforeCreate.release();

      await harness.admissionSettled;
      await vi.waitFor(() => expect(harness.engine.getLifecycleStatus().heldCount).toBe(1));
      await harness.refreshPersistedSessionCount();
      expect(harness.artifacts).toMatchObject({ processes: 0, sessions: 0, handoffs: [] });
      expect(harness.engine.getLifecycleStatus()).toMatchObject({ activeCount: 0, queueDepth: 1 });
    },
  );

  // AC: @dispatch-lifecycle-control-authority ac-final-gate-prevents-process-creation
  // AC: @dispatch-lifecycle-control-authority ac-final-gate-prevents-session-creation
  it.each(["global", "task"] as const)(
    "%s stop wins before creation and discards the candidate",
    async (scope) => {
      const harness = await createSpawnGateHarness({ realInvocation: true });
      await harness.engine.start();
      await harness.beforeCreate.entered;

      harness.store.commit(stopSnapshot(harness, scope));
      harness.beforeCreate.release();

      await harness.admissionSettled;
      await harness.refreshPersistedSessionCount();
      expect(harness.artifacts).toMatchObject({ processes: 0, sessions: 0, handoffs: [] });
      expect(harness.engine.getLifecycleStatus()).toMatchObject({ activeCount: 0, queueDepth: 0 });
    },
  );

  // AC: @dispatch-lifecycle-control-authority ac-spawn-win-pause-allows-completion
  it("publishes one active handoff before global pause and completes naturally", async () => {
    const harness = await createSpawnGateHarness();
    await harness.engine.start();
    await harness.beforeCreate.entered;
    const current = harness.store.getPublication().snapshot;
    harness.store.commit({
      ...current,
      revision: current.revision + 1,
      pending_cleanup: {
        [testUlid("TASK", 2)]: {
          cleanup_id: testUlid("CLNP", 2),
          status: "pending",
          phase: "owned",
        },
      },
    });
    harness.beforeCreate.release();

    await vi.waitFor(() => expect(harness.artifacts.handoffs).toHaveLength(1));
    expect(harness.engine.getStatus()).toMatchObject({ activeInvocations: 1 });
    expect(harness.artifacts.handoffs[0]).toMatchObject({
      sessionId: expect.any(String),
      invocationId: expect.any(String),
      taskId: harness.taskId,
      agentId: "worker",
      adapter: "mock-acp",
    });

    await harness.engine.applyGlobalLifecycleAction("pause");
    harness.completion.release();
    await vi.waitFor(() => expect(harness.completedNaturally).toBe(true));
    expect(harness.observedAbort).toBe(false);
    expect(harness.artifacts).toMatchObject({ processes: 1, sessions: 1 });
  });

  it("exposes a spawn-winner handoff to later stop recovery without cancelling here", async () => {
    const harness = await createSpawnGateHarness();
    await harness.engine.start();
    await harness.beforeCreate.entered;
    harness.beforeCreate.release();
    await vi.waitFor(() => expect(harness.artifacts.handoffs).toHaveLength(1));

    harness.store.commit(stopSnapshot(harness, "task"));
    expect(harness.engine.getStatus().activeInvocations).toBe(1);
    expect(harness.observedAbort).toBe(false);
    expect(harness.artifacts.handoffs[0]?.taskId).toBe(harness.taskId);

    harness.completion.release();
    await vi.waitFor(() => expect(harness.completedNaturally).toBe(true));
  });
});
